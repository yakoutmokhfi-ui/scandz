/**
 * Scanym — TRANSLATIONS MANAGEMENT v2.
 * Filtres, tri et regroupement de l'écran de traduction. PUR.
 *
 * ------------------------------------------------------------------
 * RÉUTILISATION, PAS DE SYSTÈME CONCURRENT (mandat §7)
 * ------------------------------------------------------------------
 * Les filtres catalogue (recherche, catégorie, sous-catégorie, tag,
 * disponibilité, tri) ne sont PAS réimplémentés : ce module réutilise
 * `CatalogueFilters`/`EMPTY_FILTERS`/`normalizeForSearch`/`sortProducts`
 * de lib/catalogue-management/filtering.ts et le même
 * `availableFilterOptions`. Le statut de traduction n'est pas
 * recalculé non plus : `getTranslationStatus` reste l'autorité unique
 * (via `rowStatus`).
 *
 * ------------------------------------------------------------------
 * RÈGLE DÉTERMINISTE RETENUE (mandat §8, « choose one and document »)
 * ------------------------------------------------------------------
 * 1. FILTRE DE STATUT : il s'applique à l'ENTITÉ. Une entité est
 *    retenue si AU MOINS UN de ses champs traduisibles visibles porte
 *    le statut choisi (recommandation explicite du mandat). Les autres
 *    champs de cette entité restent affichés : le commerçant traduit
 *    toujours en contexte, et ne peut pas « perdre » un champ parce
 *    qu'un autre champ de la même entité était déjà validé.
 *
 * 2. FILTRES CATALOGUE : une entité est retenue quand elle satisfait
 *    les critères actifs AVEC SES PROPRES attributs.
 *      - catégorie      : la catégorie elle-même, ses sous-catégories
 *                         et ses produits ;
 *      - sous-catégorie : la sous-catégorie elle-même et ses produits ;
 *      - tag / disponibilité : attributs de PRODUIT -- quand l'un de
 *        ces filtres est actif, seuls des produits peuvent être
 *        retenus (une catégorie n'a ni tag ni disponibilité : la
 *        retenir serait arbitraire) ;
 *      - recherche      : nom d'entité, contexte catégorie/
 *        sous-catégorie et TEXTE SOURCE du champ (le commerçant
 *        cherche le plus souvent une phrase à traduire).
 *    Les textes d'établissement et les messages client n'appartiennent
 *    à aucune catégorie : ils n'apparaissent que si AUCUN filtre de
 *    contexte (catégorie, sous-catégorie, tag, disponibilité) n'est
 *    actif -- ils restent soumis à la recherche et au statut.
 *
 * 3. TRI : la HIÉRARCHIE d'affichage (Catégorie > Sous-catégorie >
 *    Produit) est toujours conservée -- c'est elle qui permet au
 *    commerçant de comprendre pourquoi une ligne apparaît (mandat
 *    §15). Le tri choisi s'applique DANS chaque groupe, aux produits,
 *    via `sortProducts`-équivalent sur les lignes. Il ne réordonne
 *    jamais les catégories entre elles.
 */
import {
  normalizeForSearch,
  type CatalogueFilters,
  type SortKey,
  EMPTY_FILTERS,
  DEFAULT_SORT,
} from "@/lib/catalogue-management/filtering";
import { entityKey, rowStatus, type TranslationRow } from "@/lib/translations-management/rows";
import type { TranslationDisplayStatus } from "@/lib/translation-resolver";

export type { CatalogueFilters, SortKey };
export { EMPTY_FILTERS, DEFAULT_SORT };

/** Filtre de statut de traduction, pour la langue cible courante.
 *  "all" = aucun filtre. Les 4 autres valeurs sont EXACTEMENT les
 *  statuts de `getTranslationStatus` -- jamais un vocabulaire
 *  parallèle. */
export type TranslationStatusFilter = "all" | TranslationDisplayStatus;

export interface TranslationFilters extends CatalogueFilters {
  status: TranslationStatusFilter;
}

export const EMPTY_TRANSLATION_FILTERS: TranslationFilters = {
  ...EMPTY_FILTERS,
  status: "all",
};

