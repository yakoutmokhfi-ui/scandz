import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

/**
 * ISSUE #171 — BACK-OFFICE DOM: the REAL OrderCard and the REAL dashboard
 * page, for the six payment states.
 *
 *  - OrderCard: Accepter/Refuser/Annuler rendered ONLY for not_required
 *    and paid; a badge explains the others; a card without payment_status
 *    (legacy fixture) is NOT actionable (fail-closed).
 *  - Dashboard page: the operational list shows what the service returns
 *    (the filter itself is proven in the client-query and SQL tests); the
 *    "new order" sound/count only sees operational rows; the history view
 *    shows non-operational rows WITHOUT actions; a merchant without online
 *    payment (all not_required) keeps every action.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/dashboard?r=a", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

/**
 * AUD179-01 -- REAL sound path: a fake AudioContext that counts every
 * `oscillator.start()` issued by the page's own playSound(). Nothing in
 * the page is stubbed; only the browser audio API is replaced.
 */
const audio = { starts: 0 };
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    return { frequency: { value: 0 }, connect() {}, start() { audio.starts += 1; }, stop() {}, addEventListener() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
  close() { return Promise.resolve(); }
}
(dom.window as any).AudioContext = FakeAudioContext;
const React = await import("react");
const { createRoot } = await import("react-dom/client");

const STATES = ["not_required", "required", "pending", "paid", "failed", "cancelled"] as const;
const OPERATIONAL = new Set(["not_required", "paid"]);

const state = { rows: [] as any[], history: false, statusCalls: [] as Array<{ id: string; status: string }>, sounds: 0, onChange: () => {} };
(globalThis as any).__i171 = state;

function order(i: number, payment_status: string | undefined, status = "new") {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, restaurant_id: "a", order_number: i, status, payment_status,
    service_mode: "pickup", table_number: null, customer_name: "Client Test", customer_phone: null, customer_email: null,
    delivery_address: null, delivery_zone: null, customer_note: null, customer_language: "fr", subtotal: 10, total: 10, currency: "EUR",
    created_at: "2026-10-01T12:00:00.000Z", updated_at: "2026-10-01T12:00:00.000Z", order_items: [], order_delivery_tax_allocations: [], order_invoice_request: null,
    tax_settings_snapshot_default_tax_rate: null, tax_settings_snapshot_prices_include_tax: null, tax_settings_snapshot_tax_label: null, tax_settings_snapshot_show_tax_summary: null,
  };
}

// Mirrors lib/services/dashboard.ts: operational = status active AND payment operational; history = everything.
(globalThis as any).__i171Read = async (_restaurant: string, history: boolean) => {
  state.history = history;
  return state.rows.filter((r) => history || (!["completed", "rejected", "cancelled"].includes(r.status) && OPERATIONAL.has(r.payment_status)));
};

const mocks: Record<string, string> = {
  "next/navigation": `const router={replace(){},push(){}}; export const useRouter=()=>router; export const usePathname=()=>'/dashboard';`,
  "@/lib/services/auth": `export async function getSession(){return {user:{id:'user'}}} export async function signOut(){}`,
  "@/lib/services/establishments": `export async function isScanymOperator(){return false} export async function getEstablishmentSummary(){return {name:'Resto'}}`,
  "@/lib/services/realtime": `export function subscribeToOrders(id,fn){globalThis.__i171.onChange=fn;return ()=>{}}`,
  "@/lib/services/dashboard": `
    export const getDashboardOrders=(r,h)=>globalThis.__i171Read(r,h);
    export const getOperatorRestaurantOrders=async()=>[];
    export async function getMerchantRestaurants(){return [{restaurant_id:'a',role:'owner',restaurants:{id:'a',name:'Resto A',slug:'a'}}]}
    export async function getReceiptSettings(){return null}
    export async function getRestaurantSettings(){return {staff_receipt_language:'fr'}}
    export async function updateOrderStatus(id,status){globalThis.__i171.statusCalls.push({id,status});globalThis.__i171.rows=globalThis.__i171.rows.map(r=>r.id===id?{...r,status}:r)}
  `,
  "@/lib/receipt": `export function printReceipt(){}`,
};

