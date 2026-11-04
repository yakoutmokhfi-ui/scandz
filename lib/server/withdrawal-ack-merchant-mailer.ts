import "server-only";
import {
  ACK_EMAIL_CONTENT_VERSION,
  APPLICABLE_WITHDRAWAL_REGIMES,
  MERCHANT_EMAIL_MISSING_FOR_APPLICABLE_REGIME_ERROR,
  buildAckEmailContent,
  type SendAckOutcome,
} from "@/lib/server/ack-mailer";
import type { EmailProvider } from "@/lib/server/notifications/email-provider";
import { normalizeNotificationErrorCode } from "@/lib/server/notifications/notification-error-taxonomy";

/**
 * SCANYM — ACCUSÉ DE RÉTRACTATION PAR LA MESSAGERIE DU COMMERÇANT (PR Draft).
 *
 * Remplace, QUAND L'OPÉRATEUR L'A ACTIVÉ en base (voir
 * supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql), le canal SMTP
 * unique de la plateforme (SMTP_* / retractation@scanym.com, lib/server/
 * ack-mailer.ts) par la messagerie que CHAQUE commerçant a configurée dans
 * l'onglet E-mails (coffre `merchant_email_provider_config` + identité
 * `merchant_notification_profile`). Le canal historique reste intact et reste
 * celui utilisé tant que l'interrupteur de base est fermé (défaut).
 *
 * ORCHESTRATION PURE : aucune E/S ici. Les dépendances (claim, fournisseur,
 * enregistrement) sont injectées -- les tests n'ouvrent jamais de socket et
 * n'envoient jamais d'e-mail réel.
 *
 * ISOLATION ENTRE COMMERÇANTS : l'identifiant d'établissement vient
 * EXCLUSIVEMENT de la ligne revendiquée (`claim.restaurantId`, lue en base),
 * jamais d'un paramètre de l'appelant. Le fournisseur (coffre + secret
 * chiffré lié à l'établissement), l'expéditeur, le Reply-To et la copie en
 * sont tous dérivés : aucune valeur d'un autre commerçant ne peut être
 * utilisée pour cette demande.
 *
 * STATUT FIDÈLE : `sent` n'est enregistré que si le serveur SMTP a accepté le
 * message pour TOUS ses destinataires (client + copie). Tout autre résultat est
 * enregistré `failed` avec une classe d'erreur d'un ensemble FERMÉ (jamais un
 * texte du serveur). La demande de rétractation, elle, est déjà enregistrée en
 * base et n'est jamais touchée par un échec d'envoi.
 *
 * AUCUN RENVOI AUTOMATIQUE : une demande `failed` ou `unavailable_no_channel`
 * n'est jamais revendiquée par cette voie (le claim ne prend que `pending`, ou
 * `sending` périmé). Le traitement des demandes historiques est une décision
 * séparée (voir docs/withdrawal-ack-merchant-mailer-v1.md).
 */

/** Codes propres à ce chemin (ensemble fermé), en plus de la taxonomie des fournisseurs. */
export const ACK_MERCHANT_ERROR_CODES = [
  "MERCHANT_MAILER_UNAVAILABLE",
  "MERCHANT_MAILER_SENDER_UNRESOLVED",
  "ACK_RECIPIENT_ADDRESS_INVALID",
  "ACK_DISPATCH_UNKNOWN_ERROR",
  MERCHANT_EMAIL_MISSING_FOR_APPLICABLE_REGIME_ERROR,
] as const;
type AckMerchantErrorCode = (typeof ACK_MERCHANT_ERROR_CODES)[number];
const OWN_CODES: ReadonlySet<string> = new Set(ACK_MERCHANT_ERROR_CODES);

/** Adresse utilisable telle quelle dans une commande SMTP : pas d'espace, de chevron ni de caractère de contrôle. */
const SMTP_ADDRESS = /^[^\s@<>"',;:\\()[\]\u0000-\u001f\u007f]+@[^\s@<>"',;:\\()[\]\u0000-\u001f\u007f]+\.[A-Za-z]{2,}$/;
export function isSafeSmtpAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && SMTP_ADDRESS.test(value);
}

/**
 * Destinataire de la COPIE : le contact service client du profil légal du
 * commerçant (`merchant_legal_profile.customer_service_email`), c'est-à-dire
 * l'adresse que ses CGV montrent déjà au client -- une seule source, jamais une
 * valeur codée en dur pour un commerçant. `null` si absente, invalide, ou
 * identique à l'adresse du client (pas de doublon dans le même message).
 */
export function resolveAckCopyRecipient(
  merchantContactEmail: string | null | undefined,
  customerAddress: string
): string | null {
  const candidate = typeof merchantContactEmail === "string" ? merchantContactEmail.trim() : "";
  if (!isSafeSmtpAddress(candidate)) return null;
  if (candidate.toLowerCase() === customerAddress.trim().toLowerCase()) return null;
  return candidate;
}

export interface MerchantAckClaim {
  id: string;
  /** Lu en base avec la demande : seule source de l'établissement concerné. */
  restaurantId: string;
  orderId: string;
  acknowledgementAddress: string;
  customerFirstName: string;
  customerLastName: string;
  declarationSnapshot: unknown;
  merchantName: string;
  merchantContactEmail: string | null;
  merchantContactPhone: string | null;
  merchantWithdrawalRegime: string | null;
  /** merchant_notification_profile de CET établissement. */
  profileEmailEnabled: boolean;
  senderName: string | null;
  senderEmail: string | null;
  replyTo: string | null;
}

export interface MerchantAckRecord {
  withdrawalRequestId: string;
  ok: boolean;
  to: string;
  cc: string | null;
  messageId: string | null;
  contentVersion: string;
  error: string | null;
  /** Adresse d'expéditeur réellement utilisée (preuve) ; null si aucun envoi tenté. */
  sender: string | null;
}

