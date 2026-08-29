import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B1 — RUNTIME PROVIDER ENABLEMENT READ v1.
//
// Répond au STOP — PAYMENT P3-B RUNTIME PROVIDER CONFIG CAPABILITY
// REQUIRED soulevé par PAYMENT P3-B MONETICO CHECKOUT RUNTIME v1 :
// avant tout appel à `initiatePaymentAttempt`, un futur runtime doit
// pouvoir vérifier que le prestataire sélectionné est réellement
// activé pour le tenant concerné -- capacité que ni
// `get_merchant_payment_provider_config` (authenticated + membership)
// ni `getPaymentProviderCredential` (ne lit pas is_enabled) ne
// fournissaient.
//
// Couvre le SEUL wrapper TypeScript ajouté par ce lot :
// lib/server/payment-service.ts::getPaymentRuntimeProviderConfig
// (`get_payment_runtime_provider_config`, service_role UNIQUEMENT).
//
// Patron déjà établi par ce dépôt (tests/v110b-payment-p3a1-
// service.test.ts, tests/v112-payment-p3b0-service.test.ts) :
// `t.mock.method(client, "rpc", ...)` sur le CLIENT RÉEL construit par
// getServiceRoleSupabaseClient() (une seule construction partagée par
// tout ce fichier).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b1-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { getPaymentRuntimeProviderConfig } = await import("../lib/server/payment-service.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3b1-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "payment_provider_configs_internal_fake";

test("getPaymentRuntimeProviderConfig: appelle EXACTEMENT get_payment_runtime_provider_config avec p_restaurant_id/p_provider_code, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ provider_code: "monetico", is_enabled: true, configuration_status: "verified" }],
      error: null,
    };
  });

  await getPaymentRuntimeProviderConfig({
    restaurantId: "resto-1",
    providerCode: "monetico",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_payment_runtime_provider_config");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_provider_code",
    "p_restaurant_id",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_restaurant_id, "resto-1");
  assert.equal(args.p_provider_code, "monetico");
});

test("getPaymentRuntimeProviderConfig: un credential/secret/configuration_status fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [{ provider_code: "monetico", is_enabled: false, configuration_status: "configured" }],
      error: null,
    };
  });

  const maliciousInput = {
    restaurantId: "resto-2",
    providerCode: "monetico",
    // Champs qui n'existent PAS dans GetPaymentRuntimeProviderConfigInput
    // -- simule un appelant qui tenterait de faire passer un état
    // d'activation/configuration comme s'il était déjà connu, plutôt
    // que de le faire vérifier par la RPC elle-même.
    isEnabled: true,
    configurationStatus: "verified",
    credentialsRef: "should-never-be-sent",
    securityKey: "should-never-be-sent",
  };
  await getPaymentRuntimeProviderConfig(
    maliciousInput as unknown as Parameters<typeof getPaymentRuntimeProviderConfig>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_provider_code", "p_restaurant_id"]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes("verified"), "une configuration_status fournie par l'appelant ne doit jamais être transmise à la RPC");
});

test("getPaymentRuntimeProviderConfig: mapping succès -> les TROIS champs (providerCode/isEnabled/configurationStatus) exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_code: "monetico", is_enabled: true, configuration_status: "verified" }],
    error: null,
  }));

  const result = await getPaymentRuntimeProviderConfig({
    restaurantId: "resto-3",
    providerCode: "monetico",
  });
  assert.deepEqual(result, {
    providerCode: "monetico",
    isEnabled: true,
    configurationStatus: "verified",
  });
});

test("getPaymentRuntimeProviderConfig: isEnabled=false préservé EXACTEMENT (jamais confondu avec absence de valeur ni forcé à true)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_code: "monetico", is_enabled: false, configuration_status: "configured" }],
    error: null,
  }));
  const result = await getPaymentRuntimeProviderConfig({
    restaurantId: "resto-4",
    providerCode: "monetico",
  });
  assert.equal(result.isEnabled, false);
  assert.equal(typeof result.isEnabled, "boolean");
});

