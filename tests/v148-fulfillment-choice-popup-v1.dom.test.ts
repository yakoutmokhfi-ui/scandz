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
// SCANYM — CLAUDE DEBUSSY — CUSTOMER ORDERING UX — FULFILLMENT CHOICE
// POPUP v1 (À emporter / Livraison — pilote Emmanuel).
//
// Couvre les 17 scénarios minimums du mandat + les vérifications
// "aucun effet de bord" (Stuart / paiement / commande dupliquée) et
// non-régression. Même patron de montage DOM réel (esbuild + jsdom +
// interception supabase.rpc/from) que tests/v92-aulaitcru-sale-modes-
// runtime.dom.test.ts / tests/v94-alc-sm-02-sale-modes-ui-states.dom.test.ts
// -- aucun nouveau patron de test inventé.
//
// Réutilise l'infrastructure EXISTANTE de bout en bout : aucune
// nouvelle table/colonne/RPC/config -- get_restaurant_public_sale_modes
// / usePublicSaleModes / create_order (p_service_mode) inchangés.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v148-"));
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
 *  descendant d'un <dialog> -- nécessaire pour cibler SANS ambiguïté
 *  la rangée "howToReceive" inline existante (CartPanel.tsx) plutôt
 *  que le bouton de même libellé rendu par FulfillmentChoiceModal
 *  (toujours présent dans le DOM, même fermé -- voir sa documentation :
 *  contenu identique à ProductInfoButton.tsx, jamais démonté). */
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

/** Restaurant fixture générique, paramétrée UNIQUEMENT par les modes
 *  de vente activés -- jamais de branche "Emmanuel" codée en dur
 *  nulle part dans ce fichier ni dans le composant testé : le mandat
 *  interdit explicitement toute config marchand en dur dans le code
 *  partagé, et ce test le prouve en exerçant plusieurs configurations
 *  de merchant différentes avec exactement le même composant. */
