import {readCgvChannelActualState as catalog} from './helpers/cgv-channel-catalog-snapshot.ts';
import {isSafeSmtpAddress} from '../lib/server/withdrawal-ack-merchant-mailer.ts';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const install=readFileSync('supabase/DRAFT-lot-cgv-merchant-channel-guard-v1.sql','utf8');
const rollback=readFileSync('supabase/DRAFT-lot-cgv-merchant-channel-guard-v1-rollback.sql','utf8');
const baseline=JSON.parse(readFileSync('tests/fixtures/cgv-merchant-channel-guard-baseline.json','utf8'));
const schema=JSON.parse(readFileSync('tests/fixtures/cgv-merchant-channel-schema.json','utf8'));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let shared:PGlite|undefined;
after(async()=>{await shared?.close()});
async function fixture(apply=true){
 if(!shared){shared=new PGlite();await shared.exec('create role anon;create role authenticated;create role service_role;');}
 const db=shared;
 await db.exec('rollback;drop publication if exists third_party_pub;drop schema if exists public cascade;create schema public;drop schema if exists auth cascade;create schema auth;');
 for(const t of schema)await db.exec(`create table public.${t.identity}(${t.details.columns.map((c:any)=>`${c.name} ${c.type}`).join(',')})`);
 await db.exec(`
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function _assert_legal_cgv_role_for_user(r uuid,u uuid) returns void language plpgsql as $$begin if u is null then raise exception using errcode='28000';end if;if not exists(select 1 from public.restaurant_users where restaurant_id=r and user_id=u and role in('owner','manager')) then raise exception using errcode='42501';end if;end$$;
 create function cgv_completeness_errors(uuid) returns text[] language sql as $$select null::text[]$$;
 create function _resolve_applicable_cgv_template(uuid) returns public.cgv_template language sql as $$select * from public.cgv_template limit 1$$;
 create function _compute_cgv_publication_context_fingerprint(uuid) returns text language sql as $$select md5('context')$$;
 create table channel_flags(primitives boolean,platform boolean,switch boolean);
 insert into channel_flags values(true,false,true);
 create function _scanym_has_online_withdrawal_primitives() returns boolean language sql as $$select primitives from public.channel_flags$$;
 create function _scanym_has_operational_durable_ack_channel() returns boolean language sql as $$select platform from public.channel_flags$$;
 create function _scanym_has_online_withdrawal_runtime() returns boolean language sql as $$select public._scanym_has_online_withdrawal_primitives() and public._scanym_has_operational_durable_ack_channel()$$;
 create function scanym_ack_merchant_mailer_enabled() returns boolean language sql as $$select switch from public.channel_flags$$;
 create table merchant_email_provider_config(restaurant_id uuid,enabled boolean,last_test_at timestamptz,last_error_class text,secret_ciphertext text,secret_iv text,secret_auth_tag text);
 create table merchant_notification_profile(restaurant_id uuid,email_enabled boolean,sender_name text,sender_email text);
 create function _scanym_merchant_ack_channel_ready(p_restaurant_id uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.merchant_email_provider_config c join public.merchant_notification_profile p on p.restaurant_id=c.restaurant_id where c.restaurant_id=p_restaurant_id and c.enabled and c.secret_ciphertext is not null and c.secret_iv is not null and c.secret_auth_tag is not null and p.email_enabled and p.sender_name is not null and pg_catalog.btrim(p.sender_name)<>'' and p.sender_email is not null and pg_catalog.btrim(p.sender_email)<>'')$$;
 insert into restaurants(id,name,country) values('${A}','Shop A','FR'),('${B}','Shop B','FR');
 insert into restaurant_users values('${U}','${A}','owner',now());
 insert into merchant_legal_profile(restaurant_id,customer_service_email) values('${A}','contact@shop-a.test'),('${B}','contact@shop-b.test');
 insert into merchant_cgv_profile(restaurant_id,withdrawal_regime,profile_version,presentation_variant,status) values('${A}','MIXED',1,'FORMAL','CGV_ACTIVE'),('${B}','MIXED',1,'FORMAL','CGV_ACTIVE');
 insert into cgv_template(id,version,status,controlled_sections) values('${A}',7,'PUBLISHED','{"withdrawal_clauses":{"MIXED":"mixed clause"}}');
 insert into merchant_email_provider_config values('${A}',true,now(),null,'cipher','iv','tag'),('${B}',false,null,null,null,null,null);
 insert into merchant_notification_profile values('${A}',true,'Shop A','contact@shop-a.test'),('${B}',false,'Shop B','contact@shop-b.test');
 select set_config('test.uid','${U}',false);`);
 for(const r of baseline)await db.exec(r.definition);
 await db.exec('revoke all on function resolve_cgv_publication_context(uuid) from public;grant execute on function resolve_cgv_publication_context(uuid) to authenticated;revoke all on function persist_merchant_cgv_version(uuid,uuid,text,text,uuid) from public;grant execute on function persist_merchant_cgv_version(uuid,uuid,text,text,uuid) to service_role;');
 if(apply)await db.exec(install);
 return db;
}
const resolve=`select * from resolve_cgv_publication_context('${A}')`;
const persist=`select * from persist_merchant_cgv_version('${A}','${A}','L. 217-1 à L. 217-32 vices cachés trente jours',md5('context'),'${U}')`;
async function refused(db:PGlite,sql:string,re:RegExp){await assert.rejects(()=>db.exec(sql),re);await db.exec('rollback');}

