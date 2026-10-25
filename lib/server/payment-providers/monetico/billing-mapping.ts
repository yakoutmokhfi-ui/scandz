import "server-only";
import type { OrderBillingContext } from "@/lib/server/payment-service";
import { MoneticoProtocolError } from "@/lib/server/payment-providers/monetico/errors";

/**
 * PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1.
 * COUCHE DE MAPPING MONETICO (mandat §16) -- SEULE responsabilité de ce
 * fichier : traduire le vocabulaire INTERNE générique de Scanym
 * (`OrderBillingContext`, `lib/server/payment-service.ts`, PAYMENT
 * P3-B6) vers le vocabulaire EXACT documenté par Monetico
 * (`addressLine1`/`postalCode`/`stateOrProvince`/...), tel que
 * confirmé par la vérification d'annexe précédente (rapport "Monetico
 * Annexe 9.5 verification"). Ce fichier ne connaît NI `contexte_
 * commande`, NI la construction du MAC, NI aucune donnée brute de
 * paiement -- voir `request.ts` pour l'assemblage final de
 * `contexte_commande.billing`/`.shipping`.
 *
 * NE JAMAIS ajouter `firstName`/`lastName`/`civility`/`company`
 * (mandat §4/§16 : "Do not invent firstName/lastName" -- Monetico les
 * documente comme facultatifs, mais Scanym ne scinde JAMAIS un nom
 * client en composantes ; seul le champ `name` de Monetico, qui
 * accepte une chaîne libre, est utilisé).
 *
 * NE JAMAIS implémenter `shoppingCart`/`client` (mandat §15, hors
 * périmètre explicite de ce lot -- pas de signal de fraude, pas
 * d'historique de compte, pas de donnée de naissance/identité
 * nationale).
 */

/** Forme EXACTE du sous-objet `billing` Monetico (Annexe 9.5,
 *  vérifiée) -- champs obligatoires non optionnels dans ce type
 *  TypeScript ; champs facultatifs omis (jamais `""`/`null`) plutôt
 *  que transmis vides (mandat §5/§17). */
export interface MoneticoBillingContext {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, 2 lettres majuscules -- jamais autre chose. */
  country: string;
  /** Obligatoire SI applicable seulement (Annexe 9.5) -- Scanym ne
   *  décide d'aucune règle de "si applicable" ici : transmis
   *  uniquement s'il a été explicitement fourni par l'appelant. */
  stateOrProvince?: string;
  name?: string;
  email?: string;
  phone?: string;
}

/** Forme EXACTE du sous-objet `shipping` Monetico -- structurellement
 *  IDENTIQUE à `billing` (Annexe 9.5, §6.2.2 du guide de migration
 *  3DSecure v2 : mêmes champs, mêmes bornes). Un type distinct est
 *  néanmoins conservé (plutôt qu'un alias) pour que toute évolution
 *  future indépendante des deux objets (mandat §8 : un futur second
 *  prestataire, ou une extension Monetico non symétrique) ne force pas
 *  un couplage accidentel. */
export type MoneticoShippingContext = MoneticoBillingContext;

/** Bornes de longueur Monetico CONFIRMÉES (guide de migration 3DSecure
 *  v2, §6.2.2, entièrement lu -- voir le rapport de vérification
 *  d'annexe). Ces bornes sont défensives ICI : `order_billing_context`
 *  (PAYMENT P3-B6, SQL) applique déjà des CHECK identiques ou plus
 *  stricts à l'écriture -- cette couche ne fait jamais confiance
 *  silencieusement à cette garantie amont et refuse explicitement
 *  (fail-closed) toute valeur qui la violerait malgré tout. */
const MAX_ADDRESS_LINE = 50;
const MAX_CITY = 50;
const MAX_POSTAL_CODE = 10;
const MAX_STATE_OR_PROVINCE = 10;
const MAX_NAME = 45;
const MAX_EMAIL = 100;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/**
 * v2 CORRECTIF (ferme P3B6-MONETICO-FORMAT-01) — forme ISO 3166-2
 * CONSERVATRICE : 2 lettres de pays (majuscules) + tiret + 1 à 3
 * caractères alphanumériques (majuscules), ex. "FR-IDF", "US-CA".
 * C'est une validation de FORME uniquement -- ce dépôt ne contient
 * aucun jeu de données ISO 3166-2 faisant autorité, donc AUCUNE
 * prétention n'est faite de valider l'appartenance au registre complet
 * (mandat v2 §6 : "not registry-membership validation"). Casse : la
 * valeur est normalisée en majuscule avant validation (même précédent
 * que `country` ci-dessus) -- "fr-idf" est donc accepté et normalisé
 * en "FR-IDF", jamais rejeté pour sa seule casse. Espaces : la valeur
 * est `trim()`-ée en amont (voir `optionalField`) mais un espace
 * INTERNE (ex. "FR - IDF") ne correspond à aucun caractère du motif et
 * est donc REJETÉ, jamais silencieusement supprimé.
 */
