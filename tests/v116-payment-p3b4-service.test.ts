import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B4 — PROVIDER RUNTIME MODE READ v1.
//
// Ferme PAY-P3B-V2-06 ("deux autorités d'environnement non
// corrélées") : le candidat v2 rejeté introduisait une variable
// d'environnement globale `PAYMENT_MONETICO_MODE` qui pouvait diverger
// de `payment_provider_configs.mode`, déjà persisté et tenant-scopé
// (PAYMENT P2A). Ce lot expose ce `mode` déjà persisté, pour la
// première fois, comme SEULE autorité d'environnement runtime.
//
// Couvre le SEUL wrapper TypeScript ajouté par ce lot :
// lib/server/payment-service.ts::getPaymentRuntimeProviderEnvironment
// (`get_payment_runtime_provider_environment`, service_role
// UNIQUEMENT, capacité SŒUR de PAYMENT P3-B1 -- ne modifie ni ne
// remplace `getPaymentRuntimeProviderConfig`, testée séparément par
// tests/v113-payment-p3b1-service.test.ts).
//
// Patron déjà établi par ce dépôt (tests/v113-payment-p3b1-
// service.test.ts et les fichiers similaires) : `t.mock.method(client,
// "rpc", ...)` sur le CLIENT RÉEL construit par
// getServiceRoleSupabaseClient() (une seule construction partagée par
// tout ce fichier).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b4-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { getPaymentRuntimeProviderEnvironment } = await import("../lib/server/payment-service.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3b4-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "payment_provider_configs_internal_fake";

test("getPaymentRuntimeProviderEnvironment: appelle EXACTEMENT get_payment_runtime_provider_environment avec p_restaurant_id/p_provider_code, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [
        { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
      ],
      error: null,
    };
  });

  await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-1",
    providerCode: "monetico",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_payment_runtime_provider_environment");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_provider_code",
    "p_restaurant_id",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_restaurant_id, "resto-1");
  assert.equal(args.p_provider_code, "monetico");
});

test("getPaymentRuntimeProviderEnvironment: un mode/credential/secret fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [
        { provider_code: "monetico", is_enabled: false, configuration_status: "configured", mode: "live" },
      ],
      error: null,
    };
  });

  const maliciousInput = {
    restaurantId: "resto-2",
    providerCode: "monetico",
    // Champs qui n'existent PAS dans GetPaymentRuntimeProviderEnvironmentInput
    // -- simule un appelant qui tenterait de forcer un mode/état déjà
    // "connu" plutôt que de le faire vérifier par la RPC elle-même.
    mode: "live",
    isEnabled: true,
    configurationStatus: "verified",
    credentialsRef: "should-never-be-sent",
    securityKey: "should-never-be-sent",
    // Tentative explicite d'injection d'une variable d'environnement
    // globale de type PAYMENT_MONETICO_MODE simulée via l'input --
    // ne doit jamais atteindre la RPC (ferme PAY-P3B-V2-06).
    PAYMENT_MONETICO_MODE: "sandbox-should-never-be-sent",
  };
  await getPaymentRuntimeProviderEnvironment(
    maliciousInput as unknown as Parameters<typeof getPaymentRuntimeProviderEnvironment>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_provider_code", "p_restaurant_id"]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes("sandbox"), "aucune valeur de mode fournie par l'appelant ne doit jamais être transmise à la RPC");
});

test("getPaymentRuntimeProviderEnvironment: mapping succès -> les QUATRE champs (providerCode/isEnabled/configurationStatus/mode) exacts", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
    ],
    error: null,
  }));

  const result = await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-3",
    providerCode: "monetico",
  });
  assert.deepEqual(result, {
    providerCode: "monetico",
    isEnabled: true,
    configurationStatus: "verified",
    mode: "test",
  });
});

