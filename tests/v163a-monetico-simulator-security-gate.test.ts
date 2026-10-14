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
const { openGateEnv, withEnv, OPERATOR_SECRET, TEST_PROJECT_REF, OTHER_PROJECT_REF, syntheticServiceRoleJwt, SYNTHETIC_TPES, REAL_LOOKING_TPE_B, AUTHORITY_ROW } = envHelper;

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
/** The DB authority as the gate sees it (pure policy inputs). */
const AUTH = { projectRef: AUTHORITY_ROW.projectRef, allowedTpes: AUTHORITY_ROW.allowedTpes };
const routing = (mode: unknown, env: Record<string, string | undefined>, authority: typeof AUTH | null = AUTH) => policy.isSimulatorRoutingActive(mode, env, authority);
/** A model with the authority INSTALLED (= dedicated test project). */
function testProjectDb(t: { mock: { method: Function } }) {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  db.installAuthority(AUTHORITY_ROW);
  return db;
}
const SIM_PAGE_URL = "https://checkout.example.test/api/internal/payments/monetico/simulator/page";

// --------------------------------------------------------------------
// 1. Activation policy -- every condition alone closes the gate
// --------------------------------------------------------------------

test("GATE v1.2: synthetic environment + DB authority + merchant mode test -> active", () => {
  assert.deepEqual(routing("test", OPEN), { active: true });
});

test("GATE v1.2 cond.4 (MSIM-SEC-01): WITHOUT the DB authority the gate is closed whatever the environment says -- mutually consistent variables cannot open it", () => {
  assert.deepEqual(routing("test", OPEN, null), { active: false, reason: "authority_unavailable" });
  // The v1.1 counterexample: every variable consistently points at ONE project (production). Still closed: no authority.
  const consistentProd = { ...OPEN, NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF), SCANYM_PRODUCTION_SUPABASE_PROJECT_REF: undefined };
  assert.deepEqual(routing("test", consistentProd, null), { active: false, reason: "authority_unavailable" });
  // Even an authority row whose ref matches those variables is refused when the declared production ref equals it.
  assert.deepEqual(routing("test", { ...consistentProd, SCANYM_PRODUCTION_SUPABASE_PROJECT_REF: OTHER_PROJECT_REF }, { projectRef: OTHER_PROJECT_REF, allowedTpes: ["1234567"] }), { active: false, reason: "test_project_ref_equals_production" });
});

