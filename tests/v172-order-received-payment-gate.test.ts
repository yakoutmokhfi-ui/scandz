import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// ====================================================================
// ISSUE #172 — ORDER_RECEIVED PAYMENT GATE v1 : le SQL RÉEL dans PGlite.
//
// Règle métier (Yakout, 28/10/2026) :
//   * paiement en ligne : l'e-mail ne part qu'à `paid` ;
//   * sans paiement en ligne (`not_required`) : seulement une fois ce mode
//     rendu DÉFINITIF (payment_mode_final = 'none'), jamais sur un délai ;
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
      public_token uuid not null default gen_random_uuid(),
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
  type = "order_received",
  finalNone = false
): Promise<{ orderId: string; outboxId: string; token: string }> {
  const rest = (await db.query<{ id: string }>("insert into public.restaurants default values returning id")).rows[0]!.id;
  await db.query("insert into public.merchant_notification_profile values ($1::uuid, 'Au Lait Cru', 'contact@example.test', null)", [rest]);
  const order = await db.query<{ id: string; public_token: string }>(
    `insert into public.orders (restaurant_id, payment_status, created_at)
       values ($1::uuid, $2, now() - make_interval(secs => $3::int)) returning id, public_token`,
    [rest, paymentStatus, Math.round(ageMinutes * 60)]
  );
  const orderId = order.rows[0]!.id;
  const token = order.rows[0]!.public_token;
  if (finalNone) await finalizeNone(db, orderId, token);
  const ob = await db.query<{ id: string }>(
    `insert into public.notification_outbox
       (restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status, created_at)
     values ($1::uuid, $2::uuid, $3, 'client@example.test', 'fr', '{}'::jsonb, 'pending', now() - make_interval(secs => $4::int))
     returning id`,
    [rest, orderId, type, Math.round(ageMinutes * 60)]
  );
  return { orderId, outboxId: ob.rows[0]!.id, token };
}

const finalizeNone = async (db: PGlite, orderId: string, token: string) =>
  (await db.query<{ payment_status: string; payment_mode_final: string | null }>(
    "select * from public.finalize_order_payment_mode_none($1::uuid, $2::uuid)", [orderId, token])).rows;

const claim = async (db: PGlite, batch = 10) =>
  (await db.query<{ outbox_id: string; order_id: string }>("select * from public.claim_pending_notifications($1, 60)", [batch])).rows;

test("[172-GATE-1] paid -> l'e-mail est éligible", async () => {
  const db = await makeDb();
  const { outboxId } = await addOrder(db, "paid", 0);
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [outboxId]);
});

test("[172-GATE-2] not_required : fermé tant que le mode n'est pas définitif (même très ancien), ouvert une fois 'none'", async () => {
  const db = await makeDb();
  const undecided = await addOrder(db, "not_required", 24 * 60);
  assert.deepEqual(await claim(db), [], "aucun délai ne suffit : pas de décision finale = pas d'e-mail");
  const decided = await addOrder(db, "not_required", 0, "order_received", true);
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [decided.outboxId]);
  assert.ok(undecided.outboxId !== decided.outboxId);
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
  assert.equal((await db.query("select 1 from pg_proc where proname in ('notification_send_gate_open','finalize_order_payment_mode_none','orders_payment_mode_final_guard')")).rows.length, 0);
  assert.equal((await db.query("select 1 from information_schema.columns where table_name = 'orders' and column_name = 'payment_mode_final'")).rows.length, 0);
  assert.equal((await db.query("select 1 from pg_trigger where tgname = 'orders_payment_mode_final_guard_trg'")).rows.length, 0);
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
  for (const forbidden of ["create_order", "complete_notification_attempt", "create_order_received_notification", "insert into", "delete from", "require_order_payment"]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  // Les seules écritures sur orders : la colonne payment_mode_final.
  const updates = code.match(/update public\.orders o\s+set [^\n]+/g) ?? [];
  for (const u of updates) assert.match(u, /set payment_mode_final = 'none'/);
});

// ====================================================================
// CONSIGNE CTO : « Ajoute un test qui fait varier l'ordre entre
// réclamation de l'e-mail et passage au paiement requis, et prouve
// qu'aucun e-mail de confirmation ne part avant paiement. »
// `update ... payment_status = 'required'` est EXACTEMENT l'unique
// mutation de require_order_payment (P4-A) ; le garde est un déclencheur.
// ====================================================================

const flipToRequired = (db: PGlite, orderId: string) =>
  db.query("update public.orders set payment_status = 'required' where id = $1::uuid and payment_status = 'not_required'", [orderId]);
const modeOf = async (db: PGlite, orderId: string) =>
  (await db.query<{ payment_status: string; payment_mode_final: string | null }>(
    "select payment_status, payment_mode_final from public.orders where id = $1::uuid", [orderId])).rows[0]!;
const outboxStatus = async (db: PGlite, id: string) =>
  (await db.query<{ status: string; attempt_count: number }>(
    "select status, attempt_count from public.notification_outbox where id = $1::uuid", [id])).rows[0]!;

test("[172-RACE-1] ordre A : la réclamation passe AVANT le passage à required -> rien n'est réclamé (mode non décidé)", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  assert.deepEqual(await claim(db), [], "claim d'abord : porte fermée");
  await flipToRequired(db, o.orderId);
  assert.deepEqual(await claim(db), [], "puis required : toujours rien");
  assert.deepEqual(await outboxStatus(db, o.outboxId), { status: "pending", attempt_count: 0 });
  assert.equal((await modeOf(db, o.orderId)).payment_mode_final, "online");
});

