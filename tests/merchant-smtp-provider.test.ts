import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// A196-04/07 -- fournisseur SMTP marchand : classification, suspension
// automatique sur échec d'authentification permanent, mises à jour du
// coffre CONDITIONNELLES aux identifiants utilisés, secret lié à l'établissement.
// Client Supabase et transport injectés (couture `deps`) : aucun réseau, aucun mock de module.
// ====================================================================

process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

const { encryptMerchantSmtpPassword } = await import("../lib/server/merchant-email-provider.ts");
const { resolveMerchantSmtpProvider } = await import("../lib/server/notifications/merchant-smtp-provider.ts");

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "MOT-DE-PASSE-SYNTHETIQUE-Zq7!";
const NOW = new Date("2026-10-31T10:00:00.000Z");

function vaultRow(restaurantId = R1, overrides: Record<string, unknown> = {}) {
  const secret = encryptMerchantSmtpPassword(PASSWORD, restaurantId);
  return {
    host: "smtp.ionos.fr", port: 465, username: "contact@resto.fr", enabled: true,
    secret_ciphertext: secret.ciphertext, secret_iv: secret.iv, secret_auth_tag: secret.authTag,
    last_error_class: null, ...overrides,
  };
}

function fakeClient(row: Record<string, unknown> | null) {
  const updates: Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const client = {
    from(table: string) {
      assert.equal(table, "merchant_email_provider_config");
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        update(patch: Record<string, unknown>) {
          const record = { patch, filters: [] as Array<[string, unknown]> };
          updates.push(record);
          const chain = {
            eq(column: string, value: unknown) { record.filters.push([column, value]); return chain; },
            then(resolve: (v: { error: null }) => void) { resolve({ error: null }); },
          };
          return chain;
        },
      };
    },
  };
  return { client: client as never, updates };
}

function fakeTransport(result: Record<string, unknown>) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    transport: {
      async send(input: Record<string, unknown>) { sent.push(input); return result; },
      async checkConnectivity() { return { ok: true }; },
    } as never,
  };
}

const MESSAGE = {
  to: "client@example.com", from: "contact@resto.fr", fromName: "Resto", replyTo: null,
  subject: "S", html: "<p>h</p>", text: "t", idempotencyKey: "scanym:notification:abc",
};

test("coffre absent, désactivé ou sans secret => aucun fournisseur", async () => {
  for (const row of [null, vaultRow(R1, { enabled: false }), vaultRow(R1, { secret_ciphertext: null })]) {
    const { client } = fakeClient(row);
    assert.equal(await resolveMerchantSmtpProvider(R1, { client, transport: fakeTransport({ ok: true }).transport, now: () => NOW }), null);
  }
});

test("succès : le mot de passe déchiffré est présenté à l'hôte du coffre, nom de fournisseur merchant_smtp", async () => {
  const { client, updates } = fakeClient(vaultRow());
  const t = fakeTransport({ ok: true, messageId: "ABC" });
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: t.transport, now: () => NOW });
  assert.equal(provider?.name, "merchant_smtp");
  assert.deepEqual(await provider!.send(MESSAGE), { ok: true, providerMessageId: "ABC" });
  const call = t.sent[0] as { config: Record<string, unknown>; messageId: string };
  assert.equal(call.config.host, "smtp.ionos.fr");
  assert.equal(call.config.user, "contact@resto.fr");
  assert.equal(call.config.password, PASSWORD);
  assert.match(call.messageId, /^<scanym-notification-abc@mail\.scanym\.com>$/);
  assert.equal(updates.length, 0, "aucune écriture quand rien n'a changé");
});

test("succès après une erreur enregistrée : l'état d'erreur est effacé (écriture conditionnelle)", async () => {
  const row = vaultRow(R1, { last_error_class: "PROVIDER_TIMEOUT" });
  const { client, updates } = fakeClient(row);
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: fakeTransport({ ok: true, messageId: "X" }).transport, now: () => NOW });
  await provider!.send(MESSAGE);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.patch, { last_error_class: null, last_error_at: null });
});

test("A196-04 : AUTH refusé (535) => échec classé, fournisseur SUSPENDU, écriture conditionnelle aux identifiants utilisés", async () => {
  const row = vaultRow();
  const { client, updates } = fakeClient(row);
  const t = fakeTransport({ ok: false, error: "SMTP_UNEXPECTED_RESPONSE: attendu 235, reçu: 535 5.7.8 bad", stage: "auth", status: 535 });
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: t.transport, now: () => NOW });
  const result = await provider!.send(MESSAGE);
  assert.deepEqual(result, { ok: false, retryable: true, errorClass: "PROVIDER_AUTHENTICATION_FAILED" });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.patch, { last_error_class: "PROVIDER_AUTHENTICATION_FAILED", last_error_at: NOW.toISOString(), enabled: false });
  assert.deepEqual(updates[0]!.filters, [
    ["restaurant_id", R1], ["host", "smtp.ionos.fr"], ["username", "contact@resto.fr"], ["secret_ciphertext", row.secret_ciphertext],
  ]);
  assert.equal(JSON.stringify(result).includes("535 5.7.8"), false, "aucun texte serveur dans le résultat");
});

test("échec temporaire (délai) : classé, réessayable, fournisseur NON suspendu", async () => {
  const { client, updates } = fakeClient(vaultRow());
  const t = fakeTransport({ ok: false, error: "SMTP_TIMEOUT", stage: "timeout" });
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: t.transport, now: () => NOW });
  assert.deepEqual(await provider!.send(MESSAGE), { ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" });
  assert.equal(updates.length, 1);
  assert.equal("enabled" in updates[0]!.patch, false);
  assert.equal(updates[0]!.patch.last_error_class, "PROVIDER_TIMEOUT");
});

test("même classe déjà enregistrée : pas de nouvelle écriture (pas de tempête d'UPDATE)", async () => {
  const { client, updates } = fakeClient(vaultRow(R1, { last_error_class: "PROVIDER_TIMEOUT" }));
  const t = fakeTransport({ ok: false, error: "SMTP_TIMEOUT", stage: "timeout" });
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: t.transport, now: () => NOW });
  await provider!.send(MESSAGE);
  await provider!.send(MESSAGE);
  assert.equal(updates.length, 0);
});

test("destinataire refusé (550) : terminal, jamais de suspension du fournisseur", async () => {
  const { client, updates } = fakeClient(vaultRow());
  const t = fakeTransport({ ok: false, error: "SMTP_UNEXPECTED_RESPONSE", stage: "rcpt_to", status: 550 });
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: t.transport, now: () => NOW });
  assert.deepEqual(await provider!.send(MESSAGE), { ok: false, retryable: false, errorClass: "INVALID_RECIPIENT" });
  assert.equal(updates.every((u) => !("enabled" in u.patch)), true);
});

test("A196-07 : chiffré d'un AUTRE établissement => secret illisible, aucun envoi, fournisseur suspendu", async () => {
  const foreign = vaultRow(R2); // chiffré pour R2, lu pour R1
  const { client, updates } = fakeClient(foreign);
  const t = fakeTransport({ ok: true, messageId: "X" });
  const provider = await resolveMerchantSmtpProvider(R1, { client, transport: t.transport, now: () => NOW });
  assert.equal(provider, null);
  assert.equal(t.sent.length, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.patch.enabled, false);
  assert.equal(updates[0]!.patch.last_error_class, "PROVIDER_CONFIGURATION_ERROR");
});
