import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { buildTranslationRows } from "../lib/translations-management/rows.ts";
import { resolveTranslatedField } from "../lib/translation-resolver.ts";

const read = (name: string) => readFileSync(`supabase/${name}`, "utf8");
const MIGRATION = read("DRAFT-lot-order-help-translations-v1.sql");
const ROLLBACK = read("DRAFT-lot-order-help-translations-v1-rollback.sql");
const RID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select '${RID}'::uuid $$;
    create table public.restaurant_configs(restaurant_id uuid primary key, source_language text not null);
    insert into public.restaurant_configs values ('${RID}','fr');
    create table public.supported_languages(code text primary key);
    insert into public.supported_languages values ('fr'),('en'),('ar'),('nl');
    create table public.restaurant_active_languages(restaurant_id uuid, language_code text);
    insert into public.restaurant_active_languages values ('${RID}','fr'),('${RID}','en'),('${RID}','ar'),('${RID}','nl');
    create table public.merchant_communication_text(
      restaurant_id uuid not null, text_key text not null, body text,
      primary key(restaurant_id,text_key)
    );
    insert into public.merchant_communication_text(restaurant_id,text_key,body) values
      ('${RID}','order_help_button_label','Comment passer commande ?'),
      ('${RID}','order_help_title','Comment passer commande ?'),
      ('${RID}','order_help_body','Choisissez vos produits.'),
      ('${RID}','email_confirmation_body','internal template');
    create function public.has_role_in(uuid,text[]) returns boolean language sql stable as $$ select true $$;
    create function public.is_scanym_operator() returns boolean language sql stable as $$ select false $$;
    create function public.communication_text_max_length(text) returns integer language sql immutable as $$ select case $1 when 'order_help_button_label' then 60 when 'order_help_title' then 120 when 'order_help_body' then 5000 else 500 end $$;
    create function public.communication_template_unknown_variables(text) returns text[] language sql immutable as $$ select array[]::text[] $$;
  `);
  await pg.exec(MIGRATION);
  return pg;
}

test("order-help translations are stored per active language with a source hash", async () => {
  const pg = await db();
  const sourceHash = (await pg.query<{ body_hash: string }>(
    `select body_hash from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`, [RID]
  )).rows[0]!.body_hash;
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','en',$2,'validated',$3)`, [RID,"Choose your products.",sourceHash]);
  const row = (await pg.query<{ translations: any }>(
    `select translations from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`, [RID]
  )).rows[0]!;
  assert.equal(row.translations.en.order_help_body, "Choose your products.");
  assert.equal(row.translations.en.order_help_body_status, "validated");
  assert.equal(row.translations.en.order_help_body_source_hash, sourceHash);
  assert.equal(row.translations.fr, undefined);
});

test("source language, inactive language, unknown key and stale source are refused without altering translations", async () => {
  const pg = await db();
  const call = `select public.write_order_help_translation($1,$2,$3,$4,$5,$6)`;
  const args = [RID,"order_help_body","en","Choose products.","validated",null];
  await assert.rejects(() => pg.query(call, [RID,args[1],"fr",args[3],args[4],null]), /Cannot translate into source language/);
  await assert.rejects(() => pg.query(call, [RID,args[1],"de",args[3],args[4],null]), /Language is not active/);
  await assert.rejects(() => pg.query(call, [RID,"email_confirmation_body",args[2],args[3],args[4],null]), /Invalid order-help translation field/);
  await assert.rejects(() => pg.query(call, [RID,args[1],args[2],args[3],args[4],"stale-hash"]), /SCANYM_TRANSLATION_SOURCE_CHANGED/);
  const value = (await pg.query<{ translations: unknown }>(`select translations from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.translations;
  assert.equal(value, null);
});

test("public projection returns only order-help fields and never email templates", async () => {
  const pg = await db();
  const rows = (await pg.query<{ text_key: string }>(`select * from public.get_restaurant_public_order_help_texts($1)`,[RID])).rows;
  assert.deepEqual(rows.map((row) => row.text_key), ["order_help_body","order_help_button_label","order_help_title"]);
  assert.ok(!rows.some((row) => row.text_key.includes("email")));
});

test("translation manager exposes the merchant label, dialog title, and dialog body as separate rows", () => {
  const rows = buildTranslationRows({
    restaurant: { restaurantId: RID, restaurantName: "Shop", introText: null, introTextHash: null, announcementText: null, announcementTextHash: null, translations: null },
    categories: [],
    orderHelpTexts: [
      { restaurantId: RID, restaurantName: "Shop", textKey: "order_help_button_label", body: "Comment passer commande ?", bodyHash: "a", translations: null },
      { restaurantId: RID, restaurantName: "Shop", textKey: "order_help_title", body: "Comment passer commande ?", bodyHash: "b", translations: null },
      { restaurantId: RID, restaurantName: "Shop", textKey: "order_help_body", body: "Choisissez vos produits.", bodyHash: "c", translations: null },
    ],
  });
  assert.deepEqual(rows.map((row) => row.field), ["order_help_button_label","order_help_title","order_help_body"]);
  assert.ok(rows.every((row) => row.entityType === "order_help"));
});

test("storefront resolver uses validated fresh translations and falls back to source otherwise", () => {
  const translations = {
    en: {
      order_help_button_label: "How to order",
      order_help_button_label_status: "validated",
      order_help_button_label_source_hash: "source-hash",
    },
  };
  assert.equal(resolveTranslatedField("Comment passer commande ?","source-hash",translations,"en","fr","order_help_button_label"),"How to order");
  assert.equal(resolveTranslatedField("Comment passer commande ?","new-hash",translations,"en","fr","order_help_button_label"),"Comment passer commande ?");
  assert.equal(resolveTranslatedField("Comment passer commande ?","source-hash",translations,"fr","fr","order_help_button_label"),"Comment passer commande ?");
});

test("rollback refuses to discard order-help translations", async () => {
  const pg = await db();
  const hash = (await pg.query<{ body_hash: string }>(`select body_hash from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.body_hash;
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','en','Help','validated',$2)`,[RID,hash]);
  await assert.rejects(() => pg.exec(ROLLBACK),/communication text translations exist/);
});

test("translation migration refuses to run before the approved 5000-character help-body limit", async () => {
  const pg = new PGlite();
  await pg.exec(`
    create table public.merchant_communication_text(restaurant_id uuid, text_key text, body text);
    create function public.has_role_in(uuid,text[]) returns boolean language sql stable as $$ select true $$;
    create function public.is_scanym_operator() returns boolean language sql stable as $$ select false $$;
    create function public.communication_text_max_length(text) returns integer language sql immutable as $$ select 500 $$;
    create function public.communication_template_unknown_variables(text) returns text[] language sql immutable as $$ select array[]::text[] $$;
    create table public.restaurant_active_languages(restaurant_id uuid, language_code text);
    create table public.supported_languages(code text);
    create table public.restaurant_configs(restaurant_id uuid, source_language text);
  `);
  await assert.rejects(() => pg.exec(MIGRATION), /5000-character limit first/);
  await pg.exec("rollback");
  const columns = await pg.query<{ column_name: string }>(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='merchant_communication_text'
      and column_name in ('translations','body_hash')
  `);
  assert.equal(columns.rows.length, 0);
});
