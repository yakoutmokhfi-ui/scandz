import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

/**
 * PLANCK190-03 -- de bout en bout jusqu'à L'ÉCRAN : la VRAIE page commandes + le VRAI service
 * getDashboardOrders (seul le client Supabase et les services annexes sont doublés).
 * Une erreur de la lecture secondaire de `vacuum_packing_requested` qui ne désigne pas
 * exactement cette colonne doit : afficher une erreur visible, ne laisser AUCUNE commande
 * actionnable sans sa consigne.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/dashboard?r=a", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
class FakeAudioContext {
  currentTime = 0; destination = {};
  createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {}, addEventListener() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  close() { return Promise.resolve(); }
}
(dom.window as any).AudioContext = FakeAudioContext;
const React = await import("react");
const { createRoot } = await import("react-dom/client");

const ORDER_ID = "00000000-0000-0000-0000-000000000001";
const state = { mainRows: [] as any[], flagRows: [] as any[], flagError: null as any };
(globalThis as any).__vps = state;

const REAL_SERVICE = path.join(process.cwd(), "lib/services/dashboard.ts").replaceAll("\\", "/");
const mocks: Record<string, string> = {
  "next/navigation": `const router={replace(){},push(){}}; export const useRouter=()=>router; export const usePathname=()=>'/dashboard';`,
  "@/lib/services/auth": `export async function getSession(){return {user:{id:'user'}}} export async function signOut(){}`,
  "@/lib/services/establishments": `export async function isScanymOperator(){return false} export async function getEstablishmentSummary(){return {name:'Resto'}}`,
  "@/lib/services/realtime": `export function subscribeToOrders(id,fn){return ()=>{}}`,
  "@/lib/receipt": `export function printReceipt(){}`,
  // Client Supabase double : requête principale -> lignes; lecture secondaire (.in("id")) -> état contrôlé.
  "@/lib/supabase": `
    function builder(table){
      const b={
        select(){return b},eq(){return b},order(){return b},limit(){return b},not(){return b},or(){return b},
        in(col){ if(table==='orders'&&col==='id'){ const s=globalThis.__vps; return Promise.resolve({data:s.flagError?null:s.flagRows,error:s.flagError}); } return b },
        then(res,rej){ return Promise.resolve({data:globalThis.__vps.mainRows,error:null}).then(res,rej) },
      };
      return b;
    }
    export const supabase={from:builder,rpc:async()=>({data:null,error:null})};`,
  // Service REEL pour getDashboardOrders ; le reste est doublé.
  "@/lib/services/dashboard": `
    import { getDashboardOrders as real } from ${JSON.stringify(REAL_SERVICE)};
    export const getDashboardOrders = real;
    export const getOperatorRestaurantOrders=async()=>[];
    export async function getMerchantRestaurants(){return [{restaurant_id:'a',role:'owner',restaurants:{id:'a',name:'Resto A',slug:'a'}}]}
    export async function getReceiptSettings(){return null}
    export async function getRestaurantSettings(){return {staff_receipt_language:'fr'}}
    export async function updateOrderStatus(){}
  `,
};
async function bundle(entry: string) {
  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022", external: ["react", "react-dom", "react-dom/client"],
    plugins: [{ name: "vps", setup(build) {
      build.onResolve({ filter: /.*/ }, (a) => {
        if (mocks[a.path]) return { path: a.path, namespace: "mock" };
        if (a.path.startsWith("@/")) {
          const base = path.join(process.cwd(), a.path.slice(2));
          const r = [base, `${base}.ts`, `${base}.tsx`].find(existsSync);
          if (r) return { path: r };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: mocks[a.path], loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  const dir = mkdtempSync(path.join(process.cwd(), "tests", "tmp-vps-"));
  const file = path.join(dir, "m.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}
const { default: Page } = await bundle(`export { default } from '@/app/dashboard/page';`);
after(() => dom.window.close());

const order = () => ({
  id: ORDER_ID, restaurant_id: "a", order_number: 7, status: "new", payment_status: "paid",
  service_mode: "pickup", table_number: null, customer_name: "Client Test", customer_phone: null, customer_email: null,
  delivery_address: null, delivery_zone: null, customer_note: null, customer_language: "fr", subtotal: 10, total: 10, currency: "EUR",
  created_at: "2026-10-01T12:00:00.000Z", updated_at: "2026-10-01T12:00:00.000Z",
  order_items: [], order_delivery_tax_allocations: [], order_invoice_request: null,
  tax_settings_snapshot_default_tax_rate: null, tax_settings_snapshot_prices_include_tax: null, tax_settings_snapshot_tax_label: null, tax_settings_snapshot_show_tax_summary: null,
});
const tick = () => new Promise((r) => setTimeout(r, 15));
async function waitFor(cond: () => boolean) {
  const until = Date.now() + 5000;
  while (!cond()) { assert.ok(Date.now() < until, "UI condition timed out"); await tick(); }
  await tick();
}
async function screen(flagRows: any[], flagError: any) {
  Object.assign(state, { mainRows: [order()], flagRows, flagError });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); root.render(React.createElement(Page));
  const dispose = () => { root.unmount(); container.remove(); };
  return { container, dispose };
}
const actions = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter((t) => ["Accepter", "Refuser", "Annuler"].some((a) => t?.startsWith(a!)));

test("[VP-SCREEN-1] consigne lue : bandeau « sous vide » ET actions disponibles (témoin)", async () => {
  const s = await screen([{ id: ORDER_ID, vacuum_packing_requested: true }], null);
  try {
    await waitFor(() => s.container.querySelectorAll("article").length === 1);
    assert.equal(s.container.querySelector("[data-order-vacuum-detail]") !== null, true);
    assert.deepEqual(actions(s.container).sort(), ["Accepter", "Annuler", "Refuser"]);
  } finally { s.dispose(); }
});

test("[VP-SCREEN-2] colonne réellement absente (lot non appliqué) : la commande s'affiche normalement, sans bandeau, sans erreur", async () => {
  for (const err of [
    { code: "42703", message: "column orders.vacuum_packing_requested does not exist" },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested' column of 'orders' in the schema cache" },
  ]) {
    const s = await screen([], err);
    try {
      await waitFor(() => s.container.querySelectorAll("article").length === 1);
      assert.equal(s.container.querySelector("[data-order-vacuum-detail]"), null);
      assert.equal(s.container.textContent!.includes("does not exist"), false, "aucune erreur affichée");
      assert.deepEqual(actions(s.container).sort(), ["Accepter", "Annuler", "Refuser"]);
    } finally { s.dispose(); }
  }
});

for (const err of [
  { code: "42703", message: "column orders.other_column does not exist" },
  { code: "42703", message: 'column "vacuum_packing_requested_backup" does not exist' },
  { code: "42703", message: "x" },
  { code: "57014", message: "canceling statement due to statement timeout" },
]) {
  test(`[VP-SCREEN-3] erreur « ${err.code} ${err.message} » : erreur VISIBLE, aucune commande actionnable sans sa consigne`, async () => {
    const s = await screen([], err);
    try {
      await waitFor(() => s.container.textContent!.includes(err.message));
      assert.equal(s.container.querySelectorAll("article").length, 0, "la commande n'est pas présentée sans sa consigne");
      assert.deepEqual(actions(s.container), [], "aucun bouton Accepter/Refuser/Annuler");
      assert.equal(s.container.querySelector(".bg-red-50") !== null, true, "bandeau d'erreur affiché");
    } finally { s.dispose(); }
  });
}
