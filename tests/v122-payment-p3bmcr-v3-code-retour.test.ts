import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3.
// Tests du classificateur code-retour canonique (ferme V2-05).
// Matrice exhaustive re-vérifiée fraîchement contre le document
// technique Monetico v2.0 §1.4.3.1 -- voir l'en-tête de
// lib/server/payment-providers/monetico/code-retour.ts pour la
// citation complète.
// ====================================================================

const { classifyMoneticoCodeRetour, moneticoClassificationToProviderEventType } = await import(
  "../lib/server/payment-providers/monetico/code-retour.ts"
);

test("code-retour: payetest -> paid, non fractionné", () => {
  const r = classifyMoneticoCodeRetour("payetest");
  assert.equal(r.classification, "paid");
  assert.equal(r.isSplitPaymentInstallment, false);
  assert.equal(r.splitInstallmentNumber, null);
});

test("code-retour: paiement -> paid, non fractionné", () => {
  const r = classifyMoneticoCodeRetour("paiement");
  assert.equal(r.classification, "paid");
  assert.equal(r.isSplitPaymentInstallment, false);
});

for (const n of [2, 3, 4] as const) {
  test(`code-retour: paiement_pf${n} -> paid, fractionné, échéance ${n}`, () => {
    const r = classifyMoneticoCodeRetour(`paiement_pf${n}`);
    assert.equal(r.classification, "paid");
    assert.equal(r.isSplitPaymentInstallment, true);
    assert.equal(r.splitInstallmentNumber, n);
  });

  test(`code-retour: Annulation_pf${n} -> refused, fractionné, échéance ${n}`, () => {
    const r = classifyMoneticoCodeRetour(`Annulation_pf${n}`);
    assert.equal(r.classification, "refused");
    assert.equal(r.isSplitPaymentInstallment, true);
    assert.equal(r.splitInstallmentNumber, n);
  });
}

test("code-retour: Annulation (casse capitalisée documentée) -> refused, non fractionné", () => {
  const r = classifyMoneticoCodeRetour("Annulation");
  assert.equal(r.classification, "refused");
  assert.equal(r.isSplitPaymentInstallment, false);
});

test("code-retour: attente_partenaire -> pending", () => {
  const r = classifyMoneticoCodeRetour("attente_partenaire");
  assert.equal(r.classification, "pending");
});

test("V2-05 CENTRAL — code-retour: paiement_pf1 (aucune variante _pf1 documentée) -> unknown, JAMAIS paid", () => {
  const r = classifyMoneticoCodeRetour("paiement_pf1");
  assert.equal(r.classification, "unknown");
  assert.equal(r.isSplitPaymentInstallment, false);
  assert.equal(r.splitInstallmentNumber, null);
});

test("V2-05 CENTRAL — code-retour: Annulation_pf1 (aucune variante _pf1 documentée) -> unknown, JAMAIS refused", () => {
  const r = classifyMoneticoCodeRetour("Annulation_pf1");
  assert.equal(r.classification, "unknown");
});

test("code-retour: paiement_pf5 (au-delà de la plage documentée pf2-pf4) -> unknown", () => {
  const r = classifyMoneticoCodeRetour("paiement_pf5");
  assert.equal(r.classification, "unknown");
});

test("code-retour: annulation (casse minuscule non documentée pour la valeur de base) -> unknown, ne réplique PAS l'erreur de casse de callback.ts", () => {
  const r = classifyMoneticoCodeRetour("annulation");
  assert.equal(r.classification, "unknown");
});

test("code-retour: valeur totalement inconnue -> unknown", () => {
  const r = classifyMoneticoCodeRetour("une-valeur-jamais-documentee");
  assert.equal(r.classification, "unknown");
});

test("code-retour: chaîne vide -> unknown (fail-closed, jamais une exception)", () => {
  const r = classifyMoneticoCodeRetour("");
  assert.equal(r.classification, "unknown");
  assert.equal(r.codeRetour, "");
});

test("code-retour: entrée non-string (undefined) -> unknown, fonction TOTALE, ne lève jamais", () => {
  assert.doesNotThrow(() => classifyMoneticoCodeRetour(undefined));
  const r = classifyMoneticoCodeRetour(undefined);
  assert.equal(r.classification, "unknown");
});

test("code-retour: entrée non-string (null) -> unknown, fonction TOTALE, ne lève jamais", () => {
  assert.doesNotThrow(() => classifyMoneticoCodeRetour(null));
  const r = classifyMoneticoCodeRetour(null);
  assert.equal(r.classification, "unknown");
});

test("code-retour: entrée non-string (nombre) -> unknown, fonction TOTALE, ne lève jamais", () => {
  assert.doesNotThrow(() => classifyMoneticoCodeRetour(12345));
  const r = classifyMoneticoCodeRetour(12345);
  assert.equal(r.classification, "unknown");
});

test("code-retour: préserve la valeur brute d'entrée telle quelle (aucune normalisation de casse)", () => {
  const r = classifyMoneticoCodeRetour("PAIEMENT");
  assert.equal(r.classification, "unknown");
  assert.equal(r.codeRetour, "PAIEMENT");
});

test("moneticoClassificationToProviderEventType: dérivation mécanique 1:1, jamais une seconde source de vérité", () => {
  assert.equal(moneticoClassificationToProviderEventType("paid"), "paid");
  assert.equal(moneticoClassificationToProviderEventType("refused"), "refused");
  assert.equal(moneticoClassificationToProviderEventType("pending"), "pending");
  assert.equal(moneticoClassificationToProviderEventType("unknown"), "unknown");
});

test("STRUCTUREL — classifyMoneticoCodeRetour est exportée et exhaustive sur les 4 classifications du contrat v3", () => {
  const seen = new Set(
    [
      "payetest",
      "paiement",
      "paiement_pf2",
      "Annulation",
      "Annulation_pf3",
      "attente_partenaire",
      "quelque-chose-inconnu",
    ].map((c) => classifyMoneticoCodeRetour(c).classification)
  );
  assert.deepEqual(
    [...seen].sort(),
    ["paid", "pending", "refused", "unknown"].sort()
  );
});
