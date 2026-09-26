import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ====================================================================
// Scanym — LOT 03 CLIENT GOLDEN PATH CONSOLIDATION — parcours DOM réel.
//
// Monte components/MenuView.tsx COMPLET et le pilote comme un client :
//
//   catalogue -> sélection produit -> panier -> checkout (totaux) ->
//   create_order -> écran de confirmation -> lien de suivi ->
//   POST /api/track/exchange (Tracking v3.1) -> session de suivi.
//
// Même harnais que tests/v122i-tracking-menuview-wiring.dom.test.ts
// (bundle esbuild, lib/supabase.ts externalisé, `supabase.rpc`/`from`
// interceptés = frontière réseau la plus basse). AUCUNE base réelle,
// AUCUN envoi : `create_order` est servi par un faux serveur LOCAL
// (fakeCreateOrder ci-dessous) qui recalcule les montants depuis son
// propre catalogue, comme la fonction SQL ; `window.open` (WhatsApp) et
// `fetch` (autocomplétion d'adresse) sont interceptés et enregistrés.
//
// Couvre : matrice des modes de retrait (table/pickup/delivery),
// totaux courants + frais de livraison, autorité des montants serveur,
// contrat requête/réponse create_order, confirmation, transition vers
// Tracking v3.1 sans fuite de jeton, chemins d'échec qui ne créent
// aucune commande, double envoi, isolation des tenants.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { NextRequest } = await import("next/server");
const { POST: exchangePost } = await import("../app/api/track/exchange/route.ts");
const { verifyTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);
const { parseTrackingFragment } = await import("../lib/tracking/link.ts");
const { formatPrice } = await import("../lib/whatsapp.ts");

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v171b-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --- Utilitaires DOM (mêmes conventions que v101/v122i) ----------------

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
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

function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

function inputById(container: Element, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}

function findTrackingAnchor(container: Element): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("/track/"));
}

const SEND_LABEL = "Enregistrer et continuer sur WhatsApp";
const CONFIRM_TITLE = "Commande envoyée avec succès !";
const ORDER_FAILED = "L'envoi a échoué. Votre panier est conservé, vous pouvez réessayer.";
const eur = (n: number) => formatPrice(n, "EUR");

// --- Fixtures : deux tenants distincts --------------------------------

interface TenantFixture {
  id: string;
  slug: string;
  name: string;
  orderId: string;
  publicToken: string;
  items: { id: string; name: string; price: number }[];
  saleModes: { mode_code: string }[];
  fulfillmentRules: unknown[];
}

const TENANT_A: TenantFixture = {
  id: "aaaaaaaa-0000-4000-8000-00000000000a",
  slug: "golden-bistro",
  name: "Golden Bistro (test)",
  orderId: "11111111-1111-4111-8111-111111111111",
  publicToken: "22222222-2222-4222-8222-222222222222",
  items: [
    { id: "a1000000-0000-4000-8000-000000000001", name: "Burger maison", price: 12.5 },
    { id: "a1000000-0000-4000-8000-000000000002", name: "Limonade", price: 3.2 },
  ],
  saleModes: [{ mode_code: "table" }, { mode_code: "pickup" }, { mode_code: "delivery" }],
  fulfillmentRules: [
    {
      fulfillment_code: "golden_paris_INTERNAL",
      zone_prefixes: ["75"],
      is_fallback: false,
      min_items: 1,
      customer_text: "Livraison Paris intra-muros",
      display_order: 0,
      pricing_mode: "fixed",
      fixed_fee: 2.5,
      free_threshold: null,
    },
  ],
};

const TENANT_B: TenantFixture = {
  id: "bbbbbbbb-0000-4000-8000-00000000000b",
  slug: "other-bistro",
  name: "Other Bistro (test)",
  orderId: "33333333-3333-4333-8333-333333333333",
  publicToken: "44444444-4444-4444-8444-444444444444",
  items: [{ id: "b1000000-0000-4000-8000-000000000001", name: "Tarte du voisin", price: 5 }],
  saleModes: [{ mode_code: "pickup" }],
  fulfillmentRules: [],
};

const TENANTS = [TENANT_A, TENANT_B];

