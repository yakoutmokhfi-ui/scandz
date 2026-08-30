import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1.
//
// Couvre lib/server/payment-providers/monetico/billing-mapping.ts --
// SEULE couche autorisée à traduire le vocabulaire interne
// (`OrderBillingContext`) vers le vocabulaire Monetico exact (mandat
// §16). Fonctions PURES, aucun mock nécessaire.
// ====================================================================

const { mapToMoneticoBilling, mapToMoneticoShipping } = await import(
  "../lib/server/payment-providers/monetico/billing-mapping.ts"
);
const { MoneticoProtocolError } = await import(
  "../lib/server/payment-providers/monetico/errors.ts"
);

function fullContext(overrides: Record<string, unknown> = {}) {
  return {
    source: "manual" as const,
    addressLine1: "12 rue de Paris",
    addressLine2: "Bat B",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
    stateOrProvince: "FR-IDF",
    customerName: "Jean Dupont",
    customerEmail: "jean@example.com",
    customerPhone: "0612345678",
    ...overrides,
  };
}

test("mapToMoneticoBilling: mapping complet -- toutes les clés Monetico exactes présentes", () => {
  const result = mapToMoneticoBilling(fullContext());
  assert.deepEqual(result, {
    addressLine1: "12 rue de Paris",
    addressLine2: "Bat B",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
    stateOrProvince: "FR-IDF",
    name: "Jean Dupont",
    email: "jean@example.com",
    phone: "0612345678",
  });
});

test("mapToMoneticoBilling: JAMAIS de firstName/lastName/civility/company (mandat §4/§16 -- pas de scission du nom)", () => {
  const result = mapToMoneticoBilling(fullContext());
  const keys = Object.keys(result);
  assert.ok(!keys.includes("firstName"));
  assert.ok(!keys.includes("lastName"));
  assert.ok(!keys.includes("civility"));
  assert.ok(!keys.includes("company"));
});

test("mapToMoneticoBilling: champs optionnels absents -> OMIS (jamais une clé avec valeur vide/null, mandat §5/§17)", () => {
  const result = mapToMoneticoBilling(
    fullContext({
      addressLine2: null,
      stateOrProvince: null,
      customerName: null,
      customerEmail: null,
      customerPhone: null,
    })
  );
  assert.deepEqual(result, {
    addressLine1: "12 rue de Paris",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  });
  assert.equal("addressLine2" in result, false);
  assert.equal("stateOrProvince" in result, false);
  assert.equal("name" in result, false);
  assert.equal("email" in result, false);
  assert.equal("phone" in result, false);
});

test("mapToMoneticoBilling: champ optionnel blanc (espaces) -> également OMIS, pas juste null/undefined", () => {
  const result = mapToMoneticoBilling(fullContext({ customerName: "   " }));
  assert.equal("name" in result, false);
});

test("mapToMoneticoBilling: country toujours normalisé en majuscule", () => {
  const result = mapToMoneticoBilling(fullContext({ country: "fr" }));
  assert.equal(result.country, "FR");
});

for (const field of ["addressLine1", "city", "postalCode"] as const) {
  test(`mapToMoneticoBilling: ${field} manquant/vide -> fail-closed (MoneticoProtocolError)`, () => {
    assert.throws(
      () => mapToMoneticoBilling(fullContext({ [field]: "" })),
      MoneticoProtocolError
    );
    assert.throws(
      () => mapToMoneticoBilling(fullContext({ [field]: null })),
      MoneticoProtocolError
    );
  });
}

test("mapToMoneticoBilling: country malformé -> fail-closed (MoneticoProtocolError)", () => {
  assert.throws(() => mapToMoneticoBilling(fullContext({ country: "France" })), MoneticoProtocolError);
  assert.throws(() => mapToMoneticoBilling(fullContext({ country: "" })), MoneticoProtocolError);
});

test("mapToMoneticoBilling: bornes de longueur Monetico appliquées défensivement (addressLine1 > 50 -> rejeté)", () => {
  assert.throws(
    () => mapToMoneticoBilling(fullContext({ addressLine1: "x".repeat(51) })),
    MoneticoProtocolError
  );
});
test("mapToMoneticoBilling: addressLine1 exactement 50 caractères -> accepté (limite inclusive)", () => {
  const result = mapToMoneticoBilling(fullContext({ addressLine1: "x".repeat(50) }));
  assert.equal(result.addressLine1.length, 50);
});

test("mapToMoneticoBilling: customerName > 45 caractères -> rejeté", () => {
  assert.throws(
    () => mapToMoneticoBilling(fullContext({ customerName: "x".repeat(46) })),
    MoneticoProtocolError
  );
});

test("mapToMoneticoShipping: structurellement identique à mapToMoneticoBilling, réutilisée intégralement (mandat §14, aucune seconde implémentation)", () => {
  const ctx = fullContext();
  assert.deepEqual(mapToMoneticoShipping(ctx), mapToMoneticoBilling(ctx));
});

test("mapToMoneticoShipping: fail-closed identique (aucune règle de validation dupliquée/divergente)", () => {
  assert.throws(() => mapToMoneticoShipping(fullContext({ city: "" })), MoneticoProtocolError);
});

