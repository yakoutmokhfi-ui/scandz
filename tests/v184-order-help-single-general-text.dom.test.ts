import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

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
const { supabase } = await import("../lib/supabase.ts");
const { ORDER_NOTE_MAX_LENGTH } = await import("../lib/order-note.ts");

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
      const resolvedPath = candidate ?? base;
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const entrySource = `
export { default as MenuView } from "@/components/MenuView";
export { default as OrderHelpButton } from "@/components/OrderHelpButton";
export { DeliveryConditionsButton } from "@/components/DeliveryConditions";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-uxlot-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView, OrderHelpButton, DeliveryConditionsButton, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

function inputById(container: Element, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}

function selectServiceMode(container: Element, label: string) {
  const btn = buttonWithText(container, label);
  assert.ok(btn, `le bouton de mode "${label}" doit être présent`);
  click(btn!);
}

/** Même fixture que tests/v101-fulfillment-routing-lot-c-menuview.dom.test.ts. */
function sanaaCookiesRestaurant(opts: { configOverride?: Record<string, unknown> } = {}) {
  return {
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
      ...(opts.configOverride ?? {}),
    },
    categories: [
      {
        id: "cat-1",
        restaurant_id: "r-sanaa-test",
        name: "Cookies",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: "item-1",
            category_id: "cat-1",
            name: "Cookie chocolat",
            description: null,
            short_description: null,
            price: 3.5,
            image_url: null,
            display_order: 1,
            is_available: true,
          },
        ],
      },
    ],
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];

// Deux modes publiés (pickup + delivery, même liste que v101) --
// délibéré : avec un SEUL mode disponible, MenuView.tsx le
// présélectionne automatiquement (voir handleSendOrder/closeConfirmation,
// `availableServiceModes.length === 1 ? ... : null`) et saute l'écran
// de sélection explicite, ce qui ferait échouer `selectServiceMode`
// (aucun bouton "À emporter" à cliquer). Deux modes forcent l'étape de
// sélection explicite, exactement comme le harnais MenuView déjà
// établi par v101.
const PICKUP_SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];

const PICKUP_REQS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
];

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

/** Sonde en profondeur (défense en profondeur, même style que
 *  tests/v122b-tracking-link.test.ts) : que le jeton n'apparaisse
 *  jamais dans le pathname/search d'un href de suivi trouvé dans le
 *  DOM, quel que soit son point d'origine. */
function mockRpc(
  t: { mock: { method: Function } },
  createOrderResult: { data: unknown; error: unknown }
) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: PICKUP_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      if (args.p_mode_code === "pickup") return { data: PICKUP_REQS, error: null };
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "create_order") return createOrderResult;
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    // MERCHANT CUSTOMER COMMUNICATIONS v1 -- projection PUBLIQUE des
    // textes clients du commercant, lue par MenuView au montage.
    // Servie VIDE : « aucun texte personnalise », qui est l'etat de
    // tout etablissement avant configuration -- donc exactement les
    // formulations plateforme que ces assertions verifiaient deja.
    // CSDJ-2 / #158 : lecture publique des dates/créneaux, servie « absent »
    // (aucun calendrier = parcours d'avant). Sans réponse VALIDE le checkout
    // ne laisse plus partir la commande (fail-closed) : le mock doit donc la servir.
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
    if (name === "get_restaurant_public_communication_texts") return { data: [], error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

async function renderFillPickupAndReachSubmit(opts: { configOverride?: Record<string, unknown> } = {}) {
  const restaurant = sanaaCookiesRestaurant(opts);
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();

  const addBtn = buttonWithText(container, "Ajouter");
  assert.ok(addBtn, "le bouton Ajouter doit être présent");
  click(addBtn!);
  await flush();

  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  if (cartBar) {
    click(cartBar);
    await flush();
  }

  selectServiceMode(container, "À emporter");
  await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");

  setNativeValue(inputById(container, "customer_name")!, "Yakout");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  await flush(50);
  await flush();

  const submitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
  assert.ok(submitBtn, "le bouton d'envoi doit être atteignable en mode pickup");
  return { container, root, submitBtn: submitBtn! };
}




// ====================================================================
// UX LOT 2026-10 (demande Emmanuel) -- CHECKOUT (boutique).
//
// Monte RÉELLEMENT MenuView (esbuild + jsdom), create_order intercepté
// au niveau supabase.rpc. Ce fichier prouve :
//   B. note pour le restaurant : masquée quand
//      restaurant_configs.order_note_enabled = false (aucun champ
//      #order-note, p_note null) ; rendue sinon (défaut inchangé) ;
//      audit Maxwell P2 : une valeur de note déjà en état (trop longue)
//      ne bloque JAMAIS l'envoi une fois le champ désactivé.
//   C. aide « comment commander » : à l'ouverture, le défilement est en
//      haut et le focus est sur le TITRE (jamais sur le bouton Fermer en
//      bas) -- la partie haute du texte est visible en premier.
// (La confirmation d'âge, présente au commit 34cc977, est RETIRÉE :
//  décision de périmètre du 27/10/2026.)
// ====================================================================

const CREATE_ORDER_OK = {
  data: [{ order_id: ORDER_ID, order_number: 42, public_token: TOKEN, total: 3.5, subtotal: 3.5, delivery_fee: 0 }],
  error: null,
};

function installFetchNotNeeded() {
  (globalThis as any).fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/payments/monetico/checkout")) {
      return new Response(JSON.stringify({ outcome: "checkout_not_needed", reason: "not_required" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/checkout/withdrawal-eligibility")) {
      return new Response(JSON.stringify({ eligible: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`requête sortante inattendue : ${url}`);
  };
}

const rpcCalls = () => ((supabase.rpc as any).mock.calls as Array<{ arguments: unknown[] }>);
const createOrderCalls = () => rpcCalls().filter((c) => String(c.arguments[0]) === "create_order");
const confirmationShown = (container: Element) => container.textContent?.includes("Commande envoyée avec succès") ?? false;

// -------------------------------------------------------------------
// B. NOTE POUR LE RESTAURANT (réglage par établissement)
// -------------------------------------------------------------------


// ====================================================================
// ISSUE #184 — « Comment passer commande » = UN SEUL texte général du
// commerçant (order_help_body), indépendant des règles de livraison.
// Les textes par règle restent dans le résultat du code postal saisi.
// Aucun tarif, zone, frais ni moteur de livraison modifié.
// ====================================================================

const HELP_LABEL = "Comment passer commande ?";
const HELP_BODY = "AIDE-GENERALE-UNIQUE : choisissez vos produits puis validez.";
const SHARED_RULE_TEXT = "TEXTE-REGLE-IDENTIQUE : consignes de la zone.";

function ruleRow(i: number, prefixes: string[], text: string, fallback = false) {
  return {
    fulfillment_code: `zone-${i}`, zone_prefixes: prefixes, is_fallback: fallback, min_items: null,
    customer_text: text, display_order: i, pricing_mode: "fixed", fixed_fee: 5 + i, free_threshold: null,
  };
}

function mockRpcHelp(t: { mock: { method: Function } }, rules: ReturnType<typeof ruleRow>[], helpBody: string = HELP_BODY) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: PICKUP_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      if (args.p_mode_code === "pickup") return { data: PICKUP_REQS, error: null };
      if (args.p_mode_code === "delivery") return { data: [...PICKUP_REQS, { field: "delivery_address", requirement: "required", one_of_group: null }], error: null };
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: rules, error: null };
    if (name === "get_restaurant_public_delivery_countries") {
      return { data: [{ country_code: "FR", country_name: "France", postal_code_pattern: "^[0-9]{5}$", phone_pattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$", address_provider: "ban_ign", address_line_order: "number_first" }], error: null };
    }
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
    if (name === "get_restaurant_public_communication_texts") {
      return { data: [
        { text_key: "order_help_button_label", body: HELP_LABEL },
        { text_key: "order_help_body", body: helpBody },
      ], error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
}

async function mountMenu() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: sanaaCookiesRestaurant() }));
  // Les textes du commerçant et les règles sont lus au montage (RPC publiques).
  await waitFor(() => container.querySelector("[data-order-help-dialog]") !== null, "aide à la commande rendue");
  await flush(50);
  return { container, root };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const allText = (c: Element) => c.textContent ?? "";

test("[184-HELP-1] plusieurs règles au texte identique : UNE seule entrée d'aide, texte général unique, aucun texte de règle", async (t) => {
  mockRpcHelp(t, [0, 1, 2, 3].map((i) => ruleRow(i, [`7500${i}`], SHARED_RULE_TEXT, i === 3)));
  installFetchNotNeeded();
  const { container, root } = await mountMenu();
  try {
    const triggers = [...container.querySelectorAll("button")].filter((b) => b.textContent === HELP_LABEL);
    assert.equal(triggers.length, 1, "un seul bouton « Comment passer commande ? »");
    assert.equal(container.querySelectorAll('dialog[data-delivery-dialog="conditions"]').length, 0, "plus de fenêtre agrégée des règles");
    assert.equal(container.querySelectorAll("[data-order-help-dialog]").length, 1, "une seule fenêtre d'aide");
    click(triggers[0]!);
    await flush();
    assert.equal(count(allText(container), HELP_BODY), 1, "texte général rendu une fois");
    assert.equal(count(allText(container), SHARED_RULE_TEXT), 0, "aucune copie du texte de règle dans l'aide");
  } finally { root.unmount(); container.remove(); }
});

test("[184-HELP-4] un seul bouton, libellé CENTRÉ ; à l'ouverture titre + corps COMPLETS, une seule fois, sans texte de règle", async (t) => {
  const LONG_BODY = HELP_BODY + "\n" + Array.from({ length: 6 }, (_, i) => `Ligne ${i + 1} de l'aide générale, affichée en entier.`).join("\n");
  mockRpcHelp(t, [0, 1, 2].map((i) => ruleRow(i, [`7500${i}`], SHARED_RULE_TEXT, i === 2)), LONG_BODY);
  installFetchNotNeeded();
  const { container, root } = await mountMenu();
  try {
    const triggers = [...container.querySelectorAll("button")].filter((b) => b.textContent === HELP_LABEL);
    assert.equal(triggers.length, 1, "un seul bouton portant ce libellé");
    assert.ok(LONG_BODY.length <= 500, "dans la limite du catalogue (500)");
    const cls = triggers[0]!.className.split(/\s+/);
    assert.ok(cls.includes("text-center"), "libellé centré");
    assert.ok(!cls.includes("text-start") && !cls.includes("text-left"), "plus d'alignement à gauche");
    assert.ok(cls.includes("w-full"), "bouton pleine largeur : le centrage est visible");

    click(triggers[0]!);
    await flush();
    const dlg = container.querySelector("[data-order-help-dialog]") as HTMLDialogElement;
    assert.ok(dlg.hasAttribute("open") || dlg.open, "fenêtre ouverte");
    const title = dlg.querySelector("[data-order-help-title]")!;
    const body = dlg.querySelector("[data-order-help-body]")!;
    assert.equal(title.textContent, HELP_LABEL, "titre affiché (repli sur le libellé)");
    assert.equal(body.textContent, LONG_BODY, "corps affiché INTÉGRALEMENT");
    assert.equal(count(allText(container), LONG_BODY), 1, "corps présent une seule fois");
    assert.equal(count(allText(container), SHARED_RULE_TEXT), 0, "aucun texte de règle réinjecté");
    const bodyCls = body.className;
    assert.ok(!/truncate|line-clamp|text-ellipsis|overflow-hidden/.test(bodyCls), "aucune troncature CSS");
  } finally { root.unmount(); container.remove(); }
});

