import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Accusé de rétractation par la messagerie du COMMERÇANT.
// Aucun réseau, aucun e-mail réel : fournisseur, client Supabase et transport
// SMTP sont des doubles injectés. Les adresses sont des adresses de test
// (example.*), jamais celles d'un vrai commerçant.
// ====================================================================

process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const mailer = await import("../lib/server/withdrawal-ack-merchant-mailer.ts");
const service = await import("../lib/server/withdrawal-ack-service.ts");
const { encryptMerchantSmtpPassword } = await import("../lib/server/merchant-email-provider.ts");
const { resolveMerchantSmtpProvider } = await import("../lib/server/notifications/merchant-smtp-provider.ts");
const { ACK_EMAIL_CONTENT_VERSION } = await import("../lib/server/ack-mailer.ts");

const {
  ACK_MERCHANT_ERROR_CODES,
  isSafeSmtpAddress,
  resolveAckCopyRecipient,
  buildWithdrawalAckIdempotencyKey,
  sendWithdrawalAcknowledgementViaMerchantMailer,
} = mailer;
const {
  isMerchantMailerActivated,
  createMerchantAckDependencies,
  dispatchWithdrawalAcknowledgement,
  reportedAcknowledgementStatus,
  waitForAckOutcome,
} = service;

const RA = "11111111-1111-4111-8111-111111111111";
const RB = "22222222-2222-4222-8222-222222222222";
const WID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function claimFor(restaurantId: string, overrides: Record<string, unknown> = {}) {
  const tag = restaurantId === RA ? "a" : "b";
  return {
    id: WID,
    restaurantId,
    orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    acknowledgementAddress: "client@example.test",
    customerFirstName: "Camille",
    customerLastName: "Test",
    declarationSnapshot: {
      order_number: 42,
      declared_at: "2026-11-01T10:00:00.000Z",
      lines: [{ item_name: "Fromage", option_name: null, quantity: 1 }],
    },
    merchantName: `Boutique ${tag.toUpperCase()}`,
    merchantContactEmail: `contact-${tag}@boutique-${tag}.example.test`,
    merchantContactPhone: null,
    merchantWithdrawalRegime: "STANDARD_14_DAYS",
    profileEmailEnabled: true,
    senderName: `Boutique ${tag.toUpperCase()}`,
    senderEmail: `commandes-${tag}@boutique-${tag}.example.test`,
    replyTo: `contact-${tag}@boutique-${tag}.example.test`,
    ...overrides,
  };
}

type SendInput = Record<string, unknown>;
function fakeProvider(result: unknown = { ok: true, providerMessageId: "<mid-1@mail.scanym.com>" }, throws = false) {
  const sent: SendInput[] = [];
  return {
    sent,
    provider: {
      name: "merchant_smtp",
      async send(message: SendInput) {
        sent.push(message);
        if (throws) throw new Error("socket hang up smtp.secret-host.example:465 password=hunter2");
        return result;
      },
    } as never,
  };
}

function harness(opts: {
  claim?: unknown;
  provider?: unknown;
  providerThrows?: boolean;
  recordOk?: boolean;
}) {
  const recorded: Array<Record<string, unknown>> = [];
  const resolvedFor: string[] = [];
  const deps = {
    async claim(id: string) {
      assert.equal(id, WID);
      return (opts.claim ?? null) as never;
    },
    async resolveProvider(restaurantId: string) {
      resolvedFor.push(restaurantId);
      if (opts.providerThrows) throw new Error("vault exploded");
      return (opts.provider ?? null) as never;
    },
    async recordResult(input: never) {
      recorded.push(input as Record<string, unknown>);
      return opts.recordOk ?? true;
    },
  };
  return { deps, recorded, resolvedFor };
}

// --------------------------------------------------------------------
// A. Adresses
// --------------------------------------------------------------------
test("isSafeSmtpAddress : refuse CR/LF, espaces, chevrons, guillemets et caractères de contrôle (injection de commande SMTP)", () => {
  assert.equal(isSafeSmtpAddress("client@example.test"), true);
  for (const bad of [
    "client@example.test\r\nRCPT TO:<x@y.z>",
    "client@example.test\nBcc: x@y.z",
    "cli ent@example.test",
    "<client@example.test>",
    "\"client\"@example.test",
    "client@example.test>\r\nDATA",
    "a@b",
    "",
    "client@@example.test",
    "client@example.test\u0000",
    "a,b@example.test",
  ]) {
    assert.equal(isSafeSmtpAddress(bad), false, JSON.stringify(bad));
  }
  assert.equal(isSafeSmtpAddress(undefined), false);
  assert.equal(isSafeSmtpAddress(42), false);
  assert.equal(isSafeSmtpAddress(`${"a".repeat(250)}@example.test`), false);
});

