import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — RESTAURANT CONTEXT HARDENING v1.1 (Claude Monet)
// Remédiation des blocages CTXHARD-V1-STALE-RESPONSE-01 (BLOCKER) et
// CTXHARD-V1-REGRESSION-PACK-RACE-GAP-02 (MAJOR).
//
// CE QUE CE FICHIER PROUVE, ET POURQUOI IL EXISTE
// -----------------------------------------------
// L'audit indépendant a établi que le lot précédent « claimed race
// coverage but mainly exercised unmount/remount behaviour » -- c'est
// insuffisant, parce que démonter un composant détruit de toute façon
// son état : cela ne prouve RIEN sur la vraie séquence de production,
// qui est un changement d'établissement DANS UNE INSTANCE TOUJOURS
// MONTÉE, avec deux requêtes concurrentes en vol.
//
// Ici, AUCUN test ne démonte quoi que ce soit entre les deux requêtes.
// La bascule A -> B se fait par le VRAI sélecteur d'établissement de
// DashboardNav, sur la MÊME instance montée, exactement comme le
// gérant le fait.
//
// AUCUNE HYPOTHÈSE DE TEMPS. Les services sont remplacés par des
// promesses DIFFÉRÉES dont le test détient les résolveurs : l'ORDRE de
// résolution est donc décidé par le test, jamais par une temporisation.
// L'attente se fait sur une CONDITION OBSERVABLE (« la requête est
// enregistrée »), jamais sur un délai deviné.
//
// Invariant permanent vérifié (mandat §3) : pour chaque module,
//   URL = contexte résolu = entête = provenance des données affichées
//       = restaurant des mutations = restaurant des abonnements.
// Une réponse périmée ne doit JAMAIS devenir visible ni actionnable.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard",
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

const A_ID = "r-au-lait-cru";
const A_NAME = "Au lait cru";
const B_ID = "r-sanaa";
const B_NAME = "Sanaa Cookies & Fondant";

function mapping(id: string, name: string, slug: string) {
  return { restaurant_id: id, role: "owner" as const, restaurants: { id, name, slug } };
}
/** A en PREMIER : une éventuelle retombée sur mappings[0] choisirait A. */
const MAPPINGS = [mapping(A_ID, A_NAME, "au-lait-cru"), mapping(B_ID, B_NAME, "sanaa")];

(globalThis as any).__navMappings = MAPPINGS as unknown[];
(globalThis as any).__navIsOperator = false;
(globalThis as any).__navPathname = "/dashboard";
/** Requêtes DIFFÉRÉES en vol : { fn, id, resolve, reject }. */
(globalThis as any).__deferred = [] as any[];
/** Journal de tout appel de service portant un restaurant_id. */
(globalThis as any).__fetchLog = [] as string[];
/** Mutations réellement soumises au service (preuve de provenance). */
(globalThis as any).__mutationLog = [] as string[];
/** Abonnements temps réel ouverts / fermés. */
(globalThis as any).__subLog = [] as string[];
/** Rappels d'abonnement vivants, par restaurant -- pour rejouer un
 *  évènement PÉRIMÉ venu d'un abonnement qui aurait dû être fermé. */
(globalThis as any).__subCallbacks = {} as Record<string, (() => void)[]>;

