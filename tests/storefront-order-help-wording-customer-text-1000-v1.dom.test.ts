import { test, after } from "node:test";
import { autoConfirmCheckoutReview } from "./helpers/checkout-review-autoconfirm.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ============================================================
// MICRO-LOT — STOREFRONT ORDER HELP WORDING + CUSTOMER TEXT LENGTH v1
// Rendu RÉEL de la vitrine (jsdom + le vrai composant bundlé) :
//   - le libellé exact de la cartouche ET du titre de la fenêtre, dans
//     les quatre langues prises en charge ;
//   - un texte client de 1000 caractères AFFICHÉ EN ENTIER, sans
//     troncature, sans points de suspension, sans hauteur bornée.
//
// Le comportement base de données (saisie, enregistrement, projection
// publique, cliché de commande, refus de 1001) est prouvé sur la chaîne
// SQL réelle par tests/delivery-customer-text-1000-v1-sql.test.ts.
// ============================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
autoConfirmCheckoutReview(window);
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();
const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};
const buildResult = await esbuild.build({
  stdin: {
    contents: `
export { DeliveryConditionsButton, DeliveryPostcodeResult } from "@/components/DeliveryConditions";
export { I18nProvider } from "@/lib/i18n-context";
export { computeDeliveryFee, resolveDeliveryFulfillment } from "@/lib/delivery";
export { formatPrice } from "@/lib/whatsapp";
`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022",
  plugins: [aliasPlugin], external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dpt-"));
const tmpFile = path.join(tmpDir, "entry.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const mod = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });
// Même nettoyage que les tests DOM MenuView existants (v170,
// customer-collections-by-tags) : MenuView laisse des requêtes publiques
// en vol vers l'URL Supabase factice.
after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
});

const act = (React as any).act as (fn: () => unknown) => Promise<void>;

async function mount(element: unknown) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element as any); });
  return {
    container,
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    fulfillmentCode: "secret-routing-code", zonePrefixes: ["75", "92", "93100"], isFallback: false, minItems: 4,
    customerText: "Livraison à votre adresse.", customerTextHash: null, translations: null, displayOrder: 1,
    pricingMode: "free_above_threshold", fixedFee: 6.9, freeThreshold: 150,
    discountEnabled: true, discountThreshold: 120, discountPercentage: 37.5, ...overrides,
  };
}
const withI18n = (child: any, lang = "fr", sourceLanguage = "fr") => React.createElement(mod.I18nProvider, { lang, sourceLanguage }, child);

async function openConditions(rules: unknown[], lang = "fr") {
  const r = await mount(withI18n(React.createElement(mod.DeliveryConditionsButton, { rules, currency: "EUR" }), lang));
  const button = r.container.querySelector("button");
  if (button) await act(async () => { button.click(); });
  const dialog = r.container.querySelector<HTMLDialogElement>('dialog[data-delivery-dialog="conditions"]');
  return { ...r, button, dialog };
}
const blocks = (d: Element | null) => [...d!.querySelectorAll("[data-delivery-rule-card]")].map((c) => c.textContent);

const TEXT_1000 = "L".repeat(999) + "!";
const TEXT_1001 = "L".repeat(1000) + "!";

test("[SWD-01] le libellé exact est rendu sur la cartouche ET dans le titre, dans les quatre langues", async () => {
  const expected: Record<string, string> = {
    fr: "Comment passer commande",
    en: "How to order",
    nl: "Hoe bestellen",
    ar: "كيفية الطلب",
  };
  for (const [lang, label] of Object.entries(expected)) {
    const r = await openConditions([rule({ customerText: "Texte." })], lang);
    try {
      assert.equal(r.button!.textContent, label, `cartouche ${lang}`);
      assert.equal(r.dialog!.querySelector("h2")!.textContent, label, `titre ${lang}`);
      // L'ancien libellé n'apparaît nulle part dans le rendu.
      assert.ok(!r.container.innerHTML.includes("Modes et tarifs"), `ancien libellé rendu en ${lang}`);
    } finally {
      await r.unmount();
    }
  }
});

