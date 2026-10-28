import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ISSUE #171 — pure policy + client query shape + structural scope.
 */

const pol = await import("../lib/order-payment-operability.ts");

test("ISSUE #171 policy: exactly not_required and paid are operational; required/pending/failed/cancelled are not; unknown/missing is NOT (fail-closed)", () => {
  assert.deepEqual([...pol.OPERATIONAL_PAYMENT_STATUSES], ["not_required", "paid"]);
  for (const s of pol.ORDER_PAYMENT_STATUSES) {
    assert.equal(pol.isOrderPaymentOperational(s), s === "not_required" || s === "paid", s);
  }
  for (const bad of [undefined, null, "", "PAID", "Paid", "unknown", 1]) assert.equal(pol.isOrderPaymentOperational(bad), false, String(bad));
  assert.equal(pol.orderPaymentBadge("paid"), null);
  assert.equal(pol.orderPaymentBadge("not_required"), null);
  assert.equal(pol.orderPaymentBadge("required"), "awaiting_payment");
  assert.equal(pol.orderPaymentBadge("pending"), "awaiting_payment");
  assert.equal(pol.orderPaymentBadge("failed"), "payment_failed");
  assert.equal(pol.orderPaymentBadge("cancelled"), "payment_failed");
  assert.equal(pol.orderPaymentBadge(undefined), "awaiting_payment");
  // Every P1/P4-A state is classified exactly once.
  const all = new Set([...pol.OPERATIONAL_PAYMENT_STATUSES, ...pol.AWAITING_PAYMENT_STATUSES, ...pol.AUDIT_ONLY_PAYMENT_STATUSES]);
  assert.deepEqual([...all].sort(), [...pol.ORDER_PAYMENT_STATUSES].sort());
});

test("ISSUE #171 client query: the merchant OPERATIONAL list sends payment_status=in.(not_required,paid) alongside the status filter; the HISTORY list does not filter on payment_status", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
  const { supabase } = await import("../lib/supabase.ts");
  const { getDashboardOrders } = await import("../lib/services/dashboard.ts");
  const seen: URL[] = [];
  const original = (supabase as any).rest?.fetch ?? globalThis.fetch;
  const fetchMock = async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const prev = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await getDashboardOrders("tenant-a", false);
    await getDashboardOrders("tenant-a", true);
  } finally {
    globalThis.fetch = prev;
    void original;
  }
  assert.equal(seen.length, 2);
  const [operational, history] = seen;
  assert.equal(operational.searchParams.get("status"), "not.in.(completed,rejected,cancelled)");
  assert.equal(operational.searchParams.get("payment_status"), "in.(not_required,paid)");
  assert.match(operational.searchParams.get("select") ?? "", /\bpayment_status\b/);
  assert.equal(history.searchParams.get("status"), null);
  assert.equal(history.searchParams.get("payment_status"), null, "history keeps every payment state for audit");
});

test("ISSUE #171 scope: the lot touches neither the payment state machine nor create_order; the SQL draft redefines exactly the two read/write RPCs and keeps the operator projection", () => {
  const draft = readFileSync("supabase/DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql", "utf8");
  const created = [...draft.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, ["get_operator_restaurant_orders_page", "update_order_status"]);
  for (const forbidden of ["create_order", "initiate_payment_attempt", "confirm_payment_attempt", "record_payment_provider_event", "payment_transactions", "alter table"]) {
    assert.ok(!new RegExp(`(create or replace function public\\.${forbidden}\\(|^\\s*${forbidden}\\b)`, "mi").test(draft), forbidden);
  }
  // Deny list, never "paid only".
  assert.match(draft, /v_payment_status not in \('not_required', 'paid'\)/);
  assert.match(draft, /o\.payment_status in \('not_required', 'paid'\)/);
  // Projection unchanged: returns table has exactly the ten approved fields.
  const ret = draft.match(/get_operator_restaurant_orders_page\([\s\S]*?returns table \(([\s\S]*?)\)\s*language/)![1];
  assert.deepEqual(ret.split(",").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean), ["id", "order_number", "status", "service_mode", "created_at", "updated_at", "total", "currency", "item_count", "has_invoice_request"]);
  // No TS file of the payment pipeline changed.
  // The rollback's restored FUNCTION BODIES never mention payment_status
  // (its post-check legitimately searches for that word).
  const rb = readFileSync("supabase/DRAFT-lot-issue-171-unpaid-orders-not-operational-v1-rollback.sql", "utf8");
  const rbBodies = [...rb.matchAll(/create or replace function public\.[a-z_]+\([\s\S]*?\n(?:end )?\$\$;/g)].map((m) => m[0]);
  assert.equal(rbBodies.length, 2);
  for (const body of rbBodies) assert.doesNotMatch(body, /payment_status/);
  // AUD179-04: both scripts are explicit transactions ending with COMMIT.
  for (const f of [draft, rb]) {
    assert.match(f, /^begin;$/m);
    assert.match(f.trimEnd(), /\ncommit;$/);
  }
});
