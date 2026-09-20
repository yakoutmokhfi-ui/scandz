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
// Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
// RESET v1 — page opérateur (app/admin/establishments/catalogue-reset/
// page.tsx). Rendu RÉEL en DOM (jsdom), même patron/mécanisme que
// tests/ob1-operator-cockpit.dom.test.ts (esbuild + mocks de modules,
// JAMAIS la logique réelle de la page).
//
// Preuve comportementale que :
//   - un compte non-opérateur est redirigé AVANT tout aperçu/état
//     (item D) ;
//   - "Aperçu" appelle previewCatalogueReset et affiche les compteurs
//     exacts, sans jamais appeler resetMerchantCatalogue (item B,
//     preview = zéro mutation) ;
//   - le bouton de confirmation reste DÉSACTIVÉ tant que la phrase
//     saisie ne correspond pas exactement au marchand affiché (item C) ;
//   - une fois la phrase exacte saisie, la confirmation appelle
//     resetMerchantCatalogue EXACTEMENT une fois avec le restaurantId
//     courant (isolation tenant) et affiche le résultat détaillé ;
//   - changer de marchand (remontage avec un ?r= différent) ne fait
//     jamais fuiter un aperçu/résultat de l'établissement précédent.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/admin/establishments/catalogue-reset?r=r1",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).HTMLInputElement = window.HTMLInputElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

const MERCHANTS: Record<string, { name: string }> = {
  r1: { name: "Au Lait Cru" },
  r2: { name: "Hotel Royal" },
};

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockGetSummary = async (id: string) => {
  const m = MERCHANTS[id];
  if (!m) throw new Error("not found");
  return { restaurantId: id, name: m.name, slug: id, status: "active", ownerEmail: null, ownerStatus: null };
};
(globalThis as any).__mockReplaceCalls = [] as string[];
(globalThis as any).__mockPreviewCalls = [] as string[];
(globalThis as any).__mockResetCalls = [] as Array<{ id: string; phrase: string }>;
(globalThis as any).__mockPreviewResponder = async (id: string) => ({
  restaurantId: id,
  activeProductsCount: 12,
  archivedProductsCount: 3,
  subcategoriesTotal: 2,
  subcategoriesRemovable: 1,
  subcategoriesRetained: 1,
  categoriesTotal: 7,
  categoriesRemovable: 5,
  categoriesRetained: 2,
  productsWithOrderHistory: 4,
  categoriesActiveAfterReset: 0,
  subcategoriesActiveAfterReset: 0,
});
(globalThis as any).__mockResetResponder = async (id: string, _phrase: string) => ({
  restaurantId: id,
  productsArchived: 12,
  subcategoriesRemoved: 1,
  subcategoriesRetained: 1,
  categoriesRemoved: 5,
  categoriesRetained: 2,
  categoriesActiveAfterReset: 0,
  subcategoriesActiveAfterReset: 0,
  historicalOrdersPreserved: true as const,
  result: "completed" as const,
});

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
export async function getEstablishmentSummary(id) { return (globalThis).__mockGetSummary(id); }
`;

const MOCK_CATALOGUE_RESET = `
class CatalogueResetConfirmationMismatchError extends Error {
  constructor() {
    super("mock mismatch");
    this.name = "CatalogueResetConfirmationMismatchError";
  }
}
(globalThis).__CatalogueResetConfirmationMismatchError = CatalogueResetConfirmationMismatchError;
export { CatalogueResetConfirmationMismatchError };
export async function previewCatalogueReset(id) {
  (globalThis).__mockPreviewCalls.push(id);
  return (globalThis).__mockPreviewResponder(id);
}
export async function resetMerchantCatalogue(id, phrase) {
  (globalThis).__mockResetCalls.push({ id, phrase });
  return (globalThis).__mockResetResponder(id, phrase);
}
export function buildCatalogueResetConfirmationPhrase(name) {
  return "RESET " + name.trim();
}
export function isCatalogueResetConfirmationPhraseValid(typed, name) {
  return typed.trim() === "RESET " + name.trim();
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/catalogue-reset": MOCK_CATALOGUE_RESET,
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
export { default as CatalogueResetPage } from "@/app/admin/establishments/catalogue-reset/page.tsx";
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
const tmpFile = path.join(tmpDir, "CatalogueResetPage.mjs");
writeFileSync(tmpFile, code);
const { CatalogueResetPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CatalogueResetPage));
  return { container, root };
}

function flush(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await flush(10);
  }
  throw new Error(message);
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function resetGlobalCallLogs() {
  (globalThis as any).__mockReplaceCalls = [];
  (globalThis as any).__mockPreviewCalls = [];
  (globalThis as any).__mockResetCalls = [];
}

test("[D] non-opérateur : redirigé vers /dashboard AVANT tout aperçu/état, aucun appel preview/reset jamais émis", async () => {
  (globalThis as any).__mockIsOperator = false;
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");

  const { container, root } = render();
  await waitFor(
    () => (globalThis as any).__mockReplaceCalls.includes("/dashboard"),
    "redirection opérateur attendue vers /dashboard"
  );

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard"]);
  assert.deepEqual((globalThis as any).__mockPreviewCalls, []);
  assert.deepEqual((globalThis as any).__mockResetCalls, []);

  root.unmount();
  container.remove();
  (globalThis as any).__mockIsOperator = true;
});

