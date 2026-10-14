import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * MONETICO PAYMENT SIMULATOR v1.2 — REMEDIATION PROOFS (audit Cat Turing,
 * re-audit v1.1: SEC-01 FAIL, AUTH-03 FAIL, SIDE-04 FAIL, ENV-02 PASS).
 *
 * Part A — auditor counterexamples, encoded against v1.2 behaviour. Run
 *          unmodified on the v1.1 candidate (b16787fc) they FAIL (that run
 *          is the reproduction, see the handoff); on v1.2 they pass.
 * Part B — REAL PostgreSQL proofs of the SQL draft (PGlite): application
 *          guards, live-merchant revocation, atomic consumption, Stuart
 *          revocation, rollback.
 * Part C — MULTI-PROCESS proof: N independent Node processes (+ in-process
 *          parallel calls) race on the same token through the real v1.2
 *          TS path against ONE shared database -> exactly one success;
 *          a NEW process (restart) is refused.
 * Part D — ENV-02 preserved (unchanged behaviour, negative tests).
 */

const envHelper = await import("./helpers/monetico-simulator-env.ts");
envHelper.installOpenGateEnvGlobally();
const { openGateEnv, withEnv, OPERATOR_SECRET: SECRET, OTHER_PROJECT_REF, TEST_PROJECT_REF, syntheticServiceRoleJwt, SYNTHETIC_TPES, AUTHORITY_ROW } = envHelper;

const policy = await import("../lib/server/payment-providers/monetico/simulator/policy.ts");
const { NextRequest } = await import("next/server");
const { POST: pagePOST } = await import("../app/api/internal/payments/monetico/simulator/page/route.ts");
const { POST: callbackPOST } = await import("../app/api/payments/monetico/callback/route.ts");
const { handleSimulatorDecision } = await import("../lib/server/payment-providers/monetico/simulator/runtime.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");
const { InMemoryPaymentDb } = await import("./helpers/monetico-simulator-db.ts");
const sqlh = await import("./helpers/monetico-simulator-authority-db.ts");

const OPEN = openGateEnv();
const CRED_A = { tpe: SYNTHETIC_TPES.A, societe: "societeA", securityKey: "0123456789abcdef0123456789abcdef01234567" };

function seed(t: { mock: { method: Function } }, opts: { authority?: boolean } = {}) {
  const db = new InMemoryPaymentDb();
  db.install(t, client);
  if (opts.authority !== false) db.installAuthority(AUTHORITY_ROW);
  db.addMerchant({ id: "resto-A", mode: "test", isEnabled: true, configurationStatus: "verified", credential: CRED_A });
  db.addOrder({ id: "order-A1", restaurantId: "resto-A", publicToken: "tok-A1", paymentStatus: "failed", total: "25.00", currency: "EUR" });
  db.addOrder({ id: "order-A-delivery", restaurantId: "resto-A", publicToken: "tok-AD", paymentStatus: "failed", total: "30.00", currency: "EUR", serviceMode: "delivery" });
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
  return handleSimulatorDecision({ body: { scenario, operatorSecret: SECRET, reference: ready.fields.reference, url_retour_ok: ready.fields.url_retour_ok!, url_retour_err: ready.fields.url_retour_err! , binding }, fetchImpl: inProcessFetch(log) });
}

// ===================================================================== A

test("A/SEC-01 (a): mutually CONSISTENT variables all pointing at ONE project cannot open the gate when that project holds no trusted authority (production) -- routes 404, runtime keeps the real URL", async (t) => {
  const db = seed(t, { authority: false });
  // The v1.1 counterexample: EVERY variable -- including v1.1's own
  // PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF / _ALLOWED_TPES -- points
  // consistently at ONE project (production). v1.2 ignores those two.
  const consistent = { NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_PROJECT_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: syntheticServiceRoleJwt(OTHER_PROJECT_REF), SCANYM_PRODUCTION_SUPABASE_PROJECT_REF: undefined, PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: OTHER_PROJECT_REF, PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: SYNTHETIC_TPES.A };
  await withEnv(consistent, async () => {
    const ready = await checkout("order-A1", "tok-A1");
    assert.ok(!ready.submissionUrl.includes("/simulator/"), "v1.1 opened the simulator for consistent variables; v1.2 requires the DB authority");
    const page = await hostedPage(ready.fields as unknown as Record<string, string>);
    assert.equal(page.status, 404);
  });
  assert.equal(db.eventsFor("x").length, 0);
});

