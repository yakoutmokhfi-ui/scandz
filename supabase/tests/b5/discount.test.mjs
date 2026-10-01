import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { makeBaseline, readSql, coSig, resSig, migrationFile, rollbackFile } from './bootstrap.mjs';

let db, restaurantA, restaurantB, ruleA, ruleB, itemA, itemB;
let oldOrder, oldSnapshot, oldResolver, oldCheckout, newResolver, newCheckout, oldAcl;
let baselineCases;
const ownerA = 'b5000000-0000-0000-0000-000000000001';
const ownerB = 'b5000000-0000-0000-0000-000000000002';
const customer = { first_name: 'Ada', last_name: 'Lovelace', phone: '0612345678',
  email: 'ada@example.test', address: '1 rue Test, 75001 Paris', postalCode: '75001',
  street: '1 rue Test', city: 'Paris', country: 'FR' };
const one = async (sql, params=[], conn=db) => (await conn.query(sql, params)).rows[0];
const definition = sig => one('select pg_get_functiondef($1::regprocedure) as def', [sig]).then(r=>r.def);
const stats = () => one(`select (select count(*) from orders) as orders,
  (select count(*) from order_items) as items,
  (select count(*) from order_delivery_address) as addresses,
  (select count(*) from order_delivery_fulfillment_snapshot) as snapshots,
  (select count(*) from notification_outbox) as notifications,
  (select sum(next_order_number) from restaurant_configs) as next_number`);
const checkout = async ({ slug='b5-a', item=itemA, mode='delivery', extra={} }={}) =>
  db.transaction(async tx => {
    await tx.exec('set local role anon');
    return one(`select order_id, subtotal::text, delivery_fee::text, total::text
      from public.create_order($1,$2,$3::jsonb,null,$4::jsonb,null,'fr',false)`,
    [slug, mode, JSON.stringify([{menu_item_id:item,quantity:1}]), JSON.stringify({...customer,...extra})], tx);
  });
const snapshot = id => one('select * from order_delivery_fulfillment_snapshot where order_id=$1', [id]);
const config = async ({enabled=true, threshold='100', percentage='50', fee='6.90',
  mode='fixed', freeThreshold=null, price='100', rule=ruleA, item=itemA}={}) => {
  await db.query(`update restaurant_sale_mode_fulfillments set pricing_mode=$2,
    fixed_fee=$3, free_threshold=$4, discount_enabled=$5,
    discount_threshold=$6, discount_percentage=$7 where id=$1`,
  [rule,mode,fee,freeThreshold,enabled,threshold,percentage]);
  await db.query('update menu_items set price=$2 where id=$1', [item,price]);
};
const resolve = (rid, subtotal, postal='75001') => one(`select * from
  public.resolve_delivery_fulfillment($1,'delivery',$2,1,$3)`, [rid,postal,subtotal]);
const assertRollback = async (action, pattern=/SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT/) => {
  const before = await stats();
  await assert.rejects(action, pattern);
  assert.deepEqual(await stats(), before, 'the whole checkout transaction must roll back');
};

