import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-v2-e2e-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const {
  allocateStuartDeliveryJob,
  markStuartDeliveryJobSendStarted,
  markStuartDeliveryJobAmbiguous,
  markStuartDeliveryJobTerminalFailure,
  confirmStuartDeliveryJobCreated,
  StuartAllocationError,
  StuartTenantIsolationError,
} = await import("../lib/server/delivery-providers/stuart/allocation.ts");

// ====================================================================
// DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.1. RPC entièrement
// mockée -- AUCUN appel réseau/DB réel (preuve contre PostgreSQL réel
// séparée, harnais SQL 40/40 PASS).
// ====================================================================

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return calls;
}

test("STUART-CLIENT-REFERENCE-01 : appel RPC avec candidateReference explicite, retour complet (send_state/stuart_job_id inclus)", async (t) => {
  const calls = routeRpc(t, () => ({
    data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: true, collision: false, send_state: "allocated", stuart_job_id: null }],
    error: null,
  }));
  const result = await allocateStuartDeliveryJob({ orderId: "order-1", restaurantId: "resto-1", environment: "sandbox", candidateReference: "ABCDEF1234" });
  assert.equal(result.id, "row-1");
  assert.equal(result.isNewAllocation, true);
  assert.equal(result.collision, false);
  assert.equal(result.sendState, "allocated");
  assert.equal(result.stuartJobId, null);
  assert.equal(calls[0].name, "allocate_stuart_delivery_job");
  assert.equal(calls[0].args.p_candidate_reference, "ABCDEF1234");
});

test("STUART-CLIENT-REFERENCE-01 : collision=true -- id/clientReference vides, JAMAIS un résultat exploitable comme allocation réussie", async (t) => {
  routeRpc(t, () => ({ data: [{ id: null, client_reference: null, is_new_allocation: false, collision: true, send_state: null, stuart_job_id: null }], error: null }));
  const result = await allocateStuartDeliveryJob({ orderId: "order-1", restaurantId: "resto-1", environment: "sandbox", candidateReference: "ABCDEF1234" });
  assert.equal(result.collision, true);
  assert.equal(result.id, "");
});

test("STUART-CLIENT-REFERENCE-01 : violation d'isolation tenant (code 42501) -- StuartTenantIsolationError distincte", async (t) => {
  routeRpc(t, () => ({ data: null, error: { code: "42501", message: "isolation tenant" } }));
  await assert.rejects(
    () => allocateStuartDeliveryJob({ orderId: "order-1", restaurantId: "resto-wrong", environment: "sandbox", candidateReference: "ABCDEF1234" }),
    StuartTenantIsolationError
  );
});

test("STUART-CLIENT-REFERENCE-01 : autre échec RPC -- StuartAllocationError générique, PAS StuartTenantIsolationError", async (t) => {
  routeRpc(t, () => ({ data: null, error: { code: "40001", message: "erreur" } }));
  await assert.rejects(
    () => allocateStuartDeliveryJob({ orderId: "order-1", restaurantId: "resto-1", environment: "sandbox", candidateReference: "ABCDEF1234" }),
    (err: unknown) => err instanceof StuartAllocationError && !(err instanceof StuartTenantIsolationError)
  );
});

test("STUART-CLIENT-REFERENCE-01 : ensemble vide -- StuartAllocationError, jamais un résultat silencieusement accepté", async (t) => {
  routeRpc(t, () => ({ data: [], error: null }));
  await assert.rejects(() => allocateStuartDeliveryJob({ orderId: "order-1", restaurantId: "resto-1", environment: "sandbox", candidateReference: "ABCDEF1234" }), StuartAllocationError);
});

test("STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01 : markStuartDeliveryJobSendStarted -- appel RPC lié à la possession (id/order_id/restaurant_id)", async (t) => {
  const calls = routeRpc(t, () => ({ data: null, error: null }));
  await markStuartDeliveryJobSendStarted({ id: "row-1", orderId: "order-1", restaurantId: "resto-1" });
  assert.equal(calls[0].name, "mark_stuart_delivery_job_send_started");
  assert.equal(calls[0].args.p_id, "row-1");
  assert.equal(calls[0].args.p_order_id, "order-1");
  assert.equal(calls[0].args.p_restaurant_id, "resto-1");
});

test("STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01 : markStuartDeliveryJobAmbiguous -- échec RPC propagé", async (t) => {
  routeRpc(t, () => ({ data: null, error: { code: "P0002", message: "transition invalide" } }));
  await assert.rejects(() => markStuartDeliveryJobAmbiguous({ id: "row-1", orderId: "order-1", restaurantId: "resto-1" }), StuartAllocationError);
});

test("STUART-V2-CORRELATION-INTEGRITY-01 : confirmStuartDeliveryJobCreated -- transmet stuart_job_id", async (t) => {
  const calls = routeRpc(t, () => ({ data: null, error: null }));
  await confirmStuartDeliveryJobCreated({ id: "row-1", orderId: "order-1", restaurantId: "resto-1", stuartJobId: "JOB123" });
  assert.equal(calls[0].args.p_stuart_job_id, "JOB123");
});

test("STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01 : markStuartDeliveryJobTerminalFailure -- appel RPC correct", async (t) => {
  const calls = routeRpc(t, () => ({ data: null, error: null }));
  await markStuartDeliveryJobTerminalFailure({ id: "row-1", orderId: "order-1", restaurantId: "resto-1" });
  assert.equal(calls[0].name, "mark_stuart_delivery_job_terminal_failure");
});
