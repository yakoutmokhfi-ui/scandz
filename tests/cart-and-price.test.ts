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
