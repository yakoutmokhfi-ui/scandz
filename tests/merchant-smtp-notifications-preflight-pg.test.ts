import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPsqlRunner, parseLocalPgUrl } from "./helpers/pg-local-guard.ts";

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
// R3 (P1) : la cible est analysée strictement et passée à psql par DRAPEAUX, l'environnement
// de chaque psql est CONSTRUIT (aucun PGHOSTADDR/PGHOST/PGSERVICE... hérité) et l'adresse réellement
// jointe est vérifiée par le serveur avant toute création de base : voir
// tests/helpers/pg-local-guard.ts (testé sans PostgreSQL par tests/merchant-smtp-pg-harness-guard.test.ts).
//
//   SCANYM_TEST_PG_ADMIN_URL  ex. postgresql://postgres@127.0.0.1:55432/postgres
//   SCANYM_TEST_PSQL          (optionnel) chemin de psql ; défaut `psql`
// ====================================================================

const ADMIN_URL = process.env.SCANYM_TEST_PG_ADMIN_URL;
const PSQL = process.env.SCANYM_TEST_PSQL || "psql";
const SKIP_REASON = ADMIN_URL
  ? false
  : "SCANYM_TEST_PG_ADMIN_URL absent : le pré-vol/rollback SMTP n'est PAS rejoué sur un PostgreSQL RÉEL ici";


const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const G180 = sql("DRAFT-lot-order-received-payment-gate-v1.sql");
const RB180 = sql("DRAFT-lot-order-received-payment-gate-v1-rollback.sql");
const SMTP = sql("DRAFT-lot-merchant-smtp-notifications-v1.sql");
const RBSMTP = sql("DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql");
const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
const N1A_CLAIM = N1A.match(/create function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];
// R3 : voir tests/merchant-smtp-notifications-sql.test.ts -- fonction de profil N1-A réelle + doublures de rôle.
const N1A_PROFILE_RPC = N1A.match(/create function public\.set_merchant_notification_profile\([\s\S]*?grant execute on function public\.set_merchant_notification_profile\([^)]*\) to authenticated;/)![0];
const ROLE_STUBS = `
  create function public.has_role_in(p_restaurant_id uuid, p_roles text[]) returns boolean language sql stable
    as $f$ select coalesce(current_setting('test.role', true), '') = any(p_roles) $f$;
  create function public.is_scanym_operator() returns boolean language sql stable
    as $f$ select coalesce(current_setting('test.operator', true), '') = 'on' $f$;
`;
const CLAIM_FN = "public.claim_pending_notifications(integer, integer)";

const workDir = mkdtempSync(path.join(tmpdir(), "scanym-smtp-"));
const isolatedHome = mkdtempSync(path.join(tmpdir(), "scanym-smtp-home-"));
const psqlRunner = createPsqlRunner({ bin: PSQL, baseEnv: process.env, isolatedHome });
const databases: string[] = [];
const ROLES = ["anon", "authenticated", "service_role", "audit_extra"];

const urlFor = (db: string) => { const u = new URL(ADMIN_URL!); u.pathname = `/${db}`; return u.toString(); };

