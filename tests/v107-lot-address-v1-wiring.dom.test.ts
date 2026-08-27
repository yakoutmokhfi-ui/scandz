import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// LOT ADDRESS v1 — preuve comportementale RÉELLE (rendu React dans un
// vrai DOM, jamais une lecture du fichier source) du CÂBLAGE de
// AddressAutocomplete dans components/FulfillmentSelector.tsx, l'objet
// central de cette mission :
//
//   §4  : aucun contexte code postal valide -> ZÉRO appel réseau IGN
//         (AddressAutocomplete n'est même pas monté)
//   §5  : contexte code postal valide -> AddressAutocomplete monté,
//         `postcode` transmis à l'appel réseau réel (fetch global,
//         jamais un `search` injecté -- ce test câble le VRAI chemin
//         de production, avec `fetch` global stubbé pour ne jamais
//         toucher le réseau, mission §22)
//   §6  : sélection -> seule `customer.street` est mise à jour, jamais
//         `customer.postalCode`/`customer.city` (routing authoritatif
//         du code postal préservé, voir lib/services/order-payload.ts)
//   §7  : modifier le code postal après une sélection invalide l'état
//         affiché (remontage via `key`)
//   §17 : aucun code spécifique à un tenant (Au Lait Cru/Paris/75/
//         Stuart/Chronofresh) dans la couche adresse
//
// Même technique déjà établie dans le projet (esbuild.build() + jsdom)
// -- voir tests/v85-lot2b2v3-fulfillment-label.dom.test.ts, dont ce
// fichier reprend le patron de rendu de FulfillmentSelector.
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
(globalThis as any).KeyboardEvent = window.KeyboardEvent;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const entrySource = `
export { default as FulfillmentSelector } from "@/components/FulfillmentSelector";
`;

const buildResult = await esbuild.build({
  stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v107-"));
const tmpFile = path.join(tmpDir, "FulfillmentSelector.mjs");
writeFileSync(tmpFile, code);
const { FulfillmentSelector } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 3000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const EMPTY_CUSTOMER = { name: "", street: "", postalCode: "", city: "", phone: "", email: "" };

const DELIVERY_ADDRESS_DISPLAY_ITEMS = [
  { kind: "field", requirement: { field: "delivery_address", requirement: "required" } },
];

const NO_POSTAL_STATUS = { eligible: false, block: "no-postal" as const };

function renderSelector(container: HTMLElement, customer: typeof EMPTY_CUSTOMER, onChangeCustomer: (patch: Record<string, string>) => void) {
  const root = createRoot(container);
  root.render(
    React.createElement(FulfillmentSelector, {
      deliveryModeAvailable: true,
      status: NO_POSTAL_STATUS,
      type: "delivery",
      customer,
      errors: {},
      showErrors: false,
      displayItems: DELIVERY_ADDRESS_DISPLAY_ITEMS,
      fieldRequirementsReady: true,
      onChangeCustomer,
      onSelectFulfillment: () => {},
    })
  );
  return root;
}

// Réponse GeoJSON synthétique (mission §26) -- jamais une donnée client réelle.
const FEATURE_75001 = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [2.3488, 48.8534] },
  properties: {
    id: "75101_9575_00008",
    label: "8 Bd du Palais 75001 Paris",
    name: "8 Bd du Palais",
    postcode: "75001",
    city: "Paris",
    citycode: "75101",
  },
};

let originalFetch: typeof fetch | undefined;
function stubFetch(handler: (url: string) => unknown) {
  originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => handler(String(url)),
  });
}
function restoreFetch() {
  (globalThis as any).fetch = originalFetch;
}

// --------------------------------------------------------------------
// §4 — aucun contexte code postal valide -> ZÉRO appel réseau
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §4: code postal vide -- l'aide de recherche AddressAutocomplete n'est PAS montée (seul le champ texte `street` existant reste disponible), aucun appel réseau possible", async () => {
  let fetchCalls = 0;
  stubFetch(() => {
    fetchCalls++;
    return { features: [] };
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = renderSelector(container, EMPTY_CUSTOMER, () => {});
  await flush();

  assert.ok(!container.querySelector("#delivery-street-address-input"), "AddressAutocomplete ne doit pas être monté sans code postal valide");
  const plainStreet = container.querySelector("#street") as HTMLInputElement;
  assert.ok(plainStreet, "un champ rue simple doit rester disponible tant que le contexte code postal n'existe pas");

  // Même en tapant longuement dans le champ simple, aucun appel réseau
  // ne peut être déclenché (ce n'est pas un composant de recherche).
  setInputValue(plainStreet, "10 rue de la Paix, beaucoup de texte");
  await flush(500);
  assert.equal(fetchCalls, 0);

  root.unmount();
  restoreFetch();
});

