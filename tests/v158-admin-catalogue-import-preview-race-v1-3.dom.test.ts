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
// ADMIN CATALOGUE IMPORT ENTRY POINT v1.3 — TARGETED ASYNC PREVIEW
// RACE REMEDIATION.
//
// AUDITOR FINDING (Catimini, HIGH, release-blocking): analyzing for
// establishment A, switching to establishment B before the response
// resolves, then letting A's delayed response resolve, could
// repopulate `result` with A's Preview while `restaurantId` was
// already B — violating the invariant VISIBLE ESTABLISHMENT = PREVIEW
// TARGET = COMMIT TARGET.
//
// This file exercises that exact race with a CONTROLLABLE mock:
// `analyzeCatalogueImportFile` returns a Promise whose resolver is
// captured in a queue (`__mockAnalyzeQueue`), keyed by an
// incrementing `callIndex` embedded in the resolved fileName
// (`catalogue-call-<N>.xlsx`) — this lets a test resolve calls in any
// order and assert, from the rendered DOM, exactly which call's
// content (if any) is currently displayed. This is the only way to
// deterministically prove "the response that arrives later does not
// win" without relying on real timing/flakiness.
//
// Real DOM render (jsdom) of the real page component, same
// esbuild/jsdom harness pattern as every other *.dom.test.ts file in
// this repo, and the same mock shape as
// tests/v157-admin-catalogue-import-context-v1-2.dom.test.ts
// (unchanged by this lot, re-run separately as regression).
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

const AU_LAIT_CRU = { restaurantId: "aulaitcru-id", name: "Au lait cru", slug: "au-lait-cru", country: "FR", status: "active" };
const SANAA = { restaurantId: "sanaa-id", name: "Sanaa Cookies & Fondant", slug: "sanaa-cookies-fondant", country: "FR", status: "active" };
const DIRECTORY = [AU_LAIT_CRU, SANAA];

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockEstablishments = DIRECTORY;
(globalThis as any).__mockReplaceCalls = [] as string[];
(globalThis as any).__mockAnalyzeCalls = [] as Array<{ restaurantId: string; callIndex: number }>;
(globalThis as any).__mockAnalyzeQueue = [] as Array<{ restaurantId: string; callIndex: number; resolve: (v: any) => void; reject: (e: any) => void }>;
(globalThis as any).__mockAnalyzeCallCount = 0;
(globalThis as any).__mockCommitCalls = [] as Array<{ restaurantId: string }>;
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

