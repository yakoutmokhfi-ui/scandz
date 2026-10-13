import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Scanny — CSDJ v1.2 — remédiation d'audit Cat Greco.
 *   CSDJ12-DEPLOY-01 : pré-vol / post-vol de l'aller (identité de l'exécutant,
 *                      état exact des prédécesseurs et des objets créés).
 *   CSDJ12-RB-02     : le retour refuse si CSDJ-3 est installé.
 *
 * GARDE STRUCTURELLE : ce que l'on ne prouve qu'en lisant le SQL. La preuve
 * d'EXÉCUTION est dans le harnais PostgreSQL jetable (sections [17] à [19]).
 */

const SQL_PATH = "supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql";
const ROLLBACK_PATH = "supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql";
const HARNESS_PATH = "supabase/tests/checkout-scheduling-v12-check.sh";
const FIXTURE_PATH = "tests/fixtures/csdj12-prod-predecessor-create_order.sql";
const CONTRACT_PATH = "docs/scheduling/csdj-v1.2-interface-contract.md";

const sql = readFileSync(SQL_PATH, "utf8");
const rollback = readFileSync(ROLLBACK_PATH, "utf8");
const harness = readFileSync(HARNESS_PATH, "utf8");
const fixture = readFileSync(FIXTURE_PATH, "utf8");
const contract = readFileSync(CONTRACT_PATH, "utf8");

const stripComments = (s: string) =>
  s
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
const code = stripComments(sql);
const rbCode = stripComments(rollback);

const PINNED_CREATE_ORDER_MD5 = "c327445751333e7908d60e6d7f838eb5";

type Pin = {
  sig: string;
  name: string;
  pre: boolean;
  post: boolean;
  secdef: boolean;
  vol: string | null;
  res: string | null;
  body: string | null;
  acl: string;
  eff: string;
  cfg: string;
};

function parsePins(): Pin[] {
  const start = code.indexOf("select * from (values");
  const end = code.indexOf(") as pin(sig, pre, post, secdef, vol, res_md5, body_md5, acl, eff, cfg)");
  assert.ok(start > 0 && end > start, "liste d'état attendu introuvable");
  const block = code.slice(start, end);
  const q = "(null|'[^']*')";
  const re = new RegExp(
    `\\(\\s*'(public\\.[^']+)',\\s*(true|false),\\s*(true|false),\\s*(true|false),\\s*${q},\\s*${q},\\s*${q},\\s*'([^']*)',\\s*'([^']*)',\\s*'([^']*)'\\s*\\)`,
    "g",
  );
  const unq = (v: string) => (v === "null" ? null : v.slice(1, -1));
  const pins: Pin[] = [];
  for (const m of block.matchAll(re)) {
    pins.push({
      sig: m[1],
      name: m[1].replace(/^public\./, "").split("(")[0],
      pre: m[2] === "true",
      post: m[3] === "true",
      secdef: m[4] === "true",
      vol: unq(m[5]),
      res: unq(m[6]),
      body: unq(m[7]),
      acl: m[8],
      eff: m[9],
      cfg: m[10],
    });
  }
  return pins;
}
const pins = parsePins();

function createdFunctionNames(src: string): string[] {
  return [...src.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]);
}

const PREDECESSORS = [
  "checkout_date_selection_modes",
  "checkout_slot_selection_modes",
  "checkout_wall_time_instant",
  "checkout_wall_time_status",
  "get_checkout_fulfillment_schedule",
  "has_role_in",
  "is_member_of",
  "is_scanym_operator",
  "mutate_merchant_fulfillment_schedule",
  "resolve_fulfillment_schedule",
];

