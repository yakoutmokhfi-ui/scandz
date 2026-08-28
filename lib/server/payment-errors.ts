import "server-only";

/**
 * PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
 *
 * Taxonomie d'erreurs GÉNÉRIQUE et minimale (mission §14/§15) pour la
 * couche serveur de paiement. Volontairement réduite à trois cas : ce
 * lot ne connaît aucun prestataire (Monetico/Mercanet/autre) et ne
 * doit encoder AUCUN concept spécifique à un adaptateur -- ces erreurs
 * ne portent que sur ce que CE lot peut échouer à faire lui-même
 * (configuration serveur absente, RPC de confiance qui échoue,
 * infrastructure Supabase inatteignable).
 *
 * `import "server-only"` ici aussi (pas seulement dans
 * supabase-admin.ts) : ces classes sont conceptuellement partie de la
 * couche serveur de confiance (`lib/server/`), et le garde-fou
 * structurel (test v110-payment-p3a1-structural) vérifie que TOUT
 * fichier sous `lib/server/` porte ce garde -- une invariante simple à
 * vérifier plutôt que de faire un cas particulier pour ce fichier au
 * prétexte qu'il ne touche pas directement de secret.
 *
 * Chaque classe suit la convention déjà établie par ce dépôt
 * (`lib/services/order-error.ts`, `OrderNoteTooLongError extends
 * Error`) : un message par défaut STABLE et GÉNÉRIQUE (jamais dérivé
 * d'une valeur d'erreur Supabase/Postgrest brute -- voir
 * payment-service.ts, qui ne construit jamais ces messages à partir de
 * `error.message`/`error.details`/`error.hint`).
 */

export const PAYMENT_SERVER_CONFIG_ERROR = "PAYMENT_SERVER_CONFIG_ERROR";
export const PAYMENT_SERVER_RPC_ERROR = "PAYMENT_SERVER_RPC_ERROR";
export const PAYMENT_SERVER_UNAVAILABLE = "PAYMENT_SERVER_UNAVAILABLE";

/** Configuration serveur absente ou invalide (ex. variable
 *  d'environnement manquante). Le message peut nommer la variable
 *  manquante -- JAMAIS sa valeur (mission §8/§9). */
export class PaymentServerConfigError extends Error {
  constructor(message: string = PAYMENT_SERVER_CONFIG_ERROR) {
    super(message);
    this.name = "PaymentServerConfigError";
  }
}

/** Une RPC de paiement de confiance a été appelée mais a échoué
 *  (rejet métier, erreur Postgrest, ligne vide inattendue). Le
 *  message reste TOUJOURS générique -- jamais construit à partir du
 *  contenu de l'erreur Supabase/Postgrest d'origine (mission §16). */
export class PaymentServerRpcError extends Error {
  constructor(message: string = PAYMENT_SERVER_RPC_ERROR) {
    super(message);
    this.name = "PaymentServerRpcError";
  }
}

/** L'infrastructure Supabase elle-même n'a pas pu être jointe (échec
 *  réseau/transport, distinct d'un rejet métier renvoyé PAR la RPC). */
export class PaymentServerUnavailableError extends Error {
  constructor(message: string = PAYMENT_SERVER_UNAVAILABLE) {
    super(message);
    this.name = "PaymentServerUnavailableError";
  }
}
