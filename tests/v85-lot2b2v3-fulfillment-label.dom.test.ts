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
// Corrige L2B2-V2-01 (contre-audit Work, re-audit LOT 2B.2) : preuve
// comportementale RÉELLE (rendu React dans un vrai DOM, jamais une
// lecture du fichier source) que FulfillmentSelector n'affiche JAMAIS
// littéralement "null" quand zone.label est null (DeliveryZone.label
// est désormais string | null depuis l'unification LOT 2B.2). Même
// technique déjà établie dans le projet (esbuild.build() + jsdom,
// voir tests/v80-lot1a1-menuview-lang.dom.test.ts) -- pas une
// réimplémentation manuelle du comportement du composant.
//
// useI18n() fournit une valeur par défaut (français) sans Provider --
// aucun wrapper I18nProvider nécessaire pour ce test.
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

const EMPTY_CUSTOMER = { name: "", street: "", postalCode: "", city: "", phone: "", email: "" };

/**
 * AU LAIT CRU (sale modes) : `settings`/`requiredFields` (legacy) ne
 * sont plus des props de FulfillmentSelector -- remplacés par
 * `deliveryModeAvailable` (booléen dérivé de la liste RÉELLE des
 * modes activés, voir components/FulfillmentSelector.tsx) et
 * `displayItems`/`fieldRequirementsReady` (LOT 2B.4a.2, non pertinents
 * pour ce test qui ne vérifie que le message d'éligibilité livraison).
 * `deliveryModeAvailable: true` reproduit fidèlement l'ancien
 * BASE_SETTINGS (allowedServiceModes incluait "delivery").
 */
function renderWithStatus(status: { eligible: boolean; zone?: { code: string; label: string | null } }) {
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

test("L2B2-V2-01 (corrigé SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION §11) : zone.label présent -- affiche exactement 'Île-de-France' SANS préfixe 'Livraison offerte' (qui présumait à tort la gratuité) (rendu React réel)", async () => {
  const { container, root } = renderWithStatus({
    eligible: true,
    zone: { code: "75", label: "Île-de-France" },
  });
  await flush();
  const statusEl = container.querySelector('[role="status"] p');
  assert.ok(statusEl, "le paragraphe de statut doit être présent dans le DOM");
  assert.equal(statusEl!.textContent, "Île-de-France");
  assert.ok(!statusEl!.textContent!.includes("offerte"), "aucune présomption de gratuité ne doit être affichée -- une règle éligible peut porter un frais réel");
  root.unmount();
});

test("L2B2-V2-01 (corrigé SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION §11) : zone.label = null -- affiche le message neutre par défaut (deliveryEligibleDefault), jamais 'Livraison offerte', jamais 'null' (rendu React réel)", async () => {
  const { container, root } = renderWithStatus({
    eligible: true,
    zone: { code: "75", label: null },
  });
  await flush();
  const statusEl = container.querySelector('[role="status"] p');
  assert.ok(statusEl, "le paragraphe de statut doit être présent dans le DOM");
  assert.equal(statusEl!.textContent, "Livraison possible.");
  assert.ok(!statusEl!.textContent!.includes("offerte"), "aucune présomption de gratuité ne doit être affichée par défaut");
  assert.ok(!statusEl!.textContent!.includes("null"), "le mot 'null' ne doit JAMAIS apparaître dans le texte rendu");
  assert.ok(!statusEl!.textContent!.includes("undefined"), "le mot 'undefined' ne doit jamais apparaître non plus");
  root.unmount();
});

after(async () => {
  window.close();
  // Corrige L1A1-01 (déjà documenté ailleurs dans ce projet, réutilisé
  // ici tel quel) : esbuild.build() démarre un SERVICE persistant qui
  // reste ouvert tant que esbuild.stop() n'est pas appelé
  // explicitement.
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  // Le module "scheduler" de React (dépendance interne de react-dom)
  // référence un MessagePort qui n'a aucune API publique de fermeture
  // -- unref() indique à Node qu'il ne doit plus empêcher la sortie
  // normale du processus, sans rien fermer de force.
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
