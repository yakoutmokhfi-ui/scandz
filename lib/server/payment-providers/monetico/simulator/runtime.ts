import "server-only";
import {
  getPaymentTransactionCorrelation,
  getPaymentRuntimeProviderEnvironment,
  getPaymentProviderCredential,
} from "@/lib/server/payment-service";
import { parseMoneticoCredential } from "@/lib/server/payment-providers/monetico/credentials";
import { resolveCanonicalPublicOrigin } from "@/lib/server/canonical-public-origin";
import {
  evaluateSimulatorEnvironment,
  isSimulatorRoutingActive,
} from "@/lib/server/payment-providers/monetico/simulator/policy";
import { verifySimulatorOperatorSecret } from "@/lib/server/payment-providers/monetico/simulator/auth";
import {
  verifyInboundMerchantForm,
  SimulatorInboundError,
  type VerifiedInboundRequest,
} from "@/lib/server/payment-providers/monetico/simulator/inbound";
import {
  resolveScenario,
  type ScenarioPlan,
} from "@/lib/server/payment-providers/monetico/simulator/scenarios";
import { buildSimulatedCallback } from "@/lib/server/payment-providers/monetico/simulator/outcome";
import {
  notifyApplicationCallback,
  type NotifyResult,
} from "@/lib/server/payment-providers/monetico/simulator/notifier";
import {
  createHostedPageBinding,
  verifyHostedPageBinding,
  isSameCanonicalOrigin,
} from "@/lib/server/payment-providers/monetico/simulator/session";
import { renderHostedPage } from "@/lib/server/payment-providers/monetico/simulator/page";

/**
 * MONETICO PAYMENT SIMULATOR v1 — ORCHESTRATION (the two simulator
 * interactions, independent of HTTP; the routes are thin adapters).
 *
 *   A. HOSTED PAGE  -- the browser auto-posts the merchant form (built by
 *      the UNMODIFIED checkout runtime). We correlate `reference` to the
 *      merchant through the existing possession-free, read-only RPC
 *      `get_payment_transaction_correlation`, re-check the merchant's
 *      persisted mode is `test` (gate condition 4), load the merchant
 *      credential through the existing Vault-backed RPC, verify the
 *      form like the real TPE, cross-check the posted amount against the
 *      AUTHORITATIVE attempt amount, and render the scenario page.
 *
 *   B. DECISION     -- an authenticated OPERATOR chooses a scenario. We
 *      re-resolve everything server-side (never trusting the browser for
 *      amount/currency/mode), build the signed notifications, deliver
 *      them to the application's OWN callback route (bounded retry), and
 *      redirect the browser as Monetico would.
 *
 * ORDER OF CHECKS IS SECURITY-RELEVANT and identical in both
 * interactions: environment gate -> (auth) -> correlation -> merchant
 * mode `test` -> credential. A `live` merchant reference is refused
 * BEFORE any credential read. No RPC is called when the gate is closed.
 *
 * NO ORDER/TRANSACTION WRITE happens in this module: the ONLY mutation
 * path is the application's own callback pipeline reacting to a
 * MAC-valid notification -- exactly what a real Monetico event does.
 */

const PROVIDER_CODE = "monetico";

export type HostedPageResult =
  | { kind: "gate_closed"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "page"; html: string; verified: VerifiedInboundRequest };

export type DecisionResult =
  | { kind: "gate_closed"; reason: string }
  | { kind: "unauthorized" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "redirect";
      location: string;
      scenario: ScenarioPlan;
      notifications: NotifyResult[];
    };

interface ResolvedMerchantContext {
  restaurantId: string;
  orderId: string;
  amount: string;
  currency: string;
  credential: ReturnType<typeof parseMoneticoCredential>;
}

type ResolveFailure = { kind: "gate_closed"; reason: string } | { kind: "rejected"; reason: string };

async function resolveMerchantContext(
  reference: string
): Promise<{ ok: true; context: ResolvedMerchantContext } | { ok: false; failure: ResolveFailure }> {
  let correlation: Awaited<ReturnType<typeof getPaymentTransactionCorrelation>>;
  try {
    correlation = await getPaymentTransactionCorrelation({
      providerCode: PROVIDER_CODE,
      providerReference: reference,
    });
  } catch {
    return { ok: false, failure: { kind: "rejected", reason: "unknown_reference" } };
  }

  let environment: Awaited<ReturnType<typeof getPaymentRuntimeProviderEnvironment>>;
  try {
    environment = await getPaymentRuntimeProviderEnvironment({
      restaurantId: correlation.restaurantId,
      providerCode: PROVIDER_CODE,
    });
  } catch {
    return { ok: false, failure: { kind: "rejected", reason: "merchant_environment_unavailable" } };
  }
  const routing = isSimulatorRoutingActive(environment.mode);
  if (!routing.active) {
    return { ok: false, failure: { kind: "gate_closed", reason: routing.reason } };
  }
  if (!environment.isEnabled || environment.configurationStatus !== "verified") {
    return { ok: false, failure: { kind: "rejected", reason: "merchant_not_eligible" } };
  }

  let credential: ReturnType<typeof parseMoneticoCredential>;
  try {
    const raw = await getPaymentProviderCredential({
      restaurantId: correlation.restaurantId,
      providerCode: PROVIDER_CODE,
    });
    credential = parseMoneticoCredential(raw);
  } catch {
    return { ok: false, failure: { kind: "rejected", reason: "credential_unavailable" } };
  }

  return {
    ok: true,
    context: {
      restaurantId: correlation.restaurantId,
      orderId: correlation.orderId,
      amount: String(correlation.amount),
      currency: correlation.currency,
      credential,
    },
  };
}

