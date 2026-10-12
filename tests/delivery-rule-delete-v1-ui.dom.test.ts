// DELIVERY RULE DELETE v1 -- the real React page -> real dashboard services -> real B5 + delete SQL (PGlite).
// Only the Supabase transport, login and navigation shell are replaced locally (same harness as B234 UI).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { makeBaseline as makeDeliveryDb, readSql as sqlFile } from "../supabase/tests/b5/bootstrap.mjs";

const db = await makeDeliveryDb();
await db.exec(sqlFile("DRAFT-lot-delivery-pricing-v2-b5.sql"));
await db.exec(sqlFile("DRAFT-lot-delivery-rule-delete-v1.sql"));
const A="00000000-0000-4000-8000-000000000301", B="00000000-0000-4000-8000-000000000302", user="00000000-0000-4000-8000-000000000303";
await db.exec(`insert into auth.users(id,email) values ('${user}','del-ui@example.test');
  insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Fixture A','del-ui-a','active',true,'FR'),('${B}','Fixture B','del-ui-b','active',true,'FR');
  insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${user}','owner'),('${B}','${user}','owner');
  insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${B}','delivery',true,'{}');
  insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR'),('${B}','FR');`);
async function seed(rid:string, code:string, order:number, extra:{enabled?:boolean; fallback?:boolean; zones?:string[]}={}) {
  return (await db.query<{id:string}>(`insert into restaurant_sale_mode_fulfillments(restaurant_id,mode_code,fulfillment_code,provider,zone_prefixes,is_fallback,enabled,display_order,pricing_mode,fixed_fee,customer_text)
    values ($1,'delivery',$2,'internal',$3,$4,$5,$6,'fixed',5,$7) returning id`,[rid,code,extra.zones??[],extra.fallback??false,extra.enabled??true,order,`Texte ${code}`])).rows[0].id;
}
const dom = new JSDOM("<!doctype html><html><body></body></html>", {url:`http://localhost/dashboard/delivery-pricing?r=${A}`,pretendToBeVisual:true});
const {window}=dom;
(globalThis as any).window=window; (globalThis as any).document=window.document;
Object.defineProperty(globalThis,"navigator",{value:window.navigator,configurable:true});
(globalThis as any).HTMLElement=window.HTMLElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const React=await import("react"); const {createRoot}=await import("react-dom/client");
const confirmations:string[]=[]; let confirmationAnswer=false;
let confirmHook:(()=>void)|null=null;
window.confirm=(message?:string)=>{confirmations.push(message??"");confirmHook?.();return confirmationAnswer;};
const calls:Array<{name:string; args:Record<string,any>}>=[];
let hold:((name:string,args:Record<string,any>)=>boolean)|null=null; let release:(()=>void)|null=null;
let operator=false;
const signatures:Record<string,{keys:string[]; scalar?:boolean}>={
  preview_merchant_delivery_rule_save:{keys:["p_restaurant_id","p_rule_id","p_enabled"],scalar:true},
  get_merchant_delivery_fulfillment_pricing:{keys:["p_restaurant_id"]},
  get_merchant_delivery_method_notices:{keys:["p_restaurant_id"]},
  get_restaurant_public_delivery_countries:{keys:["p_restaurant_id"]},
  mutate_merchant_delivery_rule:{keys:["p_restaurant_id","p_action","p_rule_id","p_payload"],scalar:true},
  test_merchant_delivery_postcode:{keys:["p_restaurant_id","p_postal_code","p_country_code","p_subtotal","p_total_count"],scalar:true},
};
(globalThis as any).__dtrTransport={
  from(table:string) {
    assert.equal(table,"restaurant_users");
    return {select:()=>({order:async()=>{
      const rows=(await db.query<Record<string,any>>("select restaurant_id,role from restaurant_users where user_id=$1",[user])).rows;
      return {data:rows.map(r=>({restaurant_id:r.restaurant_id,role:r.role,restaurants:{id:r.restaurant_id,name:r.restaurant_id===A?"Fixture A":"Fixture B",slug:r.restaurant_id}})),error:null};
    }})};
  },
  async rpc(name:string,args:Record<string,any>) {
    calls.push({name,args}); const spec=signatures[name]; assert.ok(spec,`unexpected RPC: ${name}`);
    try {
      const result=await db.transaction(async tx=>{
        await tx.query("select set_config('test.uid',$1,true)",[user]); await tx.exec("set local role authenticated");
        return tx.query<Record<string,any>>(`select ${spec.scalar?'':'* from '}${name}(${spec.keys.map((_,i)=>`$${i+1}`).join(',')})${spec.scalar?' as value':''}`,spec.keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]));
      });
      const response={data:spec.scalar?result.rows[0].value:result.rows,error:null};
      if(hold&&hold(name,args)) await new Promise<void>(resolve=>{release=resolve;});
      return response;
    }catch(error:any){return {data:null,error:{message:error.message,details:error.detail??null}};}
  },
};
const mocks:Record<string,string>={
  "@/lib/supabase":"export const supabase=globalThis.__dtrTransport;",
  "next/navigation":'const router={replace(){},push(){}}; export const useRouter=()=>router;',
  "@/lib/services/auth":`export async function getUser(){return {id:'${user}'}}`,
  "@/lib/services/establishments":"export async function isScanymOperator(){return globalThis.__dtrOperator()} export async function getEstablishmentSummary(){return null}",
  "@/components/dashboard/DashboardNav":'export default function Nav(p){return <label>Tenant<select value={p.restaurantId} onChange={e=>p.onSelectRestaurant(e.target.value)}>{p.mappings.map(m=><option key={m.restaurant_id} value={m.restaurant_id}>{m.restaurants.name}</option>)}</select></label>}',
};
(globalThis as any).__dtrOperator=()=>operator;
const built=await esbuild.build({stdin:{contents:'export {default as Page} from "@/app/dashboard/delivery-pricing/page";',resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,format:"esm",jsx:"automatic",target:"es2022",external:["react","react-dom","react-dom/client"],plugins:[{name:"local-transport",setup(build){
  build.onResolve({filter:/.*/},args=>{
    if(mocks[args.path]) return {path:args.path,namespace:"fixture"};
    if(args.path.startsWith("@/")){const base=path.resolve(args.path.slice(2));return {path:["",".tsx",".ts"].map(x=>base+x).find(existsSync)??base};}
  });
  build.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:mocks[args.path],loader:"tsx"}));
}}]});
const tmp=mkdtempSync(path.resolve("tests/tmp-dtr-")); const file=path.join(tmp,"page.mjs");writeFileSync(file,built.outputFiles[0].text);
const {Page}=await import(pathToFileURL(file).href);rmSync(tmp,{recursive:true,force:true});
let container:HTMLElement, root:any;
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(check:()=>boolean){for(let i=0;i<150;i++){await React.act(tick);if(check())return;}assert.fail("UI condition timed out: "+(container?container.textContent?.slice(0,300):""));}
async function click(el:Element){await React.act(async()=>{(el as HTMLElement).click();await tick();});}
async function change(el:Element,value:string){await React.act(async()=>{
  const proto=el.tagName==='SELECT'?window.HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(el,value);
  el.dispatchEvent(new window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await tick();
});}
function button(scope:ParentNode,text:string){const b=[...scope.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);assert.ok(b,text);return b;}
function field(scope:ParentNode,label:string){const l=[...scope.querySelectorAll('label')].find(l=>{const copy=l.cloneNode(true) as Element;copy.querySelectorAll('input,textarea,select').forEach(e=>e.remove());return copy.textContent?.trim()===label;});assert.ok(l,label);const el=l.querySelector('input,textarea,select')??window.document.getElementById(l.htmlFor);assert.ok(el,label);return el;}



const cardNames=()=>[...container.querySelectorAll('[data-delivery-rule] h3')].map(h=>h.textContent);
const cardOf=(code:string)=>{const c=[...container.querySelectorAll('[data-delivery-rule]')].find(c=>c.querySelector('h3')?.textContent===code);assert.ok(c,code);return c;};
const deleteButton=(code:string)=>cardOf(code).querySelector<HTMLButtonElement>('[data-delete-rule]');
async function unmountPage(){if(root){await React.act(()=>root.unmount());container.remove();root=null;}}
async function mountPage(){
  if(root){await React.act(()=>root.unmount());container.remove();}
  container=window.document.createElement("div");window.document.body.append(container);root=createRoot(container);
  await React.act(async()=>{root.render(React.createElement(Page));await tick();});
  await until(()=>!!container.querySelector('[aria-labelledby="postcode-test-title"]')||!!container.querySelector('[data-delivery-rule]')||container.textContent!.includes('Aucune'));
}
after(async()=>{if(root)await React.act(()=>root.unmount());dom.window.close();await db.close();});
const count=(name:string,action?:string)=>calls.filter(c=>c.name===name&&(!action||c.args.p_action===action)).length;
const dbRules=async(rid=A)=>(await db.query<Record<string,any>>("select id,fulfillment_code,enabled from restaurant_sale_mode_fulfillments where restaurant_id=$1 order by display_order",[rid])).rows;
const resetRules=async()=>{await db.query("delete from restaurant_sale_mode_fulfillments");await db.query("update restaurant_sale_modes set config='{}' where mode_code='delivery'");};

test("delete is offered on every SAVED rule, never on the unsaved new-rule card",async()=>{
  const a1=await seed(A,"Zone 75",1,{zones:["75"]}); await seed(A,"Zone 92",2,{zones:["92"]}); await seed(A,"Reste",3,{fallback:true});
  await mountPage();
  assert.deepEqual(cardNames().length,3);
  for(const n of ["Zone 75","Zone 92","Reste"]) {const b=deleteButton(n);assert.ok(b,n);assert.equal(b!.textContent,"Supprimer la règle");assert.equal(b!.getAttribute("data-delete-rule")!.length>10,true);}
  await click(button(container,"Ajouter une zone"));
  const fresh=cardOf("Ajouter une zone");assert.equal(fresh.querySelector('[data-delete-rule]'),null,"no delete on an unsaved rule");
  assert.equal(deleteButton("Zone 75")!.disabled,true,"disabled while a creation is in progress");
  await click(button(container,"Annuler la création"));
  assert.equal(deleteButton("Zone 75")!.disabled,false);void a1;
});

test("cancel the confirmation: no mutation, rule kept; confirm: the right (restaurant, rule) pair is deleted, list re-read from the server",async()=>{
  const before=await dbRules();const target=before.find(r=>r.fulfillment_code==="Zone 92")!;
  confirmationAnswer=false;const c0=confirmations.length,m0=count("mutate_merchant_delivery_rule");
  await click(deleteButton("Zone 92")!);await until(()=>confirmations.length>c0);
  assert.equal(confirmations.at(-1),"Supprimer cette règle de livraison ? Elle ne sera plus utilisée pour calculer les frais et l’éligibilité futurs. Les commandes déjà enregistrées ne seront pas supprimées.");
  await React.act(tick);
  assert.equal(count("mutate_merchant_delivery_rule"),m0,"cancel never mutates");
  assert.equal((await dbRules()).length,3);assert.deepEqual(cardNames().length,3);
  confirmationAnswer=true;const l0=count("get_merchant_delivery_fulfillment_pricing");
  await click(deleteButton("Zone 92")!);await until(()=>!cardNames().includes("Zone 92"));
  const del=calls.filter(c=>c.name==="mutate_merchant_delivery_rule"&&c.args.p_action==="delete");
  assert.equal(del.length,1);assert.deepEqual(del[0].args,{p_restaurant_id:A,p_action:"delete",p_rule_id:target.id,p_payload:{}});
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),l0+1,"server truth re-read");
  assert.deepEqual((await dbRules()).map(r=>r.fulfillment_code),["Zone 75","Reste"]);
  assert.ok(container.querySelector('[data-delivery-rule-deleted]')!.textContent!.includes("Règle supprimée"));
  assert.equal(confirmations.length,c0+2,"one standard confirmation per attempt (cancelled + accepted)");
});