function restaurantProps(tenant: TenantFixture) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: tenant.id,
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
    },
    categories: [
      {
        id: `cat-${tenant.slug}`,
        restaurant_id: tenant.id,
        name: "Carte",
        display_order: 1,
        is_active: true,
        menu_items: tenant.items.map((item, i) => ({
          id: item.id,
          category_id: `cat-${tenant.slug}`,
          name: item.name,
          description: null,
          short_description: null,
          price: item.price,
          image_url: null,
          display_order: i + 1,
          is_available: true,
        })),
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

const FIELD_REQUIREMENTS: Record<string, unknown[]> = {
  table: [],
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

const CAPABILITY_ID = "55555555-5555-4555-8555-555555555555";
const CAPABILITY_SECRET = "ef".repeat(32);

// --- Faux backend local ------------------------------------------------

type RpcResult = { data: unknown; error: unknown };

interface Backend {
  rpcCalls: { name: string; args: any }[];
  createOrderCalls: () => any[];
  openedUrls: string[];
  fetchUrls: string[];
  unexpected: string[];
}

/**
 * Réplique LOCALE du contrat de create_order (v2.5) : tenant résolu par
 * slug, produits cherchés DANS ce tenant uniquement, montants recalculés
 * depuis le catalogue serveur (jamais lus dans la charge), total =
 * sous-total + frais. Aucune base, aucun effet de bord.
 */
function fakeCreateOrder(args: any, serverDeliveryFee: number, orderNumber: number): RpcResult {
  const tenant = TENANTS.find((t) => t.slug === args.p_slug);
  if (!tenant) return { data: null, error: { code: "P0001", message: `Restaurant introuvable ou inactif: ${args.p_slug}` } };
  if (!Array.isArray(args.p_items) || args.p_items.length === 0) {
    return { data: null, error: { code: "P0001", message: "Commande vide" } };
  }
  let subtotalCents = 0;
  for (const line of args.p_items) {
    const item = tenant.items.find((i) => i.id === line.menu_item_id);
    if (!item) {
      return { data: null, error: { code: "P0001", message: `Article indisponible ou étranger à ce restaurant: ${line.menu_item_id}` } };
    }
    subtotalCents += Math.round(item.price * 100) * line.quantity;
  }
  const feeCents = args.p_service_mode === "delivery" ? Math.round(serverDeliveryFee * 100) : 0;
  return {
    data: [
      {
        order_id: tenant.orderId,
        order_number: orderNumber,
        public_token: tenant.publicToken,
        subtotal: (subtotalCents / 100).toFixed(2),
        delivery_fee: (feeCents / 100).toFixed(2),
        total: ((subtotalCents + feeCents) / 100).toFixed(2),
      },
    ],
    error: null,
  };
}

function installBackend(
  t: { mock: { method: Function }; after: (fn: () => void) => void },
  opts: {
    serverDeliveryFee?: number;
    createOrder?: (args: any) => RpcResult | Promise<RpcResult>;
  } = {}
): Backend {
  const backend: Backend = {
    rpcCalls: [],
    createOrderCalls: () => backend.rpcCalls.filter((c) => c.name === "create_order").map((c) => c.args),
    openedUrls: [],
    fetchUrls: [],
    unexpected: [],
  };
  let orderNumber = 100;
  const tenantById = (id: string) => TENANTS.find((x) => x.id === id);

  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    backend.unexpected.push(`from:${table}`);
    throw new Error(`table inattendue : ${table}`);
  });

  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    backend.rpcCalls.push({ name, args });
    switch (name) {
      case "get_restaurant_public_sale_modes": {
        const tenant = tenantById(args.p_restaurant_id);
        if (!tenant) return { data: null, error: { code: "P0001", message: "tenant inconnu" } };
        return {
          data: tenant.saleModes.map((m) => ({
            mode_code: m.mode_code,
            customer_text: null,
            pricing_mode: "free",
            fixed_fee: null,
            free_threshold: null,
            delay_value: null,
            delay_unit: null,
          })),
          error: null,
        };
      }
      case "get_restaurant_public_field_requirements":
        return { data: FIELD_REQUIREMENTS[args.p_mode_code] ?? [], error: null };
      // DELIVERY COUNTRY SCOPE v1 -- ces locataires sont français ;
      // leur configuration L2 le dit désormais explicitement, au lieu
      // d'être supposée par le code.
      case "get_restaurant_public_delivery_countries":
        return { data: [{
            country_code: "FR",
            country_name: "France",
            postal_code_pattern: "^[0-9]{5}$",
            phone_pattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$",
            address_provider: "ban_ign",
            address_line_order: "number_first",
          }], error: null };
      case "get_restaurant_public_delivery_info":
        return { data: [], error: null };
      case "get_restaurant_public_delivery_fulfillments": {
        const tenant = tenantById(args.p_restaurant_id);
        return { data: tenant?.fulfillmentRules ?? [], error: null };
      }
      case "get_restaurant_public_cgv":
        return { data: [], error: null };
      case "create_order":
        orderNumber += 1;
        return opts.createOrder
          ? opts.createOrder(args)
          : fakeCreateOrder(args, opts.serverDeliveryFee ?? 2.5, orderNumber);
      case "mark_whatsapp_opened":
        return { data: null, error: null };
      case "upgrade_legacy_tracking_capability": {
        const tenant = TENANTS.find((x) => x.orderId === args.p_order_id);
        const ok = tenant && tenant.publicToken === args.p_public_token;
        return {
          data: ok ? [{ capability_id: CAPABILITY_ID, capability_secret: CAPABILITY_SECRET }] : [],
          error: null,
        };
      }
      default:
        backend.unexpected.push(`rpc:${name}`);
        throw new Error(`RPC inattendue : ${name}`);
    }
  });

  // WhatsApp : navigation hors périmètre -- enregistrée, jamais effectuée
  // (objet non-null : même chemin que la production, sans le repli
  // `window.location.href = url`, comme v122i).
  const realOpen = window.open;
  (window as any).open = (url: string) => {
    backend.openedUrls.push(url);
    return {};
  };
  t.after(() => {
    (window as any).open = realOpen;
  });

  // Autocomplétion d'adresse (lecture publique) : servie vide, jamais
  // sur le réseau. Toute autre requête sortante est enregistrée et
  // refusée -- aucun fournisseur (paiement, livraison, e-mail) ne doit
  // être contacté par ce parcours.
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input instanceof URL ? input.href : (input as any)?.url ?? input);
    backend.fetchUrls.push(url);
    if (url.startsWith("https://data.geopf.fr/geocodage/search")) {
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`requête sortante inattendue : ${url}`);
  });

  return backend;
}