before(async () => {
  db = await makeBaseline();
  console.log('ENGINE', (await one('select version() as version')).version);
  oldResolver = await definition(resSig);
  oldCheckout = await definition(coSig);
  assert.equal((await one('select md5(pg_get_functiondef($1::regprocedure)) as md5',[coSig])).md5,
    '9de8eb2349d7ee5e1b28c3681739c717');
  assert.equal((await one('select md5(pg_get_functiondef($1::regprocedure)) as md5',[resSig])).md5,
    '0277502f9f1647d6866b2b1d5fd2a994');
  oldAcl = await one('select proacl::text as acl, pg_get_function_arguments(oid) as args from pg_proc where oid=$1::regprocedure',[coSig]);
  await db.exec(`grant usage on schema public, auth to anon,authenticated,service_role;
    insert into auth.users(id,email) values ('${ownerA}','a@b5.test'),('${ownerB}','b@b5.test');
    insert into restaurants(name,slug,status,is_active,country) values
      ('B5 A','b5-a','active',true,'FR'),('B5 B','b5-b','active',true,'FR');
    insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number)
      select id,'+33600000000','EUR',1 from restaurants where slug like 'b5-%';
    insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config)
      select id,'delivery',true,'{}' from restaurants where slug like 'b5-%';
    insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config)
      select id,'pickup',true,'{}' from restaurants where slug like 'b5-%';
    insert into restaurant_delivery_countries(restaurant_id,country_code)
      select id,'FR' from restaurants where slug like 'b5-%';
    insert into restaurant_sale_mode_fulfillments(restaurant_id,mode_code,fulfillment_code,
      provider,enabled,display_order,zone_prefixes,is_fallback,pricing_mode,fixed_fee)
      select id,'delivery','local','internal',true,1,array['75'],false,'fixed',6.90
      from restaurants where slug like 'b5-%';`);
  restaurantA = (await one("select id from restaurants where slug='b5-a'")).id;
  restaurantB = (await one("select id from restaurants where slug='b5-b'")).id;
  ruleA = (await one('select id from restaurant_sale_mode_fulfillments where restaurant_id=$1',[restaurantA])).id;
  ruleB = (await one('select id from restaurant_sale_mode_fulfillments where restaurant_id=$1',[restaurantB])).id;
  for (const [rid, uid] of [[restaurantA,ownerA],[restaurantB,ownerB]]) {
    await db.query("insert into restaurant_users(restaurant_id,user_id,role) values($1,$2,'owner')",[rid,uid]);
    const cat = (await one("insert into menu_categories(restaurant_id,name,display_order) values($1,'B5',1) returning id",[rid])).id;
    const id = (await one("insert into menu_items(category_id,name,price,is_available,display_order) values($1,'B5 item',100,true,1) returning id",[cat])).id;
    if (rid===restaurantA) itemA=id; else itemB=id;
  }
  oldOrder=await checkout(); oldSnapshot=await snapshot(oldOrder.order_id);
  // Capture pre-migration output of the real resolver across the old fixture
  // corpus, including missing postcode, fallback, minimum and null subtotal.
  const fixtures = JSON.parse(readSql('../tests/fixtures/delivery-pricing-cases.json')).cases;
  baselineCases=[];
  for(const c of fixtures) {
    const r=c.rule;
    await db.query(`update restaurant_sale_mode_fulfillments set enabled=$2,
      fulfillment_code=$3, zone_prefixes=$4, is_fallback=$5, min_items=$6,
      pricing_mode=$7, fixed_fee=$8, free_threshold=$9 where id=$1`,
    [ruleA,!c.noRuleMatched,r.fulfillmentCode,r.zonePrefixes,r.isFallback,r.minItems,r.pricingMode,r.fixedFee,r.freeThreshold]);
    const result=await one('select * from public.resolve_delivery_fulfillment($1,\'delivery\',$2,$3,$4)',
      [restaurantA,c.postalCode,c.totalCount,c.subtotal]);
    baselineCases.push({c,result});
  }
  await db.query(`update restaurant_sale_mode_fulfillments set enabled=true,
    fulfillment_code='local',zone_prefixes=array['75'],is_fallback=false,min_items=null,
    pricing_mode='fixed',fixed_fee=6.90,free_threshold=null where id=$1`,[ruleA]);
  await db.exec(readSql(migrationFile));
  newResolver=await definition(resSig); newCheckout=await definition(coSig);
}, {timeout:120000});
after(async()=>{ if(db) await db.close(); });
beforeEach(async()=>{ await config(); });

test('B5 migration preserves the historical B1 v1 snapshot without backfill', async()=>{
  const after=await snapshot(oldOrder.order_id);
  const {discount_threshold,discount_percentage,...facts}=after;
  assert.deepEqual(facts,oldSnapshot);
  assert.equal(discount_threshold,null); assert.equal(discount_percentage,null);
  assert.equal((await one('select delivery_fee::text as fee from orders where id=$1',[oldOrder.order_id])).fee,'6.90');
});

