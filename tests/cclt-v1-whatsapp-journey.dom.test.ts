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
// Scanym — CUSTOMER CONTACT + LIVE TRACKING v1
// Parcours client DOM RÉEL (components/MenuView.tsx complet), même
// harnais que tests/v171b (bundle esbuild, lib/supabase.ts externalisé,
// `supabase.rpc`/`from` interceptés, `window.open` enregistré).
//
//   WhatsApp OFF : parcours complet SANS aucun bouton/lien/texte/repli
//                  WhatsApp ; commande enregistrée ; suivi = action
//                  principale de la confirmation.
//   WhatsApp ON  : comportement historique inchangé (wa.me ouvert,
//                  mark_whatsapp_opened), suivi toujours présent.
//
// Viewport mobile (375 px). Cliente d'exemple : MYRIAM.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 740, configurable: true });
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
      const resolved = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p)) ?? base;
      if (resolved.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolved).href, external: true };
      }
      return { path: resolved };
    });
  },
};

const built = await esbuild.build({
  stdin: { contents: `export { default as MenuView } from "@/components/MenuView";`, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-cclt-wa-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout : ${label}`);
    await flush(10);
  }
}
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
const buttonWithText = (c: Element, text: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

const TENANT = {
  id: "cccccccc-0000-4000-8000-00000000000c",
  slug: "epicerie-alpha",
  name: "Épicerie Alpha",
  orderId: "12121212-1212-4212-8212-121212121212",
  publicToken: "34343434-3434-4434-8434-343434343434",
  item: { id: "c1000000-0000-4000-8000-000000000001", name: "Coffret thé", price: 20 },
};

function restaurantProps(config: Record<string, unknown>) {
  return {
    id: TENANT.id,
    name: TENANT.name,
    slug: TENANT.slug,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: TENANT.id,
      max_tables: 6,
      currency: "EUR",
      whatsapp_number: "+33600000000",
      address: null,
      latitude: null,
      longitude: null,
      logo_url: null,
      cover_url: null,
      opening_hours: null,
      source_language: "fr",
      ...config,
    },
    categories: [
      {
        id: "cat-alpha",
        restaurant_id: TENANT.id,
        name: "Épicerie",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: TENANT.item.id,
            category_id: "cat-alpha",
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

interface Backend {
  rpcCalls: { name: string; args: any }[];
  openedUrls: string[];
  unexpected: string[];
}

function installBackend(t: any): Backend {
  const backend: Backend = { rpcCalls: [], openedUrls: [], unexpected: [] };
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: [{ code: "pickup", label: "Retrait", category: "pickup" }], error: null }) };
    }
    backend.unexpected.push(`from:${table}`);
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    backend.rpcCalls.push({ name, args });
    switch (name) {
      case "get_restaurant_public_sale_modes":
        return {
          data: [{ mode_code: "pickup", customer_text: null, pricing_mode: "free", fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null }],
          error: null,
        };
      case "get_restaurant_public_field_requirements":
        return {
          data: [
            { field: "customer_name", requirement: "required", one_of_group: null },
            { field: "phone", requirement: "required", one_of_group: null },
          ],
          error: null,
        };
      case "get_restaurant_public_delivery_info":
      case "get_restaurant_public_delivery_fulfillments":
      case "get_restaurant_public_cgv":
        return { data: [], error: null };
      case "create_order":
        return {
          data: [{ order_id: TENANT.orderId, order_number: 7, public_token: TENANT.publicToken, subtotal: "20.00", delivery_fee: "0.00", total: "20.00" }],
          error: null,
        };
      case "mark_whatsapp_opened":
        return { data: null, error: null };
      default:
        backend.unexpected.push(`rpc:${name}`);
        throw new Error(`RPC inattendue : ${name}`);
    }
  });
  const realOpen = window.open;
  (window as any).open = (url: string) => {
    backend.openedUrls.push(url);
    return {};
  };
  t.after(() => {
    (window as any).open = realOpen;
  });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    throw new Error(`requête sortante inattendue : ${String(input)}`);
  });
  return backend;
}

const WHATSAPP_PATTERN = /whats\s*app|wa\.me|#25D366|واتساب/i;

/** Relevé de TOUT le DOM à chaque étape : aucune trace WhatsApp. */
function assertNoWhatsappTrace(container: Element, step: string) {
  const html = container.innerHTML;
  assert.equal(WHATSAPP_PATTERN.test(html), false, `${step} : aucune trace WhatsApp (texte, lien, couleur)`);
}

async function journey(t: any, config: Record<string, unknown>, onStep?: (c: Element, step: string) => void) {
  const backend = installBackend(t);
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: restaurantProps(config) }));
  await flush();
  onStep?.(container, "catalogue");

  const card = [...container.querySelectorAll("article")].find((a) => a.querySelector("h3")?.textContent === TENANT.item.name);
  assert.ok(card, "produit affiché");
  click(buttonWithText(card!, "Ajouter")!);
  await flush();
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  assert.ok(cartBar);
  click(cartBar!);
  await flush();
  onStep?.(container, "panier");

  const pickup = buttonWithText(container, "À emporter");
  if (pickup) {
    click(pickup);
    await flush();
  }
  await waitFor(() => container.querySelector("#customer_name") !== null, "champs retrait");
  const nameInput = container.querySelector<HTMLInputElement>("#customer_name")!;
  assert.equal(nameInput.getAttribute("placeholder"), "Myriam", "exemple de nom client : Myriam");
  setNativeValue(nameInput, "MYRIAM");
  setNativeValue(container.querySelector<HTMLInputElement>("#phone")!, "0612345678");
  await flush(50);
  await flush();
  onStep?.(container, "coordonnées");

  return { backend, container, root };
}

async function submit(container: Element, label: string) {
  const send = buttonWithText(container, label);
  assert.ok(send, `bouton d'envoi « ${label} »`);
  click(send!);
  await flush();
  const notice = container.querySelector<HTMLDialogElement>('[data-delivery-timing-notice="true"][open]');
  if (notice) click(buttonWithText(notice, "J'ai compris, continuer")!);
  await waitFor(() => container.textContent?.includes("Commande envoyée avec succès !") ?? false, "confirmation");
}

function assertTrackingIsPrimary(container: Element) {
  const cta = container.querySelector<HTMLAnchorElement>("a[data-order-confirmation-tracking]");
  assert.ok(cta, "lien de suivi présent sur la confirmation");
  assert.equal(cta!.textContent, "Suivre ma commande");
  const url = new URL(cta!.getAttribute("href")!, "http://localhost");
  assert.equal(url.pathname, `/track/${TENANT.orderId}`);
  assert.equal(url.search, "", "aucun jeton en chaîne de requête");
  const cls = cta!.className;
  assert.ok(cls.includes("bg-caramel") && cls.includes("min-h-[44px]"), "action principale, cible tactile mobile >= 44px");
  const actionable = [...container.querySelectorAll("a, button")].filter((el) =>
    el.closest(".fixed.inset-0")
  );
  assert.equal(actionable[0] === cta, true, "le suivi est la PREMIÈRE action de l'écran de confirmation (visible sans défilement)");
}

// --------------------------------------------------------------------
// WhatsApp OFF
// --------------------------------------------------------------------

test("CCLT-JOURNEY-01 WhatsApp OFF (mobile) : parcours complet sans AUCUNE trace WhatsApp ; commande enregistrée ; suivi en action principale", async (t) => {
  const { backend, container, root } = await journey(t, { whatsapp_enabled: false }, (c, step) => assertNoWhatsappTrace(c, step));
  try {
    assert.ok(container.textContent?.includes("Votre commande sera enregistrée et transmise au commerçant."));
    assert.ok(container.textContent?.includes("Vos coordonnées servent uniquement à traiter votre commande et sont transmises au commerçant."));
    await submit(container, "Valider la commande");
    assertNoWhatsappTrace(container, "confirmation");
    assert.ok(container.textContent?.includes("Votre commande a bien été enregistrée et transmise à Épicerie Alpha."));

    assert.equal(backend.rpcCalls.filter((c) => c.name === "create_order").length, 1, "commande enregistrée une fois");
    assert.equal(backend.rpcCalls.find((c) => c.name === "create_order")?.args.p_customer.name, "MYRIAM");
    assert.deepEqual(backend.openedUrls, [], "aucune ouverture WhatsApp");
    assert.equal(backend.rpcCalls.some((c) => c.name === "mark_whatsapp_opened"), false, "aucun marquage WhatsApp");
    assert.deepEqual(backend.unexpected, []);
    assertTrackingIsPrimary(container);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("CCLT-JOURNEY-02 aucun repli caché : WhatsApp activé mais numéro inutilisable => parcours SANS WhatsApp", async (t) => {
  const { backend, container, root } = await journey(t, { whatsapp_enabled: true, whatsapp_number: "" }, (c, step) => assertNoWhatsappTrace(c, step));
  try {
    await submit(container, "Valider la commande");
    assert.deepEqual(backend.openedUrls, []);
    assert.equal(backend.rpcCalls.some((c) => c.name === "mark_whatsapp_opened"), false);
    assertTrackingIsPrimary(container);
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// WhatsApp ON
// --------------------------------------------------------------------

test("CCLT-JOURNEY-03 WhatsApp ON : comportement historique (wa.me + marquage), suivi toujours présent et principal", async (t) => {
  const { backend, container, root } = await journey(t, { whatsapp_enabled: true });
  try {
    assert.ok(container.textContent?.includes("WhatsApp s'ouvrira"), "mention WhatsApp avant envoi");
    await submit(container, "Enregistrer et continuer sur WhatsApp");
    assert.equal(backend.openedUrls.length, 1);
    assert.ok(backend.openedUrls[0].startsWith("https://wa.me/33600000000?text="));
    assert.equal(decodeURIComponent(backend.openedUrls[0]).includes(TENANT.publicToken), false, "le jeton de suivi ne part jamais vers WhatsApp");
    assert.deepEqual(backend.rpcCalls.find((c) => c.name === "mark_whatsapp_opened")?.args, {
      p_order_id: TENANT.orderId,
      p_token: TENANT.publicToken,
    });
    assert.ok(container.textContent?.includes("via WhatsApp"));
    assertTrackingIsPrimary(container);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("CCLT-JOURNEY-04 même charge create_order WhatsApp ON et OFF (WhatsApp n'influence jamais la commande)", async (t) => {
  const payloads: any[] = [];
  for (const enabled of [true, false]) {
    t.mock.restoreAll();
    const { backend, container, root } = await journey(t, { whatsapp_enabled: enabled });
    try {
      await submit(container, enabled ? "Enregistrer et continuer sur WhatsApp" : "Valider la commande");
      payloads.push(backend.rpcCalls.find((c) => c.name === "create_order")?.args);
    } finally {
      root.unmount();
      container.remove();
    }
  }
  assert.deepEqual(payloads[0], payloads[1]);
});
