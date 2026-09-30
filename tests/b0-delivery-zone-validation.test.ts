import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateDeliveryZones } from "../lib/delivery-zone-validation.ts";
import type {
  ZoneFinding,
  ZoneRuleInput,
  ZoneValidationInput,
} from "../lib/delivery-zone-validation-types.ts";

// ====================================================================
// DELIVERY PRICING v2 -- B0 -- DELIVERY ZONE VALIDATION.
//
// Contrat canonique figé (Ravel/CIO, issue #11, commentaire
// "DELIVERY PRICING v2 -- B0 -- CANONICAL CONTRACT NOW PROVIDED",
// SHA-256 `6cb185117ea923457d268f4134d79d1768107c2bb1d588be39ea42212c355f0b`,
// baseline `50f0775258607b99fc72323326e6d2c2b0f05ae2`).
//
// Périmètre STRICT (contrat §13) : ce fichier ne modifie AUCUN fichier
// existant, ne touche jamais `resolve_delivery_fulfillment` ni
// `lib/delivery.ts`. Le "simulateur de résolveur" ci-dessous est un
// outil de TEST PUR, autonome, qui REPRODUIT la sémantique déjà
// vérifiée par lecture directe du SQL réel (voir le commentaire de
// tête de lib/delivery-zone-validation.ts) -- il n'appelle, n'importe
// ni ne modifie aucun code de production, et n'existe que pour la
// preuve de cohérence B0-R-01/B0-R-02 exigée par le contrat §11.
// ====================================================================

const fixturePath = "tests/fixtures/delivery-zone-validation-cases.json";
const fixtureRaw = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureRaw) as {
  cases: Array<{
    id: string;
    description: string;
    shape: ZoneValidationInput["shape"];
    rules: ZoneRuleInput[];
    expectedDecision: "ACCEPTED" | "ACCEPTED_WITH_WARNINGS" | "REJECTED";
    expectedFindings: ZoneFinding[];
    expectedNormalizedRules: ZoneRuleInput[];
  }>;
};

// --------------------------------------------------------------------
// Simulateur de résolveur PUR, TEST-ONLY -- reproduit fidèlement les 7
// points de sémantique du contrat §2, eux-mêmes vérifiés avant tout
// code contre `public.resolve_delivery_fulfillment`
// (supabase/DRAFT-lot-server-delivery-fulfillment-pricing.sql) :
// correspondance par préfixe, ordre display_order ASC, première règle
// non-défaut correspondante gagne, premier préfixe correspondant du
// TABLEAU au sein d'une règle, repli utilisé seulement si aucune règle
// non-défaut ne correspond, le repli ne teste jamais ses propres
// zones, une règle non-défaut à zones vides ne correspond jamais.
// --------------------------------------------------------------------
function simulateResolver(
  rules: ZoneRuleInput[],
  candidatePostalCode: string
): { ruleId: string | null } {
  const code = candidatePostalCode.trim();
  if (code === "") return { ruleId: null };

  const nonDefaultSorted = rules
    .filter((r) => !r.isDefault)
    .map((r, inputIndex) => ({ r, inputIndex }))
    // Tri STABLE par displayOrder ASC -- Array#sort de Node est stable
    // (ES2019+), donc les égalités conservent l'ordre de saisie,
    // reproduisant fidèlement le comportement de PostgreSQL pour des
    // display_order à égalité (non spécifié explicitement par le SQL,
    // mais B0 lui-même rejette déjà les display_order dupliqués via
    // ZV-INPUT-DUPLICATE-ORDER -- ce cas ne se présente donc jamais
    // pour une configuration acceptée par B0).
    .sort((a, b) => a.r.displayOrder - b.r.displayOrder)
    .map((entry) => entry.r);

  for (const rule of nonDefaultSorted) {
    const matched = rule.zones.find((zonePrefix) => code.startsWith(zonePrefix));
    if (matched !== undefined) {
      return { ruleId: rule.ruleId };
    }
  }
  const fallback = rules.find((r) => r.isDefault);
  return { ruleId: fallback ? fallback.ruleId : null };
}

