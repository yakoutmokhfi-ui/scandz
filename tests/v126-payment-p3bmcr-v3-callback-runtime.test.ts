import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.
// Couvre lib/server/payment-callback-runtime.ts::processMoneticoCallback
// après la RESTRUCTURATION v4 (audit de travail v3 indépendant) :
// STAGE A (ingestion, classification MODE-AWARE ferme
// P3B-V3-MODE-ENDPOINT-01) + STAGE B (traitement durable partagé via
// claim/lease, ferme P3B-V3-ACK-RECOVERY-01, payment-provider-event-
// processor.ts). Préserve TOUTES les règles dures v3 (V2-02..V2-05) --
// réécrit pour le nouveau contrat (une lecture `get_payment_runtime_
// provider_environment` supplémentaire en Stage A ; `claim_payment_
// provider_event_by_id` + `update_payment_provider_event_processing_
// status` en Stage B pour le chemin `paid`). MACs RÉELLEMENT calculés
// (jamais simulés).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processMoneticoCallback } = await import("../lib/server/payment-callback-runtime.ts");
const { transformSecurityKey, computeMac } = await import(
  "../lib/server/payment-providers/monetico/mac.ts"
);

const SECURITY_KEY = "0123456789abcdef0123456789abcdef01234567";
const CREDENTIAL_JSON = JSON.stringify({
  tpe: "1234567",
  societe: "p3bmcrsociete",
  securityKey: SECURITY_KEY,
});
const KEY_BUFFER = transformSecurityKey(SECURITY_KEY);

const SUCCESS_ACK = "version=2\ncdr=0\n";
const FAILURE_ACK = "version=2\ncdr=1\n";

function signedCallback(fields: Record<string, string>): Record<string, string> {
  const mac = computeMac(fields, KEY_BUFFER);
  return { ...fields, MAC: mac };
}

type RpcHandler = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

function routeRpc(t: { mock: { method: Function } }, handlers: Record<string, RpcHandler>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`RPC inattendue dans ce scénario de test : ${name}`);
    }
    return handler(name, args);
  });
  return calls;
}

const ok = (row: unknown) => ({ data: [row], error: null });

const BASE_CORRELATION = {
  restaurant_id: "resto-1",
  order_id: "order-1",
  transaction_id: "txn-1",
  status: "pending",
  amount: "25.00",
  currency: "EUR",
};

/** `mode='live'` -- tous les code-retour "paid" de base utilisés par
 *  ce fichier (`paiement`/`paiement_pf2`) sont Production-only (mandat
 *  v4, classifyMoneticoCodeRetourForMode) -- ce fixture reste le mode
 *  par défaut de tout scénario qui atteint Stage A au-delà de la
 *  vérification MAC. */
const LIVE_ENVIRONMENT = () =>
  ok({ provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "live" });
const TEST_ENVIRONMENT = () =>
  ok({ provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" });

function recordedRow(overrides: Record<string, unknown> = {}) {
  return ok({
    id: "evt-1",
    restaurant_id: "resto-1",
    order_id: "order-1",
    payment_transaction_id: "txn-1",
    provider_event_type: "refused",
    processing_status: "received",
    created_at: "2026-08-31T00:00:00Z",
    is_new_event: true,
    ...overrides,
  });
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return ok({
    id: "evt-1",
    restaurant_id: "resto-1",
    order_id: "order-1",
    payment_transaction_id: "txn-1",
    provider_code: "monetico",
    provider_reference: "ref-1",
    event_fingerprint: "f".repeat(64),
    provider_event_type: "paid",
    provider_event_code: "paiement",
    amount: "25.00",
    currency: "EUR",
    authorization_reference: null,
    processing_status: "received",
    retry_count: 0,
    claim_token: "claim-token-1",
    claim_expires_at: "2026-08-31T00:01:00Z",
    ...overrides,
  });
}

const finalizedRow = (status: string) =>
  ok({ id: "evt-1", processing_status: status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" });

// --------------------------------------------------------------
// Structure malformée -- AVANT toute corrélation/MAC.
// --------------------------------------------------------------

test("callback malformé (MAC absent) -- ACK échec, AUCUN appel RPC (ne peut même pas corréler)", async (t) => {
  const calls = routeRpc(t, {});
  const result = await processMoneticoCallback({ reference: "ref-1", "code-retour": "paiement" });
  assert.equal(result.ack, FAILURE_ACK);
  assert.equal(result.outcome, "malformed");
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------
// Référence non corrélée.
// --------------------------------------------------------------

test("référence inconnue (aucune tentative correspondante) -- ACK échec, RIEN enregistré", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ({ data: null, error: null }),
  });
  const raw = signedCallback({ reference: "unknown-ref", "code-retour": "paiement" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, FAILURE_ACK);
  assert.equal(result.outcome, "unrecognized_reference");
  assert.ok(!calls.some((c) => c.name === "record_payment_provider_event"));
});

// --------------------------------------------------------------
// MAC invalide -- AUTORITÉ D'AUTHENTICITÉ, jamais assouplie.
// --------------------------------------------------------------

test("MAC invalide (falsifié) -- ACK échec, RIEN enregistré", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement" });
  raw.MAC = raw.MAC.slice(0, -1) + (raw.MAC.endsWith("0") ? "1" : "0");
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, FAILURE_ACK);
  assert.equal(result.outcome, "mac_invalid");
  assert.ok(!calls.some((c) => c.name === "record_payment_provider_event"));
});

test("credential stocké MALFORMÉ -- ACK échec propre, JAMAIS une exception non rattrapée", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: "{not-valid-json", error: null }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, FAILURE_ACK);
  assert.equal(result.outcome, "unrecognized_reference");
  assert.ok(!calls.some((c) => c.name === "record_payment_provider_event"));
});

