import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// PR #196 R3 (P2) -- « Budget temporel contourné si l'horloge recule ».
// Le budget du worker (A196-05) se mesurait avec la date murale : si l'horloge système recule pendant
// l'exécution (pas NTP, correction de dérive), `Date.now() >= deadlineAt` reste faux et des envois démarrent
// bien après les 150 s prévues, jusqu'à dépasser le bail de 300 s (complétion refusée alors que le message est
// parti, puis doublon après le reap). Le budget se mesure désormais sur l'horloge MONOTONE (run-budget.ts).
// Sans réseau ni base ; `Date.now` et `performance.now` sont simulés par instance (t.mock.method).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "r1-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";
process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const { NextRequest } = await import("next/server");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { createRunBudget } = await import("../lib/server/notifications/run-budget.ts");
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const { realSmtpTransport } = await import("../lib/server/ack-mailer.ts");
const { encryptMerchantSmtpPassword } = await import("../lib/server/merchant-email-provider.ts");
const route = await import("../app/api/internal/notifications/send/route.ts");
const limits = await import("../lib/server/notifications/merchant-smtp-worker-limits.ts");

const RESTAURANT = "bbbbbbbb-0000-4000-8000-000000000001";
function claimRow(n: number) {
  return {
    outbox_id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, restaurant_id: RESTAURANT, order_id: `cccccccc-0000-4000-8000-00000000000${n}`,
    notification_type: "order_received", recipient_email: `client${n}@example.com`, locale: "fr",
    payload_snapshot: { order_number: n, total: 19.9, currency: "EUR", service_mode: "pickup", public_token: `dddddddd-0000-4000-8000-00000000000${n}`, created_at: "2026-09-14T10:00:00Z" },
    attempt_count: 0, claim_token: `eeeeeeee-0000-4000-8000-00000000000${n}`, sender_name: "Resto", sender_email: "contact@resto.example", reply_to: null,
  };
}
function rpcWorld(t: { mock: { method: Function } }, rows: ReturnType<typeof claimRow>[]) {
  const completed: Array<Record<string, unknown>> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    if (name === "recover_new_order_received_notifications") return { data: [{ recovered: 0, failed: 0 }], error: null };
    if (name === "reap_stale_notification_claims") return { data: 0, error: null };
    if (name === "claim_new_order_notifications") return { data: rows, error: null };
    if (name === "issue_order_email_tracking_capability") return { data: [{ capability_id: "ffffffff-0000-4000-8000-00000000000c", capability_secret: "c0".repeat(32) }], error: null };
    if (name === "complete_notification_attempt") { completed.push(args); return { data: null, error: null }; }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return completed;
}
/** Horloge MURALE qui RECULE d'une seconde à chaque lecture (pas NTP en arrière, dérive corrigée...). */
function wallClockGoingBackwards(t: { mock: { method: Function } }) {
  let wall = Date.parse("2026-10-31T12:00:00.000Z");
  t.mock.method(Date, "now", () => { wall -= 1_000; return wall; });
}
/** Horloge monotone pilotée à la main. */
function manualMonotonic(startMs = 1_000) {
  const clock = { value: startMs };
  return { clock, now: () => clock.value, advance: (ms: number) => { clock.value += ms; } };
}

// ----- le budget lui-même ----------------------------------------------------------
test("R3-05 run-budget : expire exactement à la durée allouée sur l'horloge MONOTONE, jamais avant", () => {
  const m = manualMonotonic();
  const budget = createRunBudget(150_000, m.now);
  assert.equal(budget.expired(), false);
  assert.equal(budget.remainingMs(), 150_000);
  m.advance(149_999);
  assert.equal(budget.expired(), false);
  assert.equal(budget.remainingMs(), 1);
  m.advance(1);
  assert.equal(budget.expired(), true);
  assert.equal(budget.remainingMs(), 0);
  m.advance(1_000_000);
  assert.equal(budget.expired(), true);
});

