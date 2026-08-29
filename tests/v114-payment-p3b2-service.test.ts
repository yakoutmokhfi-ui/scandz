import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B2 — ORDER PAYMENT CONTEXT READ v1.
//
// Répond au STOP — PAYMENT P3-B CUSTOMER ORDER AUTHORITY GAP soulevé
// par PAYMENT P3-B MONETICO CHECKOUT RUNTIME v1 : avant tout appel à
// getPaymentRuntimeProviderConfig, un futur runtime doit pouvoir
// dériver un restaurant_id DE CONFIANCE depuis la seule preuve de
// possession que le navigateur détient (order_id + public_token) --
// capacité que ni get_order_payment_status (exclut délibérément
// restaurant_id) ni mark_whatsapp_opened (returns void) ni
// initiate_payment_attempt (ne vérifie aucun public_token) ne
// fournissaient.
//
// Couvre le SEUL wrapper TypeScript ajouté par ce lot :
// lib/server/payment-service.ts::getOrderPaymentContext
// (`get_order_payment_context`, service_role UNIQUEMENT).
//
// Patron déjà établi par ce dépôt (tests/v110b-payment-p3a1-
// service.test.ts, tests/v112-payment-p3b0-service.test.ts,
// tests/v113-payment-p3b1-service.test.ts) : `t.mock.method(client,
// "rpc", ...)` sur le CLIENT RÉEL construit par
// getServiceRoleSupabaseClient() (une seule construction partagée par
// tout ce fichier).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b2-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { getOrderPaymentContext } = await import("../lib/server/payment-service.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3b2-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "orders_internal_fake";
const FAKE_TOKEN = "p3b2-fake-public-token-DO-NOT-LOG-11111111-1111-1111-1111-111111111111";

test("getOrderPaymentContext: appelle EXACTEMENT get_order_payment_context avec p_order_id/p_public_token, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ restaurant_id: "resto-1", payment_status: "paid" }],
      error: null,
    };
  });

  await getOrderPaymentContext({
    orderId: "order-1",
    publicToken: "token-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_order_payment_context");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_order_id",
    "p_public_token",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, "order-1");
  assert.equal(args.p_public_token, "token-1");
});

test("getOrderPaymentContext: un restaurant_id/provider_code fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ restaurant_id: "resto-2", payment_status: "pending" }],
      error: null,
    };
  });

  const maliciousInput = {
    orderId: "order-2",
    publicToken: "token-2",
    // Champs qui n'existent PAS dans GetOrderPaymentContextInput --
    // simule un appelant qui tenterait de faire passer un tenant/
    // prestataire comme s'il était déjà connu, plutôt que de le faire
    // dériver par la RPC elle-même (mission §6, "No tenant ID from
    // caller").
    restaurantId: "should-never-be-sent",
    providerCode: "monetico",
    paymentStatus: "paid",
  };
  await getOrderPaymentContext(
    maliciousInput as unknown as Parameters<typeof getOrderPaymentContext>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_order_id", "p_public_token"]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes("monetico"), "un provider_code fourni par l'appelant ne doit jamais être transmis à la RPC");
});

test("getOrderPaymentContext: mapping succès -> les DEUX champs (restaurantId/paymentStatus) exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ restaurant_id: "resto-3", payment_status: "paid" }],
    error: null,
  }));

  const result = await getOrderPaymentContext({
    orderId: "order-3",
    publicToken: "token-3",
  });
  assert.deepEqual(result, {
    restaurantId: "resto-3",
    paymentStatus: "paid",
  });
});

for (const status of ["not_required", "pending", "paid", "failed", "cancelled"] as const) {
  test(`getOrderPaymentContext: paymentStatus="${status}" préservé EXACTEMENT, sans normalisation ni réinterprétation ajoutée par le wrapper`, async (t) => {
    t.mock.method(client, "rpc", async () => ({
      data: [{ restaurant_id: `resto-status-${status}`, payment_status: status }],
      error: null,
    }));
    const result = await getOrderPaymentContext({
      orderId: `order-status-${status}`,
      publicToken: `token-status-${status}`,
    });
    assert.equal(result.paymentStatus, status);
    assert.equal(typeof result.paymentStatus, "string");
  });
}

test("getOrderPaymentContext: le résultat ne contient JAMAIS de champ order_number/total/currency/public_token/credential, même si la RPC en renvoyait un (cast, dérive future du SQL simulée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        restaurant_id: "resto-4",
        payment_status: "paid",
        // Champs qui n'existent PAS dans le contrat documenté de la
        // RPC -- simule une future dérive du SQL ; le wrapper ne doit
        // jamais les propager silencieusement.
        id: "should-never-be-sent",
        order_number: "should-never-be-sent",
        public_token: FAKE_TOKEN,
        total: "should-never-be-sent",
        currency: "should-never-be-sent",
        customer_phone: "should-never-be-sent",
        credentials_ref: "should-never-be-sent",
      },
    ],
    error: null,
  }));

  const result = await getOrderPaymentContext({
    orderId: "order-4",
    publicToken: "token-4",
  });
  assert.deepEqual(Object.keys(result).sort(), ["paymentStatus", "restaurantId"]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes(FAKE_TOKEN));
});

test("getOrderPaymentContext: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
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
      getOrderPaymentContext({
        orderId: "order-5",
        publicToken: FAKE_TOKEN,
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

test("getOrderPaymentContext: résultat vide/absent (possession invalide -- mauvais jeton, mauvaise commande, ou inconnue) -> PaymentServerRpcError générique, indiscernable d'une autre panne RPC (mission §7/§17, possession confidentiality)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () =>
      getOrderPaymentContext({
        orderId: "order-6",
        publicToken: "wrong-token",
      }),
    PaymentServerRpcError
  );

  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () =>
      getOrderPaymentContext({
        orderId: "order-6",
        publicToken: "wrong-token",
      }),
    PaymentServerRpcError
  );
});

test("getOrderPaymentContext: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      getOrderPaymentContext({
        orderId: "order-7",
        publicToken: "token-7",
      }),
    PaymentServerUnavailableError
  );
});

test("getOrderPaymentContext: aucune valeur ne fuit jamais dans console.log/error/warn (succès comme échec), notamment jamais le public_token", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: [{ restaurant_id: "resto-8", payment_status: "paid" }],
    error: null,
  }));
  await getOrderPaymentContext({ orderId: "order-8", publicToken: FAKE_TOKEN });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    getOrderPaymentContext({ orderId: "order-8", publicToken: FAKE_TOKEN })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
  assert.ok(!combined.includes(FAKE_TOKEN), "le public_token est apparu dans une sortie console");
});

test("getOrderPaymentContext: aucun accès table direct -- ce wrapper appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({
    data: [{ restaurant_id: "resto-9", payment_status: "paid" }],
    error: null,
  }));

  await getOrderPaymentContext({ orderId: "order-9", publicToken: "token-9" });
  assert.equal(fromCalled, false, "getOrderPaymentContext ne doit jamais interroger une table directement");
});
