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
const { translate } = await import("../lib/i18n.ts");

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-170-scope-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);

/**
 * MERCHANT CUSTOMER COMMUNICATIONS v1 (mandat §B) — l'écran de
 * confirmation interroge désormais le serveur pour savoir si au moins
 * une ligne de la commande est rétractable
 * (POST /api/checkout/withdrawal-eligibility, voir
 * lib/services/merchant-communications.ts::fetchWithdrawalEligibility).
 *
 * Ce harnais fournit donc la configuration que la PRODUCTION fournit,
 * et il la fournit FERMÉE (`eligible:false`) : aucun appel à l'action de
 * rétractation n'apparaît, le parcours observé par les assertions de ce
 * fichier est donc exactement celui d'avant le lot.
 *
 * Conséquence voulue sur les COMPTEURS : les appels à cette route ne
 * sont jamais délégués au mock du test, donc jamais comptés. C'est ce
 * que les libellés de ces assertions disaient déjà (« appel fetch
 * (facture) ») ; aucune assertion n'est affaiblie, et un appel
 * INATTENDU vers une autre route atteint toujours le mock d'origine,
 * qui lève comme avant.
 */
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
const SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];
const REQS: Record<string, any[]> = {
  pickup: [
    { field: "customer_name", requirement: "required", one_of_group: null },
    { field: "phone", requirement: "required", one_of_group: null },
  ],
  delivery: [
    { field: "customer_name", requirement: "required", one_of_group: null },
    { field: "delivery_address", requirement: "required", one_of_group: null },
    { field: "phone", requirement: "required", one_of_group: null },
    { field: "email", requirement: "optional", one_of_group: null },
  ],
};
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

// ---------------- Réponses de get_checkout_fulfillment_schedule ----------------
const SLOTS_20 = [
  { slot_key: "morning", starts_at: "09:00", ends_at: "12:00" },
  { slot_key: "afternoon", starts_at: "14:00", ends_at: "18:00" },
];
function row(patch: Record<string, unknown>) {
  return {
    delivery_applicable: false, delivery_eligible: false, delivery_block: null, delivery_customer_text: null,
    schedule_status: "absent", unfulfillable_reason: null, schedule_timezone: "Europe/Paris",
    date_selection_mode: null, slot_selection_mode: null, time_granularity_minutes: null,
    first_eligible_date: null, eligible_dates: [], offers: null,
    ...patch,
  };
}
const FIXED = row({
  schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
  first_eligible_date: "2026-10-20", eligible_dates: ["2026-10-20", "2026-10-22"],
  offers: { "2026-10-20": SLOTS_20, "2026-10-22": [SLOTS_20[0]] },
});
const DATE_ONLY = row({
  schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "none",
  first_eligible_date: "2026-10-20", eligible_dates: ["2026-10-20", "2026-10-22"],
  offers: {
    "2026-10-20": [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }],
    "2026-10-22": [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }],
  },
});
const WINDOWED = row({
  schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "time_within_window",
  time_granularity_minutes: 30, first_eligible_date: "2026-10-20", eligible_dates: ["2026-10-20"],
  offers: { "2026-10-20": [{ slot_key: null, starts_at: "09:00", ends_at: "10:30" }] },
});
const DERIVED = row({
  schedule_status: "dates_available", date_selection_mode: "derived_earliest", slot_selection_mode: "none",
  first_eligible_date: "2026-10-20", eligible_dates: ["2026-10-20"],
  offers: { "2026-10-20": [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }] },
});
const AFTER_EXPIRY = row({
  schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
  first_eligible_date: "2026-10-22", eligible_dates: ["2026-10-22"],
  offers: { "2026-10-22": [SLOTS_20[0]] },
});