test('No discount: every existing resolver fixture is byte-for-byte equivalent on the original 16 fields',async()=>{
  try {
    for(const {c,result} of baselineCases) {
      const r=c.rule;
      await db.query(`update restaurant_sale_mode_fulfillments set enabled=$2,
        fulfillment_code=$3,zone_prefixes=$4,is_fallback=$5,min_items=$6,
        pricing_mode=$7,fixed_fee=$8,free_threshold=$9,
        discount_enabled=false,discount_threshold=null,discount_percentage=null where id=$1`,
      [ruleA,!c.noRuleMatched,r.fulfillmentCode,r.zonePrefixes,r.isFallback,r.minItems,r.pricingMode,r.fixedFee,r.freeThreshold]);
      const actual=await one('select * from public.resolve_delivery_fulfillment($1,\'delivery\',$2,$3,$4)',
        [restaurantA,c.postalCode,c.totalCount,c.subtotal]);
      const {discount_enabled,discount_threshold,discount_percentage,...original}=actual;
      assert.deepEqual(original,result,c.id);
    }
  } finally {
    await db.query(`update restaurant_sale_mode_fulfillments set enabled=true,
      fulfillment_code='local',zone_prefixes=array['75'],is_fallback=false,min_items=null where id=$1`,[ruleA]);
  }
});

const cases = [
  ['6.90 / 50%',{},'3.45'], ['10.90 / 50%',{fee:'10.90'},'5.45'],
  ['13.90 / 50%',{fee:'13.90'},'6.95'], ['15.90 / 50%',{fee:'15.90'},'7.95'],
  ['18.90 / 50%',{fee:'18.90'},'9.45'],
  ['just below threshold',{price:'99.99'},'6.90'],
  ['exactly at threshold',{price:'100.00'},'3.45'],
  ['above threshold',{price:'100.01'},'3.45'],
  ['other merchant policy 60 / 20%',{threshold:'60',percentage:'20',price:'60'},'5.52'],
  ['other policy below threshold',{threshold:'60',percentage:'20',price:'59.99'},'6.90'],
  ['zero percent',{percentage:'0'},'6.90'],
  ['100 percent',{percentage:'100'},'0.00'],
  ['zero threshold and zero basket',{threshold:'0',price:'0'},'3.45'],
  ['zero base fee',{fee:'0'},'0.00'],
  ['half-cent rounds up',{fee:'0.01'},'0.01'],
  ['1.005 rounds up',{fee:'2.01'},'1.01'],
  ['two-digit percentage',{fee:'10',percentage:'33.33'},'6.67'],
  ['discount disabled retains full fee',{enabled:false},'6.90'],
  ['no configured policy',{enabled:false,threshold:null,percentage:null},'6.90'],
  ['no policy, free mode',{enabled:false,threshold:null,percentage:null,mode:'free',fee:null},'0.00'],
  ['no policy, base free threshold below',{enabled:false,threshold:null,percentage:null,mode:'free_above_threshold',freeThreshold:'100.01'},'6.90'],
  ['no policy, base free threshold equal',{enabled:false,threshold:null,percentage:null,mode:'free_above_threshold',freeThreshold:'100'},'0.00'],
  ['free mode',{mode:'free',fee:null},'0.00'],
  ['base free threshold not reached',{mode:'free_above_threshold',freeThreshold:'120'},'3.45'],
  ['base free threshold exactly reached',{mode:'free_above_threshold',freeThreshold:'100'},'0.00'],
  ['base free threshold already passed',{mode:'free_above_threshold',freeThreshold:'90'},'0.00'],
];
for(const [name,options,expected] of cases) test(`B5 checkout: ${name}`,async()=>{
  await config(options);
  const row=await checkout();
  assert.equal(row.delivery_fee,expected);
  const resolved=await resolve(restaurantA,options.price??'100');
  assert.equal(Number(resolved.delivery_fee),Number(expected));
  assert.equal((await one('select total=subtotal+delivery_fee as ok from orders where id=$1',[row.order_id])).ok,true);
  const snap=await snapshot(row.order_id);
  assert.equal(snap.snapshot_method_version,options.enabled===false?'v1':'v2');
  assert.equal(snap.discount_threshold,options.enabled===false?null:(options.threshold??'100'));
  assert.equal(snap.discount_percentage,options.enabled===false?null:(options.percentage??'50'));
});

for(const [field,values] of [
  ['discount_percentage',['-1','-0.001','100.001','101','NaN','Infinity','-Infinity','50.001']],
  ['discount_threshold',['-1','-0.001','100000000','NaN','Infinity','-Infinity','0.001']],
]) for(const value of values) test(`DB rejects ${field}=${value}`,async()=>{
  await assert.rejects(()=>db.query(`update restaurant_sale_mode_fulfillments set ${field}=$1 where id=$2`,[value,ruleA]),e=>e.code==='23514');
});
for(const field of ['discount_percentage','discount_threshold']) test(`Enabled discount rejects NULL ${field}`,async()=>{
  await assert.rejects(()=>db.query(`update restaurant_sale_mode_fulfillments set ${field}=null where id=$1`,[ruleA]),e=>e.code==='23514');
});
test('Disabled policy rejects half-configured or invalid dormant values',async()=>{
  await assert.rejects(()=>config({enabled:false,threshold:null}),e=>e.code==='23514');
  await assert.rejects(()=>config({enabled:false,percentage:'101'}),e=>e.code==='23514');
});

