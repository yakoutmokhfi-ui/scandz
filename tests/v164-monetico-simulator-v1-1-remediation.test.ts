import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * MONETICO PAYMENT SIMULATOR v1.1 — AUDITOR COUNTEREXAMPLES (Cat Turing).
 *
 * Each test encodes one counterexample from the v1 audit, asserted the
 * way v1.1 MUST behave. Executed against the audited v1 candidate
 * (8425e015, see MONETICO-SIMULATOR-V1.1-REMEDIATION-HANDOFF.md §2) these
 * tests FAIL -- that run is the reproduction. On v1.1 they pass.
 *
 * Only APIs that exist in both v1 and v1.1 are used (policy evaluation,
 * routes, initiateCheckout, handleSimulatorDecision), so the same file
 * runs unmodified on both trees.
 */

const envHelper = await import("./helpers/monetico-simulator-env.ts");
envHelper.installOpenGateEnvGlobally();
const { openGateEnv, withEnv, OPERATOR_SECRET: SECRET, OTHER_PROJECT_REF, syntheticServiceRoleJwt, SYNTHETIC_TPES } = envHelper;

const policy = await import("../lib/server/payment-providers/monetico/simulator/policy.ts");
const { NextRequest } = await import("next/server");
const { POST: pagePOST } = await import("../app/api/internal/payments/monetico/simulator/page/route.ts");
const { POST: callbackPOST } = await import("../app/api/payments/monetico/callback/route.ts");
const { handleSimulatorDecision } = await import("../lib/server/payment-providers/monetico/simulator/runtime.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");
const { InMemoryPaymentDb } = await import("./helpers/monetico-simulator-db.ts");

