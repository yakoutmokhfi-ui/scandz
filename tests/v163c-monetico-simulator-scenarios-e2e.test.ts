import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * MONETICO PAYMENT SIMULATOR v1 — END-TO-END SCENARIO MATRIX.
 *
 * Every scenario runs the REAL chain with `client.rpc` replaced by the
 * in-memory model (tests/helpers/monetico-simulator-db.ts):
 *
 *   initiateCheckout (real)  -> merchant form + MAC
 *   simulator page route     -> verifies the form like the TPE, renders
 *   simulator decide route   -> signed S2S notification(s) delivered to
 *   callback route (real)    -> Stage A (MAC, classification, inbox)
 *                            -> Stage B (claim, correlation, confirm)
 *   recovery worker (real)   -> convergence when Stage B was skipped
 *
 * The notifier's `fetch` is routed IN-PROCESS to the real callback route
 * handler, so the bytes the application receives are exactly the bytes
 * the simulator would send over HTTP.
 *
 * HONESTY NOTE (CTO Q1): the orders used here start in `failed`
 * (a previous refused attempt) -- a state that legitimately permits a
 * fresh initiation TODAY. No test bypasses the `not_required` guard;
 * tests that need a brand-new order to be payable are listed in
 * MONETICO-SIMULATOR-V1-REQUIRED-STATE-SPEC.md and are NOT claimed here.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "v163-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

