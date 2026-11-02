import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// A196-08 -- route Cron : schéma `Authorization: Bearer <CRON_SECRET>` STRICT,
// porte plateforme fermée => « disabled » sans toucher à la base, exports Next valides.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "r1-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { NextRequest } = await import("next/server");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const route = await import("../app/api/internal/notifications/send/route.ts");
const limits = await import("../lib/server/notifications/merchant-smtp-worker-limits.ts");

const SECRET = "cron-secret-synthetique-0123456789";
const GATE = "NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED";

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
}
const call = (authorization?: string) => route.GET(new NextRequest("http://localhost/api/internal/notifications/send", { headers: authorization === undefined ? {} : { authorization } }));

test("A196-08 : seul `Authorization: Bearer <secret>` est accepté ; secret nu, casse, vide, faux => 401", async () => {
  await withEnv({ CRON_SECRET: SECRET, [GATE]: undefined }, async () => {
    const outcomes: Record<string, number> = {};
    for (const [label, header] of [
      ["sans en-tête", undefined], ["secret nu", SECRET], ["bearer minuscule", `bearer ${SECRET}`], ["Bearer vide", "Bearer "],
      ["Bearer faux", "Bearer nope"], ["Bearer + double espace", `Bearer  ${SECRET}`], ["Basic", `Basic ${SECRET}`], ["Bearer correct", `Bearer ${SECRET}`],
    ] as const) {
      outcomes[label] = (await call(header)).status;
    }
    assert.deepEqual(outcomes, {
      "sans en-tête": 401, "secret nu": 401, "bearer minuscule": 401, "Bearer vide": 401, "Bearer faux": 401,
      "Bearer + double espace": 401, "Basic": 401, "Bearer correct": 200,
    });
  });
});

test("CRON_SECRET non configuré => toujours 401 (jamais d'accès ouvert)", async () => {
  await withEnv({ CRON_SECRET: undefined, [GATE]: "true" }, async () => {
    assert.equal((await call("Bearer ")).status, 401);
    assert.equal((await call("Bearer undefined")).status, 401);
    assert.equal((await call()).status, 401);
  });
});

test("porte plateforme fermée (ou clé de chiffrement absente) => « disabled », AUCUN accès à la base", async (t) => {
  const calls: string[] = [];
  t.mock.method(client, "rpc", async (name: string) => { calls.push(name); return { data: null, error: null }; });
  for (const gate of [undefined, "false", "TRUE", "1", "yes", ""]) {
    await withEnv({ CRON_SECRET: SECRET, [GATE]: gate, MERCHANT_SMTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") }, async () => {
      const res = await call(`Bearer ${SECRET}`);
      assert.equal(res.status, 200, String(gate));
      assert.deepEqual(await res.json(), { ok: true, status: "disabled" }, String(gate));
    });
  }
  await withEnv({ CRON_SECRET: SECRET, [GATE]: "true", MERCHANT_SMTP_ENCRYPTION_KEY: undefined }, async () => {
    assert.deepEqual(await (await call(`Bearer ${SECRET}`)).json(), { ok: true, status: "disabled" });
  });
  assert.deepEqual(calls, [], "aucun RPC (ni reap, ni claim) tant que la porte est fermée");
});

test("porte ouverte : reap puis claim avec les bornes du module de limites (lot 25, bail 300 s)", async (t) => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "recover_new_order_received_notifications") return { data: [{ recovered: 0, failed: 0 }], error: null };
    if (name === "reap_stale_notification_claims") return { data: 2, error: null };
    if (name === "claim_new_order_notifications") return { data: [], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });
  await withEnv({ CRON_SECRET: SECRET, [GATE]: "true", MERCHANT_SMTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") }, async () => {
    const res = await call(`Bearer ${SECRET}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.reaped, 2);
  });
  assert.deepEqual(rpcCalls.map((c) => c.name), ["recover_new_order_received_notifications", "reap_stale_notification_claims", "claim_new_order_notifications"]);
  assert.deepEqual(rpcCalls[2]!.args, { p_batch_size: limits.WORKER_BATCH_SIZE, p_lease_seconds: limits.WORKER_LEASE_SECONDS });
});

test("panne de la base : 503 générique, aucun détail", async (t) => {
  t.mock.method(client, "rpc", async () => { throw new Error("secret-interne postgres://user:pass@host"); });
  await withEnv({ CRON_SECRET: SECRET, [GATE]: "true", MERCHANT_SMTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") }, async () => {
    const res = await call(`Bearer ${SECRET}`);
    assert.equal(res.status, 503);
    const text = JSON.stringify(await res.json());
    assert.equal(text.includes("postgres://"), false);
    assert.deepEqual(JSON.parse(text), { ok: false, status: "worker_failed" });
  });
});

test("la route n'exporte que des noms reconnus par Next (sinon `next build` échoue)", () => {
  const allowed = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "runtime", "dynamic", "maxDuration", "revalidate", "fetchCache", "preferredRegion", "dynamicParams"]);
  for (const name of Object.keys(route)) assert.ok(allowed.has(name), `export non autorisé : ${name}`);
});

test("vercel.json planifie la route Cron toutes les 5 minutes", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
  assert.deepEqual(config.crons.find((c) => c.path === "/api/internal/notifications/send"), { path: "/api/internal/notifications/send", schedule: "*/5 * * * *" });
});
