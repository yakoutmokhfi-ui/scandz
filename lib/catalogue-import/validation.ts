/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * CATEGORY / SUBCATEGORY ROW SUPPORT v1 (remédiation ciblée) -- voir
 * lib/catalogue-import/normalization.ts pour la classification
 * `classifyRowType` (autoritaire depuis ce lot, plus informative).
 *
 * Validation par ligne, PURE, désormais SENSIBLE AU TYPE DE LIGNE
 * (mandat : "ROW-TYPE-AWARE VALIDATION" / "The authoritative import
 * parser / validation layer must understand the row type. Do not
 * implement this as fragile UI-only logic.") -- une ligne CATEGORY ou
 * SUBCATEGORY n'est PLUS jamais validée avec les règles produit (Prix
 * TTC, TVA, correspondance produit, doublon produit) : c'était
 * exactement le bug corrigé par ce lot ("Prix manquant"/"TVA absente"
 * affichés à tort sur des lignes structurelles).
 *
 * Matrice de validation (mandat, section 6), implémentée ci-dessous
 * par TROIS fonctions dédiées, une par type de ligne connu :
 *
 *   | Champ                  | Catégorie | Sous-catégorie | Produit |
 *   |-------------------------|-----------|-----------------|---------|
 *   | Type                    | requis    | requis          | requis  |
 *   | Nom                     | requis    | requis          | requis  |
 *   | Catégorie parent        | non       | requis          | selon schéma produit |
 *   | Sous-catégorie parent   | non       | non             | optionnel/selon schéma |
 *   | Prix TTC                | non       | non             | requis  |
 *   | TVA                     | non       | non             | règle produit |
 *   | Photo                   | non       | non             | règle produit |
 *   | Disponibilité           | s/o       | s/o             | règle produit |
 *
 * "Type" lui-même reste validé une seule fois, EN AMONT des trois
 * fonctions (une valeur UNKNOWN bloque la ligne AVANT toute tentative
 * de validation plus fine -- impossible de savoir quel schéma
 * appliquer, mandat "Unknown Type: BLOCK the row with a clear
 * diagnostic" / "Do not silently interpret unknown Type values").
 *
 * PRODUIT : comportement à l'IDENTIQUE de la version précédente de ce
 * fichier -- AUCUN champ, AUCUNE borne, AUCUN message n'a changé pour
 * les lignes Produit (mandat : "Do NOT weaken current product
 * validation merely to fix category rows.").
 */

import {
  CATEGORY_NAME_MAX_LENGTH,
  LONG_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  SHORT_DESCRIPTION_MAX_LENGTH,
} from "@/lib/catalogue-text";
import { validateFiscalMeasurementFields } from "@/lib/catalogue-fiscal";
import { isValidProductPrice } from "@/lib/catalogue-import/price-validation";
import type { TagResolution } from "@/lib/catalogue-import/tag-resolution";
import type { CategoryResolution, ImportIssue, NormalizedRowValues, ProductMatch, SubcategoryResolution } from "@/lib/catalogue-import/types";

export interface RowValidationInput {
  values: NormalizedRowValues;
  categoryResolution: CategoryResolution;
  subcategoryResolution: SubcategoryResolution | null;
  productMatch: ProductMatch;
  /** Numéro de la ligne d'origine si CETTE ligne est un doublon
   *  intra-fichier (voir resolution.ts, detectDuplicateRowsWithinFile) ;
   *  `undefined` si cette ligne n'est pas un doublon. Toujours
   *  `undefined` pour une ligne CATEGORY/SUBCATEGORY (non applicable --
   *  voir preview.ts, ces lignes ne sont jamais soumises à
   *  detectDuplicateRowsWithinFile). */
  duplicateOfRow?: number;
  /** COLLECTIONS / TAGS FOUNDATION v1 -- résolution des tags de cette
   *  ligne (EXISTING / WOULD_CREATE), déjà dédupliquée. */
  resolvedTags?: TagResolution[];
  /** Type de la ligne -- nécessaire pour n'annoncer une association de
   *  tags que là où un produit est réellement écrit. */
  rowType?: "CATEGORY" | "SUBCATEGORY" | "PRODUCT" | "UNKNOWN";
  /**
   * SUBCATEGORY UNIQUEMENT (mandat, section 4 : "Preview must resolve
   * parent category from either: A. an existing merchant category; or
   * B. a CATEGORY row in the same import. If parent category cannot
   * be resolved: BLOCK the subcategory row with a clear diagnostic.").
   * `true` si `categoryResolution` est EXISTING, OU WOULD_CREATE ET
   * épaulée par au moins une ligne explicite Type=Catégorie du MÊME
   * fichier portant ce nom normalisé (calculé par preview.ts). Une
   * ligne SUBCATEGORY dont le parent ne serait WOULD_CREATE que par la
   * référence implicite d'une AUTRE ligne (ex. une ligne Produit) est
   * délibérément traitée comme NON résolue -- jamais une sous-catégorie
   * qui invente silencieusement une toute nouvelle catégorie de premier
   * niveau que rien d'autre dans le fichier n'a explicitement déclarée.
   * Ignoré pour les autres types de ligne.
   */
  subcategoryParentResolvable?: boolean;
}

// ------------------------------------------------------------------
// CATEGORY -- mandat section 3.
// ------------------------------------------------------------------

function validateCategoryRow(values: NormalizedRowValues, categoryResolution: CategoryResolution): ImportIssue[] {
  const issues: ImportIssue[] = [];

  if (values.name === "") {
    issues.push({
      code: "SCANYM_IMPORT_MISSING_CATEGORY_NAME",
      severity: "BLOCKING_ERROR",
      message: "Nom de catégorie manquant (colonne « Nom »).",
      field: "Nom",
    });
    return issues; // rien d'autre à évaluer sans nom -- categoryResolution est déjà ERROR pour la même raison, jamais un second message redondant.
  }

  if (values.name.length > CATEGORY_NAME_MAX_LENGTH) {
    issues.push({
      code: "SCANYM_IMPORT_CATEGORY_NAME_TOO_LONG",
      severity: "BLOCKING_ERROR",
      message: `Nom de catégorie trop long (${values.name.length} caractères, maximum ${CATEGORY_NAME_MAX_LENGTH}).`,
      field: "Nom",
    });
  }

  if (categoryResolution.state === "AMBIGUOUS") {
    issues.push({
      code: "SCANYM_IMPORT_AMBIGUOUS_CATEGORY",
      severity: "BLOCKING_ERROR",
      message: `Le nom de catégorie « ${categoryResolution.displayName} » correspond à plusieurs catégories existantes distinctes -- résolution automatique refusée.`,
      field: "Nom",
    });
  } else if (categoryResolution.state === "WOULD_CREATE" && categoryResolution.casingConflict) {
    issues.push({
      code: "SCANYM_IMPORT_CATEGORY_CASING_CONFLICT",
      severity: "WARNING",
      message: `Cette catégorie apparaît avec plusieurs casses différentes dans le fichier (${(categoryResolution.casingVariants ?? []).join(", ")}) -- « ${categoryResolution.displayName} » (première occurrence) sera utilisée.`,
      field: "Nom",
    });
  }

  // COLLECTIONS / TAGS FOUNDATION v1 -- une ligne structurelle n'écrit
  // aucun produit : il n'y a rien à taguer. Le dire explicitement
  // plutôt que de laisser croire que la colonne a été prise en compte.
  if (values.tags.length > 0) {
    issues.push({
      code: "SCANYM_IMPORT_TAGS_IGNORED_ON_STRUCTURAL_ROW",
      severity: "WARNING",
      message: `${values.tags.length} tag(s) présent(s) sur une ligne de type CATEGORY -- les tags s'appliquent aux PRODUITS uniquement, ils seront ignorés pour cette ligne.`,
      field: "Tags / Collections",
    });
  }

  return issues;
}

// ------------------------------------------------------------------
// SUBCATEGORY -- mandat section 4.
// ------------------------------------------------------------------

function validateSubcategoryRow(
  values: NormalizedRowValues,
  categoryResolution: CategoryResolution,
  subcategoryResolution: SubcategoryResolution | null,
  subcategoryParentResolvable: boolean
): ImportIssue[] {
  const issues: ImportIssue[] = [];

  if (values.name === "") {
    issues.push({
      code: "SCANYM_IMPORT_MISSING_SUBCATEGORY_NAME",
      severity: "BLOCKING_ERROR",
      message: "Nom de sous-catégorie manquant (colonne « Nom »).",
      field: "Nom",
    });
  } else if (values.name.length > CATEGORY_NAME_MAX_LENGTH) {
    issues.push({
      code: "SCANYM_IMPORT_SUBCATEGORY_NAME_TOO_LONG",
      severity: "BLOCKING_ERROR",
      message: `Nom de sous-catégorie trop long (${values.name.length} caractères, maximum ${CATEGORY_NAME_MAX_LENGTH}).`,
      field: "Nom",
    });
  }

  // --- Catégorie parent (mandat : "require Catégorie parent") ---
  if (categoryResolution.state === "ERROR") {
    issues.push({
      code: "SCANYM_IMPORT_SUBCATEGORY_MISSING_PARENT_CATEGORY",
      severity: "BLOCKING_ERROR",
      message: "Catégorie parent manquante pour cette sous-catégorie (colonne « Catégorie parent »).",
      field: "Catégorie parent",
    });
  } else if (categoryResolution.state === "AMBIGUOUS") {
    issues.push({
      code: "SCANYM_IMPORT_AMBIGUOUS_CATEGORY",
      severity: "BLOCKING_ERROR",
      message: `Catégorie parent « ${categoryResolution.displayName} » ambiguë (plusieurs catégories existantes distinctes portent ce nom) -- résolution automatique refusée.`,
      field: "Catégorie parent",
    });
  } else if (!subcategoryParentResolvable) {
    // mandat section 4 : "resolve parent category from either: A. an
    // existing merchant category; or B. a CATEGORY row in the same
    // import. If parent category cannot be resolved: BLOCK." --
    // categoryResolution est WOULD_CREATE (ni ERROR ni AMBIGUOUS) mais
    // SEULEMENT parce qu'une autre ligne (ex. Produit) y fait
    // implicitement référence : cette ligne Sous-catégorie, ELLE,
    // refuse de créer silencieusement une catégorie de premier niveau
    // que rien d'explicite (existante OU ligne Catégorie du même
    // fichier) ne confirme.
    issues.push({
      code: "SCANYM_IMPORT_SUBCATEGORY_PARENT_CATEGORY_NOT_FOUND",
      severity: "BLOCKING_ERROR",
      message: `Catégorie parent « ${values.categoryNameRaw.trim()} » introuvable -- ni catégorie existante, ni ligne « Catégorie » explicite dans ce fichier.`,
      field: "Catégorie parent",
    });
  }

  // --- Résolution de la sous-catégorie elle-même ---
  if (subcategoryResolution && subcategoryResolution.state === "AMBIGUOUS") {
    issues.push({
      code: "SCANYM_IMPORT_AMBIGUOUS_SUBCATEGORY",
      severity: "BLOCKING_ERROR",
      message: `Le nom de sous-catégorie « ${subcategoryResolution.displayName} » correspond à plusieurs sous-catégories existantes distinctes sous cette catégorie -- résolution automatique refusée.`,
      field: "Nom",
    });
  } else if (subcategoryResolution && subcategoryResolution.state === "WOULD_CREATE" && subcategoryResolution.casingConflict) {
    issues.push({
      code: "SCANYM_IMPORT_SUBCATEGORY_CASING_CONFLICT",
      severity: "WARNING",
      message: `Cette sous-catégorie apparaît avec plusieurs casses différentes dans le fichier (${(subcategoryResolution.casingVariants ?? []).join(", ")}) -- « ${subcategoryResolution.displayName} » (première occurrence) sera utilisée.`,
      field: "Nom",
    });
  }

  // COLLECTIONS / TAGS FOUNDATION v1 -- une ligne structurelle n'écrit
  // aucun produit : il n'y a rien à taguer. Le dire explicitement
  // plutôt que de laisser croire que la colonne a été prise en compte.
  if (values.tags.length > 0) {
    issues.push({
      code: "SCANYM_IMPORT_TAGS_IGNORED_ON_STRUCTURAL_ROW",
      severity: "WARNING",
      message: `${values.tags.length} tag(s) présent(s) sur une ligne de type SUBCATEGORY -- les tags s'appliquent aux PRODUITS uniquement, ils seront ignorés pour cette ligne.`,
      field: "Tags / Collections",
    });
  }

  return issues;
}

// ------------------------------------------------------------------
// PRODUCT -- mandat section 5 ("retain product validation... Do NOT
// weaken current product validation"). Corps INCHANGÉ (aucun champ,
// aucune borne, aucun message modifié) par rapport à la version
// précédente de ce fichier -- seuls le NOM de cette fonction et son
// point d'appel (dispatch par type de ligne, voir validateRow
// ci-dessous) sont nouveaux.
// ------------------------------------------------------------------

function validateProductRow(
  values: NormalizedRowValues,
  categoryResolution: CategoryResolution,
  subcategoryResolution: SubcategoryResolution | null,
  productMatch: ProductMatch,
  duplicateOfRow: number | undefined,
  resolvedTags: TagResolution[]
): ImportIssue[] {
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
  if (values.taxRate === undefined) {
    // CATALOGUE VAT COMPLETENESS GUARD v1 -- TVA absente (colonne non
    // fournie/vide) N'EST PAS bloquant (Layer A, "may exist in
    // draft/incomplete state") -- contrairement à un format non
    // numérique (branche ci-dessous, BLOCKING_ERROR, INCHANGÉE). Le
    // produit sera importé (create_product/update_product, inchangés
    // par ce fichier) mais créé/laissé indisponible tant que la TVA
    // n'est pas renseignée -- même invariant que le formulaire manuel
    // (voir app/dashboard/catalogue/page.tsx), seule l'AUTORITÉ réelle
    // reste la contrainte CHECK menu_items_availability_requires_tax_
    // rate_chk en base.
    issues.push({
      code: "SCANYM_IMPORT_MISSING_TAX_RATE",
      severity: "WARNING",
      message: "TVA absente (colonne « TVA (%) ») -- produit importé mais créé/laissé indisponible tant que la TVA n'est pas renseignée.",
      field: "TVA (%)",
    });
  } else if (values.taxRate === null) {
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

  // --- Tags / Collections (COLLECTIONS / TAGS FOUNDATION v1) ---
  // Remplace l'ancien INFO SCANYM_IMPORT_TAGS_UNSUPPORTED : les tags
  // sont désormais RÉELLEMENT persistés (menu_tags / menu_item_tags),
  // l'opérateur doit donc voir ce qui va se passer, pas qu'on ignore
  // sa colonne. Nous sommes ici dans validateProductRow : la ligne
  // écrit bien un produit, donc les tags seront bien associés.
  if (values.tags.length > 0) {
    const existing = resolvedTags.filter((r) => r.state === "EXISTING");
    const toCreate = resolvedTags.filter((r) => r.state === "WOULD_CREATE");
    const parts: string[] = [];
    if (existing.length > 0) {
      parts.push(`${existing.length} existant(s) : ${existing.map((r) => r.displayName).join(", ")}`);
    }
    if (toCreate.length > 0) {
      parts.push(`${toCreate.length} à créer : ${toCreate.map((r) => r.displayName).join(", ")}`);
    }
    issues.push({
      code: "SCANYM_IMPORT_TAGS_RESOLVED",
      severity: "INFO",
      message:
        `${resolvedTags.length} tag(s) seront associés à ce produit` +
        (parts.length > 0 ? ` (${parts.join(" ; ")})` : "") +
        ". Un tag créé par import reste masqué du menu client tant qu'il n'est pas publié comme collection.",
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

// ------------------------------------------------------------------
// Point d'entrée -- dispatch par type de ligne (mandat : "the
// authoritative import parser / validation layer must understand the
// row type").
// ------------------------------------------------------------------

/** Valide une ligne normalisée et retourne la liste complète de ses
 *  problèmes (tous niveaux confondus -- preview.ts les répartit
 *  ensuite par sévérité). Couvre, au minimum, chaque item listé par
 *  le mandat OB-3 section "VALIDATION" (produit) et le mandat CATEGORY
 *  / SUBCATEGORY ROW SUPPORT v1 section "VALIDATION MATRIX" (catégorie/
 *  sous-catégorie). */
export function validateRow(input: RowValidationInput): ImportIssue[] {
  const { values, categoryResolution, subcategoryResolution, productMatch, duplicateOfRow, subcategoryParentResolvable, resolvedTags, rowType } = input;

  if (values.type.kind === "UNKNOWN") {
    // mandat : "Do not silently interpret unknown Type values. Unknown
    // Type: BLOCK the row with a clear diagnostic." -- impossible de
    // savoir quel schéma (catégorie / sous-catégorie / produit)
    // appliquer, donc AUCUNE autre vérification spécifique à un type
    // n'est tentée : un unique diagnostic clair, jamais une cascade de
    // messages contradictoires pour une ligne dont la nature même est
    // inconnue.
    return [
      {
        code: "SCANYM_IMPORT_UNKNOWN_ROW_TYPE",
        severity: "BLOCKING_ERROR",
        message: `Valeur « ${values.type.rawValue} » de la colonne « Type » non reconnue -- valeurs acceptées : « Catégorie », « Sous-catégorie », « Produit » (espaces/casse/accents tolérés ; colonne vide = « Produit »).`,
        field: "Type",
      },
    ];
  }

  if (values.type.kind === "CATEGORY") {
    return validateCategoryRow(values, categoryResolution);
  }

  if (values.type.kind === "SUBCATEGORY") {
    return validateSubcategoryRow(values, categoryResolution, subcategoryResolution, subcategoryParentResolvable ?? false);
  }

  // PRODUCT (explicite "Type = Produit", ou implicite -- colonne
  // absente/vide, comportement historique préservé à l'identique).
  return validateProductRow(values, categoryResolution, subcategoryResolution, productMatch, duplicateOfRow, resolvedTags ?? []);
}
