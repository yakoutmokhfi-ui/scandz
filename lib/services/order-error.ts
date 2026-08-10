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
