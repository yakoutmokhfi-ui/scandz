import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addToCart,
  cartLines,
  changeLineQuantity,
  decrementItem,
  lineKey,
  optionCountsForItem,
  quantityForItem,
  removeItem,
  totalCount,
  totalPrice,
  type Cart,
} from "../lib/cart.ts";
import { formatPrice } from "../lib/whatsapp.ts";
import type { MenuItem } from "../lib/types.ts";

// --- Jeux d'essai -----------------------------------------------------
// Corrigé (Definition of Done Scanym, 11 août 2026) : ni `as never` ni
// `as unknown as MenuItem` — les deux contournent le contrôle
// structurel de TypeScript au lieu de produire des fixtures
// réellement conformes à MenuItem. `createMenuItem()` complète les
// champs hors sujet pour ces tests (category_id, description,
// short_description, image_url, display_order, is_available) avec
// des valeurs neutres, sans assertion de type d'aucune sorte : le
// compilateur vérifie réellement que le résultat est un MenuItem
// complet.
function createMenuItem(
  overrides: Partial<MenuItem> & Pick<MenuItem, "id" | "name" | "price">
): MenuItem {
  return {
    category_id: "test-category",
    description: null,
    short_description: null,
    image_url: null,
    display_order: 0,
    is_available: true,
    ...overrides,
  };
}

const cappuccino = createMenuItem({ id: "cap", name: "Cappuccino", price: 250 });
const prestigio = createMenuItem({ id: "pres", name: "Formule Prestigio", price: 550 });
const tiramisu = createMenuItem({ id: "tir", name: "Tiramisu", price: 450 });
const millefeuille = createMenuItem({ id: "mil", name: "Mille-feuille", price: 250 });

// ====================================================================
// BUG 1 — formatage des prix partagé
// ====================================================================

test("bug1: le dinar s'affiche DA, jamais DZD", () => {
  const out = formatPrice(1300, "DZD");
  assert.ok(out.includes("DA"), `attendu "DA" dans "${out}"`);
  assert.ok(!out.includes("DZD"), `"DZD" ne doit pas apparaître : "${out}"`);
});

test("bug1: l'euro reste correctement formaté", () => {
  const out = formatPrice(2.5, "EUR");
  assert.ok(out.includes("2,50"), `attendu "2,50" dans "${out}"`);
  assert.ok(out.includes("€"), `attendu "€" dans "${out}"`);
});

test("bug1: les montants ne sont pas altérés", () => {
  assert.ok(formatPrice(1300, "DZD").includes("300"));
  assert.ok(formatPrice(0, "DZD").includes("0"));
});

// ====================================================================
// BUG 2 — quantité des produits à options
// ====================================================================

test("bug2: tout produit démarre à zéro", () => {
  const cart: Cart = {};
  assert.equal(quantityForItem(cart, prestigio.id), 0);
  assert.equal(quantityForItem(cart, cappuccino.id), 0);
  assert.equal(totalCount(cart), 0);
});

test("bug2: ouvrir la fenêtre de choix n'ajoute rien au panier", () => {
  // L'ouverture ne passe pas par le panier : l'état reste vide tant
  // qu'aucune confirmation n'a eu lieu.
  let cart: Cart = {};
  assert.equal(cartLines(cart).length, 0);
  assert.equal(quantityForItem(cart, prestigio.id), 0);
});

test("bug2: le produit entre au panier seulement après confirmation", () => {
  let cart: Cart = {};
  cart = addToCart(cart, {
    item: prestigio,
    quantity: 1,
    option: tiramisu,
    optionKind: "pastry",
  });
  assert.equal(quantityForItem(cart, prestigio.id), 1);
  assert.equal(cartLines(cart).length, 1);
});

test("bug2: le moins depuis 1 retire complètement le produit", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: prestigio, quantity: 1, option: tiramisu });
  cart = decrementItem(cart, prestigio.id);

  assert.equal(quantityForItem(cart, prestigio.id), 0);
  assert.equal(cartLines(cart).length, 0, "l'interface doit revenir au bouton Ajouter");
});

test("bug2: le retrait efface l'option retenue", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: prestigio, quantity: 1, option: tiramisu });
  cart = decrementItem(cart, prestigio.id);

  assert.deepEqual(optionCountsForItem(cart, prestigio.id), {});
  assert.equal(cart[lineKey(prestigio.id, tiramisu.name)], undefined);
});

test("bug2: la quantité ne descend jamais sous zéro", () => {
  let cart: Cart = {};
  cart = decrementItem(cart, prestigio.id);
  cart = decrementItem(cart, prestigio.id);
  assert.equal(quantityForItem(cart, prestigio.id), 0);
  assert.equal(cartLines(cart).length, 0);
});

test("bug2: produits avec et sans option se comportent pareil", () => {
  for (const item of [cappuccino, prestigio]) {
    let cart: Cart = {};
    assert.equal(quantityForItem(cart, item.id), 0, "départ à zéro");

    cart = addToCart(cart, {
      item,
      quantity: 1,
      option: item === prestigio ? tiramisu : undefined,
    });
    assert.equal(quantityForItem(cart, item.id), 1, "un ajout donne 1");

    cart = decrementItem(cart, item.id);
    assert.equal(quantityForItem(cart, item.id), 0, "un retrait ramène à 0");
    assert.equal(cartLines(cart).length, 0, "la ligne disparaît");
  }
});

test("bug2: deux options du même produit font deux lignes distinctes", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: prestigio, quantity: 2, option: tiramisu });
  cart = addToCart(cart, { item: prestigio, quantity: 1, option: millefeuille });

  assert.equal(cartLines(cart).length, 2);
  assert.equal(quantityForItem(cart, prestigio.id), 3);
  assert.deepEqual(optionCountsForItem(cart, prestigio.id), {
    Tiramisu: 2,
    "Mille-feuille": 1,
  });
});

test("bug2: le moins retire de la dernière ligne ajoutée", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: prestigio, quantity: 2, option: tiramisu });
  cart = addToCart(cart, { item: prestigio, quantity: 1, option: millefeuille });

  cart = decrementItem(cart, prestigio.id);

  assert.equal(quantityForItem(cart, prestigio.id), 2);
  assert.deepEqual(optionCountsForItem(cart, prestigio.id), { Tiramisu: 2 });
});

test("bug2: une ligne précise se modifie par sa clé", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: prestigio, quantity: 3, option: tiramisu });
  const key = lineKey(prestigio.id, tiramisu.name);

  cart = changeLineQuantity(cart, key, -2);
  assert.equal(quantityForItem(cart, prestigio.id), 1);

  cart = changeLineQuantity(cart, key, -1);
  assert.equal(cartLines(cart).length, 0);
});