export interface MerchantAckDependencies {
  /** Revendication atomique (`sending`), ou null si la ligne n'est pas revendicable. */
  claim(withdrawalRequestId: string): Promise<MerchantAckClaim | null>;
  /** Fournisseur de CET établissement (coffre déchiffré), ou null s'il n'est pas utilisable. */
  resolveProvider(restaurantId: string): Promise<EmailProvider | null>;
  /** Enregistre le résultat réel ; `false` si la ligne n'était plus `sending` (revendication perdue). */
  recordResult(input: MerchantAckRecord): Promise<boolean>;
}

/** Clé d'idempotence STABLE par demande -- identique à chaque tentative (jamais un compteur ni une date). */
export function buildWithdrawalAckIdempotencyKey(withdrawalRequestId: string): string {
  return `scanym:withdrawal-ack:${withdrawalRequestId}`;
}

function normalizeError(raw: string): string {
  return OWN_CODES.has(raw) ? raw : normalizeNotificationErrorCode(raw);
}

export async function sendWithdrawalAcknowledgementViaMerchantMailer(
  withdrawalRequestId: string,
  deps: MerchantAckDependencies,
  lang: "fr" | "en" | "ar" = "fr"
): Promise<SendAckOutcome> {
  const claimed = await deps.claim(withdrawalRequestId);
  if (!claimed) return { attempted: false, reason: "already_claimed_elsewhere" };

  const to = claimed.acknowledgementAddress.trim();
  const fail = async (code: AckMerchantErrorCode | string, sender: string | null, cc: string | null): Promise<SendAckOutcome> => {
    const error = normalizeError(code);
    await deps.recordResult({
      withdrawalRequestId,
      ok: false,
      to: claimed.acknowledgementAddress,
      cc,
      messageId: null,
      contentVersion: ACK_EMAIL_CONTENT_VERSION,
      error,
      sender,
    });
    return { attempted: true, ok: false, error };
  };

  // 1. Adresse du client : validée STRICTEMENT avant toute commande SMTP.
  if (!isSafeSmtpAddress(to)) return fail("ACK_RECIPIENT_ADDRESS_INVALID", null, null);

  // 2. Copie au commerçant. Garde héritée du canal historique (CIO, issue #11) :
  //    sous un régime où l'accusé est exigé, l'absence de contact marchand est un
  //    ÉCHEC EXPLICITE, jamais un envoi silencieux sans copie.
  const cc = resolveAckCopyRecipient(claimed.merchantContactEmail, to);
  if (
    cc === null &&
    claimed.merchantContactEmail === null &&
    claimed.merchantWithdrawalRegime !== null &&
    APPLICABLE_WITHDRAWAL_REGIMES.has(claimed.merchantWithdrawalRegime)
  ) {
    return fail(MERCHANT_EMAIL_MISSING_FOR_APPLICABLE_REGIME_ERROR, null, null);
  }

  // 3. Identité d'expéditeur de CET établissement (profil activé + nom + adresse valides).
  const senderEmail = claimed.senderEmail?.trim() ?? "";
  const senderName = claimed.senderName?.trim() ?? "";
  if (!claimed.profileEmailEnabled || !isSafeSmtpAddress(senderEmail) || senderName.length === 0) {
    return fail("MERCHANT_MAILER_SENDER_UNRESOLVED", null, cc);
  }
  const replyTo = isSafeSmtpAddress(claimed.replyTo?.trim()) ? claimed.replyTo!.trim() : null;

  // 4. Messagerie de CET établissement (coffre actif, secret lisible).
  let provider: EmailProvider | null;
  try {
    provider = await deps.resolveProvider(claimed.restaurantId);
  } catch {
    provider = null;
  }
  if (!provider) return fail("MERCHANT_MAILER_UNAVAILABLE", senderEmail, cc);

  const snapshot = claimed.declarationSnapshot as {
    order_number?: number;
    lines?: Array<{ item_name: string; option_name: string | null; quantity: number }>;
    declared_at?: string;
  } | null;
  const content = buildAckEmailContent({
    lang,
    orderNumber: snapshot?.order_number ?? 0,
    requestedAt: snapshot?.declared_at ?? new Date().toISOString(),
    customerFirstName: claimed.customerFirstName,
    customerLastName: claimed.customerLastName,
    lines: (snapshot?.lines ?? []).map((l) => ({ itemName: l.item_name, optionName: l.option_name, quantity: l.quantity })),
    merchantName: claimed.merchantName,
    merchantContactEmail: claimed.merchantContactEmail,
    merchantContactPhone: claimed.merchantContactPhone,
  });

  // Une exception du fournisseur ne doit JAMAIS laisser la demande à `sending` :
  // elle devient un échec enregistré, d'une classe fermée.
  let result: Awaited<ReturnType<EmailProvider["send"]>>;
  try {
    result = await provider.send({
      to,
      cc,
      from: senderEmail,
      fromName: senderName,
      replyTo,
      subject: content.subject,
      text: content.text,
      html: content.html,
      idempotencyKey: buildWithdrawalAckIdempotencyKey(withdrawalRequestId),
    });
  } catch {
    return fail("ACK_DISPATCH_UNKNOWN_ERROR", senderEmail, cc);
  }

  if (result.ok) {
    await deps.recordResult({
      withdrawalRequestId,
      ok: true,
      to,
      cc,
      messageId: result.providerMessageId,
      contentVersion: ACK_EMAIL_CONTENT_VERSION,
      error: null,
      sender: senderEmail,
    });
    return { attempted: true, ok: true, messageId: result.providerMessageId };
  }
  return fail(result.errorClass, senderEmail, cc);
}
