import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Tests comportementaux React réels pour la photo produit sur la
// carte publique (V67) : rendu réel dans un DOM (jsdom), pas une
// lecture du fichier source. Mêmes raisons qu'en V66 (B-04) — une
// carte sans photo ne doit produire ni bloc vide ni <img> cassée, et
// une photo qui échoue au chargement doit disparaître proprement du
// DOM, ce qu'une assertion sur le code source seul ne peut pas
// vérifier.
//
// MenuItemCard.tsx a de vraies dépendances (@/lib/*, @/components/*,
// certaines en JSX) — contrairement à ProductInfoButton.tsx (V66),
// une simple transformation esbuild.transform() ne suffit pas :
// celle-ci ne fait que retirer TypeScript/JSX d'UN fichier, sans
// résoudre ses imports. Ce fichier utilise donc esbuild.build() avec
// bundling réel et un plugin d'alias "@/" -> racine du dépôt, pour
// compiler le composant réel ET tout son arbre de dépendances réel.
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

// Point d'entrée virtuel : MenuItemCard ET I18nProvider (lui-même en
// JSX) doivent être compilés/bundlés ENSEMBLE — le loader natif du
// projet (--experimental-strip-types) retire les types mais ne
// transforme jamais le JSX, donc importer lib/i18n-context.tsx
// directement échouerait aussi.
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
// Écrit dans un fichier temporaire réel (pas une data: URL) : "react"
// et "react-dom" restent externes au bundle (une seule instance
// partagée avec ce fichier de test, indispensable pour les hooks) et
// doivent donc être résolus depuis node_modules — une data: URL n'a
// pas de base de résolution pour un import "react" nu.
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "MenuItemCard.mjs");
writeFileSync(tmpFile, code);
const { MenuItemCard, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    category_id: "c1",
    name: "Cappuccino",
    description: "Description longue détaillée.",
    short_description: "Description courte.",
    price: 350,
    image_url: null,
    display_order: 0,
    is_available: true,
    ...overrides,
  };
}

function render(item: Record<string, unknown>) {
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
      })
    )
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("MenuItemCard (DOM réel) : produit SANS photo -- aucune <img>, aucun bloc vide, le reste de la carte est intact", async () => {
  const { container, root } = render(baseItem({ image_url: null }));
  await flush();

  assert.equal(container.querySelector("img"), null, "aucune balise <img> ne doit être rendue sans photo");
  assert.ok(container.textContent!.includes("Cappuccino"), "le titre doit rester présent");
  assert.ok(container.textContent!.includes("Description courte"), "la description courte doit rester présente");
  assert.ok(container.querySelector("dialog"), "le bouton (i) / la modale doivent rester présents (description longue non vide)");
  assert.ok(container.textContent!.includes("350"), "le prix doit rester présent");
  assert.ok(container.querySelector("button"), "un bouton (au moins le (i) ou Ajouter) doit rester présent");

  root.unmount();
  container.remove();
});

test("MenuItemCard (DOM réel) : produit AVEC photo -- <img> rendue avec le bon src", async () => {
  const { container, root } = render(
    baseItem({ image_url: "https://example.supabase.co/storage/v1/object/public/product-photos/r1/p1/abc.jpg" })
  );
  await flush();

  const img = container.querySelector("img");
  assert.ok(img, "une <img> doit être rendue quand image_url est présent");
  assert.equal(
    img!.getAttribute("src"),
    "https://example.supabase.co/storage/v1/object/public/product-photos/r1/p1/abc.jpg"
  );

  root.unmount();
  container.remove();
});

test("MenuItemCard (DOM réel) : photo cassée (échec de chargement) -- l'<img> disparaît du DOM, pas de bloc cassé résiduel", async () => {
  const { container, root } = render(baseItem({ image_url: "https://example.invalid/broken.jpg" }));
  await flush();

  const img = container.querySelector("img")!;
  assert.ok(img, "l'image doit être présente avant l'échec de chargement");

  img.dispatchEvent(new window.Event("error"));
  await flush();

  assert.equal(container.querySelector("img"), null, "l'<img> doit disparaître du DOM après un échec de chargement");
  assert.ok(container.textContent!.includes("Cappuccino"), "le reste de la carte doit rester intact après l'échec");

  root.unmount();
  container.remove();
});

test("MenuItemCard (DOM réel) : produit sans description longue -- pas de photo cassée par ailleurs, aucune régression sur le (i)", async () => {
  const { container, root } = render(
    baseItem({ description: null, image_url: "https://example.supabase.co/storage/v1/object/public/product-photos/r1/p1/abc.jpg" })
  );
  await flush();

  assert.equal(container.querySelector("dialog"), null, "pas de modale (i) quand aucune description longue");
  assert.ok(container.querySelector("img"), "la photo doit tout de même être rendue");

  root.unmount();
  container.remove();
});
