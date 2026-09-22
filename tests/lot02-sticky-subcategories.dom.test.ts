import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// LOT 02 -- STICKY SUBCATEGORIES -- rendu RÉEL de MenuView (jsdom), même
// technique que tests/v169b-menuview-subcategory-filter.dom.test.ts
// (bundling esbuild réel + alias "@/").
//
// Couverture exécutable obligatoire du mandat (cycle 4) :
//   1. activation sticky : plusieurs sous-catégories ET liste plus haute
//      que l'écran -- jamais couplée au nombre de produits ;
//   2. exactitude de l'état actif, AUCUN défilement forcé à la sélection,
//      re-mesure au redimensionnement ;
//   3. catalogue court / une seule / aucune sous-catégorie inchangé ;
//   4. contrat de non-chevauchement + une seule ligne sur mobile ;
//   5. opérabilité clavier/tactile et état accessible ;
//   6. non-régression filtre/navigation (v169b/v138c restent exécutés
//      tels quels dans la suite complète ; rappel ciblé ici en mode
//      sticky).
//
// jsdom n'a pas de moteur de mise en page : la hauteur de la liste de
// la catégorie active (nombre de cartes produit x hauteur simulée d'une
// carte) et la hauteur du viewport sont simulées ci-dessous ; les autres
// positions en surchargeant getBoundingClientRect() par élément.
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

// --------------------------------------------------------------
// Mise en page simulée
// --------------------------------------------------------------
const layout = { viewport: 700, cardPx: 100 };
beforeEach(() => {
  layout.viewport = 700;
  layout.cardPx = 100;
});
Object.defineProperty(window, "innerHeight", {
  configurable: true,
  get: () => layout.viewport,
});

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 360, width: 360, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
}

/** Liste des produits de la catégorie active : div juste sous la
 *  <section>, contenant un bloc par groupe (titre h3 + cartes). */
function isCatalogueList(el: Element): boolean {
  return el.parentElement?.tagName === "SECTION" && el.classList.contains("space-y-6");
}

const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (isCatalogueList(this)) {
    const cards = this.querySelectorAll(":scope > div > :not(h3)").length;
    return rect(200, 200 + cards * layout.cardPx);
  }
  return originalRect.call(this);
};

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseRestaurant(categories: unknown[]) {
  return {
    id: "r1",
    name: "Fromagerie (test)",
    slug: "fromagerie-test",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
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
    },
    categories,
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

function product(catId: string, id: string, sub: { id: string; name: string; order: number } | null, order: number) {
  return {
    id,
    category_id: catId,
    subcategory_id: sub?.id ?? null,
    subcategory_name: sub?.name ?? null,
    subcategory_display_order: sub?.order,
    name: id,
    description: null,
    short_description: null,
    price: 4,
    image_url: null,
    display_order: order,
    is_available: true,
  };
}

const RACLETTE = { id: "sub-raclette", name: "Raclette", order: 1 };
const CHEVRES = { id: "sub-chevres", name: "Chèvres", order: 2 };

/** 10 produits, 2 sous-catégories + produits directs. */
function longCategory() {
  const c = "cat-long";
  return {
    id: c,
    restaurant_id: "r1",
    name: "Fromages",
    display_order: 1,
    is_active: true,
    menu_items: [
      product(c, "Direct-1", null, 1),
      product(c, "Direct-2", null, 2),
      product(c, "Raclette-1", RACLETTE, 1),
      product(c, "Raclette-2", RACLETTE, 2),
      product(c, "Raclette-3", RACLETTE, 3),
      product(c, "Raclette-4", RACLETTE, 4),
      product(c, "Chevre-1", CHEVRES, 1),
      product(c, "Chevre-2", CHEVRES, 2),
      product(c, "Chevre-3", CHEVRES, 3),
      product(c, "Chevre-4", CHEVRES, 4),
    ],
  };
}

/** 3 produits seulement, mais 2 sous-catégories. */
function fewProductsCategory() {
  const c = "cat-few";
  return {
    id: c,
    restaurant_id: "r1",
    name: "Plateaux",
    display_order: 4,
    is_active: true,
    menu_items: [
      product(c, "Plateau-Raclette", RACLETTE, 1),
      product(c, "Plateau-Chevre-1", CHEVRES, 1),
      product(c, "Plateau-Chevre-2", CHEVRES, 2),
    ],
  };
}

/** 3 produits, UNE seule sous-catégorie. */
function shortCategory() {
  const c = "cat-short";
  return {
    id: c,
    restaurant_id: "r1",
    name: "Desserts",
    display_order: 2,
    is_active: true,
    menu_items: [
      product(c, "Tarte", null, 1),
      product(c, "Glace-1", { id: "sub-glaces", name: "Glaces", order: 1 }, 1),
      product(c, "Glace-2", { id: "sub-glaces", name: "Glaces", order: 1 }, 2),
    ],
  };
}

/** 12 produits, UNE seule sous-catégorie. */
function longSingleSubcategory() {
  const c = "cat-single";
  const sub = { id: "sub-vins", name: "Vins", order: 1 };
  return {
    id: c,
    restaurant_id: "r1",
    name: "Cave",
    display_order: 5,
    is_active: true,
    menu_items: Array.from({ length: 12 }, (_, i) => product(c, `Vin-${i}`, sub, i)),
  };
}

/** 10 produits SANS aucune sous-catégorie. */
function longFlatCategory() {
  const c = "cat-flat";
  return {
    id: c,
    restaurant_id: "r1",
    name: "Boissons",
    display_order: 3,
    is_active: true,
    menu_items: Array.from({ length: 10 }, (_, i) => product(c, `Boisson-${i}`, null, i)),
  };
}

async function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function filterNav(container: Element): HTMLElement | null {
  return container.querySelector('nav[aria-label="Tous"]');
}

function isSticky(container: Element): boolean {
  return filterNav(container)?.getAttribute("data-subcategory-filter-sticky") === "true";
}

function pill(container: Element, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("[data-subcategory-filter-option]")].find(
    (b) => b.textContent === label
  ) as HTMLButtonElement | undefined;
  assert.ok(found, `pilule '${label}' attendue`);
  return found!;
}

