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
// Scanym — DELIVERY FEE / ORDER TOTAL RECONCILIATION v1 (Claude Monet)
//
// INVARIANT AUTORITAIRE couvert par ce fichier :
//
//     SOUS-TOTAL PRODUITS + FRAIS DE LIVRAISON CLIENT
//         = TOTAL AUTORITAIRE DE LA COMMANDE
//
// Cet invariant est DÉJÀ garanti en base (contrainte CHECK
// `orders_total_equals_subtotal_plus_delivery_fee`, et `create_order`
// qui écrit `total = subtotal + delivery_fee`). Le défaut constaté par
// le marchand était un défaut d'AFFICHAGE : le frais de livraison,
// pourtant inclus dans le total, n'était itemisé NULLE PART dans le
// back-office ni sur le ticket -- la somme des lignes produit ne
// correspondait donc pas au montant final affiché.
//
// Aucun montant n'est recalculé ici depuis le catalogue ou la
// tarification COURANTE : tout provient des instantanés persistés de la
// commande (mandat §9 -- sécurité monétaire historique).
// ====================================================================

function item(
  id: string,
  line_total: number,
  tax_rate_snapshot: number | null,
  quantity = 1
) {
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

function order(overrides: Partial<DashboardOrder> = {}): DashboardOrder {
  return {
    id: "o1",
    restaurant_id: "r1",
    order_number: 1,
    status: "completed",
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    order_items: [item("A", 10, 20), item("B", 10, 5.5)],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [],
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

/** Ventilation TVA livraison à taux UNIQUE, cohérente par construction. */
function allocation(rate: number, gross: number, net: number, tax: number) {
  return {
    tax_rate_snapshot: rate,
    delivery_fee_gross_share: gross,
    delivery_fee_net_share: net,
    delivery_fee_tax_amount: tax,
  };
}

/**
 * Commande de LIVRAISON avec frais client réel, telle que `create_order`
 * la persiste : `subtotal` = produits SEULS, `total` = subtotal + frais.
 */
function deliveryOrder(params: {
  items: { label: string; gross: number; rate: number | null }[];
  fee: number;
  allocations: ReturnType<typeof allocation>[];
  overrides?: Partial<DashboardOrder>;
}): DashboardOrder {
  const subtotal = Number(
    params.items.reduce((acc, i) => acc + i.gross, 0).toFixed(2)
  );
  return order({
    service_mode: "delivery",
    delivery_address: "1 rue de la Livraison",
    subtotal,
    total: Number((subtotal + params.fee).toFixed(2)),
    order_items: params.items.map((i, index) => item(i.label, i.gross, i.rate, 1)) as never,
    order_delivery_tax_allocations: params.allocations as never,
    ...params.overrides,
  });
}

const money = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);

// --------------------------------------------------------------
// 1. Invariant central : produits + livraison = total autoritaire
// --------------------------------------------------------------
test("1 — livraison avec frais : sous-total produits + frais = total autoritaire persisté", () => {
  const o = deliveryOrder({
    items: [
      { label: "A", gross: 24, rate: 10 },
      { label: "B", gross: 6, rate: 10 },
    ],
    fee: 4.5,
    allocations: [allocation(10, 4.5, 4.09, 0.41)],
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.productsSubtotal, 30, "sous-total produits = orders.subtotal persisté");
  assert.equal(f.deliveryFee, 4.5, "frais de livraison dérivé des instantanés persistés");
  assert.equal(f.totalGross, 34.5, "total autoritaire inchangé");
  assert.equal(
    Number((f.productsSubtotal + f.deliveryFee).toFixed(2)),
    Number(o.total),
    "INVARIANT : produits + livraison = orders.total"
  );
  assert.equal(f.compositionReconcilesWithTotal, true);
});

// --------------------------------------------------------------
// 2 & 3. Fixtures équivalentes aux captures marchand (SC-42, SC-40)
//
// Les montants proviennent de l'ARITHMÉTIQUE des captures d'écran
// (somme des lignes produit vs total affiché) -- ce ne sont PAS des
// valeurs de production relues quelque part, et rien ici ne prétend le
// contraire (mandat §6).
// --------------------------------------------------------------
test("2 — fixture type SC-42 : 39,60 + 7,50 = 47,10 et le frais est itemisé", () => {
  const o = deliveryOrder({
    items: [
      { label: "A", gross: 9.8, rate: 10 },
      { label: "B", gross: 13.6, rate: 10 },
      { label: "C", gross: 10.4, rate: 10 },
      { label: "D", gross: 5.8, rate: 10 },
    ],
    fee: 7.5,
    allocations: [allocation(10, 7.5, 6.82, 0.68)],
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.productsSubtotal, 39.6);
  assert.equal(f.deliveryFee, 7.5);
  assert.equal(f.totalGross, 47.1);
  assert.equal(f.mode, "mixed-rate", "instantané complet : décomposition TVA disponible");

  // v1.1 : le ticket présente désormais la base HT produits, la TVA
  // produits par taux, puis la livraison TTC (voir le fichier de tests
  // v1.1). Le frais et le total autoritaire y restent visibles.
  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
  assert.ok(html.includes(money(36)), "le ticket montre la base HT produits (39,60 TTC à 10%)");
  assert.ok(html.includes(money(7.5)), "le ticket montre le frais de livraison TTC");
  assert.ok(html.includes(money(47.1)), "le ticket montre le total autoritaire");
});

test("3 — fixture type SC-40 : 44,80 + 12,00 = 56,80 et le frais est itemisé", () => {
  const o = deliveryOrder({
    items: [
      { label: "A", gross: 5.4, rate: 10 },
      { label: "B", gross: 8.6, rate: 10 },
      { label: "C", gross: 9.8, rate: 10 },
      { label: "D", gross: 6.6, rate: 10 },
      { label: "E", gross: 8.6, rate: 10 },
      { label: "F", gross: 5.8, rate: 10 },
    ],
    fee: 12,
    allocations: [allocation(10, 12, 10.91, 1.09)],
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.productsSubtotal, 44.8);
  assert.equal(f.deliveryFee, 12);
  assert.equal(f.totalGross, 56.8);

  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
  assert.ok(html.includes(money(40.73)), "base HT produits (44,80 TTC à 10%)");
  assert.ok(html.includes(money(12)) && html.includes(money(56.8)));
});

// --------------------------------------------------------------
// 4, 5, 6. Aucun frais fabriqué : retrait, table, livraison gratuite
// --------------------------------------------------------------
test("4 — retrait : aucun frais de livraison, aucune ligne de composition", () => {
  const f = computeOrderFiscalSummary(order({ service_mode: "pickup", subtotal: 20, total: 20 }));
  assert.equal(f.deliveryFee, 0, "aucun frais fabriqué pour un retrait");
  assert.equal(f.productsSubtotal, 20);

  const html = buildReceiptHtml({
    order: order({ service_mode: "pickup", subtotal: 20, total: 20 }),
    restaurantName: "Au lait cru",
    settings: settings(),
  });
  assert.ok(!html.includes("Frais de livraison"), "aucune ligne de livraison sur un ticket de retrait");
});

test("5 — table : aucun frais de livraison, aucune ligne de composition", () => {
  const o = order({ service_mode: "table", table_number: 4, subtotal: 20, total: 20 });
  const f = computeOrderFiscalSummary(o);
  assert.equal(f.deliveryFee, 0);

  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
  assert.ok(!html.includes("Frais de livraison"));
});

test("6 — livraison GRATUITE : frais = 0, convention checkout conservée (aucune ligne à 0,00 €)", () => {
  const o = deliveryOrder({
    items: [{ label: "A", gross: 25, rate: 10 }],
    fee: 0,
    allocations: [],
  });
  const f = computeOrderFiscalSummary(o);
  assert.equal(f.deliveryFee, 0, "livraison gratuite = 0, jamais un frais inventé");
  assert.equal(f.totalGross, 25);
  assert.equal(f.mode, "mixed-rate", "livraison gratuite : aucune ventilation requise");

  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
  assert.ok(!html.includes("Frais de livraison"), "aucune ligne frais pour une livraison gratuite");
});

// --------------------------------------------------------------
// 7 & 8. Multi-taux et ventilation TVA du frais de livraison
// --------------------------------------------------------------
test("7 — plusieurs taux de TVA : la composition reste exacte et la TVA vient de l'instantané", () => {
  const o = deliveryOrder({
    items: [
      { label: "A", gross: 10, rate: 20 },
      { label: "B", gross: 30, rate: 5.5 },
    ],
    fee: 6,
    allocations: [allocation(20, 1.5, 1.25, 0.25), allocation(5.5, 4.5, 4.27, 0.23)],
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.productsSubtotal, 40);
  assert.equal(f.deliveryFee, 6);
  assert.equal(f.totalGross, 46);
  assert.equal(
    Number((f.productsSubtotal + f.deliveryFee).toFixed(2)),
    f.totalGross,
    "INVARIANT conservé en multi-taux"
  );
});

test("8 — ventilation TVA livraison : les parts persistées sont utilisées TELLES QUELLES", () => {
  const o = deliveryOrder({
    items: [
      { label: "A", gross: 10, rate: 20 },
      { label: "B", gross: 30, rate: 5.5 },
    ],
    fee: 6,
    allocations: [allocation(20, 1.5, 1.25, 0.25), allocation(5.5, 4.5, 4.27, 0.23)],
  });
  const f = computeOrderFiscalSummary(o);
  assert.equal(f.mode, "mixed-rate");
  if (f.mode !== "mixed-rate") return;

  const r20 = f.rates.find((r) => r.rate === 20)!;
  const r55 = f.rates.find((r) => r.rate === 5.5)!;
  // Produit 10 @20% -> net 8.33 / tva 1.67 ; + part livraison persistée.
  assert.equal(r20.gross, 11.5, "10,00 produits + 1,50 de part livraison");
  assert.equal(r20.tax, Number((1.67 + 0.25).toFixed(2)), "TVA produit + TVA livraison persistée");
  // Produit 30 @5,5% -> net 28.44 / tva 1.56 ; + part livraison persistée.
  assert.equal(r55.gross, 34.5, "30,00 produits + 4,50 de part livraison");
  assert.equal(r55.tax, Number((1.56 + 0.23).toFixed(2)));
  assert.equal(
    Number(f.rates.reduce((acc, r) => acc + r.gross, 0).toFixed(2)),
    f.totalGross,
    "la somme des TTC par taux égale le total autoritaire"
  );
});

// --------------------------------------------------------------
// 9. Commande historique à instantané incomplet : repli sûr PRÉSERVÉ
// --------------------------------------------------------------
test("9 — historique sans ventilation TVA livraison : aucune TVA fabriquée, composition TOUJOURS exacte", () => {
  const o = deliveryOrder({
    items: [{ label: "A", gross: 20, rate: 10 }],
    fee: 5,
    allocations: [], // commande antérieure à LOT C : ventilation absente
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.mode, "unavailable", "repli sûr LOT C v1.4 INCHANGÉ");
  if (f.mode === "unavailable") {
    assert.equal(f.reason, "incomplete-delivery-tax-snapshot");
  }
  assert.equal((f as { totalTax?: number }).totalTax, undefined, "aucune TVA fabriquée");
  // La COMPOSITION, elle, reste connue : elle ne dépend que de deux
  // valeurs persistées, jamais de la ventilation TVA.
  assert.equal(f.productsSubtotal, 20);
  assert.equal(f.deliveryFee, 5);
  assert.equal(f.totalGross, 25);
  assert.equal(f.compositionReconcilesWithTotal, true);
});

test("9b — marchand en prix HORS TAXES : aucune composition affichée (addition impossible à présenter)", () => {
  const o = deliveryOrder({
    items: [{ label: "A", gross: 20, rate: null }],
    fee: 5,
    allocations: [],
    overrides: {
      tax_settings_snapshot_prices_include_tax: false,
      tax_settings_snapshot_default_tax_rate: 20,
    },
  });
  const f = computeOrderFiscalSummary(o);

  assert.equal(f.mode, "flat-rate", "comportement fiscal existant inchangé");
  assert.equal(f.deliveryFee, 5, "le frais reste connu");
  assert.equal(
    f.compositionReconcilesWithTotal,
    false,
    "subtotal/total sont HT alors que le total affiché est TTC : pas d'affichage"
  );

  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
  assert.ok(!html.includes("Frais de livraison"), "aucune décomposition trompeuse imprimée");
});

// --------------------------------------------------------------
// 12, 13, 14. Ticket : cohérence, non double-comptage, non-régression
// --------------------------------------------------------------
test("12 — ticket imprimé et back-office partagent EXACTEMENT les mêmes montants (contrat unique)", () => {
  const o = deliveryOrder({
    items: [{ label: "A", gross: 39.6, rate: 10 }],
    fee: 7.5,
    allocations: [allocation(10, 7.5, 6.82, 0.68)],
  });
  const f = computeOrderFiscalSummary(o);
  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });

  assert.ok(f.commercialPresentation, "présentation commerciale disponible");
  assert.ok(html.includes(money(f.commercialPresentation!.productNet)), "base HT produits du contrat");
  assert.ok(html.includes(money(f.deliveryFee)), "frais de livraison du contrat");
  assert.ok(html.includes(money(f.totalGross)), "total autoritaire du contrat");
  assert.ok(
    html.includes("Sous-total produits HT") && html.includes("Total TTC"),
    "présentation commerciale conservée"
  );
});

test("13 — aucun double comptage : le frais n'apparaît qu'UNE fois et n'est jamais ajouté au total", () => {
  const o = deliveryOrder({
    items: [{ label: "A", gross: 30, rate: 10 }],
    fee: 4,
    allocations: [allocation(10, 4, 3.64, 0.36)],
  });
  const f = computeOrderFiscalSummary(o);
  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });

  assert.equal(f.totalGross, 34, "le total reste celui persisté, jamais subtotal + frais recalculé deux fois");
  assert.equal(
    (html.match(/Frais de livraison/g) ?? []).length,
    1,
    "une seule ligne 'Frais de livraison' sur le ticket"
  );
  assert.equal(
    (html.match(/Sous-total produits HT/g) ?? []).length,
    1,
    "une seule ligne 'Sous-total produits HT' sur le ticket"
  );
});

test("14 — aucune régression des lignes produit du ticket", () => {
  const o = deliveryOrder({
    items: [
      { label: "A", gross: 9.8, rate: 10 },
      { label: "B", gross: 13.6, rate: 10 },
    ],
    fee: 7.5,
    allocations: [allocation(10, 7.5, 6.82, 0.68)],
  });
  const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });

  assert.equal(
    (html.match(/class="item-row"/g) ?? []).length,
    2,
    "une ligne par produit, inchangé (les occurrences CSS ne sont pas comptées)"
  );
  assert.ok(html.includes("1 x Produit A") && html.includes("1 x Produit B"));
  // v1.2 (OPTION D) : les montants de ligne sont désormais affichés en
  // HT et totalisent exactement le sous-total produits HT -- la ligne
  // elle-même (quantité, libellé, présence) est inchangée.
  const p = computeOrderFiscalSummary(o).commercialPresentation!;
  assert.equal(p.productLines.length, 2);
  for (const line of p.productLines) {
    assert.ok(html.includes(`${money(line.net)} HT`), `ligne ${line.itemId} imprimée en HT`);
  }
  assert.equal(
    Number(p.productLines.reduce((acc, l) => acc + l.net, 0).toFixed(2)),
    p.productNet,
    "les lignes HT totalisent le sous-total produits HT"
  );
});

// --------------------------------------------------------------
// 15. Contrat monétaire SERVEUR : source de vérité et paiement
//
// Preuves de CODE (aucun accès Production, aucune base contactée) :
// le total est calculé et contraint côté serveur, et le montant du
// paiement est dérivé de ce même total.
// --------------------------------------------------------------
const sql = (file: string) =>
  readFileSync(path.join(process.cwd(), "supabase", file), "utf8");

test("15a — la base CONTRAINT total = subtotal + delivery_fee (invariant non contournable)", () => {
  const pricing = sql("DRAFT-lot-server-delivery-fulfillment-pricing.sql");
  assert.ok(
    pricing.includes("add constraint orders_total_equals_subtotal_plus_delivery_fee"),
    "la contrainte CHECK doit exister"
  );
  assert.ok(
    pricing.replace(/\s+/g, " ").includes("check (total = subtotal + delivery_fee)"),
    "la contrainte porte bien l'égalité attendue"
  );
  assert.ok(
    pricing.replace(/\s+/g, " ").includes("set subtotal = v_subtotal, delivery_fee = v_delivery_fee, total = v_subtotal + v_delivery_fee"),
    "create_order persiste subtotal produits seuls et un total frais INCLUS"
  );
});

test("15b — le montant du PAIEMENT est dérivé du total autoritaire de la commande, jamais du navigateur", () => {
  const payment = sql("DRAFT-lot-payment-p1-foundation.sql");
  const flat = payment.replace(/\s+/g, " ");
  assert.ok(
    flat.includes("return query select v_transaction_id, v_order.total, v_order.currency::text"),
    "initiate_payment_attempt retourne orders.total (frais de livraison inclus)"
  );
  assert.ok(
    flat.includes("Montant/devise TOUJOURS dérivés SERVEUR depuis orders.total"),
    "le contrat documenté reste explicite"
  );
  assert.ok(
    !/initiate_payment_attempt\([^)]*p_amount/.test(flat),
    "aucun montant fourni par l'appelant n'entre dans la tentative de paiement"
  );
});

test("15c — le suivi client expose le MÊME total autoritaire", () => {
  const tracking = sql("DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql").replace(/\s+/g, " ");
  assert.ok(
    tracking.includes("o.total, o.currency"),
    "la RPC de suivi lit orders.total persisté, jamais un recalcul"
  );
});
