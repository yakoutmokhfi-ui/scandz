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
// Scanym — TVA / HT / TTC COMPLETION v1 — preuve DE RENDU (§6).
//
// Le vrai components/dashboard/OrderCard.tsx est rendu dans un DOM
// réel. On vérifie que le récapitulatif fiscal est bien AFFICHÉ, et
// surtout que les montants affichés sont EXACTEMENT ceux que retourne
// le contrat partagé -- c'est la preuve, au niveau de l'interface, que
// le back-office ne recalcule rien de son côté (mandat §4).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard",
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

const { computeOrderFiscalSummary } = await import("../lib/order-fiscal-summary.ts");
const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();
const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
      return { path: c ?? base };
    });
  },
};
const built = await esbuild.build({
  stdin: {
    contents: `export { default } from "@/components/dashboard/OrderCard";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-fiscal-dom-"));
const tmpFile = path.join(tmpDir, "OrderCard.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { default: OrderCard } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function item(id: string, line_total: number, rate: number | null, quantity = 1) {
  return {
    id,
    item_name: `Produit ${id}`,
    option_name: null,
    quantity,
    unit_price: line_total / quantity,
    line_total,
    tax_rate_snapshot: rate,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    restaurant_id: "r1",
    order_number: 16,
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
    subtotal: 20,
    total: 20,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [item("A", 10, 20), item("B", 10, 5.5)],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [],
    ...overrides,
  };
}

function render(o: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderCard, {
      order: o,
      restaurantName: "Au lait cru",
      receiptSettings: null,
      onStatus: async () => {},
      busy: false,
      staffLanguage: "fr",
    })
  );
  return { container, root };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function fiscalValue(c: Element, key: string): string | null {
  return c.querySelector(`[data-fiscal="${key}"]`)?.textContent?.trim() ?? null;
}

const eur = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);

test("§6 — le back-office AFFICHE Total HT / TVA / Total TTC, avec exactement les montants du contrat partagé", async () => {
  const o = order();
  const f: any = computeOrderFiscalSummary(o as any);
  const { container, root } = render(o);
  try {
    await flush();
    const text = container.textContent ?? "";
    assert.ok(text.includes("Total HT"), "libellé Total HT requis");
    assert.ok(text.includes("TVA"), "libellé TVA requis");
    assert.ok(text.includes("Total TTC"), "libellé Total TTC requis");

    assert.equal(fiscalValue(container, "total-ht"), eur(f.totalNet), "Total HT affiché = contrat");
    assert.equal(fiscalValue(container, "total-vat"), eur(f.totalTax), "TVA affichée = contrat");
    assert.equal(fiscalValue(container, "total-ttc"), eur(f.totalGross), "Total TTC affiché = contrat");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§2/§6 — plusieurs taux : un 'Détail TVA' avec une ligne par taux, chaque ligne portant base HT, TVA et TTC", async () => {
  const o = order({
    subtotal: 30,
    total: 30,
    order_items: [item("A", 10, 20), item("B", 10, 10), item("C", 10, 5.5)],
  });
  const f: any = computeOrderFiscalSummary(o as any);
  const { container, root } = render(o);
  try {
    await flush();
    assert.ok((container.textContent ?? "").includes("Détail TVA"), "le détail par taux doit apparaître");
    const rows = [...container.querySelectorAll("[data-fiscal-rate]")];
    assert.equal(rows.length, 3, "une ligne par taux");
    assert.deepEqual(
      rows.map((r) => r.getAttribute("data-fiscal-rate")),
      ["5.5", "10", "20"],
      "triées par taux croissant, comme le contrat"
    );
    for (const r of f.rates) {
      const row = container.querySelector(`[data-fiscal-rate="${r.rate}"]`);
      assert.ok(row, `ligne ${r.rate}% présente`);
      const rowText = row!.textContent ?? "";
      assert.ok(rowText.includes(eur(r.net)), `ligne ${r.rate}% : base HT affichée`);
      assert.ok(rowText.includes(eur(r.tax)), `ligne ${r.rate}% : TVA affichée`);
      assert.ok(rowText.includes(eur(r.gross)), `ligne ${r.rate}% : TTC affiché`);
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§6 — un seul taux : PAS de bloc 'Détail TVA' (interface compacte), mais HT/TVA/TTC toujours explicites", async () => {
  const o = order({ order_items: [item("A", 20, 20)] });
  const { container, root } = render(o);
  try {
    await flush();
    const text = container.textContent ?? "";
    assert.ok(!text.includes("Détail TVA"), "pas de tableau superflu pour un taux unique");
    assert.ok(text.includes("Total HT") && text.includes("Total TTC"));
    assert.equal(container.querySelectorAll("[data-fiscal-rate]").length, 0);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§3 — commande sans instantané fiscal : AUCUNE TVA affichée, seul le total autoritaire, avec un message explicite", async () => {
  const o = order({
    tax_settings_snapshot_default_tax_rate: null,
    tax_settings_snapshot_prices_include_tax: null,
    tax_settings_snapshot_tax_label: null,
    tax_settings_snapshot_show_tax_summary: null,
    order_items: [item("A", 20, null)],
  });
  const { container, root } = render(o);
  try {
    await flush();
    const block = container.querySelector("[data-fiscal-mode]");
    assert.equal(block?.getAttribute("data-fiscal-mode"), "unavailable");
    assert.equal(fiscalValue(container, "total-ht"), null, "aucun Total HT fabriqué");
    assert.equal(fiscalValue(container, "total-vat"), null, "aucune TVA fabriquée");
    assert.equal(fiscalValue(container, "total-ttc"), eur(20), "le total autoritaire reste affiché");
  } finally {
    root.unmount();
    container.remove();
  }
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
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
