import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const SQL_PATH = "supabase/migration-20260919000000-order-success-boundary-v1.sql";
const sql = readFileSync(SQL_PATH, "utf8");

test("order success boundary: migration has an explicit forward identity and no historical backfill", () => {
  assert.match(sql, /Migration identity: 20260919000000_order_success_boundary_v1/);
  assert.match(sql, /Existing orders are deliberately left NULL/);
  assert.doesNotMatch(sql, /update\s+public\.orders\s+set\s+order_received_notification_intent_at/i);
});

test("order success boundary: durable intent is stamped into the order row before insert", () => {
  assert.match(sql, /add column order_received_notification_intent_at timestamptz/);
  assert.match(sql, /new\.order_received_notification_intent_at := transaction_timestamp\(\)/);
  assert.match(sql, /create trigger orders_record_order_received_intent_trg[\s\S]*?before insert on public\.orders/i);
});

test("order success boundary: synchronous enqueue is removed from the business transaction", () => {
  assert.match(sql, /drop trigger orders_enqueue_order_received_trg on public\.orders/);
  assert.match(sql, /drop function public\.tg_orders_enqueue_order_received\(\)/);
  const beforeRecovery = sql.slice(0, sql.indexOf("create function public.recover_missing_order_received_notifications("));
  assert.doesNotMatch(beforeRecovery, /perform public\.create_order_received_notification/);
  assert.match(sql, /synchronous notification enqueue path still exists/);
});

test("order success boundary: migration refuses a direct enqueue remaining inside create_order", () => {
  assert.match(
    sql,
    /if v_create_order_definition like '%create_order_received_notification%' then[\s\S]*?raise exception 'SCANYM_SCHEMA_DRIFT: create_order still directly invokes notification enqueue\.'/,
  );
});

test("notification recovery: selection is tenant-scoped and only covers durable missing intents", () => {
  const start = sql.indexOf("create function public.recover_missing_order_received_notifications(");
  const end = sql.indexOf("comment on function public.recover_missing_order_received_notifications", start);
  assert.ok(start >= 0 && end > start);
  const body = sql.slice(start, end);
  assert.match(body, /o\.restaurant_id = p_restaurant_id/);
  assert.match(body, /o\.order_received_notification_intent_at is not null/);
  assert.match(body, /not exists \([\s\S]*?n\.restaurant_id = o\.restaurant_id[\s\S]*?n\.order_id = o\.id[\s\S]*?n\.notification_type = 'order_received'/);
});

test("notification recovery: concurrency and duplicate defenses are explicit", () => {
  assert.match(sql, /for update of o skip locked/i);
  assert.match(sql, /notification outbox logical uniqueness is missing/);
  assert.match(sql, /create_order_received_notification\(v_order\.id, p_restaurant_id\)/);
});

test("notification recovery: raw diagnostics are not returned or persisted", () => {
  assert.doesNotMatch(sql, /return(?:\s+next)?\s+SQLERRM|:=\s*SQLERRM|insert[\s\S]{0,200}SQLERRM/i);
  assert.doesNotMatch(sql, /GET STACKED DIAGNOSTICS/i);
  assert.match(sql, /recovery_outcome := 'retry_required'/);
});

test("notification recovery: recovery and observability RPCs are service-role-only", () => {
  for (const signature of [
    "recover_missing_order_received_notifications(uuid, integer)",
    "count_missing_order_received_notifications(uuid)",
  ]) {
    const escaped = signature.replace(/[()]/g, "\\$&").replace(", ", ",\\s*");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}[\\s\\S]*?from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}[\\s\\S]*?to service_role`, "i"));
  }
});

test("order success boundary: migration contains no external provider or network operation", () => {
  assert.doesNotMatch(sql, /http_post|net\.http|fetch\s*\(|smtp|api\.stuart|monetico|cic\.fr/i);
});

test("WhatsApp side effect starts only after create_order has returned authoritative order state", () => {
  const menu = readFileSync("components/MenuView.tsx", "utf8");
  const completeFlowDefinition = menu.indexOf("function completeOrderFlow(");
  const markerInsideCompleteFlow = menu.indexOf("void markWhatsappOpened(order.orderId, order.publicToken)", completeFlowDefinition);
  const createIndex = menu.indexOf("await createOrder(");
  const completeFlowCall = menu.indexOf("completeOrderFlow(", createIndex);
  assert.ok(createIndex >= 0, "createOrder call missing");
  assert.ok(markerInsideCompleteFlow > completeFlowDefinition, "fire-and-forget WhatsApp marker missing from completion flow");
  assert.ok(completeFlowCall > createIndex, "completion/WhatsApp flow must run only after create_order resolves");
});

test("delivery-provider orchestration remains best-effort and cannot replace payment/order finalization", () => {
  const processor = readFileSync("lib/server/payment-provider-event-processor.ts", "utf8");
  const hookIndex = processor.indexOf("await triggerStuartPostPaymentOrchestration({");
  const catchIndex = processor.indexOf("} catch {", hookIndex);
  const finalizeIndex = processor.indexOf('return finalize(claimed, "applied")', catchIndex);
  assert.ok(hookIndex >= 0 && catchIndex > hookIndex, "delivery hook must be exception-isolated");
  assert.ok(finalizeIndex > catchIndex, "authoritative finalization must still execute after delivery failure");
});
