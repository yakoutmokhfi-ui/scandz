import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

async function makeDb(applyLot = true, claimSql: string = N1A_CLAIM, afterPredecessorSql = "") {
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
    ${claimSql}
    revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
    grant execute on function public.claim_pending_notifications(integer, integer) to service_role;
    ${afterPredecessorSql}
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

test("[172-RACE-5] SÉQUENTIEL (une seule connexion PGlite) : passage à required validé, PUIS décision « sans paiement » -> la décision ne change rien. Ce test NE démontre PAS la concurrence (voir v172-order-received-payment-gate-concurrency-pg)", async () => {
  // Portée réelle de ce test : PGlite est à connexion unique. Les opérations
  // ci-dessous s'exécutent l'une après l'autre dans le MÊME objet de base ;
  // la réclamation voit donc sa propre transaction. Aucune opération n'attend
  // un verrou, aucune visibilité inter-transactions n'est mesurée. La preuve
  // multi-connexions (verrou de ligne réellement en attente) est dans
  // tests/v172-order-received-payment-gate-concurrency-pg.test.ts, qui exige
  // un vrai PostgreSQL.
  const db = await makeDb();
  const o = await addOrder(db, "not_required", 0);
  await db.query("begin");
  await flipToRequired(db, o.orderId);
  // Même connexion, même transaction : la réclamation voit l'écriture non validée.
  assert.deepEqual(await claim(db), [], "required est visible depuis la même transaction -> porte fermée");
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


// ====================================================================
// T180-02 -- PRÉ-VOL : le lot (et son rollback) REFUSE toute définition
// prédécesseur différente de celle attendue, SANS rien modifier.
// ====================================================================

const md5 = (t: string) => createHash("md5").update(t.replace(/\r/g, "")).digest("hex");
const bodyOf = (fn: string) => fn.match(/\bas \$\$([\s\S]*?)\$\$;/)![1]!;
const LOT_CLAIM = sql(LOT).match(/create or replace function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];
const CLAIM_FN = "public.claim_pending_notifications(integer, integer)";

/** Découpe un script SQL en instructions (ignore ; dans '...', $$...$$ et commentaires). */
function splitStatements(script: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let dollar: string | null = null;
  while (i < script.length) {
    const c = script[i]!;
    if (dollar) {
      if (script.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
      cur += c; i++; continue;
    }
    if (c === "-" && script[i + 1] === "-") { const nl = script.indexOf("\n", i); const end = nl === -1 ? script.length : nl; cur += script.slice(i, end); i = end; continue; }
    if (c === "'") { let j = i + 1; while (j < script.length) { if (script[j] === "'" && script[j + 1] === "'") j += 2; else if (script[j] === "'") break; else j++; } cur += script.slice(i, j + 1); i = j + 1; continue; }
    if (c === "$") { const m = /^\$[A-Za-z_]*\$/.exec(script.slice(i)); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (c === ";") { cur += c; if (cur.replace(/--[^\n]*/g, "").trim() !== ";") out.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.replace(/--[^\n]*/g, "").trim() !== "") out.push(cur.trim());
  return out;
}

/** Pire cas opérateur : chaque instruction envoyée séparément, erreurs ignorées (psql sans ON_ERROR_STOP). */
async function runIgnoringErrors(db: PGlite, script: string): Promise<string[]> {
  const errors: string[] = [];
  for (const stmt of splitStatements(script)) {
    try { await db.exec(stmt); } catch (e) { errors.push((e as Error).message); }
  }
  return errors;
}

async function snapshot(db: PGlite) {
  const q = async (text: string): Promise<Array<Record<string, any>>> => (await db.query<Record<string, any>>(text)).rows;
  return {
    claim: await q(`select pg_get_functiondef('${CLAIM_FN}'::regprocedure) as d, p.proacl::text as acl, p.prosecdef, p.proconfig::text as cfg,
                           md5(replace(p.prosrc, E'\r', '')) as body_md5
                      from pg_proc p where p.oid = '${CLAIM_FN}'::regprocedure`),
    // Ligne pg_proc COMPLÈTE du claim (propriétaire, ACL, STRICT, volatilité, LEAKPROOF, PARALLEL, COST, ROWS, SET…) :
    // toute modification d'attribut ou de droit, même hors de ce que le pré-vol compare, apparaît ici.
    claimRow: await q(`select to_jsonb(p)::text as r from pg_proc p where p.oid = '${CLAIM_FN}'::regprocedure`),
    claimAcl: await q(`select coalesce(a.grantee::regrole::text, 'PUBLIC') as grantee, a.grantor::regrole::text as grantor, a.privilege_type, a.is_grantable
                         from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where p.oid = '${CLAIM_FN}'::regprocedure order by 1, 2, 3, 4`),
    allFunctionAcl: await q(`select p.proname, p.proowner::regrole::text as owner, p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`),
    roles: await q(`select rolname from pg_roles where rolname !~ '^pg_' order by 1`),
    ordersFull: await q(`select to_jsonb(o)::text as r from public.orders o order by id`),
    functions: await q(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`),
    ordersColumns: await q(`select column_name from information_schema.columns where table_schema='public' and table_name='orders' order by 1`),
    orders: await q(`select id, payment_status from public.orders order by id`),
    outbox: await q(`select id, status, attempt_count, claim_token from public.notification_outbox order by id`),
    txOpen: await q(`select (select count(*) from pg_stat_activity) >= 0 as ok`),
    // T180-R4-01 : TOUS les objets du lot que le rollback supprime -- lignes catalogue complètes,
    // pour que toute suppression ou réécriture silencieuse apparaisse dans la comparaison.
    auxProcs: await q(`select p.proname, to_jsonb(p)::text as r from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname in ('notification_send_gate_open', 'orders_payment_mode_final_guard', 'finalize_order_payment_mode_none') order by 1`),
    auxDefs: await q(`select p.proname, pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname in ('notification_send_gate_open', 'orders_payment_mode_final_guard', 'finalize_order_payment_mode_none') order by 1`),
    triggers: await q(`select t.tgname, to_jsonb(t)::text as r from pg_trigger t where t.tgrelid = 'public.orders'::regclass order by 1`),
    constraints: await q(`select c.conname, to_jsonb(c)::text as r from pg_constraint c where c.conrelid = 'public.orders'::regclass order by 1`),
    orderAttrs: await q(`select a.attname, to_jsonb(a)::text as r from pg_attribute a where a.attrelid = 'public.orders'::regclass and a.attnum > 0 order by a.attnum`),
    orderIndexes: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'orders' order by 1`),
    orderPolicies: await q(`select policyname, qual from pg_policies where schemaname = 'public' and tablename = 'orders' order by 1`),
    publicViews: await q(`select viewname, definition from pg_views where schemaname = 'public' order by 1`),
    archive: await q(`select to_regclass('public.orders_payment_mode_final_rollback_archive')::text as t`),
  };
}

const DRIFTS: Array<{ label: string; claim: (c: string) => string; extra?: string; check: RegExp }> = [
  { label: "restriction supplémentaire dans le corps (reproduction de l'auditeur)", claim: (c) => c.replace("where o.status in ('pending', 'failed_retryable')", "where false and o.status in ('pending', 'failed_retryable')") , check: /le corps de claim_pending_notifications \(md5 [0-9a-f]{32}\) n'est pas celui du lot N1-A attendu/ },
  { label: "corps modifié par un simple commentaire", claim: (c) => c.replace("begin\n  return query", "begin\n  -- variante locale\n  return query") , check: /le corps de claim_pending_notifications \(md5 [0-9a-f]{32}\) n'est pas celui du lot N1-A attendu/ },
  { label: "search_path différent", claim: (c) => c.replace("set search_path = ''", "set search_path = public") , check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "SECURITY INVOKER au lieu de DEFINER", claim: (c) => c.replace("language plpgsql\nsecurity definer\n", "language plpgsql\n") , check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "valeur par défaut d'argument différente", claim: (c) => c.replace("p_batch_size    integer default 10", "p_batch_size    integer default 20") , check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "colonne retournée renommée", claim: (c) => c.replace(/reply_to\s+text\n\)/, "reply_to_addr text\n)") , check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "droit d'exécution élargi à authenticated", claim: (c) => c, extra: `grant execute on function ${CLAIM_FN} to authenticated;` , check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
  // --- T180-02 / constat R3 : attributs (STRICT etc.) et ENSEMBLE COMPLET des droits ---
  { label: "STRICT (RETURNS NULL ON NULL INPUT) -- contre-exemple de Turing", claim: (c) => c, extra: `alter function ${CLAIM_FN} returns null on null input;`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "volatilité STABLE", claim: (c) => c, extra: `alter function ${CLAIM_FN} stable;`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "LEAKPROOF", claim: (c) => c, extra: `alter function ${CLAIM_FN} leakproof;`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "PARALLEL SAFE", claim: (c) => c, extra: `alter function ${CLAIM_FN} parallel safe;`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "COST différent", claim: (c) => c, extra: `alter function ${CLAIM_FN} cost 500;`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "ROWS différent", claim: (c) => c, extra: `alter function ${CLAIM_FN} rows 7;`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "réglage SET supplémentaire (statement_timeout)", claim: (c) => c, extra: `alter function ${CLAIM_FN} set statement_timeout = '5s';`, check: /attributs de claim_pending_notifications différents de N1-A/ },
  { label: "rôle supplémentaire avec EXECUTE -- contre-exemple de Turing", claim: (c) => c, extra: `create role audit_extra nologin; grant execute on function ${CLAIM_FN} to audit_extra;`, check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
  { label: "droit d'exécution accordé à anon", claim: (c) => c, extra: `grant execute on function ${CLAIM_FN} to anon;`, check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
  { label: "droit d'exécution accordé à PUBLIC", claim: (c) => c, extra: `grant execute on function ${CLAIM_FN} to public;`, check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
  { label: "service_role avec option de transmission (WITH GRANT OPTION)", claim: (c) => c, extra: `grant execute on function ${CLAIM_FN} to service_role with grant option;`, check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
  { label: "propriétaire différent du rôle qui applique le lot", claim: (c) => c, extra: `create role audit_other_owner; alter function ${CLAIM_FN} owner to audit_other_owner;`, check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
  { label: "droit d'exécution de service_role retiré", claim: (c) => c, extra: `revoke execute on function ${CLAIM_FN} from service_role;` , check: /droits d'exécution de claim_pending_notifications différents de N1-A/ },
];

test("[172-PRE-1] les empreintes du pré-vol sont celles du fichier N1-A (lot) et du claim du lot (rollback), et celles que PostgreSQL stocke", async () => {
  const lotSql = sql(LOT);
  const rbSql = sql(ROLLBACK);
  const expected = lotSql.match(/c_expected_body_md5 constant text := '([0-9a-f]{32})'/)![1]!;
  const gated = rbSql.match(/c_gated_body_md5 constant text := '([0-9a-f]{32})'/)![1]!;
  assert.equal(expected, md5(bodyOf(N1A_CLAIM)), "constante du lot = corps du claim N1-A du dépôt");
  assert.equal(gated, md5(bodyOf(LOT_CLAIM)), "constante du rollback = corps du claim posé par le lot");
  assert.notEqual(expected, gated);

  const stored = async (db: PGlite) =>
    (await db.query<{ m: string }>(`select md5(replace(prosrc, E'\r', '')) as m from pg_proc where oid = '${CLAIM_FN}'::regprocedure`)).rows[0]!.m;
  assert.equal(await stored(await makeDb(false)), expected, "PostgreSQL stocke exactement le corps N1-A attendu");
  assert.equal(await stored(await makeDb(true)), gated, "PostgreSQL stocke exactement le corps posé par le lot");

  // Les attributs comparés par le pré-vol sont ceux de N1-A (arguments et résultat).
  const db = await makeDb(false);
  const attrs = (await db.query<{ a: string; r: string }>(
    `select pg_get_function_arguments(oid) as a, pg_get_function_result(oid) as r from pg_proc where oid = '${CLAIM_FN}'::regprocedure`)).rows[0]!;
  assert.ok(lotSql.includes(`c_expected_args     constant text := '${attrs.a}'`));
  assert.ok(lotSql.includes(`c_expected_result   constant text := '${attrs.r}'`));
});

for (const drift of DRIFTS) {
  test(`[172-PRE-2] prédécesseur différent -- ${drift.label} : le lot est REFUSÉ (SCANYM_PREDECESSOR_DRIFT), rien n'est modifié, ni la fonction ni les données`, async () => {
    const variant = drift.claim(N1A_CLAIM);
    if (!drift.extra) assert.notEqual(variant, N1A_CLAIM, "la variante diffère bien de N1-A");
    const db = await makeDb(false, variant, drift.extra ?? "");
    const order = await addOrder(db, "paid", 0);
    const before = await snapshot(db);
    const claimIds = async () => (await claim(db, 1).catch(() => [])).map((r) => r.outbox_id);
    const claimBefore = await claimIds();
    // Le claim de test ne doit pas altérer l'état comparé : on le rend à pending.
    await db.query("update public.notification_outbox set status = 'pending', claim_token = null, claimed_at = null, claim_expires_at = null");
    const before2 = await snapshot(db);
    assert.deepEqual(before2.claim, before.claim);

    // Mode 1 : script soumis d'un bloc (une seule requête).
    await assert.rejects(() => db.exec(sql(LOT)), (e: Error) => /SCANYM_PREDECESSOR_DRIFT/.test(e.message) && drift.check.test(e.message));
    await db.exec("rollback");
    assert.deepEqual(await snapshot(db), before, "bloc unique : aucune mutation");

    // Mode 2 : pire cas opérateur -- instruction par instruction, erreurs ignorées.
    const errors = await runIgnoringErrors(db, sql(LOT));
    assert.ok(errors.some((e) => /SCANYM_PREDECESSOR_DRIFT/.test(e) && drift.check.test(e)), "le refus explicite, par le bon contrôle, est bien levé");
    assert.deepEqual(await snapshot(db), before, "instruction par instruction : aucune mutation");

    // Aucune trace du lot : ni colonne, ni fonction, ni porte.
    const names = (await snapshot(db)).functions.map((f) => f.proname);
    assert.ok(!names.includes("finalize_order_payment_mode_none") && !names.includes("notification_send_gate_open") && !names.includes("orders_payment_mode_final_guard"));
    assert.ok(!(await snapshot(db)).ordersColumns.some((c: any) => c.column_name === "payment_mode_final"));
    // La variante garde son comportement propre (jamais « normalisée » par le lot).
    assert.deepEqual(await claimIds(), claimBefore);
    assert.ok(order.orderId);
  });
}

test("[172-PRE-3] contrôle positif : N1-A exact -> le lot s'applique, la définition devient celle du lot ; refus de double application inchangé", async () => {
  const db = await makeDb(false);
  await db.exec(sql(LOT));
  const row = (await db.query<{ m: string }>(`select md5(replace(prosrc, E'\r', '')) as m from pg_proc where oid = '${CLAIM_FN}'::regprocedure`)).rows[0]!;
  assert.equal(row.m, md5(bodyOf(LOT_CLAIM)));
  await assert.rejects(() => db.exec(sql(LOT)), /double application refusée/);
});

test("[172-PRE-4] rollback : refusé si le claim a été modifié depuis le lot (SCANYM_PREDECESSOR_DRIFT), rien n'est modifié ; refusé si le lot n'est pas appliqué ; nominal : N1-A restauré à l'empreinte exacte", async () => {
  // a) claim modifié après le lot.
  const db = await makeDb(true);
  const tweaked = LOT_CLAIM.replace("and public.notification_send_gate_open(o.order_id, o.notification_type)", "and public.notification_send_gate_open(o.order_id, o.notification_type) and true");
  assert.notEqual(tweaked, LOT_CLAIM);
  await db.exec(tweaked);
  const before = await snapshot(db);
  await assert.rejects(() => db.exec(sql(ROLLBACK)), /SCANYM_PREDECESSOR_DRIFT/);
  await db.exec("rollback");
  assert.deepEqual(await snapshot(db), before, "bloc unique : rollback refusé sans mutation");
  const errors = await runIgnoringErrors(db, sql(ROLLBACK));
  assert.ok(errors.some((e) => /SCANYM_PREDECESSOR_DRIFT/.test(e)));
  assert.deepEqual(await snapshot(db), before, "instruction par instruction : rollback refusé sans mutation");
  assert.ok((await snapshot(db)).functions.some((f: any) => f.proname === "notification_send_gate_open"), "la porte est toujours là");

  // b) lot non appliqué.
  const clean = await makeDb(false);
  const cleanBefore = await snapshot(clean);
  await assert.rejects(() => clean.exec(sql(ROLLBACK)), /SCANYM_ROLLBACK_PREFLIGHT_FAILED/);
  await clean.exec("rollback");
  assert.deepEqual(await snapshot(clean), cleanBefore);

  // c) nominal : lot puis rollback -> empreinte N1-A exacte, attributs et droits identiques.
  const nominal = await makeDb(false);
  const original = await snapshot(nominal);
  await nominal.exec(sql(LOT));
  await nominal.exec(sql(ROLLBACK));
  const restored = await snapshot(nominal);
  assert.equal(restored.claim[0]!.body_md5, md5(bodyOf(N1A_CLAIM)));
  assert.equal(restored.claim[0]!.acl, original.claim[0]!.acl);
  assert.equal(restored.claim[0]!.cfg, original.claim[0]!.cfg);
  assert.equal(restored.claim[0]!.prosecdef, original.claim[0]!.prosecdef);
  assert.deepEqual(restored.ordersColumns, original.ordersColumns);
});

// ====================================================================
// T180-02 / constat R3 (contre-audit de Turing sur 5d3c3f0) : le rollback
// applique la MÊME politique que le lot -- tous les attributs de pg_proc que
// CREATE OR REPLACE réécrirait (STRICT compris) et l'ENSEMBLE COMPLET des
// droits EXECUTE. Chaque variante est introduite APRÈS l'application du lot ;
// le rollback doit être refusé avant toute écriture, et les décisions
// payment_mode_final déjà prises doivent rester intactes.
// ====================================================================
const ROLLBACK_ATTR = /attributs de claim_pending_notifications différents de ceux posés par ce lot/;
const ROLLBACK_ACL = /droits d'exécution de claim_pending_notifications différents de ceux posés par ce lot/;
const ROLLBACK_DRIFTS: Array<{ label: string; mutate: string; check: RegExp }> = [
  { label: "STRICT (RETURNS NULL ON NULL INPUT) -- contre-exemple de Turing", mutate: `alter function ${CLAIM_FN} returns null on null input;`, check: ROLLBACK_ATTR },
  { label: "volatilité STABLE", mutate: `alter function ${CLAIM_FN} stable;`, check: ROLLBACK_ATTR },
  { label: "LEAKPROOF", mutate: `alter function ${CLAIM_FN} leakproof;`, check: ROLLBACK_ATTR },
  { label: "PARALLEL SAFE", mutate: `alter function ${CLAIM_FN} parallel safe;`, check: ROLLBACK_ATTR },
  { label: "COST différent", mutate: `alter function ${CLAIM_FN} cost 500;`, check: ROLLBACK_ATTR },
  { label: "ROWS différent", mutate: `alter function ${CLAIM_FN} rows 7;`, check: ROLLBACK_ATTR },
  { label: "réglage SET supplémentaire (statement_timeout)", mutate: `alter function ${CLAIM_FN} set statement_timeout = '5s';`, check: ROLLBACK_ATTR },
  { label: "SECURITY INVOKER", mutate: `alter function ${CLAIM_FN} security invoker;`, check: ROLLBACK_ATTR },
  { label: "rôle supplémentaire avec EXECUTE -- contre-exemple de Turing", mutate: `create role audit_extra nologin; grant execute on function ${CLAIM_FN} to audit_extra;`, check: ROLLBACK_ACL },
  { label: "droit d'exécution accordé à anon", mutate: `grant execute on function ${CLAIM_FN} to anon;`, check: ROLLBACK_ACL },
  { label: "droit d'exécution accordé à PUBLIC", mutate: `grant execute on function ${CLAIM_FN} to public;`, check: ROLLBACK_ACL },
  { label: "service_role avec option de transmission (WITH GRANT OPTION)", mutate: `grant execute on function ${CLAIM_FN} to service_role with grant option;`, check: ROLLBACK_ACL },
  { label: "propriétaire différent du rôle qui applique le rollback", mutate: `create role audit_other_owner; alter function ${CLAIM_FN} owner to audit_other_owner;`, check: ROLLBACK_ACL },
  { label: "droit d'exécution de service_role retiré", mutate: `revoke execute on function ${CLAIM_FN} from service_role;`, check: ROLLBACK_ACL },
];

for (const drift of ROLLBACK_DRIFTS) {
  test(`[172-PRE-5] rollback -- claim du lot puis ${drift.label} : REFUSÉ (SCANYM_PREDECESSOR_DRIFT) avant toute écriture ; définitions, droits, attributs et décisions inchangés`, async () => {
    const db = await makeDb(true);
    await addOrder(db, "not_required", 0, "order_received", true); // décision « sans paiement » à conserver
    await db.exec(drift.mutate);
    const before = await snapshot(db);
    const decisions = async () =>
      (await db.query<{ id: string; payment_status: string; payment_mode_final: string | null }>("select id, payment_status, payment_mode_final from public.orders order by id")).rows;
    const decisionsBefore = await decisions();
    assert.equal(decisionsBefore[0]!.payment_mode_final, "none", "précondition : une décision définitive existe");

    // Mode 1 : script soumis d'un bloc.
    await assert.rejects(() => db.exec(sql(ROLLBACK)), (e: Error) => /SCANYM_PREDECESSOR_DRIFT/.test(e.message) && drift.check.test(e.message));
    await db.exec("rollback");
    assert.deepEqual(await snapshot(db), before, "bloc unique : aucune mutation (fonction, droits, attributs, rôles, commandes)");

    // Mode 2 : pire cas opérateur -- instruction par instruction, erreurs ignorées.
    const errors = await runIgnoringErrors(db, sql(ROLLBACK));
    assert.ok(errors.some((e) => /SCANYM_PREDECESSOR_DRIFT/.test(e) && drift.check.test(e)), "le refus explicite, par le bon contrôle, est bien levé");
    assert.deepEqual(await snapshot(db), before, "instruction par instruction : aucune mutation");

    // La porte et la colonne de décision sont toujours là ; aucune décision perdue.
    const snap = await snapshot(db);
    const names = snap.functions.map((f: any) => f.proname);
    assert.ok(["notification_send_gate_open", "finalize_order_payment_mode_none", "orders_payment_mode_final_guard"].every((n) => names.includes(n)));
    assert.ok(snap.ordersColumns.some((c: any) => c.column_name === "payment_mode_final"));
    assert.deepEqual(await decisions(), decisionsBefore);
  });
}

test("[172-PRE-6] c_expected_attrs (lot ET rollback) = attributs que PostgreSQL stocke pour N1-A et pour le claim du lot ; la même expression est dans les deux scripts", async () => {
  const FORMAT = "format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s'";
  const lotSql = sql(LOT);
  const rbSql = sql(ROLLBACK);
  assert.ok(lotSql.includes(FORMAT) && rbSql.includes(FORMAT), "même expression de signature dans le lot et le rollback");
  const cLot = lotSql.match(/c_expected_attrs constant text := '([^']+)'/)![1]!;
  const cRb = rbSql.match(/c_expected_attrs constant text := '([^']+)'/)![1]!;
  assert.equal(cLot, cRb, "mêmes attributs attendus : le claim du lot est déclaré comme celui de N1-A");
  const signature = async (db: PGlite) =>
    (await db.query<{ a: string }>(
      `select ${FORMAT},
                p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')) as a
         from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = '${CLAIM_FN}'::regprocedure`)).rows[0]!.a;
  assert.equal(await signature(await makeDb(false)), cLot, "N1-A stocké par PostgreSQL");
  assert.equal(await signature(await makeDb(true)), cRb, "claim du lot stocké par PostgreSQL");
});

// ====================================================================
// T180-R4-01 (contre-audit R4 de Turing sur 9e2fc35, P2) : le rollback ne
// vérifiait QUE le claim. Il supprimait sans regarder les autres objets du lot
// -- notification_send_gate_open, orders_payment_mode_final_guard (+ son
// déclencheur), finalize_order_payment_mode_none, la contrainte et la colonne
// payment_mode_final. Un correctif opérationnel posé depuis l'installation
// (ex. la branche `paid` de la porte) était donc effacé, rollback « réussi ».
//
// Contrat : AVANT toute écriture, chaque objet que le rollback va supprimer est
// comparé à ce que CE lot a posé (corps, attributs, droits, propriétaire pour les
// fonctions ; définition et état pour le déclencheur, la contrainte, la colonne ;
// aucune dépendance inconnue sur la colonne). Écart ou objet absent :
// SCANYM_PREDECESSOR_DRIFT, transaction annulée, rien supprimé, rien modifié,
// aucune décision payment_mode_final perdue.
// ====================================================================
/** Chaque instance PGlite occupe ~250 Mo : on la ferme toujours (sinon la matrice ci-dessous épuise la mémoire). */
async function withDb(applyLot: boolean, fn: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await makeDb(applyLot);
  try { await fn(db); } finally { await db.close(); }
}
const GATE_FN = "public.notification_send_gate_open(uuid, text)";
const GUARD_FN = "public.orders_payment_mode_final_guard()";
const FINALIZE_FN = "public.finalize_order_payment_mode_none(uuid, uuid)";

/** Redéfinit une fonction à partir de sa définition réelle (CREATE OR REPLACE conserve propriétaire et droits). */
async function redefine(db: PGlite, fn: string, edit: (def: string) => string): Promise<void> {
  const def = (await db.query<{ d: string }>(`select pg_get_functiondef('${fn}'::regprocedure) as d`)).rows[0]!.d;
  const next = edit(def);
  assert.notEqual(next, def, "la mutation de corps doit réellement changer la définition");
  await db.exec(next);
}
const commentOnly = (d: string) => d.replace("\nbegin\n", "\nbegin\n  -- correctif local\n");

async function decisionsOf(db: PGlite) {
  return (await db.query<{ id: string; payment_status: string; payment_mode_final: string | null }>(
    "select id, payment_status, payment_mode_final from public.orders order by id")).rows;
}

/** Le rollback doit être refusé (bloc ET instruction par instruction), sans aucune mutation ni décision perdue. */
async function expectRollbackRefused(db: PGlite, check: RegExp, code = "SCANYM_PREDECESSOR_DRIFT"): Promise<void> {
  const before = await snapshot(db);
  const decisionsBefore = await decisionsOf(db);
  assert.equal(decisionsBefore[0]!.payment_mode_final, "none", "précondition : une décision définitive existe");

  await assert.rejects(() => db.exec(sql(ROLLBACK)), (e: Error) => e.message.includes(code) && check.test(e.message));
  await db.exec("rollback");
  assert.deepEqual(await snapshot(db), before, "bloc unique : rien n'est supprimé ni modifié (fonctions, déclencheur, contrainte, colonne, droits, données)");

  const errors = await runIgnoringErrors(db, sql(ROLLBACK));
  assert.ok(errors.some((e) => e.includes(code) && check.test(e)), "le refus explicite, par le bon contrôle, est bien levé");
  assert.deepEqual(await snapshot(db), before, "instruction par instruction (psql sans ON_ERROR_STOP) : rien n'est supprimé ni modifié");
  assert.deepEqual(await decisionsOf(db), decisionsBefore, "aucune décision payment_mode_final perdue");
}

type AuxDrift = { label: string; mutate: (db: PGlite) => Promise<void>; check: RegExp };
const AUX_FUNCTIONS = [
  {
    fn: GATE_FN, short: "notification_send_gate_open", rx: "public\\.notification_send_gate_open\\(uuid, text\\)", flip: "volatile", isSet: false, serviceGrant: false,
    bodies: [
      { label: "branche `paid` changée en false (contre-exemple exact de Turing)", edit: (d: string) => d.replace("when 'paid' then true", "when 'paid' then false") },
      { label: "corps modifié par un simple commentaire", edit: commentOnly },
    ],
  },
  {
    fn: GUARD_FN, short: "orders_payment_mode_final_guard", rx: "public\\.orders_payment_mode_final_guard\\(\\)", flip: "stable", isSet: false, serviceGrant: false,
    bodies: [
      { label: "mode posé à 'none' au lieu de 'online'", edit: (d: string) => d.replace("new.payment_mode_final := 'online';", "new.payment_mode_final := 'none';") },
      { label: "corps modifié par un simple commentaire", edit: commentOnly },
    ],
  },
  {
    fn: FINALIZE_FN, short: "finalize_order_payment_mode_none", rx: "public\\.finalize_order_payment_mode_none\\(uuid, uuid\\)", flip: "stable", isSet: true, serviceGrant: true,
    bodies: [
      { label: "mode finalisé à 'online' au lieu de 'none'", edit: (d: string) => d.replace("set payment_mode_final = 'none'", "set payment_mode_final = 'online'") },
      { label: "corps modifié par un simple commentaire", edit: commentOnly },
    ],
  },
];

const AUX_DRIFTS: AuxDrift[] = [];
for (const f of AUX_FUNCTIONS) {
  const BODY = new RegExp(`le corps de ${f.rx} \\(md5 [0-9a-f]{32}\\) n'est plus celui posé par ce lot`);
  const ATTR = new RegExp(`attributs de ${f.rx} différents de ceux posés par ce lot`);
  const ACL = new RegExp(`droits d'exécution de ${f.rx} différents de ceux posés par ce lot`);
  for (const b of f.bodies) AUX_DRIFTS.push({ label: `${f.short} -- ${b.label}`, mutate: (db) => redefine(db, f.fn, b.edit), check: BODY });
  const attrs: Array<[string, string]> = [
    ["STRICT (RETURNS NULL ON NULL INPUT)", "returns null on null input"],
    ["SECURITY INVOKER", "security invoker"],
    ["search_path différent", "set search_path = public"],
    ["réglage SET supplémentaire (statement_timeout)", "set statement_timeout = '5s'"],
    ["COST différent", "cost 500"],
    ["PARALLEL SAFE", "parallel safe"],
    ["LEAKPROOF", "leakproof"],
    [`volatilité ${f.flip.toUpperCase()}`, f.flip],
  ];
  if (f.isSet) attrs.push(["ROWS différent", "rows 7"]);
  for (const [label, stmt] of attrs) AUX_DRIFTS.push({ label: `${f.short} -- ${label}`, mutate: (db) => db.exec(`alter function ${f.fn} ${stmt};`).then(() => undefined), check: ATTR });
  const acls: Array<[string, string]> = [
    ["rôle supplémentaire avec EXECUTE", `create role audit_extra nologin; grant execute on function ${f.fn} to audit_extra;`],
    ["droit d'exécution accordé à anon", `grant execute on function ${f.fn} to anon;`],
    ["droit d'exécution accordé à authenticated", `grant execute on function ${f.fn} to authenticated;`],
    ["droit d'exécution accordé à PUBLIC", `grant execute on function ${f.fn} to public;`],
    ["service_role avec option de transmission (WITH GRANT OPTION)", `grant execute on function ${f.fn} to service_role with grant option;`],
    ["propriétaire différent du rôle qui applique le rollback", `create role audit_other_owner; alter function ${f.fn} owner to audit_other_owner;`],
  ];
  if (f.serviceGrant) acls.push(["droit d'exécution de service_role retiré", `revoke execute on function ${f.fn} from service_role;`]);
  for (const [label, stmt] of acls) AUX_DRIFTS.push({ label: `${f.short} -- ${label}`, mutate: (db) => db.exec(stmt).then(() => undefined), check: ACL });
}

const TRG = /déclencheur orders_payment_mode_final_guard_trg (est absent|différent de celui posé par ce lot)/;
const TRG_DDL = (timing: string, cols: string, extra = "", fn = "public.orders_payment_mode_final_guard()") =>
  `drop trigger orders_payment_mode_final_guard_trg on public.orders;
   create trigger orders_payment_mode_final_guard_trg ${timing} update ${cols} on public.orders for each row ${extra} execute function ${fn};`;
for (const [label, stmt] of [
  ["déclencheur désactivé (DISABLE TRIGGER)", "alter table public.orders disable trigger orders_payment_mode_final_guard_trg;"],
  ["déclencheur ENABLE ALWAYS (réplica)", "alter table public.orders enable always trigger orders_payment_mode_final_guard_trg;"],
  ["déclencheur recréé AFTER au lieu de BEFORE", TRG_DDL("after", "of payment_status")],
  ["déclencheur recréé sur toutes les colonnes", TRG_DDL("before", "")],
  ["déclencheur recréé avec une clause WHEN", TRG_DDL("before", "of payment_status", "when (old.payment_status is distinct from new.payment_status)")],
  ["déclencheur recréé vers une autre fonction", `create function public.hotfix_guard() returns trigger language plpgsql as $f$ begin return new; end $f$; ${TRG_DDL("before", "of payment_status", "", "public.hotfix_guard()")}`],
  ["déclencheur supprimé", "drop trigger orders_payment_mode_final_guard_trg on public.orders;"],
] as Array<[string, string]>) {
  AUX_DRIFTS.push({ label, mutate: (db) => db.exec(stmt).then(() => undefined), check: TRG });
}

const CHK = /contrainte orders_payment_mode_final_check (est absente|différente de celle posée par ce lot)/;
/** T180-R5-01 : littéraux qu'une normalisation par lower() / suppression d'espaces et de parenthèses confondait avec 'online'. */
const LITERAL_VARIANTS: Record<string, string> = {
  "'ONLINE'": "'ONLINE', 'none'",
  "'on line'": "'on line', 'none'",
  "'on(line)'": "'on(line)', 'none'",
  "'online ' (espace final)": "'online ', 'none'",
  "ordre inversé ('none', 'online')": "'none', 'online'",
};
const constraintWith = (list: string) =>
  `alter table public.orders drop constraint orders_payment_mode_final_check;
   alter table public.orders add constraint orders_payment_mode_final_check check (payment_mode_final is null or payment_mode_final in (${list}));`;
for (const [label, stmt] of [
  ["contrainte élargie (valeur 'manual' autorisée)", `alter table public.orders drop constraint orders_payment_mode_final_check;
     alter table public.orders add constraint orders_payment_mode_final_check check (payment_mode_final is null or payment_mode_final in ('online', 'none', 'manual'));`],
  ["contrainte recréée NOT VALID", `alter table public.orders drop constraint orders_payment_mode_final_check;
     alter table public.orders add constraint orders_payment_mode_final_check check (payment_mode_final is null or payment_mode_final in ('online', 'none')) not valid;`],
  ["contrainte supprimée", "alter table public.orders drop constraint orders_payment_mode_final_check;"],
  ...Object.entries(LITERAL_VARIANTS).map(([name, list]) => [`contrainte recréée avec le littéral ${name} (T180-R5-01)`, constraintWith(list)] as [string, string]),
] as Array<[string, string]>) {
  AUX_DRIFTS.push({ label, mutate: (db) => db.exec(stmt).then(() => undefined), check: CHK });
}

const COL = /colonne orders\.payment_mode_final (est absente|différente de celle posée par ce lot)|objets inconnus dépendent de orders\.payment_mode_final|contrainte orders_payment_mode_final_check différente/;
for (const [label, stmt] of [
  ["index ajouté sur la colonne", "create index orders_pmf_idx on public.orders (payment_mode_final);"],
  ["vue qui dépend de la colonne", "create view public.v_pmf as select id, payment_mode_final from public.orders;"],
  ["politique RLS qui référence la colonne", "alter table public.orders enable row level security; create policy hotfix_pmf on public.orders for select using (payment_mode_final is null);"],
  ["déclencheur ajouté sur la colonne", `create function public.hotfix_col() returns trigger language plpgsql as $f$ begin return new; end $f$;
     create trigger hotfix_col_trg before update of payment_mode_final on public.orders for each row execute function public.hotfix_col();`],
  ["valeur par défaut ajoutée sur la colonne", "alter table public.orders alter column payment_mode_final set default 'online';"],
  ["type de la colonne changé (varchar)", "alter table public.orders alter column payment_mode_final type varchar(10);"],
  ["colonne passée NOT NULL", "alter table public.orders alter column payment_mode_final set not null;"],
] as Array<[string, string]>) {
  AUX_DRIFTS.push({ label, mutate: (db) => db.exec(stmt).then(() => undefined), check: COL });
}

AUX_DRIFTS.push({ label: "finalize_order_payment_mode_none supprimée", mutate: (db) => db.exec(`drop function ${FINALIZE_FN};`).then(() => undefined), check: /public\.finalize_order_payment_mode_none\(uuid, uuid\) est absent/ });
AUX_DRIFTS.push({ label: "orders_payment_mode_final_guard supprimée (avec son déclencheur)", mutate: (db) => db.exec(`drop trigger orders_payment_mode_final_guard_trg on public.orders; drop function ${GUARD_FN};`).then(() => undefined), check: /public\.orders_payment_mode_final_guard\(\) est absent/ });

for (const drift of AUX_DRIFTS) {
  test(`[172-PRE-7] rollback -- objet auxiliaire du lot modifié depuis l'installation : ${drift.label} : REFUSÉ (SCANYM_PREDECESSOR_DRIFT) avant toute suppression ; tout est conservé`, async () => {
    await withDb(true, async (db) => {
      await addOrder(db, "not_required", 0, "order_received", true); // décision « sans paiement » à conserver
      await drift.mutate(db);
      await expectRollbackRefused(db, drift.check);
    });
  });
}

test("[172-PRE-8] contre-exemple EXACT de Turing (T180-R4-01) : branche `paid` de la porte changée après l'installation -> rollback refusé, définition modifiée conservée, porte et colonne présentes, décision intacte", async () => {
  await withDb(true, async (db) => {
    await addOrder(db, "not_required", 0, "order_received", true);
    const def = (await db.query<{ d: string }>(`select pg_get_functiondef('${GATE_FN}'::regprocedure) as d`)).rows[0]!.d;
    assert.ok(def.includes("when 'paid' then true"));
    await db.exec(def.replace("when 'paid' then true", "when 'paid' then false"));
    await assert.rejects(() => db.exec(sql(ROLLBACK)), /SCANYM_PREDECESSOR_DRIFT: le corps de public\.notification_send_gate_open\(uuid, text\)/);
    await db.exec("rollback");
    const after = (await db.query<{ d: string; present: boolean; col: string }>(
      `select pg_get_functiondef('${GATE_FN}'::regprocedure) as d,
              to_regprocedure('public.notification_send_gate_open(uuid, text)') is not null as present,
              (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_mode_final') as col`)).rows[0]!;
    assert.equal(after.present, true, "la porte n'a PAS été supprimée");
    assert.ok(after.d.includes("when 'paid' then false"), "la définition modifiée est toujours en place");
    assert.equal(after.col, "1", "la colonne de décision n'a PAS été supprimée");
    assert.deepEqual((await decisionsOf(db)).map((d) => d.payment_mode_final), ["none"]);
  });
});

const ARCHIVE = "public.orders_payment_mode_final_rollback_archive";
/** SQL de restauration DOCUMENTÉ dans l'en-tête du rollback, extrait du fichier (jamais recopié ici). */
function documentedRestoreSql(): string {
  const lines = sql(ROLLBACK).split("\n").filter((l) => /^--\s{3,}(update public\.orders o|set payment_mode_final = a\.|from public\.orders_payment_mode_final_rollback_archive a|where a\.order_id = o\.id)/.test(l));
  assert.equal(lines.length, 4, "les quatre lignes de la requête de restauration sont dans l'en-tête");
  return lines.map((l) => l.replace(/^--\s+/, "")).join("\n") + ";";
}
async function seedDecisions(db: PGlite) {
  const none = await addOrder(db, "not_required", 0, "order_received", true);          // décision « sans paiement » (none)
  const online = await addOrder(db, "not_required", 0, "order_received");               // décision online posée par la garde...
  await db.query("update public.orders set payment_status = 'paid' where id = $1::uuid", [online.orderId]);
  const undecided = await addOrder(db, "pending", 0, "order_received");                 // aucune décision (porte fermée)
  const dec = await decisionsOf(db);
  const by = (id: string) => dec.find((d) => d.id === id)!;
  assert.equal(by(none.orderId).payment_mode_final, "none");
  assert.equal(by(online.orderId).payment_mode_final, "online");
  assert.equal(by(undecided.orderId).payment_mode_final, null);
  return { none, online, undecided };
}

test("[172-PRE-9] nominal : lot puis rollback restaure TOUS les objets d'avant (aucune fonction, déclencheur, contrainte ni colonne du lot ne subsiste) ; les décisions payment_mode_final sont ARCHIVÉES (T180-R5), pas perdues", async () => {
  await withDb(false, async (db) => {
    const original = await snapshot(db);
    await db.exec(sql(LOT));
    const { none, online, undecided } = await seedDecisions(db);
    await db.exec(sql(ROLLBACK));
    const restored = await snapshot(db);
    assert.deepEqual(restored.auxProcs, [], "aucune fonction auxiliaire ne subsiste");
    assert.deepEqual(restored.triggers, original.triggers);
    assert.deepEqual(restored.constraints.map((c: any) => c.conname), original.constraints.map((c: any) => c.conname));
    assert.deepEqual(restored.ordersColumns, original.ordersColumns, "la colonne payment_mode_final est supprimée : schéma d'avant le lot");
    assert.equal(restored.claim[0]!.body_md5, md5(bodyOf(N1A_CLAIM)));
    assert.deepEqual(restored.allFunctionAcl, original.allFunctionAcl, "droits de toutes les fonctions publiques identiques à l'état d'avant le lot");
    assert.deepEqual(original.archive, [{ t: null }]);
    const rows = (await db.query<{ order_id: string; payment_mode_final: string; payment_status: string; archived_at: string | null }>(`select * from ${ARCHIVE} order by payment_mode_final`)).rows;
    assert.deepEqual(rows.map((r) => [r.order_id, r.payment_mode_final, r.payment_status]).sort(),
      [[online.orderId, "online", "paid"], [none.orderId, "none", "not_required"]].sort(), "les deux décisions sont archivées avec le statut de paiement du moment");
    assert.ok(rows.every((r) => r.archived_at), "date d'archivage renseignée");
    assert.ok(!rows.some((r) => r.order_id === undecided.orderId), "une commande sans décision n'est pas archivée");
  });
});

test("[172-PRE-9b] l'archive des décisions n'est lisible que par son propriétaire : RLS activée, aucun droit pour PUBLIC, anon, authenticated ni service_role, MÊME avec des privilèges par défaut de plateforme sur les tables", async () => {
  await withDb(false, async (db) => {
    await db.exec("alter default privileges in schema public grant all on tables to anon, authenticated, service_role;");
    await db.exec(sql(LOT));
    await seedDecisions(db);
    await db.exec(sql(ROLLBACK));
    const info = (await db.query<{ acl: string | null; rls: boolean }>(`select c.relacl::text as acl, c.relrowsecurity as rls from pg_class c where c.oid = '${ARCHIVE}'::regclass`)).rows[0]!;
    assert.equal(info.rls, true, "RLS activée (sans politique)");
    assert.match(String(info.acl), /^\{[^,]+=[a-zA-Z]+\/[^,]+\}$/, `une seule entrée de droits (le propriétaire) : ${info.acl}`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const priv of ["select", "insert", "update", "delete"]) {
        const r = await db.query<{ ok: boolean }>(`select has_table_privilege('${role}', '${ARCHIVE}', '${priv}') as ok`);
        assert.equal(r.rows[0]!.ok, false, `${role} n'a pas ${priv}`);
      }
    }
    assert.equal((await db.query(`select 1 from pg_policies where schemaname = 'public' and tablename = 'orders_payment_mode_final_rollback_archive'`)).rows.length, 0, "aucune politique");
  });
});

test("[172-PRE-9c] les décisions archivées se RESTAURENT après réinstallation du lot avec la requête documentée dans l'en-tête : mêmes décisions, payment_status inchangé, commande sans décision toujours sans décision", async () => {
  await withDb(false, async (db) => {
    await db.exec(sql(LOT));
    const { none, online, undecided } = await seedDecisions(db);
    const before = await decisionsOf(db);
    await db.exec(sql(ROLLBACK));
    await db.exec(sql(LOT));                         // réinstallation : toutes les décisions repartent à NULL
    assert.ok((await decisionsOf(db)).every((d) => d.payment_mode_final === null), "précondition : après réinstallation, plus aucune décision");
    await db.exec(documentedRestoreSql());
    const after = await decisionsOf(db);
    assert.deepEqual(after, before, "décisions ET payment_status strictement identiques à ceux d'avant le rollback");
    assert.equal(after.find((d) => d.id === none.orderId)!.payment_mode_final, "none");
    assert.equal(after.find((d) => d.id === online.orderId)!.payment_mode_final, "online");
    assert.equal(after.find((d) => d.id === undecided.orderId)!.payment_mode_final, null);
  });
});

test("[172-PRE-9d] une archive qui existe déjà (rollback précédent) n'est JAMAIS écrasée : rollback refusé (SCANYM_ROLLBACK_PREFLIGHT_FAILED), tout est conservé", async () => {
  await withDb(true, async (db) => {
    await addOrder(db, "not_required", 0, "order_received", true);
    await db.exec(`create table ${ARCHIVE} (order_id uuid primary key, payment_mode_final text not null, payment_status text, archived_at timestamptz not null default now());
                   insert into ${ARCHIVE} (order_id, payment_mode_final) values (gen_random_uuid(), 'none');`);
    const keep = (await db.query(`select * from ${ARCHIVE}`)).rows;
    await expectRollbackRefused(db, /orders_payment_mode_final_rollback_archive existe déjà/, "SCANYM_ROLLBACK_PREFLIGHT_FAILED");
    assert.deepEqual((await db.query(`select * from ${ARCHIVE}`)).rows, keep, "l'archive existante est intacte");
  });
});

test("[172-PRE-9e] T180-R5-01 : les littéraux 'ONLINE', 'on line', 'on(line)' sont de VRAIES contraintes différentes (la contrainte nominale accepte 'online', chaque variante la refuse) ; le rollback les refuse toutes, sans rien changer", async () => {
  for (const name of ["'ONLINE'", "'on line'", "'on(line)'"]) {
    await withDb(true, async (db) => {
      await addOrder(db, "not_required", 0, "order_received", true);
      await db.exec("begin; update public.orders set payment_mode_final = 'online'; rollback;");   // contrainte nominale : acceptée
      await db.exec(constraintWith(LITERAL_VARIANTS[name]!));
      await assert.rejects(() => db.exec("update public.orders set payment_mode_final = 'online'"), /orders_payment_mode_final_check/, `${name} : la variante REFUSE 'online' (différence sémantique)`);
      await db.exec("rollback");
      await expectRollbackRefused(db, CHK);
    });
  }
});

test("[172-PRE-9f] une recréation de la contrainte qui ne diffère que par la PRÉSENTATION (espaces, casse des mots-clés, parenthèses, forme = ANY (ARRAY[...])) donne la même définition PostgreSQL : le rollback est ACCEPTÉ", async () => {
  await withDb(true, async (db) => {
    await addOrder(db, "not_required", 0, "order_received", true);
    await db.exec(`alter table public.orders drop constraint orders_payment_mode_final_check;
      alter table public.orders add constraint orders_payment_mode_final_check
        CHECK ((PAYMENT_MODE_FINAL   IS NULL) OR ((payment_mode_final) = ANY (ARRAY [ 'online' ,'none' ])));`);
    await db.exec(sql(ROLLBACK));
    assert.deepEqual((await snapshot(db)).auxProcs, [], "rollback complet");
  });
});

test("[172-PRE-10] nominal avec privilèges par défaut de la plateforme (service_role reçoit EXECUTE sur les fonctions créées) : le rollback n'est PAS refusé à tort ; mais tout AUTRE bénéficiaire l'est", async () => {
  const hostedLike = async () => {
    const db = await makeDb(false);
    await db.exec("alter default privileges in schema public grant execute on functions to service_role;");
    await db.exec(sql(LOT));
    return db;
  };
  const acl = async (db: PGlite) => (await db.query<{ acl: string }>(`select p.proacl::text as acl from pg_proc p where p.oid = '${GATE_FN}'::regprocedure`)).rows[0]!.acl;
  const nominal = await hostedLike();
  try {
    assert.match(await acl(nominal), /service_role=X\//, "précondition : service_role a reçu EXECUTE par privilège par défaut");
    await nominal.exec(sql(ROLLBACK));
    assert.equal((await snapshot(nominal)).auxProcs.length, 0, "rollback accepté et complet");
  } finally { await nominal.close(); }

  const withExtra = await hostedLike();
  try {
    await addOrder(withExtra, "not_required", 0, "order_received", true);
    await withExtra.exec(`create role audit_extra nologin; grant execute on function ${GATE_FN} to audit_extra;`);
    await expectRollbackRefused(withExtra, new RegExp("droits d'exécution de public\\.notification_send_gate_open\\(uuid, text\\) différents"));
  } finally { await withExtra.close(); }
});

test("[172-PRE-11] les empreintes auxiliaires du rollback (corps, attributs, droits, déclencheur, contrainte, colonne) sont celles que PostgreSQL stocke après l'installation RÉELLE du lot", async () => {
  const rb = sql(ROLLBACK);
  const FORMAT = "format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s'";
  assert.ok(rb.includes(FORMAT), "même expression de signature d'attributs que le lot et le claim");
  const rows = [...rb.matchAll(/\('(public\.[^']+)',\s*'([0-9a-f]{32})',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*(true|false)\)/g)];
  assert.equal(rows.length, 3, "trois fonctions auxiliaires déclarées");
  const db = await makeDb(true);
  try {
  for (const [, sig, md5c, args, result, attrs] of rows) {
    const got = (await db.query<{ m: string; a: string; r: string; t: string }>(
      `select md5(replace(p.prosrc, E'\r', '')) as m, pg_get_function_arguments(p.oid) as a, pg_get_function_result(p.oid) as r,
              ${FORMAT}, p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile, p.proparallel, p.proretset, p.procost, p.prorows,
              p.prosupport::oid, p.provariadic, p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')) as t
         from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = '${sig}'::regprocedure`)).rows[0]!;
    assert.equal(got.m, md5c, `${sig} : md5 du corps`);
    assert.equal(got.a, args, `${sig} : arguments`);
    assert.equal(got.r, result, `${sig} : type de retour`);
    assert.equal(got.t, attrs, `${sig} : attributs`);
  }
  const unq = (s: string) => s.replaceAll("''", "'");
  const constant = (name: string) => unq(rb.match(new RegExp(`${name}\\s+constant text := '((?:[^']|'')*)'`))![1]!);
  const one = async (text: string) => (await db.query<{ fp: string }>(text)).rows[0]!.fp;
  assert.equal(await one(`select format('tgtype=%s;enabled=%s;function_is_guard=%s;columns=%s;has_when=%s;nargs=%s;internal=%s;deferrable=%s;initdeferred=%s;constraint=%s;oldtable=%s;newtable=%s', t.tgtype, t.tgenabled, t.tgfoid = to_regprocedure('public.orders_payment_mode_final_guard()'), (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)), t.tgqual is not null, t.tgnargs, t.tgisinternal, t.tgdeferrable, t.tginitdeferred, t.tgconstraint, coalesce(t.tgoldtable, ''), coalesce(t.tgnewtable, '')) as fp from pg_trigger t where t.tgrelid = 'public.orders'::regclass and t.tgname = 'orders_payment_mode_final_guard_trg'`), constant("c_trigger_fp"));
  assert.equal(await one(`select format('type=%s;validated=%s;deferrable=%s;initdeferred=%s;def=%s', c.contype, c.convalidated, c.condeferrable, c.condeferred, pg_get_constraintdef(c.oid)) as fp from pg_constraint c where c.conrelid = 'public.orders'::regclass and c.conname = 'orders_payment_mode_final_check'`), constant("c_constraint_fp"));
  assert.equal(await one(`select format('type=%s;notnull=%s;hasdef=%s;generated=%s;identity=%s;dims=%s', format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity, a.attndims) as fp from pg_attribute a where a.attrelid = 'public.orders'::regclass and a.attname = 'payment_mode_final' and not a.attisdropped`), constant("c_column_fp"));
  } finally { await db.close(); }
});
