import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { buildMinimalDocx, wordDocumentXml, bookmarkedParagraphXml, plainParagraphXml } from "./helpers/docx-fixture-builder.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// W1 TARGETED REMEDIATION (BOULEZ audit, candidate c5924a5, FAIL) --
// W1-04 -- RESTAURANT CONTEXT ISOLATION for the CGV DOCX import/review
// panel (app/dashboard/legal-cgv/page.tsx).
//
// Same technique as
// tests/restaurant-context-critical-regression-gate-legal-cgv.dom.test.ts
// (real component, esbuild + jsdom, driven through the real
// DashboardNav restaurant <select>, same-instance, no unmount) --
// deliberately a SEPARATE file: that other suite is a PERMANENT,
// INTENTIONALLY RED gate for a different, pre-existing, out-of-scope
// bug (load()'s legal/CGV/template state has no stale-response guard
// at all); this suite verifies this lot's OWN fix
// (`beginLegalCgvOperation()` reused by `importCgvDocxFile`, plus the
// `docxReviewRestaurantId` render gate and the explicit reset in
// `handleSelectRestaurant`) and is expected to be GREEN.
//
// `getMerchantLegalProfile`/`getMerchantCgvProfile`/the CGV template
// RPC are all given IMMEDIATE (non-deferred) per-restaurant fallbacks
// here -- this suite is not about load()'s own timing, only about the
// DOCX import pipeline's. The one thing kept fully under test control
// is `File.arrayBuffer()` (the only `await` inside
// `importCgvDocxFile`), via a small controllable fake File below --
// `readDocxDocument`/`diffCgvDocxImport` themselves are the REAL,
// unmocked modules (this also exercises the exact same
// fflate-via-esbuild resolution path as the other two `.dom.test.ts`
// suites -- see the deliverable's WINDOWS HARNESS section).
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

/** A minimal fake `File` whose `arrayBuffer()` is fully under test
 *  control -- `importCgvDocxFile`'s one and only `await`. Everything
 *  else (`readDocxDocument`, `diffCgvDocxImport`) stays the real,
 *  unmocked module. */
class ControlledFile {
  private readonly deferred: Deferred<ArrayBuffer>;
  constructor(deferred: Deferred<ArrayBuffer>) {
    this.deferred = deferred;
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return this.deferred.promise;
  }
}

function cgvProfile(id: string) {
  return {
    restaurant_id: id,
    withdrawal_regime: "EXEMPT_PERISHABLE" as const,
    preparation_time_min: 10,
    preparation_time_max: 20,
    preparation_time_unit: "MINUTES" as const,
    cancellation_policy_text: "Politique d'annulation.",
    substitution_policy_text: "Politique de substitution.",
    presentation_variant: "FORMAL" as const,
    status: "CGV_DRAFT" as const,
    profile_version: 1,
    updated_at: null,
    completeness_errors: [] as string[],
    cold_chain_applicable: false,
    weight_pricing_mode: null,
  };
}
function cgvTemplateRpcResult() {
  return {
    data: {
      id: "tpl-1",
      controlled_sections: {
        header: "Conditions générales de vente",
        identity_intro: "Les présentes conditions régissent les ventes.",
        withdrawal_clauses: { EXEMPT_PERISHABLE: "Pas de rétractation.", STANDARD_14_DAYS: null, MIXED: null },
        mediator_clause: "Médiateur",
        preparation_clause: "Préparation",
        cancellation_clause_label: "Annulation",
        substitution_clause_label: "Remplacement",
        jurisdiction_clause: "Juridiction",
      },
    },
    error: null,
  };
}

(globalThis as any).__mappings = [
  { restaurant_id: "resto-a", role: "owner", restaurants: { id: "resto-a", name: "Restaurant A", slug: "a" } },
  { restaurant_id: "resto-b", role: "owner", restaurants: { id: "resto-b", name: "Restaurant B", slug: "b" } },
];
// Immediate, non-deferred fallbacks for BOTH restaurants -- this
// suite is not about load()'s own staleness (a separate, pre-existing,
// out-of-scope concern covered by the other gate file), only about
// the DOCX import pipeline layered on top of it once `cgv`/`template`
// are already loaded.
(globalThis as any).__legalFallback = {
  "resto-a": { restaurant_id: "resto-a", legal_entity_name: "Resto A SARL" },
  "resto-b": { restaurant_id: "resto-b", legal_entity_name: "Resto B SARL" },
};
(globalThis as any).__cgvFallback = { "resto-a": cgvProfile("resto-a"), "resto-b": cgvProfile("resto-b") };
(globalThis as any).__templateFallback = { "resto-a": cgvTemplateRpcResult(), "resto-b": cgvTemplateRpcResult() };

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
export const supabase = {
  rpc: async (fnName, args) => {
    const restaurantId = args && args.p_restaurant_id;
    const fallback = (globalThis).__templateFallback?.[restaurantId];
    return fallback ?? { data: null, error: null };
  },
};
`;
const MOCK_LEGAL_CGV = `
export class PublishCgvError extends Error {}
export class ActivateCgvError extends Error {}
export async function getMerchantLegalProfile(restaurantId) {
  const fallback = (globalThis).__legalFallback?.[restaurantId];
  return fallback ?? null;
}
export async function getMerchantCgvProfile(restaurantId) {
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
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
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
  // W1 REMEDIATION -- see the identical comment in
  // tests/cgv-publication-boundary-v1.dom.test.ts's own client build.
  platform: "browser",
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

function docxReview(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="legal-cgv-docx-diff"]');
}