test("deleting a disabled rule while others are active shows only the standard confirmation, no legacy transition",async()=>{
  await resetRules();await seed(A,"On",1,{zones:["75"]});await seed(A,"Off",2,{zones:["92"],enabled:false});await mountPage();
  confirmationAnswer=true;const c0=confirmations.length;
  await click(deleteButton("Off")!);await until(()=>!cardNames().includes("Off"));
  assert.match(confirmations[c0],/^Supprimer cette règle de livraison \?/);
  const del=calls.filter(c=>c.args.p_action==="delete").at(-1)!;assert.deepEqual(del.args.p_payload,{});
});

for(const legacy of [null,["75"]]) test(`LAST ACTIVE rule warns with the server transition (legacy ${JSON.stringify(legacy)}), cancel is safe, confirm sends the echoed transition`,async()=>{
  await resetRules();await seed(A,"Seule",1,{zones:["75"]});await seed(A,"Inactive",2,{zones:["92"],enabled:false});
  await db.query("update restaurant_sale_modes set config=jsonb_build_object('delivery_zone_prefixes',$2::jsonb) where restaurant_id=$1 and mode_code='delivery'",[A,JSON.stringify(legacy)]);
  await mountPage();
  const expected=legacy?"legacy-zones":"legacy-unavailable";
  confirmationAnswer=false;const c0=confirmations.length,m0=count("mutate_merchant_delivery_rule");
  await click(deleteButton("Seule")!);await until(()=>confirmations.length>c0);
  const warning=confirmations.at(-1)!;
  assert.match(warning,/dernière règle de livraison active/);
  assert.match(warning,legacy?/anciennes zones.*tarifaire historique.*France/:/Sans zones historiques.*indisponible/);
  assert.match(warning,/commandes déjà enregistrées ne seront pas supprimées/);
  await React.act(tick);assert.equal(count("mutate_merchant_delivery_rule"),m0,"cancel before any mutation");assert.equal((await dbRules()).length,2);
  confirmationAnswer=true;
  await click(deleteButton("Seule")!);await until(()=>!cardNames().includes("Seule"));
  const del=calls.filter(c=>c.args.p_action==="delete").at(-1)!;assert.deepEqual(del.args.p_payload,{legacyConfirmation:expected});
  assert.deepEqual((await dbRules()).map(r=>r.fulfillment_code),["Inactive"]);
});

