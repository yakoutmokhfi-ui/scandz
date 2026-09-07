import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-v261-trigger-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/internal/stuart/sandbox-trigger/route.ts");
const { invalidateStuartTokenCache } = await import("../lib/server/delivery-providers/stuart/auth.ts");

// ====================================================================
// DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.6.1 — remédiation
// de 3 findings Work (STUART-V26-SYNTHETIC-GUARD-01 HIGH,
// STUART-V26-P3A1-ALLOWLIST-01 MEDIUM,
// STUART-V26-PICKUP-CONTACT-01 MEDIUM). Toute la couche réseau/DB est
// mockée -- preuve contre PostgreSQL réel séparée (harnais SQL
// dédié, 42/42 PASS).
// ====================================================================

const SECRET_HEADER = "x-stuart-sandbox-trigger-secret";
const TRIGGER_SECRET = "sandbox-trigger-secret-v261-synthetic-DO-NOT-USE";
const TEST_ORDER_ID = "aaaaaaaa-1111-1111-1111-111111111111";
const TEST_RESTAURANT_ID = "bbbbbbbb-2222-2222-2222-222222222222";
const OTHER_ORDER_ID = "cccccccc-3333-3333-3333-333333333333";

const BASE_ENV: Record<string, string> = {
  STUART_SANDBOX_TRIGGER_SECRET: TRIGGER_SECRET,
  STUART_SANDBOX_TEST_ORDER_ID: TEST_ORDER_ID,
  STUART_SANDBOX_TEST_RESTAURANT_ID: TEST_RESTAURANT_ID,
  STUART_ENV: "sandbox",
  STUART_CLIENT_ID: "x",
  STUART_CLIENT_SECRET: "y",
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function triggerRequest(opts: { secret?: string; body?: unknown } = {}): InstanceType<typeof NextRequest> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== undefined) headers[SECRET_HEADER] = opts.secret;
  return new NextRequest("https://internal.example.test/api/internal/stuart/sandbox-trigger", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? { orderId: TEST_ORDER_ID, restaurantId: TEST_RESTAURANT_ID }),
  });
}

type RpcHandler = (name: string, args: Record<string, unknown>) => unknown;
function routeRpc(t: { mock: { method: Function } }, handlers: Record<string, RpcHandler>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`RPC inattendue : ${name}`);
    return handler(name, args);
  });
  return calls;
}

function withSyntheticGuard(result: boolean, allocationOverrides: Partial<{ send_state: string; stuart_job_id: string | null }> = {}) {
  return {
    verify_stuart_sandbox_synthetic_order: () => ({ data: result, error: null }),
    allocate_stuart_delivery_job: () => ({
      data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: true, collision: false, send_state: "allocated", stuart_job_id: null, ...allocationOverrides }],
      error: null,
    }),
    mark_stuart_delivery_job_send_started: () => ({ data: null, error: null }),
    mark_stuart_delivery_job_ambiguous: () => ({ data: null, error: null }),
    mark_stuart_delivery_job_terminal_failure: () => ({ data: null, error: null }),
    confirm_stuart_delivery_job_created: () => ({ data: null, error: null }),
  };
}

function mockFetchOk() {
  return async (url: string) => {
    if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    return new Response(JSON.stringify({ id: 100202968 }), { status: 201 });
  };
}

// ====================================================================
// SYNTHETIC GUARD (STUART-V26-SYNTHETIC-GUARD-01)
// ====================================================================

test("SG1. IDs configurés pointant vers une commande normale (RPC de vérification renvoie false) -- 403, AUCUN appel réseau", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, withSyntheticGuard(false));
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("jamais appelé"); });
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 403);
  const json = await response.json();
  assert.equal(json.outcome, "not_a_synthetic_test_order");
  assert.ok(calls.some((c) => c.name === "verify_stuart_sandbox_synthetic_order"), "la vérification SQL DOIT être appelée");
  assert.ok(!calls.some((c) => c.name === "allocate_stuart_delivery_job"), "aucune allocation ne doit avoir lieu si la vérification échoue");
  assert.equal(fetchCalled, false);
});

