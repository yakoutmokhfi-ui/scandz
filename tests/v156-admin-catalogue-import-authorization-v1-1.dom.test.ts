import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// ADMIN CATALOGUE IMPORT ENTRY POINT v1.1 — TARGETED AUTHORIZATION
// REMEDIATION.
//
// Business rule: catalogue mass import/re-import is ADMIN ONLY. This
// exercises app/dashboard/catalogue-import/page.tsx directly (the
// SOLE caller of analyzeCatalogueImportFile/commitCatalogueImport in
// application code — confirmed by grep before writing this lot),
// independently of the Admin Cockpit entry point covered by
// tests/v155-admin-catalogue-import-entry-point.dom.test.ts (unchanged
// by this lot).
//
// Real DOM render (jsdom) of the real page component, same
// esbuild/jsdom harness pattern as every other *.dom.test.ts file in
// this repo. `@/lib/services/catalogue-import` and
// `@/lib/services/catalogue-import-commit` (OB-3/OB-4, already
// published, NOT modified by this lot) are mocked here only to record
// whether/how they were called — never to reimplement or duplicate
// their internal logic, which is proven unchanged separately by the
// OB-3/OB-4 regression suite (tests/lot-ob3-*.test.ts,
// tests/lot-ob4-*.test.ts, run and reported alongside this file).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/catalogue-import",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).File = window.File;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

// ---- Scenario fixtures --------------------------------------------
// r1 = merchant's OWN restaurant (they have a restaurant_users row)
// r2 = another establishment the merchant has no relationship with
const MAPPINGS_FOR_MERCHANT_R1 = [
  { restaurant_id: "r1", restaurants: { name: "Au Lait Cru" } },
];

(globalThis as any).__mockUser = { id: "user-1" };
(globalThis as any).__mockIsOperator = false;
(globalThis as any).__mockMappings = [] as any[];
(globalThis as any).__mockReplaceCalls = [] as string[];
(globalThis as any).__mockAnalyzeCalls = [] as Array<{ restaurantId: string }>;
(globalThis as any).__mockCommitCalls = [] as Array<{ restaurantId: string }>;
(globalThis as any).__mockAnalyzeResult = {
  kind: "OK",
  fileName: "catalogue.xlsx",
  sourceFormat: "xlsx",
  report: {
    totalRows: 1,
    eligibility: "ELIGIBLE",
    okRows: 1,
    warningRows: 0,
    blockedRows: 0,
    columnMapWarnings: [],
    rows: [
      {
        row: 2,
        status: "OK",
        plannedAction: "CREATE",
        normalizedValues: { name: "Camembert" },
        resolvedCategory: null,
        resolvedSubcategory: null,
        photoFilename: null,
        errors: [],
        warnings: [],
        infos: [],
      },
    ],
  },
};
(globalThis as any).__mockCommitResult = {
  kind: "COMMITTED",
  fileName: "catalogue.xlsx",
  categoriesCreated: 0,
  subcategoriesCreated: 0,
  productsCreated: 1,
  productsUpdated: 0,
  productsSkipped: 0,
  productsFailed: 0,
  rows: [],
};

const MOCK_NAV = `
const _router = {
  replace: (href) => { (globalThis).__mockReplaceCalls.push(href); },
  push: () => {},
};
export function useRouter() {
  return _router;
}
`;

const MOCK_AUTH = `
export async function getUser() { return (globalThis).__mockUser; }
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__mockIsOperator; }
`;

const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() {
  const m = (globalThis).__mockMappings;
  if (!m || m.length === 0) { throw new Error("no restaurant_users row"); }
  return m;
}
`;

const MOCK_CATALOGUE_IMPORT = `
export async function analyzeCatalogueImportFile(file, restaurantId) {
  (globalThis).__mockAnalyzeCalls.push({ restaurantId });
  return (globalThis).__mockAnalyzeResult;
}
`;

const MOCK_CATALOGUE_IMPORT_COMMIT = `
export async function commitCatalogueImport(file, restaurantId) {
  (globalThis).__mockCommitCalls.push({ restaurantId });
  return (globalThis).__mockCommitResult;
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/catalogue-import": MOCK_CATALOGUE_IMPORT,
  "@/lib/services/catalogue-import-commit": MOCK_CATALOGUE_IMPORT_COMMIT,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
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
export { default as CatalogueImportPage } from "@/app/dashboard/catalogue-import/page.tsx";
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
const tmpFile = path.join(tmpDir, "CatalogueImportPage.mjs");
writeFileSync(tmpFile, code);
const { CatalogueImportPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CatalogueImportPage));
  return { container, root };
}

