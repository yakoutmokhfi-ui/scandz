import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING
// FOUNDATION v1.1.
//
// CORRECTIF v1.1 (CTO PRE-CONTROL, LOT-A-CONTRACT-01, BLOCKER) : v1
// avait des tests qui PROUVAIENT le mapping de requête HTTP de
// `validateDelivery` vers `/v2/jobs/validate` à partir d'une réponse
// MOCKÉE -- ce qui ne prouve JAMAIS un contrat EXTERNE réel (seulement
// que le code se comporte comme mocké). `validateDelivery` a été
// remédiée pour n'émettre PLUS AUCUNE requête HTTP (voir
// `quote-service.ts`/`quote-errors.ts`) -- les anciens tests [7]/[10]/
// [13]/[14b]/[16]/[additionnel P0002] qui l'utilisaient pour prouver
// le mapping/la normalisation/la résolution credential ont donc été
// RÉÉCRITS pour utiliser `quoteDelivery` à la place (SEUL chemin HTTP
// réel restant, `/v2/jobs/pricing`, endpoint PROUVÉ) -- ces scénarios
// restent tous mandatés, seule la fonction testée change. Une nouvelle
// section dédiée couvre le comportement fail-closed de
// `validateDelivery` lui-même (items 1-3 de la liste "TEST
// REMEDIATION" du mandat v1.1).
//
// AUCUN appel réseau réel -- `fetchImpl` TOUJOURS injecté (mandat, "NO
// REAL EXTERNAL CALL" : "Deterministic mocked/fake HTTP responses
// only"). La résolution credential (RPC Supabase) est mockée via le
// même patron `t.mock.method(client, "rpc", ...)` que
// tests/v154-stuart-merchant-credential-foundation.test.ts (client réel
// partagé, jamais un mock de `createClient`).
//
// La preuve SQL (isolation cross-tenant, ACL service_role/anon/
// authenticated, absence structurelle de Vault) reste couverte par
// supabase/tests/stuart-quote-validate-foundation-v1-check.sh (16
// PASS / 0 FAIL, INCHANGÉ par v1.1) -- ce fichier ne la duplique pas.
//
// Items 11/12 de la liste "TEST REMEDIATION" du mandat v1.1 (régression
// A-0, régression Payment/Monetico) sont couverts EXTERNEMENT à ce
// fichier : tests/v154-stuart-merchant-credential-foundation.test.ts
// (39 PASS, INCHANGÉ par v1.1) + supabase/tests/stuart-merchant-
// credential-foundation-v1-check.sh (30 PASS) pour A-0 ; supabase/
// tests/payment-p2a-secure-config-check.sh (94 PASS) + payment-p3a0-
// secure-credential-read-check.sh (68 PASS) pour Payment/Monetico --
// voir le livrable final pour les logs complets. Le scénario [17]
// ci-dessous ne fait que la preuve structurelle statique (aucune
// référence au domaine Payment/Monetico dans le code de ce lot).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-lota-qv-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { DeliveryProviderServerRpcError, DeliveryProviderServerUnavailableError } = await import(
  "../lib/server/delivery-provider-errors.ts"
);
const { validateDelivery, quoteDelivery } = await import(
  "../lib/server/delivery-providers/stuart/quote-service.ts"
);
const { getStuartAccessTokenForMerchant, StuartMerchantAuthError } = await import(
  "../lib/server/delivery-providers/stuart/merchant-auth.ts"
);
const { StuartQuoteConfigurationError, StuartQuoteCredentialError, StuartValidateContractUnverifiedError } = await import(
  "../lib/server/delivery-providers/stuart/quote-errors.ts"
);

const CLIENT_ID = "lota-qv-synth-client-id";
const CLIENT_SECRET = "lota-qv-synth-client-secret-0123456789";

function mockTwoStepRpc(
  t: { mock: { method: (obj: unknown, name: string, fn: unknown) => void } },
  configStatusResponse: { data: unknown; error: unknown },
  credentialResponse: { data: unknown; error: unknown }
): Array<{ name: string; args: unknown }> {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    if (name === "get_delivery_provider_config_status") return configStatusResponse;
    if (name === "get_delivery_provider_credential") return credentialResponse;
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return calls;
}

