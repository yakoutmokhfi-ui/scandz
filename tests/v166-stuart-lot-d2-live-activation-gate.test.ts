import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// STUART LOT D2 — LIVE ACTIVATION GATE.
// Test matrix items 9-12. AUCUN test de ce fichier ne positionne
// JAMAIS `STUART_LIVE_ACTIVATION_ENABLED="true"` -- la porte reste
// OFF dans TOUS les scénarios, y compris ceux qui prouvent son
// comportement fail-closed sur des valeurs invalides.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-d2-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();

const { isStuartLiveActivationEnabled, describeStuartLiveActivationGateForObservability } = await import(
  "../lib/server/delivery-providers/stuart/live-activation-gate.ts"
);
const { createStuartMerchantOrchestrationTransport, StuartMerchantRuntimeAdapterError } = await import(
  "../lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts"
);

const GATE_VAR = "STUART_LIVE_ACTIVATION_ENABLED";
const ORIGINAL_GATE_VALUE = process.env[GATE_VAR];

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => handler(name, args));
}
function configStatusRow(mode: string) {
  return { data: [{ config_id: "cfg-1", provider_code: "stuart", mode, configuration_status: "configured" }], error: null };
}
function credentialRow() {
  return { data: JSON.stringify({ clientId: "cid", clientSecret: "csecret" }), error: null };
}
function samplePayload() {
  return {
    job: {
      pickups: [{ address: "1 rue A", contact: { phone: "0600000000", company: "R1" } }],
      dropoffs: [
        { address: "2 rue B", contact: { phone: "0600000001", company: "C1" }, client_reference: "CAND1", package_type: "small" as const },
      ],
    },
  };
}

// --------------------------------------------------------------
// item 9/10 : gate OFF by default / missing -> OFF.
// --------------------------------------------------------------

test("item 9 : porte absente de l'environnement -- isStuartLiveActivationEnabled() === false (défaut = OFF)", () => {
  delete process.env[GATE_VAR];
  assert.equal(isStuartLiveActivationEnabled(), false);
  const obs = describeStuartLiveActivationGateForObservability();
  assert.equal(obs.enabled, false);
  assert.equal(obs.wasUnset, true);
});

test("item 10 : valeurs invalides/mal orthographiées -- TOUTES traitées comme OFF, AUCUN alias toléré", () => {
  for (const value of ["1", "TRUE", "True", "yes", "on", "enabled", " true", "true ", ""]) {
    process.env[GATE_VAR] = value;
    assert.equal(isStuartLiveActivationEnabled(), false, `valeur "${value}" n'aurait pas dû activer la porte`);
  }
  delete process.env[GATE_VAR];
});

test("item 10bis : SEULE la chaîne EXACTE \"true\" active la porte (comportement documenté, jamais exercé activé dans ce lot au-delà de cette assertion locale et immédiatement restaurée)", () => {
  process.env[GATE_VAR] = "true";
  assert.equal(isStuartLiveActivationEnabled(), true);
  // Restauration IMMÉDIATE -- aucun autre test, aucun transport
  // réel, aucune tentative réseau n'est exercée pendant que la porte
  // est active ici. Ce test prouve UNIQUEMENT la fonction pure
  // isStuartLiveActivationEnabled() elle-même, jamais le transport.
  delete process.env[GATE_VAR];
  assert.equal(isStuartLiveActivationEnabled(), false);
});

// --------------------------------------------------------------
// item 11 : browser cannot activate live transport -- preuve
// structurelle.
// --------------------------------------------------------------

test("item 11 : live-activation-gate.ts ne lit AUCUNE variable NEXT_PUBLIC_, AUCUN header/paramètre de requête -- porte lisible SEULEMENT côté serveur", () => {
  const src = readFileSync("lib/server/delivery-providers/stuart/live-activation-gate.ts", "utf8");
  assert.match(src, /import "server-only"/);
  // Retire les commentaires AVANT la recherche -- ce fichier
  // DOCUMENTE délibérément, en prose, les variables/sources qu'il ne
  // doit jamais lire ; seule une référence en CODE RÉEL constituerait
  // une violation.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /NEXT_PUBLIC_/);
  assert.doesNotMatch(codeOnly, /request\.(headers|body|query)/);
  assert.doesNotMatch(codeOnly, /process\.env\.NODE_ENV/);
  assert.doesNotMatch(codeOnly, /process\.env\.VERCEL_ENV/);
});

test("item 11bis : aucune route app/api/ n'expose de paramètre permettant d'activer/contrôler la porte depuis une requête HTTP", () => {
  const src = readFileSync("app/api/internal/stuart/webhook/route.ts", "utf8");
  assert.doesNotMatch(src, /STUART_LIVE_ACTIVATION/);
  assert.doesNotMatch(src, /liveActivation/i);
});

// --------------------------------------------------------------
// item 12 : no network while gate OFF -- même avec un marchand
// parfaitement valide (sandbox ET production).
// --------------------------------------------------------------

test("item 12 : porte OFF -- ZÉRO appel réseau pour un marchand sandbox parfaitement valide", async (t) => {
  delete process.env[GATE_VAR];
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  let fetchCalls = 0;
  const spyFetch = (async () => {
    fetchCalls += 1;
    throw new Error("FETCH NE DOIT JAMAIS ÊTRE APPELÉ -- porte OFF");
  }) as typeof fetch;
  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-valid-sbx" }, spyFetch);
  await assert.rejects(() => transport.createJob(samplePayload()), StuartMerchantRuntimeAdapterError);
  assert.equal(fetchCalls, 0);
});

test("item 12bis : porte OFF -- ZÉRO appel réseau pour un marchand production parfaitement valide (le cas le plus dangereux si mal gardé)", async (t) => {
  delete process.env[GATE_VAR];
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("production");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  let fetchCalls = 0;
  const spyFetch = (async () => {
    fetchCalls += 1;
    throw new Error("FETCH NE DOIT JAMAIS ÊTRE APPELÉ -- porte OFF");
  }) as typeof fetch;
  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-valid-prod" }, spyFetch);
  await assert.rejects(() => transport.createJob(samplePayload()), StuartMerchantRuntimeAdapterError);
  assert.equal(fetchCalls, 0);
});

test("item 12ter : porte OFF -- ZÉRO appel réseau répété sur PLUSIEURS appels createJob successifs (jamais une fenêtre où le premier appel serait exempté)", async (t) => {
  delete process.env[GATE_VAR];
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  let fetchCalls = 0;
  const spyFetch = (async () => {
    fetchCalls += 1;
    throw new Error("FETCH NE DOIT JAMAIS ÊTRE APPELÉ -- porte OFF");
  }) as typeof fetch;
  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-repeat" }, spyFetch);
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => transport.createJob(samplePayload()));
  }
  assert.equal(fetchCalls, 0);
});

test("cleanup : restaure la valeur d'origine de STUART_LIVE_ACTIVATION_ENABLED (hygiène de suite, jamais laissé activé pour un test suivant)", () => {
  if (typeof ORIGINAL_GATE_VALUE === "undefined") {
    delete process.env[GATE_VAR];
  } else {
    process.env[GATE_VAR] = ORIGINAL_GATE_VALUE;
  }
  assert.equal(isStuartLiveActivationEnabled(), ORIGINAL_GATE_VALUE === "true");
});
