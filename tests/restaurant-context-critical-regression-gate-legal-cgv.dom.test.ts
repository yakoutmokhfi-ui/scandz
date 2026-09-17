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
// Restaurant Context Critical Regression Gate — LEGAL/CGV module
// (app/dashboard/legal-cgv/page.tsx).
//
// Same invariant, same technique as
// tests/restaurant-context-critical-regression-gate-orders.dom.test.ts
// (real component, esbuild + jsdom, driven through the real
// DashboardNav restaurant <select>, same-instance, no unmount).
//
// UNLIKE Orders (already guarded by ordersRequestSeqRef +
// selectedRestaurantIdRef), this module's `load()` function has NO
// generation/restaurant guard at all around
// `setLegal(legalRow ?? {})` (read app/dashboard/legal-cgv/page.tsx
// lines 59-76 before writing this test). This suite is therefore
// EXPECTED to demonstrate a live regression, not a false alarm --
// that is the point of a permanent gate: it must fail red today and
// turn green only once Claude Monet's functional fix lands. No
// functional fix is included here.
//
// v1.1 remediation (RCG-02, Cat Stevens) -- the v1 suite only proved
// `legal.legal_entity_name` (a MerchantLegalProfile field) was
// stale-safe; getMerchantCgvProfile() was hardcoded to always return
// null, so the REAL CGV profile (cancellation policy, etc.) and the
// template loaded in the SAME Promise.all (load()'s three-way
// Promise.all: legal profile, CGV profile, CGV template RPC) were
// never actually exercised. This suite now uses distinct, impossible-
// to-confuse A/B fixtures for all three members of that Promise.all
// and renders the REAL `@/lib/legal/render` module (not mocked) to
// prove the combined preview output -- not just one shallow field --
// is stale-safe (or, today, correctly is NOT).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/legal-cgv?r=resto-a",
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

// RCG-02 fixture factories -- distinct, impossible-to-confuse A/B values
// for the REAL CGV profile and the REAL CGV template, not just legal
// identity. `cancellation_policy_text` and `template.header` are both
// echoed VERBATIM into the rendered preview HTML by the real
// `@/lib/legal/render` module (used un-mocked in this suite), so a leak
// of either is directly observable in `container.textContent`.
function cgvProfile(id: string, marker: string) {
  return {
    restaurant_id: id,
    withdrawal_regime: "EXEMPT_PERISHABLE" as const,
    preparation_time_min: 10,
    preparation_time_max: 20,
    preparation_time_unit: "MINUTES" as const,
    cancellation_policy_text: `CGV-POLICY-${marker}`,
    substitution_policy_text: `CGV-SUBST-${marker}`,
    presentation_variant: "FORMAL" as const,
    status: "CGV_DRAFT" as const,
    profile_version: 1,
    updated_at: null,
    completeness_errors: [] as string[],
    cold_chain_applicable: false,
    weight_pricing_mode: null,
  };
}
function cgvTemplateRpcResult(marker: string) {
  return {
    data: {
      id: `tpl-${marker}`,
      controlled_sections: {
        header: `TEMPLATE-HEADER-${marker}`,
        identity_intro: `Intro ${marker}`,
        withdrawal_clauses: {
          EXEMPT_PERISHABLE: `Clause EXEMPT ${marker}`,
          STANDARD_14_DAYS: null,
          MIXED: null,
        },
        mediator_clause: `Mediator ${marker}`,
        preparation_clause: `Prep ${marker}`,
        cancellation_clause_label: "Annulation",
        substitution_clause_label: "Remplacement",
        jurisdiction_clause: `Jurisdiction ${marker}`,
      },
    },
    error: null,
  };
}

(globalThis as any).__mappings = [
  { restaurant_id: "resto-a", role: "owner", restaurants: { id: "resto-a", name: "Restaurant A", slug: "a" } },
  { restaurant_id: "resto-b", role: "owner", restaurants: { id: "resto-b", name: "Restaurant B", slug: "b" } },
];
(globalThis as any).__legalDeferred = new Map<string, Deferred<unknown>>();
(globalThis as any).__legalCallLog = [] as string[];

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/legal-cgv"; }
`;

const MOCK_AUTH = `
export async function getUser() { return { id: "staff-1" }; }
export async function signOut() {}
`;

const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() { return (globalThis).__mappings; }
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return false; }
export async function getEstablishmentSummary(id) { return { name: "Op " + id }; }
`;

const MOCK_SUPABASE = `
// RCG-02 -- the CGV TEMPLATE is loaded via supabase.rpc(...) in the SAME
// Promise.all as the legal profile and CGV profile (app/dashboard/legal-
// cgv/page.tsx: load()). It must be exercised with the same restaurant-
// scoped deferred/fallback control as the other two members of that
// Promise.all, not left hardcoded to null -- a hardcoded null can never
// demonstrate a stale-template leak.
export const supabase = {
  rpc: async (fnName, args) => {
    const restaurantId = args && args.p_restaurant_id;
    (globalThis).__templateCallLog = (globalThis).__templateCallLog ?? [];
    (globalThis).__templateCallLog.push(restaurantId);
    const deferred = (globalThis).__templateDeferred?.get(restaurantId);
    if (deferred) return deferred.promise;
    const fallback = (globalThis).__templateFallback?.[restaurantId];
    return fallback ?? { data: null, error: null };
  },
};
`;

