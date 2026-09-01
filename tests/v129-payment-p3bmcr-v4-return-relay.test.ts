import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.
// Couvre lib/server/payment-return-relay.ts -- MODÈLE D'ADVERSAIRE
// EXPLICITE (mandat v4 section 13, ferme P3B-V4-PUBLIC-TOKEN-URL-01) :
// falsification (bit-flip), expiration, jeton copié vers une AUTRE
// commande, jeton malformé (plusieurs variantes), clé de version
// inconnue/absente, rotation de clé. Fonction PURE, aucun accès
// réseau/DB -- ce fichier ne mocke AUCUNE RPC.
// ====================================================================

process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

const {
  createReturnRelayToken,
  verifyReturnRelayToken,
  ReturnRelayConfigurationError,
  ReturnRelayTokenInvalidError,
} = await import("../lib/server/payment-return-relay.ts");

const ORDER_ID = "order-relay-1";
const OTHER_ORDER_ID = "order-relay-2";
const PUBLIC_TOKEN = "secret-public-token-DO-NOT-USE";

// --------------------------------------------------------------
// Chemin nominal.
// --------------------------------------------------------------

test("mint puis vérification -- round-trip correct, orderId/publicToken récupérés à l'identique", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const relay = verifyReturnRelayToken(token, ORDER_ID);
  assert.equal(relay.orderId, ORDER_ID);
  assert.equal(relay.publicToken, PUBLIC_TOKEN);
});

test("le jeton minté NE CONTIENT JAMAIS publicToken en clair (base64url décodé ne contient pas la sous-chaîne)", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const decoded = Buffer.from(token, "base64url").toString("latin1");
  assert.ok(!decoded.includes(PUBLIC_TOKEN));
});

// --------------------------------------------------------------
// FALSIFICATION -- toute altération d'un seul octet doit échouer
// (auth tag GCM), jamais un déchiffrement silencieusement corrompu.
// --------------------------------------------------------------

test("FALSIFICATION : bit-flip sur UN SEUL octet du ciphertext -- ReturnRelayTokenInvalidError, jamais un résultat corrompu silencieux", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const packed = Buffer.from(token, "base64url");
  packed[packed.length - 1] ^= 0x01; // dernier octet = fin du ciphertext.
  const tampered = packed.toString("base64url");
  assert.throws(() => verifyReturnRelayToken(tampered, ORDER_ID), ReturnRelayTokenInvalidError);
});

test("FALSIFICATION : bit-flip sur l'authTag lui-même -- ReturnRelayTokenInvalidError", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const packed = Buffer.from(token, "base64url");
  packed[1 + 12] ^= 0xff; // premier octet de l'authTag (après version+iv).
  const tampered = packed.toString("base64url");
  assert.throws(() => verifyReturnRelayToken(tampered, ORDER_ID), ReturnRelayTokenInvalidError);
});

test("FALSIFICATION : bit-flip sur l'IV -- ReturnRelayTokenInvalidError", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const packed = Buffer.from(token, "base64url");
  packed[1] ^= 0xff; // premier octet de l'IV.
  const tampered = packed.toString("base64url");
  assert.throws(() => verifyReturnRelayToken(tampered, ORDER_ID), ReturnRelayTokenInvalidError);
});

// --------------------------------------------------------------
// EXPIRATION.
// --------------------------------------------------------------

test("EXPIRATION : ttlSeconds=1, vérifié après expiration -- ReturnRelayTokenInvalidError", async () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 1 });
  // `exp` est en secondes ENTIÈRES (floor(now/1000) + 1) -- il faut
  // franchir une frontière de seconde ENTIÈRE supplémentaire pour que
  // `payload.exp < floor(Date.now()/1000)` devienne vrai avec certitude
  // (une attente de ~1.1s peut retomber dans la MÊME seconde entière
  // que `exp`, selon l'instant de départ -- 2.2s élimine cette
  // ambiguïté sans dépendre de l'horloge de départ).
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.throws(() => verifyReturnRelayToken(token, ORDER_ID), ReturnRelayTokenInvalidError);
});

// --------------------------------------------------------------
// JETON COPIÉ VERS UNE AUTRE COMMANDE/UN AUTRE TENANT (mandat §13 :
// "wrong order", "token copied across tenants").
// --------------------------------------------------------------

test("JETON COPIÉ : jeton minté pour ORDER_ID, présenté avec expectedOrderId=OTHER_ORDER_ID -- ReturnRelayTokenInvalidError", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  assert.throws(() => verifyReturnRelayToken(token, OTHER_ORDER_ID), ReturnRelayTokenInvalidError);
});

// --------------------------------------------------------------
// PAS DE LIAISON ok/err (mandat §14) : le MÊME jeton reste valide,
// vérifié avec le MÊME orderId, indépendamment de la route -- la
// non-liaison à une route est une propriété du jeton, jamais une
// invitation à sauter la vérification serveur -- déjà couvert
// ailleurs (get_order_payment_status_snapshot reste la seule autorité
// de résultat, jamais ce module).
// --------------------------------------------------------------

test("PAS DE LIAISON ok/err : un jeton minté une fois reste vérifiable identiquement plusieurs fois (pas d'état à usage unique)", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const first = verifyReturnRelayToken(token, ORDER_ID);
  const second = verifyReturnRelayToken(token, ORDER_ID);
  assert.deepEqual(first, second);
});

