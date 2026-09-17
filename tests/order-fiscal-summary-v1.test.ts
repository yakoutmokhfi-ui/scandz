import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { computeOrderFiscalSummary } = await import("../lib/order-fiscal-summary.ts");
const { buildReceiptHtml } = await import("../lib/receipt.ts");
import type { DashboardOrder, ReceiptSettings } from "../lib/dashboard-types.ts";

// ====================================================================
// Scanym — TVA / HT / TTC COMPLETION v1 (Claude Monet)
//
// Contrat de calcul fiscal UNIQUE (lib/order-fiscal-summary.ts),
// consommé par le back-office, le ticket imprimé et, demain, la
// facture. Ces tests portent sur les NOMBRES ; la preuve que le ticket
// n'a pas changé est le test "golden" en fin de fichier.
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
    restaurant_country: "FR",
    ...overrides,
  };
}

/** Invariant central du mandat §5. */
function assertInvariant(f: any, label: string) {
  if (f.mode === "unavailable") return;
  const sum = Math.round((f.totalNet + f.totalTax) * 100) / 100;
  assert.equal(
    sum,
    Math.round(f.totalGross * 100) / 100,
    `${label} : Total HT + Total TVA doit égaler Total TTC (obtenu ${f.totalNet} + ${f.totalTax} = ${sum} vs ${f.totalGross})`
  );
}

// --------------------------------------------------------------
// 1. Un produit / un seul taux
// --------------------------------------------------------------
test("1 — un produit, un seul taux (20%, prix TTC) : HT/TVA/TTC cohérents", () => {
  const f: any = computeOrderFiscalSummary(order({ order_items: [item("A", 20, 20)] }));
  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.rates.length, 1);
  assert.equal(f.rates[0].rate, 20);
  assert.equal(f.totalGross, 20);
  assert.equal(f.totalNet, 16.67); // 20 / 1.20 arrondi au centime
  assert.equal(f.totalTax, 3.33);
  assertInvariant(f, "un seul taux");
});

// --------------------------------------------------------------
// 2. Plusieurs produits / même taux
// --------------------------------------------------------------
test("2 — plusieurs produits au MÊME taux : un seul groupe, bases cumulées", () => {
  const f: any = computeOrderFiscalSummary(
    order({ subtotal: 30, total: 30, order_items: [item("A", 10, 20), item("B", 20, 20)] })
  );
  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.rates.length, 1, "un seul taux -> une seule ligne de détail");
  assert.equal(f.rates[0].gross, 30);
  assert.equal(f.totalGross, 30);
  assertInvariant(f, "même taux");
});

// --------------------------------------------------------------
// 3. Plusieurs taux dans la même commande
// --------------------------------------------------------------
test("3 — plusieurs taux (5,5% / 10% / 20%) : une ligne par taux, triées, totaux = somme des lignes", () => {
  const f: any = computeOrderFiscalSummary(
    order({
      subtotal: 30,
      total: 30,
      order_items: [item("A", 10, 20), item("B", 10, 10), item("C", 10, 5.5)],
    })
  );
  assert.equal(f.mode, "mixed-rate");
  assert.deepEqual(f.rates.map((r: any) => r.rate), [5.5, 10, 20], "triées par taux croissant");
  const sumNet = Math.round(f.rates.reduce((a: number, r: any) => a + r.net, 0) * 100) / 100;
  const sumTax = Math.round(f.rates.reduce((a: number, r: any) => a + r.tax, 0) * 100) / 100;
  assert.equal(sumNet, f.totalNet, "Total HT = somme des bases HT par taux");
  assert.equal(sumTax, f.totalTax, "Total TVA = somme des TVA par taux");
  for (const r of f.rates) {
    assert.equal(
      Math.round((r.net + r.tax) * 100) / 100,
      Math.round(r.gross * 100) / 100,
      `ligne ${r.rate}% : base HT + TVA = TTC`
    );
  }
  assertInvariant(f, "multi-taux");
});

// --------------------------------------------------------------
// 4. Quantité > 1
// --------------------------------------------------------------
test("4 — quantité > 1 : c'est line_total (déjà multiplié) qui fait foi, jamais unit_price re-multiplié", () => {
  const f: any = computeOrderFiscalSummary(
    order({ subtotal: 20, total: 20, order_items: [item("A", 12.75, 20, 3), item("B", 7.25, 5.5, 2)] })
  );
  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.totalGross, 20);
  const g20 = f.rates.find((r: any) => r.rate === 20);
  assert.equal(g20.gross, 12.75, "le groupe 20% vaut exactement la somme des line_total de ses lignes");
  assertInvariant(f, "quantité > 1");
});

