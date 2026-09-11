import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — STUART LOT B — MERCHANT DELIVERY PRICING POLICY v1.1.
// PROVIDER COST → CUSTOMER DELIVERY FEE.
//
// CORRECTIF v1.1 (CTO PRE-CONTROL) :
//   LOT-B-01 (duplicated customer delivery fee business logic) --
//   `computeDeliveryPricingPolicy` appelle désormais `computeDeliveryFee`
//   (lib/delivery.ts) UNE SEULE FOIS, `resolveCustomerDeliveryFee`/
//   `normalizeSubtotal` (v1) sont SUPPRIMÉS. `pricingReason` est
//   SUPPRIMÉ du résultat (option B du mandat v1.1) -- les assertions
//   `result.pricingReason` des scénarios [2]-[5] (v1) sont retirées
//   ci-dessous, le reste de chaque scénario est INCHANGÉ.
//   LOT-B-02 (two-decimal money contract not enforced) -- `providerCost`/
//   `fixedFee`/`freeThreshold` sont désormais rejetés fail-closed s'ils
//   comportent plus de 2 décimales (`hasAtMostTwoDecimalPlaces`,
//   delivery-pricing-policy.ts).
// Section "SECTION v1.1" ci-dessous couvre les 12 items de la "TEST
// REMEDIATION" du mandat v1.1 ; la section suivante ("SECTION v1")
// reprend les 19 scénarios déjà mandatés en v1, avec uniquement le
// retrait des assertions `pricingReason` désormais invalides.
//
// AUCUN appel réseau, AUCUN appel Stuart, AUCUNE base de données --
// moteur PUR par construction (mandat, "PURE POLICY ENGINE"). Items
// 10/11/12 (v1.1) = items 18/17/19 (v1) -- non-régression, couverte
// EXTERNEMENT par les harnais/suites déjà existants, réexécutés à
// l'identique (voir le livrable final, section "TESTS") :
//   10. tests/v159-stuart-quote-validate-foundation.test.ts +
//       supabase/tests/stuart-quote-validate-foundation-v1-check.sh +
//       supabase/tests/stuart-merchant-credential-foundation-v1-check.sh ;
//   11. supabase/tests/delivery-pricing-operator-authorization-v1-check.sh
//       (+ merchant-delivery-pricing-check.sh, réexécuté par la même
//       chaîne) ;
//   12. supabase/tests/payment-p2a-secure-config-check.sh +
//       supabase/tests/payment-p3a0-secure-credential-read-check.sh.
// ====================================================================

import {
  computeDeliveryPricingPolicy,
  type DeliveryPricingPolicyInput,
  type MerchantDeliveryPricingConfig,
} from "../lib/delivery-pricing-policy.ts";
import {
  DeliveryPricingCurrencyMismatchError,
  DeliveryPricingInvalidMerchantConfigError,
  DeliveryPricingInvalidProviderCostError,
} from "../lib/delivery-pricing-policy-errors.ts";
import { computeDeliveryPricingPolicyWithIdentity } from "../lib/server/delivery-pricing-policy-wiring.ts";
import { computeDeliveryFee } from "../lib/delivery.ts";
import { readFileSync } from "node:fs";

// Même convention de lecture que tests/v102-delivery-pricing-determinism.test.ts
// (readFileSync + JSON.parse), jamais un import ESM JSON parallèle.
const deliveryPricingCasesFixture = JSON.parse(
  readFileSync("tests/fixtures/delivery-pricing-cases.json", "utf8")
) as {
  cases: Array<{
    id: string;
    rule: { pricingMode: MerchantDeliveryPricingConfig["pricingMode"]; fixedFee: number | null; freeThreshold: number | null };
    subtotal: number | null;
    expectedDeliveryFee: number | null;
    noRuleMatched?: boolean;
  }>;
};

const EUR = "EUR";

function baseInput(
  overrides: Partial<DeliveryPricingPolicyInput> = {}
): DeliveryPricingPolicyInput {
  const config: MerchantDeliveryPricingConfig = {
    pricingMode: "fixed",
    fixedFee: 5,
    freeThreshold: null,
  };
  return {
    providerCost: 8.4,
    currency: EUR,
    basketSubtotal: 42,
    merchantDeliveryPricingConfig: config,
    ...overrides,
  };
}

