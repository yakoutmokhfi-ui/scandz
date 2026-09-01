import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — MATRICE INTÉGRÉE
// TS <-> SQL (ferme P3BV42-TEST-MATRIX-01).
//
// LIMITATION HONNÊTE (mandat §15) : l'installation de PostgreSQL a
// échoué dans CET environnement d'exécution (miroir de paquets Ubuntu
// indisponible -- 404 sur security.ubuntu.com au moment de ce lot,
// voir SQL-HARNESS-REPORT.txt pour la trace complète de la tentative).
// Aucune exécution SQL réelle n'a donc eu lieu pour CE fichier -- au
// lieu d'un harnais SQL réellement exécuté, ce fichier réplique
// FIDÈLEMENT, en mémoire, la validation exacte de
// update_payment_provider_event_processing_status
// (supabase/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql,
// lignes ~1010-1022, ~937-1080) telle que LUE caractère par
// caractère lors de l'audit de ce lot -- jamais une invention. Les
// affirmations qui suivent portent explicitement la mention "d'après
// le contrat SQL LU" plutôt que "vérifié par exécution".
//
// Contrairement au v132 original (mocks qui renvoient TOUJOURS succès
// pour update_payment_provider_event_processing_status, quel que soit
// l'état courant réellement demandé), ce simulateur REFUSE les
// transitions non autorisées, EXACTEMENT comme la vraie RPC -- "Do not
// allow mocks to invent transitions not accepted by SQL" (mandat §14).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-v43-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processClaimedPaymentProviderEvent } = await import(
  "../lib/server/payment-provider-event-processor.ts"
);

type RpcHandler = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

const MAX_RETRY_ATTEMPTS_SQL = 5;

interface SimulatedEvent {
  processing_status: "received" | "applied" | "ignored" | "failed_retryable" | "failed_terminal";
  retry_count: number;
  claim_token: string;
}

function simulateUpdateStatus(
  event: SimulatedEvent,
  claimToken: string,
  newStatus: string
): { data: unknown; error: { code: string; message: string } | null } {
  if (event.claim_token !== claimToken) {
    return { data: null, error: { code: "P0004", message: "jeton de revendication invalide ou bail expiré" } };
  }
  if (
    event.processing_status === newStatus &&
    newStatus !== "failed_retryable" &&
    ["applied", "ignored", "failed_terminal"].includes(event.processing_status)
  ) {
    return {
      data: [{ id: "evt-1", processing_status: event.processing_status, retry_count: event.retry_count, processed_at: "2026-01-01T00:00:00Z" }],
      error: null,
    };
  }
  if (["applied", "ignored", "failed_terminal"].includes(event.processing_status)) {
    return { data: null, error: { code: "42501", message: "évènement déjà terminal, transition refusée" } };
  }
  const allowedFromReceived = ["applied", "ignored", "failed_retryable", "failed_terminal"];
  const allowedFromFailedRetryable = ["applied", "failed_retryable", "failed_terminal"];
  if (event.processing_status === "received" && !allowedFromReceived.includes(newStatus)) {
    return { data: null, error: { code: "42501", message: `transition received -> ${newStatus} non autorisée` } };
  }
  if (event.processing_status === "failed_retryable" && !allowedFromFailedRetryable.includes(newStatus)) {
    return { data: null, error: { code: "42501", message: `transition failed_retryable -> ${newStatus} non autorisée` } };
  }

  let effectiveStatus = newStatus;
  if (newStatus === "failed_retryable" && event.retry_count >= MAX_RETRY_ATTEMPTS_SQL) {
    effectiveStatus = "failed_terminal";
  }

  const newRetryCount = effectiveStatus === "failed_retryable" ? event.retry_count + 1 : event.retry_count;
  event.processing_status = effectiveStatus as SimulatedEvent["processing_status"];
  event.retry_count = newRetryCount;
  event.claim_token = "";

  return {
    data: [{ id: "evt-1", processing_status: effectiveStatus, retry_count: newRetryCount, processed_at: "2026-01-01T00:00:00Z" }],
    error: null,
  };
}

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
const rpcRejected = (code: string, message = "simulated") => ({ data: null, error: { code, message } });

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
  ok({ restaurant_id: "resto-1", order_id: "order-1", transaction_id: "txn-1", status: "pending", amount: "25.00", currency: "EUR" });