test("R3-05 run-budget : indépendant de l'horloge murale -- une date qui recule ne le rallonge pas (horloge réelle)", async (t) => {
  wallClockGoingBackwards(t);
  const budget = createRunBudget(60); // horloge monotone RÉELLE (performance.now)
  assert.equal(budget.expired(), false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(Date.now() < Date.parse("2026-10-31T12:00:00.000Z"), true, "la date murale simulée a bien reculé");
  assert.equal(budget.expired(), true, "le budget a expiré malgré une date murale revenue en arrière");
});

test("R3-05 run-budget : une horloge injectée défectueuse qui recule ne rallonge pas le budget ; valeur non finie => expiré (échec fermé) ; durée invalide refusée", () => {
  const m = manualMonotonic(5_000);
  const budget = createRunBudget(100, m.now);
  m.advance(80);
  assert.equal(budget.expired(), false);
  m.clock.value = 1_000; // recul de l'horloge « monotone » injectée
  assert.equal(budget.remainingMs(), 20, "le recul n'a pas rendu de temps");
  m.advance(30); // 1030 : toujours en dessous du plus haut instant vu
  m.clock.value = 5_100;
  assert.equal(budget.expired(), true);
  const broken = createRunBudget(100, () => Number.NaN);
  assert.equal(broken.expired(), true);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => createRunBudget(bad, m.now), RangeError);
});

// ----- le worker ---------------------------------------------------------------------
test("R3-05 REPRO worker : horloge murale qui recule + envois lents => le budget monotone arrête les nouveaux envois (2 envois, pas 3)", async (t) => {
  const completed = rpcWorld(t, [claimRow(1), claimRow(2), claimRow(3)]);
  wallClockGoingBackwards(t);
  const m = manualMonotonic();
  let sends = 0;
  const provider = {
    name: "merchant_smtp",
    async send() { sends += 1; m.advance(60); return { ok: true as const, providerMessageId: "x" }; },
  };
  const result = await processPendingNotifications(provider, {
    // Les DEUX bornes sont fournies comme la route le fait : la date murale seule ne se déclencherait jamais ici.
    deadlineAt: Date.now() + 100,
    budget: createRunBudget(100, m.now),
  });
  assert.equal(sends, 2, "troisième envoi démarré après le budget (l'horloge murale qui recule l'aurait laissé partir)");
  assert.equal(result.sent, 2);
  assert.equal(result.claimed, 3);
  assert.equal(completed.length, 2, "la ligne non traitée reste `processing` : bail puis reap, sans tentative consommée");
});

test("R3-05 worker : la date murale seule (ancien contrat) ne suffit PAS quand l'horloge recule -- et le budget n'est pas requis pour le comportement existant", async (t) => {
  rpcWorld(t, [claimRow(1), claimRow(2), claimRow(3)]);
  wallClockGoingBackwards(t);
  const m = manualMonotonic();
  let sends = 0;
  const provider = { name: "merchant_smtp", async send() { sends += 1; m.advance(60); return { ok: true as const, providerMessageId: "x" }; } };
  await processPendingNotifications(provider, { deadlineAt: Date.now() + 100 });
  assert.equal(sends, 3, "témoin : sans budget monotone, une date murale qui recule laisse tout partir (ce que fait l'ancienne route)");
});

test("R3-05 worker : le budget expiré AVANT le premier envoi n'envoie rien ; les deux bornes se cumulent (la plus courte l'emporte)", async (t) => {
  const completed = rpcWorld(t, [claimRow(1), claimRow(2)]);
  const m = manualMonotonic();
  const budget = createRunBudget(10, m.now);
  m.advance(10);
  let sends = 0;
  const provider = { name: "merchant_smtp", async send() { sends += 1; return { ok: true as const, providerMessageId: "x" }; } };
  const first = await processPendingNotifications(provider, { budget });
  assert.equal(sends, 0);
  assert.equal(completed.length, 0);
  assert.equal(first.sent, 0);

  // Date murale dépassée, budget monotone intact : la date murale (garde-fou) arrête aussi.
  const second = await processPendingNotifications(provider, { budget: createRunBudget(1_000_000, m.now), deadlineAt: Date.now() - 1 });
  assert.equal(sends, 0);
  assert.equal(second.sent, 0);
});