// [1] provider cost passé inchangé dans le résultat.
test("[1] provider cost passed through unchanged", () => {
  const result = computeDeliveryPricingPolicy(baseInput({ providerCost: 8.4 }), EUR);
  assert.equal(result.providerCost, 8.4);
});

// [2] frais client selon la politique marchande normale (mode 'fixed').
test("[2] customer fee according to normal merchant policy", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 6.5, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(result.customerDeliveryFee, 6.5);
});

// [3] seuil de gratuité NON atteint -- frais fixe toujours appliqué.
test("[3] free-delivery threshold not reached", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      basketSubtotal: 92.5,
      merchantDeliveryPricingConfig: {
        pricingMode: "free_above_threshold",
        fixedFee: 5,
        freeThreshold: 100,
      },
    }),
    EUR
  );
  assert.equal(result.customerDeliveryFee, 5);
  assert.equal(result.providerCost, 8.4);
});

// [4] seuil de gratuité EXACTEMENT atteint -- gratuit (inclusif, même
// convention que computeDeliveryFee/resolve_delivery_fulfillment).
test("[4] free-delivery threshold exactly reached", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      basketSubtotal: 100,
      merchantDeliveryPricingConfig: {
        pricingMode: "free_above_threshold",
        fixedFee: 5,
        freeThreshold: 100,
      },
    }),
    EUR
  );
  assert.equal(result.customerDeliveryFee, 0);
});

// [5] seuil de gratuité dépassé -- gratuit.
test("[5] free-delivery threshold exceeded", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      basketSubtotal: 150,
      merchantDeliveryPricingConfig: {
        pricingMode: "free_above_threshold",
        fixedFee: 5,
        freeThreshold: 100,
      },
    }),
    EUR
  );
  assert.equal(result.customerDeliveryFee, 0);
});

// [6] livraison gratuite pour le client -- le coût prestataire reste
// INCHANGÉ (le marchand absorbe le plein coût, jamais silencieusement
// ramené à 0).
test("[6] free delivery keeps provider cost unchanged", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 8.4,
      basketSubtotal: 150,
      merchantDeliveryPricingConfig: {
        pricingMode: "free_above_threshold",
        fixedFee: 5,
        freeThreshold: 100,
      },
    }),
    EUR
  );
  assert.equal(result.customerDeliveryFee, 0);
  assert.equal(result.providerCost, 8.4);
  assert.equal(result.merchantSubsidy, 8.4);
});

// [7] subvention marchande calculée correctement -- exemples du
// mandat : (8.40, 8.40) -> 0.00 ; (8.40, 0.00) -> 8.40 ; (8.40, 5.00)
// -> 3.40.
test("[7] merchant subsidy computed correctly (mandate worked examples)", () => {
  const r1 = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 8.4,
      merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 8.4, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(r1.merchantSubsidy, 0);

  const r2 = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 8.4,
      basketSubtotal: 150,
      merchantDeliveryPricingConfig: {
        pricingMode: "free_above_threshold",
        fixedFee: 8.4,
        freeThreshold: 100,
      },
    }),
    EUR
  );
  assert.equal(r2.merchantSubsidy, 8.4);

  const r3 = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 8.4,
      merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 5, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(r3.merchantSubsidy, 3.4);
});

// [8] subvention PARTIELLE -- déterministe, sans résidu flottant
// (ex. 8.40 - 5.00 doit rester EXACTEMENT 3.4, jamais
// 3.3999999999999995).
test("[8] partial merchant subsidy, deterministic (no float residue)", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 8.4,
      merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 5, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(result.merchantSubsidy, 3.4);
  assert.equal(String(result.merchantSubsidy), "3.4");
});

// [9] frais client SUPÉRIEUR au coût prestataire -- géré correctement :
// subvention plafonnée à 0, JAMAIS négative, jamais exposée comme une
// "subvention négative".
test("[9] customer fee greater than provider cost handled correctly", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 5,
      merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 8, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(result.customerDeliveryFee, 8);
  assert.equal(result.providerCost, 5);
  assert.equal(result.merchantSubsidy, 0);
});

