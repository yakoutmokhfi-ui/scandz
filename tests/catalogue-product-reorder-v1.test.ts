import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ====================================================================
// Scanym — CATALOGUE PRODUCT REORDER v1 — logique PURE, contrat
// d'import/export et contrôles structurels.
//
// Voir aussi :
//   tests/catalogue-product-reorder-v1-sql.test.ts  -- la RPC réelle,
//     exécutée sur PostgreSQL local (PGlite) à travers le vrai service ;
//   tests/catalogue-product-reorder-v1.dom.test.ts  -- le vrai écran ;
//   supabase/tests/catalogue-product-reorder-v1-check.sh -- PostgreSQL
//     réel, chaîne de migrations complète, sessions concurrentes ;
//   supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh
//     -- sondes de sûreté HARNESS-01..08 du harnais PostgreSQL.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder";

import {
  applyProductMove,
  canMoveProduct,
  findProductOrderScope,
  isReorderableView,
  moveProductInOrder,
  orderProductsForCatalogue,
  productOrderPositions,
} from "../lib/catalogue-product-order.ts";
import {
  compareMenuItemsForPublicDisplay,
  compareProductsWithinDisplayGroup,
} from "../lib/catalogue-subcategory-grouping.ts";
import {
  CATALOGUE_ORDER_SORT,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  flattenCatalogue,
  isDefaultFilters,
  sortProducts,
} from "../lib/catalogue-management/filtering.ts";
import { buildCatalogueExport, buildExportRows, EXPORT_COLUMNS } from "../lib/catalogue-management/export.ts";
import { IMPORT_COLUMNS } from "../lib/catalogue-import/column-mapping.ts";
import {
  moveProductOrderModel,
  referenceScopeFingerprint,
  type RpcModelRow,
} from "./helpers/catalogue-product-reorder-rpc-model.ts";

// Les modules qui chargent le client Supabase sont importés
// DYNAMIQUEMENT, après la définition des variables d'environnement
// ci-dessus (un import statique serait hissé avant elles).
const { supabase } = await import("../lib/supabase.ts");
const {
  classifyProductOrderError,
  ProductOrderBoundaryError,
  ProductOrderStaleError,
  PRODUCT_ORDER_BOUNDARY_CODE,
  PRODUCT_ORDER_STALE_CODE,
} = await import("../lib/services/catalogue-product-order.ts");
const { getMerchantCatalogue } = await import("../lib/services/dashboard.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

type AnyProduct = ReturnType<typeof product>;

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p1",
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null as string | null,
    subcategory_name: null as string | null,
    name: "Comté",
    name_hash: "h",
    short_description: null as string | null,
    short_description_hash: null,
    description: null as string | null,
    description_hash: null,
    translations: null,
    price: 12.5,
    is_available: true,
    archived_at: null as string | null,
    display_order: 0,
    is_option_source: false,
    image_url: null,
    tax_rate: 5.5 as number | null,
    unit_weight_grams: null as number | null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
    withdrawal_eligible: false,
    allowed_sale_modes: null as string[] | null,
    ...over,
  };
}

function subcategory(id: string, name: string, order: number, products: AnyProduct[]) {
  return {
    subcategory_id: id,
    subcategory_name: name,
    subcategory_display_order: order,
    subcategory_is_active: true,
    subcategory_name_hash: null,
    subcategory_translations: null,
    products: products.map((p) => ({ ...p, subcategory_id: id, subcategory_name: name })),
  };
}

function category(over: Record<string, unknown> = {}) {
  return {
    category_id: "c1",
    category_name: "Fromages",
    category_name_hash: "h",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [] as AnyProduct[],
    subcategories: [] as ReturnType<typeof subcategory>[],
    ...over,
  };
}

/**
 * Catalogue de référence :
 *   Fromages (c1)
 *     directs   : Comté(1) Beaufort(2) Abondance(3, indisponible)
 *     Chèvres s1: quatre EX ÆQUO historiques à 0
 *     Brebis  s2: Ossau(4) Roquefort(9)
 *   Boissons (c2)
 *     directs   : Eau(5) Jus(9) Cidre(14)
 */
function referenceCatalogue() {
  return [
    category({
      category_id: "c1",
      category_name: "Fromages",
      category_display_order: 1,
      products: [
        product({ product_id: "comte", name: "Comté", display_order: 1, allowed_sale_modes: ["pickup"] }),
        product({ product_id: "beaufort", name: "Beaufort", display_order: 2 }),
        product({ product_id: "abondance", name: "Abondance", display_order: 3, is_available: false, tax_rate: null }),
      ],
      subcategories: [
        subcategory("s1", "Chèvres", 1, [
          product({ product_id: "zeste", name: "Zeste de chèvre", display_order: 0 }),
          product({ product_id: "eclat", name: "éclat cendré", display_order: 0 }),
          product({ product_id: "banon", name: "Banon", display_order: 0 }),
          product({ product_id: "crottin", name: "crottin", display_order: 0 }),
        ]),
        subcategory("s2", "Brebis", 2, [
          product({ product_id: "ossau", name: "Ossau", display_order: 4 }),
          product({ product_id: "roquefort", name: "Roquefort", display_order: 9 }),
        ]),
      ],
    }),
    category({
      category_id: "c2",
      category_name: "Boissons",
      category_display_order: 2,
      products: [
        product({ product_id: "eau", name: "Eau", category_id: "c2", category_name: "Boissons", display_order: 5 }),
        product({ product_id: "jus", name: "Jus", category_id: "c2", category_name: "Boissons", display_order: 9 }),
        product({ product_id: "cidre", name: "Cidre", category_id: "c2", category_name: "Boissons", display_order: 14 }),
      ],
    }),
  ];
}

/** Ordre de la carte client (lib/services/restaurant.ts) pour une
 *  catégorie du back-office : produits disponibles et non archivés,
 *  triés par le comparateur PUBLIC, sous-catégorie résolue. */
function storefrontOrder(cat: ReturnType<typeof category>): string[] {
  const items: any[] = [];
  for (const p of cat.products) items.push({ ...p, id: p.product_id });
  for (const sub of cat.subcategories) {
    for (const p of sub.products) {
      items.push({
        ...p,
        id: p.product_id,
        subcategory_name: sub.subcategory_name,
        subcategory_display_order: sub.subcategory_display_order,
      });
    }
  }
  return items
    .filter((i) => i.is_available && !i.archived_at)
    .sort(compareMenuItemsForPublicDisplay)
    .map((i) => i.id);
}

/** Ordre du back-office dans la vue « Ordre de la carte », réduit aux
 *  produits que la carte client affiche. */