test("resolveAckCopyRecipient : adresse du profil légal ; absente, invalide ou identique au client => null (jamais de doublon)", () => {
  assert.equal(resolveAckCopyRecipient("  contact@boutique.example.test ", "client@example.test"), "contact@boutique.example.test");
  assert.equal(resolveAckCopyRecipient(null, "client@example.test"), null);
  assert.equal(resolveAckCopyRecipient("", "client@example.test"), null);
  assert.equal(resolveAckCopyRecipient("pas une adresse", "client@example.test"), null);
  assert.equal(resolveAckCopyRecipient("x@y.test\r\nBcc: z@y.test", "client@example.test"), null);
  assert.equal(resolveAckCopyRecipient("Client@Example.test", "client@example.test"), null);
});

test("clé d'idempotence stable par demande, identique à chaque tentative", () => {
  assert.equal(buildWithdrawalAckIdempotencyKey(WID), `scanym:withdrawal-ack:${WID}`);
  assert.equal(buildWithdrawalAckIdempotencyKey(WID), buildWithdrawalAckIdempotencyKey(WID));
});

// --------------------------------------------------------------------
// B. Orchestration
// --------------------------------------------------------------------
test("succès : un seul message, À = client, Cc = contact du profil légal, expéditeur = profil du commerçant, preuve enregistrée", async () => {
  const { provider, sent } = fakeProvider();
  const h = harness({ claim: claimFor(RA), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps, "fr");
  assert.deepEqual(outcome, { attempted: true, ok: true, messageId: "<mid-1@mail.scanym.com>" });
  assert.equal(sent.length, 1, "un seul message (À + Cc), pas deux envois");
  const m = sent[0];
  assert.equal(m.to, "client@example.test");
  assert.equal(m.cc, "contact-a@boutique-a.example.test");
  assert.equal(m.from, "commandes-a@boutique-a.example.test");
  assert.equal(m.fromName, "Boutique A");
  assert.equal(m.replyTo, "contact-a@boutique-a.example.test");
  assert.equal(m.idempotencyKey, `scanym:withdrawal-ack:${WID}`);
  assert.notEqual(m.from, "retractation@scanym.com", "ne se fait pas passer pour l'adresse de la plateforme");
  assert.equal(h.recorded.length, 1);
  assert.deepEqual(
    { ok: h.recorded[0].ok, to: h.recorded[0].to, cc: h.recorded[0].cc, sender: h.recorded[0].sender, error: h.recorded[0].error, version: h.recorded[0].contentVersion, mid: h.recorded[0].messageId },
    { ok: true, to: "client@example.test", cc: "contact-a@boutique-a.example.test", sender: "commandes-a@boutique-a.example.test", error: null, version: ACK_EMAIL_CONTENT_VERSION, mid: "<mid-1@mail.scanym.com>" }
  );
});

test("ISOLATION : la messagerie est résolue pour l'établissement de la DEMANDE seulement ; rien du commerçant B dans le message de A", async () => {
  const a = fakeProvider();
  const hA = harness({ claim: claimFor(RA), provider: a.provider });
  await sendWithdrawalAcknowledgementViaMerchantMailer(WID, hA.deps);
  assert.deepEqual(hA.resolvedFor, [RA]);
  const serialized = JSON.stringify(a.sent) + JSON.stringify(hA.recorded);
  assert.equal(serialized.includes("boutique-b"), false);
  assert.equal(serialized.includes("Boutique B"), false);

  const b = fakeProvider();
  const hB = harness({ claim: claimFor(RB), provider: b.provider });
  await sendWithdrawalAcknowledgementViaMerchantMailer(WID, hB.deps);
  assert.deepEqual(hB.resolvedFor, [RB]);
  assert.equal(b.sent[0].cc, "contact-b@boutique-b.example.test");
  assert.equal(JSON.stringify(b.sent).includes("boutique-a"), false);
});

test("échec fournisseur : demande `failed` avec une classe FERMÉE, copie et identifiant de message non enregistrés comme envoyés", async () => {
  const { provider } = fakeProvider({ ok: false, retryable: false, errorClass: "PROVIDER_AUTHENTICATION_FAILED" });
  const h = harness({ claim: claimFor(RA), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.deepEqual(outcome, { attempted: true, ok: false, error: "PROVIDER_AUTHENTICATION_FAILED" });
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].ok, false);
  assert.equal(h.recorded[0].error, "PROVIDER_AUTHENTICATION_FAILED");
  assert.equal(h.recorded[0].messageId, null);
});

test("le fournisseur LÈVE une exception : échec enregistré (ACK_DISPATCH_UNKNOWN_ERROR), jamais laissé à `sending`, aucun détail brut conservé", async () => {
  const { provider } = fakeProvider(undefined, true);
  const h = harness({ claim: claimFor(RA), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.deepEqual(outcome, { attempted: true, ok: false, error: "ACK_DISPATCH_UNKNOWN_ERROR" });
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].error, "ACK_DISPATCH_UNKNOWN_ERROR");
  assert.equal(JSON.stringify(h.recorded).includes("hunter2"), false);
  assert.equal(JSON.stringify(h.recorded).includes("secret-host"), false);
});

test("texte d'erreur libre du fournisseur => classe UNKNOWN_PROVIDER_ERROR (rien de brut en base)", async () => {
  const { provider } = fakeProvider({ ok: false, retryable: true, errorClass: "535 5.7.8 Authentication failed for user x@y with password abc" });
  const h = harness({ claim: claimFor(RA), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && !outcome.ok && outcome.error, "UNKNOWN_PROVIDER_ERROR");
  assert.equal(h.recorded[0].error, "UNKNOWN_PROVIDER_ERROR");
  assert.equal(JSON.stringify(h.recorded).includes("abc"), false);
});

test("messagerie absente, suspendue ou en erreur de résolution : échec MERCHANT_MAILER_UNAVAILABLE, aucun envoi", async () => {
  for (const providerThrows of [false, true]) {
    const h = harness({ claim: claimFor(RA), provider: null, providerThrows });
    const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
    assert.deepEqual(outcome, { attempted: true, ok: false, error: "MERCHANT_MAILER_UNAVAILABLE" });
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0].error, "MERCHANT_MAILER_UNAVAILABLE");
  }
});