function sandboxCredentialRpc(
  t: { mock: { method: (obj: unknown, name: string, fn: unknown) => void } }
): Array<{ name: string; args: unknown }> {
  const raw = JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  return mockTwoStepRpc(
    t,
    { data: [{ config_id: "cfg-1", provider_code: "stuart", mode: "sandbox", configuration_status: "configured" }], error: null },
    { data: raw, error: null }
  );
}

function productionCredentialRpc(
  t: { mock: { method: (obj: unknown, name: string, fn: unknown) => void } }
): Array<{ name: string; args: unknown }> {
  const raw = JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  return mockTwoStepRpc(
    t,
    { data: [{ config_id: "cfg-2", provider_code: "stuart", mode: "production", configuration_status: "configured" }], error: null },
    { data: raw, error: null }
  );
}

const VALID_INPUT = {
  restaurantId: "r-quote-1",
  pickup: {
    address: "1 rue de la Paix, Paris",
    contact: { phone: "+33600000000", company: "Restaurant Test" } as const,
  },
  dropoff: {
    address: "2 avenue des Champs, Paris",
    contact: { phone: "+33600000001", firstname: "Jean", lastname: "Dupont" } as const,
    packageType: "medium" as const,
    clientReference: "QUOTE-TEST-0001",
  },
};

function fakeFetchOAuthThenBody(bodyStatus: number, body: unknown, bodyIsJson = true): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "fake-merchant-token", token_type: "bearer", expires_in: 3600 }),
        { status: 200 }
      );
    }
    if (!bodyIsJson) {
      return new Response("not-json{{{", { status: bodyStatus });
    }
    return new Response(JSON.stringify(body), { status: bodyStatus });
  }) as unknown as typeof fetch;
}

// ====================================================================
// SECTION A — validateDelivery : contrat NON VÉRIFIÉ, fail-closed
// (mandat v1.1, "TEST REMEDIATION", items 1-3 ; LOT-A-CONTRACT-01)
// ====================================================================

test("[v1.1-A1] validateDelivery: N'ÉMET JAMAIS de requête fetch (ni vers /v2/jobs/validate, ni vers /oauth/token, ni vers quoi que ce soit d'autre)", async () => {
  let fetchCalled = false;
  const fetchImpl = (async () => {
    fetchCalled = true;
    throw new Error("validateDelivery ne doit JAMAIS invoquer fetchImpl");
  }) as unknown as typeof fetch;

  await assert.rejects(() => validateDelivery(VALID_INPUT, fetchImpl));
  assert.equal(fetchCalled, false, "validateDelivery a invoqué fetchImpl -- violation LOT-A-CONTRACT-01");
});

test("[v1.1-A2] validateDelivery: lève TOUJOURS StuartValidateContractUnverifiedError, de façon déterministe, quelle que soit l'entrée", async () => {
  for (const input of [
    VALID_INPUT,
    { ...VALID_INPUT, restaurantId: "another-restaurant" },
    { ...VALID_INPUT, scheduling: { pickupAt: "2026-09-11T18:00:00+02:00" } },
  ]) {
    await assert.rejects(
      () => validateDelivery(input),
      (err: unknown) => {
        assert.ok(err instanceof StuartValidateContractUnverifiedError);
        assert.equal((err as Error).message, "STUART_VALIDATE_CONTRACT_UNVERIFIED");
        // Distincte, explicitement, de configuration/credential (mandat :
        // "clearly distinguishable from configuration / credential failures").
        assert.ok(!(err instanceof StuartQuoteConfigurationError));
        assert.ok(!(err instanceof StuartQuoteCredentialError));
        return true;
      }
    );
  }
});