test("A/SEC-01 (b): a database that holds a LIVE merchant revokes the authority at every read, even after the lot was (wrongly) applied", async (t) => {
  const db = seed(t);
  db.addMerchant({ id: "resto-L", mode: "live", isEnabled: true, configurationStatus: "verified", credential: { tpe: "1111111", societe: "s", securityKey: "0".repeat(40) } });
  await withEnv({ PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: TEST_PROJECT_REF, PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: SYNTHETIC_TPES.A }, async () => {
    const ready = await checkout("order-A1", "tok-A1");
    assert.ok(!ready.submissionUrl.includes("/simulator/"), "v1.1 trusted the environment; v1.2 asks the database, which revokes itself when a live merchant exists");
    assert.equal((await hostedPage(ready.fields as unknown as Record<string, string>)).status, 404);
  });
  void db;
});

test("A/SEC-01 (c): the synthetic TPE allowlist is the DB authority's, not an environment variable -- a merchant outside it is refused", async (t) => {
  const db = seed(t);
  db.installAuthority({ ...AUTHORITY_ROW, allowedTpes: [SYNTHETIC_TPES.C] });
  await withEnv({ PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: TEST_PROJECT_REF, PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: SYNTHETIC_TPES.A }, async () => {
    const ready = await checkout("order-A1", "tok-A1");
    assert.equal((await hostedPage(ready.fields as unknown as Record<string, string>)).status, 404, "v1.1 served merchant A because the ENV allowlist said so; v1.2 obeys the DB authority (C only)");
  });
  assert.equal(db.decisionTokens.size, 0);
});

const V11_ENV = { PAYMENT_MONETICO_SIMULATOR_SUPABASE_PROJECT_REF: TEST_PROJECT_REF, PAYMENT_MONETICO_SIMULATOR_ALLOWED_TPES: `${SYNTHETIC_TPES.A},${SYNTHETIC_TPES.C}` };

test("A/AUTH-03: the token state is in the DATABASE -- a second consumption from a process with NO memory of the first (fresh client, no registry) is refused; no second notification", async (t) => withEnv(V11_ENV, async () => {
  const db = seed(t);
  const log: string[] = [];
  const ready = await checkout("order-A1", "tok-A1");
  const page = await hostedPage(ready.fields as unknown as Record<string, string>);
  const first = await decide(ready, page.binding!, "refused", log);
  assert.equal(first.kind, "redirect");
  // "Restart": there is no process-local state to clear in v1.2 (v1.1 kept a Map); the database row is consumed.
  assert.notEqual(db.decisionTokens.get(page.binding!)!.consumedAtMs, null);
  const replay = await decide(ready, page.binding!, "refused", log);
  assert.deepEqual(replay, { kind: "invalid", reason: "token_already_used" });
  assert.equal(log.length, 1);
}));

test("A/SIDE-04: a simulated paid DELIVERY order on the test project creates NO delivery job row (allocation RPC revoked by the lot), no external HTTP, payment still applied", async (t) => withEnv(V11_ENV, async () => {
  const db = seed(t);
  const log: string[] = [];
  const originalFetch = globalThis.fetch;
  const external: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => { external.push(String(url)); throw new Error("EXTERNAL CALL " + String(url)); }) as typeof fetch;
  try {
    const ready = await checkout("order-A-delivery", "tok-AD");
    const page = await hostedPage(ready.fields as unknown as Record<string, string>);
    const decision = await decide(ready, page.binding!, "paid", log);
    assert.equal(decision.kind, "redirect");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(external, []);
  assert.equal(db.stuartJobs.size, 0, "v1.1 allocated a stuart_delivery_jobs row; v1.2 test project cannot");
  assert.equal(db.orders.get("order-A-delivery")!.paymentStatus, "paid");
  assert.ok(!db.calls.some((c) => /schedul|csdj|slot|notification|outbox|email|whatsapp/i.test(c.name)), "no scheduling / notification RPC");
}));

// ===================================================================== B

test("B/SQL: the lot refuses to apply without an explicit project ref, refuses a database holding a LIVE merchant, and refuses double application", async () => {
  await assert.rejects(sqlh.createAuthorityDb({ withoutProjectRef: true }), /simulator_project_ref/);
  await assert.rejects(sqlh.createAuthorityDb({ withLiveMerchant: true }), /LIVE/);
  const db = await sqlh.createAuthorityDb();
  await db.exec(`set app.simulator_project_ref = '${sqlh.TEST_PROJECT_REF}';`);
  await assert.rejects(db.exec(sqlh.readSql("DRAFT-lot-monetico-simulator-test-authority-v1.sql")), /déjà appliquée/);
});

