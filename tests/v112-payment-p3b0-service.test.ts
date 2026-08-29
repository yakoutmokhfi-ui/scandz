import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B0 v2 — CALLBACK CORRELATION + AUTHORITATIVE
// AMOUNT/CURRENCY + CUSTOMER PAYMENT STATUS READ (corrects
// PAY-P3-B0-01, the release-blocking finding against v1: the
// correlation RPC could not return an authoritative amount/currency
// for a future callback route to compare a Monetico `montant` against
// before confirmation).
//
// Couvre le SEUL wrapper TypeScript ajouté par ce lot :
// lib/server/payment-service.ts::getPaymentTransactionCorrelation
// (RPC #1, `get_payment_transaction_correlation`, service_role
// UNIQUEMENT), désormais à SIX colonnes
// (restaurantId/orderId/transactionId/status/amount/currency). RPC #2
// (`get_order_payment_status`, client anonyme) n'a délibérément AUCUN
// wrapper dans ce lot -- voir le commentaire de
// getPaymentTransactionCorrelation dans payment-service.ts.
//
// Patron déjà établi par ce dépôt (tests/v110b-payment-p3a1-
// service.test.ts) : `t.mock.method(client, "rpc", ...)` sur le CLIENT
// RÉEL construit par getServiceRoleSupabaseClient() (une seule
// construction partagée par tout ce fichier).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b0-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { getPaymentTransactionCorrelation } = await import("../lib/server/payment-service.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3b0-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "payment_transactions_internal_fake";

test("getPaymentTransactionCorrelation: appelle EXACTEMENT get_payment_transaction_correlation avec p_provider_code/p_provider_reference, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [
        {
          restaurant_id: "resto-1",
          order_id: "order-1",
          transaction_id: "txn-1",
          status: "paid",
          amount: "25.00",
          currency: "EUR",
        },
      ],
      error: null,
    };
  });

  await getPaymentTransactionCorrelation({
    providerCode: "monetico",
    providerReference: "ref-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_payment_transaction_correlation");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_provider_code",
    "p_provider_reference",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_provider_code, "monetico");
  assert.equal(args.p_provider_reference, "ref-1");
});

test("getPaymentTransactionCorrelation: un restaurant_id/tenant/amount/currency fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [
        {
          restaurant_id: "resto-2",
          order_id: "order-2",
          transaction_id: "txn-2",
          status: "pending",
          amount: "12.50",
          currency: "EUR",
        },
      ],
      error: null,
    };
  });

  const maliciousInput = {
    providerCode: "monetico",
    providerReference: "ref-2",
    // Champs qui n'existent PAS dans GetPaymentTransactionCorrelationInput
    // -- simule un appelant qui tenterait de faire confiance à un
    // identifiant de tenant, ou à un montant/devise, fourni par le
    // callback lui-même (mission §4/§14 de PAYMENT P3-B, §5/§18 de
    // PAYMENT P3-B0-V2 -- exactement ce que cette RPC existe pour
    // éviter : amount/currency ne sont JAMAIS des entrées, seulement
    // des sorties autoritatives).
    restaurantId: "should-never-be-sent",
    tenantId: "should-never-be-sent",
    amount: "999999.99",
    currency: "XXX",
  };
  await getPaymentTransactionCorrelation(
    maliciousInput as unknown as Parameters<typeof getPaymentTransactionCorrelation>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_provider_code", "p_provider_reference"]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes("999999.99"), "l'amount fourni par l'appelant ne doit jamais être transmis à la RPC");
});

test("getPaymentTransactionCorrelation: mapping succès -> les SIX champs (restaurantId/orderId/transactionId/status/amount/currency) exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-3",
        order_id: "order-3",
        transaction_id: "txn-3",
        status: "paid",
        amount: "42.75",
        currency: "EUR",
      },
    ],
    error: null,
  }));

  const result = await getPaymentTransactionCorrelation({
    providerCode: "monetico",
    providerReference: "ref-3",
  });
  assert.deepEqual(result, {
    restaurantId: "resto-3",
    orderId: "order-3",
    transactionId: "txn-3",
    status: "paid",
    amount: "42.75",
    currency: "EUR",
  });
});

test("getPaymentTransactionCorrelation: amount préservé EXACTEMENT quand la RPC le renvoie déjà sous forme de chaîne (aucune reformulation/arrondi)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-precision",
        order_id: "order-precision",
        transaction_id: "txn-precision",
        status: "paid",
        // Valeur choisie pour détecter tout arrondi/troncature accidentel
        // (2 décimales significatives, jamais 0 en fin de chaîne).
        amount: "1234.57",
        currency: "EUR",
      },
    ],
    error: null,
  }));
  const result = await getPaymentTransactionCorrelation({
    providerCode: "monetico",
    providerReference: "ref-precision-string",
  });
  assert.equal(result.amount, "1234.57");
  assert.equal(typeof result.amount, "string");
});

