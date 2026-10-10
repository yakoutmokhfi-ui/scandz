/**
 * SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.4.
 *
 * Module pur, sans dépendance Supabase/réseau -- mêmes conventions
 * que lib/customer.ts. La validation ici est un CONFORT UX
 * (feedback immédiat) -- la RPC SQL `set_order_invoice_request`
 * reste la SEULE autorité de validation réelle (fail-closed),
 * jamais dupliquée ni contournée par ce module.
 *
 * CORRECTIF v1.4 (Cat Woman INVOICE-V13-RETRY-CORRECTION-01, HIGH,
 * section "DETERMINISTIC CLIENT VALIDATION") : les limites de
 * longueur ci-dessous sont extraites TEXTUELLEMENT de
 * `supabase/DRAFT-lot-checkout-invoice-request-v1.sql` (contraintes
 * CHECK `length(...) between 1 and N` sur `order_invoice_request`)
 * -- JAMAIS inventées. Avant v1.4, un dépassement de longueur
 * n'était détectable qu'APRÈS l'appel réseau, échouant de façon
 * déterministe et indéfiniment reproductible -- désormais détecté
 * AVANT tout appel, avec un message précis nommant le champ.
 *
 * LOT EMAIL VALIDATION v1 (Claude Monet) : `contactEmail` n'avait
 * jusqu'ici qu'un contrôle de LONGUEUR, jamais de FORMAT -- une
 * chaîne quelconque sans "@" pouvait être acceptée comme "valide"
 * ici, côté client. Réutilise EXCLUSIVEMENT `isValidEmail`
 * (lib/customer.ts, déjà la référence "maison" pour l'email client
 * du checkout) -- jamais une seconde regex/implémentation
 * indépendante. Le contrôle de format ne s'applique QUE si une
 * valeur non vide est saisie (contactEmail reste un champ
 * OPTIONNEL, inchangé -- ce lot ajoute une règle de FORMAT, jamais
 * une règle d'obligation nouvelle).
 *
 * CUSTOMER BILLING PROFILE v2 (Claude Monet) — TROIS ajouts, aucun
 * concept nouveau :
 *
 *   1. `siren` — identifiant OPTIONNEL d'une facturation société, à
 *      côté du `vatNumber` déjà optionnel. Validation de LONGUEUR
 *      seulement : aucun contrôle de format, aucune clé de contrôle,
 *      aucune dérivation (jamais un SIRET depuis un SIREN, jamais une
 *      TVA depuis un SIREN), aucun appel de registre, et aucune
 *      « correction » de la saisie -- la valeur du client prévaut.
 *      Le dépôt ne porte AUCUN champ SIRET, et ce lot n'en introduit
 *      pas.
 *   2. `firstName`/`lastName` — saisie SÉPARÉE du prénom et du nom
 *      pour une facturation particulier, exactement comme le checkout
 *      le fait déjà pour le client de la commande. Laissés vides, le
 *      prénom/nom de la commande sert de REPLI (voir
 *      `composeBillingContactName`) -- jamais une copie silencieuse
 *      dans l'état du formulaire. Ces deux champs
 *      sont RECOMPOSÉS en un nom d'affichage normalisé par
 *      `formatCustomerDisplayName` (lib/customer.ts, la référence
 *      maison) et écrits dans la colonne EXISTANTE `contact_name` --
 *      aucune colonne dupliquée, aucun second concept de nom. C'est
 *      la convention déjà retenue pour `orders.customer_name`.
 *   3. aucune règle d'obligation nouvelle : ni SIREN, ni TVA, ni
 *      prénom, ni nom ne deviennent requis. Seule la raison sociale
 *      reste requise pour une facture société, comme avant ce lot.
 *
 * INVOICE BACKOFFICE VISIBILITY + BILLING ADDRESS v1 (Claude Monet) :
 * ajoute `deriveInvoiceAddressFromCustomer` ci-dessous -- fonction
 * PURE, sans effet de bord, utilisée par
 * `components/InvoiceRequestFields.tsx` UNIQUEMENT lorsque le client
 * indique (mode livraison) que sa facturation N'EST PAS différente de
 * sa livraison ("Adresse de facturation différente de l'adresse de
 * livraison ?" -> NON, réglage par défaut). Aucune persistance d'un
 * indicateur de réutilisation quelconque -- c'est un état d'interface
 * uniquement (mandat, littéral : "Do not persist a separate reuse
 * flag. The flag is checkout UI state only.").
 */
import { formatCustomerDisplayName, isValidEmail } from "@/lib/customer";
import type { CustomerInfo } from "@/lib/customer";

export type InvoiceType = "individual" | "company";

