import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * MONETICO PAYMENT SIMULATOR v1 — ADAPTER UNIT + STRUCTURAL TESTS.
 *
 * inbound  : accepts the REAL `buildMoneticoPaymentRequest` output and
 *            rejects every tampered variant like the real TPE would.
 * outcome  : every scenario step passes the REAL `verifyMoneticoCallback`
 *            with the same credential; `bad_mac` fails it; determinism.
 * notifier : bounded retry, cdr=1 never retried, simulated timeouts,
 *            only ever targets the application callback path.
 * structural: no provider hostname anywhere in the simulator, no new
 *            dependency, the simulator never imports endpoint.ts.
 */

const { buildMoneticoPaymentRequest } = await import("../lib/server/payment-providers/monetico/request.ts");
const { verifyMoneticoCallback } = await import("../lib/server/payment-providers/monetico/callback.ts");
const { classifyMoneticoCodeRetourForMode } = await import("../lib/server/payment-providers/monetico/code-retour.ts");
const { verifyInboundMerchantForm, SimulatorInboundError } = await import(
  "../lib/server/payment-providers/monetico/simulator/inbound.ts"
);
const { buildSimulatedCallback } = await import("../lib/server/payment-providers/monetico/simulator/outcome.ts");
const { listScenarios, resolveScenario, SCENARIO_IDS } = await import(
  "../lib/server/payment-providers/monetico/simulator/scenarios.ts"
);
const { notifyApplicationCallback, buildCallbackUrl } = await import(
  "../lib/server/payment-providers/monetico/simulator/notifier.ts"
);
const { renderHostedPage } = await import("../lib/server/payment-providers/monetico/simulator/page.ts");

const CREDENTIAL = { tpe: "1234567", societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" };
const OTHER_CREDENTIAL = { tpe: "7654321", societe: "societeC", securityKey: "fedcba9876543210fedcba9876543210fedcba98" };
const NOW = new Date(Date.UTC(2026, 9, 13, 10, 0, 0));

function merchantForm(overrides: Record<string, string> = {}) {
  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 25,
      currency: "EUR",
      reference: "abc123def456",
      language: "FR",
      orderCorrelationId: "order-A",
      urlRetourOk: "https://checkout.example.test/checkout/return/ok?orderId=order-A&token=t",
      urlRetourErr: "https://checkout.example.test/checkout/return/err?orderId=order-A&token=t",
    },
    NOW
  );
  return { ...(fields as unknown as Record<string, string>), ...overrides };
}

// ---------------------------------------------------------------- inbound

test("INBOUND: accepts the real checkout-runtime form and exposes only non-secret fields", () => {
  const v = verifyInboundMerchantForm(merchantForm(), CREDENTIAL);
  assert.equal(v.reference, "abc123def456");
  assert.equal(v.amount, "25.00");
  assert.equal(v.currency, "EUR");
  assert.equal(v.tpe, "1234567");
  assert.equal(v.language, "FR");
  assert.deepEqual(v.orderContext, { correlationId: "order-A" });
  assert.ok(!("MAC" in v), "MAC never exposed");
  assert.ok(!JSON.stringify(v).includes(CREDENTIAL.securityKey), "key never exposed");
});

test("INBOUND: rejects like the real TPE -- wrong key, tampered amount, wrong TPE/societe, bad version/date/reference, missing return URLs", () => {
  const expectReason = (raw: Record<string, unknown>, credential = CREDENTIAL, reason: string) => {
    assert.throws(() => verifyInboundMerchantForm(raw, credential), (e: unknown) => e instanceof SimulatorInboundError && e.reason === reason, reason);
  };
  expectReason(merchantForm(), OTHER_CREDENTIAL, "tpe_mismatch");
  expectReason(merchantForm({ TPE: OTHER_CREDENTIAL.tpe }), { ...CREDENTIAL, tpe: OTHER_CREDENTIAL.tpe }, "mac_invalid");
  expectReason(merchantForm(), { ...CREDENTIAL, securityKey: OTHER_CREDENTIAL.securityKey }, "mac_invalid");
  expectReason(merchantForm({ montant: "26.00EUR" }), CREDENTIAL, "mac_invalid");
  expectReason(merchantForm({ societe: "other" }), CREDENTIAL, "societe_mismatch");
  expectReason(merchantForm({ version: "2.0" }), CREDENTIAL, "unsupported_version");
  expectReason(merchantForm({ date: "2026-10-13" }), CREDENTIAL, "invalid_date");
  expectReason(merchantForm({ montant: "25EURO" }), CREDENTIAL, "invalid_montant");
  expectReason(merchantForm({ reference: "too-long-reference-123" }), CREDENTIAL, "invalid_reference");
  const noUrls = merchantForm();
  delete noUrls.url_retour_ok;
  expectReason(noUrls, CREDENTIAL, "missing_return_urls");
  const noMac = merchantForm();
  delete noMac.MAC;
  expectReason(noMac, CREDENTIAL, "malformed");
  expectReason({ ...merchantForm(), extra: 1 }, CREDENTIAL, "malformed");
});