test("identité d'expéditeur incomplète (profil désactivé, adresse invalide, nom vide) : échec, la messagerie n'est même pas résolue", async () => {
  for (const overrides of [
    { profileEmailEnabled: false },
    { senderEmail: "pas-une-adresse" },
    { senderEmail: null },
    { senderEmail: "a@b.test\r\nBcc: x@y.test" },
    { senderName: "   " },
    { senderName: null },
  ]) {
    const { provider, sent } = fakeProvider();
    const h = harness({ claim: claimFor(RA, overrides), provider });
    const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
    assert.deepEqual(outcome, { attempted: true, ok: false, error: "MERCHANT_MAILER_SENDER_UNRESOLVED" }, JSON.stringify(overrides));
    assert.equal(sent.length, 0);
    assert.deepEqual(h.resolvedFor, []);
    assert.equal(h.recorded[0].sender, null);
  }
});

test("régime exigeant l'accusé (STANDARD_14_DAYS, MIXED) + contact marchand absent : échec explicite, aucun envoi", async () => {
  for (const regime of ["STANDARD_14_DAYS", "MIXED"]) {
    const { provider, sent } = fakeProvider();
    const h = harness({ claim: claimFor(RA, { merchantContactEmail: null, merchantWithdrawalRegime: regime }), provider });
    const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
    assert.deepEqual(outcome, { attempted: true, ok: false, error: "MERCHANT_CONTACT_EMAIL_MISSING_FOR_APPLICABLE_REGIME" });
    assert.equal(sent.length, 0);
  }
});

