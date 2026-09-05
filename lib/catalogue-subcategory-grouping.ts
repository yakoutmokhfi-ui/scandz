import type { MenuItem } from "@/lib/types";

/**
 * CATALOGUE / SUBCATEGORIES v1 -- logique PURE de regroupement visuel
 * d'une liste de produits (déjà triée par lib/services/restaurant.ts :
 * produits directs d'abord, puis chaque sous-catégorie, chacune dans
 * son propre display_order) en segments consécutifs, pour permettre à
 * MenuView.tsx d'insérer un sous-titre avant chaque groupe de
 * sous-catégorie SANS toucher au tableau `menu_items` lui-même (le
 * panier, la résolution d'options et les compteurs de quantité restent
 * entièrement indexés par item.id, comme avant ce lot).
 *
 * Un commerçant sans aucune sous-catégorie produit un unique segment
 * `{ subcategoryId: null, items: [...tous les produits] }` --
 * reproduisant exactement le rendu historique (aucun sous-titre).
 */
export interface MenuItemGroup {
  subcategoryId: string | null;
  subcategoryName: string | null;
  items: MenuItem[];
}

export function groupMenuItemsBySubcategory(items: readonly MenuItem[]): MenuItemGroup[] {
  const groups: MenuItemGroup[] = [];
  for (const item of items) {
    const subcategoryId = item.subcategory_id ?? null;
    const last = groups[groups.length - 1];
    if (last && last.subcategoryId === subcategoryId) {
      last.items.push(item);
    } else {
      groups.push({
        subcategoryId,
        subcategoryName: subcategoryId ? (item.subcategory_name ?? null) : null,
        items: [item],
      });
    }
  }
  return groups;
}

// ======================================================================
// CATALOGUE / SUBCATEGORIES v1.1 -- remédiation CAT-SUB-V1-PUBLIC-GROUPING-01
// (audit Work). groupMenuItemsBySubcategory() ci-dessus est une PURE
// segmentation en groupes CONSÉCUTIFS : elle suppose déjà que le
// tableau reçu place tous les produits d'une même sous-catégorie côte
// à côte. Cette hypothèse était rompue par l'ancien comparateur de tri
// de lib/services/restaurant.ts, qui -- quand deux sous-catégories
// DIFFÉRENTES partageaient le même display_order -- retombait sur le
// display_order du PRODUIT lui-même sans jamais départager les deux
// sous-catégories, entrelaçant leurs produits (ex. A1, B2, A3, B4).
// Conséquence concrète : plusieurs segments consécutifs pour la MÊME
// sous-catégorie, donc plusieurs <div key={subcategoryId}> IDENTIQUES
// dans components/MenuView.tsx (clés React dupliquées) et un sous-titre
// répété pour la même sous-catégorie.
//
// compareMenuItemsForPublicDisplay() remplace ce comparateur par un
// ORDRE TOTAL déterministe qui ne retombe JAMAIS sur un champ produit
// tant que les deux produits n'appartiennent pas au même groupe
// (direct, ou LA MÊME sous-catégorie) :
//   1. produits directs avant tout groupe de sous-catégorie
//   2. sous-catégories différentes : display_order de la SOUS-CATÉGORIE,
//      puis son nom normalisé (trim + minuscule, même normalisation que
//      l'index anti-doublon SQL idx_menu_subcategories_unique_name),
//      puis son id (départage ultime, garanti unique)
//   3. même sous-catégorie (ou 2 produits directs) : display_order du
//      PRODUIT, puis son nom normalisé, puis son id
//
// Résultat : deux sous-catégories ne peuvent JAMAIS s'entrelacer, même
// à display_order égal -- chaque sous-catégorie reste un unique bloc
// contigu, donc un unique groupe/une unique clé React par sous-catégorie
// (voir tests/v139-catalogue-public-grouping-order.test.ts, qui
// reproduit explicitement la collision ET démontre que l'ancien
// comparateur l'aurait entrelacée).
// ======================================================================

/** Trim (même jeu de caractères "espace" que lib/catalogue-text.ts /
 *  btrim SQL) + minuscule -- comparaison insensible à la casse et aux
 *  espaces de bordure, jamais localeCompare (dont le résultat peut
 *  varier selon la configuration ICU de l'environnement d'exécution --
 *  l'ordre du catalogue public doit être IDENTIQUE partout, mandat
 *  "deterministic order across repeated execution"). */
function normalizeForCompare(value: string | null | undefined): string {
  return (value ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").toLowerCase();
}

/** Comparaison ordinale simple (code point par code point) -- stable,
 *  déterministe, sans dépendance à une locale. */
function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNormalizedNames(a: string | null | undefined, b: string | null | undefined): number {
  return compareOrdinal(normalizeForCompare(a), normalizeForCompare(b));
}

/**
 * Ordre total déterministe pour l'affichage catalogue PUBLIC (utilisé
 * par lib/services/restaurant.ts comme comparateur de tri, en
 * remplacement de l'ancien comparateur ad hoc). Voir le commentaire de
 * section ci-dessus pour la précédence complète et la justification.
 */
export function compareMenuItemsForPublicDisplay(a: MenuItem, b: MenuItem): number {
  const groupA = a.subcategory_id ? 1 : 0;
  const groupB = b.subcategory_id ? 1 : 0;
  if (groupA !== groupB) return groupA - groupB;

  if (a.subcategory_id && b.subcategory_id && a.subcategory_id !== b.subcategory_id) {
    // Sous-catégories DIFFÉRENTES : jamais départagées par un champ
    // produit -- c'est précisément ce qui empêchait l'entrelacement.
    const orderA = a.subcategory_display_order ?? 0;
    const orderB = b.subcategory_display_order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    const nameCmp = compareNormalizedNames(a.subcategory_name, b.subcategory_name);
    if (nameCmp !== 0) return nameCmp;
    return compareOrdinal(a.subcategory_id, b.subcategory_id);
  }

  // Même sous-catégorie (ou 2 produits directs) : départage par le
  // produit lui-même.
  if (a.display_order !== b.display_order) return a.display_order - b.display_order;
  const nameCmp = compareNormalizedNames(a.name, b.name);
  if (nameCmp !== 0) return nameCmp;
  return compareOrdinal(a.id, b.id);
}
