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
// Scanym — CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.2
// (FERME "SILENT INVOICE LOSS", HIGH, RELEASE-BLOCKING).
//
// Preuve comportementale RÉELLE, de bout en bout (montage complet de
// MenuView, `supabase.rpc` ET `fetch` réellement interceptés,
// interactions utilisateur réelles jusqu'au clic d'envoi ET de
// reprise) -- réutilise EXACTEMENT le patron déjà établi par
// tests/v122i-tracking-menuview-wiring.dom.test.ts.
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

const entrySource = `export { default as MenuView } from "@/components/MenuView";`;
const buildResult = await esbuild.build({
  stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-invoice-retry-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(check: () => boolean, description: string, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
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
/**
 * Une case à cocher a besoin d'un VRAI `.click()` natif (qui bascule
 * `checked` puis émet "change") -- un `dispatchEvent(new Event(...))`
 * synthétique ne déclenche JAMAIS le comportement natif de bascule,
 * contrairement à un simple bouton où seul le listener importe.
 */
function toggleCheckbox(el: HTMLInputElement) {
  el.click();
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

/** Même fixture que v122i/v101 (harnais MenuView déjà établi). */
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
      address: null, latitude: null, longitude: null,
      logo_url: null, cover_url: null, opening_hours: null,
      source_language: "fr",
    },
    categories: [{
      id: "cat-1", restaurant_id: "r-sanaa-test", name: "Cookies", display_order: 1, is_active: true,
      menu_items: [{
        id: "item-1", category_id: "cat-1", name: "Cookie chocolat", description: null,
        short_description: null, price: 3.5, image_url: null, display_order: 1, is_available: true,
      }],
    }],
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];
const PICKUP_SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];
const PICKUP_REQS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
];
/** LOT EMAIL VALIDATION v1 -- même fixture, email client requis en plus. */
const PICKUP_REQS_WITH_EMAIL = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
  { field: "email", requirement: "required", one_of_group: null },
];

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

function mockRpc(t: { mock: { method: Function } }, createOrderCalls: { count: number } = { count: 0 }) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
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
    if (name === "create_order") {
      createOrderCalls.count += 1;
      return {
        data: [{ order_id: ORDER_ID, order_number: 42, public_token: TOKEN, total: 3.5, subtotal: 3.5, delivery_fee: 0 }],
        error: null,
      };
    }
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return createOrderCalls;
}

/** LOT EMAIL VALIDATION v1 -- même mock, avec "email" requis (PICKUP_REQS_WITH_EMAIL). */
function mockRpcEmailRequired(t: { mock: { method: Function } }, createOrderCalls: { count: number } = { count: 0 }) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: PICKUP_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      if (args.p_mode_code === "pickup") return { data: PICKUP_REQS_WITH_EMAIL, error: null };
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "create_order") {
      createOrderCalls.count += 1;
      return {
        data: [{ order_id: ORDER_ID, order_number: 42, public_token: TOKEN, total: 3.5, subtotal: 3.5, delivery_fee: 0 }],
        error: null,
      };
    }
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return createOrderCalls;
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
  if (cartBar) { click(cartBar); await flush(); }

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

async function renderFillPickupCheckInvoiceAndReachSubmit() {
  const { container, root } = await renderFillPickupAndReachSubmit();

  // Coche "Besoin d'une facture ?" (checkbox rendue par InvoiceRequestFields).
  const invoiceCheckbox = [...container.querySelectorAll('input[type="checkbox"]')]
    .find((el) => el.closest("label")?.textContent?.includes("Besoin d'une facture"));
  assert.ok(invoiceCheckbox, "la case à cocher de demande de facture doit être présente");
  toggleCheckbox(invoiceCheckbox as HTMLInputElement);
  await flush();

  await waitFor(() => inputById(container, "invoice-address-line-1") !== null, "champs de facture rendus");
  setNativeValue(inputById(container, "invoice-address-line-1")!, "12 rue Test");
  setNativeValue(inputById(container, "invoice-city")!, "Paris");
  setNativeValue(inputById(container, "invoice-postal-code")!, "75001");
  await flush(50);
  await flush();

  const submitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
  assert.ok(submitBtn, "le bouton d'envoi doit être atteignable après avoir coché la demande de facture");
  return { container, root, submitBtn: submitBtn! };
}

