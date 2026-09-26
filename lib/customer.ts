/** Coordonnées saisies par le client (modes retrait / livraison).
 *
 *  CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — `firstName`/`lastName` sont
 *  deux champs de SAISIE (mandat : "Capture first name + last name
 *  separately in the checkout UI"). Ils ne correspondent à AUCUNE
 *  colonne persistante : le serveur recompose un nom d'affichage
 *  normalisé et l'écrit dans la colonne EXISTANTE `orders.customer_name`
 *  (voir `formatCustomerDisplayName` ci-dessous et
 *  supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql).
 *
 *  `name` est CONSERVÉ tel quel : les modes NON suivis (room_service,
 *  click_collect, table) continuent d'exiger le champ backend
 *  `customer_name` et de le saisir dans ce champ unique -- ce lot ne
 *  change strictement rien pour eux.
 *
 *  POURQUOI `firstName`/`lastName` SONT OPTIONNELS DANS LE TYPE (et
 *  NON `string` obligatoires) -- remédiation de compatibilité :
 *  l'absence de ces deux clés est un état MÉTIER légitime, pas un
 *  objet mal construit. Le catalogue de champs backend résolu par le
 *  serveur ne retourne `first_name`/`last_name` QUE pour les modes
 *  suivis ; pour tous les autres, ces champs n'existent tout
 *  simplement pas dans le formulaire. `buildCreateOrderPayload` les
 *  transmet d'ailleurs déjà à `null` dans ce cas
 *  (lib/services/order-payload.ts) : l'absence est donc déjà un état
 *  de première classe du contrat. Les déclarer obligatoires forçait
 *  chaque appelant HISTORIQUE (et chaque fixture de test antérieure à
 *  ce lot) soit à être réécrit, soit à recourir à un transtypage
 *  `as unknown as CustomerInfo` -- c'est-à-dire à FAIRE TAIRE le
 *  compilateur au lieu de décrire la réalité.
 *
 *  Cette optionalité N'AFFAIBLIT AUCUNE RÈGLE PRODUIT : l'exigence
 *  « prénom obligatoire en retrait/livraison suivis, nom de famille
 *  obligatoire en livraison » n'est PAS portée par le type -- elle est
 *  portée, et elle seule fait autorité, par les exigences EFFECTIVES
 *  résolues côté serveur puis appliquées par `validateCustomerData()`
 *  (lib/sale-modes-public.ts) et par `getCustomerErrors()` ci-dessous.
 *  Les deux branches concernées de `getCustomerErrors` traitent une
 *  valeur ABSENTE exactement comme une valeur vide : elles échouent
 *  donc FERMÉ (`undefined` -> erreur), jamais ouvert. */
export interface CustomerInfo {
  name: string;
  /** Saisi uniquement quand le serveur expose `first_name` pour le
   *  mode courant. L'état de formulaire du checkout part TOUJOURS de
   *  `EMPTY_CUSTOMER`, qui initialise la clé à "" -- l'optionalité
   *  décrit les appelants HORS formulaire (contextes de commande
   *  construits ailleurs, fixtures antérieures à ce lot), pour
   *  lesquels la clé n'existe simplement pas. */
  firstName?: string;
  /** Idem `firstName`, pour `last_name`. */
  lastName?: string;
  street: string;
  postalCode: string;
  city: string;
  phone: string;
  email: string;
}

export const EMPTY_CUSTOMER: CustomerInfo = {
  name: "",
  firstName: "",
  lastName: "",
  street: "",
  postalCode: "",
  city: "",
  phone: "",
  email: "",
};

/** Numéro français : 10 chiffres, ou +33 suivi de 9 chiffres. */
export function isValidPhone(value: string): boolean {
  const digits = value.replace(/[\s.\-]/g, "");
  return /^(?:0\d{9}|\+33\d{9})$/.test(digits);
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim());
}

export function isValidPostalCode(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}