test("[TR-OH-1] le bouton, le titre et le texte d'aide utilisent la traduction validée de la langue affichée", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const communicationTexts = {
    order_help_button_label: "Comment passer commande ?",
    order_help_title: "Comment passer commande ?",
    order_help_body: "Choisissez vos produits.",
  };
  const translatedTexts = [
    { text_key: "order_help_button_label", body: communicationTexts.order_help_button_label, body_hash: "label-hash", translations: { en: { order_help_button_label: "How to order", order_help_button_label_status: "validated", order_help_button_label_source_hash: "label-hash" } } },
    { text_key: "order_help_title", body: communicationTexts.order_help_title, body_hash: "title-hash", translations: { en: { order_help_title: "How to order", order_help_title_status: "validated", order_help_title_source_hash: "title-hash" } } },
    { text_key: "order_help_body", body: communicationTexts.order_help_body, body_hash: "body-hash", translations: { en: { order_help_body: "Choose your products.", order_help_body_status: "validated", order_help_body_source_hash: "body-hash" } } },
  ] as const;
  root.render(React.createElement(I18nProvider, {
    lang: "en", sourceLanguage: "fr", children: React.createElement(OrderHelpButton, { communicationTexts, translatedTexts }),
  }));
  await flush();
  const trigger = [...container.querySelectorAll("button")].find((button) => button.textContent === "How to order");
  assert.ok(trigger, "the French source label is translated in English");
  click(trigger);
  await flush();
  assert.equal(container.querySelector("[data-order-help-title]")?.textContent, "How to order");
  assert.equal(container.querySelector("[data-order-help-body]")?.textContent, "Choose your products.");
  root.unmount();
  container.remove();
});

