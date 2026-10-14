import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Scanny — CSDJ v1.2 — RB-02, remédiation finale.
 *   CSDJ12-RB02-RACE-02   : exclusion mutuelle avec l'installation de CSDJ-3
 *                           (verrou consultatif transactionnel partagé).
 *   CSDJ12-RB02-CALLER-01 : découverte des consommateurs du moteur, tous
 *                           schémas non système, exclusion exacte par OID,
 *                           jeton de revue pour ce que le texte ne prouve pas.
 *
 * GARDE STRUCTURELLE : ce que l'on ne prouve qu'en lisant le SQL, et la
 * cohérence SQL / inventaire / documentation / harnais. La preuve d'EXÉCUTION
 * (deux sessions PostgreSQL réelles, schémas externes, SQL dynamique,
 * mutations) est dans le harnais PostgreSQL jetable, sections [20] à [22].
 */

const FWD = "supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql";
const RB = "supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql";
const HARNESS = "supabase/tests/checkout-scheduling-v12-check.sh";
const DOC = "docs/scheduling/csdj-v1.2-deploy-rollback-order.md";
const INVENTORY = "docs/scheduling/csdj-v1.2-engine-consumers.json";

const fwd = readFileSync(FWD, "utf8");
const rb = readFileSync(RB, "utf8");
const harness = readFileSync(HARNESS, "utf8");
const doc = readFileSync(DOC, "utf8");
const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));

const stripComments = (s: string) =>
  s
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
const rbCode = stripComments(rb);
const fwdCode = stripComments(fwd);

const LOCK_EXPR = "pg_catalog.hashtextextended('scanym.csdj3.order-persistence.v1', 0)";
const LOCK_STMT = `select pg_catalog.pg_advisory_xact_lock(${LOCK_EXPR});`;

/** Valeurs d'un tableau « constant text[] := array[ ... ]; » du retour. */
function arrayConst(name: string): string[] {
  const m = new RegExp(`${name} constant text\\[\\] := array\\[([\\s\\S]*?)\\];`).exec(rbCode);
  assert.ok(m, `tableau ${name} introuvable`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}
const engSigs = arrayConst("v_eng_sigs");
const names = arrayConst("v_names");
const tabs = arrayConst("v_tabs");
const cols = arrayConst("v_cols");
const cons = arrayConst("v_cons");

const fwdFunctions = [...fwdCode.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]);
const fwdTables = [...fwdCode.matchAll(/create table public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]);
const fwdColumns = [...fwdCode.matchAll(/add column (?:if not exists )?([a-z0-9_]+)/g)].map((m) => m[1]);

const at = (s: string, needle: string | RegExp) => {
  const i = typeof needle === "string" ? s.indexOf(needle) : s.search(needle);
  assert.ok(i >= 0, `introuvable : ${needle}`);
  return i;
};

// ------------------------------------------------------------------ RACE-02
test("[V12-RACE-1] l'expression du verrou est EXACTEMENT celle du mandat (aucune faute de frappe)", () => {
  assert.equal(rbCode.split(LOCK_EXPR).length - 1, 1, "l'expression doit apparaître une fois dans le code");
  assert.ok(rbCode.includes(LOCK_STMT), "instruction de verrou attendue");
  assert.doesNotMatch(rb, /scanny/i, "faute de frappe « scanny »");
  assert.match(rb, /scanym\.csdj3\.order-persistence\.v1/);
});

