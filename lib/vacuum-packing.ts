import type { MenuCategory, MenuItem } from "@/lib/types";

/**
 * OPTION « MISE SOUS VIDE » -- règle PURE d'éligibilité.
 *
 * Source de vérité : l'indicateur `menu_categories.vacuum_packable`, posé par le
 * commerçant dans l'éditeur de catégorie. AUCUN nom de catégorie ou de produit
 * n'est jamais codé en dur ici. Une catégorie sans indicateur (colonne absente,
 * null, false) n'est pas éligible : comportement historique inchangé.
 *
 * Le serveur (create_order) revérifie : cette fonction ne fait que décider de
 * l'AFFICHAGE de la case, jamais d'une autorisation.
 */
export function vacuumPackableCategoryIds(
  categories: ReadonlyArray<Pick<MenuCategory, "id"> & { vacuum_packable?: boolean | null }>
): Set<string> {
  const ids = new Set<string>();
  for (const c of categories) if (c.vacuum_packable === true) ids.add(c.id);
  return ids;
}

/** Vrai si au moins un article du panier appartient à une catégorie éligible. */
export function cartHasVacuumPackable(
  lines: ReadonlyArray<{ item: Pick<MenuItem, "category_id"> }>,
  categories: ReadonlyArray<Pick<MenuCategory, "id"> & { vacuum_packable?: boolean | null }>
): boolean {
  const ids = vacuumPackableCategoryIds(categories);
  if (ids.size === 0) return false;
  return lines.some((l) => ids.has(l.item.category_id));
}

/** Valeur effectivement transmise : un choix ne survit jamais à la perte d'éligibilité. */
export function effectiveVacuumPacking(requested: boolean, available: boolean): boolean {
  return requested === true && available === true;
}