/** Clés de traduction des erreurs, par champ. */
/**
 * DELIVERY COUNTRY SCOPE v1 -- motifs de validation FOURNIS PAR LE
 * SERVEUR, pour le pays réellement résolu.
 *
 * Omis (appelant historique) : les règles FRANÇAISES d'origine
 * s'appliquent, à l'identique. Fournis : elles sont remplacées. Aucun
 * appelant existant ne change de comportement, et aucun pays n'est
 * plus supposé.
 */
export interface CustomerValidationPatterns {
  postalCodePattern?: string | null;
  phonePattern?: string | null;
  /** v1.1 (DCS-COUNTRY-UI-02) -- `true` : livraison SANS pays résolu.
   *  Le code postal est alors REFUSÉ (`errDeliveryCountryRequired`),
   *  jamais validé avec les règles historiques françaises à la place du
   *  pays manquant. Omis : comportement v1 inchangé. */
  deliveryCountryMissing?: boolean;
  /** v1.1 -- clé i18n du message de FORMAT postal pour le pays résolu
   *  (voir postalCodeErrorKeyFor, lib/delivery-country.ts). Omise :
   *  `errPostalCode`, comportement historique inchangé. */
  postalCodeErrorKey?: string | null;
}

function matchesOrDefault(
  pattern: string | null | undefined,
  value: string,
  fallback: (v: string) => boolean
): boolean {
  if (pattern === undefined || pattern === null || pattern === "") return fallback(value);
  try {
    return new RegExp(pattern).test(value.trim());
  } catch {
    // Motif corrompu : on ne punit pas le client d'un défaut de NOTRE
    // configuration. Le serveur, seule autorité, tranchera.
    return true;
  }
}

export function getCustomerErrors(
  c: CustomerInfo,
  required: (keyof CustomerInfo)[],
  patterns: CustomerValidationPatterns = {}
): Partial<Record<keyof CustomerInfo, string>> {
  const errors: Partial<Record<keyof CustomerInfo, string>> = {};

  for (const field of required) {
    switch (field) {
      case "name":
        if (c.name.trim().length < 2) errors.name = "errName";
        break;
      // ÉCHEC FERMÉ : un champ ABSENT est traité exactement comme un
      // champ vide. Lorsque l'appelant demande explicitement de
      // vérifier "firstName"/"lastName" (c'est-à-dire lorsque le
      // serveur les a déclarés requis pour ce mode), ne pas les avoir
      // saisis produit TOUJOURS l'erreur -- jamais un silence.
      case "firstName":
        if ((c.firstName ?? "").trim().length < 2) errors.firstName = "errFirstName";
        break;
      case "lastName":
        if ((c.lastName ?? "").trim().length < 2) errors.lastName = "errLastName";
        break;
      case "street":
        if (c.street.trim().length < 5) errors.street = "errStreet";
        break;
      case "postalCode":
        if (patterns.deliveryCountryMissing === true) {
          errors.postalCode = "errDeliveryCountryRequired";
        } else if (!matchesOrDefault(patterns.postalCodePattern, c.postalCode, isValidPostalCode)) {
          errors.postalCode = patterns.postalCodeErrorKey || "errPostalCode";
        }
        break;
      case "city":
        if (c.city.trim().length < 2) errors.city = "errCity";
        break;
      case "phone":
        if (
          !matchesOrDefault(
            patterns.phonePattern,
            c.phone.replace(/[\s.\-]/g, ""),
            isValidPhone
          )
        ) {
          errors.phone = "errPhone";
        }
        break;
      case "email":
        if (!isValidEmail(c.email)) errors.email = "errEmail";
        break;
    }
  }

  return errors;
}

/** Adresse sur une ligne, pour le message de commande. */
export function formatAddress(c: CustomerInfo): string {
  return `${c.street.trim()}, ${c.postalCode.trim()} ${c.city.trim()}`;
}