test("[172-RACE-2] ordre B : le passage à required AVANT la réclamation -> rien, puis l'e-mail part au paiement et une seule fois", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  await flipToRequired(db, o.orderId);
  assert.deepEqual(await claim(db), []);
  await db.query("update public.orders set payment_status = 'pending' where id = $1::uuid", [o.orderId]);
  assert.deepEqual(await claim(db), []);
  await db.query("update public.orders set payment_status = 'paid' where id = $1::uuid", [o.orderId]);
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [o.outboxId]);
  assert.deepEqual(await claim(db), []);
});

test("[172-RACE-3] ordre C : décision « sans paiement » PUIS réclamation PUIS tentative de passage à required -> le passage est refusé, l'e-mail déjà légitime", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  assert.deepEqual(await finalizeNone(db, o.orderId, o.token), [{ payment_status: "not_required", payment_mode_final: "none" }]);
  assert.deepEqual((await claim(db)).map((r) => r.outbox_id), [o.outboxId]);
  await assert.rejects(() => flipToRequired(db, o.orderId), /SCANYM_PAYMENT_MODE_FINAL/);
  assert.deepEqual(await modeOf(db, o.orderId), { payment_status: "not_required", payment_mode_final: "none" });
});

test("[172-RACE-4] ordre D : passage à required PUIS décision « sans paiement » -> la décision est sans effet, aucun e-mail", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  await flipToRequired(db, o.orderId);
  assert.deepEqual(await finalizeNone(db, o.orderId, o.token), [{ payment_status: "required", payment_mode_final: "online" }]);
  assert.deepEqual(await claim(db), []);
});

test("[172-RACE-5] concurrence réelle : verrou de ligne tenu par le passage à required (non validé) -> la décision attend, puis ne change rien", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  await db.query("begin");
  await flipToRequired(db, o.orderId); // non validé
  // Une réclamation concurrente ne voit pas encore l'état : porte fermée (mode NULL).
  assert.deepEqual(await claim(db), []);
  await db.query("commit");
  assert.deepEqual(await finalizeNone(db, o.orderId, o.token), [{ payment_status: "required", payment_mode_final: "online" }]);
  assert.deepEqual(await claim(db), []);
});

test("[172-RACE-6] toutes les permutations de {claim, finalize 'none', flip required} : aucun e-mail n'est réclamé tant que la commande n'est pas payée en ligne", async () => {
  type Step = "claim" | "finalize" | "flip";
  const steps: Step[] = ["claim", "finalize", "flip"];
  const perms = (xs: Step[]): Step[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  for (const order of perms(steps)) {
    const db = await makeDb();
    const o = await addOrder(db, "not_required", 0);
    const claimedWhile: string[] = [];
    let rejected = false;
    for (const step of order) {
      if (step === "claim") claimedWhile.push(...(await claim(db)).map((r) => r.outbox_id));
      if (step === "finalize") await finalizeNone(db, o.orderId, o.token);
      if (step === "flip") await flipToRequired(db, o.orderId).catch(() => { rejected = true; });
    }
    const final = await modeOf(db, o.orderId);
    // Invariant : un e-mail réclamé implique « sans paiement en ligne » définitif ; jamais sur une commande required.
    if (claimedWhile.length > 0) {
      assert.deepEqual(final, { payment_status: "not_required", payment_mode_final: "none" }, `permutation ${order.join(">")}`);
      if (order.includes("flip")) assert.ok(rejected, `permutation ${order.join(">")} : le passage à required doit avoir été refusé`);
    }
    if (final.payment_status === "required") assert.deepEqual(claimedWhile, [], `permutation ${order.join(">")}`);
    // Dans tous les cas la ligne réclamée reste unique et la non-réclamée reste récupérable.
    const st = await outboxStatus(db, o.outboxId);
    assert.ok(st.status === "processing" || (st.status === "pending" && st.attempt_count === 0), `permutation ${order.join(">")}`);
  }
});

test("[172-RACE-7] une réclamation EN COURS (processing) d'une commande 'sans paiement' ne peut plus être suivie d'un paiement requis", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0, "order_received", true);
  assert.equal((await claim(db)).length, 1);
  await assert.rejects(() => flipToRequired(db, o.orderId), /SCANYM_PAYMENT_MODE_FINAL/);
});

test("[172-RACE-8] finalize : preuve de possession exigée, idempotente, droits service_role uniquement", async () => {
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  assert.deepEqual(await finalizeNone(db, o.orderId, "00000000-0000-4000-8000-000000000000"), []);
  assert.deepEqual(await modeOf(db, o.orderId), { payment_status: "not_required", payment_mode_final: null });
  await finalizeNone(db, o.orderId, o.token);
  assert.deepEqual(await finalizeNone(db, o.orderId, o.token), [{ payment_status: "not_required", payment_mode_final: "none" }]);
  const fn = "public.finalize_order_payment_mode_none(uuid, uuid)";
  for (const role of ["anon", "authenticated", "public"]) {
    assert.equal((await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0]!.ok, false, role);
  }
  assert.equal((await db.query<{ ok: boolean }>("select has_function_privilege('service_role', $1, 'execute') as ok", [fn])).rows[0]!.ok, true);
});
