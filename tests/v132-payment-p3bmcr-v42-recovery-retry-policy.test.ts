import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2.
// Couvre lib/server/payment-provider-event-processor.ts après la
// correction de P3BV41-RECOVERY-STARVATION-01 (audit de travail v4.1
// indépendant, blocage HIGH) : classification transitoire/permanente
// des erreurs, plafond de tentatives, et non-régression du modèle
// claim/lease existant. La preuve de PRIVATION (starvation) elle-même,
// au niveau SQL (délai d'éligibilité réel, `next_attempt_at`), vit dans
// supabase/tests/payment-p3b-monetico-checkout-runtime-v42-check.sh --
// ce fichier prouve la classification et le plafond côté TypeScript,
// au niveau du processeur PARTAGÉ (mandat §17, jamais une seconde
// implémentation).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-v42-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processClaimedPaymentProviderEvent } = await import(
  "../lib/server/payment-provider-event-processor.ts"
);

type RpcHandler = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

function routeRpc(t: { mock: { method: Function } }, handlers: Record<string, RpcHandler>) {
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
/** Simule un rejet DÉTERMINISTE de la RPC (`error.code` défini) --
 *  PostgrestError, jamais une exception de transport. C'est ce chemin
 *  précis (`error` non null, pas `client.rpc` qui lève) qui produit
 *  `PaymentServerRpcError` côté wrapper (payment-service.ts), jamais
 *  `PaymentServerUnavailableError`. */
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

// --------------------------------------------------------------
// CLASSIFICATION -- confirm_payment_attempt.
// --------------------------------------------------------------

test("confirm_payment_attempt : panne de TRANSPORT (client.rpc lève) -- failed_retryable, PAS failed_terminal", async (t) => {
  let finalized: string | undefined;
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: () => {
      throw new Error("panne réseau simulée");
    },
    update_payment_provider_event_processing_status: (_n, args) => {
      finalized = String(args.p_new_status);
      return ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 1, processed_at: "2026-08-31T00:00:00Z" });
    },
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_retryable");
  assert.equal(finalized, "failed_retryable");
});

test("confirm_payment_attempt : rejet DÉTERMINISTE de la RPC (error.code défini, ex. corrélation impossible) -- failed_terminal DIRECTEMENT, jamais failed_retryable d'abord", async (t) => {
  let finalized: string | undefined;
  let errorClass: string | undefined;
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: (_n, args) => {
      finalized = String(args.p_new_status);
      errorClass = args.p_error_class as string | undefined;
      return ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" });
    },
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_terminal");
  assert.equal(finalized, "failed_terminal");
  assert.equal(errorClass, "CONFIRM_ATTEMPT_PERMANENT_FAILURE");
});

// --------------------------------------------------------------
// CLASSIFICATION -- get_payment_transaction_correlation.
// --------------------------------------------------------------

test("get_payment_transaction_correlation : panne de TRANSPORT -- failed_retryable (CORRELATION_UNAVAILABLE)", async (t) => {
  let errorClass: string | undefined;
  routeRpc(t, {
    get_payment_transaction_correlation: () => {
      throw new Error("panne réseau simulée");
    },
    update_payment_provider_event_processing_status: (_n, args) => {
      errorClass = args.p_error_class as string | undefined;
      return ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 1, processed_at: "2026-08-31T00:00:00Z" });
    },
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_retryable");
  assert.equal(errorClass, "CORRELATION_UNAVAILABLE");
});

test("get_payment_transaction_correlation : rejet DÉTERMINISTE (corrélation introuvable -- l'exemple TERMINAL littéral du mandat) -- failed_terminal DIRECTEMENT", async (t) => {
  let errorClass: string | undefined;
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: (_n, args) => {
      errorClass = args.p_error_class as string | undefined;
      return ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" });
    },
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_terminal");
  assert.equal(errorClass, "CORRELATION_IMPOSSIBLE");
});

// --------------------------------------------------------------
// PLAFOND DE TENTATIVES -- mandat §12/§17.
// --------------------------------------------------------------

test("retryCount déjà au plafond (5) -- failed_terminal IMMÉDIAT, confirm_payment_attempt/corrélation JAMAIS appelées (défense en profondeur AVANT tout appel)", async (t) => {
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: (_n, args) =>
      ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 5, processed_at: "2026-08-31T00:00:00Z" }),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ retryCount: 5 }));
  assert.equal(result.outcome, "failed_terminal");
  assert.ok(!calls.some((c) => c.name === "get_payment_transaction_correlation"));
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("retryCount sous le plafond (4) -- tentative normale poursuit (pas d'escalade côté TS -- la SQL elle-même escaladerait à la 6e si celle-ci échoue aussi, voir harnais SQL)", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
    update_payment_provider_event_processing_status: (_n, args) =>
      ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 4, processed_at: "2026-08-31T00:00:00Z" }),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ retryCount: 4 }));
  assert.equal(result.outcome, "applied");
});

// --------------------------------------------------------------
// NON-RÉGRESSION -- règles dures v3/v4 INCHANGÉES par ce lot.
// --------------------------------------------------------------

test("NON-RÉGRESSION : refused reste 'ignored', confirm_payment_attempt JAMAIS appelée (mandat §22, refus != échec)", async (t) => {
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: (_n, args) =>
      ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" }),
  });
  const result = await processClaimedPaymentProviderEvent(
    claimedEvent({ providerEventType: "refused", amount: null, currency: null })
  );
  assert.equal(result.outcome, "ignored");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("NON-RÉGRESSION : montant/devise divergents -- 'ignored' (AMOUNT_CURRENCY_MISMATCH), jamais 'failed_retryable'/'failed_terminal' (V2-04 inchangée)", async (t) => {
  let errorClass: string | undefined;
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    update_payment_provider_event_processing_status: (_n, args) => {
      errorClass = args.p_error_class as string | undefined;
      return ok({ id: "evt-1", processing_status: args.p_new_status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" });
    },
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ amount: "999.99" }));
  assert.equal(result.outcome, "ignored");
  assert.equal(errorClass, "AMOUNT_CURRENCY_MISMATCH");
});

test("NON-RÉGRESSION : bail périmé pendant finalize (update_payment_provider_event_processing_status rejette) -- 'stale_claim', jamais une erreur remontée (perte de course SÛRE, INCHANGÉE)", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
    update_payment_provider_event_processing_status: () => rpcRejected("P0004"),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "stale_claim");
});
