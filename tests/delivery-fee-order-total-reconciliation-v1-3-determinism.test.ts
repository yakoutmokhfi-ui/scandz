import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { computeOrderFiscalSummary } = await import("../lib/order-fiscal-summary.ts");
const { buildReceiptHtml } = await import("../lib/receipt.ts");
import type { DashboardOrder, ReceiptSettings } from "../lib/dashboard-types.ts";

// ====================================================================
// Scanym — DELIVERY FEE / ORDER TOTAL RECONCILIATION v1.3
// DURCISSEMENT DÉTERMINISME de la répartition OPTION D (Claude Monet).
//
// Deux constats fermés ici, SANS toucher à la règle comptable CIO :
//
//   A. le classement des restes ne doit reposer sur AUCUNE comparaison
//      flottante -- `order_items.tax_rate_snapshot` étant persisté en
//      numeric(5,2), le reste s'exprime exactement comme un numérateur
//      entier de dénominateur commun au groupe de taux ;
//
//   B. la POSITION dans le tableau `order_items` n'est pas une identité
//      persistée : `getDashboardOrders()` ne trie pas la relation
//      imbriquée, donc deux lectures peuvent renvoyer les lignes dans
//      un ordre différent. Le centime de résidu doit malgré tout
//      toujours tomber sur la MÊME ligne -- départage par
//      `order_items.id`.
// ====================================================================

function item(id: string, line_total: number, tax_rate_snapshot: number | null, quantity = 1) {
  return {
    id,
    item_name: `Produit ${id}`,
    option_name: null,
    quantity,
    unit_price: line_total / quantity,
    line_total,
    tax_rate_snapshot,
  };
}

function allocation(rate: number, gross: number, net: number, tax: number) {
  return {
    tax_rate_snapshot: rate,
    delivery_fee_gross_share: gross,
    delivery_fee_net_share: net,
    delivery_fee_tax_amount: tax,
  };
}

function order(overrides: Partial<DashboardOrder> = {}): DashboardOrder {
  return {
    id: "o1",
    restaurant_id: "r1",
    order_number: 1,
    status: "completed",
    service_mode: "delivery",
    table_number: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    delivery_address: "1 rue de la Livraison",
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 4,
    total: 5,
    currency: "EUR",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    order_items: [item("a-1111", 2, 20), item("b-2222", 2, 20)],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [allocation(20, 1, 0.83, 0.17)],
    ...overrides,
  } as DashboardOrder;
}

