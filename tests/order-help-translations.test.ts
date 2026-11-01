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
  await assert.rejects(() => pg.query(call, [RID,args[1],args[2],args[3],args[4],null]), /SCANYM_TRANSLATION_SOURCE_CHANGED/);
  const value = (await pg.query<{ translations: unknown }>(`select translations from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.translations;
  assert.equal(value, null);
});

test("effacer une traduction retire la langue vide et permet le rollback", async () => {
  const pg = await db();
  const hash = (await pg.query<{ body_hash: string }>(`select body_hash from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.body_hash;
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','en','Help','validated',$2)`,[RID,hash]);
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','en','','validated',$2)`,[RID,hash]);
  const value=(await pg.query<{translations:unknown}>(`select translations from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.translations;
  assert.deepEqual(value, {});
  await pg.exec(ROLLBACK);
  await pg.close();
});

test("effacer une traduction conserve les autres langues et clés", async () => {
  const pg = await db();
  const hash = (await pg.query<{ body_hash: string }>(`select body_hash from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.body_hash;
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','en','Help','validated',$2)`,[RID,hash]);
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','ar','مساعدة','validated',$2)`,[RID,hash]);
  await pg.query(`update public.merchant_communication_text set translations=jsonb_set(translations,'{en,other_key}',to_jsonb('preserve'::text)) where restaurant_id=$1 and text_key='order_help_body'`,[RID]);
  await pg.query(`select public.write_order_help_translation($1,'order_help_body','en','','validated',$2)`,[RID,hash]);
  const value=(await pg.query<{translations:Record<string,unknown>}>(`select translations from public.merchant_communication_text where restaurant_id=$1 and text_key='order_help_body'`,[RID])).rows[0]!.translations;
  assert.deepEqual(value.en, { other_key: "preserve" });
  assert.ok(value.ar);
  await pg.close();
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

test("AUD203-01 rollback refuses altered functions and columns without mutation", async () => {
  const cases = [
    "alter function public.get_restaurant_public_order_help_texts(uuid) security invoker",
    "create or replace function public.get_restaurant_public_order_help_texts(p_restaurant_id uuid) returns table(text_key text, body text, body_hash text, translations jsonb) language sql stable security definer set search_path='' as $$ select null::text,null::text,null::text,null::jsonb where false $$",
    "grant execute on function public.write_order_help_translation(uuid,text,text,text,text,text) to anon",
    "revoke execute on function public.get_restaurant_public_order_help_texts(uuid) from anon",
    "alter function public.write_order_help_translation(uuid,text,text,text,text,text) strict",
    "alter table public.merchant_communication_text alter column translations set default '{}'::jsonb",
  ];
  for (const mutation of cases) {
    const pg = await db();
    await pg.exec(mutation);
    const snapshot = async () => ({
      functions: (await pg.query(`select p.oid::regprocedure::text signature,p.prosrc,p.prosecdef,p.proisstrict,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('get_restaurant_public_order_help_texts','write_order_help_translation') order by 1`)).rows,
      columns: (await pg.query(`select a.attname, format_type(a.atttypid,a.atttypmod) type,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) expr from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.merchant_communication_text'::regclass and a.attname in ('body_hash','translations') order by 1`)).rows,
    });
    const before = await snapshot();
    await assert.rejects(pg.exec(ROLLBACK), /SCANYM_PREDECESSOR_DRIFT/, mutation);
    await pg.exec('rollback');
    assert.deepEqual(await snapshot(), before, mutation);
    await pg.close();
  }
});

test("AUD203-01 accepts full CRLF function bodies but refuses mixed endings", async () => {
  const signatures = ['public.get_restaurant_public_order_help_texts(uuid)', 'public.write_order_help_translation(uuid,text,text,text,text,text)'];
  for (const mixed of [false, true]) {
    const pg = await db();
    for (const signature of signatures) {
      const definition = (await pg.query<{ definition: string }>('select pg_get_functiondef($1::regprocedure) definition', [signature])).rows[0]!.definition;
      const crlf = mixed
        ? definition.replace(/(AS \$function\$)([\s\S]*?)(\$function\$)/i, (_all, open: string, body: string, close: string) => open + body.replace('\n', '\r\n') + close)
        : definition.replaceAll('\n', '\r\n');
      await pg.exec(crlf);
    }
    if (mixed) {
      await assert.rejects(pg.exec(ROLLBACK), /SCANYM_PREDECESSOR_DRIFT/);
      await pg.exec('rollback');
    } else {
      await pg.exec(ROLLBACK);
    }
    await pg.close();
  }
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
