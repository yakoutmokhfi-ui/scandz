import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 —
// lib/services/catalogue-error.ts (2 codes fiscaux/mesure, SIMPLIFIÉ
// depuis les 7 codes de v1 -- sales_unit/price_mode/weight_mode/
// price_per_weight_rate/la combinaison ont tous disparu avec le mode
// price_per_weight lui-même, mandat v1.1 §16).
//
// Même patron que le bloc "2. lib/services/catalogue-error.ts" de
// tests/v66-categories-descriptions.test.ts : classification stricte
// sur le COUPLE code ET message, jamais sur le code seul.
// ====================================================================

const {
  INVALID_TAX_RATE_CODE,
  INVALID_WEIGHT_VALUE_CODE,
  SHORT_DESCRIPTION_TOO_LONG_CODE,
  FiscalMeasurementValidationError,
  isFiscalMeasurementValidationError,
} = await import("../lib/services/catalogue-error.ts");

test("codes fiscaux: les 2 constantes ont exactement les valeurs attendues par la migration SQL et lib/catalogue-fiscal.ts", () => {
  assert.equal(INVALID_TAX_RATE_CODE, "SCANYM_INVALID_TAX_RATE");
  assert.equal(INVALID_WEIGHT_VALUE_CODE, "SCANYM_INVALID_WEIGHT_VALUE");
});

test("aucun code fiscal résiduel de v1 (price_mode/sales_unit/weight_mode/price_per_weight/combinaison) n'est exporté", async () => {
  const mod = await import("../lib/services/catalogue-error.ts");
  const names = Object.keys(mod);
  assert.deepEqual(
    names.filter((n) => /SALES_UNIT|PRICE_MODE|WEIGHT_MODE|PER_WEIGHT|COMBINATION/i.test(n)),
    [],
    `export résiduel du modèle v1 rejeté trouvé : ${names.join(", ")}`
  );
});

test("FiscalMeasurementValidationError: porte le code exact passé au constructeur, distinct par instance", () => {
  const err = new FiscalMeasurementValidationError(INVALID_TAX_RATE_CODE);
  assert.equal(err.code, INVALID_TAX_RATE_CODE);
  assert.equal(err.name, "FiscalMeasurementValidationError");
  assert.equal(err.message, INVALID_TAX_RATE_CODE);
  assert.ok(err instanceof Error);

  const err2 = new FiscalMeasurementValidationError(INVALID_WEIGHT_VALUE_CODE);
  assert.equal(err2.code, INVALID_WEIGHT_VALUE_CODE);
  assert.notEqual(err.code, err2.code);
});

test("isFiscalMeasurementValidationError: reconnaît les 2 codes sur 22001, rejette un couple faux", () => {
  for (const code of [INVALID_TAX_RATE_CODE, INVALID_WEIGHT_VALUE_CODE]) {
    assert.equal(isFiscalMeasurementValidationError({ code: "22001", message: code }), true, code);
  }
});

test("isFiscalMeasurementValidationError: rejette un code SQLSTATE différent même avec le bon message", () => {
  assert.equal(isFiscalMeasurementValidationError({ code: "23505", message: INVALID_TAX_RATE_CODE }), false);
});

test("isFiscalMeasurementValidationError: ne requalifie JAMAIS une autre erreur 22001 du même dépôt (ex. SHORT_DESCRIPTION_TOO_LONG)", () => {
  assert.equal(
    isFiscalMeasurementValidationError({ code: "22001", message: SHORT_DESCRIPTION_TOO_LONG_CODE }),
    false
  );
});

test("isFiscalMeasurementValidationError: rejette d'anciens codes v1 (price_per_weight/combinaison) même sur 22001 -- ils n'existent plus", () => {
  assert.equal(
    isFiscalMeasurementValidationError({ code: "22001", message: "SCANYM_INVALID_FISCAL_MEASUREMENT_COMBINATION" }),
    false
  );
  assert.equal(
    isFiscalMeasurementValidationError({ code: "22001", message: "SCANYM_INVALID_PRICE_PER_WEIGHT_RATE" }),
    false
  );
});

test("isFiscalMeasurementValidationError: erreur absente/nulle jamais reconnue", () => {
  assert.equal(isFiscalMeasurementValidationError(null), false);
  assert.equal(isFiscalMeasurementValidationError(undefined), false);
  assert.equal(isFiscalMeasurementValidationError({ code: "22001", message: null }), false);
});
