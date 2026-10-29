import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).HTMLDialogElement = window.HTMLDialogElement;
(globalThis as any).Event = window.Event;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
  this.dispatchEvent(new window.Event("close"));
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();
const buildResult = await esbuild.build({
  stdin: {
    contents: `
      export { default as CartPanel } from "@/components/CartPanel";
      export { I18nProvider } from "@/lib/i18n-context";
    `,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [{
    name: "at-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find(existsSync);
        return { path: candidate ?? base };
      });
    },
  }],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-issue183-"));
const tmpFile = path.join(tmpDir, "CartPanel.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CartPanel, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error(`waitFor timeout: ${description}`);
    await flush();
  }
}

function click(element: Element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

const restaurant = {
  id: "r-notice",
  name: "Notice Test",
  slug: "notice-test",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  config: {
    restaurant_id: "r-notice",
    max_tables: 10,
    currency: "EUR",
    whatsapp_number: "+320000000",
    address: null,
    latitude: null,
    longitude: null,
    logo_url: null,
    cover_url: null,
    opening_hours: null,
    source_language: "fr",
  },
  categories: [],
  hiddenCategories: [],
  activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
};

const item = {
  id: "p1",
  category_id: "c1",
  name: "Produit",
  description: null,
  short_description: null,
  price: 10,
  image_url: null,
  display_order: 1,
  is_available: true,
};

const RULE_TEXT = "Livraison locale après préparation.";
const STATUS = { eligible: true, zone: { code: "75", label: RULE_TEXT }, deliveryFee: 5, customerNotice: RULE_TEXT };
const COUNTRY = { countryCode: "FR", countryName: "France", postalCodePattern: "^\\d{5}$", phonePattern: null, addressProvider: "manual", addressLineOrder: "number-first" };

function props(notice: null | { modeCode: "pickup" | "delivery"; modeLabel: string; message: string }, onSendOrder: () => Promise<void>) {
  return {
    restaurant,
    lines: [{ key: "p1", item, quantity: 1 }],
    totalCount: 1,
    totalPrice: 10,
    tableNumber: null,
    serviceMode: notice?.modeCode ?? "pickup",
    fulfillmentSelectionSeq: 0,
    deliveryStatus: STATUS,
    deliveryCountry: COUNTRY,
    deliveryPricingReady: true,
    deliveryCustomerNotice: notice,
    displayItems: [],
    fieldRequirementsReady: true,
    availableServiceModes: [notice?.modeCode ?? "pickup"],
    saleModesState: { status: "loaded", data: [] },
    // CFTE v1 : CustomerInfo porte désormais firstName/lastName (champs
    // de SAISIE, aucune colonne persistante). Vides ici -- ce test ne
    // concerne que l'avis de délai de livraison, inchangé.
    customer: { name: "Client", firstName: "", lastName: "", phone: "", email: "", street: "", postalCode: "75015", city: "" },
    customerErrors: {},
    showErrors: false,
    invoiceRequest: { wantsInvoice: false, invoiceType: "individual", addressLine1: "", addressLine2: "", city: "", postalCode: "", country: "", companyLegalName: "", vatNumber: "", contactName: "", contactEmail: "" },
    invoiceRequestErrors: {},
    onChangeInvoiceRequest: () => {},
    note: "Livrer après 18 h si possible",
    canSubmit: true,
    isSubmitting: false,
    submitError: null,
    invoiceRequestError: null,
    isRetryingInvoice: false,
    onRetryInvoiceRequest: () => {},
    onChangeQuantity: () => {},
    onSelectTable: () => {},
    onSelectFulfillment: () => {},
    onChangeCustomer: () => {},
    onChangeNote: () => {},
    cgvEnforced: false,
    cgvAccepted: false,
    onChangeCgvAccepted: () => {},
    cgvLegalHref: null,
    onSendOrder,
    onClose: () => {},
  };
}

async function render(panelProps: ReturnType<typeof props>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(I18nProvider, {
      lang: "fr",
      sourceLanguage: "fr",
      activeLanguages: [{ code: "fr", dir: "ltr" }],
      children: React.createElement(CartPanel, panelProps),
    })
  );
  await flush();
  return { container, root };
}

function sendButton(container: Element): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Enregistrer et continuer")
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "bouton d'envoi attendu");
  return button!;
}


const NOTICE = { modeCode: "delivery" as const, modeLabel: "Stuart", message: "Livraison locale après préparation." };

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * ISSUE #183 -- DÉCISION PRODUIT (commentaire 6499817662) :
 *  1. le texte de la règle de livraison n'est présenté qu'UNE fois, dans la
 *     fenêtre « Livraison — <code postal> » (plus de texte vert en ligne) ;
 *  2. la fenêtre « Délai et informations de livraison » ne s'ouvre plus après
 *     le choix du créneau ; rien n'est répété dans le récapitulatif.
 */
test("[#183-1] code postal saisi : le texte de la règle n'apparaît qu'une fois, dans la fenêtre", async () => {
  const view = await render(props(NOTICE, async () => {}));
  const dialog = () => view.container.querySelector('[data-delivery-dialog="postcode"]')!;
  await waitFor(() => !!dialog() && dialog().hasAttribute("open"), "fenêtre code postal ouverte");
  assert.ok(dialog().textContent?.includes("Livraison — 75015"));
  assert.ok(dialog().textContent?.includes(RULE_TEXT), "la fenêtre porte le texte de la règle");
  assert.equal(occurrences(view.container.textContent ?? "", RULE_TEXT), 1, "texte de la règle présenté UNE seule fois");
  const inlineStatus = [...view.container.querySelectorAll('[role="status"]')].filter((el) => !el.closest("dialog"));
  assert.equal(inlineStatus.some((el) => el.textContent?.includes(RULE_TEXT)), false, "aucun message vert en ligne ne répète le texte");
  view.root.unmount();
  view.container.remove();
});

test("[#183-2] après le choix du créneau : aucune fenêtre de délai, récapitulatif sans répétition", async () => {
  let submissions = 0;
  const view = await render(props(NOTICE, async () => { submissions += 1; }));
  click(sendButton(view.container));
  await waitFor(() => view.container.querySelector("[data-checkout-review]") !== null, "récapitulatif affiché");
  await flush(400);
  assert.equal(view.container.querySelector("[data-delivery-timing-notice]") === null, true, "la fenêtre de délai n'existe plus dans le parcours");
  assert.equal(view.container.querySelectorAll("dialog[open]").length, 0, "aucun dialogue ouvert (ni délai, ni code postal)");
  assert.equal(submissions, 0, "rien n'est envoyé avant la confirmation du récapitulatif");
  const review = view.container.querySelector("[data-checkout-review]")!;
  assert.equal(review.textContent?.includes(NOTICE.message), false, "le texte de délai n'est pas répété dans le récapitulatif");
  view.root.unmount();
  view.container.remove();
});

test("[#183-3] repli : sans texte de règle, le message neutre reste affiché (non porté par la fenêtre)", async () => {
  const noLabel = props(NOTICE, async () => {});
  (noLabel as any).deliveryStatus = { eligible: true, zone: { code: "75", label: null }, deliveryFee: 5, customerNotice: null };
  const view = await render(noLabel);
  const inlineStatus = [...view.container.querySelectorAll('[role="status"]')].filter((el) => !el.closest("dialog"));
  assert.ok(inlineStatus.length >= 1, "le message de repli reste rendu en ligne");
  view.root.unmount();
  view.container.remove();
});

after(() => dom.window.close());
