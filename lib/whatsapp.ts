import type { RestaurantFull, MenuItem } from "@/lib/types";
import type { CustomerInfo } from "@/lib/customer";
import { formatAddress } from "@/lib/customer";

export interface CartLine {
  item: MenuItem;
  quantity: number;
  /** Précision de commande, ex. "Goût : Nutella" */
  note?: string;
}

/** Comment le client récupère sa commande. */
export type OrderContext =
  | { mode: "table"; tableNumber: number }
  | { mode: "pickup"; customer: CustomerInfo }
  | { mode: "delivery"; zoneLabel: string; customer: CustomerInfo };

export function formatPrice(price: number, currency: string): string {
  if (currency === "EUR") {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(price);
  }
  // Le dinar s'écrit "DA" dans l'usage courant, pas "DZD".
  if (currency === "DZD") {
    return `${Math.round(price).toLocaleString("fr-FR")} DA`;
  }
  return `${price.toLocaleString("fr-FR")} ${currency}`;
}

/** Ligne d'en-tête du message décrivant le mode de récupération. */
function contextLines(ctx: OrderContext): string[] {
  switch (ctx.mode) {
    case "table":
      return [`🪑 Table ${ctx.tableNumber}`];
    case "pickup":
      return [
        "🛍️ À emporter — retrait sur place",
        `📞 ${ctx.customer.phone}`,
        `✉️ ${ctx.customer.email}`,
      ];
    case "delivery":
      return [
        `🛵 Livraison — ${ctx.zoneLabel}`,
        `📍 ${formatAddress(ctx.customer)}`,
        `📞 ${ctx.customer.phone}`,
        `✉️ ${ctx.customer.email}`,
      ];
  }
}

/**
 * Construit le lien wa.me contenant le message de commande.
 *
 * Le message reste TOUJOURS en français, quelle que soit la langue
 * choisie par le client : c'est le personnel du restaurant qui le
 * lit, et les noms de produits doivent correspondre à ceux de la
 * carte en cuisine.
 * Le numéro est nettoyé pour ne garder que les chiffres
 * (format attendu par WhatsApp : indicatif pays sans "+").
 */
export function buildWhatsAppUrl(
  restaurant: RestaurantFull,
  lines: CartLine[],
  ctx: OrderContext
): string {
  const { currency, whatsapp_number } = restaurant.config;

  const total = lines.reduce((sum, l) => sum + l.item.price * l.quantity, 0);

  const orderLines = lines
    .map((l) => {
      const note = l.note ? ` (${l.note})` : "";
      return `• ${l.quantity}x ${l.item.name}${note} — ${formatPrice(
        l.item.price * l.quantity,
        currency
      )}`;
    })
    .join("\n");

  const message = [
    `🧾 Nouvelle commande — ${restaurant.name}`,
    ...contextLines(ctx),
    "",
    orderLines,
    "",
    `💰 Total : ${formatPrice(total, currency)}`,
  ].join("\n");

  const digits = whatsapp_number.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
