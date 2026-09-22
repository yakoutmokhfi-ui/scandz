// SCANYM — MOBILE STICKY + DELIVERY DELAY NOTICE v1.1 / v1.2
// Hardening B: permanent STALE-TENANT control for the per-mode delivery
// notice save (app/dashboard/delivery-pricing/page.tsx, saveModeNotice).
//
// Renders the REAL dashboard page (esbuild + jsdom, real React, real
// DashboardNav selector) on ONE mounted instance. Only the service
// boundary is replaced. The save RPC is DEFERRED: the test decides when
// tenant A's save resolves or rejects, after the merchant has switched to
// tenant B (A -> B) or switched back (A -> B -> A).
//
// Invariants — a stale async save from tenant A can never:
//   - mutate tenant B's UI state (texts, drafts, saving state);
//   - display a false "saved" state in B;
//   - display A's save error in B;
//   - overwrite B's context (header, notices, re-read of A under B);
//   - contaminate A/B/A navigation: v1.2 — an operation started in the
//     FIRST A visit is stale in the LATER A visit (context generation),
//     so it can neither reread, repaint, show "saved" nor show an error
//     there, while a valid save made in the later A context still works.
// Two positive controls prove the harness can observe "saved" and the
// error message, so the negative assertions are meaningful.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/delivery-pricing",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

const A_ID = "r-tenant-a";
const A_NAME = "Etablissement A";
const B_ID = "r-tenant-b";
const B_NAME = "Etablissement B";
const MAPPINGS = [
  { restaurant_id: A_ID, role: "owner", restaurants: { id: A_ID, name: A_NAME, slug: "tenant-a" } },
  { restaurant_id: B_ID, role: "owner", restaurants: { id: B_ID, name: B_NAME, slug: "tenant-b" } },
];

const SAVED = "Enregistré";
const SAVING = "Enregistrement…";
const SAVE_FAILED = "Enregistrement refusé";

/** Server-side truth per tenant (what the RPC read returns). */
function initialServer() {
  return {
    [A_ID]: [
      { modeCode: "pickup", modeLabel: "Click & Collect", customerText: "RETRAIT-A-INITIAL" },
      { modeCode: "delivery", modeLabel: "Livraison", customerText: "LIVRAISON-A-INITIAL" },
    ],
    [B_ID]: [
      { modeCode: "pickup", modeLabel: "Click & Collect", customerText: "RETRAIT-B-INITIAL" },
      { modeCode: "delivery", modeLabel: "Livraison", customerText: "LIVRAISON-B-INITIAL" },
    ],
  } as Record<string, { modeCode: string; modeLabel: string; customerText: string | null }[]>;
}

(globalThis as any).__server = initialServer();
(globalThis as any).__deferred = [] as any[];
(globalThis as any).__readLog = [] as string[];
(globalThis as any).__mutationLog = [] as string[];

function exportedNames(relPath: string): string[] {
  const src = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}