test("B/SQL: get_simulator_authority returns the ref + synthetic TPEs, and is REVOKED (42501) as soon as a live merchant appears", async () => {
  const db = await sqlh.createAuthorityDb();
  const a = await sqlh.pgliteRpc(db, "get_simulator_authority", {});
  assert.equal(a.error, null);
  const row = (a.data as Array<Record<string, unknown>>)[0];
  assert.equal(row.project_ref, sqlh.TEST_PROJECT_REF);
  assert.match(String(row.authority_secret), /^[0-9a-f]{64}$/);
  assert.deepEqual(row.allowed_tpes, ["1234567", "7654321"]);
  await db.exec(`insert into public.payment_provider_configs (restaurant_id, provider_code, mode, is_enabled) values ('${sqlh.RESTO_B}', 'x', 'live', true);`);
  const b = await sqlh.pgliteRpc(db, "get_simulator_authority", {});
  assert.equal(b.error?.code, "42501");
  // Direct table access is not granted to application roles.
  const priv = await db.query("select has_table_privilege('service_role', 'public.simulator_authority', 'select') as s, has_table_privilege('anon', 'public.simulator_authority', 'select') as a");
  assert.deepEqual(priv.rows[0], { s: false, a: false });
});

test("B/SQL: token issue binds merchant/order/transaction/reference/URLs from the ATTEMPT ROW; requires pending; consume is single-use, checks expiry (DB clock) and binding; cross-merchant swap refused", async () => {
  const db = await sqlh.createAuthorityDb();
  const nonce = "a".repeat(32);
  const ok = "https://checkout.example.test/ok", err = "https://checkout.example.test/err";
  const issued = await sqlh.pgliteRpc(db, "issue_simulator_decision_token", { p_nonce: nonce, p_provider_code: "monetico", p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err, p_ttl_seconds: 600 });
  assert.equal(issued.error, null, JSON.stringify(issued.error));
  const irow = (issued.data as Array<Record<string, unknown>>)[0];
  assert.equal(irow.transaction_id, sqlh.TXN_A1);
  assert.equal(irow.order_id, sqlh.ORDER_A1);
  assert.equal(irow.restaurant_id, sqlh.RESTO_A);
  // Binding mismatch (other merchant's reference) -> 23514, token NOT consumed.
  const swap = await sqlh.pgliteRpc(db, "consume_simulator_decision_token", { p_nonce: nonce, p_provider_reference: "refB1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err });
  assert.equal(swap.error?.code, "23514");
  const c1 = await sqlh.pgliteRpc(db, "consume_simulator_decision_token", { p_nonce: nonce, p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err });
  assert.equal(c1.error, null);
  const c2 = await sqlh.pgliteRpc(db, "consume_simulator_decision_token", { p_nonce: nonce, p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err });
  assert.equal(c2.error?.code, "42501");
  // Expired (DB clock): force expires_at into the past.
  const n2 = "b".repeat(32);
  await sqlh.pgliteRpc(db, "issue_simulator_decision_token", { p_nonce: n2, p_provider_code: "monetico", p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err, p_ttl_seconds: 600 });
  await db.query("update public.simulator_decision_tokens set issued_at = now() - interval '1 hour', expires_at = now() - interval '59 minutes' where nonce = $1", [n2]);
  const ex = await sqlh.pgliteRpc(db, "consume_simulator_decision_token", { p_nonce: n2, p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err });
  assert.equal(ex.error?.code, "22023");
  // Unknown nonce; non-pending attempt.
  assert.equal((await sqlh.pgliteRpc(db, "consume_simulator_decision_token", { p_nonce: "c".repeat(32), p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err })).error?.code, "P0002");
  await db.query("update public.payment_transactions set status = 'paid' where id = $1", [sqlh.TXN_A1]);
  assert.equal((await sqlh.pgliteRpc(db, "issue_simulator_decision_token", { p_nonce: "d".repeat(32), p_provider_code: "monetico", p_provider_reference: "refA1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err, p_ttl_seconds: 600 })).error?.code, "42501");
  // TTL is clamped server-side (never beyond 15 minutes).
  const clamp = await sqlh.pgliteRpc(db, "issue_simulator_decision_token", { p_nonce: "e".repeat(32), p_provider_code: "monetico", p_provider_reference: "refB1xxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err, p_ttl_seconds: 999999 });
  assert.equal(clamp.error, null);
  const ttl = await db.query("select extract(epoch from (expires_at - issued_at)) as s from public.simulator_decision_tokens where nonce = $1", ["e".repeat(32)]);
  assert.equal(Number((ttl.rows[0] as { s: number }).s), 900);
});

test("B/SQL (SIDE-04): the lot REVOKES execute on every Stuart allocation/send RPC from service_role; the rollback restores it and removes the authority", async () => {
  const db = await sqlh.createAuthorityDb();
  const fns = ["public.allocate_stuart_delivery_job(uuid,uuid,text,text)", "public.mark_stuart_delivery_job_send_started(uuid,uuid,uuid)", "public.confirm_stuart_delivery_job_created(uuid,uuid,uuid,text)", "public.mark_stuart_delivery_job_ambiguous(uuid,uuid,uuid)", "public.mark_stuart_delivery_job_terminal_failure(uuid,uuid,uuid)"];
  for (const f of fns) {
    const r = await db.query(`select has_function_privilege('service_role', '${f}', 'execute') as ok`);
    assert.equal((r.rows[0] as { ok: boolean }).ok, false, f);
  }
  await sqlh.applyRollback(db);
  for (const f of fns) {
    const r = await db.query(`select has_function_privilege('service_role', '${f}', 'execute') as ok`);
    assert.equal((r.rows[0] as { ok: boolean }).ok, true, f);
  }
  const gone = await db.query("select to_regclass('public.simulator_authority') as t, to_regproc('public.get_simulator_authority') as f");
  assert.deepEqual(gone.rows[0], { t: null, f: null });
});

// ===================================================================== C

function run(cmd: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ stdout, code }));
  });
}

test("C/AUTH-03 MULTI-PROCESS: 4 independent Node processes x 3 simultaneous calls each race on ONE token against ONE real PostgreSQL -> exactly 1 success, 11 token_already_used; a 5th process started afterwards (restart) is refused", { timeout: 120_000 }, async () => {
  const server = spawn(process.execPath, ["tests/helpers/monetico-simulator-token-server.mjs"], { cwd: process.cwd() });
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout.on("data", (d) => { out += d; const m = /READY (\d+)/.exec(out); if (m) resolve(m[1]); });
    server.on("exit", (c) => reject(new Error("server exited " + c)));
  });
  try {
    const nonce = "f".repeat(32);
    const ok = "https://checkout.example.test/ok", err = "https://checkout.example.test/err";
    const issue = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: JSON.stringify({ name: "issue_simulator_decision_token", args: { p_nonce: nonce, p_provider_code: "monetico", p_provider_reference: "refMPxxxxxxx", p_url_retour_ok: ok, p_url_retour_err: err, p_ttl_seconds: 600 } }) }).then((r) => r.json());
    assert.equal(issue.error, null, JSON.stringify(issue.error));

    const clientArgs = ["--experimental-strip-types", "tests/helpers/monetico-simulator-token-client.mjs", port, nonce, "refMPxxxxxxx", ok, err, "3"];
    const procs = await Promise.all([1, 2, 3, 4].map(() => run(process.execPath, clientArgs)));
    const all = procs.flatMap((p) => {
      assert.equal(p.code, 0, p.stdout);
      return (JSON.parse(p.stdout.trim()) as { pid: number; results: Array<{ ok: boolean; reason?: string }> }).results;
    });
    assert.equal(all.length, 12);
    assert.equal(all.filter((r) => r.ok).length, 1, JSON.stringify(all));
    assert.equal(all.filter((r) => !r.ok && r.reason === "token_already_used").length, 11, JSON.stringify(all));

    // Restart: a brand-new process, after everything above finished.
    const late = await run(process.execPath, [...clientArgs.slice(0, -1), "1"]);
    const lateResults = (JSON.parse(late.stdout.trim()) as { results: Array<{ ok: boolean; reason?: string }> }).results;
    assert.deepEqual(lateResults, [{ ok: false, reason: "token_already_used" }]);
  } finally {
    server.kill("SIGTERM");
  }
});