async function bundleModule(entry: string) {
  const bundle = await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022", external: ["react", "react-dom", "react-dom/client"],
    plugins: [{ name: "i171-boundaries", setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (mocks[args.path]) return { path: args.path, namespace: "mock" };
        if (args.path.startsWith("@/")) {
          const base = path.join(process.cwd(), args.path.slice(2));
          const resolved = [base, `${base}.ts`, `${base}.tsx`].find(existsSync);
          if (resolved) return { path: resolved };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "tsx" }));
    } }],
  });
  const dir = mkdtempSync(path.join(process.cwd(), "tests", "tmp-i171-"));
  const file = path.join(dir, "mod.mjs");
  writeFileSync(file, bundle.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

const { default: OrderCard } = await bundleModule(`export {default} from '@/components/dashboard/OrderCard';`);
const { default: Page } = await bundleModule(`export {default} from '@/app/dashboard/page';`);
after(() => dom.window.close());

const tick = () => new Promise((r) => setTimeout(r, 15));
async function waitFor(condition: () => boolean) {
  const until = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < until, "UI condition timed out"); await tick(); }
  await tick();
}
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent?.trim());
const ACTIONS = ["Accepter", "Refuser", "Annuler", "Préparer", "Prêt", "Terminer", "Marquer prête"];
const actionButtons = (el: HTMLElement) => buttons(el).filter((t) => ACTIONS.some((a) => t?.startsWith(a)));

function mount(element: React.ReactElement) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); root.render(element);
  return { container, dispose: () => { root.unmount(); container.remove(); } };
}

for (const ps of STATES) {
  test(`ISSUE #171 OrderCard [${ps}]: ${OPERATIONAL.has(ps) ? "actions rendered, no badge" : "NO action rendered, explanatory badge"}`, async () => {
    const onStatus = async () => {};
    const { container, dispose } = mount(React.createElement(OrderCard, { order: order(1, ps), restaurantName: "Resto", receiptSettings: null, onStatus, busy: false, staffLanguage: "fr" }));
    try {
      await waitFor(() => container.querySelector("article") !== null);
      const badge = container.querySelector('[data-testid="order-payment-badge"]');
      if (OPERATIONAL.has(ps)) {
        assert.deepEqual(actionButtons(container).sort(), ["Accepter", "Annuler", "Refuser"]);
        assert.equal(badge, null);
      } else {
        assert.deepEqual(actionButtons(container), [], `${ps}: no action may be offered`);
        assert.ok(badge, "badge present");
        assert.equal(badge!.getAttribute("data-payment-status"), ps);
        assert.match(badge!.textContent ?? "", ["failed", "cancelled"].includes(ps) ? /refusé ou annulé/ : /non confirmé/);
      }
      assert.ok(buttons(container).includes("Imprimer"), "printing stays available (audit/receipt), it is not a status transition");
    } finally {
      dispose();
    }
  });
}

test("ISSUE #171 OrderCard: a legacy row WITHOUT payment_status is NOT actionable (fail-closed) and shows the awaiting badge", async () => {
  const { container, dispose } = mount(React.createElement(OrderCard, { order: order(2, undefined), restaurantName: "Resto", receiptSettings: null, onStatus: async () => {}, busy: false, staffLanguage: "fr" }));
  try {
    await waitFor(() => container.querySelector("article") !== null);
    assert.deepEqual(actionButtons(container), []);
    assert.equal(container.querySelector('[data-testid="order-payment-badge"]')!.getAttribute("data-payment-status"), "unknown");
  } finally {
    dispose();
  }
});

test("ISSUE #171 OrderCard: paid order in later kitchen states keeps its normal transitions (accepted -> Préparer/Annuler)", async () => {
  const { container, dispose } = mount(React.createElement(OrderCard, { order: order(3, "paid", "accepted"), restaurantName: "Resto", receiptSettings: null, onStatus: async () => {}, busy: false, staffLanguage: "fr" }));
  try {
    await waitFor(() => container.querySelector("article") !== null);
    assert.deepEqual(actionButtons(container).sort(), ["Annuler", "Préparer"]);
  } finally {
    dispose();
  }
});

