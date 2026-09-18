import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// ====================================================================
// Scanym — CUSTOMER TRACKING v3.1 — LIEN E-MAIL RÉUTILISABLE.
//
// Scénarios obligatoires A..L, de bout en bout côté application :
// worker de notification -> gabarit -> lien (fragment) -> analyse du
// fragment (porte d'entrée) -> POST /api/track/exchange -> cookie de
// session -> lecture par capacité (comme app/track/[orderId]/page.tsx).
//
// Les deux clients Supabase RÉELS (anon pour le suivi, service_role
// pour le worker) sont routés vers un FAUX STATEFUL qui reproduit la
// sémantique SQL de supabase/DRAFT-lot-customer-tracking-capability-
// v3-1.sql (hash seul, liaison commande, expiration, one-shot legacy).
// La preuve PostgreSQL réelle des mêmes propriétés (dont la concurrence
// réelle sous verrou FOR UPDATE et l'isolation tenant) est dans
// supabase/tests/customer-tracking-capability-v3-1-check.sh, sections
// [3], [5], [6] et [6bis].
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "v169-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";
process.env.TRACKING_SESSION_SECRET =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const { supabase } = await import("../lib/supabase.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const adminClient = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/track/exchange/route.ts");
const { verifyTrackingSessionToken } = await import("../lib/server/tracking-session.ts");
const { getOrderTracking } = await import("../lib/server/tracking-service.ts");
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { parseTrackingFragment } = await import("../lib/tracking/link.ts");

// --------------------------------------------------------------------
// Faux stateful (sémantique SQL v3.1).
// --------------------------------------------------------------------

