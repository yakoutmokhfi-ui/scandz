import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-d1-e2e-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();

const { getStuartDeliveryEligibility, StuartEligibilityError } = await import(
  "../lib/server/delivery-providers/stuart/eligibility.ts"
);
const {
  handleOrderPaymentConfirmedForStuartDelivery,
} = await import("../lib/server/delivery-providers/stuart/orchestration.ts");
const {
  recordStuartProviderEvent,
  claimStuartProviderEvents,
  updateStuartProviderEventProcessingStatus,
  StuartProviderEventError,
} = await import("../lib/server/delivery-providers/stuart/provider-events.ts");
const {
  reapStaleStuartDeliveryJobSendStarted,
  applyStuartDeliveryJobStatusIfNewer,
  recordStuartDeliveryJobLocalCancellation,
} = await import("../lib/server/delivery-providers/stuart/recovery.ts");
const { ingestStuartWebhookEvent } = await import("../lib/server/delivery-providers/stuart/webhook-ingestion.ts");
const { processClaimedStuartProviderEvents } = await import(
  "../lib/server/delivery-providers/stuart/webhook-processor.ts"
);
const { NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER } = await import(
  "../lib/server/delivery-providers/stuart/webhook-auth-adapter.ts"
);

// ====================================================================
// STUART LOT D1 — POST-PAYMENT ORCHESTRATION + CRASH RECOVERY +
// WEBHOOK INBOX FOUNDATION. Toutes les RPC sont MOCKÉES -- AUCUN appel
// réseau/DB réel (item 21). Les garanties de concurrence/RLS réelles
// (items 16/17/20) ont été vérifiées séparément contre une base
// PostgreSQL locale éphémère et jetable (voir le rapport de livraison
// pour le détail exact des commandes exécutées) -- ce fichier couvre le
// plumbing TypeScript et les invariants d'orchestration.
// ====================================================================

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return calls;
}

function eligibleRow(merchantEnvironment: "sandbox" | "production" = "sandbox") {
  // STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 2 HIGH) --
  // get_stuart_delivery_eligibility renvoie désormais AUSSI
  // merchant_environment sur la branche eligible=true (dérivé de
  // delivery_provider_configs.mode, jamais un fallback global) --
  // "sandbox" par défaut ici pour préserver le comportement déjà
  // prouvé par ce fichier (D1 v1/v1.1), un paramètre explicite permet
  // aux tests dédiés à l'autorité d'environnement de couvrir
  // "production" sans dupliquer ce helper.
  return { data: [{ eligible: true, reason_code: "ELIGIBLE", merchant_environment: merchantEnvironment }], error: null };
}
function ineligibleRow(reasonCode: string) {
  return { data: [{ eligible: false, reason_code: reasonCode }], error: null };
}

const mockTransportNeverCalled = {
  createJob: async () => {
    throw new Error("TRANSPORT MUST NEVER BE CALLED IN THIS TEST");
  },
};

function buildOrder() {
  return {
    orderId: "order-1",
    restaurantId: "resto-1",
    pickup: { address: "1 rue A", contact: { phone: "0600000000", company: "R1" } },
    dropoff: { address: "2 rue B", contact: { phone: "0600000001", company: "C1" }, packageType: "small" as const },
  };
}

// --------------------------------------------------------------
// ITEM 1 : payment not confirmed -> zero allocation/zero transport call
// --------------------------------------------------------------
test("item 1 : commande non payée -- eligibility renvoie PAYMENT_NOT_CONFIRMED, AUCUN appel allocate/transport", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return ineligibleRow("PAYMENT_NOT_CONFIRMED");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const order = buildOrder();
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...order, transport: mockTransportNeverCalled });
  assert.deepEqual(outcome, { status: "ineligible", reasonCode: "PAYMENT_NOT_CONFIRMED" });
  assert.equal(calls.filter((c) => c.name === "allocate_stuart_delivery_job").length, 0);
});

