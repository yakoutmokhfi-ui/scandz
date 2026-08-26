import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  buildWhatsAppUrl,
  formatPrice,
  type CartLine,
  type OrderContext,
  type AuthoritativeOrderTotals,
} from "../lib/whatsapp.ts";
import { translate } from "../lib/i18n.ts";

// ====================================================================
// SADFP-V2-01 (CORRECTION v3, mission §2/§3/§7) — le message WhatsApp
// doit utiliser le résumé monétaire AUTORITATIF renvoyé par le
// serveur (create_order -> CreatedOrder), jamais un total recalculé
// depuis les lignes de panier. Preuve COMPORTEMENTALE : on appelle le
// vrai chemin de construction (buildWhatsAppUrl), jamais une
// assertion statique de source seule (voir mission §15).
// ====================================================================

const menuItemA = { id: "item-a", name: "Tiramisu", price: 7.5 } as never;

const restaurant = {
  slug: "sanaa-cookies",
  name: "Sanaa Cookies",
  // EUR : formatage à 2 décimales garanti par Intl.NumberFormat,
  // contrairement à DZD (arrondi à l'entier, voir formatPrice) --
  // indispensable pour distinguer sans ambiguïté 7.50 / 12.50.
  config: { currency: "EUR", whatsapp_number: "+33600000000" },
} as never;

const deliveryCtx: OrderContext = {
  mode: "delivery",
  zoneLabel: "Paris",
  customer: {
    name: "N",
    street: "1 rue Test",
    postalCode: "75001",
    city: "Paris",
    phone: "0600000000",
    email: "n@example.com",
  },
};

function messageOf(
  lines: CartLine[],
  ctx: OrderContext,
  totals: AuthoritativeOrderTotals
): string {
  const url = buildWhatsAppUrl(restaurant, lines, ctx, totals, "fr", 12, null);
  return decodeURIComponent(url.split("text=")[1]);
}

test("SADFP-V2-01 : livraison payante -- le message utilise le subtotal/deliveryFee/total AUTORITATIFS du serveur, jamais lines.reduce(...)", () => {
  // 1 article à 7.50 -> lines.reduce donnerait 7.50, JAMAIS 12.50 --
  // exactement l'exemple de la mission (produits 7.50, frais serveur
  // 5.00, total serveur 12.50).
  const lines: CartLine[] = [{ item: menuItemA, quantity: 1 }];
  const totals: AuthoritativeOrderTotals = { subtotal: 7.5, deliveryFee: 5.0, total: 12.5 };

  const message = messageOf(lines, deliveryCtx, totals);

  const wrongTotalLine = translate("fr", "waTotal", { amount: formatPrice(7.5, "EUR") });
  const rightTotalLine = translate("fr", "waTotal", { amount: formatPrice(12.5, "EUR") });
  const subtotalLine = translate("fr", "waSubtotal", { amount: formatPrice(7.5, "EUR") });
  const feeLine = translate("fr", "waDeliveryFee", { amount: formatPrice(5.0, "EUR") });

  assert.ok(message.includes(subtotalLine), "le sous-total produits (7.50) doit être affiché");
  assert.ok(message.includes(feeLine), "le frais de livraison (5.00) doit être affiché");
  assert.ok(message.includes(rightTotalLine), "le total DOIT être 12.50 (subtotal + deliveryFee serveur)");
  assert.ok(
    !message.includes(wrongTotalLine),
    "le message ne doit JAMAIS contenir 'Total : 7.50' (ce serait le total produits-seuls, jamais le total autoritatif)"
  );

  // Le message doit se TERMINER par la ligne de total autoritatif
  // (dernière ligne non vide), jamais par une valeur produits-seule.
  const trimmedLines = message.split("\n").filter((l) => l.length > 0);
  assert.equal(trimmedLines[trimmedLines.length - 1], rightTotalLine);
});

