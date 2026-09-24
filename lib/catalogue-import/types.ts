/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Types partagés du modèle de Preview (mandat OB-3, "PREVIEW MODEL").
 * PURE (aucune valeur, uniquement des types).
 */

import type { ImportColumn } from "@/lib/catalogue-import/column-mapping";
import type { RowTypeClassification } from "@/lib/catalogue-import/normalization";
import type { TagResolution } from "@/lib/catalogue-import/tag-resolution";

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
  /** Nom PROPRE de la ligne : nom de catégorie (ligne CATEGORY), nom
   *  de sous-catégorie (ligne SUBCATEGORY), ou nom de produit (ligne
   *  PRODUCT/UNKNOWN) -- toujours la colonne « Nom », jamais réinter-
   *  prétée différemment selon le type (CATEGORY / SUBCATEGORY / ROW
   *  SUPPORT v1). */
  name: string;
  shortDescription: string | null;
  description: string | null;
  /** `undefined` = cellule absente du fichier (colonne non fournie),
   *  `null` = présente mais non numérique, `number` = valeur coercée. */
  price: number | null | undefined;
  taxRate: number | null | undefined;
  unitWeightGrams: number | null | undefined;
  weightIsApproximate: boolean;
  /** ONLINE WITHDRAWAL v1 -- valeur BRUTE lue dans la colonne
   *  « Rétractable » : `undefined` = colonne absente ou cellule vide,
   *  `true`/`false` = « Oui »/« Non » explicite, `null` = valeur non
   *  vide INVALIDE (diagnostic bloquant, jamais un `false`
   *  silencieux). Voir coerceWithdrawalEligible (normalization.ts).
   *  La valeur réellement écrite est `PreviewRow.withdrawalEligibleToWrite`
   *  ci-dessous, jamais ce champ brut. */
  withdrawalEligible: boolean | null | undefined;
  tags: string[];
  type: RowTypeClassification;
  /** Nom de catégorie à RÉSOUDRE pour cette ligne (jamais interrogé
   *  hors de resolution.ts) : le nom PROPRE de la ligne pour une ligne
   *  CATEGORY, le parent déclaré (« Catégorie parent ») pour une ligne
   *  SUBCATEGORY ou PRODUCT/UNKNOWN -- calculé une seule fois par
   *  preview.ts::normalizeRow, jamais recalculé ailleurs (CATEGORY /
   *  SUBCATEGORY ROW SUPPORT v1). */
  categoryNameRaw: string;
  /** Nom de sous-catégorie à RÉSOUDRE pour cette ligne : le nom PROPRE
   *  de la ligne pour une ligne SUBCATEGORY, « Sous-catégorie parent »
   *  pour une ligne PRODUCT/UNKNOWN, toujours vide pour une ligne
   *  CATEGORY (non applicable). */
  subcategoryNameRaw: string;
  photoFilename: string | null;
}

/** Simplifiée pour un accès direct au niveau ligne (même précédent que
 *  `PreviewRow.photoFilename`, déjà dupliqué depuis
 *  `normalizedValues.photoFilename` pour éviter à chaque consommateur
 *  -- UI, tests -- de redescendre dans `normalizedValues.type.kind`). */
export type RowType = "CATEGORY" | "SUBCATEGORY" | "PRODUCT" | "UNKNOWN";

export interface PreviewRow {
  row: number;
  status: RowStatus;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  infos: ImportIssue[];
  /** Pour une ligne CATEGORY : résolution de LA CATÉGORIE DÉCLARÉE
   *  PAR CETTE LIGNE elle-même. Pour une ligne SUBCATEGORY ou
   *  PRODUCT/UNKNOWN : résolution de SA CATÉGORIE PARENTE (« Catégorie
   *  parent »), comportement historique inchangé pour ces deux
   *  derniers cas (CATEGORY / SUBCATEGORY ROW SUPPORT v1). */
  resolvedCategory: CategoryResolution;
  /** Pour une ligne SUBCATEGORY : résolution de LA SOUS-CATÉGORIE
   *  DÉCLARÉE PAR CETTE LIGNE elle-même. Pour une ligne PRODUCT/
   *  UNKNOWN : résolution de sa sous-catégorie parente optionnelle
   *  (comportement historique inchangé). Toujours `null` pour une
   *  ligne CATEGORY (non applicable). */
  resolvedSubcategory: SubcategoryResolution | null;
  normalizedValues: NormalizedRowValues;
  photoFilename: string | null;
  /** Toujours calculé (même pour une ligne CATEGORY/SUBCATEGORY, où sa
   *  valeur n'a aucune influence sur `plannedAction`) -- jamais utilisé
   *  hors des lignes PRODUCT/UNKNOWN. */
  productMatch: ProductMatch;
  /** COLLECTIONS / TAGS FOUNDATION v1 -- résolution des tags de la
   *  colonne « Tags / Collections » de CETTE ligne, dédupliquée
   *  insensiblement à la casse, dans l'ordre du fichier. Toujours
   *  calculée ; n'a d'effet réel que pour une ligne PRODUCT/UNKNOWN
   *  (une ligne CATEGORY/SUBCATEGORY ne crée aucun produit, donc
   *  n'associe aucun tag -- voir validation.ts). */
  resolvedTags: TagResolution[];
  rowType: RowType;
  plannedAction: PlannedAction;
  /**
   * ONLINE WITHDRAWAL v1 -- valeur EFFECTIVE de `withdrawal_eligible`
   * que le commit transmettra à create_product/update_product pour
   * CETTE ligne. Résolue UNE SEULE FOIS par preview.ts (seul endroit
   * qui voit à la fois la cellule et le produit existant), jamais
   * recalculée par le commit :
   *
   *   - cellule « Oui »/« Non »  -> cette valeur, telle quelle ;
   *   - cellule VIDE / colonne absente :
   *       -> produit EXISTANT : sa valeur ACTUELLE (inchangée -- une
   *          cellule vide ne remet JAMAIS un « Oui » à « Non », alors
   *          même que update_product réécrit toujours la colonne) ;
   *       -> produit NOUVEAU : `false` (défaut de la migration) ;
   *   - cellule INVALIDE -> la ligne est BLOQUÉE (rien n'est écrit) ;
   *     cette valeur retombe sur le même repli que la cellule vide,
   *     jamais sur `true`.
   *
   * Toujours calculée, y compris pour une ligne CATEGORY/SUBCATEGORY
   * (où elle n'a aucun sens et n'est jamais lue -- ces lignes
   * n'écrivent aucun produit).
   */
  withdrawalEligibleToWrite: boolean;
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