for (const mode of ["test", "live"] as const) {
  test(`getPaymentRuntimeProviderEnvironment: mode="${mode}" préservé EXACTEMENT (union stricte "test"|"live", jamais renommé/normalisé)`, async (t) => {
    t.mock.method(client, "rpc", async () => ({
      data: [
        { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode },
      ],
      error: null,
    }));
    const result = await getPaymentRuntimeProviderEnvironment({
      restaurantId: `resto-mode-${mode}`,
      providerCode: "monetico",
    });
    assert.equal(result.mode, mode);
    assert.equal(typeof result.mode, "string");
  });
}

// PREUVE CENTRALE DE CE LOT (miroir du test comportemental SQL 2e/2f) :
// deux tenants avec des modes différents ne doivent jamais être
// confondus par le wrapper -- aucune valeur en dur, aucun mélange.
test("getPaymentRuntimeProviderEnvironment: deux tenants avec des modes différents restent isolés au niveau du wrapper (aucune valeur en dur, aucun mélange)", async (t) => {
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    const a = args as Record<string, unknown>;
    if (a.p_restaurant_id === "resto-tenant-un") {
      return {
        data: [
          { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
        ],
        error: null,
      };
    }
    return {
      data: [
        { provider_code: "monetico", is_enabled: false, configuration_status: "configured", mode: "live" },
      ],
      error: null,
    };
  });

  const resultOne = await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-tenant-un",
    providerCode: "monetico",
  });
  const resultTwo = await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-tenant-deux",
    providerCode: "monetico",
  });

  assert.equal(resultOne.mode, "test");
  assert.equal(resultTwo.mode, "live");
  assert.notEqual(resultOne.mode, resultTwo.mode);
});

test("getPaymentRuntimeProviderEnvironment: mode hors union stricte (dérive de schéma simulée, ex. 'sandbox'/'production'/'') -> PaymentServerRpcError générique, échec fermé", async (t) => {
  for (const badMode of ["sandbox", "production", "", "TEST", "live ", null, undefined]) {
    t.mock.method(client, "rpc", async () => ({
      data: [
        { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: badMode },
      ],
      error: null,
    }));
    await assert.rejects(
      () =>
        getPaymentRuntimeProviderEnvironment({
          restaurantId: "resto-bad-mode",
          providerCode: "monetico",
        }),
      PaymentServerRpcError,
      `mode=${JSON.stringify(badMode)} aurait dû être rejeté (échec fermé)`
    );
  }
});

test("getPaymentRuntimeProviderEnvironment: isEnabled=false préservé EXACTEMENT (jamais confondu avec absence de valeur ni forcé à true)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      { provider_code: "monetico", is_enabled: false, configuration_status: "configured", mode: "live" },
    ],
    error: null,
  }));
  const result = await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-4",
    providerCode: "monetico",
  });
  assert.equal(result.isEnabled, false);
  assert.equal(typeof result.isEnabled, "boolean");
});

test("getPaymentRuntimeProviderEnvironment: isEnabled=true préservé EXACTEMENT", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
    ],
    error: null,
  }));
  const result = await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-5",
    providerCode: "monetico",
  });
  assert.equal(result.isEnabled, true);
  assert.equal(typeof result.isEnabled, "boolean");
});

for (const status of ["not_configured", "configured", "verified"] as const) {
  test(`getPaymentRuntimeProviderEnvironment: configurationStatus="${status}" préservée EXACTEMENT, sans normalisation ajoutée par le wrapper (contrairement à mode, non validée par une union stricte -- même politique que PAYMENT P3-B1)`, async (t) => {
    t.mock.method(client, "rpc", async () => ({
      data: [
        { provider_code: "monetico", is_enabled: false, configuration_status: status, mode: "test" },
      ],
      error: null,
    }));
    const result = await getPaymentRuntimeProviderEnvironment({
      restaurantId: `resto-status-${status}`,
      providerCode: "monetico",
    });
    assert.equal(result.configurationStatus, status);
    assert.equal(typeof result.configurationStatus, "string");
  });
}