function flush(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Active-polling helper: this shares a process with ~2600+ other
 * tests, a fixed sleep is flaky under load, so poll until the
 * condition holds or timeoutMs elapses (established pattern, see
 * e.g. tests/v150-bulk-product-photos.dom.test.ts). */
async function waitFor(check: () => boolean, timeoutMs = 1500, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function resetMocks(opts: {
  user: { id: string } | null;
  isOperator: boolean;
  mappings?: any[];
}) {
  (globalThis as any).__mockUser = opts.user;
  (globalThis as any).__mockIsOperator = opts.isOperator;
  (globalThis as any).__mockMappings = opts.mappings ?? [];
  (globalThis as any).__mockReplaceCalls = [];
  (globalThis as any).__mockAnalyzeCalls = [];
  (globalThis as any).__mockCommitCalls = [];
}

function hasUploadUi(container: HTMLElement): boolean {
  return !!container.querySelector('input[type="file"]');
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
}

async function selectFile(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  assert.ok(fileInput, "le sélecteur de fichier doit être présent (contexte autorisé)");
  const file = new window.File(["fake-bytes"], "catalogue.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush();
}

// ====================================================================
// 1 & 2. ADMIN/OPERATOR, ?r=<selected establishment> -> ALLOWED,
// correct restaurant context propagated.
// ====================================================================

test("v1.1 AUTHZ : admin/opérateur avec ?r=r1 -> page ALLOWED (upload visible, aucune redirection)", async () => {
  resetMocks({ user: { id: "operator-1" }, isOperator: true });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  assert.ok(hasUploadUi(container), "un opérateur autorisé doit voir le sélecteur de fichier");
  assert.deepEqual(
    (globalThis as any).__mockReplaceCalls,
    [],
    "un opérateur autorisé ne doit jamais être redirigé"
  );

  root.unmount();
  container.remove();
});

test("v1.1 AUTHZ : le contexte restaurant (?r=r1) est correctement propagé jusqu'à l'analyse OB-3", async () => {
  resetMocks({ user: { id: "operator-1" }, isOperator: true });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  const analyzeBtn = findButtonByText(container, "Analyser");
  assert.ok(analyzeBtn, "le bouton Analyser doit être présent");
  analyzeBtn!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);

  assert.deepEqual(
    (globalThis as any).__mockAnalyzeCalls,
    [{ restaurantId: "r1" }],
    "analyzeCatalogueImportFile doit recevoir exactement r1 (l'établissement du ?r= de l'URL), jamais un autre id"
  );

  root.unmount();
  container.remove();
});

// ====================================================================
// 3, 4, 5. MERCHANT (authenticated, not operator) direct URL access
// -> DENIED in every variant.
// ====================================================================

test("v1.1 AUTHZ : marchand, URL directe SANS ?r= -> DENIED (redirection /dashboard, aucune UI d'import)", async () => {
  resetMocks({ user: { id: "merchant-1" }, isOperator: false, mappings: MAPPINGS_FOR_MERCHANT_R1 });
  window.history.pushState({}, "", "/dashboard/catalogue-import");
  const { container, root } = render();
  await waitFor(() => (globalThis as any).__mockReplaceCalls.length > 0);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard"]);
  assert.equal(hasUploadUi(container), false, "aucun sélecteur de fichier ne doit apparaître pour un marchand");
  assert.deepEqual((globalThis as any).__mockAnalyzeCalls, [], "OB-3 ne doit jamais être atteint");

  root.unmount();
  container.remove();
});

test("v1.1 AUTHZ : marchand, URL directe avec ?r=<son PROPRE restaurant> -> DENIED (pas de contournement via restaurant en propre)", async () => {
  resetMocks({ user: { id: "merchant-1" }, isOperator: false, mappings: MAPPINGS_FOR_MERCHANT_R1 });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => (globalThis as any).__mockReplaceCalls.length > 0);

  assert.deepEqual(
    (globalThis as any).__mockReplaceCalls,
    ["/dashboard"],
    "posséder restaurant_users pour r1 ne doit PAS suffire à accéder à l'import en masse"
  );
  assert.equal(hasUploadUi(container), false);
  assert.deepEqual((globalThis as any).__mockAnalyzeCalls, []);
  assert.deepEqual((globalThis as any).__mockCommitCalls, []);

  root.unmount();
  container.remove();
});

test("v1.1 AUTHZ : marchand, URL directe avec ?r=<un AUTRE restaurant> -> DENIED", async () => {
  resetMocks({ user: { id: "merchant-1" }, isOperator: false, mappings: MAPPINGS_FOR_MERCHANT_R1 });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r2");
  const { container, root } = render();
  await waitFor(() => (globalThis as any).__mockReplaceCalls.length > 0);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard"]);
  assert.equal(hasUploadUi(container), false);
  assert.deepEqual((globalThis as any).__mockAnalyzeCalls, []);

  root.unmount();
  container.remove();
});

// ====================================================================
// 6. anon (no session) -> DENIED (pre-existing behaviour, confirmed
// non-regressed by this lot).
// ====================================================================

test("v1.1 AUTHZ : anonyme (aucune session) -> DENIED (redirection /dashboard/login, comportement préexistant non régressé)", async () => {
  resetMocks({ user: null, isOperator: false });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => (globalThis as any).__mockReplaceCalls.length > 0);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard/login"]);
  assert.equal(hasUploadUi(container), false);

  root.unmount();
  container.remove();
});

