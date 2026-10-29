import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ====================================================================
// ISSUE #172 / T180-02 (constat R3 du contre-audit) — PRÉ-VOL ET ROLLBACK
// SQL sur un VRAI PostgreSQL : le lot et son retour arrière refusent, AVANT
// toute écriture, un prédécesseur dont les attributs (STRICT…) ou les droits
// (bénéficiaire EXECUTE en plus…) diffèrent de l'état attendu.
//
// POURQUOI CE FICHIER EN PLUS DE tests/v172-order-received-payment-gate.test.ts
// (PGlite) : les deux contre-exemples de l'auditeur (STRICT écrasé, rôle
// supplémentaire conservé) ont été établis sur un vrai PostgreSQL ; on les
// rejoue donc ici, avec le VRAI client psql, dans les DEUX modes opérateur :
// ON_ERROR_STOP=1 (le script s'arrête) et ON_ERROR_STOP=0 (psql continue après
// l'erreur -- la transaction avortée doit empêcher toute DDL suivante).
//
// EXÉCUTION -- opt-in, comme tests/v172-order-received-payment-gate-
// concurrency-pg.test.ts : sans SCANYM_TEST_PG_ADMIN_URL, chaque test est
// SAUTÉ avec sa raison (aucune preuve sur PostgreSQL réel n'est alors
// produite). Boucle locale uniquement ; bases `scanym_t180p_*` jetables et
// données 100 % synthétiques ; rôles de test créés puis supprimés.
//
//   SCANYM_TEST_PG_ADMIN_URL  ex. postgresql://postgres@127.0.0.1:55432/postgres
//   SCANYM_TEST_PSQL          (optionnel) chemin de psql ; défaut `psql`
// ====================================================================

const ADMIN_URL = process.env.SCANYM_TEST_PG_ADMIN_URL;
const PSQL = process.env.SCANYM_TEST_PSQL || "psql";

function loopbackOnly(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`SCANYM_TEST_PG_ADMIN_URL doit désigner la boucle locale (reçu : ${host})`);
  }
}

const SKIP_REASON = ADMIN_URL
  ? false
  : "SCANYM_TEST_PG_ADMIN_URL absent : le pré-vol/rollback n'est PAS rejoué sur un PostgreSQL RÉEL ici (la couverture PGlite reste exécutée par tests/v172-order-received-payment-gate.test.ts)";

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const LOT = sql("DRAFT-lot-order-received-payment-gate-v1.sql");
const ROLLBACK = sql("DRAFT-lot-order-received-payment-gate-v1-rollback.sql");
const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
const N1A_CLAIM = N1A.match(/create function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];
const CLAIM_FN = "public.claim_pending_notifications(integer, integer)";

const workDir = mkdtempSync(path.join(tmpdir(), "scanym-t180p-"));
const databases: string[] = [];
const TEST_ROLES = ["audit_extra", "audit_other_owner"];

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

