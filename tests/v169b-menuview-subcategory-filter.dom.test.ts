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
// CUSTOMER MENU / SUBCATEGORY FILTER NAVIGATION v1 — rendu RÉEL de
// MenuView (jsdom), même technique/patron que
// tests/v138c-menuview-subcategories.dom.test.ts (bundling esbuild réel
// + alias "@/", pas une réimplémentation).
//
// Couvre les scénarios obligatoires §16 : A, B, C, D, E, F, G, H, K
// (partiel : classe de défilement présente), L (partiel : le libellé
// localisé transite correctement via lib/i18n.ts). I, J, M, N, O sont
// déjà couverts par des lots antérieurs non affectés par ce changement
// (filtrage de disponibilité en amont dans lib/services/restaurant.ts,
// isolation tenant au niveau data-fetch, panier indexé par item.id
// inchangé, navigation de catégorie inchangée) — non re-testés ici.
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
      return { path: candidate ?? base };
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseConfig() {
  return {
    restaurant_id: "r1",
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
  };
}

function baseRestaurant(categories: unknown[]) {
  return {
    id: "r1",
    name: "Fromagerie (test)",
    slug: "fromagerie-test",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: baseConfig(),
    categories,
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function filterPill(container: Element, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("[data-subcategory-filter-option]")].find(
      (b) => b.textContent === label
    ) as HTMLButtonElement | undefined
  ) ?? null;
}

// Fixture Fromages : reproduit le §15 du mandat -- 5 sous-catégories,
// 7 produits A-G (A,B=Raclette ; C=Fromage à la truffe ; D=Pâtes
// dures ; E=Pâtes molles ; F=Chèvres ; G=direct/aucune sous-catégorie).
function fromagesCategory(extra: Record<string, unknown> = {}) {
  return {
    id: "cat-fromages",
    restaurant_id: "r1",
    name: "Fromages",
    display_order: 1,
    is_active: true,
    menu_items: [
      { id: "G", category_id: "cat-fromages", subcategory_id: null, subcategory_name: null, name: "G-Direct", description: null, short_description: null, price: 3, image_url: null, display_order: 1, is_available: true },
      { id: "A", category_id: "cat-fromages", subcategory_id: "sub-raclette", subcategory_name: "Raclette", subcategory_display_order: 1, name: "A-Raclette1", description: null, short_description: null, price: 4, image_url: null, display_order: 1, is_available: true },
      { id: "B", category_id: "cat-fromages", subcategory_id: "sub-raclette", subcategory_name: "Raclette", subcategory_display_order: 1, name: "B-Raclette2", description: null, short_description: null, price: 4.5, image_url: null, display_order: 2, is_available: true },
      { id: "C", category_id: "cat-fromages", subcategory_id: "sub-truffe", subcategory_name: "Fromage à la truffe", subcategory_display_order: 2, name: "C-Truffe", description: null, short_description: null, price: 8, image_url: null, display_order: 1, is_available: true },
      { id: "D", category_id: "cat-fromages", subcategory_id: "sub-pates-dures", subcategory_name: "Pâtes dures", subcategory_display_order: 3, name: "D-PatesDures", description: null, short_description: null, price: 5, image_url: null, display_order: 1, is_available: true },
      { id: "E", category_id: "cat-fromages", subcategory_id: "sub-pates-molles", subcategory_name: "Pâtes molles", subcategory_display_order: 4, name: "E-PatesMolles", description: null, short_description: null, price: 5, image_url: null, display_order: 1, is_available: true },
      { id: "F", category_id: "cat-fromages", subcategory_id: "sub-chevres", subcategory_name: "Chèvres", subcategory_display_order: 5, name: "F-Chevres", description: null, short_description: null, price: 5, image_url: null, display_order: 1, is_available: true },
    ],
    ...extra,
  };
}

function boissonsCategory() {
  return {
    id: "cat-boissons",
    restaurant_id: "r1",
    name: "Boissons",
    display_order: 2,
    is_active: true,
    menu_items: [
      { id: "eau", category_id: "cat-boissons", subcategory_id: null, subcategory_name: null, name: "Eau", description: null, short_description: null, price: 2, image_url: null, display_order: 1, is_available: true },
      { id: "jus", category_id: "cat-boissons", subcategory_id: null, subcategory_name: null, name: "Jus", description: null, short_description: null, price: 3, image_url: null, display_order: 2, is_available: true },
    ],
  };
}

