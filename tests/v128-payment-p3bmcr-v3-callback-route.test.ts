import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.
// Couvre app/api/payments/monetico/callback/route.ts::POST au niveau
// HTTP RÉEL (form-urlencoded, octets ACK exacts, code HTTP TOUJOURS
// 200 -- la sémantique succès/échec vit dans le corps `cdr=0`/`cdr=1`,
// jamais dans le code HTTP, mission v2.0 §1.4.3.3) après la
// RESTRUCTURATION v4 en deux étapes (STAGE A ingestion mode-aware +
// STAGE B traitement via claim/lease PARTAGÉ, ferme
// P3B-V3-ACK-RECOVERY-01/P3B-V3-MODE-ENDPOINT-01, mandat §15-§21) --
// rejeu, retry après panne transitoire, et filet de sécurité contre
// toute exception non rattrapée (jamais une page d'erreur HTML
// Next.js en réponse à Monetico).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-route-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/payments/monetico/callback/route.ts");
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
    if (!handler) throw new Error(`RPC inattendue dans ce scénario de test : ${name}`);
    return handler(name, args);
  });
  return calls;
}

const ok = (row: unknown) => ({ data: [row], error: null });
const empty = { data: [], error: null };

const BASE_CORRELATION = {
  restaurant_id: "resto-1",
  order_id: "order-1",
  transaction_id: "txn-1",
  status: "pending",
  amount: "25.00",
  currency: "EUR",
};

// `mode` P3-B4 AUTORITAIRE -- "live", car ce fichier utilise
// `code-retour: "paiement"` pour ses scénarios "paid" (documenté
// PRODUCTION-UNIQUEMENT, voir code-retour.ts). "test" y produirait
// désormais un `modeMismatch` (dégradé en `unknown`, JAMAIS `paid`) --
// exactement le comportement v4 exercé séparément par v126.
const LIVE_ENVIRONMENT = () =>
  ok({ provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "live" });

function postForm(fields: Record<string, string>): InstanceType<typeof NextRequest> {
  const form = new URLSearchParams(fields).toString();
  return new NextRequest("https://checkout.example.test/api/payments/monetico/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

let paidEventCounter = 0;
function paidEventRow(isNewEvent: boolean) {
  paidEventCounter += 1;
  return ok({
    id: `evt-${paidEventCounter}`,
    restaurant_id: "resto-1",
    order_id: "order-1",
    payment_transaction_id: "txn-1",
    provider_event_type: "paid",
    processing_status: "received",
    created_at: "2026-08-31T00:00:00Z",
    is_new_event: isNewEvent,
  });
}

function fixedPaidEventRow(id: string, isNewEvent: boolean) {
  return ok({
    id,
    restaurant_id: "resto-1",
    order_id: "order-1",
    payment_transaction_id: "txn-1",
    provider_event_type: "paid",
    processing_status: "received",
    created_at: "2026-08-31T00:00:00Z",
    is_new_event: isNewEvent,
  });
}

// Ligne `claim_payment_provider_event_by_id` -- même forme que
// `claim_payment_provider_events` (PAYMENT P3-B5 v2), restreinte à UN
// id (PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4). Montant/devise
// AUTORITATIFS par défaut = ceux de BASE_CORRELATION, pour que
// `processClaimedPaymentProviderEvent` applique `paid` sans divergence
// -- un test qui veut exercer une divergence les surcharge
// explicitement.
function claimRowFor(
  eventId: string,
  overrides: Partial<{ amount: string | null; currency: string | null }> = {}
) {
  return ok({
    id: eventId,
    restaurant_id: "resto-1",
    order_id: "order-1",
    payment_transaction_id: "txn-1",
    provider_code: "monetico",
    provider_reference: "ref-1",
    event_fingerprint: `fp-${eventId}`,
    provider_event_type: "paid",
    provider_event_code: "paiement",
    amount: overrides.amount === undefined ? "25.00" : overrides.amount,
    currency: overrides.currency === undefined ? "EUR" : overrides.currency,
    authorization_reference: null,
    processing_status: "received",
    retry_count: 0,
    claim_token: `claim-${eventId}`,
    claim_expires_at: "2026-08-31T00:01:00Z",
  });
}

function finalizedRow(status: string) {
  return ok({ id: "evt-x", processing_status: status, retry_count: 0, processed_at: "2026-08-31T00:00:00Z" });
}

// --------------------------------------------------------------
// Code HTTP TOUJOURS 200 ; content-type text/plain ; octets exacts.
// --------------------------------------------------------------

test("callback authentique 'paid' correspondant -- HTTP 200, content-type text/plain, corps EXACT 'version=2\\ncdr=0\\n', STAGE B applique le paiement via claim/lease", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => paidEventRow(true),
    claim_payment_provider_event_by_id: (_n, args) => claimRowFor(args.p_event_id as string),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const res = await POST(postForm(raw));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const body = await res.text();
  assert.equal(body, SUCCESS_ACK);
  assert.ok(calls.some((c) => c.name === "update_payment_provider_event_processing_status"));
});

test("MAC falsifié -- HTTP 200 QUAND MÊME (jamais un code d'erreur HTTP), corps EXACT 'version=2\\ncdr=1\\n'", async (t) => {
  const calls = routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement" });
  raw.MAC = "0".repeat(40);
  const res = await POST(postForm(raw));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, FAILURE_ACK);
  assert.ok(!calls.some((c) => c.name === "record_payment_provider_event"));
});

