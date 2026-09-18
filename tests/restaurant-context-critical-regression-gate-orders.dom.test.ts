import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Restaurant Context Critical Regression Gate — ORDERS module
// (app/dashboard/page.tsx).
//
// Permanent, release-blocking protection for the invariant: a stale
// asynchronous response from a PREVIOUSLY selected restaurant must
// NEVER become visible or actionable after the user has switched to
// another restaurant, in the SAME component instance (no
// unmount/remount).
//
// This does NOT implement or modify any functional fix -- it renders
// the REAL app/dashboard/page.tsx (esbuild + jsdom, same technique as
// tests/v81-lot1b1-dashboardnav.dom.test.ts) and drives it exactly as
// a merchant would: through the real DashboardNav restaurant <select>,
// never by calling internal state setters directly. Only the service
// layer (network boundary) is mocked, with test-controlled deferred
// promises standing in for slow/out-of-order network responses.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard?r=resto-a",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).AudioContext = undefined;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

// --------------------------------------------------------------
// Deferred-promise control, keyed by restaurant id. A test registers
// a deferred entry BEFORE the request that must hang; any restaurant
// id with no registered deferred resolves immediately with a safe
// default (so scenarios only need to control the id(s) they care
// about).
// --------------------------------------------------------------
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

(globalThis as any).__ordersDeferred = new Map<string, Deferred<unknown[]>>();
(globalThis as any).__ordersCallLog = [] as string[];
(globalThis as any).__operatorOrdersCallLog = [] as string[];
(globalThis as any).__mappings = [
  { restaurant_id: "resto-a", role: "owner", restaurants: { id: "resto-a", name: "Restaurant A", slug: "a" } },
  { restaurant_id: "resto-b", role: "owner", restaurants: { id: "resto-b", name: "Restaurant B", slug: "b" } },
];