export interface InvoiceRequestInfo {
  wantsInvoice: boolean;
  invoiceType: InvoiceType;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  country: string;
  companyLegalName: string;
  vatNumber: string;
  /** CUSTOMER BILLING PROFILE v2 -- SIREN tel que saisi, OPTIONNEL en
   *  toutes circonstances (y compris facture société). */
  siren: string;
  /** CUSTOMER BILLING PROFILE v2 -- prénom de facturation (saisie
   *  séparée). Recomposé avec `lastName` dans `contactName` par
   *  `composeBillingContactName` ci-dessous : aucune colonne dédiée. */
  firstName: string;
  /** CUSTOMER BILLING PROFILE v2 -- nom de famille de facturation. */
  lastName: string;
  contactName: string;
  contactEmail: string;
}

export const EMPTY_INVOICE_REQUEST: InvoiceRequestInfo = {
  wantsInvoice: false,
  invoiceType: "individual",
  addressLine1: "",
  addressLine2: "",
  city: "",
  postalCode: "",
  country: "FR",
  companyLegalName: "",
  vatNumber: "",
  siren: "",
  firstName: "",
  lastName: "",
  contactName: "",
  contactEmail: "",
};

/**
 * Limites de longueur MAXIMALE exactes -- extraites textuellement des
 * contraintes CHECK de `order_invoice_request`
 * (supabase/DRAFT-lot-checkout-invoice-request-v1.sql, lignes 91-116
 * et 234-290). Réutilisées à la fois pour la validation et pour
 * l'attribut HTML `maxLength` des champs correspondants -- une SEULE
 * source de vérité cliente, jamais deux chiffres qui pourraient
 * diverger.
 */
export const INVOICE_FIELD_MAX_LENGTHS = {
  addressLine1: 50,
  addressLine2: 50,
  city: 50,
  postalCode: 10,
  companyLegalName: 120,
  vatNumber: 30,
  /** CUSTOMER BILLING PROFILE v2 -- borne de STOCKAGE, jamais un
   *  format : 14 caractères (et non 9) parce que le client peut
   *  saisir son SIREN avec les espaces de lisibilité usuels
   *  (« 123 456 789 ») et que le produit interdit de « corriger » sa
   *  saisie. Miroir exact de la contrainte CHECK de la colonne
   *  (supabase/DRAFT-lot-customer-billing-profile-v2.sql). */
  siren: 14,
  /** Les deux champs de nom se recomposent dans `contact_name` (45) :
   *  chacun est donc borné par cette même limite serveur, et la
   *  recomposition est bornée à son tour. */
  firstName: 45,
  lastName: 45,
  contactName: 45,
  contactEmail: 100,
} as const;

/**
 * CUSTOMER BILLING PROFILE v2 — recompose le nom de contact de
 * facturation à écrire dans la colonne EXISTANTE `contact_name`.
 *
 * v2.1 — CORRECTION D'AUDIT (CBP-01, HIGH). La v2 composait le nom
 * SANS regarder le type de facture : `formatCustomerDisplayName`
 * privilégiant prénom/nom sur le nom unique, un prénom/nom saisi en
 * mode PARTICULIER puis resté dans l'état du formulaire APRÈS une
 * bascule en mode SOCIÉTÉ écrasait le contact société réellement
 * saisi et VISIBLE. Reproduction du mandat : « Alice Martin » (saisi
 * en particulier) était persisté à la place de « Bob Durand » (saisi
 * en société).
 *
 * La composition est donc désormais EXPLICITEMENT typée, et c'est la
 * composition elle-même qui est correcte -- pas un nettoyage d'état
 * ailleurs dans l'interface. Même si de l'état caché de l'autre mode
 * subsiste (et il subsiste : les champs sont simplement démontés),
 * la charge utile ne peut plus le reprendre.
 *
 * SOCIÉTÉ — seul le champ de contact VISIBLE en mode société fait
 * foi (`contactName`). Les champs prénom/nom, qui n'existent pas dans
 * ce mode, sont IGNORÉS, et aucun repli n'est appliqué : c'est
 * exactement le comportement d'avant ce lot pour une facture société.
 *
 * PARTICULIER — prénom et nom explicites d'abord (recomposés par
 * `formatCustomerDisplayName`, la seule autorité du dépôt pour cela),
 * puis, à défaut, le champ de contact générique saisi dans ce même
 * mode, puis, à défaut seulement, le repli APPROUVÉ sur le prénom/nom
 * déjà donné pour la commande. Les champs propres à la société ne
 * sont jamais lus.
 */
