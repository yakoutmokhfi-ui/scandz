import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// ====================================================================
// ISSUE #172 — ORDER_RECEIVED PAYMENT GATE v1 : le SQL RÉEL dans PGlite.
//
// Règle métier (Yakout, 28/10/2026) :
//   * paiement en ligne : l'e-mail ne part qu'à `paid` ;
//   * sans paiement en ligne (`not_required`) : après 5 minutes de grâce ;
//   * `required` / `pending` / `failed` / `cancelled` : jamais.
//
// La table notification_outbox et la fonction claim_pending_notifications
// sont extraites TELLES QUELLES du lot N1-A (une seule définition dans le
// dépôt), puis le lot de porte est appliqué par-dessus.
// Aucun e-mail, aucun réseau, aucune base hébergée.
// ====================================================================

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const LOT = "DRAFT-lot-order-received-payment-gate-v1.sql";
const ROLLBACK = "DRAFT-lot-order-received-payment-gate-v1-rollback.sql";

const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
const N1A_CLAIM = N1A.match(/create function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];

async function makeDb(applyLot = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.restaurants (id uuid primary key default gen_random_uuid());
    create table public.orders (
      id uuid primary key default gen_random_uuid(),
      restaurant_id uuid not null,
      payment_status text not null default 'not_required',
      created_at timestamptz not null default now()
    );
    create table public.merchant_notification_profile (
      restaurant_id uuid primary key, sender_name text, sender_email text, reply_to text
    );
    ${N1A_TABLE}
    ${N1A_CLAIM}
    revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
    grant execute on function public.claim_pending_notifications(integer, integer) to service_role;
  `);
  if (applyLot) await db.exec(sql(LOT));
  return db;
}

async function addOrder(
  db: PGlite,
  paymentStatus: string,
  ageMinutes: number,
  type = "order_received"
): Promise<{ orderId: string; outboxId: string }> {
  const rest = (await db.query<{ id: string }>("insert into public.restaurants default values returning id")).rows[0]!.id;
  await db.query("insert into public.merchant_notification_profile values ($1::uuid, 'Au Lait Cru', 'contact@example.test', null)", [rest]);
  const order = await db.query<{ id: string }>(
    `insert into public.orders (restaurant_id, payment_status, created_at)
       values ($1::uuid, $2, now() - make_interval(secs => $3::int)) returning id`,
    [rest, paymentStatus, Math.round(ageMinutes * 60)]
  );
  const orderId = order.rows[0]!.id;
  const ob = await db.query<{ id: string }>(
    `insert into public.notification_outbox
       (restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status, created_at)
     values ($1::uuid, $2::uuid, $3, 'client@example.test', 'fr', '{}'::jsonb, 'pending', now() - make_interval(secs => $4::int))
     returning id`,
    [rest, orderId, type, Math.round(ageMinutes * 60)]
  );
  return { orderId, outboxId: ob.rows[0]!.id };
}

const claim = async (db: PGlite, batch = 10) =>
  (await db.query<{ outbox_id: string; order_id: string }>("select * from public.claim_pending_notifications($1, 60)", [batch])).rows;

test("[172-GATE-1] paid -> l'e-mail est éligible", async () => {
  const db = await makeDb();
  const { outboxId } = await addOrder(db, "paid", 0);
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [outboxId]);
});

test("[172-GATE-2] not_required : fermé avant 5 minutes, ouvert après", async () => {
  const db = await makeDb();
  const fresh = await addOrder(db, "not_required", 0);
  const fourMin = await addOrder(db, "not_required", 4);
  assert.deepEqual(await claim(db), [], "0 et 4 minutes : rien");
  const sixMin = await addOrder(db, "not_required", 6);
  const claimed = (await claim(db)).map((r) => r.outbox_id);
  assert.deepEqual(claimed, [sixMin.outboxId], "6 minutes : seule cette commande part");
  assert.ok(!claimed.includes(fresh.outboxId) && !claimed.includes(fourMin.outboxId));
});

test("[172-GATE-3] required / pending / failed / cancelled : JAMAIS, même très ancien ; la ligne reste intacte", async () => {
  const db = await makeDb();
  const rows = [];
  for (const status of ["required", "pending", "failed", "cancelled"]) rows.push(await addOrder(db, status, 24 * 60));
  assert.deepEqual(await claim(db), []);
  for (const r of rows) {
    const row = (await db.query<{ status: string; attempt_count: number; claim_token: string | null }>(
      "select status, attempt_count, claim_token from public.notification_outbox where id = $1::uuid", [r.outboxId])).rows[0]!;
    assert.deepEqual(row, { status: "pending", attempt_count: 0, claim_token: null }, "aucune tentative consommée");
  }
});

test("[172-GATE-4] paiement refusé puis réussi plus tard : l'e-mail part alors, une seule fois", async () => {
  const db = await makeDb();
  const { orderId, outboxId } = await addOrder(db, "pending", 30);
  assert.deepEqual(await claim(db), []);
  await db.query("update public.orders set payment_status = 'failed' where id = $1::uuid", [orderId]);
  assert.deepEqual(await claim(db), []);
  await db.query("update public.orders set payment_status = 'paid' where id = $1::uuid", [orderId]);
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [outboxId]);
  assert.deepEqual(await claim(db), [], "déjà réclamé : pas de second envoi");
});

test("[172-GATE-5] les autres types de notification gardent EXACTEMENT leur comportement", async () => {
  const db = await makeDb();
  const { outboxId } = await addOrder(db, "required", 0, "order_accepted");
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [outboxId]);
});

test("[172-GATE-6] des lignes fermées n'affament pas le lot (le filtre précède la limite)", async () => {
  const db = await makeDb();
  for (let i = 0; i < 3; i++) await addOrder(db, "required", 120 + i);
  const paid = await addOrder(db, "paid", 0);
  assert.deepEqual((await claim(db, 1)).map((r) => r.outbox_id), [paid.outboxId]);
});

test("[172-GATE-7] commande introuvable -> porte fermée ; non exécutable par les rôles applicatifs", async () => {
  const db = await makeDb();
  const open = await db.query<{ ok: boolean }>(
    "select public.notification_send_gate_open('00000000-0000-4000-8000-000000000000'::uuid, 'order_received') as ok");
  assert.equal(open.rows[0]!.ok, false);
  const priv = async (role: string, fn: string) =>
    (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0]!.ok;
  const gate = "public.notification_send_gate_open(uuid, text)";
  const claimFn = "public.claim_pending_notifications(integer, integer)";
  for (const role of ["anon", "authenticated", "public"]) {
    assert.equal(await priv(role, gate), false, `${role} / porte`);
    assert.equal(await priv(role, claimFn), false, `${role} / claim`);
  }
  assert.equal(await priv("service_role", claimFn), true);
});

test("[172-GATE-8] le corps de claim_pending_notifications est IDENTIQUE à N1-A, au seul prédicat de porte près", () => {
  const lot = sql(LOT);
  const lotClaim = lot.match(/create or replace function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];
  const normalise = (s: string) =>
    s
      .replace("create or replace function", "create function")
      .split("\n")
      .filter((l) => !/ORDER_RECEIVED PAYMENT GATE v1|notification_send_gate_open\(/.test(l))
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join("\n");
  assert.equal(normalise(lotClaim), normalise(N1A_CLAIM));
  // Et le prédicat est bien présent, une seule fois.
  assert.equal((lotClaim.match(/notification_send_gate_open\(/g) ?? []).length, 1);
});

test("[172-GATE-9] retour arrière : corps N1-A restauré à l'identique, porte supprimée", async () => {
  const base = await makeDb(false);
  const def = async (db: PGlite) =>
    (await db.query<{ d: string }>(
      "select pg_get_functiondef('public.claim_pending_notifications(integer, integer)'::regprocedure) as d")).rows[0]!.d;
  const original = await def(base);

  const db = await makeDb(true);
  assert.notEqual(await def(db), original, "le lot modifie bien la fonction");
  await db.exec(sql(ROLLBACK));
  assert.equal(await def(db), original);
  assert.equal((await db.query("select 1 from pg_proc where proname = 'notification_send_gate_open'")).rows.length, 0);
});

test("[172-GATE-10] double application refusée ; prérequis absents refusés (échec fermé)", async () => {
  const db = await makeDb();
  await assert.rejects(() => db.exec(sql(LOT)), /déjà appliqué|already exists/);

  const empty = new PGlite();
  await assert.rejects(() => empty.exec(sql(LOT)), /SCANYM_SCHEMA_DRIFT/);
});

test("[172-GATE-11] le lot ne touche ni create_order, ni complete_notification_attempt, ni le gabarit", () => {
  // Le code SQL seul (les commentaires d'en-tête nomment ces fonctions pour
  // dire justement qu'elles ne sont PAS touchées).
  const code = sql(LOT)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
  for (const forbidden of ["create_order", "complete_notification_attempt", "create_order_received_notification", "insert into", "delete from", "update public.orders"]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
});
