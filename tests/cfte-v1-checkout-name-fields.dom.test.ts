import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
// Import de TYPE uniquement (entièrement effacé à l'exécution) : le
// module lui-même reste chargé dynamiquement plus bas, APRÈS le montage
// du DOM, exactement comme avant.
import type { CustomerInfo } from "../lib/customer.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — preuve COMPORTEMENTALE
// (rendu React dans un vrai DOM, saisie réelle -- jamais une lecture du
// fichier source) du formulaire de checkout :
//
//   - un mode SUIVI (exigences effectives telles que le serveur les
//     renvoie désormais) affiche DEUX champs de nom distincts,
//     `first_name` et `last_name`, plus l'e-mail ;
//   - la saisie de chacun écrit dans une clé DIFFÉRENTE de CustomerInfo
//     (aucune collision, aucune saisie perdue) ;
//   - le champ historique unique `customer_name` n'est plus rendu pour
//     ces modes -- mais reste rendu, INCHANGÉ, pour un mode non suivi
//     (room_service), preuve directe de non-régression ;
//   - les deux champs portent des libellés DIFFÉRENTS et des
//     `autocomplete` corrects (given-name / family-name).
//
// Patron esbuild/jsdom déjà établi -- voir
// tests/v107-lot-address-v1-wiring.dom.test.ts, dont ce fichier reprend
// le montage de FulfillmentSelector.
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
const { translate } = await import("../lib/i18n.ts");
const { EMPTY_CUSTOMER } = await import("../lib/customer.ts");

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

const buildResult = await esbuild.build({
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
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-cfte-"));
const tmpFile = path.join(tmpDir, "FulfillmentSelector.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { FulfillmentSelector } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** Exigences EFFECTIVES d'un mode SUIVI (pickup), telles que le
 *  résolveur SQL les renvoie après ce lot : plus de `customer_name`, un
 *  prénom requis, un nom de famille optionnel, un e-mail REQUIS. */
const PICKUP_ITEMS = [
  { kind: "field", requirement: { field: "first_name", requirement: "required", oneOfGroup: null } },
  { kind: "field", requirement: { field: "last_name", requirement: "optional", oneOfGroup: null } },
  { kind: "field", requirement: { field: "email", requirement: "required", oneOfGroup: null } },
];

/** Mode NON suivi (room_service) : champ unique historique, inchangé. */
const ROOM_SERVICE_ITEMS = [
  { kind: "field", requirement: { field: "customer_name", requirement: "required", oneOfGroup: null } },
];

function render(
  items: unknown,
  // Type EXACT de la prop du composant : `firstName`/`lastName` y sont
  // optionnels (lib/customer.ts), le harnais doit donc décrire la même
  // chose -- jamais un `Record<string, string>` plus strict que la
  // réalité, qui obligerait à inventer des clés vides.
  customer: CustomerInfo,
  onChangeCustomer: (patch: Record<string, string>) => void,
  extra: Record<string, unknown> = {}
) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(FulfillmentSelector, {
      deliveryModeAvailable: false,
      status: { eligible: false },
      type: "pickup",
      customer,
      errors: {},
      showErrors: false,
      displayItems: items,
      fieldRequirementsReady: true,
      onChangeCustomer,
      onSelectFulfillment: () => {},
      ...extra,
    })
  );
  return { container, root };
}

const input = (c: Element, id: string) =>
  c.querySelector<HTMLInputElement>(`input#${id}`);
const labelFor = (c: Element, id: string) =>
  c.querySelector(`label[for="${id}"]`)?.textContent ?? null;

test("1. un mode suivi rend DEUX champs de nom distincts (prénom + nom) et l'e-mail", async () => {
  const { container, root } = render(PICKUP_ITEMS, { ...EMPTY_CUSTOMER }, () => {});
  await flush();
  try {
    assert.ok(input(container, "first_name"), "le champ prénom doit être rendu");
    assert.ok(input(container, "last_name"), "le champ nom doit être rendu");
    assert.ok(input(container, "email"), "le champ e-mail doit être rendu");
    assert.equal(
      input(container, "customer_name"),
      null,
      "le champ nom UNIQUE historique ne doit plus être rendu pour un mode suivi"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("2. les deux champs portent des libellés DIFFÉRENTS et les bons `autocomplete`", async () => {
  const { container, root } = render(PICKUP_ITEMS, { ...EMPTY_CUSTOMER }, () => {});
  await flush();
  try {
    const first = labelFor(container, "first_name");
    const last = labelFor(container, "last_name");
    assert.equal(first, translate("fr", "fieldName"));
    assert.equal(last, translate("fr", "fieldLastName"));
    assert.notEqual(first, last, "prénom et nom ne doivent jamais partager le même libellé");

    assert.equal(input(container, "first_name")!.getAttribute("autocomplete"), "given-name");
    assert.equal(input(container, "last_name")!.getAttribute("autocomplete"), "family-name");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("3. saisir le prénom et le nom écrit dans DEUX clés distinctes -- aucune saisie perdue", async () => {
  const patches: Record<string, string>[] = [];
  let customer = { ...EMPTY_CUSTOMER };
  const onChange = (patch: Record<string, string>) => {
    patches.push(patch);
    customer = { ...customer, ...patch };
  };

  const { container, root } = render(PICKUP_ITEMS, customer, onChange);
  await flush();
  try {
    setInputValue(input(container, "first_name")!, "Myriam");
    await flush();
    setInputValue(input(container, "last_name")!, "Benali");
    await flush();

    assert.deepEqual(patches, [{ firstName: "Myriam" }, { lastName: "Benali" }]);
    assert.equal(customer.firstName, "Myriam");
    assert.equal(customer.lastName, "Benali");
    // Le champ historique n'est JAMAIS écrit par ces deux saisies : le
    // nom persisté est recomposé (client et serveur), jamais accumulé
    // dans `name` par effet de bord.
    assert.equal(customer.name, "");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("4. NON-RÉGRESSION : un mode NON suivi rend toujours le champ nom unique historique", async () => {
  const patches: Record<string, string>[] = [];
  const { container, root } = render(ROOM_SERVICE_ITEMS, { ...EMPTY_CUSTOMER }, (p) =>
    patches.push(p)
  );
  await flush();
  try {
    const legacy = input(container, "customer_name");
    assert.ok(legacy, "le champ historique doit rester rendu pour un mode non suivi");
    assert.equal(input(container, "first_name"), null);
    assert.equal(input(container, "last_name"), null);

    setInputValue(legacy!, "Client Chambre");
    await flush();
    assert.deepEqual(patches, [{ name: "Client Chambre" }]);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("5. les erreurs de chaque champ sont affichées séparément, jamais confondues", async () => {
  const { container, root } = render(
    PICKUP_ITEMS,
    { ...EMPTY_CUSTOMER },
    () => {},
    { showErrors: true, errors: { firstName: "errFirstName", lastName: "errLastName" } }
  );
  await flush();
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes(translate("fr", "errFirstName")));
    assert.ok(text.includes(translate("fr", "errLastName")));
    assert.equal(input(container, "first_name")!.getAttribute("aria-invalid"), "true");
    assert.equal(input(container, "last_name")!.getAttribute("aria-invalid"), "true");
  } finally {
    root.unmount();
    container.remove();
  }
});
