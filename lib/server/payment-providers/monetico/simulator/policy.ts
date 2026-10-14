import "server-only";

/**
 * MONETICO PAYMENT SIMULATOR v1.1 — ACTIVATION POLICY (security gate).
 *
 * The simulator substitutes ONLY the external party (Monetico's hosted
 * payment page + its server-to-server notifier). It is a non-production
 * facility and must be structurally unreachable in production AND
 * structurally unable to touch the production Supabase project. This
 * module is the SINGLE authority deciding whether the simulator may
 * (a) be routed to by the checkout runtime and (b) serve its own routes.
 *
 * v1.1 (Cat Turing audit remediation) -- the gate now has SEVEN
 * independent conditions; ALL must hold, fail-closed on any missing,
 * malformed or inconsistent value. Every negative verdict names the
 * condition that closed the gate.
 *
 *   1. EXPLICIT ENABLEMENT  (`PAYMENT_MONETICO_SIMULATOR_ENABLED === "true"`).
 *   2. DEPLOYMENT ALLOWLIST (MSIM-ENV-02): `VERCEL_ENV` MUST be present
 *      and MUST be listed in `PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS`
 *      (comma-separated; only "preview" and "development" are ever
 *      accepted in that list -- "production" is rejected even if listed).
 *      Missing platform metadata, unknown values and production all
 *      refuse. `NODE_ENV` is NEVER consulted (same discipline as the
 *      repository's other activation gates).
 *   3. OPERATOR SECRET configured (`PAYMENT_MONETICO_SIMULATOR_SECRET`,
 *      >= 32 chars) -- scenario decisions must be authenticable.
 *   4. TENANT BOUNDARY (MSIM-SEC-01, v1.2 -- "a different project ref is
 *      not proof of non-production unless the trusted authority is
 *      protected from the same configuration errors"): the authority is
 *      NO LONGER an environment variable. It is `get_simulator_authority()`,
 *      a SQL function that exists ONLY on the dedicated test project
 *      (DRAFT-lot-monetico-simulator-test-authority-v1.sql) and that
 *      refuses to answer as soon as a `live` merchant exists in that
 *      database. The gate then requires, against the DB-returned
 *      `project_ref`:
 *        - the ref derived from `NEXT_PUBLIC_SUPABASE_URL` to equal it;
 *        - the `ref` claim of `SUPABASE_SERVICE_ROLE_KEY` to equal it and
 *          its `role` to be "service_role".
 *      Mutually consistent environment variables pointing at PRODUCTION
 *      cannot open the gate: production has no authority function. The
 *      env-level `PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF` /
 *      `PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES` of v1.1 are REMOVED
 *      (they were the defeatable part). `SCANYM_PRODUCTION_SUPABASE_PROJECT_REF`
 *      remains an OPTIONAL additional deny (defense in depth).
 *      Fail-closed: authority unreadable (absent function, transport
 *      error, live merchant present, malformed row) => closed.
 *   5. SYNTHETIC CREDENTIALS ONLY (MSIM-SEC-01): per merchant, the
 *      credential's TPE MUST be in the DB authority's `allowed_tpes`.
 *   6. NO LIVE FULFILLMENT (MSIM-SIDE-04): `STUART_LIVE_ACTIVATION_ENABLED`
 *      MUST NOT be "true" in the same environment -- simulated payments
 *      can never coexist with a live delivery activation.
 *   7. MERCHANT MODE strictly "test" (persisted `payment_provider_configs
 *      .mode`, P3-B4), re-read server-side per request.
 *
 * Conditions 1-4 and 6 are environment-level (`evaluateSimulatorEnvironment`);
 * 5 and 7 are per-merchant (`isSimulatorRoutingActive`, `isTpeAllowed`).
 * `process.env` is read only through the injectable `env` parameter.
 */

export const SIMULATOR_ENABLED_ENV = "PAYMENT_MONETICO_SIMULATOR_ENABLED";
export const SIMULATOR_SECRET_ENV = "PAYMENT_MONETICO_SIMULATOR_SECRET";
export const SIMULATOR_ALLOWED_ENVIRONMENTS_ENV = "PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS";
export const PRODUCTION_PROJECT_REF_ENV = "SCANYM_PRODUCTION_SUPABASE_PROJECT_REF";
export const STUART_LIVE_ACTIVATION_ENV = "STUART_LIVE_ACTIVATION_ENABLED";
export const SIMULATOR_SECRET_MIN_LENGTH = 32;

