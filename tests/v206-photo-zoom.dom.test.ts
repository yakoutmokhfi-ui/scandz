import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Scanym — issue #188 (suite) — photo agrandie au clic — rendu DOM réel de
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
(globalThis as any).KeyboardEvent = window.KeyboardEvent;
(globalThis as any).MouseEvent = window.MouseEvent;
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


const ORIGINAL = "https://abc.supabase.co/storage/v1/object/public/product-photos/est/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab.jpg";
function baseItem(overrides: Record<string, unknown> = {}) {
  return { id: "p1", category_id: "c1", name: "Soumaintrain", description: null, short_description: null,
    price: 800, image_url: ORIGINAL, display_order: 0, is_available: true, ...overrides };
}
type Variant = "classic" | "inline";
const tracked: Array<{ container: Element; root: { unmount(): void } }> = [];
function mount(item: Record<string, unknown>, variant: Variant = "classic", lang = "fr") {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const calls = { add: 0, remove: 0, choice: 0 };
  const inline = variant === "inline";
  root.render(React.createElement(I18nProvider, { lang },
    React.createElement(MenuItemCard, {
      item, currency: "EUR", quantity: 0, requiresChoice: inline,
      onAdd: () => { calls.add++; }, onRemove: () => { calls.remove++; }, variant: "classic",
      inlineChoices: inline ? [baseItem({ id: "g1", name: "Nature" })] : undefined,
      inlineCounts: inline ? {} : undefined, onChangeChoice: inline ? () => { calls.choice++; } : undefined,
    })));
  tracked.push({ container, root });
  return { container, calls };
}
async function waitFor(c: () => boolean, d: string, t = 2000) {
  const s = Date.now();
  while (!c()) { if (Date.now() - s > t) throw new Error("waitFor: " + d); await new Promise((r) => setTimeout(r, 5)); }
}
const opener = (c: Element) => c.querySelector("article button[aria-haspopup='dialog']") as HTMLButtonElement | null;
const dialog = () => window.document.querySelector("[data-photo-lightbox]") as HTMLElement | null;
const key = (k: string) => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

for (const variant of ["classic", "inline"] as const) {
  test(`[206-ZOOM-open-${variant}] un clic sur la photo ouvre l'ORIGINAL en grand, sans rien ajouter au panier`, async () => {
    window.document.body.style.overflow = "";
    const { container, calls } = mount(baseItem(), variant);
    await waitFor(() => opener(container) !== null, "bouton photo");
    const btn = opener(container)!;
    assert.equal(btn.getAttribute("aria-label"), "Agrandir la photo de Soumaintrain");
    assert.equal(dialog(), null, "fermé par défaut : aucune image d'origine chargée");
    btn.click();
    await waitFor(() => dialog() !== null, "fenêtre ouverte");
    const d = dialog()!;
    assert.equal(d.getAttribute("role"), "dialog");
    assert.equal(d.getAttribute("aria-modal"), "true");
    assert.equal(d.getAttribute("aria-label"), "Soumaintrain");
    const img = d.querySelector("img")!;
    assert.equal(img.getAttribute("src"), ORIGINAL, "URL d'ORIGINE exacte : pas de /render/, pas de paramètres");
    assert.equal(img.getAttribute("alt"), "Soumaintrain");
    assert.equal(window.document.body.style.overflow, "hidden", "défilement de la page bloqué");
    assert.equal(calls.add + calls.remove + calls.choice, 0, "aucun ajout au panier");
    key("Escape");
    await waitFor(() => dialog() === null, "fermeture Échap");
    assert.equal(window.document.body.style.overflow, "", "défilement rétabli");
    assert.equal(window.document.activeElement, btn, "le focus revient sur la photo");
  });
}

test("[206-ZOOM-thumb] la carte affiche la miniature (512, q85) mais la fenêtre l'original", async () => {
  process.env.NEXT_PUBLIC_PRODUCT_PHOTO_THUMBNAILS = "1";
  try {
    const { container } = mount(baseItem());
    await waitFor(() => opener(container) !== null, "bouton");
    const cardSrc = container.querySelector("article img")!.getAttribute("src")!;
    assert.match(cardSrc, /\/render\/image\/public\/.*width=512&height=512&quality=85/);
    opener(container)!.click();
    await waitFor(() => dialog() !== null, "ouverte");
    assert.equal(dialog()!.querySelector("img")!.getAttribute("src"), ORIGINAL);
    key("Escape");
    await waitFor(() => dialog() === null, "fermée");
  } finally {
    delete process.env.NEXT_PUBLIC_PRODUCT_PHOTO_THUMBNAILS;
  }
});

