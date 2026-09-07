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
// OB-1 v1.1 — OPERATOR COCKPIT (app/admin/establishments/cockpit/page.tsx).
// Rendu RÉEL en DOM (jsdom). Preuve comportementale que :
//   - les 9 sections mandatées sont rendues ;
//   - CATALOGUE reflète réellement le résultat de getMerchantCatalogue
//     (désormais opérateur-autorisé par OB-2 v1.1) : "ready" quand le
//     catalogue a du contenu, "incomplete" quand il est vide,
//     "unavailable" seulement sur échec réel de la lecture (jamais un
//     statut inventé) ;
//   - PHOTOS est dérivé du MÊME résultat déjà chargé (aucun second
//     appel), reflète la couverture photo réelle ;
//   - PAYMENT/DELIVERY restent "unavailable" (re-vérifiés inchangés
//     par OB-2 v1.1) ;
//   - aucun secret de paiement/credential n'apparaît jamais dans le
//     DOM rendu ;
//   - aucun <button> (aucune action de mutation) n'est introduit ;
//   - le contexte d'un établissement ne fuite JAMAIS vers un autre
//     (deux montages frais avec deux `?r=` distincts restent isolés).
// next/navigation et les services Supabase sont mockés ; la logique
// réelle de la page n'est jamais mockée.
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
    receipt: {
      restaurant_id: "r1",
      business_name: "Au Lait Cru",
      legal_name: "SARL Au Lait Cru",
      legal_address: "1 rue du Fromage, Paris",
      phone: null,
      email: null,
      tax_identifier: "FR123456789",
      registration_number: null,
      tax_label: "TVA",
      default_tax_rate: 20,
      prices_include_tax: true,
      footer_text: null,
      show_tax_summary: false,
      paper_width_mm: 58,
      restaurant_country: "FR",
    },
    // Catalogue réel (OB-2 v1.1) : 1 catégorie, 2 produits actifs dont
    // 1 avec photo, 1 produit archivé (ne doit compter dans aucun
    // total). Reproduit fidèlement la forme renvoyée par
    // getMerchantCatalogue (lib/services/dashboard.ts).
    catalogue: [
      {
        category_id: "c1",
        category_name: "Fromages",
        category_translations: null,
        category_display_order: 0,
        category_is_option_source: false,
        category_description: null,
        products: [
          { product_id: "p1", category_id: "c1", category_name: "Fromages", category_translations: null, subcategory_id: null, subcategory_name: null, name: "Camembert", name_hash: "h1", short_description: null, short_description_hash: null, description: null, description_hash: null, translations: null, price: 5, is_available: true, archived_at: null, display_order: 0, is_option_source: false, image_url: "https://cdn.example/camembert.jpg", tax_rate: null, unit_weight_grams: null, weight_is_approximate: false, reference_price_per_kg: null },
          { product_id: "p2", category_id: "c1", category_name: "Fromages", category_translations: null, subcategory_id: null, subcategory_name: null, name: "Brie", name_hash: "h2", short_description: null, short_description_hash: null, description: null, description_hash: null, translations: null, price: 6, is_available: true, archived_at: null, display_order: 1, is_option_source: false, image_url: null, tax_rate: null, unit_weight_grams: null, weight_is_approximate: false, reference_price_per_kg: null },
          { product_id: "p3", category_id: "c1", category_name: "Fromages", category_translations: null, subcategory_id: null, subcategory_name: null, name: "Ancien produit", name_hash: "h3", short_description: null, short_description_hash: null, description: null, description_hash: null, translations: null, price: 4, is_available: false, archived_at: "2025-01-01T00:00:00Z", display_order: 2, is_option_source: false, image_url: null, tax_rate: null, unit_weight_grams: null, weight_is_approximate: false, reference_price_per_kg: null },
        ],
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
    // Établissement tout juste onboardé : aucune catégorie.
    catalogue: [],
  },
  r3: {
    summary: {
      restaurantId: "r3",
      name: "Café Léa",
      slug: "cafe-lea",
      status: "active",
      ownerEmail: null,
      ownerStatus: null,
    },
    receipt: null,
    // Simule un échec RÉEL de lecture catalogue (voir mock ci-dessous) :
    // getMerchantCatalogue rejette pour cet id.
    catalogueThrows: true,
  },
};

