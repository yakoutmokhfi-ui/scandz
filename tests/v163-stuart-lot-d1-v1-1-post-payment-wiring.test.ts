import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-d1-v1-1-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();

const { processClaimedPaymentProviderEvent } = await import(
  "../lib/server/payment-provider-event-processor.ts"
);
const {
  triggerStuartPostPaymentOrchestration,
  NON_LIVE_STUART_ORCHESTRATION_TRANSPORT,
} = await import("../lib/server/delivery-providers/stuart/post-payment-hook-wiring.ts");

// ====================================================================
// STUART LOT D1 v1.1 — REMEDIATION CIBLÉE (blocage scope-compliance
// CTO, "TARGETED SCOPE-COMPLIANCE REMEDIATION — POST-PAYMENT HOOK
// WIRING ONLY"). Toutes les RPC sont MOCKÉES -- AUCUN appel réseau/DB
// réel. Couvre les 8 comportements attendus du mandat v1.1 :
//   1/2. paiement non confirmé/refusé/pending -- hook JAMAIS invoqué
//   3. transition authoritative vers paid -- hook invoqué UNE fois
//   4. rejeu de callback -- jamais un second job logique
//   5. commande inéligible -- zéro appel transport
//   6. commande éligible + transport D1 non-live -- zéro appel réseau réel
//   7. traitement de paiement existant -- inchangé (best-effort strict)
//   8. reprise/rejeu d'évènement de paiement -- inchangé
// ====================================================================

function routeRpc(t: { mock: { method: Function } }, handlers: Record<string, (name: string, args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`RPC inattendue dans ce scénario de test : ${name}`);
    return handler(name, args);
  });
  return calls;
}

const ok = (row: unknown) => ({ data: [row], error: null });
const rpcRejected = (code = "P0002") => ({ data: null, error: { code, message: "simulated" } });

function claimedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evt-1",
    restaurantId: "resto-1",
    orderId: "order-1",
    paymentTransactionId: "txn-1",
    providerCode: "monetico",
    providerReference: "ref-evt-1",
    eventFingerprint: "fp-evt-1",
    providerEventType: "paid" as const,
    providerEventCode: "paiement",
    amount: "25.00",
    currency: "EUR",
    authorizationReference: null,
    processingStatus: "received",
    retryCount: 0,
    claimToken: "claim-token-1",
    claimExpiresAt: "2026-08-31T00:01:00Z",
    ...overrides,
  };
}

const CORRELATION_ROW = () =>
  ok({
    restaurant_id: "resto-1",
    order_id: "order-1",
    transaction_id: "txn-1",
    status: "pending",
    amount: "25.00",
    currency: "EUR",
  });

const CONFIRM_PAID_OK = () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });

const FINALIZE_OK = (_n: string, args: Record<string, unknown>) =>
  ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" });

function eligibleRow() {
  // STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 2 HIGH) --
  // get_stuart_delivery_eligibility renvoie désormais AUSSI
  // merchant_environment sur la branche eligible=true -- requis par
  // eligibility.ts (fail-closed sur son absence/valeur inconnue).
  return { data: [{ eligible: true, reason_code: "ELIGIBLE", merchant_environment: "sandbox" }], error: null };
}
function ineligibleRow(reasonCode: string) {
  return { data: [{ eligible: false, reason_code: reasonCode }], error: null };
}

function allocationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-row-1",
    client_reference: "CANDIDATE1",
    is_new_allocation: true,
    collision: false,
    send_state: null,
    stuart_job_id: null,
    ...overrides,
  };
}

// --------------------------------------------------------------
// ITEMS 1/2 : paiement non confirmé/refusé/pending -- hook Stuart
// JAMAIS invoqué (aucune RPC Stuart, y compris get_stuart_delivery_
// eligibility).
// --------------------------------------------------------------

test("item 1/2a : évènement 'refused' -- confirmPaymentAttempt et le hook Stuart JAMAIS appelés", async (t) => {
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(
    claimedEvent({ providerEventType: "refused", amount: null, currency: null })
  );
  assert.equal(result.outcome, "ignored");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
  assert.ok(!calls.some((c) => c.name.startsWith("get_stuart_delivery_eligibility")));
  assert.ok(!calls.some((c) => c.name.startsWith("allocate_stuart_delivery_job")));
});

test("item 1/2b : évènement 'pending' -- confirmPaymentAttempt et le hook Stuart JAMAIS appelés", async (t) => {
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(
    claimedEvent({ providerEventType: "pending", amount: null, currency: null })
  );
  assert.equal(result.outcome, "ignored");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
  assert.ok(!calls.some((c) => c.name === "get_stuart_delivery_eligibility"));
});

test("item 2c : montant/devise divergents ('paid' brut mais rejeté V2-04) -- confirmPaymentAttempt et le hook Stuart JAMAIS appelés", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ amount: "999.99" }));
  assert.equal(result.outcome, "ignored");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
  assert.ok(!calls.some((c) => c.name === "get_stuart_delivery_eligibility"));
});

