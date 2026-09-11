import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — LOT A-0 — MERCHANT STUART CREDENTIAL FOUNDATION v1.
//
// Couche APPLICATIVE (Node/TS) de ce lot : le parseur/sérialiseur
// strict `lib/server/delivery-providers/stuart/credentials.ts`
// (patron : tests/v111-payment-p3a2-credentials.test.ts, domaine
// paiement — même discipline, domaine séparé), le résolveur runtime
// `lib/server/delivery-providers/stuart/credential-resolver.ts`
// (traduction d'erreur RPC -> StuartMerchantCredentialMissingError, et
// preuve structurelle d'absence de repli sur les variables globales
// Sandbox), et `lib/server/delivery-provider-service.ts` (enveloppes
// RPC set_/clear_/get_delivery_provider_credentials — patron :
// tests/v110b-payment-p3a1-service.test.ts, même `t.mock.method(client,
// "rpc", ...)` sur le client réel partagé plutôt qu'un mock de
// createClient).
//
// La preuve SQL des 17 scénarios de sécurité/isolation multi-tenant
// mandatés est couverte séparément par
// supabase/tests/stuart-merchant-credential-foundation-v1-check.sh
// (30 PASS / 0 FAIL) — ce fichier ne duplique pas cette preuve, il
// couvre la couche applicative qui n'existe pas côté SQL : le
// parsing/la validation stricte du payload JSON, la traduction
// d'erreur du résolveur, et le contrat exact des enveloppes RPC
// (arguments envoyés, absence de fuite du secret).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
// Marqueur synthétique DISTINCTIF -- jamais une valeur plausible de
// vraie clé service_role (même discipline que v110b).
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "lota0-synthetic-service-role-key-DO-NOT-USE";

const { parseStuartMerchantCredential, serializeStuartMerchantCredential, StuartCredentialError } =
  await import("../lib/server/delivery-providers/stuart/credentials.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const {
  setDeliveryProviderCredentials,
  clearDeliveryProviderCredentials,
  getDeliveryProviderCredential,
} = await import("../lib/server/delivery-provider-service.ts");
const { DeliveryProviderServerRpcError, DeliveryProviderServerUnavailableError, StuartMerchantCredentialMissingError } =
  await import("../lib/server/delivery-provider-errors.ts");
const { getStuartCredentialForRestaurant } = await import(
  "../lib/server/delivery-providers/stuart/credential-resolver.ts"
);

const VALID_CLIENT_ID = "lota0-synth-client-id";
const VALID_CLIENT_SECRET = "lota0-synth-client-secret-0123456789";

// --------------------------------------------------------------
// parseStuartMerchantCredential / serializeStuartMerchantCredential
// --------------------------------------------------------------

test("parseStuartMerchantCredential: charge JSON valide (sans mode) analysée correctement", () => {
  const raw = JSON.stringify({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET });
  const parsed = parseStuartMerchantCredential(raw);
  assert.equal(parsed.clientId, VALID_CLIENT_ID);
  assert.equal(parsed.clientSecret, VALID_CLIENT_SECRET);
  assert.equal(parsed.mode, undefined);
});

test("parseStuartMerchantCredential: charge JSON valide avec mode explicite acceptée", () => {
  for (const mode of ["sandbox", "production"] as const) {
    const raw = JSON.stringify({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET, mode });
    const parsed = parseStuartMerchantCredential(raw);
    assert.equal(parsed.mode, mode);
  }
});

test("parseStuartMerchantCredential: clientId manquant rejeté", () => {
  const raw = JSON.stringify({ clientSecret: VALID_CLIENT_SECRET });
  assert.throws(() => parseStuartMerchantCredential(raw), StuartCredentialError);
});

test("parseStuartMerchantCredential: clientSecret manquant rejeté", () => {
  const raw = JSON.stringify({ clientId: VALID_CLIENT_ID });
  assert.throws(() => parseStuartMerchantCredential(raw), StuartCredentialError);
});

test("parseStuartMerchantCredential: mode invalide (ni sandbox ni production) rejeté", () => {
  const raw = JSON.stringify({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET, mode: "live" });
  assert.throws(() => parseStuartMerchantCredential(raw), StuartCredentialError);
});

test("parseStuartMerchantCredential: propriété supplémentaire inattendue REJETÉE (politique stricte, même discipline que monetico/credentials.ts)", () => {
  const raw = JSON.stringify({
    clientId: VALID_CLIENT_ID,
    clientSecret: VALID_CLIENT_SECRET,
    extraUnexpectedField: "smuggled-value",
  });
  assert.throws(() => parseStuartMerchantCredential(raw), StuartCredentialError);
});