// --------------------------------------------------------------
// Scénario A : catégorie SANS sous-catégorie -- aucune barre de filtre,
// rendu historique inchangé.
// --------------------------------------------------------------
test("Scénario A : catégorie SANS sous-catégorie -- aucune barre de filtre affichée, rendu historique inchangé", async () => {
  const restaurant = baseRestaurant([boissonsCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();
    assert.equal(container.querySelectorAll("[data-subcategory-filter-option]").length, 0);
    assert.ok(container.textContent?.includes("Eau"));
    assert.ok(container.textContent?.includes("Jus"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// Scénarios B, C, D : catégorie AVEC plusieurs sous-catégories -- la
// barre de filtre est visible, "Tous" est sélectionné par défaut, et
// tous les produits de la catégorie (directs + sous-catégorisés) sont
// visibles par défaut.
// --------------------------------------------------------------
test("Scénarios B+C+D : catégorie Fromages (5 sous-catégories) -- barre de filtre visible, 'Tous' sélectionné par défaut (aria-pressed=true), les 7 produits A-G visibles", async () => {
  const restaurant = baseRestaurant([fromagesCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();

    const pillLabels = [...container.querySelectorAll("[data-subcategory-filter-option]")].map((b) => b.textContent);
    assert.deepEqual(pillLabels, ["Tous", "Raclette", "Fromage à la truffe", "Pâtes dures", "Pâtes molles", "Chèvres"]);

    const allPill = filterPill(container, "Tous");
    assert.ok(allPill, "la pilule 'Tous' doit être présente");
    assert.equal(allPill!.getAttribute("aria-pressed"), "true", "'Tous' doit être sélectionné par défaut");

    for (const name of ["G-Direct", "A-Raclette1", "B-Raclette2", "C-Truffe", "D-PatesDures", "E-PatesMolles", "F-Chevres"]) {
      assert.ok(container.textContent?.includes(name), `${name} doit être visible par défaut (Tous)`);
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// Scénarios E, F, G : sélection d'une sous-catégorie précise -- seuls
// ses produits apparaissent (jamais les produits directs), puis retour
// à "Tous" restaure l'ensemble.
// --------------------------------------------------------------
test("Scénarios E+F+G : clic sur 'Raclette' -- uniquement A et B visibles (ni G le produit direct, ni les autres sous-catégories) ; reclic sur 'Tous' restaure les 7 produits", async () => {
  const restaurant = baseRestaurant([fromagesCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();

    const racletteBtn = filterPill(container, "Raclette");
    assert.ok(racletteBtn, "la pilule 'Raclette' doit être présente");
    click(racletteBtn!);
    await flush();

    assert.equal(racletteBtn!.getAttribute("aria-pressed"), "true", "Raclette doit devenir la sélection active");
    assert.equal(filterPill(container, "Tous")!.getAttribute("aria-pressed"), "false", "'Tous' ne doit plus être actif");

    assert.ok(container.textContent?.includes("A-Raclette1"));
    assert.ok(container.textContent?.includes("B-Raclette2"));
    assert.ok(!container.textContent?.includes("G-Direct"), "le produit SANS sous-catégorie ne doit PAS apparaître sous un filtre précis (scénario F)");
    assert.ok(!container.textContent?.includes("C-Truffe"));
    assert.ok(!container.textContent?.includes("D-PatesDures"));
    assert.ok(!container.textContent?.includes("E-PatesMolles"));
    assert.ok(!container.textContent?.includes("F-Chevres"));

    // Reclic sur "Tous" : retour immédiat aux 7 produits (scénario G).
    click(filterPill(container, "Tous")!);
    await flush();
    for (const name of ["G-Direct", "A-Raclette1", "B-Raclette2", "C-Truffe", "D-PatesDures", "E-PatesMolles", "F-Chevres"]) {
      assert.ok(container.textContent?.includes(name), `${name} doit réapparaître après retour à Tous`);
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

test("Scénario F : produit sans sous-catégorie (G) -- visible sous 'Tous', invisible sous n'importe quel filtre précis, y compris en changeant de filtre plusieurs fois", async () => {
  const restaurant = baseRestaurant([fromagesCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();
    assert.ok(container.textContent?.includes("G-Direct"), "visible sous Tous par défaut");

    click(filterPill(container, "Chèvres")!);
    await flush();
    assert.ok(!container.textContent?.includes("G-Direct"), "invisible sous Chèvres");
    assert.ok(container.textContent?.includes("F-Chevres"));

    click(filterPill(container, "Pâtes dures")!);
    await flush();
    assert.ok(!container.textContent?.includes("G-Direct"), "invisible sous Pâtes dures");
    assert.ok(container.textContent?.includes("D-PatesDures"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// Scénario H : changer de catégorie ne doit JAMAIS laisser un filtre
// de sous-catégorie "fuiter" vers une autre catégorie.
// --------------------------------------------------------------
test("Scénario H : sélectionner 'Chèvres' dans Fromages puis basculer vers Boissons (sans sous-catégorie) -- aucune contamination ; revenir à Fromages réaffiche 'Tous' sélectionné (pas 'Chèvres')", async () => {
  const restaurant = baseRestaurant([fromagesCategory(), boissonsCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();

    click(filterPill(container, "Chèvres")!);
    await flush();
    assert.ok(container.textContent?.includes("F-Chevres"));
    assert.ok(!container.textContent?.includes("G-Direct"));

    // Bascule vers Boissons via la navigation de catégorie existante.
    const categoryButtons = [...container.querySelectorAll("nav button")];
    const boissonsBtn = categoryButtons.find((b) => b.textContent?.includes("Boissons"));
    assert.ok(boissonsBtn, "le bouton de catégorie 'Boissons' doit être présent");
    click(boissonsBtn!);
    await flush();

    assert.equal(container.querySelectorAll("[data-subcategory-filter-option]").length, 0, "Boissons n'a pas de sous-catégorie -- aucune barre de filtre, aucune contamination visible");
    assert.ok(container.textContent?.includes("Eau"));
    assert.ok(container.textContent?.includes("Jus"));

    // Retour à Fromages : le filtre doit être réinitialisé à "Tous",
    // jamais rester sur "Chèvres" (mandat scénario H).
    const fromagesBtn = categoryButtons.find((b) => b.textContent?.includes("Fromages"));
    click(fromagesBtn!);
    await flush();

    assert.equal(filterPill(container, "Tous")!.getAttribute("aria-pressed"), "true", "'Tous' doit être de nouveau sélectionné par défaut, pas 'Chèvres'");
    assert.ok(container.textContent?.includes("G-Direct"), "tous les produits de Fromages doivent être visibles de nouveau");
    assert.ok(container.textContent?.includes("F-Chevres"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// CUSTOMER MENU / SUBCATEGORY FILTER v1.1 -- remédiation ONE-SUBCATEGORY
// CASE. Règle corrigée : la barre de filtre est masquée UNIQUEMENT
// quand il n'existe ZÉRO sous-catégorie réelle -- jamais de cas
// particulier pour "une seule sous-catégorie couvrant tout". Les 4
// scénarios requis par le mandat de remédiation, dans l'ordre demandé.
// --------------------------------------------------------------

// 1. Zéro sous-catégorie réelle -- aucune barre de filtre (rendu
//    historique inchangé, scénario A -- déjà couvert par le test
//    "Scénario A" ci-dessus ; répété ici sous le nom exact de la
//    remédiation pour une traçabilité directe avec le mandat v1.1).
test("Remédiation ONE-SUBCATEGORY CASE — 1. zéro sous-catégorie réelle -- aucune barre de filtre affichée", async () => {
  const restaurant = baseRestaurant([boissonsCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();
    assert.equal(
      container.querySelectorAll("[data-subcategory-filter-option]").length,
      0,
      "0 sous-catégorie réelle -- la barre de filtre doit rester entièrement masquée"
    );
    assert.ok(container.textContent?.includes("Eau"));
    assert.ok(container.textContent?.includes("Jus"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// 2. Exactement UNE sous-catégorie réelle + des produits directs
//    (subcategory_id null) dans la même catégorie -- "Tous" + la
//    sous-catégorie doivent être visibles (2 pilules).
test("Remédiation ONE-SUBCATEGORY CASE — 2. UNE sous-catégorie réelle + produits directs -- 'Tous' + la sous-catégorie sont affichés", async () => {
  const restaurant = baseRestaurant([
    {
      id: "cat-fromages-mixte",
      restaurant_id: "r1",
      name: "Fromages",
      display_order: 1,
      is_active: true,
      menu_items: [
        { id: "plateau", category_id: "cat-fromages-mixte", subcategory_id: null, subcategory_name: null, name: "Plateau découverte", description: null, short_description: null, price: 9, image_url: null, display_order: 1, is_available: true },
        { id: "raclette-fermiere", category_id: "cat-fromages-mixte", subcategory_id: "sub-raclette", subcategory_name: "Raclette", subcategory_display_order: 1, name: "Raclette fermière", description: null, short_description: null, price: 5, image_url: null, display_order: 1, is_available: true },
        { id: "raclette-fumee", category_id: "cat-fromages-mixte", subcategory_id: "sub-raclette", subcategory_name: "Raclette", subcategory_display_order: 1, name: "Raclette fumée", description: null, short_description: null, price: 5.5, image_url: null, display_order: 2, is_available: true },
      ],
    },
  ]);
  const { container, root } = render(restaurant);
  try {
    await flush();

    const pillLabels = [...container.querySelectorAll("[data-subcategory-filter-option]")].map((b) => b.textContent);
    assert.deepEqual(pillLabels, ["Tous", "Raclette"], "1 sous-catégorie réelle -- la barre doit apparaître avec Tous + Raclette, jamais masquée");

    // Défaut (Tous) : les 3 produits visibles, y compris le produit direct.
    assert.ok(container.textContent?.includes("Plateau découverte"));
    assert.ok(container.textContent?.includes("Raclette fermière"));
    assert.ok(container.textContent?.includes("Raclette fumée"));

    // Sélection de Raclette : seuls les 2 produits de la sous-catégorie,
    // jamais le produit direct (comportement scénario F, inchangé).
    click(filterPill(container, "Raclette")!);
    await flush();
    assert.ok(!container.textContent?.includes("Plateau découverte"), "le produit direct ne doit pas apparaître sous un filtre précis");
    assert.ok(container.textContent?.includes("Raclette fermière"));
    assert.ok(container.textContent?.includes("Raclette fumée"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// 3. Exactement UNE sous-catégorie réelle, et TOUS les produits de la
//    catégorie lui appartiennent (aucun produit direct) -- "Tous" + la
//    sous-catégorie doivent QUAND MÊME être affichés (c'est exactement
//    le cas que l'ancienne règle `options.length < 2` masquait à tort).
test("Remédiation ONE-SUBCATEGORY CASE — 3. UNE sous-catégorie réelle couvrant TOUS les produits -- 'Tous' + la sous-catégorie sont affichés quand même (ancien bug corrigé)", async () => {
  const restaurant = baseRestaurant([
    {
      id: "cat-boissons-chaudes",
      restaurant_id: "r1",
      name: "Boissons chaudes",
      display_order: 1,
      is_active: true,
      menu_items: [
        { id: "cafe", category_id: "cat-boissons-chaudes", subcategory_id: "sub-cafes", subcategory_name: "Cafés", subcategory_display_order: 1, name: "Café", description: null, short_description: null, price: 2, image_url: null, display_order: 1, is_available: true },
        { id: "expresso", category_id: "cat-boissons-chaudes", subcategory_id: "sub-cafes", subcategory_name: "Cafés", subcategory_display_order: 1, name: "Expresso", description: null, short_description: null, price: 2.5, image_url: null, display_order: 2, is_available: true },
      ],
    },
  ]);
  const { container, root } = render(restaurant);
  try {
    await flush();

    const pillLabels = [...container.querySelectorAll("[data-subcategory-filter-option]")].map((b) => b.textContent);
    assert.deepEqual(pillLabels, ["Tous", "Cafés"], "même quand une unique sous-catégorie couvre 100% des produits, la barre doit rester visible (Tous + Cafés) -- JAMAIS masquée dans ce cas");

    assert.equal(filterPill(container, "Tous")!.getAttribute("aria-pressed"), "true", "Tous reste sélectionné par défaut");
    assert.ok(container.textContent?.includes("Café"));
    assert.ok(container.textContent?.includes("Expresso"));

    click(filterPill(container, "Cafés")!);
    await flush();
    assert.equal(filterPill(container, "Cafés")!.getAttribute("aria-pressed"), "true");
    assert.ok(container.textContent?.includes("Café"));
    assert.ok(container.textContent?.includes("Expresso"), "filtrer sur l'unique sous-catégorie doit continuer d'afficher ses produits (tous les produits de la catégorie ici)");
  } finally {
    root.unmount();
    container.remove();
  }
});

// 4. Plusieurs sous-catégories réelles -- comportement EXISTANT
//    inchangé (non-régression explicite demandée par le mandat de
//    remédiation) : réutilise directement la fixture Fromages (5
//    sous-catégories) déjà couverte par les scénarios B+C+D ci-dessus.
test("Remédiation ONE-SUBCATEGORY CASE — 4. PLUSIEURS sous-catégories réelles -- comportement existant inchangé (non-régression)", async () => {
  const restaurant = baseRestaurant([fromagesCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();
    const pillLabels = [...container.querySelectorAll("[data-subcategory-filter-option]")].map((b) => b.textContent);
    assert.deepEqual(pillLabels, ["Tous", "Raclette", "Fromage à la truffe", "Pâtes dures", "Pâtes molles", "Chèvres"]);
    assert.equal(filterPill(container, "Tous")!.getAttribute("aria-pressed"), "true");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// CUSTOMER MENU / SUBCATEGORY FILTER WRAP v1 -- remplace le défilement
// horizontal par un empilement en lignes multiples (flex-wrap).
// Scénarios D et E du mandat de remédiation. La barre de filtre est
// localisée précisément via son `<nav aria-label="Tous">` (jamais tout
// le `container`, qui inclut aussi CategoryNav.tsx -- un AUTRE composant,
// explicitement hors périmètre de ce lot, qui continue lui-même
// d'utiliser overflow-x-auto pour SA propre navigation de catégories ;
// vérifier ".overflow-x-auto" sur tout le container donnerait un faux
// positif en comptant le défilement de CategoryNav).
//
// jsdom ne dispose pas d'un véritable moteur de mise en page CSS : il ne
// peut pas calculer où une pilule "tombe" réellement à la ligne
// suivante (getBoundingClientRect renvoie toujours des zéros). Les
// scénarios I (mobile ~360px, plusieurs lignes) et J (desktop ~1280px,
// une seule ligne compacte) du mandat exigent donc une vérification en
// navigateur réel (Playwright, capture des coordonnées Y des pilules +
// captures d'écran) -- fournie séparément comme preuve visuelle du
// paquet, et non par ce fichier de tests unitaires jsdom.
// --------------------------------------------------------------

function subcategoryFilterNav(container: Element): Element | null {
  return container.querySelector('nav[aria-label="Tous"]');
}

test("Scénario D : la barre de filtre utilise un conteneur flex-wrap (empilement en lignes multiples), sans hauteur fixe imposée", async () => {
  const restaurant = baseRestaurant([fromagesCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();
    const nav = subcategoryFilterNav(container);
    assert.ok(nav, "le <nav> de la barre de filtre doit être présent");

    const wrappers = [...nav!.querySelectorAll(".flex-wrap")];
    assert.ok(wrappers.length >= 1, "un conteneur flex-wrap doit envelopper les pilules de filtre");

    // Aucune hauteur fixe (h-10, max-h-64, etc. -- valeur numérique ou
    // arbitraire) ne doit être imposée au conteneur -- le nombre de
    // lignes doit rester entièrement libre, déterminé par le nombre de
    // pilules et la largeur disponible.
    const fixedHeightPattern = /(^|\s)(h|max-h)-(\d|\[)/;
    for (const el of [nav!, ...nav!.querySelectorAll("*")]) {
      const cls = el.getAttribute("class") ?? "";
      assert.ok(
        !fixedHeightPattern.test(cls),
        `aucune classe de hauteur fixe attendue, trouvé dans "${cls}"`
      );
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

test("Scénario E : aucune dépendance au défilement horizontal (overflow-x-auto / scrollbar-none / min-w-full retirés de la barre de filtre)", async () => {
  const restaurant = baseRestaurant([fromagesCategory()]);
  const { container, root } = render(restaurant);
  try {
    await flush();
    const nav = subcategoryFilterNav(container);
    assert.ok(nav, "le <nav> de la barre de filtre doit être présent");

    assert.equal(nav!.querySelectorAll(".overflow-x-auto").length, 0, "la barre de filtre ne doit plus dépendre d'un défilement horizontal");
    assert.equal(nav!.querySelectorAll(".scrollbar-none").length, 0, "classe de défilement obsolète, ne doit plus apparaître dans la barre de filtre");
    assert.equal(nav!.querySelectorAll(".min-w-full").length, 0, "min-w-full forçait l'ancien défilement horizontal, ne doit plus apparaître");

    // Preuve de scoping : le <nav> de la barre de filtre (aria-label
    // "Tous") est bien distinct du <nav> de CategoryNav.tsx (autre
    // composant, hors périmètre de ce lot, qui n'a pas d'aria-label) --
    // les assertions ci-dessus portent uniquement sur la barre de
    // filtre, jamais sur tout le DOM de la page.
    const categoryNavElement = container.querySelector("nav:not([aria-label])");
    assert.ok(categoryNavElement, "CategoryNav.tsx doit toujours être présent, inchangé, hors périmètre de ce lot");
    assert.notEqual(categoryNavElement, nav, "le <nav> de CategoryNav.tsx doit rester distinct du <nav> de la barre de filtre");
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