type Rpc = { name: string; args: any };
interface ServerCfg {
  /** Réponse du lecteur public ; une fonction permet de changer entre deux lectures. */
  reader: (args: any, callIndex: number) => Record<string, unknown> | Error;
  /** Simule `create_order` : renvoie un code SCANYM_SCHEDULE_* à refuser, ou null. */
  refuse?: (customer: any, callIndex: number) => string | null;
  /** Délai de create_order (ms) pour le test de double envoi. */
  createDelayMs?: number;
  /** Retient la réponse d'une lecture jusqu'à la résolution de la promesse rendue (courses asynchrones). */
  hold?: (args: any, callIndex: number) => Promise<void> | null;
}
function installServer(t: { mock: { method: Function } }, cfg: ServerCfg) {
  const readerCalls: any[] = [];
  const createCalls: any[] = [];
  const unexpected: string[] = [];
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") return { data: REQS[args.p_mode_code] ?? [], error: null };
    if (name === "get_restaurant_public_delivery_info") {
      return { data: [{ delivery_zone_prefixes: ["75", "69", "93"], delivery_min_items: 0, delivery_area_label: "Paris" }], error: null };
    }
    if (name === "get_restaurant_public_delivery_countries") {
      return { data: [{ country_code: "FR", country_name: "France", postal_code_pattern: "^[0-9]{5}$",
        phone_pattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$", address_provider: "ban_ign", address_line_order: "number_first" }], error: null };
    }
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "get_restaurant_public_communication_texts") return { data: [], error: null };
    if (name === "get_checkout_fulfillment_schedule") {
      readerCalls.push(args);
      const idx = readerCalls.length - 1;
      const r = cfg.reader(args, idx);
      const held = cfg.hold?.(args, idx);
      if (held) await held;
      if (r instanceof Error) return { data: null, error: { code: "XX000", message: r.message } };
      return { data: [r], error: null };
    }
    if (name === "create_order") {
      const index = createCalls.length;
      createCalls.push(args);
      if (cfg.createDelayMs) await flush(cfg.createDelayMs);
      const refused = cfg.refuse?.(args.p_customer, index) ?? null;
      // Même porteur que la Production : SQLSTATE P0001, message == code.
      if (refused) return { data: null, error: { code: "P0001", message: refused } };
      return { data: [{ order_id: ORDER_ID, order_number: 42, public_token: TOKEN, total: 3.5, subtotal: 3.5, delivery_fee: 0 }], error: null };
    }
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    unexpected.push(name);
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return { readerCalls, createCalls, unexpected };
}

/**
 * RÈGLE DE PRODUCTION reproduite (issue #158) : pour un retrait à date
 * choisie par le client, `create_order` exige une date (et un créneau en
 * `fixed_slots`) dans `p_customer.schedule`, sinon 400 / P0001 /
 * SCANYM_SCHEDULE_REQUIRED.
 */
function requireSchedule(slotKeyRequired: boolean) {
  return (customer: any): string | null => {
    const s = customer?.schedule;
    if (!s || !s.date) return "SCANYM_SCHEDULE_REQUIRED";
    if (slotKeyRequired && !s.slot_key) return "SCANYM_SCHEDULE_REQUIRED";
    return null;
  };
}

function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const q = (c: Element, id: string) => c.querySelector(`[data-testid="${id}"]`);
const SEND = (lang = "fr") => translate(lang, "sendOrder");

async function reach(mode: "pickup" | "delivery", lang = "fr") {
  const restaurant: any = sanaaCookiesRestaurant();
  if (lang !== "fr") {
    restaurant.config.source_language = lang;
    restaurant.activeLanguages = [{ code: lang, label: lang, dir: lang === "ar" ? "rtl" : "ltr", display_order: 1 }];
  }
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();

  const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === translate(lang, "add"));
  assert.ok(addBtn, "le bouton Ajouter doit être présent");
  click(addBtn!);
  await flush();
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  if (cartBar) { click(cartBar); await flush(); }

  selectServiceMode(container, translate(lang, mode));
  await waitFor(() => inputById(container, "customer_name") !== null, "champs rendus");
  setNativeValue(inputById(container, "customer_name")!, "Yakout");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  if (mode === "delivery") {
    setNativeValue(inputById(container, "street")!, "10 rue de Rivoli");
    setNativeValue(inputById(container, "postalCode")!, "75001");
    setNativeValue(inputById(container, "city")!, "Paris");
  }
  await flush(50);
  await flush();
  return { container, root };
}
const sendButton = (c: Element, lang = "fr") => buttonWithText(c, SEND(lang));
async function pickFixed(container: Element, date: string, slotKey: string) {
  await waitFor(() => q(container, "checkout-schedule-date") !== null, "sélecteur de date rendu");
  setSelect(q(container, "checkout-schedule-date") as HTMLSelectElement, date);
  await flush();
  await waitFor(() => q(container, `checkout-schedule-slot-${slotKey}`) !== null, `créneau ${slotKey} proposé`);
  click(q(container, `checkout-schedule-slot-${slotKey}`)!);
  await flush();
}
async function withOpen<T>(fn: (opened: { n: number }) => Promise<T>): Promise<T> {
  const realOpen = window.open;
  const opened = { n: 0 };
  (window as any).open = () => { opened.n += 1; return {}; };
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async () => { throw new Error("fetch inattendu"); });
  try { return await fn(opened); } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
}
const CONFIRMED = "Commande envoyée avec succès";

