import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 —
// lib/catalogue-fiscal.ts. SIMPLIFIED FIXED-PRICE PORTION MODEL.
//
// v1 introduisait un second mode de prix (`price_mode =
// 'price_per_weight'`) alors que create_order calcule TOUJOURS
// `price × quantity` -- Work a rejeté ce candidat (CAT-FISCAL-01,
// FAIL). v1.1 SUPPRIME ce mode : ce fichier remplace intégralement
// l'ancien tests/v130-catalogue-fiscal.test.ts (matrice de
// combinaison, computeEstimatedLineTotal) par la couverture du modèle
// simplifié : SEULEMENT tax_rate et unit_weight_grams sont éditables,
// INDÉPENDANTS l'un de l'autre (mandat §22, plus de matrice d'états).
// ====================================================================

const {
  DEFAULT_FISCAL_MEASUREMENT_FIELDS,
  validateFiscalMeasurementFields,
  referencePricePerKg,
  estimatedLogisticalWeightGrams,
  gramsToKgDisplayValue,
} = await import("../lib/catalogue-fiscal.ts");

test("DEFAULT_FISCAL_MEASUREMENT_FIELDS: valeurs par défaut sûres (mandat §17, jamais une valeur inventée)", () => {
  assert.deepEqual(DEFAULT_FISCAL_MEASUREMENT_FIELDS, {
    taxRate: null,
    unitWeightGrams: null,
    weightIsApproximate: false,
  });
  assert.equal(
    validateFiscalMeasurementFields(DEFAULT_FISCAL_MEASUREMENT_FIELDS),
    null,
    "le défaut doit toujours être valide -- rétrocompatibilité produits existants"
  );
});

// --------------------------------------------------------------------
// validateFiscalMeasurementFields -- 2 champs INDÉPENDANTS, plus de
// matrice de combinaison croisée (mandat §22).
// --------------------------------------------------------------------

test("validateFiscalMeasurementFields: tax_rate hors [0,100] rejeté, bornes incluses acceptées", () => {
  const base = { ...DEFAULT_FISCAL_MEASUREMENT_FIELDS };
  assert.equal(validateFiscalMeasurementFields({ ...base, taxRate: -0.01 }), "SCANYM_INVALID_TAX_RATE");
  assert.equal(validateFiscalMeasurementFields({ ...base, taxRate: 100.01 }), "SCANYM_INVALID_TAX_RATE");
  assert.equal(validateFiscalMeasurementFields({ ...base, taxRate: 0 }), null);
  assert.equal(validateFiscalMeasurementFields({ ...base, taxRate: 100 }), null);
  assert.equal(validateFiscalMeasurementFields({ ...base, taxRate: 5.5 }), null);
});

test("validateFiscalMeasurementFields: unit_weight_grams négatif ou nul rejeté, positif accepté", () => {
  const base = { ...DEFAULT_FISCAL_MEASUREMENT_FIELDS };
  assert.equal(validateFiscalMeasurementFields({ ...base, unitWeightGrams: 0 }), "SCANYM_INVALID_WEIGHT_VALUE");
  assert.equal(validateFiscalMeasurementFields({ ...base, unitWeightGrams: -100 }), "SCANYM_INVALID_WEIGHT_VALUE");
  assert.equal(validateFiscalMeasurementFields({ ...base, unitWeightGrams: 200 }), null);
  assert.equal(validateFiscalMeasurementFields({ ...base, unitWeightGrams: null }), null);
});

test("validateFiscalMeasurementFields: weightIsApproximate n'affecte JAMAIS la validité (purement informatif, mandat §5)", () => {
  const base = { taxRate: 5.5, unitWeightGrams: 200, weightIsApproximate: false };
  assert.equal(validateFiscalMeasurementFields(base), null);
  assert.equal(validateFiscalMeasurementFields({ ...base, weightIsApproximate: true }), null);
});

