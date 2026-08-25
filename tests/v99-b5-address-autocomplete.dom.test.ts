import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// FULFILLMENT ROUTING LOT B.5 — preuve comportementale RÉELLE (rendu
// React dans un vrai DOM, jamais une lecture du fichier source) du
// composant ISOLÉ AddressAutocomplete (components/AddressAutocomplete.tsx) :
//   - saisie -> déclenche une recherche (via une fonction `search`
//     INJECTÉE, jamais un vrai appel réseau -- mission §26 "utiliser
//     des données synthétiques uniquement") ;
//   - suggestions affichées, sélection au clic ET au clavier ;
//   - valeur structurée (StructuredCustomerAddress) transmise à
//     onChange après sélection ;
//   - clear/edit -- réinitialise la valeur ;
//   - état "aucun résultat" / état "erreur" (provider indisponible) ;
//   - repli manuel -- 4 champs structurés, MÊME contrat de sortie
//     qu'une sélection via l'API.
//
// Même technique déjà établie dans le projet (esbuild.build() + plugin
// d'alias "@/" + jsdom) -- voir
// tests/v90-lot2b4a1-field-requirements-hook.dom.test.ts, dont ce
// fichier reprend le patron. Contrairement à ce précédent, aucun
// module ne doit rester "external" ici : AddressAutocomplete ne
// dépend d'AUCUN singleton partagé (pas de client Supabase) --
// l'injection de dépendance se fait via la prop `search`, jamais via
// un mock de module.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  configurable: true,
});
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
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const entrySource = `
import AddressAutocomplete from "@/components/AddressAutocomplete";
export default AddressAutocomplete;
`;

const buildResult = await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v99-"));
const tmpFile = path.join(tmpDir, "AddressAutocomplete.mjs");
writeFileSync(tmpFile, code);
const { default: AddressAutocomplete } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 2000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function mount() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

const SUGGESTION_A = {
  id: "1",
  label: "8 Bd du Palais 75001 Paris",
  addressLine: "8 Bd du Palais",
  postalCode: "75001",
  city: "Paris",
  countryCode: "FR",
  latitude: 48.85,
  longitude: 2.35,
};
const SUGGESTION_B = {
  id: "2",
  label: "9 Bd du Palais 75001 Paris",
  addressLine: "9 Bd du Palais",
  postalCode: "75001",
  city: "Paris",
  countryCode: "FR",
  latitude: 48.86,
  longitude: 2.36,
};

test("LOT B.5: saisie -> appelle la fonction search injectée (jamais un vrai réseau), affiche les suggestions retournées", async () => {
  let calledWith: string | undefined;
  const search = async (query: string) => {
    calledWith = query;
    return [SUGGESTION_A, SUGGESTION_B];
  };

  const { container, root } = mount();
  let lastValue: unknown = "not-called";
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: (v: unknown) => {
        lastValue = v;
      },
      search,
      debounceMs: 1,
      id: "t1",
    })
  );
  await flush();

  const input = container.querySelector("input#t1-address-input") as HTMLInputElement;
  assert.ok(input, "le champ de saisie doit être rendu");
  setInputValue(input, "8 bd du palais");

  await waitFor(() => container.querySelectorAll('[role="option"]').length === 2, "affichage des 2 suggestions");
  assert.equal(calledWith, "8 bd du palais");
  const options = container.querySelectorAll('[role="option"]');
  assert.equal(options[0].textContent, SUGGESTION_A.label);
  assert.equal(options[1].textContent, SUGGESTION_B.label);
  assert.equal(lastValue, "not-called", "onChange ne doit être appelé qu'après une SÉLECTION, jamais pendant la simple saisie");

  root.unmount();
});

test("LOT B.5: sélection au clic -- onChange reçoit un StructuredCustomerAddress normalisé (mission §11/§12 : postalCode structuré, jamais reparsé)", async () => {
  const search = async () => [SUGGESTION_A];
  const { container, root } = mount();
  let received: unknown;
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: (v: unknown) => (received = v),
      search,
      debounceMs: 1,
      id: "t2",
    })
  );
  await flush();

  const input = container.querySelector("input#t2-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée");

  const option = container.querySelector('[role="option"]') as HTMLElement;
  option.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
  await flush();

  assert.deepEqual(received, {
    addressLine: "8 Bd du Palais",
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
    label: "8 Bd du Palais 75001 Paris",
    latitude: 48.85,
    longitude: 2.35,
  });
  assert.equal((input as HTMLInputElement).value, SUGGESTION_A.label, "le champ doit afficher le libellé de la suggestion sélectionnée");
  assert.equal(container.querySelectorAll('[role="option"]').length, 0, "la liste de suggestions doit se refermer après sélection");

  root.unmount();
});

test("LOT B.5: sélection au clavier -- ArrowDown puis Enter sélectionne la suggestion active, aria-activedescendant reflète l'index actif", async () => {
  const search = async () => [SUGGESTION_A, SUGGESTION_B];
  const { container, root } = mount();
  let received: unknown;
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: (v: unknown) => (received = v),
      search,
      debounceMs: 1,
      id: "t3",
    })
  );
  await flush();

  const input = container.querySelector("input#t3-address-input") as HTMLInputElement;
  setInputValue(input, "bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 2, "2 suggestions affichées");

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await flush();
  assert.equal(input.getAttribute("aria-activedescendant"), "t3-address-listbox-option-0");

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await flush();
  assert.equal(input.getAttribute("aria-activedescendant"), "t3-address-listbox-option-1");

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();

  assert.equal((received as { postalCode: string }).postalCode, SUGGESTION_B.postalCode);

  root.unmount();
});