test("getPaymentRuntimeProviderEnvironment: le résultat ne contient JAMAIS de champ credential/Vault/id/restaurant_id, même si la RPC en renvoyait un (cast, dérive future du SQL simulée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        provider_code: "monetico",
        is_enabled: true,
        configuration_status: "verified",
        mode: "test",
        // Champs qui n'existent PAS dans le contrat documenté de la
        // RPC -- simule une future dérive du SQL ; le wrapper ne doit
        // jamais les propager silencieusement.
        id: "should-never-be-sent",
        restaurant_id: "should-never-be-sent",
        credentials_ref: "should-never-be-sent",
        decrypted_secret: "should-never-be-sent",
        last_verified_at: "should-never-be-sent",
        updated_at: "should-never-be-sent",
      },
    ],
    error: null,
  }));

  const result = await getPaymentRuntimeProviderEnvironment({
    restaurantId: "resto-6",
    providerCode: "monetico",
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "configurationStatus",
    "isEnabled",
    "mode",
    "providerCode",
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("getPaymentRuntimeProviderEnvironment: erreur RPC (SQLSTATE/table/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
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
      getPaymentRuntimeProviderEnvironment({
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

test("getPaymentRuntimeProviderEnvironment: résultat vide/absent (aucune ligne, ex. restaurant/provider inconnu) -> PaymentServerRpcError générique (jamais un undefined silencieusement propagé)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () =>
      getPaymentRuntimeProviderEnvironment({
        restaurantId: "resto-8",
        providerCode: "monetico",
      }),
    PaymentServerRpcError
  );

  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () =>
      getPaymentRuntimeProviderEnvironment({
        restaurantId: "resto-8",
        providerCode: "monetico",
      }),
    PaymentServerRpcError
  );
});

test("getPaymentRuntimeProviderEnvironment: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      getPaymentRuntimeProviderEnvironment({
        restaurantId: "resto-9",
        providerCode: "monetico",
      }),
    PaymentServerUnavailableError
  );
});

test("getPaymentRuntimeProviderEnvironment: aucune valeur ne fuit jamais dans console.log/error/warn (succès comme échec, y compris mode invalide)", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: [
      { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
    ],
    error: null,
  }));
  await getPaymentRuntimeProviderEnvironment({ restaurantId: "resto-10", providerCode: "monetico" });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    getPaymentRuntimeProviderEnvironment({ restaurantId: "resto-10", providerCode: "monetico" })
  );

  t.mock.method(client, "rpc", async () => ({
    data: [
      { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "sandbox" },
    ],
    error: null,
  }));
  await assert.rejects(() =>
    getPaymentRuntimeProviderEnvironment({ restaurantId: "resto-10", providerCode: "monetico" })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
});

test("getPaymentRuntimeProviderEnvironment: aucun accès table direct -- ce wrapper appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({
    data: [
      { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
    ],
    error: null,
  }));

  await getPaymentRuntimeProviderEnvironment({ restaurantId: "resto-11", providerCode: "monetico" });
  assert.equal(fromCalled, false, "getPaymentRuntimeProviderEnvironment ne doit jamais interroger une table directement");
});

test("getPaymentRuntimeProviderEnvironment: la RPC PAYMENT P3-B1 (get_payment_runtime_provider_config) n'est jamais appelée par ce wrapper (capacité sœur indépendante, aucun appel imbriqué)", async (t) => {
  const rpcNames: string[] = [];
  t.mock.method(client, "rpc", async (name: string) => {
    rpcNames.push(name);
    return {
      data: [
        { provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" },
      ],
      error: null,
    };
  });

  await getPaymentRuntimeProviderEnvironment({ restaurantId: "resto-12", providerCode: "monetico" });
  assert.deepEqual(rpcNames, ["get_payment_runtime_provider_environment"]);
  assert.ok(!rpcNames.includes("get_payment_runtime_provider_config"));
});