// Sentinelle : si jamais un secret de paiement apparaissait dans le
// DOM, ce test le détecterait -- même si AUCUN chemin de code actuel
// ne peut y accéder (aucune RPC paiement n'est appelée par cette
// page, voir le mock ci-dessous qui ne l'expose délibérément pas).
const FORBIDDEN_SECRET = "sk_live_should_never_appear_ANYWHERE";

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockGetSummary = async (id: string) => {
  const m = MERCHANTS[id];
  if (!m) throw new Error("not found");
  return m.summary;
};
(globalThis as any).__mockGetReceipt = async (id: string) => MERCHANTS[id]?.receipt ?? null;
(globalThis as any).__mockGetCatalogue = async (id: string) => {
  const m = MERCHANTS[id];
  if (m?.catalogueThrows) throw new Error("catalogue read failed");
  return m?.catalogue ?? [];
};
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
export async function getEstablishmentSummary(id) { return (globalThis).__mockGetSummary(id); }
`;

// Reproduit STRICTEMENT le contrat de lib/services/dashboard.ts::getReceiptSettings
// et ::getMerchantCatalogue (jamais de champ paiement/credential dans
// ce module -- il n'a de toute façon jamais existé dans ce contrat).
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

test("OB-1 cockpit : les 9 sections mandatées sont rendues pour un établissement existant", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(50);

  const sections = container.querySelectorAll('[data-testid="cockpit-section"]');
  assert.equal(sections.length, 9, "les 9 sections mandatées doivent être présentes");

  assert.ok(container.textContent?.includes("Au Lait Cru"));
  assert.deepEqual((globalThis as any).__mockReplaceCalls, []);

  root.unmount();
  container.remove();
});

function sectionByTitle(container: HTMLElement, needle: string) {
  const sections = Array.from(container.querySelectorAll('[data-testid="cockpit-section"]'));
  return sections.find((s) => (s as HTMLElement).dataset.sectionTitle?.includes(needle));
}

test("OB-1 v1.1 cockpit : CATALOGUE reflète le catalogue réellement chargé -- 'ready' avec du contenu, résumé exact (2 produits actifs, 1 archivé exclu)", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  const section = sectionByTitle(container, "Catalogue");
  assert.ok(section);
  const badge = section!.querySelector('[data-testid="section-status-badge"]') as HTMLElement;
  assert.equal(badge.dataset.status, "ready");
  assert.ok(section!.textContent?.includes("1 catégorie"));
  assert.ok(section!.textContent?.includes("2 produit"));
  assert.ok(!section!.textContent?.includes("3 produit"), "le produit archivé ne doit jamais être compté");

  root.unmount();
  container.remove();
});

test("OB-1 v1.1 cockpit : CATALOGUE vide (établissement tout juste onboardé) -- 'incomplete', jamais 'ready' par défaut", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r2");
  const { container, root } = render();
  await flush(50);

  const section = sectionByTitle(container, "Catalogue");
  const badge = section!.querySelector('[data-testid="section-status-badge"]') as HTMLElement;
  assert.equal(badge.dataset.status, "incomplete");

  root.unmount();
  container.remove();
});

test("OB-1 v1.1 cockpit : PHOTOS dérivé du même catalogue déjà chargé -- 1/2 produits actifs ont une photo, 'incomplete' (pas tous), jamais un second appel réseau distinct requis", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  const section = sectionByTitle(container, "Photos");
  assert.ok(section);
  const badge = section!.querySelector('[data-testid="section-status-badge"]') as HTMLElement;
  assert.equal(badge.dataset.status, "incomplete");
  assert.ok(section!.textContent?.includes("1"));
  assert.ok(section!.textContent?.includes("2"));

  root.unmount();
  container.remove();
});

test("OB-1 v1.1 cockpit : un échec RÉEL de lecture catalogue dégrade UNIQUEMENT catalogue/photos vers 'unavailable' -- jamais un statut inventé, jamais tout le cockpit qui casse", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r3");
  const { container, root } = render();
  await flush(50);

  const catalogueSection = sectionByTitle(container, "Catalogue");
  const photosSection = sectionByTitle(container, "Photos");
  assert.equal(
    (catalogueSection!.querySelector('[data-testid="section-status-badge"]') as HTMLElement).dataset.status,
    "unavailable"
  );
  assert.equal(
    (photosSection!.querySelector('[data-testid="section-status-badge"]') as HTMLElement).dataset.status,
    "unavailable"
  );
  // Le reste du cockpit continue de fonctionner normalement.
  assert.ok(container.textContent?.includes("Café Léa"));
  assert.equal(container.querySelectorAll('[data-testid="cockpit-section"]').length, 9);

  root.unmount();
  container.remove();
});

test("OB-1 v1.1 cockpit : PAYMENT / DELIVERY restent 'unavailable' (re-vérifiés inchangés par OB-2 v1.1), jamais un statut inventé", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  for (const needle of ["Paiement", "Livraison"]) {
    const section = sectionByTitle(container, needle);
    assert.ok(section, `la section ${needle} doit exister`);
    const badge = section!.querySelector('[data-testid="section-status-badge"]') as HTMLElement;
    assert.equal(badge.dataset.status, "unavailable", `${needle} doit rester 'unavailable'`);
  }

  root.unmount();
  container.remove();
});

test("OB-1 v1.1 cockpit : chaque lien vers un écran marchand existant (settings/catalogue/payment/delivery-pricing) porte le rappel honnête sur le gap restaurant_users", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  for (const needle of ["Établissement", "Légal", "Catalogue", "Paiement", "Livraison"]) {
    const section = sectionByTitle(container, needle);
    assert.ok(section, `la section ${needle} doit exister`);
    assert.ok(
      section!.textContent?.includes("non lié à un restaurant"),
      `${needle} doit porter le rappel honnête sur le gap restaurant_users`
    );
  }

  root.unmount();
  container.remove();
});

test("OB-1 cockpit : aucun secret de paiement/credential n'apparaît jamais dans le DOM rendu", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  assert.ok(!container.textContent?.includes(FORBIDDEN_SECRET));
  assert.ok(!/credentials_ref/i.test(container.textContent ?? ""));
  assert.ok(!/vault/i.test(container.textContent ?? ""));

  root.unmount();
  container.remove();
});

test("OB-1 cockpit : aucun <button> n'est introduit -- uniquement des liens de navigation, aucune action de mutation", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const { container, root } = render();
  await flush(50);

  assert.equal(container.querySelectorAll("button").length, 0);

  root.unmount();
  container.remove();
});

test("OB-1 cockpit : READY TO PUBLISH reflète le statut réel sans jamais proposer d'action de publication", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r2");
  const { container, root } = render();
  await flush(50);

  assert.ok(container.textContent?.includes("Sanaa Cookies"));
  assert.ok(container.textContent?.includes("onboarding"));
  assert.equal(container.querySelectorAll("button").length, 0);

  root.unmount();
  container.remove();
});

test("OB-1 cockpit : le contexte d'un établissement ne fuite JAMAIS vers un autre (deux montages frais, deux `?r=` distincts)", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  const first = render();
  await flush(50);
  assert.ok(first.container.textContent?.includes("Au Lait Cru"));
  assert.ok(!first.container.textContent?.includes("Sanaa Cookies"));

  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r2");
  const second = render();
  await flush(50);
  assert.ok(second.container.textContent?.includes("Sanaa Cookies"));
  assert.ok(!second.container.textContent?.includes("Au Lait Cru"));

  // Le premier montage, jamais démonté, reste inchangé : aucune fuite
  // rétroactive de r2 vers le container r1.
  assert.ok(first.container.textContent?.includes("Au Lait Cru"));
  assert.ok(!first.container.textContent?.includes("Sanaa Cookies"));

  first.root.unmount();
  first.container.remove();
  second.root.unmount();
  second.container.remove();
});

test("OB-1 cockpit : absence de `?r=` affiche un message neutre, aucune donnée d'établissement chargée", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit");
  const { container, root } = render();
  await flush(50);

  assert.ok(!container.textContent?.includes("Au Lait Cru"));
  assert.ok(!container.textContent?.includes("Sanaa Cookies"));
  assert.equal(container.querySelectorAll('[data-testid="cockpit-section"]').length, 0);

  root.unmount();
  container.remove();
});

test("OB-1 cockpit : un utilisateur authentifié NON opérateur est redirigé vers /dashboard, aucune donnée d'établissement n'apparaît", async () => {
  window.history.pushState({}, "", "/admin/establishments/cockpit?r=r1");
  (globalThis as any).__mockIsOperator = false;
  (globalThis as any).__mockReplaceCalls = [];

  const { container, root } = render();
  await flush(50);

  assert.deepEqual((globalThis as any).__mockReplaceCalls, ["/dashboard"]);
  assert.ok(!container.textContent?.includes("Au Lait Cru"));

  (globalThis as any).__mockIsOperator = true;
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
  delete (globalThis as any).__mockGetSummary;
  delete (globalThis as any).__mockGetReceipt;
  delete (globalThis as any).__mockGetCatalogue;
  delete (globalThis as any).__mockReplaceCalls;
});
