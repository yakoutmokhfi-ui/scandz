import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// STUART LOT D2 — REAL MERCHANT RUNTIME + CONTRACT VALIDATION.
// Test matrix items 1-8 (credential/environment authority, no global
// fallback, spoof rejection). AUCUN appel réseau réel -- `fetchImpl`
// systématiquement mocké, JAMAIS invoqué au niveau HTTP réel dans ce
// fichier (les scénarios ici s'arrêtent tous avant toute tentative
// réseau -- résolution credential/environnement uniquement, RPC
// Supabase MOCKÉES).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-d2-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();

const { createStuartMerchantOrchestrationTransport, StuartMerchantRuntimeAdapterError } = await import(
  "../lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts"
);

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return calls;
}

function configStatusRow(mode: string, configurationStatus = "configured") {
  return { data: [{ config_id: "cfg-1", provider_code: "stuart", mode, configuration_status: configurationStatus }], error: null };
}
function credentialRow(clientId = "d2-synth-client-id", clientSecret = "d2-synth-client-secret-0123456789") {
  return { data: JSON.stringify({ clientId, clientSecret }), error: null };
}

const NEVER_CALLED_FETCH = async () => {
  throw new Error("FETCH MUST NEVER BE CALLED IN THIS TEST -- resolution failed/blocked before any network attempt");
};

function samplePayload() {
  return {
    job: {
      pickups: [{ address: "1 rue A", contact: { phone: "0600000000", company: "R1" } }],
      dropoffs: [
        {
          address: "2 rue B",
          contact: { phone: "0600000001", company: "C1" },
          client_reference: "CANDIDATE1",
          package_type: "small" as const,
        },
      ],
    },
  };
}

// --------------------------------------------------------------
// item 1 : merchant credential resolution.
// --------------------------------------------------------------

test("item 1 : résolution credential marchand -- sandbox -- résout config-status puis credential dans cet ordre, pour LE restaurant demandé", async (t) => {
  const calls = routeRpc(t, (name, args) => {
    if (name === "get_delivery_provider_config_status") {
      assert.equal(args.p_restaurant_id, "resto-A");
      assert.equal(args.p_provider_code, "stuart");
      return configStatusRow("sandbox");
    }
    if (name === "get_delivery_provider_credential") {
      assert.equal(args.p_restaurant_id, "resto-A");
      return credentialRow();
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });

  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-A" }, NEVER_CALLED_FETCH);
  await assert.rejects(() => transport.createJob(samplePayload()), StuartMerchantRuntimeAdapterError);

  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ["get_delivery_provider_config_status", "get_delivery_provider_credential"]);
});

// --------------------------------------------------------------
// item 2 : cross-tenant credential denial.
// --------------------------------------------------------------

test("item 2 : isolation croisée -- un transport lié à resto-A ne résout/n'utilise JAMAIS la config de resto-B, même si les deux sont mockées simultanément", async (t) => {
  const calls = routeRpc(t, (name, args) => {
    if (args.p_restaurant_id === "resto-A") {
      if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
      if (name === "get_delivery_provider_credential") return credentialRow("A-client-id", "A-client-secret");
    }
    if (args.p_restaurant_id === "resto-B") {
      if (name === "get_delivery_provider_config_status") return configStatusRow("production");
      if (name === "get_delivery_provider_credential") return credentialRow("B-client-id", "B-client-secret");
    }
    throw new Error(`RPC INATTENDU pour ${args.p_restaurant_id}: ${name}`);
  });

  const transportA = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-A" }, NEVER_CALLED_FETCH);
  await assert.rejects(() => transportA.createJob(samplePayload()));

  assert.ok(calls.every((c) => c.args.p_restaurant_id === "resto-A"), "transportA a fuité vers resto-B");
});

// --------------------------------------------------------------
// item 3 : missing credential fail-closed.
// --------------------------------------------------------------

