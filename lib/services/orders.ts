import { supabase } from "@/lib/supabase";
import type { MenuItem } from "@/lib/types";
import type { CartLine, OrderContext } from "@/lib/whatsapp";
import { formatAddress } from "@/lib/customer";
import type { Lang } from "@/lib/i18n";

export interface CreatedOrder {
  orderId: string;
  orderNumber: number;
  publicToken: string;
  total: number;
}

/**
 * Enregistre la commande via la fonction serveur create_order.
 *
 * Le navigateur n'envoie que des références et des quantités :
 * aucun prix, aucun total, aucun libellé d'option en texte libre.
 * Les montants sont recalculés en base à partir de menu_items, et
 * les règles métier (mode autorisé, zone de livraison, minimum
 * d'articles, validité des options) y sont vérifiées.
 */
export async function createOrder(params: {
  slug: string;
  context: OrderContext;
  lines: CartLine[];
  lang: Lang;
}): Promise<CreatedOrder> {
  const { slug, context, lines, lang } = params;

  const items = lines.map((l) => ({
    menu_item_id: l.item.id,
    quantity: l.quantity,
    option_item_id: l.option ? l.option.id : null,
  }));

  const customer =
    context.mode === "table"
      ? {}
      : {
          name: context.customer.name || null,
          phone: context.customer.phone || null,
          email: context.customer.email || null,
          address:
            context.mode === "delivery" ? formatAddress(context.customer) : null,
        };

  const { data, error } = await supabase.rpc("create_order", {
    p_slug: slug,
    p_service_mode: context.mode,
    p_items: items,
    p_table_number: context.mode === "table" ? context.tableNumber : null,
    p_customer: customer,
    p_note: null,
    p_language: lang,
  });

  if (error) {
    console.error("createOrder:", error.message);
    throw new Error(error.message);
  }

  // La fonction renvoie une table : on prend la première ligne.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Réponse vide du serveur");

  return {
    orderId: row.order_id,
    orderNumber: Number(row.order_number),
    publicToken: row.public_token,
    total: Number(row.total),
  };
}

/**
 * Signale que le lien WhatsApp a été ouvert. Le jeton empêche de
 * modifier une commande dont on ne connaîtrait que l'identifiant.
 * L'échec est sans conséquence : c'est une information de confort.
 */
export async function markWhatsappOpened(
  orderId: string,
  token: string
): Promise<void> {
  const { error } = await supabase.rpc("mark_whatsapp_opened", {
    p_order_id: orderId,
    p_token: token,
  });
  if (error) console.warn("markWhatsappOpened:", error.message);
}

/** Vérifie qu'un article a bien une option quand elle est requise. */
export function hasMissingOption(
  lines: CartLine[],
  requiresOption: (item: MenuItem) => boolean
): boolean {
  return lines.some((l) => requiresOption(l.item) && !l.option);
}
