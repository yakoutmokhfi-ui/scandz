import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// ====================================================================
// LOT 04 — TRANSACTIONAL EMAIL GOLDEN PATH — couverture d'acceptation
// exécutable.
//
// Chaîne complète côté application : outbox -> claim -> capacité de
// suivi v3.1 -> gabarit ORDER_RECEIVED approuvé -> EmailProvider
// (Fake uniquement) -> complete_notification_attempt -> reap.
//
// Le client service_role RÉEL est routé (`t.mock.method(client,
// "rpc")`, même discipline que tests/v1-n1a-notification-worker.test.ts)
// vers un FAUX STATEFUL qui reproduit la sémantique SQL de
// supabase/DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql
// (statuts, jeton de claim + bail, barème 30/120/600/1800 s, 5
// tentatives max, reap) et de issue_order_email_tracking_capability
// (supabase/DRAFT-lot-customer-tracking-capability-v3-1.sql). Les
// constantes du faux sont ÉPINGLÉES au texte SQL par la section S
// ci-dessous : toute dérive du SQL casse ce fichier.
//
// `globalThis.fetch` est remplacé dans CHAQUE test par un enregistreur
// qui échoue : aucun appel réseau n'est possible, et son absence est
// assertée.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "lot04-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const GATE_VAR = "NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED";
const ORIGINAL_GATE = process.env[GATE_VAR];

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { processPendingNotifications, runTransactionalEmailWorker } = await import(
  "../lib/server/notifications/notification-worker.ts"
);
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { resolveTransactionalEmailProvider } = await import(
  "../lib/server/notifications/email-provider-resolution.ts"
);
const { renderOrderReceivedEmail } = await import("../lib/server/notifications/order-received-template.ts");
const { buildNotificationIdempotencyKey } = await import("../lib/server/notifications/email-provider.ts");
const { parseTrackingFragment } = await import("../lib/tracking/link.ts");
// CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 -- le texte de statut attendu
// est recalculé par l'UNIQUE autorité partagée (jamais recopié en dur
// dans ce test), exactement comme le fait le worker.
const { translate } = await import("../lib/i18n.ts");
const { resolveStatusText } = await import("../lib/tracking/status-text.ts");

const N1A_SQL = readFileSync(
  new URL("../supabase/DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql", import.meta.url),
  "utf8"
);
const V31_SQL = readFileSync(
  new URL("../supabase/DRAFT-lot-customer-tracking-capability-v3-1.sql", import.meta.url),
  "utf8"
);

// --------------------------------------------------------------------
// Faux stateful (sémantique SQL N1-A + v3.1).
// --------------------------------------------------------------------

const BACKOFF_SECONDS = [30, 120, 600, 1800] as const;
const MAX_ATTEMPTS = 5;
const EMAIL_CAPABILITY_CAP = 16;

interface OutboxRow {
  id: string;
  seq: number;
  restaurantId: string;
  orderId: string;
  type: string;
  recipient: string | null;
  locale: string;
  payload: Record<string, unknown>;
  status: string;
  attemptCount: number;
  nextAttemptAt: number | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
  lastErrorCode: string | null;
}

interface OrderRow {
  id: string;
  restaurantId: string;
  publicToken: string;
  orderNumber: number;
  total: number;
  serviceMode: string;
}

interface Sender {
  sender_name: string;
  sender_email: string;
  reply_to: string | null;
}

