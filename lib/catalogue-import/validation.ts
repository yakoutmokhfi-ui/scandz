/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Validation par ligne, PURE. Réutilise EXACTEMENT les bornes déjà
 * publiées et déjà auditées (lib/catalogue-text.ts,
 * lib/catalogue-fiscal.ts, lib/catalogue-import/price-validation.ts)
 * -- "Reuse existing published catalogue read paths and validation
 * contracts... Do not create a conflicting validation contract."
 */

import {
  CATEGORY_NAME_MAX_LENGTH,
  LONG_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  SHORT_DESCRIPTION_MAX_LENGTH,
} from "@/lib/catalogue-text";
import { validateFiscalMeasurementFields } from "@/lib/catalogue-fiscal";
import { isValidProductPrice } from "@/lib/catalogue-import/price-validation";
import type { CategoryResolution, ImportIssue, NormalizedRowValues, ProductMatch, SubcategoryResolution } from "@/lib/catalogue-import/types";

export interface RowValidationInput {
  values: NormalizedRowValues;
  categoryResolution: CategoryResolution;
  subcategoryResolution: SubcategoryResolution | null;
  productMatch: ProductMatch;
  /** Numéro de la ligne d'origine si CETTE ligne est un doublon
   *  intra-fichier (voir resolution.ts, detectDuplicateRowsWithinFile) ;
   *  `undefined` si cette ligne n'est pas un doublon. */
  duplicateOfRow?: number;
}

/** Valide une ligne normalisée et retourne la liste complète de ses
 *  problèmes (tous niveaux confondus -- preview.ts les répartit
 *  ensuite par sévérité). Couvre, au minimum, chaque item listé par
 *  le mandat OB-3 section "VALIDATION". */
