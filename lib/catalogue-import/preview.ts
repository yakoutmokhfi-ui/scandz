/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * CATEGORY / SUBCATEGORY ROW SUPPORT v1 (remédiation ciblée).
 * Orchestrateur PUR du modèle de Preview (mandat OB-3, "PREVIEW
 * MODEL") -- combine normalisation, résolution catégorie/
 * sous-catégorie, correspondance produit et validation en un rapport
 * ligne par ligne. AUCUN accès réseau, AUCUNE écriture, AUCUN appel
 * RPC -- "Preview must be a true dry run."
 *
 * ROW-TYPE-AWARE (ce lot) : "Type" détermine désormais QUEL nom
 * (« Nom » lui-même, ou « Catégorie parent »/« Sous-catégorie
 * parent ») alimente `resolveCategoriesForRows`/
 * `resolveSubcategoriesForRows` (resolution.ts, INCHANGÉ -- ces
 * fonctions restent des résolveurs génériques "ce nom, pour cette
 * ligne", agnostiques de la RAISON pour laquelle une ligne référence
 * un nom donné) :
 *   - ligne CATEGORY  : categoryNameRaw    = Nom (la ligne SE déclare
 *                                            elle-même) ; subcategoryNameRaw = "".
 *   - ligne SUBCATEGORY : categoryNameRaw = Catégorie parent (le
 *                                            parent déclaré) ;
 *                         subcategoryNameRaw = Nom (la ligne SE
 *                                            déclare elle-même).
 *   - ligne PRODUCT/UNKNOWN : INCHANGÉ -- categoryNameRaw = Catégorie
 *                             parent, subcategoryNameRaw = Sous-
 *                             catégorie parent.
 * Cette seule réaffectation permet à `buildCommitPlan`
 * (commit-plan.ts, INCHANGÉ) de dédupliquer AUTOMATIQUEMENT une
 * catégorie référencée à la fois par une ligne CATEGORY explicite et
 * par une ligne PRODUCT/SUBCATEGORY du même fichier (mandat, section 7
 * "SAME-FILE DEPENDENCIES" / section 8 "IMPORT ORDER") -- sans AUCUNE
 * modification de resolution.ts ni commit-plan.ts.
 */

import type { CatalogueCategory } from "@/lib/services/dashboard";
import type { ImportColumn } from "@/lib/catalogue-import/column-mapping";
import {
  classifyRowType,
  coerceInteger,
  coerceNumeric,
  normalizedKey,
  splitTagsColumn,
} from "@/lib/catalogue-import/normalization";
import { normalizeText } from "@/lib/catalogue-text";
import {
  detectDuplicateRowsWithinFile,
  findExistingProductById,
  matchProductsForRows,
  resolveCategoriesForRows,
  resolveSubcategoriesForRows,
} from "@/lib/catalogue-import/resolution";
import { validateRow } from "@/lib/catalogue-import/validation";
import type {
  ImportIssue,
  NormalizedRowValues,
  PreviewFileEligibility,
  PreviewReport,
  PreviewRow,
  ProductMatch,
  RowType,
} from "@/lib/catalogue-import/types";

export interface RawImportRow {
  row: number;
  cells: Partial<Record<ImportColumn, string>>;
}

function normalizeRow(cells: Partial<Record<ImportColumn, string>>): NormalizedRowValues {
  const type = classifyRowType(cells["Type"]);
  const name = normalizeText(cells["Nom"] ?? "", Number.POSITIVE_INFINITY).value;
  const shortDescriptionRaw = cells["Description courte"];
  const descriptionRaw = cells["Description longue"];
  const shortDescription =
    shortDescriptionRaw === undefined ? null : normalizeText(shortDescriptionRaw, Number.POSITIVE_INFINITY).value || null;
  const description =
    descriptionRaw === undefined ? null : normalizeText(descriptionRaw, Number.POSITIVE_INFINITY).value || null;

  const price = cells["Prix TTC (€)"] === undefined ? undefined : coerceNumeric(cells["Prix TTC (€)"]!);
  const taxRate = cells["TVA (%)"] === undefined ? undefined : coerceNumeric(cells["TVA (%)"]!);
  const unitWeightGrams = cells["Poids (g)"] === undefined ? undefined : coerceInteger(cells["Poids (g)"]!);

  const photoRaw = cells["Photo fichier"];
  const photoFilename = photoRaw === undefined ? null : normalizeText(photoRaw, Number.POSITIVE_INFINITY).value || null;

  // CATEGORY / SUBCATEGORY ROW SUPPORT v1 -- le nom à RÉSOUDRE en tant
  // que catégorie/sous-catégorie dépend du type de ligne (voir
  // commentaire d'en-tête). resolution.ts (INCHANGÉ) ne voit jamais la
  // différence : il résout toujours "ce nom, pour cette ligne".
  let categoryNameRaw: string;
  let subcategoryNameRaw: string;
  if (type.kind === "CATEGORY") {
    categoryNameRaw = name;
    subcategoryNameRaw = "";
  } else if (type.kind === "SUBCATEGORY") {
    categoryNameRaw = cells["Catégorie parent"] ?? "";
    subcategoryNameRaw = name;
  } else {
    // PRODUCT (explicite ou implicite) et UNKNOWN (filet de sécurité --
    // tant qu'on ignore la nature réelle de la ligne, on continue de la
    // résoudre comme un produit ; elle sera de toute façon bloquée
    // d'office par validateRow pour "Type" inconnu).
    categoryNameRaw = cells["Catégorie parent"] ?? "";
    subcategoryNameRaw = cells["Sous-catégorie parent"] ?? "";
  }

  return {
    name,
    shortDescription,
    description,
    price,
    taxRate,
    unitWeightGrams,
    // Mandat : aucune colonne source pour weight_is_approximate --
    // valeur fixe `false` documentée (IMPORT-CONTRACT.md), jamais une
    // heuristique par ligne (même décision que le gap-analysis OB-2
    // préparatoire, §2).
    weightIsApproximate: false,
    tags: splitTagsColumn(cells["Tags / Collections"]),
    type,
    categoryNameRaw,
    subcategoryNameRaw,
    photoFilename,
  };
}

/** Compare une ligne normalisée à un produit EXISTANT déjà matché
 *  pour décider CREATE / UPDATE / SKIP : SKIP si TOUTES les valeurs
 *  seraient identiques après import (aucune écriture utile), UPDATE
 *  sinon -- décision déterministe documentée (IMPORT-CONTRACT.md),
 *  jamais un no-op silencieusement classé UPDATE. */
function valuesEqualExisting(
  values: NormalizedRowValues,
  existing: { price: number; short_description: string | null; description: string | null; tax_rate: number | null; unit_weight_grams: number | null; weight_is_approximate: boolean }
): boolean {
  const priceEqual =
    values.price !== undefined && values.price !== null && Math.round(values.price * 100) === Math.round(existing.price * 100);
  const shortDescEqual = (values.shortDescription ?? null) === (existing.short_description ?? null);
  const descEqual = (values.description ?? null) === (existing.description ?? null);
  const taxEqual = (values.taxRate === undefined ? null : values.taxRate) === existing.tax_rate;
  const weightEqual = (values.unitWeightGrams === undefined ? null : values.unitWeightGrams) === existing.unit_weight_grams;
  return priceEqual && shortDescEqual && descEqual && taxEqual && weightEqual;
}

/**
 * Construit le rapport de Preview complet à partir des lignes brutes
 * déjà extraites (fichier déjà lu, en-têtes déjà résolus -- voir
 * lib/services/catalogue-import.ts pour l'orchestration impure
 * amont) et du catalogue EXISTANT du restaurant explicitement
 * sélectionné (déjà lu via getMerchantCatalogue, jamais interrogé par
 * ce module lui-même).
 */
export function buildPreviewReport(
  rawRows: RawImportRow[],
  existingCategories: CatalogueCategory[],
  columnMapWarnings: ImportIssue[]
): PreviewReport {
  const normalized = rawRows.map((r) => ({ row: r.row, values: normalizeRow(r.cells) }));

  // Résolution catégorie/sous-catégorie -- TOUTES les lignes, quel que
  // soit leur type (voir commentaire d'en-tête : categoryNameRaw/
  // subcategoryNameRaw portent déjà la bonne signification par type).
  const categoryResolutions = resolveCategoriesForRows(
    existingCategories,
    normalized.map((r) => ({ row: r.row, categoryNameRaw: r.values.categoryNameRaw }))
  );

  const subcategoryResolutions = resolveSubcategoriesForRows(
    existingCategories,
    normalized.map((r) => ({
      row: r.row,
      categoryNameRaw: r.values.categoryNameRaw,
      subcategoryNameRaw: r.values.subcategoryNameRaw,
      categoryResolution: categoryResolutions.get(r.row)!,
    }))
  );

  // mandat section 4 ("resolve parent category from either: A. an
  // existing merchant category; or B. a CATEGORY row in the same
  // import") -- clés normalisées de TOUTE ligne CATEGORY explicite non
  // vide de ce fichier, pour distinguer, pour une ligne SUBCATEGORY,
  // une catégorie parent WOULD_CREATE explicitement déclarée (option B)
  // d'une catégorie WOULD_CREATE seulement par la référence implicite
  // d'une AUTRE ligne (ex. Produit) -- cette dernière reste bloquante
  // pour la ligne SUBCATEGORY (voir validation.ts,
  // subcategoryParentResolvable).
  const explicitCategoryKeys = new Set<string>();
  for (const { values } of normalized) {
    if (values.type.kind === "CATEGORY" && values.name.trim() !== "") {
      explicitCategoryKeys.add(normalizedKey(values.name));
    }
  }
  function isSubcategoryParentResolvable(row: number): boolean {
    const res = categoryResolutions.get(row)!;
    if (res.state === "EXISTING") return true;
    if (res.state !== "WOULD_CREATE") return false; // ERROR / AMBIGUOUS -- déjà signalés séparément
    const values = normalized.find((r) => r.row === row)!.values;
    return explicitCategoryKeys.has(normalizedKey(values.categoryNameRaw));
  }

  // Correspondance produit / doublons intra-fichier -- UNIQUEMENT les
  // lignes PRODUCT (explicite ou implicite) et UNKNOWN (filet de
  // sécurité, comportement produit par défaut) : une ligne CATEGORY ou
  // SUBCATEGORY ne "correspond" jamais à un produit existant et ne
  // participe jamais à la détection de doublon PRODUIT (mandat : "do
  // NOT create a product" -- ces concepts n'ont simplement aucun sens
  // pour une ligne structurelle).
  const productLikeRows = normalized.filter((r) => r.values.type.kind !== "CATEGORY" && r.values.type.kind !== "SUBCATEGORY");

  const productMatches = matchProductsForRows(
    existingCategories,
    productLikeRows.map((r) => ({ row: r.row, productNameRaw: r.values.name, categoryResolution: categoryResolutions.get(r.row)! }))
  );

  const duplicates = detectDuplicateRowsWithinFile(
    productLikeRows.map((r) => ({
      row: r.row,
      categoryNameRaw: r.values.categoryNameRaw,
      productNameRaw: r.values.name,
      categoryResolution: categoryResolutions.get(r.row)!,
    }))
  );

  const DEFAULT_PRODUCT_MATCH: ProductMatch = { state: "NEW" };

  const rows: PreviewRow[] = normalized.map(({ row, values }) => {
    const categoryResolution = categoryResolutions.get(row)!;
    const subcategoryResolution = subcategoryResolutions.get(row) ?? null;
    const productMatch = productMatches.get(row) ?? DEFAULT_PRODUCT_MATCH;
    const duplicateOfRow = duplicates.get(row);
    const rowType: RowType = values.type.kind;

    const issues = validateRow({
      values,
      categoryResolution,
      subcategoryResolution,
      productMatch,
      duplicateOfRow,
      subcategoryParentResolvable: rowType === "SUBCATEGORY" ? isSubcategoryParentResolvable(row) : undefined,
    });

    const errors = issues.filter((i) => i.severity === "BLOCKING_ERROR");
    const warnings = issues.filter((i) => i.severity === "WARNING");
    const infos = issues.filter((i) => i.severity === "INFO");

    let plannedAction: PreviewRow["plannedAction"];
    if (errors.length > 0) {
      plannedAction = "BLOCKED";
    } else if (rowType === "CATEGORY") {
      // mandat section 3 : "Créer la catégorie" si elle n'existe pas
      // encore, réutilisée (aucune écriture) si elle existe déjà --
      // jamais UPDATE (l'import ne modifie jamais une catégorie
      // existante, seulement sa création/réutilisation).
      plannedAction = categoryResolution.state === "EXISTING" ? "SKIP" : "CREATE";
    } else if (rowType === "SUBCATEGORY") {
      plannedAction = subcategoryResolution?.state === "EXISTING" ? "SKIP" : "CREATE";
    } else if (productMatch.state === "NEW") {
      // PRODUCT (explicite ou implicite) -- comportement INCHANGÉ.
      plannedAction = "CREATE";
    } else if (productMatch.state === "EXISTING_MATCH" && productMatch.existingId) {
      const existing = findExistingProductById(existingCategories, productMatch.existingId);
      plannedAction = existing && valuesEqualExisting(values, existing) ? "SKIP" : "UPDATE";
    } else {
      // AMBIGUOUS_DUPLICATE sans erreur bloquante ne devrait jamais
      // se produire (validateRow émet toujours SCANYM_IMPORT_
      // AMBIGUOUS_PRODUCT_MATCH pour cet état) -- filet de sécurité
      // déterministe, jamais une action ambiguë silencieuse.
      plannedAction = "BLOCKED";
    }

    const status: PreviewRow["status"] = errors.length > 0 ? "BLOCKED" : warnings.length > 0 ? "WARNING" : "OK";

    return {
      row,
      status,
      errors,
      warnings,
      infos,
      resolvedCategory: categoryResolution,
      resolvedSubcategory: subcategoryResolution,
      normalizedValues: values,
      photoFilename: values.photoFilename,
      productMatch,
      rowType,
      plannedAction,
    };
  });

  const blockedRows = rows.filter((r) => r.status === "BLOCKED").length;
  const warningRows = rows.filter((r) => r.status === "WARNING").length;
  const okRows = rows.filter((r) => r.status === "OK").length;

  let eligibility: PreviewFileEligibility;
  if (rows.length === 0 || blockedRows > 0) eligibility = "NOT_ELIGIBLE";
  else if (warningRows > 0) eligibility = "ELIGIBLE_WITH_WARNINGS";
  else eligibility = "ELIGIBLE";

  return {
    rows,
    eligibility,
    totalRows: rows.length,
    blockedRows,
    warningRows,
    okRows,
    columnMapWarnings,
  };
}

export { normalizedKey };