function psqlFile(dbUrl: string, name: string, content: string, onErrorStop: boolean) {
  const file = path.join(workDir, name);
  writeFileSync(file, content);
  const r = psqlRunner.run(dbUrl, ["-v", `ON_ERROR_STOP=${onErrorStop ? 1 : 0}`, "-f", file]);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function psqlQuery(dbUrl: string, query: string): string {
  const r = psqlRunner.run(dbUrl, ["-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function newDb(opts: { g180?: boolean; smtp?: boolean; extraSql?: string } = {}): string {
  const { g180 = true, smtp = true, extraSql = "" } = opts;
  parseLocalPgUrl(ADMIN_URL!); // refus net (cible non locale, paramètre de redirection...) avant toute connexion
  const db = `scanym_smtp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // La première exécution vérifie l'adresse RÉELLE du serveur (lecture seule) AVANT le `create database`.
  const admin = psqlRunner.run(ADMIN_URL!, ["-v", "ON_ERROR_STOP=1", "-c", `create database ${db}`]);
  assert.equal(admin.status, 0, admin.stderr);
  databases.push(db);
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
    ${ROLE_STUBS}
    ${N1A_PROFILE_RPC}
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
      -- R4 : la fonction d'écriture du profil sous bail (ligne pg_proc complète : corps, attributs, propriétaire, droits + commentaire).
      (select coalesce(string_agg(to_jsonb(p)::text || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '-'), E'\n' order by p.oid), 'fonction-sous-bail-absente')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'set_merchant_notification_profile_under_save_lease'),
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
  if (ADMIN_URL) for (const db of databases) psqlRunner.run(ADMIN_URL, ["-c", `drop database if exists ${db}`]);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(isolatedHome, { recursive: true, force: true });
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
  const child = psqlRunner.session(url, ["-v", "ON_ERROR_STOP=1", ...extraArgs]);
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

// --------------------------------------------------------------------
// R3 (P1) : environnement libpq HOSTILE -- le harnais ne doit viser que la cible désignée
// --------------------------------------------------------------------
test("[SMTP-PG-K] PostgreSQL réel -- PGHOSTADDR/PGHOST/PGSERVICE/PGPORT... hostiles : le harnais atteint QUAND MÊME le cluster désigné par l'URL (jamais l'adresse imposée par l'environnement)", OPTS, () => {
  const hostile: Record<string, string> = {
    PGHOSTADDR: "192.0.2.1", // TEST-NET-1 : injoignable ; avant R3 psql s'y connectait et le harnais échouait (ou pire : visait un serveur réel)
    PGHOST: "192.0.2.1",
    PGPORT: "1",
    PGSERVICE: "scanym-absent",
    PGSERVICEFILE: path.join(workDir, "absent-service.conf"),
    PGUSER: "intrus",
    PGDATABASE: "intrus",
    PGOPTIONS: "-c search_path=intrus",
    PGCONNECT_TIMEOUT: "2",
  };
  const saved = Object.fromEntries(Object.keys(hostile).map((k) => [k, process.env[k]]));
  Object.assign(process.env, hostile);
  try {
    const url = newDb();
    assert.equal(bodyMd5(url), BODY_SMTP, "le lot a été appliqué sur le cluster désigné");
    assert.equal(hasVault(url), "t");
    const addr = psqlQuery(url, "select inet_server_addr()::text;");
    assert.ok(/^(127\.|::1)/.test(addr), `adresse réellement jointe : ${addr}`);
    assert.equal(psqlQuery(url, "select current_database() = '" + new URL(url).pathname.slice(1) + "';"), "t");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

// --------------------------------------------------------------------
// R3 (P2) : profil ancien -- l'écriture du profil sous bail est ATOMIQUE avec la vérification du jeton
// --------------------------------------------------------------------
const LEASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEASE_RESTAURANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const leasedCall = (token: string, name: string, email: string) =>
  `set role authenticated; select public.set_merchant_notification_profile_under_save_lease('${LEASE_RESTAURANT}', '${token}', true, '${name}', '${email}', null, 'fr');`;
function leaseWorld(): string {
  const url = newDb();
  psqlQuery(url, `
    insert into public.restaurants(id) values ('${LEASE_RESTAURANT}');
    insert into public.merchant_notification_profile(restaurant_id, email_enabled, sender_name, sender_email) values ('${LEASE_RESTAURANT}', true, 'Resto initial', 'init@resto.example');
    insert into public.merchant_email_provider_config(restaurant_id, host, port, username, enabled, save_token, save_lease_until)
      values ('${LEASE_RESTAURANT}', 'smtp.ionos.fr', 465, 'a@resto.example', false, '${LEASE_A}', now() - interval '1 second');`); // le bail d'A a EXPIRÉ (A est lent)
  return url;
}
const senderOf = (url: string) => psqlQuery(url, `select sender_name from public.merchant_notification_profile where restaurant_id = '${LEASE_RESTAURANT}';`);
const tokenOf = (url: string) => psqlQuery(url, `select save_token from public.merchant_email_provider_config where restaurant_id = '${LEASE_RESTAURANT}';`);
const TAKEOVER = `update public.merchant_email_provider_config set save_token = '${LEASE_B}', save_lease_until = now() + interval '60 seconds'
  where restaurant_id = '${LEASE_RESTAURANT}' and (save_token is null or save_lease_until < now());`;

test("[SMTP-PG-L] PostgreSQL réel, 2 connexions -- la reprise du bail par B ATTEND la fin de l'écriture du profil d'A (vérification du jeton + écriture indivisibles)", OPTS, async () => {
  const url = leaseWorld();
  const a = psqlSession(url);
  let b: ReturnType<typeof psqlSession> | undefined;
  try {
    a.child.stdin.write(`select set_config('test.role', 'owner', false); begin; ${leasedCall(LEASE_A, "Resto A", "a@resto.example")}\n`); // transaction OUVERTE : verrou de la ligne tenu
    await sleep(1000);
    b = psqlSession(url);
    b.child.stdin.write(`${TAKEOVER}\n`);
    await sleep(2000);
    assert.equal(b.finished(), false, "B attend le verrou tenu par l'écriture d'A : il ne s'intercale PAS entre la vérification et l'écriture");
    assert.equal(tokenOf(url), LEASE_A, "tant qu'A n'a pas validé, le jeton est toujours celui d'A");
    a.child.stdin.end("commit;\n");
    b.child.stdin.end();
    const [aCode, bCode] = await Promise.all([a.done, b.done]);
    assert.equal(aCode, 0, a.output());
    assert.equal(bCode, 0, b.output());
  } finally {
    // Un échec d'assertion ne doit JAMAIS laisser une session ouverte (le test échouerait en se bloquant au lieu d'échouer).
    for (const session of [a, b]) if (session && !session.finished()) session.child.kill();
  }
  assert.equal(senderOf(url), "Resto A", "le profil d'A a été écrit tant qu'A détenait le bail");
  assert.equal(tokenOf(url), LEASE_B, "puis B a repris le bail");
  // A, s'il retente avec son ancien jeton, ne peut plus rien écrire.
  const late = psqlRunner.run(url, ["-A", "-t", "-c", `select set_config('test.role', 'owner', false); ${leasedCall(LEASE_A, "Resto A (en retard)", "retard@resto.example")}`]);
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /SCANYM_SAVE_LEASE_LOST/);
  assert.equal(senderOf(url), "Resto A");
});

test("[SMTP-PG-M] PostgreSQL réel -- B a repris le bail et écrit son profil : l'appel tardif d'A est REFUSÉ ; la fonction non conditionnelle de 9e38c88 l'aurait écrasé (témoin du défaut)", OPTS, () => {
  const url = leaseWorld();
  psqlQuery(url, TAKEOVER);
  assert.equal(tokenOf(url), LEASE_B);
  const asB = psqlRunner.run(url, ["-A", "-t", "-c", `select set_config('test.role', 'manager', false); ${leasedCall(LEASE_B, "Resto B", "b@resto.example")}`]);
  assert.equal(asB.status, 0, asB.stderr);
  assert.equal(senderOf(url), "Resto B");

  const lateA = psqlRunner.run(url, ["-A", "-t", "-c", `select set_config('test.role', 'owner', false); ${leasedCall(LEASE_A, "Resto A (ancien)", "ancien@resto.example")}`]);
  assert.notEqual(lateA.status, 0, "l'appel d'A (bail repris) doit échouer");
  assert.match(lateA.stderr, /SCANYM_SAVE_LEASE_LOST/);
  assert.equal(senderOf(url), "Resto B", "le profil récent n'est pas remplacé");

  // Témoin : ce que faisait le code de 9e38c88 (appel direct de la fonction N1-A, sans lien avec le bail).
  const old = psqlRunner.run(url, ["-A", "-t", "-c", `select set_config('test.role', 'owner', false); set role authenticated; select public.set_merchant_notification_profile('${LEASE_RESTAURANT}', true, 'Resto A (ancien)', 'ancien@resto.example', null, 'fr');`]);
  assert.equal(old.status, 0, old.stderr);
  assert.equal(senderOf(url), "Resto A (ancien)", "témoin : sans le bail, le profil ancien REMPLACE le récent");
});

// --------------------------------------------------------------------
// R4 (contre-audit de c8e023e) : le rollback ne supprime la fonction sous bail QUE si elle est intacte
// --------------------------------------------------------------------
const LEASE_FN = "public.set_merchant_notification_profile_under_save_lease(uuid, uuid, boolean, text, text, text, text)";
const leasePresent = (url: string) => psqlQuery(url, `select to_regprocedure('${LEASE_FN}') is not null;`);
const leaseBodyMd5 = (url: string) => psqlQuery(url, `select md5(prosrc) from pg_proc where oid = '${LEASE_FN}'::regprocedure;`);
const leaseBodyEdit = (url: string, from: string, to: string) =>
  psqlQuery(url, `do $x$ declare s text; begin select pg_get_functiondef('${LEASE_FN}'::regprocedure) into s; execute replace(s, '${from}', '${to}'); end $x$;`);

test("[SMTP-PG-N] PostgreSQL réel -- rollback SMTP : fonction sous bail dérivée (STRICT = reproduction du contre-audit, puis corps, puis droits) : REFUSÉ dans les deux modes psql, sans mutation ; remise en l'état => rollback réussi", OPTS, () => {
  const url = newDb();
  const nominalBody = leaseBodyMd5(url);
  const claimBefore = bodyMd5(url);

  // 1. ALTER FUNCTION ... STRICT : avant R4, le rollback réussissait et supprimait cette fonction modifiée.
  psqlQuery(url, `alter function ${LEASE_FN} strict;`);
  assertRefused(url, RBSMTP, "rb-lease-strict", /set_merchant_notification_profile_under_save_lease/);
  assert.equal(leasePresent(url), "t", "la fonction n'a pas été supprimée");
  assert.equal(psqlQuery(url, `select proisstrict from pg_proc where oid = '${LEASE_FN}'::regprocedure;`), "t", "elle est restée STRICT, telle qu'observée");
  psqlQuery(url, `alter function ${LEASE_FN} called on null input;`);

  // 2. Corps modifié (FOR UPDATE -> FOR SHARE).
  leaseBodyEdit(url, "for update of c", "for share of c");
  assert.notEqual(leaseBodyMd5(url), nominalBody, "le corps a réellement changé");
  assertRefused(url, RBSMTP, "rb-lease-body", /le corps de set_merchant_notification_profile_under_save_lease/);
  assert.equal(leasePresent(url), "t");
  leaseBodyEdit(url, "for share of c", "for update of c");
  assert.equal(leaseBodyMd5(url), nominalBody, "corps remis à l'identique (octets exacts)");

  // 3. Droit EXECUTE en plus.
  psqlQuery(url, `grant execute on function ${LEASE_FN} to audit_extra;`);
  assertRefused(url, RBSMTP, "rb-lease-acl", /droits d'exécution ou propriétaire de set_merchant_notification_profile_under_save_lease/);
  assert.equal(leasePresent(url), "t");
  psqlQuery(url, `revoke execute on function ${LEASE_FN} from audit_extra;`);

  // Rien n'a bougé pendant les refus : le coffre et le claim SMTP sont en place.
  assert.equal(hasVault(url), "t");
  assert.equal(bodyMd5(url), claimBefore);

  // 4. Remise en l'état => le rollback passe, la fonction part avec le coffre, #180 est restauré.
  const rb = psqlFile(url, "rb-lease-ok.sql", RBSMTP, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(leasePresent(url), "f");
  assert.equal(hasVault(url), "f");
  assert.equal(bodyMd5(url), BODY_180);
});