/**
 * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — nom d'AFFICHAGE normalisé.
 *
 * MIROIR EXACT de la composition faite par `create_order` côté serveur
 * (`nullif(left(btrim(concat_ws(' ', v_first_name, v_last_name)), 120), '')`,
 * supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql) : mêmes
 * entrées, même séparateur, même repli. Le SERVEUR reste l'autorité --
 * cette fonction n'existe que pour que l'écran de confirmation et le
 * message WhatsApp affichent EXACTEMENT ce qui sera persisté, jamais
 * une seconde vérité.
 *
 * Repli sur `name` UNIQUEMENT lorsque ni le prénom ni le nom n'ont été
 * saisis : c'est le cas des modes NON suivis (room_service,
 * click_collect), dont le champ backend reste `customer_name` -- leur
 * comportement est ainsi rigoureusement inchangé.
 */
export function formatCustomerDisplayName(
  c: Pick<CustomerInfo, "name" | "firstName" | "lastName">
): string {
  // Lecture TOTALE (`?? ""`) : `firstName`/`lastName` sont optionnels
  // dans CustomerInfo (voir la justification sur l'interface) -- ce
  // `??` n'est donc pas une précaution décorative, c'est le traitement
  // du cas normal des modes NON suivis, où ces deux clés sont absentes
  // et où le nom d'affichage doit retomber sur `name`. Un champ absent
  // produit un repli propre, jamais une exception dans le chemin de
  // validation de commande.
  const parts = [c.firstName ?? "", c.lastName ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return (c.name ?? "").trim();
  return parts.join(" ").slice(0, 120);
}

/**
 * LOT 2B.4a.2 — message d'erreur de format pour UN champ générique du
 * catalogue backend (tel que renvoyé par
 * get_restaurant_public_field_requirements : "customer_name", "phone",
 * "email", ...), jamais une clé CustomerInfo -- utilisé par le
 * formulaire dynamique (FulfillmentSelector.tsx) qui itère désormais
 * sur SaleModeFieldRequirement[] (lib/sale-modes-types.ts), plus sur
 * un (keyof CustomerInfo)[] figé.
 *
 * Couvre UNIQUEMENT les champs génériques ayant un équivalent
 * CustomerInfo à validation de format déjà connue ici -- "name" pour
 * customer_name, "phone", "email". NE couvre PAS "delivery_address" :
 * ce champ backend unique correspond à 3 sous-champs UI (street /
 * postalCode / city, cas spécial documenté dans
 * lib/sale-modes-types.ts et rendu séparément par le formulaire), sa
 * validation de format reste celle déjà existante ci-dessus (les
 * cases "street"/"postalCode"/"city" de getCustomerErrors),
 * inchangée. Un champ générique inconnu de cette liste (ex. un futur
 * "delivery_instructions" ajouté uniquement côté configuration/base)
 * retourne toujours `undefined` -- aucune règle de format à
 * appliquer ici ; sa présence reste validée génériquement par
 * validateCustomerData() (lib/sale-modes-public.ts), jamais par cette
 * fonction.
 *
 * Pure, sans effet de bord, réutilise exclusivement isValidPhone/
 * isValidEmail déjà définies ci-dessus -- aucune seconde
 * implémentation de ces règles.
 */
export function genericFieldFormatError(field: string, value: string): string | undefined {
  switch (field) {
    case "customer_name":
      return value.trim().length < 2 ? "errName" : undefined;
    // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 -- deux champs backend
    // supplémentaires, MÊME règle de forme que customer_name (aucune
    // règle inventée : un nom reste un nom). La DÉCISION de les exiger
    // ou non n'est jamais prise ici -- elle vient exclusivement des
    // exigences effectives résolues côté serveur.
    case "first_name":
      return value.trim().length < 2 ? "errFirstName" : undefined;
    case "last_name":
      return value.trim().length < 2 ? "errLastName" : undefined;
    case "phone":
      return isValidPhone(value) ? undefined : "errPhone";
    case "email":
      return isValidEmail(value) ? undefined : "errEmail";
    default:
      return undefined;
  }
}
