// ISOLATED MEMORY ONLY: no remote client, URLs, credentials or network.
// Re-audit runner: actual forward/rollback DML on the saved fixture, plus SELECT-only evidence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {makeBaseline,readSql,migrationFile} from './b5/bootstrap.mjs';
const fixture=JSON.parse(readFileSync(new URL('../evidence/au-lait-cru-delivery-zone-remediation-v1/before.json',import.meta.url),'utf8'));
const expected=JSON.parse(readFileSync(new URL('../evidence/au-lait-cru-delivery-zone-remediation-v1/after-proposed.json',import.meta.url),'utf8'));
const db=await makeBaseline();await db.exec(readSql(migrationFile));

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

const ev='supabase/evidence/au-lait-cru-delivery-zone-remediation-v1/';
const fs=await import('node:fs');
const hash=async()=> (await db.query('select md5(jsonb_agg(to_jsonb(f) order by id)::text) hash from restaurant_sale_mode_fulfillments f where restaurant_id=$1',[A])).rows[0].hash;
const beforeHash=await hash();
const targeted=(await db.exec(fs.readFileSync(ev+'targeted-read-only.sql','utf8'))).find(r=>r.rows?.[0]?.postcode)?.rows;
assert.equal(targeted.length,28);assert.ok(targeted.every(r=>r.pass));
const regression=await db.exec(fs.readFileSync(ev+'regression-read-only.sql','utf8'));
await db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1.sql'));
const afterHash=await hash();assert.deepEqual(await rules(),sorted(expected));
const outcomes=(await db.exec(fs.readFileSync(ev+'actual-postflight-read-only.sql','utf8'))).find(r=>r.rows?.[0]?.postcode)?.rows;
assert.equal(outcomes.length,28);assert.ok(outcomes.every(r=>r.pass));
const discountsPreserved=(await rules()).every(r=>{const b=fixture.rules.find(b=>b.id===r.id);return r.discount_enabled===b.discount_enabled&&r.discount_threshold===b.discount_threshold&&r.discount_percentage===b.discount_percentage;});assert.ok(discountsPreserved);
await db.exec(readSql('DRAFT-lot-au-lait-cru-delivery-zone-remediation-v1-ROLLBACK.sql'));
assert.deepEqual(await rules(),sorted(fixture.rules));const restoredHash=await hash();assert.equal(restoredHash,beforeHash);
const root=ev+'reaudit/';fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(root+'regression-results.json',JSON.stringify(regression,null,2)+'\n');
fs.writeFileSync(root+'targeted-results.json',JSON.stringify(targeted,null,2)+'\n');
fs.writeFileSync(root+'actual-after-results.json',JSON.stringify(outcomes,null,2)+'\n');
fs.writeFileSync(root+'state-checks.json',JSON.stringify({environment:'isolated PGlite; saved fixture only',observedAt:new Date().toISOString(),node:process.version,postgres:(await db.query('select version() v')).rows[0].v,beforeHash,afterHash,restoredHash,discountsPreserved,targetedPassed:targeted.length,actualAfterPassed:outcomes.length,productionAccess:false,preprodAccess:false},null,2)+'\n');
await db.close();console.log(JSON.stringify({targeted:28,actualAfter:28,beforeHash,afterHash,restoredHash,discountsPreserved}));
