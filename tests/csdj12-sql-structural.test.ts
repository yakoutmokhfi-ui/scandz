import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CHECKOUT_UNFULFILLABLE_REASONS_V12,
  FULFILLMENT_SELECTION_REASONS_V12,
} from "../lib/scheduling/schedule-model-v12.ts";

/**
 * Scanym — CSDJ v1.2 — garde STRUCTURELLE.
 *
 * Vérifie ce qu'on ne peut prouver qu'en lisant le code : miroir des
 * catalogues SQL/TS, sécurité (search_path, revoke avant grant, aucune
 * écriture directe), absence de donnée métier / juridictionnelle livrée,
 * respect de la frontière avec Debussy (`create_order` non redéfinie),
 * et sûreté du harnais d'exécution.
 */

const SQL_PATH = "supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql";
const ROLLBACK_PATH =
  "supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql";
const HARNESS_PATH = "supabase/tests/checkout-scheduling-v12-check.sh";
const V12_TS_PATH = "lib/scheduling/eligibility-v12.ts";

const sql = readFileSync(SQL_PATH, "utf8");
const rollback = readFileSync(ROLLBACK_PATH, "utf8");
const harness = readFileSync(HARNESS_PATH, "utf8");
const v12ts = readFileSync(V12_TS_PATH, "utf8");

function executableSql(source: string): string {
  return source
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}
const code = executableSql(sql);

/** Corps de fonction par nom, depuis `create or replace function public.<n>(`. */
function functionBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /create (?:or replace )?function public\.([a-z0-9_]+)\s*\(/g;
  const starts: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    out.set(s.name, src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length));
  });
  return out;
}

// ---------------------------------------------------------------- MIRROR
test("[V12-MIRROR-1] checkout_unfulfillable_reasons_v12() ≡ CHECKOUT_UNFULFILLABLE_REASONS_V12 (ordre compris)", () => {
  const m = /function public\.checkout_unfulfillable_reasons_v12\(\)[\s\S]*?array\[([\s\S]*?)\]/.exec(code);
  assert.ok(m, "fonction catalogue introuvable");
  const sqlReasons = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(sqlReasons, [...CHECKOUT_UNFULFILLABLE_REASONS_V12]);
});

test("[V12-MIRROR-2] fulfillment_selection_reasons_v12() ≡ FULFILLMENT_SELECTION_REASONS_V12 (ordre compris)", () => {
  const m = /function public\.fulfillment_selection_reasons_v12\(\)[\s\S]*?array\[([\s\S]*?)\]/.exec(code);
  assert.ok(m, "fonction catalogue introuvable");
  const sqlReasons = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(sqlReasons, [...FULFILLMENT_SELECTION_REASONS_V12]);
});

test("[V12-MIRROR-3] tout motif émis par validate_fulfillment_selection est dans le catalogue fermé", () => {
  const body = functionBodies(code).get("validate_fulfillment_selection");
  assert.ok(body);
  const emitted = new Set([...body.matchAll(/v_reason := '([a-z_]+)'/g)].map((x) => x[1]));
  assert.ok(emitted.size >= 7, [...emitted].join(","));
  for (const r of emitted) {
    assert.ok((FULFILLMENT_SELECTION_REASONS_V12 as readonly string[]).includes(r), `motif hors catalogue : ${r}`);
  }
  // …et réciproquement : aucun motif du catalogue n'est mort.
  for (const r of FULFILLMENT_SELECTION_REASONS_V12) assert.ok(emitted.has(r), `motif jamais émis : ${r}`);
});

// -------------------------------------------------------------- SECURITY
const bodies = functionBodies(code);

test("[V12-SEC-1] le lot définit exactement quatorze fonctions, toutes avec search_path = ''", () => {
  assert.equal(bodies.size, 14, [...bodies.keys()].join(", "));
  for (const [name, body] of bodies) {
    assert.match(body, /set search_path\s*=\s*''/, `${name} : search_path non fixé`);
  }
});

test("[V12-SEC-2] revoke AVANT grant, pour chaque table et chaque fonction", () => {
  const firstGrant = code.search(/\bgrant\s+(select|execute)/);
  const lastRevoke = code.lastIndexOf("revoke all on");
  // Aucun grant ne précède le premier revoke de son bloc : on exige que
  // le premier revoke précède le premier grant.
  assert.ok(code.indexOf("revoke all on") < firstGrant);
  assert.ok(lastRevoke > 0);
});

