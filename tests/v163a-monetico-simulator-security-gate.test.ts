import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * MONETICO PAYMENT SIMULATOR v1.1 — SECURITY-GATE TESTS.
 *
 * v1.1 (Cat Turing remediation): the gate has seven conditions (policy.ts).
 * This file proves each one closes the gate on its own, that the routes
 * answer 404 while closed and 401 without the operator secret, that
 * scenario/secret are never read from the query string, and that the
 * checkout runtime substitutes the endpoint ONLY under the gate.
 */

const envHelper = await import("./helpers/monetico-simulator-env.ts");
envHelper.installOpenGateEnvGlobally();
const { openGateEnv, withEnv, OPERATOR_SECRET, TEST_PROJECT_REF, OTHER_PROJECT_REF, syntheticServiceRoleJwt, SYNTHETIC_TPES, REAL_LOOKING_TPE_B } = envHelper;

const policy = await import("../lib/server/payment-providers/monetico/simulator/policy.ts");
const auth = await import("../lib/server/payment-providers/monetico/simulator/auth.ts");
const session = await import("../lib/server/payment-providers/monetico/simulator/session.ts");
const { NextRequest } = await import("next/server");
const { POST: pagePOST, GET: pageGET } = await import("../app/api/internal/payments/monetico/simulator/page/route.ts");
const { POST: decidePOST } = await import("../app/api/internal/payments/monetico/simulator/decide/route.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");
const { MONETICO_TEST_PAYMENT_SUBMISSION_URL, MONETICO_LIVE_PAYMENT_SUBMISSION_URL } = await import("../lib/server/payment-providers/monetico/endpoint.ts");
const { InMemoryPaymentDb } = await import("./helpers/monetico-simulator-db.ts");

const OPEN = openGateEnv();
const SECRET = OPERATOR_SECRET;
const SIM_PAGE_URL = "https://checkout.example.test/api/internal/payments/monetico/simulator/page";

// --------------------------------------------------------------------
// 1. Activation policy -- every condition alone closes the gate
// --------------------------------------------------------------------

test("GATE v1.1: fully configured synthetic environment + merchant mode test -> active", () => {
  assert.deepEqual(policy.isSimulatorRoutingActive("test", OPEN), { active: true });
});

test("GATE cond.1 enablement: anything but the exact string \"true\" closes the gate", () => {
  for (const bad of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_ENABLED: bad }), { active: false, reason: "not_enabled" }, JSON.stringify(bad));
  }
});

