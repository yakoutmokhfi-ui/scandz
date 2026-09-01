import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.3 — CONVERGENCE (mandat
// §9) et RÉGRESSION DE FAMINE (mandat §13).
//
// LIMITATION HONNÊTE (mandat §15, identique à v133) : PostgreSQL
// indisponible dans cet environnement -- simulateur en mémoire
// répliquant fidèlement le contrat SQL lu, jamais une exécution SQL
// réelle. Voir SQL-HARNESS-REPORT.txt.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-v43-convergence-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/internal/payments/monetico/recover/route.ts");

const SECRET = "recovery-worker-secret-convergence-synthetic-DO-NOT-USE";
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
const rpcRejected = (code: string, message = "simulated") => ({ data: null, error: { code, message } });

function postRecover(): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", {
    method: "POST",
    headers: { [HEADER]: SECRET },
  });
}

async function withSecret<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PAYMENT_RECOVERY_WORKER_SECRET;
  process.env.PAYMENT_RECOVERY_WORKER_SECRET = SECRET;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_RECOVERY_WORKER_SECRET;
    else process.env.PAYMENT_RECOVERY_WORKER_SECRET = previous;
  }
}

interface StoreEvent {
  id: string;
  processing_status: "received" | "applied" | "ignored" | "failed_retryable" | "failed_terminal";
  retry_count: number;
  claim_token: string | null;
  next_attempt_at: number | null;
  provider_event_type: "paid" | "refused";
}

const MAX_RETRY_ATTEMPTS_SQL = 5;
const BACKOFF_SECONDS = [30, 120, 600, 1800];

function simulateClaim(store: Map<string, StoreEvent>, nowMs: number, batchSize: number): StoreEvent[] {
  const eligible = [...store.values()].filter(
    (e) =>
      (e.processing_status === "received" || e.processing_status === "failed_retryable") &&
      e.claim_token === null &&
      (e.next_attempt_at === null || e.next_attempt_at <= nowMs)
  );
  const claimed = eligible.slice(0, batchSize);
  for (const e of claimed) {
    e.claim_token = `token-${e.id}`;
  }
  return claimed;
}

function simulateUpdateStatus(
  store: Map<string, StoreEvent>,
  eventId: string,
  claimToken: string,
  newStatus: string,
  nowMs: number
): { data: unknown; error: { code: string; message: string } | null } {
  const event = store.get(eventId);
  if (!event) return { data: null, error: { code: "P0002", message: "évènement introuvable" } };
  if (event.claim_token !== claimToken) {
    return { data: null, error: { code: "P0004", message: "jeton invalide ou bail expiré" } };
  }
  if (["applied", "ignored", "failed_terminal"].includes(event.processing_status)) {
    return { data: null, error: { code: "42501", message: "évènement déjà terminal" } };
  }
  const allowedFromReceived = ["applied", "ignored", "failed_retryable", "failed_terminal"];
  const allowedFromFailedRetryable = ["applied", "failed_retryable", "failed_terminal"];
  if (event.processing_status === "received" && !allowedFromReceived.includes(newStatus)) {
    return { data: null, error: { code: "42501", message: "transition non autorisée" } };
  }
  if (event.processing_status === "failed_retryable" && !allowedFromFailedRetryable.includes(newStatus)) {
    return { data: null, error: { code: "42501", message: "transition non autorisée" } };
  }

  let effectiveStatus = newStatus;
  if (newStatus === "failed_retryable" && event.retry_count >= MAX_RETRY_ATTEMPTS_SQL) {
    effectiveStatus = "failed_terminal";
  }
  const newRetryCount = effectiveStatus === "failed_retryable" ? event.retry_count + 1 : event.retry_count;
  event.processing_status = effectiveStatus as StoreEvent["processing_status"];
  event.retry_count = newRetryCount;
  event.claim_token = null;
  event.next_attempt_at =
    effectiveStatus === "failed_retryable"
      ? nowMs + BACKOFF_SECONDS[Math.min(newRetryCount - 1, BACKOFF_SECONDS.length - 1)] * 1000
      : null;

  return {
    data: [{ id: event.id, processing_status: effectiveStatus, retry_count: newRetryCount, processed_at: new Date(nowMs).toISOString() }],
    error: null,
  };
}

