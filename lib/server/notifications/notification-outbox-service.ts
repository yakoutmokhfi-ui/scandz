import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * N1-A — CUSTOMER EMAIL NOTIFICATION FOUNDATION + ORDER RECEIVED.
 *
 * Enveloppe TYPÉE des 4 RPC `notification_outbox`
 * (create_order_received_notification / claim_pending_notifications /
 * complete_notification_attempt / reap_stale_notification_claims) --
 * calquée délibérément sur
 * `lib/server/delivery-providers/stuart/provider-events.ts` (même
 * discipline : AUCUNE erreur Postgrest brute ne traverse ce module,
 * AUCUN secret/jeton de suivi n'est jamais loggé ou renvoyé au-delà de
 * ce qui est déjà exposé par les colonnes SQL elles-mêmes).
 *
 * `create_order_received_notification` est normalement appelée à
 * l'INTÉRIEUR de `create_order` (même transaction SQL) -- ce module
 * l'expose aussi en TypeScript uniquement pour les tests/rejeu
 * défensif (garde anti-substitution tenant croisée), jamais comme
 * chemin de production pour la création d'événement.
 */

export class NotificationOutboxError extends Error {
  constructor(message: string = "NOTIFICATION_OUTBOX_ERROR") {
    super(message);
    this.name = "NotificationOutboxError";
  }
}

/**
 * Rejoue `create_order_received_notification` directement -- réservé
 * aux tests (idempotence, garde anti-substitution tenant croisée). Le
 * chemin de production réel passe TOUJOURS par `create_order`
 * lui-même (même transaction).
 */
export async function createOrderReceivedNotification(input: {
  orderId: string;
  restaurantId: string;
}): Promise<string | null> {
  const client = getServiceRoleSupabaseClient();
  let data: string | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("create_order_received_notification", {
      p_order_id: input.orderId,
      p_restaurant_id: input.restaurantId,
    }));
  } catch {
    throw new NotificationOutboxError("NOTIFICATION_OUTBOX_CREATE_UNAVAILABLE");
  }
  if (error) {
    throw new NotificationOutboxError(`NOTIFICATION_OUTBOX_CREATE_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  return data ?? null;
}

export interface ClaimedNotification {
  outboxId: string;
  restaurantId: string;
  orderId: string;
  notificationType: string;
  recipientEmail: string | null;
  locale: string;
  payloadSnapshot: Record<string, unknown>;
  attemptCount: number;
  claimToken: string;
  senderName: string | null;
  senderEmail: string | null;
  replyTo: string | null;
}

/**
 * Revendique un lot BORNÉ de notifications éligibles
 * (`pending`/`failed_retryable`, échéance atteinte) via
 * `claim_pending_notifications` -- `FOR UPDATE SKIP LOCKED` +  bail
 * côté SQL, sûr sous concurrence. L'identité d'expéditeur
 * (`senderName`/`senderEmail`/`replyTo`) est résolue FRAÎCHE par la
 * fonction SQL elle-même, à partir du `restaurant_id` de CHAQUE ligne
 * -- jamais un paramètre fourni ici.
 */
export async function claimPendingNotifications(input: {
  batchSize?: number;
  leaseSeconds?: number;
} = {}): Promise<ClaimedNotification[]> {
  const client = getServiceRoleSupabaseClient();
  let data:
    | Array<{
        outbox_id: string; restaurant_id: string; order_id: string; notification_type: string;
        recipient_email: string | null; locale: string; payload_snapshot: Record<string, unknown>;
        attempt_count: number; claim_token: string;
        sender_name: string | null; sender_email: string | null; reply_to: string | null;
      }>
    | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("claim_pending_notifications", {
      p_batch_size: input.batchSize ?? 10,
      p_lease_seconds: input.leaseSeconds ?? 60,
    }));
  } catch {
    throw new NotificationOutboxError("NOTIFICATION_OUTBOX_CLAIM_UNAVAILABLE");
  }
  if (error) {
    throw new NotificationOutboxError(`NOTIFICATION_OUTBOX_CLAIM_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  return (data ?? []).map((row) => ({
    outboxId: row.outbox_id,
    restaurantId: row.restaurant_id,
    orderId: row.order_id,
    notificationType: row.notification_type,
    recipientEmail: row.recipient_email,
    locale: row.locale,
    payloadSnapshot: row.payload_snapshot,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    replyTo: row.reply_to,
  }));
}

/** Valeurs EXACTES acceptées par `p_result`. */
export type NotificationAttemptResult = "success" | "retryable_failure" | "terminal_failure" | "skipped";

export interface CompleteNotificationAttemptInput {
  outboxId: string;
  claimToken: string;
  attemptNumber: number;
  provider: string;
  result: NotificationAttemptResult;
  /** Identifiant de message renvoyé par le prestataire -- jamais un
   *  secret, uniquement un identifiant opaque de corrélation. */
  providerMessageId?: string | null;
  /** Classification NORMALISÉE uniquement -- jamais un message brut de
   *  prestataire, jamais un jeton de suivi (mandat, littéral). */
  errorClass?: string | null;
}

/**
 * Finalise une tentative (succès/échec) via `complete_notification_attempt`
 * -- seule autorité de transition d'état, barème de reprise appliqué
 * côté SQL (30s/120s/600s/1800s, 5 tentatives max). Un jeton de
 * réclamation invalide/périmé est rejeté fail-closed par la fonction
 * SQL elle-même (protège contre une double complétion concurrente).
 */
export async function completeNotificationAttempt(
  input: CompleteNotificationAttemptInput
): Promise<void> {
  const client = getServiceRoleSupabaseClient();
  let error: { code?: string; message: string } | null;
  try {
    ({ error } = await client.rpc("complete_notification_attempt", {
      p_outbox_id: input.outboxId,
      p_claim_token: input.claimToken,
      p_attempt_number: input.attemptNumber,
      p_provider: input.provider,
      p_result: input.result,
      p_provider_message_id: input.providerMessageId ?? null,
      p_error_class: input.errorClass ?? null,
    }));
  } catch {
    throw new NotificationOutboxError("NOTIFICATION_OUTBOX_COMPLETE_UNAVAILABLE");
  }
  if (error) {
    throw new NotificationOutboxError(`NOTIFICATION_OUTBOX_COMPLETE_FAILED_${error.code ?? "UNKNOWN"}`);
  }
}

/**
 * Balayage de récupération après crash worker (bail dépassé) via
 * `reap_stale_notification_claims`. Renvoie le nombre de lignes
 * récupérées (remises `pending`).
 */
export async function reapStaleNotificationClaims(input: { batchSize?: number } = {}): Promise<number> {
  const client = getServiceRoleSupabaseClient();
  let data: number | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("reap_stale_notification_claims", {
      p_batch_size: input.batchSize ?? 100,
    }));
  } catch {
    throw new NotificationOutboxError("NOTIFICATION_OUTBOX_REAP_UNAVAILABLE");
  }
  if (error) {
    throw new NotificationOutboxError(`NOTIFICATION_OUTBOX_REAP_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  return data ?? 0;
}