function psqlFile(dbUrl: string, name: string, content: string, onErrorStop: boolean): { status: number | null; out: string } {
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

/** Base jetable : prédécesseur N1-A réel + variante éventuelle ; le lot est appliqué ensuite si demandé. */
function newDb(extraSql = "", applyLot = false): string {
  loopbackOnly(ADMIN_URL!);
  const db = `scanym_t180p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  databases.push(db);
  const admin = spawnSync(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ADMIN_URL!, "-c", `create database ${db}`], { encoding: "utf8" });
  assert.equal(admin.status, 0, admin.stderr);
  const url = urlFor(db);
  const roles = ["anon", "authenticated", "service_role", ...TEST_ROLES]
    .map((r) => `do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$;`)
    .join("\n");
  const setup = psqlFile(url, "setup.sql", `
    ${roles}
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
    ${N1A_CLAIM}
    revoke all on function ${CLAIM_FN} from public, anon, authenticated;
    grant execute on function ${CLAIM_FN} to service_role;
    ${extraSql}
  `, true);
  assert.equal(setup.status, 0, setup.out);
  if (applyLot) {
    const lot = psqlFile(url, "lot-setup.sql", LOT, true);
    assert.equal(lot.status, 0, lot.out);
  }
  return url;
}

/** Empreinte textuelle de TOUT ce que le refus ne doit pas toucher : ligne pg_proc du claim (propriétaire, ACL, STRICT…), ACL de toutes les fonctions, rôles, colonnes d'orders, commandes. */
function snapshot(url: string): string {
  return psqlQuery(url, `
    select concat_ws(E'\\n',
      (select to_jsonb(p)::text from pg_proc p where p.oid = '${CLAIM_FN}'::regprocedure),
      (select string_agg(p.proname || ':' || p.proowner::regrole::text || ':' || coalesce(p.proacl::text, '-'), ',' order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
      (select string_agg(rolname, ',' order by rolname) from pg_roles where rolname !~ '^pg_'),
      (select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'orders'),
      (select coalesce(string_agg(to_jsonb(o)::text, ',' order by o.id), '') from public.orders o)
    );`);
}

const claimIsStrict = (url: string) => psqlQuery(url, `select proisstrict from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
const claimAcl = (url: string) => psqlQuery(url, `select proacl::text from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
const hasGate = (url: string) => psqlQuery(url, `select to_regprocedure('public.notification_send_gate_open(uuid, text)') is not null;`);

/** Joue un script dans les deux modes opérateur ; exige un refus explicite et AUCUNE mutation. */
function assertRefused(url: string, script: string, label: string, expectMessage: RegExp): void {
  const before = snapshot(url);
  const stop = psqlFile(url, `${label}-stop.sql`, script, true);
  assert.notEqual(stop.status, 0, `${label} (ON_ERROR_STOP=1) : le script doit échouer`);
  assert.match(stop.out, /SCANYM_PREDECESSOR_DRIFT/, `${label} (ON_ERROR_STOP=1)\n${stop.out}`);
  assert.match(stop.out, expectMessage, `${label} (ON_ERROR_STOP=1) : mauvais contrôle\n${stop.out}`);
  assert.equal(snapshot(url), before, `${label} (ON_ERROR_STOP=1) : aucune mutation`);

  const go = psqlFile(url, `${label}-go.sql`, script, false);
  assert.match(go.out, /SCANYM_PREDECESSOR_DRIFT/, `${label} (ON_ERROR_STOP=0)\n${go.out}`);
  assert.match(go.out, expectMessage, `${label} (ON_ERROR_STOP=0) : mauvais contrôle\n${go.out}`);
  assert.equal(snapshot(url), before, `${label} (ON_ERROR_STOP=0) : psql a continué après l'erreur, la transaction avortée a empêché toute DDL suivante`);
}

const OPTS = { skip: SKIP_REASON };

test("[172-PGPRE-A] PostgreSQL réel -- prédécesseur STRICT : le lot est REFUSÉ (jamais normalisé à CALLED ON NULL INPUT), dans les deux modes psql, sans aucune mutation", OPTS, () => {
  const url = newDb(`alter function ${CLAIM_FN} returns null on null input;`);
  assert.equal(claimIsStrict(url), "t");
  assertRefused(url, LOT, "fwd-strict", /attributs de claim_pending_notifications différents de N1-A/);
  assert.equal(claimIsStrict(url), "t", "la variante STRICT est conservée telle quelle");
  assert.equal(hasGate(url), "f", "aucune trace du lot");
});

test("[172-PGPRE-B] PostgreSQL réel -- bénéficiaire EXECUTE en plus : le lot est REFUSÉ (le droit n'est ni conservé en silence ni révoqué), dans les deux modes psql, sans aucune mutation", OPTS, () => {
  const url = newDb(`grant execute on function ${CLAIM_FN} to audit_extra;`);
  const aclBefore = claimAcl(url);
  assert.match(aclBefore, /audit_extra=X\//);
  assertRefused(url, LOT, "fwd-extra-role", /droits d'exécution de claim_pending_notifications différents de N1-A/);
  assert.equal(claimAcl(url), aclBefore, "ACL identique : rien révoqué ni accordé");
  assert.equal(hasGate(url), "f", "aucune trace du lot");
});

test("[172-PGPRE-C] PostgreSQL réel -- rollback : claim du lot devenu STRICT -> REFUSÉ, porte et décisions conservées, dans les deux modes psql", OPTS, () => {
  const url = newDb("", true);
  psqlQuery(url, `alter function ${CLAIM_FN} returns null on null input;`);
  psqlQuery(url, `insert into public.orders (restaurant_id) values (gen_random_uuid());`);
  assertRefused(url, ROLLBACK, "rb-strict", /attributs de claim_pending_notifications différents de ceux posés par ce lot/);
  assert.equal(claimIsStrict(url), "t");
  assert.equal(hasGate(url), "t", "la porte est toujours là");
});

test("[172-PGPRE-D] PostgreSQL réel -- rollback : bénéficiaire EXECUTE en plus -> REFUSÉ, droits inchangés, dans les deux modes psql", OPTS, () => {
  const url = newDb("", true);
  psqlQuery(url, `grant execute on function ${CLAIM_FN} to audit_extra;`);
  const aclBefore = claimAcl(url);
  assertRefused(url, ROLLBACK, "rb-extra-role", /droits d'exécution de claim_pending_notifications différents de ceux posés par ce lot/);
  assert.equal(claimAcl(url), aclBefore);
  assert.equal(hasGate(url), "t", "la porte est toujours là");
});

test("[172-PGPRE-E] PostgreSQL réel -- nominal : N1-A exact -> le lot s'applique, puis le rollback restaure EXACTEMENT la ligne pg_proc (attributs, propriétaire, ACL) de N1-A", OPTS, () => {
  const url = newDb();
  const original = psqlQuery(url, `select to_jsonb(p)::text from pg_proc p where p.oid = '${CLAIM_FN}'::regprocedure;`);
  const lot = psqlFile(url, "nominal-lot.sql", LOT, true);
  assert.equal(lot.status, 0, lot.out);
  assert.equal(hasGate(url), "t");
  assert.notEqual(psqlQuery(url, `select md5(prosrc) from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`), psqlQuery(url, `select md5('')`));
  const rb = psqlFile(url, "nominal-rollback.sql", ROLLBACK, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(hasGate(url), "f");
  const restored = psqlQuery(url, `select to_jsonb(p)::text from pg_proc p where p.oid = '${CLAIM_FN}'::regprocedure;`);
  // Seuls le texte source (prosrc) et les POSITIONS de parse (:location N) des valeurs par défaut
  // dépendent de la mise en forme du fichier ; tout le reste doit être identique.
  const strip = (j: string) => {
    const o = JSON.parse(j);
    delete o.prosrc;
    o.proargdefaults = String(o.proargdefaults).replace(/:location \d+/g, ":location N");
    return o;
  };
  assert.deepEqual(strip(restored), strip(original), "mêmes attributs, propriétaire et ACL qu'avant le lot");
  assert.equal(
    psqlQuery(url, `select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`),
    "a29cc6b88ccd77782ea4c5db299c6a70",
    "corps N1-A restauré à l'empreinte exacte"
  );
});

after(() => {
  if (ADMIN_URL && databases.length > 0) {
    for (const db of databases) {
      spawnSync(PSQL, ["-X", "-q", ADMIN_URL, "-c", `drop database if exists ${db} with (force)`], { encoding: "utf8" });
    }
    for (const r of TEST_ROLES) {
      spawnSync(PSQL, ["-X", "-q", ADMIN_URL, "-c", `drop role if exists ${r}`], { encoding: "utf8" });
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});
