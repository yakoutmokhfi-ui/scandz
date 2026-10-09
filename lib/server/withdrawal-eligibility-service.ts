import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — PREUVE D'ÉLIGIBILITÉ À
 * LA RÉTRACTATION pour l'écran de confirmation.
 *
 * ──────────────────────────────────────────────────────────────────────
 * CE MODULE NE DÉCIDE RIEN (mandat, littéral : « Do NOT alter withdrawal
 * eligibility rules in this lot »).
 *
 * Il appelle `public.order_has_withdrawal_eligible_line(order_id,
 * public_token)`, qui LIT l'instantané existant
 * `order_items.withdrawal_eligible_at_order_time` — lui-même posé par le
 * déclencheur `snapshot_order_item_withdrawal_eligibility()` d'ONLINE
 * WITHDRAWAL FOUNDATION v1. Aucune règle n'est recalculée, aucune n'est
 * réécrite, aucune ligne n'est modifiée.
 * ──────────────────────────────────────────────────────────────────────
 *
 * FERMÉ AU REPOS. La fonction ne renvoie `true` que sur une réponse
 * explicitement positive du serveur. Jeton erroné, commande inconnue,
 * panne RPC, forme de réponse inattendue : `false`. L'absence de preuve
 * ne vaut pas preuve, et un appel à l'action de rétractation affiché par
 * erreur serait une promesse juridique fausse faite au client d'un
 * commerçant.
 *
 * NE DISTINGUE PAS observablement « jeton incorrect » de « commande
 * inexistante » de « panne » — même posture que
 * lib/server/invoice-request-service.ts : une preuve de possession ne
 * doit jamais être sondable.
 */

export interface WithdrawalEligibilityInput {
  readonly orderId: string;
  readonly publicToken: string;
}

export async function orderHasWithdrawalEligibleLine(
  input: WithdrawalEligibilityInput
): Promise<boolean> {
  const supabase = getServiceRoleSupabaseClient();
  const { data, error } = await supabase.rpc("order_has_withdrawal_eligible_line", {
    p_order_id: input.orderId,
    p_public_token: input.publicToken,
  });
  if (error) return false;
  // `=== true` et non une coercition : une réponse `"true"`, `1` ou un
  // objet ne vaut PAS une preuve.
  return data === true;
}