function amountsMatch(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

export async function handleSimulatorHostedPage(raw: Record<string, unknown>): Promise<HostedPageResult> {
  const gate = evaluateSimulatorEnvironment();
  if (!gate.active) return { kind: "gate_closed", reason: gate.reason };

  const reference = raw["reference"];
  if (typeof reference !== "string" || reference.length === 0) {
    return { kind: "rejected", reason: "malformed" };
  }

  const resolved = await resolveMerchantContext(reference);
  if (!resolved.ok) return resolved.failure;
  const { context } = resolved;

  let verified: VerifiedInboundRequest;
  try {
    verified = verifyInboundMerchantForm(raw, context.credential);
  } catch (err) {
    return { kind: "rejected", reason: err instanceof SimulatorInboundError ? err.reason : "malformed" };
  }

  // Stricter than the real TPE (which does not know the order): the
  // posted amount must equal the authoritative attempt amount. A
  // divergence means the form was not produced by this application's
  // checkout runtime for this attempt.
  if (!amountsMatch(verified.amount, context.amount) || verified.currency !== context.currency.toUpperCase()) {
    return { kind: "rejected", reason: "amount_mismatch" };
  }

  let origin: string;
  try {
    origin = resolveCanonicalPublicOrigin();
  } catch {
    return { kind: "rejected", reason: "canonical_origin_unavailable" };
  }
  if (!isSameCanonicalOrigin(verified.urlRetourOk, origin) || !isSameCanonicalOrigin(verified.urlRetourErr, origin)) {
    return { kind: "rejected", reason: "return_url_foreign_origin" };
  }

  const binding = createHostedPageBinding({
    reference: verified.reference,
    urlRetourOk: verified.urlRetourOk,
    urlRetourErr: verified.urlRetourErr,
  });

  const html = renderHostedPage({
    verified,
    binding,
    merchantLabel: `restaurant ${context.restaurantId.slice(0, 8)}… (mode test)`,
  });
  return { kind: "page", html, verified };
}

export interface DecisionInput {
  /** Form fields of the decision POST (never query parameters). */
  body: Record<string, unknown>;
  /** Bearer token from the Authorization header, if any (alternative to
   *  the `operatorSecret` body field, for automated drivers). */
  bearer?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function handleSimulatorDecision(input: DecisionInput): Promise<DecisionResult> {
  const gate = evaluateSimulatorEnvironment();
  if (!gate.active) return { kind: "gate_closed", reason: gate.reason };

  const provided = typeof input.body["operatorSecret"] === "string" ? input.body["operatorSecret"] : input.bearer;
  if (!verifySimulatorOperatorSecret(provided)) return { kind: "unauthorized" };

  const scenario = resolveScenario(input.body["scenario"]);
  if (!scenario) return { kind: "invalid", reason: "unknown_scenario" };

  const reference = input.body["reference"];
  const urlRetourOk = input.body["url_retour_ok"];
  const urlRetourErr = input.body["url_retour_err"];
  if (typeof reference !== "string" || typeof urlRetourOk !== "string" || typeof urlRetourErr !== "string") {
    return { kind: "invalid", reason: "malformed" };
  }
  if (!verifyHostedPageBinding({ reference, urlRetourOk, urlRetourErr }, input.body["binding"])) {
    return { kind: "invalid", reason: "binding_invalid" };
  }

  let origin: string;
  try {
    origin = resolveCanonicalPublicOrigin();
  } catch {
    return { kind: "invalid", reason: "canonical_origin_unavailable" };
  }
  if (!isSameCanonicalOrigin(urlRetourOk, origin) || !isSameCanonicalOrigin(urlRetourErr, origin)) {
    return { kind: "invalid", reason: "return_url_foreign_origin" };
  }

  const resolved = await resolveMerchantContext(reference);
  if (!resolved.ok) {
    return resolved.failure.kind === "gate_closed"
      ? resolved.failure
      : { kind: "invalid", reason: resolved.failure.reason };
  }
  const { context } = resolved;

  const now = input.now ?? new Date();
  const notifications: NotifyResult[] = [];
  for (const step of scenario.steps) {
    const fields = buildSimulatedCallback({
      step,
      reference,
      tpe: context.credential.tpe,
      amount: context.amount,
      currency: context.currency,
      credential: context.credential,
      now,
    });
    const result = await notifyApplicationCallback({
      canonicalOrigin: origin,
      fields,
      simulatedTransportFailures: scenario.simulatedTransportFailures,
      fetchImpl: input.fetchImpl,
    });
    notifications.push(result);
  }

  return {
    kind: "redirect",
    location: scenario.redirect === "ok" ? urlRetourOk : urlRetourErr,
    scenario,
    notifications,
  };
}
