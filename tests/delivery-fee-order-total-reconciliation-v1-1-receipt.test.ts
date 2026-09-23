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
// Scanym — DELIVERY FEE / ORDER TOTAL RECONCILIATION v1.1 (Claude Monet)
// PRÉSENTATION COMMERCIALE DU TICKET IMPRIMÉ — décision produit CIO.
//
// INVARIANT AFFICHÉ, cent pour cent :
//
//     PRODUITS HT
//   + TVA PRODUITS (par taux réellement présent dans l'instantané)
//   + LIVRAISON TTC
//   = TOTAL TTC
//
// Le frais de livraison est un montant CLIENT TTC : sa TVA est déjà
// DEDANS. Les lignes de TVA affichées au-dessus ne portent donc QUE la
// part produit -- sinon la TVA livraison serait comptée deux fois à
// l'œil. La ventilation TVA livraison persistée
// (order_delivery_tax_allocations) reste l'autorité interne, INTACTE.
//
// Aucun taux n'est codé en dur : 5,5 % et 20 % ne sont que des
// exemples de fixtures, tous les taux viennent des instantanés.
//
// PÉRIMÈTRE : cette présentation ne concerne QUE les commandes à
// livraison PAYANTE -- le seul cas où la question du double comptage
// se pose. Sans frais de livraison, le ticket garde EXACTEMENT son
// rendu d'avant (Total HT / TVA {taux}% / Total TTC), ce que les
// tests ci-dessous vérifient aussi.
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
    subtotal: 22.55,
    total: 30.05,
    currency: "EUR",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    order_items: [item("A", 10.55, 5.5), item("B", 12, 20)],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [
      allocation(5.5, 3.51, 3.33, 0.18),
      allocation(20, 3.99, 3.33, 0.66),
    ],
    ...overrides,
  } as DashboardOrder;
}

function settings(overrides: Partial<ReceiptSettings> = {}): ReceiptSettings {
  return {
    restaurant_id: "r1",
    business_name: "Au lait cru",
    legal_name: "Au Lait Cru SARL",
    legal_address: "12 rue du Fromage, 75001 Paris",
    phone: "+33 1 23 45 67 89",
    email: "contact@aulaitcru.example",
    tax_identifier: "FR12345678901",
    registration_number: "RCS Paris 123 456 789",
    paper_width_mm: 58,
    show_tax_summary: true,
    prices_include_tax: true,
    tax_label: "TVA",
    default_tax_rate: 20,
    footer_text: "Merci !",
    ...overrides,
  } as ReceiptSettings;
}

const money = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
const receipt = (o: DashboardOrder, s: ReceiptSettings | null = settings()) =>
  buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: s });
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// --------------------------------------------------------------
// 8. FIXTURE CIO EXACTE
// --------------------------------------------------------------
test("8 — fixture CIO : 10,55 @5,5% + 12,00 @20% + livraison 7,50 TTC = 30,05 TTC", () => {
  const f = computeOrderFiscalSummary(order());
  const p = f.commercialPresentation;
  assert.ok(p, "la présentation commerciale doit exister sur un instantané complet");

  assert.equal(p!.productNet, 20, "produits HT");
  assert.equal(p!.productTax, 2.55, "TVA produits (0,55 + 2,00)");
  assert.equal(p!.productGross, 22.55, "TTC produits = orders.subtotal");
  assert.equal(p!.deliveryGrossTtc, 7.5, "livraison TTC");
  assert.equal(p!.finalGrossTtc, 30.05, "total TTC autoritaire");
  assert.deepEqual(
    p!.productRates.map((r) => [r.rate, r.net, r.tax]),
    [
      [5.5, 10, 0.55],
      [20, 10, 2],
    ],
    "une ligne par taux produit, part PRODUIT seule"
  );

  const html = receipt(order());
  for (const value of [money(20), money(0.55), money(2), money(7.5), money(30.05)]) {
    assert.ok(html.includes(value), `le ticket doit afficher ${value}`);
  }
});

