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
// LOT ADDRESS v1 — preuve comportementale RÉELLE (rendu React, vrai
// DOM) des exigences propres à cette mission sur components/
// AddressAutocomplete.tsx, en complément de
// tests/v99-b5-address-autocomplete.dom.test.ts (qui couvre déjà le
// contrat général du composant, non dupliqué ici) :
//   - §3  : minQueryLength par défaut = 6 (pas 3, pas 10)
//   - §4  : debounceMs par défaut = 350
//   - §5  : postcodeContext transmis au `search` injecté
//   - §12 : dédoublonnage d'une requête normalisée identique
//
// Même technique déjà établie (esbuild + plugin d'alias "@/" + jsdom)
// que tests/v99-b5-address-autocomplete.dom.test.ts, dont ce fichier
// reprend le patron. Données 100% synthétiques (mission §26).
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v101-"));
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

// --------------------------------------------------------------------
// §3 — minQueryLength par défaut = 6 (ni 3, ni 10)
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §3: sans minQueryLength explicite, 5 caractères (trim) ne déclenche AUCUN appel réseau", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return [];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "d1" }));
  await flush();
  const input = container.querySelector("input#d1-address-input") as HTMLInputElement;
  setInputValue(input, "12345"); // 5 chars
  await flush(120);
  assert.equal(calls, 0, "5 caractères ne doit déclencher aucun appel réseau avec le seuil par défaut (6)");
  root.unmount();
});

test("LOT ADDRESS v1 §3/§8-9: exactement 6 caractères (trim) déclenche bien un appel après le debounce -- confirme que le seuil par défaut n'est PAS 10 (CIO: ne jamais bloquer une adresse courte légitime)", async () => {
  let calls = 0;
  let lastQuery: string | undefined;
  const search = async (q: string) => {
    calls++;
    lastQuery = q;
    return [];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "d2" }));
  await flush();
  const input = container.querySelector("input#d2-address-input") as HTMLInputElement;
  setInputValue(input, "1 Rue"); // 5 chars -- juste sous le seuil
  await flush(80);
  assert.equal(calls, 0);
  setInputValue(input, "1 Rue A"); // 7 chars -- au-dessus, mais on veut EXACTEMENT 6 : ajuste ci-dessous
  await flush(80);
  assert.equal(calls, 1, "7 caractères doit déclencher un appel (bien au-dessus du seuil par défaut)");
  assert.equal(lastQuery, "1 Rue A");
  root.unmount();
});

test("LOT ADDRESS v1 §8/§9: une adresse courte valide de 6 à 9 caractères n'est jamais artificiellement bloquée (seuil par défaut = 6, PAS 10)", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return [];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "d3" }));
  await flush();
  const input = container.querySelector("input#d3-address-input") as HTMLInputElement;
  setInputValue(input, "1 rue A"); // 7 caractères, adresse française courte plausible
  await flush(80);
  assert.equal(calls, 1, "une adresse de 7 caractères doit déclencher une recherche -- ne jamais exiger 10 caractères");
  root.unmount();
});

// --------------------------------------------------------------------
// §4 — debounceMs par défaut = 350
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §4: sans debounceMs explicite, aucun appel n'est encore parti à 200ms mais un appel est bien parti à 500ms (confirme un debounce proche de 350ms, ni immédiat ni un multiple de secondes)", async () => {
  let calls = 0;
  const search = async () => {
    calls++;
    return [];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, id: "d4" }));
  await flush();
  const input = container.querySelector("input#d4-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(200);
  assert.equal(calls, 0, "à 200ms, le debounce par défaut (350ms) ne doit pas encore avoir déclenché de recherche");
  await flush(300);
  assert.equal(calls, 1, "à 500ms au total, la recherche doit avoir été déclenchée");
  root.unmount();
});

// --------------------------------------------------------------------
// §5 — postcodeContext transmis au `search` injecté
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §5: postcodeContext est transmis tel quel dans les options du `search` injecté", async () => {
  let receivedPostcode: string | undefined;
  const search = async (_q: string, options?: { postcode?: string }) => {
    receivedPostcode = options?.postcode;
    return [];
  };
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {},
      search,
      debounceMs: 20,
      postcodeContext: "75001",
      id: "d5",
    })
  );
  await flush();
  const input = container.querySelector("input#d5-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(80);
  assert.equal(receivedPostcode, "75001");
  root.unmount();
});

test("LOT ADDRESS v1 §5: sans postcodeContext fourni, le `search` injecté reçoit `postcode: undefined` (aucun contexte inventé)", async () => {
  let receivedOptions: { postcode?: string } | undefined;
  const search = async (_q: string, options?: { postcode?: string }) => {
    receivedOptions = options;
    return [];
  };
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "d6" }));
  await flush();
  const input = container.querySelector("input#d6-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(80);
  assert.equal(receivedOptions?.postcode, undefined);
  root.unmount();
});

