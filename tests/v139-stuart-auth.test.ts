import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  getStuartAccessToken,
  invalidateStuartTokenCache,
  StuartAuthError,
  StuartConfigError,
  StuartInvalidScopeError,
} = await import("../lib/server/delivery-providers/stuart/auth.ts");

// ====================================================================
// DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.1 (ferme
// STUART-V1-AUTH-CONTRACT-01, STUART-V1-AUTH-CACHE-01). fetch()
// mocké -- AUCUN appel réseau réel, jamais de Sandbox/Production
// contactée par ce fichier.
// ====================================================================

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

const BASE_ENV = {
  STUART_ENV: "sandbox",
  STUART_CLIENT_ID: "test-client-id",
  STUART_CLIENT_SECRET: "test-client-secret-DO-NOT-USE",
};

function tokenResponse(overrides: Partial<{ access_token: string; token_type: string; expires_in: number }> = {}) {
  return new Response(
    JSON.stringify({ access_token: "fake-jwt-token", token_type: "bearer", expires_in: 2592000, ...overrides }),
    { status: 200 }
  );
}

test("STUART-V1-AUTH-CONTRACT-01 : configuration manquante -- StuartConfigError, jamais un appel réseau", async (t) => {
  invalidateStuartTokenCache();
  let called = false;
  t.mock.method(globalThis, "fetch", async () => {
    called = true;
    throw new Error("ne doit jamais être appelé");
  });
  await withEnv({ STUART_ENV: "sandbox", STUART_CLIENT_ID: undefined, STUART_CLIENT_SECRET: undefined }, async () => {
    await assert.rejects(() => getStuartAccessToken(), StuartConfigError);
  });
  assert.equal(called, false);
});

test("STUART-V1-AUTH-CONTRACT-01 : URL complète EXACTE et corps de requête EXACT -- grant_type, client_id, client_secret, scope=api", async (t) => {
  invalidateStuartTokenCache();
  let capturedUrl: string | undefined;
  let capturedBody: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = init.body as string;
    return tokenResponse();
  });
  await withEnv(BASE_ENV, async () => {
    await getStuartAccessToken();
  });
  assert.equal(capturedUrl, "https://api.sandbox.stuart.com/oauth/token", "URL complète exacte attendue (base Sandbox officielle + chemin d'authentification)");
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get("grant_type"), "client_credentials");
  assert.equal(params.get("client_id"), "test-client-id");
  assert.equal(params.get("client_secret"), "test-client-secret-DO-NOT-USE");
  assert.equal(params.get("scope"), "api", "scope=api DOIT être envoyé explicitement (ferme STUART-V1-AUTH-CONTRACT-01)");
});

test("STUART-V1-AUTH-CONTRACT-01 : environnement production -- URL de base Production EXACTE utilisée", async (t) => {
  invalidateStuartTokenCache();
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    capturedUrl = url;
    return tokenResponse();
  });
  await withEnv({ ...BASE_ENV, STUART_ENV: "production" }, async () => {
    await getStuartAccessToken();
  });
  assert.equal(capturedUrl, "https://api.stuart.com/oauth/token");
});

test("STUART-V1-AUTH-CONTRACT-01 : succès -- jeton renvoyé", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => tokenResponse());
  await withEnv(BASE_ENV, async () => {
    const token = await getStuartAccessToken();
    assert.equal(token, "fake-jwt-token");
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : token_type inattendu (ni \"bearer\" ni \"Bearer\") -- StuartAuthError, jamais silencieusement accepté", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => tokenResponse({ token_type: "mac" }));
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken(), StuartAuthError);
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : token_type=\"Bearer\" (majuscule) -- ACCEPTÉ (comparaison insensible à la casse)", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => tokenResponse({ token_type: "Bearer" }));
  await withEnv(BASE_ENV, async () => {
    const token = await getStuartAccessToken();
    assert.equal(token, "fake-jwt-token");
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : invalid_scope -- StuartInvalidScopeError, CLASSIFIÉE distinctement des autres échecs", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_scope", error_description: "boom" }), { status: 400 }));
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken(), StuartInvalidScopeError);
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : JSON malformé -- StuartAuthError", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => new Response("ceci n'est pas du JSON", { status: 200 }));
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken(), StuartAuthError);
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : access_token absent -- StuartAuthError", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ token_type: "bearer", expires_in: 2592000 }), { status: 200 }));
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken(), StuartAuthError);
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : HTTP 401 (générique, sans error=invalid_scope) -- StuartAuthError, PAS StuartInvalidScopeError", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken(), (err: unknown) => err instanceof StuartAuthError && !(err instanceof StuartInvalidScopeError));
  });
});