function makeFakeDb() {
  let now = Date.parse("2026-09-18T10:00:00Z");
  let seq = 0;
  const orders = new Map<string, OrderRow>();
  const profiles = new Map<string, Sender>();
  const outbox: OutboxRow[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  const caps: Array<{ id: string; orderId: string; secret: string }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function addTenant(sender: Sender): string {
    const id = randomUUID();
    profiles.set(id, sender);
    return id;
  }

  function addOrder(restaurantId: string, opts: Partial<OrderRow> = {}): OrderRow {
    const o: OrderRow = {
      id: randomUUID(),
      restaurantId,
      publicToken: randomUUID(),
      orderNumber: 42,
      total: 23.5,
      serviceMode: "pickup",
      ...opts,
    };
    orders.set(o.id, o);
    return o;
  }

  function enqueue(order: OrderRow, opts: { type?: string; recipient?: string | null; locale?: string } = {}): OutboxRow {
    const row: OutboxRow = {
      id: randomUUID(),
      seq: seq++,
      restaurantId: order.restaurantId,
      orderId: order.id,
      type: opts.type ?? "order_received",
      recipient: opts.recipient === undefined ? "client@example.com" : opts.recipient,
      locale: opts.locale ?? "fr",
      payload: {
        order_number: order.orderNumber,
        total: order.total,
        currency: "EUR",
        service_mode: order.serviceMode,
        public_token: order.publicToken,
        created_at: "2026-09-18T09:59:00Z",
      },
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: null,
    };
    outbox.push(row);
    return row;
  }

  async function rpc(name: string, args: Record<string, any>) {
    rpcCalls.push({ name, args });
    switch (name) {
      case "claim_pending_notifications": {
        const batch = Math.max(1, Math.min(args.p_batch_size ?? 10, 100));
        const lease = Math.max(1, Math.min(args.p_lease_seconds ?? 60, 3600));
        const eligible = outbox
          .filter((r) => (r.status === "pending" || r.status === "failed_retryable")
            && (r.nextAttemptAt === null || r.nextAttemptAt <= now))
          .sort((a, b) => a.seq - b.seq)
          .slice(0, batch);
        for (const r of eligible) {
          r.status = "processing";
          r.claimToken = randomUUID();
          r.claimExpiresAt = now + lease * 1000;
        }
        return {
          data: eligible.map((r) => {
            const p = profiles.get(r.restaurantId);
            return {
              outbox_id: r.id, restaurant_id: r.restaurantId, order_id: r.orderId,
              notification_type: r.type, recipient_email: r.recipient, locale: r.locale,
              payload_snapshot: r.payload, attempt_count: r.attemptCount, claim_token: r.claimToken,
              sender_name: p?.sender_name ?? null, sender_email: p?.sender_email ?? null,
              reply_to: p?.reply_to ?? null,
            };
          }),
          error: null,
        };
      }
      case "complete_notification_attempt": {
        const r = outbox.find((x) => x.id === args.p_outbox_id);
        if (!r) return { data: null, error: { code: "P0002", message: "not found" } };
        if (r.status !== "processing" || r.claimToken !== args.p_claim_token
            || r.claimExpiresAt === null || r.claimExpiresAt <= now) {
          return { data: null, error: { code: "42501", message: "claim invalid" } };
        }
        if (attempts.some((a) => a.outbox_id === r.id && a.attempt_number === args.p_attempt_number)) {
          return { data: null, error: { code: "23505", message: "duplicate attempt" } };
        }
        attempts.push({
          outbox_id: r.id, attempt_number: args.p_attempt_number, provider: args.p_provider,
          result: args.p_result, provider_message_id: args.p_provider_message_id,
          error_class: args.p_error_class,
        });
        r.attemptCount += 1;
        if (args.p_result === "success") {
          r.status = "sent";
          r.nextAttemptAt = null;
        } else if (args.p_result === "terminal_failure" || r.attemptCount >= MAX_ATTEMPTS) {
          r.status = "failed_terminal";
          r.nextAttemptAt = null;
        } else {
          r.status = "failed_retryable";
          r.nextAttemptAt = now + BACKOFF_SECONDS[Math.min(r.attemptCount, 4) - 1]! * 1000;
        }
        if (args.p_result !== "success") r.lastErrorCode = args.p_error_class;
        r.claimToken = null;
        r.claimExpiresAt = null;
        return { data: null, error: null };
      }
      case "reap_stale_notification_claims": {
        let count = 0;
        for (const r of outbox) {
          if (r.status === "processing" && r.claimExpiresAt !== null && r.claimExpiresAt < now) {
            r.status = "pending";
            r.claimToken = null;
            r.claimExpiresAt = null;
            count += 1;
          }
        }
        return { data: count, error: null };
      }
      case "issue_order_email_tracking_capability": {
        const order = orders.get(args.p_order_id);
        if (!order) return { data: [], error: null };
        if (caps.filter((c) => c.orderId === order.id).length >= EMAIL_CAPABILITY_CAP) {
          return { data: [], error: null };
        }
        const cap = { id: randomUUID(), orderId: order.id, secret: randomBytes(32).toString("hex") };
        caps.push(cap);
        return { data: [{ capability_id: cap.id, capability_secret: cap.secret }], error: null };
      }
      default:
        throw new Error(`RPC inattendue : ${name}`);
    }
  }

  return {
    orders, outbox, attempts, caps, rpcCalls,
    addTenant, addOrder, enqueue, rpc,
    advance(seconds: number) { now += seconds * 1000; },
    get now() { return now; },
  };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

function install(t: any, db: FakeDb) {
  t.mock.method(client, "rpc", (name: string, args: Record<string, unknown>) => db.rpc(name, args));
  // Remplacement manuel (même patron que checkout-invoice-request-
  // reliability.dom.test.ts) : `fetch` peut être un accesseur sur
  // globalThis, que `t.mock.method` refuse.
  const fetchCalls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error("NETWORK_FORBIDDEN_IN_LOT04_TESTS");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return { fetchCalls };
}

function captureLogs(t: any): unknown[][] {
  const logs: unknown[][] = [];
  for (const level of ["log", "error", "warn", "info", "debug"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => logs.push(args));
  }
  return logs;
}

function trackingUrlOf(text: string): URL {
  return new URL(text.match(/https:\/\/\S+/)![0]);
}

const ALCRU: Sender = { sender_name: "Au Lait Cru", sender_email: "commandes@aulaitcru.example", reply_to: "reply@aulaitcru.example" };
const SANAA: Sender = { sender_name: "Sanaa Cookies", sender_email: "hello@sanaa.example", reply_to: null };

// --------------------------------------------------------------------
// 1. Message provider-neutre approuvé + lien v3.1 réutilisable.
// --------------------------------------------------------------------

test("1. commande éligible -> EXACTEMENT le message provider-neutre du gabarit ORDER_RECEIVED approuvé", async (t) => {
  const db = makeFakeDb();
  const { fetchCalls } = install(t, db);
  const tenant = db.addTenant(ALCRU);
  const order = db.addOrder(tenant, { orderNumber: 7, total: 19.9, serviceMode: "delivery" });
  const row = db.enqueue(order, { locale: "en" });

  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);

  assert.deepEqual(result, { claimed: 1, sent: 1, retriedRetryable: 0, failedTerminal: 0 });
  assert.equal(provider.callCountForAssertions, 1);
  const msg = provider.sent[0]!;
  // Forme provider-neutre : uniquement les champs de EmailMessage.
  assert.deepEqual(Object.keys(msg).sort(), ["from", "html", "idempotencyKey", "replyTo", "subject", "text", "to"]);

  const cap = db.caps[0]!;
  const expected = renderOrderReceivedEmail({
    locale: "en",
    merchantSenderName: ALCRU.sender_name,
    orderNumber: 7,
    total: 19.9,
    currency: "EUR",
    serviceMode: "delivery",
    orderId: order.id,
    trackingCapabilityId: cap.id,
    trackingSecret: cap.secret,
    // CFTE v1 -- ce snapshot (antérieur au lot) ne porte ni statut, ni
    // surcharge, ni adresse : le worker DOIT alors replier sur le nom
    // d'expéditeur, le texte de base du statut `new`, et omettre
    // proprement la ligne d'adresse. C'est exactement ce que cette
    // attente reproduit.
    merchantName: ALCRU.sender_name,
    statusText: resolveStatusText("new", {}, (k) => translate("en", k)).text,
    deliveryAddress: null,
  });
  assert.equal(msg.subject, expected.subject);
  assert.equal(msg.html, expected.html);
  assert.equal(msg.text, expected.text);
  assert.equal(msg.to, "client@example.com");
  assert.equal(msg.from, ALCRU.sender_email);
  assert.equal(msg.replyTo, ALCRU.reply_to);
  assert.equal(msg.idempotencyKey, buildNotificationIdempotencyKey(row.id));
  assert.equal(row.status, "sent");
  assert.equal(fetchCalls.length, 0);
});

test("2. lien de suivi = capacité v3.1 réutilisable en fragment ; le public_token legacy n'apparaît jamais", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const order = db.addOrder(db.addTenant(ALCRU));
  db.enqueue(order);

  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  const msg = provider.sent[0]!;
  const url = trackingUrlOf(msg.text);

  assert.equal(url.origin, "https://app.scanym.example");
  assert.equal(url.pathname, `/track/${order.id}`);
  assert.equal(url.search, "");
  const fragment = parseTrackingFragment(decodeURIComponent(url.hash.slice(1)));
  assert.ok(fragment && fragment.kind === "capability", "fragment v3.1 capacité attendu");
  assert.equal(fragment.capabilityId, db.caps[0]!.id);
  assert.equal(fragment.secret, db.caps[0]!.secret);
  assert.ok(msg.html.includes(`#c1.${db.caps[0]!.id}.`));
  for (const body of [msg.html, msg.text, msg.subject]) {
    assert.equal(body.includes(order.publicToken), false, "public_token legacy présent dans l'e-mail");
  }
});

