import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_INVOICE_REQUEST,
  getInvoiceRequestErrors,
  hasInvoiceRequestErrors,
  normalizeOptional,
  INVOICE_FIELD_MAX_LENGTHS,
  type InvoiceRequestInfo,
} from "../lib/invoice-request.ts";

// ====================================================================
// SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1.
// Tests de la logique de validation PURE (aucune dépendance réseau/
// Supabase) -- la RPC SQL reste la SEULE autorité réelle, ces tests
// vérifient uniquement le confort UX côté client.
// ====================================================================

function withInfo(overrides: Partial<InvoiceRequestInfo>): InvoiceRequestInfo {
  return { ...EMPTY_INVOICE_REQUEST, ...overrides };
}

test("1. aucune facture demandée -- pas d'erreur pertinente (wantsInvoice false, jamais évaluée par l'appelant)", () => {
  const info = withInfo({ wantsInvoice: false });
  // Le contrat exact (mandat) : la validation n'est appelée QUE si
  // wantsInvoice est vrai -- ce test documente explicitement que
  // getInvoiceRequestErrors elle-même ne connaît pas ce champ, la
  // décision d'appeler ou non lui revient à l'appelant (MenuView.tsx).
  const errors = getInvoiceRequestErrors(info);
  assert.equal(Object.keys(errors).length, 3, "les champs obligatoires vides (adresse/ville/CP) produisent 3 erreurs -- le pays par défaut 'FR' est déjà valide (2 caractères)");
});

test("2. facture individuelle complète -- aucune erreur", () => {
  const info = withInfo({
    wantsInvoice: true,
    invoiceType: "individual",
    addressLine1: "12 rue Test",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  });
  assert.deepEqual(getInvoiceRequestErrors(info), {});
  assert.equal(hasInvoiceRequestErrors(info), false);
});

test("3. facture société complète -- aucune erreur", () => {
  const info = withInfo({
    wantsInvoice: true,
    invoiceType: "company",
    addressLine1: "1 avenue Société",
    city: "Lyon",
    postalCode: "69001",
    country: "FR",
    companyLegalName: "ACME SARL",
  });
  assert.deepEqual(getInvoiceRequestErrors(info), {});
});

test("4. société SANS nom légal -- erreur companyLegalName précisément", () => {
  const info = withInfo({
    wantsInvoice: true,
    invoiceType: "company",
    addressLine1: "1 avenue Société",
    city: "Lyon",
    postalCode: "69001",
    country: "FR",
    companyLegalName: "",
  });
  const errors = getInvoiceRequestErrors(info);
  assert.equal(errors.companyLegalName, "invoiceCompanyNameRequired");
  assert.equal(Object.keys(errors).length, 1, "aucune autre erreur ne doit apparaître -- adresse/ville/CP/pays sont valides ici");
});

test("5. adresse de facturation manquante -- rejetée", () => {
  const info = withInfo({ wantsInvoice: true, invoiceType: "individual", city: "Paris", postalCode: "75001", country: "FR" });
  assert.equal(getInvoiceRequestErrors(info).addressLine1, "invoiceAddressRequired");
});

test("6. invoiceType invalide -- structurellement impossible via le type TypeScript (individual | company uniquement), confirmé par le type lui-même", () => {
  // Ce test documente l'invariant : le TYPE InvoiceType lui-même
  // n'autorise que 'individual' | 'company' -- aucune valeur bogus
  // ne peut être assignée sans erreur de compilation. La validation
  // RUNTIME du format exact reste de la responsabilité de la RPC SQL
  // (voir tests SQL : "6. invoice_type invalide -- REJETÉE").
  const info = withInfo({ wantsInvoice: true, invoiceType: "company", companyLegalName: "X", addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR" });
  assert.ok(info.invoiceType === "individual" || info.invoiceType === "company");
});

test("7. champs optionnels vides normalisés en undefined (normalizeOptional)", () => {
  assert.equal(normalizeOptional(""), undefined);
  assert.equal(normalizeOptional("   "), undefined);
  assert.equal(normalizeOptional("  Jean Contact  "), "Jean Contact");
});

test("8. pays de longueur incorrecte -- rejeté (doit être exactement 2 caractères)", () => {
  const info = withInfo({ wantsInvoice: true, invoiceType: "individual", addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "France" });
  assert.equal(getInvoiceRequestErrors(info).country, "invoiceCountryRequired");
});

test("9. valeur par défaut EMPTY_INVOICE_REQUEST -- wantsInvoice false, pays FR par défaut", () => {
  assert.equal(EMPTY_INVOICE_REQUEST.wantsInvoice, false);
  assert.equal(EMPTY_INVOICE_REQUEST.country, "FR");
  assert.equal(EMPTY_INVOICE_REQUEST.invoiceType, "individual");
});

// ====================================================================
// CORRECTIF v1.4 (Cat Woman INVOICE-V13-RETRY-CORRECTION-01, HIGH,
// "DETERMINISTIC CLIENT VALIDATION"). Les limites ci-dessous sont
// DÉRIVÉES de INVOICE_FIELD_MAX_LENGTHS (elle-même extraite
// textuellement des contraintes CHECK réelles de
// supabase/DRAFT-lot-checkout-invoice-request-v1.sql) -- JAMAIS une
// valeur codée en dur indépendamment, conformément au mandat,
// littéral : "Do NOT hardcode test values without deriving them from
// the actual SQL contract."
// ====================================================================

function repeat(char: string, n: number): string {
  return char.repeat(n);
}

test("10. addressLine1 à la longueur maximale EXACTE (50) -- valide", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: repeat("a", INVOICE_FIELD_MAX_LENGTHS.addressLine1),
    city: "Paris", postalCode: "75001", country: "FR",
  });
  assert.equal(getInvoiceRequestErrors(info).addressLine1, undefined);
});

