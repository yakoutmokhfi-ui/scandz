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
// FULFILLMENT ROUTING LOT C — ACTIVE FRONTEND RUNTIME ROUTING.
//
// Preuve comportementale RÉELLE, de bout en bout (montage complet de
// MenuView, appels supabase.rpc réellement interceptés, interactions
// utilisateur réelles) que le pont de migration
// (resolveActiveDeliveryStatus, lib/delivery.ts) pilote RÉELLEMENT
// l'UI :
//   1. règles publiques NON VIDES, code postal correspondant -> le
//      texte customer_text de la règle apparaît, la commande devient
//      possible une fois le minimum atteint, AUCUNE mention du
//      fulfillmentCode/provider n'apparaît jamais dans le DOM ;
//   2. règles publiques NON VIDES, AUCUNE correspondance -> ineligible
//      via le nouveau moteur, jamais un repli vers le chemin legacy ;
//   3. le mode "pickup" reste totalement indépendant : soumission
//      possible même si les règles de fulfillment restent en
//      "loading" indéfiniment ou échouent (mission §17/§30).
//
// Réutilise EXACTEMENT le même patron/la même fixture
// ("sanaa-cookies") que tests/v91-lot2b4a2-dynamic-form.dom.test.ts
// (harnais MenuView déjà établi) -- fichier auto-contenu comme
// l'ensemble des tests DOM du projet.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v101-menuview-"));
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

/** Même fixture que tests/v91-lot2b4a2-dynamic-form.dom.test.ts. */
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

const DELIVERY_REQS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "delivery_address", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
  { field: "email", requirement: "optional", one_of_group: null },
];

const SANAA_SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];

const FULFILLMENT_RULE_75 = {
  fulfillment_code: "local_delivery_75_INTERNAL_NEVER_SHOWN",
  zone_prefixes: ["75"],
  is_fallback: false,
  min_items: 2,
  customer_text: "Livraison locale le jour même",
  display_order: 0,
  pricing_mode: "free",
  fixed_fee: null,
  free_threshold: null,
};

/** Mock RPC : `fulfillmentRules` pilote get_restaurant_public_delivery_fulfillments
 *  (LOT C, ce fichier) ; delivery_info legacy volontairement PIÉGÉ
 *  (matcherait le même code postal avec un libellé différent) pour
 *  prouver qu'il n'est JAMAIS consulté dès que des règles réelles
 *  existent (mission §4). */
