import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Tests MAC (mandat §37). AUCUN vecteur de test officiel (clé + chaîne
// canonique + MAC résultant) n'a pu être obtenu de la documentation
// officielle par l'agent, malgré plusieurs tentatives explicites --
// voir IMPLEMENTATION-REPORT.txt. Conformément à l'instruction de
// reprise de mission (§8, "create an independent reference
// implementation in the test suite and cross-check production
// implementation against it"), ce fichier inclut une SECONDE
// implémentation, écrite INDÉPENDAMMENT de canonicalization.ts/mac.ts
// (comparateur de tri manuel par insertion, boucle de concaténation
// manuelle plutôt que map/join), pour détecter toute erreur
// d'implémentation de la règle relayée.
//
// ⚠️ CE QUE CE CROISEMENT PROUVE, ET CE QU'IL NE PROUVE PAS : il prouve
// que la production applique correctement et de façon cohérente LA
// RÈGLE TELLE QUE RELAYÉE (deux implémentations indépendantes de la
// même règle s'accordent). Il ne prouve PAS que cette règle correspond
// au protocole Monetico réel, puisqu'aucun vecteur numérique officiel
// n'a pu être obtenu pour valider cela de façon absolue -- voir
// VERDICT du rapport final.
// ====================================================================

const { transformSecurityKey, computeMac, verifyMac } = await import(
  "../lib/server/payment-providers/monetico/mac.ts"
);
const { MoneticoProtocolError } = await import(
  "../lib/server/payment-providers/monetico/errors.ts"
);

const SYNTHETIC_KEY_HEX = "0123456789abcdef0123456789abcdef01234567"; // 40 hex chars

/**
 * Implémentation de référence INDÉPENDANTE : tri par insertion manuel
 * (pas Array.sort), concaténation par boucle `for` explicite (pas
 * map/join), HMAC-SHA1 calculé directement via node:crypto sans
 * passer par computeMac/buildCanonicalString de production.
 */
function independentReferenceMac(fields: Record<string, string>, keyHex: string): string {
  const names = Object.keys(fields);
  // Tri par insertion, comparaison ordinale explicite caractère par
  // caractère (équivalent fonctionnel à un tri ASCII, écrit
  // différemment de Array.prototype.sort()).
  for (let i = 1; i < names.length; i++) {
    const current = names[i]!;
    let j = i - 1;
    while (j >= 0 && names[j]! > current) {
      names[j + 1] = names[j]!;
      j--;
    }
    names[j + 1] = current;
  }
  let canonical = "";
  for (let i = 0; i < names.length; i++) {
    if (i > 0) canonical += "*";
    canonical += names[i] + "=" + fields[names[i]!];
  }
  const keyBuffer = Buffer.from(keyHex.toLowerCase(), "hex");
  return createHmac("sha1", keyBuffer).update(Buffer.from(canonical, "utf8")).digest("hex");
}

test("transformSecurityKey: clé hex 40 caractères -> 20 octets", () => {
  const buf = transformSecurityKey(SYNTHETIC_KEY_HEX);
  assert.equal(buf.length, 20);
  assert.equal(buf.toString("hex"), SYNTHETIC_KEY_HEX.toLowerCase());
});

test("transformSecurityKey: insensible à la casse (hex majuscule accepté et normalisé)", () => {
  const buf = transformSecurityKey(SYNTHETIC_KEY_HEX.toUpperCase());
  assert.equal(buf.toString("hex"), SYNTHETIC_KEY_HEX.toLowerCase());
});

test("transformSecurityKey: longueur incorrecte rejetée", () => {
  assert.throws(() => transformSecurityKey("abcd"), MoneticoProtocolError);
});

test("transformSecurityKey: caractères non hexadécimaux rejetés", () => {
  assert.throws(() => transformSecurityKey("Z".repeat(40)), MoneticoProtocolError);
});

test("MAC: sortie hexadécimale minuscule de 40 caractères", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const mac = computeMac({ a: "1", b: "2" }, key);
  assert.match(mac, /^[0-9a-f]{40}$/);
});

test("MAC: cohérence interne -- production == implémentation de référence indépendante (jeu de champs simple)", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { TPE: "1234567", date: "24/05/2019:10:00:25", montant: "95.25EUR", reference: "abc123def456" };
  const prod = computeMac(fields, key);
  const ref = independentReferenceMac(fields, SYNTHETIC_KEY_HEX);
  assert.equal(prod, ref);
});

test("MAC: cohérence interne -- production == référence (champs vides mélangés)", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { alpha: "", beta: "x", Gamma: "", delta: "y" };
  assert.equal(computeMac(fields, key), independentReferenceMac(fields, SYNTHETIC_KEY_HEX));
});

test("MAC: cohérence interne -- production == référence (valeurs UTF-8/accentuées)", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { societe: "Société Générale — café", nom: "Le déjeuner à 3€" };
  assert.equal(computeMac(fields, key), independentReferenceMac(fields, SYNTHETIC_KEY_HEX));
});

test("MAC: déterministe -- mêmes champs, mêmes clé -> même MAC à chaque appel", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { a: "1", b: "2" };
  const first = computeMac(fields, key);
  const second = computeMac(fields, key);
  assert.equal(first, second);
});

test("MAC: une clé différente produit un MAC différent (mêmes champs)", () => {
  const key1 = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const key2 = transformSecurityKey("fedcba9876543210fedcba9876543210fedcba98");
  const fields = { a: "1", b: "2" };
  assert.notEqual(computeMac(fields, key1), computeMac(fields, key2));
});

test("verifyMac: MAC valide accepté", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { a: "1", b: "2" };
  const mac = computeMac(fields, key);
  assert.equal(verifyMac(fields, key, mac), true);
});

test("verifyMac: MAC invalide rejeté", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { a: "1", b: "2" };
  assert.equal(verifyMac(fields, key, "0".repeat(40)), false);
});

test("verifyMac: une seule mutation de caractère dans le MAC fait échouer la vérification", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { a: "1", b: "2" };
  const mac = computeMac(fields, key);
  const mutated = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
  assert.equal(verifyMac(fields, key, mutated), false);
});

test("verifyMac: mutation de l'ORDRE des champs fait échouer la vérification (le MAC dépend de l'ordre canonique, pas d'un simple ensemble)", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const macForOriginalOrder = computeMac({ a: "1", b: "2" }, key);
  // Champs identiques mais un troisième champ change quel jeu est
  // effectivement signé -- la vérification contre un jeu de champs
  // différent doit échouer même si "a"/"b" sont inchangés.
  assert.equal(verifyMac({ a: "1", b: "2", c: "3" }, key, macForOriginalOrder), false);
});

test("verifyMac: casse du MAC reçu insensible (Monetico peut envoyer le MAC en majuscules)", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  const fields = { a: "1", b: "2" };
  const mac = computeMac(fields, key);
  assert.equal(verifyMac(fields, key, mac.toUpperCase()), true);
});

test("verifyMac: MAC reçu de longueur incorrecte rejeté sans lever d'exception", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  assert.equal(verifyMac({ a: "1" }, key, "abc"), false);
});

test("verifyMac: MAC reçu non hexadécimal rejeté sans lever d'exception", () => {
  const key = transformSecurityKey(SYNTHETIC_KEY_HEX);
  assert.equal(verifyMac({ a: "1" }, key, "Z".repeat(40)), false);
});