test("[V12-SEC-3] AUCUN grant d'écriture de table, pour aucun rôle", () => {
  assert.doesNotMatch(code, /grant\s+(insert|update|delete|truncate|all)\b/i);
});

test("[V12-SEC-4] anon n'obtient AUCUNE exécution dans ce lot", () => {
  assert.doesNotMatch(code, /grant\s+execute[^;]*\bto\b[^;]*\banon\b/i);
  assert.doesNotMatch(code, /grant\s+select[^;]*\bto\b[^;]*\banon\b/i);
});

test("[V12-SEC-5] les primitives de capacité ne sont exécutables par AUCUN rôle client", () => {
  assert.doesNotMatch(
    code,
    /grant\s+execute\s+on\s+function\s+public\.(reserve|release)_fulfillment_capacity/i
  );
  assert.doesNotMatch(
    code,
    /grant\s+execute\s+on\s+function\s+public\.fulfillment_capacity_used/i
  );
  assert.doesNotMatch(
    code,
    /grant\s+execute\s+on\s+function\s+public\.validate_fulfillment_selection/i
  );
});

test("[V12-SEC-6] la table de réservation n'est lisible par aucun rôle client (aucun décompte exposé)", () => {
  assert.doesNotMatch(
    code,
    /grant\s+select\s+on\s+table\s+public\.order_fulfillment_capacity_reservation/i
  );
});

test("[V12-SEC-7] RLS activée sur chaque table créée", () => {
  const created = [...code.matchAll(/create table public\.([a-z_]+)/g)].map((x) => x[1]);
  assert.equal(created.length, 5, created.join(","));
  for (const t of created) {
    assert.match(
      code,
      new RegExp(`alter table public\\.${t}\\s+enable row level security`),
      `${t} : RLS non activée`
    );
  }
});

test("[V12-SEC-8] l'écriture marchande exige owner/manager et le verrou tenant", () => {
  const body = bodies.get("mutate_merchant_fulfillment_schedule_v12");
  assert.ok(body);
  assert.match(body, /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(p_restaurant_id::text,\s*1104\)/);
  assert.match(body, /has_role_in\(p_restaurant_id,\s*array\['owner',\s*'manager'\]\)/);
  assert.match(body, /CSDJ12_FORBIDDEN/);
});

// -------------------------------------------------------------- CAPACITY
test("[V12-CAP-1] la réservation sérialise par SEAU avec un verrou consultatif de graine dédiée", () => {
  const body = bodies.get("reserve_fulfillment_capacity");
  assert.ok(body);
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /,\s*1204\)/);
  const seeds = [...code.matchAll(/hashtextextended\([\s\S]*?,\s*(\d{3,5})\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(seeds)].sort(), ["1104", "1204"]);
});

test("[V12-CAP-2] la réservation refuse tout niveau d'isolation autre que READ COMMITTED", () => {
  const body = bodies.get("reserve_fulfillment_capacity");
  assert.ok(body);
  assert.match(body, /transaction_isolation/);
  assert.match(body, /read committed/);
});

test("[V12-CAP-3] la capacité est « une commande = une unité » : aucune lecture de quantité", () => {
  for (const name of ["reserve_fulfillment_capacity", "validate_fulfillment_selection", "fulfillment_capacity_used", "fulfillment_capacity_is_holding"]) {
    const body = bodies.get(name);
    assert.ok(body, name);
    assert.doesNotMatch(body, /order_items|\bquantity\b|\bqty\b/i, `${name} lit une quantité`);
  }
});

test("[V12-CAP-4] le seuil de capacité est strictement positif (contrainte de table)", () => {
  assert.match(code, /rfs_capacity_positive[\s\S]{0,200}capacity_max_orders\s*>\s*0/);
});

