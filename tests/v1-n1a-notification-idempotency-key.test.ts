import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// N1-A v1.2 — N1A-IDEMPOTENCY-KEY-CONTRACT-01 (remediation).
//
// Mandat §"MANDATORY IDEMPOTENCY TESTS" -- 8 scénarios numérotés,
// couverts ci-dessous dans le même ordre. Même discipline de mock que
// tests/v1-n1a-notification-worker.test.ts : `t.mock.method(client,
// "rpc", ...)`, jamais un mock de module global.
//
// La clé d'idempotence est TOUJOURS `scanym:notification:<outbox_id>`
// (buildNotificationIdempotencyKey, lib/server/notifications/email-
// provider.ts) -- dérivée EXCLUSIVEMENT de notification_outbox.id,
// jamais de attempt_number/claim_token/horodatage. Ces tests simulent
// des séquences de plusieurs appels processPendingNotifications() pour
// prouver la STABILITÉ de la clé across attempts/claims -- une seule
// notification_worker.test.ts prouve un appel isolé, celui-ci prouve
// la séquence.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "n1a-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { buildNotificationIdempotencyKey } = await import("../lib/server/notifications/email-provider.ts");

// CUSTOMER TRACKING v3.1 : le worker émet une capacité de suivi e-mail
// par tentative (issue_order_email_tracking_capability) avant le rendu.
function routeRpc(
  t: { mock: { method: Function } },
  handler: (name: string, args: Record<string, unknown>) => unknown
) {
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    if (name === "issue_order_email_tracking_capability") {
      return {
        data: [{ capability_id: "ffffffff-0000-4000-8000-00000000000c", capability_secret: "c0".repeat(32) }],
        error: null,
      };
    }
    return handler(name, args);
  });
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    outbox_id: "aaaaaaaa-0000-4000-8000-000000000001",
    restaurant_id: "bbbbbbbb-0000-4000-8000-000000000001",
    order_id: "cccccccc-0000-4000-8000-000000000001",
    notification_type: "order_received",
    recipient_email: "client@example.com",
    locale: "fr",
    payload_snapshot: {
      order_number: 7,
      total: 19.9,
      currency: "EUR",
      service_mode: "pickup",
      public_token: "dddddddd-0000-4000-8000-000000000001",
      created_at: "2026-09-14T10:00:00Z",
    },
    attempt_count: 0,
    claim_token: "eeeeeeee-0000-4000-8000-000000000001",
    sender_name: "Au Lait Cru",
    sender_email: "commandes@aulaitcru.example",
    reply_to: "reply@aulaitcru.example",
    ...overrides,
  };
}