test("SG2. désignation synthétique explicite requise -- vérifiée via RPC dédiée avant toute orchestration", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, withSyntheticGuard(true));
  t.mock.method(globalThis, "fetch", mockFetchOk());
  await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  const guardCallIndex = calls.findIndex((c) => c.name === "verify_stuart_sandbox_synthetic_order");
  const allocCallIndex = calls.findIndex((c) => c.name === "allocate_stuart_delivery_job");
  assert.ok(guardCallIndex >= 0 && guardCallIndex < allocCallIndex, "la vérification synthétique DOIT précéder toute allocation");
});

test("SG3. commande synthétique avec PII client réelle (RPC renvoie false -- la vérification SQL compare aux constantes synthétiques) -- 403", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(false));
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 403);
});

test("SG4. mauvais restaurant/contexte (RPC renvoie false) -- 403", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(false));
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 403);
});

test("SG5. corrélation Stuart incompatible existante (RPC renvoie false) -- 403", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(false));
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 403);
});

test("SG6. la requête ne peut PAS créer/surcharger la désignation synthétique (aucun champ de désignation accepté dans le corps)", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, withSyntheticGuard(true));
  t.mock.method(globalThis, "fetch", mockFetchOk());
  await withEnv(BASE_ENV, () =>
    POST(triggerRequest({ secret: TRIGGER_SECRET, body: { orderId: TEST_ORDER_ID, restaurantId: TEST_RESTAURANT_ID, isSynthetic: true, synthetic: true } }))
  );
  const guardCall = calls.find((c) => c.name === "verify_stuart_sandbox_synthetic_order");
  assert.ok(guardCall);
  assert.equal(Object.keys(guardCall!.args).length, 8, "seuls les 8 paramètres attendus (order_id/restaurant_id + 6 PII synthétiques) sont transmis -- jamais un champ de désignation venant de la requête");
  assert.deepEqual(
    Object.keys(guardCall!.args).sort(),
    ["p_expected_customer_email", "p_expected_customer_name", "p_expected_customer_note", "p_expected_customer_phone", "p_expected_delivery_address", "p_expected_delivery_zone", "p_order_id", "p_restaurant_id"].sort(),
    "STUART-V26-SYNTHETIC-GUARD-01 (v2.6.4) : inventaire PII COMPLET des 6 champs réellement persistés par orders (confirmé par purge_old_customer_data())"
  );
});

test("SG7. commande synthétique valide -- atteint EXACTEMENT createStuartSandboxJobForOrder() après vérification réussie", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, withSyntheticGuard(true));
  t.mock.method(globalThis, "fetch", mockFetchOk());
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 200);
  assert.ok(calls.some((c) => c.name === "allocate_stuart_delivery_job"));
});

// ====================================================================
// ALLOWLIST (STUART-V26-P3A1-ALLOWLIST-01)
// ====================================================================

test("AL8. la route Stuart ne fait PLUS partie de la liste Monetico non restreinte", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("tests/v110c-payment-p3a1-structural.test.ts", "utf8");
  const monSection = source.slice(source.indexOf("MONETICO_ALLOWED_SERVER_IMPORTERS = new Set(["), source.indexOf("]);", source.indexOf("MONETICO_ALLOWED_SERVER_IMPORTERS = new Set([")));
  assert.ok(!monSection.includes("sandbox-trigger"), "la route Stuart ne doit plus apparaître dans la liste Monetico non restreinte");
});

test("AL9. les imports Stuart approuvés EXACTS sont acceptés par la règle structurelle dédiée", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("tests/v110c-payment-p3a1-structural.test.ts", "utf8");
  assert.match(source, /STUART_ALLOWED_SERVER_IMPORTERS/);
  assert.match(source, /delivery-providers\\\/stuart\\\/\(environment\|create-job\|allocation\)/);
});

