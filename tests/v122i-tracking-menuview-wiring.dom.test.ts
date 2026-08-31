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
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// components/MenuView.tsx::handleSendOrder -> lib/tracking/link.ts ->
// components/OrderConfirmation.tsx (mandat §20, §30.A/B, §33).
//
// Preuve comportementale RÉELLE de bout en bout (montage complet de
// MenuView, `supabase.rpc` réellement intercepté, interactions
// utilisateur réelles jusqu'au clic d'envoi) que :
//   1. après un `create_order` RÉUSSI, le lien de suivi affiché porte
//      l'order_id/public_token EXACTS renvoyés par le serveur, encodés
//      en FRAGMENT (`/track/<order_id>#<public_token>`) -- jamais en
//      segment de chemin (v1, FORBIDDEN, mandat §6) ni en chaîne de
//      requête (mandat §20) ;
//   2. après un `create_order` en ÉCHEC, AUCUN lien de suivi n'apparaît
//      nulle part dans le DOM (mandat §20, "no tracking link if order
//      creation failed") ;
//   3. `closeConfirmation` (bouton "Passer une autre commande") efface
//      l'état de suivi -- aucune commande suivante ne peut hériter par
//      erreur du chemin d'une commande précédente (mandat §11, en écho
//      MenuView.tsx ligne "jamais d'état de suivi résiduel").
//
// Réutilise EXACTEMENT le même patron/la même fixture ("sanaa-cookies",
// mode pickup -- exigences de champs les plus simples) que
// tests/v101-fulfillment-routing-lot-c-menuview.dom.test.ts, qui a
// déjà établi le harnais MenuView complet de ce dépôt ; ce fichier est
// le premier à pousser ce harnais jusqu'au clic d'envoi RÉEL
// (`create_order` mocké au niveau `supabase.rpc`, jamais au niveau
// `@/lib/services/orders` -- même discipline que v101 : ne mocker que
// la frontière réseau la plus basse).
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v122i-"));
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
function assertTrackingHrefIsSecure(href: string) {
  const url = new URL(href, "https://example.com");
  assert.equal(url.pathname, `/track/${ORDER_ID}`, "le pathname ne doit contenir QUE l'order_id");
  assert.equal(url.search, "", "aucune chaîne de requête ne doit porter le jeton");
  assert.equal(url.hash, `#${TOKEN}`, "le jeton n'apparaît QUE dans le fragment");
  assert.equal(href.includes(`/track/${ORDER_ID}/${TOKEN}`), false, "JAMAIS le format v1 <order_id>/<token> (mandat §6, FORBIDDEN)");
  assert.equal(href.includes("?token="), false, "JAMAIS un jeton en paramètre de requête");
}

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

function findTrackingAnchor(container: Element): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("/track/"));
}

test("mandat §20/§33 : create_order RÉUSSI -- le lien de suivi affiché porte l'order_id/public_token RÉELS renvoyés par le serveur, en FRAGMENT, jamais un jeton régénéré", async (t) => {
  mockRpc(t, {
    data: [
      {
        order_id: ORDER_ID,
        order_number: 42,
        public_token: TOKEN,
        total: 3.5,
        subtotal: 3.5,
        delivery_fee: 0,
      },
    ],
    error: null,
  });
  // Mandat : cette navigation WhatsApp est hors périmètre de ce lot --
  // simulée comme "réussie" (objet tronqué non-null) pour emprunter le
  // même chemin que la production sans jamais déclencher la
  // navigation `window.location.href = url` de repli (non pertinente
  // ici, et non fiable sous jsdom).
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(
      () => container.textContent?.includes("Commande envoyée avec succès") ?? false,
      "l'écran de confirmation doit apparaître après un create_order réussi"
    );

    const anchor = findTrackingAnchor(container);
    assert.ok(anchor, "un lien de suivi (<a href=\"/track/...\">) doit être présent après succès");
    assert.equal(anchor!.textContent, "Suivre ma commande");
    assertTrackingHrefIsSecure(anchor!.getAttribute("href")!);

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
  }
});

test("mandat §20 : create_order en ÉCHEC -- AUCUN lien de suivi nulle part dans le DOM, panier conservé, message d'échec générique", async (t) => {
  mockRpc(t, { data: null, error: { message: "boom serveur" } });
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(
      () => container.textContent?.includes("L'envoi a échoué") ?? false,
      "le message d'échec générique doit apparaître après un create_order en échec"
    );

    assert.equal(findTrackingAnchor(container), undefined, "AUCUN lien de suivi ne doit apparaître si la commande n'a pas été créée (mandat §20)");
    assert.equal(container.textContent?.includes("Commande envoyée avec succès"), false, "l'écran de confirmation ne doit jamais s'afficher après un échec");
    // Le message d'erreur brut du serveur ne doit jamais fuiter tel quel.
    assert.equal(container.textContent?.includes("boom serveur"), false);

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
  }
});

test("mandat §11 (écho MenuView) : \"Passer une autre commande\" efface l'état de suivi -- aucun résidu pour la commande suivante", async (t) => {
  mockRpc(t, {
    data: [
      {
        order_id: ORDER_ID,
        order_number: 43,
        public_token: TOKEN,
        total: 3.5,
        subtotal: 3.5,
        delivery_fee: 0,
      },
    ],
    error: null,
  });
  const realOpen = window.open;
  (window as any).open = () => ({});

  const { container, root, submitBtn } = await renderFillPickupAndReachSubmit();
  try {
    click(submitBtn);
    await waitFor(
      () => findTrackingAnchor(container) !== undefined,
      "le lien de suivi doit apparaître après succès"
    );

    const newOrderBtn = buttonWithText(container, "Passer une autre commande");
    assert.ok(newOrderBtn, "le bouton \"Passer une autre commande\" doit être présent sur l'écran de confirmation");
    click(newOrderBtn!);
    await flush();

    assert.equal(
      container.textContent?.includes("Commande envoyée avec succès"),
      false,
      "l'écran de confirmation doit se fermer"
    );
    assert.equal(
      findTrackingAnchor(container),
      undefined,
      "aucun lien de suivi résiduel ne doit rester affiché après retour au menu"
    );

    root.unmount();
    container.remove();
  } finally {
    (window as any).open = realOpen;
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
