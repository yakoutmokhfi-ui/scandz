import { test, after } from "node:test";
import { autoConfirmCheckoutReview } from "./helpers/checkout-review-autoconfirm.ts";
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
autoConfirmCheckoutReview(window);
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-csdj2-158-"));
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
      const r = cfg.reader(args, readerCalls.length - 1);
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

test("[170-S1] règle STUART : calendrier de CETTE règle affiché, envoi fermé tant que jour+créneau ne sont pas choisis, schedule exact transmis, jour et créneau dans le message au commerçant", async (t) => {
  const srv = installServer(t, { reader: byPostal, refuse: requireSchedule(true) });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(STUART_POSTAL);
    try {
      await waitFor(() => q(container, "checkout-schedule") !== null, "bloc date/créneau rendu en livraison Stuart");
      assert.equal(sendButton(container) === undefined, true, "envoi FERMÉ tant que le créneau n'est pas choisi");
      await waitFor(() => q(container, "checkout-schedule-date") !== null, "date");
      const dateSelect = q(container, "checkout-schedule-date") as HTMLSelectElement;
      assert.deepEqual([...dateSelect.options].map((o) => o.value).filter(Boolean), ["2026-10-30"], "uniquement la date du serveur");
      await pickFixed(container, "2026-10-30", "s-b");
      assert.ok(q(container, "checkout-schedule-slot-s-a") !== null && q(container, "checkout-schedule-slot-s-b") !== null, "uniquement les deux créneaux de la règle");
      assert.equal(container.querySelectorAll('[data-testid^="checkout-schedule-slot-"]').length, 2);
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert après le choix");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");

      // Lecture : par code postal (le serveur résout la règle).
      assert.ok(srv.readerCalls.some((c) => c.p_mode_code === "delivery" && c.p_postal_code === STUART_POSTAL));
      // Écriture : schedule exact, offres du serveur.
      assert.equal(srv.createCalls.length, 1);
      assert.deepEqual(srv.createCalls[0].p_customer.schedule, {
        date: "2026-10-30", slot_key: "s-b", starts_at: "14:00", ends_at: "17:00",
      });
      // Message au commerçant : jour et créneau choisis.
      assert.equal(urls.length, 1, "un seul lien WhatsApp");
      const text = waText(urls[0]);
      assert.ok(text.includes("vendredi 30 octobre 2026 · 14:00–17:00"), `jour et créneau dans le message : ${text}`);
      assert.ok(!text.includes("11:00"), "l'autre créneau n'y figure pas");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-C1] règle CHRONOFRESH (aucun calendrier) : aucun créneau Stuart, envoi ouvert, aucune clé schedule, message au commerçant inchangé", async (t) => {
  const srv = installServer(t, { reader: byPostal, refuse: refuseOnlyStuart });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(CHRONOFRESH_POSTAL);
    try {
      await waitFor(() => srv.readerCalls.some((c) => c.p_postal_code === CHRONOFRESH_POSTAL), "lecture du calendrier de cette adresse");
      await flush(80);
      assert.equal(q(container, "checkout-schedule-date"), null, "aucun sélecteur de date");
      assert.equal(container.querySelectorAll('[data-testid^="checkout-schedule-slot-"]').length, 0, "aucun créneau Stuart");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert (parcours d'avant)");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.equal(srv.createCalls.length, 1);
      assert.equal("schedule" in srv.createCalls[0].p_customer, false, "aucune clé schedule");
      assert.ok(!waText(urls[0]).includes("📅"), "aucune ligne de jour/créneau dans le message");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-C2] AUCUNE FUITE d'une adresse à l'autre : créneau Stuart choisi puis adresse Chronofresh => sélection abandonnée, rien de Stuart n'est envoyé", async (t) => {
  const srv = installServer(t, { reader: byPostal, refuse: refuseOnlyStuart });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(STUART_POSTAL);
    try {
      await pickFixed(container, "2026-10-30", "s-a");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert après le choix Stuart");
      setNativeValue(inputById(container, "postalCode")!, CHRONOFRESH_POSTAL);
      await waitFor(() => srv.readerCalls.some((c) => c.p_postal_code === CHRONOFRESH_POSTAL), "relecture pour la nouvelle adresse");
      await flush(80);
      assert.equal(q(container, "checkout-schedule-date"), null, "le calendrier Stuart disparaît");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert (parcours Chronofresh)");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.equal(srv.createCalls.length, 1);
      assert.equal("schedule" in srv.createCalls[0].p_customer, false, "le créneau Stuart choisi plus tôt n'est PAS envoyé");
      assert.ok(!waText(urls[0]).includes("📅"), "ni affiché au commerçant");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-N1] adresse NON éligible (refusée en amont) : aucun créneau proposé, aucun schedule envoyé", async (t) => {
  const srv = installServer(t, { reader: byPostal, refuse: refuseOnlyStuart });
  await withWhatsAppCapture(async () => {
    const { container, root } = await reachDelivery(OUT_OF_ZONE_POSTAL);
    try {
      await flush(120);
      assert.equal(q(container, "checkout-schedule-date"), null, "aucun sélecteur de date");
      assert.equal(container.querySelectorAll('[data-testid^="checkout-schedule-slot-"]').length, 0, "aucun créneau");
      const btn = sendButton(container);
      if (btn) { click(btn); await flush(100); }
      assert.equal(srv.createCalls.filter((c) => "schedule" in c.p_customer).length, 0, "aucun schedule, jamais");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-A1] règle Stuart SANS planning (état d'aujourd'hui, avant toute configuration) : parcours strictement inchangé", async (t) => {
  const srv = installServer(t, { reader: () => row({ delivery_applicable: true, delivery_eligible: true }), refuse: () => null /* aucun planning : le serveur n'exige rien */ });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(STUART_POSTAL);
    try {
      await waitFor(() => srv.readerCalls.length > 0, "lecture");
      await flush(80);
      assert.equal(q(container, "checkout-schedule"), null, "aucun bloc de planification");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.equal("schedule" in srv.createCalls[0].p_customer, false);
      assert.ok(!waText(urls[0]).includes("📅"));
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-P1] le serveur refuse un créneau périmé (SCANYM_SCHEDULE_SLOT_INVALID) : aucun message au commerçant, panier conservé, rien de faux affiché", async (t) => {
  const srv = installServer(t, { reader: byPostal, refuse: () => "SCANYM_SCHEDULE_SLOT_INVALID" });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reachDelivery(STUART_POSTAL);
    try {
      await pickFixed(container, "2026-10-30", "s-a");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert");
      click(sendButton(container)!);
      await waitFor(() => srv.createCalls.length >= 1, "create_order appelé");
      await flush(100);
      assert.equal(urls.length, 0, "aucun lien WhatsApp : la commande n'existe pas");
      assert.ok(!container.textContent!.includes(CONFIRMED), "pas de confirmation");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-R1] RETRAIT sans créneau : message au commerçant inchangé (aucune ligne de jour/créneau), commande sans schedule", async (t) => {
  const srv = installServer(t, { reader: () => row({}), refuse: () => null });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reach("pickup");
    try {
      await waitFor(() => srv.readerCalls.length > 0, "lecture");
      await flush(80);
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.equal("schedule" in srv.createCalls[0].p_customer, false);
      assert.equal(urls.length, 1);
      assert.ok(!waText(urls[0]).includes("📅"), "aucune ligne ajoutée au message de retrait");
    } finally { root.unmount(); container.remove(); }
  });
});

test("[170-R2] RETRAIT avec créneau (#158) : périmètre #170 = livraison planifiée seulement, message de retrait inchangé", async (t) => {
  const srv = installServer(t, { reader: () => FIXED, refuse: requireSchedule(true) });
  await withWhatsAppCapture(async (urls) => {
    const { container, root } = await reach("pickup");
    try {
      await pickFixed(container, "2026-10-20", "morning");
      await waitFor(() => sendButton(container) !== undefined, "envoi ouvert");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "commande confirmée");
      assert.equal(srv.createCalls[0].p_customer.schedule.slot_key, "morning", "le schedule de retrait reste transmis au serveur");
      assert.ok(!waText(urls[0]).includes("📅"), "le message de retrait n'est pas modifié par ce lot");
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
