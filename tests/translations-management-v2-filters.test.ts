import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRANSLATIONS MANAGEMENT v2 — FILTRES (mandat §7, §8, §19.C)
//
// Les filtres catalogue ne sont pas réimplémentés : ce test vérifie
// aussi qu'ils RESTENT ceux du catalogue (mêmes clés, même
// EMPTY_FILTERS) -- jamais un système concurrent.
// ====================================================================

const {
  applyTranslationFilters,
  availableTranslationFilterOptions,
  coherentSubcategoryOptions,
  countEntities,
  isDefaultTranslationFilters,
  statusCounts,
  EMPTY_TRANSLATION_FILTERS,
} = await import("../lib/translations-management/filtering.ts");
const { buildTranslationRows } = await import("../lib/translations-management/rows.ts");
const { EMPTY_FILTERS } = await import("../lib/catalogue-management/filtering.ts");

const HASH = {
  tomme: "h-tomme",
  crottin: "h-crottin",
  cola: "h-cola",
  sub: "h-sub",
};

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p",
    category_id: "c-fromages",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Tomme de brebis",
    name_hash: HASH.tomme,
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 12,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
    ...over,
  };
}

const CATALOGUE = [
  {
    category_id: "c-fromages",
    category_name: "Fromages",
    category_name_hash: "h-cat1",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [product({ product_id: "p-tomme" })],
    subcategories: [
      {
        subcategory_id: "s-chevres",
        subcategory_name: "Chèvres",
        subcategory_display_order: 1,
        subcategory_is_active: true,
        subcategory_name_hash: HASH.sub,
        subcategory_translations: null,
        products: [
          product({
            product_id: "p-crottin",
            subcategory_id: "s-chevres",
            subcategory_name: "Chèvres",
            name: "Crottin de Chavignol",
            name_hash: HASH.crottin,
            price: 6,
            is_available: false,
          }),
        ],
      },
    ],
  },
  {
    category_id: "c-boissons",
    category_name: "Boissons",
    category_name_hash: "h-cat2",
    category_translations: null,
    category_display_order: 2,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [
      product({
        product_id: "p-cola",
        category_id: "c-boissons",
        category_name: "Boissons",
        name: "Cola artisanal",
        name_hash: HASH.cola,
        price: 3,
      }),
    ],
    subcategories: [],
  },
] as never;

const TAGS = new Map([["p-tomme", { tagIds: ["t-bio"], tagNames: ["Bio"] }]]);

const NOTICES = [
  {
    modeCode: "pickup" as const,
    modeLabel: "À emporter",
    customerText: "Retrait sous 2 h.",
    saleModeId: "sm-pickup",
    customerTextHash: "h-pickup",
    translations: null,
  },
];

function rows() {
  return buildTranslationRows({
    restaurant: {
      restaurantId: "r-1",
      restaurantName: "Au lait cru",
      introText: "Fromagerie artisanale",
      introTextHash: "h-intro",
      announcementText: null,
      announcementTextHash: null,
      translations: null,
    },
    categories: CATALOGUE,
    tagsByProductId: TAGS,
    methodNotices: NOTICES,
  });
}

const f = (over: Record<string, unknown> = {}) => ({ ...EMPTY_TRANSLATION_FILTERS, ...over }) as never;

test("les filtres catalogue sont RÉUTILISÉS, pas réimplémentés (mêmes clés que EMPTY_FILTERS)", () => {
  for (const key of Object.keys(EMPTY_FILTERS)) {
    assert.equal(
      key in EMPTY_TRANSLATION_FILTERS,
      true,
      `clé de filtre catalogue absente du filtre traduction : ${key}`
    );
  }
  assert.equal(EMPTY_TRANSLATION_FILTERS.status, "all");
  assert.equal(isDefaultTranslationFilters(EMPTY_TRANSLATION_FILTERS), true);
  assert.equal(isDefaultTranslationFilters(f({ status: "missing" })), false);
});

