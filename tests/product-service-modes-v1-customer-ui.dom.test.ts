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
// PRODUCT SERVICE MODES v1 -- tests DOM DÉDIÉS (interface client
// public) : badge de restriction (MenuItemCard), blocage panier mixte
// (CartPanel : rangée "howToReceive"), et garde-fou de désélection
// automatique (MenuView).
//
// Demandé explicitement par le GO CIO/Ravel (issue #11, "dedicated
// DOM/service tests"). Même patron de montage DOM réel (esbuild +
// jsdom + interception supabase.rpc/from), MÊME fixture de base et
// MÊME infrastructure que tests/v148-fulfillment-choice-popup-v1.dom.test.ts
// -- aucun nouveau patron de test inventé, seulement les scénarios
// PRODUCT SERVICE MODES v1 (aucun de ceux-ci n'existait avant ce lot).
//
// Ce que ce fichier NE reteste PAS volontairement (déjà couvert
// ailleurs, pas de duplication) :
//   - Le popup FulfillmentChoiceModal lui-même (ouverture/fermeture,
//     texte, accessibilité) : v148 ci-dessus, inchangé par ce lot.
//   - blockingItemsByMode()/frontendRestrictedModes() en tant que
//     fonctions pures : tests/product-service-modes-v1-restrictions.test.ts.
//   Le popup reçoit `modes={unblockedServiceModes}` (CartPanel.tsx),
//   dérivé de la MÊME fonction blockingItemsByMode déjà prouvée pure
//   et déjà exercée ci-dessous via la rangée inline -- le
//   Scénario "aucun popup" plus bas prouve directement le cas où le
//   blocage réduit le choix à une seule option.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-psmv1-"));
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

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function allButtonsWithText(container: Element, text: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
}

function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return allButtonsWithText(container, text)[0];
}

/** Bouton de la rangée inline "howToReceive" (CartPanel.tsx), jamais
 *  celui, au même libellé, rendu par le popup FulfillmentChoiceModal
 *  (toujours présent dans le DOM, même fermé) -- même distinction que
 *  v148. */
function inlineButtonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text && !b.closest("dialog")
  );
}

function dialogEl(container: Element): HTMLDialogElement | null {
  return container.querySelector("dialog");
}

function popupIsOpen(container: Element): boolean {
  const dialog = dialogEl(container);
  return dialog !== null && dialog.hasAttribute("open");
}

/** Restaurant fixture -- deux produits (un restreint, un non) pour
 *  pouvoir composer un panier mixte à volonté, sur un marchand
 *  proposant pickup + delivery (patron 2-modes déjà établi par v148). */
function testRestaurant(idSuffix: string, items: Record<string, unknown>[]) {
  return {
    id: `r-psmv1-${idSuffix}`,
    name: `Test PRODUCT SERVICE MODES v1 (${idSuffix})`,
    slug: `psmv1-test-${idSuffix}`,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: `r-psmv1-${idSuffix}`,
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
        restaurant_id: `r-psmv1-${idSuffix}`,
        name: "Produits",
        display_order: 1,
        is_active: true,
        menu_items: items,
      },
    ],
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

function menuItem(over: Record<string, unknown> = {}) {
  return {
    id: "item-free",
    category_id: "cat-1",
    name: "Article libre",
    description: null,
    short_description: null,
    price: 4,
    image_url: null,
    display_order: 1,
    is_available: true,
    allowed_sale_modes: null,
    ...over,
  };
}

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];

function saleModeRow(code: "table" | "pickup" | "delivery") {
  return {
    mode_code: code,
    customer_text: null,
    pricing_mode: "free" as const,
    fixed_fee: null,
    free_threshold: null,
    delay_value: null,
    delay_unit: null,
  };
}

const PICKUP_REQS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "one_of", one_of_group: "contact" },
  { field: "email", requirement: "one_of", one_of_group: "contact" },
];
const DELIVERY_REQS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "delivery_address", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
  { field: "email", requirement: "optional", one_of_group: null },
];

