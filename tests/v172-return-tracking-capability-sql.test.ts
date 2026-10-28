import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// ====================================================================
// ISSUE #172 — RETURN TRACKING CAPABILITY v1 : le SQL RÉEL exécuté dans
// PGlite (aucune base hébergée, aucune clé, aucun réseau).
//
// Le lot v3.1 (suivi par capacité) est exécuté TEL QUEL, puis le lot
// DRAFT-lot-return-tracking-capability-v1.sql par-dessus.
//
//   [172-CAP-1]  PREUVE de la cause : le lien legacy est à usage unique.
//   [172-CAP-2]  la capacité de retour est RÉUTILISABLE (autre navigateur,
//                rechargement, autre appareil).
//   [172-CAP-3/4] compteur DISTINCT de celui des e-mails, dans les deux
//                sens : la page de retour ne peut jamais empêcher
//                l'e-mail de confirmation de partir, et inversement.
//   [172-CAP-5]  mauvaise commande / mauvais secret / expirée : vide.
//   [172-CAP-6]  droits d'exécution : service_role uniquement.
//   [172-CAP-7]  double application refusée ; [172-CAP-8] retour arrière.
// ====================================================================

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const V31 = "DRAFT-lot-customer-tracking-capability-v3-1.sql";
const LOT = "DRAFT-lot-return-tracking-capability-v1.sql";
const ROLLBACK = "DRAFT-lot-return-tracking-capability-v1-rollback.sql";