function settings(): ReceiptSettings {
  return {
    restaurant_id: "r1",
    business_name: "Au lait cru",
    legal_name: null,
    legal_address: null,
    phone: null,
    email: null,
    tax_identifier: null,
    registration_number: null,
    paper_width_mm: 58,
    show_tax_summary: true,
    prices_include_tax: true,
    tax_label: "TVA",
    default_tax_rate: 20,
    footer_text: null,
  } as ReceiptSettings;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
const presentationOf = (o: DashboardOrder) => {
  const p = computeOrderFiscalSummary(o).commercialPresentation;
  assert.ok(p, "présentation commerciale attendue");
  return p!;
};
/** Répartition indexée par identité persistée -- jamais par position. */
const netById = (o: DashboardOrder) =>
  Object.fromEntries(presentationOf(o).productLines.map((l) => [l.itemId, l.net]));

// --------------------------------------------------------------
// A. Restes mathématiquement ÉGAUX -> identité persistée
// --------------------------------------------------------------
test("A — restes exactement égaux : le centime suit l'order_items.id, jamais la place dans le tableau", () => {
  const lines = [item("z-9999", 2, 20), item("a-0001", 2, 20)];
  const p = presentationOf(order({ order_items: lines as never }));

  const winner = p.productLines.find((l) => l.net === 1.67)!;
  assert.equal(winner.itemId, "a-0001", "id le plus petit, bien qu'il arrive en SECOND dans le tableau");
  assert.equal(p.productLines.find((l) => l.itemId === "z-9999")!.net, 1.66);
  assert.equal(round2(1.67 + 1.66), p.productNet, "réconciliation inchangée");
});

// --------------------------------------------------------------
// B. Deux lectures, deux ordres de tableau -> même attribution
// --------------------------------------------------------------
test("B — mêmes lignes présentées dans DEUX ordres de tableau différents : attribution identique par identité", () => {
  const read1 = order({
    order_items: [item("a-1111", 2, 20), item("b-2222", 2, 20), item("c-3333", 2.25, 20)] as never,
    subtotal: 6.25,
    total: 7.25,
    order_delivery_tax_allocations: [allocation(20, 1, 0.83, 0.17)] as never,
  });
  // Même commande, relation renvoyée dans un autre ordre (ce que la
  // lecture imbriquée non triée autorise parfaitement).
  const read2 = order({
    order_items: [item("c-3333", 2.25, 20), item("b-2222", 2, 20), item("a-1111", 2, 20)] as never,
    subtotal: 6.25,
    total: 7.25,
    order_delivery_tax_allocations: [allocation(20, 1, 0.83, 0.17)] as never,
  });

  assert.deepEqual(netById(read1), netById(read2), "la même ligne reçoit le même HT dans les deux lectures");
  assert.equal(presentationOf(read1).productNet, presentationOf(read2).productNet);

  // Et toutes les permutations donnent le même résultat.
  const reference = netById(read1);
  const items = [item("a-1111", 2, 20), item("b-2222", 2, 20), item("c-3333", 2.25, 20)];
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const perm of permutations) {
    const permuted = order({
      order_items: perm.map((i) => items[i]) as never,
      subtotal: 6.25,
      total: 7.25,
      order_delivery_tax_allocations: [allocation(20, 1, 0.83, 0.17)] as never,
    });
    assert.deepEqual(netById(permuted), reference, `permutation ${perm.join("")} : attribution stable`);
  }
});

// --------------------------------------------------------------
// C. Exécutions répétées : résultat strictement identique
// --------------------------------------------------------------
test("C — 100 exécutions successives : résultat byte-identique, commande jamais mutée", () => {
  const o = order({
    subtotal: 12.55,
    total: 15.55,
    order_items: [
      item("a-1111", 2, 20),
      item("b-2222", 2, 20),
      item("c-3333", 4, 5.5),
      item("d-4444", 4.55, 5.5),
    ] as never,
    order_delivery_tax_allocations: [
      allocation(5.5, 2.04, 1.93, 0.11),
      allocation(20, 0.96, 0.8, 0.16),
    ] as never,
  });
  const reference = JSON.stringify(presentationOf(o).productLines);
  const snapshot = JSON.stringify(o);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(JSON.stringify(presentationOf(o).productLines), reference);
  }
  assert.equal(JSON.stringify(o), snapshot, "la commande d'entrée n'est jamais mutée");
});

// --------------------------------------------------------------
// D. Plus aucune comparaison flottante de reste dans l'algorithme
// --------------------------------------------------------------
test("D — l'algorithme de répartition ne compare AUCUN reste flottant et n'utilise aucune position de tableau", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "order-fiscal-summary.ts"), "utf8");
  const start = src.indexOf("function allocateProductLineNet");
  assert.ok(start > 0, "la fonction de répartition doit exister");
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src
    .slice(start, end > 0 ? end : undefined)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  // Le reste est un entier exact (BigInt), comparé comme tel.
  assert.ok(/remainderNumerator/.test(body), "le reste est un numérateur entier");
  assert.ok(/BigInt\(/.test(body), "arithmétique entière exacte");
  assert.ok(
    !/remainder\s*[-+]\s*|b\.remainder\s*-\s*a\.remainder/.test(body),
    "aucune soustraction de restes flottants pour le classement"
  );
  // Aucune position de tableau : ni index de boucle, ni entries().
  assert.ok(!/\.entries\(\)/.test(body), "aucune énumération indexée des lignes");
  assert.ok(!/\bindex\b/.test(body), "aucune notion de position dans la répartition");
  assert.ok(/itemId\s*<\s*b\.itemId|a\.itemId\s*<\s*b\.itemId/.test(body), "départage par identité persistée");
  // Aucune source non déterministe.
  assert.ok(!/Math\.random|Date\.now|new Date\(/.test(body));
});