function pressed(container: Element): string[] {
  return [...container.querySelectorAll('[data-subcategory-filter-option][aria-pressed="true"]')].map(
    (b) => b.textContent ?? ""
  );
}

function categoryButton(container: Element, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("nav:not([aria-label]) button")].find((b) =>
    b.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;
  assert.ok(btn, `bouton de catégorie '${label}' attendu`);
  return btn!;
}

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** CSS RÉELLEMENT généré par Tailwind (config du projet) pour une liste
 *  de classes -- une classe présente dans le DOM mais sans règle générée
 *  (ex. "bg-crema/95" sur une couleur var()) n'y apparaît pas. */
async function compileUtilities(classList: string[]): Promise<string> {
  const { default: postcss } = await import("postcss");
  const { default: tailwindcss } = await import("tailwindcss");
  const { default: config } = await import(pathToFileURL(path.join(REPO_ROOT, "tailwind.config.ts")).href);
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: classList.join(" "), extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

/** Déclarations de la règle générée pour une classe simple. */
function ruleFor(css: string, className: string): string | null {
  const selector = "." + className.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  const start = css.indexOf(selector + " {");
  if (start === -1) return null;
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start)).trim();
}

/** Espionne tout défilement programmatique de la page. */
function spyScrolls() {
  const calls: string[] = [];
  const proto = window.Element.prototype as any;
  const saved = {
    scrollIntoView: proto.scrollIntoView,
    scrollTo: (window as any).scrollTo,
    scrollBy: (window as any).scrollBy,
    elScrollTo: proto.scrollTo,
    elScrollBy: proto.scrollBy,
  };
  proto.scrollIntoView = () => calls.push("scrollIntoView");
  proto.scrollTo = () => calls.push("element.scrollTo");
  proto.scrollBy = () => calls.push("element.scrollBy");
  (window as any).scrollTo = () => calls.push("window.scrollTo");
  (window as any).scrollBy = () => calls.push("window.scrollBy");
  return {
    calls,
    restore() {
      proto.scrollIntoView = saved.scrollIntoView;
      proto.scrollTo = saved.elScrollTo;
      proto.scrollBy = saved.elScrollBy;
      (window as any).scrollTo = saved.scrollTo;
      (window as any).scrollBy = saved.scrollBy;
    },
  };
}

