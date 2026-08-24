/** Coordonnées saisies par le client (modes retrait / livraison). */
export interface CustomerInfo {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  phone: string;
  email: string;
}

export const EMPTY_CUSTOMER: CustomerInfo = {
  name: "",
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
export function getCustomerErrors(
  c: CustomerInfo,
  required: (keyof CustomerInfo)[]
): Partial<Record<keyof CustomerInfo, string>> {
  const errors: Partial<Record<keyof CustomerInfo, string>> = {};

  for (const field of required) {
    switch (field) {
      case "name":
        if (c.name.trim().length < 2) errors.name = "errName";
        break;
      case "street":
        if (c.street.trim().length < 5) errors.street = "errStreet";
        break;
      case "postalCode":
        if (!isValidPostalCode(c.postalCode)) errors.postalCode = "errPostalCode";
        break;
      case "city":
        if (c.city.trim().length < 2) errors.city = "errCity";
        break;
      case "phone":
        if (!isValidPhone(c.phone)) errors.phone = "errPhone";
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
    case "phone":
      return isValidPhone(value) ? undefined : "errPhone";
    case "email":
      return isValidEmail(value) ? undefined : "errEmail";
    default:
      return undefined;
  }
}