// ====================================================================
// B0-R-01 / B0-R-02 -- écrits EN PREMIER (avant les cas d'acceptation
// détaillés ci-dessous), conformément à la consigne littérale du
// contrat §11 ("Write B0-R-01 and B0-R-02 EARLY").
// ====================================================================

test("B0-R-01 : toute zone portant un finding ZV-COVERED-BY-HIGHER (ou ZV-DUPLICATE-ACROSS) est bien INATTEIGNABLE par le résolveur simulé -- la règle qui la possède ne gagne JAMAIS pour cette zone utilisée comme code postal candidat", () => {
  let deadZonesChecked = 0;
  for (const testCase of fixture.cases) {
    const result = validateDeliveryZones({ shape: testCase.shape, rules: testCase.rules });
    for (const finding of result.findings) {
      if (finding.code !== "ZV-COVERED-BY-HIGHER" && finding.code !== "ZV-DUPLICATE-ACROSS") continue;
      assert.ok(finding.zone, `${testCase.id}: finding ${finding.code} sans zone`);
      const resolved = simulateResolver(testCase.rules, finding.zone!);
      assert.notEqual(
        resolved.ruleId,
        finding.ruleId,
        `${testCase.id}: la zone morte '${finding.zone}' (règle '${finding.ruleId}') est en réalité résolue par sa PROPRE règle -- le finding ${finding.code} serait un faux positif`
      );
      deadZonesChecked += 1;
    }
  }
  // Preuve que ce test exerce RÉELLEMENT au moins un cas (sinon la
  // boucle ci-dessus serait vide et le test passerait trivialement
  // sans rien prouver -- garde-fou contre un fixture cassé).
  assert.ok(deadZonesChecked >= 4, `attendu au moins 4 zones mortes vérifiées (C-02, C-04, C-06 x2), obtenu ${deadZonesChecked}`);
});

test("B0-R-02 : toute zone valide NON morte (règle non-défaut, sans finding ZV-COVERED-BY-HIGHER ni ZV-DUPLICATE-ACROSS) est bien ATTEIGNABLE par au moins un code postal échantillonné -- elle-même", () => {
  let liveZonesChecked = 0;
  for (const testCase of fixture.cases) {
    const result = validateDeliveryZones({ shape: testCase.shape, rules: testCase.rules });
    const deadZoneKeys = new Set(
      result.findings
        .filter((f) => f.code === "ZV-COVERED-BY-HIGHER" || f.code === "ZV-DUPLICATE-ACROSS")
        .map((f) => `${f.ruleId}::${f.zone}`)
    );
    const formInvalidOrTooLongKeys = new Set(
      result.findings
        .filter((f) => f.code === "ZV-FORM-INVALID" || f.code === "ZV-TOO-LONG")
        .map((f) => `${f.ruleId}::${f.zone}`)
    );
    for (const rule of testCase.rules) {
      if (rule.isDefault) continue; // hors périmètre de l'analyse de couverture (contrat §4).
      for (const zone of rule.zones) {
        const key = `${rule.ruleId}::${zone}`;
        if (deadZoneKeys.has(key) || formInvalidOrTooLongKeys.has(key)) continue;
        // Zone valide et non signalée morte -- doit être atteignable
        // en l'utilisant elle-même comme candidat (elle "startsWith"
        // elle-même par construction).
        const resolved = simulateResolver(testCase.rules, zone);
        assert.equal(
          resolved.ruleId,
          rule.ruleId,
          `${testCase.id}: la zone vivante '${zone}' (règle '${rule.ruleId}') n'est PAS atteignable par le résolveur simulé -- incohérence entre B0 et la sémantique réelle`
        );
        liveZonesChecked += 1;
      }
    }
  }
  assert.ok(liveZonesChecked >= 10, `attendu au moins 10 zones vivantes vérifiées, obtenu ${liveZonesChecked}`);
});

