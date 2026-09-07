import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { NextRequest } = await import("next/server");
const { GET } = await import("../app/api/internal/stuart/sandbox-readiness/route.ts");

// ====================================================================
// DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.6.2 — SONDE DE
// PRÉPARATION RUNTIME. AUCUN appel réseau/DB dans ce fichier -- la
// route elle-même n'en effectue structurellement aucun (confirmé par
// test dédié #12/#13/#14/#15 ci-dessous).
// ====================================================================

const SECRET_HEADER = "x-stuart-sandbox-readiness-secret";
const READINESS_SECRET = "readiness-secret-v262-synthetic-DO-NOT-USE";
const TRIGGER_SECRET_UNRELATED = "sandbox-trigger-secret-v261-synthetic-DO-NOT-USE";

const BASE_ENV: Record<string, string> = {
  STUART_SANDBOX_READINESS_SECRET: READINESS_SECRET,
  STUART_ENV: "sandbox",
  STUART_CLIENT_ID: "real-client-id-value",
  STUART_CLIENT_SECRET: "real-client-secret-value",
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

function readinessRequest(secret?: string): InstanceType<typeof NextRequest> {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers[SECRET_HEADER] = secret;
  return new NextRequest("https://internal.example.test/api/internal/stuart/sandbox-readiness", { method: "GET", headers });
}

// 1. Requête non authentifiée refusée.
test("1. requête SANS en-tête secret -- 503", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest()));
  assert.equal(response.status, 503);
});

// 2. Mauvais secret interne refusé.
test("2. secret interne INCORRECT -- 503", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest("wrong-secret")));
  assert.equal(response.status, 503);
});

test("2b. le secret du déclencheur d'orchestration (DIFFÉRENT) est REFUSÉ pour cette sonde -- secrets non interchangeables", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(TRIGGER_SECRET_UNRELATED)));
  assert.equal(response.status, 503);
});

// 3. STUART_ENV absente => fail.
test("3. STUART_ENV absente -- stuart_env=fail", async () => {
  const response = await withEnv({ ...BASE_ENV, STUART_ENV: undefined }, () => GET(readinessRequest(READINESS_SECRET)));
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.stuart_env, "fail");
  assert.equal(json.resolved_base_url, "invalid");
});

// 4. STUART_ENV != sandbox => fail.
test("4. STUART_ENV=production -- stuart_env=fail, production_url_selected=true", async () => {
  const response = await withEnv({ ...BASE_ENV, STUART_ENV: "production" }, () => GET(readinessRequest(READINESS_SECRET)));
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.stuart_env, "fail");
  assert.equal(json.production_url_selected, true);
  assert.equal(json.resolved_base_url, "invalid");
});

// 5. STUART_CLIENT_ID absent => absent.
test("5. STUART_CLIENT_ID absent -- stuart_client_id=absent", async () => {
  const response = await withEnv({ ...BASE_ENV, STUART_CLIENT_ID: undefined }, () => GET(readinessRequest(READINESS_SECRET)));
  const json = await response.json();
  assert.equal(json.stuart_client_id, "absent");
});

// 6. STUART_CLIENT_SECRET absent => absent.
test("6. STUART_CLIENT_SECRET absent -- stuart_client_secret=absent", async () => {
  const response = await withEnv({ ...BASE_ENV, STUART_CLIENT_SECRET: undefined }, () => GET(readinessRequest(READINESS_SECRET)));
  const json = await response.json();
  assert.equal(json.stuart_client_secret, "absent");
});

// 7. Configuration runtime valide => sandbox/present/present.
test("7. configuration valide -- sandbox/present/present", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET)));
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.stuart_env, "sandbox");
  assert.equal(json.stuart_client_id, "present");
  assert.equal(json.stuart_client_secret, "present");
});

// 8. URL de base résolue est EXACTEMENT Sandbox.
test("8. URL de base résolue -- EXACTEMENT https://api.sandbox.stuart.com", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET)));
  const json = await response.json();
  assert.equal(json.resolved_base_url, "https://api.sandbox.stuart.com");
});

// 9. L'URL Production n'est jamais sélectionnée sous une config Sandbox valide.
test("9. configuration Sandbox valide -- production_url_selected=false", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET)));
  const json = await response.json();
  assert.equal(json.production_url_selected, false);
});

// 10. Aucune valeur de secret n'apparaît dans la réponse.
test("10. AUCUNE valeur de secret dans la réponse (ni client_id, ni client_secret, ni readiness secret)", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET)));
  const text = await response.text();
  assert.ok(!text.includes("real-client-id-value"));
  assert.ok(!text.includes("real-client-secret-value"));
  assert.ok(!text.includes(READINESS_SECRET));
  const json = JSON.parse(text);
  const allowedKeys = ["stuart_env", "stuart_client_id", "stuart_client_secret", "resolved_base_url", "production_url_selected"].sort();
  assert.deepEqual(Object.keys(json).sort(), allowedKeys, "aucun champ supplémentaire ne doit exister dans la réponse");
});

// 11. Aucune valeur de secret n'apparaît dans les erreurs/logs.
test("11. AUCUNE valeur de secret dans les surfaces d'erreur (réponse 503 générique, jamais de détail)", async () => {
  const response = await withEnv({ ...BASE_ENV, STUART_SANDBOX_READINESS_SECRET: "correct-secret-xyz" }, () => GET(readinessRequest("wrong-guess")));
  const text = await response.text();
  assert.ok(!text.includes("correct-secret-xyz"));
  assert.ok(!text.includes("wrong-guess"));
});