const SECRET = "v163-simulator-operator-secret-synthetic-DO-NOT-USE-0002";
const CRON_SECRET = "v163-cron-secret-synthetic-DO-NOT-USE-00000000";
process.env.PAYMENT_MONETICO_SIMULATOR_ENABLED = "true";
process.env.PAYMENT_MONETICO_SIMULATOR_SECRET = SECRET;
process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = "true";
process.env.CRON_SECRET = CRON_SECRET;
delete process.env.VERCEL_ENV;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const { NextRequest } = await import("next/server");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");
const { POST: pagePOST } = await import("../app/api/internal/payments/monetico/simulator/page/route.ts");
const { POST: callbackPOST } = await import("../app/api/payments/monetico/callback/route.ts");
const { GET: recoverGET } = await import("../app/api/internal/payments/monetico/recover/route.ts");
const { handleSimulatorDecision } = await import("../lib/server/payment-providers/monetico/simulator/runtime.ts");
const { buildSimulatedCallback } = await import("../lib/server/payment-providers/monetico/simulator/outcome.ts");
const { verifyReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");
const { InMemoryPaymentDb } = await import("./helpers/monetico-simulator-db.ts");

const CRED_A = { tpe: "1234567", societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" };
const CRED_B = { tpe: "2345678", societe: "societeB", securityKey: "89abcdef0123456789abcdef0123456789abcdef" };
const CRED_C = { tpe: "7654321", societe: "societeC", securityKey: "fedcba9876543210fedcba9876543210fedcba98" };

type Db = InstanceType<typeof InMemoryPaymentDb>;

function seed(t: { mock: { method: Function } }): Db {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  db.addMerchant({ id: "resto-A", mode: "test", isEnabled: true, configurationStatus: "verified", credential: CRED_A });
  db.addMerchant({ id: "resto-B", mode: "live", isEnabled: true, configurationStatus: "verified", credential: CRED_B });
  db.addMerchant({ id: "resto-C", mode: "test", isEnabled: true, configurationStatus: "verified", credential: CRED_C });
  db.addOrder({ id: "order-A1", restaurantId: "resto-A", publicToken: "tok-A1", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  db.addOrder({ id: "order-B1", restaurantId: "resto-B", publicToken: "tok-B1", paymentStatus: "failed", total: "40.00", currency: "EUR" });
  db.addOrder({ id: "order-C1", restaurantId: "resto-C", publicToken: "tok-C1", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  return db;
}

/** In-process transport: the simulator's fetch hits the real callback route. */
function inProcessFetch(log: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    log.push(String(url));
    const req = new NextRequest(String(url), { method: "POST", headers: init?.headers as Record<string, string>, body: init?.body as string });
    const res = await callbackPOST(req);
    return new Response(await res.text(), { status: res.status });
  }) as unknown as typeof fetch;
}

async function checkout(orderId: string, publicToken: string) {
  const result = await initiateCheckout({ orderId, publicToken, language: "fr" });
  assert.equal(result.outcome, "ready", JSON.stringify(result));
  if (result.outcome !== "ready") throw new Error("unreachable");
  return result;
}

async function hostedPage(fields: Record<string, string>) {
  const req = new NextRequest("https://checkout.example.test/api/internal/payments/monetico/simulator/page", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const res = await pagePOST(req);
  const html = await res.text();
  const binding = /name="binding" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? null;
  return { status: res.status, html, binding };
}

async function decide(ready: Awaited<ReturnType<typeof checkout>>, binding: string, scenario: string, transport: typeof fetch, overrides: Record<string, string> = {}) {
  return handleSimulatorDecision({
    body: {
      scenario,
      operatorSecret: SECRET,
      reference: ready.fields.reference,
      url_retour_ok: ready.fields.url_retour_ok!,
      url_retour_err: ready.fields.url_retour_err!,
      binding,
      ...overrides,
    },
    fetchImpl: transport,
    now: new Date(Date.UTC(2026, 9, 13, 10, 0, 0)),
  });
}

async function runScenario(t: { mock: { method: Function } }, scenario: string) {
  const db = seed(t);
  const transportLog: string[] = [];
  const transport = inProcessFetch(transportLog);
  const ready = await checkout("order-A1", "tok-A1");
  assert.equal(ready.submissionUrl, "https://checkout.example.test/api/internal/payments/monetico/simulator/page");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  assert.equal(page.status, 200, page.html);
  assert.ok(page.binding, "binding rendered");
  const decision = await decide(ready, page.binding!, scenario, transport);
  assert.equal(decision.kind, "redirect", JSON.stringify(decision));
  if (decision.kind !== "redirect") throw new Error("unreachable");
  const txn = db.txnByReference("monetico", ready.fields.reference)!;
  const order = db.orders.get("order-A1")!;
  return { db, ready, page, decision, txn, order, transportLog, events: db.eventsFor(ready.fields.reference) };
}

function confirmCalls(db: Db) {
  return db.calls.filter((c) => c.name === "confirm_payment_attempt");
}

// --------------------------------------------------------------------

test("E2E paid: payetest -> applied_paid, transaction paid, order paid, inbox applied, numauto stored, redirect to url_retour_ok with a valid relay token", async (t) => {
  const r = await runScenario(t, "paid");
  assert.deepEqual(r.decision.notifications.map((n) => n.delivered), [true]);
  assert.equal(r.txn.status, "paid");
  assert.match(r.txn.authorizationReference ?? "", /^\d{6}$/);
  assert.equal(r.order.paymentStatus, "paid");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].processingStatus, "applied");
  assert.equal(confirmCalls(r.db).length, 1);
  assert.equal(r.decision.location, r.ready.fields.url_retour_ok);
  const token = new URL(r.decision.location).searchParams.get("token")!;
  const relay = verifyReturnRelayToken(token, "order-A1");
  assert.equal(relay.orderId, "order-A1");
  assert.deepEqual(r.transportLog, ["https://checkout.example.test/api/payments/monetico/callback"]);
});

test("E2E refused: Annulation -> inbox ignored, attempt stays pending (resumable), confirm never called, redirect to url_retour_err", async (t) => {
  const r = await runScenario(t, "refused");
  assert.equal(r.txn.status, "pending");
  assert.equal(r.order.paymentStatus, "pending");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.processingStatus]), [["refused", "ignored"]]);
  assert.equal(confirmCalls(r.db).length, 0);
  assert.equal(r.decision.location, r.ready.fields.url_retour_err);
  // A second checkout call RESUMES the same reference (P3-B3) -- no new attempt.
  const again = await checkout("order-A1", "tok-A1");
  assert.equal(again.resumed, true);
  assert.equal(again.fields.reference, r.ready.fields.reference);
});

test("E2E pending_partner: attente_partenaire -> inbox ignored, attempt stays pending", async (t) => {
  const r = await runScenario(t, "pending_partner");
  assert.equal(r.txn.status, "pending");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.processingStatus]), [["pending", "ignored"]]);
  assert.equal(confirmCalls(r.db).length, 0);
});

