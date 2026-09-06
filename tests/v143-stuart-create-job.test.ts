import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-v2-e2e-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const {
  createStuartSandboxJobForOrder,
  StuartProductionForbiddenError,
  StuartCreateJobAmbiguousError,
  StuartCreateJobBlockedByAmbiguityError,
  StuartCreateJobTerminalFailureError,
} = await import("../lib/server/delivery-providers/stuart/create-job.ts");
const { invalidateStuartTokenCache } = await import("../lib/server/delivery-providers/stuart/auth.ts");

// ====================================================================
// DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.2 (ferme
// STUART-V21-CREATE-JOB-ID-CONTRACT-01 BLOCKER,
// STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01 HIGH). fetch()/RPC
// mockés -- AUCUN appel réseau/DB réel.
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

const BASE_ENV = { STUART_ENV: "sandbox", STUART_CLIENT_ID: "x", STUART_CLIENT_SECRET: "y" };

const INPUT = {
  orderId: "order-1",
  restaurantId: "resto-1",
  pickup: { address: "1 rue A, Paris", contact: { phone: "+33600000001", firstname: "M", lastname: "P" } },
  dropoff: { address: "2 rue B, Paris", contact: { phone: "+33600000002", firstname: "A", lastname: "D" }, packageType: "small" as const },
};

function routeRpc(t: { mock: { method: Function } }, byName: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const handler = byName[name];
    if (!handler) throw new Error(`RPC non mockée dans ce test : ${name}`);
    return handler(args);
  });
  return calls;
}

function freshAllocationHandlers(overrides: Partial<{ send_state: string; stuart_job_id: string | null }> = {}) {
  return {
    allocate_stuart_delivery_job: () => ({
      data: [{ id: "row-1", client_reference: "ABCDEF1234", is_new_allocation: true, collision: false, send_state: "allocated", stuart_job_id: null, ...overrides }],
      error: null,
    }),
    mark_stuart_delivery_job_send_started: () => ({ data: null, error: null }),
    mark_stuart_delivery_job_ambiguous: () => ({ data: null, error: null }),
    mark_stuart_delivery_job_terminal_failure: () => ({ data: null, error: null }),
    confirm_stuart_delivery_job_created: () => ({ data: null, error: null }),
  };
}

function mockFetchWithBody(responseBody: unknown, status: number) {
  return async (url: string) => {
    if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    return new Response(JSON.stringify(responseBody), { status });
  };
}
function mockFetchNetworkFailure() {
  return async (url: string) => {
    if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    throw new Error("network failure simulated");
  };
}

test("STUART-V2-CREATE-JOB-ALLOCATION-COUPLING-01 : la primitive HTTP brute n'est PLUS exportée", async () => {
  const mod = await import("../lib/server/delivery-providers/stuart/create-job.ts");
  assert.equal((mod as Record<string, unknown>).createStuartSandboxJob, undefined);
  assert.equal((mod as Record<string, unknown>).sendStuartCreateJobHttp, undefined);
  assert.equal(typeof mod.createStuartSandboxJobForOrder, "function");
});

test("STUART-V2-CREATE-JOB-ALLOCATION-COUPLING-01 : la référence injectée est TOUJOURS celle allouée durablement", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers());
  let capturedBody: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 2592000 }), { status: 200 });
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ id: 100202968 }), { status: 201 });
  });
  await withEnv(BASE_ENV, async () => { await createStuartSandboxJobForOrder(INPUT); });
  const parsedPayload = JSON.parse(capturedBody!);
  assert.equal(parsedPayload.job.dropoffs[0].client_reference, "ABCDEF1234");
});

test("STUART-V2-SANDBOX-GATE-01 : STUART_ENV=production -- rejet AVANT tout appel RPC/réseau", async (t) => {
  invalidateStuartTokenCache();
  let rpcCalled = false;
  t.mock.method(client, "rpc", async () => { rpcCalled = true; throw new Error("ne doit jamais être appelé"); });
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("ne doit jamais être appelé"); });
  await withEnv({ ...BASE_ENV, STUART_ENV: "production" }, async () => {
    await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartProductionForbiddenError);
  });
  assert.equal(rpcCalled, false);
  assert.equal(fetchCalled, false);
});

