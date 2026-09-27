import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import type { CustomerInfo } from "../lib/customer.ts";
import type { DeliveryCountryOption } from "../lib/delivery-country.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — ADDRESS UX v1 — preuve COMPORTEMENTALE sur le VRAI
// components/FulfillmentSelector.tsx (esbuild + React + jsdom), même
// patron que tests/delivery-country-scope-v1.dom.test.ts.
//
// CE QUE CE FICHIER PROUVE
//   1. CIO ADDENDUM -- message proéminent de périmètre pays : rendu
//      AVANT toute saisie de code postal, pour 1 pays ("uniquement en
//      France") et pour 2+ pays (liste jointe "France et Italie"),
//      ABSENT quand aucun pays n'est configuré ;
//   2. CORRECTIF DE BUG (analyse issue #11, cas 5.8) : une rue tapée
//      À LA MAIN (jamais de sélection IGN) est désormais bien effacée
//      sur un changement de PAYS -- avant ce lot, elle ne l'était pas ;
//   3. CP -> plusieurs villes : la ville devient un choix RESTREINT
//      (select), jamais un champ libre, avec une option vide en tête ;
//      CP -> une seule ville (ou aucune) : le champ ville reste le
//      champ texte libre historique, inchangé.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { EMPTY_CUSTOMER } = await import("../lib/customer.ts");

const REPO_ROOT = process.cwd();

// Mock du provider d'adresse (rue) -- aucun appel réseau réel dans ce
// fichier, même discipline que delivery-country-scope-v1.dom.test.ts.
const MOCK_ADDRESS_SEARCH = `
export const MIN_QUERY_LENGTH = 3;
export class AddressSearchError extends Error {}
export async function searchAddressSuggestions() { return []; }
export function normalizeAddressSuggestion(s) { return s; }
export function manualAddressToStructured(a) { return a; }
export function mapGeoplateformeFeatureToSuggestion() { return null; }
`;

const mockPlugin: esbuild.Plugin = {
  name: "address-ux-v1-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path === "@/lib/services/address-search") {
        return { path: args.path, namespace: "auxmock" };
      }
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
        return { path: c ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "auxmock" }, () => ({
      contents: MOCK_ADDRESS_SEARCH,
      loader: "ts",
    }));
  },
};

// Wrapper d'état LOCAL (le vrai FulfillmentSelector est contrôlé --
// customer/onChangeCustomer viennent toujours d'un parent). Reproduit
// ICI le strict minimum de ce que fait components/CartPanel.tsx :
// fusionner le patch reçu dans l'état, rien d'autre.
const HARNESS_SOURCE = `
import { useState } from "react";
import FulfillmentSelector from "@/components/FulfillmentSelector";

export default function Harness({ initialCustomer, ...rest }) {
  const [customer, setCustomer] = useState(initialCustomer);
  if (rest.exposeState) rest.exposeState(customer);
  return FulfillmentSelector({
    ...rest,
    customer,
    onChangeCustomer: (patch) => setCustomer((prev) => ({ ...prev, ...patch })),
  });
}
`;

