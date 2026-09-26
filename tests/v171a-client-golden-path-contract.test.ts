import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — LOT 03 CLIENT GOLDEN PATH CONSOLIDATION — contrats purs.
//
// Parcours client complet, couche par couche, SANS DOM :
//   catalogue -> sélection produit -> panier (lib/cart.ts) -> checkout
//   (totaux, frais de livraison estimés) -> charge create_order
//   (lib/services/order-payload.ts) -> requête/réponse create_order
//   (lib/services/orders.ts, `supabase.rpc` intercepté, AUCUNE base
//   réelle) -> lien de suivi Tracking v3.1 (lib/tracking/link.ts) ->
//   résumé TVA de la commande persistée (lib/order-fiscal-summary.ts).
//
// Complété par une preuve STRUCTURELLE de la définition SQL COURANTE
// de public.create_order (tenant, validations, prix/TVA serveur) : ce
// dépôt n'a pas de base de test locale, la fonction est donc lue comme
// texte (même discipline que v103/v168). Le parcours DOM réel (MenuView
// monté) est couvert par tests/v171b-client-golden-path.dom.test.ts.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { addToCart, cartLines, totalCount, totalPrice } = await import("../lib/cart.ts");
const { computeDeliveryFee } = await import("../lib/delivery.ts");
const { buildCreateOrderPayload } = await import("../lib/services/order-payload.ts");
const { createOrder, OrderNoteTooLongError, CgvAcceptanceRequiredError } = await import(
  "../lib/services/orders.ts"
);
const { buildTrackingPath, parseTrackingFragment, buildCleanTrackingPath } = await import(
  "../lib/tracking/link.ts"
);
const { computeOrderFiscalSummary } = await import("../lib/order-fiscal-summary.ts");

import type { MenuItem } from "../lib/types.ts";
import type { OrderContext } from "../lib/whatsapp.ts";
import type { Cart } from "../lib/cart.ts";

// --- Jeux d'essai -----------------------------------------------------

function createMenuItem(
  overrides: Partial<MenuItem> & Pick<MenuItem, "id" | "name" | "price">
): MenuItem {
  return {
    category_id: "cat-golden",
    description: null,
    short_description: null,
    image_url: null,
    display_order: 0,
    is_available: true,
    ...overrides,
  };
}

const BURGER = createMenuItem({ id: "b0000000-0000-4000-8000-000000000001", name: "Burger maison", price: 12.5 });
const LIMONADE = createMenuItem({ id: "b0000000-0000-4000-8000-000000000002", name: "Limonade", price: 3.2 });
const PRESTIGIO = createMenuItem({ id: "b0000000-0000-4000-8000-000000000003", name: "Formule Prestigio", price: 5.5 });
const TIRAMISU = createMenuItem({ id: "b0000000-0000-4000-8000-000000000004", name: "Tiramisu", price: 4.5 });

const SLUG = "golden-bistro";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

const CUSTOMER = {
  name: "Yakout",
  // CFTE v1 : champs de SAISIE ajoutés à CustomerInfo. Laissés VIDES ici
  // délibérément -- ce contrat doré vérifie le chemin HISTORIQUE (nom en
  // un seul champ), qui doit rester rigoureusement inchangé.
  firstName: "",
  lastName: "",
  street: "12 rue des Lilas",
  postalCode: "75001",
  city: "Paris",
  phone: "0612345678",
  email: "",
};

/** Panier doré : 2 x Burger + 1 x Limonade = 28,20. */
function goldenCart(): Cart {
  let cart: Cart = {};
  cart = addToCart(cart, { item: BURGER, quantity: 1 });
  cart = addToCart(cart, { item: BURGER, quantity: 1 });
  cart = addToCart(cart, { item: LIMONADE, quantity: 1 });
  return cart;
}

const MODE_CONTEXTS: Record<"table" | "pickup" | "delivery", OrderContext> = {
  table: { mode: "table", tableNumber: 4 },
  pickup: { mode: "pickup", customer: CUSTOMER },
  delivery: { mode: "delivery", zoneLabel: "Paris", customer: CUSTOMER },
};

/** Clés monétaires/tenant qu'un client ne doit JAMAIS transmettre. */
const FORBIDDEN_CLIENT_KEY = /price|total|amount|fee|tax|vat|restaurant_id|restaurantId|currency/i;

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

// ====================================================================
// 1. Catalogue -> sélection -> panier -> totaux du checkout
// ====================================================================