test("régime non exigeant + contact absent : envoi au client SANS copie (cc null), la copie n'est pas enregistrée", async () => {
  const { provider, sent } = fakeProvider();
  const h = harness({ claim: claimFor(RA, { merchantContactEmail: null, merchantWithdrawalRegime: "EXEMPT" }), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true);
  assert.equal(sent[0].cc, null);
  assert.equal(h.recorded[0].cc, null);
});

test("copie identique à l'adresse du client : un seul destinataire (cc null)", async () => {
  const { provider, sent } = fakeProvider();
  const h = harness({ claim: claimFor(RA, { merchantContactEmail: "CLIENT@example.test" }), provider });
  await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(sent[0].cc, null);
});

test("adresse client invalide (CR/LF) : échec ACK_RECIPIENT_ADDRESS_INVALID avant toute résolution ou envoi", async () => {
  const { provider, sent } = fakeProvider();
  const h = harness({ claim: claimFor(RA, { acknowledgementAddress: "client@example.test\r\nRCPT TO:<evil@example.test>" }), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.deepEqual(outcome, { attempted: true, ok: false, error: "ACK_RECIPIENT_ADDRESS_INVALID" });
  assert.equal(sent.length, 0);
  assert.deepEqual(h.resolvedFor, []);
});

test("demande non revendicable (déjà en cours, terminée, ou sans canal) : rien n'est envoyé ni enregistré", async () => {
  const { provider, sent } = fakeProvider();
  const h = harness({ claim: null, provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.deepEqual(outcome, { attempted: false, reason: "already_claimed_elsewhere" });
  assert.equal(sent.length, 0);
  assert.equal(h.recorded.length, 0);
  assert.deepEqual(h.resolvedFor, []);
});

test("revendication perdue (recordResult => false) : pas d'exception, le résultat réel de l'envoi est tout de même rapporté", async () => {
  const { provider } = fakeProvider();
  const h = harness({ claim: claimFor(RA), provider, recordOk: false });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true);
});

test("ensemble fermé de codes propres : chaque code est reconnu par la normalisation (jamais réécrit en UNKNOWN_PROVIDER_ERROR)", async () => {
  assert.deepEqual([...ACK_MERCHANT_ERROR_CODES].sort(), [
    "ACK_DISPATCH_UNKNOWN_ERROR",
    "ACK_RECIPIENT_ADDRESS_INVALID",
    "MERCHANT_CONTACT_EMAIL_MISSING_FOR_APPLICABLE_REGIME",
    "MERCHANT_MAILER_SENDER_UNRESOLVED",
    "MERCHANT_MAILER_UNAVAILABLE",
  ]);
});

// --------------------------------------------------------------------
// C. Fournisseur SMTP marchand : transmission du Cc + CONTRÔLE NÉGATIF d'isolation
// --------------------------------------------------------------------
function vaultClient(row: Record<string, unknown> | null) {
  return {
    from() {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        update: () => ({ eq() { return this; }, then(r: (v: unknown) => void) { r({ error: null }); } }),
      };
    },
  } as never;
}
function vaultRowFor(restaurantId: string) {
  const s = encryptMerchantSmtpPassword("MOT-DE-PASSE-SYNTHETIQUE", restaurantId);
  return {
    host: "smtp.example.test", port: 465, username: "commandes-a@boutique-a.example.test", enabled: true,
    secret_ciphertext: s.ciphertext, secret_iv: s.iv, secret_auth_tag: s.authTag, last_error_class: null,
  };
}

test("le fournisseur marchand transmet le Cc au transport SMTP (À + Cc dans UN message)", async () => {
  const sentToTransport: Array<Record<string, unknown>> = [];
  const provider = await resolveMerchantSmtpProvider(RA, {
    client: vaultClient(vaultRowFor(RA)),
    transport: { async send(i: Record<string, unknown>) { sentToTransport.push(i); return { ok: true, messageId: "<m@x>" }; }, async checkConnectivity() { return { ok: true }; } } as never,
  });
  assert.ok(provider);
  await provider!.send({
    to: "client@example.test", cc: "contact-a@boutique-a.example.test", from: "commandes-a@boutique-a.example.test",
    fromName: "Boutique A", replyTo: null, subject: "S", html: "<p>h</p>", text: "t", idempotencyKey: `scanym:withdrawal-ack:${WID}`,
  });
  assert.equal(sentToTransport.length, 1);
  assert.equal(sentToTransport[0].to, "client@example.test");
  assert.equal(sentToTransport[0].cc, "contact-a@boutique-a.example.test");
});

test("sans Cc, le comportement des notifications existantes est inchangé (cc null)", async () => {
  const sentToTransport: Array<Record<string, unknown>> = [];
  const provider = await resolveMerchantSmtpProvider(RA, {
    client: vaultClient(vaultRowFor(RA)),
    transport: { async send(i: Record<string, unknown>) { sentToTransport.push(i); return { ok: true, messageId: "<m@x>" }; }, async checkConnectivity() { return { ok: true }; } } as never,
  });
  await provider!.send({ to: "c@example.test", from: "a@b.test", replyTo: null, subject: "S", html: "h", text: "t", idempotencyKey: "scanym:notification:abc" });
  assert.equal(sentToTransport[0].cc, null);
});

test("CONTRÔLE NÉGATIF : le secret chiffré du restaurant A copié dans la ligne du restaurant B n'est pas déchiffrable => aucune messagerie", async () => {
  const transportCalls: unknown[] = [];
  const provider = await resolveMerchantSmtpProvider(RB, {
    client: vaultClient(vaultRowFor(RA)),
    transport: { async send(i: unknown) { transportCalls.push(i); return { ok: true, messageId: "<m@x>" }; }, async checkConnectivity() { return { ok: true }; } } as never,
  });
  assert.equal(provider, null);
  assert.equal(transportCalls.length, 0);

  // Dans la chaîne complète, cela donne un échec enregistré et aucun envoi.
  const h = harness({ claim: claimFor(RB), provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.deepEqual(outcome, { attempted: true, ok: false, error: "MERCHANT_MAILER_UNAVAILABLE" });
});

// --------------------------------------------------------------------
// D. Câblage service : interrupteur, choix du canal, RPC
// --------------------------------------------------------------------
function legacyDeps(calls: string[]) {
  return {
    transport: { async send() { calls.push("legacy-send"); return { ok: true, messageId: "<l@x>" }; } },
    async claim() { calls.push("legacy-claim"); return null; },
    async recordResult() { calls.push("legacy-record"); },
  } as never;
}

test("interrupteur FERMÉ : canal historique uniquement, la messagerie du commerçant n'est pas touchée", async () => {
  const calls: string[] = [];
  const prev = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: "h", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "retractation@scanym.com" });
  try {
    const merchant = { async claim() { calls.push("merchant-claim"); return null; }, async resolveProvider() { calls.push("merchant-resolve"); return null; }, async recordResult() { calls.push("merchant-record"); return true; } };
    await dispatchWithdrawalAcknowledgement(WID, "fr", { isMerchantMailerActivated: async () => false, merchant, legacy: legacyDeps(calls) });
    assert.deepEqual(calls, ["legacy-claim"]);
  } finally {
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"]) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test("interrupteur OUVERT : messagerie du commerçant uniquement, jamais les deux canaux", async () => {
  const calls: string[] = [];
  const merchant = { async claim() { calls.push("merchant-claim"); return null; }, async resolveProvider() { return null; }, async recordResult() { return true; } };
  const outcome = await dispatchWithdrawalAcknowledgement(WID, "fr", { isMerchantMailerActivated: async () => true, merchant, legacy: legacyDeps(calls) });
  assert.deepEqual(calls, ["merchant-claim"]);
  assert.deepEqual(outcome, { attempted: false, reason: "already_claimed_elsewhere" });
});

test("une exception interne ne sort JAMAIS du dispatch : résultat d'échec fermé", async () => {
  const merchant = { async claim() { throw new Error("db down"); }, async resolveProvider() { return null; }, async recordResult() { return true; } };
  const outcome = await dispatchWithdrawalAcknowledgement(WID, "fr", { isMerchantMailerActivated: async () => true, merchant, legacy: legacyDeps([]) });
  assert.deepEqual(outcome, { attempted: true, ok: false, error: "ACK_DISPATCH_UNKNOWN_ERROR" });
  const outcome2 = await dispatchWithdrawalAcknowledgement(WID, "fr", {
    isMerchantMailerActivated: async () => { throw new Error("rpc"); }, merchant, legacy: legacyDeps([]),
  });
  assert.equal(outcome2.attempted, true);
});

test("isMerchantMailerActivated : échec FERMÉ (erreur, RPC absente, valeur non booléenne, exception)", async () => {
  const mk = (r: unknown) => ({ rpc: async () => r }) as never;
  assert.equal(await isMerchantMailerActivated(mk({ data: true, error: null })), true);
  assert.equal(await isMerchantMailerActivated(mk({ data: false, error: null })), false);
  assert.equal(await isMerchantMailerActivated(mk({ data: "true", error: null })), false);
  assert.equal(await isMerchantMailerActivated(mk({ data: 1, error: null })), false);
  assert.equal(await isMerchantMailerActivated(mk({ data: null, error: null })), false);
  assert.equal(await isMerchantMailerActivated(mk({ data: true, error: { message: "function does not exist" } })), false);
  assert.equal(await isMerchantMailerActivated({ rpc: async () => { throw new Error("net"); } } as never), false);
});

test("dépendances réelles : RPC v2 nommées, paramètres exacts, ligne NULL = non revendicable, record lit le booléen", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const claimRow = {
    id: WID, restaurant_id: RA, order_id: "o", acknowledgement_address: "client@example.test",
    customer_first_name: "C", customer_last_name: "T", declaration_snapshot: {}, merchant_name: null,
    merchant_contact_email: "contact-a@boutique-a.example.test", merchant_contact_phone: null,
    merchant_withdrawal_regime: "MIXED", profile_email_enabled: true, sender_name: "A", sender_email: "a@b.test", reply_to: null,
  };
  let nextClaim: unknown = [claimRow];
  let nextRecord: unknown = { data: true, error: null };
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return name.startsWith("claim_") ? { data: nextClaim, error: null } : nextRecord;
    },
  } as never;
  const deps = createMerchantAckDependencies({ client });

  const claim = await deps.claim(WID);
  assert.equal(claim?.restaurantId, RA);
  assert.equal(claim?.merchantName, "");
  assert.equal(claim?.profileEmailEnabled, true);
  assert.deepEqual(rpcCalls[0], { name: "claim_withdrawal_acknowledgement_send_v2", args: { p_withdrawal_request_id: WID, p_stale_after_seconds: 120 } });

  nextClaim = [{ ...claimRow, id: null }];
  assert.equal(await deps.claim(WID), null);
  nextClaim = [];
  assert.equal(await deps.claim(WID), null);

  const ok = await deps.recordResult({ withdrawalRequestId: WID, ok: true, to: "t", cc: "c", messageId: "m", contentVersion: "v", error: null, sender: "s" });
  assert.equal(ok, true);
  const rec = rpcCalls[rpcCalls.length - 1];
  assert.equal(rec.name, "record_withdrawal_acknowledgement_result_v2");
  assert.deepEqual(rec.args, { p_withdrawal_request_id: WID, p_ok: true, p_to: "t", p_cc: "c", p_message_id: "m", p_content_version: "v", p_error: null, p_sender: "s", p_transport: "merchant_smtp" });

  nextRecord = { data: false, error: null };
  assert.equal(await deps.recordResult({ withdrawalRequestId: WID, ok: false, to: "t", cc: null, messageId: null, contentVersion: "v", error: "X", sender: null }), false);
  nextRecord = { data: null, error: { message: "boom" } };
  assert.equal(await deps.recordResult({ withdrawalRequestId: WID, ok: false, to: "t", cc: null, messageId: null, contentVersion: "v", error: "X", sender: null }), false);
});

// --------------------------------------------------------------------
// E. Statut rapporté au client
// --------------------------------------------------------------------
test("reportedAcknowledgementStatus : jamais `sent` sans envoi confirmé ; sinon l'état enregistré", () => {
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: true, ok: true, messageId: "m" }), "sent");
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: true, ok: false, error: "X" }), "failed");
  assert.equal(reportedAcknowledgementStatus("pending", null), "pending");
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: false, reason: "already_claimed_elsewhere" }), "pending");
  assert.equal(reportedAcknowledgementStatus("unavailable_no_channel", { attempted: false, reason: "no_channel" }), "unavailable_no_channel");
  assert.equal(reportedAcknowledgementStatus("unavailable_no_channel", null), "unavailable_no_channel");
});