test("getPaymentRuntimeProviderConfig: isEnabled=true préservé EXACTEMENT", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_code: "monetico", is_enabled: true, configuration_status: "verified" }],
    error: null,
  }));
  const result = await getPaymentRuntimeProviderConfig({
    restaurantId: "resto-5",
    providerCode: "monetico",
  });
  assert.equal(result.isEnabled, true);
  assert.equal(typeof result.isEnabled, "boolean");
});

for (const status of ["not_configured", "configured", "verified"] as const) {
  test(`getPaymentRuntimeProviderConfig: configurationStatus="${status}" préservée EXACTEMENT, sans normalisation ajoutée par le wrapper`, async (t) => {
    t.mock.method(client, "rpc", async () => ({
      data: [{ provider_code: "monetico", is_enabled: false, configuration_status: status }],
      error: null,
    }));
    const result = await getPaymentRuntimeProviderConfig({
      restaurantId: `resto-status-${status}`,
      providerCode: "monetico",
    });
    assert.equal(result.configurationStatus, status);
    assert.equal(typeof result.configurationStatus, "string");
  });
}

test("getPaymentRuntimeProviderConfig: le résultat ne contient JAMAIS de champ credential/Vault/id/restaurant_id, même si la RPC en renvoyait un (cast, dérive future du SQL simulée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        provider_code: "monetico",
        is_enabled: true,
        configuration_status: "verified",
        // Champs qui n'existent PAS dans le contrat documenté de la
        // RPC -- simule une future dérive du SQL ; le wrapper ne doit
        // jamais les propager silencieusement.
        id: "should-never-be-sent",
        restaurant_id: "should-never-be-sent",
        credentials_ref: "should-never-be-sent",
        decrypted_secret: "should-never-be-sent",
        mode: "should-never-be-sent",
        last_verified_at: "should-never-be-sent",
      },
    ],
    error: null,
  }));

  const result = await getPaymentRuntimeProviderConfig({
    restaurantId: "resto-6",
    providerCode: "monetico",
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "configurationStatus",
    "isEnabled",
    "providerCode",
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("getPaymentRuntimeProviderConfig: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
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
      getPaymentRuntimeProviderConfig({
        restaurantId: "resto-7",
        providerCode: "no-such-provider",
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

test("getPaymentRuntimeProviderConfig: résultat vide/absent (aucune ligne, ex. restaurant/provider inconnu) -> PaymentServerRpcError générique (jamais un undefined silencieusement propagé)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () =>
      getPaymentRuntimeProviderConfig({
        restaurantId: "resto-8",
        providerCode: "monetico",
      }),
    PaymentServerRpcError
  );

  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () =>
      getPaymentRuntimeProviderConfig({
        restaurantId: "resto-8",
        providerCode: "monetico",
      }),
    PaymentServerRpcError
  );
});

test("getPaymentRuntimeProviderConfig: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      getPaymentRuntimeProviderConfig({
        restaurantId: "resto-9",
        providerCode: "monetico",
      }),
    PaymentServerUnavailableError
  );
});

test("getPaymentRuntimeProviderConfig: aucune valeur ne fuit jamais dans console.log/error/warn (succès comme échec)", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_code: "monetico", is_enabled: true, configuration_status: "verified" }],
    error: null,
  }));
  await getPaymentRuntimeProviderConfig({ restaurantId: "resto-10", providerCode: "monetico" });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    getPaymentRuntimeProviderConfig({ restaurantId: "resto-10", providerCode: "monetico" })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
});

test("getPaymentRuntimeProviderConfig: aucun accès table direct -- ce wrapper appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({
    data: [{ provider_code: "monetico", is_enabled: true, configuration_status: "verified" }],
    error: null,
  }));

  await getPaymentRuntimeProviderConfig({ restaurantId: "resto-11", providerCode: "monetico" });
  assert.equal(fromCalled, false, "getPaymentRuntimeProviderConfig ne doit jamais interroger une table directement");
});
