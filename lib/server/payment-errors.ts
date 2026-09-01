import "server-only";

/**
 * PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — ferme
 * P3BV42-RPC-TRANSIENT-CLASSIFICATION-01.
 *
 * AVANT ce lot : `PaymentServerRpcError` ne portait AUCUNE information
 * exploitable au-delà de son type JS -- le SQLSTATE d'origine
 * (`error.code` de PostgREST) était journalisé (`logRpcFailure`) puis
 * PERDU pour l'appelant. `classifyProcessingError`
 * (payment-provider-event-processor.ts) ne pouvait donc classer
 * QUE par `instanceof`, jamais par la SÉMANTIQUE réelle du rejet
 * (mandat §4 : "Do not classify solely from JavaScript
 * exception-vs-error-object shape").
 *
 * v4.3 : `PaymentServerRpcError` porte désormais `sqlstate` (le code
 * PostgREST d'origine, ou un pseudo-code stable pour les cas
 * non-SQLSTATE déjà existants -- "ligne vide inattendue" -- voir
 * PSEUDO_SQLSTATE_EMPTY_ROW ci-dessous) et `rpcName` (contexte,
 * jamais exposé au client). Le message reste TOUJOURS générique,
 * INCHANGÉ (mandat §16, §8/§9 de P3-A1) -- ces deux nouvelles
 * propriétés sont des métadonnées INTERNES de classification, jamais
 * sérialisées vers un client par aucune route API existante (aucune
 * route ne sérialise `.sqlstate`/`.rpcName` aujourd'hui -- confirmé
 * par recherche exhaustive avant ce lot, voir SQLSTATE-REPORT.txt).
 *
 * `import "server-only"` ici aussi (pas seulement dans
 * supabase-admin.ts) : ces classes sont conceptuellement partie de la
 * couche serveur de confiance (`lib/server/`), et le garde-fou
 * structurel (test v110-payment-p3a1-structural) vérifie que TOUT
 * fichier sous `lib/server/` porte ce garde.
 */

export const PAYMENT_SERVER_CONFIG_ERROR = "PAYMENT_SERVER_CONFIG_ERROR";
export const PAYMENT_SERVER_RPC_ERROR = "PAYMENT_SERVER_RPC_ERROR";
export const PAYMENT_SERVER_UNAVAILABLE = "PAYMENT_SERVER_UNAVAILABLE";

/**
 * Pseudo-SQLSTATE stable pour un cas DÉJÀ existant avant ce lot,
 * jamais un vrai code PostgreSQL : la RPC a répondu SANS erreur
 * PostgREST mais avec zéro ligne, alors qu'une ligne était attendue
 * (contrat de la RPC violé, ou ressource introuvable dégradée en
 * réponse vide plutôt qu'en erreur explicite). Classée DÉTERMINISTE
 * (voir classifyRpcSqlstate ci-dessous) -- rejouer la même entrée ne
 * produirait jamais une ligne qui n'existe pas.
 */
export const PSEUDO_SQLSTATE_EMPTY_ROW = "SCANYM_EMPTY_ROW";

/** Configuration serveur absente ou invalide (ex. variable
 *  d'environnement manquante). Le message peut nommer la variable
 *  manquante -- JAMAIS sa valeur (mission §8/§9). */
export class PaymentServerConfigError extends Error {
  constructor(message: string = PAYMENT_SERVER_CONFIG_ERROR) {
    super(message);
    this.name = "PaymentServerConfigError";
  }
}

/**
 * Une RPC de paiement de confiance a été appelée mais a échoué (rejet
 * métier, erreur Postgrest, ligne vide inattendue). Le message reste
 * TOUJOURS générique -- jamais construit à partir du contenu de
 * l'erreur Supabase/Postgrest d'origine (mission §16).
 *
 * v4.3 : porte désormais `sqlstate` (le code PostgREST d'origine, ou
 * PSEUDO_SQLSTATE_EMPTY_ROW / un pseudo-code stable équivalent pour
 * les cas déjà existants sans SQLSTATE réel) et `rpcName` --
 * métadonnées de classification INTERNES uniquement, jamais exposées
 * au client (voir le commentaire de fichier).
 */
