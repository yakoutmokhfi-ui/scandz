import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// app/api/track/exchange/route.ts.
//
// Couvre mandat §8 (séquence d'échange), §13 (énumération -- réponse
// générique identique pour toute défaillance de possession), §30.D
// ("exchange POST receives possession material only in request
// body"), §30.E ("valid possession proof establishes presentation
// session"), §30.F/§30.G (jeton invalide / couple croisé -> échec
// générique), §30.L (aucun jeton dans les journaux/erreurs).
//
// Appelle DIRECTEMENT le handler `POST` exporté par route.ts avec un
// vrai `NextRequest` (voir tests/alias-loader.mjs pour la résolution
// de "next/server" sous `node --test`) -- même discipline que les
// autres tests de service de ce dépôt (t.mock.method sur le client
// Supabase RÉEL), jamais un serveur HTTP réellement démarré.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const { supabase } = await import("../lib/supabase.ts");
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/track/exchange/route.ts");
const { verifyTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

const VALID_ROW = {
  order_status: "ready",
  service_mode: "pickup",
  order_number: 104,
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: "2026-01-01T10:05:00Z",
  preparing_at: "2026-01-01T10:10:00Z",
  ready_at: "2026-01-01T10:20:00Z",
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
};

function makeRequest(body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest("https://example.com/api/track/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("mandat §30.D : le corps JSON POST est la SEULE source lue -- l'URL de la requête ne porte ni orderId ni publicToken", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));
  const req = makeRequest({ orderId: ORDER_ID, publicToken: TOKEN });
  assert.equal(req.nextUrl.search, "", "aucune chaîne de requête ne doit porter le jeton");
  assert.equal(req.nextUrl.pathname.includes(TOKEN), false);
  const res = await POST(req);
  assert.equal(res.status, 200);
});

test("mandat §13 : corps JSON malformé -- réponse générique invalide, AUCUN appel RPC", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [VALID_ROW], error: null };
  });
  const res = await POST(makeRequest("{not-json"));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
  assert.equal(called, false);
});

test("mandat §13 : orderId/publicToken absents -- réponse générique invalide, AUCUN appel RPC", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [VALID_ROW], error: null };
  });
  const res = await POST(makeRequest({}));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
  assert.equal(called, false);
});

test("mandat §13 : publicToken mal formé (pas un UUID) -- réponse générique invalide, AUCUN appel RPC", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [VALID_ROW], error: null };
  });
  const res = await POST(makeRequest({ orderId: ORDER_ID, publicToken: "not-a-uuid" }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
  assert.equal(called, false);
});

test("mandat §30.G : couple order_id/public_token croisé (RPC renvoie un ensemble vide) -- réponse générique invalide, MÊME forme que toute autre entrée invalide", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  const res = await POST(makeRequest({ orderId: ORDER_ID, publicToken: TOKEN }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
});

test("panne d'infrastructure (erreur Postgrest) -- réponse générique INDISPONIBLE, catégorie DIFFÉRENTE d'un lien invalide (mandat §13)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "PGRST000", message: "boom", details: null, hint: null },
  }));
  const res = await POST(makeRequest({ orderId: ORDER_ID, publicToken: TOKEN }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, reason: "unavailable" });
});

test("mandat §30.E : preuve de possession valide -- session établie (cookie Set-Cookie présent, attributs corrects, réponse minimale)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));
  const res = await POST(makeRequest({ orderId: ORDER_ID, publicToken: TOKEN }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true }, "le corps de réponse ne doit JAMAIS contenir les données de suivi ni le jeton");

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "un en-tête Set-Cookie doit être présent");
  assert.ok(setCookie!.startsWith(`${TRACKING_SESSION_COOKIE_NAME}=`));
  assert.ok(/HttpOnly/i.test(setCookie!), "HttpOnly requis (mandat §10)");
  assert.ok(/SameSite=Strict/i.test(setCookie!), "SameSite=Strict requis");
  assert.ok(
    setCookie!.includes(`Path=/track/${ORDER_ID}`),
    "Path doit être scindé par commande (mandat §10, 'narrow path where practical')"
  );
  assert.ok(/Max-Age=\d+/i.test(setCookie!), "expiration bornée requise (mandat §10)");

  // Mandat §10 : "no raw public_token stored in ... rendered into
  // HTML" / le jeton (le SECRET porteur) ne doit jamais apparaître EN
  // CLAIR nulle part dans Set-Cookie -- ni dans la VALEUR du cookie
  // (chiffrée, lib/server/tracking-session.ts) ni dans ses attributs.
  assert.equal(setCookie!.includes(TOKEN), false, "le jeton ne doit jamais apparaître en clair dans Set-Cookie");
  // order_id N'EST PAS un secret (il est déjà visible dans l'URL
  // /track/<order_id> elle-même) -- son apparition dans l'attribut
  // Path=/track/<order_id> est INTENTIONNELLE (mandat §10, "narrow
  // path where practical"). Ce qui compte : il n'apparaît PAS dans la
  // VALEUR chiffrée du cookie (avant le premier ';'), seulement dans
  // cet attribut de portée, en clair par construction.
  const cookieNameValue = setCookie!.split(";")[0]!;
  assert.equal(
    cookieNameValue.includes(ORDER_ID),
    false,
    "order_id ne doit jamais apparaître dans la VALEUR chiffrée du cookie elle-même"
  );
  assert.ok(
    setCookie!.includes(`Path=/track/${ORDER_ID}`),
    "order_id apparaît normalement dans l'attribut Path, en clair, par construction"
  );

  // La session émise doit être RÉELLEMENT vérifiable et fidèle.
  const cookieValue = setCookie!.split(";")[0]!.split("=").slice(1).join("=");
  const verified = verifyTrackingSessionToken(cookieValue, ORDER_ID);
  assert.deepEqual(verified, { orderId: ORDER_ID, publicToken: TOKEN });
});

test("mandat §30.F : jeton correctement formé mais possession incorrecte -- même comportement générique qu'un jeton malformé (aucune distinction observable)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  const wellFormedButWrong = "33333333-3333-4333-8333-333333333333";
  const res = await POST(makeRequest({ orderId: ORDER_ID, publicToken: wellFormedButWrong }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
});

test("TRACKING_SESSION_SECRET absent au moment de l'émission -- réponse générique INDISPONIBLE, jamais une erreur 500 brute ni un détail de configuration exposé", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));
  const saved = process.env.TRACKING_SESSION_SECRET;
  try {
    delete process.env.TRACKING_SESSION_SECRET;
    const res = await POST(makeRequest({ orderId: ORDER_ID, publicToken: TOKEN }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, reason: "unavailable" });
  } finally {
    process.env.TRACKING_SESSION_SECRET = saved;
  }
});

test("mandat §30.L : aucun appel de ce handler (succès ou échec) n'invoque console.error/warn/log avec le jeton ou order_id", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "log", (...args: unknown[]) => logs.push(args));

  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));
  await POST(makeRequest({ orderId: ORDER_ID, publicToken: TOKEN }));
  await POST(makeRequest({ orderId: ORDER_ID, publicToken: "not-a-uuid" }));
  await POST(makeRequest("{not-json"));

  for (const call of logs) {
    const serialized = call.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    assert.equal(serialized.includes(TOKEN), false, `le jeton ne doit jamais apparaître dans les logs : ${serialized}`);
    assert.equal(serialized.includes(ORDER_ID), false, `order_id ne doit jamais apparaître dans les logs : ${serialized}`);
  }
});
