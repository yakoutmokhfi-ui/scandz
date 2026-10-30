import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
// T180-R4-01 (contre-audit R4, P2) : le rollback ne vérifiait QUE le claim et
// supprimait sans regarder la porte, la garde, finalize, le déclencheur, la contrainte
// et la colonne. [172-PGPRE-F..J] rejouent, sur un VRAI PostgreSQL et avec le VRAI psql,
// le contre-exemple de Turing (branche `paid` de la porte modifiée après installation),
// d'autres écarts d'objets auxiliaires, et le chemin nominal (avec privilèges par défaut
// de plateforme). Le nominal sur PostgreSQL réel prouve aussi que les empreintes
// codées dans le rollback sont celles que cette version de PostgreSQL stocke.
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
      (select coalesce(string_agg(to_jsonb(o)::text, ',' order by o.id), '') from public.orders o),
      -- T180-R4-01 : tous les objets auxiliaires du lot (lignes catalogue COMPLÈTES) et leurs dépendances.
      (select coalesce(string_agg(to_jsonb(p)::text, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('notification_send_gate_open', 'orders_payment_mode_final_guard', 'finalize_order_payment_mode_none')),
      (select coalesce(string_agg(pg_get_functiondef(p.oid), ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('notification_send_gate_open', 'orders_payment_mode_final_guard', 'finalize_order_payment_mode_none')),
      (select coalesce(string_agg(to_jsonb(t)::text, ',' order by t.tgname), '') from pg_trigger t where t.tgrelid = 'public.orders'::regclass),
      (select coalesce(string_agg(to_jsonb(c)::text, ',' order by c.conname), '') from pg_constraint c where c.conrelid = 'public.orders'::regclass),
      (select coalesce(string_agg(to_jsonb(a)::text, ',' order by a.attnum), '') from pg_attribute a where a.attrelid = 'public.orders'::regclass and a.attnum > 0),
      (select coalesce(string_agg(indexdef, ',' order by indexname), '') from pg_indexes where schemaname = 'public' and tablename = 'orders'),
      (select coalesce(string_agg(viewname || definition, ',' order by viewname), '') from pg_views where schemaname = 'public'),
      (select coalesce(string_agg(policyname || coalesce(qual, ''), ',' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = 'orders'),
      -- T180-R5 : l'archive des décisions ne doit exister que si un rollback a RÉUSSI.
      coalesce(to_regclass('public.orders_payment_mode_final_rollback_archive')::text, 'archive-absente')
    );`);
}

const claimIsStrict = (url: string) => psqlQuery(url, `select proisstrict from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
const claimAcl = (url: string) => psqlQuery(url, `select proacl::text from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`);
const hasGate = (url: string) => psqlQuery(url, `select to_regprocedure('public.notification_send_gate_open(uuid, text)') is not null;`);

/** Joue un script dans les deux modes opérateur ; exige un refus explicite et AUCUNE mutation. */
function assertRefused(url: string, script: string, label: string, expectMessage: RegExp, code = "SCANYM_PREDECESSOR_DRIFT"): void {
  const before = snapshot(url);
  const stop = psqlFile(url, `${label}-stop.sql`, script, true);
  assert.notEqual(stop.status, 0, `${label} (ON_ERROR_STOP=1) : le script doit échouer`);
  assert.ok(stop.out.includes(code), `${label} (ON_ERROR_STOP=1) : ${code} attendu\n${stop.out}`);
  assert.match(stop.out, expectMessage, `${label} (ON_ERROR_STOP=1) : mauvais contrôle\n${stop.out}`);
  assert.equal(snapshot(url), before, `${label} (ON_ERROR_STOP=1) : aucune mutation`);

  const go = psqlFile(url, `${label}-go.sql`, script, false);
  assert.ok(go.out.includes(code), `${label} (ON_ERROR_STOP=0) : ${code} attendu\n${go.out}`);
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

const GATE_FN = "public.notification_send_gate_open(uuid, text)";
const GUARD_FN = "public.orders_payment_mode_final_guard()";
const FINALIZE_FN = "public.finalize_order_payment_mode_none(uuid, uuid)";

/** Base avec le lot installé et une commande dont la décision définitive « sans paiement » (none) est posée. */
function lotWithDecision(extraSql = ""): string {
  const url = newDb(extraSql, true);
  psqlQuery(url, `insert into public.orders (restaurant_id) values (gen_random_uuid());`);
  psqlQuery(url, `select 1 from public.finalize_order_payment_mode_none((select id from public.orders limit 1), (select public_token from public.orders limit 1));`);
  assert.equal(psqlQuery(url, `select payment_mode_final from public.orders;`), "none", "précondition : décision « sans paiement » posée");
  return url;
}
const decisions = (url: string) => psqlQuery(url, `select coalesce(string_agg(id::text || ':' || coalesce(payment_mode_final, '-'), ',' order by id), '') from public.orders;`);
const functionDef = (url: string, fn: string) => psqlQuery(url, `select pg_get_functiondef('${fn}'::regprocedure);`);
const gateExists = (url: string) => psqlQuery(url, `select to_regprocedure('${GATE_FN}') is not null;`);

test("[172-PGPRE-F] PostgreSQL réel -- T180-R4-01, contre-exemple EXACT de Turing : branche `paid` de la porte modifiée après l'installation -> rollback REFUSÉ (ON_ERROR_STOP 1 et 0), définition modifiée conservée, porte et colonne présentes, décision intacte", OPTS, () => {
  const url = lotWithDecision();
  const original = functionDef(url, GATE_FN);
  assert.ok(original.includes("when 'paid' then true"));
  const tampered = psqlFile(url, "tamper-gate.sql", `${original.replace("when 'paid' then true", "when 'paid' then false")};\n`, true);
  assert.equal(tampered.status, 0, tampered.out);
  const decisionsBefore = decisions(url);
  assertRefused(url, ROLLBACK, "rb-gate-paid", /le corps de public\.notification_send_gate_open\(uuid, text\) \(md5 [0-9a-f]{32}\) n'est plus celui posé par ce lot/);
  assert.equal(gateExists(url), "t", "la porte n'a PAS été supprimée");
  assert.ok(functionDef(url, GATE_FN).includes("when 'paid' then false"), "la définition modifiée est toujours en place");
  assert.equal(psqlQuery(url, `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_mode_final';`), "1", "la colonne de décision n'a PAS été supprimée");
  assert.equal(decisions(url), decisionsBefore, "décision payment_mode_final strictement inchangée");
});

const ATTR_GATE = /attributs de public\.notification_send_gate_open\(uuid, text\) différents de ceux posés par ce lot/;
const ACL_GATE = /droits d'exécution de public\.notification_send_gate_open\(uuid, text\) différents de ceux posés par ce lot/;
const TRG_DIFF = /déclencheur orders_payment_mode_final_guard_trg différent de celui posé par ce lot/;
const CHK_DIFF = /contrainte orders_payment_mode_final_check différente de celle posée par ce lot/;
/** T180-R5-01 : littéraux que lower() + suppression des espaces et parenthèses confondait avec 'online'. */
const LITERAL_VARIANTS: Record<string, string> = {
  "'ONLINE'": "'ONLINE', 'none'",
  "'on line'": "'on line', 'none'",
  "'on(line)'": "'on(line)', 'none'",
  "'online ' (espace final)": "'online ', 'none'",
};
const constraintWith = (list: string) =>
  `alter table public.orders drop constraint orders_payment_mode_final_check; alter table public.orders add constraint orders_payment_mode_final_check check (payment_mode_final is null or payment_mode_final in (${list}));`;
/** La contrainte accepte-t-elle `value` ? (essai réel sur PostgreSQL, annulé dans tous les cas) */
function constraintAccepts(url: string, value: string): boolean {
  const r = spawnSync(PSQL, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c",
    `do $$ begin update public.orders set payment_mode_final = '${value.replaceAll("'", "''")}'; raise exception 'ACCEPTED'; exception when check_violation then null; end $$;`], { encoding: "utf8" });
  if (r.status === 0) return false;                       // check_violation attrapée : valeur refusée
  assert.match(r.stderr, /ACCEPTED/, r.stderr);           // toute autre erreur est un échec du test
  return true;
}
const PG_DRIFTS: Array<{ label: string; ddl: string; check: RegExp }> = [
  { label: "porte : STRICT", ddl: `alter function ${GATE_FN} returns null on null input;`, check: ATTR_GATE },
  { label: "porte : search_path différent", ddl: `alter function ${GATE_FN} set search_path = public;`, check: ATTR_GATE },
  { label: "porte : droit d'exécution accordé à anon", ddl: `grant execute on function ${GATE_FN} to anon;`, check: ACL_GATE },
  { label: "porte : rôle supplémentaire avec EXECUTE", ddl: `grant execute on function ${GATE_FN} to audit_extra;`, check: ACL_GATE },
  { label: "garde : propriétaire différent", ddl: `alter function ${GUARD_FN} owner to audit_other_owner;`, check: /droits d'exécution de public\.orders_payment_mode_final_guard\(\) différents de ceux posés par ce lot/ },
  {
    label: "finalize : mode finalisé à 'online' au lieu de 'none'",
    ddl: `do $$ begin execute replace(pg_get_functiondef('${FINALIZE_FN}'::regprocedure), 'set payment_mode_final = ''none''', 'set payment_mode_final = ''online'''); end $$;`,
    check: /le corps de public\.finalize_order_payment_mode_none\(uuid, uuid\) \(md5 [0-9a-f]{32}\) n'est plus celui posé par ce lot/,
  },
  { label: "finalize : droit de service_role retiré", ddl: `revoke execute on function ${FINALIZE_FN} from service_role;`, check: /droits d'exécution de public\.finalize_order_payment_mode_none\(uuid, uuid\) différents de ceux posés par ce lot/ },
  { label: "finalize : supprimée", ddl: `drop function ${FINALIZE_FN};`, check: /public\.finalize_order_payment_mode_none\(uuid, uuid\) est absent/ },
  { label: "déclencheur : désactivé", ddl: `alter table public.orders disable trigger orders_payment_mode_final_guard_trg;`, check: TRG_DIFF },
  { label: "déclencheur : recréé AFTER", ddl: `drop trigger orders_payment_mode_final_guard_trg on public.orders; create trigger orders_payment_mode_final_guard_trg after update of payment_status on public.orders for each row execute function ${GUARD_FN};`, check: TRG_DIFF },
  { label: "déclencheur : supprimé", ddl: `drop trigger orders_payment_mode_final_guard_trg on public.orders;`, check: /déclencheur orders_payment_mode_final_guard_trg est absent/ },
  { label: "contrainte : élargie", ddl: `alter table public.orders drop constraint orders_payment_mode_final_check; alter table public.orders add constraint orders_payment_mode_final_check check (payment_mode_final is null or payment_mode_final in ('online', 'none', 'manual'));`, check: CHK_DIFF },
  { label: "contrainte : NOT VALID", ddl: `alter table public.orders drop constraint orders_payment_mode_final_check; alter table public.orders add constraint orders_payment_mode_final_check check (payment_mode_final is null or payment_mode_final in ('online', 'none')) not valid;`, check: CHK_DIFF },
  ...Object.entries(LITERAL_VARIANTS).map(([name, list]) => ({ label: `contrainte recréée avec le littéral ${name} (T180-R5-01)`, ddl: constraintWith(list), check: CHK_DIFF })),
  { label: "colonne : index ajouté", ddl: `create index orders_pmf_idx on public.orders (payment_mode_final);`, check: /objets inconnus dépendent de orders\.payment_mode_final/ },
  { label: "colonne : passée NOT NULL", ddl: `alter table public.orders alter column payment_mode_final set not null;`, check: /colonne orders\.payment_mode_final différente de celle posée par ce lot|objets inconnus dépendent de orders\.payment_mode_final/ },
  { label: "colonne : valeur par défaut ajoutée", ddl: `alter table public.orders alter column payment_mode_final set default 'online';`, check: /colonne orders\.payment_mode_final différente de celle posée par ce lot/ },
];
for (const drift of PG_DRIFTS) {
  test(`[172-PGPRE-G] PostgreSQL réel -- T180-R4-01, rollback : ${drift.label} -> REFUSÉ (ON_ERROR_STOP 1 et 0), tout est conservé, décision intacte`, OPTS, () => {
    const url = lotWithDecision();
    psqlQuery(url, drift.ddl);
    const decisionsBefore = decisions(url);
    assertRefused(url, ROLLBACK, "rb-aux", drift.check);
    assert.equal(decisions(url), decisionsBefore);
  });
}

test("[172-PGPRE-H] PostgreSQL réel -- privilèges par défaut de plateforme (service_role/anon/authenticated reçoivent EXECUTE sur les fonctions créées) : le rollback nominal N'EST PAS refusé à tort ; un bénéficiaire en plus l'est", OPTS, () => {
  const hostedLike = `alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;
  const url = lotWithDecision(hostedLike);
  assert.match(psqlQuery(url, `select proacl::text from pg_proc where oid = '${GATE_FN}'::regprocedure;`), /service_role=X\//, "précondition : service_role a reçu EXECUTE par privilège par défaut");
  const rb = psqlFile(url, "hosted-like-rollback.sql", ROLLBACK, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(psqlQuery(url, `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('notification_send_gate_open', 'orders_payment_mode_final_guard', 'finalize_order_payment_mode_none');`), "0");

  const refused = lotWithDecision(hostedLike);
  psqlQuery(refused, `grant execute on function ${GATE_FN} to audit_extra;`);
  assertRefused(refused, ROLLBACK, "rb-hosted-like-extra", ACL_GATE);
});

const ARCHIVE = "public.orders_payment_mode_final_rollback_archive";
const archiveRows = (url: string) => psqlQuery(url, `select coalesce(string_agg(order_id::text || ':' || payment_mode_final || ':' || coalesce(payment_status, '-'), ',' order by order_id), '') from ${ARCHIVE};`);
/** Requête de restauration DOCUMENTÉE dans l'en-tête du rollback (extraite du fichier, jamais recopiée ici). */
function documentedRestoreSql(): string {
  const lines = ROLLBACK.split("\n").filter((l) => /^--\s{3,}(update public\.orders o|set payment_mode_final = a\.|from public\.orders_payment_mode_final_rollback_archive a|where a\.order_id = o\.id)/.test(l));
  assert.equal(lines.length, 4, "les quatre lignes de la requête de restauration sont dans l'en-tête");
  return lines.map((l) => l.replace(/^--\s+/, "")).join("\n") + ";";
}
/** Ajoute une deuxième commande dont la décision définitive est « online » (posée par le déclencheur à la sortie de not_required) et une troisième sans décision. */
function addOnlineAndUndecided(url: string): void {
  psqlQuery(url, `insert into public.orders (restaurant_id, payment_status) values (gen_random_uuid(), 'not_required');`);
  psqlQuery(url, `update public.orders set payment_status = 'paid' where payment_mode_final is null;`);
  psqlQuery(url, `insert into public.orders (restaurant_id, payment_status) values (gen_random_uuid(), 'pending');`);
  assert.equal(psqlQuery(url, `select string_agg(coalesce(payment_mode_final, '-'), ',' order by payment_mode_final) from public.orders;`), "none,online,-", "précondition : none, online et une commande sans décision");
}

test("[172-PGPRE-I] PostgreSQL réel -- nominal avec décisions (none ET online) : le rollback réussit, ARCHIVE les décisions (NOTICE une fois), supprime tous les objets du lot et la colonne, et restaure le claim N1-A (T180-R5)", OPTS, () => {
  const url = lotWithDecision();
  addOnlineAndUndecided(url);
  const expected = psqlQuery(url, `select coalesce(string_agg(id::text || ':' || payment_mode_final || ':' || payment_status, ',' order by id), '') from public.orders where payment_mode_final is not null;`);
  const rb = psqlFile(url, "nominal-decision-rollback.sql", ROLLBACK, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(rb.out.match(/SCANYM_ROLLBACK_NOTICE: 2 décision\(s\) payment_mode_final archivée\(s\)/g)?.length, 1, rb.out);
  assert.equal(archiveRows(url), expected, "les deux décisions (none et online) sont archivées, avec le statut de paiement du moment");
  assert.equal(psqlQuery(url, `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_mode_final';`), "0", "colonne supprimée : schéma d'avant le lot");
  assert.equal(psqlQuery(url, `select count(*) from pg_trigger where tgrelid = 'public.orders'::regclass and not tgisinternal;`), "0");
  assert.equal(psqlQuery(url, `select count(*) from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_payment_mode_final_check';`), "0");
  assert.equal(psqlQuery(url, `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('notification_send_gate_open', 'orders_payment_mode_final_guard', 'finalize_order_payment_mode_none');`), "0");
  assert.equal(psqlQuery(url, `select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = '${CLAIM_FN}'::regprocedure;`), "a29cc6b88ccd77782ea4c5db299c6a70");
});

test("[172-PGPRE-J] PostgreSQL réel -- un rollback REFUSÉ n'émet pas de NOTICE d'archivage et ne crée PAS l'archive", OPTS, () => {
  const url = lotWithDecision();
  psqlQuery(url, `alter function ${GATE_FN} volatile;`);
  const rb = psqlFile(url, "refused-no-notice.sql", ROLLBACK, true);
  assert.notEqual(rb.status, 0);
  assert.match(rb.out, /SCANYM_PREDECESSOR_DRIFT/);
  assert.doesNotMatch(rb.out, /SCANYM_ROLLBACK_NOTICE/, rb.out);
  assert.equal(psqlQuery(url, `select to_regclass('${ARCHIVE}') is null;`), "t", "aucune archive créée");
});

test("[172-PGPRE-K] PostgreSQL réel -- une archive déjà existante n'est JAMAIS écrasée : rollback REFUSÉ (SCANYM_ROLLBACK_PREFLIGHT_FAILED, ON_ERROR_STOP 1 et 0), archive, décision et schéma intacts", OPTS, () => {
  const url = lotWithDecision();
  psqlQuery(url, `create table ${ARCHIVE} (order_id uuid primary key, payment_mode_final text not null, payment_status text, archived_at timestamptz not null default now()); insert into ${ARCHIVE} (order_id, payment_mode_final) values (gen_random_uuid(), 'online');`);
  const keep = archiveRows(url);
  const decisionsBefore = decisions(url);
  assertRefused(url, ROLLBACK, "rb-archive-exists", /orders_payment_mode_final_rollback_archive existe déjà/, "SCANYM_ROLLBACK_PREFLIGHT_FAILED");
  assert.equal(archiveRows(url), keep, "archive existante intacte");
  assert.equal(decisions(url), decisionsBefore, "décision intacte");
  assert.equal(gateExists(url), "t", "porte conservée");
});

test("[172-PGPRE-L] PostgreSQL réel -- l'archive est inaccessible à anon, authenticated, service_role et PUBLIC (RLS sans politique), MÊME avec des privilèges par défaut de plateforme sur les tables", OPTS, () => {
  const url = lotWithDecision(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  const rb = psqlFile(url, "archive-privileges-rollback.sql", ROLLBACK, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(psqlQuery(url, `select relrowsecurity from pg_class where oid = '${ARCHIVE}'::regclass;`), "t", "RLS activée");
  assert.equal(psqlQuery(url, `select count(*) from pg_policies where schemaname = 'public' and tablename = 'orders_payment_mode_final_rollback_archive';`), "0", "aucune politique");
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
      assert.equal(psqlQuery(url, `select has_table_privilege('${role}', '${ARCHIVE}', '${priv}');`), "f", `${role} n'a pas ${priv}`);
    }
  }
  assert.match(psqlQuery(url, `select relacl::text from pg_class where oid = '${ARCHIVE}'::regclass;`), /^\{[^,]+\}$/, "une seule entrée de droits : le propriétaire");
});

test("[172-PGPRE-M] PostgreSQL réel -- après rollback puis RÉINSTALLATION du lot, la requête de restauration documentée dans l'en-tête rétablit exactement les décisions (none et online), sans toucher payment_status, ni la commande sans décision", OPTS, () => {
  const url = lotWithDecision();
  addOnlineAndUndecided(url);
  const before = psqlQuery(url, `select coalesce(string_agg(id::text || ':' || coalesce(payment_mode_final, '-') || ':' || payment_status, ',' order by id), '') from public.orders;`);
  const rb = psqlFile(url, "restore-1-rollback.sql", ROLLBACK, true);
  assert.equal(rb.status, 0, rb.out);
  const reinstall = psqlFile(url, "restore-2-lot.sql", LOT, true);
  assert.equal(reinstall.status, 0, reinstall.out);
  assert.equal(psqlQuery(url, `select count(*) from public.orders where payment_mode_final is not null;`), "0", "précondition : après réinstallation, plus aucune décision");
  const restore = psqlFile(url, "restore-3.sql", documentedRestoreSql(), true);
  assert.equal(restore.status, 0, restore.out);
  assert.equal(psqlQuery(url, `select coalesce(string_agg(id::text || ':' || coalesce(payment_mode_final, '-') || ':' || payment_status, ',' order by id), '') from public.orders;`), before);
});

test("[172-PGPRE-N] PostgreSQL réel -- T180-R5-01 : 'ONLINE', 'on line' et 'on(line)' sont de VRAIES contraintes différentes (la nominale accepte 'online', chaque variante la refuse) ; la comparaison exacte les refuse toutes", OPTS, () => {
  const nominal = lotWithDecision();
  assert.equal(constraintAccepts(nominal, "online"), true, "contrainte nominale : 'online' accepté");
  assert.equal(constraintAccepts(nominal, "none"), true);
  for (const name of ["'ONLINE'", "'on line'", "'on(line)'", "'online ' (espace final)"]) {
    const url = lotWithDecision();
    psqlQuery(url, constraintWith(LITERAL_VARIANTS[name]!));
    assert.equal(constraintAccepts(url, "online"), false, `${name} : la variante REFUSE 'online' -- différence sémantique réelle`);
    assertRefused(url, ROLLBACK, "rb-literal", CHK_DIFF);
  }
});

test("[172-PGPRE-O] PostgreSQL réel -- une recréation de la contrainte qui ne diffère que par la PRÉSENTATION (espaces, casse des mots-clés, parenthèses) donne la même définition : rollback ACCEPTÉ ; la forme exacte vérifiée est celle de la version testée", OPTS, () => {
  const url = lotWithDecision();
  psqlQuery(url, `alter table public.orders drop constraint orders_payment_mode_final_check; alter table public.orders add constraint orders_payment_mode_final_check CHECK ((PAYMENT_MODE_FINAL   IS NULL) OR ((payment_mode_final) = ANY (ARRAY [ 'online' ,'none' ])));`);
  assert.equal(psqlQuery(url, `select pg_get_constraintdef(oid) from pg_constraint where conname = 'orders_payment_mode_final_check';`),
    "CHECK (((payment_mode_final IS NULL) OR (payment_mode_final = ANY (ARRAY['online'::text, 'none'::text]))))", "définition PostgreSQL exacte attendue par le rollback");
  const rb = psqlFile(url, "presentation-only-rollback.sql", ROLLBACK, true);
  assert.equal(rb.status, 0, rb.out);
  assert.equal(psqlQuery(url, `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_mode_final';`), "0");
});

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test("[172-PGPRE-P] PostgreSQL réel, DEUX sessions -- une écriture de décision EN COURS pendant le rollback est ATTENDUE (verrou de orders dès le début) puis ARCHIVÉE : aucune décision n'est perdue entre l'archivage et la suppression de la colonne", OPTS, async () => {
  const url = lotWithDecision();
  psqlQuery(url, `insert into public.orders (restaurant_id) values (gen_random_uuid());`);
  const target = psqlQuery(url, `select id from public.orders where payment_mode_final is null limit 1;`);
  assert.match(target, /^[0-9a-f-]{36}$/, "précondition : une commande sans décision");
  // Session A : pose une décision (non validée) puis dort 4 s avant de valider.
  const a = spawn(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", url, "-c", `begin; update public.orders set payment_mode_final = 'none' where id = '${target}'; select pg_sleep(4); commit;`]);
  const aClosed = new Promise<number | null>((resolve) => a.on("close", resolve));
  for (let i = 0; i < 100 && psqlQuery(url, `select count(*) from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and pid <> pg_backend_pid();`) === "0"; i++) sleepMs(100);
  assert.equal(psqlQuery(url, `select count(*) from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and pid <> pg_backend_pid();`), "1", "précondition : la session A tient sa décision non validée");
  assert.equal(psqlQuery(url, `select payment_mode_final is null from public.orders where id = '${target}';`), "t", "précondition : la décision de A n'est pas encore visible");
  const started = Date.now();
  const rb = psqlFile(url, "concurrent-rollback.sql", ROLLBACK, true);     // attend A, puis archive
  const elapsed = Date.now() - started;
  assert.equal(await aClosed, 0, "la session A a validé");
  assert.equal(rb.status, 0, rb.out);
  assert.ok(rb.out.includes("SCANYM_ROLLBACK_NOTICE: 2 décision(s)"), `deux décisions archivées (celle de A comprise) -- ${rb.out}`);
  assert.ok(archiveRows(url).includes(`${target}:none:`), `la décision écrite par A pendant le rollback est archivée (rollback resté ${elapsed} ms en attente)`);
  assert.equal(psqlQuery(url, `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_mode_final';`), "0");
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
