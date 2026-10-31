import { test } from "node:test";
import assert from "node:assert/strict";

const {
  encryptMerchantSmtpPassword,
  decryptMerchantSmtpPassword,
  validateMerchantSmtpConfig,
  validateMerchantSmtpPassword,
  validateMerchantSenderProfile,
  MERCHANT_SMTP_PASSWORD_MAX_LENGTH,
} = await import("../lib/server/merchant-email-provider.ts");

const RESTAURANT_A = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_B = "22222222-2222-4222-8222-222222222222";

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
    const encrypted = encryptMerchantSmtpPassword(password, RESTAURANT_A);
    assert.notEqual(encrypted.ciphertext, password);
    assert.equal(decryptMerchantSmtpPassword(encrypted, RESTAURANT_A), password);
    assert.throws(() => decryptMerchantSmtpPassword({ ...encrypted, authTag: Buffer.alloc(16).toString("base64") }, RESTAURANT_A));
  });
});

test("A196-07 : le chiffré est LIÉ à l'établissement (AAD) -- copié vers un autre restaurant, il ne se déchiffre pas", () => {
  withEncryptionKey(() => {
    const encrypted = encryptMerchantSmtpPassword("secret-du-restaurant-A", RESTAURANT_A);
    assert.equal(decryptMerchantSmtpPassword(encrypted, RESTAURANT_A), "secret-du-restaurant-A");
    assert.throws(() => decryptMerchantSmtpPassword(encrypted, RESTAURANT_B));
    // La casse de l'UUID ne change pas l'établissement.
    assert.equal(decryptMerchantSmtpPassword(encrypted, RESTAURANT_A.toUpperCase()), "secret-du-restaurant-A");
    // Un identifiant qui n'est pas un UUID n'est jamais accepté comme AAD.
    assert.throws(() => encryptMerchantSmtpPassword("x", "pas-un-uuid"), /valid restaurant id/);
    assert.throws(() => decryptMerchantSmtpPassword(encrypted, ""), /valid restaurant id/);
  });
});

test("A196-07 : deux chiffrements du même mot de passe diffèrent (IV aléatoire)", () => {
  withEncryptionKey(() => {
    const a = encryptMerchantSmtpPassword("même-secret", RESTAURANT_A);
    const b = encryptMerchantSmtpPassword("même-secret", RESTAURANT_A);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });
});

test("clé absente ou de mauvaise taille : chiffrement fermé, sans clé de repli", () => {
  const previous = process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
  try {
    delete process.env.MERCHANT_SMTP_ENCRYPTION_KEY;
    assert.throws(() => encryptMerchantSmtpPassword("secret", RESTAURANT_A), /not configured/);
    process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    assert.throws(() => encryptMerchantSmtpPassword("secret", RESTAURANT_A), /32 bytes/);
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
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "SMTP_HOST_NOT_PUBLIC");
  assert.equal(result.stage, "host_not_public");
});

test("A196-06/10 : mot de passe -- absent = conserver ; au-delà de la borne ou non textuel = refusé", () => {
  assert.equal(validateMerchantSmtpPassword(undefined), null);
  assert.equal(validateMerchantSmtpPassword(null), null);
  assert.equal(validateMerchantSmtpPassword(""), null);
  assert.equal(validateMerchantSmtpPassword("  espaces conservés  "), "  espaces conservés  ");
  assert.equal(validateMerchantSmtpPassword("x".repeat(MERCHANT_SMTP_PASSWORD_MAX_LENGTH)), "x".repeat(MERCHANT_SMTP_PASSWORD_MAX_LENGTH));
  assert.throws(() => validateMerchantSmtpPassword("x".repeat(MERCHANT_SMTP_PASSWORD_MAX_LENGTH + 1)), /SMTP_PASSWORD_INVALID/);
  assert.throws(() => validateMerchantSmtpPassword(12345), /SMTP_PASSWORD_INVALID/);
  assert.throws(() => validateMerchantSmtpPassword({ toString: () => "x" }), /SMTP_PASSWORD_INVALID/);
});

test("A196-06 : l'identité d'expéditeur est validée côté route avec les règles du RPC N1-A (avant toute écriture)", () => {
  const ok = validateMerchantSenderProfile({ senderName: "  Au Lait Cru ", senderEmail: " contact@aulaitcru.com ", replyTo: "", enabled: true });
  assert.deepEqual(ok, { senderName: "Au Lait Cru", senderEmail: "contact@aulaitcru.com", replyTo: null });
  assert.equal(validateMerchantSenderProfile({ senderName: "A", senderEmail: "a@b.fr", replyTo: "r@b.fr", enabled: true }).replyTo, "r@b.fr");
  // Nom vide : refusé seulement si l'envoi est activé (règle du RPC).
  assert.throws(() => validateMerchantSenderProfile({ senderName: "", senderEmail: "a@b.fr", replyTo: "", enabled: true }), /SMTP_SENDER_NAME_REQUIRED/);
  assert.equal(validateMerchantSenderProfile({ senderName: "", senderEmail: "a@b.fr", replyTo: "", enabled: false }).senderName, "");
  assert.throws(() => validateMerchantSenderProfile({ senderName: "x".repeat(121), senderEmail: "a@b.fr", replyTo: "", enabled: true }), /SMTP_SENDER_NAME_INVALID/);
  assert.throws(() => validateMerchantSenderProfile({ senderName: "Nom\r\nBcc: x@y.fr", senderEmail: "a@b.fr", replyTo: "", enabled: true }), /SMTP_SENDER_NAME_INVALID/);
  for (const bad of ["pas-un-mail", "a@b", "a@b.c", "a b@c.fr", "a@b.fr>", "<a@b.fr", `${"x".repeat(250)}@b.fr`]) {
    assert.throws(() => validateMerchantSenderProfile({ senderName: "N", senderEmail: bad, replyTo: "", enabled: true }), /SMTP_EMAIL_INVALID/, bad);
  }
  assert.throws(() => validateMerchantSenderProfile({ senderName: "N", senderEmail: "a@b.fr", replyTo: "invalide", enabled: true }), /SMTP_EMAIL_INVALID/);
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
