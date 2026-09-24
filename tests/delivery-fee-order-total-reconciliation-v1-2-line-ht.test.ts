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
// Scanym — DELIVERY FEE / ORDER TOTAL RECONCILIATION v1.2 (Claude Monet)
// LIGNES PRODUIT EN HT — décision CIO, OPTION D.
//
// INVARIANT AFFICHÉ, cent pour cent :
//
//     somme des HT de LIGNE = « Sous-total produits HT »
//   + TVA PRODUITS par taux instantané (canonique, inchangée)
//   + LIVRAISON TTC (persistée, inchangée)
//   = TOTAL TTC = orders.total
//
// La répartition du résidu de centime est une décision de PRÉSENTATION
// et rien d'autre : aucun total fiscal, aucune TVA, aucune ventilation
// livraison, aucune valeur persistée n'est modifiée.
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

/** Commande de livraison PAYANTE, telle que create_order la persiste. */
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
    order_items: [item("A", 2, 20), item("B", 2, 20)],
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

const money = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const receipt = (o: DashboardOrder) =>
  buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
const presentationOf = (o: DashboardOrder) => {
  const p = computeOrderFiscalSummary(o).commercialPresentation;
  assert.ok(p, "présentation commerciale attendue sur cette commande");
  return p!;
};
/** Arrondi NAÏF, ligne par ligne -- exactement ce que l'OPTION D remplace. */
const naiveLineNet = (gross: number, rate: number) => round2(gross / (1 + rate / 100));

// --------------------------------------------------------------
// 1/2/3. Le cas d'arrondi, aux trois taux courants (jamais codés en dur
// dans le produit : ce sont des fixtures).
// --------------------------------------------------------------
test("1 — 2,00 + 2,00 TTC à 20 % : les HT affichés totalisent le HT canonique 3,33 €", () => {
  const p = presentationOf(order());

  assert.deepEqual(
    p.productLines.map((l) => [l.itemId, l.net]),
    [
      ["A", 1.67],
      ["B", 1.66],
    ],
    "répartition déterministe : le centige va à la première ligne à reste égal"
  );
  assert.equal(round2(p.productLines.reduce((acc, l) => acc + l.net, 0)), 3.33, "somme = HT canonique");
  assert.equal(p.productNet, 3.33);
  assert.equal(p.productRates[0].tax, 0.67, "TVA canonique du taux 20 %");
  assert.equal(round2(p.productNet + p.productRates[0].tax), 4, "3,33 + 0,67 = 4,00 TTC produits");
  assert.equal(round2(p.productNet + p.productTax + p.deliveryGrossTtc), 5, "= Total TTC");

  // Le résultat NAÏF (1,67 + 1,67 = 3,34) est bien celui qu'on évite.
  assert.equal(naiveLineNet(2, 20), 1.67);
  assert.notEqual(round2(naiveLineNet(2, 20) * 2), p.productNet);
});

test("2 — même problème à 5,5 % : les HT affichés totalisent le HT canonique", () => {
  const o = order({
    order_items: [item("A", 2, 5.5), item("B", 2, 5.5)],
    order_delivery_tax_allocations: [allocation(5.5, 1, 0.95, 0.05)] as never,
  });
  const p = presentationOf(o);
  const canonical = p.productRates.find((r) => r.rate === 5.5)!.net;

  assert.equal(canonical, 3.79, "round(4,00 / 1,055) = 3,79");
  assert.equal(round2(p.productLines.reduce((acc, l) => acc + l.net, 0)), canonical);
  assert.deepEqual(p.productLines.map((l) => l.net), [1.9, 1.89], "un centime de résidu, attribué à la 1re ligne");
  assert.notEqual(round2(naiveLineNet(2, 5.5) * 2), canonical, "l'arrondi naïf diverge (3,78)");
});

