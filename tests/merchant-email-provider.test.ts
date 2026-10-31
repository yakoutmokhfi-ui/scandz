import { test } from "node:test";
import assert from "node:assert/strict";

const {
  encryptMerchantSmtpPassword,
  decryptMerchantSmtpPassword,
  validateMerchantSmtpConfig,
} = await import("../lib/server/merchant-email-provider.ts");

function withEncryptionKey<T>(fn: () => T): T {
  const previous = process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
  process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
    else process.env.MERCHANT_SMTP_ENCRYPTION_KEY = previous;
  }
}

test("mot de passe marchand chiffré AES-GCM, jamais stocké en clair, déchiffrable avec la clé active", () => {
  withEncryptionKey(() => {
    const password = "une phrase secrète SMTP";
    const encrypted = encryptMerchantSmtpPassword(password);
    assert.notEqual(encrypted.ciphertext, password);
    assert.equal(decryptMerchantSmtpPassword(encrypted), password);
    assert.throws(() => decryptMerchantSmtpPassword({ ...encrypted, authTag: Buffer.alloc(16).toString("base64") }));
  });
});

test("clé absente ou de mauvaise taille : chiffrement fermé, sans clé de repli", () => {
  const previous = process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
  try {
    delete process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
    assert.throws(() => encryptMerchantSmtpPassword("secret"), /not configured/);
    process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    assert.throws(() => encryptMerchantSmtpPassword("secret"), /32 bytes/);
  } finally {
    if (previous === undefined) delete process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
    else process.env.MERCHANT_SMTP_ENCRYPTION_KEY = previous;
  }
});

test("configuration SMTP accepte le port TLS direct 465 et refuse hôtes non DNS, IP et autres ports", () => {
  assert.deepEqual(validateMerchantSmtpConfig({ host: "SMTP.IONOS.FR", port: "465", username: "contact@aulaitcru.com", fromEmail: "contact@aulaitcru.com" }), {
    host: "smtp.ionos.fr", port: 465, username: "contact@aulaitcru.com", fromEmail: "contact@aulaitcru.com",
  });
  assert.throws(() => validateMerchantSmtpConfig({ host: "127.0.0.1", port: 465, username: "a@b.fr", fromEmail: "a@b.fr" }), /HOST_INVALID/);
  assert.throws(() => validateMerchantSmtpConfig({ host: "smtp.example.com", port: 587, username: "a@b.fr", fromEmail: "a@b.fr" }), /PORT_UNSUPPORTED/);
  assert.throws(() => validateMerchantSmtpConfig({ host: "smtp.example.com", port: 465, username: "bad", fromEmail: "a@b.fr" }), /EMAIL_INVALID/);
});

test("transport SMTP refuse localhost avant d'ouvrir un socket (protection contre SSRF)", async () => {
  const { realSmtpTransport } = await import("../lib/server/ack-mailer.ts");
  const result = await realSmtpTransport.checkConnectivity({
    host: "localhost", port: 465, user: "merchant@example.test", password: "never-log-this", from: "merchant@example.test",
  });
  assert.deepEqual(result, { ok: false, error: "SMTP_HOST_NOT_PUBLIC" });
});

test("le transport conserve le nom expéditeur marchand et rejette les injections d'en-tête", async () => {
  const { buildSmtpMimeMessage } = await import("../lib/server/ack-mailer.ts");
  const message = buildSmtpMimeMessage({
    config: { host: "smtp.ionos.fr", port: 465, user: "orders@example.fr", password: "secret", from: "orders@example.fr" },
    to: "customer@example.fr", cc: null, fromName: "Au Lait Cru", subject: "Commande reçue",
    text: "Suivi", html: "<p>Suivi</p>",
  });
  const encodedName = Buffer.from("Au Lait Cru", "utf8").toString("base64");
  assert.match(message, new RegExp(`From: =\\?UTF-8\\?B\\?${encodedName}\\?= <orders@example\\.fr>`));
  assert.throws(() => buildSmtpMimeMessage({
    config: { host: "smtp.ionos.fr", port: 465, user: "orders@example.fr", password: "secret", from: "orders@example.fr" },
    to: "customer@example.fr", cc: null, fromName: "Au Lait Cru\r\nBcc: attacker@example.fr", subject: "Order",
    text: "Body", html: "<p>Body</p>",
  }), /INVALID_FROM-NAME_HEADER/);
});