test("[SWD-02] un texte client de 1000 caractères est AFFICHÉ EN ENTIER", async () => {
  assert.equal(TEXT_1000.length, 1000);
  const r = await openConditions([rule({ customerText: TEXT_1000 })]);
  try {
    const paragraph = r.dialog!.querySelector("[data-delivery-rule-text]")!;
    assert.equal(paragraph.textContent!.length, 1000, "le texte rendu doit faire exactement 1000 caractères");
    assert.equal(paragraph.textContent, TEXT_1000, "caractère pour caractère, sans perte");
    // Aucune marque de troncature.
    assert.ok(!paragraph.textContent!.includes("…"), "aucun point de suspension ajouté");
    assert.ok(!paragraph.textContent!.endsWith("..."), "aucune ellipse ASCII ajoutée");
  } finally {
    await r.unmount();
  }
});

test("[SWD-03] aucune classe ni style ne cache une partie du texte", async () => {
  const r = await openConditions([rule({ customerText: TEXT_1000 })]);
  try {
    const paragraph = r.dialog!.querySelector<HTMLElement>("[data-delivery-rule-text]")!;
    const className = paragraph.className;
    for (const forbidden of ["line-clamp", "truncate", "text-ellipsis", "overflow-hidden", "max-h-", "h-10", "h-20"]) {
      assert.ok(!className.includes(forbidden), `classe de troncature « ${forbidden} » sur le texte`);
    }
    assert.equal(paragraph.getAttribute("style"), null, "aucun style en ligne pouvant borner la hauteur");
    assert.match(className, /whitespace-pre-wrap/);
    assert.match(className, /break-words/);
    // La FENÊTRE défile ; c'est elle qui est bornée, pas le texte.
    assert.match(r.dialog!.className, /overflow-y-auto/);
  } finally {
    await r.unmount();
  }
});

test("[SWD-04] 1000 caractères avec retours à la ligne : tout est rendu, mise en forme comprise", async () => {
  const multiline = ["Ligne A", "Ligne B", "L".repeat(1000 - "Ligne A\nLigne B\n".length)].join("\n");
  assert.equal(multiline.length, 1000);
  const r = await openConditions([rule({ customerText: multiline })]);
  try {
    const paragraph = r.dialog!.querySelector("[data-delivery-rule-text]")!;
    assert.equal(paragraph.textContent, multiline);
    assert.equal(paragraph.textContent!.length, 1000);
  } finally {
    await r.unmount();
  }
});

test("[SWD-05] plusieurs règles de 1000 caractères : chacune rendue en entier, dans l'ordre", async () => {
  const a = "A".repeat(1000);
  const b = "B".repeat(1000);
  const r = await openConditions([
    rule({ customerText: a, displayOrder: 1 }),
    rule({ customerText: b, displayOrder: 2 }),
  ]);
  try {
    const texts = [...r.dialog!.querySelectorAll("[data-delivery-rule-text]")].map((p) => p.textContent!);
    assert.deepEqual(texts.map((t) => t.length), [1000, 1000]);
    assert.deepEqual(texts, [a, b]);
  } finally {
    await r.unmount();
  }
});

test("[SWD-06] la vitrine n'est pas l'endroit où la borne s'applique : elle AFFICHE ce que la base a accepté", async () => {
  // Un texte de 1001 caractères ne peut pas exister en base (CHECK +
  // garde RPC, prouvés dans le test SQL). S'il arrivait tout de même
  // ici, la vitrine ne doit NI le couper NI le refuser : elle affiche,
  // et la borne reste là où elle est opposable -- à l'écriture.
  const r = await openConditions([rule({ customerText: TEXT_1001 })]);
  try {
    const paragraph = r.dialog!.querySelector("[data-delivery-rule-text]")!;
    assert.equal(paragraph.textContent!.length, 1001, "affiché tel quel, jamais tronqué par la vitrine");
  } finally {
    await r.unmount();
  }
});

