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
// Scanym — CUSTOMER BILLING PROFILE v2 (Claude Monet)
// Preuve COMPORTEMENTALE : MenuView réellement monté, `supabase.rpc`
// et `fetch` réellement interceptés, interactions réelles jusqu'à la
// charge utile effectivement envoyée. Harnais repris de
// tests/checkout-invoice-request-reliability.dom.test.ts.
//
// Ce que ce fichier prouve, et que la logique pure ne peut pas prouver
// seule :
//   - PARTICULIER : prénom et nom séparés, préremplis depuis le client
//     de la commande, recomposés dans le champ de contact existant ;
//   - SOCIÉTÉ : SIREN et TVA affichés UNIQUEMENT en mode Société, tous
//     deux annonçant leur optionalité, et une commande valide SANS
//     aucun des deux ;
//   - la saisie du client part telle quelle (espaces internes
//     compris) : aucune « correction » en route ;
//   - aucun champ SIRET n'est rendu, jamais ;
//   - le texte d'explication du commerçant s'affiche s'il est
//     configuré, et RIEN ne s'affiche sinon.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
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
const { supabase } = await import("../lib/supabase.ts");

const REPO_ROOT = process.cwd();

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      const resolvedPath = candidate ?? base;
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as MenuView } from "@/components/MenuView";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-billing-v2-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0]!.text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Utilitaires DOM (mêmes que le harnais checkout existant)
// ------------------------------------------------------------------

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(check: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout : ${description}`);
    await flush(10);
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
function toggleCheckbox(el: HTMLInputElement) {
  el.click();
}
function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}
function inputById(container: Element, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}
function labelFor(container: Element, id: string): string {
  return container.querySelector(`label[for="${id}"]`)?.textContent ?? "";
}

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

function restaurantFixture() {
  return {
    id: "r-billing-v2",
    name: "Établissement d'essai",
    slug: "etablissement-essai",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r-billing-v2",
      max_tables: 10,
      currency: "EUR",
      whatsapp_number: "+33600000000",
      address: null, latitude: null, longitude: null,
      logo_url: null, cover_url: null, opening_hours: null,
      source_language: "fr",
    },
    categories: [{
      id: "cat-1", restaurant_id: "r-billing-v2", name: "Boutique", display_order: 1, is_active: true,
      menu_items: [{
        id: "item-1", category_id: "cat-1", name: "Coffret", description: null,
        short_description: null, price: 24, image_url: null, display_order: 1, is_available: true,
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
const SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];
/** Mode suivi : le serveur expose `first_name`/`last_name` -- c'est
 *  ce catalogue de champs, et lui seul, qui fait autorité. */
const PICKUP_REQS = [
  { field: "first_name", requirement: "required", one_of_group: null },
  { field: "last_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
];

/** `communicationTexts` : rendu exactement comme la projection
 *  publique le renvoie (text_key / body). Vide = aucun texte
 *  configuré, l'état de tout établissement avant configuration. */
function mockRpc(
  t: { mock: { method: Function } },
  options: { communicationTexts?: Array<{ text_key: string; body: string }> } = {},
  createOrderCalls: { count: number } = { count: 0 }
) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      if (args.p_mode_code === "pickup") return { data: PICKUP_REQS, error: null };
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    // CSDJ-2 / #158 : lecture publique des dates/créneaux, servie « absent »
    // (aucun calendrier = parcours d'avant). Sans réponse VALIDE le checkout
    // ne laisse plus partir la commande (fail-closed) : le mock doit donc la servir.
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
    if (name === "get_restaurant_public_communication_texts") {
      return { data: options.communicationTexts ?? [], error: null };
    }
    if (name === "create_order") {
      createOrderCalls.count += 1;
      return {
        data: [{ order_id: ORDER_ID, order_number: 7, public_token: TOKEN, total: 24, subtotal: 24, delivery_fee: 0 }],
        error: null,
      };
    }
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return createOrderCalls;
}

function withWithdrawalEligibilityClosed(inner: (...args: any[]) => any) {
  return async (...args: any[]) => {
    const first: any = args[0];
    const url = String(first instanceof URL ? first.href : first?.url ?? first);
    // PAYMENT P4-A (MODIFIÉ) : après create_order, la boutique demande désormais au
    // serveur si un paiement en ligne est requis (POST /api/payments/monetico/checkout).
    // Ce harnais répond « non » : parcours historique inchangé.
    if (url.includes("/api/payments/monetico/checkout")) {
      return new Response(JSON.stringify({ outcome: "checkout_not_needed", reason: "not_required" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/checkout/withdrawal-eligibility")) {
      return new Response(JSON.stringify({ eligible: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(...args);
  };
}

/** Monte le menu, ajoute un article, choisit le retrait, saisit
 *  prénom/nom/téléphone du CLIENT, puis coche « Besoin d'une
 *  facture ? » et renseigne l'adresse de facturation. */
async function reachBillingBlock() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: restaurantFixture() }));
  await flush();

  click(buttonWithText(container, "Ajouter")!);
  await flush();
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  if (cartBar) { click(cartBar); await flush(); }

  click(buttonWithText(container, "À emporter")!);
  await waitFor(() => inputById(container, "first_name") !== null, "champs client rendus");
  setNativeValue(inputById(container, "first_name")!, "Victor");
  setNativeValue(inputById(container, "last_name")!, "Hugo");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  await flush(50);

  const invoiceCheckbox = [...container.querySelectorAll('input[type="checkbox"]')]
    .find((el) => el.closest("label")?.textContent?.includes("Besoin d'une facture"));
  assert.ok(invoiceCheckbox, "la case de demande de facture doit être présente");
  toggleCheckbox(invoiceCheckbox as HTMLInputElement);
  await waitFor(() => inputById(container, "invoice-address-line-1") !== null, "champs de facturation rendus");

  setNativeValue(inputById(container, "invoice-address-line-1")!, "6 place des Vosges");
  setNativeValue(inputById(container, "invoice-city")!, "Paris");
  setNativeValue(inputById(container, "invoice-postal-code")!, "75004");
  await flush(50);

  return { container, root };
}

async function selectCompany(container: Element) {
  const companyRadio = [...container.querySelectorAll('input[type="radio"]')]
    .find((el) => (el as HTMLInputElement).closest("label")?.textContent?.includes("Société")) as HTMLInputElement;
  assert.ok(companyRadio, "le bouton radio Société doit être présent");
  toggleCheckbox(companyRadio);
  await flush(50);
}

// ==================================================================
// 1. PARTICULIER
// ==================================================================

test("particulier (type par défaut) : prénom et nom de facturation sont rendus, le nom de la commande servant d'indication", async (t) => {
  mockRpc(t);
  const { container, root } = await reachBillingBlock();
  try {
    const first = inputById(container, "invoice-first-name");
    const last = inputById(container, "invoice-last-name");
    assert.ok(first, "le prénom de facturation doit être rendu");
    assert.ok(last, "le nom de facturation doit être rendu");

    // Les champs restent VIDES : rien n'est recopié en silence dans
    // l'état du formulaire. Le prénom/nom déjà donné pour la commande
    // est MONTRÉ en indication -- le client voit ce qui sera retenu
    // s'il n'écrit rien, et peut écrire autre chose.
    assert.equal(first!.value, "");
    assert.equal(last!.value, "");
    assert.equal(first!.placeholder, "Victor");
    assert.equal(last!.placeholder, "Hugo");

    // Et AUCUN champ société n'est visible en mode particulier.
    assert.equal(inputById(container, "invoice-company-legal-name"), null);
    assert.equal(inputById(container, "invoice-siren"), null);
    assert.equal(inputById(container, "invoice-vat-number"), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("particulier : une saisie de facturation explicite PRÉVAUT sur le nom de la commande", async (t) => {
  mockRpc(t);
  const payloads: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async (_u: string, init: any) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  });
  (window as any).open = () => ({});

  const { container, root } = await reachBillingBlock();
  try {
    setNativeValue(inputById(container, "invoice-first-name")!, "Juliette");
    setNativeValue(inputById(container, "invoice-last-name")!, "Drouet");
    await flush(50);
    // La valeur saisie reste la sienne, quoi qu'il arrive au nom de la
    // commande ensuite.
    setNativeValue(inputById(container, "first_name")!, "Victor-Marie");
    await flush(50);
    assert.equal(inputById(container, "invoice-first-name")!.value, "Juliette");
    assert.equal(inputById(container, "invoice-last-name")!.value, "Drouet");

    click(buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");
    assert.equal(payloads[0]!.contactName, "Juliette Drouet", "la saisie du client prévaut");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("particulier : la charge utile porte le nom RECOMPOSÉ (repli sur la commande), et aucun SIREN", async (t) => {
  mockRpc(t);
  const payloads: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async (_u: string, init: any) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  });
  (window as any).open = () => ({});

  const { container, root } = await reachBillingBlock();
  try {
    click(buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");
    assert.equal(payloads.length, 1);
    const body = payloads[0]!;
    assert.equal(body.invoiceType, "individual");
    assert.equal(
      body.contactName,
      "Victor Hugo",
      "champs de facturation laissés vides -> repli sur le prénom/nom de la commande, recomposé dans le champ existant"
    );
    assert.equal(body.siren, null, "aucun SIREN pour un particulier");
    assert.ok(!("siret" in body), "aucune clé SIRET, jamais");
    assert.ok(!("firstName" in body) && !("lastName" in body), "aucun second concept de nom n'est transmis");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// ==================================================================
// 2. SOCIÉTÉ — optionalité visible, aucun SIRET
// ==================================================================

test("société : raison sociale, SIREN et TVA apparaissent, et les deux identifiants s'annoncent OPTIONNELS", async (t) => {
  mockRpc(t);
  const { container, root } = await reachBillingBlock();
  try {
    await selectCompany(container);
    assert.ok(inputById(container, "invoice-company-legal-name"), "raison sociale rendue");
    assert.ok(inputById(container, "invoice-siren"), "SIREN rendu");
    assert.ok(inputById(container, "invoice-vat-number"), "TVA rendue");

    // L'optionalité est VISIBLE, dans le libellé du champ lui-même.
    assert.match(labelFor(container, "invoice-siren"), /optionnel/i);
    assert.match(labelFor(container, "invoice-vat-number"), /optionnel/i);

    // …et une ligne d'aide dit explicitement qu'aucun SIRET n'est
    // demandé.
    const hint = container.querySelector("[data-invoice-identifiers-optional]");
    assert.ok(hint, "la ligne d'aide des identifiants doit être rendue");
    assert.match(hint!.textContent ?? "", /facultatifs/i);
    assert.match(hint!.textContent ?? "", /Aucun SIRET/i);

    // AUCUN champ SIRET n'existe dans tout le formulaire.
    assert.equal(container.querySelector('[id*="siret" i]'), null);
    assert.ok(!/SIRET\s*:/i.test(container.textContent ?? ""));

    // Les champs PARTICULIER se retirent (aucun doublon de nom).
    assert.equal(inputById(container, "invoice-first-name"), null);
    assert.equal(inputById(container, "invoice-last-name"), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("société SANS SIREN NI TVA : la commande aboutit, les deux champs partent à null", async (t) => {
  mockRpc(t);
  const payloads: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async (_u: string, init: any) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  });
  (window as any).open = () => ({});

  const { container, root } = await reachBillingBlock();
  try {
    await selectCompany(container);
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "Maison Hugo SARL");
    await flush(50);
    click(buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");

    const body = payloads[0]!;
    assert.equal(body.invoiceType, "company");
    assert.equal(body.companyLegalName, "Maison Hugo SARL");
    assert.equal(body.siren, null, "SIREN absent -> null, jamais un blocage");
    assert.equal(body.vatNumber, null, "TVA absente -> null, jamais un blocage");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("société : le SIREN saisi part TEL QUEL -- espaces internes compris, aucune « correction »", async (t) => {
  mockRpc(t);
  const payloads: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async (_u: string, init: any) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  });
  (window as any).open = () => ({});

  const { container, root } = await reachBillingBlock();
  try {
    await selectCompany(container);
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "Maison Hugo SARL");
    setNativeValue(inputById(container, "invoice-siren")!, " 123 456 789 ");
    setNativeValue(inputById(container, "invoice-vat-number")!, "fr12345678901");
    await flush(50);
    click(buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");

    const body = payloads[0]!;
    // Seul le blanc de BORDURE est retiré (convention de tous les
    // champs optionnels depuis v1.1) : ni espaces internes retirés,
    // ni casse modifiée, ni chiffres « complétés ».
    assert.equal(body.siren, "123 456 789");
    assert.equal(body.vatNumber, "fr12345678901");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// ==================================================================
// 3. TEXTE D'EXPLICATION CONFIGURABLE PAR LE COMMERÇANT
// ==================================================================

test("texte marchand : non configuré -> AUCUN bloc rendu (checkout identique à avant ce lot)", async (t) => {
  mockRpc(t, { communicationTexts: [] });
  const { container, root } = await reachBillingBlock();
  try {
    assert.equal(
      container.querySelector("[data-invoice-merchant-explanation]"),
      null,
      "aucun paragraphe, jamais un bloc vide"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("texte marchand : configuré -> rendu TEL QUEL dans le bloc de facturation", async (t) => {
  const MERCHANT_TEXT =
    "Pour une facture au nom de votre société, indiquez sa raison sociale ; le SIREN et la TVA restent facultatifs.";
  mockRpc(t, {
    communicationTexts: [{ text_key: "billing_profile_explanation", body: MERCHANT_TEXT }],
  });
  const { container, root } = await reachBillingBlock();
  try {
    const block = container.querySelector("[data-invoice-merchant-explanation]");
    assert.ok(block, "le paragraphe du commerçant doit être rendu");
    assert.equal(block!.textContent, MERCHANT_TEXT);
    // Texte BRUT : rendu comme un nœud texte, jamais interprété.
    assert.equal(block!.querySelector("*"), null, "aucun balisage interprété");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("texte marchand : un autre emplacement ne s'affiche PAS dans le bloc de facturation", async (t) => {
  // Preuve d'étanchéité des emplacements : `checkout_info` est un
  // emplacement voisin du même catalogue, il n'a rien à faire ici.
  mockRpc(t, {
    communicationTexts: [{ text_key: "checkout_info", body: "Texte d'un AUTRE emplacement." }],
  });
  const { container, root } = await reachBillingBlock();
  try {
    assert.equal(container.querySelector("[data-invoice-merchant-explanation]"), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// CBP-01 (HIGH) — bascule de type DANS L'INTERFACE RÉELLE, puis envoi.
// La preuve qui compte : ce que la charge utile porte après que le
// client a réellement changé de mode.
// ==================================================================

test("[CBP-01-B/DOM] particulier Alice Martin -> bascule SOCIÉTÉ, contact Bob Durand => la charge utile porte « Bob Durand »", async (t) => {
  mockRpc(t);
  const payloads: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async (_u: string, init: any) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  });
  (window as any).open = () => ({});

  const { container, root } = await reachBillingBlock();
  try {
    // 1/2. Mode PARTICULIER : le client saisit Alice Martin.
    setNativeValue(inputById(container, "invoice-first-name")!, "Alice");
    setNativeValue(inputById(container, "invoice-last-name")!, "Martin");
    await flush(50);

    // 3/4. Bascule en SOCIÉTÉ, puis saisie du contact VISIBLE.
    await selectCompany(container);
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "ACME SARL");
    setNativeValue(inputById(container, "invoice-contact-name")!, "Bob Durand");
    await flush(50);

    // Les champs particulier ne sont plus montés -- leur état, lui,
    // subsiste : c'est exactement la situation de l'audit.
    assert.equal(inputById(container, "invoice-first-name"), null);

    // 5. Envoi.
    click(buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.invoiceType, "company");
    assert.equal(payloads[0]!.contactName, "Bob Durand", "le contact VISIBLE prévaut sur l'état caché du mode particulier");
    assert.notEqual(payloads[0]!.contactName, "Alice Martin");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

test("[CBP-01-C/DOM] société Bob Durand -> bascule PARTICULIER, saisie Carol Dupont => la charge utile porte « Carol Dupont »", async (t) => {
  mockRpc(t);
  const payloads: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async (_u: string, init: any) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ outcome: "ok" }), { status: 200 });
  });
  (window as any).open = () => ({});

  const { container, root } = await reachBillingBlock();
  try {
    await selectCompany(container);
    setNativeValue(inputById(container, "invoice-company-legal-name")!, "ACME SARL");
    setNativeValue(inputById(container, "invoice-contact-name")!, "Bob Durand");
    await flush(50);

    // Retour en PARTICULIER : saisie explicite Carol Dupont.
    const individualRadio = [...container.querySelectorAll('input[type="radio"]')]
      .find((el) => (el as HTMLInputElement).closest("label")?.textContent?.includes("Particulier")) as HTMLInputElement;
    assert.ok(individualRadio, "le bouton radio Particulier doit être présent");
    toggleCheckbox(individualRadio);
    await flush(50);
    setNativeValue(inputById(container, "invoice-first-name")!, "Carol");
    setNativeValue(inputById(container, "invoice-last-name")!, "Dupont");
    await flush(50);

    click(buttonWithText(container, "Enregistrer et continuer sur WhatsApp")!);
    await waitFor(() => container.textContent?.includes("Commande envoyée avec succès") ?? false, "confirmation attendue");

    assert.equal(payloads[0]!.invoiceType, "individual");
    assert.equal(payloads[0]!.contactName, "Carol Dupont");
    assert.notEqual(payloads[0]!.contactName, "Bob Durand");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// Démontage du harnais : même séquence que
// tests/checkout-invoice-request-reliability.dom.test.ts -- sans
// elle, la boucle d'animation de jsdom garde le processus vivant et
// le FICHIER expire alors que tous ses tests ont réussi.
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