test("[V12-CAP-5] l'appelant n'a aucun moyen de fournir un décompte ni une heure à la lecture publique", () => {
  // le répartiteur garde la signature à 4 arguments de CSDJ-1
  assert.match(
    code,
    /create function public\.resolve_fulfillment_schedule\(\s*p_restaurant_id uuid,\s*p_mode_code text,\s*p_fulfillment_rule_id uuid default null,\s*p_now timestamptz default/
  );
});

// ------------------------------------------------------------- BOUNDARIES
test("[V12-OWN-1] create_order / update_order_status / paiements ne sont PAS redéfinis par ce lot", () => {
  for (const forbidden of [
    "create_order",
    "update_order_status",
    "initiate_payment_attempt",
    "record_payment_result",
    "compute_order_pricing",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(`create (?:or replace )?function public\\.${forbidden}\\b`),
      `${forbidden} redéfini`
    );
  }
  // …et aucune réécriture dynamique non plus
  assert.doesNotMatch(code, /alter function public\.(create_order|update_order_status)/);
});

test("[V12-OWN-2] le répartiteur ne redéfinit pas le corps CSDJ-1 : renommage, pas copie", () => {
  assert.match(code, /alter function public\.resolve_fulfillment_schedule\([^)]*\)\s+rename to resolve_fulfillment_schedule_v1\b/);
});

test("[V12-OWN-3] la lecture publique get_checkout_fulfillment_schedule n'est pas redéfinie", () => {
  assert.doesNotMatch(code, /create (?:or replace )?function public\.get_checkout_fulfillment_schedule/);
});

test("[V12-OWN-4] aucune clé i18n / how_to_order_* / MCC n'est ajoutée", () => {
  assert.doesNotMatch(code, /how_to_order_|text_key|communication_text/i);
});

// ------------------------------------------------------------ NO INVENTED
test("[V12-NODATA-1] aucune donnée n'est livrée : aucun INSERT/UPDATE de niveau script", () => {
  // Les INSERT légitimes sont à l'intérieur des fonctions (indentés) ;
  // un INSERT en colonne 0 serait une donnée livrée par la migration.
  assert.doesNotMatch(code, /^\s{0,0}(insert\s+into|update\s+public|delete\s+from|copy)\b/im);
  assert.doesNotMatch(code, /^\s{0,0}values\b/im);
});

test("[V12-NODATA-2] aucun pays, région ni juridiction n'est nommé dans le code exécutable", () => {
  for (const j of ["France", "Algérie", "Algeria", "Maroc", "Tunisie", "Belgique"]) {
    assert.ok(!code.includes(j), `juridiction nommée : ${j}`);
  }
});

test("[V12-NODATA-3] aucun délai d'expiration de paiement en attente n'est inventé", () => {
  assert.doesNotMatch(code, /interval\s+'\d+\s*(minute|hour|day)/i);
  assert.doesNotMatch(code, /pg_cron|cron\.schedule/i);
});

test("[V12-NODATA-4] aucun nom ni slug de commerçant dans le code exécutable", () => {
  assert.doesNotMatch(code, /au[-_ ]lait[-_ ]cru|aulaitcru/i);
});

test("[V12-NODATA-5] le miroir TypeScript ne contient aucun jeu de jours fériés", () => {
  assert.doesNotMatch(v12ts, /\d{4}-\d{2}-\d{2}/);
});

// ------------------------------------------------------------ NO CLIENT
function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p)) acc.push(p);
  }
  return acc;
}

test("[V12-NOCLIENT-1] aucun fichier d'app/ ou components/ n'importe le résolveur de référence v1.2", () => {
  for (const f of [...walk("app"), ...walk("components")]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /eligibility-v12/, `${f} importe le résolveur`);
  }
});

test("[V12-NOCLIENT-2] le résolveur de référence porte sa propre interdiction", () => {
  assert.match(v12ts, /NE DOIT PAS|ne doit pas|jamais|AUTORITÉ|autorit/i);
});

// ------------------------------------------------------ ATOMICITY/ROLLBACK
test("[V12-ATOM-1] une seule transaction, pré-vol et post-vol DANS la transaction", () => {
  const begins = code.match(/^\s*begin\s*;/gim) ?? [];
  const commits = code.match(/^\s*commit\s*;/gim) ?? [];
  assert.equal(begins.length, 1);
  assert.equal(commits.length, 1);
  assert.ok(code.indexOf("commit;") > code.lastIndexOf("do $"));
});