test("GATE cond.2 deployment allowlist (MSIM-ENV-02): missing platform metadata, production, unknown values, non-allowlisted and malformed allowlists all refuse; NODE_ENV is never consulted", () => {
  const r = (env: Record<string, string | undefined>) => policy.evaluateDeploymentEnvironment({ ...OPEN, ...env });
  assert.deepEqual(r({ VERCEL_ENV: undefined }), { active: false, reason: "platform_environment_missing" });
  assert.deepEqual(r({ VERCEL_ENV: "" }), { active: false, reason: "platform_environment_missing" });
  assert.deepEqual(r({ VERCEL_ENV: undefined, NODE_ENV: "test" }), { active: false, reason: "platform_environment_missing" }, "NODE_ENV=test must NOT substitute for platform metadata");
  assert.deepEqual(r({ VERCEL_ENV: "production" }), { active: false, reason: "production_deployment" });
  assert.deepEqual(r({ VERCEL_ENV: "production", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,development,production" }), { active: false, reason: "production_deployment" }, "production refused even when listed");
  assert.deepEqual(r({ VERCEL_ENV: "staging" }), { active: false, reason: "environment_not_allowlisted" });
  assert.deepEqual(r({ VERCEL_ENV: "Preview" }), { active: false, reason: "environment_not_allowlisted" });
  assert.deepEqual(r({ VERCEL_ENV: "preview", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "development" }), { active: false, reason: "environment_not_allowlisted" });
  assert.deepEqual(r({ VERCEL_ENV: "preview", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: undefined }), { active: false, reason: "allowlist_missing_or_invalid" });
  assert.deepEqual(r({ VERCEL_ENV: "preview", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "" }), { active: false, reason: "allowlist_missing_or_invalid" });
  assert.deepEqual(r({ VERCEL_ENV: "preview", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,staging" }), { active: false, reason: "allowlist_missing_or_invalid" }, "an allowlist naming a non-acceptable environment is rejected as a whole");
  assert.deepEqual(r({ VERCEL_ENV: "preview", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,production" }), { active: false, reason: "allowlist_missing_or_invalid" });
  assert.deepEqual(r({ VERCEL_ENV: "development", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: " development " }), { active: true });
  assert.deepEqual(r({ VERCEL_ENV: "preview", NODE_ENV: "production" }), { active: true }, "preview builds run NODE_ENV=production and remain allowed");
});

test("GATE cond.3 operator secret: missing or shorter than 32 chars closes the gate", () => {
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_SECRET: undefined }), { active: false, reason: "secret_missing_or_too_short" });
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_SECRET: "short" }), { active: false, reason: "secret_missing_or_too_short" });
});

test("GATE cond.4 tenant boundary (MSIM-SEC-01): authorized ref, URL ref and service-role JWT ref must all agree; production ref denied; no fallback", () => {
  const t = (env: Record<string, string | undefined>) => policy.evaluateTenantBoundary({ ...OPEN, ...env });
  assert.deepEqual(t({}), { active: true });
  assert.deepEqual(t({ PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: undefined }), { active: false, reason: "test_project_ref_missing" });
  assert.deepEqual(t({ PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: "Bad-Ref" }), { active: false, reason: "test_project_ref_missing" });
  // Authorized ref accidentally equal to the declared production ref.
  assert.deepEqual(t({ PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: OTHER_PROJECT_REF, NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF) }), { active: false, reason: "test_project_ref_equals_production" });
  // Client URL points at another (production) project.
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co` }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co" }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: `http://${TEST_PROJECT_REF}.supabase.co` }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_PROJECT_REF}.supabase.co.evil.example` }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: undefined }), { active: false, reason: "supabase_url_project_mismatch" });
  // Service-role key belongs to another project (production key + test URL).
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF) }), { active: false, reason: "service_role_key_project_mismatch" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(TEST_PROJECT_REF, "anon") }), { active: false, reason: "service_role_key_role_mismatch" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: "not-a-jwt" }), { active: false, reason: "service_role_key_unreadable" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: undefined }), { active: false, reason: "service_role_key_unreadable" });
});

test("GATE cond.5 synthetic credentials (MSIM-SEC-01): TPE allowlist required and enforced per merchant", () => {
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: undefined }), { active: false, reason: "allowed_tpes_missing_or_invalid" });
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: "123" }), { active: false, reason: "allowed_tpes_missing_or_invalid" });
  assert.equal(policy.isTpeAllowed(SYNTHETIC_TPES.A, OPEN), true);
  assert.equal(policy.isTpeAllowed(REAL_LOOKING_TPE_B, OPEN), false);
  assert.equal(policy.isTpeAllowed(undefined, OPEN), false);
});

test("GATE cond.6 no live fulfillment (MSIM-SIDE-04): STUART_LIVE_ACTIVATION_ENABLED=true closes the gate", () => {
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, STUART_LIVE_ACTIVATION_ENABLED: "true" }), { active: false, reason: "stuart_live_activation_enabled" });
  assert.deepEqual(policy.isSimulatorRoutingActive("test", { ...OPEN, STUART_LIVE_ACTIVATION_ENABLED: undefined }), { active: true });
});

test("GATE cond.7 merchant mode: anything but \"test\" closes the gate", () => {
  for (const mode of ["live", "LIVE", "Test", "", undefined, null, 1, "sandbox"]) {
    assert.deepEqual(policy.isSimulatorRoutingActive(mode, OPEN), { active: false, reason: "merchant_mode_not_test" }, String(mode));
  }
});

// --------------------------------------------------------------------
// 2. Operator authentication and single-use decision token
// --------------------------------------------------------------------

test("AUTH: operator secret -- constant-time exact match; short/missing configured secret disables auth entirely", () => {
  const env = { PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET };
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET, env), true);
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET + "x", env), false);
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET.slice(0, -1), env), false);
  assert.equal(auth.verifySimulatorOperatorSecret("", env), false);
  assert.equal(auth.verifySimulatorOperatorSecret(undefined, env), false);
  assert.equal(auth.verifySimulatorOperatorSecret("short", { PAYMENT_MONETICO_SIMULATOR_SECRET: "short" }), false);
  assert.equal(auth.verifySimulatorOperatorSecret(SECRET, {}), false);
  assert.equal(auth.extractBearer(`Bearer ${SECRET}`), SECRET);
  assert.equal(auth.extractBearer(`Basic abc`), null);
});

