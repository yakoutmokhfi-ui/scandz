import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Tests d'ORDRE DE CHAMP DÉTERMINISTE (mandat §12) pour
// buildCanonicalString (canonicalization.ts). Voir la note de
// provenance en tête de ce fichier de production : la règle testée
// ici a été relayée par l'opérateur humain et n'a pas pu être vérifiée
// par l'agent contre le PDF officiel brut malgré plusieurs tentatives
// -- ces tests prouvent la COHÉRENCE INTERNE de l'implémentation de
// cette règle (ordre/séparateur/casse/encodage), PAS sa conformité au
// protocole Monetico réel.
// ====================================================================

const { buildCanonicalString } = await import(
  "../lib/server/payment-providers/monetico/canonicalization.ts"
);

test("canonicalisation: champs joints par '=' puis '*', triés par ordre ASCII du nom de champ", () => {
  const result = buildCanonicalString({ zeta: "9", alpha: "1", mu: "5" });
  assert.equal(result, "alpha=1*mu=5*zeta=9");
});

test("canonicalisation: tri ASCII sensible à la casse -- majuscule avant minuscule (T avant d)", () => {
  // 'T' (ASCII 84) < 'd' (ASCII 100) : un tri ordinal place "TPE"
  // avant "date", ce qu'un tri alphabétique naïf insensible à la
  // casse ne ferait PAS.
  const result = buildCanonicalString({ date: "24/05/2019", TPE: "1234567" });
  assert.equal(result, "TPE=1234567*date=24/05/2019");
});

test("canonicalisation: noms de champ à casse mixte -- ordre ordinal strict démontré sur plusieurs champs", () => {
  const result = buildCanonicalString({
    societe: "s1",
    TPE: "t1",
    montant: "m1",
    MAC: "should-not-appear-in-this-test-but-treated-like-any-field",
    date: "d1",
  });
  // Ordre ordinal attendu : MAC(77,65,67) < TPE(84,80,69) < date < montant < societe
  assert.equal(
    result,
    "MAC=should-not-appear-in-this-test-but-treated-like-any-field*TPE=t1*date=d1*montant=m1*societe=s1"
  );
});

test("canonicalisation: champ à valeur vide inclus tel quel ('nom=')", () => {
  const result = buildCanonicalString({ alpha: "", beta: "x" });
  assert.equal(result, "alpha=*beta=x");
});

test("canonicalisation: champs multiples avec valeurs vides mélangées à des valeurs peuplées", () => {
  const result = buildCanonicalString({ a: "1", b: "", c: "3", d: "" });
  assert.equal(result, "a=1*b=*c=3*d=");
});

test("canonicalisation: valeurs accentuées/UTF-8 préservées EXACTEMENT, jamais normalisées", () => {
  const result = buildCanonicalString({ nom: "Société Générale — café" });
  assert.equal(result, "nom=Société Générale — café");
});

test("canonicalisation: caractères nécessitant une préservation exacte (espace, astérisque, égal dans une valeur)", () => {
  const result = buildCanonicalString({ texte: "a=b*c d" });
  assert.equal(result, "texte=a=b*c d");
});

test("canonicalisation: un seul champ ne produit aucun séparateur", () => {
  const result = buildCanonicalString({ seul: "valeur" });
  assert.equal(result, "seul=valeur");
});

test("canonicalisation: objet de champs vide produit une chaîne vide", () => {
  const result = buildCanonicalString({});
  assert.equal(result, "");
});

test("canonicalisation: déterministe -- deux appels avec le même objet (ordre de propriété différent) produisent la même chaîne", () => {
  const a = buildCanonicalString({ z: "1", a: "2" });
  const b = buildCanonicalString({ a: "2", z: "1" });
  assert.equal(a, b);
});
