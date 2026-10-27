import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// UX LOT 2026-10 (demande Emmanuel) -- `cartContainsAlcohol` (lib/cart.ts).
// Source UNIQUE : le drapeau marchand `contains_alcohol` du produit ou de
// son option. Jamais une inférence depuis le nom/la description/les tags.
// ====================================================================

const { cartContainsAlcohol, cartLines } = await import("../lib/cart.ts");

function item(over: Record<string, unknown> = {}) {
  return {
    id: "i-" + Math.random().toString(36).slice(2),
    category_id: "c1",
    name: "Produit",
    description: null,
    short_description: null,
    price: 5,
    image_url: null,
    display_order: 1,
    is_available: true,
    ...over,
  } as any;
}

function cartOf(entries: Array<{ item: any; quantity: number; option?: any }>) {
  const cart: Record<string, any> = {};
  entries.forEach((e, i) => {
    cart[`k${i}`] = { key: `k${i}`, item: e.item, quantity: e.quantity, option: e.option };
  });
  return cart;
}

test("panier vide -> false", () => {
  assert.equal(cartContainsAlcohol({}), false);
});

test("aucun drapeau (colonne absente) -> false, même si le NOM évoque l'alcool", () => {
  const cart = cartOf([{ item: item({ name: "Vin rouge Bordeaux 75cl" }), quantity: 2 }]);
  assert.equal(cartContainsAlcohol(cart), false);
});

test("drapeau false / null -> false", () => {
  assert.equal(cartContainsAlcohol(cartOf([{ item: item({ contains_alcohol: false }), quantity: 1 }])), false);
  assert.equal(cartContainsAlcohol(cartOf([{ item: item({ contains_alcohol: null }), quantity: 1 }])), false);
});

test("un seul produit marqué parmi d'autres -> true", () => {
  const cart = cartOf([
    { item: item(), quantity: 3 },
    { item: item({ contains_alcohol: true }), quantity: 1 },
  ]);
  assert.equal(cartContainsAlcohol(cart), true);
});

test("option (goût/variante) marquée, produit non marqué -> true", () => {
  const cart = cartOf([{ item: item(), quantity: 1, option: item({ contains_alcohol: true }) }]);
  assert.equal(cartContainsAlcohol(cart), true);
});

test("ligne à quantité 0 (retirée) ne compte pas, cohérent avec cartLines", () => {
  const cart = cartOf([{ item: item({ contains_alcohol: true }), quantity: 0 }]);
  assert.equal(cartLines(cart).length, 0);
  assert.equal(cartContainsAlcohol(cart), false);
});

test("une valeur non booléenne (chaîne « true ») n'est jamais interprétée comme vrai", () => {
  assert.equal(cartContainsAlcohol(cartOf([{ item: item({ contains_alcohol: "true" }), quantity: 1 }])), false);
});
