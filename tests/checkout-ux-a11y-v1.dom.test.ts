import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// CHECKOUT UX/A11Y MICRO-LOT (issue #11, CIO) -- rendu réel du bouton
// "Valider la commande" dans CartPanel : gris net et désactivé tant
// que la commande n'est pas effectivement validable (CGV comprises),
// vert net dès que toutes les conditions sont réunies. Même harnais
// (esbuild + jsdom) que tests/delivery-delay-checkout.dom.test.ts,
// réutilisé tel quel.
// ====================================================================

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-checkout-ux-a11y-"));
const tmpFile = path.join(tmpDir, "CartPanel.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CartPanel, I18nProvider } = await import(pathToFileURL(tmpFile).href);
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

async function render(panelProps: ReturnType<typeof baseProps>) {
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

test("CGV non exigées : commande déjà validable -- bouton vert, actif", async () => {
  const view = await render(baseProps({ cgvEnforced: false, cgvAccepted: false }));
  const button = sendButton(view.container);
  assert.equal(button.disabled, false, "aucune CGV à exiger -- le bouton doit être actif");
  assert.ok(button.className.includes("bg-green-700"), `classe attendue bg-green-700, obtenu: ${button.className}`);
  assert.ok(!button.className.includes("bg-stone-300"), "ne doit pas porter la classe grise à l'état actif");
  view.root.unmount();
  view.container.remove();
});

test("CGV exigées, non acceptées : bouton gris net, désactivé -- aucune soumission possible au clic", async () => {
  let submissions = 0;
  const view = await render(
    baseProps({
      cgvEnforced: true,
      cgvAccepted: false,
      onSendOrder: async () => { submissions += 1; },
    })
  );
  const button = sendButton(view.container);
  assert.equal(button.disabled, true, "CGV non acceptées -- le bouton doit être désactivé");
  assert.ok(button.className.includes("bg-stone-300"), `classe attendue bg-stone-300, obtenu: ${button.className}`);
  assert.ok(!button.className.includes("bg-green-700"), "ne doit pas porter la classe verte tant que les CGV ne sont pas acceptées");
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(submissions, 0, "un bouton natif désactivé ne doit déclencher aucune soumission");
  view.root.unmount();
  view.container.remove();
});

test("CGV exigées ET acceptées : bouton redevient vert, actif", async () => {
  const view = await render(baseProps({ cgvEnforced: true, cgvAccepted: true }));
  const button = sendButton(view.container);
  assert.equal(button.disabled, false, "CGV acceptées -- le bouton doit redevenir actif");
  assert.ok(button.className.includes("bg-green-700"), `classe attendue bg-green-700, obtenu: ${button.className}`);
  assert.ok(!button.className.includes("bg-stone-300"), "ne doit plus porter la classe grise une fois les CGV acceptées");
  view.root.unmount();
  view.container.remove();
});

test("Note de commande trop longue : le compteur passe en text-error, le textarea en pastille rouge fixe", async () => {
  const longNote = "x".repeat(2000);
  const view = await render(baseProps({ note: longNote }));
  const counter = [...view.container.querySelectorAll("p")].find((p) =>
    p.className.includes("text-error")
  );
  assert.ok(counter, "le compteur de note doit basculer en text-error quand la note dépasse la limite");
  const textarea = view.container.querySelector("#order-note");
  assert.ok(textarea, "le champ de note doit exister");
  assert.ok(
    (textarea as HTMLElement).className.includes("border-red-500") &&
      (textarea as HTMLElement).className.includes("bg-red-50"),
    `pastille rouge fixe attendue sur le textarea invalide, obtenu: ${(textarea as HTMLElement).className}`
  );
  view.root.unmount();
  view.container.remove();
});

test("Erreur de soumission : bandeau rouge (bg-red-50/text-red-800), plus amber", async () => {
  const view = await render(baseProps({ submitError: "Le serveur a refusé la commande." }));
  const banner = [...view.container.querySelectorAll("p")].find((p) =>
    p.textContent === "Le serveur a refusé la commande."
  );
  assert.ok(banner, "le bandeau d'erreur de soumission doit être affiché");
  assert.ok((banner as HTMLElement).className.includes("bg-red-50"));
  assert.ok((banner as HTMLElement).className.includes("text-red-800"));
  assert.ok(!(banner as HTMLElement).className.includes("amber"));
  view.root.unmount();
  view.container.remove();
});

after(() => dom.window.close());
