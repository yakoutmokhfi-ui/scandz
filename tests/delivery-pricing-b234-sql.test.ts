import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeBaseline as makeDeliveryDb, readSql as sqlFile } from "../supabase/tests/b5/bootstrap.mjs";
import { validateDeliveryZones } from "../lib/delivery-zone-validation.ts";
import type { ZoneValidationInput } from "../lib/delivery-zone-validation-types.ts";

const db = await makeDeliveryDb();
after(async () => { await db.close(); });
const migration = "DRAFT-lot-delivery-pricing-v2-b5.sql";
await db.exec(sqlFile(migration));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const A=id(1), B=id(2), owner=id(3), manager=id(4), staff=id(5), operator=id(6), stranger=id(7), item=id(8);
await db.exec(`insert into auth.users(id,email) values ${[owner,manager,staff,operator,stranger].map((u,i)=>`('${u}','b234-${i}@example.test')`).join(',')};
  insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Fixture Au Lait Cru','b234-a','active',true,'FR'),('${B}','Tenant B','b234-b','active',true,'FR');
  insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${owner}','owner'),('${A}','${manager}','manager'),('${A}','${staff}','staff'),('${B}','${stranger}','owner');
  insert into scanym_operators(user_id) values ('${operator}');
  insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number) values ('${A}','+33600000000','EUR',1),('${B}','+33600000000','EUR',1);
  insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{"delivery_zone_prefixes":["75"]}'),('${A}','pickup',true,'{}'),('${B}','delivery',true,'{}');
  insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR'),('${B}','FR');
  insert into menu_categories(id,restaurant_id,name) values ('${id(9)}','${A}','Fixture');
  insert into menu_items(id,category_id,name,price,tax_rate,is_available) values ('${item}','${id(9)}','Fixture product',10,5.5,true);`);
async function userQuery(sql:string,args:unknown[]=[],uid:string|null=owner,role="authenticated") {
  return db.transaction(async tx=>{await tx.query<Record<string, any>>("select set_config('test.uid',$1,true)",[uid??""]); await tx.exec(`set local role ${role}`); return tx.query<Record<string, any>>(sql,args);});
}
const payload=(extra:Record<string,unknown>={})=>({fulfillmentCode:"Zone",provider:"internal",zones:["75018"],enabled:true,isFallback:false,
  pricingMode:"fixed",fixedFee:6.9,freeThreshold:null,customerText:"Livraison",minItems:null,...extra});
async function save(p:Record<string,unknown>,rid:string|null=null,uid=owner,tenant=A) {
  if(p.enabled===false) {
    const preview=(await userQuery('select preview_merchant_delivery_rule_save($1,$2,false) result',[tenant,rid],uid)).rows[0].result;
    if(preview!=='none') p={...p,legacyConfirmation:preview};
  }
  const result=await userQuery("select mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb) id",[tenant,rid,JSON.stringify(p)],uid);
  return String(result.rows[0].id);
}
async function preview(postal="75018",amount=10,count=1,country:string|null="FR") {
  return (await userQuery("select test_merchant_delivery_postcode($1,$2,$3,$4,$5) result",[A,postal,country,amount,count])).rows[0].result as Record<string,any>;
}
const state=async()=>JSON.stringify((await db.query<Record<string, any>>("select to_jsonb(f) r from restaurant_sale_mode_fulfillments f where restaurant_id=$1 order by display_order",[A])).rows);
async function rejectsUnchanged(fn:()=>Promise<unknown>,pattern:RegExp){const before=await state();await assert.rejects(fn,pattern);assert.equal(await state(),before);}
let localRule:string, fallback:string, historicOrder:string, snapshot:string;

