import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Scanym — issue #200 — produits en rupture — rendu DOM réel de
// MenuItemCard (même harnais que tests/v67b-photo-placeholder.dom.
// test.ts : esbuild.build() réel, alias "@/", attente conditionnelle
// waitFor(), cycle de vie JSDOM nettoyé dans after()).
//
// Couvre : produit tagué, produit sans tag (aucun élément ajouté),
// tags multiples, suppression des doublons au rendu, sémantique
// accessible (liste nommée, éléments de liste, aucun contrôle
// interactif), trois variantes de carte (classic, editorial, inline),
// libellé accessible localisé (fr/en/ar).
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
export { default as MenuItemCard } from "@/components/MenuItemCard";
export { default as SoldOutVisibilityField } from "@/components/dashboard/SoldOutVisibilityField";
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
const { MenuItemCard, SoldOutVisibilityField, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1", category_id: "c1", name: "Camembert", description: null,
    short_description: "Lait cru", price: 800, image_url: null, display_order: 0,
    is_available: true, ...overrides,
  };
}
type Variant = "classic" | "editorial" | "inline";
function render(item: Record<string, unknown>, variant: Variant = "classic", lang = "fr", requiresChoice = false, quantity = 0) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const inline = variant === "inline";
  const calls = { add: 0, remove: 0, choice: 0 };
  root.render(
    React.createElement(I18nProvider, { lang },
      React.createElement(MenuItemCard, {
        item, currency: "EUR", quantity, requiresChoice: requiresChoice || inline,
        onAdd: () => { calls.add++; }, onRemove: () => { calls.remove++; },
        variant: inline ? "classic" : variant,
        inlineChoices: inline ? [baseItem({ id: "g1", name: "Nature", short_description: null })] : undefined,
        inlineCounts: inline ? {} : undefined,
        onChangeChoice: inline ? () => { calls.choice++; } : undefined,
      })
    )
  );
  return { container, root, calls };
}
async function waitFor(c: () => boolean, d: string, t = 2000) {
  const s = Date.now();
  while (!c()) { if (Date.now() - s > t) throw new Error("waitFor: " + d); await new Promise((r) => setTimeout(r, 5)); }
}
const tracked: Array<{ container: Element; root: { unmount(): void } }> = [];
const mount = async (...a: Parameters<typeof render>) => {
  const v = render(...a); tracked.push(v);
  await waitFor(() => v.container.querySelector("article") !== null, "article");
  return v;
};

for (const variant of ["classic", "editorial", "inline"] as const) {
  test(`[200-CARD-${variant}] produit en rupture : « En rupture », aucun bouton ni compteur, aucun ajout`, async () => {
    const { container, calls } = await mount(baseItem({ is_available: false }), variant);
    const badge = container.querySelector("[data-sold-out-badge]");
    assert.ok(badge, "mention affichée");
    assert.equal(badge!.textContent, "En rupture");
    assert.equal(container.querySelectorAll("button").length, 0, "aucun bouton d'ajout / compteur / choix");
    assert.equal(container.querySelectorAll("input").length, 0);
    assert.match(container.textContent ?? "", /Camembert/);
    assert.equal(calls.add + calls.remove + calls.choice, 0);
  });
}

test("[200-CARD-options] produit à options en rupture : pas de bouton « Ajouter » ni de compteur", async () => {
  const { container } = await mount(baseItem({ is_available: false }), "classic", "fr", true, 0);
  assert.equal(container.querySelectorAll("button").length, 0);
  assert.ok(container.querySelector("[data-sold-out-badge]"));
});

test("[200-CARD-regression] produit disponible : aucune mention, bouton d'ajout présent et fonctionnel", async () => {
  const { container, calls } = await mount(baseItem(), "classic");
  assert.equal(container.querySelector("[data-sold-out-badge]"), null);
  const btn = container.querySelector("button") as HTMLButtonElement;
  assert.ok(btn);
  btn.click();
  assert.equal(calls.add, 1);
});

test("[200-CARD-lang] la mention est localisée FR / EN / AR / NL", async () => {
  const expected: Record<string, string> = { fr: "En rupture", en: "Out of stock", ar: "نفد من المخزون", nl: "Uitverkocht" };
  for (const [lang, text] of Object.entries(expected)) {
    const { container } = await mount(baseItem({ is_available: false }), "classic", lang);
    assert.equal(container.querySelector("[data-sold-out-badge]")!.textContent, text, lang);
  }
});

function renderField(value: boolean, disabled: boolean, onChange: (v: boolean) => void) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const t = (k: string) => k;
  root.render(React.createElement(SoldOutVisibilityField, { value, onChange, disabled, t }));
  tracked.push({ container, root });
  return container;
}

test("[200-SETTING] case à cocher libellée, reflète la valeur et notifie le changement", async () => {
  const seen: boolean[] = [];
  const c = renderField(false, false, (v) => seen.push(v));
  await waitFor(() => c.querySelector("input[type=checkbox]") !== null, "case");
  const box = c.querySelector("input[type=checkbox]") as HTMLInputElement;
  assert.equal(box.checked, false);
  assert.equal(box.closest("label")?.textContent, "stSoldOutLabel");
  assert.equal(box.getAttribute("aria-describedby"), "sold-out-visibility-hint");
  box.click();
  assert.deepEqual(seen, [true]);
});

test("[200-SETTING-disabled] lecture impossible (colonne absente) : case désactivée + message", async () => {
  const c = renderField(false, true, () => { throw new Error("ne doit pas écrire"); });
  await waitFor(() => c.querySelector("input[type=checkbox]") !== null, "case");
  assert.equal((c.querySelector("input[type=checkbox]") as HTMLInputElement).disabled, true);
  assert.ok(c.querySelector("[data-sold-out-disabled-note]"));
});

after(() => { for (const v of tracked) { try { v.root.unmount(); } catch {} v.container.remove(); } dom.window.close(); });
