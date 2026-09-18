import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// N1-A — NOTIFICATION WORKER (NotificationService -> EmailProvider).
// Même discipline de mock que tests/v166-stuart-lot-d2-live-
// activation-gate.test.ts : `t.mock.method(client, "rpc", ...)`,
// jamais un mock de module global. Mandat items 3, 4, 5 (partiel --
// "order remains unchanged" est prouvé côté SQL, ce fichier prouve
// seulement que le worker n'appelle jamais orders/paiement/Stuart),
// 12 ("merchant sender identity resolved correctly").
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "n1a-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");

// CUSTOMER TRACKING v3.1 : le worker émet une capacité de suivi e-mail
// par tentative (issue_order_email_tracking_capability) avant le rendu.
const EMAIL_CAP_ID = "ffffffff-0000-4000-8000-00000000000c";
const EMAIL_SECRET = "c0".repeat(32);

function routeRpc(
  t: { mock: { method: Function } },
  handler: (name: string, args: Record<string, unknown>) => unknown
) {
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    if (name === "issue_order_email_tracking_capability") {
      return { data: [{ capability_id: EMAIL_CAP_ID, capability_secret: EMAIL_SECRET }], error: null };
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
// Scénario 3 : worker processes event -> fake provider called once.
// --------------------------------------------------------------
test("scénario 3 : une notification réclamée -> le provider Fake est appelé exactement une fois", async (t) => {
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);

  assert.equal(provider.callCountForAssertions, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(provider.sent[0].to, "client@example.com");
  assert.equal(provider.sent[0].from, "commandes@aulaitcru.example");
  assert.equal(provider.sent[0].replyTo, "reply@aulaitcru.example");
  assert.equal((completeArgs as any).p_result, "success");
  assert.equal((completeArgs as any).p_attempt_number, 1);
});

// --------------------------------------------------------------
// Scénario 12 : merchant sender identity resolved correctly.
// --------------------------------------------------------------
test("scénario 12 : l'identité d'expéditeur du message envoyé correspond EXACTEMENT à celle résolue par claim_pending_notifications", async (t) => {
  routeRpc(t, (name) => {
    if (name === "claim_pending_notifications") {
      return {
        data: [claimRow({ sender_name: "Sanaa Cookies", sender_email: "hello@sanaa.example", reply_to: null })],
        error: null,
      };
    }
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);

  assert.equal(provider.sent[0].from, "hello@sanaa.example");
  assert.equal(provider.sent[0].replyTo, null);
  assert.match(provider.sent[0].subject, /Sanaa Cookies/);
});

// --------------------------------------------------------------
// Scénario 4 : retryable provider failure -> attempt logged, event
// rescheduled (le calcul du barème est vérifié côté SQL harness --
// ce test vérifie seulement que le worker transmet fidèlement la
// classification du provider).
// --------------------------------------------------------------
test("scénario 4 : échec réessayable du provider -> complete_notification_attempt reçoit result=retryable_failure", async (t) => {
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" }));
  const result = await processPendingNotifications(provider);

  assert.equal(result.retriedRetryable, 1);
  assert.equal((completeArgs as any).p_result, "retryable_failure");
  assert.equal((completeArgs as any).p_error_class, "PROVIDER_TIMEOUT");
});

// --------------------------------------------------------------
// Scénario 5 : terminal provider failure -> terminal failed state,
// worker never touches orders/payment/Stuart (aucune RPC autre que
// claim/complete n'est jamais appelée -- mandat §"NO BUSINESS
// COUPLING").
// --------------------------------------------------------------
test("scénario 5 : échec terminal du provider -> result=terminal_failure, aucune RPC métier appelée", async (t) => {
  const calledRpcNames: string[] = [];
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    calledRpcNames.push(name);
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: false, errorClass: "INVALID_RECIPIENT" }));
  const result = await processPendingNotifications(provider);

  assert.equal(result.failedTerminal, 1);
  assert.equal((completeArgs as any).p_result, "terminal_failure");
  // issue_order_email_tracking_capability est routée par routeRpc (hors
  // `handler`) : seule écriture autorisée, une capacité de suivi.
  assert.deepEqual(calledRpcNames.sort(), ["claim_pending_notifications", "complete_notification_attempt"]);
});