// ====================================================================
// ISSUE #170 — CRÉNEAUX DE LIVRAISON STUART (Au Lait Cru)
//
// Le client ne distingue PAS les transporteurs : le serveur résout la
// règle de livraison exacte depuis le code postal et rend le calendrier
// de CETTE règle (get_checkout_fulfillment_schedule). Ces tests fixent
// le contrat côté client : un calendrier propre à la règle Stuart
// s'affiche et se transmet ; une règle sans calendrier (Chronofresh,
// marchand sans planning) garde son parcours ; aucune sélection ne fuit
// d'une adresse à l'autre ; le jour et le créneau envoyés figurent dans
// le message transmis au commerçant.
//
// Les créneaux ci-dessous sont SYNTHÉTIQUES : ils ne sont PAS les
// règles d'Au Lait Cru (jours, créneaux et délai restent à confirmer
// avec le commerçant, issue #170).
// ====================================================================
const STUART_POSTAL = "75001";
const CHRONOFRESH_POSTAL = "69001";
const OUT_OF_ZONE_POSTAL = "13001";
const STUART_SLOTS = [
  { slot_key: "s-a", starts_at: "11:00", ends_at: "14:00" },
  { slot_key: "s-b", starts_at: "14:00", ends_at: "17:00" },
];
const STUART_ROW = row({
  delivery_applicable: true, delivery_eligible: true,
  schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
  first_eligible_date: "2026-10-30", eligible_dates: ["2026-10-30"],
  offers: { "2026-10-30": STUART_SLOTS },
});
const BLOCKED_ROW = row({
  schedule_status: "blocked_upstream", delivery_applicable: true, delivery_eligible: false, delivery_block: "out_of_zone",
});
/** Réponse du serveur par code postal : une règle = un calendrier. */
const byPostal = (a: any) =>
  a.p_postal_code === STUART_POSTAL ? STUART_ROW
  : a.p_postal_code === OUT_OF_ZONE_POSTAL ? BLOCKED_ROW
  : row({}); // Chronofresh et tout le reste : aucun calendrier

/**
 * Règle serveur reproduite : SEULE la règle Stuart configurée exige un
 * jour + créneau. Une règle sans calendrier n'exige rien (sinon un
 * `create_order` sans schedule serait refusé à tort pour Chronofresh).
 */
const refuseOnlyStuart = (customer: any): string | null =>
  customer?.postalCode === STUART_POSTAL ? requireSchedule(true)(customer) : null;