test("[V12-RACE-2] verrou PREMIÈRE instruction utile : après l'isolation, avant toute lecture de catalogue ou de dépendance", () => {
  const begin = at(rbCode, "begin;");
  const iso = at(rbCode, "do $csdj12_rb_isolation$");
  const lock = at(rbCode, LOCK_STMT);
  const pre = at(rbCode, "do $csdj12_rb_preflight$");
  assert.ok(begin < iso && iso < lock && lock < pre, "ordre begin < isolation < verrou < pré-vol");
  const beforeLock = rbCode.slice(0, lock);
  for (const forbidden of ["to_regclass", "to_regprocedure", "pg_proc", "pg_depend", "pg_class", "create temp"]) {
    assert.ok(!beforeLock.includes(forbidden), `${forbidden} lu avant le verrou`);
  }
  // l'unique instruction « select » avant le pré-vol est le verrou lui-même
  const between = rbCode.slice(begin, pre);
  assert.equal([...between.matchAll(/\bselect\b/gi)].length, 1);
});

test("[V12-RACE-3] READ COMMITTED exigé avant le verrou (sous REPEATABLE READ, instantané antérieur à l'attente)", () => {
  const iso = rbCode.slice(at(rbCode, "do $csdj12_rb_isolation$"), at(rbCode, "$csdj12_rb_isolation$;"));
  assert.match(iso, /current_setting\('transaction_isolation'\) is distinct from 'read committed'/);
  assert.match(iso, /\[ISOLATION\]/);
  assert.match(iso, /errcode = '55000'/);
});

test("[V12-RACE-4] le verrou est TRANSACTIONNEL (xact) : libéré au COMMIT/ROLLBACK, jamais de verrou de session", () => {
  assert.doesNotMatch(rbCode, /pg_advisory_lock\b|pg_try_advisory/);
  assert.match(rbCode, /pg_advisory_xact_lock/);
});

test("[V12-RACE-5] ordre du pré-vol : applicabilité, CSDJ-3, create_order, moteur, dépendances, appelants, cron, données, jeton, puis seulement les DROP", () => {
  const order = [
    "SCANYM_ROLLBACK_NOT_APPLICABLE",
    "[CSDJ3_INSTALLED]",
    "[CREATE_ORDER_FINGERPRINT]",
    "[ENGINE_SURFACE]",
    "[ENGINE_DEPENDENT]",
    "[ENGINE_CALLER]",
    "[CRON_JOB]",
    "planification(s) de méthode v1.2",
    "réservation(s) de capacité",
    "SCANYM_ROLLBACK_REVIEW_ONLY",
    "[REVIEW_TOKEN]",
  ].map((t) => at(rbCode, t));
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `ordre rompu à l'étape ${i}`);
  const firstDrop = at(rbCode, /\n(drop|alter) (function|table)\b/);
  assert.ok(order[order.length - 1] < firstDrop, "toutes les gardes précèdent la première modification");
  assert.ok(at(rbCode, LOCK_STMT) < order[0], "le verrou précède l'applicabilité");
});

test("[V12-RACE-6] l'interface avec CSDJ-3 est documentée et la non-vérification contre 34cad9e est dite", () => {
  for (const must of [
    "scanym.csdj3.order-persistence.v1",
    "34cad9e",
    "NON VÉRIFIÉ",
    "Dépendance d'interface avec CSDJ-3",
    "relus APRÈS le verrou",
    "SCANYM_CSDJ3_PREREQ",
  ]) assert.ok(doc.includes(must), `doc : ${must} absent`);
  assert.match(rb, /NON VÉRIFIÉE contre le\s+--\s+candidat CSDJ-3 34cad9e/);
});