test("GP-01 panier : la sélection produit alimente le panier, totaux courants exacts (2 x 12,50 + 1 x 3,20 = 28,20)", () => {
  const cart = goldenCart();
  const lines = cartLines(cart);
  assert.deepEqual(
    lines.map((l) => [l.item.id, l.quantity]),
    [[BURGER.id, 2], [LIMONADE.id, 1]],
    "une ligne par produit, dans l'ordre d'ajout, quantités cumulées"
  );
  assert.equal(totalCount(cart), 3);
  assert.equal(totalPrice(cart), 28.2);
});

test("GP-02 checkout : frais de livraison estimé par mode de tarification -- jamais appliqué hors livraison, total = sous-total + frais", () => {
  const subtotal = totalPrice(goldenCart());
  const fixed = computeDeliveryFee({ pricingMode: "fixed", fixedFee: 2.5, freeThreshold: null }, subtotal);
  assert.equal(fixed, 2.5);
  assert.equal(Math.round((subtotal + fixed) * 100) / 100, 30.7);

  assert.equal(computeDeliveryFee({ pricingMode: "free", fixedFee: null, freeThreshold: null }, subtotal), 0);
  assert.equal(
    computeDeliveryFee({ pricingMode: "free_above_threshold", fixedFee: 2.5, freeThreshold: 25 }, subtotal),
    0,
    "seuil atteint (28,20 >= 25) -> livraison offerte"
  );
  assert.equal(
    computeDeliveryFee({ pricingMode: "free_above_threshold", fixedFee: 2.5, freeThreshold: 30 }, subtotal),
    2.5,
    "seuil non atteint -> frais fixe"
  );
});

// ====================================================================
// 2. Charge create_order -- matrice des modes de retrait
// ====================================================================

test("GP-03 charge create_order : contrat exact pour CHAQUE mode (table/pickup/delivery) -- références + quantités seulement", () => {
  const lines = cartLines(goldenCart());
  const expectedItems = [
    { menu_item_id: BURGER.id, quantity: 2, option_item_id: null },
    { menu_item_id: LIMONADE.id, quantity: 1, option_item_id: null },
  ];

  assert.deepEqual(
    buildCreateOrderPayload({ slug: SLUG, context: MODE_CONTEXTS.table, lines, lang: "fr" }),
    {
      p_slug: SLUG,
      p_service_mode: "table",
      p_items: expectedItems,
      p_table_number: 4,
      p_customer: {},
      p_note: null,
      p_language: "fr",
      p_cgv_accepted: false,
    }
  );

  assert.deepEqual(
    buildCreateOrderPayload({ slug: SLUG, context: MODE_CONTEXTS.pickup, lines, lang: "fr" }),
    {
      p_slug: SLUG,
      p_service_mode: "pickup",
      p_items: expectedItems,
      p_table_number: null,
      p_customer: {
        name: "Yakout",
        // CFTE v1 : deux clés ADDITIVES, `null` lorsque le client a
        // saisi son nom dans le champ unique historique.
        first_name: null,
        last_name: null,
        phone: "0612345678",
        email: null,
        address: null,
        postalCode: null,
        street: null,
        city: null,
        // DELIVERY COUNTRY SCOPE v1 : le pays voyage explicitement.
        country: null,
      },
      p_note: null,
      p_language: "fr",
      p_cgv_accepted: false,
    },
    "pickup : aucune donnée d'adresse transmise"
  );

  assert.deepEqual(
    buildCreateOrderPayload({ slug: SLUG, context: MODE_CONTEXTS.delivery, lines, lang: "fr" }),
    {
      p_slug: SLUG,
      p_service_mode: "delivery",
      p_items: expectedItems,
      p_table_number: null,
      p_customer: {
        name: "Yakout",
        first_name: null,
        last_name: null,
        phone: "0612345678",
        email: null,
        address: "12 rue des Lilas, 75001 Paris",
        postalCode: "75001",
        street: "12 rue des Lilas",
        city: "Paris",
        // DELIVERY COUNTRY SCOPE v1 : `null` quand l'appelant ne
        // transmet aucun pays (cas historique) -- le serveur le résout
        // alors depuis la configuration du marchand.
        country: null,
      },
      p_note: null,
      p_language: "fr",
      p_cgv_accepted: false,
    },
    "delivery : code postal STRUCTURÉ transmis tel quel"
  );
});