function claimRow(e: StoreEvent) {
  return {
    id: e.id,
    restaurant_id: "resto-1",
    order_id: `order-${e.id}`,
    payment_transaction_id: `txn-${e.id}`,
    provider_code: "monetico",
    provider_reference: `ref-${e.id}`,
    event_fingerprint: `fp-${e.id}`,
    provider_event_type: e.provider_event_type,
    provider_event_code: "paiement",
    amount: "25.00",
    currency: "EUR",
    authorization_reference: null,
    processing_status: e.processing_status,
    retry_count: e.retry_count,
    claim_token: e.claim_token,
    claim_expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}

test("CONVERGENCE (mandat §9) : paid -> 40001 -> next_attempt_at futur -> non revendicable -> devient éligible -> succès -> applied UNE SEULE FOIS", async (t) => {
  const store = new Map<string, StoreEvent>();
  store.set("evt-conv", { id: "evt-conv", processing_status: "received", retry_count: 0, claim_token: null, next_attempt_at: null, provider_event_type: "paid" });

  let nowMs = 1_000_000_000_000;
  let confirmCallCount = 0;
  let correlationAttemptCount = 0;

  function reconfigure() {
    routeRpc(t, {
      claim_payment_provider_events: () => {
        const claimed = simulateClaim(store, nowMs, 20);
        return { data: claimed.map(claimRow), error: null };
      },
      get_payment_transaction_correlation: () => {
        correlationAttemptCount += 1;
        return correlationAttemptCount === 1
          ? rpcRejected("40001", "conflit de sérialisation simulé")
          : ok({ restaurant_id: "resto-1", order_id: "order-evt-conv", transaction_id: "txn-evt-conv", status: "pending", amount: "25.00", currency: "EUR" });
      },
      confirm_payment_attempt: () => {
        confirmCallCount += 1;
        return ok({ transaction_id: "txn-evt-conv", order_id: "order-evt-conv", status: "paid" });
      },
      update_payment_provider_event_processing_status: (_n, args) =>
        simulateUpdateStatus(store, "evt-conv", args.p_claim_token as string, args.p_new_status as string, nowMs),
    });
  }

  reconfigure();
  const res1 = await withSecret(() => POST(postRecover()));
  const body1 = await res1.json();
  assert.equal(body1.claimed, 1);
  assert.equal(body1.failedRetryable, 1, "40001 doit rester réessayable, jamais terminal");
  const evt = store.get("evt-conv")!;
  assert.equal(evt.processing_status, "failed_retryable");
  assert.equal(evt.retry_count, 1);
  assert.ok(evt.next_attempt_at !== null && evt.next_attempt_at > nowMs, "next_attempt_at doit être dans le futur");

  reconfigure();
  const res2 = await withSecret(() => POST(postRecover()));
  const body2 = await res2.json();
  assert.equal(body2.claimed, 0, "ne doit PAS être revendicable avant next_attempt_at");

  nowMs = evt.next_attempt_at! + 1000;

  reconfigure();
  const res3 = await withSecret(() => POST(postRecover()));
  const body3 = await res3.json();
  assert.equal(body3.claimed, 1, "devient éligible après next_attempt_at");
  assert.equal(body3.applied, 1);
  assert.equal(store.get("evt-conv")!.processing_status, "applied");
  assert.equal(confirmCallCount, 1, "confirmPaymentAttempt appelé UNE SEULE FOIS -- aucune double application financière");
});

test("CONVERGENCE (mandat §9, répétition 40P01) : interblocage détecté -- convergence identique", async (t) => {
  const store = new Map<string, StoreEvent>();
  store.set("evt-conv2", { id: "evt-conv2", processing_status: "received", retry_count: 0, claim_token: null, next_attempt_at: null, provider_event_type: "paid" });
  let nowMs = 2_000_000_000_000;
  let correlationCallCount = 0;

  function reconfigure() {
    routeRpc(t, {
      claim_payment_provider_events: () => {
        const claimed = simulateClaim(store, nowMs, 20);
        return { data: claimed.map(claimRow), error: null };
      },
      get_payment_transaction_correlation: () => {
        correlationCallCount += 1;
        return correlationCallCount === 1
          ? rpcRejected("40P01", "interblocage simulé")
          : ok({ restaurant_id: "resto-1", order_id: "order-evt-conv2", transaction_id: "txn-evt-conv2", status: "pending", amount: "25.00", currency: "EUR" });
      },
      confirm_payment_attempt: () => ok({ transaction_id: "txn-evt-conv2", order_id: "order-evt-conv2", status: "paid" }),
      update_payment_provider_event_processing_status: (_n, args) =>
        simulateUpdateStatus(store, "evt-conv2", args.p_claim_token as string, args.p_new_status as string, nowMs),
    });
  }

  reconfigure();
  const res1 = await withSecret(() => POST(postRecover()));
  assert.equal((await res1.json()).failedRetryable, 1);

  const evt = store.get("evt-conv2")!;
  nowMs = evt.next_attempt_at! + 1000;

  reconfigure();
  const res2 = await withSecret(() => POST(postRecover()));
  const body2 = await res2.json();
  assert.equal(body2.applied, 1);
  assert.equal(store.get("evt-conv2")!.processing_status, "applied");
});

test("RÉGRESSION DE FAMINE (mandat §13) : 20 évènements poison/transitoires + 1 paid légitime -- aucune monopolisation du batch", async (t) => {
  const store = new Map<string, StoreEvent>();
  const nowMs = 3_000_000_000_000;

  for (let i = 0; i < 15; i++) {
    store.set(`poison-terminal-${i}`, {
      id: `poison-terminal-${i}`,
      processing_status: "failed_terminal",
      retry_count: 5,
      claim_token: null,
      next_attempt_at: null,
      provider_event_type: "refused",
    });
  }
  for (let i = 0; i < 5; i++) {
    store.set(`poison-future-${i}`, {
      id: `poison-future-${i}`,
      processing_status: "failed_retryable",
      retry_count: 2,
      claim_token: null,
      next_attempt_at: nowMs + 600_000,
      provider_event_type: "refused",
    });
  }
  store.set("legit-paid", {
    id: "legit-paid",
    processing_status: "received",
    retry_count: 0,
    claim_token: null,
    next_attempt_at: null,
    provider_event_type: "paid",
  });

  routeRpc(t, {
    claim_payment_provider_events: () => {
      const claimed = simulateClaim(store, nowMs, 20);
      return { data: claimed.map(claimRow), error: null };
    },
    get_payment_transaction_correlation: () =>
      ok({ restaurant_id: "resto-1", order_id: "order-legit-paid", transaction_id: "txn-legit-paid", status: "pending", amount: "25.00", currency: "EUR" }),
    confirm_payment_attempt: () => ok({ transaction_id: "txn-legit-paid", order_id: "order-legit-paid", status: "paid" }),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(store, args.p_event_id as string, args.p_claim_token as string, args.p_new_status as string, nowMs),
  });

  const res = await withSecret(() => POST(postRecover()));
  const body = await res.json();

  assert.equal(body.claimed, 1, "seul l'évènement éligible doit être revendiqué -- aucune monopolisation par les évènements poison");
  assert.equal(body.applied, 1);
  assert.equal(store.get("legit-paid")!.processing_status, "applied");

  for (let i = 0; i < 15; i++) {
    assert.equal(store.get(`poison-terminal-${i}`)!.processing_status, "failed_terminal");
  }
  for (let i = 0; i < 5; i++) {
    assert.equal(store.get(`poison-future-${i}`)!.claim_token, null, "un évènement dont next_attempt_at est futur ne doit jamais être revendiqué avant son heure");
  }
});

test("RÉGRESSION DE FAMINE -- reproduction exacte de l'ancien défaut : received + erreur déterministe ne boucle plus après expiration du bail (P3BV42-TEST-MATRIX-01)", async (t) => {
  const store = new Map<string, StoreEvent>();
  const nowMs = 4_000_000_000_000;
  store.set("evt-old-defect", { id: "evt-old-defect", processing_status: "received", retry_count: 0, claim_token: null, next_attempt_at: null, provider_event_type: "paid" });

  routeRpc(t, {
    claim_payment_provider_events: () => {
      const claimed = simulateClaim(store, nowMs, 20);
      return { data: claimed.map(claimRow), error: null };
    },
    get_payment_transaction_correlation: () => rpcRejected("P0002", "corrélation impossible -- déterministe"),
    update_payment_provider_event_processing_status: (_n, args) =>
      simulateUpdateStatus(store, "evt-old-defect", args.p_claim_token as string, args.p_new_status as string, nowMs),
  });

  const res = await withSecret(() => POST(postRecover()));
  const body = await res.json();
  assert.equal(body.failedTerminal, 1, "AVANT ce lot, cette transition était rejetée (42501) et masquée en stale_claim -- désormais failed_terminal directement");
  assert.equal(store.get("evt-old-defect")!.processing_status, "failed_terminal");

  routeRpc(t, {
    claim_payment_provider_events: () => {
      const claimed = simulateClaim(store, nowMs + 100000, 20);
      return { data: claimed.map(claimRow), error: null };
    },
  });
  const res2 = await withSecret(() => POST(postRecover()));
  const body2 = await res2.json();
  assert.equal(body2.claimed, 0, "l'évènement définitivement terminal ne doit plus jamais être revendiqué -- aucune boucle poison");
});