interface FakeOrder {
  id: string;
  tenant: string;
  publicToken: string;
}
interface FakeCapability {
  id: string;
  orderId: string;
  kind: "legacy_upgrade" | "email";
  secretHash: string | null;
  expiresAt: number | null;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const mintSecret = () => randomBytes(32).toString("hex");

function makeFakeDb() {
  const orders = new Map<string, FakeOrder>();
  const caps: FakeCapability[] = [];
  const calls: string[] = [];

  function addOrder(tenant: string): FakeOrder {
    const o = { id: randomUUID(), tenant, publicToken: randomUUID() };
    orders.set(o.id, o);
    return o;
  }

  function trackingRow(orderId: string) {
    return {
      bound_order_id: orderId,
      order_status: "preparing",
      service_mode: "pickup",
      order_number: 7,
      created_at: "2026-09-18T10:00:00Z",
      accepted_at: "2026-09-18T10:01:00Z",
      preparing_at: "2026-09-18T10:02:00Z",
      ready_at: null,
      completed_at: null,
      rejected_at: null,
      cancelled_at: null,
      order_total: "19.90",
      order_currency: "EUR",
      invoice_requested: false,
    };
  }

  // Tout le corps est SYNCHRONE (aucun await) : exactement comme le
  // verrou FOR UPDATE de la ligne commande côté SQL, deux appels
  // concurrents ne peuvent jamais s'entrelacer entre lecture et claim.
  function rpc(name: string, args: Record<string, any>) {
    calls.push(name);
    switch (name) {
      case "get_order_tracking_by_capability": {
        const c = caps.find(
          (x) =>
            x.id === args.p_capability_id &&
            x.orderId === args.p_order_id &&
            orders.has(args.p_order_id) &&
            x.secretHash !== null &&
            (x.expiresAt === null || x.expiresAt > Date.now()) &&
            typeof args.p_secret === "string" &&
            args.p_secret.length === 64 &&
            x.secretHash === sha256(args.p_secret)
        );
        return { data: c ? [trackingRow(c.orderId)] : [], error: null };
      }
      case "upgrade_legacy_tracking_capability": {
        const o = orders.get(args.p_order_id);
        if (!o || o.publicToken !== args.p_public_token) return { data: [], error: null };
        let c = caps.find((x) => x.orderId === o.id && x.kind === "legacy_upgrade");
        if (!c) {
          c = { id: randomUUID(), orderId: o.id, kind: "legacy_upgrade", secretHash: null, expiresAt: null };
          caps.push(c);
        }
        if (c.secretHash !== null) return { data: [], error: null };
        const secret = mintSecret();
        c.secretHash = sha256(secret);
        return { data: [{ capability_id: c.id, capability_secret: secret }], error: null };
      }
      case "issue_order_email_tracking_capability": {
        const o = orders.get(args.p_order_id);
        if (!o) return { data: [], error: null };
        if (caps.filter((x) => x.orderId === o.id && x.kind === "email").length >= 16) {
          return { data: [], error: null };
        }
        const secret = mintSecret();
        const c: FakeCapability = {
          id: randomUUID(),
          orderId: o.id,
          kind: "email",
          secretHash: sha256(secret),
          expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
        };
        caps.push(c);
        return { data: [{ capability_id: c.id, capability_secret: secret }], error: null };
      }
      default:
        throw new Error(`RPC inattendue : ${name}`);
    }
  }

  return { orders, caps, calls, addOrder, rpc };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

function install(t: { mock: { method: Function } }, db: FakeDb, notifications: Array<Record<string, unknown>> = []) {
  // Client anon (suivi) : RPC de lecture/échange UNIQUEMENT -- l'émission
  // e-mail est service_role (le SQL la refuse à anon/authenticated).
  t.mock.method(supabase, "rpc", async (name: string, args: Record<string, any>) => {
    if (name === "issue_order_email_tracking_capability") {
      return { data: null, error: { code: "42501", message: "permission denied" } };
    }
    return db.rpc(name, args);
  });
  t.mock.method(adminClient, "rpc", async (name: string, args: Record<string, any>) => {
    if (name === "claim_pending_notifications") return { data: notifications.splice(0), error: null };
    if (name === "complete_notification_attempt") return { data: null, error: null };
    return db.rpc(name, args);
  });
}

function claimRow(orderId: string, publicToken: string) {
  return {
    outbox_id: randomUUID(),
    restaurant_id: randomUUID(),
    order_id: orderId,
    notification_type: "order_received",
    recipient_email: "client@example.com",
    locale: "fr",
    payload_snapshot: {
      order_number: 7,
      total: 19.9,
      currency: "EUR",
      service_mode: "pickup",
      public_token: publicToken,
      created_at: "2026-09-18T10:00:00Z",
    },
    attempt_count: 0,
    claim_token: randomUUID(),
    sender_name: "Au Lait Cru",
    sender_email: "commandes@aulaitcru.example",
    reply_to: null,
  };
}

/** Envoie l'e-mail ORDER_RECEIVED via le VRAI worker et renvoie l'URL de suivi du texte. */
async function sendOrderReceivedEmail(t: any, db: FakeDb, order: FakeOrder) {
  install(t, db, [claimRow(order.id, order.publicToken)]);
  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  assert.equal(result.sent, 1);
  const m = provider.sent[0]!.text.match(/https:\/\/\S+/);
  assert.ok(m, "lien de suivi attendu dans l'e-mail");
  return { url: new URL(m![0]), message: provider.sent[0]! };
}

/** Ce que fait components/TrackingEntryGate.tsx à partir de l'URL ouverte. */
function gateBody(url: URL): Record<string, string> {
  const fragment = parseTrackingFragment(decodeURIComponent(url.hash.slice(1)));
  assert.ok(fragment, "fragment reconnu");
  const orderId = decodeURIComponent(url.pathname.split("/")[2]!);
  return fragment!.kind === "legacy"
    ? { orderId, publicToken: fragment!.publicToken }
    : { orderId, capabilityId: fragment!.capabilityId, secret: fragment!.secret };
}

/** Requête telle qu'émise par la porte d'entrée (fetch same-origin). `null` retire un en-tête. */
function exchange(body: unknown, overrides: Record<string, string | null> = {}) {
  const merged: Record<string, string | null> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    host: "app.scanym.example",
    origin: "https://app.scanym.example",
    ...overrides,
  };
  const headers = Object.fromEntries(
    Object.entries(merged).filter((e): e is [string, string] => e[1] !== null)
  );
  return POST(
    new NextRequest("https://app.scanym.example/api/track/exchange", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function cookieValue(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "Set-Cookie attendu");
  return setCookie!.split(";")[0]!.split("=").slice(1).join("=");
}

/** Ce que fait app/track/[orderId]/page.tsx à partir du cookie. */
async function readPage(cookie: string, orderId: string) {
  const session = verifyTrackingSessionToken(cookie, orderId);
  if (!session) return null;
  return getOrderTracking(session);
}

// --------------------------------------------------------------------
// A..E : réutilisabilité.
// --------------------------------------------------------------------

test("A. nouvel e-mail, première ouverture : lien capacité v3.1 (jamais public_token) -> session établie -> suivi lisible", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);

  assert.equal(url.pathname, `/track/${order.id}`);
  assert.ok(url.hash.startsWith("#c1."), "fragment capacité v3.1 attendu");
  assert.equal(url.href.includes(order.publicToken), false, "le public_token legacy ne doit plus figurer dans un nouvel e-mail");
  const emailCaps = db.caps.filter((c) => c.kind === "email");
  assert.equal(emailCaps.length, 1);
  assert.equal(emailCaps[0]!.orderId, order.id);

  const res = await exchange(gateBody(url));
  assert.equal(res.status, 200);
  const tracking = await readPage(cookieValue(res), order.id);
  assert.equal(tracking?.orderStatus, "preparing");
});

test("B. même lien rouvert dans le même navigateur : la session existante suffit, et un nouvel échange réussit aussi (rien n'est consommé)", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);

