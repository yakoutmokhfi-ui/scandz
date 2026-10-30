import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync, chmodSync, writeFileSync, rmSync } from "node:fs";
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

const PORT = 54000 + Math.floor(Math.random() * 900);
const SOCK = mkdtempSync(path.join(os.tmpdir(), "vp-pg-"));
const DATA = path.join(SOCK, "data");
chmodSync(SOCK, 0o777);
const asPg = (cmd: string, args: string[]) => execFileSync("/usr/sbin/runuser", ["-u", "postgres", "--", cmd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const psqlArgs = (db: string) => ["-h", SOCK, "-p", String(PORT), "-U", "postgres", "-d", db, "-X", "-q", "-v", "ON_ERROR_STOP=1"];
// Les corps de fonction référencent des tables hors périmètre (restaurants...) : validation désactivée.
process.env.PGOPTIONS = "-c check_function_bodies=off";
const psql = (db: string, sqlText: string) => execFileSync("/usr/bin/psql", [...psqlArgs(db), "-At", "-c", sqlText], { encoding: "utf8" }).trim();
const psqlFile = (db: string, file: string) => execFileSync("/usr/bin/psql", [...psqlArgs(db), "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let started = false;
const ready = (async () => {
  if (!canRun) return;
  asPg(`${binDir}/initdb`, ["-D", DATA, "--auth=trust", "-U", "postgres", "-A", "trust"]);
  asPg(`${binDir}/pg_ctl`, ["-D", DATA, "-o", `-c listen_addresses='' -c unix_socket_directories=${SOCK} -p ${PORT}`, "-l", path.join(SOCK, "log"), "-w", "start"]);
  started = true;
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

async function freshDb(name: string): Promise<void> {
  await ready;
  psql("postgres", `create database ${name}`);
  const setup = path.join(SOCK, `${name}-setup.sql`);
  writeFileSync(setup, setupSql());
  psqlFile(name, setup);
  psqlFile(name, path.resolve("supabase/DRAFT-lot-vacuum-packing-option-v1.sql"));
}

/** Ouvre la transaction W (écriture NON validée), lance le rollback, laisse W valider. */
async function raceRollback(db: string, rollbackFile: string) {
  const w: ChildProcessWithoutNullStreams = spawn("/usr/bin/psql", psqlArgs(db), { stdio: ["pipe", "pipe", "pipe"] });
  let wOut = "";
  w.stdout.on("data", (d) => { wOut += d; });
  w.stdin.write(`begin; update public.orders set vacuum_packing_requested = true where id = '${ORDER}'; select 'W_READY';\n`);
  for (let i = 0; i < 100 && !wOut.includes("W_READY"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(wOut.includes("W_READY"), "la transaction concurrente a écrit sans valider");

  const rb = spawn("/usr/bin/psql", [...psqlArgs(db), "-f", rollbackFile], { stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(psql("vp_fixed", "select vacuum_packing_requested from public.orders where id='" + ORDER + "'"), "t", "le choix est INTACT");
  assert.equal(psql("vp_fixed", "select count(*) from information_schema.columns where table_name='orders' and column_name='vacuum_packing_requested'"), "1");
  assert.match(psql("vp_fixed", "select pg_get_functiondef(to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'))"), /VACUUM-PACKING BEGIN/, "create_order non restauré : état cohérent");
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
  assert.equal(psql("vp_unfixed", "select count(*) from information_schema.columns where table_name='orders' and column_name='vacuum_packing_requested'"), "0", "colonne supprimée avec le choix validé = perte de données");
});

test("[VP-CONC-3] le verrou est pris AVANT tout contrôle, avec lock_timeout (échec propre plutôt qu'attente infinie)", () => {
  const src = read("supabase/DRAFT-lot-vacuum-packing-option-v1-rollback.sql").replace(/--.*$/gm, "");
  const iLock = src.indexOf("lock table public.orders, public.menu_categories in access exclusive mode");
  assert.ok(iLock > 0);
  assert.ok(src.indexOf("set local lock_timeout") > 0 && src.indexOf("set local lock_timeout") < iLock);
  assert.ok(iLock > src.indexOf("begin;") && iLock < src.indexOf("do $rb$"));
});