test("B0-R-03 : la fixture PRÉEXISTANTE tests/fixtures/delivery-pricing-cases.json n'a pas été touchée par ce lot (hash SHA-256 identique à la baseline main@50f0775)", () => {
  const existingFixture = readFileSync("tests/fixtures/delivery-pricing-cases.json");
  const hash = createHash("sha256").update(existingFixture).digest("hex");
  assert.equal(
    hash,
    "8da0e05c592c2cc8ee4fff59ec7188cb106f7d362301ac7c1f82adc34625ad8e",
    "tests/fixtures/delivery-pricing-cases.json a changé -- interdit par le périmètre B0 (contrat §9/§10 : 4 fichiers créés, 0 modifié)"
  );
});

// ====================================================================
// Cas d'acceptation requis (contrat §11) -- un test par cas de la
// fixture partagée, vérification EXACTE (decision, findings dans
// l'ORDRE, normalizedRules).
// ====================================================================

for (const testCase of fixture.cases) {
  test(`${testCase.id} : ${testCase.description}`, () => {
    const input: ZoneValidationInput = { shape: testCase.shape, rules: testCase.rules };
    // Clone profond AVANT l'appel -- sert aussi à la preuve de
    // non-mutation ci-dessous (section déterminisme), mais vérifié
    // dès ici pour chaque cas individuellement.
    const inputSnapshotJson = JSON.stringify(input);

    const result = validateDeliveryZones(input);

    assert.equal(result.decision, testCase.expectedDecision, `${testCase.id}: decision`);
    assert.deepEqual(result.findings, testCase.expectedFindings, `${testCase.id}: findings (contenu ET ordre)`);
    assert.deepEqual(result.normalizedRules, testCase.expectedNormalizedRules, `${testCase.id}: normalizedRules`);

    assert.equal(JSON.stringify(input), inputSnapshotJson, `${testCase.id}: l'entrée ne doit JAMAIS être mutée`);
  });
}

// ====================================================================
// Déterminisme / pureté (contrat §8).
// ====================================================================

test("Déterminisme : 100 exécutions répétées sur la même entrée produisent un résultat structurellement IDENTIQUE (cas cascade C-06)", () => {
  const c06 = fixture.cases.find((c) => c.id === "C-06")!;
  const input: ZoneValidationInput = { shape: c06.shape, rules: c06.rules };
  const first = JSON.stringify(validateDeliveryZones(input));
  for (let i = 0; i < 100; i += 1) {
    const again = JSON.stringify(validateDeliveryZones(input));
    assert.equal(again, first, `exécution #${i}: résultat divergent`);
  }
});

test("Déterminisme : l'entrée n'est jamais mutée, même après plusieurs appels successifs (cas cascade C-06, tableaux imbriqués compris)", () => {
  const c06 = fixture.cases.find((c) => c.id === "C-06")!;
  const input: ZoneValidationInput = { shape: c06.shape, rules: c06.rules };
  const before = JSON.stringify(input);
  validateDeliveryZones(input);
  validateDeliveryZones(input);
  validateDeliveryZones(input);
  assert.equal(JSON.stringify(input), before);
});

