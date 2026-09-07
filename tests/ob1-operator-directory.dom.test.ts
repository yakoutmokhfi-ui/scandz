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
// OB-1 — OPERATOR MERCHANT DIRECTORY (app/admin/establishments/page.tsx).
// Rendu RÉEL en DOM (jsdom), pas une lecture du fichier source : preuve
// comportementale que (1) un opérateur Scanym accède au répertoire,
// (2) un utilisateur authentifié NON opérateur en est redirigé plutôt
// que d'en voir le contenu, (3) la recherche filtre réellement les
// lignes affichées. next/navigation et les services Supabase sont
// mockés (même technique que tests/v81-lot1b1-dashboardnav.dom.test.ts) ;
// la logique réelle de la page (garde d'autorisation, filtrage,
// rendu du tableau) n'est JAMAIS mockée.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/admin/establishments",
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

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockDirectoryList = [
  { restaurantId: "r1", name: "Au Lait Cru", slug: "au-lait-cru", country: "FR", status: "active" },
  { restaurantId: "r2", name: "Sanaa Cookies", slug: "sanaa-cookies", country: "DZ", status: "onboarding" },
];
(globalThis as any).__mockDirectoryError = null;
(globalThis as any).__mockReplaceCalls = [] as string[];

const MOCK_NAV = `
// Objet routeur STABLE (identité inchangée entre rendus), comme le
// vrai useRouter() de Next.js -- un objet neuf à chaque appel ferait
// reboucler indéfiniment l'effet d'autorisation de la page (dépendance
// [router]), ce qu'aucun routeur réel ne fait jamais.
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

const MOCK_DIRECTORY_SERVICE = `
export async function listOperatorEstablishments() {
  if ((globalThis).__mockDirectoryError) throw new Error((globalThis).__mockDirectoryError);
  return (globalThis).__mockDirectoryList;
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/operator-directory": MOCK_DIRECTORY_SERVICE,
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
export { default as DirectoryPage } from "@/app/admin/establishments/page.tsx";
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
const tmpFile = path.join(tmpDir, "DirectoryPage.mjs");
writeFileSync(tmpFile, code);
const { DirectoryPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(DirectoryPage));
  return { container, root };
}

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("OB-1 répertoire : un opérateur Scanym authentifié voit le répertoire (les deux établissements de test s'affichent, jamais redirigé)", async () => {
  (globalThis as any).__mockUser = { id: "operator-1" };
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(60);

  assert.ok(container.textContent?.includes("Au Lait Cru"));
  assert.ok(container.textContent?.includes("Sanaa Cookies"));
  assert.deepEqual((globalThis as any).__mockReplaceCalls, []);

  root.unmount();
  container.remove();
});

test("OB-1 répertoire : un utilisateur authentifié NON opérateur est redirigé vers /dashboard et ne voit JAMAIS le contenu du répertoire", async () => {
  (globalThis as any).__mockUser = { id: "merchant-1" };
  (globalThis as any).__mockIsOperator = false;
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(60);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard"]);
  assert.ok(!container.textContent?.includes("Au Lait Cru"), "aucune donnée du répertoire ne doit fuiter");
  assert.ok(!container.textContent?.includes("Sanaa Cookies"));

  root.unmount();
  container.remove();
});

test("OB-1 répertoire : un utilisateur non authentifié est redirigé vers /dashboard/login", async () => {
  (globalThis as any).__mockUser = null;
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(60);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard/login"]);

  root.unmount();
  container.remove();
});

test("OB-1 répertoire : la recherche filtre réellement les lignes affichées (comportement réel, pas un texte statique)", async () => {
  (globalThis as any).__mockUser = { id: "operator-1" };
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(60);

  const input = container.querySelector("input") as HTMLInputElement;
  assert.ok(input, "un champ de recherche doit exister");

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, "sanaa");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await flush(60);

  assert.ok(container.textContent?.includes("Sanaa Cookies"));
  assert.ok(!container.textContent?.includes("Au Lait Cru"), "Au Lait Cru doit être filtré hors de la vue");

  root.unmount();
  container.remove();
});

test("OB-1 répertoire : aucun bouton de mutation n'est introduit -- uniquement des liens de navigation (<a>)", async () => {
  (globalThis as any).__mockUser = { id: "operator-1" };
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(60);

  assert.equal(container.querySelectorAll("button").length, 0);

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
  delete (globalThis as any).__mockUser;
  delete (globalThis as any).__mockIsOperator;
  delete (globalThis as any).__mockDirectoryList;
  delete (globalThis as any).__mockDirectoryError;
  delete (globalThis as any).__mockReplaceCalls;
});
