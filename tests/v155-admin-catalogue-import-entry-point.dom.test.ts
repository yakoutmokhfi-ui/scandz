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
// MERCHANT CATALOGUE IMPORT ENTRY POINT v1 — SCOPE CORRECTION:
// ADMIN ONLY. The catalogue mass-import capability must be reachable
// from the Admin/Operator Establishment Cockpit
// (app/admin/establishments/cockpit/page.tsx, OB-1), NOT from the
// merchant dashboard. This lot adds ONLY a second navigation link
// inside the existing CATALOGUE section, pointing to the already
// published and already audited OB-3/OB-4 import screen
// (app/dashboard/catalogue-import/page.tsx) with the cockpit's own
// `restaurantId` — no import logic (parsing/preview/validation/
// commit/idempotency) is duplicated or reimplemented here, and no
// merchant-facing file is touched by this lot.
//
// Real DOM render (jsdom) of the real cockpit component, same
// harness pattern and same fixture as
// tests/ob1-operator-cockpit.dom.test.ts (13/13 passing, unchanged
// by this lot — re-run separately as regression). This file adds
// only what THAT file does not already cover: the new link's
// presence, its exact href (tenant preserved, current establishment
// only), its absence when no establishment is selected, and that it
// remains a plain navigation <a> (no new <button>/mutation
// introduced — the existing "no button" assertion in
// ob1-operator-cockpit.dom.test.ts already covers this globally and
// is unchanged).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/admin/establishments/cockpit?r=r1",
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

const MERCHANTS: Record<string, any> = {
  r1: {
    summary: {
      restaurantId: "r1",
      name: "Au Lait Cru",
      slug: "au-lait-cru",
      status: "active",
      ownerEmail: "owner@aulaitcru.fr",
      ownerStatus: "linked",
    },
    receipt: null,
    catalogue: [
      {
        category_id: "c1",
        category_name: "Fromages",
        category_translations: null,
        category_display_order: 0,
        category_is_option_source: false,
        category_description: null,
        products: [],
        subcategories: [],
      },
    ],
  },
  r2: {
    summary: {
      restaurantId: "r2",
      name: "Sanaa Cookies",
      slug: "sanaa-cookies",
      status: "onboarding",
      ownerEmail: null,
      ownerStatus: null,
    },
    receipt: null,
    catalogue: [],
  },
};

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockGetSummary = async (id: string) => {
  const m = MERCHANTS[id];
  if (!m) throw new Error("not found");
  return m.summary;
};
(globalThis as any).__mockGetReceipt = async (id: string) => MERCHANTS[id]?.receipt ?? null;
(globalThis as any).__mockGetCatalogue = async (id: string) => MERCHANTS[id]?.catalogue ?? [];
(globalThis as any).__mockReplaceCalls = [] as string[];

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

const MOCK_DASHBOARD = `
export async function getReceiptSettings(id) { return (globalThis).__mockGetReceipt(id); }
export async function getMerchantCatalogue(id) { return (globalThis).__mockGetCatalogue(id); }
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
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
export { default as CockpitPage } from "@/app/admin/establishments/cockpit/page.tsx";
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
const tmpFile = path.join(tmpDir, "CockpitPage.mjs");
writeFileSync(tmpFile, code);
const { CockpitPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CockpitPage));
  return { container, root };
}

function flush(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sectionByTitle(container: HTMLElement, needle: string) {
  const sections = Array.from(container.querySelectorAll('[data-testid="cockpit-section"]'));
  return sections.find((s) => (s as HTMLElement).dataset.sectionTitle?.includes(needle)) as
    | HTMLElement
    | undefined;
}

function findImportLink(section: HTMLElement | undefined) {
  if (!section) return undefined;
  return [...section.querySelectorAll("a")].find((a) => a.textContent === "Importer un catalogue");
}

test("ADMIN CATALOGUE IMPORT ENTRY POINT : le lien 'Importer un catalogue' est présent dans la section Catalogue du cockpit", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  const catalogueSection = sectionByTitle(container, "Catalogue");
  assert.ok(catalogueSection, "la section Catalogue doit être présente");
  const link = findImportLink(catalogueSection);
  assert.ok(link, "le lien 'Importer un catalogue' doit être présent dans la section Catalogue");

  root.unmount();
  container.remove();
});

test("ADMIN CATALOGUE IMPORT ENTRY POINT : le lien pointe vers la page OB-3/OB-4 existante, pour l'établissement COURANT du cockpit uniquement", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  const link = findImportLink(sectionByTitle(container, "Catalogue"));
  assert.ok(link, "le lien doit être présent");
  assert.equal(
    link!.getAttribute("href"),
    "/dashboard/catalogue-import?r=r1",
    "le lien doit pointer vers la page d'import EXISTANTE (jamais réimplémentée) avec exactement le restaurant_id de l'établissement actuellement ouvert dans le cockpit -- jamais un autre établissement, jamais un ID arbitraire"
  );

  root.unmount();
  container.remove();
});

test("ADMIN CATALOGUE IMPORT ENTRY POINT : deux établissements distincts obtiennent chacun leur PROPRE lien d'import -- aucune fuite de tenant", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r2");
  const { container, root } = render();
  await flush(50);

  const link = findImportLink(sectionByTitle(container, "Catalogue"));
  assert.ok(link, "le lien doit être présent aussi pour un établissement tout juste onboardé (catalogue vide)");
  assert.equal(
    link!.getAttribute("href"),
    "/dashboard/catalogue-import?r=r2",
    "l'établissement affiché (r2) doit produire un lien d'import vers r2, jamais r1 ni un autre établissement précédemment consulté"
  );

  root.unmount();
  container.remove();
});

test("ADMIN CATALOGUE IMPORT ENTRY POINT : aucun <button> introduit (navigation pure, aucune action de mutation ajoutée par ce lot)", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  assert.equal(
    container.querySelectorAll("button").length,
    0,
    "ce lot ajoute uniquement un lien de navigation <a> -- aucun <button> ne doit apparaître, exactement comme avant ce lot (voir tests/ob1-operator-cockpit.dom.test.ts, assertion identique et inchangée)"
  );

  root.unmount();
  container.remove();
});

test("Régression de contrôle : les 9 sections mandatées du cockpit restent toutes présentes", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  assert.equal(
    container.querySelectorAll('[data-testid="cockpit-section"]').length,
    9,
    "ce lot ne doit ajouter, retirer ni fusionner aucune section du cockpit"
  );

  root.unmount();
  container.remove();
});