test("[v1.1-A3] validateDelivery: N'APPELLE AUCUNE RPC Supabase (aucune résolution de credential -- la condition est établissable AVANT authentification, indépendamment du restaurant)", async (t) => {
  let rpcCalled = false;
  t.mock.method(client, "rpc", async (name: string) => {
    rpcCalled = true;
    throw new Error(`validateDelivery ne doit appeler AUCUNE RPC (appel inattendu : ${name})`);
  });

  await assert.rejects(() => validateDelivery(VALID_INPUT), StuartValidateContractUnverifiedError);
  assert.equal(rpcCalled, false, "validateDelivery a appelé une RPC Supabase -- ne devrait résoudre AUCUN credential");
});

test("[v1.1-A4] validateDelivery: AUCUNE requête OAuth marchand n'est émise (getStuartAccessTokenForMerchant n'est jamais invoquée) -- preuve indépendante du test fetch [A1]", async (t) => {
  let oauthCalled = false;
  // Même si la résolution credential ÉTAIT mockée avec succès, la
  // fonction ne doit JAMAIS atteindre l'étape d'authentification.
  sandboxCredentialRpc(t);
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).includes("/oauth/token")) {
      oauthCalled = true;
    }
    throw new Error("fetchImpl ne doit jamais être invoqué par validateDelivery");
  }) as unknown as typeof fetch;

  await assert.rejects(() => validateDelivery(VALID_INPUT, fetchImpl), StuartValidateContractUnverifiedError);
  assert.equal(oauthCalled, false);
});

test("[v1.1-A5] validateDelivery: N'EST JAMAIS un alias silencieux de quoteDelivery -- structure du code, preuve statique", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("lib/server/delivery-providers/stuart/quote-service.ts", "utf8");
  const validateFnMatch = source.match(/export async function validateDelivery[\s\S]*?\n}/);
  assert.ok(validateFnMatch, "fonction validateDelivery introuvable dans quote-service.ts");
  const validateFnBody = validateFnMatch![0];
  assert.ok(
    !/quoteDelivery|performStuartPricingRequest|resolveMerchantAuthContext/.test(validateFnBody),
    "validateDelivery délègue à quoteDelivery/à la résolution credential -- alias silencieux interdit par le mandat v1.1"
  );
  assert.ok(
    /StuartValidateContractUnverifiedError/.test(validateFnBody),
    "validateDelivery devrait lever StuartValidateContractUnverifiedError"
  );
});

// ====================================================================
// SECTION B — quoteDelivery : scénarios originaux du mandat LOT A v1
// (17 scénarios, désormais couverts EXCLUSIVEMENT par quoteDelivery,
// seul chemin HTTP réel restant depuis v1.1)
// ====================================================================

// --------------------------------------------------------------
// [1] merchant config resolved for correct restaurant
// --------------------------------------------------------------
test("[1] quoteDelivery: config marchand résolue pour le BON restaurant -- les DEUX RPC sont appelées avec le restaurantId fourni", async (t) => {
  const calls = sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(200, { ok: true });

  await quoteDelivery(VALID_INPUT, fetchImpl);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "get_delivery_provider_config_status");
  assert.deepEqual(calls[0].args, { p_restaurant_id: "r-quote-1", p_provider_code: "stuart" });
  assert.equal(calls[1].name, "get_delivery_provider_credential");
  assert.deepEqual(calls[1].args, { p_restaurant_id: "r-quote-1", p_provider_code: "stuart" });
});

// --------------------------------------------------------------
// [2] cross-tenant credential access denied (preuve applicative --
// scoping RPC toujours au restaurantId fourni par l'appelant, jamais
// un autre ; l'isolation SQL elle-même est prouvée par le harnais SQL).
// --------------------------------------------------------------
test("[2] quoteDelivery: deux restaurants distincts -> deux résolutions STRICTEMENT scopées, jamais de fuite d'un restaurantId vers l'autre", async (t) => {
  const callsA = sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(200, { ok: true });
  await quoteDelivery({ ...VALID_INPUT, restaurantId: "restaurant-A" }, fetchImpl);
  assert.deepEqual(callsA[0].args, { p_restaurant_id: "restaurant-A", p_provider_code: "stuart" });

  const callsB = productionCredentialRpc(t);
  await quoteDelivery({ ...VALID_INPUT, restaurantId: "restaurant-B" }, fetchImpl);
  assert.deepEqual(callsB[0].args, { p_restaurant_id: "restaurant-B", p_provider_code: "stuart" });
});

