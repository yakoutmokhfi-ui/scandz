import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
// lib/catalogue-import/normalization.ts + validation.ts +
// price-validation.ts.
// ====================================================================

const { normalizedKey, coerceNumeric, coerceInteger, classifyType, splitTagsColumn } = await import(
  "../lib/catalogue-import/normalization.ts"
);
const { isValidProductPrice, PRODUCT_PRICE_MIN, PRODUCT_PRICE_MAX } = await import(
  "../lib/catalogue-import/price-validation.ts"
);
const { validateRow } = await import("../lib/catalogue-import/validation.ts");

// ------------------------------------------------------------------
// normalizedKey -- même règle que l'index unique en base
// ------------------------------------------------------------------

test("normalizedKey : insensible à la casse, bordures d'espace retirées, AUCUN retrait d'accent (même règle que lower(btrim(name)) en base)", () => {
  assert.equal(normalizedKey("  Boissons  "), "boissons");
  assert.equal(normalizedKey("BOISSONS"), "boissons");
  assert.notEqual(normalizedKey("Café"), normalizedKey("Cafe")); // accent PRÉSERVÉ, jamais replié
});

// ------------------------------------------------------------------
// 4. numeric coercion -- format français (virgule/point, espaces, €, %)
// ------------------------------------------------------------------

test("4. coerceNumeric : virgule ET point décimal acceptés", () => {
  assert.equal(coerceNumeric("12,50"), 12.5);
  assert.equal(coerceNumeric("12.50"), 12.5);
});

test("4. coerceNumeric : espace normal et insécable comme séparateur de milliers, symbole € toléré", () => {
  assert.equal(coerceNumeric("1 234,50 €"), 1234.5);
  assert.equal(coerceNumeric("1 234,50 €"), 1234.5);
});

test("4. coerceNumeric : cellule vide -> undefined (absente), jamais 0 inventé", () => {
  assert.equal(coerceNumeric(""), undefined);
  assert.equal(coerceNumeric("   "), undefined);
});

test("5. invalid price : texte non numérique -> null (invalide, distinct de vide)", () => {
  assert.equal(coerceNumeric("gratuit"), null);
  assert.equal(coerceNumeric("12,50,00"), null);
});

test("5. invalid price : bornes 0..9 999 999 (même contrainte que create_product)", () => {
  assert.equal(PRODUCT_PRICE_MIN, 0);
  assert.equal(PRODUCT_PRICE_MAX, 9999999);
  assert.equal(isValidProductPrice(-1), false);
  assert.equal(isValidProductPrice(10000000), false);
  assert.equal(isValidProductPrice(0), true);
  assert.equal(isValidProductPrice(9999999), true);
});