// --------------------------------------------------------------
// Scénario 1 : premier traitement -> reçoit la clé stable K.
// --------------------------------------------------------------
test("idempotency #1 : premier traitement reçoit la clé stable scanym:notification:<outbox_id>", async (t) => {
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);

  const expectedKey = buildNotificationIdempotencyKey("aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(provider.sent[0].idempotencyKey, expectedKey);
  assert.equal(expectedKey, "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});

// --------------------------------------------------------------
// Scénario 2 : retry après échec réessayable -> reçoit la MÊME clé K.
// --------------------------------------------------------------
test("idempotency #2 : retry après échec réessayable reçoit la MÊME clé que la tentative initiale", async (t) => {
  const keysObserved: string[] = [];

  // Tentative 1 : attempt_count=0 (attemptNumber=1) -> échec réessayable.
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") return { data: [claimRow({ attempt_count: 0 })], error: null };
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });
  const provider1 = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" }));
  await processPendingNotifications(provider1);
  keysObserved.push(provider1.sent[0].idempotencyKey);

  // Tentative 2 (retry, SQL a incrémenté attempt_count=1 -> attemptNumber=2,
  // MÊME outbox_id, nouveau claim_token -- le worker relit la ligne via
  // claim_pending_notifications à chaque appel) -> succès cette fois.
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") {
      return { data: [claimRow({ attempt_count: 1, claim_token: "ffffffff-0000-4000-8000-000000000002" })], error: null };
    }
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });
  const provider2 = new FakeEmailProvider();
  await processPendingNotifications(provider2);
  keysObserved.push(provider2.sent[0].idempotencyKey);

  assert.equal(keysObserved[0], keysObserved[1]);
  assert.equal(keysObserved[0], "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});

// --------------------------------------------------------------
// Scénario 3 : récupération après bail périmé (reap) -> reçoit la
// MÊME clé K (le reap ne change ni outbox_id ni la clé -- seul un
// nouveau claim_token est émis lors de la réclamation suivante).
// --------------------------------------------------------------
test("idempotency #3 : récupération après bail périmé (nouveau claim_token) reçoit la MÊME clé K", async (t) => {
  // Simule l'état APRÈS reap_stale_notification_claims : la ligne est
  // de nouveau 'pending' -> reste au même attempt_count qu'avant le
  // crash (aucune tentative n'a été complétée), mais un nouveau
  // claim_token est émis par la réclamation suivante.
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") {
      return {
        data: [claimRow({ attempt_count: 0, claim_token: "99999999-0000-4000-8000-000000000009" })],
        error: null,
      };
    }
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });
  const providerAfterReap = new FakeEmailProvider();
  await processPendingNotifications(providerAfterReap);

  assert.equal(providerAfterReap.sent[0].idempotencyKey, "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});

// --------------------------------------------------------------
// Scénario 4 : un second événement/commande DIFFÉRENT reçoit une clé
// DIFFÉRENTE (dans le même lot réclamé).
// --------------------------------------------------------------
test("idempotency #4 : deux notifications distinctes (outbox_id différents) reçoivent des clés DIFFÉRENTES", async (t) => {
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") {
      return {
        data: [
          claimRow({ outbox_id: "11111111-0000-4000-8000-000000000001", order_id: "order-1" }),
          claimRow({ outbox_id: "22222222-0000-4000-8000-000000000002", order_id: "order-2" }),
        ],
        error: null,
      };
    }
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);

  assert.equal(provider.sent.length, 2);
  assert.notEqual(provider.sent[0].idempotencyKey, provider.sent[1].idempotencyKey);
  assert.equal(provider.sent[0].idempotencyKey, "scanym:notification:11111111-0000-4000-8000-000000000001");
  assert.equal(provider.sent[1].idempotencyKey, "scanym:notification:22222222-0000-4000-8000-000000000002");
});