test("bug2: retirer un produit emporte toutes ses options", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: prestigio, quantity: 2, option: tiramisu });
  cart = addToCart(cart, { item: prestigio, quantity: 1, option: millefeuille });
  cart = addToCart(cart, { item: cappuccino, quantity: 1 });

  cart = removeItem(cart, prestigio.id);

  assert.equal(quantityForItem(cart, prestigio.id), 0);
  assert.equal(quantityForItem(cart, cappuccino.id), 1, "les autres produits restent");
});

test("bug2: les totaux suivent le contenu du panier", () => {
  let cart: Cart = {};
  cart = addToCart(cart, { item: cappuccino, quantity: 2 });
  cart = addToCart(cart, { item: prestigio, quantity: 1, option: tiramisu });

  assert.equal(totalCount(cart), 3);
  assert.equal(totalPrice(cart), 2 * 250 + 550);

  cart = decrementItem(cart, prestigio.id);
  assert.equal(totalCount(cart), 2);
  assert.equal(totalPrice(cart), 500);
});

// ====================================================================
// V31 — matrice de rôles du catalogue (logique côté interface)
// ====================================================================

import { canEditProducts, canToggleAvailability } from "../lib/roles.ts";

test("v31: owner et manager peuvent éditer, pas staff", () => {
  assert.equal(canEditProducts("owner"), true);
  assert.equal(canEditProducts("manager"), true);
  assert.equal(canEditProducts("staff"), false);
  assert.equal(canEditProducts(undefined), false);
});

test("v31: tous les rôles peuvent signaler une rupture", () => {
  assert.equal(canToggleAvailability("owner"), true);
  assert.equal(canToggleAvailability("manager"), true);
  assert.equal(canToggleAvailability("staff"), true);
  assert.equal(canToggleAvailability(undefined), false);
});

// ====================================================================
// Thèmes — lisibilité garantie pour chaque palette proposée
// ====================================================================

import { THEMES, getTheme, themeStyle } from "../lib/themes.ts";

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * f(ch[0]) + 0.7152 * f(ch[1]) + 0.0722 * f(ch[2]);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("themes: texte lisible sur le fond de chaque palette", () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(
      contrast(t.ink, t.bg) >= 4.5,
      `${name}: contraste texte/fond insuffisant`
    );
  }
});

test("themes: texte blanc lisible sur les boutons", () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(
      contrast("#FFFFFF", t.accent) >= 4.5,
      `${name}: contraste blanc/bouton insuffisant`
    );
  }
});

test("themes: un thème inconnu retombe sur le thème par défaut", () => {
  assert.deepEqual(getTheme("inexistant"), THEMES.cafe);
  assert.deepEqual(getTheme(undefined), THEMES.cafe);
});

test("themes: les variables CSS sont toutes produites", () => {
  const style = themeStyle("nuit");
  for (const key of [
    "--sc-ink",
    "--sc-bg",
    "--sc-accent",
    "--sc-accent-dark",
    "--sc-highlight",
  ]) {
    assert.ok(style[key], `variable ${key} manquante`);
  }
  assert.equal(style["--sc-accent"], THEMES.nuit.accent);
});

test("themes: le voile de bannière suit la couleur sombre du thème", () => {
  const nuit = themeStyle("nuit");
  const cafe = themeStyle("cafe");
  // Un bar bleu ne doit pas hériter du brun d'un café
  assert.notEqual(nuit["--sc-veil-soft"], cafe["--sc-veil-soft"]);
  assert.ok(nuit["--sc-veil-soft"].startsWith("rgba("));
  assert.ok(nuit["--sc-veil-strong"].startsWith("rgba("));
});

// ====================================================================
// V39 — langue du ticket destiné au personnel
// ====================================================================

import { translate } from "../lib/i18n.ts";

test("v39: le ticket se traduit dans les trois langues", () => {
  for (const [lang, expected] of [
    ["fr", "TOTAL"],
    ["en", "TOTAL"],
    ["ar", "المجموع"],
  ] as const) {
    assert.equal(translate(lang, "rcTotal"), expected);
  }
  assert.ok(translate("ar", "rcPickup").length > 0);
  assert.notEqual(translate("fr", "rcDelivery"), translate("ar", "rcDelivery"));
});

test("v39: le numéro de commande figure dans le ticket", () => {
  assert.ok(translate("fr", "rcOrder", { n: 12 }).includes("12"));
  assert.ok(translate("ar", "rcOrder", { n: 12 }).includes("12"));
});

// ====================================================================
// V39 bug — la langue du gérant doit piloter WhatsApp ET le dashboard
// ====================================================================

import { buildReceiptHtml } from "../lib/receipt.ts";

/** Commande minimale, telle que la renvoie le dashboard. */
function fakeOrder(lang: string) {
  return {
    id: "o1",
    order_number: 12,
    status: "new",
    service_mode: "table",
    table_number: 7,
    total: 1300,
    currency: "DZD",
    customer_language: lang,
    created_at: new Date().toISOString(),
    order_items: [
      {
        id: "i1",
        item_name: "Cappuccino",
        option_name: null,
        quantity: 2,
        unit_price: 250,
        line_total: 500,
      },
    ],
  } as never;
}

test("bug v39: le ticket du dashboard suit la langue du gérant", () => {
  const fr = buildReceiptHtml(
    { order: fakeOrder("fr"), restaurantName: "Illico", settings: null },
    "fr"
  );
  const ar = buildReceiptHtml(
    { order: fakeOrder("fr"), restaurantName: "Illico", settings: null },
    "ar"
  );

  // Même commande, deux langues : le rendu doit différer
  assert.notEqual(fr, ar, "le ticket ne change pas avec la langue");
  assert.ok(fr.includes("SUR PLACE"), "libellé français attendu");
  assert.ok(ar.includes("الطاولة"), "libellé arabe attendu");
  assert.ok(!ar.includes("SUR PLACE"), "libellé français résiduel en arabe");
});

test("bug v39: WhatsApp et le ticket partagent la même source", () => {
  // Les deux passent par translate() : une clé absente d'un côté
  // le serait de l'autre.
  for (const lang of ["fr", "en", "ar"] as const) {
    assert.notEqual(translate(lang, "rcTable", { n: 7 }), "rcTable");
    assert.notEqual(translate(lang, "waTable", { n: 7 }), "waTable");
    assert.notEqual(translate(lang, "dsTable", { n: 7 }), "dsTable");
  }
});

test("bug v39: les libellés du dashboard existent dans les trois langues", () => {
  const keys = [
    "dsNew", "dsAccepted", "dsPreparing", "dsReady",
    "dsAccept", "dsRefuse", "dsCancel", "dsPrint",
    "dsPickup", "dsDelivery",
  ];
  for (const key of keys) {
    for (const lang of ["fr", "en", "ar"] as const) {
      assert.notEqual(translate(lang, key), key, `${key} manquant en ${lang}`);
    }
    // Le français et l'arabe ne doivent pas coïncider
    assert.notEqual(translate("fr", key), translate("ar", key), key);
  }
});

