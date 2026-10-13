import "server-only";

/**
 * MONETICO PAYMENT SIMULATOR v1 — ACTIVATION POLICY (security gate).
 *
 * The simulator substitutes ONLY the external party (Monetico's hosted
 * payment page + its server-to-server notifier). It is a non-production
 * facility and must be structurally unreachable in production. This
 * module is the SINGLE authority deciding whether the simulator may
 * (a) be routed to by the checkout runtime and (b) serve its own routes.
 *
 * FOUR INDEPENDENT CONDITIONS -- ALL must hold (fail-closed on any
 * missing/unknown value):
 *
 *   1. EXPLICIT ENABLEMENT: `PAYMENT_MONETICO_SIMULATOR_ENABLED` is the
 *      exact string "true" (same discipline as
 *      `PAYMENT_CHECKOUT_RUNTIME_ENABLED`).
 *   2. NON-PRODUCTION DEPLOYMENT, POSITIVELY IDENTIFIED:
 *      `VERCEL_ENV` is "preview" or "development" (Vercel sets it on
 *      every deployment; "production" closes the gate unconditionally).
 *      When `VERCEL_ENV` is ABSENT (local machine / CI test runner), the
 *      deployment is identified by `NODE_ENV !== "production"` -- but
 *      `NODE_ENV` is NEVER used alone when `VERCEL_ENV` is present, since
 *      Vercel preview builds also run with NODE_ENV=production (CTO
 *      decision Q3). Any other / unknown `VERCEL_ENV` value closes the
 *      gate.
 *   3. OPERATOR SECRET CONFIGURED: `PAYMENT_MONETICO_SIMULATOR_SECRET`
 *      is present and at least 32 characters. Without it, scenario
 *      selection could not be authenticated, so the whole facility is
 *      off -- never "enabled but unauthenticated".
 *   4. MERCHANT MODE STRICTLY "test" (persisted `payment_provider_configs
 *      .mode`, PAYMENT P3-B4): a "live" merchant is NEVER routed to the
 *      simulator, whatever the environment says.
 *
 * Conditions 1-3 are environment-level (`evaluateSimulatorEnvironment`);
 * condition 4 is per-merchant (`isSimulatorRoutingActive`). Every
 * negative answer carries a `reason` so tests can assert WHICH condition
 * closed the gate (never a bare boolean that could pass by accident).
 *
 * This module reads `process.env` only through the injectable `env`
 * parameter (default: `process.env`) so the full truth table is testable
 * without mutating the global environment.
 */

export const SIMULATOR_ENABLED_ENV = "PAYMENT_MONETICO_SIMULATOR_ENABLED";
export const SIMULATOR_SECRET_ENV = "PAYMENT_MONETICO_SIMULATOR_SECRET";
export const SIMULATOR_SECRET_MIN_LENGTH = 32;

export type SimulatorEnvSource = Readonly<Record<string, string | undefined>>;

export type SimulatorEnvironmentVerdict =
  | { active: true }
  | {
      active: false;
      reason:
        | "not_enabled"
        | "production_deployment"
        | "unknown_deployment_environment"
        | "secret_missing_or_too_short";
    };

/** Positive non-production identification -- see file comment, cond. 2. */
export function isNonProductionDeployment(env: SimulatorEnvSource): boolean {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === "production") return false;
  if (vercelEnv === "preview" || vercelEnv === "development") return true;
  if (vercelEnv === undefined || vercelEnv === "") {
    // No platform discriminator: local dev / test runner. NODE_ENV is
    // acceptable HERE ONLY because no platform value exists to contradict it.
    return env.NODE_ENV !== "production";
  }
  // Unknown value -- fail closed.
  return false;
}

export function evaluateSimulatorEnvironment(
  env: SimulatorEnvSource = process.env
): SimulatorEnvironmentVerdict {
  if (env[SIMULATOR_ENABLED_ENV] !== "true") {
    return { active: false, reason: "not_enabled" };
  }
  if (env.VERCEL_ENV === "production") {
    return { active: false, reason: "production_deployment" };
  }
  if (!isNonProductionDeployment(env)) {
    return { active: false, reason: "unknown_deployment_environment" };
  }
  const secret = env[SIMULATOR_SECRET_ENV];
  if (typeof secret !== "string" || secret.length < SIMULATOR_SECRET_MIN_LENGTH) {
    return { active: false, reason: "secret_missing_or_too_short" };
  }
  return { active: true };
}

export type SimulatorRoutingVerdict =
  | { active: true }
  | {
      active: false;
      reason: Exclude<SimulatorEnvironmentVerdict, { active: true }>["reason"] | "merchant_mode_not_test";
    };

/**
 * Per-merchant decision used by the checkout runtime (endpoint
 * substitution) and by the simulator routes (serving a given reference).
 * `mode` is the PERSISTED merchant mode (P3-B4) -- any value other than
 * the exact string "test" closes the gate, including "live" and
 * anything unexpected.
 */
export function isSimulatorRoutingActive(
  mode: unknown,
  env: SimulatorEnvSource = process.env
): SimulatorRoutingVerdict {
  const environment = evaluateSimulatorEnvironment(env);
  if (!environment.active) return environment;
  if (mode !== "test") return { active: false, reason: "merchant_mode_not_test" };
  return { active: true };
}

/** Path (relative to the canonical public origin) of the simulated hosted
 *  payment page. The checkout runtime POSTs the merchant form here instead
 *  of the real sandbox endpoint (endpoint.ts) when routing is active. */
export const SIMULATOR_HOSTED_PAGE_PATH = "/api/internal/payments/monetico/simulator/page";
export const SIMULATOR_DECIDE_PATH = "/api/internal/payments/monetico/simulator/decide";
/** Real application callback route the simulator notifies (server-to-server). */
export const APPLICATION_CALLBACK_PATH = "/api/payments/monetico/callback";

/**
 * Builds the simulator submission URL from the canonical public origin
 * (`resolveCanonicalPublicOrigin()`, never a request header). The origin
 * is passed in, not resolved here, so this module stays pure.
 */
export function buildSimulatorSubmissionUrl(canonicalOrigin: string): string {
  return new URL(SIMULATOR_HOSTED_PAGE_PATH, canonicalOrigin).toString();
}
