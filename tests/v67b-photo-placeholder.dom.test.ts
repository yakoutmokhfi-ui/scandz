import { test } from "node:test";
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
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

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

test("Placeholder (DOM réel) : rendu effectivement présent quand image_url est absent (pas seulement 'pas de <img>')", async () => {
  const { container, root } = render(baseItem({ image_url: null }));
  await flush();

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
  await flush();

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
  await flush();

  const img = container.querySelector("img")!;
  assert.ok(img, "l'image doit être tentée avant l'échec");
  img.dispatchEvent(new window.Event("error"));
  await flush();

  assert.equal(container.querySelector("img"), null, "l'<img> cassée doit disparaître du DOM");
  const placeholder = container.querySelector('[role="img"][aria-hidden="true"]');
  assert.ok(placeholder, "le placeholder doit apparaître à la place, pas un bloc vide");

  root.unmount();
  container.remove();
});

test("Placeholder (DOM réel) : comportement identique dans la variante 'editorial' (pas seulement 'classic')", async () => {
  const { container, root } = render(baseItem({ image_url: null }), "editorial");
  await flush();

  const placeholder = container.querySelector('[role="img"][aria-hidden="true"]');
  assert.ok(placeholder, "le placeholder doit aussi être rendu dans la variante éditoriale");

  root.unmount();
  container.remove();
});