// --------------------------------------------------------------
// JETON MALFORMÉ -- plusieurs variantes, TOUTES ReturnRelayTokenInvalidError.
// --------------------------------------------------------------

test("MALFORMÉ : chaîne vide -- ReturnRelayTokenInvalidError", () => {
  assert.throws(() => verifyReturnRelayToken("", ORDER_ID), ReturnRelayTokenInvalidError);
});

test("MALFORMÉ : type non-string (undefined) -- ReturnRelayTokenInvalidError", () => {
  assert.throws(() => verifyReturnRelayToken(undefined, ORDER_ID), ReturnRelayTokenInvalidError);
});

test("MALFORMÉ : base64url syntaxiquement invalide (caractères hors alphabet) -- ReturnRelayTokenInvalidError", () => {
  assert.throws(() => verifyReturnRelayToken("!!!not-base64url!!!", ORDER_ID), ReturnRelayTokenInvalidError);
});

test("MALFORMÉ : trop court pour contenir version+iv+authTag -- ReturnRelayTokenInvalidError", () => {
  const tooShort = Buffer.from([1, 2, 3]).toString("base64url");
  assert.throws(() => verifyReturnRelayToken(tooShort, ORDER_ID), ReturnRelayTokenInvalidError);
});

test("MALFORMÉ : longueur excessive (> 4096) -- ReturnRelayTokenInvalidError, jamais un déchiffrement tenté", () => {
  const tooLong = "A".repeat(5000);
  assert.throws(() => verifyReturnRelayToken(tooLong, ORDER_ID), ReturnRelayTokenInvalidError);
});

test("MALFORMÉ : ciphertext valide-forme mais JSON déchiffré de forme inattendue (payload sans oid/pt/exp) -- ReturnRelayTokenInvalidError", () => {
  // Chiffre directement une charge utile de forme incorrecte avec la
  // MÊME clé/algorithme pour produire un jeton syntaxiquement valide
  // mais sémantiquement invalide après déchiffrement réussi.
  const key = Buffer.from(process.env.PAYMENT_RETURN_RELAY_KEY_V1!, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ wrong: "shape" }))), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]);
  assert.throws(() => verifyReturnRelayToken(packed.toString("base64url"), ORDER_ID), ReturnRelayTokenInvalidError);
});

// --------------------------------------------------------------
// CLÉ MANQUANTE / VERSION INCONNUE (mandat §13 : "missing key",
// "key rotation" -- FAIL-CLOSED, JAMAIS un repli implicite).
// --------------------------------------------------------------

test("VERSION DE CLÉ INCONNUE : versionByte pointant vers une variable d'environnement JAMAIS positionnée -- ReturnRelayTokenInvalidError, jamais un repli vers la clé active", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const packed = Buffer.from(token, "base64url");
  packed[0] = 99; // version 99, PAYMENT_RETURN_RELAY_KEY_V99 jamais positionnée.
  assert.throws(() => verifyReturnRelayToken(packed.toString("base64url"), ORDER_ID), ReturnRelayTokenInvalidError);
});

test("MONTAGE : createReturnRelayToken échoue AU MONTAGE (ReturnRelayConfigurationError) si PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION pointe vers une clé absente", () => {
  const previous = process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION;
  process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION = "7"; // V7 jamais positionnée.
  try {
    assert.throws(
      () => createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 }),
      ReturnRelayConfigurationError
    );
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION;
    else process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION = previous;
  }
});

// --------------------------------------------------------------
// ROTATION DE CLÉ (mandat §13) : une clé RETIRÉE de la rotation ACTIVE
// reste déchiffrable tant que sa variable d'environnement existe --
// fenêtre de transition explicite.
// --------------------------------------------------------------

test("ROTATION : jeton minté sous la clé V1 ACTIVE reste vérifiable après le basculement de la clé active vers V2 (V1 toujours positionnée -- fenêtre de transition)", () => {
  process.env.PAYMENT_RETURN_RELAY_KEY_V2 ??=
    "b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5";
  const tokenUnderV1 = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });

  const previous = process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION;
  process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION = "2";
  try {
    // Nouvelle émission utilise désormais V2.
    const tokenUnderV2 = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
    assert.notEqual(Buffer.from(tokenUnderV2, "base64url")[0], Buffer.from(tokenUnderV1, "base64url")[0]);
    // L'ANCIEN jeton (version 1, embarquée dans le jeton lui-même)
    // reste déchiffrable -- V1 toujours positionnée dans l'environnement.
    const relay = verifyReturnRelayToken(tokenUnderV1, ORDER_ID);
    assert.equal(relay.publicToken, PUBLIC_TOKEN);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION;
    else process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION = previous;
  }
});

test("ROTATION : jeton minté sous V1, V1 ENTIÈREMENT RETIRÉE de l'environnement -- ReturnRelayTokenInvalidError (pas de secret orphelin qui déchiffre indéfiniment)", () => {
  const token = createReturnRelayToken({ orderId: ORDER_ID, publicToken: PUBLIC_TOKEN, ttlSeconds: 900 });
  const previous = process.env.PAYMENT_RETURN_RELAY_KEY_V1;
  delete process.env.PAYMENT_RETURN_RELAY_KEY_V1;
  try {
    assert.throws(() => verifyReturnRelayToken(token, ORDER_ID), ReturnRelayTokenInvalidError);
  } finally {
    process.env.PAYMENT_RETURN_RELAY_KEY_V1 = previous;
  }
});