test("waitForAckOutcome : résultat si rapide, null si trop long (l'envoi continue), null si rejet", async () => {
  const fast = Promise.resolve({ attempted: true, ok: true, messageId: "m" } as const);
  assert.deepEqual(await waitForAckOutcome(fast, 200), { attempted: true, ok: true, messageId: "m" });
  const slow = new Promise<never>(() => {});
  assert.equal(await waitForAckOutcome(slow, 20), null);
  assert.equal(await waitForAckOutcome(Promise.reject(new Error("x")), 200), null);
});

// --------------------------------------------------------------------
// F. Contrôles structurels (garde-fous contre la régression)
// --------------------------------------------------------------------
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");

test("route : l'envoi passe par after() et n'est jamais un `void` non attendu ; l'adresse est validée strictement", () => {
  const route = read("app/track/[orderId]/withdrawal/route.ts");
  assert.match(route, /after\(\(\) => dispatch\.then/);
  assert.equal(/void\s+tryDispatchWithdrawalAcknowledgement/.test(route), false);
  assert.match(route, /isSafeSmtpAddress\(acknowledgementAddress\)/);
  assert.match(route, /reportedAcknowledgementStatus\(/);
  assert.match(route, /if \(!receipt\.replayed\)/, "une rediffusion (replay) ne relance jamais l'envoi");
  assert.equal(/export const ACK_RESPONSE_WAIT_MS/.test(route), false, "export interdit dans un fichier de route Next");
});

test("tableau de bord : « Copie envoyée » seulement pour `sent`, cause affichée pour `failed`, aucune colonne SQL nouvelle dans le select", () => {
  const page = read("app/dashboard/withdrawal-requests/page.tsx");
  assert.match(page, /Copie envoyée à/);
  assert.match(page, /acknowledgement_status === "sent"/);
  assert.match(page, /Cause :/);
  for (const code of ACK_MERCHANT_ERROR_CODES) assert.ok(page.includes(code), `ACK_ERROR_HINT couvre ${code}`);
  const dash = read("lib/services/dashboard.ts");
  assert.match(dash, /acknowledgement_last_error/);
  assert.equal(/acknowledgement_sender|acknowledgement_transport/.test(dash), false, "ordre de déploiement : le select ne dépend pas des nouvelles colonnes");
});

test("i18n : `withdrawalAckFailed` existe en FR, EN et AR et ne promet pas une notification du vendeur", () => {
  const i18n = read("lib/i18n.ts");
  assert.equal((i18n.match(/withdrawalAckFailed:/g) ?? []).length, 3);
  assert.equal(/le vendeur en est informé|the seller is informed/.test(i18n), false);
  assert.match(read("components/WithdrawalPanel.tsx"), /withdrawalAckFailed/);
});

test("aucune adresse de commerçant codée en dur dans le code source (Au Lait Cru se configure dans le profil légal)", () => {
  for (const f of [
    "lib/server/withdrawal-ack-merchant-mailer.ts",
    "lib/server/withdrawal-ack-service.ts",
    "app/track/[orderId]/withdrawal/route.ts",
    "app/dashboard/withdrawal-requests/page.tsx",
    "lib/server/notifications/merchant-smtp-provider.ts",
    "supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql",
    "supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1-ROLLBACK.sql",
    "supabase/DRAFT-diagnostic-withdrawal-ack-backlog-v1-READONLY.sql",
  ]) {
    assert.equal(/aulaitcru/i.test(read(f)), false, f);
  }
});

test("SQL : interrupteur fermé par défaut, jamais ouvert par le lot, aucune écriture dans le diagnostic", () => {
  const lot = read("supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql").replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
  assert.equal(/update\s+public\.scanym_ack_merchant_mailer_activation\s+set\s+enabled\s*=\s*true/i.test(lot), false, "le lot n'ouvre jamais l'interrupteur");
  const seed = lot.match(/insert\s+into\s+public\.scanym_ack_merchant_mailer_activation[\s\S]*?;/i);
  assert.ok(seed, "ligne singleton semée");
  assert.match(seed![0], /\bfalse\b/i);
  assert.equal(/\btrue\b/i.test(seed![0]), false, "la ligne semée n'est pas ouverte");
  const diag = stripSqlComments(read("supabase/DRAFT-diagnostic-withdrawal-ack-backlog-v1-READONLY.sql"));
  assert.equal(/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(diag), false);
  const rollback = read("supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1-ROLLBACK.sql");
  assert.match(rollback, /SCANYM_ROLLBACK_REFUSED/);
  assert.match(rollback, /SCANYM_ROLLBACK_DATA_LOSS/);
});

test("le lot SQL ne retouche NI la fonction de dépôt NI la garde de publication des CGV", () => {
  const lot = stripSqlComments(read("supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql"));
  assert.equal(/create\s+or\s+replace\s+function\s+(public\.)?submit_withdrawal_request_by_capability/i.test(lot), false);
  assert.equal(/create\s+or\s+replace\s+function\s+(public\.)?_scanym_has_online_withdrawal_runtime/i.test(lot), false);
  assert.equal(/create\s+or\s+replace\s+function\s+(public\.)?_scanym_has_operational_durable_ack_channel/i.test(lot), false);
});
