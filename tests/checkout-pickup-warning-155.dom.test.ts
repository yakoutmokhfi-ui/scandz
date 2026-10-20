import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-pw155-"));
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
    id: `r-pw155-${idSuffix}`,
    name: `Test #155 AVERTISSEMENT RETRAIT (${idSuffix})`,
    slug: `pw155-test-${idSuffix}`,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: `r-pw155-${idSuffix}`,
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
        restaurant_id: `r-pw155-${idSuffix}`,
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
    // CSDJ-2 / #158 : lecture publique des dates/créneaux, servie « absent »
    // (aucun calendrier = parcours d'avant). Sans réponse VALIDE le checkout
    // ne laisse plus partir la commande (fail-closed) : le mock doit donc la servir.
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
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
    // CSDJ-2 / #158 : lecture publique des dates/créneaux, servie « absent »
    // (aucun calendrier = parcours d'avant). Sans réponse VALIDE le checkout
    // ne laisse plus partir la commande (fail-closed) : le mock doit donc la servir.
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
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


const { translate } = await import("../lib/i18n.ts");

// ====================================================================
// ISSUE #155 -- AVERTISSEMENT « <mode> indisponible avec ce panier »
//
// CONTRAT (mandat CIO) : l'avertissement de refus de LIVRAISON n'est
// affiché QUE lorsque Livraison est le mode ACTIF ou qu'on tente
// explicitement de la sélectionner. En mode « À emporter », il
// disparaît, y compris avec du lait cru dans le panier. Les règles qui
// interdisent la livraison du lait cru ne changent pas : le mode
// reste refusé, rien n'est jamais envoyé, aucun article n'est retiré.
//
// « ACTIF » est vérifié sur l'état RÉEL (aria-pressed des deux boutons
// + présence/absence des champs d'adresse de livraison), jamais
// seulement sur la présence d'un texte -- c'est ce qui permettrait de
// repérer une incohérence « Livraison semble sélectionnée alors que
// À emporter est actif ».
// ====================================================================

const MILK = "Lait cru";
const FREE = "Article libre";
const WARNING_DELIVERY = "Livraison indisponible avec ce panier : Lait cru.";

function milkItem() {
  return menuItem({ id: "milk", name: MILK, allowed_sale_modes: ["pickup"] });
}
function freeItem() {
  return menuItem({ id: "free", name: FREE, display_order: 2 });
}

/** Bouton de la rangée « howToReceive » (jamais celui du popup). Le libellé
 *  peut être suivi d'un indice (« Adresse… ») quand la livraison est active
 *  mais incomplète : on compare donc le DÉBUT du texte. */
function modeButton(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith(label) && !b.closest("dialog") && b.hasAttribute("aria-pressed")
  ) as HTMLButtonElement | undefined;
}
function text(container: Element): string {
  return container.textContent ?? "";
}
/** Le MOTIF de refus du panier (« Livraison indisponible avec ce panier : … »).
 *  Volontairement distinct de « Livraison indisponible pour ce panier ou cette
 *  destination » (message de zone/minimum de livraison, autre composant). */
function deliveryWarning(container: Element): boolean {
  return (
    container.querySelector("#mode-blocked-delivery") !== null ||
    text(container).includes("Livraison indisponible avec ce panier")
  );
}
function pressed(container: Element, label: string): string | null | undefined {
  return modeButton(container, label)?.getAttribute("aria-pressed");
}
function deliveryFieldsShown(container: Element): boolean {
  return text(container).includes("Adresse de livraison");
}
function rpcNames(): string[] {
  return ((supabase.rpc as any).mock.calls as Array<{ arguments: unknown[] }>).map(
    (c) => String(c.arguments[0])
  );
}
function assertNothingSent() {
  assert.equal(
    rpcNames().filter((n) => n === "create_order").length,
    0,
    "aucune commande ne doit jamais partir de ces scénarios"
  );
}

async function mount(items: Record<string, unknown>[], t: { mock: { method: Function } }) {
  mockRpc(t);
  const r = await renderCatalogue(items);
  await waitFor(() => text(r.container).includes(items[0]!.name as string), "catalogue rendu");
  return r;
}

async function pickInPopup(container: Element, label: string) {
  await waitFor(() => popupIsOpen(container), "popup de choix attendu");
  const btn = [...dialogEl(container)!.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label
  );
  assert.ok(btn, `bouton « ${label} » absent du popup`);
  click(btn!);
  await flush();
}

// --------------------------------------------------------------------
// 1. Mode À emporter choisi dès le départ
// --------------------------------------------------------------------

