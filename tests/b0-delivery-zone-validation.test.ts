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
// AMENDEMENT (arbitrage de conception Debussy après audit FAIL de
// Chateaubriand sur le candidat `25ce692e962d03258d0b4462abeffd5f1cc575d5`,
// issue #11, commentaires `5905379897`/`5905402555`) -- D-B0-5 :
// B0-R-01/B0-R-02 sont réécrits en TÉMOINS (witnesses) : un code postal
// COMPLET (longueur exacte, forme valide), jamais la zone-préfixe
// elle-même utilisée comme "candidat" (Blocker 2 de Chateaubriand --
// une zone-préfixe n'est PAS nécessairement un code postal réel).
// L'ancienne vérification d'intégrité par hash (étiquetée B0-R-03 dans
// la première livraison) est renommée B0-INTEGRITY-01 -- ce nom est
// maintenant repris par une preuve de cohérence différente -- et sa
// sensibilité aux fins de ligne (CRLF/LF, limite constatée par le
// replay Windows de Chateaubriand) est corrigée par normalisation
// avant hachage.
//
// Périmètre STRICT (contrat §13) : ce fichier ne modifie AUCUN fichier
// existant, ne touche jamais `resolve_delivery_fulfillment` ni
// `lib/delivery.ts`. Le "simulateur de résolveur" et le "chercheur de
// témoin" ci-dessous sont des outils de TEST PUR, autonomes, qui
// REPRODUISENT la sémantique déjà vérifiée par lecture directe du SQL
// réel (voir le commentaire de tête de lib/delivery-zone-validation.ts)
// -- ils n'appellent, n'importent ni ne modifient aucun code de
// production, et n'existent que pour la preuve de cohérence exigée par
// le contrat §11 (amendée D-B0-5).
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