// ====================================================================
// v2 CORRECTIF -- ferme P3B6-MONETICO-FORMAT-01.
//
// stateOrProvince : forme ISO 3166-2 CONSERVATRICE (2 lettres pays +
// tiret + 1-3 alphanumériques), PAS une validation d'appartenance au
// registre complet (mandat v2 §6 -- documenté explicitement dans
// billing-mapping.ts). phone : contenu numérique, "+" optionnel en
// première position UNIQUEMENT, espaces supprimés (seule normalisation
// autorisée), aucune autre ponctuation/lettre.
// ====================================================================

const STATE_OR_PROVINCE_PASS = ["FR-IDF", "US-CA", "fr-idf", "US-ca"];
for (const value of STATE_OR_PROVINCE_PASS) {
  test(`mapToMoneticoBilling: stateOrProvince "${value}" -- forme ISO 3166-2 valide -> accepté (normalisé majuscule)`, () => {
    const result = mapToMoneticoBilling(fullContext({ stateOrProvince: value }));
    assert.equal(result.stateOrProvince, value.toUpperCase());
  });
}

const STATE_OR_PROVINCE_FAIL = [
  "IDF", // pas de préfixe pays
  "CA", // pas de préfixe pays (ambigu avec le code pays Canada)
  "France Ile-de-France", // texte libre
  "FR_IDF", // séparateur incorrect (underscore, pas tiret)
  "FR-", // suffixe vide
  "FR-TROPLONG1", // suffixe > 3 caractères
  "FRA-IDF", // préfixe pays à 3 lettres
  "FR - IDF", // espace interne (jamais silencieusement supprimé)
  "F-IDF", // préfixe pays à 1 lettre
];
for (const value of STATE_OR_PROVINCE_FAIL) {
  test(`mapToMoneticoBilling: stateOrProvince "${value}" -- forme ISO 3166-2 invalide -> rejeté (MoneticoProtocolError), JAMAIS omis silencieusement`, () => {
    assert.throws(
      () => mapToMoneticoBilling(fullContext({ stateOrProvince: value })),
      MoneticoProtocolError
    );
  });
}

test("mapToMoneticoBilling: stateOrProvince absent/blanc -> omis (comportement inchangé, pas un rejet)", () => {
  assert.equal("stateOrProvince" in mapToMoneticoBilling(fullContext({ stateOrProvince: null })), false);
  assert.equal(
    "stateOrProvince" in mapToMoneticoBilling(fullContext({ stateOrProvince: "   " })),
    false
  );
});

test("mapToMoneticoBilling: stateOrProvince valide mais > 10 caractères après trim -> rejeté (borne de longueur ET forme)", () => {
  assert.throws(
    () => mapToMoneticoBilling(fullContext({ stateOrProvince: "FR-" + "A".repeat(9) })),
    MoneticoProtocolError
  );
});

const PHONE_PASS: Array<[string, string]> = [
  ["0612345678", "0612345678"],
  ["+33612345678", "+33612345678"],
  ["06 12 34 56 78", "0612345678"], // espaces supprimés -- seule normalisation autorisée
  ["+33 6 12 34 56 78", "+33612345678"],
];
for (const [input, expected] of PHONE_PASS) {
  test(`mapToMoneticoBilling: phone "${input}" -- forme valide -> accepté, canonique = "${expected}"`, () => {
    const result = mapToMoneticoBilling(fullContext({ customerPhone: input }));
    assert.equal(result.phone, expected);
  });
}

const PHONE_FAIL = [
  "++33612345678", // "+" répété
  "06+12345678", // "+" mal placé (pas en première position)
  "06.12.34.56.78", // ponctuation (points) -- jamais silencieusement supprimée comme les espaces
  "06-12-34-56-78", // ponctuation (tirets)
  "(06)12345678", // parenthèses
  "0612345O78", // lettre "O" au lieu d'un chiffre
  "phone: 0612345678", // texte libre mêlé à des chiffres
];
for (const value of PHONE_FAIL) {
  test(`mapToMoneticoBilling: phone "${value}" -- forme invalide -> rejeté (MoneticoProtocolError), JAMAIS réécrit vers un autre numéro`, () => {
    assert.throws(
      () => mapToMoneticoBilling(fullContext({ customerPhone: value })),
      MoneticoProtocolError
    );
  });
}

test("mapToMoneticoBilling: phone absent/blanc -> omis (comportement inchangé, pas un rejet)", () => {
  assert.equal("phone" in mapToMoneticoBilling(fullContext({ customerPhone: null })), false);
  assert.equal("phone" in mapToMoneticoBilling(fullContext({ customerPhone: "   " })), false);
});

test("mapToMoneticoBilling: phone valide mais > 18 caractères APRÈS suppression des espaces -> rejeté", () => {
  assert.throws(
    () => mapToMoneticoBilling(fullContext({ customerPhone: "+" + "1".repeat(19) })),
    MoneticoProtocolError
  );
});

test("mapToMoneticoBilling: phone exactement 18 caractères après suppression des espaces -> accepté (limite inclusive)", () => {
  const result = mapToMoneticoBilling(
    fullContext({ customerPhone: "+" + "1".repeat(17) })
  );
  assert.equal(result.phone!.length, 18);
});
