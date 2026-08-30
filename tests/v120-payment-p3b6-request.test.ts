import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1.
//
// Couvre l'extension de buildMoneticoPaymentRequest (contexte_commande
// .billing/.shipping) -- mandat §17/§18/§19 : NON-RÉGRESSION MAC
// stricte (même chaîne canonique, même sémantique de signature
// qu'avant ce lot -- contexte_commande reste un UNIQUE champ opaque
// signé), plus les nouvelles garanties de sérialisation
// (billing/shipping indépendants, aucun sous-objet fabriqué vide).
//
// tests/v111d-payment-p3a2-request.test.ts (PAYMENT P3-A2, INCHANGÉ
// par ce lot) démontre déjà que l'omission de billing/shipping produit
// un JSON byte-identique à avant ce lot -- non dupliqué ici.
// ====================================================================

const { buildMoneticoPaymentRequest } = await import(
  "../lib/server/payment-providers/monetico/request.ts"
);
const { parseMoneticoCredential } = await import(
  "../lib/server/payment-providers/monetico/credentials.ts"
);

const CREDENTIAL = parseMoneticoCredential(
  JSON.stringify({
    tpe: "1234567",
    societe: "p3b6synthsociete",
    securityKey: "0123456789abcdef0123456789abcdef01234567",
  })
);

const FIXED_DATE = new Date(Date.UTC(2026, 4, 24, 10, 0, 25));

const BILLING = {
  addressLine1: "12 rue de Paris",
  city: "Paris",
  postalCode: "75001",
  country: "FR",
};

const BILLING_DIFFERENT = {
  addressLine1: "5 avenue Foo",
  city: "Lyon",
  postalCode: "69001",
  country: "FR",
};

const SHIPPING = {
  addressLine1: "20 rue de Lyon",
  city: "Lyon",
  postalCode: "69002",
  country: "FR",
};

function baseInput(extra: Record<string, unknown> = {}) {
  return {
    credential: CREDENTIAL,
    amount: 10,
    currency: "EUR",
    referenceSeed: "order-1",
    ...extra,
  };
}

test("contexte_commande: billing fourni -> décodé exactement sous {billing: {...}}", () => {
  const fields = buildMoneticoPaymentRequest(baseInput({ billingContext: BILLING }), FIXED_DATE);
  const decoded = JSON.parse(Buffer.from(fields.contexte_commande, "base64").toString("utf8"));
  assert.deepEqual(decoded, { billing: BILLING });
});

test("contexte_commande: billing + corrélation -> les deux clés présentes, jamais de shipping/panier fabriqué", () => {
  const fields = buildMoneticoPaymentRequest(
    baseInput({ billingContext: BILLING, orderCorrelationId: "corr-1" }),
    FIXED_DATE
  );
  const decoded = JSON.parse(Buffer.from(fields.contexte_commande, "base64").toString("utf8"));
  assert.deepEqual(decoded, { correlationId: "corr-1", billing: BILLING });
  assert.equal("shipping" in decoded, false);
  assert.equal("shoppingCart" in decoded, false);
  assert.equal("client" in decoded, false);
});

test("contexte_commande: shipping fourni indépendamment de billing (mandat §14 -- pickup/table/room_service n'envoient jamais de shipping)", () => {
  const fields = buildMoneticoPaymentRequest(
    baseInput({ shippingContext: SHIPPING }),
    FIXED_DATE
  );
  const decoded = JSON.parse(Buffer.from(fields.contexte_commande, "base64").toString("utf8"));
  assert.deepEqual(decoded, { shipping: SHIPPING });
  assert.equal("billing" in decoded, false);
});

test("contexte_commande: billing ET shipping fournis simultanément (mode delivery)", () => {
  const fields = buildMoneticoPaymentRequest(
    baseInput({ billingContext: BILLING, shippingContext: SHIPPING }),
    FIXED_DATE
  );
  const decoded = JSON.parse(Buffer.from(fields.contexte_commande, "base64").toString("utf8"));
  assert.deepEqual(decoded, { billing: BILLING, shipping: SHIPPING });
});

test("MAC non-régression: MÊME entrée (y compris billing identique) -> MÊME MAC de façon déterministe", () => {
  const fields1 = buildMoneticoPaymentRequest(baseInput({ billingContext: BILLING }), FIXED_DATE);
  const fields2 = buildMoneticoPaymentRequest(baseInput({ billingContext: BILLING }), FIXED_DATE);
  assert.equal(fields1.MAC, fields2.MAC);
  assert.equal(fields1.contexte_commande, fields2.contexte_commande);
});

test("MAC: un billing DIFFÉRENT produit un contexte_commande différent, donc un MAC différent (contexte_commande reste dans le champ signé)", () => {
  const fields1 = buildMoneticoPaymentRequest(baseInput({ billingContext: BILLING }), FIXED_DATE);
  const fields2 = buildMoneticoPaymentRequest(
    baseInput({ billingContext: BILLING_DIFFERENT }),
    FIXED_DATE
  );
  assert.notEqual(fields1.contexte_commande, fields2.contexte_commande);
  assert.notEqual(fields1.MAC, fields2.MAC);
});

test("MAC: présent, hexadécimal 40 caractères, même avec billing/shipping fournis (aucun changement de format)", () => {
  const fields = buildMoneticoPaymentRequest(
    baseInput({ billingContext: BILLING, shippingContext: SHIPPING }),
    FIXED_DATE
  );
  assert.match(fields.MAC, /^[0-9a-f]{40}$/);
});

test("jeu de champs signés: EXACTEMENT les 8 champs habituels, contexte_commande reste un UNIQUE champ opaque (mandat §18 -- MAC non redessiné)", () => {
  const fields = buildMoneticoPaymentRequest(
    baseInput({ billingContext: BILLING, shippingContext: SHIPPING }),
    FIXED_DATE
  );
  assert.deepEqual(Object.keys(fields).sort(), [
    "MAC",
    "TPE",
    "contexte_commande",
    "date",
    "lgue",
    "montant",
    "reference",
    "societe",
    "version",
  ]);
  assert.equal(typeof fields.contexte_commande, "string");
});