// --------------------------------------------------------------------
// 3. Aucun double envoi d'une tentative réussie.
// --------------------------------------------------------------------

test("3. tentative réussie -> jamais renvoyée (runs successifs, temps écoulé, reap, workers concurrents)", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const order = db.addOrder(db.addTenant(ALCRU));
  const row = db.enqueue(order);
  const provider = new FakeEmailProvider();

  const [a, b] = await Promise.all([
    processPendingNotifications(provider),
    processPendingNotifications(provider),
  ]);
  assert.equal(a.claimed + b.claimed, 1, "une seule réclamation sous concurrence");

  for (let i = 0; i < 4; i += 1) {
    db.advance(86_400);
    await db.rpc("reap_stale_notification_claims", {});
    const r = await processPendingNotifications(provider);
    assert.equal(r.claimed, 0);
  }
  assert.equal(provider.callCountForAssertions, 1);
  assert.equal(row.status, "sent");
  assert.equal(db.attempts.length, 1);
  assert.equal(db.caps.length, 1, "aucune capacité supplémentaire émise après succès");
});

// --------------------------------------------------------------------
// 4. Échec transitoire : reprise + backoff.
// --------------------------------------------------------------------

test("4a. échec transitoire puis succès : backoff respecté, même clé d'idempotence, un seul succès", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const row = db.enqueue(db.addOrder(db.addTenant(ALCRU)));
  const provider = new FakeEmailProvider((_m, attempt) =>
    attempt === 1
      ? { ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" }
      : { ok: true, providerMessageId: `fake-${attempt}` }
  );

  const r1 = await processPendingNotifications(provider);
  assert.equal(r1.retriedRetryable, 1);
  assert.equal(row.status, "failed_retryable");
  assert.equal(row.nextAttemptAt! - db.now, 30_000);
  assert.equal(row.lastErrorCode, "PROVIDER_TIMEOUT");

  // Avant échéance : rien n'est réclamé.
  db.advance(29);
  assert.equal((await processPendingNotifications(provider)).claimed, 0);
  db.advance(1);
  const r2 = await processPendingNotifications(provider);
  assert.equal(r2.sent, 1);
  assert.equal(row.status, "sent");
  assert.equal(provider.callCountForAssertions, 2);
  assert.equal(provider.sent[0]!.idempotencyKey, provider.sent[1]!.idempotencyKey);
  assert.deepEqual(db.attempts.map((a) => [a.attempt_number, a.result]), [
    [1, "retryable_failure"],
    [2, "success"],
  ]);
});

