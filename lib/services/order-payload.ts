import type { CartLine, OrderContext } from "@/lib/whatsapp";
import { formatAddress } from "@/lib/customer";
import type { Lang } from "@/lib/i18n";
import { orderNotePayload } from "@/lib/order-note";

/** Charge exacte envoyée à la RPC Postgres `create_order`. */
export interface CreateOrderPayload {
  p_slug: string;
  p_service_mode: OrderContext["mode"];
  p_items: { menu_item_id: string; quantity: number; option_item_id: string | null }[];
  p_table_number: number | null;
  /** Coordonnées client, ou objet vide en mode "table". Reste un
   *  simple objet JSON transmis tel quel à la RPC : la validation de
   *  forme est faite côté serveur (create_order), pas ici. */
  p_customer: Record<string, string | null | undefined>;
  p_note: string | null;
  p_language: Lang;
}

/**
 * Construit la charge de `create_order` à partir de l'état du panier.
 *
 * Fonction pure (aucun accès réseau, aucune dépendance à Supabase) :
 * extraite de `createOrder` pour rester testable par `npm test` sans
 * variables d'environnement Supabase. `createOrder` (lib/services/orders.ts)
 * appelle cette fonction puis se contente de transmettre le résultat
 * à `supabase.rpc(...)`.
 */
export function buildCreateOrderPayload(params: {
  slug: string;
  context: OrderContext;
  lines: CartLine[];
  lang: Lang;
  note?: string | null;
}): CreateOrderPayload {
  const { slug, context, lines, lang, note } = params;

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

  return {
    p_slug: slug,
    p_service_mode: context.mode,
    p_items: items,
    p_table_number: context.mode === "table" ? context.tableNumber : null,
    p_customer: customer,
    p_note: orderNotePayload(note),
    p_language: lang,
  };
}
