import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PgTargetRefused,
  assertAsciiSqlArgv,
  assertLoopbackServerAddress,
  cleanPgEnv,
  createPsqlRunner,
  isLoopbackServerAddress,
  parseLocalPgUrl,
  psqlTargetArgs,
} from "./helpers/pg-local-guard.ts";

// ====================================================================
// PR #196 R3 (P1) -- « Harnais PostgreSQL redirigeable par PGHOSTADDR, malgré l'URL locale ».
// Ces tests ne demandent AUCUN PostgreSQL : ils prouvent, avec un faux psql, que
//   - aucune variable libpq héritée n'arrive au processus enfant ;
//   - la cible est désignée par drapeaux (-h/-p/-U/-d), pas par une URL réinterprétable ;
//   - un paramètre d'URL (hostaddr=, host=, service=...) est refusé AVANT tout lancement ;
//   - une adresse serveur non locale (ou inconnue) bloque toute création de base / tout script.
// Le rejeu sur un vrai PostgreSQL est dans tests/merchant-smtp-notifications-preflight-pg.test.ts
// ([SMTP-PG-K], opt-in).
// ====================================================================

const dir = mkdtempSync(path.join(tmpdir(), "scanym-pg-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Next ajoute NODE_ENV (requis) au type ProcessEnv : l'environnement hostile du test est volontairement partiel.
const HOSTILE = {
  PATH: process.env.PATH,
  PGHOSTADDR: "192.0.2.1",
  PGHOST: "192.0.2.1",
  PGPORT: "1",
  PGSERVICE: "ailleurs",
  PGSERVICEFILE: "/etc/ailleurs.conf",
  PGSYSCONFDIR: "/etc/ailleurs",
  PGUSER: "intrus",
  PGDATABASE: "intrus",
  PGOPTIONS: "-c search_path=intrus",
  PGPASSFILE: "/home/intrus/.pgpass",
  PGSSLMODE: "disable",
  PGTARGETSESSIONATTRS: "any",
  pghostaddr: "192.0.2.2", // Windows ne respecte pas la casse des noms de variables
} as unknown as NodeJS.ProcessEnv;

// ----- analyse de la cible -------------------------------------------------
test("[PG-GUARD-1] cible : seules les URL de boucle locale sans paramètre sont acceptées, analysées en champs", () => {
  assert.deepEqual(parseLocalPgUrl("postgresql://postgres@127.0.0.1:55432/postgres"), { host: "127.0.0.1", port: "55432", user: "postgres", password: null, database: "postgres" });
  assert.deepEqual(parseLocalPgUrl("postgres://u:p%40ss@[::1]:5433/scanym_smtp_x"), { host: "::1", port: "5433", user: "u", password: "p@ss", database: "scanym_smtp_x" });
  assert.equal(parseLocalPgUrl("postgresql://postgres@localhost/postgres").port, "5432");
});

const REFUSED: Array<[string, string]> = [
  ["hostaddr= (remplace l'adresse de l'URL)", "postgresql://postgres@127.0.0.1:55432/postgres?hostaddr=192.0.2.1"],
  ["host=", "postgresql://postgres@127.0.0.1:55432/postgres?host=192.0.2.1"],
  ["service=", "postgresql://postgres@127.0.0.1:55432/postgres?service=ailleurs"],
  ["options=", "postgresql://postgres@127.0.0.1:55432/postgres?options=-c%20search_path%3Dx"],
  ["'?' vide", "postgresql://postgres@127.0.0.1:55432/postgres?"],
  ["fragment", "postgresql://postgres@127.0.0.1:55432/postgres#x"],
  ["hôte distant", "postgresql://postgres@192.0.2.1:5432/postgres"],
  ["nom d'hôte quelconque", "postgresql://postgres@db.exemple.test:5432/postgres"],
  ["préfixe de nom local", "postgresql://postgres@localhost.exemple.test/postgres"],
  ["deux « @ » (analyseurs divergents)", "postgresql://x@192.0.2.1@127.0.0.1:55432/postgres"],
  ["mot de passe avec « @ » NON encodé (libpq et WHATWG ne découpent pas l'autorité pareil ; seule la règle « un seul @ » le refuse)", "postgresql://postgres:pa@ss@127.0.0.1:55432/postgres"],
  ["deux « @ » dont le dernier est local, rôle valide (libpq lirait l'hôte avant le second @)", "postgresql://postgres@192.0.2.1:5432@127.0.0.1:55432/postgres"],
  ["plusieurs hôtes", "postgresql://postgres@127.0.0.1,192.0.2.1:55432/postgres"],
  ["hôte vide (socket Unix)", "postgresql://postgres@/postgres"],
  ["port non numérique", "postgresql://postgres@127.0.0.1:abc/postgres"],
  ["port hors plage", "postgresql://postgres@127.0.0.1:99999/postgres"],
  ["base = chaîne de connexion", "postgresql://postgres@127.0.0.1:55432/host=192.0.2.1"],
  ["base = URI", "postgresql://postgres@127.0.0.1:55432/postgresql:%2F%2F192.0.2.1%2Fx"],
  ["base absente", "postgresql://postgres@127.0.0.1:55432/"],
  ["rôle invalide", "postgresql://po%20stgres@127.0.0.1:55432/postgres"],
  ["autre schéma", "http://postgres@127.0.0.1:55432/postgres"],
  ["chaîne vide", ""],
];
for (const [label, url] of REFUSED) {
  test(`[PG-GUARD-2] cible refusée : ${label}`, () => {
    assert.throws(() => parseLocalPgUrl(url), (error: unknown) => error instanceof PgTargetRefused && /SCANYM_HARNESS_TARGET_REFUSED/.test(String(error)));
  });
}

test("[PG-GUARD-3] la cible est passée par DRAPEAUX (jamais par URL/conninfo) et sans invite de mot de passe", () => {
  const args = psqlTargetArgs(parseLocalPgUrl("postgresql://postgres@127.0.0.1:55432/postgres"));
  assert.deepEqual(args, ["-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "postgres", "-w"]);
  assert.ok(!args.some((a) => /:\/\/|=/.test(a)));
});

// ----- environnement enfant ------------------------------------------------
test("[PG-GUARD-4] environnement enfant : aucune variable PG* héritée, quelle que soit la casse ; seuls PATH & co et la cible passent", () => {
  const target = parseLocalPgUrl("postgresql://postgres@127.0.0.1:55432/postgres");
  const env = cleanPgEnv(target, HOSTILE, dir);
  const pg = Object.keys(env).filter((k) => /^pg/i.test(k)).sort();
  assert.deepEqual(pg, ["PGCONNECT_TIMEOUT", "PGSYSCONFDIR"], "seules les deux variables posées par le harnais subsistent");
  assert.equal(env.PGSYSCONFDIR, dir, "pg_service.conf du système/utilisateur n'est pas lu");
  assert.equal(env.HOME, dir);
  assert.equal(env.PATH, process.env.PATH);
  for (const hostile of ["PGHOSTADDR", "PGHOST", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGUSER", "PGDATABASE", "PGOPTIONS", "PGPASSFILE", "PGSSLMODE", "PGTARGETSESSIONATTRS", "pghostaddr"]) {
    assert.ok(!(hostile in env), `${hostile} ne doit pas atteindre psql`);
  }
  const withPassword = cleanPgEnv({ ...target, password: "secret-de-test" }, HOSTILE, dir);
  assert.equal(withPassword.PGPASSWORD, "secret-de-test", "le mot de passe de la cible (et lui seul) est transmis");
});

// ----- adresse réelle du serveur ------------------------------------------
test("[PG-GUARD-5] adresse du serveur : seule la boucle locale est admise ; vide/inconnue/distante → refus", () => {
  for (const ok of ["127.0.0.1", "127.0.0.2/32", "::1", "::1/128", "::ffff:127.0.0.1", "127.255.255.254\n"]) assert.equal(isLoopbackServerAddress(ok), true, ok);
  for (const bad of ["", "   ", "192.0.2.1", "10.0.0.5", "169.254.1.1", "::2", "2001:db8::1", "128.0.0.1", "localhost", "unix", "127.0.0.1.evil"]) assert.equal(isLoopbackServerAddress(bad), false, bad);
  assert.throws(() => assertLoopbackServerAddress("192.0.2.1"), PgTargetRefused);
  assert.throws(() => assertLoopbackServerAddress(""), PgTargetRefused);
});

// ----- câblage réel : faux psql, mêmes appels de processus que le harnais ------------
const FAKE = path.join(dir, "fake-psql.mjs");
const CALLS = path.join(dir, "calls.jsonl");
const ADDR = path.join(dir, "addr.txt");
writeFileSync(FAKE, `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const cIdx = args.indexOf("-c");
const isProbe = cIdx >= 0 && /inet_server_addr/.test(args[cIdx + 1] ?? "");
appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ probe: isProbe, args, pg: Object.keys(process.env).filter((k) => /^pg/i.test(k)).sort() }) + "\\n");
if (isProbe) { process.stdout.write(readFileSync(${JSON.stringify(ADDR)}, "utf8")); process.exit(0); }
process.stdout.write("ok");
`);
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { probe: boolean; args: string[]; pg: string[] }) : []);
const reset = (addr: string) => { rmSync(CALLS, { force: true }); writeFileSync(ADDR, addr); };
const runner = () => createPsqlRunner({ bin: process.execPath, binPrefixArgs: [FAKE], baseEnv: HOSTILE, isolatedHome: dir });

test("[PG-GUARD-6] câblage : avec PGHOSTADDR/PGHOST/... hostiles, psql reçoit -h 127.0.0.1 -p 55432 et AUCUNE variable de redirection", () => {
  reset("127.0.0.1");
  const r = runner().run("postgresql://postgres@127.0.0.1:55432/postgres", ["-c", "create database scanym_x"]);
  assert.equal(r.status, 0, r.stderr);
  const seen = calls();
  assert.equal(seen.length, 2, "une sonde d'identité en lecture seule, puis la commande demandée");
  assert.equal(seen[0]!.probe, true, "la sonde passe AVANT la commande");
  for (const call of seen) {
    assert.deepEqual(call.pg, ["PGCONNECT_TIMEOUT", "PGSYSCONFDIR"], `variables PG* vues par psql : ${call.pg.join(",")}`);
    assert.deepEqual(call.args.slice(call.args.indexOf("-h"), call.args.indexOf("-h") + 8), ["-h", "127.0.0.1", "-p", "55432", "-U", "postgres", "-d", "postgres"]);
  }
});

test("[PG-GUARD-7] câblage : serveur joint à une adresse NON locale (tunnel, hôte redirigé) → refus avant toute commande", () => {
  for (const addr of ["192.0.2.1", "10.1.2.3", "", "2001:db8::5"]) {
    reset(addr);
    assert.throws(() => runner().run("postgresql://postgres@127.0.0.1:55432/postgres", ["-c", "create database scanym_x"]), PgTargetRefused, addr);
    assert.deepEqual(calls().map((c) => c.probe), [true], `adresse « ${addr} » : seule la sonde en lecture seule a tourné, aucun create database`);
  }
});

test("[PG-GUARD-8] câblage : URL avec hostaddr=/host=/service= → refus avant tout lancement de psql (aucun processus)", () => {
  reset("127.0.0.1");
  for (const bad of ["?hostaddr=192.0.2.1", "?host=192.0.2.1", "?service=ailleurs"]) {
    assert.throws(() => runner().run(`postgresql://postgres@127.0.0.1:55432/postgres${bad}`, ["-c", "create database scanym_x"]), PgTargetRefused, bad);
    assert.throws(() => runner().session(`postgresql://postgres@127.0.0.1:55432/postgres${bad}`, []), PgTargetRefused, bad);
  }
  assert.deepEqual(calls(), [], "aucun processus psql lancé");
});

test("[PG-GUARD-9] câblage : la sonde est faite une fois par serveur (host:port) puis mémorisée ; session() passe par les mêmes garde-fous", async () => {
  reset("127.0.0.1");
  const r = runner();
  r.run("postgresql://postgres@127.0.0.1:55432/postgres", ["-c", "select 1"]);
  r.run("postgresql://postgres@127.0.0.1:55432/scanym_a", ["-c", "select 2"]);
  assert.deepEqual(calls().map((c) => c.probe), [true, false, false]);
  const child = r.session("postgresql://postgres@127.0.0.1:55432/scanym_a", ["-c", "select 3"]);
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const last = calls().at(-1)!;
  assert.deepEqual(last.pg, ["PGCONNECT_TIMEOUT", "PGSYSCONFDIR"]);
});

// ----- R5 : SQL non ASCII dans l'argv de `psql -c` (limite Windows signalée par le contre-audit de 2431eba) -----
test("[PG-GUARD-10] R5 : un SQL non ASCII passé à `-c` est refusé AVANT tout lancement (aucun processus), run() comme session(), avec le caractère fautif nommé", () => {
  reset("127.0.0.1");
  const accentue = "comment on function f() is 'commentaire alt\u00e9r\u00e9'";
  assert.throws(() => assertAsciiSqlArgv(["-A", "-c", accentue]), /SCANYM_HARNESS_SQL_NOT_ASCII.*U\+00E9.*position 43/);
  assert.throws(() => runner().run("postgresql://postgres@127.0.0.1:55432/postgres", ["-A", "-t", "-c", accentue]), /SCANYM_HARNESS_SQL_NOT_ASCII/);
  assert.throws(() => runner().session("postgresql://postgres@127.0.0.1:55432/postgres", ["-c", accentue]), /SCANYM_HARNESS_SQL_NOT_ASCII/);
  // Un commentaire SQL accentué compte aussi : c'est ce qui avait fait échouer snapshot() sous Windows.
  assert.throws(() => assertAsciiSqlArgv(["-c", "select 1; -- d\u00e9j\u00e0\nselect 2"]), /SCANYM_HARNESS_SQL_NOT_ASCII/);
  // Caractère hors plan de base : la position et le point de code sont ceux du caractère, pas d'une moitié de paire de substitution.
  assert.throws(() => assertAsciiSqlArgv(["-c", "select '\u{1F600}'"]), /U\+1F600/);
  assert.deepEqual(calls(), [], "aucun processus psql lancé, pas même la sonde d'identité");
});

test("[PG-GUARD-11] R5 : le garde-fou ne vise QUE le SQL de `-c` -- ASCII, échappements ASCII (E'\\u00e9'), fichiers -f et chemins accentués restent admis", () => {
  reset("127.0.0.1");
  assertAsciiSqlArgv(["-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "select E'alt\\u00e9r\\u00e9', 'tab\there';"]);
  assertAsciiSqlArgv(["-v", "ON_ERROR_STOP=1", "-f", "C:\\Users\\Zo\u00e9\\scanym\\smtp.sql"]); // un CHEMIN n'est pas du SQL
  assertAsciiSqlArgv(["-c"]); // « -c » en dernière position : rien à contrôler (psql refusera lui-même)
  const r = runner().run("postgresql://postgres@127.0.0.1:55432/postgres", ["-A", "-t", "-c", "select E'alt\\u00e9r\\u00e9'"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls().filter((c) => !c.probe).length, 1, "la commande ASCII est bien transmise à psql");
});

test("[PG-GUARD-12] R5 : plus aucun SQL non ASCII dans les appels `-c` du test PostgreSQL SMTP (statique, sans PostgreSQL)", () => {
  // Les gabarits SQL de ce fichier sont envoyés par psqlQuery / psqlRunner.run(..., "-c", ...). On vérifie, dans les
  // littéraux gabarit qui contiennent du SQL, l'absence de caractère non ASCII HORS commentaires JS et messages d'assertion.
  // Périmètre volontairement limité au fichier de CETTE PR : tests/v172-order-received-payment-gate-preflight-pg.test.ts
  // (antérieur, non modifié par #196) a le même défaut latent (« COMPLÈTES » dans le SQL de snapshot()) -- signalé dans la PR.
  for (const file of ["merchant-smtp-notifications-preflight-pg.test.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const calls: string[] = [];
    // psqlQuery(url, `...`) et ["-A", "-t", "-c", `...`] : le SQL est le littéral gabarit de l'appel.
    for (const m of source.matchAll(/(?:psqlQuery\(\s*\w+(?:\.\w+)*\s*,\s*|"-c"\s*,\s*)`((?:[^`\\]|\\[\s\S])*)`/g)) calls.push(m[1]!);
    assert.ok(calls.length >= 5, `${file} : appels -c retrouvés (${calls.length})`);
    for (const sql of calls) assert.doesNotThrow(() => assertAsciiSqlArgv(["-c", sql]), `${file} : SQL non ASCII dans « ${sql.slice(0, 60).replace(/\s+/g, " ")}… »`);
  }
});
