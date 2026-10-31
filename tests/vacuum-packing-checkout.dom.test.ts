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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-vacuum-checkout-"));
const tmpFile = path.join(tmpDir, "CartPanel.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CartPanel, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });


function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function click(element: Element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

const FR_LABEL = "Mettre mes fromages et charcuteries sous vide";
const FR_INFO = "La mise sous vide aide à protéger les fromages et les charcuteries et à préserver leur qualité pendant le transport.";
const EN_LABEL = "Vacuum-pack my cheeses and deli meats";
const EN_INFO = "Vacuum packing helps protect the cheeses and deli meats and preserve their quality during transport.";

const restaurant = {
  id: "r-vac", name: "Vac", slug: "vac", is_active: true, created_at: "2026-01-01T00:00:00Z",
  config: { restaurant_id: "r-vac", max_tables: 10, currency: "EUR", whatsapp_number: null, address: "1 rue du Test", latitude: null, longitude: null, logo_url: null, cover_url: null, opening_hours: null, source_language: "fr" },
  categories: [], hiddenCategories: [],
  activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }, { code: "en", label: "English", dir: "ltr", display_order: 2 }],
};
const item = { id: "p1", category_id: "c1", name: "Comté", description: null, short_description: null, price: 10, image_url: null, display_order: 1, is_available: true };

function props(over: Record<string, unknown> = {}) {
  return {
    restaurant,
    lines: [{ key: "p1", item, quantity: 1 }],
    totalCount: 1, totalPrice: 10, tableNumber: null, serviceMode: "pickup", fulfillmentSelectionSeq: 0,
    deliveryStatus: { eligible: true }, deliveryCustomerNotice: null, displayItems: [], fieldRequirementsReady: true,
    availableServiceModes: ["pickup"], saleModesState: { status: "loaded", data: [] },
    customer: { name: "Client", firstName: "", lastName: "", phone: "", email: "", street: "", postalCode: "", city: "" },
    customerErrors: {}, showErrors: false,
    invoiceRequest: { wantsInvoice: false, invoiceType: "individual", addressLine1: "", addressLine2: "", city: "", postalCode: "", country: "", companyLegalName: "", vatNumber: "", contactName: "", contactEmail: "" },
    invoiceRequestErrors: {}, onChangeInvoiceRequest: () => {},
    note: "", canSubmit: true, isSubmitting: false, submitError: null,
    invoiceRequestError: null, isRetryingInvoice: false, onRetryInvoiceRequest: () => {},
    onChangeQuantity: () => {}, onSelectTable: () => {}, onSelectFulfillment: () => {}, onChangeCustomer: () => {}, onChangeNote: () => {},
    cgvEnforced: false, cgvAccepted: false, onChangeCgvAccepted: () => {}, cgvLegalHref: null,
    onSendOrder: async () => {}, onClose: () => {},
    ...over,
  };
}

async function render(panelProps: Record<string, unknown>, lang = "fr") {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(I18nProvider, {
      lang, sourceLanguage: "fr",
      activeLanguages: [{ code: "fr", dir: "ltr" }, { code: "en", dir: "ltr" }],
      children: React.createElement(CartPanel, panelProps),
    })
  );
  await flush();
  return { container, root, done() { root.unmount(); container.remove(); } };
}
const option = (c: Element) => c.querySelector("[data-vacuum-packing-option]");
const checkbox = (c: Element) => c.querySelector("[data-vacuum-packing-checkbox]") as HTMLInputElement | null;
const infoButton = (c: Element) => c.querySelector("[data-vacuum-packing-info-button]") as HTMLButtonElement | null;

test("[VP-UI-1] sans article éligible : AUCUNE case (comportement historique)", async () => {
  for (const extra of [{}, { vacuumPackingAvailable: false }]) {
    const v = await render(props(extra));
    assert.equal(option(v.container) === null, true);
    assert.equal(v.container.textContent!.includes(FR_LABEL), false);
    v.done();
  }
});

test("[VP-UI-2] article éligible : case présente, DÉCOCHÉE par défaut, libellé FR exact", async () => {
  const v = await render(props({ vacuumPackingAvailable: true, vacuumPacking: false, onChangeVacuumPacking: () => {} }));
  const box = checkbox(v.container)!;
  assert.ok(box, "case attendue");
  assert.equal(box.checked, false);
  const label = v.container.querySelector(`label[for="${box.id}"]`)!;
  assert.equal(label.textContent, FR_LABEL);
  v.done();
});

