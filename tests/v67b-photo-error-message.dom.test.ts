import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// V67b — Correctif audit Work : le message "produit créé, photo
// échouée" était effacé immédiatement par le reload() automatique de
// run(), lui-même déclenché juste après que
// tryAttachPhotoAfterCreate() ait posé ce message et fait SON PROPRE
// reload(). Ce fichier RENDER RÉELLEMENT app/dashboard/catalogue/page.tsx
// (le vrai composant, pas une réimplémentation), simule le VRAI
// parcours utilisateur (remplir le formulaire, choisir un fichier,
// cliquer Créer), et vérifie que le message reste affiché dans le DOM
// APRÈS le retour complet de run() — pas seulement qu'un appel
// setError(...) existe quelque part dans le code source.
//
// page.tsx a de nombreuses dépendances (Supabase, next/navigation,
// DashboardNav...) : toutes celles qui parleraient réellement au
// réseau/à Supabase sont remplacées par des modules virtuels via un
// plugin esbuild dédié (onResolve + onLoad, namespace "mock"), la
// logique métier du composant lui-même (run/reload/
// tryAttachPhotoAfterCreate) n'est JAMAIS mockée : c'est précisément
// ce qu'on veut prouver.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/catalogue",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  configurable: true,
});
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).File = window.File;
// jsdom ne fournit pas URL.createObjectURL/revokeObjectURL, et le
// URL global de Node (natif) n'accepte pas les Blob/File de jsdom en
// entrée (TypeError). Limite connue, même nature que le polyfill
// dialog.showModal() de tests/v66-product-info-button.dom.test.ts :
// polyfill minimal, fidèle au contrat utilisé par ProductForm
// (renvoie une chaîne, jamais interprétée comme une vraie URL ici).
(globalThis as any).URL.createObjectURL = () => "blob:mock-preview-url";
(globalThis as any).URL.revokeObjectURL = () => {};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// ---- Contenu des modules mockés (JS pur, chargés via namespace "mock") ----

const MOCK_NAV = `
export function useRouter() {
  return { replace: () => {} };
}
`;

const MOCK_AUTH = `
export async function getUser() {
  return { id: "u1" };
}
`;

// Comportement contrôlé depuis les tests via globalThis.__mocks__ (un
// simple objet en mémoire, réinitialisé à chaque test) -- évite de
// recompiler un bundle par scénario.
const MOCK_DASHBOARD = `
class CategoryDuplicateNameError extends Error {}
class CategoryDescriptionTooLongError extends Error {}
class DescriptionTooLongError extends Error {}
class ShortDescriptionTooLongError extends Error {}

export { CategoryDuplicateNameError, CategoryDescriptionTooLongError, DescriptionTooLongError, ShortDescriptionTooLongError };

export async function getUser2() {}

export async function getMerchantRestaurants() {
  return [{ restaurant_id: "r1", role: "owner", restaurants: { id: "r1", name: "Le Test", slug: "le-test" } }];
}

export async function getMerchantCatalogue() {
  return [{
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    products: [],
  }];
}

export async function getRestaurantSettings() {
  return { currency: "DZD", staff_receipt_language: "fr" };
}

export async function createProduct() {
  return "new-product-id";
}

export async function updateProduct() {}
export async function createCategory() { return "new-category-id"; }
export async function updateCategory() {}
export async function setProductAvailability() {}
export async function setProductOrder() {}
export async function archiveProduct() {}
export async function restoreProduct() {}
`;

const MOCK_PRODUCT_PHOTO = `
export class InvalidFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export class PhotoUploadError extends Error {
  constructor(cause) { super("Photo upload failed"); this.cause = cause; }
}
export class PhotoRemoveError extends Error {
  constructor(cause) { super("Photo remove failed"); this.cause = cause; }
}

export async function validateProductPhotoFile() {
  return { mime: "image/jpeg", ext: "jpg" };
}

export async function addOrReplaceProductPhoto() {
  const behavior = globalThis.__scanymTestPhotoBehavior__ || "fail";
  if (behavior === "fail") {
    throw new PhotoUploadError(new Error("network error (simulated)"));
  }
  return "https://example.supabase.co/storage/v1/object/public/product-photos/r1/new-product-id/x.jpg";
}

export async function removeProductPhoto() {}
`;