test("4b. échecs transitoires persistants : barème 30/120/600/1800 s puis terminal à la 5e tentative, boucle bornée", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const row = db.enqueue(db.addOrder(db.addTenant(ALCRU)));
  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: "PROVIDER_RATE_LIMITED" }));

  const delays: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const before = db.now;
    await processPendingNotifications(provider);
    if (row.status === "failed_retryable") {
      delays.push((row.nextAttemptAt! - before) / 1000);
      db.advance((row.nextAttemptAt! - before) / 1000);
    } else {
      db.advance(86_400);
    }
  }
  assert.deepEqual(delays, [30, 120, 600, 1800]);
  assert.equal(row.status, "failed_terminal");
  assert.equal(row.attemptCount, MAX_ATTEMPTS);
  assert.equal(provider.callCountForAssertions, MAX_ATTEMPTS, "aucun envoi au-delà de 5 tentatives");
  assert.equal(new Set(provider.sent.map((m) => m.idempotencyKey)).size, 1);
});

// --------------------------------------------------------------------
// 5. Échec permanent : classification terminale, aucune reprise.
// --------------------------------------------------------------------

for (const errorClass of ["INVALID_RECIPIENT", "PROVIDER_AUTHENTICATION_FAILED", "PROVIDER_CONFIGURATION_ERROR"]) {
  test(`5. échec permanent ${errorClass} -> failed_terminal après UNE tentative, jamais réessayé`, async (t) => {
    const db = makeFakeDb();
    install(t, db);
    const row = db.enqueue(db.addOrder(db.addTenant(ALCRU)));
    const provider = new FakeEmailProvider(() => ({ ok: false, retryable: false, errorClass }));

    const r = await processPendingNotifications(provider);
    assert.equal(r.failedTerminal, 1);
    for (let i = 0; i < 5; i += 1) {
      db.advance(86_400);
      await db.rpc("reap_stale_notification_claims", {});
      assert.equal((await processPendingNotifications(provider)).claimed, 0);
    }
    assert.equal(provider.callCountForAssertions, 1);
    assert.equal(row.status, "failed_terminal");
    assert.equal(row.lastErrorCode, errorClass);
  });
}