  const first = await exchange(gateBody(url));
  const cookie = cookieValue(first);
  assert.equal((await readPage(cookie, order.id))?.orderNumber, 7);
  assert.equal((await readPage(cookie, order.id))?.orderNumber, 7);

  const again = await exchange(gateBody(url));
  assert.equal(again.status, 200);
  assert.ok(await readPage(cookieValue(again), order.id));
});

test("C. rouvert APRÈS suppression du cookie : nouvel échange réussi avec le même lien", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);

  await exchange(gateBody(url)); // cookie ensuite supprimé : rien n'est conservé ici
  const res = await exchange(gateBody(url));
  assert.equal(res.status, 200);
  assert.equal((await readPage(cookieValue(res), order.id))?.orderStatus, "preparing");
});

test("D. second navigateur/appareil : le même lien fonctionne, SANS rotation ni invalidation de l'identifiant e-mail ni de la session du premier appareil", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);
  const capsBefore = JSON.stringify(db.caps);

  const deviceOne = cookieValue(await exchange(gateBody(url)));
  db.calls.length = 0;
  const deviceTwo = cookieValue(await exchange(gateBody(url)));

  assert.deepEqual(db.calls, ["get_order_tracking_by_capability"], "l'échange e-mail n'est qu'une lecture");
  assert.equal(JSON.stringify(db.caps), capsBefore, "aucune capacité créée, modifiée ni supprimée");
  assert.ok(await readPage(deviceOne, order.id), "le premier appareil reste valide");
  assert.ok(await readPage(deviceTwo, order.id), "le second appareil est valide");
  const third = await exchange(gateBody(url));
  assert.equal(third.status, 200, "le lien reste réutilisable ensuite");
});