export function isDefaultTranslationFilters(f: TranslationFilters): boolean {
  return (
    f.search.trim() === "" &&
    f.categoryId === null &&
    f.subcategoryId === null &&
    f.tagId === null &&
    f.available === null &&
    f.status === "all" &&
    f.sort === DEFAULT_SORT
  );
}

/** Un filtre de CONTEXTE est actif (catégorie/sous-catégorie/tag/
 *  disponibilité) : les entités hors catalogue sont alors masquées. */
function hasContextFilter(f: TranslationFilters): boolean {
  return (
    f.categoryId !== null || f.subcategoryId !== null || f.tagId !== null || f.available !== null
  );
}

export function matchesTranslationSearch(row: TranslationRow, needle: string): boolean {
  const q = normalizeForSearch(needle);
  if (q === "") return true;
  return [row.entityLabel, row.categoryName ?? "", row.subcategoryName ?? "", row.sourceText]
    .map(normalizeForSearch)
    .join("   ")
    .includes(q);
}

/** Applique les filtres CATALOGUE (hors statut) à une ligne. */
function matchesCatalogueFilters(row: TranslationRow, f: TranslationFilters): boolean {
  if (!matchesTranslationSearch(row, f.search)) return false;

  const isCatalogueEntity =
    row.entityType === "category" || row.entityType === "subcategory" || row.entityType === "item";
  if (!isCatalogueEntity) {
    // Texte d'établissement / message client : aucun contexte catalogue.
    return !hasContextFilter(f);
  }

  if (f.categoryId !== null && row.categoryId !== f.categoryId) return false;
  if (f.subcategoryId !== null && row.subcategoryId !== f.subcategoryId) return false;

  if (f.tagId !== null) {
    if (row.entityType !== "item") return false;
    if (!row.tagIds.includes(f.tagId)) return false;
  }
  if (f.available !== null) {
    if (row.entityType !== "item") return false;
    if (row.isAvailable !== f.available) return false;
  }
  return true;
}

/**
 * Applique filtres + statut + tri, en conservant la hiérarchie.
 * `lang` est la langue CIBLE courante (celle dont on juge le statut).
 */
export function applyTranslationFilters(
  rows: ReadonlyArray<TranslationRow>,
  filters: TranslationFilters,
  lang: string
): TranslationRow[] {
  const kept = rows.filter((row) => matchesCatalogueFilters(row, filters));

  let afterStatus = kept;
  if (filters.status !== "all") {
    // Règle 1 : filtre par ENTITÉ -- une entité est retenue si l'un de
    // ses champs (parmi ceux retenus ci-dessus) porte le statut choisi.
    const matching = new Set<string>();
    for (const row of kept) {
      if (rowStatus(row, lang) === filters.status) matching.add(entityKey(row));
    }
    afterStatus = kept.filter((row) => matching.has(entityKey(row)));
  }

  return sortTranslationRows(afterStatus, filters.sort);
}

/**
 * Tri STABLE et déterministe conservant la hiérarchie :
 *   1. blocs non catalogue (établissement, messages client) d'abord,
 *      dans leur ordre d'origine ;
 *   2. puis chaque catégorie dans son ordre d'origine (celui de
 *      get_merchant_catalogue), avec : champs de catégorie, puis
 *      sous-catégories, puis produits ;
 *   3. à l'intérieur d'un groupe de produits, le tri choisi ; à
 *      valeur égale, le nom départage -- jamais un ordre dépendant de
 *      l'ordre d'arrivée (même discipline que sortProducts).
 */
