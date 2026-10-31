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
// R3 : le lot SMTP délègue l'écriture du profil sous bail à la fonction N1-A (extraite TELLE QUELLE) et aux deux
// fonctions de rôle, dont les corps réels vivent dans d'autres lots : doublures minimales pilotées par des réglages de session.
const N1A_PROFILE_RPC = N1A.match(/create function public\.set_merchant_notification_profile\([\s\S]*?grant execute on function public\.set_merchant_notification_profile\([^)]*\) to authenticated;/)![0];
const ROLE_STUBS = `
  create function public.has_role_in(p_restaurant_id uuid, p_roles text[]) returns boolean language sql stable
    as $f$ select coalesce(current_setting('test.role', true), '') = any(p_roles) $f$;
  create function public.is_scanym_operator() returns boolean language sql stable
    as $f$ select coalesce(current_setting('test.operator', true), '') = 'on' $f$;
`;
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
const toCrlf = (text: string) => text.replaceAll("\n", "\r\n");
const BODY_180_CRLF_MD5 = md5(toCrlf(claimBodyOf(G180)));
const BODY_SMTP_CRLF_MD5 = md5(toCrlf(claimBodyOf(SMTP)));

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
    ${ROLE_STUBS}
    ${N1A_PROFILE_RPC}
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
  // R2 (défaut 4) : empreinte sur les OCTETS EXACTS (md5(prosrc) brut), deux formes admises : LF et CRLF intégral.
  assert.match(SMTP, new RegExp(`c_expected_body_md5\\s+constant text := '${BODY_180_MD5}'`));
  assert.match(SMTP, new RegExp(`c_expected_body_md5_crlf\\s+constant text := '${BODY_180_CRLF_MD5}'`));
  assert.match(RBSMTP, new RegExp(`c_gated_body_md5\\s+constant text := '${BODY_180_MD5}'`), "le rollback restaure le corps de #180");
  assert.match(RBSMTP, new RegExp(`c_gated_body_md5_crlf\\s+constant text := '${BODY_180_CRLF_MD5}'`));
  assert.match(SMTP, new RegExp(`c_smtp_body_md5\\s+constant text := '${BODY_SMTP_MD5}'`), "le post-contrôle épingle le corps du nouveau claim");
  assert.match(SMTP, new RegExp(`c_smtp_body_md5_crlf\\s+constant text := '${BODY_SMTP_CRLF_MD5}'`));
  assert.match(RBSMTP, new RegExp(`c_expected_body_md5\\s+constant text := '${BODY_SMTP_MD5}'`), "le rollback épingle le corps du claim SMTP");
  assert.match(RBSMTP, new RegExp(`c_expected_body_md5_crlf\\s+constant text := '${BODY_SMTP_CRLF_MD5}'`));
  // Le commentaire de la fonction est épinglé lui aussi (une dérive de commentaire fait échouer le contrôle).
  for (const file of [SMTP, RBSMTP]) assert.match(file, /obj_description\(p\.oid, 'pg_proc'\)/);
  assert.match(SMTP, /c_expected_comment_md5\s+constant text := '[0-9a-f]{32}'/);
  assert.match(RBSMTP, /c_expected_comment_md5\s+constant text := '[0-9a-f]{32}'/);

  const base = await makeDb({ smtp: false });
  assert.equal((await claimState(base)).md5, BODY_180_MD5, "#180 pose bien le corps épinglé");
  await base.close();
  const full = await makeDb();
  assert.equal((await claimState(full)).md5, BODY_SMTP_MD5, "le lot SMTP pose bien le corps épinglé");
  await full.close();
});

test("R2 (défaut 4) : aucun littéral de chaîne des corps de claim ne contient de saut de ligne (sinon LF et CRLF ne seraient pas sémantiquement équivalents)", () => {
  // Justifie l'admission des DEUX seules formes d'octets (LF, CRLF intégral) par les pré-vols.
  for (const [name, body] of [["#180", claimBodyOf(G180)], ["SMTP", claimBodyOf(SMTP)]] as const) {
    let inLiteral = false;
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i]!;
      if (!inLiteral && c === "-" && body[i + 1] === "-") { while (i < body.length && body[i] !== "\n") i += 1; continue; }
      if (c === "'") {
        if (inLiteral && body[i + 1] === "'") { i += 1; continue; }
        inLiteral = !inLiteral;
        continue;
      }
      assert.ok(!(inLiteral && (c === "\n" || c === "\r")), `${name} : saut de ligne dans un littéral (offset ${i})`);
    }
    assert.equal(inLiteral, false, `${name} : littéral non fermé`);
    assert.equal(body.includes("\r"), false, `${name} : le dépôt est normalisé en LF dans ce test`);
    assert.equal(body.includes("$"), false, `${name} : aucun dollar-quoting imbriqué`);
  }
});