// ---------------------------------------------------------------- outcome

test("OUTCOME: every catalog step produces a callback the REAL verifyMoneticoCallback accepts (except bad_mac), with the documented classification under mode test", () => {
  for (const plan of listScenarios()) {
    for (const step of plan.steps) {
      const fields = buildSimulatedCallback({ step, reference: "abc123def456", tpe: CREDENTIAL.tpe, amount: "25.00", currency: "EUR", credential: CREDENTIAL, now: NOW });
      assert.equal(fields["scanym-simulator"], "1");
      if (step.corruptMac) {
        assert.throws(() => verifyMoneticoCallback(fields, CREDENTIAL), `${plan.id}: corrupted MAC must be rejected by the real verifier`);
        continue;
      }
      const verified = verifyMoneticoCallback(fields, CREDENTIAL);
      assert.equal(verified.codeRetour, step.codeRetour, plan.id);
      assert.equal(verified.providerReference, "abc123def456");
      const classified = classifyMoneticoCodeRetourForMode(verified.codeRetour, "test");
      const expectedClass =
        step.codeRetour === "payetest" ? "paid" : step.codeRetour === "Annulation" ? "refused" : step.codeRetour === "attente_partenaire" ? "pending" : "unknown";
      assert.equal(classified.classification, expectedClass, `${plan.id}/${step.codeRetour}`);
      if (step.codeRetour === "paiement") assert.equal(classified.modeMismatch, true);
      const expectedAmount = ((2500 + (step.amountTamperCents ?? 0)) / 100).toFixed(2) + (step.currencyOverride ?? "EUR");
      assert.equal(verified.rawMontant, expectedAmount, plan.id);
      // numauto accompanies every ACCEPTED code as the real TPE sends it
      // (including `paiement`, which the application then degrades for
      // mode mismatch -- the degradation is the application's job).
      if (/^(payetest|paiement(_pf[2-4])?)$/.test(step.codeRetour)) assert.match(verified.authorizationReference ?? "", /^\d{6}$/);
      else assert.equal(verified.authorizationReference, null);
    }
  }
});

test("OUTCOME: deterministic -- identical inputs give byte-identical fields; a different key gives a different MAC only", () => {
  const step = { codeRetour: "payetest" };
  const a = buildSimulatedCallback({ step, reference: "abc123def456", tpe: CREDENTIAL.tpe, amount: "25.00", currency: "EUR", credential: CREDENTIAL, now: NOW });
  const b = buildSimulatedCallback({ step, reference: "abc123def456", tpe: CREDENTIAL.tpe, amount: "25.00", currency: "EUR", credential: CREDENTIAL, now: NOW });
  assert.deepEqual(a, b);
  const c = buildSimulatedCallback({ step, reference: "abc123def456", tpe: CREDENTIAL.tpe, amount: "25.00", currency: "EUR", credential: { ...CREDENTIAL, securityKey: OTHER_CREDENTIAL.securityKey }, now: NOW });
  const { MAC: macA, ...restA } = a;
  const { MAC: macC, ...restC } = c;
  assert.deepEqual(restA, restC);
  assert.notEqual(macA, macC);
  assert.throws(() => verifyMoneticoCallback(c, CREDENTIAL), "cross-merchant: signed with another merchant's key -> rejected by the real verifier");
});