// [10] coût prestataire nul -- valeur valide, jamais rejetée.
test("[10] zero provider cost is accepted", () => {
  const result = computeDeliveryPricingPolicy(baseInput({ providerCost: 0 }), EUR);
  assert.equal(result.providerCost, 0);
  assert.equal(result.merchantSubsidy, 0);
});

// [11] coût prestataire négatif -- rejeté (fail-closed).
test("[11] negative provider cost rejected", () => {
  assert.throws(
    () => computeDeliveryPricingPolicy(baseInput({ providerCost: -0.01 }), EUR),
    DeliveryPricingInvalidProviderCostError
  );
});

// [11b] coût prestataire NaN/Infinity -- rejeté également (même
// invariant "no NaN").
test("[11b] non-finite provider cost rejected (NaN / Infinity)", () => {
  assert.throws(
    () => computeDeliveryPricingPolicy(baseInput({ providerCost: Number.NaN }), EUR),
    DeliveryPricingInvalidProviderCostError
  );
  assert.throws(
    () => computeDeliveryPricingPolicy(baseInput({ providerCost: Number.POSITIVE_INFINITY }), EUR),
    DeliveryPricingInvalidProviderCostError
  );
});

// [12] frais/seuil marchand configuré négatif -- rejeté / fail-closed
// (même invariant que la contrainte CHECK déjà en base).
test("[12] negative configured customer fee rejected/fails closed", () => {
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        baseInput({
          merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: -1, freeThreshold: null },
        }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        baseInput({
          merchantDeliveryPricingConfig: {
            pricingMode: "free_above_threshold",
            fixedFee: 5,
            freeThreshold: -10,
          },
        }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
});

// [13] devise différente -- rejetée (aucun calcul cross-devise, aucun
// taux de change inventé).
test("[13] currency mismatch rejected", () => {
  assert.throws(
    () => computeDeliveryPricingPolicy(baseInput({ currency: "EUR" }), "DZD"),
    DeliveryPricingCurrencyMismatchError
  );
});

// [14] arrondi monétaire déterministe -- même résultat sur plusieurs
// appels identiques, aucune divergence liée à l'ordre d'exécution.
test("[14] money rounding deterministic across repeated calls", () => {
  const input = baseInput({
    providerCost: 10.1,
    merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 3.33, freeThreshold: null },
  });
  const results = Array.from({ length: 5 }, () => computeDeliveryPricingPolicy(input, EUR).merchantSubsidy);
  for (const r of results) {
    assert.equal(r, results[0]);
  }
  assert.equal(results[0], 6.77);
});

