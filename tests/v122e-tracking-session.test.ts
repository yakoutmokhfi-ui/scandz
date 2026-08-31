import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// lib/server/tracking-session.ts.
//
// Couvre mandat §9 (session de présentation STATELESS, dérivée d'une
// preuve de possession déjà validée, jamais une seconde autorité),
// §10 (chiffrée/authentifiée, expiration bornée), §11 (ISOLATION
// SESSION/COMMANDE -- "session A + order A -> PASS ; session A + order
// B -> FAIL ; session A + random order -> FAIL ; expired/invalid
// session -> generic invalid/unavailable behavior"), et §12 (jamais de
// journalisation du jeton/secret).
// ====================================================================

process.env.TRACKING_SESSION_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const {
  createTrackingSessionToken,
  verifyTrackingSessionToken,
  TrackingSessionConfigError,
  TRACKING_SESSION_COOKIE_NAME,
} = await import("../lib/server/tracking-session.ts");

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "99999999-9999-4999-8999-999999999999";
const RANDOM_ORDER = "55555555-5555-4555-8555-555555555555";
const TOKEN_A = "22222222-2222-4222-8222-222222222222";

test("mandat §11.A : session A + order A -> PASS (round-trip fidèle)", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  const result = verifyTrackingSessionToken(token, ORDER_A);
  assert.deepEqual(result, { orderId: ORDER_A, publicToken: TOKEN_A });
});

test("mandat §11.B : session A + order B -> FAIL (jamais de lecture croisée)", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  assert.equal(verifyTrackingSessionToken(token, ORDER_B), null);
});

test("mandat §11 : session A + commande aléatoire non liée -> FAIL", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  assert.equal(verifyTrackingSessionToken(token, RANDOM_ORDER), null);
});

test("session expirée -> FAIL générique (mandat §10 'bounded expiry', §11 'expired session -> generic invalid behavior')", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  const realNow = Date.now;
  try {
    // Simule une horloge 3 heures dans le futur (TTL réel = 2h) --
    // seule façon déterministe de tester une expiration bornée sans
    // attendre réellement.
    Date.now = () => realNow() + 3 * 60 * 60 * 1000;
    assert.equal(verifyTrackingSessionToken(token, ORDER_A), null);
  } finally {
    Date.now = realNow;
  }
});

test("jeton altéré (un octet modifié) -- authentification AES-GCM échoue, FAIL générique, jamais une exception propagée", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  const bytes = Buffer.from(token, "base64url");
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; // altère le dernier octet du texte chiffré
  const tampered = bytes.toString("base64url");
  assert.doesNotThrow(() => verifyTrackingSessionToken(tampered, ORDER_A));
  assert.equal(verifyTrackingSessionToken(tampered, ORDER_A), null);
});

test("jeton tronqué -- FAIL générique, jamais une exception", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  const truncated = token.slice(0, 10);
  assert.doesNotThrow(() => verifyTrackingSessionToken(truncated, ORDER_A));
  assert.equal(verifyTrackingSessionToken(truncated, ORDER_A), null);
});

test("entrée totalement arbitraire (jamais un jeton émis par ce module) -- FAIL générique, jamais une exception", () => {
  for (const bad of ["", "not-a-token", "!!!invalid-base64url!!!", "a".repeat(500)]) {
    assert.doesNotThrow(() => verifyTrackingSessionToken(bad, ORDER_A));
    assert.equal(verifyTrackingSessionToken(bad, ORDER_A), null);
  }
});

test("un jeton émis pour une commande ne se vérifie JAMAIS pour un order_id vide/malformé", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  assert.equal(verifyTrackingSessionToken(token, ""), null);
  assert.equal(verifyTrackingSessionToken(token, "not-a-uuid"), null);
});