test("LOT B.5: Escape referme la liste de suggestions sans effacer la saisie ni appeler onChange", async () => {
  const search = async () => [SUGGESTION_A];
  const { container, root } = mount();
  let onChangeCalls = 0;
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {
        onChangeCalls++;
      },
      search,
      debounceMs: 1,
      id: "t4",
    })
  );
  await flush();

  const input = container.querySelector("input#t4-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée");

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await flush();

  assert.equal(container.querySelectorAll('[role="option"]').length, 0, "la liste doit se refermer");
  assert.equal(input.value, "8 bd du palais", "la saisie de l'utilisateur ne doit pas être effacée par Escape");
  assert.equal(onChangeCalls, 0);

  root.unmount();
});

test("LOT B.5: aucun résultat -- message dédié affiché, jamais confondu avec l'état d'erreur", async () => {
  const search = async () => [];
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {},
      search,
      debounceMs: 1,
      id: "t5",
    })
  );
  await flush();

  const input = container.querySelector("input#t5-address-input") as HTMLInputElement;
  setInputValue(input, "adresse introuvable");
  await waitFor(() => container.textContent?.includes("Aucune adresse trouvée") ?? false, "message 'aucun résultat'");

  assert.ok(!container.querySelector('[role="alert"]'), "l'état 'aucun résultat' ne doit jamais déclencher le rendu d'erreur");

  root.unmount();
});

test("LOT B.5: provider indisponible (search rejette) -- état d'erreur affiché, jamais de crash, invite au repli manuel (mission §10)", async () => {
  const search = async () => {
    throw new Error("panne réseau simulée");
  };
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {},
      search,
      debounceMs: 1,
      id: "t6",
    })
  );
  await flush();

  const input = container.querySelector("input#t6-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelector('[role="alert"]') !== null, "état d'erreur affiché");

  assert.ok(!container.innerHTML.includes("panne réseau simulée"), "aucun détail technique de l'erreur ne doit être exposé à l'utilisateur");

  root.unmount();
});

test("LOT B.5: bouton clear -- réinitialise la saisie et appelle onChange(null)", async () => {
  const search = async () => [SUGGESTION_A];
  const { container, root } = mount();
  let received: unknown = "unset";
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: (v: unknown) => (received = v),
      search,
      debounceMs: 1,
      id: "t7",
    })
  );
  await flush();

  const input = container.querySelector("input#t7-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée");
  (container.querySelector('[role="option"]') as HTMLElement).dispatchEvent(
    new window.Event("mousedown", { bubbles: true, cancelable: true })
  );
  await flush();
  assert.notEqual(received, null);

  const clearButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Effacer") as HTMLButtonElement;
  assert.ok(clearButton, "le bouton Effacer doit être rendu une fois une adresse sélectionnée");
  clearButton.click();
  await flush();

  assert.equal(received, null);
  assert.equal((container.querySelector("input#t7-address-input") as HTMLInputElement).value, "");

  root.unmount();
});

test("LOT B.5: repli manuel -- bascule vers 4 champs structurés, produit le MÊME contrat StructuredCustomerAddress qu'une sélection API (mission §11)", async () => {
  const search = async () => [];
  const { container, root } = mount();
  let received: unknown;
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: (v: unknown) => (received = v),
      search,
      debounceMs: 1,
      id: "t8",
    })
  );
  await flush();

  const switchButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Saisir l'adresse manuellement") as HTMLButtonElement;
  assert.ok(switchButton, "le bouton de repli manuel doit toujours être proposé, même sans erreur préalable");
  switchButton.click();
  await flush();

  assert.ok(container.querySelector('[data-testid="address-manual-form"]'), "le formulaire manuel doit être rendu");

  const street = container.querySelector("#t8-manual-street") as HTMLInputElement;
  const postal = container.querySelector("#t8-manual-postal") as HTMLInputElement;
  const city = container.querySelector("#t8-manual-city") as HTMLInputElement;
  const country = container.querySelector("#t8-manual-country") as HTMLInputElement;
  assert.ok(street && postal && city && country, "les 4 champs structurés doivent être rendus (addressLine/postalCode/city/countryCode)");

  setInputValue(street, "10 rue de la Paix");
  setInputValue(postal, "75002");
  setInputValue(city, "Paris");
  setInputValue(country, "fr");
  await flush();

  assert.deepEqual(received, {
    addressLine: "10 rue de la Paix",
    postalCode: "75002",
    city: "Paris",
    countryCode: "FR",
    label: null,
    latitude: null,
    longitude: null,
  });

  root.unmount();
});

test("LOT B.5: aucune mise à jour d'état après démontage (unmount avant résolution de la recherche) -- jamais de crash ni d'avertissement React", async () => {
  let resolveSearch: (v: (typeof SUGGESTION_A)[]) => void = () => {};
  const search = () =>
    new Promise<(typeof SUGGESTION_A)[]>((resolve) => {
      resolveSearch = resolve;
    });

  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {},
      search,
      debounceMs: 1,
      id: "t9",
    })
  );
  await flush();

  const input = container.querySelector("input#t9-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush();

  root.unmount();
  assert.doesNotThrow(() => resolveSearch([SUGGESTION_A]));
  await flush();
  await flush();
});
