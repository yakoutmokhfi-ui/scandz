import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { buildTranslationRows } from "../lib/translations-management/rows.ts";

const RID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAG = "11111111-1111-4111-8111-111111111111";
const HIDDEN = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const CATEGORY = "44444444-4444-4444-8444-444444444444";
const migration = readFileSync("supabase/DRAFT-lot-storefront-tag-translations-v1.sql", "utf8");
const rollback = readFileSync("supabase/DRAFT-lot-storefront-tag-translations-v1-rollback.sql", "utf8");

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated;
    create table public.menu_tags(id uuid primary key, restaurant_id uuid not null, name text not null,
      is_active boolean not null, visible_on_customer_menu boolean not null, display_order int not null);
    create table public.restaurants(id uuid primary key, is_active boolean, status text);
    create table public.menu_categories(id uuid primary key, restaurant_id uuid, is_active boolean);
    create table public.menu_items(id uuid primary key, category_id uuid, archived_at timestamptz, is_available boolean, display_order int, name text);
    create table public.menu_item_tags(tag_id uuid, menu_item_id uuid);
    create table public.restaurant_configs(restaurant_id uuid primary key, source_language text);
    create table public.restaurant_active_languages(restaurant_id uuid, language_code text);
    insert into public.restaurant_configs values ('${RID}','fr'),('${OTHER}','fr');
    insert into public.restaurant_active_languages values ('${RID}','fr'),('${RID}','en'),('${RID}','ar');
    insert into public.menu_tags values ('${TAG}','${RID}','Truffe',true,true,0),('${HIDDEN}','${RID}','Privé',true,false,1);
    insert into public.restaurants values ('${RID}',true,'active'),('${OTHER}',true,'active');
    insert into public.menu_categories values ('${CATEGORY}','${RID}',true);
    insert into public.menu_items values ('${PRODUCT}','${CATEGORY}',null,true,0,'Fromage');
    insert into public.menu_item_tags values ('${TAG}','${PRODUCT}'),('${HIDDEN}','${PRODUCT}');
    create function public.assert_tag_admin(uuid) returns void language plpgsql as $$
      begin if $1 <> '${RID}'::uuid then raise exception 'Not authorized'; end if; end $$;
  `);
  const source=readFileSync('supabase/DRAFT-lot-catalogue-collections-tags-foundation-v1.sql','utf8');
  const start=source.indexOf('create or replace function public.get_restaurant_collections(');
  const end=source.indexOf('end $$;',start);
  assert.ok(start>=0 && end>start, 'la fonction publique existante est présente');
  await pg.exec(source.slice(start,end+'end $$;'.length));
  await pg.exec(migration);
  return pg;
}

test("tag translations are per tag and language; only validated current published entries reach clients", async () => {
  const pg = await setup();
  const hash = (await pg.query<{h:string}>("select md5('Truffe') h")).rows[0]!.h;
  await pg.query("select public.write_tag_translation($1,$2,'en','Truffle','validated',$3)",[RID,TAG,hash]);
  await pg.query("select public.write_tag_translation($1,$2,'ar','كمأة','to_review',$3)",[RID,TAG,hash]);
  const hiddenHash = (await pg.query<{h:string}>("select md5('Privé') h")).rows[0]!.h;
  await pg.query("select public.write_tag_translation($1,$2,'en','Private','validated',$3)",[RID,HIDDEN,hiddenHash]);
  const rows=(await pg.query<{tag_id:string;language_code:string;value:string}>("select * from public.get_public_tag_translations($1)",[RID])).rows;
  assert.deepEqual(rows,[{tag_id:TAG,language_code:"en",value:"Truffle"}]);
  await pg.query("update public.menu_items set is_available=false where id=$1",[PRODUCT]);
  assert.deepEqual((await pg.query("select * from public.get_public_tag_translations($1)",[RID])).rows,[]);
  await pg.query("update public.menu_items set is_available=true where id=$1",[PRODUCT]);
  await pg.query("update public.restaurants set status='suspended' where id=$1",[RID]);
  assert.deepEqual((await pg.query("select * from public.get_public_tag_translations($1)",[RID])).rows,[]);
  await pg.query("update public.restaurants set status='active' where id=$1",[RID]);
  await pg.query("update public.menu_tags set name='Truffe noire' where id=$1",[TAG]);
  assert.deepEqual((await pg.query("select * from public.get_public_tag_translations($1)",[RID])).rows,[]);
  await pg.close();
});

test("stale source, wrong tenant, source language and inactive language are rejected", async () => {
  const pg=await setup();
  const hash=(await pg.query<{h:string}>("select md5('Truffe') h")).rows[0]!.h;
  const call="select public.write_tag_translation($1,$2,$3,'X','validated',$4)";
  await assert.rejects(()=>pg.query(call,[RID,TAG,"en","old"]),/SCANYM_TRANSLATION_SOURCE_CHANGED/);
  await assert.rejects(()=>pg.query(call,[OTHER,TAG,"en",hash]),/Not authorized/);
  await assert.rejects(()=>pg.query(call,[RID,TAG,"fr",hash]),/source language/);
  await assert.rejects(()=>pg.query(call,[RID,TAG,"nl",hash]),/Language not active/);
  assert.equal((await pg.query("select * from public.menu_tag_translations")).rows.length,0);
  const grants = (await pg.query<{anon_read:boolean; anon_write:boolean; anon_public:boolean}>(`select
    has_function_privilege('anon','public.get_merchant_tag_translations(uuid)','EXECUTE') as anon_read,
    has_function_privilege('anon','public.write_tag_translation(uuid,uuid,text,text,text,text)','EXECUTE') as anon_write,
    has_function_privilege('anon','public.get_public_tag_translations(uuid)','EXECUTE') as anon_public`)).rows[0]!;
  assert.deepEqual(grants, { anon_read:false, anon_write:false, anon_public:true });
  await pg.close();
});

test("rollback refuses to delete translations and translation rows keep tag IDs",async()=>{
  const pg=await setup();
  const hash=(await pg.query<{h:string}>("select md5('Truffe') h")).rows[0]!.h;
  await pg.query("select public.write_tag_translation($1,$2,'en','Truffle','validated',$3)",[RID,TAG,hash]);
  await assert.rejects(()=>pg.exec(rollback),/SCANYM_ROLLBACK_DATA_LOSS/);
  await pg.exec("rollback");
  assert.equal((await pg.query("select * from public.menu_tag_translations")).rows.length,1);
  const rows=buildTranslationRows({restaurant:null,categories:[],tagTranslations:[{id:TAG,name:'Truffe',name_hash:hash,translations:null}]});
  assert.equal(rows[0]?.entityId,TAG);
  assert.equal(rows[0]?.entityType,'tag');
  await pg.close();
});

test("rollback succeeds when empty and refuses modified functions", async () => {
  const pg=await setup();
  await pg.exec("alter function public.get_public_tag_translations(uuid) strict");
  await assert.rejects(() => pg.exec(rollback), /SCANYM_PREDECESSOR_DRIFT/);
  await pg.exec("rollback");
  assert.ok((await pg.query<{t:string | null}>("select to_regclass('public.menu_tag_translations')::text as t")).rows[0]!.t);
  await pg.exec("alter function public.get_public_tag_translations(uuid) called on null input");
  await pg.exec(rollback);
  assert.equal((await pg.query<{t:string | null}>("select to_regclass('public.menu_tag_translations')::text as t")).rows[0]!.t,null);
  await pg.close();
});
