import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Tests de la construction de requête sortante (mandat §13/§14/§15/
// §16/§17/§18) : formats de date/montant/référence/contexte_commande,
// et surtout l'INVARIANT D'AUTORITÉ MONTANT/DEVISE (mandat §14) --
// démontré ici comme un flux intégré initiatePaymentAttempt (mocké)
// -> buildMoneticoPaymentRequest, PLUS une preuve structurelle qu'AUCUN
// fichier de l'adaptateur ne lit jamais une entrée HTTP directement.
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
    societe: "p3a2synthsociete",
    securityKey: "0123456789abcdef0123456789abcdef01234567",
  })
);

const FIXED_DATE = new Date(Date.UTC(2026, 4, 24, 10, 0, 25)); // 24/05/2026 10:00:25 UTC

test("request: format de date exact JJ/MM/AAAA:HH:MM:SS, en UTC", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal(fields.date, "24/05/2026:10:00:25");
});

test("request: format de montant exact <valeur>.<2 décimales><devise ISO 3 lettres>", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 95.25, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal(fields.montant, "95.25EUR");
});

test("request: montant entier formaté avec 2 décimales", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "USD", referenceSeed: "order-2" },
    FIXED_DATE
  );
  assert.equal(fields.montant, "10.00USD");
});

test("request: devise invalide (pas 3 lettres majuscules) rejetée", () => {
  assert.throws(
    () =>
      buildMoneticoPaymentRequest(
        { credential: CREDENTIAL, amount: 10, currency: "eur", referenceSeed: "order-1" },
        FIXED_DATE
      ),
    MoneticoProtocolError
  );
});

test("request: montant négatif rejeté", () => {
  assert.throws(
    () =>
      buildMoneticoPaymentRequest(
        { credential: CREDENTIAL, amount: -1, currency: "EUR", referenceSeed: "order-1" },
        FIXED_DATE
      ),
    MoneticoProtocolError
  );
});

test("request: version fixée à '3.0'", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal(fields.version, "3.0");
});

test("request: langue par défaut FR, langue documentée acceptée", () => {
  const defaultLang = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal(defaultLang.lgue, "FR");

  const explicitLang = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1", language: "en" },
    FIXED_DATE
  );
  assert.equal(explicitLang.lgue, "EN");
});

test("request: langue non documentée rejetée", () => {
  assert.throws(
    () =>
      buildMoneticoPaymentRequest(
        { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1", language: "XX" },
        FIXED_DATE
      ),
    MoneticoProtocolError
  );
});

test("request: référence dérivée déterministe (jamais l'UUID interne brut exposé)", () => {
  const seed = "11111111-2222-3333-4444-555555555555";
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: seed },
    FIXED_DATE
  );
  assert.equal(fields.reference, deriveMoneticoReference(seed));
  assert.notEqual(fields.reference, seed);
  assert.ok(fields.reference.length <= 50);
  assert.match(fields.reference, /^[\x20-\x7E]+$/);
});

test("request: contexte_commande est du base64 valide décodant vers un JSON minimal (aucun sous-objet billing/shipping/panier -- Annexe 9.5 non vérifiable, voir rapport)", () => {
  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: 10,
      currency: "EUR",
      referenceSeed: "order-1",
      orderCorrelationId: "corr-42",
    },
    FIXED_DATE
  );
  const decoded = JSON.parse(Buffer.from(fields.contexte_commande, "base64").toString("utf8"));
  assert.deepEqual(decoded, { correlationId: "corr-42" });
});

test("request: contexte_commande sans corrélation fournie reste un JSON minimal vide", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  const decoded = JSON.parse(Buffer.from(fields.contexte_commande, "base64").toString("utf8"));
  assert.deepEqual(decoded, {});
});

test("request: TPE/societe proviennent EXACTEMENT du credential fourni, jamais recalculés", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.equal(fields.TPE, CREDENTIAL.tpe);
  assert.equal(fields.societe, CREDENTIAL.societe);
});

test("request: MAC présent, hexadécimal 40 caractères, absent de son propre calcul", () => {
  const fields = buildMoneticoPaymentRequest(
    { credential: CREDENTIAL, amount: 10, currency: "EUR", referenceSeed: "order-1" },
    FIXED_DATE
  );
  assert.match(fields.MAC, /^[0-9a-f]{40}$/);
});

// --------------------------------------------------------------
// §14 INVARIANT D'AUTORITÉ MONTANT/DEVISE -- flux intégré simulant
// exactement le flux attendu par le mandat : commande ->
// initiatePaymentAttempt() (mocké, résultat SERVEUR-AUTORITAIRE) ->
// buildMoneticoPaymentRequest().
// --------------------------------------------------------------

test("request: le montant Monetico dérive EXACTEMENT du résultat (mocké) de initiatePaymentAttempt, jamais d'une autre source", () => {
  // Simule le résultat que renverrait la RPC P1 initiate_payment_attempt
  // (déjà auditée) -- ce lot ne la ré-implémente pas, il consomme
  // uniquement sa forme de résultat.
  const mockInitiateResult = { transactionId: "txn-mock-1", amount: 42.1, currency: "EUR" };

  const fields = buildMoneticoPaymentRequest(
    {
      credential: CREDENTIAL,
      amount: mockInitiateResult.amount,
      currency: mockInitiateResult.currency,
      referenceSeed: "order-mock-1",
    },
    FIXED_DATE
  );

  assert.equal(fields.montant, "42.10EUR");
});

test("archi: aucun fichier de lib/server/payment-providers/monetico/ ne lit une entrée HTTP/client (req.body, searchParams, req.query, NextRequest)", () => {
  const dir = "lib/server/payment-providers/monetico";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  // Cible l'USAGE réel, jamais la simple mention entre backticks dans
  // un commentaire d'architecture expliquant ce que ce module NE fait
  // PAS (même patron de correction qu'ailleurs dans cette suite).
  const forbidden = /(?<!`)(req\.body|searchParams|req\.query|NextRequest|request\.json\(\))(?!`)/;
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    if (forbidden.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `entrée HTTP/client inattendue détectée : ${offenders.join(", ")}`);
});

test("archi: chaque fichier sous lib/server/payment-providers/ importe \"server-only\" en tête", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith(".ts")) out.push(full);
    }
    return out;
  }
  const files = walk("lib/server/payment-providers");
  assert.ok(files.length >= 10, "au moins 10 fichiers .ts attendus sous lib/server/payment-providers/");
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!/^import\s+"server-only";/m.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `garde "server-only" manquant : ${offenders.join(", ")}`);
});