// ====================================================================
// STUART-V21-CREATE-JOB-ID-CONTRACT-01 (BLOCKER) — contrat réel :
// identifiant NUMÉRIQUE (ex. 100202968), jamais une chaîne.
// ====================================================================

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : ID numérique valide (100202968) -- created_confirmed, canonicalisé en chaîne EXACTE '100202968'", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ id: 100202968 }, 201));
  const result = await withEnv(BASE_ENV, () => createStuartSandboxJobForOrder(INPUT));
  assert.equal(result.sendState, "created_confirmed");
  assert.equal(result.stuartJobId, "100202968");
  assert.equal(typeof result.stuartJobId, "string");
  const confirmCall = calls.find((c) => c.name === "confirm_stuart_delivery_job_created");
  assert.equal(confirmCall!.args.p_stuart_job_id, "100202968", "aucune notation scientifique, aucune troncature");
});

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : id ABSENT -- send_ambiguous, jamais terminal", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({}, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
  assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
  assert.ok(!calls.some((c) => c.name === "mark_stuart_delivery_job_terminal_failure"));
});

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : id = null -- send_ambiguous", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ id: null }, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
});

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : id = '100202968' (CHAÎNE) -- REJETÉ, ambigu (aucune preuve documentaire que Stuart retourne une chaîne)", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ id: "100202968" }, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
});

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : id = 1.5 (non entier) -- ambigu si contrat entier requis", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ id: 1.5 }, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
});

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : id = -1 (négatif) -- ambigu, aucune preuve d'ID <= 0 documentée", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ id: -1 }, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
});

test("STUART-V21-CREATE-JOB-ID-CONTRACT-01 : id = 0 -- ambigu (positif strict requis)", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ id: 0 }, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
});

// ====================================================================
// STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01 (HIGH)
// ====================================================================

test("STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01 : timeout réseau -- send_ambiguous", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchNetworkFailure());
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
  assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
  assert.ok(!calls.some((c) => c.name === "confirm_stuart_delivery_job_created"));
});

for (const status of [408, 429, 500, 503, 502, 504, 400, 401, 403, 404, 422]) {
  test(`STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01 : HTTP ${status} REÇU -- AMBIGU (jamais terminal, aucune preuve documentaire de rejet pré-création pour ce code)`, async (t) => {
    invalidateStuartTokenCache();
    const calls = routeRpc(t, freshAllocationHandlers());
    t.mock.method(globalThis, "fetch", mockFetchWithBody({ error: "rejected" }, status));
    await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
    assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"), `HTTP ${status} doit être classé ambigu`);
    assert.ok(!calls.some((c) => c.name === "mark_stuart_delivery_job_terminal_failure"), `HTTP ${status} ne doit JAMAIS être classé terminal dans ce lot`);
  });
}

test("STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01 : code HTTP totalement inconnu/inattendu (599) -- AMBIGU par défaut (fail-safe)", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({}, 599));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
  assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
});

test("STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01 : mark_stuart_delivery_job_terminal_failure n'est JAMAIS appelée dans toute la suite de tests HTTP ci-dessus (liste d'autorisation terminale vide dans ce lot)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("lib/server/delivery-providers/stuart/create-job.ts", "utf8");
  assert.match(source, /DOCUMENTED_TERMINAL_HTTP_STATUSES.*=.*new Set\(\[\]\)/, "la liste d'autorisation terminale doit rester explicitement vide tant qu'aucune preuve documentaire n'est fournie");
});

test("STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01 : réponse 2xx MALFORMÉE (id absent) -- AMBIGUË, jamais un succès", async (t) => {
  invalidateStuartTokenCache();
  const calls = routeRpc(t, freshAllocationHandlers());
  t.mock.method(globalThis, "fetch", mockFetchWithBody({ unexpected: "shape" }, 201));
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobAmbiguousError); });
  assert.ok(calls.some((c) => c.name === "mark_stuart_delivery_job_ambiguous"));
});

test("STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01 : allocation déjà send_ambiguous -- BLOQUE toute reprise automatique, AUCUN appel réseau", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers({ send_state: "send_ambiguous" }));
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("ne doit jamais être appelé"); });
  await withEnv(BASE_ENV, async () => { await assert.rejects(() => createStuartSandboxJobForOrder(INPUT), StuartCreateJobBlockedByAmbiguityError); });
  assert.equal(fetchCalled, false);
});

test("STUART-V2-CREATE-JOB-ALLOCATION-COUPLING-01 : allocation déjà created_confirmed -- retourne l'état existant SANS second envoi réseau", async (t) => {
  invalidateStuartTokenCache();
  routeRpc(t, freshAllocationHandlers({ send_state: "created_confirmed", stuart_job_id: "100202968" }));
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => { fetchCalled = true; throw new Error("ne doit jamais être appelé"); });
  const result = await withEnv(BASE_ENV, () => createStuartSandboxJobForOrder(INPUT));
  assert.equal(result.stuartJobId, "100202968");
  assert.equal(fetchCalled, false);
});