// --------------------------------------------------------------
// ITEM 2 : payment confirmed + ineligible fulfillment -> zero call
// --------------------------------------------------------------
test("item 2 : mode de service non delivery -- AUCUN appel allocate/transport", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return ineligibleRow("FULFILLMENT_MODE_NOT_DELIVERY");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const order = buildOrder();
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...order, transport: mockTransportNeverCalled });
  assert.deepEqual(outcome, { status: "ineligible", reasonCode: "FULFILLMENT_MODE_NOT_DELIVERY" });
});

// --------------------------------------------------------------
// ITEM 3 : merchant Stuart non configuré/vérifié -> zero call
// --------------------------------------------------------------
test("item 3 : credential Stuart marchand non configuré -- AUCUN appel allocate/transport", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return ineligibleRow("STUART_CREDENTIAL_NOT_CONFIGURED");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const order = buildOrder();
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...order, transport: mockTransportNeverCalled });
  assert.deepEqual(outcome, { status: "ineligible", reasonCode: "STUART_CREDENTIAL_NOT_CONFIGURED" });
});

// --------------------------------------------------------------
// ITEM 4/9 : commande payée éligible -> UNE allocation logique,
// fixture succès -> created_confirmed
// --------------------------------------------------------------
test("item 4/9 : commande éligible, fixture succès (id numérique Stuart) -- created_confirmed, UNE seule allocation", async (t) => {
  let transportCalls = 0;
  routeRpc(t, (name, args) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow();
    if (name === "allocate_stuart_delivery_job")
      return { data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: true, collision: false, send_state: "allocated", stuart_job_id: null }], error: null };
    if (name === "mark_stuart_delivery_job_send_started") return { data: null, error: null };
    if (name === "confirm_stuart_delivery_job_created") {
      assert.equal(args.p_stuart_job_id, "100202968");
      return { data: null, error: null };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = {
    createJob: async () => {
      transportCalls += 1;
      return { raw: { id: 100202968 }, httpStatus: 201, networkFailure: false };
    },
  };
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  assert.deepEqual(outcome, { status: "created_confirmed", jobRowId: "row-1", stuartJobId: "100202968" });
  assert.equal(transportCalls, 1);
});

// --------------------------------------------------------------
// ITEM 5 : payment callback replay -> toujours UNE seule allocation
// logique (idempotence allocate_stuart_delivery_job + court-circuit
// created_confirmed, transport JAMAIS rappelé)
// --------------------------------------------------------------
test("item 5 : rejeu callback paiement (second appel) -- allocate renvoie la ligne déjà created_confirmed, transport jamais rappelé", async (t) => {
  let transportCalls = 0;
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow();
    if (name === "allocate_stuart_delivery_job")
      return { data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: false, collision: false, send_state: "created_confirmed", stuart_job_id: "100202968" }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = { createJob: async () => { transportCalls += 1; return { raw: { id: 1 }, httpStatus: 201, networkFailure: false }; } };
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  assert.deepEqual(outcome, { status: "already_created_confirmed", jobRowId: "row-1", stuartJobId: "100202968" });
  assert.equal(transportCalls, 0);
});

// --------------------------------------------------------------
// ITEM 6 : retry d'orchestration sur un job déjà alloué -> zéro job
// logique dupliqué (même mécanisme qu'item 5, invoqué depuis un angle
// "retry applicatif" distinct du "rejeu callback paiement")
// --------------------------------------------------------------
test("item 6 : retry d'orchestration sur job déjà alloué -- zéro duplication logique", async (t) => {
  let transportCalls = 0;
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow();
    if (name === "allocate_stuart_delivery_job")
      return { data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: false, collision: false, send_state: "created_confirmed", stuart_job_id: "999" }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = { createJob: async () => { transportCalls += 1; return { raw: { id: 1 }, httpStatus: 201, networkFailure: false }; } };
  await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  assert.equal(transportCalls, 0, "un job déjà created_confirmed ne doit jamais ré-appeler le transport, quel que soit le nombre de retries");
});

