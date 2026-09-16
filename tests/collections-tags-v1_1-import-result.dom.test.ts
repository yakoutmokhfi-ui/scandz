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
// Scanym — COLLECTIONS / TAGS FOUNDATION v1.1 — REMÉDIATION CIBLÉE.
//
// CONSTAT B (Cat Stevens 2) : `tagAssociationFailures` est compté par
// le service mais pourrait n'être JAMAIS affiché dans l'écran de
// résultat d'import. Conséquence potentielle : le marchand/opérateur
// voit un résultat apparemment pleinement réussi alors que des
// associations produit-tag ont réellement échoué.
//
// Rendu RÉEL de app/dashboard/catalogue-import/page.tsx (esbuild +
// jsdom), même patron que
// tests/v158-admin-catalogue-import-preview-race-v1-3.dom.test.ts.
// Le service de commit est mocké UNIQUEMENT pour choisir le résultat
// retourné : l'écran testé est bien le vrai.
//
// Ces tests ont d'abord été exécutés contre l'écran v1 NON MODIFIÉ
// pour REPRODUIRE le défaut avant toute correction.
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

const AU_LAIT_CRU = {
  restaurantId: "aulaitcru-id",
  name: "Au lait cru",
  slug: "au-lait-cru",
  country: "FR",
  status: "active",
};

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockEstablishments = [AU_LAIT_CRU];
(globalThis as any).__mockCommitResult = null;

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
`;
const MOCK_AUTH = `export async function getUser() { return (globalThis).__mockUser; }`;
const MOCK_ESTABLISHMENTS = `export async function isScanymOperator() { return (globalThis).__mockIsOperator; }`;
const MOCK_OPERATOR_DIRECTORY = `
export async function listOperatorEstablishments() { return (globalThis).__mockEstablishments ?? []; }
`;

// Preview minimal ÉLIGIBLE : une ligne PRODUIT sans blocage, pour
// pouvoir atteindre le bouton de confirmation.
const MOCK_CATALOGUE_IMPORT = `
export async function analyzeCatalogueImportFile(file, restaurantId) {
  return {
    kind: "OK",
    fileName: "catalogue.xlsx",
    sourceFormat: "xlsx",
    report: {
      rows: [{
        row: 2,
        status: "OK",
        errors: [], warnings: [], infos: [],
        resolvedCategory: { state: "EXISTING", displayName: "Pizzas", existingId: "cat-1" },
        resolvedSubcategory: null,
        normalizedValues: {
          name: "Pizza Margherita", shortDescription: null, description: null,
          price: 9.9, taxRate: null, unitWeightGrams: null, weightIsApproximate: false,
          tags: ["Bio"], type: { kind: "PRODUCT" },
          categoryNameRaw: "Pizzas", subcategoryNameRaw: "", photoFilename: null,
        },
        photoFilename: null,
        productMatch: { state: "EXISTING_MATCH", existingId: "prod-1" },
        resolvedTags: [{ state: "WOULD_CREATE", displayName: "Bio" }],
        rowType: "PRODUCT",
        plannedAction: "SKIP",
      }],
      eligibility: "ELIGIBLE",
      totalRows: 1, blockedRows: 0, warningRows: 0, okRows: 1,
      columnMapWarnings: [],
    },
  };
}
`;

const MOCK_CATALOGUE_IMPORT_COMMIT = `
export async function commitCatalogueImport(file, restaurantId) {
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

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as CatalogueImportPage } from "@/app/dashboard/catalogue-import/page.tsx";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "CatalogueImportPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
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

async function waitFor(check: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function findButtonByPrefix(container: HTMLElement, prefix: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(prefix)
  ) as HTMLButtonElement | undefined;
}

let fileCounter = 0;

/** Parcourt le flux réel jusqu'à l'affichage du résultat de commit :
 *  sélection d'établissement -> fichier -> Analyser -> Confirmer. */