test("recherche : porte sur le nom, le contexte ET le texte source", () => {
  const byName = applyTranslationFilters(rows(), f({ search: "crottin" }), "en");
  assert.deepEqual([...new Set(byName.map((r) => r.entityId))], ["p-crottin"]);

  const byContext = applyTranslationFilters(rows(), f({ search: "chèvres" }), "en");
  assert.equal(
    byContext.some((r) => r.entityId === "p-crottin"),
    true,
    "un produit doit être trouvable par sa sous-catégorie"
  );

  const bySource = applyTranslationFilters(rows(), f({ search: "fromagerie artisanale" }), "en");
  assert.deepEqual(
    bySource.map((r) => r.field),
    ["intro_text"],
    "le texte source est cherchable (c'est ce que le commerçant traduit)"
  );
});

test("catégorie : la catégorie, ses sous-catégories et ses produits ; jamais une autre catégorie", () => {
  const kept = applyTranslationFilters(rows(), f({ categoryId: "c-fromages" }), "en");
  const ids = new Set(kept.map((r) => r.entityId));
  assert.equal(ids.has("c-fromages"), true);
  assert.equal(ids.has("s-chevres"), true);
  assert.equal(ids.has("p-tomme"), true);
  assert.equal(ids.has("p-crottin"), true);
  assert.equal(ids.has("p-cola"), false);
  assert.equal(ids.has("r-1"), false, "les textes d'établissement n'ont pas de catégorie");
  assert.equal(ids.has("sm-pickup"), false, "les messages client n'ont pas de catégorie");
});

test("sous-catégorie : la sous-catégorie et ses produits uniquement", () => {
  const kept = applyTranslationFilters(rows(), f({ subcategoryId: "s-chevres" }), "en");
  assert.deepEqual([...new Set(kept.map((r) => r.entityId))].sort(), ["p-crottin", "s-chevres"]);
});

test("tag et disponibilité : critères de PRODUIT -- seuls des produits sont retenus", () => {
  const byTag = applyTranslationFilters(rows(), f({ tagId: "t-bio" }), "en");
  assert.deepEqual([...new Set(byTag.map((r) => r.entityId))], ["p-tomme"]);
  assert.equal(byTag.every((r) => r.entityType === "item"), true);

  const unavailable = applyTranslationFilters(rows(), f({ available: false }), "en");
  assert.deepEqual([...new Set(unavailable.map((r) => r.entityId))], ["p-crottin"]);

  const available = applyTranslationFilters(rows(), f({ available: true }), "en");
  assert.deepEqual([...new Set(available.map((r) => r.entityId))].sort(), ["p-cola", "p-tomme"]);
});

test("statut : filtre par ENTITÉ (règle documentée) -- tous les champs de l'entité restent visibles", () => {
  const withTranslation = buildTranslationRows({
    restaurant: null,
    categories: [
      {
        ...(CATALOGUE as never as Array<Record<string, unknown>>)[0],
        subcategories: [],
        products: [
          product({
            product_id: "p-tomme",
            short_description: "Brebis des Pyrénées",
            short_description_hash: "h-court",
            translations: {
              en: { name: "Sheep tomme", name_status: "validated", name_source_hash: HASH.tomme },
            },
          }),
        ],
      },
    ] as never,
  });

  const validated = applyTranslationFilters(withTranslation, f({ status: "validated" }), "en");
  assert.equal(
    validated.length,
    2,
    "l'entité est retenue par son champ validé, et ses 2 champs restent affichés"
  );
  assert.deepEqual(validated.map((r) => r.field).sort(), ["name", "short_description"]);

  const missing = applyTranslationFilters(withTranslation, f({ status: "missing" }), "en");
  // Le produit a un champ manquant (short_description) : l'entité est
  // retenue avec SES DEUX champs. La catégorie, elle aussi entièrement
  // manquante, est retenue de son côté -- chaque entité est jugée
  // indépendamment, jamais globalement.
  assert.deepEqual(
    missing.map((r) => `${r.entityType}:${r.field}`).sort(),
    ["category:name", "item:name", "item:short_description"]
  );

  const stale = applyTranslationFilters(withTranslation, f({ status: "stale" }), "en");
  assert.equal(stale.length, 0);
});

