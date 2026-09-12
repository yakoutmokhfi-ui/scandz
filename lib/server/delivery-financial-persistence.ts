import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import type { DeliveryPricingPolicyResult } from "@/lib/delivery-pricing-policy";
import {
  DeliveryFinancialPersistenceRpcError,
  DeliveryFinancialPersistenceUnavailableError,
  PSEUDO_SQLSTATE_EMPTY_ROW,
} from "@/lib/server/delivery-financial-persistence-errors";

/**
 * STUART LOT C — DELIVERY FINANCIAL PERSISTENCE FOUNDATION v1.
 *
 * Enveloppe TYPÉE, SERVEUR UNIQUEMENT (`import "server-only"`,
 * `service_role` -- jamais `anon`/`authenticated`), autour de la RPC
 * `set_order_delivery_provider_financials`
 * (supabase/DRAFT-lot-delivery-financial-persistence-foundation-v1.sql).
 *
 * Reçoit un `DeliveryPricingPolicyResult` DÉJÀ calculé par STUART
 * LOT B (`computeDeliveryPricingPolicy`, lib/delivery-pricing-policy.ts)
 * -- ne recalcule NI `customerDeliveryFee` NI `merchantSubsidy` ici, ne
 * fait aucune arithmétique flottante supplémentaire. Transmet
 * `providerCost`/`merchantSubsidy`/`currency` EXACTEMENT tels que
 * produits par LOT B ; la RPC elle-même reste l'autorité de validation
 * finale (immuabilité, cohérence défensive avec `orders.delivery_fee`
 * déjà persisté, devise, précision).
 *
 * `customerDeliveryFee` n'est PAS transmis ici : il correspond déjà à
 * `orders.delivery_fee`, écrit par `create_order`/le moteur de
 * résolution serveur existant -- ce module ne le lit ni ne l'écrit
 * (mandat, "LOT C MUST NOT reimplement those calculations").
 *
 * AUCUN appelant réel n'existe encore dans ce lot (le câblage d'un
 * vrai devis Stuart au checkout reste hors périmètre) -- ce fichier
 * pose la capacité serveur, prête à être invoquée par un LOT
 * ultérieur au moment exact où `providerCost` devient réellement
 * connu.
 */

export interface PersistDeliveryProviderFinancialsInput {
  orderId: string;
  /** Résultat LOT B déjà calculé -- providerCost/merchantSubsidy/
   *  currency utilisés tels quels, customerDeliveryFee ignoré ici. */
  policyResult: Pick<DeliveryPricingPolicyResult, "providerCost" | "merchantSubsidy" | "currency">;
}

export interface PersistedDeliveryProviderFinancials {
  orderId: string;
  providerCost: number;
  merchantSubsidy: number;
  updatedAt: string;
}

interface SetOrderDeliveryProviderFinancialsRow {
  order_id: string;
  provider_cost: number | string;
  delivery_merchant_subsidy: number | string;
  updated_at: string;
}

export async function persistDeliveryProviderFinancials(
  input: PersistDeliveryProviderFinancialsInput
): Promise<PersistedDeliveryProviderFinancials> {
  const client = getServiceRoleSupabaseClient();

  let data: SetOrderDeliveryProviderFinancialsRow[] | SetOrderDeliveryProviderFinancialsRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("set_order_delivery_provider_financials", {
      p_order_id: input.orderId,
      p_provider_cost: input.policyResult.providerCost,
      p_merchant_subsidy: input.policyResult.merchantSubsidy,
      p_currency: input.policyResult.currency,
    }));
  } catch {
    throw new DeliveryFinancialPersistenceUnavailableError();
  }

  if (error) {
    throw new DeliveryFinancialPersistenceRpcError(error.code ?? PSEUDO_SQLSTATE_EMPTY_ROW);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new DeliveryFinancialPersistenceRpcError(PSEUDO_SQLSTATE_EMPTY_ROW);
  }

  return {
    orderId: String(row.order_id),
    providerCost: Number(row.provider_cost),
    merchantSubsidy: Number(row.delivery_merchant_subsidy),
    updatedAt: String(row.updated_at),
  };
}
