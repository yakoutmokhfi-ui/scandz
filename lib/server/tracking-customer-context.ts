import "server-only";
import { supabase } from "@/lib/supabase";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";
import { publicContactOf, type PublicContact } from "@/lib/customer-contact";

/**
 * Scanym — CUSTOMER CONTACT + LIVE TRACKING v1.
 *
 * Contexte CLIENT complémentaire de la page de suivi (nom du commerçant
 * et son contact PUBLIC), lu par la RPC
 * `get_order_tracking_customer_context_by_capability` — MÊME preuve de
 * capacité v3.1 que `get_order_tracking_by_capability` (prédicat SQL
 * identique, voir supabase/DRAFT-lot-customer-contact-live-tracking-
 * v1.sql). La lecture principale du suivi (lib/server/tracking-
 * service.ts) et sa sécurité de session ne sont NI modifiées NI
 * contournées : ce module ne fait que réutiliser la capacité déjà
 * vérifiée par la page.
 *
 * ÉCHEC FERMÉ ET SILENCIEUX : toute entrée implausible, erreur RPC,
 * ligne absente ou liée à une autre commande renvoie `null`. La page de
 * suivi reste alors complète (statut, frise, total) — simplement sans
 * section contact. Jamais une donnée inventée, jamais une donnée d'une
 * autre commande.
 *
 * Aucune donnée WhatsApp n'est lue ici : le suivi ne dépend jamais de
 * WhatsApp. Le secret de capacité et l'identifiant de commande ne sont
 * jamais journalisés.
 */

export interface OrderTrackingCustomerContext {
  restaurantName: string;
  publicContact: PublicContact | null;
}

interface ContextRow {
  bound_order_id: string | null;
  restaurant_name: string | null;
  public_phone: string | null;
  public_email: string | null;
}

export async function getOrderTrackingCustomerContext(input: {
  orderId: string;
  capabilityId: string;
  secret: string;
}): Promise<OrderTrackingCustomerContext | null> {
  if (
    !isPlausibleUuid(input.orderId) ||
    !isPlausibleUuid(input.capabilityId) ||
    !isPlausibleCapabilitySecret(input.secret)
  ) {
    return null;
  }

  let data: ContextRow[] | ContextRow | null;
  let error: { code?: string } | null;
  try {
    ({ data, error } = await supabase.rpc("get_order_tracking_customer_context_by_capability", {
      p_order_id: input.orderId,
      p_capability_id: input.capabilityId,
      p_secret: input.secret,
    }));
  } catch {
    return null;
  }
  if (error) {
    console.error(
      `[tracking-customer-context] get_order_tracking_customer_context_by_capability a échoué (SQLSTATE=${error.code ?? "?"})`
    );
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  if (
    typeof row.bound_order_id !== "string" ||
    row.bound_order_id.toLowerCase() !== input.orderId.toLowerCase()
  ) {
    return null;
  }
  if (typeof row.restaurant_name !== "string") return null;

  return {
    restaurantName: row.restaurant_name,
    publicContact: publicContactOf(row),
  };
}
