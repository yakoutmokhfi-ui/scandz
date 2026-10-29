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
// Scanym — INVOICE BACKOFFICE VISIBILITY + BILLING ADDRESS v1
// (Claude Monet), mandat Section E / matrice de test §I, éléments
// 11 à 16.
//
// Preuve comportementale RÉELLE (rendu React dans un vrai DOM, patron
// esbuild/jsdom déjà établi -- voir
// tests/v133-receipt-invoice-name-history.dom.test.ts) que
// components/dashboard/OrderCard.tsx affiche désormais la demande de
// facture (order_invoice_request) QUAND ELLE EXISTE, sans jamais
// afficher de statut de génération/envoi (mandat, littéral : "Do NOT
// display 'Facture générée'/'Envoyée'"). Le dernier test (16) prouve,
// par un mock direct de `supabase.from`, que
// `lib/services/dashboard.ts` embarque désormais la relation
// `order_invoice_request` dans sa requête -- SANS introduire
// d'endpoint service-role (même client authentifié qu'avant ce lot).
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
export { buildReceiptHtml } from "@/lib/receipt";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-170-"));
const tmpFile = path.join(tmpDir, "OrderCard.mjs");
writeFileSync(tmpFile, code);
const { OrderCard, buildReceiptHtml } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    restaurant_id: "r1",
    order_number: 42,
    status: "new",
    service_mode: "delivery",
    table_number: null,
    customer_name: "Yakout",
    customer_phone: "0612345678",
    customer_email: null,
    delivery_address: "10 rue de Rivoli, 75001 Paris",
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 15,
    total: 15,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [
      {
        id: "i1",
        item_name: "Cookie chocolat",
        option_name: null,
        quantity: 2,
        unit_price: 7.5,
        line_total: 15,
      },
    ],
    // Par défaut, AUCUNE demande de facture (cas normal, majoritaire) --
    // chaque test ci-dessous fournit `order_invoice_request` explicitement
    // lorsqu'il veut prouver le comportement inverse.
    order_invoice_request: null,
    ...overrides,
  };
}

function render(order: Record<string, unknown>, staffLanguage: "fr" | "en" | "ar" = "fr") {
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


// ====================================================================
// ISSUE #170 -- CRÉNEAU DE RETRAIT (et de livraison) VISIBLE PAR LE
// COMMERÇANT, indépendamment de WhatsApp.
//
// Chaîne tracée :
//   1. checkout -> `p_customer.schedule` {date, slot_key, starts_at,
//      ends_at} (tests/csdj2-checkout-schedule-158.dom.test.ts [158-D1],
//      lib/services/order-payload.ts) ;
//   2. `create_order` HÉBERGÉ (bloc CSDJ-3, hors dépôt) valide la
//      sélection et écrit public.order_fulfillment_schedule_snapshot
//      (scheduled_date, slot_key, selected_time, window_starts_at,
//      window_ends_at, timezone, origin…) -- preuve hébergée : définition
//      de la fonction et lignes existantes relevées en lecture seule,
//      voir la PR ; requête reproductible :
//      supabase/tests/issue-170-order-schedule-snapshot-check.sql ;
//   3. back-office : lib/services/dashboard.ts embarque la relation 1:1
//      (RLS staff hébergée), components/dashboard/OrderCard.tsx et
//      lib/receipt.ts l'affichent -- CE fichier.
// Données synthétiques ; les lignes ci-dessous ont EXACTEMENT la forme
// des colonnes hébergées (relevée le 28/10/2026).
// ====================================================================

const PICKUP_SNAPSHOT = {
  mode_code: "pickup",
  scheduled_date: "2026-10-30",
  slot_key: "16-20",
  selected_time: null,
  window_starts_at: "16:00",
  window_ends_at: "20:00",
  timezone: "Europe/Paris",
  origin: "customer",
};

test("[#170-1] OrderCard, commande RETRAIT avec snapshot : « Retrait prévu : ven. 30 oct. 2026 · 16:00–20:00 » visible, sans WhatsApp", async () => {
  const { container, root } = render(baseOrder({ service_mode: "pickup", delivery_address: null, order_fulfillment_schedule_snapshot: PICKUP_SNAPSHOT }));
  await flush();
  try {
    const el = container.querySelector("[data-order-schedule]");
    assert.ok(el, "la ligne de créneau doit être rendue");
    assert.equal(el!.getAttribute("data-order-schedule-mode"), "pickup");
    assert.equal(el!.textContent, "Retrait prévu : ven. 30 oct. 2026 · 16:00–20:00");
    assert.ok(!/whatsapp/i.test(container.innerHTML), "aucune dépendance WhatsApp dans la fiche");
  } finally { root.unmount(); container.remove(); }
});

test("[#170-2] OrderCard, commande LIVRAISON avec créneau libre (selected_time) : « Livraison prévue : … · 12:30 »", async () => {
  const snap = { ...PICKUP_SNAPSHOT, mode_code: "delivery", slot_key: null, selected_time: "12:30", window_starts_at: "11:00", window_ends_at: "14:00", scheduled_date: "2026-11-02" };
  const { container, root } = render(baseOrder({ order_fulfillment_schedule_snapshot: snap }));
  await flush();
  try {
    const el = container.querySelector("[data-order-schedule]")!;
    assert.equal(el.textContent, "Livraison prévue : lun. 2 nov. 2026 · 12:30", "l'heure choisie prime sur la fenêtre");
  } finally { root.unmount(); container.remove(); }
});

test("[#170-3] OrderCard, AUCUN snapshot (null / absent) : aucune ligne de créneau, rendu inchangé", async () => {
  for (const over of [{ order_fulfillment_schedule_snapshot: null }, {}]) {
    const { container, root } = render(baseOrder({ service_mode: "pickup", ...over }));
    await flush();
    try {
      assert.equal(container.querySelector("[data-order-schedule]") === null, true);
      assert.ok(!/prévu/i.test(container.textContent ?? ""));
    } finally { root.unmount(); container.remove(); }
  }
});

test("[#170-4] OrderCard, date seule (slot none : aucune heure figée) : la date est affichée sans heure ; date malformée : rien (jamais une valeur inventée)", async () => {
  const dateOnly = { ...PICKUP_SNAPSHOT, slot_key: null, window_starts_at: null, window_ends_at: null };
  let r = render(baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: dateOnly }));
  await flush();
  try {
    assert.equal(r.container.querySelector("[data-order-schedule]")!.textContent, "Retrait prévu : ven. 30 oct. 2026");
  } finally { r.root.unmount(); r.container.remove(); }
  r = render(baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: { ...PICKUP_SNAPSHOT, scheduled_date: "2026-02-31" } }));
  await flush();
  try {
    assert.equal(r.container.querySelector("[data-order-schedule]") === null, true, "date impossible -> rien");
  } finally { r.root.unmount(); r.container.remove(); }
});

