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
function sanaaCookiesRestaurant(opts: { alcohol?: boolean; configOverride?: Record<string, unknown> } = {}) {
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
            // UX LOT 2026-10 : drapeau marchand (jamais déduit du nom).
            ...(opts.alcohol ? { contains_alcohol: true } : {}),
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

async function renderFillPickupAndReachSubmit(opts: { alcohol?: boolean; configOverride?: Record<string, unknown> } = {}) {
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
//   A. confirmation d'âge : rendue UNIQUEMENT si le panier contient un
//      produit `contains_alcohol = true` ; décochée par défaut ; tant
//      qu'elle n'est pas cochée, l'envoi est impossible (bouton
//      désactivé ET aucune create_order même en forçant le clic) ;
//      cochée -> la commande part. Panier sans alcool : aucune case,
//      parcours inchangé. Rien n'est déduit du NOM du produit.
//   B. note pour le restaurant : masquée quand
//      restaurant_configs.order_note_enabled = false (aucun champ
//      #order-note, p_note null) ; rendue sinon (défaut inchangé).
//   C. aide « comment commander » : à l'ouverture, le défilement est en
//      haut et le focus est sur le TITRE (jamais sur le bouton Fermer en
//      bas) -- la partie haute du texte est visible en premier.
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
const ageBox = (container: Element) => container.querySelector("[data-age-confirmation-input]") as HTMLInputElement | null;

function setChecked(input: HTMLInputElement, checked: boolean) {
  // React écoute `click` sur les cases à cocher ; `.click()` natif
  // bascule `checked` et déclenche l'événement.
  if (input.checked !== checked) input.click();
}

// -------------------------------------------------------------------
// A. CONFIRMATION D'ÂGE
// -------------------------------------------------------------------

test("[AGE-1] panier AVEC alcool : case rendue, DÉCOCHÉE par défaut, bouton désactivé, aucune create_order même en forçant le clic", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit({ alcohol: true });
  try {
    const box = ageBox(container);
    assert.ok(box, "la case de confirmation d'âge doit être rendue");
    assert.equal(box!.checked, false, "décochée par défaut");
    assert.match(container.querySelector("[data-age-confirmation]")!.textContent ?? "", /18 ans ou plus/);
    assert.equal(submitBtn.disabled, true, "bouton d'envoi désactivé tant que la case n'est pas cochée");
    // Clic forcé (le DOM ne protège pas un bouton disabled contre un
    // dispatch programmatique) : la garde logique doit tenir seule.
    click(submitBtn);
    await flush(80);
    assert.equal(createOrderCalls().length, 0, "aucune commande envoyée sans confirmation d'âge");
    assert.equal(confirmationShown(container), false);
  } finally { root.unmount(); container.remove(); }
});

test("[AGE-2] panier AVEC alcool : case cochée -> bouton actif -> create_order appelée UNE fois -> confirmation", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  const { container, root } = await renderFillPickupAndReachSubmit({ alcohol: true });
  try {
    setChecked(ageBox(container)!, true);
    await flush();
    assert.equal(ageBox(container)!.checked, true);
    const btn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!;
    assert.equal(btn.disabled, false, "bouton actif une fois la case cochée");
    click(btn);
    await waitFor(() => confirmationShown(container), "confirmation attendue");
    assert.equal(createOrderCalls().length, 1);
  } finally { root.unmount(); container.remove(); }
});

test("[AGE-3] panier AVEC alcool : décocher à nouveau re-bloque l'envoi (la case est une condition, pas un événement)", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  const { container, root } = await renderFillPickupAndReachSubmit({ alcohol: true });
  try {
    setChecked(ageBox(container)!, true);
    await flush();
    setChecked(ageBox(container)!, false);
    await flush();
    const btn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!;
    assert.equal(btn.disabled, true);
    click(btn);
    await flush(80);
    assert.equal(createOrderCalls().length, 0);
  } finally { root.unmount(); container.remove(); }
});

test("[AGE-4] panier SANS alcool : AUCUNE case, bouton actif, commande envoyée comme avant", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit({ alcohol: false });
  try {
    assert.equal(ageBox(container), null, "aucune case pour un panier sans alcool");
    assert.equal(container.querySelector("[data-age-confirmation]"), null);
    assert.equal(submitBtn.disabled, false);
    click(submitBtn);
    await waitFor(() => confirmationShown(container), "confirmation attendue");
    assert.equal(createOrderCalls().length, 1);
  } finally { root.unmount(); container.remove(); }
});

test("[AGE-5] un produit dont le NOM évoque l'alcool mais sans drapeau marchand n'exige RIEN (jamais d'inférence)", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  installFetchNotNeeded();
  const restaurant = sanaaCookiesRestaurant({ alcohol: false });
  restaurant.categories[0]!.menu_items[0]!.name = "Bière blonde 33cl";
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
    selectServiceMode(container, "À emporter");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");
    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush(50);
    assert.ok(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"));
    assert.equal(ageBox(container), null, "le nom du produit n'est jamais une source");
  } finally { root.unmount(); container.remove(); }
});

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

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame", "fetch"]) delete (globalThis as any)[k];
});