test("SCENARIOS: strict resolution -- unknown ids, casing, non-strings rejected; catalog ids unique", () => {
  assert.equal(resolveScenario("paid")?.id, "paid");
  for (const bad of ["Paid", "paid ", "", "__proto__", "constructor", 1, null, undefined, ["paid"]]) {
    assert.equal(resolveScenario(bad), null, String(bad));
  }
  assert.equal(new Set(SCENARIO_IDS).size, SCENARIO_IDS.length);
});

// ---------------------------------------------------------------- notifier

function fakeFetch(responses: Array<{ status?: number; body?: string; throws?: boolean }>) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const r = responses.shift() ?? { status: 200, body: "version=2\ncdr=0\n" };
    if (r.throws) throw new Error("ECONNRESET");
    return new Response(r.body ?? "", { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("NOTIFIER: targets ONLY the application callback on the canonical origin; delivered on cdr=0", async () => {
  const f = fakeFetch([{ status: 200, body: "version=2\ncdr=0\n" }]);
  const r = await notifyApplicationCallback({ canonicalOrigin: "https://checkout.example.test", fields: { a: "1", MAC: "x" }, fetchImpl: f.impl });
  assert.deepEqual(r, { delivered: true, rejected: false, attempts: 1, attemptOutcomes: ["ack_success"], ack: "version=2\ncdr=0\n" });
  assert.equal(f.calls[0].url, "https://checkout.example.test/api/payments/monetico/callback");
  assert.equal(f.calls[0].body, "a=1&MAC=x");
  assert.equal(buildCallbackUrl("https://checkout.example.test"), "https://checkout.example.test/api/payments/monetico/callback");
});

test("NOTIFIER: transport errors and non-200 are retried up to the bound, then reported delivered=false without throwing", async () => {
  const f = fakeFetch([{ throws: true }, { status: 500 }, { status: 502 }, { status: 200, body: "version=2\ncdr=0\n" }]);
  const r = await notifyApplicationCallback({ canonicalOrigin: "https://checkout.example.test", fields: { a: "1" }, fetchImpl: f.impl, maxAttempts: 3 });
  assert.equal(r.delivered, false);
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.attemptOutcomes, ["transport_error", "http_500", "http_502"]);
  assert.equal(f.calls.length, 3, "never more than maxAttempts HTTP calls");
});

test("NOTIFIER: recovers within the bound (fail, fail, success) -- provider timeout + retry", async () => {
  const f = fakeFetch([{ throws: true }, { status: 503 }, { status: 200, body: "version=2\ncdr=0\n" }]);
  const r = await notifyApplicationCallback({ canonicalOrigin: "https://checkout.example.test", fields: { a: "1" }, fetchImpl: f.impl, maxAttempts: 3 });
  assert.equal(r.delivered, true);
  assert.equal(r.attempts, 3);
});

test("NOTIFIER: an authenticated negative ACK (cdr=1) is final -- never retried", async () => {
  const f = fakeFetch([{ status: 200, body: "version=2\ncdr=1\n" }]);
  const r = await notifyApplicationCallback({ canonicalOrigin: "https://checkout.example.test", fields: { a: "1" }, fetchImpl: f.impl, maxAttempts: 3 });
  assert.deepEqual(r, { delivered: false, rejected: true, attempts: 1, attemptOutcomes: ["ack_failure"], ack: "version=2\ncdr=1\n" });
  assert.equal(f.calls.length, 1);
});

test("NOTIFIER: simulated transport failures consume attempts WITHOUT any HTTP call", async () => {
  const f = fakeFetch([{ status: 200, body: "version=2\ncdr=0\n" }]);
  const r = await notifyApplicationCallback({ canonicalOrigin: "https://checkout.example.test", fields: { a: "1" }, fetchImpl: f.impl, maxAttempts: 3, simulatedTransportFailures: 2 });
  assert.equal(r.delivered, true);
  assert.deepEqual(r.attemptOutcomes, ["simulated_timeout", "simulated_timeout", "ack_success"]);
  assert.equal(f.calls.length, 1);
  const exhausted = await notifyApplicationCallback({ canonicalOrigin: "https://checkout.example.test", fields: { a: "1" }, fetchImpl: f.impl, maxAttempts: 2, simulatedTransportFailures: 5 });
  assert.equal(exhausted.delivered, false);
  assert.equal(exhausted.attempts, 2);
  assert.equal(f.calls.length, 1, "budget exhausted by timeouts: no HTTP call at all");
});

// ---------------------------------------------------------------- page

test("PAGE: renders no secret material and escapes interpolated values", () => {
  const html = renderHostedPage({
    verified: {
      tpe: "1234567",
      reference: "<script>x</script>",
      montant: "25.00EUR",
      amount: "25.00",
      currency: "EUR",
      date: "13/10/2026:10:00:00",
      language: "FR",
      urlRetourOk: "https://checkout.example.test/ok?a=1&b=\"2\"",
      urlRetourErr: "https://checkout.example.test/err",
      orderContext: null,
    },
    binding: "ab".repeat(32),
    merchantLabel: "resto A",
  });
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes('value="https://checkout.example.test/ok?a=1&amp;b=&quot;2&quot;"'));
  assert.ok(!html.includes(CREDENTIAL.securityKey));
  assert.ok(html.includes('name="operatorSecret" type="password"'));
  assert.ok(html.includes("AUCUN PAIEMENT RÉEL"));
});