test("corps de requête totalement vide -- HTTP 200, ACK échec, aucune exception non rattrapée", async (t) => {
  const calls = routeRpc(t, {});
  const req = new NextRequest("https://checkout.example.test/api/payments/monetico/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  const res = await POST(req);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), FAILURE_ACK);
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------
// REJEU (Monetico peut renvoyer le MÊME callback plusieurs fois).
// --------------------------------------------------------------

test("REJEU EXACT : le MÊME callback 'paid' authentique posté DEUX fois -- les deux réponses sont un succès ; la 2e revendication `claim_payment_provider_event_by_id` est VIDE (évènement déjà terminal) -- confirm_payment_attempt appelée UNE seule fois au total (STAGE B partagé, jamais un second traitement)", async (t) => {
  let confirmCalls = 0;
  let claimed = false;
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    // rejeu = jamais "nouveau" (même empreinte, PAYMENT P3-B5 v2) --
    // même id stable "evt-1" les deux fois.
    record_payment_provider_event: () => fixedPaidEventRow("evt-1", false),
    claim_payment_provider_event_by_id: () => {
      if (claimed) return empty; // déjà revendiqué/terminal -- 2e POST.
      claimed = true;
      return claimRowFor("evt-1");
    },
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => {
      confirmCalls += 1;
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });

  const first = await POST(postForm(raw));
  const second = await POST(postForm(raw));

  assert.equal(await first.text(), SUCCESS_ACK);
  assert.equal(await second.text(), SUCCESS_ACK);
  assert.equal(confirmCalls, 1);
});

// --------------------------------------------------------------
// RETRY : panne transitoire PUIS nouvelle tentative Monetico réussie.
// --------------------------------------------------------------

test("RETRY : 1er POST échoue (panne DB pendant l'enregistrement durable) -> ACK échec ; Monetico réessaie -> 2e POST réussit -> ACK succès, STAGE B applique le paiement", async (t) => {
  let attempt = 0;
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: () => {
      attempt += 1;
      if (attempt === 1) {
        return { data: null, error: { code: "53300", message: "boom" } };
      }
      return paidEventRow(true);
    },
    claim_payment_provider_event_by_id: (_n, args) => claimRowFor(args.p_event_id as string),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" }),
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });

  const firstAttempt = await POST(postForm(raw));
  assert.equal(await firstAttempt.text(), FAILURE_ACK);

  const retryAttempt = await POST(postForm(raw));
  assert.equal(await retryAttempt.text(), SUCCESS_ACK);
});

