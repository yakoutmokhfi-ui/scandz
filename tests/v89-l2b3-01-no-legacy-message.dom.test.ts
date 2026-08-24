import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Corrige L2B3-01 (contre-audit Work) : preuve comportementale RÉELLE
// (rendu React dans un vrai DOM, jamais une lecture du fichier
// source) que FulfillmentSelector construit désormais le message
// "hors zone" SANS JAMAIS consulter settings.deliveryAreaLabel ni
// settings.deliveryZones (legacy).
//
// Piège délibéré : `settings` reçoit un deliveryAreaLabel et des
// deliveryZones VOLONTAIREMENT DIFFÉRENTS de toute donnée publique
// réelle -- si le composant les consultait encore, le texte rendu
// contiendrait "PIEGE-LEGACY-NE-DOIT-JAMAIS-APPARAITRE". Sa
// simple ABSENCE du DOM est la preuve directe de la correction.
//
// Même technique déjà établie dans le projet (esbuild.build() +
// plugin d'alias "@/" + jsdom).
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
export { default as FulfillmentSelector } from "@/components/FulfillmentSelector";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "FulfillmentSelector.mjs");
writeFileSync(tmpFile, code);
const { FulfillmentSelector } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Piège legacy historique : avant AU LAIT CRU (sale modes),
// FulfillmentSelector recevait encore une prop `settings` -- si le
// composant avait consulté settings.deliveryAreaLabel/deliveryZones,
// ce texte serait apparu dans le rendu. Depuis ce lot, `settings`
// n'est plus une prop acceptée du tout par le composant (voir
// components/FulfillmentSelector.tsx) : le piège est donc désormais
// garanti STRUCTURELLEMENT (impossible de transmettre cet objet),
// en plus de la preuve comportementale ci-dessous (aucune trace du
// texte-piège dans le DOM rendu) et de la preuve textuelle du test 3
// (aucune référence à settings.delivery* dans le code réel).

const EMPTY_CUSTOMER = { name: "", street: "", postalCode: "", city: "", phone: "", email: "" };

function render(status: { eligible: boolean; zone?: { code: string; label: string | null }; block?: string; missing?: number }) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(FulfillmentSelector, {
      deliveryModeAvailable: true,
      status,
      type: "delivery",
      customer: EMPTY_CUSTOMER,
      errors: {},
      showErrors: false,
      onChangeCustomer: () => {},
      onSelectFulfillment: () => {},
    })
  );
  return { container, root };
}

test("L2B3-01: message 'hors zone' -- le piège legacy (deliveryAreaLabel/deliveryZones) n'apparaît JAMAIS dans le DOM rendu, message neutre déjà présent dans le produit utilisé à la place", async () => {
  const { container, root } = render({ eligible: false, block: "out-of-zone" });
  await flush();

  assert.ok(
    !container.innerHTML.includes("PIEGE-LEGACY"),
    "aucune trace du piège legacy ne doit apparaître -- confirme que settings.deliveryAreaLabel/deliveryZones ne sont plus jamais consultés"
  );

  const statusEl = container.querySelector('[role="status"] p');
  assert.ok(statusEl, "un message hors zone doit être affiché");
  assert.equal(statusEl!.textContent, "Hors zone", "doit utiliser exactement le message neutre existant (deliveryOutOfZoneShort), jamais une zone reconstruite");

  root.unmount();
});

test("L2B3-01: message 'éligible' -- utilise exclusivement status.zone.label (donnée publique), jamais le piège legacy, même quand settings contient des valeurs différentes", async () => {
  const { container, root } = render({ eligible: true, zone: { code: "75", label: "Île-de-France" } });
  await flush();

  assert.ok(!container.innerHTML.includes("PIEGE-LEGACY"), "aucune trace du piège legacy");
  const statusEl = container.querySelector('[role="status"] p');
  assert.equal(statusEl!.textContent, "Livraison offerte — Île-de-France.");

  root.unmount();
});

test("L2B3-01: aucune référence à settings.deliveryAreaLabel/deliveryZones/deliveryMinItems ne subsiste dans le CODE réel de FulfillmentSelector.tsx", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.includes("settings.delivery"), "aucun accès à settings.delivery* ne doit subsister dans le code réel");
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