// --------------------------------------------------------------
// Identité d'expéditeur non résolue (profil supprimé/désactivé après
// claim) -> échec terminal défensif, JAMAIS un envoi avec une valeur
// devinée/vide.
// --------------------------------------------------------------
test("identité d'expéditeur non résolue -> échec terminal SENDER_IDENTITY_UNRESOLVED, provider jamais appelé", async (t) => {
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    if (name === "claim_pending_notifications") {
      return { data: [claimRow({ sender_email: null, sender_name: null })], error: null };
    }
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);

  assert.equal(provider.callCountForAssertions, 0);
  assert.equal(result.failedTerminal, 1);
  assert.equal((completeArgs as any).p_error_class, "SENDER_IDENTITY_UNRESOLVED");
});

// --------------------------------------------------------------
// Mandat "no tracking secret in logs/error fields" : la classification
// d'erreur transmise à complete_notification_attempt ne contient
// JAMAIS l'URL/le jeton de suivi, même si le provider Fake est
// configuré pour "fuiter" une erreur verbeuse -- le worker ne relaie
// QUE errorClass (déjà normalisé par l'appelant), jamais le corps du
// message envoyé.
// --------------------------------------------------------------
test("no tracking secret leak : errorClass transmis ne contient jamais le jeton de possession de la commande", async (t) => {
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" }));
  await processPendingNotifications(provider);

  const publicToken = "dddddddd-0000-4000-8000-000000000001";
  assert.doesNotMatch(String((completeArgs as any).p_error_class), new RegExp(publicToken));
});

// --------------------------------------------------------------
// v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 : preuve END-TO-END
// (pas seulement unitaire sur normalizeNotificationErrorCode, voir
// v1-n1a-notification-error-taxonomy.test.ts) -- si un provider
// (même un futur provider réel mal élevé) renvoie un errorClass
// contenant un jeton/secret/diagnostic verbeux, ce que reçoit
// RÉELLEMENT complete_notification_attempt (p_error_class) est
// TOUJOURS un membre exact de la taxonomie fermée, jamais la valeur
// brute.
// --------------------------------------------------------------
test("v1.2 adversarial (pipeline complet) : un errorClass provider contenant un jeton de suivi devient UNKNOWN_PROVIDER_ERROR avant complete_notification_attempt", async (t) => {
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const leakedToken = "dddddddd-0000-4000-8000-000000000001";
  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: leakedToken }));
  await processPendingNotifications(provider);

  assert.equal((completeArgs as any).p_error_class, "UNKNOWN_PROVIDER_ERROR");
  assert.notEqual((completeArgs as any).p_error_class, leakedToken);
});

test("v1.2 adversarial (pipeline complet) : un errorClass provider verbeux/multi-lignes contenant une clé API devient UNKNOWN_PROVIDER_ERROR", async (t) => {
  let completeArgs: Record<string, unknown> | null = null;
  routeRpc(t, (name, args) => {
    if (name === "claim_pending_notifications") return { data: [claimRow()], error: null };
    if (name === "complete_notification_attempt") {
      completeArgs = args;
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const verboseLeak = "Authentication failed:\nkey=sk_test_example_secret_value\nRetry-After: 30";
  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: false, errorClass: verboseLeak }));
  await processPendingNotifications(provider);

  assert.equal((completeArgs as any).p_error_class, "UNKNOWN_PROVIDER_ERROR");
  assert.doesNotMatch(String((completeArgs as any).p_error_class), /sk_test_example_secret_value/);
  assert.doesNotMatch(String((completeArgs as any).p_error_class), /\n/);
});