// --------------------------------------------------------------
// 7. RÉCONCILIATION EXACTE
// --------------------------------------------------------------
test("7 — produits HT + TVA produits + livraison TTC = total TTC, au centime", () => {
  const fixtures: DashboardOrder[] = [
    order(),
    order({
      subtotal: 39.6,
      total: 47.1,
      order_items: [item("A", 9.8, 10), item("B", 13.6, 10), item("C", 10.4, 10), item("D", 5.8, 10)],
      order_delivery_tax_allocations: [allocation(10, 7.5, 6.82, 0.68)] as never,
    }),
    order({
      subtotal: 19.99,
      total: 21.99,
      order_items: [item("A", 9.99, 20), item("B", 10, 5.5)],
      order_delivery_tax_allocations: [
        allocation(5.5, 1, 0.95, 0.05),
        allocation(20, 1, 0.83, 0.17),
      ] as never,
    }),
  ];
  for (const o of fixtures) {
    const p = computeOrderFiscalSummary(o).commercialPresentation;
    assert.ok(p, "présentation attendue");
    assert.equal(
      round2(p!.productNet + p!.productTax + p!.deliveryGrossTtc),
      p!.finalGrossTtc,
      "l'addition visible doit retomber exactement sur le total autoritaire"
    );
    assert.equal(p!.finalGrossTtc, Number(o.total), "le total affiché reste orders.total");
  }
});

// --------------------------------------------------------------
// 1, 2, 3, 13, 14, 15, 12. Dérivation HT par taux réel
// --------------------------------------------------------------
test("1/13 — produit TTC à 5,5% seul : HT et TVA dérivés de l'instantané", () => {
  const o = order({
    subtotal: 10.55,
    total: 12.55,
    order_items: [item("A", 10.55, 5.5)],
    order_delivery_tax_allocations: [allocation(5.5, 2, 1.9, 0.1)] as never,
  });
  const p = computeOrderFiscalSummary(o).commercialPresentation!;
  assert.deepEqual(p.productRates, [{ rate: 5.5, net: 10, tax: 0.55, gross: 10.55 }]);
  assert.equal(p.deliveryGrossTtc, 2);
  assert.equal(round2(p.productNet + p.productTax + p.deliveryGrossTtc), 12.55);
});

test("2/14 — produit TTC à 20% seul : HT et TVA dérivés de l'instantané", () => {
  const o = order({
    subtotal: 12,
    total: 15,
    order_items: [item("A", 12, 20)],
    order_delivery_tax_allocations: [allocation(20, 3, 2.5, 0.5)] as never,
  });
  const p = computeOrderFiscalSummary(o).commercialPresentation!;
  assert.deepEqual(p.productRates, [{ rate: 20, net: 10, tax: 2, gross: 12 }]);
  assert.equal(round2(p.productNet + p.productTax + p.deliveryGrossTtc), 15);
});

test("3 — taux mixtes : une ligne de TVA par taux, triées, jamais un taux codé en dur", () => {
  const o = order({
    subtotal: 32.55,
    total: 35.55,
    order_items: [item("A", 10.55, 5.5), item("B", 12, 20), item("C", 10, 10)],
    order_delivery_tax_allocations: [
      allocation(5.5, 0.97, 0.92, 0.05),
      allocation(10, 0.92, 0.84, 0.08),
      allocation(20, 1.11, 0.93, 0.18),
    ] as never,
  });
  const p = computeOrderFiscalSummary(o).commercialPresentation!;
  assert.deepEqual(p.productRates.map((r) => r.rate), [5.5, 10, 20], "tous les taux de l'instantané, triés");

  const html = receipt(o);
  for (const rate of [5.5, 10, 20]) {
    assert.ok(html.includes(`TVA produits ${rate}%`), `ligne TVA produits ${rate}% attendue`);
  }
  // Aucun taux n'est écrit en dur dans le moteur de rendu.
  const receiptSrc = readFileSync(path.join(process.cwd(), "lib", "receipt.ts"), "utf8");
  assert.ok(!/\b5\.5\b|\b20\b\s*%/.test(receiptSrc.replace(/paper_width_mm[^\n]*/g, "")), "aucun taux codé en dur dans lib/receipt.ts");
});

