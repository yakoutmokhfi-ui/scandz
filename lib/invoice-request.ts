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
 */
import { isValidEmail } from "@/lib/customer";

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
  contactName: 45,
  contactEmail: 100,
} as const;

export type InvoiceRequestErrors = Partial<
  Record<
    | "addressLine1"
    | "addressLine2"
    | "city"
    | "postalCode"
    | "country"
    | "companyLegalName"
    | "vatNumber"
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
export function getInvoiceRequestErrors(info: InvoiceRequestInfo): InvoiceRequestErrors {
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

export function hasInvoiceRequestErrors(info: InvoiceRequestInfo): boolean {
  return Object.keys(getInvoiceRequestErrors(info)).length > 0;
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
