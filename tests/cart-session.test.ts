import { test } from "node:test";
import assert from "node:assert/strict";
import { addToCart, cartLines } from "../lib/cart.ts";
import { cartSessionKey, restoreSessionCart, serializeSessionCart } from "../lib/cart-session.ts";
import type { RestaurantFull, MenuItem } from "../lib/types.ts";

const item = (id: string, name: string, price: number): MenuItem => ({
  id, name, price, category_id: "c", description: null, short_description: null,
  image_url: null, display_order: 0, is_available: true,
});
const product = item("p1", "Cookie", 3);
const choice = item("o1", "Chocolat", 0);
const other = item("p2", "Thé", 4);
const restaurant = {
  id: "shop-a", slug: "sanaa-cookies",
  categories: [{ id: "c", name: "Boissons et biscuits", is_active: true, menu_items: [product, other] }],
  hiddenCategories: [{ id: "hidden", name: "Goûts cookies", menu_items: [choice] }],
} as unknown as RestaurantFull;

test("la session conserve seulement les identifiants et quantités, puis relit le prix et l'option courants", () => {
  let cart = addToCart({}, { item: product, option: choice, optionKind: "flavor", quantity: 2 });
  cart = addToCart(cart, { item: other, quantity: 1 });
  const saved = serializeSessionCart(cart);
  assert.ok(!saved.includes("Chocolat") && !saved.includes("price") && !saved.includes("phone"));
  const updated = { ...restaurant, categories: [{ ...restaurant.categories[0], menu_items: [{ ...product, price: 7 }, other] }] };
  const restored = restoreSessionCart(saved, updated);
  assert.equal(restored.removed, false);
  assert.equal(cartLines(restored.cart).length, 2);
  assert.equal(cartLines(restored.cart)[0].item.price, 7);
  assert.equal(cartLines(restored.cart)[0].option?.id, "o1");
  assert.equal(cartLines(restored.cart)[0].quantity, 2);
});

test("produit ou option retirés et quantités invalides ne sont pas restaurés", () => {
  const payload = JSON.stringify({ version: 1, lines: [
    { itemId: "p1", optionId: "missing", quantity: 1 },
    { itemId: "p2", optionId: null, quantity: -1 },
    { itemId: "unknown", optionId: null, quantity: 1 },
    { itemId: "p2", optionId: null, quantity: 2 },
  ] });
  const result = restoreSessionCart(payload, restaurant);
  assert.equal(result.removed, true);
  assert.equal(cartLines(result.cart).length, 1);
  assert.equal(cartLines(result.cart)[0].item.id, "p2");
  assert.equal(cartLines(result.cart)[0].quantity, 2);
});

test("les paniers sont isolés par établissement et les données invalides sont ignorées", () => {
  assert.notEqual(cartSessionKey("shop-a"), cartSessionKey("shop-b"));
  assert.deepEqual(restoreSessionCart("{", restaurant).cart, {});
  assert.deepEqual(restoreSessionCart('{"version":2,"lines":[]}', restaurant).cart, {});
  const otherShop = { ...restaurant, id: "shop-b", categories: [] };
  const payload = JSON.stringify({ version: 1, lines: [{ itemId: "p2", quantity: 1 }] });
  assert.deepEqual(restoreSessionCart(payload, otherShop).cart, {});
});
