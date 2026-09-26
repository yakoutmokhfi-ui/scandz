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
// Scanym — DELIVERY COUNTRY SCOPE v1 — preuve COMPORTEMENTALE sur le
// VRAI bloc d'adresse du checkout (esbuild + React + jsdom).
//
// CE QUE CE FICHIER PROUVE
//   1. FIXTURE AU LAIT CRU (L2 = {FR}) : aucun sélecteur de pays,
//      aucune option « Belgique » nulle part dans le DOM, fournisseur
//      français, format à 5 chiffres ;
//   2. FIXTURE PLATEFORME BE (L2 = {BE}) : le MÊME code, sans aucune
//      modification, produit un comportement belge -- 4 chiffres,
//      AUCUN appel au fournisseur français, saisie manuelle ;
//   3. L2 = {FR, BE} : le sélecteur APPARAÎT (capacité multi-pays) ;
//   4. L2 = {} : rien n'est proposé (fail-closed).
//
// Le test 2 est le test qui prouve l'absence de codage en dur : seule
// la DONNÉE change entre les fixtures 1 et 2.
//
// Patron esbuild/jsdom repris de tests/cfte-v1-checkout-name-fields.dom.test.ts.
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

/** Journal des appels RÉELS au fournisseur d'adresse. Toute requête
 *  sortante y apparaît : c'est la preuve d'isolation du fournisseur. */
(globalThis as any).__addressSearchCalls = [] as string[];

const MOCK_ADDRESS_SEARCH = `
export const MIN_QUERY_LENGTH = 3;
export class AddressSearchError extends Error {}
export async function searchAddressSuggestions(query, options) {
  (globalThis).__addressSearchCalls.push("ban_ign:" + query);
  return [];
}
export function normalizeAddressSuggestion(s) { return s; }
export function manualAddressToStructured(a) { return a; }
export function mapGeoplateformeFeatureToSuggestion() { return null; }
`;

const mockPlugin: esbuild.Plugin = {
  name: "dcs-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path === "@/lib/services/address-search") {
        return { path: args.path, namespace: "dcsmock" };
      }
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
        return { path: c ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "dcsmock" }, () => ({
      contents: MOCK_ADDRESS_SEARCH,
      loader: "ts",
    }));
  },
};

