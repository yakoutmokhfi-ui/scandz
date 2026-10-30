import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";

/**
 * PLANCK190-04 -- rollback CONCURRENT : preuve sur un VRAI serveur PostgreSQL, plusieurs
 * connexions. PGlite est mono-connexion et ne peut pas montrer ce défaut.
 *
 * Scénario : une transaction W écrit `vacuum_packing_requested = true` et n'a PAS encore
 * validé; on lance le rollback. Avant correctif, son contrôle anti-perte ne voyait pas
 * l'écriture, attendait son commit au DROP COLUMN, puis SUPPRIMAIT le choix. Après
 * correctif, le verrou initial attend W, voit le choix validé et REFUSE.
 *
 * Nécessite les binaires PostgreSQL du système et root (serveur lancé sous l'utilisateur
 * `postgres`). Sinon le test est SAUTÉ explicitement -- jamais un faux succès silencieux.
 */
const binDir = (() => {
  try {
    const base = "/usr/lib/postgresql";
    const v = readdirSync(base).sort().reverse().find((d) => existsSync(`${base}/${d}/bin/initdb`));
    return v ? `${base}/${v}/bin` : null;
  } catch { return null; }
})();
const canRun = binDir !== null && process.getuid?.() === 0 && existsSync("/usr/bin/psql") && existsSync("/usr/sbin/runuser");
const skip = canRun ? false : "PostgreSQL système + root requis (initdb/psql/runuser) : test de concurrence sauté";

/**
 * AUD190-HARNESS-01 -- ISOLATION DU HARNAIS.
 *
 * libpq lit de nombreuses variables d'environnement (PGHOSTADDR, PGHOST, PGPORT, PGSERVICE*,
 * PGPASSFILE, PGOPTIONS, PGUSER, PGDATABASE...) et des fichiers du HOME. Hérités, ils peuvent
 * rediriger un `psql` du harnais vers une AUTRE base -- et ce harnais crée des bases, des rôles,
 * des tables et exécute des scripts. Garde-fous :
 *   1. chaque processus enfant reçoit un environnement CONSTRUIT explicitement (jamais
 *      `process.env`) : aucune variable PG*, HOME et PGSYSCONFDIR dans un répertoire jetable vide;
 *   2. l'instance est désignée par trois paramètres explicites (socket Unix du répertoire jetable,
 *      port, utilisateur) et son IDENTITÉ est vérifiée -- nonce secret passé au démarrage, socket,
 *      répertoire de données, absence d'écoute TCP -- AVANT toute création de base/rôle/table et
 *      avant l'exécution de tout script; sinon le harnais REFUSE (SCANYM_HARNESS_WRONG_INSTANCE);
 *   3. aucune valeur d'environnement n'est journalisée; ce test ne vise jamais une base hébergée.
 */
const PORT = 54000 + Math.floor(Math.random() * 900);
const SOCK = mkdtempSync(path.join(os.tmpdir(), "vp-pg-"));
const DATA = path.join(SOCK, "data");
const NONCE = randomBytes(16).toString("hex");
chmodSync(SOCK, 0o777);
mkdirSync(path.join(SOCK, "home"));
chmodSync(path.join(SOCK, "home"), 0o755);

type Endpoint = { sock: string; port: number; nonce: string; data: string };
const ME: Endpoint = { sock: SOCK, port: PORT, nonce: NONCE, data: DATA };

