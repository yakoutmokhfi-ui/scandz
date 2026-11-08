import "server-only";
import { getOrderPaymentContext } from "@/lib/server/payment-service";
import { getPublicSupabaseClient } from "@/lib/server/supabase-public";
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
    // service_role peut exécuter la RPC de possession sans avoir SELECT sur
    // restaurants. Le slug publié se lit avec anon, comme la vitrine, sous RLS.
    const { data, error } = await getPublicSupabaseClient()
      .from("restaurants").select("slug").eq("id", restaurantId).single();
    if (error || !data || typeof data.slug !== "string") return null;
    return publicMenuUrlForSlug(data.slug);
  } catch {
    // Une panne de navigation ne change jamais le résultat du paiement.
    return null;
  }
}