test("TOKEN (MSIM-AUTH-03): single-use -- second consumption of the same token is refused; bound to reference/URLs/transaction; expires; tamper-evident", () => {
  const env = { PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET };
  const registry = session.createDecisionTokenRegistry();
  const now = new Date(Date.UTC(2026, 9, 13, 10, 0, 0));
  const b = { reference: "abc123def456", transactionId: "txn-1", urlRetourOk: "https://checkout.example.test/checkout/return/ok?x=1", urlRetourErr: "https://checkout.example.test/checkout/return/err?x=1" };
  const expected = { reference: b.reference, urlRetourOk: b.urlRetourOk, urlRetourErr: b.urlRetourErr };
  const token = session.issueDecisionToken({ ...b, now, env });
  const first = session.consumeDecisionToken({ token, expected, now, env, registry });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.payload.transactionId, "txn-1");
  assert.deepEqual(session.consumeDecisionToken({ token, expected, now, env, registry }), { ok: false, reason: "token_already_used" });
  // Fresh token, other bindings
  const t2 = session.issueDecisionToken({ ...b, now, env });
  assert.deepEqual(session.consumeDecisionToken({ token: t2, expected: { ...expected, reference: "abc123def457" }, now, env, registry }), { ok: false, reason: "token_binding_mismatch" });
  assert.deepEqual(session.consumeDecisionToken({ token: t2, expected: { ...expected, urlRetourOk: "https://evil.example/ok" }, now, env, registry }), { ok: false, reason: "token_binding_mismatch" });
  assert.deepEqual(session.consumeDecisionToken({ token: t2, expected, now: new Date(now.getTime() + (session.DECISION_TOKEN_TTL_SECONDS + 1) * 1000), env, registry }), { ok: false, reason: "token_expired" });
  assert.deepEqual(session.consumeDecisionToken({ token: t2, expected, now, env: { PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET + "2" }, registry }), { ok: false, reason: "token_signature_invalid" });
  const [payload, sig] = t2.split(".");
  assert.deepEqual(session.consumeDecisionToken({ token: `${payload}.${sig.replace(/^./, (c) => (c === "0" ? "1" : "0"))}`, expected, now, env, registry }), { ok: false, reason: "token_signature_invalid" });
  // Payload tampering (transactionId swap) invalidates the signature.
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), transactionId: "txn-2" }), "utf8").toString("base64url");
  assert.deepEqual(session.consumeDecisionToken({ token: `${tampered}.${sig}`, expected, now, env, registry }), { ok: false, reason: "token_signature_invalid" });
  for (const bad of [undefined, "", "a.b", "x".repeat(64), 42]) {
    assert.equal(session.consumeDecisionToken({ token: bad, expected, now, env, registry }).ok, false, String(bad));
  }
  // The untouched valid t2 is still consumable exactly once.
  assert.equal(session.consumeDecisionToken({ token: t2, expected, now, env, registry }).ok, true);
  assert.deepEqual(session.consumeDecisionToken({ token: t2, expected, now, env, registry }), { ok: false, reason: "token_already_used" });
  assert.equal(session.isSameCanonicalOrigin("https://checkout.example.test.evil.example/ok", "https://checkout.example.test"), false);
});

// --------------------------------------------------------------------
// 3. Routes
// --------------------------------------------------------------------

function formRequest(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new NextRequest(`https://checkout.example.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
}

test("ROUTES: production deployment -> both simulator routes answer 404 with empty body, no RPC call", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  await withEnv({ VERCEL_ENV: "production" }, async () => {
    const page = await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }));
    assert.equal(page.status, 404);
    assert.equal(await page.text(), "");
    assert.equal((await pageGET(new NextRequest(SIM_PAGE_URL, { headers: { authorization: `Bearer ${SECRET}` } }))).status, 404);
    assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", operatorSecret: SECRET, reference: "abc" }))).status, 404);
  });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: gate closed by tenant boundary (client pointed at another project) -> 404, no RPC", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  await withEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co` }, async () => {
    assert.equal((await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }))).status, 404);
    assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", operatorSecret: SECRET }))).status, 404);
  });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: decision without/with wrong operator secret -> 401 before any RPC; secret in query string ignored", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", reference: "abc" }))).status, 401);
  assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", reference: "abc", operatorSecret: "nope" }))).status, 401);
  const inQuery = await decidePOST(new NextRequest(`https://checkout.example.test/api/internal/payments/monetico/simulator/decide?operatorSecret=${encodeURIComponent(SECRET)}&scenario=paid`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ reference: "abc" }).toString() }));
  assert.equal(inQuery.status, 401);
  assert.deepEqual(db.calls, []);
});

