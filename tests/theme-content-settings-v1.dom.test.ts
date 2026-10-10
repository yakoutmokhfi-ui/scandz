import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// THEME & CONTENT SETTINGS v1 -- preuves DOM de la VITRINE.
//
//   BL   : sans configuration, le rendu est IDENTIQUE à celui de main
//          (empreinte capturée sur la baseline 412dbb5, voir
//          tests/fixtures/theme-content-settings-v1/baseline-noconfig.json).
//   TOK  : un jeton configuré est posé sur la BONNE surface (et seulement
//          celle-là) ; une configuration invalide/hostile est ignorée.
//   ISO  : la configuration d'un établissement A ne fuit pas vers B
//          (démontage ET changement de prop sur la même racine).
//   HELP : bouton « comment commander » -- libellé, titre, contenu
//          surchargés ; contenu hostile rendu comme TEXTE ; isolation.
//   FORM : champs de couleur du back-office (validation, réinitialisation).
//
// MODE CAPTURE (THEME_BASELINE_CAPTURE=<fichier>) : n'exécute QUE le
// scénario BL et écrit l'empreinte. Il est lancé sur un checkout de
// main (412dbb5) -- jamais sur la branche -- pour que l'empreinte soit
// celle de l'ANCIEN rendu et non une copie du nouveau.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const CAPTURE = process.env.THEME_BASELINE_CAPTURE ?? "";
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "theme-content-settings-v1", "baseline-noconfig.json");

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
window.HTMLDialogElement.prototype.close = function () {
  const was = this.hasAttribute("open");
  this.removeAttribute("open");
  if (was) this.dispatchEvent(new window.Event("close"));
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { supabase } = await import("../lib/supabase.ts");

const REPO_ROOT = process.cwd();
const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const resolved = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p)) ?? base;
      // lib/supabase.ts reste le module RÉEL du test (mocké par t.mock.method).
      if (resolved.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolved).href, external: true };
      }
      return { path: resolved };
    });
  },
};

async function bundle(entry: string, tag: string) {
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: REPO_ROOT, loader: "tsx" },
    bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022",
    plugins: [aliasPlugin], external: ["react", "react-dom", "react-dom/client"],
  });
  const dir = mkdtempSync(path.join(REPO_ROOT, "tests", `tmp-dom-${tag}-`));
  const file = path.join(dir, "entry.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  const m = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return m;
}

// Modules qui EXISTENT sur main : seuls ceux-là sont chargés en mode capture.
const core: any = await bundle(`
export { default as MenuView } from "@/components/MenuView";
export { DeliveryConditionsButton } from "@/components/DeliveryConditions";
export { I18nProvider } from "@/lib/i18n-context";
`, "core");
// Modules NOUVEAUX de ce lot : absents de main, donc jamais chargés en capture.
const theme: any = CAPTURE ? null : await bundle(`
export { default as OrderHelpButton } from "@/components/OrderHelpButton";
export { default as ThemeTokensFields, emptyThemeTokenInputs } from "@/components/dashboard/ThemeTokensFields";
export * from "@/lib/theme-tokens";
export { sanitizeCommunicationTextOverrides } from "@/lib/communications/text-keys";
`, "theme");

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
const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const settle = () => act(async () => { await flush(40); });

async function mount(element: unknown) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element as any); });
  return {
    container,
    async rerender(next: unknown) { await act(async () => { root.render(next as any); }); },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

// ------------------------------------------------------------- RPC factice
// Projection publique des textes, INDEXÉE PAR p_restaurant_id (c'est ce qui
// porte l'isolation multi-tenant côté serveur) ; tout autre RPC : vide.
type TextRows = Record<string, Array<{ text_key: string; body: string }>>;
let TEXTS_BY_RESTAURANT: TextRows = {};
let TEXT_CALLS: string[] = [];

function installSupabaseMock(t: { mock: { method: Function } }) {
  TEXT_CALLS = [];
  const chain: any = new Proxy(function () {}, {
    get: (_, p) => (p === "then" ? (res: any) => res({ data: [], error: null }) : () => chain),
    apply: () => chain,
  });
  t.mock.method(supabase, "from", () => chain);
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_communication_texts") {
      TEXT_CALLS.push(args?.p_restaurant_id);
      return { data: TEXTS_BY_RESTAURANT[args?.p_restaurant_id] ?? [], error: null };
    }
    return { data: [], error: null };
  });
}

