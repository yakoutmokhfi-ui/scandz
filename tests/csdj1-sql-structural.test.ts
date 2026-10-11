import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CHECKOUT_DATE_SELECTION_MODES,
  CHECKOUT_SCHEDULE_STATUSES,
  CHECKOUT_SLOT_SELECTION_MODES,
  CHECKOUT_UNFULFILLABLE_REASONS,
  CHECKOUT_WALL_TIME_STATUSES,
  SCHEDULE_CLOSURE_LABEL_MAX_LENGTH,
  SCHEDULE_CUTOFF_OFFSET_DAYS_MAX,
  SCHEDULE_LEAD_TIME_MINUTES_MAX,
  SCHEDULE_MIN_LEAD_DAYS_MAX,
  SCHEDULE_BOOKING_HORIZON_DAYS_MAX,
  SCHEDULE_BOOKING_HORIZON_DAYS_MIN,
  SCHEDULE_SLOT_KEY_MAX_LENGTH,
  SCHEDULE_TIMEZONE_MAX_LENGTH,
  SCHEDULE_TIME_GRANULARITY_MINUTES_MAX,
  SCHEDULE_TIME_GRANULARITY_MINUTES_MIN,
} from "../lib/scheduling/schedule-model.ts";
import { COMMUNICATION_TEXT_KEYS } from "../lib/communications/text-keys.ts";

/**
 * Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1) — garde STRUCTURELLE.
 *
 * Ce fichier ne teste pas un comportement : il vérifie que deux
 * AUTORITÉS qui doivent dire la même chose la disent effectivement, et
 * que les engagements du mandat qu'on ne peut prouver qu'en lisant le
 * code sont tenus -- y compris les BORNES DE PROPRIÉTÉ avec le lot
 * THEME & CONTENT SETTINGS v1 (Debussy), qu'aucun test de comportement
 * ne saurait exprimer.
 *
 * La dérive entre un catalogue SQL et son miroir TypeScript est
 * SILENCIEUSE : rien ne casse, une valeur cesse simplement d'être
 * acceptée d'un côté.
 */

const SQL_PATH = "supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql";
const ROLLBACK_PATH =
  "supabase/DRAFT-lot-checkout-scheduling-foundation-v1-rollback.sql";
const HARNESS_PATH = "supabase/tests/checkout-scheduling-foundation-v1-check.sh";
const MODEL_PATH = "lib/scheduling/schedule-model.ts";
const ELIGIBILITY_PATH = "lib/scheduling/eligibility.ts";

const sql = readFileSync(SQL_PATH, "utf8");
const rollback = readFileSync(ROLLBACK_PATH, "utf8");
const harness = readFileSync(HARNESS_PATH, "utf8");
const modelSrc = readFileSync(MODEL_PATH, "utf8");
const eligibilitySrc = readFileSync(ELIGIBILITY_PATH, "utf8");

/**
 * Code SQL EXÉCUTABLE seul : les commentaires `--` sont retirés. La
 * documentation peut légitimement NOMMER ce que le code ne doit pas
 * faire ; les confondre produit des faux positifs.
 */
function executableSql(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");
}
const execSql = executableSql(sql);
const execRollback = executableSql(rollback);

