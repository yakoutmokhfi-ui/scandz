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
// FIX ADDR-V1-04 (Production, HIGH) — "SELECTED SUGGESTION REOPENS
// AUTOCOMPLETE RESULTS".
//
// Bug observé en Production : sélectionner une suggestion appelle
// `selectSuggestion()`, qui appelle `setQuery(suggestion.label)`. Ce
// changement de `query` (purement PROGRAMMATIQUE, jamais une frappe)
// redéclenchait l'effet de recherche débouncée (dépendance `query`),
// qui relançait une recherche avec le libellé choisi comme texte de
// requête -- rouvrant la liste de suggestions juste après que le
// client venait de la fermer en sélectionnant.
//
// Cette suite prouve, par un rendu React RÉEL (jsdom, jamais une
// lecture de code source) :
//   - une sélection (souris ET clavier) ne rouvre jamais la liste,
//     même en laissant le temps au debounce de s'écouler ;
//   - une VRAIE frappe après une sélection continue de fonctionner
//     normalement (le correctif ne bloque pas la recherche pour
//     toujours) ;
//   - une valeur initiale pré-remplie (`value` non nul au montage,
//     tel que produit par components/FulfillmentSelector.tsx) ne
//     déclenche pas non plus de recherche fantôme au montage ;
//   - effacer la sélection ne déclenche aucune recherche parasite.
//
// Même patron esbuild + jsdom déjà établi (voir
// tests/v107-lot-address-v1-autocomplete.dom.test.ts). Données 100%
// synthétiques.
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
import AddressAutocomplete from "@/components/AddressAutocomplete";
export default AddressAutocomplete;
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v108-"));
const tmpFile = path.join(tmpDir, "AddressAutocomplete.mjs");
writeFileSync(tmpFile, code);
const { default: AddressAutocomplete } = await import(pathToFileURL(tmpFile).href);
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

function mount() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

const SUGGESTION_8_PALAIS = {
  id: "75101_9575_00008",
  label: "8 Bd du Palais 75001 Paris",
  addressLine: "8 Bd du Palais",
  postalCode: "75001",
  city: "Paris",
  countryCode: "FR",
};

// --------------------------------------------------------------------
// Sélection à la souris (mousedown sur l'option) -- cas exact du
// rapport de Production.
// --------------------------------------------------------------------

test("FIX ADDR-V1-04: sélectionner une suggestion (souris) ne rouvre JAMAIS la liste, même en laissant le temps au debounce de s'écouler (le `search` matcherait pourtant le libellé choisi si on le rappelait)", async () => {
  let calls = 0;
  // Volontairement conçu pour re-matcher le libellé choisi lui-même --
  // si le bug réapparaissait (nouvelle recherche relancée avec le
  // libellé comme requête), ce stub la retrouverait et rouvrirait la
  // liste : le test doit donc échouer si la régression revient.
  const search = async () => {
    calls++;
    return [SUGGESTION_8_PALAIS];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "v108a" }));
  await flush();

  const input = container.querySelector("input#v108a-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée", 2000);
  assert.equal(calls, 1, "un seul appel réseau attendu avant sélection");

  const option = container.querySelector('[role="option"]') as HTMLElement;
  option.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
  await flush();

  assert.equal(container.querySelectorAll('[role="listbox"]').length, 0, "la liste doit être fermée immédiatement après la sélection");
  assert.equal(input.value, "8 Bd du Palais 75001 Paris", "le champ affiche le libellé choisi");

  // Laisse largement le temps à un éventuel debounce fantôme de
  // s'exécuter (bien au-delà de debounceMs) -- la régression ADDR-V1-04
  // se manifestait précisément après ce délai.
  await flush(200);

  assert.equal(calls, 1, "AUCUN second appel réseau ne doit avoir été déclenché par la sélection elle-même (FIX ADDR-V1-04)");
  assert.equal(container.querySelectorAll('[role="listbox"]').length, 0, "la liste doit rester fermée -- jamais de réouverture spontanée après sélection");

  root.unmount();
});

// --------------------------------------------------------------------
// Sélection au clavier (ArrowDown + Enter) -- même chemin de code
// (`selectSuggestion`), doit être couvert par le même correctif.
// --------------------------------------------------------------------

