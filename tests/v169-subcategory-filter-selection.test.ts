import { test } from "node:test";
import assert from "node:assert/strict";

const {
  groupMenuItemsBySubcategory,
  deriveSubcategoryFilterOptions,
  filterMenuItemGroupsBySubcategory,
} = await import("../lib/catalogue-subcategory-grouping.ts");
import type { MenuItem } from "../lib/types.ts";

// ====================================================================
// CUSTOMER MENU / SUBCATEGORY FILTER NAVIGATION v1 -- tests unitaires
// PURS pour deriveSubcategoryFilterOptions() et
// filterMenuItemGroupsBySubcategory() (lib/catalogue-subcategory-
// grouping.ts), consommées par components/MenuView.tsx (via
// components/SubcategoryFilter.tsx pour l'affichage). Même patron que
// tests/v138-catalogue-subcategory-grouping.test.ts.
//
// Couvre les scénarios obligatoires §16 testables sans rendu DOM :
// C (Tous par défaut -- couvert indirectement, la valeur par défaut
// activeSubcategoryId=null vit dans MenuView.tsx, testé en DOM v169b),
// D, E, F, J (ordre). Les scénarios nécessitant un rendu réel (A, B,
// G, H, K, L) sont couverts par tests/v169b-*.dom.test.ts.
// ====================================================================

function item(overrides: Partial<MenuItem> & { id: string }): MenuItem {
  return {
    category_id: "cat-fromages",
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

// --------------------------------------------------------------
// deriveSubcategoryFilterOptions
// --------------------------------------------------------------

test("deriveSubcategoryFilterOptions: catégorie sans aucune sous-catégorie -- tableau vide (aucune pilule, jamais 'Tous' inclus ici -- 'Tous' est géré séparément par SubcategoryFilter.tsx)", () => {
  const groups = groupMenuItemsBySubcategory([item({ id: "eau" }), item({ id: "jus" })]);
  const options = deriveSubcategoryFilterOptions(groups);
  assert.deepEqual(options, []);
});

test("deriveSubcategoryFilterOptions: une pilule par sous-catégorie RÉELLE, jamais de pilule pour le groupe direct (subcategory_id null)", () => {
  const groups = groupMenuItemsBySubcategory([
    item({ id: "eau" }), // direct
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
    item({ id: "camembert", subcategory_id: "sub-vaches", subcategory_name: "Vaches" }),
  ]);
  const options = deriveSubcategoryFilterOptions(groups);
  assert.deepEqual(options, [
    { id: "sub-chevres", name: "Chèvres" },
    { id: "sub-vaches", name: "Vaches" },
  ]);
});

test("deriveSubcategoryFilterOptions: respecte l'ordre déjà présent dans les groupes (display_order de la sous-catégorie, jamais recalculé/re-trié alphabétiquement -- scénario J)", () => {
  // Fournit délibérément les groupes dans un ordre non alphabétique
  // ("Vaches" avant "Chèvres") pour prouver qu'aucun tri alphabétique
  // n'est appliqué ici -- l'ordre d'affichage vient entièrement de
  // l'ordre reçu (display_order, déjà résolu en amont).
  const groups = groupMenuItemsBySubcategory([
    item({ id: "camembert", subcategory_id: "sub-vaches", subcategory_name: "Vaches" }),
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
  ]);
  const options = deriveSubcategoryFilterOptions(groups);
  assert.deepEqual(options.map((o) => o.name), ["Vaches", "Chèvres"]);
});

test("deriveSubcategoryFilterOptions: subcategoryName null (ne devrait pas arriver pour un groupe réel, mais défensif) -- devient chaîne vide, jamais 'null' affiché", () => {
  const groups = [{ subcategoryId: "sub-x", subcategoryName: null, items: [] }];
  const options = deriveSubcategoryFilterOptions(groups);
  assert.deepEqual(options, [{ id: "sub-x", name: "" }]);
});

// --------------------------------------------------------------
// filterMenuItemGroupsBySubcategory
// --------------------------------------------------------------

test("filterMenuItemGroupsBySubcategory: activeSubcategoryId=null (Tous) -- retourne TOUS les groupes inchangés, y compris le groupe direct (scénario D + F)", () => {
  const groups = groupMenuItemsBySubcategory([
    item({ id: "eau" }),
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
  ]);
  const filtered = filterMenuItemGroupsBySubcategory(groups, null);
  assert.deepEqual(filtered, groups);
});

test("filterMenuItemGroupsBySubcategory: activeSubcategoryId précis -- UNIQUEMENT le groupe correspondant, jamais le groupe direct (scénario E + F)", () => {
  const groups = groupMenuItemsBySubcategory([
    item({ id: "eau" }), // direct -- subcategory_id null
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
    item({ id: "camembert", subcategory_id: "sub-vaches", subcategory_name: "Vaches" }),
  ]);
  const filtered = filterMenuItemGroupsBySubcategory(groups, "sub-chevres");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].subcategoryId, "sub-chevres");
  assert.deepEqual(filtered[0].items.map((i) => i.id), ["charolais"]);
});

