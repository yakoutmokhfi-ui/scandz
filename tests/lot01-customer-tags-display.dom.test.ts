import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Scanym — LOT 01 — CUSTOMER TAGS DISPLAY — rendu DOM réel de
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
    short_description: "Lait cru",
    price: 800,
    image_url: null,
    display_order: 0,
    is_available: true,
    ...overrides,
  };
}

type Variant = "classic" | "editorial" | "inline";

function render(item: Record<string, unknown>, variant: Variant = "classic", lang = "fr") {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const inline = variant === "inline";
  root.render(
    React.createElement(
      I18nProvider,
      { lang },
      React.createElement(MenuItemCard, {
        item,
        currency: "EUR",
        quantity: 0,
        requiresChoice: inline,
        onAdd: () => {},
        onRemove: () => {},
        variant: inline ? "classic" : variant,
        inlineChoices: inline ? [baseItem({ id: "g1", name: "Nature", short_description: null })] : undefined,
        inlineCounts: inline ? {} : undefined,
        onChangeChoice: inline ? () => {} : undefined,
      })
    )
  );
  return { container, root };
}

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

function tagTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-product-tags] > li")).map((li) => li.textContent ?? "");
}

for (const variant of ["classic", "editorial", "inline"] as const) {
  test(`[TAGGED] (${variant}) un produit tagué affiche ses tags dans une liste accessible nommée`, async () => {
    const { container, root } = render(baseItem({ customer_tags: ["Bio"] }), variant);
    await waitFor(() => container.querySelector("article") !== null, "la carte doit être rendue");

    const list = container.querySelector("[data-product-tags]");
    assert.ok(list, "la liste des tags doit être rendue");
    assert.equal(list!.tagName, "UL", "sémantique de liste native");
    assert.equal(list!.getAttribute("aria-label"), "Tags de Camembert");
    assert.deepEqual(tagTexts(container), ["Bio"]);
    assert.ok(list!.closest("article"), "la liste est DANS la carte produit");
    assert.equal(list!.querySelector("button, a, input, [tabindex]"), null, "affichage en lecture seule : aucun contrôle interactif");

    root.unmount();
    container.remove();
  });

  test(`[UNTAGGED] (${variant}) un produit sans tag ne rend aucune liste ni pilule`, async () => {
    for (const tags of [undefined, [] as string[], ["", "  "]]) {
      const { container, root } = render(baseItem(tags === undefined ? {} : { customer_tags: tags }), variant);
      await waitFor(() => container.querySelector("article") !== null, "la carte doit être rendue");
      assert.equal(container.querySelector("[data-product-tags]"), null);
      // La variante inline rend déjà sa propre liste de goûts
      // (InlineOptions) : seule la liste préexistante est tolérée.
      assert.equal(container.querySelectorAll("ul").length, variant === "inline" ? 1 : 0, "aucune liste ajoutée à la carte");
      root.unmount();
      container.remove();
    }
  });
}

test("[UNTAGGED] le rendu d'un produit sans tag est identique à celui d'un produit dont customer_tags est absent", async () => {
  const a = render(baseItem({ customer_tags: [] }));
  const b = render(baseItem());
  await waitFor(
    () => a.container.querySelector("article") !== null && b.container.querySelector("article") !== null,
    "les deux cartes doivent être rendues"
  );
  assert.equal(a.container.innerHTML, b.container.innerHTML);
  a.root.unmount();
  b.root.unmount();
  a.container.remove();
  b.container.remove();
});

test("[MULTI] plusieurs tags : tous affichés, dans l'ordre reçu, un <li> chacun", async () => {
  const { container, root } = render(baseItem({ customer_tags: ["Bio", "Truffe", "AOP"] }));
  await waitFor(() => container.querySelector("[data-product-tags]") !== null, "la liste doit apparaître");
  assert.deepEqual(tagTexts(container), ["Bio", "Truffe", "AOP"]);
  root.unmount();
  container.remove();
});

test("[DUPLICATES] une étiquette répétée (casse/espaces) n'est rendue qu'une fois, sans avertissement de clé React", async () => {
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const { container, root } = render(baseItem({ customer_tags: ["Bio", "bio", " Bio ", "Truffe", "Truffe"] }));
    await waitFor(() => container.querySelector("[data-product-tags]") !== null, "la liste doit apparaître");
    assert.deepEqual(tagTexts(container), ["Bio", "Truffe"]);
    root.unmount();
    container.remove();
  } finally {
    console.error = originalError;
  }
  assert.equal(warnings.filter((w) => w.includes("same key")).length, 0);
});

test("[A11Y] chaque pilule garde son propre sens d'écriture (dir=auto) et un contraste calculé (bg-crema + text-accent-dark-on-bg, sans opacité)", async () => {
  const { container, root } = render(baseItem({ customer_tags: ["Bio", "عضوي"] }));
  await waitFor(() => container.querySelector("[data-product-tags]") !== null, "la liste doit apparaître");
  const items = Array.from(container.querySelectorAll("[data-product-tags] > li"));
  assert.equal(items.length, 2);
  for (const li of items) {
    assert.equal(li.getAttribute("dir"), "auto");
    const cls = li.getAttribute("class") ?? "";
    assert.ok(cls.includes("bg-crema") && cls.includes("text-accent-dark-on-bg"));
    assert.ok(!/text-accent-dark-on-bg\//.test(cls), "aucune opacité Tailwind sur une couleur de contraste calculée");
  }
  const list = container.querySelector("[data-product-tags]")!;
  assert.ok((list.getAttribute("class") ?? "").includes("flex-wrap"), "mobile-first : retour à la ligne, jamais de défilement horizontal");
  root.unmount();
  container.remove();
});

test("[A11Y] le nom accessible de la liste est localisé (en, ar)", async () => {
  const en = render(baseItem({ customer_tags: ["Bio"] }), "classic", "en");
  const ar = render(baseItem({ customer_tags: ["Bio"] }), "classic", "ar");
  await waitFor(
    () => en.container.querySelector("[data-product-tags]") !== null && ar.container.querySelector("[data-product-tags]") !== null,
    "les deux listes doivent apparaître"
  );
  assert.equal(en.container.querySelector("[data-product-tags]")!.getAttribute("aria-label"), "Tags for Camembert");
  assert.equal(ar.container.querySelector("[data-product-tags]")!.getAttribute("aria-label"), "وسوم Camembert");
  en.root.unmount();
  ar.root.unmount();
  en.container.remove();
  ar.container.remove();
});

after(async () => {
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