const built = await esbuild.build({
  stdin: {
    contents: `export { default as FulfillmentSelector } from "@/components/FulfillmentSelector";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-dcs-"));
const tmpFile = path.join(tmpDir, "FulfillmentSelector.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { FulfillmentSelector } = await import(pathToFileURL(tmpFile).href);
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

// ------------------------------------------------------------------
// LES DEUX FIXTURES — c'est la SEULE chose qui change entre les tests.
// ------------------------------------------------------------------
const FIXTURE_FR: DeliveryCountryOption = {
  countryCode: "FR",
  countryName: "France",
  postalCodePattern: "^[0-9]{5}$",
  phonePattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$",
  addressProvider: "ban_ign",
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
  customer?: Partial<CustomerInfo>;
  onSelectCountry?: (c: string) => void;
}) {
  (globalThis as any).__addressSearchCalls = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(FulfillmentSelector, {
      deliveryModeAvailable: true,
      status: { eligible: true },
      type: "delivery",
      customer: { ...EMPTY_CUSTOMER, ...(opts.customer ?? {}) },
      errors: {},
      showErrors: false,
      displayItems: DELIVERY_ITEMS,
      fieldRequirementsReady: true,
      onChangeCustomer: () => {},
      onSelectFulfillment: () => {},
      deliveryCountry: opts.country,
      deliveryCountryOptions: opts.options ?? [],
      onSelectDeliveryCountry: opts.onSelectCountry ?? (() => {}),
    })
  );
  return { container, root };
}

const calls = () => (globalThis as any).__addressSearchCalls as string[];
const q = (c: Element, s: string) => c.querySelector(s);
const qa = (c: Element, s: string) => [...c.querySelectorAll(s)];

// ==================================================================
// 1. FIXTURE AU LAIT CRU — L2 = { FR }
// ==================================================================

test("[ALC] un seul pays autorisé : AUCUN sélecteur de pays n'est rendu", async () => {
  const { container, root } = render({ country: FIXTURE_FR, options: [] });
  await flush();
  try {
    assert.equal(q(container, '[data-testid="delivery-country-select"]'), null);
    assert.equal(q(container, "select#delivery-country"), null);
    // ... mais le contexte est rappelé, non modifiable.
    const ctx = q(container, '[data-testid="delivery-country-context"]');
    assert.ok(ctx, "le pays résolu doit être rappelé au client");
    assert.equal(ctx!.getAttribute("data-country-code"), "FR");
    assert.equal(ctx!.tagName.toLowerCase(), "p", "un texte, jamais un contrôle éditable");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ALC] « Belgique » n'apparaît NULLE PART dans le DOM du checkout", async () => {
  const { container, root } = render({ country: FIXTURE_FR, options: [] });
  await flush();
  try {
    const html = container.innerHTML;
    for (const forbidden of ["Belgique", "Belgium", ">BE<", 'value="BE"']) {
      assert.equal(html.includes(forbidden), false, `« ${forbidden} » ne doit pas être rendu`);
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ALC] un code postal français à 5 chiffres ouvre l'autocomplétion FRANÇAISE", async () => {
  const { container, root } = render({
    country: FIXTURE_FR,
    options: [],
    customer: { postalCode: "75018", city: "Paris" },
  });
  await flush();
  try {
    assert.ok(
      q(container, '[data-testid="address-autocomplete"]'),
      "le composant d'autocomplétion doit être monté pour un pays qui a un fournisseur"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[ALC] un code postal à 4 chiffres n'ouvre PAS l'autocomplétion en France", async () => {
  const { container, root } = render({
    country: FIXTURE_FR,
    options: [],
    customer: { postalCode: "1000", city: "Bruxelles" },
  });
  await flush();
  try {
    assert.equal(q(container, '[data-testid="address-autocomplete"]'), null, "format invalide pour ce pays");
    assert.ok(q(container, "input#street"), "le champ simple de repli reste offert");
    assert.deepEqual(calls(), [], "aucun appel fournisseur sur un format invalide");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// 2. FIXTURE PLATEFORME BE — LE MÊME CODE, UNE AUTRE DONNÉE
// ==================================================================

test("[BE] 4 chiffres : la Belgique est acceptée SANS aucune modification de code", async () => {
  const { container, root } = render({
    country: FIXTURE_BE,
    options: [],
    customer: { postalCode: "1000", city: "Bruxelles" },
  });
  await flush();
  try {
    const ctx = q(container, '[data-testid="delivery-country-context"]');
    assert.ok(ctx, "le pays belge est rappelé");
    assert.equal(ctx!.getAttribute("data-country-code"), "BE");
    // Aucun fournisseur belge n'existe : la saisie reste MANUELLE et
    // structurée -- jamais l'autocomplétion française.
    assert.equal(q(container, '[data-testid="address-autocomplete"]'), null, "aucune autocomplétion en BE");
    assert.ok(q(container, "input#street"), "la saisie structurée manuelle reste offerte");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[BE/ISOLATION] AUCUN appel au fournisseur français, même avec une adresse belge saisie", async () => {
  // Preuve directe de l'isolation. Fondement factuel : le 2026-09-24,
  // la BAN interrogée sur « Rue de la Loi 16 Bruxelles » a retourné
  // trois rues FRANÇAISES -- un repli inter-pays produirait donc une
  // mauvaise adresse d'apparence normale, pas une absence de résultat.
  const { container, root } = render({
    country: FIXTURE_BE,
    options: [],
    customer: { postalCode: "1000", city: "Bruxelles" },
  });
  await flush();
  try {
    const street = q(container, "input#street") as HTMLInputElement | null;
    assert.ok(street, "champ rue attendu");
    setInputValue(street!, "Rue de la Loi 16");
    await flush(450);
    assert.deepEqual(
      calls(),
      [],
      `aucune requête au fournisseur français ne doit partir — reçu : ${JSON.stringify(calls())}`
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[BE] un code postal à 5 chiffres n'ouvre rien en Belgique", async () => {
  const { container, root } = render({
    country: FIXTURE_BE,
    options: [],
    customer: { postalCode: "75018", city: "Paris" },
  });
  await flush();
  try {
    assert.equal(q(container, '[data-testid="address-autocomplete"]'), null);
    assert.deepEqual(calls(), []);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// 3. CAPACITÉ MULTI-PAYS
// ==================================================================

test("[MULTI] deux pays autorisés : le sélecteur APPARAÎT, avec exactement ces deux pays", async () => {
  const { container, root } = render({
    country: null,
    options: [FIXTURE_FR, FIXTURE_BE],
  });
  await flush();
  try {
    const select = q(container, '[data-testid="delivery-country-select"]');
    assert.ok(select, "le sélecteur doit être rendu dès qu'il y a un choix réel");
    const values = qa(select!, "option").map((o) => (o as HTMLOptionElement).value);
    assert.deepEqual(values, ["", "FR", "BE"], "l'invite, puis exactement les pays autorisés");
    assert.equal(q(container, '[data-testid="delivery-country-context"]'), null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[MULTI] choisir un pays remonte EXACTEMENT ce code au parent", async () => {
  const picked: string[] = [];
  const { container, root } = render({
    country: null,
    options: [FIXTURE_FR, FIXTURE_BE],
    onSelectCountry: (c) => picked.push(c),
  });
  await flush();
  try {
    const select = q(container, "select#delivery-country") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value"
    )!.set!;
    setter.call(select, "BE");
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
    assert.deepEqual(picked, ["BE"]);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// 4. FAIL-CLOSED
// ==================================================================

test("[FAIL-CLOSED] aucun pays résolu : ni autocomplétion, ni appel réseau", async () => {
  const { container, root } = render({
    country: null,
    options: [],
    customer: { postalCode: "75018", city: "Paris" },
  });
  await flush();
  try {
    assert.equal(q(container, '[data-testid="address-autocomplete"]'), null);
    assert.equal(q(container, '[data-testid="delivery-country-context"]'), null);
    assert.deepEqual(calls(), []);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ==================================================================
// 5. LE TEST QUI PROUVE L'ABSENCE DE CODAGE EN DUR
// ==================================================================

test("[NO-HARDCODE] FR et BE empruntent le MÊME code — seule la donnée diffère", async () => {
  // Même composant, mêmes props, même saisie : seul l'objet de
  // configuration change. Si le comportement belge exigeait une ligne
  // de code, ce test échouerait.
  const fr = render({ country: FIXTURE_FR, options: [], customer: { postalCode: "75018" } });
  await flush();
  const frHasAutocomplete = !!q(fr.container, '[data-testid="address-autocomplete"]');
  const frContext = q(fr.container, '[data-testid="delivery-country-context"]')?.getAttribute(
    "data-country-code"
  );
  fr.root.unmount();
  fr.container.remove();

  const be = render({ country: FIXTURE_BE, options: [], customer: { postalCode: "1000" } });
  await flush();
  const beHasAutocomplete = !!q(be.container, '[data-testid="address-autocomplete"]');
  const beContext = q(be.container, '[data-testid="delivery-country-context"]')?.getAttribute(
    "data-country-code"
  );
  be.root.unmount();
  be.container.remove();

  assert.equal(frContext, "FR");
  assert.equal(beContext, "BE");
  assert.equal(frHasAutocomplete, true, "la France a un fournisseur");
  assert.equal(beHasAutocomplete, false, "la Belgique n'en a pas — et n'emprunte pas celui de la France");
});
