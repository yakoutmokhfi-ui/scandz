import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// A196-05 -- budget temps du worker et du Cron.
//  - aucun NOUVEL envoi n'est démarré après la date limite ;
//  - les lignes réclamées mais non traitées ne sont PAS complétées (le bail expire,
//    `reap_stale_notification_claims` les remet en attente sans consommer de tentative) ;
//  - invariant : budget + durée max d'une session SMTP < bail <= maxDuration.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "r1-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const limits = await import("../lib/server/notifications/merchant-smtp-worker-limits.ts");
const { SMTP_SESSION_TOTAL_TIMEOUT_MS } = await import("../lib/server/ack-mailer.ts");

function claimRow(n: number) {
  return {
    outbox_id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
    restaurant_id: "bbbbbbbb-0000-4000-8000-000000000001",
    order_id: `cccccccc-0000-4000-8000-00000000000${n}`,
    notification_type: "order_received",
    recipient_email: `client${n}@example.com`,
    locale: "fr",
    payload_snapshot: { order_number: n, total: 19.9, currency: "EUR", service_mode: "pickup", public_token: `dddddddd-0000-4000-8000-00000000000${n}`, created_at: "2026-09-14T10:00:00Z" },
    attempt_count: 0,
    claim_token: `eeeeeeee-0000-4000-8000-00000000000${n}`,
    sender_name: "Resto",
    sender_email: "contact@resto.example",
    reply_to: null,
  };
}

function rpcWorld(t: { mock: { method: Function } }, rows: ReturnType<typeof claimRow>[]) {
  const completed: Array<Record<string, unknown>> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_pending_notifications") return { data: rows, error: null };
    if (name === "issue_order_email_tracking_capability") return { data: [{ capability_id: "ffffffff-0000-4000-8000-00000000000c", capability_secret: "c0".repeat(32) }], error: null };
    if (name === "complete_notification_attempt") { completed.push(args); return { data: null, error: null }; }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return completed;
}

test("date limite dépassée AVANT le premier envoi : rien n'est envoyé, rien n'est complété", async (t) => {
  const completed = rpcWorld(t, [claimRow(1), claimRow(2), claimRow(3)]);
  let sends = 0;
  const provider = { name: "merchant_smtp", async send() { sends += 1; return { ok: true as const, providerMessageId: "x" }; } };
  const result = await processPendingNotifications(provider, { deadlineAt: Date.now() - 1 });
  assert.equal(sends, 0);
  assert.equal(completed.length, 0, "lignes laissées `processing` : le bail expire puis reap les remet en attente");
  assert.equal(result.claimed, 3);
  assert.equal(result.sent, 0);
});

test("date limite atteinte PENDANT le lot : l'envoi en cours se termine, les suivants ne démarrent pas", async (t) => {
  const completed = rpcWorld(t, [claimRow(1), claimRow(2), claimRow(3)]);
  let sends = 0;
  const provider = {
    name: "merchant_smtp",
    async send() { sends += 1; await new Promise((resolve) => setTimeout(resolve, 80)); return { ok: true as const, providerMessageId: `m${sends}` }; },
  };
  const result = await processPendingNotifications(provider, { deadlineAt: Date.now() + 40 });
  assert.equal(sends, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.p_result, "success");
  assert.equal(result.claimed, 3);
  assert.equal(result.sent, 1);
});

test("sans date limite : comportement inchangé (tout le lot est traité)", async (t) => {
  const completed = rpcWorld(t, [claimRow(1), claimRow(2)]);
  const provider = { name: "merchant_smtp", async send() { return { ok: true as const, providerMessageId: "x" }; } };
  const result = await processPendingNotifications(provider, {});
  assert.equal(completed.length, 2);
  assert.equal(result.sent, 2);
});

test("fournisseur absent (coffre suspendu/illisible) : tentative consommée, classe PROVIDER_CONFIGURATION_ERROR, fournisseur 'merchant_smtp'", async (t) => {
  const completed = rpcWorld(t, [claimRow(1)]);
  const placeholder = { name: "smtp", async send() { return { ok: true as const, providerMessageId: "x" }; } };
  const result = await processPendingNotifications(placeholder, { providerForNotification: async () => null });
  assert.equal(result.retriedRetryable, 1);
  assert.equal(completed[0]!.p_provider, "merchant_smtp");
  assert.equal(completed[0]!.p_result, "retryable_failure");
  assert.equal(completed[0]!.p_error_class, "PROVIDER_CONFIGURATION_ERROR");
});

test("invariant de temps : budget + session SMTP max < bail <= maxDuration", () => {
  assert.equal(limits.workerTimingIsConsistent(), true);
  assert.ok(limits.WORKER_RUN_BUDGET_MS + SMTP_SESSION_TOTAL_TIMEOUT_MS < limits.WORKER_LEASE_SECONDS * 1000);
  assert.ok(limits.WORKER_LEASE_SECONDS <= limits.WORKER_MAX_DURATION_SECONDS);
  // Le lot réclamé tient dans le budget en régime nominal (≥ 6 s par message en moyenne).
  assert.ok(limits.WORKER_RUN_BUDGET_MS / limits.WORKER_BATCH_SIZE >= 6_000);
});

test("le littéral `maxDuration` de la route Cron égale WORKER_MAX_DURATION_SECONDS", () => {
  const source = readFileSync(new URL("../app/api/internal/notifications/send/route.ts", import.meta.url), "utf8");
  const match = /export const maxDuration = (\d+);/.exec(source);
  assert.ok(match, "export const maxDuration absent");
  assert.equal(Number(match![1]), limits.WORKER_MAX_DURATION_SECONDS);
});

test("la route Cron utilise EXACTEMENT les bornes du module de limites (lot, bail, budget)", () => {
  const source = readFileSync(new URL("../app/api/internal/notifications/send/route.ts", import.meta.url), "utf8");
  assert.match(source, /batchSize: WORKER_BATCH_SIZE/);
  assert.match(source, /leaseSeconds: WORKER_LEASE_SECONDS/);
  assert.match(source, /deadlineAt: startedAt \+ WORKER_RUN_BUDGET_MS/);
});