test("[TR-OH-2] une traduction de l'ancienne source n'est pas affichée avec la nouvelle source", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const communicationTexts = { order_help_button_label: "Nouvelle instruction", order_help_body: "Nouveau texte" };
    const translatedTexts = [
      { text_key: "order_help_button_label", body: "Ancienne instruction", body_hash: "old", translations: { en: { order_help_button_label: "Old instruction", order_help_button_label_status: "validated", order_help_button_label_source_hash: "old" } } },
      { text_key: "order_help_body", body: "Ancien texte", body_hash: "old-body", translations: { en: { order_help_body: "Old text", order_help_body_status: "validated", order_help_body_source_hash: "old-body" } } },
    ] as const;
    root.render(React.createElement(I18nProvider, { lang: "en", sourceLanguage: "fr", children: React.createElement(OrderHelpButton, { communicationTexts, translatedTexts }) }));
    await flush();
    const trigger = [...container.querySelectorAll("button")].find((button) => button.textContent === "Nouvelle instruction");
    assert.ok(trigger);
    click(trigger);
    await flush();
    assert.equal(container.querySelector("[data-order-help-body]")?.textContent, "Nouveau texte");
    assert.ok(!container.textContent?.includes("Old text"));
  } finally { root.unmount(); container.remove(); }
});

