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
const { MenuView, OrderHelpButton, I18nProvider } = await import(pathToFileURL(tmpFile).href);
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

test("[NOTE-1] order_note_enabled = false : aucun champ note, la commande part avec p_note null", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit({ configOverride: { order_note_enabled: false } });
  try {
    assert.equal(container.querySelector("#order-note"), null, "aucun champ note");
    assert.equal(container.querySelector("[data-order-note-block]"), null);
    assert.ok(!/Note pour le restaurant/.test(container.textContent ?? ""), "aucun libellé de note");
    click(submitBtn);
    await waitFor(() => confirmationShown(container), "confirmation attendue");
    const args = createOrderCalls()[0]!.arguments[1] as { p_note: unknown };
    assert.equal(args.p_note, null, "aucune note transmise");
  } finally { root.unmount(); container.remove(); }
});

test("[NOTE-2] order_note_enabled absent (défaut) ou true : champ note rendu, comportement historique", async (t) => {
  for (const configOverride of [{}, { order_note_enabled: true }, { order_note_enabled: null }]) {
    mockRpc(t, CREATE_ORDER_OK);
    (window as any).open = () => ({});
    installFetchNotNeeded();
    const { container, root } = await renderFillPickupAndReachSubmit({ configOverride });
    try {
      assert.ok(container.querySelector("#order-note"), `champ note rendu (${JSON.stringify(configOverride)})`);
      assert.ok(container.querySelector("[data-order-note-block]"));
    } finally { root.unmount(); container.remove(); }
  }
});

test("[NOTE-3] audit Maxwell P2 : une note TROP LONGUE déjà saisie, puis champ désactivé par l'établissement -> l'envoi n'est plus bloqué, p_note null", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  // 1. Champ note ACTIF : le client saisit une note au-delà de la limite.
  const enabled = sanaaCookiesRestaurant({ configOverride: { order_note_enabled: true } });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: enabled }));
  await flush();
  try {
    click(buttonWithText(container, "Ajouter")!);
    await flush();
    const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
    if (cartBar) { click(cartBar); await flush(); }
    selectServiceMode(container, "À emporter");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");
    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush(50);
    const noteEl = container.querySelector("#order-note") as HTMLTextAreaElement;
    assert.ok(noteEl, "champ note rendu quand actif");
    const tooLong = "x".repeat(ORDER_NOTE_MAX_LENGTH + 1);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(noteEl, tooLong);
    noteEl.dispatchEvent(new window.Event("input", { bubbles: true }));
    await flush(50);
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp") ?? null, null, "note trop longue : envoi bloqué tant que le champ est actif (règle v65 inchangée)");

    // 2. L'établissement DÉSACTIVE la note (nouvelle configuration reçue,
    //    même instance de MenuView : l'état de saisie subsiste).
    const disabled = sanaaCookiesRestaurant({ configOverride: { order_note_enabled: false } });
    root.render(React.createElement(MenuView, { restaurant: disabled }));
    await flush(50);
    assert.equal(container.querySelector("#order-note"), null, "champ note retiré");
    const submit = buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
    assert.ok(submit, "l'ancienne note trop longue ne bloque plus l'envoi");
    assert.ok(!/dépasse 500 caractères/.test(container.textContent ?? ""), "aucun message « note trop longue » résiduel");
    click(submit!);
    await waitFor(() => confirmationShown(container), "confirmation attendue");
    const args = createOrderCalls()[0]!.arguments[1] as { p_note: unknown };
    assert.equal(args.p_note, null, "la note résiduelle n'est jamais transmise");
  } finally { root.unmount(); container.remove(); }
});

// -------------------------------------------------------------------
// C. AIDE « COMMENT COMMANDER » : partie haute visible en premier
// -------------------------------------------------------------------

test("[HELP-1] à l'ouverture, le focus est sur le TITRE (pas sur « Fermer »), le défilement est en haut, et le bouton Fermer n'a plus autoFocus", async () => {
  // 30 lignes (< 500 caractères, borne MCC du contenu) : assez haut
  // pour dépasser une fenêtre mobile, donc pour que l'ancien autoFocus
  // sur « Fermer » ait fait défiler le début hors écran.
  const longBody = Array.from({ length: 30 }, (_, i) => `Étape ${i + 1} : ...`).join("\n");
  assert.ok(longBody.length <= 500);
  const texts = {
    order_help_button_label: "Comment commander ?",
    order_help_title: "Comment passer commande ?",
    order_help_body: longBody,
  };
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(I18nProvider, { lang: "fr", activeLanguages: [{ code: "fr", dir: "ltr" }] },
      React.createElement(OrderHelpButton, { communicationTexts: texts }))
  );
  await flush();
  try {
    const trigger = container.querySelector("[data-order-help] > button") as HTMLButtonElement;
    assert.ok(trigger, "bouton d'aide rendu");
    const dlg = container.querySelector("dialog[data-order-help-dialog]") as HTMLDialogElement;
    // Simule un contenu déjà défilé (ce que faisait l'autoFocus du bouton
    // Fermer en bas) : l'ouverture doit ramener en haut.
    Object.defineProperty(dlg, "scrollTop", { value: 500, writable: true, configurable: true });
    click(trigger);
    await flush();
    assert.ok(dlg.hasAttribute("open") || dlg.open, "dialogue ouvert");
    assert.equal(dlg.scrollTop, 0, "défilement remis en haut à l'ouverture");
    const title = dlg.querySelector("[data-order-help-title]") as HTMLElement;
    assert.ok(title, "titre rendu");
    assert.equal(title.getAttribute("tabindex"), "-1", "titre focusable par programme seulement");
    assert.equal(window.document.activeElement, title, "le focus initial est sur le titre");
    const close = dlg.querySelector("[data-order-help-close]") as HTMLButtonElement;
    assert.ok(close, "bouton Fermer rendu");
    assert.notEqual(window.document.activeElement, close, "jamais le focus initial sur Fermer");
    assert.equal(close.hasAttribute("autofocus"), false);
    assert.equal(dlg.querySelector("[data-order-help-body]")!.textContent, longBody, "texte intégral, inchangé");
  } finally { root.unmount(); container.remove(); }
});

