import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// STUART LOT D2 — INTÉGRATION avec l'orchestration D1 (INCHANGÉE) +
// non-régression. Test matrix items 18 (réplique au niveau
// orchestration), 19 (crash/recovery -- référence structurelle), 20
// (immutabilité provider-reference -- référence structurelle), 21
// (corrélation webhook -- référence structurelle), 22 (non-régression
// LOT C -- référence), 23 (non-régression retry/backoff D1 --
// référence).
//
// PREUVE CENTRALE DE CE FICHIER : brancher
// `createStuartMerchantOrchestrationTransport` (RÉEL, porte OFF) à la
// place de `NON_LIVE_STUART_ORCHESTRATION_TRANSPORT`
// (`post-payment-hook-wiring.ts`, D1 v1.1, INCHANGÉ, PAS modifié par
// ce test) DANS `handleOrderPaymentConfirmedForStuartDelivery`
// (`orchestration.ts`, D1, INCHANGÉ) ne change RIEN au comportement
// observable pendant ce mandat (porte OFF) : même transition
// `send_ambiguous`, même verrouillage `blocked_by_prior_ambiguity` au
// rejeu, ZÉRO second appel `transport.createJob`. C'est la preuve que
// ce lot "plugs into the existing orchestration boundary" (mandat)
// sans la redessiner.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-d2-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();

const { handleOrderPaymentConfirmedForStuartDelivery } = await import(
  "../lib/server/delivery-providers/stuart/orchestration.ts"
);
const { createStuartMerchantOrchestrationTransport } = await import(
  "../lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts"
);

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return calls;
}
function eligibleRow(merchantEnvironment: "sandbox" | "production" = "sandbox") {
  return { data: [{ eligible: true, reason_code: "ELIGIBLE", merchant_environment: merchantEnvironment }], error: null };
}
function configStatusRow(mode: string) {
  return { data: [{ config_id: "cfg-1", provider_code: "stuart", mode, configuration_status: "configured" }], error: null };
}
function credentialRow() {
  return { data: JSON.stringify({ clientId: "cid", clientSecret: "csecret" }), error: null };
}
function buildOrder() {
  return {
    orderId: "order-d2-1",
    restaurantId: "resto-d2-1",
    pickup: { address: "1 rue A", contact: { phone: "0600000000", company: "R1" } },
    dropoff: { address: "2 rue B", contact: { phone: "0600000001", company: "C1" }, packageType: "small" as const },
  };
}

// --------------------------------------------------------------
// Preuve d'intégration : porte OFF -- transport RÉEL branché dans
// l'orchestration D1 INCHANGÉE produit EXACTEMENT le même verrouillage
// send_ambiguous / blocked_by_prior_ambiguity qu'avec le transport
// non-live de D1 v1.1, et JAMAIS un second appel createJob au rejeu.
// --------------------------------------------------------------

