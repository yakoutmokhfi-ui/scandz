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
