import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
// lib/catalogue-import/resolution.ts + preview.ts -- résolution
// catégorie/sous-catégorie, correspondance produit, orchestration
// complète du rapport de Preview.
// ====================================================================

const { resolveCategoriesForRows, resolveSubcategoriesForRows, matchProductsForRows, detectDuplicateRowsWithinFile } =
  await import("../lib/catalogue-import/resolution.ts");
const { buildPreviewReport } = await import("../lib/catalogue-import/preview.ts");
const { makeCategory, makeProduct, makeSubcategory } = await import("./helpers/catalogue-fixtures.ts");

// ------------------------------------------------------------------
// 8. existing category resolution
// ------------------------------------------------------------------

test("8. catégorie existante (correspondance insensible à la casse) -> EXISTING avec son id", () => {
  const existing = [makeCategory({ category_id: "c1", category_name: "Boissons" })];
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "boissons" }]);
  assert.deepEqual(result.get(2), { state: "EXISTING", displayName: "Boissons", existingId: "c1" });
});

// ------------------------------------------------------------------
// 9. would-create category state
// ------------------------------------------------------------------

test("9. catégorie absente du catalogue existant -> WOULD_CREATE, jamais créée", () => {
  const result = resolveCategoriesForRows([], [{ row: 2, categoryNameRaw: "Pizzas" }]);
  assert.deepEqual(result.get(2), { state: "WOULD_CREATE", displayName: "Pizzas", casingConflict: false, casingVariants: undefined });
});

test("catégorie WOULD_CREATE référencée avec 2 casses différentes dans le même fichier -> casingConflict signalé, première casse retenue de façon déterministe", () => {
  const rows = [
    { row: 2, categoryNameRaw: "pizzas" },
    { row: 3, categoryNameRaw: "Pizzas" },
  ];
  const result = resolveCategoriesForRows([], rows);
  assert.equal(result.get(2)!.state, "WOULD_CREATE");
  assert.equal(result.get(2)!.displayName, "pizzas"); // 1re occurrence
  assert.equal(result.get(2)!.casingConflict, true);
  assert.equal(result.get(3)!.displayName, "pizzas");
});

test("catégorie vide -> ERROR (catégorie parent manquante)", () => {
  const result = resolveCategoriesForRows([], [{ row: 2, categoryNameRaw: "   " }]);
  assert.equal(result.get(2)!.state, "ERROR");
});

test("AMBIGUOUS : deux catégories existantes distinctes partagent la même clé normalisée -> résolution refusée", () => {
  const existing = [
    makeCategory({ category_id: "c1", category_name: "Boissons" }),
    makeCategory({ category_id: "c2", category_name: "boissons" }), // ex. une inactive + une active
  ];
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Boissons" }]);
  assert.equal(result.get(2)!.state, "AMBIGUOUS");
  assert.deepEqual(result.get(2)!.ambiguousIds!.sort(), ["c1", "c2"]);
});

// ------------------------------------------------------------------
// 10. existing subcategory resolution
// ------------------------------------------------------------------

test("10. sous-catégorie existante sous une catégorie existante -> EXISTING avec son id", () => {
  const existing = [
    makeCategory({
      category_id: "c1",
      category_name: "Plats",
      subcategories: [makeSubcategory({ subcategory_id: "s1", subcategory_name: "Chauds" })],
    }),
  ];
  const catRes = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Plats" }]);
  const result = resolveSubcategoriesForRows(existing, [
    { row: 2, categoryNameRaw: "Plats", subcategoryNameRaw: "chauds", categoryResolution: catRes.get(2)! },
  ]);
  assert.deepEqual(result.get(2), { state: "EXISTING", displayName: "Chauds", existingId: "s1" });
});

test("sous-catégorie vide -> null (optionnelle, jamais une erreur)", () => {
  const catRes = resolveCategoriesForRows([], [{ row: 2, categoryNameRaw: "Plats" }]);
  const result = resolveSubcategoriesForRows([], [
    { row: 2, categoryNameRaw: "Plats", subcategoryNameRaw: "", categoryResolution: catRes.get(2)! },
  ]);
  assert.equal(result.get(2), null);
});

