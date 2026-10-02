import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { makeBaseline,readSql,coSig,resSig,migrationFile,rollbackFile } from './bootstrap.mjs';

let db, baselineCo, baselineRes;
const one=async(sql,params=[]) => (await db.query(sql,params)).rows[0];
const def=sig=>one('select pg_get_functiondef($1::regprocedure) as def',[sig]).then(r=>r.def);
const noColumns=async()=>{
  assert.equal((await one(`select count(*) as n from information_schema.columns where table_schema='public'
    and table_name in ('restaurant_sale_mode_fulfillments','order_delivery_fulfillment_snapshot')
    and column_name like 'discount_%'`)).n,0);
};
before(async()=>{db=await makeBaseline();baselineCo=await def(coSig);baselineRes=await def(resSig);},{timeout:120000});
after(async()=>{if(db) await db.close();});

test('Migration rejects checkout drift before DDL',async()=>{
  const changed=baselineCo.replace('  v_subtotal    numeric(12,2) := 0;', '  v_subtotal    numeric(12,2) := 1;');
  assert.notEqual(changed,baselineCo);
  try {
    await db.exec(changed);
    await assert.rejects(()=>db.exec(readSql(migrationFile)),/SCANYM_SCHEMA_DRIFT/);
    await db.exec('rollback'); await noColumns(); assert.equal(await def(coSig),changed);
  } finally {await db.exec(baselineCo);}
});
test('Migration rejects resolver drift before DDL',async()=>{
  const changed=baselineRes.replace("s.pricing_mode = 'free' then 0","s.pricing_mode = 'free' then 1");
  assert.notEqual(changed,baselineRes);
  try {
    await db.exec(changed);
    await assert.rejects(()=>db.exec(readSql(migrationFile)),/SCANYM_SCHEMA_DRIFT/);
    await db.exec('rollback');await noColumns();assert.equal(await def(resSig),changed);
  } finally {await db.exec(baselineRes);}
});
test('Failure after replacing resolver but before patching B1-A-01 rolls back ALL DDL',async()=>{
  const sql=readSql(migrationFile).replace('do $b5_patch$',"do $inject$ begin raise exception 'B5_TEST_ABORT'; end $inject$;\ndo $b5_patch$");
  assert.notEqual(sql,readSql(migrationFile));
  await assert.rejects(()=>db.exec(sql),/B5_TEST_ABORT/); await db.exec('rollback');
  await noColumns(); assert.equal(await def(coSig),baselineCo); assert.equal(await def(resSig),baselineRes);
});
test('Migration rejects a second checkout overload',async()=>{
  await db.exec('create function public.create_order(integer) returns integer language sql as $$ select $1 $$');
  try {
    await assert.rejects(()=>db.exec(readSql(migrationFile)),/SCANYM_SCHEMA_DRIFT/);
    await db.exec('rollback');await noColumns();
  } finally {await db.exec('drop function public.create_order(integer)');}
});
test('CRLF baseline and CRLF migration apply atomically; rollback preserves the exact normalized B1 body',async()=>{
  // Match the live B1 SQL body line endings observed in read-only verification.
  const crlf=baselineCo.replace(/AS \$function\$([\s\S]*)\$function\$/,(_,body)=>
    'AS $function$'+body.replaceAll('\n','\r\n')+'$function$');
  await db.exec(crlf);
  assert.equal((await one('select md5(pg_get_functiondef($1::regprocedure)) as md5',[coSig])).md5,'5e7ffb5e0fd6cad6aeef8ee7db3e7114');
  await db.exec(readSql(migrationFile).replaceAll('\n','\r\n'));
  assert.equal((await one(`select count(*) as n from information_schema.columns where table_schema='public'
    and table_name in ('restaurant_sale_mode_fulfillments','order_delivery_fulfillment_snapshot')
    and column_name like 'discount_%'`)).n,5);
  await db.exec(readSql(rollbackFile).replaceAll('\n','\r\n'));
  assert.equal(await def(coSig),baselineCo); assert.equal((await def(resSig)).replaceAll('\r\n','\n'),baselineRes);
});