function backOfficeOrder(cats: ReturnType<typeof category>[], categoryId: string): string[] {
  return sortProducts(flattenCatalogue(cats as any), CATALOGUE_ORDER_SORT)
    .filter((fp) => fp.categoryId === categoryId)
    .map((fp) => fp.product)
    .filter((p) => p.is_available && !p.archived_at)
    .map((p) => p.product_id);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/** Générateur pseudo-aléatoire DÉTERMINISTE (mulberry32) : une marche
 *  « aléatoire » rejouée à l'identique à chaque exécution. */
function prng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function allProducts(cats: ReturnType<typeof category>[]): AnyProduct[] {
  return cats.flatMap((c) => [...c.products, ...c.subcategories.flatMap((s) => s.products)]);
}

/** Noms piégeux : casse, accents, espaces de bordure, emoji (hors BMP),
 *  formes de présentation arabes (U+FExx), tous EX ÆQUO. */
/** Lignes « menu_items » d'un catalogue de test, pour le modèle du
 *  contrat RPC (le périmètre est le panier qui porte le produit). */
function modelRows(cats: ReturnType<typeof category>[]): RpcModelRow[] {
  const rows: RpcModelRow[] = [];
  for (const c of cats) {
    for (const p of c.products) {
      rows.push({ id: p.product_id, category_id: c.category_id, subcategory_id: null, name: p.name, display_order: p.display_order, archived_at: p.archived_at });
    }
    for (const sub of c.subcategories) {
      for (const p of sub.products) {
        rows.push({ id: p.product_id, category_id: c.category_id, subcategory_id: sub.subcategory_id, name: p.name, display_order: p.display_order, archived_at: p.archived_at });
      }
    }
  }
  return rows;
}

const TRICKY_NAMES = [
  "Zeste",
  "éclair",
  "Éclair au café",
  "  Banon  ",
  "banon affiné",
  "crottin",
  "Crottin de Chavignol",
  "🍕 Pizza",
  "🥐 Croissant",
  "ﻗﻬﻮﺓ",
  "قهوة",
  "Œuf",
  "oeuf",
  "Ÿ",
  "1 litre",
  "10 litres",
  "2 litres",
];

// ==================================================================
// A. UN SEUL comparateur : le back-office affiche l'ordre de la carte
// ==================================================================

test("[A] grouping.ts : compareMenuItemsForPublicDisplay DÉLÈGUE le départage intra-groupe à compareProductsWithinDisplayGroup (une seule règle, jamais deux copies)", () => {
  const src = readFileSync("lib/catalogue-subcategory-grouping.ts", "utf8");
  const start = src.indexOf("export function compareMenuItemsForPublicDisplay(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.ok(body.includes("return compareProductsWithinDisplayGroup(a, b);"));
  assert.equal(
    (src.match(/a\.display_order !== b\.display_order/g) ?? []).length,
    1,
    "la comparaison de display_order produit ne doit exister qu'à UN endroit"
  );
});

test("[A] restaurant.ts (carte client) trie toujours les produits avec compareMenuItemsForPublicDisplay et les catégories par display_order -- ce lot ne modifie pas ce fichier", () => {
  const src = readFileSync("lib/services/restaurant.ts", "utf8");
  assert.ok(src.includes(".sort(compareMenuItemsForPublicDisplay)"));
  assert.ok(src.includes(".sort((a: MenuCategory, b: MenuCategory) => a.display_order - b.display_order)"));
  assert.ok(!src.includes("catalogue-product-order"), "la carte client n'importe rien du réordonnancement");
});

test("[A] à l'intérieur d'un groupe, compareProductsWithinDisplayGroup et le comparateur PUBLIC donnent exactement le même ordre (ex æquo, casse, accents, espaces, emoji, formes arabes)", () => {
  for (const subcategoryId of [null, "s1"]) {
    const items = TRICKY_NAMES.map((name, i) => ({
      id: `id-${String(TRICKY_NAMES.length - i).padStart(2, "0")}`,
      name,
      display_order: 0,
      subcategory_id: subcategoryId,
      subcategory_name: subcategoryId ? "Chèvres" : null,
      subcategory_display_order: subcategoryId ? 1 : null,
    }));
    const viaPublic = [...items].sort(compareMenuItemsForPublicDisplay as any).map((i) => i.id);
    const viaShared = [...items].sort(compareProductsWithinDisplayGroup).map((i) => i.id);
    assert.deepEqual(viaShared, viaPublic);
  }
});

test("[A] orderProductsForCatalogue (back-office) == ordre de la carte client, pour un groupe d'ex æquo piégeux et pour des valeurs distinctes", () => {
  const tied = TRICKY_NAMES.map((name, i) => product({ product_id: `t${i}`, name, display_order: 0 }));
  const distinct = TRICKY_NAMES.map((name, i) => product({ product_id: `d${i}`, name, display_order: (i * 7) % 5 }));
  for (const products of [tied, distinct]) {
    const bo = orderProductsForCatalogue(products).map((p) => p.product_id);
    const publicOrder = products
      .map((p) => ({ ...p, id: p.product_id }))
      .sort(compareMenuItemsForPublicDisplay as any)
      .map((p) => p.id);
    assert.deepEqual(bo, publicOrder);
  }
});

test("[A] STOREFRONT == BO : pour chaque catégorie (directs + sous-catégories), la vue « Ordre de la carte » du back-office liste les produits visibles dans l'ordre exact de la carte client", () => {
  const cats = referenceCatalogue();
  for (const cat of cats) {
    assert.deepEqual(backOfficeOrder(cats, cat.category_id), storefrontOrder(cat), `catégorie ${cat.category_name}`);
  }
  // L'ordre attendu, écrit en clair : directs d'abord, puis chaque
  // sous-catégorie ; Abondance (indisponible) est masquée de la carte.
  assert.deepEqual(storefrontOrder(cats[0]), ["comte", "beaufort", "banon", "crottin", "zeste", "eclat", "ossau", "roquefort"]);
});

test("[A] STOREFRONT == BO après CHAQUE déplacement d'une marche aléatoire de 300 déplacements (tous périmètres confondus)", () => {
  let cats = referenceCatalogue();
  const ids = allProducts(cats).map((p) => p.product_id);
  const rand = prng(20261009);
  let applied = 0;
  for (let i = 0; i < 300; i++) {
    const result = applyProductMove(cats as any, ids[rand(ids.length)], rand(2) === 0 ? "up" : "down");
    if (!result) continue;
    applied++;
    cats = result.categories as any;
    for (const cat of cats) {
      assert.deepEqual(backOfficeOrder(cats, cat.category_id), storefrontOrder(cat));
    }
  }
  assert.ok(applied > 100, `la marche doit réellement déplacer des produits (${applied})`);
});

// ==================================================================
// B. Monter / Descendre, bornes
// ==================================================================

test("[B] déplacer l'élément du MILIEU vers le HAUT l'échange avec son voisin du dessus", () => {
  assert.deepEqual(moveProductInOrder(["a", "b", "c"], "b", "up"), ["b", "a", "c"]);
  const cats = referenceCatalogue();
  const result = applyProductMove(cats as any, "beaufort", "up")!;
  assert.equal(result.position, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(findProductOrderScope(result.categories, "beaufort")!.orderedIds, ["beaufort", "comte", "abondance"]);
});

test("[B] déplacer l'élément du MILIEU vers le BAS l'échange avec son voisin du dessous", () => {
  assert.deepEqual(moveProductInOrder(["a", "b", "c"], "b", "down"), ["a", "c", "b"]);
  const cats = referenceCatalogue();
  const result = applyProductMove(cats as any, "beaufort", "down")!;
  assert.equal(result.position, 3);
  assert.deepEqual(findProductOrderScope(result.categories, "beaufort")!.orderedIds, ["comte", "abondance", "beaufort"]);
});

test("[B] le PREMIER ne peut pas monter : aucun ordre produit, aucun état local produit", () => {
  assert.equal(canMoveProduct(["a", "b", "c"], "a", "up"), false);
  assert.equal(moveProductInOrder(["a", "b", "c"], "a", "up"), null);
  assert.equal(applyProductMove(referenceCatalogue() as any, "comte", "up"), null);
  assert.equal(canMoveProduct(["a", "b", "c"], "a", "down"), true, "… mais il peut descendre");
});

test("[B] le DERNIER ne peut pas descendre", () => {
  assert.equal(canMoveProduct(["a", "b", "c"], "c", "down"), false);
  assert.equal(moveProductInOrder(["a", "b", "c"], "c", "down"), null);
  assert.equal(applyProductMove(referenceCatalogue() as any, "abondance", "down"), null);
  assert.equal(canMoveProduct(["a", "b", "c"], "c", "up"), true, "… mais il peut monter");
});

test("[B] périmètre d'un seul produit, produit inconnu, produit archivé : aucun déplacement", () => {
  assert.equal(canMoveProduct(["a"], "a", "up"), false);
  assert.equal(canMoveProduct(["a"], "a", "down"), false);
  assert.equal(canMoveProduct(["a", "b"], "zzz", "up"), false);
  const cats = referenceCatalogue();
  assert.equal(applyProductMove(cats as any, "inconnu", "up"), null);
  cats[0].products[1].archived_at = "2026-10-01T00:00:00Z";
  assert.equal(findProductOrderScope(cats as any, "beaufort"), null, "un produit archivé n'a pas de périmètre d'ordre");
  assert.equal(applyProductMove(cats as any, "beaufort", "down"), null);
});

test("[B] aucune fonction ne MUTE ses entrées (catalogue gelé en profondeur)", () => {
  const cats = deepFreeze(referenceCatalogue());
  const ids = deepFreeze(["a", "b", "c"]);
  assert.doesNotThrow(() => {
    moveProductInOrder(ids, "b", "up");
    orderProductsForCatalogue(cats[0].products);
    findProductOrderScope(cats as any, "crottin");
    productOrderPositions(cats as any);
    applyProductMove(cats as any, "crottin", "up");
    applyProductMove(cats as any, "jus", "down");
    sortProducts(flattenCatalogue(cats as any), CATALOGUE_ORDER_SORT);
  });
});

// ==================================================================
// C. Périmètres : sous-catégorie, sinon catégorie -- jamais au-delà
// ==================================================================

test("[C] PÉRIMÈTRE SOUS-CATÉGORIE : un produit d'une sous-catégorie ne se réordonne que parmi les produits de CETTE sous-catégorie", () => {
  const cats = referenceCatalogue();
  const scope = findProductOrderScope(cats as any, "crottin")!;
  assert.equal(scope.categoryId, "c1");
  assert.equal(scope.subcategoryId, "s1");
  assert.deepEqual(scope.orderedIds, ["banon", "crottin", "zeste", "eclat"]);

  const result = applyProductMove(cats as any, "crottin", "up")!;
  const [fromages, boissons] = result.categories;
  assert.equal(fromages.products, cats[0].products, "les produits directs de la catégorie sont repris PAR RÉFÉRENCE (intacts)");
  assert.equal(fromages.subcategories[1], cats[0].subcategories[1], "l'autre sous-catégorie est intacte");
  assert.equal(boissons, cats[1], "l'autre catégorie est intacte");
  assert.deepEqual(fromages.subcategories[0].products.map((p) => p.product_id), ["crottin", "banon", "zeste", "eclat"]);
});

test("[C] REPLI CATÉGORIE : un produit sans sous-catégorie ne se réordonne que parmi les produits DIRECTS de sa catégorie", () => {
  const cats = referenceCatalogue();
  const scope = findProductOrderScope(cats as any, "beaufort")!;
  assert.equal(scope.subcategoryId, null);
  assert.deepEqual(scope.orderedIds, ["comte", "beaufort", "abondance"], "aucun produit de sous-catégorie dans le périmètre");

  const result = applyProductMove(cats as any, "beaufort", "down")!;
  const [fromages, boissons] = result.categories;
  assert.equal(fromages.subcategories[0], cats[0].subcategories[0], "Chèvres intacte");
  assert.equal(fromages.subcategories[1], cats[0].subcategories[1], "Brebis intacte");
  assert.equal(boissons, cats[1], "Boissons intacte");
});

test("[C] AUCUN DÉPLACEMENT ENTRE CATÉGORIES : après 500 déplacements aléatoires, chaque produit est toujours dans SA catégorie et SA sous-catégorie, chaque panier contient les mêmes produits", () => {
  const initial = referenceCatalogue();
  const taxonomy = (cats: ReturnType<typeof category>[]) =>
    Object.fromEntries(
      cats.flatMap((c) => [
        [`${c.category_id}/-`, c.products.map((p) => p.product_id).sort()],
        ...c.subcategories.map((s) => [`${c.category_id}/${s.subcategory_id}`, s.products.map((p) => p.product_id).sort()]),
      ])
    );
  const membership = (cats: ReturnType<typeof category>[]) =>
    Object.fromEntries(allProducts(cats).map((p) => [p.product_id, `${p.category_id}/${p.subcategory_id ?? "-"}`]));

  let cats = initial;
  const ids = allProducts(initial).map((p) => p.product_id);
  const rand = prng(7);
  for (let i = 0; i < 500; i++) {
    const result = applyProductMove(cats as any, ids[rand(ids.length)], rand(2) === 0 ? "up" : "down");
    if (result) cats = result.categories as any;
  }
  assert.deepEqual(taxonomy(cats), taxonomy(initial));
  assert.deepEqual(membership(cats), membership(initial));
  assert.equal(allProducts(cats).length, allProducts(initial).length);
});

test("[C] un produit ARCHIVÉ présent dans un panier n'entre pas dans le périmètre et n'est pas renuméroté", () => {
  const cats = referenceCatalogue();
  cats[1].products.push(
    product({ product_id: "vieux", name: "Vieux soda", category_id: "c2", category_name: "Boissons", display_order: 6, archived_at: "2026-01-01T00:00:00Z" })
  );
  assert.deepEqual(findProductOrderScope(cats as any, "jus")!.orderedIds, ["eau", "jus", "cidre"]);
  const result = applyProductMove(cats as any, "jus", "up")!;
  const vieux = result.categories[1].products.find((p) => p.product_id === "vieux")!;
  assert.equal(vieux.display_order, 6);
  assert.equal(vieux.archived_at, "2026-01-01T00:00:00Z");
  assert.equal(result.total, 3);
});

test("[C] VUE TRANSMISE (scope.expected) : pour chaque produit non archivé du périmètre, dans l'ordre affiché, EXACTEMENT { id, display_order, name } -- les valeurs reçues, recopiées telles quelles", () => {
  const cats = referenceCatalogue();
  const direct = findProductOrderScope(cats as any, "beaufort")!;
  assert.deepEqual(direct.expected, [
    { id: "comte", display_order: 1, name: "Comté" },
    { id: "beaufort", display_order: 2, name: "Beaufort" },
    { id: "abondance", display_order: 3, name: "Abondance" },
  ]);
  // Ex æquo : l'ordre de la carte client (nom normalisé, puis id).
  const chevres = findProductOrderScope(cats as any, "zeste")!;
  assert.deepEqual(chevres.expected, [
    { id: "banon", display_order: 0, name: "Banon" },
    { id: "crottin", display_order: 0, name: "crottin" },
    { id: "zeste", display_order: 0, name: "Zeste de chèvre" },
    { id: "eclat", display_order: 0, name: "éclat cendré" },
  ]);
  // Même liste, même ordre que orderedIds ; trois clés, pas une de plus.
  for (const id of allProducts(cats).map((p) => p.product_id)) {
    const scope = findProductOrderScope(cats as any, id)!;
    assert.deepEqual(scope.expected.map((e) => e.id), scope.orderedIds, id);
    for (const entry of scope.expected) assert.deepEqual(Object.keys(entry), ["id", "display_order", "name"]);
  }
});

test("[C] VUE TRANSMISE : aucune normalisation -- casse, espaces, forme Unicode et valeurs négatives partent telles que reçues ; un produit archivé n'y figure pas", () => {
  const cats = referenceCatalogue();
  const raw = ["  Comté  ", "COMTÉ", "Comté", "comté\t"];
  cats[1].products = raw.map((name, i) =>
    product({ product_id: `r${i}`, name, category_id: "c2", category_name: "Boissons", display_order: i - 2 })
  );
  cats[1].products.push(
    product({ product_id: "vieux", name: "Vieux soda", category_id: "c2", category_name: "Boissons", display_order: -9, archived_at: "2026-01-01T00:00:00Z" })
  );
  const scope = findProductOrderScope(cats as any, "r2")!;
  assert.deepEqual(scope.expected, raw.map((name, i) => ({ id: `r${i}`, display_order: i - 2, name })));
  // Le nom transmis est la MÊME chaîne que celle reçue (pas une copie
  // normalisée qui lui ressemblerait).
  for (const [i, entry] of scope.expected.entries()) assert.equal(entry.name, raw[i]);
  assert.ok(!scope.expected.some((e) => e.id === "vieux"));
});

test("[C] VUE TRANSMISE après un déplacement local : elle porte les display_order que la RPC vient d'écrire (1..N), de sorte qu'un second geste sans rechargement envoie une vue FRAÎCHE", () => {
  const cats = referenceCatalogue();
  const first = applyProductMove(cats as any, "cidre", "up")!;
  assert.deepEqual(findProductOrderScope(first.categories as any, "cidre")!.expected, [
    { id: "eau", display_order: 1, name: "Eau" },
    { id: "cidre", display_order: 2, name: "Cidre" },
    { id: "jus", display_order: 3, name: "Jus" },
  ]);
  // Le modèle du contrat serveur, appliqué au même état de départ,
  // aboutit au même état : la vue locale EST la vue serveur.
  const rows = modelRows(cats);
  const outcome = moveProductOrderModel(rows, "cidre", "up", findProductOrderScope(cats as any, "cidre")!.expected);
  assert.equal(outcome.kind, "moved");
  if (outcome.kind === "moved") {
    assert.deepEqual(outcome.writes, { eau: 1, cidre: 2, jus: 3 });
    assert.equal(outcome.position, first.position);
  }
});

// ==================================================================
// D. Modèle persisté : positions entières denses, déterministes
// ==================================================================

test("[D] un déplacement renumérote le périmètre en positions ENTIÈRES denses 1..N, distinctes (jamais de flottant, jamais de doublon)", () => {
  const cats = referenceCatalogue();
  const result = applyProductMove(cats as any, "jus", "down")!; // Boissons : 5 / 9 / 14
  const orders = result.categories[1].products.map((p) => [p.product_id, p.display_order]);
  assert.deepEqual(orders, [["eau", 1], ["cidre", 2], ["jus", 3]]);
  for (const [, value] of orders) assert.ok(Number.isInteger(value));
  assert.equal(new Set(orders.map(([, v]) => v)).size, orders.length);
});

test("[D] CATALOGUE HISTORIQUE (ex æquo) : le premier déplacement matérialise l'ordre que le client voyait DÉJÀ, plus le seul échange demandé -- aucun autre produit ne change de position relative", () => {
  const cats = referenceCatalogue();
  const before = storefrontOrder(cats[0]).filter((id) => ["banon", "crottin", "zeste", "eclat"].includes(id));
  assert.deepEqual(before, ["banon", "crottin", "zeste", "eclat"], "ordre client avant tout geste (é après z : comparaison ordinale)");

  const result = applyProductMove(cats as any, "zeste", "up")!;
  const after = result.categories[0].subcategories[0].products;
  assert.deepEqual(after.map((p) => [p.product_id, p.display_order]), [["banon", 1], ["zeste", 2], ["crottin", 3], ["eclat", 4]]);

  // Toutes les paires qui n'impliquent pas l'échange gardent leur ordre.
  const pos = new Map(after.map((p, i) => [p.product_id, i]));
  for (let i = 0; i < before.length; i++) {
    for (let j = i + 1; j < before.length; j++) {
      const pair = [before[i], before[j]];
      if (pair.includes("zeste") && pair.includes("crottin")) continue;
      assert.ok(pos.get(before[i])! < pos.get(before[j])!, `ordre relatif ${pair.join(" < ")} conservé`);
    }
  }
});

test("[D] un déplacement ne modifie QUE display_order : disponibilité, modes de vente, prix, TVA, noms, archivage, catégorie et sous-catégorie de chaque produit sont identiques", () => {
  let cats = referenceCatalogue();
  const strip = (cs: ReturnType<typeof category>[]) =>
    Object.fromEntries(allProducts(cs).map(({ display_order: _ignored, ...rest }) => [rest.product_id, rest]));
  const before = strip(cats);
  for (const [id, direction] of [["beaufort", "up"], ["comte", "down"], ["zeste", "up"], ["roquefort", "up"], ["jus", "down"], ["abondance", "up"]] as const) {
    const result = applyProductMove(cats as any, id, direction);
    assert.ok(result, `${id} ${direction}`);
    cats = result!.categories as any;
  }
  assert.deepEqual(strip(cats), before);
  // Explicitement : la disponibilité et les modes de vente.
  const byId = Object.fromEntries(allProducts(cats).map((p) => [p.product_id, p]));
  assert.equal(byId.abondance.is_available, false, "un produit indisponible le reste");
  assert.equal(byId.beaufort.is_available, true);
  assert.deepEqual(byId.comte.allowed_sale_modes, ["pickup"], "restriction de mode de vente intacte");
  assert.equal(byId.beaufort.allowed_sale_modes, null, "« tous les modes » (null) reste null, jamais un tableau vide");
});

test("[D] ORDRE DÉTERMINISTE APRÈS RECHARGEMENT : relu depuis les seules valeurs stockées, dans n'importe quel ordre d'arrivée, le périmètre retrouve le même ordre", () => {
  let cats = referenceCatalogue();
  for (const [id, direction] of [["zeste", "up"], ["eclat", "up"], ["banon", "down"]] as const) {
    cats = applyProductMove(cats as any, id, direction)!.categories as any;
  }
  const local = findProductOrderScope(cats as any, "banon")!.orderedIds;
  const stored = cats[0].subcategories[0].products;
  // « Rechargement » : mêmes lignes, ordre d'arrivée quelconque.
  for (const reloaded of [[...stored].reverse(), [stored[2], stored[0], stored[3], stored[1]], [...stored]]) {
    assert.deepEqual(orderProductsForCatalogue(reloaded).map((p) => p.product_id), local);
    assert.deepEqual(orderProductsForCatalogue(reloaded).map((p) => p.display_order), [1, 2, 3, 4]);
  }
});

test("[D] productOrderPositions : position de chaque produit non archivé dans SON périmètre", () => {
  const positions = productOrderPositions(referenceCatalogue() as any);
  assert.deepEqual(positions.get("comte"), { position: 1, total: 3 });
  assert.deepEqual(positions.get("abondance"), { position: 3, total: 3 });
  assert.deepEqual(positions.get("banon"), { position: 1, total: 4 });
  assert.deepEqual(positions.get("eclat"), { position: 4, total: 4 });
  assert.deepEqual(positions.get("roquefort"), { position: 2, total: 2 });
  assert.deepEqual(positions.get("cidre"), { position: 3, total: 3 });
  assert.equal(positions.size, 12);
});

// ==================================================================
// E. Marchand qui ne réordonne jamais : rien ne change
// ==================================================================

test("[E] le tri PAR DÉFAUT du back-office reste « name-asc » : l'écran d'un marchand qui n'utilise pas le réordonnancement est inchangé", () => {
  assert.equal(DEFAULT_SORT, "name-asc");
  assert.equal(EMPTY_FILTERS.sort, "name-asc");
  assert.equal(isDefaultFilters(EMPTY_FILTERS), true);
  assert.equal(isReorderableView(EMPTY_FILTERS), false, "aucun Monter/Descendre dans la vue par défaut");
  const flat = flattenCatalogue(referenceCatalogue() as any);
  assert.deepEqual(
    sortProducts(flat, DEFAULT_SORT).map((f) => f.product.name).slice(0, 4),
    ["Abondance", "Banon", "Beaufort", "Cidre"],
    "tri alphabétique historique intact"
  );
});

test("[E] afficher la vue « Ordre de la carte » ne RÉÉCRIT rien : aucun display_order n'est modifié, les ex æquo restent des ex æquo tant que le marchand ne déplace rien", () => {
  const cats = deepFreeze(referenceCatalogue());
  const sorted = sortProducts(flattenCatalogue(cats as any), CATALOGUE_ORDER_SORT);
  assert.deepEqual(
    sorted.filter((f) => f.subcategoryId === "s1").map((f) => f.product.display_order),
    [0, 0, 0, 0]
  );
  assert.deepEqual(
    sorted.map((f) => f.product.product_id),
    ["comte", "beaufort", "abondance", "banon", "crottin", "zeste", "eclat", "ossau", "roquefort", "eau", "jus", "cidre"],
    "groupes dans l'ordre du catalogue, chaque groupe dans l'ordre de la carte"
  );
});

test("[E] isReorderableView : tri « Ordre de la carte » ET aucun critère masquant des produits À L'INTÉRIEUR d'un périmètre", () => {
  const base = { ...EMPTY_FILTERS, sort: CATALOGUE_ORDER_SORT };
  assert.equal(isReorderableView(base), true);
  // Catégorie / sous-catégorie masquent des périmètres ENTIERS : permis.
  assert.equal(isReorderableView({ ...base, categoryId: "c1" }), true);
  assert.equal(isReorderableView({ ...base, subcategoryId: "s1" }), true);
  // Tout ce qui masque une partie d'un périmètre : interdit.
  assert.equal(isReorderableView({ ...base, search: "com" }), false);
  assert.equal(isReorderableView({ ...base, search: "   " }), true, "une recherche vide (espaces) ne masque rien");
  assert.equal(isReorderableView({ ...base, tagId: "t1" }), false);
  assert.equal(isReorderableView({ ...base, available: true }), false);
  assert.equal(isReorderableView({ ...base, available: false }), false);
  assert.equal(isReorderableView({ ...base, withdrawalEligible: true }), false);
  // Tout autre tri : interdit.
  for (const sort of ["name-asc", "name-desc", "price-asc", "price-desc"] as const) {
    assert.equal(isReorderableView({ ...EMPTY_FILTERS, sort }), false, sort);
  }
});

// ==================================================================
// F. Service : classification des erreurs de la RPC
// ==================================================================

test("[F] classifyProductOrderError : classification sur le COUPLE SQLSTATE + message, jamais sur l'un seul", () => {
  assert.ok(classifyProductOrderError({ code: "P0001", message: PRODUCT_ORDER_STALE_CODE }) instanceof ProductOrderStaleError);
  assert.ok(classifyProductOrderError({ code: "22023", message: PRODUCT_ORDER_BOUNDARY_CODE }) instanceof ProductOrderBoundaryError);
  // Bon message, mauvais code -> générique.
  const wrongCode = classifyProductOrderError({ code: "22023", message: PRODUCT_ORDER_STALE_CODE });
  assert.ok(!(wrongCode instanceof ProductOrderStaleError) && !(wrongCode instanceof ProductOrderBoundaryError));
  // Bon code, autre message -> générique (P0001 est partagé par tout RAISE).
  const otherMessage = classifyProductOrderError({ code: "P0001", message: "STALE_CONTEXT" });
  assert.ok(!(otherMessage instanceof ProductOrderStaleError));
  // Refus d'autorisation : jamais déguisé en « périmé ».
  const denied = classifyProductOrderError({ code: "42501", message: "Not authorized for this product" });
  assert.ok(!(denied instanceof ProductOrderStaleError));
  assert.equal(denied.message, "Not authorized for this product");
  assert.equal(classifyProductOrderError({}).message, "");
});

// ==================================================================
// G. Contrôles structurels
// ==================================================================

const pageSrc = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
const serviceSrc = readFileSync("lib/services/catalogue-product-order.ts", "utf8");
const lotSql = readFileSync("supabase/DRAFT-lot-catalogue-product-reorder-v1.sql", "utf8").replaceAll("\r\n", "\n");
const rollbackSql = readFileSync("supabase/DRAFT-lot-catalogue-product-reorder-v1-ROLLBACK.sql", "utf8").replaceAll("\r\n", "\n");

/** Corps de move_product_order tel qu'écrit dans le DRAFT. */
function functionBody(): string {
  const start = lotSql.indexOf("create function public.move_product_order(");
  const end = lotSql.indexOf("end $$;", start);
  assert.ok(start > 0 && end > start);
  return lotSql.slice(start, end);
}
/** SQL exécutable : commentaires `--` retirés. */
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}
/** INSTRUCTIONS seules : commentaires retirés ET littéraux de chaîne
 *  vidés (`'...'` -> `''`), par un petit automate -- un mot-clé cité
 *  dans un message d'erreur ou dans une expression régulière de
 *  contrôle ne doit pas être pris pour une instruction. Les corps
 *  `$$ ... $$` restent du code. */
function sqlStatements(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    out += sql[i++];
  }
  return out;
}

test("[G] service : UN seul appel, la RPC move_product_order, avec exactement ses trois paramètres ; aucune écriture directe, aucun identifiant d'établissement transmis, aucune clé service_role", () => {
  const code = serviceSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal((code.match(/supabase\.rpc\(/g) ?? []).length, 1);
  assert.ok(code.includes('supabase.rpc("move_product_order", {'));
  for (const param of ["p_product_id: productId", "p_direction: direction", "p_expected_scope: expectedScope.map((entry) => ({"]) {
    assert.ok(code.includes(param), param);
  }
  // La vue part avec ses TROIS champs, recopiés tels quels : aucune
  // normalisation, aucun hachage, aucun recalcul côté client.
  const projection = code.slice(code.indexOf("p_expected_scope:"), code.indexOf("})),"));
  assert.deepEqual(
    [...projection.matchAll(/^\s*(\w+): entry\.(\w+),$/gm)].map((m) => [m[1], m[2]]),
    [["id", "id"], ["display_order", "display_order"], ["name", "name"]]
  );
  assert.ok(!/(normalize|toLowerCase|toUpperCase|trim\(|md5|sha|hash|digest|crypto)/i.test(code), "aucune transformation de la vue");
  assert.ok(!/\.from\(/.test(code), "aucun accès direct à une table");
  assert.ok(!/restaurant/i.test(code), "aucun identifiant d'établissement transmis : le serveur le dérive du produit");
  assert.ok(!/service_role/i.test(code));
});

test("[G] dashboard.ts n'est pas le point d'appel de la nouvelle RPC et garde le chemin numérique historique (set_product_order) tel quel", () => {
  const src = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(!src.includes("move_product_order"));
  assert.ok(src.includes('supabase.rpc("set_product_order"'));
  assert.ok(!/\.from\("menu_items"\)\.update/.test(src));
});

test("[G] écran : Monter/Descendre sont de vrais <button type=\"button\"> nommés ; AUCUN glisser-déposer ; zone aria-live ; le champ numérique historique reste câblé hors vue de réordonnancement", () => {
  const start = pageSrc.indexOf("function ProductReorderControls(");
  const end = pageSrc.indexOf("\n}\n", start);
  const controls = pageSrc.slice(start, end);
  assert.equal((controls.match(/<button\s+type="button"/g) ?? []).length, 2);
  assert.ok(controls.includes('aria-label={t("mcMoveUpAria", { name: productName })}'));
  assert.ok(controls.includes('aria-label={t("mcMoveDownAria", { name: productName })}'));
  assert.ok(controls.includes("disabled={!canMoveUp}") && controls.includes("disabled={!canMoveDown}"));
  for (const forbidden of ["draggable", "onDragStart", "onDragOver", "onDrop", "onPointerDown", "onMouseDown", "onTouchStart"]) {
    assert.ok(!pageSrc.includes(forbidden), `aucun ${forbidden} dans l'écran catalogue`);
  }
  assert.ok(/role="status" aria-live="polite"[^>]*data-testid="catalogue-reorder-status"/.test(pageSrc));
  assert.ok(pageSrc.includes("<OrderField"));
  assert.ok(pageSrc.includes("setProductOrder(p.product_id, order)"));
  assert.ok(pageSrc.includes('from "@/lib/services/catalogue-product-order"'));
});

test("[G] écran : un déplacement transmet la VUE AFFICHÉE du périmètre (scope.expected : id, display_order, name), jamais une liste filtrée ni la liste d'un autre panier", () => {
  const start = pageSrc.indexOf("async function handleMoveProduct(");
  const end = pageSrc.indexOf("\n  }\n", start);
  const handler = pageSrc.slice(start, end);
  assert.ok(handler.includes("findProductOrderScope(categoriesInContext, p.product_id)"));
  assert.ok(handler.includes("await moveProductOrder(p.product_id, direction, scope.expected);"));
  assert.ok(!handler.includes("filteredProducts") && !handler.includes("visibleProductIds"));
  assert.ok(handler.includes("movingProductRef.current"), "un seul déplacement à la fois");
  assert.ok(handler.includes("currentRestaurantRef.current === id"), "garde de changement d'établissement");
});

test("[G] SQL : le lot est strictement ADDITIF -- une fonction créée, aucun ALTER TABLE, aucun index, aucun trigger, aucune redéfinition, aucun backfill", () => {
  const sql = sqlStatements(lotSql);
  assert.equal((sql.match(/\bcreate\s+function\b/gi) ?? []).length, 1);
  assert.ok(!/\bcreate\s+or\s+replace\b/i.test(sql), "aucune fonction existante n'est redéfinie");
  assert.ok(!/\bdrop\s+/i.test(sql), "aucun DROP");
  assert.ok(!/\balter\s+/i.test(sql), "aucun ALTER (table, fonction, rôle…)");
  assert.ok(!/\bcreate\s+(unique\s+)?index\b/i.test(sql));
  assert.ok(!/\bcreate\s+trigger\b/i.test(sql));
  assert.ok(!/\bcreate\s+table\b/i.test(sql));
  assert.ok(!/\binsert\s+into\b/i.test(sql) && !/\bdelete\s+from\b/i.test(sql) && !/\btruncate\b/i.test(sql));
  // Le SEUL UPDATE du fichier est celui de la fonction.
  assert.equal((sql.match(/\bupdate\s+public\./gi) ?? []).length, 1);
  assert.ok(sqlStatements(functionBody()).includes("update public.menu_items mi"));
});

test("[G] SQL : ORDRE, PAS TAXONOMIE -- la seule colonne écrite est display_order ; category_id et subcategory_id ne sont jamais affectés", () => {
  const body = withoutComments(functionBody());
  const update = body.slice(body.indexOf("update public.menu_items mi"));
  const setClause = update.slice(update.indexOf("set "), update.indexOf("from ("));
  assert.equal(setClause.replace(/\s+/g, " ").trim(), "set display_order = n.new_display_order");
  assert.ok(!/(category_id|subcategory_id|is_available|archived_at|price|name)\s*:?=\s*[^=]/.test(setClause));
  // Le périmètre est re-vérifié dans la clause WHERE de l'écriture elle-même.
  const where = update.slice(update.indexOf("where mi.id::text = n.id_text"));
  assert.ok(where.startsWith("where mi.id::text = n.id_text"));
  assert.ok(where.includes("mi.category_id = v_category_id"));
  assert.ok(where.includes("mi.subcategory_id is not distinct from v_subcategory_id"));
  assert.ok(where.includes("mi.archived_at is null"));
});

test("[G] SQL : garde tenant serveur (assert_product_role owner/manager, jamais staff), SECURITY DEFINER, search_path vide, droits authenticated uniquement", () => {
  const body = withoutComments(functionBody());
  assert.ok(body.includes("v_restaurant_id := public.assert_product_role(p_product_id, array['owner','manager']);"));
  assert.ok(!body.includes("'staff'"));
  assert.ok(body.indexOf("assert_product_role") < body.indexOf("pg_advisory_xact_lock"), "l'autorisation précède toute autre action");
  assert.ok(/security definer\s+set search_path = ''/.test(body));
  assert.ok(!/\bp_restaurant_id\b/.test(body), "l'établissement n'est jamais fourni par l'appelant");
  const sql = withoutComments(lotSql);
  assert.ok(sql.includes("revoke all on function public.move_product_order(uuid, text, jsonb) from public, anon, service_role;"));
  assert.ok(sql.includes("grant execute on function public.move_product_order(uuid, text, jsonb) to authenticated;"));
  assert.equal((sql.match(/\bgrant\b/gi) ?? []).length, 1);
});

test("[G] SQL : concurrence -- verrou transactionnel d'établissement, puis verrou des lignes du périmètre (NO KEY), AVANT le contrôle de l'ordre attendu et AVANT l'écriture", () => {
  const body = withoutComments(functionBody());
  const lock = body.indexOf("perform pg_advisory_xact_lock(hashtextextended(v_restaurant_id::text, 2701));");
  const rowLocks = [...body.matchAll(/for no key update;/g)].map((m) => m.index!);
  const stale = body.indexOf("'SCANYM_PRODUCT_ORDER_STALE'");
  const write = body.indexOf("update public.menu_items mi");
  assert.ok(lock > 0);
  assert.equal(rowLocks.length, 2, "le produit ciblé, puis tout le périmètre");
  assert.ok(lock < rowLocks[0] && rowLocks[1] < stale && stale < write);
  assert.ok(!/\bfor update\b/.test(body.replaceAll("for no key update", "")), "jamais FOR UPDATE (bloquerait les clés étrangères des commandes)");
});

test("[G] SQL : aucun ordre flottant ou fractionnaire -- positions entières uniquement", () => {
  const body = withoutComments(functionBody());
  assert.ok(/returns integer/.test(body));
  assert.ok(!/\b(numeric|real|double precision|float\d?|decimal)\b/i.test(body));
  assert.ok(body.includes("end)::integer as new_display_order"));
});

test("[G] SQL : le contrôle de dérive et le contrôle post-application sont DANS la transaction (échec = rollback, quel que soit le client)", () => {
  const begin = lotSql.search(/^begin;$/m);
  const drift = lotSql.indexOf("raise exception\n      'SCANYM_SCHEMA_DRIFT");
  const create = lotSql.indexOf("create function public.move_product_order(");
  const post = lotSql.indexOf("SCANYM_POST_COMMIT_CHECK_FAILED");
  const commit = lotSql.search(/^commit;$/m);
  assert.ok(begin >= 0 && begin < drift && drift < create && create < post && post < commit);
  assert.equal((lotSql.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((lotSql.match(/^commit;$/gm) ?? []).length, 1);
});

test("[G] SQL rollback : retire exactement la fonction du lot, dans une transaction, sans toucher aux données", () => {
  const sql = sqlStatements(rollbackSql);
  assert.deepEqual(sql.match(/\bdrop\s+[^;]+;/gi), ["drop function public.move_product_order(uuid, text, jsonb);"]);
  assert.ok(!/\b(update|delete\s+from|insert\s+into|alter|truncate|create)\b/i.test(sql));
  const raw = withoutComments(rollbackSql);
  assert.ok(raw.search(/^begin;$/m) < raw.indexOf("SCANYM_ROLLBACK_DRIFT"));
  assert.ok(raw.indexOf("SCANYM_ROLLBACK_DRIFT") < raw.indexOf("drop function"));
  assert.ok(raw.indexOf("drop function") < raw.search(/^commit;$/m));
});

test("[G] i18n : toutes les clés du lot existent en FR, EN et AR", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const dict = (name: string) => {
    const start = source.indexOf(`const ${name}: Dict = {`);
    const next = ["fr", "en", "ar"].map((n) => source.indexOf(`const ${n}: Dict = {`, start + 1)).filter((i) => i > start);
    return source.slice(start, next.length ? Math.min(...next) : source.indexOf("const DICTS", start));
  };
  const keys = [
    "mcSortCatalogueOrder", "mcMoveUp", "mcMoveDown", "mcMoveUpAria", "mcMoveDownAria",
    "mcReorderHint", "mcReorderActiveHint", "mcReorderFiltersHint", "mcReorderMoved",
    "mcReorderStale", "mcReorderFailed",
  ];
  for (const lang of ["fr", "en", "ar"]) {
    const body = dict(lang);
    for (const key of keys) assert.ok(new RegExp(`^\\s*${key}: "`, "m").test(body), `${key} absente de ${lang}`);
  }
  // Nom accessible : contient le nom du produit et le libellé visible.
  const fr = dict("fr");
  assert.ok(/mcMoveUpAria: "Monter \{name\}"/.test(fr) && /mcMoveUp: "↑ Monter"/.test(fr));
  assert.ok(/mcMoveDownAria: "Descendre \{name\}"/.test(fr) && /mcMoveDown: "↓ Descendre"/.test(fr));
  assert.ok(/mcReorderMoved: "\{name\} : position \{position\} sur \{total\}\."/.test(fr));
});

test("[G] périmètre du lot : la carte client, le panier, le paiement, les thèmes et les CGV n'importent rien du réordonnancement", () => {
  const untouched = [
    "components/MenuView.tsx", "components/CategoryNav.tsx", "components/SubcategoryFilter.tsx",
    "components/MenuItemCard.tsx", "components/CartPanel.tsx", "lib/cart.ts", "lib/themes.ts",
    "lib/services/restaurant.ts", "lib/services/orders.ts", "lib/sale-modes-public.ts",
    "app/r/[slug]/page.tsx", "app/dashboard/legal-cgv/page.tsx",
  ];
  for (const file of untouched) {
    const src = readFileSync(file, "utf8");
    assert.ok(!/catalogue-product-order|move_product_order|moveProductOrder/.test(src), file);
  }
});

// ==================================================================
// J. FRAÎCHEUR DE LA VUE -- remédiation CPR-AUDIT-01 (contrat)
// ==================================================================

/** L'état de l'audit : Comté=1, Beaufort=2, Abondance=3, puis un autre
 *  utilisateur passe Comté à 2. */
function auditState() {
  const cats = referenceCatalogue();
  const loadedView = findProductOrderScope(cats as any, "abondance")!.expected;
  cats[0].products[0].display_order = 2; // Comté -> 2, par un autre utilisateur
  return { cats, loadedView, rows: modelRows(cats) };
}

/** Ce que vérifiait la PREMIÈRE version de la RPC (candidat refusé) :
 *  mêmes identifiants que le périmètre, display_order STOCKÉS non
 *  décroissants le long de la liste. Reproduit ici pour démontrer ce
 *  que l'audit a trouvé -- jamais utilisé ailleurs. */
function firstVersionAccepted(rows: RpcModelRow[], productId: string, ids: string[]): boolean {
  const product = rows.find((r) => r.id === productId)!;
  const scope = rows.filter((r) => r.category_id === product.category_id && r.subcategory_id === product.subcategory_id && r.archived_at === null);
  if (ids.length !== scope.length || new Set(ids).size !== ids.length) return false;
  const stored = ids.map((id) => scope.find((r) => r.id === id)?.display_order);
  if (stored.some((v) => v === undefined)) return false;
  return stored.every((v, i) => i === 0 || (stored[i - 1] as number) <= (v as number));
}

test("[J] REPRODUCTION DE L'AUDIT au niveau du contrat : la vue périmée [Comté, Beaufort, Abondance] passait le contrôle de la première version (identifiants + monotonie) ; le contrat corrigé la refuse, sans écriture", () => {
  const { cats, loadedView, rows } = auditState();
  assert.deepEqual(loadedView.map((e) => e.id), ["comte", "beaufort", "abondance"]);
  // L'ordre qui fait autorité est devenu Beaufort, Comté, Abondance.
  assert.deepEqual(findProductOrderScope(cats as any, "abondance")!.orderedIds, ["beaufort", "comte", "abondance"]);
  assert.deepEqual(storefrontOrder(cats[0]).slice(0, 2), ["beaufort", "comte"]);

  assert.equal(firstVersionAccepted(rows, "abondance", loadedView.map((e) => e.id)), true, "c'est la faille : la première version acceptait");
  assert.deepEqual(moveProductOrderModel(rows, "abondance", "up", loadedView), { kind: "stale" });

  // La vue fraîche, elle, est acceptée et s'applique à l'ordre réel.
  const fresh = findProductOrderScope(cats as any, "abondance")!.expected;
  assert.deepEqual(moveProductOrderModel(rows, "abondance", "up", fresh), {
    kind: "moved", position: 2, writes: { beaufort: 1, abondance: 2, comte: 3 },
  });
});

test("[J] ce que le contrat COMPARE : l'appartenance, display_order ET name de CHAQUE produit -- changer un seul de ces champs, sur un seul produit, rend la vue périmée ; rien d'autre ne le fait", () => {
  const cats = referenceCatalogue();
  const view = findProductOrderScope(cats as any, "crottin")!.expected;
  const rows = () => modelRows(referenceCatalogue());
  const decide = (mutate: (r: RpcModelRow[]) => void) => {
    const state = rows();
    mutate(state);
    return moveProductOrderModel(state, "crottin", "down", view).kind;
  };
  const row = (state: RpcModelRow[], id: string) => state.find((r) => r.id === id)!;

  assert.equal(decide(() => {}), "moved", "vue fraîche");
  // display_order d'UN produit (même sans changer l'ordre visible).
  assert.equal(decide((s) => { row(s, "eclat").display_order = 1; }), "stale");
  assert.equal(decide((s) => { row(s, "banon").display_order = -1; }), "stale");
  // name d'UN produit : renommage, casse, espace, forme Unicode.
  for (const name of ["Banon AOP", "banon", "Banon ", "Banón"]) {
    assert.equal(decide((s) => { row(s, "banon").name = name; }), "stale", JSON.stringify(name));
  }
  // Appartenance : archivage, départ, arrivée.
  assert.equal(decide((s) => { row(s, "zeste").archived_at = "2026-10-10T00:00:00Z"; }), "stale");
  assert.equal(decide((s) => { row(s, "zeste").subcategory_id = "s2"; }), "stale");
  assert.equal(decide((s) => { row(s, "ossau").subcategory_id = "s1"; }), "stale");
  assert.equal(decide((s) => { s.push({ id: "neuf", category_id: "c1", subcategory_id: "s1", name: "Neuf", display_order: 0, archived_at: null }); }), "stale");
  // Ce qui se passe AILLEURS ne périme pas la vue de ce périmètre.
  assert.equal(decide((s) => { row(s, "comte").display_order = 9; row(s, "eau").name = "Eau gazeuse"; row(s, "ossau").archived_at = "x"; }), "moved");
  assert.equal(decide((s) => { s.push({ id: "neuf", category_id: "c1", subcategory_id: null, name: "Neuf", display_order: 0, archived_at: null }); }), "moved");
});

test("[J] le contrat n'est NI plus strict NI plus laxiste que nécessaire : entre ex æquo d'un état FRAIS l'ordre affiché fait foi ; dès que les valeurs stockées diffèrent, la base fait autorité", () => {
  const rows = modelRows(referenceCatalogue());
  const byId = new Map(rows.map((r) => [r.id, r]));
  const viewOf = (ids: string[]) => ids.map((id) => ({ id, display_order: byId.get(id)!.display_order, name: byId.get(id)!.name }));

  // L'ancien faux serveur des tests DOM exigeait l'ordre canonique
  // EXACT. Le SQL réel accepte toute permutation d'ex æquo d'un état
  // frais : le modèle aussi (le faux serveur n'est donc plus PLUS
  // STRICT que la production).
  for (const ids of [["banon", "crottin", "zeste", "eclat"], ["eclat", "zeste", "crottin", "banon"], ["zeste", "banon", "eclat", "crottin"]]) {
    assert.equal(moveProductOrderModel(rows, "zeste", ids.indexOf("zeste") === 0 ? "down" : "up", viewOf(ids)).kind, "moved", ids.join());
  }
  // Valeurs distinctes : valeurs fraîches mais ordre contraire -> refus.
  assert.equal(moveProductOrderModel(rows, "jus", "up", viewOf(["jus", "eau", "cidre"])).kind, "stale");
  assert.equal(moveProductOrderModel(rows, "jus", "up", viewOf(["eau", "jus", "cidre"])).kind, "moved");
  // Bornes : décidées APRÈS la fraîcheur.
  assert.equal(moveProductOrderModel(rows, "eau", "up", viewOf(["eau", "jus", "cidre"])).kind, "boundary");
  assert.equal(moveProductOrderModel(rows, "eau", "up", viewOf(["eau", "jus"])).kind, "stale", "une vue périmée n'est jamais « à la borne »");
});

test("[J] ÉQUIVALENCE AVEC UNE EMPREINTE DE PÉRIMÈTRE : sur 4 000 couples (vue, état) tirés au hasard, le contrat accepte SI ET SEULEMENT SI empreinte(vue) = empreinte(état) et la liste est non décroissante", () => {
  const rand = prng(8128);
  const pick = <T,>(items: ReadonlyArray<T>): T => items[rand(items.length)];
  let equal = 0, accepted = 0, refused = 0;
  for (let i = 0; i < 4000; i++) {
    const cats = referenceCatalogue();
    // État : ex æquo fréquents (valeurs tirées dans un petit intervalle).
    for (const p of allProducts(cats)) if (rand(2) === 0) p.display_order = rand(4);
    const target = pick(allProducts(cats));
    const view = findProductOrderScope(cats as any, target.product_id)!.expected.map((e) => ({ ...e }));
    // Entre le chargement et l'appel : 0, 1 ou 2 changements.
    for (let c = rand(3); c > 0; c--) {
      const victim = pick(allProducts(cats));
      const kind = rand(4);
      if (kind === 0) victim.display_order = rand(4);
      else if (kind === 1) victim.name = pick([victim.name + "!", victim.name.toUpperCase(), victim.name]);
      else if (kind === 2) victim.archived_at = victim.archived_at ? null : "2026-10-10T00:00:00Z";
      else if (rand(2) === 0 && view.length > 1) [view[0], view[view.length - 1]] = [view[view.length - 1], view[0]]; // vue permutée
    }
    const rows = modelRows(cats);
    const current = rows.find((r) => r.id === target.product_id)!;
    if (current.archived_at !== null) continue;
    const state = rows
      .filter((r) => r.category_id === current.category_id && r.subcategory_id === current.subcategory_id && r.archived_at === null)
      .map((r) => ({ id: r.id, display_order: r.display_order, name: r.name }));
    const sameFingerprint = referenceScopeFingerprint(view) === referenceScopeFingerprint(state);
    const stored = new Map(state.map((e) => [e.id, e.display_order]));
    const nonDecreasing = view.every((e, k) => k === 0 || (stored.get(view[k - 1].id) ?? 0) <= (stored.get(e.id) ?? 0));
    const outcome = moveProductOrderModel(rows, target.product_id, pick(["up", "down"] as const), view);
    const fresh = outcome.kind === "moved" || outcome.kind === "boundary";
    assert.equal(fresh, sameFingerprint && nonDecreasing, JSON.stringify({ view, state, outcome }));
    if (sameFingerprint) equal++;
    if (fresh) accepted++; else refused++;
  }
  assert.ok(accepted > 800 && refused > 800 && equal > accepted - 1, `${accepted} acceptées, ${refused} refusées, ${equal} empreintes égales`);
});

test("[J] SQL : le contrôle de fraîcheur compare display_order ET name de chaque ligne à l'état VERROUILLÉ, octet pour octet, sans jamais convertir une valeur reçue", () => {
  const body = withoutComments(functionBody());
  // Signature : la vue est un jsonb, plus un tableau d'identifiants.
  assert.ok(/p_expected_scope jsonb\s*\)/.test(body));
  assert.ok(!/p_expected_order/.test(withoutComments(lotSql)), "l'ancien paramètre n'existe plus nulle part dans le SQL exécutable");
  // (a) appartenance : jointure sur l'identifiant DANS le périmètre.
  assert.ok(body.includes("on jsonb_typeof(e.item -> 'id') = 'string'"));
  assert.ok(body.includes("and mi.id::text = (e.item ->> 'id')"));
  assert.ok(body.includes("or v_distinct_count <> v_expected_count"));
  // (b) display_order, (c) name.
  assert.ok(body.includes("and (e.item ->> 'display_order') = mi.display_order::text"));
  assert.ok(body.includes(`and (e.item ->> 'name') collate "C" = mi.name::text collate "C"`));
  assert.ok(body.includes("and jsonb_typeof(e.item -> 'display_order') = 'number'"));
  assert.ok(body.includes("and jsonb_typeof(e.item -> 'name') = 'string'"));
  assert.ok(body.includes("or v_fresh_count <> v_expected_count"));
  // (d) monotonie conservée, en défense en profondeur.
  assert.ok(body.includes("or v_out_of_order"));
  // AUCUNE valeur reçue n'est convertie : ni (…)::uuid, ni (…)::integer.
  assert.ok(!/\(e\.item\s*->>?\s*'[a-z_]+'\)\s*::/.test(body), "aucun cast d'une valeur de la charge");
  assert.ok(!/p_expected_scope\s*::/.test(body));
  assert.ok(!/::uuid/.test(body.slice(body.indexOf("begin"))), "aucun ::uuid dans le corps");
  // Ordre des étapes : verrous -> forme -> taille -> fraîcheur -> bornes -> écriture.
  const at = (needle: string, from = 0) => {
    const index = body.indexOf(needle, from);
    assert.ok(index >= 0, needle);
    return index;
  };
  const lastRowLock = body.lastIndexOf("for no key update;");
  const shape = at("jsonb_typeof(p_expected_scope) is distinct from 'array'");
  const size = at("jsonb_array_length(p_expected_scope) <> v_scope_count");
  const freshness = at("from jsonb_array_elements(p_expected_scope) with ordinality as e(item, ord)");
  const boundary = at("'SCANYM_PRODUCT_ORDER_BOUNDARY'");
  const write = at("update public.menu_items mi");
  assert.ok(lastRowLock < shape && shape < size && size < freshness && freshness < boundary && boundary < write);
  // La longueur n'est demandée QUE pour un tableau (deux instructions).
  assert.ok(/'array' then\s+raise exception[\s\S]*?end if;\s+if jsonb_array_length/.test(body));
  // Le contrôle post-application exige ces comparaisons dans le corps INSTALLÉ.
  const post = withoutComments(lotSql.slice(lotSql.indexOf("3. VÉRIFICATION POST-APPLICATION")));
  assert.ok(post.includes("move_product_order sans contrôle de fraîcheur complet (appartenance, display_order, name)"));
  // Le contrôle de dérive exige menu_items.name NOT NULL.
  assert.ok(withoutComments(lotSql).includes("(c.column_name = 'name' and c.data_type in ('character varying', 'text') and c.is_nullable = 'NO')"));
});

test("[J] les trois champs transmis sont TOUS les champs du comparateur de la carte client, et réciproquement", () => {
  const grouping = readFileSync("lib/catalogue-subcategory-grouping.ts", "utf8");
  const start = grouping.indexOf("export function compareProductsWithinDisplayGroup(");
  const comparator = grouping.slice(start, grouping.indexOf("\n}\n", start));
  const fields = [...new Set([...comparator.matchAll(/\b[ab]\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(fields, ["display_order", "id", "name"], "champs lus par le comparateur intra-groupe");
  const order = readFileSync("lib/catalogue-product-order.ts", "utf8");
  const entries = order.slice(order.indexOf("function scopeEntries("), order.indexOf("\n}\n", order.indexOf("function scopeEntries(")));
  assert.deepEqual(
    [...entries.matchAll(/^\s*(\w+): p\.(\w+),$/gm)].map((m) => [m[1], m[2]]),
    [["id", "product_id"], ["display_order", "display_order"], ["name", "name"]]
  );
});

// ==================================================================
// K. SÛRETÉ DU HARNAIS PostgreSQL -- remédiation CPR-AUDIT-02
//
// Contrôles STRUCTURELS, exécutables sur tout poste (aucun PostgreSQL
// requis). Les preuves par l'exécution sont HARNESS-01..08, dans
// supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh.
// ==================================================================

const harnessSrc = readFileSync("supabase/tests/catalogue-product-reorder-v1-check.sh", "utf8").replaceAll("\r\n", "\n");
const harnessLibSrc = readFileSync("supabase/tests/catalogue-product-reorder-v1-harness-lib.sh", "utf8").replaceAll("\r\n", "\n");
const harnessProbeSrc = readFileSync("supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh", "utf8").replaceAll("\r\n", "\n");

/** Lignes EXÉCUTABLES d'un script shell : ni commentaires, ni lignes de
 *  journalisation (dont le texte peut citer des noms de commandes). */
function shellCode(src: string): string[] {
  return src
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => !/^(log|h_log|pass|fail|skip|fatal|check|assert_\w+|h_refuse_gate)\s/.test(line));
}
/** Un binaire PostgreSQL appelé PAR SON NOM, en position de commande
 *  (début de ligne, après un tube, un séparateur, `$(`, ou un mot-clé
 *  du shell) -- donc résolu par le PATH et servi par les défauts
 *  ambiants. Un chemin absolu ("$H_BIN/psql") ou un simple argument
 *  (`command -v initdb`, `hpsql postgres …`) n'en est pas un. */
const POSTGRES_COMMANDS =
  /(?:^|[;|&(`]\s*|\$\(\s*|\b(?:if|then|else|elif|do|while|until|exec|eval|time)\s+|!\s+)(?:psql|createdb|dropdb|createuser|dropuser|initdb|pg_ctl|pg_dump|pg_dumpall|pg_restore|pg_isready|pg_basebackup|vacuumdb|postgres)(?=\s|$)/;

test("[K] harnais : AUCUNE commande PostgreSQL n'est appelée par son nom (donc par les défauts ambiants) -- tout passe par les enveloppes de la bibliothèque de sûreté", () => {
  const offenders = shellCode(harnessSrc).filter((line) => POSTGRES_COMMANDS.test(line));
  assert.deepEqual(offenders, []);
  // … et la bibliothèque elle-même ne lance que des binaires par chemin
  // absolu ("$H_BIN/…"), dans un environnement vide.
  assert.deepEqual(shellCode(harnessLibSrc).filter((line) => POSTGRES_COMMANDS.test(line)), []);
  // Le détecteur détecte bien ce qu'il doit détecter (et rien de plus).
  for (const bad of ['psql -X -c "select 1"', "createdb x", "q | psql -d x", 'x="$(psql -Atc x)"', "if psql -c x; then", "a && dropdb x", "! pg_isready"]) {
    assert.ok(POSTGRES_COMMANDS.test(bad), bad);
  }
  for (const good of ['"$H_BIN/psql" -X', "hpsql postgres -c x", "command -v initdb", "h_server_bin initdb -D x", 'echo "psql"', "hpsql_as anon x"]) {
    assert.ok(!POSTGRES_COMMANDS.test(good), good);
  }
  const wrappers = harnessLibSrc.slice(harnessLibSrc.indexOf("hpsql() {"), harnessLibSrc.indexOf("# 3. Cluster jetable CRÉÉ"));
  assert.equal((wrappers.match(/env -i /g) ?? []).length, 3, "hpsql, hpsql_as et h_server_bin partent d'un environnement vide");
  assert.equal((wrappers.match(/"\$H_BIN\/psql" -X -h "\$H_SOCK" -p "\$H_PORT" -U "\$H_USER" -d "\$db" "\$@"/g) ?? []).length, 2);
  assert.equal((wrappers.match(/PGHOST="\$H_SOCK" PGPORT="\$H_PORT" PGUSER="\$H_USER" PGDATABASE="\$db"/g) ?? []).length, 2);
  // Le harnais n'utilise que ces enveloppes pour parler à PostgreSQL.
  assert.ok(shellCode(harnessSrc).filter((line) => /\bhpsql(_as)?\b/.test(line)).length >= 30);
});

test("[K] harnais : le verrou d'entrée précède TOUT -- consentement explicite exact, puis seulement création du cluster ; le nettoyage est armé avant la création", () => {
  const code = shellCode(harnessSrc);
  const index = (pattern: RegExp) => code.findIndex((line) => pattern.test(line));
  const source = index(/^\. "\$SCRIPT_DIR\/catalogue-product-reorder-v1-harness-lib\.sh"$/);
  const gate = index(/^harness_safety_gate$/);
  const trap = index(/^trap harness_cleanup EXIT$/);
  const start = index(/^harness_start_cluster \|\| fatal/);
  const prove = index(/^harness_prove_identity \|\| fatal/);
  const firstSql = index(/\bhpsql(_as)?\s+"/);
  const firstCreate = index(/^harness_create_db /);
  assert.ok(source >= 0 && source < gate && gate < trap && trap < start && start < prove, "source < verrou < trap < cluster < preuve");
  assert.ok(prove < firstCreate, "aucune base créée avant la preuve d'identité");
  // Les seules lignes exécutables avant le verrou : options du shell,
  // chemins du dépôt, compteurs et fonctions de journalisation.
  for (const line of code.slice(0, gate)) {
    assert.ok(/^(set -uo pipefail|SCRIPT_DIR=|SUPABASE_DIR=|LOT_SQL=|ROLLBACK_SQL=|PASS=0|FAIL=0|log\(\)|pass\(\)|fail\(\)|fatal\(\)|\. ")/.test(line), line);
  }
  assert.ok(firstSql > prove || firstSql === -1 || code.slice(0, prove).every((line) => !/^\s*hpsql/.test(line)));
  // Consentement : la valeur exacte « 1 », rien d'autre.
  assert.ok(harnessLibSrc.includes('if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then'));
  const gateBody = harnessLibSrc.slice(harnessLibSrc.indexOf("harness_safety_gate() {"), harnessLibSrc.indexOf("\n}\n", harnessLibSrc.indexOf("harness_safety_gate() {")));
  assert.ok(gateBody.indexOf("SCANYM_DISPOSABLE_CLUSTER") < gateBody.indexOf("H_REDIRECTING_VARS"), "consentement d'abord");
  const gateCode = shellCode(gateBody);
  assert.deepEqual(gateCode.filter((line) => POSTGRES_COMMANDS.test(line) || /\b(hpsql|hpsql_as|h_server_bin|h_guarded_sql)\b/.test(line) || /"\$H_BIN\//.test(line)), [], "le verrou d'entrée n'exécute aucune commande PostgreSQL");
});

test("[K] harnais : toute variable de connexion héritée est un REFUS, signalé par son NOM -- jamais par sa valeur ; les autres PG* sont retirées", () => {
  const list = harnessLibSrc.match(/^H_REDIRECTING_VARS="([^"]+)"$/m)![1].split(" ");
  for (const mandated of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGPASSWORD"]) {
    assert.ok(list.includes(mandated), mandated);
  }
  for (const extra of ["PGSYSCONFDIR", "PGCLUSTER", "DATABASE_URL", "SUPABASE_DB_URL"]) assert.ok(list.includes(extra), extra);
  // La valeur d'une variable héritée n'est lue qu'UNE fois, pour
  // tester sa présence ; elle n'entre dans aucun message.
  for (const src of [harnessLibSrc, harnessSrc]) {
    const reads = shellCode(src).filter((line) => line.includes("${!"));
    assert.deepEqual(reads, src === harnessLibSrc ? ['if [ -n "${!v:-}" ]; then'] : []);
  }
  assert.ok(harnessLibSrc.includes("for name in $(compgen -e); do"));
  assert.ok(/PG\*\)\s+unset "\$name"/.test(harnessLibSrc));
  // Aucune trace d'exécution, aucun vidage d'environnement.
  for (const src of [harnessLibSrc, harnessSrc]) {
    const code = shellCode(src).join("\n");
    assert.ok(!/\bset -[a-z]*x\b|\bprintenv\b|\bdeclare -p\b|\bexport -p\b|(^|[;&|]\s*)env\s*($|[;&|>])/m.test(code));
  }
});

test("[K] harnais : cluster créé par l'exécution (mktemp, initdb, socket privé, aucune écoute réseau), noms aléatoires, registre des bases", () => {
  assert.ok(harnessLibSrc.includes('H_RUN_DIR="$(mktemp -d "$base/scanym-$H_LOT_TAG.XXXXXXXXXX")"'));
  assert.ok(harnessLibSrc.includes(`H_NONCE="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"`));
  assert.ok(harnessLibSrc.includes("h_server_bin initdb -D \"$H_DATA\" -U \"$H_USER\""));
  for (const setting of ["listen_addresses = ''", "unix_socket_directories = '$H_SOCK'", "unix_socket_permissions = 0700", "scanym.harness_run_nonce = '$H_NONCE'"]) {
    assert.ok(harnessLibSrc.includes(setting), setting);
  }
  assert.ok(!/SCANYM_HARNESS_PG(HOST|PORT)/.test(harnessLibSrc + harnessSrc), "aucun mode « cluster désigné » : le harnais ne parle qu'au cluster qu'il crée");
  // Chaque nom de base porte l'étiquette aléatoire de l'exécution.
  const names = [...harnessSrc.matchAll(/^DB_\w+="(scanym[^"]+)"$/gm)].map((m) => m[1]);
  assert.equal(names.length, 5);
  assert.equal([...harnessSrc.matchAll(/scanym_cpr1_[a-z]+_[^"\s]*/g)].filter((m) => !m[0].endsWith("$H_TAG")).length, 0, "aucun nom de base fixe");
  for (const name of names) assert.ok(/^scanym_cpr1_[a-z]+_\$H_TAG$/.test(name), name);
  assert.ok(!/\$\$/.test(shellCode(harnessSrc).filter((line) => /^DB\w*=/.test(line)).join("\n")), "plus aucun nom dérivé du PID");
});

test("[K] harnais : CREATE / DROP DATABASE n'existent que derrière la preuve d'identité, sur la MÊME connexion ; jamais de « if exists » ; suppression limitée au registre", () => {
  const lib = shellCode(harnessLibSrc);
  const databaseStatements = lib.filter((line) => /\b(create|drop)\s+database\b/i.test(line));
  assert.deepEqual(databaseStatements, [
    'h_guarded_sql "create database \\"$name\\"${tpl:+ template \\"$tpl\\"};" >/dev/null',
    'h_guarded_sql "drop database \\"$name\\";" >/dev/null',
  ]);
  for (const src of [harnessSrc, harnessLibSrc]) {
    assert.ok(!/drop\s+database\s+if\s+exists/i.test(shellCode(src).join("\n")));
  }
  assert.deepEqual(shellCode(harnessSrc).filter((line) => /\b(create|drop)\s+database\b/i.test(line)), [], "le harnais ne crée ni ne supprime de base que par la bibliothèque");
  // La preuve et l'instruction partent dans UNE session psql, arrêtée
  // à la première erreur.
  assert.ok(harnessLibSrc.includes(`out="$( { h_identity_sql; printf '%s\\n' "$1"; } | hpsql postgres -v ON_ERROR_STOP=1 -q -A -t -f - 2>"$H_RUN_DIR/tmp/guard.err" )"`));
  const proof = harnessLibSrc.slice(harnessLibSrc.indexOf("h_identity_sql() {"), harnessLibSrc.indexOf("\n}\n", harnessLibSrc.indexOf("h_identity_sql() {")));
  for (const condition of [
    "current_setting('scanym.harness_run_nonce', true) is distinct from '$H_NONCE'",
    "f.sourcefile = '$H_DATA/postgresql.conf'",
    "current_setting('data_directory') is distinct from '$H_DATA'",
    "inet_server_addr() is not null",
    "current_setting('listen_addresses') is distinct from ''",
    "raise exception 'SCANYM_HARNESS_IDENTITY_MISMATCH'",
  ]) assert.ok(proof.includes(condition), condition);
  // Suppression : le registre d'abord, la preuve ensuite.
  const drop = harnessLibSrc.slice(harnessLibSrc.indexOf("harness_drop_db() {"), harnessLibSrc.indexOf("\n}\n", harnessLibSrc.indexOf("harness_drop_db() {")));
  assert.ok(drop.indexOf('if ! h_is_tracked "$name"; then') > 0);
  assert.ok(drop.indexOf('if ! h_is_tracked "$name"; then') < drop.indexOf("h_guarded_sql"));
  const create = harnessLibSrc.slice(harnessLibSrc.indexOf("harness_create_db() {"), harnessLibSrc.indexOf("\n}\n", harnessLibSrc.indexOf("harness_create_db() {")));
  assert.ok(create.indexOf("select count(*) from pg_catalog.pg_database where datname = '$name';") < create.indexOf("create database"));
  assert.ok(create.indexOf('H_CREATED_DBS+=("$name")') > create.indexOf("create database"), "une base n'entre au registre qu'après sa création réussie");
});

test("[K] harnais : le nettoyage n'ouvre aucune connexion et ne supprime QUE le répertoire qui porte le marqueur de l'exécution", () => {
  const cleanup = harnessLibSrc.slice(harnessLibSrc.indexOf("harness_cleanup() {"), harnessLibSrc.indexOf("\n}\n", harnessLibSrc.indexOf("harness_cleanup() {")));
  const code = shellCode(cleanup).join("\n");
  assert.ok(!/hpsql|h_guarded_sql|drop database/.test(code), "aucune connexion, aucun DROP au nettoyage");
  assert.ok(code.indexOf("if ! h_owns_run_dir; then") >= 0 && code.indexOf("if ! h_owns_run_dir; then") < code.indexOf('rm -rf -- "$H_RUN_DIR"'));
  assert.equal((code.match(/rm -rf/g) ?? []).length, 1);
  assert.ok(code.includes('*"$H_DATA"*)'), "le postmaster n'est arrêté que si sa ligne de commande désigne le répertoire de l'exécution");
  const owns = harnessLibSrc.slice(harnessLibSrc.indexOf("h_owns_run_dir() {"), harnessLibSrc.indexOf("\n}\n", harnessLibSrc.indexOf("h_owns_run_dir() {")));
  assert.ok(owns.includes('[ "$(cat "$H_RUN_DIR/.scanym-harness-owner" 2>/dev/null)" = "$H_NONCE" ] || return 1'));
  assert.ok(owns.includes('[ -d "$H_RUN_DIR" ] && [ ! -L "$H_RUN_DIR" ] || return 1'));
  // Le harnais n'a AUCUN autre nettoyage que celui de la bibliothèque.
  assert.ok(!/\brm\s+-/.test(shellCode(harnessSrc).join("\n")));
  for (const signal of ["EXIT", "HUP", "INT", "TERM"]) assert.ok(new RegExp(`^trap .* ${signal}$`, "m").test(harnessSrc), signal);
});

test("[K] sondes : HARNESS-01 à HARNESS-08 sont toutes présentes, avec témoin, fil-piège et contrôles positifs", () => {
  for (let n = 1; n <= 8; n++) {
    const id = `HARNESS-0${n}`;
    const proofs = harnessProbeSrc.split("\n").filter((line) => new RegExp(`^\\s*(pass|fail|check|expect_refusal|skip) "${id}`).test(line));
    assert.ok(proofs.length >= 2, `${id} : ${proofs.length} preuve(s)`);
  }
  for (const instrument of ["witness_state()", "witness_connections()", "witness_statements()", 'TRIPWIRE="$P_DIR/tripwire.log"', "contrôle positif"]) {
    assert.ok(harnessProbeSrc.includes(instrument), instrument);
  }
  // Les sondes s'appliquent à elles-mêmes le verrou d'entrée.
  const code = shellCode(harnessProbeSrc);
  assert.ok(code.indexOf("harness_safety_gate") >= 0 && code.indexOf("harness_safety_gate") < code.findIndex((line) => /initdb/.test(line)));
});

// ==================================================================
// H. Import / export : contrat inchangé, ordre jamais perdu
// ==================================================================

test("[H] CONTRAT XLSX INCHANGÉ : les colonnes d'import et d'export sont exactement celles d'avant ce lot -- aucune colonne d'ordre n'est ajoutée", () => {
  assert.deepEqual([...IMPORT_COLUMNS], [
    "Type", "Nom", "Catégorie parent", "Sous-catégorie parent", "Tags / Collections",
    "Description courte", "Description longue", "Prix TTC (€)", "TVA (%)", "Poids (g)",
    "Photo fichier", "Rétractable", "Modes de vente", "Disponible",
  ]);
  assert.deepEqual([...EXPORT_COLUMNS], [...IMPORT_COLUMNS, "Prix de référence (€/kg)"]);
  for (const column of EXPORT_COLUMNS) {
    assert.ok(!/ordre|order|position|rang/i.test(column), `colonne d'ordre inattendue : ${column}`);
  }
});

test("[H] le pipeline d'import ne lit ni n'écrit l'ordre : aucune référence à display_order, set_product_order ou move_product_order", () => {
  const files = [
    ...readdirSync("lib/catalogue-import").map((f) => `lib/catalogue-import/${f}`),
    "lib/services/catalogue-import-commit.ts",
    "lib/catalogue-management/export.ts",
  ];
  for (const file of files) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/display_order|displayOrder|set_product_order|setProductOrder|move_product_order|moveProductOrder/.test(code), file);
  }
  // lib/services/catalogue-import.ts ne fait que LIRE (structure déjà
  // prouvée par tests/lot-ob3-catalogue-import-structural.test.ts).
  assert.ok(!readFileSync("lib/services/catalogue-import.ts", "utf8").includes("move_product_order"));
});

test("[H] l'écran exporte le catalogue COMPLET dans l'ordre persisté de la carte ; l'export des résultats reste la liste affichée", () => {
  assert.ok(
    pageSrc.includes('scope === "complet" ? sortProducts(flatProducts, CATALOGUE_ORDER_SORT) : filteredProducts'),
    "export complet = ordre persisté ; export filtré = liste affichée"
  );
});

test("[H] après réordonnancement, les lignes de l'export complet suivent l'ordre persisté, périmètre par périmètre", () => {
  let cats = referenceCatalogue();
  for (const [id, direction] of [["beaufort", "up"], ["zeste", "up"], ["jus", "down"]] as const) {
    cats = applyProductMove(cats as any, id, direction)!.categories as any;
  }
  const rows = buildExportRows(sortProducts(flattenCatalogue(cats as any), CATALOGUE_ORDER_SORT));
  assert.deepEqual(
    rows.map((r) => `${r[2]}/${r[3] || "-"}/${r[1]}`),
    [
      "Fromages/-/Beaufort", "Fromages/-/Comté", "Fromages/-/Abondance",
      "Fromages/Chèvres/Banon", "Fromages/Chèvres/Zeste de chèvre", "Fromages/Chèvres/crottin", "Fromages/Chèvres/éclat cendré",
      "Fromages/Brebis/Ossau", "Fromages/Brebis/Roquefort",
      "Boissons/-/Eau", "Boissons/-/Cidre", "Boissons/-/Jus",
    ]
  );
  assert.equal(rows[0].length, EXPORT_COLUMNS.length);
});

// --- Aller-retour RÉEL : vrais services d'import, RPC simulées en mémoire ---

interface Row { [key: string]: unknown }

/** Modèle en mémoire d'un établissement, exposé à travers
 *  `supabase.rpc` : get_merchant_catalogue (mêmes lignes à plat que la
 *  RPC), create_product (fin de CATÉGORIE : max + 1, comme le SQL),
 *  update_product / set_product_availability (n'écrivent jamais
 *  l'ordre). Toute autre écriture fait échouer le test. */
function catalogueBackend(t: TestContext, cats: ReturnType<typeof category>[]) {
  const state = structuredClone(cats);
  const calls: { name: string; args: Row }[] = [];
  let created = 0;

  const rows = (): Row[] => {
    const out: Row[] = [];
    for (const c of state) {
      const groups: { sub: ReturnType<typeof subcategory> | null; products: AnyProduct[] }[] = [
        { sub: null, products: c.products },
        ...c.subcategories.map((s) => ({ sub: s, products: s.products })),
      ];
      for (const g of groups) {
        const base = {
          category_id: c.category_id,
          category_name: c.category_name,
          category_name_hash: "h",
          category_translations: null,
          category_display_order: c.category_display_order,
          category_is_option_source: false,
          category_description: null,
          category_description_hash: null,
          category_is_active: true,
          subcategory_id: g.sub?.subcategory_id ?? null,
          subcategory_name: g.sub?.subcategory_name ?? null,
          subcategory_display_order: g.sub?.subcategory_display_order ?? null,
          subcategory_is_active: g.sub ? true : null,
        };
        if (g.products.length === 0) {
          out.push({ ...base, product_id: null, name: null });
          continue;
        }
        // Même tri que get_merchant_catalogue à l'intérieur d'un groupe.
        for (const p of [...g.products].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))) {
          out.push({ ...p, ...base });
        }
      }
    }
    return out;
  };

  const find = (id: unknown) => allProducts(state).find((p) => p.product_id === id);

  t.mock.method(supabase, "rpc", async (name: string, args: Row) => {
    calls.push({ name, args });
    if (name === "get_merchant_catalogue") return { data: rows(), error: null };
    if (name === "get_restaurant_tags") return { data: [], error: null };
    if (name === "create_product") {
      const c = state.find((x) => x.category_id === args.p_category_id);
      assert.ok(c, "catégorie inconnue");
      const max = Math.max(0, ...c!.products.map((p) => p.display_order), ...c!.subcategories.flatMap((s) => s.products.map((p) => p.display_order)));
      const sub = c!.subcategories.find((s) => s.subcategory_id === args.p_subcategory_id) ?? null;
      const p = product({
        product_id: `new-${++created}`,
        name: args.p_name,
        category_id: c!.category_id,
        category_name: c!.category_name,
        subcategory_id: sub?.subcategory_id ?? null,
        subcategory_name: sub?.subcategory_name ?? null,
        price: args.p_price,
        tax_rate: args.p_tax_rate,
        is_available: args.p_tax_rate !== null,
        allowed_sale_modes: args.p_allowed_sale_modes ?? null,
        display_order: max + 1,
      });
      (sub ? sub.products : c!.products).push(p);
      return { data: p.product_id, error: null };
    }
    const p = find(args.p_product_id);
    assert.ok(p, `RPC produit inattendue : ${name}`);
    if (name === "set_product_availability") {
      p!.is_available = args.p_is_available as boolean;
    } else if (name === "update_product") {
      p!.price = args.p_price as number;
      p!.tax_rate = args.p_tax_rate as number | null;
    } else {
      assert.fail(`écriture inattendue pendant un import : ${name}`);
    }
    return { data: null, error: null };
  });
  t.mock.method(supabase, "from", () => {
    throw new Error("écriture directe interdite");
  });
  return { state, calls, writes: () => calls.filter((c) => !c.name.startsWith("get_")) };
}

async function exportFullCatalogue(): Promise<File> {
  const flat = flattenCatalogue(await getMerchantCatalogue("tenant-test"), new Map());
  const bytes = buildCatalogueExport(sortProducts(flat, CATALOGUE_ORDER_SORT));
  return new File([new Uint8Array(bytes)], "catalogue-complet.xlsx");
}

/** Catalogue réordonné par le marchand, tous produits disponibles et
 *  taxés (un produit indisponible ajouterait une écriture de
 *  disponibilité sans rapport avec l'ordre). */
function reorderedCatalogue() {
  let cats = referenceCatalogue();
  cats[0].products[2].is_available = true;
  cats[0].products[2].tax_rate = 5.5;
  for (const [id, direction] of [["beaufort", "up"], ["abondance", "up"], ["zeste", "up"], ["eclat", "up"], ["roquefort", "up"], ["jus", "down"]] as const) {
    cats = applyProductMove(cats as any, id, direction)!.categories as any;
  }
  return cats;
}

test("[H] ALLER-RETOUR sur le MÊME catalogue : exporter puis réimporter un catalogue réordonné ne produit AUCUNE écriture -- l'import ne peut ni perdre ni modifier l'ordre", async (t) => {
  const backend = catalogueBackend(t, reorderedCatalogue());
  const orderBefore = allProducts(backend.state).map((p) => [p.product_id, p.display_order]);

  const result = await commitCatalogueImport(await exportFullCatalogue(), "tenant-test");
  assert.equal(result.kind, "COMMITTED");
  assert.ok("rows" in result);
  assert.ok(result.rows.every((r) => r.outcome === "SKIPPED"), JSON.stringify(result.rows));
  assert.deepEqual(backend.writes(), [], "aucune RPC d'écriture");
  assert.deepEqual(allProducts(backend.state).map((p) => [p.product_id, p.display_order]), orderBefore);
});

test("[H] réimporter un export dont le marchand a MÉLANGÉ les lignes et modifié un prix : le prix est mis à jour, l'ordre persisté ne bouge pas", async (t) => {
  const backend = catalogueBackend(t, reorderedCatalogue());
  const orderBefore = allProducts(backend.state).map((p) => [p.product_id, p.display_order]);

  const flat = sortProducts(flattenCatalogue(await getMerchantCatalogue("tenant-test"), new Map()), CATALOGUE_ORDER_SORT);
  const shuffled = [...flat].reverse().map((fp) =>
    fp.product.product_id === "jus" ? { ...fp, product: { ...fp.product, price: 3.9 } } : fp
  );
  const file = new File([new Uint8Array(buildCatalogueExport(shuffled))], "melange.xlsx");

  const result = await commitCatalogueImport(file, "tenant-test");
  assert.equal(result.kind, "COMMITTED");
  assert.deepEqual(backend.writes().map((c) => c.name), ["update_product"]);
  assert.equal(allProducts(backend.state).find((p) => p.product_id === "jus")!.price, 3.9);
  assert.deepEqual(allProducts(backend.state).map((p) => [p.product_id, p.display_order]), orderBefore, "l'ordre des lignes d'un fichier ne réordonne jamais un produit existant");
});

test("[H] EXPORT -> IMPORT dans un catalogue VIDE (mêmes catégories) : les produits sont recréés dans l'ordre du fichier, donc dans l'ordre persisté -- l'ordre de la carte est reconstitué à l'identique", async (t) => {
  const source = reorderedCatalogue();
  // 1. Export complet du catalogue source.
  const exporting = catalogueBackend(t, source);
  const file = await exportFullCatalogue();
  const expectedByScope = Object.fromEntries(
    source.flatMap((c) => [
      [`${c.category_name}/-`, orderProductsForCatalogue(c.products).map((p) => p.name)],
      ...c.subcategories.map((s) => [`${c.category_name}/${s.subcategory_name}`, orderProductsForCatalogue(s.products).map((p) => p.name)]),
    ])
  );
  assert.deepEqual(exporting.writes(), []);
  t.mock.restoreAll();

  // 2. Import dans un établissement qui a la même structure, sans produit.
  const empty = source.map((c) => ({
    ...c,
    products: [],
    subcategories: c.subcategories.map((s) => ({ ...s, products: [] })),
  }));
  const target = catalogueBackend(t, empty as any);
  const result = await commitCatalogueImport(file, "tenant-test");
  assert.equal(result.kind, "COMMITTED");
  assert.ok("productsCreated" in result);
  assert.equal(result.productsCreated, 12);
  assert.ok(target.writes().every((c) => c.name === "create_product"), "création seule : aucune RPC d'ordre n'est nécessaire");

  // 3. L'ordre de la carte de la cible == celui de la source.
  const actualByScope = Object.fromEntries(
    target.state.flatMap((c) => [
      [`${c.category_name}/-`, orderProductsForCatalogue(c.products).map((p) => p.name)],
      ...c.subcategories.map((s) => [`${c.category_name}/${s.subcategory_name}`, orderProductsForCatalogue(s.products).map((p) => p.name)]),
    ])
  );
  assert.deepEqual(actualByScope, expectedByScope);
  assert.deepEqual(actualByScope["Fromages/Chèvres"], ["Banon", "Zeste de chèvre", "éclat cendré", "crottin"]);
});