function mockRpc(t: { mock: { method: Function } }) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") {
      return { data: [saleModeRow("pickup"), saleModeRow("delivery")], error: null };
    }
    if (name === "get_restaurant_public_field_requirements") {
      const reqs = args.p_mode_code === "pickup" ? PICKUP_REQS : DELIVERY_REQS;
      return { data: reqs, error: null };
    }
    if (name === "get_restaurant_public_delivery_countries") {
      return {
        data: [
          {
            country_code: "FR",
            country_name: "France",
            postal_code_pattern: "^[0-9]{5}$",
            phone_pattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$",
            address_provider: "ban_ign",
            address_line_order: "number_first",
          },
        ],
        error: null,
      };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "get_restaurant_public_cgv") return { data: [], error: null };
    // MERCHANT CUSTOMER COMMUNICATIONS v1 -- projection PUBLIQUE des
    // textes clients du commercant, lue par MenuView au montage.
    // Servie VIDE : « aucun texte personnalise », qui est l'etat de
    // tout etablissement avant configuration -- donc exactement les
    // formulations plateforme que ces assertions verifiaient deja.
    if (name === "get_restaurant_public_communication_texts") return { data: [], error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

/**
 * CORRECTIF round 2 (audit CHATEAUBRIAND, issue #11) -- variante de
 * mockRpc() pour un établissement qui ne propose qu'UN SEUL mode de
 * service (pickup seul), nécessaire pour prouver que le message
 * nommant le produit bloquant reste visible même quand
 * `availableServiceModes.length === 1` (la rangée de boutons
 * "howToReceive", elle, n'a jamais de raison d'apparaître dans ce cas
 * -- rien à choisir entre un seul mode).
 */
function mockRpcSingleMode(t: { mock: { method: Function } }) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") {
      return { data: [saleModeRow("pickup")], error: null };
    }
    if (name === "get_restaurant_public_field_requirements") {
      return { data: PICKUP_REQS, error: null };
    }
    if (name === "get_restaurant_public_delivery_countries") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "get_restaurant_public_cgv") return { data: [], error: null };
    // MERCHANT CUSTOMER COMMUNICATIONS v1 -- projection PUBLIQUE des
    // textes clients du commercant, lue par MenuView au montage.
    // Servie VIDE : « aucun texte personnalise », qui est l'etat de
    // tout etablissement avant configuration -- donc exactement les
    // formulations plateforme que ces assertions verifiaient deja.
    if (name === "get_restaurant_public_communication_texts") return { data: [], error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

async function renderCatalogue(items: Record<string, unknown>[]) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: testRestaurant("x", items) }));
  await flush();
  return { container, root };
}