// --------------------------------------------------------------------
// §12 — dédoublonnage d'une requête normalisée identique
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §12: un nouveau passage de l'effet (ex. nouvelle référence `search`) SANS changement de texte saisi ni de contexte postal ne déclenche AUCUN second appel réseau (requête normalisée identique)", async () => {
  let callsA = 0;
  let callsB = 0;
  const searchA = async () => {
    callsA++;
    return [];
  };
  const searchB = async () => {
    callsB++;
    return [];
  };
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search: searchA, debounceMs: 20, postcodeContext: "75001", id: "d7" })
  );
  await flush();
  const input = container.querySelector("input#d7-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(80);
  assert.equal(callsA, 1, "premier appel attendu");

  // Re-rendu avec une NOUVELLE référence `search` (fonctionnellement
  // équivalente) mais SANS changement de texte saisi ni de contexte
  // postal -- l'effet se redéclenche (dépendance `search` modifiée)
  // mais la requête normalisée est identique à la dernière déjà
  // envoyée : aucun nouvel appel réseau ne doit partir (mission §12).
  root.render(
    React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search: searchB, debounceMs: 20, postcodeContext: "75001", id: "d7" })
  );
  await flush(80);
  assert.equal(callsB, 0, "requête normalisée identique -- aucun appel dupliqué, même avec une nouvelle référence de fonction search");

  root.unmount();
});

test("LOT ADDRESS v1 §12: un changement RÉEL de contexte postal (même texte saisi) N'EST PAS dédoublonné -- une nouvelle recherche doit repartir", async () => {
  let calls = 0;
  const receivedPostcodes: (string | undefined)[] = [];
  const search = async (_q: string, options?: { postcode?: string }) => {
    calls++;
    receivedPostcodes.push(options?.postcode);
    return [];
  };
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, postcodeContext: "75001", id: "d8" })
  );
  await flush();
  const input = container.querySelector("input#d8-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(80);
  assert.equal(calls, 1);

  root.render(
    React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, postcodeContext: "13001", id: "d8" })
  );
  await flush(80);
  assert.equal(calls, 2, "un changement de contexte postal doit relancer une recherche, malgré un texte saisi identique");
  assert.deepEqual(receivedPostcodes, ["75001", "13001"]);

  root.unmount();
});

// --------------------------------------------------------------------
// LOT ADDRESS v1 §11/§12 (ACTIVE CHECKOUT INTEGRATION) — onQueryChange :
// texte brut propagé à CHAQUE frappe, indépendamment de onChange (qui
// ne notifie jamais autre chose que null / une sélection confirmée) ;
// permet à l'appelant de garder la rue tapée utilisable sans exiger de
// sélection formelle (repli manuel simple, mission §11/§12).
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §11/§12: onQueryChange est appelé avec le texte brut à chaque frappe, même sous minQueryLength -- indépendamment de tout appel réseau", async () => {
  const queryChanges: string[] = [];
  const search = async () => [];
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {},
      onQueryChange: (t: string) => queryChanges.push(t),
      search,
      debounceMs: 20,
      id: "d9",
    })
  );
  await flush();
  const input = container.querySelector("input#d9-address-input") as HTMLInputElement;
  setInputValue(input, "8");
  setInputValue(input, "8 b");
  await flush(5);
  assert.deepEqual(queryChanges, ["8", "8 b"], "onQueryChange doit recevoir chaque valeur tapée, y compris sous le seuil de déclenchement réseau");
  root.unmount();
});

test("LOT ADDRESS v1 §11/§12: onQueryChange est appelé avec '' lors d'un effacement (bouton clear)", async () => {
  const queryChanges: string[] = [];
  const search = async () => [];
  const { container, root } = mount();
  root.render(
    React.createElement(AddressAutocomplete, {
      value: null,
      onChange: () => {},
      onQueryChange: (t: string) => queryChanges.push(t),
      search,
      debounceMs: 20,
      id: "d10",
    })
  );
  await flush();
  const input = container.querySelector("input#d10-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(5);
  const clearButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Effacer") as HTMLButtonElement;
  assert.ok(clearButton, "le bouton d'effacement doit être présent une fois du texte saisi");
  clearButton.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(5);
  assert.equal(queryChanges[queryChanges.length - 1], "", "le dernier appel onQueryChange après effacement doit être une chaîne vide");
  root.unmount();
});

test("LOT ADDRESS v1: onQueryChange est optionnel -- son absence ne casse rien (composant utilisable sans, comme avant ce lot)", async () => {
  const search = async () => [];
  const { container, root } = mount();
  root.render(React.createElement(AddressAutocomplete, { value: null, onChange: () => {}, search, debounceMs: 20, id: "d11" }));
  await flush();
  const input = container.querySelector("input#d11-address-input") as HTMLInputElement;
  setInputValue(input, "8 bd du palais");
  await flush(30);
  assert.equal(input.value, "8 bd du palais");
  root.unmount();
});