test("aperçu : affiche le marchand résolu depuis ?r=, aucun appel preview/reset automatique au montage", async () => {
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");
  const { container, root } = render();
  await waitFor(() => !!container.textContent?.includes("Au Lait Cru"), "marchand Au Lait Cru non rendu");

  assert.ok(container.textContent?.includes("Au Lait Cru"));
  assert.deepEqual((globalThis as any).__mockPreviewCalls, []);
  assert.deepEqual((globalThis as any).__mockResetCalls, []);

  root.unmount();
  container.remove();
});

test("[A/B] clic sur 'Aperçu' appelle previewCatalogueReset UNE fois avec le restaurantId courant, affiche les compteurs exacts, AUCUN appel reset", async () => {
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");
  const { container, root } = render();
  await waitFor(() => !!container.textContent?.includes("Au Lait Cru"), "marchand Au Lait Cru non rendu");

  const previewButton = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Aperçu de la réinitialisation")
  );
  assert.ok(previewButton, "bouton Aperçu introuvable");
  click(previewButton!);
  await waitFor(
    () => (globalThis as any).__mockPreviewCalls.length === 1 && !!container.textContent?.includes("12 produit"),
    "aperçu catalogue non rendu"
  );

  assert.deepEqual((globalThis as any).__mockPreviewCalls, ["r1"]);
  assert.deepEqual((globalThis as any).__mockResetCalls, []);
  assert.ok(container.textContent?.includes("12 produit"));
  assert.ok(container.textContent?.includes("5 catégorie"));

  root.unmount();
  container.remove();
});

test("[C] bouton de confirmation reste DÉSACTIVÉ tant que la phrase saisie ne correspond pas exactement, activé seulement après la phrase EXACTE", async () => {
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");
  const { container, root } = render();
  await waitFor(() => !!container.textContent?.includes("Au Lait Cru"), "marchand Au Lait Cru non rendu");

  const previewButton = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Aperçu de la réinitialisation")
  )!;
  click(previewButton);
  await waitFor(
    () =>
      (globalThis as any).__mockPreviewCalls.length === 1 &&
      !!container.querySelector("input[type='text']") &&
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Réinitialiser le catalogue")
      ),
    "aperçu et contrôles de confirmation non rendus"
  );

  const confirmButton = () =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Réinitialiser le catalogue"));
  assert.ok(confirmButton(), "bouton de confirmation introuvable après aperçu");
  assert.equal((confirmButton() as HTMLButtonElement).disabled, true, "doit être désactivé sans saisie");

  const input = container.querySelector("input[type='text']") as HTMLInputElement;
  assert.ok(input, "champ de confirmation introuvable");

  setNativeValue(input, "reset au lait cru");
  await waitFor(
    () => !!confirmButton() && (confirmButton() as HTMLButtonElement).disabled === true,
    "bouton non désactivé après casse différente"
  );
  assert.equal((confirmButton() as HTMLButtonElement).disabled, true, "doit rester désactivé sur une casse différente");

  setNativeValue(input, "RESET Au Lait");
  await waitFor(
    () => !!confirmButton() && (confirmButton() as HTMLButtonElement).disabled === true,
    "bouton non désactivé après phrase partielle"
  );
  assert.equal((confirmButton() as HTMLButtonElement).disabled, true, "doit rester désactivé sur une phrase partielle");

  setNativeValue(input, "RESET AU LAIT CRU");
  await waitFor(
    () => !!confirmButton() && (confirmButton() as HTMLButtonElement).disabled === true,
    "bouton non désactivé pour ancienne phrase uppercase"
  );
  assert.equal(
    (confirmButton() as HTMLButtonElement).disabled,
    true,
    "v1.1 : l'ancienne phrase TOUT-MAJUSCULES ne doit plus activer le bouton -- la casse du marchand est désormais préservée"
  );

  setNativeValue(input, "RESET Au Lait Cru");
  await waitFor(
    () => !!confirmButton() && (confirmButton() as HTMLButtonElement).disabled === false,
    "bouton non activé pour phrase exacte"
  );
  assert.equal((confirmButton() as HTMLButtonElement).disabled, false, "doit être activé sur la phrase exacte (v1.1 : casse du marchand préservée)");

  // Aucun appel reset n'a encore eu lieu -- seule la SAISIE de la
  // phrase ne doit jamais déclencher de mutation.
  assert.deepEqual((globalThis as any).__mockResetCalls, []);

  root.unmount();
  container.remove();
});