// [15] configuration marchande manquante/invalide -- échoue de façon
// sûre (fail-closed), jamais une valeur par défaut silencieuse.
test("[15] missing/invalid merchant pricing config fails safely", () => {
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        // config volontairement absente pour prouver le rejet fail-closed
        // (Partial<> l'autorise sans erreur de compilation -- le rejet est
        // runtime, par assertValidMerchantConfig).
        baseInput({ merchantDeliveryPricingConfig: undefined }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        baseInput({
          // @ts-expect-error -- pricingMode hors vocabulaire, pour prouver le rejet fail-closed.
          merchantDeliveryPricingConfig: { pricingMode: "external_quote", fixedFee: 5, freeThreshold: null },
        }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        baseInput({
          // 'free' incohérent avec un fixedFee non-null -- même contrainte combo que la base.
          merchantDeliveryPricingConfig: { pricingMode: "free", fixedFee: 5, freeThreshold: null },
        }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
});

// [16] identité tenant/règle non mélangée lorsque portée par
// l'adaptateur minimal -- deux contextes distincts, deux résultats
// distincts, jamais de fuite croisée.
test("[16] tenant/provider identity not mixed when carried through", () => {
  const resultA = computeDeliveryPricingPolicyWithIdentity(
    { restaurantId: "resto-A", fulfillmentRuleId: "rule-A" },
    baseInput({ providerCost: 8.4 }),
    EUR
  );
  const resultB = computeDeliveryPricingPolicyWithIdentity(
    { restaurantId: "resto-B", fulfillmentRuleId: "rule-B" },
    baseInput({ providerCost: 12.0 }),
    EUR
  );
  assert.equal(resultA.restaurantId, "resto-A");
  assert.equal(resultA.fulfillmentRuleId, "rule-A");
  assert.equal(resultB.restaurantId, "resto-B");
  assert.equal(resultB.fulfillmentRuleId, "rule-B");
  assert.notEqual(resultA.restaurantId, resultB.restaurantId);
  assert.equal(resultA.providerCost, 8.4);
  assert.equal(resultB.providerCost, 12.0);
});

// [17] non-régression Delivery Pricing Operator Authorization --
// couverte EXTERNEMENT (voir en-tête de fichier), réaffirmée ici par
// une preuve structurelle : ce module ne référence AUCUN symbole SQL
// d'autorisation opérateur (is_scanym_operator, has_role_in), jamais
// une réimplémentation locale divergente.
test("[17-smoke] no reimplementation of operator authorization primitives", () => {
  const src =
    readFileSync(new URL("../lib/delivery-pricing-policy.ts", import.meta.url), "utf8") +
    readFileSync(new URL("../lib/server/delivery-pricing-policy-wiring.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("is_scanym_operator"));
  assert.ok(!src.includes("has_role_in"));
  assert.ok(!src.includes("is_member_of"));
});

// [18] non-régression Stuart LOT A -- couverte EXTERNEMENT (voir
// en-tête de fichier), réaffirmée ici par une preuve structurelle : ce
// module n'importe AUCUN symbole du service Stuart (quote-service.ts),
// jamais un appel HTTP/OAuth caché.
test("[18-smoke] no import of Stuart quote-service internals", () => {
  const src =
    readFileSync(new URL("../lib/delivery-pricing-policy.ts", import.meta.url), "utf8") +
    readFileSync(new URL("../lib/server/delivery-pricing-policy-wiring.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("quote-service"));
  assert.ok(!src.includes("quoteDelivery"));
  assert.ok(!src.includes("validateDelivery"));
  assert.ok(!/\bfetch\(/.test(src));
});

// [19] non-régression Payment/Monetico -- couverte EXTERNEMENT (voir
// en-tête de fichier), réaffirmée ici par une preuve structurelle : ce
// module N'IMPORTE ni n'UTILISE aucun symbole/chemin Payment/Monetico
// (aucun couplage CODE) -- une simple mention en prose expliquant une
// décision de périmètre (ex. pourquoi un primitif Payment existant
// n'a pas été réutilisé, voir CORRECTIF v1.1 LOT-B-02) n'est PAS un
// couplage et n'est donc volontairement PAS ce que ce test interdit.
test("[19-smoke] no import/usage of Payment/Monetico internals", () => {
  const src =
    readFileSync(new URL("../lib/delivery-pricing-policy.ts", import.meta.url), "utf8") +
    readFileSync(new URL("../lib/server/delivery-pricing-policy-wiring.ts", import.meta.url), "utf8") +
    readFileSync(new URL("../lib/delivery-pricing-policy-errors.ts", import.meta.url), "utf8");
  assert.ok(!/from\s+["']@\/lib\/server\/payment/i.test(src));
  assert.ok(!/from\s+["'][^"']*monetico/i.test(src));
  assert.ok(!src.includes("MoneticoCredentialPayload"));
  assert.ok(!src.includes("BuildMoneticoRequestInput"));
  assert.ok(!src.includes("recordPaymentProviderEvent"));
  assert.ok(!src.includes("payment_provider_configs"));
});

// [additionnel] la fonction pure ne fait jamais confiance à l'égalité
// providerCost === customerDeliveryFee par raccourci : deux appels aux
// mêmes providerCost/subtotal mais des politiques marchandes
// différentes produisent des frais clients différents.
test("[additionnel] customer fee never silently assumed equal to provider cost", () => {
  const asFree = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 8.4,
      merchantDeliveryPricingConfig: { pricingMode: "free", fixedFee: null, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(asFree.customerDeliveryFee, 0);
  assert.notEqual(asFree.customerDeliveryFee, asFree.providerCost);
});

// [additionnel] `merchantSubsidy` n'est JAMAIS négatif, quel que soit
// l'écart entre providerCost et customerDeliveryFee.
test("[additionnel] merchant subsidy is never negative", () => {
  const result = computeDeliveryPricingPolicy(
    baseInput({
      providerCost: 1,
      merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 999, freeThreshold: null },
    }),
    EUR
  );
  assert.equal(result.merchantSubsidy, 0);
  assert.ok(result.merchantSubsidy >= 0);
});

// ====================================================================
// SECTION v1.1 — CTO PRE-CONTROL REMEDIATION (LOT-B-01 / LOT-B-02).
// 12 items de la "TEST REMEDIATION" du mandat v1.1.
// ====================================================================

// [v1.1-1] customerDeliveryFee provient de computeDeliveryFee EXISTANT
// (lib/delivery.ts) -- comparaison directe, plusieurs cas, jamais une
// coïncidence de valeurs entre deux implémentations indépendantes.
test("[v1.1-1] customerDeliveryFee comes from existing computeDeliveryFee behavior", () => {
  const cases: Array<{ config: MerchantDeliveryPricingConfig; subtotal: number }> = [
    { config: { pricingMode: "free", fixedFee: null, freeThreshold: null }, subtotal: 42 },
    { config: { pricingMode: "fixed", fixedFee: 6.5, freeThreshold: null }, subtotal: 1 },
    { config: { pricingMode: "free_above_threshold", fixedFee: 8, freeThreshold: 30 }, subtotal: 29.99 },
    { config: { pricingMode: "free_above_threshold", fixedFee: 8, freeThreshold: 30 }, subtotal: 30 },
  ];
  for (const { config, subtotal } of cases) {
    const viaPolicy = computeDeliveryPricingPolicy(
      baseInput({ basketSubtotal: subtotal, merchantDeliveryPricingConfig: config }),
      EUR
    ).customerDeliveryFee;
    const viaDirectCall = computeDeliveryFee(config, subtotal);
    assert.equal(viaPolicy, viaDirectCall);
  }
});

// [v1.1-2] aucun calculateur de frais dupliqué ne subsiste dans LOT B --
// preuve structurelle : le module importe computeDeliveryFee depuis
// "@/lib/delivery" et ne redéfinit localement ni resolveCustomerDeliveryFee
// ni normalizeSubtotal (supprimés par ce correctif).
test("[v1.1-2] no duplicate monetary fee switch/calculator remains in LOT B", () => {
  const src = readFileSync(new URL("../lib/delivery-pricing-policy.ts", import.meta.url), "utf8");
  assert.ok(src.includes('from "@/lib/delivery"'));
  assert.ok(src.includes("computeDeliveryFee("));
  assert.ok(!src.includes("function resolveCustomerDeliveryFee"));
  assert.ok(!src.includes("function normalizeSubtotal"));
  // Aucune seconde structure de branchement sur pricingMode qui
  // calculerait un montant (le seul `switch`/`case` sur pricingMode
  // autorisé est celui, déjà existant et INCHANGÉ, de computeDeliveryFee
  // lui-même dans lib/delivery.ts -- jamais dans ce fichier).
  assert.ok(!/case\s+"free_above_threshold"\s*:/.test(src));
});

// [v1.1-3] tous les cas existants free/fixed/threshold (fixture
// canonique déjà publiée, tests/fixtures/delivery-pricing-cases.json)
// PASSENT toujours à travers le moteur LOT B -- même source de vérité
// que tests/v102-delivery-pricing-determinism.test.ts.
test("[v1.1-3] all existing free/fixed/threshold fixture cases still pass", () => {
  let checked = 0;
  for (const c of deliveryPricingCasesFixture.cases) {
    if (c.noRuleMatched) {
      // Hors périmètre de ce moteur : "aucune règle retenue" est une
      // décision de ROUTAGE (resolveDeliveryFulfillment), jamais une
      // entrée valide de computeDeliveryPricingPolicy (qui reçoit
      // toujours une règle déjà résolue).
      continue;
    }
    const result = computeDeliveryPricingPolicy(
      baseInput({
        basketSubtotal: (c.subtotal ?? null) as unknown as number,
        merchantDeliveryPricingConfig: {
          pricingMode: c.rule.pricingMode,
          fixedFee: c.rule.fixedFee,
          freeThreshold: c.rule.freeThreshold,
        },
      }),
      EUR
    );
    assert.equal(result.customerDeliveryFee, c.expectedDeliveryFee, `case ${c.id}`);
    checked += 1;
  }
  // Preuve positive que la fixture a bien été parcourue (jamais un test
  // vert par absence de cas).
  assert.equal(checked, 8);
});

// [v1.1-4] providerCost à 3 décimales -- rejeté (convention numeric(_,2)).
test("[v1.1-4] providerCost 8.405 is rejected", () => {
  assert.throws(
    () => computeDeliveryPricingPolicy(baseInput({ providerCost: 8.405 }), EUR),
    DeliveryPricingInvalidProviderCostError
  );
});

// [v1.1-5] fixedFee à plus de 2 décimales -- rejeté.
test("[v1.1-5] fixedFee with more than 2 decimals is rejected", () => {
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        baseInput({
          merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 5.999, freeThreshold: null },
        }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
});

// [v1.1-6] freeThreshold à plus de 2 décimales -- rejeté.
test("[v1.1-6] freeThreshold with more than 2 decimals is rejected", () => {
  assert.throws(
    () =>
      computeDeliveryPricingPolicy(
        baseInput({
          merchantDeliveryPricingConfig: {
            pricingMode: "free_above_threshold",
            fixedFee: 5,
            freeThreshold: 100.123,
          },
        }),
        EUR
      ),
    DeliveryPricingInvalidMerchantConfigError
  );
});

// [v1.1-7] montants à 0, 1 ou 2 décimales -- acceptés (providerCost ET
// merchant config), jamais confondus avec le rejet ci-dessus.
test("[v1.1-7] valid 0/1/2-decimal amounts accepted", () => {
  for (const amount of [8, 8.4, 8.4, 8.40, 0, 0.5, 12.99]) {
    const result = computeDeliveryPricingPolicy(
      baseInput({
        providerCost: amount,
        merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: amount, freeThreshold: null },
      }),
      EUR
    );
    assert.equal(result.providerCost, amount);
    assert.equal(result.customerDeliveryFee, amount);
  }
});

// [v1.1-8] arrondi de merchantSubsidy reste déterministe après ce
// correctif -- même assertion que [14] (v1, inchangée), réaffirmée ici
// explicitement pour l'item 8 de la TEST REMEDIATION v1.1.
test("[v1.1-8] merchantSubsidy rounding remains deterministic", () => {
  const input = baseInput({
    providerCost: 10.1,
    merchantDeliveryPricingConfig: { pricingMode: "fixed", fixedFee: 3.33, freeThreshold: null },
  });
  const results = Array.from({ length: 5 }, () => computeDeliveryPricingPolicy(input, EUR).merchantSubsidy);
  for (const r of results) {
    assert.equal(r, results[0]);
  }
  assert.equal(results[0], 6.77);
});

// [v1.1-9] devise incompatible toujours rejetée -- même assertion que
// [13] (v1, inchangée), réaffirmée ici explicitement pour l'item 9 de
// la TEST REMEDIATION v1.1.
test("[v1.1-9] currency mismatch still rejected", () => {
  assert.throws(
    () => computeDeliveryPricingPolicy(baseInput({ currency: "EUR" }), "DZD"),
    DeliveryPricingCurrencyMismatchError
  );
});

// [v1.1-10] régression Stuart LOT A -- couverte EXTERNEMENT (voir
// en-tête de fichier) : tests/v159-stuart-quote-validate-foundation.test.ts
// + supabase/tests/stuart-quote-validate-foundation-v1-check.sh +
// supabase/tests/stuart-merchant-credential-foundation-v1-check.sh
// (réexécutés à l'identique, voir le livrable). Réaffirmée ici par
// [18-smoke] ci-dessus (INCHANGÉ par ce correctif).

// [v1.1-11] régression Delivery Pricing (SQL/RPC/autorisation) --
// couverte EXTERNEMENT : supabase/tests/delivery-pricing-operator-
// authorization-v1-check.sh + merchant-delivery-pricing-check.sh
// (réexécutés à l'identique). Réaffirmée ici par [17-smoke] ci-dessus
// (INCHANGÉ par ce correctif).

// [v1.1-12] régression Payment/Monetico -- couverte EXTERNEMENT :
// supabase/tests/payment-p2a-secure-config-check.sh + payment-p3a0-
// secure-credential-read-check.sh (réexécutés à l'identique).
// Réaffirmée ici par [19-smoke] ci-dessus (INCHANGÉ par ce correctif).
