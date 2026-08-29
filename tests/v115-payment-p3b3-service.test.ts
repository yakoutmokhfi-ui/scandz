import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B3 — ACTIVE PAYMENT ATTEMPT RESUME READ v1.
//
// Répond au STOP — PAYMENT P3-B v2 PENDING ATTEMPT DATABASE CAPABILITY
// REQUIRED soulevé par PAYMENT P3-B MONETICO CHECKOUT RUNTIME v2 :
// après qu'un navigateur abandonne un paiement, l'unique tentative
// 'pending' déjà créée par initiate_payment_attempt (P1) reste valide
// en base mais orpheline -- aucune capacité existante ne permettait de
// la retrouver par (order_id, public_token) seuls (ni
// getOrderPaymentContext, contrat P3-B2 volontairement minimal, ni
// getPaymentTransactionCorrelation, keyed par la référence en ENTRÉE).
//
// Couvre le SEUL wrapper TypeScript ajouté par ce lot :
// lib/server/payment-service.ts::getOrderActivePaymentAttempt
// (`get_order_active_payment_attempt`, service_role UNIQUEMENT).
//
// Patron déjà établi par ce dépôt (tests/v110b/v112/v113/v114-payment-
// p3b2-service.test.ts) : `t.mock.method(client, "rpc", ...)` sur le
// CLIENT RÉEL construit par getServiceRoleSupabaseClient() (une seule
// construction partagée par tout ce fichier).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b3-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { getOrderActivePaymentAttempt } = await import("../lib/server/payment-service.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3b3-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "payment_transactions_internal_fake";
const FAKE_TOKEN = "p3b3-fake-public-token-DO-NOT-LOG-22222222-2222-2222-2222-222222222222";

test("getOrderActivePaymentAttempt: appelle EXACTEMENT get_order_active_payment_attempt avec p_order_id/p_public_token/p_provider_code, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ provider_reference: "ref-1", amount: "12.50", currency: "EUR" }],
      error: null,
    };
  });

  await getOrderActivePaymentAttempt({
    orderId: "order-1",
    publicToken: "token-1",
    providerCode: "monetico",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_order_active_payment_attempt");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_order_id",
    "p_provider_code",
    "p_public_token",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, "order-1");
  assert.equal(args.p_public_token, "token-1");
  assert.equal(args.p_provider_code, "monetico");
});

test("getOrderActivePaymentAttempt: un restaurant_id/transaction_id fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ provider_reference: "ref-2", amount: "30.00", currency: "EUR" }],
      error: null,
    };
  });

  const maliciousInput = {
    orderId: "order-2",
    publicToken: "token-2",
    providerCode: "monetico",
    // Champs qui n'existent PAS dans GetOrderActivePaymentAttemptInput.
    restaurantId: "should-never-be-sent",
    transactionId: "should-never-be-sent",
    amount: "999.99",
    currency: "USD",
  };
  await getOrderActivePaymentAttempt(
    maliciousInput as unknown as Parameters<typeof getOrderActivePaymentAttempt>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_order_id", "p_provider_code", "p_public_token"]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes("999.99"), "un montant fourni par l'appelant ne doit jamais être transmis à la RPC");
  assert.ok(!serialized.includes("USD"), "une devise fournie par l'appelant ne doit jamais être transmise à la RPC");
});

test("getOrderActivePaymentAttempt: mapping succès -> les TROIS champs (providerReference/amount/currency) exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_reference: "ref-3", amount: "15.75", currency: "EUR" }],
    error: null,
  }));

  const result = await getOrderActivePaymentAttempt({
    orderId: "order-3",
    publicToken: "token-3",
    providerCode: "monetico",
  });
  assert.deepEqual(result, {
    providerReference: "ref-3",
    amount: "15.75",
    currency: "EUR",
  });
});

test("getOrderActivePaymentAttempt: amount renvoyé en STRING, jamais converti en number (préservation de précision, même convention que PaymentTransactionCorrelation)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_reference: "ref-precision", amount: 12345678901234.57, currency: "EUR" }],
    error: null,
  }));
  const result = await getOrderActivePaymentAttempt({
    orderId: "order-precision",
    publicToken: "token-precision",
    providerCode: "monetico",
  });
  assert.equal(typeof result?.amount, "string");
});

