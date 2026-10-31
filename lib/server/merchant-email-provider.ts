import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CIPHER = "aes-256-gcm";

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

export function encryptMerchantSmtpPassword(password: string): EncryptedSecret {
  if (!password) throw new Error("SMTP password is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
  cipher.setAAD(Buffer.from("scanym:merchant-smtp:v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptMerchantSmtpPassword(secret: EncryptedSecret): string {
  const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(secret.iv, "base64"));
  decipher.setAAD(Buffer.from("scanym:merchant-smtp:v1", "utf8"));
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