test("12/15 — taux 0 % : base HT conservée, aucune ligne 'TVA 0 %' fabriquée (convention existante)", () => {
  const zeroOnly = order({
    subtotal: 18,
    total: 20,
    order_items: [item("A", 18, 0)],
    order_delivery_tax_allocations: [allocation(0, 2, 2, 0)] as never,
  });
  const p0 = computeOrderFiscalSummary(zeroOnly).commercialPresentation!;
  assert.deepEqual(p0.productRates, [{ rate: 0, net: 18, tax: 0, gross: 18 }]);
  const html0 = receipt(zeroOnly);
  assert.ok(html0.includes("Sous-total produits HT"), "base HT affichée");
  assert.ok(!html0.includes("TVA produits 0%"), "aucune ligne TVA 0 % explicite");
  assert.ok(html0.includes(money(18)), "HT = TTC à 0 %");
  assert.ok(html0.includes(money(20)), "total TTC = 18,00 + 2,00 de livraison");

  const mixedZero = order({
    subtotal: 30,
    total: 33,
    order_items: [item("A", 18, 0), item("B", 12, 20)],
    order_delivery_tax_allocations: [allocation(0, 1.8, 1.8, 0), allocation(20, 1.2, 1, 0.2)] as never,
  });
  const pm = computeOrderFiscalSummary(mixedZero).commercialPresentation!;
  assert.equal(pm.productNet, 28, "18,00 (0 %) + 10,00 (20 %)");
  assert.equal(pm.productTax, 2);
  const htmlM = receipt(mixedZero);
  assert.ok(htmlM.includes("TVA produits 20%") && !htmlM.includes("TVA produits 0%"));
});

// --------------------------------------------------------------
// 4, 5, 18. Livraison TTC séparée, TVA produits SANS TVA livraison
// --------------------------------------------------------------
test("4 — la livraison est affichée comme UN montant TTC, séparé des produits", () => {
  const html = receipt(order());
  assert.ok(html.includes("Frais de livraison TTC"), "libellé TTC explicite");
  assert.ok(html.includes(money(7.5)), "montant TTC persisté, affiché tel quel");
  assert.equal((html.match(/Frais de livraison TTC/g) ?? []).length, 1, "une seule ligne livraison");
});

test("5/18 — PREUVE ANTI-DOUBLE-COMPTAGE : la TVA affichée est la TVA PRODUIT, jamais produit + livraison", () => {
  const o = order();
  const f = computeOrderFiscalSummary(o);
  const p = f.commercialPresentation!;
  const html = receipt(o);

  // Vue A (fiscale complète) : TVA COMBINÉE produit + livraison.
  assert.equal(f.mode, "mixed-rate");
  if (f.mode !== "mixed-rate") return;
  const combined55 = f.rates.find((r) => r.rate === 5.5)!;
  const combined20 = f.rates.find((r) => r.rate === 20)!;
  assert.equal(combined55.tax, 0.73, "0,55 produit + 0,18 livraison (autorité interne)");
  assert.equal(combined20.tax, 2.66, "2,00 produit + 0,66 livraison (autorité interne)");

  // Vue B (ticket) : la part PRODUIT seule.
  assert.equal(p.productRates.find((r) => r.rate === 5.5)!.tax, 0.55);
  assert.equal(p.productRates.find((r) => r.rate === 20)!.tax, 2);

  // Le ticket ne doit contenir AUCUN des montants combinés en face
  // d'une ligne de TVA -- c'est exactement la régression à interdire.
  assert.ok(
    !html.includes(`${money(0.73)}`),
    "la TVA combinée 5,5 % ne doit jamais apparaître alors que la livraison est déjà TTC"
  );
  assert.ok(
    !html.includes(`${money(2.66)}`),
    "la TVA combinée 20 % ne doit jamais apparaître alors que la livraison est déjà TTC"
  );

  // Et l'addition « produits HT + TVA combinée + livraison TTC »
  // dépasserait le total : c'est précisément le double comptage.
  const doubleCounted = round2(p.productNet + combined55.tax + combined20.tax + p.deliveryGrossTtc);
  assert.notEqual(doubleCounted, p.finalGrossTtc, "le double comptage doit être arithmétiquement détectable");
  assert.equal(round2(doubleCounted - p.finalGrossTtc), 0.84, "écart = TVA livraison comptée deux fois");
});

