import type { MenuItem } from "@/lib/types";

export type OptionKind = "flavor" | "pastry";

export interface CartEntry {
  key: string;
  item: MenuItem;
  quantity: number;
  option?: MenuItem;
  optionKind?: OptionKind;
}

/** Panier : une entrée par couple produit + option. */
export type Cart = Record<string, CartEntry>;

/**
 * Clé d'une ligne. Un même produit commandé avec deux options
 * différentes occupe deux lignes distinctes, chacune ajustable
 * séparément.
 */
export function lineKey(itemId: string, optionName?: string): string {
  return optionName ? `${itemId}::${optionName}` : itemId;
}

/** Lignes du panier, dans leur ordre d'ajout. */
export function cartLines(cart: Cart): CartEntry[] {
  return Object.values(cart).filter((l) => l.quantity > 0);
}

/** Quantité totale d'un produit, toutes options confondues. */
export function quantityForItem(cart: Cart, itemId: string): number {
  return cartLines(cart)
    .filter((l) => l.item.id === itemId)
    .reduce((sum, l) => sum + l.quantity, 0);
}

/** Quantités par option pour un produit (affichage des goûts). */
export function optionCountsForItem(
  cart: Cart,
  itemId: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of cartLines(cart)) {
    if (line.item.id !== itemId || !line.option) continue;
    out[line.option.name] = line.quantity;
  }
  return out;
}

/**
 * Ajoute une quantité à une ligne, ou la crée. Une quantité qui
 * tombe à zéro supprime la ligne : l'option retenue disparaît avec
 * elle, il ne reste aucun résidu de sélection.
 */
export function addToCart(
  cart: Cart,
  params: {
    item: MenuItem;
    quantity: number;
    option?: MenuItem;
    optionKind?: OptionKind;
  }
): Cart {
  const { item, quantity, option, optionKind } = params;
  const key = lineKey(item.id, option?.name);
  const next = { ...cart };
  const current = next[key]?.quantity ?? 0;
  const total = current + quantity;

  if (total <= 0) {
    delete next[key];
    return next;
  }

  next[key] = {
    key,
    item: next[key]?.item ?? item,
    option: next[key]?.option ?? option,
    optionKind: next[key]?.optionKind ?? optionKind,
    quantity: total,
  };
  return next;
}

/** Modifie une ligne précise, identifiée par sa clé. */
export function changeLineQuantity(
  cart: Cart,
  key: string,
  delta: number
): Cart {
  const line = cart[key];
  if (!line) return cart;
  return addToCart(cart, {
    item: line.item,
    quantity: delta,
    option: line.option,
    optionKind: line.optionKind,
  });
}

/**
 * Retire une unité d'un produit depuis sa carte de menu.
 *
 * Pour un produit à options, la carte n'affiche qu'un total : on
 * retire de la ligne ajoutée en dernier, ce qui est le comportement
 * attendu quand on vient de se tromper. Quand la dernière unité
 * part, le produit quitte le panier et la carte revient au bouton
 * « Ajouter ».
 */
export function decrementItem(cart: Cart, itemId: string): Cart {
  const lines = cartLines(cart).filter((l) => l.item.id === itemId);
  if (lines.length === 0) return cart;
  const target = lines[lines.length - 1];
  return changeLineQuantity(cart, target.key, -1);
}

/** Retire entièrement un produit, toutes ses options comprises. */
export function removeItem(cart: Cart, itemId: string): Cart {
  const next = { ...cart };
  for (const line of cartLines(cart)) {
    if (line.item.id === itemId) delete next[line.key];
  }
  return next;
}

export function totalCount(cart: Cart): number {
  return cartLines(cart).reduce((sum, l) => sum + l.quantity, 0);
}

export function totalPrice(cart: Cart): number {
  return cartLines(cart).reduce((sum, l) => sum + l.item.price * l.quantity, 0);
}
