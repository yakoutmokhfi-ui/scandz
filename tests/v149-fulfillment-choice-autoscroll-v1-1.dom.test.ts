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
// SCANYM — CLAUDE NOUGARO — CUSTOMER ORDERING UX — FULFILLMENT CHOICE
// v1.1 (POST-SELECTION AUTO-SCROLL / FOCUS).
//
// Même patron de montage DOM réel (esbuild + jsdom + interception
// supabase.rpc/from) que tests/v148-fulfillment-choice-popup-v1.dom.test.ts
// -- aucun nouveau patron de test inventé. Ce fichier est
// intentionnellement autonome (aucun import depuis v148), comme tous
// les fichiers *.dom.test.ts existants de ce dépôt.
//
// jsdom N'IMPLÉMENTE PAS `Element.prototype.scrollIntoView` (absent,
// jamais un no-op) -- voir CartPanel.tsx pour la détection de
// fonctionnalité correspondante. Ce fichier définit donc un STUB
// EXPLICITE sur HTMLElement.prototype AVANT de monter quoi que ce
// soit, afin de pouvoir observer POSITIVEMENT les appels (élément
// cible + options), plutôt que de se contenter d'une absence de
// crash comme seule preuve.
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

type ScrollCall = { targetId: string | null; targetTag: string; behavior?: string; block?: string };
let scrollCalls: ScrollCall[] = [];
window.HTMLElement.prototype.scrollIntoView = function (
  this: HTMLElement,
  opts?: ScrollIntoViewOptions
) {
  scrollCalls.push({
    targetId: this.id || null,
    targetTag: this.tagName,
    behavior: (opts as any)?.behavior,
    block: (opts as any)?.block,
  });
};

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v149-"));
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

/** Comme buttonWithText, mais exclut explicitement tout bouton
 *  descendant d'un <dialog> -- cible sans ambiguïté la rangée inline
 *  "howToReceive" plutôt que le popup (même helper que v148). */
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

