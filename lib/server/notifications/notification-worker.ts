import "server-only";
import type { Lang } from "@/lib/i18n";
import { buildNotificationIdempotencyKey, type EmailProvider } from "@/lib/server/notifications/email-provider";
import { renderOrderReceivedEmail } from "@/lib/server/notifications/order-received-template";
import {
  claimPendingNotifications,
  completeNotificationAttempt,
} from "@/lib/server/notifications/notification-outbox-service";
import { normalizeNotificationErrorCode } from "@/lib/server/notifications/notification-error-taxonomy";

/**
 * N1-A — NOTIFICATION WORKER / PROCESSING MODEL.
 *
 * `NotificationService -> EmailProvider` (mandat, littéral). Traite un
 * lot BORNÉ de notifications réclamées (`claimPendingNotifications`,
 * `FOR UPDATE SKIP LOCKED` + bail côté SQL) : rend le gabarit
 * ORDER_RECEIVED, appelle le provider injecté, puis finalise via
 * `completeNotificationAttempt` (barème de reprise appliqué côté SQL).
 *
 * AUCUNE AUTORITÉ MÉTIER (mandat §"NO BUSINESS COUPLING") : ce module
 * ne lit ni n'écrit jamais `orders.status`/paiement/Stuart/facture/
 * suivi/fulfillment -- pur observateur d'un événement déjà créé.
 *
 * Provider INJECTÉ (jamais résolu par ce module lui-même) -- ce lot
 * n'autorise que `FakeEmailProvider` (voir fake-email-provider.ts) ;
 * un futur lot pourrait résoudre un provider réel derrière
 * `real-email-activation-gate.ts`, mais ce choix reste À L'APPELANT,
 * jamais implicite ici.
 */

export interface ProcessPendingNotificationsResult {
  claimed: number;
  sent: number;
  retriedRetryable: number;
  failedTerminal: number;
}

interface OrderReceivedPayloadSnapshot {
  order_number: number;
  total: number;
  currency: string;
  service_mode: string;
  public_token: string;
  created_at: string;
}

function isOrderReceivedPayload(value: unknown): value is OrderReceivedPayloadSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.order_number !== "undefined" &&
    typeof v.total !== "undefined" &&
    typeof v.currency === "string" &&
    typeof v.service_mode === "string" &&
    typeof v.public_token === "string"
  );
}

export async function processPendingNotifications(
  provider: EmailProvider,
  options: { batchSize?: number; leaseSeconds?: number } = {}
): Promise<ProcessPendingNotificationsResult> {
  const claimed = await claimPendingNotifications(options);

  let sent = 0;
  let retriedRetryable = 0;
  let failedTerminal = 0;

  for (const notification of claimed) {
    const attemptNumber = notification.attemptCount + 1;

    // Identité d'expéditeur non résolue (profil supprimé/désactivé
    // entre la création et le traitement, ou payload corrompu) --
    // classification défensive, jamais un envoi avec une valeur
    // devinée, jamais un crash du worker entier pour une seule ligne
    // (mandat §"WORKER / PROCESSING MODEL", "explicit terminal failure
    // state").
    if (!notification.senderEmail || !notification.senderName) {
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: "terminal_failure",
        errorClass: normalizeNotificationErrorCode("SENDER_IDENTITY_UNRESOLVED"),
      });
      failedTerminal += 1;
      continue;
    }

    if (!notification.recipientEmail) {
      // Ne devrait structurellement jamais se produire (une ligne sans
      // e-mail destinataire reste 'skipped_no_email' dès sa création,
      // donc jamais réclamée -- voir create_order_received_notification)
      // -- garde défensive uniquement.
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: "terminal_failure",
        errorClass: normalizeNotificationErrorCode("RECIPIENT_EMAIL_MISSING"),
      });
      failedTerminal += 1;
      continue;
    }

    if (!isOrderReceivedPayload(notification.payloadSnapshot)) {
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: "terminal_failure",
        errorClass: normalizeNotificationErrorCode("PAYLOAD_SNAPSHOT_MALFORMED"),
      });
      failedTerminal += 1;
      continue;
    }

    const payload = notification.payloadSnapshot;
    const rendered = renderOrderReceivedEmail({
      locale: notification.locale as Lang,
      merchantSenderName: notification.senderName,
      orderNumber: Number(payload.order_number),
      total: Number(payload.total),
      currency: payload.currency,
      serviceMode: payload.service_mode,
      orderId: notification.orderId,
      publicToken: payload.public_token,
    });

    // v1.2 — N1A-IDEMPOTENCY-KEY-CONTRACT-01 : clé d'idempotence
    // STABLE, dérivée UNIQUEMENT de outboxId (l'identité de
    // l'événement logique) -- jamais de attemptNumber/claimToken, qui
    // varient entre tentatives et casseraient la stabilité exigée par
    // le mandat. Deux appels provider.send() pour LE MÊME
    // notification.outboxId (ex. après un échec réessayable, ou après
    // une récupération de bail périmé) reçoivent donc TOUJOURS la
    // même clé -- c'est ce qui permet à un futur provider réel de
    // déduplicquer côté serveur si le worker envoie deux fois sous une
    // fenêtre de crash résiduelle (mandat, §10 README-AUDIT.md).
    const idempotencyKey = buildNotificationIdempotencyKey(notification.outboxId);

    const result = await provider.send({
      to: notification.recipientEmail,
      from: notification.senderEmail,
      replyTo: notification.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey,
    });

    if (result.ok) {
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: "success",
        providerMessageId: result.providerMessageId,
      });
      sent += 1;
    } else {
      // v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 : le provider n'est
      // PAS une autorité de confiance quant au contenu de errorClass
      // (un provider réel futur pourrait renvoyer un message brut, un
      // en-tête HTTP verbeux, voire accidentellement un jeton). Cette
      // frontière normalise TOUJOURS avant persistance -- seule une
      // valeur membre de la taxonomie fermée traverse, tout le reste
      // devient UNKNOWN_PROVIDER_ERROR sans jamais conserver la chaîne
      // d'origine (mandat, littéral : "Arbitrary provider-supplied
      // error strings must NEVER cross the trusted normalization
      // boundary into persisted diagnostic fields").
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: result.retryable ? "retryable_failure" : "terminal_failure",
        errorClass: normalizeNotificationErrorCode(result.errorClass),
      });
      if (result.retryable) {
        retriedRetryable += 1;
      } else {
        failedTerminal += 1;
      }
    }
  }

  return { claimed: claimed.length, sent, retriedRetryable, failedTerminal };
}