test("parseStuartMerchantCredential: type de champ inattendu (nombre au lieu de chaîne) rejeté", () => {
  const raw = JSON.stringify({ clientId: 12345, clientSecret: VALID_CLIENT_SECRET });
  assert.throws(() => parseStuartMerchantCredential(raw), StuartCredentialError);
});

test("parseStuartMerchantCredential: chaîne vide pour clientId/clientSecret rejetée", () => {
  assert.throws(
    () => parseStuartMerchantCredential(JSON.stringify({ clientId: "", clientSecret: VALID_CLIENT_SECRET })),
    StuartCredentialError
  );
  assert.throws(
    () => parseStuartMerchantCredential(JSON.stringify({ clientId: VALID_CLIENT_ID, clientSecret: "" })),
    StuartCredentialError
  );
});

test("parseStuartMerchantCredential: JSON invalide rejeté", () => {
  assert.throws(() => parseStuartMerchantCredential("{not valid json"), StuartCredentialError);
});

test("parseStuartMerchantCredential: chaîne vide rejetée", () => {
  assert.throws(() => parseStuartMerchantCredential(""), StuartCredentialError);
});

test("parseStuartMerchantCredential: type inattendu (tableau JSON) rejeté", () => {
  assert.throws(() => parseStuartMerchantCredential("[1,2,3]"), StuartCredentialError);
});

test("parseStuartMerchantCredential: type inattendu (null JSON) rejeté", () => {
  assert.throws(() => parseStuartMerchantCredential("null"), StuartCredentialError);
});

test("parseStuartMerchantCredential: aucun secret n'apparaît jamais dans un message d'erreur", () => {
  const secretMarker = "lota0-synthetic-secret-marker-DO-NOT-USE-XYZ789";
  const raw = JSON.stringify({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET, mode: secretMarker });
  try {
    parseStuartMerchantCredential(raw);
    assert.fail("aurait dû lever");
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    assert.ok(!message.includes(secretMarker));
    assert.ok(!stack.includes(secretMarker));
  }
});

test("serializeStuartMerchantCredential: round-trip exact (avec et sans mode)", () => {
  const withMode = { clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET, mode: "production" as const };
  const roundTripped = parseStuartMerchantCredential(serializeStuartMerchantCredential(withMode));
  assert.deepEqual(roundTripped, withMode);

  const withoutMode = { clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET };
  const roundTripped2 = parseStuartMerchantCredential(serializeStuartMerchantCredential(withoutMode));
  assert.deepEqual(roundTripped2, withoutMode);
});

test("serializeStuartMerchantCredential: ne produit JAMAIS de champ hors ALLOWED_KEYS", () => {
  const out = JSON.parse(
    serializeStuartMerchantCredential({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET, mode: "sandbox" })
  );
  assert.deepEqual(Object.keys(out).sort(), ["clientId", "clientSecret", "mode"]);
});

// --------------------------------------------------------------
// delivery-provider-service.ts : set_/clear_/get_delivery_provider_credentials
// --------------------------------------------------------------

test("setDeliveryProviderCredentials: appelle EXACTEMENT set_delivery_provider_credentials avec p_restaurant_id/p_provider_code/p_secret/p_mode, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [
        {
          config_id: "cfg-1",
          provider_code: "stuart",
          mode: "sandbox",
          configuration_status: "configured",
          last_updated: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  await setDeliveryProviderCredentials({
    restaurantId: "r-1",
    providerCode: "stuart",
    secret: "opaque-secret-payload",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "set_delivery_provider_credentials");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_mode",
    "p_provider_code",
    "p_restaurant_id",
    "p_secret",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_restaurant_id, "r-1");
  assert.equal(args.p_provider_code, "stuart");
  assert.equal(args.p_secret, "opaque-secret-payload");
  assert.equal(args.p_mode, "sandbox"); // défaut appliqué quand omis
});

