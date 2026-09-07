/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Orchestrateur PUR du modèle de Preview (mandat OB-3, "PREVIEW
 * MODEL") -- combine normalisation, résolution catégorie/
 * sous-catégorie, correspondance produit et validation en un rapport
 * ligne par ligne. AUCUN accès réseau, AUCUNE écriture, AUCUN appel
 * RPC -- "Preview must be a true dry run."
 */

import type { CatalogueCategory } from "@/lib/services/dashboard";
import type { ImportColumn } from "@/lib/catalogue-import/column-mapping";
import {
  classifyType,
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
} from "@/lib/catalogue-import/types";

export interface RawImportRow {
  row: number;
  cells: Partial<Record<ImportColumn, string>>;
}

function normalizeRow(cells: Partial<Record<ImportColumn, string>>): NormalizedRowValues {
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
    type: classifyType(cells["Type"]),
    categoryNameRaw: cells["Catégorie parent"] ?? "",
    subcategoryNameRaw: cells["Sous-catégorie parent"] ?? "",
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

  const productMatches = matchProductsForRows(
    existingCategories,
    normalized.map((r) => ({ row: r.row, productNameRaw: r.values.name, categoryResolution: categoryResolutions.get(r.row)! }))
  );

  const duplicates = detectDuplicateRowsWithinFile(
    normalized.map((r) => ({
      row: r.row,
      categoryNameRaw: r.values.categoryNameRaw,
      productNameRaw: r.values.name,
      categoryResolution: categoryResolutions.get(r.row)!,
    }))
  );

  const rows: PreviewRow[] = normalized.map(({ row, values }) => {
    const categoryResolution = categoryResolutions.get(row)!;
    const subcategoryResolution = subcategoryResolutions.get(row) ?? null;
    const productMatch = productMatches.get(row)!;
    const duplicateOfRow = duplicates.get(row);

    const issues = validateRow({
      values,
      categoryResolution,
      subcategoryResolution,
      productMatch,
      duplicateOfRow,
    });

    const errors = issues.filter((i) => i.severity === "BLOCKING_ERROR");
    const warnings = issues.filter((i) => i.severity === "WARNING");
    const infos = issues.filter((i) => i.severity === "INFO");

    let plannedAction: PreviewRow["plannedAction"];
    if (errors.length > 0) {
      plannedAction = "BLOCKED";
    } else if (productMatch.state === "NEW") {
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
