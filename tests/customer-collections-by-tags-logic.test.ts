import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — P1 CUSTOMER COLLECTIONS BY TAGS — logique PURE
// (lib/customer-collections.ts). Aucune dépendance réseau/React.
//
// Couvre : ordre du contrat serveur (§5), sélection multi-catégories /
// sous-catégories (§4), identifiants inconnus / inter-tenant ignorés
// (§8), collection vide supprimée côté client aussi (défense en
// profondeur de §3), entrée vide/échec -> aucune collection (§14).
// ====================================================================

const { buildCustomerCollections, selectCollectionItems } = await import(
  "../lib/customer-collections.ts"
);

function item(id: string, category_id: string, subcategory_id: string | null = null) {
  return { id, category_id, subcategory_id, name: id };
}

/** Modèle public : 2 catégories, dont une avec 2 sous-catégories. */
const CATEGORIES = [
  {
    id: "c-fromages",
    menu_items: [
      item("p-direct", "c-fromages"),
      item("p-raclette", "c-fromages", "s-raclette"),
      item("p-chevre", "c-fromages", "s-chevre"),
    ],
  },
  {
    id: "c-vins",
    menu_items: [item("p-rouge", "c-vins"), item("p-blanc", "c-vins", "s-blancs")],
  },
];
const ALLOWED = new Set(CATEGORIES.flatMap((c) => c.menu_items.map((i) => i.id)));

test("[ORDER] display_order du contrat serveur respecté ; à égalité l'ordre reçu (déjà trié par libellé côté serveur) est conservé", () => {
  const out = buildCustomerCollections(
    [
      { id: "t-z", label: "Zeste", displayOrder: 2, menuItemIds: ["p-rouge"] },
      { id: "t-a", label: "Apéro", displayOrder: 1, menuItemIds: ["p-blanc"] },
      { id: "t-b", label: "Bio", displayOrder: 1, menuItemIds: ["p-direct"] },
    ],
    ALLOWED
  );
  assert.deepEqual(out.map((c) => c.id), ["t-a", "t-b", "t-z"]);
});

test("[MULTI-CATEGORY] une collection sélectionne ses produits dans PLUSIEURS catégories et sous-catégories, dans l'ordre public", () => {
  const [collection] = buildCustomerCollections(
    [{ id: "t", label: "Sélection", displayOrder: 1, menuItemIds: ["p-blanc", "p-chevre", "p-raclette", "p-direct"] }],
    ALLOWED
  );
  const items = selectCollectionItems(CATEGORIES, collection);
  assert.deepEqual(items.map((i) => i.id), ["p-direct", "p-raclette", "p-chevre", "p-blanc"]);
  assert.deepEqual(new Set(items.map((i) => i.category_id)), new Set(["c-fromages", "c-vins"]));
  assert.deepEqual(
    new Set(items.map((i) => i.subcategory_id)),
    new Set([null, "s-raclette", "s-chevre", "s-blancs"])
  );
  // Mêmes objets que la navigation normale (panier/options/badges inchangés).
  assert.equal(items[0], CATEGORIES[0].menu_items[0]);
  // Uniquement les produits de la collection.
  assert.equal(items.some((i) => i.id === "p-rouge"), false);
});

test("[FAIL-CLOSED] identifiants inconnus / d'un autre tenant ignorés ; une collection qui ne garde AUCUN produit public est supprimée", () => {
  const out = buildCustomerCollections(
    [
      { id: "t-mix", label: "Mix", displayOrder: 1, menuItemIds: ["p-rouge", "foreign-tenant-b", "p-rouge"] },
      { id: "t-foreign", label: "Étrangère", displayOrder: 2, menuItemIds: ["foreign-tenant-b", "hidden-reservoir"] },
      { id: "t-empty", label: "Vide", displayOrder: 3, menuItemIds: [] },
    ],
    ALLOWED
  );
  assert.deepEqual(out, [{ id: "t-mix", label: "Mix", displayOrder: 1, menuItemIds: ["p-rouge"] }]);
  assert.equal(JSON.stringify(out).includes("foreign-tenant-b"), false);
  assert.equal(JSON.stringify(out).includes("Étrangère"), false);

  // Même une collection forgée côté client (ids hors modèle public) ne
  // peut rien exposer : la sélection ne lit QUE le modèle public.
  const forged = selectCollectionItems(CATEGORIES, { menuItemIds: ["foreign-tenant-b", "p-blanc"] });
  assert.deepEqual(forged.map((i) => i.id), ["p-blanc"]);
});

test("[FAIL-CLOSED] collection absente/inconnue -> aucun produit ; libellé vide et doublon d'id ignorés", () => {
  assert.deepEqual(selectCollectionItems(CATEGORIES, null), []);
  assert.deepEqual(selectCollectionItems(CATEGORIES, undefined), []);
  const out = buildCustomerCollections(
    [
      { id: "t-blank", label: "   ", displayOrder: 1, menuItemIds: ["p-rouge"] },
      { id: "t-1", label: " Bio ", displayOrder: 1, menuItemIds: ["p-rouge"] },
      { id: "t-1", label: "Bio bis", displayOrder: 1, menuItemIds: ["p-blanc"] },
    ],
    ALLOWED
  );
  assert.deepEqual(out, [{ id: "t-1", label: "Bio", displayOrder: 1, menuItemIds: ["p-rouge"] }]);
});

test("[SERVICE FAILURE] aucune source (RPC en échec -> []) : aucune collection", () => {
  assert.deepEqual(buildCustomerCollections([], ALLOWED), []);
});

test("[PURE] l'entrée n'est jamais mutée", () => {
  const sources = [
    { id: "b", label: "B", displayOrder: 2, menuItemIds: ["p-rouge", "x"] },
    { id: "a", label: "A", displayOrder: 1, menuItemIds: ["p-blanc"] },
  ];
  const snapshot = JSON.stringify(sources);
  buildCustomerCollections(sources, ALLOWED);
  assert.equal(JSON.stringify(sources), snapshot);
});
