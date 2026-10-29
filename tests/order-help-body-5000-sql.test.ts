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
const CHECK = MCC.match(/constraint merchant_communication_text_body_length\s+check \([^\n]+\)/)![0];

async function makeDb(apply = true) {
  const db = new PGlite();
  await db.exec(`
    create table public.merchant_communication_text (
      restaurant_id uuid not null default gen_random_uuid(),
      text_key text not null, body text,
      primary key (restaurant_id, text_key),
      ${CHECK}
    );
    ${FN}
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
