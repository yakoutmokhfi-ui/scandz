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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-p4a-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
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
function sanaaCookiesRestaurant() {
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

async function renderFillPickupAndReachSubmit() {
  const restaurant = sanaaCookiesRestaurant();
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
// PAYMENT P4-A -- PARCOURS CLIENT DU PAIEMENT EN LIGNE (boutique).
//
// Monte RÉELLEMENT MenuView (esbuild + jsdom), create_order intercepté
// au niveau supabase.rpc, et les appels HTTP sortants interceptés au
// niveau `fetch` (jamais plus bas). Ce fichier prouve :
//   1. après create_order, la boutique DEMANDE au serveur si un paiement
//      est requis (POST /api/payments/monetico/checkout) avec l'order_id
//      et le public_token RÉELS -- jamais décidé côté client ;
//   2. `checkout_not_needed` -> parcours historique inchangé (écran de
//      confirmation) ;
//   3. `ready` -> un formulaire POST vers l'URL Monetico, rejouant les
//      champs signés TELS QUELS, est soumis ; AUCUN écran de confirmation
//      n'est affiché (l'autorité est le retour serveur) ;
//   4. `billing_required` (retrait) -> dialogue d'adresse de facturation,
//      puis nouvel appel AVEC l'adresse sur la MÊME commande ; l'adresse
//      vide/refusée est signalée sans perdre la saisie ;
//   5. `unavailable` -> la commande n'est pas perdue : message + reprise
//      CIBLÉE (même commande, create_order JAMAIS rappelée).
// ====================================================================

const CREATE_ORDER_OK = {
  data: [{ order_id: ORDER_ID, order_number: 42, public_token: TOKEN, total: 3.5, subtotal: 3.5, delivery_fee: 0 }],
  error: null,
};

interface CheckoutCall { body: any }
type CheckoutResponder = (call: CheckoutCall, index: number) => { status: number; body: unknown };

function installFetch(respond: CheckoutResponder) {
  const checkoutCalls: CheckoutCall[] = [];
  const otherCalls: string[] = [];
  (globalThis as any).fetch = async (input: unknown, init: any) => {
    const url = String(input);
    if (url.includes("/api/payments/monetico/checkout")) {
      const body = JSON.parse(init.body);
      checkoutCalls.push({ body });
      const r = respond({ body }, checkoutCalls.length - 1);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/checkout/withdrawal-eligibility")) {
      otherCalls.push(url);
      return new Response(JSON.stringify({ eligible: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    otherCalls.push(url);
    throw new Error(`requête sortante inattendue : ${url}`);
  };
  return { checkoutCalls, otherCalls };
}

const READY = { status: 200, body: { outcome: "ready", submissionUrl: "https://p.monetico-services.com/test/paiement.cgi", fields: { version: "3.0", TPE: "35VV71I", montant: "3.50EUR", reference: "ABC123", MAC: "deadbeef" }, resumed: false } };
const NOT_NEEDED = { status: 200, body: { outcome: "checkout_not_needed", reason: "not_required" } };
const BILLING_REQUIRED = { status: 409, body: { outcome: "billing_required" } };
const BILLING_INVALID = { status: 400, body: { outcome: "invalid_request", reason: "billing_invalid" } };
const UNAVAILABLE = { status: 503, body: { outcome: "provider_unavailable" } };

/** Intercepte la soumission du formulaire de redirection (jsdom n'implémente
 *  pas la navigation) et capture action + champs. */
function captureRedirectForms() {
  const submitted: Array<{ action: string; method: string; fields: Record<string, string> }> = [];
  const proto = window.HTMLFormElement.prototype as any;
  const original = proto.submit;
  proto.submit = function (this: HTMLFormElement) {
    const fields: Record<string, string> = {};
    for (const input of this.querySelectorAll("input")) fields[(input as HTMLInputElement).name] = (input as HTMLInputElement).value;
    submitted.push({ action: this.action, method: this.method.toUpperCase(), fields });
  };
  return { submitted, restore: () => { proto.submit = original; } };
}

function confirmationShown(container: Element): boolean {
  return container.textContent?.includes("Commande envoyée avec succès") ?? false;
}

function billingDialog(container: Element): HTMLDialogElement | null {
  return container.querySelector("dialog[data-billing-dialog]");
}
function billingOpen(container: Element): boolean {
  const d = billingDialog(container);
  return d !== null && d.hasAttribute("open");
}
function fillBilling(container: Element, v: Partial<Record<"addressLine1"|"addressLine2"|"postalCode"|"city"|"country", string>>) {
  for (const [k, val] of Object.entries(v)) {
    const input = container.querySelector(`[data-billing-field="${k}"]`) as HTMLInputElement | null;
    assert.ok(input, `champ de facturation ${k}`);
    setNativeValue(input!, val!);
  }
}

async function orderPickupWith(t: any, respond: CheckoutResponder) {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  const fetchSpy = installFetch(respond);
  const r = await renderFillPickupAndReachSubmit();
  click(r.submitBtn);
  return { ...r, ...fetchSpy };
}

const rpcNames = () => ((supabase.rpc as any).mock.calls as Array<{ arguments: unknown[] }>).map((c) => String(c.arguments[0]));

test("[P4A-1] après create_order, la boutique appelle POST /api/payments/monetico/checkout avec l'order_id/public_token RÉELS et la langue -- sans adresse (retrait) ; `checkout_not_needed` -> confirmation historique", async (t) => {
  const { container, root, checkoutCalls } = await orderPickupWith(t, () => NOT_NEEDED);
  try {
    await waitFor(() => confirmationShown(container), "confirmation attendue");
    assert.equal(checkoutCalls.length, 1);
    assert.equal(checkoutCalls[0]!.body.orderId, ORDER_ID);
    assert.equal(checkoutCalls[0]!.body.publicToken, TOKEN);
    assert.equal(checkoutCalls[0]!.body.language, "fr");
    assert.equal("billing" in checkoutCalls[0]!.body, false, "retrait : aucune adresse envoyée au premier appel");
    assert.equal(billingOpen(container), false);
    assert.equal(container.querySelector("[data-payment-error]"), null);
  } finally { root.unmount(); container.remove(); }
});

test("[P4A-2] `ready` -> formulaire POST vers l'URL Monetico avec les champs signés TELS QUELS ; AUCUNE confirmation, AUCUN WhatsApp, create_order appelée UNE fois", async (t) => {
  const forms = captureRedirectForms();
  let opened = 0;
  const { container, root, checkoutCalls } = await orderPickupWith(t, () => READY);
  (window as any).open = () => { opened++; return {}; };
  try {
    await waitFor(() => forms.submitted.length === 1, "formulaire de redirection soumis");
    const f = forms.submitted[0]!;
    assert.equal(f.action, READY.body.submissionUrl);
    assert.equal(f.method, "POST");
    assert.deepEqual(f.fields, READY.body.fields, "les champs signés sont rejoués sans ajout ni modification");
    await flush(60);
    assert.equal(confirmationShown(container), false, "jamais de confirmation avant le retour serveur");
    assert.equal(opened, 0);
    assert.equal(checkoutCalls.length, 1);
    assert.equal(rpcNames().filter((n) => n === "create_order").length, 1);
    assert.equal(rpcNames().includes("mark_whatsapp_opened"), false);
  } finally { forms.restore(); root.unmount(); container.remove(); }
});

test("[P4A-3] retrait : `billing_required` -> dialogue d'adresse ; saisie -> 2e appel sur la MÊME commande avec billing manual (pays en majuscules, nom/téléphone du client) -> `ready` -> redirection", async (t) => {
  const forms = captureRedirectForms();
  const { container, root, checkoutCalls } = await orderPickupWith(t, (_c, i) => (i === 0 ? BILLING_REQUIRED : READY));
  try {
    await waitFor(() => billingOpen(container), "dialogue de facturation ouvert");
    assert.equal(confirmationShown(container), false);
    // Validation locale : champs obligatoires vides -> pas d'appel.
    (container.querySelector('[data-billing-action="continue"]') as HTMLButtonElement).click();
    await flush(30);
    assert.equal(checkoutCalls.length, 1, "aucun appel tant que l'adresse est incomplète");
    assert.ok(container.querySelector('[data-billing-field="addressLine1"][aria-invalid="true"]'));

    fillBilling(container, { addressLine1: " 12 rue des Lilas ", postalCode: "74000", city: "Annecy", country: "fr" });
    await flush();
    (container.querySelector("dialog[data-billing-dialog] form") as HTMLFormElement).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => forms.submitted.length === 1, "redirection après adresse");

    assert.equal(checkoutCalls.length, 2);
    const second = checkoutCalls[1]!.body;
    assert.equal(second.orderId, ORDER_ID, "même commande");
    assert.equal(second.publicToken, TOKEN);
    assert.deepEqual(second.billing, {
      source: "manual", addressLine1: "12 rue des Lilas", city: "Annecy", postalCode: "74000", country: "FR",
      customerName: "Yakout", customerPhone: "0612345678",
    });
    assert.equal(rpcNames().filter((n) => n === "create_order").length, 1, "create_order jamais rappelée");
  } finally { forms.restore(); root.unmount(); container.remove(); }
});

test("[P4A-4] adresse REFUSÉE par le serveur (`billing_invalid`) -> erreur affichée dans le dialogue, saisie CONSERVÉE, nouvelle tentative possible sur la même commande", async (t) => {
  const forms = captureRedirectForms();
  const { container, root, checkoutCalls } = await orderPickupWith(t, (_c, i) => (i === 0 ? BILLING_REQUIRED : i === 1 ? BILLING_INVALID : READY));
  try {
    await waitFor(() => billingOpen(container), "dialogue ouvert");
    fillBilling(container, { addressLine1: "1 rue X", postalCode: "75001", city: "Paris", country: "FR" });
    await flush();
    const form = container.querySelector("dialog[data-billing-dialog] form") as HTMLFormElement;
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => container.querySelector("[data-billing-error]") !== null, "erreur serveur affichée");
    assert.equal(billingOpen(container), true, "le dialogue reste ouvert");
    assert.equal((container.querySelector('[data-billing-field="city"]') as HTMLInputElement).value, "Paris", "saisie conservée");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => forms.submitted.length === 1, "redirection au 3e appel");
    assert.equal(checkoutCalls.length, 3);
    assert.ok(checkoutCalls.every((c) => c.body.orderId === ORDER_ID));
  } finally { forms.restore(); root.unmount(); container.remove(); }
});

test("[P4A-5] `provider_unavailable` -> la commande n'est PAS perdue : message + bouton « Réessayer le paiement » (jamais de confirmation) ; la reprise rappelle le checkout sur la MÊME commande sans recréer de commande", async (t) => {
  const forms = captureRedirectForms();
  const { container, root, checkoutCalls } = await orderPickupWith(t, (_c, i) => (i === 0 ? UNAVAILABLE : READY));
  try {
    await waitFor(() => container.querySelector("[data-payment-error]") !== null, "message d'indisponibilité");
    assert.equal(confirmationShown(container), false);
    assert.ok(container.textContent?.includes("Votre commande est enregistrée"));
    const retry = container.querySelector('[data-payment-action="retry"]') as HTMLButtonElement;
    assert.ok(retry, "bouton de reprise");
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined, "le bouton d'envoi normal est remplacé (pas de nouvelle commande possible)");
    click(retry);
    await waitFor(() => forms.submitted.length === 1, "redirection après reprise");
    assert.equal(checkoutCalls.length, 2);
    assert.equal(checkoutCalls[1]!.body.orderId, ORDER_ID);
    assert.equal(rpcNames().filter((n) => n === "create_order").length, 1, "create_order appelée UNE seule fois");
  } finally { forms.restore(); root.unmount(); container.remove(); }
});

test("[P4A-6] réseau coupé (fetch rejette) -> même traitement qu'indisponible : commande conservée, reprise ciblée", async (t) => {
  mockRpc(t, CREATE_ORDER_OK);
  (window as any).open = () => ({});
  let n = 0;
  (globalThis as any).fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/payments/monetico/checkout")) { n++; throw new TypeError("network down"); }
    return new Response(JSON.stringify({ eligible: false }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.querySelector("[data-payment-error]") !== null, "message d'indisponibilité");
    assert.equal(n, 1);
    assert.equal(confirmationShown(container), false);
    assert.ok(container.querySelector('[data-payment-action="retry"]'));
  } finally { root.unmount(); container.remove(); }
});

test("[P4A-7] `ready` MALFORMÉ (URL non https, ou champs absents) -> AUCUNE redirection, traité comme indisponible", async (t) => {
  const forms = captureRedirectForms();
  for (const bad of [
    { outcome: "ready", submissionUrl: "http://evil.example/pay", fields: { a: "1" } },
    { outcome: "ready", submissionUrl: "https://p.monetico-services.com/test/paiement.cgi", fields: {} },
    { outcome: "ready", submissionUrl: "https://p.monetico-services.com/test/paiement.cgi" },
    { outcome: "ready", submissionUrl: "https://p.monetico-services.com/test/paiement.cgi", fields: { a: 1 } },
  ]) {
    const { container, root } = await orderPickupWith(t, () => ({ status: 200, body: bad }));
    try {
      await waitFor(() => container.querySelector("[data-payment-error]") !== null, `indisponible attendu pour ${JSON.stringify(bad)}`);
      assert.equal(forms.submitted.length, 0, `redirection interdite pour ${JSON.stringify(bad)}`);
      assert.equal(confirmationShown(container), false);
    } finally { root.unmount(); container.remove(); t.mock.restoreAll(); }
  }
  forms.restore();
});

test("[P4A-8] annuler le dialogue d'adresse -> la commande reste reprise possible (message + Réessayer), jamais de confirmation ni de nouvelle commande", async (t) => {
  const { container, root, checkoutCalls } = await orderPickupWith(t, () => BILLING_REQUIRED);
  try {
    await waitFor(() => billingOpen(container), "dialogue ouvert");
    click(container.querySelector('[data-billing-action="cancel"]')!);
    await waitFor(() => container.querySelector("[data-payment-error]") !== null, "message après annulation");
    assert.equal(billingOpen(container), false);
    assert.equal(confirmationShown(container), false);
    assert.equal(checkoutCalls.length, 1);
    assert.equal(rpcNames().filter((n) => n === "create_order").length, 1);
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
