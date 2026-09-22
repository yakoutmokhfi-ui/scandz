import "server-only";
import { supabase } from "@/lib/supabase";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";
import {
  sanitizeMerchantStatusTextOverrides,
  type MerchantStatusTextOverrides,
} from "@/lib/tracking/status-text";

/**
 * Scanym — CUSTOMER FOLLOW-UP + TRACKING EMAIL v1.
 *
 * Lecture CLIENT des surcharges de texte de statut, par la RPC
 * `get_order_tracking_status_text_by_capability` — MÊME preuve de
 * capacité v3.1 que `get_order_tracking_by_capability` (prédicat SQL
 * copié, jamais affaibli — voir
 * supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql). Calqué
 * sur lib/server/tracking-customer-context.ts (CCLT v1), même posture,
 * même discipline de journalisation.
 *
 * ÉCHEC FERMÉ ET SILENCIEUX : toute entrée implausible, erreur RPC, ou
 * ligne liée à une AUTRE commande renvoie un objet VIDE — la page de
 * suivi affiche alors les textes de base, qui sont toujours corrects.
 * Une surcharge n'est donc jamais une condition de disponibilité du
 * suivi.
 *
 * ISOLATION TENANT : chaque ligne renvoyée doit porter le
 * `bound_order_id` EXACT demandé ; une seule ligne incohérente fait
 * rejeter l'ENSEMBLE de la réponse (jamais un mélange partiel).
 *
 * Le secret de capacité et l'identifiant de commande ne sont jamais
 * journalisés.
 */

interface StatusTextRow {
  bound_order_id: string | null;
  status: string | null;
  body: string | null;
}

export async function getOrderTrackingStatusTextOverrides(input: {
  orderId: string;
  capabilityId: string;
  secret: string;
}): Promise<MerchantStatusTextOverrides> {
  if (
    !isPlausibleUuid(input.orderId) ||
    !isPlausibleUuid(input.capabilityId) ||
    !isPlausibleCapabilitySecret(input.secret)
  ) {
    return {};
  }

  let data: StatusTextRow[] | StatusTextRow | null;
  let error: { code?: string } | null;
  try {
    ({ data, error } = await supabase.rpc("get_order_tracking_status_text_by_capability", {
      p_order_id: input.orderId,
      p_capability_id: input.capabilityId,
      p_secret: input.secret,
    }));
  } catch {
    return {};
  }
  if (error) {
    console.error(
      `[tracking-status-text] get_order_tracking_status_text_by_capability a échoué (SQLSTATE=${error.code ?? "?"})`
    );
    return {};
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    if (
      typeof row.bound_order_id !== "string" ||
      row.bound_order_id.toLowerCase() !== input.orderId.toLowerCase()
    ) {
      // Une seule ligne non liée à CETTE commande invalide toute la
      // réponse -- jamais un affichage partiellement issu d'un autre
      // tenant.
      return {};
    }
    if (typeof row.status !== "string") return {};
    raw[row.status] = row.body;
  }

  // L'assainissement (clés canoniques uniquement, vide/trop long ->
  // repli base) reste fait par l'UNIQUE autorité partagée.
  return sanitizeMerchantStatusTextOverrides(raw);
}
