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
// LOT 2B.4a.2 -- DYNAMIC CUSTOMER FORM RUNTIME SWITCH -- preuve
// comportementale RÉELLE (rendu React dans un vrai DOM, appels
// supabase.rpc réellement interceptés, interactions utilisateur
// réelles -- clics, saisie -- jamais une lecture du fichier source
// ni une supposition sur le comportement interne).
//
// Fixture volontairement choisie : établissement "sanaa-cookies", qui
// possède une configuration LEGACY réelle dans
// lib/restaurants-config.ts (settings.requiredCustomerFields =
// { pickup: ["name","phone","email"] (TOUS requis),
//   delivery: ["street","postalCode","city","phone","email"] }).
// Les réponses RPC mockées ci-dessous sont délibérément DIFFÉRENTES
// de cette configuration legacy (ex. pickup : phone/email en one_of,
// jamais les deux à la fois) -- si le comportement observé suit la
// réponse RPC plutôt que settings.requiredCustomerFields, c'est la
// preuve directe que le formulaire actif ne consulte plus JAMAIS ce
// chemin legacy (section 14, "piège legacy").
//
// Patron esbuild/jsdom/supabase déjà établi dans ce projet -- voir
// tests/v90-lot2b4a1-field-requirements-hook.dom.test.ts (mock du
// hook seul) et tests/v80-lot1a1-menuview-lang.dom.test.ts (montage
// réel de MenuView). Ce fichier combine les deux : montage réel de
// MenuView, avec supabase.rpc intercepté pour piloter à la fois
// usePublicFieldRequirements (LOT 2B.4a.1) ET usePublicDeliveryInfo
// (LOT 2B.3, inchangé par ce lot, réutilisé tel quel).
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
      // lib/supabase.ts DOIT rester externe -- même raison que
      // v90-lot2b4a1-field-requirements-hook.dom.test.ts : singleton
      // partagé, le mock (t.mock.method) n'a d'effet que si le code
      // testé importe EXACTEMENT la même instance de module.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v91-"));
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


/** Établissement de test réel : "sanaa-cookies" (settings LEGACY
 *  connues, voir en-tête de fichier), une seule catégorie, un seul
 *  produit sans option (aucune fenêtre de choix à gérer). */
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

const PICKUP_ONE_OF = [
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

/**
 * AU LAIT CRU (sale modes) : depuis l'activation de usePublicSaleModes
 * dans MenuView, les boutons de mode ("À emporter"/"Livraison") ne
 * sont plus dérivés de settings.allowedServiceModes (legacy, statique)
 * mais de get_restaurant_public_sale_modes -- cette RPC (et la lecture
 * de sale_mode_catalog qui l'enrichit, get_public_sale_modes via
 * lib/sale-modes-public.ts) doit donc être mockée ici, exactement
 * comme dans tests/v84-lot2b1.test.ts, pour que ces tests DOM
 * continuent de refléter la fixture "sanaa-cookies" (pickup+delivery,
 * voir lib/restaurants-config.ts) plutôt que de tomber en "error"
 * (aucune RPC mockée -> aucun mode disponible -> aucun bouton).
 */
const SANAA_SALE_MODE_ROWS = [
  {
    mode_code: "pickup",
    customer_text: null,
    pricing_mode: "free" as const,
    fixed_fee: null,
    free_threshold: null,
    delay_value: null,
    delay_unit: null,
  },
  {
    mode_code: "delivery",
    customer_text: null,
    pricing_mode: "free" as const,
    fixed_fee: null,
    free_threshold: null,
    delay_value: null,
    delay_unit: null,
  },
];

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];

/** Mock RPC générique : dispatch par nom de RPC, réponses de
 *  field_requirements pilotées par mode via `reqsByMode`, réponse de
 *  delivery_info fixe (`deliveryInfo`). Modes de vente disponibles
 *  mockés en dur sur pickup+delivery (fixture sanaa-cookies, voir
 *  ci-dessus) -- `sale_mode_catalog` (supabase.from) également mocké,
 *  requis par getPublicSaleModes(). Toute RPC inattendue échoue
 *  bruyamment (jamais un mock silencieusement permissif). */
