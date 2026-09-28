import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — LOT 1 (P0, cookie-path fix) — app/track/[orderId]/
// withdrawal/route.ts, anciennement app/api/track/withdrawal/route.ts.
//
// CONTEXTE (issue #11, marche à pied Production live de Yakout) : la
// confirmation de rétractation échouait systématiquement en Production
// avec WITHDRAWAL_CAPABILITY_INVALID ("Ce lien de suivi n'est plus
// valable"), quelle que soit la validité réelle de la capacité de
// suivi. ROOT CAUSE : le cookie de session `st_session`
// (lib/server/tracking-session.ts) est posé avec
// `path: /track/{orderId}` (mandat §10, "narrow path where
// practical") ; l'ancienne route vivait sous `/api/track/withdrawal`,
// qui N'EST PAS un sous-chemin de `/track/{orderId}` (RFC 6265
// §5.1.4, correspondance de PRÉFIXE DE SEGMENT) -- le navigateur
// n'envoyait donc JAMAIS ce cookie à cette route. CORRECTIF (décision
// Ravel/CIO, Option 3) : déplacer la route sous
// `/track/{orderId}/withdrawal`, un sous-chemin réel de la portée du
// cookie -- la portée du cookie elle-même reste ÉTROITE (jamais
// élargie à "/"), et le modèle d'autorisation (verifyTrackingSessionToken
// + liaison orderId) reste STRICTEMENT inchangé.
//
// LACUNE DE COUVERTURE COMBLÉE PAR CE FICHIER : avant ce lot, AUCUN
// test n'invoquait directement le handler POST de cette route avec un
// VRAI cookie simulé selon la portée RFC 6265 réelle -- la seule
// couverture existante (tests/online-withdrawal-tracking-v1-dom.test.ts)
// mocke `fetch` entièrement (capture URL + corps, jamais de transport
// HTTP/cookie réel), ce qui explique pourquoi ce bug de portée n'a
// jamais été détecté par la suite de tests malgré une couverture DOM
// par ailleurs très complète. Ce fichier COMBINE deux disciplines déjà
// établies dans ce dépôt (voir tests/v122f-tracking-exchange-route.test.ts
// pour l'invocation directe du handler POST de l'échange, et
// tests/v123c-tracking-multiorder-cookie-isolation.dom.test.ts pour
// l'algorithme SimpleCookieJar RFC 6265 §5.1.4), plutôt que d'en
// introduire une nouvelle : capture le VRAI Set-Cookie émis par
// l'échange, simule ce qu'un VRAI navigateur annexerait à une requête
// vers un chemin donné, et invoque le VRAI handler POST de la route de
// rétractation avec ce résultat -- jamais un cookie fabriqué à la
// main.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const { supabase } = await import("../lib/supabase.ts");
const { NextRequest } = await import("next/server");
const { POST: exchangePOST } = await import("../app/api/track/exchange/route.ts");
const { POST: withdrawalPOST } = await import("../app/track/[orderId]/withdrawal/route.ts");
const { verifyTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_A = "22222222-2222-4222-8222-222222222222";
const ORDER_B = "33333333-3333-4333-8333-333333333333";
const CAP_A = "66666666-6666-4666-8666-666666666666";
const SECRET_A = "aa".repeat(32);
const LINE_1 = "77777777-7777-4777-8777-777777777777";
const REQUEST_ID_1 = "88888888-8888-4888-8888-888888888888";

const EXCHANGE_ROW_A = { capability_id: CAP_A, capability_secret: SECRET_A };

// --------------------------------------------------------------
// SimpleCookieJar -- réplique EXACTE de l'algorithme RFC 6265 §5.1.4
// déjà établi et audité dans tests/v123c-tracking-multiorder-cookie-
// isolation.dom.test.ts. Dupliqué ici plutôt que factorisé en module
// partagé, par cohérence avec la préférence déjà observée dans ce
// dépôt pour des fichiers de test autonomes et intégralement
// audités sans dépendance croisée entre suites.
// --------------------------------------------------------------
interface StoredCookie {
  name: string;
  value: string;
  cookiePath: string;
}

class SimpleCookieJar {
  private cookies: StoredCookie[] = [];

  captureSetCookie(setCookieHeader: string): void {
    const parts = setCookieHeader.split(";").map((p) => p.trim());
    const [name, value] = parts[0]!.split("=");
    const pathAttr = parts.find((p) => p.toLowerCase().startsWith("path="));
    const cookiePath = pathAttr ? pathAttr.slice("path=".length) : "/";
    this.cookies.push({ name: name!, value: value!, cookiePath });
  }

  private pathMatches(cookiePath: string, requestPath: string): boolean {
    if (requestPath === cookiePath) return true;
    if (!requestPath.startsWith(cookiePath)) return false;
    if (cookiePath.endsWith("/")) return true;
    return requestPath.charAt(cookiePath.length) === "/";
  }

  /** Reproduit ce qu'un VRAI navigateur annexerait au Cookie header
   *  d'une requête vers `requestPath`. */
  cookiesForPath(requestPath: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const c of this.cookies) {
      if (this.pathMatches(c.cookiePath, requestPath)) {
        result[c.name] = c.value;
      }
    }
    return result;
  }
}

