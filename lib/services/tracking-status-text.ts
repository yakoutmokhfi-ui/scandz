import { supabase } from "@/lib/supabase";
import {
  sanitizeMerchantStatusTextOverrides,
  type MerchantStatusTextOverrides,
} from "@/lib/tracking/status-text";
import { CANONICAL_ORDER_STATUSES, type OrderStatus } from "@/lib/tracking/status";

/**
 * Scanym — CUSTOMER FOLLOW-UP + TRACKING EMAIL v1.
 *
 * Chemin MARCHAND (dashboard) des surcharges de texte de suivi :
 *   - LECTURE : `select` direct sur `merchant_tracking_status_text`,
 *     protégé par la RLS de la table (membres du tenant uniquement,
 *     aucun accès anon) -- même posture que
 *     `restaurant_sale_mode_field_requirements` (LOT 2A), jamais une RPC
 *     supplémentaire pour une lecture que la RLS sait déjà borner ;
 *   - ÉCRITURE : EXCLUSIVEMENT `set_merchant_tracking_status_text`
 *     (SECURITY DEFINER, owner/manager) -- la table n'accorde aucun
 *     INSERT/UPDATE/DELETE direct, l'écriture RPC-only est donc garantie
 *     par le schéma, pas seulement par convention de code.
 *
 * Ce module ne connaît AUCUN texte : il ne transporte que la
 * configuration. La résolution surcharge/base est faite ailleurs, par
 * l'unique autorité `resolveStatusText` (lib/tracking/status-text.ts).
 *
 * Il n'écrit JAMAIS dans `orders` et n'a aucune notion de transition
 * d'état -- une surcharge est de la configuration d'AFFICHAGE.
 */

interface StatusTextRow {
  status: string;
  body: string | null;
}

/**
 * Surcharges enregistrées pour un établissement, assainies par l'unique
 * autorité (`sanitizeMerchantStatusTextOverrides`) : toute clé non
 * canonique et toute valeur vide/trop longue sont écartées ici comme
 * partout ailleurs. Un établissement sans aucune surcharge renvoie un
 * objet vide -- jamais une exception, jamais `null`.
 */
export async function getMerchantTrackingStatusText(
  restaurantId: string
): Promise<MerchantStatusTextOverrides> {
  const { data, error } = await supabase
    .from("merchant_tracking_status_text")
    .select("status, body")
    .eq("restaurant_id", restaurantId);
  if (error) throw new Error(error.message);

  const raw: Record<string, unknown> = {};
  for (const row of (data ?? []) as StatusTextRow[]) {
    raw[row.status] = row.body;
  }
  return sanitizeMerchantStatusTextOverrides(raw);
}

/**
 * Enregistre (ou efface) la surcharge d'UN statut canonique.
 *
 * Une chaîne vide/blanche est transmise telle quelle : le SQL la traite
 * comme un EFFACEMENT (ligne supprimée, repli sur le texte de base) --
 * un seul état pour « pas de surcharge », jamais une ligne vide
 * persistée. Le statut est validé côté SQL contre les 7 valeurs
 * canoniques ; ce garde-fou client évite seulement un aller-retour.
 */
export async function setMerchantTrackingStatusText(
  restaurantId: string,
  status: OrderStatus,
  body: string
): Promise<void> {
  if (!(CANONICAL_ORDER_STATUSES as readonly string[]).includes(status)) {
    throw new Error("SCANYM_UNKNOWN_ORDER_STATUS");
  }
  const { error } = await supabase.rpc("set_merchant_tracking_status_text", {
    p_restaurant_id: restaurantId,
    p_status: status,
    p_body: body,
  });
  if (error) throw new Error(error.message);
}

/**
 * Enregistre les 7 statuts en une passe (le formulaire du dashboard
 * édite toute la grille d'un coup). Séquentiel DÉLIBÉRÉMENT : le
 * premier refus serveur interrompt la suite, plutôt que de laisser une
 * partie des messages changer pendant qu'une autre échoue silencieusement
 * -- même discipline que le bloc WhatsApp/contact public de la page
 * Réglages.
 */
export async function setAllMerchantTrackingStatusText(
  restaurantId: string,
  bodies: Readonly<Partial<Record<OrderStatus, string>>>
): Promise<void> {
  for (const status of CANONICAL_ORDER_STATUSES) {
    await setMerchantTrackingStatusText(restaurantId, status, bodies[status] ?? "");
  }
}