async function runImportToResult(commitResult: unknown): Promise<HTMLElement> {
  (globalThis as any).__mockCommitResult = commitResult;
  const { container } = render();
  await waitFor(() => !!container.querySelector("select"));

  const select = container.querySelector("select") as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, AU_LAIT_CRU.restaurantId);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush();

  await waitFor(() => !!container.querySelector('input[type="file"]'));
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fileCounter += 1;
  const file = new window.File(["x"], `catalogue-${fileCounter}.xlsx`, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush();

  findButtonByPrefix(container, "Analys")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  // Le bouton « Confirmer l'import » EXISTE dès le départ (désactivé) :
  // attendre sa simple présence cliquerait pendant l'analyse. On attend
  // donc qu'il devienne réellement ACTIF, c'est-à-dire que l'analyse
  // soit terminée pour l'établissement sélectionné.
  await waitFor(() => {
    const b = findButtonByPrefix(container, "Confirmer l");
    return !!b && !b.disabled;
  });

  // La confirmation est en DEUX temps : « Confirmer l'import » ouvre
  // la demande de confirmation, « Oui, importer maintenant » déclenche
  // réellement le commit. Le harnais parcourt les deux, comme un
  // opérateur réel.
  findButtonByPrefix(container, "Confirmer l")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => !!findButtonByPrefix(container, "Oui, importer"));
  findButtonByPrefix(container, "Oui, importer")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (container.textContent ?? "").includes("Import terminé"));
  return container;
}

function baseCommitResult(over: Record<string, unknown> = {}) {
  return {
    kind: "COMMITTED",
    fileName: "catalogue.xlsx",
    categoriesCreated: 0,
    subcategoriesCreated: 0,
    categoriesFailed: 0,
    subcategoriesFailed: 0,
    productsCreated: 2,
    productsUpdated: 0,
    productsSkipped: 1,
    productsFailed: 0,
    tagsAssociated: 0,
    tagAssociationFailures: 0,
    rows: [],
    ...over,
  };
}

// ------------------------------------------------------------------
// B1 — aucun échec d'association : présentation de succès normale
// ------------------------------------------------------------------
test("[B1] tagAssociationFailures = 0 -> présentation de succès normale, AUCUN avertissement d'association parasite", async () => {
  const container = await runImportToResult(baseCommitResult({ tagsAssociated: 3 }));
  const text = container.textContent ?? "";

  assert.ok(text.includes("Import terminé"), "le résultat doit s'afficher");
  assert.ok(text.includes("2 produit(s) créé(s)"), "les produits commités restent correctement rapportés");
  assert.equal(
    /association.{0,40}échou/i.test(text),
    false,
    "aucun message d'échec d'association ne doit apparaître quand il n'y en a aucun"
  );
});

// ------------------------------------------------------------------
// B2 — échecs d'association : information EXPLICITE et visible
// ------------------------------------------------------------------
test("[B2] tagAssociationFailures > 0 -> l'échec d'association est EXPLICITEMENT visible, avec son décompte", async () => {
  const container = await runImportToResult(
    baseCommitResult({ tagsAssociated: 1, tagAssociationFailures: 2 })
  );
  const text = container.textContent ?? "";

  // Le décompte doit être visible.
  assert.ok(
    /2\s*produit\(s\)[^.]{0,80}association/i.test(text) || /association[^.]{0,80}\b2\b/i.test(text),
    `le nombre d'échecs d'association doit être visible. Texte obtenu : ${text.slice(0, 600)}`
  );
  // Le libellé doit parler d'association de tags/collections, pas d'un
  // échec de ligne produit.
  assert.ok(
    /tag|collection/i.test(text),
    "le libellé doit nommer les tags/collections"
  );
  assert.ok(
    /échou|échec/i.test(text),
    "le libellé doit indiquer un échec"
  );
});

// ------------------------------------------------------------------
// B3 — produits OK + échecs d'association : ni faux succès total,
//      ni import produit faussement classé en échec
// ------------------------------------------------------------------
test("[B3] produits commités avec succès + échecs d'association -> ni faux succès complet, ni import produit faussement présenté comme échoué, ni rollback annoncé à tort", async () => {
  const container = await runImportToResult(
    baseCommitResult({ productsCreated: 5, productsFailed: 0, tagAssociationFailures: 1 })
  );
  const text = container.textContent ?? "";

  // Les produits réussis restent correctement rapportés.
  assert.ok(text.includes("5 produit(s) créé(s)"), "les produits réellement écrits doivent rester rapportés");

  // Aucune ligne produit n'est en échec : l'écran ne doit PAS prétendre
  // le contraire.
  assert.equal(
    /ligne\(s\) en échec/.test(text),
    false,
    "aucune ligne produit n'a échoué : l'écran ne doit pas afficher de lignes en échec"
  );

  // Mais il ne doit pas non plus présenter un succès pleinement propre.
  assert.ok(
    /tag|collection/i.test(text) && /échou|échec/i.test(text),
    "l'échec d'association doit être signalé malgré des produits tous réussis"
  );

  // Et surtout, ne jamais annoncer une annulation qui n'a pas eu lieu.
  assert.equal(
    /annul|rollback|revert/i.test(text),
    false,
    "aucun rollback des produits n'a eu lieu : ne jamais l'annoncer"
  );
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).File;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