function orderFor(restaurantId: string, marker: string) {
  return {
    id: `order-${restaurantId}`,
    restaurant_id: restaurantId,
    order_number: 1,
    status: "new",
    service_mode: "table",
    table_number: 1,
    customer_name: marker,
    customer_phone: null,
    customer_email: null,
    delivery_address: null,
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 10,
    total: 10,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [],
    tax_settings_snapshot_default_tax_rate: null,
    tax_settings_snapshot_prices_include_tax: null,
    tax_settings_snapshot_tax_label: null,
    tax_settings_snapshot_show_tax_summary: null,
    order_delivery_tax_allocations: [],
  };
}

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard"; }
`;

const MOCK_AUTH = `
export async function getSession() { return { user: { id: "staff-1" } }; }
export async function signOut() {}
`;

const MOCK_REALTIME = `
export function subscribeToOrders(restaurantId, onChange) {
  (globalThis).__subscribeCalls = (globalThis).__subscribeCalls ?? [];
  (globalThis).__subscribeCalls.push(restaurantId);
  // RCG-01 -- retain the ACTUAL registered callback (not just a record
  // that subscribe() happened) so a test can invoke it directly, after
  // unsubscribe, to prove receive-side stale-context protection -- not
  // merely that unsubscribe() was called.
  (globalThis).__subscribeEntries = (globalThis).__subscribeEntries ?? [];
  const entry = { restaurantId, onChange, unsubscribed: false };
  (globalThis).__subscribeEntries.push(entry);
  return () => {
    entry.unsubscribed = true;
    (globalThis).__unsubscribeCalls = (globalThis).__unsubscribeCalls ?? [];
    (globalThis).__unsubscribeCalls.push(restaurantId);
  };
}
`;

const MOCK_DASHBOARD = `
export async function getDashboardOrders(restaurantId, showHistory) {
  // Out-of-order support: this app legitimately issues TWO calls per
  // restaurant-id transition (two separate effects both depend on
  // loadOrders/restaurantId -- pre-existing, unrelated behavior, not a
  // bug this gate is about). Both calls of the SAME "visit" (no other
  // id logged in between) must resolve to the SAME deferred; only a
  // genuinely NEW visit (the id changed and came back) advances to the
  // next entry in that id's per-visit array.
  const log = (globalThis).__ordersCallLog;
  const prevId = (globalThis).__ordersLastId;
  (globalThis).__ordersLastId = restaurantId;
  log.push(restaurantId);
  if (prevId !== restaurantId) {
    const visits = ((globalThis).__ordersVisitIndex ??= new Map());
    visits.set(restaurantId, (visits.get(restaurantId) ?? -1) + 1);
  }
  const visitIdx = (globalThis).__ordersVisitIndex?.get(restaurantId) ?? 0;
  const perVisit = (globalThis).__ordersDeferredQueue?.get(restaurantId);
  if (perVisit && perVisit[visitIdx]) return perVisit[visitIdx].promise;
  const deferred = (globalThis).__ordersDeferred.get(restaurantId);
  if (deferred) return deferred.promise;
  const fallback = (globalThis).__ordersFallback?.[restaurantId];
  return fallback ?? [];
}
export async function getMerchantRestaurants() {
  return (globalThis).__mappings;
}
export async function getReceiptSettings(restaurantId) {
  (globalThis).__settingsCallLog = (globalThis).__settingsCallLog ?? [];
  (globalThis).__settingsCallLog.push(restaurantId);
  const deferred = (globalThis).__settingsDeferred?.get(restaurantId);
  if (deferred) return deferred.promise;
  return null;
}
export async function getRestaurantSettings(restaurantId) {
  return { staff_receipt_language: "fr" };
}
export async function updateOrderStatus() {}
// ORDERS OPERATOR READ v1 -- lecture opérateur minimale, appels tracés
// séparément de getDashboardOrders pour prouver l'absence de repli.
export async function getOperatorRestaurantOrders(restaurantId, showHistory) {
  (globalThis).__operatorOrdersCallLog.push(restaurantId);
  if ((globalThis).__operatorOrdersError) throw new Error((globalThis).__operatorOrdersError);
  return (globalThis).__operatorOrdersFallback?.[restaurantId] ?? [];
}
`;

// --------------------------------------------------------------
// RCG-V12-MONET-COMPAT-04, Root Cause A -- the real
// @/lib/services/establishments module makes a live `supabase.rpc(...)`
// network call (isScanymOperator -> "is_scanym_operator"), independently
// confirmed unchanged in the verified Monet Restaurant Context Hardening
// v1.2 candidate (byte-identical to baseline; not part of that patch).
// app/dashboard/page.tsx, in that verified candidate, awaits
// isScanymOperator() in the same Promise.all as getMerchantRestaurants()
// during initialization -- so once that candidate lands, this permanent
// DOM gate would otherwise bundle the REAL module and make a real network
// call on every run. Mocked here defensively, ahead of that landing, so
// this harness never depends on live network timing (same class of
// defect, same fix, as Claude Monet's own
// tests/printed-receipt-vat-legal-fix-v1-dom.test.ts remediation).
//
// Every EXISTING scenario in this file assumes a non-operator account
// (none of them exercises operator authority), so `false` is the correct
// default, not an arbitrary one -- __navIsOperator is reset to `false` by
// resetSharedMockState() below and only overridden by the one dedicated
// operator-case scenario. getEstablishmentSummary is included only
// because app/dashboard/page.tsx imports it from the same module (esbuild
// must resolve both exports); it throws rather than stubbing a value: for
// every non-operator scenario that branch is unreachable, so if a future
// change ever routed through it unexpectedly, this mock fails loudly
// instead of silently masking the change.
// --------------------------------------------------------------
const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__navIsOperator ?? false; }
export async function getEstablishmentSummary() {
  throw new Error("RCG-V12-MONET-COMPAT-04: getEstablishmentSummary() must not be reached in a non-operator scenario");
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/realtime": MOCK_REALTIME,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) {
        return { path: args.path, namespace: "mock" };
      }
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path],
      loader: "ts",
    }));
  },
};

const entrySource = `
export { default as DashboardPage } from "@/app/dashboard/page";
`;

const buildResult = await esbuild.build({
  stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "DashboardPage.mjs");
writeFileSync(tmpFile, code);
const { DashboardPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out waiting for condition");
    }
    await flush(stepMs);
  }
  // One extra tick so any state update triggered by the condition
  // becoming true has actually committed and painted before we assert.
  await flush(stepMs);
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(DashboardPage));
  return { container, root };
}

function switchTo(container: HTMLElement, restaurantId: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the restaurant <select> switcher must be present in DashboardNav");
  select!.value = restaurantId;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

// ====================================================================
// RCG-V12-MONET-COMPAT-04, Root Cause C -- test isolation.
//
// Finding: scenarios that mutate the shared, module-level JSDOM URL
// (via `dom.reconfigure(...)`) only restored it at the very END of the
// test body. If an assertion earlier in that same test threw, the
// restore call never ran, leaving the URL mutated for every
// SUBSEQUENT test in this file (jsdom's `dom` instance is a single
// module-level singleton, shared across all tests) -- observed by Cat
// Stevens as a cascade: a deliberately failing foreign-`?r=` scenario
// poisoning the following A->B->A scenario, which mounts assuming the
// default `?r=resto-a` URL.
//
// Fix: `beforeEachScenario()` resets the URL AND every shared mock
// registry to a known-clean baseline before a scenario runs (this
// alone already makes the suite defensive against a PRECEDING
// scenario's incomplete cleanup); `afterEachScenario()` does the same
// afterward, and every test now wraps its body in try/finally so that
// restoration runs whether the test passes, fails an assertion, or
// throws for any other reason -- never conditioned on reaching the
// test's own final lines.
// ====================================================================
const DEFAULT_URL = "http://localhost/dashboard?r=resto-a";

function resetSharedMockState() {
  (globalThis as any).__ordersDeferred = new Map();
  (globalThis as any).__ordersDeferredQueue = new Map();
  (globalThis as any).__ordersCallLog = [];
  (globalThis as any).__ordersLastId = undefined;
  (globalThis as any).__ordersVisitIndex = new Map();
  (globalThis as any).__ordersFallback = undefined;
  (globalThis as any).__operatorOrdersCallLog = [];
  (globalThis as any).__operatorOrdersFallback = undefined;
  (globalThis as any).__operatorOrdersError = undefined;
  (globalThis as any).__settingsDeferred = new Map();
  (globalThis as any).__settingsCallLog = [];
  (globalThis as any).__subscribeCalls = [];
  (globalThis as any).__unsubscribeCalls = [];
  (globalThis as any).__subscribeEntries = [];
  // RCG-V12-MONET-COMPAT-04, Root Cause A -- every existing scenario is a
  // non-operator account; only the dedicated operator-case scenario
  // overrides this, and it is restored to `false` afterward by this same
  // reset (called both before and after every scenario).
  (globalThis as any).__navIsOperator = false;
}

function beforeEachScenario() {
  dom.reconfigure({ url: DEFAULT_URL });
  resetSharedMockState();
}

function afterEachScenario() {
  dom.reconfigure({ url: DEFAULT_URL });
  resetSharedMockState();
}

test("ORDERS — A→B→late A (same instance): B's data renders and is never overwritten by A's late response", async () => {
  beforeEachScenario();
  const deferredA = makeDeferred<unknown[]>();
  (globalThis as any).__ordersDeferred.set("resto-a", deferredA);
  (globalThis as any).__ordersFallback = { "resto-b": [orderFor("resto-b", "MARKER_B")] };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    rendered = render();
    const { container, root } = rendered;
    // initial mount selects resto-a (from ?r=resto-a), request in flight (deferred, held)
    await waitFor(() => (globalThis as any).__ordersCallLog.includes("resto-a"));

    assert.ok(!container.textContent!.includes("MARKER_A"), "A's request is still pending: nothing of A should render yet");

    // Switch to B BEFORE A resolves.
    switchTo(container, "resto-b");
    await waitFor(() => container.textContent!.includes("MARKER_B"));

    assert.ok(container.textContent!.includes("MARKER_B"), "B's orders must be rendered after switching");
    assert.ok(!container.textContent!.includes("MARKER_A"), "A must not be rendered while B is selected");

    // A's response finally resolves, LATE, after B is already displayed.
    deferredA.resolve([orderFor("resto-a", "MARKER_A")]);
    await flush(50);

    assert.ok(
      container.textContent!.includes("MARKER_B"),
      "B must STILL be rendered after A's stale response resolves"
    );
    assert.ok(
      !container.textContent!.includes("MARKER_A"),
      "REGRESSION: A's stale, late-arriving response must be rejected, never overwrite B on screen"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — stale realtime subscription: an onChange fired for the previous restaurant's channel must not repopulate a A order after switching to B", async () => {
  beforeEachScenario();
  (globalThis as any).__ordersFallback = {
    "resto-a": [orderFor("resto-a", "MARKER_A2")],
    "resto-b": [orderFor("resto-b", "MARKER_B2")],
  };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    rendered = render();
    const { container } = rendered;
    await waitFor(() => container.textContent!.includes("MARKER_A2"));

    switchTo(container, "resto-b");
    await waitFor(() => container.textContent!.includes("MARKER_B2"));
    assert.ok(!container.textContent!.includes("MARKER_A2"));

    // A's realtime subscription must have been torn down on switch (real
    // cleanup, not merely superseded) -- prevents a stale channel event
    // from ever being able to fire for A again while B is on screen.
    await waitFor(() => ((globalThis as any).__unsubscribeCalls ?? []).includes("resto-a"));
    assert.ok(
      (globalThis as any).__unsubscribeCalls.includes("resto-a"),
      "switching restaurant must unsubscribe A's realtime channel (effect cleanup)"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — RCG-01: a realtime callback captured for A and invoked AFTER unsubscribe+switch to B genuinely triggers a reload, whose stale A result is then rejected, B remaining authoritative", async () => {
  // Cat Stevens' v1.2 finding: the v1.1 version of this test invoked
  // the captured A callback and then only asserted "B is still shown,
  // A is not" -- which is trivially true even if the callback did
  // NOTHING (proved by substituting `() => {}` for the real callback:
  // the v1.1 test still passed). It never proved the callback actually
  // reaches the Orders reload/read path. This version closes that gap:
  // it explicitly proves (a) a NEW Orders read was registered as a
  // direct result of invoking the callback, using an observable
  // call-log delta, not elapsed time; (b) that specific read is given
  // its OWN dedicated deferred promise (never an already-consumed
  // fixture) and resolved with unmistakable, distinct A data; (c) the
  // read is proven CONSUMED (the app's own await-continuation has run)
  // via microtask ordering, not a fixed sleep; and only then (d) that
  // the app still shows B and rejects that A result. A no-op negative
  // control immediately below proves this call-log-delta mechanism is
  // not itself vacuous.
  beforeEachScenario();
  (globalThis as any).__ordersFallback = {
    "resto-a": [orderFor("resto-a", "MARKER_A_RT")],
    "resto-b": [orderFor("resto-b", "MARKER_B_RT")],
  };

  const ordersReadCountFor = (id: string) =>
    ((globalThis as any).__ordersCallLog as string[]).filter((x) => x === id).length;

  let rendered: ReturnType<typeof render> | undefined;
  try {
    // 1. Mount under Restaurant A.
    rendered = render();
    const { container, root } = rendered;
    await waitFor(() => container.textContent!.includes("MARKER_A_RT"));

    // 2. Capture the ACTUAL onChange callback registered for A.
    const aEntry = ((globalThis as any).__subscribeEntries as Array<{
      restaurantId: string;
      onChange: () => void;
      unsubscribed: boolean;
    }>).find((e) => e.restaurantId === "resto-a");
    assert.ok(aEntry, "a realtime subscription must have been registered for resto-a");
    assert.equal(aEntry!.unsubscribed, false, "must not be unsubscribed yet, before the switch");

    // 3. baseline Orders read count for "resto-a" (mount already issued
    // at least one -- captured here, not assumed to be zero).
    const baselineACount = ordersReadCountFor("resto-a");

    // 4. Switch to Restaurant B.
    switchTo(container, "resto-b");
    // 7. Wait until B has FULLY loaded.
    await waitFor(() => container.textContent!.includes("MARKER_B_RT"));
    assert.ok(!container.textContent!.includes("MARKER_A_RT"), "A must not be rendered while B is selected");

    // 5-6. Verify unsubscribe(A) and subscribe(B) both occurred.
    await waitFor(() => (globalThis as any).__unsubscribeCalls.includes("resto-a"));
    assert.ok((globalThis as any).__unsubscribeCalls.includes("resto-a"), "A's channel must have been unsubscribed");
    assert.ok(aEntry!.unsubscribed, "A's captured subscription entry must itself be marked unsubscribed");
    assert.ok((globalThis as any).__subscribeCalls.includes("resto-b"), "B's channel must have been subscribed");

    // 8. Record the read-call count for "resto-a" right before invoking
    // the stale callback (B's own loads never touch "resto-a", so this
    // still equals baselineACount, but re-measured explicitly rather than
    // assumed).
    const preInvokeACount = ordersReadCountFor("resto-a");
    assert.equal(preInvokeACount, baselineACount, "no resto-a read should have happened merely from switching to B");

    // 11. Register a DEDICATED deferred promise for the NEXT ("resto-a"
    // visit-index + 1") request -- never reusing an already-consumed
    // fixture -- so the read this callback triggers can be independently
    // observed, controlled, and resolved with unmistakable data.
    const priorAVisitIndex = ((globalThis as any).__ordersVisitIndex as Map<string, number> | undefined)?.get("resto-a") ?? -1;
    const staleCallbackDeferred = makeDeferred<unknown[]>();
    const queueForA: Deferred<unknown[]>[] = [];
    queueForA[priorAVisitIndex + 1] = staleCallbackDeferred;
    (globalThis as any).__ordersDeferredQueue.set("resto-a", queueForA);

    // 9. Invoke the OLD, already-unsubscribed A callback -- simulating an
    // event that was already queued on the wire before the unsubscribe
    // took effect on it.
    aEntry!.onChange();

    // 10. Assert a NEW Orders read was ACTUALLY triggered -- an
    // observable call-log delta, never inferred from elapsed time. The
    // mock's getDashboardOrders body runs synchronously up to (and
    // including) its call-log push, so this is true immediately; waitFor
    // is used regardless for robustness rather than asserting bare.
    await waitFor(() => ordersReadCountFor("resto-a") === preInvokeACount + 1);
    assert.equal(
      ordersReadCountFor("resto-a"),
      preInvokeACount + 1,
      "REGRESSION (RCG-01): invoking the captured A callback must genuinely trigger a NEW Orders read for resto-a -- if this delta is ever 0, the callback is not reaching the reload path at all and the rest of this test would be vacuous"
    );

    // 12. Resolve that SAME dedicated deferred with unmistakable,
    // distinct Restaurant A data.
    staleCallbackDeferred.resolve([orderFor("resto-a", "MARKER_A_STALE_CALLBACK")]);

    // 13. Wait until that deferred read has ACTUALLY been consumed by the
    // app -- i.e. the app's own `await getDashboardOrders(...)`
    // continuation has already run to completion -- via microtask
    // ordering, not a fixed sleep. The app registers its `.then()` on
    // this exact promise synchronously inside `aEntry.onChange()` above
    // (before this line runs); a `.then()`/`.finally()` attached to the
    // SAME promise afterward is therefore guaranteed, by promise
    // handler FIFO ordering, to run strictly after the app's own
    // continuation has finished (there is no further await in that
    // continuation before it returns).
    let staleReadConsumed = false;
    staleCallbackDeferred.promise.finally(() => {
      staleReadConsumed = true;
    });
    await waitFor(() => staleReadConsumed, 2000, 1);

    // 14. Final state, now that the stale A result has genuinely been
    // produced AND consumed:
    // - current context remains B;
    assert.ok(
      container.textContent!.includes("MARKER_B_RT"),
      "B must remain rendered and authoritative after the stale A callback's result was produced and consumed"
    );
    // - A data does not reappear (neither the immediate mount-time A
    //   marker nor the NEW, distinct stale-callback marker);
    assert.ok(!container.textContent!.includes("MARKER_A_RT"), "A's original data must not reappear");
    assert.ok(
      !container.textContent!.includes("MARKER_A_STALE_CALLBACK"),
      "REGRESSION (RCG-01): the stale callback's genuinely-triggered, genuinely-resolved A read must be REJECTED by receive-side stale-context protection, never rendered, even though it was produced with unmistakable, distinct data and proven consumed"
    );
    // - stale A print/mutation state is not actionable: every rendered
    //   order card (a real <article>, one per order in state) must be
    //   B's own card, never a phantom A/stale-callback card.
    const cards = Array.from(container.querySelectorAll("article"));
    assert.equal(cards.length, 1, `exactly one order card (B's) must be rendered, never a resurrected A card. Actual count: ${cards.length}`);
    assert.ok(cards[0].textContent!.includes("MARKER_B_RT"), "the single rendered order card must be B's");
    assert.ok(!cards[0].textContent!.includes("MARKER_A_STALE_CALLBACK"), "the single rendered order card must never be the stale-callback A card");
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — RCG-01 negative control: a no-op stand-in for the captured callback shows NO new Orders read (proves the call-log-delta mechanism above is not vacuous)", async () => {
  // Cat Stevens' exact adversarial mutation: substitute `() => {}` for
  // the captured callback. This test independently demonstrates that
  // doing so is DETECTABLE -- the call-log-delta assertion the main
  // RCG-01 test relies on (step 10 above) correctly shows a delta of 0
  // for a callback that does nothing, so it is not a mechanism that
  // would "pass" regardless of what the callback actually does.
  beforeEachScenario();
  (globalThis as any).__ordersFallback = {
    "resto-a": [orderFor("resto-a", "MARKER_A_NOOP")],
    "resto-b": [orderFor("resto-b", "MARKER_B_NOOP")],
  };

  const ordersReadCountFor = (id: string) =>
    ((globalThis as any).__ordersCallLog as string[]).filter((x) => x === id).length;

  let rendered: ReturnType<typeof render> | undefined;
  try {
    rendered = render();
    const { container, root } = rendered;
    await waitFor(() => container.textContent!.includes("MARKER_A_NOOP"));

    switchTo(container, "resto-b");
    await waitFor(() => container.textContent!.includes("MARKER_B_NOOP"));
    await waitFor(() => (globalThis as any).__unsubscribeCalls.includes("resto-a"));

    const baselineACount = ordersReadCountFor("resto-a");

    // The adversarial mutation itself: a literal no-op in place of the
    // real captured callback. No flush/sleep is used here -- a no-op
    // cannot possibly schedule a later async read, so there is nothing
    // to poll for; the call log is read back synchronously.
    const noop = () => {};
    noop();

    assert.equal(
      ordersReadCountFor("resto-a"),
      baselineACount,
      "a no-op callback must show NO new Orders read for resto-a -- this is the discriminating negative control: it proves the call-log-delta mechanism used by the main RCG-01 test above genuinely distinguishes 'the callback did nothing' from 'the callback triggered a reload', so that test cannot pass vacuously"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — RCG-V12-MONET-COMPAT-04 Root Cause B: invalid/foreign ?r= for a NON-operator account fails closed (no fallback, no read, no subscription, dedicated context-unavailable state)", async () => {
  // Supersedes the prior "falls back to an authorized restaurant"
  // expectation. That silent-fallback contract was the exact defect
  // fixed by the independently-verified Monet Restaurant Context
  // Hardening v1.2 candidate (lib/dashboard-nav.ts, resolveRestaurantContext,
  // rule B): a staff account whose own mappings are only resto-a/resto-b
  // (see (globalThis).__mappings above), NOT a Scanym operator, navigates
  // with ?r= pointing at a restaurant id that is not in their own
  // mappings (tampered URL, or a stale link into another merchant's
  // establishment). The verified candidate's own comment is explicit:
  // "Le repli sur mappings[0] serait ici une bascule silencieuse
  // d'établissement : exactement le défaut" -- falling back would BE the
  // defect, not the fix. The correct, verified contract is fail-closed:
  // no fallback to any authorized restaurant, no Orders read for ANY
  // restaurant (foreign or authorized), no realtime subscription opened,
  // and a dedicated, explicit "context unavailable" state rendered
  // instead -- carrying the actually-requested id, per
  // `data-context-unavailable` (app/dashboard/page.tsx, verified
  // candidate).
  beforeEachScenario();
  (globalThis as any).__navIsOperator = false;
  (globalThis as any).__ordersFallback = { "resto-a": [orderFor("resto-a", "MARKER_SHOULD_NEVER_APPEAR")] };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    dom.reconfigure({ url: "http://localhost/dashboard?r=someone-elses-restaurant" });
    rendered = render();
    const { container } = rendered;
    await waitFor(() => container.querySelector("[data-context-unavailable]") !== null);

    const unavailableEl = container.querySelector("[data-context-unavailable]");
    assert.ok(
      unavailableEl,
      "REGRESSION (RCG-V12-MONET-COMPAT-04 Root Cause B): a foreign/unauthorized ?r= for a non-operator account must render the dedicated context-unavailable state, never silently fall back to an authorized restaurant"
    );
    assert.equal(
      unavailableEl!.getAttribute("data-context-unavailable"),
      "someone-elses-restaurant",
      "the unavailable state must carry the ACTUALLY-requested foreign id, never a substituted authorized one"
    );

    const calls: string[] = (globalThis as any).__ordersCallLog;
    assert.equal(
      calls.length,
      0,
      `no Orders read may EVER be issued while context is unavailable -- neither for the foreign id nor for a silently-substituted authorized restaurant. Actual calls: ${JSON.stringify(calls)}`
    );
    assert.equal(
      ((globalThis as any).__subscribeCalls ?? []).length,
      0,
      "no realtime subscription may be opened while context is unavailable"
    );
    assert.ok(
      !container.textContent!.includes("MARKER_SHOULD_NEVER_APPEAR"),
      "no authorized restaurant's data may ever render as a substitute for a foreign, unauthorized ?r="
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — RCG-V12-MONET-COMPAT-04 operator case: a genuine Scanym operator's explicit foreign ?r= IS honored (URL alone still grants nothing -- authority comes only from isScanymOperator(), never from ?r=)", async () => {
  // Minimum coverage for the one case Root Cause B's fail-closed rule
  // must NOT break: lib/dashboard-nav.ts's resolveRestaurantContext rule
  // A explicitly allows an unattached, explicit ?r= when the account is a
  // verified Scanym operator -- but the verified candidate's own comment
  // is equally explicit that this authority comes from isScanymOperator()
  // alone, never from the URL itself ("l'autorité opérateur vient
  // d'isScanymOperator(), jamais de l'URL"). This proves both directions
  // at once: the operator IS granted the explicitly-requested foreign
  // restaurant (not fail-closed, not silently defaulted to their own
  // mappings[0]), and the URL by itself never doubles as authority (every
  // other scenario in this file -- including Root Cause B immediately
  // above -- runs with __navIsOperator left at its default `false` and
  // still fails closed on the identical URL).
  //
  // ORDERS OPERATOR READ v1 -- in operator context the orders are read
  // ONLY through getOperatorRestaurantOrders (minimal, read-only
  // operator RPC). The merchant read (getDashboardOrders, RLS
  // is_member_of) returned an empty list in Production for an
  // unattached operator; it must never be issued here, not even as a
  // fallback.
  beforeEachScenario();
  (globalThis as any).__navIsOperator = true;
  (globalThis as any).__operatorOrdersFallback = {
    "someone-elses-restaurant": [
      {
        id: "order-someone-elses-restaurant",
        order_number: 4242,
        status: "new",
        service_mode: "pickup",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        total: 10,
        currency: "EUR",
        item_count: 3,
        has_invoice_request: false,
      },
    ],
    "resto-a": [
      {
        id: "order-resto-a",
        order_number: 9999,
        status: "new",
        service_mode: "pickup",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        total: 10,
        currency: "EUR",
        item_count: 1,
        has_invoice_request: false,
      },
    ],
  };
  (globalThis as any).__ordersFallback = {
    "someone-elses-restaurant": [orderFor("someone-elses-restaurant", "MARKER_MERCHANT_PATH_SHOULD_NOT_APPEAR")],
  };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    dom.reconfigure({ url: "http://localhost/dashboard?r=someone-elses-restaurant" });
    rendered = render();
    const { container } = rendered;
    await waitFor(() => container.querySelector('[data-operator-order-id="order-someone-elses-restaurant"]') !== null);

    assert.equal(
      container.querySelector("[data-context-unavailable]"),
      null,
      "a genuine Scanym operator must NOT see the context-unavailable state for an explicit, foreign restaurant id"
    );
    assert.ok(
      container.textContent!.includes("#4242"),
      "the operator-authorized, explicitly-requested foreign restaurant's own orders must be rendered"
    );
    assert.ok(
      !container.textContent!.includes("#9999"),
      "the operator's own mappings[0] orders must never appear"
    );
    assert.ok(
      container.querySelector('[data-operator-orders="read-only"]') !== null,
      "operator context must render the read-only operator list"
    );
    assert.ok(
      !container.textContent!.includes("MARKER_MERCHANT_PATH_SHOULD_NOT_APPEAR"),
      "the merchant read path must never be used in operator context"
    );

    const operatorCalls: string[] = (globalThis as any).__operatorOrdersCallLog;
    assert.equal(
      operatorCalls.length,
      1,
      `ORDERS OPERATOR READ v1: exactly one operator read per page load. Actual calls: ${JSON.stringify(operatorCalls)}`
    );
    assert.ok(
      operatorCalls.every((id) => id === "someone-elses-restaurant"),
      `only the explicitly-requested, operator-authorized restaurant may ever be read -- never the operator's own mappings[0] (resto-a) as a default. Actual calls: ${JSON.stringify(operatorCalls)}`
    );
    assert.deepEqual(
      (globalThis as any).__ordersCallLog,
      [],
      "ORDERS OPERATOR READ v1: no merchant-membership read (getDashboardOrders) in operator context, not even as a fallback"
    );
    assert.deepEqual(
      (globalThis as any).__subscribeCalls,
      [],
      "ORDERS OPERATOR READ v1: no realtime subscription in the read-only operator view"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — ORDERS OPERATOR READ v1: operator RPC failure is surfaced, never silently replaced by the merchant read", async () => {
  beforeEachScenario();
  (globalThis as any).__navIsOperator = true;
  (globalThis as any).__operatorOrdersError = "Not authorized for this restaurant";
  (globalThis as any).__ordersFallback = {
    "someone-elses-restaurant": [orderFor("someone-elses-restaurant", "MARKER_MERCHANT_FALLBACK_SHOULD_NOT_APPEAR")],
  };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    dom.reconfigure({ url: "http://localhost/dashboard?r=someone-elses-restaurant" });
    rendered = render();
    const { container } = rendered;
    await waitFor(() => container.textContent!.includes("Not authorized for this restaurant"));

    assert.ok(
      !container.textContent!.includes("MARKER_MERCHANT_FALLBACK_SHOULD_NOT_APPEAR"),
      "an operator RPC failure must never fall back to merchant-membership data"
    );
    assert.ok(
      !container.textContent!.includes("Aucune commande à afficher"),
      "ORDERS OPERATOR READ v1: a failed operator read must not be presented as an empty order list"
    );
    assert.deepEqual(
      (globalThis as any).__ordersCallLog,
      [],
      "getDashboardOrders must never be issued in operator context, even after an operator RPC failure"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — A→B→A out-of-order: the FIRST (stale) A response resolving AFTER the SECOND A response must not overwrite it", async () => {
  // Distinct from the A→B→late-A scenario above: here the user comes
  // BACK to A, issuing a second, fresh request for "resto-a". The
  // FIRST "resto-a" request (issued before the trip to B) is the one
  // that resolves late -- out of order, after the second one already
  // rendered -- and must be rejected as stale even though its
  // restaurant id matches the CURRENTLY selected restaurant.
  beforeEachScenario();
  const firstA = makeDeferred<unknown[]>();
  const secondA = makeDeferred<unknown[]>();
  (globalThis as any).__ordersDeferredQueue.set("resto-a", [firstA, secondA]);
  (globalThis as any).__ordersFallback = { "resto-b": [orderFor("resto-b", "MARKER_B3")] };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    rendered = render();
    const { container, root } = rendered;
    // Initial mount issues the FIRST visit's resto-a request(s); hold it.
    await waitFor(() => (globalThis as any).__ordersCallLog.includes("resto-a"));
    assert.equal((globalThis as any).__ordersVisitIndex.get("resto-a"), 0, "mount must be visit #0 for resto-a");

    switchTo(container, "resto-b");
    await waitFor(() => container.textContent!.includes("MARKER_B3"));

    // Back to A: issues the SECOND visit's resto-a request(s).
    switchTo(container, "resto-a");
    await waitFor(() => (globalThis as any).__ordersVisitIndex.get("resto-a") === 1);

    // Resolve OUT OF ORDER: the second (fresher) request resolves first...
    secondA.resolve([orderFor("resto-a", "MARKER_A_FRESH")]);
    await waitFor(() => container.textContent!.includes("MARKER_A_FRESH"));
    assert.ok(container.textContent!.includes("MARKER_A_FRESH"), "the fresh, second A response must be rendered");

    // ...then the FIRST, now-stale A request finally resolves, late.
    firstA.resolve([orderFor("resto-a", "MARKER_A_STALE")]);
    await flush(50);

    assert.ok(
      container.textContent!.includes("MARKER_A_FRESH"),
      "the fresh second A response must still be rendered after the stale first one resolves"
    );
    assert.ok(
      !container.textContent!.includes("MARKER_A_STALE"),
      "REGRESSION: an out-of-order STALE response sharing the SAME restaurant id as the current " +
        "selection must still be rejected by generation, never allowed to overwrite the fresher response"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — explicit valid ?r= is preserved: an authorized, explicitly requested restaurant is selected on mount, not the first mapping", async () => {
  beforeEachScenario();
  (globalThis as any).__ordersFallback = {
    "resto-a": [orderFor("resto-a", "MARKER_A_SHOULDNOTSHOW")],
    "resto-b": [orderFor("resto-b", "MARKER_B_EXPLICIT")],
  };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    // resto-a is mappings[0] (the implicit default); ?r= explicitly asks
    // for resto-b instead, and resto-b IS in this account's own mappings.
    dom.reconfigure({ url: "http://localhost/dashboard?r=resto-b" });
    rendered = render();
    const { container, root } = rendered;
    await waitFor(() => container.textContent!.includes("MARKER_B_EXPLICIT"));

    assert.ok(container.textContent!.includes("MARKER_B_EXPLICIT"), "the explicitly requested, authorized restaurant must be selected");
    assert.ok(!container.textContent!.includes("MARKER_A_SHOULDNOTSHOW"), "the default (first) mapping must NOT be selected when a valid ?r= overrides it");
    assert.ok(
      (globalThis as any).__ordersCallLog.every((id: string) => id === "resto-b"),
      `only resto-b should ever have been requested, never the default resto-a. Actual: ${JSON.stringify((globalThis as any).__ordersCallLog)}`
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

test("ORDERS — stale mutation precondition rejected: the print gate never unlocks on stale/foreign data, only once BOTH orders and settings belong to the currently selected restaurant", async () => {
  // `printRestaurantId` (app/dashboard/page.tsx) is the real, existing
  // precondition gate in front of the print action (OrderCard's
  // `data-print-allowed`, backed by `canPrint` / `handlePrint`'s own
  // defensive re-check). It must stay CLOSED for B's orders until B's
  // OWN receipt settings have also resolved -- A's already-resolved
  // settings must never be mistaken for B's, and B's orders must never
  // become printable on a stale/incomplete precondition.
  beforeEachScenario();
  (globalThis as any).__ordersFallback = {
    "resto-a": [orderFor("resto-a", "MARKER_A_PRINT")],
    "resto-b": [orderFor("resto-b", "MARKER_B_PRINT")],
  };

  let rendered: ReturnType<typeof render> | undefined;
  try {
    rendered = render();
    const { container, root } = rendered;
    // A's settings resolve immediately (no deferred registered for A) ->
    // print becomes allowed for A.
    await waitFor(() => container.querySelector('[data-print-allowed="true"]') !== null);

    // Now defer B's settings BEFORE switching, so B's orders can arrive
    // while B's own precondition (settings) is still outstanding.
    const settingsB = makeDeferred<unknown>();
    (globalThis as any).__settingsDeferred.set("resto-b", settingsB);

    switchTo(container, "resto-b");
    await waitFor(() => container.textContent!.includes("MARKER_B_PRINT"));

    // B's orders are on screen, but B's settings precondition has not
    // resolved yet: NOTHING must be printable, even transiently, even
    // though A's settings had already resolved earlier in this same
    // instance.
    assert.equal(
      container.querySelector('[data-print-allowed="true"]'),
      null,
      "REGRESSION: printing must stay blocked until the CURRENTLY selected restaurant's own settings have loaded -- a stale/foreign settings precondition must never unlock it"
    );

    // B's settings finally resolve: print unlocks, now correctly scoped
    // to B.
    settingsB.resolve(null);
    await waitFor(() => container.querySelector('[data-print-allowed="true"]') !== null);
    assert.ok(
      container.querySelector('[data-print-allowed="true"]') !== null,
      "print must unlock once B's own orders AND B's own settings have both resolved"
    );
  } finally {
    rendered?.root.unmount();
    rendered?.container.remove();
    afterEachScenario();
  }
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__ordersDeferred;
  delete (globalThis as any).__ordersDeferredQueue;
  delete (globalThis as any).__ordersCallLog;
  delete (globalThis as any).__ordersLastId;
  delete (globalThis as any).__ordersVisitIndex;
  delete (globalThis as any).__ordersFallback;
  delete (globalThis as any).__settingsDeferred;
  delete (globalThis as any).__settingsCallLog;
  delete (globalThis as any).__mappings;
  delete (globalThis as any).__subscribeCalls;
  delete (globalThis as any).__unsubscribeCalls;
  delete (globalThis as any).__subscribeEntries;
});