test("SADFP-V2-01 : frais de livraison nul -- total serveur affiché, AUCUNE ligne de frais dupliquée/incorrecte", () => {
  const lines: CartLine[] = [{ item: menuItemA, quantity: 1 }];
  const totals: AuthoritativeOrderTotals = { subtotal: 7.5, deliveryFee: 0, total: 7.5 };

  const message = messageOf(lines, deliveryCtx, totals);

  const totalLine = translate("fr", "waTotal", { amount: formatPrice(7.5, "EUR") });
  assert.ok(message.includes(totalLine), "le total (7.50, identique au subtotal) doit être affiché");
  assert.ok(
    !message.includes("waDeliveryFee") && !/🚚/.test(message),
    "aucune ligne 'frais de livraison' ne doit apparaître quand deliveryFee=0 (préserve l'UX existante)"
  );
  assert.ok(
    !message.includes(translate("fr", "waSubtotal", { amount: formatPrice(7.5, "EUR") })),
    "aucune ligne de sous-total séparée n'est nécessaire quand il n'y a pas de frais à décomposer"
  );
});

test("SADFP-V2-01 : divergence frontend/serveur -- même si les lignes de panier calculeraient un total différent, le message utilise TOUJOURS order.total (serveur)", () => {
  // Lignes qui, si on les additionnait côté client, donneraient un
  // total totalement différent (99 x 7.50 = 742.50) -- simulateur
  // d'une estimation frontend obsolète/manipulée. Le serveur, lui,
  // a déjà tranché : subtotal 7.50, deliveryFee 5.00, total 12.50
  // (comme si un seul article avait réellement été facturé).
  const tamperedLines: CartLine[] = [{ item: menuItemA, quantity: 99 }];
  const serverTotals: AuthoritativeOrderTotals = { subtotal: 7.5, deliveryFee: 5.0, total: 12.5 };

  const message = messageOf(tamperedLines, deliveryCtx, serverTotals);

  const clientDerivedTotal = translate("fr", "waTotal", {
    amount: formatPrice(99 * 7.5, "EUR"),
  });
  const serverTotal = translate("fr", "waTotal", { amount: formatPrice(12.5, "EUR") });

  assert.ok(
    !message.includes(clientDerivedTotal),
    "le total dérivé des lignes côté client (742.50) ne doit JAMAIS apparaître"
  );
  assert.ok(message.includes(serverTotal), "le total AUTORITATIF du serveur (12.50) doit gagner, quoi que calculent les lignes");
});

test("SADFP-V2-01 : pickup -- deliveryFee toujours 0, comportement identique au cas 'sans frais' (aucune régression du flux non-livraison)", () => {
  const pickupCtx: OrderContext = {
    mode: "pickup",
    customer: {
      name: "P",
      street: "",
      postalCode: "",
      city: "",
      phone: "0600000001",
      email: "p@example.com",
    },
  };
  const lines: CartLine[] = [{ item: menuItemA, quantity: 2 }];
  const totals: AuthoritativeOrderTotals = { subtotal: 15, deliveryFee: 0, total: 15 };

  const message = messageOf(lines, pickupCtx, totals);
  const totalLine = translate("fr", "waTotal", { amount: formatPrice(15, "EUR") });
  assert.ok(message.includes(totalLine));
  assert.ok(!/🚚/.test(message), "pickup : jamais de ligne frais de livraison");
});

test("SADFP-V2-01 (non-régression source) : lib/whatsapp.ts ne recalcule plus JAMAIS le total depuis les lignes (aucun lines.reduce pour un total de commande)", () => {
  const src = readFileSync("lib/whatsapp.ts", "utf8");
  assert.ok(
    !/lines\.reduce/.test(src),
    "buildWhatsAppUrl ne doit plus dériver aucun total depuis `lines` -- seul `totals` (autoritatif) doit alimenter le résumé monétaire"
  );
  assert.match(
    src,
    /totals\.total/,
    "le total affiché doit provenir explicitement de `totals.total`"
  );
});

test("SADFP-V2-01 : orderNumber/langue/note restent inchangés par l'ajout de `totals` (aucune régression de signature au-delà du nouveau paramètre)", () => {
  const lines: CartLine[] = [{ item: menuItemA, quantity: 1 }];
  const totals: AuthoritativeOrderTotals = { subtotal: 7.5, deliveryFee: 0, total: 7.5 };
  const url = buildWhatsAppUrl(restaurant, lines, deliveryCtx, totals, "fr", 42, "Sans oignons");
  const message = decodeURIComponent(url.split("text=")[1]);
  assert.ok(message.includes("42"), "le numéro de commande doit toujours apparaître");
  assert.ok(message.includes("Sans oignons"), "la note doit toujours apparaître");
});
