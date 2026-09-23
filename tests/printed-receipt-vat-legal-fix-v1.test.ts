import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { buildReceiptHtml } = await import("../lib/receipt.ts");
import type { DashboardOrder, ReceiptSettings } from "../lib/dashboard-types.ts";

// ====================================================================
// Scanym — PRINTED MERCHANT RECEIPT / VAT + LEGAL INFO FIX v1 (Claude
// Monet, root cause confirmé par Cat Stevens) — preuve comportementale
// DIRECTE de buildReceiptHtml() (lib/receipt.ts), la fonction PURE qui
// produit le HTML du ticket imprimé. Aucune réimplémentation : le vrai
// module est importé et exercé tel quel, même patron que
// tests/cart-and-price.test.ts (autre consommateur pur de lib/receipt).
//
// Fixture "orders 16/17" -- reproduit les caractéristiques rapportées
// par l'investigation (show_tax_summary=true, prices_include_tax=true,
// tax label=TVA, lignes fiscales complètes aux taux 5,5% et 20%,
// livraison gratuite, receipt_settings présents) : deux produits, l'un
// à 5,5% l'autre à 20%, delivery_fee=0 (total === subtotal).
// ====================================================================

function orderItem(overrides: Partial<DashboardOrder["order_items"][number]> & { id: string }) {
  return {
    item_name: `Produit ${overrides.id}`,
    option_name: null,
    quantity: 1,
    unit_price: 10,
    line_total: 10,
    tax_rate_snapshot: null,
    ...overrides,
  };
}

function baseOrder(overrides: Partial<DashboardOrder> = {}): DashboardOrder {
  return {
    id: "o1",
    restaurant_id: "r-au-lait-cru",
    order_number: 16,
    status: "new",
    service_mode: "pickup",
    table_number: null,
    customer_name: "Client Test",
    customer_phone: "0600000000",
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
    order_items: [
      orderItem({ id: "i1", item_name: "Pain au lait", line_total: 10, tax_rate_snapshot: 5.5 }),
      orderItem({ id: "i2", item_name: "Plat chaud", line_total: 10, tax_rate_snapshot: 20 }),
    ],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [],
    ...overrides,
  } as DashboardOrder;
}

function fullSettings(overrides: Partial<ReceiptSettings> = {}): ReceiptSettings {
  return {
    restaurant_id: "r-au-lait-cru",
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
    footer_text: "Merci de votre visite !",
    restaurant_country: "FR",
    ...overrides,
  };
}

// --------------------------------------------------------------
// A. VAT ON + instantané complet (orders 16/17) -- HT / TVA par taux
//    / TTC doivent être rendus, avec les DEUX taux 5,5% et 20%.
// --------------------------------------------------------------
test("A. VAT ON + snapshots complets (fixture orders 16/17 : TTC, 5,5% + 20%, livraison gratuite) -- Total HT / lignes TVA par taux / Total TTC rendus", () => {
  const html = buildReceiptHtml({
    order: baseOrder(),
    restaurantName: "Au lait cru",
    settings: fullSettings(),
  });

  // DELIVERY FEE / ORDER TOTAL RECONCILIATION v1.1 : cette fixture est
  // une commande à LIVRAISON GRATUITE -- le ticket garde donc
  // EXACTEMENT son rendu historique (la nouvelle présentation
  // commerciale ne concerne que les commandes à livraison payante).
  assert.ok(html.includes("Total HT"), "le Total HT doit être rendu");
  assert.ok(html.includes("Total TTC"), "le Total TTC doit être rendu");
  assert.ok(/TVA 5\.5%|TVA 5,5%/.test(html), "la ligne TVA à 5,5% doit être rendue");
  assert.ok(html.includes("TVA 20%"), "la ligne TVA à 20% doit être rendue");
});

test("A (repli taux unique). VAT ON + instantané complet à taux UNIQUE (pas de rendu multi-taux nécessaire) -- HT / TVA / TTC rendus via le calcul plat existant, inchangé", () => {
  const order = baseOrder({
    order_items: [orderItem({ id: "i1", item_name: "Plat", line_total: 20, tax_rate_snapshot: 20 })],
  });
  const html = buildReceiptHtml({ order, restaurantName: "Au lait cru", settings: fullSettings() });

  assert.ok(html.includes("Total HT"));
  assert.ok(html.includes("Total TTC"));
  assert.ok(html.includes("TVA 20%"));
});