// --------------------------------------------------------------
// ITEM 7/8 : send_started stale recovery -- crash n'entraine JAMAIS un
// renvoi HTTP aveugle (reap transite en SQL pur, jamais un appel
// transport)
// --------------------------------------------------------------
test("item 7 : reapStaleStuartDeliveryJobSendStarted -- balayage borné, transition send_started->send_ambiguous mappée fidèlement", async (t) => {
  const calls = routeRpc(t, (name, args) => {
    if (name === "reap_stale_stuart_delivery_job_send_started") {
      assert.equal(args.p_stale_after_seconds, 120);
      return { data: [{ id: "row-1", order_id: "order-1", restaurant_id: "resto-1", previous_send_state: "send_started", new_send_state: "send_ambiguous" }], error: null };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const rows = await reapStaleStuartDeliveryJobSendStarted({ staleAfterSeconds: 120 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].newSendState, "send_ambiguous");
  assert.equal(calls[0].name, "reap_stale_stuart_delivery_job_send_started");
});

test("item 8 : job en send_ambiguous (après reprise crash) -- orchestration bloque, JAMAIS de renvoi aveugle", async (t) => {
  let transportCalls = 0;
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow();
    if (name === "allocate_stuart_delivery_job")
      return { data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: false, collision: false, send_state: "send_ambiguous", stuart_job_id: null }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = { createJob: async () => { transportCalls += 1; return { raw: { id: 1 }, httpStatus: 201, networkFailure: false }; } };
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  assert.deepEqual(outcome, { status: "blocked_by_prior_ambiguity", jobRowId: "row-1" });
  assert.equal(transportCalls, 0);
});

// --------------------------------------------------------------
// ITEM 10 : fixture timeout -- état ambigu sûr, jamais un succès
// silencieux ni un échec terminal supposé
// --------------------------------------------------------------
test("item 10 : transport signale networkFailure (timeout) -- send_ambiguous, mark_stuart_delivery_job_ambiguous appelé", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow();
    if (name === "allocate_stuart_delivery_job")
      return { data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: true, collision: false, send_state: "allocated", stuart_job_id: null }], error: null };
    if (name === "mark_stuart_delivery_job_send_started") return { data: null, error: null };
    if (name === "mark_stuart_delivery_job_ambiguous") return { data: null, error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = { createJob: async () => ({ raw: null, httpStatus: 0, networkFailure: true }) };
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  assert.deepEqual(outcome, { status: "send_ambiguous", jobRowId: "row-1" });
  assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
});

// --------------------------------------------------------------
// ITEM 11 : fixture 5xx -- classification BORNÉE conservatrice
// (allowlist terminale vide, préservée du design actuel create-job.ts)
// -- AMBIGU, jamais terminal_failure pour un 5xx non documenté
// --------------------------------------------------------------
test("item 11 : fixture 503 -- classifié AMBIGU (jamais terminal, allowlist terminale volontairement vide)", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow();
    if (name === "allocate_stuart_delivery_job")
      return { data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: true, collision: false, send_state: "allocated", stuart_job_id: null }], error: null };
    if (name === "mark_stuart_delivery_job_send_started") return { data: null, error: null };
    if (name === "mark_stuart_delivery_job_ambiguous") return { data: null, error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = { createJob: async () => ({ raw: { error: "service unavailable" }, httpStatus: 503, networkFailure: false }) };
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport });
  assert.deepEqual(outcome, { status: "send_ambiguous", jobRowId: "row-1" });
});