test("E. navigation inter-sites depuis un webmail : cookie SameSite=Lax (envoyé sur la navigation GET de premier niveau), échange de même origine accepté, POST inter-sites refusé sans aucun appel RPC", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);
  const body = gateBody(url);

  // Arrivée depuis mail.example : la page elle-même est un GET inter-sites
  // (aucun corps, aucun secret transmis au serveur -- fragment). La porte
  // d'entrée émet ensuite un fetch de MÊME ORIGINE.
  const ok = await exchange(body);
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get("set-cookie")!;
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.ok(setCookie.includes(`Path=/track/${order.id}`));

  db.calls.length = 0;
  const crossSite = await exchange(body, { "sec-fetch-site": "cross-site", origin: "https://mail.example" });
  assert.equal(crossSite.status, 400);
  assert.equal(crossSite.headers.get("set-cookie"), null);
  const sameSiteOtherOrigin = await exchange(body, { "sec-fetch-site": "same-site" });
  assert.equal(sameSiteOtherOrigin.status, 400);
  const formPost = await exchange(JSON.stringify(body), { "content-type": "text/plain" });
  assert.equal(formPost.status, 400, "un formulaire HTML (text/plain) ne peut pas fixer de session");
  const noFetchMetadataForeignOrigin = await exchange(body, { "sec-fetch-site": null, origin: "https://evil.example" });
  assert.equal(noFetchMetadataForeignOrigin.status, 400);
  assert.deepEqual(db.calls, [], "aucune requête inter-sites n'atteint la base");

  // Navigateur sans Fetch Metadata mais Origin identique : accepté.
  const legacyBrowser = await exchange(body, { "sec-fetch-site": null });
  assert.equal(legacyBrowser.status, 200);
  // ... y compris Origin: null (POST de même origine sous
  // Referrer-Policy: no-referrer, en-tête posé sur /track/*).
  const noReferrerPolicy = await exchange(body, { "sec-fetch-site": null, origin: "null" });
  assert.equal(noReferrerPolicy.status, 200);
});

// --------------------------------------------------------------------
// F, G, L : liaison commande / secret / tenant.
// --------------------------------------------------------------------

test("F. mauvaise commande : l'identifiant e-mail de la commande X présenté pour Y -> invalide générique, aucun cookie", async (t) => {
  const db = makeFakeDb();
  const x = db.addOrder("tenant-one");
  const y = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, x);
  const body = gateBody(url);

  const res = await exchange({ ...body, orderId: y.id });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
  assert.equal(res.headers.get("set-cookie"), null);

  // Session légitime de X jamais utilisable pour Y.
  const cookieX = cookieValue(await exchange(body));
  assert.equal(await readPage(cookieX, y.id), null);
});

test("G. mauvaise capacité / mauvais secret / forme invalide / mélange de formes -> même réponse invalide générique", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);
  const body = gateBody(url);

  const cases: unknown[] = [
    { ...body, secret: mintSecret() },
    { ...body, capabilityId: randomUUID() },
    { ...body, secret: body.secret!.toUpperCase() },
    { ...body, secret: body.secret!.slice(0, 63) },
    { ...body, secret: order.publicToken },
    { ...body, publicToken: order.publicToken },
    { orderId: order.id, capabilityId: body.capabilityId },
    { orderId: order.id, secret: body.secret },
  ];
  for (const c of cases) {
    const res = await exchange(c);
    assert.equal(res.status, 400, JSON.stringify(c));
    assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
    assert.equal(res.headers.get("set-cookie"), null);
  }
  // Le vrai lien reste valide après ces tentatives.
  assert.equal((await exchange(body)).status, 200);
});

test("G'. identifiant e-mail EXPIRÉ (borne SQL de 30 jours) -> invalide générique", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);
  const cookie = cookieValue(await exchange(gateBody(url)));

  db.caps.find((c) => c.kind === "email")!.expiresAt = Date.now() - 1;
  const res = await exchange(gateBody(url));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid" });
  // Même une session déjà posée ne relit plus rien : chaque rendu repasse par la RPC.
  await assert.rejects(() => readPage(cookie, order.id));
});