function testRestaurant(idSuffix: string) {
  return {
    id: `r-fcas-${idSuffix}`,
    name: `Test Fulfillment Choice Autoscroll (${idSuffix})`,
    slug: `fcas-test-${idSuffix}`,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: `r-fcas-${idSuffix}`,
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
        restaurant_id: `r-fcas-${idSuffix}`,
        name: "Produits",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: "item-1",
            category_id: "cat-1",
            name: "Article",
            description: null,
            short_description: null,
            price: 4,
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
    if (name === "get_restaurant_public_delivery_fulfillments") {
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return { calledRpcNames };
}

async function renderAndAddOneItemToCart(restaurant: ReturnType<typeof testRestaurant>) {
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

// --------------------------------------------------------------------
// 1, 2, 3. LIVRAISON via le popup : ferme le popup, défile vers la
// section adresse (#delivery-address-section), focalise le premier
// champ d'adresse significatif (#postalCode).
// --------------------------------------------------------------------
test("1/2/3 -- choisir Livraison dans le popup : popup fermé, défilement vers #delivery-address-section, focus sur #postalCode", async (t) => {
  scrollCalls = [];
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("scroll-delivery"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const deliveryBtn = [...dialogEl(container)!.querySelectorAll("button")].find(
      (b) => b.textContent === "Livraison"
    )!;
    click(deliveryBtn);
    await flush();

    assert.equal(popupIsOpen(container), false, "1. le popup doit se refermer après sélection Livraison");

    await waitFor(
      () => container.querySelector("#delivery-address-section") !== null,
      "la section adresse doit être montée"
    );
    await waitFor(() => scrollCalls.length > 0, "un défilement doit avoir été déclenché");

    assert.equal(
      scrollCalls.length,
      1,
      "2. exactement UN défilement déclenché par cette sélection explicite"
    );
    assert.equal(
      scrollCalls[0].targetId,
      "delivery-address-section",
      "2b. le défilement cible précisément #delivery-address-section, pas seulement le conteneur englobant"
    );
    assert.equal(scrollCalls[0].behavior, "smooth", "2c. défilement fluide (comportement délibéré, pas un saut brutal)");
    assert.equal(scrollCalls[0].block, "start", "2d. aligne le haut de la section en vue");

    await waitFor(
      () => window.document.activeElement?.id === "postalCode",
      "3. le focus doit se porter sur #postalCode (premier champ d'adresse significatif)"
    );
    const focused = window.document.activeElement as HTMLInputElement;
    assert.equal(focused.tagName, "INPUT", "3b. le champ focalisé est un <input> natif");
    assert.equal(
      container.querySelector('label[for="postalCode"]')?.textContent,
      "Code postal",
      "3c. le champ focalisé porte bien un label accessible (comportement clavier/lecteur d'écran préservé)"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 4, 5, 6. À EMPORTER via le popup : ferme le popup, défile vers la
// section FulfillmentSelector (prochaine section actionnable), ne
// focalise JAMAIS de champ d'adresse (structurellement absent du DOM
// pour ce mode).
// --------------------------------------------------------------------
test("4/5/6 -- choisir À emporter dans le popup : popup fermé, défilement vers la section coordonnées, aucun focus sur un champ d'adresse", async (t) => {
  scrollCalls = [];
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("scroll-pickup"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const pickupBtn = [...dialogEl(container)!.querySelectorAll("button")].find(
      (b) => b.textContent === "À emporter"
    )!;
    click(pickupBtn);
    await flush();

    assert.equal(popupIsOpen(container), false, "4. le popup doit se refermer après sélection À emporter");

    await waitFor(
      () => container.textContent?.includes("Complétez vos coordonnées") === true,
      "la section coordonnées doit être montée"
    );
    await waitFor(() => scrollCalls.length > 0, "un défilement doit avoir été déclenché");

    assert.equal(scrollCalls.length, 1, "5. exactement UN défilement déclenché par cette sélection explicite");
    assert.notEqual(
      scrollCalls[0].targetId,
      "delivery-address-section",
      "5b. le défilement ne cible JAMAIS la section adresse (structurellement absente pour ce mode)"
    );
    assert.equal(scrollCalls[0].targetTag, "DIV", "5c. cible le conteneur de la section coordonnées (prochaine section actionnable)");

    assert.equal(
      container.querySelector("#delivery-address-section"),
      null,
      "6. aucun champ d'adresse de livraison n'existe dans le DOM pour ce mode"
    );
    assert.equal(
      container.querySelector("#postalCode"),
      null,
      "6b. #postalCode n'existe pas non plus -- structurellement impossible d'y focaliser quoi que ce soit"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 7, 8. Bascule de mode (Livraison -> À emporter -> Livraison) : le
// défilement/focus se met à jour à CHAQUE bascule explicite (rangée
// inline "howToReceive"), jamais figé sur la première sélection.
// --------------------------------------------------------------------
test("7/8 -- bascule Livraison -> À emporter -> Livraison : le défilement/focus se met à jour à chaque sélection explicite", async (t) => {
  scrollCalls = [];
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("switch-scroll"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    await waitFor(() => scrollCalls.length === 1, "premier défilement (Livraison)");
    assert.equal(scrollCalls[0].targetId, "delivery-address-section");
    await waitFor(() => window.document.activeElement?.id === "postalCode", "focus initial sur postalCode");

    // 7. Livraison -> À emporter.
    click(inlineButtonWithText(container, "À emporter")!);
    await flush();
    await waitFor(() => scrollCalls.length === 2, "second défilement (À emporter)");
    assert.notEqual(
      scrollCalls[1].targetId,
      "delivery-address-section",
      "7. après bascule vers À emporter, la cible de défilement change (plus jamais la section adresse)"
    );
    assert.notEqual(
      window.document.activeElement?.id,
      "postalCode",
      "7b. aucun focus résiduel sur #postalCode après bascule vers À emporter (le champ est démonté)"
    );

    // 8. À emporter -> Livraison.
    click(inlineButtonWithText(container, "Livraison")!);
    await flush();
    await waitFor(() => scrollCalls.length === 3, "troisième défilement (Livraison de nouveau)");
    assert.equal(
      scrollCalls[2].targetId,
      "delivery-address-section",
      "8. après re-bascule vers Livraison, la cible de défilement redevient la section adresse"
    );
    await waitFor(
      () => window.document.activeElement?.id === "postalCode",
      "8b. le focus revient sur #postalCode après re-bascule vers Livraison"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 9. Aucune boucle de défilement : une fois un mode choisi, taper dans
// les champs (re-rendus génériques, aucune nouvelle sélection) ne doit
// JAMAIS redéclencher de défilement/focus.
// --------------------------------------------------------------------
test("9 -- aucune boucle de défilement : les re-rendus génériques (saisie dans un champ) ne redéclenchent jamais le défilement", async (t) => {
  scrollCalls = [];
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("no-scroll-loop"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    await waitFor(() => scrollCalls.length === 1, "un seul défilement après la sélection");

    const postalInput = container.querySelector<HTMLInputElement>("#postalCode")!;
    for (const digit of ["9", "2", "1", "0", "0"]) {
      postalInput.value += digit;
      postalInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      await flush();
    }
    const cityInput = container.querySelector<HTMLInputElement>("#city")!;
    cityInput.value = "Boulogne";
    cityInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    await flush(50);

    assert.equal(
      scrollCalls.length,
      1,
      "9. aucun appel de défilement supplémentaire n'a été déclenché par ces re-rendus génériques (saisie de champs)"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 10. Aucun défilement automatique au rendu initial sans sélection
// explicite (marchand à mode unique : présélection PROGRAMMATIQUE,
// jamais un clic client).
// --------------------------------------------------------------------
test("10 -- marchand à mode unique : présélection automatique programmatique, AUCUN défilement/focus déclenché", async (t) => {
  scrollCalls = [];
  mockRpc(t, [saleModeRow("delivery")], { delivery: DELIVERY_REQS });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("no-autoscroll-single-mode"));
  try {
    await waitFor(
      () => container.textContent?.includes("Adresse de livraison") === true,
      "le mode delivery doit être présélectionné automatiquement (aucun popup, un seul mode)"
    );
    assert.equal(popupIsOpen(container), false, "aucun popup pour un mode unique");
    // Laisse le temps à un éventuel effet erroné de se déclencher.
    await flush(100);
    assert.equal(
      scrollCalls.length,
      0,
      "10. la présélection automatique (programmatique, aucun clic client) ne doit JAMAIS déclencher de défilement"
    );
    assert.notEqual(
      window.document.activeElement?.id,
      "postalCode",
      "10b. aucun focus automatique non plus sur le rendu initial"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 11, 12, 13. Aucune commande dupliquée, aucun paiement, aucun Stuart
// -- preuve positive par trace exhaustive des RPC pendant tout le
// scénario de sélection/bascule (même patron que v148, scénario
// 10/11/12).
// --------------------------------------------------------------------
test("11/12/13 -- trace exhaustive des RPC pendant sélection + bascule : jamais create_order, jamais paiement, jamais Stuart", async (t) => {
  const { calledRpcNames } = mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("no-side-effects"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    click(inlineButtonWithText(container, "À emporter")!);
    await flush();
    click(inlineButtonWithText(container, "Livraison")!);
    await flush();

    const KNOWN_SAFE_RPCS = new Set([
      "get_restaurant_public_sale_modes",
      "get_restaurant_public_field_requirements",
      "get_restaurant_public_delivery_info",
      "get_restaurant_public_delivery_fulfillments",
    ]);
    const unexpected = calledRpcNames.filter((n) => !KNOWN_SAFE_RPCS.has(n));
    assert.deepEqual(
      unexpected,
      [],
      `seules les RPC de lecture génériques déjà auditées doivent être appelées : inattendu(s) ${unexpected.join(", ")}`
    );
    assert.ok(!calledRpcNames.includes("create_order"), "11. aucune commande créée par le défilement/focus post-sélection");
    assert.ok(
      !calledRpcNames.some((n) => /monetico|payment/i.test(n)),
      "12. aucun déclenchement paiement/Monetico"
    );
    assert.ok(!calledRpcNames.some((n) => /stuart/i.test(n)), "13. aucun déclenchement Stuart");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 14. Le panier (contenu/quantité) reste préservé à travers les
// sélections/bascules qui déclenchent le défilement/focus.
// --------------------------------------------------------------------
test("14 -- le panier reste préservé à travers les sélections qui déclenchent le défilement", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("cart-preserved"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    click(inlineButtonWithText(container, "À emporter")!);
    await flush();

    assert.ok(
      container.textContent?.includes("4,00"),
      "14. le prix de l'unique article ajouté doit rester affiché (panier préservé à travers les sélections)"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 15. Comportement clavier préservé : le champ auto-focalisé reste un
// <input> natif pleinement opérable (éditable, associé à un <label>),
// et le popup lui-même conserve sa fermeture native par Échap (inchangée,
// FulfillmentChoiceModal non modifié -- non-régression directe).
// --------------------------------------------------------------------
test("15 -- comportement clavier préservé : champ auto-focalisé pleinement opérable, popup toujours natif", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("keyboard-preserved"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const dialog = dialogEl(container)!;
    // Le popup reste un <dialog> natif avec un type de bouton natif --
    // comportement Échap/piège de focus géré nativement par le
    // navigateur, non modifié par ce lot (aucune ligne de
    // FulfillmentChoiceModal.tsx n'est touchée).
    assert.equal(dialog.tagName, "DIALOG");
    const deliveryBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!;
    assert.equal(deliveryBtn.getAttribute("type"), "button");
    click(deliveryBtn);
    await flush();

    await waitFor(
      () => window.document.activeElement?.id === "postalCode",
      "le focus doit se porter sur #postalCode"
    );
    const focused = window.document.activeElement as HTMLInputElement;
    // Le champ auto-focalisé reste pleinement éditable au clavier --
    // l'auto-focus ne le désactive ni ne le rend en lecture seule.
    assert.equal(focused.disabled, false, "15. le champ auto-focalisé n'est jamais désactivé");
    assert.equal(focused.readOnly, false, "15b. le champ auto-focalisé reste modifiable");
    focused.value = "75001";
    focused.dispatchEvent(new window.Event("input", { bubbles: true }));
    await flush();
    assert.equal(
      container.querySelector<HTMLInputElement>("#postalCode")?.value,
      "75001",
      "15c. la saisie clavier fonctionne normalement immédiatement après l'auto-focus"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 16. Gabarit mobile préservé : le conteneur défilable de CartPanel et
// le pied de page collant conservent leurs classes structurelles
// (aucun changement de layout introduit par ce lot).
// --------------------------------------------------------------------
test("16 -- gabarit mobile préservé : conteneur défilable et pied de page collant inchangés", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("mobile-layout-preserved"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    await waitFor(
      () => container.querySelector("#delivery-address-section") !== null,
      "la section adresse doit être montée"
    );

    const scrollableRegion = container.querySelector(".overflow-y-auto");
    assert.ok(scrollableRegion, "16. le conteneur défilable de CartPanel (overflow-y-auto) est toujours présent");
    assert.match(
      scrollableRegion!.className,
      /overscroll-contain/,
      "16b. overscroll-contain toujours présent (empêche le scroll-chaining vers la page derrière le panier)"
    );

    const footer = [...container.querySelectorAll("div")].find((d) =>
      d.className.includes("safe-area-inset-bottom")
    );
    assert.ok(footer, "16c. le pied de page collant (zone tactile sûre mobile) est toujours présent");
    assert.match(
      footer!.className,
      /shrink-0/,
      "16d. le pied de page reste hors du flux défilable (shrink-0) -- ne peut donc jamais recouvrir le contenu défilé en vue par ce lot"
    );

    // La section adresse fraîchement défilée en vue est bien à
    // l'intérieur du conteneur défilable, jamais du pied de page fixe.
    const addressSection = container.querySelector("#delivery-address-section")!;
    assert.ok(
      scrollableRegion!.contains(addressSection),
      "16e. la section adresse amenée en vue est structurellement à l'intérieur du conteneur défilable, jamais recouverte par le pied de page collant"
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