/** The ONLY deployment environments that may ever be allowlisted. */
export const ACCEPTABLE_ENVIRONMENTS = new Set(["preview", "development"]);

export type SimulatorEnvSource = Readonly<Record<string, string | undefined>>;

export type SimulatorGateReason =
  | "not_enabled"
  | "platform_environment_missing"
  | "production_deployment"
  | "environment_not_allowlisted"
  | "allowlist_missing_or_invalid"
  | "secret_missing_or_too_short"
  | "authority_unavailable"
  | "authority_project_ref_invalid"
  | "test_project_ref_equals_production"
  | "supabase_url_project_mismatch"
  | "service_role_key_project_mismatch"
  | "service_role_key_role_mismatch"
  | "service_role_key_unreadable"
  | "stuart_live_activation_enabled"
  | "merchant_mode_not_test"
  | "merchant_tpe_not_allowlisted";

export type SimulatorEnvironmentVerdict = { active: true } | { active: false; reason: SimulatorGateReason };

const PROJECT_REF_PATTERN = /^[a-z0-9]{10,40}$/;
const TPE_PATTERN = /^[A-Za-z0-9]{7}$/;

/** Parses a comma-separated allowlist; returns null when empty/invalid. */
function parseList(raw: string | undefined, itemPattern: RegExp): string[] | null {
  if (typeof raw !== "string") return null;
  const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0) return null;
  for (const item of items) if (!itemPattern.test(item)) return null;
  return items;
}

/** Project ref from `https://<ref>.supabase.co`; null for anything else. */
export function projectRefFromSupabaseUrl(url: string | undefined): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const match = /^([a-z0-9]{10,40})\.supabase\.co$/.exec(parsed.hostname);
  return match ? match[1] : null;
}

/** `ref`/`role` claims of a Supabase service-role JWT (payload only --
 *  identity binding, not signature verification; the key is still only
 *  ever USED by the existing client). Null when unreadable. */
export function readServiceRoleKeyClaims(key: string | undefined): { ref: string | null; role: string | null } | null {
  if (typeof key !== "string") return null;
  const parts = key.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as Record<string, unknown>;
    return {
      ref: typeof payload.ref === "string" ? payload.ref : null,
      role: typeof payload.role === "string" ? payload.role : null,
    };
  } catch {
    return null;
  }
}

/** Condition 2 -- MSIM-ENV-02. */
export function evaluateDeploymentEnvironment(env: SimulatorEnvSource): SimulatorEnvironmentVerdict {
  const vercelEnv = env.VERCEL_ENV;
  if (typeof vercelEnv !== "string" || vercelEnv.length === 0) {
    return { active: false, reason: "platform_environment_missing" };
  }
  if (vercelEnv === "production") return { active: false, reason: "production_deployment" };
  const allowlist = parseList(env[SIMULATOR_ALLOWED_ENVIRONMENTS_ENV], /^[a-z]+$/);
  if (!allowlist || allowlist.some((e) => !ACCEPTABLE_ENVIRONMENTS.has(e))) {
    return { active: false, reason: "allowlist_missing_or_invalid" };
  }
  if (!allowlist.includes(vercelEnv)) return { active: false, reason: "environment_not_allowlisted" };
  return { active: true };
}

/** DB-returned authority (see authority.ts); `null` = unreadable. */
export interface TrustedAuthority {
  projectRef: string;
  allowedTpes: string[];
}

