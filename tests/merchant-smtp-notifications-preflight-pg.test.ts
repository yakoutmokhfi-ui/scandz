import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ====================================================================
// MERCHANT SMTP v1 R1 (A196-02 / A196-03) -- PRÉ-VOL ET ROLLBACK SUR UN VRAI
// PostgreSQL, avec le VRAI psql, dans les DEUX modes opérateur
// (ON_ERROR_STOP=1 : le script s'arrête ; ON_ERROR_STOP=0 : psql continue après
// l'erreur -- la transaction avortée doit empêcher toute DDL suivante).
//
// Même norme que tests/v172-order-received-payment-gate-preflight-pg.test.ts.
// Opt-in : sans SCANYM_TEST_PG_ADMIN_URL, chaque test est SAUTÉ avec sa raison
// (la couverture PGlite reste exécutée par tests/merchant-smtp-notifications-sql.test.ts).
// Boucle locale uniquement ; bases `scanym_smtp_*` jetables ; données synthétiques.
//
//   SCANYM_TEST_PG_ADMIN_URL  ex. postgresql://postgres@127.0.0.1:55432/postgres
//   SCANYM_TEST_PSQL          (optionnel) chemin de psql ; défaut `psql`
// ====================================================================

const ADMIN_URL = process.env.SCANYM_TEST_PG_ADMIN_URL;
const PSQL = process.env.SCANYM_TEST_PSQL || "psql";
const SKIP_REASON = ADMIN_URL
  ? false
  : "SCANYM_TEST_PG_ADMIN_URL absent : le pré-vol/rollback SMTP n'est PAS rejoué sur un PostgreSQL RÉEL ici";

function loopbackOnly(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error(`SCANYM_TEST_PG_ADMIN_URL doit désigner la boucle locale (reçu : ${host})`);
}

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const G180 = sql("DRAFT-lot-order-received-payment-gate-v1.sql");
const RB180 = sql("DRAFT-lot-order-received-payment-gate-v1-rollback.sql");
const SMTP = sql("DRAFT-lot-merchant-smtp-notifications-v1.sql");
const RBSMTP = sql("DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql");
const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
const N1A_CLAIM = N1A.match(/create function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];
const CLAIM_FN = "public.claim_pending_notifications(integer, integer)";

const workDir = mkdtempSync(path.join(tmpdir(), "scanym-smtp-"));
const databases: string[] = [];
const ROLES = ["anon", "authenticated", "service_role", "audit_extra"];

const urlFor = (db: string) => { const u = new URL(ADMIN_URL!); u.pathname = `/${db}`; return u.toString(); };