test("filterMenuItemGroupsBySubcategory: sous-catégorie inconnue (ne correspond à aucun groupe) -- tableau vide, jamais une exception ni un repli sur 'Tous'", () => {
  const groups = groupMenuItemsBySubcategory([
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres" }),
  ]);
  const filtered = filterMenuItemGroupsBySubcategory(groups, "sub-inconnue");
  assert.deepEqual(filtered, []);
});

test("filterMenuItemGroupsBySubcategory: ne mute JAMAIS le tableau de groupes d'origine (nouvelle référence de tableau à chaque appel)", () => {
  const groups = groupMenuItemsBySubcategory([item({ id: "eau" })]);
  const filtered = filterMenuItemGroupsBySubcategory(groups, null);
  assert.notEqual(filtered, groups, "doit être un NOUVEAU tableau (même si le contenu est identique)");
  assert.deepEqual(filtered, groups);
});

// --------------------------------------------------------------
// Exemple travaillé du mandat, §15 -- Fromages, 5 sous-catégories,
// 7 produits A-G (A,B=Raclette ; C=Fromage à la truffe ; D=Pâtes
// dures ; E=Pâtes molles ; F=Chèvres ; G=aucune sous-catégorie).
// Reproduit EXACTEMENT les 4 résultats attendus du mandat.
// --------------------------------------------------------------

function fromagesGroups() {
  return groupMenuItemsBySubcategory([
    item({ id: "G", display_order: 1 }), // direct, listé en dernier logiquement mais placé ici pour prouver l'ordre reçu (produits directs toujours en tête côté restaurant.ts réel -- ici on fait confiance à l'ordre transmis)
    item({ id: "A", subcategory_id: "sub-raclette", subcategory_name: "Raclette", display_order: 1 }),
    item({ id: "B", subcategory_id: "sub-raclette", subcategory_name: "Raclette", display_order: 2 }),
    item({ id: "C", subcategory_id: "sub-truffe", subcategory_name: "Fromage à la truffe", display_order: 1 }),
    item({ id: "D", subcategory_id: "sub-pates-dures", subcategory_name: "Pâtes dures", display_order: 1 }),
    item({ id: "E", subcategory_id: "sub-pates-molles", subcategory_name: "Pâtes molles", display_order: 1 }),
    item({ id: "F", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", display_order: 1 }),
  ]);
}

function idsOf(groups: ReturnType<typeof fromagesGroups>) {
  return groups.flatMap((g) => g.items.map((i) => i.id));
}

test("mandat §15 (Fromages) : Tous par défaut -- A B C D E F G, dans l'ordre reçu", () => {
  const groups = fromagesGroups();
  const filtered = filterMenuItemGroupsBySubcategory(groups, null);
  assert.deepEqual(idsOf(filtered), ["G", "A", "B", "C", "D", "E", "F"]);
});

test("mandat §15 (Fromages) : Raclette sélectionné -- uniquement A B", () => {
  const groups = fromagesGroups();
  const filtered = filterMenuItemGroupsBySubcategory(groups, "sub-raclette");
  assert.deepEqual(idsOf(filtered), ["A", "B"]);
});

test("mandat §15 (Fromages) : Chèvres sélectionné -- uniquement F", () => {
  const groups = fromagesGroups();
  const filtered = filterMenuItemGroupsBySubcategory(groups, "sub-chevres");
  assert.deepEqual(idsOf(filtered), ["F"]);
});

test("mandat §15 (Fromages) : retour à Tous après Chèvres -- de nouveau A B C D E F G au complet (pas de perte de produit après un cycle de filtrage)", () => {
  const groups = fromagesGroups();
  filterMenuItemGroupsBySubcategory(groups, "sub-chevres"); // simule une sélection intermédiaire
  const backToAll = filterMenuItemGroupsBySubcategory(groups, null);
  assert.deepEqual(idsOf(backToAll), ["G", "A", "B", "C", "D", "E", "F"]);
});

test("mandat §15 (Fromages) : les 5 pilules de filtre attendues sont dérivées, dans l'ordre, sans 'G' (produit direct, aucune pilule dédiée)", () => {
  const groups = fromagesGroups();
  const options = deriveSubcategoryFilterOptions(groups);
  assert.deepEqual(options.map((o) => o.name), [
    "Raclette",
    "Fromage à la truffe",
    "Pâtes dures",
    "Pâtes molles",
    "Chèvres",
  ]);
});
