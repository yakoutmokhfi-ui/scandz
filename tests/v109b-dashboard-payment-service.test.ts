import { test } from "node:test";
import assert from "node:assert/strict";

// Import dynamique obligatoire (patron déjà établi,
// tests/v67-product-photos.test.ts, tests/v84-lot2b1.test.ts) : les
// variables d'environnement doivent être définies AVANT que
// lib/supabase.ts ne soit chargé.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { getMerchantPaymentProviderConfig } = await import("../lib/services/dashboard.ts");

// ====================================================================
// Scanym — PAYMENT P2B-B — preuve COMPORTEMENTALE (pas un grep de
// source) que le mapping du service marchand est réellement une
// liste blanche : même si la RPC mockée renvoie une ligne malicieuse
// avec des propriétés supplémentaires inattendues (credentials_ref,
// secret, vault_id, id, restaurant_id...), l'objet DTO réellement
// retourné par getMerchantPaymentProviderConfig() ne les contient
// JAMAIS (mission section 42 : "even if a mocked/backend row contains
// unexpected extra properties, they must not survive the DTO
// mapping").
// ====================================================================

test("P2B-B service: appelle EXACTEMENT get_merchant_payment_provider_config avec p_restaurant_id, jamais une autre RPC ni une table directe", async (t) => {
  const calledRpcNames: string[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calledRpcNames.push(name);
    if (name === "get_merchant_payment_provider_config") {
      assert.deepEqual(Object.keys(args), ["p_restaurant_id"]);
      assert.equal(args.p_restaurant_id, "r-test-1");
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  t.mock.method(supabase, "from", (table: string) => {
    throw new Error(`table inattendue dans ce test (accès direct interdit) : ${table}`);
  });

  await getMerchantPaymentProviderConfig("r-test-1");
  assert.deepEqual(calledRpcNames, ["get_merchant_payment_provider_config"]);
});

test("P2B-B service: mapping propre (ligne saine à 6 colonnes) -> DTO camelCase exact, aucune clé en trop", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    return {
      data: [
        {
          provider_code: "monetico",
          mode: "test",
          configuration_status: "configured",
          is_enabled: true,
          last_verified_at: null,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  const result = await getMerchantPaymentProviderConfig("r-test-1");
  assert.equal(result.length, 1);
  const row = result[0] as unknown as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  assert.deepEqual(keys, [
    "configurationStatus",
    "isEnabled",
    "lastVerifiedAt",
    "mode",
    "providerCode",
    "updatedAt",
  ]);
  assert.equal(row.providerCode, "monetico");
  assert.equal(row.mode, "test");
  assert.equal(row.configurationStatus, "configured");
  assert.equal(row.isEnabled, true);
  assert.equal(row.lastVerifiedAt, null);
  assert.equal(row.updatedAt, "2026-01-01T00:00:00Z");
});

test("P2B-B service: ligne RPC MALICIEUSE avec propriétés secrètes/structurelles en trop -> AUCUNE ne survit au mapping DTO", async (t) => {
  const MALICIOUS_ROW = {
    provider_code: "monetico",
    mode: "live",
    configuration_status: "verified",
    is_enabled: true,
    last_verified_at: "2026-01-02T10:00:00Z",
    updated_at: "2026-01-02T10:00:00Z",
    // Propriétés supplémentaires INATTENDUES simulant un backend
    // compromis ou une future colonne DB accidentellement exposée --
    // le mapping explicite champ par champ doit les ignorer purement
    // et simplement, quelles que soient leurs valeurs.
    id: "00000000-0000-0000-0000-000000000001",
    restaurant_id: "00000000-0000-0000-0000-000000000002",
    credentials_ref: "11111111-1111-1111-1111-111111111111",
    credentialsRef: "11111111-1111-1111-1111-111111111111",
    secret: "sk_live_should_never_survive_mapping",
    vault_id: "22222222-2222-2222-2222-222222222222",
    password: "should-never-survive",
    mac_key: "should-never-survive",
    tpe_id: "should-never-survive",
    api_token: "should-never-survive",
    signing_key: "should-never-survive",
  };

  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    return { data: [MALICIOUS_ROW], error: null };
  });

  const result = await getMerchantPaymentProviderConfig("r-test-1");
  assert.equal(result.length, 1);
  const row = result[0] as unknown as Record<string, unknown>;

  const forbiddenKeys = [
    "id",
    "restaurant_id",
    "restaurantId",
    "credentials_ref",
    "credentialsRef",
    "secret",
    "vault_id",
    "vaultId",
    "password",
    "mac_key",
    "macKey",
    "tpe_id",
    "tpeId",
    "api_token",
    "apiToken",
    "signing_key",
    "signingKey",
  ];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in row), `la clé interdite "${key}" a survécu au mapping DTO`);
  }
  // Ceinture ET bretelles : aucune des VALEURS secrètes elles-mêmes
  // n'apparaît nulle part dans l'objet sérialisé, même sous une autre
  // clé imprévue par la liste ci-dessus.
  const serialized = JSON.stringify(row);
  for (const leakedValue of [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
    "11111111-1111-1111-1111-111111111111",
    "sk_live_should_never_survive_mapping",
    "22222222-2222-2222-2222-222222222222",
    "should-never-survive",
  ]) {
    assert.ok(!serialized.includes(leakedValue), `la valeur secrète "${leakedValue}" a fuité dans le DTO`);
  }
  // Exactement les 6 clés sûres attendues survivent, rien d'autre.
  assert.deepEqual(Object.keys(row).sort(), [
    "configurationStatus",
    "isEnabled",
    "lastVerifiedAt",
    "mode",
    "providerCode",
    "updatedAt",
  ]);
});

test("P2B-B service: plusieurs prestataires (2 lignes) -> 2 entrées DTO, aucun LIMIT 1 côté service", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    return {
      data: [
        {
          provider_code: "monetico",
          mode: "live",
          configuration_status: "verified",
          is_enabled: true,
          last_verified_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          provider_code: "future-unknown-provider",
          mode: "test",
          configuration_status: "not_configured",
          is_enabled: false,
          last_verified_at: null,
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  const result = await getMerchantPaymentProviderConfig("r-test-1");
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.providerCode),
    ["monetico", "future-unknown-provider"]
  );
});

test("P2B-B service: zéro configuration -> tableau vide, jamais une ligne fabriquée, jamais une exception", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    return { data: [], error: null };
  });

  const result = await getMerchantPaymentProviderConfig("r-test-1");
  assert.deepEqual(result, []);
});

test("P2B-B service: erreur RPC -> exception levée avec le message serveur (c'est la PAGE qui doit ensuite le remplacer par un message sûr, pas le service)", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    return { data: null, error: { message: "permission denied for restaurant" } };
  });

  await assert.rejects(() => getMerchantPaymentProviderConfig("r-test-1"));
});
