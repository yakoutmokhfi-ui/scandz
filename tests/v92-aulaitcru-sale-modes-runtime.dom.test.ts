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
// AU LAIT CRU — CASE 1A -- SALE MODES HARDENING + CLICK & COLLECT ONLY
//
// Preuve comportementale RÉELLE (rendu React dans un vrai DOM, appels
// supabase.rpc réellement interceptés, interactions utilisateur
// réelles) que la bascule runtime (usePublicSaleModes,
// lib/use-public-sale-modes.ts) résout bien le problème identifié par
// l'audit Phase 1 : un établissement SANS entrée dans
// lib/restaurants-config.ts (comme "au-lait-cru") n'affiche plus
// JAMAIS uniquement "table" (DEFAULT_SETTINGS legacy), mais la liste
// RÉELLE renvoyée par get_restaurant_public_sale_modes.
//
// SCOPE RÉVISÉ (CASE 1A, décision CIO) : la cible Au Lait Cru pour ce
// lot est CLICK & COLLECT ONLY -- "pickup" présent, "table" absent,
// "delivery" absent. La livraison locale et réfrigérée seront
// traitées dans un lot ultérieur distinct (la version précédente de ce
// fichier testait aussi "Livraison locale" pour Au Lait Cru -- retiré
// ici, ce test générique de livraison reste couvert par ailleurs, voir
// tests/v91-lot2b4a2-dynamic-form.dom.test.ts, fixture sanaa-cookies).
//
// Fixture volontairement choisie : slug "au-lait-cru", qui n'existe
// PAS dans lib/restaurants-config.ts SETTINGS (vérifié ci-dessous par
// un test direct sur getSettings()) -- donc getSettings("au-lait-cru")
// retombe sur DEFAULT_SETTINGS = { allowedServiceModes: ["table"] }.
// Si le composant montré ci-dessous affichait encore "Sur place, à
// table" et masquait Click & Collect, ce serait la preuve que la
// bascule runtime n'est pas réellement active. C'est l'inverse qui est
// démontré ici.
//
// Patron esbuild/jsdom/supabase déjà établi dans ce projet -- voir
// tests/v91-lot2b4a2-dynamic-form.dom.test.ts (montage réel de
// MenuView, RPC interceptées).
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
const { flushSync } = await import("react-dom");
const { supabase } = await import("../lib/supabase.ts");
const { getSettings } = await import("../lib/restaurants-config.ts");

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v92-"));
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

/** Fixture "au-lait-cru" : AUCUNE entrée statique dans
 *  lib/restaurants-config.ts (vérifié par le test dédié plus bas) --
 *  exactement la situation réelle de l'établissement Au Lait Cru
 *  décrite par l'audit Phase 1 (section 4 du rapport). */