const STATE_OR_PROVINCE_PATTERN = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

/**
 * PAYMENT P4-B — MONETICO CONTEXTE_COMMANDE FORMAT FIX (25/10/2026).
 * CONSTAT TERRAIN (premier paiement de test Au Lait Cru, TPE test) :
 * Monetico a refusé le formulaire avec « Format invalide pour le(s)
 * champ(s) : /contexte_commande/billing/phone ». Le format attendu par
 * la plateforme est le numéro international E.164 avec un TIRET entre
 * l'indicatif pays et le numéro national (exemple documenté Monetico :
 * `+33-612345678`). `phone` est FACULTATIF dans `billing`/`shipping`.
 *
 * RÈGLE (remplace la règle v2 "chaîne dé-espacée telle quelle") :
 *  - séparateurs de présentation retirés (espaces, points, tirets,
 *    parenthèses) ; un préfixe `00` est lu comme `+` ;
 *  - un numéro fourni en forme INTERNATIONALE (`+CC…`) dont l'indicatif
 *    est reconnu (table ci-dessous, préfixe le plus long d'abord) est
 *    émis sous la forme `+CC-NNNN` ;
 *  - TOUT AUTRE cas (forme nationale `06…`, indicatif inconnu, lettres,
 *    longueur hors E.164) → `phone` OMIS. Jamais de "réparation" : on
 *    n'ajoute JAMAIS un indicatif deviné d'après le pays de facturation
 *    (ce serait potentiellement un AUTRE numéro, mandat v2 §6) et on ne
 *    bloque plus un paiement à cause d'un champ facultatif.
 */
const PHONE_COUNTRY_CODES: ReadonlySet<string> = new Set([
  // 1 chiffre
  "1", "7",
  // 2 chiffres (Europe, Afrique du Nord, Asie principale)
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46",
  "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63",
  "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
  // 3 chiffres (Maghreb, Europe, Moyen-Orient)
  "212", "213", "216", "218", "221", "223", "224", "225", "226", "227", "228", "229",
  "230", "234", "237", "241", "242", "243", "248", "254", "255", "256", "261", "262",
  "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370", "371",
  "372", "373", "374", "375", "376", "377", "378", "380", "381", "382", "383", "385",
  "386", "387", "389", "420", "421", "423", "590", "594", "596", "852", "853", "886",
  "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "972",
  "973", "974", "975", "976", "977", "992", "993", "994", "995", "996", "998",
]);
const PHONE_SEPARATORS = /[\s.\-()]/g;
const PHONE_INTERNATIONAL_PATTERN = /^\+[0-9]{7,15}$/;

/**
 * Forme canonique Monetico `+CC-NNNN` ou `undefined` (omission).
 * Exportée pour test direct ; ne lève jamais d'exception.
 */
export function formatMoneticoPhone(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return undefined;
  let compact = trimmed.replace(PHONE_SEPARATORS, "");
  if (compact.startsWith("00")) compact = "+" + compact.slice(2);
  if (!PHONE_INTERNATIONAL_PATTERN.test(compact)) return undefined;
  const digits = compact.slice(1);
  for (const len of [3, 2, 1]) {
    const cc = digits.slice(0, len);
    if (cc.length === len && PHONE_COUNTRY_CODES.has(cc)) {
      const national = digits.slice(len);
      if (national.length < 4) return undefined;
      return `+${cc}-${national}`;
    }
  }
  return undefined;
}

function requireNonEmpty(value: string | null | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    throw new MoneticoProtocolError(`MONETICO_BILLING_MISSING_${field}`);
  }
  if (trimmed.length > max) {
    throw new MoneticoProtocolError(`MONETICO_BILLING_TOO_LONG_${field}`);
  }
  return trimmed;
}

/** Omission stricte (mandat §5/§17 : "omit rather than manufacture
 *  empty values") -- une chaîne vide/blanche après trim ne produit
 *  JAMAIS une clé présente avec une valeur vide dans l'objet renvoyé. */
function optionalField(
  value: string | null | undefined,
  field: string,
  max: number
): string | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) {
    throw new MoneticoProtocolError(`MONETICO_BILLING_TOO_LONG_${field}`);
  }
  return trimmed;
}