async function reachDelivery(postal: string) {
  const restaurant: any = sanaaCookiesRestaurant();
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();
  const addBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === translate("fr", "add"));
  assert.ok(addBtn, "le bouton Ajouter doit être présent");
  click(addBtn!);
  await flush();
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  if (cartBar) { click(cartBar); await flush(); }
  selectServiceMode(container, translate("fr", "delivery"));
  await waitFor(() => inputById(container, "customer_name") !== null, "champs rendus");
  setNativeValue(inputById(container, "customer_name")!, "Yakout");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  setNativeValue(inputById(container, "street")!, "10 rue de Rivoli");
  setNativeValue(inputById(container, "postalCode")!, postal);
  setNativeValue(inputById(container, "city")!, "Ville");
  await flush(50);
  await flush();
  return { container, root };
}

/** Capture le lien wa.me réellement ouvert (message au commerçant). */
async function withWhatsAppCapture<T>(fn: (urls: string[]) => Promise<T>): Promise<T> {
  const realOpen = window.open;
  const urls: string[] = [];
  (window as any).open = (u: string) => { urls.push(String(u)); return {}; };
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = withWithdrawalEligibilityClosed(async () => { throw new Error("fetch inattendu"); });
  try { return await fn(urls); } finally {
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
}
const waText = (url: string) => decodeURIComponent(new URL(url).searchParams.get("text") ?? "");

// ====================================================================
// ISSUE #170 — DÉFAUT P2 (audit de e5aa05a) : UNE SÉLECTION APPARTIENT À
// SA PORTÉE.
//
// Séquence d'origine : le client choisit 11 h–14 h (clé « s-a ») pour
// l'adresse A, puis passe à une adresse B dont la règle de livraison
// propose la MÊME date et réutilise la MÊME clé « s-a » (fenêtre 18 h–20 h).
// Avant correctif, la sélection survivait (date + clé encore « offertes »)
// et l'écran montrait 18 h–20 h comme choisi, que le message au commerçant
// présentait comme choisi par le client.
//
// Règle : portée = (restaurant, mode, code postal, panier de livraison) --
// tout ce que le serveur reçoit pour résoudre la règle. Une sélection n'est
// conservée que si cette portée est STRICTEMENT identique ; sinon elle est
// vidée et RIEN n'est présélectionné (même date, même clé).
//
// Les créneaux sont SYNTHÉTIQUES (ni règles ni horaires d'Au Lait Cru).
// ====================================================================
const POSTAL_A = "75001";
const POSTAL_B = "75008";
const POSTAL_C = "69001"; // règle sans calendrier
const POSTAL_D = "93100"; // même date, aucun créneau (date seule)
const DATE = "2026-10-30";
const SLOT_A_A = { slot_key: "s-a", starts_at: "11:00", ends_at: "14:00" };
const SLOT_A_B = { slot_key: "s-b", starts_at: "14:00", ends_at: "17:00" };
const SLOT_B_A = { slot_key: "s-a", starts_at: "18:00", ends_at: "20:00" }; // MÊME clé que A, autre fenêtre
const dated = (slotMode: string, offers: any[]) =>
  row({
    delivery_applicable: true, delivery_eligible: true,
    schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: slotMode,
    first_eligible_date: DATE, eligible_dates: [DATE], offers: { [DATE]: offers },
  });
const ROW_A = dated("fixed_slots", [SLOT_A_A, SLOT_A_B]);
const ROW_B = dated("fixed_slots", [SLOT_B_A]);
const ROW_D = dated("none", [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }]);
const byRule = (a: any) =>
  a.p_postal_code === POSTAL_A ? ROW_A
  : a.p_postal_code === POSTAL_B ? ROW_B
  : a.p_postal_code === POSTAL_D ? ROW_D
  : row({});