test("Déterminisme : ordre de saisie des règles (tableau `rules`) sans effet sur `findings` NI sur la décision -- displayOrder, jamais la position dans le tableau, pilote le tri (sauf tie-break documenté à displayOrder égal)", () => {
  const c06 = fixture.cases.find((c) => c.id === "C-06")!;
  const original = c06.rules;
  const reversedNonDefaultThenDefault = [...original].reverse();
  // Une troisième permutation arbitraire (ni l'ordre original, ni
  // l'inverse strict) pour renforcer la preuve d'invariance.
  const shuffled = [original[2], original[0], original[3], original[1]];

  const baseline = validateDeliveryZones({ shape: c06.shape, rules: original });
  for (const permuted of [reversedNonDefaultThenDefault, shuffled]) {
    const candidate = validateDeliveryZones({ shape: c06.shape, rules: permuted });
    assert.equal(candidate.decision, baseline.decision, "decision doit être identique quel que soit l'ordre de saisie");
    assert.deepEqual(candidate.findings, baseline.findings, "findings (contenu ET ordre) doivent être identiques quel que soit l'ordre de saisie -- preuve directe de C-07 'attribution independent of current edited tariff' et de l'exigence §11 'unsorted input => same result as sorted input'");
    // normalizedRules, lui, suit l'ordre de SAISIE (contrat §5,
    // "must not reorder tariffs") -- donc PAS forcément identique en
    // tant que TABLEAU, seulement en tant qu'ENSEMBLE de règles
    // (comparé ici par ruleId, indépendamment de la position).
    const byId = (rs: ZoneRuleInput[]) =>
      Object.fromEntries(rs.map((r) => [r.ruleId, r]));
    assert.deepEqual(byId(candidate.normalizedRules), byId(baseline.normalizedRules), "le CONTENU de normalizedRules par règle doit être identique, indépendamment de l'ordre de saisie");
  }
});

test("Pureté : scan de source -- aucune dépendance interdite (Date, fetch, Math.random, Supabase, Next.js, React, services applicatifs), aucune API sensible à la locale", () => {
  for (const path of ["lib/delivery-zone-validation.ts", "lib/delivery-zone-validation-types.ts"]) {
    const src = readFileSync(path, "utf8");
    const forbiddenPatterns: Array<[RegExp, string]> = [
      [/\bnew Date\(/, "new Date("],
      [/\bDate\.now\(/, "Date.now("],
      [/\bfetch\s*\(/, "fetch("],
      [/\bMath\.random\(/, "Math.random("],
      [/@supabase/, "import Supabase"],
      [/\bfrom ["']next(\/|["'])/, "import next/*"],
      [/\bfrom ["']react(\/|["'])/, "import react/*"],
      [/\blib\/server\//, "import lib/server/*"],
      [/\blib\/services\//, "import lib/services/*"],
      [/\.toLocale[A-Za-z]*\(/, ".toLocale*("],
      [/\blocaleCompare\(/, ".localeCompare("],
    ];
    for (const [pattern, label] of forbiddenPatterns) {
      assert.ok(!pattern.test(src), `${path}: référence interdite trouvée -- ${label}`);
    }
  }
});

// ====================================================================
// Rapport de la valeur RÉELLEMENT observée de
// scanym_country_delivery_capability.postal_code_pattern pour FR
// (contrat §6, "report the actual observed value... If absent or
// unexpected, report -- do not infer"). Observée par lecture directe
// de supabase/DRAFT-lot-delivery-country-scope-v1.sql (seule
// migration qui insère cette ligne, jamais mise à jour ensuite --
// vérifié par recherche exhaustive de tout `update` sur cette table
// avant d'écrire ce test). Ce test ne CHANGE rien à B0 (décision
// D-B0-1 : B0 ne connaît aucun pays) -- il documente seulement
// l'observation exigée, de façon vérifiable et rejouable.
// ====================================================================

test("Observation (contrat §6, ne change rien à B0) : postal_code_pattern FR observé dans supabase/DRAFT-lot-delivery-country-scope-v1.sql", () => {
  const src = readFileSync("supabase/DRAFT-lot-delivery-country-scope-v1.sql", "utf8");
  assert.ok(
    src.includes("('FR', true,  '^[0-9]{5}$'"),
    "valeur attendue introuvable telle quelle -- si ce test échoue, la valeur RÉELLE a changé et doit être re-rapportée, jamais supposée"
  );
});