test("getPaymentTransactionCorrelation: amount reste utilisable même si le client Postgrest le désérialise en JS number (comportement documenté de PostgREST pour `numeric`) -- jamais un Number() supplémentaire appliqué par ce wrapper", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-numeric",
        order_id: "order-numeric",
        transaction_id: "txn-numeric",
        status: "pending",
        // PostgREST sérialise `numeric` comme un nombre JSON brut par
        // défaut (voir AMOUNT-CURRENCY-REPORT.txt) -- ce test simule ce
        // cas : `row.amount` arrive déjà comme un JS `number`.
        amount: 8.5,
        currency: "EUR",
      },
    ],
    error: null,
  }));
  const result = await getPaymentTransactionCorrelation({
    providerCode: "monetico",
    providerReference: "ref-precision-number",
  });
  // String(8.5) === "8.5" -- le wrapper ne fait que stringifier ce qui
  // arrive, jamais de conversion Number(...) supplémentaire qui
  // pourrait figer une imprécision différente à chaque appel.
  assert.equal(result.amount, "8.5");
  assert.equal(typeof result.amount, "string");
});

test("getPaymentTransactionCorrelation: currency préservée EXACTEMENT telle que renvoyée par la RPC, sans normalisation ajoutée par le wrapper", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-cur",
        order_id: "order-cur",
        transaction_id: "txn-cur",
        status: "paid",
        amount: "10.00",
        currency: "EUR",
      },
    ],
    error: null,
  }));
  const result = await getPaymentTransactionCorrelation({
    providerCode: "monetico",
    providerReference: "ref-currency",
  });
  assert.equal(result.currency, "EUR");
  assert.equal(typeof result.currency, "string");
});

test("getPaymentTransactionCorrelation: le résultat ne contient JAMAIS de champ credential/Vault/public_token/écho de référence, même si la RPC en renvoyait un (cast, dérive future du SQL simulée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-4",
        order_id: "order-4",
        transaction_id: "txn-4",
        status: "paid",
        amount: "5.00",
        currency: "EUR",
        // Champs qui n'existent PAS dans le contrat documenté de la
        // RPC -- simule une future dérive du SQL ; le wrapper ne doit
        // jamais les propager silencieusement.
        provider_reference: "should-never-be-sent",
        credentials_ref: "should-never-be-sent",
        public_token: "should-never-be-sent",
        securityKey: "should-never-be-sent",
      },
    ],
    error: null,
  }));

  const result = await getPaymentTransactionCorrelation({
    providerCode: "monetico",
    providerReference: "ref-4",
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "amount",
    "currency",
    "orderId",
    "restaurantId",
    "status",
    "transactionId",
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("getPaymentTransactionCorrelation: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
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
      getPaymentTransactionCorrelation({
        providerCode: "monetico",
        providerReference: "no-such-reference",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      const serialized = String(err.message) + String(err.stack ?? "");
      assert.ok(!serialized.includes(FAKE_SQLSTATE));
      assert.ok(!serialized.includes(FAKE_SECRET_IN_ERROR));
      assert.ok(!serialized.includes(FAKE_TABLE_NAME));
      return true;
    }
  );
});

test("getPaymentTransactionCorrelation: résultat vide/absent (aucune ligne, ex. NULL/mauvaise référence) -> PaymentServerRpcError générique (jamais un undefined silencieusement propagé)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () =>
      getPaymentTransactionCorrelation({
        providerCode: "monetico",
        providerReference: "ref-5",
      }),
    PaymentServerRpcError
  );

  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () =>
      getPaymentTransactionCorrelation({
        providerCode: "monetico",
        providerReference: "ref-5",
      }),
    PaymentServerRpcError
  );
});

test("getPaymentTransactionCorrelation: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      getPaymentTransactionCorrelation({
        providerCode: "monetico",
        providerReference: "ref-6",
      }),
    PaymentServerUnavailableError
  );
});

test("getPaymentTransactionCorrelation: aucune valeur (y compris amount/currency) ne fuit jamais dans console.log/error/warn (succès comme échec)", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-7",
        order_id: "order-7",
        transaction_id: "txn-7",
        status: "paid",
        amount: "77.77",
        currency: "EUR",
      },
    ],
    error: null,
  }));
  await getPaymentTransactionCorrelation({ providerCode: "monetico", providerReference: "ref-7" });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    getPaymentTransactionCorrelation({ providerCode: "monetico", providerReference: "ref-7" })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
  assert.ok(!combined.includes("77.77"), "un montant, même légitime, ne doit jamais atterrir dans un log console");
});

test("getPaymentTransactionCorrelation: aucun accès table direct -- ce wrapper appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-8",
        order_id: "order-8",
        transaction_id: "txn-8",
        status: "paid",
        amount: "1.00",
        currency: "EUR",
      },
    ],
    error: null,
  }));

  await getPaymentTransactionCorrelation({ providerCode: "monetico", providerReference: "ref-8" });
  assert.equal(fromCalled, false, "getPaymentTransactionCorrelation ne doit jamais interroger une table directement");
});
