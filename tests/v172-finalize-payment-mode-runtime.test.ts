import { test } from "node:test";
import assert from "node:assert/strict";

// ISSUE #172 — initiateCheckout rend le mode « sans paiement en ligne »
// DÉFINITIF (finalize_order_payment_mode_none) avant que l'e-mail de
// confirmation puisse devenir éligible. Jamais sur le chemin paiement en
// ligne. Fail-soft : une panne de la RPC ne change pas le parcours client.
// Client Supabase mocké : aucun réseau, aucune base.

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "v172-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");

type Handler = (args: Record<string, unknown>) => unknown;
function route(t: { mock: { method: Function } }, handlers: Record<string, Handler>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const h = handlers[name];
    if (!h) throw new Error(`RPC inattendue : ${name}`);
    return h(args);
  });
  return calls;
}
const ok = (row: unknown) => ({ data: [row], error: null });

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
  process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = "true";
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
    else process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = prev;
  }
}
const ctx = () => ok({ restaurant_id: "resto-1", payment_status: "not_required" });
const env = (e: object) => () => ok({ provider_code: "monetico", mode: "test", ...e });
const FINAL = { p_order_id: "order-1", p_public_token: "tok-1" };

test("[172-FIN-1] fournisseur non activé/vérifié -> mode 'sans paiement' rendu définitif", async (t) =>
  enabled(async () => {
    for (const e of [
      { is_enabled: false, configuration_status: "verified" },
      { is_enabled: true, configuration_status: "configured" },
    ]) {
      const calls = route(t, {
        get_order_payment_context: ctx,
        get_payment_runtime_provider_environment: env(e),
        finalize_order_payment_mode_none: () => ok({ payment_status: "not_required", payment_mode_final: "none" }),
      });
      const r = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
      assert.deepEqual(r, { outcome: "checkout_not_needed", reason: "not_required" });
      const fin = calls.filter((c) => c.name === "finalize_order_payment_mode_none");
      assert.equal(fin.length, 1);
      assert.deepEqual(fin[0]!.args, FINAL);
      assert.ok(!calls.some((c) => c.name === "require_order_payment"));
      t.mock.restoreAll();
    }
  }));

test("[172-FIN-2] la base refuse le passage à required (statut/total) -> mode 'sans paiement' rendu définitif APRÈS la tentative", async (t) =>
  enabled(async () => {
    const calls = route(t, {
      get_order_payment_context: ctx,
      get_payment_runtime_provider_environment: env({ is_enabled: true, configuration_status: "verified" }),
      require_order_payment: () => ok({ payment_status: "not_required", changed: false }),
      finalize_order_payment_mode_none: () => ok({ payment_status: "not_required", payment_mode_final: "none" }),
    });
    const r = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(r, { outcome: "checkout_not_needed", reason: "not_required" });
    const names = calls.map((c) => c.name);
    assert.ok(names.indexOf("require_order_payment") < names.indexOf("finalize_order_payment_mode_none"));
  }));

test("[172-FIN-3] paiement requis (flip réussi) ou déjà payé : finalize JAMAIS appelée", async (t) =>
  enabled(async () => {
    const calls = route(t, {
      get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "paid" }),
    });
    assert.deepEqual(await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" }), {
      outcome: "checkout_not_needed", reason: "already_paid",
    });
    assert.ok(!calls.some((c) => c.name === "finalize_order_payment_mode_none"));
    t.mock.restoreAll();

    // Flip réussi puis la suite du chemin s'arrête sur une RPC non mockée : on ne vérifie que l'absence de finalize.
    const calls2 = route(t, {
      get_order_payment_context: ctx,
      get_payment_runtime_provider_environment: env({ is_enabled: true, configuration_status: "verified" }),
      require_order_payment: () => ok({ payment_status: "required", changed: true }),
    });
    await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" }).catch(() => undefined);
    assert.ok(calls2.some((c) => c.name === "require_order_payment"));
    assert.ok(!calls2.some((c) => c.name === "finalize_order_payment_mode_none"));
  }));

test("[172-FIN-4] fail-soft : RPC finalize en erreur / exception -> même résultat client, aucune exception", async (t) =>
  enabled(async () => {
    for (const h of [() => ({ data: null, error: { code: "42883", message: "x" } }), () => { throw new Error("réseau"); }]) {
      route(t, {
        get_order_payment_context: ctx,
        get_payment_runtime_provider_environment: env({ is_enabled: false, configuration_status: "not_configured" }),
        finalize_order_payment_mode_none: h,
      });
      assert.deepEqual(await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" }), {
        outcome: "checkout_not_needed", reason: "not_required",
      });
      t.mock.restoreAll();
    }
  }));
