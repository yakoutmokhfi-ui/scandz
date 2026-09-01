import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.
// Couvre app/api/internal/payments/monetico/recover/route.ts (worker
// de reprise, ferme P3B-V3-ACK-RECOVERY-01, mandat §18) : gating
// d'authentification, revendication par lot + traitement partagé, et
// les scénarios B/C de la matrice de crash (mandat §20) NON couverts
// par v126/v128 (qui exercent exclusivement le chemin SYNCHRONE) :
//   B. enregistrement durable réussi, "crash" AVANT toute
//      revendication -- le worker de reprise revendique et applique
//      plus tard (jamais couvert par le chemin synchrone lui-même).
//   C. revendication réussie, "crash" AVANT la mutation de paiement,
//      expiration du bail, un NOUVEAU worker applique -- prouvé ici
//      directement via processClaimedPaymentProviderEvent (échec
//      transitoire -> failed_retryable -> bail libéré -> nouvelle
//      revendication -> application réussie), le primitif SQL
//      claim_payment_provider_event(s) sous-jacent étant déjà
//      prouvé par le harnais SQL P3-B5/v4 (FOR UPDATE SKIP LOCKED +
//      expiration de bail réelle).
// AUCUNE route ne restant JAMAIS activée/programmée par ce lot
// (mandat §18/§30) -- ce fichier teste le comportement HTTP de la
// route TELLE QU'ELLE EXISTE DANS LE DÉPÔT, jamais son activation.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-route-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/internal/payments/monetico/recover/route.ts");
const { processClaimedPaymentProviderEvent } = await import(
  "../lib/server/payment-provider-event-processor.ts"
);

const SECRET = "recovery-worker-secret-synthetic-DO-NOT-USE";
const HEADER = "x-payment-recovery-worker-secret";

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

function postRecover(headers: Record<string, string> = {}): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", {
    method: "POST",
    headers,
  });
}

async function withSecret<T>(configured: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PAYMENT_RECOVERY_WORKER_SECRET;
  if (configured === undefined) delete process.env.PAYMENT_RECOVERY_WORKER_SECRET;
  else process.env.PAYMENT_RECOVERY_WORKER_SECRET = configured;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_RECOVERY_WORKER_SECRET;
    else process.env.PAYMENT_RECOVERY_WORKER_SECRET = previous;
  }
}

function claimedEventRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    restaurant_id: "resto-1",
    order_id: "order-1",
    payment_transaction_id: "txn-1",
    provider_code: "monetico",
    provider_reference: `ref-${id}`,
    event_fingerprint: `fp-${id}`,
    provider_event_type: "paid",
    provider_event_code: "paiement",
    amount: "25.00",
    currency: "EUR",
    authorization_reference: null,
    processing_status: "received",
    retry_count: 0,
    claim_token: `claim-${id}`,
    claim_expires_at: "2026-08-31T00:01:00Z",
    ...overrides,
  };
}

// --------------------------------------------------------------
// GATING D'AUTHENTIFICATION -- fail-closed, AUCUN appel RPC en cas de
// refus (mandat §18 : "no public unauthenticated trigger").
// --------------------------------------------------------------

test("secret serveur NON configuré -- 503, AUCUN appel RPC, jamais un worker 'ouvert par défaut'", async (t) =>
  withSecret(undefined, async () => {
    const calls = routeRpc(t, {});
    const res = await POST(postRecover({ [HEADER]: "anything" }));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  }));

test("en-tête ABSENT -- 503, AUCUN appel RPC", async (t) =>
  withSecret(SECRET, async () => {
    const calls = routeRpc(t, {});
    const res = await POST(postRecover({}));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  }));

test("en-tête INCORRECT -- 503, AUCUN appel RPC", async (t) =>
  withSecret(SECRET, async () => {
    const calls = routeRpc(t, {});
    const res = await POST(postRecover({ [HEADER]: "wrong-secret-DO-NOT-USE" }));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  }));

test("en-tête CORRECT -- autorisé, claim_payment_provider_events appelée", async (t) =>
  withSecret(SECRET, async () => {
    const calls = routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
    const res = await POST(postRecover({ [HEADER]: SECRET }));
    assert.equal(res.status, 200);
    assert.ok(calls.some((c) => c.name === "claim_payment_provider_events"));
  }));

// --------------------------------------------------------------
// AUCUN SECRET DANS L'URL -- l'authentification passe EXCLUSIVEMENT
// par l'en-tête (mandat §18 : "no secrets in URL").
// --------------------------------------------------------------

