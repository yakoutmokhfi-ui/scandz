import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3.
// Tests de l'extension additive url_retour_ok/url_retour_err
// (ferme V2-07). Vérifie la RÉTROCOMPATIBILITÉ STRICTE (mandat P3-B6
// §18, reprise à l'identique) et l'inclusion correcte dans la
// signature MAC quand ces champs sont fournis.
// ====================================================================

const { buildMoneticoPaymentRequest } = await import(
  "../lib/server/payment-providers/monetico/request.ts"
);
const { parseMoneticoCredential } = await import(
  "../lib/server/payment-providers/monetico/credentials.ts"
);
const { transformSecurityKey, computeMac } = await import(
  "../lib/server/payment-providers/monetico/mac.ts"
);

const CREDENTIAL = parseMoneticoCredential(
  JSON.stringify({
    tpe: "1234567",
    societe: "p3bmcrsociete",
    securityKey: "0123456789abcdef0123456789abcdef01234567",
  })
);
const FIXED_DATE = new Date(Date.UTC(2026, 7, 31, 12, 0, 0));

test("url_retour: OMIS -- objet de sortie ne porte NI url_retour_ok NI url_retour_err (rétrocompatibilité stricte)", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal("url_retour_ok" in fields, false);
  assert.equal("url_retour_err" in fields, false);
});

test("url_retour: OMIS -- le MAC est BYTE-IDENTIQUE à une requête sans ce lot (non-régression)", () => {
  const withoutUrlRetour = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  const keyBuffer = transformSecurityKey(CREDENTIAL.securityKey);
  const expectedMac = computeMac(
    {
      version: withoutUrlRetour.version,
      TPE: withoutUrlRetour.TPE,
      date: withoutUrlRetour.date,
      montant: withoutUrlRetour.montant,
      reference: withoutUrlRetour.reference,
      lgue: withoutUrlRetour.lgue,
      contexte_commande: withoutUrlRetour.contexte_commande,
      societe: withoutUrlRetour.societe,
    },
    keyBuffer
  );
  assert.equal(withoutUrlRetour.MAC, expectedMac);
});

test("url_retour: FOURNI (les deux) -- présents tels quels dans l'objet de sortie", () => {
  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 10,
      currency: "EUR",
      referenceSeed: "order-1",
      urlRetourOk: "https://example.test/checkout/return/ok",
      urlRetourErr: "https://example.test/checkout/return/err",
    },
    FIXED_DATE
  );
  assert.equal(fields.url_retour_ok, "https://example.test/checkout/return/ok");
  assert.equal(fields.url_retour_err, "https://example.test/checkout/return/err");
});

test("url_retour: FOURNI -- entre correctement dans la signature MAC (le MAC change par rapport à l'omission)", () => {
  const without = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  const withUrls = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 10,
      currency: "EUR",
      referenceSeed: "order-1",
      urlRetourOk: "https://example.test/checkout/return/ok",
      urlRetourErr: "https://example.test/checkout/return/err",
    },
    FIXED_DATE
  );
  assert.notEqual(without.MAC, withUrls.MAC);

  const keyBuffer = transformSecurityKey(CREDENTIAL.securityKey);
  const expectedMac = computeMac(
    {
      version: withUrls.version,
      TPE: withUrls.TPE,
      date: withUrls.date,
      montant: withUrls.montant,
      reference: withUrls.reference,
      lgue: withUrls.lgue,
      contexte_commande: withUrls.contexte_commande,
      societe: withUrls.societe,
      url_retour_ok: withUrls.url_retour_ok as string,
      url_retour_err: withUrls.url_retour_err as string,
    },
    keyBuffer
  );
  assert.equal(withUrls.MAC, expectedMac);
});

test("url_retour: seul urlRetourOk fourni -- url_retour_err reste absent (indépendance des deux champs)", () => {
  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 10,
      currency: "EUR",
      referenceSeed: "order-1",
      urlRetourOk: "https://example.test/checkout/return/ok",
    },
    FIXED_DATE
  );
  assert.equal(fields.url_retour_ok, "https://example.test/checkout/return/ok");
  assert.equal("url_retour_err" in fields, false);
});

test("url_retour: chaîne vide traitée comme absente (jamais un champ vide envoyé à Monetico)", () => {
  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 10,
      currency: "EUR",
      referenceSeed: "order-1",
      urlRetourOk: "",
      urlRetourErr: "",
    },
    FIXED_DATE
  );
  assert.equal("url_retour_ok" in fields, false);
  assert.equal("url_retour_err" in fields, false);
});

test("STRUCTUREL -- reference.ts/canonicalization.ts/mac.ts ne sont pas modifiés par cette extension (aucune trace de url_retour dans ces fichiers)", async () => {
  const { readFileSync } = await import("node:fs");
  const canonicalizationSrc = readFileSync(
    "lib/server/payment-providers/monetico/canonicalization.ts",
    "utf8"
  );
  const macSrc = readFileSync("lib/server/payment-providers/monetico/mac.ts", "utf8");
  const referenceSrc = readFileSync("lib/server/payment-providers/monetico/reference.ts", "utf8");
  assert.ok(!/url_retour/i.test(canonicalizationSrc));
  assert.ok(!/url_retour/i.test(macSrc));
  assert.ok(!/url_retour/i.test(referenceSrc));
});