// ----------------------------------------------------------------- fixtures
function restaurant(id: string, config: Record<string, unknown> = {}) {
  return {
    id, name: "Établissement " + id, slug: "slug-" + id, is_active: true, created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: id, max_tables: 10, currency: "EUR", whatsapp_number: "+33600000000",
      address: "12 rue du Fromage, 75001 Paris", latitude: null, longitude: null, logo_url: null, cover_url: null,
      opening_hours: "Lundi 09:00 – 19:00\nMardi 09:00 – 19:00", maps_url: null, source_language: "fr", ...config,
    },
    categories: [
      { id: "c1", restaurant_id: id, name: "Fromages", display_order: 1, is_active: true,
        menu_items: [{ id: "i1", category_id: "c1", name: "Comté", description: "Affiné 18 mois, lait cru.", price: 8.9, image_url: null, display_order: 1, is_available: true }] },
    ],
    hiddenCategories: [],
    activeLanguages: [{ language_code: "fr", display_order: 0 }],
  };
}
const menuView = (r: any) => React.createElement(core.MenuView, { restaurant: r });

const RULES = [
  { fulfillmentCode: "x", zonePrefixes: ["75"], isFallback: false, minItems: null, customerText: "Livraison.", customerTextHash: null,
    translations: null, displayOrder: 1, pricingMode: "fixed", fixedFee: 6.9, freeThreshold: null, discountEnabled: false,
    discountThreshold: null, discountPercentage: null },
  { fulfillmentCode: "y", zonePrefixes: [], isFallback: true, minItems: 2, customerText: null, customerTextHash: null,
    translations: null, displayOrder: 2, pricingMode: "fixed", fixedFee: 9.5, freeThreshold: 80, discountEnabled: false,
    discountThreshold: null, discountPercentage: null },
];
const withI18n = (child: any) => React.createElement(core.I18nProvider, { lang: "fr", sourceLanguage: "fr" }, child);

/** Normalisation de comparaison : (1) retire UNIQUEMENT l'attribut inerte
 *  `data-sc-surface` ajouté par ce lot ; (2) renumérote les identifiants
 *  useId par ordre d'apparition (le compteur est global au processus). */
function normalize(html: string): string {
  const noAttr = html.replace(/ data-sc-surface="[a-z-]+"/g, "");
  const ids = new Map<string, string>();
  return noAttr.replace(/:r[0-9a-v]+:/g, (m) => {
    if (!ids.has(m)) ids.set(m, `:id${ids.size}:`);
    return ids.get(m)!;
  });
}

async function captureNoConfig(t: { mock: { method: Function } }) {
  TEXTS_BY_RESTAURANT = {};
  installSupabaseMock(t);
  const menu = await mount(menuView(restaurant("r-bl")));
  await settle();
  const menuHtml = normalize(menu.container.innerHTML);
  await menu.unmount();
  const del = await mount(withI18n(React.createElement(core.DeliveryConditionsButton, { rules: RULES, currency: "EUR" })));
  const deliveryHtml = normalize(del.container.innerHTML);
  await del.unmount();
  return { menuHtml, deliveryHtml };
}

// =========================================================== BL (baseline)
test("[BL-1] sans configuration, le rendu est IDENTIQUE à celui de main (empreinte 412dbb5)", async (t) => {
  const now = await captureNoConfig(t);
  if (CAPTURE) {
    mkdirSync(path.dirname(CAPTURE), { recursive: true });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
    writeFileSync(CAPTURE, JSON.stringify({
      provenance: {
        capturedAtCommit: sha,
        how: "THEME_BASELINE_CAPTURE=<file> node --experimental-strip-types --import ./tests/register.mjs --test tests/theme-content-settings-v1.dom.test.ts, exécuté sur un checkout de main (aucun fichier de ce lot présent)",
        normalization: "retire l'attribut inerte data-sc-surface=\"…\" ; renumérote les identifiants useId",
      },
      ...now,
    }, null, 2) + "\n");
    return;
  }
  const baseline = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(baseline.provenance.capturedAtCommit, "412dbb53c5f180983860852b79425209c04b9c42", "empreinte capturée sur la baseline");
  assert.equal(now.menuHtml, baseline.menuHtml, "MenuView sans configuration : balisage identique à main");
  assert.equal(now.deliveryHtml, baseline.deliveryHtml, "cartouche livraison sans configuration : balisage identique à main");
});

