import { addToCart, cartLines, type Cart } from "@/lib/cart";
import { getChoices, getOptionGroup } from "@/lib/restaurants-config";
import type { RestaurantFull } from "@/lib/types";

// The browser stores identifiers and quantities only. Prices and product
// details always come from the current public catalogue on restoration.
export function cartSessionKey(restaurantId: string): string {
  return `scanym:cart:v1:${restaurantId}`;
}

export function serializeSessionCart(cart: Cart): string {
  return JSON.stringify({
    version: 1,
    lines: cartLines(cart).map((line) => ({
      itemId: line.item.id,
      optionId: line.option?.id ?? null,
      quantity: line.quantity,
    })),
  });
}

export function restoreSessionCart(value: string | null, restaurant: RestaurantFull): { cart: Cart; removed: boolean } {
  if (!value) return { cart: {}, removed: false };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { cart: {}, removed: false }; }
  if (!parsed || typeof parsed !== "object") return { cart: {}, removed: false };
  const saved = parsed as { version?: unknown; lines?: unknown };
  if (saved.version !== 1 || !Array.isArray(saved.lines) || saved.lines.length > 500) return { cart: {}, removed: false };

  const items = new Map(
    restaurant.categories.filter((category) => category.is_active)
      .flatMap((category) => category.menu_items)
      .filter((item) => item.is_available && !item.archived_at)
      .map((item) => [item.id, item])
  );
  let cart: Cart = {};
  let removed = false;
  for (const entry of saved.lines) {
    if (!entry || typeof entry !== "object") { removed = true; continue; }
    const line = entry as { itemId?: unknown; optionId?: unknown; quantity?: unknown };
    if (typeof line.itemId !== "string" || !Number.isSafeInteger(line.quantity) ||
        (line.quantity as number) <= 0 || (line.quantity as number) > 10000) { removed = true; continue; }
    const item = items.get(line.itemId);
    if (!item) { removed = true; continue; }
    const group = getOptionGroup(restaurant.slug, item);
    if (!group && line.optionId != null) { removed = true; continue; }
    if (group) {
      if (typeof line.optionId !== "string") { removed = true; continue; }
      const option = getChoices(restaurant, group).find(
        (choice) => choice.id === line.optionId && choice.is_available && !choice.archived_at
      );
      if (!option) { removed = true; continue; }
      cart = addToCart(cart, { item, option, quantity: line.quantity as number,
        optionKind: group.title.includes("goût") ? "flavor" : "pastry" });
    } else {
      cart = addToCart(cart, { item, quantity: line.quantity as number });
    }
  }
  return { cart, removed };
}
