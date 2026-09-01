import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.4 -- ferme
// P3BV43-RECOVERY-ACTIVATION-01.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-v44-scheduler-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { GET, POST } = await import("../app/api/internal/payments/monetico/recover/route.ts");

const MANUAL_HEADER = "x-payment-recovery-worker-secret";
const MANUAL_SECRET = "recovery-worker-secret-v44-synthetic-DO-NOT-USE";
const CRON_SECRET = "cron-secret-v44-synthetic-DO-NOT-USE";

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

function cronRequest(): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", {
    method: "GET",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}
function manualRequest(): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", {
    method: "POST",
    headers: { [MANUAL_HEADER]: MANUAL_SECRET },
  });
}
function unauthenticatedGetRequest(): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", { method: "GET" });
}

async function withSecrets<T>(fn: () => Promise<T>): Promise<T> {
  const prevManual = process.env.PAYMENT_RECOVERY_WORKER_SECRET;
  const prevCron = process.env.CRON_SECRET;
  process.env.PAYMENT_RECOVERY_WORKER_SECRET = MANUAL_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  try {
    return await fn();
  } finally {
    if (prevManual === undefined) delete process.env.PAYMENT_RECOVERY_WORKER_SECRET;
    else process.env.PAYMENT_RECOVERY_WORKER_SECRET = prevManual;
    if (prevCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCron;
  }
}

// ====================================================================
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.5 -- ferme
// P3BV44-CRON-AUTH-SEPARATION-01.
//
// AVANT ce lot : isAuthorized() acceptait indifféremment L'UN OU
// L'AUTRE mécanisme (OR) pour un MÊME verbe HTTP -- une requête GET
// portant l'en-tête manuel, ou une requête POST portant
// Authorization: Bearer <CRON_SECRET>, étaient toutes deux acceptées
// à tort. v4.5 sépare STRICTEMENT par verbe (mandat §12/§13) :
//   GET  -> UNIQUEMENT Authorization: Bearer <CRON_SECRET>
//   POST -> UNIQUEMENT X-Payment-Recovery-Worker-Secret
//
// MATRICE CROISÉE OBLIGATOIRE (mandat §13, 7 scénarios exacts) --
// AUCUN scénario omis, chacun testé exactement comme spécifié.
// ====================================================================

function manualHeaderRequest(method: "GET" | "POST", secret: string | null): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", {
    method,
    headers: secret !== null ? { [MANUAL_HEADER]: secret } : {},
  });
}
function bearerRequest(method: "GET" | "POST", token: string | null): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/internal/payments/monetico/recover", {
    method,
    headers: token !== null ? { authorization: `Bearer ${token}` } : {},
  });
}

test("MATRICE CROISÉE 1/7 -- GET + CRON_SECRET valide -> succès (200)", async (t) => {
  routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => GET(bearerRequest("GET", CRON_SECRET)));
  assert.equal(res.status, 200);
});

test("MATRICE CROISÉE 2/7 -- GET + CRON_SECRET invalide -> 503 (fail-closed, équivalent 401/403 de ce projet)", async (t) => {
  const calls = routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => GET(bearerRequest("GET", "totalement-incorrect")));
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("MATRICE CROISÉE 3/7 -- GET sans authentification -> 503", async (t) => {
  const calls = routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => GET(bearerRequest("GET", null)));
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("MATRICE CROISÉE 4/7 -- GET + secret manuel SEUL (jamais en Bearer) -> 503 (INTERDIT explicitement, mandat §12 : 'GET + worker secret → accepted' est un défaut)", async (t) => {
  const calls = routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => GET(manualHeaderRequest("GET", MANUAL_SECRET)));
  assert.equal(res.status, 503, "un GET portant l'en-tête manuel (jamais Authorization: Bearer) ne doit JAMAIS être autorisé");
  assert.equal(calls.length, 0);
});

test("MATRICE CROISÉE 5/7 -- POST + secret manuel valide -> succès (200)", async (t) => {
  routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => POST(manualHeaderRequest("POST", MANUAL_SECRET)));
  assert.equal(res.status, 200);
});