test("5b. classification provider inconnue non réessayable -> UNKNOWN_PROVIDER_ERROR terminal, la chaîne brute n'est jamais persistée", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const row = db.enqueue(db.addOrder(db.addTenant(ALCRU)));
  const raw = "550 5.1.1 mailbox unavailable; api_key=sk_live_should_never_persist";
  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: false, errorClass: raw }));
  await processPendingNotifications(provider);
  assert.equal(row.status, "failed_terminal");
  assert.equal(row.lastErrorCode, "UNKNOWN_PROVIDER_ERROR");
  assert.equal(JSON.stringify([db.outbox, db.attempts]).includes("sk_live_should_never_persist"), false);
});

// --------------------------------------------------------------------
// 6. Frontière crash / idempotence du worker actuel.
// --------------------------------------------------------------------

test("6a. crash APRÈS envoi réussi, AVANT complétion : pas de renvoi pendant le bail ; après reap, renvoi avec la MÊME clé ; complétion périmée refusée", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const row = db.enqueue(db.addOrder(db.addTenant(ALCRU)));
  const provider = new FakeEmailProvider();

  // Panne de complete_notification_attempt juste après un envoi réussi.
  let failComplete = true;
  let staleClaimToken: string | null = null;
  t.mock.method(client, "rpc", (name: string, args: Record<string, any>) => {
    if (name === "complete_notification_attempt" && failComplete) {
      staleClaimToken = args.p_claim_token;
      failComplete = false;
      return Promise.reject(new Error("connection reset"));
    }
    return db.rpc(name, args);
  });

  await assert.rejects(processPendingNotifications(provider), { name: "NotificationOutboxError" });
  assert.equal(provider.callCountForAssertions, 1);
  assert.equal(row.status, "processing");

  // Pendant le bail : la ligne n'est ni réclamable ni récupérable.
  assert.equal((await db.rpc("reap_stale_notification_claims", {})).data, 0);
  assert.equal((await processPendingNotifications(provider)).claimed, 0);
  assert.equal(provider.callCountForAssertions, 1);

  // Après expiration du bail : reap -> un seul renvoi, MÊME clé.
  db.advance(61);
  assert.equal((await db.rpc("reap_stale_notification_claims", {})).data, 1);
  const r = await processPendingNotifications(provider);
  assert.equal(r.sent, 1);
  assert.equal(provider.callCountForAssertions, 2);
  assert.equal(provider.sent[0]!.idempotencyKey, provider.sent[1]!.idempotencyKey);
  assert.equal(provider.sent[1]!.idempotencyKey, buildNotificationIdempotencyKey(row.id));

  // Une complétion tardive avec l'ancien jeton est rejetée (aucune
  // double transition d'état).
  const late = await db.rpc("complete_notification_attempt", {
    p_outbox_id: row.id, p_claim_token: staleClaimToken, p_attempt_number: 1,
    p_provider: "fake", p_result: "success",
  });
  assert.equal(late.error?.code, "42501");
  assert.equal(row.status, "sent");
  assert.equal(db.attempts.length, 1);

  // Plus jamais d'envoi ensuite.
  db.advance(86_400);
  await db.rpc("reap_stale_notification_claims", {});
  assert.equal((await processPendingNotifications(provider)).claimed, 0);
  assert.equal(provider.callCountForAssertions, 2);
});

