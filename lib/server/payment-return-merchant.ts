import "server-only";
import { getOrderPaymentContext } from "@/lib/server/payment-service";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import { publicMenuUrlForSlug } from "@/lib/public-menu-url";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

/** Navigation uniquement : le marchand vient de la commande vérifiée par
 * sa preuve de possession, jamais d'un slug/returnUrl fourni par le navigateur. */
export async function getPaymentReturnMerchantPath(input: {
  orderId: string;
  publicToken: string;
}): Promise<string | null> {
  if (!isPlausibleUuid(input.orderId) || !isPlausibleUuid(input.publicToken)) return null;
  try {
    const { restaurantId } = await getOrderPaymentContext(input);
    if (!isPlausibleUuid(restaurantId)) return null;
    const { data, error } = await getServiceRoleSupabaseClient()
      .from("restaurants").select("slug").eq("id", restaurantId).single();
    if (error || !data || typeof data.slug !== "string") return null;
    return publicMenuUrlForSlug(data.slug);
  } catch {
    // Une panne de navigation ne change jamais le résultat du paiement.
    return null;
  }
}
