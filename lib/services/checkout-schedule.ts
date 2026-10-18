import { supabase } from "@/lib/supabase";
import type { CheckoutScheduleView } from "@/lib/checkout-schedule/model";
import { mapCheckoutScheduleResponse } from "@/lib/checkout-schedule/map-row";

/**
 * CSDJ-2 / issue #158 -- LECTURE PUBLIQUE des dates et créneaux que le
 * SERVEUR propose au checkout : `get_checkout_fulfillment_schedule`
 * (CSDJ-1, appliqué, `EXECUTE` à `anon`/`authenticated`).
 *
 * Signature (contrat CSDJ v1.2, §4.1) :
 *   (p_restaurant_id uuid, p_mode_code text, p_postal_code text,
 *    p_total_count integer, p_subtotal numeric)
 * La fonction n'accepte AUCUNE heure de l'appelant : « maintenant » est
 * l'horloge du serveur, dans le fuseau du commerçant. Ce module ne
 * calcule rien : il ne fait que typer la réponse. FAIL-CLOSED : une
 * réponse vide, sans statut ou au statut hors catalogue n'est PAS
 * « aucune planification » (`absent` est un statut explicite du
 * serveur) : elle est rendue invalide et le parcours ne laisse pas
 * partir la commande.
 */
export async function fetchCheckoutSchedule(params: {
  restaurantId: string;
  modeCode: "pickup" | "delivery";
  postalCode?: string | null;
  totalCount?: number;
  subtotal?: number | null;
}): Promise<CheckoutScheduleView> {
  const { data, error } = await supabase.rpc("get_checkout_fulfillment_schedule", {
    p_restaurant_id: params.restaurantId,
    p_mode_code: params.modeCode,
    p_postal_code: params.postalCode ?? null,
    p_total_count: params.totalCount ?? 0,
    p_subtotal: params.subtotal ?? null,
  });
  if (error) throw new Error(error.message);
  // Fail-closed : voir lib/checkout-schedule/map-row.ts.
  return mapCheckoutScheduleResponse(data);
}
