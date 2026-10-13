import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * MONETICO PAYMENT SIMULATOR v1 — SECURITY-GATE TESTS.
 *
 * Proves the activation policy (four independent conditions), the
 * operator authentication, the stateless binding, the production
 * rejection of BOTH simulator routes, the rejection of unauthenticated
 * / query-parameter scenario selection, and that the checkout runtime
 * substitutes the endpoint ONLY under the gate (a `live` merchant is
 * never routed to the simulator, whatever the environment).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "v163-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

const policy = await import("../lib/server/payment-providers/monetico/simulator/policy.ts");
const auth = await import("../lib/server/payment-providers/monetico/simulator/auth.ts");
const session = await import("../lib/server/payment-providers/monetico/simulator/session.ts");
const { NextRequest } = await import("next/server");
const { POST: pagePOST, GET: pageGET } = await import(
  "../app/api/internal/payments/monetico/simulator/page/route.ts"
);
const { POST: decidePOST } = await import("../app/api/internal/payments/monetico/simulator/decide/route.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");
const { MONETICO_TEST_PAYMENT_SUBMISSION_URL, MONETICO_LIVE_PAYMENT_SUBMISSION_URL } = await import(
  "../lib/server/payment-providers/monetico/endpoint.ts"
);
const { InMemoryPaymentDb } = await import("./helpers/monetico-simulator-db.ts");

const SECRET = "v163-simulator-operator-secret-synthetic-DO-NOT-USE-0001";
const ENV_KEYS = [
  "PAYMENT_MONETICO_SIMULATOR_ENABLED",
  "PAYMENT_MONETICO_SIMULATOR_SECRET",
  "VERCEL_ENV",
  "NODE_ENV",
  "PAYMENT_CHECKOUT_RUNTIME_ENABLED",
] as const;

async function withEnv<T>(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) {
    if (k in overrides) {
      const v = overrides[k];
      if (v === undefined) delete process.env[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else (process.env as Record<string, string | undefined>)[k] = saved[k];
    }
  }
}

const OPEN_GATE = {
  PAYMENT_MONETICO_SIMULATOR_ENABLED: "true",
  PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET,
  VERCEL_ENV: undefined,
  NODE_ENV: "test",
  PAYMENT_CHECKOUT_RUNTIME_ENABLED: "true",
} as const;

// --------------------------------------------------------------------
// 1. Activation policy -- full truth table
// --------------------------------------------------------------------

test("GATE: all four conditions required -- truth table over enabled × deployment × secret × mode", () => {
  const good = { PAYMENT_MONETICO_SIMULATOR_ENABLED: "true", VERCEL_ENV: "preview", PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET };
  assert.deepEqual(policy.isSimulatorRoutingActive("test", good), { active: true });

  // enabled
  for (const bad of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    const v = policy.isSimulatorRoutingActive("test", { ...good, PAYMENT_MONETICO_SIMULATOR_ENABLED: bad });
    assert.deepEqual(v, { active: false, reason: "not_enabled" }, `enabled=${JSON.stringify(bad)}`);
  }
  // deployment
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...good, VERCEL_ENV: "production" }), {
    active: false,
    reason: "production_deployment",
  });
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...good, VERCEL_ENV: "staging" }), {
    active: false,
    reason: "unknown_deployment_environment",
  });
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...good, VERCEL_ENV: "development" }), { active: true });
  // secret
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...good, PAYMENT_MONETICO_SIMULATOR_SECRET: undefined }), {
    active: false,
    reason: "secret_missing_or_too_short",
  });
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...good, PAYMENT_MONETICO_SIMULATOR_SECRET: "short" }), {
    active: false,
    reason: "secret_missing_or_too_short",
  });
  // mode
  for (const mode of ["live", "LIVE", "Test", "", undefined, null, 1, "sandbox"]) {
    assert.deepEqual(policy.isSimulatorRoutingActive(mode, good), { active: false, reason: "merchant_mode_not_test" }, `mode=${String(mode)}`);
  }
});

test("GATE: NODE_ENV is NEVER the discriminator when VERCEL_ENV is present (preview builds run NODE_ENV=production); it only applies when no platform value exists", () => {
  // Vercel preview + NODE_ENV=production -> OPEN (CTO Q3: preview builds also run NODE_ENV=production).
  assert.equal(policy.isNonProductionDeployment({ VERCEL_ENV: "preview", NODE_ENV: "production" }), true);
  // Vercel production + NODE_ENV=development -> CLOSED (platform value wins).
  assert.equal(policy.isNonProductionDeployment({ VERCEL_ENV: "production", NODE_ENV: "development" }), false);
  // No platform value: NODE_ENV decides.
  assert.equal(policy.isNonProductionDeployment({ NODE_ENV: "production" }), false);
  assert.equal(policy.isNonProductionDeployment({ NODE_ENV: "test" }), true);
  assert.equal(policy.isNonProductionDeployment({}), true);
  // Unknown platform value -> CLOSED.
  assert.equal(policy.isNonProductionDeployment({ VERCEL_ENV: "something-else", NODE_ENV: "test" }), false);
});