test("E2E abandoned: no notification at all, redirect err, attempt stays pending and is resumed by the next checkout", async (t) => {
  const r = await runScenario(t, "abandoned");
  assert.deepEqual(r.decision.notifications, []);
  assert.deepEqual(r.transportLog, []);
  assert.equal(r.txn.status, "pending");
  assert.equal(r.events.length, 0);
  assert.equal(r.decision.location, r.ready.fields.url_retour_err);
  const again = await checkout("order-A1", "tok-A1");
  assert.equal(again.resumed, true);
  assert.equal(r.db.calls.filter((c) => c.name === "initiate_payment_attempt").length, 1, "exactly one attempt ever created");
});

test("E2E delayed_confirmation: browser returns on url_retour_ok BEFORE any S2S -> order still pending (never paid from a redirect); later `paid` on the same reference converges", async (t) => {
  const r = await runScenario(t, "delayed_confirmation");
  assert.equal(r.decision.location, r.ready.fields.url_retour_ok);
  assert.equal(r.order.paymentStatus, "pending", "a redirect alone NEVER marks paid");
  assert.equal(r.events.length, 0);
  const later = await decide(r.ready, r.page.binding!, "paid", inProcessFetch());
  assert.equal(later.kind, "redirect");
  assert.equal(r.db.orders.get("order-A1")!.paymentStatus, "paid");
  assert.equal(confirmCalls(r.db).length, 1);
});

test("E2E delayed confirmation via RECOVERY WORKER: Stage B skipped at callback time (claim unavailable), the scheduled worker converges exactly once", async (t) => {
  const db = seed(t);
  const ready = await checkout("order-A1", "tok-A1");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  // Make the synchronous Stage B claim fail ONCE (as a transient outage would).
  const original = db.handle.bind(db);
  let claimFailures = 1;
  db.handle = (name, args) => {
    if (name === "claim_payment_provider_event_by_id" && claimFailures > 0) {
      claimFailures -= 1;
      return { data: null, error: { code: "40001", message: "transient" } };
    }
    return original(name, args);
  };
  const decision = await decide(ready, page.binding!, "paid", inProcessFetch());
  assert.equal(decision.kind, "redirect");
  if (decision.kind !== "redirect") return;
  assert.equal(decision.notifications[0].delivered, true, "ACK positive even though Stage B did not run (durable record acquired)");
  assert.equal(db.orders.get("order-A1")!.paymentStatus, "pending");
  assert.equal(db.eventsFor(ready.fields.reference)[0].processingStatus, "received");
  const res = await recoverGET(new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", { method: "GET", headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  assert.equal(res.status, 200);
  assert.equal(db.orders.get("order-A1")!.paymentStatus, "paid");
  assert.equal(db.eventsFor(ready.fields.reference)[0].processingStatus, "applied");
  assert.equal(confirmCalls(db).length, 1);
});

test("E2E unknown_code -> recorded unknown, ignored, never applied", async (t) => {
  const r = await runScenario(t, "unknown_code");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.providerEventCode, e.processingStatus]), [["unknown", "xyz_unexpected", "ignored"]]);
  assert.equal(r.txn.status, "pending");
  assert.equal(confirmCalls(r.db).length, 0);
});

test("E2E mode_mismatch: production code `paiement` under mode test -> degraded to unknown before recording, never applied", async (t) => {
  const r = await runScenario(t, "mode_mismatch");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.providerEventCode, e.processingStatus]), [["unknown", "paiement", "ignored"]]);
  assert.equal(r.txn.status, "pending");
  assert.equal(confirmCalls(r.db).length, 0);
});

test("E2E bad_mac: ACK cdr=1, NOTHING recorded, notifier does not retry an authenticated rejection", async (t) => {
  const r = await runScenario(t, "bad_mac");
  assert.deepEqual(r.decision.notifications.map((n) => [n.delivered, n.rejected, n.attempts]), [[false, true, 1]]);
  assert.equal(r.decision.notifications[0].ack, "version=2\ncdr=1\n");
  assert.equal(r.events.length, 0);
  assert.equal(r.txn.status, "pending");
  assert.equal(r.db.calls.filter((c) => c.name === "record_payment_provider_event").length, 0);
});

test("E2E amount_tamper (MAC valid, montant +1.00): recorded paid, Stage B ignored/AMOUNT_CURRENCY_MISMATCH, never applied", async (t) => {
  const r = await runScenario(t, "amount_tamper");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.amount, e.processingStatus, e.errorClass]), [["paid", "26.00", "ignored", "AMOUNT_CURRENCY_MISMATCH"]]);
  assert.equal(r.txn.status, "pending");
  assert.equal(confirmCalls(r.db).length, 0);
});

