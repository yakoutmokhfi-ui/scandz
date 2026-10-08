// ISOLATED MEMORY ONLY: no remote client, URLs, credentials or network.
// Prepared for independent execution; not run in this session (local process helper unavailable).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeBaseline,readSql,migrationFile} from './b5/bootstrap.mjs';
const fixture=JSON.parse(readFileSync(new URL('../evidence/au-lait-cru-delivery-zone-remediation-v1/before.json',import.meta.url),'utf8'));
const expected=JSON.parse(readFileSync(new URL('../evidence/au-lait-cru-delivery-zone-remediation-v1/after-proposed.json',import.meta.url),'utf8'));
const db=await makeBaseline();await db.exec(readSql(migrationFile));
after(()=>db.close());
const A=fixture.restaurant.id;
await db.query("insert into restaurants(id,name,slug,status,is_active,country) values($1,'Au lait cru','au-lait-cru','active',true,'FR')",[A]);
await db.query("insert into restaurant_sale_modes(restaurant_id,mode_code,enabled) values($1,'delivery',true)",[A]);
await db.query("insert into restaurant_delivery_countries(restaurant_id,country_code) values($1,'FR')",[A]);
const columns=Object.keys(fixture.rules[0]).filter(c=>c!=='customer_text_hash');
assert.ok(columns.every(c=>/^[a-z_]+$/.test(c)));
await db.query('insert into restaurant_sale_mode_fulfillments('+columns.join(',')+') select '+columns.join(',')+' from jsonb_populate_recordset(null::restaurant_sale_mode_fulfillments,$1::jsonb)',[JSON.stringify(fixture.rules)]);
const rules=async()=> (await db.query('select jsonb_agg(to_jsonb(f) order by id) value from restaurant_sale_mode_fulfillments f where restaurant_id=$1',[A])).rows[0].value;
const sorted=a=>[...a].sort((a,b)=>a.id.localeCompare(b.id));
const resolve=async(cp,sub)=> (await db.query("select * from resolve_delivery_fulfillment($1,'delivery',$2,1,$3)",[A,cp,sub])).rows[0];
const cases=[['93000','stuart',10.9],['92600','stuart',15.9],['92270','stuart',15.9],['92200','stuart',15.9],['93260','stuart',15.9],['75018','stuart',6.9],['69001','chronofresh',18.9]];
test('Exact observed BEFORE fixture and five incident reproductions',async()=>{
 assert.deepEqual(await rules(),sorted(fixture.rules));
 for(const [cp] of cases.slice(0,5)){const r=await resolve(cp,50);assert.equal(r.provider,'chronofresh');assert.equal(Number(r.delivery_fee),18.9);}
});
test('Actual forward DML, B0 triggers, 28 resolver outcomes and exact two-row delta',async()=>{
 await db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1.sql'));
 assert.deepEqual(await rules(),sorted(expected));
 for(const [cp,provider,fee] of cases)for(const subtotal of [50,99.99,100,100.01]){
  const r=await resolve(cp,subtotal);assert.equal(r.eligible,true);assert.equal(r.provider,provider);
  assert.equal(Number(r.delivery_fee),subtotal>=100?fee/2:fee);assert.equal(r.is_fallback,cp==='69001');
 }
});
test('Forward replay and stale rollback both fail closed without changing data',async()=>{
 await assert.rejects(()=>db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1.sql')),/STATE_DRIFT/);await db.exec('rollback');assert.deepEqual(await rules(),sorted(expected));
 await db.query("update restaurant_sale_mode_fulfillments set discount_percentage=40 where id=$1",[fixture.rules[0].id]);const drifted=await rules();
 await assert.rejects(()=>db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1-ROLLBACK.sql')),/STATE_DRIFT/);await db.exec('rollback');assert.deepEqual(await rules(),drifted);
 await db.query("update restaurant_sale_mode_fulfillments set discount_percentage=50 where id=$1",[fixture.rules[0].id]);
});
test('Actual rollback restores ALL original fields; stale forward refuses any unrelated edit',async()=>{
 await db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1-ROLLBACK.sql'));assert.deepEqual(await rules(),sorted(fixture.rules));
 await db.query("update restaurant_sale_mode_fulfillments set customer_text='Changed since review' where id=$1",[fixture.rules[0].id]);const drifted=await rules();
 await assert.rejects(()=>db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1.sql')),/STATE_DRIFT/);await db.exec('rollback');assert.deepEqual(await rules(),drifted);
});