test("GP-04 charge create_order : aucun prix, total, frais, TVA ni identifiant de tenant n'est jamais transmis par le client, quel que soit le mode", () => {
  const lines = cartLines(goldenCart());
  for (const [mode, context] of Object.entries(MODE_CONTEXTS)) {
    const payload = buildCreateOrderPayload({ slug: SLUG, context, lines, lang: "fr", note: "Sans oignon" });
    const offenders = collectKeys(payload).filter((k) => FORBIDDEN_CLIENT_KEY.test(k));
    assert.deepEqual(offenders, [], `${mode} : clés interdites transmises -- ${offenders.join(", ")}`);
    assert.equal(payload.p_slug, SLUG, `${mode} : le tenant n'est désigné QUE par son slug`);
  }
});

test("GP-05 sélection avec option : l'option voyage par référence (option_item_id), jamais par libellé ni par prix", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: PRESTIGIO, quantity: 1, option: TIRAMISU, optionKind: "pastry" });
  const payload = buildCreateOrderPayload({
    slug: SLUG,
    context: MODE_CONTEXTS.table,
    lines: cartLines(cart),
    lang: "fr",
  });
  assert.deepEqual(payload.p_items, [
    { menu_item_id: PRESTIGIO.id, quantity: 1, option_item_id: TIRAMISU.id },
  ]);
});

// ====================================================================
// 3. Requête / réponse create_order (supabase.rpc intercepté)
// ====================================================================

test("GP-06 createOrder : UN seul appel create_order avec la charge exacte ; réponse serveur mappée telle quelle (montants numeric PostgREST en chaîne compris)", async (t) => {
  const calls: { name: string; args: unknown }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [
        {
          order_id: ORDER_ID,
          order_number: "101",
          public_token: TOKEN,
          subtotal: "28.20",
          delivery_fee: "2.50",
          total: "30.70",
        },
      ],
      error: null,
    };
  });

  const lines = cartLines(goldenCart());
  const order = await createOrder({ slug: SLUG, context: MODE_CONTEXTS.delivery, lines, lang: "fr" });

  assert.equal(calls.length, 1, "exactement un appel réseau");
  assert.equal(calls[0].name, "create_order");
  assert.deepEqual(
    calls[0].args,
    buildCreateOrderPayload({ slug: SLUG, context: MODE_CONTEXTS.delivery, lines, lang: "fr" })
  );
  assert.deepEqual(order, {
    orderId: ORDER_ID,
    orderNumber: 101,
    publicToken: TOKEN,
    total: 30.7,
    subtotal: 28.2,
    deliveryFee: 2.5,
  });
});

test("GP-07 createOrder en échec : aucune commande renvoyée, erreur métier brute jamais requalifiée, classifications dédiées préservées", async (t) => {
  const lines = cartLines(goldenCart());
  const cases: { error: Record<string, unknown>; expect: (err: unknown) => boolean }[] = [
    {
      error: { code: "P0001", message: "Article indisponible ou étranger à ce restaurant: x" },
      expect: (err) =>
        err instanceof Error &&
        !(err instanceof OrderNoteTooLongError) &&
        !(err instanceof CgvAcceptanceRequiredError),
    },
    { error: { code: "P0001", message: "Commande vide" }, expect: (err) => err instanceof Error },
    {
      error: { code: "22001", message: "SCANYM_ORDER_NOTE_TOO_LONG" },
      expect: (err) => err instanceof OrderNoteTooLongError,
    },
    {
      error: { code: "P0001", message: "CGV_ACCEPTANCE_REQUIRED" },
      expect: (err) => err instanceof CgvAcceptanceRequiredError,
    },
  ];
  const quietError = t.mock.method(console, "error", () => {});
  let currentError: Record<string, unknown> = {};
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: currentError }));
  for (const c of cases) {
    currentError = c.error;
    await assert.rejects(
      createOrder({ slug: SLUG, context: MODE_CONTEXTS.pickup, lines, lang: "fr" }),
      (err: unknown) => c.expect(err),
      `classification attendue pour "${String(c.error.message)}"`
    );
  }
  assert.ok(quietError.mock.callCount() >= cases.length);
});

test("GP-08 createOrder : réponse vide du serveur -- échec explicite, jamais une commande fantôme", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    createOrder({ slug: SLUG, context: MODE_CONTEXTS.table, lines: cartLines(goldenCart()), lang: "fr" }),
    /Réponse vide du serveur/
  );
});

// ====================================================================
// 4. Confirmation -> Tracking v3.1 (sans fuite de jeton)
// ====================================================================