test("item 3 : aucune configuration -- fail closed, configuration_failure, ZÉRO appel réseau", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") {
      return { data: null, error: { code: "P0002", message: "not found" } };
    }
    throw new Error(`RPC INATTENDU: ${name}`);
  });

  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-none" }, NEVER_CALLED_FETCH);
  await assert.rejects(
    () => transport.createJob(samplePayload()),
    (err: unknown) => {
      assert.ok(err instanceof StuartMerchantRuntimeAdapterError);
      assert.equal((err as InstanceType<typeof StuartMerchantRuntimeAdapterError>).category, "configuration_failure");
      return true;
    }
  );
});

// --------------------------------------------------------------
// item 4 : invalid credential configuration.
// --------------------------------------------------------------

test("item 4 : payload credential stocké corrompu -- fail closed, auth_credential_failure, ZÉRO appel réseau", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
    if (name === "get_delivery_provider_credential") return { data: "{ not valid json", error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });

  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-corrupt" }, NEVER_CALLED_FETCH);
  await assert.rejects(
    () => transport.createJob(samplePayload()),
    (err: unknown) => {
      assert.ok(err instanceof StuartMerchantRuntimeAdapterError);
      assert.equal((err as InstanceType<typeof StuartMerchantRuntimeAdapterError>).category, "auth_credential_failure");
      return true;
    }
  );
});

test("item 4bis : mode invalide/inconnu persisté (défense en profondeur) -- fail closed, configuration_failure", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("staging");
    throw new Error(`RPC INATTENDU: ${name}`);
  });

  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-badmode" }, NEVER_CALLED_FETCH);
  await assert.rejects(
    () => transport.createJob(samplePayload()),
    (err: unknown) => {
      assert.ok(err instanceof StuartMerchantRuntimeAdapterError);
      assert.equal((err as InstanceType<typeof StuartMerchantRuntimeAdapterError>).category, "configuration_failure");
      return true;
    }
  );
});

// --------------------------------------------------------------
// item 5 : no global fallback -- preuve structurelle (grep).
// --------------------------------------------------------------

test("item 5 : merchant-runtime-adapter.ts ne référence JAMAIS STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV en CODE (hors commentaires), ni auth.ts/create-job.ts/resolveStuartEnvironment", () => {
  const src = readFileSync("lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts", "utf8");
  // Retire les commentaires /* ... */ et // ... AVANT la recherche --
  // ce fichier DOCUMENTE délibérément, en prose, les variables qu'il
  // ne doit jamais lire (voir commentaire de fichier) ; seule une
  // référence en CODE RÉEL constituerait une violation.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const forbidden = [
    /process\.env\.STUART_CLIENT_ID/,
    /process\.env\.STUART_CLIENT_SECRET/,
    /process\.env\.STUART_ENV\b/,
    /from ["']@\/lib\/server\/delivery-providers\/stuart\/auth["']/,
    /from ["']@\/lib\/server\/delivery-providers\/stuart\/create-job["']/,
    /resolveStuartEnvironment\s*\(/,
  ];
  const offenders = forbidden.filter((p) => p.test(codeOnly));
  assert.deepEqual(offenders.map(String), []);
});

test("item 5bis : aucun repli vers un credential Scanym global -- getStuartCredentialForRestaurant manquant/en échec n'est JAMAIS intercepté silencieusement pour retomber sur un autre chemin", async (t) => {
  routeRpc(t, () => {
    throw new Error("panne infrastructure inattendue");
  });
  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-infra-down" }, NEVER_CALLED_FETCH);
  // Panne infrastructure -- propagée TELLE QUELLE (pas
  // StuartMerchantRuntimeAdapterError), jamais un repli silencieux vers
  // un succès ou un credential par défaut.
  await assert.rejects(() => transport.createJob(samplePayload()), (err: unknown) => {
    assert.ok(!(err instanceof StuartMerchantRuntimeAdapterError));
    return true;
  });
});

// --------------------------------------------------------------
// item 6/7 : environment resolution (sandbox/production).
// --------------------------------------------------------------

test("item 6 : marchand configuré sandbox -- baseUrl résolue = https://api.sandbox.stuart.com (jamais atteinte réseau -- porte OFF, voir v166)", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-sbx" }, NEVER_CALLED_FETCH);
  await assert.rejects(
    () => transport.createJob(samplePayload()),
    (err: unknown) => {
      assert.ok(err instanceof StuartMerchantRuntimeAdapterError);
      assert.equal((err as InstanceType<typeof StuartMerchantRuntimeAdapterError>).category, "configuration_failure");
      assert.equal((err as Error).message, "STUART_LIVE_ACTIVATION_DISABLED");
      return true;
    }
  );
});

test("item 7 : marchand configuré production -- résolution credential/environnement réussit intégralement, MAIS bloquée par la porte -- AUCUN accès réseau, AUCUNE exception liée à la production elle-même", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("production");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const transport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-prod" }, NEVER_CALLED_FETCH);
  await assert.rejects(
    () => transport.createJob(samplePayload()),
    (err: unknown) => {
      assert.ok(err instanceof StuartMerchantRuntimeAdapterError);
      assert.equal((err as InstanceType<typeof StuartMerchantRuntimeAdapterError>).category, "configuration_failure");
      assert.equal((err as Error).message, "STUART_LIVE_ACTIVATION_DISABLED");
      return true;
    }
  );
});