/** Condition 4 -- MSIM-SEC-01 tenant boundary, anchored on the DB authority. */
export function evaluateTenantBoundary(env: SimulatorEnvSource, authority: TrustedAuthority | null): SimulatorEnvironmentVerdict {
  if (authority === null) return { active: false, reason: "authority_unavailable" };
  const authorized = authority.projectRef;
  if (typeof authorized !== "string" || !PROJECT_REF_PATTERN.test(authorized)) {
    return { active: false, reason: "authority_project_ref_invalid" };
  }
  const production = env[PRODUCTION_PROJECT_REF_ENV];
  if (typeof production === "string" && production.trim().length > 0 && production.trim() === authorized) {
    return { active: false, reason: "test_project_ref_equals_production" };
  }
  const urlRef = projectRefFromSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (urlRef !== authorized) return { active: false, reason: "supabase_url_project_mismatch" };
  const claims = readServiceRoleKeyClaims(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!claims) return { active: false, reason: "service_role_key_unreadable" };
  if (claims.role !== "service_role") return { active: false, reason: "service_role_key_role_mismatch" };
  if (claims.ref !== authorized) return { active: false, reason: "service_role_key_project_mismatch" };
  return { active: true };
}

/**
 * ENVIRONMENT-ONLY conditions (1, 2, 3, 6) -- PURE, no I/O. Used as the
 * cheap first stage: when it is closed, the DB authority is never even
 * queried (no RPC while closed, asserted by tests).
 */
export function evaluateSimulatorEnvironmentPreconditions(env: SimulatorEnvSource = process.env): SimulatorEnvironmentVerdict {
  if (env[SIMULATOR_ENABLED_ENV] !== "true") return { active: false, reason: "not_enabled" };
  const deployment = evaluateDeploymentEnvironment(env);
  if (!deployment.active) return deployment;
  const secret = env[SIMULATOR_SECRET_ENV];
  if (typeof secret !== "string" || secret.length < SIMULATOR_SECRET_MIN_LENGTH) {
    return { active: false, reason: "secret_missing_or_too_short" };
  }
  if (env[STUART_LIVE_ACTIVATION_ENV] === "true") return { active: false, reason: "stuart_live_activation_enabled" };
  return { active: true };
}

/**
 * FULL environment verdict: preconditions + DB-anchored tenant boundary.
 * `authority` is the result of `getSimulatorAuthority()` (null when it
 * threw). PURE given its inputs.
 */
export function evaluateSimulatorEnvironment(env: SimulatorEnvSource, authority: TrustedAuthority | null): SimulatorEnvironmentVerdict {
  const pre = evaluateSimulatorEnvironmentPreconditions(env);
  if (!pre.active) return pre;
  const tenant = evaluateTenantBoundary(env, authority);
  if (!tenant.active) return tenant;
  if (authority!.allowedTpes.length === 0 || authority!.allowedTpes.some((t) => !TPE_PATTERN.test(t))) {
    return { active: false, reason: "authority_project_ref_invalid" };
  }
  return { active: true };
}

/** Condition 5 -- synthetic credential allowlist from the DB authority, per merchant. */
export function isTpeAllowed(tpe: unknown, authority: TrustedAuthority | null): boolean {
  return !!authority && typeof tpe === "string" && TPE_PATTERN.test(tpe) && authority.allowedTpes.includes(tpe);
}

export type SimulatorRoutingVerdict = SimulatorEnvironmentVerdict;

/**
 * Per-merchant decision used by the checkout runtime (endpoint
 * substitution) and by the simulator routes. `mode` is the PERSISTED
 * merchant mode (P3-B4) -- anything but the exact string "test" closes
 * the gate. PURE given its inputs.
 */
export function isSimulatorRoutingActive(mode: unknown, env: SimulatorEnvSource, authority: TrustedAuthority | null): SimulatorRoutingVerdict {
  const environment = evaluateSimulatorEnvironment(env, authority);
  if (!environment.active) return environment;
  if (mode !== "test") return { active: false, reason: "merchant_mode_not_test" };
  return { active: true };
}

export const SIMULATOR_HOSTED_PAGE_PATH = "/api/internal/payments/monetico/simulator/page";
export const SIMULATOR_DECIDE_PATH = "/api/internal/payments/monetico/simulator/decide";
/** Real application callback route the simulator notifies (server-to-server). */
export const APPLICATION_CALLBACK_PATH = "/api/payments/monetico/callback";

/** Simulator submission URL from the canonical public origin (passed in,
 *  never resolved here -- this module stays pure). */
export function buildSimulatorSubmissionUrl(canonicalOrigin: string): string {
  return new URL(SIMULATOR_HOSTED_PAGE_PATH, canonicalOrigin).toString();
}
