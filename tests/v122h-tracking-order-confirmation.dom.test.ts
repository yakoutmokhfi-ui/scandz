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
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// components/OrderConfirmation.tsx (contrat du composant, ISOLÉ de
// MenuView -- voir tests/v122i-tracking-menuview-wiring.dom.test.ts
// pour la preuve d'intégration bout-en-bout via un create_order réel).
//
// Couvre mandat §20 ("no tracking link if order creation failed" ->
// trackingPath=null -> aucun lien), §6/§7 (le lien affiché ne doit
// JAMAIS porter le format v1 <order_id>/<token> ni un paramètre de
// requête -- seulement ce que l'appelant lui a transmis, ce composant
// ne le reconstruit ni ne le régénère jamais lui-même) et §25
// (langue : réutilise l'architecture i18n existante, aucun nouveau
// framework -- vérifié ici via I18nProvider pour l'anglais).
//
// `useI18n()` fournit une valeur par défaut (français) sans Provider --
// même constat déjà établi par tests/v85-lot2b2v3-fulfillment-label.dom.test.ts
// -- donc la plupart des scénarios ci-dessous ne montent AUCUN
// I18nProvider ; seul le scénario anglais en monte un explicitement.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
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

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const entrySource = `
export { default as OrderConfirmation } from "@/components/OrderConfirmation";
export { I18nProvider } from "@/lib/i18n-context";
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
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v122h-"));
const tmpFile = path.join(tmpDir, "OrderConfirmation.mjs");
writeFileSync(tmpFile, code);
const { OrderConfirmation, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findTrackingAnchor(container: Element): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("/track/"));
}

/** Fixture RestaurantFull minimale -- seuls les champs lus par
 *  OrderConfirmation.tsx (restaurant.name) sont pertinents ici. */
const RESTAURANT = {
  id: "r-sanaa-test",
  name: "Sanaa Cookies (test)",
  slug: "sanaa-cookies",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  config: {
    restaurant_id: "r-sanaa-test",
    max_tables: 10,
    currency: "EUR",
    whatsapp_number: "+33600000000",
    address: null,
    latitude: null,
    longitude: null,
    logo_url: null,
    cover_url: null,
    opening_hours: null,
    source_language: "fr",
  },
  categories: [],
  hiddenCategories: [],
  activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
};

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const TRACKING_PATH = `/track/${ORDER_ID}#${TOKEN}`;

function render(props: { trackingPath: string | null; orderNumber?: number | null }) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderConfirmation, {
      restaurant: RESTAURANT,
      context: null,
      orderNumber: props.orderNumber ?? 42,
      trackingPath: props.trackingPath,
      onBackToMenu: () => {},
      onNewOrder: () => {},
    })
  );
  return { container, root };
}

test("mandat §20 : trackingPath fourni -- un lien de suivi RÉEL (<a href>) est rendu, exactement égal au chemin transmis (jamais reconstruit ni régénéré par ce composant)", async () => {
  const { container, root } = render({ trackingPath: TRACKING_PATH });
  await flush();

  const anchor = findTrackingAnchor(container);
  assert.ok(anchor, "un <a href=\"/track/...\"> doit être rendu");
  assert.equal(anchor!.getAttribute("href"), TRACKING_PATH, "le composant ne doit JAMAIS altérer/reconstruire le chemin reçu");
  assert.equal(anchor!.textContent, "Suivre ma commande");
  assert.equal(anchor!.tagName, "A", "un lien HTML natif -- pas un bouton avec navigation JS");

  root.unmount();
  container.remove();
});

test("mandat §20 : trackingPath=null (create_order en échec, ou commande refermée) -- AUCUN lien de suivi rendu", async () => {
  const { container, root } = render({ trackingPath: null });
  await flush();

  assert.equal(findTrackingAnchor(container), undefined, "aucun lien de suivi ne doit apparaître sans trackingPath");
  assert.equal(container.textContent?.includes("Suivre ma commande"), false);

  root.unmount();
  container.remove();
});

test("mandat §6/§7 : le href rendu ne contient JAMAIS le format v1 <order_id>/<token> ni un paramètre de requête -- seulement ce qui a été transmis en FRAGMENT", async () => {
  const { container, root } = render({ trackingPath: TRACKING_PATH });
  await flush();

  const href = findTrackingAnchor(container)!.getAttribute("href")!;
  const url = new URL(href, "https://example.com");
  assert.equal(url.pathname, `/track/${ORDER_ID}`);
  assert.equal(url.search, "", "aucune chaîne de requête ne doit porter le jeton");
  assert.equal(url.hash, `#${TOKEN}`);
  assert.equal(href.includes(`/track/${ORDER_ID}/${TOKEN}`), false, "JAMAIS le format v1 FORBIDDEN (mandat §6)");
  assert.equal(href.includes("?token="), false);

  root.unmount();
  container.remove();
});

test("mandat §25 : langue anglaise (I18nProvider) -- le même composant, la même architecture i18n existante, un libellé traduit différent", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      I18nProvider,
      { lang: "en", sourceLanguage: "fr", activeLanguages: RESTAURANT.activeLanguages },
      React.createElement(OrderConfirmation, {
        restaurant: RESTAURANT,
        context: null,
        orderNumber: 42,
        trackingPath: TRACKING_PATH,
        onBackToMenu: () => {},
        onNewOrder: () => {},
      })
    )
  );
  await flush();

  const anchor = findTrackingAnchor(container);
  assert.ok(anchor, "le lien de suivi doit rester présent en anglais");
  assert.equal(anchor!.textContent, "Track your order");
  assert.equal(anchor!.getAttribute("href"), TRACKING_PATH, "le chemin transmis reste inchangé, quelle que soit la langue");

  root.unmount();
  container.remove();
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
