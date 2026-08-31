import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// lib/server/tracking-service.ts.
//
// Couvre le SEUL wrapper serveur autour de la RPC déjà publiée/auditée
// get_order_tracking (CUSTOMER ORDER TRACKING FOUNDATION v3, contrat
// inchangé) : validation de forme AVANT tout appel réseau, mapping
// snake_case -> camelCase, taxonomie d'erreurs à deux catégories
// (mandat §25/§45).
//
// Patron déjà établi par ce dépôt (tests/v110b-payment-p3a1-
// service.test.ts, tests/v112-payment-p3b0-service.test.ts) :
// `t.mock.method(client, "rpc", ...)` sur le CLIENT RÉEL construit par
// lib/supabase.ts (client anon PARTAGÉ -- tracking-service.ts appelle
// DÉLIBÉRÉMENT ce client, jamais service_role -- voir son commentaire
// de tête).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { getOrderTracking } = await import("../lib/server/tracking-service.ts");
const { TrackingLinkInvalidError, TrackingServerUnavailableError } = await import(
  "../lib/server/tracking-errors.ts"
);

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

const VALID_ROW = {
  order_status: "ready",
  service_mode: "pickup",
  order_number: 104,
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: "2026-01-01T10:05:00Z",
  preparing_at: "2026-01-01T10:10:00Z",
  ready_at: "2026-01-01T10:20:00Z",
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
};

test("getOrderTracking: appelle EXACTEMENT get_order_tracking avec p_order_id/p_public_token, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: [VALID_ROW], error: null };
  });

  await getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_order_tracking");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_order_id",
    "p_public_token",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, ORDER_ID);
  assert.equal(args.p_public_token, TOKEN);
});

test("getOrderTracking: ligne valide -- mapping camelCase complet et fidèle", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));

  const result = await getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN });
  assert.deepEqual(result, {
    orderStatus: "ready",
    serviceMode: "pickup",
    orderNumber: 104,
    createdAt: "2026-01-01T10:00:00Z",
    acceptedAt: "2026-01-01T10:05:00Z",
    preparingAt: "2026-01-01T10:10:00Z",
    readyAt: "2026-01-01T10:20:00Z",
    completedAt: null,
    rejectedAt: null,
    cancelledAt: null,
  });
});

test("getOrderTracking: order_number en chaîne (bigint Postgrest) -- converti en number", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ ...VALID_ROW, order_number: "104" }],
    error: null,
  }));
  const result = await getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN });
  assert.equal(result.orderNumber, 104);
  assert.equal(typeof result.orderNumber, "number");
});

test("getOrderTracking: order_id malformé -- TrackingLinkInvalidError SANS aucun appel RPC (mandat §25/§34)", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [VALID_ROW], error: null };
  });
  await assert.rejects(
    () => getOrderTracking({ orderId: "not-a-uuid", publicToken: TOKEN }),
    TrackingLinkInvalidError
  );
  assert.equal(called, false);
});

test("getOrderTracking: public_token malformé -- TrackingLinkInvalidError SANS aucun appel RPC", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [VALID_ROW], error: null };
  });
  await assert.rejects(
    () => getOrderTracking({ orderId: ORDER_ID, publicToken: "" }),
    TrackingLinkInvalidError
  );
  assert.equal(called, false);
});

test("getOrderTracking: ensemble vide (mauvais jeton/mauvaise commande) -- TrackingLinkInvalidError, MÊME erreur qu'une entrée malformée", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () => getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingLinkInvalidError
  );
});

test("getOrderTracking: data null sans erreur -- traité comme ensemble vide, TrackingLinkInvalidError", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () => getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingLinkInvalidError
  );
});

test("getOrderTracking: erreur Postgrest -- TrackingServerUnavailableError, catégorie DIFFÉRENTE d'un lien invalide", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "PGRST000", message: "boom", details: null, hint: null },
  }));
  await assert.rejects(
    () => getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingServerUnavailableError
  );
});

test("getOrderTracking: rpc() qui lève (panne réseau) -- TrackingServerUnavailableError", async (t) => {
  t.mock.method(supabase, "rpc", async () => {
    throw new Error("network unreachable");
  });
  await assert.rejects(
    () => getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingServerUnavailableError
  );
});

test("getOrderTracking: order_status hors ensemble canonique -- échec FERMÉ (TrackingServerUnavailableError), jamais affiché tel quel", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ ...VALID_ROW, order_status: "served" }],
    error: null,
  }));
  await assert.rejects(
    () => getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingServerUnavailableError
  );
});

test("getOrderTracking: erreur Postgrest -- console.error n'expose JAMAIS order_id/public_token", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "PGRST100", message: `leaked ${TOKEN}`, details: TOKEN, hint: null },
  }));
  const logs: string[] = [];
  t.mock.method(console, "error", (msg: string) => {
    logs.push(msg);
  });
  await assert.rejects(() => getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN }));
  for (const line of logs) {
    assert.equal(line.includes(TOKEN), false, "le jeton ne doit jamais apparaître dans les logs");
    assert.equal(line.includes(ORDER_ID), false, "order_id ne doit jamais apparaître dans les logs");
  }
});

test("getOrderTracking: data renvoyée comme objet unique (pas un tableau) -- géré comme une seule ligne", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: VALID_ROW, error: null }));
  const result = await getOrderTracking({ orderId: ORDER_ID, publicToken: TOKEN });
  assert.equal(result.orderStatus, "ready");
});