test("6. invalid tax : TVA hors 0-100 -> détecté par validateRow (SCANYM_INVALID_TAX_RATE)", () => {
  const issues = validateRow({
    values: baseValues({ taxRate: 150 }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_INVALID_TAX_RATE" && i.severity === "BLOCKING_ERROR"));
});

test("6. TVA non numérique -> SCANYM_IMPORT_INVALID_TAX_FORMAT", () => {
  const issues = validateRow({
    values: baseValues({ taxRate: null }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_IMPORT_INVALID_TAX_FORMAT"));
});

test("7. invalid weight : poids négatif ou nul -> SCANYM_INVALID_WEIGHT_VALUE", () => {
  const issues = validateRow({
    values: baseValues({ unitWeightGrams: 0 }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_INVALID_WEIGHT_VALUE" && i.severity === "BLOCKING_ERROR"));
});

test("7. poids décimal (150,5) -> traité comme invalide plutôt qu'arrondi silencieusement", () => {
  assert.equal(coerceInteger("150,5"), null);
});

test("7. coerceInteger : entier valide accepté, cellule absente -> undefined", () => {
  assert.equal(coerceInteger("200"), 200);
  assert.equal(coerceInteger(""), undefined);
});

// ------------------------------------------------------------------
// 16. Type ambiguity handled deterministically
// ------------------------------------------------------------------

test("16. classifyType : colonne absente/vide -> ABSENT, jamais une erreur", () => {
  assert.deepEqual(classifyType(undefined), { kind: "ABSENT" });
  assert.deepEqual(classifyType(""), { kind: "ABSENT" });
  assert.deepEqual(classifyType("   "), { kind: "ABSENT" });
});

test("16. classifyType : TOUTE valeur non vide -> UNSUPPORTED_DECISION_REQUIRED, jamais une devinette de sémantique (mandat 'Do not guess')", () => {
  assert.deepEqual(classifyType("Produit"), { kind: "UNSUPPORTED_DECISION_REQUIRED", rawValue: "Produit" });
  assert.deepEqual(classifyType("Menu"), { kind: "UNSUPPORTED_DECISION_REQUIRED", rawValue: "Menu" });
});

test("16. Type inconnu -> WARNING non bloquant (SCANYM_IMPORT_TYPE_UNSUPPORTED), jamais un blocage de la ligne pour ce seul motif", () => {
  const issues = validateRow({
    values: baseValues({ type: { kind: "UNSUPPORTED_DECISION_REQUIRED", rawValue: "Formule" } }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  const issue = issues.find((i) => i.code === "SCANYM_IMPORT_TYPE_UNSUPPORTED");
  assert.ok(issue);
  assert.equal(issue.severity, "WARNING");
  assert.equal(
    issues.some((i) => i.severity === "BLOCKING_ERROR"),
    false
  );
});

// ------------------------------------------------------------------
// 14. Tags/Collections unsupported warning
// ------------------------------------------------------------------

test("splitTagsColumn : virgule/point-virgule, trim, dédoublonnage insensible à la casse", () => {
  assert.deepEqual(splitTagsColumn("Bestseller, Nouveau; bestseller"), ["Bestseller", "Nouveau"]);
  assert.deepEqual(splitTagsColumn(undefined), []);
  assert.deepEqual(splitTagsColumn(""), []);
});

test("14. tags présents -> INFO 'UNSUPPORTED IN CURRENT BACKEND', jamais bloquant", () => {
  const issues = validateRow({
    values: baseValues({ tags: ["Bestseller"] }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  const issue = issues.find((i) => i.code === "SCANYM_IMPORT_TAGS_UNSUPPORTED");
  assert.ok(issue);
  assert.equal(issue.severity, "INFO");
});

// ------------------------------------------------------------------
// 15. Photo fichier parsed only
// ------------------------------------------------------------------

test("15. photo fichier renseignée -> INFO 'parsée mais non uploadée', jamais bloquant", () => {
  const issues = validateRow({
    values: baseValues({ photoFilename: "pizza.jpg" }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  const issue = issues.find((i) => i.code === "SCANYM_IMPORT_PHOTO_NOT_UPLOADED");
  assert.ok(issue);
  assert.equal(issue.severity, "INFO");
  assert.ok(issue.message.includes("pizza.jpg"));
});

test("15. photo fichier absente -> aucune mention", () => {
  const issues = validateRow({
    values: baseValues({ photoFilename: null }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.equal(
    issues.some((i) => i.code === "SCANYM_IMPORT_PHOTO_NOT_UPLOADED"),
    false
  );
});

// ------------------------------------------------------------------
// Nom manquant / catégorie manquante / sous-catégorie sans catégorie
// ------------------------------------------------------------------

test("nom de produit manquant -> BLOCKING_ERROR", () => {
  const issues = validateRow({
    values: baseValues({ name: "" }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_IMPORT_MISSING_PRODUCT_NAME" && i.severity === "BLOCKING_ERROR"));
});

test("catégorie parent manquante (state ERROR) -> BLOCKING_ERROR", () => {
  const issues = validateRow({
    values: baseValues({}),
    categoryResolution: { state: "ERROR", displayName: "" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_IMPORT_MISSING_PARENT_CATEGORY" && i.severity === "BLOCKING_ERROR"));
});

test("11. sous-catégorie sans catégorie parent valide -> BLOCKING_ERROR", () => {
  const issues = validateRow({
    values: baseValues({}),
    categoryResolution: { state: "ERROR", displayName: "" },
    subcategoryResolution: { state: "ERROR", displayName: "Chaude" },
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_IMPORT_SUBCATEGORY_WITHOUT_CATEGORY" && i.severity === "BLOCKING_ERROR"));
});

test("prix manquant -> BLOCKING_ERROR distinct de 'invalide'", () => {
  const issues = validateRow({
    values: baseValues({ price: undefined }),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_IMPORT_MISSING_PRICE"));
});

test("13. correspondance produit ambiguë -> BLOCKING_ERROR", () => {
  const issues = validateRow({
    values: baseValues({}),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "AMBIGUOUS_DUPLICATE", ambiguousIds: ["p1", "p2"] },
  });
  assert.ok(issues.some((i) => i.code === "SCANYM_IMPORT_AMBIGUOUS_PRODUCT_MATCH" && i.severity === "BLOCKING_ERROR"));
});

test("12. doublon intra-fichier -> BLOCKING_ERROR référençant la ligne d'origine", () => {
  const issues = validateRow({
    values: baseValues({}),
    categoryResolution: { state: "EXISTING", displayName: "Boissons", existingId: "c1" },
    subcategoryResolution: null,
    productMatch: { state: "NEW" },
    duplicateOfRow: 3,
  });
  const issue = issues.find((i) => i.code === "SCANYM_IMPORT_DUPLICATE_ROW_IN_FILE");
  assert.ok(issue);
  assert.equal(issue.severity, "BLOCKING_ERROR");
  assert.ok(issue.message.includes("3"));
});

function baseValues(overrides: Partial<Record<string, unknown>>) {
  return {
    name: "Pizza Margherita",
    shortDescription: null,
    description: null,
    price: 9.9,
    taxRate: 10,
    unitWeightGrams: 350,
    weightIsApproximate: false,
    tags: [] as string[],
    type: { kind: "ABSENT" as const },
    categoryNameRaw: "Pizzas",
    subcategoryNameRaw: "",
    photoFilename: null,
    ...overrides,
  };
}