// 12. Aucune logique OAuth.
test("12. AUCUNE logique OAuth dans la sonde -- confirmé structurellement", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-readiness/route.ts", "utf8");
  assert.ok(!/oauth\/token|grant_type=client_credentials/i.test(source));
});

// 13. Aucune logique Create Job.
test("13. AUCUNE logique Create Job dans la sonde -- confirmé structurellement", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-readiness/route.ts", "utf8");
  assert.ok(!/\/v2\/jobs/i.test(source));
  assert.ok(!source.includes("createStuartSandboxJobForOrder"));
});

// 14. Aucun appel réseau ne se produit.
test("14. AUCUN appel fetch ne se produit, quel que soit le résultat", async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("ne doit jamais être appelé"); });
  await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET)));
  assert.equal(fetchCalled, false);
});

// 15. Aucune mutation DB ne se produit (confirmé structurellement -- aucun import Supabase).
test("15. AUCUN accès base de données -- confirmé structurellement (aucun import supabase-admin/RPC)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-readiness/route.ts", "utf8");
  assert.ok(!source.includes("supabase-admin"));
  assert.ok(!source.includes(".rpc("));
});

test("import-scope. la sonde n'importe QUE le résolveur d'environnement Stuart (aucun autre module lib/server/*)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-readiness/route.ts", "utf8");
  const imports = [...source.matchAll(/from\s+["'](@\/lib\/server\/[^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/lib/server/delivery-providers/stuart/environment"]);
});

// ====================================================================
// AUTH TIMING-LENGTH (STUART-V262-AUTH-TIMING-LENGTH-01, LOW)
// ====================================================================

test("AT1. secret readiness CORRECT -- accepté", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET)));
  assert.equal(response.status, 200);
});

test("AT2. secret INCORRECT de MÊME longueur -- rejeté", async () => {
  const sameLength = "x".repeat(READINESS_SECRET.length);
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(sameLength)));
  assert.equal(response.status, 503);
});

test("AT3. secret INCORRECT PLUS COURT -- rejeté", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET.slice(0, 5))));
  assert.equal(response.status, 503);
});

test("AT4. secret INCORRECT PLUS LONG -- rejeté", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET + "extra-suffix")));
  assert.equal(response.status, 503);
});

test("AT5. secret du déclencheur d'orchestration -- rejeté (déjà couvert par 2b, revérifié ici pour la matrice AT)", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(TRIGGER_SECRET_UNRELATED)));
  assert.equal(response.status, 503);
});

test("AT6. en-tête secret ABSENT -- rejeté", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(undefined)));
  assert.equal(response.status, 503);
});

test("AT6b. en-tête secret PRÉSENT MAIS VIDE -- rejeté (STUART-V262-AUTH-TIMING-LENGTH-01, réouvert)", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest("")));
  assert.equal(response.status, 503);
});

test("AT6c. en-tête secret d'UN SEUL caractère incorrect -- rejeté", async () => {
  const response = await withEnv(BASE_ENV, () => GET(readinessRequest(READINESS_SECRET.slice(0, 1))));
  assert.equal(response.status, 503);
});

test("AT7. STUART_SANDBOX_READINESS_SECRET NON CONFIGURÉ côté serveur -- rejeté (fail-closed)", async () => {
  const response = await withEnv({ ...BASE_ENV, STUART_SANDBOX_READINESS_SECRET: undefined }, () => GET(readinessRequest(READINESS_SECRET)));
  assert.equal(response.status, 503);
});

test("AT8. AUCUNE valeur brute de secret n'apparaît jamais, y compris avec des longueurs de secret variées (2/3/4 combinées)", async () => {
  const attempts = [READINESS_SECRET.slice(0, 5), READINESS_SECRET + "x", "z".repeat(READINESS_SECRET.length)];
  for (const attempt of attempts) {
    const response = await withEnv(BASE_ENV, () => GET(readinessRequest(attempt)));
    const text = await response.text();
    assert.ok(!text.includes(attempt));
    assert.ok(!text.includes(READINESS_SECRET));
  }
});

test("AT-structural. l'implémentation ne contient PLUS de retour anticipé basé sur la longueur brute (attaquant OU digest) avant la comparaison cryptographique -- confirmé structurellement", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("app/api/internal/stuart/sandbox-readiness/route.ts", "utf8");
  assert.ok(!/bufA\.length\s*!==\s*bufB\.length/.test(source), "aucune comparaison de longueur brute avant timingSafeEqual ne doit subsister");
  assert.ok(!/provided\.length\s*===\s*0/.test(source), "STUART-V262-AUTH-TIMING-LENGTH-01 (réouvert) : aucun retour anticipé basé sur la longueur de l'entrée CONTRÔLÉE PAR L'APPELANT ne doit subsister");
  assert.match(source, /request\.headers\.get\(SECRET_HEADER\)\s*\?\?\s*""/, "l'entrée de l'appelant doit être normalisée en chaîne vide (jamais un typeof/length check séparé) avant la comparaison");
  assert.ok(source.includes("createHash"), "une empreinte à longueur fixe doit être utilisée avant timingSafeEqual");
});