function renderPage(rows: any[]) {
  Object.assign(state, { rows, statusCalls: [], sounds: 0 });
  dom.reconfigure({ url: "http://localhost/dashboard?r=a" });
  return mount(React.createElement(Page));
}
const cardIds = (el: HTMLElement) => [...el.querySelectorAll("article")].map((a) => a.textContent?.match(/SC-(\d+)/)?.[1] ?? "?");
const hasCard = (el: HTMLElement, n: number) => [...el.querySelectorAll("article")].filter((a) => a.textContent?.includes(`SC-${n}`)).length;

test("ISSUE #171 dashboard page (merchant): operational list shows ONLY not_required and paid `new` orders, each with actions; non-operational ones are absent (not counted as 'Nouvelle')", async () => {
  const { container, dispose } = renderPage(STATES.map((ps, i) => order(10 + i, ps)));
  try {
    await waitFor(() => container.querySelectorAll("article").length === 2);
    assert.deepEqual(cardIds(container).sort(), ["10", "13"], "not_required (#10) and paid (#13)");
    for (const article of container.querySelectorAll("article")) {
      assert.deepEqual(actionButtons(article as HTMLElement).sort(), ["Accepter", "Annuler", "Refuser"]);
      assert.equal(article.querySelector('[data-testid="order-payment-badge"]'), null);
    }
    assert.equal(hasCard(container, 11) + hasCard(container, 12) + hasCard(container, 14) + hasCard(container, 15), 0, "required/pending/failed/cancelled never rendered in the operational list");
  } finally {
    dispose();
  }
});

test("ISSUE #171 dashboard page (merchant, history view): every payment state is listed for audit, but required/pending/failed/cancelled carry a badge and NO action; a click on a paid one still goes through", async () => {
  const { container, dispose } = renderPage(STATES.map((ps, i) => order(20 + i, ps)));
  try {
    await waitFor(() => container.querySelectorAll("article").length === 2);
    const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent === "Voir l'historique");
    assert.ok(toggle, "history toggle present");
    toggle!.click();
    await waitFor(() => state.history && container.querySelectorAll("article").length === 6);
    const articles = [...container.querySelectorAll("article")] as HTMLElement[];
    const withActions = articles.filter((a) => actionButtons(a).length > 0).map((a) => a.querySelector('[data-testid="order-payment-badge"]'));
    assert.equal(withActions.length, 2);
    assert.ok(withActions.every((b) => b === null));
    const badged = articles.map((a) => a.querySelector('[data-testid="order-payment-badge"]')?.getAttribute("data-payment-status")).filter(Boolean).sort();
    assert.deepEqual(badged, ["cancelled", "failed", "pending", "required"]);
    const paidCard = articles.find((a) => a.textContent?.includes("SC-23"))!;
    [...paidCard.querySelectorAll("button")].find((b) => b.textContent === "Accepter")!.click();
    await waitFor(() => state.statusCalls.length === 1);
    assert.deepEqual(state.statusCalls[0], { id: order(23, "paid").id, status: "accepted" });
  } finally {
    dispose();
  }
});

test("ISSUE #171 dashboard page: merchant WITHOUT online payment (all not_required) is unaffected -- every order listed with actions, count unchanged", async () => {
  const { container, dispose } = renderPage([order(30, "not_required"), order(31, "not_required"), order(32, "not_required", "accepted")]);
  try {
    await waitFor(() => container.querySelectorAll("article").length === 3);
    for (const a of container.querySelectorAll("article")) assert.ok(actionButtons(a as HTMLElement).length > 0);
    assert.equal(container.querySelectorAll('[data-testid="order-payment-badge"]').length, 0);
  } finally {
    dispose();
  }
});

