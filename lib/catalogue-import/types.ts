/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Types partagés du modèle de Preview (mandat OB-3, "PREVIEW MODEL").
 * PURE (aucune valeur, uniquement des types).
 */

import type { ImportColumn } from "@/lib/catalogue-import/column-mapping";
import type { TypeClassification } from "@/lib/catalogue-import/normalization";

export type IssueSeverity = "BLOCKING_ERROR" | "WARNING" | "INFO";

export interface ImportIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  field?: ImportColumn;
}

export type ResolutionState = "EXISTING" | "WOULD_CREATE" | "AMBIGUOUS" | "ERROR";

export interface CategoryResolution {
  state: ResolutionState;
  /** Nom affiché : nom existant si EXISTING, première casse rencontrée
   *  dans le fichier si WOULD_CREATE, valeur brute (ou vide) si ERROR. */
  displayName: string;
  existingId?: string;
  /** Présent uniquement si state === "AMBIGUOUS" : tous les
   *  category_id existants dont le nom normalisé collisionne. */
  ambiguousIds?: string[];
  /** Présent uniquement si state === "WOULD_CREATE" : la casse
   *  affichée diffère d'une autre ligne du MÊME fichier référençant
   *  la même clé normalisée -- jamais bloquant, toujours une décision
   *  déterministe documentée (première occurrence gagne), mais
   *  surfacée pour visibilité opérateur. */
  casingConflict?: boolean;
  casingVariants?: string[];
}

export type SubcategoryResolution = CategoryResolution;

export type ProductMatchState = "NEW" | "EXISTING_MATCH" | "AMBIGUOUS_DUPLICATE";

export interface ProductMatch {
  state: ProductMatchState;
  existingId?: string;
  ambiguousIds?: string[];
}

export type PlannedAction = "CREATE" | "UPDATE" | "SKIP" | "BLOCKED";
export type RowStatus = "OK" | "WARNING" | "BLOCKED";

export interface NormalizedRowValues {
  name: string;
  shortDescription: string | null;
  description: string | null;
  /** `undefined` = cellule absente du fichier (colonne non fournie),
   *  `null` = présente mais non numérique, `number` = valeur coercée. */
  price: number | null | undefined;
  taxRate: number | null | undefined;
  unitWeightGrams: number | null | undefined;
  weightIsApproximate: boolean;
  tags: string[];
  type: TypeClassification;
  categoryNameRaw: string;
  subcategoryNameRaw: string;
  photoFilename: string | null;
}

export interface PreviewRow {
  row: number;
  status: RowStatus;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  infos: ImportIssue[];
  resolvedCategory: CategoryResolution;
  resolvedSubcategory: SubcategoryResolution | null;
  normalizedValues: NormalizedRowValues;
  photoFilename: string | null;
  productMatch: ProductMatch;
  plannedAction: PlannedAction;
}

export type PreviewFileEligibility = "ELIGIBLE" | "ELIGIBLE_WITH_WARNINGS" | "NOT_ELIGIBLE";

export interface PreviewReport {
  rows: PreviewRow[];
  eligibility: PreviewFileEligibility;
  totalRows: number;
  blockedRows: number;
  warningRows: number;
  okRows: number;
  columnMapWarnings: ImportIssue[];
}