/**
 * v2 CORRECTIF (ferme P3B6-MONETICO-FORMAT-01) — `stateOrProvince` :
 * absent/blanc → omis (même politique que `optionalField`) ; fourni
 * mais dépassant `MAX_STATE_OR_PROVINCE` → rejet explicite (même
 * politique que `optionalField`) ; fourni, de longueur valide, mais de
 * FORME incompatible avec `STATE_OR_PROVINCE_PATTERN` (ex. "IDF", "CA",
 * texte libre, tiret mal placé) → rejet explicite -- JAMAIS omis
 * silencieusement (une valeur malformée mais réellement fournie par
 * l'appelant n'est pas une valeur "absente" : mandat v2 §4 "never
 * silently alter supplied values" s'applique par extension au choix
 * omit/reject lui-même). Normalisation : uniquement la casse
 * (majuscule), comme pour `country` -- aucune autre transformation.
 */
function mapStateOrProvinceField(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_STATE_OR_PROVINCE) {
    throw new MoneticoProtocolError("MONETICO_BILLING_TOO_LONG_STATE_OR_PROVINCE");
  }
  const normalized = trimmed.toUpperCase();
  if (!STATE_OR_PROVINCE_PATTERN.test(normalized)) {
    throw new MoneticoProtocolError("MONETICO_BILLING_INVALID_STATE_OR_PROVINCE");
  }
  return normalized;
}

/**
 * `phone` : voir `formatMoneticoPhone` (PAYMENT P4-B) -- format Monetico
 * `+CC-NNNN` ou omission ; jamais d'exception, jamais de réécriture vers
 * un numéro différent de celui fourni.
 */
function mapPhoneField(value: string | null | undefined): string | undefined {
  return formatMoneticoPhone(value);
}

/**
 * Traduit un `OrderBillingContext` interne (PAYMENT P3-B6) vers le
 * sous-objet `billing` Monetico exact. Fail-closed (`MoneticoProtocolError`)
 * si un champ obligatoire Monetico (`addressLine1`/`city`/`postalCode`/
 * `country`) est manquant ou dépasse sa borne documentée -- défense en
 * profondeur, la RPC `set_order_billing_context` (SQL) ayant déjà
 * validé ces mêmes règles à l'écriture.
 */
export function mapToMoneticoBilling(billing: OrderBillingContext): MoneticoBillingContext {
  const country = (billing.country ?? "").trim().toUpperCase();
  if (!COUNTRY_PATTERN.test(country)) {
    throw new MoneticoProtocolError("MONETICO_BILLING_INVALID_COUNTRY");
  }

  // Construction INCRÉMENTALE, jamais littérale avec des valeurs
  // `undefined` -- un littéral `{ addressLine2: optionalField(...) }`
  // laisserait la CLÉ présente avec la valeur `undefined` (`"addressLine2"
  // in result` resterait `true`), ce qui viole l'exigence d'OMISSION
  // stricte du mandat (§5/§17 : "omit rather than manufacture empty
  // values") au niveau de l'objet TypeScript lui-même -- pas seulement
  // après une sérialisation JSON (qui, elle, aurait de toute façon
  // supprimé la clé). Détecté par test direct (mapToMoneticoBilling
  // avait "en" les clés facultatives avec valeur `undefined`).
  const result: MoneticoBillingContext = {
    addressLine1: requireNonEmpty(billing.addressLine1, "ADDRESS_LINE_1", MAX_ADDRESS_LINE),
    city: requireNonEmpty(billing.city, "CITY", MAX_CITY),
    postalCode: requireNonEmpty(billing.postalCode, "POSTAL_CODE", MAX_POSTAL_CODE),
    country,
  };

  const addressLine2 = optionalField(billing.addressLine2, "ADDRESS_LINE_2", MAX_ADDRESS_LINE);
  if (addressLine2 !== undefined) result.addressLine2 = addressLine2;

  const stateOrProvince = mapStateOrProvinceField(billing.stateOrProvince);
  if (stateOrProvince !== undefined) result.stateOrProvince = stateOrProvince;

  const name = optionalField(billing.customerName, "NAME", MAX_NAME);
  if (name !== undefined) result.name = name;

  const email = optionalField(billing.customerEmail, "EMAIL", MAX_EMAIL);
  if (email !== undefined) result.email = email;

  const phone = mapPhoneField(billing.customerPhone);
  if (phone !== undefined) result.phone = phone;

  return result;
}

/**
 * Traduit le MÊME `OrderBillingContext` interne vers le sous-objet
 * `shipping` Monetico (mandat §14 : envoyé UNIQUEMENT lorsque
 * applicable -- l'appel de cette fonction, jamais son contenu interne,
 * est la décision "applicable ou non" ; voir `request.ts`, qui
 * n'invoque cette fonction que pour le mode `delivery`). Réutilise
 * intégralement `mapToMoneticoBilling` -- Monetico documente `shipping`
 * comme structurellement identique à `billing` (Annexe 9.5) ; AUCUNE
 * seconde implémentation des mêmes règles de validation/bornage.
 */
export function mapToMoneticoShipping(shipping: OrderBillingContext): MoneticoShippingContext {
  return mapToMoneticoBilling(shipping);
}
