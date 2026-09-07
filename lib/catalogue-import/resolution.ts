/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Résolution catégorie/sous-catégorie et correspondance produit,
 * PURE (aucun accès réseau -- reçoit le catalogue déjà lu via
 * getMerchantCatalogue en paramètre, ne l'appelle jamais elle-même).
 * "Never create anything" (mandat) : ce module ne fait AUCUNE
 * écriture, AUCUN appel RPC -- il classe seulement.
 */

import type { CatalogueCategory, CatalogueProduct } from "@/lib/services/dashboard";
import { normalizedKey } from "@/lib/catalogue-import/normalization";
import type { CategoryResolution, ProductMatch, SubcategoryResolution } from "@/lib/catalogue-import/types";

interface CategoryIndexEntry {
  ids: string[];
  displayName: string;
}

/** Index des catégories existantes par clé normalisée -- plusieurs
 *  `category_id` peuvent partager la même clé (voir commentaire
 *  détaillé dans AUTHORIZATION... non, ici : get_merchant_catalogue
 *  ne filtre pas par is_active, une collision réelle entre catégories
 *  existantes reste possible ; c'est exactement le cas AMBIGUOUS). */
function indexCategoriesByKey(categories: CatalogueCategory[]): Map<string, CategoryIndexEntry> {
  const index = new Map<string, CategoryIndexEntry>();
  for (const c of categories) {
    const key = normalizedKey(c.category_name);
    const entry = index.get(key);
    if (entry) {
      entry.ids.push(c.category_id);
    } else {
      index.set(key, { ids: [c.category_id], displayName: c.category_name });
    }
  }
  return index;
}

function indexSubcategoriesByKey(category: CatalogueCategory): Map<string, CategoryIndexEntry> {
  const index = new Map<string, CategoryIndexEntry>();
  for (const s of category.subcategories) {
    const key = normalizedKey(s.subcategory_name);
    const entry = index.get(key);
    if (entry) {
      entry.ids.push(s.subcategory_id);
    } else {
      index.set(key, { ids: [s.subcategory_id], displayName: s.subcategory_name });
    }
  }
  return index;
}

/**
 * Résout TOUTES les catégories référencées par le fichier en une
 * seule passe (nécessaire pour détecter les conflits de casse
 * INTRA-fichier -- mandat "detect ambiguous collisions"). Retourne
 * une résolution par ligne, indexée par numéro de ligne.
 *
 * `rows` : paires (numéro de ligne, nom de catégorie brut) dans
 * l'ordre du fichier -- l'ordre détermine quelle casse "gagne" pour
 * une catégorie WOULD_CREATE référencée avec plusieurs casses
 * différentes (première occurrence, déterministe, documentée).
 */
export function resolveCategoriesForRows(
  existingCategories: CatalogueCategory[],
  rows: ReadonlyArray<{ row: number; categoryNameRaw: string }>
): Map<number, CategoryResolution> {
  const existingIndex = indexCategoriesByKey(existingCategories);
  const result = new Map<number, CategoryResolution>();

  // Première casse rencontrée par clé normalisée, pour les catégories
  // WOULD_CREATE -- et liste de toutes les casses distinctes vues.
  const firstSeenDisplay = new Map<string, string>();
  const allCasingsSeen = new Map<string, Set<string>>();

  for (const { categoryNameRaw } of rows) {
    const trimmed = categoryNameRaw.trim();
    if (trimmed === "") continue;
    const key = normalizedKey(categoryNameRaw);
    if (!firstSeenDisplay.has(key)) firstSeenDisplay.set(key, trimmed);
    if (!allCasingsSeen.has(key)) allCasingsSeen.set(key, new Set());
    allCasingsSeen.get(key)!.add(trimmed);
  }

  for (const { row, categoryNameRaw } of rows) {
    const trimmed = categoryNameRaw.trim();
    if (trimmed === "") {
      result.set(row, { state: "ERROR", displayName: "" });
      continue;
    }
    const key = normalizedKey(categoryNameRaw);
    const existing = existingIndex.get(key);
    if (existing && existing.ids.length === 1) {
      result.set(row, { state: "EXISTING", displayName: existing.displayName, existingId: existing.ids[0] });
      continue;
    }
    if (existing && existing.ids.length > 1) {
      result.set(row, { state: "AMBIGUOUS", displayName: existing.displayName, ambiguousIds: existing.ids });
      continue;
    }
    const casings = allCasingsSeen.get(key)!;
    result.set(row, {
      state: "WOULD_CREATE",
      displayName: firstSeenDisplay.get(key)!,
      casingConflict: casings.size > 1,
      casingVariants: casings.size > 1 ? Array.from(casings) : undefined,
    });
  }

  return result;
}

/**
 * Résout les sous-catégories, ligne par ligne, en fonction de la
 * résolution de catégorie DÉJÀ calculée pour cette ligne (une
 * sous-catégorie ne peut jamais être résolue "EXISTING" sous une
 * catégorie qui n'existe pas encore -- cascade déterministe).
 * `subcategoryNameRaw` vide -> pas de sous-catégorie pour cette ligne
 * (`null`, jamais une erreur : la sous-catégorie est optionnelle).
 */
export function resolveSubcategoriesForRows(
  existingCategories: CatalogueCategory[],
  rows: ReadonlyArray<{
    row: number;
    categoryNameRaw: string;
    subcategoryNameRaw: string;
    categoryResolution: CategoryResolution;
  }>
): Map<number, SubcategoryResolution | null> {
  const result = new Map<number, SubcategoryResolution | null>();

  // Index sous-catégorie existante par (category_id existant, clé).
  const subIndexByCategory = new Map<string, Map<string, CategoryIndexEntry>>();
  for (const c of existingCategories) {
    subIndexByCategory.set(c.category_id, indexSubcategoriesByKey(c));
  }

  // Première casse / toutes les casses vues, par (clé catégorie
  // normalisée, clé sous-catégorie normalisée) -- portée à la
  // catégorie pour ne jamais confondre deux sous-catégories de nom
  // identique dans des catégories différentes.
  const firstSeenDisplay = new Map<string, string>();
  const allCasingsSeen = new Map<string, Set<string>>();
  const scopeKey = (catKey: string, subKey: string) => `${catKey}\0${subKey}`;

  for (const { categoryNameRaw, subcategoryNameRaw } of rows) {
    const subTrimmed = subcategoryNameRaw.trim();
    if (subTrimmed === "") continue;
    const catKey = normalizedKey(categoryNameRaw);
    const subKey = normalizedKey(subcategoryNameRaw);
    const scoped = scopeKey(catKey, subKey);
    if (!firstSeenDisplay.has(scoped)) firstSeenDisplay.set(scoped, subTrimmed);
    if (!allCasingsSeen.has(scoped)) allCasingsSeen.set(scoped, new Set());
    allCasingsSeen.get(scoped)!.add(subTrimmed);
  }

  for (const { row, categoryNameRaw, subcategoryNameRaw, categoryResolution } of rows) {
    const subTrimmed = subcategoryNameRaw.trim();
    if (subTrimmed === "") {
      result.set(row, null);
      continue;
    }
    // Sous-catégorie sans catégorie exploitable (mandat : "Reject
    // rows where 'Sous-catégorie parent' is present but 'Catégorie
    // parent' is empty or mismatched") -- cascade : toute catégorie
    // ERROR ou AMBIGUOUS rend la sous-catégorie elle-même ERROR
    // (impossible de la rattacher sans savoir à quelle catégorie).
    if (categoryResolution.state === "ERROR" || categoryResolution.state === "AMBIGUOUS") {
      result.set(row, { state: "ERROR", displayName: subTrimmed });
      continue;
    }

    const catKey = normalizedKey(categoryNameRaw);
    const subKey = normalizedKey(subcategoryNameRaw);

    if (categoryResolution.state === "EXISTING" && categoryResolution.existingId) {
      const subIndex = subIndexByCategory.get(categoryResolution.existingId);
      const existing = subIndex?.get(subKey);
      if (existing && existing.ids.length === 1) {
        result.set(row, { state: "EXISTING", displayName: existing.displayName, existingId: existing.ids[0] });
        continue;
      }
      if (existing && existing.ids.length > 1) {
        result.set(row, { state: "AMBIGUOUS", displayName: existing.displayName, ambiguousIds: existing.ids });
        continue;
      }
    }

    // Catégorie WOULD_CREATE, ou catégorie EXISTING sans cette
    // sous-catégorie : la sous-catégorie sera créée (mandat : "show
    // values that WOULD CREATE later").
    const scoped = scopeKey(catKey, subKey);
    const casings = allCasingsSeen.get(scoped)!;
    result.set(row, {
      state: "WOULD_CREATE",
      displayName: firstSeenDisplay.get(scoped)!,
      casingConflict: casings.size > 1,
      casingVariants: casings.size > 1 ? Array.from(casings) : undefined,
    });
  }

  return result;
}

interface ProductIndexEntry {
  ids: string[];
  product: CatalogueProduct;
}

/** Tous les produits existants d'une catégorie (directs + dans
 *  chacune de ses sous-catégories), indexés par nom normalisé --
 *  mandat : clé "restaurant + category + normalized product name",
 *  SANS la sous-catégorie (portée volontairement à la catégorie
 *  entière, exactement comme demandé). */
function indexProductsByCategory(categories: CatalogueCategory[]): Map<string, Map<string, ProductIndexEntry>> {
  const byCategory = new Map<string, Map<string, ProductIndexEntry>>();
  for (const c of categories) {
    const index = new Map<string, ProductIndexEntry>();
    const allProducts: CatalogueProduct[] = [
      ...c.products,
      ...c.subcategories.flatMap((s) => s.products),
    ];
    for (const p of allProducts) {
      const key = normalizedKey(p.name);
      const entry = index.get(key);
      if (entry) entry.ids.push(p.product_id);
      else index.set(key, { ids: [p.product_id], product: p });
    }
    byCategory.set(c.category_id, index);
  }
  return byCategory;
}

/**
 * Correspondance produit, ligne par ligne. Pour une catégorie encore
 * WOULD_CREATE (n'existe pas encore), AUCUN produit existant ne peut
 * s'y trouver -- toujours NEW (sauf duplicat intra-fichier, détecté
 * séparément par `detectDuplicateRowsWithinFile`).
 */
export function matchProductsForRows(
  existingCategories: CatalogueCategory[],
  rows: ReadonlyArray<{ row: number; productNameRaw: string; categoryResolution: CategoryResolution }>
): Map<number, ProductMatch> {
  const byCategory = indexProductsByCategory(existingCategories);
  const result = new Map<number, ProductMatch>();

  for (const { row, productNameRaw, categoryResolution } of rows) {
    if (categoryResolution.state !== "EXISTING" || !categoryResolution.existingId) {
      result.set(row, { state: "NEW" });
      continue;
    }
    const index = byCategory.get(categoryResolution.existingId);
    const key = normalizedKey(productNameRaw);
    const existing = index?.get(key);
    if (!existing) {
      result.set(row, { state: "NEW" });
    } else if (existing.ids.length === 1) {
      result.set(row, { state: "EXISTING_MATCH", existingId: existing.ids[0] });
    } else {
      result.set(row, { state: "AMBIGUOUS_DUPLICATE", ambiguousIds: existing.ids });
    }
  }

  return result;
}

/** Le produit existant matché pour une ligne EXISTING_MATCH -- utilisé
 *  par preview.ts pour décider CREATE/UPDATE/SKIP (comparaison de
 *  valeurs). Recherche directe par id, pas une seconde passe d'index. */
export function findExistingProductById(
  existingCategories: CatalogueCategory[],
  productId: string
): CatalogueProduct | undefined {
  for (const c of existingCategories) {
    for (const p of c.products) if (p.product_id === productId) return p;
    for (const s of c.subcategories) for (const p of s.products) if (p.product_id === productId) return p;
  }
  return undefined;
}

/**
 * Doublons INTRA-fichier (mandat : "duplicate rows inside the
 * uploaded file"). Clé = (clé catégorie résolue -- existingId si
 * EXISTING/AMBIGUOUS, sinon la clé normalisée textuelle pour
 * WOULD_CREATE/ERROR -- + clé produit normalisée). Retourne, pour
 * chaque ligne EN DOUBLON (2e occurrence et suivantes), le numéro de
 * la ligne d'origine (la toute première occurrence, jamais
 * elle-même signalée comme doublon).
 */
export function detectDuplicateRowsWithinFile(
  rows: ReadonlyArray<{ row: number; categoryNameRaw: string; productNameRaw: string; categoryResolution: CategoryResolution }>
): Map<number, number> {
  const firstSeenRow = new Map<string, number>();
  const duplicates = new Map<number, number>();

  for (const { row, categoryNameRaw, productNameRaw, categoryResolution } of rows) {
    const catPart =
      categoryResolution.state === "EXISTING" || categoryResolution.state === "AMBIGUOUS"
        ? categoryResolution.existingId ?? (categoryResolution.ambiguousIds ?? []).join(",")
        : `new:${normalizedKey(categoryNameRaw)}`;
    const key = `${catPart}\0${normalizedKey(productNameRaw)}`;
    const first = firstSeenRow.get(key);
    if (first === undefined) {
      firstSeenRow.set(key, row);
    } else {
      duplicates.set(row, first);
    }
  }

  return duplicates;
}