// --------------------------------------------------------------
// 6, 16. La ventilation TVA livraison persistée reste INTACTE
// --------------------------------------------------------------
test("6/16 — la ventilation TVA livraison persistée est conservée, ni recalculée ni supprimée", () => {
  const o = order();
  const before = JSON.parse(JSON.stringify(o.order_delivery_tax_allocations));
  const f = computeOrderFiscalSummary(o);

  assert.deepEqual(o.order_delivery_tax_allocations, before, "la commande n'est jamais mutée");
  assert.equal(f.mode, "mixed-rate", "la vue fiscale complète reste disponible");
  if (f.mode === "mixed-rate") {
    // Les parts persistées sont toujours consommées TELLES QUELLES.
    assert.equal(f.rates.find((r) => r.rate === 5.5)!.gross, round2(10.55 + 3.51));
    assert.equal(f.rates.find((r) => r.rate === 20)!.gross, round2(12 + 3.99));
    assert.equal(round2(f.rates.reduce((acc, r) => acc + r.gross, 0)), 30.05);
  }

  // Garde de complétude LOT C v1.4 INCHANGÉE : une ventilation
  // incohérente supprime toujours toute décomposition.
  const broken = order({ order_delivery_tax_allocations: [allocation(5.5, 3.51, 3.33, 0.18)] as never });
  const fb = computeOrderFiscalSummary(broken);
  assert.equal(fb.mode, "unavailable");
  if (fb.mode === "unavailable") assert.equal(fb.reason, "incomplete-delivery-tax-snapshot");
  assert.equal(fb.commercialPresentation, null, "aucune présentation sur instantané incomplet");
});

// --------------------------------------------------------------
// 9, 10, 11. Aucun frais fabriqué, aucun HT/TVA fabriqué
// --------------------------------------------------------------
test("9 — retrait / table : aucune ligne de livraison sur le ticket", () => {
  for (const mode of ["pickup", "table"] as const) {
    const o = order({
      service_mode: mode,
      delivery_address: null,
      subtotal: 22.55,
      total: 22.55,
      order_delivery_tax_allocations: [] as never,
    });
    const html = receipt(o);
    assert.ok(!html.includes("Frais de livraison"), `aucune livraison affichée (${mode})`);
    // Sans frais de livraison, le ticket garde son rendu d'ORIGINE.
    assert.equal(computeOrderFiscalSummary(o).commercialPresentation, null);
    assert.ok(html.includes("Total HT"), "rendu historique conservé");
    assert.ok(!html.includes("Sous-total produits HT"), "aucune nouvelle présentation sans livraison payante");
    assert.ok(html.includes(money(22.55)), "total TTC inchangé");
  }
});

test("10 — livraison gratuite : aucune ligne 0,00 € fabriquée", () => {
  const o = order({ subtotal: 22.55, total: 22.55, order_delivery_tax_allocations: [] as never });
  assert.equal(
    computeOrderFiscalSummary(o).commercialPresentation,
    null,
    "livraison gratuite : aucune présentation livraison, rendu historique conservé"
  );
  const html = receipt(o);
  assert.ok(!html.includes("Frais de livraison"), "aucune ligne livraison pour une livraison gratuite");
  assert.ok(html.includes("Total HT"), "rendu historique conservé");
  assert.ok(html.includes(money(22.55)));
});

