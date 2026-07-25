import type { MenuItem, RestaurantFull } from "@/lib/types";

/**
 * Articles nécessitant le choix d'une pâtisserie avant ajout au
 * panier (décision UX CTO du 25/07/2026).
 *
 * NOTE ARCHITECTURE : pour le MVP, la détection se fait par le nom
 * du produit. Si les options se multiplient (choix de boisson, de
 * lait, de taille...), la bonne évolution sera une table d'options
 * en base — à soumettre à validation Yakout + CTO le moment venu.
 */
const ITEMS_WITH_PASTRY_CHOICE = ["Formule Prestigio"];

export function requiresPastryChoice(item: MenuItem): boolean {
  return ITEMS_WITH_PASTRY_CHOICE.includes(item.name);
}

/** Retourne les pâtisseries disponibles pour le choix en modal. */
export function getPastryChoices(restaurant: RestaurantFull): MenuItem[] {
  const category = restaurant.categories.find((c) =>
    c.name.includes("Pâtisseries")
  );
  return category?.menu_items ?? [];
}