test("6b. provider qui lève (panne réseau) : aucune complétion, ligne récupérée après bail, même clé ; le reste du lot attend le bail sans être perdu", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const tenant = db.addTenant(ALCRU);
  const first = db.enqueue(db.addOrder(tenant));
  const second = db.enqueue(db.addOrder(tenant));
  let throwOnce = true;
  const provider = new FakeEmailProvider(() => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("ECONNRESET");
    }
    return { ok: true, providerMessageId: "fake-ok" };
  });

  await assert.rejects(processPendingNotifications(provider));
  assert.equal(first.status, "processing");
  assert.equal(second.status, "processing");
  assert.equal(provider.callCountForAssertions, 1);
  assert.equal(db.attempts.length, 0);

  db.advance(61);
  assert.equal((await db.rpc("reap_stale_notification_claims", {})).data, 2);
  const r = await processPendingNotifications(provider);
  assert.equal(r.sent, 2);
  assert.equal(first.status, "sent");
  assert.equal(second.status, "sent");
  const firstKeys = provider.sent.filter((m) => m.idempotencyKey === buildNotificationIdempotencyKey(first.id));
  assert.equal(firstKeys.length, 2, "le renvoi du premier message porte la même clé");
  assert.equal(provider.sent.filter((m) => m.idempotencyKey === buildNotificationIdempotencyKey(second.id)).length, 1);
});

// --------------------------------------------------------------------
// 7. Aucun secret dans les journaux, le chemin ou la query.
// --------------------------------------------------------------------

test("7. aucun secret (capacité, public_token, clé service_role) dans journaux, chemin/query, clé d'idempotence ni champs persistés", async (t) => {
  const logs = captureLogs(t);
  const db = makeFakeDb();
  const { fetchCalls } = install(t, db);
  const tenant = db.addTenant(ALCRU);
  const okOrder = db.addOrder(tenant);
  const retryOrder = db.addOrder(tenant);
  db.enqueue(okOrder);
  db.enqueue(retryOrder);
  const provider = new FakeEmailProvider((m) =>
    m.text.includes(retryOrder.id)
      ? { ok: false, retryable: true, errorClass: m.text }
      : { ok: true, providerMessageId: "fake-ok" }
  );
  await processPendingNotifications(provider);

  const secrets = [
    ...db.caps.map((c) => c.secret),
    okOrder.publicToken,
    retryOrder.publicToken,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  ];
  assert.equal(db.caps.length, 2);
  for (const msg of provider.sent) {
    const url = trackingUrlOf(msg.text);
    for (const s of secrets) {
      assert.equal(url.pathname.includes(s), false);
      assert.equal(url.search.includes(s), false);
      assert.equal(msg.idempotencyKey.includes(s), false);
      assert.equal(msg.subject.includes(s), false);
    }
  }
  const persisted = JSON.stringify([db.outbox.map((r) => ({ ...r, payload: null })), db.attempts]);
  const rpcArgs = JSON.stringify(db.rpcCalls.filter((c) => c.name !== "issue_order_email_tracking_capability"));
  const serializedLogs = logs.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
  for (const s of secrets) {
    assert.equal(persisted.includes(s), false, "secret persisté");
    assert.equal(rpcArgs.includes(s), false, "secret transmis à une RPC d'outbox");
    assert.equal(serializedLogs.includes(s), false, "secret journalisé");
  }
  assert.equal(fetchCalls.length, 0);
});

// --------------------------------------------------------------------
// 8. Provider désactivé : aucun envoi réseau.
// --------------------------------------------------------------------

test("8a. résolution du provider réel : TOUJOURS null (porte absente, fausse ou activée) -- activation réelle hors périmètre", (t) => {
  t.after(() => {
    if (ORIGINAL_GATE === undefined) delete process.env[GATE_VAR];
    else process.env[GATE_VAR] = ORIGINAL_GATE;
  });
  delete process.env[GATE_VAR];
  assert.equal(resolveTransactionalEmailProvider(), null);
  process.env[GATE_VAR] = "false";
  assert.equal(resolveTransactionalEmailProvider(), null);
  process.env[GATE_VAR] = "true";
  assert.equal(resolveTransactionalEmailProvider(), null);
});