test("GATE: production is refused even with every other condition satisfied and NODE_ENV lying", () => {
  const v = policy.evaluateSimulatorEnvironment({
    PAYMENT_MONETICO_SIMULATOR_ENABLED: "true",
    PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET,
    VERCEL_ENV: "production",
    NODE_ENV: "development",
  });
  assert.deepEqual(v, { active: false, reason: "production_deployment" });
});

// --------------------------------------------------------------------
// 2. Operator authentication and binding
// --------------------------------------------------------------------

test("AUTH: operator secret -- constant-time exact match; short/missing configured secret disables auth entirely", () => {
  const env = { PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET };
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET, env), true);
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET + "x", env), false);
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET.slice(0, -1), env), false);
  assert.equal(auth.verifySimulatorOperatorSecret("", env), false);
  assert.equal(auth.verifySimulatorOperatorSecret(undefined, env), false);
  assert.equal(auth.verifySimulatorOperatorSecret(123, env), false);
  assert.equal(auth.verifySimulatorOperatorSecret("short", { PAYMENT_MONETICO_SIMULATOR_SECRET: "short" }), false, "a too-short configured secret never authenticates anyone");
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET, {}), false);
  assert.equal(auth.extractBearer(`Bearer ${SECRET}`), SECRET);
  assert.equal(auth.extractBearer(`Basic abc`), null);
  assert.equal(auth.extractBearer(null), null);
});

test("BINDING: HMAC binding ties reference + both return URLs; any swap or foreign secret fails; same-origin check", () => {
  const env = { PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET };
  const b = { reference: "abc123", urlRetourOk: "https://checkout.example.test/checkout/return/ok?x=1", urlRetourErr: "https://checkout.example.test/checkout/return/err?x=1" };
  const token = session.createHostedPageBinding(b, env);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(session.verifyHostedPageBinding(b, token, env), true);
  assert.equal(session.verifyHostedPageBinding({ ...b, reference: "abc124" }, token, env), false);
  assert.equal(session.verifyHostedPageBinding({ ...b, urlRetourOk: "https://evil.example/ok" }, token, env), false);
  assert.equal(session.verifyHostedPageBinding({ ...b, urlRetourOk: b.urlRetourErr, urlRetourErr: b.urlRetourOk }, token, env), false);
  assert.equal(session.verifyHostedPageBinding(b, token, { PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET + "2" }), false);
  assert.equal(session.verifyHostedPageBinding(b, "not-hex", env), false);
  assert.equal(session.isSameCanonicalOrigin(b.urlRetourOk, "https://checkout.example.test"), true);
  assert.equal(session.isSameCanonicalOrigin("https://checkout.example.test.evil.example/ok", "https://checkout.example.test"), false);
  assert.equal(session.isSameCanonicalOrigin("javascript:alert(1)", "https://checkout.example.test"), false);
});

// --------------------------------------------------------------------
// 3. Routes: 404 when gated off (production / disabled), 401 without
//    operator secret, query-string scenario ignored
// --------------------------------------------------------------------

function formRequest(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new NextRequest(`https://checkout.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

test("ROUTES: production deployment -> both simulator routes answer 404 with empty body, no RPC call", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  await withEnv({ ...OPEN_GATE, VERCEL_ENV: "production" }, async () => {
    const page = await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }));
    assert.equal(page.status, 404);
    assert.equal(await page.text(), "");
    const list = await pageGET(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/page", { headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(list.status, 404);
    const decide = await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", operatorSecret: SECRET, reference: "abc" }));
    assert.equal(decide.status, 404);
  });
  assert.deepEqual(db.calls, [], "no RPC may be called while the gate is closed");
});

test("ROUTES: simulator not enabled -> 404 on both routes even outside production", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  await withEnv({ ...OPEN_GATE, PAYMENT_MONETICO_SIMULATOR_ENABLED: undefined }, async () => {
    assert.equal((await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }))).status, 404);
    assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", operatorSecret: SECRET }))).status, 404);
  });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: decision without operator secret -> 401 before any RPC; wrong secret -> 401; secret in query string is ignored", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  await withEnv(OPEN_GATE, async () => {
    const noSecret = await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", reference: "abc" }));
    assert.equal(noSecret.status, 401);
    const wrong = await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", reference: "abc", operatorSecret: "nope" }));
    assert.equal(wrong.status, 401);
    const inQuery = await decidePOST(
      new NextRequest(`https://checkout.example.test/api/internal/payments/monetico/simulator/decide?operatorSecret=${encodeURIComponent(SECRET)}&scenario=paid`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ reference: "abc" }).toString(),
      })
    );
    assert.equal(inQuery.status, 401, "secret passed in the query string must NOT authenticate");
  });
  assert.deepEqual(db.calls, [], "unauthenticated decisions never reach any RPC");
});