test("[V12-RACE-7] le harnais prouve la course avec deux sessions réelles et la MÊME clé que le retour", () => {
  assert.ok(harness.includes(`CS3_KEY_SQL="${LOCK_EXPR}"`), "clé du harnais ≠ clé du retour");
  for (const m of [
    "race_cs3_first",
    "race_rb_first",
    "pg_terminate_backend",
    "pg_locks",
    "wait_event_type='Lock'",
    "pg_advisory_lock",
    "[20a]",
    "[20f]",
    "[20i]",
    "[20k]",
    "[20n]",
    "[22a]",
    "[22b]",
    "[22c]",
  ]) assert.ok(harness.includes(m), `harnais : ${m} absent`);
  // le stand-in CSDJ-3 respecte le protocole : verrou d'abord, prérequis ensuite, installation après
  const stand = harness.slice(at(harness, "cs3_script() {"), at(harness, "BG_PID=\"\""));
  assert.ok(at(stand, "pg_advisory_xact_lock") < at(stand, "SCANYM_CSDJ3_PREREQ"));
  assert.ok(at(stand, "SCANYM_CSDJ3_PREREQ") < at(stand, "$CS3_MARKER_SQL"));
  assert.ok(at(stand, "$CS3_MARKER_SQL") < at(stand, "$CS3_STANDIN_SQL"));
  // aucune synchronisation par sommeil chronométré dans les scénarios de course
  const sect = harness.slice(at(harness, 'log "=== [20] RB02-RACE-02'), at(harness, 'log "=== [22] Mutation des gardes'));
  assert.doesNotMatch(sect.replace(/pg_sleep\(900\)/g, ""), /pg_sleep\(/);
});

// ----------------------------------------------------------------- CALLER-01
test("[V12-CALLER-1] l'exclusion du moteur se fait par OID EXACT, jamais par nom ; plus aucune liste de noms exemptés", () => {
  assert.doesNotMatch(rbCode, /proname not in/);
  assert.match(rbCode, /r\.oid <> all \(v_eng\) and r\.prosrc ~\* v_re/);
  assert.match(rbCode, /to_regprocedure\(s\) as r from pg_catalog\.unnest\(v_eng_sigs\)/);
  assert.match(rbCode, /\[ENGINE_SURFACE\]/);
});

test("[V12-CALLER-2] l'inspection couvre TOUS les schémas non système, pas seulement public", () => {
  const ct = rbCode.slice(at(rbCode, "create temp table csdj12_rb_routines"), at(rbCode, "select r.sig into v_hit"));
  assert.match(ct, /n\.nspname not in \('pg_catalog', 'information_schema', 'pg_toast'\)/);
  assert.doesNotMatch(ct, /regnamespace/);
  assert.match(ct, /pg_extension/);
  assert.match(ct, /l\.lanname not in \('internal', 'c'\)/);
});

test("[V12-CALLER-3] les noms surveillés couvrent TOUT ce que l'aller crée (sauf le répartiteur restauré) + le résolveur renommé", () => {
  const watched = new Set(names);
  for (const f of fwdFunctions) {
    if (f === "resolve_fulfillment_schedule") continue; // restauré sous son nom : ses appelants survivent
    assert.ok(watched.has(f), `fonction créée par l'aller non surveillée : ${f}`);
  }
  assert.ok(watched.has("resolve_fulfillment_schedule_v1"), "resolve_fulfillment_schedule_v1 disparaît au renommage");
  assert.ok(!watched.has("resolve_fulfillment_schedule"), "le répartiteur est restauré : ne pas le surveiller");
  for (const t of fwdTables) assert.ok(watched.has(t), `table créée non surveillée : ${t}`);
  assert.equal(fwdTables.length, 5);
  assert.deepEqual([...tabs].sort(), [...fwdTables].sort());
  assert.deepEqual([...cols].sort(), [...fwdColumns].sort());
  for (const c of cols) assert.ok(watched.has(c), `colonne non surveillée : ${c}`);
});

test("[V12-CALLER-4] la surface exacte (v_eng_sigs) = fonctions créées par l'aller + résolveur renommé, et couvre tous les DROP du retour", () => {
  const sigNames = engSigs.map((s) => /^public\.([a-z0-9_]+)\(/.exec(s)![1]);
  assert.deepEqual([...new Set(sigNames)].sort(), [...new Set([...fwdFunctions, "resolve_fulfillment_schedule_v1"])].sort());
  assert.equal(engSigs.length, 15);
  const dropped = [...rbCode.matchAll(/\ndrop function public\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
  for (const d of dropped) assert.ok(sigNames.includes(d), `DROP d'une fonction hors surface : ${d}`);
  assert.equal(dropped.length, 14);
});

test("[V12-CALLER-5] contraintes et colonnes « attendues retirées » = exactement ce que le retour supprime", () => {
  const droppedCons = [...rbCode.matchAll(/drop constraint ([a-z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...cons].sort(), [...droppedCons].sort());
  const droppedCols = [...rbCode.matchAll(/drop column ([a-z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...cols].sort(), [...droppedCols].sort());
  const droppedTabs = [...rbCode.matchAll(/\ndrop table public\.([a-z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...tabs].sort(), [...droppedTabs].sort());
});

test("[V12-CALLER-6] dépendances enregistrées : pg_depend vers fonctions, tables, colonnes, types ; fermeture auto/interne exclue", () => {
  const dep = rbCode.slice(at(rbCode, "with recursive owned"), at(rbCode, "[ENGINE_DEPENDENT]"));
  assert.match(dep, /d\.deptype = 'n'/);
  for (const k of ["'pg_proc'::regclass", "'pg_class'::regclass", "'pg_type'::regclass", "d.refobjsubid = any (v_attn)"]) {
    assert.ok(dep.includes(k), `pg_depend : ${k} absent`);
  }
  assert.match(dep, /d\.deptype in \('a', 'i'\)/);
  assert.match(dep, /pg_describe_object/);
});

test("[V12-CALLER-7] pg_cron : inspecté seulement si cron.job existe (dynamique), commandes liées au jeton", () => {
  assert.match(rbCode, /to_regclass\('cron\.job'\) is not null/);
  assert.match(rbCode, /\[CRON_JOB\]/);
  assert.match(rbCode, /md5\(j\.command\)/);
});

test("[V12-CALLER-8] jeton de revue : mode revue sans modification, jeton lié aux routines dynamiques + cron, refus sans jeton", () => {
  assert.match(rbCode, /v_review_version constant text := 'csdj12-rollback-review-v1'/);
  assert.match(rbCode, /scanym\.csdj12_rollback_mode/);
  assert.match(rbCode, /scanym\.csdj12_rollback_review_token/);
  assert.match(rbCode, /SCANYM_ROLLBACK_REVIEW_ONLY: mode revue, AUCUNE modification/);
  assert.match(rbCode, /\[REVIEW_TOKEN\]/);
  assert.match(rbCode, /\[MODE\]/);
  // le jeton lie les routines dynamiques / hors SQL-plpgsql, hors moteur, hors extensions
  assert.match(rbCode, /r\.lanname not in \('sql', 'plpgsql'\) or r\.prosrc ~\* v_dyn_re/);
  assert.match(rbCode, /not r\.is_ext/);
  assert.match(rbCode, /md5\(v_review_version \|\| '\|' \|\| v_s2 \|\| '\|' \|\| v_s3\)/);
  // le jeton attendu n'est jamais imprimé hors du mode revue
  const refusal = rbCode.slice(at(rbCode, "[REVIEW_TOKEN]"), at(rbCode, "[REVIEW_TOKEN]") + 400);
  assert.doesNotMatch(refusal, /v_token/);
  const idx = [...rbCode.matchAll(/v_token/g)].map((m) => m.index!);
  const reviewOnly = at(rbCode, "SCANYM_ROLLBACK_REVIEW_ONLY");
  assert.ok(idx.some((i) => i > reviewOnly && i < reviewOnly + 200), "jeton affiché en mode revue");
});

test("[V12-CALLER-9] la limite du SQL dynamique est DÉCLARÉE dans le SQL et dans la doc (pas de revendication de complétude)", () => {
  assert.match(rb, /PostgreSQL ne suit PAS les dépendances du corps d'une fonction plpgsql/);
  assert.match(rb, /LIMITE ASSUMÉE/);
  assert.match(rb, /Le jeton n'est PAS une preuve d'absence/);
  assert.match(doc, /ne PROUVE pas|ne prouve pas/i);
  for (const c of ["SQL dynamique", "pg_cron", "clients externes", "jeton de revue"]) assert.ok(doc.includes(c), `doc : ${c}`);
  assert.doesNotMatch(doc, /complet(e)? et prouvé|découverte (exhaustive|complète)/i);
});

test("[V12-CALLER-10] inventaire des consommateurs : cohérent avec le SQL, avec le dépôt, et ses gardes existent", () => {
  assert.deepEqual([...inventory.engine.functions].sort(), names.filter((n: string) => !tabs.includes(n) && !cols.includes(n)).sort());
  assert.deepEqual([...inventory.engine.tables].sort(), [...tabs].sort());
  assert.deepEqual([...inventory.engine.columns_of_restaurant_fulfillment_schedule].sort(), [...cols].sort());
  for (const c of inventory.database_consumers) {
    assert.match(c.routine, /^public\./);
    for (const g of c.rollback_guards) assert.ok(rbCode.includes(`[${g}]`), `garde ${g} absente du retour`);
  }
  assert.ok(inventory.unprovable_consumer_classes.length >= 4);
  assert.ok(inventory.unprovable_policy.length > 20);
});

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

test("[V12-CALLER-11] le dépôt ne contient aucun appel .rpc / .from vers un objet du moteur hors de l'inventaire", () => {
  const engineObjects = new Set<string>([...inventory.engine.functions, ...inventory.engine.tables]);
  const declared = new Set<string>(inventory.repository_consumers.map((c: { file: string }) => c.file));
  const found = new Set<string>();
  for (const dir of inventory.repository_scan.directories as string[]) {
    for (const f of walk(dir)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.(?:rpc|from)\(\s*(["'`])([a-z0-9_]+)\1/g)) {
        if (engineObjects.has(m[2])) found.add(f);
      }
    }
  }
  assert.deepEqual([...found].sort(), [...declared].sort(), "consommateur applicatif non inventorié (ou inventorié à tort)");
});

test("[V12-CALLER-12] le harnais couvre : schémas externes, dépendances, pg_cron, SQL dynamique, jeton périmé, mutations de chaque garde", () => {
  for (const m of [
    "[21c] LIMITE DÉMONTRÉE",
    "[21g] jeton PÉRIMÉ",
    "[21j] LIMITE RÉSIDUELLE DÉMONTRÉE",
    "[21k]",
    "ENGINE_DEPENDENT",
    "CRON_JOB",
    "ENGINE_SURFACE",
    "exclusion du moteur par NOM au lieu de l'OID",
    "inspection limitée au schéma public",
    "contrôle des dépendances enregistrées (pg_depend) retiré",
    "contrôle pg_cron retiré",
    "garde du jeton de revue retirée",
    "garde d'isolation retirée",
    "resolve_fulfillment_schedule_v1 retiré des noms surveillés",
    "SURCHARGE de même NOM",
    "BEGIN ATOMIC",
    "clé étrangère externe",
    "politique RLS externe",
  ]) assert.ok(harness.includes(m), `harnais : ${m} absent`);
});

// ------------------------------------------------------- DEPLOY-01 INCHANGÉ
test("[V12-FROZEN-1] DEPLOY-01 est CLOS : l'aller n'est pas modifié par cette remédiation (empreinte épinglée)", () => {
  const sha = createHash("sha256").update(readFileSync(FWD)).digest("hex");
  assert.equal(sha, "c1428bc409f5c123b382198eaac75916cfa037a0517a4bd1e457faa3805562c2");
});

test("[V12-FROZEN-2] le retour ne touche ni create_order, ni le paiement, ni l'expiration des réservations", () => {
  assert.doesNotMatch(rbCode, /(create (or replace )?function|alter function|drop function) public\.(create_order|update_order_status|initiate_payment_attempt)\b/);
  assert.doesNotMatch(rbCode, /expir/i);
  assert.match(rbCode, /c327445751333e7908d60e6d7f838eb5/);
});