test("3 — même problème à 10 % : les HT affichés totalisent le HT canonique", () => {
  const o = order({
    subtotal: 4.25,
    total: 5.25,
    order_items: [item("A", 2, 10), item("B", 2.25, 10)],
    order_delivery_tax_allocations: [allocation(10, 1, 0.91, 0.09)] as never,
  });
  const p = presentationOf(o);
  const canonical = p.productRates.find((r) => r.rate === 10)!.net;

  assert.equal(canonical, 3.86, "round(4,25 / 1,10) = 3,86");
  assert.equal(round2(p.productLines.reduce((acc, l) => acc + l.net, 0)), canonical);
  assert.deepEqual(
    p.productLines.map((l) => l.net),
    [1.82, 2.04],
    "le centime va au plus grand reste (0,8181… contre 0,4545…)"
  );
  assert.notEqual(
    round2(naiveLineNet(2, 10) + naiveLineNet(2.25, 10)),
    canonical,
    "l'arrondi naïf diverge (3,85)"
  );
});

// --------------------------------------------------------------
// 4/8. Répartition ISOLÉE par groupe de taux
// --------------------------------------------------------------
test("4/8 — taux mixtes : la répartition est isolée par groupe, chaque groupe retombe sur son HT canonique", () => {
  const o = order({
    subtotal: 12.55,
    total: 15.55,
    order_items: [item("A", 2, 20), item("B", 2, 20), item("C", 4, 5.5), item("D", 4.55, 5.5)],
    order_delivery_tax_allocations: [
      allocation(5.5, 2.04, 1.93, 0.11),
      allocation(20, 0.96, 0.8, 0.16),
    ] as never,
  });
  const p = presentationOf(o);

  for (const rateRow of p.productRates) {
    const sumForRate = round2(
      p.productLines.filter((l) => l.rate === rateRow.rate).reduce((acc, l) => acc + l.net, 0)
    );
    assert.equal(
      sumForRate,
      rateRow.net,
      `la somme des HT de ligne du taux ${rateRow.rate}% doit égaler son HT canonique`
    );
  }
  assert.equal(round2(p.productLines.reduce((acc, l) => acc + l.net, 0)), p.productNet);
  assert.equal(round2(p.productNet + p.productTax + p.deliveryGrossTtc), Number(o.total));
});

// --------------------------------------------------------------
// 5/6. Déterminisme : départage stable, résultat reproductible
// --------------------------------------------------------------
test("5 — départage DÉTERMINISTE : à reste EXACTEMENT égal, c'est l'identité persistée qui tranche, jamais la position", () => {
  // v1.3 : deux lignes de 2,00 € à 20 % ont le MÊME reste exact. Le
  // centime va à l'`order_items.id` le plus petit -- quel que soit
  // l'ordre dans lequel la relation a été renvoyée par la base.
  const inOrder = presentationOf(order({ order_items: [item("A", 2, 20), item("B", 2, 20)] as never }));
  const reversed = presentationOf(order({ order_items: [item("B", 2, 20), item("A", 2, 20)] as never }));

  const cent = (p: ReturnType<typeof presentationOf>) =>
    p.productLines.find((l) => l.net === 1.67)!.itemId;

  assert.equal(cent(inOrder), "A", "id le plus petit");
  assert.equal(cent(reversed), "A", "MÊME ligne, même si elle arrive en second");
  assert.equal(
    round2(reversed.productLines.reduce((acc, l) => acc + l.net, 0)),
    reversed.productNet,
    "la réconciliation tient dans les deux lectures"
  );
});

test("6 — STABILITÉ : 50 exécutions successives donnent un résultat stricitement identique", () => {
  const o = order({
    subtotal: 12.55,
    total: 15.55,
    order_items: [item("A", 2, 20), item("B", 2, 20), item("C", 4, 5.5), item("D", 4.55, 5.5)],
    order_delivery_tax_allocations: [
      allocation(5.5, 2.04, 1.93, 0.11),
      allocation(20, 0.96, 0.8, 0.16),
    ] as never,
  });
  const reference = JSON.stringify(presentationOf(o).productLines);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(JSON.stringify(presentationOf(o).productLines), reference, "aucun aléa, aucun état partagé");
  }
  // Et la commande elle-même n'est jamais mutée par le calcul.
  assert.equal(Number(o.subtotal), 12.55);
  assert.equal(o.order_items[0].line_total, 2);
});

