import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — DELIVERY COUNTRY SCOPE v1.1 — remédiation DCS-COUNTRY-UI-02,
// preuve DOM sur le VRAI components/MenuView.tsx (checkout multi-pays).
//
// CE QUE CE FICHIER PROUVE
//   1. FR -> BE : le code postal déjà saisi est REVALIDÉ pour la
//      Belgique au moment du changement de pays (l'envoi disparaît) ;
//   2. BE -> FR : idem dans l'autre sens ;
//   3. multi-pays SANS choix : l'envoi est BLOQUÉ (aucun repli sur les
//      règles françaises), aucun create_order ne part ;
//   4. lecture des pays en échec : l'envoi est BLOQUÉ ;
//   5. après correction, la charge create_order porte le pays CHOISI.
//
// En v1, (1)(2)(3)(4) échouaient : le mémo de validation ne dépendait
// pas du pays, et un pays absent retombait sur ^\d{5}$.
//
// Harnais : même patron que tests/v171b-client-golden-path.dom.test.ts
// (bundle esbuild, lib/supabase.ts externalisé, supabase.rpc/from
// interceptés). Aucune base, aucun réseau.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-dcs11-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --- Utilitaires DOM ---------------------------------------------------

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, description: string, timeoutMs = 3000) {
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

function selectCountry(container: Element, code: string) {
  const select = container.querySelector("select#delivery-country") as HTMLSelectElement | null;
  assert.ok(select, "le sélecteur de pays doit être rendu (deux pays autorisés)");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, code);
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
const buttonWithText = (c: Element, text: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === text);
const inputById = (c: Element, id: string) => c.querySelector(`#${id}`) as HTMLInputElement | null;

const SEND_LABEL = "Enregistrer et continuer sur WhatsApp";
const CONFIRM_TITLE = "Commande envoyée avec succès !";
const POSTAL_ERR_FR = "5 chiffres"; // errPostalCode_FR (fr) = libellé historique errPostalCode
const POSTAL_ERR_BE = "4 chiffres"; // errPostalCode_BE (fr)
const POSTAL_ERR_COUNTRY = "Pays de livraison requis";

// --- Fixture : un établissement autorisé en FR + BE ---------------------

const TENANT = {
  id: "dddddddd-0000-4000-8000-00000000000d",
  slug: "dcs-multi-pays",
  name: "Multi pays (test)",
  orderId: "66666666-6666-4666-8666-666666666666",
  publicToken: "77777777-7777-4777-8777-777777777777",
  item: { id: "d1000000-0000-4000-8000-000000000001", name: "Comte", price: 10 },
};

const COUNTRY_ROWS = [
  {
    country_code: "FR",
    country_name: "France",
    postal_code_pattern: "^[0-9]{5}$",
    phone_pattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$",
    address_provider: "ban_ign",
    address_line_order: "number_first",
  },
  {
    country_code: "BE",
    country_name: "Belgique",
    postal_code_pattern: "^[0-9]{4}$",
    phone_pattern: "^(?:0[0-9]{8,9}|\\+32[0-9]{8,9})$",
    address_provider: "manual",
    address_line_order: "street_first",
  },
];

function restaurantProps() {
  return {
    id: TENANT.id,
    name: TENANT.name,
    slug: TENANT.slug,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: TENANT.id,
      max_tables: 0,
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
        id: "cat-dcs",
        restaurant_id: TENANT.id,
        name: "Carte",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: TENANT.item.id,
            category_id: "cat-dcs",
            name: TENANT.item.name,
            description: null,
            short_description: null,
            price: TENANT.item.price,
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

function installBackend(
  t: { mock: { method: Function }; after: (fn: () => void) => void },
  opts: { countries?: "ok" | "error" } = {}
) {
  const rpcCalls: { name: string; args: any }[] = [];
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return {
        select: async () => ({
          data: [
            { code: "pickup", label: "Retrait", category: "pickup" },
            { code: "delivery", label: "Livraison", category: "delivery" },
          ],
          error: null,
        }),
      };
    }
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    switch (name) {
      case "get_restaurant_public_sale_modes":
        return {
          data: ["pickup", "delivery"].map((mode_code) => ({
            mode_code,
            customer_text: null,
            pricing_mode: "free",
            fixed_fee: null,
            free_threshold: null,
            delay_value: null,
            delay_unit: null,
          })),
          error: null,
        };
      case "get_restaurant_public_field_requirements":
        return {
          data:
            args.p_mode_code === "delivery"
              ? [
                  { field: "customer_name", requirement: "required", one_of_group: null },
                  { field: "delivery_address", requirement: "required", one_of_group: null },
                  { field: "phone", requirement: "required", one_of_group: null },
                ]
              : [{ field: "customer_name", requirement: "required", one_of_group: null }],
          error: null,
        };
      case "get_restaurant_public_delivery_countries":
        return opts.countries === "error"
          ? { data: null, error: { code: "XX000", message: "lecture impossible" } }
          : { data: COUNTRY_ROWS, error: null };
      case "get_restaurant_public_delivery_info":
        return { data: [], error: null };
      case "get_restaurant_public_delivery_fulfillments":
        // Territoire commercial couvrant les DEUX pays : seule la
        // validation de FORMAT par pays peut donc bloquer l'envoi.
        return {
          data: [
            {
              fulfillment_code: "dcs_multi",
              zone_prefixes: ["75", "1"],
              is_fallback: false,
              min_items: 1,
              customer_text: "Livraison FR + BE",
              display_order: 0,
              pricing_mode: "fixed",
              fixed_fee: 2,
              free_threshold: null,
            },
          ],
          error: null,
        };
      case "get_restaurant_public_cgv":
        return { data: [], error: null };
      case "create_order":
        return {
          data: [
            {
              order_id: TENANT.orderId,
              order_number: 1,
              public_token: TENANT.publicToken,
              subtotal: "10.00",
              delivery_fee: "2.00",
              total: "12.00",
            },
          ],
          error: null,
        };
      case "mark_whatsapp_opened":
        return { data: null, error: null };
      case "upgrade_legacy_tracking_capability":
        return { data: [], error: null };
      default:
        throw new Error(`RPC inattendue : ${name}`);
    }
  });
  const realOpen = window.open;
  (window as any).open = () => ({});
  t.after(() => {
    (window as any).open = realOpen;
  });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input instanceof URL ? input.href : (input as any)?.url ?? input);
    if (url.startsWith("https://data.geopf.fr/geocodage/search")) {
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`requête sortante inattendue : ${url}`);
  });
  return { createOrderCalls: () => rpcCalls.filter((c) => c.name === "create_order").map((c) => c.args) };
}