test("AL10. importer un module Monetico depuis la route Stuart ferait ÉCHOUER la règle structurelle (vérifié par simulation du motif)", async () => {
  const pattern = /^@\/lib\/server\/delivery-providers\/stuart\/(environment|create-job|allocation)$/;
  assert.equal(pattern.test("@/lib/server/payment-providers/monetico/request"), false);
});

test("AL11. importer un autre module lib/server/* arbitraire échouerait à la règle structurelle", async () => {
  const pattern = /^@\/lib\/server\/delivery-providers\/stuart\/(environment|create-job|allocation)$/;
  assert.equal(pattern.test("@/lib/server/tracking-service"), false);
  assert.equal(pattern.test("@/lib/server/supabase-admin"), false);
});

test("AL12. importer un module d'un AUTRE prestataire de livraison échouerait à la règle structurelle", async () => {
  const pattern = /^@\/lib\/server\/delivery-providers\/stuart\/(environment|create-job|allocation)$/;
  assert.equal(pattern.test("@/lib/server/delivery-providers/chronofresh/client"), false);
});

test("AL-real. la route Stuart réelle n'importe QUE les 3 modules Stuart approuvés (aucun import lib/server/* supplémentaire)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  const imports = [...source.matchAll(/from\s+["'](@\/lib\/server\/[^"']+)["']/g)].map((m) => m[1]);
  const allowed = /^@\/lib\/server\/delivery-providers\/stuart\/(environment|create-job|allocation)$/;
  for (const imported of imports) {
    assert.ok(allowed.test(imported), `import non approuvé trouvé dans la route réelle : ${imported}`);
  }
  assert.ok(imports.length >= 3);
});

// ====================================================================
// CONTACT SAFETY (STUART-V26-PICKUP-CONTACT-01)
// ====================================================================

test("CS13. le numéro de téléphone de retrait n'appartient PAS à l'ancien préfixe mobile abandonné (STUART-V264-CONTACT-RANGE-TEST-01) -- allowlist uniquement, jamais une valeur historique réintroduite ici", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  const literalMatches = [...source.matchAll(/phone:\s*"(\+33\d+)"/g)].map((m) => m[1]);
  for (const phone of literalMatches) {
    assert.match(phone, /^\+3363998[0-9]{4}$/, `${phone} doit appartenir EXACTEMENT au bloc fictif officiel ARCEP 06 39 98`);
  }
});

test("CS-dropoff. STUART-V264-REAL-DROPOFF-ADDRESS-01 / STUART-V265-DROPOFF-AUTHORIZATION-EVIDENCE-01 : pickup et dropoff sont désormais DEUX adresses DISTINCTES, toutes deux explicitement autorisées par le CIO -- jamais l'ancienne adresse réelle non autorisée, jamais une adresse inventée", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  assert.ok(!source.includes("156 rue de Charonne"), "l'ancienne adresse de dépôt réelle non autorisée (v2.6.1/v2.6.4) ne doit plus apparaître");
  assert.ok(!source.includes("46 Boulevard Barbès"), "l'ancienne adresse de repli (v2.6.5/v2.6.6) ne doit plus apparaître comme fixture active");
  const pickupMatch = source.match(/address:\s*"(114 Rue Ordener[^"]*)"/);
  const dropoffConstMatch = source.match(/const EXPECTED_SYNTHETIC_DELIVERY_ADDRESS = "([^"]*)";/);
  assert.ok(pickupMatch, "adresse de retrait CIO (114 Rue Ordener) introuvable");
  assert.ok(dropoffConstMatch, "constante d'adresse de dépôt introuvable");
  assert.equal(dropoffConstMatch![1], "2 Place Constantin Pecqueur, 75018 Paris, France", "le dépôt DOIT utiliser exactement l'adresse CIO autorisée");
  assert.notEqual(dropoffConstMatch![1], pickupMatch![1], "pickup et dropoff sont désormais des adresses DISTINCTES");
});