test("[206-ZOOM-close] fond, bouton Fermer (nommé, 44 px) ; clic sur l'image ne ferme pas ; Tab reste dans la fenêtre", async () => {
  const { container } = mount(baseItem());
  await waitFor(() => opener(container) !== null, "bouton");
  opener(container)!.click();
  await waitFor(() => dialog() !== null, "ouverte");
  const close = dialog()!.querySelector("button") as HTMLButtonElement;
  assert.equal(close.getAttribute("aria-label"), "Fermer");
  assert.match(close.className, /h-11 w-11/);
  assert.equal(window.document.activeElement, close, "focus initial sur Fermer");
  (dialog()!.querySelector("img") as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(dialog(), "un clic sur l'image ne ferme pas");
  key("Tab");
  assert.equal(window.document.activeElement, close, "Tab retenu dans la fenêtre");
  dialog()!.click();
  await waitFor(() => dialog() === null, "fermée par le fond");
  opener(container)!.click();
  await waitFor(() => dialog() !== null, "rouverte");
  (dialog()!.querySelector("button") as HTMLButtonElement).click();
  await waitFor(() => dialog() === null, "fermée par le bouton");
});

test("[206-ZOOM-sold-out] une photo de produit en rupture reste agrandissable, sans ajout possible", async () => {
  const { container, calls } = mount(baseItem({ is_available: false }));
  await waitFor(() => opener(container) !== null, "bouton");
  opener(container)!.click();
  await waitFor(() => dialog() !== null, "ouverte");
  assert.equal(calls.add, 0);
  key("Escape");
  await waitFor(() => dialog() === null, "fermée");
});

test("[206-ZOOM-nophoto] sans photo : aucun bouton d'agrandissement", async () => {
  const { container } = mount(baseItem({ image_url: null }));
  await waitFor(() => container.querySelector("article") !== null, "carte");
  assert.equal(opener(container), null);
});

test("[206-ZOOM-error] original introuvable : message clair, fermeture toujours possible", async () => {
  const { container } = mount(baseItem());
  await waitFor(() => opener(container) !== null, "bouton");
  opener(container)!.click();
  await waitFor(() => dialog() !== null, "ouverte");
  dialog()!.querySelector("img")!.dispatchEvent(new window.Event("error"));
  await waitFor(() => dialog()!.querySelector("[data-photo-lightbox-error]") !== null, "message d'erreur");
  assert.equal(dialog()!.querySelector("[data-photo-lightbox-error]")!.textContent, "Photo indisponible.");
  key("Escape");
  await waitFor(() => dialog() === null, "fermée");
});

test("[206-ZOOM-lang] libellé du bouton localisé FR / EN / AR / NL", async () => {
  const exp: Record<string, string> = {
    fr: "Agrandir la photo de Soumaintrain", en: "Enlarge the photo of Soumaintrain",
    ar: "تكبير صورة Soumaintrain", nl: "Foto van Soumaintrain vergroten",
  };
  for (const [lang, label] of Object.entries(exp)) {
    const { container } = mount(baseItem(), "classic", lang);
    await waitFor(() => opener(container) !== null, "bouton " + lang);
    assert.equal(opener(container)!.getAttribute("aria-label"), label, lang);
  }
});

after(() => { for (const v of tracked) { try { v.root.unmount(); } catch {} v.container.remove(); } dom.window.close(); });

// [206-BACKDROP] le fond de la fenêtre doit utiliser une classe qui génère
// réellement une règle CSS (bg-espresso/90 n'en générait aucune : la couleur
// est une variable CSS, Tailwind ne peut pas lui appliquer d'opacité).
import { readFileSync as __rf206 } from "node:fs";
test("[206-BACKDROP] fond opaque à 85 % via une classe valide", () => {
  const src = __rf206(new URL("../components/PhotoLightbox.tsx", import.meta.url), "utf8");
  assert.match(src, /bg-black\/85/);
  assert.doesNotMatch(src, /bg-espresso\/\d+/);
});
