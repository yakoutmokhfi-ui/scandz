// THEME & CONTENT SETTINGS v1 -- étape 1 de la preuve navigateur.
// Rend la VRAIE vitrine (MenuView + cartes de livraison) avec React/JSDOM,
// dans deux variantes (sans configuration / configurée), et écrit le balisage
// dans <outDir>/{default,configured}.html. L'étape 2 (browser-proof.mjs)
// compile le CSS réel (Tailwind + app/globals.css) et mesure les styles
// CALCULÉS dans Chromium.
//
//   node --experimental-strip-types --import ./tests/register.mjs \
//        supabase/evidence/theme-content-settings-v1/render-markup.mjs <outDir>
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
const outDir = path.resolve(process.argv[2] ?? "proof-out");
mkdirSync(outDir, { recursive: true });

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement; globalThis.Event = window.Event;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { supabase } = await import(pathToFileURL(path.resolve("lib/supabase.ts")).href);
const ROOT = process.cwd();
const alias = {
  name: "at", setup(b) {
    b.onResolve({ filter: /^@\// }, (a) => {
      const base = path.join(ROOT, a.path.slice(2));
      const r = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p)) ?? base;
      return r.endsWith(path.join("lib", "supabase.ts")) ? { path: pathToFileURL(r).href, external: true } : { path: r };
    });
  },
};
const res = await esbuild.build({
  stdin: { contents: `export { default as MenuView } from "@/components/MenuView";
export { DeliveryConditionsButton } from "@/components/DeliveryConditions";
export { I18nProvider } from "@/lib/i18n-context";`, resolveDir: ROOT, loader: "tsx" },
  bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022", plugins: [alias],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmp = mkdtempSync(path.join(ROOT, "tests", "tmp-proof-"));
writeFileSync(path.join(tmp, "e.mjs"), res.outputFiles[0].text);
const mod = await import(pathToFileURL(path.join(tmp, "e.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

const chain = new Proxy(function () {}, { get: (_, p) => (p === "then" ? (r) => r({ data: [], error: null }) : () => chain), apply: () => chain });
supabase.from = () => chain;
supabase.rpc = async (name) => name === "get_restaurant_public_communication_texts"
  ? { data: [
      { text_key: "order_help_button_label", body: "Comment passer commande ?" },
      { text_key: "order_help_title", body: "Passer commande en 3 étapes" },
      { text_key: "order_help_body", body: "1. Choisissez vos produits\n2. Validez le panier\n3. Payez ou confirmez" },
    ], error: null }
  : { data: [], error: null };

const RULES = [
  { fulfillmentCode: "x", zonePrefixes: ["75"], isFallback: false, minItems: null, customerText: "Livraison à votre adresse.", customerTextHash: null,
    translations: null, displayOrder: 1, pricingMode: "fixed", fixedFee: 6.9, freeThreshold: null, discountEnabled: false, discountThreshold: null, discountPercentage: null },
  { fulfillmentCode: "y", zonePrefixes: [], isFallback: true, minItems: 2, customerText: null, customerTextHash: null,
    translations: null, displayOrder: 2, pricingMode: "fixed", fixedFee: 9.5, freeThreshold: 80, discountEnabled: false, discountThreshold: null, discountPercentage: null },
];
// Établissement « sombre » : fond de page sombre, accent laiton -- la configuration
// ne touche QUE les surfaces d'information.
const TOKENS = {
  info_panel_bg: "#FFFFFF", info_panel_text: "#111111",
  popup_bg: "#FFFFFF", popup_text: "#000000",
  delivery_card_bg: "#FFFFFF", delivery_card_text: "#000000",
  surface_border: "#C9A24B",
};
const restaurant = (tokens) => ({
  id: "r-proof", name: "Boutique", slug: "slug-proof", is_active: true, created_at: "2026-01-01T00:00:00Z",
  config: {
    restaurant_id: "r-proof", max_tables: 10, currency: "EUR", whatsapp_number: "+33600000000",
    address: "12 rue du Fromage, 75001 Paris", latitude: null, longitude: null, logo_url: null, cover_url: null,
    opening_hours: "Lundi 09:00 – 19:00\nMardi 09:00 – 19:00", maps_url: null, source_language: "fr",
    bg_color: "#14100D", primary_color: "#2B1D14", secondary_color: "#221510", accent_color: "#C6A15B",
    ...(tokens ? { theme_tokens: tokens } : {}),
  },
  categories: [{ id: "c1", restaurant_id: "r-proof", name: "Fromages", display_order: 1, is_active: true,
    menu_items: [{ id: "i1", category_id: "c1", name: "Comté", description: "Affiné 18 mois, lait cru.", price: 8.9, image_url: null, display_order: 1, is_available: true }] }],
  hiddenCategories: [], activeLanguages: [{ language_code: "fr", display_order: 0 }],
});
const act = React.act;
for (const [name, tokens] of [["default", null], ["configured", TOKENS]]) {
  const c = window.document.createElement("div");
  window.document.body.appendChild(c);
  const root = createRoot(c);
  await act(async () => { root.render(React.createElement(mod.MenuView, { restaurant: restaurant(tokens) })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  // Cartes de livraison : rendues par le composant réel, insérées DANS le conteneur thémé
  // (les règles sont des sélecteurs descendants du conteneur).
  const d = window.document.createElement("div");
  const dr = createRoot(d);
  await act(async () => { dr.render(React.createElement(mod.I18nProvider, { lang: "fr", sourceLanguage: "fr" }, React.createElement(mod.DeliveryConditionsButton, { rules: RULES, currency: "EUR" }))); });
  const host = c.querySelector("[dir]");
  host.insertAdjacentHTML("beforeend", `<div id="proof-delivery">${d.innerHTML}</div>`);
  writeFileSync(path.join(outDir, `${name}.html`), `<div id="proof-root">${c.innerHTML}</div>`);
  await act(async () => { dr.unmount(); root.unmount(); });
}
console.log("markup written to", outDir);
await esbuild.stop();
setTimeout(() => process.exit(0), 100);