// ----------------------------------------------------------- DEPLOY-01
test("[V12-DEPLOY-1] l'identité de l'exécutant est vérifiée AVANT toute création d'objet", () => {
  const id = code.indexOf("do $csdj12_identity$");
  assert.ok(id > 0, "bloc d'identité absent");
  const firstCreate = code.search(/create (table|function|temp)/i);
  assert.ok(id < firstCreate, "l'identité doit précéder toute création");
  const block = code.slice(id, code.indexOf("$csdj12_identity$;", id));
  assert.match(block, /current_user::text is distinct from 'postgres'/);
  assert.match(block, /SCANYM_DEPLOY_IDENTITY/);
  assert.match(block, /errcode = '42501'/);
});

test("[V12-DEPLOY-2] l'état attendu : 10 prédécesseurs avant, 9 inchangés + _v1 + 14 créées après", () => {
  assert.equal(pins.length, 25);
  assert.equal(pins.filter((p) => p.pre).length, 10);
  assert.equal(pins.filter((p) => p.post).length, 24);
  assert.deepEqual(
    pins.filter((p) => p.pre && p.post).map((p) => p.name).sort(),
    PREDECESSORS.filter((n) => n !== "resolve_fulfillment_schedule").sort(),
  );
  assert.deepEqual(
    pins.filter((p) => p.pre).map((p) => p.name).sort(),
    [...PREDECESSORS].sort(),
  );
  const v1 = pins.filter((p) => p.name === "resolve_fulfillment_schedule_v1");
  assert.equal(v1.length, 1);
  assert.ok(!v1[0].pre && v1[0].post);
  const oldResolver = pins.find((p) => p.name === "resolve_fulfillment_schedule" && p.pre)!;
  // l'ancien résolveur renommé est LE MÊME objet : mêmes empreintes, mêmes droits
  for (const k of ["body", "res", "acl", "eff", "cfg", "vol"] as const) {
    assert.equal(v1[0][k], oldResolver[k], `_v1 diffère de l'ancien résolveur (${k})`);
  }
});

test("[V12-DEPLOY-3] toute fonction créée par l'aller a une épingle de post-vol, et inversement", () => {
  const created = new Set(createdFunctionNames(code));
  const postNew = new Set(pins.filter((p) => p.post && !p.pre).map((p) => p.name));
  for (const n of created) assert.ok(postNew.has(n), `fonction créée sans épingle de post-vol : ${n}`);
  for (const n of postNew) {
    assert.ok(created.has(n) || n === "resolve_fulfillment_schedule_v1", `épingle orpheline : ${n}`);
  }
  assert.equal(created.size, 14);
});

test("[V12-DEPLOY-4] chaque prédécesseur épinglé est réellement utilisé par l'aller (aucune épingle morte)", () => {
  for (const n of PREDECESSORS) {
    if (n === "resolve_fulfillment_schedule") continue; // renommée
    assert.ok(new RegExp(`public\\.${n}\\b`).test(code), `${n} épinglé mais jamais référencé`);
  }
});

test("[V12-DEPLOY-5] empreintes canoniques : md5 32 hex, proconfig complet, ACL nommant le donneur", () => {
  for (const p of pins) {
    assert.equal(p.cfg, 'search_path=""', `${p.sig} : proconfig`);
    assert.match(p.acl, /^([A-Za-z0-9_]+\/[A-Za-z0-9_]+:EXECUTE\*?)(,[A-Za-z0-9_]+\/[A-Za-z0-9_]+:EXECUTE\*?)*$/, `${p.sig} : ACL`);
    assert.match(p.eff, /^anon=(true|false),authenticated=(true|false),service_role=(true|false)$/, `${p.sig} : privilèges effectifs`);
    assert.ok(p.acl.includes("postgres/postgres:EXECUTE"), `${p.sig} : le propriétaire doit être le donneur`);
    assert.ok(!p.acl.includes("PUBLIC"), `${p.sig} : PUBLIC ne doit jamais être attendu`);
    assert.ok(!p.acl.includes("*"), `${p.sig} : aucune option de transmission attendue`);
    if (p.pre) {
      assert.match(p.body ?? "", /^[0-9a-f]{32}$/, `${p.sig} : empreinte de corps`);
      assert.match(p.res ?? "", /^[0-9a-f]{32}$/, `${p.sig} : empreinte de type de retour`);
      assert.ok(p.vol && "ivs".includes(p.vol) || p.vol === "v", `${p.sig} : volatilité`);
    }
  }
});