// ====================================================================
// 7. Authenticated but unrelated user (no restaurant_users row
// anywhere, not an operator) -> DENIED.
// ====================================================================

test("v1.1 AUTHZ : utilisateur authentifié SANS lien avec un établissement (ni opérateur, ni restaurant_users) -> DENIED", async () => {
  resetMocks({ user: { id: "stranger-1" }, isOperator: false, mappings: [] });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => (globalThis as any).__mockReplaceCalls.length > 0);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard"]);
  assert.equal(hasUploadUi(container), false);
  assert.deepEqual((globalThis as any).__mockAnalyzeCalls, []);

  root.unmount();
  container.remove();
});

// ====================================================================
// 8 & 9. Admin preview still reaches OB-3; admin commit still reaches
// OB-4 -- via the SAME, unmodified page wiring.
// ====================================================================

test("v1.1 AUTHZ : admin autorisé -> Analyser atteint bien analyzeCatalogueImportFile (OB-3), inchangé", async () => {
  resetMocks({ user: { id: "operator-1" }, isOperator: true });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);

  assert.equal((globalThis as any).__mockAnalyzeCalls.length, 1, "OB-3 doit être appelé exactement une fois");

  root.unmount();
  container.remove();
});

test("v1.1 AUTHZ : admin autorisé -> confirmation explicite atteint bien commitCatalogueImport (OB-4), inchangé, jamais avant confirmation", async () => {
  resetMocks({ user: { id: "operator-1" }, isOperator: true });
  window.history.pushState({}, "", "/dashboard/catalogue-import?r=r1");
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);
  await flush();

  // Item 10 (pas de mutation avant confirmation explicite) : à ce
  // stade, seul l'aperçu (OB-3) a été appelé -- jamais le commit.
  assert.deepEqual(
    (globalThis as any).__mockCommitCalls,
    [],
    "aucune mutation ne doit avoir eu lieu avant le clic explicite de confirmation"
  );

  findButtonByText(container, "Confirmer l’import")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  findButtonByText(container, "Oui, importer maintenant")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockCommitCalls.length > 0);

  assert.deepEqual(
    (globalThis as any).__mockCommitCalls,
    [{ restaurantId: "r1" }],
    "commitCatalogueImport (OB-4) doit être appelé exactement une fois, pour r1"
  );

  root.unmount();
  container.remove();
});