const MOCK_LEGAL_CGV = `
export class PublishCgvError extends Error {}
export async function getMerchantLegalProfile(restaurantId) {
  (globalThis).__legalCallLog.push(restaurantId);
  const deferred = (globalThis).__legalDeferred.get(restaurantId);
  if (deferred) return deferred.promise;
  const fallback = (globalThis).__legalFallback?.[restaurantId];
  return fallback ?? null;
}
// RCG-02 -- previously hardcoded to always return null, which could only
// ever prove that "some" legal identity state was stale-safe, never that
// REAL CGV profile state (cancellation policy, etc.) is. Now
// restaurant-scoped and deferred-controllable exactly like
// getMerchantLegalProfile above.
export async function getMerchantCgvProfile(restaurantId) {
  (globalThis).__cgvCallLog = (globalThis).__cgvCallLog ?? [];
  (globalThis).__cgvCallLog.push(restaurantId);
  const deferred = (globalThis).__cgvDeferred?.get(restaurantId);
  if (deferred) return deferred.promise;
  const fallback = (globalThis).__cgvFallback?.[restaurantId];
  return fallback ?? null;
}
export async function updateMerchantLegalProfile() {}
export async function updateMerchantCgvProfile() {}
export async function publishMerchantCgvVersion() {}
export async function activateMerchantCgv() {}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/supabase": MOCK_SUPABASE,
  "@/lib/services/legal-cgv": MOCK_LEGAL_CGV,
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
export { default as LegalCgvPage } from "@/app/dashboard/legal-cgv/page";
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
const tmpFile = path.join(tmpDir, "LegalCgvPage.mjs");
writeFileSync(tmpFile, code);
const { LegalCgvPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await flush(stepMs);
  }
  await flush(stepMs);
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(LegalCgvPage));
  return { container, root };
}

function switchTo(container: HTMLElement, restaurantId: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the restaurant <select> switcher must be present in DashboardNav");
  select!.value = restaurantId;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function legalEntityNameInput(container: HTMLElement): HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll("input")).find(
    (el) => (el as HTMLInputElement).placeholder && !(el as HTMLInputElement).placeholder.match(/^\d/)
  ) as HTMLInputElement | undefined;
}

test("LEGAL/CGV — A→B→late A (same instance): B's legal profile must render and must never be overwritten by A's late response", async () => {
  (globalThis as any).__legalDeferred = new Map();
  (globalThis as any).__legalCallLog = [];
  const deferredA = makeDeferred<unknown>();
  (globalThis as any).__legalDeferred.set("resto-a", deferredA);
  (globalThis as any).__legalFallback = {
    "resto-b": { restaurant_id: "resto-b", legal_entity_name: "MARKER_B_LEGAL" },
  };

  const { container, root } = render();
  await waitFor(() => (globalThis as any).__legalCallLog.includes("resto-a"));

  const inputsBefore = Array.from(container.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value);
  assert.ok(!inputsBefore.includes("MARKER_A_LEGAL"), "A's request is still pending, nothing of A should be filled in yet");

  // Switch to B before A resolves.
  switchTo(container, "resto-b");
  await waitFor(() => {
    const values = Array.from(container.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value);
    return values.includes("MARKER_B_LEGAL");
  });

  let values = Array.from(container.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value);
  assert.ok(values.includes("MARKER_B_LEGAL"), "B's legal profile must be rendered after switching");
  assert.ok(!values.includes("MARKER_A_LEGAL"), "A must not be rendered while B is selected");

  // A's response finally resolves, LATE, after B is already displayed.
  deferredA.resolve({ restaurant_id: "resto-a", legal_entity_name: "MARKER_A_LEGAL" });
  await flush(80);

  values = Array.from(container.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value);
  assert.ok(values.includes("MARKER_B_LEGAL"), "B must STILL be rendered after A's stale response resolves");
  assert.ok(
    !values.includes("MARKER_A_LEGAL"),
    "REGRESSION (expected to currently FAIL — no functional fix applied by this gate): " +
      "load() in app/dashboard/legal-cgv/page.tsx has no generation/restaurant guard, so A's " +
      "stale late response overwrites B's already-displayed legal profile via an unconditional setLegal()."
  );

  root.unmount();
  container.remove();
});

test("LEGAL/CGV — RCG-02: real CGV profile + template (same Promise.all) — A→B→late A must never let B's CGV/template state revert to A's", async () => {
  // Cat Stevens' finding: getMerchantCgvProfile() was hardcoded to
  // always return null, so the v1 suite could only prove legal IDENTITY
  // (legal_entity_name) was stale-safe -- never the real CGV profile
  // (cancellation policy, etc.) or the CGV template, both loaded in the
  // SAME Promise.all as the legal profile. This test exercises all
  // three members of that Promise.all with distinct, impossible-to-
  // confuse A/B fixtures, and renders the REAL @/lib/legal/render
  // module (not mocked) so the combined preview text is genuinely
  // observable -- not just one shallow field.
  (globalThis as any).__legalDeferred = new Map();
  (globalThis as any).__legalCallLog = [];
  (globalThis as any).__cgvDeferred = new Map<string, Deferred<unknown>>();
  (globalThis as any).__cgvCallLog = [];
  (globalThis as any).__templateDeferred = new Map<string, Deferred<unknown>>();
  (globalThis as any).__templateCallLog = [];

  const deferredLegalA = makeDeferred<unknown>();
  const deferredCgvA = makeDeferred<unknown>();
  const deferredTemplateA = makeDeferred<unknown>();
  (globalThis as any).__legalDeferred.set("resto-a", deferredLegalA);
  (globalThis as any).__cgvDeferred.set("resto-a", deferredCgvA);
  (globalThis as any).__templateDeferred.set("resto-a", deferredTemplateA);

  (globalThis as any).__legalFallback = {
    "resto-b": { restaurant_id: "resto-b", legal_entity_name: "MARKER_B_LEGAL2" },
  };
  (globalThis as any).__cgvFallback = { "resto-b": cgvProfile("resto-b", "B") };
  (globalThis as any).__templateFallback = { "resto-b": cgvTemplateRpcResult("B") };

  const { container, root } = render();
  // 1-2. Restaurant A current; Legal/CGV load A pending (all three
  // Promise.all members deferred/held for resto-a).
  await waitFor(() => (globalThis as any).__cgvCallLog.includes("resto-a"));
  assert.ok(!container.textContent!.includes("CGV-POLICY-A"), "A's CGV request is still pending: nothing of A should render yet");
  assert.ok(container.querySelector("textarea") === null, "the CGV section (gated on `cgv` being non-null) must not render until load(A) actually resolves");

  // 3. Switch to B before A resolves; 4. Legal/CGV load B pending
  // (immediate here, via fallback) then resolves.
  switchTo(container, "resto-b");
  await waitFor(() => container.textContent!.includes("CGV-POLICY-B"));

  // 5-6. B's REAL CGV profile/template state is visible: the raw
  // controlled cancellation-policy textarea AND the rendered preview
  // (real renderCgv output, which embeds both business.cancellation
  // PolicyText and template.header) must both show B's markers.
  const cancellationTextarea = () =>
    (Array.from(container.querySelectorAll("textarea"))[0] as HTMLTextAreaElement | undefined);
  assert.equal(cancellationTextarea()?.value, "CGV-POLICY-B", "B's raw cancellation-policy CGV field must be shown");
  assert.ok(container.textContent!.includes("TEMPLATE-HEADER-B"), "B's real CGV template header must appear in the rendered preview");
  assert.ok(!container.textContent!.includes("CGV-POLICY-A"), "A's CGV data must not be present while B is selected");
  assert.ok(!container.textContent!.includes("TEMPLATE-HEADER-A"), "A's template data must not be present while B is selected");

  // 7. A resolves late -- legal, CGV profile, AND template together
  // (this page's real Promise.all commits all three atomically).
  deferredLegalA.resolve({ restaurant_id: "resto-a", legal_entity_name: "MARKER_A_LEGAL2" });
  deferredCgvA.resolve(cgvProfile("resto-a", "A"));
  deferredTemplateA.resolve(cgvTemplateRpcResult("A"));
  await flush(80);

  // 8. B's CGV profile/template state must remain unchanged -- this is
  // the exact false-negative Cat Stevens identified: legal identity
  // staying on B while CGV/template state silently reverts to A.
  assert.equal(
    cancellationTextarea()?.value,
    "CGV-POLICY-B",
    "REGRESSION (RCG-02, expected to currently FAIL — no functional fix applied by this gate): " +
      "B's raw CGV profile field (cancellation_policy_text) must STILL read B's value after A's stale, " +
      "same-Promise.all response resolves late -- load() has no generation/restaurant guard at all."
  );
  assert.ok(
    !container.textContent!.includes("CGV-POLICY-A") && !container.textContent!.includes("TEMPLATE-HEADER-A"),
    "REGRESSION (RCG-02, expected to currently FAIL — no functional fix applied by this gate): " +
      "neither A's stale CGV profile text nor A's stale template header may ever appear after switching to B, " +
      "even though A's legal/CGV/template response resolved in the SAME Promise.all this page's load() awaits unconditionally."
  );
  assert.ok(
    container.textContent!.includes("TEMPLATE-HEADER-B"),
    "B's own template header must still be the one rendered in the preview after A's stale response resolves"
  );

  root.unmount();
  container.remove();
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
  delete (globalThis as any).__mappings;
  delete (globalThis as any).__legalDeferred;
  delete (globalThis as any).__legalCallLog;
  delete (globalThis as any).__legalFallback;
  delete (globalThis as any).__cgvDeferred;
  delete (globalThis as any).__cgvCallLog;
  delete (globalThis as any).__cgvFallback;
  delete (globalThis as any).__templateDeferred;
  delete (globalThis as any).__templateCallLog;
  delete (globalThis as any).__templateFallback;
});
