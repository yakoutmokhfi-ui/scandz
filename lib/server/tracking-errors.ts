import "server-only";

/**
 * CUSTOMER TRACKING EXPERIENCE v1.
 *
 * Taxonomie d'erreurs GÉNÉRIQUE et minimale pour la lecture serveur du
 * suivi client, même discipline que lib/server/payment-errors.ts :
 * message par défaut STABLE, jamais dérivé d'une valeur brute
 * Supabase/Postgrest (mandat §25, "no enumeration-friendly
 * distinction").
 *
 * Deux cas SEULEMENT, délibérément distincts (mandat §25 vs §45) :
 *   - TrackingLinkInvalidError : la RPC a répondu SANS ERREUR mais
 *     avec un ensemble de résultats VIDE -- couple order_id/
 *     public_token incorrect (mauvais jeton, mauvaise commande, les
 *     deux, ou entrée malformée déjà écartée avant l'appel RPC). C'est
 *     l'état "lien invalide" customer-safe du mandat §25 -- AUCUNE
 *     distinction observable entre ses sous-cas.
 *   - TrackingServerUnavailableError : panne D'INFRASTRUCTURE
 *     (Supabase injoignable, erreur Postgrest inattendue) --
 *     N'EST PAS une information sensible du point de vue énumération
 *     (elle ne révèle rien sur l'existence d'une commande précise) et
 *     mérite donc un message DIFFÉRENT ("réessayez plus tard") plutôt
 *     que d'être confondue avec un lien invalide.
 */

export const TRACKING_LINK_INVALID = "TRACKING_LINK_INVALID";
export const TRACKING_SERVER_UNAVAILABLE = "TRACKING_SERVER_UNAVAILABLE";

/** Couple (order_id, public_token) incorrect ou introuvable -- réponse
 *  RPC vide, sans erreur. Le message reste TOUJOURS générique (mandat
 *  §25) : jamais "wrong token" vs "wrong order", jamais un détail sur
 *  l'existence de la commande. */
export class TrackingLinkInvalidError extends Error {
  constructor(message: string = TRACKING_LINK_INVALID) {
    super(message);
    this.name = "TrackingLinkInvalidError";
  }
}

/** L'infrastructure Supabase elle-même n'a pas pu être jointe, ou a
 *  renvoyé une erreur Postgrest inattendue -- distinct d'un lien
 *  invalide (voir le commentaire de tête). Le message ne contient
 *  JAMAIS `error.message`/`error.details`/`error.hint` d'origine. */
export class TrackingServerUnavailableError extends Error {
  constructor(message: string = TRACKING_SERVER_UNAVAILABLE) {
    super(message);
    this.name = "TrackingServerUnavailableError";
  }
}
