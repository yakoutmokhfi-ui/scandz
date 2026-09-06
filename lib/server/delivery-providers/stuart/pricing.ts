import "server-only";
import { resolveStuartEnvironment } from "@/lib/server/delivery-providers/stuart/environment";
import { getStuartAccessToken } from "@/lib/server/delivery-providers/stuart/auth";
import type { StuartCreateJobPayload } from "@/lib/server/delivery-providers/stuart/types";

/**
 * DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.
 *
 * Endpoint confirmé (contrat actuel officiel) : `POST /v2/jobs/pricing`.
 * Même structure de charge utile que Create Job (confirmé) --
 * réutilise `StuartCreateJobPayload`, jamais un second type dupliqué.
 *
 * VERROU SANDBOX STRICT (mandat §20, littéral) : "Likewise, real
 * pricing calls in this v2 stream must be Sandbox-only. No Production
 * pricing call." -- même garde exacte que create-job.ts.
 *
 * AUTORITÉ DE PRIX (mandat §16) : le prix retourné par Stuart est
 * TOUJOURS traité comme une DONNÉE FOURNIE PAR LE PRESTATAIRE, jamais
 * appliqué automatiquement à `orders.total`/`orders.delivery_fee`
 * (INCHANGÉS, sous l'autorité exclusive de
 * `resolve_delivery_fulfillment`, Payment Stream B inchangé) -- ce
 * wrapper ne MUTE JAMAIS aucune donnée de commande, il se contente de
 * retourner la réponse brute Stuart à l'appelant.
 */

export class StuartPricingError extends Error {
  constructor(message: string = "STUART_PRICING_ERROR") {
    super(message);
    this.name = "StuartPricingError";
  }
}

export class StuartPricingProductionForbiddenError extends StuartPricingError {
  constructor() {
    super("STUART_V2_PRICING_PRODUCTION_FORBIDDEN");
    this.name = "StuartPricingProductionForbiddenError";
  }
}

const PRICING_PATH = "/v2/jobs/pricing";
const PRICING_TIMEOUT_MS = 15_000;

export interface StuartPricingResult {
  raw: unknown;
  httpStatus: number;
}

/**
 * Interroge le prix Stuart pour une charge utile de job -- SANDBOX
 * UNIQUEMENT pour ce flux v2. ÉCHOUE AVANT TOUT APPEL RÉSEAU si
 * l'environnement résolu n'est pas EXACTEMENT "sandbox".
 *
 * Ne mute JAMAIS `orders.total` ni `orders.delivery_fee` -- retourne
 * uniquement la réponse brute, à la charge exclusive de l'appelant
 * de décider quoi en faire (jamais automatique, mandat §16).
 */
export async function getStuartSandboxPricing(payload: StuartCreateJobPayload): Promise<StuartPricingResult> {
  const { environment, baseUrl } = resolveStuartEnvironment();
  if (environment !== "sandbox") {
    throw new StuartPricingProductionForbiddenError();
  }

  const accessToken = await getStuartAccessToken();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${PRICING_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    void err;
    throw new StuartPricingError("STUART_PRICING_UNAVAILABLE");
  } finally {
    clearTimeout(timeoutId);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new StuartPricingError("STUART_PRICING_MALFORMED_RESPONSE");
  }

  if (!response.ok) {
    throw new StuartPricingError(`STUART_PRICING_FAILED_${response.status}`);
  }

  return { raw: parsed, httpStatus: response.status };
}