/** Même traitement pour un script shell. */
function executableShell(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => {
      const i = line.indexOf(" #");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");
}
const execHarness = executableShell(harness);

/** Littéraux d'un `array[ 'a', 'b' ]` d'une fonction de catalogue, dans
 *  l'ordre du fichier. */
function sqlArrayLiterals(functionName: string): string[] {
  const start = execSql.indexOf(`create function public.${functionName}()`);
  assert.ok(start > 0, `${functionName}() doit être déclarée dans le SQL`);
  const body = execSql.slice(start, execSql.indexOf("$$;", start));
  const open = body.indexOf("array[");
  assert.ok(open > 0, `${functionName}() doit déclarer un array[...]`);
  const close = body.indexOf("]", open);
  return [...body.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Bloc textuel d'une déclaration `create function public.<nom>(` … */
function sqlFunctionBlock(signatureStart: string): string {
  const start = execSql.indexOf(signatureStart);
  assert.ok(start > 0, `${signatureStart} doit être déclarée dans le SQL`);
  const next = execSql.indexOf("\ncreate function", start + 1);
  return execSql.slice(start, next < 0 ? undefined : next);
}

// ====================================================================
// MIROIRS SQL ↔ TypeScript
// ====================================================================

test("[MIRROR-1] checkout_date_selection_modes() ≡ CHECKOUT_DATE_SELECTION_MODES", () => {
  // deepEqual ORDONNÉ, pas une comparaison d'ensembles : l'ordre est
  // celui dans lequel le back-office présentera les choix.
  assert.deepEqual(sqlArrayLiterals("checkout_date_selection_modes"), [
    ...CHECKOUT_DATE_SELECTION_MODES,
  ]);
});

test("[MIRROR-2] checkout_slot_selection_modes() ≡ CHECKOUT_SLOT_SELECTION_MODES", () => {
  assert.deepEqual(sqlArrayLiterals("checkout_slot_selection_modes"), [
    ...CHECKOUT_SLOT_SELECTION_MODES,
  ]);
});

test("[MIRROR-3] checkout_schedule_statuses() ≡ CHECKOUT_SCHEDULE_STATUSES", () => {
  assert.deepEqual(sqlArrayLiterals("checkout_schedule_statuses"), [
    ...CHECKOUT_SCHEDULE_STATUSES,
  ]);
});

test("[MIRROR-4] checkout_unfulfillable_reasons() ≡ CHECKOUT_UNFULFILLABLE_REASONS", () => {
  assert.deepEqual(sqlArrayLiterals("checkout_unfulfillable_reasons"), [
    ...CHECKOUT_UNFULFILLABLE_REASONS,
  ]);
});

test("[MIRROR-9] checkout_wall_time_statuses() ≡ CHECKOUT_WALL_TIME_STATUSES", () => {
  // Le classement d'une heure murale est un CATALOGUE FERMÉ, au même
  // titre que les statuts de planning : trois valeurs, exactement, et
  // les mêmes des deux côtés. Un quatrième état d'un seul côté serait
  // une politique qui diverge en silence.
  assert.deepEqual(sqlArrayLiterals("checkout_wall_time_statuses"), [
    ...CHECKOUT_WALL_TIME_STATUSES,
  ]);
  assert.equal(CHECKOUT_WALL_TIME_STATUSES.length, 3);
});

test("[MIRROR-5] la forme d'une clé de créneau est la MÊME des deux côtés", () => {
  // Une classe de caractères plus large d'un côté laisserait passer une
  // clé que l'autre côté refuserait -- et un créneau cesserait d'être
  // sélectionnable sans qu'aucune erreur ne soit levée.
  assert.ok(
    execSql.includes("slot_key ~ '^[a-z0-9_-]+$'"),
    "le CHECK SQL doit porter exactement cette classe de caractères"
  );
  assert.ok(
    modelSrc.includes("/^[a-z0-9_-]+$/"),
    "SCHEDULE_SLOT_KEY_PATTERN doit porter exactement la même"
  );
});

test("[MIRROR-6] la contrainte de cohérence des politiques mire isSchedulePolicyCoherent", () => {
  const normalized = execSql.replace(/\s+/g, " ");
  assert.ok(
    normalized.includes(
      "check (date_selection_mode = 'customer_selectable' or slot_selection_mode = 'none')"
    ),
    "la contrainte rfs_policy_coherent doit dire exactement la même règle que le TypeScript"
  );
  assert.ok(
    modelSrc.replace(/\s+/g, " ").includes(
      'return dateMode === "customer_selectable" || slotMode === "none";'
    ),
    "isSchedulePolicyCoherent doit dire exactement la même règle que le SQL"
  );
});

test("[MIRROR-7] les bornes numériques sont les mêmes des deux côtés", () => {
  const normalized = execSql.replace(/\s+/g, " ");
  const expectations: ReadonlyArray<[string, string]> = [
    [
      "granularité",
      `time_granularity_minutes between ${SCHEDULE_TIME_GRANULARITY_MINUTES_MIN} and ${SCHEDULE_TIME_GRANULARITY_MINUTES_MAX}`,
    ],
    ["délai", `lead_time_minutes between 0 and ${SCHEDULE_LEAD_TIME_MINUTES_MAX}`],
    ["minimum de jours", `min_lead_days between 0 and ${SCHEDULE_MIN_LEAD_DAYS_MAX}`],
    [
      "décalage d'heure limite",
      `cutoff_offset_days between 0 and ${SCHEDULE_CUTOFF_OFFSET_DAYS_MAX}`,
    ],
    [
      "horizon",
      `booking_horizon_days between ${SCHEDULE_BOOKING_HORIZON_DAYS_MIN} and ${SCHEDULE_BOOKING_HORIZON_DAYS_MAX}`,
    ],
    [
      "longueur de clé de créneau",
      `pg_catalog.length(slot_key) between 1 and ${SCHEDULE_SLOT_KEY_MAX_LENGTH}`,
    ],
    [
      "longueur de fuseau",
      `pg_catalog.length(pg_catalog.btrim(timezone)) between 1 and ${SCHEDULE_TIMEZONE_MAX_LENGTH}`,
    ],
    [
      "longueur de libellé de fermeture",
      `between 1 and ${SCHEDULE_CLOSURE_LABEL_MAX_LENGTH}`,
    ],
  ];
  for (const [label, fragment] of expectations) {
    assert.ok(
      normalized.includes(fragment),
      `borne « ${label} » absente ou divergente : ${fragment}`
    );
  }
});

test("[MIRROR-8] la convention de jour de semaine est la même des deux côtés", () => {
  // 0 = dimanche, des deux côtés. Une convention ISO d'un seul côté
  // décalerait tous les jours d'un rang, ce qui se verrait sur le
  // produit mais pas forcément en relecture.
  assert.ok(execSql.includes("weekday between 0 and 6"));
  assert.ok(
    execSql.includes("pg_catalog.date_part('dow', v_d)::smallint"),
    "le SQL doit dériver le jour de semaine avec date_part('dow'), qui vaut 0 le dimanche"
  );
  assert.ok(
    eligibilitySrc.includes("getUTCDay()"),
    "le TypeScript doit dériver le jour de semaine avec getUTCDay(), qui vaut 0 le dimanche"
  );
});

// ====================================================================
// AUCUNE FUITE DE FOURNISSEUR — mandat et décision CIO
// ====================================================================

test("[NO-PROVIDER-1] la lecture publique n'expose ni provider, ni code de fulfillment", () => {
  const block = sqlFunctionBlock(
    "create function public.get_checkout_fulfillment_schedule("
  );
  const returns = block.slice(block.indexOf("returns table"), block.indexOf("language"));
  for (const forbidden of [
    "provider",
    "fulfillment_code",
    "fulfillment_rule_id",
    "zone_prefixes",
    "config",
  ]) {
    assert.ok(
      !returns.includes(forbidden),
      `la signature de retour publique ne doit pas contenir « ${forbidden} » : le client ne choisit pas son transporteur`
    );
  }
});

test("[NO-PROVIDER-2] le post-vol interdit lui aussi cette fuite", () => {
  // Une garde en test protège le fichier ; une garde en post-vol protège
  // la base le jour où quelqu'un applique une variante du fichier.
  assert.ok(
    execSql.includes("SCANYM_POSTCHECK: la lecture publique exposerait la colonne"),
    "le post-vol doit refuser une signature publique qui exposerait une colonne interdite"
  );
});

test("[NO-SECOND-ENGINE-1] aucune formule de tarification n'est réécrite", () => {
  // Mandat §G : réutiliser le moteur existant, ne pas en créer un
  // second. On appelle l'autorité, on ne recopie pas sa formule.
  assert.ok(
    execSql.includes("public.resolve_delivery_fulfillment("),
    "l'autorité de tarification existante doit être APPELÉE"
  );
  for (const formula of [
    "free_above_threshold",
    "discount_percentage / 100",
    "discount_percentage/100",
    "pg_catalog.round(",
  ]) {
    assert.ok(
      !execSql.includes(formula),
      `ce lot ne doit contenir aucune arithmétique tarifaire (« ${formula} »)`
    );
  }
  // Les champs tarifaires ne sont que RECOPIÉS depuis l'appel.
  assert.ok(execSql.includes("v_del.delivery_fee"));
  assert.ok(execSql.includes("v_del.pricing_mode"));
  assert.ok(execSql.includes("v_del.free_threshold"));
});

test("[NO-SECOND-ENGINE-2] seules les colonnes COMMUNES du résolveur sont lues", () => {
  // CSDJ1-V1-RESOLVER-COMMON-COLUMNS-01 : les trois colonnes de remise
  // n'existent que dans la variante B5, encore DRAFT. Les lire créerait
  // une dépendance dure envers un lot non appliqué, et l'application de
  // CSDJ-1 échouerait sur l'état réel de la base.
  for (const b5Only of [
    "v_del.discount_enabled",
    "v_del.discount_threshold",
    "v_del.discount_percentage",
  ]) {
    assert.ok(
      !execSql.includes(b5Only),
      `ce lot ne doit pas lire ${b5Only} : colonne propre à la variante B5 non appliquée`
    );
  }
  // Et le pré-vol refuse si l'une des colonnes communes disparaissait.
  assert.ok(
    execSql.includes(
      "SCANYM_SCHEMA_DRIFT: resolve_delivery_fulfillment ne renvoie pas la colonne de sortie attendue"
    ),
    "le pré-vol doit refuser une forme de résolveur amputée"
  );
});

// ====================================================================
// BORNES DE PROPRIÉTÉ — THEME & CONTENT SETTINGS v1 (Debussy)
// ====================================================================

test("[OWNERSHIP-1] aucune clé how_to_order_* n'est ajoutée, nulle part", () => {
  // Ajustement obligatoire n°1 de la décision CIO : cette surface
  // éditoriale appartient à Debussy.
  // Code EXÉCUTABLE seul : l'en-tête du lot NOMME légitimement ce qu'il
  // ne fait pas, et confondre documentation et code produirait un faux
  // positif (leçon du garde NO-HARDCODE de MCC v1).
  for (const [path, source] of [
    [SQL_PATH, execSql],
    [ROLLBACK_PATH, execRollback],
    [HARNESS_PATH, execHarness],
    [MODEL_PATH, modelSrc],
    [ELIGIBILITY_PATH, eligibilitySrc],
  ] as const) {
    assert.ok(
      !source.includes("how_to_order"),
      `${path} ne doit contenir aucune clé how_to_order_* dans son code exécutable (périmètre Debussy)`
    );
  }
  // Et le SQL doit DIRE, en commentaire, que cette surface ne lui
  // appartient pas : la frontière se documente aussi.
  assert.ok(
    sql.includes("how_to_order_button"),
    "l'en-tête du lot doit nommer la surface qu'il laisse à Debussy"
  );
});

test("[OWNERSHIP-2] le catalogue MCC n'est pas étendu par ce lot", () => {
  // MCC v1.1 porte 14 emplacements. Ce lot n'en ajoute aucun : si ce
  // nombre bouge, c'est que la frontière de propriété a été franchie.
  assert.equal(
    COMMUNICATION_TEXT_KEYS.length,
    14,
    "CSDJ-1 ne doit pas toucher au catalogue de textes MCC"
  );
});

test("[OWNERSHIP-3] ce lot ne porte aucun texte client ni aucune clé i18n", () => {
  // CSDJ-1 est un lot de données et d'autorité serveur. S'il portait une
  // phrase destinée au client, il empiéterait sur la surface éditoriale.
  for (const [path, src] of [
    [MODEL_PATH, modelSrc],
    [ELIGIBILITY_PATH, eligibilitySrc],
  ] as const) {
    assert.ok(
      !src.includes("@/lib/i18n"),
      `${path} ne doit pas importer le dictionnaire : aucun texte client dans ce lot`
    );
    assert.ok(
      !/\bt\("/.test(src),
      `${path} ne doit appeler aucun traducteur`
    );
  }
});

// ====================================================================
// LE NAVIGATEUR N'EST JAMAIS UNE AUTORITÉ
// ====================================================================

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

test("[NO-CLIENT-AUTHORITY-1] aucun fichier d'app/ ou components/ n'importe le résolveur", () => {
  // CSDJ-V1-REFERENCE-NOT-AUTHORITY-01. L'éligibilité est décidée par le
  // SERVEUR, avec SON horloge. Importer ce module dans un composant
  // rouvrirait la porte à une décision prise dans le navigateur -- le
  // défaut exact que ce lot est censé rendre impossible.
  const offenders: string[] = [];
  for (const dir of ["app", "components"]) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      if (
        src.includes("lib/scheduling/eligibility") ||
        src.includes("@/lib/scheduling/eligibility")
      ) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, [], "le résolveur de référence a fuité côté client");
});

test("[NO-CLIENT-AUTHORITY-2] le résolveur de référence porte sa propre interdiction", () => {
  assert.ok(
    eligibilitySrc.includes("CSDJ-V1-REFERENCE-NOT-AUTHORITY-01"),
    "l'invariant doit être nommé dans le module lui-même, pas seulement dans un test"
  );
  assert.ok(
    !eligibilitySrc.includes("Date.now()") && !eligibilitySrc.includes("new Date()"),
    "le résolveur ne doit JAMAIS lire une horloge : l'instant lui est fourni"
  );
});

test("[NO-CLIENT-AUTHORITY-3] la lecture publique n'accepte aucune heure de l'appelant", () => {
  const block = sqlFunctionBlock(
    "create function public.get_checkout_fulfillment_schedule("
  );
  const params = block.slice(0, block.indexOf("returns table"));
  for (const forbidden of ["timestamptz", "timestamp", "p_now", "date"]) {
    assert.ok(
      !params.includes(forbidden),
      `la RPC publique ne doit accepter aucun paramètre temporel (« ${forbidden} ») : l'horloge est celle du serveur`
    );
  }
  // Et l'autorité interne, qui accepte `p_now` pour la fixture, n'est
  // accessible à aucun rôle applicatif.
  assert.ok(
    execSql.includes(
      "revoke all on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz) from public, anon, authenticated, service_role;"
    ),
    "l'autorité interne doit être révoquée de tous les rôles"
  );
});

// ====================================================================
// POSTURE DE SÉCURITÉ
// ====================================================================

test("[SECURITY-1] toute fonction du lot fixe search_path = ''", () => {
  const declarations = [...execSql.matchAll(/create function public\.(\w+)\(/g)].map(
    (m) => m[1]!
  );
  assert.ok(declarations.length >= 8, "le lot déclare au moins huit fonctions");
  for (const name of declarations) {
    const block = sqlFunctionBlock(`create function public.${name}(`);
    assert.ok(
      block.includes("set search_path = ''"),
      `public.${name} doit fixer search_path = ''`
    );
  }
});

test("[SECURITY-2] revoke AVANT grant, pour chaque table et chaque fonction", () => {
  // Leçon SEC-2A3-01 : le contrat ne doit jamais dépendre des
  // privilèges par défaut de la plateforme.
  for (const table of [
    "restaurant_fulfillment_schedule",
    "restaurant_fulfillment_schedule_window",
    "restaurant_fulfillment_schedule_slot",
    "restaurant_fulfillment_schedule_closure",
  ]) {
    const revoke = execSql.indexOf(`revoke all on table public.${table} `);
    const grant = execSql.indexOf(`grant select on table public.${table} `);
    assert.ok(revoke > 0, `revoke manquant pour ${table}`);
    assert.ok(grant > 0, `grant manquant pour ${table}`);
    assert.ok(revoke < grant, `le revoke de ${table} doit précéder son grant`);
  }
  const fnRevoke = execSql.indexOf(
    "revoke all on function public.get_checkout_fulfillment_schedule"
  );
  const fnGrant = execSql.indexOf(
    "grant execute on function public.get_checkout_fulfillment_schedule"
  );
  assert.ok(fnRevoke > 0 && fnGrant > fnRevoke);
});

test("[SECURITY-3] AUCUN grant d'écriture de table, pour aucun rôle", () => {
  // L'écriture directe doit être structurellement impossible, pas
  // seulement interdite par convention.
  for (const priv of ["insert", "update", "delete", "truncate"]) {
    const re = new RegExp(`grant[^;]*\\b${priv}\\b[^;]*on table`, "i");
    assert.ok(
      !re.test(execSql),
      `aucun grant ${priv.toUpperCase()} sur table ne doit figurer dans ce lot`
    );
  }
});

test("[SECURITY-4] anon n'obtient l'exécution que de la SEULE lecture publique", () => {
  const grants = [
    ...execSql.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);/g),
  ];
  const anonTargets = grants
    .filter((m) => m[2]!.includes("anon"))
    .map((m) => m[1]!);
  assert.deepEqual(anonTargets, ["get_checkout_fulfillment_schedule"]);
});

test("[SECURITY-5] RLS activée sur les quatre tables, une policy SELECT chacune", () => {
  for (const table of [
    "restaurant_fulfillment_schedule",
    "restaurant_fulfillment_schedule_window",
    "restaurant_fulfillment_schedule_slot",
    "restaurant_fulfillment_schedule_closure",
  ]) {
    assert.ok(
      execSql.includes(`alter table public.${table} `) &&
        new RegExp(
          `alter table public\\.${table}\\s+enable row level security`
        ).test(execSql),
      `RLS doit être activée sur ${table}`
    );
  }
  const policies = [...execSql.matchAll(/create policy (\w+) on public\.(\w+)\s+for (\w+)/g)];
  assert.equal(policies.length, 4, "exactement quatre policies");
  for (const p of policies) {
    assert.equal(p[3], "select", `la policy ${p[1]} doit être une policy SELECT`);
  }
});

test("[SECURITY-6] l'écriture marchande exige owner/manager et un verrou tenant", () => {
  const block = sqlFunctionBlock(
    "create function public.mutate_merchant_fulfillment_schedule("
  );
  assert.ok(
    block.includes("public.has_role_in(p_restaurant_id, array['owner','manager'])"),
    "l'écriture doit exiger owner ou manager, décision CIO"
  );
  assert.ok(
    block.includes("pg_catalog.pg_advisory_xact_lock("),
    "deux éditions concurrentes du même établissement doivent se sérialiser"
  );
  assert.ok(
    block.includes("CSDJ1_FOREIGN_RULE"),
    "une règle de livraison d'un autre établissement doit être refusée nommément"
  );
  assert.ok(
    block.includes("pg_catalog.pg_timezone_names"),
    "le fuseau doit être validé contre le catalogue du serveur, pas contre une liste figée"
  );
});

test("[SECURITY-7] clé étrangère COMPOSITE : une fenêtre ne peut pas changer de tenant", () => {
  for (const [table, constraint] of [
    ["restaurant_fulfillment_schedule_window", "rfsw_schedule_fk"],
    ["restaurant_fulfillment_schedule_slot", "rfss_schedule_fk"],
    ["restaurant_fulfillment_schedule_closure", "rfsc_schedule_fk"],
  ] as const) {
    const start = execSql.indexOf(`create table public.${table} (`);
    assert.ok(start > 0, `${table} doit être déclarée`);
    const body = execSql.slice(start, execSql.indexOf("\n);", start));
    assert.ok(body.includes(constraint), `${table} doit porter ${constraint}`);
    assert.ok(
      body.replace(/\s+/g, " ").includes(
        "foreign key (restaurant_id, mode_code, rule_key)"
      ),
      `la clé étrangère de ${table} doit être composite et inclure restaurant_id`
    );
  }
});

// ====================================================================
// ADDITIVITÉ ET ATOMICITÉ
// ====================================================================

test("[ADDITIVE-1] aucune fonction préexistante n'est redéfinie", () => {
  // Mandat CSDJ-1 : la revalidation dans create_order est le périmètre
  // de CSDJ-3. Ce lot ne touche à rien d'existant.
  assert.ok(
    !/create or replace function/i.test(execSql),
    "ce lot ne doit redéfinir aucune fonction existante"
  );
  assert.ok(
    !/\bdrop function\b/i.test(execSql),
    "ce lot ne doit supprimer aucune fonction"
  );
  assert.ok(
    !/alter table public\.orders\b/i.test(execSql),
    "ce lot ne doit pas modifier la table orders"
  );
  assert.ok(
    !/alter table public\.restaurant_sale_mode_fulfillments\b/i.test(execSql),
    "ce lot ne doit pas modifier la table des règles de livraison"
  );
});

test("[ADDITIVE-2] le post-vol vérifie que create_order est intacte", () => {
  assert.ok(
    execSql.includes("ce lot ne doit pas y toucher") ||
      execSql.includes("p.proname = 'create_order'"),
    "le post-vol doit constater que create_order n'a pas été dupliquée"
  );
});

test("[ATOMICITY-1] une seule transaction, commit en dernière instruction", () => {
  for (const [label, source] of [
    ["aller", execSql],
    ["retour", execRollback],
  ] as const) {
    const begins = [...source.matchAll(/^\s*begin;\s*$/gm)];
    assert.equal(begins.length, 1, `${label} : un seul begin; explicite`);
    const statements = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    assert.equal(
      statements[statements.length - 1],
      "commit;",
      `${label} : commit; doit être la DERNIÈRE instruction exécutable`
    );
  }
});

test("[ATOMICITY-2] le pré-vol et le post-vol sont DANS la transaction", () => {
  const begin = execSql.indexOf("\nbegin;");
  const commit = execSql.lastIndexOf("commit;");
  const preflight = execSql.indexOf("$csdj1_preflight$");
  const postflight = execSql.indexOf("$csdj1_postflight$");
  assert.ok(begin < preflight && preflight < commit, "pré-vol hors transaction");
  assert.ok(begin < postflight && postflight < commit, "post-vol hors transaction");
});

test("[ADDITIVE-3] le pré-vol refuse une seconde application et une dérive de schéma", () => {
  assert.ok(execSql.includes("SCANYM_ALREADY_APPLIED"));
  assert.ok(execSql.includes("SCANYM_SCHEMA_DRIFT"));
  assert.ok(
    execSql.includes("public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)"),
    "le pré-vol doit exiger l'autorité de tarification que ce lot réutilise"
  );
  assert.ok(
    execSql.includes("pg_catalog.pg_timezone_names where name = 'Europe/Paris'"),
    "le pré-vol doit vérifier que la base de fuseaux du serveur est utilisable"
  );
});

test("[ROLLBACK-1] le retour défait exactement ce que l'aller a fait", () => {
  for (const fn of [
    "public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)",
    "public.get_merchant_fulfillment_schedules(uuid)",
    "public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)",
    "public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz)",
    "public.checkout_unfulfillable_reasons()",
    "public.checkout_schedule_statuses()",
    "public.checkout_slot_selection_modes()",
    "public.checkout_date_selection_modes()",
  ]) {
    assert.ok(
      execRollback.includes(`drop function if exists ${fn}`),
      `le retour doit supprimer ${fn}`
    );
  }
  for (const table of [
    "restaurant_fulfillment_schedule_closure",
    "restaurant_fulfillment_schedule_slot",
    "restaurant_fulfillment_schedule_window",
    "restaurant_fulfillment_schedule",
  ]) {
    assert.ok(
      execRollback.includes(`drop table if exists public.${table};`),
      `le retour doit supprimer ${table}`
    );
  }
  // Les tables partent AVANT les catalogues : leurs CHECK en dépendent.
  assert.ok(
    execRollback.indexOf("drop table if exists public.restaurant_fulfillment_schedule;") <
      execRollback.indexOf("drop function if exists public.checkout_unfulfillable_reasons()"),
    "les tables doivent être supprimées avant les catalogues dont dépendent leurs CHECK"
  );
});

test("[ROLLBACK-2] le retour REFUSE de passer sous un instantané de CSDJ-3", () => {
  // Supprimer la planification sous une table d'instantané de commande
  // casserait un historique. On refuse plutôt que de détruire.
  assert.ok(execRollback.includes("SCANYM_ROLLBACK_REFUSED"));
  assert.ok(execRollback.includes("order_fulfillment_schedule_snapshot"));
  assert.ok(execRollback.includes("SCANYM_ALREADY_REVERTED"));
});

// ====================================================================
// AUCUNE DATE INVENTÉE, AUCUN COMMERÇANT EN DUR
// ====================================================================

test("[NO-INVENTED-DATE-1] aucun délai ni intervalle métier en dur dans le SQL", () => {
  // Mandat : « Do NOT invent J+2 or J+3 ». Le seul calcul temporel admis
  // est relatif à des valeurs CONFIGURÉES.
  assert.ok(
    !/interval\s+'/i.test(execSql),
    "aucun littéral d'intervalle : tout délai vient de la configuration"
  );
  assert.ok(
    execSql.includes("pg_catalog.make_interval(mins => v_s.lead_time_minutes)"),
    "le délai doit être construit depuis la colonne configurée"
  );
  assert.ok(
    execSql.includes("v_today + v_s.min_lead_days") &&
      execSql.includes("v_today + v_s.booking_horizon_days"),
    "le minimum de jours et l'horizon doivent venir des colonnes configurées"
  );
});

test("[NO-HARDCODE-1] aucun nom ni slug de commerçant dans le code exécutable du lot", () => {
  for (const [path, source] of [
    [SQL_PATH, execSql],
    [ROLLBACK_PATH, execRollback],
    [MODEL_PATH, modelSrc],
    [ELIGIBILITY_PATH, eligibilitySrc],
    [HARNESS_PATH, execHarness],
  ] as const) {
    for (const needle of ["au-lait-cru", "au lait cru", "sanaa", "illico"]) {
      assert.ok(
        !source.toLowerCase().includes(needle),
        `${path} ne doit contenir aucune référence à « ${needle} »`
      );
    }
  }
});

test("[NO-HARDCODE-2] aucun fuseau en dur dans la décision", () => {
  // `Europe/Paris` n'apparaît que dans le pré-vol, pour vérifier que la
  // base de fuseaux du serveur fonctionne -- jamais comme fuseau de
  // calcul. Un fuseau en dur condamnerait tous les commerçants d'un
  // autre pays.
  // Les emplois LÉGITIMES sont des SONDES : le pré-vol vérifie que la
  // base de fuseaux du serveur fonctionne, le post-vol que la politique
  // d'heure murale refuse bien. Ce qui compte est l'absence de fuseau en
  // dur dans les fonctions qui DÉCIDENT.
  assert.ok(
    execSql.includes("pg_catalog.pg_timezone_names where name = 'Europe/Paris'"),
    "le pré-vol doit sonder la base de fuseaux du serveur"
  );
  // Aucun fuseau LITTÉRAL ne doit servir de fuseau de calcul : un
  // fuseau en dur condamnerait tout commerçant d'un autre pays. Les
  // seuls emplois admis sont des SONDES de pré-vol et de post-vol, qui
  // ne décident de rien.
  for (const hardcoded of [
    "at time zone 'Europe/Paris'",
    "'Europe/Paris', p_time",
  ]) {
    assert.ok(
      !execSql.includes(hardcoded),
      `aucun fuseau en dur ne doit servir de fuseau de calcul (« ${hardcoded} »)`
    );
  }

  // Cas particulier d'« at time zone 'UTC' » : ce n'est PAS un fuseau
  // métier, c'est le PIVOT sans lequel un `timestamp` nu ne peut pas
  // devenir un instant absolu. La classification d'heure murale en a
  // besoin pour énumérer ses instants candidats. Elle n'y localise
  // jamais l'heure du commerçant : cela, elle le fait avec
  // `p_timezone`.
  //
  // La garantie est donc : ce pivot n'existe QUE dans la
  // classification, et nulle part dans les fonctions qui décident de
  // l'éligibilité. Interdire le pivot partout aurait rendu la
  // classification impossible ; l'autoriser partout aurait rouvert le
  // fuseau en dur. On délimite.
  const countOf = (hay: string, needle: RegExp) => (hay.match(needle) ?? []).length;
  const UTC_PIVOT = /at time zone 'UTC'/g;
  const classifier =
    sqlFunctionBlock("create function public.checkout_wall_time_status(") +
    "\n" +
    sqlFunctionBlock("create function public.checkout_wall_time_instant(");
  assert.equal(
    countOf(execSql, UTC_PIVOT),
    countOf(classifier, UTC_PIVOT),
    "le pivot UTC ne doit apparaître QUE dans la classification d'heure murale"
  );
  assert.ok(
    countOf(classifier, UTC_PIVOT) > 0,
    "la classification doit bien employer un pivot explicite, et non une normalisation implicite"
  );
  for (const decider of [
    "create function public.resolve_fulfillment_schedule(",
    "create function public.get_checkout_fulfillment_schedule(",
  ]) {
    assert.ok(
      !/at time zone '/.test(sqlFunctionBlock(decider)),
      `aucun fuseau littéral ne doit intervenir dans ${decider}`
    );
  }
  // Et les deux fonctions de décision lisent bien un fuseau PARAMÉTRÉ.
  assert.ok(
    sqlFunctionBlock("create function public.resolve_fulfillment_schedule(")
      .includes("v_s.timezone"),
    "le résolveur doit lire le fuseau de la portée"
  );
  assert.ok(
    execSql.includes("at time zone p_timezone"),
    "la politique d'heure murale doit lire le fuseau qu'on lui passe"
  );
  const resolveBlock = sqlFunctionBlock(
    "create function public.resolve_fulfillment_schedule("
  );
  assert.ok(
    !resolveBlock.includes("Europe/Paris"),
    "le calcul d'éligibilité doit lire le fuseau de la portée, jamais un fuseau en dur"
  );
  assert.ok(
    resolveBlock.includes("at time zone v_s.timezone"),
    "le calcul doit employer le fuseau configuré"
  );
  assert.ok(
    !eligibilitySrc.includes("Europe/Paris"),
    "le résolveur de référence ne doit pas contenir de fuseau en dur"
  );
});

// ====================================================================
// HARNAIS PostgreSQL — sûreté, reprise du modèle MCC v1.1
// ====================================================================

test("[HARNESS-1] consentement explicite exigé", () => {
  assert.ok(execHarness.includes('"${SCANYM_DISPOSABLE_CLUSTER:-}" != "1"'));
  assert.ok(execHarness.includes("SCANYM_DISPOSABLE_CLUSTER=1 est requis"));
});

test("[HARNESS-2] les variables redirectrices sont refusées PAR LEUR NOM", () => {
  for (const v of [
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGDATABASE",
    "DATABASE_URL",
    "POSTGRES_URL",
    "SUPABASE_DB_URL",
  ]) {
    assert.ok(
      execHarness.includes(v),
      `${v} doit figurer parmi les variables refusées`
    );
  }
  assert.ok(
    execHarness.includes("La valeur n'est pas journalisée"),
    "une valeur peut être un secret : seul le nom doit être journalisé"
  );
});

test("[HARNESS-3] aucun nom de base FIXE, et refus plutôt que destruction", () => {
  assert.ok(
    execHarness.includes('RUN_TAG="$$_$('),
    "les noms de base doivent porter une étiquette propre à l'exécution"
  );
  assert.ok(
    execHarness.includes("refuse plutôt que de la détruire"),
    "une base homonyme préexistante doit être refusée, jamais supprimée"
  );
  // Aucun `drop database` sur un nom construit sans l'étiquette
  // d'exécution.
  const drops = [...execHarness.matchAll(/drop database[^\n]*/g)].map((m) => m[0]!);
  for (const d of drops) {
    assert.ok(
      d.includes('\\"$d\\"') || d.includes('"$d"'),
      `un drop ne doit porter que sur une base enregistrée par cette exécution : ${d}`
    );
  }
});

test("[HARNESS-4] le harnais crée son propre cluster et prouve son identité", () => {
  assert.ok(execHarness.includes("initdb"));
  assert.ok(execHarness.includes("listen_addresses=''"));
  assert.ok(
    execHarness.includes('[ "$DATA_DIR" = "$PGDATA_DIR" ]'),
    "le serveur joint doit être prouvé être celui que le harnais a créé"
  );
  assert.ok(
    execHarness.includes("(prod|production|live|preprod|staging|recette)"),
    "un cluster portant un nom d'environnement protégé doit être refusé"
  );
});

test("[HARNESS-5] le harnais rejoue la FIXTURE PARTAGÉE, pas des cas réécrits", () => {
  assert.ok(
    execHarness.includes("checkout-scheduling-cases.json"),
    "le harnais doit lire la fixture partagée : c'est elle qui fait la preuve croisée"
  );
});

// ====================================================================
// REMÉDIATION — les six blockers de l'audit indépendant
// ====================================================================

test("[AUD01-SQL] le résolveur compare des INSTANTS, pas seulement des dates", () => {
  assert.ok(
    sql.includes("CSDJ-V1-OFFER-START-INSTANT-01"),
    "l'invariant doit être nommé dans le fichier, pas seulement dans un test"
  );
  const block = sqlFunctionBlock("create function public.resolve_fulfillment_schedule(");
  assert.ok(
    block.includes("v_min_instant"),
    "un instant minimal de réalisation doit être calculé"
  );
  // Chaque offre est comparée à cet instant -- deux comparaisons, une
  // par politique d'horaire.
  assert.ok(
    (block.match(/v_inst >= v_min_instant|v_inst < v_min_instant/g) ?? []).length >= 2,
    "chaque offre doit être comparée à l'instant minimal"
  );
  // Et une date sans offre survivante est retirée.
  assert.ok(
    block.includes("pg_catalog.jsonb_array_length(v_day) = 0"),
    "une date dont toutes les offres sont écartées doit être retirée"
  );
  assert.ok(
    CHECKOUT_UNFULFILLABLE_REASONS.includes("no_offer_in_horizon"),
    "le motif distinguant « des dates ouvertes mais aucune offre » doit exister"
  );
});

test("[AUD02-SQL] la politique d'heure murale est une AUTORITÉ, pas un commentaire", () => {
  assert.ok(execSql.includes("create function public.checkout_wall_time_status("));
  assert.ok(execSql.includes("create function public.checkout_wall_time_instant("));
  const status = sqlFunctionBlock("create function public.checkout_wall_time_status(");
  assert.ok(status.includes("'nonexistent'"), "l'heure inexistante doit être nommée");
  assert.ok(status.includes("'ambiguous'"), "l'heure ambiguë doit être nommée");
  // Le résolveur ne doit JAMAIS convertir une heure murale autrement
  // que par cette autorité : un `at time zone` direct rouvrirait la
  // normalisation silencieuse que la politique ferme.
  const resolver = sqlFunctionBlock("create function public.resolve_fulfillment_schedule(");
  const directConversions = (
    resolver.match(/\+ v_s\.cutoff_time\)\s*\n?\s*at time zone/g) ?? []
  ).length;
  assert.equal(
    directConversions,
    0,
    "aucune conversion d'heure murale ne doit contourner checkout_wall_time_instant"
  );
  assert.ok(
    resolver.includes("public.checkout_wall_time_instant("),
    "le résolveur doit passer par l'autorité de politique"
  );
  // Et le post-vol le vérifie à l'exécution, pas seulement au texte.
  assert.ok(
    execSql.includes("une heure murale INEXISTANTE est acceptée"),
    "le post-vol doit refuser une politique inopérante"
  );
  assert.ok(execSql.includes("une heure murale AMBIGUË est acceptée"));
  assert.ok(
    execSql.includes("la politique sur-refuse"),
    "le post-vol doit aussi refuser une politique qui refuserait TOUT"
  );
  assert.ok(
    sql.includes("CSDJ-V1-WALL-TIME-FAIL-CLOSED-01"),
    "la politique doit être nommée dans le fichier"
  );
});

test("[AUD02-SQL-2] la classification d'heure murale ne suppose AUCUNE transition d'une heure", () => {
  // Reproche du re-audit delta : une classification qui cherche
  // l'ambiguïté « à plus ou moins une heure » rate Australia/Lord_Howe,
  // dont la transition fait TRENTE minutes. La classification doit donc
  // ÉNUMÉRER les décalages réellement en vigueur autour de l'instant,
  // et ne tenir aucune durée pour acquise.
  const status = sqlFunctionBlock("create function public.checkout_wall_time_status(");
  assert.ok(
    status.includes("'valid_unique'"),
    "le cas unique doit être nommé, et non implicite"
  );

  // Les cinq sondes de décalage, par leur VALEUR : une sonde perdue
  // rétrécirait silencieusement la fenêtre d'observation.
  for (const probe of [
    "make_interval(days => -1)",
    "make_interval(hours => -4)",
    "make_interval()",
    "make_interval(hours => 4)",
    "make_interval(days => 1)",
  ]) {
    assert.ok(
      status.includes(probe),
      `la sonde ${probe} doit faire partie de l'énumération des décalages`
    );
  }

  // AUCUNE constante d'une heure dans la DÉCISION : ni '1 hour', ni
  // 3600, ni interval '01:00'. C'est l'hypothèse que l'audit interdit.
  for (const forbidden of ["1 hour", "3600", "01:00:00'::interval", "hours => 1)"]) {
    assert.ok(
      !status.includes(forbidden),
      `« ${forbidden} » dans la classification réintroduirait l'hypothèse des 60 minutes`
    );
  }

  // La décision est un COMPTAGE de candidats survivants, pas une
  // comparaison à un décalage attendu.
  assert.ok(
    /count\(\*\)/.test(status),
    "la classification doit compter les instants candidats survivants"
  );
  assert.ok(
    status.includes("when 0 then 'nonexistent'") &&
      status.includes("when 1 then 'valid_unique'"),
    "zéro candidat = inexistante, un = unique, au-delà = ambiguë"
  );

  // Le miroir TypeScript partage la même structure, et la même absence
  // d'hypothèse.
  assert.ok(
    eligibilitySrc.includes("OFFSET_PROBES_MS"),
    "le miroir TypeScript doit énumérer les mêmes sondes"
  );
  for (const probe of ["-86_400_000", "-14_400_000", "14_400_000", "86_400_000"]) {
    assert.ok(
      eligibilitySrc.includes(probe),
      `la sonde ${probe} doit exister côté TypeScript`
    );
  }
  const resolveWall = eligibilitySrc.slice(
    eligibilitySrc.indexOf("export function resolveWallTime"),
    eligibilitySrc.indexOf("export function", eligibilitySrc.indexOf("export function resolveWallTime") + 10)
  );
  assert.ok(resolveWall.length > 0, "resolveWallTime doit être exportée");
  assert.ok(
    !resolveWall.includes("3_600_000") && !resolveWall.includes("3600000"),
    "aucune constante d'une heure ne doit intervenir dans la classification TypeScript"
  );

  assert.ok(
    sql.includes("CSDJ-V1-TRANSITION-SAFE-CLASSIFY-01"),
    "l'invariant doit être nommé dans le SQL"
  );
  assert.ok(
    eligibilitySrc.includes("CSDJ-V1-TRANSITION-SAFE-CLASSIFY-01"),
    "l'invariant doit être nommé dans le miroir TypeScript"
  );

  // Et le post-vol l'éprouve sur la zone qui fait tomber l'hypothèse.
  assert.ok(
    execSql.includes("Australia/Lord_Howe"),
    "le post-vol doit sonder une zone à transition de trente minutes"
  );
  assert.ok(
    sql.includes("TRENTE minutes"),
    "le post-vol doit dire ce qu'il prouve : une transition de trente minutes"
  );
});

test("[AUD02-SQL-3] une occurrence est exposée en ENTIER ou pas du tout", () => {
  // Reproche du re-audit delta : une fenêtre dont le DÉBUT existe mais
  // dont la FIN ou un point de la grille n'existe pas restait offerte.
  // La règle est désormais tout-ou-rien.
  const resolver = sqlFunctionBlock("create function public.resolve_fulfillment_schedule(");
  assert.ok(
    sql.includes("CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01"),
    "l'invariant doit être nommé dans le SQL"
  );
  assert.ok(
    eligibilitySrc.includes("CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01"),
    "l'invariant doit être nommé dans le miroir TypeScript"
  );
  // La FIN de fenêtre passe par l'autorité de classification.
  assert.ok(
    /checkout_wall_time_status\(\s*v_d,\s*v_off\.ends_at,\s*v_s\.timezone\)\s*\n?\s*<> 'valid_unique'/.test(
      resolver
    ),
    "la FIN de fenêtre doit être classée et l'occurrence écartée si elle ne l'est pas"
  );
  // Et la grille entière est parcourue, avec un verdict unique.
  assert.ok(
    resolver.includes("v_grid_sound"),
    "la grille doit porter un verdict d'ensemble (tout-ou-rien)"
  );
  assert.ok(
    eligibilitySrc.includes("gridIsSound"),
    "le miroir TypeScript doit porter le même verdict d'ensemble"
  );
  // La fixture partagée doit contenir les quatre fenêtres exigées.
  const fixture = readFileSync(
    "tests/fixtures/checkout-scheduling-cases.json",
    "utf8"
  );
  for (const id of [
    "aud02-window-start-valid-end-nonexistent",
    "aud02-window-entirely-nonexistent",
    "aud02-window-spans-nonexistent-region",
    "aud02-window-after-transition-valid",
    "aud02-lord-howe-autumn-30min-ambiguous",
    "aud02-lord-howe-spring-30min-nonexistent",
  ]) {
    assert.ok(fixture.includes(id), `le cas ${id} doit figurer dans la fixture partagée`);
  }
});

test("[AUD07-SQL] le harnais de rôles s'isole et PROUVE sa destination", () => {
  // Reproche du re-audit delta : PGHOSTADDR l'emporte sur un « -h »
  // explicite ; un client qui hérite de l'environnement peut donc muter
  // un AUTRE serveur que celui que le verrou de sûreté a constaté.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  assert.ok(existsSync(rolePath), "le harnais de restauration de rôles doit exister");
  const roleSrc = readFileSync(rolePath, "utf8");
  const execRole = executableShell(roleSrc);

  assert.ok(
    roleSrc.includes("CSDJ-V1-HARNESS-CLEAN-ENV-01"),
    "l'invariant d'isolation doit être nommé"
  );
  assert.ok(
    roleSrc.includes("CSDJ-V1-DESTINATION-PROOF-02"),
    "l'invariant de preuve de destination COMPLÈTE doit être nommé"
  );

  // Les variables de routage sont refusées PAR LEUR NOM -- jamais par
  // leur valeur, qui peut être un secret.
  for (const name of [
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGSYSCONFDIR",
    "PGCLUSTER",
    "DATABASE_URL",
    "SUPABASE_DB_URL",
  ]) {
    assert.ok(
      new RegExp(`ROUTING_VARS="[^"]*\\b${name}\\b`).test(execRole),
      `${name} doit figurer dans la liste des variables refusées`
    );
  }
  assert.ok(
    roleSrc.includes("La valeur n'est pas journalisée"),
    "le refus doit dire explicitement qu'il ne journalise pas la valeur"
  );

  // Chaque appel client passe par env -i, avec PATH, HOME et -h/-p/-U/-d
  // explicites, et par un binaire à chemin ABSOLU.
  assert.ok(
    /env -i PATH="\$SAFE_PATH" HOME="\$SAFE_HOME"/.test(execRole),
    "les appels clients doivent s'exécuter dans un environnement vidé"
  );
  assert.ok(
    execRole.includes("resolve_bin"),
    "les binaires doivent être résolus en chemin absolu, pas par le PATH"
  );
  assert.ok(
    /-h "\$SOCKET_DIR" -p "\$PORT" -U "\$OWNER" -d postgres/.test(execRole),
    "la destination doit être entièrement explicite à chaque appel"
  );

  // L'identité COMPLÈTE précède toute mutation, et un échec ABANDONNE.
  assert.ok(
    execRole.includes("csdj1_identity_mutate") &&
      execRole.includes("mutation ABANDONNÉE"),
    "aucune mutation ne doit avoir lieu sans preuve d'identité complète immédiate"
  );

  // Le harnais PRINCIPAL ferme le même trou côté nettoyage.
  assert.ok(
    execHarness.includes("RESTAURATION DE RÔLES ABANDONNÉE"),
    "le harnais principal doit abandonner la restauration si sa destination a changé"
  );
  assert.ok(
    /ROUTING_VARS|REDIRECTING_VARS/.test(execHarness) &&
      /\bPGHOSTADDR\b/.test(execHarness),
    "le harnais principal doit nommer PGHOSTADDR parmi les variables refusées"
  );

  // La menace est DÉMONTRÉE nocive, pas seulement déclarée : un témoin
  // joignable, et une reproduction en lecture seule.
  assert.ok(
    execRole.includes("WIT_DATA") && execRole.includes("127.0.0.1"),
    "un cluster témoin joignable doit exister, sans quoi l'absence de redirection ne prouve rien"
  );
  assert.ok(
    execRole.includes("PSQL_UNISOLATED_ON_PURPOSE"),
    "le contrôle de nocivité doit exister"
  );
  assert.ok(
    execRole.includes("witness_untouched"),
    "chaque vecteur hostile doit vérifier que le témoin n'a subi AUCUNE mutation"
  );
});

test("[AUD07-SQL-2] UN SEUL prédicat d'identité, COMPLET, pour tout chemin qui mute", () => {
  // Reproche du SECOND re-audit delta : la preuve du nettoyage ne
  // portait que sur quatre faits (socket, port, utilisateur,
  // superutilisateur) et omettait data_directory, config_file et le
  // marqueur. Deux clusters distincts peuvent satisfaire une telle
  // identité partielle -- même port, même utilisateur, même motif de
  // socket -- et la preuve ne liait donc pas le serveur à CETTE
  // exécution.
  //
  // La cause profonde n'était pas la faiblesse d'un contrôle mais
  // l'EXISTENCE DE DEUX contrôles : un à la mise en place, un autre au
  // nettoyage, subtilement différents. Il n'y en a plus qu'un.
  const LIB_PATH = "supabase/tests/csdj1-cluster-identity.sh";
  assert.ok(existsSync(LIB_PATH), "le prédicat d'identité doit vivre dans une bibliothèque partagée");
  const lib = readFileSync(LIB_PATH, "utf8");

  // Les HUIT faits, chacun avec sa raison de refus NOMMÉE : un refus
  // sans raison nommée ne se distingue pas d'une panne.
  for (const fact of [
    "destination_reseau",
    "port",
    "current_user",
    "is_superuser",
    "socket",
    "data_directory",
    "config_file",
    "marqueur_absent",
    "nonce",
  ]) {
    assert.ok(
      lib.includes(`SCANYM_IDENTITY_REFUS|${fact}`),
      `le prédicat doit vérifier « ${fact} » et le refuser sous ce nom`
    );
  }

  // Le statut superutilisateur est vérifié AVANT les réglages qui
  // l'exigent : sinon un défaut de privilège se présenterait comme une
  // erreur de permission, et non comme un refus nommé.
  assert.ok(
    lib.indexOf("REFUS|is_superuser") < lib.indexOf("REFUS|data_directory"),
    "is_superuser doit être vérifié avant data_directory"
  );

  // Preuve et mutation dans UNE session, UNE transaction : prouver puis
  // muter en deux connexions laisse un intervalle exploitable.
  assert.ok(
    /do \\\$csdj1id\\\$/.test(lib) || lib.includes("do \$csdj1id\$"),
    "la garde et la mutation doivent tenir dans un seul bloc DO"
  );
  assert.ok(
    lib.includes("csdj1_identity_run_guarded"),
    "un seul point d'exécution gardée"
  );

  // Le marqueur est en BASE, pas sur le disque : un fichier témoin
  // prouverait que le système de fichiers est le bon, pas que le
  // SERVEUR joint est le bon.
  assert.ok(
    lib.includes("to_regclass('public.") && lib.includes("where nonce ="),
    "le marqueur doit être une table de ce cluster, lue en SQL"
  );
  assert.ok(
    !/\[ -f .*marqueur|test -f .*marker/i.test(lib),
    "aucun marqueur de système de fichiers ne doit servir de preuve d'identité"
  );

  // LES DEUX harnais emploient ce prédicat, et aucun n'en garde un autre.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  for (const [label, src] of [
    ["harnais principal", harness],
    ["harnais de rôles", readFileSync(rolePath, "utf8")],
  ] as const) {
    assert.ok(
      src.includes("csdj1-cluster-identity.sh") &&
        src.includes("csdj1_identity_mutate"),
      `${label} doit muter par le prédicat partagé`
    );
  }

  // La mutation de rôles de la MISE EN PLACE passe par la garde elle
  // aussi : c'est l'exigence explicite du mandat. Elle ne peut donc
  // plus vivre dans l'amorçage d'une base -- un marqueur logé dans
  // « postgres » n'y serait pas visible.
  assert.ok(
    !/create role (anon|authenticated|service_role) nologin; end if;[\s\S]*?\nalter role service_role bypassrls;/.test(
      execHarness
    ),
    "les rôles globaux ne doivent plus être mutés depuis l'amorçage d'une base"
  );
  const setupMutation = execHarness.slice(
    execHarness.indexOf("csdj1_identity_mutate \""),
  );
  assert.ok(
    setupMutation.includes("create role anon nologin") &&
      setupMutation.includes("alter role service_role bypassrls"),
    "la mise en place des rôles globaux doit passer par le prédicat"
  );

  // Et les contrôles négatifs existent, un par fait, avec l'exigence de
  // ZÉRO mutation : un prédicat qu'on ne peut pas faire échouer n'est
  // pas un prédicat.
  const role = readFileSync(rolePath, "utf8");
  assert.ok(role.includes("negative_control"), "les contrôles négatifs doivent exister");
  for (const label of [
    "data_directory faux",
    "config_file faux",
    "marqueur RETIRÉ",
    "marqueur CHANGÉ",
    "port faux",
    "utilisateur faux",
    "non superutilisateur",
    "destination RÉSEAU",
    "socket attendue fausse",
  ]) {
    assert.ok(role.includes(label), `le contrôle négatif « ${label} » doit exister`);
  }
  assert.ok(
    role.includes("ZÉRO mutation"),
    "chaque contrôle négatif doit vérifier qu'AUCUNE mutation n'a eu lieu"
  );
  assert.ok(
    role.includes("CONTRÔLE POSITIF") && role.includes("refus universel"),
    "un harnais qui refuserait TOUT n'est pas un succès : le chemin nominal doit muter"
  );
});

