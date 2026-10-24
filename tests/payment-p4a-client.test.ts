import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ====================================================================
// PAYMENT P4-A -- unités CLIENT (sans MenuView) :
//   - lib/payment-redirect.ts : formulaire POST vers Monetico, champs
//     rejoués tels quels, https obligatoire ;
//   - lib/services/payment-checkout.ts : lecture FERMÉE des réponses de
//     la route (tout inattendu -> `unavailable`, jamais une redirection).
// ====================================================================

const { buildPaymentRedirectForm, submitPaymentRedirect } = await import("../lib/payment-redirect.ts");
const { startOnlineCheckout } = await import("../lib/services/payment-checkout.ts");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://shop.example.test/" });
const { window } = dom;

test("[P4A-C1] buildPaymentRedirectForm : POST, action exacte, un input hidden par champ, valeurs identiques (y compris MAC), ordre conservé", () => {
  const fields = { version: "3.0", TPE: "35VV71I", montant: "3.50EUR", MAC: "ab12" };
  const form = buildPaymentRedirectForm(window.document, "https://p.monetico-services.com/test/paiement.cgi", fields);
  assert.equal(form.method.toUpperCase(), "POST");
  assert.equal(form.action, "https://p.monetico-services.com/test/paiement.cgi");
  const inputs = [...form.querySelectorAll("input")] as HTMLInputElement[];
  assert.deepEqual(inputs.map((i) => [i.type, i.name, i.value]), Object.entries(fields).map(([k, v]) => ["hidden", k, v]));
  assert.equal(form.getAttribute("accept-charset"), "UTF-8");
});

test("[P4A-C2] URL non https -> exception, aucun formulaire", () => {
  for (const bad of ["http://p.monetico-services.com/paiement.cgi", "javascript:alert(1)", "//evil/x", ""]) {
    assert.throws(() => buildPaymentRedirectForm(window.document, bad, { a: "1" }), /PAYMENT_REDIRECT_INSECURE_URL/, bad);
  }
});

test("[P4A-C3] submitPaymentRedirect : le formulaire est attaché au document puis soumis UNE fois", () => {
  const proto = window.HTMLFormElement.prototype as any;
  const original = proto.submit;
  let submitted = 0;
  proto.submit = function () { submitted++; };
  try {
    submitPaymentRedirect(window.document, "https://p.monetico-services.com/test/paiement.cgi", { a: "1" });
    assert.equal(submitted, 1);
    assert.ok(window.document.querySelector('form[data-payment-redirect="monetico"]'));
  } finally {
    proto.submit = original;
  }
});

function fakeFetch(status: number, body: unknown) {
  (globalThis as any).fetch = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("[P4A-C4] startOnlineCheckout : lecture des réponses de la route", async () => {
  const base = { orderId: "o", publicToken: "t" };
  fakeFetch(200, { outcome: "checkout_not_needed", reason: "not_required" });
  assert.deepEqual(await startOnlineCheckout(base), { kind: "not_needed" });
  fakeFetch(200, { outcome: "ready", submissionUrl: "https://x.example/p", fields: { a: "1" }, resumed: false });
  assert.deepEqual(await startOnlineCheckout(base), { kind: "ready", submissionUrl: "https://x.example/p", fields: { a: "1" } });
  fakeFetch(409, { outcome: "billing_required" });
  assert.deepEqual(await startOnlineCheckout(base), { kind: "billing_required" });
  fakeFetch(400, { outcome: "invalid_request", reason: "billing_invalid" });
  assert.deepEqual(await startOnlineCheckout(base), { kind: "billing_invalid" });
});

test("[P4A-C5] startOnlineCheckout : tout l'inattendu -> 'unavailable' (jamais 'ready')", async () => {
  const base = { orderId: "o", publicToken: "t" };
  const cases: Array<[number, unknown]> = [
    [503, { outcome: "provider_unavailable" }],
    [503, { outcome: "checkout_disabled" }],
    [502, { outcome: "unavailable" }],
    [400, { outcome: "invalid_request", reason: "unsupported_currency" }],
    [200, { outcome: "ready", submissionUrl: "http://x.example/p", fields: { a: "1" } }],
    [200, { outcome: "ready", submissionUrl: "https://x.example/p", fields: {} }],
    [200, { outcome: "ready", submissionUrl: "https://x.example/p", fields: { a: 1 } }],
    [200, { outcome: "ready" }],
    [500, "not json"],
    [200, null],
  ];
  for (const [status, body] of cases) {
    (globalThis as any).fetch = async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    assert.deepEqual(await startOnlineCheckout(base), { kind: "unavailable" }, JSON.stringify([status, body]));
  }
  (globalThis as any).fetch = async () => { throw new TypeError("network"); };
  assert.deepEqual(await startOnlineCheckout(base), { kind: "unavailable" });
});

test("[P4A-C6] startOnlineCheckout : le corps envoyé porte exactement orderId/publicToken/language/billing, credentials same-origin", async () => {
  let captured: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    captured = { url, init };
    return new Response(JSON.stringify({ outcome: "checkout_not_needed", reason: "not_required" }), { status: 200 });
  };
  await startOnlineCheckout({ orderId: "o", publicToken: "t", language: "fr", billing: { source: "delivery_reuse", country: "FR" } });
  assert.equal(captured.url, "/api/payments/monetico/checkout");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(captured.init.body), { orderId: "o", publicToken: "t", language: "fr", billing: { source: "delivery_reuse", country: "FR" } });
});

after(() => {
  delete (globalThis as any).fetch;
  window.close();
});
