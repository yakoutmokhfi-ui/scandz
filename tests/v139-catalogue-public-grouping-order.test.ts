import { test } from "node:test";
import assert from "node:assert/strict";

const { compareMenuItemsForPublicDisplay, groupMenuItemsBySubcategory } = await import(
  "../lib/catalogue-subcategory-grouping.ts"
);
import type { MenuItem } from "../lib/types.ts";

// ====================================================================
// CATALOGUE / SUBCATEGORIES v1.1 -- remédiation
// CAT-SUB-V1-PUBLIC-GROUPING-01 (audit Work, sévérité MEDIUM).
//
// Bug reproduit : quand 2 sous-catégories DIFFÉRENTES d'une même
// catégorie partagent le même display_order, l'ancien comparateur de
// lib/services/restaurant.ts (avant v1.1) retombait sur le
// display_order du PRODUIT lui-même pour les départager -- ce qui, en
// pratique, ignorait totalement la frontière entre les 2
// sous-catégories et pouvait produire un ordre entrelacé
// (ex. A1, B2, A3, B4) au lieu de garder chaque sous-catégorie
// contiguë. groupMenuItemsBySubcategory() (segmentation PURE en
// groupes consécutifs, inchangée par ce lot) suppose justement que le
// tableau reçu est déjà groupé par sous-catégorie -- un tri entrelacé
// lui fait donc produire PLUSIEURS groupes pour la MÊME sous-catégorie
// au lieu d'un seul, c'est-à-dire des clés React dupliquées et un
// sous-titre répété dans components/MenuView.tsx.
// ====================================================================