function buildServiceMock(relPath: string, overrides: Record<string, string>): string {
  const src = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const classes = [...src.matchAll(/export\s+class\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const lines: string[] = classes.map((c) => `export class ${c} extends Error {}`);
  for (const f of exportedNames(relPath)) if (!overrides[f]) lines.push(`export async function ${f}() { return undefined; }`);
  lines.push(...Object.values(overrides));
  return lines.join("\n");
}

const mocks: Record<string, string> = {
  "next/navigation": `const r = { replace: () => {}, push: () => {} };
export function useRouter() { return r; }
export function usePathname() { return "/dashboard/delivery-pricing"; }`,
  "@/lib/services/auth": `export async function getUser() { return { id: "u" }; }
export async function getSession() { return { user: { id: "u" } }; }
export async function signOut() {}`,
  "@/lib/supabase": `export const supabase = {
  rpc: async () => ({ data: null, error: null }),
  from: () => ({ select: async () => ({ data: [], error: null }) }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
};`,
  "@/lib/services/establishments": buildServiceMock("lib/services/establishments.ts", {
    isScanymOperator: `export async function isScanymOperator() { return false; }`,
    getEstablishmentSummary: `export async function getEstablishmentSummary(id) { return { id, name: id, slug: id }; }`,
  }),
  "@/lib/services/dashboard": buildServiceMock("lib/services/dashboard.ts", {
    getMerchantRestaurants: `export async function getMerchantRestaurants() { return ${JSON.stringify(MAPPINGS)}; }`,
    getMerchantDeliveryFulfillmentPricing: `export async function getMerchantDeliveryFulfillmentPricing(id) { return []; }`,
    getMerchantDeliveryMethodNotices: `export async function getMerchantDeliveryMethodNotices(id) {
  (globalThis).__readLog.push(id);
  return JSON.parse(JSON.stringify((globalThis).__server[id] || []));
}`,
    updateMerchantDeliveryMethodNotice: `export async function updateMerchantDeliveryMethodNotice(params) {
  (globalThis).__mutationLog.push(params.restaurantId + ":" + params.modeCode + ":" + params.customerText);
  return new Promise((resolve, reject) => {
    (globalThis).__deferred.push({ params, resolve, reject });
  });
}`,
  }),
};

const built = await esbuild.build({
  stdin: {
    contents: `export { default as Delivery } from "@/app/dashboard/delivery-pricing/page";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [{
    name: "notice-stale-mocks",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (mocks[args.path]) return { path: args.path, namespace: "notice-mock" };
        if (args.path.startsWith("@/")) {
          const base = path.join(REPO_ROOT, args.path.slice(2));
          const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
          return { path: c ?? base };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "notice-mock" }, (a) => ({ contents: mocks[a.path], loader: "ts" }));
    },
  }],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-notice-stale-"));
const tmpFile = path.join(tmpDir, "page.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const P = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Scenario helpers
// ------------------------------------------------------------------
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await tick(0);
  await tick(5);
}
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await tick(5);
  }
  throw new Error(`timeout: ${label}`);
}

function reset() {
  (globalThis as any).__server = initialServer();
  (globalThis as any).__deferred = [];
  (globalThis as any).__readLog = [];
  (globalThis as any).__mutationLog = [];
  window.history.replaceState({}, "", `/dashboard/delivery-pricing?r=${A_ID}`);
}
const readLog = () => (globalThis as any).__readLog as string[];
const mutationLog = () => (globalThis as any).__mutationLog as string[];
const pendingSaves = () => (globalThis as any).__deferred as { params: any; resolve: () => void; reject: (e: unknown) => void }[];

function mount() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(P.Delivery));
  return { container, root };
}
function header(c: Element) {
  return c.querySelector("h1")?.textContent?.trim() ?? "";
}
function block(c: Element, mode: string) {
  return c.querySelector(`[data-delivery-method-notice="${mode}"]`) as HTMLElement | null;
}
function textareaValue(c: Element, mode: string) {
  return (block(c, mode)?.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? null;
}
function typeInto(c: Element, mode: string, value: string) {
  const ta = block(c, mode)!.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function saveButton(c: Element, mode: string) {
  return [...block(c, mode)!.querySelectorAll("button")].find((b) => [SAVING, "Enregistrer"].includes(b.textContent?.trim() ?? "")) as HTMLButtonElement;
}
function switchRestaurant(c: Element, id: string) {
  const select = c.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the restaurant selector (DashboardNav) must be rendered");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, id);
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}
async function loadedIn(c: Element, name: string, pickupText: string) {
  await waitFor(() => header(c) === name && textareaValue(c, "pickup") === pickupText, `${name} notices displayed`);
}
/** Starts a save of tenant A's pickup notice and leaves it in flight. */
async function startDeferredSaveA(c: Element, newText: string) {
  typeInto(c, "pickup", newText);
  await settle();
  saveButton(c, "pickup").click();
  await waitFor(() => pendingSaves().length === 1, "A save in flight");
  assert.equal(pendingSaves()[0].params.restaurantId, A_ID);
}
async function completeA(outcome: "success" | "failure") {
  const d = pendingSaves().shift()!;
  if (outcome === "success") {
    const row = (globalThis as any).__server[A_ID].find((m: any) => m.modeCode === d.params.modeCode);
    row.customerText = d.params.customerText; // persisted server-side
    d.resolve();
  } else {
    d.reject(new Error("RPC failure for A"));
  }
  await settle(12);
}
/** Everything B must show — and must keep showing — whatever A does. */
function assertCleanB(c: Element, label: string, bPickup = "RETRAIT-B-INITIAL") {
  assert.equal(header(c), B_NAME, `${label}: header must stay B`);
  assert.equal(textareaValue(c, "pickup"), bPickup, `${label}: B pickup text must be B's`);
  assert.equal(textareaValue(c, "delivery"), "LIVRAISON-B-INITIAL", `${label}: B delivery text must be B's`);
  const text = c.textContent ?? "";
  assert.equal(text.includes(SAVED), false, `${label}: no false "saved" state in B`);
  assert.equal(text.includes(SAVE_FAILED), false, `${label}: A's save error must never show in B`);
  assert.equal(text.includes(SAVING), false, `${label}: A's in-flight saving state must never show in B`);
  assert.equal(text.includes("RETRAIT-A"), false, `${label}: no A text in B`);
  assert.equal(text.includes("LIVRAISON-A"), false, `${label}: no A text in B`);
}

// ------------------------------------------------------------------
// Positive controls (the harness can observe saved / error states)
// ------------------------------------------------------------------
test("control: same-tenant save shows the saved state and re-reads the server truth", async () => {
  reset();
  const { container, root } = mount();
  try {
    await loadedIn(container, A_NAME, "RETRAIT-A-INITIAL");
    await startDeferredSaveA(container, "RETRAIT-A-NOUVEAU");
    await completeA("success");
    await waitFor(() => (container.textContent ?? "").includes(SAVED), "saved state visible");
    assert.equal(textareaValue(container, "pickup"), "RETRAIT-A-NOUVEAU");
    assert.ok(readLog().filter((id) => id === A_ID).length >= 2, "post-save re-read of A");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("control: same-tenant save failure shows the error", async () => {
  reset();
  const { container, root } = mount();
  try {
    await loadedIn(container, A_NAME, "RETRAIT-A-INITIAL");
    await startDeferredSaveA(container, "RETRAIT-A-NOUVEAU");
    await completeA("failure");
    await waitFor(() => (container.textContent ?? "").includes(SAVE_FAILED), "error visible");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// A -> B
// ------------------------------------------------------------------
for (const outcome of ["success", "failure"] as const) {
  test(`A -> B: a delayed ${outcome} of A's notice save never touches B (state, saved, error, context, draft)`, async () => {
    reset();
    const { container, root } = mount();
    try {
      await loadedIn(container, A_NAME, "RETRAIT-A-INITIAL");
      await startDeferredSaveA(container, "RETRAIT-A-NOUVEAU");

      switchRestaurant(container, B_ID);
      await loadedIn(container, B_NAME, "RETRAIT-B-INITIAL");
      assertCleanB(container, "B before A completes");

      // The merchant starts editing B (unsaved draft) while A is in flight.
      typeInto(container, "pickup", "BROUILLON-B");
      await settle();
      const readsOfABefore = readLog().filter((id) => id === A_ID).length;

      await completeA(outcome);

      assertCleanB(container, `B after A ${outcome}`, "BROUILLON-B");
      assert.equal(
        readLog().filter((id) => id === A_ID).length,
        readsOfABefore,
        "a stale A save must never re-read A under B"
      );
      assert.deepEqual(mutationLog(), [`${A_ID}:pickup:RETRAIT-A-NOUVEAU`], "only A was written, never B");
      assert.equal(saveButton(container, "pickup").disabled, false, "B save button must not inherit A's saving state");
    } finally {
      root.unmount();
      container.remove();
    }
  });
}

// ------------------------------------------------------------------
// A -> B -> A  (v1.2 — OW-MSDD-STALE-ABA-01 / OW-MSDD-TEST-ABA-02)
//
// Returning to A creates a NEW context. An operation started during the
// FIRST A visit is stale even though the restaurant id is A again: its
// completion must be a silent UI no-op in the later A context.
// ------------------------------------------------------------------
for (const outcome of ["success", "failure"] as const) {
  // v1.2: test identity (title) kept from v1.1; body strengthened.
  test(`A -> B -> A: a delayed ${outcome} of A's first save never contaminates B nor shows B data back in A`, async () => {
    reset();
    const { container, root } = mount();
    try {
      await loadedIn(container, A_NAME, "RETRAIT-A-INITIAL");
      await startDeferredSaveA(container, "RETRAIT-A-NOUVEAU");

      switchRestaurant(container, B_ID);
      await loadedIn(container, B_NAME, "RETRAIT-B-INITIAL");
      assertCleanB(container, "B during A/B/A");

      switchRestaurant(container, A_ID);
      await loadedIn(container, A_NAME, "RETRAIT-A-INITIAL");
      // The later A context is authoritative: the merchant is editing it.
      typeInto(container, "pickup", "BROUILLON-A-SECOND-CONTEXTE");
      await settle();
      const readsOfABefore = readLog().filter((id) => id === A_ID).length;

      await completeA(outcome);

      const text = container.textContent ?? "";
      assert.equal(header(container), A_NAME, "header must be A");
      assert.equal(
        readLog().filter((id) => id === A_ID).length,
        readsOfABefore,
        "the stale first-A operation must NOT trigger any reread in the later A context"
      );
      assert.equal(
        textareaValue(container, "pickup"),
        "BROUILLON-A-SECOND-CONTEXTE",
        "the stale first-A operation must NOT repaint the later A context"
      );
      assert.equal(textareaValue(container, "delivery"), "LIVRAISON-A-INITIAL", "no repaint of other modes");
      assert.equal(text.includes(SAVED), false, "no false saved state from the stale operation");
      assert.equal(text.includes(SAVE_FAILED), false, "no stale error from the stale operation");
      assert.equal(text.includes(SAVING), false, "no stale saving state");
      assert.equal(text.includes("RETRAIT-B"), false, "no B data in A");
      assert.equal(text.includes("LIVRAISON-B"), false, "no B data in A");
      assert.deepEqual(mutationLog(), [`${A_ID}:pickup:RETRAIT-A-NOUVEAU`], "only A was written, never B");

      // A VALID save in the later A context is NOT cancelled.
      saveButton(container, "pickup").click();
      await waitFor(() => pendingSaves().length === 1, "later-A save in flight");
      assert.equal(pendingSaves()[0].params.customerText, "BROUILLON-A-SECOND-CONTEXTE");
      await completeA("success");
      await waitFor(() => (container.textContent ?? "").includes(SAVED), "later-A valid save shows saved");
      assert.equal(textareaValue(container, "pickup"), "BROUILLON-A-SECOND-CONTEXTE");
      assert.equal(readLog().filter((id) => id === A_ID).length, readsOfABefore + 1, "exactly one reread, by the valid later-A save");

      // And B, revisited afterwards, is still clean.
      switchRestaurant(container, B_ID);
      await loadedIn(container, B_NAME, "RETRAIT-B-INITIAL");
      assertCleanB(container, "B revisited after A/B/A");
    } finally {
      root.unmount();
      container.remove();
    }
  });
}
