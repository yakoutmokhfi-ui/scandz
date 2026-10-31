import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

// ====================================================================
// MERCHANT SMTP v1 R1 (audit PR #196) -- LE SQL RÉEL dans PGlite.
//
// Avant R1 ce fichier rejouait un claim SIMULÉ : il ne prouvait rien sur le
// prédécesseur réel (constat A196-10). Il installe maintenant, TELS QUELS :
//   1. la table notification_outbox et le claim extraits du lot N1-A ;
//   2. le lot ORDER_RECEIVED PAYMENT GATE (#180) ;
//   3. le lot SMTP de cette PR ;
// et prouve :
//   A196-02  le rollback restaure le claim de #180 OCTET POUR OCTET (corps, attributs,
//            ACL, commentaire) et le rollback de #180 reste possible ensuite ;
//   A196-03  pré-vol EXACT du prédécesseur (STRICT, EXECUTE en trop, corps modifié,
//            #180 absent) : refus explicite, jamais de normalisation silencieuse ;
//   + sémantique du claim (coffre activé ET opt-in marchand), porte de paiement conservée,
//     privilèges du coffre, contraintes d'état d'erreur.
// Aucun réseau, aucune base hébergée, données synthétiques.
// ====================================================================

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const G180 = sql("DRAFT-lot-order-received-payment-gate-v1.sql");
const RB180 = sql("DRAFT-lot-order-received-payment-gate-v1-rollback.sql");
const SMTP = sql("DRAFT-lot-merchant-smtp-notifications-v1.sql");
const RBSMTP = sql("DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql");

const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
const N1A_CLAIM = N1A.match(/create function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];
const CLAIM = "public.claim_pending_notifications(integer,integer)";
const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");

