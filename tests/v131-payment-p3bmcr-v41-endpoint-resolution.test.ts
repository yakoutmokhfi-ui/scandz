import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.1.
// Correction finale mode/endpoint (mandat §16-§17/§25) : test unitaire
// DÉDIÉ de lib/server/payment-providers/monetico/endpoint.ts, isolé
// de tout autre appelant (payment-checkout-runtime.ts est déjà couvert
// indirectement par tests/v125). Ferme explicitement l'exigence du
// mandat : "add an explicit test asserting the test-mode URL and
// live-mode URL are exactly the claimed strings and are NOT equal to
// each other."
// ====================================================================

const {
  resolveMoneticoSubmissionUrl,
  MoneticoUnsupportedModeError,
  MONETICO_TEST_PAYMENT_SUBMISSION_URL,
  MONETICO_LIVE_PAYMENT_SUBMISSION_URL,
  MONETICO_PAYMENT_SUBMISSION_URL,
} = await import("../lib/server/payment-providers/monetico/endpoint.ts");

test("MONETICO_TEST_PAYMENT_SUBMISSION_URL est EXACTEMENT la chaîne revendiquée", () => {
  assert.equal(MONETICO_TEST_PAYMENT_SUBMISSION_URL, "https://p.monetico-services.com/test/paiement.cgi");
});

test("MONETICO_LIVE_PAYMENT_SUBMISSION_URL est EXACTEMENT la chaîne revendiquée", () => {
  assert.equal(MONETICO_LIVE_PAYMENT_SUBMISSION_URL, "https://p.monetico-services.com/paiement.cgi");
});

test("les deux URLs de soumission NE SONT PAS égales", () => {
  assert.notEqual(MONETICO_TEST_PAYMENT_SUBMISSION_URL, MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
});

test("l'alias déprécié MONETICO_PAYMENT_SUBMISSION_URL désigne désormais LIVE, jamais TEST", () => {
  assert.equal(MONETICO_PAYMENT_SUBMISSION_URL, MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
  assert.notEqual(MONETICO_PAYMENT_SUBMISSION_URL, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
});

test("resolveMoneticoSubmissionUrl('test') renvoie l'URL test EXACTE", () => {
  assert.equal(resolveMoneticoSubmissionUrl("test"), "https://p.monetico-services.com/test/paiement.cgi");
  assert.equal(resolveMoneticoSubmissionUrl("test"), MONETICO_TEST_PAYMENT_SUBMISSION_URL);
});

test("resolveMoneticoSubmissionUrl('live') renvoie l'URL live EXACTE", () => {
  assert.equal(resolveMoneticoSubmissionUrl("live"), "https://p.monetico-services.com/paiement.cgi");
  assert.equal(resolveMoneticoSubmissionUrl("live"), MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
});

test("resolveMoneticoSubmissionUrl : 'test' et 'live' renvoient des valeurs DIFFÉRENTES", () => {
  assert.notEqual(resolveMoneticoSubmissionUrl("test"), resolveMoneticoSubmissionUrl("live"));
});

test("resolveMoneticoSubmissionUrl : mode non supporté échoue FERMÉ (MoneticoUnsupportedModeError), jamais une URL devinée", () => {
  // @ts-expect-error -- valeur volontairement hors union pour ce test fail-closed
  assert.throws(() => resolveMoneticoSubmissionUrl("sandbox"), MoneticoUnsupportedModeError);
  // @ts-expect-error
  assert.throws(() => resolveMoneticoSubmissionUrl(""), MoneticoUnsupportedModeError);
  // @ts-expect-error
  assert.throws(() => resolveMoneticoSubmissionUrl(undefined), MoneticoUnsupportedModeError);
});

test("aucune variable d'environnement ne peut surcharger la résolution de mode -- P3-B4 (mode persisté) reste la seule autorité", () => {
  const previous = process.env.MONETICO_MODE;
  process.env.MONETICO_MODE = "live";
  try {
    // resolveMoneticoSubmissionUrl ne lit AUCUNE variable d'environnement
    // -- son unique paramètre est le mode déjà résolu par l'appelant
    // depuis payment_provider_environments (P3-B4). Une variable
    // d'environnement de même nom, même positionnée, n'a AUCUN effet.
    assert.equal(resolveMoneticoSubmissionUrl("test"), MONETICO_TEST_PAYMENT_SUBMISSION_URL);
  } finally {
    if (previous === undefined) delete process.env.MONETICO_MODE;
    else process.env.MONETICO_MODE = previous;
  }
});