test("E2E currency_tamper (MAC valid, USD): recorded paid, Stage B ignored/AMOUNT_CURRENCY_MISMATCH, never applied", async (t) => {
  const r = await runScenario(t, "currency_tamper");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.currency, e.processingStatus, e.errorClass]), [["paid", "USD", "ignored", "AMOUNT_CURRENCY_MISMATCH"]]);
  assert.equal(r.txn.status, "pending");
  assert.equal(confirmCalls(r.db).length, 0);
});

test("E2E duplicate_paid: identical notification twice -> one event (fingerprint replay), one confirm, both ACK positive", async (t) => {
  const r = await runScenario(t, "duplicate_paid");
  assert.deepEqual(r.decision.notifications.map((n) => n.delivered), [true, true]);
  assert.equal(r.events.length, 1, "replay deduplicated by fingerprint");
  assert.equal(r.events[0].processingStatus, "applied");
  assert.equal(confirmCalls(r.db).length, 1);
  assert.equal(r.txn.status, "paid");
});

test("E2E refused_then_paid (ordering): refused ignored, then paid applied", async (t) => {
  const r = await runScenario(t, "refused_then_paid");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.processingStatus]), [["refused", "ignored"], ["paid", "applied"]]);
  assert.equal(r.txn.status, "paid");
  assert.equal(confirmCalls(r.db).length, 1);
});

test("E2E paid_then_refused (late refusal): paid applied, late refused recorded+ignored, terminal lock-in untouched", async (t) => {
  const r = await runScenario(t, "paid_then_refused");
  assert.deepEqual(r.events.map((e) => [e.providerEventType, e.processingStatus]), [["paid", "applied"], ["refused", "ignored"]]);
  assert.equal(r.txn.status, "paid");
  assert.equal(r.order.paymentStatus, "paid");
  assert.equal(confirmCalls(r.db).length, 1);
});

test("E2E provider_timeout_retry: two simulated timeouts then delivery -> attempts=3, applied exactly once", async (t) => {
  const r = await runScenario(t, "provider_timeout_retry");
  assert.deepEqual(r.decision.notifications.map((n) => [n.delivered, n.attempts, n.attemptOutcomes]), [[true, 3, ["simulated_timeout", "simulated_timeout", "ack_success"]]]);
  assert.equal(r.transportLog.length, 1);
  assert.equal(r.txn.status, "paid");
  assert.equal(confirmCalls(r.db).length, 1);
});

// --------------------------------------------------------------------
// Isolation and forgery resistance
// --------------------------------------------------------------------

test("ISOLATION: a LIVE merchant's form is refused by the simulator page (404, gate closed by mode) -- and its checkout never pointed there", async (t) => {
  const db = seed(t);
  const ready = await checkout("order-B1", "tok-B1");
  assert.notEqual(ready.submissionUrl, "https://checkout.example.test/api/internal/payments/monetico/simulator/page");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  assert.equal(page.status, 404);
  assert.equal(db.calls.filter((c) => c.name === "get_payment_provider_credential" && c.args.p_restaurant_id === "resto-B").length, 1, "credential read happens ONLY through the checkout runtime, never by the simulator for a live merchant");
  // and an operator decision on a live reference is refused too
  const decision = await handleSimulatorDecision({ body: { scenario: "paid", operatorSecret: SECRET, reference: ready.fields.reference, url_retour_ok: ready.fields.url_retour_ok, url_retour_err: ready.fields.url_retour_err, binding: "0".repeat(64) }, fetchImpl: inProcessFetch() });
  assert.equal(decision.kind, "invalid", "binding check precedes any merchant lookup");
});

