import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeliveryDb, sqlFile } from '../supabase/tests/b234-bootstrap.mjs';

const db=await makeDeliveryDb();
after(()=>db.close());
const forward=sqlFile('migrations/20260930173129_delivery_pricing_b234.sql');
const rollback=sqlFile('ROLLBACK-delivery-pricing-b234.sql');
const A='00000000-0000-4000-8000-000000000901';
const snapshot=async()=>({
  functions:(await db.query(`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition,p.proacl::text acl,pg_get_userbyid(p.proowner) owner,obj_description(p.oid,'pg_proc') description
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','scanym_internal','auth') and p.prokind='f' order by 1,2,p.oid`)).rows,
  triggers:(await db.query(`select tgname,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by tgname`)).rows,
  schemas:(await db.query(`select nspname,nspacl::text from pg_namespace where nspname='scanym_internal'`)).rows,
  data:(await db.query('select to_jsonb(f) r from restaurant_sale_mode_fulfillments f order by id')).rows,
});

test('B234 rollback preserves the original schema inventory on first installation',async()=>{
  const before=await snapshot();await db.exec(forward);await db.exec(rollback);assert.deepEqual(await snapshot(),before);
});

test('B234 preflight rejects each missing dependency before even an attempted DDL',async()=>{
  // Event trigger raises on any DDL. A dependency failure must precede it,
  // rather than relying on transaction rollback to hide earlier DDL.
  for(const damage of [
    'alter table restaurant_sale_mode_fulfillments drop column customer_text_hash',
    'alter table restaurant_sale_mode_fulfillments drop column translations',
    'alter table restaurant_sale_modes rename column config to missing_config',
    'alter function public.is_scanym_operator() rename to missing_operator',
    'alter table restaurant_delivery_countries rename column country_code to missing_country',
  ]) {
    await db.exec('begin'); await db.exec(damage);
    await db.exec(`create function public.forbid_b234_ddl() returns event_trigger language plpgsql as $$begin raise exception 'DDL_WAS_ATTEMPTED'; end$$;
      create event trigger forbid_b234_ddl on ddl_command_start execute function public.forbid_b234_ddl();`);
    await assert.rejects(()=>db.exec(forward.replace(/^begin;$/m,'')),/B234_DEPENDENCY/,damage);
    await db.exec('rollback');
  }
});

test('B234 existing invalid config fails before DDL with tenant, slug, rule and B0 blocker',async()=>{
  await db.exec(`insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Invalid fixture','invalid-b234','active',true,'FR');
    insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${A}','pickup',true,'{}');
    insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR');
    insert into restaurant_sale_mode_fulfillments(restaurant_id,mode_code,fulfillment_code,provider,zone_prefixes,display_order,pricing_mode,fixed_fee)
      values ('${A}','delivery','Invalid','internal','{}',0,'fixed',5);`);
  await db.exec(`create function public.forbid_b234_ddl() returns event_trigger language plpgsql as $$begin raise exception 'DDL_WAS_ATTEMPTED'; end$$;
    create event trigger forbid_b234_ddl on ddl_command_start execute function public.forbid_b234_ddl();`);
  await assert.rejects(()=>db.exec(forward),(e:any)=>{
    assert.match(e.message,/B234_INVALID_ZONES/);const detail=JSON.parse(e.detail);
    assert.equal(detail.restaurant_id,A);assert.equal(detail.slug,'invalid-b234');
    assert.ok(detail.blockers.some((b:any)=>b.ruleId&&b.code==='ZV-EMPTY-ZONES'));return true;
  });
  await db.exec('rollback');
  await db.exec(`alter event trigger forbid_b234_ddl disable;
    update restaurant_sale_mode_fulfillments set zone_prefixes=array['75'] where restaurant_id='${A}';
    insert into restaurant_sale_mode_fulfillments(restaurant_id,mode_code,fulfillment_code,provider,zone_prefixes,display_order,pricing_mode,fixed_fee)
      values ('${A}','delivery','Covered','internal',array['7501'],1,'fixed',5);
    alter event trigger forbid_b234_ddl enable;`);
  await assert.rejects(()=>db.exec(forward),(e:any)=>{
    assert.match(e.message,/B234_INVALID_ZONES/);const detail=JSON.parse(e.detail);
    assert.equal(detail.restaurant_id,A);
    assert.ok(detail.blockers.some((b:any)=>b.ruleId&&b.zone==='7501'&&b.code==='ZV-COVERED-BY-HIGHER'));return true;
  });
  await db.exec('rollback');
  await db.exec('alter event trigger forbid_b234_ddl disable; drop event trigger forbid_b234_ddl; drop function public.forbid_b234_ddl();');
});

test('B234 pickup and metadata edits do not validate delivery, meaningful mode/country changes do',async()=>{
  // Install while dormant, then simulate a historical invalid enabled state
  // using the privileged fixture connection with triggers temporarily disabled.
  await db.exec(`update restaurant_sale_modes set enabled=false where restaurant_id='${A}' and mode_code='delivery'`);
  await db.exec(forward);
  await db.exec(`alter table restaurant_sale_modes disable trigger b234_check_modes;
    update restaurant_sale_modes set enabled=true where restaurant_id='${A}' and mode_code='delivery';
    alter table restaurant_sale_modes enable trigger b234_check_modes;`);
  await db.exec(`update restaurant_sale_modes set enabled=false where restaurant_id='${A}' and mode_code='pickup';
    update restaurant_sale_modes set config='{"notice":"unchanged delivery semantics"}' where restaurant_id='${A}' and mode_code='delivery';
    update restaurant_delivery_countries set country_code=country_code where restaurant_id='${A}';`);
  await assert.rejects(()=>db.exec(`begin; update restaurant_sale_modes set enabled=false where restaurant_id='${A}' and mode_code='delivery';
    update restaurant_sale_modes set enabled=true where restaurant_id='${A}' and mode_code='delivery'; commit;`),/B234_INVALID_ZONES/);
  await db.exec('rollback');
  await assert.rejects(()=>db.exec(`insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','BE')`),/B234_INVALID_ZONES/);
  await db.exec(rollback);
});

test('B234 forward/rollback restores exact predecessor definition, ACL, other objects and business data',async()=>{
  await db.exec(`update restaurant_sale_mode_fulfillments set zone_prefixes=case when display_order=0 then array['75'] else array['92'] end where restaurant_id='${A}'`);
  // Test both installed predecessor variants: operator read and translations read.
  for(const translations of [false,true]) {
    if(translations) {
      const source=sqlFile('DRAFT-lot-translations-management-v2.sql');
      await db.exec(source.slice(source.indexOf('drop function if exists public.get_merchant_delivery_fulfillment_pricing(uuid);'),source.indexOf('grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;')+'grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;'.length));
    }
    const before=await snapshot();
    await db.exec(forward);await db.exec(rollback);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await db.query(`select proname from pg_proc where proname in ('mutate_merchant_delivery_rule','test_merchant_delivery_postcode','preview_merchant_delivery_rule_save')`)).rows.length,0);
    assert.equal((await db.query(`select tgname from pg_trigger where tgname like 'b234_%'`)).rows.length,0);
    assert.equal((await db.query<{r:string|null}>(`select to_regclass('scanym_internal.b234_predecessor') r`)).rows[0].r,null);
  }
});