test("D bis — le contrat de lecture NE promet AUCUN ordre sur la relation order_items", () => {
  const service = readFileSync(path.join(process.cwd(), "lib", "services", "dashboard.ts"), "utf8");
  const start = service.indexOf("export async function getDashboardOrders");
  const body = service.slice(start, service.indexOf("\n}", start));
  assert.ok(/order_items \(/.test(body), "la relation est bien lue en imbriqué");
  assert.ok(
    !/foreignTable:\s*"order_items"|order\("[^"]*",\s*\{[^}]*foreignTable/.test(body),
    "aucun tri n'est demandé sur la relation : la position ne peut donc pas servir d'identité"
  );
  // C'est précisément pourquoi la répartition n'utilise que l'id.
  const fiscal = readFileSync(path.join(process.cwd(), "lib", "order-fiscal-summary.ts"), "utf8");
  assert.ok(/order_items\.id/.test(fiscal), "la règle de départage est documentée dans le module fiscal");
});

// --------------------------------------------------------------
// E. Les fixtures d'origine restent EXACTES
// --------------------------------------------------------------
test("E — fixtures inchangées : 20 %, 5,5 %, 10 % et taux mixtes donnent exactement les mêmes montants", () => {
  const at20 = presentationOf(order());
  assert.equal(at20.productNet, 3.33);
  assert.deepEqual(at20.productLines.map((l) => l.net).sort(), [1.66, 1.67]);

  const at55 = presentationOf(
    order({
      order_items: [item("a-1111", 2, 5.5), item("b-2222", 2, 5.5)] as never,
      order_delivery_tax_allocations: [allocation(5.5, 1, 0.95, 0.05)] as never,
    })
  );
  assert.equal(at55.productNet, 3.79);
  assert.deepEqual(at55.productLines.map((l) => l.net).sort(), [1.89, 1.9]);

  const at10 = presentationOf(
    order({
      subtotal: 4.25,
      total: 5.25,
      order_items: [item("a-1111", 2, 10), item("b-2222", 2.25, 10)] as never,
      order_delivery_tax_allocations: [allocation(10, 1, 0.91, 0.09)] as never,
    })
  );
  assert.equal(at10.productNet, 3.86);
  assert.deepEqual(at10.productLines.map((l) => [l.itemId, l.net]), [
    ["a-1111", 1.82],
    ["b-2222", 2.04],
  ]);

  const mixed = presentationOf(
    order({
      subtotal: 12.55,
      total: 15.55,
      order_items: [
        item("a-1111", 2, 20),
        item("b-2222", 2, 20),
        item("c-3333", 4, 5.5),
        item("d-4444", 4.55, 5.5),
      ] as never,
      order_delivery_tax_allocations: [
        allocation(5.5, 2.04, 1.93, 0.11),
        allocation(20, 0.96, 0.8, 0.16),
      ] as never,
    })
  );
  for (const rateRow of mixed.productRates) {
    const sumForRate = round2(
      mixed.productLines.filter((l) => l.rate === rateRow.rate).reduce((acc, l) => acc + l.net, 0)
    );
    assert.equal(sumForRate, rateRow.net, `groupe ${rateRow.rate}% : somme des lignes = HT canonique`);
  }
});

// --------------------------------------------------------------
// F/G/H/I. Rien d'autre n'a bougé
// --------------------------------------------------------------
test("F/G — HT et TVA canoniques inchangés, les lignes HT réconcilient toujours", () => {
  const o = order({
    subtotal: 12.55,
    total: 15.55,
    order_items: [
      item("a-1111", 2, 20),
      item("b-2222", 2, 20),
      item("c-3333", 4, 5.5),
      item("d-4444", 4.55, 5.5),
    ] as never,
    order_delivery_tax_allocations: [
      allocation(5.5, 2.04, 1.93, 0.11),
      allocation(20, 0.96, 0.8, 0.16),
    ] as never,
  });
  const f = computeOrderFiscalSummary(o);
  const p = f.commercialPresentation!;

  assert.equal(f.mode, "mixed-rate", "vue fiscale complète intacte");
  if (f.mode === "mixed-rate") {
    assert.equal(f.rates.find((r) => r.rate === 20)!.gross, 4.96);
    assert.equal(f.rates.find((r) => r.rate === 5.5)!.gross, 10.59);
    assert.equal(round2(f.rates.reduce((acc, r) => acc + r.gross, 0)), 15.55);
  }
  assert.equal(p.productRates.find((r) => r.rate === 20)!.tax, 0.67, "TVA produit canonique");
  assert.equal(p.productRates.find((r) => r.rate === 5.5)!.tax, 0.45);
  assert.equal(round2(p.productLines.reduce((acc, l) => acc + l.net, 0)), p.productNet);
  assert.equal(round2(p.productNet + p.productTax + p.deliveryGrossTtc), 15.55);
});

test("H/I — livraison affichée UNE fois en TTC, Total TTC = orders.total", () => {
  const o = order();
  const before = JSON.parse(JSON.stringify(o.order_delivery_tax_allocations));
  const p = presentationOf(o);
  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });

  assert.deepEqual(o.order_delivery_tax_allocations, before, "ventilation persistée intacte");
  assert.equal(p.deliveryGrossTtc, 1);
  assert.equal((html.match(/Frais de livraison TTC/g) ?? []).length, 1);
  assert.ok(
    !html.includes(`<span>TVA produits 20%</span><span>${money(0.84)}</span>`),
    "la TVA combinée n'est jamais imprimée (anti-double-comptage v1.1 toujours en vigueur)"
  );
  assert.equal(p.finalGrossTtc, Number(o.total));
  assert.ok(html.includes(money(5)), "Total TTC = orders.total");
});