// --------------------------------------------------------------
// 7. Le TICKET : chaque ligne produit est en HT, et l'addition se
//    vérifie à la main.
// --------------------------------------------------------------
test("7 — le ticket affiche CHAQUE ligne produit en HT, et les lignes totalisent le sous-total affiché", () => {
  const o = order({
    subtotal: 12.55,
    total: 15.55,
    order_items: [item("A", 2, 20), item("B", 2, 20), item("C", 4, 5.5), item("D", 4.55, 5.5)],
    order_delivery_tax_allocations: [
      allocation(5.5, 2.04, 1.93, 0.11),
      allocation(20, 0.96, 0.8, 0.16),
    ] as never,
  });
  const p = presentationOf(o);
  const html = receipt(o);

  for (const line of p.productLines) {
    assert.ok(
      html.includes(`${money(line.net)} HT`),
      `la ligne ${line.itemId} doit être imprimée en HT (${money(line.net)})`
    );
  }
  // Les montants TTC des lignes ne sont plus imprimés comme montant de
  // ligne (4,55 € n'apparaît nulle part : ni ligne, ni total).
  assert.ok(!html.includes(money(4.55)), "aucun montant TTC de ligne résiduel");
  assert.ok(html.includes(`${money(p.productNet)}`), "sous-total produits HT affiché");
  assert.ok(html.includes(money(Number(o.total))), "Total TTC = orders.total");

  // Vérification "à la main" de tout le bloc imprimé.
  const displayedLineSum = round2(p.productLines.reduce((acc, l) => acc + l.net, 0));
  const displayedVatSum = round2(p.productRates.reduce((acc, r) => acc + r.tax, 0));
  assert.equal(
    round2(displayedLineSum + displayedVatSum + p.deliveryGrossTtc),
    Number(o.total),
    "lignes HT + TVA produits + livraison TTC = Total TTC"
  );
});

// --------------------------------------------------------------
// 9/10/11/12. Rien d'autre n'a bougé
// --------------------------------------------------------------
test("9 — la TVA canonique par taux est INCHANGÉE par la répartition", () => {
  const o = order({
    subtotal: 12.55,
    total: 15.55,
    order_items: [item("A", 2, 20), item("B", 2, 20), item("C", 4, 5.5), item("D", 4.55, 5.5)],
    order_delivery_tax_allocations: [
      allocation(5.5, 2.04, 1.93, 0.11),
      allocation(20, 0.96, 0.8, 0.16),
    ] as never,
  });
  const f = computeOrderFiscalSummary(o);
  const p = f.commercialPresentation!;

  // Vue A (autorité fiscale interne) : produit + livraison, intacte.
  assert.equal(f.mode, "mixed-rate");
  if (f.mode === "mixed-rate") {
    const g20 = f.rates.find((r) => r.rate === 20)!;
    const g55 = f.rates.find((r) => r.rate === 5.5)!;
    assert.equal(g20.gross, 4.96, "4,00 produits + 0,96 livraison");
    assert.equal(g55.gross, 10.59, "8,55 produits + 2,04 livraison");
    assert.equal(round2(g20.gross + g55.gross), 15.55, "= orders.total");
    assert.equal(g20.net, round2(3.33 + 0.8), "HT combiné inchangé (part livraison lue telle quelle)");
    assert.equal(g55.net, round2(8.1 + 1.93));
  }
  // Vue B : TVA produit canonique, jamais recalculée depuis les lignes.
  assert.equal(p.productRates.find((r) => r.rate === 20)!.tax, 0.67);
  assert.equal(p.productRates.find((r) => r.rate === 5.5)!.tax, 0.45);
});