export function validateRow(input: RowValidationInput): ImportIssue[] {
  const { values, categoryResolution, subcategoryResolution, productMatch, duplicateOfRow } = input;
  const issues: ImportIssue[] = [];

  // --- Nom du produit ---
  if (values.name === "") {
    issues.push({
      code: "SCANYM_IMPORT_MISSING_PRODUCT_NAME",
      severity: "BLOCKING_ERROR",
      message: "Nom du produit manquant (colonne « Nom »).",
      field: "Nom",
    });
  } else if (values.name.length > PRODUCT_NAME_MAX_LENGTH) {
    issues.push({
      code: "SCANYM_IMPORT_NAME_TOO_LONG",
      severity: "BLOCKING_ERROR",
      message: `Nom du produit trop long (${values.name.length} caractères, maximum ${PRODUCT_NAME_MAX_LENGTH}).`,
      field: "Nom",
    });
  }

  // --- Catégorie / sous-catégorie parent ---
  if (categoryResolution.state === "ERROR") {
    issues.push({
      code: "SCANYM_IMPORT_MISSING_PARENT_CATEGORY",
      severity: "BLOCKING_ERROR",
      message: "Catégorie parent manquante (colonne « Catégorie parent »).",
      field: "Catégorie parent",
    });
  } else if (categoryResolution.state === "AMBIGUOUS") {
    issues.push({
      code: "SCANYM_IMPORT_AMBIGUOUS_CATEGORY",
      severity: "BLOCKING_ERROR",
      message: `Le nom de catégorie « ${categoryResolution.displayName} » correspond à plusieurs catégories existantes distinctes -- résolution automatique refusée.`,
      field: "Catégorie parent",
    });
  } else if (categoryResolution.state === "WOULD_CREATE" && categoryResolution.displayName.length > CATEGORY_NAME_MAX_LENGTH) {
    issues.push({
      code: "SCANYM_IMPORT_CATEGORY_NAME_TOO_LONG",
      severity: "BLOCKING_ERROR",
      message: `Nom de catégorie trop long (${categoryResolution.displayName.length} caractères, maximum ${CATEGORY_NAME_MAX_LENGTH}).`,
      field: "Catégorie parent",
    });
  } else if (categoryResolution.state === "WOULD_CREATE" && categoryResolution.casingConflict) {
    issues.push({
      code: "SCANYM_IMPORT_CATEGORY_CASING_CONFLICT",
      severity: "WARNING",
      message: `Cette catégorie apparaît avec plusieurs casses différentes dans le fichier (${(categoryResolution.casingVariants ?? []).join(", ")}) -- « ${categoryResolution.displayName} » (première occurrence) sera utilisée.`,
      field: "Catégorie parent",
    });
  }

  if (subcategoryResolution) {
    if (subcategoryResolution.state === "ERROR") {
      issues.push({
        code: "SCANYM_IMPORT_SUBCATEGORY_WITHOUT_CATEGORY",
        severity: "BLOCKING_ERROR",
        message: "Sous-catégorie renseignée sans catégorie parent valide.",
        field: "Sous-catégorie parent",
      });
    } else if (subcategoryResolution.state === "AMBIGUOUS") {
      issues.push({
        code: "SCANYM_IMPORT_AMBIGUOUS_SUBCATEGORY",
        severity: "BLOCKING_ERROR",
        message: `Le nom de sous-catégorie « ${subcategoryResolution.displayName} » correspond à plusieurs sous-catégories existantes distinctes -- résolution automatique refusée.`,
        field: "Sous-catégorie parent",
      });
    } else if (subcategoryResolution.state === "WOULD_CREATE" && subcategoryResolution.casingConflict) {
      issues.push({
        code: "SCANYM_IMPORT_SUBCATEGORY_CASING_CONFLICT",
        severity: "WARNING",
        message: `Cette sous-catégorie apparaît avec plusieurs casses différentes dans le fichier (${(subcategoryResolution.casingVariants ?? []).join(", ")}) -- « ${subcategoryResolution.displayName} » (première occurrence) sera utilisée.`,
        field: "Sous-catégorie parent",
      });
    }
  }

  // --- Prix ---
  if (values.price === undefined) {
    issues.push({
      code: "SCANYM_IMPORT_MISSING_PRICE",
      severity: "BLOCKING_ERROR",
      message: "Prix manquant (colonne « Prix TTC (€) »).",
      field: "Prix TTC (€)",
    });
  } else if (values.price === null) {
    issues.push({
      code: "SCANYM_IMPORT_INVALID_PRICE_FORMAT",
      severity: "BLOCKING_ERROR",
      message: "Prix non numérique.",
      field: "Prix TTC (€)",
    });
  } else if (!isValidProductPrice(values.price)) {
    issues.push({
      code: "SCANYM_INVALID_PRICE",
      severity: "BLOCKING_ERROR",
      message: `Prix hors bornes (${values.price} -- attendu entre 0 et 9 999 999, même contrainte que create_product).`,
      field: "Prix TTC (€)",
    });
  }

  // --- TVA / poids (réutilise le contrat serveur EXACT) ---
  const fiscalIssue = validateFiscalMeasurementFields({
    taxRate: values.taxRate === undefined ? null : values.taxRate,
    unitWeightGrams: values.unitWeightGrams === undefined ? null : values.unitWeightGrams,
    weightIsApproximate: values.weightIsApproximate,
  });
  if (values.taxRate === null) {
    issues.push({
      code: "SCANYM_IMPORT_INVALID_TAX_FORMAT",
      severity: "BLOCKING_ERROR",
      message: "TVA non numérique.",
      field: "TVA (%)",
    });
  } else if (fiscalIssue === "SCANYM_INVALID_TAX_RATE") {
    issues.push({
      code: "SCANYM_INVALID_TAX_RATE",
      severity: "BLOCKING_ERROR",
      message: `TVA hors bornes (${values.taxRate}% -- attendu entre 0 et 100).`,
      field: "TVA (%)",
    });
  }
  if (values.unitWeightGrams === null) {
    issues.push({
      code: "SCANYM_IMPORT_INVALID_WEIGHT_FORMAT",
      severity: "BLOCKING_ERROR",
      message: "Poids non numérique ou non entier.",
      field: "Poids (g)",
    });
  } else if (fiscalIssue === "SCANYM_INVALID_WEIGHT_VALUE") {
    issues.push({
      code: "SCANYM_INVALID_WEIGHT_VALUE",
      severity: "BLOCKING_ERROR",
      message: `Poids invalide (${values.unitWeightGrams} g -- doit être strictement positif).`,
      field: "Poids (g)",
    });
  }

  // --- Descriptions ---
  if (values.shortDescription !== null && values.shortDescription.length > SHORT_DESCRIPTION_MAX_LENGTH) {
    issues.push({
      code: "SCANYM_SHORT_DESCRIPTION_TOO_LONG",
      severity: "BLOCKING_ERROR",
      message: `Description courte trop longue (${values.shortDescription.length} caractères, maximum ${SHORT_DESCRIPTION_MAX_LENGTH}).`,
      field: "Description courte",
    });
  }
  if (values.description !== null && values.description.length > LONG_DESCRIPTION_MAX_LENGTH) {
    issues.push({
      code: "SCANYM_DESCRIPTION_TOO_LONG",
      severity: "BLOCKING_ERROR",
      message: `Description longue trop longue (${values.description.length} caractères, maximum ${LONG_DESCRIPTION_MAX_LENGTH}).`,
      field: "Description longue",
    });
  }

  // --- Doublon intra-fichier ---
  if (duplicateOfRow !== undefined) {
    issues.push({
      code: "SCANYM_IMPORT_DUPLICATE_ROW_IN_FILE",
      severity: "BLOCKING_ERROR",
      message: `Doublon dans le fichier : même catégorie + même nom de produit que la ligne ${duplicateOfRow}.`,
    });
  }

  // --- Correspondance produit ambiguë ---
  if (productMatch.state === "AMBIGUOUS_DUPLICATE") {
    issues.push({
      code: "SCANYM_IMPORT_AMBIGUOUS_PRODUCT_MATCH",
      severity: "BLOCKING_ERROR",
      message: "Plusieurs produits existants portent déjà ce nom dans cette catégorie -- résolution automatique refusée.",
      field: "Nom",
    });
  }

  // --- Type (mandat : "Do not guess") ---
  if (values.type.kind === "UNSUPPORTED_DECISION_REQUIRED") {
    issues.push({
      code: "SCANYM_IMPORT_TYPE_UNSUPPORTED",
      severity: "WARNING",
      message: `Valeur « ${values.type.rawValue} » de la colonne « Type » ne correspond à aucune notion actuellement modélisée par Scanym -- décision produit requise, ignorée pour cet import.`,
      field: "Type",
    });
  }

  // --- Tags / Collections (mandat : "UNSUPPORTED IN CURRENT BACKEND") ---
  if (values.tags.length > 0) {
    issues.push({
      code: "SCANYM_IMPORT_TAGS_UNSUPPORTED",
      severity: "INFO",
      message: `${values.tags.length} tag(s)/collection(s) détecté(s) (${values.tags.join(", ")}) -- non pris en charge par le backend actuel, ignoré(s) pour cet import.`,
      field: "Tags / Collections",
    });
  }

  // --- Photo fichier (mandat : parsée mais jamais uploadée) ---
  if (values.photoFilename !== null) {
    issues.push({
      code: "SCANYM_IMPORT_PHOTO_NOT_UPLOADED",
      severity: "INFO",
      message: `Fichier photo référencé (« ${values.photoFilename} ») -- lu mais NON uploadé par cet import (appariement/upload prévus dans un lot séparé, OB-5).`,
      field: "Photo fichier",
    });
  }

  return issues;
}
