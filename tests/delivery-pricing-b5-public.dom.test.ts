// Real public RPC -> service -> resolver -> CartPanel -> real create_order.
// Only transport and the browser platform are provided by the local harness.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';
import { makeBaseline, readSql, migrationFile } from '../supabase/tests/b5/bootstrap.mjs';
const db=await makeBaseline();await db.exec(readSql(migrationFile));
const A='b5d00000-0000-4000-8000-000000000001', U='b5d00000-0000-4000-8000-000000000002', I='b5d00000-0000-4000-8000-000000000003', C='b5d00000-0000-4000-8000-000000000004';
await db.exec(`insert into auth.users(id,email) values ('${U}','public@example.test');
 insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Public fixture','b5-dom','active',true,'FR');
 insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${U}','owner');
 insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number) values ('${A}','+33600000000','EUR',1);
 insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${A}','pickup',true,'{}');
 insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR');
 insert into menu_categories(id,restaurant_id,name) values ('${C}','${A}','Products');
 insert into menu_items(id,category_id,name,price,tax_rate,is_available) values ('${I}','${C}','Product',12.4,5.5,true);`);
async function anon(sql:string,args:unknown[]=[]){return db.transaction(async tx=>{await tx.exec('set local role anon');return tx.query<Record<string,any>>(sql,args);});}
let rule:string|null=null;
async function save(discountEnabled=false,discountThreshold:number|null=null,discountPercentage:number|null=null){
 rule=String((await db.transaction(async tx=>{await tx.query("select set_config('test.uid',$1,true)",[U]);await tx.exec('set local role authenticated');
 return tx.query<Record<string,any>>("select mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb) id",[A,rule,JSON.stringify({fulfillmentCode:'secret-routing',provider:'chronofresh',zones:['75013'],enabled:true,isFallback:false,pricingMode:'fixed',fixedFee:18.9,freeThreshold:null,minItems:null,customerText:'Livraison à votre adresse.',discountEnabled,discountThreshold,discountPercentage})]);})).rows[0].id);
}
await save();
(globalThis as any).__b5PublicTransport={async rpc(name:string,args:any){assert.equal(name,'get_restaurant_public_delivery_fulfillments');return {data:(await anon('select * from get_restaurant_public_delivery_fulfillments($1)',[args.p_restaurant_id])).rows,error:null};}};
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/menu/b5-dom',pretendToBeVisual:true});const {window}=dom;
(globalThis as any).window=window;(globalThis as any).document=window.document;Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
(globalThis as any).HTMLElement=window.HTMLElement;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};
const React=await import('react');const {createRoot}=await import('react-dom/client');
const built=await esbuild.build({stdin:{contents:`export {default as CartPanel} from '@/components/CartPanel';export {DeliveryConditionsButton} from '@/components/DeliveryConditions';export {I18nProvider} from '@/lib/i18n-context';export {getPublicDeliveryFulfillments} from '@/lib/sale-modes-public';export {resolveDeliveryFulfillment,deliveryStatusFromFulfillmentResult} from '@/lib/delivery';export {EMPTY_INVOICE_REQUEST} from '@/lib/invoice-request';export {formatPrice} from '@/lib/whatsapp';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'esm',jsx:'automatic',target:'es2022',external:['react','react-dom','react-dom/client'],plugins:[{name:'transport',setup(build){build.onResolve({filter:/.*/},args=>{
 if(args.path==='@/lib/supabase')return {path:args.path,namespace:'fixture'};
 if(args.path.startsWith('@/')){const base=path.resolve(args.path.slice(2));return {path:['','.tsx','.ts'].map(x=>base+x).find(existsSync)??base};}
 });build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const supabase=globalThis.__b5PublicTransport;',loader:'js'}));}}]});
const file=path.resolve(`tests/.b5-public-${process.pid}.mjs`);writeFileSync(file,built.outputFiles[0].text);const mod=await import(pathToFileURL(file).href);unlinkSync(file);
const container=window.document.createElement('div');window.document.body.append(container);const root=createRoot(container);const noop=()=>{};
const customer={name:'Ada Lovelace',firstName:'Ada',lastName:'Lovelace',street:'1 rue Test',postalCode:'75013',city:'Paris',phone:'0612345678',email:'ada@example.test'};
let order:any=null;let current:any;let rules:any[]=await mod.getPublicDeliveryFulfillments(A);
const money=(n:number)=>mod.formatPrice(n,'EUR');
async function render(subtotal=12.4,postal='75013',mode='delivery',lang='fr',override:any={}){
 await db.query('update menu_items set price=$1 where id=$2',[subtotal,I]);
 const status=mod.deliveryStatusFromFulfillmentResult(mod.resolveDeliveryFulfillment(rules,postal,1,subtotal));
 current={restaurant:{id:A,name:'Fixture',slug:'b5-dom',config:{currency:'EUR',max_tables:10,whatsapp_enabled:false}},lines:[{key:I,item:{id:I,name:'Product',price:subtotal,allowed_service_modes:null},quantity:1}],totalCount:1,totalPrice:subtotal,tableNumber:null,serviceMode:mode,fulfillmentSelectionSeq:0,deliveryStatus:status,deliveryPricingReady:true,deliveryCustomerNotice:null,displayItems:[],fieldRequirementsReady:true,availableServiceModes:['delivery','pickup'],saleModesState:{status:'loaded',modes:[]},customer:{...customer,postalCode:postal},customerErrors:{},showErrors:false,invoiceRequest:mod.EMPTY_INVOICE_REQUEST,invoiceRequestErrors:{},onChangeInvoiceRequest:noop,note:'',canSubmit:status.eligible,isSubmitting:false,submitError:null,invoiceRequestError:null,isRetryingInvoice:false,onRetryInvoiceRequest:noop,onChangeQuantity:noop,onSelectTable:noop,onSelectFulfillment:noop,onChangeCustomer:noop,deliveryCountry:{countryCode:'FR',countryName:'France',postalCodePattern:'^[0-9]{5}$',phonePattern:null,addressProvider:'manual',addressLineOrder:'number_first'},onChangeNote:noop,cgvEnforced:false,cgvAccepted:false,onChangeCgvAccepted:noop,cgvLegalHref:null,onClose:noop,
 onSendOrder:async()=>{order=(await anon("select * from create_order('b5-dom',$1,$2::jsonb,null,$3::jsonb,null,'fr',false)",[mode,JSON.stringify([{menu_item_id:I,quantity:1}]),JSON.stringify({first_name:'Ada',last_name:'Lovelace',phone:customer.phone,email:customer.email,address:`1 rue Test, ${postal} Paris`,postalCode:postal,street:customer.street,city:customer.city,country:'FR'})])).rows[0];},...override};
 await React.act(async()=>root.render(React.createElement(mod.I18nProvider,{lang,sourceLanguage:'fr'},React.createElement(React.Fragment,null,React.createElement(mod.DeliveryConditionsButton,{rules,currency:'EUR'}),React.createElement(mod.CartPanel,current)))));
}
async function settle(){await React.act(async()=>new Promise(r=>setTimeout(r,390)));}
async function click(el:Element){await React.act(async()=>{(el as HTMLElement).click();await new Promise(r=>setTimeout(r,10));});}
function button(scope:ParentNode,text:string){const b=[...scope.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);assert.ok(b,text);return b;}
function dialog(marker:string){return container.querySelector<HTMLDialogElement>(`dialog[data-delivery-dialog="${marker}"]`)!;}
function amount(label:string){const span=[...container.querySelectorAll('span')].find(s=>s.textContent===label);assert.ok(span,label);return span.parentElement!.textContent!;}
after(async()=>{await React.act(()=>root.unmount());dom.window.close();await db.close();});

test('B5 public cart shows 12.40 / 18.90 / 31.30 before real checkout',async()=>{
 await render();assert.ok(amount('Sous-total produits').includes(money(12.4)));assert.ok(amount('Frais de livraison').includes(money(18.9)));assert.ok(amount('Total').includes(money(31.3)));assert.equal(order,null);
 await settle();assert.equal(dialog('postcode').open,true);assert.match(dialog('postcode').textContent!,/75013/);assert.ok(dialog('postcode').textContent!.includes(money(18.9)));assert.match(dialog('postcode').textContent!,/Livraison à votre adresse/);
 await click(button(dialog('postcode'),'Fermer'));assert.equal(dialog('postcode').open,false);
 await render();await settle();assert.equal(dialog('postcode').open,false,'same result does not reopen');
 await click(button(container,'Valider la commande'));assert.equal(Number((order as any).delivery_fee),18.9);assert.equal(Number((order as any).total),31.3);
});
test('B5 inclusive threshold changes actual displayed fee and dismissible result',async()=>{
 await save(true,100,50);rules=await mod.getPublicDeliveryFulfillments(A);
 for(const [subtotal,fee] of [[99.99,18.9],[100,9.45],[100.01,9.45]]){
  await render(subtotal);assert.ok(amount('Frais de livraison').includes(money(fee)));assert.ok(amount('Total').includes(money(Math.round((subtotal+fee)*100)/100)));await settle();
  if(subtotal===100){assert.equal(dialog('postcode').open,true);assert.match(dialog('postcode').textContent!,/50/);await click(button(dialog('postcode'),'Fermer'));}
  await click(button(container,'Valider la commande'));assert.equal(Number((order as any).delivery_fee),fee);
 }
 await render(100.01);await settle();assert.equal(dialog('postcode').open,false);
});
test('B5 unavailable and incomplete postcodes; native dismissal; pickup unchanged',async()=>{
 await render(12.4,'69001');await settle();assert.equal(dialog('postcode').open,true);assert.match(dialog('postcode').textContent!,/indisponible/i);
 await React.act(()=>dialog('postcode').dispatchEvent(new window.Event('cancel',{bubbles:true})));assert.equal(dialog('postcode').open,false);
 await render(12.4,'750');await settle();assert.equal(dialog('postcode').open,false);
 await render(12.4,'75013','pickup', 'fr',{canSubmit:true});assert.ok(amount('Total').includes(money(12.4)));await settle();assert.equal(dialog('postcode').open,false);
});
test('B5 public conditions use SQL data and validated translation, never provider labels',async()=>{
 await db.query("update restaurant_sale_mode_fulfillments set translations=jsonb_build_object('en',jsonb_build_object('customer_text','Delivered to your address.','customer_text_status','validated','customer_text_source_hash',customer_text_hash)) where id=$1",[rule]);
 rules=await mod.getPublicDeliveryFulfillments(A);await render(100,'75013','delivery','en');
 const trigger=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes('Delivery options'));assert.ok(trigger);await click(trigger);
 assert.equal(dialog('conditions').open,true);assert.match(dialog('conditions').textContent!,/Delivered to your address/);assert.ok(dialog('conditions').textContent!.includes(money(18.9)));assert.match(dialog('conditions').textContent!,/50/);assert.doesNotMatch(dialog('conditions').textContent!,/chronofresh|secret-routing/);
 await click(dialog('conditions'));assert.equal(dialog('conditions').open,false);
 await db.query("update restaurant_sale_mode_fulfillments set customer_text='Nouvelle instruction.' where id=$1",[rule]);rules=await mod.getPublicDeliveryFulfillments(A);await render(100,'75013','delivery','en');await click(trigger);assert.match(dialog('conditions').textContent!,/Nouvelle instruction/);assert.doesNotMatch(dialog('conditions').textContent!,/Delivered to your address/);
});
test('B5 absent public price metadata abstains visibly and blocks cart submission',async()=>{
 rules=rules.map(({pricingMode,fixedFee,freeThreshold,...legacy})=>legacy);await render(12.4);
 assert.ok(amount('Total').includes('—'));assert.ok(![...container.querySelectorAll('button')].some(b=>b.textContent?.trim()==='Valider la commande'));
 await settle();assert.equal(dialog('postcode').open,true);assert.match(dialog('postcode').textContent!,/Tarif de livraison indisponible/);
});