test('RED witness: production predecessor blocks merchant-ready shop at resolve and persist',async()=>{const db=await fixture(false);await refused(db,resolve,/WITHDRAWAL_RUNTIME_NOT_READY/);await refused(db,persist,/WITHDRAWAL_RUNTIME_NOT_READY/);});
test('Merchant channel permits resolve/persist for its shop without changing legacy global guard',async()=>{const db=await fixture();assert.equal((await db.query<any>(resolve)).rows.length,1);await db.exec(persist);assert.equal((await db.query<any>('select count(*)::int as n from merchant_cgv_version')).rows[0].n,1);assert.equal((await db.query<any>('select _scanym_has_online_withdrawal_runtime() as ready')).rows[0].ready,false);assert.equal((await db.query<any>(`select _scanym_has_online_withdrawal_runtime_for_restaurant('${B}') as ready`)).rows[0].ready,false);});
for(const [name,mutation] of [
 ['switch off','update channel_flags set switch=false'],['primitives absent','update channel_flags set primitives=false'],
 ['provider disabled',`update merchant_email_provider_config set enabled=false where restaurant_id='${A}'`],
 ['missing secret',`update merchant_email_provider_config set secret_ciphertext=null where restaurant_id='${A}'`],
 ['email disabled',`update merchant_notification_profile set email_enabled=false where restaurant_id='${A}'`],
 ['missing sender',`update merchant_notification_profile set sender_name='' where restaurant_id='${A}'`],
 ['untested SMTP',`update merchant_email_provider_config set last_test_at=null where restaurant_id='${A}'`],
 ['provider error',`update merchant_email_provider_config set last_error_class='auth' where restaurant_id='${A}'`],
 ['missing merchant copy',`update merchant_legal_profile set customer_service_email=null where restaurant_id='${A}'`],
 ['invalid merchant copy',`update merchant_legal_profile set customer_service_email='bad' where restaurant_id='${A}'`],
 ['CRLF merchant copy',`update merchant_legal_profile set customer_service_email=E'contact@shop-a.test\\r\\nBcc:x@y.test' where restaurant_id='${A}'`],
] as const)test(`Both publication stages refuse ${name}`,async()=>{const db=await fixture();await db.exec(mutation);await refused(db,resolve,/WITHDRAWAL_RUNTIME_NOT_READY/);await refused(db,persist,/WITHDRAWAL_RUNTIME_NOT_READY/);assert.equal((await db.query<any>('select count(*)::int as n from merchant_cgv_version')).rows[0].n,0);});
test('Legacy platform supported; null and unknown tenant refused',async()=>{const db=await fixture();await db.exec('update channel_flags set platform=true,switch=false');assert.equal((await db.query<any>(resolve)).rows.length,1);for(const id of ['null',`'33333333-3333-4333-8333-333333333333'`])assert.equal((await db.query<any>(`select _scanym_has_online_withdrawal_runtime_for_restaurant(${id}) as ready`)).rows[0].ready,false);});
test('Auth, ownership, context and content guards remain effective',async()=>{const db=await fixture();await db.exec(`select set_config('test.uid','',false)`);await assert.rejects(()=>db.exec(resolve));await db.exec(`select set_config('test.uid','${U}',false)`);await assert.rejects(()=>db.exec(resolve.replace(A,B)));await refused(db,persist.replace("md5('context')","md5('stale')"),/STALE_CONTEXT/);await refused(db,persist.replace('L. 217-1 à L. 217-32 vices cachés trente jours','TODO'),/PLACEHOLDER_TEXT_DETECTED/);});
test('Helper private and manifest inaccessible directly',async()=>{const db=await fixture();for(const role of ['anon','authenticated','service_role']){const r=await db.query<any>(`select has_function_privilege('${role}','_scanym_has_online_withdrawal_runtime_for_restaurant(uuid)','execute') as fn,has_table_privilege('${role}','cgv_merchant_channel_guard_manifest','select') as tbl`);assert.deepEqual(r.rows[0],{fn:false,tbl:false});}});
test('Nominal rollback restores exact predecessors and reapplies',async()=>{const db=await fixture();await db.exec(rollback);for(const r of baseline)assert.equal((await db.query<any>(`select md5(prosrc) as hash from pg_proc where oid='public.${r.identity}'::regprocedure`)).rows[0].hash,r.source_md5);await db.exec(install);});
for(const [name,mutation] of [
 ['helper strict','alter function _scanym_has_online_withdrawal_runtime_for_restaurant(uuid) strict'],
 ['resolve grant','grant execute on function resolve_cgv_publication_context(uuid) to anon'],
 ['column comment',"comment on column cgv_merchant_channel_guard_manifest.originals is 'third party'"],
 ['extra constraint','alter table cgv_merchant_channel_guard_manifest add constraint third_party check(expected is not null)'],
 ['statistics','create statistics third_party_stats on originals,expected from cgv_merchant_channel_guard_manifest'],
 ['owned sequence','create sequence third_party_seq owned by cgv_merchant_channel_guard_manifest.id'],
 ['publication','create publication third_party_pub for table cgv_merchant_channel_guard_manifest'],
 ['consumer',"create function third_party() returns boolean language plpgsql as $$begin return public._scanym_has_online_withdrawal_runtime_for_restaurant(null);end$$"],
] as const)test(`Rollback refuses ${name} without catalog mutation`,async()=>{const db=await fixture();await db.exec(mutation);const before=await catalog(db);await refused(db,rollback,/SCANYM_ROLLBACK_DRIFT/);assert.deepEqual(await catalog(db),before);});
test('Install refuses modified predecessor without mutation',async()=>{const db=await fixture(false);await db.exec('alter function resolve_cgv_publication_context(uuid) security invoker');const before=await catalog(db);await refused(db,install,/SCANYM_PREDECESSOR_DRIFT/);assert.deepEqual(await catalog(db),before);});