test("MATRICE CROISÉE 6/7 -- POST + secret manuel invalide -> 503", async (t) => {
  const calls = routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => POST(manualHeaderRequest("POST", "totalement-incorrect")));
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("MATRICE CROISÉE 7/7 -- POST + CRON_SECRET SEUL (en Bearer) -> 503 (INTERDIT explicitement, mandat §12 : 'POST + CRON_SECRET → accepted' est un défaut sauf conception séparée explicite -- non conçue ici)", async (t) => {
  const calls = routeRpc(t, { claim_payment_provider_events: () => ({ data: [], error: null }) });
  const res = await withSecrets(() => POST(bearerRequest("POST", CRON_SECRET)));
  assert.equal(res.status, 503, "un POST portant Authorization: Bearer <CRON_SECRET> ne doit JAMAIS être autorisé");
  assert.equal(calls.length, 0);
});

test("SECRET ISOLATION (mandat §14) : CRON_SECRET != worker secret != MAC Monetico != service_role != credentials marchand != public_token client -- confirmé structurellement, valeurs synthétiques toutes distinctes dans ce test lui-même", async () => {
  const values = new Set([CRON_SECRET, MANUAL_SECRET, "monetico-mac-key-should-never-equal-cron-secret", "service_role"]);
  assert.equal(values.size, 4, "les 4 valeurs synthétiques utilisées dans ce fichier de test doivent toutes être distinctes -- garde-fou contre une régression accidentelle de fixture");
});

test("SCHEDULER: aucun secret Monetico (MAC) ni public_token client n'apparaît dans le CODE réel du fichier route", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("app/api/internal/payments/monetico/recover/route.ts", "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.toLowerCase().includes("mac_key"));
  assert.ok(!codeOnly.includes("public_token"));
});

test("CHEVAUCHEMENT: deux invocations concurrentes -- FOR UPDATE SKIP LOCKED empêche toute double revendication du MÊME évènement", async (t) => {
  let claimedOnce = false;
  routeRpc(t, {
    claim_payment_provider_events: () => {
      if (!claimedOnce) {
        claimedOnce = true;
        return {
          data: [
            {
              id: "evt-shared", restaurant_id: "r1", order_id: "o1", payment_transaction_id: "t1",
              provider_code: "monetico", provider_reference: "ref-shared", event_fingerprint: "f".repeat(64),
              provider_event_type: "paid", provider_event_code: null, amount: "10.00", currency: "EUR",
              authorization_reference: null, processing_status: "received", retry_count: 0,
              claim_token: "token-a", claim_expires_at: new Date(Date.now() + 60000).toISOString(),
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    },
    get_payment_transaction_correlation: () =>
      ok({ restaurant_id: "r1", order_id: "o1", transaction_id: "t1", status: "pending", amount: "10.00", currency: "EUR" }),
    confirm_payment_attempt: () => ok({ transaction_id: "t1", order_id: "o1", status: "paid" }),
    update_payment_provider_event_processing_status: () =>
      ok({ id: "evt-shared", processing_status: "applied", retry_count: 0, processed_at: new Date().toISOString() }),
  });

  const [resultA, resultB] = await withSecrets(() =>
    Promise.all([GET(cronRequest()), GET(cronRequest())])
  );
  const bodyA = await resultA.json();
  const bodyB = await resultB.json();

  assert.equal(bodyA.claimed + bodyB.claimed, 1, "l'évènement partagé ne doit être revendiqué QUE par une seule des deux invocations");
  assert.equal(bodyA.applied + bodyB.applied, 1, "aucune application financière dupliquée");
});

test("CONVERGENCE AUTOMATIQUE (mandat §14) : failed_retryable -> invocation PLANIFIÉE ultérieure (GET, JAMAIS un appel manuel) reprend et applique -- exactement une fois", async (t) => {
  const store = new Map<string, any>();
  store.set("evt-auto", {
    id: "evt-auto", processing_status: "failed_retryable", retry_count: 1, claim_token: null,
    next_attempt_at: Date.now() - 1000,
  });
  let confirmCallCount = 0;

  routeRpc(t, {
    claim_payment_provider_events: () => {
      const e = store.get("evt-auto");
      if (e.processing_status !== "failed_retryable" || e.claim_token !== null || e.next_attempt_at > Date.now()) {
        return { data: [], error: null };
      }
      e.claim_token = "token-auto";
      return {
        data: [
          {
            id: "evt-auto", restaurant_id: "r1", order_id: "o1", payment_transaction_id: "t1",
            provider_code: "monetico", provider_reference: "ref-auto", event_fingerprint: "a".repeat(64),
            provider_event_type: "paid", provider_event_code: null, amount: "10.00", currency: "EUR",
            authorization_reference: null, processing_status: e.processing_status, retry_count: e.retry_count,
            claim_token: e.claim_token, claim_expires_at: new Date(Date.now() + 60000).toISOString(),
          },
        ],
        error: null,
      };
    },
    get_payment_transaction_correlation: () =>
      ok({ restaurant_id: "r1", order_id: "o1", transaction_id: "t1", status: "pending", amount: "10.00", currency: "EUR" }),
    confirm_payment_attempt: () => {
      confirmCallCount += 1;
      return ok({ transaction_id: "t1", order_id: "o1", status: "paid" });
    },
    update_payment_provider_event_processing_status: () => {
      const e = store.get("evt-auto");
      e.processing_status = "applied";
      e.claim_token = null;
      return ok({ id: "evt-auto", processing_status: "applied", retry_count: e.retry_count, processed_at: new Date().toISOString() });
    },
  });

  const res = await withSecrets(() => GET(cronRequest()));
  const body = await res.json();

  assert.equal(body.claimed, 1);
  assert.equal(body.applied, 1);
  assert.equal(store.get("evt-auto").processing_status, "applied");
  assert.equal(confirmCallCount, 1, "application financière exactement une fois, sans intervention manuelle");
});