test("[184-HELP-2] l'aide générale ne varie pas avec le nombre de règles", async (t) => {
  const snap = async (n: number) => {
    mockRpcHelp(t, Array.from({ length: n }, (_, i) => ruleRow(i, [`7500${i}`], SHARED_RULE_TEXT, i === n - 1)));
    installFetchNotNeeded();
    const { container, root } = await mountMenu();
    const dlg = container.querySelector("[data-order-help-dialog]")!;
    const text = dlg.textContent;
    const n_buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent === HELP_LABEL).length;
    root.unmount(); container.remove(); t.mock.restoreAll();
    return { text, n_buttons };
  };
  const one = await snap(1);
  const six = await snap(6);
  assert.deepEqual(six, one);
  assert.equal(one.n_buttons, 1);
});

test("[184-HELP-3] code postal saisi : le résultat garde UNIQUEMENT le texte de la règle correspondante", async (t) => {
  const A = "TEXTE-ZONE-75017 : livraison à vélo.";
  const B = "TEXTE-ZONE-75018 : livraison en camionnette.";
  mockRpcHelp(t, [ruleRow(1, ["75017"], A), ruleRow(2, ["75018"], B), ruleRow(3, ["75003"], "TEXTE-ZONE-75003"), ruleRow(4, ["92200"], "TEXTE-NEUILLY")]);
  installFetchNotNeeded();
  const { container, root } = await mountMenu();
  try {
    click(buttonWithText(container, "Ajouter")!);
    await flush();
    const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
    if (cartBar) { click(cartBar); await flush(); }
    selectServiceMode(container, "Livraison");
    await waitFor(() => inputById(container, "postalCode") !== null, "champ code postal");
    setNativeValue(inputById(container, "postalCode")!, "75017");
    await waitFor(() => visibleText(container).includes(A), "texte de la règle 75017");
    const vis = visibleText(container);
    for (const other of [B, "TEXTE-ZONE-75003", "TEXTE-NEUILLY"]) assert.ok(!vis.includes(other), `pas de texte d'une autre zone : ${other}`);
    assert.ok(!vis.includes(HELP_BODY), "le texte général n'est pas mêlé au résultat (fenêtre d'aide fermée)");
  } finally { root.unmount(); container.remove(); }
});

function visibleText(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  for (const d of clone.querySelectorAll("dialog:not([open])")) d.remove();
  return clone.textContent ?? "";
}

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame", "fetch"]) delete (globalThis as any)[k];
});
