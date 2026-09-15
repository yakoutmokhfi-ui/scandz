import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
// RESET v1.1 — preuve que lib/catalogue-import/resolution.ts (module
// TS PUR, "il classe seulement", AUCUN accès réseau, AUCUNE RPC
// touchée) ignore bien toute catégorie/sous-catégorie
// RETENUE-DÉSACTIVÉE par un reset (category_is_active === false /
// subcategory_is_active === false) lors de la résolution d'un import
// ultérieur -- mandat v1.1 §3/§4, "clean import must not accidentally
// reuse unwanted legacy structure".
//
// La preuve que le SCHÉMA/get_merchant_catalogue permettent bien,
// EN BASE RÉELLE, la coexistence sans collision d'une catégorie/
// sous-catégorie active et d'une retenue-désactivée de même nom (les
// 2 index uniques partiels concernés) est apportée séparément par
// supabase/tests/operator-catalogue-reset-v1-check.sh, sections
// [v1.1 Q/R] -- jamais dupliquée ici (ce fichier ne teste que la
// logique TS pure de résolution, sans aucune base de données).
// ====================================================================

const { resolveCategoriesForRows, resolveSubcategoriesForRows } = await import(
  "../lib/catalogue-import/resolution.ts"
);
const { makeCategory, makeSubcategory } = await import("./helpers/catalogue-fixtures.ts");

test("[v1.1] catégorie RETENUE-DÉSACTIVÉE (category_is_active: false) par un reset -> IGNORÉE lors de la résolution, une ligne de MÊME NOM résout en WOULD_CREATE, jamais EXISTING", () => {
  const existing = [makeCategory({ category_id: "c1", category_name: "Fromages", category_is_active: false })];
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Fromages" }]);
  assert.deepEqual(result.get(2), {
    state: "WOULD_CREATE",
    displayName: "Fromages",
    casingConflict: false,
    casingVariants: undefined,
  });
});

test("[v1.1] catégorie ACTIVE (category_is_active: true, comportement historique/défaut) -> toujours résolue EXISTING, comportement inchangé", () => {
  const existing = [makeCategory({ category_id: "c1", category_name: "Fromages", category_is_active: true })];
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Fromages" }]);
  assert.deepEqual(result.get(2), { state: "EXISTING", displayName: "Fromages", existingId: "c1" });
});

test("[v1.1] une catégorie ACTIVE et une catégorie RETENUE-DÉSACTIVÉE partageant le même nom normalisé -> la ligne résout EXISTING vers la SEULE catégorie active (jamais AMBIGUOUS, jamais la désactivée)", () => {
  const existing = [
    makeCategory({ category_id: "c-old-inactive", category_name: "Fromages", category_is_active: false }),
    makeCategory({ category_id: "c-new-active", category_name: "Fromages", category_is_active: true }),
  ];
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Fromages" }]);
  assert.deepEqual(result.get(2), { state: "EXISTING", displayName: "Fromages", existingId: "c-new-active" });
});

test("[v1.1] deux catégories RETENUES-DÉSACTIVÉES de même nom (cas dégénéré) -> toutes deux ignorées, WOULD_CREATE -- jamais un faux AMBIGUOUS entre 2 lignes mortes", () => {
  const existing = [
    makeCategory({ category_id: "c1", category_name: "Fromages", category_is_active: false }),
    makeCategory({ category_id: "c2", category_name: "fromages", category_is_active: false }),
  ];
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Fromages" }]);
  assert.equal(result.get(2)!.state, "WOULD_CREATE");
});

test("[v1.1] category_is_active absent de la ligne (base non encore migrée, undefined) -> traité comme actif (repli défensif, comportement historique préservé, jamais une régression silencieuse)", () => {
  const existing = [makeCategory({ category_id: "c1", category_name: "Fromages" })];
  delete (existing[0] as any).category_is_active;
  const result = resolveCategoriesForRows(existing, [{ row: 2, categoryNameRaw: "Fromages" }]);
  assert.deepEqual(result.get(2), { state: "EXISTING", displayName: "Fromages", existingId: "c1" });
});

test("[v1.1] sous-catégorie RETENUE-DÉSACTIVÉE (subcategory_is_active: false) -> IGNORÉE lors de la résolution, une ligne de MÊME NOM résout en WOULD_CREATE", () => {
  const category = makeCategory({
    category_id: "c1",
    category_name: "Fromages",
    subcategories: [makeSubcategory({ subcategory_id: "s1", subcategory_name: "Chevres", subcategory_is_active: false })],
  });
  const result = resolveSubcategoriesForRows(
    [category],
    [
      {
        row: 2,
        categoryNameRaw: "Fromages",
        categoryResolution: { state: "EXISTING", displayName: "Fromages", existingId: "c1" },
        subcategoryNameRaw: "Chevres",
      },
    ]
  );
  assert.equal(result.get(2)!.state, "WOULD_CREATE");
});

test("[v1.1] sous-catégorie ACTIVE (comportement historique/défaut) -> toujours résolue EXISTING, comportement inchangé", () => {
  const category = makeCategory({
    category_id: "c1",
    category_name: "Fromages",
    subcategories: [makeSubcategory({ subcategory_id: "s1", subcategory_name: "Chevres", subcategory_is_active: true })],
  });
  const result = resolveSubcategoriesForRows(
    [category],
    [
      {
        row: 2,
        categoryNameRaw: "Fromages",
        categoryResolution: { state: "EXISTING", displayName: "Fromages", existingId: "c1" },
        subcategoryNameRaw: "Chevres",
      },
    ]
  );
  assert.deepEqual(result.get(2), { state: "EXISTING", displayName: "Chevres", existingId: "s1" });
});