test("CS-dropoff-no-private-name. aucun nom de personne privée associé à l'adresse de dépôt n'apparaît dans le code source", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  // Vérification structurelle : le commentaire documente uniquement
  // "adresse explicitement contrôlée et autorisée par le CIO", jamais
  // un nom de personne.
  assert.ok(source.includes("explicitement contrôlée et autorisée"), "la documentation attendue doit être présente");
});

test("CS13b. la fixture utilise EXCLUSIVEMENT le préfixe mobile fictif officiel ARCEP 06 39 98 (Décision n° 2018-0881, article 2.5.12) -- garantie réglementaire française, jamais un numéro deviné", async () => {  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  const literalMatches = [...source.matchAll(/phone:\s*"(\+33\d+)"/g)].map((m) => m[1]);
  const constMatch = source.match(/const EXPECTED_SYNTHETIC_CUSTOMER_PHONE = "(\+33\d+)";/);
  assert.ok(constMatch, "la constante EXPECTED_SYNTHETIC_CUSTOMER_PHONE doit exister");
  const allPhones = [...literalMatches, constMatch![1]];
  assert.ok(allPhones.length >= 2, "au moins 2 numéros de contact attendus (pickup + dropoff)");
  for (const phone of allPhones) {
    assert.match(phone, /^\+3363998[0-9]{4}$/, `${phone} doit appartenir EXACTEMENT au bloc fictif officiel ARCEP 06 39 98 (soit +3363998 suivi de 4 chiffres -- jamais 06 39 90-97/99)`);
  }
  assert.match(source, /2018-0881/, "la source réglementaire officielle exacte doit être citée dans le code");
  assert.match(source, /legifrance\.gouv\.fr/, "un lien vers la source officielle vérifiable doit être présent");
  assert.deepEqual([...allPhones].sort(), ["+33639980000", "+33639980001"].sort(), "les DEUX numéros de fixture approuvés exacts, jamais changés, jamais un autre numéro du bloc réservé");
});

test("CS14. la fixture n'expose QUE des identités synthétiques autorisées -- preuve positive en monde clos (allowlist), jamais une liste noire de valeurs privées historiques", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  // Ensemble FERMÉ des identités synthétiques autorisées pour ce
  // déclencheur -- toute valeur de firstname/lastname/name littérale
  // rencontrée dans le fichier DOIT appartenir à cet ensemble.
  const AUTHORIZED_SYNTHETIC_IDENTITY_TOKENS = new Set(["Scanym", "SandboxSynthetic"]);
  const identityMatches = [
    ...source.matchAll(/(?:firstname|lastname)\s*:\s*"([^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(identityMatches.length > 0, "au moins une identité de contact attendue dans la fixture");
  for (const identity of identityMatches) {
    assert.ok(
      AUTHORIZED_SYNTHETIC_IDENTITY_TOKENS.has(identity),
      `identité non autorisée détectée dans la fixture : "${identity}" n'appartient pas à l'ensemble fermé des identités synthétiques approuvées`
    );
  }
  // La constante de nom client attendu doit également appartenir au
  // même monde clos synthétique (comparaison structurelle, jamais une
  // citation de valeur privée historique).
  const customerNameConst = source.match(/const EXPECTED_SYNTHETIC_CUSTOMER_NAME = "([^"]+)";/);
  assert.ok(customerNameConst, "constante EXPECTED_SYNTHETIC_CUSTOMER_NAME introuvable");
  const nameTokens = customerNameConst![1].split(/\s+/);
  for (const token of nameTokens) {
    assert.ok(AUTHORIZED_SYNTHETIC_IDENTITY_TOKENS.has(token), `jeton de nom non autorisé : "${token}"`);
  }
});

test("CS15. la fixture est CLAIREMENT synthétique (libellés explicites)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  assert.match(source, /SandboxSynthetic|SCANYM-TEST/);
});