// --------------------------------------------------------------
// B. VAT OFF (tax_settings_snapshot_show_tax_summary = false) -- la
//    décomposition détaillée doit rester masquée, seul le total
//    autoritaire (order.total) est affiché.
// --------------------------------------------------------------
test("B. VAT OFF (show_tax_summary=false sur l'instantané de commande) -- décomposition HT/TVA/TTC masquée, seul le total autoritaire est affiché", () => {
  const order = baseOrder({ tax_settings_snapshot_show_tax_summary: false });
  const html = buildReceiptHtml({ order, restaurantName: "Au lait cru", settings: fullSettings() });

  assert.ok(!html.includes("Total HT"), "aucun Total HT quand show_tax_summary est désactivé sur l'instantané");
  assert.ok(!html.includes("Sous-total produits HT"), "aucune base HT produits non plus");
  assert.ok(!/TVA \d/.test(html), "aucune ligne TVA par taux");
  assert.ok(html.includes(String(20)), "le total autoritaire (20) doit tout de même apparaître quelque part");
});

// --------------------------------------------------------------
// C. Instantané fiscal historique INCOMPLET -- aucune TVA fabriquée.
//    Deux variantes couvertes : (1) commande antérieure à MERCHANT
//    LEGAL & TAX PROFILE (les 4 champs snapshot sont null) ; (2)
//    ventilation TVA livraison incomplète alors que delivery_fee > 0
//    (repli "option B" de STUART LOT C v1.4).
// --------------------------------------------------------------
test("C.1 Instantané fiscal historique ABSENT (commande antérieure au lot MLTP) -- aucune décomposition HT/TVA/TTC fabriquée, seul order.total affiché", () => {
  const order = baseOrder({
    tax_settings_snapshot_default_tax_rate: null,
    tax_settings_snapshot_prices_include_tax: null,
    tax_settings_snapshot_tax_label: null,
    tax_settings_snapshot_show_tax_summary: null,
    order_items: [orderItem({ id: "i1", item_name: "Plat", line_total: 20, tax_rate_snapshot: null })],
  });
  const html = buildReceiptHtml({ order, restaurantName: "Au lait cru", settings: fullSettings() });

  assert.ok(!html.includes("Total HT"), "aucune décomposition fabriquée pour une commande sans instantané fiscal");
  assert.ok(!html.includes("Sous-total produits HT"), "aucune base HT produits fabriquée non plus");
  assert.ok(!/TVA \d/.test(html));
});

test("C.2 Instantané fiscal complet MAIS ventilation TVA livraison incomplète (delivery_fee > 0, order_delivery_tax_allocations vide) -- repli 'option B' STUART LOT C v1.4, aucune TVA livraison fabriquée à zéro, aucun repli sur le calcul plat marchand", () => {
  const order = baseOrder({
    subtotal: 20,
    total: 25, // delivery_fee = 5, non nul
    order_delivery_tax_allocations: [], // ventilation absente malgré delivery_fee > 0
  });
  const html = buildReceiptHtml({ order, restaurantName: "Au lait cru", settings: fullSettings() });

  assert.ok(!html.includes("Total HT"), "aucune décomposition HT/TVA/TTC fabriquée quand la ventilation TVA livraison est incomplète");
  assert.ok(!html.includes("Sous-total produits HT"), "aucune base HT produits fabriquée non plus");
  assert.ok(!/TVA \d/.test(html));
  assert.ok(html.includes("25"), "le total autoritaire (25) reste affiché, jamais un montant recalculé");
});

// --------------------------------------------------------------
// D. Champs légaux configurés -- rendus (legal_name, legal_address,
//    phone, tax_identifier, registration_number, footer_text,
//    business_name — comportement déjà correct, non-régression).
// --------------------------------------------------------------
test("D. Champs légaux configurés -- tous rendus sur le ticket (business_name, legal_name, legal_address, phone, tax_identifier, registration_number, footer_text)", () => {
  const settings = fullSettings();
  const html = buildReceiptHtml({ order: baseOrder(), restaurantName: "Au lait cru (nom restaurant)", settings });

  assert.ok(html.includes("Au lait cru"), "business_name doit primer sur restaurantName quand configuré");
  assert.ok(html.includes("Au Lait Cru SARL"), "legal_name doit être rendu");
  assert.ok(html.includes("12 rue du Fromage, 75001 Paris"), "legal_address doit être rendu");
  assert.ok(html.includes("+33 1 23 45 67 89"), "phone doit être rendu");
  assert.ok(html.includes("FR12345678901"), "tax_identifier doit être rendu");
  assert.ok(html.includes("RCS Paris 123 456 789"), "registration_number doit être rendu");
  assert.ok(html.includes("Merci de votre visite !"), "footer_text doit être rendu");
});

