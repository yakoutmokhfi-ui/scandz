import { supabase } from "@/lib/supabase";
import type { MenuItem } from "@/lib/types";
import type { CartLine, OrderContext } from "@/lib/whatsapp";
import type { Lang } from "@/lib/i18n";
import { buildCreateOrderPayload } from "@/lib/services/order-payload";
import {
  isOrderNoteTooLongError,
  OrderNoteTooLongError,
  ORDER_NOTE_TOO_LONG_CODE,
} from "@/lib/services/order-error";

// Réexportés pour compatibilité : components/MenuView.tsx importe ces
// symboles depuis "@/lib/services/orders". La classification elle-même
// vit dans lib/services/order-error.ts (fonction pure, testable sans
// dépendance Supabase — voir tests/v65-order-note.test.ts).
export { OrderNoteTooLongError, ORDER_NOTE_TOO_LONG_CODE };

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
 *
 * La construction de la charge est déléguée à buildCreateOrderPayload
 * (fonction pure, sans dépendance Supabase) : createOrder se limite à
 * l'appel réseau et à la traduction des erreurs.
 */
export async function createOrder(params: {
  slug: string;
  context: OrderContext;
  lines: CartLine[];
  lang: Lang;
  note?: string | null;
}): Promise<CreatedOrder> {
  const payload = buildCreateOrderPayload(params);

  const { data, error } = await supabase.rpc("create_order", payload);

  if (error) {
    console.error("createOrder:", error.message);
    // Classification stricte (code ET message) : voir
    // lib/services/order-error.ts. Une erreur 22001 sans rapport avec
    // la note (ex. une autre colonne trop longue pour son domaine)
    // ne doit jamais être requalifiée en "note trop longue".
    if (isOrderNoteTooLongError(error)) {
      throw new OrderNoteTooLongError();
    }
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