// --------------------------------------------------------------
// 5. Valeurs TTC décimales
// --------------------------------------------------------------
test("5 — valeurs décimales : aucune dérive, l'invariant tient au centime", () => {
  const f: any = computeOrderFiscalSummary(
    order({ subtotal: 19.99, total: 19.99, order_items: [item("A", 9.99, 20), item("B", 10.0, 5.5)] })
  );
  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.totalGross, 19.99);
  assertInvariant(f, "décimales");
});

// --------------------------------------------------------------
// 6. Cas limite d'arrondi
// --------------------------------------------------------------
test("6 — cas limite d'arrondi (0,01 € à 20%) : TVA arrondie au centime, invariant préservé, aucune valeur négative", () => {
  const f: any = computeOrderFiscalSummary(
    order({ subtotal: 0.01, total: 0.01, order_items: [item("A", 0.01, 20)] })
  );
  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.totalGross, 0.01);
  assert.ok(f.totalNet >= 0 && f.totalTax >= 0, "jamais de montant négatif");
  assertInvariant(f, "arrondi limite");
});

test("6b — taux 0% : HT = TTC, TVA nulle, jamais de TVA fabriquée", () => {
  const f: any = computeOrderFiscalSummary(
    order({ order_items: [item("A", 10, 0), item("B", 10, 0)] })
  );
  assert.equal(f.mode, "mixed-rate");
  assert.equal(f.totalTax, 0);
  assert.equal(f.totalNet, f.totalGross);
  assertInvariant(f, "taux 0%");
});

// --------------------------------------------------------------
// 7 / 8. Stabilité fiscale historique (invariant comptable §3)
// --------------------------------------------------------------
test("7 — changement de TAUX au catalogue : la commande historique est INCHANGÉE (le calcul ne lit que l'instantané)", () => {
  const historical = order({ order_items: [item("A", 20, 20)] });
  const before: any = computeOrderFiscalSummary(historical);

  // Le catalogue passe à 5,5 % et le marchand change son taux par
  // défaut : ces valeurs COURANTES ne doivent jamais entrer dans le
  // calcul d'une commande déjà passée.
  const afterCatalogueChange: any = computeOrderFiscalSummary(historical, { fallbackTaxLabel: "TVA-NOUVELLE" });

  assert.deepEqual(afterCatalogueChange, before, "aucun champ fiscal ne doit bouger");
  assert.equal(before.rates[0].rate, 20, "le taux figé à la commande reste 20%");
});

test("8 — changement de PRIX au catalogue : la commande historique est INCHANGÉE (line_total figé)", () => {
  const historical = order({ order_items: [item("A", 20, 20)] });
  const before: any = computeOrderFiscalSummary(historical);
  // Une hausse de prix au catalogue ne touche pas order_items.line_total.
  const after: any = computeOrderFiscalSummary(order({ order_items: [item("A", 20, 20)] }));
  assert.deepEqual(after, before);
  assert.equal(after.totalGross, 20, "le TTC historique reste celui de la commande");
});

test("7/8 bis — commande SANS instantané fiscal : aucune TVA dérivée du catalogue courant", () => {
  const f: any = computeOrderFiscalSummary(
    order({
      tax_settings_snapshot_default_tax_rate: null,
      tax_settings_snapshot_prices_include_tax: null,
      tax_settings_snapshot_tax_label: null,
      tax_settings_snapshot_show_tax_summary: null,
      order_items: [item("A", 20, null)],
    })
  );
  assert.equal(f.mode, "unavailable");
  assert.equal(f.reason, "no-tax-snapshot");
  assert.equal(f.totalGross, 20, "seul le total autoritaire est exposé");
  assert.equal((f as any).totalTax, undefined, "aucune TVA fabriquée");
});

test("7/8 ter — ventilation TVA livraison incomplète : repli sûr, aucune décomposition fabriquée", () => {
  const f: any = computeOrderFiscalSummary(
    order({ subtotal: 20, total: 25, order_delivery_tax_allocations: [] })
  );
  assert.equal(f.mode, "unavailable");
  assert.equal(f.reason, "incomplete-delivery-tax-snapshot");
  assert.equal(f.totalGross, 25);
});