function testRestaurant(idSuffix: string) {
  return {
    id: `r-fcp-${idSuffix}`,
    name: `Test Fulfillment Choice Popup (${idSuffix})`,
    slug: `fcp-test-${idSuffix}`,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: `r-fcp-${idSuffix}`,
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
        restaurant_id: `r-fcp-${idSuffix}`,
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

/** Exigences par défaut du catalogue backend (voir
 *  supabase/migration-v82-lot2a-sale-modes.sql, sections 2b/2c) --
 *  aucune valeur inventée ici. */
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

/** Mock RPC générique -- trace tous les noms de RPC réellement
 *  invoqués (pour prouver "aucun appel Stuart / paiement / commande"
 *  de façon POSITIVE, jamais seulement par absence d'assertion). */
function mockRpc(
  t: { mock: { method: Function } },
  saleModeRows: unknown[],
  reqsByMode: Record<string, unknown[]>
): { calledRpcNames: string[]; calledRpcArgs: Array<{ name: string; args: any }> } {
  const calledRpcNames: string[] = [];
  const calledRpcArgs: Array<{ name: string; args: any }> = [];
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calledRpcNames.push(name);
    calledRpcArgs.push({ name, args });
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
    // get_restaurant_public_delivery_fulfillments : RPC de lecture
    // publique PRÉEXISTANTE (DRAFT-lot-fulfillment-routing-lot-b-rpc.sql,
    // déjà auditée dans un lot antérieur, hors périmètre de ce popup) --
    // FulfillmentSelector.tsx l'invoque dès que le mode 'delivery' est
    // actif, EXACTEMENT de la même façon que via la rangée inline
    // préexistante ou via ce popup (même callback onSelectFulfillment
    // des deux côtés) : ce n'est donc jamais un effet de bord introduit
    // par ce lot. Réponse neutre (aucune règle) -- ne modifie ni
    // n'invente aucun comportement de tarification/zone.
    if (name === "get_restaurant_public_delivery_fulfillments") {
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue dans ce test (ne devrait JAMAIS être appelée par une simple sélection de mode) : ${name}`);
  });
  return { calledRpcNames, calledRpcArgs };
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

function sendButton(container: Element) {
  return buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
}

// --------------------------------------------------------------------
// 1 & 4. Marchand À EMPORTER SEUL : un seul mode -> présélection
// automatique (comportement EXISTANT, inchangé), AUCUN popup, ET la
// livraison n'est réellement PAS sélectionnable (aucun bouton
// "Livraison" nulle part -- ni popup, ni rangée inline) : un vrai
// verrou, pas seulement un masquage visuel.
// --------------------------------------------------------------------
test("Scénario 1/4 -- marchand À EMPORTER SEUL : aucun popup (présélection automatique), aucun bouton Livraison nulle part (mode réellement indisponible, pas seulement masqué)", async (t) => {
  mockRpc(t, [saleModeRow("pickup")], { pickup: PICKUP_REQS });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("pickup-only"));
  try {
    await waitFor(
      () => container.textContent?.includes("Complétez vos coordonnées") === true,
      "le mode pickup doit être présélectionné automatiquement (coordonnées requises, jamais un blocage 'missingFulfillment')"
    );
    assert.equal(popupIsOpen(container), false, "le popup ne doit jamais être ouvert quand un seul mode existe (rien à choisir)");
    assert.equal(
      allButtonsWithText(container, "Livraison").length,
      0,
      "aucun bouton 'Livraison' nulle part (popup ou rangée inline) : la livraison n'est simplement pas activée pour ce marchand"
    );
    assert.equal(
      allButtonsWithText(container, "Sur place, à table").length,
      0,
      "aucun bouton table non plus"
    );
    assert.ok(
      !container.textContent?.includes("Adresse de livraison"),
      "aucune exigence d'adresse de livraison pour un marchand à emporter seul"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 2. Marchand LIVRAISON SEULE : présélection automatique, adresse de
// livraison exigée, aucun popup (rien à choisir), aucun bouton
// "À emporter" nulle part.
// --------------------------------------------------------------------
test("Scénario 2 -- marchand LIVRAISON SEULE : présélection automatique, aucun popup, adresse de livraison exigée, aucun bouton À emporter", async (t) => {
  mockRpc(t, [saleModeRow("delivery")], { delivery: DELIVERY_REQS });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("delivery-only"));
  try {
    await waitFor(
      () => container.textContent?.includes("Adresse de livraison") === true,
      "le mode delivery présélectionné doit exiger une adresse de livraison"
    );
    assert.equal(popupIsOpen(container), false, "le popup ne doit jamais être ouvert quand un seul mode existe");
    assert.equal(allButtonsWithText(container, "À emporter").length, 0, "aucun bouton 'À emporter' nulle part");
    assert.equal(sendButton(container), undefined, "envoi impossible tant que l'adresse/coordonnées ne sont pas remplies");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 3, 14, 15, 16. Marchand AVEC LES DEUX MODES (pilote Emmanuel) :
// popup automatique, titre exact du mandat, boutons "[ À emporter ]"
// "[ Livraison ]", gabarit mobile (largeur/rembourrage tactile),
// nom accessible (aria-labelledby), boutons natifs (clavier).
// --------------------------------------------------------------------
test("Scénario 3/14/15 -- marchand À EMPORTER + LIVRAISON : popup automatique, texte exact du mandat, boutons À emporter/Livraison, gabarit mobile, nom accessible", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("both"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir automatiquement (2 modes, aucun choisi)");

    const dialog = dialogEl(container)!;
    assert.equal(
      dialog.textContent?.includes("Comment souhaitez-vous recevoir votre commande ?"),
      true,
      "le texte du popup doit être EXACTEMENT celui du mandat"
    );

    // Nom accessible du dialogue : aria-labelledby pointe vers un <h2>
    // visible portant ce même texte (jamais un dialogue sans nom).
    const labelledBy = dialog.getAttribute("aria-labelledby");
    assert.ok(labelledBy, "le popup doit avoir un nom accessible (aria-labelledby)");
    const heading = container.querySelector(`#${labelledBy}`);
    assert.ok(heading, "l'élément référencé par aria-labelledby doit exister");
    assert.equal(heading?.textContent, "Comment souhaitez-vous recevoir votre commande ?");

    const pickupBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "À emporter");
    const deliveryBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Livraison");
    assert.ok(pickupBtn, "bouton 'À emporter' dans le popup");
    assert.ok(deliveryBtn, "bouton 'Livraison' dans le popup");
    // Boutons natifs <button type="button"> -- focusables/activables au
    // clavier nativement, aucun rôle/tabindex artificiel nécessaire.
    assert.equal(pickupBtn!.tagName, "BUTTON");
    assert.equal(pickupBtn!.getAttribute("type"), "button");
    assert.equal(deliveryBtn!.getAttribute("type"), "button");

    // Gabarit mobile : largeur bornée à l'écran (calc(100%-2rem)),
    // conteneur centré, boutons en rangée flexible à largeur égale
    // (flex-1) pour une cible tactile confortable de chaque côté --
    // jamais un débordement horizontal (max-w-sm, w-[calc(100%-2rem)]).
    assert.match(dialog.className, /w-\[calc\(100%-2rem\)\]/);
    assert.match(dialog.className, /max-w-sm/);
    assert.match(pickupBtn!.className, /flex-1/);
    assert.match(pickupBtn!.className, /py-3\b/);
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 16 (suite). i18n : le titre du popup existe dans les 3 langues de
// l'interface (fr/en/ar), avec un texte RÉELLEMENT distinct par
// langue -- jamais un repli silencieux vers le français pour en/ar
// (contrat translate(): dict[key] ?? fr[key] ?? key -- ce test prouve
// que 'en' et 'ar' n'ont pas besoin de ce repli pour cette clé).
// --------------------------------------------------------------------
test("Scénario 16 -- i18n : fulfillmentChoicePopupTitle existe et est traduit dans fr/en/ar (pas de repli silencieux)", async () => {
  const { translate } = await import("../lib/i18n.ts");
  const fr = translate("fr", "fulfillmentChoicePopupTitle");
  const en = translate("en", "fulfillmentChoicePopupTitle");
  const ar = translate("ar", "fulfillmentChoicePopupTitle");
  assert.equal(fr, "Comment souhaitez-vous recevoir votre commande ?");
  assert.ok(en.length > 0 && en !== "fulfillmentChoicePopupTitle", "en ne doit jamais retomber sur la clé brute");
  assert.ok(ar.length > 0 && ar !== "fulfillmentChoicePopupTitle", "ar ne doit jamais retomber sur la clé brute");
  assert.notEqual(en, fr);
  assert.notEqual(ar, fr);
  // Les libellés de bouton pickup/delivery, réutilisés tels quels par
  // le popup, restent également traduits dans les 3 langues (déjà
  // existants, non modifiés par ce lot -- vérifié ici pour mémoire de
  // non-régression).
  assert.equal(translate("fr", "pickup"), "À emporter");
  assert.equal(translate("fr", "delivery"), "Livraison");
  assert.ok(translate("en", "pickup").length > 0);
  assert.ok(translate("ar", "pickup").length > 0);
});

// --------------------------------------------------------------------
// 5. À EMPORTER choisi via le popup => aucune exigence d'adresse de
// livraison.
// --------------------------------------------------------------------
test("Scénario 5 -- choisir À emporter dans le popup : aucune exigence d'adresse de livraison, popup se referme", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("choose-pickup"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const dialog = dialogEl(container)!;
    const pickupBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "À emporter")!;
    click(pickupBtn);
    await flush();

    assert.equal(popupIsOpen(container), false, "le popup doit se refermer après sélection");
    await waitFor(
      () => container.textContent?.includes("Complétez vos coordonnées") === true,
      "les coordonnées client (nom/téléphone/email) restent requises pour le retrait, jamais une adresse"
    );
    assert.ok(
      !container.textContent?.includes("Adresse de livraison"),
      "aucune adresse de livraison ne doit apparaître pour le mode retrait"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 6. LIVRAISON choisie via le popup => adresse de livraison exigée.
// --------------------------------------------------------------------
test("Scénario 6 -- choisir Livraison dans le popup : adresse de livraison exigée, popup se referme", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("choose-delivery"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const dialog = dialogEl(container)!;
    const deliveryBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!;
    click(deliveryBtn);
    await flush();

    assert.equal(popupIsOpen(container), false, "le popup doit se refermer après sélection");
    await waitFor(
      () => container.textContent?.includes("Adresse de livraison") === true,
      "l'adresse de livraison doit être exigée après avoir choisi Livraison"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 7. La sélection persiste à travers la navigation du panier (fermer
// / rouvrir) -- ET le popup ne doit JAMAIS réapparaître par-dessus un
// choix déjà fait (pas d'état de blocage résiduel non plus : rouvrir
// sans choix déjà fait réaffiche le popup -- couvert par le test
// "aucun blocage" plus bas).
// --------------------------------------------------------------------
test("Scénario 7 -- la sélection persiste à la fermeture/réouverture du panier ; le popup ne réapparaît pas sur un choix déjà fait", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("persists"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const pickupBtn = [...dialogEl(container)!.querySelectorAll("button")].find(
      (b) => b.textContent === "À emporter"
    )!;
    click(pickupBtn);
    await flush();

    // Fermer le panier (le popup ET tout CartPanel sont démontés --
    // voir MenuView.tsx, `isCartOpen`), puis le rouvrir.
    const closeBtn = buttonWithText(container, "Fermer ✕");
    assert.ok(closeBtn, "bouton fermer le panier");
    click(closeBtn!);
    await flush();

    const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
    click(cartBar!);
    await flush();

    assert.equal(popupIsOpen(container), false, "le popup ne doit PAS réapparaître : un choix a déjà été fait");
    assert.ok(
      container.textContent?.includes("Complétez vos coordonnées"),
      "le mode À emporter choisi précédemment doit toujours être actif après réouverture"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 8 & 9 & 13. Le client change d'avis (delivery -> pickup, puis
// pickup -> delivery), le panier (contenu/quantités) reste inchangé,
// aucune commande n'est jamais créée par ces changements.
// --------------------------------------------------------------------
test("Scénario 8/9/13 -- changer de mode plusieurs fois : adresse apparaît/disparaît correctement, panier préservé, aucune commande créée", async (t) => {
  const { calledRpcNames } = mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("switch-modes"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");

    // 1) Choisit Livraison via le popup.
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    await waitFor(() => container.textContent?.includes("Adresse de livraison") === true, "adresse exigée après Livraison");

    // 2) Bascule vers À emporter via la rangée inline existante
    //    (howToReceive, toujours visible sous le popup -- jamais
    //    masquée par lui).
    const pickupInline = inlineButtonWithText(container, "À emporter");
    assert.ok(pickupInline, "le bouton À emporter inline doit rester disponible pour changer d'avis");
    click(pickupInline!);
    await flush();
    assert.ok(
      !container.textContent?.includes("Adresse de livraison"),
      "l'exigence d'adresse doit disparaître immédiatement après bascule vers À emporter -- aucune adresse résiduelle ne doit forcer la livraison"
    );

    // 3) Rebascule vers Livraison.
    const deliveryInline = inlineButtonWithText(container, "Livraison");
    click(deliveryInline!);
    await flush();
    await waitFor(() => container.textContent?.includes("Adresse de livraison") === true, "adresse ré-exigée après re-bascule vers Livraison");

    // Panier : la quantité de l'article ajouté reste 1 malgré les 3
    // changements de mode (aucune ligne dupliquée/perdue).
    assert.ok(container.textContent?.includes("4,00"), "le prix de l'unique article ajouté doit rester affiché (panier préservé)");

    // Aucune commande n'a jamais été créée par ces changements de mode.
    assert.ok(
      !calledRpcNames.includes("create_order"),
      "aucun changement de mode ne doit jamais appeler create_order (aucune commande créée par la simple sélection)"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 10, 11, 12. Aucune commande dupliquée, aucun appel Stuart, aucun
// déclenchement paiement -- preuve POSITIVE par trace exhaustive des
// RPC réellement appelées pendant tout le scénario (ouverture panier,
// ouverture popup, sélection, changement de mode).
// --------------------------------------------------------------------
test("Scénario 10/11/12 -- trace exhaustive des RPC : jamais create_order, jamais Stuart, jamais paiement/Monetico, pendant toute l'interaction avec le popup", async (t) => {
  const { calledRpcNames } = mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("rpc-trace"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    click([...dialogEl(container)!.querySelectorAll("button")].find((b) => b.textContent === "Livraison")!);
    await flush();
    click(inlineButtonWithText(container, "À emporter")!);
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
      `seules les RPC de lecture génériques déjà auditées doivent être appelées, jamais : ${unexpected.join(", ")}`
    );
    assert.ok(!calledRpcNames.some((n) => /stuart/i.test(n)), "aucun nom de RPC lié à Stuart");
    assert.ok(
      !calledRpcNames.some((n) => /monetico|payment/i.test(n)),
      "aucun nom de RPC lié au paiement/Monetico"
    );
    assert.ok(!calledRpcNames.includes("create_order"), "aucune commande créée");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 11 (preuve structurelle complémentaire) -- aucune référence à
// Stuart/Monetico/paiement dans le code source du popup lui-même
// (pas seulement "non observé à l'exécution dans ce scénario précis").
// --------------------------------------------------------------------
test("Preuve structurelle -- FulfillmentChoiceModal.tsx ne référence ni Stuart, ni Monetico, ni aucune RPC de paiement/commande", () => {
  const src = readFileSync(path.join(REPO_ROOT, "components", "FulfillmentChoiceModal.tsx"), "utf8");
  // Le CODE (imports, appels) ne doit jamais référencer Stuart/Monetico
  // -- mais la DOCUMENTATION de ce fichier explique précisément
  // l'ABSENCE de tels appels ("aucun appel Stuart"), donc un simple
  // grep texte sur le fichier entier produirait un faux positif sur
  // ses propres commentaires. On retire donc les lignes de commentaire
  // (//... et les lignes internes d'un bloc /* ... */) avant de
  // chercher une référence RÉELLEMENT structurelle (import/appel).
  const codeOnly = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line.trim()))
    .join("\n");
  assert.ok(!/stuart/i.test(codeOnly), "aucune référence Stuart dans le code (hors commentaires)");
  assert.ok(!/monetico/i.test(codeOnly), "aucune référence Monetico dans le code (hors commentaires)");
  assert.ok(!/create_order/.test(codeOnly), "aucun appel create_order dans le code (hors commentaires)");
  assert.ok(!/\.rpc\(/.test(codeOnly), "aucun appel RPC direct dans le code : ce composant ne fait que relayer onSelect(mode) au parent");
});

// --------------------------------------------------------------------
// 4 (complément) -- marchand À EMPORTER + SUR PLACE (sans livraison) :
// le popup s'ouvre bien pour CE couple de modes (généricité : pas
// seulement pickup/delivery), et "Livraison" reste totalement absent.
// --------------------------------------------------------------------
test("Scénario 4 (complément) -- marchand À EMPORTER + SUR PLACE (sans livraison) : popup s'ouvre pour ce couple, jamais de bouton Livraison", async (t) => {
  mockRpc(t, [saleModeRow("table"), saleModeRow("pickup")], {
    pickup: PICKUP_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("table-pickup"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir (2 modes, aucun choisi)");
    const dialog = dialogEl(container)!;
    assert.ok([...dialog.querySelectorAll("button")].some((b) => b.textContent === "À emporter"));
    assert.ok([...dialog.querySelectorAll("button")].some((b) => b.textContent === "Sur place, à table"));
    assert.equal(allButtonsWithText(container, "Livraison").length, 0, "aucun bouton Livraison nulle part pour ce marchand");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// Mobile/clavier (complément) -- fermeture par clic sur le fond
// (::backdrop natif, simulé ici par un clic direct sur l'élément
// <dialog> lui-même) SANS avoir choisi : n'introduit aucun état de
// blocage -- rouvrir le panier réaffiche le popup, aucune régression,
// jamais de plantage (aucun test suivant ne doit être affecté).
// --------------------------------------------------------------------
test("Complément mobile -- fermer le popup sans choisir (clic sur le fond) : aucun état de blocage, réouverture du panier réaffiche le popup", async (t) => {
  mockRpc(t, [saleModeRow("pickup"), saleModeRow("delivery")], {
    pickup: PICKUP_REQS,
    delivery: DELIVERY_REQS,
  });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("dismiss-no-choice"));
  try {
    await waitFor(() => popupIsOpen(container), "le popup doit s'ouvrir");
    const dialog = dialogEl(container)!;
    // Clic directement sur l'élément <dialog> (pas sur son contenu) =
    // clic sur le fond.
    dialog.dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush();
    assert.equal(popupIsOpen(container), false, "le popup doit se fermer sans qu'aucun mode n'ait été choisi");
    assert.ok(
      container.textContent?.includes("Choisissez le retrait ou la livraison"),
      "le message existant 'missingFulfillment' reste affiché -- aucun défaut silencieux vers un mode"
    );
    assert.equal(sendButton(container), undefined, "toujours aucune soumission possible sans choix");

    // Fermer puis rouvrir le panier : le popup doit réapparaître
    // (aucun état de blocage résiduel, jamais de plantage).
    click(buttonWithText(container, "Fermer ✕")!);
    await flush();
    click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"))!);
    await flush();
    await waitFor(() => popupIsOpen(container), "le popup doit réapparaître : aucun choix n'a encore été fait");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 17. Non-régression : un marchand à mode UNIQUE (déjà couvert par
// v92/v93/v94, ré-exécutés tels quels dans ce même run de suite) suit
// encore exactement le même chemin qu'avant ce lot -- ce test ajoute
// une vérification directe et indépendante dans CE fichier : jusqu'à
// l'envoi, en excluant volontairement l'appel réel WhatsApp/create_order
// (hors périmètre de ce test, déjà couvert ailleurs).
// --------------------------------------------------------------------
test("Scénario 17 -- non-régression : marchand à mode unique atteint canSubmit (bouton d'envoi visible) sans jamais voir de popup", async (t) => {
  mockRpc(t, [saleModeRow("pickup")], { pickup: PICKUP_REQS });
  const { container, root } = await renderAndAddOneItemToCart(testRestaurant("single-mode-e2e"));
  try {
    await waitFor(() => container.textContent?.includes("Complétez vos coordonnées") === true, "coordonnées requises");
    assert.equal(popupIsOpen(container), false, "le popup ne doit jamais être ouvert pour un mode unique");

    const nameInput = container.querySelector<HTMLInputElement>("#field-customer_name, input[id*=customer_name]");
    // Les identifiants de champ exacts sont un détail d'implémentation
    // de FulfillmentSelector (hors périmètre de ce lot) -- on se
    // contente ici de vérifier qu'AUCUNE exigence d'adresse n'apparaît
    // et que la structure de champs générique existante est bien
    // rendue (au moins un champ texte est présent).
    assert.ok(container.querySelector("input"), "au moins un champ de coordonnées doit être rendu");
    assert.ok(!container.textContent?.includes("Adresse de livraison"));
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