test("11. addressLine1 à la longueur maximale + 1 -- bloqué AVANT tout appel réseau", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: repeat("a", INVOICE_FIELD_MAX_LENGTHS.addressLine1 + 1),
    city: "Paris", postalCode: "75001", country: "FR",
  });
  assert.equal(getInvoiceRequestErrors(info).addressLine1, "invoiceAddressTooLong");
});

test("12. addressLine2 (optionnel) à la limite + 1 -- bloqué", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: "1 rue X",
    addressLine2: repeat("b", INVOICE_FIELD_MAX_LENGTHS.addressLine2 + 1),
    city: "Paris", postalCode: "75001", country: "FR",
  });
  assert.equal(getInvoiceRequestErrors(info).addressLine2, "invoiceAddressLine2TooLong");
});

test("13. addressLine2 vide -- toujours valide (champ optionnel, mandat inchangé)", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: "1 rue X", addressLine2: "",
    city: "Paris", postalCode: "75001", country: "FR",
  });
  assert.equal(getInvoiceRequestErrors(info).addressLine2, undefined);
});

test("14. city à la limite + 1 -- bloqué", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: "1 rue X",
    city: repeat("c", INVOICE_FIELD_MAX_LENGTHS.city + 1),
    postalCode: "75001", country: "FR",
  });
  assert.equal(getInvoiceRequestErrors(info).city, "invoiceCityTooLong");
});

test("15. postalCode à la limite + 1 -- bloqué", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: "1 rue X", city: "Paris",
    postalCode: repeat("1", INVOICE_FIELD_MAX_LENGTHS.postalCode + 1),
    country: "FR",
  });
  assert.equal(getInvoiceRequestErrors(info).postalCode, "invoicePostalCodeTooLong");
});

test("16. companyLegalName à la limite + 1 -- bloqué (facture société)", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "company",
    addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
    companyLegalName: repeat("d", INVOICE_FIELD_MAX_LENGTHS.companyLegalName + 1),
  });
  assert.equal(getInvoiceRequestErrors(info).companyLegalName, "invoiceCompanyNameTooLong");
});

test("17. vatNumber (optionnel) à la limite + 1 -- bloqué", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "company",
    addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
    companyLegalName: "ACME", vatNumber: repeat("9", INVOICE_FIELD_MAX_LENGTHS.vatNumber + 1),
  });
  assert.equal(getInvoiceRequestErrors(info).vatNumber, "invoiceVatNumberTooLong");
});

test("18. vatNumber vide -- toujours valide (optionnel même pour une société, mandat inchangé)", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "company",
    addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
    companyLegalName: "ACME", vatNumber: "",
  });
  assert.equal(getInvoiceRequestErrors(info).vatNumber, undefined);
});

test("19. contactName à la limite + 1 -- bloqué", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
    contactName: repeat("e", INVOICE_FIELD_MAX_LENGTHS.contactName + 1),
  });
  assert.equal(getInvoiceRequestErrors(info).contactName, "invoiceContactNameTooLong");
});

test("20. contactEmail à la limite + 1 -- bloqué", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "individual",
    addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
    contactEmail: repeat("f", INVOICE_FIELD_MAX_LENGTHS.contactEmail + 1),
  });
  assert.equal(getInvoiceRequestErrors(info).contactEmail, "invoiceContactEmailTooLong");
});

test("21. TOUS les champs à leur limite EXACTE simultanément -- entièrement valide (aucune erreur)", () => {
  const info = withInfo({
    wantsInvoice: true, invoiceType: "company",
    addressLine1: repeat("a", INVOICE_FIELD_MAX_LENGTHS.addressLine1),
    addressLine2: repeat("b", INVOICE_FIELD_MAX_LENGTHS.addressLine2),
    city: repeat("c", INVOICE_FIELD_MAX_LENGTHS.city),
    postalCode: repeat("1", INVOICE_FIELD_MAX_LENGTHS.postalCode),
    country: "FR",
    companyLegalName: repeat("d", INVOICE_FIELD_MAX_LENGTHS.companyLegalName),
    vatNumber: repeat("9", INVOICE_FIELD_MAX_LENGTHS.vatNumber),
    contactName: repeat("e", INVOICE_FIELD_MAX_LENGTHS.contactName),
    contactEmail: repeat("f", INVOICE_FIELD_MAX_LENGTHS.contactEmail),
  });
  assert.deepEqual(getInvoiceRequestErrors(info), {});
  assert.equal(hasInvoiceRequestErrors(info), false);
});