test("item 1/2d : confirmPaymentAttempt REJETÉE (statut réellement pas atteint côté base) -- hook Stuart JAMAIS appelé", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_terminal");
  assert.ok(!calls.some((c) => c.name === "get_stuart_delivery_eligibility"));
});

// --------------------------------------------------------------
// ITEM 3/5 : transition authoritative vers paid -- hook Stuart invoqué
// EXACTEMENT une fois (get_stuart_delivery_eligibility appelée une
// fois) ; fixture inéligible -- ZÉRO appel allocate/transport (item 5).
// --------------------------------------------------------------

test("item 3+5 : confirmPaymentAttempt réussit -- hook Stuart invoqué EXACTEMENT une fois ; commande inéligible -- zéro allocation/transport", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: CONFIRM_PAID_OK,
    get_stuart_delivery_eligibility: () => ineligibleRow("PAYMENT_NOT_CONFIRMED"),
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  // Le traitement financier reste "applied" -- l'orchestration Stuart
  // est strictement best-effort et n'affecte JAMAIS ce résultat (item 7).
  assert.equal(result.outcome, "applied");
  assert.equal(calls.filter((c) => c.name === "get_stuart_delivery_eligibility").length, 1);
  assert.equal(calls.filter((c) => c.name === "allocate_stuart_delivery_job").length, 0);
});

// --------------------------------------------------------------
// ITEM 6 : commande ÉLIGIBLE + transport D1 non-live -- ZÉRO appel
// réseau réel possible. L'allocation SQL est réellement exercée (effet
// voulu, "payment-confirmed event wiring exists now") mais le
// transport ne renvoie jamais qu'un networkFailure -- jamais un
// "created_confirmed" réel.
// --------------------------------------------------------------

test("item 6 : commande éligible -- allocation réelle exercée, mais AUCUN appel réseau réel (transport non-live -> send_ambiguous, jamais created_confirmed)", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: CONFIRM_PAID_OK,
    get_stuart_delivery_eligibility: eligibleRow,
    allocate_stuart_delivery_job: () => ok(allocationRow()),
    mark_stuart_delivery_job_send_started: () => ({ data: null, error: null }),
    mark_stuart_delivery_job_ambiguous: () => ({ data: null, error: null }),
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "applied");
  // Le hook Stuart lui-même (appelé directement pour vérifier son issue
  // exacte, jamais observable depuis le résultat du paiement) doit
  // renvoyer send_ambiguous -- JAMAIS created_confirmed -- puisque le
  // transport ne peut structurellement jamais réussir.
  const direct = await triggerStuartPostPaymentOrchestration({ orderId: "order-1", restaurantId: "resto-1" });
  assert.equal(direct.status, "send_ambiguous");
  assert.ok(!("stuartJobId" in direct));
});

test("item 6 (transport isolé) : NON_LIVE_STUART_ORCHESTRATION_TRANSPORT.createJob renvoie TOUJOURS networkFailure:true, quel que soit le payload", async () => {
  const result = await NON_LIVE_STUART_ORCHESTRATION_TRANSPORT.createJob({ job: { pickups: [], dropoffs: [] } } as never);
  assert.deepEqual(result, { raw: null, httpStatus: 0, networkFailure: true });
});