test("bug v39b: le nom du produit suit la langue du gérant", () => {
  // L'instantané reste français ; la traduction du produit prime
  // quand elle existe.
  const line = {
    item_name: "Cappuccino",
    option_name: null,
    menu_items: { translations: { ar: { name: "كابتشينو" } } },
    option: null,
  } as never;

  const pick = (l: string) =>
    l === "fr"
      ? (line as { item_name: string }).item_name
      : ((line as { menu_items?: { translations?: Record<string, { name?: string }> } })
          .menu_items?.translations?.[l]?.name ??
        (line as { item_name: string }).item_name);

  assert.equal(pick("fr"), "Cappuccino");
  assert.equal(pick("ar"), "كابتشينو");
  // Sans traduction anglaise, on retombe sur l'instantané
  assert.equal(pick("en"), "Cappuccino");
});

test("bug v39b: libellés du dashboard complets et distincts", () => {
  const keys = [
    "dsOrderTitle", "dsMinutes", "dsOrders", "dsActiveOrders",
    "dsHistory", "dsSubtitle", "dsSoundOn", "dsSoundOff",
  ];
  for (const key of keys) {
    for (const lang of ["fr", "en", "ar"] as const) {
      assert.notEqual(translate(lang, key), key, `${key} manquant en ${lang}`);
    }
    assert.notEqual(translate("fr", key), translate("ar", key), key);
  }
});

test("v41: toute l'interface commerçant existe dans les trois langues", () => {
  const keys = [
    // Ma carte
    "mcTitle", "mcSettings", "mcHintEdit", "mcHintStaff", "mcSeeArchived",
    "mcAvailable", "mcSoldOut", "mcEdit", "mcArchive", "mcRestore",
    "mcCreate", "mcSave", "mcCancel", "mcName", "mcPrice", "mcEmpty",
    // Réglages
    "stTitle", "stLangTitle", "stLangHint", "stInfoTitle", "stAddress",
    "stHours", "stSaved", "stSaveFailed",
    // Navigation
    "dsOrders", "dsLogout", "dsBackToOrders",
  ];
  for (const key of keys) {
    for (const lang of ["fr", "en", "ar"] as const) {
      assert.notEqual(translate(lang, key), key, `${key} manquant en ${lang}`);
    }
    assert.notEqual(translate("fr", key), translate("ar", key), key);
    assert.notEqual(translate("fr", key), translate("en", key), key);
  }
});

// ====================================================================
// Motifs de fond
// ====================================================================

import { patternUrl, zelligeUrl } from "../lib/pattern.ts";

test("motifs: le zellige produit une image inline valide et légère", () => {
  const url = zelligeUrl("#C6A15B");
  assert.ok(url.startsWith('url("data:image/svg+xml,'), "data-URI attendue");
  assert.ok(url.length < 1500, `motif trop lourd : ${url.length} caractères`);
  // La couleur du thème doit se retrouver dans le tracé
  assert.ok(url.includes(encodeURIComponent("#C6A15B")));
});

test("motifs: la couleur suit le thème", () => {
  assert.notEqual(zelligeUrl("#C6A15B"), zelligeUrl("#B08D57"));
});

test("motifs: aucun motif quand l'établissement n'en veut pas", () => {
  assert.equal(patternUrl("none", "#000000"), undefined);
  assert.equal(patternUrl(undefined, "#000000"), undefined);
  assert.ok(patternUrl("zellige", "#000000"));
  assert.ok(patternUrl("diamond", "#000000"));
});

test("motifs: l'entrelacs girih est valide et raisonnablement léger", () => {
  const url = patternUrl("girih", "#C9A227");
  assert.ok(url, "motif girih absent");
  assert.ok(url!.startsWith('url("data:image/svg+xml,'));
  assert.ok(url!.length < 4000, `motif trop lourd : ${url!.length}`);
  assert.ok(url!.includes(encodeURIComponent("#C9A227")));
});

// ====================================================================
// Variantes visuelles de démonstration
// ====================================================================

import { getSettings } from "../lib/restaurants-config.ts";

test("demo: Le Sirocco a une bannière par défaut, sans paramètre d'URL", () => {
  assert.equal(getSettings("le-sirocco").banner, "sirocco-nuit");
});

test("demo: les autres établissements gardent la bannière de leur slug", () => {
  assert.equal(getSettings("illico-presto").banner, undefined);
  assert.equal(getSettings("sanaa-cookies").banner, undefined);
});

// ====================================================================
// Architecture — la dépendance à Supabase reste dans les services
// ====================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Fichiers d'interface : pages et composants, hors couche service. */
function uiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk("app");
  walk("components");
  return out;
}

/**
 * Cible les appels réellement interdits, pas le mot « supabase » :
 * une mention en commentaire ou un nom de variable ne doit pas
 * faire échouer le test.
 */