// --------------------------------------------------------------
// Environnement/mode indisponible APRÈS authentification MAC réussie.
// --------------------------------------------------------------

test("get_payment_runtime_provider_environment échoue APRÈS un MAC valide -- ACK échec, RIEN enregistré (impossible de classifier sans mode)", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: () => ({ data: null, error: { code: "50000", message: "boom" } }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, FAILURE_ACK);
  assert.ok(!calls.some((c) => c.name === "record_payment_provider_event"));
});

// --------------------------------------------------------------
// V2-05 : classification exhaustive -- refused/pending/unknown ne
// mutent JAMAIS payment_transactions.status.
// --------------------------------------------------------------

test("code-retour='Annulation' (refused) -- enregistré durablement, confirmPaymentAttempt JAMAIS appelée, ACK succès", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "refused");
      return recordedRow({ provider_event_type: "refused" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "Annulation" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_refused");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("code-retour='attente_partenaire' (pending) -- enregistré, confirmPaymentAttempt JAMAIS appelée", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "pending");
      return recordedRow({ provider_event_type: "pending" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "attente_partenaire" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_pending");
});

test("code-retour non documenté (ex. 'paiement_pf1') -- classifié 'unknown', enregistré, JAMAIS traité comme paid", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "unknown");
      return recordedRow({ provider_event_type: "unknown" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement_pf1" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_unknown");
});

// --------------------------------------------------------------
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 -- ferme
// P3B-V3-MODE-ENDPOINT-01 : cohérence mode/code-retour.
// --------------------------------------------------------------

test("MODE-ENDPOINT-01 : mode='live' + code-retour='payetest' (sandbox-only) -- JAMAIS paid, enregistré 'unknown'/mode-mismatch", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "unknown");
      assert.equal(args.p_provider_event_code, "payetest");
      return recordedRow({ provider_event_type: "unknown", provider_event_code: "payetest" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "payetest", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_mode_mismatch");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("MODE-ENDPOINT-01 : mode='test' + code-retour='paiement' (production-only) -- JAMAIS paid, enregistré 'unknown'/mode-mismatch", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: TEST_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "unknown");
      return recordedRow({ provider_event_type: "unknown", provider_event_code: "paiement" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_mode_mismatch");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("MODE-ENDPOINT-01 : mode='test' + code-retour='payetest' (compatible) -- classifié paid normalement", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: TEST_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "paid");
      return recordedRow({ provider_event_type: "paid", provider_event_code: "payetest" });
    },
    claim_payment_provider_event_by_id: () =>
      claimRow({ provider_event_code: "payetest" }),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "payetest", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "applied_paid");
});

// --------------------------------------------------------------
// V2-04 : montant/devise fail-closed (vérifié maintenant en STAGE B,
// payment-provider-event-processor.ts).
// --------------------------------------------------------------

test("'paid' SANS champ montant -- confirmPaymentAttempt JAMAIS appelée, ACK succès (preuve durable acquise)", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "paid" }),
    claim_payment_provider_event_by_id: () => claimRow({ amount: null, currency: null }),
    update_payment_provider_event_processing_status: () => finalizedRow("ignored"),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_paid_not_yet_applied");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("'paid' avec montant NE CORRESPONDANT PAS au montant autoritatif P1 -- confirmPaymentAttempt JAMAIS appelée", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION), // amount "25.00"
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "paid" }),
    claim_payment_provider_event_by_id: () => claimRow({ amount: "999.99", currency: "EUR" }),
    update_payment_provider_event_processing_status: () => finalizedRow("ignored"),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "999.99EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_paid_not_yet_applied");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