test("item 6 (structurel) : post-payment-hook-wiring.ts n'appelle jamais fetch(...) littéralement", () => {
  const src = readFileSync("lib/server/delivery-providers/stuart/post-payment-hook-wiring.ts", "utf8");
  assert.ok(!/\bfetch\s*\(/.test(src));
});

// --------------------------------------------------------------
// ITEM 4 : rejeu de callback paiement -- jamais un second job logique.
// Simule un second appel du hook pour la MÊME commande alors que
// l'allocation précédente a déjà transité vers send_ambiguous (état
// EXISTANT, D1 v1, INCHANGÉ) -- allocate_stuart_delivery_job (idempotent
// côté SQL réel) renvoie alors send_state déjà posé, PAS is_new_allocation.
// --------------------------------------------------------------

test("item 4 : rejeu -- allocation déjà send_ambiguous -- blocked_by_prior_ambiguity, AUCUN second appel transport/possession", async (t) => {
  const calls = routeRpc(t, {
    get_stuart_delivery_eligibility: eligibleRow,
    allocate_stuart_delivery_job: () =>
      ok(allocationRow({ is_new_allocation: false, send_state: "send_ambiguous" })),
  });
  const outcome = await triggerStuartPostPaymentOrchestration({ orderId: "order-1", restaurantId: "resto-1" });
  assert.deepEqual(outcome, { status: "blocked_by_prior_ambiguity", jobRowId: "job-row-1" });
  assert.ok(!calls.some((c) => c.name === "mark_stuart_delivery_job_send_started"));
  assert.ok(!calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
});

test("item 4bis : rejeu -- allocation déjà created_confirmed -- already_created_confirmed, AUCUN second appel transport", async (t) => {
  const calls = routeRpc(t, {
    get_stuart_delivery_eligibility: eligibleRow,
    allocate_stuart_delivery_job: () =>
      ok(allocationRow({ is_new_allocation: false, send_state: "created_confirmed", stuart_job_id: "999" })),
  });
  const outcome = await triggerStuartPostPaymentOrchestration({ orderId: "order-1", restaurantId: "resto-1" });
  assert.deepEqual(outcome, { status: "already_created_confirmed", jobRowId: "job-row-1", stuartJobId: "999" });
  assert.ok(!calls.some((c) => c.name === "mark_stuart_delivery_job_send_started"));
});

// --------------------------------------------------------------
// ITEM 7 : traitement de paiement existant INCHANGÉ -- best-effort
// STRICT. Le hook Stuart échoue (RPC rejetée/exception) -- le résultat
// du traitement de paiement reste EXACTEMENT le même qu'avant ce lot.
// --------------------------------------------------------------

test("item 7 : le hook Stuart lève (get_stuart_delivery_eligibility rejette) -- 'applied' reste INCHANGÉ, jamais une erreur remontée au paiement", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: CONFIRM_PAID_OK,
    get_stuart_delivery_eligibility: () => {
      throw new Error("panne Stuart simulée -- ne doit JAMAIS affecter le paiement");
    },
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "applied");
  assert.equal(calls.filter((c) => c.name === "update_payment_provider_event_processing_status").length, 1);
  assert.equal(
    calls.find((c) => c.name === "update_payment_provider_event_processing_status")?.args.p_new_status,
    "applied"
  );
});

test("item 7bis : NON-RÉGRESSION -- refused reste 'ignored' (comportement pré-v1.1 strictement identique)", async (t) => {
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(
    claimedEvent({ providerEventType: "refused", amount: null, currency: null })
  );
  assert.equal(result.outcome, "ignored");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("item 7ter : NON-RÉGRESSION -- retryCount au plafond (5) reste failed_terminal IMMÉDIAT, ni corrélation ni hook Stuart appelés", async (t) => {
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: FINALIZE_OK,
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ retryCount: 5 }));
  assert.equal(result.outcome, "failed_terminal");
  assert.ok(!calls.some((c) => c.name === "get_payment_transaction_correlation"));
  assert.ok(!calls.some((c) => c.name === "get_stuart_delivery_eligibility"));
});

// --------------------------------------------------------------
// ITEM 8 : reprise/rejeu d'évènement de paiement INCHANGÉ -- un conflit
// de bail RÉEL (P0004) pendant la finalisation reste 'stale_claim',
// MÊME si le hook Stuart a été invoqué avec succès entre-temps (ordre
// d'appel : confirmPaymentAttempt -> hook Stuart best-effort ->
// finalize -- le hook Stuart s'exécute AVANT la finalisation, jamais
// après, donc son issue ne peut structurellement jamais changer celle
// de finalize).
// --------------------------------------------------------------

test("item 8 : bail périmé pendant finalize (P0004) -- 'stale_claim' INCHANGÉ, même avec un hook Stuart invoqué avec succès (ineligible fixture)", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: CONFIRM_PAID_OK,
    get_stuart_delivery_eligibility: () => ineligibleRow("FULFILLMENT_MODE_NOT_DELIVERY"),
    update_payment_provider_event_processing_status: () => rpcRejected("P0004"),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "stale_claim");
});

test("item 8bis : bail périmé pendant finalize (P0004) -- 'stale_claim' INCHANGÉ même si le hook Stuart lui-même échoue", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: CONFIRM_PAID_OK,
    get_stuart_delivery_eligibility: () => {
      throw new Error("panne Stuart simulée");
    },
    update_payment_provider_event_processing_status: () => rpcRejected("P0004"),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "stale_claim");
});

// --------------------------------------------------------------
// Sanity structurelle -- confirme que le câblage existe réellement
// (jamais un fichier ajouté mais jamais invoqué).
// --------------------------------------------------------------

test("sanity : payment-provider-event-processor.ts importe et appelle réellement triggerStuartPostPaymentOrchestration", () => {
  const src = readFileSync("lib/server/payment-provider-event-processor.ts", "utf8");
  assert.match(src, /triggerStuartPostPaymentOrchestration/);
  assert.match(src, /from ["']@\/lib\/server\/delivery-providers\/stuart\/post-payment-hook-wiring["']/);
});

test("sanity : post-payment-hook-wiring.ts importe \"server-only\" en tête (convention lib/server/*)", () => {
  const src = readFileSync("lib/server/delivery-providers/stuart/post-payment-hook-wiring.ts", "utf8");
  assert.match(src, /^import "server-only";/);
});
