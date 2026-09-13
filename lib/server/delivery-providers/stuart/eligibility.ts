import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * STUART LOT D1 §A — DELIVERY ELIGIBILITY AUTHORITY.
 *
 * Enveloppe TYPÉE de `get_stuart_delivery_eligibility` (narrow SECURITY
 * DEFINER RPC, lecture pure) — voir
 * supabase/DRAFT-lot-stuart-provider-events-foundation-v1.sql pour le
 * détail exact des dix vérifications séquentielles. Ce module N'INVENTE
 * AUCUNE logique d'éligibilité côté TypeScript — il se limite à
 * transmettre l'appel et à typer fidèlement le contrat de retour
 * (`eligible`/`reasonCode`), fail-closed sur toute erreur RPC (jamais
 * un `eligible: true` silencieux en cas de panne infrastructure).
 */

export class StuartEligibilityError extends Error {
  constructor(message: string = "STUART_ELIGIBILITY_ERROR") {
    super(message);
    this.name = "StuartEligibilityError";
  }
}

/** Valeurs EXACTES renvoyées par get_stuart_delivery_eligibility --
 *  voir la RPC SQL pour la séquence de vérification correspondante.
 *  Toute valeur hors de cette union est traitée comme une erreur
 *  fail-closed par ce wrapper (jamais transmise telle quelle à un
 *  appelant qui pourrait la mal interpréter).
 *
 *  STUART_MERCHANT_ENVIRONMENT_INVALID -- STUART LOT D1 v1.2
 *  (remédiation Cat Stevens, blocker 2 HIGH) : défense en profondeur
 *  si delivery_provider_configs.mode s''écartait un jour de
 *  l''énumération CHECK existante ('sandbox'/'production', LOT A-0,
 *  INCHANGÉE) -- ne devrait structurellement jamais se produire pour
 *  une ligne réelle. */
export type StuartDeliveryIneligibilityReasonCode =
  | "INVALID_INPUT"
  | "ORDER_NOT_FOUND"
  | "RESTAURANT_INACTIVE"
  | "ORDER_CANCELLED"
  | "PAYMENT_NOT_CONFIRMED"
  | "FULFILLMENT_MODE_NOT_DELIVERY"
  | "DELIVERY_CONTACT_DATA_MISSING"
  | "DELIVERY_MODE_NOT_ENABLED"
  | "DELIVERY_PROVIDER_NOT_STUART"
  | "NO_ACTIVE_STUART_FULFILLMENT_RULE"
  | "STUART_CREDENTIAL_NOT_CONFIGURED"
  | "STUART_MERCHANT_ENVIRONMENT_INVALID"
  | "PRIOR_TERMINAL_FAILURE_EXISTS";

/** STUART LOT D1 v1.2 (blocker 2, HIGH) -- vocabulaire IDENTIQUE à
 *  `delivery_provider_configs.mode` (LOT A-0) et à `StuartEnvironment`
 *  (environment.ts) -- défini ICI localement (jamais importé depuis
 *  environment.ts, qui reste explicitement hors périmètre D1, mandat
 *  §I) pour que ce module continue de n'importer AUCUN chemin
 *  credential/HTTP global. Structurellement compatible (union de
 *  littéraux) avec StuartEnvironment -- aucune conversion nécessaire
 *  côté appelant. */
export type StuartMerchantEnvironment = "sandbox" | "production";

export type StuartDeliveryEligibilityResult =
  | { eligible: true; reasonCode: "ELIGIBLE"; merchantEnvironment: StuartMerchantEnvironment }
  | { eligible: false; reasonCode: StuartDeliveryIneligibilityReasonCode };