const itCand = CAPTURE ? test.skip : test;

itCand("[BL-2] sans configuration : aucun attribut data-sc-themed, aucune variable de surface, aucun bouton d'aide", async (t) => {
  TEXTS_BY_RESTAURANT = {};
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-bl2")));
  await settle();
  try {
    const root = m.container.querySelector<HTMLElement>("[data-sc-themed], .min-h-screen") ;
    assert.equal(m.container.querySelector("[data-sc-themed]"), null);
    const styled = [...m.container.querySelectorAll<HTMLElement>("[style]")].map((e) => e.getAttribute("style") ?? "").join(";");
    assert.ok(!/--sc-(info-panel|popup|delivery-card|surface-border)/.test(styled), "aucune variable de surface");
    assert.equal(m.container.querySelector("[data-order-help]"), null);
    assert.ok(root !== undefined);
  } finally { await m.unmount(); }
});

// ================================================================== TOK
const FULL = {
  info_panel_bg: "#ffffff", info_panel_text: "#111111",
  popup_bg: "#FFFFFF", popup_text: "#000000",
  delivery_card_bg: "#FFFFFF", delivery_card_text: "#000000",
  surface_border: "#C9A24B",
};
function themedRoot(c: Element): HTMLElement | null { return c.querySelector<HTMLElement>("[data-sc-themed]"); }
function styleOf(el: HTMLElement | null): string { return el?.getAttribute("style") ?? ""; }