test("the only remaining rule, disabled: strong 'last rule' wording, no invented legacy outcome, deletion succeeds",async()=>{
  await mountPage();confirmationAnswer=true;const c0=confirmations.length;
  await click(deleteButton("Inactive")!);await until(()=>cardNames().length===0);
  assert.match(confirmations[c0],/dernière règle de livraison configurée/);assert.doesNotMatch(confirmations[c0],/active|indisponible|anciennes zones/);
  assert.equal(calls.filter(c=>c.args.p_action==="delete").at(-1)!.args.p_payload.legacyConfirmation,undefined);
  assert.equal((await dbRules()).length,0);
});

test("server-side confirmation drift (legacy config changes after the preview) is refused with a translated message and keeps the rule",async()=>{
  await resetRules();await seed(A,"Seule",1,{zones:["75"]});await db.query("update restaurant_sale_modes set config='{\"delivery_zone_prefixes\":[\"75\"]}' where restaurant_id=$1 and mode_code='delivery'",[A]);
  await mountPage();confirmationAnswer=true;
  hold=(name)=>name==="preview_merchant_delivery_rule_save";
  await click(deleteButton("Seule")!);await until(()=>release!==null);
  await db.query("update restaurant_sale_modes set config='{}' where restaurant_id=$1 and mode_code='delivery'",[A]);
  hold=null;await React.act(async()=>{release!();release=null;await tick();});
  await until(()=>container.textContent!.includes("La configuration a changé"));
  assert.equal((await dbRules()).length,1,"rule kept");
  assert.ok(!container.textContent!.includes("B234_CONFIRM_LEGACY_REQUIRED"),"no raw server code");
});

