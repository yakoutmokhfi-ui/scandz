/**
 * Classification des erreurs RPC catalogue (V66) — fonctions pures,
 * sans dépendance Supabase, testables sans variables d'environnement.
 *
 * Même patron que lib/services/order-error.ts (V65) : classification
 * stricte sur le COUPLE code ET message, jamais sur le code seul (un
 * SQLSTATE peut être partagé par plusieurs causes sans rapport).
 */

export const SHORT_DESCRIPTION_TOO_LONG_CODE = "SCANYM_SHORT_DESCRIPTION_TOO_LONG";
export const DESCRIPTION_TOO_LONG_CODE = "SCANYM_DESCRIPTION_TOO_LONG";
export const CATEGORY_DUPLICATE_NAME_CODE = "SCANYM_CATEGORY_DUPLICATE_NAME";
/** V67b — description longue de catégorie. */
export const CATEGORY_DESCRIPTION_TOO_LONG_CODE = "SCANYM_CATEGORY_DESCRIPTION_TOO_LONG";

/** CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 — mêmes constantes
 *  EXACTES que les `raise exception ... message = '...'` de
 *  create_product/update_product (voir supabase/DRAFT-lot-catalogue-
 *  fiscal-product-measurements-v1.sql) et que lib/catalogue-fiscal.ts
 *  (FiscalValidationErrorCode) -- une seule liste de vérité,
 *  répliquée aux 3 endroits, jamais redéfinie divergemment.
 *  SIMPLIFIÉ (v1.1) : seulement 2 codes -- sales_unit/price_mode/
 *  weight_mode/price_per_weight_rate/la combinaison ont tous été
 *  supprimés avec le modèle price_per_weight lui-même (voir mandat
 *  v1.1 §16, CAT-FISCAL-01). */
export const INVALID_TAX_RATE_CODE = "SCANYM_INVALID_TAX_RATE";
export const INVALID_WEIGHT_VALUE_CODE = "SCANYM_INVALID_WEIGHT_VALUE";

export class ShortDescriptionTooLongError extends Error {
  constructor() {
    super(SHORT_DESCRIPTION_TOO_LONG_CODE);
    this.name = "ShortDescriptionTooLongError";
  }
}

export class DescriptionTooLongError extends Error {
  constructor() {
    super(DESCRIPTION_TOO_LONG_CODE);
    this.name = "DescriptionTooLongError";
  }
}

export class CategoryDuplicateNameError extends Error {
  constructor() {
    super(CATEGORY_DUPLICATE_NAME_CODE);
    this.name = "CategoryDuplicateNameError";
  }
}

export class CategoryDescriptionTooLongError extends Error {
  constructor() {
    super(CATEGORY_DESCRIPTION_TOO_LONG_CODE);
    this.name = "CategoryDescriptionTooLongError";
  }
}

/** CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 — une seule classe
 *  d'erreur pour les 2 codes fiscaux/mesure (contrairement aux
 *  erreurs texte ci-dessus, qui ont chacune leur propre classe) : le
 *  dashboard a besoin de savoir LEQUEL des 2 codes a été renvoyé pour
 *  afficher le bon message (voir `code` ci-dessous), une classe
 *  unique paramétrée reste donc plus simple que 2 classes quasi
 *  identiques. */
export class FiscalMeasurementValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "FiscalMeasurementValidationError";
    this.code = code;
  }
}

export interface RpcErrorLike {
  message?: string | null;
  code?: string | null;
}

export function isShortDescriptionTooLongError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "22001" && error.message === SHORT_DESCRIPTION_TOO_LONG_CODE;
}

export function isDescriptionTooLongError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "22001" && error.message === DESCRIPTION_TOO_LONG_CODE;
}

/**
 * Doublon de nom de catégorie : remonte via l'index unique partiel
 * (voir supabase/migration-v66-categories-descriptions.sql), donc via
 * le vrai SQLSTATE Postgres de violation d'unicité (23505), pas un
 * code inventé — la contrainte est la source de vérité, pas une
 * vérification applicative qui pourrait rater une course concurrente.
 */
export function isCategoryDuplicateNameError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "23505" && error.message === CATEGORY_DUPLICATE_NAME_CODE;
}

export function isCategoryDescriptionTooLongError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "22001" && error.message === CATEGORY_DESCRIPTION_TOO_LONG_CODE;
}

const FISCAL_MEASUREMENT_ERROR_CODES: readonly string[] = [
  INVALID_TAX_RATE_CODE,
  INVALID_WEIGHT_VALUE_CODE,
];

/** Reconnaît n'importe lequel des 2 codes fiscaux/mesure -- voir
 *  FiscalMeasurementValidationError ci-dessus. */
export function isFiscalMeasurementValidationError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "22001" && FISCAL_MEASUREMENT_ERROR_CODES.includes(error.message ?? "");
}