export function composeBillingContactName(
  info: Pick<InvoiceRequestInfo, "invoiceType" | "firstName" | "lastName" | "contactName">,
  fallback?: Pick<CustomerInfo, "firstName" | "lastName"> | null
): string {
  if (info.invoiceType === "company") {
    // Le champ de contact société, et RIEN d'autre : ni l'état caché
    // du mode particulier, ni un repli sur le nom de la commande.
    // Comportement identique à celui d'avant CUSTOMER BILLING PROFILE
    // v2 (normalizeOptional(contactName)).
    return info.contactName.trim();
  }

  const own = formatCustomerDisplayName({
    name: info.contactName,
    firstName: info.firstName,
    lastName: info.lastName,
  });
  if (own !== "") return own;
  // REPLI, et seulement en l'absence totale de saisie de facturation :
  // le prénom/nom déjà donné pour la commande. La saisie du client
  // PRÉVAUT toujours (elle est testée en premier), et ce repli n'est
  // jamais recopié dans l'état du formulaire -- il est simplement
  // retenu au moment de construire la charge utile, et montré au
  // client en indication dans le champ.
  if (!fallback) return "";
  return formatCustomerDisplayName({
    name: "",
    firstName: fallback.firstName,
    lastName: fallback.lastName,
  });
}

/**
 * Dérive l'adresse de facturation depuis l'adresse de LIVRAISON du
 * client (`customer`) -- utilisée UNIQUEMENT lorsque le client répond
 * NON (réglage par défaut) à "Adresse de facturation différente de
 * l'adresse de livraison ?" en mode livraison. Fonction PURE, aucun
 * effet de bord, aucune persistance -- l'état "réutiliser l'adresse
 * de livraison" reste un booléen d'interface local à
 * `components/InvoiceRequestFields.tsx`, jamais transmis ni stocké
 * (mandat, littéral : "Do not persist a separate reuse flag. The
 * flag is checkout UI state only.").
 *
 * `country` est fixé à "FR" -- `CustomerInfo` ne porte aucun champ
 * pays (le checkout est implicitement France uniquement, cf.
 * `isValidPostalCode` dans lib/customer.ts) ; c'est exactement la
 * valeur par défaut déjà utilisée par `EMPTY_INVOICE_REQUEST.country`
 * ci-dessus, donc aucune nouvelle valeur inventée.
 *
 * `addressLine2` reste vide -- `CustomerInfo` ne porte qu'une seule
 * ligne d'adresse (`street`), jamais de complément d'adresse
 * distinct.
 */
export function deriveInvoiceAddressFromCustomer(
  customer: Pick<CustomerInfo, "street" | "postalCode" | "city">
): Pick<InvoiceRequestInfo, "addressLine1" | "addressLine2" | "city" | "postalCode" | "country"> {
  return {
    addressLine1: customer.street.trim(),
    addressLine2: "",
    city: customer.city.trim(),
    postalCode: customer.postalCode.trim(),
    country: "FR",
  };
}

export type InvoiceRequestErrors = Partial<
  Record<
    | "addressLine1"
    | "addressLine2"
    | "city"
    | "postalCode"
    | "country"
    | "companyLegalName"
    | "vatNumber"
    | "siren"
    | "firstName"
    | "lastName"
    | "contactName"
    | "contactEmail",
    string
  >
>;

/**
 * Valide les champs de la demande de facture -- appelée UNIQUEMENT
 * lorsque `wantsInvoice` est vrai (mandat, littéral : "If NO: preserve
 * current checkout"). Retourne un objet d'erreurs vide si tout est
 * valide, jamais une exception.
 *
 * Couvre désormais (v1.4) DEUX catégories de règles, TOUTES
 * déterministes et alignées sur le contrat SQL réel :
 * 1. champs obligatoires vides (inchangé depuis v1.1) ;
 * 2. dépassement de longueur maximale (nouveau v1.4) -- pour TOUT
 *    champ, obligatoire ou optionnel, dès qu'une valeur non vide est
 *    saisie.
 *
 * Ne duplique JAMAIS une règle non déterministe (validation
 * d'autorité fiscale du numéro de TVA, syntaxe par pays) -- mandat,
 * littéral : "Do not duplicate non-deterministic tax/business
 * validation."
 */
