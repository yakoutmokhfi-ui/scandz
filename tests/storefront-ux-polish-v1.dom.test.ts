import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ============================================================
// STOREFRONT UX POLISH v1 -- preuves DOM (présentation uniquement).
//
//   1. Instagram / TikTok : rendus seulement si l'URL existe, href,
//      target/rel et nom accessible inchangés, traitement de marque
//      (dégradé Instagram, échos cyan/rouge TikTok), cible 40 px.
//   2. Facebook et le comportement des URL sociales inchangés.
//   3. Cartouche livraison : aucun provider / fulfillment_code, frais
//      affiché une seule fois et issu des faits publics existants
//      (computeDeliveryFee / status.deliveryFee), jamais « 0 € » quand le
//      frais est indisponible, aucune remise si discountEnabled=false.
//   4. Navigation catalogue : catégories / collections fonctionnelles,
//      état sélectionné (aria-pressed), pas de « Tout le catalogue »,
//      rangée mobile défilable, pas de marge vide sans collection.
// ============================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();
const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};
const buildResult = await esbuild.build({
  stdin: {
    contents: `
export { default as RestaurantHeader } from "@/components/RestaurantHeader";
export { default as MenuView } from "@/components/MenuView";
export { DeliveryConditionsButton, DeliveryPostcodeResult } from "@/components/DeliveryConditions";
export { I18nProvider } from "@/lib/i18n-context";
export { computeDeliveryFee } from "@/lib/delivery";
export { formatPrice } from "@/lib/whatsapp";
`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022",
  plugins: [aliasPlugin], external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "entry.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const mod = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });
// Même nettoyage que les tests DOM MenuView existants (v170,
// customer-collections-by-tags) : MenuView laisse des requêtes publiques
// en vol vers l'URL Supabase factice.
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
});

const act = (React as any).act as (fn: () => unknown) => Promise<void>;

async function mount(element: unknown) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element as any); });
  return {
    container,
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

function restaurant(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "r-ux", name: "Au Lait Cru", slug: "ux-polish-fixture", is_active: true, created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r-ux", max_tables: 10, currency: "EUR", whatsapp_number: "+33600000000",
      address: null, latitude: null, longitude: null, logo_url: null, cover_url: null, opening_hours: null,
      maps_url: null, source_language: "fr", ...config,
    },
    categories: [
      { id: "c1", restaurant_id: "r-ux", name: "Fromages au lait cru", display_order: 1, is_active: true,
        menu_items: [{ id: "i1", category_id: "c1", name: "Comté", description: null, price: 8.9, image_url: null, display_order: 1, is_available: true }] },
      { id: "c2", restaurant_id: "r-ux", name: "Crèmerie & beurres de baratte", display_order: 2, is_active: true,
        menu_items: [{ id: "i2", category_id: "c2", name: "Beurre demi-sel", description: null, price: 4.8, image_url: null, display_order: 1, is_available: true }] },
    ],
    hiddenCategories: [],
    activeLanguages: [{ language_code: "fr", display_order: 0 }],
    ...extra,
  };
}

function renderHeader(config: Record<string, unknown>) {
  return mount(React.createElement(mod.RestaurantHeader, {
    restaurant: restaurant(config), lang: "fr", onChangeLang: () => {}, theme: "classic", banner: undefined,
  }));
}

const IG = "https://www.instagram.com/aulaitcru/";
const TT = "https://www.tiktok.com/@aulaitcru";
const FB = "https://www.facebook.com/aulaitcru";