test("GATE cond.1 enablement: anything but the exact string \"true\" closes the gate", () => {
  for (const bad of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    assert.deepEqual(routing("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_ENABLED: bad }), { active: false, reason: "not_enabled" }, JSON.stringify(bad));
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
  assert.deepEqual(routing("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_SECRET: undefined }), { active: false, reason: "secret_missing_or_too_short" });
  assert.deepEqual(routing("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_SECRET: "short" }), { active: false, reason: "secret_missing_or_too_short" });
});

test("GATE cond.4 tenant boundary (MSIM-SEC-01): the client in use must match the DB authority's project (URL ref AND service-role JWT ref/role); production ref denied; no fallback", () => {
  const t = (env: Record<string, string | undefined>, authority: typeof AUTH | null = AUTH) => policy.evaluateTenantBoundary({ ...OPEN, ...env }, authority);
  assert.deepEqual(t({}), { active: true });
  assert.deepEqual(t({}, null), { active: false, reason: "authority_unavailable" });
  assert.deepEqual(t({}, { projectRef: "Bad-Ref", allowedTpes: ["1234567"] }), { active: false, reason: "authority_project_ref_invalid" });
  assert.deepEqual(t({ SCANYM_PRODUCTION_SUPABASE_PROJECT_REF: TEST_PROJECT_REF }), { active: false, reason: "test_project_ref_equals_production" });
  // Client URL points at another project than the one that answered -- impossible in practice (the authority came from that client), kept as defense in depth.
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co` }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co" }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: `http://${TEST_PROJECT_REF}.supabase.co` }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_PROJECT_REF}.supabase.co.evil.example` }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ NEXT_PUBLIC_SUPABASE_URL: undefined }), { active: false, reason: "supabase_url_project_mismatch" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF) }), { active: false, reason: "service_role_key_project_mismatch" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(TEST_PROJECT_REF, "anon") }), { active: false, reason: "service_role_key_role_mismatch" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: "not-a-jwt" }), { active: false, reason: "service_role_key_unreadable" });
  assert.deepEqual(t({ SUPABASE_SERVICE_ROLE_KEY: undefined }), { active: false, reason: "service_role_key_unreadable" });
});

test("GATE cond.5 synthetic credentials (MSIM-SEC-01): TPE allowlist comes from the DB authority and is enforced per merchant; malformed authority lists close the gate", () => {
  assert.equal(policy.isTpeAllowed(SYNTHETIC_TPES.A, AUTH), true);
  assert.equal(policy.isTpeAllowed(REAL_LOOKING_TPE_B, AUTH), false);
  assert.equal(policy.isTpeAllowed(SYNTHETIC_TPES.A, null), false);
  assert.equal(policy.isTpeAllowed(undefined, AUTH), false);
  assert.deepEqual(routing("test", OPEN, { projectRef: TEST_PROJECT_REF, allowedTpes: [] }), { active: false, reason: "authority_project_ref_invalid" });
  assert.deepEqual(routing("test", OPEN, { projectRef: TEST_PROJECT_REF, allowedTpes: ["123"] }), { active: false, reason: "authority_project_ref_invalid" });
});

test("GATE cond.6 no live fulfillment (MSIM-SIDE-04): STUART_LIVE_ACTIVATION_ENABLED=true closes the gate", () => {
  assert.deepEqual(routing("test", { ...OPEN, STUART_LIVE_ACTIVATION_ENABLED: "true" }), { active: false, reason: "stuart_live_activation_enabled" });
  assert.deepEqual(routing("test", { ...OPEN, STUART_LIVE_ACTIVATION_ENABLED: undefined }), { active: true });
});

test("GATE cond.7 merchant mode: anything but \"test\" closes the gate", () => {
  for (const mode of ["live", "LIVE", "Test", "", undefined, null, 1, "sandbox"]) {
    assert.deepEqual(routing(mode, OPEN), { active: false, reason: "merchant_mode_not_test" }, String(mode));
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

test("TOKEN (MSIM-AUTH-03, DB-authoritative): opaque nonce; issue requires a pending attempt; consume is single-use, bound and expiring -- state lives in the database, not in the process", async (t) => {
  const db = testProjectDb(t);
  db.addMerchant({ id: "resto-A", mode: "test", isEnabled: true, configurationStatus: "verified", credential: { tpe: SYNTHETIC_TPES.A, societe: "s", securityKey: "0123456789abcdef0123456789abcdef01234567" } });
  db.addOrder({ id: "order-A", restaurantId: "resto-A", publicToken: "tok-A", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  const ready = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
  assert.equal(ready.outcome, "ready");
  if (ready.outcome !== "ready") return;
  const expected = { reference: ready.fields.reference, urlRetourOk: ready.fields.url_retour_ok!, urlRetourErr: ready.fields.url_retour_err! };
  const issued = await session.issueDecisionToken({ providerReference: expected.reference, urlRetourOk: expected.urlRetourOk, urlRetourErr: expected.urlRetourErr });
  assert.match(issued.token, /^[0-9a-f]{32}$/);
  assert.equal(db.decisionTokens.get(issued.token)!.transactionId, issued.transactionId);
  const first = await session.consumeDecisionToken({ token: issued.token, expected });
  assert.equal(first.ok, true);
  assert.deepEqual(await session.consumeDecisionToken({ token: issued.token, expected }), { ok: false, reason: "token_already_used" });
  const t2 = await session.issueDecisionToken({ providerReference: expected.reference, urlRetourOk: expected.urlRetourOk, urlRetourErr: expected.urlRetourErr });
  assert.deepEqual(await session.consumeDecisionToken({ token: t2.token, expected: { ...expected, urlRetourOk: "https://evil.example/ok" } }), { ok: false, reason: "token_binding_mismatch" });
  assert.deepEqual(await session.consumeDecisionToken({ token: t2.token, expected: { ...expected, reference: "000000000000" } }), { ok: false, reason: "token_binding_mismatch" });
  db.nowMs += (session.DECISION_TOKEN_TTL_SECONDS + 1) * 1000;
  assert.deepEqual(await session.consumeDecisionToken({ token: t2.token, expected }), { ok: false, reason: "token_expired" });
  assert.deepEqual(await session.consumeDecisionToken({ token: "f".repeat(32), expected }), { ok: false, reason: "token_unknown" });
  for (const bad of [undefined, "", "a.b", "x".repeat(32), 42]) {
    assert.deepEqual(await session.consumeDecisionToken({ token: bad, expected }), { ok: false, reason: "token_malformed" }, String(bad));
  }
  // Attempt no longer pending -> issuance refused by the database.
  db.txnByReference("monetico", expected.reference)!.status = "paid";
  await assert.rejects(session.issueDecisionToken({ providerReference: expected.reference, urlRetourOk: expected.urlRetourOk, urlRetourErr: expected.urlRetourErr }));
  // Production project (no authority): every token RPC fails -> consume reports service unavailable, issue throws.
  db.authority = null;
  assert.deepEqual(await session.consumeDecisionToken({ token: t2.token, expected }), { ok: false, reason: "token_service_unavailable" });
  assert.equal(session.isSameCanonicalOrigin("https://checkout.example.test.evil.example/ok", "https://checkout.example.test"), false);
});

// --------------------------------------------------------------------
// 3. Routes
// --------------------------------------------------------------------

function formRequest(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new NextRequest(`https://checkout.example.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
}

test("ROUTES: production deployment -> both simulator routes answer 404 with empty body, no RPC call", async (t) => {
  const db = testProjectDb(t);
  await withEnv({ VERCEL_ENV: "production" }, async () => {
    const page = await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }));
    assert.equal(page.status, 404);
    assert.equal(await page.text(), "");
    assert.equal((await pageGET(new NextRequest(SIM_PAGE_URL, { headers: { authorization: `Bearer ${SECRET}` } }))).status, 404);
    assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", operatorSecret: SECRET, reference: "abc" }))).status, 404);
  });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: PRODUCTION PROJECT (no authority function) with every environment variable set consistently -> both routes 404; the ONLY RPC ever issued is the failed authority read", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client); // authority NOT installed = production
  assert.equal((await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }))).status, 404);
  assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", operatorSecret: SECRET }))).status, 404);
  assert.deepEqual([...new Set(db.calls.map((c) => c.name))], ["get_simulator_authority"]);
});

test("ROUTES: test project whose database holds a LIVE merchant -> authority revoked -> 404", async (t) => {
  const db = testProjectDb(t);
  db.addMerchant({ id: "resto-L", mode: "live", isEnabled: true, configurationStatus: "verified", credential: { tpe: "1111111", societe: "s", securityKey: "0".repeat(40) } });
  assert.equal((await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }))).status, 404);
});

test("ROUTES: gate closed by environment preconditions -> 404 and NO RPC at all (authority never queried)", async (t) => {
  const db = testProjectDb(t);
  await withEnv({ VERCEL_ENV: undefined }, async () => {
    assert.equal((await pagePOST(formRequest("/api/internal/payments/monetico/simulator/page", { reference: "abc" }))).status, 404);
  });
  assert.deepEqual(db.calls, []);
});

test("ROUTES: decision without/with wrong operator secret -> 401; secret in query string ignored; no RPC beyond the authority read", async (t) => {
  const db = testProjectDb(t);
  assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", reference: "abc" }))).status, 401);
  assert.equal((await decidePOST(formRequest("/api/internal/payments/monetico/simulator/decide", { scenario: "paid", reference: "abc", operatorSecret: "nope" }))).status, 401);
  const inQuery = await decidePOST(new NextRequest(`https://checkout.example.test/api/internal/payments/monetico/simulator/decide?operatorSecret=${encodeURIComponent(SECRET)}&scenario=paid`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ reference: "abc" }).toString() }));
  assert.equal(inQuery.status, 401);
  assert.deepEqual([...new Set(db.calls.map((c) => c.name))], ["get_simulator_authority"]);
});

test("ROUTES: authenticated decision with scenario ONLY in the query string -> 400 unknown_scenario", async (t) => {
  const db = testProjectDb(t);
  const res = await decidePOST(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/decide?scenario=paid", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${SECRET}` }, body: new URLSearchParams({ reference: "abc" }).toString() }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { outcome: "invalid_request", reason: "unknown_scenario" });
  assert.deepEqual([...new Set(db.calls.map((c) => c.name))], ["get_simulator_authority"]);
});

test("ROUTES: catalog GET requires Bearer operator secret and lists exactly the catalog ids", async (t) => {
  testProjectDb(t);
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
  if (mode === "test") db.installAuthority(AUTHORITY_ROW);
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

test("RUNTIME: PRODUCTION PROJECT (no authority) with consistent variables -> REAL test Monetico URL; attempt still created normally", async (t) => {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  db.addMerchant({ id: "resto-A", mode: "test", isEnabled: true, configurationStatus: "verified", credential: { tpe: SYNTHETIC_TPES.A, societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" } });
  db.addOrder({ id: "order-A", restaurantId: "resto-A", publicToken: "tok-A", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  const result = await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
  assert.equal(result.outcome, "ready");
  if (result.outcome === "ready") assert.equal(result.submissionUrl, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
});

for (const [label, override] of [
  ["production deployment", { VERCEL_ENV: "production" }],
  ["platform metadata missing", { VERCEL_ENV: undefined }],
  ["client pointed at another Supabase project", { NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co` }],
  ["service-role key of another project", { SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF) }],
  ["declared production ref equals the authority's ref", { SCANYM_PRODUCTION_SUPABASE_PROJECT_REF: TEST_PROJECT_REF }],
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