test("STUART-V1-AUTH-CONTRACT-01 : HTTP 400 générique -- StuartAuthError", async (t) => {
  invalidateStuartTokenCache();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }));
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken(), StuartAuthError);
  });
});

test("STUART-V1-AUTH-CONTRACT-01 (SÉCURITÉ) : le client_secret n'apparaît JAMAIS dans le message d'une erreur levée, y compris en cas d'échec réseau/HTTP", async (t) => {
  invalidateStuartTokenCache();
  const SECRET = "ultra-secret-value-should-never-leak-anywhere-XYZ123";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
  await withEnv({ ...BASE_ENV, STUART_CLIENT_SECRET: SECRET }, async () => {
    try {
      await getStuartAccessToken();
      assert.fail("une erreur était attendue");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(SECRET), "le secret ne doit JAMAIS apparaître dans le message d'erreur");
    }
  });
});

test("STUART-V1-AUTH-CACHE-01 : jeton mis en cache -- un second appel séquentiel n'invoque PAS fetch de nouveau", async (t) => {
  invalidateStuartTokenCache();
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    return tokenResponse();
  });
  await withEnv(BASE_ENV, async () => {
    const t1 = await getStuartAccessToken();
    const t2 = await getStuartAccessToken();
    assert.equal(t1, t2);
  });
  assert.equal(callCount, 1);
});

test("STUART-V1-AUTH-CACHE-01 : SINGLE-FLIGHT -- deux appelants CONCURRENTS à cache froid déclenchent UNE SEULE requête réseau", async (t) => {
  invalidateStuartTokenCache();
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    await new Promise((r) => setTimeout(r, 20));
    return tokenResponse();
  });
  await withEnv(BASE_ENV, async () => {
    const [t1, t2] = await Promise.all([getStuartAccessToken(), getStuartAccessToken()]);
    assert.equal(t1, t2);
  });
  assert.equal(callCount, 1, "un seul appel réseau attendu pour deux appelants concurrents à cache froid");
});

test("STUART-V1-AUTH-CACHE-01 : échec du renouvellement -- les DEUX appelants concurrents rejettent, l'état in-flight est correctement effacé", async (t) => {
  invalidateStuartTokenCache();
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  });
  await withEnv(BASE_ENV, async () => {
    const results = await Promise.allSettled([getStuartAccessToken(), getStuartAccessToken()]);
    assert.ok(results.every((r) => r.status === "rejected"), "les deux appelants doivent rejeter identiquement");
  });
  assert.equal(callCount, 1, "un seul appel réseau, même en cas d'échec partagé");
});

test("STUART-V1-AUTH-CACHE-01 : nouvel essai APRÈS un échec -- une nouvelle requête réseau est bien émise (l'état in-flight a été effacé)", async (t) => {
  invalidateStuartTokenCache();
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    if (callCount === 1) return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
    return tokenResponse();
  });
  await withEnv(BASE_ENV, async () => {
    await assert.rejects(() => getStuartAccessToken());
    const token = await getStuartAccessToken();
    assert.equal(token, "fake-jwt-token");
  });
  assert.equal(callCount, 2);
});

test("STUART-V1-AUTH-CACHE-01 : jeton à COURTE durée de vie (300s) reste néanmoins mis en cache -- la marge de sécurité est BORNÉE, jamais disproportionnée", async (t) => {
  invalidateStuartTokenCache();
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    return tokenResponse({ expires_in: 300 });
  });
  await withEnv(BASE_ENV, async () => {
    const t1 = await getStuartAccessToken();
    const t2 = await getStuartAccessToken();
    assert.equal(t1, t2, "un jeton de 300s doit rester en cache pour un second appel immédiat -- preuve que la marge n'est jamais >= à la durée de vie elle-même");
  });
  assert.equal(callCount, 1, "un seul appel réseau -- le cache fonctionne même pour une durée de vie courte");
});

test("STUART-V1-AUTH-CACHE-01 : invalidateStuartTokenCache() force un nouvel appel réseau (comportement officiel recommandé sur INVALID_GRANT)", async (t) => {
  invalidateStuartTokenCache();
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    return tokenResponse({ access_token: `token-${callCount}` });
  });
  await withEnv(BASE_ENV, async () => {
    const t1 = await getStuartAccessToken();
    invalidateStuartTokenCache();
    const t2 = await getStuartAccessToken();
    assert.notEqual(t1, t2);
  });
  assert.equal(callCount, 2);
});