test("11 — instantanés fiscaux incomplets : aucun HT/TVA fabriqué, total autoritaire seul", () => {
  const noSnapshot = order({
    tax_settings_snapshot_prices_include_tax: null,
    tax_settings_snapshot_default_tax_rate: null,
    tax_settings_snapshot_tax_label: null,
    tax_settings_snapshot_show_tax_summary: null,
    order_delivery_tax_allocations: [] as never,
    subtotal: 22.55,
    total: 22.55,
  });
  const fNo = computeOrderFiscalSummary(noSnapshot);
  assert.equal(fNo.mode, "unavailable");
  assert.equal(fNo.commercialPresentation, null);
  const htmlNo = receipt(noSnapshot);
  assert.ok(!htmlNo.includes("Sous-total produits HT") && !htmlNo.includes("Total HT"));
  assert.ok(htmlNo.includes(money(22.55)), "seul le total autoritaire est imprimé");

  const summaryOff = order({
    tax_settings_snapshot_show_tax_summary: false,
    order_delivery_tax_allocations: [] as never,
    subtotal: 22.55,
    total: 22.55,
  });
  const fOff = computeOrderFiscalSummary(summaryOff);
  assert.equal(fOff.commercialPresentation, null, "récapitulatif TVA désactivé : aucune présentation");
  assert.ok(!receipt(summaryOff).includes("Sous-total produits HT"));

  // Historique LOT C : frais > 0 sans ventilation -> repli sûr, et la
  // composition v1 (sous-total TTC + frais) reste affichée.
  const historical = order({ order_delivery_tax_allocations: [] as never });
  const fHist = computeOrderFiscalSummary(historical);
  assert.equal(fHist.commercialPresentation, null);
  const htmlHist = receipt(historical);
  assert.ok(!htmlHist.includes("Sous-total produits HT"), "aucune base HT fabriquée");
  assert.ok(htmlHist.includes("Frais de livraison"), "le frais reste visible (composition v1)");
  assert.ok(htmlHist.includes(money(30.05)));
});

// --------------------------------------------------------------
// 17. Back-office : la correction v1 reste en place et non modifiée
// --------------------------------------------------------------
test("17 — back-office : la vue fiscale complète et la composition v1 restent disponibles", () => {
  const f = computeOrderFiscalSummary(order());
  assert.equal(f.productsSubtotal, 22.55, "composition v1 intacte");
  assert.equal(f.deliveryFee, 7.5);
  assert.equal(f.compositionReconcilesWithTotal, true);
  assert.equal(f.mode, "mixed-rate", "vue fiscale complète intacte");
  if (f.mode === "mixed-rate") {
    assert.equal(f.totalNet, round2(13.33 + 13.33), "Total HT combiné (produits + livraison)");
    assert.equal(f.totalGross, 30.05);
  }
});