test("FIX ADDR-V1-04: sélectionner une suggestion au clavier (ArrowDown puis Enter) ne rouvre pas non plus la liste", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return [SUGGESTION_8_PALAIS];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "v108b" }));
  await flush();

  const input = container.querySelector("input#v108b-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée", 2000);
  assert.equal(calls, 1);

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await flush();
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();
  assert.equal(container.querySelectorAll('[role="listbox"]').length, 0, "la liste doit être fermée après une sélection clavier");

  await flush(200);
  assert.equal(calls, 1, "AUCUN second appel réseau après une sélection clavier (FIX ADDR-V1-04)");
  assert.equal(container.querySelectorAll('[role="listbox"]').length, 0);

  root.unmount();
});

// --------------------------------------------------------------------
// Une VRAIE frappe après une sélection continue de fonctionner --
// preuve que le correctif ne bloque pas la recherche pour toujours,
// seulement le changement programmatique immédiatement consécutif à la
// sélection.
// --------------------------------------------------------------------

test("FIX ADDR-V1-04: après une sélection, TAPER un nouveau texte relance bien une recherche normale (le drapeau anti-réouverture ne bloque qu'UNE fois, jamais la frappe réelle suivante)", async () => {
  let calls = 0;
  const queries: string[] = [];
  const search = async (q: string) => {
    calls++;
    queries.push(q);
    return [SUGGESTION_8_PALAIS];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "v108c" }));
  await flush();

  const input = container.querySelector("input#v108c-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée", 2000);
  (container.querySelector('[role="option"]') as HTMLElement).dispatchEvent(
    new window.Event("mousedown", { bubbles: true, cancelable: true })
  );
  await flush(200);
  assert.equal(calls, 1, "aucun second appel juste après la sélection");

  // Vraie frappe : l'utilisateur corrige/retape après avoir sélectionné.
  setInputValue(input, "12 rue de Rivoli");
  await waitFor(() => calls === 2, "une nouvelle recherche doit repartir pour une vraie frappe", 2000);
  assert.equal(queries[1], "12 rue de Rivoli", "la nouvelle recherche doit porter sur le texte réellement tapé");

  root.unmount();
});

// --------------------------------------------------------------------
// Valeur initiale pré-remplie au montage (mission ACTIVE CHECKOUT
// INTEGRATION : `value` peut être non nul dès le montage, voir
// components/FulfillmentSelector.tsx, `currentAddressValue`) -- ne
// doit jamais déclencher de recherche fantôme au montage.
// --------------------------------------------------------------------

test("FIX ADDR-V1-04: une valeur initiale pré-remplie (`value` non nul au montage) ne déclenche AUCUNE recherche fantôme, même en laissant le temps au debounce de s'écouler", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return [SUGGESTION_8_PALAIS];
  };
  const { root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: { addressLine: "8 Bd du Palais", postalCode: "75001", city: "Paris", countryCode: "FR", label: "8 Bd du Palais 75001 Paris" },
      onChange: () => {},
      search,
      debounceMs: 20,
      id: "v108d",
    })
  );
  await flush(200);
  assert.equal(calls, 0, "aucun appel réseau ne doit être déclenché par une valeur initiale pré-remplie au montage");
  root.unmount();
});

// --------------------------------------------------------------------
// Effacer la sélection ne déclenche aucune recherche parasite.
// --------------------------------------------------------------------

test("FIX ADDR-V1-04: effacer une sélection (bouton clear) ne déclenche aucune recherche parasite", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return [SUGGESTION_8_PALAIS];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "v108e" }));
  await flush();

  const input = container.querySelector("input#v108e-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await waitFor(() => container.querySelectorAll('[role="option"]').length === 1, "1 suggestion affichée", 2000);
  (container.querySelector('[role="option"]') as HTMLElement).dispatchEvent(
    new window.Event("mousedown", { bubbles: true, cancelable: true })
  );
  await flush(200);
  assert.equal(calls, 1);

  const clearButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Effacer") as HTMLButtonElement;
  assert.ok(clearButton, "le bouton d'effacement doit être présent");
  clearButton.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(200);

  assert.equal(calls, 1, "effacer ne doit déclencher aucun nouvel appel réseau");
  assert.equal(input.value, "");

  root.unmount();
});