// --- Pilotage du parcours ---------------------------------------------

async function renderMenu(tenant: TenantFixture) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: restaurantProps(tenant) }));
  await flush();
  return { container, root };
}

function productCard(container: Element, name: string): HTMLElement {
  const card = [...container.querySelectorAll("article")].find(
    (a) => a.querySelector("h3")?.textContent === name
  );
  assert.ok(card, `la fiche produit "${name}" doit être affichée au catalogue`);
  return card as HTMLElement;
}

async function selectProduct(container: Element, name: string, quantity: number) {
  const add = buttonWithText(productCard(container, name), "Ajouter");
  assert.ok(add, `bouton Ajouter de "${name}"`);
  click(add!);
  await flush();
  for (let i = 1; i < quantity; i++) {
    const plus = productCard(container, name).querySelector(
      'button[aria-label="Augmenter la quantité"]'
    );
    assert.ok(plus, `bouton + de "${name}"`);
    click(plus!);
    await flush();
  }
}

async function openCart(container: Element) {
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  assert.ok(cartBar, "la barre panier doit apparaître dès qu'un produit est sélectionné");
  click(cartBar!);
  await flush();
}

async function chooseMode(container: Element, label: string) {
  const btn = buttonWithText(container, label);
  assert.ok(btn, `le mode "${label}" doit être proposé`);
  click(btn!);
  await flush();
}

async function fillPickup(container: Element, fields: { name?: string; phone?: string }) {
  await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");
  if (fields.name !== undefined) setNativeValue(inputById(container, "customer_name")!, fields.name);
  if (fields.phone !== undefined) setNativeValue(inputById(container, "phone")!, fields.phone);
  await flush(50);
  await flush();
}

async function fillDelivery(container: Element, postalCode: string) {
  await waitFor(() => inputById(container, "customer_name") !== null, "champs delivery rendus");
  setNativeValue(inputById(container, "customer_name")!, "Yakout");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  setNativeValue(inputById(container, "street")!, "12 rue des Lilas");
  setNativeValue(inputById(container, "city")!, "Paris");
  setNativeValue(inputById(container, "postalCode")!, postalCode);
  await flush(50);
  await flush();
}

