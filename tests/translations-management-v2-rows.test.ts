import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRANSLATIONS MANAGEMENT v2 — COUVERTURE DES LIGNES
//
// A. COUVERTURE PRODUIT (mandat §19.A) : un produit rattaché
//    DIRECTEMENT à sa catégorie ET un produit rattaché à une
//    SOUS-CATÉGORIE apparaissent tous les deux, sans doublon. C'est le
//    défaut PRODUIT confirmé par le mandat §2 : l'écran ne lisait que
//    `cat.products`.
// B. SOUS-CATÉGORIES traduisibles, textes d'établissement, textes
//    client configurables (jamais un libellé d'interface Scanym).
// ====================================================================

const {
  buildTranslationRows,
  entityKey,
  rowStatus,
  rowStoredTranslation,
  isTranslatableField,
  TRANSLATABLE_FIELDS,
} = await import("../lib/translations-management/rows.ts");
const { getTranslationStatus } = await import("../lib/translation-resolver.ts");

const HASH_TOMME = "hash-tomme";
const HASH_CHEVRE = "hash-chevre";

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p-direct",
    category_id: "c-fromages",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Tomme de brebis",
    name_hash: HASH_TOMME,
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

function catalogue() {
  return [
    {
      category_id: "c-fromages",
      category_name: "Fromages",
      category_name_hash: "hash-cat-fromages",
      category_translations: null,
      category_display_order: 1,
      category_is_option_source: false,
      category_description: "Sélection fermière",
      category_description_hash: "hash-cat-desc",
      category_is_active: true,
      products: [product()],
      subcategories: [
        {
          subcategory_id: "s-chevres",
          subcategory_name: "Chèvres",
          subcategory_display_order: 1,
          subcategory_is_active: true,
          subcategory_name_hash: HASH_CHEVRE,
          subcategory_translations: null,
          products: [
            product({
              product_id: "p-sous-categorie",
              subcategory_id: "s-chevres",
              subcategory_name: "Chèvres",
              name: "Crottin de Chavignol",
              name_hash: "hash-crottin",
              short_description: "Affiné 3 semaines",
              short_description_hash: "hash-crottin-court",
              price: 6,
            }),
          ],
        },
      ],
    },
  ] as never;
}

const RESTAURANT = {
  restaurantId: "r-1",
  restaurantName: "Au lait cru",
  introText: "Fromagerie artisanale",
  introTextHash: "hash-intro",
  announcementText: null,
  announcementTextHash: null,
  translations: null,
};

test("A — le produit rattaché à une SOUS-CATÉGORIE apparaît (défaut corrigé) ET le produit direct aussi", () => {
  const rows = buildTranslationRows({ restaurant: RESTAURANT, categories: catalogue() });
  const productIds = rows.filter((r) => r.entityType === "item").map((r) => r.entityId);
  assert.equal(productIds.includes("p-direct"), true, "produit direct attendu");
  assert.equal(
    productIds.includes("p-sous-categorie"),
    true,
    "produit de sous-catégorie attendu -- c'est exactement le défaut du mandat §2"
  );
});

test("A — aucun produit n'est DUPLIQUÉ (un seul aplatissement, partagé avec l'écran Catalogue)", () => {
  const rows = buildTranslationRows({ restaurant: RESTAURANT, categories: catalogue() });
  const nameRows = rows.filter((r) => r.entityType === "item" && r.field === "name");
  assert.deepEqual(
    nameRows.map((r) => r.entityId).sort(),
    ["p-direct", "p-sous-categorie"],
    "un et un seul champ `name` par produit"
  );
  assert.equal(new Set(rows.map((r) => `${entityKey(r)}\u0000${r.field}`)).size, rows.length);
});

test("A — chaque produit conserve son contexte Catégorie > Sous-catégorie > Produit", () => {
  const rows = buildTranslationRows({ restaurant: RESTAURANT, categories: catalogue() });
  const direct = rows.find((r) => r.entityId === "p-direct" && r.field === "name")!;
  const nested = rows.find((r) => r.entityId === "p-sous-categorie" && r.field === "name")!;
  assert.deepEqual(
    [direct.categoryName, direct.subcategoryName],
    ["Fromages", null],
    "produit direct : Catégorie > Produit"
  );
  assert.deepEqual([nested.categoryName, nested.subcategoryName], ["Fromages", "Chèvres"]);
});

test("B — la SOUS-CATÉGORIE est elle-même une ligne traduisible (champ `name` uniquement)", () => {
  const rows = buildTranslationRows({ restaurant: RESTAURANT, categories: catalogue() });
  const subRows = rows.filter((r) => r.entityType === "subcategory");
  assert.equal(subRows.length, 1);
  assert.deepEqual(
    [subRows[0].entityId, subRows[0].field, subRows[0].sourceText, subRows[0].sourceHash],
    ["s-chevres", "name", "Chèvres", HASH_CHEVRE]
  );
  assert.deepEqual([...TRANSLATABLE_FIELDS.subcategory], ["name"]);
  assert.equal(isTranslatableField("subcategory", "description"), false);
  assert.equal(isTranslatableField("subcategory", "name"), true);
});

