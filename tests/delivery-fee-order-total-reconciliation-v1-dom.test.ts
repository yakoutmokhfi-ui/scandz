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
// Scanym — DELIVERY FEE / ORDER TOTAL RECONCILIATION v1 — preuve DE
// RENDU back-office (§8, §14.10/11/14).
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dfot-dom-"));
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


const composition = (c: Element, key: string): string | null =>
  c.querySelector(`[data-composition="${key}"]`)?.textContent?.trim() ?? null;

/** Commande de LIVRAISON telle que create_order la persiste. */
function deliveryOrder(overrides: Record<string, unknown> = {}) {
  return order({
    service_mode: "delivery",
    delivery_address: "1 rue de la Livraison",
    subtotal: 39.6,
    total: 47.1,
    order_items: [
      item("A", 9.8, 10),
      item("B", 13.6, 10),
      item("C", 10.4, 10),
      item("D", 5.8, 10),
    ],
    order_delivery_tax_allocations: [
      {
        tax_rate_snapshot: 10,
        delivery_fee_gross_share: 7.5,
        delivery_fee_net_share: 6.82,
        delivery_fee_tax_amount: 0.68,
      },
    ],
    ...overrides,
  });
}

test("§8/§14.10 — livraison avec frais : le back-office ITEMISE le frais et l'addition est visible", async () => {
  const o = deliveryOrder();
  const f: any = computeOrderFiscalSummary(o as any);
  const { container, root } = render(o);
  try {
    await flush();
    const text = container.textContent ?? "";
    assert.ok(text.includes("Sous-total produits"), "libellé sous-total produits requis");
    assert.ok(text.includes("Frais de livraison"), "libellé frais de livraison requis");

    assert.equal(composition(container, "products-subtotal"), eur(39.6));
    assert.equal(composition(container, "delivery-fee"), eur(7.5));
    assert.equal(fiscalValue(container, "total-ttc"), eur(47.1));
    assert.equal(
      Number((f.productsSubtotal + f.deliveryFee).toFixed(2)),
      Number(o.total),
      "INVARIANT affiché : produits + livraison = total autoritaire"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§14.11 — le montant final proéminent reste EXACTEMENT orders.total", async () => {
  const o = deliveryOrder();
  const { container, root } = render(o);
  try {
    await flush();
    const amounts = [...container.querySelectorAll("span")]
      .map((s) => s.textContent?.trim() ?? "")
      .filter((tx) => tx === eur(47.1));
    assert.ok(amounts.length >= 2, "le total autoritaire est affiché (Total TTC + montant proéminent)");
    assert.ok(
      !(container.textContent ?? "").includes(eur(54.6)),
      "jamais de total gonflé par un second ajout du frais"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§14.13 — aucun double comptage : une seule ligne frais, une seule ligne sous-total", async () => {
  const o = deliveryOrder();
  const { container, root } = render(o);
  try {
    await flush();
    assert.equal(container.querySelectorAll('[data-composition="delivery-fee"]').length, 1);
    assert.equal(container.querySelectorAll('[data-composition="products-subtotal"]').length, 1);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§14.4/5/6 — retrait, table et livraison gratuite : AUCUNE ligne de frais fabriquée", async () => {
  for (const o of [
    order({ service_mode: "pickup" }),
    order({ service_mode: "table", table_number: 3 }),
    deliveryOrder({ subtotal: 39.6, total: 39.6, order_delivery_tax_allocations: [] }),
  ]) {
    const { container, root } = render(o);
    try {
      await flush();
      const text = container.textContent ?? "";
      assert.ok(!text.includes("Frais de livraison"), `aucun frais affiché (${o.service_mode})`);
      assert.ok(!text.includes("Sous-total produits"), `aucun sous-total affiché (${o.service_mode})`);
      assert.equal(container.querySelectorAll("[data-order-composition]").length, 0);
    } finally {
      root.unmount();
      container.remove();
    }
  }
});

test("§14.9 — commande historique sans ventilation TVA livraison : frais visible, AUCUNE TVA fabriquée", async () => {
  const o = deliveryOrder({ order_delivery_tax_allocations: [] });
  const { container, root } = render(o);
  try {
    await flush();
    const zone = container.querySelector("[data-fiscal-mode]")!;
    assert.equal(zone.getAttribute("data-fiscal-mode"), "unavailable", "repli sûr conservé");
    assert.equal(composition(container, "products-subtotal"), eur(39.6), "composition toujours exacte");
    assert.equal(composition(container, "delivery-fee"), eur(7.5));
    assert.equal(fiscalValue(container, "total-ttc"), eur(47.1), "total autoritaire seul");
    assert.ok(!(container.textContent ?? "").includes("Total HT"), "aucune décomposition fabriquée");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§14.14 — aucune régression des lignes produit du back-office", async () => {
  const o = deliveryOrder();
  const { container, root } = render(o);
  try {
    await flush();
    const text = container.textContent ?? "";
    for (const [label, amount] of [["Produit A", 9.8], ["Produit B", 13.6], ["Produit C", 10.4], ["Produit D", 5.8]] as const) {
      assert.ok(text.includes(label), `${label} doit rester affiché`);
      assert.ok(text.includes(eur(amount)), `montant de ${label} inchangé`);
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

test("§14.2/3 — fixtures équivalentes aux captures marchand : 39,60+7,50=47,10 et 44,80+12,00=56,80", async () => {
  const cases = [
    { subtotal: 39.6, fee: 7.5, total: 47.1, net: 6.82, tax: 0.68 },
    { subtotal: 44.8, fee: 12, total: 56.8, net: 10.91, tax: 1.09 },
  ];
  for (const c of cases) {
    const o = deliveryOrder({
      subtotal: c.subtotal,
      total: c.total,
      order_items: [item("A", c.subtotal, 10)],
      order_delivery_tax_allocations: [
        {
          tax_rate_snapshot: 10,
          delivery_fee_gross_share: c.fee,
          delivery_fee_net_share: c.net,
          delivery_fee_tax_amount: c.tax,
        },
      ],
    });
    const { container, root } = render(o);
    try {
      await flush();
      assert.equal(composition(container, "products-subtotal"), eur(c.subtotal));
      assert.equal(composition(container, "delivery-fee"), eur(c.fee));
      assert.equal(fiscalValue(container, "total-ttc"), eur(c.total));
    } finally {
      root.unmount();
      container.remove();
    }
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
