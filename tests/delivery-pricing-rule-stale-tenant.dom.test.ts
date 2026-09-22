// SCANYM — MOBILE STICKY + DELIVERY DELAY NOTICE v1.3
// QA-MSDD-PRICING-ABA-03: permanent STALE-TENANT / ABA control for the
// pricing-rule save (app/dashboard/delivery-pricing/page.tsx, save(ruleId)).
//
// Renders the REAL dashboard page (esbuild + jsdom, real React, real
// DashboardNav selector) on ONE mounted instance. Only the service
// boundary is replaced. The pricing-rule save RPC is DEFERRED: the test
// decides when tenant A's save resolves or rejects, after the merchant
// has switched to tenant B (A -> B) or switched back (A -> B -> A).
//
// Invariants — a stale async pricing-rule save from tenant A can never:
//   - mutate tenant B's UI state (fee, text, drafts, saving state);
//   - display a false "saved" state or A's error in B;
//   - re-read A's pricing under B;
//   - in A -> B -> A: an operation started in the FIRST A visit is stale
//     in the LATER A visit (context generation), so it can neither
//     reread, repaint, show "saved" nor show an error there, while a
//     valid save made in the later A context still works.
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

const A_LABEL = "REGLE-LIVRAISON-A";
const B_LABEL = "REGLE-LIVRAISON-B";
const A_TEXT_INITIAL = "TEXTE-REGLE-A-INITIAL";
const B_TEXT_INITIAL = "TEXTE-REGLE-B-INITIAL";

type Rule = {
  ruleId: string;
  fulfillmentLabel: string;
  pricingMode: "fixed" | "free_above_threshold";
  fixedFee: number | null;
  freeThreshold: number | null;
  customerText: string | null;
};

/** Server-side truth per tenant (what the pricing read RPC returns). */
function initialServer(): Record<string, Rule[]> {
  return {
    [A_ID]: [{ ruleId: "rule-a", fulfillmentLabel: A_LABEL, pricingMode: "fixed", fixedFee: 3, freeThreshold: null, customerText: A_TEXT_INITIAL }],
    [B_ID]: [{ ruleId: "rule-b", fulfillmentLabel: B_LABEL, pricingMode: "fixed", fixedFee: 5, freeThreshold: null, customerText: B_TEXT_INITIAL }],
  };
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
    getMerchantDeliveryFulfillmentPricing: `export async function getMerchantDeliveryFulfillmentPricing(id) {
  (globalThis).__readLog.push(id);
  return JSON.parse(JSON.stringify((globalThis).__server[id] || []));
}`,
    updateMerchantDeliveryFulfillmentPricing: `export async function updateMerchantDeliveryFulfillmentPricing(input) {
  (globalThis).__mutationLog.push(input.ruleId + ":" + input.fixedFee + ":" + input.customerText);
  return new Promise((resolve, reject) => {
    (globalThis).__deferred.push({ input, resolve, reject });
  });
}`,
    getMerchantDeliveryMethodNotices: `export async function getMerchantDeliveryMethodNotices() { return []; }`,
    updateMerchantDeliveryMethodNotice: `export async function updateMerchantDeliveryMethodNotice() {
  throw new Error("notice save must not be called by the pricing-rule test");
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
    name: "pricing-stale-mocks",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (mocks[args.path]) return { path: args.path, namespace: "pricing-mock" };
        if (args.path.startsWith("@/")) {
          const base = path.join(REPO_ROOT, args.path.slice(2));
          const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
          return { path: c ?? base };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "pricing-mock" }, (a) => ({ contents: mocks[a.path], loader: "ts" }));
    },
  }],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-pricing-stale-"));
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
const readsOf = (id: string) => ((globalThis as any).__readLog as string[]).filter((x) => x === id).length;
const mutationLog = () => (globalThis as any).__mutationLog as string[];
const pendingSaves = () => (globalThis as any).__deferred as { input: any; resolve: () => void; reject: (e: unknown) => void }[];

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
/** The pricing-rule <section> whose heading is the given rule label. */
function ruleSection(c: Element, label: string) {
  return ([...c.querySelectorAll("section")] as HTMLElement[]).find(
    (s) => s.querySelector("h3")?.textContent?.trim() === label
  ) ?? null;
}
function feeValue(c: Element, label: string) {
  return (ruleSection(c, label)?.querySelector('input[type="number"]') as HTMLInputElement | null)?.value ?? null;
}
function textValue(c: Element, label: string) {
  return (ruleSection(c, label)?.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? null;
}
function setFee(c: Element, label: string, value: string) {
  const input = ruleSection(c, label)!.querySelector('input[type="number"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function setText(c: Element, label: string, value: string) {
  const ta = ruleSection(c, label)!.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function saveButton(c: Element, label: string) {
  return [...ruleSection(c, label)!.querySelectorAll("button")].find((b) =>
    [SAVING, "Enregistrer"].includes(b.textContent?.trim() ?? "")
  ) as HTMLButtonElement;
}
function switchRestaurant(c: Element, id: string) {
  // The DashboardNav restaurant selector is the <select> offering both tenants
  // (never a rule's pricing-mode <select>).
  const select = ([...c.querySelectorAll("select")] as HTMLSelectElement[]).find((s) =>
    [...s.options].some((o) => o.value === B_ID)
  );
  assert.ok(select, "the restaurant selector (DashboardNav) must be rendered");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, id);
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}
async function loadedIn(c: Element, name: string, label: string, text: string) {
  await waitFor(() => header(c) === name && textValue(c, label) === text, `${name} pricing rule displayed`);
}
/** Starts a save of tenant A's pricing rule and leaves it in flight. */
async function startDeferredSaveA(c: Element) {
  setFee(c, A_LABEL, "4.5");
  setText(c, A_LABEL, "TEXTE-REGLE-A-NOUVEAU");
  await settle();
  saveButton(c, A_LABEL).click();
  await waitFor(() => pendingSaves().length === 1, "A pricing save in flight");
  assert.equal(pendingSaves()[0].input.ruleId, "rule-a");
}
async function completeA(outcome: "success" | "failure") {
  const d = pendingSaves().shift()!;
  if (outcome === "success") {
    const rule = (globalThis as any).__server[A_ID].find((r: Rule) => r.ruleId === d.input.ruleId);
    rule.pricingMode = d.input.pricingMode; // persisted server-side
    rule.fixedFee = d.input.fixedFee;
    rule.freeThreshold = d.input.freeThreshold;
    rule.customerText = d.input.customerText;
    d.resolve();
  } else {
    d.reject(new Error("RPC failure for A"));
  }
  await settle(12);
}
/** Everything B must show — and must keep showing — whatever A does. */
function assertCleanB(c: Element, label: string, bText = B_TEXT_INITIAL, bFee = "5") {
  assert.equal(header(c), B_NAME, `${label}: header must stay B`);
  assert.equal(textValue(c, B_LABEL), bText, `${label}: B rule text must be B's`);
  assert.equal(feeValue(c, B_LABEL), bFee, `${label}: B rule fee must be B's`);
  assert.equal(ruleSection(c, A_LABEL), null, `${label}: A's rule must never be rendered in B`);
  const text = c.textContent ?? "";
  assert.equal(text.includes(SAVED), false, `${label}: no false "saved" state in B`);
  assert.equal(text.includes(SAVE_FAILED), false, `${label}: A's save error must never show in B`);
  assert.equal(text.includes(SAVING), false, `${label}: A's in-flight saving state must never show in B`);
  assert.equal(text.includes("REGLE-A"), false, `${label}: no A data in B`);
}

