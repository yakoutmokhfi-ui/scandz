import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// V67b — Placeholder produit : tests comportementaux réels (DOM),
// complémentaires à tests/v67-product-photos.dom.test.ts (qui vérifie
// déjà "aucune <img> sans photo" mais pas qu'un VRAI placeholder
// visuel est rendu à la place — un <div> vide passerait ce test-là
// tout autant qu'un placeholder correct). Même harnais de bundling
// que V67 (esbuild.build() réel, alias "@/" -> racine du dépôt).
//
// ⚠️ CORRIGE L1B1-02 (contre-audit Work, tour LOT 1B.2) : Work a
// reproduit une instabilité réelle de ces 4 tests sous charge (671/671
// puis 667/671 avec ces 4 précis en échec, puis de nouveau 671/671).
// Cause racine diagnostiquée AVANT toute modification (pas supposée) :
//
//   1. flush() attendait un DÉLAI FIXE arbitraire (10ms) avant de
//      vérifier le DOM -- sous charge machine, le rendu React peut ne
//      pas encore avoir eu lieu à cet instant précis, produisant un
//      échec intermittent selon le timing exact de l'exécution.
//      Remplacé par waitFor() : une attente CONDITIONNELLE déterministe,
//      qui interroge l'état réel du DOM à intervalles courts jusqu'à
//      ce que la condition attendue soit vraie (ou qu'un délai maximal
//      généreux soit dépassé, auquel cas le test échoue légitimement
//      avec un message clair) -- jamais un délai arbitraire qui masque
//      le problème en espérant qu'il soit "assez long".
//   2. requestAnimationFrame/cancelAnimationFrame étaient remplacés
//      par un polyfill maison basé sur setTimeout brut, DÉCONNECTÉ du
//      cycle de vie JSDOM -- même défaut déjà corrigé ailleurs (LOT
//      1A.1, tests/v80-lot1a1-menuview-lang.dom.test.ts) mais jamais
//      reporté sur ce fichier plus ancien. JSDOM fournit DÉJÀ
//      requestAnimationFrame/cancelAnimationFrame nativement via
//      pretendToBeVisual:true -- réutilisés tels quels.
//   3. Aucun nettoyage (window.close(), esbuild.stop()) n'existait --
//      ajouté dans un hook after() (node:test), même technique déjà
//      éprouvée.
//
// Aucune assertion affaiblie, aucun scénario supprimé, aucun
// --test-force-exit, aucun retry masquant un échec : la cause racine
// (synchronisation) est corrigée, le comportement testé reste
// strictement identique.
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
// Corrige L1B1-02 : RAF/cancelRAF réels de JSDOM (pretendToBeVisual),
// jamais un polyfill setTimeout brut déconnecté du cycle de vie de la
// fenêtre.
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
export { default as MenuItemCard } from "@/components/MenuItemCard";
export { I18nProvider } from "@/lib/i18n-context";
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
const tmpFile = path.join(tmpDir, "MenuItemCard.mjs");
writeFileSync(tmpFile, code);
const { MenuItemCard, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    category_id: "c1",
    name: "Camembert",
    description: null,
    short_description: null,
    price: 800,
    image_url: null,
    display_order: 0,
    is_available: true,
    ...overrides,
  };
}

function render(item: Record<string, unknown>, variant: "classic" | "editorial" = "classic") {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      I18nProvider,
      { lang: "fr" },
      React.createElement(MenuItemCard, {
        item,
        currency: "DZD",
        quantity: 0,
        requiresChoice: false,
        onAdd: () => {},
        onRemove: () => {},
        variant,
      })
    )
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Corrige L1B1-02 : attente CONDITIONNELLE déterministe, jamais un
 * délai fixe arbitraire. Interroge `condition()` à intervalles courts
 * jusqu'à ce qu'elle devienne vraie, ou jusqu'à un délai maximal
 * généreux (2s -- largement suffisant pour un rendu React réel, y
 * compris sous charge machine) -- au-delà, le test échoue
 * légitimement avec un message explicite, jamais un faux-positif
 * masqué par un délai trop court ni un délai artificiellement
 * allongé pour "faire passer" le test.
 */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 2000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition jamais vraie dans le délai imparti (${timeoutMs}ms) -- ${description}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("Placeholder (DOM réel) : rendu effectivement présent quand image_url est absent (pas seulement 'pas de <img>')", async () => {
  const { container, root } = render(baseItem({ image_url: null }));
  await waitFor(
    () => container.querySelector('[role="img"][aria-hidden="true"]') !== null,
    "le placeholder doit apparaître dans le DOM"
  );

  const placeholder = container.querySelector('[role="img"][aria-hidden="true"]');
  assert.ok(placeholder, "un élément role=img aria-hidden doit être rendu à la place de la photo absente");
  assert.ok(placeholder!.querySelector("svg"), "le placeholder doit contenir un glyphe SVG neutre, pas être vide");
  assert.equal(container.querySelector("img"), null, "aucune balise <img> ne doit être rendue sans photo");

  root.unmount();
  container.remove();
});

