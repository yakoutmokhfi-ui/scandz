import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCgvWordActualState, assertCgvWordActualStateUnchanged } from "./helpers/cgv-word-catalog-snapshot.ts";
import { PGlite } from "@electric-sql/pglite";
const install = readFileSync("supabase/DRAFT-lot-cgv-word-draft-v1.sql","utf8");
const rollback = readFileSync("supabase/DRAFT-lot-cgv-word-draft-v1-rollback.sql","utf8");
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222", U="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", V="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let shared: PGlite | null = null;
after(async () => { if(shared) await shared.close(); });
async function fixture() {
 if(!shared) { shared = new PGlite(); await shared.exec('create role anon;create role authenticated;create role service_role;'); }
 const db=shared;
 await db.exec('rollback;drop publication if exists third_party_pub;drop schema if exists public cascade;create schema public;drop schema if exists auth cascade;create schema auth;');
 await db.exec(`
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create table restaurants(id uuid primary key);create table merchant_legal_profile(restaurant_id uuid);
 create table cgv_template(id uuid primary key);create table merchant_cgv_profile(restaurant_id uuid);
 create table restaurant_users(restaurant_id uuid,user_id uuid,role text);create table scanym_operators(user_id uuid);
 create table merchant_cgv_version(restaurant_id uuid,status text,content_hash text,published_at timestamptz);
 create function assert_legal_cgv_role(p_restaurant_id uuid) returns void language plpgsql as $$begin
 if auth.uid() is null then raise exception using errcode='28000',message='Authentication required';end if;
 if not exists(select 1 from public.restaurant_users where restaurant_id=p_restaurant_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception using errcode='42501',message='Forbidden';end if;end$$;
 create function _compute_cgv_publication_context_fingerprint(uuid) returns text language sql as $$select md5('fixture')$$;
 create function _resolve_applicable_cgv_template(uuid) returns cgv_template language sql as $$select * from public.cgv_template limit 1$$;
 create function resolve_cgv_publication_context(uuid) returns text language sql as $$select 'fixture'::text$$;
 create function persist_merchant_cgv_version(uuid,uuid,text,text,uuid) returns void language sql as $$select$$;
 insert into restaurants values('${A}'),('${B}');insert into merchant_legal_profile values('${A}'),('${B}');insert into merchant_cgv_profile values('${A}'),('${B}');insert into cgv_template values('${A}');
 insert into restaurant_users values('${A}','${U}','owner'),('${B}','${V}','manager');
 select set_config('test.uid','${U}',false);`);
 await db.exec(install);return db;
}
async function refused(db:PGlite, sql:string, pattern?:RegExp) { if(pattern) await assert.rejects(()=>db.exec(sql),pattern); else await assert.rejects(()=>db.exec(sql)); await db.exec('rollback'); }
const save=(id=A,fp="md5('fixture')")=>`select (save_merchant_cgv_word_draft('${id}',${fp},'{"leadingContent":["title","shop"],"chapters":[]}')).id`;
test("SQL save/load, append-only history and tenant isolation",async()=>{const db=await fixture();try{
 const a=await db.query<{id:string}>(save());await db.exec(save());
 const r=await db.query<{draft:any}>(`select get_merchant_cgv_word_draft('${A}','${a.rows[0].id}') as draft`);assert.equal(r.rows[0].draft.id,a.rows[0].id);
 assert.equal((await db.query(`select * from merchant_cgv_word_draft`)).rows.length,2);
 await refused(db,save(B),/Forbidden/);await refused(db,`select get_merchant_cgv_word_draft('${B}')`,/Forbidden/);
 await db.exec(`select set_config('test.uid','${V}',false)`);assert.equal((await db.query<{d:any}>(`select get_merchant_cgv_word_draft('${B}','${a.rows[0].id}') as d`)).rows[0].d,null);
 await refused(db,`select get_merchant_cgv_word_draft('${A}')`,/Forbidden/);
 }finally{/* isolated schema reset by next fixture; one WASM engine per file */}});