test("R2 (rollback) : le verrou exclusif de la table et son délai précèdent le contrôle « coffre vide » (aucune écriture concurrente ne peut s'intercaler)", () => {
  const timeout = RBSMTP.indexOf("set local lock_timeout = '10s';");
  const lock = RBSMTP.indexOf("lock table public.merchant_email_provider_config in access exclusive mode;");
  const check = RBSMTP.indexOf("raise exception 'SCANYM_ROLLBACK_DATA_LOSS");
  const drop = RBSMTP.indexOf("\ndrop table public.merchant_email_provider_config");
  assert.ok(timeout > 0 && lock > timeout, "lock_timeout avant le verrou");
  assert.ok(check > lock, "le contrôle « coffre vide » vient APRÈS l'obtention du verrou");
  assert.ok(drop > check, "la suppression vient après le contrôle");
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
  // R2 (défaut 3) : le bail d'enregistrement est toujours « jeton ET échéance » ou « ni l'un ni l'autre ».
  await assert.rejects(() => update("save_token = gen_random_uuid()"), /save_lease_consistent/);
  await assert.rejects(() => update("save_lease_until = now()"), /save_lease_consistent/);
  await update("save_token = gen_random_uuid(), save_lease_until = now() + interval '1 minute'");
  await update("save_token = null, save_lease_until = null");
  await db.close();
});