test("a rule already deleted elsewhere fails safely: translated refusal, list re-read",async()=>{
  await resetRules();const gone=await seed(A,"Fantôme",1,{zones:["75"]});await seed(A,"Reste",2,{fallback:true});await mountPage();confirmationAnswer=true;
  await db.query("delete from restaurant_sale_mode_fulfillments where id=$1",[gone]);
  await click(deleteButton("Fantôme")!);await until(()=>!cardNames().includes("Fantôme"));
  assert.ok(container.textContent!.includes("Suppression refusée"));
  assert.ok(!container.textContent!.includes("Delivery rule unavailable"));
  assert.deepEqual((await dbRules()).map(r=>r.fulfillment_code),["Reste"]);
});

test("ordinary staff sees no delete action and the server refuses a forged call",async()=>{
  await resetRules();const r=await seed(A,"Zone",1,{zones:["75"]});await seed(A,"Zone 2",2,{zones:["92"]});
  await db.query("update restaurant_users set role='staff' where restaurant_id=$1 and user_id=$2",[A,user]);
  await mountPage();
  assert.equal(container.querySelectorAll('[data-delete-rule]').length,0);
  const direct=await (globalThis as any).__dtrTransport.rpc("mutate_merchant_delivery_rule",{p_restaurant_id:A,p_action:"delete",p_rule_id:r,p_payload:{}});
  assert.match(direct.error.message,/Not authorized/);assert.equal((await dbRules()).length,2);
  await db.query("update restaurant_users set role='manager' where restaurant_id=$1 and user_id=$2",[A,user]);
  await mountPage();assert.equal(container.querySelectorAll('[data-delete-rule]').length,2,"manager can delete");
  await db.query("update restaurant_users set role='owner' where restaurant_id=$1 and user_id=$2",[A,user]);
});

