#!/usr/bin/env node
// ============================================================
// Scanym — SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING
// FOUNDATION (mission §13/§22) — générateur de vérification SQL à
// partir de la fixture commune tests/fixtures/delivery-pricing-cases.json.
//
// Même patron que supabase/tests/generate-fulfillment-lot-b1-fixture-checks.mjs
// (LOT B.1/B.2), appliqué ici au calcul de FRAIS DE LIVRAISON par
// règle plutôt qu'au routage de zone : pour CHAQUE cas de la fixture,
// insère UNE règle de fulfillment (pricingMode/fixedFee/freeThreshold
// inclus), appelle resolve_delivery_fulfillment() avec le subtotal du
// cas, et compare delivery_fee au expectedDeliveryFee de la fixture --
// LA MÊME valeur, littéralement, que celle vérifiée côté TypeScript
// par tests/v102-delivery-pricing-determinism.test.ts.
//
// Usage :
//   node generate-delivery-pricing-fixture-checks.mjs \
//     <chemin-fixture.json> <restaurant_id-uuid> <mode_code>
//
// AUCUNE exécution SQL ici -- émet uniquement du texte SQL sur stdout ;
// c'est le harnais appelant (server-delivery-fulfillment-pricing-check.sh)
// qui le passe à psql, jamais contre Production.
// ============================================================

import { readFileSync } from "node:fs";

const [, , fixturePath, restaurantId, modeCode] = process.argv;

if (!fixturePath || !restaurantId || !modeCode) {
  console.error(
    "usage: generate-delivery-pricing-fixture-checks.mjs <fixture.json> <restaurant_id> <mode_code>"
  );
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

function sqlStr(v) {
  if (v === null || v === undefined) return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function sqlBool(v) {
  return v ? "true" : "false";
}

function sqlTextArray(arr) {
  if (!arr || arr.length === 0) return "array[]::text[]";
  return "array[" + arr.map((s) => sqlStr(s)).join(",") + "]::text[]";
}

function sqlNum(v) {
  return v === null || v === undefined ? "null" : String(v);
}

const out = [];

out.push(
  "-- Généré automatiquement par generate-delivery-pricing-fixture-checks.mjs",
  `-- depuis ${fixturePath} -- NE PAS ÉDITER À LA MAIN, éditer la fixture.`,
  ""
);

for (const c of fixture.cases) {
  out.push(`-- === case: ${c.id} ===`);
  out.push(
    `delete from restaurant_sale_mode_fulfillments where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`
  );
  out.push(
    `update restaurant_sale_modes set enabled = true where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`
  );

  if (!c.noRuleMatched) {
    const r = c.rule;
    out.push(
      `insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order, pricing_mode, fixed_fee, free_threshold) values\n    ('${restaurantId}','${modeCode}',${sqlStr(r.fulfillmentCode)},'internal',${sqlTextArray(
        r.zonePrefixes
      )},${sqlBool(r.isFallback)},${r.minItems ?? "null"},${sqlStr(r.customerText)},${r.displayOrder},${sqlStr(
        r.pricingMode
      )},${sqlNum(r.fixedFee)},${sqlNum(r.freeThreshold)});`
    );
  }

  const expectedFeeExpr = c.expectedDeliveryFee === null ? "null" : `${c.expectedDeliveryFee}::numeric`;
  out.push(
    `select ${sqlStr(c.id)} || '|' || (case when t.delivery_fee is not distinct from ${expectedFeeExpr} then 't' else 'f' end) || '|' || coalesce(t.delivery_fee::text, 'null')`,
    `from resolve_delivery_fulfillment('${restaurantId}'::uuid, ${sqlStr(modeCode)}, ${sqlStr(c.postalCode)}, ${c.totalCount}, ${sqlNum(c.subtotal)}) t;`,
    ""
  );
}

// Nettoyage final : le tenant de test ne doit garder aucune donnée
// résiduelle du dernier cas exécuté.
out.push(
  `delete from restaurant_sale_mode_fulfillments where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`,
  `update restaurant_sale_modes set enabled = true where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`
);

process.stdout.write(out.join("\n") + "\n");