export function getInvoiceRequestErrors(
  info: InvoiceRequestInfo,
  /** v2.1 (CBP-01) -- repli éventuel, pour que la validation porte sur
   *  le nom RÉELLEMENT envoyé et non sur une composition partielle.
   *  Optionnel : un appelant qui ne le fournit pas valide exactement
   *  ce que le formulaire contient. */
  contactNameFallback?: Pick<CustomerInfo, "firstName" | "lastName"> | null
): InvoiceRequestErrors {
  const errors: InvoiceRequestErrors = {};

  if (info.addressLine1.trim().length === 0) {
    errors.addressLine1 = "invoiceAddressRequired";
  } else if (info.addressLine1.trim().length > INVOICE_FIELD_MAX_LENGTHS.addressLine1) {
    errors.addressLine1 = "invoiceAddressTooLong";
  }

  if (info.addressLine2.trim().length > INVOICE_FIELD_MAX_LENGTHS.addressLine2) {
    errors.addressLine2 = "invoiceAddressLine2TooLong";
  }

  if (info.city.trim().length === 0) {
    errors.city = "invoiceCityRequired";
  } else if (info.city.trim().length > INVOICE_FIELD_MAX_LENGTHS.city) {
    errors.city = "invoiceCityTooLong";
  }

  if (info.postalCode.trim().length === 0) {
    errors.postalCode = "invoicePostalCodeRequired";
  } else if (info.postalCode.trim().length > INVOICE_FIELD_MAX_LENGTHS.postalCode) {
    errors.postalCode = "invoicePostalCodeTooLong";
  }

  if (info.country.trim().length !== 2) {
    errors.country = "invoiceCountryRequired";
  }

  if (info.invoiceType === "company" && info.companyLegalName.trim().length === 0) {
    errors.companyLegalName = "invoiceCompanyNameRequired";
  } else if (info.companyLegalName.trim().length > INVOICE_FIELD_MAX_LENGTHS.companyLegalName) {
    errors.companyLegalName = "invoiceCompanyNameTooLong";
  }

  if (info.vatNumber.trim().length > INVOICE_FIELD_MAX_LENGTHS.vatNumber) {
    errors.vatNumber = "invoiceVatNumberTooLong";
  }

  // CUSTOMER BILLING PROFILE v2 -- SIREN : une SEULE règle, la
  // longueur, et seulement si une valeur est saisie. Jamais « requis »
  // (pas même pour une facture société), jamais un contrôle de format,
  // jamais une clé de contrôle, jamais une normalisation : le produit
  // interdit explicitement de corriger un identifiant saisi par le
  // client.
  if (info.siren.trim().length > INVOICE_FIELD_MAX_LENGTHS.siren) {
    errors.siren = "invoiceSirenTooLong";
  }

  // Prénom / nom de facturation : optionnels (ce lot ne crée aucune
  // obligation nouvelle), bornés par la limite serveur de la colonne
  // dans laquelle ils se recomposent.
  if (info.firstName.trim().length > INVOICE_FIELD_MAX_LENGTHS.firstName) {
    errors.firstName = "invoiceFirstNameTooLong";
  }
  if (info.lastName.trim().length > INVOICE_FIELD_MAX_LENGTHS.lastName) {
    errors.lastName = "invoiceLastNameTooLong";
  }
  // v2.1 (CBP-01, observation d'audit) -- la validation porte sur le
  // nom FINAL : celui que `buildInvoicePayload` transmettra, repli
  // compris, et composé selon le TYPE de facture courant. Avant cette
  // correction, un nom de contact composé dépassant la limite de
  // stockage (45 caractères) n'était détecté qu'APRÈS l'appel réseau,
  // par le refus de la RPC.
  if (
    composeBillingContactName(info, contactNameFallback).length >
    INVOICE_FIELD_MAX_LENGTHS.contactName
  ) {
    errors.contactName = "invoiceContactNameTooLong";
  }

  if (info.contactName.trim().length > INVOICE_FIELD_MAX_LENGTHS.contactName) {
    errors.contactName = "invoiceContactNameTooLong";
  }

  const trimmedContactEmail = info.contactEmail.trim();
  if (trimmedContactEmail.length > INVOICE_FIELD_MAX_LENGTHS.contactEmail) {
    errors.contactEmail = "invoiceContactEmailTooLong";
  } else if (trimmedContactEmail.length > 0 && !isValidEmail(trimmedContactEmail)) {
    // LOT EMAIL VALIDATION v1 : champ optionnel -- la règle de format
    // ne s'applique que si une valeur est effectivement saisie
    // (jamais "requis" : ce lot ne modifie pas l'obligation du champ).
    errors.contactEmail = "invoiceContactEmailInvalid";
  }

  return errors;
}

export function hasInvoiceRequestErrors(
  info: InvoiceRequestInfo,
  contactNameFallback?: Pick<CustomerInfo, "firstName" | "lastName"> | null
): boolean {
  return Object.keys(getInvoiceRequestErrors(info, contactNameFallback)).length > 0;
}

/**
 * Normalise une chaîne optionnelle saisie par l'utilisateur --
 * chaîne vide/blanche -> undefined (jamais transmise), sinon la
 * valeur telle quelle (le TRIM final et la validation de longueur
 * restent une responsabilité SERVEUR/SQL, jamais dupliqués ici).
 */
export function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
