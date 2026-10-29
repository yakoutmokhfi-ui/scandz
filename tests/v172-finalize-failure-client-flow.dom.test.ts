import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "v172-fin-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";

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
// Chaîne serveur RÉELLE : vraie route POST -> vrai runtime -> vrai service.
// Seule la frontière RPC du client service-role est simulée (aucun réseau).
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const serviceClient = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST: checkoutRoute } = await import("../app/api/payments/monetico/checkout/route.ts");

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v172fin-"));
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
// ISSUE #172 / T180-01 — l'ÉCHEC de la finalisation « sans paiement en
// ligne » ne doit JAMAIS produire une confirmation de commande.
//
// Chaîne réelle : MenuView (jsdom) -> client HTTP -> route POST ->
// initiateCheckout -> finalize_order_payment_mode_none. Seules la
// frontière RPC service-role et l'ouverture WhatsApp sont interceptées.
//
// Quatre comportements prouvés à chaque échec de finalisation :
//   1. aucun écran de confirmation de commande ;
//   2. aucune ouverture WhatsApp (ni mark_whatsapp_opened) ;
//   3. aucun autre état « terminé » : le panier n'est pas vidé ;
//   4. erreur compréhensible + reprise sûre sur la MÊME commande
//      (create_order jamais rappelée), puis succès normal à la reprise.
// ====================================================================

const CREATE_ORDER_OK = {
  data: [{ order_id: ORDER_ID, order_number: 42, public_token: TOKEN, total: 3.5, subtotal: 3.5, delivery_fee: 0 }],
  error: null,
};

const ok = (row: unknown) => ({ data: [row], error: null });
const FINALIZED_NONE = () => ok({ payment_status: "not_required", payment_mode_final: "none" });

type FinalizeBehavior = (callIndex: number) => unknown;

interface ServerCall { name: string; args: Record<string, unknown> }

/** Frontière RPC service-role : une commande `not_required`, un prestataire
 *  non activé -> la route atteint finalize_order_payment_mode_none. */
function installServerBoundary(t: { mock: { method: Function } }, finalize: { current: FinalizeBehavior }) {
  const calls: ServerCall[] = [];
  t.mock.method(serviceClient, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "get_order_payment_context") return ok({ restaurant_id: "resto-1", payment_status: "not_required" });
    if (name === "get_payment_runtime_provider_environment") {
      return ok({ provider_code: "monetico", mode: "test", is_enabled: false, configuration_status: "not_configured" });
    }
    if (name === "finalize_order_payment_mode_none") {
      return finalize.current(calls.filter((c) => c.name === name).length - 1);
    }
    throw new Error(`RPC serveur inattendue dans ce test : ${name}`);
  });
  return calls;
}

/** Le fetch du navigateur est routé vers la VRAIE route (jamais une réponse canned). */
function installRealRouteFetch() {
  const http: Array<{ status: number; body: unknown }> = [];
  (globalThis as any).fetch = async (input: unknown, init: any) => {
    const url = String(input);
    if (url.includes("/api/payments/monetico/checkout")) {
      const request = new NextRequest("http://localhost/api/payments/monetico/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: init.body,
      });
      const response = await checkoutRoute(request);
      http.push({ status: response!.status, body: await response!.clone().json().catch(() => null) });
      return response;
    }
    if (url.includes("/api/checkout/withdrawal-eligibility")) {
      return new Response(JSON.stringify({ eligible: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`requête sortante inattendue : ${url}`);
  };
  return http;
}

function confirmationShown(container: Element): boolean {
  return container.textContent?.includes("Commande envoyée avec succès") ?? false;
}

const rpcNames = () => ((supabase.rpc as any).mock.calls as Array<{ arguments: unknown[] }>).map((c) => String(c.arguments[0]));

async function withRuntimeEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
  process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = "true";
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
    else process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = prev;
  }
}

async function runScenario(t: any, firstAttempt: FinalizeBehavior) {
  mockRpc(t, CREATE_ORDER_OK);
  let opened = 0;
  (window as any).open = () => { opened++; return {}; };
  const finalize = { current: firstAttempt };
  const server = installServerBoundary(t, finalize);
  const http = installRealRouteFetch();
  const r = await renderFillPickupAndReachSubmit();
  click(r.submitBtn);
  return { ...r, finalize, server, http, opened: () => opened };
}

const FAILURES: Array<{ label: string; behavior: FinalizeBehavior }> = [
  { label: "RPC en erreur (57014)", behavior: () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) },
  { label: "RPC qui lève (réseau)", behavior: () => { throw new Error("réseau coupé"); } },
  { label: "ensemble vide (commande/jeton inconnus)", behavior: () => ({ data: [], error: null }) },
  { label: "commande déjà passée à required/online (lecture périmée)", behavior: () => ok({ payment_status: "required", payment_mode_final: "online" }) },
];