// --------------------------------------------------------------
// [3] missing config fails closed
// --------------------------------------------------------------
test("[3] quoteDelivery: configuration introuvable (P0002 étape 1) -> StuartQuoteConfigurationError, AUCUN appel HTTP", async (t) => {
  let httpCalled = false;
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "P0002", message: "SCANYM_DELIVERY_PROVIDER_CONFIG_STATUS: configuration introuvable" },
  }));
  const fetchImpl = (async () => {
    httpCalled = true;
    throw new Error("ne doit jamais être appelé");
  }) as unknown as typeof fetch;

  await assert.rejects(() => quoteDelivery(VALID_INPUT, fetchImpl), StuartQuoteConfigurationError);
  assert.equal(httpCalled, false);
});

// --------------------------------------------------------------
// [4] missing credential fails closed
// --------------------------------------------------------------
test("[4] quoteDelivery: credential introuvable (P0002 étape 2, config existe mais pas de secret) -> StuartQuoteConfigurationError, AUCUN appel HTTP", async (t) => {
  let httpCalled = false;
  const calls = mockTwoStepRpc(
    t,
    { data: [{ config_id: "cfg-3", provider_code: "stuart", mode: "sandbox", configuration_status: "not_configured" }], error: null },
    { data: null, error: { code: "P0002", message: "introuvable" } }
  );
  const fetchImpl = (async () => {
    httpCalled = true;
    throw new Error("ne doit jamais être appelé");
  }) as unknown as typeof fetch;

  await assert.rejects(() => quoteDelivery(VALID_INPUT, fetchImpl), StuartQuoteConfigurationError);
  assert.equal(httpCalled, false);
  assert.equal(calls.length, 2);
});

// --------------------------------------------------------------
// [5] malformed credential fails closed
// --------------------------------------------------------------
test("[5] quoteDelivery: payload credential stocké corrompu (JSON invalide) -> StuartQuoteCredentialError, AUCUN appel HTTP", async (t) => {
  let httpCalled = false;
  mockTwoStepRpc(
    t,
    { data: [{ config_id: "cfg-4", provider_code: "stuart", mode: "sandbox", configuration_status: "configured" }], error: null },
    { data: "{not-valid-json", error: null }
  );
  const fetchImpl = (async () => {
    httpCalled = true;
    throw new Error("ne doit jamais être appelé");
  }) as unknown as typeof fetch;

  await assert.rejects(() => quoteDelivery(VALID_INPUT, fetchImpl), StuartQuoteCredentialError);
  assert.equal(httpCalled, false);
});

// --------------------------------------------------------------
// [6] mode AUTORITATIF ne peut diverger -- reflété dans l'URL de base
// effectivement utilisée pour l'appel HTTP (dérivée EXCLUSIVEMENT du
// mode retourné par l'étape 1 RPC, voir credential-resolver.ts déjà
// testé en profondeur par v154 -- ici, preuve BOUT-EN-BOUT que
// quote-service consomme bien ce mode, jamais une autre source).
// --------------------------------------------------------------
test("[6] quoteDelivery: le mode AUTORITATIF (étape 1 RPC) détermine SEUL l'URL de base effectivement appelée", async (t) => {
  productionCredentialRpc(t);
  let calledUrl = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    calledUrl = u;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);
  assert.equal(result.mode, "production");
  assert.ok(calledUrl.startsWith("https://api.stuart.com"), `attendu préfixe Production, obtenu : ${calledUrl}`);
});

// --------------------------------------------------------------
// [7] Sandbox config choisit l'URL de base Sandbox
// --------------------------------------------------------------
test("[7] quoteDelivery: config Sandbox -> URL de base https://api.sandbox.stuart.com", async (t) => {
  sandboxCredentialRpc(t);
  let calledUrl = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    calledUrl = u;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await quoteDelivery(VALID_INPUT, fetchImpl);
  assert.ok(calledUrl.startsWith("https://api.sandbox.stuart.com/v2/jobs/pricing"), calledUrl);
});

