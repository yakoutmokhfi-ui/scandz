import { clearTestCartSession } from "./helpers/cart-session-isolation.ts";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-csdj2-158-r3-"));
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
  /** Réponse BRUTE du lecteur (vide, null, sans statut, plusieurs lignes...). */
  readerRaw?: (args: any, callIndex: number) => { data: unknown; error: unknown };
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
      return { data: [{ delivery_zone_prefixes: ["75"], delivery_min_items: 0, delivery_area_label: "Paris" }], error: null };
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
      if (cfg.readerRaw) return cfg.readerRaw(args, idx);
      const r = cfg.reader(args, idx);
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
  clearTestCartSession(window.sessionStorage);
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
// REMÉDIATION APRÈS CONTRE-AUDIT (PR #160, HEAD audité f81bb60) --
// RÉPONSES CALENDRIER INCOHÉRENTES.
//
// Le lecteur est l'autorité, mais une réponse qui se contredit (créneaux
// de même clé, date impossible, intervalle inversé, politique inconnue)
// n'est pas une disponibilité : le client NE DEVINE PAS, n'invente rien,
// n'envoie rien, EXPLIQUE pourquoi, garde le panier et propose de réessayer.
// ====================================================================
const D = (patch: Record<string, unknown>) => row({
  schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
  first_eligible_date: "2026-10-20", eligible_dates: ["2026-10-20"],
  offers: { "2026-10-20": SLOTS_20 },
  ...patch,
});
const SL = (slot_key: string | null, starts_at: string, ends_at: string) => ({ slot_key, starts_at, ends_at });

/**
 * CSDJ2-R3-01 (P2, contre-audit Turing du HEAD 427c395) -- la branche
 * `derived_earliest` (créneau « none ») retournait une exigence « derived »
 * AVANT d'avoir validé les offres : `offers:null`, une offre mal formée
 * (`25:00`) ou des bornes inversées en format non strict (`18:00:00`->`09:00:00`)
 * laissaient partir une commande date seule. Une date dérivée n'est une
 * disponibilité que si le serveur a rendu, pour CETTE date, au moins une offre
 * bien formée (heures strictes HH:MM, fin strictement après le début).
 */
const DER = (patch: Record<string, unknown>) => D({
  date_selection_mode: "derived_earliest", slot_selection_mode: "none",
  offers: { "2026-10-20": [SL(null, "09:00", "18:00")] },
  ...patch,
});

async function expectDerivedBlocked(
  t: { mock: { method: Function; restoreAll: Function } },
  mode: "pickup" | "delivery",
  label: string,
  bad: Record<string, unknown>,
  messageKey: string,
) {
  let healthy = false;
  const srv = installServer(t, {
    reader: () => (healthy ? DER({}) : bad),
    refuse: requireSchedule(false),
  });
  await withOpen(async (opened) => {
    const { container, root } = await reach(mode);
    const L = `${mode} / ${label}`;
    try {
      await waitFor(() => q(container, "checkout-schedule") !== null, `${L}: bloc affiché`);
      await flush(80);
      assert.equal(sendButton(container) === undefined, true, `${L}: envoi FERMÉ (aucune commande date seule sur réponse invalide)`);
      assert.ok(q(container, "checkout-schedule-derived") === null, `${L}: aucune date dérivée annoncée`);
      assert.ok(container.textContent!.includes(translate("fr", messageKey)), `${L}: explication « ${messageKey} »`);
      assert.equal(q(container, "checkout-schedule-retry") !== null, true, `${L}: « Réessayer »`);
      assert.ok(container.textContent!.includes("Cookie chocolat"), `${L}: panier intact`);
      assert.ok((inputById(container, "customer_name") as HTMLInputElement).value === "Yakout", `${L}: nom conservé`);
      assert.ok((inputById(container, "phone") as HTMLInputElement).value === "0612345678", `${L}: téléphone conservé`);
      assert.equal(srv.createCalls.length, 0, `${L}: aucun create_order`);
      assert.equal(opened.n, 0, `${L}: aucune ouverture WhatsApp`);
      // Réessayer avec une réponse enfin valide : reprise, UN seul appel, payload date seule.
      healthy = true;
      click(q(container, "checkout-schedule-retry")!);
      await waitFor(() => q(container, "checkout-schedule-derived") !== null, `${L}: date dérivée rechargée`);
      click(sendButton(container)!);
      click(sendButton(container) ?? container); // double clic : un seul envoi
      await waitFor(() => container.textContent!.includes(CONFIRMED), `${L}: confirmation`);
      assert.equal(srv.createCalls.length, 1, `${L}: UN seul create_order après reprise`);
      assert.deepEqual(srv.createCalls[0].p_customer.schedule,
        { date: "2026-10-20", slot_key: null, starts_at: null, ends_at: null }, `${L}: payload date seule conforme au contrat`);
    } finally { root.unmount(); container.remove(); }
  });
  t.mock.restoreAll();
}