async function toDeliveryCheckout() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: restaurantProps() }));
  await flush();
  const card = [...container.querySelectorAll("article")].find(
    (a) => a.querySelector("h3")?.textContent === TENANT.item.name
  );
  assert.ok(card, "fiche produit");
  click(buttonWithText(card!, "Ajouter")!);
  await flush();
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  assert.ok(cartBar, "barre panier");
  click(cartBar!);
  await flush();
  const delivery = buttonWithText(container, "Livraison");
  assert.ok(delivery, "le mode Livraison doit être proposé");
  click(delivery!);
  await flush();
  await waitFor(() => inputById(container, "customer_name") !== null, "champs livraison rendus");
  return { container, root };
}

async function fillAddress(container: Element, postalCode: string, street: string, city: string) {
  setNativeValue(inputById(container, "customer_name")!, "Victor Hugo");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  const streetInput = inputById(container, "street") ?? inputById(container, "delivery-street");
  assert.ok(streetInput, "champ rue");
  setNativeValue(streetInput!, street);
  setNativeValue(inputById(container, "city")!, city);
  setNativeValue(inputById(container, "postalCode")!, postalCode);
  await flush(50);
  await flush();
}

const canSend = (c: Element) => buttonWithText(c, SEND_LABEL) !== undefined;
const text = (c: Element) => c.textContent ?? "";

async function submit(container: Element) {
  click(buttonWithText(container, SEND_LABEL)!);
  await flush();
  const notice = container.querySelector('[data-delivery-timing-notice="true"][open]');
  if (notice) click(buttonWithText(notice, "J'ai compris, continuer")!);
  await waitFor(() => text(container).includes(CONFIRM_TITLE), "écran de confirmation");
}

// ====================================================================