test("SQL auth, context drift, JSON shape, table ACLs and no publication",async()=>{const db=await fixture();try{
 await refused(db,save(A,"md5('stale')"),/STALE_CONTEXT/);
 await refused(db,`select save_merchant_cgv_word_draft('${A}',md5('fixture'),'[]')`,/check constraint/);
 await db.exec(`select set_config('test.uid','',false)`);await refused(db,save(),/Authentication/);
 for(const role of ['anon','authenticated','service_role']) {const q=await db.query<{allowed:boolean}>(`select has_table_privilege('${role}','merchant_cgv_word_draft','SELECT') or has_table_privilege('${role}','merchant_cgv_word_draft','INSERT') or has_table_privilege('${role}','merchant_cgv_word_draft','UPDATE') or has_table_privilege('${role}','merchant_cgv_word_draft','DELETE') as allowed`);assert.equal(q.rows[0].allowed,false);}
 assert.equal((await db.query(`select * from merchant_cgv_version`)).rows.length,0);
 }finally{/* isolated schema reset by next fixture; one WASM engine per file */}});
test("SQL nominal rollback, reapplication and refusal with saved data",async()=>{const db=await fixture();try{await db.exec(rollback);await db.exec(install);await db.exec(save());await refused(db,rollback,/SCANYM_ROLLBACK_HAS_DATA/);assert.equal((await db.query('select * from merchant_cgv_word_draft')).rows.length,1);}finally{/* isolated schema reset by next fixture; one WASM engine per file */}});
for(const [name,mutation] of [
 ['constraint',`alter table merchant_cgv_word_draft add constraint third_party check(created_by is not null)`],
 ['index',`create index third_party_idx on merchant_cgv_word_draft(created_by)`],
 ['column',`alter table merchant_cgv_word_draft add column third_party text`],
 ['function body',`create or replace function get_merchant_cgv_word_draft(p_restaurant_id uuid,p_draft_id uuid default null) returns jsonb language sql as $$select '{}'::jsonb$$`],
 ['security',`alter function get_merchant_cgv_word_draft(uuid,uuid) security invoker`],
 ['strict',`alter function get_merchant_cgv_word_draft(uuid,uuid) strict`],
 ['owner',`alter function get_merchant_cgv_word_draft(uuid,uuid) owner to authenticated`],
 ['grant',`grant execute on function get_merchant_cgv_word_draft(uuid,uuid) to anon`],
 ['table grants',`grant select on merchant_cgv_word_draft to anon`],
 ['comment',`comment on function get_merchant_cgv_word_draft(uuid,uuid) is 'changed'`],
 ['policy',`create policy third_party on merchant_cgv_word_draft using(true)`],
 ['third-party function',`create function external_consumer() returns bigint language plpgsql as $$begin return (select count(*) from public.merchant_cgv_word_draft);end$$`],
 ['third-party procedure',`create procedure external_consumer() language plpgsql as $$begin perform public.get_merchant_cgv_word_draft(null,null);end$$`],
 ['extended statistics',`create statistics third_party_stats on created_by,created_at from merchant_cgv_word_draft`],
 ['owned sequence',`create sequence third_party_seq owned by merchant_cgv_word_draft.created_by`],
 ['publication membership',`create publication third_party_pub for table merchant_cgv_word_draft`],
 ['column comment',`comment on column merchant_cgv_word_draft.created_by is 'third-party metadata'`],
 ['manifest constraint',`alter table cgv_word_draft_install_manifest add constraint third_party check(snapshot is not null)`],
] as const) test(`Rollback refuses drift: ${name}`,async()=>{const db=await fixture();try{await db.exec(mutation);const before=await readCgvWordActualState(db);await refused(db,rollback,/SCANYM_ROLLBACK_DRIFT/);await assertCgvWordActualStateUnchanged(db,before);assert.ok((await db.query<{x:string}>(`select to_regclass('merchant_cgv_word_draft') as x`)).rows[0].x);}finally{/* isolated schema reset by next fixture; one WASM engine per file */}});


test("R2-P3 independent oracle detects a committed DEFAULT followed by the expected error",async()=>{
 const db=await fixture();const before=await readCgvWordActualState(db);
 const stored=(await db.query('select snapshot from cgv_word_draft_install_manifest')).rows;
 const faulty=`begin;alter table public.merchant_cgv_word_draft alter column created_at set default (now()+interval '1 day');commit;do $$begin raise exception 'SCANYM_ROLLBACK_DRIFT';end$$;`;
 await refused(db,faulty,/SCANYM_ROLLBACK_DRIFT/);
 // The old assertions still pass despite the persisted mutation.
 assert.deepEqual((await db.query('select snapshot from cgv_word_draft_install_manifest')).rows,stored);
 assert.ok((await db.query<{x:string}>("select to_regclass('merchant_cgv_word_draft') as x")).rows[0].x);
 await assert.rejects(()=>assertCgvWordActualStateUnchanged(db,before),/actual catalog\/data: defaults/);
});