// ------------------------------------------------------------------
// 11. subcategory without category
// ------------------------------------------------------------------

test("11. sous-catégorie renseignée mais catégorie vide -> cascade en ERROR", () => {
  const catRes = resolveCategoriesForRows([], [{ row: 2, categoryNameRaw: "" }]);
  const result = resolveSubcategoriesForRows([], [
    { row: 2, categoryNameRaw: "", subcategoryNameRaw: "Chauds", categoryResolution: catRes.get(2)! },
  ]);
  assert.equal(result.get(2)!.state, "ERROR");
});

// ------------------------------------------------------------------
// Correspondance produit : NEW / EXISTING MATCH / AMBIGUOUS DUPLICATE
// ------------------------------------------------------------------

test("produit NEW : catégorie WOULD_CREATE -> toujours NEW (rien ne peut exister dans une catégorie pas encore créée)", () => {
  const result = matchProductsForRows([], [
    { row: 2, productNameRaw: "Pizza", categoryResolution: { state: "WOULD_CREATE", displayName: "Pizzas" } },
  ]);
  assert.deepEqual(result.get(2), { state: "NEW" });
});

test("produit EXISTING MATCH : nom normalisé identique dans la MÊME catégorie (directe ou via sous-catégorie)", () => {
  const existing = [
    makeCategory({
      category_id: "c1",
      category_name: "Pizzas",
      products: [makeProduct({ product_id: "p1", name: "Margherita" })],
      subcategories: [
        makeSubcategory({
          subcategory_id: "s1",
          subcategory_name: "Spécialités",
          products: [makeProduct({ product_id: "p2", name: "Quatre Fromages" })],
        }),
      ],
    }),
  ];
  const result = matchProductsForRows(existing, [
    { row: 2, productNameRaw: "margherita", categoryResolution: { state: "EXISTING", displayName: "Pizzas", existingId: "c1" } },
    { row: 3, productNameRaw: "Quatre fromages", categoryResolution: { state: "EXISTING", displayName: "Pizzas", existingId: "c1" } },
  ]);
  assert.deepEqual(result.get(2), { state: "EXISTING_MATCH", existingId: "p1" });
  assert.deepEqual(result.get(3), { state: "EXISTING_MATCH", existingId: "p2" });
});

test("13. produit AMBIGUOUS DUPLICATE : deux produits existants de la même catégorie partagent le même nom normalisé", () => {
  const existing = [
    makeCategory({
      category_id: "c1",
      category_name: "Pizzas",
      products: [makeProduct({ product_id: "p1", name: "Margherita" }), makeProduct({ product_id: "p2", name: "margherita" })],
    }),
  ];
  const result = matchProductsForRows(existing, [
    { row: 2, productNameRaw: "Margherita", categoryResolution: { state: "EXISTING", displayName: "Pizzas", existingId: "c1" } },
  ]);
  assert.equal(result.get(2)!.state, "AMBIGUOUS_DUPLICATE");
  assert.deepEqual(result.get(2)!.ambiguousIds!.sort(), ["p1", "p2"]);
});

// ------------------------------------------------------------------
// 12. duplicate rows inside the uploaded file
// ------------------------------------------------------------------

test("12. deux lignes du même fichier, même catégorie WOULD_CREATE + même nom normalisé -> la 2e est un doublon référençant la 1re", () => {
  const rows = [
    { row: 2, categoryNameRaw: "Pizzas", productNameRaw: "Margherita", categoryResolution: { state: "WOULD_CREATE" as const, displayName: "Pizzas" } },
    { row: 5, categoryNameRaw: "Pizzas", productNameRaw: "margherita", categoryResolution: { state: "WOULD_CREATE" as const, displayName: "Pizzas" } },
  ];
  const duplicates = detectDuplicateRowsWithinFile(rows);
  assert.equal(duplicates.get(5), 2);
  assert.equal(duplicates.has(2), false);
});

test("pas de doublon si les catégories WOULD_CREATE diffèrent", () => {
  const rows = [
    { row: 2, categoryNameRaw: "Pizzas", productNameRaw: "Margherita", categoryResolution: { state: "WOULD_CREATE" as const, displayName: "Pizzas" } },
    { row: 5, categoryNameRaw: "Salades", productNameRaw: "Margherita", categoryResolution: { state: "WOULD_CREATE" as const, displayName: "Salades" } },
  ];
  const duplicates = detectDuplicateRowsWithinFile(rows);
  assert.equal(duplicates.size, 0);
});