// --------------------------------------------------------------
// Contrat persisté du taux : numeric(5,2)
// --------------------------------------------------------------
test("contrat — tax_rate_snapshot est persisté en numeric(5,2), borné 0..100 : le taux est un rationnel exact", () => {
  const ddl = readFileSync(
    path.join(process.cwd(), "supabase", "DRAFT-lot-receipt-invoice-tax-detail-v1.sql"),
    "utf8"
  ).replace(/\s+/g, " ");
  assert.ok(ddl.includes("add column tax_rate_snapshot numeric(5,2)"), "échelle persistée = 2 décimales");
  assert.ok(
    /tax_rate_snapshot is null or \(tax_rate_snapshot >= 0 and tax_rate_snapshot <= 100\)/.test(ddl),
    "borné 0..100"
  );

  // Un taux à deux décimales exactes est traité exactement...
  const twoDecimals = presentationOf(
    order({
      subtotal: 4,
      total: 5,
      order_items: [item("a-1111", 2, 8.25), item("b-2222", 2, 8.25)] as never,
      order_delivery_tax_allocations: [allocation(8.25, 1, 0.92, 0.08)] as never,
    })
  );
  assert.equal(
    round2(twoDecimals.productLines.reduce((acc, l) => acc + l.net, 0)),
    twoDecimals.productNet,
    "réconciliation exacte à 8,25 %"
  );

  // ... et une valeur hors contrat (plus de 2 décimales) fait renoncer
  // à la répartition plutôt que d'être arrondie en silence.
  const outOfContract = computeOrderFiscalSummary(
    order({
      order_items: [item("a-1111", 2, 20.005), item("b-2222", 2, 20.005)] as never,
      order_delivery_tax_allocations: [allocation(20.005, 1, 0.83, 0.17)] as never,
    })
  );
  assert.equal(
    outOfContract.commercialPresentation,
    null,
    "aucune ligne HT fabriquée pour un taux hors du contrat persisté"
  );
});
