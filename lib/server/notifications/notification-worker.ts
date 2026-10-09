import "server-only";
import { translate, type Lang } from "@/lib/i18n";
import { isCanonicalOrderStatus } from "@/lib/tracking/status";
import {
  normalizeMerchantStatusText,
  resolveStatusText,
} from "@/lib/tracking/status-text";
import { buildNotificationIdempotencyKey, type EmailProvider } from "@/lib/server/notifications/email-provider";
import { renderOrderReceivedEmail } from "@/lib/server/notifications/order-received-template";
import {
  claimPendingNotifications,
  completeNotificationAttempt,
  issueOrderEmailTrackingCapability,
  type EmailTrackingCapability,
} from "@/lib/server/notifications/notification-outbox-service";
import { normalizeNotificationErrorCode } from "@/lib/server/notifications/notification-error-taxonomy";
import { isCommunicationEventCode } from "@/lib/communications/events";
import { renderCommunicationEventEmail } from "@/lib/server/notifications/communication-event-template";
import { buildCommunicationTemplateValues } from "@/lib/server/notifications/communication-template-values";
import { renderCommunicationTemplate } from "@/lib/communications/template-variables";
import { buildCapabilityTrackingPath } from "@/lib/tracking/link";
import { resolveCanonicalPublicOrigin } from "@/lib/server/canonical-public-origin";
import type { RenderedEmail } from "@/lib/server/notifications/order-received-template";

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
 * Seule exception (CUSTOMER TRACKING v3.1) : l'émission, par tentative,
 * d'une capacité de suivi e-mail liée à la commande
 * (`issueOrderEmailTrackingCapability`), lecture seule pour le client.
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
  /**
   * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — quatre clés ADDITIVES du
   * snapshot (create_order_received_notification). Toutes OPTIONNELLES
   * ici DÉLIBÉRÉMENT : une ligne outbox enfilée AVANT ce lot ne les
   * porte pas, et doit continuer d'être rendue sans échec ni reprise
   * inutile -- le repli est alors le texte de base et l'omission propre
   * de la ligne d'adresse (jamais une valeur inventée).
   */
  order_status?: unknown;
  status_text_override?: unknown;
  delivery_address?: unknown;
  merchant_name?: unknown;
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

    // LOT 04, étendu par MERCHANT CUSTOMER COMMUNICATIONS v1 — les
    // types RENDABLES sont désormais `order_received` ET les trois
    // événements de communication. Les 8 placeholders SQL restants
    // (order_accepted, order_ready, refund_issued, …) demeurent SANS
    // émission active : ils tombent toujours en état terminal explicite,
    // sans émission de capacité de suivi et sans boucle de reprise --
    // comportement INCHANGÉ pour eux.
    //
    // Ce n'est pas un second worker : l'aiguillage choisit un GABARIT,
    // puis le même bloc d'envoi, la même clé d'idempotence et la même
    // finalisation s'appliquent plus bas.
    const isCommunicationEvent = isCommunicationEventCode(notification.notificationType);
    const isOrderReceived = notification.notificationType === "order_received";
    if (!isOrderReceived && !isCommunicationEvent) {
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: "terminal_failure",
        errorClass: normalizeNotificationErrorCode("TEMPLATE_RENDER_ERROR"),
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

    // CUSTOMER TRACKING v3.1 — lien de suivi RÉUTILISABLE : une
    // capacité liée à la commande est émise à CHAQUE tentative
    // (seul son sha256 est stocké côté SQL ; le secret ne vit qu'en
    // mémoire, le temps du rendu). Jamais le public_token legacy du
    // payload_snapshot, qui ne donnerait qu'un échange one-shot. Une
    // tentative antérieure éventuellement livrée garde sa propre
    // capacité, jamais invalidée par celle-ci.
    //
    // MERCHANT CUSTOMER COMMUNICATIONS v1 — l'émission de capacité reste
    // RÉSERVÉE à `order_received`, dont le gabarit porte le lien de
    // suivi et ne doit jamais partir sans lui. Les trois événements
    // additionnels n'en exigent PAS : faire dépendre un e-mail « remise
    // au transporteur » de l'émission d'un lien de suivi le rendrait
    // indélivrable pour une raison étrangère à son objet. Ils ne
    // consomment donc aucune capacité et n'en font échouer aucune.
    let trackingCapability: EmailTrackingCapability | null = null;
    if (isOrderReceived) {
      try {
        trackingCapability = await issueOrderEmailTrackingCapability(notification.orderId);
      } catch {
        // Panne transitoire : jamais d'envoi sans lien valide.
        await completeNotificationAttempt({
          outboxId: notification.outboxId,
          claimToken: notification.claimToken,
          attemptNumber,
          provider: provider.name,
          result: "retryable_failure",
          errorClass: normalizeNotificationErrorCode("TEMPLATE_RENDER_ERROR"),
        });
        retriedRetryable += 1;
        continue;
      }
      if (!trackingCapability) {
        // Commande introuvable ou plafond de capacités atteint : état
        // terminal explicite, jamais un e-mail sans lien de suivi.
        await completeNotificationAttempt({
          outboxId: notification.outboxId,
          claimToken: notification.claimToken,
          attemptNumber,
          provider: provider.name,
          result: "terminal_failure",
          errorClass: normalizeNotificationErrorCode("TEMPLATE_RENDER_ERROR"),
        });
        failedTerminal += 1;
        continue;
      }
    }

    const payload = notification.payloadSnapshot;
    const locale = notification.locale as Lang;

    // MERCHANT CUSTOMER COMMUNICATIONS v1 — surcharges marchandes.
    //
    // Les gabarits sont LUS DANS L'INSTANTANÉ (figés à l'enfilement), et
    // substitués ici par l'UNIQUE autorité partagée avec le back-office
    // (`renderCommunicationTemplate`) : un jeton hors liste blanche --
    // seulement possible pour une ligne écrite avant un resserrement de
    // cette liste -- disparaît sans faire échouer l'envoi et sans jamais
    // être recraché au client (MCC-V1-UNKNOWN-VARIABLE-RULE, moitié
    // RENDU). Absentes : les textes PLATEFORME s'appliquent, inchangés.
    const merchantTrackingUrl = trackingCapability
      ? `${resolveCanonicalPublicOrigin()}${buildCapabilityTrackingPath(
          notification.orderId,
          trackingCapability.capabilityId,
          trackingCapability.secret
        )}`
      : null;
    const templateValues = buildCommunicationTemplateValues({
      locale,
      payload: payload as Readonly<Record<string, unknown>>,
      withdrawalLink: merchantTrackingUrl,
    });
    //
    // ─── v1.1 — CARTOGRAPHIE ÉVÉNEMENT -> GABARIT, APPLIQUÉE ICI ───
    // Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 (audit indépendant
    // OpenAI/Codex, blocker 2).
    //
    // v1 lisait `subject_template`/`body_template` pour TOUS les types,
    // de sorte qu'un e-mail « demande de rétractation enregistrée »
    // empruntait la formulation de l'e-mail de CONFIRMATION DE COMMANDE,
    // tandis que la formulation d'accusé de rétractation du commerçant,
    // pourtant figée dans l'instantané, n'était JAMAIS lue.
    //
    // Deux domaines désormais, et aucun pont entre eux :
    //
    //   order_received                 -> `subject_template` (sujet) et
    //                                     `body_template` (corps), les
    //                                     deux clés nommées pour lui ;
    //   les 3 événements additionnels  -> `event_body_template`, le
    //                                     gabarit que
    //                                     communication_event_body_text_key()
    //                                     a désigné À L'ENFILEMENT pour
    //                                     CET événement ; sujet
    //                                     PLATEFORME (aucune clé de sujet
    //                                     propre à l'événement n'existe
    //                                     au catalogue, et ce lot n'en
    //                                     invente pas).
    //
    // Un instantané enfilé par la version v1 porte `body_template` /
    // `withdrawal_template` et pas `event_body_template` : pour un
    // événement additionnel, il est alors traité comme SANS surcharge et
    // rend la formulation plateforme. C'est délibéré -- retomber sur
    // `body_template` serait précisément l'emprunt silencieux que ce
    // correctif ferme.
    const snapshot = payload as Record<string, unknown>;
    const templateField = (key: string): string | null =>
      typeof snapshot[key] === "string" ? (snapshot[key] as string) : null;

    const merchantSubject = isCommunicationEvent
      ? ""
      : renderCommunicationTemplate(templateField("subject_template"), templateValues);
    const merchantBody = renderCommunicationTemplate(
      isCommunicationEvent
        ? templateField("event_body_template")
        : templateField("body_template"),
      templateValues
    );

    // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — texte de statut résolu
    // par l'UNIQUE autorité partagée avec la page de suivi
    // (`resolveStatusText`) : surcharge marchande FIGÉE dans le snapshot
    // au moment de l'enfilement, sinon texte de base i18n. Le worker ne
    // fait ici AUCUNE lecture métier supplémentaire (mandat §"NO
    // BUSINESS COUPLING") : tout vient du snapshot déterministe.
    //
    // Statut absent ou non canonique (ligne antérieure à ce lot, ou
    // donnée corrompue) : repli sur `new`, le seul statut qu'un
    // événement ORDER_RECEIVED puisse avoir eu à sa création -- jamais
    // un statut inventé, jamais un e-mail sans explication.
    const snapshotStatus = isCanonicalOrderStatus(payload.order_status)
      ? payload.order_status
      : "new";
    const { text: statusText } = resolveStatusText(
      snapshotStatus,
      { [snapshotStatus]: normalizeMerchantStatusText(payload.status_text_override as string) },
      (key) => translate(locale, key)
    );

    // Valeurs partagées par les deux gabarits -- calculées UNE fois.
    const merchantName =
      typeof payload.merchant_name === "string" && payload.merchant_name.trim() !== ""
        ? payload.merchant_name
        : notification.senderName;
    const deliveryAddress =
      typeof payload.delivery_address === "string" && payload.delivery_address.trim() !== ""
        ? payload.delivery_address
        : null;

    // MERCHANT CUSTOMER COMMUNICATIONS v1 — AIGUILLAGE DE GABARIT, et
    // rien d'autre : le bloc d'envoi, la clé d'idempotence et la
    // finalisation ci-dessous sont les MÊMES pour les deux branches.
    let rendered: RenderedEmail;
    if (isCommunicationEventCode(notification.notificationType)) {
      rendered = renderCommunicationEventEmail({
        event: notification.notificationType,
        locale,
        merchantSenderName: notification.senderName,
        merchantName,
        orderNumber: Number(payload.order_number),
        total: Number(payload.total),
        currency: payload.currency,
        deliveryAddress,
        carrierName: templateValues.carrier_name ?? null,
        merchantSubject,
        merchantBody,
      });
    } else if (trackingCapability) {
      rendered = renderOrderReceivedEmail({
        locale,
        merchantSenderName: notification.senderName,
        // Nom du commerçant issu du snapshot ; repli sur l'identité
        // d'expédition déjà résolue plutôt qu'une chaîne vide.
        merchantName,
        orderNumber: Number(payload.order_number),
        total: Number(payload.total),
        currency: payload.currency,
        serviceMode: payload.service_mode,
        statusText,
        deliveryAddress,
        orderId: notification.orderId,
        trackingCapabilityId: trackingCapability.capabilityId,
        trackingSecret: trackingCapability.secret,
        merchantSubject,
        merchantBody,
      });
    } else {
      // INATTEIGNABLE : la branche order_received a déjà échoué plus
      // haut si la capacité manque. Garde défensive -- jamais un envoi
      // sans gabarit, jamais un `!` d'assertion de type qui ferait
      // disparaître la question à la compilation.
      await completeNotificationAttempt({
        outboxId: notification.outboxId,
        claimToken: notification.claimToken,
        attemptNumber,
        provider: provider.name,
        result: "terminal_failure",
        errorClass: normalizeNotificationErrorCode("TEMPLATE_RENDER_ERROR"),
      });
      failedTerminal += 1;
      continue;
    }

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

export type RunTransactionalEmailWorkerResult =
  | { status: "provider_disabled" }
  | ({ status: "processed" } & ProcessPendingNotificationsResult);

/**
 * LOT 04 — point d'entrée FAIL-CLOSED du chemin transactionnel réel.
 * Provider désactivé (`null`, cas unique aujourd'hui -- voir
 * email-provider-resolution.ts) : AUCUNE réclamation (les lignes
 * restent `pending`, aucune tentative consommée), AUCUNE capacité de
 * suivi émise, AUCUN appel réseau.
 */
export async function runTransactionalEmailWorker(
  provider: EmailProvider | null,
  options: { batchSize?: number; leaseSeconds?: number } = {}
): Promise<RunTransactionalEmailWorkerResult> {
  if (!provider) return { status: "provider_disabled" };
  return { status: "processed", ...(await processPendingNotifications(provider, options)) };
}
