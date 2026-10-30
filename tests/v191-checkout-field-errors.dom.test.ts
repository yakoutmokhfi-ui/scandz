import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// Issue #191 -- erreurs de champ du checkout : message associé au champ,
// bouton « Voir les champs à corriger », focus sur le premier champ
// invalide (ordre du document), saisies conservées, erreur serveur
// générale sans déplacement du focus. Même harnais que
// tests/checkout-ux-a11y-v1.dom.test.ts.

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
      export { default as InvoiceRequestFields } from "@/components/InvoiceRequestFields";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-191-"));
const tmpFile = path.join(tmpDir, "CartPanel.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CartPanel, InvoiceRequestFields, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const restaurant = {
  id: "r-ux-a11y",
  name: "UX A11y Test",
  slug: "ux-a11y-test",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  config: {
    restaurant_id: "r-ux-a11y",
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

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    restaurant,
    lines: [{ key: "p1", item, quantity: 1 }],
    totalCount: 1,
    totalPrice: 10,
    tableNumber: null,
    serviceMode: "pickup",
    fulfillmentSelectionSeq: 0,
    deliveryStatus: { eligible: true },
    deliveryCustomerNotice: null,
    displayItems: [],
    fieldRequirementsReady: true,
    availableServiceModes: ["pickup"],
    saleModesState: { status: "loaded", data: [] },
    customer: { name: "Client", firstName: "", lastName: "", phone: "", email: "", street: "", postalCode: "", city: "" },
    customerErrors: {},
    showErrors: false,
    invoiceRequest: { wantsInvoice: false, invoiceType: "individual", addressLine1: "", addressLine2: "", city: "", postalCode: "", country: "", companyLegalName: "", vatNumber: "", contactName: "", contactEmail: "" },
    invoiceRequestErrors: {},
    onChangeInvoiceRequest: () => {},
    note: "",
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
    onSendOrder: async () => {},
    onClose: () => {},
    ...overrides,
  };
}


const PICKUP_ITEMS = [
  { kind: "field", requirement: { field: "first_name", requirement: "required", oneOfGroup: null } },
  { kind: "field", requirement: { field: "last_name", requirement: "optional", oneOfGroup: null } },
  { kind: "field", requirement: { field: "email", requirement: "required", oneOfGroup: null } },
];

const FULL_INVOICE = {
  wantsInvoice: true, invoiceType: "individual", addressLine1: "", addressLine2: "",
  city: "", postalCode: "", country: "", companyLegalName: "", vatNumber: "",
  contactName: "", contactEmail: "",
};

// Parent minimal : détient `showErrors`, comme MenuView.
function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [showErrors, setShowErrors] = React.useState(false);
  const props = baseProps({
    ...initial,
    showErrors,
    onRevealErrors: () => setShowErrors(true),
  });
  return React.createElement(CartPanel, props);
}

async function mount(initial: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(I18nProvider, {
      lang: "fr",
      sourceLanguage: "fr",
      activeLanguages: [{ code: "fr", dir: "ltr" }],
      children: React.createElement(Harness, { initial }),
    })
  );
  await flush();
  return { container, root };
}

const revealButton = (c: Element) =>
  c.querySelector<HTMLButtonElement>("button[data-checkout-show-field-errors]");

const base191 = {
  displayItems: PICKUP_ITEMS,
  canSubmit: false,
  customer: { name: "", firstName: "", lastName: "Dupont", phone: "", email: "", street: "", postalCode: "", city: "" },
  customerErrors: { firstName: "errFirstName", email: "errEmail" },
};

test("[191-1] champs invalides : aucune erreur affichée avant action, bouton « Voir les champs à corriger », aucun envoi", async () => {
  let sent = 0;
  const { container, root } = await mount({ ...base191, onSendOrder: async () => { sent++; } });
  try {
    assert.equal(container.querySelectorAll('[aria-invalid="true"]').length, 0);
    const btn = revealButton(container);
    assert.ok(btn, "bouton attendu");
    assert.equal(btn!.textContent, "Voir les champs à corriger");
    assert.equal(sent, 0);
  } finally { root.unmount(); container.remove(); }
});

