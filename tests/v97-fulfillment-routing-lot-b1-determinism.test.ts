import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PublicDeliveryFulfillmentRule } from "../lib/sale-modes-types.ts";

// ====================================================================
// FULFILLMENT ROUTING LOT B.1 — Preuve de déterminisme SQL/frontend
// (FRB-B-02, MEDIUM).
//
// ÉTENDU EN LOT B.2 (FRB-B-01/FRB-B-02 restants) : la fixture contient
// désormais un cas canonique postalCode=null
// (postal-null-no-postal-even-with-fallback) qui prouve, via CE MÊME
// mécanisme (une fixture, deux moteurs), que resolveDeliveryFulfillment
// ne plante plus sur un postalCode réellement null et rend la même
// décision no-postal que le résolveur SQL pour un p_postal_code NULL.
//
// Ce fichier NE RÉ-IMPLÉMENTE AUCUN scénario à la main : il lit
// tests/fixtures/fulfillment-routing-cases.json (LA source de vérité
// unique) et fait tourner CHAQUE cas au travers de
// resolveDeliveryFulfillment (lib/delivery.ts), en comparant le
// résultat à `expected` -- exactement les mêmes clés, exactement les
// mêmes valeurs que celles utilisées côté SQL.
//
// Le côté SERVEUR de cette même preuve vit dans
// supabase/tests/fulfillment-routing-lot-b-check.sh, section "FIXTURE
// COMMUNE" : ce harnais fait générer, par
// supabase/tests/generate-fulfillment-lot-b1-fixture-checks.mjs, un
// script SQL qui lit CE MÊME fichier JSON, insère les données décrites
// par chaque cas (ou son bloc `sql` optionnel) dans une base Postgres
// jetable, appelle resolve_delivery_fulfillment(), et compare le
// résultat au MÊME objet `expected` via une égalité JSONB stricte.
//
// C'est la preuve auditable demandée par l'audit Work : PAS deux
// suites indépendantes qui se ressemblent, mais UNE fixture, DEUX
// moteurs, LE MÊME verdict attendu pour chaque cas -- si quelqu'un
// modifie un cas ici, les deux suites (TS et SQL) doivent être rejouées
// contre lui, mécaniquement, sans resynchronisation manuelle.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { resolveDeliveryFulfillment } = await import("../lib/delivery.ts");

// Type minimal, local à ce fichier de test -- la fixture elle-même
// (tests/fixtures/fulfillment-routing-cases.json) reste la source de
// vérité en JSON brut, jamais dupliquée en un type partagé avec le
// code applicatif (PublicDeliveryFulfillmentRule est réutilisé tel
// quel pour `rules`, voir l'appel à resolveDeliveryFulfillment plus
// bas -- seul `expected`/`id`/`description`/`postalCode`/`totalCount`
// ont besoin d'être nommés ici, pour satisfaire noImplicitAny).
interface FixtureCase {
  id: string;
  description: string;
  // LOT B.2 (FRB-B-01/FRB-B-02) : le JSON peut désormais porter un
  // `postalCode` réellement `null` (voir le cas
  // postal-null-no-postal-even-with-fallback) -- volontairement NON
  // casté vers `string` ici : ce test doit prouver que
  // resolveDeliveryFulfillment lui-même gère `null`, pas que ce
  // fichier de test l'ait neutralisé avant l'appel.
  postalCode: string | null;
  totalCount: number;
  rules: PublicDeliveryFulfillmentRule[];
  expected: {
    eligible: boolean;
    fulfillmentCode: string | null;
    matchedPrefix: string | null;
    minItems: number | null;
    customerText: string | null;
    block: string | null;
    missing: number | null;
  };
}

const FIXTURE_PATH = "tests/fixtures/fulfillment-routing-cases.json";
const fixture: { cases: FixtureCase[] } = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