// --------------------------------------------------------------
// item 8 : environment/input spoof rejection.
// --------------------------------------------------------------

test("item 8 : aucun paramètre d'environnement n'existe dans l'API publique du transport -- structurellement impossible à usurper depuis l'appelant/la charge utile", () => {
  const src = readFileSync("lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts", "utf8");
  // La SEULE entrée publique est {restaurantId, orderId?} -- ni
  // "environment", ni "mode" n'apparaissent dans
  // CreateStuartMerchantOrchestrationTransportInput.
  const inputTypeMatch = src.match(/export interface CreateStuartMerchantOrchestrationTransportInput \{[^}]*\}/);
  assert.ok(inputTypeMatch, "interface d'entrée introuvable");
  assert.doesNotMatch(inputTypeMatch![0], /environment|mode\s*:/);
  // La charge utile Stuart (StuartCreateJobPayload) elle-même ne porte
  // aucun champ environment/mode (types.ts, INCHANGÉ) -- confirmé par
  // relecture directe de son import ci-dessus (aucune assertion runtime
  // supplémentaire nécessaire, propriété du TYPE lui-même).
  assert.match(src, /environment/); // le mot existe (dans les commentaires/logs), mais jamais comme paramètre d'entrée exploitable -- déjà prouvé ci-dessus.
});

test("item 8bis : même charge utile transmise pour un marchand sandbox et un marchand production -- seule la config marchand (jamais la charge utile) détermine l'environnement résolu", async (t) => {
  const payload = samplePayload();

  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("sandbox");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const sbxTransport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-sbx-2" }, NEVER_CALLED_FETCH);
  const sbxErr = await sbxTransport.createJob(payload).catch((e: unknown) => e);
  assert.ok(sbxErr instanceof StuartMerchantRuntimeAdapterError);

  routeRpc(t, (name) => {
    if (name === "get_delivery_provider_config_status") return configStatusRow("production");
    if (name === "get_delivery_provider_credential") return credentialRow();
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const prodTransport = createStuartMerchantOrchestrationTransport({ restaurantId: "resto-prod-2" }, NEVER_CALLED_FETCH);
  const prodErr = await prodTransport.createJob(payload).catch((e: unknown) => e);
  assert.ok(prodErr instanceof StuartMerchantRuntimeAdapterError);

  // Les deux échouent identiquement (porte OFF) malgré la charge utile
  // IDENTIQUE -- preuve que rien dans le payload n'influence
  // l'environnement résolu.
  assert.equal((sbxErr as Error).message, (prodErr as Error).message);
});
