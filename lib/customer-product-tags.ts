/**
 * Scanym — CUSTOMER TAGS DISPLAY (LOT 01).
 *
 * Logique PURE (aucun accès réseau) qui transforme le contrat de
 * lecture CLIENT déjà existant `get_restaurant_collections` (lib/
 * services/catalogue-tags.ts, une ligne par collection VISIBLE avec
 * ses produits agrégés) en carte produit -> libellés de tags affichés
 * sur la carte publique.
 *
 * Aucune nouvelle source de vérité : seuls les tags que le marchand a
 * explicitement publiés (visible_on_customer_menu = true) atteignent
 * le client -- un tag interne n'est jamais exposé, exactement la règle
 * déjà portée par la RPC. Ce module ne décide rien côté sécurité ; il
 * ajoute seulement une défense en profondeur : un identifiant produit
 * qui n'appartient pas aux produits déjà chargés pour CET
 * établissement est ignoré (aucune fuite inter-tenant possible même si
 * la réponse amont était incohérente).
 */

/** Forme minimale d'une collection lue par le menu client (sous-ensemble
 *  structurel de RestaurantCollection, lib/services/catalogue-tags.ts). */
export interface CustomerTagSource {
  id: string;
  label: string;
  displayOrder: number;
  menuItemIds: string[];
}

/** Clé de dédoublonnage d'un libellé : insensible à la casse, aux
 *  espaces de bord et aux formes Unicode équivalentes (« Bio » et
 *  « bio » ne s'affichent qu'une fois). */
function tagKey(label: string): string {
  return label.normalize("NFC").trim().toLocaleLowerCase();
}

/**
 * Libellés nettoyés, sans vide ni doublon, dans l'ordre reçu (première
 * occurrence conservée). Utilisé à la fois par le service et au rendu,
 * pour qu'aucune pilule dupliquée ne puisse jamais s'afficher.
 */
export function dedupeTagLabels(labels: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    if (label.length === 0) continue;
    const key = tagKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Carte produit -> libellés, ordonnés comme les collections
 * (display_order puis libellé, même ordre que la RPC). Seuls les
 * produits présents dans `allowedMenuItemIds` (ceux de l'établissement
 * affiché) reçoivent des tags ; un produit sans tag est absent de la
 * carte.
 */
export function buildCustomerProductTags(
  collections: ReadonlyArray<CustomerTagSource>,
  allowedMenuItemIds: ReadonlySet<string>
): Map<string, string[]> {
  const ordered = [...collections].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label)
  );
  const raw = new Map<string, string[]>();
  for (const collection of ordered) {
    for (const menuItemId of collection.menuItemIds ?? []) {
      if (!allowedMenuItemIds.has(menuItemId)) continue;
      const list = raw.get(menuItemId);
      if (list) list.push(collection.label);
      else raw.set(menuItemId, [collection.label]);
    }
  }
  const result = new Map<string, string[]>();
  for (const [menuItemId, labels] of raw) {
    const tags = dedupeTagLabels(labels);
    if (tags.length > 0) result.set(menuItemId, tags);
  }
  return result;
}

/**
 * Ajoute `customer_tags` aux seuls produits tagués. Un produit sans tag
 * est retourné tel quel (même objet, aucune propriété ajoutée).
 */
export function attachCustomerTags<T extends { id: string }>(
  items: T[],
  tagsByItem: ReadonlyMap<string, string[]>
): (T & { customer_tags?: string[] })[] {
  return items.map((item) => {
    const tags = tagsByItem.get(item.id);
    return tags && tags.length > 0 ? { ...item, customer_tags: tags } : item;
  });
}