// ====================================================================
// EXISTING SAFETY (préservée depuis v2.6, non régressée)
// ====================================================================

test("ES16. invocation SANS en-tête secret -- 503, AUCUN appel", async (t) => {
  let rpcCalled = false;
  t.mock.method(client, "rpc", async () => { rpcCalled = true; throw new Error("jamais appelé"); });
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest()));
  assert.equal(response.status, 503);
  assert.equal(rpcCalled, false);
});

test("ES17. secret INCORRECT -- 503, AUCUN appel", async (t) => {
  let called = false;
  t.mock.method(client, "rpc", async () => { called = true; throw new Error("jamais appelé"); });
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: "wrong-secret-value" })));
  assert.equal(response.status, 503);
  assert.equal(called, false);
});

// ====================================================================
// AUTH TIMING-LENGTH (STUART-V262-AUTH-TIMING-LENGTH-01, réouvert v2.6.5)
// -- matrice complète pour le déclencheur, symétrique à v146.
// ====================================================================

test("AT1t. secret déclencheur CORRECT -- accepté (atteint la vérification synthétique)", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, withSyntheticGuard(true));
  t.mock.method(globalThis, "fetch", mockFetchOk());
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 200);
  assert.ok(calls.length > 0);
});

test("AT2t. secret INCORRECT de MÊME longueur -- rejeté", async (t) => {
  let called = false;
  t.mock.method(client, "rpc", async () => { called = true; throw new Error("jamais appelé"); });
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: "x".repeat(TRIGGER_SECRET.length) })));
  assert.equal(response.status, 503);
  assert.equal(called, false);
});

test("AT3t. secret INCORRECT PLUS COURT -- rejeté", async (t) => {
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET.slice(0, 5) })));
  assert.equal(response.status, 503);
});

test("AT4t. secret INCORRECT PLUS LONG -- rejeté", async (t) => {
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET + "extra" })));
  assert.equal(response.status, 503);
});

test("AT5t. secret de la sonde de préparation (readiness) -- rejeté par le déclencheur (secrets non interchangeables)", async (t) => {
  const READINESS_SECRET_UNRELATED = "readiness-secret-v262-synthetic-DO-NOT-USE";
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: READINESS_SECRET_UNRELATED })));
  assert.equal(response.status, 503);
});

test("AT6t. en-tête secret ABSENT -- rejeté", async (t) => {
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest()));
  assert.equal(response.status, 503);
});

test("AT6bt. en-tête secret PRÉSENT MAIS VIDE -- rejeté (STUART-V262-AUTH-TIMING-LENGTH-01, réouvert)", async (t) => {
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: "" })));
  assert.equal(response.status, 503);
});

test("AT6ct. en-tête secret d'UN SEUL caractère incorrect -- rejeté", async (t) => {
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET.slice(0, 1) })));
  assert.equal(response.status, 503);
});

test("AT7t. STUART_SANDBOX_TRIGGER_SECRET NON CONFIGURÉ côté serveur -- rejeté (fail-closed)", async (t) => {
  const response = await withEnv({ ...BASE_ENV, STUART_SANDBOX_TRIGGER_SECRET: undefined }, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 503);
});

test("AT8t. AUCUNE valeur brute de secret n'apparaît jamais dans la réponse, longueurs variées", async (t) => {
  const attempts = [TRIGGER_SECRET.slice(0, 5), TRIGGER_SECRET + "x", "z".repeat(TRIGGER_SECRET.length)];
  for (const attempt of attempts) {
    const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: attempt })));
    const text = await response.text();
    assert.ok(!text.includes(attempt));
    assert.ok(!text.includes(TRIGGER_SECRET));
  }
});