test("Placeholder (DOM réel) : disparaît et laisse place à une vraie <img> dès qu'une photo existe", async () => {
  const { container, root } = render(
    baseItem({ image_url: "https://example.supabase.co/storage/v1/object/public/product-photos/r1/p1/abc.jpg" })
  );
  await waitFor(
    () => container.querySelector("img") !== null,
    "une <img> réelle doit apparaître dans le DOM"
  );

  assert.equal(
    container.querySelector('[role="img"][aria-hidden="true"]'),
    null,
    "le placeholder ne doit plus être rendu dès qu'une vraie photo existe"
  );
  const img = container.querySelector("img");
  assert.ok(img, "une vraie <img> doit être rendue à la place");
  assert.equal(img!.getAttribute("src"), "https://example.supabase.co/storage/v1/object/public/product-photos/r1/p1/abc.jpg");

  root.unmount();
  container.remove();
});

test("Placeholder (DOM réel) : revient après échec de chargement (photo cassée), simule le cas 'suppression'", async () => {
  // Le cas fonctionnel "suppression de la photo" (image_url repasse à
  // null après un removeProductPhoto()) est déjà couvert par le fait
  // que MenuItemCard se re-rend simplement avec image_url=null, testé
  // ci-dessus. Ce test-ci couvre le cas voisin explicitement demandé
  // par la mission (item 11 : "broken real image -> clean fallback") :
  // une image dont le CHARGEMENT échoue doit elle aussi retomber sur
  // le placeholder, pas rester un <img> cassé indéfiniment.
  const { container, root } = render(baseItem({ image_url: "https://example.invalid/broken.jpg" }));
  await waitFor(() => container.querySelector("img") !== null, "l'<img> initiale doit apparaître avant l'échec simulé");

  const img = container.querySelector("img")!;
  assert.ok(img, "l'image doit être tentée avant l'échec");
  img.dispatchEvent(new window.Event("error"));
  await waitFor(
    () => container.querySelector("img") === null && container.querySelector('[role="img"][aria-hidden="true"]') !== null,
    "après l'échec de chargement, l'<img> cassée doit disparaître et le placeholder réapparaître"
  );

  assert.equal(container.querySelector("img"), null, "l'<img> cassée doit disparaître du DOM");
  const placeholder = container.querySelector('[role="img"][aria-hidden="true"]');
  assert.ok(placeholder, "le placeholder doit apparaître à la place, pas un bloc vide");

  root.unmount();
  container.remove();
});

test("Placeholder (DOM réel) : comportement identique dans la variante 'editorial' (pas seulement 'classic')", async () => {
  const { container, root } = render(baseItem({ image_url: null }), "editorial");
  await waitFor(
    () => container.querySelector('[role="img"][aria-hidden="true"]') !== null,
    "le placeholder doit apparaître dans le DOM (variante editorial)"
  );

  const placeholder = container.querySelector('[role="img"][aria-hidden="true"]');
  assert.ok(placeholder, "le placeholder doit aussi être rendu dans la variante éditoriale");

  root.unmount();
  container.remove();
});

after(async () => {
  // Corrige L1B1-02 : cycle de vie complet, même technique éprouvée
  // qu'en LOT 1A.1 (tests/v80-lot1a1-menuview-lang.dom.test.ts).
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
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