test("[UI-02/DOM] FR -> BE : changer de pays REVALIDE le code postal déjà saisi, puis la charge porte BE", async (t) => {
  const backend = installBackend(t);
  const { container, root } = await toDeliveryCheckout();
  try {
    await waitFor(() => container.querySelector("select#delivery-country") !== null, "sélecteur de pays");
    selectCountry(container, "FR");
    await flush();
    await fillAddress(container, "75001", "12 rue des Lilas", "Paris");
    await waitFor(() => canSend(container), "envoi possible en FR avec 75001");

    // Changement de pays SANS toucher au formulaire.
    selectCountry(container, "BE");
    await flush();
    assert.equal(canSend(container), false, "75001 n'est pas un code postal belge : l'envoi doit disparaître");
    assert.ok(text(container).includes(POSTAL_ERR_BE), "l'erreur de format BELGE (4 chiffres) est affichée");
    assert.equal(text(container).includes(POSTAL_ERR_FR), false, "jamais le message français pour un code belge");

    // Correction au format belge.
    setNativeValue(inputById(container, "postalCode")!, "1000");
    setNativeValue(inputById(container, "city")!, "Bruxelles");
    await flush(50);
    await waitFor(() => canSend(container), "envoi possible en BE avec 1000");
    assert.equal(backend.createOrderCalls().length, 0, "aucune commande avant le clic");
    await submit(container);
    const calls = backend.createOrderCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].p_customer.country, "BE");
    assert.equal(calls[0].p_customer.postalCode, "1000");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[UI-02/DOM] BE -> FR : changer de pays REVALIDE le code postal déjà saisi, puis la charge porte FR", async (t) => {
  const backend = installBackend(t);
  const { container, root } = await toDeliveryCheckout();
  try {
    await waitFor(() => container.querySelector("select#delivery-country") !== null, "sélecteur de pays");
    selectCountry(container, "BE");
    await flush();
    await fillAddress(container, "1000", "Rue de la Loi 16", "Bruxelles");
    await waitFor(() => canSend(container), "envoi possible en BE avec 1000");

    selectCountry(container, "FR");
    await flush();
    assert.equal(canSend(container), false, "1000 n'est pas un code postal français : l'envoi doit disparaître");
    assert.ok(text(container).includes(POSTAL_ERR_FR), "message français inchangé : 5 chiffres");
    assert.equal(text(container).includes(POSTAL_ERR_BE), false);

    setNativeValue(inputById(container, "postalCode")!, "75001");
    setNativeValue(inputById(container, "city")!, "Paris");
    await flush(50);
    await waitFor(() => canSend(container), "envoi possible en FR avec 75001");
    await submit(container);
    const calls = backend.createOrderCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].p_customer.country, "FR");
    assert.equal(calls[0].p_customer.postalCode, "75001");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[UI-02/DOM] multi-pays SANS choix : l'envoi est BLOQUÉ (aucun repli FR), aucune commande", async (t) => {
  const backend = installBackend(t);
  const { container, root } = await toDeliveryCheckout();
  try {
    await waitFor(() => container.querySelector("select#delivery-country") !== null, "sélecteur de pays");
    // Adresse parfaitement française, mais AUCUN pays choisi.
    await fillAddress(container, "75001", "12 rue des Lilas", "Paris");
    await flush(50);
    assert.equal(canSend(container), false, "sans pays choisi, l'envoi doit rester bloqué");
    assert.ok(text(container).includes(POSTAL_ERR_COUNTRY), "le client est informé qu'un pays est requis");
    assert.equal(backend.createOrderCalls().length, 0);

    // Le choix du pays débloque, sans retoucher l'adresse.
    selectCountry(container, "FR");
    await flush();
    await waitFor(() => canSend(container), "envoi possible après choix FR");
    assert.equal(text(container).includes(POSTAL_ERR_COUNTRY), false);

    // Revenir à l'invite vide re-bloque.
    selectCountry(container, "");
    await flush();
    assert.equal(canSend(container), false, "pays désélectionné : envoi à nouveau bloqué");
    assert.equal(backend.createOrderCalls().length, 0);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[UI-02/DOM] lecture des pays en échec : l'envoi en livraison est BLOQUÉ", async (t) => {
  const backend = installBackend(t, { countries: "error" });
  const { container, root } = await toDeliveryCheckout();
  try {
    await fillAddress(container, "75001", "12 rue des Lilas", "Paris");
    await flush(50);
    assert.equal(container.querySelector("select#delivery-country"), null, "aucun pays à proposer");
    assert.equal(canSend(container), false, "aucun pays résolu : jamais d'envoi");
    assert.ok(text(container).includes(POSTAL_ERR_COUNTRY));
    assert.equal(backend.createOrderCalls().length, 0);
  } finally {
    root.unmount();
    container.remove();
  }
});