test("validateFiscalMeasurementFields: tax_rate et unit_weight_grams sont INDÉPENDANTS -- aucune combinaison des deux n'est jamais rejetée pour un troisième motif", () => {
  // Toute combinaison de valeurs individuellement valides doit rester
  // valide, quelle que soit l'association -- il n'existe plus de
  // matrice d'états croisés (contrairement à v1).
  const taxRates = [null, 0, 5.5, 19, 100];
  const weights = [null, 1, 200, 1800];
  for (const taxRate of taxRates) {
    for (const unitWeightGrams of weights) {
      assert.equal(
        validateFiscalMeasurementFields({ taxRate, unitWeightGrams, weightIsApproximate: false }),
        null,
        `taxRate=${taxRate}, unitWeightGrams=${unitWeightGrams} devrait être valide`
      );
    }
  }
});

// --------------------------------------------------------------------
// referencePricePerKg -- MÉTADONNÉE DE RÉFÉRENCE UNIQUEMENT (mandat
// §6), jamais une autorité. Reproduit la formule de la colonne
// GÉNÉRÉE côté base : price / (unit_weight_grams / 1000), arrondi.
// --------------------------------------------------------------------

test("referencePricePerKg: raclette canonique du mandat -- 7.50 € / 200 g = 37.50 €/kg", () => {
  assert.equal(referencePricePerKg(7.5, 200), 37.5);
});

test("referencePricePerKg: fromage 32.90 € / 1000 g = 32.90 €/kg", () => {
  assert.equal(referencePricePerKg(32.9, 1000), 32.9);
});

test("referencePricePerKg: poids absent ou non positif -> null (jamais une valeur inventée)", () => {
  assert.equal(referencePricePerKg(7.5, null), null);
  assert.equal(referencePricePerKg(7.5, 0), null);
  assert.equal(referencePricePerKg(7.5, -50), null);
});

test("referencePricePerKg: arrondi au centime, decimal-safe (pas d'accumulation flottante)", () => {
  // 4.99 € / 333 g = 14.984984... €/kg -> 14.98 arrondi.
  assert.equal(referencePricePerKg(4.99, 333), 14.98);
});

// --------------------------------------------------------------------
// estimatedLogisticalWeightGrams -- fondation de DONNÉES pour un futur
// usage logistique (mandat §14), JAMAIS un calcul financier.
// --------------------------------------------------------------------

test("estimatedLogisticalWeightGrams: raclette canonique -- 200g × 2 = 400g (mandat §2/§26, exemple explicite)", () => {
  assert.equal(estimatedLogisticalWeightGrams(200, 2), 400);
});

test("estimatedLogisticalWeightGrams: poids unitaire absent -> null", () => {
  assert.equal(estimatedLogisticalWeightGrams(null, 3), null);
});

test("estimatedLogisticalWeightGrams: quantité 1 -> égal au poids unitaire", () => {
  assert.equal(estimatedLogisticalWeightGrams(1800, 1), 1800);
});

// --------------------------------------------------------------------
// gramsToKgDisplayValue -- affichage uniquement.
// --------------------------------------------------------------------

test("gramsToKgDisplayValue: une décimale sous 10kg, entier au-delà", () => {
  assert.equal(gramsToKgDisplayValue(1800), 1.8);
  assert.equal(gramsToKgDisplayValue(400), 0.4);
  assert.equal(gramsToKgDisplayValue(1000), 1);
  assert.equal(gramsToKgDisplayValue(15000), 15);
});

// --------------------------------------------------------------------
// CAT-FISCAL-01 CLOSURE (mandat §18) -- preuve qu'AUCUNE fonction de
// ce module ne calcule un montant de commande à partir d'un poids.
// --------------------------------------------------------------------

test("CAT-FISCAL-01 CLOSURE: ce module n'exporte aucune fonction de calcul de montant pondéré (price × weight)", async () => {
  const mod = await import("../lib/catalogue-fiscal.ts");
  const exportNames = Object.keys(mod);
  // v1 exportait computeEstimatedLineTotal (price_mode/price_per_weight).
  // v1.1 ne doit plus exposer aucune fonction de ce type.
  assert.deepEqual(
    exportNames.filter((n) => /priceMode|PerWeight|LineTotal/i.test(n)),
    [],
    `des exports laissent supposer un second moteur de prix au poids : ${exportNames.join(", ")}`
  );
});