test("LOT ADDRESS v1 §4: code postal structurellement invalide (4 chiffres) -- AddressAutocomplete reste absent", async () => {
  let fetchCalls = 0;
  stubFetch(() => {
    fetchCalls++;
    return { features: [] };
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = renderSelector(container, { ...EMPTY_CUSTOMER, postalCode: "7500" }, () => {});
  await flush();
  assert.ok(!container.querySelector("#delivery-street-address-input"));
  assert.equal(fetchCalls, 0);
  root.unmount();
  restoreFetch();
});

// --------------------------------------------------------------------
// §5 — contexte valide -> AddressAutocomplete monté, `postcode` transmis
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §5: code postal valide (75001) -- AddressAutocomplete est monté et transmet postcode=75001 au VRAI service adresse (fetch global stubbé, jamais un appel réseau réel)", async () => {
  let capturedUrl: string | undefined;
  stubFetch((url) => {
    capturedUrl = url;
    return { features: [FEATURE_75001] };
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = renderSelector(container, { ...EMPTY_CUSTOMER, postalCode: "75001", city: "Paris" }, () => {});
  await flush();

  const input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  assert.ok(input, "AddressAutocomplete doit être monté avec un contexte code postal valide");

  setInputValue(input, "8 bd du palais");
  await waitFor(() => capturedUrl !== undefined, "appel réseau (stubbé) déclenché", 2000);
  const parsed = new URL(capturedUrl!);
  assert.equal(parsed.searchParams.get("postcode"), "75001");
  assert.equal(parsed.searchParams.get("q"), "8 bd du palais");

  root.unmount();
  restoreFetch();
});

// --------------------------------------------------------------------
// §6/§7 — sélection : street + postalCode + city changent (mission
// §9/§26, IGN devient autoritatif) ; invalidation au changement de
// code postal APRÈS une sélection confirmée (mission §10/§25)
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §9/§26: sélectionner une suggestion met à jour street, postalCode ET city -- IGN devient autoritatif pour ces trois valeurs (corrige l'ancienne exigence 'seule street change', désormais incorrecte -- voir mission §28, EXISTING TESTS MUST BE UPDATED)", async () => {
  stubFetch(() => ({ features: [FEATURE_75001] }));
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const patches: Record<string, string>[] = [];
  const root = renderSelector(container, { ...EMPTY_CUSTOMER, postalCode: "75001", city: "Paris" }, (patch) => patches.push(patch));
  await flush();

  const input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée", 2000);

  const option = container.querySelector('[role="option"]') as HTMLElement;
  option.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
  await flush();

  const selectionPatch = patches.find((p) => p.street === "8 Bd du Palais");
  assert.ok(selectionPatch, "un patch contenant street: '8 Bd du Palais' doit avoir été émis");
  assert.equal(selectionPatch!.postalCode, "75001", "la sélection doit renseigner postalCode (mission §9/§26)");
  assert.equal(selectionPatch!.city, "Paris", "la sélection doit renseigner city (mission §9/§26)");

  root.unmount();
  restoreFetch();
});

test("LOT ADDRESS v1 §10/§25: modifier le code postal (étape A) APRÈS une sélection confirmée efface street ET réinitialise l'affichage (remontage) -- jamais une adresse choisie pour un ancien contexte affichée sous un nouveau contexte ; ceci est prouvé en pilotant le VRAI champ #postalCode, jamais une simulation manuelle de la logique d'invalidation", async () => {
  stubFetch(() => ({ features: [FEATURE_75001] }));
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  let customer = { ...EMPTY_CUSTOMER, postalCode: "75001", city: "Paris" };
  function rerender() {
    root.render(
      React.createElement(FulfillmentSelector, {
        deliveryModeAvailable: true,
        status: NO_POSTAL_STATUS,
        type: "delivery",
        customer,
        errors: {},
        showErrors: false,
        displayItems: DELIVERY_ADDRESS_DISPLAY_ITEMS,
        fieldRequirementsReady: true,
        onChangeCustomer: (patch: Record<string, string>) => {
          customer = { ...customer, ...patch };
          rerender();
        },
        onSelectFulfillment: () => {},
      })
    );
  }
  const root = renderSelector(container, customer, (patch) => {
    customer = { ...customer, ...patch };
    rerender();
  });
  await flush();

  let input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée", 2000);
  (container.querySelector('[role="option"]') as HTMLElement).dispatchEvent(
    new window.Event("mousedown", { bubbles: true, cancelable: true })
  );
  await flush();
  input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  assert.equal(input.value, "8 Bd du Palais 75001 Paris", "après sélection, le champ affiche le libellé choisi");
  assert.equal(customer.street, "8 Bd du Palais", "customer.street reflète la sélection");

  // Édite le VRAI champ #postalCode (étape A) -- jamais une simulation
  // manuelle du patch d'invalidation : c'est la logique interne de
  // FulfillmentSelector (handleStageAFieldChange) qui doit décider
  // d'effacer `street` puisqu'une sélection était confirmée.
  const postalInput = container.querySelector("#postalCode") as HTMLInputElement;
  setInputValue(postalInput, "13001");
  await flush();

  assert.equal(customer.postalCode, "13001");
  assert.equal(customer.street, "", "street doit être effacé par la logique RÉELLE d'invalidation du composant (mission §10/§25), pas par le test");

  input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  assert.ok(input, "AddressAutocomplete doit rester monté (13001 reste un code postal structurellement valide)");
  assert.equal(input.value, "", "le champ doit être réinitialisé (remonté via key={addressContext}) après un changement de code postal -- aucune adresse périmée affichée");

  root.unmount();
  restoreFetch();
});

test("LOT ADDRESS v1 §10: éditer le code postal AVANT toute sélection IGN (saisie manuelle pure) ne touche JAMAIS street -- préserve exactement le comportement des tests préexistants v91/v101 (jamais de sélection IGN dans leur parcours)", async () => {
  stubFetch(() => ({ features: [] }));
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  let customer = { ...EMPTY_CUSTOMER, street: "12 rue des Lilas" };
  function rerender() {
    root.render(
      React.createElement(FulfillmentSelector, {
        deliveryModeAvailable: true,
        status: NO_POSTAL_STATUS,
        type: "delivery",
        customer,
        errors: {},
        showErrors: false,
        displayItems: DELIVERY_ADDRESS_DISPLAY_ITEMS,
        fieldRequirementsReady: true,
        onChangeCustomer: (patch: Record<string, string>) => {
          customer = { ...customer, ...patch };
          rerender();
        },
        onSelectFulfillment: () => {},
      })
    );
  }
  const root = renderSelector(container, customer, (patch) => {
    customer = { ...customer, ...patch };
    rerender();
  });
  await flush();

  // "12 rue des Lilas" a été tapé AVANT que le code postal ne soit
  // valide (plain #street field) -- reproduit exactement la séquence
  // de tests/v91-lot2b4a2-dynamic-form.dom.test.ts et
  // tests/v101-fulfillment-routing-lot-c-menuview.dom.test.ts.
  assert.ok(container.querySelector("#street"), "champ simple attendu tant que le code postal est vide");

  const postalInput = container.querySelector("#postalCode") as HTMLInputElement;
  setInputValue(postalInput, "75001");
  await flush();
  const cityInput = container.querySelector("#city") as HTMLInputElement;
  setInputValue(cityInput, "Paris");
  await flush();

  assert.equal(customer.street, "12 rue des Lilas", "street ne doit JAMAIS être effacé par une édition de l'étape A tant qu'aucune sélection IGN n'a jamais été confirmée");
  assert.equal(customer.postalCode, "75001");
  assert.equal(customer.city, "Paris");

  const input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  assert.ok(input, "AddressAutocomplete doit maintenant être monté (postal valide)");
  assert.equal(input.value, "12 rue des Lilas", "le texte tapé manuellement avant la validité du postal reste affiché/utilisable (mission §11/§12)");

  root.unmount();
  restoreFetch();
});

test("LOT ADDRESS v1 §8: UN SEUL champ actif de saisie de rue à la fois -- jamais #street ET #delivery-street-address-input simultanément", async () => {
  stubFetch(() => ({ features: [] }));
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);

  const root1 = renderSelector(container, EMPTY_CUSTOMER, () => {});
  await flush();
  assert.ok(container.querySelector("#street"), "champ simple attendu sans code postal valide");
  assert.ok(!container.querySelector("#delivery-street-address-input"), "AddressAutocomplete ne doit pas coexister avec le champ simple");
  root1.unmount();

  const root2 = renderSelector(container, { ...EMPTY_CUSTOMER, postalCode: "75001", city: "Paris" }, () => {});
  await flush();
  assert.ok(container.querySelector("#delivery-street-address-input"), "AddressAutocomplete attendu avec un code postal valide");
  assert.ok(!container.querySelector("#street"), "le champ simple ne doit plus être rendu une fois AddressAutocomplete actif (mission §8 -- jamais les deux en même temps)");
  root2.unmount();

  restoreFetch();
});