// --------------------------------------------------------------
// [8] Production config choisit l'URL de base Production
// --------------------------------------------------------------
test("[8] quoteDelivery: config Production -> URL de base https://api.stuart.com", async (t) => {
  productionCredentialRpc(t);
  let calledUrl = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    calledUrl = u;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await quoteDelivery(VALID_INPUT, fetchImpl);
  assert.ok(calledUrl.startsWith("https://api.stuart.com/v2/jobs/pricing"), calledUrl);
});

// --------------------------------------------------------------
// [9] no global credential fallback -- preuve structurelle statique
// --------------------------------------------------------------
test("[9] quote-service.ts/merchant-auth.ts: aucune référence à process.env.STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV, aucun import de auth.ts/environment.ts::resolveStuartEnvironment", async () => {
  const fs = await import("node:fs");
  const files = [
    "lib/server/delivery-providers/stuart/quote-service.ts",
    "lib/server/delivery-providers/stuart/merchant-auth.ts",
  ];
  for (const f of files) {
    const source = fs.readFileSync(f, "utf8");
    assert.ok(
      !/process\.env\.STUART_CLIENT_ID|process\.env\.STUART_CLIENT_SECRET|process\.env\.STUART_ENV/.test(source),
      `${f} référence directement une variable Stuart globale -- repli interdit`
    );
    assert.ok(
      !/delivery-providers\/stuart\/auth"|delivery-providers\/stuart\/auth'/.test(source),
      `${f} importe auth.ts (authentification PLATEFORME UNIQUE) -- chemin de repli indirect possible`
    );
  }
  // environment.ts est légitimement importé par quote-service.ts, mais
  // UNIQUEMENT pour sa fonction PURE resolveStuartBaseUrlForEnvironment
  // -- jamais resolveStuartEnvironment() (qui lit process.env.STUART_ENV).
  const quoteServiceSource = fs.readFileSync("lib/server/delivery-providers/stuart/quote-service.ts", "utf8");
  assert.ok(
    !/resolveStuartEnvironment\(/.test(quoteServiceSource),
    "quote-service.ts appelle resolveStuartEnvironment() (lit STUART_ENV global) -- repli interdit"
  );
  assert.ok(
    /resolveStuartBaseUrlForEnvironment\(/.test(quoteServiceSource),
    "quote-service.ts devrait utiliser resolveStuartBaseUrlForEnvironment() (PURE, dérivée du mode marchand)"
  );
});

// --------------------------------------------------------------
// [10] request mapping (SEUL endpoint HTTP réel depuis v1.1 --
// /v2/jobs/pricing, PROUVÉ ; /v2/jobs/validate n'existe plus dans le
// code -- voir SECTION A)
// --------------------------------------------------------------
test("[10] quoteDelivery: mapping de requête -- POST /v2/jobs/pricing, charge utile StuartCreateJobPayload EXACTE dérivée de l'entrée", async (t) => {
  sandboxCredentialRpc(t);
  let capturedBody: unknown = null;
  let capturedPath = "";
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    capturedPath = u;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await quoteDelivery(
    { ...VALID_INPUT, scheduling: { pickupAt: "2026-09-11T18:00:00+02:00" } },
    fetchImpl
  );

  assert.ok(capturedPath.endsWith("/v2/jobs/pricing"));
  // NB : capturedBody est le résultat de JSON.parse(JSON.stringify(...)) --
  // JSON.stringify omet toute propriété valant `undefined` (comment/
  // package_description/partner_data non fournis ici), d'où leur
  // absence ci-dessous plutôt qu'une valeur `undefined` explicite.
  assert.deepEqual(capturedBody, {
    job: {
      pickup_at: "2026-09-11T18:00:00+02:00",
      pickups: [{ address: VALID_INPUT.pickup.address, contact: VALID_INPUT.pickup.contact }],
      dropoffs: [
        {
          address: VALID_INPUT.dropoff.address,
          contact: VALID_INPUT.dropoff.contact,
          client_reference: VALID_INPUT.dropoff.clientReference,
          package_type: VALID_INPUT.dropoff.packageType,
        },
      ],
    },
  });
});

// --------------------------------------------------------------
// [11] pricing request mapping -- partner_data propagé correctement
// --------------------------------------------------------------
test("[11] quoteDelivery: mapping de requête -- partner_data propagé correctement dans la charge utile", async (t) => {
  sandboxCredentialRpc(t);
  let capturedBody: unknown = null;
  let capturedPath = "";
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    capturedPath = u;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  await quoteDelivery(
    {
      ...VALID_INPUT,
      partnerData: { integrator: "scanym" },
    },
    fetchImpl
  );

  assert.ok(capturedPath.endsWith("/v2/jobs/pricing"));
  assert.deepEqual((capturedBody as { job: { dropoffs: Array<{ partner_data?: unknown }> } }).job.dropoffs[0].partner_data, {
    integrator: "scanym",
  });
});

// --------------------------------------------------------------
// [12] successful normalized quote
// --------------------------------------------------------------
test("[12] quoteDelivery: réponse 2xx JSON valide -> résultat normalisé eligible=true, aucun champ commercial fabriqué", async (t) => {
  sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(200, { some: "stuart-shaped-response-we-cannot-trust-field-names-of" });

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);

  assert.deepEqual(result, {
    eligible: true,
    providerCode: "stuart",
    mode: "sandbox",
    httpStatus: 200,
    scheduling: undefined,
  });
});

// --------------------------------------------------------------
// [13] provider rejection normalization
// --------------------------------------------------------------
test("[13] quoteDelivery: réponse 4xx -> eligible=false, errorClassification=provider_rejection", async (t) => {
  sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(422, { error: "unprocessable" });

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);

  assert.equal(result.eligible, false);
  assert.equal(result.errorClassification, "provider_rejection");
  assert.equal(result.httpStatus, 422);
  assert.equal(result.mode, "sandbox");
  assert.equal(result.providerCode, "stuart");
});