// -------------------------------------------------------------------
// D. TEXTES PROPRES AU MODE (constat PR #166, commentaire du 27/10 11:08)
//
// Constat Production (Au Lait Cru, lecture seule) : en « Livraison —
// 75017 » le texte affiché commence par « Pour le retrait en boutique ».
// SOURCE : ce texte est le `customer_text` de la RÈGLE de livraison qui
// couvre 75008/75009/75010/75017/75019/93400/93000
// (restaurant_sale_mode_fulfillments, id 1d222236-…, fulfillment_code
// « Paris et banlieues desservies : 8ème, 9ème, 10ème, 17ème, 1 ») --
// le commerçant y a saisi des consignes de RETRAIT. Les textes sont des
// RÉGLAGES SÉPARÉS : livraison = customer_text de la règle résolue par
// le code postal (FulfillmentSelector, `status.zone.label`) ; retrait =
// emplacement MCC `pickup_explanation` (ou le défaut plateforme). La
// correction du constat de Production est une correction de DONNÉES
// (texte de la règle, écran Tarifs de livraison du back-office).
// Ce test a toutefois révélé un défaut de CODE voisin, corrigé dans
// FulfillmentSelector : le bandeau d'état de livraison (texte de la
// règle appariée) restait affiché en mode RETRAIT après une bascule
// Livraison -> Retrait. Il est désormais réservé au mode livraison.
// -------------------------------------------------------------------

const DELIVERY_COPY = "LIVRAISON-COPY-75017 : livraison à vélo, créneau proposé à la commande.";
const PICKUP_COPY = "RETRAIT-COPY : pour le retrait en boutique, du mardi au samedi.";

function mockRpcModeCopy(t: { mock: { method: Function } }) {
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
      if (args.p_mode_code === "delivery") return { data: [...PICKUP_REQS, { field: "delivery_address", requirement: "required", one_of_group: null }], error: null };
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") {
      return { data: [{
        fulfillment_code: "Paris et banlieues desservies : 8ème, 9ème, 10ème, 17ème, 1",
        zone_prefixes: ["75008", "75009", "75010", "75017", "75019"],
        is_fallback: false,
        min_items: null,
        customer_text: DELIVERY_COPY,
        display_order: 20,
        pricing_mode: "fixed",
        fixed_fee: 10.9,
        free_threshold: null,
      }], error: null };
    }
    if (name === "get_restaurant_public_delivery_countries") {
      return { data: [{ country_code: "FR", country_name: "France", postal_code_pattern: "^[0-9]{5}$", phone_pattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$", address_provider: "ban_ign", address_line_order: "number_first" }], error: null };
    }
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
    if (name === "get_restaurant_public_communication_texts") {
      return { data: [{ text_key: "pickup_explanation", body: PICKUP_COPY }], error: null };
    }
    if (name === "create_order") return CREATE_ORDER_OK;
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

/** Texte VISIBLE : exclut le contenu des <dialog> fermés (ex. la fenêtre
 *  « Zones et tarifs de livraison » de l'en-tête, qui liste TOUTES les
 *  règles mais n'est pas affichée tant qu'on ne l'ouvre pas). */
function visibleText(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  for (const d of clone.querySelectorAll("dialog:not([open])")) d.remove();
  return clone.textContent ?? "";
}

test("[MODE-COPY-1] Livraison 75017 -> seul le texte de la RÈGLE de livraison ; bascule Retrait -> seul le texte retrait ; retour Livraison -> seul le texte livraison", async (t) => {
  mockRpcModeCopy(t);
  installFetchNotNeeded();
  const restaurant = sanaaCookiesRestaurant();
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();
  try {
    click(buttonWithText(container, "Ajouter")!);
    await flush();
    const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
    if (cartBar) { click(cartBar); await flush(); }

    // 1. Livraison + 75017 : le texte de la règle apparaît, jamais celui du retrait.
    selectServiceMode(container, "Livraison");
    await waitFor(() => inputById(container, "postalCode") !== null, "champ code postal rendu");
    setNativeValue(inputById(container, "postalCode")!, "75017");
    await waitFor(() => visibleText(container).includes(DELIVERY_COPY), "texte de la règle de livraison attendu");
    assert.ok(!visibleText(container).includes(PICKUP_COPY), "en Livraison, AUCUN texte de retrait");

    // 2. Bascule Retrait : le texte retrait apparaît, celui de la règle disparaît.
    selectServiceMode(container, "À emporter");
    await waitFor(() => visibleText(container).includes(PICKUP_COPY), "texte retrait attendu");
    assert.ok(!visibleText(container).includes(DELIVERY_COPY), "en Retrait, AUCUN texte de règle de livraison");
    assert.equal(container.querySelector('[role="status"]'), null, "en Retrait, aucun bandeau d'état de livraison");

    // 3. Retour Livraison : le code postal saisi est conservé, le texte de la règle revient seul.
    selectServiceMode(container, "Livraison");
    await waitFor(() => visibleText(container).includes(DELIVERY_COPY), "texte de la règle à nouveau attendu");
    assert.ok(!visibleText(container).includes(PICKUP_COPY));
  } finally { root.unmount(); container.remove(); }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame", "fetch"]) delete (globalThis as any)[k];
});