const OPEN = openGateEnv();
const CRED_A = { tpe: SYNTHETIC_TPES.A, societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" };

function seed(t: { mock: { method: Function } }) {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  db.addMerchant({ id: "resto-A", mode: "test", isEnabled: true, configurationStatus: "verified", credential: CRED_A });
  db.addOrder({ id: "order-A1", restaurantId: "resto-A", publicToken: "tok-A1", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  db.addOrder({ id: "order-A-delivery", restaurantId: "resto-A", publicToken: "tok-AD", paymentStatus: "failed", total: "30.00", currency: "EUR", serviceMode: "delivery" });
  db.addMerchant({ id: "resto-R", mode: "test", isEnabled: true, configurationStatus: "verified", credential: { tpe: "9999999", societe: "realMerchant", securityKey: "1111111111111111111111111111111111111111" } });
  db.addOrder({ id: "order-R1", restaurantId: "resto-R", publicToken: "tok-R1", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  return db;
}

function inProcessFetch(log: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    log.push(String(url));
    const res = await callbackPOST(new NextRequest(String(url), { method: "POST", headers: init?.headers as Record<string, string>, body: init?.body as string }));
    return new Response(await res.text(), { status: res.status });
  }) as unknown as typeof fetch;
}

async function checkout(orderId: string, publicToken: string) {
  const r = await initiateCheckout({ orderId, publicToken, language: "fr" });
  assert.equal(r.outcome, "ready", JSON.stringify(r));
  if (r.outcome !== "ready") throw new Error("unreachable");
  return r;
}

async function hostedPage(fields: Record<string, string>) {
  const res = await pagePOST(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/page", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const html = await res.text();
  return { status: res.status, html, binding: /name="binding" value="([^"]+)"/.exec(html)?.[1] ?? null };
}

async function decide(ready: Awaited<ReturnType<typeof checkout>>, binding: string, scenario: string, log: string[]) {
  return handleSimulatorDecision({
    body: { scenario, operatorSecret: SECRET, reference: ready.fields.reference, url_retour_ok: ready.fields.url_retour_ok!, url_retour_err: ready.fields.url_retour_err!, binding },
    fetchImpl: inProcessFetch(log),
  });
}

// ------------------------------------------------------------------ SEC-01

test("MSIM-SEC-01 (a): simulator enabled on a preview deployment whose service-role client points at an UNAUTHORIZED (production) Supabase project -> gate MUST be closed", () => {
  const productionClient = {
    PAYMENT_MONETICO_SIMULATOR_ENABLED: "true",
    PAYMENT_MONETICO_SIMULATOR_SECRET: SECRET,
    VERCEL_ENV: "preview",
    PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,development",
    PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: SYNTHETIC_TPES.A,
    NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF),
    // No PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: nothing authorizes this project.
  };
  const verdict = policy.isSimulatorRoutingActive("test", productionClient);
  assert.equal(verdict.active, false, "v1 opened the gate for ANY Supabase project; v1.1 requires an authorized, verified test project");
});

test("MSIM-SEC-01 (b): a production service-role key pointed at the authorized test URL -> gate MUST be closed (key/project identity mismatch)", () => {
  const verdict = policy.isSimulatorRoutingActive("test", { ...OPEN, SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF) });
  assert.equal(verdict.active, false);
});

test("MSIM-SEC-01 (c): a test-mode merchant with a REAL (non-synthetic) TPE must never be served by the simulator page", async (t) => {
  const db = seed(t);
  const ready = await checkout("order-R1", "tok-R1");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  assert.equal(page.status, 404, "v1 served the page for any merchant in mode test; v1.1 requires the TPE on the synthetic allowlist");
  assert.equal(db.eventsFor(ready.fields.reference).length, 0);
});

// ------------------------------------------------------------------ ENV-02

test("MSIM-ENV-02 (a): platform metadata missing (VERCEL_ENV unset) with NODE_ENV=test -> gate MUST be closed", () => {
  const verdict = policy.isSimulatorRoutingActive("test", { ...OPEN, VERCEL_ENV: undefined, NODE_ENV: "test" });
  assert.equal(verdict.active, false, "v1 fell back to NODE_ENV when platform metadata was missing");
});

test("MSIM-ENV-02 (b): no explicit environment allowlist configured -> gate MUST be closed even on a preview deployment", () => {
  const verdict = policy.isSimulatorRoutingActive("test", { ...OPEN, PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: undefined });
  assert.equal(verdict.active, false, "v1 had an implicit allowlist; v1.1 requires an explicit one");
});

test("MSIM-ENV-02 (c): unknown environment and production -> closed (negative tests)", () => {
  assert.equal(policy.isSimulatorRoutingActive("test", { ...OPEN, VERCEL_ENV: "staging" }).active, false);
  assert.equal(policy.isSimulatorRoutingActive("test", { ...OPEN, VERCEL_ENV: "production" }).active, false);
  assert.equal(policy.isSimulatorRoutingActive("test", { ...OPEN, VERCEL_ENV: "production", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "production" }).active, false);
});

// ------------------------------------------------------------------ AUTH-03

test("MSIM-AUTH-03: replaying the SAME authenticated decision POST MUST be refused and MUST NOT emit a second notification", async (t) => {
  const db = seed(t);
  const log: string[] = [];
  const ready = await checkout("order-A1", "tok-A1");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  assert.equal(page.status, 200);
  const first = await decide(ready, page.binding!, "refused", log);
  assert.equal(first.kind, "redirect");
  assert.equal(log.length, 1);
  const replay = await decide(ready, page.binding!, "refused", log);
  assert.notEqual(replay.kind, "redirect", "v1 accepted the replayed decision (stateless binding); v1.1 refuses (single-use token)");
  assert.equal(log.length, 1, "no second notification");
  assert.equal(db.eventsFor(ready.fields.reference).length, 1);
});

// ------------------------------------------------------------------ SIDE-04

test("MSIM-SIDE-04: with Stuart live activation enabled in the same environment, a simulated paid DELIVERY order MUST be refused before any notification and MUST NOT allocate a Stuart job", async (t) => {
  const db = seed(t);
  const log: string[] = [];
  const ready = await checkout("order-A-delivery", "tok-AD");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  assert.equal(page.status, 200);
  await withEnv({ STUART_LIVE_ACTIVATION_ENABLED: "true" }, async () => {
    const decision = await decide(ready, page.binding!, "paid", log);
    assert.notEqual(decision.kind, "redirect", "v1 ignored the Stuart live activation flag entirely");
  });
  assert.equal(log.length, 0, "no notification emitted");
  assert.equal(db.stuartJobs.size, 0, "v1 let the paid pipeline allocate a Stuart job row while live activation was on");
  assert.equal(db.orders.get("order-A-delivery")!.paymentStatus, "pending");
});
