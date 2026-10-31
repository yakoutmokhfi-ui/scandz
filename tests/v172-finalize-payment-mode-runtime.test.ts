import { test } from "node:test";
import assert from "node:assert/strict";

// ISSUE #172 — initiateCheckout rend le mode « sans paiement en ligne »
// DÉFINITIF (finalize_order_payment_mode_none) avant que l'e-mail de
// confirmation puisse devenir éligible. Jamais sur le chemin paiement en
// ligne. T180-01 : le RÉSULTAT de la finalisation décide de la sortie -- une
// panne, un ensemble vide ou une commande déjà sortie de `not_required` ne
// produit JAMAIS `checkout_not_needed` (voir [172-FIN-4] et [172-FIN-5]).
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

test("[172-FIN-4] T180-01 : RPC finalize en erreur / exception / ensemble vide / forme inattendue -> `payment_decision_unavailable`, JAMAIS `checkout_not_needed`", async (t) =>
  enabled(async () => {
    const failures: Array<[string, Handler]> = [
      ["erreur PostgREST", () => ({ data: null, error: { code: "42883", message: "x" } })],
      ["statement timeout", () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })],
      ["exception réseau", () => { throw new Error("réseau"); }],
      ["ensemble vide", () => ({ data: [], error: null })],
      ["data null sans erreur", () => ({ data: null, error: null })],
      ["not_required mais mode non final (NULL)", () => ok({ payment_status: "not_required", payment_mode_final: null })],
      ["not_required mais mode online (incohérent)", () => ok({ payment_status: "not_required", payment_mode_final: "online" })],
      ["statut inconnu", () => ok({ payment_status: "mystery", payment_mode_final: "none" })],
      ["ligne sans champs", () => ok({})],
    ];
    for (const [label, h] of failures) {
      for (const providerEnv of [
        env({ is_enabled: false, configuration_status: "not_configured" }),
        env({ is_enabled: true, configuration_status: "verified" }),
      ]) {
        const calls = route(t, {
          get_order_payment_context: ctx,
          get_payment_runtime_provider_environment: providerEnv,
          // Chemin « prestataire vérifié » : la base refuse le passage à required (statut/total) -> décision « sans paiement » tentée.
          require_order_payment: () => ok({ payment_status: "not_required", changed: false }),
          finalize_order_payment_mode_none: h,
        });
        const r = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
        assert.deepEqual(r, { outcome: "payment_decision_unavailable" }, label);
        assert.equal(calls.filter((c) => c.name === "finalize_order_payment_mode_none").length, 1, label);
        assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"), `${label} : aucune tentative de paiement ouverte`);
        t.mock.restoreAll();
      }
    }
  }));

test("[172-FIN-5] T180-01 : table de décision -- final_none -> not_required ; paid -> already_paid ; required/pending/failed/cancelled -> `payment_decision_unavailable` (jamais confirmé à tort)", async (t) =>
  enabled(async () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ payment_status: "not_required", payment_mode_final: "none" }, { outcome: "checkout_not_needed", reason: "not_required" }],
      [{ payment_status: "paid", payment_mode_final: "online" }, { outcome: "checkout_not_needed", reason: "already_paid" }],
      [{ payment_status: "required", payment_mode_final: "online" }, { outcome: "payment_decision_unavailable" }],
      [{ payment_status: "pending", payment_mode_final: "online" }, { outcome: "payment_decision_unavailable" }],
      [{ payment_status: "failed", payment_mode_final: "online" }, { outcome: "payment_decision_unavailable" }],
      [{ payment_status: "cancelled", payment_mode_final: "online" }, { outcome: "payment_decision_unavailable" }],
    ];
    for (const [row, expected] of cases) {
      route(t, {
        get_order_payment_context: ctx,
        get_payment_runtime_provider_environment: env({ is_enabled: false, configuration_status: "not_configured" }),
        finalize_order_payment_mode_none: () => ok(row),
      });
      assert.deepEqual(await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" }), expected, JSON.stringify(row));
      t.mock.restoreAll();
    }
  }));

test("[172-FIN-6] T180-01 : le résultat de finalisation ne laisse fuiter ni code d'erreur, ni message, ni jeton (corps de réponse minimal)", async (t) =>
  enabled(async () => {
    route(t, {
      get_order_payment_context: ctx,
      get_payment_runtime_provider_environment: env({ is_enabled: false, configuration_status: "not_configured" }),
      finalize_order_payment_mode_none: () => ({ data: null, error: { code: "XX000", message: "secret tok-1 order-1 détail interne" } }),
    });
    const r = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    const text = JSON.stringify(r);
    assert.equal(text, '{"outcome":"payment_decision_unavailable"}');
    assert.ok(!/XX000|secret|tok-1|order-1/.test(text));
  }));
