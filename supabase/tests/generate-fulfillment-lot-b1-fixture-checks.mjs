#!/usr/bin/env node
// ============================================================
// Scanym — FULFILLMENT ROUTING LOT B.1 — générateur de vérification
// SQL à partir de la fixture commune (FRB-B-02).
//
// Lit tests/fixtures/fulfillment-routing-cases.json (LA source de
// vérité unique, également consommée directement par
// tests/v97-fulfillment-routing-lot-b1-determinism.test.ts côté
// TypeScript) et émet, sur stdout, un script SQL qui, pour CHAQUE cas
// de la fixture :
//   1. Réinitialise les données de fulfillment du tenant/mode de test
//      (DELETE ciblé, jamais une autre table).
//   2. Positionne restaurant_sale_modes.enabled selon
//      case.sql.parentModeEnabled (par défaut true).
//   3. Insère les règles de case.sql.rules (ou, à défaut, celles de
//      case.rules avec enabled=true implicite) -- PEUT inclure des
//      lignes enabled=false ou des règles que le frontend ne verrait
//      jamais (cas de parité serveur-only, voir le champ `sql` de la
//      fixture).
//   4. Appelle resolve_delivery_fulfillment() et compare le résultat
//      (sérialisé en jsonb, mêmes clés que le contrat TypeScript) à
//      `case.expected` -- LE MÊME OBJET, littéralement, que celui lu
//      par le test TypeScript pour ce même cas.
//   5. Émet UNE ligne `id|t-ou-f|<json résultat>` (délimiteur '|',
//      caractère unique -- IFS bash ne gère pas un délimiteur
//      multi-caractères) -- une ligne par cas,
//      dans l'ordre de la fixture, consommée par
//      supabase/tests/fulfillment-routing-lot-b-check.sh.
//
// Usage :
//   node generate-fulfillment-lot-b1-fixture-checks.mjs \
//     <chemin-fixture.json> <restaurant_id-uuid> <mode_code>
//
// AUCUNE exécution SQL ici -- ce script ne fait qu'émettre du texte
// SQL sur stdout ; c'est le harnais appelant (fulfillment-routing-
// lot-b-check.sh) qui le passe à psql, jamais contre Production.
// ============================================================

import { readFileSync } from "node:fs";

const [, , fixturePath, restaurantId, modeCode] = process.argv;

if (!fixturePath || !restaurantId || !modeCode) {
  console.error(
    "usage: generate-fulfillment-lot-b1-fixture-checks.mjs <fixture.json> <restaurant_id> <mode_code>"
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

// Sérialise `expected` en littéral jsonb SQL. Les clés doivent
// correspondre EXACTEMENT à celles utilisées par le test TypeScript
// (tests/v97-fulfillment-routing-lot-b1-determinism.test.ts) et par
// la jsonb_build_object() générée plus bas pour le résultat réel --
// c'est cette correspondance de clés, littérale et mécanique, qui
// constitue la preuve de déterminisme (FRB-B-02), pas une
// coïncidence de nommage entretenue à la main des deux côtés.
function expectedJsonbLiteral(expected) {
  const json = JSON.stringify({
    eligible: expected.eligible,
    fulfillmentCode: expected.fulfillmentCode ?? null,
    matchedPrefix: expected.matchedPrefix ?? null,
    minItems: expected.minItems ?? null,
    customerText: expected.customerText ?? null,
    block: expected.block ?? null,
    missing: expected.missing ?? null,
  });
  return "'" + json.replace(/'/g, "''") + "'::jsonb";
}

const RESULT_JSONB_EXPR = `jsonb_build_object(
      'eligible', t.eligible,
      'fulfillmentCode', t.fulfillment_code,
      'matchedPrefix', t.matched_prefix,
      'minItems', t.min_items,
      'customerText', t.customer_text,
      'block', t.block,
      'missing', t.missing
    )`;

const out = [];

out.push(
  "-- Généré automatiquement par generate-fulfillment-lot-b1-fixture-checks.mjs",
  `-- depuis ${fixturePath} -- NE PAS ÉDITER À LA MAIN, éditer la fixture.`,
  ""
);

for (const c of fixture.cases) {
  const sqlOverride = c.sql ?? {};
  const rulesForSql =
    sqlOverride.rules ??
    c.rules.map((r) => ({ ...r, enabled: true }));
  const parentEnabled = sqlOverride.parentModeEnabled ?? true;

  out.push(`-- === case: ${c.id} ===`);
  out.push(
    `delete from restaurant_sale_mode_fulfillments where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`
  );
  out.push(
    `update restaurant_sale_modes set enabled = ${sqlBool(parentEnabled)} where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`
  );

  if (rulesForSql.length > 0) {
    const values = rulesForSql
      .map((r) => {
        const enabled = r.enabled ?? true;
        return `('${restaurantId}','${modeCode}',${sqlStr(r.fulfillmentCode)},'internal',${sqlTextArray(
          r.zonePrefixes
        )},${sqlBool(r.isFallback)},${r.minItems ?? "null"},${sqlStr(r.customerText)},${r.displayOrder},${sqlBool(
          enabled
        )})`;
      })
      .join(",\n    ");
    out.push(
      `insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order, enabled) values\n    ${values};`
    );
  }

  const expectedJsonb = expectedJsonbLiteral(c.expected);
  out.push(
    `select ${sqlStr(c.id)} || '|' || (case when ${RESULT_JSONB_EXPR} = ${expectedJsonb} then 't' else 'f' end) || '|' || (${RESULT_JSONB_EXPR})::text`,
    `from resolve_delivery_fulfillment('${restaurantId}'::uuid, ${sqlStr(modeCode)}, ${sqlStr(c.postalCode)}, ${c.totalCount}) t;`,
    ""
  );
}

// Nettoyage final : le tenant de test ne doit garder aucune donnée
// résiduelle du dernier cas exécuté (les assertions suivantes du
// harnais, si elles réutilisent ce même tenant, ne doivent jamais
// hériter d'un état laissé par la fixture).
out.push(
  `delete from restaurant_sale_mode_fulfillments where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`,
  `update restaurant_sale_modes set enabled = true where restaurant_id = '${restaurantId}' and mode_code = '${modeCode}';`
);

process.stdout.write(out.join("\n") + "\n");