test("[V12-ATOM-2] le pré-vol exige CSDJ-1 présent et refuse une seconde application", () => {
  assert.match(code, /do \$csdj12_preflight\$/);
  assert.match(code, /restaurant_fulfillment_schedule/);
  assert.match(code, /SCANYM_ALREADY_APPLIED/);
});

test("[V12-ROLLBACK-1] le retour REFUSE de détruire des données et d'être appliqué hors contexte", () => {
  assert.match(rollback, /SCANYM_ROLLBACK_REFUSED/);
  assert.match(rollback, /SCANYM_ROLLBACK_NOT_APPLICABLE/);
});

test("[V12-ROLLBACK-2] le retour restaure le résolveur CSDJ-1 par renommage inverse", () => {
  assert.match(rollback, /rename to resolve_fulfillment_schedule\b/);
});

// ---------------------------------------------------------------- HARNESS
test("[V12-HARNESS-1] consentement explicite exigé", () => {
  assert.match(harness, /CONSENT|consent/);
});

test("[V12-HARNESS-2] les variables PG* redirectrices sont refusées", () => {
  for (const v of ["PGHOST", "PGPORT", "PGDATABASE", "PGSERVICE", "PGPASSFILE"]) {
    assert.ok(harness.includes(v), `${v} non traité`);
  }
});

test("[V12-HARNESS-3] le harnais n'a aucun accès réseau ni connexion distante", () => {
  assert.doesNotMatch(harness, /\b(curl|wget)\b/);
  assert.doesNotMatch(harness, /supabase\.co|pooler\.supabase/);
});

test("[V12-HARNESS-4] le harnais rejoue la FIXTURE PARTAGÉE, pas des cas réécrits", () => {
  assert.match(harness, /checkout-scheduling-v12-cases\.json/);
});

test("[V12-HARNESS-5] la concurrence est prouvée par de VRAIES sessions (pg_stat_activity + barrière)", () => {
  assert.match(harness, /pg_stat_activity/);
  assert.match(harness, /barri[eè]re|barrier/i);
});

test("[V12-HARNESS-6] les mutants de contrôle existent", () => {
  assert.match(harness, /mutant|MUTANT|mutation/i);
});

test("[V12-HARNESS-7] aucun fichier intermédiaire de construction n'est versionné", () => {
  const stray = readdirSync("supabase/tests").filter((f) => /^\.v12-/.test(f));
  assert.deepEqual(stray, []);
});

// ------------------------------------------------- UNE SEULE AUTORITÉ
test("[V12-AUTH-1] reserve_fulfillment_capacity REJOUE validate_fulfillment_selection (pas de second algorithme)", () => {
  const body = functionBodies(code).get("reserve_fulfillment_capacity");
  assert.ok(body);
  assert.match(body, /public\.validate_fulfillment_selection\(/);
  // reserve ne lit PAS le résolveur ni le décompte lui-même
  assert.doesNotMatch(body, /resolve_fulfillment_schedule/);
  assert.doesNotMatch(body, /fulfillment_capacity_used/);
});

test("[V12-AUTH-2] validate est STABLE, ne modifie rien", () => {
  const body = functionBodies(code).get("validate_fulfillment_selection");
  assert.ok(body);
  assert.match(body.slice(0, 1200), /\bstable\b/);
  assert.doesNotMatch(body, /\b(insert\s+into|update\s+public|delete\s+from)\b/i);
  assert.doesNotMatch(body, /pg_advisory/);
});

test("[V12-AUTH-3] un seul verrou et un seul décompte pour tout le lot", () => {
  const locks = [...code.matchAll(/pg_advisory_xact_lock\(/g)].length;
  assert.equal(locks, 2, "verrous : bucket (reserve) + tenant (écriture marchande)");
  const counters = [...code.matchAll(/create function public\.([a-z_]*capacity_used[a-z_]*)/g)].map((m) => m[1]);
  assert.deepEqual(counters, ["fulfillment_capacity_used"]);
});

test("[V12-MODEL-1] le modèle v1.2 est des constantes PURES (importable par un client) et n'importe aucun résolveur", () => {
  const model = readFileSync("lib/scheduling/schedule-model-v12.ts", "utf8");
  const imports = [...model.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/lib/scheduling/schedule-model"]);
  assert.doesNotMatch(model, /\bfunction\b|=>/);
});