test("B234 SQL enforces every B0 fixture's blocking findings",async()=>{
  const fixtures=JSON.parse(readFileSync("tests/fixtures/delivery-zone-validation-cases.json","utf8"));
  const key=(f:any)=>`${f.code}|${f.ruleId}|${f.zone}`;
  for(const c of fixtures.cases){
    const expected=validateDeliveryZones(c).findings.filter(f=>f.severity==="BLOCKING_ERROR").map(key);
    const actual=(await db.query<Record<string, any>>("select scanym_internal.delivery_zone_blockers($1::jsonb,$2::jsonb) f",[JSON.stringify(c.rules),JSON.stringify(c.shape)])).rows[0].f as any[];
    assert.deepEqual([...new Set(actual.map(key))].sort(),[...new Set(expected)].sort(),c.id);
  }
});
test("B234 generated B0 differential cases: order, nesting, null IDs and collectivity",async()=>{
  let seed=234; const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<160;i++){
    const input:ZoneValidationInput={shape:{allowedChars:"digits",exactLength:2,minPrefixLength:1},rules:Array.from({length:1+next()%5},(_,j)=>({ruleId:j%3?String(j):null,label:`Rule ${j}`,displayOrder:next()%5,isDefault:next()%7===0,zones:Array.from({length:next()%5},()=>String(next()%100))}))};
    const expected=validateDeliveryZones(input).decision==="REJECTED";
    const actual=(await db.query<Record<string, any>>("select scanym_internal.delivery_zone_blockers($1::jsonb,$2::jsonb) f",[JSON.stringify(input.rules),JSON.stringify(input.shape)])).rows[0].f as any[];
    assert.equal(actual.length>0,expected,JSON.stringify(input));
  }
});
test("owner creates dedicated 75018 zone and generic tariff groups",async()=>{
  localRule=await save(payload());
  for(const [zone,fee] of [["92",10.9],["93",13.9],["94",15.9]] as const) await save(payload({zones:[zone],fixedFee:fee,fulfillmentCode:`Zone ${zone}`}));
  fallback=await save(payload({zones:[],isFallback:true,provider:"chronofresh",fixedFee:18.9,fulfillmentCode:"Reste du territoire"}));
  assert.equal((await preview()).delivery_fee,6.9);
  for(const [code,fee] of [["92000",10.9],["93000",13.9],["94000",15.9],["69001",18.9]] as const) assert.equal(Number((await preview(code)).delivery_fee),fee);
});
test("manager edits a rule; translations survive, source hash changes",async()=>{
  await db.query<Record<string, any>>(`update restaurant_sale_mode_fulfillments set translations='{"en":{"customer_text":"Delivery","customer_text_status":"validated","customer_text_source_hash":"old"}}' where id=$1`,[localRule]);
  const before=(await db.query<Record<string, any>>('select translations,customer_text_hash from restaurant_sale_mode_fulfillments where id=$1',[localRule])).rows[0];
  await save(payload({customerText:"Nouveau texte"}),localRule,manager);
  const afterRow=(await userQuery('select * from get_merchant_delivery_fulfillment_pricing($1)',[A])).rows.find(r=>r.rule_id===localRule)!;
  assert.deepEqual(afterRow.translations,before.translations);assert.notEqual(afterRow.customer_text_hash,before.customer_text_hash);
});
test("operator without membership can read, create, edit and test",async()=>{
  assert.equal((await userQuery('select * from get_merchant_delivery_fulfillment_pricing($1)',[A],operator)).rows.length,5);
  const r=await save(payload({zones:['95']}),null,operator);
  await save(payload({zones:['95'],fixedFee:9}),r,operator);
  assert.equal((await userQuery("select test_merchant_delivery_postcode($1,'95000','FR',10,1) r",[A],operator)).rows[0].r.eligible,true);
});
test("other tenant, staff write, anon and unauthenticated claims rejected",async()=>{
  for(const uid of [stranger,staff]) await assert.rejects(()=>userQuery('select preview_merchant_delivery_rule_save($1,$2,false)',[A,localRule],uid),/Not authorized/);
  for(const uid of [owner,manager,operator]) assert.equal((await userQuery('select preview_merchant_delivery_rule_save($1,$2,false) result',[A,localRule],uid)).rows[0].result,'none');
  await assert.rejects(()=>userQuery('select preview_merchant_delivery_rule_save($1,$2,false)',[B,localRule],stranger),/unavailable/);
  for(const role of ['anon','authenticated']) await assert.rejects(()=>userQuery('select preview_merchant_delivery_rule_save($1,$2,false)',[A,localRule],null,role),/permission denied|Authentication required/);
  for(const uid of [stranger,staff]) await rejectsUnchanged(()=>save(payload(),localRule,uid),/Not authorized/);
  await assert.rejects(()=>userQuery('select * from get_merchant_delivery_fulfillment_pricing($1)',[A],stranger),/Not authorized/);
  await assert.rejects(()=>save(payload(),localRule,stranger,B),/unavailable/);
  for(const role of ['anon','authenticated']) await assert.rejects(()=>userQuery('select mutate_merchant_delivery_rule($1,\'save\',null,$2::jsonb)',[A,JSON.stringify(payload())],null,role),/permission denied|Authentication required/);
  for(const role of ['anon','authenticated']) {
    await assert.rejects(()=>userQuery('select * from get_merchant_delivery_fulfillment_pricing($1)',[A],null,role),/permission denied|Authentication required/);
    await assert.rejects(()=>userQuery("select test_merchant_delivery_postcode($1,'75018','FR',10,1)",[A],null,role),/permission denied|Authentication required/);
  }
  await assert.rejects(()=>userQuery("select test_merchant_delivery_postcode($1,'75018','FR',10,1)",[A],stranger),/Not authorized/);
  await assert.rejects(()=>userQuery("select mutate_merchant_delivery_rule($1,'move',$2,$3::jsonb)",[B,localRule,JSON.stringify({otherRuleId:fallback})],stranger),/unavailable/);
  assert.ok((await userQuery('select * from get_merchant_delivery_fulfillment_pricing($1)',[A],staff)).rows.length>0);
  assert.equal((await userQuery("select test_merchant_delivery_postcode($1,'75018','FR',10,1) r",[A],staff)).rows[0].r.eligible,true);
});
test("no direct writes or direct resolver execution granted to application roles",async()=>{
  for(const role of ['anon','authenticated']){
    assert.equal((await db.query<{allowed:boolean}>("select has_any_column_privilege($1,'public.restaurant_sale_mode_fulfillments','UPDATE') allowed",[role])).rows[0].allowed,false);
    for(const column of ['zone_prefixes','provider','is_fallback','display_order','fulfillment_code','enabled','pricing_mode','fixed_fee','free_threshold','customer_text','min_items']) {
      assert.equal((await db.query<{allowed:boolean}>("select has_column_privilege($1,'public.restaurant_sale_mode_fulfillments',$2,'UPDATE') allowed",[role,column])).rows[0].allowed,false,`${role}.${column}`);
      for(const uid of [owner,staff]) await assert.rejects(()=>userQuery(`update restaurant_sale_mode_fulfillments set ${column}=${column} where id=$1`,[localRule],uid,role),/permission denied/);
    }
    await assert.rejects(()=>userQuery('update restaurant_sale_mode_fulfillments set fixed_fee=0 where id=$1',[localRule],owner,role),/permission denied/);
    await assert.rejects(()=>userQuery("select * from resolve_delivery_fulfillment($1,'delivery','75018',1,10)",[A],owner,role),/permission denied/);
  }
});