test("GP-09 transition vers le suivi : le lien de confirmation porte order_id en chemin et public_token UNIQUEMENT en fragment, relu comme preuve legacy one-shot", () => {
  const href = buildTrackingPath(ORDER_ID, TOKEN);
  const url = new URL(href, "https://scanym.example");
  assert.equal(url.pathname, `/track/${ORDER_ID}`);
  assert.equal(url.search, "");
  assert.equal(url.pathname.includes(TOKEN), false, "le jeton n'est jamais dans une requête HTTP");
  assert.deepEqual(parseTrackingFragment(decodeURIComponent(url.hash.slice(1))), {
    kind: "legacy",
    publicToken: TOKEN,
  });
  assert.equal(buildCleanTrackingPath(ORDER_ID), url.pathname, "chemin propre = chemin réellement envoyé au serveur");
});

// ====================================================================
// 5. TVA -- la commande persistée par create_order reste cohérente
// ====================================================================

test("GP-10 TVA : commande dorée telle que persistée (instantanés par ligne + ventilation livraison) -- détail multi-taux réconcilié avec le total serveur", () => {
  // Forme persistée par create_order v2.5 : unit_price/line_total lus
  // depuis menu_items.price, tax_rate_snapshot depuis menu_items.tax_rate,
  // total = subtotal + delivery_fee ; ventilation livraison cohérente
  // (gross = net + tax par ligne, somme = frais de livraison).
  const persisted = {
    id: ORDER_ID,
    restaurant_id: "r-golden",
    order_number: 101,
    status: "new",
    service_mode: "delivery",
    table_number: null,
    customer_name: "Yakout",
    customer_phone: "0612345678",
    customer_email: null,
    delivery_address: "12 rue des Lilas, 75001 Paris",
    delivery_zone: "75",
    customer_note: null,
    customer_language: "fr",
    subtotal: 28.2,
    total: 30.7,
    currency: "EUR",
    created_at: "2026-09-18T10:00:00Z",
    updated_at: "2026-09-18T10:00:00Z",
    tax_settings_snapshot_default_tax_rate: 10,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_items: [
      { id: "i1", item_name: "Burger maison", option_name: null, quantity: 2, unit_price: 12.5, line_total: 25, tax_rate_snapshot: 10 },
      { id: "i2", item_name: "Limonade", option_name: null, quantity: 1, unit_price: 3.2, line_total: 3.2, tax_rate_snapshot: 20 },
    ],
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 10, delivery_fee_gross_share: 2.22, delivery_fee_net_share: 2.02, delivery_fee_tax_amount: 0.2 },
      { tax_rate_snapshot: 20, delivery_fee_gross_share: 0.28, delivery_fee_net_share: 0.23, delivery_fee_tax_amount: 0.05 },
    ],
  } as never;

  const summary = computeOrderFiscalSummary(persisted);
  assert.equal(summary.mode, "mixed-rate");
  if (summary.mode !== "mixed-rate") return;
  assert.equal(summary.totalGross, 30.7, "le TTC reste le total autoritaire serveur");
  const cents = (n: number) => Math.round(n * 100);
  assert.equal(
    summary.rates.reduce((acc, r) => acc + cents(r.gross), 0),
    cents(30.7),
    "somme des TTC par taux = total"
  );
  for (const r of summary.rates) {
    assert.equal(cents(r.net) + cents(r.tax), cents(r.gross), `taux ${r.rate} : HT + TVA = TTC`);
  }
  assert.deepEqual(summary.rates.map((r) => r.rate).sort((a, b) => a - b), [10, 20]);
  // Référence indépendante :
  //   10 % : produit 25,00 -> HT 22,73 / TVA 2,27 ; livraison 2,02 / 0,20 -> 24,75 / 2,47
  //   20 % : produit  3,20 -> HT  2,67 / TVA 0,53 ; livraison 0,23 / 0,05 ->  2,90 / 0,58
  assert.equal(summary.totalNet, 27.65);
  assert.equal(summary.totalTax, 3.05);
});

// ====================================================================
// 6. create_order (SQL) -- définition COURANTE, tenant + validations
// ====================================================================

// Dernière redéfinition de public.create_order posée sur main
// (CGV ENGINE v2.5, 16/09/2026). DRAFT-lot-order-received-enqueue-
// recovery-v1.sql (posé ensuite) ajoute un déclencheur et ne touche
// PAS create_order -- vérifié ci-dessous.
const CURRENT_CREATE_ORDER_SQL = "supabase/DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql";

function createOrderBody(): string {
  const sql = readFileSync(CURRENT_CREATE_ORDER_SQL, "utf8");
  const start = sql.indexOf("create or replace function public.create_order(");
  assert.ok(start >= 0, "définition create_order introuvable");
  const end = sql.indexOf("end $$;", start);
  assert.ok(end > start, "fin de définition create_order introuvable");
  return sql.slice(start, end);
}