test("[AUD07-SQL-3] le répertoire de socket se compare à l'ÉGALITÉ EXACTE", () => {
  // Défaut du quatrième re-audit : la validation employait `strpos`,
  // une sémantique de SOUS-CHAÎNE. Un serveur dont la socket est
  // « /tmp » satisfaisait un attendu « /tm ». Une identité qui accepte
  // un fragment n'identifie rien -- et sur un poste où plusieurs
  // clusters jetables vivent côte à côte sous /tmp, le fragment est la
  // règle, pas l'exception.
  const LIB_PATH = "supabase/tests/csdj1-cluster-identity.sh";
  const lib = readFileSync(LIB_PATH, "utf8");
  // On juge le code EXÉCUTABLE : un commentaire a le droit de nommer
  // `strpos` pour dire précisément qu'on ne l'emploie plus.
  const libExec = lib
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s*--.*$/, ""))
    .join("\n");

  // `strpos` est légitime dans la défense anti-collision, qui y cherche
  // un octet interdit ([AUD07-SQL-7]) ; il reste interdit dans la
  // COMPARAISON d'appartenance, qui est le défaut d'origine.
  const matchExprBody = libExec.slice(
    libExec.indexOf("csdj1_identity_socket_match_expr() {"),
    libExec.indexOf("csdj1_identity_socket_balanced_expr() {")
  );
  assert.ok(
    !matchExprBody.includes("strpos"),
    "la comparaison d'appartenance ne doit plus employer strpos"
  );
  assert.ok(
    !/like\s*'%/.test(libExec) && !/position\s*\(/.test(libExec),
    "ni LIKE ni position() ne doivent réintroduire une acceptation partielle"
  );
  // La liste est découpée en ENTRÉES, et chaque entrée est comparée à
  // l'ÉGALITÉ.
  assert.ok(
    libExec.includes("string_to_array(") && libExec.includes("pg_catalog.unnest("),
    "la liste unix_socket_directories doit être découpée en entrées"
  );
  // L'égalité est portée par l'expression que le parseur émet ; sa
  // forme interne est éprouvée par [AUD07-SQL-5].
  assert.ok(
    libExec.includes("csdj1_sock_norm where entry = ") &&
      libExec.includes('"$CSDJ1_ID_SOCKET"'),
    "l'entrée normalisée doit être comparée à l'attendu par égalité"
  );
  // Les deux côtés sont normalisés DE LA MÊME FAÇON, sans quoi
  // « /tmp/ » et « /tmp » seraient deux répertoires différents.
  assert.ok(
    lib.includes("csdj1_identity_normalize_socket"),
    "l'attendu doit être normalisé côté shell"
  );
  for (const piece of ["btrim", "rtrim"]) {
    assert.ok(
      libExec.includes(piece),
      `la normalisation SQL doit employer ${piece} (espaces, guillemets, barre oblique finale)`
    );
  }
  // Un attendu vide accepterait une entrée vide : le contrat refuse de
  // se déclarer.
  assert.ok(
    /case "\$sock" in\s*\n\s*\/\*\)/.test(lib),
    "un répertoire attendu non absolu doit faire REFUSER la déclaration du contrat"
  );

  // Les contrôles négatifs de socket existent, y compris la
  // reproduction littérale du rapport d'audit.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  const role = readFileSync(rolePath, "utf8");
  assert.ok(role.includes("socket_control"), "les contrôles de socket doivent exister");
  for (const label of [
    "entrée EXACTE (membre simple)",
    "entrée EXACTE (autre membre)",
    "PRÉFIXE d'une entrée",
    "SUFFIXE d'une entrée",
    "SOUS-répertoire d'une entrée",
    "répertoire PARENT",
    "la LISTE ENTIÈRE rendue par SHOW",
    "reproduction d'audit : /tmp vs /tm",
    "reproduction d'audit : /tmp vs /tmpx",
  ]) {
    assert.ok(role.includes(label), `le contrôle de socket « ${label} » doit exister`);
  }
  // Un cluster à PLUSIEURS répertoires de socket est nécessaire : sans
  // lui, rien ne distingue « une entrée complète » de « la liste ».
  assert.ok(
    /unix_socket_directories='[^']*\$LAB_SOCK_A[^']*\$LAB_SOCK_B/.test(role),
    "un cluster à PLUSIEURS répertoires de socket doit être créé pour éprouver la liste"
  );
  // Et la nocivité de l'ancien prédicat est démontrée, pas déclarée.
  assert.ok(
    role.includes("accepté par au moins un ancien prédicat"),
    "le harnais doit démontrer que les anciens prédicats acceptaient ces fragments"
  );
});