test("10/11 — livraison : montant TTC persisté inchangé, TVA livraison jamais affichée deux fois", () => {
  const o = order();
  const before = JSON.parse(JSON.stringify(o.order_delivery_tax_allocations));
  const f = computeOrderFiscalSummary(o);
  const p = f.commercialPresentation!;
  const html = receipt(o);

  assert.deepEqual(o.order_delivery_tax_allocations, before, "ventilation persistée jamais mutée");
  assert.equal(p.deliveryGrossTtc, 1, "livraison affichée en TTC, telle que persistée");
  assert.equal((html.match(/Frais de livraison TTC/g) ?? []).length, 1);

  // Anti-double-comptage : la TVA combinée (produit + livraison) ne doit
  // jamais apparaître comme ligne de TVA du ticket.
  assert.equal(f.mode, "mixed-rate");
  if (f.mode === "mixed-rate") {
    const combined = f.rates.find((r) => r.rate === 20)!;
    assert.equal(combined.tax, round2(0.67 + 0.17), "0,84 € : produit + livraison, vue interne");
    assert.ok(
      !html.includes(`<span>TVA produits 20%</span><span>${money(0.84)}</span>`),
      "la TVA combinée ne doit jamais être imprimée alors que la livraison est déjà TTC"
    );
  }
  assert.ok(html.includes(`<span>TVA produits 20%</span><span>${money(0.67)}</span>`), "TVA produit seule");
});

test("12 — le Total TTC imprimé reste EXACTEMENT orders.total", () => {
  for (const o of [
    order(),
    order({ subtotal: 4.25, total: 5.25, order_items: [item("A", 2, 10), item("B", 2.25, 10)] as never, order_delivery_tax_allocations: [allocation(10, 1, 0.91, 0.09)] as never }),
  ]) {
    const p = presentationOf(o);
    assert.equal(p.finalGrossTtc, Number(o.total));
    assert.ok(receipt(o).includes(money(Number(o.total))));
  }
});

// --------------------------------------------------------------
// 13/14. Instantanés historiques uniquement
// --------------------------------------------------------------
test("13 — la répartition n'utilise QUE les instantanés de la commande (taux par ligne, gross par ligne)", () => {
  const base = order();
  const laterMerchantRateChanged = order({ tax_settings_snapshot_default_tax_rate: 99 });

  assert.deepEqual(
    presentationOf(laterMerchantRateChanged).productLines,
    presentationOf(base).productLines,
    "un taux marchand modifié après coup ne change AUCUN montant de ligne"
  );
  assert.ok(!receipt(laterMerchantRateChanged).includes("99%"), "aucun taux courant n'atteint un ticket historique");

  // Une ligne sans taux instantané rend toute répartition par ligne
  // impossible : la commande retombe sur la synthèse à taux unique et
  // AUCUNE valeur de ligne n'est fabriquée.
  const missingRate = order({ order_items: [item("A", 2, 20), item("B", 2, null)] as never });
  const pMissing = computeOrderFiscalSummary(missingRate).commercialPresentation;
  assert.ok(pMissing, "synthèse encore disponible via l'instantané marchand");
  assert.deepEqual(pMissing!.productLines, [], "aucune ligne HT fabriquée sans taux instantané");
  assert.ok(!receipt(missingRate).includes(" HT</div>"), "aucune ligne imprimée en HT");
});

