import "server-only";

/**
 * LOT A-0 — MERCHANT STUART CREDENTIAL FOUNDATION v1.
 *
 * Taxonomie d'erreurs du domaine credential de prestataire de
 * LIVRAISON — distincte, DÉLIBÉRÉMENT, de `lib/server/payment-errors.ts`
 * (domaine paiement). Ce lot crée un domaine PARALLÈLE et SÉPARÉ, pas
 * une extension du domaine paiement (décision CIO/CTO explicite du
 * mandat LOT A-0) — voir aussi `delivery-provider-service.ts` et
 * `supabase/DRAFT-lot-stuart-merchant-credential-foundation-v1.sql`.
 *
 * Chaque message par défaut reste STABLE et GÉNÉRIQUE — jamais dérivé
 * d'une valeur de credential (même discipline que le domaine paiement,
 * mission §8/§9 historique de ce dépôt).
 */

export const DELIVERY_PROVIDER_SERVER_CONFIG_ERROR = "DELIVERY_PROVIDER_SERVER_CONFIG_ERROR";
export const DELIVERY_PROVIDER_SERVER_RPC_ERROR = "DELIVERY_PROVIDER_SERVER_RPC_ERROR";
export const DELIVERY_PROVIDER_SERVER_UNAVAILABLE = "DELIVERY_PROVIDER_SERVER_UNAVAILABLE";

/**
 * Une RPC credential de livraison de confiance a été appelée mais a
 * échoué (rejet métier, erreur Postgrest, ligne vide inattendue). Le
 * message reste TOUJOURS générique — jamais construit à partir du
 * contenu de l'erreur Supabase/Postgrest d'origine. Porte `sqlstate`
 * et `rpcName` comme métadonnées de classification INTERNES
 * uniquement — jamais sérialisées vers un client.
 */
export class DeliveryProviderServerRpcError extends Error {
  readonly rpcName: string;
  readonly sqlstate: string | null;

  constructor(
    rpcName: string,
    sqlstate: string | null,
    message: string = DELIVERY_PROVIDER_SERVER_RPC_ERROR
  ) {
    super(message);
    this.name = "DeliveryProviderServerRpcError";
    this.rpcName = rpcName;
    this.sqlstate = sqlstate;
  }
}

/** L'infrastructure Supabase elle-même n'a pas pu être jointe (échec
 *  réseau/transport, distinct d'un rejet métier renvoyé PAR la RPC). */
export class DeliveryProviderServerUnavailableError extends Error {
  constructor(message: string = DELIVERY_PROVIDER_SERVER_UNAVAILABLE) {
    super(message);
    this.name = "DeliveryProviderServerUnavailableError";
  }
}

/**
 * Levée UNIQUEMENT par le résolveur runtime marchand (`credential-
 * resolver.ts`) lorsqu'aucun credential Stuart n'est configuré pour le
 * restaurant demandé. Erreur DÉTERMINISTE, distincte de
 * `DeliveryProviderServerRpcError` (échec infrastructure/RPC générique)
 * — signale spécifiquement une absence de configuration marchande,
 * jamais une panne. Ne porte JAMAIS restaurant_id dans le message par
 * défaut (mandat §8/§9) — l'appelant connaît déjà cette valeur, il l'a
 * fournie.
 *
 * Un appelant réel NE DOIT JAMAIS intercepter cette erreur pour
 * retomber silencieusement sur un credential Scanym global de
 * diagnostic Sandbox (STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV)
 * — voir credential-resolver.ts pour la preuve qu'aucun chemin de ce
 * module ne lit jamais ces variables d'environnement.
 */
export class StuartMerchantCredentialMissingError extends Error {
  constructor(message: string = "STUART_MERCHANT_CREDENTIAL_MISSING") {
    super(message);
    this.name = "StuartMerchantCredentialMissingError";
  }
}