test('B-D-2: CIO-approved staff READ of provider/fulfillment_code; mutations remain forbidden',async()=>{
  const rows=(await userQuery('select * from get_merchant_delivery_fulfillment_pricing($1)',[A],staff)).rows;
  const expected=rows.find(r=>r.rule_id===fallback)!;
  assert.equal(expected.provider,'chronofresh');assert.equal(expected.fulfillment_code,'Reste du territoire');
  const tested=(await userQuery("select test_merchant_delivery_postcode($1,'69001','FR',10,1) r",[A],staff)).rows[0].r;
  assert.equal(tested.provider,expected.provider);assert.equal(tested.fulfillment_code,expected.fulfillment_code);
  await rejectsUnchanged(()=>save(payload(),localRule,staff),/Not authorized/);
});
test("duplicates, covered zones, empty active rules and second fallback fail atomically",async()=>{
  for(const p of [payload(),payload({zones:['92000']}),payload({zones:[]}),payload({zones:[],isFallback:true})])
    await rejectsUnchanged(()=>save(p),/B234_INVALID_ZONES|one_fallback/);
  await rejectsUnchanged(()=>save(payload({zones:['92']}),localRule),/B234_INVALID_ZONES/);
});
test("hostile payload, LIKE wildcards, non-finite/negative fees and fractional counts are rejected",async()=>{
  for(const extra of [{zones:['%']},{zones:['_']},{zones:[null]},{zones:'75'},{fixedFee:'NaN'},{fixedFee:'Infinity'},{fixedFee:-1},{fixedFee:6.999},{minItems:1.5},{enabled:'false'},{unknown:1},{fulfillmentCode:''}])
    await rejectsUnchanged(()=>save(payload(extra),localRule),/B234_|ZV-|constraint|invalid input/);
});
test("reorder changes priority deterministically; invalid reorder rolls back",async()=>{
  const broad=await save(payload({zones:['75'],fulfillmentCode:'Broad'}));
  await rejectsUnchanged(()=>userQuery("select mutate_merchant_delivery_rule($1,'move',$2,$3::jsonb)",[A,broad,JSON.stringify({otherRuleId:localRule})]),/B234_INVALID_ZONES/);
  const group=(await db.query<Record<string, any>>("select id from restaurant_sale_mode_fulfillments where restaurant_id=$1 and zone_prefixes=ARRAY['92']",[A])).rows[0].id;
  await userQuery("select mutate_merchant_delivery_rule($1,'move',$2,$3::jsonb)",[A,group,JSON.stringify({otherRuleId:localRule})]);
  assert.equal((await preview()).fulfillment_rule_id,localRule);
  await save(payload({zones:['75'],enabled:false}),broad);
});
test("tester is exactly the runtime resolver for matching, fallback, threshold and minimum",async()=>{
  await save(payload({pricingMode:'free_above_threshold',freeThreshold:100,minItems:2}),localRule);
  for(const [postal,amount,count] of [['75018',99,1],['75018',100,2],['75018',99,2],['69001',120,3]] as const){
    const expected=(await db.query<Record<string, any>>("select to_jsonb(r) r from resolve_delivery_fulfillment($1,'delivery',$2,$3,$4) r",[A,postal,count,amount])).rows[0].r;
    const actual=await preview(postal,amount,count);delete actual.status;assert.deepEqual(actual,expected);
  }
  await save(payload(),localRule);
});
test("real B1 order before edit preserves its immutable snapshot and monetary facts",async()=>{
  const customer={name:'Ada Lovelace',first_name:'Ada',last_name:'Lovelace',phone:'0612345678',email:'ada@example.test',address:'1 rue Test, 75018 Paris',postalCode:'75018',street:'1 rue Test',city:'Paris',country:'FR'};
  const created=(await userQuery("select * from create_order('b234-a','delivery',$1::jsonb,null,$2::jsonb,null,'fr',false)",[JSON.stringify([{menu_item_id:item,quantity:1}]),JSON.stringify(customer)],null,'anon')).rows[0];
  historicOrder=String(created.order_id);assert.equal(Number(created.delivery_fee),6.9);
  snapshot=JSON.stringify((await db.query<Record<string, any>>('select to_jsonb(s) s from order_delivery_fulfillment_snapshot s where order_id=$1',[historicOrder])).rows);
  assert.notEqual(snapshot,'[]');
  await userQuery("select mutate_merchant_delivery_rule($1,'move',$2,$3::jsonb)",[A,localRule,JSON.stringify({otherRuleId:fallback})]);
  assert.equal(JSON.stringify((await db.query<Record<string, any>>('select to_jsonb(s) s from order_delivery_fulfillment_snapshot s where order_id=$1',[historicOrder])).rows),snapshot);
  await save(payload({fixedFee:8.9}),localRule);
  assert.equal(Number((await preview()).delivery_fee),8.9);
  assert.equal(JSON.stringify((await db.query<Record<string, any>>('select to_jsonb(s) s from order_delivery_fulfillment_snapshot s where order_id=$1',[historicOrder])).rows),snapshot);
  assert.equal(Number((await db.query<Record<string, any>>('select delivery_fee from orders where id=$1',[historicOrder])).rows[0].delivery_fee),6.9);
  const picked=(await userQuery("select * from create_order('b234-a','pickup',$1::jsonb,null,$2::jsonb,null,'fr',false)",[JSON.stringify([{menu_item_id:item,quantity:1}]),JSON.stringify(customer)],null,'anon')).rows[0];
  assert.equal(Number(picked.delivery_fee),0);
});
test("disabling fallback yields non-eligible out-of-zone; snapshots untouched",async()=>{
  await save(payload({zones:[],isFallback:true,enabled:false,provider:'chronofresh',fixedFee:18.9}),fallback);
  const result=await preview('69001');assert.equal(result.eligible,false);assert.equal(result.block,'out-of-zone');
  assert.equal(JSON.stringify((await db.query<Record<string, any>>('select to_jsonb(s) s from order_delivery_fulfillment_snapshot s where order_id=$1',[historicOrder])).rows),snapshot);
});
test("disabling the final rule is legitimate and clearly reports legacy, without a fake price",async()=>{
  await db.query<Record<string, any>>("update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id=$1",[A]);
  assert.deepEqual(await preview(),{status:'legacy',eligible:null});
  await save(payload({enabled:false}),localRule);
  assert.equal(JSON.stringify((await db.query<Record<string, any>>('select to_jsonb(s) s from order_delivery_fulfillment_snapshot s where order_id=$1',[historicOrder])).rows),snapshot);
});
test("disabled rules are excluded but reactivation must pass B0",async()=>{
  await save(payload(),localRule);
  const dormant=await save(payload({enabled:false}));
  await rejectsUnchanged(()=>save(payload(),dormant),/B234_INVALID_ZONES/);
});
test("FR+BE domain union avoids a false collective-unreachable verdict",async()=>{
  await db.query<Record<string, any>>("update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id=$1",[A]);
  await db.query<Record<string, any>>("insert into restaurant_delivery_countries(restaurant_id,country_code) values ($1,'BE')",[A]);
  for(let i=0;i<10;i++) await save(payload({zones:[`1234${i}`],fulfillmentCode:`digit ${i}`}));
  await save(payload({zones:['1234'],fulfillmentCode:'Short postcode'}));
  assert.equal((await preview('1234',10,1,'BE')).eligible,true);
  await assert.rejects(()=>db.query<Record<string, any>>("delete from restaurant_delivery_countries where restaurant_id=$1 and country_code='BE'",[A]),/B234_INVALID_ZONES/);
  assert.equal((await preview('1234',10,1,'FR')).status,'invalid-postcode');
  assert.equal((await preview('12345',10,1,null)).status,'country-required');
});
test("parent mode reactivation validates the final rule set",async()=>{
  await db.query<Record<string, any>>("update restaurant_sale_modes set enabled=false where restaurant_id=$1 and mode_code='delivery'",[A]);
  await save(payload({zones:['12340'],enabled:true}));
  await assert.rejects(()=>db.query<Record<string, any>>("update restaurant_sale_modes set enabled=true where restaurant_id=$1 and mode_code='delivery'",[A]),/B234_INVALID_ZONES/);
  assert.equal((await preview('12345')).status,'mode-disabled');
});