function mockRpc(t: { mock: { method: Function } }, fulfillmentRules: unknown[]) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: SANAA_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      if (args.p_mode_code === "delivery") return { data: DELIVERY_REQS, error: null };
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") {
      // Piège délibéré (mission §4) : ce libellé ne doit JAMAIS
      // apparaître dès que fulfillmentRules est non vide.
      return {
        data: [{ delivery_zone_prefixes: ["75"], delivery_min_items: 1, delivery_area_label: "PIEGE-LEGACY-NE-DOIT-JAMAIS-APPARAITRE" }],
        error: null,
      };
    }
    if (name === "get_restaurant_public_delivery_fulfillments") {
      return { data: fulfillmentRules, error: null };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

async function renderAndAddOneItemToCart() {
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
  return { container, root };
}

test("LOT C (nouveau moteur, DOM réel bout-en-bout) : règles publiques NON VIDES, code postal correspondant -- customer_text affiché, JAMAIS le libellé legacy piégé, JAMAIS fulfillmentCode/provider, envoi permis une fois le minimum atteint", async (t) => {
  mockRpc(t, [FULFILLMENT_RULE_75]);
  const { container, root } = await renderAndAddOneItemToCart();

  try {
    selectServiceMode(container, "Livraison");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs delivery rendus");

    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    setNativeValue(inputById(container, "street")!, "12 rue des Lilas");
    setNativeValue(inputById(container, "city")!, "Paris");
    setNativeValue(inputById(container, "postalCode")!, "75001");
    await flush(50);

    // Sous le minimum (1 article, minItems=2 sur la règle) -- toujours
    // bloqué ; le message affiché à ce stade est "articles manquants",
    // pas encore le customer_text (même contrat que le chemin legacy,
    // voir FulfillmentSelector.tsx -- comportement volontairement
    // INCHANGÉ par ce lot, non régressé).
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined);
    assert.ok(
      !container.textContent?.includes("PIEGE-LEGACY-NE-DOIT-JAMAIS-APPARAITRE"),
      "le chemin legacy ne doit JAMAIS être consulté dès que des règles publiques réelles existent (mission §4)"
    );

    const plusBtn = container.querySelector('button[aria-label="Augmenter la quantité"]') as HTMLButtonElement | null;
    assert.ok(plusBtn, "le bouton d'incrément de quantité doit être présent");
    click(plusBtn!);
    await flush();

    await waitFor(
      () => container.textContent?.includes("Livraison locale le jour même") ?? false,
      "le customer_text de la règle doit apparaître une fois éligible (minimum atteint)"
    );
    assert.ok(
      !container.textContent?.includes("PIEGE-LEGACY-NE-DOIT-JAMAIS-APPARAITRE"),
      "le chemin legacy ne doit JAMAIS être consulté dès que des règles publiques réelles existent (mission §4)"
    );
    assert.ok(
      !container.innerHTML.includes("local_delivery_75_INTERNAL_NEVER_SHOWN"),
      "le fulfillmentCode interne ne doit JAMAIS apparaître dans le rendu client (mission §12)"
    );
    // Case vie privée/CGU (mission §14, hors périmètre routage fulfillment
    // de ce fichier) : requise avant l'envoi depuis ce lot.
    await flush();
    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "minimum atteint (2 articles) + adresse complète + code postal correspondant -> l'envoi doit être permis via le nouveau moteur"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("LOT C (nouveau moteur, DOM réel) : règles publiques NON VIDES, AUCUNE correspondance de préfixe -- ineligible, JAMAIS un repli vers le libellé legacy piégé", async (t) => {
  mockRpc(t, [FULFILLMENT_RULE_75]); // seul le préfixe "75" existe
  const { container, root } = await renderAndAddOneItemToCart();

  try {
    selectServiceMode(container, "Livraison");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs delivery rendus");

    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    setNativeValue(inputById(container, "street")!, "1 rue de Marseille");
    setNativeValue(inputById(container, "city")!, "Marseille");
    setNativeValue(inputById(container, "postalCode")!, "13001"); // ne matche aucune règle "75"
    await flush(50);

    assert.ok(
      !container.textContent?.includes("PIEGE-LEGACY-NE-DOIT-JAMAIS-APPARAITRE"),
      "aucune correspondance dans le nouveau moteur ne doit JAMAIS retomber sur le chemin legacy (mission §4)"
    );
    assert.equal(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      undefined,
      "aucune règle ne correspond -- l'envoi doit rester bloqué"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("LOT C (mission §17/§30, pickup non-régression, DOM réel) : le mode pickup reste soumissible même si les règles de fulfillment livraison n'atteignent JAMAIS l'état 'loaded' (RPC en attente indéfinie)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: SANAA_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      if (args.p_mode_code === "pickup") {
        return { data: [{ field: "customer_name", requirement: "required", one_of_group: null }, { field: "phone", requirement: "required", one_of_group: null }], error: null };
      }
      return { data: [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    // Ne se résout JAMAIS -- simule une RPC qui ne répond jamais.
    if (name === "get_restaurant_public_delivery_fulfillments") return new Promise(() => {});
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderAndAddOneItemToCart();
  try {
    selectServiceMode(container, "À emporter");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");

    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush(50);
    await flush();

    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "le pickup doit rester pleinement soumissible même si les règles de fulfillment livraison restent indéfiniment non résolues -- indépendance totale (mission §17)"
    );
  } finally {
    root.unmount();
    container.remove();
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
