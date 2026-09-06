import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { getStuartSandboxPricing, StuartPricingProductionForbiddenError, StuartPricingError } = await import(
  "../lib/server/delivery-providers/stuart/pricing.ts"
);
const { invalidateStuartTokenCache } = await import("../lib/server/delivery-providers/stuart/auth.ts");

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const MINIMAL_PAYLOAD = {
  job: {
    pickups: [{ address: "test", contact: { phone: "+33600000000", firstname: "Test", lastname: "User" } }],
    dropoffs: [{ address: "test", contact: { phone: "+33600000000", firstname: "Test", lastname: "User" }, client_reference: "TEST000001", package_type: "small" as const }],
  },
};

test("STUART-V2-PRICING-GATE-01 : STUART_ENV=production -- StuartPricingProductionForbiddenError, AUCUN appel réseau", async (t) => {
  invalidateStuartTokenCache();
  let called = false;
  t.mock.method(globalThis, "fetch", async () => {
    called = true;
    throw new Error("ne doit jamais être appelé");
  });
  await withEnv({ STUART_ENV: "production", STUART_CLIENT_ID: "x", STUART_CLIENT_SECRET: "y" }, async () => {
    await assert.rejects(() => getStuartSandboxPricing(MINIMAL_PAYLOAD), StuartPricingProductionForbiddenError);
  });
  assert.equal(called, false);
});

test("STUART-V2-PRICING-GATE-01 : STUART_ENV=sandbox -- appel réseau autorisé, réponse transmise telle quelle", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fake-token", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ amount: 5.5, currency: "EUR" }), { status: 200 });
  });
  await withEnv({ STUART_ENV: "sandbox", STUART_CLIENT_ID: "x", STUART_CLIENT_SECRET: "y" }, async () => {
    const result = await getStuartSandboxPricing(MINIMAL_PAYLOAD);
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(result.raw, { amount: 5.5, currency: "EUR" });
  });
});

test("STUART-V2-PRICING-GATE-01 : ne mute JAMAIS de commande -- confirmé structurellement (aucun appel RPC/DB, ce module est un pur wrapper HTTP)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("lib/server/delivery-providers/stuart/pricing.ts", "utf8");
  assert.ok(!/\.rpc\(|getServiceRoleSupabaseClient/.test(source), "ce module ne doit contenir AUCUN appel RPC/DB -- un pur wrapper HTTP ne peut structurellement muter aucune donnée de commande");
});

test("STUART-V2-PRICING-GATE-01 : échec HTTP -- StuartPricingError", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "fake-token", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "invalid" }), { status: 422 });
  });
  await withEnv({ STUART_ENV: "sandbox", STUART_CLIENT_ID: "x", STUART_CLIENT_SECRET: "y" }, async () => {
    await assert.rejects(() => getStuartSandboxPricing(MINIMAL_PAYLOAD), StuartPricingError);
  });
});
