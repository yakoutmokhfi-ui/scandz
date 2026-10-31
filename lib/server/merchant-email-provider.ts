import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CIPHER = "aes-256-gcm";
const RESTAURANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longueur maximale acceptée pour un mot de passe SMTP (borne anti-abus, A196-10). */
export const MERCHANT_SMTP_PASSWORD_MAX_LENGTH = 512;

export interface MerchantEmailProviderConfig {
  restaurantId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function encryptionKey(): Buffer {
  const raw = process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
  if (!raw) throw new Error("MERCHANT_SMTP_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("MERCHANT_SMTP_ENCRYPTION_KEY must be 32 bytes encoded as base64");
  return key;
}

export function isMerchantSmtpEncryptionConfigured(): boolean {
  try { encryptionKey(); return true; } catch { return false; }
}

/**
 * Données authentifiées additionnelles (AAD) LIÉES À L'ÉTABLISSEMENT (A196-07) :
 * un chiffré copié d'un restaurant vers un autre échoue à l'authentification GCM.
 * Format v2 ; aucune donnée v1 n'a jamais été persistée (le lot SQL n'est pas appliqué).
 */
function secretAad(restaurantId: string): Buffer {
  if (!RESTAURANT_ID_PATTERN.test(restaurantId)) throw new Error("SMTP secret requires a valid restaurant id");
  return Buffer.from(`scanym:merchant-smtp:v2:${restaurantId.toLowerCase()}`, "utf8");
}

export function encryptMerchantSmtpPassword(password: string, restaurantId: string): EncryptedSecret {
  if (!password) throw new Error("SMTP password is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
  cipher.setAAD(secretAad(restaurantId));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptMerchantSmtpPassword(secret: EncryptedSecret, restaurantId: string): string {
  const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(secret.iv, "base64"));
  decipher.setAAD(secretAad(restaurantId));
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function validateMerchantSmtpConfig(input: {
  host: unknown;
  port: unknown;
  username: unknown;
  fromEmail: unknown;
}): { host: string; port: 465; username: string; fromEmail: string } {
  const host = typeof input.host === "string" ? input.host.trim().toLowerCase() : "";
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const fromEmail = typeof input.fromEmail === "string" ? input.fromEmail.trim() : "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error("SMTP_HOST_INVALID");
  }
  if (Number(input.port) !== 465) throw new Error("SMTP_TLS_PORT_UNSUPPORTED");
  const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!email.test(username) || !email.test(fromEmail)) throw new Error("SMTP_EMAIL_INVALID");
  return { host, port: 465, username, fromEmail };
}

/**
 * Mot de passe saisi : `null` = non fourni (on conserve le secret stocké),
 * sinon la valeur exacte (jamais rognée). Refuse les valeurs non textuelles
 * et celles qui dépassent la borne.
 */
export function validateMerchantSmtpPassword(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || input.length > MERCHANT_SMTP_PASSWORD_MAX_LENGTH) {
    throw new Error("SMTP_PASSWORD_INVALID");
  }
  return input;
}

/**
 * Identité d'expéditeur : mêmes règles que le RPC `set_merchant_notification_profile`
 * (nom ≤ 120, adresses ≤ 254 avec TLD alphabétique), validées AVANT toute écriture
 * pour qu'un rejet tardif du RPC ne puisse pas laisser le coffre à moitié modifié
 * (A196-06). Les caractères de contrôle sont refusés (en-têtes SMTP).
 */
export function validateMerchantSenderProfile(input: {
  senderName: unknown;
  senderEmail: unknown;
  replyTo: unknown;
  enabled: boolean;
}): { senderName: string; senderEmail: string; replyTo: string | null } {
  const senderName = typeof input.senderName === "string" ? input.senderName.trim() : "";
  const senderEmail = typeof input.senderEmail === "string" ? input.senderEmail.trim() : "";
  const replyToRaw = typeof input.replyTo === "string" ? input.replyTo.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(senderName) || senderName.length > 120) throw new Error("SMTP_SENDER_NAME_INVALID");
  if (input.enabled && senderName.length === 0) throw new Error("SMTP_SENDER_NAME_REQUIRED");
  const address = /^[^@\s<>]+@[^@\s<>]+\.[A-Za-z]{2,}$/;
  if (!address.test(senderEmail) || senderEmail.length > 254) throw new Error("SMTP_EMAIL_INVALID");
  if (replyToRaw && (!address.test(replyToRaw) || replyToRaw.length > 254)) throw new Error("SMTP_EMAIL_INVALID");
  return { senderName, senderEmail, replyTo: replyToRaw || null };
}