test("[#155-1] lait cru SEUL, À emporter choisi dans la rangée : AUCUN avertissement de livraison, retrait actif, livraison non active", async (t) => {
  const { container, root } = await mount([milkItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    openCart(container);
    await flush();

    click(modeButton(container, "À emporter")!);
    await flush();

    assert.equal(pressed(container, "À emporter"), "true", "À emporter est réellement actif");
    assert.equal(pressed(container, "Livraison"), "false", "Livraison n'est PAS active");
    assert.equal(deliveryFieldsShown(container), false, "aucun champ d'adresse de livraison");
    assert.equal(deliveryWarning(container), false, "l'avertissement de livraison doit avoir disparu en mode À emporter");
    assert.ok(text(container).includes(MILK), "le lait cru reste dans le panier");
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-2] panier MIXTE (lait cru + article libre), À emporter choisi dès le départ via le popup : aucun avertissement de livraison", async (t) => {
  const { container, root } = await mount([milkItem(), freeItem()], t);
  try {
    addToCartByName(container, FREE);
    await flush();
    openCart(container);
    await flush();
    await pickInPopup(container, "À emporter");

    addToCartByName(container, MILK);
    await flush(120);

    assert.equal(pressed(container, "À emporter"), "true");
    assert.equal(pressed(container, "Livraison"), "false");
    assert.equal(deliveryFieldsShown(container), false);
    assert.equal(deliveryWarning(container), false, "en mode À emporter, aucun avertissement de livraison, même avec du lait cru");
    assert.ok(text(container).includes(MILK) && text(container).includes(FREE), "aucun article retiré");
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-3] lait cru dans le panier AVANT tout choix de mode : aucun mode actif -> aucun avertissement tant que Livraison n'est pas tentée", async (t) => {
  const { container, root } = await mount([milkItem(), freeItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    addToCartByName(container, FREE);
    await flush();
    openCart(container);
    await flush();

    assert.equal(pressed(container, "À emporter"), "false");
    assert.equal(pressed(container, "Livraison"), "false");
    assert.equal(deliveryWarning(container), false, "rien n'est actif ni tenté : aucun avertissement");
    // Le refus reste signalé SANS texte : le bouton est inactif et expliqué à l'activation.
    const del = modeButton(container, "Livraison")!;
    assert.equal(del.getAttribute("aria-disabled"), "true", "Livraison reste marquée indisponible (accessibilité)");
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 2. Livraison refusée -> À emporter
// --------------------------------------------------------------------

test("[#155-4] Livraison TENTÉE avec du lait cru : refus expliqué (texte exact, role=status, aria-describedby), livraison jamais activée, puis À emporter : l'avertissement disparaît", async (t) => {
  const { container, root } = await mount([milkItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    openCart(container);
    await flush();

    const del = modeButton(container, "Livraison")!;
    assert.equal(del.getAttribute("aria-disabled"), "true");
    click(del);
    await flush();

    const msg = container.querySelector("#mode-blocked-delivery");
    assert.ok(msg, "le refus de livraison doit être expliqué quand on la tente");
    assert.equal(msg!.textContent?.trim(), WARNING_DELIVERY);
    assert.equal(msg!.getAttribute("role"), "status");
    assert.equal(del.getAttribute("aria-describedby"), "mode-blocked-delivery");
    assert.equal(pressed(container, "Livraison"), "false", "la livraison n'est JAMAIS activée");
    assert.equal(pressed(container, "À emporter"), "false");
    assert.equal(deliveryFieldsShown(container), false, "aucun champ de livraison");

    click(modeButton(container, "À emporter")!);
    await flush();

    assert.ok(container.querySelector("#mode-blocked-delivery") === null, "transition Livraison refusée -> À emporter : l'avertissement disparaît");
    assert.equal(deliveryWarning(container), false);
    assert.equal(pressed(container, "À emporter"), "true");
    assert.equal(pressed(container, "Livraison"), "false");
    assert.equal(deliveryFieldsShown(container), false);
    assert.equal(modeButton(container, "Livraison")!.getAttribute("aria-disabled"), "true", "la règle de refus est inchangée");
    assert.equal(modeButton(container, "Livraison")!.hasAttribute("aria-describedby"), false, "plus rien à décrire en mode retrait");
    assert.ok(text(container).includes(MILK), "panier conservé");
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-5] À emporter ACTIF puis Livraison tentée : le refus est expliqué, À emporter RESTE le mode actif ; re-choisir À emporter retire l'explication", async (t) => {
  const { container, root } = await mount([milkItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    openCart(container);
    await flush();
    click(modeButton(container, "À emporter")!);
    await flush();
    assert.equal(deliveryWarning(container), false);

    click(modeButton(container, "Livraison")!);
    await flush();

    assert.equal(
      container.querySelector("#mode-blocked-delivery")?.textContent?.trim(),
      WARNING_DELIVERY,
      "une tentative explicite de Livraison doit être expliquée même si À emporter est actif"
    );
    assert.equal(pressed(container, "À emporter"), "true", "le mode actif ne change pas");
    assert.equal(pressed(container, "Livraison"), "false");
    assert.equal(deliveryFieldsShown(container), false);

    click(modeButton(container, "À emporter")!);
    await flush();
    assert.equal(deliveryWarning(container), false, "retour sur À emporter : l'explication disparaît");
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-6] Livraison ACTIVE (choisie avec un panier sans lait cru), puis ajout de lait cru : la sélection est retirée ET le refus expliqué ; À emporter l'efface", async (t) => {
  const { container, root } = await mount([freeItem(), milkItem()], t);
  try {
    addToCartByName(container, FREE);
    await flush();
    openCart(container);
    await flush();
    await pickInPopup(container, "Livraison");
    await waitFor(() => deliveryFieldsShown(container), "livraison active");
    assert.equal(pressed(container, "Livraison"), "true");

    addToCartByName(container, MILK);
    await flush(120);
    await waitFor(() => !deliveryFieldsShown(container), "livraison désélectionnée");

    assert.equal(pressed(container, "Livraison"), "false", "Livraison n'est plus active");
    assert.equal(pressed(container, "À emporter"), "false");
    assert.equal(
      container.querySelector("#mode-blocked-delivery")?.textContent?.trim(),
      WARNING_DELIVERY,
      "le mode qui vient d'être retiré au client doit être expliqué"
    );

    click(modeButton(container, "À emporter")!);
    await flush();
    assert.equal(deliveryWarning(container), false);
    assert.equal(pressed(container, "À emporter"), "true");
    assert.equal(pressed(container, "Livraison"), "false");
    assert.equal(deliveryFieldsShown(container), false);
    assert.ok(text(container).includes(MILK) && text(container).includes(FREE));
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-7] état réellement actif, transitions croisées : jamais Livraison ET À emporter pressés ensemble, jamais d'adresse de livraison en mode retrait", async (t) => {
  const { container, root } = await mount([milkItem(), freeItem()], t);
  try {
    addToCartByName(container, FREE);
    await flush();
    openCart(container);
    await flush();
    const observe = (label: string) => {
      const p = pressed(container, "À emporter") === "true";
      const d = pressed(container, "Livraison") === "true";
      assert.equal(p && d, false, `${label} : deux modes pressés simultanément`);
      if (p) assert.equal(deliveryFieldsShown(container), false, `${label} : champs de livraison visibles en mode retrait`);
      if (d) assert.equal(deliveryFieldsShown(container), true, `${label} : livraison active sans ses champs`);
      if (!d) assert.equal(deliveryFieldsShown(container), false, `${label} : champs de livraison sans livraison active`);
    };
    await pickInPopup(container, "À emporter");
    observe("retrait choisi");
    click(modeButton(container, "Livraison")!);
    await flush();
    observe("livraison choisie");
    assert.equal(pressed(container, "Livraison"), "true");
    addToCartByName(container, MILK);
    await flush(120);
    observe("lait cru ajouté");
    assert.equal(pressed(container, "Livraison"), "false");
    click(modeButton(container, "À emporter")!);
    await flush();
    observe("retrait après refus");
    assert.equal(pressed(container, "À emporter"), "true");
    assert.equal(deliveryWarning(container), false);
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-7b] présentation : en mode À emporter, Livraison refusée est GRISÉE (neutre), jamais ambre ni « erreur » ; À emporter porte seul la sélection active", async (t) => {
  const { container, root } = await mount([milkItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    openCart(container);
    await flush();
    click(modeButton(container, "À emporter")!);
    await flush();
    const del = modeButton(container, "Livraison")!;
    const pick = modeButton(container, "À emporter")!;
    assert.equal(/amber/.test(del.className), false, "pas d'ambre (couleur d'erreur) sur un mode non utilisé");
    assert.equal(del.hasAttribute("aria-invalid"), false);
    assert.ok(/caramel/.test(pick.className), "À emporter porte la mise en évidence de sélection");
    assert.equal(/caramel/.test(del.className), false);
    // Tentative : l'ambre (erreur) n'apparaît qu'à ce moment-là.
    click(del);
    await flush();
    assert.ok(/amber/.test(modeButton(container, "Livraison")!.className), "après tentative : état d'erreur visible");
    assert.ok(/caramel/.test(modeButton(container, "À emporter")!.className), "À emporter reste le mode actif");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 3. Garde-fous : le refus doit rester expliqué quand aucune autre voie
// --------------------------------------------------------------------

test("[#155-8] aucune alternative possible (produit réservé à room_service) : les DEUX refus restent expliqués d'emblée (le client ne peut rien commander)", async (t) => {
  const { container, root } = await mount(
    [menuItem({ id: "rs", name: "Plateau chambre", allowed_sale_modes: ["room_service"] })],
    t
  );
  try {
    addToCartByName(container, "Plateau chambre");
    await flush();
    openCart(container);
    await flush();
    assert.ok(container.querySelector("#mode-blocked-pickup"));
    assert.ok(container.querySelector("#mode-blocked-delivery"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-9] un bouton refusé n'est PLUS natif disabled (sinon la tentative est inobservable) mais reste aria-disabled, et un clic ne l'active jamais", async (t) => {
  const { container, root } = await mount([milkItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    openCart(container);
    await flush();
    const del = modeButton(container, "Livraison")!;
    assert.equal(del.disabled, false, "doit pouvoir recevoir le geste pour l'expliquer");
    assert.equal(del.getAttribute("aria-disabled"), "true");
    click(del);
    click(del);
    await flush();
    assert.equal(del.getAttribute("aria-invalid"), "true", "après tentative : état d'erreur exposé");
    assert.equal(del.getAttribute("aria-pressed"), "false");
    assert.equal(deliveryFieldsShown(container), false);
    assertNothingSent();
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[#155-10] l'explication disparaît aussi quand le lait cru est retiré du panier (plus rien à expliquer), sans retour intempestif si on le rajoute", async (t) => {
  const { container, root } = await mount([milkItem(), freeItem()], t);
  try {
    addToCartByName(container, MILK);
    await flush();
    addToCartByName(container, FREE);
    await flush();
    openCart(container);
    await flush();
    click(modeButton(container, "Livraison")!);
    await flush();
    assert.ok(container.querySelector("#mode-blocked-delivery"));

    // retire le lait cru : bouton « Diminuer la quantité » de sa ligne
    const line = [...container.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes(MILK) && [...li.querySelectorAll("button")].some((b) => /Diminuer|Retirer/.test(b.getAttribute("aria-label") ?? "")));
    assert.ok(line, "ligne du lait cru dans le panier");
    const minus = [...line!.querySelectorAll("button")].find((b) => /Diminuer|Retirer/.test(b.getAttribute("aria-label") ?? ""));
    assert.ok(minus, "bouton de retrait de la ligne");
    click(minus!);
    await flush(60);
    assert.equal(deliveryWarning(container), false, "plus de lait cru : plus d'avertissement");
    assert.equal(modeButton(container, "Livraison")!.getAttribute("aria-disabled"), null);

    addToCartByName(container, MILK);
    await flush(60);
    assert.equal(deliveryWarning(container), false, "rajouter du lait cru sans re-tenter la livraison : pas d'avertissement fantôme");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 4. i18n : le libellé du refus existe et garde ses paramètres
// --------------------------------------------------------------------

test("[#155-11] « serviceModeBlockedByCart » : FR/EN/AR gardent {mode} et {items}, la substitution produit le texte attendu ; NL retombe sur FR (comportement existant)", () => {
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const out = translate(lang, "serviceModeBlockedByCart", { mode: "MODE_X", items: "ITEMS_Y" });
    assert.ok(out.includes("MODE_X") && out.includes("ITEMS_Y"), `${lang} : paramètres perdus (${out})`);
    assert.equal(out.includes("{mode}") || out.includes("{items}"), false, `${lang} : paramètre non substitué`);
  }
  assert.equal(
    translate("fr", "serviceModeBlockedByCart", { mode: "Livraison", items: "Lait cru" }),
    "Livraison indisponible avec ce panier : Lait cru."
  );
  assert.equal(
    translate("en", "serviceModeBlockedByCart", { mode: "Delivery", items: "Raw milk" }),
    "Delivery unavailable with this basket: Raw milk."
  );
  assert.equal(
    translate("nl", "serviceModeBlockedByCart", { mode: "Livraison", items: "Lait cru" }),
    translate("fr", "serviceModeBlockedByCart", { mode: "Livraison", items: "Lait cru" })
  );
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