// Controllable, order-independent mock: each call is queued with its
// own resolver rather than resolved immediately -- the test decides
// when (and in what order) each call's response actually arrives.
const MOCK_CATALOGUE_IMPORT = `
export function analyzeCatalogueImportFile(file, restaurantId) {
  const callIndex = ++(globalThis).__mockAnalyzeCallCount;
  (globalThis).__mockAnalyzeCalls.push({ restaurantId, callIndex });
  return new Promise((resolve, reject) => {
    (globalThis).__mockAnalyzeQueue.push({ restaurantId, callIndex, resolve, reject });
  });
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

function resetMocks() {
  (globalThis as any).__mockUser = { id: "operator-1" };
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockEstablishments = DIRECTORY;
  (globalThis as any).__mockReplaceCalls = [];
  (globalThis as any).__mockAnalyzeCalls = [];
  (globalThis as any).__mockAnalyzeQueue = [];
  (globalThis as any).__mockAnalyzeCallCount = 0;
  (globalThis as any).__mockCommitCalls = [];
}

function hasUploadUi(container: HTMLElement): boolean {
  return !!container.querySelector('input[type="file"]');
}

function getSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector("select") as HTMLSelectElement;
  assert.ok(select, "le sélecteur d'établissement doit être présent");
  return select;
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
}

let fileCounter = 0;
async function selectFile(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  assert.ok(fileInput, "le sélecteur de fichier doit être présent");
  fileCounter += 1;
  const file = new window.File(["fake-bytes"], `catalogue-${fileCounter}.xlsx`, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush();
}

/**
 * Le bouton "Analyser" devient "Analyse en cours…" (et `disabled`)
 * pendant qu'une analyse est en vol -- pour exercer volontairement le
 * scénario de chevauchement (items 9–12 du mandat v1.3 : deux clics
 * Analyser qui se chevauchent), ce test doit pouvoir déclencher un
 * second clic pendant que le premier est encore en vol. On retrouve
 * donc le bouton par son PRÉFIXE de texte ("Analys…"), qui matche les
 * deux libellés, plutôt que par égalité stricte sur "Analyser" seul.
 * `dispatchEvent` sur un bouton HTML `disabled` invoque bien le
 * gestionnaire `onClick` React sous jsdom (vérifié empiriquement) --
 * seul le texte affiché change, pas la capacité à recevoir l'event.
 */
function findAnalyserButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Analys")) as
    | HTMLButtonElement
    | undefined;
}

function clickAnalyser(container: HTMLElement) {
  findAnalyserButton(container)!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

/** Resolves the queued analyze() call identified by callIndex with a
 * distinguishable OK result (its fileName embeds callIndex, so the
 * DOM can be inspected to prove exactly which call's content, if
 * any, ended up displayed). */
function resolveAnalyze(callIndex: number) {
  const queue = (globalThis as any).__mockAnalyzeQueue as Array<{ callIndex: number; resolve: (v: any) => void }>;
  const entry = queue.find((e) => e.callIndex === callIndex);
  assert.ok(entry, `aucun appel Analyser en file d'attente avec callIndex=${callIndex}`);
  entry.resolve({
    kind: "OK",
    fileName: `catalogue-call-${callIndex}.xlsx`,
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
          normalizedValues: { name: `Produit-appel-${callIndex}` },
          resolvedCategory: null,
          resolvedSubcategory: null,
          photoFilename: null,
          errors: [],
          warnings: [],
          infos: [],
        },
      ],
    },
  });
}

function displayedCallIndex(container: HTMLElement): number | null {
  const match = /catalogue-call-(\d+)\.xlsx/.exec(container.textContent ?? "");
  return match ? Number(match[1]) : null;
}

// ====================================================================
// Items 1–5 — la réponse obsolète (Au lait cru), résolue APRÈS la
// bascule vers Sanaa, n'est ni affichée ni éligible au commit.
// ====================================================================

test("v1.3 RACE : Preview Au lait cru en vol -> bascule vers Sanaa -> réponse Au lait cru obsolète résolue -> IGNORÉE (jamais affichée, Confirmer reste inactif)", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  clickAnalyser(container);
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 1);
  const auLaitCruCallIndex = (globalThis as any).__mockAnalyzeCalls[0].callIndex;
  assert.equal((globalThis as any).__mockAnalyzeCalls[0].restaurantId, AU_LAIT_CRU.restaurantId);

  // Bascule AVANT toute résolution.
  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();
  assert.equal(getSelect(container).value, SANAA.restaurantId);

  // La réponse Au lait cru, obsolète, arrive maintenant.
  resolveAnalyze(auLaitCruCallIndex);
  await flush(80);

  assert.notEqual(
    displayedCallIndex(container),
    auLaitCruCallIndex,
    "la réponse obsolète (Au lait cru) ne doit JAMAIS être affichée après bascule vers Sanaa"
  );
  assert.equal(
    container.textContent?.includes("ligne(s) analysée(s)"),
    false,
    "aucun résumé de Preview ne doit être affiché tant que Sanaa n'a pas sa propre Analyse"
  );

  const confirmBtn = findButtonByText(container, "Confirmer l’import");
  assert.equal(
    confirmBtn!.hasAttribute("disabled"),
    true,
    "Confirmer doit rester inactif -- la réponse obsolète ne doit jamais restaurer l'éligibilité au commit"
  );
  assert.deepEqual((globalThis as any).__mockCommitCalls, [], "aucun commit ne doit avoir eu lieu");

  root.unmount();
  container.remove();
});

// ====================================================================
// Items 6–8 — après la réponse obsolète ignorée, une NOUVELLE analyse
// pour Sanaa est acceptée normalement, et le Commit cible bien Sanaa.
// ====================================================================

