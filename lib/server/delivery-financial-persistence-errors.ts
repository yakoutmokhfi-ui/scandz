import "server-only";

/**
 * STUART LOT C — DELIVERY FINANCIAL PERSISTENCE FOUNDATION v1.
 *
 * Erreurs du wrapper serveur autour de la RPC `service_role`
 * `set_order_delivery_provider_financials`
 * (supabase/DRAFT-lot-delivery-financial-persistence-foundation-v1.sql).
 * Domaine SÉPARÉ des erreurs Payment (`lib/server/payment-errors.ts`) --
 * jamais réutilisées, jamais importées d'ici, même patron que
 * `lib/delivery-pricing-policy-errors.ts` (STUART LOT B) : un domaine,
 * ses propres erreurs, aucun couplage inter-domaine.
 */

export const DELIVERY_FINANCIAL_PERSISTENCE_RPC_ERROR =
  "DELIVERY_FINANCIAL_PERSISTENCE_RPC_ERROR";
export const DELIVERY_FINANCIAL_PERSISTENCE_UNAVAILABLE =
  "DELIVERY_FINANCIAL_PERSISTENCE_UNAVAILABLE";

/** Pseudo-code stable pour une réponse RPC sans erreur PostgREST mais
 *  sans ligne renvoyée (contrat violé) -- jamais un vrai SQLSTATE. */
export const PSEUDO_SQLSTATE_EMPTY_ROW = "SCANYM_EMPTY_ROW";

/**
 * La RPC a répondu avec une erreur PostgREST (violation de contrainte,
 * commande introuvable, snapshot déjà enregistré, devise incompatible,
 * précision invalide, subside incohérent, commande non-livraison...).
 * Message TOUJOURS générique (jamais le détail SQL brut) -- même
 * discipline que PaymentServerRpcError. `sqlstate` reste une métadonnée
 * INTERNE, jamais sérialisée vers un client.
 */
export class DeliveryFinancialPersistenceRpcError extends Error {
  readonly sqlstate: string;
  constructor(sqlstate: string) {
    super(DELIVERY_FINANCIAL_PERSISTENCE_RPC_ERROR);
    this.name = "DeliveryFinancialPersistenceRpcError";
    this.sqlstate = sqlstate;
  }
}

/** Échec de transport (réseau, client Supabase indisponible) --
 *  distinct d'un rejet applicatif de la RPC elle-même. */
export class DeliveryFinancialPersistenceUnavailableError extends Error {
  constructor() {
    super(DELIVERY_FINANCIAL_PERSISTENCE_UNAVAILABLE);
    this.name = "DeliveryFinancialPersistenceUnavailableError";
  }
}
