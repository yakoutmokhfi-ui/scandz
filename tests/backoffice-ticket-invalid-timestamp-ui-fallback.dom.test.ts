import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Scanym — BACKOFFICE TICKET AGE / ELAPSED TIME DISPLAY v1.2 —
// INVALID TIMESTAMP UI FALLBACK. Preuve comportementale RÉELLE (rendu
// React dans un vrai DOM, patron esbuild/jsdom déjà établi -- voir
// tests/v133-receipt-invoice-name-history.dom.test.ts) que
// components/dashboard/OrderCard.tsx affiche EXACTEMENT "—" pour une
// commande dont `created_at` est invalide/manquant -- DANS LES TROIS
// LANGUES (fr/en/ar) -- jamais un rendu littéral "NaN"/"Infinity",
// même dans les langues où le formatage j/h/min détaillé (français
// uniquement) ne s'applique pas.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard",
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
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

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
export { default as OrderCard } from "@/components/dashboard/OrderCard";
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
const tmpFile = path.join(tmpDir, "OrderCard.mjs");
writeFileSync(tmpFile, code);
const { OrderCard } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    restaurant_id: "r1",
    order_number: 42,
    status: "new",
    service_mode: "pickup",
    table_number: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    delivery_address: null,
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 15,
    total: 15,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [
      { id: "i1", item_name: "Produit A", option_name: null, quantity: 1, unit_price: 15, line_total: 15 },
    ],
    ...overrides,
  };
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function render(order: Record<string, unknown>, staffLanguage: string) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderCard, {
      order,
      restaurantName: "Restaurant Test",
      receiptSettings: null,
      onStatus: async () => {},
      busy: false,
      staffLanguage,
    })
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

for (const lang of ["fr", "en", "ar"] as const) {
  test(`OrderCard (DOM réel) : created_at INVALIDE, langue ${lang} -- affiche EXACTEMENT "—", JAMAIS "NaN"`, async () => {
    const { container, root } = render(baseOrder({ created_at: "not-a-valid-date" }), lang);
    await flush();

    assert.ok(container.textContent!.includes("—"), `le repli "—" doit être affiché en langue ${lang}`);
    assert.ok(!container.textContent!.includes("NaN"), `AUCUN rendu littéral "NaN" ne doit jamais apparaître en langue ${lang}`);
    assert.ok(!container.textContent!.includes("Infinity"), `AUCUN rendu littéral "Infinity" ne doit jamais apparaître en langue ${lang}`);

    root.unmount();
    container.remove();
  });
}

test('OrderCard (DOM réel) : French, durée VALIDE 1285 min -- affiche "21h 25min" (formatage j/h/min détaillé toujours FRANÇAIS UNIQUEMENT, non régressé)', async () => {
  const { container, root } = render(baseOrder({ created_at: minutesAgoIso(1285) }), "fr");
  await flush();

  assert.ok(container.textContent!.includes("21h 25min"), "le formatage détaillé français doit rester exact");
  assert.ok(!container.textContent!.includes("—"), "une durée valide ne doit jamais afficher le repli");

  root.unmount();
  container.remove();
});

for (const lang of ["en", "ar"] as const) {
  test(`OrderCard (DOM réel) : ${lang}, durée VALIDE -- comportement dsMinutes EXISTANT préservé (jamais de formatage j/h/min introduit pour cette langue)`, async () => {
    const { container, root } = render(baseOrder({ created_at: minutesAgoIso(1285) }), lang);
    await flush();

    // Le formatage détaillé j/h/min est FRANÇAIS UNIQUEMENT -- pour
    // en/ar, le rendu ne doit JAMAIS contenir "21h 25min" (preuve que
    // ce lot n'élargit pas la portée du formatage à ces langues).
    assert.ok(!container.textContent!.includes("21h 25min"), `${lang} ne doit jamais recevoir le formatage détaillé français`);
    assert.ok(!container.textContent!.includes("—"), "une durée valide ne doit jamais afficher le repli");

    root.unmount();
    container.remove();
  });
}