test("GP-11 SQL : la définition courante de create_order n'a pas été redéfinie depuis (le lot enqueue-recovery n'y touche pas)", () => {
  const recovery = readFileSync("supabase/DRAFT-lot-order-received-enqueue-recovery-v1.sql", "utf8");
  assert.equal(/create\s+or\s+replace\s+function\s+public\.create_order\s*\(/i.test(recovery), false);
  const body = createOrderBody();
  assert.ok(body.includes("p_cgv_accepted  boolean default false"), "signature à 8 arguments (v1.1+)");
  assert.ok(/security definer\s+set search_path = ''/.test(body), "SECURITY DEFINER + search_path vide");
});

test("GP-12 SQL tenant : restaurant résolu par slug actif uniquement, aucun restaurant_id client, produits ET options confinés à ce restaurant", () => {
  const body = createOrderBody();
  const signature = body.slice(0, body.indexOf(")"));
  assert.equal(/p_restaurant_id/.test(signature), false, "le client ne désigne jamais le tenant par identifiant");
  assert.ok(
    body.includes("from public.restaurants where slug = p_slug and is_active = true and status = 'active'"),
    "tenant résolu côté serveur depuis le slug, restaurant actif uniquement"
  );
  assert.ok(
    /join public\.menu_categories mc on mc\.id = mi\.category_id\s+where mi\.id = \(v_item->>'menu_item_id'\)::uuid\s+and mc\.restaurant_id = v_restaurant\.id\s+and mi\.is_available = true\s+and mc\.is_active = true;/.test(body),
    "chaque produit est cherché DANS le restaurant résolu, disponible, catégorie active"
  );
  assert.ok(body.includes("Article indisponible ou étranger à ce restaurant"));
  assert.ok(
    /and mi\.category_id = v_menu_item\.option_source_category_id\s+and mi\.is_available = true;/.test(body),
    "une option n'est acceptée que depuis la catégorie source du produit (déjà confiné au tenant)"
  );
});

test("GP-13 SQL validations : restaurant, mode, panier vide, champs requis et zone sont contrôlés AVANT l'insertion de la commande (transaction unique, aucune commande sur échec)", () => {
  const body = createOrderBody();
  const insertAt = body.indexOf("insert into public.orders (");
  assert.ok(insertAt > 0);
  for (const guard of [
    "Restaurant introuvable ou inactif",
    "Mode de service % non autorisé pour %",
    "Commande vide",
    "Trop de lignes dans la commande",
    "Champ requis manquant pour ce mode",
    "Code postal absent de l''adresse",
  ]) {
    const at = body.indexOf(guard);
    assert.ok(at > 0, `garde "${guard}" absente`);
    assert.ok(at < insertAt, `garde "${guard}" doit précéder l'insertion`);
  }
  // Les gardes par ligne (produit/option/quantité) et le minimum de
  // livraison lèvent APRÈS l'insertion, mais dans la même fonction
  // plpgsql -- l'exception annule toute la transaction. Aucun bloc
  // "exception when" ne vient l'avaler.
  assert.equal(/exception\s+when/i.test(body), false, "aucune exception avalée dans create_order");
  // (`on commit drop` de la table temporaire n'est pas un COMMIT.)
  assert.equal(/\bcommit\s*;/i.test(body), false, "aucun commit intermédiaire");
});

test("GP-14 SQL montants : prix unitaire et taux de TVA lus depuis le catalogue serveur, total = sous-total + frais résolu serveur", () => {
  const body = createOrderBody();
  assert.ok(
    body.includes("v_qty, v_menu_item.price, v_menu_item.price * v_qty,"),
    "unit_price / line_total recalculés depuis menu_items.price"
  );
  assert.ok(
    body.includes("v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate,"),
    "tax_rate_snapshot figé depuis menu_items.tax_rate"
  );
  assert.ok(body.includes("v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);"), "frais de livraison résolu serveur");
  assert.ok(body.includes("total = v_subtotal + v_delivery_fee,"));
  assert.ok(
    body.includes("return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;"),
    "la réponse porte exactement les champs mappés par createOrder"
  );
  // Aucune valeur monétaire n'est lue depuis la charge client.
  assert.equal(/p_items[^;]*->>'(unit_)?price'/.test(body), false);
  assert.equal(/p_customer->>'(total|subtotal|delivery_fee)'/.test(body), false);
});