// --------------------------------------------------------------
// 1. Activation sticky : plusieurs sous-catégories ET liste défilante
// --------------------------------------------------------------
test("1a. plusieurs sous-catégories + liste plus haute que l'écran -- barre sticky (top-0, fond opaque), sans ancre ni élément ajouté", async () => {
  const { container, root } = await render(baseRestaurant([longCategory()]));
  try {
    const nav = filterNav(container);
    assert.ok(nav, "barre de filtre attendue");
    assert.equal(nav!.getAttribute("data-subcategory-filter-sticky"), "true");
    const cls = classes(nav!);
    for (const c of ["sticky", "top-0", "z-20", "bg-crema"]) {
      assert.ok(cls.includes(c), `classe '${c}' attendue sur la barre sticky`);
    }
    assert.equal(container.querySelector("[data-subcategory-filter-anchor]"), null, "plus aucune ancre de recentrage");
    assert.equal(nav!.previousElementSibling?.tagName, "DIV", "élément précédent inchangé (filet laiton)");
    assert.ok(classes(nav!.previousElementSibling!).includes("bg-gold"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("1b. activation NON couplée au nombre de produits -- 3 grandes cartes défilantes : sticky ; 10 petites cartes tenant dans l'écran : non sticky", async () => {
  layout.cardPx = 300; // 3 x 300 = 900 px > 700 px
  let r = await render(baseRestaurant([fewProductsCategory()]));
  try {
    assert.equal(isSticky(r.container), true, "3 produits mais liste défilante : sticky");
  } finally {
    r.root.unmount();
    r.container.remove();
  }

  layout.cardPx = 60; // 10 x 60 = 600 px <= 700 px
  r = await render(baseRestaurant([longCategory()]));
  try {
    const nav = filterNav(r.container)!;
    assert.ok(nav);
    assert.equal(isSticky(r.container), false, "10 produits tenant dans l'écran : jamais sticky");
    assert.equal(nav.getAttribute("class"), "mt-3 border-b border-espresso/10 pb-3");
  } finally {
    r.root.unmount();
    r.container.remove();
  }
});

test("1c. UNE seule sous-catégorie réelle, liste très longue -- jamais sticky (barre historique)", async () => {
  const { container, root } = await render(baseRestaurant([longSingleSubcategory()]));
  try {
    const nav = filterNav(container)!;
    assert.ok(nav);
    assert.equal(isSticky(container), false);
    assert.equal(nav.getAttribute("class"), "mt-3 border-b border-espresso/10 pb-3");
    assert.equal(nav.querySelector("ul")!.getAttribute("class"), "flex flex-wrap gap-2");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// 2. État actif, aucun défilement forcé, redimensionnement
// --------------------------------------------------------------
test("2a. état actif exact après sélection, défilement et changement de catégorie -- une seule pilule aria-pressed=true, sticky stable malgré la liste filtrée plus courte que l'écran", async () => {
  const { container, root } = await render(baseRestaurant([longCategory(), shortCategory()]));
  try {
    assert.deepEqual(pressed(container), ["Tous"]);
    assert.equal(isSticky(container), true);

    click(pill(container, "Raclette"));
    await flush();
    assert.deepEqual(pressed(container), ["Raclette"]);
    // Liste filtrée : 4 cartes = 400 px < 700 px -- la barre reste
    // sticky (mesure "Tous" conservée, aucun saut de mise en page).
    assert.equal(isSticky(container), true);

    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new window.Event("scroll"));
      window.document.dispatchEvent(new window.Event("scroll"));
    }
    await flush();
    assert.deepEqual(pressed(container), ["Raclette"]);
    assert.ok(container.textContent?.includes("Raclette-4"));
    assert.ok(!container.textContent?.includes("Chevre-1"));

    click(pill(container, "Chèvres"));
    await flush();
    assert.deepEqual(pressed(container), ["Chèvres"]);
    assert.equal(isSticky(container), true);

    // Navigation de catégorie : filtre réinitialisé à "Tous" (v169b H).
    click(categoryButton(container, "Desserts"));
    await flush();
    assert.deepEqual(pressed(container), ["Tous"]);
    assert.equal(isSticky(container), false);

    click(categoryButton(container, "Fromages"));
    await flush();
    assert.deepEqual(pressed(container), ["Tous"]);
    assert.equal(isSticky(container), true);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("2b. sélection d'une sous-catégorie (barre collée ou non) -- AUCUN défilement programmatique de la page, filtrage exact", async () => {
  const spy = spyScrolls();
  const { container, root } = await render(baseRestaurant([longCategory()]));
  try {
    assert.equal(isSticky(container), true);
    const nav = filterNav(container)!;

    // Barre à sa place naturelle.
    nav.getBoundingClientRect = () => rect(240, 300);
    click(pill(container, "Raclette"));
    await flush();

    // Barre collée en haut, page défilée bien au-delà.
    nav.getBoundingClientRect = () => rect(0, 60);
    click(pill(container, "Chèvres"));
    await flush();
    click(pill(container, "Tous"));
    await flush();
    click(pill(container, "Chèvres"));
    await flush();

    assert.deepEqual(spy.calls, [], "aucun scrollIntoView / scrollTo / scrollBy à la sélection");
    assert.deepEqual(pressed(container), ["Chèvres"]);
    assert.ok(container.textContent?.includes("Chevre-1"));
    assert.ok(!container.textContent?.includes("Raclette-1"));
    assert.ok(!container.textContent?.includes("Direct-1"));
  } finally {
    spy.restore();
    root.unmount();
    container.remove();
  }
});

test("2c. redimensionnement / rotation -- re-mesure en mode 'Tous' ; jamais de bascule tant qu'une sous-catégorie est choisie", async () => {
  const { container, root } = await render(baseRestaurant([longCategory()]));
  try {
    assert.equal(isSticky(container), true);

    layout.viewport = 1400; // 1000 px de liste tiennent désormais
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    assert.equal(isSticky(container), false);

    layout.viewport = 700;
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    assert.equal(isSticky(container), true);

    click(pill(container, "Raclette"));
    await flush();
    layout.viewport = 1400;
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    assert.equal(isSticky(container), true, "filtre actif : la mesure 'Tous' est conservée");
    assert.deepEqual(pressed(container), ["Raclette"]);

    click(pill(container, "Tous"));
    await flush();
    assert.equal(isSticky(container), false, "retour à 'Tous' : re-mesure sur la liste complète");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// 3. Catalogue court / sans sous-catégorie inchangé
// --------------------------------------------------------------
test("3a. catalogue COURT avec sous-catégorie -- barre dans le flux normal, markup historique exact (aucune classe sticky, aucune ancre)", async () => {
  const { container, root } = await render(baseRestaurant([shortCategory()]));
  try {
    const nav = filterNav(container);
    assert.ok(nav);
    assert.equal(nav!.getAttribute("class"), "mt-3 border-b border-espresso/10 pb-3");
    assert.equal(nav!.querySelector("ul")!.getAttribute("class"), "flex flex-wrap gap-2");
    assert.equal(nav!.hasAttribute("data-subcategory-filter-sticky"), false);
    assert.equal(container.querySelector("[data-subcategory-filter-anchor]"), null);
    assert.deepEqual(
      [...container.querySelectorAll("[data-subcategory-filter-option]")].map((b) => b.textContent),
      ["Tous", "Glaces"]
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("3b. catalogue LONG sans sous-catégorie -- aucune barre, aucun élément sticky ajouté", async () => {
  const { container, root } = await render(baseRestaurant([longFlatCategory()]));
  try {
    assert.equal(filterNav(container), null);
    assert.equal(container.querySelector("[data-subcategory-filter-sticky]"), null);
    const stickies = [...container.querySelectorAll(".sticky")];
    assert.equal(stickies.length, 0, "aucun sticky mobile sans filtre de sous-catégorie");
    const categoryNav = container.querySelector("[data-category-navigation]")!;
    assert.ok(classes(categoryNav).includes("sm:sticky"), "CategoryNav reste sticky sur desktop");
    assert.ok(container.textContent?.includes("Boisson-9"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// 4. Non-chevauchement + une seule ligne sur mobile
// --------------------------------------------------------------
test("4a. non-chevauchement -- bloc contenant = section de la catégorie active, empilement sous CategoryNav / barre panier / modales, fond opaque", async () => {
  const { container, root } = await render(baseRestaurant([longCategory()]));
  try {
    const nav = filterNav(container)!;

    assert.equal(nav.parentElement?.tagName, "SECTION");
    assert.equal(nav.parentElement?.parentElement?.tagName, "MAIN");

    // CategoryNav (desktop sm:z-30) est sticky dans un parent qui ne
    // contient QUE lui : il ne suit donc jamais le défilement jusqu'à
    // top-0 au-dessus de la barre de filtre.
    const categoryNav = container.querySelector("nav:not([aria-label])")!;
    assert.ok(classes(categoryNav).includes("sm:z-30"));
    assert.equal(classes(categoryNav).includes("z-30"), false, "aucun z-index sticky mobile");
    assert.equal(categoryNav.parentElement!.children.length, 1);
    assert.ok(!nav.contains(categoryNav) && !categoryNav.contains(nav));

    const zOf = (el: Element) => Number(classes(el).find((c) => /^z-\d+$/.test(c))!.slice(2));
    assert.equal(zOf(nav), 20);
    assert.ok(zOf(nav) < 30, "sur desktop, la barre secondaire reste sous CategoryNav sm:z-30");

    const addBtn = [...container.querySelectorAll("main button")].find(
      (b) => !b.hasAttribute("data-subcategory-filter-option")
    )!;
    click(addBtn);
    await flush();
    const cartBar = [...container.querySelectorAll("button")].find((b) => classes(b).includes("fixed"));
    assert.ok(cartBar, "barre panier fixe attendue");
    assert.ok(zOf(cartBar!) > zOf(nav));

    for (const file of ["CartPanel.tsx", "OptionModal.tsx", "OrderConfirmation.tsx"]) {
      const source = readFileSync(path.join(REPO_ROOT, "components", file), "utf8");
      assert.ok(/className="fixed inset-0 z-50\b/.test(source), `${file} : racine modale z-50 attendue`);
    }
    assert.ok(readFileSync(path.join(REPO_ROOT, "components", "ProductInfoButton.tsx"), "utf8").includes("showModal()"));

    const navClasses = classes(nav);
    const css = await compileUtilities(navClasses);
    assert.equal(ruleFor(css, "sticky"), "position: sticky");
    assert.equal(ruleFor(css, "top-0"), "top: 0px");
    assert.equal(ruleFor(css, "z-20"), "z-index: 20");
    const backgrounds = navClasses
      .filter((c) => c.startsWith("bg-"))
      .map((c) => [c, ruleFor(css, c)] as const);
    assert.deepEqual(backgrounds, [["bg-crema", "background-color: var(--sc-bg, #F6F2EC)"]],
      "un seul fond, généré, sans opacité réduite");
    assert.ok(!navClasses.some((c) => c.startsWith("backdrop-")), "aucun flou : fond opaque");
    assert.equal(ruleFor(await compileUtilities(["bg-crema/95"]), "bg-crema/95"), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("4b. mobile -- barre sticky sur UNE seule ligne défilable horizontalement (hauteur bornée), retour à la ligne conservé à partir de sm ; CSS réellement généré", async () => {
  const { container, root } = await render(baseRestaurant([longCategory()]));
  try {
    const nav = filterNav(container)!;
    const ul = nav.querySelector("ul")!;
    const ulClasses = classes(ul);
    for (const c of ["flex", "flex-nowrap", "overflow-x-auto", "sm:flex-wrap", "sm:overflow-x-visible"]) {
      assert.ok(ulClasses.includes(c), `classe '${c}' attendue sur la ligne de pilules`);
    }
    assert.ok(!ulClasses.includes("flex-wrap"), "jamais de retour à la ligne sur mobile en mode sticky");
    for (const li of ul.children) assert.equal(li.tagName, "LI");
    for (const b of ul.querySelectorAll("button")) {
      assert.ok(classes(b).includes("whitespace-nowrap"), "libellé de pilule jamais coupé");
    }
    // Aucun masquage de la barre de défilement ni hauteur figée : la
    // hauteur est bornée par construction (une ligne de pilules).
    assert.ok(!ulClasses.some((c) => /scrollbar|^(h|max-h)-/.test(c)));
    assert.ok(!classes(nav).some((c) => /^(h|max-h|overflow)-/.test(c)));

    const css = await compileUtilities(ulClasses);
    assert.equal(ruleFor(css, "flex-nowrap"), "flex-wrap: nowrap");
    assert.equal(ruleFor(css, "overflow-x-auto"), "overflow-x: auto");
    assert.equal(ruleFor(css, "overscroll-x-contain"), "overscroll-behavior-x: contain");
    const smStart = css.indexOf("@media (min-width: 640px)");
    assert.ok(smStart !== -1, "variante sm générée");
    const smCss = css.slice(smStart);
    assert.ok(smCss.includes(".sm\\:flex-wrap {") && smCss.includes("flex-wrap: wrap"));
    assert.ok(smCss.includes(".sm\\:overflow-x-visible {") && smCss.includes("overflow-x: visible"));
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// 5. Clavier / tactile / état accessible
// --------------------------------------------------------------
test("5a. pilules sticky : boutons natifs (clavier Entrée/Espace, tap), dans l'ordre de tabulation, aria-pressed exact, nav nommée", async () => {
  const { container, root } = await render(baseRestaurant([longCategory()]));
  const spy = spyScrolls();
  try {
    const nav = filterNav(container)!;
    assert.equal(nav.tagName, "NAV");
    assert.equal(nav.getAttribute("aria-label"), "Tous");
    const pills = [...nav.querySelectorAll("button")];
    assert.equal(pills.length, 3);
    for (const b of pills) {
      assert.equal(b.getAttribute("type"), "button");
      assert.equal(b.hasAttribute("tabindex"), false, "aucun tabindex : ordre de tabulation natif");
      assert.equal(b.hasAttribute("disabled"), false);
      assert.ok(["true", "false"].includes(b.getAttribute("aria-pressed")!));
    }
    for (const el of [nav, ...nav.querySelectorAll("*")]) {
      const cls = classes(el);
      assert.ok(!cls.includes("pointer-events-none") && !cls.some((c) => c.startsWith("touch-")),
        "le tap et le glissé horizontal ne doivent jamais être neutralisés");
    }

    pills[1].focus();
    assert.equal(window.document.activeElement, pills[1]);
    click(pills[1]);
    await flush();
    assert.deepEqual(spy.calls, []);
    assert.equal(window.document.activeElement, pills[1], "le focus reste sur la pilule activée");
    assert.equal(pills[1].getAttribute("aria-pressed"), "true");
    assert.equal(pills[0].getAttribute("aria-pressed"), "false");
  } finally {
    spy.restore();
    root.unmount();
    container.remove();
  }
});

test("5b. focus clavier dans la liste masqué par la barre collée -- la page défile juste assez ; élément visible ou mode non sticky -- aucun défilement", async () => {
  const calls: Array<[number, number]> = [];
  const savedScrollBy = (window as any).scrollBy;
  (window as any).scrollBy = (x: number, y: number) => calls.push([x, y]);

  const { container, root } = await render(baseRestaurant([longCategory(), shortCategory()]));
  try {
    const nav = filterNav(container)!;
    assert.equal(isSticky(container), true);
    nav.getBoundingClientRect = () => rect(0, 60);
    const listButton = () =>
      [...container.querySelectorAll("main button")].find(
        (b) => !b.hasAttribute("data-subcategory-filter-option")
      ) as HTMLButtonElement;

    // jsdom n'a pas d'heuristique de modalité : ":focus-visible" (vrai
    // pour un focus clavier, faux pour un clic/tap) est simulé.
    const withModality = (el: HTMLElement, keyboard: boolean) => {
      const original = window.Element.prototype.matches;
      el.matches = (selector: string) =>
        selector === ":focus-visible" ? keyboard : original.call(el, selector);
    };

    const hidden = listButton();
    hidden.getBoundingClientRect = () => rect(20, 60);
    withModality(hidden, true);
    hidden.focus();
    assert.equal(window.document.activeElement, hidden);
    assert.deepEqual(calls, [[0, 20 - 60 - 8]]);

    calls.length = 0;
    hidden.blur();
    hidden.getBoundingClientRect = () => rect(300, 340);
    hidden.focus();
    assert.deepEqual(calls, [], "élément déjà sous la barre -- aucun défilement");

    hidden.blur();
    hidden.getBoundingClientRect = () => rect(20, 60);
    withModality(hidden, false);
    hidden.focus();
    assert.equal(window.document.activeElement, hidden);
    assert.deepEqual(calls, [], "focus pointeur -- aucun défilement");
    hidden.blur();

    // Catégorie non sticky : gestionnaire inactif.
    click(categoryButton(container, "Desserts"));
    await flush();
    const shortNav = filterNav(container)!;
    shortNav.getBoundingClientRect = () => rect(0, 60);
    const b = listButton();
    b.getBoundingClientRect = () => rect(10, 40);
    b.focus();
    assert.deepEqual(calls, []);
  } finally {
    (window as any).scrollBy = savedScrollBy;
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// 6. Non-régression filtre / navigation en mode sticky
// --------------------------------------------------------------
test("6. non-régression -- ordre des pilules, 'Tous' par défaut, filtrage exact (produits directs exclus d'un filtre précis), retour à 'Tous'", async () => {
  const { container, root } = await render(baseRestaurant([longCategory()]));
  try {
    assert.equal(isSticky(container), true);
    assert.deepEqual(
      [...container.querySelectorAll("[data-subcategory-filter-option]")].map((b) => b.textContent),
      ["Tous", "Raclette", "Chèvres"]
    );
    assert.deepEqual(pressed(container), ["Tous"]);
    assert.equal(container.querySelectorAll("[data-subcategory-heading]").length, 2);

    click(pill(container, "Raclette"));
    await flush();
    for (const n of ["Raclette-1", "Raclette-4"]) assert.ok(container.textContent?.includes(n));
    for (const n of ["Direct-1", "Chevre-1"]) assert.ok(!container.textContent?.includes(n));

    click(pill(container, "Tous"));
    await flush();
    for (const n of ["Direct-1", "Direct-2", "Raclette-1", "Chevre-4"]) assert.ok(container.textContent?.includes(n));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("nettoyage -- aucun écouteur scroll ; chaque écouteur resize ajouté par MenuView est retiré (changements de filtre, de catégorie, démontage)", async () => {
  const added: Array<[string, unknown]> = [];
  const removed: Array<[string, unknown]> = [];
  const originalAdd = window.addEventListener.bind(window);
  const originalRemove = window.removeEventListener.bind(window);
  (window as any).addEventListener = (type: string, fn: unknown, ...rest: unknown[]) => {
    added.push([type, fn]);
    return (originalAdd as any)(type, fn, ...rest);
  };
  (window as any).removeEventListener = (type: string, fn: unknown, ...rest: unknown[]) => {
    removed.push([type, fn]);
    return (originalRemove as any)(type, fn, ...rest);
  };
  try {
    const { container, root } = await render(baseRestaurant([longCategory(), shortCategory()]));
    click(pill(container, "Raclette"));
    await flush();
    click(pill(container, "Tous"));
    await flush();
    click(categoryButton(container, "Desserts"));
    await flush();
    click(categoryButton(container, "Fromages"));
    await flush();
    root.unmount();
    container.remove();
  } finally {
    (window as any).addEventListener = originalAdd;
    (window as any).removeEventListener = originalRemove;
  }
  assert.ok(!added.some(([t]) => t === "scroll"), "aucun écouteur scroll");
  const resizeAdded = added.filter(([t]) => t === "resize");
  assert.ok(resizeAdded.length >= 1, "écouteur resize attendu en mode sticky");
  for (const [, fn] of resizeAdded) {
    assert.ok(removed.some(([t, f]) => t === "resize" && f === fn), "écouteur resize non retiré");
  }
});

after(async () => {
  window.HTMLElement.prototype.getBoundingClientRect = originalRect;
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
