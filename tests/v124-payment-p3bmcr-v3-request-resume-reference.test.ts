import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3.
// Tests de l'extension additive `reference` (bypass de la dérivation
// `referenceSeed`) — résout le gap documenté par PAYMENT P3-B3 :
// la reprise d'une tentative `pending` doit reconstruire un
// formulaire Monetico avec EXACTEMENT la même `reference` déjà
// stockée par `initiate_payment_attempt`, jamais une nouvelle
// dérivée. Vérifie la RÉTROCOMPATIBILITÉ STRICTE (omis, comportement
// byte-identique) et l'usage correct pour la reprise.
// ====================================================================

const { buildMoneticoPaymentRequest } = await import(
  "../lib/server/payment-providers/monetico/request.ts"
);
const { parseMoneticoCredential } = await import(
  "../lib/server/payment-providers/monetico/credentials.ts"
);
const { deriveMoneticoReference } = await import(
  "../lib/server/payment-providers/monetico/reference.ts"
);
const { MoneticoProtocolError } = await import(
  "../lib/server/payment-providers/monetico/errors.ts"
);

const CREDENTIAL = parseMoneticoCredential(
  JSON.stringify({
    tpe: "1234567",
    societe: "p3bmcrsociete",
    securityKey: "0123456789abcdef0123456789abcdef01234567",
  })
);
const FIXED_DATE = new Date(Date.UTC(2026, 7, 31, 12, 0, 0));

test("reference: OMISE -- comportement byte-identique à avant ce lot (dérivation via referenceSeed)", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal(fields.reference, deriveMoneticoReference("order-1"));
});

test("reference: FOURNIE -- utilisée TELLE QUELLE, jamais re-dérivée", () => {
  const stored = "abcdef123456"; // référence déjà stockée par initiate_payment_attempt lors de l'initiation d'origine
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", reference: stored },
    FIXED_DATE
  );
  assert.equal(fields.reference, stored);
  assert.notEqual(fields.reference, deriveMoneticoReference(stored));
});

test("reference: REPRISE -- même reference/amount/currency -> MAC identique à la requête d'origine (formulaire reconstructible à l'identique)", () => {
  const originalSeed = "order-42-attempt-seed";
  const originalReference = deriveMoneticoReference(originalSeed);

  // Requête d'ORIGINE (au moment de l'initiation).
  const original = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 25.5, currency: "EUR", referenceSeed: originalSeed },
    FIXED_DATE
  );

  // Requête de REPRISE : l'orchestrateur n'a plus `originalSeed` (jamais
  // stocké) -- seulement `originalReference`, restituée par
  // `getOrderActivePaymentAttempt` (P3-B3) avec amount/currency
  // AUTORITATIFS identiques.
  const resumed = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 25.5,
      currency: "EUR",
      reference: originalReference,
    },
    FIXED_DATE
  );

  assert.equal(resumed.reference, original.reference);
  assert.deepEqual(resumed, original);
});

test("reference: fournie -- prend STRICTEMENT priorité sur referenceSeed si les deux sont présents (jamais une erreur de redondance)", () => {
  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 10,
      currency: "EUR",
      reference: "priority-wins",
      referenceSeed: "ignored-seed",
    },
    FIXED_DATE
  );
  assert.equal(fields.reference, "priority-wins");
});

test("reference: ni `reference` ni `referenceSeed` fournis -- échoue fermé (MoneticoProtocolError), jamais un envoi sans référence", () => {
  assert.throws(
    () =>
      buildMoneticoPaymentRequest(
        { credential: CREDENTIAL, amount: 10, currency: "EUR" } as never,
        FIXED_DATE
      ),
    MoneticoProtocolError
  );
});

test("STRUCTUREL -- reference.ts/canonicalization.ts/mac.ts ne sont pas modifiés par cette extension", async () => {
  const { readFileSync } = await import("node:fs");
  const canonicalizationSrc = readFileSync(
    "lib/server/payment-providers/monetico/canonicalization.ts",
    "utf8"
  );
  const macSrc = readFileSync("lib/server/payment-providers/monetico/mac.ts", "utf8");
  const referenceSrc = readFileSync("lib/server/payment-providers/monetico/reference.ts", "utf8");
  assert.ok(!/reference\?:/.test(canonicalizationSrc));
  assert.ok(!/reference\?:/.test(macSrc));
  assert.ok(!/input\.reference\b/.test(referenceSrc));
});