test("intégration : porte OFF -- 1er appel -> send_ambiguous (échec de transport non anticipé, catch générique orchestration.ts INCHANGÉ) ; 2e appel (rejeu) -> blocked_by_prior_ambiguity, ZÉRO second appel createJob", async (t) => {
  const jobState: { sendState: string; stuartJobId: string | null } = { sendState: "allocated", stuartJobId: null };
  let allocateCallCount = 0;

  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow("sandbox");
    if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
    if (name === "get_delivery_provider_credential") return credentialRow();
    if (name === "allocate_stuart_delivery_job") {
      allocateCallCount += 1;
      return {
        data: [
          {
            id: "job-row-d2-1",
            client_reference: "CANDD2A",
            is_new_allocation: allocateCallCount === 1,
            collision: false,
            send_state: jobState.sendState,
            stuart_job_id: jobState.stuartJobId,
          },
        ],
        error: null,
      };
    }
    if (name === "mark_stuart_delivery_job_send_started") {
      jobState.sendState = "send_started";
      return { data: null, error: null };
    }
    if (name === "mark_stuart_delivery_job_ambiguous") {
      jobState.sendState = "send_ambiguous";
      return { data: null, error: null };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });

  let createJobCalls = 0;
  const baseTransport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-d2-1", orderId: "order-d2-1" }, async () => {
    throw new Error("FETCH NE DOIT JAMAIS ÊTRE APPELÉ -- porte OFF");
  });
  const spyTransport = {
    async createJob(payload: Parameters<typeof baseTransport.createJob>[0]) {
      createJobCalls += 1;
      return baseTransport.createJob(payload);
    },
  };

  const first = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport: spyTransport });
  assert.deepEqual(first, { status: "send_ambiguous", jobRowId: "job-row-d2-1" });
  assert.equal(createJobCalls, 1);
  assert.equal(jobState.sendState, "send_ambiguous");

  const second = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport: spyTransport });
  assert.deepEqual(second, { status: "blocked_by_prior_ambiguity", jobRowId: "job-row-d2-1" });
  // item 18 (réplique/idempotence) : le rejeu ne déclenche JAMAIS un
  // second appel createJob -- vérifié ICI au niveau orchestration
  // (D1, INCHANGÉ), avec le transport RÉEL de ce lot substitué.
  assert.equal(createJobCalls, 1, "un rejeu ne doit JAMAIS ré-invoquer transport.createJob");
});

// --------------------------------------------------------------
// items 19/21/22/23 (référence structurelle) : les modules D1
// consommés par ce lot (recovery/crash, corrélation webhook, LOT C)
// exposent TOUJOURS les mêmes signatures -- preuve QUE ce lot ne les a
// PAS modifiés (aucun fichier D1 de ces domaines n'apparaît dans le
// diff de ce lot, voir full.patch) ; la non-régression COMPORTEMENTALE
// elle-même reste couverte par la suite complète INCHANGÉE
// (tests/v1XX déjà existants, ré-exécutés sans modification).
// --------------------------------------------------------------

test("item 19 (référence) : recovery.ts (crash/reprise D1) reste importable avec les MÊMES exports -- ce lot ne l'a pas touché", async () => {
  const recovery = await import("../lib/server/delivery-providers/stuart/recovery.ts");
  assert.equal(typeof recovery.reapStaleStuartDeliveryJobSendStarted, "function");
  assert.equal(typeof recovery.applyStuartDeliveryJobStatusIfNewer, "function");
  assert.equal(typeof recovery.recordStuartDeliveryJobLocalCancellation, "function");
});

test("item 21 (référence) : webhook-processor.ts (corrélation D1) reste importable avec les MÊMES exports -- ce lot ne l'a pas touché", async () => {
  const processor = await import("../lib/server/delivery-providers/stuart/webhook-processor.ts");
  assert.equal(typeof processor.processClaimedStuartProviderEvents, "function");
});

test("item 22 (référence) : ce lot n'importe, ne référence ni ne recalcule AUCUN champ financier LOT C (provider_cost/customer_delivery_fee/merchant_delivery_subsidy/delivery VAT)", async () => {
  const src = (await import("node:fs")).readFileSync(
    "lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts",
    "utf8"
  );
  for (const forbidden of ["provider_cost", "customer_delivery_fee", "merchant_delivery_subsidy", "delivery_vat"]) {
    assert.doesNotMatch(src, new RegExp(forbidden, "i"));
  }
});

test("item 23 (référence) : allocation.ts (allocation/retry D1) reste importable avec les MÊMES exports -- ce lot ne l'a pas touché", async () => {
  const allocation = await import("../lib/server/delivery-providers/stuart/allocation.ts");
  assert.equal(typeof allocation.allocateStuartDeliveryJob, "function");
  assert.equal(typeof allocation.markStuartDeliveryJobSendStarted, "function");
  assert.equal(typeof allocation.markStuartDeliveryJobAmbiguous, "function");
  assert.equal(typeof allocation.confirmStuartDeliveryJobCreated, "function");
  assert.equal(typeof allocation.markStuartDeliveryJobTerminalFailure, "function");
});