// ---------------------------------------------------------------- structural

const SIM_DIR = join(process.cwd(), "lib/server/payment-providers/monetico/simulator");
const ROUTES_DIR = join(process.cwd(), "app/api/internal/payments/monetico/simulator");

function readAll(dir: string): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAll(p));
    else out.push({ file: p, source: readFileSync(p, "utf8") });
  }
  return out;
}

test("STRUCTURAL: the simulator contains NO provider hostname and never imports the real endpoint module -- no real bank call is possible", () => {
  const files = [...readAll(SIM_DIR), ...readAll(ROUTES_DIR), { file: "lib/server/payment-simulator-runtime.ts", source: readFileSync(join(process.cwd(), "lib/server/payment-simulator-runtime.ts"), "utf8") }];
  assert.ok(files.length >= 9);
  for (const { file, source } of files) {
    assert.ok(!/monetico-services\.com/i.test(source), `${file}: provider hostname present`);
    assert.ok(!/paiement\.cgi/i.test(source), `${file}: provider path present`);
    assert.ok(!/monetico\/endpoint/.test(source), `${file}: imports endpoint.ts`);
    assert.ok(!/console\.(log|info|debug)/.test(source), `${file}: logging present`);
    assert.ok(!/\bprocess\.env\.[A-Z_]*(KEY|SECRET)\b/.test(source) || /SIMULATOR_SECRET_ENV|PAYMENT_MONETICO_SIMULATOR_SECRET/.test(source), `${file}: unexpected secret access`);
  }
});

test("STRUCTURAL: the checkout runtime's ONLY new dependency is simulator/policy.ts and the substitution is guarded by isSimulatorRoutingActive", () => {
  const runtime = readFileSync(join(process.cwd(), "lib/server/payment-checkout-runtime.ts"), "utf8");
  const simImports = runtime.match(/from "@\/lib\/server\/payment-providers\/monetico\/simulator\/[^"]+"/g) ?? [];
  assert.deepEqual(simImports, ['from "@/lib/server/payment-providers/monetico/simulator/policy"']);
  assert.match(runtime, /if \(isSimulatorRoutingActive\(environment\.mode\)\.active\) \{\s*submissionUrl = buildSimulatorSubmissionUrl\(origin\);\s*\}/);
  assert.equal((runtime.match(/buildSimulatorSubmissionUrl\(/g) ?? []).length, 1);
});

test("STRUCTURAL: no new runtime dependency added to package.json by the simulator", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@supabase/supabase-js", "fflate", "next", "react", "react-dom", "saxes", "server-only"]);
});

test("STRUCTURAL: no existing payment SQL function is modified and no SQL file is added by this lot", () => {
  const sqlDir = join(process.cwd(), "supabase");
  const names = readdirSync(sqlDir).filter((n) => n.endsWith(".sql"));
  assert.ok(!names.some((n) => /simulator/i.test(n)));
});