test("v1.3 RACE : après une réponse obsolète ignorée, une nouvelle Analyse pour Sanaa est acceptée et le Commit cible Sanaa", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  clickAnalyser(container);
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 1);
  const staleCallIndex = (globalThis as any).__mockAnalyzeCalls[0].callIndex;

  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();

  // Nouvelle Analyse explicite pour Sanaa (nécessite un fichier de
  // nouveau, puisque le changement d'établissement n'efface pas le
  // fichier lui-même mais invalide déjà le Preview -- le fichier
  // sélectionné reste valide et réutilisable).
  clickAnalyser(container);
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 2);
  const sanaaCallIndex = (globalThis as any).__mockAnalyzeCalls[1].callIndex;
  assert.equal((globalThis as any).__mockAnalyzeCalls[1].restaurantId, SANAA.restaurantId);

  resolveAnalyze(sanaaCallIndex);
  await flush(80);

  assert.equal(displayedCallIndex(container), sanaaCallIndex, "le Preview affiché doit être celui de Sanaa");

  // La réponse Au lait cru, encore plus obsolète, arrive tardivement.
  resolveAnalyze(staleCallIndex);
  await flush(80);
  assert.equal(
    displayedCallIndex(container),
    sanaaCallIndex,
    "la réponse Au lait cru très tardive ne doit toujours pas écraser le Preview Sanaa déjà accepté"
  );

  findButtonByText(container, "Confirmer l’import")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  findButtonByText(container, "Oui, importer maintenant")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockCommitCalls.length > 0);

  assert.deepEqual(
    (globalThis as any).__mockCommitCalls,
    [{ restaurantId: SANAA.restaurantId }],
    "le Commit doit cibler Sanaa, jamais Au lait cru"
  );

  root.unmount();
  container.remove();
});

// ====================================================================
// Items 9–12 — deux clics Analyser qui se chevauchent pour le MÊME
// établissement/fichier : la réponse la plus récente (B) gagne même
// si l'ancienne (A) se résout après.
// ====================================================================

// NOTE méthodologique : le bouton "Analyser" natif porte l'attribut
// HTML `disabled` pendant qu'une analyse est en vol (voir
// `page.tsx`). React applique lui-même une suppression du
// délégué "click" pour les éléments de formulaire `disabled` --
// vérifié empiriquement : un second `dispatchEvent("click")` sur le
// MÊME bouton, alors qu'il est encore `disabled`, n'invoque PAS
// `onClick`/`handleAnalyze` sous jsdom (React ne le laisse pas
// remonter), exactement comme dans un vrai navigateur. Un second
// clic littéral sur le bouton pendant que le premier est en vol n'est
// donc, par construction, JAMAIS possible pour un utilisateur réel --
// c'est déjà une protection supplémentaire au-delà du jeton.
//
// Pour exercer honnêtement le chevauchement mandaté (deux Analyses en
// vol pour le MÊME établissement + MÊME fichier), ce test utilise le
// seul chemin UI qui réactive légitimement le bouton pendant qu'une
// analyse reste en vol : basculer d'établissement (ce qui invalide le
// jeton ET réactive immédiatement le bouton, cf. `handleRestaurantChange`
// v1.3) puis rebasculer sur le MÊME établissement de départ, sans
// changer le fichier. Cela produit deux appels `analyzeCatalogueImportFile`
// réellement en vol simultanément, avec le même `restaurantId` et le
// même objet `File`, exactement le scénario des items 9–12.
test("v1.3 RACE : deux Analyses qui se chevauchent (même établissement/fichier) -- la plus récente (B) gagne, même si l'ancienne (A) se résout après", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  clickAnalyser(container); // Preview A (Au lait cru)
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 1);
  const callA = (globalThis as any).__mockAnalyzeCalls[0].callIndex;
  assert.equal((globalThis as any).__mockAnalyzeCalls[0].restaurantId, AU_LAIT_CRU.restaurantId);

  // Bascule vers Sanaa (invalide le jeton de A, réactive le bouton),
  // puis rebascule vers Au lait cru (même établissement que A, jeton
  // à nouveau invalidé) -- A reste en vol, non résolu, tout du long ;
  // le fichier sélectionné n'est jamais changé.
  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();
  setSelectValue(getSelect(container), AU_LAIT_CRU.restaurantId);
  await flush();

  clickAnalyser(container); // Preview B, même établissement/fichier que A, A toujours en vol
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 2);
  const callB = (globalThis as any).__mockAnalyzeCalls[1].callIndex;
  assert.equal((globalThis as any).__mockAnalyzeCalls[1].restaurantId, AU_LAIT_CRU.restaurantId);
  assert.notEqual(callA, callB);

  // B se résout en premier.
  resolveAnalyze(callB);
  await flush(80);
  assert.equal(displayedCallIndex(container), callB, "B doit être affiché dès sa résolution");

  // A se résout ensuite -- ne doit PAS écraser B.
  resolveAnalyze(callA);
  await flush(80);
  assert.equal(displayedCallIndex(container), callB, "A, résolu après, ne doit jamais écraser B déjà affiché");
  const confirmBtn = findButtonByText(container, "Confirmer l’import");
  assert.equal(confirmBtn!.hasAttribute("disabled"), false, "B est un Preview ELIGIBLE pour l'établissement courant -- Confirmer doit être actif");

  root.unmount();
  container.remove();
});

