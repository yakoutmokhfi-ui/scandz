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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-checkout-ux-a11y-"));
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
    candidate.textContent?.includes("Vérifier ma commande")
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

// --------------------------------------------------------------------
// Correctif Chateaubriand (audit PR #119) : le message d'erreur du
// panneau facture (bg-white/50, translucide) doit porter la classe
// dédiée text-error-on-invoice-panel -- preuve par rendu RÉEL, pas
// seulement par lecture du code source (voir checkout-ux-a11y-v1.test.ts
// pour la preuve structurelle/de calcul).
// --------------------------------------------------------------------

test("InvoiceRequestFields : le message d'erreur, rendu dans le panneau translucide bg-white/50, porte la classe text-error-on-invoice-panel (pas text-error nu)", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(I18nProvider, {
      lang: "fr",
      sourceLanguage: "fr",
      activeLanguages: [{ code: "fr", dir: "ltr" }],
      children: React.createElement(InvoiceRequestFields, {
        info: {
          wantsInvoice: true,
          invoiceType: "company",
          addressLine1: "",
          addressLine2: "",
          city: "",
          postalCode: "",
          country: "",
          companyLegalName: "",
          vatNumber: "",
          contactName: "",
          contactEmail: "",
        },
        errors: { companyLegalName: "invoiceCompanyNameRequired" },
        onChange: () => {},
        serviceMode: "pickup",
        customer: undefined,
      }),
    })
  );
  await flush();

  const panel = container.querySelector(".bg-white\\/50");
  assert.ok(panel, "le panneau translucide bg-white/50 doit être rendu (facture demandée)");

  const errorParagraph = [...container.querySelectorAll("p")].find((p) =>
    p.className.includes("text-error-on-invoice-panel")
  );
  assert.ok(
    errorParagraph,
    "le message d'erreur du champ raison sociale doit porter text-error-on-invoice-panel"
  );
  assert.ok(panel!.contains(errorParagraph!), "ce message doit bien être rendu À L'INTÉRIEUR du panneau translucide");
  // Ne doit plus porter la classe text-error nue (calculée contre le
  // mauvais fond pour ce contexte précis) en plus de la nouvelle --
  // une seule classe de couleur d'erreur doit s'appliquer ici.
  assert.ok(
    !/(^|\s)text-error(\s|$)/.test(errorParagraph!.className),
    `ne doit pas porter text-error nu en plus, obtenu: ${errorParagraph!.className}`
  );

  root.unmount();
  container.remove();
});


function reviewConfirmButton(container: Element): HTMLButtonElement {
  const button = container.querySelector('button[data-checkout-review-confirm]') as HTMLButtonElement | null;
  assert.ok(button, "bouton de confirmation du récapitulatif attendu");
  return button!;
}

test("récapitulatif avant commande : aucun envoi avant confirmation, mode/adresse/créneau visibles et retour éditable", async () => {
  let submissions = 0;
  const view = await render(baseProps({
    serviceMode: "delivery",
    deliveryStatus: { eligible: true, deliveryFee: 4.9, pricingUnavailable: false },
    customer: { name: "Client", firstName: "", lastName: "", phone: "", email: "", street: "10 rue Exemple", postalCode: "75018", city: "Paris" },
    scheduleSummary: { date: "2026-10-30", slot_key: "11-14", starts_at: "11:00", ends_at: "14:00" },
    onSendOrder: async () => { submissions += 1; },
  }));

  sendButton(view.container).click();
  await flush();
  assert.equal(submissions, 0, "ouvrir le récapitulatif ne crée pas la commande et ne lance pas le paiement");
  let summary = view.container.querySelector("[data-checkout-review]");
  assert.ok(summary, "écran de récapitulatif affiché");
  const text = summary!.textContent ?? "";
  assert.ok(text.includes("Produit"), "article présent");
  assert.ok(text.includes("Livraison"), "mode présent");
  assert.ok(text.includes("10 rue Exemple") && text.includes("75018") && text.includes("Paris"), "adresse de livraison présente");
  assert.ok(text.includes("11:00–14:00"), "créneau choisi présent");

  const back = [...view.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Modifier ma commande"));
  assert.ok(back, "bouton de retour à la saisie présent");
  (back as HTMLButtonElement).click();
  await flush();
  assert.equal(view.container.querySelector("[data-checkout-review]"), null, "retour à la saisie");
  assert.equal(submissions, 0, "retour arrière sans créer de commande");

  sendButton(view.container).click();
  await flush();
  reviewConfirmButton(view.container).click();
  await flush();
  assert.equal(submissions, 1, "la commande ne part qu'après la confirmation explicite");
  view.root.unmount();
  view.container.remove();
});

test("récapitulatif Chronofresh date seule : aucun horaire inventé", async () => {
  const view = await render(baseProps({
    serviceMode: "delivery",
    deliveryStatus: { eligible: true, deliveryFee: 18.9, pricingUnavailable: false },
    customer: { name: "Client", firstName: "", lastName: "", phone: "", email: "", street: "2 rue Bordeaux", postalCode: "33000", city: "Bordeaux" },
    scheduleSummary: { date: "2026-10-30", slot_key: null, starts_at: null, ends_at: null },
  }));
  sendButton(view.container).click();
  await flush();
  const schedule = view.container.querySelector("[data-checkout-review-schedule]");
  assert.ok(schedule, "date de livraison présente");
  assert.match(schedule!.textContent ?? "", /30/);
  assert.doesNotMatch(schedule!.textContent ?? "", /\b\d{2}:\d{2}\b/, "aucun horaire n'est affiché");
  view.root.unmount();
  view.container.remove();
});

after(() => dom.window.close());
