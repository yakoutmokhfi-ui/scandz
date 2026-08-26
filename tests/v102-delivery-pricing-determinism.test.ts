import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION
// (mission §13/§22) — preuve de déterminisme du calcul de frais de
// livraison PAR RÈGLE (pricingMode/fixedFee/freeThreshold), même
// discipline fixture-driven que LOT B.1/B.2
// (tests/v97-fulfillment-routing-lot-b1-determinism.test.ts) : la
// fixture tests/fixtures/delivery-pricing-cases.json est LA source de
// vérité unique, également consommée côté SQL par
// supabase/tests/generate-delivery-pricing-fixture-checks.mjs (appelé
// depuis supabase/tests/server-delivery-fulfillment-pricing-check.sh)
// -- MÊME cas, MÊME résultat attendu des deux côtés.
//
// Fichier DÉLIBÉRÉMENT séparé de tests/v97-fulfillment-routing-lot-b1-
// determinism.test.ts / tests/fixtures/fulfillment-routing-cases.json
// (déviation divulguée, voir "deviationNote" dans la fixture et le
// rapport de mission) : ce fichier ne teste JAMAIS le routage de zone
// (déjà entièrement couvert ailleurs), uniquement le calcul du frais
// une fois la règle déjà résolue.
// ====================================================================

const { computeDeliveryFee, resolveDeliveryFulfillment } = await import("../lib/delivery.ts");

const fixture = JSON.parse(
  readFileSync("tests/fixtures/delivery-pricing-cases.json", "utf8")
) as {
  cases: Array<{
    id: string;
    description: string;
    rule: {
      fulfillmentCode: string;
      zonePrefixes: string[];
      isFallback: boolean;
      minItems: number | null;
      customerText: string | null;
      displayOrder: number;
      pricingMode: "free" | "fixed" | "free_above_threshold";
      fixedFee: number | null;
      freeThreshold: number | null;
    };
    postalCode: string;
    totalCount: number;
    subtotal: number | null;
    expectedDeliveryFee: number | null;
    noRuleMatched?: boolean;
  }>;
};

for (const c of fixture.cases) {
  test(`LOT PRICING (fixture ${c.id}): ${c.description}`, () => {
    // 1. computeDeliveryFee isolé -- jamais applicable au cas
    // "aucune règle retenue" (il n'y a alors structurellement aucune
    // règle à passer à computeDeliveryFee).
    if (!c.noRuleMatched) {
      const subtotalArg = c.subtotal === null ? (null as unknown as number) : c.subtotal;
      const fee = computeDeliveryFee(c.rule, subtotalArg);
      assert.equal(fee, c.expectedDeliveryFee, "computeDeliveryFee doit produire EXACTEMENT le frais attendu par la fixture");
    }

    // 2. resolveDeliveryFulfillment bout-en-bout (mêmes paramètres
    // qu'un appelant réel : rules/postalCode/totalCount/subtotal) --
    // prouve que deliveryFee est bien propagé jusqu'au résultat final
    // exposé à l'appelant (jamais recalculé séparément par un second
    // chemin non testé).
    const rules = c.noRuleMatched ? [] : [c.rule];
    const subtotalArg = c.subtotal === null ? undefined : c.subtotal;
    const result = resolveDeliveryFulfillment(rules, c.postalCode, c.totalCount, subtotalArg);
    if (c.noRuleMatched) {
      assert.equal(
        "deliveryFee" in result ? (result as { deliveryFee?: number }).deliveryFee : undefined,
        undefined,
        "aucune règle retenue -- deliveryFee ne doit JAMAIS être présent (ni 0, ce qui signifierait à tort une gratuité décidée)"
      );
    } else {
      assert.equal(
        (result as { deliveryFee?: number }).deliveryFee,
        c.expectedDeliveryFee,
        "resolveDeliveryFulfillment doit exposer EXACTEMENT le même frais que computeDeliveryFee pour la règle résolue"
      );
    }
  });
}

test("LOT PRICING: computeDeliveryFee est bien la SEULE implémentation du calcul de frais utilisée par resolveDeliveryFulfillment (jamais une seconde formule dupliquée)", () => {
  const deliverySrc = readFileSync("lib/delivery.ts", "utf8");
  const resolverStart = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  const resolverEnd = deliverySrc.indexOf("\nexport function", resolverStart + 1);
  const body = deliverySrc.slice(resolverStart, resolverEnd === -1 ? undefined : resolverEnd);
  assert.ok(
    body.includes("computeDeliveryFee("),
    "resolveDeliveryFulfillment doit appeler computeDeliveryFee, jamais réimplémenter le calcul de frais en ligne"
  );
});