const KNOWN_REASON_CODES = new Set<string>([
  "ELIGIBLE",
  "INVALID_INPUT",
  "ORDER_NOT_FOUND",
  "RESTAURANT_INACTIVE",
  "ORDER_CANCELLED",
  "PAYMENT_NOT_CONFIRMED",
  "FULFILLMENT_MODE_NOT_DELIVERY",
  "DELIVERY_CONTACT_DATA_MISSING",
  "DELIVERY_MODE_NOT_ENABLED",
  "DELIVERY_PROVIDER_NOT_STUART",
  "NO_ACTIVE_STUART_FULFILLMENT_RULE",
  "STUART_CREDENTIAL_NOT_CONFIGURED",
  "STUART_MERCHANT_ENVIRONMENT_INVALID",
  "PRIOR_TERMINAL_FAILURE_EXISTS",
]);

const KNOWN_MERCHANT_ENVIRONMENTS = new Set<string>(["sandbox", "production"]);

export interface GetStuartDeliveryEligibilityInput {
  orderId: string;
  restaurantId: string;
}

/**
 * Évalue l'éligibilité livraison Stuart d'une commande, via la RPC
 * `get_stuart_delivery_eligibility` (STUART LOT D1 §A). N'ALLOUE, NE
 * CRÉE ET N'ENVOIE RIEN — lecture seule. `restaurantId` doit provenir
 * d'un contexte serveur déjà authentifié (même règle que
 * `getStuartCredentialForRestaurant`) — cette fonction elle-même ne
 * réalise AUCUNE vérification d'autorisation additionnelle.
 */
export async function getStuartDeliveryEligibility(
  input: GetStuartDeliveryEligibilityInput
): Promise<StuartDeliveryEligibilityResult> {
  const client = getServiceRoleSupabaseClient();
  let data:
    | Array<{ eligible: boolean; reason_code: string; merchant_environment: string | null }>
    | { eligible: boolean; reason_code: string; merchant_environment: string | null }
    | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("get_stuart_delivery_eligibility", {
      p_order_id: input.orderId,
      p_restaurant_id: input.restaurantId,
    }));
  } catch {
    throw new StuartEligibilityError("STUART_ELIGIBILITY_UNAVAILABLE");
  }
  if (error) {
    throw new StuartEligibilityError(`STUART_ELIGIBILITY_FAILED_${error.code ?? "UNKNOWN"}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new StuartEligibilityError("STUART_ELIGIBILITY_EMPTY_ROW");
  }

  const reasonCode = String(row.reason_code);
  if (!KNOWN_REASON_CODES.has(reasonCode)) {
    // Échec fermé : jamais laisser un reason_code inattendu (dérive de
    // schéma future) atteindre une logique d'orchestration en aval.
    throw new StuartEligibilityError(`STUART_ELIGIBILITY_UNKNOWN_REASON_CODE_${reasonCode}`);
  }

  if (row.eligible === true) {
    if (reasonCode !== "ELIGIBLE") {
      throw new StuartEligibilityError("STUART_ELIGIBILITY_INCONSISTENT_RESULT");
    }
    // STUART LOT D1 v1.2 (blocker 2, HIGH) -- l'AUTORITÉ d'environnement
    // job (mandat v1.2, "Remove the hardcoded environment. Determine
    // the environment from the authoritative merchant Stuart config.").
    // Fail-closed STRICT ici aussi, jamais seulement côté SQL -- une
    // ligne eligible=true DOIT toujours porter une valeur reconnue
    // (la RPC ne renvoie merchant_environment que sur ce chemin,
    // jamais NULL -- tout NULL/valeur inattendue ici est une
    // incohérence, jamais silencieusement tolérée).
    const merchantEnvironment = row.merchant_environment;
    if (merchantEnvironment === null || !KNOWN_MERCHANT_ENVIRONMENTS.has(merchantEnvironment)) {
      throw new StuartEligibilityError("STUART_ELIGIBILITY_UNKNOWN_MERCHANT_ENVIRONMENT");
    }
    return {
      eligible: true,
      reasonCode: "ELIGIBLE",
      merchantEnvironment: merchantEnvironment as StuartMerchantEnvironment,
    };
  }
  if (reasonCode === "ELIGIBLE") {
    throw new StuartEligibilityError("STUART_ELIGIBILITY_INCONSISTENT_RESULT");
  }
  return { eligible: false, reasonCode: reasonCode as StuartDeliveryIneligibilityReasonCode };
}
