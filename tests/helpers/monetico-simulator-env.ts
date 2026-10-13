/**
 * MONETICO PAYMENT SIMULATOR v1.1 — SYNTHETIC TEST ENVIRONMENT (TEST ONLY).
 *
 * Everything here is synthetic: a fake dedicated test project ref, a
 * structurally valid (unsigned) service-role JWT carrying that ref, an
 * operator secret, and the allowlists. No value resembles a real
 * credential; all secrets are suffixed DO-NOT-USE.
 */

export const TEST_PROJECT_REF = "simtestproj00001";
export const OTHER_PROJECT_REF = "prodprojectref01";
export const TEST_SUPABASE_URL = `https://${TEST_PROJECT_REF}.supabase.co`;
export const OPERATOR_SECRET = "v164-simulator-operator-secret-synthetic-DO-NOT-USE-0001";
export const CRON_SECRET = "v164-cron-secret-synthetic-DO-NOT-USE-000000000";

/** Synthetic Supabase-style JWT: header.payload.signature, unsigned. */
export function syntheticServiceRoleJwt(ref: string, role = "service_role"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role, iat: 1700000000, exp: 4102444800 })}.SYNTHETIC-SIGNATURE-DO-NOT-USE`;
}

export const SYNTHETIC_TPES = { A: "1234567", C: "7654321" } as const;
/** B is a "real" merchant TPE deliberately NOT allowlisted. */
export const REAL_LOOKING_TPE_B = "2345678";

/** Environment that opens every gate condition (v1.1). */
export function openGateEnv(): Record<string, string> {
  return {
    PAYMENT_MONETICO_SIMULATOR_ENABLED: "true",
    PAYMENT_MONETICO_SIMULATOR_SECRET: OPERATOR_SECRET,
    PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,development",
    VERCEL_ENV: "preview",
    PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
    SCANYM_PRODUCTION_SUPABASE_PROJECT_REF: OTHER_PROJECT_REF,
    NEXT_PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(TEST_PROJECT_REF),
    PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: `${SYNTHETIC_TPES.A},${SYNTHETIC_TPES.C}`,
    STUART_LIVE_ACTIVATION_ENABLED: "false",
    PAYMENT_CHECKOUT_RUNTIME_ENABLED: "true",
    SCANYM_PUBLIC_ORIGIN: "https://checkout.example.test",
  };
}

export const MANAGED_ENV_KEYS = [
  ...Object.keys(openGateEnv()),
  "NODE_ENV",
  "CRON_SECRET",
] as const;

/** Applies `overrides` on top of the process env for the duration of `fn`. */
export async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const keys = new Set<string>([...MANAGED_ENV_KEYS, ...Object.keys(overrides)]);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  }
}

/** Installs the open-gate env process-wide (for files that need it at import time). */
export function installOpenGateEnvGlobally(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(openGateEnv())) env[k] = v;
  delete env.NODE_ENV;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
  env.PAYMENT_RETURN_RELAY_KEY_V1 ??= "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
  env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";
  env.CRON_SECRET = CRON_SECRET;
}