// --------------------------------------------------------------
// Mocks générés depuis la liste RÉELLE des exports du module : un
// export ajouté ailleurs ne peut pas casser ce fichier pour une raison
// sans rapport avec le contexte restaurant.
// --------------------------------------------------------------
function exportedNames(relPath: string): { fns: string[]; classes: string[] } {
  const src = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return {
    fns: [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    classes: [
      ...[...src.matchAll(/export\s+class\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
      ...[...src.matchAll(/export\s*\{([^}]*)\}\s*from/g)].flatMap((m) =>
        m[1]
          .split(",")
          .map((p) => p.trim().split(/\s+as\s+/).pop()!.trim())
          .filter(Boolean)
      ),
    ],
  };
}

function buildServiceMock(relPath: string, overrides: Record<string, string>): string {
  const { fns, classes } = exportedNames(relPath);
  const lines: string[] = [];
  for (const c of classes) lines.push(`export class ${c} extends Error {}`);
  for (const f of fns) {
    if (overrides[f]) continue;
    lines.push(`export async function ${f}() { return undefined; }`);
  }
  for (const body of Object.values(overrides)) lines.push(body);
  return lines.join("\n");
}

/**
 * Lecture DIFFÉRÉE : la promesse ne se résout que lorsque le test le
 * décide. C'est le cœur du dispositif -- il n'y a plus aucune course
 * « au hasard », la séquence est entièrement dirigée.
 */
const deferredRead = (name: string) => `export async function ${name}(id) {
  (globalThis).__fetchLog.push(${JSON.stringify(name)} + ":" + id);
  return new Promise((resolve, reject) => {
    (globalThis).__deferred.push({ fn: ${JSON.stringify(name)}, id, resolve, reject });
  });
}`;

/** Lecture immédiate (bruit de fond non pertinent pour la course). */
const instantRead = (name: string, value: string) => `export async function ${name}(id) {
  (globalThis).__fetchLog.push(${JSON.stringify(name)} + ":" + id);
  return ${value};
}`;

const MOCK_DASHBOARD = buildServiceMock("lib/services/dashboard.ts", {
  getMerchantRestaurants: `export async function getMerchantRestaurants() { return (globalThis).__navMappings; }`,
  getDashboardOrders: deferredRead("getDashboardOrders"),
  getMerchantCatalogue: deferredRead("getMerchantCatalogue"),
  getReceiptSettings: deferredRead("getReceiptSettings"),
  getRestaurantSettings: deferredRead("getRestaurantSettings"),
  getRestaurantActiveLanguages: instantRead(
    "getRestaurantActiveLanguages",
    `[{ code: "fr", label: "Francais", dir: "ltr", display_order: 1 }, { code: "en", label: "English", dir: "ltr", display_order: 2 }]`
  ),
  getRestaurantTranslationSettings: instantRead("getRestaurantTranslationSettings", `{ source_language: "fr" }`),
  getRestaurantCurrency: instantRead("getRestaurantCurrency", `"EUR"`),
  getMerchantPaymentProviderConfig: deferredRead("getMerchantPaymentProviderConfig"),
  getMerchantDeliveryFulfillmentPricing: deferredRead("getMerchantDeliveryFulfillmentPricing"),
  getSupportedLanguages: `export async function getSupportedLanguages() { return [{ code: "fr", label: "Francais" }]; }`,
  updateOrderStatus: `export async function updateOrderStatus(orderId, status) {
  (globalThis).__mutationLog.push("updateOrderStatus:" + orderId + ":" + status);
  return undefined;
}`,
});

const MOCK_ESTABLISHMENTS = buildServiceMock("lib/services/establishments.ts", {
  isScanymOperator: `export async function isScanymOperator() { return (globalThis).__navIsOperator; }`,
  getEstablishmentSummary: `export async function getEstablishmentSummary(id) {
  const known = { ${JSON.stringify(A_ID)}: ${JSON.stringify(A_NAME)}, ${JSON.stringify(B_ID)}: ${JSON.stringify(B_NAME)} };
  return { id, name: known[id] ?? id, slug: id };
}`,
  listEstablishments: `export async function listEstablishments() { return []; }`,
});

const MOCK_LEGAL_CGV = buildServiceMock("lib/services/legal-cgv.ts", {
  getMerchantLegalProfile: deferredRead("getMerchantLegalProfile"),
  getMerchantCgvProfile: deferredRead("getMerchantCgvProfile"),
  updateMerchantLegalProfile: `export async function updateMerchantLegalProfile(input) {
  (globalThis).__mutationLog.push("updateMerchantLegalProfile:" + (input && input.restaurantId));
  return undefined;
}`,
});

const mocks: Record<string, string> = {
  "next/navigation": `export function usePathname() { return (globalThis).__navPathname ?? "/dashboard"; }
const r = { replace: () => {}, push: () => {} };
export function useRouter() { return r; }`,
  "@/lib/services/auth": `export async function getUser() { return { id: "u" }; }
export async function getSession() { return { user: { id: "u" } }; }
export async function signOut() {}`,
  "@/lib/services/realtime": `export function subscribeToOrders(id, cb) {
  (globalThis).__subLog.push("subscribe:" + id);
  const store = (globalThis).__subCallbacks;
  (store[id] = store[id] || []).push(cb);
  return () => {
    (globalThis).__subLog.push("unsubscribe:" + id);
    const list = store[id] || [];
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  };
}`,
  "@/lib/supabase": `export const supabase = {
  rpc: async () => ({ data: null, error: null }),
  from: () => ({ select: async () => ({ data: [], error: null }) }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
};`,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/legal-cgv": MOCK_LEGAL_CGV,
};

const mockPlugin: esbuild.Plugin = {
  name: "ctxhard-v11-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "ctxmock11" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
        return { path: c ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "ctxmock11" }, (a) => ({
      contents: mocks[a.path],
      loader: "ts",
    }));
  },
};