// ====================================================================
// MICRO-LOT UX — CENTER ORDER HELP BUTTON
// La cartouche garde sa géométrie (pleine largeur, mêmes bordure, fond,
// hauteur, marges) ; SEUL son libellé est centré. La fenêtre qui
// s'ouvre au clic garde son texte et son alignement.
// ====================================================================

test("[CB-01] le libellé de la cartouche est CENTRÉ, et rien d'autre ne bouge", async () => {
  const r = await openConditions([rule({ customerText: "Texte." })]);
  try {
    const cls = r.button!.className;
    assert.match(cls, /\btext-center\b/, "le libellé doit être centré");
    assert.ok(!/\btext-(start|left|right|end)\b/.test(cls), "aucun autre alignement résiduel");
    // Géométrie INCHANGÉE : pleine largeur, même hauteur, mêmes bordure,
    // fond, rayon, espacements, graisse.
    for (const kept of [
      "min-h-11",
      "w-full",
      "rounded-xl",
      "border",
      "border-espresso/15",
      "bg-espresso/5",
      "px-4",
      "py-2.5",
      "text-sm",
      "font-semibold",
      "text-ink-on-bg",
    ]) {
      assert.ok(cls.includes(kept), `la classe « ${kept} » doit être conservée`);
    }
    // Le conteneur de la cartouche n'a pas bougé non plus.
    assert.equal(r.container.firstElementChild!.className, "mx-4 mt-3");
  } finally {
    await r.unmount();
  }
});

test("[CB-02] le CONTENU et le COMPORTEMENT du bouton sont inchangés", async () => {
  const r = await openConditions([rule({ customerText: "Texte." })]);
  try {
    assert.equal(r.button!.textContent, "Comment passer commande", "même libellé");
    assert.equal(r.button!.getAttribute("type"), "button");
    assert.equal(r.dialog!.open, true, "le clic ouvre toujours la fenêtre");
  } finally {
    await r.unmount();
  }
});

test("[CB-03] la FENÊTRE garde son texte et son alignement : rien n'y est centré", async () => {
  const r = await openConditions([rule({ customerText: "Ligne 1\nLigne 2" })]);
  try {
    const dialogHtml = r.dialog!.innerHTML;
    assert.ok(!dialogHtml.includes("text-center"), "aucun centrage introduit dans la fenêtre");
    const paragraph = r.dialog!.querySelector("[data-delivery-rule-text]")!;
    assert.equal(paragraph.className, "whitespace-pre-wrap break-words text-sm leading-relaxed");
    assert.equal(paragraph.textContent, "Ligne 1\nLigne 2");
    // Titre : mêmes classes de texte ; UX LOT 2026-10 (PR #166) y ajoute
    // `outline-none` (le titre reçoit le focus programmatique à
    // l'ouverture, sans anneau de focus visible) -- aucun centrage.
    const h2cls = r.dialog!.querySelector("h2")!.className.split(/\s+/);
    for (const c of ["text-xl", "font-bold"]) assert.ok(h2cls.includes(c), `classe ${c} attendue sur le titre`);
    assert.ok(!h2cls.some((c) => /text-(center|start|left|right)/.test(c)), "titre jamais centré/réaligné");
  } finally {
    await r.unmount();
  }
});

test("[CB-04] le centrage ne dépend d'aucune largeur : même classe en mobile et en desktop", async () => {
  // `text-center` n'est pas préfixé par un point de rupture (sm:/md:/lg:)
  // et la cartouche reste `w-full` : le libellé est donc centré dans le
  // conteneur à TOUTE largeur de viewport, sans règle conditionnelle.
  const r = await openConditions([rule({ customerText: "Texte." })]);
  try {
    const cls = r.button!.className;
    assert.ok(/(^|\s)text-center(\s|$)/.test(cls), "classe non préfixée");
    assert.ok(!/(sm|md|lg|xl):text-(center|start|left)/.test(cls), "aucun centrage conditionnel");
  } finally {
    await r.unmount();
  }
});