// --------------------------------------------------------------------
// D-B0-5 -- Reproduction INDÉPENDANTE (TEST-ONLY) du classement
// "resolver order" des zones non-défaut : displayOrder ASC, puis ordre
// de saisie du tableau `rules` à égalité -- mêmes règles que le module
// (contrat §2.2/§2.3/§8), mais réimplémentées ici sans jamais appeler
// le code de production, pour que la preuve de cohérence soit
// RÉELLEMENT indépendante.
// --------------------------------------------------------------------
function hasValidFormTestOnly(zone: string, shape: ZoneValidationInput["shape"]): boolean {
  if (zone.length === 0) return false;
  for (const ch of zone) {
    const isDigit = ch >= "0" && ch <= "9";
    const isAlpha = (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
    if (shape.allowedChars === "digits" ? !isDigit : !(isDigit || isAlpha)) return false;
  }
  return true;
}

function rankedNonDefaultZones(
  shape: ZoneValidationInput["shape"],
  rules: ZoneRuleInput[]
): Array<{ ruleIndex: number; ruleId: string | null; ruleLabel: string; zone: string }> {
  const entries: Array<{ ruleIndex: number; displayOrder: number; ruleId: string | null; ruleLabel: string; zone: string }> = [];
  rules.forEach((rule, ruleIndex) => {
    if (rule.isDefault) return;
    const seenExact = new Set<string>();
    rule.zones.forEach((zone) => {
      if (!hasValidFormTestOnly(zone, shape)) return; // ZV-FORM-INVALID -- hors périmètre de l'analyse de couverture.
      if (zone.length > shape.exactLength) return; // ZV-TOO-LONG -- idem.
      if (seenExact.has(zone)) return; // doublon EXACT au sein de la règle -- déjà dédupliqué en production (ZV-DUPLICATE-WITHIN).
      seenExact.add(zone);
      entries.push({ ruleIndex, displayOrder: rule.displayOrder, ruleId: rule.ruleId, ruleLabel: rule.label, zone });
    });
  });
  entries.sort((a, b) => a.displayOrder - b.displayOrder || a.ruleIndex - b.ruleIndex);
  return entries.map(({ ruleIndex, ruleId, ruleLabel, zone }) => ({ ruleIndex, ruleId, ruleLabel, zone }));
}

const ALPHABETS: Record<"digits" | "alnum", string[]> = {
  digits: "0123456789".split(""),
  alnum: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split(""),
};

/**
 * D-B0-5 -- Recherche PAR BACKTRACKING (TEST-ONLY) d'un TÉMOIN : un
 * code postal COMPLET (longueur EXACTE `shape.exactLength`, forme
 * valide) qui commence par `zone` et n'est dominé par AUCUNE zone
 * antérieure de `earlierZones` (déjà classées "resolver order" par
 * `rankedNonDefaultZones`, ordre STRICTEMENT antérieur à `zone`).
 *
 * Une zone antérieure `e` DOMINE un candidat `c = zone + suffixe` de
 * deux façons possibles (jamais d'autre) :
 *   (a) `e` est un préfixe de `zone` elle-même (`e.length <=
 *       zone.length`, `zone.startsWith(e)`) -- alors TOUT candidat
 *       commençant par `zone` commence aussi par `e` : domination
 *       INCONDITIONNELLE, aucun témoin ne peut jamais exister (c'est
 *       exactement ZV-COVERED-BY-HIGHER / ZV-DUPLICATE-ACROSS, contrat
 *       §4 d'origine).
 *   (b) `e` ÉTEND `zone` (`e.length > zone.length`,
 *       `e.startsWith(zone)`) -- alors seule une partie des suffixes
 *       possibles est dominée (celle qui commence par
 *       `e.slice(zone.length)`) : c'est le cas COLLECTIF (D-B0-4,
 *       ZV-UNREACHABLE-BY-HIGHER-SET), qui nécessite le parcours
 *       ci-dessous.
 * Un `earlierZones` sans rapport avec `zone` (ni préfixe ni extension)
 * ne peut jamais dominer aucun candidat -- ignoré silencieusement.
 *
 * Une ABSENCE de témoin (retour `null`) est une PREUVE D'INATTEIGNABILITÉ
 * COMPLÈTE, pas seulement l'échec d'une tentative : l'élagage ne retire
 * jamais qu'un sous-arbre INTÉGRALEMENT dominé (tout candidat de ce
 * sous-arbre partage le même préfixe dominant), donc le parcours
 * explore bien, par construction, l'espace ENTIER des suffixes
 * possibles.
 */
function findWitness(
  shape: ZoneValidationInput["shape"],
  earlierZones: string[],
  zone: string
): string | null {
  // Cas (a) : domination inconditionnelle.
  if (earlierZones.some((e) => e.length <= zone.length && zone.startsWith(e))) return null;

  const k = shape.exactLength - zone.length;
  if (k === 0) return zone; // déjà de longueur maximale -- rien à compléter, aucune zone ne peut plus l'étendre.

  // Cas (b) : suffixes bloquants (zones antérieures qui ÉTENDENT `zone`).
  const blockingSuffixes = earlierZones
    .filter((e) => e.length > zone.length && e.startsWith(zone))
    .map((e) => e.slice(zone.length));

  const alphabet = ALPHABETS[shape.allowedChars];

  function isDominated(partial: string): boolean {
    return blockingSuffixes.some((s) => s.length <= partial.length && partial.startsWith(s));
  }

  function search(partial: string): string | null {
    if (isDominated(partial)) return null;
    if (partial.length === k) return zone + partial;
    for (const ch of alphabet) {
      const found = search(partial + ch);
      if (found !== null) return found;
    }
    return null;
  }

  return search("");
}

// ====================================================================
// B0-R-01 / B0-R-02 -- écrits EN PREMIER (avant les cas d'acceptation
// détaillés ci-dessous), conformément à la consigne littérale du
// contrat §11 ("Write B0-R-01 and B0-R-02 EARLY"). Réécrits en TÉMOINS
// complets par l'amendement D-B0-5 (voir le commentaire de tête).
// ====================================================================

test("B0-R-01 : toute zone portant un finding bloquant de couverture (ZV-COVERED-BY-HIGHER, ZV-DUPLICATE-ACROSS ou ZV-UNREACHABLE-BY-HIGHER-SET, D-B0-4) est bien INATTEIGNABLE -- AUCUN témoin (code postal complet, forme valide) commençant par cette zone ne peut jamais résoudre vers sa propre règle, quelle que soit sa complétion", () => {
  let deadZonesChecked = 0;
  for (const testCase of fixture.cases) {
    const ranked = rankedNonDefaultZones(testCase.shape, testCase.rules);
    const result = validateDeliveryZones({ shape: testCase.shape, rules: testCase.rules });
    for (const finding of result.findings) {
      if (
        finding.code !== "ZV-COVERED-BY-HIGHER" &&
        finding.code !== "ZV-DUPLICATE-ACROSS" &&
        finding.code !== "ZV-UNREACHABLE-BY-HIGHER-SET"
      ) {
        continue;
      }
      assert.ok(finding.zone, `${testCase.id}: finding ${finding.code} sans zone`);
      const rank = ranked.findIndex((e) => e.ruleId === finding.ruleId && e.ruleLabel === finding.ruleLabel && e.zone === finding.zone);
      assert.ok(rank >= 0, `${testCase.id}: zone signalée '${finding.zone}' (règle '${finding.ruleId}') introuvable dans le classement resolver-order indépendant`);
      // Exclut les zones ANTÉRIEURES de la MÊME règle (`ruleIndex`
      // identique) -- une paire intra-règle ne "domine" jamais au sens
      // de la couverture inter-règles (ZV-REDUNDANT-WITHIN couvre déjà
      // ce cas séparément, non bloquant) : matcher n'importe quelle
      // zone de SA PROPRE règle fait de toute façon gagner la MÊME
      // règle, donc n'a AUCUN effet sur l'atteignabilité de la règle
      // elle-même (même principe que `earlier.ruleIndex ===
      // current.ruleIndex` en production, étape 1 ET étape 2).
      const earlierZones = ranked
        .slice(0, rank)
        .filter((e) => e.ruleIndex !== ranked[rank]!.ruleIndex)
        .map((e) => e.zone);
      const witness = findWitness(testCase.shape, earlierZones, finding.zone!);
      assert.equal(
        witness,
        null,
        `${testCase.id}: un témoin existe ('${witness}') pour la zone signalée morte '${finding.zone}' (règle '${finding.ruleId}', ${finding.code}) -- faux positif`
      );
      deadZonesChecked += 1;
    }
  }
  // Preuve que ce test exerce RÉELLEMENT au moins un cas (sinon la
  // boucle ci-dessus serait vide et le test passerait trivialement
  // sans rien prouver -- garde-fou contre un fixture cassé).
  assert.ok(
    deadZonesChecked >= 5,
    `attendu au moins 5 zones mortes vérifiées (C-02, C-04, C-06 x2, COLLECTIVE-01, PREC-01 x2...), obtenu ${deadZonesChecked}`
  );
});

test("B0-R-02 / B0-R-03 : toute zone valide NON morte (règle non-défaut, sans finding bloquant de couverture) est bien ATTEIGNABLE -- un témoin (code postal COMPLET, forme valide) existe ET, la simulation du résolveur le confirme, ce témoin sélectionne bien le TARIF attendu (jamais un autre)", () => {
  let liveZonesChecked = 0;
  for (const testCase of fixture.cases) {
    const ranked = rankedNonDefaultZones(testCase.shape, testCase.rules);
    const result = validateDeliveryZones({ shape: testCase.shape, rules: testCase.rules });
    const deadKeys = new Set(
      result.findings
        .filter(
          (f) =>
            f.code === "ZV-COVERED-BY-HIGHER" ||
            f.code === "ZV-DUPLICATE-ACROSS" ||
            f.code === "ZV-UNREACHABLE-BY-HIGHER-SET"
        )
        .map((f) => `${f.ruleId}::${f.zone}`)
    );
    ranked.forEach((entry, rank) => {
      const key = `${entry.ruleId}::${entry.zone}`;
      if (deadKeys.has(key)) return;
      // Voir le commentaire équivalent dans B0-R-01 -- exclut les
      // zones antérieures de la MÊME règle (paire intra-règle, sans
      // effet sur l'atteignabilité de la règle).
      const earlierZones = ranked
        .slice(0, rank)
        .filter((e) => e.ruleIndex !== entry.ruleIndex)
        .map((e) => e.zone);
      // B0-R-02 : le témoin existe.
      const witness = findWitness(testCase.shape, earlierZones, entry.zone);
      assert.ok(
        witness !== null,
        `${testCase.id}: AUCUN témoin trouvé pour la zone vivante '${entry.zone}' (règle '${entry.ruleId}') -- incohérence entre B0 (qui la considère vivante) et la recherche indépendante`
      );
      assert.equal(witness!.length, testCase.shape.exactLength, `${testCase.id}: le témoin '${witness}' n'a pas la longueur exacte attendue`);
      // B0-R-03 (redéfini D-B0-5) : le témoin exhibé, une fois soumis
      // au simulateur de résolveur INDÉPENDANT, sélectionne bien le
      // tarif attendu -- jamais un autre.
      const resolved = simulateResolver(testCase.rules, witness!);
      assert.equal(
        resolved.ruleId,
        entry.ruleId,
        `${testCase.id}: le témoin '${witness}' ne résout PAS vers la règle attendue '${entry.ruleId}' (résolu : '${resolved.ruleId}')`
      );
      liveZonesChecked += 1;
    });
  }
  assert.ok(liveZonesChecked >= 10, `attendu au moins 10 zones vivantes vérifiées, obtenu ${liveZonesChecked}`);
});

test("B0-R-04 : couverture de la taxonomie de saturation collective (D-B0-4) -- les cas de référence (saturation complète, sous-saturation, précédence étape1/étape2, zone antérieure invalide sans effet, règle par défaut sans effet, garde de sécurité numérique) sont bien présents dans la fixture partagée et produisent le code attendu", () => {
  const expectedByCaseId: Record<string, string | null> = {
    "COLLECTIVE-01": "ZV-UNREACHABLE-BY-HIGHER-SET",
    "COLLECTIVE-02": null, // sous-saturation (9/10) -- aucun finding de couverture.
    "PREC-01": "ZV-COVERED-BY-HIGHER", // précédence étape 1, jamais ZV-UNREACHABLE-BY-HIGHER-SET pour '75'.
    "INVALID-PRIOR-01": null, // zone antérieure invalide '7X' -- sans effet, '7' vivante.
    "DEFAULT-NOEFFECT-01": null, // zones du repli -- sans effet, '7' vivante.
    "REACH-NOTCOMPUTED-01": null, // abstention (ZV-REACHABILITY-NOT-COMPUTED), pas un finding de couverture.
  };
  for (const [caseId, expectedCode] of Object.entries(expectedByCaseId)) {
    const testCase = fixture.cases.find((c) => c.id === caseId);
    assert.ok(testCase, `cas de référence '${caseId}' absent de la fixture`);
    const result = validateDeliveryZones({ shape: testCase!.shape, rules: testCase!.rules });
    const coverageFindings = result.findings.filter(
      (f) => f.code === "ZV-COVERED-BY-HIGHER" || f.code === "ZV-DUPLICATE-ACROSS" || f.code === "ZV-UNREACHABLE-BY-HIGHER-SET"
    );
    if (expectedCode === null) {
      assert.equal(coverageFindings.length, 0, `${caseId}: attendu aucun finding de couverture, obtenu ${JSON.stringify(coverageFindings.map((f) => f.code))}`);
    } else {
      assert.ok(
        coverageFindings.some((f) => f.code === expectedCode),
        `${caseId}: attendu au moins un finding '${expectedCode}', obtenu ${JSON.stringify(coverageFindings.map((f) => f.code))}`
      );
    }
  }
  // REACH-NOTCOMPUTED-01 exerce spécifiquement l'abstention numérique.
  const reachCase = fixture.cases.find((c) => c.id === "REACH-NOTCOMPUTED-01")!;
  const reachResult = validateDeliveryZones({ shape: reachCase.shape, rules: reachCase.rules });
  assert.ok(
    reachResult.findings.some((f) => f.code === "ZV-REACHABILITY-NOT-COMPUTED"),
    "REACH-NOTCOMPUTED-01: attendu ZV-REACHABILITY-NOT-COMPUTED"
  );
});

test("B0-INTEGRITY-01 (anciennement étiqueté B0-R-03 -- ce nom est repris par une preuve différente depuis D-B0-5) : la fixture PRÉEXISTANTE tests/fixtures/delivery-pricing-cases.json n'a pas été touchée par ce lot (hash SHA-256 identique à la baseline main@50f0775, CRLF-agnostique -- limite Windows constatée par le replay de Chateaubriand sur PR #119/#120 : les fins de ligne sont normalisées LF avant hachage, pour ne jamais dépendre du paramétrage de checkout git)", () => {
  const existingFixtureText = readFileSync("tests/fixtures/delivery-pricing-cases.json", "utf8");
  const normalized = existingFixtureText.replace(/\r\n/g, "\n");
  const hash = createHash("sha256").update(normalized, "utf8").digest("hex");
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

test("B0-DET-06 (D-B0-3) : le tri des findings, pour une règle NON SAUVEGARDÉE (ruleId null) rattachée à un displayOrder réel, ne dépend JAMAIS de l'ordre de SAISIE du tableau `rules` -- même résultat, règle non sauvegardée en premier OU en second dans le tableau d'entrée (bug racine Chateaubriand : ruleId===null ne doit JAMAIS agir comme proxy de tri)", () => {
  const nullIdRule: ZoneRuleInput = { ruleId: null, label: "Nouveau tarif (non enregistré)", displayOrder: 0, isDefault: false, zones: [] };
  const savedRule: ZoneRuleInput = { ruleId: "r2", label: "Zone B", displayOrder: 1, isDefault: false, zones: [] };
  const shape: ZoneValidationInput["shape"] = { allowedChars: "digits", exactLength: 5, minPrefixLength: 1 };

  const inOrder = validateDeliveryZones({ shape, rules: [nullIdRule, savedRule] });
  const reversed = validateDeliveryZones({ shape, rules: [savedRule, nullIdRule] });

  assert.deepEqual(reversed.findings, inOrder.findings, "l'ordre de SAISIE du tableau `rules` ne doit jamais changer l'ordre des findings -- seul le displayOrder RÉEL de chaque règle pilote le tri");
  // Preuve positive et non tautologique : la règle non sauvegardée
  // (displayOrder 0) doit trier AVANT la règle sauvegardée
  // (displayOrder 1) dans les DEUX permutations -- l'ancien bug aurait
  // trié le finding de la règle non sauvegardée en DERNIER (sentinelle
  // ruleId===null traitée comme "global").
  assert.equal(inOrder.findings[0]!.ruleId, null, "le finding de displayOrder 0 (règle non sauvegardée) doit être en PREMIER");
  assert.equal(inOrder.findings[1]!.ruleId, "r2", "le finding de displayOrder 1 (règle sauvegardée) doit être en SECOND");
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