test("8b. provider désactivé -> aucune réclamation, aucune capacité, aucune tentative consommée, aucun fetch", async (t) => {
  t.after(() => {
    if (ORIGINAL_GATE === undefined) delete process.env[GATE_VAR];
    else process.env[GATE_VAR] = ORIGINAL_GATE;
  });
  const db = makeFakeDb();
  const { fetchCalls } = install(t, db);
  const row = db.enqueue(db.addOrder(db.addTenant(ALCRU)));

  for (const gate of [undefined, "true"]) {
    if (gate === undefined) delete process.env[GATE_VAR];
    else process.env[GATE_VAR] = gate;
    const result = await runTransactionalEmailWorker(resolveTransactionalEmailProvider());
    assert.deepEqual(result, { status: "provider_disabled" });
  }
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.caps.length, 0);
  assert.equal(row.status, "pending");
  assert.equal(row.attemptCount, 0);
  assert.equal(fetchCalls.length, 0);

  // Le même point d'entrée, avec le provider Fake injecté, traite
  // normalement (aucun fetch non plus).
  const provider = new FakeEmailProvider();
  const processed = await runTransactionalEmailWorker(provider);
  assert.deepEqual(processed, { status: "processed", claimed: 1, sent: 1, retriedRetryable: 0, failedTerminal: 0 });
  assert.equal(fetchCalls.length, 0);
});