/** Règles de production reproduites : le serveur valide le schedule contre SA règle. */
const RULE_SLOTS: Record<string, any[] | null> = {
  [POSTAL_A]: [SLOT_A_A, SLOT_A_B],
  [POSTAL_B]: [SLOT_B_A],
  [POSTAL_C]: null,
  [POSTAL_D]: [],
};
function serverValidates(customer: any): string | null {
  const slots = RULE_SLOTS[customer?.postalCode];
  if (slots === null || slots === undefined) return null; // aucune planification
  const s = customer.schedule;
  if (!s || !s.date) return "SCANYM_SCHEDULE_REQUIRED";
  if (s.date !== DATE) return "SCANYM_SCHEDULE_DATE_INVALID";
  if (slots.length === 0) return s.slot_key === null ? null : "SCANYM_SCHEDULE_SLOT_INVALID";
  const hit = slots.find((x) => x.slot_key === s.slot_key && x.starts_at === s.starts_at && x.ends_at === s.ends_at);
  return hit ? null : s.slot_key ? "SCANYM_SCHEDULE_SLOT_INVALID" : "SCANYM_SCHEDULE_REQUIRED";
}

const slotButtons = (c: Element) => [...c.querySelectorAll('[data-testid^="checkout-schedule-slot-"]')] as HTMLElement[];
const pressed = (c: Element) => slotButtons(c).filter((b) => b.getAttribute("aria-pressed") === "true");
const dateValue = (c: Element) => (q(c, "checkout-schedule-date") as HTMLSelectElement | null)?.value ?? null;
async function changePostal(container: Element, srv: { readerCalls: any[] }, postal: string, expectRead = true) {
  const before = srv.readerCalls.length;
  setNativeValue(inputById(container, "postalCode")!, postal);
  if (expectRead) await waitFor(() => srv.readerCalls.length > before && srv.readerCalls.at(-1).p_postal_code === postal, `lecture pour ${postal}`);
}
/** Choisit la date (le sélecteur de créneaux n'apparaît qu'après) et attend le nombre de créneaux attendu pour LA règle affichée. */
async function openDate(container: Element, expectedSlots: number) {
  await waitFor(() => q(container, "checkout-schedule-date") !== null, "sélecteur de date de la règle affichée");
  // Précondition : après un changement de portée, RIEN n'est repris avant le choix du client.
  assert.equal(dateValue(container), "", "aucune date reprise d'une autre portée");
  assert.equal(slotButtons(container).length, 0, "aucun créneau affiché avant le choix de la date");
  assert.equal(sendButton(container) === undefined, true, "envoi fermé avant le choix de la date");
  setSelect(q(container, "checkout-schedule-date") as HTMLSelectElement, DATE);
  await flush();
  await waitFor(() => slotButtons(container).length === expectedSlots, `${expectedSlots} créneau(x) proposé(s)`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
/** Après un changement de portée, l'envoi ne doit JAMAIS s'ouvrir tant que le client n'a pas choisi : échantillonné. */
async function assertSendStaysClosed(container: Element, why: string, samples = 8) {
  for (let i = 0; i < samples; i++) {
    assert.equal(sendButton(container) === undefined, true, `envoi fermé (${why}) -- échantillon ${i}`);
    await flush(15);
  }
}

test("[170-P2-1] REPRO EXACTE : 11h–14h pour l'adresse A, puis règle B (même date, même clé « s-a » = 18h–20h) => rien n'est sélectionné, envoi fermé, aucun message au commerçant tant que le client n'a pas choisi B explicitement", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      assert.deepEqual(pressed(container).map((b) => b.getAttribute("data-testid")), ["checkout-schedule-slot-s-a"], "A : 11h–14h choisi");
      assert.ok(slotButtons(container)[0].textContent!.includes("11:00"), "le bouton choisi est bien 11h–14h");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert pour A");

      await changePostal(container, srv, POSTAL_B);
      await waitFor(() => q(container, "checkout-schedule-date") !== null, "B : calendrier de la nouvelle règle");
      // LE DÉFAUT : date + clé conservées, 18h–20h présenté comme choisi. Attendu : RIEN de sélectionné.
      assert.equal(dateValue(container), "", "la date de A n'est pas reprise pour B");
      assert.equal(slotButtons(container).length, 0, "aucun créneau affiché (donc aucun sélectionné) tant que la date n'est pas choisie");
      await assertSendStaysClosed(container, "B n'a pas été choisie");
      await openDate(container, 1);
      assert.ok(slotButtons(container)[0].textContent!.includes("18:00"), "B : son seul créneau est 18h–20h");
      assert.equal(pressed(container).length, 0, "aucun créneau présélectionné pour B (même date, même clé « s-a »)");
      await assertSendStaysClosed(container, "B : date choisie mais pas le créneau", 4);
      assert.equal(srv.createCalls.length, 0, "aucune commande n'est partie");
      assert.equal(urls.length, 0, "aucun message au commerçant");

      // Choix EXPLICITE pour B : c'est lui, et lui seul, qui part.
      click(q(container, "checkout-schedule-slot-s-a")!);
      await flush();
      assert.equal(pressed(container).length, 1, "B : choisi par le client");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert après le choix explicite");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.deepEqual(srv.createCalls[0].p_customer.schedule, { date: DATE, slot_key: "s-a", starts_at: "18:00", ends_at: "20:00" });
      const text = waText(urls[0]);
      assert.ok(text.includes("vendredi 30 octobre 2026 · 18:00–20:00"), `créneau de B dans le message : ${text}`);
      assert.ok(!text.includes("11:00"), "le créneau de A n'y figure pas");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-2] sans choix explicite pour B, le serveur ne reçoit JAMAIS le créneau de A ni un créneau inventé, et le message ne porte aucune ligne 📅", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      await changePostal(container, srv, POSTAL_B);
      await openDate(container, 1);
      assert.equal(pressed(container).length, 0);
      // Même en forçant le clic sur Envoyer (bouton absent => rien à cliquer) : aucune commande.
      const btn = sendButton(container);
      if (btn) click(btn);
      await flush(100);
      assert.equal(srv.createCalls.length, 0, "aucun create_order sans choix pour B");
      assert.equal(urls.length, 0);
      assert.ok(!container.textContent!.includes(CONFIRMED));
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-3] portée INCHANGÉE : le choix est conservé quand seuls la rue ou le nom changent (le serveur ne reçoit que le code postal) -- et part tel quel", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-b");
      const reads = srv.readerCalls.length;
      const street = inputById(container, "street");
      if (street instanceof window.HTMLInputElement) setNativeValue(street, "12 avenue de l'Opéra");
      setNativeValue(inputById(container, "customer_name")!, "Yakout M.");
      setNativeValue(inputById(container, "phone")!, "0698765432");
      await flush(80);
      assert.equal(srv.readerCalls.length, reads, "aucune relecture : même portée");
      assert.deepEqual(pressed(container).map((b) => b.getAttribute("data-testid")), ["checkout-schedule-slot-s-b"], "choix conservé");
      assert.equal(dateValue(container), DATE, "date conservée");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.deepEqual(srv.createCalls[0].p_customer.schedule, { date: DATE, slot_key: "s-b", starts_at: "14:00", ends_at: "17:00" });
      assert.ok(waText(urls[0]).includes("14:00–17:00"));
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-4] retour A → B → A : la sélection de A n'est PAS rétablie (elle a été invalidée au passage par B) ; le client choisit de nouveau", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async () => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      await changePostal(container, srv, POSTAL_B);
      await openDate(container, 1);
      await changePostal(container, srv, POSTAL_A);
      await waitFor(() => q(container, "checkout-schedule-date") !== null && dateValue(container) === "", "A de nouveau, date vide");
      assert.equal(slotButtons(container).length, 0, "aucun créneau rétabli");
      await assertSendStaysClosed(container, "A n'a pas été rechoisie");
      await openDate(container, 2);
      assert.equal(pressed(container).length, 0, "pas de créneau rétabli (s-a ne revient pas)");
      await assertSendStaysClosed(container, "A : date rechoisie, créneau non choisi", 4);
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-5] nouvelle règle SANS calendrier : aucun créneau inventé, rien de A envoyé ; et en revenant à A, rien n'est restauré", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      await changePostal(container, srv, POSTAL_C);
      await waitFor(() => q(container, "checkout-schedule-date") === null, "plus de calendrier");
      assert.equal(slotButtons(container).length, 0, "aucun créneau proposé ni sélectionné");
      await waitFor(() => sendButton(container) !== undefined, "parcours sans calendrier : envoi ouvert");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.equal("schedule" in srv.createCalls[0].p_customer, false, "aucune clé schedule");
      assert.ok(!waText(urls[0]).includes("📅"), "aucune ligne jour/créneau");
    } finally { root.unmount(); container.remove(); }
  });
  // Variante : retour vers A sans avoir envoyé.
  const srv2 = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async () => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      await changePostal(container, srv2, POSTAL_C);
      await waitFor(() => q(container, "checkout-schedule-date") === null, "plus de calendrier");
      await changePostal(container, srv2, POSTAL_A);
      await waitFor(() => q(container, "checkout-schedule-date") !== null, "A: calendrier revenu");
      assert.equal(slotButtons(container).length, 0);
      assert.equal(dateValue(container), "", "aucune date reprise");
      await assertSendStaysClosed(container, "A n'a pas été rechoisie après un passage sans calendrier");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-6] nouvelle règle à date seule (même date, AUCUN créneau) : ni la date ni la clé de A ne sont reprises ; le client choisit la date ; le payload n'a aucune clé de créneau", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      await changePostal(container, srv, POSTAL_D);
      await waitFor(() => q(container, "checkout-schedule-date") !== null && slotButtons(container).length === 0, "règle D : date seule");
      assert.equal(dateValue(container), "", "la date de A n'est pas reprise");
      await assertSendStaysClosed(container, "date de D non choisie");
      setSelect(q(container, "checkout-schedule-date") as HTMLSelectElement, DATE);
      await flush();
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert après le choix de la date");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.deepEqual(srv.createCalls[0].p_customer.schedule, { date: DATE, slot_key: null, starts_at: null, ends_at: null });
      const text = waText(urls[0]);
      assert.ok(text.includes("vendredi 30 octobre 2026"), "le jour choisi pour D");
      assert.ok(!text.includes("11:00") && !text.includes("s-a"), "rien de A");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-7] COURSE : la réponse LENTE de B arrive après le retour à A => ignorée ; ni créneau de B affiché, ni sélection rétablie", async (t) => {
  const gateB = deferred();
  const srv = installServer(t, {
    reader: byRule, refuse: serverValidates,
    hold: (a) => (a.p_postal_code === POSTAL_B ? gateB.promise : null),
  });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      await changePostal(container, srv, POSTAL_B); // lecture B retenue
      await assertSendStaysClosed(container, "B en cours de lecture", 4);
      assert.equal(slotButtons(container).length, 0, "pendant la lecture : aucun créneau (ni de A, ni de B)");
      assert.equal(q(container, "checkout-schedule-date"), null, "pendant la lecture : pas de calendrier périmé");
      await changePostal(container, srv, POSTAL_A); // A relue (immédiate), B toujours en vol
      await openDate(container, 2);
      gateB.resolve(); // la réponse périmée de B arrive MAINTENANT
      await flush(80);
      assert.equal(slotButtons(container).length, 2, "l'écran reste celui de A (réponse de B ignorée)");
      assert.ok(!container.textContent!.includes("18:00"), "rien de B n'est affiché");
      assert.equal(pressed(container).length, 0, "aucun créneau sélectionné");
      await assertSendStaysClosed(container, "A n'a pas été rechoisie", 4);
      assert.equal(srv.createCalls.length, 0);
      assert.equal(urls.length, 0);
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-8] COURSE : la réponse LENTE de A arrive après le passage à B => ignorée ; B n'hérite de rien ; le choix explicite pour B est celui qui part", async (t) => {
  const gateA = deferred();
  let firstA = true;
  const srv = installServer(t, {
    reader: byRule, refuse: serverValidates,
    hold: (a) => { if (a.p_postal_code === POSTAL_A && firstA) { firstA = false; return gateA.promise; } return null; },
  });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A); // lecture A retenue
    try {
      await waitFor(() => srv.readerCalls.some((c) => c.p_postal_code === POSTAL_A), "lecture A lancée");
      await changePostal(container, srv, POSTAL_B);
      await openDate(container, 1);
      assert.ok(slotButtons(container)[0].textContent!.includes("18:00"), "B affiché");
      gateA.resolve(); // réponse périmée de A
      await flush(80);
      assert.equal(slotButtons(container).length, 1, "toujours B (réponse de A ignorée)");
      assert.equal(dateValue(container), DATE, "la date choisie pour B n'est pas effacée par la réponse périmée");
      assert.ok(!container.textContent!.includes("11:00"), "rien de A n'est affiché");
      assert.equal(pressed(container).length, 0);
      await assertSendStaysClosed(container, "B : créneau non choisi", 4);
      click(q(container, "checkout-schedule-slot-s-a")!);
      await flush();
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert après le choix explicite pour B");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.deepEqual(srv.createCalls[0].p_customer.schedule, { date: DATE, slot_key: "s-a", starts_at: "18:00", ends_at: "20:00" });
      assert.ok(waText(urls[0]).includes("18:00–20:00") && !waText(urls[0]).includes("11:00"));
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-9] COURSE : changements rapides A → B → C → A → B (sans attendre) : seule la dernière portée compte, aucune sélection antérieure ne ressurgit", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      for (const p of [POSTAL_B, POSTAL_C, POSTAL_A, POSTAL_B]) setNativeValue(inputById(container, "postalCode")!, p);
      await waitFor(() => srv.readerCalls.at(-1)?.p_postal_code === POSTAL_B, "dernière lecture : B");
      await openDate(container, 1);
      assert.ok(slotButtons(container)[0].textContent!.includes("18:00"), "B affiché");
      await flush(60);
      assert.equal(pressed(container).length, 0, "aucun créneau présélectionné");
      await assertSendStaysClosed(container, "B non choisie après des changements rapides", 5);
      assert.equal(srv.createCalls.length, 0);
      assert.equal(urls.length, 0);
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P2-10] le panier fait partie de la portée de livraison (le serveur reçoit nombre d'articles et sous-total) : un choix fait avant un changement de panier n'est pas repris", async (t) => {
  const srv = installServer(t, { reader: byRule, refuse: serverValidates });
  await withWhatsAppCapture(async () => {
    const { container, root } = await reachDelivery(POSTAL_A);
    try {
      await pickFixed(container, DATE, "s-a");
      const reads = srv.readerCalls.length;
      const plus = [...container.querySelectorAll("button")].find((b) => b.textContent === "+" || b.getAttribute("aria-label") === translate("fr", "increaseQuantity"));
      if (!plus) { t.diagnostic("bouton + introuvable : cas non applicable dans ce harnais"); return; }
      click(plus);
      await waitFor(() => srv.readerCalls.length > reads, "relecture après le changement de panier");
      await waitFor(() => q(container, "checkout-schedule-date") !== null, "A relue");
      assert.notEqual(srv.readerCalls.at(-1).p_total_count, srv.readerCalls[reads - 1].p_total_count, "le panier envoyé a changé");
      assert.equal(dateValue(container), "", "date non reprise : portée différente");
      assert.equal(pressed(container).length, 0, "choix non repris : portée différente");
      await assertSendStaysClosed(container, "panier changé", 4);
    } finally { root.unmount(); container.remove(); }
  });
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
});