test("[AUD07-SQL-4] AUCUNE mutation de rôle hors de la garde, témoin compris", () => {
  // Défaut du quatrième re-audit : l'initialisation des rôles du
  // cluster TÉMOIN passait par un appel brut. Un cluster dont on mute
  // les rôles est un cluster qu'il faut identifier, même quand il ne
  // sert que de témoin -- un appel brut qui « ne compte pas » est un
  // appel brut qui comptera le jour où la destination n'est plus celle
  // qu'on croit.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  const role = readFileSync(rolePath, "utf8");

  // Le témoin a son CONTRAT COMPLET, pas une dispense.
  assert.ok(
    /csdj1_identity_declare temoin /.test(role),
    "le cluster témoin doit avoir son propre contrat d'identité"
  );
  for (const field of ["WIT_SOCK", "WIT_PORT", "WIT_DATA_DIR_PROVEN",
                        "WIT_CONFIG_FILE_PROVEN", "WIT_MARKER", "WIT_NONCE"]) {
    assert.ok(role.includes(field), `le contrat du témoin doit porter ${field}`);
  }
  // Son marqueur est DISTINCT de celui du cluster sous test, sinon la
  // preuve « le marqueur n'existe que là » ne voudrait rien dire.
  assert.ok(
    /WIT_MARKER="scanym_csdj1_identity_temoin_/.test(role),
    "le marqueur du témoin doit porter un nom distinct"
  );

  // L'initialisation des rôles du témoin passe par la garde.
  const witnessInit = role.slice(
    role.indexOf("Le TÉMOIN reçoit des attributs distinctifs"),
    role.indexOf("declare -A WITNESS_BEFORE")
  );
  assert.ok(witnessInit.length > 0, "le bloc d'initialisation du témoin doit être identifiable");
  assert.ok(
    witnessInit.includes("csdj1_identity_mutate"),
    "l'initialisation des rôles du témoin doit passer par la mutation gardée"
  );
  assert.ok(
    !/\bqw "do /.test(witnessInit),
    "aucun appel brut `qw` ne doit porter une mutation de rôle"
  );

  // Et le harnais porte son propre détecteur, qui raisonne par commande
  // englobante : une mutation vit presque toujours dans un argument sur
  // plusieurs lignes, et un contrôle ligne à ligne ne prouverait rien.
  assert.ok(
    role.includes("mutation de rôle") || role.includes("NON-GARDEE"),
    "le harnais doit détecter lui-même une mutation de rôle non gardée"
  );
  assert.ok(
    role.includes("TOUTE mutation de rôle est portée par une commande gardée"),
    "le détecteur doit conclure explicitement"
  );

  // Les contrats sont NOMMÉS : plusieurs clusters, plusieurs contrats
  // complets, et aucun contrat global sauvegardé puis restauré à la
  // main -- c'est exactement ce dédoublement qui a produit le défaut
  // d'origine.
  const lib = readFileSync("supabase/tests/csdj1-cluster-identity.sh", "utf8");
  assert.ok(
    lib.includes("csdj1_identity_use") && lib.includes("CSDJ1_ID_CTX_RUNNER"),
    "la bibliothèque doit gérer des contrats NOMMÉS"
  );
  for (const ctx of ["temoin", "test", "banc", "test_sans_privilege"]) {
    assert.ok(
      new RegExp(`csdj1_identity_declare ${ctx} `).test(role),
      `le contrat « ${ctx} » doit être déclaré`
    );
  }
});

