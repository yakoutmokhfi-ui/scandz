import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
// Couvre lib/server/payment-service.ts : les trois enveloppes RPC
// typées (initiate/confirm/credential), la sanitisation d'erreur
// (mandat §14/§16/§28), et l'absence totale de fuite du secret retourné
// par getPaymentProviderCredential (mandat §21/§27).
//
// Patron déjà établi par ce dépôt (tests/v109b-dashboard-payment-
// service.test.ts) : `t.mock.method(client, "rpc", ...)` sur le CLIENT
// RÉEL construit par getServiceRoleSupabaseClient() (une seule
// construction partagée par tout ce fichier, mandat §37 -- singleton
// paresseux) plutôt qu'un mock de createClient lui-même.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
// Marqueur synthétique DISTINCTIF (mandat §21/§35) -- jamais une
// valeur plausible de vraie clé service_role.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3a1-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiatePaymentAttempt, confirmPaymentAttempt, getPaymentProviderCredential } =
  await import("../lib/server/payment-service.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

// Marqueurs internes synthétiques utilisés pour prouver la
// sanitisation -- jamais un vrai SQLSTATE/table de Production.
const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3a1-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "payment_provider_configs_internal_fake";

// --------------------------------------------------------------
// initiate_payment_attempt
// --------------------------------------------------------------

test("initiatePaymentAttempt: appelle EXACTEMENT initiate_payment_attempt avec p_order_id/p_provider_code/p_provider_reference, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ transaction_id: "txn-1", amount: 12.5, currency: "EUR" }],
      error: null,
    };
  });

  await initiatePaymentAttempt({
    orderId: "order-1",
    providerCode: "fixture-provider",
    providerReference: "ref-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "initiate_payment_attempt");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_order_id",
    "p_provider_code",
    "p_provider_reference",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, "order-1");
  assert.equal(args.p_provider_code, "fixture-provider");
  assert.equal(args.p_provider_reference, "ref-1");
});

test("initiatePaymentAttempt: un montant/devise/restaurant_id fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ transaction_id: "txn-2", amount: 5, currency: "EUR" }],
      error: null,
    };
  });

  const maliciousInput = {
    orderId: "order-2",
    providerCode: "fixture-provider",
    providerReference: "ref-2",
    // Champs qui n'existent PAS dans InitiatePaymentAttemptInput --
    // simule un appelant compilé de façon laxiste / un cast `as any`.
    amount: 999999,
    currency: "XXX",
    restaurantId: "should-never-be-sent",
  };
  await initiatePaymentAttempt(maliciousInput as unknown as Parameters<typeof initiatePaymentAttempt>[0]);

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), [
    "p_order_id",
    "p_provider_code",
    "p_provider_reference",
  ]);
});

test("initiatePaymentAttempt: mapping succès -> transactionId/amount/currency exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ transaction_id: "txn-3", amount: "42.75", currency: "EUR" }],
    error: null,
  }));

  const result = await initiatePaymentAttempt({
    orderId: "order-3",
    providerCode: "fixture-provider",
    providerReference: "ref-3",
  });
  assert.deepEqual(result, { transactionId: "txn-3", amount: 42.75, currency: "EUR" });
});