test("'paid' avec devise NE CORRESPONDANT PAS (même montant numérique) -- confirmPaymentAttempt JAMAIS appelée", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION), // currency EUR
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "paid" }),
    claim_payment_provider_event_by_id: () => claimRow({ amount: "25.00", currency: "USD" }),
    update_payment_provider_event_processing_status: () => finalizedRow("ignored"),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00USD" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_paid_not_yet_applied");
  assert.ok(!calls.some((c) => c.name === "confirm_payment_attempt"));
});

// --------------------------------------------------------------
// Chemin 'paid' matching -- APPLIQUÉ (Stage A + Stage B synchrone).
// --------------------------------------------------------------

test("'paid' avec montant/devise EXACTEMENT correspondants -- confirmPaymentAttempt('paid') appelée via Stage B, ACK succès, outcome applied_paid", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION), // amount 25.00 EUR
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "paid" }),
    claim_payment_provider_event_by_id: (_n, args) => {
      assert.equal(args.p_event_id, "evt-1");
      return claimRow();
    },
    update_payment_provider_event_processing_status: (_n, args) => {
      assert.equal(args.p_claim_token, "claim-token-1");
      assert.equal(args.p_new_status, "applied");
      return finalizedRow("applied");
    },
    confirm_payment_attempt: (_n, args) => {
      assert.equal(args.p_provider_code, "monetico");
      assert.equal(args.p_provider_reference, "ref-1");
      assert.equal(args.p_status, "paid");
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "applied_paid");
  assert.equal(result.eventId, "evt-1");
  assert.ok(calls.some((c) => c.name === "confirm_payment_attempt"));
  assert.ok(calls.some((c) => c.name === "update_payment_provider_event_processing_status"));
});

test("'paid' -- code-retour split-installment 'paiement_pf2' (production-only, compatible mode='live') classifié paid, appliqué", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_event_type, "paid");
      assert.equal(args.p_provider_event_code, "paiement_pf2");
      return recordedRow({ provider_event_type: "paid", provider_event_code: "paiement_pf2" });
    },
    claim_payment_provider_event_by_id: () => claimRow({ provider_event_code: "paiement_pf2" }),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
  });
  const raw = signedCallback({
    reference: "ref-1",
    "code-retour": "paiement_pf2",
    montant: "25.00EUR",
  });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.outcome, "applied_paid");
  assert.equal(calls.filter((c) => c.name === "confirm_payment_attempt").length, 1);
});

// --------------------------------------------------------------
// L'INVARIANT DUR : un refus antérieur ne bloque JAMAIS un paid
// authentique ultérieur pour la MÊME référence.
// --------------------------------------------------------------

test("INVARIANT : refus PUIS paid authentique pour la MÊME référence -- le paid est appliqué normalement, jamais bloqué par le refus antérieur", async (t) => {
  let confirmCalls = 0;
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) =>
      recordedRow({
        id: args.p_provider_event_type === "refused" ? "evt-refused" : "evt-paid",
        provider_event_type: args.p_provider_event_type,
      }),
    claim_payment_provider_event_by_id: (_n, args) =>
      args.p_event_id === "evt-paid" ? claimRow({ id: "evt-paid" }) : null,
    update_payment_provider_event_processing_status: (_n, args) =>
      finalizedRow(args.p_new_status as string),
    confirm_payment_attempt: () => {
      confirmCalls += 1;
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });

  const refusal = signedCallback({ reference: "ref-1", "code-retour": "Annulation" });
  const refusalResult = await processMoneticoCallback(refusal);
  assert.equal(refusalResult.outcome, "recorded_refused");
  assert.equal(confirmCalls, 0);

  const paid = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const paidResult = await processMoneticoCallback(paid);
  assert.equal(paidResult.outcome, "applied_paid");
  assert.equal(confirmCalls, 1);
});

// --------------------------------------------------------------
// Rejeu exact -- Stage B claim/lease gère l'idempotence : un évènement
// DÉJÀ terminal (applied) n'est PLUS re-revendicable -- claim_by_id
// renvoie vide, confirmPaymentAttempt n'est PAS re-tentée par CE chemin
// synchrone (contrairement à v3, qui la ré-appelait inconditionnellement).
// --------------------------------------------------------------