test("LOT ADDRESS v1 §11/§12: le texte tapé dans AddressAutocomplete SANS sélection reste directement utilisable comme customer.street (repli manuel simple, via onQueryChange -- jamais un mode séparé)", async () => {
  stubFetch(() => ({ features: [] }));
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const patches: Record<string, string>[] = [];
  const root = renderSelector(container, { ...EMPTY_CUSTOMER, postalCode: "75001", city: "Paris" }, (patch) => patches.push(patch));
  await flush();

  const input = container.querySelector("#delivery-street-address-input") as HTMLInputElement;
  setInputValue(input, "8 b");
  await flush();

  const lastPatch = patches[patches.length - 1];
  assert.deepEqual(lastPatch, { street: "8 b" }, "chaque frappe doit propager le texte brut comme valeur street, même en dessous de minQueryLength, sans attendre une sélection");

  root.unmount();
  restoreFetch();
});

// --------------------------------------------------------------------
// §17 — aucun code tenant-spécifique dans la couche adresse
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §17: le câblage dans FulfillmentSelector.tsx ne code en dur aucun tenant/zone (au-lait-cru, Paris, 75, Stuart, Chronofresh) dans le code exécutable", () => {
  const src = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  const executable = src
    .split("\n")
    .filter((line: string) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/**");
    })
    .join("\n");
  assert.ok(!/au-lait-cru|stuart|chronofresh/i.test(executable));
  assert.ok(!/["']75["']/.test(executable), "aucun préfixe de zone codé en dur dans le code exécutable");
});

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
  delete (globalThis as any).KeyboardEvent;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