test("un secret placé en paramètre de requête (jamais en-tête) reste 503 -- SEUL l'en-tête est consulté", async (t) =>
  withSecret(SECRET, async () => {
    const calls = routeRpc(t, {});
    const req = new NextRequest(
      `https://checkout.example.test/api/internal/payments/monetico/recover?secret=${encodeURIComponent(SECRET)}`,
      { method: "POST" }
    );
    const res = await POST(req);
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  }));

// --------------------------------------------------------------
// LOT VIDE -- rien à revendiquer, résultat normal, jamais une erreur.
// --------------------------------------------------------------

test("lot vide (rien d'éligible) -- 200, claimed=0", async (t) =>
  withSecret(SECRET, async () => {
    routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
    const res = await POST(postRecover({ [HEADER]: SECRET }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outcome, "ok");
    assert.equal(body.claimed, 0);
  }));

// --------------------------------------------------------------
// PANNE RPC PENDANT LA REVENDICATION -- 502, jamais un crash HTTP 500.
// --------------------------------------------------------------

test("panne RPC pendant claim_payment_provider_events -- 502 propre, jamais une exception non rattrapée", async (t) =>
  withSecret(SECRET, async () => {
    routeRpc(t, {
      claim_payment_provider_events: () => {
        throw new Error("panne transitoire simulée");
      },
    });
    const res = await POST(postRecover({ [HEADER]: SECRET }));
    assert.equal(res.status, 502);
  }));

// --------------------------------------------------------------
// LOT NON VIDE -- traitement PARTAGÉ (processClaimedPaymentProviderEvent,
// MÊME fonction que le chemin synchrone, mandat §17) appliqué à
// chaque évènement revendiqué ; comptage exact par issue.
// --------------------------------------------------------------

test("lot de 2 évènements paid éligibles -- traités via le processeur PARTAGÉ, tous deux 'applied', confirm_payment_attempt appelée 2 fois", async (t) =>
  withSecret(SECRET, async () => {
    let confirmCalls = 0;
    routeRpc(t, {
      claim_payment_provider_events: () => ({
        data: [claimedEventRow("evt-r1"), claimedEventRow("evt-r2")],
        error: null,
      }),
      get_payment_transaction_correlation: () =>
        ok({
          restaurant_id: "resto-1",
          order_id: "order-1",
          transaction_id: "txn-1",
          status: "pending",
          amount: "25.00",
          currency: "EUR",
        }),
      update_payment_provider_event_processing_status: () =>
        ok({ id: "evt-r1", processing_status: "applied", retry_count: 0, processed_at: "2026-08-31T00:00:00Z" }),
      confirm_payment_attempt: () => {
        confirmCalls += 1;
        return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
      },
    });
    const res = await POST(postRecover({ [HEADER]: SECRET }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.claimed, 2);
    assert.equal(body.applied, 2);
    assert.equal(confirmCalls, 2);
  }));

test("évènement refused dans le lot -- 'ignored', confirm_payment_attempt JAMAIS appelée pour lui", async (t) =>
  withSecret(SECRET, async () => {
    let confirmCalls = 0;
    routeRpc(t, {
      claim_payment_provider_events: () => ({
        data: [claimedEventRow("evt-refused", { provider_event_type: "refused", amount: null, currency: null })],
        error: null,
      }),
      update_payment_provider_event_processing_status: () =>
        ok({ id: "evt-refused", processing_status: "ignored", retry_count: 0, processed_at: "2026-08-31T00:00:00Z" }),
      confirm_payment_attempt: () => {
        confirmCalls += 1;
        return ok({});
      },
    });
    const res = await POST(postRecover({ [HEADER]: SECRET }));
    const body = await res.json();
    assert.equal(body.ignored, 1);
    assert.equal(confirmCalls, 0);
  }));

// ====================================================================
// MATRICE DE CRASH (mandat §20) -- scénarios B et C, NON couverts par
// v126/v128 (chemin synchrone uniquement).
// ====================================================================

// --------------------------------------------------------------
// B. Enregistrement durable réussi, "crash" AVANT toute revendication
// (le processus qui vient de traiter le callback s'arrête net avant
// même d'appeler claimPaymentProviderEventById -- jamais observable
// directement à ce niveau, mais son EFFET est un évènement
// `processing_status='received'` orphelin) -- le worker de reprise le
// revendique et l'applique PLUS TARD, sans jamais dépendre du
// processus d'origine.
// --------------------------------------------------------------

test("SCÉNARIO B : évènement 'received' orphelin (crash simulé avant toute revendication synchrone) -- le worker de reprise le revendique et l'applique correctement", async (t) =>
  withSecret(SECRET, async () => {
    routeRpc(t, {
      claim_payment_provider_events: () => ({ data: [claimedEventRow("evt-orphan-b")], error: null }),
      get_payment_transaction_correlation: () =>
        ok({
          restaurant_id: "resto-1",
          order_id: "order-1",
          transaction_id: "txn-1",
          status: "pending",
          amount: "25.00",
          currency: "EUR",
        }),
      update_payment_provider_event_processing_status: () =>
        ok({ id: "evt-orphan-b", processing_status: "applied", retry_count: 0, processed_at: "2026-08-31T00:00:00Z" }),
      confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
    });
    const res = await POST(postRecover({ [HEADER]: SECRET }));
    const body = await res.json();
    assert.equal(body.claimed, 1);
    assert.equal(body.applied, 1);
  }));

// --------------------------------------------------------------
// C. Revendication réussie, "crash" AVANT la mutation de paiement
// (confirm_payment_attempt échoue -- panne transitoire simulée),
// expiration du bail (simulée : le SECOND appel du même processeur
// représente un NOUVEAU worker ayant re-revendiqué après expiration
// -- la garantie d'unicité elle-même, via claim_token, est prouvée
// séparément par le harnais SQL P3-B5 v2 / P3-B MONETICO CHECKOUT
// RUNTIME v4, section [4bis], FOR UPDATE SKIP LOCKED + expiration
// réelle) -- le NOUVEAU worker applique correctement, sans double
// application.
// --------------------------------------------------------------

test("SCÉNARIO C : 1re revendication -- confirm_payment_attempt échoue (panne transitoire) -> failed_retryable, bail libéré (finalize appelée) ; 2e revendication (nouveau worker, aucun état partagé entre les deux appels) -> applique avec succès", async (t) => {
  let confirmAttempt = 0;
  const finalizeCalls: string[] = [];
  const client2Handlers = {
    get_payment_transaction_correlation: () =>
      ok({
        restaurant_id: "resto-1",
        order_id: "order-1",
        transaction_id: "txn-1",
        status: "pending",
        amount: "25.00",
        currency: "EUR",
      }),
    update_payment_provider_event_processing_status: (_n: string, args: Record<string, unknown>) => {
      finalizeCalls.push(String(args.p_new_status));
      return ok({
        id: "evt-crash-c",
        processing_status: args.p_new_status,
        retry_count: confirmAttempt,
        processed_at: "2026-08-31T00:00:00Z",
      });
    },
    confirm_payment_attempt: () => {
      confirmAttempt += 1;
      if (confirmAttempt === 1) {
        // "crash"/panne transitoire simulée -- représente le worker
        // qui s'arrête / échoue AVANT que la mutation de paiement
        // n'aboutisse.
        throw new Error("panne transitoire simulée pendant confirm_payment_attempt");
      }
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  };
  routeRpc(t, client2Handlers);

  const claimedEventFirstWorker = {
    id: "evt-crash-c",
    restaurantId: "resto-1",
    orderId: "order-1",
    paymentTransactionId: "txn-1",
    providerCode: "monetico",
    providerReference: "ref-evt-crash-c",
    eventFingerprint: "fp-evt-crash-c",
    providerEventType: "paid" as const,
    providerEventCode: "paiement",
    amount: "25.00",
    currency: "EUR",
    authorizationReference: null,
    processingStatus: "received",
    retryCount: 0,
    claimToken: "claim-token-worker-1",
    claimExpiresAt: "2026-08-31T00:01:00Z",
  };
  const firstResult = await processClaimedPaymentProviderEvent(claimedEventFirstWorker);
  assert.equal(firstResult.outcome, "failed_retryable");
  assert.deepEqual(finalizeCalls, ["failed_retryable"]);

  // NOUVEAU worker -- bail expiré côté SQL entre-temps (prouvé
  // séparément par le harnais SQL, section [4bis]) -- représenté ici
  // par un DEUXIÈME claim_token INDÉPENDANT (aucun état partagé avec
  // le premier appel).
  const claimedEventSecondWorker = { ...claimedEventFirstWorker, claimToken: "claim-token-worker-2" };
  const secondResult = await processClaimedPaymentProviderEvent(claimedEventSecondWorker);
  assert.equal(secondResult.outcome, "applied");
  assert.deepEqual(finalizeCalls, ["failed_retryable", "applied"]);
  assert.equal(confirmAttempt, 2);
});
