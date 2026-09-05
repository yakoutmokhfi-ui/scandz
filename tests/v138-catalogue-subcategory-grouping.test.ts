import { test } from "node:test";
import assert from "node:assert/strict";

const { groupMenuItemsBySubcategory } = await import(
  "../lib/catalogue-subcategory-grouping.ts"
);
import type { MenuItem } from "../lib/types.ts";

// ====================================================================
// CATALOGUE / SUBCATEGORIES v1 -- tests unitaires purs pour
// groupMenuItemsBySubcategory (lib/catalogue-subcategory-grouping.ts),
// consommée par components/MenuView.tsx pour insérer un sous-titre
// visuel entre des groupes de produits, SANS jamais modifier le
// tableau plat menu_items lui-même (indexé par item.id pour le
// panier/les options, voir le commentaire du fichier source).
// ====================================================================

function item(overrides: Partial<MenuItem> & { id: string }): MenuItem {
  return {
    category_id: "cat-1",
    subcategory_id: null,
    subcategory_name: null,
    name: `Produit ${overrides.id}`,
    description: null,
    short_description: null,
    price: 5,
    image_url: null,
    display_order: 1,
    is_available: true,
    ...overrides,
  } as MenuItem;
}

test("groupMenuItemsBySubcategory: liste vide -> tableau de groupes vide (jamais une exception)", () => {
  assert.deepEqual(groupMenuItemsBySubcategory([]), []);
});

test("groupMenuItemsBySubcategory: commerçant SANS sous-catégorie -- un seul groupe {subcategoryId:null}, contenant TOUS les produits dans l'ordre reçu (comportement historique reproduit à l'identique)", () => {
  const items = [
    item({ id: "eau" }),
    item({ id: "jus" }),
    item({ id: "soda" }),
  ];
  const groups = groupMenuItemsBySubcategory(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].subcategoryId, null);
  assert.equal(groups[0].subcategoryName, null);
  assert.deepEqual(
    groups[0].items.map((i) => i.id),
    ["eau", "jus", "soda"]
  );
});

test("groupMenuItemsBySubcategory: produits directs PUIS une sous-catégorie -- 2 groupes distincts, dans l'ordre reçu", () => {
  const items = [
    item({ id: "eau" }),
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
    item({ id: "pelardon", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
  ];
  const groups = groupMenuItemsBySubcategory(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].subcategoryId, null);
  assert.deepEqual(groups[0].items.map((i) => i.id), ["eau"]);
  assert.equal(groups[1].subcategoryId, "sub-chevres");
  assert.equal(groups[1].subcategoryName, "Chèvres");
  assert.deepEqual(groups[1].items.map((i) => i.id), ["charolais", "pelardon"]);
});

test("groupMenuItemsBySubcategory: PLUSIEURS sous-catégories consécutives -- un groupe par sous-catégorie, jamais fusionnées entre elles", () => {
  const items = [
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
    item({ id: "pelardon", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
    item({ id: "camembert", subcategory_id: "sub-vaches", subcategory_name: "Vaches" }),
  ];
  const groups = groupMenuItemsBySubcategory(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].subcategoryId, "sub-chevres");
  assert.deepEqual(groups[0].items.map((i) => i.id), ["charolais", "pelardon"]);
  assert.equal(groups[1].subcategoryId, "sub-vaches");
  assert.deepEqual(groups[1].items.map((i) => i.id), ["camembert"]);
});

test("groupMenuItemsBySubcategory: une même sous-catégorie réapparaissant PLUS LOIN dans la liste (non consécutive) -- reste 2 groupes distincts, jamais fusionnés à distance (la segmentation est purement séquentielle, l'ordre amont -- restaurant.ts / get_merchant_catalogue -- garantit déjà la contiguïté réelle)", () => {
  const items = [
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
    item({ id: "camembert", subcategory_id: "sub-vaches", subcategory_name: "Vaches" }),
    item({ id: "pelardon", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
  ];
  const groups = groupMenuItemsBySubcategory(items);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.subcategoryId), [
    "sub-chevres",
    "sub-vaches",
    "sub-chevres",
  ]);
});

test("groupMenuItemsBySubcategory: subcategory_name absent (undefined) sur un item de sous-catégorie -- devient null, jamais 'undefined' affiché", () => {
  const items = [
    item({ id: "x", subcategory_id: "sub-1", subcategory_name: undefined }),
  ];
  const groups = groupMenuItemsBySubcategory(items);
  assert.equal(groups[0].subcategoryName, null);
});

test("groupMenuItemsBySubcategory: ne modifie JAMAIS les objets MenuItem d'origine (aucune copie/mutation, item.id reste la clé stable pour le panier)", () => {
  const original = item({ id: "eau" });
  const groups = groupMenuItemsBySubcategory([original]);
  assert.equal(groups[0].items[0], original, "doit être la MÊME référence d'objet, pas une copie");
});