test("TRACKING_SESSION_SECRET absent -- createTrackingSessionToken lève TrackingSessionConfigError, JAMAIS un jeton silencieusement invalide", () => {
  const saved = process.env.TRACKING_SESSION_SECRET;
  try {
    delete process.env.TRACKING_SESSION_SECRET;
    assert.throws(() => createTrackingSessionToken(ORDER_A, TOKEN_A), TrackingSessionConfigError);
  } finally {
    process.env.TRACKING_SESSION_SECRET = saved;
  }
});

test("TRACKING_SESSION_SECRET mal formé (mauvaise longueur) -- même erreur de configuration", () => {
  const saved = process.env.TRACKING_SESSION_SECRET;
  try {
    process.env.TRACKING_SESSION_SECRET = "trop-court";
    assert.throws(() => createTrackingSessionToken(ORDER_A, TOKEN_A), TrackingSessionConfigError);
  } finally {
    process.env.TRACKING_SESSION_SECRET = saved;
  }
});

test("verifyTrackingSessionToken DÉGRADE (retourne null) si le secret devient indisponible entre-temps, ne lève JAMAIS -- une session invérifiable doit se comporter comme absente", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  const saved = process.env.TRACKING_SESSION_SECRET;
  try {
    delete process.env.TRACKING_SESSION_SECRET;
    assert.doesNotThrow(() => verifyTrackingSessionToken(token, ORDER_A));
    assert.equal(verifyTrackingSessionToken(token, ORDER_A), null);
  } finally {
    process.env.TRACKING_SESSION_SECRET = saved;
  }
});

test("deux jetons émis pour la MÊME commande sont DIFFÉRENTS (IV aléatoire) -- jamais un chiffrement déterministe rejouable", () => {
  const tokenOne = createTrackingSessionToken(ORDER_A, TOKEN_A);
  const tokenTwo = createTrackingSessionToken(ORDER_A, TOKEN_A);
  assert.notEqual(tokenOne, tokenTwo);
  // Les deux restent néanmoins valides et fidèles.
  assert.deepEqual(verifyTrackingSessionToken(tokenOne, ORDER_A), { orderId: ORDER_A, publicToken: TOKEN_A });
  assert.deepEqual(verifyTrackingSessionToken(tokenTwo, ORDER_A), { orderId: ORDER_A, publicToken: TOKEN_A });
});

test("le jeton de session émis NE CONTIENT PAS le jeton de possession en clair (recherche de sous-chaîne dans le blob base64url)", () => {
  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  assert.equal(token.includes(TOKEN_A), false, "le jeton de possession ne doit jamais apparaître en clair dans le jeton de session chiffré");
  assert.equal(token.includes(ORDER_A), false, "order_id ne doit jamais apparaître en clair dans le jeton de session chiffré");
});

test("TRACKING_SESSION_COOKIE_NAME : nom fixe, ne contient aucune donnée client (mandat §10, 'no customer PII in cookie')", () => {
  assert.equal(typeof TRACKING_SESSION_COOKIE_NAME, "string");
  assert.equal(TRACKING_SESSION_COOKIE_NAME.includes(ORDER_A), false);
  assert.equal(TRACKING_SESSION_COOKIE_NAME.includes(TOKEN_A), false);
});

test("mandat §12 : aucune opération de ce module (succès ou échec) n'invoque console.error/warn/log avec le jeton, l'order_id, ou le secret", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args);
  });
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logs.push(args);
  });
  t.mock.method(console, "log", (...args: unknown[]) => {
    logs.push(args);
  });

  const token = createTrackingSessionToken(ORDER_A, TOKEN_A);
  verifyTrackingSessionToken(token, ORDER_A);
  verifyTrackingSessionToken(token, ORDER_B); // isolation failure
  verifyTrackingSessionToken("garbage", ORDER_A); // malformed
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3 * 60 * 60 * 1000;
    verifyTrackingSessionToken(token, ORDER_A); // expired
  } finally {
    Date.now = realNow;
  }

  assert.equal(logs.length, 0, `ce module ne doit journaliser sous AUCUNE circonstance testée ici : ${JSON.stringify(logs)}`);
});