const built = await esbuild.build({
  stdin: {
    contents: `
      export { default as Orders } from "@/app/dashboard/page";
      export { default as Catalogue } from "@/app/dashboard/catalogue/page";
      export { default as Cgv } from "@/app/dashboard/legal-cgv/page";
      export { default as Settings } from "@/app/dashboard/settings/page";
      export { default as Delivery } from "@/app/dashboard/delivery-pricing/page";
      export { default as Translations } from "@/app/dashboard/translations/page";
      export { default as Payment } from "@/app/dashboard/payment/page";
    `,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-ctx11-"));
const tmpFile = path.join(tmpDir, "pages.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const P = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------
// Pilotage du scénario
// --------------------------------------------------------------
type Deferred = { fn: string; id: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };

const deferred = () => (globalThis as any).__deferred as Deferred[];
const fetchLog = () => (globalThis as any).__fetchLog as string[];
const mutationLog = () => (globalThis as any).__mutationLog as string[];
const subLog = () => (globalThis as any).__subLog as string[];

function resetScenario(pathname: string, search: string) {
  (globalThis as any).__deferred = [];
  (globalThis as any).__fetchLog = [];
  (globalThis as any).__mutationLog = [];
  (globalThis as any).__subLog = [];
  (globalThis as any).__subCallbacks = {};
  (globalThis as any).__navMappings = MAPPINGS;
  (globalThis as any).__navIsOperator = false;
  (globalThis as any).__navPathname = pathname;
  window.history.replaceState({}, "", pathname + search);
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** Laisse React appliquer les effets/rendus déclenchés. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await tick(0);
  await tick(5);
}

/**
 * Attend une CONDITION OBSERVABLE : « une requête `fn` pour `id` est
 * enregistrée ». Jamais un délai deviné -- si la requête n'est jamais
 * émise, le test échoue avec un message explicite plutôt que de passer
 * par chance.
 */
async function waitForPending(fn: string, id: string, label: string): Promise<Deferred> {
  for (let i = 0; i < 400; i += 1) {
    const hit = deferred().find((d) => d.fn === fn && d.id === id);
    if (hit) return hit;
    await tick(5);
  }
  throw new Error(
    `${label} : aucune requête ${fn} pour ${id} n'a été émise (journal : ${JSON.stringify(fetchLog())})`
  );
}

function pendingFor(fn: string, id: string): Deferred[] {
  return deferred().filter((d) => d.fn === fn && d.id === id);
}

/** Retire la requête de la file PUIS la résout : une même requête ne
 *  peut pas être résolue deux fois. */
function resolveOne(d: Deferred, value: unknown) {
  const list = deferred();
  const i = list.indexOf(d);
  if (i >= 0) list.splice(i, 1);
  d.resolve(value);
}

/**
 * Résout TOUTES les requêtes `fn` en vol pour `id`.
 *
 * Nécessaire parce que certaines pages émettent légitimement plusieurs
 * requêtes concurrentes pour un même établissement (app/dashboard/
 * page.tsx en émet deux : l'effet « changement d'établissement » et
 * l'effet « actives/historique »). Ne résoudre que la plus ancienne
 * laisserait la plus récente en vol -- et la garde de génération
 * ignorerait alors, à juste titre, la réponse appliquée. Ce détail est
 * une PROPRIÉTÉ DU TEST, pas un assouplissement : l'ordre reste
 * entièrement dirigé par le test.
 */
async function resolvePending(fn: string, id: string, value: unknown, label: string) {
  await waitForPending(fn, id, label);
  for (const d of pendingFor(fn, id)) resolveOne(d, value);
  await settle();
}

function mount(Component: unknown) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Component as any));
  return { container, root };
}

/**
 * Bascule d'établissement par le VRAI sélecteur de DashboardNav, sur
 * l'instance TOUJOURS MONTÉE -- c'est précisément ce que le lot
 * précédent ne faisait pas (il démontait/remontait).
 */
function switchRestaurant(container: Element, id: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "le sélecteur d'établissement doit être rendu (deux rattachements)");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, id);
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function headerName(c: Element): string {
  return c.querySelector("h1")?.textContent?.trim() ?? "";
}

/** Établissement que la page transmettra à la page suivante (?r=). */
function activeRestaurantId(c: Element): string | null {
  const a = [...c.querySelectorAll("a")].find((x) => (x.getAttribute("href") ?? "").startsWith("/dashboard?r="));
  if (!a) return null;
  return new URLSearchParams((a.getAttribute("href") ?? "").split("?")[1] ?? "").get("r");
}

function textOf(c: Element): string {
  return c.textContent ?? "";
}

// --------------------------------------------------------------
// Jeux de données DISCERNABLES par établissement.
// --------------------------------------------------------------
function orderFor(restaurantId: string, number: number, id: string) {
  return {
    id,
    restaurant_id: restaurantId,
    order_number: number,
    status: "new",
    service_mode: "pickup",
    table_number: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    delivery_address: null,
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 10,
    total: 10,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [],
    tax_settings_snapshot_default_tax_rate: null,
    tax_settings_snapshot_prices_include_tax: null,
    tax_settings_snapshot_tax_label: null,
    tax_settings_snapshot_show_tax_summary: null,
    order_delivery_tax_allocations: [],
  };
}

function productFor(name: string, categoryId: string) {
  return {
    product_id: `prod-${name}`,
    category_id: categoryId,
    category_name: name,
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: `PRODUIT-${name}`,
    name_hash: "h",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 5,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
  };
}

function categoryFor(name: string) {
  return {
    category_id: `cat-${name}`,
    category_name: name,
    category_name_hash: "h",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [productFor(name, `cat-${name}`)],
    subcategories: [],
  };
}

const ORDER_A = orderFor(A_ID, 111, "order-a");
const ORDER_B = orderFor(B_ID, 777, "order-b");
const CAT_A = categoryFor("CATEGORIE-DE-A-UNIQUEMENT");
const CAT_B = categoryFor("CATEGORIE-DE-B-UNIQUEMENT");
const LEGAL_A = { restaurant_id: A_ID, legal_entity_name: "ENTITE-LEGALE-DE-A", city: "VILLE-A" };
const LEGAL_B = { restaurant_id: B_ID, legal_entity_name: "ENTITE-LEGALE-DE-B", city: "VILLE-B" };