test("1. aucune facture demandée -- checkout normal INCHANGÉ (confirmation directe, aucun appel fetch)", async (t) => {
  mockRpc(t);
  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { fetchCalled = true; throw new Error("ne doit jamais être appelé"); };
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");
    assert.equal(fetchCalled, false, "aucun appel fetch (facture) ne doit jamais se produire si non demandée");
    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("2. facture demandée + persistance RÉUSSIE -- completion normale, un seul appel create_order, un seul appel fetch", async (t) => {
  const createOrderCalls = mockRpc(t);
  let fetchCallCount = 0;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { fetchCallCount += 1; return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 }); };
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après persistance réussie");
    assert.equal(createOrderCalls.count, 1, "un seul appel create_order");
    assert.equal(fetchCallCount, 1, "un seul appel fetch (facture)");
    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("3/4/5/6/7. facture demandée + persistance ÉCHOUE -- échec VISIBLE, AUCUN faux succès, commande NON recréée, reprise avec MÊME orderId/publicToken, upsert déterministe sur reprise répétée", async (t) => {
  const createOrderCalls = mockRpc(t);
  const fetchCalls: Array<{ orderId: string; publicToken: string }> = [];
  let shouldFail = true;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    fetchCalls.push({ orderId: body.orderId, publicToken: body.publicToken });
    if (shouldFail) return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  let whatsappOpenCount = 0;
  (window as any).open = () => { whatsappOpenCount += 1; return {}; };

  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    // Premier essai -- échec de persistance.
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "le bouton de reprise doit apparaître après échec");

    // 3. Échec VISIBLE.
    assert.ok(container.textContent?.includes("commande a bien été créée"), "le message d'échec doit confirmer que la commande existe");
    // AUCUN faux succès.
    assert.equal(container.textContent?.includes("Commande envoyée avec succès"), false, "aucune confirmation ne doit apparaître tant que la facture n'est pas persistée");
    // 4. La commande N'EST PAS recréée par cet échec seul.
    assert.equal(createOrderCalls.count, 1, "create_order ne doit avoir été appelé qu'une fois");
    // Aucune ouverture WhatsApp tant que l'issue de la facture n'est pas connue avec succès.
    assert.equal(whatsappOpenCount, 0, "WhatsApp ne doit pas s'ouvrir tant que la facture a échoué");

    // 5. Reprise -- vérifie que le MÊME orderId/publicToken est réutilisé.
    shouldFail = false;
    const retryBtn = buttonWithText(container, "Réessayer la demande de facture")!;
    assert.ok(retryBtn, "le bouton de reprise doit être présent");
    click(retryBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après reprise réussie");

    assert.equal(fetchCalls.length, 2, "exactement 2 appels fetch (échec + reprise réussie)");
    assert.equal(fetchCalls[0].orderId, ORDER_ID);
    assert.equal(fetchCalls[1].orderId, ORDER_ID, "la reprise doit réutiliser EXACTEMENT le même orderId");
    assert.equal(fetchCalls[1].publicToken, TOKEN, "la reprise doit réutiliser EXACTEMENT le même publicToken");
    // 6. Après reprise, exactement 1 appel WhatsApp -- jamais un doublon.
    assert.equal(whatsappOpenCount, 1, "WhatsApp ne doit s'ouvrir qu'une seule fois, après la reprise réussie");
    // 11. create_order n'a JAMAIS été rappelé, même après la reprise.
    assert.equal(createOrderCalls.count, 1, "create_order ne doit JAMAIS être rappelé lors d'une reprise de facture");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("8. aucune action WhatsApp dupliquée même si la reprise échoue plusieurs fois avant de réussir", async (t) => {
  mockRpc(t);
  const fetchCalls: number[] = [];
  let failCount = 2; // échoue 2 fois, réussit à la 3e tentative (1 initiale + 2 reprises)
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    fetchCalls.push(1);
    if (failCount > 0) { failCount -= 1; return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 }); }
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  let whatsappOpenCount = 0;
  (window as any).open = () => { whatsappOpenCount += 1; return {}; };

  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "premier échec attendu");
    click(buttonWithText(container, "Réessayer la demande de facture")!);
    await waitFor(() => fetchCalls.length === 2, "deuxième tentative attendue");
    await flush(20);
    click(buttonWithText(container, "Réessayer la demande de facture")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "succès final attendu");

    assert.equal(fetchCalls.length, 3, "3 tentatives au total (1 initiale + 2 reprises)");
    assert.equal(whatsappOpenCount, 1, "WhatsApp ne doit JAMAIS s'ouvrir plus d'une fois, quel que soit le nombre de tentatives");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("9/10. aucune action de paiement/Stuart déclenchée par la reprise de facture (preuve structurelle -- aucune RPC de ce type mockée n'est jamais appelée, sinon l'exception du mock ferait échouer le test)", async (t) => {
  const createOrderCalls = mockRpc(t);
  let shouldFail = true;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    if (shouldFail) return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "échec attendu");
    shouldFail = false;
    click(buttonWithText(container, "Réessayer la demande de facture")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "succès attendu");
    // La sonde `supabase.rpc` mockée lève une exception pour tout nom
    // de RPC non explicitement listé (paiement/Stuart compris) -- le
    // test aurait déjà échoué si l'un ou l'autre avait été appelé.
    assert.equal(createOrderCalls.count, 1);
    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("12/13. facture individuelle et société restent valides après le changement de fiabilité (non-régression du formulaire)", async (t) => {
  mockRpc(t);
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    // Bascule sur "Société" avant l'envoi.
    const companyRadio = [...container.querySelectorAll('input[type="radio"]')]
      .find((el) => (el as HTMLInputElement).closest("label")?.textContent?.includes("Société")) as HTMLInputElement;
    assert.ok(companyRadio, "le bouton radio Société doit être présent");
    toggleCheckbox(companyRadio);
    await flush();
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "ACME SARL");
    await flush(50);
    await flush();

    // Le bouton capturé AVANT ce changement de type peut être devenu
    // une référence DOM obsolète après le nouveau rendu -- re-requêté
    // ici pour cliquer sur le nœud RÉELLEMENT attaché à l'arbre.
    const freshSubmitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!;
    click(freshSubmitBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue (facture société)");
    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("CORRECTABLE-RETRY. facture rejetée pour un champ invalide -- la correction PUIS reprise envoie la VALEUR CORRIGÉE, jamais l'ancienne rejetée (ferme Cat Woman INVOICE-V13-RETRY-CORRECTION-01, HIGH) -- commande/panier/contexte/note restent gelés", async (t) => {
  const createOrderCalls = mockRpc(t);
  const invoicePayloads: Array<Record<string, unknown>> = [];
  let shouldFail = true;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    invoicePayloads.push(body);
    if (shouldFail) return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  let capturedWhatsAppUrl: string | null = null;
  let whatsappOpenCount = 0;
  (window as any).open = (url: string) => { whatsappOpenCount += 1; capturedWhatsAppUrl = url; return {}; };

  // 1/2. Créer la commande, la persistance de facture échoue
  // (déterministe -- ex. un champ que le serveur rejette).
  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "échec initial attendu");
    assert.equal(createOrderCalls.count, 1, "une seule commande créée jusqu'ici");

    // 3. Modifier la quantité de produit (bouton "+") -- fait partie
    // de LA COMMANDE, doit rester GELÉ malgré la modification.
    const plusBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "+");
    assert.ok(plusBtn, "le bouton d'incrémentation de quantité doit être présent");
    click(plusBtn!);
    await flush();

    // 4. Modifier la note -- fait partie de LA COMMANDE, doit rester GELÉE.
    const noteField = container.querySelector("#order-note") as HTMLTextAreaElement | null;
    if (noteField) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(noteField, "Note modifiée APRÈS l'échec -- ne doit JAMAIS apparaître dans le message WhatsApp de cette commande");
      noteField.dispatchEvent(new window.Event("input", { bubbles: true }));
      await flush();
    }

    // 5/6. CORRIGER le champ de facture rejeté -- CORRECTIF v1.4 :
    // contrairement à la commande, la FACTURE doit être corrigible.
    const addressField = inputById(container, "invoice-address-line-1");
    assert.ok(addressField, "le champ adresse de facture doit rester éditable pendant l'attente");
    setNativeValue(addressField!, "42 rue Corrigée");
    await flush();

    // 7. Reprise -- envoie la valeur CORRIGÉE.
    shouldFail = false;
    const retryBtn = buttonWithText(container, "Réessayer la demande de facture")!;
    click(retryBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après reprise corrigée");

    // 8. Même orderId/publicToken sur les deux appels fetch.
    assert.equal(invoicePayloads.length, 2, "2 appels fetch (échec initial + reprise corrigée réussie)");
    assert.equal(invoicePayloads[0].orderId, ORDER_ID);
    assert.equal(invoicePayloads[1].orderId, ORDER_ID, "la reprise doit réutiliser EXACTEMENT le même orderId");
    assert.equal(invoicePayloads[1].publicToken, TOKEN, "la reprise doit réutiliser EXACTEMENT le même publicToken");

    // 9. La reprise envoie la valeur CORRIGÉE, JAMAIS l'ancienne
    // valeur rejetée -- CŒUR du correctif v1.4 (Cat Woman
    // INVOICE-V13-RETRY-CORRECTION-01) : v1.3 aurait renvoyé "12 rue
    // Test" indéfiniment, rendant la récupération impossible.
    assert.equal(invoicePayloads[1].addressLine1, "42 rue Corrigée", "la reprise DOIT envoyer la valeur CORRIGÉE par le client, jamais l'ancienne valeur rejetée gelée");
    assert.notEqual(invoicePayloads[1].addressLine1, invoicePayloads[0].addressLine1, "la valeur de reprise doit différer de la valeur initialement rejetée");

    // Le message WhatsApp ne doit JAMAIS contenir la note modifiée après coup (LA COMMANDE reste gelée).
    assert.ok(capturedWhatsAppUrl, "une URL WhatsApp doit avoir été construite");
    const decodedUrl = decodeURIComponent(capturedWhatsAppUrl!);
    assert.ok(!decodedUrl.includes("Note modifiée APRÈS l'échec"), "le message WhatsApp ne doit JAMAIS contenir une note modifiée après la création de la commande -- LA COMMANDE reste gelée, contrairement à la facture");

    // create_order n'a JAMAIS été rappelé, malgré la modification de quantité et la correction de facture.
    assert.equal(createOrderCalls.count, 1, "create_order ne doit JAMAIS être rappelé, même après correction de la facture pendant l'attente");

    // Un seul appel WhatsApp -- jamais un doublon.
    assert.equal(whatsappOpenCount, 1, "WhatsApp ne doit s'ouvrir qu'une seule fois");

    // Une seule ligne de facture -- upsert déterministe SQL (77/77, harnais dédié) ; exactement 2 appels réseau (échec + succès corrigé), jamais plus.
    assert.equal(invoicePayloads.length, 2);

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("FULFILLMENT-FREEZE. changement de mode de fulfillment (pickup -> delivery) PENDANT une reprise en attente -- la reprise réussie utilise le CONTEXTE GELÉ (pickup), JAMAIS le mode changé en direct (mandat v1.3 refresh, points 11/12)", async (t) => {
  const createOrderCalls = mockRpc(t);
  let shouldFail = true;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    if (shouldFail) return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  let capturedWhatsAppUrl: string | null = null;
  (window as any).open = (url: string) => { capturedWhatsAppUrl = url; return {}; };

  // Commande créée en mode PICKUP, la persistance de facture échoue.
  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "échec initial attendu");
    assert.equal(createOrderCalls.count, 1, "commande créée une seule fois, en mode pickup");

    // Changement de mode EN DIRECT vers "Livraison" pendant l'attente
    // -- représente un client qui, après l'échec, change d'avis pour
    // sa PROCHAINE commande potentielle (le formulaire reste
    // interactif, mandat : "Do not silently discard user edits").
    const deliveryBtn = buttonWithText(container, "Livraison");
    if (deliveryBtn) {
      click(deliveryBtn);
      await flush();
    }

    // Reprise -- doit réussir et utiliser le contexte GELÉ (pickup),
    // jamais le mode "delivery" sélectionné en direct après l'échec.
    shouldFail = false;
    const retryBtn = buttonWithText(container, "Réessayer la demande de facture")!;
    assert.ok(retryBtn, "le bouton de reprise doit rester accessible même après un changement de mode en direct");
    click(retryBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après reprise");

    // Le message WhatsApp DOIT référencer le mode GELÉ (pickup),
    // JAMAIS le mode changé en direct (delivery) après l'échec.
    assert.ok(capturedWhatsAppUrl, "une URL WhatsApp doit avoir été construite");
    const decodedUrl = decodeURIComponent(capturedWhatsAppUrl!);
    assert.ok(decodedUrl.includes("retrait sur place") || decodedUrl.includes("Pickup"), "le message WhatsApp doit référencer le mode PICKUP gelé au moment de la création de la commande");
    assert.ok(!decodedUrl.includes("Livraison —") && !decodedUrl.includes("Delivery —"), "le message WhatsApp ne doit JAMAIS référencer le mode 'delivery' sélectionné en direct après l'échec -- seul le contexte gelé au moment de create_order compte");

    // create_order n'a JAMAIS été rappelé, malgré le changement de mode.
    assert.equal(createOrderCalls.count, 1, "create_order ne doit JAMAIS être rappelé, même après un changement de mode de fulfillment pendant l'attente");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("OVERLAP. sélection explicite de fulfillment (autoscroll v1.1) + facture rejetée puis corrigée -- AUCUNE régression d'autoscroll, reprise avec valeur corrigée fonctionne, create_order/WhatsApp exactement une fois (mandat v1.4 refresh, scénario combiné)", async (t) => {
  const createOrderCalls = mockRpc(t);
  const invoicePayloads: Array<Record<string, unknown>> = [];
  let shouldFail = true;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    invoicePayloads.push(body);
    if (shouldFail) return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  let whatsappOpenCount = 0;
  (window as any).open = () => { whatsappOpenCount += 1; return {}; };

  // FULFILLMENT CHOICE AUTOSCROLL v1.1 : trace les appels
  // scrollIntoView (absent nativement de jsdom, jamais un no-op --
  // voir le garde-fou de type déjà présent dans CartPanel.tsx) pour
  // prouver qu'AUCUNE boucle de défilement répétée ne se produit.
  let scrollIntoViewCallCount = 0;
  (window.HTMLElement.prototype as any).scrollIntoView = function () {
    scrollIntoViewCallCount += 1;
  };

  // 1/2. `renderFillPickupCheckInvoiceAndReachSubmit` sélectionne déjà
  // le mode "À emporter" de façon EXPLICITE (clic réel), exerçant le
  // même chemin que le compteur `fulfillmentSelectionSeq` --
  // déclenche l'autoscroll v1.1 exactement comme en production.
  const { container, root, submitBtn } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    // L'autoscroll doit s'être déclenché AU PLUS une fois pour cette
    // unique sélection explicite -- jamais une boucle répétée.
    const scrollCallsAfterSelection = scrollIntoViewCallCount;
    assert.ok(scrollCallsAfterSelection <= 1, `l'autoscroll ne doit se déclencher qu'au plus une fois par sélection explicite, obtenu ${scrollCallsAfterSelection}`);

    // 3. Créer la commande, la persistance de facture échoue.
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "échec initial attendu");
    assert.equal(createOrderCalls.count, 1, "create_order appelé une seule fois");

    // Aucun défilement supplémentaire déclenché par l'échec de facture
    // lui-même (l'échec n'est PAS une sélection de fulfillment).
    assert.equal(scrollIntoViewCallCount, scrollCallsAfterSelection, "l'échec de facture ne doit JAMAIS déclencher un défilement supplémentaire");

    // 4. Corriger le champ de facture rejeté.
    const addressField = inputById(container, "invoice-address-line-1");
    assert.ok(addressField, "le champ adresse de facture doit rester éditable");
    setNativeValue(addressField!, "7 rue Overlap Corrigée");
    await flush();

    // 5. Reprise -- envoie la valeur corrigée.
    shouldFail = false;
    click(buttonWithText(container, "Réessayer la demande de facture")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après reprise corrigée");

    // 6/7. Même orderId/publicToken, valeur corrigée effectivement envoyée.
    assert.equal(invoicePayloads.length, 2);
    assert.equal(invoicePayloads[1].orderId, ORDER_ID);
    assert.equal(invoicePayloads[1].publicToken, TOKEN);
    assert.equal(invoicePayloads[1].addressLine1, "7 rue Overlap Corrigée", "la reprise doit envoyer la valeur CORRIGÉE");

    // 8. create_order reste appelé une seule fois au total.
    assert.equal(createOrderCalls.count, 1, "create_order ne doit JAMAIS être rappelé, y compris dans ce scénario combiné avec autoscroll");

    // 9/10. WhatsApp exactement une fois.
    assert.equal(whatsappOpenCount, 1, "WhatsApp ne doit s'ouvrir qu'une seule fois");

    // 11. Aucune régression d'autoscroll -- aucun appel scrollIntoView
    // supplémentaire déclenché par la correction/reprise de facture
    // elle-même (ce n'est jamais une nouvelle sélection de fulfillment).
    assert.equal(scrollIntoViewCallCount, scrollCallsAfterSelection, "la correction/reprise de facture ne doit JAMAIS déclencher un défilement supplémentaire");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
    delete (window.HTMLElement.prototype as any).scrollIntoView;
  }
});


// ====================================================================
// LOT EMAIL VALIDATION v1 (Claude Monet) — preuves comportementales
// bout en bout, même patron que les tests ci-dessus.
// ====================================================================

test("EMAIL-VALIDATION-CUSTOMER. email client au format invalide bloque le checkout -- bouton d'envoi absent, réapparaît après correction, un seul create_order au total", async (t) => {
  const createOrderCalls = mockRpcEmailRequired(t);
  const realOpen = window.open;
  (window as any).open = () => ({});

  const restaurant = sanaaCookiesRestaurant();
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();
  try {
    const addBtn = buttonWithText(container, "Ajouter");
    assert.ok(addBtn, "le bouton Ajouter doit être présent");
    click(addBtn!);
    await flush();
    const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
    if (cartBar) { click(cartBar); await flush(); }
    selectServiceMode(container, "À emporter");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");

    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await waitFor(() => inputById(container, "email") !== null, "champ email client rendu (requis via PICKUP_REQS_WITH_EMAIL)");

    // Email au format structurellement invalide (mandat, exemple exact : "emmanuel@aulaitcru").
    setNativeValue(inputById(container, "email")!, "emmanuel@aulaitcru");
    await flush(50);
    await flush();
    assert.equal(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      undefined,
      "le bouton d'envoi ne doit JAMAIS apparaître tant que l'email client reste au format invalide"
    );

    // Correction -- email valide (mandat, exemple exact accepté).
    setNativeValue(inputById(container, "email")!, "emmanuel@aulaitcru.fr");
    await flush(50);
    await flush();
    const submitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
    assert.ok(submitBtn, "le bouton d'envoi doit réapparaître dès que l'email client corrigé est structurellement valide");

    click(submitBtn!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après correction");
    assert.equal(createOrderCalls.count, 1, "un seul appel create_order, après correction uniquement -- jamais tenté tant que l'email était invalide");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
  }
});

test("EMAIL-VALIDATION-INVOICE. email de contact facture (société) au format invalide bloque l'envoi de la facture -- bouton d'envoi absent, réapparaît après correction, aucun appel fetch tenté avec la valeur invalide", async (t) => {
  mockRpc(t);
  let fetchCallCount = 0;
  const fetchBodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    fetchCallCount += 1;
    fetchBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    // Bascule sur "Société" -- seul type affichant le champ email de contact.
    const companyRadio = [...container.querySelectorAll('input[type="radio"]')]
      .find((el) => (el as HTMLInputElement).closest("label")?.textContent?.includes("Société")) as HTMLInputElement;
    assert.ok(companyRadio, "le bouton radio Société doit être présent");
    toggleCheckbox(companyRadio);
    await flush();
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "ACME SARL");
    await waitFor(() => inputById(container, "invoice-contact-email") !== null, "champ email de contact facture rendu (type société)");

    // Email de contact au format structurellement invalide.
    setNativeValue(inputById(container, "invoice-contact-email")!, "emmanuel@aulaitcru");
    await flush(50);
    await flush();
    assert.equal(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      undefined,
      "le bouton d'envoi ne doit JAMAIS apparaître tant que l'email de contact facture reste au format invalide"
    );

    // Correction -- email valide.
    setNativeValue(inputById(container, "invoice-contact-email")!, "facturation@entreprise.com");
    await flush(50);
    await flush();
    const submitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
    assert.ok(submitBtn, "le bouton d'envoi doit réapparaître dès que l'email de contact facture corrigé est structurellement valide");

    click(submitBtn!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après correction");
    assert.equal(fetchCallCount, 1, "un seul appel fetch (facture), envoyé uniquement après correction");
    assert.equal(fetchBodies[0].contactEmail, "facturation@entreprise.com", "la valeur envoyée doit être la valeur CORRIGÉE, jamais l'ancienne valeur invalide");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("EMAIL-VALIDATION-RETRY. facture société avec email de contact, échec réseau PUIS correction de l'email ET reprise -- même orderId/publicToken, create_order jamais rappelé, valeur d'email CORRIGÉE envoyée sur la reprise, une seule ouverture WhatsApp", async (t) => {
  const createOrderCalls = mockRpc(t);
  const invoicePayloads: Array<Record<string, unknown>> = [];
  let shouldFail = true;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    invoicePayloads.push(body);
    if (shouldFail) return new Response(JSON.stringify({ outcome: "unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  };
  const realOpen = window.open;
  let whatsappOpenCount = 0;
  (window as any).open = () => { whatsappOpenCount += 1; return {}; };

  const { container, root } = await renderFillPickupCheckInvoiceAndReachSubmit();
  try {
    const companyRadio = [...container.querySelectorAll('input[type="radio"]')]
      .find((el) => (el as HTMLInputElement).closest("label")?.textContent?.includes("Société")) as HTMLInputElement;
    assert.ok(companyRadio, "le bouton radio Société doit être présent");
    toggleCheckbox(companyRadio);
    await flush();
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "ACME SARL");
    await waitFor(() => inputById(container, "invoice-contact-email") !== null, "champ email de contact facture rendu");
    // Email VALIDE côté client dès le premier envoi -- l'échec simulé
    // ici est un échec RÉSEAU/SERVEUR (outcome "unavailable"), jamais
    // un rejet de format (déjà couvert par EMAIL-VALIDATION-INVOICE).
    setNativeValue(inputById(container, "invoice-contact-email")!, "old-contact@example.com");
    await flush(50);
    await flush();

    const submitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!;
    assert.ok(submitBtn, "le bouton d'envoi doit être atteignable avec un email de contact valide");
    click(submitBtn);
    await waitFor(() => container.textContent?.includes("Réessayer la demande de facture") ?? false, "échec initial attendu (réseau/serveur, pas un rejet de format)");
    assert.equal(createOrderCalls.count, 1, "une seule commande créée jusqu'ici");

    // Correction de l'email de contact PENDANT l'attente -- toujours
    // éditable (mandat CORRECTIF v1.4, étendu ici à l'email).
    setNativeValue(inputById(container, "invoice-contact-email")!, "new-contact@example.com");
    await flush();

    shouldFail = false;
    const retryBtn = buttonWithText(container, "Réessayer la demande de facture")!;
    click(retryBtn);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue après reprise avec email corrigé");

    assert.equal(invoicePayloads.length, 2, "2 appels fetch (échec initial + reprise corrigée réussie)");
    assert.equal(invoicePayloads[0].orderId, ORDER_ID);
    assert.equal(invoicePayloads[1].orderId, ORDER_ID, "la reprise doit réutiliser EXACTEMENT le même orderId");
    assert.equal(invoicePayloads[1].publicToken, TOKEN, "la reprise doit réutiliser EXACTEMENT le même publicToken");
    assert.equal(invoicePayloads[0].contactEmail, "old-contact@example.com");
    assert.equal(invoicePayloads[1].contactEmail, "new-contact@example.com", "la reprise DOIT envoyer l'email de contact CORRIGÉ, jamais l'ancienne valeur");
    assert.equal(createOrderCalls.count, 1, "create_order ne doit JAMAIS être rappelé, même après correction de l'email de contact pendant l'attente");
    assert.equal(whatsappOpenCount, 1, "WhatsApp ne doit s'ouvrir qu'une seule fois -- jamais un doublon");

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
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