test("B — textes d'établissement conservés (intro/annonce), sans régression de hash/statut", () => {
  const rows = buildTranslationRows({ restaurant: RESTAURANT, categories: [] });
  assert.deepEqual(
    rows.map((r) => [r.entityType, r.field, r.sourceHash]),
    [["restaurant", "intro_text", "hash-intro"]],
    "un champ vide ne produit aucune ligne (jamais une invitation à traduire le vide)"
  );
  assert.equal(rows[0].entityId, "r-1");
});

test("B — les textes client CONFIGURABLES sont inclus ; un mode sans texte n'en produit aucun", () => {
  const rows = buildTranslationRows({
    restaurant: null,
    categories: [],
    methodNotices: [
      {
        modeCode: "pickup",
        modeLabel: "À emporter",
        customerText: "Retrait sous 2 h.",
        saleModeId: "sm-pickup",
        customerTextHash: "hash-pickup",
        translations: null,
      },
      {
        modeCode: "delivery",
        modeLabel: "Livraison",
        customerText: null,
        saleModeId: "sm-delivery",
        customerTextHash: null,
        translations: null,
      },
    ],
    fulfillmentNotices: [
      {
        ruleId: "rule-1",
        fulfillmentLabel: "Livraison — zones 75",
        pricingMode: "fixed",
        fixedFee: 5,
        freeThreshold: null,
        customerText: "Coursier sous 2 h.",
        customerTextHash: "hash-rule",
        translations: null,
      },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.entityType, r.entityId, r.field]),
    [
      ["customer_notice", "sm-pickup", "customer_text"],
      ["customer_notice", "rule-1", "customer_text"],
    ]
  );
});

test("B — un texte client sans identifiant stable n'est JAMAIS proposé à la traduction", () => {
  // Base non encore migrée : `saleModeId` absent. Proposer la ligne
  // produirait un import impossible à réappliquer (entity_id vide).
  const rows = buildTranslationRows({
    restaurant: null,
    categories: [],
    methodNotices: [
      {
        modeCode: "pickup",
        modeLabel: "À emporter",
        customerText: "Retrait sous 2 h.",
        saleModeId: null,
        customerTextHash: null,
        translations: null,
      },
    ],
  });
  assert.equal(rows.length, 0);
});

test("le STATUT n'est jamais recalculé : rowStatus délègue à getTranslationStatus", () => {
  const translations = {
    en: { name: "Sheep tomme", name_status: "validated", name_source_hash: HASH_TOMME },
  };
  const rows = buildTranslationRows({
    restaurant: null,
    categories: [
      {
        ...(catalogue() as never as Array<Record<string, unknown>>)[0],
        products: [product({ translations })],
        subcategories: [],
      },
    ] as never,
  });
  const row = rows.find((r) => r.entityType === "item" && r.field === "name")!;
  assert.equal(rowStatus(row, "en"), getTranslationStatus(HASH_TOMME, translations, "en", "name"));
  assert.equal(rowStatus(row, "en"), "validated");
  assert.equal(rowStoredTranslation(row, "en"), "Sheep tomme");
  assert.equal(rowStatus(row, "ar"), "missing");
});

test("STALE : le nom source renommé rend la traduction validée PÉRIMÉE (jamais stockée, dérivée)", () => {
  const translations = {
    en: { name: "Goat cheeses", name_status: "validated", name_source_hash: "ancien-hash" },
  };
  const cats = catalogue() as never as Array<Record<string, unknown>>;
  (cats[0].subcategories as Array<Record<string, unknown>>)[0].subcategory_translations = translations;
  const rows = buildTranslationRows({ restaurant: null, categories: cats as never });
  const sub = rows.find((r) => r.entityType === "subcategory")!;
  assert.equal(rowStatus(sub, "en"), "stale");
});

test("les champs traduisibles reflètent EXACTEMENT les 5 types acceptés par write_translation", () => {
  assert.deepEqual(Object.keys(TRANSLATABLE_FIELDS).sort(), [
    "category",
    "customer_notice",
    "item",
    "restaurant",
    "subcategory",
  ]);
  assert.deepEqual([...TRANSLATABLE_FIELDS.customer_notice], ["customer_text"]);
  assert.deepEqual([...TRANSLATABLE_FIELDS.item], ["name", "short_description", "description"]);
  assert.equal(isTranslatableField("item", "price"), false);
  assert.equal(isTranslatableField("inventé", "name"), false);
});