test("[V12-DEPLOY-6] le comparateur vérifie TOUS les aspects exigés", () => {
  const start = code.indexOf("create function pg_temp.csdj12_pin_drift");
  const end = code.indexOf("$csdj12_pin_drift$;", start + 80);
  assert.ok(start > 0 && end > start);
  const fn = code.slice(start, end);
  for (const [what, re] of [
    ["surcharge unique", /count\(\*\) into v_n[\s\S]*proname = p\.proname/],
    ["propriétaire", /pg_get_userbyid\(p\.proowner\)::text <> 'postgres'/],
    ["SECURITY DEFINER/INVOKER", /p\.prosecdef is distinct from r\.secdef/],
    ["volatilité", /p\.provolatile/],
    ["proconfig complet", /array_to_string\(p\.proconfig, ','\)/],
    ["type de retour", /pg_get_function_result\(p\.oid\)/],
    ["corps (LF)", /md5\(pg_catalog\.replace\(p\.prosrc, pg_catalog\.chr\(13\)/],
    ["ACL : aclexplode", /pg_catalog\.aclexplode\(p\.proacl\)/],
    ["ACL : PUBLIC", /a\.grantee = 0 then 'PUBLIC'/],
    ["ACL : donneur", /pg_get_userbyid\(a\.grantor\)/],
    ["ACL : option de transmission", /a\.is_grantable/],
    ["ACL : tri indépendant de la locale", /collate "C"/],
    ["privilège effectif anon", /has_function_privilege\('anon'/],
    ["privilège effectif authenticated", /has_function_privilege\('authenticated'/],
    ["privilège effectif service_role", /has_function_privilege\('service_role'/],
  ] as Array<[string, RegExp]>) {
    assert.match(fn, re, `aspect non vérifié : ${what}`);
  }
  assert.match(fn, /set search_path = ''/, "la fonction temporaire doit avoir un search_path vide");
  assert.doesNotMatch(fn.replace(/pg_catalog\.[a-z_]+/g, ""), /\bpublic\./.source ? /[^'"(]\bpublic\.[a-z]/ : /x^/, "références non qualifiées à public hors épingles");
});

test("[V12-DEPLOY-7] pré-vol : rôles, propriétaire des tables, puis épingles 'pre' ; post-vol : épingles 'post' et propriétaire des tables créées", () => {
  const pre = code.slice(code.indexOf("do $csdj12_preflight$"), code.indexOf("$csdj12_preflight$;"));
  assert.match(pre, /pg_temp\.csdj12_pin_drift\('pre'\)/);
  assert.match(pre, /errcode = '55000'/);
  for (const role of ["anon", "authenticated", "service_role"]) assert.ok(pre.includes(`'${role}'`));
  const post = code.slice(code.indexOf("do $csdj12_postflight$"), code.indexOf("$csdj12_postflight$;"));
  assert.match(post, /pg_temp\.csdj12_pin_drift\('post'\)/);
  assert.match(post, /pg_get_userbyid\(c\.relowner\)::text\)? is distinct from 'postgres'|is distinct from 'postgres'/);
  assert.ok(post.indexOf("pg_temp.csdj12_pin_drift('post')") > post.indexOf("public_holiday_calendar"), "épingles après les contrôles d'objets");
});

test("[V12-DEPLOY-8] la fonction temporaire est supprimée AVANT le COMMIT, après le post-vol", () => {
  const drop = code.indexOf("drop function pg_temp.csdj12_pin_drift(text);");
  assert.ok(drop > code.indexOf("$csdj12_postflight$;"));
  assert.ok(drop < code.lastIndexOf("commit;"));
  assert.equal([...code.matchAll(/create function pg_temp\./g)].length, 1);
  assert.doesNotMatch(code, /create temp table/i, "aucun état attendu stocké dans une table");
});

test("[V12-DEPLOY-9] les deux RPC marchandes sont fermées à service_role de façon déterministe (droits par défaut Supabase inclus)", () => {
  assert.match(code, /revoke all on function public\.mutate_merchant_fulfillment_schedule_v12\(uuid,text,jsonb\) from public, anon, service_role;/);
  assert.match(code, /revoke all on function public\.get_merchant_fulfillment_schedules_v12\(uuid\) from public, anon, service_role;/);
  for (const n of ["mutate_merchant_fulfillment_schedule_v12", "get_merchant_fulfillment_schedules_v12"]) {
    const p = pins.find((x) => x.name === n)!;
    assert.equal(p.acl, "authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE");
    assert.equal(p.eff, "anon=false,authenticated=true,service_role=false");
  }
});

test("[V12-DEPLOY-10] l'aller ne définit toujours ni create_order, ni update_order_status, ni le moteur de paiement", () => {
  assert.doesNotMatch(code, /function public\.(create_order|update_order_status|initiate_payment_attempt|confirm_payment_attempt)\b/);
  assert.doesNotMatch(code, /alter function public\.(create_order|update_order_status|initiate_payment_attempt)\b/);
});

// ----------------------------------------------------------------- RB-02
test("[V12-RB-1] le retour contrôle le marqueur de schéma CSDJ-3 — nommé par le contrat canonique", () => {
  assert.match(contract, /order_fulfillment_schedule_snapshot/);
  assert.match(rbCode, /to_regclass\('public\.order_fulfillment_schedule_snapshot'\) is not null/);
  assert.match(rbCode, /\[CSDJ3_INSTALLED\]/);
});

test("[V12-RB-2] l'empreinte de create_order épinglée = celle du contrat §12.2/§12.3, de la fixture et du harnais", () => {
  assert.ok(contract.includes(PINNED_CREATE_ORDER_MD5), "contrat");
  assert.ok(rbCode.includes(`'${PINNED_CREATE_ORDER_MD5}'`), "retour");
  assert.ok(harness.includes(`PROD_CO_MD5="${PINNED_CREATE_ORDER_MD5}"`), "harnais");
  assert.match(rbCode, /md5\(pg_catalog\.replace\(p\.prosrc, pg_catalog\.chr\(13\) \|\| pg_catalog\.chr\(10\), pg_catalog\.chr\(10\)\)\)/);
  assert.match(rbCode, /create_order\(text,text,jsonb,integer,jsonb,text,text,boolean\)/);
  assert.match(rbCode, /\[CREATE_ORDER_FINGERPRINT\]/);
});

test("[V12-RB-3] la fixture create_order reproduit EXACTEMENT l'empreinte PROD (md5 LF du corps)", () => {
  const open = "as $csdj12_prod_create_order$";
  const close = "$csdj12_prod_create_order$;";
  const a = fixture.indexOf(open);
  const b = fixture.lastIndexOf(close);
  assert.ok(a > 0 && b > a);
  const body = fixture.slice(a + open.length, b);
  const md5 = createHash("md5").update(body.replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(md5, PINNED_CREATE_ORDER_MD5);
  assert.match(fixture, /security definer/);
  assert.match(fixture, /set search_path to ''/);
});

test("[V12-RB-4] toutes les gardes précèdent la PREMIÈRE modification du schéma", () => {
  const firstMutation = rbCode.search(/\b(drop|alter) (function|table)\b/);
  assert.ok(firstMutation > 0);
  for (const g of ["[CSDJ3_INSTALLED]", "[CREATE_ORDER_FINGERPRINT]", "[ENGINE_CALLER]"]) {
    const i = rollback.indexOf(g);
    assert.ok(i > 0, `${g} absent`);
    assert.ok(rollback.indexOf(g) < rollback.search(/\n(drop|alter) (function|table)\b/), `${g} après une modification`);
  }
  assert.ok(rbCode.indexOf("SCANYM_ROLLBACK_NOT_APPLICABLE") < rbCode.indexOf("[CSDJ3_INSTALLED]"));
});

test("[V12-RB-5] la garde d'appelant orphelin exclut TOUTES les fonctions du moteur (aucun faux positif sur l'état nominal)", () => {
  const m = /p\.proname not in \(([\s\S]*?)\)\s*and p\.prosrc/.exec(rbCode);
  assert.ok(m, "liste d'exclusion introuvable");
  const excluded = new Set([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]));
  for (const n of createdFunctionNames(code)) assert.ok(excluded.has(n), `fonction du moteur non exclue : ${n}`);
  // …et surveille l'ensemble des objets du moteur (sauf le répartiteur, restauré par le retour)
  const scan = /p\.prosrc ~\* '\(([^']*)\)'/.exec(rbCode);
  assert.ok(scan);
  const watched = new Set(scan[1].split("|"));
  for (const n of createdFunctionNames(code)) {
    if (n === "resolve_fulfillment_schedule") continue;
    assert.ok(watched.has(n), `appel de ${n} non surveillé`);
  }
  assert.ok(watched.has("order_fulfillment_capacity_reservation"));
  assert.ok(!watched.has("resolve_fulfillment_schedule"), "le répartiteur est restauré : ne pas le surveiller");
});

test("[V12-RB-6] le retour ne redéfinit ni ne modifie create_order (lecture seule)", () => {
  assert.doesNotMatch(rbCode, /(create (or replace )?function|alter function|drop function) public\.create_order\b/);
  assert.doesNotMatch(rbCode, /public\.update_order_status|public\.initiate_payment_attempt/);
});

test("[V12-RB-7] l'ordre inverse du déploiement est documenté dans le retour", () => {
  assert.match(rollback, /ORDRE INVERSE DU DÉPLOIEMENT/);
  assert.match(rollback, /CSDJ-3 d'abord, PUIS CE FICHIER/);
});

// --------------------------------------------------------------- HARNESS
test("[V12-HARNESS-8] le harnais couvre DEPLOY-01 / RB-02 : cas négatifs, post-vol, ordre inverse, mutation", () => {
  for (const marker of [
    "[17] DEPLOY-01",
    "[18] RB-02",
    "[19] Mutation des gardes",
    "fwd_refused",
    "postflight_fails",
    "rb_refused",
    "mut_fwd",
    "mut_rb",
    "SCANYM_DEPLOY_IDENTITY",
    "CSDJ3_INSTALLED",
    "CREATE_ORDER_FINGERPRINT",
    "ENGINE_CALLER",
    "ORDRE INVERSE",
    "grantor",
  ]) {
    assert.ok(harness.includes(marker) || harness.toLowerCase().includes(marker.toLowerCase()), `harnais : ${marker} absent`);
  }
  // exécutant inattendu : un superutilisateur ET un rôle ordinaire
  assert.match(harness, /NEG_SU/);
  assert.match(harness, /NEG_PLAIN/);
  // le harnais exige l'exécutant postgres (le SQL l'épingle)
  assert.match(harness, /\[ "\$CUR_USER" = "postgres" \]/);
});

test("[V12-HARNESS-9] aucune mutation de rôle en SQL brut : elles passent par le point de passage gardé", () => {
  for (const line of harness.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (/\bpsql\b/.test(line)) {
      assert.doesNotMatch(line, /\b(create|drop|alter) role\b|grant authenticated to anon|revoke authenticated from anon/i, `mutation de rôle brute : ${line.trim()}`);
    }
  }
  assert.match(harness, /csdj1_identity_mutate "\s*\n\s*create role \$NEG_ROLE nologin;/);
});

test("[V12-HARNESS-10] la chaîne du harnais aligne create_order sur le prédécesseur PROD et vérifie l'empreinte", () => {
  assert.match(harness, /PROD_CO_FIXTURE=/);
  assert.match(harness, /csdj12-prod-predecessor-create_order\.sql/);
  assert.match(harness, /la fixture create_order ne reproduit pas l'empreinte PROD/);
});