test("[VP-UI-3] placement : APRÈS la demande de facture, dans la zone de saisie (avant le récapitulatif)", async () => {
  const v = await render(props({ vacuumPackingAvailable: true, onChangeVacuumPacking: () => {}, note: "" }));
  const invoice = [...v.container.querySelectorAll("label")].find((e) => /Besoin d'une facture/.test(e.textContent ?? ""))!;
  assert.ok(invoice, "bloc facture attendu");
  const opt = option(v.container)!;
  assert.ok(invoice.compareDocumentPosition(opt) & window.Node.DOCUMENT_POSITION_FOLLOWING, "la case suit la facture");
  assert.ok(opt.closest("[data-checkout-edit]"), "dans la zone de saisie");
  assert.equal(v.container.querySelector("[data-checkout-review]") === null, true, "le récapitulatif n'est pas encore affiché");
  v.done();
});

test("[VP-UI-4] cocher / décocher remonte le choix", async () => {
  const seen: boolean[] = [];
  const v = await render(props({ vacuumPackingAvailable: true, vacuumPacking: false, onChangeVacuumPacking: (b: boolean) => seen.push(b) }));
  click(checkbox(v.container)!);
  assert.deepEqual(seen, [true]);
  v.done();
  const w = await render(props({ vacuumPackingAvailable: true, vacuumPacking: true, onChangeVacuumPacking: (b: boolean) => seen.push(b) }));
  assert.equal(checkbox(w.container)!.checked, true);
  click(checkbox(w.container)!);
  assert.deepEqual(seen, [true, false]);
  w.done();
});

test("[VP-UI-5] bouton « i » : vrai <button>, nom accessible, aria-expanded/aria-controls, texte exact, Échap", async () => {
  const v = await render(props({ vacuumPackingAvailable: true, onChangeVacuumPacking: () => {} }));
  const btn = infoButton(v.container)!;
  assert.equal(btn.tagName, "BUTTON");
  assert.equal(btn.getAttribute("type"), "button");
  assert.notEqual(btn.getAttribute("tabindex"), "-1", "atteignable au clavier");
  assert.ok((btn.getAttribute("aria-label") ?? "").length > 3, "nom accessible");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  const info = window.document.getElementById(btn.getAttribute("aria-controls")!) as HTMLElement | null;
  assert.ok(info, "aria-controls désigne l'explication");
  assert.equal(info!.textContent, FR_INFO);
  assert.equal(info!.hidden, true);

  click(btn); await flush();
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(info!.hidden, false);
  assert.equal(checkbox(v.container)!.getAttribute("aria-describedby"), info!.id, "lié à la case quand ouvert");

  btn.focus();
  btn.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(info!.hidden, true);
  assert.equal(window.document.activeElement === btn, true, "focus rendu au bouton");
  v.done();
});

test("[VP-UI-6] anglais : libellé, bouton et explication traduits à l'identique du texte validé", async () => {
  const v = await render(props({ vacuumPackingAvailable: true, onChangeVacuumPacking: () => {} }), "en");
  const box = checkbox(v.container)!;
  assert.equal(v.container.querySelector(`label[for="${box.id}"]`)!.textContent, EN_LABEL);
  assert.equal(v.container.querySelector("[data-vacuum-packing-info]")!.textContent, EN_INFO);
  assert.equal(infoButton(v.container)!.getAttribute("aria-label"), "More information about vacuum packing");
  v.done();
});

test("[VP-UI-7] mode table : jamais de case ; récapitulatif : ligne présente seulement si coché", async () => {
  const t = await render(props({ serviceMode: "table", tableNumber: 3, availableServiceModes: ["table"], vacuumPackingAvailable: true, vacuumPacking: true, onChangeVacuumPacking: () => {} }));
  assert.equal(option(t.container) === null, true);
  t.done();

  for (const [checked, expected] of [[true, true], [false, false]] as const) {
    const v = await render(props({ vacuumPackingAvailable: true, vacuumPacking: checked, onChangeVacuumPacking: () => {}, onSendOrder: async () => {} }));
    const send = [...v.container.querySelectorAll("button")].find((b) => /Valider la commande|Vérifier ma commande|Enregistrer et continuer/.test(b.textContent ?? ""))!;
    if (!send) throw new Error("boutons: " + [...v.container.querySelectorAll("button")].map((b) => b.textContent).join(" | "));
    click(send); await flush(30);
    assert.ok(v.container.querySelector("[data-checkout-review]"), "récapitulatif ouvert");
    assert.equal(v.container.querySelector("[data-checkout-review-vacuum]") !== null, expected);
    v.done();
  }
});

after(() => dom.window.close());