test("operator without a membership can delete the targeted establishment",async()=>{
  await db.query("delete from restaurant_users where restaurant_id=$1 and user_id=$2",[A,user]);
  await db.query("insert into scanym_operators(user_id) values ($1) on conflict do nothing",[user]);operator=true;
  await mountPage();confirmationAnswer=true;
  assert.ok(deleteButton("Zone 2"));
  await click(deleteButton("Zone 2")!);await until(()=>!cardNames().includes("Zone 2"));
  assert.deepEqual((await dbRules()).map(r=>r.fulfillment_code),["Zone"]);
  operator=false;await db.query("delete from scanym_operators where user_id=$1",[user]);
  await db.query("insert into restaurant_users(restaurant_id,user_id,role) values ($1,$2,'owner')",[A,user]);
});

test("STALE A->B: switching tenant while the transition preview is in flight abandons the delete (no confirm, no mutation, B untouched)",async()=>{
  await resetRules();await seed(A,"A1",1,{zones:["75"]});await seed(A,"A2",2,{zones:["92"]});await seed(B,"B1",1,{zones:["13"]});await seed(B,"B2",2,{zones:["31"]});
  await mountPage();confirmationAnswer=true;
  hold=(name,args)=>name==="preview_merchant_delivery_rule_save"&&args.p_restaurant_id===A;
  const c0=confirmations.length,m0=count("mutate_merchant_delivery_rule");
  await click(deleteButton("A1")!);await until(()=>release!==null);
  await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  hold=null;await React.act(async()=>{release!();release=null;await tick();});await React.act(tick);
  assert.equal(confirmations.length,c0,"no confirmation shown for a stale context");
  assert.equal(count("mutate_merchant_delivery_rule"),m0);
  assert.deepEqual(cardNames(),["B1","B2"]);assert.equal(container.querySelector('[data-delivery-rule-deleted]'),null);
  assert.equal((await dbRules(A)).length,2);assert.equal((await dbRules(B)).length,2);
});

test("STALE A->B: switching tenant while the DELETE is in flight never writes A's outcome into B's UI",async()=>{
  await change(field(container,"Tenant"),A);await until(()=>cardNames().includes("A1"));
  confirmationAnswer=true;
  hold=(name,args)=>name==="mutate_merchant_delivery_rule"&&args.p_action==="delete";
  await click(deleteButton("A1")!);await until(()=>release!==null);
  await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  const loads0=count("get_merchant_delivery_fulfillment_pricing");
  hold=null;await React.act(async()=>{release!();release=null;await tick();});await React.act(tick);await React.act(tick);
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A2"],"the already-sent server mutation is neither undone nor compensated");
  assert.deepEqual(cardNames(),["B1","B2"],"B's list intact");
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),loads0,"no stale reload");
  assert.equal(container.querySelector('[data-delivery-rule-deleted]'),null,"no success notice in B");
  assert.ok(!container.textContent!.includes("Suppression refusée"));
});

