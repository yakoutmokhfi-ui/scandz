import "server-only";
import { realSmtpTransport, type SmtpTransport } from "@/lib/server/ack-mailer";
import { decryptMerchantSmtpPassword } from "@/lib/server/merchant-email-provider";
import type { EmailProvider } from "@/lib/server/notifications/email-provider";
import { classifySmtpFailure } from "@/lib/server/notifications/smtp-failure-classification";
import type { NotificationErrorCode } from "@/lib/server/notifications/notification-error-taxonomy";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "merchant_email_provider_config";

export interface MerchantSmtpVaultRow {
  host: string;
  port: number;
  username: string;
  enabled: boolean;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_auth_tag: string | null;
  last_error_class: string | null;
}

export interface MerchantSmtpProviderDeps {
  client?: SupabaseClient;
  transport?: SmtpTransport;
  now?: () => Date;
}

/**
 * Enregistre l'état opérationnel du coffre (classe normalisée uniquement) et,
 * pour un échec d'authentification PERMANENT ou un secret illisible, SUSPEND le
 * fournisseur (`enabled=false`) afin que le claim cesse de le réclamer : plus de
 * rafale d'AUTH échoués, notifications conservées en file (A196-04).
 *
 * L'écriture est CONDITIONNÉE aux identifiants utilisés (hôte, identifiant,
 * chiffré) : si le commerçant a entre-temps enregistré d'autres identifiants,
 * rien n'est modifié. Meilleur effort : une panne de cette écriture ne change
 * jamais le résultat de l'envoi.
 */
export async function recordMerchantSmtpVaultState(
  client: SupabaseClient,
  restaurantId: string,
  used: Pick<MerchantSmtpVaultRow, "host" | "username" | "secret_ciphertext">,
  errorClass: NotificationErrorCode | null,
  suspend: boolean,
  now: Date
): Promise<void> {
  try {
    const patch: Record<string, unknown> = errorClass
      ? { last_error_class: errorClass, last_error_at: now.toISOString() }
      : { last_error_class: null, last_error_at: null };
    if (suspend) patch.enabled = false;
    await client
      .from(TABLE)
      .update(patch)
      .eq("restaurant_id", restaurantId)
      .eq("host", used.host)
      .eq("username", used.username)
      .eq("secret_ciphertext", used.secret_ciphertext);
  } catch {
    // Meilleur effort.
  }
}

/** Résout le compte SMTP du restaurant de CETTE notification seulement. */
export async function resolveMerchantSmtpProvider(
  restaurantId: string,
  deps: MerchantSmtpProviderDeps = {}
): Promise<EmailProvider | null> {
  const client = deps.client ?? getServiceRoleSupabaseClient();
  const transport = deps.transport ?? realSmtpTransport;
  const now = deps.now ?? (() => new Date());

  const { data, error } = await client
    .from(TABLE)
    .select("host,port,username,enabled,secret_ciphertext,secret_iv,secret_auth_tag,last_error_class")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  const row = data as MerchantSmtpVaultRow | null;
  if (error || !row?.enabled || !row.secret_ciphertext || !row.secret_iv || !row.secret_auth_tag) return null;

  let password: string;
  try {
    password = decryptMerchantSmtpPassword(
      { ciphertext: row.secret_ciphertext, iv: row.secret_iv, authTag: row.secret_auth_tag },
      restaurantId
    );
  } catch {
    // Secret illisible (clé remplacée, donnée altérée, chiffré d'un autre établissement) :
    // échec fermé SANS brûler les tentatives de toute la file -- on suspend ce commerce.
    await recordMerchantSmtpVaultState(client, restaurantId, row, "PROVIDER_CONFIGURATION_ERROR", true, now());
    return null;
  }
  const config = { host: row.host, port: row.port, user: row.username, password, from: row.username };

  return {
    name: "merchant_smtp",
    async send(message) {
      const result = await transport.send({
        config: { ...config, from: message.from },
        to: message.to,
        cc: null,
        fromName: message.fromName,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
        messageId: `<${message.idempotencyKey.replace(/[^a-zA-Z0-9.-]/g, "-")}@mail.scanym.com>`,
      });
      if (result.ok) {
        if (row.last_error_class) await recordMerchantSmtpVaultState(client, restaurantId, row, null, false, now());
        return { ok: true, providerMessageId: result.messageId };
      }
      const verdict = classifySmtpFailure(result);
      if (verdict.disableProvider || row.last_error_class !== verdict.errorClass) {
        await recordMerchantSmtpVaultState(client, restaurantId, row, verdict.errorClass, verdict.disableProvider, now());
      }
      return { ok: false, retryable: verdict.retryable, errorClass: verdict.errorClass };
    },
  };
}