/** catalogue -> 2 x Burger + 1 x Limonade -> panier ouvert. */
async function goldenCatalogueToCart(tenant: TenantFixture = TENANT_A) {
  const { container, root } = await renderMenu(tenant);
  // Catalogue : produits et prix courants affichés.
  for (const item of tenant.items) {
    productCard(container, item.name);
    assert.ok(container.textContent?.includes(eur(item.price)), `prix de "${item.name}" affiché`);
  }
  assert.equal(findTrackingAnchor(container), undefined, "aucun lien de suivi avant toute commande");

  await selectProduct(container, "Burger maison", 2);
  await selectProduct(container, "Limonade", 1);
  await openCart(container);
  return { container, root };
}

async function submitAndConfirm(container: Element) {
  const send = buttonWithText(container, SEND_LABEL);
  assert.ok(send, "le bouton d'envoi doit être atteignable");
  click(send!);
  await flush();
  const timingNotice = container.querySelector<HTMLDialogElement>(
    '[data-delivery-timing-notice="true"][open]'
  );
  if (timingNotice) {
    const acknowledge = buttonWithText(timingNotice, "J'ai compris, continuer");
    assert.ok(acknowledge, "le message de délai configuré doit pouvoir être confirmé");
    click(acknowledge!);
  }
  await waitFor(() => container.textContent?.includes(CONFIRM_TITLE) ?? false, "écran de confirmation");
}

/**
 * Confirmation -> Tracking v3.1 : relit le lien affiché, vérifie qu'il
 * ne porte le jeton qu'en fragment, puis rejoue l'échange POST réel
 * (route.ts) avec ce que TrackingEntryGate enverrait.
 */
async function followTrackingLink(container: Element, tenant: TenantFixture) {
  const anchor = findTrackingAnchor(container);
  assert.ok(anchor, "le lien de suivi doit être affiché après confirmation");
  assert.equal(anchor!.textContent, "Suivre ma commande");
  const href = anchor!.getAttribute("href")!;
  const url = new URL(href, "http://localhost");
  assert.equal(url.pathname, `/track/${tenant.orderId}`, "le chemin ne porte QUE l'order_id renvoyé par le serveur");
  assert.equal(url.search, "", "aucun jeton en chaîne de requête");
  assert.equal(href.includes(`/${tenant.publicToken}`), false, "jamais le format v1 /track/<id>/<token>");

  const fragment = parseTrackingFragment(decodeURIComponent(url.hash.slice(1)));
  assert.deepEqual(fragment, { kind: "legacy", publicToken: tenant.publicToken });

  const request = new NextRequest("http://localhost/api/track/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: tenant.orderId, publicToken: tenant.publicToken }),
  });
  assert.equal(request.nextUrl.href.includes(tenant.publicToken), false, "le jeton ne transite que dans le corps POST");
  const response = await exchangePost(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true }, "réponse minimale, aucune donnée ni jeton en écho");

  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.ok(setCookie.startsWith(`${TRACKING_SESSION_COOKIE_NAME}=`));
  assert.ok(/HttpOnly/i.test(setCookie));
  assert.ok(setCookie.includes(`Path=/track/${tenant.orderId}`), "cookie limité au chemin de CETTE commande");
  for (const secret of [tenant.publicToken, CAPABILITY_ID, CAPABILITY_SECRET]) {
    assert.equal(setCookie.includes(secret), false, "aucun matériel de possession en clair dans Set-Cookie");
  }
  const sessionToken = setCookie.split(";")[0]!.split("=").slice(1).join("=");
  return sessionToken;
}

function assertCreateOrderPayloadIsReferenceOnly(payload: any) {
  const keys: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.push(k);
        walk(child);
      }
    }
  };
  walk(payload);
  const forbidden = keys.filter((k) => /price|total|amount|fee|tax|vat|restaurant_id|restaurantId|currency/i.test(k));
  assert.deepEqual(forbidden, [], `clés monétaires/tenant transmises par le client : ${forbidden.join(", ")}`);
}

function assertTenantScopedCalls(backend: Backend, tenant: TenantFixture) {
  for (const call of backend.rpcCalls) {
    if (call.args && "p_restaurant_id" in call.args) {
      assert.equal(call.args.p_restaurant_id, tenant.id, `${call.name} doit viser le tenant rendu`);
    }
    if (call.args && "p_slug" in call.args) {
      assert.equal(call.args.p_slug, tenant.slug, `${call.name} doit viser le tenant rendu`);
    }
  }
}

