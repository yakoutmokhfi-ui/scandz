/**
 * Normalisation et comptage de texte du catalogue (V66) — catégories
 * et produits (nom, description courte, description longue).
 *
 * Généralisation de lib/order-note.ts (V65) : même jeu de caractères
 * "espace" explicite, même comptage par point de code, même prudence
 * sur \v (voir ce fichier et supabase/migration-v66-categories-descriptions.sql
 * pour le rappel complet du piège PostgreSQL E'\v').
 *
 * String.prototype.trim() (JS) et trim() (PostgreSQL) ne retirent pas
 * le même ensemble de caractères — voir lib/order-note.ts pour le
 * détail vérifié empiriquement. Ce module n'utilise ni l'un ni
 * l'autre nativement : un jeu de 6 caractères explicite (espace, tab,
 * LF, CR, FF, VT) est appliqué, identique à celui utilisé côté SQL
 * via btrim(..., E' \t\n\r\f' || chr(11)).
 */

const EDGE_WHITESPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

function trimEdges(raw: string): string {
  return raw.replace(EDGE_WHITESPACE, "");
}

export interface NormalizedText {
  /** Valeur nettoyée (jeu de caractères ci-dessus retiré en bordure). */
  value: string;
  /** Nombre de caractères Unicode (comptage par point de code, aligné sur PostgreSQL). */
  length: number;
  /** true si `length` ne dépasse pas la limite donnée. */
  isValid: boolean;
  /** true si le texte, une fois nettoyé, est vide. */
  isEmpty: boolean;
}

/** Normalise un texte : trim explicite, puis comptage par point de code, comparé à `maxLength`. */
export function normalizeText(
  raw: string | null | undefined,
  maxLength: number
): NormalizedText {
  const value = trimEdges(raw ?? "");
  const length = Array.from(value).length;
  return {
    value,
    length,
    isValid: length <= maxLength,
    isEmpty: value.length === 0,
  };
}

/**
 * Valeur à transmettre à une RPC : `null` si vide, sinon la valeur
 * normalisée. Ne tronque jamais — si le texte dépasse `maxLength`, il
 * est transmis tel quel pour que le serveur le rejette explicitement.
 */
export function textPayload(
  raw: string | null | undefined,
  maxLength: number
): string | null {
  const { value, isEmpty } = normalizeText(raw, maxLength);
  return isEmpty ? null : value;
}

/** Limites strictes, partagées entre l'interface, le service et les tests. */
export const CATEGORY_NAME_MAX_LENGTH = 255;
export const PRODUCT_NAME_MAX_LENGTH = 255;
export const SHORT_DESCRIPTION_MAX_LENGTH = 100;
export const LONG_DESCRIPTION_MAX_LENGTH = 500;