test("STALE B->A and A->B->A (ABA): the delete started in the FIRST visit of a tenant stays stale after returning",async()=>{
  await resetRules();await seed(A,"A1",1,{zones:["75"]});await seed(A,"A2",2,{zones:["92"]});await seed(B,"B1",1,{zones:["13"]});await seed(B,"B2",2,{zones:["31"]});
  await mountPage();await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  await change(field(container,"Tenant"),A);await until(()=>cardNames().includes("A1"));
  confirmationAnswer=true;
  hold=(name,args)=>name==="mutate_merchant_delivery_rule"&&args.p_action==="delete";
  await click(deleteButton("A2")!);await until(()=>release!==null);
  await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  await change(field(container,"Tenant"),A);await until(()=>cardNames().includes("A1"));
  const loads0=count("get_merchant_delivery_fulfillment_pricing");
  hold=null;await React.act(async()=>{release!();release=null;await tick();});await React.act(tick);
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),loads0,"ABA: restaurant id alone is not enough, the generation is stale");
  assert.equal(container.querySelector('[data-delivery-rule-deleted]'),null);
  assert.equal((await dbRules(A)).length,1,"server mutation did happen");
  // B -> A mirror: delete in B while in flight, jump to A.
  await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  hold=(name,args)=>name==="mutate_merchant_delivery_rule"&&args.p_action==="delete";
  await click(deleteButton("B2")!);await until(()=>release!==null);
  await change(field(container,"Tenant"),A);await until(()=>cardNames().includes("A1"));
  hold=null;await React.act(async()=>{release!();release=null;await tick();});await React.act(tick);
  assert.deepEqual(cardNames(),["A1"],"A's list is not replaced by B's outcome");
  assert.equal(container.querySelector('[data-delivery-rule-deleted]'),null);
});

// ---------------------------------------------------------------- DTR-AUDIT-01
// UNMOUNT / REMOUNT: restaurant + generation do not prove the ORIGINATING INSTANCE is still alive.
async function seedTwoTenants(){
  await resetRules();await seed(A,"A1",1,{zones:["75"]});await seed(A,"A2",2,{zones:["92"]});await seed(B,"B1",1,{zones:["13"]});await seed(B,"B2",2,{zones:["31"]});
  confirmationAnswer=true;hold=null;release=null;confirmHook=null;
}
const settle=async()=>{for(let i=0;i<4;i++)await React.act(tick);};
const noStaleUi=()=>{assert.equal(container.querySelector('[data-delivery-rule-deleted]'),null,"no success notice");assert.ok(!container.textContent!.includes("Suppression refusée"),"no delete error notice");};

test("DTR-AUDIT-01 / 1. UNMOUNT then a NEW instance on B: the abandoned preview cannot confirm, delete, reload or write state",async()=>{
  await seedTwoTenants();await mountPage();
  hold=(name,args)=>name==="preview_merchant_delivery_rule_save"&&args.p_restaurant_id===A;
  const c0=confirmations.length,d0=count("mutate_merchant_delivery_rule","delete");
  await click(deleteButton("A1")!);await until(()=>release!==null);
  await unmountPage();hold=null;
  await mountPage();await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  const loads0=count("get_merchant_delivery_fulfillment_pricing");
  await React.act(async()=>{release!();release=null;await tick();});await settle();
  assert.equal(confirmations.length,c0,"no confirmation from the abandoned instance");
  assert.equal(count("mutate_merchant_delivery_rule","delete"),d0,"no DELETE from the abandoned instance");
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),loads0,"no load()");
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A1","A2"]);assert.deepEqual((await dbRules(B)).map(r=>r.fulfillment_code),["B1","B2"]);
  assert.deepEqual(cardNames(),["B1","B2"]);noStaleUi();
});