function assertNoExternalEffects(backend: Backend) {
  assert.deepEqual(backend.unexpected, [], "aucun appel backend hors contrat du parcours");
  const outbound = backend.fetchUrls.filter((u) => !u.startsWith("https://data.geopf.fr/geocodage/search"));
  assert.deepEqual(outbound, [], "aucune requête vers un fournisseur externe (paiement, livraison, e-mail)");
  for (const url of backend.openedUrls) {
    assert.ok(url.startsWith("https://wa.me/"), "seule la redirection WhatsApp (enregistrée, non suivie) est ouverte");
  }
}

const GOLDEN_ITEMS = [
  { menu_item_id: TENANT_A.items[0].id, quantity: 2, option_item_id: null },
  { menu_item_id: TENANT_A.items[1].id, quantity: 1, option_item_id: null },
];

// ====================================================================
// Matrice des modes de retrait -- parcours complet
// ====================================================================

test("GP-DOM-01 table : catalogue -> sélection -> panier (28,20) -> table 4 -> create_order -> confirmation -> suivi v3.1", async (t) => {
  const backend = installBackend(t);
  const { container, root } = await goldenCatalogueToCart();
  try {
    assert.ok(container.textContent?.includes(eur(28.2)), "total panier courant = 2 x 12,50 + 3,20");
    assert.equal(container.textContent?.includes("Frais de livraison"), false, "aucun frais hors livraison");

    await chooseMode(container, "Sur place, à table");
    assert.equal(buttonWithText(container, SEND_LABEL), undefined, "envoi bloqué tant qu'aucune table n'est choisie");
    await chooseMode(container, "4");
    assert.equal(backend.createOrderCalls().length, 0, "aucune commande avant le clic d'envoi");

    await submitAndConfirm(container);

    const calls = backend.createOrderCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      p_slug: TENANT_A.slug,
      p_service_mode: "table",
      p_items: GOLDEN_ITEMS,
      p_table_number: 4,
      p_customer: {},
      p_note: null,
      p_language: "fr",
      p_cgv_accepted: false,
    });
    assertCreateOrderPayloadIsReferenceOnly(calls[0]);

    const text = container.textContent ?? "";
    assert.ok(text.includes("Commande n°101"), "numéro de commande renvoyé par le serveur");
    assert.ok(text.includes("Montant total :"));
    assert.ok(text.includes(eur(28.2)), "total autoritaire serveur affiché");
    assert.ok(text.includes("🪑 Table 4"));

    const session = await followTrackingLink(container, TENANT_A);
    assert.deepEqual(verifyTrackingSessionToken(session, TENANT_A.orderId), {
      orderId: TENANT_A.orderId,
      capabilityId: CAPABILITY_ID,
      secret: CAPABILITY_SECRET,
    });
    assert.equal(
      verifyTrackingSessionToken(session, TENANT_B.orderId),
      null,
      "la session de suivi d'une commande n'ouvre jamais une autre commande"
    );
    assert.deepEqual(
      backend.rpcCalls.find((c) => c.name === "upgrade_legacy_tracking_capability")?.args,
      { p_order_id: TENANT_A.orderId, p_public_token: TENANT_A.publicToken }
    );

    assert.equal(backend.openedUrls.length, 1, "une seule ouverture WhatsApp");
    const waMessage = decodeURIComponent(backend.openedUrls[0]);
    assert.equal(waMessage.includes(TENANT_A.publicToken), false, "le jeton de suivi ne fuit jamais vers le commerçant");
    assert.equal(waMessage.includes("/track/"), false);
    assert.deepEqual(
      backend.rpcCalls.find((c) => c.name === "mark_whatsapp_opened")?.args,
      { p_order_id: TENANT_A.orderId, p_token: TENANT_A.publicToken }
    );

    assertTenantScopedCalls(backend, TENANT_A);
    assertNoExternalEffects(backend);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("GP-DOM-02 pickup : coordonnées requises -> create_order sans adresse -> confirmation retrait -> suivi v3.1", async (t) => {
  const backend = installBackend(t);
  const { container, root } = await goldenCatalogueToCart();
  try {
    await chooseMode(container, "À emporter");
    await fillPickup(container, { name: "Yakout", phone: "0612345678" });
    assert.ok(container.textContent?.includes(eur(28.2)));
    assert.equal(container.textContent?.includes("Frais de livraison"), false);

    await submitAndConfirm(container);

    const calls = backend.createOrderCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      p_slug: TENANT_A.slug,
      p_service_mode: "pickup",
      p_items: GOLDEN_ITEMS,
      p_table_number: null,
      p_customer: {
        name: "Yakout",
        // CFTE v1 : deux clés ADDITIVES, `null` lorsque le client a
        // saisi son nom dans le champ unique historique (ce parcours
        // doré utilise le jeu d'exigences legacy du backend simulé).
        first_name: null,
        last_name: null,
        phone: "0612345678",
        email: null,
        address: null,
        postalCode: null,
        street: null,
        city: null,
        // DELIVERY COUNTRY SCOPE v1 : `null` hors livraison.
        country: null,
      },
      p_note: null,
      p_language: "fr",
      p_cgv_accepted: false,
    });
    assertCreateOrderPayloadIsReferenceOnly(calls[0]);

    const text = container.textContent ?? "";
    assert.ok(text.includes("🛍️ À emporter — retrait sur place"));
    assert.ok(text.includes("📞 0612345678"));
    assert.ok(text.includes(eur(28.2)));

    await followTrackingLink(container, TENANT_A);
    assertTenantScopedCalls(backend, TENANT_A);
    assertNoExternalEffects(backend);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("GP-DOM-03 delivery : zone éligible, frais estimé affiché (28,20 + 2,50 = 30,70) -> create_order avec adresse structurée -> confirmation -> suivi v3.1", async (t) => {
  const backend = installBackend(t, { serverDeliveryFee: 2.5 });
  const { container, root } = await goldenCatalogueToCart();
  try {
    await chooseMode(container, "Livraison");
    await fillDelivery(container, "75001");
    await waitFor(
      () => container.textContent?.includes("Livraison Paris intra-muros") ?? false,
      "règle de livraison éligible affichée"
    );
    const cartText = container.textContent ?? "";
    assert.ok(cartText.includes("Sous-total produits"));
    assert.ok(cartText.includes("Frais de livraison"));
    assert.ok(cartText.includes(eur(2.5)));
    assert.ok(cartText.includes(eur(30.7)), "total checkout = sous-total + frais");
    assert.equal(container.innerHTML.includes("golden_paris_INTERNAL"), false, "code de fulfillment interne jamais exposé");

    await submitAndConfirm(container);

    const calls = backend.createOrderCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      p_slug: TENANT_A.slug,
      p_service_mode: "delivery",
      p_items: GOLDEN_ITEMS,
      p_table_number: null,
      p_customer: {
        name: "Yakout",
        first_name: null,
        last_name: null,
        phone: "0612345678",
        email: null,
        address: "12 rue des Lilas, 75001 Paris",
        postalCode: "75001",
        street: "12 rue des Lilas",
        city: "Paris",
        // DELIVERY COUNTRY SCOPE v1 : pays RÉSOLU depuis la
        // configuration du marchand (L2 = {FR}), jamais saisi par le
        // client ni codé en dur dans l'écran.
        country: "FR",
      },
      p_note: null,
      p_language: "fr",
      p_cgv_accepted: false,
    });
    assertCreateOrderPayloadIsReferenceOnly(calls[0]);

    const text = container.textContent ?? "";
    assert.ok(text.includes("🛵 Livraison"));
    assert.ok(text.includes("📍 12 rue des Lilas, 75001 Paris"));
    assert.ok(text.includes(eur(30.7)), "total autoritaire serveur (frais inclus)");

    await followTrackingLink(container, TENANT_A);
    assertTenantScopedCalls(backend, TENANT_A);
    assertNoExternalEffects(backend);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("GP-DOM-04 autorité des montants : le serveur résout un frais différent de l'estimation (3,00 vs 2,50) -- confirmation et message commerçant suivent le total SERVEUR", async (t) => {
  const backend = installBackend(t, { serverDeliveryFee: 3 });
  const { container, root } = await goldenCatalogueToCart();
  try {
    await chooseMode(container, "Livraison");
    await fillDelivery(container, "75001");
    await waitFor(() => container.textContent?.includes(eur(30.7)) ?? false, "estimation client affichée");

    await submitAndConfirm(container);

    const text = container.textContent ?? "";
    assert.ok(text.includes(eur(31.2)), "la confirmation affiche order.total renvoyé par create_order");
    assert.equal(text.includes(eur(30.7)), false, "jamais l'estimation client après confirmation");

    const waMessage = decodeURIComponent(backend.openedUrls[0] ?? "");
    assert.ok(waMessage.includes(`💰 Total : ${eur(31.2)}`), "message commerçant : total serveur");
    assert.ok(waMessage.includes(`🚚 Frais de livraison : ${eur(3)}`), "message commerçant : frais serveur");
    assert.ok(waMessage.includes(`🧺 Sous-total produits : ${eur(28.2)}`));
    assertNoExternalEffects(backend);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// Chemins d'échec -- aucune commande ne doit être créée
// ====================================================================

test("GP-DOM-05 validation : panier vide, coordonnées incomplètes, zone non desservie -- envoi impossible, create_order JAMAIS appelé", async (t) => {
  const backend = installBackend(t);

  // (a) Panier vide : aucune barre panier, aucun envoi possible.
  {
    const { container, root } = await renderMenu(TENANT_A);
    try {
      assert.equal(
        [...container.querySelectorAll("button")].some((b) => b.textContent?.includes("🛒")),
        false,
        "aucune barre panier sans produit"
      );
      assert.equal(buttonWithText(container, SEND_LABEL), undefined);
    } finally {
      root.unmount();
      container.remove();
    }
  }

  // (b) Retrait sans téléphone requis.
  {
    const { container, root } = await goldenCatalogueToCart();
    try {
      await chooseMode(container, "À emporter");
      await fillPickup(container, { name: "Yakout" });
      assert.equal(buttonWithText(container, SEND_LABEL), undefined, "téléphone requis manquant -> envoi bloqué");
    } finally {
      root.unmount();
      container.remove();
    }
  }

  // (c) Livraison hors zone.
  {
    const { container, root } = await goldenCatalogueToCart();
    try {
      await chooseMode(container, "Livraison");
      await fillDelivery(container, "13001");
      assert.equal(buttonWithText(container, SEND_LABEL), undefined, "code postal hors zone -> envoi bloqué");
    } finally {
      root.unmount();
      container.remove();
    }
  }

  assert.equal(backend.createOrderCalls().length, 0, "aucune tentative de création de commande");
  assert.deepEqual(backend.openedUrls, []);
  assertNoExternalEffects(backend);
});

test("GP-DOM-06 rejet serveur (article étranger au restaurant) : aucune confirmation, aucun lien de suivi, aucun WhatsApp, panier conservé, message générique", async (t) => {
  const quietError = t.mock.method(console, "error", () => {});
  const backend = installBackend(t, {
    createOrder: () => ({
      data: null,
      error: { code: "P0001", message: "Article indisponible ou étranger à ce restaurant: x" },
    }),
  });
  const { container, root } = await goldenCatalogueToCart();
  try {
    await chooseMode(container, "À emporter");
    await fillPickup(container, { name: "Yakout", phone: "0612345678" });
    const send = buttonWithText(container, SEND_LABEL);
    assert.ok(send);
    click(send!);
    await waitFor(() => container.textContent?.includes(ORDER_FAILED) ?? false, "message d'échec générique");

    const text = container.textContent ?? "";
    assert.equal(text.includes(CONFIRM_TITLE), false, "aucune confirmation après un rejet");
    assert.equal(findTrackingAnchor(container), undefined, "aucun lien de suivi sans commande créée");
    assert.equal(text.includes("étranger à ce restaurant"), false, "le message SQL brut ne fuit jamais");
    assert.ok(text.includes(eur(28.2)), "panier conservé intact");
    assert.ok(buttonWithText(container, SEND_LABEL), "le client peut réessayer");

    assert.equal(backend.createOrderCalls().length, 1, "une seule tentative, jamais de réessai automatique");
    assert.deepEqual(backend.openedUrls, [], "aucun WhatsApp pour une commande non créée");
    assert.equal(backend.rpcCalls.some((c) => c.name === "mark_whatsapp_opened"), false);
    assert.equal(backend.rpcCalls.some((c) => c.name === "upgrade_legacy_tracking_capability"), false);
    assert.ok(quietError.mock.callCount() >= 1);
    assertNoExternalEffects(backend);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("GP-DOM-07 double envoi : un second clic pendant l'enregistrement ne crée jamais une seconde commande", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = installBackend(t, {
    createOrder: async (args) => {
      await gate;
      return fakeCreateOrder(args, 2.5, 101);
    },
  });
  const { container, root } = await goldenCatalogueToCart();
  try {
    await chooseMode(container, "Sur place, à table");
    await chooseMode(container, "2");
    const send = buttonWithText(container, SEND_LABEL);
    assert.ok(send);
    click(send!);
    await flush();

    const pending =
      buttonWithText(container, "Enregistrement en cours…") ?? buttonWithText(container, SEND_LABEL) ?? send!;
    assert.ok(pending.disabled, "le bouton est désactivé pendant l'enregistrement");
    click(pending);
    click(send!);
    await flush();
    assert.equal(backend.createOrderCalls().length, 1, "un seul create_order en vol");

    release();
    await waitFor(() => container.textContent?.includes(CONFIRM_TITLE) ?? false, "confirmation après résolution");
    assert.equal(backend.createOrderCalls().length, 1, "toujours une seule commande");
    assert.equal(backend.openedUrls.length, 1);
  } finally {
    release();
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// Isolation des tenants
// ====================================================================

test("GP-DOM-08 isolation tenant : le menu d'un autre établissement ne voit, ne charge et ne commande que ses propres produits", async (t) => {
  const backend = installBackend(t);
  const { container, root } = await renderMenu(TENANT_B);
  try {
    for (const item of TENANT_A.items) {
      assert.equal(container.textContent?.includes(item.name), false, `produit du tenant A "${item.name}" jamais affiché`);
    }
    await selectProduct(container, "Tarte du voisin", 1);
    await openCart(container);
    // Mode unique (pickup) : présélectionné, pas de choix explicite.
    await fillPickup(container, { name: "Yakout", phone: "0612345678" });
    assert.ok(container.textContent?.includes(eur(5)));

    await submitAndConfirm(container);

    const calls = backend.createOrderCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].p_slug, TENANT_B.slug);
    assert.deepEqual(calls[0].p_items, [
      { menu_item_id: TENANT_B.items[0].id, quantity: 1, option_item_id: null },
    ]);
    const anchor = findTrackingAnchor(container);
    assert.ok(anchor);
    assert.equal(new URL(anchor!.getAttribute("href")!, "http://localhost").pathname, `/track/${TENANT_B.orderId}`);

    assertTenantScopedCalls(backend, TENANT_B);
    assert.equal(
      backend.rpcCalls.some((c) => c.args?.p_restaurant_id === TENANT_A.id || c.args?.p_slug === TENANT_A.slug),
      false,
      "aucune donnée du tenant A n'est jamais demandée depuis le menu du tenant B"
    );
    assertNoExternalEffects(backend);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("GP-DOM-09 isolation tenant (serveur) : une charge visant un tenant avec les produits d'un autre est rejetée sans commande ni suivi", async (t) => {
  // Contrat du faux serveur, identique à create_order v2.5 (produits
  // cherchés dans le tenant résolu par slug -- structure SQL prouvée par
  // tests/v171a GP-12) : un article du tenant A commandé chez B échoue.
  const result = fakeCreateOrder(
    {
      p_slug: TENANT_B.slug,
      p_service_mode: "pickup",
      p_items: [{ menu_item_id: TENANT_A.items[0].id, quantity: 1, option_item_id: null }],
    },
    0,
    1
  );
  assert.equal(result.data, null);
  assert.match(String((result.error as { message: string }).message), /étranger à ce restaurant/);

  // Et le jeton de suivi d'une commande de A ne permet jamais d'obtenir
  // une session pour la commande de B (paire croisée = invalide générique).
  installBackend(t);
  const crossed = await exchangePost(
    new NextRequest("http://localhost/api/track/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: TENANT_B.orderId, publicToken: TENANT_A.publicToken }),
    })
  );
  assert.equal(crossed.status, 400);
  assert.deepEqual(await crossed.json(), { ok: false, reason: "invalid" });
  assert.equal(crossed.headers.get("set-cookie"), null, "aucune session posée pour une paire croisée");
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