test("initiatePaymentAttempt: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: FAKE_SQLSTATE,
      message: `relation "${FAKE_TABLE_NAME}" violates constraint, secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: FAKE_TABLE_NAME,
    },
  }));

  await assert.rejects(
    () =>
      initiatePaymentAttempt({
        orderId: "order-4",
        providerCode: "fixture-provider",
        providerReference: "ref-4",
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

test("initiatePaymentAttempt: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      initiatePaymentAttempt({
        orderId: "order-5",
        providerCode: "fixture-provider",
        providerReference: "ref-5",
      }),
    PaymentServerUnavailableError
  );
});

// --------------------------------------------------------------
// confirm_payment_attempt
// --------------------------------------------------------------

test("confirmPaymentAttempt: appelle EXACTEMENT confirm_payment_attempt avec les 4 arguments documentés (p_authorization_reference=null si omis)", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ transaction_id: "txn-6", order_id: "order-6", status: "paid" }],
      error: null,
    };
  });

  await confirmPaymentAttempt({
    providerCode: "fixture-provider",
    providerReference: "ref-6",
    status: "paid",
  });

  assert.equal(calls[0]!.name, "confirm_payment_attempt");
  const args = calls[0]!.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), [
    "p_authorization_reference",
    "p_provider_code",
    "p_provider_reference",
    "p_status",
  ]);
  assert.equal(args.p_provider_code, "fixture-provider");
  assert.equal(args.p_provider_reference, "ref-6");
  assert.equal(args.p_status, "paid");
  assert.equal(args.p_authorization_reference, null);
});

test("confirmPaymentAttempt: une charge brute spécifique à un prestataire (cast) n'est jamais transmise à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ transaction_id: "txn-7", order_id: "order-7", status: "paid" }],
      error: null,
    };
  });

  const maliciousInput = {
    providerCode: "fixture-provider",
    providerReference: "ref-7",
    status: "paid" as const,
    authorizationReference: "auth-7",
    // Champs qui n'existent PAS dans ConfirmPaymentAttemptInput --
    // simule un futur callback provider mal encapsulé.
    rawPayload: { MAC: "should-never-be-sent", TPE: "should-never-be-sent" },
    macKey: "should-never-be-sent",
  };
  await confirmPaymentAttempt(maliciousInput as unknown as Parameters<typeof confirmPaymentAttempt>[0]);

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), [
    "p_authorization_reference",
    "p_provider_code",
    "p_provider_reference",
    "p_status",
  ]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("confirmPaymentAttempt: mapping succès -> transactionId/orderId/status exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ transaction_id: "txn-8", order_id: "order-8", status: "failed" }],
    error: null,
  }));
  const result = await confirmPaymentAttempt({
    providerCode: "fixture-provider",
    providerReference: "ref-8",
    status: "failed",
  });
  assert.deepEqual(result, { transactionId: "txn-8", orderId: "order-8", status: "failed" });
});

test("confirmPaymentAttempt: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: FAKE_SQLSTATE,
      message: `duplicate key in "${FAKE_TABLE_NAME}", secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: null,
    },
  }));

  await assert.rejects(
    () =>
      confirmPaymentAttempt({
        providerCode: "fixture-provider",
        providerReference: "ref-9",
        status: "paid",
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

// --------------------------------------------------------------
// get_payment_provider_credential
// --------------------------------------------------------------

const SYNTHETIC_CREDENTIAL = "p3a1-synthetic-credential-value-DO-NOT-USE";

test("getPaymentProviderCredential: appelle EXACTEMENT get_payment_provider_credential avec p_restaurant_id/p_provider_code", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: SYNTHETIC_CREDENTIAL, error: null };
  });

  await getPaymentProviderCredential({ restaurantId: "r-1", providerCode: "fixture-provider" });

  assert.equal(calls[0]!.name, "get_payment_provider_credential");
  const args = calls[0]!.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), ["p_provider_code", "p_restaurant_id"]);
  assert.equal(args.p_restaurant_id, "r-1");
  assert.equal(args.p_provider_code, "fixture-provider");
});

test("getPaymentProviderCredential: succès -> renvoie EXACTEMENT le secret (chaîne nue, jamais enveloppée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: SYNTHETIC_CREDENTIAL, error: null }));
  const result = await getPaymentProviderCredential({
    restaurantId: "r-2",
    providerCode: "fixture-provider",
  });
  assert.equal(result, SYNTHETIC_CREDENTIAL);
  assert.equal(typeof result, "string");
});

test("getPaymentProviderCredential: le secret n'est JAMAIS journalisé (log/error/warn), succès comme échec", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({ data: SYNTHETIC_CREDENTIAL, error: null }));
  await getPaymentProviderCredential({ restaurantId: "r-3", providerCode: "fixture-provider" });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${SYNTHETIC_CREDENTIAL}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    getPaymentProviderCredential({ restaurantId: "r-3", providerCode: "fixture-provider" })
  );

  const combined = seen.join("\n");
  assert.ok(
    !combined.includes(SYNTHETIC_CREDENTIAL),
    "le secret synthétique est apparu dans une sortie console"
  );
});

test("getPaymentProviderCredential: erreur RPC (secret/SQLSTATE/table factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: FAKE_SQLSTATE,
      message: `vault reference invalid in "${FAKE_TABLE_NAME}", secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: FAKE_TABLE_NAME,
    },
  }));

  await assert.rejects(
    () => getPaymentProviderCredential({ restaurantId: "r-4", providerCode: "fixture-provider" }),
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

test("getPaymentProviderCredential: résultat vide/non-chaîne -> PaymentServerRpcError générique (jamais une chaîne vide silencieusement acceptée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: "", error: null }));
  await assert.rejects(
    () => getPaymentProviderCredential({ restaurantId: "r-5", providerCode: "fixture-provider" }),
    PaymentServerRpcError
  );

  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () => getPaymentProviderCredential({ restaurantId: "r-5", providerCode: "fixture-provider" }),
    PaymentServerRpcError
  );
});