test("[191-2] clic : erreurs visibles, associées à leur champ (aria-describedby), focus sur le PREMIER champ en ordre visuel, saisies conservées", async () => {
  let sent = 0;
  const { container, root } = await mount({ ...base191, onSendOrder: async () => { sent++; } });
  try {
    revealButton(container)!.click();
    await flush();
    const first = container.querySelector<HTMLInputElement>("input#first_name")!;
    const email = container.querySelector<HTMLInputElement>("input#email")!;
    assert.equal(window.document.activeElement, first, "le focus va au premier champ invalide (prénom, avant e-mail)");
    for (const el of [first, email]) {
      assert.equal(el.getAttribute("aria-invalid"), "true");
      const id = el.getAttribute("aria-describedby");
      assert.ok(id, "aria-describedby attendu");
      const msg = container.querySelector("#" + id);
      assert.ok(msg && (msg.textContent ?? "").trim().length > 0, "message d'erreur lisible associé au champ");
    }
    // nom de famille valide : ni invalide, ni décrit par une erreur
    const last = container.querySelector<HTMLInputElement>("input#last_name")!;
    assert.equal(last.getAttribute("aria-invalid"), null);
    assert.equal(last.value, "Dupont", "la saisie existante est conservée");
    assert.equal(sent, 0, "afficher les erreurs n'envoie jamais la commande");
  } finally { root.unmount(); container.remove(); }
});

test("[191-3] un seul champ invalide : c'est lui qui reçoit le focus", async () => {
  const { container, root } = await mount({ ...base191, customerErrors: { email: "errEmail" } });
  try {
    revealButton(container)!.click();
    await flush();
    assert.equal(window.document.activeElement, container.querySelector("input#email"));
  } finally { root.unmount(); container.remove(); }
});

test("[191-4] demande de facture invalide : erreurs associées à leurs champs, focus sur le premier champ de facture en erreur", async () => {
  const { container, root } = await mount({
    displayItems: [],
    canSubmit: false,
    customerErrors: {},
    invoiceRequest: FULL_INVOICE,
    invoiceRequestErrors: { addressLine1: "invoiceAddressRequired", contactEmail: "errEmail" },
  });
  try {
    const btn = revealButton(container);
    assert.ok(btn, "le bouton existe aussi pour les erreurs de facture");
    btn!.click();
    await flush();
    const invalid = [...container.querySelectorAll<HTMLElement>('[aria-invalid="true"]')];
    assert.ok(invalid.length >= 2);
    assert.equal(window.document.activeElement, invalid[0], "premier champ invalide dans l'ordre du document");
    for (const el of invalid) {
      const id = el.getAttribute("aria-describedby");
      assert.ok(id && container.querySelector("#" + id), "message associé");
    }
  } finally { root.unmount(); container.remove(); }
});

test("[191-5] erreur serveur générale : message annoncé (role=alert), focus NON déplacé", async () => {
  const { container, root } = await mount({
    canSubmit: true, submitError: "Impossible d'enregistrer la commande.",
  });
  try {
    const before = window.document.activeElement;
    const alert = container.querySelector('[role="alert"]');
    assert.ok(alert, "role=alert attendu");
    assert.match(alert!.textContent ?? "", /Impossible d'enregistrer/);
    assert.equal(window.document.activeElement, before, "le focus n'est pas déplacé arbitrairement");
    assert.equal(revealButton(container), null);
  } finally { root.unmount(); container.remove(); }
});

test("[191-6] aucune erreur de champ (ex. mode non choisi) : pas de bouton superflu", async () => {
  const { container, root } = await mount({ canSubmit: false, customerErrors: {}, serviceMode: null });
  try {
    assert.equal(revealButton(container), null);
  } finally { root.unmount(); container.remove(); }
});

test("[191-7] aucun mouvement de focus sans demande : le focus ne bouge pas tant que le client n'a pas cliqué", async () => {
  const { container, root } = await mount(base191);
  try {
    assert.notEqual(window.document.activeElement?.id, "first_name");
    assert.notEqual(window.document.activeElement?.id, "email");
  } finally { root.unmount(); container.remove(); }
});

after(() => { window.close(); });
