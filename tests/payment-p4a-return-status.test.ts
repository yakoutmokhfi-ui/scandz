import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p4a-synthetic-service-role-key-DO-NOT-USE";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

// ====================================================================
// PAYMENT P4-A -- pages de retour navigateur : le nouvel état
// `orders.payment_status = 'required'` (paiement exigé, aucune tentative
// encore initiée) doit être présenté comme « en cours », JAMAIS comme un
// échec ni comme un paiement. Les autres états restent inchangés.
// Le statut est lu via get_order_payment_status_snapshot (serveur),
// jamais depuis l'URL.
// ====================================================================

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { createReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");
const { resolvePaymentReturnStatus } = await import("../app/checkout/return/shared.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

function withSnapshot(t: { mock: { method: Function } }, paymentStatus: string) {
  t.mock.method(client, "rpc", async (name: string) => {
    if (name === "get_order_payment_status_snapshot") {
      return { data: [{ payment_status: paymentStatus, provider_code: "monetico", has_observed_refusal: false, last_refusal_at: null }], error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
}

const relay = () => createReturnRelayToken({ orderId: ORDER_ID, publicToken: TOKEN, ttlSeconds: 600 });

test("[P4A-RET-1] payment_status='required' -> kind 'pending' (jamais 'failed_or_cancelled'), lien de suivi exact", async (t) => {
  withSnapshot(t, "required");
  const r = await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() });
  assert.deepEqual(r, { kind: "pending", trackingPath: `/track/${ORDER_ID}#${TOKEN}` });
});

test("[P4A-RET-2] états P1 INCHANGÉS : paid/pending/not_required/failed/cancelled", async (t) => {
  const expected: Record<string, string> = { paid: "paid", pending: "pending", not_required: "not_required", failed: "failed_or_cancelled", cancelled: "failed_or_cancelled" };
  for (const [status, kind] of Object.entries(expected)) {
    withSnapshot(t, status);
    const r = await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() });
    assert.equal(r.kind, kind, status);
    t.mock.restoreAll();
  }
});

test("[P4A-RET-3] jeton de relais invalide -> 'unavailable', AUCUNE lecture serveur (posture anti-fuite inchangée)", async (t) => {
  let calls = 0;
  t.mock.method(client, "rpc", async () => { calls++; return { data: [], error: null }; });
  const r = await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: "garbage" });
  assert.deepEqual(r, { kind: "unavailable" });
  assert.equal(calls, 0);
});