test("8c. structurel : la résolution et le worker n'effectuent aucun appel réseau et n'importent aucun SDK de provider réel", () => {
  for (const file of ["email-provider-resolution.ts", "notification-worker.ts", "email-provider.ts", "fake-email-provider.ts"]) {
    const src = readFileSync(new URL(`../lib/server/notifications/${file}`, import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\bfetch\s*\(|node:https?|node:net|XMLHttpRequest|axios|nodemailer/, file);
    assert.doesNotMatch(code, /resend|postmark|sendgrid|mailgun|client-ses|aws-sdk/i, file);
  }
  const resolution = readFileSync(new URL("../lib/server/notifications/email-provider-resolution.ts", import.meta.url), "utf8");
  assert.match(resolution, /^import "server-only";/m);
  assert.doesNotMatch(resolution, /FakeEmailProvider|fake-email-provider/, "jamais de repli implicite vers le Fake");
});

// --------------------------------------------------------------------
// 9. Liaison tenant / commande.
// --------------------------------------------------------------------

test("9. liaison tenant/commande : chaque message est lié à SA commande, SON destinataire, SON expéditeur, SA capacité", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const tenantA = db.addTenant(ALCRU);
  const tenantB = db.addTenant(SANAA);
  const orderA = db.addOrder(tenantA, { orderNumber: 11 });
  const orderB = db.addOrder(tenantB, { orderNumber: 22 });
  db.enqueue(orderA, { recipient: "a@client.example" });
  db.enqueue(orderB, { recipient: "b@client.example" });

  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  assert.equal(provider.sent.length, 2);

  const issued = db.rpcCalls.filter((c) => c.name === "issue_order_email_tracking_capability").map((c) => c.args.p_order_id);
  assert.deepEqual(issued.sort(), [orderA.id, orderB.id].sort());

  for (const [order, sender, recipient, other] of [
    [orderA, ALCRU, "a@client.example", orderB],
    [orderB, SANAA, "b@client.example", orderA],
  ] as const) {
    const msg = provider.sent.find((m) => m.to === recipient)!;
    assert.equal(msg.from, sender.sender_email);
    assert.match(msg.subject, new RegExp(sender.sender_name));
    assert.match(msg.subject, new RegExp(`#${order.orderNumber}\\b`));
    const url = trackingUrlOf(msg.text);
    assert.equal(url.pathname, `/track/${order.id}`);
    const frag = parseTrackingFragment(decodeURIComponent(url.hash.slice(1)));
    assert.ok(frag && frag.kind === "capability");
    const cap = db.caps.find((c) => c.id === frag.capabilityId)!;
    assert.equal(cap.orderId, order.id, "capacité liée à la commande du message");
    assert.equal(msg.html.includes(other.id), false);
    assert.equal(msg.text.includes(other.id), false);
  }
});

// --------------------------------------------------------------------
// 10. Types de notification non liés : jamais rendus avec ce gabarit.
// --------------------------------------------------------------------

test("10. un type autre que order_received n'est jamais envoyé avec le gabarit ORDER_RECEIVED ; le lot order_received reste traité", async (t) => {
  const db = makeFakeDb();
  install(t, db);
  const tenant = db.addTenant(ALCRU);
  const other = db.enqueue(db.addOrder(tenant), { type: "order_accepted", recipient: "other@client.example" });
  const received = db.enqueue(db.addOrder(tenant), { recipient: "received@client.example" });

  const provider = new FakeEmailProvider();
  const r = await processPendingNotifications(provider);
  assert.deepEqual(r, { claimed: 2, sent: 1, retriedRetryable: 0, failedTerminal: 1 });
  assert.deepEqual(provider.sent.map((m) => m.to), ["received@client.example"]);
  assert.equal(other.status, "failed_terminal", "état terminal explicite, jamais une boucle de reprise");
  assert.equal(other.lastErrorCode, "TEMPLATE_RENDER_ERROR");
  assert.equal(received.status, "sent");
  assert.equal(db.caps.filter((c) => c.orderId === other.orderId).length, 0, "aucune capacité émise pour un type non pris en charge");
});

// --------------------------------------------------------------------
// S. Épinglage du faux sur le SQL réel + non-dérive des types.
// --------------------------------------------------------------------

test("S1. le faux reproduit le barème SQL : 30/120/600/1800 s, 5 tentatives max, succès -> sent, terminal/plafond -> failed_terminal", () => {
  const body = N1A_SQL.slice(N1A_SQL.indexOf("create function public.complete_notification_attempt("));
  const fn = body.slice(0, body.indexOf("end $$;"));
  assert.match(fn, /c_max_retry_attempts constant integer := 5;/);
  assert.equal(MAX_ATTEMPTS, 5);
  assert.match(fn, /when 1 then 30\s+when 2 then 120\s+when 3 then 600\s+else 1800/);
  assert.deepEqual([...BACKOFF_SECONDS], [30, 120, 600, 1800]);
  assert.match(fn, /if p_result = 'success' then\s+v_new_status := 'sent';/);
  assert.match(fn, /if p_result = 'terminal_failure' or v_new_attempt_count >= c_max_retry_attempts then\s+v_new_status := 'failed_terminal';/);
  assert.match(fn, /v_row\.status <> 'processing' or v_row\.claim_token is distinct from p_claim_token\s+or v_row\.claim_expires_at is null or v_row\.claim_expires_at <= now\(\)/);
  assert.match(N1A_SQL, /constraint notification_delivery_attempt_unique_per_outbox\s+unique \(outbox_id, attempt_number\)/);
});

test("S2. le faux reproduit la réclamation SQL : seuls pending/failed_retryable échus, jamais sent/failed_terminal ; reap sur bail expiré uniquement", () => {
  const claim = N1A_SQL.slice(N1A_SQL.indexOf("create function public.claim_pending_notifications("));
  assert.match(claim, /where o\.status in \('pending', 'failed_retryable'\)\s+and \(o\.next_attempt_at is null or o\.next_attempt_at <= now\(\)\)/);
  assert.match(claim, /for update skip locked/);
  const reap = N1A_SQL.slice(N1A_SQL.indexOf("create function public.reap_stale_notification_claims("));
  assert.match(reap, /where status = 'processing'\s+and claim_expires_at is not null\s+and claim_expires_at < now\(\)/);
  assert.match(reap, /set status = 'pending'/);
});

test("S3. capacité e-mail v3.1 : liée à la commande, plafond 16, secret 64 hex jamais stocké en clair", () => {
  const issue = V31_SQL.slice(V31_SQL.indexOf("create function public.issue_order_email_tracking_capability("));
  const fn = issue.slice(0, issue.indexOf("$$;"));
  assert.match(fn, /where o\.id = p_order_id\s+for update;/);
  assert.match(fn, /if v_count >= 16 then/);
  assert.equal(EMAIL_CAPABILITY_CAP, 16);
  assert.match(fn, /pg_catalog\.sha256\(pg_catalog\.convert_to\(v_secret, 'UTF8'\)\)/);
  assert.match(V31_SQL, /grant execute on function public\.issue_order_email_tracking_capability\(uuid\) to service_role;/);
});

test("S4. types de notification inchangés : même liste CHECK, seule 'order_received' est émise, garde tenant intacte", () => {
  assert.match(
    N1A_SQL,
    /notification_type text not null check \(notification_type in \(\s+'order_received',\s+'order_accepted', 'order_preparing', 'order_ready', 'order_delivered',\s+'order_cancelled', 'order_rejected', 'delivery_failed', 'refund_issued'\s+\)\)/
  );
  const inserts = [...N1A_SQL.matchAll(/insert into public\.notification_outbox \([\s\S]*?\) values \(([\s\S]*?)\)\s*on conflict/g)];
  assert.equal(inserts.length, 1);
  assert.match(inserts[0]![1]!, /'order_received'/);
  assert.match(N1A_SQL, /if not found or v_order\.restaurant_id <> p_restaurant_id then\s+raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH/);
});