test("ROUTES: authenticated decision with scenario ONLY in the query string -> 400 unknown_scenario (query parameters are never read)", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  await withEnv(OPEN_GATE, async () => {
    const res = await decidePOST(
      new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/decide?scenario=paid", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${SECRET}` },
        body: new URLSearchParams({ reference: "abc" }).toString(),
      })
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { outcome: "invalid_request", reason: "unknown_scenario" });
  });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: catalog GET requires Bearer operator secret (401 otherwise) and lists exactly the catalog ids", async () => {
  await withEnv(OPEN_GATE, async () => {
    const anon = await pageGET(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/page"));
    assert.equal(anon.status, 401);
    const okRes = await pageGET(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/page", { headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as { scenarios: Array<{ id: string }> };
    const { SCENARIO_IDS } = await import("../lib/server/payment-providers/monetico/simulator/scenarios.ts");
    assert.deepEqual(body.scenarios.map((s) => s.id), [...SCENARIO_IDS]);
  });
});

// --------------------------------------------------------------------
// 4. Checkout runtime substitution -- only under the gate, only for
//    `test` merchants; everything else in the result is unchanged
// --------------------------------------------------------------------

function seedMerchantAndOrder(db: InstanceType<typeof InMemoryPaymentDb>, mode: "test" | "live") {
  db.addMerchant({
    id: "resto-A",
    mode,
    isEnabled: true,
    configurationStatus: "verified",
    credential: { tpe: "1234567", societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" },
  });
  // `failed` = a previous attempt was refused; a retry is a legitimate
  // fresh initiation TODAY, without the future `required` state. The
  // `not_required` guard is NOT bypassed by this test (see v163c).
  db.addOrder({ id: "order-A", restaurantId: "resto-A", publicToken: "tok-A", paymentStatus: "failed", total: "25.00", currency: "EUR" });
}

test("RUNTIME: gate open + merchant mode test -> submissionUrl is the simulator page on the CANONICAL origin; fields/MAC/attempt creation unchanged", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "test");
  await withEnv(OPEN_GATE, async () => {
    const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A", language: "fr" });
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;
    assert.equal(result.submissionUrl, "https://checkout.example.test/api/internal/payments/monetico/simulator/page");
    assert.equal(result.resumed, false);
    assert.equal(result.fields.TPE, "1234567");
    assert.equal(result.fields.montant, "25.00EUR");
    assert.match(result.fields.MAC, /^[0-9a-f]{40}$/);
    assert.ok(result.fields.url_retour_ok?.startsWith("https://checkout.example.test/checkout/return/ok?"));
    assert.equal(db.calls.filter((c) => c.name === "initiate_payment_attempt").length, 1);
  });
});

test("RUNTIME: gate open but merchant mode LIVE -> REAL live Monetico URL, simulator never involved", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "live");
  await withEnv(OPEN_GATE, async () => {
    const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;
    assert.equal(result.submissionUrl, MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
  });
});

test("RUNTIME: production deployment (VERCEL_ENV=production) with simulator enabled -> REAL test Monetico URL (gate closed)", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "test");
  await withEnv({ ...OPEN_GATE, VERCEL_ENV: "production" }, async () => {
    const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;
    assert.equal(result.submissionUrl, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
  });
});

test("RUNTIME: simulator disabled (default) -> REAL test Monetico URL -- existing behaviour byte-for-byte preserved", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "test");
  await withEnv({ ...OPEN_GATE, PAYMENT_MONETICO_SIMULATOR_ENABLED: undefined, PAYMENT_MONETICO_SIMULATOR_SECRET: undefined }, async () => {
    const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready") return;
    assert.equal(result.submissionUrl, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
  });
});

test("RUNTIME: the `not_required` guard is NOT bypassed -- a fresh order stays checkout_not_needed with the simulator enabled", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "test");
  db.addOrder({ id: "order-fresh", restaurantId: "resto-A", publicToken: "tok-F", paymentStatus: "not_required", total: "10.00", currency: "EUR" });
  await withEnv(OPEN_GATE, async () => {
    const result = await initiateCheckout({ orderId: "order-fresh", publicToken: "tok-F" });
    assert.deepEqual(result, { outcome: "checkout_not_needed", reason: "not_required" });
    assert.equal(db.calls.filter((c) => c.name === "initiate_payment_attempt").length, 0);
  });
});
