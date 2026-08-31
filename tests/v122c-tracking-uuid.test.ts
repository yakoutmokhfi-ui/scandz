import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 — lib/tracking/uuid.ts.
//
// Validation de FORME pure (mandat §25/§34, "NULL/malformed route
// input -> safe failure"). Ne prétend jamais distinguer un UUID
// "valide mais inconnu" d'un "malformé" -- seulement la FORME.
// ====================================================================

const { isPlausibleUuid } = await import("../lib/tracking/uuid.ts");

test("isPlausibleUuid: accepte un UUID v4 bien formé, insensible à la casse", () => {
  assert.equal(isPlausibleUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isPlausibleUuid("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"), true);
});

test("isPlausibleUuid: rejette chaînes vides, null, undefined, nombres, objets", () => {
  for (const bad of ["", null, undefined, 42, {}, [], true]) {
    assert.equal(isPlausibleUuid(bad), false);
  }
});

test("isPlausibleUuid: rejette un UUID malformé (mauvaise longueur/segments/caractères)", () => {
  for (const bad of [
    "11111111-1111-4111-8111-11111111111", // trop court
    "11111111-1111-4111-8111-1111111111111", // trop long
    "11111111_1111_4111_8111_111111111111", // mauvais séparateur
    "not-a-uuid-at-all",
    "11111111-1111-4111-8111-11111111111g", // caractère hors hexadécimal
    " 11111111-1111-4111-8111-111111111111", // espace parasite
    "11111111-1111-4111-8111-111111111111 ",
  ]) {
    assert.equal(isPlausibleUuid(bad), false);
  }
});

test("isPlausibleUuid: injection SQL/texte arbitraire dans une entrée de route -- toujours rejeté, jamais une exception levée", () => {
  assert.doesNotThrow(() => isPlausibleUuid("'; drop table orders; --"));
  assert.equal(isPlausibleUuid("'; drop table orders; --"), false);
});
