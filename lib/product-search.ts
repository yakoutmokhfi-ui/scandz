import type { Lang } from "@/lib/i18n";
import { tName } from "@/lib/menu-i18n";
import type { MenuCategory, MenuItem } from "@/lib/types";

/**
 * RECHERCHE DE PRODUITS DANS LA VITRINE (issue #169, PR #201).
 *
 * Module PUR : aucune lecture réseau, aucun état, aucun accès navigateur.
 * La recherche ne lit QUE les catégories passées en argument -- c'est-à-dire
 * le catalogue public de l'établissement affiché (`restaurant.categories`).
 * Elle ne peut donc ni atteindre un autre établissement ni exposer une donnée
 * que la vitrine n'affiche pas déjà.
 *
 * CONTRAT DE VISIBILITÉ (coordination avec la PR « produits en rupture ») :
 *   - la recherche part des MÊMES listes que la vitrine : une catégorie
 *     publiée, ses produits tels que le service public les a retournés ;
 *   - un produit ARCHIVÉ est toujours exclu ici, quoi qu'il arrive en amont ;
 *   - `is_available` n'est PAS refiltré ici : la décision « un produit
 *     indisponible reste-t-il visible ? » appartient au catalogue public (réglage
 *     par établissement). Si le catalogue retourne un produit en rupture, la
 *     recherche le retrouve et la carte produit l'affiche comme partout ailleurs ;
 *     s'il ne le retourne pas, la recherche ne peut pas le deviner.
 */

/** Sous ce nombre de produits affichés, le champ n'est pas proposé : un menu de
 *  quelques lignes se parcourt plus vite qu'il ne se cherche. */
export const PRODUCT_SEARCH_MIN_ITEMS = 8;

/** Nombre de produits rendus d'un coup ; « Afficher plus » charge la suite. */
export const PRODUCT_SEARCH_PAGE_SIZE = 40;

/** Borne de la saisie utilisée pour la recherche (défense en profondeur). */
export const PRODUCT_SEARCH_MAX_QUERY_LENGTH = 80;

/**
 * Forme de comparaison : minuscules, sans accents ni signes diacritiques
 * (y compris les voyelles brèves arabes), ligatures dépliées, variantes
 * courantes de l'alif / ya / ta marbuta unifiées, tatwil retiré, toute
 * ponctuation (apostrophes droites ou courbes, tirets, guillemets) réduite à
 * un espace.
 */
export function normalizeSearchText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Mots de la requête : tous doivent être trouvés (ET), dans n'importe quel ordre. */
export function productSearchTokens(query: string | null | undefined): string[] {
  const normalized = normalizeSearchText((query ?? "").slice(0, PRODUCT_SEARCH_MAX_QUERY_LENGTH));
  if (normalized === "") return [];
  return [...new Set(normalized.split(" "))];
}

export interface ProductSearchEntry {
  item: MenuItem;
  categoryId: string;
  /** Nom affiché dans la langue active ET nom source, sous forme normalisée. */
  haystack: string;
}

/**
 * Index de recherche d'un catalogue. À recalculer quand le catalogue ou la langue
 * change, jamais à chaque frappe. L'ordre est celui de la vitrine : catégories dans
 * l'ordre reçu, produits dans l'ordre reçu.
 *
 * Le nom source est indexé en plus du nom traduit : un client qui lit la vitrine en
 * arabe et tape le nom français qu'il connaît retrouve quand même le produit.
 */
export function buildProductSearchIndex(
  categories: readonly MenuCategory[],
  lang: Lang,
  sourceLanguage: Lang
): ProductSearchEntry[] {
  const index: ProductSearchEntry[] = [];
  for (const category of categories) {
    if (category.is_active === false) continue;
    for (const item of category.menu_items ?? []) {
      if (item.archived_at) continue;
      index.push({
        item,
        categoryId: category.id,
        haystack: normalizeSearchText(`${tName(item, lang, sourceLanguage)} ${item.name}`),
      });
    }
  }
  return index;
}

export interface ProductSearchGroup {
  category: MenuCategory;
  items: MenuItem[];
}

export interface ProductSearchResult {
  /** Nombre total de produits correspondants (toutes pages confondues). */
  total: number;
  /** Produits rendus (au plus `limit`), regroupés par catégorie, ordre de la vitrine. */
  groups: ProductSearchGroup[];
  shown: number;
}

/**
 * Applique la requête à l'index. Requête vide (ou sans caractère exploitable) :
 * `null`, c'est-à-dire « pas de recherche active », jamais « zéro résultat ».
 */
export function searchProducts(
  categories: readonly MenuCategory[],
  index: readonly ProductSearchEntry[],
  query: string | null | undefined,
  limit: number = PRODUCT_SEARCH_PAGE_SIZE
): ProductSearchResult | null {
  const tokens = productSearchTokens(query);
  if (tokens.length === 0) return null;

  const matching = index.filter((entry) => tokens.every((token) => entry.haystack.includes(token)));
  const kept = matching.slice(0, Math.max(0, limit));

  const byCategory = new Map<string, MenuItem[]>();
  for (const entry of kept) {
    const list = byCategory.get(entry.categoryId);
    if (list) list.push(entry.item);
    else byCategory.set(entry.categoryId, [entry.item]);
  }
  const groups: ProductSearchGroup[] = [];
  for (const category of categories) {
    const items = byCategory.get(category.id);
    if (items) groups.push({ category, items });
  }
  return { total: matching.length, groups, shown: kept.length };
}