test("LOT B.1/B.2: la fixture commune existe, est un JSON valide, et contient au moins les scénarios de la matrice CIO (FRB-B-02)", () => {
  assert.ok(Array.isArray(fixture.cases));
  assert.ok(fixture.cases.length >= 17, "la fixture doit couvrir au moins les 17 scénarios conçus pour ces lots (16 Lot B.1 + 1 Lot B.2 postal-null)");
  const ids = new Set(fixture.cases.map((c) => c.id));
  assert.equal(ids.size, fixture.cases.length, "aucun id de cas ne doit être dupliqué");
  for (const requiredId of [
    "valid-match-min-reached",
    "valid-match-below-min",
    "postal-empty-string-no-postal-even-with-fallback",
    "postal-whitespace-only-no-postal",
    "postal-null-no-postal-even-with-fallback",
    "rule-disabled-excluded-server-side-falls-out-of-zone",
    "parent-mode-disabled-parity-with-empty-rules",
  ]) {
    assert.ok(ids.has(requiredId), `cas requis manquant dans la fixture : ${requiredId}`);
  }
});

test("LOT B.2 (FRB-B-01): le cas canonique postalCode=null porte bien une valeur JSON `null` réelle (pas la chaîne '' ni la chaîne 'null') -- le résolveur doit être exercé avec le vrai type null", () => {
  const nullCase = fixture.cases.find((c) => c.id === "postal-null-no-postal-even-with-fallback");
  assert.ok(nullCase, "le cas canonique postal-null-no-postal-even-with-fallback doit exister");
  assert.strictEqual(nullCase!.postalCode, null, "postalCode doit être le littéral JSON null, pas une chaîne");
  assert.ok(
    nullCase!.rules.some((r) => r.isFallback),
    "le cas doit inclure un fallback par ailleurs éligible, pour prouver qu'il n'est PAS appliqué à un postal null"
  );
});

// Chaque cas de la fixture devient un test Node natif distinct --
// visible individuellement dans la sortie `npm test`, pas un seul gros
// test opaque qui masquerait quel cas précis a échoué.
for (const c of fixture.cases) {
  test(`LOT B.1 FIXTURE[${c.id}]: ${c.description}`, () => {
    const result = resolveDeliveryFulfillment(c.rules, c.postalCode, c.totalCount);

    assert.equal(result.eligible, c.expected.eligible, "eligible");
    assert.equal(result.fulfillmentCode ?? null, c.expected.fulfillmentCode, "fulfillmentCode");
    assert.equal(result.matchedPrefix ?? null, c.expected.matchedPrefix, "matchedPrefix");
    assert.equal(result.matchedRule?.minItems ?? null, c.expected.minItems, "minItems (via matchedRule)");
    assert.equal(result.customerText ?? null, c.expected.customerText, "customerText");
    assert.equal(result.block ?? null, c.expected.block, "block");
    assert.equal(result.missing ?? null, c.expected.missing, "missing");
  });
}

test("LOT B.1: le générateur de vérification SQL existe et déclare lire exactement le même fichier fixture (correspondance 1:1 auditable)", () => {
  const generatorSrc = readFileSync(
    "supabase/tests/generate-fulfillment-lot-b1-fixture-checks.mjs",
    "utf8"
  );
  assert.ok(
    generatorSrc.includes("fulfillment-routing-cases.json"),
    "le générateur SQL doit référencer explicitement le même fichier fixture que ce test"
  );
});

test("LOT B.1: le harnais SQL Lot B invoque bien le générateur de fixture commune (la preuve de déterminisme n'est pas un artefact mort, non branché)", () => {
  const harnessSrc = readFileSync("supabase/tests/fulfillment-routing-lot-b-check.sh", "utf8");
  assert.ok(
    harnessSrc.includes("generate-fulfillment-lot-b1-fixture-checks.mjs"),
    "le harnais SQL doit exécuter le générateur pour rejouer les mêmes cas côté serveur"
  );
});