test("AT-structural-t. le déclencheur ne contient PLUS de retour anticipé basé sur la longueur brute (attaquant OU digest) -- confirmé structurellement", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  assert.ok(!/bufA\.length\s*!==\s*bufB\.length/.test(source));
  assert.ok(!/provided\.length\s*===\s*0/.test(source), "STUART-V262-AUTH-TIMING-LENGTH-01 (réouvert) : aucun retour anticipé basé sur la longueur de l'entrée CONTRÔLÉE PAR L'APPELANT ne doit subsister");
  assert.match(source, /request\.headers\.get\(SECRET_HEADER\)\s*\?\?\s*""/);
  assert.ok(source.includes("createHash"));
});

test("ES18. STUART_ENV absente -- rejeté AVANT tout réseau", async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("jamais appelé"); });
  const response = await withEnv({ ...BASE_ENV, STUART_ENV: undefined }, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 503);
  assert.equal(fetchCalled, false);
});

test("ES19. STUART_ENV=production -- rejeté AVANT tout réseau (403)", async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("jamais appelé"); });
  const response = await withEnv({ ...BASE_ENV, STUART_ENV: "production" }, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 403);
  assert.equal(fetchCalled, false);
});

test("ES20. URL Production impossible -- environnement sandbox dérive TOUJOURS l'URL Sandbox officielle", async () => {
  const { resolveStuartEnvironment } = await import("../lib/server/delivery-providers/stuart/environment.ts");
  await withEnv(BASE_ENV, async () => {
    const { baseUrl } = resolveStuartEnvironment();
    assert.equal(baseUrl, "https://api.sandbox.stuart.com");
  });
});

test("ES21. la requête ne peut PAS surcharger l'URL Stuart", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(true));
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => { capturedUrl = String(url); return mockFetchOk()(url); });
  await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET, body: { orderId: TEST_ORDER_ID, restaurantId: TEST_RESTAURANT_ID, baseUrl: "https://attacker.example.test" } })));
  assert.ok(capturedUrl?.startsWith("https://api.sandbox.stuart.com"));
});

test("ES22. la requête ne peut PAS fournir/surcharger les identifiants Stuart", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(true));
  let capturedAuthBody: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/oauth/token")) { capturedAuthBody = init?.body as string; return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 2592000 }), { status: 200 }); }
    return new Response(JSON.stringify({ id: 100202968 }), { status: 201 });
  });
  await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET, body: { orderId: TEST_ORDER_ID, restaurantId: TEST_RESTAURANT_ID, clientId: "attacker" } })));
  const params = new URLSearchParams(capturedAuthBody);
  assert.equal(params.get("client_id"), "x");
});

test("ES23. AUCUNE logique OAuth/Create Job indépendante dans le déclencheur", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-trigger/route.ts", "utf8");
  assert.ok(!/oauth\/token|\/v2\/jobs(?!\/pricing)|grant_type=client_credentials/i.test(source));
  assert.ok(source.includes("createStuartSandboxJobForOrder"));
});

test("ES24. secrets/jeton JAMAIS dans la réponse", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(true));
  t.mock.method(globalThis, "fetch", mockFetchOk());
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  const text = await response.text();
  assert.ok(!text.includes(TRIGGER_SECRET));
  assert.ok(!text.toLowerCase().includes("bearer"));
});

test("ES25. résultat ambigu mocké -- comportement v2.5 préservé (send_ambiguous, 502)", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, withSyntheticGuard(true));
  let createJobCallCount = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    createJobCallCount += 1;
    throw new Error("network failure simulated");
  });
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 502);
  assert.equal(createJobCallCount, 1, "ES26. AUCUNE reprise implicite");
  assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
});

test("ES-existing-confirmed. allocation déjà send_ambiguous -- 409, AUCUN appel réseau", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, withSyntheticGuard(true, { send_state: "send_ambiguous" }));
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("jamais appelé"); });
  const response = await withEnv(BASE_ENV, () => POST(triggerRequest({ secret: TRIGGER_SECRET })));
  assert.equal(response.status, 409);
  assert.equal(fetchCalled, false);
});
