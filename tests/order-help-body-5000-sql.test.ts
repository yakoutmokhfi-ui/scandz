import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { COMMUNICATION_TEXT_SPEC } from "../lib/communications/text-keys.ts";

// Le texte « Comment passer commande » (order_help_body) accepte 5000
// caractères ; tous les autres emplacements gardent leur borne. Le SQL réel
// du lot est exécuté dans PGlite (aucune base hébergée).

const sql = (n: string) => readFileSync(`supabase/${n}`, "utf8").replaceAll("\r\n", "\n");
const LOT = "DRAFT-lot-order-help-body-5000-v1.sql";
const ROLLBACK = "DRAFT-lot-order-help-body-5000-v1-rollback.sql";
const THEME = sql("DRAFT-lot-theme-content-settings-v1.sql");
const MCC = sql("DRAFT-lot-merchant-customer-communications-v1.sql");

// Fonction de bornes TELLE QUE posée par THEME & CONTENT SETTINGS v1 (version courante).
const FN = THEME.match(/create or replace function public\.communication_text_max_length[\s\S]*?\$\$;/)![0];
// CHECK de table tel que posé par MCC v1.
// Catalogue de clés tel que posé par THEME & CONTENT SETTINGS v1 (version courante).
const KEYS = THEME.match(/create or replace function public\.communication_text_keys\(\)[\s\S]*?\$\$;/)![0];
const CHECK = MCC.match(/constraint merchant_communication_text_body_length\s+check \([^\n]+\)/)![0];

