import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_SEARCH_MAX_QUERY_LENGTH,
  PRODUCT_SEARCH_MIN_ITEMS,
  PRODUCT_SEARCH_PAGE_SIZE,
  buildProductSearchIndex,
  normalizeSearchText,
  productSearchTokens,
  searchProducts,
} from "../lib/product-search.ts";
import { translate } from "../lib/i18n.ts";

function item(id: string, categoryId: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, category_id: categoryId, name, description: null, short_description: null, price: 1, image_url: null, display_order: 1, is_available: true, ...extra } as any;
}
function category(id: string, name: string, items: any[], extra: Record<string, unknown> = {}) {
  return { id, restaurant_id: "r", name, display_order: 1, is_active: true, menu_items: items, ...extra } as any;
}

test("[PSU-1] normalisation : casse, accents, ligatures, ponctuation, apostrophes courbes", () => {
  assert.equal(normalizeSearchText("  ÉPOISSES  "), "epoisses");
  assert.equal(normalizeSearchText("Raclette à l’ail des ours"), "raclette a l ail des ours");
  assert.equal(normalizeSearchText("Raclette à l'ail"), normalizeSearchText("raclette a l’ail"));
  assert.equal(normalizeSearchText("Cœur de bœuf"), "coeur de boeuf");
  assert.equal(normalizeSearchText("Straße"), "strasse");
  assert.equal(normalizeSearchText("Saint-Nectaire (AOP)"), "saint nectaire aop");
  assert.equal(normalizeSearchText(null), "");
  assert.equal(normalizeSearchText("   "), "");
});

test("[PSU-2] normalisation arabe : voyelles brèves, tatwil et variantes d'alif/ya/ta marbuta unifiés", () => {
  assert.equal(normalizeSearchText("راكليت"), normalizeSearchText("رَاكْلِيت"));
  assert.equal(normalizeSearchText("أجبان"), normalizeSearchText("اجبان"));
  assert.equal(normalizeSearchText("جبنـــة"), normalizeSearchText("جبنه"));
  assert.equal(normalizeSearchText("مستشفى"), normalizeSearchText("مستشفي"));
});

test("[PSU-3] mots de la requête : ET, doublons retirés, requête vide ou sans caractère exploitable = pas de recherche", () => {
  assert.deepEqual(productSearchTokens("Raclette  RACLETTE ail"), ["raclette", "ail"]);
  assert.deepEqual(productSearchTokens(""), []);
  assert.deepEqual(productSearchTokens("  !!! ... "), []);
  assert.deepEqual(productSearchTokens(undefined), []);
  assert.ok(productSearchTokens("x".repeat(500)).join("").length <= PRODUCT_SEARCH_MAX_QUERY_LENGTH);
});

test("[PSU-4] searchProducts : null sans recherche, sinon résultats groupés dans l'ordre reçu, total exact", () => {
  const cats = [
    category("c1", "Fromages", [item("a", "c1", "Comté"), item("b", "c1", "Brie de Meaux")]),
    category("c2", "Boissons", [item("c", "c2", "Cidre brut"), item("d", "c2", "Thé à la menthe")]),
  ];
  const index = buildProductSearchIndex(cats, "fr", "fr");
  assert.equal(searchProducts(cats, index, ""), null);
  assert.equal(searchProducts(cats, index, "   "), null);
  const r = searchProducts(cats, index, "me")!;
  assert.equal(r.total, 2);
  assert.deepEqual(r.groups.map((g) => [g.category.id, g.items.map((i) => i.id)]), [["c1", ["b"]], ["c2", ["d"]]]);
  const none = searchProducts(cats, index, "zzz")!;
  assert.deepEqual([none.total, none.groups.length, none.shown], [0, 0, 0]);
});

