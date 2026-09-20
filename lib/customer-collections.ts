/**
 * Scanym — P1 CUSTOMER COLLECTIONS BY TAGS.
 *
 * Logique PURE (aucun accès réseau) de la navigation « Collections » de
 * la carte publique. Consomme EXCLUSIVEMENT le contrat client existant
 * `get_restaurant_collections` (via lib/services/catalogue-tags.ts), déjà
 * filtré côté serveur (tag actif + publié, établissement publié, produits
 * disponibles et non archivés, collection vide supprimée).
 *
 * Aucune nouvelle source de vérité : une collection n'est qu'une VUE
 * supplémentaire sur les produits déjà admis dans le modèle public
 * (RestaurantFull.categories). Défense en profondeur, comme
 * lib/customer-product-tags.ts : tout identifiant produit inconnu du
 * modèle public (autre tenant, catégorie masquée, produit non chargé)
 * est ignoré, et une collection qui ne garde aucun produit est retirée.
 */
import type { CustomerTagSource } from "@/lib/customer-product-tags";
import type { MenuItemGroup } from "@/lib/catalogue-subcategory-grouping";

/** Collection publique prête à l'affichage : identifiants produits déjà
 *  restreints au modèle public, jamais vide. */
export interface CustomerCollection {
  id: string;
  label: string;
  displayOrder: number;
  menuItemIds: string[];
}

/**
 * Collections affichables, dans l'ordre du contrat serveur
 * (display_order ; à égalité, l'ordre reçu -- déjà trié par libellé côté
 * serveur -- est conservé par un tri stable).
 */
export function buildCustomerCollections(
  sources: ReadonlyArray<CustomerTagSource>,
  allowedMenuItemIds: ReadonlySet<string>
): CustomerCollection[] {
  const out: CustomerCollection[] = [];
  const seenIds = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source.id !== "string" || seenIds.has(source.id)) continue;
    const label = typeof source.label === "string" ? source.label.trim() : "";
    if (label.length === 0) continue;
    const ids: string[] = [];
    const seenItems = new Set<string>();
    for (const menuItemId of source.menuItemIds ?? []) {
      if (!allowedMenuItemIds.has(menuItemId) || seenItems.has(menuItemId)) continue;
      seenItems.add(menuItemId);
      ids.push(menuItemId);
    }
    if (ids.length === 0) continue;
    seenIds.add(source.id);
    out.push({
      id: source.id,
      label,
      displayOrder: Number.isFinite(source.displayOrder) ? source.displayOrder : 0,
      menuItemIds: ids,
    });
  }
  return out.sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Produits d'une collection, pris dans les catégories PUBLIQUES affichées,
 * dans l'ordre public existant (ordre des catégories puis ordre des
 * produits dans chaque catégorie, sous-catégories comprises). Retourne
 * les MÊMES objets produit que la navigation normale (panier, options et
 * badges inchangés). Collection absente/inconnue -> aucun produit.
 */
export function selectCollectionItems<T extends { id: string }>(
  categories: ReadonlyArray<{ menu_items: ReadonlyArray<T> }>,
  collection: Pick<CustomerCollection, "menuItemIds"> | null | undefined
): T[] {
  if (!collection) return [];
  const wanted = new Set(collection.menuItemIds);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    for (const item of category.menu_items) {
      if (!wanted.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * Tags publics utiles dans UNE catégorie active. L'intersection garde
 * l'ordre P1 existant et retire tout produit extérieur à la catégorie :
 * une même étiquette peut donc rester publiée dans plusieurs catégories
 * sans jamais transformer le filtre courant en collection transversale.
 */
export function deriveContextualCategoryTags<T extends { id: string }>(
  collections: ReadonlyArray<CustomerCollection>,
  categoryItems: ReadonlyArray<T>
): CustomerCollection[] {
  const categoryItemIds = new Set(categoryItems.map((item) => item.id));
  return collections.flatMap((collection) => {
    const menuItemIds = collection.menuItemIds.filter((id) => categoryItemIds.has(id));
    return menuItemIds.length > 0 ? [{ ...collection, menuItemIds }] : [];
  });
}

/**
 * Filtre par tag appliqué aux groupes déjà limités à la catégorie et,
 * éventuellement, à une sous-catégorie. Les groupes vides disparaissent,
 * l'ordre et les objets produit d'origine restent strictement inchangés.
 */
export function filterMenuItemGroupsByTag(
  groups: ReadonlyArray<MenuItemGroup>,
  tag: Pick<CustomerCollection, "menuItemIds"> | null | undefined
): MenuItemGroup[] {
  if (!tag) return [...groups];
  const wanted = new Set(tag.menuItemIds);
  return groups.flatMap((group) => {
    const items = group.items.filter((item) => wanted.has(item.id));
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}