async function makeDb(apply = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.merchant_communication_text (
      restaurant_id uuid not null default gen_random_uuid(),
      text_key text not null, body text,
      primary key (restaurant_id, text_key),
      ${CHECK}
    );
    ${KEYS}
    ${FN}
    revoke all on function public.communication_text_max_length(text) from public, anon, authenticated, service_role;
  `);
  if (apply) await db.exec(sql(LOT));
  return db;
}
const insert = (db: PGlite, key: string, n: number) =>
  db.query("insert into public.merchant_communication_text (text_key, body) values ($1, $2)", [key, "x".repeat(n)]);
const max = async (db: PGlite, key: string) =>
  (await db.query<{ m: number }>("select public.communication_text_max_length($1) as m", [key])).rows[0]!.m;

test("[OH5000-1] avant le lot : 500 ; après : order_help_body 5000, table acceptant 5000 et refusant 5001", async () => {
  const before = await makeDb(false);
  assert.equal(await max(before, "order_help_body"), 500);
  await assert.rejects(() => insert(before, "order_help_body", 501), /merchant_communication_text_body_length/);

  const db = await makeDb();
  assert.equal(await max(db, "order_help_body"), 5000);
  await insert(db, "order_help_body", 5000);
  await assert.rejects(() => insert(db, "order_help_body", 5001), /merchant_communication_text_body_length/);
});

test("[OH5000-2] les autres emplacements gardent EXACTEMENT leurs bornes", async () => {
  const db = await makeDb();
  const expected: Record<string, number> = {
    email_confirmation_subject: 160, order_help_button_label: 60, order_help_title: 120,
    checkout_info: 500, pickup_explanation: 500, billing_profile_explanation: 500,
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(await max(db, k), v, k);
});

test("[OH5000-3] miroir TypeScript : mêmes bornes que le SQL", async () => {
  const db = await makeDb();
  for (const key of ["order_help_body", "order_help_title", "order_help_button_label", "checkout_info", "email_confirmation_subject"] as const) {
    assert.equal(COMMUNICATION_TEXT_SPEC[key].maxLength, await max(db, key), key);
  }
});

test("[OH5000-4] double application et dérive refusées", async () => {
  const db = await makeDb();
  await assert.rejects(() => db.exec(sql(LOT)), /SCANYM_ALREADY_APPLIED/);

  const drift = await makeDb(false);
  await drift.exec(`create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable as $$ select 500 $$;`);
  await assert.rejects(() => drift.exec(sql(LOT)), /SCANYM_SCHEMA_DRIFT/);
});

test("[OH5000-5] retour arrière : refusé si un texte dépasse 500, sinon état d'origine restauré à l'identique", async () => {
  const original = async (db: PGlite) =>
    (await db.query<{ d: string }>("select pg_get_functiondef('public.communication_text_max_length(text)'::regprocedure) as d")).rows[0]!.d;
  const base = await original(await makeDb(false));

  const db = await makeDb();
  await insert(db, "order_help_body", 800);
  await assert.rejects(() => db.exec(sql(ROLLBACK)), /SCANYM_ROLLBACK_REFUSED/);
  await db.exec("rollback");
  await db.query("delete from public.merchant_communication_text");
  await db.exec(sql(ROLLBACK));
  assert.equal((await original(db)).split("COMMENT")[0], base.split("COMMENT")[0]);
  assert.equal(await max(db, "order_help_body"), 500);
  await assert.rejects(() => insert(db, "order_help_body", 501), /merchant_communication_text_body_length/);
});

// ====================================================================
// CONTRE-AUDIT PR #186 (SHA b932aed) : le pré-vol laissait passer une borne
// hors périmètre dérivée (ex. 80 au lieu de 160) et l'écrasait en silence.
// Chaque dérive doit arrêter le lot EXPLICITEMENT, avant toute mutation, et
// laisser définitions ET données strictement inchangées.
// ====================================================================

async function snapshot(db: PGlite) {
  const fn = (await db.query<{ d: string }>(
    "select pg_get_functiondef('public.communication_text_max_length(text)'::regprocedure) as d")).rows[0]!.d;
  const ck = (await db.query<{ d: string }>(
    "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'merchant_communication_text_body_length'")).rows[0]!.d;
  const rows = (await db.query("select restaurant_id, text_key, body from public.merchant_communication_text order by text_key")).rows;
  const priv = (await db.query<{ a: boolean; b: boolean; c: boolean }>(
    `select has_function_privilege('anon','public.communication_text_max_length(text)','execute') a,
            has_function_privilege('authenticated','public.communication_text_max_length(text)','execute') b,
            has_function_privilege('service_role','public.communication_text_max_length(text)','execute') c`)).rows[0]!;
  return JSON.stringify({ fn, ck, rows, priv });
}

const PREDECESSOR_BODY = (subject: number, label = 60, title = 120, other = 500) => `
  select case
    when p_text_key = 'email_confirmation_subject' then ${subject}
    when p_text_key = 'order_help_button_label' then ${label}
    when p_text_key = 'order_help_title' then ${title}
    else ${other}
  end`;

const DRIFTS: Array<{ name: string; setup: string; expect: RegExp }> = [
  { name: "borne d'e-mail hors périmètre à 80 (cas du contre-audit)",
    setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$${PREDECESSOR_BODY(80)}$$;`,
    expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "libellé du bouton à 40", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$${PREDECESSOR_BODY(160, 40)}$$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "titre à 200", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$${PREDECESSOR_BODY(160, 60, 200)}$$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "défaut ailleurs à 400", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$${PREDECESSOR_BODY(160, 60, 120, 400)}$$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "branche ajoutée par un autre lot", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$ select case when p_text_key = 'email_confirmation_subject' then 160 when p_text_key = 'order_help_button_label' then 60 when p_text_key = 'order_help_title' then 120 when p_text_key = 'billing_profile_explanation' then 900 else 500 end $$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "volatilité modifiée (stable)", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql stable set search_path = '' as $$${PREDECESSOR_BODY(160)}$$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "search_path modifié", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable as $$${PREDECESSOR_BODY(160)}$$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "droit d'exécution accordé à anon", setup: `grant execute on function public.communication_text_max_length(text) to anon;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "littéral en MAJUSCULES (contre-exemple Maxwell)", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$ select case when p_text_key = 'EMAIL_CONFIRMATION_SUBJECT' then 160 when p_text_key = 'order_help_button_label' then 60 when p_text_key = 'order_help_title' then 120 else 500 end $$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "espace insérée dans un littéral (contre-exemple Maxwell)", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$ select case when p_text_key = 'email_confirmation_ subject' then 160 when p_text_key = 'order_help_button_label' then 60 when p_text_key = 'order_help_title' then 120 else 500 end $$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "littéral supplémentaire dans une branche morte, sans effet sur les valeurs", setup: `create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$ select case when p_text_key = 'email_confirmation_subject' then 160 when p_text_key = 'order_help_button_label' then 60 when p_text_key = 'order_help_title' then 120 when p_text_key = 'zz_inconnu' then 500 else 500 end $$;`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "CHECK avec un signe unaire -length(...) (contre-exemple Maxwell)", setup: `alter table public.merchant_communication_text drop constraint merchant_communication_text_body_length; alter table public.merchant_communication_text add constraint merchant_communication_text_body_length check (body is null or -pg_catalog.length(pg_catalog.btrim(body)) <= 500);`, expect: /SCANYM_SCHEMA_DRIFT/ },
  { name: "CHECK de table dérivé (300)", setup: `alter table public.merchant_communication_text drop constraint merchant_communication_text_body_length; alter table public.merchant_communication_text add constraint merchant_communication_text_body_length check (body is null or pg_catalog.length(pg_catalog.btrim(body)) <= 300);`, expect: /SCANYM_SCHEMA_DRIFT/ },
];

for (const d of DRIFTS) {
  test(`[OH5000-6] pré-vol : ${d.name} -> arrêt explicite AVANT mutation, rien n'est modifié`, async () => {
    const db = await makeDb(false);
    await db.exec(d.setup);
    await db.query("insert into public.merchant_communication_text (text_key, body) values ('checkout_info', 'donnée existante')");
    const before = await snapshot(db);
    await assert.rejects(() => db.exec(sql(LOT)), d.expect);
    await db.exec("rollback");
    assert.equal(await snapshot(db), before, "définitions, droits et données strictement inchangés");
    // Le lot n'a rien écrit : order_help_body reste à la borne par défaut du prédécesseur.
    assert.notEqual(await max(db, "order_help_body"), 5000);
  });
}