// ------------------------------------------------------------------
// buildPreviewReport -- orchestration complète, PLANNED ACTION
// ------------------------------------------------------------------

test("PLANNED ACTION = CREATE pour une catégorie/produit intégralement nouveaux, ligne sans erreur -> status OK", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Pizza", "Catégorie parent": "Pizzas", "Prix TTC (€)": "9.9" } }],
    [],
    []
  );
  assert.equal(report.rows[0].plannedAction, "CREATE");
  assert.equal(report.rows[0].status, "OK");
  assert.equal(report.eligibility, "ELIGIBLE");
});

test("PLANNED ACTION = UPDATE quand une valeur diffère du produit existant matché", () => {
  const existing = [
    makeCategory({
      category_id: "c1",
      category_name: "Pizzas",
      products: [makeProduct({ product_id: "p1", name: "Margherita", price: 8 })],
    }),
  ];
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Margherita", "Catégorie parent": "Pizzas", "Prix TTC (€)": "9.9" } }],
    existing,
    []
  );
  assert.equal(report.rows[0].productMatch.state, "EXISTING_MATCH");
  assert.equal(report.rows[0].plannedAction, "UPDATE");
});

test("PLANNED ACTION = SKIP quand toutes les valeurs sont déjà identiques au produit existant (aucune écriture utile)", () => {
  const existing = [
    makeCategory({
      category_id: "c1",
      category_name: "Pizzas",
      products: [
        makeProduct({
          product_id: "p1",
          name: "Margherita",
          price: 9.9,
          short_description: null,
          description: null,
          tax_rate: null,
          unit_weight_grams: null,
        }),
      ],
    }),
  ];
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Margherita", "Catégorie parent": "Pizzas", "Prix TTC (€)": "9.9" } }],
    existing,
    []
  );
  assert.equal(report.rows[0].plannedAction, "SKIP");
  assert.equal(report.rows[0].status, "OK");
});

test("PLANNED ACTION = BLOCKED dès qu'une erreur bloquante existe, quel que soit l'état de correspondance produit", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "", "Catégorie parent": "Pizzas", "Prix TTC (€)": "9.9" } }],
    [],
    []
  );
  assert.equal(report.rows[0].plannedAction, "BLOCKED");
  assert.equal(report.rows[0].status, "BLOCKED");
  assert.equal(report.eligibility, "NOT_ELIGIBLE");
});

test("éligibilité ELIGIBLE_WITH_WARNINGS : aucune ligne bloquée mais au moins un avertissement", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Pizza", "Catégorie parent": "Pizzas", "Prix TTC (€)": "9.9", Type: "Menu" } }],
    [],
    []
  );
  assert.equal(report.rows[0].status, "WARNING");
  assert.equal(report.eligibility, "ELIGIBLE_WITH_WARNINGS");
});

test("21. deux appels successifs de buildPreviewReport sur les MÊMES lignes produisent un résultat identique (déterminisme)", () => {
  const rows = [{ row: 2, cells: { Nom: "Pizza", "Catégorie parent": "Pizzas", "Prix TTC (€)": "9.9" } }];
  const r1 = buildPreviewReport(rows, [], []);
  const r2 = buildPreviewReport(rows, [], []);
  assert.deepEqual(r1, r2);
});

test("lignes intégralement vides -> ignorées silencieusement, jamais une erreur (ligne de fin de feuille)", () => {
  // Couvert au niveau du service (lib/services/catalogue-import.ts) --
  // ici on vérifie qu'une ligne SANS aucune cellule fournie ne casse
  // pas buildPreviewReport si jamais elle lui parvenait malgré tout
  // (filet de sécurité : la ligne sera alors BLOCKED pour absence de
  // nom/catégorie/prix, jamais une exception).
  const report = buildPreviewReport([{ row: 5, cells: {} }], [], []);
  assert.equal(report.rows[0].status, "BLOCKED");
});