test("tri : hiérarchie conservée, tri appliqué DANS les groupes de produits", () => {
  const asc = applyTranslationFilters(rows(), f({ sort: "price-asc", categoryId: "c-fromages" }), "en");
  const products = asc.filter((r) => r.entityType === "item" && r.subcategoryId === null);
  assert.deepEqual(products.map((r) => r.entityId), ["p-tomme"]);

  // Les catégories ne sont jamais réordonnées par le tri produit.
  const all = applyTranslationFilters(rows(), f({ sort: "price-desc" }), "en");
  const categoryOrder = all.filter((r) => r.entityType === "category").map((r) => r.entityId);
  assert.deepEqual(categoryOrder, ["c-fromages", "c-boissons"]);
});

test("tri par prix entre produits d'un même groupe : ordre déterministe", () => {
  const twoProducts = buildTranslationRows({
    restaurant: null,
    categories: [
      {
        ...(CATALOGUE as never as Array<Record<string, unknown>>)[0],
        subcategories: [],
        products: [
          product({ product_id: "p-cher", name: "Comté 36 mois", name_hash: "h1", price: 30 }),
          product({ product_id: "p-pas-cher", name: "Bleu", name_hash: "h2", price: 4 }),
        ],
      },
    ] as never,
  });
  assert.deepEqual(
    applyTranslationFilters(twoProducts, f({ sort: "price-asc" }), "en")
      .filter((r) => r.entityType === "item")
      .map((r) => r.entityId),
    ["p-pas-cher", "p-cher"]
  );
  assert.deepEqual(
    applyTranslationFilters(twoProducts, f({ sort: "price-desc" }), "en")
      .filter((r) => r.entityType === "item")
      .map((r) => r.entityId),
    ["p-cher", "p-pas-cher"]
  );
  assert.deepEqual(
    applyTranslationFilters(twoProducts, f({ sort: "name-asc" }), "en")
      .filter((r) => r.entityType === "item")
      .map((r) => r.entityId),
    ["p-pas-cher", "p-cher"]
  );
});

test("combinaisons : les groupes de filtres se combinent en ET", () => {
  const combined = applyTranslationFilters(
    rows(),
    f({ categoryId: "c-fromages", available: true, search: "tomme" }),
    "en"
  );
  assert.deepEqual([...new Set(combined.map((r) => r.entityId))], ["p-tomme"]);

  const impossible = applyTranslationFilters(
    rows(),
    f({ categoryId: "c-boissons", subcategoryId: "s-chevres" }),
    "en"
  );
  assert.equal(impossible.length, 0);
});

test("options de filtre dérivées des données, et sous-catégories COHÉRENTES avec la catégorie", () => {
  const options = availableTranslationFilterOptions(rows());
  assert.deepEqual(options.categories.map((c) => c.id).sort(), ["c-boissons", "c-fromages"]);
  assert.deepEqual(options.subcategories.map((s) => s.id), ["s-chevres"]);

  assert.deepEqual(coherentSubcategoryOptions(options.subcategories, "c-boissons"), []);
  assert.deepEqual(
    coherentSubcategoryOptions(options.subcategories, "c-fromages").map((s) => s.id),
    ["s-chevres"]
  );
  assert.deepEqual(coherentSubcategoryOptions(options.subcategories, null).map((s) => s.id), [
    "s-chevres",
  ]);
});

test("compteurs : le résultat compte des ENTITÉS, pas des champs", () => {
  const all = rows();
  const distinct = new Set(all.map((r) => `${r.entityType}\u0000${r.entityId}`)).size;
  assert.equal(countEntities(all), distinct);
  // Un produit à 2 champs ne compte QU'UNE fois.
  const twoFields = buildTranslationRows({
    restaurant: null,
    categories: [
      {
        ...(CATALOGUE as never as Array<Record<string, unknown>>)[0],
        subcategories: [],
        products: [
          product({
            product_id: "p-tomme",
            short_description: "Brebis des Pyrénées",
            short_description_hash: "h-court",
          }),
        ],
      },
    ] as never,
  });
  assert.equal(twoFields.filter((r) => r.entityType === "item").length, 2);
  assert.equal(countEntities(twoFields.filter((r) => r.entityType === "item")), 1);
  const counts = statusCounts(all, "en");
  assert.equal(counts.missing, countEntities(all), "tout est manquant tant que rien n'est traduit");
  assert.equal(counts.validated, 0);
  assert.equal(counts.stale, 0);
});