test("DTR-AUDIT-01 / 2. UNMOUNT then A -> B -> A in the NEW instance: the abandoned preview still cannot confirm or delete",async()=>{
  await seedTwoTenants();await mountPage();
  hold=(name,args)=>name==="preview_merchant_delivery_rule_save"&&args.p_restaurant_id===A;
  const c0=confirmations.length,d0=count("mutate_merchant_delivery_rule","delete");
  await click(deleteButton("A1")!);await until(()=>release!==null);
  await unmountPage();hold=null;
  await mountPage();await change(field(container,"Tenant"),B);await until(()=>cardNames().includes("B1"));
  await change(field(container,"Tenant"),A);await until(()=>cardNames().includes("A1"));
  const loads0=count("get_merchant_delivery_fulfillment_pricing");
  await React.act(async()=>{release!();release=null;await tick();});await settle();
  assert.equal(confirmations.length,c0);assert.equal(count("mutate_merchant_delivery_rule","delete"),d0);
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),loads0);
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A1","A2"]);
  assert.deepEqual(cardNames(),["A1","A2"],"the new A view stays consistent with the database");noStaleUi();
  // and the NEW instance still works normally afterwards
  await click(deleteButton("A2")!);await until(()=>!cardNames().includes("A2"));
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A1"]);
});

test("DTR-AUDIT-01 / 2b. UNMOUNT + a new instance on the SAME tenant (no navigation): the abandoned preview is still dead",async()=>{
  await seedTwoTenants();await mountPage();
  hold=(name,args)=>name==="preview_merchant_delivery_rule_save"&&args.p_restaurant_id===A;
  const c0=confirmations.length,d0=count("mutate_merchant_delivery_rule","delete");
  await click(deleteButton("A1")!);await until(()=>release!==null);
  await unmountPage();hold=null;await mountPage();
  await React.act(async()=>{release!();release=null;await tick();});await settle();
  assert.equal(confirmations.length,c0);assert.equal(count("mutate_merchant_delivery_rule","delete"),d0);
  assert.deepEqual((await dbRules(A)).length,2);assert.deepEqual(cardNames(),["A1","A2"]);noStaleUi();
});

test("DTR-AUDIT-01 / 3. UNMOUNT inside the confirmation (answer = OK) but before dispatch: DELETE is never sent",async()=>{
  await seedTwoTenants();await mountPage();
  const d0=count("mutate_merchant_delivery_rule","delete"),loads0=count("get_merchant_delivery_fulfillment_pricing");
  // The user accepts, but the instance is torn down at that very moment (synchronously, inside confirm()).
  confirmHook=()=>{root.unmount();};
  const c0=confirmations.length;
  await click(deleteButton("A1")!);await until(()=>confirmations.length>c0);await settle();
  confirmHook=null;root=null;container.remove();
  assert.equal(count("mutate_merchant_delivery_rule","delete"),d0,"the check right before deleteMerchantDeliveryRule is permanent");
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),loads0);
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A1","A2"]);
});

test("DTR-AUDIT-01 / 3b. CONTROL: a still-mounted, still-current instance accepting the same confirmation dispatches exactly one DELETE",async()=>{
  await seedTwoTenants();await mountPage();
  const d0=count("mutate_merchant_delivery_rule","delete"),c0=confirmations.length;
  await click(deleteButton("A1")!);await until(()=>confirmations.length>c0);await until(()=>!cardNames().includes("A1"));
  assert.equal(count("mutate_merchant_delivery_rule","delete"),d0+1);
});

test("DTR-AUDIT-01 / 4. UNMOUNT while the DELETE is already in flight: not compensated, no reload, no state write, new instance not polluted",async()=>{
  await seedTwoTenants();await mountPage();
  hold=(name,args)=>name==="mutate_merchant_delivery_rule"&&args.p_action==="delete";
  await click(deleteButton("A1")!);await until(()=>release!==null);
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A2"],"the server already executed the DELETE");
  await unmountPage();hold=null;await mountPage();
  await until(()=>cardNames().length===1);
  const loads0=count("get_merchant_delivery_fulfillment_pricing"),m0=count("mutate_merchant_delivery_rule");
  await React.act(async()=>{release!();release=null;await tick();});await settle();
  assert.equal(count("get_merchant_delivery_fulfillment_pricing"),loads0,"the abandoned instance performs NO reload");
  assert.equal(count("mutate_merchant_delivery_rule"),m0,"nothing compensating / re-sent");
  assert.deepEqual((await dbRules(A)).map(r=>r.fulfillment_code),["A2"],"the already-sent mutation is neither undone nor repeated");
  assert.deepEqual(cardNames(),["A2"]);noStaleUi();
});