const R3_CASES: Array<[string, Record<string, unknown>, string]> = [
  ["offers:null", DER({ offers: null }), "chkScheduleUnreadable"],
  ["offers absent pour la date dérivée", DER({ offers: {} }), "chkScheduleUnreadable"],
  ["liste d'offres vide pour la date dérivée", DER({ offers: { "2026-10-20": [] } }), "chkScheduleUnreadable"],
  ["offre mal formée 25:00 -> 09:00 (cas Turing)", DER({ offers: { "2026-10-20": [SL(null, "25:00", "09:00")] } }), "chkScheduleUnreadable"],
  ["heure 24:00 hors format", DER({ offers: { "2026-10-20": [SL(null, "09:00", "24:00")] } }), "chkScheduleUnreadable"],
  ["bornes non strictes inversées 18:00:00 -> 09:00:00", DER({ offers: { "2026-10-20": [SL(null, "18:00:00", "09:00:00")] } }), "chkScheduleUnreadable"],
  ["bornes non strictes ordonnées 09:00:00 -> 18:00:00", DER({ offers: { "2026-10-20": [SL(null, "09:00:00", "18:00:00")] } }), "chkScheduleUnreadable"],
  ["heure vide", DER({ offers: { "2026-10-20": [SL(null, "", "")] } }), "chkScheduleUnreadable"],
  ["intervalle strict inversé 18:00 -> 09:00", DER({ offers: { "2026-10-20": [SL(null, "18:00", "09:00")] } }), "chkScheduleUnreadableInterval"],
  ["intervalle de durée nulle 09:00 -> 09:00", DER({ offers: { "2026-10-20": [SL(null, "09:00", "09:00")] } }), "chkScheduleUnreadableInterval"],
  ["une bonne offre + une offre mal formée", DER({ offers: { "2026-10-20": [SL(null, "09:00", "12:00"), SL(null, "25:00", "26:00")] } }), "chkScheduleUnreadable"],
  ["clé de créneau présente alors que la politique est « none »", DER({ offers: { "2026-10-20": [SL("morning", "09:00", "12:00")] } }), "chkScheduleUnreadable"],
  ["offres de la date dérivée absentes, offres d'une AUTRE date présentes", DER({ eligible_dates: ["2026-10-20"], offers: { "2026-10-22": [SL(null, "09:00", "18:00")] } }), "chkScheduleUnreadable"],
];

test("[158-R3-1] REPRO CSDJ2-R3-01 : date dérivée + offres absentes / mal formées / non strictes => envoi fermé (retrait)", async (t) => {
  const failures: string[] = [];
  for (const [label, bad, key] of R3_CASES) {
    try { await expectDerivedBlocked(t, "pickup", label, bad, key); }
    catch (e) { failures.push(String((e as Error).message).split("\n")[0]); t.mock.restoreAll(); }
  }
  assert.deepEqual(failures, [], "réponses invalides encore envoyables ou mal gérées");
});

test("[158-R3-2] même chose en LIVRAISON : fermé, explication, panier intact, reprise valide => un seul appel date seule", async (t) => {
  const failures: string[] = [];
  for (const [label, bad, key] of R3_CASES) {
    try { await expectDerivedBlocked(t, "delivery", label, bad, key); }
    catch (e) { failures.push(String((e as Error).message).split("\n")[0]); t.mock.restoreAll(); }
  }
  assert.deepEqual(failures, [], "réponses invalides encore envoyables ou mal gérées");
});