function auLaitCruRestaurant() {
  return {
    id: "r-aulaitcru-test",
    name: "Au Lait Cru (test)",
    slug: "au-lait-cru",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r-aulaitcru-test",
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
        restaurant_id: "r-aulaitcru-test",
        name: "Pâtisseries",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: "item-1",
            category_id: "cat-1",
            name: "Croissant",
            description: null,
            short_description: null,
            price: 2.2,
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

/** Fixture d'un AUTRE établissement (tenant A), pickup+delivery+table
 *  tous activés -- utilisée UNIQUEMENT par le test de bascule tenant
 *  ci-dessous, pour prouver l'absence de stale state entre deux
 *  établissements réellement différents (ALC-SM-01, volet intégré
 *  MenuView -- section 3 de la mission, "RESET DU SERVICE MODE"). */
function otherTenantRestaurant() {
  return {
    id: "r-other-tenant-test",
    name: "Autre établissement (test)",
    slug: "other-tenant-test",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r-other-tenant-test",
      max_tables: 10,
      currency: "EUR",
      whatsapp_number: "+33600000001",
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
        id: "cat-2",
        restaurant_id: "r-other-tenant-test",
        name: "Plats",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: "item-2",
            category_id: "cat-2",
            name: "Plat du jour",
            description: null,
            short_description: null,
            price: 12,
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

/** Modes de vente publics mockés pour Au Lait Cru : SEULEMENT pickup
 *  ("Click & Collect" / "Retrait en boutique") -- JAMAIS "table",
 *  JAMAIS "delivery", conformément au scope CASE 1A ("CLICK & COLLECT
 *  ONLY", section 6-8 de la mission). */
const AU_LAIT_CRU_SALE_MODE_ROWS = [
  {
    mode_code: "pickup",
    customer_text: null,
    pricing_mode: "free" as const,
    fixed_fee: null,
    free_threshold: null,
    delay_value: null,
    delay_unit: null,
  },
];

/** Modes de vente publics mockés pour "l'autre établissement" (tenant
 *  A du test de bascule) : table + pickup + delivery, tous activés --
 *  délibérément DIFFÉRENT d'Au Lait Cru, pour que toute fuite d'état
 *  entre les deux soit immédiatement détectable. */
const OTHER_TENANT_SALE_MODE_ROWS = [
  { mode_code: "table", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];

/** Exigences pickup ("Click & Collect") -- exactement les valeurs par
 *  défaut du catalogue backend (supabase/migration-v82-lot2a-sale-modes.sql) :
 *  customer_name required, phone/email one_of. */
const PICKUP_ONE_OF = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "one_of", one_of_group: "contact" },
  { field: "email", requirement: "one_of", one_of_group: "contact" },
];

/** Trace tous les noms de RPC réellement appelés pendant un scénario,
 *  pour prouver positivement (section "aucun appel provider") que
 *  seules les RPC génériques connues sont invoquées -- jamais une RPC
 *  ou un appel réseau lié à un provider (Stuart/Chronofresh), et
 *  jamais un appel lié à un mode 'delivery' pour Au Lait Cru dans ce
 *  lot (CLICK & COLLECT ONLY). */
function mockRpc(
  t: { mock: { method: Function } },
  saleModeRows: unknown[],
  reqsByMode: Record<string, unknown[]>
): { calledRpcNames: string[] } {
  const calledRpcNames: string[] = [];
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calledRpcNames.push(name);
    if (name === "get_restaurant_public_sale_modes") {
      return { data: saleModeRows, error: null };
    }
    if (name === "get_restaurant_public_field_requirements") {
      const data = reqsByMode[args.p_mode_code];
      if (data === undefined) {
        throw new Error(`mode inattendu dans le test : ${args.p_mode_code}`);
      }
      return { data, error: null };
    }
    if (name === "get_restaurant_public_delivery_info") {
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return { calledRpcNames };
}

/** Variante MULTI-TENANT de mockRpc(), routée sur `p_restaurant_id` --
 *  indispensable pour le test de bascule tenant ci-dessous : contrairement
 *  à mockRpc() (une seule réponse fixe, quel que soit le restaurant
 *  demandé -- impropre à prouver une isolation entre deux tenants
 *  distincts), cette variante retourne les modes/exigences RÉELLEMENT
 *  associés à chaque `restaurantId`, exactement comme le ferait la RPC
 *  Supabase réelle (filtrée par restaurant_id en base). */
function mockRpcByRestaurant(
  t: { mock: { method: Function } },
  byRestaurant: Record<string, { saleModeRows: unknown[]; reqsByMode: Record<string, unknown[]> }>
): void {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    const tenant = byRestaurant[args.p_restaurant_id];
    if (tenant === undefined) {
      throw new Error(`restaurant inattendu dans ce test : ${args.p_restaurant_id}`);
    }
    if (name === "get_restaurant_public_sale_modes") {
      return { data: tenant.saleModeRows, error: null };
    }
    if (name === "get_restaurant_public_field_requirements") {
      const data = tenant.reqsByMode[args.p_mode_code];
      if (data === undefined) {
        throw new Error(`mode inattendu dans le test : ${args.p_mode_code} (restaurant ${args.p_restaurant_id})`);
      }
      return { data, error: null };
    }
    if (name === "get_restaurant_public_delivery_info") {
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

async function renderAndAddOneItemToCart(restaurant: ReturnType<typeof auLaitCruRestaurant>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();

  const addBtn = buttonWithText(container, "Ajouter");
  assert.ok(addBtn, "le bouton Ajouter doit être présent");
  click(addBtn!);
  await flush();

  const cartBar = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("🛒")
  );
  assert.ok(cartBar, "la barre panier doit apparaître dès qu'un article est ajouté");
  click(cartBar!);
  await flush();

  return { container, root };
}

function selectServiceMode(container: Element, label: string) {
  const btn = buttonWithText(container, label);
  assert.ok(btn, `le bouton de mode "${label}" doit être présent`);
  click(btn!);
}

// --------------------------------------------------------------------
// 0. Preuve directe de la cause racine identifiée par l'audit Phase 1 :
//    "au-lait-cru" n'a AUCUNE entrée statique dans
//    lib/restaurants-config.ts -- retombe sur DEFAULT_SETTINGS =
//    { allowedServiceModes: ["table"] }.
// --------------------------------------------------------------------

test("AU LAIT CRU : getSettings('au-lait-cru') retombe sur DEFAULT_SETTINGS legacy (allowedServiceModes = ['table']) -- confirme la cause racine identifiée par l'audit Phase 1, avant activation runtime", () => {
  const settings = getSettings("au-lait-cru");
  assert.deepEqual(
    settings.allowedServiceModes,
    ["table"],
    "aucune entrée statique 'au-lait-cru' dans lib/restaurants-config.ts : le chemin legacy ne proposerait QUE 'table', jamais Click & Collect"
  );
});

// --------------------------------------------------------------------
// 1. CLICK & COLLECT ONLY : pickup présent, table ABSENT, delivery
//    ABSENT -- cible métier CASE 1A.
// --------------------------------------------------------------------

test("AU LAIT CRU (CLICK & COLLECT ONLY) : pickup présent (présélectionné automatiquement, un seul mode) -- jamais 'Sur place, à table', jamais un sélecteur de mode proposant 'Livraison' -- bascule runtime réelle, pas settings.allowedServiceModes", async (t) => {
  mockRpc(t, AU_LAIT_CRU_SALE_MODE_ROWS, { pickup: PICKUP_ONE_OF });
  const { container, root } = await renderAndAddOneItemToCart(auLaitCruRestaurant());

  try {
    // Un seul mode disponible ('pickup') -> présélectionné
    // automatiquement par MenuView (voir l'effet dédié) -- le bloc
    // sélecteur de mode ("Comment souhaitez-vous récupérer votre
    // commande ?", boutons par mode) n'est alors PAS rendu du tout
    // (CartPanel ne le montre que si plus d'un mode est disponible) :
    // la preuve que 'pickup' est bien le seul mode retenu passe donc
    // par le rendu direct du formulaire Click & Collect (customer_name),
    // pas par un bouton "À emporter" qui n'existerait dans ce cas.
    await waitFor(
      () => inputById(container, "customer_name") !== null,
      "le formulaire Click & Collect (customer_name) doit apparaître, présélection automatique du seul mode disponible"
    );

    assert.equal(
      buttonWithText(container, "Sur place, à table"),
      undefined,
      "ALC : le mode table ne doit JAMAIS apparaître pour Au Lait Cru (CLICK & COLLECT ONLY)"
    );
    assert.equal(
      buttonWithText(container, "Livraison"),
      undefined,
      "ALC : le mode delivery ne doit JAMAIS apparaître pour Au Lait Cru dans ce lot (CLICK & COLLECT ONLY -- la livraison est explicitement hors scope, section 8 de la mission)"
    );
    assert.equal(
      container.querySelector('[aria-label="Choisir une table"]'),
      null,
      "aucun sélecteur de numéro de table ne doit être rendu pour Au Lait Cru"
    );
    assert.equal(
      inputById(container, "street"),
      null,
      "aucun champ d'adresse de livraison ne doit être rendu pour Au Lait Cru dans ce lot (CLICK & COLLECT ONLY)"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 2. Click & Collect ("Retrait en boutique") : name required,
//    phone/email one_of -- table absente de ce parcours.
// --------------------------------------------------------------------

test("AU LAIT CRU (Click & Collect) : name requis, phone seul valide, email seul valide, ni l'un ni l'autre invalide, phone+email valides -- table/delivery absents de ce parcours", async (t) => {
  mockRpc(t, AU_LAIT_CRU_SALE_MODE_ROWS, { pickup: PICKUP_ONE_OF });
  const { container, root } = await renderAndAddOneItemToCart(auLaitCruRestaurant());

  try {
    // Un seul mode disponible -> présélectionné automatiquement,
    // aucun clic de sélection nécessaire.
    await waitFor(() => inputById(container, "customer_name") !== null, "champs Click & Collect rendus (présélection automatique, mode unique)");

    assert.equal(inputById(container, "street"), null, "aucune adresse de livraison pour Click & Collect");
    assert.equal(container.querySelector('[aria-label="Choisir une table"]'), null);

    // Ni l'un ni l'autre -- invalide (groupe one_of non satisfait).
    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    await flush();
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined, "name seul, sans phone ni email, ne doit jamais suffire");

    // Phone seul -- valide.
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush();
    assert.ok(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), "name + phone seul doit satisfaire le groupe one_of");

    // Email seul (phone vidé) -- également valide.
    setNativeValue(inputById(container, "phone")!, "");
    setNativeValue(inputById(container, "email")!, "yakout@example.fr");
    await flush();
    assert.ok(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), "name + email seul doit également satisfaire le groupe one_of");

    // Les deux valides (name + phone + email) -- toujours valide.
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush();
    assert.ok(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), "name + phone + email valides doit rester permis");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 3. Bascule tenant intégrée (MenuView complet) : autre établissement
//    -> Au Lait Cru, et l'inverse -- sans stale state. Complète (au
//    niveau composant, pas seulement le hook isolé -- voir
//    tests/v93-alc-sm-01-sale-modes-stale-state.dom.test.ts pour la
//    preuve au niveau du hook) la preuve ALC-SM-01, ainsi que le
//    "RESET DU SERVICE MODE" générique de MenuView.tsx (section 3 de
//    la mission).
// --------------------------------------------------------------------

test("AU LAIT CRU (bascule tenant, MenuView complet) : autre établissement (table+pickup+delivery) -> Au Lait Cru (pickup only), aucun mode de l'autre établissement ne fuite, réinitialisation correcte", async (t) => {
  // mockRpcByRestaurant (pas mockRpc) : la RPC DOIT retourner une
  // réponse DIFFÉRENTE selon le restaurantId demandé, exactement comme
  // en production -- sinon ce test ne prouverait rien : une réponse
  // fixe identique avant/après la bascule masquerait silencieusement
  // toute fuite entre tenants au lieu de la révéler.
  mockRpcByRestaurant(t, {
    "r-other-tenant-test": { saleModeRows: OTHER_TENANT_SALE_MODE_ROWS, reqsByMode: { pickup: PICKUP_ONE_OF, delivery: [], table: [] } },
    "r-aulaitcru-test": { saleModeRows: AU_LAIT_CRU_SALE_MODE_ROWS, reqsByMode: { pickup: PICKUP_ONE_OF } },
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  try {
    // 1. Monte avec l'autre établissement (3 modes) et sélectionne
    // "Livraison" (mode qui n'existe PAS pour Au Lait Cru).
    flushSync(() => {
      root.render(React.createElement(MenuView, { restaurant: otherTenantRestaurant() }));
    });
    await flush();
    click(buttonWithText(container, "Ajouter")!);
    await flush();
    click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"))!);
    await flush();
    await waitFor(() => buttonWithText(container, "Livraison") !== undefined, "mode Livraison proposé pour l'autre établissement");
    selectServiceMode(container, "Livraison");
    await flush();
    assert.ok(container.textContent, "l'autre établissement doit être correctement rendu avant bascule");

    // 2. Bascule IMMÉDIATE vers Au Lait Cru (pickup only) -- même
    // racine que la fixture, nouveau restaurantId.
    flushSync(() => {
      root.render(React.createElement(MenuView, { restaurant: auLaitCruRestaurant() }));
    });
    await flush();

    // 3. Après résolution, l'EN-TÊTE (RestaurantHeader, lu directement
    // depuis la prop `restaurant` à chaque rendu -- jamais mis en cache
    // dans un state) doit être celui d'Au Lait Cru. (Ne vérifie PAS
    // l'affichage de "Croissant" : l'onglet de catégorie ACTIF
    // [activeCategoryId] est un state propre à MenuView qui, comme
    // `cart` [voir note plus bas], n'est pas non plus réinitialisé par
    // un changement de prop `restaurant` sans démontage -- observation
    // de la MÊME famille, également hors scope CASE 1A, également
    // documentée dans RAPPORT.md. Seul l'état sale-mode/fulfillment,
    // seul périmètre corrigé ici, est vérifié par ce test.)
    await waitFor(
      () => container.textContent?.includes("Au Lait Cru (test)") === true,
      "l'en-tête Au Lait Cru doit être affiché après bascule (RestaurantHeader, dérivé directement de la prop restaurant)"
    );

    // 4. Portée EXACTE de ce que corrige CASE 1A (ALC-SM-01 + section 3,
    // "RESET DU SERVICE MODE") : l'état SALE MODE / FULFILLMENT ne doit
    // JAMAIS laisser fuiter le mode "delivery" (sélectionné sur l'autre
    // établissement juste avant la bascule) ni son formulaire vers Au
    // Lait Cru, qui ne propose QUE "pickup" -- serviceMode doit avoir
    // été réinitialisé par l'effet dédié de MenuView (section 3) dès
    // que "delivery" n'appartient plus à availableServiceModes, et
    // ré-présélectionné automatiquement sur l'unique mode restant
    // ("pickup"), faisant réapparaître le formulaire Click & Collect.
    assert.equal(
      buttonWithText(container, "Livraison"),
      undefined,
      "ALC-SM-01/section 3 : le mode 'delivery' de l'autre établissement ne doit jamais rester sélectionnable pour Au Lait Cru après bascule"
    );
    assert.equal(
      container.querySelector('[aria-label="Choisir une table"]'),
      null,
      "ALC-SM-01/section 3 : aucun sélecteur de table ne doit fuiter vers Au Lait Cru après bascule"
    );
    assert.equal(
      inputById(container, "street"),
      null,
      "ALC-SM-01/section 3 : le formulaire de livraison (adresse) de l'autre établissement ne doit jamais rester affiché pour Au Lait Cru après bascule"
    );
    await waitFor(
      () => inputById(container, "customer_name") !== null,
      "ALC-SM-01/section 3 : le formulaire Click & Collect (pickup, seul mode d'Au Lait Cru) doit être réaffiché après réinitialisation du serviceMode devenu invalide"
    );

    // NOTE (observation hors scope CASE 1A, documentée dans RAPPORT.md) :
    // au moins DEUX states propres à MenuView.tsx ne sont PAS
    // réinitialisés par ce changement de prop `restaurant` sans
    // démontage (aucune prop `key` au site d'appel app/r/[slug]/page.tsx) :
    // le CONTENU du panier (`cart` useState -- ex. "Plat du jour" de
    // l'autre établissement resterait affiché dans CartPanel) et
    // l'onglet de catégorie actif (`activeCategoryId` -- peut ne
    // référencer aucune catégorie existante chez le nouveau tenant, cf.
    // note plus haut). Comportement PRÉEXISTANT, distinct de
    // usePublicSaleModes/ALC-SM-01 et du reset de serviceMode (section 3),
    // et explicitement HORS SCOPE de ce lot (mission CASE 1A :
    // uniquement les modes de vente). Ce test ne fait donc AUCUNE
    // assertion sur le contenu du panier ni sur la catégorie affichée --
    // seulement sur l'état sale-mode/fulfillment, seul périmètre
    // corrigé ici.
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