const MOCK_DASHBOARD_NAV = `
export default function DashboardNav() { return null; }
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/product-photo": MOCK_PRODUCT_PHOTO,
  "@/components/dashboard/DashboardNav": MOCK_DASHBOARD_NAV,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path in mocks) {
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
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => {
      return { contents: mocks[args.path], loader: "js" };
    });
  },
};

const entrySource = `
export { default as CataloguePage } from "@/app/dashboard/catalogue/page.tsx";
`;

const buildResult = await esbuild.build({
  stdin: {
    contents: entrySource,
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
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "CataloguePage.mjs");
writeFileSync(tmpFile, code);
const { CataloguePage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attend activement qu'une condition devienne vraie, plutôt qu'un
 * délai fixe arbitraire. Nécessaire car ce fichier s'exécute parfois
 * dans le même processus que ~260 autres tests (node --test
 * tests/*.test.ts) : un délai fixe suffisant en isolation peut
 * devenir insuffisant sous charge (CPU partagé, esbuild qui
 * recompile ailleurs) -- corrige un test intermittent constaté
 * précisément dans ce scénario, pas un défaut du composant lui-même.
 */
async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition jamais satisfaite avant le délai");
    }
    await flush(intervalMs);
  }
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function renderAndOpenCreateForm() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CataloguePage));

  // "+ Produit" (mcAddProduct) -- attente active (pas un délai fixe) :
  // le chargement initial enchaîne plusieurs appels asynchrones
  // (getUser -> getMerchantRestaurants -> reload -> getMerchantCatalogue),
  // dont la durée réelle varie selon la charge du process de test.
  await waitFor(() =>
    [...container.querySelectorAll("button")].some(
      (b) => b.textContent?.includes("Produit") && b.textContent.includes("+")
    )
  );

  const addBtn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes("Produit") && b.textContent.includes("+")
  )!;
  addBtn.dispatchEvent(new window.Event("click", { bubbles: true }));

  await waitFor(() =>
    [...container.querySelectorAll("input")].some(
      (i) => i.getAttribute("placeholder") === "Nom du produit"
    )
  );

  const nameInput = [...container.querySelectorAll("input")].find(
    (i) => i.getAttribute("placeholder") === "Nom du produit"
  ) as HTMLInputElement;
  const priceInput = [...container.querySelectorAll("input")].find(
    (i) => i.getAttribute("placeholder") === "Prix"
  ) as HTMLInputElement;
  assert.ok(nameInput && priceInput, "les champs nom/prix doivent être présents dans le formulaire de création");

  setNativeValue(nameInput, "Camembert");
  setNativeValue(priceInput, "8");
  await flush();

  return { container, root };
}

async function selectPhoto(container: HTMLElement) {
  const fileInput = container.querySelector("#new-product-photo") as HTMLInputElement;
  assert.ok(fileInput, "le sélecteur de photo doit être présent dans le formulaire de création");
  const file = new window.File(["fake-bytes"], "photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush();
}

function clickCreate(container: HTMLElement) {
  const buttons = [...container.querySelectorAll("button")];
  const createBtn = buttons.find((b) => b.textContent === "Créer");
  assert.ok(createBtn, "le bouton 'Créer' doit être présent");
  assert.equal(createBtn!.hasAttribute("disabled"), false, "le bouton Créer doit être actif (formulaire valide)");
  createBtn!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

test("BUG CORRIGÉ (audit Work) : création réussie + échec photo -> le message reste affiché APRÈS le retour complet de run()", async () => {
  (globalThis as any).__scanymTestPhotoBehavior__ = "fail";
  const { container, root } = await renderAndOpenCreateForm();
  await selectPhoto(container);
  clickCreate(container);

  // Attente active du message, jusqu'à un délai généreux : couvre
  // createProduct -> tryAttachPhotoAfterCreate (échec, reload,
  // setError) -> retour dans run() (plus de second reload() depuis
  // le correctif). Puis pause supplémentaire : si le bug n'était pas
  // corrigé, le message apparaîtrait BRIÈVEMENT avant d'être effacé
  // par le second reload() -- une attente active seule pourrait
  // capter cet instant fugace par coïncidence, d'où la vérification
  // de PERSISTANCE ci-dessous, pas seulement d'apparition.
  await waitFor(() =>
    container.textContent!.includes("Produit créé. L'ajout de la photo a échoué")
  );
  await flush(200);
  assert.ok(
    container.textContent!.includes("Produit créé. L'ajout de la photo a échoué"),
    "le message traduit doit rester visible dans le DOM après la fin complète de l'action, pas seulement posé puis effacé"
  );

  root.unmount();
  container.remove();
});

test("Régression : création réussie + photo réussie -> aucun message d'échec affiché", async () => {
  (globalThis as any).__scanymTestPhotoBehavior__ = "succeed";
  const { container, root } = await renderAndOpenCreateForm();
  await selectPhoto(container);
  clickCreate(container);
  await waitFor(() => !container.querySelector("#new-product-photo"), 3000).catch(() => {});
  await flush(300);

  assert.ok(
    !container.textContent!.includes("L'ajout de la photo a échoué"),
    "aucun message d'échec ne doit apparaître quand la photo réussit"
  );

  root.unmount();
  container.remove();
});

test("Régression : création sans photo -> aucun message d'échec affiché", async () => {
  const { container, root } = await renderAndOpenCreateForm();
  // Pas de selectPhoto() ici : création sans photo, cas facultatif.
  clickCreate(container);
  await flush(300);

  assert.ok(
    !container.textContent!.includes("L'ajout de la photo a échoué"),
    "aucun message d'échec photo ne doit apparaître quand aucune photo n'a été choisie"
  );

  root.unmount();
  container.remove();
});
