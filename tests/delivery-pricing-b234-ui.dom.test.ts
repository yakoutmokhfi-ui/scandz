// Actual React page -> actual dashboard services -> actual B234 SQL in PGlite.
// Only the Supabase transport, login and navigation shell are replaced locally.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { makeDeliveryDb, sqlFile } from "../supabase/tests/b234-bootstrap.mjs";

const db = await makeDeliveryDb();
await db.exec(sqlFile("DRAFT-lot-delivery-pricing-v2-b234.sql"));
const A="00000000-0000-4000-8000-000000000201", B="00000000-0000-4000-8000-000000000202", user="00000000-0000-4000-8000-000000000203";
await db.exec(`insert into auth.users(id,email) values ('${user}','ui@example.test');
  insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Fixture A','ui-a','active',true,'FR'),('${B}','Fixture B','ui-b','active',true,'FR');
  insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${user}','owner'),('${B}','${user}','owner');
  insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${B}','delivery',true,'{}');
  insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR'),('${B}','FR');`);
const dom = new JSDOM("<!doctype html><html><body></body></html>", {url:`http://localhost/dashboard/delivery-pricing?r=${A}`,pretendToBeVisual:true});
const {window}=dom;
(globalThis as any).window=window; (globalThis as any).document=window.document;
Object.defineProperty(globalThis,"navigator",{value:window.navigator,configurable:true});
(globalThis as any).HTMLElement=window.HTMLElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const React=await import("react"); const {createRoot}=await import("react-dom/client");
const confirmations:string[]=[]; let confirmationAnswer=false;
window.confirm=(message?:string)=>{confirmations.push(message??"");return confirmationAnswer;};
const calls:Array<{name:string; args:Record<string,any>}>=[];
let holdTester=false, releaseTester:(()=>void)|null=null;
let changeLegacyAfterPreview=false;
const signatures:Record<string,{keys:string[]; scalar?:boolean}>={
  preview_merchant_delivery_rule_save:{keys:["p_restaurant_id","p_rule_id","p_enabled"],scalar:true},
  get_merchant_delivery_fulfillment_pricing:{keys:["p_restaurant_id"]},
  get_merchant_delivery_method_notices:{keys:["p_restaurant_id"]},
  get_restaurant_public_delivery_countries:{keys:["p_restaurant_id"]},
  mutate_merchant_delivery_rule:{keys:["p_restaurant_id","p_action","p_rule_id","p_payload"],scalar:true},
  test_merchant_delivery_postcode:{keys:["p_restaurant_id","p_postal_code","p_country_code","p_subtotal","p_total_count"],scalar:true},
};
(globalThis as any).__b234Transport={
  from(table:string) {
    assert.equal(table,"restaurant_users");
    return {select:()=>({order:async()=>({data:[A,B].map(id=>({restaurant_id:id,role:"owner",restaurants:{id,name:id===A?"Fixture A":"Fixture B",slug:id}})),error:null})})};
  },
  async rpc(name:string,args:Record<string,any>) {
    calls.push({name,args}); const spec=signatures[name]; assert.ok(spec,`unexpected RPC: ${name}`);
    try {
      const result=await db.transaction(async tx=>{
        await tx.query("select set_config('test.uid',$1,true)",[user]); await tx.exec("set local role authenticated");
        return tx.query<Record<string,any>>(`select ${spec.scalar?'':'* from '}${name}(${spec.keys.map((_,i)=>`$${i+1}`).join(',')})${spec.scalar?' as value':''}`,spec.keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]));
      });
      const response={data:spec.scalar?result.rows[0].value:result.rows,error:null};
      if(name==='preview_merchant_delivery_rule_save'&&changeLegacyAfterPreview) {
        changeLegacyAfterPreview=false;
        await db.query("update restaurant_sale_modes set config='{}' where restaurant_id=$1 and mode_code='delivery'",[A]);
      }
      if(name==='test_merchant_delivery_postcode'&&holdTester) await new Promise<void>(resolve=>{releaseTester=resolve;});
      return response;
    }catch(error:any){return {data:null,error:{message:error.message,details:error.detail??null}};}
  },
};
const mocks:Record<string,string>={
  "@/lib/supabase":"export const supabase=globalThis.__b234Transport;",
  "next/navigation":'const router={replace(){},push(){}}; export const useRouter=()=>router;',
  "@/lib/services/auth":`export async function getUser(){return {id:'${user}'}}`,
  "@/lib/services/establishments":"export async function isScanymOperator(){return false} export async function getEstablishmentSummary(){return null}",
  "@/components/dashboard/DashboardNav":'export default function Nav(p){return <label>Tenant<select value={p.restaurantId} onChange={e=>p.onSelectRestaurant(e.target.value)}>{p.mappings.map(m=><option key={m.restaurant_id} value={m.restaurant_id}>{m.restaurants.name}</option>)}</select></label>}',
};
const built=await esbuild.build({stdin:{contents:'export {default as Page} from "@/app/dashboard/delivery-pricing/page";',resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,format:"esm",jsx:"automatic",target:"es2022",external:["react","react-dom","react-dom/client"],plugins:[{name:"local-transport",setup(build){
  build.onResolve({filter:/.*/},args=>{
    if(mocks[args.path]) return {path:args.path,namespace:"fixture"};
    if(args.path.startsWith("@/")){const base=path.resolve(args.path.slice(2));return {path:["",".tsx",".ts"].map(x=>base+x).find(existsSync)??base};}
  });
  build.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:mocks[args.path],loader:"tsx"}));
}}]});
const tmp=mkdtempSync(path.resolve("tests/tmp-b234-")); const file=path.join(tmp,"page.mjs");writeFileSync(file,built.outputFiles[0].text);
const {Page}=await import(pathToFileURL(file).href);rmSync(tmp,{recursive:true,force:true});
const container=window.document.createElement("div");window.document.body.append(container);const root=createRoot(container);
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(check:()=>boolean){for(let i=0;i<150;i++){await React.act(tick);if(check())return;}assert.fail("UI condition timed out");}
async function click(el:Element){await React.act(async()=>{(el as HTMLElement).click();await tick();});}
async function change(el:Element,value:string){await React.act(async()=>{
  const proto=el.tagName==='SELECT'?window.HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(el,value);
  el.dispatchEvent(new window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await tick();
});}
function button(scope:ParentNode,text:string){const b=[...scope.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);assert.ok(b,text);return b;}
function field(scope:ParentNode,label:string){const l=[...scope.querySelectorAll('label')].find(l=>{const copy=l.cloneNode(true) as Element;copy.querySelectorAll('input,textarea,select').forEach(e=>e.remove());return copy.textContent?.trim()===label;});assert.ok(l,label);const el=l.querySelector('input,textarea,select')??window.document.getElementById(l.htmlFor);assert.ok(el,label);return el;}
function card(name:string){const c=[...container.querySelectorAll('[data-delivery-rule]')].find(c=>c.querySelector('h3')?.textContent===name);assert.ok(c,name);return c;}
function tester(){return container.querySelector('[aria-labelledby="postcode-test-title"]')!;}
await React.act(async()=>{root.render(React.createElement(Page));await tick();});
await until(()=>!!container.querySelector('[aria-labelledby="postcode-test-title"]'));
after(async()=>{await React.act(()=>root.unmount());dom.window.close();await db.close();});

test("B234 UI creates normalized zones through the real service and SQL; re-reads server truth",async()=>{
  await click(button(container,"Ajouter une zone"));const c=card("Ajouter une zone");
  await change(field(c,"Nom de la règle"),"Paris 18");
  await change(field(c,"Codes postaux / préfixes")," 75018;75018\n75019 ");
  await change(field(c,"Frais de livraison"),"6.90");
  await click(button(c,"Enregistrer"));await until(()=>!![...container.querySelectorAll('h3')].find(e=>e.textContent==='Paris 18'));
  const row=(await db.query<Record<string,any>>('select * from restaurant_sale_mode_fulfillments where restaurant_id=$1',[A])).rows[0];
  assert.deepEqual(row.zone_prefixes,['75018','75019']);assert.equal(Number(row.fixed_fee),6.9);
  assert.match(card("Paris 18").textContent!,/6\.90/);
  const mutation=calls.find(c=>c.name==='mutate_merchant_delivery_rule')!;assert.equal(mutation.args.p_restaurant_id,A);assert.equal(mutation.args.p_rule_id,null);
});

test("B234 UI renders translated B0 rejection and keeps the persisted rule",async()=>{
  await click(button(container,"Ajouter une zone"));const c=card("Ajouter une zone");
  await change(field(c,"Nom de la règle"),"Duplicate");await change(field(c,"Codes postaux / préfixes"),"75018");await change(field(c,"Frais de livraison"),"2");
  await click(button(c,"Enregistrer"));await until(()=>c.textContent!.includes("Une zone est déjà couverte"));
  assert.ok(!c.textContent!.includes('B234_INVALID_ZONES'));
  assert.equal((await db.query('select id from restaurant_sale_mode_fulfillments where restaurant_id=$1',[A])).rows.length,1);
  await click(button(container,"Annuler la création"));
});

test("B234 UI creates fallback, reorders, and previews the actual resolver without creating an order",async()=>{
  await click(button(container,"Ajouter une zone"));const c=card("Ajouter une zone");
  await change(field(c,"Nom de la règle"),"Reste du territoire");await change(field(c,"Frais de livraison"),"18.9");
  await click(field(c,"Règle de repli"));await change(field(c,"Prestataire"),"chronofresh");
  await click(button(c,"Enregistrer"));await until(()=>!![...container.querySelectorAll('h3')].find(e=>e.textContent==='Reste du territoire'));
  await click(button(card("Reste du territoire"),"↑ Monter"));await until(()=>container.querySelector('[data-delivery-rule] h3')?.textContent==='Reste du territoire');
  await change(field(tester(),"Code postal"),"69001");await click(button(tester(),"Tester"));
  await until(()=>tester().textContent!.includes('18.90'));assert.match(tester().textContent!,/chronofresh/);
  assert.equal((await db.query('select id from orders')).rows.length,0);
  const call=calls.filter(c=>c.name==='test_merchant_delivery_postcode').at(-1)!;
  assert.deepEqual(call.args,{p_restaurant_id:A,p_postal_code:'69001',p_country_code:'FR',p_subtotal:0,p_total_count:1});
});

test("B234 UI edits threshold and free pricing; tester uses saved server values",async()=>{
  const c=card("Paris 18");await change(field(c,"Mode de tarification"),"free_above_threshold");
  await change(field(c,"Gratuit à partir de"),"100");await click(button(c,"Enregistrer"));await until(()=>c.textContent!.includes('Enregistré'));
  await change(field(tester(),"Code postal"),"75018");await change(field(tester(),"Montant des produits (devise du magasin)"),"100");
  await click(button(tester(),"Tester"));await until(()=>tester().textContent!.includes('0.00'));
  await change(field(c,"Mode de tarification"),"free");await click(button(c,"Enregistrer"));await until(()=>c.textContent!.includes('Enregistré'));
  assert.equal((await db.query<Record<string,any>>("select pricing_mode from restaurant_sale_mode_fulfillments where fulfillment_code='Paris 18'")).rows[0].pricing_mode,'free');
});

test("B234 UI ignores late tester results after input change and A -> B -> A",async()=>{
  holdTester=true;await change(field(tester(),"Code postal"),"69001");await click(button(tester(),"Tester"));await until(()=>releaseTester!==null);
  await change(field(tester(),"Code postal"),"75018");await React.act(async()=>{releaseTester!();await tick();});releaseTester=null;
  assert.ok(!tester().textContent!.includes('18.90'));
  await click(button(tester(),"Tester"));await until(()=>releaseTester!==null);
  await change(field(container,"Tenant"),B);await until(()=>!!tester());await change(field(container,"Tenant"),A);await until(()=>!!tester());
  await React.act(async()=>{releaseTester!();await tick();});holdTester=false;releaseTester=null;
  assert.ok(!tester().querySelector('dl'));
});

test("B234 UI permits disabling every rule and explains the unchanged legacy path",async()=>{
  confirmationAnswer=true;
  for(const name of ['Paris 18','Reste du territoire']){const c=card(name);await click(field(c,"Active"));await click(button(c,"Enregistrer"));await until(()=>c.textContent!.includes('Enregistré'));}
  await change(field(tester(),"Code postal"),"75018");await click(button(tester(),"Tester"));
  await until(()=>tester().textContent!.includes('Aucune règle active'));
  assert.ok(!tester().querySelector('dl'));
});

for(const legacy of [null,[],['75']]) test(`B234 UI last-active confirmation uses server legacy ${JSON.stringify(legacy)}; cancel never mutates`,async()=>{
  await db.query("update restaurant_sale_modes set config=jsonb_build_object('delivery_zone_prefixes',$2::jsonb) where restaurant_id=$1 and mode_code='delivery'",[A,JSON.stringify(legacy)]);
  const c=card('Paris 18');
  const initial=confirmations.length;
  await click(field(c,'Active'));await click(button(c,'Enregistrer'));await until(()=>c.textContent!.includes('Enregistré'));
  assert.equal(confirmations.length,initial,'reactivation must not warn');
  await click(field(c,'Active'));
  const mutations=()=>calls.filter(x=>x.name==='mutate_merchant_delivery_rule').length;
  const before=mutations();confirmationAnswer=false;
  await click(button(c,'Enregistrer'));await until(()=>confirmations.length>initial);
  assert.equal(mutations(),before,'cancel must occur before any mutation');
  assert.equal((await db.query<{enabled:boolean}>("select enabled from restaurant_sale_mode_fulfillments where restaurant_id=$1 and fulfillment_code='Paris 18'",[A])).rows[0].enabled,true);
  const warning=confirmations.at(-1)!;
  assert.match(warning,legacy?.length?/anciennes zones.*tarifaire historique.*France/:/Sans zones historiques.*indisponible/);
  assert.doesNotMatch(warning,/gratuite/);
  confirmationAnswer=true;await click(button(c,'Enregistrer'));await until(()=>c.textContent!.includes('Enregistré'));
  assert.equal(mutations(),before+1);
  assert.equal((await db.query<{enabled:boolean}>("select enabled from restaurant_sale_mode_fulfillments where restaurant_id=$1 and fulfillment_code='Paris 18'",[A])).rows[0].enabled,false);
  assert.equal(calls.at(-1)!.name,'get_merchant_delivery_fulfillment_pricing');
});

test('B234 UI no last-active warning when another active rule remains, or on creation',async()=>{
  const start=confirmations.length;
  for(const name of ['Paris 18','Reste du territoire']) {const c=card(name);await click(field(c,'Active'));await click(button(c,'Enregistrer'));await until(()=>c.textContent!.includes('Enregistré'));}
  const c=card('Paris 18');await click(field(c,'Active'));await click(button(c,'Enregistrer'));await until(()=>c.textContent!.includes('Enregistré'));
  assert.equal(confirmations.length,start);
  await click(button(container,'Ajouter une zone'));const fresh=card('Ajouter une zone');
  await change(field(fresh,'Nom de la règle'),'Creation after transition');await change(field(fresh,'Codes postaux / préfixes'),'92');await change(field(fresh,'Frais de livraison'),'5');
  await click(button(fresh,'Enregistrer'));await until(()=>!![...container.querySelectorAll('h3')].find(e=>e.textContent==='Creation after transition'));
  assert.equal(confirmations.length,start);
});

test('B234 UI requires a fresh warning when legacy state changes after preview',async()=>{
  const other=card('Creation after transition');await click(field(other,'Active'));await click(button(other,'Enregistrer'));await until(()=>other.textContent!.includes('Enregistré'));
  const c=card('Reste du territoire');await click(field(c,'Active'));
  changeLegacyAfterPreview=true;confirmationAnswer=true;
  await click(button(c,'Enregistrer'));await until(()=>c.textContent!.includes('La configuration a changé'));
  assert.match(confirmations.at(-1)!,/anciennes zones/);
  assert.equal((await db.query<{enabled:boolean}>("select enabled from restaurant_sale_mode_fulfillments where restaurant_id=$1 and fulfillment_code='Reste du territoire'",[A])).rows[0].enabled,true);
  await click(button(c,'Enregistrer'));await until(()=>c.textContent!.includes('Enregistré'));
  assert.match(confirmations.at(-1)!,/Sans zones historiques.*indisponible/);
});