function mockRpc(
  t: { mock: { method: Function } },
  reqsByMode: Record<string, unknown[]>,
  deliveryInfo: { delivery_zone_prefixes: string[]; delivery_min_items: number; delivery_area_label: string | null } | null
) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") {
      return { data: SANAA_SALE_MODE_ROWS, error: null };
    }
    if (name === "get_restaurant_public_field_requirements") {
      const data = reqsByMode[args.p_mode_code];
      if (data === undefined) {
        throw new Error(`mode inattendu dans le test : ${args.p_mode_code}`);
      }
      return { data, error: null };
    }
    if (name === "get_restaurant_public_delivery_info") {
      return { data: deliveryInfo ? [deliveryInfo] : [], error: null };
    }
    // MIS À JOUR EN LOT C (ACTIVE FRONTEND RUNTIME ROUTING) : le
    // fixture partagé de ce fichier (v91-lot2b4a2, hérité de LOT 2B.3
    // et antérieur) simule un établissement de type "Sanaa" -- SANS
    // AUCUNE règle publique de fulfillment migrée, exactement le cas
    // réel de tous les établissements existants à ce jour (mission LOT
    // C §2/§18/§29). AVANT ce lot, la RPC
    // get_restaurant_public_delivery_fulfillments n'était appelée par
    // AUCUN hook -- ce mock n'avait donc jamais besoin de la
    // connaître. LOT C l'active (usePublicDeliveryFulfillments) : ce
    // même mock doit désormais lui répondre, avec un tableau VIDE
    // (POSITIVEMENT connu, jamais "non résolu") -- exactement ce qui
    // fait passer resolveActiveDeliveryStatus (lib/delivery.ts) par le
    // pont de migration vers le chemin legacy
    // (getDeliveryStatusFromPublicInfo), préservant TOUS les
    // comportements déjà vérifiés par ce fichier (zone/minimum LOT
    // 2B.3), sans aucune régression -- voir aussi
    // tests/v101-fulfillment-routing-lot-c-active-runtime.test.ts pour
    // la preuve unitaire dédiée de ce même pont.
    if (name === "get_restaurant_public_delivery_fulfillments") {
      return { data: [], error: null };
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
// 1. Rendu dynamique + one_of + piège legacy (Click & Collect)
// --------------------------------------------------------------------

test("LOT 2B.4a.2 (Click&Collect, DOM réel) : rendu dynamique required + one_of, jamais les 3 champs legacy imposés -- piège legacy (settings.requiredCustomerFields.pickup=[name,phone,email] TOUS requis, ignoré)", async (t) => {
  mockRpc(t, { pickup: PICKUP_ONE_OF }, { delivery_zone_prefixes: ["75"], delivery_min_items: 1, delivery_area_label: "Paris" });
  const { container, root } = await renderAndAddOneItemToCart();

  try {
    selectServiceMode(container, "À emporter");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus après chargement des exigences");

    assert.ok(inputById(container, "customer_name"), "customer_name (required) doit être rendu");
    assert.ok(inputById(container, "phone"), "phone (membre du groupe one_of) doit être rendu");
    assert.ok(inputById(container, "email"), "email (membre du groupe one_of) doit être rendu");
    assert.equal(inputById(container, "street"), null, "delivery_address ne doit jamais être rendu en mode pickup");

    // Indication générique "au moins un des deux" -- jamais un nom de
    // groupe littéral ("contact") affiché à l'utilisateur.
    assert.ok(
      container.textContent?.includes("Renseignez au moins un des champs suivants"),
      "l'indication one_of générique doit être visible tant que ni phone ni email n'est rempli"
    );
    assert.ok(!container.textContent?.includes("\"contact\""));

    // "name seul" -- toujours invalide (section 14, Click&Collect).
    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    await flush();
    assert.ok(
      container.textContent?.includes("Complétez vos coordonnées"),
      "name seul, sans phone ni email, ne doit jamais permettre l'envoi (groupe one_of non satisfait)"
    );
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined);

    // "name + phone" -- valide (piège legacy : email legacy requis
    // n'est JAMAIS rempli ici, et pourtant la soumission est permise).
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush();
    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "name + phone (valide) doit suffire -- le groupe one_of est satisfait par phone seul, malgré settings.requiredCustomerFields.pickup legacy qui exigerait aussi email"
    );

    // "name + email" (phone vidé) -- également valide.
    setNativeValue(inputById(container, "phone")!, "");
    setNativeValue(inputById(container, "email")!, "yakout@example.fr");
    await flush();
    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "name + email (valide), phone vide, doit aussi suffire -- symétrique du cas précédent"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 2. Rendu dynamique delivery_address (3 sous-champs) + zone/minimum
//    (LOT 2B.3, non régressé) + composition "tout ou rien"
// --------------------------------------------------------------------

test("LOT 2B.4a.2 (Delivery, DOM réel) : delivery_address rendu en 3 sous-champs, composition tout-ou-rien, zone/minimum LOT 2B.3 non régressés", async (t) => {
  mockRpc(
    t,
    { delivery: DELIVERY_REQS },
    { delivery_zone_prefixes: ["92"], delivery_min_items: 2, delivery_area_label: "Hauts-de-Seine" }
  );
  const { container, root } = await renderAndAddOneItemToCart();

  try {
    selectServiceMode(container, "Livraison");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs delivery rendus après chargement des exigences");

    assert.ok(inputById(container, "customer_name"));
    assert.ok(inputById(container, "street"), "delivery_address doit être rendu en 3 sous-champs UI");
    assert.ok(inputById(container, "postalCode"));
    assert.ok(inputById(container, "city"));
    assert.ok(inputById(container, "phone"), "phone required en delivery");
    assert.ok(inputById(container, "email"), "email optional : rendu, mais jamais bloquant s'il reste vide");

    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush();

    // Adresse PARTIELLE (rue seule) -- doit rester "manquante" pour la
    // validation générique (composition tout-ou-rien, jamais une
    // simple concaténation qui produirait une chaîne non vide même à
    // moitié vide).
    setNativeValue(inputById(container, "street")!, "12 rue des Lilas");
    await flush();
    assert.equal(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      undefined,
      "une adresse partielle (rue seule) ne doit jamais suffire à activer l'envoi"
    );

    // Code postal hors zone (zone réelle : préfixe "92") -- toujours
    // bloqué, même adresse par ailleurs complète.
    setNativeValue(inputById(container, "postalCode")!, "75001");
    setNativeValue(inputById(container, "city")!, "Paris");
    await flush();
    assert.ok(
      container.textContent?.includes("Hors zone") || container.textContent?.toLowerCase().includes("livrons uniquement"),
      "un code postal hors zone doit être signalé (LOT 2B.3, non régressé)"
    );
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined);

    // Code postal DANS la zone (préfixe "92"), mais panier sous le
    // minimum (1 article, minimum=2) -- toujours bloqué.
    setNativeValue(inputById(container, "postalCode")!, "92100");
    setNativeValue(inputById(container, "city")!, "Boulogne-Billancourt");
    await flush();
    assert.equal(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      undefined,
      "sous le minimum d'articles (LOT 2B.3), l'envoi doit rester bloqué même adresse complète et dans la zone"
    );

    // Ajout d'un 2e article -- atteint le minimum -> éligible -> tous
    // les champs sont désormais valides -> envoi permis.
    const plusBtn = container.querySelector('button[aria-label="Augmenter la quantité"]') as HTMLButtonElement | null;
    assert.ok(plusBtn, "le bouton d'incrément de quantité doit être présent");
    click(plusBtn!);
    await flush();
    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "adresse complète + dans la zone + minimum atteint + phone valide -> l'envoi doit être permis"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 3. Fail-closed intégré à MenuView (loading puis error) -- jamais de
//    soumission tentée tant que les exigences ne sont pas résolues.
// --------------------------------------------------------------------

test("LOT 2B.4a.2 (fail-closed, DOM réel) : pendant le chargement des exigences, aucun champ n'est rendu et l'envoi reste bloqué ; après erreur, toujours bloqué, jamais de crash", async (t) => {
  let resolveReqs: (v: { data: unknown; error: null }) => void;
  const pending = new Promise((resolve) => {
    resolveReqs = resolve;
  });
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_restaurant_public_sale_modes") return { data: SANAA_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") return pending;
    if (name === "get_restaurant_public_delivery_info")
      return { data: [{ delivery_zone_prefixes: ["75"], delivery_min_items: 1, delivery_area_label: "Paris" }], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderAndAddOneItemToCart();
  try {
    selectServiceMode(container, "À emporter");
    await flush();

    assert.equal(inputById(container, "customer_name"), null, "aucun champ ne doit être rendu tant que les exigences sont en 'loading' (fail-closed)");
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined);

    resolveReqs!({ data: null as unknown as never, error: new Error("panne réseau simulée") } as any);
    // Le mock ci-dessus simule directement une réponse d'erreur RPC
    // (error non-null) plutôt qu'un rejet de promesse, pour rester
    // fidèle au contrat réel de supabase-js (jamais un throw), déjà
    // couvert différemment par v90-lot2b4a1-field-requirements-hook.dom.test.ts.
    await flush(50);

    assert.equal(inputById(container, "customer_name"), null, "toujours aucun champ après une erreur (fail-closed, jamais un repli legacy)");
    assert.equal(buttonWithText(container, "Enregistrer et continuer sur WhatsApp"), undefined, "l'envoi doit rester bloqué après une erreur de chargement des exigences");
    assert.ok(container.textContent, "le composant ne doit jamais planter");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 4. loaded([]) -- réponse métier valide, jamais confondue avec
//    loading/error : l'envoi devient possible immédiatement, sans
//    aucun champ à remplir.
// --------------------------------------------------------------------

test("LOT 2B.4a.2 : loaded([]) -- aucune exigence pour ce mode, aucun champ rendu, envoi immédiatement permis (distinct de loading/error)", async (t) => {
  mockRpc(t, { pickup: [] }, { delivery_zone_prefixes: ["75"], delivery_min_items: 1, delivery_area_label: "Paris" });
  const { container, root } = await renderAndAddOneItemToCart();

  try {
    selectServiceMode(container, "À emporter");
    await waitFor(
      () => buttonWithText(container, "Enregistrer et continuer sur WhatsApp") !== undefined,
      "envoi permis dès que loaded([]) est résolu, sans aucune saisie"
    );
    assert.equal(inputById(container, "customer_name"), null, "aucun champ ne doit être rendu quand aucune exigence n'existe pour ce mode");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 5. one_of : une saisie GARBAGE (non vide mais invalide) sur un
//    membre du groupe doit rester bloquante, MÊME si un autre membre
//    du même groupe satisfait déjà la présence -- jamais d'acceptation
//    silencieuse d'une valeur mal formée sous prétexte qu'un champ
//    frère suffirait à la validation de présence générique.
// --------------------------------------------------------------------

test("LOT 2B.4a.2 (one_of, DOM réel) : email non vide mais invalide reste bloquant même si phone (valide) satisfait déjà le groupe one_of", async (t) => {
  mockRpc(t, { pickup: PICKUP_ONE_OF }, { delivery_zone_prefixes: ["75"], delivery_min_items: 1, delivery_area_label: "Paris" });
  const { container, root } = await renderAndAddOneItemToCart();

  try {
    selectServiceMode(container, "À emporter");
    await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");

    setNativeValue(inputById(container, "customer_name")!, "Yakout");
    setNativeValue(inputById(container, "phone")!, "0612345678");
    await flush();
    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "name + phone valide doit suffire (groupe one_of satisfait par phone)"
    );

    // email non vide mais invalide -- doit redevenir bloquant, malgré
    // phone déjà valide.
    setNativeValue(inputById(container, "email")!, "pas-un-email");
    await flush();
    assert.equal(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      undefined,
      "une saisie email invalide ne doit JAMAIS être silencieusement acceptée, même si phone seul suffirait à la présence"
    );
    assert.ok(
      container.textContent?.includes("Adresse e-mail invalide"),
      "l'erreur de format doit être visible sur le champ email fautif"
    );

    // Correction du format -- redevient valide.
    setNativeValue(inputById(container, "email")!, "yakout@example.fr");
    await flush();
    assert.ok(
      buttonWithText(container, "Enregistrer et continuer sur WhatsApp"),
      "une fois l'email corrigé (ou vidé), l'envoi redevient possible"
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