test("ROUTES: authenticated decision with scenario ONLY in the query string -> 400 unknown_scenario", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  const res = await decidePOST(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/decide?scenario=paid", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${SECRET}` }, body: new URLSearchParams({ reference: "abc" }).toString() }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { outcome: "invalid_request", reason: "unknown_scenario" });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: catalog GET requires Bearer operator secret and lists exactly the catalog ids", async () => {
  assert.equal((await pageGET(new NextRequest(SIM_PAGE_URL))).status, 401);
  const okRes = await pageGET(new NextRequest(SIM_PAGE_URL, { headers: { authorization: `Bearer ${SECRET}` } }));
  assert.equal(okRes.status, 200);
  const { SCENARIO_IDS } = await import("../lib/server/payment-providers/monetico/simulator/scenarios.ts");
  assert.deepEqual(((await okRes.json()) as { scenarios: Array<{ id: string }> }).scenarios.map((s) => s.id), [...SCENARIO_IDS]);
});

// --------------------------------------------------------------------
// 4. Checkout runtime substitution
// --------------------------------------------------------------------

function seedMerchantAndOrder(db: InstanceType<typeof InMemoryPaymentDb>, mode: "test" | "live") {
  db.addMerchant({ id: "resto-A", mode, isEnabled: true, configurationStatus: "verified", credential: { tpe: SYNTHETIC_TPES.A, societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" } });
  // `failed` = previous refused attempt; a retry is a legitimate fresh
  // initiation TODAY. The `not_required` guard is NOT bypassed.
  db.addOrder({ id: "order-A", restaurantId: "resto-A", publicToken: "tok-A", paymentStatus: "failed", total: "25.00", currency: "EUR" });
}

test("RUNTIME: gate open + merchant mode test -> submissionUrl is the simulator page on the CANONICAL origin; fields/MAC/attempt creation unchanged", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "test");
  const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A", language: "fr" });
  assert.equal(result.outcome, "ready");
  if (result.outcome !== "ready") return;
  assert.equal(result.submissionUrl, SIM_PAGE_URL);
  assert.equal(result.fields.montant, "25.00EUR");
  assert.match(result.fields.MAC, /^[0-9a-f]{40}$/);
  assert.equal(db.calls.filter((c) => c.name === "initiate_payment_attempt").length, 1);
});

test("RUNTIME: merchant mode LIVE -> REAL live Monetico URL, simulator never involved", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "live");
  const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
  assert.equal(result.outcome, "ready");
  if (result.outcome === "ready") assert.equal(result.submissionUrl, MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
});

for (const [label, override] of [
  ["production deployment", { VERCEL_ENV: "production" }],
  ["platform metadata missing", { VERCEL_ENV: undefined }],
  ["client pointed at another Supabase project", { NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co` }],
  ["service-role key of another project", { SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF) }],
  ["Stuart live activation enabled", { STUART_LIVE_ACTIVATION_ENABLED: "true" }],
  ["simulator disabled (default)", { PAYMENT_MONETICO_SIMULATOR_ENABLED: undefined, PAYMENT_MONETICO_SIMULATOR_SECRET: undefined }],
] as const) {
  test(`RUNTIME: ${label} -> REAL test Monetico URL (gate closed), existing behaviour preserved`, async (t) => {
    const db = new InMemoryPaymentDb();
    db.install(t, client);
    seedMerchantAndOrder(db, "test");
    await withEnv({ ...override }, async () => {
      const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
      assert.equal(result.outcome, "ready");
      if (result.outcome === "ready") assert.equal(result.submissionUrl, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
    });
  });
}

test("RUNTIME: the `not_required` guard is NOT bypassed -- a fresh order stays checkout_not_needed with the simulator enabled", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  seedMerchantAndOrder(db, "test");
  db.addOrder({ id: "order-fresh", restaurantId: "resto-A", publicToken: "tok-F", paymentStatus: "not_required", total: "10.00", currency: "EUR" });
  const result = await initiateCheckout({ orderId: "order-fresh", publicToken: "tok-F" });
  assert.deepEqual(result, { outcome: "checkout_not_needed", reason: "not_required" });
  assert.equal(db.calls.filter((c) => c.name === "initiate_payment_attempt").length, 0);
});