test("D (repli). business_name absent -- repli sur restaurantName (comportement déjà correct, non-régression)", () => {
  const html = buildReceiptHtml({
    order: baseOrder(),
    restaurantName: "Nom de secours",
    settings: fullSettings({ business_name: null }),
  });
  assert.ok(html.includes("Nom de secours"));
});

test("D (champ légal ABSENT) -- jamais inventé : legal_name/legal_address/phone/tax_identifier/registration_number/footer_text non configurés -- aucune ligne correspondante dans le HTML", () => {
  const html = buildReceiptHtml({
    order: baseOrder(),
    restaurantName: "Au lait cru",
    settings: fullSettings({
      legal_name: null,
      legal_address: null,
      phone: null,
      tax_identifier: null,
      registration_number: null,
      footer_text: null,
      email: null,
    }),
  });
  assert.ok(!html.includes("Au Lait Cru SARL"));
  assert.ok(!html.includes("12 rue du Fromage"));
  assert.ok(!html.includes("+33 1 23 45 67 89"));
  assert.ok(!html.includes("FR12345678901"));
  assert.ok(!html.includes("RCS Paris"));
  assert.ok(!html.includes("Merci de votre visite"));
  assert.ok(!html.includes("contact@aulaitcru.example"));
});

// --------------------------------------------------------------
// E. Email configuré -- rendu (écart confirmé et corrigé par ce lot :
//    settings.email était déjà chargé par getReceiptSettings() et
//    saisi dans le formulaire de réglages, mais n'était encore JAMAIS
//    rendu sur le ticket imprimé -- voir lib/receipt.ts).
// --------------------------------------------------------------
test("E. Email configuré (settings.email) -- désormais rendu sur le ticket imprimé", () => {
  const html = buildReceiptHtml({
    order: baseOrder(),
    restaurantName: "Au lait cru",
    settings: fullSettings({ email: "contact@aulaitcru.example" }),
  });
  assert.ok(html.includes("contact@aulaitcru.example"), "l'email configuré doit apparaître sur le ticket");
});

test("E (repli). Email non configuré (null) -- aucune ligne email fabriquée, comportement cohérent avec les autres champs légaux optionnels", () => {
  const html = buildReceiptHtml({
    order: baseOrder(),
    restaurantName: "Au lait cru",
    settings: fullSettings({ email: null }),
  });
  assert.ok(!/@aulaitcru\.example/.test(html));
});

test("E (HTML échappé) -- l'email traverse la même fonction d'échappement esc() que les autres champs (pas de faille XSS spécifique introduite)", () => {
  const html = buildReceiptHtml({
    order: baseOrder(),
    restaurantName: "Au lait cru",
    settings: fullSettings({ email: 'x@y.example"><script>alert(1)</script>' }),
  });
  assert.ok(!html.includes("<script>alert(1)</script>"), "l'email ne doit jamais être injecté sans échappement");
});

// --------------------------------------------------------------
// Non-régression explicite : settings === null (fenêtre de chargement,
// avant le correctif du race côté page/OrderCard -- ce fichier prouve
// le comportement de buildReceiptHtml() lui-même dans ce cas, la garde
// qui EMPÊCHE ce cas d'atteindre l'impression en pratique est prouvée
// séparément par tests/printed-receipt-vat-legal-fix-v1-dom.test.ts,
// scénario F).
// --------------------------------------------------------------
test("Non-régression : settings === null -- aucun champ légal fabriqué, repli sur restaurantName, la TVA (dérivée EXCLUSIVEMENT de l'instantané order.*, jamais de settings) reste correcte", () => {
  const html = buildReceiptHtml({ order: baseOrder(), restaurantName: "Au lait cru", settings: null });

  assert.ok(html.includes("Au lait cru"), "repli sur restaurantName");
  assert.ok(!html.includes("Au Lait Cru SARL"));
  assert.ok(!html.includes("12 rue du Fromage"));
  assert.ok(!/@aulaitcru\.example/.test(html));
  // La TVA elle-même reste correcte car dérivée EXCLUSIVEMENT de
  // l'instantané order.tax_settings_snapshot_* / order_items.
  // tax_rate_snapshot / order_delivery_tax_allocations -- jamais de
  // `settings` -- c'est précisément pourquoi le correctif de ce lot
  // porte sur la DISPONIBILITÉ de `settings` avant impression (les
  // champs LÉGAUX, eux, n'ont aucun repli), pas sur le calcul fiscal.
  assert.ok(html.includes("Total HT"));
  assert.ok(html.includes("Total TTC"));
});
