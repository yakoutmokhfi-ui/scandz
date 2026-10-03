import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compareOrderKeys, type OrderCursor } from "../lib/dashboard-pagination.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/dashboard?r=a", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const state = {
  operator: false, rows: [] as any[], calls: [] as Array<{ operator: boolean; restaurant: string; history: boolean; cursor: OrderCursor | null }>,
  onChange: () => {},
  deferred: null as null | { promise: Promise<void>; resolve: () => void },
  failMore: false,
};
(globalThis as any).__paginationTest = state;
function fixture(count: number, restaurant = "a") {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(count - i).padStart(12, "0")}`,
    restaurant_id: restaurant, order_number: count - i, status: "new", service_mode: "pickup",
    created_at: "2026-10-01T12:00:00.123456Z", updated_at: "2026-10-01T12:00:00.123456Z",
    total: 10, currency: "EUR", item_count: 1, has_invoice_request: false,
  }));
}
(globalThis as any).__paginationRead = async (operator: boolean, restaurant: string, history: boolean, cursor: OrderCursor | null = null) => {
  state.calls.push({ operator, restaurant, history, cursor });
  // Capture response before delaying, like an in-flight response from old context.
  const rows = state.rows.filter(r => r.restaurant_id === restaurant &&
    (history || !["completed", "rejected", "cancelled"].includes(r.status)) &&
    (!cursor || compareOrderKeys(r, cursor) < 0)).sort((a, b) => -compareOrderKeys(a, b)).slice(0, 51);
  if (cursor && state.deferred) await state.deferred.promise;
  if (cursor && state.failMore) throw new Error("PAGE_FAILED");
  return rows;
};
const mocks: Record<string, string> = {
  "next/navigation": `const router={replace(){},push(){}}; export const useRouter=()=>router; export const usePathname=()=>'/dashboard';`,
  "@/lib/services/auth": `export async function getSession(){return {user:{id:'user'}}} export async function signOut(){}`,
  "@/lib/services/establishments": `export async function isScanymOperator(){return globalThis.__paginationTest.operator} export async function getEstablishmentSummary(){return {name:'Operator restaurant'}}`,
  "@/lib/services/realtime": `export function subscribeToOrders(id,fn){globalThis.__paginationTest.onChange=fn;return ()=>{}}`,
  "@/lib/services/dashboard": `
    export const getDashboardOrders=(...args)=>globalThis.__paginationRead(false,...args);
    export const getOperatorRestaurantOrders=(...args)=>globalThis.__paginationRead(true,...args);
    export async function getMerchantRestaurants(){return globalThis.__paginationTest.operator?[]:['a','b'].map(id=>({restaurant_id:id,role:'owner',restaurants:{id,name:id,slug:id}}))}
    export async function getReceiptSettings(){return null}
    export async function getRestaurantSettings(){return {staff_receipt_language:'fr'}}
    export async function updateOrderStatus(id,status){globalThis.__paginationTest.rows=globalThis.__paginationTest.rows.map(r=>r.id===id?{...r,status}:r)}
  `,
  "@/components/dashboard/OrderCard": `
    import React from 'react';
    export const STATUS_KEY={new:'statusNew'};
    export default function Card({order,onStatus,printRestaurantId}){return <div data-order-id={order.id} data-print-tenant={printRestaurantId}>
      {order.restaurant_id}<button onClick={()=>onStatus(order.id,'completed')}>Complete {order.order_number}</button></div>}
  `,
};
const bundle = await esbuild.build({
  stdin: { contents: `export {default} from '@/app/dashboard/page';`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022", external: ["react", "react-dom", "react-dom/client"],
  plugins: [{ name: "pagination-test-boundaries", setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(process.cwd(), args.path.slice(2));
        const resolved = [base, `${base}.ts`, `${base}.tsx`].find(existsSync);
        if (resolved) return { path: resolved };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], loader: "tsx" }));
  } }],
});
const dir = mkdtempSync(path.join(process.cwd(), "tests", "tmp-pagination-"));
writeFileSync(path.join(dir, "page.mjs"), bundle.outputFiles[0].text);
const { default: Page } = await import(pathToFileURL(path.join(dir, "page.mjs")).href);
rmSync(dir, { recursive: true, force: true });
after(() => dom.window.close());
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function waitFor(condition: () => boolean) {
  const until = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < until, "UI condition timed out"); await tick(); }
  await tick();
}
function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find(b => b.textContent === text);
}
function ids(container: HTMLElement) {
  return [...container.querySelectorAll("[data-order-id],[data-operator-order-id]")]
    .map(e => e.getAttribute("data-order-id") ?? e.getAttribute("data-operator-order-id"));
}
function render(count: number, operator = false) {
  Object.assign(state, { operator, rows: fixture(count), calls: [], failMore: false, deferred: null });
  dom.reconfigure({ url: "http://localhost/dashboard?r=a" });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); root.render(React.createElement(Page));
  return { container, dispose: () => { root.unmount(); container.remove(); } };
}
function deferPage() {
  let resolve!: () => void;
  state.deferred = { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
  return state.deferred;
}

for (const operator of [false, true]) {
  test(`P9/P15/P16 UI ${operator ? "operator" : "merchant"}: full traversal, has-more, retry and no duplicate clicks`, async () => {
    const { container, dispose } = render(237, operator);
    try {
      await waitFor(() => ids(container).length === 50);
      assert.match(container.textContent!, /D’autres commandes/);
      state.failMore = true;
      button(container, "Charger plus de commandes")!.click();
      await waitFor(() => container.textContent!.includes("PAGE_FAILED"));
      assert.equal(ids(container).length, 50);
      state.failMore = false;
      const pending = deferPage();
      const before = state.calls.length;
      const more = button(container, "Charger plus de commandes")!;
      more.click(); more.click();
      await waitFor(() => state.calls.length === before + 1);
      assert.ok(more.disabled);
      pending.resolve(); state.deferred = null;
      await waitFor(() => ids(container).length === 100);
      while (button(container, "Charger plus de commandes")) {
        const count = ids(container).length;
        button(container, "Charger plus de commandes")!.click();
        await waitFor(() => ids(container).length > count);
      }
      assert.deepEqual(ids(container), fixture(237).map(r => r.id));
      assert.ok(state.calls.every(c => c.operator === operator));
      assert.ok(!container.textContent!.includes("D’autres commandes"));
    } finally { dispose(); }
  });
}

test("P14 UI: realtime during continuation is queued; refresh preserves reached frontier and status actions", async () => {
  const { container, dispose } = render(120);
  try {
    await waitFor(() => ids(container).length === 50);
    const pending = deferPage();
    button(container, "Charger plus de commandes")!.click();
    await waitFor(() => state.calls.some(c => c.cursor !== null));
    state.rows.unshift({ ...fixture(121)[0], created_at: "2026-10-02T12:00:00Z" });
    const count = state.calls.length;
    state.onChange(); state.onChange();
    await tick();
    assert.equal(state.calls.length, count, "realtime cannot cancel pending continuation");
    pending.resolve(); state.deferred = null;
    await waitFor(() => ids(container).length === 121);
    assert.equal(new Set(ids(container)).size, 121);
    assert.ok(ids(container).includes(fixture(120)[99].id));
    button(container, "Complete 121")!.click();
    await waitFor(() => ids(container).length === 120);
    assert.ok(!ids(container).includes(fixture(121)[0].id));
    assert.equal(container.querySelector("[data-order-id]")?.getAttribute("data-print-tenant"), "a");
  } finally { dispose(); }
});

test("P11/P16 UI: late page from A cannot appear or print after switching to B", async () => {
  const { container, dispose } = render(101);
  try {
    await waitFor(() => ids(container).length === 50);
    const pending = deferPage();
    button(container, "Charger plus de commandes")!.click();
    await waitFor(() => state.calls.some(c => c.cursor !== null));
    state.rows = fixture(1, "b");
    const select = container.querySelector("select")!;
    select.value = "b"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await waitFor(() => ids(container).length === 1);
    pending.resolve(); state.deferred = null; await tick();
    assert.deepEqual(ids(container), fixture(1).map(r => r.id));
    assert.equal(container.querySelector("[data-order-id]")?.getAttribute("data-print-tenant"), "b");
    assert.ok(!button(container, "Charger plus de commandes"));
  } finally { dispose(); }
});

test("P16 UI: history change invalidates pending active page and resets continuation", async () => {
  const { container, dispose } = render(101);
  try {
    await waitFor(() => ids(container).length === 50);
    const staleActiveCallback = state.onChange;
    const pending = deferPage();
    button(container, "Charger plus de commandes")!.click();
    await waitFor(() => state.calls.some(c => c.cursor !== null));
    state.rows = [{ ...fixture(1)[0], status: "completed" }];
    const history = [...container.querySelectorAll("button")].find(b => /historique/i.test(b.textContent ?? ""));
    assert.ok(history); history.click();
    await waitFor(() => state.calls.some(c => c.history && c.cursor === null));
    pending.resolve(); state.deferred = null;
    await waitFor(() => ids(container).length === 1);
    assert.deepEqual(ids(container), fixture(1).map(r => r.id));
    assert.ok(!button(container, "Charger plus de commandes"));
    const before = state.calls.length;
    staleActiveCallback();
    await waitFor(() => state.calls.length > before);
    assert.deepEqual(ids(container), fixture(1).map(r => r.id), "old active subscription cannot overwrite history");
  } finally { dispose(); }
});