test("[E/G] confirmation avec la phrase exacte appelle resetMerchantCatalogue EXACTEMENT une fois avec le restaurantId courant, affiche le résultat détaillé", async () => {
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");
  const { container, root } = render();
  await waitFor(() => !!container.textContent?.includes("Au Lait Cru"), "marchand Au Lait Cru non rendu");

  const previewButton = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Aperçu de la réinitialisation")
  );
  assert.ok(previewButton, "bouton Aperçu introuvable");
  click(previewButton!);
  await waitFor(
    () =>
      (globalThis as any).__mockPreviewCalls.length === 1 &&
      !!container.querySelector("input[type='text']"),
    "aperçu et champ de confirmation non rendus"
  );

  const input = container.querySelector("input[type='text']") as HTMLInputElement | null;
  assert.ok(input, "champ de confirmation introuvable");
  setNativeValue(input, "RESET Au Lait Cru");
  await waitFor(
    () => {
      const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Réinitialiser le catalogue")) as HTMLButtonElement | undefined;
      return !!button && button.disabled === false;
    },
    "bouton de confirmation non activé"
  );

  const confirmButton = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Réinitialiser le catalogue")
  )!;
  click(confirmButton);
  await waitFor(
    () => (globalThis as any).__mockResetCalls.length === 1 && !!container.textContent?.includes("Produits archivés"),
    "résultat de réinitialisation non rendu"
  );

  assert.deepEqual((globalThis as any).__mockResetCalls, [{ id: "r1", phrase: "RESET Au Lait Cru" }]);
  assert.ok(container.textContent?.includes("Produits archivés"));
  assert.ok(container.textContent?.includes("12"));
  assert.ok(container.textContent?.includes("Historique des commandes préservé"));

  root.unmount();
  container.remove();
});

test("[v1.1] le serveur rejette la confirmation (CatalogueResetConfirmationMismatchError) -- message d'erreur dédié affiché, JAMAIS un résultat de succès, aucun état de succès affiché", async () => {
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");
  const { container, root } = render();
  await waitFor(() => !!container.textContent?.includes("Au Lait Cru"), "marchand Au Lait Cru non rendu");

  const previewButton = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Aperçu de la réinitialisation")
  );
  assert.ok(previewButton, "bouton Aperçu introuvable");
  click(previewButton!);
  await waitFor(
    () =>
      (globalThis as any).__mockPreviewCalls.length === 1 &&
      !!container.querySelector("input[type='text']"),
    "aperçu et champ de confirmation non rendus"
  );

  const input = container.querySelector("input[type='text']") as HTMLInputElement | null;
  assert.ok(input, "champ de confirmation introuvable");
  setNativeValue(input, "RESET Au Lait Cru");
  await waitFor(
    () => {
      const button = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Réinitialiser le catalogue")
      ) as HTMLButtonElement | undefined;
      return !!button && button.disabled === false;
    },
    "bouton de confirmation non activé"
  );

  const originalResponder = (globalThis as any).__mockResetResponder;
  (globalThis as any).__mockResetResponder = async () => {
    const MismatchError = (globalThis as any).__CatalogueResetConfirmationMismatchError;
    throw new MismatchError();
  };

  const confirmButton = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Réinitialiser le catalogue")
  )!;
  click(confirmButton);
  await waitFor(
    () => (globalThis as any).__mockResetCalls.length === 1 && !!container.textContent?.includes("Le serveur a refusé la phrase de confirmation"),
    "message de rejet serveur non rendu"
  );

  assert.equal((globalThis as any).__mockResetCalls.length, 1, "un seul appel resetMerchantCatalogue, jamais de retry silencieux");
  assert.ok(!container.textContent?.includes("Réinitialisation terminée"), "aucun état de succès ne doit jamais s'afficher");
  assert.ok(
    container.textContent?.includes("Le serveur a refusé la phrase de confirmation"),
    "le message d'erreur dédié à un rejet serveur doit être affiché"
  );

  (globalThis as any).__mockResetResponder = originalResponder;
  root.unmount();
  container.remove();
});

test("[F] changer de marchand (remontage avec ?r= différent) n'affiche jamais un aperçu/résultat de l'établissement précédent", async () => {
  resetGlobalCallLogs();
  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r1");
  const { container: c1, root: r1 } = render();
  await waitFor(() => !!c1.textContent?.includes("Au Lait Cru"), "marchand r1 non rendu");
  const previewButton = Array.from(c1.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Aperçu de la réinitialisation")
  );
  assert.ok(previewButton, "bouton Aperçu introuvable pour r1");
  click(previewButton!);
  await waitFor(
    () => (globalThis as any).__mockPreviewCalls.length === 1 && !!c1.textContent?.includes("12 produit"),
    "aperçu r1 non rendu"
  );
  assert.ok(c1.textContent?.includes("Au Lait Cru"));
  r1.unmount();
  c1.remove();

  window.history.pushState({}, "", "/admin/establishments/catalogue-reset?r=r2");
  const { container: c2, root: r2b } = render();
  await waitFor(() => !!c2.textContent?.includes("Hotel Royal"), "marchand r2 non rendu");

  assert.ok(c2.textContent?.includes("Hotel Royal"));
  assert.ok(!c2.textContent?.includes("Au Lait Cru"));
  // Aucun compteur/résultat de r1 ne doit apparaître avant un nouvel
  // aperçu explicite pour r2 (état entièrement réinitialisé au
  // changement d'établissement).
  assert.ok(!c2.textContent?.includes("12 produit"));

  r2b.unmount();
  c2.remove();
});