// ====================================================================
// Items 13–15 — changement de FICHIER pendant un Preview en vol : la
// réponse de l'ancien fichier ne peut pas autoriser un commit pour le
// nouveau fichier.
// ====================================================================

test("v1.3 RACE : changement de fichier pendant un Preview en vol -- la réponse de l'ancien fichier est ignorée", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container); // fichier 1
  clickAnalyser(container);
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 1);
  const oldFileCallIndex = (globalThis as any).__mockAnalyzeCalls[0].callIndex;

  await selectFile(container); // fichier 2, AVANT que l'analyse du fichier 1 ne se résolve

  resolveAnalyze(oldFileCallIndex);
  await flush(80);

  assert.notEqual(
    displayedCallIndex(container),
    oldFileCallIndex,
    "la réponse Preview de l'ANCIEN fichier ne doit jamais s'afficher après un changement de fichier"
  );
  const confirmBtn = findButtonByText(container, "Confirmer l’import");
  assert.equal(
    confirmBtn!.hasAttribute("disabled"),
    true,
    "Confirmer doit rester inactif -- la réponse de l'ancien fichier ne peut pas autoriser un commit pour le nouveau fichier"
  );

  root.unmount();
  container.remove();
});

// ====================================================================
// Item 16 — comportement Preview terminé puis bascule d'établissement
// reste sûr (repris explicitement dans ce fichier, déjà couvert par
// tests/v157-..., ici avec le harnais à réponse différée pour prouver
// que ce n'est pas seulement un artefact d'une résolution
// synchrone/immédiate).
// ====================================================================

test("v1.3 RACE : un Preview COMPLET (déjà résolu) pour Au lait cru est bien invalidé par une bascule ultérieure vers Sanaa", async () => {
  resetMocks();
  window.history.pushState({}, "", `/dashboard/catalogue-import?r=${AU_LAIT_CRU.restaurantId}`);
  const { container, root } = render();
  await waitFor(() => hasUploadUi(container));

  await selectFile(container);
  clickAnalyser(container);
  await waitFor(() => (globalThis as any).__mockAnalyzeCalls.length === 1);
  const callIndex = (globalThis as any).__mockAnalyzeCalls[0].callIndex;
  resolveAnalyze(callIndex);
  await flush(80);
  assert.equal(displayedCallIndex(container), callIndex, "le Preview doit être affiché avant toute bascule");

  setSelectValue(getSelect(container), SANAA.restaurantId);
  await flush();

  assert.equal(displayedCallIndex(container), null, "le Preview précédent doit disparaître après la bascule");
  assert.equal(findButtonByText(container, "Confirmer l’import")!.hasAttribute("disabled"), true);

  root.unmount();
  container.remove();
});
