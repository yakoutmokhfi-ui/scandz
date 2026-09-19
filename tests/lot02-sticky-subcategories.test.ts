import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalogueGrouping = await import("../lib/catalogue-subcategory-grouping.ts");
const { shouldStickSubcategoryFilter, stickyFocusScrollDelta, STICKY_FOCUS_GAP_PX } = catalogueGrouping;

// ====================================================================
// LOT 02 -- STICKY SUBCATEGORIES -- tests PURS de
// shouldStickSubcategoryFilter() et stickyFocusScrollDelta()
// (lib/catalogue-subcategory-grouping.ts). Le rendu réel est couvert par
// tests/lot02-sticky-subcategories.dom.test.ts.
// ====================================================================

const VIEWPORT = 700;

test("plusieurs sous-catégories + liste plus haute que l'écran -- sticky activé", () => {
  assert.equal(
    shouldStickSubcategoryFilter({ subcategoryCount: 2, catalogueHeight: VIEWPORT + 1, viewportHeight: VIEWPORT }),
    true
  );
  assert.equal(
    shouldStickSubcategoryFilter({ subcategoryCount: 7, catalogueHeight: 5000, viewportHeight: VIEWPORT }),
    true
  );
});

test("liste qui tient dans l'écran (hauteur <= viewport) -- jamais sticky, même avec plusieurs sous-catégories", () => {
  for (const catalogueHeight of [0, 300, VIEWPORT]) {
    assert.equal(
      shouldStickSubcategoryFilter({ subcategoryCount: 5, catalogueHeight, viewportHeight: VIEWPORT }),
      false
    );
  }
});

test("une seule sous-catégorie réelle (ou aucune) -- jamais sticky, même sur une liste très longue", () => {
  for (const subcategoryCount of [0, 1]) {
    assert.equal(
      shouldStickSubcategoryFilter({ subcategoryCount, catalogueHeight: 10_000, viewportHeight: VIEWPORT }),
      false
    );
  }
});

test("viewport non mesurable (0 / NaN, ex. rendu sans mise en page) -- jamais sticky", () => {
  for (const viewportHeight of [0, Number.NaN]) {
    assert.equal(
      shouldStickSubcategoryFilter({ subcategoryCount: 3, catalogueHeight: 2000, viewportHeight }),
      false
    );
  }
});

test("seuil arbitraire en nombre de produits supprimé (décision CIO cycle 4) -- aucune constante ni entrée 'nombre de produits'", () => {
  assert.equal("STICKY_SUBCATEGORY_FILTER_MIN_ITEMS" in catalogueGrouping, false);
  const source = readFileSync(new URL("../lib/catalogue-subcategory-grouping.ts", import.meta.url), "utf8");
  assert.ok(!/MIN_ITEMS/.test(source));
});

test("stickyFocusScrollDelta : élément déjà sous la barre -- aucun défilement", () => {
  assert.equal(stickyFocusScrollDelta(120, 120), 0);
  assert.equal(stickyFocusScrollDelta(300, 120), 0);
});

test("stickyFocusScrollDelta : élément masqué (partiellement ou au-dessus du viewport) -- remonte juste sous la barre + marge", () => {
  assert.equal(stickyFocusScrollDelta(50, 120), 50 - 120 - STICKY_FOCUS_GAP_PX);
  assert.equal(stickyFocusScrollDelta(-400, 120), -400 - 120 - STICKY_FOCUS_GAP_PX);
  assert.ok(stickyFocusScrollDelta(119, 120) < 0);
});

test("aucun observer navigateur ni écouteur scroll ; l'unique écouteur resize de MenuView est retiré au nettoyage", () => {
  for (const file of ["components/SubcategoryFilter.tsx", "components/MenuView.tsx", "lib/catalogue-subcategory-grouping.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/IntersectionObserver|ResizeObserver|MutationObserver/.test(source), `${file} ne doit utiliser aucun observer`);
    assert.ok(!/addEventListener\(\s*["']scroll["']/.test(source), `${file} ne doit ajouter aucun écouteur scroll`);
    const adds = source.match(/addEventListener\(\s*["']resize["']/g)?.length ?? 0;
    const removes = source.match(/removeEventListener\(\s*["']resize["']/g)?.length ?? 0;
    assert.equal(adds, removes, `${file} : chaque écouteur resize doit être retiré`);
  }
});

test("aucun défilement forcé à la sélection d'une sous-catégorie (décision CIO cycle 4)", () => {
  const source = readFileSync(new URL("../components/SubcategoryFilter.tsx", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/scrollIntoView|scrollTo\(|scrollBy\(/.test(code));
});
