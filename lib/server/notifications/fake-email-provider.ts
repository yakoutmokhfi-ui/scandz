import "server-only";
import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/server/notifications/email-provider";

/**
 * N1-A — FAKE/TEST EMAIL PROVIDER.
 *
 * SEUL provider autorisé par ce lot (mandat, littéral : "DO NOT
 * integrate a real external provider in N1-A. No Resend/Postmark/
 * SendGrid/etc production credential is authorized in this lot.").
 *
 * Enregistre chaque message envoyé (recipient/sender/subject/rendered
 * body/tracking link/idempotency key/nombre de tentatives sont tous
 * dérivables de `sent` ci-dessous) pour que les tests puissent
 * asserter dessus directement, sans double d'aucune sorte -- même
 * discipline d'injection que `tests/v166-stuart-lot-d2-live-
 * activation-gate.test.ts` (fonction injectée, jamais un mock de
 * module global).
 *
 * Comportement configurable par test (mandat §"FAKE PROVIDER TESTS",
 * scénarios 4/5) : `behavior` optionnel, appelé pour chaque envoi --
 * par défaut, toujours un succès déterministe.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  readonly sent: EmailMessage[] = [];
  private callCount = 0;
  private readonly behavior?: (message: EmailMessage, attempt: number) => EmailSendResult;

  // Paramètre de constructeur explicite (pas une "parameter property"
  // TypeScript) -- `node --experimental-strip-types` (strip-only mode,
  // utilisé par tests/register.mjs) ne supporte PAS les parameter
  // properties (`constructor(private readonly x)`), même si `tsc`
  // les accepte -- voir tsconfig.json/tests/register.mjs.
  constructor(behavior?: (message: EmailMessage, attempt: number) => EmailSendResult) {
    this.behavior = behavior;
  }

  get callCountForAssertions(): number {
    return this.callCount;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.callCount += 1;
    this.sent.push(message);
    if (this.behavior) {
      return this.behavior(message, this.callCount);
    }
    return { ok: true, providerMessageId: `fake-msg-${this.callCount}` };
  }
}