// --------------------------------------------------------------
// INVARIANT bout-en-bout au niveau ROUTE : refus PUIS paid authentique.
// --------------------------------------------------------------

test("INVARIANT bout-en-bout : refus PUIS paid authentique via DEUX POST distincts -- le paid est appliqué, ACK succès dans les deux cas, confirm_payment_attempt JAMAIS pour le refus", async (t) => {
  let confirmCalls = 0;
  routeRpc(t, {
    get_payment_transaction_correlation: () => ok(BASE_CORRELATION),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_payment_runtime_provider_environment: LIVE_ENVIRONMENT,
    record_payment_provider_event: (_n, args) =>
      ok({
        id: args.p_provider_event_type === "refused" ? "evt-refused" : "evt-paid",
        restaurant_id: "resto-1",
        order_id: "order-1",
        payment_transaction_id: "txn-1",
        provider_event_type: args.p_provider_event_type,
        processing_status: "received",
        created_at: "2026-08-31T00:00:00Z",
        is_new_event: true,
      }),
    // STAGE B best-effort est AUSSI tenté pour un `refused` (mandat
    // §21 : ne jamais laisser un évènement traité indéfiniment
    // `received`) -- revendication VIDE ici (rien à appliquer,
    // finalisé `ignored` ailleurs par construction), jamais
    // `confirm_payment_attempt`.
    claim_payment_provider_event_by_id: (_n, args) =>
      args.p_event_id === "evt-refused" ? empty : claimRowFor("evt-paid"),
    update_payment_provider_event_processing_status: () => finalizedRow("applied"),
    confirm_payment_attempt: () => {
      confirmCalls += 1;
      return ok({ transaction_id: "txn-1", order_id: "order-1", status: "paid" });
    },
  });

  const refusal = signedCallback({ reference: "ref-1", "code-retour": "Annulation" });
  const refusalRes = await POST(postForm(refusal));
  assert.equal(await refusalRes.text(), SUCCESS_ACK);
  assert.equal(confirmCalls, 0);

  const paid = signedCallback({ reference: "ref-1", "code-retour": "paiement", montant: "25.00EUR" });
  const paidRes = await POST(postForm(paid));
  assert.equal(await paidRes.text(), SUCCESS_ACK);
  assert.equal(confirmCalls, 1);
});

// --------------------------------------------------------------
// Filet de sécurité : une exception totalement inattendue ne doit
// JAMAIS produire une page d'erreur HTML Next.js.
// --------------------------------------------------------------

test("FILET DE SÉCURITÉ : une exception inattendue levée profondément dans le traitement -- ACK échec propre, JAMAIS un crash HTTP 500", async (t) => {
  routeRpc(t, {
    get_payment_transaction_correlation: () => {
      throw new TypeError("panne totalement inattendue, jamais un PostgrestError");
    },
  });
  const raw = signedCallback({ reference: "ref-1", "code-retour": "paiement" });
  const res = await POST(postForm(raw));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), FAILURE_ACK);
});

// --------------------------------------------------------------
// Champ non-texte dans le formulaire (jamais un `File` attendu par
// Monetico) -- ignoré, jamais un crash.
// --------------------------------------------------------------

test("champ non-texte dans le corps multipart -- ignoré silencieusement, échoue fermé comme un champ manquant", async (t) => {
  routeRpc(t, {});
  const form = new FormData();
  form.set("reference", "ref-1");
  form.set("code-retour", "paiement");
  form.set("MAC", "irrelevant");
  form.set("attachment", new Blob(["not-expected"]), "file.bin");
  const req = new NextRequest("https://checkout.example.test/api/payments/monetico/callback", {
    method: "POST",
    body: form,
  });
  const res = await POST(req);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), FAILURE_ACK);
});