test("[OH5000-7] retour arrière : état posé par le lot dérivé -> arrêt avant mutation", async () => {
  const db = await makeDb();
  await db.exec(`create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$ select case when p_text_key = 'email_confirmation_subject' then 80 when p_text_key = 'order_help_button_label' then 60 when p_text_key = 'order_help_title' then 120 when p_text_key = 'order_help_body' then 5000 else 500 end $$;`);
  const before = await snapshot(db);
  await assert.rejects(() => db.exec(sql(ROLLBACK)), /SCANYM_SCHEMA_DRIFT/);
  await db.exec("rollback");
  assert.equal(await snapshot(db), before);
});

test("[OH5000-8] retour arrière : CHECK avec signe unaire « - » (contre-exemple Maxwell) -> arrêt avant mutation, définitions, droits et données inchangés", async () => {
  const db = await makeDb();
  await db.exec(`alter table public.merchant_communication_text drop constraint merchant_communication_text_body_length;
    alter table public.merchant_communication_text add constraint merchant_communication_text_body_length
    check (body is null or -pg_catalog.length(pg_catalog.btrim(body)) <= 5000);`);
  await db.query("insert into public.merchant_communication_text (text_key, body) values ('checkout_info', 'donnée existante')");
  const before = await snapshot(db);
  await assert.rejects(() => db.exec(sql(ROLLBACK)), /SCANYM_SCHEMA_DRIFT/);
  await db.exec("rollback");
  assert.equal(await snapshot(db), before);
});

test("[OH5000-9] retour arrière : littéral en MAJUSCULES / espace dans un littéral dans l'état posé -> arrêt avant mutation", async () => {
  for (const lit of ["'EMAIL_CONFIRMATION_SUBJECT'", "'email_confirmation_ subject'"]) {
    const db = await makeDb();
    await db.exec(`create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$
      select case when p_text_key = ${lit} then 160 when p_text_key = 'order_help_button_label' then 60 when p_text_key = 'order_help_title' then 120 when p_text_key = 'order_help_body' then 5000 else 500 end $$;`);
    const before = await snapshot(db);
    await assert.rejects(() => db.exec(sql(ROLLBACK)), /SCANYM_SCHEMA_DRIFT/, lit);
    await db.exec("rollback");
    assert.equal(await snapshot(db), before, lit);
  }
});

test("[OH5000-10] la MISE EN FORME du prédécesseur n'est pas une dérive (blancs, retours, casse des mots-clés) : le lot s'applique", async () => {
  const db = await makeDb(false);
  await db.exec(`create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path = '' as $$SELECT CASE WHEN p_text_key='email_confirmation_subject' THEN 160
 WHEN p_text_key  =  'order_help_button_label'   THEN   60

 WHEN p_text_key = 'order_help_title' THEN 120 ELSE 500 END$$;`);
  await db.exec(sql(LOT));
  assert.equal(await max(db, "order_help_body"), 5000);
  assert.equal(await max(db, "email_confirmation_subject"), 160);
  await insert(db, "order_help_body", 5000);
  await assert.rejects(() => insert(db, "order_help_body", 5001), /merchant_communication_text_body_length/);
});

test("[OH5000-11] le CHECK nominal (rendu réel par PostgreSQL) est reconnu ; cycle nominal lot -> retour arrière -> lot", async () => {
  const db = await makeDb();
  await db.exec(sql(ROLLBACK));
  assert.equal(await max(db, "order_help_body"), 500);
  await db.exec(sql(LOT));
  assert.equal(await max(db, "order_help_body"), 5000);
});