function triggerImport(container: HTMLElement, file: ControlledFile) {
  const input = container.querySelector('[data-testid="legal-cgv-docx-import-input"]') as HTMLInputElement | null;
  assert.ok(input, "the DOCX import file input must be present (canEdit=owner for both fixtures)");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

/** A minimal, valid .docx carrying exactly the ONE unconditional CGV
 *  chapter ("identité du vendeur", present in every template) with a
 *  distinct, impossible-to-confuse marker in its body -- the current
 *  model will have several OTHER chapters this import never mentions
 *  (surfaced as `removedChapters`, irrelevant to this suite), but the
 *  one matched chapter's body-paragraph diff is directly observable
 *  in `container.textContent`. */
function markerDocx(marker: string): ArrayBuffer {
  const body =
    bookmarkedParagraphXml(0, "cgv_identite_du_vendeur", "Identité du vendeur") + plainParagraphXml(marker);
  return buildMinimalDocx(wordDocumentXml(body));
}

test("CGV DOCX import — W1-04: import under A shows A's review while A is selected", async () => {
  const { container, root } = render();
  await waitFor(() => docxReview(container) === null && container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  const deferred = makeDeferred<ArrayBuffer>();
  triggerImport(container, new ControlledFile(deferred));
  deferred.resolve(markerDocx("MARKER-FILE-A"));
  await waitFor(() => docxReview(container) !== null);

  assert.ok(docxReview(container), "the review must be shown for A right after A's own import completes");
  assert.ok(container.textContent!.includes("MARKER-FILE-A"), "A's own imported content must be visible in the review");

  root.unmount();
  container.remove();
});

test("CGV DOCX import — W1-04: switching restaurant clears the current DOCX review", async () => {
  const { container, root } = render();
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  const deferred = makeDeferred<ArrayBuffer>();
  triggerImport(container, new ControlledFile(deferred));
  deferred.resolve(markerDocx("MARKER-FILE-A2"));
  await waitFor(() => docxReview(container) !== null);
  assert.ok(docxReview(container), "sanity check: A's review is shown before switching");

  switchTo(container, "resto-b");
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  assert.equal(docxReview(container), null, "the review must be cleared immediately on switching restaurant, before any import for B");
  assert.ok(!container.textContent!.includes("MARKER-FILE-A2"), "A's imported content must never remain visible after switching away");

  root.unmount();
  container.remove();
});

test("CGV DOCX import — W1-04: an import started for A that completes AFTER switching to B is discarded, never displayed under B", async () => {
  const { container, root } = render();
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  const deferredA = makeDeferred<ArrayBuffer>();
  triggerImport(container, new ControlledFile(deferredA));
  // Switch to B BEFORE A's file read resolves -- the exact mandate
  // reproduction: "an async import started under restaurant A can
  // complete after a context switch to B and show A's review under B".
  switchTo(container, "resto-b");
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);
  assert.equal(docxReview(container), null, "no review yet for B");

  // A's import now resolves, LATE, after B is already the active context.
  deferredA.resolve(markerDocx("MARKER-FILE-A3"));
  await flush(100);

  assert.equal(
    docxReview(container),
    null,
    "A's late-resolving import must NEVER commit a review while B is the active restaurant"
  );
  assert.ok(!container.textContent!.includes("MARKER-FILE-A3"), "A's stale imported content must never appear under B");

  root.unmount();
  container.remove();
});

test("CGV DOCX import — W1-04: switching back to A does not auto-resurrect A's previous review", async () => {
  const { container, root } = render();
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  const deferred = makeDeferred<ArrayBuffer>();
  triggerImport(container, new ControlledFile(deferred));
  deferred.resolve(markerDocx("MARKER-FILE-A4"));
  await waitFor(() => docxReview(container) !== null);

  switchTo(container, "resto-b");
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);
  assert.equal(docxReview(container), null);

  switchTo(container, "resto-a");
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  assert.equal(
    docxReview(container),
    null,
    "switching back to A must never automatically resurrect A's earlier, already-cleared review -- nothing is persisted anywhere"
  );
  assert.ok(!container.textContent!.includes("MARKER-FILE-A4"));

  root.unmount();
  container.remove();
});

test("CGV DOCX import — W1-04: B's own import shows ONLY B's content, never any trace of A's", async () => {
  const { container, root } = render();
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);

  const deferredA = makeDeferred<ArrayBuffer>();
  triggerImport(container, new ControlledFile(deferredA));
  deferredA.resolve(markerDocx("MARKER-FILE-A5"));
  await waitFor(() => docxReview(container) !== null);

  switchTo(container, "resto-b");
  await waitFor(() => container.querySelector('[data-testid="legal-cgv-docx-import-input"]') !== null);
  assert.equal(docxReview(container), null);

  const deferredB = makeDeferred<ArrayBuffer>();
  triggerImport(container, new ControlledFile(deferredB));
  deferredB.resolve(markerDocx("MARKER-FILE-B5"));
  await waitFor(() => docxReview(container) !== null);

  assert.ok(container.textContent!.includes("MARKER-FILE-B5"), "B's own imported content must be visible");
  assert.ok(!container.textContent!.includes("MARKER-FILE-A5"), "B's review must never carry any trace of A's earlier import");

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
  delete (globalThis as any).__legalFallback;
  delete (globalThis as any).__cgvFallback;
  delete (globalThis as any).__templateFallback;
});