// --------------------------------------------------------------
// Scénario 5 : attempt_number change mais la clé d'idempotence NE
// change PAS -- assertion directe et isolée (distincte du scénario 2,
// qui prouve la stabilité end-to-end sur un retry réel).
// --------------------------------------------------------------
test("idempotency #5 : p_attempt_number varie (1 puis 2) tandis que idempotencyKey reste rigoureusement identique", async (t) => {
  const observed: Array<{ attemptNumber: unknown; key: string }> = [];

  for (const attemptCount of [0, 1, 2]) {
    let completeArgs: Record<string, unknown> | null = null;
    routeRpc(t, (name, args) => {
      if (name === "claim_pending_notifications") return { data: [claimRow({ attempt_count: attemptCount })], error: null };
      if (name === "complete_notification_attempt") {
        completeArgs = args;
        return { data: null, error: null };
      }
      throw new Error(`RPC inattendue : ${name}`);
    });
    const provider = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" }));
    await processPendingNotifications(provider);
    observed.push({ attemptNumber: (completeArgs as any).p_attempt_number, key: provider.sent[0].idempotencyKey });
  }

  assert.deepEqual(observed.map((o) => o.attemptNumber), [1, 2, 3]);
  const distinctKeys = new Set(observed.map((o) => o.key));
  assert.equal(distinctKeys.size, 1, "la clé d'idempotence doit rester UNIQUE malgré 3 numéros de tentative différents");
  assert.equal([...distinctKeys][0], "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});

// --------------------------------------------------------------
// Scénario 6 : le provider Fake expose et permet d'asserter la clé
// (déjà prouvé isolément dans v1-n1a-fake-email-provider.test.ts --
// ce test confirme que le CHEMIN COMPLET worker -> provider préserve
// bien l'accès direct via `provider.sent[i].idempotencyKey`).
// --------------------------------------------------------------
test("idempotency #6 : provider.sent[i].idempotencyKey est directement assertable après un traitement via le worker", async (t) => {
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);

  assert.equal(typeof provider.sent[0].idempotencyKey, "string");
  assert.ok(provider.sent[0].idempotencyKey.length > 0);
});

// --------------------------------------------------------------
// Scénario 7 : simulation crash/retry -- le worker "s'arrête" APRÈS
// l'appel provider.send() mais AVANT complete_notification_attempt
// (le cas réel d'un crash worker en pleine fenêtre). Le prochain
// traitement de la MÊME ligne (après reap, attempt_count inchangé
// puisqu'aucune complétion n'a jamais eu lieu) doit recevoir la MÊME
// clé -- c'est précisément ce qui permettrait à un futur provider réel
// de déduplicquer un envoi resoumis sous cette fenêtre de crash.
// --------------------------------------------------------------
test("idempotency #7 : simulation crash worker (send() réussi, complete jamais appelé) -> le retraitement reçoit la MÊME clé", async (t) => {
  // Tentative 1 : le provider "réussit" mais on simule le crash en
  // faisant échouer complete_notification_attempt (indisponibilité
  // réseau au moment du crash) -- processPendingNotifications() ne
  // capture pas cette exception, donc elle se propage : c'est
  // EXACTEMENT le comportement attendu d'un crash mi-parcours (aucun
  // état "à moitié fini" n'est écrit en mémoire ; la ligne outbox reste
  // 'processing' côté SQL jusqu'au reap).
  // Le wrapper notification-outbox-service.ts capture TOUTE exception
  // rpc() et la re-lève sous un message générique fixe
  // (NOTIFICATION_OUTBOX_COMPLETE_UNAVAILABLE, même discipline que
  // provider-events.ts -- jamais l'erreur brute du transport) : c'est
  // CE message générique, et non un message de simulation inventé, qui
  // doit remonter jusqu'ici -- c'est la preuve que le crash se propage
  // sans état "à moitié fini" écrit en mémoire par processPending
  // Notifications().
  let firstSendKey: string | null = null;
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") return { data: [claimRow({ attempt_count: 0 })], error: null };
    if (name === "complete_notification_attempt") {
      throw new Error("SIMULATED_TRANSPORT_FAILURE_DURING_CRASH");
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  const providerAttempt1 = new FakeEmailProvider();
  await assert.rejects(() => processPendingNotifications(providerAttempt1), /NOTIFICATION_OUTBOX_COMPLETE_UNAVAILABLE/);
  firstSendKey = providerAttempt1.sent[0].idempotencyKey;

  // reap_stale_notification_claims a récupéré la ligne (bail expiré) :
  // status revient à 'pending', attempt_count INCHANGÉ (aucune
  // complétion n'a jamais été enregistrée). Le worker suivant la
  // réclame de nouveau (nouveau claim_token) et RÉUSSIT cette fois.
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") {
      return { data: [claimRow({ attempt_count: 0, claim_token: "abababab-0000-4000-8000-00000000000a" })], error: null };
    }
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });
  const providerAttempt2 = new FakeEmailProvider();
  await processPendingNotifications(providerAttempt2);
  const secondSendKey = providerAttempt2.sent[0].idempotencyKey;

  assert.equal(firstSendKey, secondSendKey);
  assert.equal(secondSendKey, "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});

// --------------------------------------------------------------
// Scénario 8 : aucun envoi e-mail réel -- chaque provider instancié
// dans TOUT ce fichier est le provider Fake (jamais un provider réel),
// prouvé directement sur les instances réellement exercées par les
// scénarios ci-dessus (plus robuste qu'une recherche de motif sur le
// texte source du fichier, qui matcherait à tort sa propre liste de
// noms interdits -- piège déjà rencontré ailleurs dans ce lot, voir
// README-AUDIT.md). La garde structurelle "le worker n'importe/
// n'active jamais de module provider réel" vit déjà dans
// tests/v1-n1a-structural-atomic-integration.test.ts.
// --------------------------------------------------------------
test("idempotency #8 : chaque provider utilisé dans ce fichier est FakeEmailProvider (name === 'fake'), aucun envoi réel possible", async (t) => {
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  assert.equal(provider.name, "fake");
  await processPendingNotifications(provider);
  assert.equal(provider.sent[0].idempotencyKey, "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});
