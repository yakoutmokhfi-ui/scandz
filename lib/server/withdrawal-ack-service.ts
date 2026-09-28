import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  realSmtpTransport,
  sendWithdrawalAcknowledgement,
  type AckDependencies,
  type SendAckOutcome,
} from "@/lib/server/ack-mailer";

/**
 * SCANYM — GAP-01 — branchement service_role de `sendWithdrawalAcknowledgement`
 * (lib/server/ack-mailer.ts, orchestration PURE, dépendances injectées).
 *
 * Ce module est la SEULE implémentation réelle des dépendances
 * (claim/recordResult), toutes via le client `service_role` (jamais
 * anon/authenticated) -- les deux RPC (`claim_withdrawal_
 * acknowledgement_send`, `record_withdrawal_acknowledgement_result`)
 * sont, par construction SQL (DRAFT-lot-gap-01-ack-transport-v1.sql,
 * section D), refusées à tout autre rôle.
 */
const realAckDependencies: AckDependencies = {
  transport: realSmtpTransport,

  // claim_withdrawal_acknowledgement_send renvoie, dans le MÊME appel
  // SECURITY DEFINER, l'identité/contact marchand (jointure interne
  // restaurants + merchant_legal_profile) : service_role n'a par
  // ailleurs AUCUN privilège de table direct sur ces deux tables
  // (revocations explicites de leurs migrations respectives) -- une
  // lecture séparée via .from(...) échouerait donc en production.
  async claim(withdrawalRequestId) {
    const client = getServiceRoleSupabaseClient();
    const { data, error } = await client
      .rpc("claim_withdrawal_acknowledgement_send", {
        p_withdrawal_request_id: withdrawalRequestId,
        p_stale_after_seconds: 120,
      })
      .single();

    if (error || !data) return null;
    const row = data as {
      id: string | null;
      restaurant_id: string;
      order_id: string;
      acknowledgement_address: string;
      customer_first_name: string;
      customer_last_name: string;
      declaration_snapshot: unknown;
      merchant_name: string | null;
      merchant_contact_email: string | null;
      merchant_contact_phone: string | null;
      // GAP-01 remédiation (issue #11) -- merchant_cgv_profile.withdrawal_regime,
      // ajouté par DRAFT-lot-gap-01-mandatory-merchant-email-v1.sql.
      merchant_withdrawal_regime: string | null;
    };
    // Un claim refusé (déjà en cours ailleurs / déjà terminé) renvoie
    // une ligne entièrement NULL depuis le LEFT JOIN sur une CTE vide
    // -- jamais une exception -- donc id est explicitement vérifié ici.
    if (!row.id) return null;

    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      orderId: row.order_id,
      acknowledgementAddress: row.acknowledgement_address,
      customerFirstName: row.customer_first_name,
      customerLastName: row.customer_last_name,
      declarationSnapshot: row.declaration_snapshot,
      merchantName: row.merchant_name ?? "",
      merchantContactEmail: row.merchant_contact_email,
      merchantContactPhone: row.merchant_contact_phone,
      merchantWithdrawalRegime: row.merchant_withdrawal_regime,
    };
  },

  async recordResult(input) {
    const client = getServiceRoleSupabaseClient();
    await client.rpc("record_withdrawal_acknowledgement_result", {
      p_withdrawal_request_id: input.withdrawalRequestId,
      p_ok: input.ok,
      p_to: input.to,
      p_cc: input.cc,
      p_message_id: input.messageId,
      p_content_version: input.contentVersion,
      p_error: input.error,
    });
  },
};

/**
 * Point d'entrée BEST-EFFORT appelé après un `submitWithdrawalRequest`
 * réussi (app/api/track/withdrawal/route.ts). Ne lève JAMAIS -- une
 * erreur inattendue (réseau, RPC, etc.) est capturée ICI, en dernier
 * ressort, pour garantir que l'envoi de l'accusé ne peut jamais faire
 * échouer une réponse HTTP déjà déterminée par l'enregistrement de la
 * déclaration elle-même.
 */
export async function tryDispatchWithdrawalAcknowledgement(
  withdrawalRequestId: string,
  lang: "fr" | "en" | "ar" = "fr"
): Promise<SendAckOutcome> {
  try {
    return await sendWithdrawalAcknowledgement(withdrawalRequestId, realAckDependencies, lang);
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      error: err instanceof Error ? err.message : "ACK_DISPATCH_UNKNOWN_ERROR",
    };
  }
}
