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
    functions: await q(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`),
    ordersColumns: await q(`select column_name from information_schema.columns where table_schema='public' and table_name='orders' order by 1`),
    orders: await q(`select id, payment_status from public.orders order by id`),
    outbox: await q(`select id, status, attempt_count, claim_token from public.notification_outbox order by id`),
    txOpen: await q(`select (select count(*) from pg_stat_activity) >= 0 as ok`),
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
