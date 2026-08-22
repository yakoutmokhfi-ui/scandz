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
// Test comportemental React réel (LOT 1B.1, finding L1B-02) : rendu
// RÉEL de DashboardNav dans un DOM (jsdom), pas une lecture du
// fichier source -- vérifie qu'une entrée "Langues & traductions"
// existe réellement, qu'elle est marquée active sur
// /dashboard/translations, et que "Commandes" ne l'est JAMAIS sur
// cette route (bug reproduit avant correction : le repli générique
// !onCatalogue && !onSettings marquait Commandes actif par défaut).
//
// next/navigation est mocké (usePathname contrôlable par test, même
// technique que tests/v67b-photo-error-message.dom.test.ts) ; la
// logique réelle de DashboardNav (calcul des onglets actifs, liens)
// n'est JAMAIS mockée.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/translations",
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
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// Contrôlable par test : chaque scénario fixe le pathname simulé
// avant de (re)construire le bundle -- le mock lit une variable
// globale plutôt qu'une valeur figée à la compilation.
(globalThis as any).__mockPathname = "/dashboard/translations";

const MOCK_NAV = `
export function usePathname() {
  return (globalThis as any).__mockPathname;
}
export function useRouter() {
  return { replace: () => {}, push: () => {} };
}
`;

const MOCK_AUTH = `
export async function signOut() {}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
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
export { default as DashboardNav } from "@/components/dashboard/DashboardNav";
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
const tmpFile = path.join(tmpDir, "DashboardNav.mjs");
writeFileSync(tmpFile, code);
const { DashboardNav } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function render(pathname: string) {
  (globalThis as any).__mockPathname = pathname;
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(DashboardNav, {
      restaurantName: "Test Resto",
      restaurantId: "r1",
      mappings: [],
      onSelectRestaurant: () => {},
    })
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("DashboardNav (DOM réel, L1B-02) : une entrée « Langues & traductions » existe et pointe vers /dashboard/translations?r=<restaurant_id>", async () => {
  const { container, root } = render("/dashboard/translations");
  await flush();

  const links = Array.from(container.querySelectorAll("nav a")) as HTMLAnchorElement[];
  const translationsLink = links.find((a) => a.getAttribute("href")?.includes("/dashboard/translations"));
  assert.ok(translationsLink, "un lien vers /dashboard/translations doit exister dans la nav");
  assert.ok(
    translationsLink!.getAttribute("href")?.includes("r=r1"),
    "l'établissement sélectionné doit être conservé dans le lien (?r=r1)"
  );

  root.unmount();
  container.remove();
});

test("DashboardNav (DOM réel, L1B-02) : sur /dashboard/translations, l'onglet « Langues & traductions » est actif ET « Commandes » ne l'est JAMAIS (bug reproduit avant correction : repli générique marquait Commandes actif par défaut)", async () => {
  const { container, root } = render("/dashboard/translations");
  await flush();

  const links = Array.from(container.querySelectorAll("nav a")) as HTMLAnchorElement[];
  const ordersLink = links.find((a) => a.getAttribute("href")?.startsWith("/dashboard?"));
  const translationsLink = links.find((a) => a.getAttribute("href")?.includes("/dashboard/translations"));

  assert.ok(ordersLink && translationsLink, "les deux liens doivent exister");

  const ACTIVE_CLASS = "bg-stone-900";
  assert.ok(
    !ordersLink!.className.includes(ACTIVE_CLASS),
    "« Commandes » ne doit JAMAIS être actif sur /dashboard/translations"
  );
  assert.ok(
    translationsLink!.className.includes(ACTIVE_CLASS),
    "« Langues & traductions » doit être actif sur cette route"
  );

  root.unmount();
  container.remove();
});

test("DashboardNav (DOM réel, L1B-02) : sur /dashboard (Commandes), c'est bien Commandes qui est actif, Langues & traductions ne l'est pas (non-régression)", async () => {
  const { container, root } = render("/dashboard");
  await flush();

  const links = Array.from(container.querySelectorAll("nav a")) as HTMLAnchorElement[];
  const ordersLink = links.find((a) => a.getAttribute("href")?.startsWith("/dashboard?"));
  const translationsLink = links.find((a) => a.getAttribute("href")?.includes("/dashboard/translations"));

  const ACTIVE_CLASS = "bg-stone-900";
  assert.ok(ordersLink!.className.includes(ACTIVE_CLASS));
  assert.ok(!translationsLink!.className.includes(ACTIVE_CLASS));

  root.unmount();
  container.remove();
});

after(async () => {
  // Corrige un ordre de nettoyage trop hâtif (leçon L1A1-01) : laisse
  // un court délai pour que toute activité asynchrone interne de
  // React (post-unmount) se termine AVANT de supprimer window/document
  // -- sinon une telle activité résiduelle accédant à `window` après
  // sa suppression déclenche une exception non gérée.
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
  delete (globalThis as any).__mockPathname;
});
