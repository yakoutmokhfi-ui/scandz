import { test, after } from "node:test";
import { autoConfirmCheckoutReview } from "./helpers/checkout-review-autoconfirm.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ============================================================
// DELIVERY PUBLIC TEXT v1 -- storefront contract of the
// "Comment passer commande" popup (DeliveryConditionsButton; relabelled
// by STOREFRONT ORDER HELP WORDING v1 -- same button, same dialog, same
// i18n key `deliveryConditionsTitle`).
//
// The popup renders ONLY the merchant-configured customer_text of each rule,
// resolved with the existing tCustomerNoticeText. Rules keep ALL their
// technical facts in the data (engine / postcode result use them); they are
// simply never presented here. If no rule has a (resolved) text, the button
// itself is hidden: the customer never opens an empty popup (documented
// decision, test 8).
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

test("1-3. technical details never appear: zones, postcodes, base fee, mode, threshold, min items, discount, provider, code, order", async () => {
  const r = await openConditions([rule({ displayOrder: 7 }), rule({ isFallback: true, zonePrefixes: [], displayOrder: 8, fulfillmentCode: "fallback-code", customerText: "Autres zones." })]);
  try {
    const html = r.dialog!.innerHTML;
    const text = r.dialog!.textContent!;
    assert.deepEqual(blocks(r.dialog), ["Livraison à votre adresse.", "Autres zones."]);
    for (const forbidden of [
      "75", "92", "93100", "Codes postaux", "Autres codes postaux", "préfixe",                       // zones / postcodes / fallback label
      mod.formatPrice(6.9, "EUR"), mod.formatPrice(150, "EUR"), mod.formatPrice(120, "EUR"), "6.90", "6,90", // base fee, thresholds
      "Offerte", "Min.", "articles", "−37.5", "37.5", "37,5", "%", "remise", "Remise",                  // free-from, min items, discount
      "secret-routing-code", "fallback-code", "internal", "stuart", "chronofresh", "other_external",     // provider / fulfillment code
    ]) {
      assert.ok(!text.includes(forbidden) && !html.includes(forbidden), `"${forbidden}" ne doit pas apparaître`);
    }
    assert.equal(r.dialog!.querySelectorAll("h3,[data-delivery-rule-conditions]").length, 0, "plus d'en-tête de règle ni de ligne de conditions");
    assert.doesNotMatch(html, /data-(display-order|fulfillment|rule-id|zone)/i);
    assert.equal(r.dialog!.querySelector("h2")!.textContent, "Comment passer commande", "libellé de vitrine (STOREFRONT ORDER HELP WORDING v1)");
  } finally { await r.unmount(); }
});

test("4. customer_text only: one text -> one block with exactly that text (whitespace and line breaks preserved)", async () => {
  const r = await openConditions([rule({ customerText: "Ligne 1\nLigne 2" })]);
  try {
    assert.deepEqual(blocks(r.dialog), ["Ligne 1\nLigne 2"]);
    assert.match(r.dialog!.querySelector("[data-delivery-rule-text]")!.className, /whitespace-pre-wrap/);
  } finally { await r.unmount(); }
});

test("5. several non-empty texts -> separate blocks sorted by display_order (input order irrelevant)", async () => {
  const r = await openConditions([
    rule({ displayOrder: 30, customerText: "C" }), rule({ displayOrder: 10, customerText: "A" }),
    rule({ displayOrder: 20, customerText: "B" }), rule({ displayOrder: 25, customerText: " \n " }),
  ]);
  try {
    assert.deepEqual(blocks(r.dialog), ["A", "B", "C"]);
    assert.equal(r.dialog!.querySelectorAll("[data-delivery-rule-card]").length, 3, "un bloc distinct par texte");
  } finally { await r.unmount(); }
});

test("6. global text in the first rule, the others empty -> only that text is shown", async () => {
  const r = await openConditions([
    rule({ displayOrder: 1, customerText: "Livraison offerte partout, expédition sous 48 h." }),
    rule({ displayOrder: 2, customerText: null, zonePrefixes: ["13"] }), rule({ displayOrder: 3, customerText: "", isFallback: true, zonePrefixes: [] }),
  ]);
  try { assert.deepEqual(blocks(r.dialog), ["Livraison offerte partout, expédition sous 48 h."]); } finally { await r.unmount(); }
});

test("7. a rule with an empty text stays active and fully usable by the (unchanged) engine", async () => {
  const withText = [rule({ customerText: "Texte." })];
  const empty = [rule({ customerText: null })];
  for (const [postal, count, subtotal] of [["75001", 5, 10], ["75001", 5, 150], ["75001", 2, 10], ["13001", 5, 10]] as const) {
    const a = mod.resolveDeliveryFulfillment(withText, postal, count, subtotal);
    const b = mod.resolveDeliveryFulfillment(empty, postal, count, subtotal);
    // Only the text itself may differ; every eligibility / fee / matching field is identical.
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === "customerText" ? undefined : v)));
    assert.deepEqual(strip(b), strip(a), `engine result identical with/without text (${postal}, ${count}, ${subtotal})`);
  }
  const hit = mod.resolveDeliveryFulfillment(empty, "75001", 5, 10);
  assert.equal(hit.eligible, true);
  assert.equal(hit.deliveryFee, mod.computeDeliveryFee({ ...empty[0], discountEnabled: true }, 10), "fee computed by computeDeliveryFee, not by the popup");
  assert.equal(mod.resolveDeliveryFulfillment(empty, "75001", 2, 10).eligible, false, "minimum items still enforced for the empty-text rule");
  // and the popup simply shows nothing for it while another rule's text remains
  const r = await openConditions([rule({ customerText: null, displayOrder: 1 }), rule({ customerText: "Visible.", displayOrder: 2 })]);
  try { assert.deepEqual(blocks(r.dialog), ["Visible."]); } finally { await r.unmount(); }
});