// ===================================================================== D

test("D/ENV-02 preserved: allowlist mandatory, production refused even if listed, metadata missing refused, NODE_ENV never consulted (unchanged from v1.1)", () => {
  const AUTH = { projectRef: TEST_PROJECT_REF, allowedTpes: ["1234567"] };
  const r = (env: Record<string, string | undefined>) => policy.isSimulatorRoutingActive("test", { ...OPEN, ...env }, AUTH);
  assert.deepEqual(r({}), { active: true });
  assert.deepEqual(r({ VERCEL_ENV: undefined, NODE_ENV: "test" }), { active: false, reason: "platform_environment_missing" });
  assert.deepEqual(r({ VERCEL_ENV: "production", PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,development,production" }), { active: false, reason: "production_deployment" });
  assert.deepEqual(r({ VERCEL_ENV: "staging" }), { active: false, reason: "environment_not_allowlisted" });
  assert.deepEqual(r({ PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: undefined }), { active: false, reason: "allowlist_missing_or_invalid" });
  assert.deepEqual(r({ PAYMENT_MONETICO_SIMULATOR_ALLOWED_ENVIRONMENTS: "preview,staging" }), { active: false, reason: "allowlist_missing_or_invalid" });
  // Policy source with comments stripped: NODE_ENV must not be read anywhere.
  const src = readFileSync("lib/server/payment-providers/monetico/simulator/policy.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /NODE_ENV/);
});