test('Historical v2 facts survive rule edits, disabling, deletion and personal-data purge',async()=>{
  const order=await checkout(); const initial=await snapshot(order.order_id);
  await config({enabled:false,threshold:'60',percentage:'20',fee:'18.90'});
  assert.deepEqual(await snapshot(order.order_id),initial);
  await db.exec('begin');
  try {
    await db.query('delete from restaurant_sale_mode_fulfillments where id=$1',[ruleA]);
    assert.deepEqual(await snapshot(order.order_id),initial);
    assert.equal((await one('select fulfillment_rule_id from orders where id=$1',[order.order_id])).fulfillment_rule_id,null);
    await db.exec('select public.purge_old_customer_data(0)');
    assert.deepEqual(await snapshot(order.order_id),initial);
  } finally { await db.exec('rollback'); }
});
test('Policy edit between resolution and snapshot does not mix old fees with new configuration',async()=>{
  // Deterministic interleaving inside checkout, not a multi-session load test.
  await db.exec(`create function b5_test_edit_policy() returns trigger language plpgsql as $$
    begin update public.restaurant_sale_mode_fulfillments
      set discount_threshold=60,discount_percentage=20 where id=NEW.fulfillment_rule_id;
      return NEW; end $$;
    create trigger b5_test_edit_policy before update of delivery_fee on orders
      for each row execute function b5_test_edit_policy();`);
  try {
    const row=await checkout();const snap=await snapshot(row.order_id);
    assert.equal(row.delivery_fee,'3.45');assert.equal(snap.discount_percentage,'50');
    assert.equal(snap.discount_threshold,'100');
    assert.equal((await one('select discount_percentage from restaurant_sale_mode_fulfillments where id=$1',[ruleA])).discount_percentage,'20');
  } finally {await db.exec('drop trigger b5_test_edit_policy on orders; drop function b5_test_edit_policy()');}
});
test('A second tenant has its own policy and cannot alter or read tenant A facts',async()=>{
  await config({rule:ruleB,item:itemB,threshold:'60',percentage:'20',price:'60'});
  const a=await checkout(), b=await checkout({slug:'b5-b',item:itemB});
  assert.equal(a.delivery_fee,'3.45'); assert.equal(b.delivery_fee,'5.52');
  const readAs = async uid=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('test.uid',$1,true)",[uid]);
    return (await tx.query('select order_id from order_delivery_fulfillment_snapshot where order_id=$1',[a.order_id])).rows;
  });
  assert.equal((await readAs(ownerA)).length,1); assert.equal((await readAs(ownerB)).length,0);
  await assert.rejects(()=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('test.uid',$1,true)",[ownerB]);
    await tx.query('update restaurant_sale_mode_fulfillments set discount_percentage=100 where id=$1',[ruleA]);
  }),e=>e.code==='42501');
});
for(const role of ['anon','authenticated','service_role']) {
  test(`Internal resolver denied to ${role}`,async()=>{
    await assert.rejects(()=>db.transaction(async tx=>{
      await tx.exec(`set local role ${role}`);
      await tx.query("select * from public.resolve_delivery_fulfillment($1,'delivery','75001',1,100)",[restaurantA]);
    }),e=>e.code==='42501');
  });
  test(`Snapshot writes denied to ${role}`,async()=>{
    await assert.rejects(()=>db.transaction(async tx=>{
      await tx.exec(`set local role ${role}`);
      await tx.query('update order_delivery_fulfillment_snapshot set discount_percentage=100 where order_id=$1',[oldOrder.order_id]);
    }),e=>e.code==='42501');
  });
}
test('Client-supplied fee and discount facts have no authority',async()=>{
  const row=await checkout({extra:{delivery_fee:0,deliveryFee:0,discount_enabled:true,
    discount_percentage:100,discount_threshold:0,pricing_mode:'free',subtotal:999999}});
  assert.equal(row.delivery_fee,'3.45');
  const snap=await snapshot(row.order_id); assert.equal(snap.discount_percentage,'50');
});
test('Cross-tenant cart item is refused atomically',async()=>{
  await assertRollback(()=>checkout({item:itemB}),/./);
});
test('Pickup and legacy deliveries still have no snapshot',async()=>{
  const pickup=await checkout({mode:'pickup'});
  assert.equal(pickup.delivery_fee,'0.00'); assert.equal(await snapshot(pickup.order_id),undefined);
  await db.exec('begin');
  try {
    await db.query('update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id=$1',[restaurantA]);
    await db.query(`update restaurant_sale_modes set config='{"delivery_zone_prefixes":["75"]}' where restaurant_id=$1 and mode_code='delivery'`,[restaurantA]);
    // Call directly in this transaction; the normal wrapper starts its own.
    const row=await one(`select * from public.create_order('b5-a','delivery',$1::jsonb,null,$2::jsonb,null,'fr',false)`,
      [JSON.stringify([{menu_item_id:itemA,quantity:1}]),JSON.stringify(customer)]);
    assert.equal(row.delivery_fee,'0.00'); assert.equal(await snapshot(row.order_id),undefined);
  } finally { await db.exec('rollback'); }
});
test('Fallback routing still applies the selected rule discount',async()=>{
  await db.exec('begin');
  try {
    await db.query('update restaurant_sale_mode_fulfillments set is_fallback=true,zone_prefixes=array[]::text[] where id=$1',[ruleA]);
    const row=await one(`select * from public.create_order('b5-a','delivery',$1::jsonb,null,$2::jsonb,null,'fr',false)`,
      [JSON.stringify([{menu_item_id:itemA,quantity:1}]),JSON.stringify({...customer,postalCode:'69001',city:'Lyon'})]);
    assert.equal(row.delivery_fee,'3.45'); const snap=await snapshot(row.order_id);
    assert.equal(snap.is_fallback,true); assert.equal(snap.matched_prefix,null);
  } finally { await db.exec('rollback'); }
});
test('Unknown pricing vocabulary is accepted by snapshot schema but checkout fails closed even at zero',async()=>{
  await db.exec('begin');
  try {
    await db.query("update order_delivery_fulfillment_snapshot set pricing_mode='future_tariff' where order_id=$1",[oldOrder.order_id]);
    assert.equal((await snapshot(oldOrder.order_id)).pricing_mode,'future_tariff');
  } finally {await db.exec('rollback');}
  const mutated=newResolver.replace('s.pricing_mode,\n    s.fixed_fee,',"'future_tariff'::text as pricing_mode,\n    s.fixed_fee,");
  assert.notEqual(mutated,newResolver);
  try { await config({percentage:'100'}); await db.exec(mutated); await assertRollback(()=>checkout()); }
  finally { await db.exec(newResolver); }
});
test('Mutation: changing only resolver percentage formula aborts checkout and all side effects',async()=>{
  const mutated=newResolver.replaceAll('1 - s.discount_percentage / 100','1 - s.discount_percentage / 200');
  assert.notEqual(mutated,newResolver);
  try { await db.exec(mutated); await assertRollback(()=>checkout()); }
  finally { await db.exec(newResolver); }
});
test('Mutation: changing only B1-A-01 percentage formula aborts checkout and all side effects',async()=>{
  const mutated=newCheckout.replace('1 - v_resolved.discount_percentage / 100','1 - v_resolved.discount_percentage / 200');
  assert.notEqual(mutated,newCheckout);
  try { await db.exec(mutated); await assertRollback(()=>checkout()); }
  finally { await db.exec(newCheckout); }
});
test('Mutation: sub-cent resolver drift is rejected before numeric(12,2) coercion can conceal it',async()=>{
  const mutated=newResolver.replace('end as delivery_fee,','end + 0.001 as delivery_fee,');
  assert.notEqual(mutated,newResolver);
  try { await db.exec(mutated); await assertRollback(()=>checkout()); }
  finally { await db.exec(newResolver); }
});
test('Mutation: resolver uses strict > threshold while B1-A-01 uses >=; equality checkout fails',async()=>{
  const mutated=newResolver.replace('coalesce(p_subtotal, 0) >= s.discount_threshold','coalesce(p_subtotal, 0) > s.discount_threshold');
  assert.notEqual(mutated,newResolver);
  try {await db.exec(mutated);await assertRollback(()=>checkout());}
  finally {await db.exec(newResolver);}
});
test('Mutation: removing B5 from B1-A-01 catches discounted resolver output',async()=>{
  try { await db.exec(oldCheckout); await assertRollback(()=>checkout()); }
  finally {await db.exec(newCheckout);}
});
test('Checkout signature, defaults, ACL and single overload are unchanged',async()=>{
  assert.deepEqual(await one('select proacl::text as acl, pg_get_function_arguments(oid) as args from pg_proc where oid=$1::regprocedure',[coSig]),oldAcl);
  assert.equal((await one("select count(*) as n from pg_proc where pronamespace='public'::regnamespace and proname='create_order'")).n,1);
});
test('Double application fails atomically without changing configuration or functions',async()=>{
  const before=await stats();
  await assert.rejects(()=>db.exec(readSql(migrationFile)),/SCANYM_SCHEMA_DRIFT/);
  await db.exec('rollback');
  assert.equal(await definition(coSig),newCheckout); assert.equal(await definition(resSig),newResolver);
  assert.deepEqual(await stats(),before);
});
test('Rollback refuses a changed resolver and does not overwrite another release',async()=>{
  const mutated=newResolver.replace('1 - s.discount_percentage / 100','1 - s.discount_percentage / 200');
  await db.exec('update restaurant_sale_mode_fulfillments set discount_enabled=false');
  try {
    await db.exec(mutated);
    await assert.rejects(()=>db.exec(readSql(rollbackFile)),/SCANYM_SCHEMA_DRIFT/);
    await db.exec('rollback');
    assert.equal(await definition(resSig),mutated);
    assert.equal(await definition(coSig),newCheckout);
  } finally {await db.exec(newResolver);}
});
test('Rollback refuses active policies; disabled rollback restores exact B1 functions and preserves v2 history',async()=>{
  const order=await checkout(); const snap=await snapshot(order.order_id);
  await assert.rejects(()=>db.exec(readSql(rollbackFile)),/SCANYM_B5_ROLLBACK_ACTIVE_POLICY/);
  await db.exec('rollback');
  assert.equal(await definition(coSig),newCheckout);
  await db.exec('update restaurant_sale_mode_fulfillments set discount_enabled=false');
  try {
    await db.exec(readSql(rollbackFile));
    assert.equal(await definition(coSig),oldCheckout); assert.equal(await definition(resSig),oldResolver);
    assert.deepEqual(await snapshot(order.order_id),snap);
    const next=await checkout(); assert.equal(next.delivery_fee,'6.90');
    assert.equal((await snapshot(next.order_id)).snapshot_method_version,'v1');
    await assert.rejects(()=>db.query('update restaurant_sale_mode_fulfillments set discount_enabled=true where id=$1',[ruleA]),e=>e.code==='23514');
  } finally {
    await db.exec('drop function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)');
    await db.exec(newResolver);
    await db.exec('revoke all on function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric) from public,anon,authenticated,service_role');
    await db.exec(newCheckout);
    await db.exec('alter table restaurant_sale_mode_fulfillments drop constraint rsmf_discount_disabled_during_rollback');
  }
});
test('Existing VAT allocation uses the discounted fee and remains atomic on checkout failure',async()=>{
  await db.exec(readSql('DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql'));
  await db.query('update menu_items set tax_rate=10 where id=$1',[itemA]);
  const row=await checkout();
  const vat=await one('select sum(delivery_fee_gross_share)::text as gross from order_delivery_tax_allocations where order_id=$1',[row.order_id]);
  assert.equal(row.delivery_fee,'3.45');assert.equal(vat.gross,'3.45');
  const before=(await one('select count(*) as n from order_delivery_tax_allocations')).n;
  const mutated=newResolver.replaceAll('1 - s.discount_percentage / 100','1 - s.discount_percentage / 200');
  try {await db.exec(mutated);await assertRollback(()=>checkout());}
  finally {await db.exec(newResolver);}
  assert.equal((await one('select count(*) as n from order_delivery_tax_allocations')).n,before);
  await db.query('update menu_items set tax_rate=null where id=$1',[itemA]);
  await assertRollback(()=>checkout(),/SCANYM_DELIVERY_TAX_ALLOCATION/);
});