test("[158-R3-3] REPRO (aucun create_order) : sur chacune des 13 réponses, un clic forcé n'envoie jamais de commande date seule", async (t) => {
  const sent: string[] = [];
  for (const [label, bad] of R3_CASES) {
    const srv = installServer(t, { reader: () => bad, refuse: requireSchedule(false) });
    await withOpen(async (opened) => {
      const { container, root } = await reach("pickup");
      try {
        await waitFor(() => q(container, "checkout-schedule") !== null, `${label}: bloc`);
        await flush(80);
        const btn = sendButton(container);
        if (btn) { click(btn); await flush(150); }
        if (srv.createCalls.length !== 0) sent.push(`${label}: create_order envoyé ${JSON.stringify(srv.createCalls[0].p_customer.schedule)}`);
        if (opened.n !== 0) sent.push(`${label}: WhatsApp ouvert`);
      } finally { root.unmount(); container.remove(); }
    });
    t.mock.restoreAll();
  }
  assert.deepEqual(sent, [], "commandes envoyées sur une réponse calendrier invalide");
});

test("[158-R3-4] NON-RÉGRESSION : dérivée valide (une ou plusieurs offres bien formées) reste envoyable avec la date seule du serveur", async (t) => {
  for (const [label, offers] of [
    ["une offre", { "2026-10-20": [SL(null, "09:00", "18:00")] }],
    ["bornes adjacentes (deux offres)", { "2026-10-20": [SL(null, "09:00", "12:00"), SL(null, "12:00", "18:00")] }],
    ["durée d'une minute", { "2026-10-20": [SL(null, "09:00", "09:01")] }],
    ["minuit-fin 23:59", { "2026-10-20": [SL(null, "00:00", "23:59")] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const srv = installServer(t, { reader: () => DER({ offers }), refuse: requireSchedule(false) });
    await withOpen(async () => {
      const { container, root } = await reach("pickup");
      try {
        await waitFor(() => q(container, "checkout-schedule-derived") !== null, `${label}: date prévue`);
        click(sendButton(container)!);
        await waitFor(() => container.textContent!.includes(CONFIRMED), `${label}: confirmation`);
        assert.equal(srv.createCalls.length, 1, label);
        assert.deepEqual(srv.createCalls[0].p_customer.schedule,
          { date: "2026-10-20", slot_key: null, starts_at: null, ends_at: null }, label);
      } finally { root.unmount(); container.remove(); }
    });
    t.mock.restoreAll();
  }
});

test("[158-R3-5] NON-RÉGRESSION : date seule, créneaux fixes, fenêtre et absence explicite de calendrier restent inchangés", async (t) => {
  // absence explicite : aucune sélection, aucun schedule envoyé
  let srv = installServer(t, { reader: () => row({}) });
  await withOpen(async () => {
    const { container, root } = await reach("pickup");
    try {
      await flush(120);
      assert.equal(q(container, "checkout-schedule-retry"), null);
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "absent: confirmation");
      assert.equal(srv.createCalls[0].p_customer.schedule, undefined);
    } finally { root.unmount(); container.remove(); }
  });
  t.mock.restoreAll();
  // créneaux fixes : sélection puis envoi du créneau choisi
  srv = installServer(t, { reader: () => FIXED, refuse: requireSchedule(true) });
  await withOpen(async () => {
    const { container, root } = await reach("pickup");
    try {
      await pickFixed(container, "2026-10-20", "afternoon");
      click(sendButton(container)!);
      await waitFor(() => container.textContent!.includes(CONFIRMED), "fixed: confirmation");
      assert.deepEqual(srv.createCalls[0].p_customer.schedule,
        { date: "2026-10-20", slot_key: "afternoon", starts_at: "14:00", ends_at: "18:00" });
    } finally { root.unmount(); container.remove(); }
  });
  t.mock.restoreAll();
});

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
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