async function waitForSchedule(container: Element): Promise<Element> {
  for (let i = 0; i < 50; i++) {
    const el = container.querySelector("[data-order-schedule]");
    if (el) return el;
    await flush();
  }
  throw new Error("ligne de créneau non rendue");
}

test("[#170-5] OrderCard en anglais et en arabe : libellé traduit, même date (jour civil), même créneau", async () => {
  const en = render(baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: PICKUP_SNAPSHOT }), "en");
  try {
    const enText = (await waitForSchedule(en.container)).textContent ?? "";
    assert.match(enText, /^Pickup scheduled : .*30.*2026 · 16:00–20:00$/);
  } finally { en.root.unmount(); en.container.remove(); }
  const ar = render(baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: PICKUP_SNAPSHOT }), "ar");
  try {
    const arText = (await waitForSchedule(ar.container)).textContent ?? "";
    assert.ok(arText.startsWith("موعد الاستلام"), arText);
    assert.ok(arText.includes("16:00–20:00"));
  } finally { ar.root.unmount(); ar.container.remove(); }
});

test("[#170-6] ticket imprimé (buildReceiptHtml) : la ligne « Retrait prévu : … » est présente, échappée, et absente sans snapshot", async () => {
  const withSnap = buildReceiptHtml({ order: baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: PICKUP_SNAPSHOT }), restaurantName: "Au Lait Cru (test)", settings: null }, "fr");
  assert.ok(withSnap.includes("Retrait prévu : ven. 30 oct. 2026 · 16:00–20:00"), "ligne de créneau sur le ticket");
  const without = buildReceiptHtml({ order: baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: null }), restaurantName: "Au Lait Cru (test)", settings: null }, "fr");
  assert.ok(!without.includes("prévu"), "aucune ligne sans snapshot");
  // Échappement : une valeur hostile dans une colonne texte ne devient jamais du balisage.
  const hostile = buildReceiptHtml({ order: baseOrder({ service_mode: "pickup", order_fulfillment_schedule_snapshot: { ...PICKUP_SNAPSHOT, window_starts_at: "<b>", window_ends_at: null } }), restaurantName: "X", settings: null }, "fr");
  assert.ok(!hostile.includes("<b>"), "forme HH:MM exigée, sinon ignorée ; jamais injectée");
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame"]) delete (globalThis as any)[k];
});
