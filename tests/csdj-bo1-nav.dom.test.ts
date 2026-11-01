import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { settle } from "./helpers/dom-settle.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CSDJ-BO-1 — ONGLET DE NAVIGATION : MATRICE COMPLÈTE DE L'ÉTAT ACTIF.
//
// Le défaut L1B-02 (contre-audit LOT 1B.1) s'est produit parce que
// l'onglet « Commandes » n'a pas de route propre : il est un repli
// générique « aucun autre onglet n'est actif ». Chaque onglet ajouté
// depuis doit donc être retiré de ce repli, et c'est exactement ce qui
// est oublié un jour sur deux.
//
// Ce fichier ne teste pas « la nouvelle route fonctionne » : il teste
// toutes les routes, une par une, et vérifie pour chacune qu'un seul
// onglet est actif. C'est la seule forme qui attrape la régression
// dans l'autre sens -- un onglet ancien qui redeviendrait actif sur la
// nouvelle route, ou l'inverse.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/availability",
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
(globalThis as any).__mockPathname = "/dashboard/availability";

const mocks: Record<string, string> = {
  "next/navigation": `
const ROUTER = { replace: () => {}, push: () => {} };
export function usePathname() { return (globalThis).__mockPathname; }
export function useRouter() { return ROUTER; }
`,
  "@/lib/services/auth": `export async function signOut() {}`,
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
    contents: `export { default as DashboardNav } from "@/components/dashboard/DashboardNav";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bo1-nav-"));
const tmpFile = path.join(tmpDir, "DashboardNav.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { DashboardNav } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const ACTIVE_CLASS = "bg-stone-900";

/** Les routes, et l'onglet qui doit être actif sur chacune. */
const ROUTES: Array<[route: string, activeHref: string]> = [
  ["/dashboard", "/dashboard?"],
  ["/dashboard/catalogue", "/dashboard/catalogue"],
  ["/dashboard/settings", "/dashboard/settings"],
  ["/dashboard/delivery-pricing", "/dashboard/delivery-pricing"],
  ["/dashboard/availability", "/dashboard/availability"],
  ["/dashboard/payment", "/dashboard/payment"],
  ["/dashboard/legal-cgv", "/dashboard/legal-cgv"],
  ["/dashboard/translations", "/dashboard/translations"],
  ["/dashboard/email", "/dashboard/email"],
];

function render(pathname: string) {
  (globalThis as any).__mockPathname = pathname;
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(DashboardNav, {
      restaurantName: "Au lait cru",
      restaurantId: "r1",
      mappings: [],
      onSelectRestaurant: () => {},
    })
  );
  return { container, root };
}

/** Attente de QUIESCENCE, pas de durée (remédiation F-03) : voir
 *  tests/helpers/dom-settle.ts. `ms` est accepté et ignoré. */
const flush = settle;

function tabs(container: Element): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("nav a")) as HTMLAnchorElement[];
}

test("[BO1-NAV-DOM-1] l'onglet Disponibilités conserve le libellé et l'établissement, l'onglet E-mails est ajouté", async () => {
  const { container, root } = render("/dashboard/availability");
  await flush();

  const links = tabs(container);
  assert.equal(links.length, 9, "la barre compte neuf onglets avec E-mails");
  const target = links.find((a) => (a.getAttribute("href") ?? "").includes("/dashboard/availability"));
  assert.ok(target, "un lien vers /dashboard/availability doit exister");
  assert.ok(
    target!.getAttribute("href")!.includes("r=r1"),
    "l'établissement sélectionné doit voyager dans le lien"
  );
  assert.ok(
    (target!.textContent ?? "").includes("Mise à disposition"),
    "le libellé complet doit être présent dans le DOM"
  );
  assert.ok(links.some((a) => a.getAttribute("href")?.includes("/dashboard/email")), "le nouvel onglet E-mails doit être présent");

  // Placé juste après « Tarifs de livraison » : les deux règlent la
  // même chose, la mise à disposition.
  const hrefs = links.map((a) => a.getAttribute("href") ?? "");
  const pricing = hrefs.findIndex((h) => h.includes("/dashboard/delivery-pricing"));
  const availability = hrefs.findIndex((h) => h.includes("/dashboard/availability"));
  assert.equal(availability, pricing + 1, "l'ordre des onglets est une décision, pas un hasard");

  root.unmount();
  container.remove();
});

test("[BO1-NAV-DOM-2] sur CHAQUE route, un seul onglet est actif (matrice complète, L1B-02)", async () => {
  for (const [route, activeHref] of ROUTES) {
    const { container, root } = render(route);
    await flush();

    const links = tabs(container);
    const active = links.filter((a) => a.className.includes(ACTIVE_CLASS));
    assert.equal(
      active.length,
      1,
      `${route} : exactement un onglet doit être actif (vus : ${active.length})`
    );
    assert.ok(
      (active[0].getAttribute("href") ?? "").includes(activeHref),
      `${route} : l'onglet actif doit être ${activeHref}, vu ${active[0].getAttribute("href")}`
    );

    root.unmount();
    container.remove();
  }
});

test("[BO1-NAV-DOM-3] « Commandes » n'est JAMAIS actif sur la nouvelle route -- la régression reproduite avant correction", async () => {
  const { container, root } = render("/dashboard/availability");
  await flush();

  const links = tabs(container);
  const orders = links.find((a) => (a.getAttribute("href") ?? "").startsWith("/dashboard?"))!;
  const availability = links.find((a) => (a.getAttribute("href") ?? "").includes("/dashboard/availability"))!;
  assert.ok(
    !orders.className.includes(ACTIVE_CLASS),
    "sans l'exclusion du repli générique, « Commandes » s'allume ici : c'est exactement L1B-02"
  );
  assert.ok(availability.className.includes(ACTIVE_CLASS));

  root.unmount();
  container.remove();
});

test("[BO1-NAV-DOM-4] une route inconnue laisse « Commandes » actif, et aucun autre -- le repli reste un repli", async () => {
  const { container, root } = render("/dashboard/une-route-future");
  await flush();

  const links = tabs(container);
  const active = links.filter((a) => a.className.includes(ACTIVE_CLASS));
  assert.equal(active.length, 1);
  assert.ok((active[0].getAttribute("href") ?? "").startsWith("/dashboard?"));

  root.unmount();
  container.remove();
});

test("[BO1-NAV-DOM-5] les huit onglets antérieurs restent dans le même ordre et E-mails est ajouté en dernier", async () => {
  const { container, root } = render("/dashboard");
  await flush();

  const hrefs = tabs(container).map((a) => (a.getAttribute("href") ?? "").split("?")[0]);
  assert.deepEqual(hrefs, [
    "/dashboard",
    "/dashboard/catalogue",
    "/dashboard/settings",
    "/dashboard/delivery-pricing",
    "/dashboard/availability",
    "/dashboard/payment",
    "/dashboard/legal-cgv",
    "/dashboard/translations",
    "/dashboard/email",
  ]);

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
});