test("8. rules exist but ALL resolved texts are empty -> the button is hidden entirely (no empty popup)", async () => {
  for (const rules of [
    [rule({ customerText: null })], [rule({ customerText: "" })], [rule({ customerText: "  \n\t " })],
    [rule({ customerText: null }), rule({ customerText: "   ", displayOrder: 2 })], [],
  ]) {
    const r = await openConditions(rules);
    try {
      assert.equal(r.container.querySelector("button"), null, "aucun bouton");
      assert.equal(r.container.querySelector("dialog"), null, "aucune fenêtre vide");
      assert.equal(r.container.textContent, "");
    } finally { await r.unmount(); }
  }
});

test("9. translated customer_text uses the existing resolution (validated translation, source fallback, no stale hash)", async () => {
  const translated = rule({ customerText: "Livraison à votre adresse.", customerTextHash: "h1",
    translations: { en: { customer_text: "Delivered to your address.", customer_text_status: "validated", customer_text_source_hash: "h1" } } });
  const en = await openConditions([translated], "en");
  try { assert.deepEqual(blocks(en.dialog), ["Delivered to your address."]); } finally { await en.unmount(); }
  const fr = await openConditions([translated], "fr");
  try { assert.deepEqual(blocks(fr.dialog), ["Livraison à votre adresse."]); } finally { await fr.unmount(); }
  const stale = { ...translated, customerTextHash: "h2" };
  const old = await openConditions([stale], "en");
  try { assert.doesNotMatch(old.dialog!.textContent ?? "", /Delivered to your address/, "traduction périmée jamais présentée"); } finally { await old.unmount(); }
  // The popup resolves through the very same function as the postcode result.
  const mixed = await openConditions([translated, rule({ displayOrder: 2, customerText: "Sans traduction." })], "en");
  try { assert.equal(blocks(mixed.dialog)![0], "Delivered to your address."); } finally { await mixed.unmount(); }
});

async function postcodeDialog(status: Record<string, unknown>, subtotal = 150) {
  const r = await mount(withI18n(React.createElement(mod.DeliveryPostcodeResult, {
    active: true, contextKey: "k", postcode: "75013", subtotal, currency: "EUR",
    status: { eligible: true, block: null, missing: null, customerNotice: null, customerNoticeHash: null, customerNoticeTranslations: null, discountPolicy: null, ...status },
  })));
  await act(async () => { await new Promise((res) => setTimeout(res, 400)); });
  const dialog = r.container.querySelector<HTMLDialogElement>('dialog[data-delivery-dialog="postcode"]')!;
  return { ...r, dialog };
}

test("10. postcode result is preserved: availability, real fee, discount applied, missing items, matched rule customer_text", async () => {
  const ok = await postcodeDialog({ deliveryFee: 4.31, pricingUnavailable: false, customerNotice: "Livraison à votre adresse.",
    discountPolicy: { discountEnabled: true, discountThreshold: 120, discountPercentage: 37.5 } });
  try {
    const text = ok.dialog.textContent!;
    assert.ok(ok.dialog.hasAttribute("open"));
    assert.ok(text.includes(`Disponible — ${mod.formatPrice(4.31, "EUR")}`), "disponibilité + frais réel");
    assert.match(text, /37[.,]5 ?%/, "remise appliquée visible dans le résultat");
    assert.ok(text.includes("Livraison à votre adresse."), "texte de la règle appariée");
  } finally { await ok.unmount(); }
  const below = await postcodeDialog({ deliveryFee: 6.9, pricingUnavailable: false, block: "below-min", missing: 3, eligible: true });
  try { assert.match(below.dialog.textContent!, /3/); assert.ok(below.dialog.textContent!.toLowerCase().includes("article")); } finally { await below.unmount(); }
  const no = await postcodeDialog({ eligible: false });
  try { assert.match(no.dialog.textContent!, /indisponible|pas disponible|non disponible/i); } finally { await no.unmount(); }
});

test("11. the popup does not read pricing at all: changing every technical field leaves its DOM unchanged", async () => {
  const base = await openConditions([rule()]);
  const html1 = base.dialog!.innerHTML.replace(/:r[0-9a-v]+:|_r_[0-9a-z]+_/g, "ID");
  await base.unmount();
  const mutated = await openConditions([rule({ zonePrefixes: ["01"], fixedFee: 99, freeThreshold: 1, minItems: 9, pricingMode: "fixed",
    discountEnabled: false, discountThreshold: null, discountPercentage: null, fulfillmentCode: "other", isFallback: true })]);
  const html2 = mutated.dialog!.innerHTML.replace(/:r[0-9a-v]+:|_r_[0-9a-z]+_/g, "ID");
  await mutated.unmount();
  assert.equal(html2, html1);
});