test("coffre R2 : bail d'enregistrement = acquisition atomique, restauration et activation conditionnelles au jeton (verrou ligne PostgreSQL réel du PGlite)", async () => {
  const db = await makeDb();
  const rest = (await db.query<{ id: string }>("insert into public.restaurants default values returning id")).rows[0]!.id;
  const secret = "'c', 'i', 't'";
  await db.query(`insert into public.merchant_email_provider_config(restaurant_id, host, port, username, enabled, secret_ciphertext, secret_iv, secret_auth_tag)
                  values ('${rest}', 'smtp.ionos.fr', 465, 'a@b.fr', true, ${secret})`);
  const tokenA = "11111111-1111-4111-8111-111111111111";
  const tokenB = "22222222-2222-4222-8222-222222222222";
  const acquire = (token: string, host: string) => db.query<{ restaurant_id: string }>(
    `update public.merchant_email_provider_config
        set host = '${host}', enabled = false, save_token = '${token}', save_lease_until = now() + interval '60 seconds'
      where restaurant_id = '${rest}' and host = 'smtp.ionos.fr' and enabled = true
        and (save_token is null or save_lease_until < now())
      returning restaurant_id`);
  assert.equal((await acquire(tokenA, "smtp.a.fr")).rows.length, 1, "A prend le bail");
  assert.equal((await acquire(tokenB, "smtp.b.fr")).rows.length, 0, "B ne peut pas : l'état lu n'est plus le même ET le bail est tenu");
  const restore = (token: string) => db.query(
    `update public.merchant_email_provider_config set host = 'smtp.ionos.fr', enabled = true, save_token = null, save_lease_until = null
      where restaurant_id = '${rest}' and save_token = '${token}' returning restaurant_id`);
  assert.equal((await restore(tokenB)).rows.length, 0, "la restauration de B (jeton étranger) n'écrit rien");
  assert.equal((await db.query<{ host: string }>(`select host from public.merchant_email_provider_config where restaurant_id = '${rest}'`)).rows[0]!.host, "smtp.a.fr");
  assert.equal((await restore(tokenA)).rows.length, 1, "la restauration de A (son jeton) s'applique");
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

// ====================================================================
// R3 (P2) -- « Sauvegarde concurrente : un profil ancien peut remplacer celui d'une configuration
// récemment enregistrée » : écriture du profil SOUS BAIL, dans la même transaction que la vérification
// du jeton (verrou de la ligne du coffre). Preuve de verrouillage entre DEUX connexions : voir
// [SMTP-PG-L]/[SMTP-PG-M] dans tests/merchant-smtp-notifications-preflight-pg.test.ts (PGlite est mono-connexion).
// ====================================================================
const LEASED = "public.set_merchant_notification_profile_under_save_lease(uuid,uuid,boolean,text,text,text,text)";
const TOKEN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function leasedCall(db: PGlite, restaurant: string, token: string | null, role: "owner" | "manager" | "staff" | "", fields: { name?: string; email?: string; enabled?: boolean } = {}) {
  await db.exec(`select set_config('test.role', '${role}', false); set role authenticated;`);
  try {
    await db.query(
      "select public.set_merchant_notification_profile_under_save_lease($1::uuid, $2::uuid, $3, $4, $5, null, 'fr')",
      [restaurant, token, fields.enabled ?? true, fields.name ?? "Resto B", fields.email ?? "b@resto.example"]);
  } finally {
    await db.exec("reset role");
  }
}
const profileOf = async (db: PGlite, restaurant: string) =>
  (await db.query<{ email_enabled: boolean; sender_name: string; sender_email: string }>(
    "select email_enabled, sender_name, sender_email from public.merchant_notification_profile where restaurant_id = $1::uuid", [restaurant])).rows[0];
const takeLease = (db: PGlite, restaurant: string, token: string) =>
  db.query("update public.merchant_email_provider_config set save_token = $2::uuid, save_lease_until = now() + interval '60 seconds' where restaurant_id = $1::uuid", [restaurant, token]);
const rejectsWith = (code: string, marker: RegExp) => (error: unknown) => {
  const e = error as { code?: string; message?: string };
  return e.code === code && marker.test(String(e.message));
};

test("R3-02 : la fonction de profil sous bail est SECURITY DEFINER, search_path vide, exécutable par authenticated SEULEMENT", async () => {
  const db = await makeDb();
  const r = await db.query<{ secdef: boolean; config: string; acl: string; can_auth: boolean; can_anon: boolean; can_service: boolean; can_public: boolean }>(`
    select p.prosecdef as secdef, array_to_string(p.proconfig, ',') as config, p.proacl::text as acl,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_auth,
           has_function_privilege('anon', p.oid, 'EXECUTE') as can_anon,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as can_service,
           has_function_privilege('public', p.oid, 'EXECUTE') as can_public
    from pg_proc p where p.oid = '${LEASED}'::regprocedure`);
  const row = r.rows[0]!;
  assert.equal(row.secdef, true);
  assert.equal(row.config, 'search_path=""');
  assert.deepEqual([row.can_auth, row.can_anon, row.can_service, row.can_public], [true, false, false, false], row.acl);
  await db.close();
});

test("R3-02 REPRO : jeton COURANT => profil écrit ; jeton repris par un autre enregistrement (ou absent, ou étranger) => SCANYM_SAVE_LEASE_LOST et profil INCHANGÉ", async () => {
  const db = await makeDb();
  const { restaurant } = await addRestaurant(db, {});
  const other = await addRestaurant(db, {});
  await takeLease(db, restaurant, TOKEN_A);
  await takeLease(db, other.restaurant, TOKEN_B);

  await leasedCall(db, restaurant, TOKEN_A, "owner", { name: "Resto A", email: "a@resto.example" });
  assert.deepEqual(await profileOf(db, restaurant), { email_enabled: true, sender_name: "Resto A", sender_email: "a@resto.example" });

  // B reprend le bail (celui d'A a expiré) et écrit SON profil ; A, en retard, arrive ensuite avec son ancien jeton.
  await takeLease(db, restaurant, TOKEN_B);
  await leasedCall(db, restaurant, TOKEN_B, "manager", { name: "Resto B", email: "b@resto.example" });
  const afterB = await profileOf(db, restaurant);
  assert.equal(afterB!.sender_name, "Resto B");
  for (const stale of [TOKEN_A, null, TOKEN_B.replace(/^b/, "c"), other.restaurant]) {
    await assert.rejects(() => leasedCall(db, restaurant, stale, "owner", { name: "Resto A (ancien)", email: "ancien@resto.example" }), rejectsWith("55000", /SCANYM_SAVE_LEASE_LOST/), String(stale));
    assert.deepEqual(await profileOf(db, restaurant), afterB, `le profil récent n'est pas remplacé (jeton ${stale})`);
  }
  // Le jeton d'un AUTRE établissement ne vaut rien ici.
  await assert.rejects(() => leasedCall(db, restaurant, TOKEN_B.replace(/^b/, "d"), "owner"), rejectsWith("55000", /SCANYM_SAVE_LEASE_LOST/));
  // Bail libéré (enregistrement terminé) : plus de jeton valide.
  await db.query("update public.merchant_email_provider_config set save_token = null, save_lease_until = null where restaurant_id = $1::uuid", [restaurant]);
  await assert.rejects(() => leasedCall(db, restaurant, TOKEN_B, "owner"), rejectsWith("55000", /SCANYM_SAVE_LEASE_LOST/));
  assert.deepEqual(await profileOf(db, restaurant), afterB);
  await db.close();
});

test("R3-02 : l'autorisation précède le bail -- sans rôle owner/manager : 42501, même avec un faux jeton (l'état du bail n'est pas révélé) ; opérateur admis", async () => {
  const db = await makeDb();
  const { restaurant } = await addRestaurant(db, {});
  await takeLease(db, restaurant, TOKEN_A);
  const before = await profileOf(db, restaurant);
  for (const role of ["staff", ""] as const) {
    for (const token of [TOKEN_A, TOKEN_B]) {
      await assert.rejects(() => leasedCall(db, restaurant, token, role), rejectsWith("42501", /SCANYM_NOTIFICATION_PROFILE_FORBIDDEN/), `${role || "(aucun)"} / ${token}`);
    }
  }
  assert.deepEqual(await profileOf(db, restaurant), before);
  await db.exec("select set_config('test.operator', 'on', false); select set_config('test.role', '', false); set role authenticated;");
  await db.query("select public.set_merchant_notification_profile_under_save_lease($1::uuid, $2::uuid, true, 'Opérateur', 'op@resto.example', null, 'fr')", [restaurant, TOKEN_A]);
  await db.exec("reset role; select set_config('test.operator', 'off', false);");
  assert.equal((await profileOf(db, restaurant))!.sender_name, "Opérateur");
  await db.close();
});

test("R3-02 : profil invalide avec le bon jeton => erreur de validation de la fonction N1-A, rien d'écrit, bail intact", async () => {
  const db = await makeDb();
  const { restaurant } = await addRestaurant(db, {});
  await takeLease(db, restaurant, TOKEN_A);
  const before = await profileOf(db, restaurant);
  await assert.rejects(() => leasedCall(db, restaurant, TOKEN_A, "owner", { email: "pas-un-courriel" }), rejectsWith("22023", /sender_email invalide/));
  assert.deepEqual(await profileOf(db, restaurant), before);
  const lease = await db.query<{ save_token: string | null }>("select save_token from public.merchant_email_provider_config where restaurant_id = $1::uuid", [restaurant]);
  assert.equal(lease.rows[0]!.save_token, TOKEN_A, "le bail est toujours à son titulaire (la fonction ne le modifie jamais)");
  await db.close();
});

test("R3-02 : pré-vol -- profil N1-A, has_role_in ou is_scanym_operator absents, ou fonction déjà présente => lot REFUSÉ sans mutation", async () => {
  for (const [label, drop] of [
    ["profil N1-A absent", "drop function public.set_merchant_notification_profile(uuid, boolean, text, text, text, text);"],
    ["has_role_in absent", "drop function public.has_role_in(uuid, text[]);"],
    ["is_scanym_operator absent", "drop function public.is_scanym_operator();"],
  ] as const) {
    const db = await makeDb({ smtp: false });
    await db.exec(drop);
    await refused(db, SMTP, /SCANYM_SCHEMA_DRIFT/);
    assert.equal((await claimState(db)).hasVault, false, label);
    assert.equal((await claimState(db)).md5, BODY_180_MD5, label);
    await db.close();
  }
  const db = await makeDb({ smtp: false });
  await db.exec("create function public.set_merchant_notification_profile_under_save_lease(uuid, uuid, boolean, text, text, text, text) returns void language sql as $f$ select 1 $f$;");
  await refused(db, SMTP, /SCANYM_SCHEMA_DRIFT: set_merchant_notification_profile_under_save_lease already exists/);
  assert.equal((await claimState(db)).hasVault, false);
  await db.close();
});

test("R3-02 : le rollback supprime la fonction sous bail (et elle seule) ; le profil N1-A et le claim de #180 restent", async () => {
  const db = await makeDb();
  await db.exec(RBSMTP);
  const r = await db.query<{ leased: boolean; base: boolean; vault: boolean }>(`
    select to_regprocedure('${LEASED}') is not null as leased,
           to_regprocedure('public.set_merchant_notification_profile(uuid,boolean,text,text,text,text)') is not null as base,
           to_regclass('public.merchant_email_provider_config') is not null as vault`);
  assert.deepEqual(r.rows[0], { leased: false, base: true, vault: false });
  assert.equal((await claimState(db)).md5, BODY_180_MD5);
  // Cycle complet : le lot se réapplique (la fonction est recréée).
  await db.exec(SMTP);
  assert.equal((await db.query<{ ok: boolean }>(`select to_regprocedure('${LEASED}') is not null as ok`)).rows[0]!.ok, true);
  await db.close();
});