test("ISSUE #171 dashboard page: a realtime refresh that brings a `pending` (refused) order does not surface it as 'Nouvelle' -- only a later `paid` state does, once", async () => {
  const { container, dispose } = renderPage([order(40, "not_required")]);
  try {
    await waitFor(() => container.querySelectorAll("article").length === 1);
    state.rows = [...state.rows, order(41, "pending")];
    state.onChange();
    await tick(); await tick(); await tick();
    assert.equal(container.querySelectorAll("article").length, 1, "pending stays invisible");
    state.rows = state.rows.map((r) => (r.order_number === 41 ? { ...r, payment_status: "paid" } : r));
    state.onChange();
    await waitFor(() => container.querySelectorAll("article").length === 2);
    assert.equal(hasCard(container, 41), 1, "appears exactly once");
    state.onChange();
    await tick(); await tick(); await tick();
    assert.equal(hasCard(container, 41), 1, "a replayed refresh does not duplicate it");
  } finally {
    dispose();
  }
});

// --------------------------------------------------------------------
// AUD179-01 -- sound alert, measured on the real AudioContext path
// --------------------------------------------------------------------

function clickByText(container: HTMLElement, text: string) {
  const b = [...container.querySelectorAll("button")].find((x) => x.textContent === text);
  assert.ok(b, `button "${text}" present`);
  b!.click();
}

test("AUD179-01 (auditor's reproduction): paid order loaded, sound enabled, History opened, a new `pending` row arrives via realtime -> NO sound; the card offers no action", async () => {
  const { container, dispose } = renderPage([order(50, "paid")]);
  try {
    await waitFor(() => container.querySelectorAll("article").length === 1);
    clickByText(container, "Activer le son");
    await tick();
    clickByText(container, "Voir l'historique");
    await waitFor(() => state.history === true && container.querySelectorAll("article").length === 1);
    const before = audio.starts;
    state.rows = [...state.rows, order(51, "pending")];
    state.onChange();
    await waitFor(() => hasCard(container, 51) === 1);
    assert.equal(audio.starts, before, "a pending order must not trigger the sound, even in History");
    const card = [...container.querySelectorAll("article")].find((a) => a.textContent?.includes("SC-51")) as HTMLElement;
    assert.deepEqual(actionButtons(card), []);
  } finally {
    dispose();
  }
});

test("AUD179-01: in History, a `pending` order seen first and later confirmed `paid` triggers the sound exactly ONCE (not when seen unpaid, not again on replayed refreshes)", async () => {
  const { container, dispose } = renderPage([order(60, "paid")]);
  try {
    await waitFor(() => container.querySelectorAll("article").length === 1);
    clickByText(container, "Activer le son");
    await tick();
    clickByText(container, "Voir l'historique");
    await waitFor(() => state.history === true);
    const before = audio.starts;
    for (const ps of ["required", "pending", "failed", "cancelled"]) {
      state.rows = [...state.rows.filter((r) => r.order_number !== 61), order(61, ps)];
      state.onChange();
      await waitFor(() => hasCard(container, 61) === 1);
      assert.equal(audio.starts, before, `${ps}: no sound`);
    }
    state.rows = state.rows.map((r) => (r.order_number === 61 ? { ...r, payment_status: "paid" } : r));
    state.onChange();
    await waitFor(() => audio.starts === before + 1);
    state.onChange();
    await tick(); await tick(); await tick();
    assert.equal(audio.starts, before + 1, "replayed refresh: no second alert");
  } finally {
    dispose();
  }
});

test("AUD179-01: operational view -- a `pending` new order never sounds; when it becomes `paid` it sounds once; a new `not_required` order (merchant without online payment) still sounds", async () => {
  const { container, dispose } = renderPage([order(70, "not_required")]);
  try {
    await waitFor(() => container.querySelectorAll("article").length === 1);
    clickByText(container, "Activer le son");
    await tick();
    const before = audio.starts;
    state.rows = [...state.rows, order(71, "pending")];
    state.onChange();
    await tick(); await tick(); await tick();
    assert.equal(audio.starts, before);
    state.rows = state.rows.map((r) => (r.order_number === 71 ? { ...r, payment_status: "paid" } : r));
    state.onChange();
    await waitFor(() => audio.starts === before + 1);
    state.rows = [...state.rows, order(72, "not_required")];
    state.onChange();
    await waitFor(() => audio.starts === before + 2);
  } finally {
    dispose();
  }
});