test('B234 rechecks last-active confirmation under the mutation lock after server state changes',async()=>{
  const first=await save(payload({zones:['75']}),null,stranger,B);
  const second=await save(payload({zones:['92']}),null,stranger,B);
  assert.equal((await userQuery('select preview_merchant_delivery_rule_save($1,$2,false) result',[B,first],stranger)).rows[0].result,'none');
  await save(payload({zones:['92'],enabled:false}),second,stranger,B);
  const mutate=(ack?:string)=>userQuery("select mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb)",[B,first,JSON.stringify(payload({zones:['75'],enabled:false,...(ack?{legacyConfirmation:ack}:{})}))],stranger);
  await assert.rejects(()=>mutate(),/B234_CONFIRM_LEGACY_REQUIRED/);
  await db.query("update restaurant_sale_modes set config=$2::jsonb where restaurant_id=$1 and mode_code='delivery'",[B,JSON.stringify({delivery_zone_prefixes:['75']})]);
  await assert.rejects(()=>mutate('legacy-unavailable'),/B234_CONFIRM_LEGACY_REQUIRED/);
  assert.equal((await db.query<{enabled:boolean}>('select enabled from restaurant_sale_mode_fulfillments where id=$1',[first])).rows[0].enabled,true);
  await mutate('legacy-zones');
  assert.equal((await db.query<{enabled:boolean}>('select enabled from restaurant_sale_mode_fulfillments where id=$1',[first])).rows[0].enabled,false);
});
