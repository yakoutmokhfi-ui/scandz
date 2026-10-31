import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const RID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAG = "11111111-1111-4111-8111-111111111111";
const read = (file: string) => readFileSync(`supabase/${file}`, "utf8");
const help = read("DRAFT-lot-order-help-translations-v1.sql");
const tags = read("DRAFT-lot-storefront-tag-translations-v1.sql");
const helpRollback = read("DRAFT-lot-order-help-translations-v1-rollback.sql");
const tagRollback = read("DRAFT-lot-storefront-tag-translations-v1-rollback.sql");

for (const [label, first, second, undoFirst, undoSecond] of [
  ["aide puis tags", help, tags, tagRollback, helpRollback],
  ["tags puis aide", tags, help, helpRollback, tagRollback],
] as const) {
  test(`migrations combinées : ${label}`, async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        create role anon; create role authenticated;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select '${RID}'::uuid $$;
        create table public.restaurant_configs(restaurant_id uuid primary key, source_language text not null);
        insert into public.restaurant_configs values ('${RID}','fr');
        create table public.supported_languages(code text primary key);
        insert into public.supported_languages values ('fr'),('en');
        create table public.restaurant_active_languages(restaurant_id uuid, language_code text);
        insert into public.restaurant_active_languages values ('${RID}','fr'),('${RID}','en');
        create table public.merchant_communication_text(restaurant_id uuid not null, text_key text not null, body text, primary key(restaurant_id,text_key));
        insert into public.merchant_communication_text values ('${RID}','order_help_body','Comment commander');
        create function public.has_role_in(uuid,text[]) returns boolean language sql stable as $$ select true $$;
        create function public.is_scanym_operator() returns boolean language sql stable as $$ select false $$;
        create function public.communication_text_max_length(text) returns integer language sql immutable as $$ select case $1 when 'order_help_body' then 5000 else 120 end $$;
        create function public.communication_template_unknown_variables(text) returns text[] language sql immutable as $$ select array[]::text[] $$;
        create table public.menu_tags(id uuid primary key, restaurant_id uuid not null, name text not null, is_active boolean not null, visible_on_customer_menu boolean not null, display_order integer not null);
        insert into public.menu_tags values ('${TAG}','${RID}','Truffe',true,true,0);
        create function public.assert_tag_admin(uuid) returns void language plpgsql as $$ begin if $1 <> '${RID}'::uuid then raise exception 'Not authorized'; end if; end $$;
        create function public.get_restaurant_collections(uuid) returns table(id uuid) language sql stable as $$ select id from public.menu_tags where restaurant_id=$1 and is_active and visible_on_customer_menu $$;
      `);
      await pg.exec(first);
      await pg.exec(second);
      const h = (await pg.query<{v: string}>("select body_hash as v from public.merchant_communication_text where restaurant_id=$1", [RID])).rows[0]!.v;
      const t = (await pg.query<{v: string}>("select md5(name) as v from public.menu_tags where id=$1", [TAG])).rows[0]!.v;
      await pg.query("select public.write_order_help_translation($1,'order_help_body','en','How to order','validated',$2)", [RID,h]);
      await pg.query("select public.write_tag_translation($1,$2,'en','Truffle','validated',$3)", [RID,TAG,t]);
      const helpRows = (await pg.query<{translations:Record<string,Record<string,string>>}>("select translations from public.get_restaurant_public_order_help_texts($1)",[RID])).rows;
      const tagRows = (await pg.query<{value:string}>("select value from public.get_public_tag_translations($1)",[RID])).rows;
      assert.equal(helpRows[0]!.translations.en!.order_help_body, "How to order");
      assert.equal(tagRows[0]!.value, "Truffle");
      await assert.rejects(() => pg.exec(undoFirst), /SCANYM_ROLLBACK/);
      await pg.exec("rollback");
      await pg.exec("delete from public.menu_tag_translations; update public.merchant_communication_text set translations=null");
      await pg.exec(undoFirst);
      await pg.exec(undoSecond);
    } finally { await pg.close(); }
  });
}
