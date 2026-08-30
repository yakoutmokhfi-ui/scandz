import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1.
//
// Couvre les DEUX wrappers TypeScript ajoutés par ce lot dans
// lib/server/payment-service.ts : getOrderBillingContext /
// setOrderBillingContext (get_order_billing_context /
// set_order_billing_context, service_role UNIQUEMENT). Même patron
// déjà établi (tests/v113..v117) : `t.mock.method(client, "rpc", ...)`
// sur le CLIENT RÉEL construit par getServiceRoleSupabaseClient().
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b6-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { getOrderBillingContext, setOrderBillingContext } = await import(
  "../lib/server/payment-service.ts"
);
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "22023";
const FAKE_SECRET_IN_ERROR = "p3b6-fake-secret-in-error-DO-NOT-USE";

// --------------------------------------------------------------
// getOrderBillingContext
// --------------------------------------------------------------

test("getOrderBillingContext: appelle EXACTEMENT get_order_billing_context avec p_order_id/p_public_token, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [
        {
          source: "manual",
          address_line_1: "1 rue Test",
          address_line_2: null,
          city: "Paris",
          postal_code: "75001",
          country: "FR",
          state_or_province: null,
          customer_name: null,
          customer_email: null,
          customer_phone: null,
        },
      ],
      error: null,
    };
  });

  await getOrderBillingContext({ orderId: "order-1", publicToken: "token-1" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_order_billing_context");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_order_id",
    "p_public_token",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, "order-1");
  assert.equal(args.p_public_token, "token-1");
});

test("getOrderBillingContext: mappe intégralement la ligne snake_case vers le vocabulaire interne camelCase", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        source: "delivery_reuse",
        address_line_1: "12 rue de Paris",
        address_line_2: "Bat B",
        city: "Paris",
        postal_code: "75001",
        country: "FR",
        state_or_province: "IDF",
        customer_name: "Jean Dupont",
        customer_email: "jean@example.com",
        customer_phone: "0612345678",
      },
    ],
    error: null,
  }));

  const result = await getOrderBillingContext({ orderId: "order-2", publicToken: "token-2" });

  assert.deepEqual(result, {
    source: "delivery_reuse",
    addressLine1: "12 rue de Paris",
    addressLine2: "Bat B",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
    stateOrProvince: "IDF",
    customerName: "Jean Dupont",
    customerEmail: "jean@example.com",
    customerPhone: "0612345678",
  });
});

test("getOrderBillingContext: résultat VIDE (aucun contexte encore assemblé -- absence légitime, mandat §6) -> null, JAMAIS une exception", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));

  const result = await getOrderBillingContext({ orderId: "order-3", publicToken: "token-3" });

  assert.equal(result, null);
});

test("getOrderBillingContext: data=null (même contrat qu'un ensemble vide) -> null également", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));

  const result = await getOrderBillingContext({ orderId: "order-4", publicToken: "token-4" });

  assert.equal(result, null);
});

test("getOrderBillingContext: erreur RPC (possession invalide ou panne) -> PaymentServerRpcError, message générique, secret jamais exposé", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));

  await assert.rejects(
    () => getOrderBillingContext({ orderId: "order-5", publicToken: "token-5" }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      assert.ok(!String((err as Error).message).includes(FAKE_SECRET_IN_ERROR));
      return true;
    }
  );
});

test("getOrderBillingContext: rejet réseau/inattendu -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("network down");
  });

  await assert.rejects(
    () => getOrderBillingContext({ orderId: "order-6", publicToken: "token-6" }),
    PaymentServerUnavailableError
  );
});

// v2 CORRECTIF -- ferme P3B6-SOURCE-MAPPING-01 : le mauvais motif
// précédent ("tout ce qui n'est pas 'manual' devient 'delivery_reuse'")
// aurait silencieusement accepté n'importe quelle dérive de la RPC ici.
// Toute valeur autre que "manual"/"delivery_reuse" doit désormais échouer
// fermé, jamais être transformée en "delivery_reuse" par défaut.
for (const badSource of ["automatic", "", "MANUAL", "Delivery_Reuse", null, undefined]) {
  test(`getOrderBillingContext: source RPC inattendue (${JSON.stringify(badSource)}) -> PaymentServerRpcError, JAMAIS un défaut "delivery_reuse" fabriqué`, async (t) => {
    t.mock.method(client, "rpc", async () => ({
      data: [
        {
          source: badSource,
          address_line_1: "1 rue Test",
          address_line_2: null,
          city: "Paris",
          postal_code: "75001",
          country: "FR",
          state_or_province: null,
          customer_name: null,
          customer_email: null,
          customer_phone: null,
        },
      ],
      error: null,
    }));

    await assert.rejects(
      () => getOrderBillingContext({ orderId: "order-bad-source", publicToken: "token-bad-source" }),
      PaymentServerRpcError
    );
  });
}

// --------------------------------------------------------------
// setOrderBillingContext
// --------------------------------------------------------------