test("[PSU-5] pagination : « limit » borne les produits rendus, « total » reste le nombre réel", () => {
  const items = Array.from({ length: 100 }, (_, i) => item(`i${i}`, "c1", `Tomme ${i}`));
  const cats = [category("c1", "Fromages", items)];
  const index = buildProductSearchIndex(cats, "fr", "fr");
  const first = searchProducts(cats, index, "tomme")!;
  assert.equal(first.total, 100);
  assert.equal(first.shown, PRODUCT_SEARCH_PAGE_SIZE);
  assert.equal(searchProducts(cats, index, "tomme", 100)!.shown, 100);
  assert.equal(searchProducts(cats, index, "tomme", 0)!.shown, 0);
});

test("[PSU-6] visibilité : archivé et catégorie inactive exclus ; indisponible conservé s'il est fourni par le catalogue public", () => {
  const cats = [
    category("c1", "Fromages", [
      item("ok", "c1", "Comté"),
      item("old", "c1", "Comté archivé", { archived_at: "2026-01-01T00:00:00Z" }),
      item("rupture", "c1", "Comté en rupture", { is_available: false }),
    ]),
    category("c2", "Masquée", [item("h", "c2", "Comté caché")], { is_active: false }),
  ];
  const index = buildProductSearchIndex(cats, "fr", "fr");
  const ids = searchProducts(cats, index, "comte")!.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, ["ok", "rupture"]);
});

test("[PSU-7] langue : nom traduit validé et nom source indexés ; traduction obsolète ou à relire ignorée", () => {
  const validated = item("v", "c1", "Raclette à l’ail", {
    name_hash: "h1",
    translations: { ar: { name: "راكليت بالثوم", name_status: "validated", name_source_hash: "h1" } },
  });
  const stale = item("s", "c1", "Brie", {
    name_hash: "h2",
    translations: { ar: { name: "بري", name_status: "validated", name_source_hash: "ancien" } },
  });
  const review = item("r", "c1", "Comté", {
    name_hash: "h3",
    translations: { ar: { name: "كومتيه", name_status: "to_review", name_source_hash: "h3" } },
  });
  const cats = [category("c1", "Fromages", [validated, stale, review])];
  const index = buildProductSearchIndex(cats, "ar", "fr");
  const find = (q: string) => searchProducts(cats, index, q)!.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(find("بالثوم"), ["v"]);
  assert.deepEqual(find("ail"), ["v"]);
  assert.deepEqual(find("بري"), [], "traduction obsolète : jamais cherchée");
  assert.deepEqual(find("brie"), ["s"]);
  assert.deepEqual(find("كومتيه"), [], "traduction à relire : jamais cherchée");
});

test("[PSU-8] isolation : l'index ne contient QUE les catégories reçues", () => {
  const a = [category("ca", "A", [item("a1", "ca", "Produit A")])];
  const b = [category("cb", "B", [item("b1", "cb", "Produit B")])];
  const indexA = buildProductSearchIndex(a, "fr", "fr");
  assert.equal(searchProducts(a, indexA, "produit b")!.total, 0);
  assert.equal(searchProducts(a, indexA, "produit a")!.total, 1);
  assert.ok(buildProductSearchIndex(b, "fr", "fr").every((e) => e.item.id === "b1"));
});

test("[PSU-9] seuil d'affichage et libellés FR/EN/AR/NL complets pour chaque clé de la recherche", () => {
  assert.equal(PRODUCT_SEARCH_MIN_ITEMS, 8);
  const keys = [
    "productSearchLabel", "productSearchPlaceholder", "productSearchClear",
    "productSearchResultsOne", "productSearchResultsMany", "productSearchNoResults", "productSearchShowMore",
  ];
  const fr = new Set<string>();
  for (const lang of ["fr", "en", "ar", "nl"]) {
    for (const key of keys) {
      const text = translate(lang, key, { n: 7, query: "zz" });
      assert.notEqual(text, key, `${lang}/${key} manquant`);
      assert.ok(!text.includes("{n}") && !text.includes("{query}"), `${lang}/${key} : variable non remplacée`);
      if (lang === "fr") fr.add(text);
      else assert.ok(!fr.has(text), `${lang}/${key} : identique au français`);
    }
  }
  assert.match(translate("fr", "productSearchNoResults", { query: "zz" }), /« zz »/);
  assert.match(translate("ar", "productSearchLabel"), /\p{Script=Arabic}/u);
});