function makeExchangeRequest(body: unknown) {
  return new NextRequest("https://example.com/api/track/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeWithdrawalRequest(orderId: string, body: unknown) {
  return new NextRequest(`https://example.com/track/${orderId}/withdrawal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function establishSessionForOrderA(): Promise<SimpleCookieJar> {
  const jar = new SimpleCookieJar();
  const res = await exchangePOST(makeExchangeRequest({ orderId: ORDER_A, publicToken: TOKEN_A }));
  assert.equal(res.status, 200, "l'échange doit réussir pour établir la session de ce test");
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "Set-Cookie attendu");
  jar.captureSetCookie(setCookie!);
  return jar;
}

function withdrawalBody(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_A,
    firstName: "Victor",
    lastName: "Hugo",
    acknowledgementAddress: "victor.hugo@example.org",
    clientRequestId: REQUEST_ID_1,
    items: [{ orderItemId: LINE_1, quantity: 1 }],
    ...overrides,
  };
}

// ==================================================================
// PREUVE DE LA ROOT CAUSE -- pure logique de portée de cookie,
// n'invoque AUCUNE route. Documente, de façon exécutable et vérifiée
// à chaque exécution de la suite, EXACTEMENT pourquoi l'ancien chemin
// échouait et pourquoi le nouveau fonctionne -- avant même de toucher
// au moindre handler.
// ==================================================================
test("ROOT CAUSE documentée : un cookie Path=/track/{orderId} n'est JAMAIS annexé à une requête vers /api/track/withdrawal, mais l'EST pour /track/{orderId}/withdrawal (RFC 6265 §5.1.4)", () => {
  const jar = new SimpleCookieJar();
  jar.captureSetCookie(`${TRACKING_SESSION_COOKIE_NAME}=opaque; Path=/track/${ORDER_A}; HttpOnly`);

  const forOldPath = jar.cookiesForPath("/api/track/withdrawal");
  assert.equal(
    Object.keys(forOldPath).length,
    0,
    "l'ancien chemin (hors du sous-arbre /track/{orderId}) ne doit recevoir AUCUN cookie -- c'est exactement le bug"
  );

  const forNewPath = jar.cookiesForPath(`/track/${ORDER_A}/withdrawal`);
  assert.equal(
    forNewPath[TRACKING_SESSION_COOKIE_NAME],
    "opaque",
    "le nouveau chemin, sous-chemin réel de la portée du cookie, doit le recevoir -- c'est le correctif"
  );
});

// ==================================================================
// 1. Flux complet, session valide -- échange RÉEL -> cookie RÉEL ->
//    sélection du cookie par le jar pour le NOUVEAU chemin ->
//    confirmation RÉELLE de rétractation.
// ==================================================================
test("flux complet : une session de suivi valide peut mener la rétractation jusqu'à confirmation, via le nouveau chemin /track/{orderId}/withdrawal", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    if (name === "upgrade_legacy_tracking_capability") {
      return { data: [EXCHANGE_ROW_A], error: null };
    }
    if (name === "submit_withdrawal_request_by_capability") {
      return {
        data: [
          {
            withdrawal_request_id: "99999999-9999-4999-8999-999999999999",
            requested_at: "2026-09-28T15:00:00Z",
            acknowledgement_status: "pending",
            replayed: false,
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });

  const jar = await establishSessionForOrderA();
  const cookiesSent = jar.cookiesForPath(`/track/${ORDER_A}/withdrawal`);
  assert.ok(cookiesSent[TRACKING_SESSION_COOKIE_NAME], "le jar doit sélectionner le cookie pour ce chemin");

  (globalThis as any).__mockCookieStore = cookiesSent;
  const res = await withdrawalPOST(makeWithdrawalRequest(ORDER_A, withdrawalBody()));
  (globalThis as any).__mockCookieStore = {};

  assert.equal(res.status, 200, `attendu 200, obtenu ${res.status} : ${JSON.stringify(await res.clone().json())}`);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.withdrawalRequestId, "99999999-9999-4999-8999-999999999999");
  assert.equal(payload.replayed, false);
});

// ==================================================================
// 2. orderId / session non appariés -- rejeté.
// ==================================================================
test("session établie pour la commande A, corps prétendant à la commande B -- rejetée générique (WITHDRAWAL_CAPABILITY_INVALID), aucun appel RPC de soumission", async (t) => {
  let submitCalled = false;
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "upgrade_legacy_tracking_capability") return { data: [EXCHANGE_ROW_A], error: null };
    if (name === "submit_withdrawal_request_by_capability") {
      submitCalled = true;
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const jar = await establishSessionForOrderA();
  // Le cookie a été posé avec Path=/track/{ORDER_A} -- un navigateur
  // réel ne l'enverrait de toute façon jamais sur une requête pour la
  // commande B (portées de chemin différentes), mais ce test vérifie
  // la défense en profondeur CÔTÉ SERVEUR (payload.orderId ===
  // expectedOrderId dans verifyTrackingSessionToken) indépendamment de
  // ce comportement de transport -- au cas où le cookie serait tout de
  // même présenté (ex. sous-domaine partagé, portée navigateur
  // différente d'un jour à l'autre).
  const cookiesSent = jar.cookiesForPath(`/track/${ORDER_A}/withdrawal`);
  (globalThis as any).__mockCookieStore = cookiesSent;
  const res = await withdrawalPOST(makeWithdrawalRequest(ORDER_B, withdrawalBody({ orderId: ORDER_B })));
  (globalThis as any).__mockCookieStore = {};

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, code: "WITHDRAWAL_CAPABILITY_INVALID" });
  assert.equal(submitCalled, false, "aucune soumission ne doit être tentée sans session appariée");
});

// ==================================================================
// 3. Session absente / invalide / expirée -- rejetée, dans les trois
//    cas.
// ==================================================================
test("aucun cookie de session (magasin vide) -- rejetée générique, aucun appel RPC", async (t) => {
  let submitCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    submitCalled = true;
    return { data: [], error: null };
  });
  (globalThis as any).__mockCookieStore = {};
  const res = await withdrawalPOST(makeWithdrawalRequest(ORDER_A, withdrawalBody()));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, code: "WITHDRAWAL_CAPABILITY_INVALID" });
  assert.equal(submitCalled, false);
});

test("cookie de session présent mais altéré/mal formé -- rejetée générique, aucun appel RPC", async (t) => {
  let submitCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    submitCalled = true;
    return { data: [], error: null };
  });
  (globalThis as any).__mockCookieStore = { [TRACKING_SESSION_COOKIE_NAME]: "ceci-nest-pas-un-jeton-valide" };
  const res = await withdrawalPOST(makeWithdrawalRequest(ORDER_A, withdrawalBody()));
  (globalThis as any).__mockCookieStore = {};
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, code: "WITHDRAWAL_CAPABILITY_INVALID" });
  assert.equal(submitCalled, false);
});

test("cookie de session valide mais expiré (30 jours + 1) -- rejetée générique, aucun appel RPC (mandat §10 'bounded expiry', même discipline que tests/v122e-tracking-session.test.ts)", async (t) => {
  let submitCalled = false;
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "upgrade_legacy_tracking_capability") return { data: [EXCHANGE_ROW_A], error: null };
    submitCalled = true;
    return { data: [], error: null };
  });

  const jar = await establishSessionForOrderA();
  const cookiesSent = jar.cookiesForPath(`/track/${ORDER_A}/withdrawal`);

  const DAY_MS = 24 * 60 * 60 * 1000;
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * DAY_MS;
    (globalThis as any).__mockCookieStore = cookiesSent;
    const res = await withdrawalPOST(makeWithdrawalRequest(ORDER_A, withdrawalBody()));
    (globalThis as any).__mockCookieStore = {};
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: "WITHDRAWAL_CAPABILITY_INVALID" });
  } finally {
    Date.now = realNow;
  }
  assert.equal(submitCalled, false);
});

// ==================================================================
// 4. Rejeu / idempotence -- inchangé. Le handler doit simplement
//    RELAYER fidèlement ce que la RPC (autorité réelle de l'idempotence,
//    déjà testée au niveau SQL par tests/online-withdrawal-foundation-v1.test.ts,
//    test "rejeu") renvoie -- ce test vérifie le TRANSPORT, pas la
//    logique d'idempotence elle-même.
// ==================================================================
test("rejeu : deux confirmations avec le même clientRequestId -- le handler relaie fidèlement replayed:true et le MÊME withdrawalRequestId renvoyés par la RPC", async (t) => {
  let calls = 0;
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "upgrade_legacy_tracking_capability") return { data: [EXCHANGE_ROW_A], error: null };
    calls += 1;
    return {
      data: [
        {
          withdrawal_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          requested_at: "2026-09-28T15:00:00Z",
          acknowledgement_status: "pending",
          replayed: calls > 1,
        },
      ],
      error: null,
    };
  });

  const jar = await establishSessionForOrderA();
  const cookiesSent = jar.cookiesForPath(`/track/${ORDER_A}/withdrawal`);
  (globalThis as any).__mockCookieStore = cookiesSent;

  const first = await withdrawalPOST(makeWithdrawalRequest(ORDER_A, withdrawalBody()));
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstPayload.replayed, false);

  const second = await withdrawalPOST(makeWithdrawalRequest(ORDER_A, withdrawalBody()));
  const secondPayload = await second.json();
  (globalThis as any).__mockCookieStore = {};

  assert.equal(second.status, 200);
  assert.equal(secondPayload.replayed, true, "la seconde confirmation avec le même clientRequestId doit être signalée comme rejeu");
  assert.equal(
    secondPayload.withdrawalRequestId,
    firstPayload.withdrawalRequestId,
    "un rejeu doit renvoyer le MÊME identifiant de demande, jamais une seconde demande"
  );
});