test("setOrderBillingContext: appelle EXACTEMENT set_order_billing_context avec les 12 paramètres attendus, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ order_id: "order-7", source: "manual", updated_at: "2026-01-01T00:00:00Z" }],
      error: null,
    };
  });

  await setOrderBillingContext({
    orderId: "order-7",
    publicToken: "token-7",
    source: "manual",
    addressLine1: "1 rue Test",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "set_order_billing_context");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_address_line_1",
    "p_address_line_2",
    "p_city",
    "p_country",
    "p_customer_email",
    "p_customer_name",
    "p_customer_phone",
    "p_order_id",
    "p_postal_code",
    "p_public_token",
    "p_source",
    "p_state_or_province",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, "order-7");
  assert.equal(args.p_public_token, "token-7");
  assert.equal(args.p_source, "manual");
  assert.equal(args.p_address_line_1, "1 rue Test");
  assert.equal(args.p_address_line_2, null);
  assert.equal(args.p_city, "Paris");
  assert.equal(args.p_postal_code, "75001");
  assert.equal(args.p_country, "FR");
  assert.equal(args.p_state_or_province, null);
  assert.equal(args.p_customer_name, null);
  assert.equal(args.p_customer_email, null);
  assert.equal(args.p_customer_phone, null);
});

test("setOrderBillingContext: country toujours transmis EXPLICITEMENT tel que fourni par l'appelant -- jamais inventé/déduit ici (mandat §12)", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ order_id: "order-8", source: "delivery_reuse", updated_at: "2026-01-01T00:00:00Z" }],
      error: null,
    };
  });

  await setOrderBillingContext({
    orderId: "order-8",
    publicToken: "token-8",
    source: "delivery_reuse",
    country: "be",
  });

  assert.equal(sentArgs!.p_country, "be");
  // Ce wrapper ne normalise/valide JAMAIS lui-même le pays -- cette
  // responsabilité appartient exclusivement à la RPC (mandat §23,
  // "no duplicated validation").
});

test("setOrderBillingContext: un restaurant_id/provider_code fourni artificiellement (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ order_id: "order-9", source: "manual", updated_at: "2026-01-01T00:00:00Z" }],
      error: null,
    };
  });

  const maliciousInput = {
    orderId: "order-9",
    publicToken: "token-9",
    source: "manual",
    addressLine1: "1 rue Test",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
    restaurantId: "resto-should-be-ignored",
    providerCode: "monetico",
  };

  await setOrderBillingContext(
    maliciousInput as unknown as Parameters<typeof setOrderBillingContext>[0]
  );

  assert.deepEqual(Object.keys(sentArgs!).sort(), [
    "p_address_line_1",
    "p_address_line_2",
    "p_city",
    "p_country",
    "p_customer_email",
    "p_customer_name",
    "p_customer_phone",
    "p_order_id",
    "p_postal_code",
    "p_public_token",
    "p_source",
    "p_state_or_province",
  ]);
});

test("setOrderBillingContext: résultat mappé fidèlement (orderId/source/updatedAt)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ order_id: "order-10", source: "manual", updated_at: "2026-06-01T12:00:00Z" }],
    error: null,
  }));

  const result = await setOrderBillingContext({
    orderId: "order-10",
    publicToken: "token-10",
    source: "manual",
    addressLine1: "1 rue Test",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  });

  assert.deepEqual(result, {
    orderId: "order-10",
    source: "manual",
    updatedAt: "2026-06-01T12:00:00Z",
  });
});

test("setOrderBillingContext: erreur RPC (ex. validation fail-closed) -> PaymentServerRpcError, secret jamais exposé", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));

  await assert.rejects(
    () =>
      setOrderBillingContext({
        orderId: "order-11",
        publicToken: "token-11",
        source: "manual",
        country: "FR",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      assert.ok(!String((err as Error).message).includes(FAKE_SECRET_IN_ERROR));
      return true;
    }
  );
});

test("setOrderBillingContext: résultat vide inattendu -> PaymentServerRpcError (jamais silencieusement toléré)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));

  await assert.rejects(
    () =>
      setOrderBillingContext({
        orderId: "order-12",
        publicToken: "token-12",
        source: "manual",
        country: "FR",
      }),
    PaymentServerRpcError
  );
});

test("setOrderBillingContext: rejet réseau/inattendu -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("network down");
  });

  await assert.rejects(
    () =>
      setOrderBillingContext({
        orderId: "order-13",
        publicToken: "token-13",
        source: "manual",
        country: "FR",
      }),
    PaymentServerUnavailableError
  );
});

// v2 CORRECTIF -- ferme P3B6-SOURCE-MAPPING-01 (voir le test analogue
// ci-dessus pour getOrderBillingContext).
test('setOrderBillingContext: source RPC inattendue en retour ("automatic") -> PaymentServerRpcError, JAMAIS un défaut "delivery_reuse" fabriqué', async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ order_id: "order-14", source: "automatic", updated_at: "2026-01-01T00:00:00Z" }],
    error: null,
  }));

  await assert.rejects(
    () =>
      setOrderBillingContext({
        orderId: "order-14",
        publicToken: "token-14",
        source: "manual",
        country: "FR",
      }),
    PaymentServerRpcError
  );
});