// --------------------------------------------------------------
// [14] transient failure normalization (5xx ET échec réseau)
// --------------------------------------------------------------
test("[14a] quoteDelivery: réponse 5xx -> eligible=false, errorClassification=transient_failure", async (t) => {
  sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(503, { error: "unavailable" });

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);

  assert.equal(result.eligible, false);
  assert.equal(result.errorClassification, "transient_failure");
  assert.equal(result.httpStatus, 503);
});

test("[14b] quoteDelivery: échec réseau (fetch rejette) -> eligible=false, errorClassification=transient_failure, httpStatus=0", async (t) => {
  sandboxCredentialRpc(t);
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);

  assert.equal(result.eligible, false);
  assert.equal(result.errorClassification, "transient_failure");
  assert.equal(result.httpStatus, 0);
});

// --------------------------------------------------------------
// [15] malformed provider response fails safely
// --------------------------------------------------------------
test("[15] quoteDelivery: réponse 2xx JSON NON parseable -> eligible=false, errorClassification=malformed_response, jamais un crash", async (t) => {
  sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(200, null, false);

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);

  assert.equal(result.eligible, false);
  assert.equal(result.errorClassification, "malformed_response");
  assert.equal(result.httpStatus, 200);
});

// --------------------------------------------------------------
// [16] secrets never returned in normalized result
// --------------------------------------------------------------
test("[16] quoteDelivery: le résultat normalisé ne contient JAMAIS le clientSecret ni le jeton d'accès, sous quelque forme que ce soit", async (t) => {
  sandboxCredentialRpc(t);
  const fetchImpl = fakeFetchOAuthThenBody(200, { ok: true });

  const result = await quoteDelivery(VALID_INPUT, fetchImpl);
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes(CLIENT_SECRET), "le secret client apparaît dans le résultat normalisé -- FUITE");
  assert.ok(!serialized.includes("fake-merchant-token"), "le jeton d'accès apparaît dans le résultat normalisé -- FUITE");
  assert.ok(!("clientSecret" in result), "le résultat normalisé porte un champ clientSecret -- FUITE structurelle");
});