test("L. isolation tenant : l'identifiant e-mail d'une commande du tenant A ne lit jamais une commande du tenant B (ni l'inverse)", async (t) => {
  const db = makeFakeDb();
  const a = db.addOrder("tenant-one");
  const b = db.addOrder("tenant-two");
  const linkA = gateBody((await sendOrderReceivedEmail(t, db, a)).url);
  const linkB = gateBody((await sendOrderReceivedEmail(t, db, b)).url);

  for (const [link, other] of [[linkA, b], [linkB, a]] as const) {
    const res = await exchange({ ...link, orderId: other.id });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  const cross = await exchange({ orderId: a.id, capabilityId: linkB.capabilityId, secret: linkA.secret });
  assert.equal(cross.status, 400);
  assert.ok(await readPage(cookieValue(await exchange(linkA)), a.id));
  assert.ok(await readPage(cookieValue(await exchange(linkB)), b.id));
});

// --------------------------------------------------------------------
// H, I, J : liens legacy historiques inchangés.
// --------------------------------------------------------------------

function legacyUrl(order: FakeOrder): URL {
  // Format EXACT des e-mails historiques : /track/<order_id>#<public_token>.
  return new URL(`https://app.scanym.example/track/${order.id}#${order.publicToken}`);
}

test("H. lien legacy historique, premier échange : upgrade one-shot réussi -> session -> suivi lisible", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  install(t, db);

  const body = gateBody(legacyUrl(order));
  assert.deepEqual(body, { orderId: order.id, publicToken: order.publicToken });
  const res = await exchange(body);
  assert.equal(res.status, 200);
  assert.deepEqual(db.calls, ["upgrade_legacy_tracking_capability"]);
  assert.ok(await readPage(cookieValue(res), order.id));
});

test("I. rejeu du lien legacy : refusé, AUCUNE réémission de secret, aucune capacité e-mail créée en repli, session initiale intacte", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  install(t, db);

  const cookie = cookieValue(await exchange(gateBody(legacyUrl(order))));
  const capsAfterFirst = JSON.stringify(db.caps);
  for (let i = 0; i < 3; i++) {
    const replay = await exchange(gateBody(legacyUrl(order)));
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { ok: false, reason: "invalid" });
    assert.equal(replay.headers.get("set-cookie"), null);
  }
  assert.equal(JSON.stringify(db.caps), capsAfterFirst, "aucune rotation ni réémission");
  assert.equal(db.calls.includes("issue_order_email_tracking_capability"), false);
  assert.ok(await readPage(cookie, order.id), "la session du premier échange reste valide");
});

test("J. upgrades legacy concurrents : EXACTEMENT un succès, une seule capacité legacy", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  install(t, db);

  const results = await Promise.all(Array.from({ length: 10 }, () => exchange(gateBody(legacyUrl(order)))));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 400).length, 9);
  assert.equal(db.caps.filter((c) => c.kind === "legacy_upgrade").length, 1);
});

test("H+. un identifiant e-mail n'empêche jamais le premier upgrade d'un lien legacy de la même commande (et inversement)", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const { url } = await sendOrderReceivedEmail(t, db, order);
  install(t, db);

  assert.equal((await exchange(gateBody(legacyUrl(order)))).status, 200);
  assert.equal((await exchange(gateBody(legacyUrl(order)))).status, 400);
  assert.equal((await exchange(gateBody(url))).status, 200);
});

// --------------------------------------------------------------------
// K : aucun secret dans le chemin, la query ni les journaux.
// --------------------------------------------------------------------