test("[AUD07-SQL-5] la liste de sockets est analysée SELON LA SYNTAXE PostgreSQL", () => {
  // Défaut du cinquième re-audit : la comparaison était bien une
  // ÉGALITÉ, mais le DÉCOUPAGE restait faux. `string_to_array(liste,
  // ',')` coupe à CHAQUE virgule, y compris celles qui sont DANS une
  // entrée citée. Vérifié empiriquement sur un serveur de ce poste :
  //
  //   configuration  "<rép>/foo,bar",<rép>/plain
  //   SHOW rend      "<rép>/foo,bar",<rép>/plain
  //
  // Un découpage brut ACCEPTE « <rép>/foo » -- qui n'est pas un
  // répertoire configuré -- et REFUSE « <rép>/foo,bar » -- qui en est
  // un. Les deux erreurs sont graves ; la première est une fausse
  // identité.
  const LIB_PATH = "supabase/tests/csdj1-cluster-identity.sh";
  const lib = readFileSync(LIB_PATH, "utf8");
  const libExec = lib
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s*--.*$/, ""))
    .join("\n");

  // Plus de découpage BRUT du réglage.
  assert.ok(
    !/string_to_array\(\s*\n?\s*coalesce\(pg_catalog\.current_setting\('unix_socket_directories'/.test(
      libExec
    ),
    "la liste ne doit plus être découpée à chaque virgule"
  );
  // Le découpage est conditionné par la PARITÉ des guillemets : après
  // substitution des guillemets doublés, les guillemets restants sont
  // les délimiteurs, et ils alternent.
  assert.ok(
    libExec.includes("outside_quotes"),
    "le découpage doit distinguer les virgules HORS citation"
  );
  assert.ok(
    /% 2 = 0\s*\n?\s*as outside_quotes/.test(libExec),
    "la position hors citation doit se décider par parité des guillemets"
  );
  // Les guillemets DOUBLÉS valent un guillemet littéral : PostgreSQL
  // les accepte en configuration et SHOW les ré-encode doublés.
  assert.ok(
    libExec.includes(`replace(r.raw, '""', pg_catalog.chr(1))`),
    "un guillemet doublé doit être traité comme un guillemet littéral"
  );
  assert.ok(
    libExec.includes(`replace(u.e, pg_catalog.chr(1), '"')`),
    "la sentinelle doit être restituée en guillemet dans la valeur finale"
  );
  // Les guillemets encadrants sont retirés SEULEMENT s'il y en a aux
  // deux bouts : les retirer d'un seul bord est ce qui transforme un
  // fragment en chemin plausible.
  assert.ok(
    /left\(t\.e, 1\) = '"'[\s\S]{0,120}right\(t\.e, 1\) = '"'/.test(libExec),
    "les guillemets ne doivent être retirés que s'ils encadrent l'entrée"
  );
  assert.ok(
    !/btrim\(t\.e, '"'\)/.test(libExec),
    "btrim des guillemets accepterait une entrée à guillemet unique, donc un fragment"
  );
  // Normalisation : espaces extérieurs, barre oblique finale, « / ».
  assert.ok(libExec.includes("btrim(s.e)"), "les espaces extérieurs doivent être retirés");
  assert.ok(
    /case when r\.e = '\/' then '\/' else pg_catalog\.rtrim\(r\.e, '\/'\) end/.test(libExec),
    "la barre oblique finale doit être normalisée, « / » restant « / »"
  );
  // Fail-closed sur une syntaxe mal formée, même si SHOW ne peut pas la
  // produire (PostgreSQL refuse de démarrer sur une citation non fermée).
  assert.ok(
    lib.includes("socket_liste_malformee"),
    "une liste mal formée doit être refusée, pas devinée"
  );

  // UN SEUL parseur, partagé par tous les chemins de garde.
  assert.equal(
    (lib.match(/^csdj1_identity_socket_cte\(\)/gm) ?? []).length,
    1,
    "le parseur doit être défini une seule fois"
  );
  assert.ok(
    lib.includes("csdj1_identity_socket_match_expr"),
    "la garde doit consommer le parseur par une expression émise"
  );
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  const role = readFileSync(rolePath, "utf8");
  assert.ok(
    role.includes("csdj1_identity_socket_match_expr"),
    "la démonstration de nocivité doit employer l'expression de la GARDE, pas une copie"
  );

  // Le banc d'essai configure réellement des entrées CITÉES : sur une
  // liste sans guillemets, un découpage brut et un parseur correct sont
  // indiscernables.
  assert.ok(
    /LAB_SOCK_C="\$TMP_DIR\/foo,bar"/.test(role),
    "un répertoire de socket contenant une VIRGULE doit être configuré"
  );
  assert.ok(
    /LAB_SOCK_D="\$TMP_DIR\/lab d"/.test(role),
    "un répertoire de socket contenant un ESPACE doit être configuré"
  );
  for (const label of [
    "membre CITÉ à virgule, exact",
    "FRAGMENT avant la virgule citée",
    "FRAGMENT après la virgule citée",
    "membre CITÉ à ESPACE, exact",
    "membre CITÉ, barre oblique finale dans la configuration",
    "la LISTE ENTIÈRE rendue par SHOW",
  ]) {
    assert.ok(role.includes(label), `le contrôle « ${label} » doit exister`);
  }
});

test("[AUD07-SQL-6] une mutation brute tenant sur UNE ligne est classée par sa COMMANDE", () => {
  // Historique : la mutation multi-lignes fut d'abord attrapée, puis la
  // mutation packée sur une seule ligne, puis les formes de littéral et
  // la casse. Le détecteur ne classe plus des LIGNES mais des
  // COMMANDES ([AUD07-SQL-8]) -- ce qui règle la famille entière.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  const role = readFileSync(rolePath, "utf8");
  const DET_PATH = "supabase/tests/csdj1-raw-role-mutation-detector.awk";
  const det = readFileSync(DET_PATH, "utf8");

  // Le classement porte sur la commande reconstituée, pas sur la ligne.
  assert.ok(
    det.includes('report(kind, buf, "commande complete")'),
    "le verdict doit porter sur la COMMANDE reconstituée"
  );
  assert.ok(
    det.includes("function finish(") && det.includes("buf = \"\""),
    "chaque commande doit être classée puis remise à zéro"
  );
  // Les formes d'une seule ligne, dans les deux littéraux.
  assert.ok(
    role.includes("detector_fixture d1 NON-GARDEE") &&
      role.includes("detector_fixture d2 NON-GARDEE"),
    "les deux formes de littéral sur une seule ligne doivent être détectées"
  );
  // Et une mutation gardée n'est pas dénoncée.
  assert.ok(
    role.includes("detector_fixture d6 GARDEE"),
    "une mutation gardée ne doit pas être dénoncée à tort"
  );
  assert.ok(
    role.includes("detector_fixture d7 AUCUNE"),
    "du SQL sans mutation de rôle ne doit produire aucun verdict"
  );
  // Le détecteur est un seul programme, réutilisé pour les fixtures.
  assert.ok(
    role.includes('awk -f "$MUT_AWK"'),
    "le détecteur doit être un seul programme, réutilisé pour les fixtures"
  );
});

test("[AUD07-SQL-7] les octets que le parseur se RÉSERVE sont refusés dans l'entrée brute", () => {
  // Défaut du sixième re-audit : le parseur emploie chr(1) et chr(2)
  // comme sentinelles internes. Ces octets ne sont réservés par AUCUNE
  // syntaxe PostgreSQL -- un nom de répertoire peut les contenir, Linux
  // n'interdit que « / » et l'octet nul -- et un serveur démarre
  // parfaitement sur un tel répertoire (vérifié empiriquement).
  //
  // La collision se produit dans les DEUX sens : un chr(2) dans un nom
  // est pris pour un séparateur, et le fragment qui le précède devient
  // une FAUSSE IDENTITÉ acceptée ; un chr(1) est restitué en guillemet,
  // ce qui FABRIQUE un chemin inexistant et refuse l'entrée réelle.
  const LIB_PATH = "supabase/tests/csdj1-cluster-identity.sh";
  const lib = readFileSync(LIB_PATH, "utf8");

  assert.ok(
    lib.includes("csdj1_identity_socket_reserved_expr"),
    "une défense contre les octets réservés doit exister"
  );
  assert.ok(
    lib.includes("SCANYM_IDENTITY_REFUS|socket_octets_reserves"),
    "le refus doit être NOMMÉ : un refus sans nom ne se distingue pas d'une panne"
  );
  // La défense s'applique à l'entrée BRUTE, donc AVANT toute
  // substitution de sentinelle.
  const guard = lib.slice(
    lib.indexOf("csdj1_identity_guard_sql() {"),
    lib.indexOf("csdj1_identity_marker_sql() {")
  );
  assert.ok(
    guard.indexOf("socket_octets_reserves") < guard.indexOf("socket_liste_malformee"),
    "le refus des octets réservés doit précéder l'analyse de la liste"
  );
  assert.ok(
    guard.indexOf("socket_octets_reserves") < guard.indexOf("REFUS|socket'"),
    "le refus des octets réservés doit précéder le test d'appartenance"
  );
  // Les DEUX octets, et sur le réglage lu du serveur.
  const reserved = lib.slice(
    lib.indexOf("csdj1_identity_socket_reserved_expr() {"),
    lib.indexOf("# Expression SQL booléenne : « l'attendu est-il une entrée COMPLÈTE ? »")
  );
  assert.ok(reserved.includes("chr(1)"), "chr(1) doit être refusé");
  assert.ok(reserved.includes("chr(2)"), "chr(2) doit être refusé");
  assert.ok(
    reserved.includes("unix_socket_directories"),
    "la défense doit porter sur le réglage lu du serveur, et non sur une copie transformée"
  );
  // Et l'ATTENDU est refusé lui aussi : accepter d'un côté ce qu'on
  // refuse de l'autre serait une asymétrie, donc une faille.
  assert.ok(
    /\*\$'\\001'\*\|\*\$'\\002'\*\)/.test(lib),
    "un attendu portant chr(1) ou chr(2) doit faire refuser la déclaration du contrat"
  );
  // L'emploi de strpos est CANTONNÉ à cette défense : il y cherche un
  // octet interdit, ce qui n'est pas comparer un chemin par sous-chaîne.
  const libExec = lib
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s*--.*$/, ""))
    .join("\n");
  const matchExpr = libExec.slice(
    libExec.indexOf("csdj1_identity_socket_match_expr() {"),
    libExec.indexOf("csdj1_identity_socket_balanced_expr() {")
  );
  assert.ok(
    !matchExpr.includes("strpos"),
    "la comparaison d'appartenance ne doit pas employer strpos"
  );

  // Les contrôles existent, sur de VRAIS clusters portant ces octets.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  const role = readFileSync(rolePath, "utf8");
  assert.ok(role.includes("sentinel_control"), "les contrôles de sentinelle doivent exister");
  assert.ok(
    /SENT_B1="\$TMP_DIR\/foo\$\(printf '\\001'\)bar"/.test(role) &&
      /SENT_B2="\$TMP_DIR\/foo\$\(printf '\\002'\)bar"/.test(role),
    "deux répertoires portant réellement chr(1) et chr(2) doivent être créés"
  );
  assert.ok(
    role.includes("empreinte de rôle INCHANGÉE"),
    "chaque contrôle doit vérifier l'empreinte de rôle, et non seulement le refus"
  );
  assert.ok(
    role.includes("la collision est RÉELLE"),
    "chaque contrôle doit démontrer que le parseur SEUL accepterait la fausse identité"
  );
  // Le cluster est d'abord configuré ORDINAIREMENT pour que le marqueur
  // soit posé légitimement : sans cela le refus pourrait venir du
  // marqueur absent, et le contrôle prouverait autre chose.
  assert.ok(
    role.includes("Tout le reste de l'identité est ainsi LÉGITIME"),
    "le marqueur doit être posé avant la reconfiguration, pour isoler le fait éprouvé"
  );
  assert.ok(
    role.includes("CONTRÔLE POSITIF — un chemin ORDINAIRE passe toujours"),
    "la défense ne doit pas rendre le harnais inutilisable là où rien ne cloche"
  );
});