function item(overrides: Partial<MenuItem> & { id: string }): MenuItem {
  return {
    category_id: "cat-fromages",
    subcategory_id: null,
    subcategory_name: null,
    subcategory_display_order: null,
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

/**
 * Reproduction FIDÈLE du comparateur ad hoc qui existait dans
 * lib/services/restaurant.ts AVANT ce lot (v1.0) -- copié ici, jamais
 * importé depuis le code de production, précisément pour démontrer que
 * CE bug existait réellement et n'existe plus après le remplacement
 * par compareMenuItemsForPublicDisplay. Les 2 sous-catégories sont
 * résolues via une Map (comme le faisait restaurant.ts), pas via des
 * champs portés par l'item lui-même (subcategory_display_order
 * n'existait pas encore en v1.0).
 */
function legacyV1Compare(
  a: MenuItem,
  b: MenuItem,
  subcategoryDisplayOrderById: Map<string, number>
): number {
  const orderA = a.subcategory_id ? subcategoryDisplayOrderById.get(a.subcategory_id) : undefined;
  const orderB = b.subcategory_id ? subcategoryDisplayOrderById.get(b.subcategory_id) : undefined;
  const groupA = orderA !== undefined ? 1 : 0;
  const groupB = orderB !== undefined ? 1 : 0;
  if (groupA !== groupB) return groupA - groupB;
  if (orderA !== undefined && orderB !== undefined && orderA !== orderB) {
    return orderA - orderB;
  }
  return a.display_order - b.display_order;
}

function collisionFixture(): MenuItem[] {
  // Fromages -> Chèvres (display_order=1) et Vaches (display_order=1,
  // MÊME valeur) -- la collision exacte décrite par le finding.
  return [
    item({ id: "A1", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 1 }),
    item({ id: "B2", subcategory_id: "sub-vaches", subcategory_name: "Vaches", subcategory_display_order: 1, display_order: 2 }),
    item({ id: "A3", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 3 }),
    item({ id: "B4", subcategory_id: "sub-vaches", subcategory_name: "Vaches", subcategory_display_order: 1, display_order: 4 }),
  ];
}

test("PREUVE DE RÉGRESSION v1.0 : le comparateur historique ENTRELACE 2 sous-catégories de même display_order (A1, B2, A3, B4) -- démontre que le bug était réel avant ce lot", () => {
  const items = collisionFixture();
  const subcategoryDisplayOrderById = new Map([
    ["sub-chevres", 1],
    ["sub-vaches", 1],
  ]);
  const sorted = [...items].sort((a, b) => legacyV1Compare(a, b, subcategoryDisplayOrderById));
  assert.deepEqual(
    sorted.map((i) => i.id),
    ["A1", "B2", "A3", "B4"],
    "le comparateur v1.0 devait produire un ordre entrelacé pour cette collision -- si ce test échoue, la reproduction du bug n'est plus fidèle"
  );

  // Conséquence concrète : groupMenuItemsBySubcategory produit alors 4
  // groupes (jamais 2), donc des clés React dupliquées
  // ("sub-chevres" et "sub-vaches" apparaissent chacune 2 fois).
  const groups = groupMenuItemsBySubcategory(sorted);
  const groupIds = groups.map((g) => g.subcategoryId);
  assert.deepEqual(groupIds, ["sub-chevres", "sub-vaches", "sub-chevres", "sub-vaches"]);
  const uniqueIds = new Set(groupIds);
  assert.ok(uniqueIds.size < groupIds.length, "doit démontrer des clés de groupe DUPLIQUÉES (le bug React-key)");
});

test("v1.1 CORRIGÉ : compareMenuItemsForPublicDisplay garde CHAQUE sous-catégorie contiguë, même collision de display_order (A1, A3, B2, B4 -- jamais entrelacé)", () => {
  const items = collisionFixture();
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);

  // Chèvres (nom normalisé "chèvres") < Vaches ("vaches") -- départage
  // par nom normalisé quand le display_order est à égalité : Chèvres
  // sort en premier, entièrement groupé.
  assert.deepEqual(sorted.map((i) => i.id), ["A1", "A3", "B2", "B4"]);

  const groups = groupMenuItemsBySubcategory(sorted);
  assert.equal(groups.length, 2, "exactement 2 groupes -- un par sous-catégorie, jamais plus");
  assert.deepEqual(groups.map((g) => g.subcategoryId), ["sub-chevres", "sub-vaches"]);
  assert.deepEqual(groups[0].items.map((i) => i.id), ["A1", "A3"]);
  assert.deepEqual(groups[1].items.map((i) => i.id), ["B2", "B4"]);

  // Clés React (subcategoryId) -- toutes uniques.
  const groupIds = groups.map((g) => g.subcategoryId);
  assert.equal(new Set(groupIds).size, groupIds.length, "aucune clé de groupe dupliquée");
});

test("compareMenuItemsForPublicDisplay: produits directs TOUJOURS avant tout groupe de sous-catégorie (précédence #1)", () => {
  const items = [
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 1 }),
    item({ id: "eau", display_order: 1 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["eau", "charolais"]);
});

test("compareMenuItemsForPublicDisplay: sous-catégorie de display_order INFÉRIEUR sort en premier, quel que soit le nom (précédence #2 avant #3)", () => {
  const items = [
    item({ id: "camembert", subcategory_id: "sub-vaches", subcategory_name: "Vaches", subcategory_display_order: 2, display_order: 1 }),
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 1 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["charolais", "camembert"], "Chèvres (display_order=1) doit précéder Vaches (display_order=2) malgré l'ordre alphabétique inverse");
});

test("compareMenuItemsForPublicDisplay: tie-break par nom de sous-catégorie insensible à la casse/aux espaces (normalisation identique à l'index SQL anti-doublon)", () => {
  const items = [
    item({ id: "b-item", subcategory_id: "sub-b", subcategory_name: "  Vaches  ", subcategory_display_order: 1, display_order: 1 }),
    item({ id: "a-item", subcategory_id: "sub-a", subcategory_name: "CHÈVRES", subcategory_display_order: 1, display_order: 1 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["a-item", "b-item"]);
});

test("compareMenuItemsForPublicDisplay: si le nom normalisé est ÉGAL (théoriquement impossible dans la même catégorie grâce à l'index unique SQL, mais le comparateur reste total), l'id de sous-catégorie départage en dernier recours", () => {
  const items = [
    item({ id: "y", subcategory_id: "sub-zzz", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 1 }),
    item({ id: "x", subcategory_id: "sub-aaa", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 1 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["x", "y"], "sub-aaa < sub-zzz");
});

test("compareMenuItemsForPublicDisplay: à l'intérieur d'une MÊME sous-catégorie, tri normal par display_order puis nom puis id du produit (précédence #4/#5, inchangé)", () => {
  const items = [
    item({ id: "pelardon", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, name: "Pélardon", display_order: 2 }),
    item({ id: "charolais", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, name: "Charolais", display_order: 1 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["charolais", "pelardon"]);
});

test("compareMenuItemsForPublicDisplay: 2 produits directs à display_order égal -- départagés par nom normalisé puis id (jamais un ordre arbitraire/instable)", () => {
  const items = [
    item({ id: "jus", name: "Jus", display_order: 1 }),
    item({ id: "eau", name: "Eau", display_order: 1 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["eau", "jus"]);
});

test("compareMenuItemsForPublicDisplay: commerçant SANS aucune sous-catégorie -- comportement historique par display_order strictement préservé (non-régression)", () => {
  const items = [
    item({ id: "soda", display_order: 3 }),
    item({ id: "eau", display_order: 1 }),
    item({ id: "jus", display_order: 2 }),
  ];
  const sorted = [...items].sort(compareMenuItemsForPublicDisplay);
  assert.deepEqual(sorted.map((i) => i.id), ["eau", "jus", "soda"]);
});

test("compareMenuItemsForPublicDisplay: ordre DÉTERMINISTE à travers 20 exécutions répétées, y compris depuis un tableau pré-mélangé (aucune dépendance à l'ordre d'entrée ni à une comparaison instable)", () => {
  const shuffled = [
    item({ id: "B4", subcategory_id: "sub-vaches", subcategory_name: "Vaches", subcategory_display_order: 1, display_order: 4 }),
    item({ id: "eau", display_order: 1 }),
    item({ id: "A3", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 3 }),
    item({ id: "A1", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 1, display_order: 1 }),
    item({ id: "B2", subcategory_id: "sub-vaches", subcategory_name: "Vaches", subcategory_display_order: 1, display_order: 2 }),
  ];
  const results = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const sorted = [...shuffled].sort(compareMenuItemsForPublicDisplay);
    results.add(sorted.map((x) => x.id).join(","));
  }
  assert.equal(results.size, 1, "un seul ordre résultat possible sur 20 exécutions");
  assert.equal([...results][0], "eau,A1,A3,B2,B4");
});
