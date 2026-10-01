import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeBaseline, readSql, migrationFile, rollbackFile } from "../supabase/tests/b5/bootstrap.mjs";
import { computeDeliveryFee, resolveDeliveryFulfillment } from "../lib/delivery.ts";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
const { supabase } = await import("../lib/supabase.ts");
const { getPublicDeliveryFulfillments } = await import("../lib/sale-modes-public.ts");
const db = await makeBaseline();
after(async () => db.close());
const signatures = ['get_merchant_delivery_fulfillment_pricing(uuid)','mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)','get_restaurant_public_delivery_fulfillments(uuid)'];
const definitions = async () => (await db.query(`select oid::regprocedure::text sig,pg_get_functiondef(oid) def,proacl::text acl,proowner from pg_proc where oid=any($1::regprocedure[]) order by 1`, [signatures])).rows;
const predecessors = await definitions();
await db.exec(readSql(migrationFile));
const id=(n:number)=>`b5c00000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const A=id(1), B=id(2), owner=id(3), manager=id(4), staff=id(5), operator=id(6), stranger=id(7), item=id(8);
await db.exec(`insert into auth.users(id,email) values ${[owner,manager,staff,operator,stranger].map((u,i)=>`('${u}','b5c-${i}@example.test')`).join(',')};
 insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Generic A','b5c-a','active',true,'FR'),('${B}','Generic B','b5c-b','active',true,'FR');
 insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${owner}','owner'),('${A}','${manager}','manager'),('${A}','${staff}','staff'),('${B}','${stranger}','owner');
 insert into scanym_operators(user_id) values ('${operator}');
 insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number) values ('${A}','+33600000000','EUR',1),('${B}','+33600000000','EUR',1);
 insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${A}','pickup',true,'{}'),('${B}','delivery',true,'{}');
 insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR'),('${B}','FR');
 insert into menu_categories(id,restaurant_id,name) values ('${id(9)}','${A}','Fixture');
 insert into menu_items(id,category_id,name,price,tax_rate,is_available) values ('${item}','${id(9)}','Product',12.4,5.5,true);`);
async function asUser(sql:string,args:unknown[]=[],uid:string|null=owner,role='authenticated') {
 return db.transaction(async tx=>{await tx.query("select set_config('test.uid',$1,true)",[uid??'']);await tx.exec(`set local role ${role}`);return tx.query<Record<string,any>>(sql,args);});
}
const payload=(extra:Record<string,unknown>={})=>({fulfillmentCode:'private-routing-code',provider:'chronofresh',zones:['75013'],enabled:true,isFallback:false,
 pricingMode:'fixed',fixedFee:18.9,freeThreshold:null,customerText:'Livraison à votre adresse.',minItems:null,...extra});
let rule:string, historical:string, historicalSnapshot:unknown;
async function save(extra:Record<string,unknown>={},uid=owner){const r=await asUser("select mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb) id",[A,rule??null,JSON.stringify(payload(extra))],uid);rule=String(r.rows[0].id);}
const customer=(postal:string)=>({first_name:'Ada',last_name:'Lovelace',phone:'0612345678',email:'ada@example.test',address:`1 rue Test, ${postal} Paris`,postalCode:postal,street:'1 rue Test',city:'Paris',country:'FR'});
async function checkout(subtotal:number,postal='75013',mode='delivery') {
 await db.query('update menu_items set price=$1 where id=$2',[subtotal,item]);
 return (await asUser("select * from create_order('b5c-a',$1,$2::jsonb,null,$3::jsonb,null,'fr',false)",[mode,JSON.stringify([{menu_item_id:item,quantity:1}]),JSON.stringify({...customer(postal),delivery_fee:0,discount_percentage:100})],null,'anon')).rows[0];
}
async function parity(t:any,subtotal:number,expected?:number,postal='75013') {
 t.mock.method(supabase,'rpc',async(name:string,args:any)=>{
   assert.equal(name,'get_restaurant_public_delivery_fulfillments');
   return {data:(await asUser('select * from get_restaurant_public_delivery_fulfillments($1)',[args.p_restaurant_id],null,'anon')).rows,error:null};
 });
 const rules=await getPublicDeliveryFulfillments(A);
 const estimate=resolveDeliveryFulfillment(rules,postal,1,subtotal).deliveryFee;
 const result=await checkout(subtotal,postal);
 const tester=(await asUser("select test_merchant_delivery_postcode($1,$2,'FR',$3,1) r",[A,postal,subtotal],staff)).rows[0].r;
 assert.equal(estimate,Number(result.delivery_fee));assert.equal(Number(tester.delivery_fee),estimate);
 assert.equal(Number(result.total),(Math.round(subtotal*100)+Math.round(estimate!*100))/100);
 if(expected!==undefined)assert.equal(estimate,expected);
 return result;
}

test('B5 live-shaped projection supplies all price facts, no provider/config; exact 12.40 + 18.90 = 31.30',async t=>{
 await save();
 const rows=(await asUser('select * from get_restaurant_public_delivery_fulfillments($1)',[A],null,'anon')).rows;
 assert.deepEqual(Object.keys(rows[0]).sort(),['fulfillment_code','zone_prefixes','is_fallback','min_items','customer_text','display_order','rule_id','customer_text_hash','translations','pricing_mode','fixed_fee','free_threshold','discount_enabled','discount_threshold','discount_percentage'].sort());
 assert.equal(Number(rows[0].fixed_fee),18.9);assert.equal(rows[0].discount_enabled,false);
 assert.ok(!JSON.stringify(rows).includes('chronofresh'));assert.ok(!('provider' in rows[0]));
 const order=await parity(t,12.4,18.9);assert.equal(Number(order.total),31.3);
 historical=String(order.order_id);historicalSnapshot=(await db.query('select * from order_delivery_fulfillment_snapshot where order_id=$1',[historical])).rows;
});

test('B5 owner, manager and operator configure; staff/other tenant/direct columns cannot mutate',async()=>{
 for(const uid of [owner,manager,operator]){await save({discountEnabled:true,discountThreshold:100,discountPercentage:50},uid);
  const r=(await asUser('select * from get_merchant_delivery_fulfillment_pricing($1)',[A],staff)).rows[0];assert.equal(Number(r.discount_percentage),50);}
 for(const uid of [staff,stranger])await assert.rejects(()=>save({discountEnabled:false,discountThreshold:null,discountPercentage:null},uid),/Not authorized/);
 await assert.rejects(()=>asUser("select mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb)",[B,rule,JSON.stringify(payload())],stranger),/unavailable/);
 for(const role of ['anon','authenticated'])for(const col of ['discount_enabled','discount_threshold','discount_percentage']){
  assert.equal((await db.query<{yes:boolean}>("select has_column_privilege($1,'public.restaurant_sale_mode_fulfillments',$2,'UPDATE') yes",[role,col])).rows[0].yes,false);
  await assert.rejects(()=>asUser(`update restaurant_sale_mode_fulfillments set ${col}=${col} where id=$1`,[rule],owner,role),/permission denied/);
 }
});

test('B5 older B234 payload preserves policy on edit and default-disabled on create',async()=>{
 await save({fixedFee:18.9});
 const r=(await db.query<Record<string,any>>('select * from restaurant_sale_mode_fulfillments where id=$1',[rule])).rows[0];assert.equal(r.discount_enabled,true);assert.equal(Number(r.discount_percentage),50);
 const result=await asUser("select mutate_merchant_delivery_rule($1,'save',null,$2::jsonb) id",[A,JSON.stringify(payload({zones:[],isFallback:true,fulfillmentCode:'Fallback',fixedFee:12}))]);
 assert.equal((await db.query<Record<string,any>>('select discount_enabled from restaurant_sale_mode_fulfillments where id=$1',[result.rows[0].id])).rows[0].discount_enabled,false);
});

test('B5 hostile/partial policy values fail atomically, including inactive invalid configurations',async()=>{
 const before=JSON.stringify((await db.query('select * from restaurant_sale_mode_fulfillments where id=$1',[rule])).rows);
 for(const extra of [{discountEnabled:true},{discountEnabled:null,discountThreshold:100,discountPercentage:50},
  ...[-1,100.01,100.001,'NaN','50'].map(v=>({discountEnabled:true,discountThreshold:100,discountPercentage:v})),
  ...[-0.001,-1,100.001,null,'Infinity',100000000].map(v=>({discountEnabled:true,discountThreshold:v,discountPercentage:50})),
  {discountEnabled:false,discountThreshold:100,discountPercentage:101}]){
  await assert.rejects(()=>save(extra),/B5_INVALID_DISCOUNT/);
  assert.equal(JSON.stringify((await db.query('select * from restaurant_sale_mode_fulfillments where id=$1',[rule])).rows),before);
 }
});

test('B5 public service / tester / checkout parity at thresholds and all five fixture fees',async t=>{
 for(const [fee,expected] of [[6.9,3.45],[10.9,5.45],[13.9,6.95],[15.9,7.95],[18.9,9.45]]){
  await save({fixedFee:fee,discountEnabled:true,discountThreshold:100,discountPercentage:50});
  await parity(t,99.99,fee);await parity(t,100,expected);await parity(t,100.01,expected);
 }
 await save({fixedFee:6.9,discountEnabled:true,discountThreshold:60,discountPercentage:20});await parity(t,60,5.52);
 for(const percent of [0,100]){await save({discountEnabled:true,discountThreshold:0,discountPercentage:percent});await parity(t,12.4,percent===100?0:18.9);}
 await save({discountEnabled:false,discountThreshold:100,discountPercentage:50});await parity(t,100,18.9);
 await parity(t,100,12,'69001');assert.equal(Number((await checkout(100,'75013','pickup')).delivery_fee),0);
});

test('B5 exact rounding: 160 deterministic real checkout / public estimator pairs',async t=>{
 let seed=593263;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let i=0;i<160;i++){
  const fee=(next()%100000)/100,percent=(next()%10001)/100;
  await save({fixedFee:fee,discountEnabled:true,discountThreshold:0,discountPercentage:percent});await parity(t,100);
 }
 await save({fixedFee:0.01,discountEnabled:true,discountThreshold:0,discountPercentage:50});await parity(t,100,0.01);
});

test('B5 free/free-above precedence, unavailable metadata abstention and original v1 history',async t=>{
 await save({pricingMode:'free',fixedFee:null,discountEnabled:true,discountThreshold:100,discountPercentage:50});await parity(t,100,0);
 await save({pricingMode:'free_above_threshold',freeThreshold:80,discountEnabled:true,discountThreshold:100,discountPercentage:50});await parity(t,79.99,18.9);await parity(t,100,0);
 assert.equal(computeDeliveryFee({pricingMode:'free_above_threshold',fixedFee:18.9,freeThreshold:1},0.1+0.7+0.2),0,'IEEE cart sum is compared at checkout cent precision');
 assert.equal(computeDeliveryFee({pricingMode:undefined as any,fixedFee:undefined as any,freeThreshold:null},12.4),undefined);
 assert.equal(computeDeliveryFee({pricingMode:'fixed',fixedFee:18.9,freeThreshold:null,discountEnabled:true,discountThreshold:null,discountPercentage:50},100),undefined);
 assert.deepEqual((await db.query('select * from order_delivery_fulfillment_snapshot where order_id=$1',[historical])).rows,historicalSnapshot);
});

test('B5 rollback restores exact B234/public contracts and ACL, preserves v2 facts, blocks reactivation',async()=>{
 await save({discountEnabled:true,discountThreshold:100,discountPercentage:50});
 const order=await checkout(100);const snapshot=(await db.query('select * from order_delivery_fulfillment_snapshot where order_id=$1',[order.order_id])).rows;
 assert.equal((snapshot[0] as any).snapshot_method_version,'v2');
 await assert.rejects(()=>db.exec(readSql(rollbackFile)),/B5_ROLLBACK_ACTIVE_POLICY/);await db.exec('rollback');
 await save({discountEnabled:false,discountThreshold:100,discountPercentage:50});
 await db.exec(readSql(rollbackFile));assert.deepEqual(await definitions(),predecessors);
 assert.deepEqual((await db.query('select * from order_delivery_fulfillment_snapshot where order_id=$1',[order.order_id])).rows,snapshot);
 await assert.rejects(()=>db.query('update restaurant_sale_mode_fulfillments set discount_enabled=true where id=$1',[rule]),/discount_disabled_during_rollback/);
 assert.equal(Number((await checkout(100)).delivery_fee),18.9);
});