// --------------------------------------------------------------
// [17] no Payment/Monetico regression -- preuve structurelle statique
// (régression comportementale complète : voir logs externes, §11/12
// de la liste "TEST REMEDIATION" du mandat v1.1)
// --------------------------------------------------------------
test("[17] quote-service.ts/merchant-auth.ts/quote-types.ts/quote-errors.ts: aucune référence au domaine Payment/Monetico", async () => {
  const fs = await import("node:fs");
  const files = [
    "lib/server/delivery-providers/stuart/quote-service.ts",
    "lib/server/delivery-providers/stuart/merchant-auth.ts",
    "lib/server/delivery-providers/stuart/quote-types.ts",
    "lib/server/delivery-providers/stuart/quote-errors.ts",
  ];
  for (const f of files) {
    const source = fs.readFileSync(f, "utf8");
    assert.ok(
      !/payment-service|payment-providers\/monetico|payment-errors/i.test(source),
      `${f} référence le domaine Payment/Monetico -- ce lot doit rester STRICTEMENT séparé`
    );
  }
});

// --------------------------------------------------------------
// Couverture additionnelle -- OAuth marchand échoue -> credential/auth
// error normalisée (fusion des deux causes, voir quote-errors.ts) --
// UNIQUEMENT pertinent pour quoteDelivery depuis v1.1 (validateDelivery
// n'atteint plus jamais l'étape OAuth, voir SECTION A).
// --------------------------------------------------------------
test("[additionnel] quoteDelivery: échec d'authentification OAuth marchand (401) -> StuartQuoteCredentialError, AUCUN appel /v2/jobs/pricing", async (t) => {
  sandboxCredentialRpc(t);
  let pricingCalled = false;
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    }
    pricingCalled = true;
    throw new Error("ne doit jamais être appelé");
  }) as unknown as typeof fetch;

  await assert.rejects(() => quoteDelivery(VALID_INPUT, fetchImpl), StuartQuoteCredentialError);
  assert.equal(pricingCalled, false);
});

test("[additionnel] getStuartAccessTokenForMerchant: succès -> retourne EXACTEMENT access_token, AUCUN cache (deux appels = deux requêtes réseau)", async (t) => {
  let callCount = 0;
  const fetchImpl = (async () => {
    callCount += 1;
    return new Response(
      JSON.stringify({ access_token: `tok-${callCount}`, token_type: "bearer", expires_in: 3600 }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  const token1 = await getStuartAccessTokenForMerchant({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, "https://api.sandbox.stuart.com", fetchImpl);
  const token2 = await getStuartAccessTokenForMerchant({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, "https://api.sandbox.stuart.com", fetchImpl);

  assert.equal(token1, "tok-1");
  assert.equal(token2, "tok-2");
  assert.equal(callCount, 2, "AUCUN cache attendu dans ce lot -- chaque appel doit déclencher une nouvelle requête réseau (simplification documentée)");
});

test("[additionnel] getStuartAccessTokenForMerchant: réponse malformée (token_type inattendu) -> StuartMerchantAuthError", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ access_token: "x", token_type: "unexpected", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

  await assert.rejects(
    () => getStuartAccessTokenForMerchant({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, "https://api.sandbox.stuart.com", fetchImpl),
    StuartMerchantAuthError
  );
});

test("[additionnel] quoteDelivery: toute AUTRE erreur RPC (panne infrastructure, ni P0002 ni 42501) est propagée TELLE QUELLE, jamais masquée", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: null, error: { code: "53300", message: "too many connections" } }));

  await assert.rejects(() => quoteDelivery(VALID_INPUT), DeliveryProviderServerRpcError);
});

test("[additionnel] quoteDelivery: la RPC lève (indisponibilité transport) -> DeliveryProviderServerUnavailableError propagée telle quelle", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("network down");
  });

  await assert.rejects(() => quoteDelivery(VALID_INPUT), DeliveryProviderServerUnavailableError);
});