test("[AUD07-SQL-8] le détecteur reconstitue les COMMANDES du shell", () => {
  // Trois audits successifs ont trouvé trois façons de tromper un
  // détecteur qui comptait les guillemets ligne par ligne. Le dernier
  // est le plus parlant : une apostrophe dans un COMMENTAIRE faisait
  // survivre l'état « gardé » à une commande terminée, la continuation
  // par barre oblique inverse n'était pas reconnue, et la mutation
  // brute qui suivait était déclarée GARDÉE -- alors qu'elle
  // s'exécutait.
  //
  // On ne corrige plus le comptage : il est remplacé par un lexeur qui
  // reconstitue les COMMANDES. Chaque commande est classée SEULE, donc
  // la classe entière de défauts « fuite d'état » disparaît par
  // construction.
  const DET_PATH = "supabase/tests/csdj1-raw-role-mutation-detector.awk";
  assert.ok(
    existsSync(DET_PATH),
    "le détecteur doit vivre dans SON PROPRE fichier : logé dans celui qu'il analyse, il se dénonce lui-même"
  );
  const det = readFileSync(DET_PATH, "utf8");

  // Les cinq états du mandat sont modélisés.
  assert.ok(
    /if \(c == "#" && \(buf == "" \|\| substr\(buf, length\(buf\), 1\) ~/.test(det),
    "un « # » en début de mot, hors citation, doit terminer la ligne sans toucher l'état"
  );
  assert.ok(
    /if \(i == n\) \{ cont = 1;/.test(det),
    "une barre oblique inverse en fin de ligne doit être une continuation"
  );
  assert.ok(
    det.includes(`if (q == "'") {`) && det.includes("aucune échappement"),
    "les apostrophes n'admettent aucun échappement : c'est la règle du shell"
  );
  assert.ok(
    /if \(c == "\\\\" && i < n\) \{ buf = buf substr\(line, i, 2\)/.test(det),
    "entre guillemets, la barre oblique inverse échappe le caractère suivant"
  );
  assert.ok(
    det.includes('if (c == ";" || c == "&" || c == "|") { finish(); i++; continue }'),
    "« ; », « & » et « | » hors citation terminent une commande"
  );
  // Les documents en ligne : leur corps est du texte, mais une mutation
  // qu'il contient appartient à la commande qui l'a ouvert.
  assert.ok(
    det.includes('substr(line, i, 2) == "<<"') && det.includes("hdkind"),
    "un document en ligne doit être reconnu, et son corps attribué à la commande qui l'ouvre"
  );
  // Aucun état ne se propage d'une commande à l'autre.
  assert.ok(
    !/(^|[^a-z])pending\b/m.test(det),
    "aucun état « gardé » ne doit subsister entre deux commandes : c'est la classe de défauts à supprimer (hdpending, intra-ligne, ne compte pas)"
  );
  // Fermé par défaut.
  assert.ok(
    det.includes("SANS-OUVREUR") && det.includes("commande non terminee en fin de fichier"),
    "une commande qu'on ne sait pas classer doit être rapportée défavorablement"
  );
  // Casse insensible.
  assert.ok(
    det.includes("tolower(cmd)") &&
      /\(create\|alter\|drop\)\[ \\t\]\+role/.test(det),
    "le mot-clé doit être cherché sur le texte en minuscules"
  );
  // Un appel BRUT l'emporte sur un appel gardé dans la même commande.
  assert.ok(
    det.indexOf('kind = "garde"') < det.indexOf('kind = "brut"'),
    "en cas de doute, le classement défavorable doit l'emporter"
  );

  // Les dix-sept fixtures : D1-D7, R1-R5, C1-C5.
  const rolePath =
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh";
  const role = readFileSync(rolePath, "utf8");
  assert.ok(
    role.includes('MUT_AWK="$SCRIPT_DIR/csdj1-raw-role-mutation-detector.awk"'),
    "le harnais doit employer le détecteur externalisé"
  );
  const EXPECTED: ReadonlyArray<[string, string]> = [
    ["d1", "NON-GARDEE"], ["d2", "NON-GARDEE"], ["d3", "NON-GARDEE"],
    ["d4", "NON-GARDEE"], ["d5", "NON-GARDEE"], ["d6", "GARDEE"], ["d7", "AUCUNE"],
    ["r1", "NON-GARDEE"], ["r2", "NON-GARDEE"], ["r3", "NON-GARDEE"],
    ["r4", "NON-GARDEE"], ["r5", "NON-GARDEE"],
    ["c1", "NON-GARDEE"], ["c2", "NON-GARDEE"], ["c3", "NON-GARDEE"],
    ["c4", "GARDEE"], ["c5", "AUCUNE"],
  ];
  for (const [fx, want] of EXPECTED) {
    assert.ok(
      role.includes(`detector_fixture ${fx} ${want}`),
      `la fixture « ${fx} » doit être attendue en ${want}`
    );
  }
  // Chaque fixture est d'abord validée par bash : une fixture que le
  // shell refuserait ne représenterait aucune réalité lexicale.
  assert.ok(
    role.includes('if ! bash -n "$DET_FIXT/$fx.sh"'),
    "chaque fixture doit être syntaxiquement valide pour bash"
  );
  // Et la séquence de l'audit est démontrée NOCIVE, pas seulement
  // mal étiquetée.
  assert.ok(
    role.includes("[I] la séquence de l'audit mute-t-elle réellement un rôle ?"),
    "la nocivité de la séquence doit être démontrée, et non déduite"
  );
  assert.ok(
    role.includes("NOCIF : la séquence de l'audit a RÉELLEMENT muté le rôle"),
    "le contrôle doit observer la mutation effective d'un rôle"
  );
  // Les verbes des fixtures restent assemblés.
  assert.ok(
    role.includes('V_CREATE="crea""te role"'),
    "les verbes des fixtures doivent être assemblés, non écrits en clair"
  );
});

test("[AUD03-SQL] la lecture publique vérifie l'activation du mode de vente", () => {
  assert.ok(
    sql.includes("CSDJ-V1-MODE-ENABLED-GATE-01"),
    "la garde doit être nommée dans le fichier"
  );
  const block = sqlFunctionBlock(
    "create function public.get_checkout_fulfillment_schedule("
  );
  assert.ok(
    block.includes("public.restaurant_sale_modes m"),
    "l'activation doit être lue sur la table des modes du commerçant"
  );
  assert.ok(
    block.includes("and m.enabled = true"),
    "seule l'activation STRICTE autorise la projection"
  );
  // La garde doit précéder tout calcul de planification : sinon elle
  // n'empêcherait pas la fuite, elle l'accompagnerait.
  const gate = block.indexOf("and m.enabled = true");
  const firstResolve = block.indexOf("public.resolve_fulfillment_schedule(");
  assert.ok(gate > 0 && firstResolve > gate, "la garde doit précéder la résolution");
  assert.ok(
    execSql.includes("la lecture publique ne vérifie plus l''activation du mode de vente"),
    "le post-vol doit constater la présence de la garde"
  );
});

test("[AUD04-SQL] la précision à la minute est contrainte sur CHAQUE colonne time", () => {
  for (const [table, constraint] of [
    ["restaurant_fulfillment_schedule", "rfs_cutoff_minute_precision"],
    ["restaurant_fulfillment_schedule_window", "rfsw_minute_precision"],
    ["restaurant_fulfillment_schedule_slot", "rfss_minute_precision"],
  ] as const) {
    const start = execSql.indexOf(`create table public.${table} (`);
    const body = execSql.slice(start, execSql.indexOf("\n);", start));
    assert.ok(body.includes(constraint), `${table} doit porter ${constraint}`);
    assert.ok(
      body.includes("pg_catalog.date_trunc('minute'"),
      `${table} doit exiger des secondes nulles`
    );
    assert.ok(
      body.includes("'24:00:00'::time"),
      `${table} doit refuser 24:00 explicitement (CSDJ-V1-NO-24H-01)`
    );
  }
  // Et la RPC d'écriture refuse AVANT la contrainte, avec un nom.
  assert.ok(execSql.includes("CSDJ1_SUBMINUTE_TIME"));
  // Le TypeScript dit la même chose : refus, pas troncature.
  assert.ok(
    modelSrc.includes("CSDJ-V1-MINUTE-PRECISION-01"),
    "l'invariant doit être nommé dans le modèle TypeScript"
  );
  assert.ok(
    modelSrc.includes("if (sec !== 0) return null;"),
    "parseScheduleTime doit REFUSER des secondes non nulles, jamais les tronquer"
  );
});

test("[AUD05-SQL] l'anti-dérive lit le CATALOGUE, jamais une sous-chaîne", () => {
  assert.ok(
    sql.includes("CSDJ-V1-RESOLVER-EXACT-SHAPE-01"),
    "la stratégie doit être nommée dans le fichier"
  );
  // Nom ET type, lus dans pg_proc.
  assert.ok(execSql.includes("unnest(p.proargnames, p.proargmodes, p.proallargtypes)"));
  assert.ok(execSql.includes("a.argmode = 't'"), "seules les colonnes de SORTIE comptent");
  assert.ok(
    execSql.includes("pg_catalog.format_type(a.argtype, null) = pg_catalog.split_part("),
    "le TYPE doit être comparé, pas seulement le nom"
  );
  // L'ancienne heuristique textuelle ne doit plus exister.
  assert.ok(
    !execSql.includes("pg_get_function_result(\n         pg_catalog.to_regprocedure('public.resolve_delivery_fulfillment"),
    "aucune vérification par sous-chaîne de la signature du résolveur"
  );
  const preflight = execSql.slice(
    execSql.indexOf("$csdj1_preflight$"),
    execSql.indexOf("§A  CATALOGUES FERMÉS")
  );
  assert.ok(
    preflight.includes("resolve_delivery_fulfillment"),
    "le contrôle doit être dans le PRÉ-vol : le refus doit tomber avant toute création"
  );
  assert.ok(
    preflight.includes("plusieurs surcharges"),
    "deux résolveurs de même nom rendraient le contrôle ambigu"
  );
});

test("[AUD06-SQL] le harnais normalise les booléens et restaure exactement", () => {
  assert.ok(
    execHarness.includes("then '1' else '0' end"),
    "l'instantané de rôle doit encoder explicitement 1/0"
  );
  assert.ok(
    !execHarness.includes("rolcanlogin::text"),
    "`boolean::text` rend « true », jamais « t » : la capture ne doit plus l'employer"
  );
  assert.ok(
    execHarness.includes('[ "$login" = "1" ]') &&
      execHarness.includes('[ "$bypass" = "1" ]'),
    "la restauration doit comparer à la MÊME forme que la capture"
  );
  assert.ok(
    execHarness.includes("'EXISTS|1|1'"),
    "le verrou de sûreté doit énumérer les instantanés admissibles"
  );
  // Et un harnais dédié prouve la restauration des quatre combinaisons.
  assert.ok(
    existsSync(
      "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh"
    ),
    "le harnais de restauration de rôles doit exister"
  );
  const roleHarness = readFileSync(
    "supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh",
    "utf8"
  );
  for (const combo of [
    "NOLOGIN NOBYPASSRLS",
    "LOGIN NOBYPASSRLS",
    "NOLOGIN BYPASSRLS",
    "LOGIN BYPASSRLS",
  ]) {
    assert.ok(roleHarness.includes(combo), `la combinaison ${combo} doit être couverte`);
  }
  assert.ok(
    roleHarness.includes("SCANYM_HARNESS_PGHOST"),
    "la preuve doit porter sur le mode CLUSTER DÉSIGNÉ : c'est le seul où la restauration a des conséquences durables"
  );
});

test("[SENTINEL-1] le zéro UUID est réservé des deux côtés", () => {
  const start = execSql.indexOf("create table public.restaurant_fulfillment_schedule (");
  const body = execSql.slice(start, execSql.indexOf("\n);", start));
  assert.ok(body.includes("rfs_rule_id_not_sentinel"));
  assert.ok(
    body.includes("is distinct from\n                                  '00000000-0000-0000-0000-000000000000'::uuid") ||
      body.replace(/\s+/g, " ").includes(
        "check (fulfillment_rule_id is distinct from '00000000-0000-0000-0000-000000000000'::uuid)"
      ),
    "aucune vraie règle ne doit pouvoir porter la sentinelle"
  );
  assert.ok(execSql.includes("CSDJ1_RESERVED_RULE_ID"), "la RPC doit refuser par un nom");
});

test("[FIXTURE-SOURCE-1] le générateur de la fixture est VERSIONNÉ et traçable", () => {
  // L'audit a eu raison : une preuve « indépendante » dont la source
  // n'est pas livrable n'est pas vérifiable.
  const generator = "tests/fixtures/build-checkout-scheduling-cases.py";
  assert.ok(existsSync(generator), "la troisième implémentation doit être au dépôt");
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/checkout-scheduling-cases.json", "utf8")
  ) as {
    generator?: string;
    generatorCommand?: string;
    generatorRuntime?: { python?: string; tzdataVersion?: string };
  };
  assert.equal(fixture.generator, generator);
  assert.ok(fixture.generatorCommand?.includes(generator));
  assert.ok(fixture.generatorRuntime?.python, "la version de Python doit être consignée");
  assert.ok(
    fixture.generatorRuntime?.tzdataVersion,
    "la version de la base de fuseaux doit être consignée"
  );
  // Et le générateur ne doit RIEN emprunter aux implémentations qu'il
  // juge, sinon il n'en serait pas indépendant.
  // Ce qui compte est qu'il ne LISE aucune des deux implémentations
  // qu'il juge : son en-tête les NOMME, précisément pour expliquer son
  // rôle, et le lui interdire serait confondre documentation et code.
  const executablePy = readFileSync(generator, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  for (const borrowed of ["subprocess", "psycopg", "importlib", "requests"]) {
    assert.ok(
      !executablePy.includes(borrowed),
      `le générateur ne doit rien exécuter d'extérieur (« ${borrowed} »)`
    );
  }
  // Et il ne LIT aucun fichier d'implémentation : ni TypeScript, ni SQL.
  assert.ok(
    !/(open|read_text|readlines|load)\s*\([^)]*\.(ts|sql)\b/.test(executablePy),
    "le générateur ne doit lire aucune des deux implémentations qu'il juge"
  );
  // Ses seules lectures sont la sonde de version de fuseaux ; sa seule
  // écriture est la fixture.
  assert.ok(
    executablePy.includes("zoneinfo"),
    "le générateur doit tirer ses fuseaux de la bibliothèque standard"
  );

});
