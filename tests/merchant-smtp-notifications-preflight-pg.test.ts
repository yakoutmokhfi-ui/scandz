import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const bodyMd5 = (url: string) => psqlQuery(url, `select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
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
const BODY_SMTP = (SMTP.match(/'([0-9a-f]{32})'/g) ?? []).map((m) => m.slice(1, -1)).find((h) => h !== BODY_180)!;

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