test("MATRICE [received, P0002 déterministe] -- classification=terminal, transition SQL simulée RÉELLEMENT ACCEPTÉE (received -> failed_terminal, LOT v4.3)", async (t) => {
  const event: SimulatedEvent = { processing_status: "received", retry_count: 0, claim_token: "claim-token-1" };
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("P0002", "corrélation impossible"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_terminal", "classification correcte ET transition SQL simulée acceptée -- plus jamais masquée en stale_claim");
  assert.equal(event.processing_status, "failed_terminal");
  assert.equal(event.retry_count, 0, "retry_count reste à 0 -- jamais une tentative de retry réellement effectuée");
});

for (const transientCode of ["40001", "40P01"]) {
  test(`MATRICE [received, ${transientCode} transitoire] -- classification=retryable, JAMAIS terminal (ferme P3BV42-RPC-TRANSIENT-CLASSIFICATION-01)`, async (t) => {
    const event: SimulatedEvent = { processing_status: "received", retry_count: 0, claim_token: "claim-token-1" };
    routeRpc(t, {
      get_payment_transaction_correlation: () => rpcRejected(transientCode, "conflit transitoire simulé"),
      update_payment_provider_event_processing_status: (_n, args) =>
        simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
    });
    const result = await processClaimedPaymentProviderEvent(claimedEvent());
    assert.equal(result.outcome, "failed_retryable", `${transientCode} DOIT rester réessayable`);
    assert.equal(event.processing_status, "failed_retryable");
    assert.equal(event.retry_count, 1);
  });
}

test("MATRICE [failed_retryable, 40001] -- reste retryable, retry_count incrémenté normalement", async (t) => {
  const event: SimulatedEvent = { processing_status: "failed_retryable", retry_count: 2, claim_token: "claim-token-1" };
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("40001", "conflit transitoire simulé"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ processingStatus: "failed_retryable", retryCount: 2 }));
  assert.equal(result.outcome, "failed_retryable");
  assert.equal(event.retry_count, 3);
});

test("MATRICE [failed_retryable, succès] -- applied, transition RÉELLEMENT acceptée par le simulateur", async (t) => {
  const event: SimulatedEvent = { processing_status: "failed_retryable", retry_count: 2, claim_token: "claim-token-1" };
  routeRpc(t, {
    get_payment_transaction_correlation: CORRELATION_ROW,
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ processingStatus: "failed_retryable", retryCount: 2 }));
  assert.equal(result.outcome, "applied");
  assert.equal(event.processing_status, "applied");
});

test("MATRICE [failed_retryable retryCount=5 (5 échecs déjà comptés), transitoire] -- escalade AUTORITAIRE côté SQL simulé vers failed_terminal dès la 6e tentative ratée (off-by-one exact, mandat §12 : le seuil compare retry_count AVANT incrémentation)", async (t) => {
  const event: SimulatedEvent = { processing_status: "failed_retryable", retry_count: 5, claim_token: "claim-token-1" };
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("40001", "conflit transitoire simulé"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ processingStatus: "failed_retryable", retryCount: 5 }));
  assert.equal(result.outcome, "failed_terminal", "l'escalade SQL (retry_count courant >= 5 AVANT incrémentation) transforme la demande failed_retryable en failed_terminal RÉEL à la 6e tentative ratée");
  assert.equal(event.processing_status, "failed_terminal");
  assert.equal(event.retry_count, 5, "retry_count n'est PLUS incrémenté une fois escaladé en failed_terminal (seul failed_retryable incrémente)");
  // Précision (mandat §12) : à retryCount=5, la défense en profondeur
  // CÔTÉ TS (payment-provider-event-processor.ts, claimed.retryCount
  // >= MAX_RETRY_ATTEMPTS) intercepte DÉJÀ avant tout appel de
  // corrélation -- ce test exerce donc RÉELLEMENT ce chemin
  // court-circuité (résultat identique : failed_terminal, sans
  // gaspiller un appel de corrélation), PAS l'escalade SQL en réponse
  // à un échec transitoire fraîchement survenu. L'escalade SQL PURE
  // (sans le court-circuit TS) est prouvée séparément ci-dessous.
  assert.ok(!calls.some((c) => c.name === "get_payment_transaction_correlation"), "confirme que la défense en profondeur TS a court-circuité, pas l'escalade SQL en réponse à un échec transitoire");
});