function psqlFile(dbUrl: string, name: string, content: string, onErrorStop: boolean) {
  const file = path.join(workDir, name);
  writeFileSync(file, content);
  const r = spawnSync(PSQL, ["-X", "-q", "-v", `ON_ERROR_STOP=${onErrorStop ? 1 : 0}`, "-f", file, dbUrl], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function psqlQuery(dbUrl: string, query: string): string {
  const r = spawnSync(PSQL, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", dbUrl, "-c", query], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function newDb(opts: { g180?: boolean; smtp?: boolean; extraSql?: string } = {}): string {
  const { g180 = true, smtp = true, extraSql = "" } = opts;
  loopbackOnly(ADMIN_URL!);
  const db = `scanym_smtp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  databases.push(db);
  const admin = spawnSync(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ADMIN_URL!, "-c", `create database ${db}`], { encoding: "utf8" });
  assert.equal(admin.status, 0, admin.stderr);
  const url = urlFor(db);
  const roles = ROLES.map((r) => `do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$;`).join("\n");
  const setup = psqlFile(url, "setup.sql", `
    ${roles}
    create table public.restaurants (id uuid primary key default gen_random_uuid());
    create table public.orders (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, public_token uuid not null default gen_random_uuid(),
      payment_status text not null default 'not_required', created_at timestamptz not null default now());
    create table public.merchant_notification_profile (restaurant_id uuid primary key, email_enabled boolean not null default false,
      sender_name text, sender_email text, reply_to text, default_locale text default 'fr');
    create function public.touch_updated_at() returns trigger language plpgsql as $f$ begin new.updated_at = now(); return new; end $f$;
    ${N1A_TABLE}
    ${N1A_CLAIM}
    revoke all on function ${CLAIM_FN} from public, anon, authenticated;
    grant execute on function ${CLAIM_FN} to service_role;
    ${extraSql}
  `, true);
  assert.equal(setup.status, 0, setup.out);
  if (g180) assert.equal(psqlFile(url, "g180.sql", G180, true).status, 0);
  if (smtp) { const r = psqlFile(url, "smtp.sql", SMTP, true); assert.equal(r.status, 0, r.out); }
  return url;
}

/** Tout ce qu'un refus ne doit pas toucher. */
function snapshot(url: string): string {
  return psqlQuery(url, `
    select concat_ws(E'\\n',
      (select to_jsonb(p)::text from pg_proc p where p.oid = '${CLAIM_FN}'::regprocedure),
      obj_description('${CLAIM_FN}'::regprocedure, 'pg_proc'),
      (select string_agg(p.proname || ':' || p.proowner::regrole::text || ':' || coalesce(p.proacl::text, '-'), ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
      coalesce(to_regclass('public.merchant_email_provider_config')::text, 'coffre-absent'),
      (select coalesce(string_agg(to_jsonb(c)::text, ',' order by c.conname), '') from pg_constraint c where c.conrelid = to_regclass('public.merchant_email_provider_config')),
      (select count(*)::text from public.notification_outbox));`);
}
// R2 (défaut 4) : empreinte sur les OCTETS EXACTS (aucune normalisation des fins de ligne).
const bodyMd5 = (url: string) => psqlQuery(url, `select md5(prosrc) from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
const comment = (url: string) => psqlQuery(url, `select md5(obj_description('${CLAIM_FN}'::regprocedure, 'pg_proc'));`);
const claimAcl = (url: string) => psqlQuery(url, `select proacl::text from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
const hasVault = (url: string) => psqlQuery(url, `select to_regclass('public.merchant_email_provider_config') is not null;`);
const hasGate = (url: string) => psqlQuery(url, `select to_regprocedure('public.notification_send_gate_open(uuid, text)') is not null;`);

function assertRefused(url: string, script: string, label: string, expectMessage: RegExp, code = "SCANYM_PREDECESSOR_DRIFT"): void {
  const before = snapshot(url);
  const stop = psqlFile(url, `${label}-stop.sql`, script, true);
  assert.notEqual(stop.status, 0, `${label} (ON_ERROR_STOP=1) : le script doit échouer`);
  assert.ok(stop.out.includes(code), `${label} (ON_ERROR_STOP=1) : ${code} attendu\n${stop.out}`);
  assert.match(stop.out, expectMessage, `${label} (ON_ERROR_STOP=1)\n${stop.out}`);
  assert.equal(snapshot(url), before, `${label} (ON_ERROR_STOP=1) : aucune mutation`);
  const go = psqlFile(url, `${label}-go.sql`, script, false);
  assert.ok(go.out.includes(code), `${label} (ON_ERROR_STOP=0) : ${code} attendu\n${go.out}`);
  assert.match(go.out, expectMessage, `${label} (ON_ERROR_STOP=0)\n${go.out}`);
  assert.equal(snapshot(url), before, `${label} (ON_ERROR_STOP=0) : psql a continué mais la transaction avortée a empêché toute DDL suivante`);
}

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (!ADMIN_URL) return;
  for (const db of databases) spawnSync(PSQL, ["-X", "-q", ADMIN_URL, "-c", `drop database if exists ${db}`], { encoding: "utf8" });
});

const OPTS = { skip: SKIP_REASON };
const BODY_180 = "16d75b38372fd5dfd0ca1a4e20dfa3a8";
/** Corps ($$...$$) du `create [or replace] function public.claim_pending_notifications` d'un fichier SQL. */
function claimBodyOf(file: string): string {
  const m = file.match(/create (?:or replace )?function public\.claim_pending_notifications\([\s\S]*?as \$\$([\s\S]*?)\$\$;/);
  assert.ok(m, "définition du claim introuvable");
  return m![1]!;
}
const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const BODY_SMTP = md5(claimBodyOf(SMTP));
assert.equal(md5(claimBodyOf(G180)), BODY_180);

test("[SMTP-PG-A] PostgreSQL réel -- chaîne nominale : #180 -> SMTP pose le corps épinglé ; rollback SMTP restaure #180 octet pour octet ; rollback #180 ensuite", OPTS, () => {
  const ref = newDb({ smtp: false });
  const refBody = bodyMd5(ref), refAcl = claimAcl(ref), refComment = comment(ref);
  assert.equal(refBody, BODY_180, "empreinte du claim #180 sur CE PostgreSQL");

  const url = newDb();
  assert.equal(bodyMd5(url), BODY_SMTP, "empreinte du claim SMTP sur CE PostgreSQL");
  assert.equal(hasVault(url), "t");
  const rb = psqlFile(url, "rb.sql", RBSMTP, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(bodyMd5(url), refBody);
  assert.equal(claimAcl(url), refAcl);
  assert.equal(comment(url), refComment);
  assert.equal(hasVault(url), "f");
  const rb180 = psqlFile(url, "rb180.sql", RB180, true);
  assert.equal(rb180.status, 0, `le rollback de #180 doit rester possible\n${rb180.out}`);
  assert.equal(hasGate(url), "f");
});

test("[SMTP-PG-B] PostgreSQL réel -- prédécesseur STRICT : lot REFUSÉ dans les deux modes psql, sans mutation", OPTS, () => {
  const url = newDb({ smtp: false, extraSql: "" });
  psqlQuery(url, `alter function ${CLAIM_FN} returns null on null input;`);
  assertRefused(url, SMTP, "fwd-strict", /attributs de claim_pending_notifications/);
  assert.equal(hasVault(url), "f");
});

test("[SMTP-PG-C] PostgreSQL réel -- bénéficiaire EXECUTE en plus : lot REFUSÉ dans les deux modes psql, sans mutation", OPTS, () => {
  const url = newDb({ smtp: false });
  psqlQuery(url, `grant execute on function ${CLAIM_FN} to audit_extra;`);
  const aclBefore = claimAcl(url);
  assertRefused(url, SMTP, "fwd-extra-role", /droits d'exécution de claim_pending_notifications/);
  assert.equal(claimAcl(url), aclBefore);
  assert.equal(hasVault(url), "f");
});

test("[SMTP-PG-D] PostgreSQL réel -- rollback SMTP avec identifiants enregistrés : REFUSÉ dans les deux modes psql, sans mutation", OPTS, () => {
  const url = newDb();
  psqlQuery(url, `insert into public.restaurants default values;`);
  psqlQuery(url, `insert into public.merchant_email_provider_config(restaurant_id, host, port, username) select id, 'smtp.ionos.fr', 465, 'a@example.com' from public.restaurants limit 1;`);
  assertRefused(url, RBSMTP, "rb-data", /./, "SCANYM_ROLLBACK_DATA_LOSS");
  assert.equal(bodyMd5(url), BODY_SMTP);
  assert.equal(hasVault(url), "t");
});

test("[SMTP-PG-E] PostgreSQL réel -- rollback SMTP : claim dérivé (EXECUTE en trop, puis STRICT) : REFUSÉ dans les deux modes psql, sans mutation", OPTS, () => {
  const url = newDb();
  psqlQuery(url, `grant execute on function ${CLAIM_FN} to audit_extra;`);
  assertRefused(url, RBSMTP, "rb-extra-role", /droits d'exécution de claim_pending_notifications/);
  psqlQuery(url, `revoke execute on function ${CLAIM_FN} from audit_extra; alter function ${CLAIM_FN} returns null on null input;`);
  assertRefused(url, RBSMTP, "rb-strict", /attributs de claim_pending_notifications/);
  assert.equal(hasVault(url), "t");
});

// --------------------------------------------------------------------
// R2 (défaut 4 du contre-audit de 7cb60a8) : pré-vols EXACTS, sur un PostgreSQL réel
// --------------------------------------------------------------------
/** Réécrit le claim courant en transformant son `pg_get_functiondef` ; vérifie que le corps a réellement changé. */
function redefineClaim(url: string, transformSql: string): void {
  const before = bodyMd5(url);
  psqlQuery(url, `do $x$ declare s text; begin select pg_get_functiondef('${CLAIM_FN}'::regprocedure) into s; execute ${transformSql}; end $x$;`);
  assert.notEqual(bodyMd5(url), before, "la variante doit réellement modifier le corps");
}
const TAMPERS: Array<{ name: string; apply: (url: string) => void }> = [
  // Une seule fin de ligne CRLF au milieu d'un corps LF : une empreinte « CR retirés » l'aurait acceptée.
  { name: "fins de ligne mixtes (un seul CRLF)", apply: (url) => redefineClaim(url, `replace(s, E'begin\\n  return query', E'begin\\r\\n  return query')`) },
  // Un CR DANS un littéral de chaîne change la valeur comparée : l'ancienne empreinte (CR retirés) ne le voyait pas.
  { name: "CR isolé dans un littéral", apply: (url) => redefineClaim(url, `replace(s, '''processing''', '''processing' || E'\\r' || '''')`) },
  { name: "commentaire de fonction modifié", apply: (url) => psqlQuery(url, `comment on function ${CLAIM_FN} is 'commentaire altéré';`) },
  { name: "commentaire SQL ajouté dans le corps", apply: (url) => redefineClaim(url, `replace(s, 'begin', 'begin -- x')`) },
];

test("[SMTP-PG-F] PostgreSQL réel -- lot SMTP : chaque variante du claim de #180 (fins de ligne mixtes, CR dans un littéral, commentaire) est REFUSÉE, sans mutation", OPTS, () => {
  for (const tamper of TAMPERS) {
    const url = newDb({ smtp: false });
    tamper.apply(url);
    assertRefused(url, SMTP, `fwd-${tamper.name.replace(/\W+/g, "-")}`, /./);
    assert.equal(hasVault(url), "f", tamper.name);
  }
});

test("[SMTP-PG-G] PostgreSQL réel -- rollback SMTP : chaque variante du claim SMTP est REFUSÉE, sans mutation (le coffre et le claim restent en place)", OPTS, () => {
  for (const tamper of TAMPERS) {
    const url = newDb();
    tamper.apply(url);
    assertRefused(url, RBSMTP, `rb-${tamper.name.replace(/\W+/g, "-")}`, /./);
    assert.equal(hasVault(url), "t", tamper.name);
  }
});

test("[SMTP-PG-H] PostgreSQL réel -- la forme CRLF intégrale (extraction Windows du dépôt) reste admise : lot appliqué, puis rollback qui restaure #180", OPTS, () => {
  const url = newDb({ smtp: false });
  redefineClaim(url, `replace(s, E'\\n', E'\\r\\n')`);
  assert.equal(bodyMd5(url), md5(claimBodyOf(G180).replaceAll("\n", "\r\n")), "le claim #180 est bien en CRLF intégral");
  const fwd = psqlFile(url, "fwd-crlf.sql", SMTP, true);
  assert.equal(fwd.status, 0, fwd.out);
  assert.equal(bodyMd5(url), BODY_SMTP);
  redefineClaim(url, `replace(s, E'\\n', E'\\r\\n')`);
  const rb = psqlFile(url, "rb-crlf.sql", RBSMTP, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(bodyMd5(url), BODY_180);
  assert.equal(hasVault(url), "f");
});

// --------------------------------------------------------------------
// R2 : rollback face à une écriture concurrente (DEUX connexions réelles)
// --------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function psqlSession(url: string, extraArgs: string[] = []) {
  const child = spawn(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...extraArgs, url], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let finished = false;
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => { finished = true; resolve(code); }));
  return { child, done, output: () => output, finished: () => finished };
}
const RACE_RESTAURANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const raceInsert = `insert into public.merchant_email_provider_config(restaurant_id, host, port, username, enabled) values ('${RACE_RESTAURANT}', 'smtp.ionos.fr', 465, 'b@b.fr', false);`;

test("[SMTP-PG-I] PostgreSQL réel, 2 connexions -- une écriture de configuration en cours pendant le rollback n'est JAMAIS perdue (le rollback attend, revoit le coffre, refuse)", OPTS, async () => {
  const url = newDb();
  psqlQuery(url, `insert into public.restaurants(id) values ('${RACE_RESTAURANT}');`);
  const rbFile = path.join(workDir, "rb-race.sql");
  writeFileSync(rbFile, RBSMTP);

  const writer = psqlSession(url);
  writer.child.stdin.write(`begin; ${raceInsert}\n`); // transaction OUVERTE, pas encore validée
  await sleep(1000);
  const rollback = psqlSession(url, ["-f", rbFile]);
  await sleep(2000);
  assert.equal(rollback.finished(), false, "le rollback attend le verrou : il ne passe PAS devant l'écriture en cours");
  writer.child.stdin.end("commit;\n");
  const [writerCode, rollbackCode] = await Promise.all([writer.done, rollback.done]);

  assert.equal(writerCode, 0, writer.output());
  assert.notEqual(rollbackCode, 0, "le rollback doit être refusé");
  assert.match(rollback.output(), /SCANYM_ROLLBACK_DATA_LOSS/, rollback.output());
  assert.equal(hasVault(url), "t", "la table n'a pas été supprimée");
  assert.equal(psqlQuery(url, "select count(*)::text from public.merchant_email_provider_config;"), "1", "la configuration validée par l'écriture concurrente est intacte");
  assert.equal(bodyMd5(url), BODY_SMTP, "le claim SMTP est resté en place (rollback annulé en bloc)");
});

test("[SMTP-PG-J] PostgreSQL réel, 2 connexions -- verrou tenu trop longtemps : le rollback expire (lock_timeout 10 s) sans rien modifier", OPTS, async () => {
  const url = newDb();
  psqlQuery(url, `insert into public.restaurants(id) values ('${RACE_RESTAURANT}');`);
  const rbFile = path.join(workDir, "rb-timeout.sql");
  writeFileSync(rbFile, RBSMTP);
  const before = snapshot(url);

  const holder = psqlSession(url);
  holder.child.stdin.write(`begin; ${raceInsert}\n`);
  await sleep(500);
  const rollback = psqlSession(url, ["-f", rbFile]);
  const rollbackCode = await rollback.done; // expire seul, sans attendre le commit
  assert.notEqual(rollbackCode, 0);
  assert.match(rollback.output(), /lock timeout|SCANYM_/i, rollback.output());
  holder.child.stdin.end("rollback;\n");
  await holder.done;
  assert.equal(snapshot(url), before, "aucune mutation");
  assert.equal(hasVault(url), "t");
});
