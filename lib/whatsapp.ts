import type { RestaurantFull, MenuItem } from "@/lib/types";

export interface CartLine {
  item: MenuItem;
  quantity: number;
  /** Précision de commande, ex. "Pâtisserie : Tiramisu" */
  note?: string;
}

export function formatPrice(price: number, currency: string): string {
  return `${price.toLocaleString("fr-DZ")} ${currency}`;
}

/**
 * Construit le lien wa.me contenant le message de commande.
 * Le numéro est nettoyé pour ne garder que les chiffres
 * (format attendu par WhatsApp : indicatif pays sans "+").
 */
export function buildWhatsAppUrl(
  restaurant: RestaurantFull,
  lines: CartLine[],
  tableNumber: number
): string {
  const { currency, whatsapp_number } = restaurant.config;

  const total = lines.reduce(
    (sum, l) => sum + l.item.price * l.quantity,
    0
  );

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
    `🪑 Table ${tableNumber}`,
    "",
    orderLines,
    "",
    `💰 Total : ${formatPrice(total, currency)}`,
  ].join("\n");

  const digits = whatsapp_number.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