export class PaymentServerRpcError extends Error {
  readonly rpcName: string;
  readonly sqlstate: string | null;

  constructor(rpcName: string, sqlstate: string | null, message: string = PAYMENT_SERVER_RPC_ERROR) {
    super(message);
    this.name = "PaymentServerRpcError";
    this.rpcName = rpcName;
    this.sqlstate = sqlstate;
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

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — ferme
 * P3BV42-RPC-TRANSIENT-CLASSIFICATION-01.
 *
 * POLITIQUE DE CLASSIFICATION EXPLICITE, UNIQUE (mandat §5) --
 * réutilisée par tout appelant ayant besoin de distinguer
 * déterministe/transitoire/inconnu à partir d'un SQLSTATE réel.
 * N'appartient PAS au type d'exception JS (voir le défaut corrigé
 * ci-dessus) -- une fonction PURE, testée isolément, jamais un simple
 * `instanceof`.
 *
 * A. DÉTERMINISTE / TERMINAL -- rejouer la MÊME entrée produit
 *    TOUJOURS le même rejet :
 *    - P0002 : rejet métier explicite (ressource introuvable --
 *      "corrélation impossible", "évènement introuvable") ;
 *    - PSEUDO_SQLSTATE_EMPTY_ROW : ligne vide inattendue (cas
 *      déjà existant, jamais un vrai SQLSTATE).
 *
 * B. TRANSITOIRE / RÉESSAYABLE -- une nouvelle tentative PEUT réussir :
 *    - 40001 : échec de sérialisation (conflit de transaction
 *      concurrente) ;
 *    - 40P01 : interblocage détecté.
 *    Les classes 53xxx (ressources épuisées : connexions, mémoire,
 *    disque) et 57xxx (intervention admin/arrêt) sont évaluées
 *    INDIVIDUELLEMENT (mandat §5 : "Do NOT make an entire SQLSTATE
 *    class retryable without justification") -- seuls 57P01 (arrêt
 *    admin normal, transitoire par nature) et 53300 (trop de
 *    connexions, transitoire par nature) sont retenus ici ; les
 *    autres codes de ces classes restent dans le seau C (inconnu/
 *    prudent) faute de preuve positive de leur nature transitoire.
 *
 * C. INCONNU / PRUDENT -- AUCUNE preuve positive d'échec déterministe :
 *    tout code non explicitement classé en A ou B, y compris
 *    `sqlstate === null` (ex. erreur Postgrest sans code identifiable).
 *    Traité comme transitoire-borné (mandat §5 : "must NOT silently
 *    become immediately terminal... use bounded retry unless there is
 *    positive evidence of deterministic failure").
 *
 * P0004 (conflit réel de revendication/bail) et 42501 (transition
 * d'état refusée) sont des codes RÉELS de ce dépôt (voir
 * update_payment_provider_event_processing_status), mais
 * appartiennent à une préoccupation DIFFÉRENTE (l'intégrité du modèle
 * claim/lease et de la machine à états elle-même, pas la fiabilité
 * réseau/transaction) -- ils ne transitent JAMAIS par cette fonction :
 * `finalize()` (payment-provider-event-processor.ts) les traite
 * exclusivement par inspection DIRECTE du SQLSTATE, AVANT tout appel
 * à classifyRpcSqlstate (voir STATE-MACHINE-RECONCILIATION-REPORT.txt).
 */
export type RpcFailureClassification = "deterministic" | "transient" | "unknown";

const DETERMINISTIC_SQLSTATES: ReadonlySet<string> = new Set(["P0002", PSEUDO_SQLSTATE_EMPTY_ROW]);
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "57P01", "53300"]);

export function classifyRpcSqlstate(sqlstate: string | null): RpcFailureClassification {
  if (sqlstate === null) return "unknown";
  if (DETERMINISTIC_SQLSTATES.has(sqlstate)) return "deterministic";
  if (TRANSIENT_SQLSTATES.has(sqlstate)) return "transient";
  return "unknown";
}