test("setDeliveryProviderCredentials: un restaurant_id/provider_code fourni artificiellement par l'appelant (cast) n'est jamais transmis en plus à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [
        {
          config_id: "cfg-2",
          provider_code: "stuart",
          mode: "production",
          configuration_status: "configured",
          last_updated: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  const maliciousInput = {
    restaurantId: "r-2",
    providerCode: "stuart",
    secret: "opaque-secret-payload-2",
    mode: "production" as const,
    // Champ qui n'existe PAS dans SetDeliveryProviderCredentialsInput.
    credentialsRef: "should-never-be-sent",
  };
  await setDeliveryProviderCredentials(
    maliciousInput as unknown as Parameters<typeof setDeliveryProviderCredentials>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_mode", "p_provider_code", "p_restaurant_id", "p_secret"]);
});

test("setDeliveryProviderCredentials: mapping succès -> métadonnées exactes, JAMAIS le secret renvoyé", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        config_id: "cfg-3",
        provider_code: "stuart",
        mode: "sandbox",
        configuration_status: "configured",
        last_updated: "2026-01-02T00:00:00Z",
      },
    ],
    error: null,
  }));

  const result = await setDeliveryProviderCredentials({
    restaurantId: "r-3",
    providerCode: "stuart",
    secret: VALID_CLIENT_SECRET,
  });
  assert.deepEqual(result, {
    configId: "cfg-3",
    providerCode: "stuart",
    mode: "sandbox",
    configurationStatus: "configured",
    lastUpdated: "2026-01-02T00:00:00Z",
  });
  assert.ok(!Object.values(result).includes(VALID_CLIENT_SECRET));
});

test("setDeliveryProviderCredentials: erreur RPC (SQLSTATE/table/secret factices) -> DeliveryProviderServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  const FAKE_SQLSTATE = "P0002";
  const FAKE_SECRET_IN_ERROR = "lota0-fake-secret-in-error-DO-NOT-USE";
  const FAKE_TABLE_NAME = "delivery_provider_configs_internal_fake";
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
    () => setDeliveryProviderCredentials({ restaurantId: "r-4", providerCode: "stuart", secret: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof DeliveryProviderServerRpcError);
      const serialized = String(err.message) + String(err.stack ?? "");
      assert.ok(!serialized.includes(FAKE_SQLSTATE));
      assert.ok(!serialized.includes(FAKE_SECRET_IN_ERROR));
      assert.ok(!serialized.includes(FAKE_TABLE_NAME));
      return true;
    }
  );
});

test("setDeliveryProviderCredentials: la RPC lève (indisponibilité réseau/transport) -> DeliveryProviderServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () => setDeliveryProviderCredentials({ restaurantId: "r-5", providerCode: "stuart", secret: "x" }),
    DeliveryProviderServerUnavailableError
  );
});

test("clearDeliveryProviderCredentials: appelle EXACTEMENT clear_delivery_provider_credentials avec p_restaurant_id/p_provider_code, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [{ config_id: "cfg-6", provider_code: "stuart", configuration_status: "not_configured", last_updated: "2026-01-03T00:00:00Z" }],
      error: null,
    };
  });

  await clearDeliveryProviderCredentials({ restaurantId: "r-6", providerCode: "stuart" });

  assert.equal(calls[0]!.name, "clear_delivery_provider_credentials");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), ["p_provider_code", "p_restaurant_id"]);
});

test("getDeliveryProviderCredential: appelle EXACTEMENT get_delivery_provider_credential avec p_restaurant_id/p_provider_code", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: "opaque-payload", error: null };
  });

  await getDeliveryProviderCredential({ restaurantId: "r-7", providerCode: "stuart" });

  assert.equal(calls[0]!.name, "get_delivery_provider_credential");
  const args = calls[0]!.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), ["p_provider_code", "p_restaurant_id"]);
  assert.equal(args.p_restaurant_id, "r-7");
  assert.equal(args.p_provider_code, "stuart");
});

test("getDeliveryProviderCredential: succès -> renvoie EXACTEMENT le secret (chaîne nue, jamais enveloppée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: "opaque-payload-8", error: null }));
  const result = await getDeliveryProviderCredential({ restaurantId: "r-8", providerCode: "stuart" });
  assert.equal(result, "opaque-payload-8");
  assert.equal(typeof result, "string");
});

test("getDeliveryProviderCredential: le secret n'est JAMAIS journalisé (log/error/warn), succès comme échec", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  const SYNTHETIC = "lota0-synthetic-credential-value-DO-NOT-USE";
  t.mock.method(client, "rpc", async () => ({ data: SYNTHETIC, error: null }));
  await getDeliveryProviderCredential({ restaurantId: "r-9", providerCode: "stuart" });

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "P0002", message: `secret=${SYNTHETIC}`, details: null, hint: null },
  }));
  await assert.rejects(() => getDeliveryProviderCredential({ restaurantId: "r-9", providerCode: "stuart" }));

  const combined = seen.join("\n");
  assert.ok(!combined.includes(SYNTHETIC), "le secret synthétique est apparu dans une sortie console");
});