// ----- la route Cron, de bout en bout (reap -> claim -> résolution du coffre -> envoi) -----
test("R3-05 REPRO route Cron : horloge murale qui recule, envois de 80 s => le troisième envoi n'est PAS démarré (budget 150 s respecté)", async (t) => {
  const completed = rpcWorld(t, [claimRow(1), claimRow(2), claimRow(3)]);
  const secret = encryptMerchantSmtpPassword("MOT-DE-PASSE-DE-TEST", RESTAURANT);
  t.mock.method(client, "from", ((table: string) => {
    assert.equal(table, "merchant_email_provider_config");
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { host: "smtp.ionos.fr", port: 465, username: "contact@resto.example", enabled: true, secret_ciphertext: secret.ciphertext, secret_iv: secret.iv, secret_auth_tag: secret.authTag, last_error_class: null },
        error: null,
      }) }) }),
    };
  }) as never);

  const m = manualMonotonic(50_000);
  t.mock.method(performance, "now", () => m.now());
  wallClockGoingBackwards(t);
  let sends = 0;
  t.mock.method(realSmtpTransport, "send", (async () => { sends += 1; m.advance(80_000); return { ok: true, messageId: `m${sends}` }; }) as never);

  const previous = { CRON_SECRET: process.env.CRON_SECRET, GATE: process.env.NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED };
  process.env.CRON_SECRET = "cron-secret-synthetique-0123456789";
  process.env.NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED = "true";
  try {
    const res = await route.GET(new NextRequest("http://localhost/api/internal/notifications/send", { headers: { authorization: "Bearer cron-secret-synthetique-0123456789" } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(sends, 2, "80 s + 80 s = 160 s > 150 s : aucun troisième envoi, même si l'horloge murale a reculé");
    assert.equal(body.result.sent, 2);
    assert.equal(body.deferred, 1);
    assert.equal(completed.length, 2);
    assert.ok(limits.WORKER_RUN_BUDGET_MS === 150_000);
  } finally {
    if (previous.CRON_SECRET === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous.CRON_SECRET;
    if (previous.GATE === undefined) delete process.env.NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED; else process.env.NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED = previous.GATE;
  }
});

// ----- garde-fous de structure ------------------------------------------------------
test("R3-05 structure : la route crée le budget monotone AVANT le reap et le transmet ; le worker le consulte ; une seule lecture de date murale reste (garde-fou)", () => {
  const routeSrc = readFileSync(new URL("../app/api/internal/notifications/send/route.ts", import.meta.url), "utf8");
  const create = routeSrc.indexOf("createRunBudget(WORKER_RUN_BUDGET_MS)");
  const reap = routeSrc.indexOf("await reapStaleNotificationClaims(");
  assert.ok(create > 0 && reap > create, "le budget démarre avant le reap, comme startedAt");
  assert.match(routeSrc, /\bbudget,\r?\n/); // checkout Windows (autocrlf) : fins de ligne CRLF admises
  const workerSrc = readFileSync(new URL("../lib/server/notifications/notification-worker.ts", import.meta.url), "utf8");
  assert.match(workerSrc, /options\.budget !== undefined && options\.budget\.expired\(\)/);
  assert.equal((workerSrc.match(/Date\.now\(\)/g) ?? []).length, 1, "la seule lecture de date murale du worker est le garde-fou deadlineAt");
  const budgetSrc = readFileSync(new URL("../lib/server/notifications/run-budget.ts", import.meta.url), "utf8");
  assert.equal(/Date\.now|new Date\(/.test(budgetSrc.replace(/\/\*[\s\S]*?\*\//g, "")), false, "run-budget n'utilise jamais l'horloge murale");
  assert.match(budgetSrc, /performance\.now\(\)/);
});