test("ISOLATION: a notification for merchant A's reference signed with merchant C's key is rejected by the real callback (cdr=1, nothing recorded)", async (t) => {
  const db = seed(t);
  const ready = await checkout("order-A1", "tok-A1");
  const forged = buildSimulatedCallback({ step: { codeRetour: "payetest" }, reference: ready.fields.reference, tpe: CRED_A.tpe, amount: "25.00", currency: "EUR", credential: CRED_C, now: new Date() });
  const res = await callbackPOST(new NextRequest("https://checkout.example.test/api/payments/monetico/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(forged).toString() }));
  assert.equal(await res.text(), "version=2\ncdr=1\n");
  assert.equal(db.eventsFor(ready.fields.reference).length, 0);
  assert.equal(db.txnByReference("monetico", ready.fields.reference)!.status, "pending");
});

test("ISOLATION: merchant C's form posted with merchant A's reference is rejected by the page (MAC/TPE mismatch), nothing changes", async (t) => {
  const db = seed(t);
  const readyA = await checkout("order-A1", "tok-A1");
  const readyC = await checkout("order-C1", "tok-C1");
  const crossed = { ...(readyC.fields as unknown as Record<string, string>), reference: readyA.fields.reference };
  const page = await hostedPage(crossed);
  assert.equal(page.status, 400);
  assert.ok(page.html.includes("tpe_mismatch") || page.html.includes("mac_invalid"));
  assert.equal(db.eventsFor(readyA.fields.reference).length, 0);
});

test("FORGERY: a decision whose binding was minted for another reference/URL, or with a foreign return URL, is refused before any notification", async (t) => {
  const db = seed(t);
  const ready = await checkout("order-A1", "tok-A1");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  const log: string[] = [];
  const transport = inProcessFetch(log);
  const swapped = await decide(ready, page.binding!, "paid", transport, { url_retour_ok: "https://evil.example/ok" });
  assert.deepEqual(swapped, { kind: "invalid", reason: "binding_invalid" });
  const otherRef = await decide(ready, page.binding!, "paid", transport, { reference: "000000000000" });
  assert.deepEqual(otherRef, { kind: "invalid", reason: "binding_invalid" });
  assert.deepEqual(log, []);
  assert.equal(db.eventsFor(ready.fields.reference).length, 0);
});

test("FORGERY: the page rejects a form whose amount differs from the authoritative attempt even if the merchant signed it", async (t) => {
  const db = seed(t);
  const ready = await checkout("order-A1", "tok-A1");
  // Re-sign a tampered amount with the merchant's own key (a compromised
  // merchant front-end) -- the simulator still refuses it.
  const { buildMoneticoPaymentRequest } = await import("../lib/server/payment-providers/monetico/request.ts");
  const resigned = buildMoneticoPaymentRequest({ credential: CRED_A, amount: 1, currency: "EUR", reference: ready.fields.reference, language: "FR", orderCorrelationId: "order-A1", urlRetourOk: ready.fields.url_retour_ok, urlRetourErr: ready.fields.url_retour_err });
  const page = await hostedPage(resigned as unknown as Record<string, string>);
  assert.equal(page.status, 400);
  assert.ok(page.html.includes("amount_mismatch"));
  assert.equal(db.eventsFor(ready.fields.reference).length, 0);
});

test("SIDE EFFECTS: a simulated paid run triggers no network call other than the in-process application callback, and no RPC outside the payment pipeline", async (t) => {
  const r = await runScenario(t, "paid");
  assert.deepEqual(r.transportLog, ["https://checkout.example.test/api/payments/monetico/callback"]);
  const allowed = new Set([
    "get_order_payment_context", "get_order_currency_preflight", "get_payment_runtime_provider_environment", "get_order_active_payment_attempt",
    "get_payment_provider_credential", "get_order_billing_context", "get_order_service_mode", "initiate_payment_attempt",
    "get_payment_transaction_correlation", "record_payment_provider_event", "claim_payment_provider_event_by_id",
    "update_payment_provider_event_processing_status", "confirm_payment_attempt",
    // Stuart post-payment hook (D1 v1.1): its FIRST step is a read-only
    // eligibility RPC; for a pickup order it stops there (observed and
    // pinned below). Transport is structurally non-live (post-payment-hook-wiring.ts).
    "get_stuart_delivery_eligibility",
  ]);
  const unexpected = r.db.calls.map((c) => c.name).filter((n) => !allowed.has(n));
  assert.deepEqual(unexpected, [], "no notification/email/WhatsApp/settlement RPC may be reached by a simulated payment");
  const stuartCalls = r.db.calls.filter((c) => c.name.includes("stuart")).map((c) => c.name);
  assert.deepEqual(stuartCalls, ["get_stuart_delivery_eligibility"], "pickup order: Stuart hook stops at the read-only eligibility check");
});
