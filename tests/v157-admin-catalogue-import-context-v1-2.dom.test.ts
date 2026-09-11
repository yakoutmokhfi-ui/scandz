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
// ADMIN CATALOGUE IMPORT ENTRY POINT v1.2 — SELECTED ESTABLISHMENT
// CONTEXT REMEDIATION.
//
// PRODUCTION BUG (verified independently, not assumed — see the
// header comment of app/dashboard/catalogue-import/page.tsx and the
// package README for the full root-cause writeup): before v1.2, the
// page correctly resolved `restaurantId` state from `?r=`, but
// populated the VISIBLE selector from `getMerchantRestaurants()`
// (merchant-membership authority, restaurant_users) — a source with
// no relationship to `?r=`. When the admin/operator account also had
// a restaurant_users row for a DIFFERENT establishment than the one
// selected in the cockpit, the rendered `<select>` had no `<option>`
// matching `restaurantId`, and the browser silently displayed its
// first (and only) real option instead — a different establishment
// than the one the Admin actually opened from the cockpit.
//
// This file proves the v1.2 fix: the selector is now sourced
// EXCLUSIVELY from `listOperatorEstablishments()` (Admin/Operator
// directory, RLS `is_scanym_operator()`, never restaurant_users), and
// `?r=` is never silently overridden by that list's ordering, by a
// "first establishment" fallback, or by merchant membership. It also
// proves the mandated Preview/Commit safety rule: switching
// establishment after a Preview was generated invalidates that
// Preview and the commit path, requiring a fresh Analyze.
//
// Real DOM render (jsdom) of the real page component, same
// esbuild/jsdom harness pattern as every other *.dom.test.ts file in
// this repo, and the same mock shape as
// tests/v156-admin-catalogue-import-authorization-v1-1.dom.test.ts
// (unchanged by this lot, re-run separately as regression — it
// already re-proves the Admin-only authorization gate is untouched).
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

// AU_LAIT_CRU and SANAA reproduce the exact Production evidence names
// from the mandate ("Au lait cru" cockpit selection vs. "Sanaa
// Cookies & Fondant" wrongly displayed).
const AU_LAIT_CRU = { restaurantId: "aulaitcru-id", name: "Au lait cru", slug: "au-lait-cru", country: "FR", status: "active" };
const SANAA = { restaurantId: "sanaa-id", name: "Sanaa Cookies & Fondant", slug: "sanaa-cookies-fondant", country: "FR", status: "active" };
const DIRECTORY = [SANAA, AU_LAIT_CRU]; // deliberately NOT in ?r= order, to prove array ordering never wins

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockEstablishments = DIRECTORY;
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