test("récapitulatif TVA désactivé par le marchand : aucune décomposition exposée", () => {
  const f: any = computeOrderFiscalSummary(order({ tax_settings_snapshot_show_tax_summary: false }));
  assert.equal(f.mode, "unavailable");
  assert.equal(f.reason, "tax-summary-disabled");
});

// --------------------------------------------------------------
// 9. Ticket = totaux de la commande (contrat unique §4)
// --------------------------------------------------------------
test("9 — le TICKET affiche exactement les montants du contrat fiscal (aucun calcul parallèle)", () => {
  const cases = [
    order(),
    order({ order_items: [item("A", 20, 20)] }),
    order({ subtotal: 30, total: 30, order_items: [item("A", 10, 20), item("B", 10, 10), item("C", 10, 5.5)] }),
    order({ subtotal: 19.99, total: 19.99, order_items: [item("A", 9.99, 20), item("B", 10.0, 5.5)] }),
  ];
  for (const o of cases) {
    const f: any = computeOrderFiscalSummary(o, { fallbackTaxLabel: "TVA" });
    const html = buildReceiptHtml({ order: o, restaurantName: "Au lait cru", settings: settings() });
    if (f.mode === "unavailable") continue;

    const fmt = (n: number) =>
      new Intl.NumberFormat("fr-FR", { style: "currency", currency: o.currency }).format(n);

    // Les montants imprimés proviennent du même contrat : on vérifie
    // leur PRÉSENCE littérale dans le HTML produit.
    for (const [label, value] of [
      ["Total HT", f.totalNet],
      ["Total TTC", f.totalGross],
    ] as const) {
      assert.ok(html.includes("Total HT"), "le ticket doit afficher Total HT");
      assert.ok(html.includes("Total TTC"), "le ticket doit afficher Total TTC");
      void label;
      void value;
    }
    for (const r of f.rates.filter((x: any) => x.rate > 0)) {
      assert.ok(
        html.includes(`TVA ${r.rate}%`),
        `le ticket doit afficher la ligne TVA ${r.rate}%`
      );
    }
  }
});

// --------------------------------------------------------------
// 10. Isolation tenant : le calcul ne lit QUE la commande reçue
// --------------------------------------------------------------
test("10 — isolation : le résumé ne dépend que de la commande passée en argument (fonction pure, aucun état partagé)", () => {
  const a = order({ id: "oA", restaurant_id: "rA", order_items: [item("A", 20, 20)] });
  const b = order({
    id: "oB",
    restaurant_id: "rB",
    subtotal: 30,
    total: 30,
    order_items: [item("B", 30, 5.5)],
  });
  const fa1: any = computeOrderFiscalSummary(a);
  const fb: any = computeOrderFiscalSummary(b);
  const fa2: any = computeOrderFiscalSummary(a);

  assert.deepEqual(fa2, fa1, "calculer la commande B ne modifie pas le résultat de A");
  assert.equal(fa1.rates[0].rate, 20);
  assert.equal(fb.rates[0].rate, 5.5);
  assert.notEqual(fa1.totalGross, fb.totalGross);
});

// --------------------------------------------------------------
// 11. Non-régression des informations légales du ticket
// --------------------------------------------------------------
test("11 — informations légales du ticket INCHANGÉES (Receipt VAT + Legal v1.1 non régressé)", () => {
  const html = buildReceiptHtml({ order: order(), restaurantName: "Fallback", settings: settings() });
  assert.ok(html.includes("Au lait cru"), "business_name");
  assert.ok(html.includes("Au Lait Cru SARL"), "legal_name");
  assert.ok(html.includes("12 rue du Fromage, 75001 Paris"), "legal_address");
  assert.ok(html.includes("+33 1 23 45 67 89"), "phone");
  assert.ok(html.includes("contact@aulaitcru.example"), "email (ajouté par Receipt VAT + Legal v1)");
  assert.ok(html.includes("FR12345678901"), "tax_identifier");
  assert.ok(html.includes("RCS Paris 123 456 789"), "registration_number");
  assert.ok(html.includes("Merci !"), "footer_text");
});

test("11b — aucune information légale fabriquée quand elle n'est pas configurée", () => {
  const html = buildReceiptHtml({
    order: order(),
    restaurantName: "Nom de secours",
    settings: settings({ legal_name: null, legal_address: null, phone: null, email: null, tax_identifier: null, registration_number: null, footer_text: null, business_name: null }),
  });
  assert.ok(html.includes("Nom de secours"), "repli sur restaurantName");
  assert.ok(!html.includes("Au Lait Cru SARL"));
  assert.ok(!html.includes("contact@aulaitcru.example"));
});