// ------------------------------------------------------------------
// Positive controls (the harness can observe saved / error states)
// ------------------------------------------------------------------
test("pricing control: same-context rule save shows the saved state and re-reads the server truth", async () => {
  reset();
  const { container, root } = mount();
  try {
    await loadedIn(container, A_NAME, A_LABEL, A_TEXT_INITIAL);
    const readsBefore = readsOf(A_ID);
    await startDeferredSaveA(container);
    await completeA("success");
    await waitFor(() => (container.textContent ?? "").includes(SAVED), "saved state visible");
    assert.equal(textValue(container, A_LABEL), "TEXTE-REGLE-A-NOUVEAU");
    assert.equal(feeValue(container, A_LABEL), "4.5");
    assert.equal(readsOf(A_ID), readsBefore + 1, "exactly one post-save re-read of A");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("pricing control: same-context rule save failure shows the error", async () => {
  reset();
  const { container, root } = mount();
  try {
    await loadedIn(container, A_NAME, A_LABEL, A_TEXT_INITIAL);
    await startDeferredSaveA(container);
    await completeA("failure");
    await waitFor(() => (container.textContent ?? "").includes(SAVE_FAILED), "error visible");
    assert.equal(saveButton(container, A_LABEL).disabled, false, "saving state released after failure");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// A -> B
// ------------------------------------------------------------------
for (const outcome of ["success", "failure"] as const) {
  test(`pricing A -> B: a delayed ${outcome} of A's rule save never touches B (state, saved, error, reread, draft)`, async () => {
    reset();
    const { container, root } = mount();
    try {
      await loadedIn(container, A_NAME, A_LABEL, A_TEXT_INITIAL);
      await startDeferredSaveA(container);

      switchRestaurant(container, B_ID);
      await loadedIn(container, B_NAME, B_LABEL, B_TEXT_INITIAL);
      assertCleanB(container, "B before A completes");

      // The merchant starts editing B (unsaved draft) while A is in flight.
      setFee(container, B_LABEL, "6");
      setText(container, B_LABEL, "BROUILLON-REGLE-B");
      await settle();
      const readsOfABefore = readsOf(A_ID);
      const readsOfBBefore = readsOf(B_ID);

      await completeA(outcome);

      assertCleanB(container, `B after A ${outcome}`, "BROUILLON-REGLE-B", "6");
      assert.equal(readsOf(A_ID), readsOfABefore, "a stale A save must never re-read A under B");
      assert.equal(readsOf(B_ID), readsOfBBefore, "a stale A save must never trigger a B reread either");
      assert.deepEqual(mutationLog(), ["rule-a:4.5:TEXTE-REGLE-A-NOUVEAU"], "only A's rule was written, never B's");
      assert.equal(saveButton(container, B_LABEL).disabled, false, "B save button must not inherit A's saving state");
    } finally {
      root.unmount();
      container.remove();
    }
  });
}

// ------------------------------------------------------------------
// A -> B -> A  (v1.3 — QA-MSDD-PRICING-ABA-03)
//
// Returning to A creates a NEW context. A pricing-rule save started during
// the FIRST A visit is stale even though the restaurant id is A again: its
// completion must be a silent UI no-op in the later A context.
// ------------------------------------------------------------------
for (const outcome of ["success", "failure"] as const) {
  test(`pricing A -> B -> A: a delayed ${outcome} of A's first rule save is a silent no-op in the later A context`, async () => {
    reset();
    const { container, root } = mount();
    try {
      await loadedIn(container, A_NAME, A_LABEL, A_TEXT_INITIAL);
      await startDeferredSaveA(container);

      switchRestaurant(container, B_ID);
      await loadedIn(container, B_NAME, B_LABEL, B_TEXT_INITIAL);
      assertCleanB(container, "B during A/B/A");

      switchRestaurant(container, A_ID);
      await loadedIn(container, A_NAME, A_LABEL, A_TEXT_INITIAL);
      // The later A context is authoritative: the merchant is editing it.
      setFee(container, A_LABEL, "7");
      setText(container, A_LABEL, "BROUILLON-REGLE-A-SECOND-CONTEXTE");
      await settle();
      const readsOfABefore = readsOf(A_ID);

      await completeA(outcome);

      const text = container.textContent ?? "";
      assert.equal(header(container), A_NAME, "header must be A");
      assert.equal(
        readsOf(A_ID),
        readsOfABefore,
        "the stale first-A pricing save must NOT trigger any reread in the later A context"
      );
      assert.equal(
        textValue(container, A_LABEL),
        "BROUILLON-REGLE-A-SECOND-CONTEXTE",
        "the stale first-A pricing save must NOT repaint the later A context (text)"
      );
      assert.equal(feeValue(container, A_LABEL), "7", "the stale first-A pricing save must NOT repaint the later A context (fee)");
      assert.equal(text.includes(SAVED), false, "no false saved state from the stale operation");
      assert.equal(text.includes(SAVE_FAILED), false, "no stale error from the stale operation");
      assert.equal(text.includes(SAVING), false, "no stale saving state");
      assert.equal(saveButton(container, A_LABEL).disabled, false, "later-A save button must be usable");
      assert.equal(ruleSection(container, B_LABEL), null, "no B rule in A");
      assert.equal(text.includes("REGLE-B"), false, "no B data in A");
      assert.deepEqual(mutationLog(), ["rule-a:4.5:TEXTE-REGLE-A-NOUVEAU"], "only A's rule was written, never B's");

      // A VALID save in the later A context is NOT cancelled.
      saveButton(container, A_LABEL).click();
      await waitFor(() => pendingSaves().length === 1, "later-A pricing save in flight");
      assert.equal(pendingSaves()[0].input.ruleId, "rule-a");
      assert.equal(pendingSaves()[0].input.fixedFee, 7);
      assert.equal(pendingSaves()[0].input.customerText, "BROUILLON-REGLE-A-SECOND-CONTEXTE");
      await completeA("success");
      await waitFor(() => (container.textContent ?? "").includes(SAVED), "later-A valid pricing save shows saved");
      assert.equal(textValue(container, A_LABEL), "BROUILLON-REGLE-A-SECOND-CONTEXTE");
      assert.equal(feeValue(container, A_LABEL), "7");
      assert.equal(readsOf(A_ID), readsOfABefore + 1, "exactly one reread, by the valid later-A save");

      // And B, revisited afterwards, is still clean.
      switchRestaurant(container, B_ID);
      await loadedIn(container, B_NAME, B_LABEL, B_TEXT_INITIAL);
      assertCleanB(container, "B revisited after A/B/A");
    } finally {
      root.unmount();
      container.remove();
    }
  });
}