const MOCK_OPERATOR_DIRECTORY = `
export async function listOperatorEstablishments() {
  return (globalThis).__mockEstablishments ?? [];
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
  "@/lib/services/operator-directory": MOCK_OPERATOR_DIRECTORY,
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

async function waitFor(check: () => boolean, timeoutMs = 1500, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function resetMocks(opts: { establishments?: any[] } = {}) {
  (globalThis as any).__mockUser = { id: "operator-1" };
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockEstablishments = opts.establishments ?? DIRECTORY;
  (globalThis as any).__mockReplaceCalls = [];
  (globalThis as any).__mockAnalyzeCalls = [];
  (globalThis as any).__mockCommitCalls = [];
}

function hasUploadUi(container: HTMLElement): boolean {
  return !!container.querySelector('input[type="file"]');
}

function getSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector("select") as HTMLSelectElement;
  assert.ok(select, "le sélecteur d'établissement doit être présent (contexte Admin autorisé)");
  return select;
}

function selectedName(container: HTMLElement): string {
  // The "Établissement sélectionné : X" line, not the <select>'s
  // (possibly stale, unselected-because-mismatched) native rendering
  // -- exactly the distinction the Production bug was about.
  const paragraphs = [...container.querySelectorAll("p")];
  const p = paragraphs.find((el) => el.textContent?.startsWith("Établissement sélectionné"));
  assert.ok(p, "la ligne 'Établissement sélectionné :' doit être présente");
  return p!.textContent!.replace("Établissement sélectionné :", "").trim();
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
}

async function selectFile(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  assert.ok(fileInput, "le sélecteur de fichier doit être présent");
  const file = new window.File(["fake-bytes"], "catalogue.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush();
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

// ====================================================================
// Items 1 & 2 — ?r=<établissement> sélectionné par défaut, y compris
// quand la liste (ordre du tableau) place un AUTRE établissement en
// premier -- reproduit exactement la preuve de Production (le
// répertoire liste Sanaa AVANT Au lait cru, `?r=` doit quand même
// gagner).
// ====================================================================

test("v1.2 CONTEXTE : ?r=<Au lait cru> -> Au lait cru sélectionné par défaut, malgré un répertoire qui liste Sanaa en premier", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));
  await flush();

  assert.equal(getSelect(container).value, AU_LAIT_CRU.restaurantId);
  assert.equal(selectedName(container), AU_LAIT_CRU.name);

  root.unmount();
  container.remove();
});

test("v1.2 CONTEXTE : ?r=<Sanaa> -> Sanaa sélectionné par défaut", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${SANAA.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));
  await flush();

  assert.equal(getSelect(container).value, SANAA.restaurantId);
  assert.equal(selectedName(container), SANAA.name);

  root.unmount();
  container.remove();
});

// ====================================================================
// Item 3 — l'Admin peut explicitement basculer de Au lait cru vers
// Sanaa.
// ====================================================================

test("v1.2 CONTEXTE : l'Admin peut explicitement basculer de Au lait cru vers Sanaa via le sélecteur", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));
  await flush();
  assert.equal(getSelect(container).value, AU_LAIT_CRU.restaurantId);

  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();

  assert.equal(getSelect(container).value, SANAA.restaurantId);
  assert.equal(selectedName(container), SANAA.name);

  root.unmount();
  container.remove();
});

// ====================================================================
// Item 4 — le répertoire opérateur (listOperatorEstablishments) ne
// peut jamais écraser ?r=, même quand il ne contient PAS
// l'établissement demandé par ?r= (cas encore plus strict que la
// preuve de Production : ici l'établissement demandé n'est même pas
// dans la liste chargée).
// ====================================================================

test("v1.2 CONTEXTE : listOperatorEstablishments() ne peut pas écraser ?r=, même si ?r= est absent de la liste chargée", async () => {
  resetMocks({ establishments: [SANAA] }); // Au lait cru volontairement absent de la liste
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));
  await flush();

  assert.equal(
    getSelect(container).value,
    AU_LAIT_CRU.restaurantId,
    "?r= doit rester la valeur sélectionnée même absente du répertoire chargé -- jamais un repli silencieux sur Sanaa"
  );
  assert.notEqual(
    selectedName(container),
    SANAA.name,
    "le nom affiché ne doit JAMAIS être celui d'un autre établissement que celui demandé par ?r="
  );

  root.unmount();
  container.remove();
});

// ====================================================================
// Item 5 — l'ordre du tableau renvoyé par le répertoire ne peut pas
// écraser ?r= (le fixture DIRECTORY place Sanaa AVANT Au lait cru
// délibérément ; déjà couvert par les tests 1/2 ci-dessus, reformulé
// ici explicitement contre l'ordre).
// ====================================================================

test("v1.2 CONTEXTE : l'ordre du tableau (Sanaa en position 0, Au lait cru en position 1) ne détermine jamais la sélection par défaut", async () => {
  resetMocks({ establishments: [SANAA, AU_LAIT_CRU] });
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));
  await flush();

  assert.equal(getSelect(container).value, AU_LAIT_CRU.restaurantId);
  assert.equal(selectedName(container), AU_LAIT_CRU.name, "jamais Sanaa (position 0) simplement parce qu'il est premier");

  root.unmount();
  container.remove();
});

// ====================================================================
// Items 6 & 7 — Preview et Commit reçoivent tous deux le
// restaurantId COURANT sélectionné par l'Admin.
// ====================================================================

test("v1.2 CONTEXTE : Preview (OB-3) reçoit le restaurantId courant sélectionné par l'Admin", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${SANAA.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);

  assert.deepEqual((globalThis as any).__mockAnalyzeCalls, [{ restaurantId: SANAA.restaurantId }]);

  root.unmount();
  container.remove();
});

test("v1.2 CONTEXTE : Commit (OB-4) reçoit le MÊME restaurantId que la Preview qui l'a précédé", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${SANAA.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);
  await flush();

  findButtonByText(container, "Confirmer l’import")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  findButtonByText(container, "Oui, importer maintenant")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockCommitCalls.length > 0);

  assert.deepEqual((globalThis as any).__mockCommitCalls, [{ restaurantId: SANAA.restaurantId }]);

  root.unmount();
  container.remove();
});

// ====================================================================
// Items 8 & 9 — changer d'établissement APRÈS une Preview invalide
// cette Preview ; le Commit reste désactivé jusqu'à une nouvelle
// Preview pour le nouvel établissement.
// ====================================================================

test("v1.2 SÉCURITÉ : changer d'établissement après une Preview invalide cette Preview (le résumé Preview disparaît)", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);
  await flush();

  // Preview affichée : le fichier analysé apparaît dans le compte-rendu.
  assert.ok(
    container.textContent?.includes("catalogue.xlsx"),
    "le résumé de la Preview doit être visible avant tout changement d'établissement"
  );

  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();

  assert.equal(
    container.textContent?.includes("ligne(s) analysée(s)"),
    false,
    "le résumé de la Preview précédente (Au lait cru) ne doit plus être affiché après bascule vers Sanaa"
  );

  root.unmount();
  container.remove();
});

test("v1.2 SÉCURITÉ : le bouton Confirmer reste désactivé après un changement d'établissement, jusqu'à une nouvelle Analyse", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length > 0);
  await flush();

  const confirmBtnBefore = findButtonByText(container, "Confirmer l’import");
  assert.equal(confirmBtnBefore!.hasAttribute("disabled"), false, "Confirmer doit être actif juste après une Preview éligible");

  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();

  const confirmBtnAfter = findButtonByText(container, "Confirmer l’import");
  assert.equal(
    confirmBtnAfter!.hasAttribute("disabled"),
    true,
    "Confirmer doit redevenir inactif après un changement d'établissement -- jamais de confirmation sur une Preview d'un autre établissement"
  );
  assert.deepEqual((globalThis as any).__mockCommitCalls, [], "aucun commit ne doit avoir eu lieu");

  // Une nouvelle Analyse pour Sanaa réactive normalement le flux.
  await selectFile(container);
  findButtonByText(container, "Analyser")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 2);
  await flush();
  assert.deepEqual((globalThis as any).__mockAnalyzeCalls[1], { restaurantId: SANAA.restaurantId });
  assert.equal(findButtonByText(container, "Confirmer l’import")!.hasAttribute("disabled"), false);

  root.unmount();
  container.remove();
});

// ====================================================================
// Item 10 — ?r= absent : géré proprement, sélection explicite requise
// (aucune présélection automatique, jamais un "premier établissement"
// implicite).
// ====================================================================

test("v1.2 CONTEXTE : ?r= absent -> aucun établissement présélectionné, sélection explicite requise (jamais un repli sur le premier de la liste)", async () => {
  resetMocks();
  window.history.pushState({}, "", "/dashboard/catalogue-import");
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));
  await flush();

  assert.equal(getSelect(container).value, "", "aucune présélection automatique en l'absence de ?r=");
  assert.equal(selectedName(container), "aucun");

  const analyzeBtn = findButtonByText(container, "Analyser");
  assert.equal(analyzeBtn!.hasAttribute("disabled"), true, "Analyser doit rester inactif tant qu'aucun établissement n'est choisi");

  setSelectValue(getSelect(container), AU_LAIT_CRU.restaurantId);
  await flush();
  assert.equal(getSelect(container).value, AU_LAIT_CRU.restaurantId, "l'Admin peut ensuite choisir explicitement");

  root.unmount();
  container.remove();
});