const FORBIDDEN = [
  { pattern: /supabase\s*\.\s*auth\s*\./, label: "supabase.auth.*" },
  { pattern: /supabase\s*\.\s*channel\s*\(/, label: "supabase.channel(" },
  { pattern: /supabase\s*\.\s*removeChannel\s*\(/, label: "supabase.removeChannel(" },
  { pattern: /supabase\s*\.\s*from\s*\(/, label: "supabase.from(" },
];

test("archi: l'interface n'appelle jamais Supabase directement", () => {
  const offenders: string[] = [];
  for (const file of uiFiles()) {
    const src = readFileSync(file, "utf8");
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(src)) offenders.push(`${file} → ${label}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Passer par lib/services : ${offenders.join(", ")}`
  );
});

test("archi: Realtime et Auth sont encapsulés dans un service unique", () => {
  const realtime = readFileSync("lib/services/realtime.ts", "utf8");
  const auth = readFileSync("lib/services/auth.ts", "utf8");

  // Le service est bien le seul à connaître le mécanisme
  assert.ok(/supabase\s*\.\s*channel\s*\(/.test(realtime));
  assert.ok(/supabase\s*\.\s*auth\s*\./.test(auth));

  // Les deux préoccupations restent séparées
  assert.ok(!/supabase\s*\.\s*auth\s*\./.test(realtime));
  assert.ok(!/supabase\s*\.\s*channel\s*\(/.test(auth));
});

// ====================================================================
// STUART LOT C v1.2 (LOT-C-12-03) — lib/receipt.ts, rendu TVA
// multi-taux. Couvre les items 9-14 de la TEST MATRIX ADDITIONS du
// mandat v1.2 : (9) pas de taux marchand par défaut appliqué au total
// pour une commande multi-taux, (10) regroupement produit par
// tax_rate_snapshot, (11) incorporation de la ventilation TVA
// livraison, (12) équivalence financière à taux unique, (13)/(14)
// instantanés historiques ignorent menu_items.tax_rate/le taux
// marchand courant (déjà couvert structurellement par le test
// MLTP-V1-HISTORICAL-TAX-01 ci-dessus — ici, couverture par le
// COMPORTEMENT réel du rendu, pas seulement par grep de source).
//
// NOTE STUART LOT C v1.3 : depuis la correction CIO/CTO DÉCISION 1,
// buildMixedRateTaxGroups() ne recalcule plus JAMAIS le net/taxe
// livraison à partir du gross combiné (produit+livraison) ; le net et
// la taxe PRODUIT sont dérivés du gross PRODUIT seul, et le net/la
// taxe LIVRAISON sont lus TELS QUELS depuis l'instantané persistant
// order_delivery_tax_allocations, puis les deux paires sont
// simplement ADDITIONNÉES. Dans la fixture ci-dessous, les valeurs de
// order_delivery_tax_allocations (1.25/0.25 pour le taux 20, 1.42/0.08
// pour le taux 5.5) coïncident avec un arrondi "à plat" sur la part
// livraison seule -- la référence indépendante recalculée ligne par
// ligne (produit puis livraison, additionnés) donne donc EXACTEMENT
// les mêmes totaux que l'ancien calcul combiné-puis-arrondi utilisé
// pour documenter ce test en v1.2. Ceci est une coïncidence de cette
// fixture précise (voir le test LOT-C-13 dédié plus bas, qui utilise
// le cas CTO 0.01 où les deux méthodes DIVERGENT, pour prouver la
// correction v1.3 elle-même).
// ====================================================================

function fakeMixedRateOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "o-lotc12",
    order_number: 42,
    status: "new",
    service_mode: "delivery",
    table_number: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    delivery_address: null,
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 20.0,
    total: 23.0,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tax_settings_snapshot_default_tax_rate: 20.0,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_items: [
      { id: "i1", item_name: "Plat A", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 20.0 },
      { id: "i2", item_name: "Plat B", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 5.5 },
    ],
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.25, delivery_fee_tax_amount: 0.25 },
      { tax_rate_snapshot: 5.5, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.42, delivery_fee_tax_amount: 0.08 },
    ],
    ...overrides,
  } as never;
}

test("LOT-C-12-03 (item 9/10/11): commande multi-taux -- pas de taux marchand unique appliqué au total, regroupement par tax_rate_snapshot, ventilation livraison incorporée", () => {
  const html = buildReceiptHtml(
    { order: fakeMixedRateOrder(), restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // Calcul de référence INDÉPENDANT (même formule que le déclencheur
  // SQL, pas une réutilisation du code testé) :
  //   rate 20  : gross = 10.00 (produit) + 1.50 (livraison) = 11.50 ; net = round(11.50/1.20,2) = 9.58 ; tax = 1.92
  //   rate 5.5 : gross = 10.00 (produit) + 1.50 (livraison) = 11.50 ; net = round(11.50/1.055,2) = 10.90 ; tax = 0.60
  //   total HT = 9.58 + 10.90 = 20.48 ; total TTC = order.total = 23.00 (autoritaire, inchangé)
  assert.ok(html.includes(formatPrice(20.48, "EUR")), "Total HT doit être la somme des HT par groupe, jamais un calcul à taux unique");
  assert.ok(html.includes("TVA 20%"), "une ligne TVA par taux présent sur la commande");
  assert.ok(html.includes(formatPrice(1.92, "EUR")), "montant TVA du groupe 20% (produit + part livraison à ce taux)");
  assert.ok(html.includes("TVA 5.5%"));
  assert.ok(html.includes(formatPrice(0.6, "EUR")), "montant TVA du groupe 5.5% (produit + part livraison à ce taux)");
  assert.ok(html.includes(formatPrice(23, "EUR")), "Total TTC reste order.total, l'unique autorité financière");
  // Preuve négative : le calcul PLAT à taux unique (ancien comportement
  // v1.1) aurait donné TVA = 23 - 23/1.20 = 3.83(...) sur le total
  // entier -- ce montant NE DOIT PAS apparaître (preuve que le taux
  // marchand par défaut n'est plus appliqué en bloc à une commande
  // multi-taux).
  assert.ok(!html.includes(formatPrice(3.83, "EUR")), "le taux marchand par défaut ne doit jamais être appliqué au total entier pour une commande multi-taux");
});

test("LOT-C-12-03 (item 12): commande à taux UNIQUE -- équivalence financière exacte entre le rendu multi-taux (éligible) et le calcul plat historique (non éligible)", () => {
  const singleRateEligible = fakeMixedRateOrder({
    total: 12.0,
    order_items: [
      { id: "i1", item_name: "Plat A", option_name: null, quantity: 1, unit_price: 5.0, line_total: 5.0, tax_rate_snapshot: 20.0 },
      { id: "i2", item_name: "Plat B", option_name: null, quantity: 1, unit_price: 5.0, line_total: 5.0, tax_rate_snapshot: 20.0 },
    ],
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 2.0, delivery_fee_net_share: 1.67, delivery_fee_tax_amount: 0.33 },
    ],
  });
  // Même montants financiers, mais NON éligible au rendu multi-taux
  // (un item sans tax_rate_snapshot) -- doit emprunter l'ANCIEN calcul
  // plat, inchangé depuis v1.1.
  const singleRateLegacyPath = fakeMixedRateOrder({
    total: 12.0,
    order_items: [
      { id: "i1", item_name: "Plat A", option_name: null, quantity: 1, unit_price: 5.0, line_total: 5.0, tax_rate_snapshot: null },
      { id: "i2", item_name: "Plat B", option_name: null, quantity: 1, unit_price: 5.0, line_total: 5.0, tax_rate_snapshot: null },
    ],
    order_delivery_tax_allocations: [],
  });

  const htmlMixedPath = buildReceiptHtml(
    { order: singleRateEligible, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  const htmlLegacyPath = buildReceiptHtml(
    { order: singleRateLegacyPath, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );

  // Les deux chemins de calcul (nouveau groupé vs ancien plat)
  // produisent EXACTEMENT le même résultat financier pour une commande
  // à taux unique : Total HT 10,00 €, TVA 20% 2,00 €, Total TTC 12,00 €.
  for (const html of [htmlMixedPath, htmlLegacyPath]) {
    assert.ok(html.includes(formatPrice(10, "EUR")), "Total HT identique entre les deux chemins");
    assert.ok(html.includes(formatPrice(2, "EUR")), "montant TVA identique entre les deux chemins");
    assert.ok(html.includes(formatPrice(12, "EUR")), "Total TTC identique entre les deux chemins");
    assert.ok(html.includes("TVA 20%"));
  }
});

test("LOT-C-12-03 (item 13/14): commande historique SANS tax_rate_snapshot par ligne -- ignore le rendu multi-taux, jamais menu_items.tax_rate ni le taux marchand courant, replie sur le calcul plat existant", () => {
  const legacyOrder = fakeMixedRateOrder({
    order_items: [
      { id: "i1", item_name: "Plat historique", option_name: null, quantity: 1, unit_price: 20.0, line_total: 20.0, tax_rate_snapshot: null },
    ],
    order_delivery_tax_allocations: [],
    subtotal: 20.0,
    total: 23.0,
  });
  const html = buildReceiptHtml(
    { order: legacyOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // Repli sur le calcul plat existant (taux marchand par défaut de
  // l'INSTANTANÉ de commande, 20% ici -- jamais un taux menu_items
  // courant, qui n'est de toute façon jamais lu par ce fichier).
  assert.ok(html.includes("TVA 20%"));
  assert.ok(!html.includes("TVA 5.5%"), "aucun rendu multi-taux fabriqué pour une commande sans tax_rate_snapshot par ligne");
});

test("LOT-C-12-03: livraison gratuite (delivery_fee=0, aucune ligne de ventilation) -- rendu multi-taux basé uniquement sur les lignes produit, jamais d'erreur", () => {
  const freeDeliveryOrder = fakeMixedRateOrder({
    total: 20.0,
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: freeDeliveryOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(html.includes("TVA 20%"));
  assert.ok(html.includes("TVA 5.5%"));
  assert.ok(html.includes(formatPrice(20, "EUR")));
});

test("LOT-C-12-03: provider_cost/delivery_merchant_subsidy n'apparaissent jamais dans le rendu TVA client (LOT-C-BIZ-01)", () => {
  const html = buildReceiptHtml(
    { order: fakeMixedRateOrder({ provider_cost: 4.5, delivery_merchant_subsidy: 3.0 }), restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("4,50"), "provider_cost ne doit jamais apparaître dans le ticket client");
  assert.ok(!/provider.?cost|merchant.?subsidy/i.test(html));
});

// ====================================================================
// STUART LOT C v1.3 — lib/receipt.ts, CIO/CTO DÉCISION 1 (autorité de
// l'instantané reçu). Couvre les items 1/2/3/4/5/8/9 de la TESTS —
// FINAL TARGETED MATRIX du mandat v1.3 :
//   (1) le reçu lit le net livraison persistant (order_delivery_tax_
//       allocations.delivery_fee_net_share), jamais un recalcul ;
//   (2) le reçu lit la taxe livraison persistante (...delivery_fee_
//       tax_amount), jamais un recalcul ;
//   (3) le reçu ne recalcule jamais la taxe livraison à partir d'un
//       gross combiné (produit + livraison) ;
//   (4) le cas de divergence d'arrondi 0.01 confirmé par le CTO
//       retourne EXACTEMENT gross=0.04 / net=0.04 / tax=0.00, jamais
//       gross=0.04 / net=0.03 / tax=0.01 (résultat v1.2, désormais
//       interdit) ;
//   (5) une ventilation livraison ajustée par résidu (net != round
//       (gross/(1+rate),2) "naïf") survit INCHANGÉE dans le reçu ;
//   (8)/(9) un changement ultérieur du taux par défaut marchand
//       (tax_settings_snapshot_default_tax_rate) n'affecte jamais un
//       reçu dont les lignes portent déjà un tax_rate_snapshot propre
//       -- l'instantané ligne par ligne reste l'unique autorité.
// ====================================================================

test("LOT-C-13 (item 4, cas CTO obligatoire): gross=0.01/taux 20% -- ventilation livraison persistée 0.03/0.03/0.00 -- combiné DOIT donner 0.04/0.04/0.00, jamais 0.04/0.03/0.01", () => {
  const ctoEdgeCaseOrder = fakeMixedRateOrder({
    total: 0.04,
    subtotal: 0.01,
    order_items: [
      { id: "i1", item_name: "Micro-article", option_name: null, quantity: 1, unit_price: 0.01, line_total: 0.01, tax_rate_snapshot: 20.0 },
    ],
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 0.03, delivery_fee_net_share: 0.03, delivery_fee_tax_amount: 0.0 },
    ],
  });
  const html = buildReceiptHtml(
    { order: ctoEdgeCaseOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // Référence indépendante v1.3 (jamais un recalcul combiné) :
  //   produit : net = round(0.01/1.20,2) = 0.01 ; tax = 0.01-0.01 = 0.00
  //   livraison (lue telle quelle) : net = 0.03 ; tax = 0.00
  //   combiné : gross = 0.01+0.03 = 0.04 ; net = 0.01+0.03 = 0.04 ; tax = 0.00+0.00 = 0.00
  assert.ok(html.includes("TVA 20%"));
  assert.ok(html.includes(formatPrice(0.04, "EUR")), "Total HT et Total TTC doivent tous deux afficher 0,04 €");
  assert.ok(html.includes(formatPrice(0, "EUR")), "montant TVA du groupe 20% doit être 0,00 €");
  // Preuve négative -- l'ancien résultat v1.2 (BUG désormais interdit
  // par le mandat CIO/CTO) recalculait net=round((0.01+0.03)/1.20,2)=0.03
  // et tax=0.04-0.03=0.01 : cette ligne TVA précise ne doit JAMAIS
  // apparaître (0,01 € apparaît légitimement ailleurs sur le ticket,
  // comme prix de la ligne produit elle-même -- on cible donc
  // spécifiquement la ligne totalisatrice TVA, pas une simple
  // sous-chaîne globale).
  assert.ok(
    !html.includes(`<span>TVA 20%</span><span>${formatPrice(0.01, "EUR")}</span>`),
    "l'ancien résultat combiné-puis-arrondi (ligne TVA 20% = 0,01 €) est désormais interdit par le mandat CIO/CTO v1.3"
  );
});

test("LOT-C-13 (items 1/2/3/5): ventilation livraison ajustée par résidu -- le reçu lit l'instantané TEL QUEL, ne le recalcule jamais depuis le gross combiné", () => {
  // Ventilation persistée volontairement NON conforme à un arrondi
  // "naïf" round(part_gross/(1+taux),2) isolé -- simule un ajustement
  // par résidu de centime (LOT-C-12-02) survivant dans l'instantané
  // SQL. Si le reçu recalculait quoi que ce soit (au lieu de lire ces
  // valeurs telles quelles), il produirait un résultat différent.
  const residualAdjustedOrder = fakeMixedRateOrder({
    total: 11.51,
    order_items: [
      { id: "i1", item_name: "Plat A", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 20.0 },
    ],
    order_delivery_tax_allocations: [
      // gross=1.51 ; un arrondi "naïf" isolé donnerait net=round(1.51/1.20,2)=1.26, tax=0.25 --
      // mais l'instantané persistant (avec résidu appliqué en SQL) porte 1.20/0.31.
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.51, delivery_fee_net_share: 1.2, delivery_fee_tax_amount: 0.31 },
    ],
  });
  const html = buildReceiptHtml(
    { order: residualAdjustedOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // Référence v1.3 : produit net=round(10/1.20,2)=8.33, tax=1.67 ;
  // livraison lue telle quelle : net=1.20, tax=0.31 ;
  // combiné : net=8.33+1.20=9.53 ; tax=1.67+0.31=1.98 ; gross=11.51.
  assert.ok(html.includes(formatPrice(9.53, "EUR")), "Total HT doit refléter l'instantané livraison persistant tel quel (9,53 €), jamais un recalcul");
  assert.ok(html.includes(formatPrice(1.98, "EUR")), "montant TVA doit refléter l'instantané livraison persistant tel quel (1,98 €), jamais un recalcul");
  assert.ok(html.includes(formatPrice(11.51, "EUR")), "Total TTC reste la somme des gross, 11,51 €");
  // Preuve négative : un recalcul à partir du gross combiné donnerait
  // net=round(11.51/1.20,2)=9.59 et tax=11.51-9.59=1.92 -- valeurs
  // différentes de l'instantané persistant, qui ne doivent PAS apparaître.
  assert.ok(!html.includes(formatPrice(9.59, "EUR")), "un recalcul depuis le gross combiné (9,59 €) ne doit jamais apparaître -- l'instantané livraison est l'unique autorité");
  assert.ok(!html.includes(formatPrice(1.92, "EUR")), "un recalcul depuis le gross combiné (TVA 1,92 €) ne doit jamais apparaître -- l'instantané livraison est l'unique autorité");
});

test("LOT-C-13 (items 8/9): un taux par défaut marchand modifié ULTÉRIEUREMENT (tax_settings_snapshot_default_tax_rate) n'affecte jamais un reçu dont les lignes portent déjà leur propre tax_rate_snapshot", () => {
  // Simule un marchand ayant changé son taux par défaut après coup
  // (99% est une valeur sentinelle impossible en pratique, choisie
  // pour rendre toute fuite immédiatement détectable) -- les lignes
  // produit et la ventilation livraison, elles, restent figées à leurs
  // taux d'origine (20% / 5.5%) au moment de la commande.
  const laterDefaultRateChangedOrder = fakeMixedRateOrder({
    tax_settings_snapshot_default_tax_rate: 99.0,
  });
  const html = buildReceiptHtml(
    { order: laterDefaultRateChangedOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(html.includes("TVA 20%"), "le taux d'origine par ligne (20%) doit rester utilisé malgré le changement ultérieur du taux par défaut marchand");
  assert.ok(html.includes("TVA 5.5%"), "le taux d'origine par ligne (5.5%) doit rester utilisé malgré le changement ultérieur du taux par défaut marchand");
  assert.ok(!html.includes("TVA 99%"), "le taux par défaut marchand modifié APRÈS la commande ne doit jamais apparaître sur un reçu historique à taux multiples");
});

// ====================================================================
// STUART LOT C v1.4 (LOT-C-HISTORICAL-DELIVERY-TAX-01) — lib/receipt.ts,
// garde de COMPLÉTUDE de l'instantané TVA livraison. Couvre les items
// 1-15 de la TARGETED TEST MATRIX du mandat v1.4 :
//   (1)/(2)/(3)/(4)/(5) commande historique multi-taux éligible mais
//       delivery_fee>0 + order_delivery_tax_allocations=[] --
//       décomposition HT/TVA supprimée, Total TTC affiché tel quel,
//       aucune TVA livraison fabriquée à zéro, aucun repli sur le
//       calcul plat à taux marchand par défaut ;
//   (6) taux produit manquant dans la ventilation (couverture
//       partielle) -- suppression ;
//   (7) taux orphelin dans la ventilation (sans groupe produit
//       correspondant) -- suppression ;
//   (8) taux dupliqué dans la ventilation -- suppression ;
//   (9) somme des parts gross != delivery_fee dérivé -- suppression ;
//   (10) une ligne d'allocation avec gross != net + tax -- suppression ;
//   (11) ventilation complète et réconciliée -- décomposition
//       multi-taux TOUJOURS affichée (aucune régression) ;
//   (12) livraison gratuite + zéro ligne de ventilation -- comportement
//       inchangé (aucune ventilation exigée) ;
//   (13) cas CTO 0.01 (v1.3) reste PASS -- déjà couvert par le test
//       "LOT-C-13 (item 4, cas CTO obligatoire)" ci-dessus, dont
//       l'instantané est complet et réconcilié (une seule ligne
//       d'allocation pour l'unique taux produit, somme exacte) --
//       ré-exécuté après cette garde v1.4, toujours PASS ;
//   (14) reçu à taux unique inchangé -- déjà couvert par le test
//       "LOT-C-12-03 (item 12)" ci-dessus (ventilation complète), et
//       par le test dédié "complet et réconcilié" (11) ci-dessous ;
//   (15) un réglage marchand courant/ultérieur (tax_settings_snapshot_
//       default_tax_rate) ne reconstruit JAMAIS une TVA livraison
//       historique manquante -- couvert par le test dédié "aucun repli
//       taux marchand par défaut" ci-dessous (items 5+15 combinés).
// ====================================================================

test("LOT-C-14 (items 1/2/3/4): commande historique -- items fiscalisés par ligne + delivery_fee>0 + order_delivery_tax_allocations=[] -- décomposition HT/TVA SUPPRIMÉE, Total TTC affiché tel quel, aucune TVA livraison fabriquée à zéro", () => {
  const historicalZeroAllocationOrder = fakeMixedRateOrder({
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: historicalZeroAllocationOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "aucun Total HT ne doit être affiché quand l'instantané TVA livraison est absent pour une commande à livraison payante");
  assert.ok(!/TVA\s+\d/.test(html), "aucune ligne TVA par taux ne doit être fabriquée (y compris à zéro) quand l'instantané livraison est incomplet");
  assert.ok(html.includes("<span>TOTAL</span>"), "repli 'option B' -- même étiquette générique que MERCHANT LEGAL & TAX PROFILE v1.1 pour un instantané fiscal absent");
  assert.ok(html.includes(formatPrice(23, "EUR")), "le total autoritaire déjà persisté (order.total, incluant la livraison) reste affiché tel quel");
});

test("LOT-C-14 (item 6): ventilation PARTIELLE -- un taux produit (5.5%) n'a AUCUNE ligne d'allocation correspondante alors que la somme des parts existantes réconcilie déjà le frais de livraison -- décomposition HT/TVA SUPPRIMÉE", () => {
  const partialMissingRateOrder = fakeMixedRateOrder({
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 3.0, delivery_fee_net_share: 2.5, delivery_fee_tax_amount: 0.5 },
    ],
  });
  const html = buildReceiptHtml(
    { order: partialMissingRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "une ventilation qui ne couvre pas TOUS les taux produit est incomplète, même si la somme gross réconcilie déjà le frais de livraison");
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

test("LOT-C-14 (item 7): taux ORPHELIN dans la ventilation (10% -- aucun groupe produit à ce taux) -- décomposition HT/TVA SUPPRIMÉE", () => {
  const orphanRateOrder = fakeMixedRateOrder({
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.25, delivery_fee_tax_amount: 0.25 },
      { tax_rate_snapshot: 5.5, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.42, delivery_fee_tax_amount: 0.08 },
      { tax_rate_snapshot: 10.0, delivery_fee_gross_share: 0, delivery_fee_net_share: 0, delivery_fee_tax_amount: 0 },
    ],
  });
  const html = buildReceiptHtml(
    { order: orphanRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "une ligne de ventilation à un taux sans groupe produit correspondant rend l'instantané incohérent, même si les autres lignes sont par ailleurs correctes");
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

test("LOT-C-14 (item 8): taux DUPLIQUÉ dans la ventilation (deux lignes pour 20%) -- décomposition HT/TVA SUPPRIMÉE", () => {
  const duplicateRateOrder = fakeMixedRateOrder({
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.25, delivery_fee_tax_amount: 0.25 },
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.25, delivery_fee_tax_amount: 0.25 },
      { tax_rate_snapshot: 5.5, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.42, delivery_fee_tax_amount: 0.08 },
    ],
  });
  const html = buildReceiptHtml(
    { order: duplicateRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "une ventilation portant deux lignes pour le même taux est incohérente par construction (jamais produite par le déclencheur SQL, mais traitée défensivement comme incomplète)");
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

test("LOT-C-14 (item 9): somme des parts gross (2.50) != frais de livraison dérivé (3.00) -- décomposition HT/TVA SUPPRIMÉE", () => {
  const grossSumMismatchOrder = fakeMixedRateOrder({
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.0, delivery_fee_net_share: 0.83, delivery_fee_tax_amount: 0.17 },
      { tax_rate_snapshot: 5.5, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.42, delivery_fee_tax_amount: 0.08 },
    ],
  });
  const html = buildReceiptHtml(
    { order: grossSumMismatchOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "chaque ligne d'allocation est individuellement cohérente (gross=net+tax) mais leur somme ne réconcilie pas order.total-order.subtotal -- doit rester supprimé");
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

test("LOT-C-14 (item 10): une ligne d'allocation avec gross != net + tax (1.50 != 1.00+0.20) -- décomposition HT/TVA SUPPRIMÉE", () => {
  const rowInconsistentOrder = fakeMixedRateOrder({
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 20.0, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.0, delivery_fee_tax_amount: 0.2 },
      { tax_rate_snapshot: 5.5, delivery_fee_gross_share: 1.5, delivery_fee_net_share: 1.42, delivery_fee_tax_amount: 0.08 },
    ],
  });
  const html = buildReceiptHtml(
    { order: rowInconsistentOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "la somme totale des gross réconcilie par coïncidence order.total-order.subtotal, mais une ligne individuellement incohérente (gross != net+tax) doit à elle seule suffire à supprimer la décomposition");
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

test("LOT-C-14 (item 11): ventilation COMPLÈTE et réconciliée -- décomposition multi-taux TOUJOURS affichée (aucune régression introduite par la garde de complétude v1.4)", () => {
  const html = buildReceiptHtml(
    { order: fakeMixedRateOrder(), restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(html.includes("Total HT"));
  assert.ok(html.includes("TVA 20%"));
  assert.ok(html.includes("TVA 5.5%"));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

test("LOT-C-14 (item 12): livraison GRATUITE + zéro ligne de ventilation -- comportement inchangé, aucune ventilation exigée (delivery_fee dérivé <= 0)", () => {
  const freeDeliveryOrder = fakeMixedRateOrder({
    total: 20.0,
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: freeDeliveryOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(html.includes("Total HT"), "livraison gratuite (delivery_fee dérivé = total-subtotal = 0) -- la garde de complétude v1.4 ne s'applique pas, comportement identique à v1.1/v1.2/v1.3");
  assert.ok(html.includes("TVA 20%"));
  assert.ok(html.includes("TVA 5.5%"));
});

test("LOT-C-14 (items 5/15): instantané TVA livraison incomplet -- AUCUN repli sur le taux marchand par défaut de l'instantané (tax_settings_snapshot_default_tax_rate=15%, ne correspond à AUCUN taux produit) -- pas de reconstruction depuis un réglage courant/ultérieur", () => {
  const mismatchedDefaultRateOrder = fakeMixedRateOrder({
    tax_settings_snapshot_default_tax_rate: 15.0,
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: mismatchedDefaultRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("TVA 15%"), "le taux par défaut marchand (instantané ou courant) ne doit JAMAIS être appliqué en repli pour reconstruire une TVA livraison historique manquante");
  assert.ok(!html.includes("Total HT"));
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes("<span>TOTAL</span>"));
  assert.ok(html.includes(formatPrice(23, "EUR")));
});

// ====================================================================
// STUART LOT C v1.5 (LOT-C-RECEIPT-ZERO-RATE-01) — lib/receipt.ts,
// correction de l'exigence erronée "au moins un taux strictement
// positif" dans useMixedRateRendering. Couvre les items 1-8 de la
// TARGETED TEST MATRIX du mandat v1.5 (les items 9/10/11 sont
// satisfaits par la ré-exécution des suites LOT-C-13/LOT-C-14/
// LOT-C-12-03 existantes ci-dessus, toutes inchangées et toujours
// PASS après ce correctif -- voir commentaire dédié en fin de bloc).
// ====================================================================

test("LOT-C-15 (item 1): produit unique à taux 0%, AUCUNE livraison -- Total HT = Total TTC, aucune TVA fabriquée depuis le taux marchand par défaut (20%, non concordant)", () => {
  const singleZeroRateNoDeliveryOrder = fakeMixedRateOrder({
    total: 10.0,
    subtotal: 10.0,
    order_items: [
      { id: "i1", item_name: "Article détaxé", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 0.0 },
    ],
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: singleZeroRateNoDeliveryOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(html.includes("Total HT"), "un instantané COMPLET exclusivement à 0% doit activer le rendu par instantané (pas de repli plat)");
  assert.ok(html.includes(formatPrice(10, "EUR")), "Total HT = Total TTC = 10,00 € (taux 0% -- net = gross)");
  assert.ok(!html.includes("TVA 20%"), "le taux marchand par défaut (20%, non concordant avec l'instantané réel à 0%) ne doit JAMAIS être appliqué en repli");
  assert.ok(!/TVA\s+[1-9]/.test(html), "aucune TVA positive ne doit être fabriquée pour un instantané exclusivement à 0%");
});

test("LOT-C-15 (items 2/3/4, reproduction EXACTE Stevens): produit 0% + livraison payante allouée à 0% (gross=2.00/net=2.00/tax=0.00) -- Total HT=12.00, Total TTC=12.00, AUCUNE ligne 'TVA 20%', AUCUNE ligne 'TVA 0%' explicite (convention de présentation préservée)", () => {
  const stevensZeroRateOrder = fakeMixedRateOrder({
    total: 12.0,
    subtotal: 10.0,
    order_items: [
      { id: "i1", item_name: "Article détaxé", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 0.0 },
    ],
    order_delivery_tax_allocations: [
      { tax_rate_snapshot: 0.0, delivery_fee_gross_share: 2.0, delivery_fee_net_share: 2.0, delivery_fee_tax_amount: 0.0 },
    ],
  });
  const html = buildReceiptHtml(
    { order: stevensZeroRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // Référence indépendante v1.5 : produit net=round(10/1,2)=10.00,
  // tax=0.00 ; livraison lue telle quelle (gross=2.00, net=2.00,
  // tax=0.00) ; combiné : gross=12.00, net=12.00, tax=0.00.
  assert.ok(html.includes("Total HT"), "item 2 -- l'instantané complet à 0% (produit + livraison) doit activer le rendu par instantané");
  assert.ok(html.includes(formatPrice(12, "EUR")), "item 2 -- Total HT = Total TTC = 12,00 €, jamais 10,00 €/2,00 € fabriqués par le calcul plat");
  assert.ok(!html.includes("TVA 20%"), "item 3 -- aucune ligne 'TVA 20%' (taux marchand par défaut) ne doit apparaître malgré un instantané réel à 0%");
  assert.ok(!html.includes("TVA 0%"), "item 4 -- convention de présentation préservée : aucune ligne 'TVA 0% : 0,00 €' explicite n'est requise ni ajoutée par ce correctif");
  assert.ok(!/TVA\s+[1-9]/.test(html), "aucune TVA positive fabriquée");
});

test("LOT-C-15 (item 5): instantané mixte 0% + 5.5% -- comportement déjà correct INCHANGÉ (régression), la part HT du groupe à 0% contribue normalement au Total HT", () => {
  const mixedZeroAndReducedRateOrder = fakeMixedRateOrder({
    total: 20.0,
    subtotal: 20.0,
    order_items: [
      { id: "i1", item_name: "Article détaxé", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 0.0 },
      { id: "i2", item_name: "Article réduit", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 5.5 },
    ],
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: mixedZeroAndReducedRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // rate 0 : net=10.00, tax=0.00 ; rate 5.5 : net=round(10/1.055,2)=9.48,
  // tax=0.52 ; Total HT = 10.00+9.48 = 19.48 ; Total TTC = 20.00.
  assert.ok(html.includes(formatPrice(19.48, "EUR")), "Total HT doit inclure la part du groupe à 0% (10,00 €) additionnée à celle du groupe à 5.5% (9,48 €)");
  assert.ok(html.includes("TVA 5.5%"));
  assert.ok(html.includes(formatPrice(0.52, "EUR")));
  assert.ok(!html.includes("TVA 0%"), "convention de présentation inchangée -- pas de ligne explicite pour le groupe à 0%");
  assert.ok(html.includes(formatPrice(20, "EUR")));
});

test("LOT-C-15 (item 6): instantané mixte 0% + 20% -- comportement déjà correct INCHANGÉ (régression)", () => {
  const mixedZeroAndStandardRateOrder = fakeMixedRateOrder({
    total: 20.0,
    subtotal: 20.0,
    order_items: [
      { id: "i1", item_name: "Article détaxé", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 0.0 },
      { id: "i2", item_name: "Article standard", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 20.0 },
    ],
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: mixedZeroAndStandardRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  // rate 0 : net=10.00, tax=0.00 ; rate 20 : net=round(10/1.2,2)=8.33,
  // tax=1.67 ; Total HT = 10.00+8.33 = 18.33 ; Total TTC = 20.00.
  assert.ok(html.includes(formatPrice(18.33, "EUR")));
  assert.ok(html.includes("TVA 20%"));
  assert.ok(html.includes(formatPrice(1.67, "EUR")));
  assert.ok(!html.includes("TVA 0%"));
  assert.ok(html.includes(formatPrice(20, "EUR")));
});

test("LOT-C-15 (item 7): produit à 0% + ventilation livraison HISTORIQUE INCOMPLÈTE (delivery_fee>0, order_delivery_tax_allocations=[]) -- la garde de complétude v1.4 supprime toujours la décomposition, INCHANGÉE par ce correctif", () => {
  const incompleteHistoryZeroRateOrder = fakeMixedRateOrder({
    total: 12.0,
    subtotal: 10.0,
    order_items: [
      { id: "i1", item_name: "Article détaxé", option_name: null, quantity: 1, unit_price: 10.0, line_total: 10.0, tax_rate_snapshot: 0.0 },
    ],
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: incompleteHistoryZeroRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(!html.includes("Total HT"), "un produit à 0% n'exempte pas de la garde de complétude v1.4 -- delivery_fee>0 avec ventilation absente reste supprimé, jamais un rendu par instantané partiel ni un repli plat");
  assert.ok(!/TVA\s+\d/.test(html));
  assert.ok(html.includes("<span>TOTAL</span>"), "repli 'option B' -- comportement v1.4 inchangé par ce correctif v1.5");
  assert.ok(html.includes(formatPrice(12, "EUR")));
});

test("LOT-C-15 (item 8): livraison GRATUITE + produit unique à 0% -- rendu par instantané valide, Total HT = Total TTC, aucune TVA fabriquée", () => {
  const freeDeliveryZeroRateOrder = fakeMixedRateOrder({
    total: 15.0,
    subtotal: 15.0,
    tax_settings_snapshot_default_tax_rate: 8.0,
    order_items: [
      { id: "i1", item_name: "Article détaxé", option_name: null, quantity: 1, unit_price: 15.0, line_total: 15.0, tax_rate_snapshot: 0.0 },
    ],
    order_delivery_tax_allocations: [],
  });
  const html = buildReceiptHtml(
    { order: freeDeliveryZeroRateOrder, restaurantName: "Au Lait Cru", settings: null },
    "fr"
  );
  assert.ok(html.includes("Total HT"));
  assert.ok(html.includes(formatPrice(15, "EUR")));
  assert.ok(!html.includes("TVA 8%"), "livraison gratuite -- aucune ventilation exigée (deliveryFeeGross<=0), et aucun repli sur le taux marchand par défaut (8%, non concordant)");
  assert.ok(!/TVA\s+[1-9]/.test(html));
});

// Items 9/10/11 de la matrice v1.5 -- ré-exécution des suites
// existantes, sans nouveau test dédié (elles couvrent déjà exactement
// ces cas et restent, après ce correctif, toutes PASS) :
//   (9)  garde de complétude historique v1.4 -- tests "LOT-C-14 (items
//        1-12/5-15)" ci-dessus, ré-exécutés, PASS.
//   (10) cas CTO 0.01 persisté (v1.3) -- test "LOT-C-13 (item 4, cas
//        CTO obligatoire)" ci-dessus, ré-exécuté, PASS.
//   (11) instantanés à taux strictement positifs -- tests
//        "LOT-C-12-03 (item 9/10/11)", "LOT-C-12-03 (item 12)" et
//        "LOT-C-14 (item 11)" ci-dessus, ré-exécutés, PASS.
