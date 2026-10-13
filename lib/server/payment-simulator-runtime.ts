import "server-only";

/**
 * MONETICO PAYMENT SIMULATOR v1 — GENERIC FACADE for the HTTP routes.
 *
 * Same layering discipline as `payment-checkout-runtime.ts` /
 * `payment-callback-runtime.ts`: files under `app/` import ONLY this
 * generic `lib/server/payment-*` layer (structural rule v111h: nothing
 * under app/ or components/ imports `lib/server/payment-providers/*`),
 * and this generic layer carries NO provider-specific technical
 * signature (structural rule v110c). All Monetico-specific simulator
 * logic lives in `lib/server/payment-providers/monetico/simulator/`.
 */

export {
  handleSimulatorHostedPage,
  handleSimulatorDecision,
  type HostedPageResult,
  type DecisionResult,
  type DecisionInput,
} from "@/lib/server/payment-providers/monetico/simulator/runtime";

export { evaluateSimulatorEnvironment } from "@/lib/server/payment-providers/monetico/simulator/policy";
export { listScenarios as listSimulatorScenarios } from "@/lib/server/payment-providers/monetico/simulator/scenarios";
export { renderRejectionPage as renderSimulatorRejectionPage } from "@/lib/server/payment-providers/monetico/simulator/page";

import { verifySimulatorOperatorSecret, extractBearer } from "@/lib/server/payment-providers/monetico/simulator/auth";

/** `true` only for a valid `Authorization: Bearer <operator secret>` header. */
export function verifySimulatorOperatorBearer(authorizationHeader: string | null | undefined): boolean {
  return verifySimulatorOperatorSecret(extractBearer(authorizationHeader));
}

/** Bearer token value or null -- for routes that pass it through to the decision. */
export function extractSimulatorBearer(authorizationHeader: string | null | undefined): string | null {
  return extractBearer(authorizationHeader);
}