for (const failure of FAILURES) {
  test(`[T180-01] finalisation en échec -- ${failure.label} : aucune confirmation, aucun WhatsApp, panier conservé, erreur claire, reprise sûre sur la MÊME commande`, async (t) =>
    withRuntimeEnabled(async () => {
      const s = await runScenario(t, failure.behavior);
      try {
        await waitFor(() => s.container.querySelector("[data-payment-error]") !== null, "message d'erreur de finalisation");

        // 1. aucun écran de confirmation.
        assert.equal(confirmationShown(s.container), false, "jamais de confirmation sans décision finale");
        // 2. aucune ouverture WhatsApp, aucun mark_whatsapp_opened.
        assert.equal(s.opened(), 0, "window.open (WhatsApp) ne doit pas être appelé");
        assert.equal(rpcNames().includes("mark_whatsapp_opened"), false);
        // 3. aucun autre état « terminé » : le panier n'est pas vidé.
        assert.ok(s.container.textContent?.includes("Cookie chocolat"), "le panier doit rester affiché");
        assert.equal(buttonWithText(s.container, "Enregistrer et continuer sur WhatsApp"), undefined, "le bouton d'envoi normal est remplacé : aucune seconde commande possible");
        // 4. erreur compréhensible (distincte de « le paiement n'a pas pu démarrer »).
        const message = s.container.querySelector("[data-payment-error]")!.textContent ?? "";
        assert.match(message, /n'avons pas pu la finaliser/);
        assert.doesNotMatch(message, /paiement en ligne n'a pas pu démarrer/);
        const retry = s.container.querySelector('[data-payment-action="retry"]') as HTMLButtonElement | null;
        assert.ok(retry, "bouton de reprise");

        // Serveur : la route n'a PAS répondu « checkout_not_needed ».
        assert.equal(s.http.length, 1);
        assert.notEqual((s.http[0]!.body as any)?.outcome, "checkout_not_needed");
        assert.ok(s.http[0]!.status >= 500, `statut HTTP d'échec attendu, reçu ${s.http[0]!.status}`);
        assert.equal(s.server.filter((c) => c.name === "finalize_order_payment_mode_none").length, 1);

        // Reprise sûre : même commande, aucune nouvelle création.
        s.finalize.current = FINALIZED_NONE;
        click(retry!);
        await waitFor(() => confirmationShown(s.container), "confirmation après reprise réussie");
        assert.equal(s.opened(), 1, "WhatsApp s'ouvre une seule fois, APRÈS la décision finale");
        assert.equal(s.container.querySelector("[data-payment-error]"), null);
        assert.equal(rpcNames().filter((n) => n === "create_order").length, 1, "create_order appelée UNE seule fois");
        const finals = s.server.filter((c) => c.name === "finalize_order_payment_mode_none");
        assert.equal(finals.length, 2);
        assert.ok(finals.every((c) => c.args.p_order_id === ORDER_ID && c.args.p_public_token === TOKEN), "même commande, même jeton");
        assert.equal(s.http.length, 2);
        assert.equal((s.http[1]!.body as any).outcome, "checkout_not_needed");
      } finally { root_cleanup(s); }
    }));
}

test("[T180-01] contrôle positif : finalisation réussie (not_required/none) -> parcours historique INCHANGÉ (confirmation, WhatsApp une fois, aucune erreur, un seul finalize)", async (t) =>
  withRuntimeEnabled(async () => {
    const s = await runScenario(t, FINALIZED_NONE);
    try {
      await waitFor(() => confirmationShown(s.container), "confirmation attendue");
      assert.equal(s.opened(), 1);
      assert.equal(s.container.querySelector("[data-payment-error]"), null);
      assert.equal(s.server.filter((c) => c.name === "finalize_order_payment_mode_none").length, 1);
      assert.equal(s.http.length, 1);
      assert.deepEqual(s.http[0], { status: 200, body: { outcome: "checkout_not_needed", reason: "not_required" } });
      assert.equal(rpcNames().filter((n) => n === "create_order").length, 1);
    } finally { root_cleanup(s); }
  }));

test("[T180-01] commande déjà payée (finalize -> paid) : confirmation légitime ; le détail `already_paid` est conservé", async (t) =>
  withRuntimeEnabled(async () => {
    const s = await runScenario(t, () => ok({ payment_status: "paid", payment_mode_final: "online" }));
    try {
      await waitFor(() => confirmationShown(s.container), "confirmation attendue pour une commande payée");
      assert.deepEqual(s.http[0], { status: 200, body: { outcome: "checkout_not_needed", reason: "already_paid" } });
      assert.equal(s.opened(), 1);
    } finally { root_cleanup(s); }
  }));

function root_cleanup(s: { root: { unmount: () => void }; container: Element }) {
  s.root.unmount();
  s.container.remove();
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