/** Corps ($$...$$) du `create [or replace] function public.claim_pending_notifications` d'un fichier SQL. */
function claimBodyOf(file: string): string {
  const m = file.match(/create (?:or replace )?function public\.claim_pending_notifications\([\s\S]*?as \$\$([\s\S]*?)\$\$;/);
  assert.ok(m, "définition du claim introuvable");
  return m![1]!;
}
const BODY_180_MD5 = md5(claimBodyOf(G180));
const BODY_SMTP_MD5 = md5(claimBodyOf(SMTP));

async function makeDb(opts: { g180?: boolean; smtp?: boolean; afterPredecessor?: string } = {}) {
  const { g180 = true, smtp = true, afterPredecessor = "" } = opts;
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role audit_extra;
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
      restaurant_id uuid primary key, email_enabled boolean not null default false,
      sender_name text, sender_email text, reply_to text, default_locale text default 'fr'
    );
    create function public.touch_updated_at() returns trigger language plpgsql as $f$ begin new.updated_at = now(); return new; end $f$;
    ${N1A_TABLE}
    ${N1A_CLAIM}
    revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
    grant execute on function public.claim_pending_notifications(integer, integer) to service_role;
  `);
  if (g180) await db.exec(G180);
  if (afterPredecessor) await db.exec(afterPredecessor);
  if (smtp) await db.exec(SMTP);
  return db;
}

interface ClaimState { md5: string; attrs: string; acl: string; comment: string | null; hasVault: boolean; hasGate: boolean }
async function claimState(db: PGlite): Promise<ClaimState> {
  const r = await db.query<{ md5: string; attrs: string; acl: string; comment: string | null; has_vault: boolean; has_gate: boolean }>(`
    select md5(replace(prosrc, E'\\r', '')) as md5,
           concat_ws(';', prosecdef, proisstrict, provolatile, proparallel, proretset, prorettype, pronargs, pronargdefaults, proconfig::text, proowner::regrole::text) as attrs,
           coalesce(proacl::text, '-') as acl,
           obj_description(oid, 'pg_proc') as comment,
           to_regclass('public.merchant_email_provider_config') is not null as has_vault,
           to_regprocedure('public.notification_send_gate_open(uuid,text)') is not null as has_gate
    from pg_proc where oid = '${CLAIM}'::regprocedure`);
  const row = r.rows[0]!;
  return { md5: row.md5, attrs: row.attrs, acl: row.acl, comment: row.comment, hasVault: row.has_vault, hasGate: row.has_gate };
}

async function addRestaurant(db: PGlite, o: { optIn?: boolean; vault?: "enabled" | "disabled" | "none"; payment?: string; ageSeconds?: number }) {
  const { optIn = true, vault = "enabled", payment = "paid", ageSeconds = 0 } = o;
  const rest = (await db.query<{ id: string }>("insert into public.restaurants default values returning id")).rows[0]!.id;
  await db.query("insert into public.merchant_notification_profile(restaurant_id, email_enabled, sender_name, sender_email) values ($1::uuid, $2, 'Resto', 'contact@resto.example')", [rest, optIn]);
  if (vault !== "none") {
    await db.query(
      `insert into public.merchant_email_provider_config(restaurant_id, host, port, username, enabled, secret_ciphertext, secret_iv, secret_auth_tag)
       values ($1::uuid, 'smtp.ionos.fr', 465, 'contact@resto.example', $2, 'c', 'i', 't')`, [rest, vault === "enabled"]);
  }
  const order = await db.query<{ id: string }>(
    "insert into public.orders(restaurant_id, payment_status) values ($1::uuid, $2) returning id", [rest, payment]);
  const outbox = await db.query<{ id: string }>(
    `insert into public.notification_outbox(restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status, created_at)
     values ($1::uuid, $2::uuid, 'order_received', 'client@example.test', 'fr', '{}'::jsonb, 'pending', now() - make_interval(secs => $3::int)) returning id`,
    [rest, order.rows[0]!.id, ageSeconds]);
  return { restaurant: rest, outboxId: outbox.rows[0]!.id };
}
const claim = async (db: PGlite, batch = 10) =>
  (await db.query<{ outbox_id: string }>("select outbox_id from public.claim_pending_notifications($1, 60)", [batch])).rows.map((r) => r.outbox_id);
const statusOf = async (db: PGlite, id: string) =>
  (await db.query<{ status: string; attempt_count: number; claim_token: string | null }>("select status, attempt_count, claim_token from public.notification_outbox where id = $1::uuid", [id])).rows[0]!;

async function refused(db: PGlite, script: string, expected: RegExp) {
  await assert.rejects(() => db.exec(script), expected);
  await db.exec("rollback");
}

// --------------------------------------------------------------------
test("empreintes : le lot SMTP épingle le corps du claim de #180 et pose le corps qu'il annonce", async () => {
  assert.equal(BODY_180_MD5, "16d75b38372fd5dfd0ca1a4e20dfa3a8");
  assert.match(SMTP, new RegExp(`c_expected_body_md5 constant text := '${BODY_180_MD5}'`));
  assert.match(RBSMTP, new RegExp(`'${BODY_180_MD5}'`), "le rollback restaure le corps de #180");
  assert.match(SMTP, new RegExp(`'${BODY_SMTP_MD5}'`), "le post-contrôle épingle le corps du nouveau claim");
  assert.match(RBSMTP, new RegExp(`'${BODY_SMTP_MD5}'`), "le rollback épingle le corps du claim SMTP");

  const base = await makeDb({ smtp: false });
  assert.equal((await claimState(base)).md5, BODY_180_MD5, "#180 pose bien le corps épinglé");
  await base.close();
  const full = await makeDb();
  assert.equal((await claimState(full)).md5, BODY_SMTP_MD5, "le lot SMTP pose bien le corps épinglé");
  await full.close();
});

test("claim : seuls les commerces avec coffre ACTIVÉ et opt-in marchand sont réclamés ; les autres restent intacts", async () => {
  const db = await makeDb();
  const a = await addRestaurant(db, {});
  const noVault = await addRestaurant(db, { vault: "none" });
  const optOut = await addRestaurant(db, { optIn: false });
  const disabled = await addRestaurant(db, { vault: "disabled" });
  assert.deepEqual(await claim(db), [a.outboxId]);
  assert.equal((await statusOf(db, a.outboxId)).status, "processing");
  for (const other of [noVault, optOut, disabled]) {
    assert.deepEqual(await statusOf(db, other.outboxId), { status: "pending", attempt_count: 0, claim_token: null });
  }
  await db.close();
});

test("claim : la porte de paiement de #180 est CONSERVÉE (commande en attente de paiement => jamais réclamée)", async () => {
  const db = await makeDb();
  const unpaid = await addRestaurant(db, { payment: "required" });
  const pending = await addRestaurant(db, { payment: "pending" });
  const paid = await addRestaurant(db, { payment: "paid" });
  assert.deepEqual(await claim(db), [paid.outboxId]);
  for (const row of [unpaid, pending]) assert.equal((await statusOf(db, row.outboxId)).status, "pending");
  await db.close();
});

test("claim : des lignes non éligibles plus anciennes n'affament pas le lot (le filtre précède la limite)", async () => {
  const db = await makeDb();
  for (let i = 0; i < 4; i++) await addRestaurant(db, { vault: "none", ageSeconds: 3600 + i });
  const eligible = await addRestaurant(db, {});
  assert.deepEqual(await claim(db, 1), [eligible.outboxId]);
  await db.close();
});

test("coffre : anon/authenticated sans accès, service_role sans DELETE, RLS activée, claim réservé à service_role", async () => {
  const db = await makeDb();
  const grants = await db.query<Record<string, boolean>>(`
    select has_table_privilege('anon','public.merchant_email_provider_config','select') as anon_select,
           has_table_privilege('authenticated','public.merchant_email_provider_config','select') as auth_select,
           has_table_privilege('authenticated','public.merchant_email_provider_config','update') as auth_update,
           has_table_privilege('service_role','public.merchant_email_provider_config','select') as svc_select,
           has_table_privilege('service_role','public.merchant_email_provider_config','insert') as svc_insert,
           has_table_privilege('service_role','public.merchant_email_provider_config','update') as svc_update,
           has_table_privilege('service_role','public.merchant_email_provider_config','delete') as svc_delete,
           (select relrowsecurity from pg_class where oid = 'public.merchant_email_provider_config'::regclass) as rls,
           has_function_privilege('anon','${CLAIM}','execute') as anon_claim,
           has_function_privilege('authenticated','${CLAIM}','execute') as auth_claim,
           has_function_privilege('service_role','${CLAIM}','execute') as svc_claim`);
  assert.deepEqual(grants.rows[0], {
    anon_select: false, auth_select: false, auth_update: false, svc_select: true, svc_insert: true, svc_update: true, svc_delete: false,
    rls: true, anon_claim: false, auth_claim: false, svc_claim: true,
  });
  await db.close();
});

test("coffre : contraintes (port 465, hôte minuscule, activé => secret, état d'erreur cohérent et fermé)", async () => {
  const db = await makeDb();
  const rest = (await db.query<{ id: string }>("insert into public.restaurants default values returning id")).rows[0]!.id;
  const insert = (cols: string, vals: string) => db.query(`insert into public.merchant_email_provider_config(restaurant_id, ${cols}) values ('${rest}', ${vals})`);
  const base = "host, port, username";
  await assert.rejects(() => insert(base, "'smtp.ionos.fr', 587, 'a@b.fr'"));
  await assert.rejects(() => insert(base, "'SMTP.IONOS.FR', 465, 'a@b.fr'"));
  await assert.rejects(() => insert(base, "'127.0.0.1', 465, 'a@b.fr'"));
  await assert.rejects(() => insert(`${base}, enabled`, "'smtp.ionos.fr', 465, 'a@b.fr', true"), /enabled_requires_secret/);
  await insert(`${base}, secret_ciphertext, secret_iv, secret_auth_tag`, "'smtp.ionos.fr', 465, 'a@b.fr', 'c', 'i', 't'");
  const update = (set: string) => db.query(`update public.merchant_email_provider_config set ${set} where restaurant_id = '${rest}'`);
  await assert.rejects(() => update("last_error_class = 'PROVIDER_AUTHENTICATION_FAILED'"), /last_error_consistent/);
  await assert.rejects(() => update("last_error_at = now()"), /last_error_consistent/);
  await assert.rejects(() => update("last_error_class = 'boom: 535 bad password', last_error_at = now()"), /last_error_class_format/);
  await update("last_error_class = 'PROVIDER_AUTHENTICATION_FAILED', last_error_at = now()");
  await update("last_error_class = null, last_error_at = null");
  await db.close();
});

// --------------------------------------------------------------------
// A196-03 : pré-vol exact du prédécesseur
// --------------------------------------------------------------------
test("A196-03 : double application refusée sans mutation", async () => {
  const db = await makeDb();
  const before = await claimState(db);
  await refused(db, SMTP, /SCANYM_SCHEMA_DRIFT/);
  assert.deepEqual(await claimState(db), before);
  await db.close();
});

test("A196-03 : claim de #180 devenu STRICT => lot SMTP REFUSÉ (jamais normalisé), aucune table créée", async () => {
  const db = await makeDb({ smtp: false, afterPredecessor: "alter function public.claim_pending_notifications(integer,integer) returns null on null input;" });
  const before = await claimState(db);
  await refused(db, SMTP, /SCANYM_PREDECESSOR_DRIFT/);
  const after = await claimState(db);
  assert.deepEqual(after, before);
  assert.equal(after.hasVault, false);
  assert.match(after.attrs, /^t;t;v;/, "SECURITY DEFINER + STRICT conservés tels quels");
  await db.close();
});

test("A196-03 : bénéficiaire EXECUTE en plus => lot SMTP REFUSÉ (le droit n'est ni conservé en silence ni révoqué)", async () => {
  const db = await makeDb({ smtp: false, afterPredecessor: "grant execute on function public.claim_pending_notifications(integer,integer) to audit_extra;" });
  const before = await claimState(db);
  assert.match(before.acl, /audit_extra=X\//);
  await refused(db, SMTP, /SCANYM_PREDECESSOR_DRIFT/);
  assert.deepEqual(await claimState(db), before);
  await db.close();
});

test("A196-03 : corps du claim modifié depuis #180 => lot SMTP REFUSÉ", async () => {
  const drifted = N1A_CLAIM.replace("create function", "create or replace function").replace(/limit /i, "limit 1 + ");
  const db = await makeDb({ smtp: false, afterPredecessor: `${drifted}
    revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
    grant execute on function public.claim_pending_notifications(integer, integer) to service_role;` });
  const before = await claimState(db);
  assert.notEqual(before.md5, BODY_180_MD5);
  await refused(db, SMTP, /SCANYM_PREDECESSOR_DRIFT/);
  assert.deepEqual(await claimState(db), before);
  await db.close();
});

test("A196-03 : #180 absent (N1-A seul) => lot SMTP REFUSÉ", async () => {
  const db = await makeDb({ g180: false, smtp: false });
  const before = await claimState(db);
  await refused(db, SMTP, /SCANYM_SCHEMA_DRIFT|SCANYM_PREDECESSOR_DRIFT/);
  assert.deepEqual(await claimState(db), before);
  assert.equal(before.hasVault, false);
  await db.close();
});

// --------------------------------------------------------------------
// A196-02 : rollback qui restaure #180 octet pour octet
// --------------------------------------------------------------------
test("A196-02 : rollback avec identifiants enregistrés => REFUSÉ (SCANYM_ROLLBACK_DATA_LOSS), rien ne change", async () => {
  const db = await makeDb();
  await addRestaurant(db, {});
  const before = await claimState(db);
  await refused(db, RBSMTP, /SCANYM_ROLLBACK_DATA_LOSS/);
  assert.deepEqual(await claimState(db), before);
  assert.equal(before.md5, BODY_SMTP_MD5);
  assert.equal((await db.query("select * from public.merchant_email_provider_config")).rows.length, 1);
  await db.close();
});

test("A196-02 : rollback à vide => claim IDENTIQUE à celui de #180 (corps, attributs, ACL, commentaire), coffre supprimé", async () => {
  const withoutSmtp = await makeDb({ smtp: false });
  const reference = await claimState(withoutSmtp);
  await withoutSmtp.close();

  const db = await makeDb();
  assert.notEqual((await claimState(db)).md5, reference.md5);
  await db.exec(RBSMTP);
  const after = await claimState(db);
  assert.equal(after.md5, BODY_180_MD5);
  assert.equal(after.attrs, reference.attrs);
  assert.equal(after.acl, reference.acl);
  assert.equal(after.comment, reference.comment, "le commentaire de #180 est restauré à l'identique");
  assert.equal(after.hasVault, false);
  assert.equal(after.hasGate, true, "la porte de #180 est intacte");
  await db.close();
});

test("A196-02 : le rollback de #180 réussit APRÈS le rollback SMTP (chaîne intacte) ; et le claim #180 restauré fonctionne", async () => {
  const db = await makeDb();
  await db.exec(RBSMTP);
  const paid = await addRestaurant(db, { vault: "none" });
  assert.deepEqual(await claim(db), [paid.outboxId], "sans coffre, le claim #180 réclame de nouveau (comportement antérieur)");
  await db.exec(RB180);
  assert.equal((await claimState(db)).hasGate, false, "rollback #180 appliqué");
  await db.close();
});

test("A196-02 : le rollback #180 appliqué AVANT le rollback SMTP est incohérent et le rollback SMTP le refuse ou échoue sans muter", async () => {
  const db = await makeDb();
  const before = await claimState(db);
  // Ordre inverse (interdit par la doc) : #180 d'abord. Il doit être refusé car le claim n'est plus celui de #180.
  await refused(db, RB180, /SCANYM_PREDECESSOR_DRIFT|SCANYM_SCHEMA_DRIFT|SCANYM_ROLLBACK/);
  assert.deepEqual(await claimState(db), before);
  assert.equal(before.hasGate, true);
  await db.close();
});

test("A196-02/03 : rollback SMTP refusé si le claim a dérivé depuis le lot (EXECUTE en trop)", async () => {
  const db = await makeDb();
  await db.exec("grant execute on function public.claim_pending_notifications(integer,integer) to audit_extra;");
  const before = await claimState(db);
  await refused(db, RBSMTP, /SCANYM_PREDECESSOR_DRIFT/);
  assert.deepEqual(await claimState(db), before);
  assert.equal(before.hasVault, true);
  await db.close();
});

test("A196-02 : rejeu du rollback => refusé (le coffre n'existe plus), sans mutation", async () => {
  const db = await makeDb();
  await db.exec(RBSMTP);
  const before = await claimState(db);
  await refused(db, RBSMTP, /SCANYM_SCHEMA_DRIFT|does not exist|SCANYM_/);
  assert.deepEqual(await claimState(db), before);
  await db.close();
});

test("cycle complet : #180 -> SMTP -> rollback -> SMTP de nouveau", async () => {
  const db = await makeDb();
  await db.exec(RBSMTP);
  await db.exec(SMTP);
  assert.equal((await claimState(db)).md5, BODY_SMTP_MD5);
  await db.close();
});