test("getOrderActivePaymentAttempt: résultat VIDE (aucune tentative pending courante -- absence légitime, mission §11 'resume only') -> null, JAMAIS une exception", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  const result = await getOrderActivePaymentAttempt({
    orderId: "order-4",
    publicToken: "token-4",
    providerCode: "monetico",
  });
  assert.equal(result, null);
});

test("getOrderActivePaymentAttempt: data=null (même contrat qu'un ensemble de résultats vide) -> null également", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  const result = await getOrderActivePaymentAttempt({
    orderId: "order-4b",
    publicToken: "token-4b",
    providerCode: "monetico",
  });
  assert.equal(result, null);
});

test("getOrderActivePaymentAttempt: le résultat ne contient JAMAIS de champ transaction_id/restaurant_id/order_number/public_token/credential, même si la RPC en renvoyait un (cast, dérive future du SQL simulée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        provider_reference: "ref-5",
        amount: "8.00",
        currency: "EUR",
        // Champs qui n'existent PAS dans le contrat documenté de la
        // RPC -- simule une future dérive du SQL ; le wrapper ne doit
        // jamais les propager silencieusement.
        transaction_id: "should-never-be-sent",
        restaurant_id: "should-never-be-sent",
        order_number: "should-never-be-sent",
        public_token: FAKE_TOKEN,
        authorization_reference: "should-never-be-sent",
        credentials_ref: "should-never-be-sent",
      },
    ],
    error: null,
  }));

  const result = await getOrderActivePaymentAttempt({
    orderId: "order-5",
    publicToken: "token-5",
    providerCode: "monetico",
  });
  assert.ok(result);
  assert.deepEqual(Object.keys(result).sort(), ["amount", "currency", "providerReference"]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes(FAKE_TOKEN));
});

test("getOrderActivePaymentAttempt: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: FAKE_SQLSTATE,
      message: `no row found in "${FAKE_TABLE_NAME}", secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: FAKE_TABLE_NAME,
    },
  }));

  await assert.rejects(
    () =>
      getOrderActivePaymentAttempt({
        orderId: "order-6",
        publicToken: FAKE_TOKEN,
        providerCode: "monetico",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      const serialized = String(err.message) + String(err.stack ?? "");
      assert.ok(!serialized.includes(FAKE_SQLSTATE));
      assert.ok(!serialized.includes(FAKE_SECRET_IN_ERROR));
      assert.ok(!serialized.includes(FAKE_TABLE_NAME));
      assert.ok(!serialized.includes(FAKE_TOKEN), "le public_token ne doit jamais apparaître dans une erreur");
      return true;
    }
  );
});

test("getOrderActivePaymentAttempt: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      getOrderActivePaymentAttempt({
        orderId: "order-7",
        publicToken: "token-7",
        providerCode: "monetico",
      }),
    PaymentServerUnavailableError
  );
});

test("getOrderActivePaymentAttempt: aucune valeur ne fuit jamais dans console.log/error/warn (succès, absence légitime, comme échec), notamment jamais le public_token", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_reference: "ref-8", amount: "8.00", currency: "EUR" }],
    error: null,
  }));
  await getOrderActivePaymentAttempt({ orderId: "order-8", publicToken: FAKE_TOKEN, providerCode: "monetico" });

  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await getOrderActivePaymentAttempt({ orderId: "order-8", publicToken: FAKE_TOKEN, providerCode: "monetico" });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    getOrderActivePaymentAttempt({ orderId: "order-8", publicToken: FAKE_TOKEN, providerCode: "monetico" })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
  assert.ok(!combined.includes(FAKE_TOKEN), "le public_token est apparu dans une sortie console");
});

test("getOrderActivePaymentAttempt: aucun accès table direct -- ce wrapper appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_reference: "ref-9", amount: "8.00", currency: "EUR" }],
    error: null,
  }));

  await getOrderActivePaymentAttempt({ orderId: "order-9", publicToken: "token-9", providerCode: "monetico" });
  assert.equal(fromCalled, false, "getOrderActivePaymentAttempt ne doit jamais interroger une table directement");
});