test("MATRICE [failed_retryable, ESCALADE SQL PURE isolée de la défense en profondeur TS] -- prouve que l'escalade est portée par la RPC elle-même, pas seulement par le court-circuit côté TS", async (t) => {
  // Isole l'escalade SQL : claimed.retryCount (vu par TS, sous le
  // plafond -- ne déclenche PAS le court-circuit de défense en
  // profondeur) diffère volontairement de event.retry_count (l'état
  // RÉEL simulé côté base, déjà au plafond) -- scénario réaliste d'un
  // worker de reprise dont la vue de claim date d'avant un
  // rattrapage. Prouve que même SANS le court-circuit TS,
  // l'ESCALADE reste portée par la SEULE autorité réelle : la RPC
  // elle-même (comme documenté explicitement dans son propre
  // commentaire SQL : "cette fonction reste la SEULE autorité qui ne
  // peut jamais être contournée par un appelant bogué ou futur").
  const event: SimulatedEvent = { processing_status: "failed_retryable", retry_count: 5, claim_token: "claim-token-1" };
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("40001", "conflit transitoire simulé"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ processingStatus: "failed_retryable", retryCount: 3 }));
  assert.ok(calls.some((c) => c.name === "get_payment_transaction_correlation"), "la défense en profondeur TS (retryCount=3 vu par TS) ne doit PAS avoir court-circuité -- l'appel de corrélation a bien eu lieu");
  assert.equal(result.outcome, "failed_terminal", "l'escalade est portée par la RPC elle-même (event.retry_count RÉEL = 5), indépendamment de la vue TS (claimed.retryCount = 3)");
  assert.equal(event.processing_status, "failed_terminal");
});

test("MATRICE [failed_retryable retryCount=4 (SOUS le plafond), transitoire] -- reste failed_retryable normalement, PAS d'escalade prématurée (preuve de l'exactitude du seuil, mandat §12)", async (t) => {
  const event: SimulatedEvent = { processing_status: "failed_retryable", retry_count: 4, claim_token: "claim-token-1" };
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("40001", "conflit transitoire simulé"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ processingStatus: "failed_retryable", retryCount: 4 }));
  assert.equal(result.outcome, "failed_retryable", "retry_count=4 est ENCORE sous le plafond (4 >= 5 est faux) -- la 5e tentative ratée reste réessayable, incrémentée à 5, jamais escaladée prématurément");
  assert.equal(event.retry_count, 5);
});

test("MATRICE [received, SQLSTATE totalement inconnu] -- classification=retryable PRUDENTE, jamais terminal immédiat sans preuve positive", async (t) => {
  const event: SimulatedEvent = { processing_status: "received", retry_count: 0, claim_token: "claim-token-1" };
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("XX999", "code jamais vu, jamais catalogué"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "failed_retryable");
  assert.equal(event.retry_count, 1);
});

test("finalize() : P0004 (jeton périmé, VRAI conflit de bail) -- 'stale_claim'", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: () => rpcRejected("P0004", "bail expiré"),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "stale_claim");
});

test("finalize() : 42501 (transition réellement refusée) -- 'finalize_rejected_transition', JAMAIS 'stale_claim'", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: () => rpcRejected("42501", "transition non autorisée (simulé)"),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "finalize_rejected_transition");
  assert.notEqual(result.outcome, "stale_claim");
});

test("finalize() : panne de TRANSPORT pendant la finalisation elle-même -- 'finalize_failed_transient', JAMAIS 'stale_claim'", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: () => {
      throw new Error("panne réseau simulée pendant finalize");
    },
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "finalize_failed_transient");
  assert.notEqual(result.outcome, "stale_claim");
});

test("finalize() : SQLSTATE inconnu pendant la finalisation elle-même -- 'finalize_failed_transient'", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => rpcRejected("P0002"),
    update_payment_provider_event_processing_status: () => rpcRejected("XX999", "jamais catalogué"),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent());
  assert.equal(result.outcome, "finalize_failed_transient");
});

test("PREUVE DE RÉGRESSION FERMÉE : received + retryCount>=plafond -- transition received->failed_terminal simulée RÉELLEMENT ACCEPTÉE, plus jamais masquée en stale_claim (P3BV42-TEST-MATRIX-01)", async (t) => {
  const event: SimulatedEvent = { processing_status: "received", retry_count: 5, claim_token: "claim-token-1" };
  const calls = routeRpc(t, {
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(event, args.p_claim_token as string, args.p_new_status as string),
  });
  const result = await processClaimedPaymentProviderEvent(claimedEvent({ retryCount: 5 }));
  assert.equal(result.outcome, "failed_terminal");
  assert.ok(!calls.some((c) => c.name === "get_payment_transaction_correlation"));
  assert.equal(event.processing_status, "failed_terminal");
});