test("K. aucun secret dans le chemin/la query/les journaux/les réponses/les champs persistés du worker", async (t) => {
  const logs: unknown[][] = [];
  for (const level of ["log", "error", "warn", "info"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => logs.push(args));
  }
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const completeArgs: unknown[] = [];
  install(t, db, [claimRow(order.id, order.publicToken)]);
  const origAdminRpc = (adminClient as any).rpc;
  t.mock.method(adminClient, "rpc", async (name: string, args: Record<string, any>) => {
    if (name === "complete_notification_attempt") completeArgs.push(args);
    return origAdminRpc.call(adminClient, name, args);
  });
  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  const url = new URL(provider.sent[0]!.text.match(/https:\/\/\S+/)![0]);
  const body = gateBody(url);

  // Le secret n'est JAMAIS dans la partie envoyée au serveur (chemin + query).
  assert.equal(url.search, "");
  assert.equal(url.pathname.includes(body.secret!), false);
  assert.equal(url.pathname.includes(body.capabilityId!), false);
  // Idempotency key / sujet / en-têtes du message : aucun secret.
  const msg = provider.sent[0]!;
  for (const field of [msg.subject, msg.idempotencyKey, msg.to, msg.from]) {
    assert.equal(String(field).includes(body.secret!), false);
  }
  assert.equal(JSON.stringify(completeArgs).includes(body.secret!), false);
  // Seul le hash est stocké.
  assert.equal(JSON.stringify(db.caps).includes(body.secret!), false);

  const res = await exchange(body);
  const text = await res.text();
  assert.equal(text.includes(body.secret!), false);
  assert.equal(res.headers.get("set-cookie")!.includes(body.secret!), false);
  await exchange({ ...body, secret: mintSecret() });
  await exchange({ ...body, orderId: randomUUID() });

  const serialized = logs.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
  assert.equal(serialized.includes(body.secret!), false, `secret journalisé : ${serialized}`);
  assert.equal(serialized.includes(body.capabilityId!), false);
});

test("K'. le worker n'envoie JAMAIS d'e-mail sans lien valide : panne d'émission -> échec réessayable, commande introuvable/plafond -> échec terminal", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const results: Array<Record<string, unknown>> = [];

  const pending = [claimRow(order.id, order.publicToken)];
  t.mock.method(adminClient, "rpc", async (name: string, args: Record<string, any>) => {
    if (name === "claim_pending_notifications") return { data: pending.splice(0), error: null };
    if (name === "complete_notification_attempt") {
      results.push(args);
      return { data: null, error: null };
    }
    if (name === "issue_order_email_tracking_capability") {
      return { data: null, error: { code: "PGRST000", message: "boom" } };
    }
    return db.rpc(name, args);
  });
  const p1 = new FakeEmailProvider();
  await processPendingNotifications(p1);
  assert.equal(p1.callCountForAssertions, 0);
  assert.equal(results[0]!.p_result, "retryable_failure");
  assert.equal(results[0]!.p_error_class, "TEMPLATE_RENDER_ERROR");

  const missing = db.addOrder("tenant-one");
  db.orders.delete(missing.id);
  install(t, db, [claimRow(missing.id, missing.publicToken)]);
  const completes: Array<Record<string, unknown>> = [];
  const orig = (adminClient as any).rpc;
  t.mock.method(adminClient, "rpc", async (name: string, args: Record<string, any>) => {
    if (name === "complete_notification_attempt") completes.push(args);
    return orig.call(adminClient, name, args);
  });
  const p2 = new FakeEmailProvider();
  await processPendingNotifications(p2);
  assert.equal(p2.callCountForAssertions, 0);
  assert.equal(completes[0]!.p_result, "terminal_failure");
});

test("K''. réessai du worker : chaque tentative a son propre identifiant, celui d'une tentative déjà livrée reste valide", async (t) => {
  const db = makeFakeDb();
  const order = db.addOrder("tenant-one");
  const first = gateBody((await sendOrderReceivedEmail(t, db, order)).url);
  const second = gateBody((await sendOrderReceivedEmail(t, db, order)).url);
  assert.notEqual(first.capabilityId, second.capabilityId);
  assert.equal((await exchange(first)).status, 200);
  assert.equal((await exchange(second)).status, 200);
});