// --------------------------------------------------------------
// LIGNES PRODUIT EN HT — DÉCISION D'ARRONDI EN ATTENTE (mandat v1.1 §7)
//
// Ce test DOCUMENTE, de façon permanente et reproductible, pourquoi
// les lignes produit du ticket affichent encore le montant réellement
// facturé (TTC) et non un HT par ligne : passer chaque ligne en HT
// crée un écart d'un centime avec la frontière d'arrondi canonique
// par TAUX (LOT C v1.3), sur des prix parfaitement ordinaires. Aucune
// répartition de résidu n'est inventée ici -- décision CIO requise.
// --------------------------------------------------------------
test("§7 — fixture d'arrondi : un HT par LIGNE diverge d'un centime du HT canonique par TAUX", () => {
  const o = order({
    subtotal: 4,
    total: 5,
    order_items: [item("A", 2, 20), item("B", 2, 20)],
    order_delivery_tax_allocations: [allocation(20, 1, 0.83, 0.17)] as never,
  });

  const perLineHt = round2(round2(2 / 1.2) + round2(2 / 1.2)); // 1,67 + 1,67
  const canonicalGroupHt = computeOrderFiscalSummary(o).commercialPresentation!.productNet;

  assert.equal(perLineHt, 3.34, "HT dérivé ligne par ligne");
  assert.equal(canonicalGroupHt, 3.33, "HT canonique dérivé du groupe de taux (LOT C v1.3)");
  assert.equal(round2(perLineHt - canonicalGroupHt), 0.01, "écart d'exactement un centime");

  // Tant que la décision n'est pas prise : les lignes produit
  // continuent d'afficher le montant réellement facturé, et le bloc
  // de totaux reste cent-parfait.
  const html = receipt(o);
  assert.ok(html.includes(money(2)), "ligne produit au montant facturé");
  assert.ok(html.includes(money(3.33)), "base HT produits canonique");
  assert.ok(!html.includes(money(3.34)), "aucune base HT fabriquée par sommation de lignes");
});

// --------------------------------------------------------------
// 20. prices_include_tax = false — sémantique réelle, PROUVÉE
// --------------------------------------------------------------
test("20a — contrat du dépôt : line_total/subtotal/total sont TOUJOURS les montants réellement facturés", () => {
  // Les marqueurs de commentaire SQL (`--`) et les retours à la ligne
  // sont neutralisés : c'est la DÉCISION qui est vérifiée, pas sa mise
  // en page.
  const sql = readFileSync(
    path.join(process.cwd(), "supabase", "DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql"),
    "utf8"
  )
    .replace(/^\s*--/gm, " ")
    .replace(/\s+/g, " ");
  assert.ok(
    sql.includes("`prices_include_tax` est un réglage de PRÉSENTATION DU TICKET uniquement"),
    "décision CIO/CTO déjà actée : réglage de présentation seulement"
  );
  assert.ok(
    sql.includes("`order_items.line_total` reste TOUJOURS le montant TTC réellement facturé"),
    "le montant facturé ne dépend pas de ce réglage"
  );
});

test("20b — marchand HT : le total facturé reste orders.total ; le ticket n'invente PAS de présentation", () => {
  const o = order({
    tax_settings_snapshot_prices_include_tax: false,
    order_delivery_tax_allocations: [] as never,
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.commercialPresentation, null, "aucune présentation commerciale dans ce mode");
  assert.equal(f.productsSubtotal, 22.55, "sous-total = montant réellement facturé");
  assert.equal(f.deliveryFee, 7.5);
  assert.equal(f.compositionReconcilesWithTotal, false, "abstention v1 conservée");
  // CONSTAT PRÉEXISTANT (hors périmètre v1.1, voir rapport) : la
  // branche plate ajoute la TVA PAR-DESSUS orders.total et affiche donc
  // un « Total TTC » supérieur au montant réellement facturé/encaissé.
  assert.equal(f.mode, "flat-rate");
  if (f.mode === "flat-rate") {
    assert.equal(f.totalGross, 36.06, "30,05 + 20% -- surévalué par rapport au montant facturé");
  }
  assert.equal(Number(o.total), 30.05, "le montant autoritaire, lui, reste 30,05");
});

test("20c — le paiement encaisse le total autoritaire, quel que soit prices_include_tax", () => {
  const payment = readFileSync(
    path.join(process.cwd(), "supabase", "DRAFT-lot-payment-p1-foundation.sql"),
    "utf8"
  ).replace(/\s+/g, " ");
  assert.ok(
    payment.includes("return query select v_transaction_id, v_order.total, v_order.currency::text"),
    "initiate_payment_attempt encaisse orders.total"
  );
  assert.ok(
    !/prices_include_tax/.test(payment),
    "le chemin de paiement ne lit JAMAIS ce réglage d'affichage"
  );
});