export function sortTranslationRows(
  rows: ReadonlyArray<TranslationRow>,
  sort: SortKey
): TranslationRow[] {
  const byName = (a: TranslationRow, b: TranslationRow) =>
    a.entityLabel.localeCompare(b.entityLabel, "fr", { sensitivity: "base" });

  const compareProducts = (a: TranslationRow, b: TranslationRow) => {
    switch (sort) {
      case "name-asc":
        return byName(a, b);
      case "name-desc":
        return byName(b, a);
      case "price-asc":
        return (a.price ?? 0) - (b.price ?? 0) || byName(a, b);
      case "price-desc":
        return (b.price ?? 0) - (a.price ?? 0) || byName(a, b);
      default:
        return byName(a, b);
    }
  };

  // Index d'origine : conserve l'ordre serveur des catégories et des
  // sous-catégories, et l'ordre des champs d'une même entité.
  const order = new Map<TranslationRow, number>();
  rows.forEach((row, i) => order.set(row, i));

  const groupKey = (row: TranslationRow) =>
    `${row.categoryId ?? ""}\u0000${row.subcategoryId ?? ""}\u0000${row.entityType === "item" ? "p" : "h"}`;

  const groups = new Map<string, TranslationRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const out: TranslationRow[] = [];
  for (const bucket of groups.values()) {
    const isProductGroup = bucket[0]?.entityType === "item";
    if (!isProductGroup) {
      out.push(...bucket);
      continue;
    }
    // Les champs d'un MÊME produit restent groupés et dans leur ordre
    // d'origine : le tri porte sur les produits, pas sur les champs.
    const byEntity = new Map<string, TranslationRow[]>();
    for (const row of bucket) {
      const key = entityKey(row);
      const list = byEntity.get(key);
      if (list) list.push(row);
      else byEntity.set(key, [row]);
    }
    const heads = [...byEntity.values()].map((list) => list[0]);
    heads.sort((a, b) => compareProducts(a, b) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
    for (const head of heads) out.push(...(byEntity.get(entityKey(head)) ?? []));
  }
  return out;
}

/** Nombre d'entités DISTINCTES représentées par ces lignes -- le
 *  compteur affiché parle de produits/entités, jamais de champs
 *  (« 12 résultats » doit correspondre à ce que le commerçant voit). */
export function countEntities(rows: ReadonlyArray<TranslationRow>): number {
  return new Set(rows.map(entityKey)).size;
}

/** Répartition des statuts pour la langue cible, par ENTITÉ (même
 *  règle que le filtre) -- alimente les compteurs de l'écran. */
export function statusCounts(
  rows: ReadonlyArray<TranslationRow>,
  lang: string
): Record<TranslationDisplayStatus, number> {
  const seen = new Map<string, Set<TranslationDisplayStatus>>();
  for (const row of rows) {
    const key = entityKey(row);
    const set = seen.get(key) ?? new Set<TranslationDisplayStatus>();
    set.add(rowStatus(row, lang));
    seen.set(key, set);
  }
  const counts: Record<TranslationDisplayStatus, number> = {
    missing: 0,
    to_review: 0,
    validated: 0,
    stale: 0,
  };
  for (const set of seen.values()) {
    for (const status of set) counts[status] += 1;
  }
  return counts;
}

/** Options de filtre réellement disponibles, dérivées des lignes
 *  chargées -- jamais une liste codée en dur. Même forme que
 *  `availableFilterOptions` du catalogue. */
export function availableTranslationFilterOptions(rows: ReadonlyArray<TranslationRow>): {
  categories: { id: string; name: string }[];
  subcategories: { id: string; name: string; categoryId: string }[];
} {
  const categories = new Map<string, string>();
  const subcategories = new Map<string, { name: string; categoryId: string }>();
  for (const row of rows) {
    if (row.categoryId) categories.set(row.categoryId, row.categoryName ?? "");
    if (row.subcategoryId && row.categoryId) {
      subcategories.set(row.subcategoryId, {
        name: row.subcategoryName ?? "",
        categoryId: row.categoryId,
      });
    }
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
  return {
    categories: [...categories].map(([id, name]) => ({ id, name })).sort(byName),
    subcategories: [...subcategories]
      .map(([id, v]) => ({ id, name: v.name, categoryId: v.categoryId }))
      .sort(byName),
  };
}

/** Sous-catégories COHÉRENTES avec la catégorie sélectionnée (mandat
 *  §15 : « When a category filter changes: subcategory choices should
 *  remain coherent with that category »). */
export function coherentSubcategoryOptions(
  options: ReadonlyArray<{ id: string; name: string; categoryId: string }>,
  categoryId: string | null
): { id: string; name: string; categoryId: string }[] {
  return categoryId === null
    ? [...options]
    : options.filter((option) => option.categoryId === categoryId);
}