test("14 — aucune dépendance au catalogue courant : le module fiscal ne lit que la commande", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "order-fiscal-summary.ts"), "utf8");
  const imports = [...src.matchAll(/^import[^;]+from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/lib/dashboard-types"], "un seul import : le type de la commande");
  // Commentaires retirés : seules les INSTRUCTIONS sont inspectées (les
  // commentaires citent légitimement menu_items/receipt_settings pour
  // expliquer ce qui n'est justement PAS lu).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  assert.ok(!/menu_items|catalogue|supabase|receipt_settings/.test(code), "aucune lecture de catalogue ni de réglage courant");
  assert.ok(!/Math\.random|Date\.now|new Date\(/.test(code), "aucune source non déterministe");
});

// --------------------------------------------------------------
// 8 (mandat §8). PREUVE NÉGATIVE : l'arrondi naïf par ligne échoue
// --------------------------------------------------------------
test("§8 — PREUVE NÉGATIVE : l'arrondi indépendant par ligne casse la réconciliation, la répartition OPTION D la rétablit", () => {
  const fixtures = [
    { gross: 2, rate: 20, canonical: 3.33, naive: 3.34 },
    { gross: 2, rate: 5.5, canonical: 3.79, naive: 3.8 },
  ];

  for (const fx of fixtures) {
    const naiveSum = round2(naiveLineNet(fx.gross, fx.rate) * 2);
    assert.equal(naiveSum, fx.naive, "somme de l'arrondi naïf");
    assert.notEqual(
      naiveSum,
      fx.canonical,
      `arrondi naïf ${naiveSum} != HT canonique ${fx.canonical} -- c'est précisément le défaut à interdire`
    );

    const o = order({
      subtotal: round2(fx.gross * 2),
      total: round2(fx.gross * 2 + 1),
      order_items: [item("A", fx.gross, fx.rate), item("B", fx.gross, fx.rate)] as never,
      order_delivery_tax_allocations: [allocation(fx.rate, 1, round2(1 / (1 + fx.rate / 100)), round2(1 - 1 / (1 + fx.rate / 100)))] as never,
    });
    const p = presentationOf(o);
    const displayed = p.productLines.map((l) => l.net);

    assert.equal(round2(displayed[0] + displayed[1]), fx.canonical, "la répartition rétablit le HT canonique");
    assert.notDeepEqual(
      displayed,
      [naiveLineNet(fx.gross, fx.rate), naiveLineNet(fx.gross, fx.rate)],
      "les deux lignes ne peuvent pas porter toutes deux la valeur naïve"
    );

    // Le ticket ne doit contenir AUCUNE trace de la somme naïve.
    const html = receipt(o);
    assert.ok(
      !html.includes(`${money(fx.naive)}`),
      `la somme naïve ${money(fx.naive)} ne doit jamais être imprimée`
    );
    assert.ok(html.includes(`${money(fx.canonical)}`), "le sous-total HT canonique est imprimé");
  }
});

// --------------------------------------------------------------
// Non-régression : les commandes SANS livraison payante et les
// commandes historiques gardent EXACTEMENT leur ticket d'avant.
// --------------------------------------------------------------
test("non-régression — sans livraison payante, les lignes gardent le montant facturé et le rendu historique", () => {
  const pickup = order({
    service_mode: "pickup",
    delivery_address: null,
    subtotal: 4,
    total: 4,
    order_delivery_tax_allocations: [] as never,
  });
  assert.equal(computeOrderFiscalSummary(pickup).commercialPresentation, null);
  const html = receipt(pickup);
  assert.ok(html.includes(money(2)) && !html.includes(`${money(1.67)} HT`), "lignes au montant facturé");
  assert.ok(html.includes("Total HT"), "rendu fiscal historique conservé");
});

test("non-régression — commande historique SANS taux par ligne : aucune ligne HT fabriquée", () => {
  const legacy = order({
    subtotal: 20,
    total: 23,
    order_items: [item("A", 20, null)] as never,
    order_delivery_tax_allocations: [] as never,
  });
  const p = computeOrderFiscalSummary(legacy).commercialPresentation!;
  assert.deepEqual(p.productLines, [], "aucune répartition sans taux instantané par ligne");
  const html = receipt(legacy);
  assert.ok(html.includes(money(20)), "la ligne garde le montant réellement facturé");
  assert.ok(!html.includes(" HT</div>"), "aucun suffixe HT sur une ligne non répartie");
  assert.ok(html.includes("TVA produits 20%"), "la présentation de synthèse reste disponible");
});
