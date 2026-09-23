import type { MenuItem, Translations } from "@/lib/types";

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
  /** TRANSLATIONS MANAGEMENT v2 -- hash source et traductions DU NOM
   *  de la sous-catégorie, portés par le groupe pour que l'affichage
   *  (sous-titre et pilule de filtre) puisse résoudre l'intitulé dans
   *  la langue du client via `tSubcategoryName`. Ce module NE RÉSOUT
   *  RIEN lui-même : il reste pur et indépendant de la langue, comme
   *  avant ce lot. `null` pour le groupe "direct" et pour une base non
   *  encore migrée. */
  subcategoryNameHash?: string | null;
  subcategoryTranslations?: Translations | null;
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
        subcategoryNameHash: subcategoryId ? (item.subcategory_name_hash ?? null) : null,
        subcategoryTranslations: subcategoryId ? (item.subcategory_translations ?? null) : null,
        items: [item],
      });
    }
  }
  return groups;
}

// ======================================================================
// CUSTOMER MENU / SUBCATEGORY FILTER NAVIGATION v1 -- logique PURE de
// sélection pour la barre de filtre de components/SubcategoryFilter.tsx,
// consommée par components/MenuView.tsx. Séparée ici (plutôt que
// laissée inline dans le composant React) pour rester testable sans
// rendu DOM, à l'image de groupMenuItemsBySubcategory ci-dessus.
//
// Ces deux fonctions NE recalculent AUCUN ordre ni AUCUN filtre de
// disponibilité -- elles font entièrement confiance aux groupes déjà
// produits par groupMenuItemsBySubcategory (déjà : uniquement des
// groupes avec >= 1 produit visible, déjà dans l'ordre d'affichage
// public). Une sous-catégorie qui n'a plus aucun produit visible
// (archivé/indisponible) n'apparaît donc déjà plus dans `groups` --
// jamais une pilule de filtre vide.
// ======================================================================

export interface SubcategoryFilterOption {
  id: string;
  name: string;
}

/** TRANSLATIONS MANAGEMENT v2 -- traduit l'intitulé des options de
 *  filtre déjà dérivées, SANS changer leur nombre, leur ordre ni leur
 *  identité : la sélection reste faite sur `id`, jamais sur le libellé
 *  affiché. Une sous-catégorie sans traduction valide garde son nom
 *  source (contrat de repli inchangé). */
export function translateSubcategoryFilterOptions(
  options: readonly SubcategoryFilterOption[],
  groups: readonly MenuItemGroup[],
  translate: (group: MenuItemGroup) => string
): SubcategoryFilterOption[] {
  const byId = new Map(groups.filter((g) => g.subcategoryId).map((g) => [g.subcategoryId as string, g]));
  return options.map((option) => {
    const group = byId.get(option.id);
    return group ? { ...option, name: translate(group) || option.name } : option;
  });
}

/**
 * Options de la barre de filtre : une entrée par groupe de
 * sous-catégorie RÉELLE (subcategoryId non nul). Le groupe "direct"
 * (subcategoryId === null) n'a JAMAIS de pilule dédiée -- il est
 * représenté par le pseudo-onglet "Tous" (voir
 * filterMenuItemGroupsBySubcategory ci-dessous), qui n'existe qu'en UI
 * et ne correspond à aucune sous-catégorie en base.
 */
export function deriveSubcategoryFilterOptions(
  groups: readonly MenuItemGroup[]
): SubcategoryFilterOption[] {
  return groups
    .filter((group) => group.subcategoryId !== null)
    .map((group) => ({
      id: group.subcategoryId as string,
      name: group.subcategoryName ?? "",
    }));
}

/**
 * Applique le filtre de sous-catégorie sélectionné aux groupes de la
 * catégorie active.
 *
 * `activeSubcategoryId === null` ("Tous") : TOUS les groupes, y
 * compris le groupe "direct" -- mandat, littéral : "Products with
 * subcategory_id = null [...] must remain visible under 'Tous'".
 *
 * `activeSubcategoryId` précis : UNIQUEMENT le groupe dont
 * `subcategoryId` correspond exactement -- jamais le groupe "direct"
 * (mandat, littéral : "must NOT appear under a specific subcategory
 * filter"), et jamais une autre sous-catégorie.
 */
export function filterMenuItemGroupsBySubcategory(
  groups: readonly MenuItemGroup[],
  activeSubcategoryId: string | null
): MenuItemGroup[] {
  if (activeSubcategoryId === null) {
    return [...groups];
  }
  return groups.filter((group) => group.subcategoryId === activeSubcategoryId);
}

// ======================================================================
// LOT 02 -- STICKY SUBCATEGORIES. Logique PURE décidant si la barre de
// filtre de sous-catégories doit rester accessible (position sticky)
// pendant le défilement du catalogue, et de combien corriger le
// défilement pour qu'un élément focalisé ne soit jamais masqué par
// elle. Aucune API navigateur ici : les mesures (hauteur de la liste,
// hauteur du viewport) sont fournies par l'appelant -- testable sans
// rendu DOM.
// ======================================================================

/**
 * Vrai UNIQUEMENT si (a) la catégorie active possède PLUSIEURS
 * sous-catégories réelles (>= 2 pilules hors "Tous" : avec une seule,
 * la barre n'offre aucun vrai choix à garder sous la main) ET (b) la
 * liste NON filtrée ("Tous") de la catégorie est plus haute que le
 * viewport -- le client doit réellement défiler pour la parcourir, et
 * la barre quitterait l'écran sans sticky.
 *
 * Aucun seuil en nombre de produits (décision CIO, cycle 4) : quelques
 * grandes cartes peuvent justifier le sticky, beaucoup de petites
 * cartes tenant sur un écran non. Hauteur mesurée sur la liste NON
 * filtrée : choisir une sous-catégorie ne fait jamais basculer la
 * barre entre sticky et non-sticky (aucun saut de mise en page au
 * moment du clic).
 */
export function shouldStickSubcategoryFilter({
  subcategoryCount,
  catalogueHeight,
  viewportHeight,
}: {
  subcategoryCount: number;
  catalogueHeight: number;
  viewportHeight: number;
}): boolean {
  if (subcategoryCount < 2) return false;
  if (!(viewportHeight > 0)) return false;
  return catalogueHeight > viewportHeight;
}

/** Marge (px) conservée entre le bas de la barre sticky et un élément
 *  focalisé ramené sous elle. */
export const STICKY_FOCUS_GAP_PX = 8;

/**
 * Décalage vertical (px, <= 0) à appliquer via window.scrollBy pour
 * qu'un élément focalisé dont le bord supérieur est `targetTop` ne
 * soit pas masqué par une barre sticky dont le bord inférieur est
 * `stickyBottom` (coordonnées viewport). 0 si l'élément est déjà
 * entièrement sous la barre.
 */
export function stickyFocusScrollDelta(targetTop: number, stickyBottom: number): number {
  if (targetTop >= stickyBottom) return 0;
  return targetTop - stickyBottom - STICKY_FOCUS_GAP_PX;
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