/** Environnement EXPLICITE : aucune variable héritée (y compris PG*). */
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${binDir ?? ""}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: path.join(SOCK, "home"),
    PGSYSCONFDIR: path.join(SOCK, "home"),
    LANG: "C", LC_ALL: "C",
    // Les corps de fonction référencent des tables hors périmètre (restaurants...) : validation désactivée.
    PGOPTIONS: "-c check_function_bodies=off",
  };
}
const asPg = (cmd: string, args: string[]) =>
  execFileSync("/usr/sbin/runuser", ["-u", "postgres", "--", cmd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
const psqlArgs = (ep: Endpoint, db: string) => ["-h", ep.sock, "-p", String(ep.port), "-U", "postgres", "-d", db, "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1"];

/** Contrôle d'identité, en LECTURE SEULE : à appeler avant toute mutation. */
function assertIsolated(ep: Endpoint): void {
  let out: string;
  try {
    out = execFileSync("/usr/bin/psql", [...psqlArgs(ep, "postgres"), "-At", "-F", "|", "-c",
      "select coalesce(current_setting('vp.nonce', true),'-'), current_setting('data_directory'), coalesce(inet_server_addr()::text,'unix'), current_setting('listen_addresses'), current_setting('unix_socket_directories')"],
      { encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
  } catch {
    throw new Error("SCANYM_HARNESS_WRONG_INSTANCE: instance injoignable ou refusée (aucune mutation effectuée)");
  }
  const [nonce, dataDir, addr, listen, sockDirs] = out.split("|");
  if (nonce !== ep.nonce || dataDir !== ep.data || addr !== "unix" || listen !== "" || !sockDirs.split(",").map((x) => x.trim()).includes(ep.sock)) {
    // Aucune valeur n'est recopiée dans le message : seulement quels contrôles ont échoué.
    const failed = [nonce !== ep.nonce && "nonce", dataDir !== ep.data && "data_directory", addr !== "unix" && "transport", listen !== "" && "listen_addresses", !sockDirs.split(",").map((x) => x.trim()).includes(ep.sock) && "socket"].filter(Boolean).join(",");
    throw new Error(`SCANYM_HARNESS_WRONG_INSTANCE: identité non conforme (${failed}) -- aucune mutation effectuée`);
  }
}
const psql = (ep: Endpoint, db: string, sqlText: string) => {
  assertIsolated(ep);
  return execFileSync("/usr/bin/psql", [...psqlArgs(ep, db), "-At", "-c", sqlText], { encoding: "utf8", env: cleanEnv() }).trim();
};
const psqlFile = (ep: Endpoint, db: string, file: string) => {
  assertIsolated(ep);
  return execFileSync("/usr/bin/psql", [...psqlArgs(ep, db), "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
};

let started = false;
const ready = (async () => {
  if (!canRun) return;
  asPg(`${binDir}/initdb`, ["-D", DATA, "--auth=trust", "-U", "postgres", "-A", "trust"]);
  asPg(`${binDir}/pg_ctl`, ["-D", DATA, "-o", `-c listen_addresses='' -c unix_socket_directories=${SOCK} -p ${PORT} -c vp.nonce=${NONCE}`, "-l", path.join(SOCK, "log"), "-w", "start"]);
  started = true;
  assertIsolated(ME); // la première connexion est un contrôle d'identité en lecture seule
})();
after(() => {
  if (started) { try { asPg(`${binDir}/pg_ctl`, ["-D", DATA, "-m", "immediate", "stop"]); } catch { /* arrêt best-effort */ } }
  try { rmSync(SOCK, { recursive: true, force: true }); } catch { /* idem */ }
});

const read = (f: string) => readFileSync(f, "utf8").replaceAll("\r\n", "\n");
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ORDER = uuid(1001);

function setupSql(): string {
  const lotd = read("supabase/migration-lotd-establishment-creation.sql")
    .match(/create function public\.is_scanym_operator\(\)[\s\S]*?grant execute on function public\.is_scanym_operator\(\) to authenticated;/)![0];
  const acl = read("supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql")
    .match(/create or replace function public\.assert_category_role\([\s\S]*?\nend \$\$;/)![0];
  const SIG = "public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)";
  return `
    set check_function_bodies = off;
    do $r$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; create role authenticated; create role service_role; end if; end $r$;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    create table public.restaurant_users (user_id uuid, restaurant_id uuid, role text);
    create table public.scanym_operators (user_id uuid);
    create table public.menu_categories (id uuid primary key, restaurant_id uuid not null, name text not null);
    create table public.menu_items (id uuid primary key, category_id uuid not null references public.menu_categories(id), name text not null);
    create table public.orders (id uuid primary key, payment_status text not null default 'not_required');
    create table public.order_items (id serial primary key, order_id uuid not null references public.orders(id), menu_item_id uuid not null);
    insert into public.orders(id) values ('${ORDER}');
    ${lotd}
    ${acl}
    ${read("tests/fixtures/create-order-hosted-5ed0f3e2.sql")};
    revoke all on function ${SIG} from public; grant execute on function ${SIG} to anon, authenticated;
  `;
}

async function freshDb(name: string, ep: Endpoint = ME): Promise<void> {
  await ready;
  assertIsolated(ep); // AVANT toute création de base / rôle / table / script
  psql(ep, "postgres", `create database ${name}`);
  const setup = path.join(ep.sock, `${name}-setup.sql`);
  writeFileSync(setup, setupSql());
  psqlFile(ep, name, setup);
  psqlFile(ep, name, path.resolve("supabase/DRAFT-lot-vacuum-packing-option-v1.sql"));
}

/** Ouvre la transaction W (écriture NON validée), lance le rollback, laisse W valider. */
async function raceRollback(db: string, rollbackFile: string) {
  assertIsolated(ME);
  const w: ChildProcessWithoutNullStreams = spawn("/usr/bin/psql", psqlArgs(ME, db), { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
  let wOut = "";
  w.stdout.on("data", (d) => { wOut += d; });
  w.stdin.write(`begin; update public.orders set vacuum_packing_requested = true where id = '${ORDER}'; select 'W_READY';\n`);
  for (let i = 0; i < 100 && !wOut.includes("W_READY"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(wOut.includes("W_READY"), "la transaction concurrente a écrit sans valider");

  const rb = spawn("/usr/bin/psql", [...psqlArgs(ME, db), "-f", rollbackFile], { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
  let rbErr = "";
  let rbExit: number | null = null;
  rb.stderr.on("data", (d) => { rbErr += d; });
  rb.on("exit", (c) => { rbExit = c; });
  await new Promise((r) => setTimeout(r, 1500));
  w.stdin.write("commit;\n\\q\n");
  for (let i = 0; i < 300 && rbExit === null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.notEqual(rbExit, null, "le rollback se termine une fois W validée");
  return { rbExit: rbExit as unknown as number, rbErr, blockedWhileWOpen: true };
}

test("[VP-CONC-1] rollback concurrent : attend la transaction en cours, voit le choix VALIDÉ et REFUSE (aucune perte)", { skip }, async () => {
  await freshDb("vp_fixed");
  const r = await raceRollback("vp_fixed", path.resolve("supabase/DRAFT-lot-vacuum-packing-option-v1-rollback.sql"));
  assert.notEqual(r.rbExit, 0, "le rollback échoue");
  assert.match(r.rbErr, /SCANYM_ROLLBACK_DATA_LOSS/);
  assert.equal(psql(ME, "vp_fixed", "select vacuum_packing_requested from public.orders where id='" + ORDER + "'"), "t", "le choix est INTACT");
  assert.equal(psql(ME, "vp_fixed", "select count(*) from information_schema.columns where table_name='orders' and column_name='vacuum_packing_requested'"), "1");
  assert.match(psql(ME, "vp_fixed", "select pg_get_functiondef(to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'))"), /VACUUM-PACKING BEGIN/, "create_order non restauré : état cohérent");
});

test("[VP-CONC-2] CONTRÔLE NÉGATIF : sans le verrou initial, le même scénario DÉTRUIT le choix (le test détecte bien le défaut)", { skip }, async () => {
  await freshDb("vp_unfixed");
  const stripped = read("supabase/DRAFT-lot-vacuum-packing-option-v1-rollback.sql")
    .replace(/^set local lock_timeout.*$/m, "")
    .replace(/^lock table .*$/m, "");
  assert.doesNotMatch(stripped, /lock table/i);
  const file = path.join(SOCK, "rollback-unlocked.sql");
  writeFileSync(file, stripped);
  const r = await raceRollback("vp_unfixed", file);
  assert.equal(r.rbExit, 0, "sans verrou, le rollback réussit... et supprime la donnée");
  assert.equal(psql(ME, "vp_unfixed", "select count(*) from information_schema.columns where table_name='orders' and column_name='vacuum_packing_requested'"), "0", "colonne supprimée avec le choix validé = perte de données");
});

test("[VP-CONC-3] le verrou est pris AVANT tout contrôle, avec lock_timeout (échec propre plutôt qu'attente infinie)", () => {
  const src = read("supabase/DRAFT-lot-vacuum-packing-option-v1-rollback.sql").replace(/--.*$/gm, "");
  const iLock = src.indexOf("lock table public.orders, public.menu_categories in access exclusive mode");
  assert.ok(iLock > 0);
  assert.ok(src.indexOf("set local lock_timeout") > 0 && src.indexOf("set local lock_timeout") < iLock);
  assert.ok(iLock > src.indexOf("begin;") && iLock < src.indexOf("do $rb$"));
});

// ───────────────────────── AUD190-HARNESS-01 : isolation du harnais ─────────────────────────

/** Variables libpq hostiles, posées dans l'environnement du PROCESSUS DE TEST (jamais journalisées). */
const HOSTILE: Record<string, string> = {
  PGHOSTADDR: "127.0.0.1", PGHOST: "decoy.invalid", PGPORT: "1", PGUSER: "decoy_user", PGDATABASE: "decoy_db",
  PGSERVICE: "decoy_service", PGSERVICEFILE: "/nonexistent/pg_service.conf", PGPASSFILE: "/nonexistent/pgpass",
  PGOPTIONS: "-c search_path=decoy", PGSYSCONFDIR: "/nonexistent", PGSSLMODE: "require", PGCONNECT_TIMEOUT: "3",
};
async function withHostileEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(HOSTILE)) { saved[k] = process.env[k]; process.env[k] = HOSTILE[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(HOSTILE)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
/**
 * « Autre base » : un serveur TCP leurre sur 127.0.0.1:<port du harnais>, dans un PROCESSUS À PART
 * (les appels psql du harnais sont synchrones et bloqueraient un serveur du même processus : le
 * compteur resterait à zéro quoi qu'il arrive -- preuve vide). Chaque connexion ajoute une ligne
 * au fichier-compteur.
 */
async function withDecoy<T>(fn: (count: () => number) => Promise<T> | T): Promise<T> {
  const counter = path.join(SOCK, `decoy-${randomBytes(4).toString("hex")}.count`);
  writeFileSync(counter, "");
  const script = `const net=require("net"),fs=require("fs");
    net.createServer((s)=>{fs.appendFileSync(${JSON.stringify(counter)},"x\\n");s.destroy();}).listen(${PORT},"127.0.0.1",()=>console.log("READY"));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: cleanEnv().PATH } });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("leurre non démarré")), 10000);
    child.stdout.on("data", (d) => { if (String(d).includes("READY")) { clearTimeout(t); resolve(); } });
    child.once("exit", () => { clearTimeout(t); reject(new Error("leurre arrêté")); });
  });
  try { return await fn(() => readFileSync(counter, "utf8").split("\n").filter(Boolean).length); }
  finally { child.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 100)); }
}

test("[VP-HARNESS-1] environnement libpq hostile (PGHOSTADDR...) : AUCUNE tentative vers l'autre base, mutations seulement sur le cluster jetable", { skip }, async () => {
  await ready;
  await withDecoy(async (count) => {
    await withHostileEnv(async () => {
      assert.equal(process.env.PGHOSTADDR, "127.0.0.1", "l'environnement hostile est bien en place");
      assertIsolated(ME);
      await freshDb("vp_hostile");
      assert.equal(psql(ME, "vp_hostile", "select count(*) from public.orders"), "1", "setup exécuté sur le cluster jetable");
    });
    assert.equal(count(), 0, "le leurre n'a reçu AUCUNE connexion");
  });
});

test("[VP-HARNESS-2] CONTRÔLE NÉGATIF : un psql qui hérite de process.env EST redirigé par PGHOSTADDR (le risque est réel)", { skip }, async () => {
  await ready;
  await withDecoy(async (count) => {
    await withHostileEnv(async () => {
      try {
        // Appel « naïf » (seul PGHOSTADDR est conservé : un PGSERVICE bidon échouerait AVANT toute connexion)
        // ; : environnement hérité, mêmes arguments explicites que le harnais.
        execFileSync("/usr/bin/psql", [...psqlArgs(ME, "postgres"), "-At", "-c", "select 1"], { encoding: "utf8", env: { ...process.env, PATH: cleanEnv().PATH, ...Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("PG") && k !== "PGHOSTADDR").map((k) => [k, undefined])) }, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
      } catch { /* le leurre raccroche : l'échec est attendu, seule la tentative compte */ }
    });
    assert.ok(count() >= 1, "l'environnement hérité a bien détourné la connexion vers le leurre");
  });
});

test("[VP-HARNESS-3] mauvaise instance (autre serveur, ou nonce différent) : REFUS avant toute mutation", { skip }, async () => {
  await ready;
  // (a) un AUTRE vrai serveur PostgreSQL, sans le nonce du harnais
  const otherSock = mkdtempSync(path.join(os.tmpdir(), "vp-other-"));
  chmodSync(otherSock, 0o777);
  const otherData = path.join(otherSock, "data");
  const otherPort = PORT + 1;
  const other: Endpoint = { sock: otherSock, port: otherPort, nonce: NONCE, data: otherData };
  const otherStarted = (() => {
    asPg(`${binDir}/initdb`, ["-D", otherData, "--auth=trust", "-U", "postgres", "-A", "trust"]);
    asPg(`${binDir}/pg_ctl`, ["-D", otherData, "-o", `-c listen_addresses='' -c unix_socket_directories=${otherSock} -p ${otherPort}`, "-l", path.join(otherSock, "log"), "-w", "start"]);
    return true;
  })();
  try {
    assert.ok(otherStarted);
    assert.throws(() => assertIsolated(other), /SCANYM_HARNESS_WRONG_INSTANCE/);
    await assert.rejects(freshDb("vp_must_not_exist", other), /SCANYM_HARNESS_WRONG_INSTANCE/);
    // Vérification indépendante, lecture seule : rien n'a été créé sur l'autre serveur.
    const list = execFileSync("/usr/bin/psql", ["-h", otherSock, "-p", String(otherPort), "-U", "postgres", "-d", "postgres", "-X", "-At", "-c", "select string_agg(datname, ',') from pg_database"], { encoding: "utf8", env: cleanEnv() }).trim();
    assert.doesNotMatch(list, /vp_must_not_exist/);
    const roles = execFileSync("/usr/bin/psql", ["-h", otherSock, "-p", String(otherPort), "-U", "postgres", "-d", "postgres", "-X", "-At", "-c", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')"], { encoding: "utf8", env: cleanEnv() }).trim();
    assert.equal(roles, "0", "aucun rôle créé sur l'autre serveur");
  } finally {
    try { asPg(`${binDir}/pg_ctl`, ["-D", otherData, "-m", "immediate", "stop"]); } catch { /* best-effort */ }
    try { rmSync(otherSock, { recursive: true, force: true }); } catch { /* idem */ }
  }
  // (b) bon serveur mais nonce attendu différent : refus
  assert.throws(() => assertIsolated({ ...ME, nonce: "0".repeat(32) }), /SCANYM_HARNESS_WRONG_INSTANCE/);
  assert.throws(() => assertIsolated({ ...ME, data: "/not/the/data/dir" }), /SCANYM_HARNESS_WRONG_INSTANCE/);
});

test("[VP-HARNESS-4] le message de refus ne contient aucune valeur d'environnement ni de nonce", { skip }, async () => {
  await ready;
  let message = "";
  try { assertIsolated({ ...ME, nonce: "f".repeat(32) }); } catch (e) { message = (e as Error).message; }
  assert.match(message, /SCANYM_HARNESS_WRONG_INSTANCE/);
  assert.equal(message.includes(NONCE), false);
  for (const v of Object.values(HOSTILE)) assert.equal(message.includes(v) && v.length > 6, false);
});

test("[VP-HARNESS-5] statique : aucun enfant ne reçoit process.env ; chaque processus enfant a un environnement explicite", () => {
  const src = read("tests/vacuum-packing-rollback-concurrency.test.ts");
  const code = src.split("// ───────────────────────── AUD190-HARNESS-01")[0].replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/process\.env/.test(code), false, "aucune lecture de process.env dans le harnais");
  const calls: string[] = [];
  for (const m of code.matchAll(/\b(execFileSync|spawn)\(\s*(?:"|`)/g)) {
    let depth = 0, i = m.index! + m[1].length;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") { depth--; if (depth === 0) break; }
    }
    calls.push(code.slice(start, i + 1));
  }
  assert.ok(calls.length >= 6, `appels enfants détectés : ${calls.length}`);
  for (const call of calls) assert.match(call, /env:\s*cleanEnv\(\)/, `environnement explicite requis : ${call.slice(0, 70)}`);
});