// ====================================================================
// 1. COMMANDES — cas BLOCKER du mandat §6, dans la MÊME instance.
//    A en vol -> bascule B -> B en vol -> B résout -> A résout EN
//    RETARD -> la réponse de A doit être ignorée, B doit rester.
// ====================================================================
test("§6/§17.1 — Commandes : une réponse RETARDATAIRE de A n'écrase jamais l'affichage de B (même instance montée)", async () => {
  resetScenario("/dashboard", `?r=${A_ID}`);
  const { container, root } = mount(P.Orders);
  try {
    // --- A est le contexte courant, sa requête part.
    await waitForPending("getDashboardOrders", A_ID, "Commandes/A");

    // --- Bascule vers B SANS démonter : la requête de A reste EN VOL.
    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getDashboardOrders", B_ID, "Commandes/B");

    // Deux requêtes concurrentes coexistent réellement : c'est la
    // situation que le lot précédent n'avait jamais construite.
    assert.ok(
      deferred().some((d) => d.fn === "getDashboardOrders" && d.id === A_ID),
      "la requête de A doit être ENCORE EN VOL au moment où celle de B part"
    );

    // --- B résout et s'affiche.
    await resolvePending("getDashboardOrders", B_ID, [ORDER_B], "Commandes/B");
    assert.ok(textOf(container).includes("777"), "la commande de B doit être affichée après résolution de B");
    assert.equal(headerName(container), B_NAME, "l'entête doit nommer B");

    // --- A résout EN RETARD : doit être intégralement ignorée.
    await resolvePending("getDashboardOrders", A_ID, [ORDER_A], "Commandes/A tardif");

    const body = textOf(container);
    assert.ok(
      !body.includes("111"),
      "BLOCKER CTXHARD-V1-STALE-RESPONSE-01 : la commande de A ne doit JAMAIS apparaître sous l'entête de B"
    );
    assert.ok(body.includes("777"), "les commandes de B doivent rester affichées");
    assert.equal(headerName(container), B_NAME, "l'entête doit toujours nommer B");
    assert.equal(activeRestaurantId(container), B_ID, "le contexte transmis doit rester B");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 2. CATALOGUE — cas BLOCKER du mandat §7, dans la MÊME instance.
// ====================================================================
test("§7/§17.2 — Catalogue : une réponse RETARDATAIRE de A n'écrase jamais le catalogue de B (même instance montée)", async () => {
  resetScenario("/dashboard/catalogue", `?r=${A_ID}`);
  const { container, root } = mount(P.Catalogue);
  try {
    await waitForPending("getMerchantCatalogue", A_ID, "Catalogue/A");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getMerchantCatalogue", B_ID, "Catalogue/B");
    assert.ok(
      deferred().some((d) => d.fn === "getMerchantCatalogue" && d.id === A_ID),
      "la requête catalogue de A doit être ENCORE EN VOL quand celle de B part"
    );

    await resolvePending("getMerchantCatalogue", B_ID, [CAT_B], "Catalogue/B");
    assert.ok(textOf(container).includes(CAT_B.category_name), "le catalogue de B doit être affiché");

    await resolvePending("getMerchantCatalogue", A_ID, [CAT_A], "Catalogue/A tardif");

    const body = textOf(container);
    assert.ok(
      !body.includes(CAT_A.category_name),
      "BLOCKER : une catégorie de A ne doit JAMAIS apparaître sous l'entête de B"
    );
    assert.ok(body.includes(CAT_B.category_name), "le catalogue de B doit rester affiché");
    assert.equal(headerName(container), B_NAME, "l'entête doit nommer B");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 3. MODULE DE CONFIGURATION (CGV / informations légales) — §8.
// ====================================================================
test("§8/§17.3 — CGV : une réponse RETARDATAIRE de A n'écrase jamais les informations légales de B (même instance montée)", async () => {
  resetScenario("/dashboard/legal-cgv", `?r=${A_ID}`);
  const { container, root } = mount(P.Cgv);
  try {
    await waitForPending("getMerchantLegalProfile", A_ID, "CGV/A");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getMerchantLegalProfile", B_ID, "CGV/B");
    assert.ok(
      deferred().some((d) => d.fn === "getMerchantLegalProfile" && d.id === A_ID),
      "la requête légale de A doit être ENCORE EN VOL quand celle de B part"
    );

    await resolvePending("getMerchantCgvProfile", B_ID, null, "CGV/B profil");
    await resolvePending("getMerchantLegalProfile", B_ID, LEGAL_B, "CGV/B");
    assert.ok(
      textOf(window.document.body).includes("") && inputValues(container).includes(LEGAL_B.legal_entity_name),
      `les informations légales de B doivent être affichées (obtenu : ${JSON.stringify(inputValues(container))})`
    );

    await resolvePending("getMerchantCgvProfile", A_ID, null, "CGV/A profil tardif");
    await resolvePending("getMerchantLegalProfile", A_ID, LEGAL_A, "CGV/A tardif");

    const values = inputValues(container);
    assert.ok(
      !values.includes(LEGAL_A.legal_entity_name),
      "BLOCKER : les informations légales de A ne doivent JAMAIS apparaître sous l'entête de B"
    );
    assert.ok(values.includes(LEGAL_B.legal_entity_name), "les informations légales de B doivent rester affichées");
    assert.equal(headerName(container), B_NAME, "l'entête doit nommer B");
  } finally {
    root.unmount();
    container.remove();
  }
});

function inputValues(c: Element): string[] {
  return [...c.querySelectorAll("input, textarea")].map((el) => (el as HTMLInputElement).value);
}

// ====================================================================
// 4. A -> B -> A avec un ORDRE DE RÉSOLUTION DÉLIBÉRÉMENT INVERSÉ.
//    Le retour à A ne doit pas non plus pouvoir être pollué par la
//    réponse de B restée en vol.
// ====================================================================
test("§12/§17.4 — Commandes : A -> B -> A, résolutions dans un ordre délibérément inversé, seul A final survit", async () => {
  resetScenario("/dashboard", `?r=${A_ID}`);
  const { container, root } = mount(P.Orders);
  try {
    await waitForPending("getDashboardOrders", A_ID, "A initial");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getDashboardOrders", B_ID, "B");

    // Les requêtes de A émises AVANT la bascule vers B sont, par
    // définition, périmées : on les identifie par IDENTITÉ d'objet, pas
    // par comptage (une page peut légitimement émettre plusieurs
    // requêtes concurrentes pour un même établissement).
    const staleA = pendingFor("getDashboardOrders", A_ID);
    assert.ok(staleA.length > 0, "au moins une requête de A doit être restée en vol pendant la visite de B");
    const staleB = pendingFor("getDashboardOrders", B_ID);
    assert.ok(staleB.length > 0, "au moins une requête de B doit être en vol");

    switchRestaurant(container, A_ID);
    await settle();
    // Le retour sur A émet de NOUVELLES requêtes, distinctes des
    // précédentes.
    let currentA: Deferred[] = [];
    for (let i = 0; i < 200; i += 1) {
      currentA = pendingFor("getDashboardOrders", A_ID).filter((d) => !staleA.includes(d));
      if (currentA.length > 0) break;
      await tick(5);
    }
    assert.ok(currentA.length > 0, "le retour sur A doit émettre une NOUVELLE requête, distincte de la périmée");

    // Ordre choisi par le test, délibérément à contre-courant :
    // les requêtes PÉRIMÉES de A d'abord, puis celles de B (périmées
    // elles aussi), et seulement ENSUITE la requête courante de A.
    const ORDER_A_OLD = orderFor(A_ID, 101, "order-a-old");
    const ORDER_A_NOW = orderFor(A_ID, 202, "order-a-now");

    for (const d of staleA) resolveOne(d, [ORDER_A_OLD]);
    await settle();
    for (const d of staleB) resolveOne(d, [ORDER_B]);
    await settle();
    for (const d of currentA) resolveOne(d, [ORDER_A_NOW]);
    await settle();

    const body = textOf(container);
    assert.ok(body.includes("202"), "la réponse COURANTE de A doit être affichée");
    assert.ok(!body.includes("777"), "aucune commande de B ne doit subsister après le retour sur A");
    assert.ok(
      !body.includes("101"),
      "la PREMIÈRE requête de A, périmée par la bascule, ne doit pas être appliquée non plus"
    );
    assert.equal(headerName(container), A_NAME, "l'entête doit nommer A");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 5. §5 — INVALIDATION IMMÉDIATE : au changement de contexte, les
//    données de A disparaissent AVANT toute réponse pour B. Aucune
//    donnée de A ne doit rester lisible sous l'entête de B.
// ====================================================================
test("§5/§17.5 — Commandes : au changement A -> B, les données de A sont purgées IMMÉDIATEMENT, avant toute réponse de B", async () => {
  resetScenario("/dashboard", `?r=${A_ID}`);
  const { container, root } = mount(P.Orders);
  try {
    await resolvePending("getDashboardOrders", A_ID, [ORDER_A], "A");
    assert.ok(textOf(container).includes("111"), "les commandes de A sont d'abord affichées");

    switchRestaurant(container, B_ID);
    await settle();

    // Rien n'a été résolu pour B : l'écran est en cours de chargement.
    assert.ok(
      deferred().some((d) => d.fn === "getDashboardOrders" && d.id === B_ID),
      "la requête de B doit être en vol (non résolue) à ce point du test"
    );
    assert.equal(headerName(container), B_NAME, "l'entête affiche déjà B");
    assert.ok(
      !textOf(container).includes("111"),
      "§5 : les données de A ne doivent PAS rester affichées sous l'entête de B pendant le chargement"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§5/§17.5 — Catalogue : au changement A -> B, le catalogue de A est purgé IMMÉDIATEMENT, avant toute réponse de B", async () => {
  resetScenario("/dashboard/catalogue", `?r=${A_ID}`);
  const { container, root } = mount(P.Catalogue);
  try {
    await resolvePending("getMerchantCatalogue", A_ID, [CAT_A], "Catalogue/A");
    assert.ok(textOf(container).includes(CAT_A.category_name), "le catalogue de A est d'abord affiché");

    switchRestaurant(container, B_ID);
    await settle();

    assert.ok(
      deferred().some((d) => d.fn === "getMerchantCatalogue" && d.id === B_ID),
      "la requête catalogue de B doit être en vol (non résolue)"
    );
    assert.equal(headerName(container), B_NAME, "l'entête affiche déjà B");
    assert.ok(
      !textOf(container).includes(CAT_A.category_name),
      "§5 : le catalogue de A ne doit PAS rester affiché sous l'entête de B pendant le chargement"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 6. §5 — PROVENANCE EXPLICITE : rien de dérivé du locataire ne
//    s'affiche tant que `loadedRestaurantId !== currentRestaurantId`.
//    Vérifié sur l'observable le plus strict du produit : la porte
//    d'impression (`data-print-allowed`), qui exige explicitement
//    l'égalité des provenances.
// ====================================================================
test("§5/§17.6 — une provenance périmée ne peut RIEN rendre d'actionnable : l'impression reste fermée tant que provenance != contexte", async () => {
  resetScenario("/dashboard", `?r=${A_ID}`);
  const { container, root } = mount(P.Orders);
  try {
    await resolvePending("getDashboardOrders", A_ID, [ORDER_A], "A commandes");
    await resolvePending("getReceiptSettings", A_ID, { paper_width_mm: 58, business_name: A_NAME }, "A réglages");
    await settle();
    const allowedOnA = [...container.querySelectorAll("[data-print-allowed]")].map((e) =>
      e.getAttribute("data-print-allowed")
    );
    assert.ok(allowedOnA.includes("true"), "sur A, cohérent, l'impression doit être ouverte");

    switchRestaurant(container, B_ID);
    await settle();
    // Les COMMANDES de B arrivent, mais PAS encore ses réglages : les
    // deux provenances ne coïncident donc pas.
    await resolvePending("getDashboardOrders", B_ID, [ORDER_B], "B commandes");

    const allowed = [...container.querySelectorAll("[data-print-allowed]")].map((e) =>
      e.getAttribute("data-print-allowed")
    );
    assert.ok(
      allowed.length > 0 && allowed.every((v) => v === "false"),
      `tant que les réglages de B ne sont pas chargés, rien ne doit être imprimable (obtenu : ${JSON.stringify(allowed)})`
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 7. §6 — MUTATION : une commande ne peut être mutée que si sa
//    provenance correspond au contexte courant. On prouve qu'après
//    bascule, aucune commande de A n'est encore actionnable.
// ====================================================================
test("§6/§17.7 — aucune mutation ne peut viser une entité de A après bascule vers B (provenance vérifiée)", async () => {
  resetScenario("/dashboard", `?r=${A_ID}`);
  const { container, root } = mount(P.Orders);
  try {
    await resolvePending("getDashboardOrders", A_ID, [ORDER_A], "A");
    assert.ok(textOf(container).includes("111"), "la commande de A est affichée");

    switchRestaurant(container, B_ID);
    await settle();

    /** Clique TOUS les boutons présents et retourne les mutations
     *  produites qui visent l'entité de A. */
    async function clickEverythingAndCollectMutationsOnA(): Promise<string[]> {
      for (const b of [...container.querySelectorAll("button")]) {
        (b as HTMLButtonElement).click();
      }
      await settle();
      return mutationLog().filter((e) => e.includes(ORDER_A.id));
    }

    // (a) PENDANT le chargement de B : les commandes de A ne doivent
    //     plus être ni visibles ni actionnables.
    assert.ok(
      !textOf(container).includes("111"),
      "§5 : la commande de A ne doit plus être visible sous l'entête de B"
    );
    assert.deepEqual(
      await clickEverythingAndCollectMutationsOnA(),
      [],
      `aucune mutation ne doit viser une entité de A pendant le chargement de B (obtenu : ${JSON.stringify(mutationLog())})`
    );

    // (b) APRÈS résolution de B : même exigence.
    await resolvePending("getDashboardOrders", B_ID, [ORDER_B], "B");
    assert.ok(textOf(container).includes("777"), "les commandes de B sont affichées");
    assert.ok(!textOf(container).includes("111"), "aucune commande de A ne doit rester à l'écran");
    assert.deepEqual(
      await clickEverythingAndCollectMutationsOnA(),
      [],
      `aucune mutation ne doit viser une entité de A après bascule (obtenu : ${JSON.stringify(mutationLog())})`
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 8. §9 — ABONNEMENTS : l'abonnement de A est fermé à la bascule, et
//    un évènement PÉRIMÉ rejoué depuis A ne doit rien repeupler.
// ====================================================================
test("§9/§17.8 — l'abonnement de A est fermé à la bascule, et un évènement périmé de A ne repeuple rien sous B", async () => {
  resetScenario("/dashboard", `?r=${A_ID}`);
  const { container, root } = mount(P.Orders);
  try {
    await resolvePending("getDashboardOrders", A_ID, [ORDER_A], "A");
    assert.ok(subLog().includes(`subscribe:${A_ID}`), "un abonnement doit exister pour A");
    const callbacksA = ((globalThis as any).__subCallbacks[A_ID] ?? []).slice() as (() => void)[];
    assert.ok(callbacksA.length > 0, "le rappel d'abonnement de A doit être capturé");

    switchRestaurant(container, B_ID);
    await settle();

    assert.ok(subLog().includes(`unsubscribe:${A_ID}`), "§9 : l'abonnement de A doit être FERMÉ à la bascule");
    assert.ok(subLog().includes(`subscribe:${B_ID}`), "§9 : un abonnement doit être ouvert pour B");

    await resolvePending("getDashboardOrders", B_ID, [ORDER_B], "B");
    assert.ok(textOf(container).includes("777"), "les commandes de B sont affichées");

    // Évènement PÉRIMÉ : on rejoue de force le rappel de l'abonnement
    // de A, comme le ferait un message temps réel arrivé en retard.
    const before = fetchLog().length;
    for (const cb of callbacksA) cb();
    await settle();

    // Soit aucune requête n'est repartie (le rappel périmé est inerte),
    // soit une requête est repartie mais pour B : dans tous les cas,
    // aucune donnée de A ne peut réapparaître.
    const newCalls = fetchLog().slice(before).filter((e) => e.startsWith("getDashboardOrders:"));
    const forA = newCalls.filter((e) => e.endsWith(":" + A_ID));
    // Si une requête pour A est malgré tout repartie, on la résout pour
    // prouver qu'elle reste sans effet.
    for (const _ of forA) {
      await resolvePending("getDashboardOrders", A_ID, [ORDER_A], "évènement périmé de A");
    }
    await settle();

    const body = textOf(container);
    assert.ok(
      !body.includes("111"),
      "§9 : un évènement d'abonnement PÉRIMÉ ne doit jamais faire réapparaître les données de A sous B"
    );
    assert.ok(body.includes("777"), "les commandes de B doivent rester affichées");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 9-12. §8 — LES AUTRES MODULES DE CONFIGURATION, même exigence.
//    Le mandat impose de durcir Réglages, Légal/CGV, Tarifs de
//    livraison et Traductions, et de NE PAS AFFAIBLIR Paiement (qui
//    disposait déjà d'une protection génération/provenance). Les quatre
//    sont donc couverts ici par le MÊME scénario adverse, dans la même
//    instance montée.
// ====================================================================

test("§8 — Réglages : une réponse RETARDATAIRE de A n'écrase jamais les réglages de B (même instance montée)", async () => {
  resetScenario("/dashboard/settings", `?r=${A_ID}`);
  const { container, root } = mount(P.Settings);
  try {
    await waitForPending("getRestaurantSettings", A_ID, "Réglages/A");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getRestaurantSettings", B_ID, "Réglages/B");
    assert.ok(
      pendingFor("getRestaurantSettings", A_ID).length > 0,
      "la requête réglages de A doit être ENCORE EN VOL quand celle de B part"
    );

    await resolvePending(
      "getRestaurantSettings",
      B_ID,
      { staff_receipt_language: "fr", source_language: "fr", address: "ADRESSE-DE-B", display_name: "NOM-AFFICHE-B" },
      "Réglages/B"
    );
    assert.ok(
      inputValues(container).includes("ADRESSE-DE-B"),
      `les réglages de B doivent être affichés (obtenu : ${JSON.stringify(inputValues(container))})`
    );

    await resolvePending(
      "getRestaurantSettings",
      A_ID,
      { staff_receipt_language: "fr", source_language: "fr", address: "ADRESSE-DE-A", display_name: "NOM-AFFICHE-A" },
      "Réglages/A tardif"
    );

    const values = inputValues(container);
    assert.ok(
      !values.includes("ADRESSE-DE-A"),
      "BLOCKER : les réglages de A ne doivent JAMAIS apparaître sous l'entête de B"
    );
    assert.ok(values.includes("ADRESSE-DE-B"), "les réglages de B doivent rester affichés");
    assert.equal(headerName(container), B_NAME, "l'entête doit nommer B");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§8 — Tarifs de livraison : une réponse RETARDATAIRE de A n'écrase jamais les tarifs de B (même instance montée)", async () => {
  const ruleFor = (label: string) => [
    { ruleId: "rule-" + label, fulfillmentLabel: label, pricingMode: "fixed", fixedFee: 3, freeThreshold: null, customerText: null },
  ];
  resetScenario("/dashboard/delivery-pricing", `?r=${A_ID}`);
  const { container, root } = mount(P.Delivery);
  try {
    await waitForPending("getMerchantDeliveryFulfillmentPricing", A_ID, "Livraison/A");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getMerchantDeliveryFulfillmentPricing", B_ID, "Livraison/B");
    assert.ok(
      pendingFor("getMerchantDeliveryFulfillmentPricing", A_ID).length > 0,
      "la requête tarifs de A doit être ENCORE EN VOL quand celle de B part"
    );

    await resolvePending("getMerchantDeliveryFulfillmentPricing", B_ID, ruleFor("TARIF-DE-B"), "Livraison/B");
    assert.ok(textOf(container).includes("TARIF-DE-B"), "les tarifs de B doivent être affichés");

    await resolvePending("getMerchantDeliveryFulfillmentPricing", A_ID, ruleFor("TARIF-DE-A"), "Livraison/A tardif");

    const body = textOf(container);
    assert.ok(!body.includes("TARIF-DE-A"), "BLOCKER : un tarif de A ne doit JAMAIS apparaître sous l'entête de B");
    assert.ok(body.includes("TARIF-DE-B"), "les tarifs de B doivent rester affichés");
    assert.equal(headerName(container), B_NAME, "l'entête doit nommer B");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§8 — Traductions : une réponse RETARDATAIRE de A n'écrase jamais le contenu de B (même instance montée)", async () => {
  resetScenario("/dashboard/translations", "");
  const { container, root } = mount(P.Translations);
  try {
    await waitForPending("getMerchantCatalogue", A_ID, "Traductions/A");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getMerchantCatalogue", B_ID, "Traductions/B");
    assert.ok(
      pendingFor("getMerchantCatalogue", A_ID).length > 0,
      "la requête catalogue de A doit être ENCORE EN VOL quand celle de B part"
    );

    await resolvePending("getMerchantCatalogue", B_ID, [CAT_B], "Traductions/B");
    // Le contenu de B doit être là AVANT de juger la réponse tardive --
    // sans quoi l'assertion suivante serait vide de sens.
    assert.ok(
      textOf(container).includes(`PRODUIT-${CAT_B.category_name}`),
      `le contenu de B doit être affiché (obtenu : ${textOf(container).slice(0, 400)})`
    );

    await resolvePending("getMerchantCatalogue", A_ID, [CAT_A], "Traductions/A tardif");

    const body = textOf(container);
    assert.ok(
      !body.includes(`PRODUIT-${CAT_A.category_name}`),
      "BLOCKER : un contenu de A ne doit JAMAIS apparaître sous le contexte B"
    );
    assert.ok(body.includes(`PRODUIT-${CAT_B.category_name}`), "le contenu de B doit rester affiché");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§8 — Paiement : la protection préexistante n'est PAS affaiblie (réponse retardataire de A toujours ignorée)", async () => {
  const cfgFor = (label: string) => [
    {
      providerCode: label,
      mode: "test",
      configurationStatus: "configured",
      isEnabled: true,
      lastVerifiedAt: null,
      updatedAt: null,
    },
  ];
  resetScenario("/dashboard/payment", `?r=${A_ID}`);
  const { container, root } = mount(P.Payment);
  try {
    await waitForPending("getMerchantPaymentProviderConfig", A_ID, "Paiement/A");

    switchRestaurant(container, B_ID);
    await settle();
    await waitForPending("getMerchantPaymentProviderConfig", B_ID, "Paiement/B");
    assert.ok(
      pendingFor("getMerchantPaymentProviderConfig", A_ID).length > 0,
      "la requête paiement de A doit être ENCORE EN VOL quand celle de B part"
    );

    await resolvePending("getMerchantPaymentProviderConfig", B_ID, cfgFor("CONFIG-DE-B"), "Paiement/B");
    await resolvePending("getMerchantPaymentProviderConfig", A_ID, cfgFor("CONFIG-DE-A"), "Paiement/A tardif");

    const body = textOf(container);
    assert.ok(
      !body.includes("CONFIG-DE-A"),
      "la configuration de paiement de A ne doit JAMAIS apparaître sous l'entête de B"
    );
    assert.equal(headerName(container), B_NAME, "l'entête doit nommer B");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// 14. §11 / §17.13 — L'URL N'ACCORDE AUCUNE AUTORITÉ OPÉRATEUR.
//     Même URL, même établissement forgé : le SEUL paramètre qui change
//     est le résultat d'isScanymOperator(). C'est la preuve directe que
//     l'autorité vient du mécanisme d'autorisation existant, jamais de
//     `?r=`.
// ====================================================================
test("§11/§17.13 — un `?r=` forgé ne confère aucune autorité : refusé sans statut opérateur, accepté avec", async () => {
  const FORGED = "r-etablissement-qui-nest-pas-le-mien";

  // (a) compte NON opérateur -> fail closed, AUCUNE lecture émise.
  resetScenario("/dashboard/catalogue", `?r=${FORGED}`);
  (globalThis as any).__navIsOperator = false;
  const denied = mount(P.Catalogue);
  try {
    await settle(20);
    assert.ok(
      denied.container.querySelector("[data-context-unavailable]") !== null,
      "sans statut opérateur, un `?r=` non rattaché doit produire l'état indisponible explicite"
    );
    assert.deepEqual(
      fetchLog(),
      [],
      `aucune donnée ne doit être demandée en contexte refusé (obtenu : ${JSON.stringify(fetchLog())})`
    );
    assert.ok(
      !textOf(denied.container).includes(A_NAME) && !textOf(denied.container).includes(B_NAME),
      "aucun autre établissement ne doit être ouvert à la place"
    );
  } finally {
    denied.root.unmount();
    denied.container.remove();
  }

  // (b) MÊME URL, compte opérateur -> contexte conservé. La différence
  //     ne vient QUE du mécanisme d'autorisation, pas de l'URL.
  resetScenario("/dashboard/catalogue", `?r=${FORGED}`);
  (globalThis as any).__navIsOperator = true;
  const allowed = mount(P.Catalogue);
  try {
    await waitForPending("getMerchantCatalogue", FORGED, "opérateur");
    assert.ok(
      allowed.container.querySelector("[data-context-unavailable]") === null,
      "en contexte opérateur, l'établissement demandé doit être conservé"
    );
    const others = fetchLog().filter((e) => !e.endsWith(":" + FORGED));
    assert.deepEqual(
      others,
      [],
      `aucune donnée ne doit être chargée pour un autre établissement (obtenu : ${JSON.stringify(fetchLog())})`
    );
  } finally {
    allowed.root.unmount();
    allowed.container.remove();
  }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await tick(50);
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