test("REJEU EXACT d'un paid DÉJÀ appliqué (processing_status déjà 'applied') -- claim_by_id renvoie vide, ACK succès quand même, confirmPaymentAttempt PAS re-tentée par ce chemin", async (t) => {
  let confirmCalls = 0;
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () =>
      recordedRow({ provider_event_type: "paid", is_new_event: false }), // rejeu exact
    claim_payment_provider_event_by_id: () => ({ data: [], error: null }), // déjà terminal -- vide
    confirm_payment_attempt: () => {
      confirmCalls += 1;
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_paid_not_yet_applied");
  assert.equal(result.isNewEvent, false);
  assert.equal(confirmCalls, 0, "un rejeu déjà terminal ne doit pas re-déclencher confirmPaymentAttempt via CE chemin");
});

test("CRASH MATRIX D : mutation confirmPaymentAttempt DÉJÀ réussie avant un crash antérieur (inbox jamais finalisée) -- un rejeu qui parvient à re-revendiquer réapplique idempotemment, inbox devient 'applied', jamais de double paiement observable", async (t) => {
  let confirmCalls = 0;
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () =>
      recordedRow({ provider_event_type: "paid", is_new_event: false }),
    // Encore 'received' -- la finalisation n'a JAMAIS eu lieu avant le
    // crash précédent, donc CE rejeu peut re-revendiquer.
    claim_payment_provider_event_by_id: () => claimRow(),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => {
      confirmCalls += 1;
      // `confirmPaymentAttempt` idempotent sous verrouillage terminal
      // (PAYMENT P1, INCHANGÉ) -- réussit ENCORE ici, comme un no-op sûr.
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.outcome, "applied_paid");
  assert.equal(confirmCalls, 1);
});

// --------------------------------------------------------------
// Pannes internes -- ACK jamais basé sur le succès de la mutation.
// --------------------------------------------------------------

test("recordPaymentProviderEvent échoue (panne DB) -- ACK échec (JAMAIS de succès sans preuve durable, V2-03)", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => ({ data: null, error: { code: "50000", message: "boom" } }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, FAILURE_ACK);
  assert.equal(result.outcome, "record_failed");
});

test("CRASH MATRIX F : confirmPaymentAttempt échoue APRÈS enregistrement durable réussi (panne transitoire) -- ACK reste SUCCÈS, Stage B finalise 'failed_retryable' (reste éligible à une future revendication)", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "paid" }),
    claim_payment_provider_event_by_id: () => claimRow(),
    update_payment_provider_event_processing_status: (_n, args) => {
      assert.equal(args.p_new_status, "failed_retryable");
      return finalizedRow("failed_retryable");
    },
    confirm_payment_attempt: () => ({ data: null, error: { code: "50000", message: "boom" } }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_paid_not_yet_applied");
  assert.equal(result.eventId, "evt-1");
});

test("CRASH MATRIX E : bail périmé/déjà repris par un autre claimant au moment de finaliser -- perte de course SÛRE, ACK reste succès, jamais une exception remontée", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "paid" }),
    claim_payment_provider_event_by_id: () => claimRow(),
    update_payment_provider_event_processing_status: () => ({
      data: null,
      error: { code: "42501", message: "claim token mismatch" },
    }),
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, SUCCESS_ACK);
  assert.equal(result.outcome, "recorded_paid_not_yet_applied");
});

// --------------------------------------------------------------
// provider_code fixé serveur -- jamais dérivé du callback lui-même.
// --------------------------------------------------------------

test("provider_code envoyé aux RPC est TOUJOURS 'monetico' fixé serveur, jamais dérivé du callback", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: (_n, args) => {
      assert.equal(args.p_provider_code, "monetico");
      return ok(BASE_CORRELATION);
    },
    get_payment_provider_credential: (_n, args) => {
      assert.equal(args.p_provider_code, "monetico");
      return { data: CREDENTIAL_JSON, error: null };
    },
    get_payment_runtime_provider_environment: (_n, args) => {
      assert.equal(args.p_provider_code, "monetico");
      return LIVE_ENVIRONMENT();
    },
    record_payment_provider_event: (_n, args) => {
      assert.equal(args.p_provider_code, "monetico");
      return recordedRow({ provider_event_type: "paid" });
    },
    claim_payment_provider_event_by_id: () => claimRow(),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: (_n, args) => {
      assert.equal(args.p_provider_code, "monetico");
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });
  const raw = signedCallback({
    reference: "ref-1",
    "code-retour": "paiement",
    montant: "25.00EUR",
    provider_code: "SOMETHING-ELSE",
  });
  await processMoneticoCallback(raw);
  assert.ok(calls.length >= 5);
});

// --------------------------------------------------------------
// Octets ACK -- exactitude littérale.
// --------------------------------------------------------------

test("octets ACK EXACTS -- succès='version=2\\ncdr=0\\n', échec='version=2\\ncdr=1\\n'", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => recordedRow({ provider_event_type: "refused" }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "Annulation" });
  const result = await processMoneticoCallback(raw);
  assert.equal(result.ack, "version=2\ncdr=0\n");

  const badMac = { ...raw, MAC: "0000000000000000000000000000000000000000" };
  const failResult = await processMoneticoCallback(badMac);
  assert.equal(failResult.ack, "version=2\ncdr=1\n");
});