// ------------------------------------------------------------------ 1-3
test("1. Instagram : rendu seulement si l'URL existe, href exact, nom accessible, dégradé de marque", async () => {
  const none = await renderHeader({ tiktok_url: TT });
  assert.equal(none.container.querySelector('a[aria-label="Instagram"]'), null, "aucune icône Instagram sans URL");
  await none.unmount();

  const r = await renderHeader({ instagram_url: IG });
  try {
    const a = r.container.querySelector<HTMLAnchorElement>('a[aria-label="Instagram"]');
    assert.ok(a, "lien Instagram présent");
    assert.equal(a!.getAttribute("href"), IG);
    assert.equal(a!.getAttribute("target"), "_blank");
    assert.equal(a!.getAttribute("rel"), "noopener noreferrer");
    assert.equal(a!.getAttribute("data-social-brand"), "instagram");
    for (const cls of ["h-10", "w-10", "focus-visible:outline"]) assert.ok(a!.className.includes(cls), `classe ${cls}`);
    const svg = a!.querySelector("svg")!;
    assert.equal(svg.getAttribute("aria-hidden"), "true", "le nom vient du lien, jamais de la couleur seule");
    const stops = [...svg.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color")!.toUpperCase());
    for (const c of ["#FEDA75", "#FA7E1E", "#D62976", "#962FBF", "#4F5BD5"]) assert.ok(stops.includes(c), `couleur de marque ${c}`);
    const gradientId = svg.querySelector("radialGradient")!.getAttribute("id")!;
    assert.ok(svg.querySelector(`rect[fill="url(#${gradientId})"]`), "le carré utilise le dégradé déclaré");
    assert.ok(!svg.outerHTML.includes("currentColor"), "plus de glyphe monochrome au thème marchand");
  } finally { await r.unmount(); }
});

test("2. TikTok : rendu seulement si l'URL existe, href exact, nom accessible, couleurs de marque", async () => {
  const none = await renderHeader({ instagram_url: IG });
  assert.equal(none.container.querySelector('a[aria-label="TikTok"]'), null, "aucune icône TikTok sans URL");
  await none.unmount();

  const r = await renderHeader({ tiktok_url: TT });
  try {
    const a = r.container.querySelector<HTMLAnchorElement>('a[aria-label="TikTok"]');
    assert.ok(a);
    assert.equal(a!.getAttribute("href"), TT);
    assert.equal(a!.getAttribute("target"), "_blank");
    assert.equal(a!.getAttribute("rel"), "noopener noreferrer");
    assert.equal(a!.getAttribute("data-social-brand"), "tiktok");
    const fills = [...a!.querySelectorAll("svg path")].map((p) => p.getAttribute("fill")!.toUpperCase());
    assert.deepEqual(fills, ["#25F4EE", "#FE2C55", "#FFFFFF"], "échos cyan/rouge puis note blanche (lisible sur fond noir)");
  } finally { await r.unmount(); }
});

test("3. comportement des URL sociales inchangé : aucune ligne sans URL, Facebook inchangé, deux instances = ids distincts", async () => {
  const empty = await renderHeader({});
  assert.equal(empty.container.querySelectorAll('header a[aria-label="Instagram"], header a[aria-label="TikTok"], header a[aria-label="Facebook"]').length, 0);
  await empty.unmount();

  const r = await renderHeader({ instagram_url: IG, tiktok_url: TT, facebook_url: FB });
  const r2 = await renderHeader({ instagram_url: IG });
  try {
    const labels = [...r.container.querySelectorAll("header a[aria-label]")].map((a) => a.getAttribute("aria-label"));
    assert.deepEqual(labels.filter((l) => ["Instagram", "TikTok", "Facebook"].includes(l!)), ["Instagram", "TikTok", "Facebook"], "ordre conservé");
    const fb = r.container.querySelector<HTMLAnchorElement>('a[aria-label="Facebook"]')!;
    assert.equal(fb.getAttribute("href"), FB);
    assert.equal(fb.className, "text-ink-text", "Facebook garde sa classe et son glyphe monochrome");
    assert.equal(fb.querySelector("svg")!.getAttribute("fill"), "currentColor");
    const id1 = r.container.querySelector("radialGradient")!.getAttribute("id");
    const id2 = r2.container.querySelector("radialGradient")!.getAttribute("id");
    assert.notEqual(id1, id2, "identifiant de dégradé unique par instance");
  } finally { await r.unmount(); await r2.unmount(); }
});

// ------------------------------------------------------------------ 4
function rule(overrides: Record<string, unknown> = {}) {
  return {
    fulfillmentCode: "secret-routing", zonePrefixes: ["75", "92"], isFallback: false, minItems: null,
    customerText: "Livraison à votre adresse.", customerTextHash: null, translations: null, displayOrder: 1,
    pricingMode: "fixed", fixedFee: 6.9, freeThreshold: null,
    discountEnabled: false, discountThreshold: null, discountPercentage: null, ...overrides,
  };
}

function withI18n(child: any) {
  return React.createElement(mod.I18nProvider, { lang: "fr", sourceLanguage: "fr" }, child);
}

async function openConditions(rules: unknown[]) {
  const r = await mount(withI18n(React.createElement(mod.DeliveryConditionsButton, { rules, currency: "EUR" })));
  const button = r.container.querySelector("button")!;
  await act(async () => { button.click(); });
  const dialog = r.container.querySelector<HTMLDialogElement>('dialog[data-delivery-dialog="conditions"]')!;
  return { ...r, dialog };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("4a. cartouche conditions : une ligne « zone — tarif », frais unique issu de computeDeliveryFee, aucun provider", async () => {
  const rules = [
    rule(),
    rule({ fulfillmentCode: "fallback-code", zonePrefixes: [], isFallback: true, displayOrder: 9, customerText: null,
      pricingMode: "free_above_threshold", fixedFee: 18.9, freeThreshold: 150, minItems: 3 }),
  ];
  const r = await openConditions(rules);
  try {
    const text = r.dialog.textContent!;
    assert.doesNotMatch(text, /secret-routing|fallback-code|internal|chronofresh|stuart|other_external/i, "aucun code ni prestataire");
    const cards = [...r.dialog.querySelectorAll("[data-delivery-rule-card]")];
    assert.equal(cards.length, 2);
    for (const [i, rl] of rules.entries()) {
      const fee = mod.formatPrice(mod.computeDeliveryFee({ ...rl, discountEnabled: false }, 0), "EUR");
      assert.equal(count(cards[i].textContent!, fee), 1, `frais ${fee} affiché une seule fois`);
      assert.ok(cards[i].querySelector("h3")!.textContent!.endsWith(`— ${fee}`), "ligne principale zone — tarif");
    }
    assert.equal(cards[0].querySelector("h3")!.textContent, `Codes postaux 75, 92 — ${mod.formatPrice(6.9, "EUR")}`);
    assert.equal(cards[1].querySelector("h3")!.textContent, `Autres codes postaux — ${mod.formatPrice(18.9, "EUR")}`);
    assert.equal(cards[1].querySelector("[data-delivery-rule-conditions]")!.textContent,
      `Offerte dès ${mod.formatPrice(150, "EUR")} · Min. 3 articles`);
    assert.doesNotMatch(text, /%/, "aucune remise affichée quand discountEnabled=false");
    assert.match(text, /Livraison à votre adresse\./, "le texte marchand est conservé");
    assert.equal(count(text, "Tarif de base"), 0, "plus de libellé redondant");
  } finally { await r.unmount(); }
});

test("4b. cartouche conditions : la remise ne vient que des faits publics activés (aucune valeur codée en dur)", async () => {
  const r = await openConditions([rule({ discountEnabled: true, discountThreshold: 120, discountPercentage: 37.5 })]);
  try {
    const conditions = r.dialog.querySelector("[data-delivery-rule-conditions]")!.textContent!;
    assert.equal(conditions, `−37.5 % dès ${mod.formatPrice(120, "EUR")}`);
    assert.equal(count(r.dialog.textContent!, mod.formatPrice(6.9, "EUR")), 1, "tarif de base non dupliqué");
  } finally { await r.unmount(); }
  const disabledWithValues = await openConditions([rule({ discountEnabled: false, discountThreshold: 120, discountPercentage: 37.5 })]);
  try {
    assert.doesNotMatch(disabledWithValues.dialog.textContent!, /%|37/, "valeurs conservées mais politique désactivée : rien affiché");
  } finally { await disabledWithValues.unmount(); }
});

test("4c. cartouche conditions : tarif indisponible -> texte d'indisponibilité, jamais 0 €", async () => {
  const r = await openConditions([rule({ pricingMode: "fixed", fixedFee: null })]);
  try {
    const text = r.dialog.textContent!;
    assert.match(text, /Tarif de livraison indisponible/);
    assert.ok(!text.includes(mod.formatPrice(0, "EUR")), "aucun repli à 0 €");
    assert.equal(r.dialog.querySelector("h3")!.textContent, "Codes postaux 75, 92");
  } finally { await r.unmount(); }
});

async function postcodeDialog(status: Record<string, unknown>, subtotal = 50) {
  const r = await mount(withI18n(React.createElement(mod.DeliveryPostcodeResult, {
    active: true, contextKey: "k", postcode: "75013", subtotal, currency: "EUR",
    status: { eligible: true, block: null, missing: null, customerNotice: null, customerNoticeHash: null, customerNoticeTranslations: null, discountPolicy: null, ...status },
  })));
  await act(async () => { await new Promise((res) => setTimeout(res, 400)); });
  const dialog = r.container.querySelector<HTMLDialogElement>('dialog[data-delivery-dialog="postcode"]')!;
  assert.ok(dialog.hasAttribute("open"), "le résultat s'ouvre");
  return { ...r, dialog };
}

test("4d. résultat code postal : une ligne « Disponible — frais », frais = status.deliveryFee, une seule fois", async () => {
  const r = await postcodeDialog({ deliveryFee: 18.9, pricingUnavailable: false, customerNotice: "Livraison à votre adresse." });
  try {
    const text = r.dialog.textContent!;
    const fee = mod.formatPrice(18.9, "EUR");
    assert.equal(count(text, fee), 1);
    assert.ok(text.includes(`Disponible — ${fee}`));
    assert.doesNotMatch(text, /Frais de livraison :|Livraison disponible/, "plus de double ligne disponibilité + frais");
    assert.doesNotMatch(text, /%/, "aucune remise sans politique");
  } finally { await r.unmount(); }
});

test("4e. résultat code postal : tarif indisponible ou inconnu -> jamais 0 €", async () => {
  const unavailable = await postcodeDialog({ deliveryFee: undefined, pricingUnavailable: true });
  try {
    assert.match(unavailable.dialog.textContent!, /Tarif de livraison indisponible/);
    assert.ok(!unavailable.dialog.textContent!.includes(mod.formatPrice(0, "EUR")));
  } finally { await unavailable.unmount(); }
  const legacy = await postcodeDialog({ deliveryFee: undefined, pricingUnavailable: false });
  try {
    assert.match(legacy.dialog.textContent!, /Livraison disponible/);
    assert.doesNotMatch(legacy.dialog.textContent!, /€/, "parcours historique : aucun montant inventé");
  } finally { await legacy.unmount(); }
});

test("4f. résultat code postal : remise affichée seulement si la politique publique est activée", async () => {
  const off = await postcodeDialog({ deliveryFee: 18.9, pricingUnavailable: false,
    discountPolicy: { discountEnabled: false, discountThreshold: 100, discountPercentage: 50 } }, 120);
  try { assert.doesNotMatch(off.dialog.textContent!, /%/); } finally { await off.unmount(); }
  const on = await postcodeDialog({ deliveryFee: 9.45, pricingUnavailable: false,
    discountPolicy: { discountEnabled: true, discountThreshold: 100, discountPercentage: 50 } }, 120);
  try {
    assert.match(on.dialog.textContent!, new RegExp(`−50 % appliqué \\(dès ${mod.formatPrice(100, "EUR").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
    assert.equal(count(on.dialog.textContent!, mod.formatPrice(9.45, "EUR")), 1);
  } finally { await on.unmount(); }
});

// ------------------------------------------------------------------ 5
function collectionButtons(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("nav[data-customer-collections-nav] button")];
}
function categoryButtons(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("[data-category-navigation] button")];
}

test("5. navigation : catégories et collections fonctionnelles, état sélectionné, pas de « Tout le catalogue », rangée défilable", async () => {
  const r = await mount(React.createElement(mod.MenuView, { restaurant: restaurant({}, {
    collections: [{ id: "t1", label: "Nouveautés", displayOrder: 1, menuItemIds: ["i2"] }],
  }) }));
  try {
    const ul = r.container.querySelector("nav[data-customer-collections-nav] ul")!;
    for (const cls of ["flex", "flex-nowrap", "overflow-x-auto"]) assert.ok(ul.classList.contains(cls), `rangée mobile ${cls}`);
    assert.equal(collectionButtons(r.container).some((b) => b.getAttribute("data-customer-collection-option") === "__catalogue__"), false);
    assert.deepEqual(categoryButtons(r.container).map((b) => b.getAttribute("aria-pressed")), ["true", "false"]);
    await act(async () => { categoryButtons(r.container)[1].click(); });
    assert.deepEqual(categoryButtons(r.container).map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
    assert.equal(r.container.querySelector("main section h2")!.textContent!.trim().toLowerCase(), "crèmerie & beurres de baratte");
    await act(async () => { collectionButtons(r.container)[0].click(); });
    assert.equal(collectionButtons(r.container)[0].getAttribute("aria-pressed"), "true");
    assert.ok(r.container.querySelector("[data-customer-collection-view]"), "vue collection affichée");
    for (const b of categoryButtons(r.container)) assert.ok(b.classList.contains("min-h-11"), "cible tactile conservée");
  } finally { await r.unmount(); }
});

test("5b. sans collection : aucun wrapper vide avant les catégories", async () => {
  const r = await mount(React.createElement(mod.MenuView, { restaurant: restaurant() }));
  try {
    assert.equal(r.container.querySelector("nav[data-customer-collections-nav]"), null);
    const catWrapper = r.container.querySelector("[data-category-navigation]")!.parentElement!;
    assert.equal(catWrapper.className, "mt-3");
    const prev = catWrapper.previousElementSibling;
    assert.ok(!prev || prev.childElementCount > 0 || (prev.textContent ?? "").trim() !== "", "aucun div vide juste avant la navigation");
  } finally { await r.unmount(); }
});
