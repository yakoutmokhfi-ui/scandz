/**
 * Classification de l'erreur "note trop longue" (V65) — fonction pure,
 * sans dépendance Supabase, pour rester testable par `npm test` sans
 * variables d'environnement.
 *
 * Extraite de lib/services/orders.ts après audit : la version
 * précédente acceptait `error.code === "22001"` seule (avec un `||`),
 * ce qui aurait requalifié en "note trop longue" n'importe quelle
 * erreur PostgreSQL 22001 sans rapport avec la note (toute autre
 * colonne trop longue pour son domaine partage ce même SQLSTATE).
 * La classification exige maintenant le COUPLE code ET message.
 */

/** Code d'erreur stable renvoyé par create_order (V65) quand la note dépasse la limite. */
export const ORDER_NOTE_TOO_LONG_CODE = "SCANYM_ORDER_NOTE_TOO_LONG";

/** Erreur reconnaissable levée quand le serveur rejette la note (>500 caractères). */
export class OrderNoteTooLongError extends Error {
  constructor() {
    super(ORDER_NOTE_TOO_LONG_CODE);
    this.name = "OrderNoteTooLongError";
  }
}

/** Sous-ensemble de PostgrestError utile ici, pour rester testable sans importer @supabase/supabase-js. */
export interface RpcErrorLike {
  message?: string | null;
  code?: string | null;
}

/**
 * true seulement si le SQLSTATE ET le message correspondent tous les
 * deux à l'erreur "note trop longue" de create_order. Un message
 * SCANYM_ORDER_NOTE_TOO_LONG avec un autre SQLSTATE, ou un SQLSTATE
 * 22001 avec un autre message, ne sont PAS classés comme "note trop
 * longue" — ils restent des erreurs génériques (orderFailed).
 */
export function isOrderNoteTooLongError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "22001" && error.message === ORDER_NOTE_TOO_LONG_CODE;
}

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1 -- classification des deux
 * erreurs déterministes levées par create_order quand le marchand est
 * CGV_ACTIVE (voir DRAFT-lot-seller-legal-profile-cgv-engine-v1.sql,
 * section M). Même discipline que ci-dessus : code ET message exigés
 * ensemble, jamais le code seul (P0001 est le SQLSTATE générique de
 * `raise exception`, partagé par de nombreuses erreurs applicatives
 * sans rapport avec la CGV).
 */
export const CGV_ACCEPTANCE_REQUIRED_CODE = "CGV_ACCEPTANCE_REQUIRED";
export const CGV_NOT_PUBLISHED_CODE = "CGV_REQUIRED_BUT_NOT_PUBLISHED";

export class CgvAcceptanceRequiredError extends Error {
  constructor() {
    super(CGV_ACCEPTANCE_REQUIRED_CODE);
    this.name = "CgvAcceptanceRequiredError";
  }
}

export function isCgvAcceptanceRequiredError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "P0001" && error.message === CGV_ACCEPTANCE_REQUIRED_CODE;
}

export function isCgvNotPublishedError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "P0001" && error.message === CGV_NOT_PUBLISHED_CODE;
}
