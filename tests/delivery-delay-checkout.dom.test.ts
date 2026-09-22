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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-delivery-checkout-"));
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

function props(notice: null | { modeCode: "pickup" | "delivery"; modeLabel: string; message: string }, onSendOrder: () => Promise<void>) {
  return {
    restaurant,
    lines: [{ key: "p1", item, quantity: 1 }],
    totalCount: 1,
    totalPrice: 10,
    tableNumber: null,
    serviceMode: notice?.modeCode ?? "pickup",
    fulfillmentSelectionSeq: 0,
    deliveryStatus: { eligible: true },
    deliveryCustomerNotice: notice,
    displayItems: [],
    fieldRequirementsReady: true,
    availableServiceModes: [notice?.modeCode ?? "pickup"],
    saleModesState: { status: "loaded", data: [] },
    // CFTE v1 : CustomerInfo porte désormais firstName/lastName (champs
    // de SAISIE, aucune colonne persistante). Vides ici -- ce test ne
    // concerne que l'avis de délai de livraison, inchangé.
    customer: { name: "Client", firstName: "", lastName: "", phone: "", email: "", street: "", postalCode: "", city: "" },
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

for (const configured of [
  { modeCode: "pickup" as const, modeLabel: "Click & Collect", message: "Retrait disponible sous 2 heures." },
  { modeCode: "delivery" as const, modeLabel: "Stuart", message: "Livraison locale après préparation." },
  { modeCode: "delivery" as const, modeLabel: "Chronofresh", message: "Expédition réfrigérée sous 48 heures." },
]) {
  test(`${configured.modeLabel}: le message configuré est montré avant toute soumission`, async () => {
    let submissions = 0;
    const view = await render(props(configured, async () => { submissions += 1; }));
    click(sendButton(view.container));
    const dialog = view.container.querySelector("[data-delivery-timing-notice]")!;
    await waitFor(() => dialog.hasAttribute("open"), `${configured.modeLabel} notice open`);
    assert.equal(submissions, 0, "create-order callback ne doit pas partir avant confirmation");
    assert.ok(dialog.textContent?.includes(configured.modeLabel));
    assert.ok(dialog.textContent?.includes(configured.message));
    assert.ok(view.container.querySelector("#order-note"), "le champ de notes reste disponible");
    view.root.unmount();
    view.container.remove();
  });
}

test("confirmation rapide répétée : une seule soumission", async () => {
  let submissions = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const view = await render(props(
    { modeCode: "pickup", modeLabel: "Click & Collect", message: "Prêt bientôt." },
    async () => { submissions += 1; await pending; }
  ));
  click(sendButton(view.container));
  const dialog = view.container.querySelector("[data-delivery-timing-notice]")!;
  await waitFor(() => dialog.hasAttribute("open"), "notice open");
  const confirm = [...dialog.querySelectorAll("button")].at(-1)!;
  click(confirm);
  click(confirm);
  assert.equal(submissions, 1);
  release();
  await flush();
  view.root.unmount();
  view.container.remove();
});

test("message absent : soumission directe sûre, aucun popup", async () => {
  let submissions = 0;
  const view = await render(props(null, async () => { submissions += 1; }));
  click(sendButton(view.container));
  await flush();
  assert.equal(submissions, 1);
  assert.equal(view.container.querySelector("[data-delivery-timing-notice]")!.hasAttribute("open"), false);
  view.root.unmount();
  view.container.remove();
});

after(() => dom.window.close());