test("getDeliveryProviderCredential: résultat vide/non-chaîne -> DeliveryProviderServerRpcError générique (jamais silencieusement accepté)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: "", error: null }));
  await assert.rejects(
    () => getDeliveryProviderCredential({ restaurantId: "r-10", providerCode: "stuart" }),
    DeliveryProviderServerRpcError
  );

  t.mock.method(client, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () => getDeliveryProviderCredential({ restaurantId: "r-10", providerCode: "stuart" }),
    DeliveryProviderServerRpcError
  );
});

// --------------------------------------------------------------
// credential-resolver.ts : getStuartCredentialForRestaurant
// --------------------------------------------------------------

test("getStuartCredentialForRestaurant: succès -> combine restaurantId + payload analysé", async (t) => {
  const raw = JSON.stringify({ clientId: VALID_CLIENT_ID, clientSecret: VALID_CLIENT_SECRET, mode: "sandbox" });
  t.mock.method(client, "rpc", async () => ({ data: raw, error: null }));

  const result = await getStuartCredentialForRestaurant("r-11");
  assert.deepEqual(result, {
    restaurantId: "r-11",
    clientId: VALID_CLIENT_ID,
    clientSecret: VALID_CLIENT_SECRET,
    mode: "sandbox",
  });
});

test("getStuartCredentialForRestaurant: erreur RPC P0002 (configuration introuvable) -> StuartMerchantCredentialMissingError, jamais une valeur par défaut", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "P0002", message: "config introuvable", details: null, hint: null },
  }));
  await assert.rejects(() => getStuartCredentialForRestaurant("r-12"), StuartMerchantCredentialMissingError);
});

test("getStuartCredentialForRestaurant: erreur RPC 42501 (non éligible / not_configured) -> StuartMerchantCredentialMissingError également", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "42501", message: "insufficient_privilege", details: null, hint: null },
  }));
  await assert.rejects(() => getStuartCredentialForRestaurant("r-13"), StuartMerchantCredentialMissingError);
});

test("getStuartCredentialForRestaurant: toute AUTRE erreur RPC (panne infrastructure) est propagée TELLE QUELLE, jamais masquée en StuartMerchantCredentialMissingError", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "53300", message: "too many connections", details: null, hint: null },
  }));
  await assert.rejects(
    () => getStuartCredentialForRestaurant("r-14"),
    (err: unknown) => {
      assert.ok(err instanceof DeliveryProviderServerRpcError);
      assert.ok(!(err instanceof StuartMerchantCredentialMissingError));
      return true;
    }
  );
});

test("getStuartCredentialForRestaurant: payload stocké corrompu (JSON invalide) -> StuartCredentialError, jamais silencieusement accepté", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: "{not valid json", error: null }));
  await assert.rejects(() => getStuartCredentialForRestaurant("r-15"), StuartCredentialError);
});

test("getStuartCredentialForRestaurant: restaurantId vide/invalide -> StuartMerchantCredentialMissingError immédiatement, aucun appel RPC", async (t) => {
  let called = false;
  t.mock.method(client, "rpc", async () => {
    called = true;
    return { data: null, error: null };
  });
  await assert.rejects(() => getStuartCredentialForRestaurant(""), StuartMerchantCredentialMissingError);
  assert.equal(called, false, "aucun appel RPC ne doit être effectué pour un restaurantId vide");
});

// --------------------------------------------------------------
// Preuve structurelle : aucun repli sur les variables globales Sandbox
// (même propriété que le test SQL 16a/16b, vérifiée ici au niveau
// source pour que la propriété soit couverte par le suite Node/TS
// standard du dépôt, pas seulement par le harnais shell).
// --------------------------------------------------------------

test("credential-resolver.ts: aucune référence à process.env.STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV dans le code source", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../lib/server/delivery-providers/stuart/credential-resolver.ts", import.meta.url),
    "utf8"
  );
  assert.ok(!source.includes("process.env.STUART_CLIENT_ID"));
  assert.ok(!source.includes("process.env.STUART_CLIENT_SECRET"));
  assert.ok(!source.includes("process.env.STUART_ENV"));
});

test("credential-resolver.ts: n'importe ni auth.ts ni environment.ts (les deux seuls modules lisant les variables Stuart globales)", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../lib/server/delivery-providers/stuart/credential-resolver.ts", import.meta.url),
    "utf8"
  );
  assert.ok(!source.includes(`delivery-providers/stuart/auth"`));
  assert.ok(!source.includes(`delivery-providers/stuart/environment"`));
});