// R2: guard and worker must agree on the exact addresses used by dispatch.

for(const address of ['a,b@example.com','a;b@example.com','a:b@example.com','a\\b@example.com','a(b)@example.com','a[b]@example.com',"a'b@example.com",'a"b@example.com','a<z>@example.com']){
 test(`R2 unsafe copy/sender ${JSON.stringify(address)} is refused like the worker`,async()=>{
  assert.equal(isSafeSmtpAddress(address),false);
  for(const [table,col] of [['merchant_legal_profile','customer_service_email'],['merchant_notification_profile','sender_email']]){
   const db=await fixture();await db.query(`update ${table} set ${col}=$1 where restaurant_id=$2`,[address,A]);
   await refused(db,resolve,/WITHDRAWAL_RUNTIME_NOT_READY/);await refused(db,persist,/WITHDRAWAL_RUNTIME_NOT_READY/);
  }
 });
}
test('R2 merchant selected: ready platform never bypasses a broken merchant channel',async()=>{const db=await fixture();await db.exec(`update channel_flags set platform=true;update merchant_email_provider_config set enabled=false where restaurant_id='${A}'`);await refused(db,resolve,/WITHDRAWAL_RUNTIME_NOT_READY/);await refused(db,persist,/WITHDRAWAL_RUNTIME_NOT_READY/);});
for(const [name,ddl] of [['all tables','create publication third_party_pub for all tables'],['schema','create publication third_party_pub for tables in schema public']] as const){
 test(`R2 rollback refuses publication ${name} without mutation`,async()=>{const db=await fixture();await db.exec(ddl);const before=await catalog(db);await refused(db,rollback,/SCANYM_ROLLBACK_DRIFT/);assert.deepEqual(await catalog(db),before);});
}
test('R2 oracle detects committed column mutation even after the expected error',async()=>{const db=await fixture();const before=await catalog(db);await db.exec('begin;alter table cgv_merchant_channel_guard_manifest alter column expected set statistics 500;commit;');await assert.rejects(()=>db.exec("do $$begin raise exception 'SCANYM_ROLLBACK_DRIFT';end$$"),/SCANYM_ROLLBACK_DRIFT/);assert.notDeepEqual(await catalog(db),before);});
test('R2 differential corpus agrees with real worker including trim, controls, Unicode and UTF16 limit',async()=>{
 const db=await fixture();
 const cases=['valid+tag@example.test',' contact@example.test\t','\ufeffcontact@example.test\ufeff','a\u0085b@example.test','a\u2003b@example.test','é@example.test','🚀@example.test','a'.repeat(241)+'@example.test','a'.repeat(242)+'@example.test','🚀'.repeat(124)+'@ex.test','🚀'.repeat(121)+'@ex.test','a@example.x','a@example.12','a@b@example.test',''];
 for(let i=1;i<128;i++)cases.push(`a${String.fromCharCode(i)}b@example.test`);
 for(const address of cases){
  const expected=isSafeSmtpAddress(address.trim());
  for(const [table,col] of [['merchant_legal_profile','customer_service_email'],['merchant_notification_profile','sender_email']]){
   await db.query(`update ${table} set ${col}=$1 where restaurant_id=$2`,[address,A]);
   const ready=(await db.query<{ready:boolean}>(`select public._scanym_has_online_withdrawal_runtime_for_restaurant($1) as ready`,[A])).rows[0].ready;
   assert.equal(ready,expected,`${table} worker mismatch for ${JSON.stringify(address)}`);
   await db.query(`update ${table} set ${col}='contact@example.test' where restaurant_id=$1`,[A]);
  }
 }
});
test('R2 channel matrix follows dispatcher for every switch/platform/merchant combination',async()=>{
 const db=await fixture();
 for(const selected of [false,true])for(const platform of [false,true])for(const ready of [false,true]){
  await db.query('update channel_flags set switch=$1,platform=$2',[selected,platform]);
  await db.query('update merchant_email_provider_config set enabled=$1 where restaurant_id=$2',[ready,A]);
  const actual=(await db.query<{ready:boolean}>(`select public._scanym_has_online_withdrawal_runtime_for_restaurant($1) as ready`,[A])).rows[0].ready;
  assert.equal(actual,selected?ready:platform,JSON.stringify({selected,platform,ready}));
 }
});
test('Existing v7 form placeholder block is reproduced unchanged on predecessor and candidate',async()=>{
 const lot=readFileSync('supabase/DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql','utf8');
 const match=lot.match(/"withdrawal_model_form_text":\s*("(?:[^"\\]|\\.)*")/);
 assert.ok(match);const form=JSON.parse(match[1]);assert.ok(form.includes('à compléter'));
 for(const apply of [false,true]){
  const db=await fixture(apply);await db.exec('update channel_flags set platform=true');
  await refused(db,persist.replace('L. 217-1 à L. 217-32 vices cachés trente jours',`L. 217-1 à L. 217-32 vices cachés trente jours ${form.replaceAll("'","''")}`),/PLACEHOLDER_TEXT_DETECTED/);
 }
});
