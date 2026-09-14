import "server-only";

/**
 * N1-A — CUSTOMER EMAIL NOTIFICATION FOUNDATION + ORDER RECEIVED.
 *
 * Abstraction d'ENVOI e-mail -- `NotificationService -> EmailProvider`
 * (mandat, littéral). Ce lot n'implémente et n'autorise QU'un provider
 * Fake/Test (voir fake-email-provider.ts). Aucun provider réel
 * (Resend/Postmark/SendGrid/etc.) n'est intégré ici -- un futur lot
 * introduira une implémentation réelle DERRIÈRE cette même interface,
 * gardée par real-email-activation-gate.ts.
 */

export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  /**
   * v1.2 — N1A-IDEMPOTENCY-KEY-CONTRACT-01. Clé d'idempotence STABLE
   * côté frontière prestataire, identifiant l'ÉVÉNEMENT DE
   * NOTIFICATION LOGIQUE -- jamais une tentative individuelle. Ne
   * varie JAMAIS entre deux tentatives du même événement (mandat,
   * littéral : "It must NOT vary per retry"). Toujours construite via
   * `buildNotificationIdempotencyKey` ci-dessous, jamais dérivée de
   * attempt_number/claim_token/horodatage. Un futur provider réel doit
   * transmettre cette même clé à son propre mécanisme d'idempotence
   * (ex. en-tête HTTP Idempotency-Key) -- non implémenté dans ce lot.
   */
  idempotencyKey: string;
}

export type EmailSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; errorClass: string };

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * v1.2 — N1A-IDEMPOTENCY-KEY-CONTRACT-01. Dérive la clé d'idempotence
 * STABLE d'un événement de notification à partir de la SEULE autorité
 * stable et unique disponible : `notification_outbox.id` (identité de
 * la ligne, fixée à la création, jamais réattribuée). Forme :
 * `scanym:notification:<outbox_id>` -- déterministe, ne dépend
 * d'aucune valeur qui change entre tentatives (attempt_number,
 * claim_token, horodatage de la tentative en cours sont TOUS exclus
 * par construction : cette fonction ne reçoit que `outboxId`).
 */
export function buildNotificationIdempotencyKey(outboxId: string): string {
  return `scanym:notification:${outboxId}`;
}
