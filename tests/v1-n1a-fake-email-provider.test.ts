import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// N1-A — FAKE/TEST EMAIL PROVIDER.
// Mandat §"FAKE PROVIDER TESTS" : "recipient/sender/subject/rendered
// body/tracking link/idempotency key/number of send attempts" doivent
// tous être assertables. v1.2 — N1A-IDEMPOTENCY-KEY-CONTRACT-01 :
// l'idempotency key est STABLE par notification_outbox.id SEUL
// (jamais outboxId+attemptNumber -- une clé qui varie par tentative ne
// serait plus stable, exactement ce que le mandat interdit). La
// couverture de sa STABILITÉ across attempts/claims vit dans
// tests/v1-n1a-notification-idempotency-key.test.ts ; ce fichier-ci
// couvre uniquement le provider Fake lui-même isolément (le provider
// se contente d'enregistrer fidèlement le champ idempotencyKey qu'on
// lui fournit dans EmailMessage, jamais de le calculer lui-même).
// ====================================================================

const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");

test("FakeEmailProvider : succès par défaut, enregistre le message envoyé", async () => {
  const provider = new FakeEmailProvider();
  const result = await provider.send({
    to: "client@example.com",
    from: "commandes@resto.example",
    replyTo: "reply@resto.example",
    subject: "Objet",
    html: "<p>Corps</p>",
    text: "Corps",
    idempotencyKey: "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001",
  });

  assert.equal(result.ok, true);
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].to, "client@example.com");
  assert.equal(provider.sent[0].from, "commandes@resto.example");
  assert.equal(provider.sent[0].subject, "Objet");
  assert.equal(provider.callCountForAssertions, 1);
});

// Mandat §"MANDATORY IDEMPOTENCY TESTS" #6 : "fake provider exposes
// and allows assertion of the key" -- prouvé ici directement au
// niveau du provider isolé (la stabilité across attempts/claims est
// couverte séparément, voir en-tête de fichier).
test("FakeEmailProvider : le champ idempotencyKey du message est fidèlement enregistré et assertable", async () => {
  const provider = new FakeEmailProvider();
  await provider.send({
    to: "client@example.com",
    from: "commandes@resto.example",
    subject: "Objet",
    html: "<p>Corps</p>",
    text: "Corps",
    idempotencyKey: "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001",
  });

  assert.equal(provider.sent[0].idempotencyKey, "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001");
});

test("FakeEmailProvider : compte les tentatives sur plusieurs envois", async () => {
  const provider = new FakeEmailProvider();
  await provider.send({
    to: "a@example.com", from: "f@example.com", subject: "s", html: "h", text: "t",
    idempotencyKey: "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001",
  });
  await provider.send({
    to: "b@example.com", from: "f@example.com", subject: "s", html: "h", text: "t",
    idempotencyKey: "scanym:notification:bbbbbbbb-0000-4000-8000-000000000002",
  });
  assert.equal(provider.callCountForAssertions, 2);
  assert.equal(provider.sent.length, 2);
});

test("FakeEmailProvider : comportement injecté -- échec réessayable configurable", async () => {
  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: true, errorClass: "SYNTHETIC_RETRYABLE" }));
  const result = await provider.send({
    to: "a@example.com", from: "f@example.com", subject: "s", html: "h", text: "t",
    idempotencyKey: "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retryable, true);
    assert.equal(result.errorClass, "SYNTHETIC_RETRYABLE");
  }
});

test("FakeEmailProvider : comportement injecté -- échec terminal configurable", async () => {
  const provider = new FakeEmailProvider(() => ({ ok: false, retryable: false, errorClass: "SYNTHETIC_TERMINAL" }));
  const result = await provider.send({
    to: "a@example.com", from: "f@example.com", subject: "s", html: "h", text: "t",
    idempotencyKey: "scanym:notification:aaaaaaaa-0000-4000-8000-000000000001",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retryable, false);
  }
});