function addToCartByName(container: Element, name: string) {
  const card = [...container.querySelectorAll("li, article")].find((el) =>
    (el.textContent ?? "").includes(name)
  );
  assert.ok(card, `carte produit « ${name} » introuvable`);
  const addBtn = [...card!.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Ajouter"));
  assert.ok(addBtn, `bouton Ajouter absent de la carte « ${name} »`);
  click(addBtn!);
}

function openCart(container: Element) {
  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  assert.ok(cartBar, "la barre panier doit apparaître dès qu'un article est ajouté");
  click(cartBar!);
}

// ==================================================================
// A. Badge de restriction (MenuItemCard)
// ==================================================================

test("[Badge] produit restreint à UN seul mode -- badge « <mode> uniquement », jamais un second jeu de libellés", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Coffret retrait seul", allowed_sale_modes: ["pickup"] }),
  ]);
  try {
    await waitFor(
      () => container.querySelector('[data-testid="service-mode-restriction-badge"]') !== null,
      "le badge de restriction doit être rendu"
    );
    const badge = container.querySelector('[data-testid="service-mode-restriction-badge"]');
    assert.equal(badge!.textContent?.trim(), "À emporter uniquement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Badge] produit restreint à PLUSIEURS modes -- badge « Disponible pour : X, Y », dans l'ordre déclaré", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Plat deux modes", allowed_sale_modes: ["delivery", "pickup"] }),
  ]);
  try {
    await waitFor(
      () => container.querySelector('[data-testid="service-mode-restriction-badge"]') !== null,
      "le badge de restriction doit être rendu"
    );
    const badge = container.querySelector('[data-testid="service-mode-restriction-badge"]');
    assert.equal(badge!.textContent?.trim(), "Disponible pour : Livraison, À emporter");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Badge] produit SANS restriction (allowed_sale_modes = null) -- aucun badge affiché", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Plat sans restriction", allowed_sale_modes: null }),
  ]);
  try {
    await waitFor(
      () => container.textContent?.includes("Plat sans restriction") === true,
      "le produit doit être rendu"
    );
    await flush(30);
    assert.equal(
      container.querySelector('[data-testid="service-mode-restriction-badge"]'),
      null,
      "aucun badge ne doit apparaître pour un produit disponible à tous les modes"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// A bis. CORRECTIF round 2 (audit CHATEAUBRIAND, issue #11) -- badge
// pour une restriction composée en tout ou partie de codes non
// reconnus par le frontend (room_service, click_collect) : DOIT
// rester visible (message générique, jamais un mode nommé qui serait
// faux), jamais silencieusement absent comme avant le correctif.
// ------------------------------------------------------------------

test("[Badge] produit restreint à room_service SEUL (mode serveur réel, non rendu par le frontend) -- badge générique « Mode de service limité » (jamais aucun badge absent, jamais un libellé nommant un mode inexistant côté client)", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Plateau chambre seul", allowed_sale_modes: ["room_service"] }),
  ]);
  try {
    await waitFor(
      () => container.querySelector('[data-testid="service-mode-restriction-badge"]') !== null,
      "le badge de restriction générique doit être rendu même pour une restriction non reconnue par le frontend"
    );
    const badge = container.querySelector('[data-testid="service-mode-restriction-badge"]');
    assert.equal(badge!.textContent?.trim(), "Mode de service limité");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Badge] produit restreint à click_collect SEUL -- même badge générique « Mode de service limité »", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Commande drive seule", allowed_sale_modes: ["click_collect"] }),
  ]);
  try {
    await waitFor(
      () => container.querySelector('[data-testid="service-mode-restriction-badge"]') !== null,
      "le badge de restriction générique doit être rendu"
    );
    const badge = container.querySelector('[data-testid="service-mode-restriction-badge"]');
    assert.equal(badge!.textContent?.trim(), "Mode de service limité");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Badge] mélange connu + inconnu (pickup + room_service) -- badge nomme SEULEMENT le mode connu, comportement pickup/delivery existant inchangé", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Coffret mixte", allowed_sale_modes: ["pickup", "room_service"] }),
  ]);
  try {
    await waitFor(
      () => container.querySelector('[data-testid="service-mode-restriction-badge"]') !== null,
      "le badge de restriction doit être rendu"
    );
    const badge = container.querySelector('[data-testid="service-mode-restriction-badge"]');
    // Jamais le badge générique ici : "pickup" est un mode connu, donc
    // nommé normalement -- comportement pickup/delivery existant
    // strictement inchangé, "room_service" est simplement ignoré côté
    // libellé (déjà correctement pris en compte côté blocage panier,
    // testé plus bas).
    assert.equal(badge!.textContent?.trim(), "À emporter uniquement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Badge] restriction à room_service seul -- indépendant de withdrawal_eligible (aucun couplage, exigence CIO déjà prouvée pour le cas connu, re-confirmée ici pour le cas corrigé)", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({
      id: "p1",
      name: "Plateau chambre avec droit de rétractation",
      allowed_sale_modes: ["room_service"],
      withdrawal_eligible: true,
    }),
  ]);
  try {
    await waitFor(
      () => container.querySelector('[data-testid="service-mode-restriction-badge"]') !== null,
      "le badge de restriction générique doit être rendu quelle que soit withdrawal_eligible"
    );
    const badge = container.querySelector('[data-testid="service-mode-restriction-badge"]');
    assert.equal(badge!.textContent?.trim(), "Mode de service limité");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// B. Blocage panier mixte -- rangée "howToReceive" (CartPanel)
// ==================================================================

test("[Panier mixte] un item restreint bloque le mode exclu dans la rangée : bouton désactivé, aria-describedby, message nommant le produit", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Coffret retrait seul", allowed_sale_modes: ["pickup"] }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Coffret retrait seul") === true, "produit rendu");
    addToCartByName(container, "Coffret retrait seul");
    await flush();
    openCart(container);
    await flush();

    const deliveryBtn = inlineButtonWithText(container, "Livraison");
    assert.ok(deliveryBtn, "le bouton 'Livraison' doit exister dans la rangée inline");
    assert.equal(deliveryBtn!.disabled, true, "le bouton 'Livraison' doit être désactivé (bloqué par le panier)");
    assert.equal(deliveryBtn!.getAttribute("aria-invalid"), "true");
    const describedBy = deliveryBtn!.getAttribute("aria-describedby");
    assert.equal(describedBy, "mode-blocked-delivery");

    const message = container.querySelector(`#${describedBy}`);
    assert.ok(message, "le message expliquant le blocage doit exister");
    assert.equal(message!.getAttribute("role"), "status");
    assert.equal(
      message!.textContent?.trim(),
      "Livraison indisponible avec ce panier : Coffret retrait seul."
    );

    // Cliquer sur un bouton désactivé ne doit rien faire : aucune
    // conséquence, aucun mode sélectionné malgré le clic.
    click(deliveryBtn!);
    await flush();
    assert.equal(deliveryBtn!.getAttribute("aria-pressed"), "false");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Panier mixte] le mode NON bloqué reste normalement sélectionnable malgré la restriction d'un autre article", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Coffret retrait seul", allowed_sale_modes: ["pickup"] }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Coffret retrait seul") === true, "produit rendu");
    addToCartByName(container, "Coffret retrait seul");
    await flush();
    openCart(container);
    await flush();

    // Avec un seul mode encore utilisable (pickup), le popup ne
    // s'ouvre PAS (rien à choisir) -- la rangée inline reste le seul
    // moyen de sélectionner.
    assert.equal(popupIsOpen(container), false, "aucun popup quand un seul mode reste utilisable pour ce panier");

    const pickupBtn = inlineButtonWithText(container, "À emporter");
    assert.ok(pickupBtn, "le bouton 'À emporter' doit exister");
    assert.equal(pickupBtn!.disabled, false, "'À emporter' n'est bloqué par aucun article de ce panier");
    click(pickupBtn!);
    await flush();
    assert.equal(pickupBtn!.getAttribute("aria-pressed"), "true", "le mode pickup doit être sélectionnable normalement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Panier mixte] AUCUN article n'est jamais retiré ni scindé par le blocage -- seul le CHOIX de mode devient indisponible (mandat CIO)", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Coffret retrait seul", allowed_sale_modes: ["pickup"] }),
    menuItem({ id: "p2", name: "Article libre" }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Coffret retrait seul") === true, "produits rendus");
    addToCartByName(container, "Coffret retrait seul");
    await flush();
    addToCartByName(container, "Article libre");
    await flush();
    openCart(container);
    await flush();

    // Les deux articles doivent toujours apparaître dans le panier,
    // aucun n'a été retiré par le blocage du mode livraison.
    assert.ok(container.textContent?.includes("Coffret retrait seul"));
    assert.ok(container.textContent?.includes("Article libre"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Panier mixte] produit restreint à room_service SEUL -- bloque LES DEUX modes de l'établissement (table/pickup/delivery non représentés, room_service non rendu), messages nommant le produit pour chacun", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Plateau chambre seul", allowed_sale_modes: ["room_service"] }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Plateau chambre seul") === true, "produit rendu");
    addToCartByName(container, "Plateau chambre seul");
    await flush();
    openCart(container);
    await flush();

    const pickupBtn = inlineButtonWithText(container, "À emporter");
    const deliveryBtn = inlineButtonWithText(container, "Livraison");
    assert.ok(pickupBtn && deliveryBtn, "les deux boutons de mode doivent exister");
    assert.equal(pickupBtn!.disabled, true, "'À emporter' doit être bloqué (room_service n'y est pas inclus)");
    assert.equal(deliveryBtn!.disabled, true, "'Livraison' doit être bloqué (room_service n'y est pas inclus)");

    const pickupMsg = container.querySelector("#mode-blocked-pickup");
    const deliveryMsg = container.querySelector("#mode-blocked-delivery");
    assert.ok(pickupMsg && deliveryMsg, "un message doit nommer le produit bloquant pour CHAQUE mode");
    assert.equal(
      pickupMsg!.textContent?.trim(),
      "À emporter indisponible avec ce panier : Plateau chambre seul."
    );
    assert.equal(
      deliveryMsg!.textContent?.trim(),
      "Livraison indisponible avec ce panier : Plateau chambre seul."
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// CORRECTIF (audit CHATEAUBRIAND round 2, issue #11) -- avant ce
// correctif, la rangée "howToReceive" ENTIÈRE (boutons ET messages de
// blocage) était masquée dès que l'établissement ne propose qu'UN
// SEUL mode de service, même quand ce mode unique était bloqué par le
// panier : le client ne voyait alors STRICTEMENT AUCUNE indication de
// ce qui l'empêchait de commander. Ce scénario prouve que le message
// nommant le produit bloquant reste visible même dans ce cas -- sans
// pour autant faire réapparaître une rangée de boutons inutile (un
// seul mode, rien à choisir).
test("[Panier mixte, établissement MONO-MODE] le message nommant le produit bloquant reste visible même quand un SEUL mode client est proposé (pas de rangée de boutons -- rien à choisir)", async (t) => {
  mockRpcSingleMode(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Plateau chambre seul", allowed_sale_modes: ["room_service"] }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Plateau chambre seul") === true, "produit rendu");
    addToCartByName(container, "Plateau chambre seul");
    await flush();
    openCart(container);
    await flush();

    // Aucune rangée de boutons "howToReceive" : rien à choisir entre
    // un seul mode -- comportement existant inchangé pour ce cas.
    assert.equal(
      inlineButtonWithText(container, "À emporter"),
      undefined,
      "aucun bouton de mode ne doit apparaître -- établissement mono-mode, rien à choisir"
    );

    // Mais le message nommant le produit bloquant DOIT être présent :
    // c'est la seule information disponible expliquant au client
    // pourquoi il ne peut pas finaliser sa commande.
    const pickupMsg = container.querySelector("#mode-blocked-pickup");
    assert.ok(
      pickupMsg,
      "le message nommant le produit bloquant doit rester visible même sans rangée de boutons"
    );
    assert.equal(pickupMsg!.getAttribute("role"), "status");
    assert.equal(
      pickupMsg!.textContent?.trim(),
      "À emporter indisponible avec ce panier : Plateau chambre seul."
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[Panier mixte, établissement MONO-MODE] AUCUN message de blocage quand le panier ne contient QUE des produits utilisables pour l'unique mode (comportement existant inchangé)", async (t) => {
  mockRpcSingleMode(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Article libre mono-mode" }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Article libre mono-mode") === true, "produit rendu");
    addToCartByName(container, "Article libre mono-mode");
    await flush();
    openCart(container);
    await flush();

    assert.equal(
      container.querySelector("#mode-blocked-pickup"),
      null,
      "aucun message de blocage quand rien ne bloque l'unique mode -- comportement existant inchangé"
    );
    assert.equal(
      inlineButtonWithText(container, "À emporter"),
      undefined,
      "toujours aucune rangée de boutons -- établissement mono-mode, rien à choisir, avec ou sans blocage"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// C. Désélection automatique (MenuView) quand le panier change sous
// un mode déjà choisi
// ==================================================================

test("[Désélection auto] un mode déjà choisi ET utilisable devient indisponible dès qu'un article ajouté ensuite le bloque -- jamais l'inverse", async (t) => {
  mockRpc(t);
  const { container, root } = await renderCatalogue([
    menuItem({ id: "p1", name: "Article libre" }),
    menuItem({ id: "p2", name: "Coffret retrait seul", allowed_sale_modes: ["pickup"] }),
  ]);
  try {
    await waitFor(() => container.textContent?.includes("Article libre") === true, "produits rendus");
    addToCartByName(container, "Article libre");
    await flush();
    openCart(container);
    await flush();

    // Panier non restreint pour l'instant : les deux modes sont
    // utilisables, le popup doit s'ouvrir (2 modes, rien choisi).
    await waitFor(() => popupIsOpen(container), "popup attendu (aucune restriction encore, 2 modes)");
    const deliveryPopupBtn = [...dialogEl(container)!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Livraison"
    );
    assert.ok(deliveryPopupBtn, "bouton Livraison présent dans le popup avant toute restriction");
    click(deliveryPopupBtn!);
    await flush();
    assert.equal(popupIsOpen(container), false, "le popup doit se fermer après sélection");
    await waitFor(
      () => container.textContent?.includes("Adresse de livraison") === true,
      "le mode livraison choisi doit afficher l'exigence d'adresse"
    );

    // Le client ajoute ensuite un produit qui bloque justement le
    // mode déjà choisi (livraison) : la sélection doit être
    // réinitialisée -- jamais laissée sur un mode devenu invalide.
    addToCartByName(container, "Coffret retrait seul");
    await flush(120);

    await waitFor(
      () => container.textContent?.includes("Adresse de livraison") === false,
      "le mode livraison, devenu bloqué par le nouvel article, doit être désélectionné automatiquement"
    );

    const deliveryInlineBtn = inlineButtonWithText(container, "Livraison");
    assert.equal(
      deliveryInlineBtn?.getAttribute("aria-pressed"),
      "false",
      "le bouton Livraison ne doit plus apparaître comme sélectionné"
    );
    assert.equal(deliveryInlineBtn?.disabled, true, "et doit maintenant apparaître désactivé (bloqué par le panier)");

    // Toujours aucun article retiré : les deux produits restent dans
    // le panier malgré la réinitialisation du mode.
    assert.ok(container.textContent?.includes("Article libre"));
    assert.ok(container.textContent?.includes("Coffret retrait seul"));
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