// --------------------------------------------------------------
// ITEM 12 : statut prestataire inconnu -- RAW stocké, KNOWN nullable,
// jamais un crash
// --------------------------------------------------------------
test("item 12 : applyStuartDeliveryJobStatusIfNewer -- statut inconnu, wrapper ne crashe jamais, known=null", async (t) => {
  routeRpc(t, (name, args) => {
    if (name === "apply_stuart_delivery_job_status_if_newer") {
      assert.equal(args.p_job_status_raw, "totally_unknown_status");
      return { data: [{ applied: true, job_status_known: null, delivery_status_known: null, package_status_known: null }], error: null };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const result = await applyStuartDeliveryJobStatusIfNewer({
    id: "row-1", orderId: "order-1", restaurantId: "resto-1",
    providerEventAt: new Date("2026-01-01T00:00:00Z"),
    jobStatusRaw: "totally_unknown_status",
  });
  assert.equal(result.applied, true);
  assert.equal(result.jobStatusKnown, null);
});

// --------------------------------------------------------------
// ITEM 13 : évènement hors-ordre -- AUCUNE régression, applied=false
// --------------------------------------------------------------
test("item 13 : applyStuartDeliveryJobStatusIfNewer -- évènement plus ancien qu'un déjà appliqué -- applied=false, état existant renvoyé fidèlement", async (t) => {
  routeRpc(t, (name) => {
    if (name === "apply_stuart_delivery_job_status_if_newer")
      return { data: [{ applied: false, job_status_known: "in_progress", delivery_status_known: null, package_status_known: null }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const result = await applyStuartDeliveryJobStatusIfNewer({
    id: "row-1", orderId: "order-1", restaurantId: "resto-1",
    providerEventAt: new Date("2020-01-01T00:00:00Z"),
    jobStatusRaw: "new",
  });
  assert.equal(result.applied, false);
  assert.equal(result.jobStatusKnown, "in_progress", "l'état déjà appliqué (plus récent) n'est jamais régressé");
});

// --------------------------------------------------------------
// ITEM 14 : dedup fingerprint -- rejeu exact du même corps webhook ->
// MÊME fingerprint calculé, isNewEvent=false au second appel
// --------------------------------------------------------------
test("item 14 : ingestStuartWebhookEvent -- rejeu exact -- MÊME event_fingerprint transmis, dedup (isNewEvent false au 2e appel)", async (t) => {
  let seenFingerprint: unknown = null;
  let callCount = 0;
  routeRpc(t, (name, args) => {
    if (name === "record_stuart_provider_event") {
      callCount += 1;
      if (seenFingerprint === null) seenFingerprint = args.p_event_fingerprint;
      else assert.equal(args.p_event_fingerprint, seenFingerprint, "rejeu exact doit produire EXACTEMENT le même fingerprint");
      return {
        data: [{ id: "evt-1", stuart_delivery_job_id: null, restaurant_id: null, processing_status: "received", created_at: "2026-01-01T00:00:00Z", is_new_event: callCount === 1 }],
        error: null,
      };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const fields = { providerEventType: "job_status_updated", providerJobIdRaw: "100202968", providerStatusRaw: "in_progress", rawBody: '{"event_type":"job_status_updated","job_id":100202968,"status":"in_progress"}' };
  const first = await ingestStuartWebhookEvent(fields);
  const second = await ingestStuartWebhookEvent(fields);
  assert.equal(first.isNewEvent, true);
  assert.equal(second.isNewEvent, false);
});

// --------------------------------------------------------------
// ITEM 15 : évènement job inconnu -- stocké en sécurité, AUCUN crash
// --------------------------------------------------------------
test("item 15 : recordStuartProviderEvent -- job Stuart inconnu localement -- stuartDeliveryJobId/restaurantId null, AUCUNE exception", async (t) => {
  routeRpc(t, (name) => {
    if (name === "record_stuart_provider_event")
      return { data: [{ id: "evt-2", stuart_delivery_job_id: null, restaurant_id: null, processing_status: "received", created_at: "2026-01-01T00:00:00Z", is_new_event: true }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const record = await recordStuartProviderEvent({ eventFingerprint: "a".repeat(64), providerEventType: "job_status_updated", providerJobIdRaw: "NO-SUCH-JOB" });
  assert.equal(record.stuartDeliveryJobId, null);
  assert.equal(record.restaurantId, null);
});

// --------------------------------------------------------------
// ITEM 16 : revendications concurrentes -- ownership unique (le
// primitif FOR UPDATE SKIP LOCKED lui-même a été vérifié EN DIRECT
// contre PostgreSQL réel -- voir rapport. Ici : le processeur ne
// traite jamais deux fois le même évènement à travers deux appels
// successifs quand le second batch est vide, comme le renverrait
// réellement SKIP LOCKED après un premier claim exhaustif).
// --------------------------------------------------------------
test("item 16 : processClaimedStuartProviderEvents -- un second appel avec un batch vide ne retraite RIEN (reflète SKIP LOCKED)", async (t) => {
  let claimCallCount = 0;
  routeRpc(t, (name) => {
    claimCallCount += 1;
    if (name === "claim_stuart_provider_events") {
      if (claimCallCount === 1) {
        return {
          data: [{ id: "evt-1", stuart_delivery_job_id: "job-1", restaurant_id: "resto-1", provider_job_id_raw: "100202968", event_fingerprint: "a".repeat(64), provider_event_type: "job_status_updated", provider_status_raw: "in_progress", processing_status: "received", retry_count: 0, claim_token: "tok-1", claim_expires_at: "2026-01-01T01:00:00Z", created_at: "2026-01-01T00:00:00Z" }],
          error: null,
        };
      }
      return { data: [], error: null };
    }
    if (name === "apply_stuart_delivery_job_status_if_newer") return { data: [{ applied: true, job_status_known: "in_progress", delivery_status_known: null, package_status_known: null }], error: null };
    if (name === "update_stuart_provider_event_processing_status") return { data: [{ id: "evt-1", processing_status: "applied", retry_count: 0, processed_at: "2026-01-01T00:00:00Z", stuart_delivery_job_id: "job-1" }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const resolver = { resolveOrderId: async () => "order-1" };
  const first = await processClaimedStuartProviderEvents(resolver);
  const second = await processClaimedStuartProviderEvents(resolver);
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome, "applied");
  assert.equal(second.length, 0, "un second appel après un batch déjà entièrement revendiqué ne retraite jamais les mêmes évènements");
});

// --------------------------------------------------------------
// ITEM 15bis (unknown job -> processor) : job non résolu -- reprise
// différée, JAMAIS un crash/une erreur non gérée
// --------------------------------------------------------------
test("item 15bis : processClaimedStuartProviderEvents -- évènement à job inconnu -- failed_retryable (reprise différée), AUCUN crash", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "claim_stuart_provider_events")
      return {
        data: [{ id: "evt-3", stuart_delivery_job_id: null, restaurant_id: null, provider_job_id_raw: "NO-SUCH-JOB", event_fingerprint: "b".repeat(64), provider_event_type: "job_status_updated", provider_status_raw: "in_progress", processing_status: "received", retry_count: 0, claim_token: "tok-3", claim_expires_at: "2026-01-01T01:00:00Z", created_at: "2026-01-01T00:00:00Z" }],
        error: null,
      };
    if (name === "update_stuart_provider_event_processing_status") return { data: [{ id: "evt-3", processing_status: "failed_retryable", retry_count: 1, processed_at: "2026-01-01T00:00:00Z", stuart_delivery_job_id: null }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const resolver = { resolveOrderId: async () => { throw new Error("NE DOIT JAMAIS ÊTRE APPELÉ POUR UN JOB INCONNU"); } };
  const results = await processClaimedStuartProviderEvents(resolver);
  assert.equal(results[0].outcome, "unknown_job_retry");
  const updateCall = calls.find((c) => c.name === "update_stuart_provider_event_processing_status");
  assert.equal(updateCall?.args.p_new_status, "failed_retryable");
  assert.equal(updateCall?.args.p_error_class, "STUART_UNKNOWN_JOB_AWAITING_CORRELATION");
});

// --------------------------------------------------------------
// ITEM 17 : bail expiré -- reclaimable (plomberie du wrapper : le
// claim_token/claim_expires_at renvoyés par la RPC sont transmis
// fidèlement à update -- la garantie temporelle elle-même a été
// vérifiée EN DIRECT contre PostgreSQL réel, voir rapport)
// --------------------------------------------------------------
test("item 17 : claimStuartProviderEvents -- claim_token/claim_expires_at transmis fidèlement (plomberie)", async (t) => {
  routeRpc(t, (name) => {
    if (name === "claim_stuart_provider_events")
      return {
        data: [{ id: "evt-4", stuart_delivery_job_id: null, restaurant_id: null, provider_job_id_raw: null, event_fingerprint: "c".repeat(64), provider_event_type: "x", provider_status_raw: null, processing_status: "received", retry_count: 0, claim_token: "tok-4", claim_expires_at: "2026-01-01T00:01:00Z", created_at: "2026-01-01T00:00:00Z" }],
        error: null,
      };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const rows = await claimStuartProviderEvents({ batchSize: 5, leaseSeconds: 60 });
  assert.equal(rows[0].claimToken, "tok-4");
  assert.equal(rows[0].claimExpiresAt, "2026-01-01T00:01:00Z");
});

// --------------------------------------------------------------
// ITEM 18 : évènement terminal -- ne peut pas être retraité de façon
// incorrecte (le verrouillage lui-même vérifié EN DIRECT contre
// PostgreSQL réel -- ici : l'erreur RPC 42501 se propage fidèlement en
// StuartProviderEventError, jamais masquée/avalée)
// --------------------------------------------------------------
test("item 18 : updateStuartProviderEventProcessingStatus -- transition refusée (42501) -- StuartProviderEventError propagée", async (t) => {
  routeRpc(t, (name) => {
    if (name === "update_stuart_provider_event_processing_status") return { data: null, error: { code: "42501", message: "terminal" } };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await assert.rejects(
    () => updateStuartProviderEventProcessingStatus({ eventId: "evt-1", claimToken: "tok-1", newStatus: "failed_retryable" }),
    StuartProviderEventError
  );
});

// --------------------------------------------------------------
// ITEM 19 : corrélation cross-tenant rejetée (isolation tenant
// STRUCTURELLE -- le wrapper propage fidèlement ORDER_NOT_FOUND, la
// garantie base a été vérifiée EN DIRECT contre PostgreSQL réel)
// --------------------------------------------------------------
test("item 19 : getStuartDeliveryEligibility -- couple (order_id, restaurant_id) incohérent -- ORDER_NOT_FOUND, jamais eligible", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return ineligibleRow("ORDER_NOT_FOUND");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const result = await getStuartDeliveryEligibility({ orderId: "order-1", restaurantId: "wrong-tenant" });
  assert.deepEqual(result, { eligible: false, reasonCode: "ORDER_NOT_FOUND" });
});

// --------------------------------------------------------------
// ITEM 20 : accès direct table anon/authenticated refusé -- vérifié EN
// DIRECT contre PostgreSQL réel (RLS activée + REVOKE ALL, y compris
// service_role sur la table elle-même) -- voir rapport de livraison
// pour la trace exacte des commandes exécutées.
// --------------------------------------------------------------
test("item 20 (référence) : la posture RLS/ACL de stuart_provider_events est documentée dans le fichier SQL et a été vérifiée en direct (voir rapport)", () => {
  const sql = readFileSync("supabase/DRAFT-lot-stuart-provider-events-foundation-v1.sql", "utf8");
  assert.match(sql, /revoke all on table public\.stuart_provider_events from anon, authenticated, service_role, public;/);
  assert.match(sql, /alter table public\.stuart_provider_events enable row level security;/);
});

// --------------------------------------------------------------
// ITEM 21 : AUCUN appel fetch/réseau réel dans toute la nouvelle
// surface D1 -- vérification structurelle par lecture de fichier
// --------------------------------------------------------------
test("item 21 : aucun des nouveaux fichiers D1 n'appelle fetch(...) littéralement (transport toujours injecté)", () => {
  const files = [
    "lib/server/delivery-providers/stuart/eligibility.ts",
    "lib/server/delivery-providers/stuart/orchestration.ts",
    "lib/server/delivery-providers/stuart/recovery.ts",
    "lib/server/delivery-providers/stuart/provider-events.ts",
    "lib/server/delivery-providers/stuart/webhook-ingestion.ts",
    "lib/server/delivery-providers/stuart/webhook-processor.ts",
    "lib/server/delivery-providers/stuart/webhook-auth-adapter.ts",
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (/\bfetch\s*\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------
// ITEM 22 : LOT C non-régression -- aucun des nouveaux modules D1
// n'appelle set_order_delivery_provider_financials/
// persistOrderDeliveryProviderFinancials (autorité write-once LOT C,
// jamais exercée hors d'un test fixture dédié, mandat §H)
// --------------------------------------------------------------
test("item 22 : aucun fichier D1 n'appelle set_order_delivery_provider_financials/persistOrderDeliveryProviderFinancials", () => {
  const files = [
    "lib/server/delivery-providers/stuart/eligibility.ts",
    "lib/server/delivery-providers/stuart/orchestration.ts",
    "lib/server/delivery-providers/stuart/recovery.ts",
    "lib/server/delivery-providers/stuart/provider-events.ts",
    "lib/server/delivery-providers/stuart/webhook-ingestion.ts",
    "lib/server/delivery-providers/stuart/webhook-processor.ts",
    "lib/server/delivery-providers/stuart/webhook-auth-adapter.ts",
    "supabase/DRAFT-lot-stuart-provider-events-foundation-v1.sql",
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (/set_order_delivery_provider_financials|persistOrderDeliveryProviderFinancials/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------
// ITEM 23 : aucun fallback credential global -- structurel (aucun
// fichier D1 n'importe auth.ts/environment.ts/create-job.ts, jamais de
// référence à STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV)
// --------------------------------------------------------------
test("item 23 : aucun module D1 n'importe auth.ts/environment.ts/create-job.ts ni ne référence de credential global", () => {
  const files = [
    "lib/server/delivery-providers/stuart/eligibility.ts",
    "lib/server/delivery-providers/stuart/orchestration.ts",
    "lib/server/delivery-providers/stuart/recovery.ts",
    "lib/server/delivery-providers/stuart/provider-events.ts",
    "lib/server/delivery-providers/stuart/webhook-ingestion.ts",
    "lib/server/delivery-providers/stuart/webhook-processor.ts",
    "lib/server/delivery-providers/stuart/webhook-auth-adapter.ts",
    "app/api/internal/stuart/webhook/route.ts",
  ];
  const forbidden = [
    /from ["']@\/lib\/server\/delivery-providers\/stuart\/auth["']/,
    /from ["']@\/lib\/server\/delivery-providers\/stuart\/environment["']/,
    /from ["']@\/lib\/server\/delivery-providers\/stuart\/create-job["']/,
    /STUART_CLIENT_ID/,
    /STUART_CLIENT_SECRET/,
    /STUART_ENV\b/,
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(src)) offenders.push(`${file} -> ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------
// Cancellation locale (mandat §G) -- plomberie du wrapper
// --------------------------------------------------------------
test("cancellation locale : recordStuartDeliveryJobLocalCancellation -- appel RPC possession-scopé, propage l'échec fermé (P0002) si déjà marqué", async (t) => {
  const calls = routeRpc(t, (name, args) => {
    if (name === "record_stuart_delivery_job_local_cancellation") {
      assert.equal(args.p_id, "row-1");
      assert.equal(args.p_order_id, "order-1");
      assert.equal(args.p_restaurant_id, "resto-1");
      return { data: null, error: { code: "P0002", message: "déjà marqué" } };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await assert.rejects(() => recordStuartDeliveryJobLocalCancellation({ id: "row-1", orderId: "order-1", restaurantId: "resto-1" }));
  assert.equal(calls[0].name, "record_stuart_delivery_job_local_cancellation");
});

// --------------------------------------------------------------
// Adaptateur d'authentification webhook -- NON-LIVE par construction
// --------------------------------------------------------------
test("adaptateur d'authentification webhook NON-LIVE -- rejette INCONDITIONNELLEMENT, quel que soit le contenu", async () => {
  const result = await NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER.verify("{}", { "x-stuart-signature": "anything" });
  assert.equal(result.authenticated, false);
});

// --------------------------------------------------------------
// Erreur RPC générique -- fail-closed, jamais un eligible=true implicite
// --------------------------------------------------------------
test("panne RPC eligibility -- StuartEligibilityError, jamais un résultat implicite", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return { data: null, error: { code: "40001", message: "panne" } };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await assert.rejects(() => getStuartDeliveryEligibility({ orderId: "order-1", restaurantId: "resto-1" }), StuartEligibilityError);
});
