import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";

/**
 * RETURN TRACKING CAPABILITY v1 (issue #172).
 *
 * Émet, côté serveur, une capacité de suivi RÉUTILISABLE pour la page de
 * retour de paiement (`issue_order_return_tracking_capability`,
 * supabase/DRAFT-lot-return-tracking-capability-v1.sql), du même type que
 * celle des e-mails de commande : le lien `#c1.<id>.<secret>` reste valable
 * sur un autre navigateur ou un autre appareil, contrairement au lien
 * legacy dont l'échange est à usage unique.
 *
 * Compteur DISTINCT de celui des e-mails (kind = 'return') : la page de
 * retour ne peut jamais épuiser le plafond dont dépend l'e-mail de
 * confirmation.
 *
 * ÉCHEC DOUX : cette capacité est un confort d'affichage, jamais une
 * autorité de paiement. Toute indisponibilité (SQL non encore appliqué,
 * panne, plafond atteint, forme inattendue) renvoie `null` et l'appelant
 * retombe sur le lien legacy -- jamais d'exception, jamais de détail
 * d'erreur renvoyé, jamais de secret journalisé.
 */
export interface ReturnTrackingCapability {
  capabilityId: string;
  secret: string;
}

export async function issueOrderReturnTrackingCapability(
  orderId: string
): Promise<ReturnTrackingCapability | null> {
  try {
    const client = getServiceRoleSupabaseClient();
    const { data, error } = await client.rpc("issue_order_return_tracking_capability", {
      p_order_id: orderId,
    });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    const { capability_id: capabilityId, capability_secret: secret } = row as {
      capability_id: unknown;
      capability_secret: unknown;
    };
    if (!isPlausibleUuid(capabilityId) || !isPlausibleCapabilitySecret(secret)) return null;
    return { capabilityId, secret };
  } catch {
    return null;
  }
}