async function makeDb(applyLot = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.orders (
      id uuid primary key default gen_random_uuid(),
      public_token uuid not null default gen_random_uuid(),
      total numeric not null default 10, currency text not null default 'EUR',
      status text not null default 'new', service_mode text not null default 'pickup',
      order_number bigint not null default 1,
      created_at timestamptz not null default now(),
      accepted_at timestamptz, preparing_at timestamptz, ready_at timestamptz,
      completed_at timestamptz, rejected_at timestamptz, cancelled_at timestamptz
    );
    create table public.order_invoice_request (order_id uuid);
    -- Prérequis du lot v3.1 : get_order_tracking(uuid, uuid) à 13 colonnes.
    create function public.get_order_tracking(p_order_id uuid, p_public_token uuid)
    returns table (a text, b text, c text, d text, e text, f text, g text, h text, i text, j text, k text, l text, m text)
    language sql as $$ select null::text, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::text, null::text, null::text, null::text, null::text where false $$;
  `);
  await db.exec(sql(V31));
  if (applyLot) await db.exec(sql(LOT));
  return db;
}

async function newOrder(db: PGlite): Promise<{ id: string; token: string }> {
  const r = await db.query<{ id: string; public_token: string }>(
    "insert into public.orders default values returning id, public_token"
  );
  return { id: r.rows[0]!.id, token: r.rows[0]!.public_token };
}

type Cap = { capability_id: string; capability_secret: string };
const upgrade = async (db: PGlite, id: string, token: string) =>
  (await db.query<Cap>("select * from public.upgrade_legacy_tracking_capability($1::uuid, $2::uuid)", [id, token])).rows;
const issueReturn = async (db: PGlite, id: string) =>
  (await db.query<Cap>("select * from public.issue_order_return_tracking_capability($1::uuid)", [id])).rows;
const issueEmail = async (db: PGlite, id: string) =>
  (await db.query<Cap>("select * from public.issue_order_email_tracking_capability($1::uuid)", [id])).rows;
const readTracking = async (db: PGlite, orderId: string, capId: string, secret: string) =>
  (await db.query("select * from public.get_order_tracking_by_capability($1::uuid, $2::uuid, $3)", [orderId, capId, secret])).rows;

test("[172-CAP-1] CAUSE : le lien legacy est à usage unique -- le 2e échange est refusé, la capacité de retour non", async () => {
  const db = await makeDb();
  const o = await newOrder(db);

  const first = await upgrade(db, o.id, o.token);
  assert.equal(first.length, 1, "1er échange : capacité émise");
  const replay = await upgrade(db, o.id, o.token);
  assert.equal(replay.length, 0, "2e échange (autre navigateur / lien déjà ouvert) : ensemble vide => « lien invalide »");

  // Une capacité de retour émise APRÈS ce rejeu fonctionne, elle.
  const ret = await issueReturn(db, o.id);
  assert.equal(ret.length, 1);
  assert.equal((await readTracking(db, o.id, ret[0]!.capability_id, ret[0]!.capability_secret)).length, 1);
});

test("[172-CAP-2] la capacité de retour est RÉUTILISABLE : lectures répétées, sans rotation ni consommation", async () => {
  const db = await makeDb();
  const o = await newOrder(db);
  const [cap] = await issueReturn(db, o.id);
  for (let i = 0; i < 5; i++) {
    const rows = await readTracking(db, o.id, cap!.capability_id, cap!.capability_secret);
    assert.equal(rows.length, 1, `lecture n°${i + 1}`);
  }
  assert.match(cap!.capability_secret, /^[0-9a-f]{64}$/);
  const stored = await db.query<{ kind: string; has_hash: boolean; bounded: boolean }>(
    `select kind, secret_hash is not null as has_hash, expires_at > now() as bounded
       from public.order_tracking_capabilities where id = $1::uuid`, [cap!.capability_id]);
  assert.deepEqual(stored.rows[0], { kind: "return", has_hash: true, bounded: true });
  // Le secret n'est jamais stocké en clair.
  const leak = await db.query(
    "select 1 from public.order_tracking_capabilities where encode(secret_hash, 'hex') = $1", [cap!.capability_secret]);
  assert.equal(leak.rows.length, 0);
});

test("[172-CAP-3] 16 capacités de retour épuisent le plafond RETOUR, jamais celui des e-mails", async () => {
  const db = await makeDb();
  const o = await newOrder(db);
  for (let i = 0; i < 16; i++) assert.equal((await issueReturn(db, o.id)).length, 1, `retour n°${i + 1}`);
  assert.equal((await issueReturn(db, o.id)).length, 0, "17e : plafond retour atteint -> repli legacy côté application");
  assert.equal((await issueEmail(db, o.id)).length, 1, "l'e-mail de confirmation peut TOUJOURS obtenir son lien");
});

test("[172-CAP-4] 16 capacités d'e-mail n'empêchent pas la page de retour d'émettre la sienne", async () => {
  const db = await makeDb();
  const o = await newOrder(db);
  for (let i = 0; i < 16; i++) assert.equal((await issueEmail(db, o.id)).length, 1);
  assert.equal((await issueEmail(db, o.id)).length, 0);
  assert.equal((await issueReturn(db, o.id)).length, 1);
});

test("[172-CAP-5] mauvaise commande, mauvais secret, capacité expirée, NULL : ensemble vide identique", async () => {
  const db = await makeDb();
  const a = await newOrder(db);
  const b = await newOrder(db);
  const [cap] = await issueReturn(db, a.id);

  assert.equal((await readTracking(db, b.id, cap!.capability_id, cap!.capability_secret)).length, 0, "capacité d'une autre commande");
  assert.equal((await readTracking(db, a.id, cap!.capability_id, "0".repeat(64))).length, 0, "mauvais secret");
  assert.equal((await issueReturn(db, "00000000-0000-4000-8000-000000000000")).length, 0, "commande inexistante");

  await db.query("update public.order_tracking_capabilities set expires_at = now() - interval '1 second' where id = $1::uuid", [cap!.capability_id]);
  assert.equal((await readTracking(db, a.id, cap!.capability_id, cap!.capability_secret)).length, 0, "expirée");
});

test("[172-CAP-6] droits : seule service_role peut émettre une capacité de retour", async () => {
  const db = await makeDb();
  const priv = async (role: string) =>
    (await db.query<{ ok: boolean }>(
      "select has_function_privilege($1, 'public.issue_order_return_tracking_capability(uuid)', 'execute') as ok", [role])).rows[0]!.ok;
  assert.equal(await priv("anon"), false);
  assert.equal(await priv("authenticated"), false);
  assert.equal(await priv("public"), false);
  assert.equal(await priv("service_role"), true);
  // Table toujours fermée à tous les rôles applicatifs.
  const t = await db.query<{ ok: boolean }>(
    "select has_table_privilege('service_role', 'public.order_tracking_capabilities', 'select') as ok");
  assert.equal(t.rows[0]!.ok, false);
});

test("[172-CAP-7] double application refusée (échec fermé)", async () => {
  const db = await makeDb();
  await assert.rejects(() => db.exec(sql(LOT)), /déjà appliqué|already exists/);
});

test("[172-CAP-8] retour arrière : capacités 'return' supprimées, e-mail et legacy intacts, contraintes v3.1 restaurées", async () => {
  const db = await makeDb();
  const o = await newOrder(db);
  const [legacy] = await upgrade(db, o.id, o.token);
  const [email] = await issueEmail(db, o.id);
  await issueReturn(db, o.id);

  await db.exec(sql(ROLLBACK));

  const kinds = await db.query<{ kind: string }>("select kind from public.order_tracking_capabilities order by kind");
  assert.deepEqual(kinds.rows.map((r) => r.kind), ["email", "legacy_upgrade"]);
  assert.equal((await readTracking(db, o.id, email!.capability_id, email!.capability_secret)).length, 1);
  assert.equal((await readTracking(db, o.id, legacy!.capability_id, legacy!.capability_secret)).length, 1);
  assert.equal(
    (await db.query("select 1 from pg_proc where proname = 'issue_order_return_tracking_capability'")).rows.length, 0);
  await assert.rejects(
    () => db.query("insert into public.order_tracking_capabilities (order_id, kind, secret_hash, claimed_at, expires_at) values ($1::uuid, 'return', sha256('x'::bytea), now(), now())", [o.id]),
    /order_tracking_capabilities_(kind|email_bounded)/);
});

test("[172-CAP-9] le lot ne redéfinit AUCUNE fonction de lecture ni d'échange du lot v3.1", () => {
  const lot = sql(LOT);
  for (const fn of ["get_order_tracking_by_capability", "upgrade_legacy_tracking_capability", "issue_order_email_tracking_capability"]) {
    assert.equal(new RegExp(`(create|replace)[^;]*function public\\.${fn}`, "i").test(lot), false, fn);
  }
});