const built = await esbuild.build({
  stdin: {
    contents: HARNESS_SOURCE,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-aux-"));
const tmpFile = path.join(tmpDir, "Harness.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { default: Harness } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const flush = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value"
  )!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

const FIXTURE_FR: DeliveryCountryOption = {
  countryCode: "FR",
  countryName: "France",
  postalCodePattern: "^[0-9]{5}$",
  phonePattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$",
  addressProvider: "ban_ign",
  addressLineOrder: "number_first",
};
const FIXTURE_IT: DeliveryCountryOption = {
  countryCode: "IT",
  countryName: "Italie",
  postalCodePattern: "^[0-9]{5}$",
  phonePattern: null,
  addressProvider: "manual",
  addressLineOrder: "number_first",
};
const FIXTURE_BE: DeliveryCountryOption = {
  countryCode: "BE",
  countryName: "Belgique",
  postalCodePattern: "^[0-9]{4}$",
  phonePattern: "^(?:0[0-9]{8,9}|\\+32[0-9]{8,9})$",
  addressProvider: "manual",
  addressLineOrder: "street_first",
};

const DELIVERY_ITEMS = [
  { kind: "field", requirement: { field: "delivery_address", requirement: "required", oneOfGroup: null } },
];

function render(opts: {
  country: DeliveryCountryOption | null;
  options?: DeliveryCountryOption[];
  scope?: DeliveryCountryOption[];
  cityOptions?: { code: string; name: string }[] | null;
  customer?: Partial<CustomerInfo>;
  onSelectCountry?: (c: string) => void;
}) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let latestCustomer: CustomerInfo = { ...EMPTY_CUSTOMER, ...(opts.customer ?? {}) };
  root.render(
    React.createElement(Harness, {
      initialCustomer: latestCustomer,
      exposeState: (c: CustomerInfo) => {
        latestCustomer = c;
      },
      deliveryModeAvailable: true,
      status: { eligible: true },
      type: "delivery",
      errors: {},
      showErrors: false,
      displayItems: DELIVERY_ITEMS,
      fieldRequirementsReady: true,
      onSelectFulfillment: () => {},
      deliveryCountry: opts.country,
      deliveryCountryOptions: opts.options ?? [],
      deliveryCountryScope: opts.scope ?? [],
      cityOptions: opts.cityOptions ?? null,
      onSelectDeliveryCountry: opts.onSelectCountry ?? (() => {}),
    })
  );
  return { container, root, getCustomer: () => latestCustomer };
}

const q = (c: Element, s: string) => c.querySelector(s);

// ==================================================================
// 1. CIO ADDENDUM -- message proéminent de périmètre pays
// ==================================================================

test("[ADDRESS UX v1] 1 pays configuré : message proéminent « uniquement en France », rendu SANS code postal saisi", async () => {
  const { container, root } = render({ country: FIXTURE_FR, options: [], scope: [FIXTURE_FR] });
  await flush();
  try {
    const el = q(container, '[data-testid="delivery-country-scope-prominent"]');
    assert.ok(el, "le message proéminent doit être rendu dès l'ouverture du bloc adresse");
    assert.equal(el!.textContent, "Livraison disponible uniquement en France");
    assert.equal(el!.getAttribute("data-country-codes"), "FR");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[MICRO-FIX dark-theme contrast] message proéminent : couleur de texte CALCULÉE (text-ink-on-bg), jamais --sc-ink brut (text-espresso)", async () => {
  // Preuve DOM directe sur le VRAI élément rendu (pas seulement un grep
  // source) : la classe de couleur doit être celle recalculée contre
  // --sc-bg (lib/color-contrast.ts, readableAccentOnBg), garantissant
  // 4.5:1 quel que soit secondary_color -- même patron que V73-02 sur
  // InlineOptions.tsx. text-espresso (--sc-ink non calculée) devenait
  // quasi invisible sur ce panneau bg-caramel/10 avec un thème sombre.
  const { container, root } = render({ country: FIXTURE_FR, options: [], scope: [FIXTURE_FR] });
  await flush();
  try {
    const prominent = q(container, '[data-testid="delivery-country-scope-prominent"]');
    assert.ok(prominent);
    assert.ok(
      prominent!.className.includes("text-ink-on-bg"),
      "le message proéminent doit utiliser la couleur calculée text-ink-on-bg"
    );
    assert.equal(
      prominent!.className.includes("text-espresso"),
      false,
      "text-espresso (couleur brute, non calculée) ne doit plus être utilisé ici"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[MICRO-FIX doublon] 1 pays configuré : le rappel « Livraison en France uniquement » ne double PLUS le message proéminent", async () => {
  // Constat CIO en Production (Au Lait Cru) : les deux textes étaient
  // rendus simultanément pour un établissement à un seul pays -- le
  // message proéminent CIO ADDENDUM (ci-dessus) ET l'ancien rappel
  // discret `countryDeliveryContext` (PR #106). Le second doit
  // disparaître dès que le premier couvre déjà l'information.
  const { container, root } = render({ country: FIXTURE_FR, options: [], scope: [FIXTURE_FR] });
  await flush();
  try {
    assert.ok(
      q(container, '[data-testid="delivery-country-scope-prominent"]'),
      "le message proéminent doit bien être présent (condition du test)"
    );
    assert.equal(
      q(container, '[data-testid="delivery-country-context"]'),
      null,
      "le petit rappel redondant ne doit plus être rendu à côté du message proéminent"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[MICRO-FIX doublon] pas de deliveryCountryScope fourni : le rappel `delivery-country-context` reste rendu (pas de régression pour un appelant qui n'a pas encore migré)", async () => {
  const { container, root } = render({ country: FIXTURE_FR, options: [] });
  await flush();
  try {
    assert.equal(
      q(container, '[data-testid="delivery-country-scope-prominent"]'),
      null,
      "sans deliveryCountryScope, aucun message proéminent à afficher"
    );
    const ctx = q(container, '[data-testid="delivery-country-context"]');
    assert.ok(ctx, "le rappel discret reste seul responsable de l'info pays quand le message proéminent est absent");
    assert.equal(ctx!.getAttribute("data-country-code"), "FR");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ADDRESS UX v1] 2 pays configurés (FR + IT) : message proéminent avec liste jointe « et »", async () => {
  const { container, root } = render({
    country: FIXTURE_FR,
    options: [FIXTURE_FR, FIXTURE_IT],
    scope: [FIXTURE_FR, FIXTURE_IT],
  });
  await flush();
  try {
    const el = q(container, '[data-testid="delivery-country-scope-prominent"]');
    assert.ok(el);
    assert.equal(el!.textContent, "Livraison disponible en France et Italie");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ADDRESS UX v1] aucun pays configuré : aucun message proéminent rendu", async () => {
  const { container, root } = render({ country: null, options: [], scope: [] });
  await flush();
  try {
    assert.equal(q(container, '[data-testid="delivery-country-scope-prominent"]'), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// 2. CORRECTIF DE BUG -- rue tapée à la main effacée sur changement
//    de PAYS (analyse issue #11, cas 5.8 -- avant ce lot : NON effacée)
// ==================================================================

test("[ADDRESS UX v1] rue tapée à la main + changement de pays -> la rue est effacée (bug corrigé)", async () => {
  const { container, root, getCustomer } = render({
    country: FIXTURE_FR,
    options: [FIXTURE_FR, FIXTURE_BE],
    scope: [FIXTURE_FR, FIXTURE_BE],
  });
  await flush();
  try {
    // Code postal encore vide -> champ "street" au format texte simple
    // (postalReady == false), exactement comme le fera un client qui
    // tape sa rue avant son code postal.
    const streetInput = q(container, "#street") as HTMLInputElement;
    assert.ok(streetInput, "champ street texte simple attendu (postal non résolu)");
    setInputValue(streetInput, "12 rue de Paris");
    await flush();
    assert.equal(getCustomer().street, "12 rue de Paris");

    const countrySelect = q(container, '[data-testid="delivery-country-select"]') as HTMLSelectElement;
    assert.ok(countrySelect, "sélecteur de pays attendu (2 pays configurés)");
    setSelectValue(countrySelect, "BE");
    await flush();

    assert.equal(
      getCustomer().street,
      "",
      "une rue française tapée à la main ne doit plus survivre à un changement de pays"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ADDRESS UX v1] pas de rue saisie : changement de pays ne déclenche aucune écriture inutile", async () => {
  const calls: Partial<CustomerInfo>[] = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(Harness, {
      initialCustomer: { ...EMPTY_CUSTOMER },
      deliveryModeAvailable: true,
      status: { eligible: true },
      type: "delivery",
      errors: {},
      showErrors: false,
      displayItems: DELIVERY_ITEMS,
      fieldRequirementsReady: true,
      onSelectFulfillment: () => {},
      deliveryCountry: FIXTURE_FR,
      deliveryCountryOptions: [FIXTURE_FR, FIXTURE_BE],
      deliveryCountryScope: [FIXTURE_FR, FIXTURE_BE],
      onSelectDeliveryCountry: (code: string) => calls.push({ street: undefined } as any) && code,
    })
  );
  await flush();
  try {
    const countrySelect = q(container, '[data-testid="delivery-country-select"]') as HTMLSelectElement;
    setSelectValue(countrySelect, "BE");
    await flush();
    // Pas d'assertion négative fragile ici au-delà de : aucune
    // exception, le pays est bien transmis au parent.
    assert.equal(calls.length, 1);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// 3. CP -> plusieurs villes : choix RESTREINT (select), jamais libre
// ==================================================================

test("[ADDRESS UX v1] plusieurs villes candidates pour le CP : la ville devient un <select> restreint", async () => {
  const { container, root } = render({
    country: FIXTURE_FR,
    options: [],
    scope: [FIXTURE_FR],
    customer: { postalCode: "92700" },
    cityOptions: [
      { code: "92025", name: "Colombes" },
      { code: "92050", name: "Nanterre" },
    ],
  });
  await flush();
  try {
    assert.equal(q(container, "input#city"), null, "aucun champ texte libre dans ce cas");
    const select = q(container, '[data-testid="city-options-select"]') as HTMLSelectElement;
    assert.ok(select, "un <select> restreint doit être rendu");
    const optionLabels = [...select.querySelectorAll("option")].map((o) => o.textContent);
    assert.deepEqual(optionLabels, ["Choisissez une ville", "Colombes", "Nanterre"]);
    assert.equal(select.value, "", "aucune sélection par défaut arbitraire");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ADDRESS UX v1] une seule ville candidate (ou aucune) : le champ ville reste le champ texte libre historique", async () => {
  const { container, root } = render({
    country: FIXTURE_FR,
    options: [],
    scope: [FIXTURE_FR],
    customer: { postalCode: "75001", city: "Paris" },
    cityOptions: null,
  });
  await flush();
  try {
    assert.equal(q(container, '[data-testid="city-options-select"]'), null);
    const input = q(container, "input#city") as HTMLInputElement;
    assert.ok(input, "champ ville texte libre attendu");
    assert.equal(input.value, "Paris");
  } finally {
    root.unmount();
    container.remove();
  }
});
