import "server-only";
import { realSmtpTransport } from "@/lib/server/ack-mailer";
import { decryptMerchantSmtpPassword } from "@/lib/server/merchant-email-provider";
import type { EmailProvider } from "@/lib/server/notifications/email-provider";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/** Résout le compte SMTP du restaurant de CETTE notification seulement. */
export async function resolveMerchantSmtpProvider(restaurantId: string): Promise<EmailProvider | null> {
  const { data, error } = await getServiceRoleSupabaseClient()
    .from("merchant_email_provider_config")
    .select("host,port,username,enabled,secret_ciphertext,secret_iv,secret_auth_tag")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (error || !data?.enabled || !data.secret_ciphertext || !data.secret_iv || !data.secret_auth_tag) return null;

  let password: string;
  try {
    password = decryptMerchantSmtpPassword({
      ciphertext: data.secret_ciphertext,
      iv: data.secret_iv,
      authTag: data.secret_auth_tag,
    });
  } catch {
    return null;
  }
  const config = { host: data.host, port: data.port, user: data.username, password, from: data.username };

  return {
    name: "merchant_smtp",
    async send(message) {
      const result = await realSmtpTransport.send({
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
      return result.ok
        ? { ok: true, providerMessageId: result.messageId }
        : { ok: false, retryable: true, errorClass: "SMTP_DELIVERY_FAILED" };
    },
  };
}
