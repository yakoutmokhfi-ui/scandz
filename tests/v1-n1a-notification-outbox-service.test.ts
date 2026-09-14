import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// N1-A — enveloppe TS des 4 RPC notification_outbox. Vérifie le
// mapping snake_case -> camelCase et la transmission fidèle des
// paramètres, même discipline que
// tests/v166-stuart-lot-d2-live-activation-gate.test.ts.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "n1a-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const {
  claimPendingNotifications,
  completeNotificationAttempt,
  reapStaleNotificationClaims,
  createOrderReceivedNotification,
  NotificationOutboxError,
} = await import("../lib/server/notifications/notification-outbox-service.ts");

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => handler(name, args));
}

test("claimPendingNotifications : mappe snake_case -> camelCase, transmet batchSize/leaseSeconds", async (t) => {
  let receivedArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    receivedArgs = args;
    return {
      data: [
        {
          outbox_id: "o1", restaurant_id: "r1", order_id: "ord1", notification_type: "order_received",
          recipient_email: "a@example.com", locale: "fr", payload_snapshot: { order_number: 1 },
          attempt_count: 0, claim_token: "tok1", sender_name: "S", sender_email: "s@example.com", reply_to: null,
        },
      ],
      error: null,
    };
  });

  const rows = await claimPendingNotifications({ batchSize: 5, leaseSeconds: 90 });
  assert.equal((receivedArgs as any).p_batch_size, 5);
  assert.equal((receivedArgs as any).p_lease_seconds, 90);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    outboxId: "o1", restaurantId: "r1", orderId: "ord1", notificationType: "order_received",
    recipientEmail: "a@example.com", locale: "fr", payloadSnapshot: { order_number: 1 },
    attemptCount: 0, claimToken: "tok1", senderName: "S", senderEmail: "s@example.com", replyTo: null,
  });
});

test("claimPendingNotifications : lève NotificationOutboxError sur erreur Postgrest", async (t) => {
  routeRpc(t, () => ({ data: null, error: { code: "42501", message: "denied" } }));
  await assert.rejects(() => claimPendingNotifications(), NotificationOutboxError);
});

test("completeNotificationAttempt : transmet fidèlement tous les paramètres", async (t) => {
  let receivedArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    receivedArgs = args;
    return { data: null, error: null };
  });

  await completeNotificationAttempt({
    outboxId: "o1", claimToken: "tok1", attemptNumber: 2, provider: "fake",
    result: "retryable_failure", errorClass: "PROVIDER_TIMEOUT",
  });

  assert.equal((receivedArgs as any).p_outbox_id, "o1");
  assert.equal((receivedArgs as any).p_claim_token, "tok1");
  assert.equal((receivedArgs as any).p_attempt_number, 2);
  assert.equal((receivedArgs as any).p_provider, "fake");
  assert.equal((receivedArgs as any).p_result, "retryable_failure");
  assert.equal((receivedArgs as any).p_error_class, "PROVIDER_TIMEOUT");
  assert.equal((receivedArgs as any).p_provider_message_id, null);
});

test("reapStaleNotificationClaims : renvoie le compte, 0 par défaut si data null", async (t) => {
  routeRpc(t, () => ({ data: null, error: null }));
  const count = await reapStaleNotificationClaims();
  assert.equal(count, 0);
});

test("createOrderReceivedNotification : renvoie null pour un rejeu idempotent (data null)", async (t) => {
  routeRpc(t, (name, args) => {
    assert.equal(name, "create_order_received_notification");
    assert.equal((args as any).p_order_id, "ord1");
    assert.equal((args as any).p_restaurant_id, "r1");
    return { data: null, error: null };
  });
  const result = await createOrderReceivedNotification({ orderId: "ord1", restaurantId: "r1" });
  assert.equal(result, null);
});