itCand("[TOK-1] configuration complète : attribut + variables sur le conteneur, valeurs normalisées", async (t) => {
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-tok1", { theme_tokens: FULL })));
  await settle();
  try {
    const root = themedRoot(m.container)!;
    assert.ok(root, "conteneur thémé");
    assert.deepEqual(new Set(root.getAttribute("data-sc-themed")!.split(" ")), new Set(["info-panel", "popup", "delivery-card", "border"]));
    const s = styleOf(root);
    assert.match(s, /--sc-info-panel-bg:\s*#FFFFFF/i);          // normalisé en majuscules
    assert.match(s, /--sc-info-panel-text:\s*#111111/i);
    assert.match(s, /--sc-popup-bg:\s*#FFFFFF/i);
    assert.match(s, /--sc-delivery-card-text:\s*#000000/i);
    assert.match(s, /--sc-surface-border:\s*#C9A24B/i);
    assert.match(s, /--sc-info-panel-link:/);
    assert.ok(!/--sc-info-panel-text-muted/.test(s), "surface encre : pas de texte secondaire");
    assert.match(s, /--sc-popup-text-muted:/);
    assert.match(s, /--sc-popup-link:/);
    // Les couleurs HISTORIQUES du thème sont toujours posées (accent/or préservés).
    assert.match(s, /--sc-accent/);
    assert.match(s, /--sc-bg/);
  } finally { await m.unmount(); }
});

itCand("[TOK-2] le panneau adresse/horaires porte la surface info-panel, la fiche produit la surface popup", async (t) => {
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-tok2", { theme_tokens: FULL })));
  await settle();
  try {
    const panel = m.container.querySelector('[data-sc-surface="info-panel"]')!;
    assert.ok(panel, "panneau d'infos");
    assert.match(panel.textContent!, /12 rue du Fromage/);
    assert.match(panel.textContent!, /Lundi 09:00/);
    const popup = m.container.querySelector('dialog[data-sc-surface="popup"]')!;
    assert.ok(popup, "fenêtre d'information produit");
    assert.match(popup.textContent!, /Affiné 18 mois/);
    // Une seule surface info-panel (pas de duplication de thème).
    assert.equal(m.container.querySelectorAll('[data-sc-surface="info-panel"]').length, 1);
  } finally { await m.unmount(); }
});

itCand("[TOK-3] les cartes de tarifs de livraison portent la surface delivery-card (une par règle), pas la fenêtre", async () => {
  const m = await mount(withI18n(React.createElement(core.DeliveryConditionsButton, { rules: RULES, currency: "EUR" })));
  try {
    const cards = [...m.container.querySelectorAll('[data-delivery-rule-card]')];
    assert.equal(cards.length, 2);
    for (const c of cards) assert.equal(c.getAttribute("data-sc-surface"), "delivery-card");
    const dlg = m.container.querySelector('dialog[data-delivery-dialog="conditions"]')!;
    assert.equal(dlg.getAttribute("data-sc-surface"), null, "la fenêtre englobante garde le thème (seules les cartes internes sont ciblées)");
  } finally { await m.unmount(); }
});

itCand("[TOK-4] configuration PARTIELLE : seule la surface configurée est activée", async (t) => {
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-tok4", { theme_tokens: { popup_bg: "#FFFFFF", popup_text: "#000000" } })));
  await settle();
  try {
    const root = themedRoot(m.container)!;
    assert.equal(root.getAttribute("data-sc-themed"), "popup");
    const s = styleOf(root);
    assert.match(s, /--sc-popup-bg/);
    assert.ok(!/--sc-info-panel|--sc-delivery-card|--sc-surface-border/.test(s));
  } finally { await m.unmount(); }
});

itCand("[TOK-5] bordure seule : activée sans activer de surface de couleur", async (t) => {
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-tok5", { theme_tokens: { surface_border: "#123456" } })));
  await settle();
  try {
    const root = themedRoot(m.container)!;
    assert.equal(root.getAttribute("data-sc-themed"), "border");
    assert.match(styleOf(root), /--sc-surface-border:\s*#123456/i);
  } finally { await m.unmount(); }
});

const HOSTILE: Array<[string, unknown]> = [
  ["couleur nommée", { popup_bg: "white", popup_text: "black" }],
  ["fonction CSS / url()", { popup_bg: "url(javascript:alert(1))", popup_text: "#000000" }],
  ["injection de déclaration", { popup_bg: "#FFFFFF;background:url(x)", popup_text: "#000000" }],
  ["expression()", { popup_bg: "expression(alert(1))", popup_text: "#000000" }],
  ["#RGB court", { popup_bg: "#FFF", popup_text: "#000" }],
  ["#RRGGBBAA", { popup_bg: "#FFFFFFFF", popup_text: "#000000" }],
  ["paire incomplète", { popup_bg: "#FFFFFF" }],
  ["contraste insuffisant", { popup_bg: "#777777", popup_text: "#7A7A7A" }],
  ["clé inconnue seule", { custom_css: "body{display:none}" }],
  ["balise style", { popup_bg: "<style>*{display:none}</style>", popup_text: "#000000" }],
  ["tableau", ["#FFFFFF"]],
  ["chaîne", "popup_bg:#FFFFFF"],
  ["nombre", 42],
  ["null", null],
  ["objet vide", {}],
];
for (const [label, value] of HOSTILE) {
  itCand(`[TOK-6] configuration invalide ou hostile ignorée (${label}) : rendu identique à « sans configuration »`, async (t) => {
    installSupabaseMock(t);
    const ref = await mount(menuView(restaurant("r-tok6")));
    await settle();
    const refRoot = ref.container.querySelector<HTMLElement>(".sc-template-editorial, [dir]")!;
    const refStyle = styleOf(refRoot);
    await ref.unmount();

    const m = await mount(menuView(restaurant("r-tok6", { theme_tokens: value })));
    await settle();
    try {
      assert.equal(m.container.querySelector("[data-sc-themed]"), null, "aucun attribut de thème");
      const all = [...m.container.querySelectorAll("[style]")].map((e) => e.getAttribute("style")).join(";");
      assert.ok(!/--sc-(info-panel|popup|delivery-card|surface-border)/.test(all));
      assert.ok(!/javascript:|expression\(|<style|display:\s*none/i.test(m.container.innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "")), "rien de dangereux dans le balisage");
      assert.equal(styleOf(m.container.querySelector<HTMLElement>(".sc-template-editorial, [dir]")), refStyle, "styles du conteneur identiques");
    } finally { await m.unmount(); }
  });
}

// ================================================================== ISO
itCand("[ISO-1] la configuration de A ne fuit pas vers B (démontage puis nouveau montage)", async (t) => {
  installSupabaseMock(t);
  const a = await mount(menuView(restaurant("r-A", { theme_tokens: FULL })));
  await settle();
  assert.ok(themedRoot(a.container));
  await a.unmount();
  const b = await mount(menuView(restaurant("r-B")));
  await settle();
  try {
    assert.equal(b.container.querySelector("[data-sc-themed]"), null);
    assert.equal(window.document.querySelector("[data-sc-themed]"), null, "aucune trace dans le document");
    assert.ok(!/--sc-(info-panel|popup)/.test(window.document.documentElement.getAttribute("style") ?? ""));
    assert.ok(!/--sc-(info-panel|popup)/.test(window.document.body.getAttribute("style") ?? ""));
  } finally { await b.unmount(); }
});

itCand("[ISO-2] changement d'établissement sur la MÊME racine : les jetons de A disparaissent, ceux de B s'appliquent", async (t) => {
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-A2", { theme_tokens: FULL })));
  await settle();
  try {
    assert.match(styleOf(themedRoot(m.container)), /--sc-popup-bg:\s*#FFFFFF/i);
    await m.rerender(menuView(restaurant("r-B2")));
    await settle();
    assert.equal(m.container.querySelector("[data-sc-themed]"), null, "plus de jeton de A");
    await m.rerender(menuView(restaurant("r-C2", { theme_tokens: { popup_bg: "#101010", popup_text: "#F5F5F5" } })));
    await settle();
    const s = styleOf(themedRoot(m.container));
    assert.match(s, /--sc-popup-bg:\s*#101010/i);
    assert.ok(!/--sc-info-panel|--sc-surface-border/.test(s), "rien de A ne subsiste");
  } finally { await m.unmount(); }
});

// ================================================================= HELP
const LABEL = { text_key: "order_help_button_label", body: "Comment passer commande ?" };
const TITLE = { text_key: "order_help_title", body: "Passer commande en 3 étapes" };
const BODY = { text_key: "order_help_body", body: "1. Choisissez vos produits\n2. Validez le panier\n3. Payez ou confirmez" };

itCand("[HELP-1] libellé + contenu configurés : le bouton apparaît avec le libellé exact ; le titre et le contenu s'affichent à l'ouverture", async (t) => {
  TEXTS_BY_RESTAURANT = { "r-h1": [LABEL, TITLE, BODY] };
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-h1")));
  await settle();
  try {
    const wrap = m.container.querySelector("[data-order-help]")!;
    assert.ok(wrap, "bloc d'aide");
    const btn = wrap.querySelector("button")!;
    assert.equal(btn.textContent!.trim(), "Comment passer commande ?");
    assert.equal(btn.getAttribute("aria-haspopup"), "dialog");
    const dlg = wrap.querySelector<HTMLDialogElement>("dialog")!;
    assert.equal(dlg.hasAttribute("open"), false, "fermé au repos");
    await act(async () => { btn.click(); });
    assert.equal(dlg.hasAttribute("open"), true);
    assert.equal(dlg.querySelector("h2")!.textContent, "Passer commande en 3 étapes");
    const body = dlg.querySelector("[data-order-help-body]")!;
    assert.equal(body.textContent, "1. Choisissez vos produits\n2. Validez le panier\n3. Payez ou confirmez");
    assert.ok(body.classList.contains("whitespace-pre-line"), "retours à la ligne conservés");
    assert.equal(dlg.getAttribute("data-sc-surface"), "popup", "surface popup (configurable)");
    assert.equal(dlg.getAttribute("aria-labelledby"), dlg.querySelector("h2")!.id);
    // Fermeture par le bouton Fermer.
    const close = [...dlg.querySelectorAll("button")].pop()!;
    await act(async () => { close.click(); });
    assert.equal(dlg.hasAttribute("open"), false);
  } finally { await m.unmount(); }
});

itCand("[HELP-2] titre absent : le titre de la fenêtre retombe sur le libellé du bouton", async (t) => {
  TEXTS_BY_RESTAURANT = { "r-h2": [LABEL, BODY] };
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-h2")));
  await settle();
  try {
    assert.equal(m.container.querySelector("[data-order-help] dialog h2")!.textContent, "Comment passer commande ?");
  } finally { await m.unmount(); }
});

itCand("[HELP-3] libellé SEUL ou contenu SEUL : aucun bouton (jamais de bouton vide ni de fenêtre vide)", async (t) => {
  for (const rows of [[LABEL], [BODY], [TITLE], [LABEL, TITLE], [BODY, TITLE]]) {
    TEXTS_BY_RESTAURANT = { "r-h3": rows };
    installSupabaseMock(t);
    const m = await mount(menuView(restaurant("r-h3")));
    await settle();
    try { assert.equal(m.container.querySelector("[data-order-help]"), null, JSON.stringify(rows.map((r) => r.text_key))); }
    finally { await m.unmount(); }
    (supabase.rpc as any).mock.restore();
    (supabase.from as any).mock.restore();
  }
});

itCand("[HELP-4] contenu HOSTILE rendu comme TEXTE : aucun élément interprété, aucun script", async (t) => {
  const hostile = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"><b>gras</b> <a href="javascript:alert(1)">x</a>';
  TEXTS_BY_RESTAURANT = { "r-h4": [
    { text_key: "order_help_button_label", body: "<b>Aide</b>" },
    { text_key: "order_help_title", body: "<i>Titre</i>" },
    { text_key: "order_help_body", body: hostile },
  ] };
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-h4")));
  await settle();
  try {
    const wrap = m.container.querySelector("[data-order-help]")!;
    assert.equal(wrap.querySelector("button")!.textContent, "<b>Aide</b>");
    const dlg = wrap.querySelector("dialog")!;
    assert.equal(dlg.querySelector("h2")!.textContent, "<i>Titre</i>");
    assert.equal(dlg.querySelector("[data-order-help-body]")!.textContent, hostile, "affiché littéralement");
    assert.equal(wrap.querySelectorAll("script, img, b, i, a, style").length, 0, "aucun élément injecté");
    assert.equal((window as any).__pwned, undefined, "aucun code exécuté");
    assert.ok(!/<script/i.test(dlg.innerHTML.replace(/&lt;script/g, "")), "le HTML est échappé");
  } finally { await m.unmount(); }
});

itCand("[HELP-5] isolation : le texte de A n'apparaît pas chez B ; la lecture est faite PAR établissement", async (t) => {
  TEXTS_BY_RESTAURANT = { "r-hA": [LABEL, BODY] };       // B n'a rien
  installSupabaseMock(t);
  const a = await mount(menuView(restaurant("r-hA")));
  await settle();
  assert.ok(a.container.querySelector("[data-order-help]"));
  await a.unmount();
  const b = await mount(menuView(restaurant("r-hB")));
  await settle();
  try {
    assert.equal(b.container.querySelector("[data-order-help]"), null);
    assert.ok(!/Comment passer commande/.test(b.container.innerHTML));
    assert.deepEqual(TEXT_CALLS, ["r-hA", "r-hB"], "un appel par établissement, avec SON identifiant");
  } finally { await b.unmount(); }
});

itCand("[HELP-6] changement d'établissement sur la même racine : le bouton de A disparaît immédiatement chez B", async (t) => {
  TEXTS_BY_RESTAURANT = { "r-hA6": [LABEL, BODY] };
  installSupabaseMock(t);
  const m = await mount(menuView(restaurant("r-hA6")));
  await settle();
  try {
    assert.ok(m.container.querySelector("[data-order-help]"));
    await m.rerender(menuView(restaurant("r-hB6")));
    await settle();
    assert.equal(m.container.querySelector("[data-order-help]"), null);
  } finally { await m.unmount(); }
});

itCand("[HELP-7] lecture des textes en échec : aucun bouton, la vitrine continue de s'afficher", async (t) => {
  installSupabaseMock(t);
  (supabase.rpc as any).mock.restore();
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_restaurant_public_communication_texts") return { data: null, error: { message: "boom" } };
    return { data: [], error: null };
  });
  const m = await mount(menuView(restaurant("r-h7")));
  await settle();
  try {
    assert.equal(m.container.querySelector("[data-order-help]"), null);
    assert.match(m.container.textContent!, /Comté/);
  } finally { await m.unmount(); }
});

itCand("[HELP-8] libellé au-delà de 60 caractères ou titre au-delà de 120 : valeur rejetée (jamais tronquée)", async () => {
  const over = theme.sanitizeCommunicationTextOverrides([]) ;
  assert.deepEqual(over, {});
  const cleaned = theme.sanitizeCommunicationTextOverrides({
    order_help_button_label: "x".repeat(61),
    order_help_title: "y".repeat(121),
    order_help_body: "z".repeat(500),
  });
  assert.equal(cleaned.order_help_button_label, undefined);
  assert.equal(cleaned.order_help_title, undefined);
  assert.equal(cleaned.order_help_body, "z".repeat(500));
  const ok = theme.sanitizeCommunicationTextOverrides({ order_help_button_label: "x".repeat(60), order_help_title: "y".repeat(120) });
  assert.equal(ok.order_help_button_label!.length, 60);
  assert.equal(ok.order_help_title!.length, 120);
});

itCand("[HELP-9] OrderHelpButton direct : ni hook ni identifiant consommé quand rien n'est configuré", async () => {
  const m = await mount(withI18n(React.createElement(theme.OrderHelpButton, { communicationTexts: {} })));
  try { assert.equal(m.container.innerHTML, ""); } finally { await m.unmount(); }
  const n = await mount(withI18n(React.createElement(theme.OrderHelpButton, { communicationTexts: null })));
  try { assert.equal(n.container.innerHTML, ""); } finally { await n.unmount(); }
});

// ================================================================== FORM
const tId = (k: string) => k;
function renderFields(inputs: Record<string, string>, disabled = false) {
  const changes: Array<Record<string, string>> = [];
  const full = { ...theme.emptyThemeTokenInputs(), ...inputs };
  return mount(React.createElement(theme.ThemeTokensFields, { inputs: full, onChange: (n: any) => changes.push(n), disabled, t: tId })).then((m) => ({ ...m, changes }));
}

itCand("[FORM-1] état vide : aucun message d'erreur, bouton Réinitialiser désactivé, un champ #RRGGBB par jeton", async () => {
  const m = await renderFields({});
  try {
    assert.equal(m.container.querySelectorAll("[data-theme-token-field]").length, 7);
    assert.equal(m.container.querySelector("p.text-amber-700"), null);
    assert.equal(m.container.querySelector<HTMLButtonElement>("[data-theme-tokens-reset]")!.disabled, true);
    for (const i of m.container.querySelectorAll<HTMLInputElement>('input[maxlength="7"]')) assert.equal(i.placeholder, "#RRGGBB");
  } finally { await m.unmount(); }
});

itCand("[FORM-2] couleur invalide, paire incomplète et contraste insuffisant sont signalés par la MÊME validation que l'enregistrement", async () => {
  const bad = await renderFields({ popup_bg: "rouge", popup_text: "#000000" });
  assert.match(bad.container.querySelector('[data-theme-token-field="popup_bg"]')!.textContent!, /stColorInvalid/);
  await bad.unmount();
  const pair = await renderFields({ popup_bg: "#FFFFFF" });
  assert.match(pair.container.textContent!, /stThemeTokPairIncomplete/);
  await pair.unmount();
  const low = await renderFields({ popup_bg: "#777777", popup_text: "#7A7A7A" });
  assert.match(low.container.textContent!, /stThemeTokLowContrast/);
  await low.unmount();
  const ok = await renderFields({ popup_bg: "#FFFFFF", popup_text: "#000000" });
  assert.equal(ok.container.querySelector("p.text-amber-700"), null);
  assert.ok(ok.container.querySelector('[data-theme-token-surface="popup"] [aria-hidden="true"]'), "aperçu « Aa » pour une paire valide");
  await ok.unmount();
});

itCand("[FORM-3] Réinitialiser remet TOUS les jetons à vide (retour au thème par défaut) ; champs désactivés = aucun effet", async () => {
  const m = await renderFields({ popup_bg: "#FFFFFF", popup_text: "#000000", surface_border: "#C9A24B" });
  try {
    const reset = m.container.querySelector<HTMLButtonElement>("[data-theme-tokens-reset]")!;
    assert.equal(reset.disabled, false);
    await act(async () => { reset.click(); });
    assert.equal(m.changes.length, 1);
    assert.ok(Object.values(m.changes[0]).every((v) => v === ""), "tous vides");
    assert.equal(Object.keys(m.changes[0]).length, 7);
  } finally { await m.unmount(); }
  const off = await renderFields({ popup_bg: "#FFFFFF", popup_text: "#000000" }, true);
  try {
    assert.equal(off.container.querySelector<HTMLButtonElement>("[data-theme-tokens-reset]")!.disabled, true);
    for (const i of off.container.querySelectorAll<HTMLInputElement>("input")) assert.equal(i.disabled, true);
  } finally { await off.unmount(); }
});

itCand("[FORM-4] aucun champ libre : uniquement des sélecteurs de couleur et des champs #RRGGBB (7 caractères max)", async () => {
  const m = await renderFields({});
  try {
    assert.equal(m.container.querySelectorAll("textarea, select").length, 0);
    const types = [...m.container.querySelectorAll("input")].map((i) => i.getAttribute("type") ?? "text");
    assert.equal(types.filter((x) => x === "color").length, 7);
    for (const i of m.container.querySelectorAll<HTMLInputElement>('input:not([type="color"])')) assert.equal(i.maxLength, 7);
  } finally { await m.unmount(); }
});
