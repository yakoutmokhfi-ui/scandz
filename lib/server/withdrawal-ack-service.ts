import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  realSmtpTransport,
  sendWithdrawalAcknowledgement,
  type AckDependencies,
  type SendAckOutcome,
} from "@/lib/server/ack-mailer";
import {
  sendWithdrawalAcknowledgementViaMerchantMailer,
  type MerchantAckClaim,
  type MerchantAckDependencies,
} from "@/lib/server/withdrawal-ack-merchant-mailer";
import { resolveMerchantSmtpProvider } from "@/lib/server/notifications/merchant-smtp-provider";
import type { EmailProvider } from "@/lib/server/notifications/email-provider";

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

// ---------------------------------------------------------------------
// Canal « messagerie du commerçant » (DRAFT-lot-withdrawal-ack-merchant-
// mailer-v1.sql). Toutes les lectures/écritures passent par des RPC
// SECURITY DEFINER réservées à service_role.
// ---------------------------------------------------------------------
type RpcClient = Pick<ReturnType<typeof getServiceRoleSupabaseClient>, "rpc">;

/** Interrupteur opérateur (base). Échec fermé : erreur, RPC absente (SQL non appliqué) ou valeur autre que `true` => canal historique. */
export async function isMerchantMailerActivated(client?: RpcClient): Promise<boolean> {
  try {
    const { data, error } = await (client ?? getServiceRoleSupabaseClient()).rpc("scanym_ack_merchant_mailer_enabled");
    return !error && data === true;
  } catch {
    return false;
  }
}

export function createMerchantAckDependencies(deps: {
  client?: RpcClient;
  resolveProvider?: (restaurantId: string) => Promise<EmailProvider | null>;
} = {}): MerchantAckDependencies {
  const client = () => deps.client ?? getServiceRoleSupabaseClient();
  return {
    async claim(withdrawalRequestId) {
      // Aucune reprise de `sending` périmé en v2 : pas de paramètre de péremption (voir le SQL).
      const { data, error } = await client().rpc("claim_withdrawal_acknowledgement_send_v2", {
        p_withdrawal_request_id: withdrawalRequestId,
      });
      if (error) return null;
      const row = (Array.isArray(data) ? data[0] : data) as {
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
        merchant_withdrawal_regime: string | null;
        profile_email_enabled: boolean | null;
        sender_name: string | null;
        sender_email: string | null;
        reply_to: string | null;
      } | null | undefined;
      if (!row || !row.id) return null;
      const claim: MerchantAckClaim = {
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
        profileEmailEnabled: row.profile_email_enabled === true,
        senderName: row.sender_name,
        senderEmail: row.sender_email,
        replyTo: row.reply_to,
      };
      return claim;
    },

    resolveProvider: deps.resolveProvider ?? ((restaurantId) => resolveMerchantSmtpProvider(restaurantId)),

    // Contrat : `true` = écrit ; `false` = la ligne n'était plus `sending` ; une ERREUR réelle de la
    // RPC (ou de l'appel) est PROPAGÉE -- l'orchestrateur la réessaie de façon bornée puis la rapporte
    // (`resultPersisted:false`). Jamais avalée, jamais convertie en « pas persisté » silencieux.
    async recordResult(input) {
      const { data, error } = await client().rpc("record_withdrawal_acknowledgement_result_v2", {
        p_withdrawal_request_id: input.withdrawalRequestId,
        p_ok: input.ok,
        p_to: input.to,
        p_cc: input.cc,
        p_message_id: input.messageId,
        p_content_version: input.contentVersion,
        p_error: input.error,
        p_sender: input.sender,
        p_transport: "merchant_smtp",
      });
      if (error) throw new Error(`RECORD_RPC_FAILED: ${error.message ?? "unknown"}`);
      return data === true;
    },
  };
}

export interface AckDispatchWiring {
  isMerchantMailerActivated(): Promise<boolean>;
  merchant: MerchantAckDependencies;
  legacy: AckDependencies;
}

/**
 * Choix du canal, UNE fois par demande, AVANT toute revendication :
 *   - interrupteur de base fermé (défaut) ou illisible => canal SMTP de la
 *     plateforme, STRICTEMENT inchangé ;
 *   - ouvert => messagerie du commerçant de la demande.
 * Aucun repli d'un canal sur l'autre après revendication : un accusé n'est
 * jamais envoyé sous deux identités.
 */
export async function dispatchWithdrawalAcknowledgement(
  withdrawalRequestId: string,
  lang: "fr" | "en" | "ar",
  wiring: AckDispatchWiring
): Promise<SendAckOutcome> {
  try {
    if (await wiring.isMerchantMailerActivated()) {
      return await sendWithdrawalAcknowledgementViaMerchantMailer(withdrawalRequestId, wiring.merchant, lang);
    }
    return await sendWithdrawalAcknowledgement(withdrawalRequestId, wiring.legacy, lang);
  } catch {
    return { attempted: true, ok: false, error: "ACK_DISPATCH_UNKNOWN_ERROR" };
  }
}

/**
 * Point d'entrée BEST-EFFORT appelé après un `submitWithdrawalRequest`
 * réussi (app/track/[orderId]/withdrawal/route.ts). Ne lève JAMAIS -- une
 * erreur inattendue (réseau, RPC, etc.) est capturée ICI, en dernier
 * ressort, pour garantir que l'envoi de l'accusé ne peut jamais faire
 * échouer une réponse HTTP déjà déterminée par l'enregistrement de la
 * déclaration elle-même. La promesse renvoyée ne rejette jamais.
 */
export function tryDispatchWithdrawalAcknowledgement(
  withdrawalRequestId: string,
  lang: "fr" | "en" | "ar" = "fr"
): Promise<SendAckOutcome> {
  return dispatchWithdrawalAcknowledgement(withdrawalRequestId, lang, {
    isMerchantMailerActivated,
    merchant: createMerchantAckDependencies(),
    legacy: realAckDependencies,
  });
}

export type ReportedAckStatus = "pending" | "unavailable_no_channel" | "sending" | "sent" | "failed" | "unconfirmed";

/**
 * Statut d'accusé à RAPPORTER au client dans la réponse :
 *   - `sent`        : envoi accepté par le serveur SMTP ET résultat écrit en base ;
 *   - `unconfirmed` : envoi accepté mais résultat NON écrit en base (issue ambiguë, jamais présentée comme `sent`) ;
 *   - `failed`      : échec constaté (enregistré ou non) ;
 *   - sinon l'état enregistré à la création.
 */
export function reportedAcknowledgementStatus(recorded: ReportedAckStatus, outcome: SendAckOutcome | null): ReportedAckStatus {
  if (outcome && outcome.attempted) {
    if (!outcome.ok) return "failed";
    return outcome.resultPersisted === false ? "unconfirmed" : "sent";
  }
  return recorded;
}

/** Attend au plus `ms` le résultat de l'envoi ; `null` si trop long (l'envoi continue en arrière-plan). */
export function waitForAckOutcome(promise: Promise<SendAckOutcome>, ms: number): Promise<SendAckOutcome | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}
