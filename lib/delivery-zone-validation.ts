/**
 * DELIVERY PRICING v2 — B0 — DELIVERY ZONE VALIDATION.
 *
 * Module PUR de validation GÉOMÉTRIQUE des zones de livraison (issue
 * #11, contrat canonique figé de Ravel/CIO, commentaire
 * "DELIVERY PRICING v2 — B0 — CANONICAL CONTRACT NOW PROVIDED",
 * SHA-256 `6cb185117ea923457d268f4134d79d1768107c2bb1d588be39ea42212c355f0b`,
 * baseline `50f0775258607b99fc72323326e6d2c2b0f05ae2`).
 *
 * Étant donné une forme de code postal et l'ensemble ORDONNÉ des
 * règles tarifaires de livraison d'un établissement + mode de vente,
 * détecte -- AVANT toute sauvegarde -- les zones invalides, mortes,
 * redondantes ou trompeuses. Ne valide JAMAIS les prix, seuils, modes
 * de tarification, logique fournisseur, ni aucun calcul métier (hors
 * périmètre, contrat §1).
 *
 * SÉMANTIQUE DU RÉSOLVEUR REPRODUITE (contrat §2) -- vérifiée contre
 * le code RÉEL de `public.resolve_delivery_fulfillment`
 * (supabase/DRAFT-lot-server-delivery-fulfillment-pricing.sql,
 * commentaire de la fonction : "étend le résolveur LOT B.1 (algorithme
 * de correspondance INCHANGÉ)") avant d'écrire une seule ligne de ce
 * fichier -- AUCUNE divergence trouvée, donc AUCUN arrêt requis :
 *   1. correspondance par PRÉFIXE (`code like zp.prefix || '%'`) ;
 *   2. règles NON PAR DÉFAUT évaluées par `display_order ASC` ;
 *   3. la PREMIÈRE règle non-défaut ayant au moins un préfixe
 *      correspondant l'emporte (`order by display_order asc limit 1`
 *      sur les règles où `exists` un préfixe correspondant) ;
 *   4. au sein d'une règle, le PREMIER préfixe correspondant dans le
 *      TABLEAU (ordre de saisie, `ord` de `with ordinality`) est le
 *      préfixe retenu ;
 *   5. la règle de repli/défaut n'est utilisée QUE si aucune règle
 *      non-défaut ne correspond (`not exists (select 1 from
 *      matched_rule)`) ;
 *   6. la règle de repli/défaut NE TESTE JAMAIS ses propres zones
 *      (`fallback_rule` ne filtre pas sur `zone_prefixes`) ;
 *   7. une règle non-défaut à zones VIDES ne peut jamais correspondre
 *      (`exists (select 1 from unnest(...))` est faux sur un tableau
 *      vide -- la règle est alors exclue de `matched_rule`).
 * `resolve_delivery_fulfillment` N'EST PAS modifiée par ce lot
 * (interdit, contrat §13).
 *
 * DÉTERMINISME (contrat §8) : ce module ne lit ni horloge, ni réseau,
 * ni base de données, ne mute jamais son entrée, et ne dépend
 * d'aucune API sensible à la locale -- vérifié explicitement par un
 * test de scan de source (tests/b0-delivery-zone-validation.test.ts).
 */

import type {
  PostalCodeShape,
  ZoneFinding,
  ZoneFindingCode,
  ZoneFindingRemedy,
  ZoneRuleInput,
  ZoneValidationDecision,
  ZoneValidationInput,
  ZoneValidationResult,
} from "@/lib/delivery-zone-validation-types";

/**
 * Sévérité figée par code (contrat §3 -- "Blocking findings" /
 * "Advisory findings"). ZV-NO-DEFAULT est le SEUL code "advisory" à
 * sévérité INFO (jamais WARNING) : contrat §11, cas d'acceptation
 * "no default => NO_DEFAULT INFO only" -- ne fait donc JAMAIS
 * basculer `decision` vers ACCEPTED_WITH_WARNINGS à lui seul (§5,
 * "frozen invariants": "one BLOCKING_ERROR => REJECTED; else WARNING
 * => ACCEPTED_WITH_WARNINGS; else ACCEPTED" -- INFO n'est ni l'un ni
 * l'autre).
 */
const SEVERITY_BY_CODE: Record<ZoneFindingCode, "BLOCKING_ERROR" | "WARNING" | "INFO"> = {
  "ZV-FORM-INVALID": "BLOCKING_ERROR",
  "ZV-TOO-LONG": "BLOCKING_ERROR",
  "ZV-COVERED-BY-HIGHER": "BLOCKING_ERROR",
  "ZV-DUPLICATE-ACROSS": "BLOCKING_ERROR",
  "ZV-EMPTY-ZONES": "BLOCKING_ERROR",
  "ZV-NO-DEFAULT-NO-ZONES": "BLOCKING_ERROR",
  "ZV-INPUT-DUPLICATE-ORDER": "BLOCKING_ERROR",
  "ZV-INPUT-MULTIPLE-DEFAULTS": "BLOCKING_ERROR",
  "ZV-DUPLICATE-WITHIN": "WARNING",
  "ZV-REDUNDANT-WITHIN": "WARNING",
  "ZV-VERY-BROAD": "WARNING",
  "ZV-DEFAULT-HAS-ZONES": "WARNING",
  "ZV-NO-DEFAULT": "INFO",
};

/**
 * Choix de `remedy` par code. Le contrat n'impose EXPLICITEMENT que
 * deux associations (§3 : ZV-COVERED-BY-HIGHER -> REORDER_BEFORE ;
 * §11 : ZV-DEFAULT-HAS-ZONES -> REMOVE_ZONE). Pour les autres codes,
 * `remedy` est explicitement documenté comme "descriptive only ; B0
 * performs no action" (§5) -- ce module choisit donc, pour chaque
 * autre code bloquant/avertissement qui a une action corrective
 * évidente et SANS AMBIGUÏTÉ, la valeur de l'énumération figée qui la
 * décrit le mieux (ex. FIX_FORMAT pour une zone mal formée ou trop
 * longue, REMOVE_ZONE pour une zone en trop, ADD_ZONE pour une règle
 * sans aucune zone) -- jamais une valeur inventée hors de
 * `ZoneFindingRemedy`. Codes sans remedy explicite ci-dessous
 * (ZV-VERY-BROAD, ZV-INPUT-DUPLICATE-ORDER, ZV-INPUT-MULTIPLE-DEFAULTS,
 * ZV-NO-DEFAULT, ZV-NO-DEFAULT-NO-ZONES) : `remedy: null`, faute d'une
 * action ciblée unique et non ambiguë sur UNE zone/règle précise --
 * voir les appels `makeFinding` correspondants plus bas.
 */

/**
 * Sentinelle de tri pour un finding non rattaché à une règle précise
 * (ZV-NO-DEFAULT, ZV-NO-DEFAULT-NO-ZONES : conditions GLOBALES, pas
 * une règle en particulier) -- trie ces findings APRÈS tout finding
 * rattaché à une règle réelle. Choix documenté ici faute de précision
 * du contrat sur ce cas précis ; déterministe et stable, c'est
 * l'essentiel exigé (contrat §8).
 */
const NO_RULE_SORT_ORDER = Number.POSITIVE_INFINITY;
/** Sentinelle de tri pour un finding sans zone précise (ex. ZV-EMPTY-ZONES) -- trié avant toute zone réelle (position >= 0). */
const NO_ZONE_SORT_POSITION = -1;

function shapeAllowsChar(ch: string, shape: PostalCodeShape): boolean {
  if (shape.allowedChars === "digits") {
    return ch >= "0" && ch <= "9";
  }
  // "alnum" : chiffres et lettres ASCII (majuscules/minuscules), rien
  // d'autre -- jamais d'espace, jamais de ponctuation, jamais
  // d'accent (voir décision D-B0-2 : aucune tolérance silencieuse).
  return (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/**
 * Un zone-string a-t-il un format valide contre `shape` ? Décision
 * figée D-B0-2 : AUCUN trim silencieux -- une zone entourée d'espaces
 * (`" 75018 "`) est invalide EXACTEMENT parce que l'espace n'est
 * jamais un caractère autorisé par `shapeAllowsChar`, jamais par un
 * test de longueur post-trim déguisé.
 */
function hasValidForm(zone: string, shape: PostalCodeShape): boolean {
  if (zone.length === 0) return false;
  for (let i = 0; i < zone.length; i += 1) {
    if (!shapeAllowsChar(zone[i], shape)) return false;
  }
  return true;
}

type ZonePosition = {
  ruleIndex: number;
  rule: ZoneRuleInput;
  zone: string;
  /** Position de CETTE occurrence dans le tableau `zones` BRUT (avant déduplication) de sa règle -- clé de tri "zone position" (contrat §8). */
  zonePositionInRule: number;
};

function makeFinding(
  code: ZoneFindingCode,
  fields: {
    ruleId: string | null;
    ruleLabel: string;
    zone: string | null;
    relatedRuleId?: string | null;
    relatedRuleLabel?: string | null;
    relatedZone?: string | null;
    remedy?: ZoneFindingRemedy;
  }
): ZoneFinding {
  return {
    code,
    severity: SEVERITY_BY_CODE[code],
    ruleId: fields.ruleId,
    ruleLabel: fields.ruleLabel,
    zone: fields.zone,
    relatedRuleId: fields.relatedRuleId ?? null,
    relatedRuleLabel: fields.relatedRuleLabel ?? null,
    relatedZone: fields.relatedZone ?? null,
    remedy: fields.remedy ?? null,
  };
}

/**
 * Point d'entrée unique du module (contrat §5). Fonction PURE : ne
 * mute jamais `input` (chaque étape construit de nouvelles structures
 * -- aucune affectation sur `input.rules`/`.zones`), ne lit ni
 * horloge, ni réseau, ni base de données, aucun nombre aléatoire.
 */
export function validateDeliveryZones(input: ZoneValidationInput): ZoneValidationResult {
  const { shape, rules } = input;

  // "no rules at all => accepted, no finding" (contrat §11) -- cas
  // particulier explicite, AVANT toute autre analyse (une entrée vide
  // ne déclenche ni NO_DEFAULT ni NO_DEFAULT_NO_ZONES).
  if (rules.length === 0) {
    return { decision: "ACCEPTED", findings: [], normalizedRules: [] };
  }

  const findings: ZoneFinding[] = [];

  // ------------------------------------------------------------------
  // 1) Cohérence de la SAISIE elle-même (avant toute analyse de zone).
  // ------------------------------------------------------------------

  // ZV-INPUT-DUPLICATE-ORDER : deux règles partageant le même
  // displayOrder. Un finding par règle EXCÉDENTAIRE (au-delà de la
  // première rencontrée dans l'ordre de saisie), rattachée à la
  // première règle portant ce displayOrder -- déterministe, ne dépend
  // jamais de l'ordre de tri final.
  {
    const firstIndexByOrder = new Map<number, number>();
    rules.forEach((rule, index) => {
      const firstIndex = firstIndexByOrder.get(rule.displayOrder);
      if (firstIndex === undefined) {
        firstIndexByOrder.set(rule.displayOrder, index);
        return;
      }
      const firstRule = rules[firstIndex];
      findings.push(
        makeFinding("ZV-INPUT-DUPLICATE-ORDER", {
          ruleId: rule.ruleId,
          ruleLabel: rule.label,
          zone: null,
          relatedRuleId: firstRule.ruleId,
          relatedRuleLabel: firstRule.label,
        })
      );
    });
  }

  // ZV-INPUT-MULTIPLE-DEFAULTS : même principe, sur `isDefault`.
  {
    let firstDefaultIndex = -1;
    rules.forEach((rule, index) => {
      if (!rule.isDefault) return;
      if (firstDefaultIndex === -1) {
        firstDefaultIndex = index;
        return;
      }
      const firstRule = rules[firstDefaultIndex];
      findings.push(
        makeFinding("ZV-INPUT-MULTIPLE-DEFAULTS", {
          ruleId: rule.ruleId,
          ruleLabel: rule.label,
          zone: null,
          relatedRuleId: firstRule.ruleId,
          relatedRuleLabel: firstRule.label,
        })
      );
    });
  }

  // ------------------------------------------------------------------
  // 2) Forme de chaque zone (indépendante de sa règle) + variantes
  //    "très large" (VERY_BROAD, non bloquant).
  // ------------------------------------------------------------------

  // validZonesByRuleIndex : zones BIEN FORMÉES ET dans la plage de
  // longueur [minPrefixLength, exactLength] -- seules celles-ci
  // entrent dans les analyses de doublon/couverture (une chaîne mal
  // formée ou trop longue n'est pas une "zone" géographique
  // exploitable, voir le commentaire de hasValidForm ci-dessus).
  const validZonesByRuleIndex: string[][] = rules.map(() => []);

  rules.forEach((rule, ruleIndex) => {
    rule.zones.forEach((zone) => {
      if (!hasValidForm(zone, shape)) {
        findings.push(
          makeFinding("ZV-FORM-INVALID", {
            ruleId: rule.ruleId,
            ruleLabel: rule.label,
            zone,
            remedy: "FIX_FORMAT",
          })
        );
        return;
      }
      if (zone.length > shape.exactLength) {
        findings.push(
          makeFinding("ZV-TOO-LONG", {
            ruleId: rule.ruleId,
            ruleLabel: rule.label,
            zone,
            remedy: "FIX_FORMAT",
          })
        );
        return;
      }
      if (zone.length < shape.minPrefixLength) {
        findings.push(
          makeFinding("ZV-VERY-BROAD", {
            ruleId: rule.ruleId,
            ruleLabel: rule.label,
            zone,
          })
        );
        // "VERY_BROAD, accepted" (contrat §11, B0-F-06) : reste une
        // zone exploitable pour les analyses suivantes -- pas un rejet
        // de forme, juste un avertissement de portée.
      }
      validZonesByRuleIndex[ruleIndex].push(zone);
    });
  });

  // ------------------------------------------------------------------
  // 3) Déduplication EXACTE au sein d'une même règle (ZV-DUPLICATE-WITHIN)
  //    -- construit aussi normalizedRules (zones dédupliquées, ordre
  //    des zones RESTANTES préservé, aucune règle réordonnée).
  // ------------------------------------------------------------------

  const dedupedValidZonesByRuleIndex: string[][] = rules.map(() => []);
  const normalizedRules: ZoneRuleInput[] = rules.map((rule, ruleIndex) => {
    // Ne déduplique JAMAIS une zone mal formée (D-B0-2 : ne jamais
    // nettoyer silencieusement l'entrée) -- seule une zone BIEN
    // FORMÉE répétée est une "duplication" au sens du contrat
    // ("normalizedRules may deduplicate zones"). Une chaîne invalide
    // répétée reste répétée telle quelle dans normalizedRules ; chaque
    // occurrence continue de porter son propre ZV-FORM-INVALID/
    // ZV-TOO-LONG ci-dessus.
    const seenValid = new Set<string>();
    const dedupedRawZones: string[] = [];
    rule.zones.forEach((zone) => {
      const isValid = validZonesByRuleIndex[ruleIndex].includes(zone);
      if (isValid) {
        if (seenValid.has(zone)) {
          findings.push(
            makeFinding("ZV-DUPLICATE-WITHIN", {
              ruleId: rule.ruleId,
              ruleLabel: rule.label,
              zone,
              relatedRuleId: rule.ruleId,
              relatedRuleLabel: rule.label,
              relatedZone: zone,
              remedy: "REMOVE_ZONE",
            })
          );
          return;
        }
        seenValid.add(zone);
      }
      dedupedRawZones.push(zone);
    });
    dedupedValidZonesByRuleIndex[ruleIndex] = dedupedRawZones.filter((zone) =>
      validZonesByRuleIndex[ruleIndex].includes(zone)
    );
    return { ...rule, zones: dedupedRawZones };
  });

  // ------------------------------------------------------------------
  // 4) Redondance AU SEIN d'une même règle (ZV-REDUNDANT-WITHIN) : une
  //    zone plus large déjà présente dans LA MÊME règle rend une zone
  //    plus spécifique surperflue (elle ne change jamais le résultat,
  //    la règle correspond déjà via la zone large -- non bloquant).
  // ------------------------------------------------------------------

  rules.forEach((rule, ruleIndex) => {
    const zones = dedupedValidZonesByRuleIndex[ruleIndex];
    zones.forEach((zoneB) => {
      const covering = zones.find((zoneA) => zoneA !== zoneB && zoneB.startsWith(zoneA));
      if (covering) {
        findings.push(
          makeFinding("ZV-REDUNDANT-WITHIN", {
            ruleId: rule.ruleId,
            ruleLabel: rule.label,
            zone: zoneB,
            relatedRuleId: rule.ruleId,
            relatedRuleLabel: rule.label,
            relatedZone: covering,
            remedy: "REMOVE_ZONE",
          })
        );
      }
    });
  });

  // ------------------------------------------------------------------
  // 5) Couverture INTER-RÈGLES (ZV-COVERED-BY-HIGHER / ZV-DUPLICATE-ACROSS)
  //    -- règles NON-DÉFAUT uniquement (contrat §4, "Default/fallback
  //    rules are excluded from inter-rule coverage analysis"),
  //    ordonnées par displayOrder ASC puis par ordre de saisie à
  //    displayOrder égal (contrat §8, déterminisme).
  // ------------------------------------------------------------------

  const rankedPositions: ZonePosition[] = [];
  rules.forEach((rule, ruleIndex) => {
    if (rule.isDefault) return;
    dedupedValidZonesByRuleIndex[ruleIndex].forEach((zone) => {
      rankedPositions.push({
        ruleIndex,
        rule,
        zone,
        zonePositionInRule: rule.zones.indexOf(zone),
      });
    });
  });
  // Tri stable : displayOrder ASC, puis ordre de saisie du TABLEAU
  // `rules` (ruleIndex), puis position de la zone au sein de la règle
  // -- reproduit fidèlement §2.2/§2.3 du résolveur + le tie-break
  // explicite du §8 ("At duplicate displayOrder, preserve input
  // order").
  const rankedIndices = rankedPositions.map((_, i) => i);
  rankedIndices.sort((i, j) => {
    const a = rankedPositions[i];
    const b = rankedPositions[j];
    if (a.rule.displayOrder !== b.rule.displayOrder) return a.rule.displayOrder - b.rule.displayOrder;
    if (a.ruleIndex !== b.ruleIndex) return a.ruleIndex - b.ruleIndex;
    return a.zonePositionInRule - b.zonePositionInRule;
  });

  for (let rank = 0; rank < rankedIndices.length; rank += 1) {
    const current = rankedPositions[rankedIndices[rank]];
    // Cherche, PARMI LES ZONES ANTÉRIEURES (rang strictement
    // inférieur), la PREMIÈRE (donc la plus prioritaire pour le
    // résolveur réel) qui intercepte déjà `current.zone` -- exactement
    // ou par préfixe. C'est la cause RÉELLE, au sens du résolveur, si
    // plusieurs zones antérieures couvrent la même zone (voir le cas
    // "cascade" §11 C-06 : "7", "75", "75018" -- "75018" est mort à
    // cause de "7", pas de "75", car "7" gagne en premier).
    for (let earlierRank = 0; earlierRank < rank; earlierRank += 1) {
      const earlier = rankedPositions[rankedIndices[earlierRank]];
      if (earlier.ruleIndex === current.ruleIndex) continue; // paires intra-règle : ZV-REDUNDANT-WITHIN ci-dessus, pas ici.
      if (earlier.zone === current.zone) {
        findings.push(
          makeFinding("ZV-DUPLICATE-ACROSS", {
            ruleId: current.rule.ruleId,
            ruleLabel: current.rule.label,
            zone: current.zone,
            relatedRuleId: earlier.rule.ruleId,
            relatedRuleLabel: earlier.rule.label,
            relatedZone: earlier.zone,
            remedy: "REMOVE_ZONE",
          })
        );
        break;
      }
      if (current.zone.startsWith(earlier.zone)) {
        findings.push(
          makeFinding("ZV-COVERED-BY-HIGHER", {
            ruleId: current.rule.ruleId,
            ruleLabel: current.rule.label,
            zone: current.zone,
            relatedRuleId: earlier.rule.ruleId,
            relatedRuleLabel: earlier.rule.label,
            relatedZone: earlier.zone,
            remedy: "REORDER_BEFORE",
          })
        );
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // 6) Findings par règle : EMPTY_ZONES (non-défaut sans zone),
  //    DEFAULT_HAS_ZONES (défaut avec zone(s)).
  // ------------------------------------------------------------------

  rules.forEach((rule) => {
    if (!rule.isDefault && rule.zones.length === 0) {
      findings.push(
        makeFinding("ZV-EMPTY-ZONES", {
          ruleId: rule.ruleId,
          ruleLabel: rule.label,
          zone: null,
          remedy: "ADD_ZONE",
        })
      );
    }
    if (rule.isDefault) {
      // Une zone par finding (remedy REMOVE_ZONE cible CETTE zone
      // précise) -- toute zone brute présente sur une règle par défaut
      // est en trop, quelle que soit sa forme (une règle par défaut ne
      // teste jamais ses zones -- semantic §2.6 -- donc AUCUNE zone
      // n'y a sa place).
      const seen = new Set<string>();
      rule.zones.forEach((zone) => {
        if (seen.has(zone)) return; // déjà signalée une fois par ZV-DUPLICATE-WITHIN si bien formée -- pas la peine de la répéter ici pour DEFAULT_HAS_ZONES.
        seen.add(zone);
        findings.push(
          makeFinding("ZV-DEFAULT-HAS-ZONES", {
            ruleId: rule.ruleId,
            ruleLabel: rule.label,
            zone,
            remedy: "REMOVE_ZONE",
          })
        );
      });
    }
  });

  // ------------------------------------------------------------------
  // 7) Findings GLOBAUX (pas rattachés à une règle précise) :
  //    NO_DEFAULT (info), NO_DEFAULT_NO_ZONES (bloquant).
  // ------------------------------------------------------------------

  const hasDefault = rules.some((rule) => rule.isDefault);
  const hasAnyZoneAnywhere = rules.some((rule) => rule.zones.length > 0);

  if (!hasDefault) {
    findings.push(
      makeFinding("ZV-NO-DEFAULT", {
        ruleId: null,
        // Pas de règle concrète pour ce finding global -- chaîne vide
        // documentée comme sentinelle (ruleLabel n'est pas nullable
        // dans le contrat public §5).
        ruleLabel: "",
        zone: null,
      })
    );
  }
  if (!hasDefault && !hasAnyZoneAnywhere) {
    findings.push(
      makeFinding("ZV-NO-DEFAULT-NO-ZONES", {
        ruleId: null,
        ruleLabel: "",
        zone: null,
      })
    );
  }

  // ------------------------------------------------------------------
  // 8) Tri final (contrat §8) : displayOrder ASC (findings globaux en
  //    dernier), puis position de la zone dans le tableau BRUT de sa
  //    règle (findings sans zone en premier), puis code ASCII/littéral
  //    -- comparaison par `<`/`>` sur des chaînes JS, jamais
  //    localeCompare/toLocale*. Tri STABLE (Array#sort de Node est
  //    stable) : à clés identiques, l'ordre de génération ci-dessus
  //    (lui-même entièrement déterministe) tranche.
  // ------------------------------------------------------------------

  const ruleById = new Map<string, ZoneRuleInput>();
  rules.forEach((rule) => {
    if (rule.ruleId !== null) ruleById.set(rule.ruleId, rule);
  });
  function displayOrderOf(finding: ZoneFinding): number {
    if (finding.ruleId === null) return NO_RULE_SORT_ORDER;
    return ruleById.get(finding.ruleId)?.displayOrder ?? NO_RULE_SORT_ORDER;
  }
  function zonePositionOf(finding: ZoneFinding): number {
    if (finding.zone === null || finding.ruleId === null) return NO_ZONE_SORT_POSITION;
    const rule = ruleById.get(finding.ruleId);
    if (!rule) return NO_ZONE_SORT_POSITION;
    const position = rule.zones.indexOf(finding.zone);
    return position === -1 ? NO_ZONE_SORT_POSITION : position;
  }

  const sortedFindings = findings
    .map((finding, originalIndex) => ({ finding, originalIndex }))
    .sort((a, b) => {
      const orderDiff = displayOrderOf(a.finding) - displayOrderOf(b.finding);
      if (orderDiff !== 0) return orderDiff;
      const positionDiff = zonePositionOf(a.finding) - zonePositionOf(b.finding);
      if (positionDiff !== 0) return positionDiff;
      if (a.finding.code !== b.finding.code) return a.finding.code < b.finding.code ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.finding);

  // ------------------------------------------------------------------
  // 9) Décision (contrat §5, "frozen invariants").
  // ------------------------------------------------------------------

  let decision: ZoneValidationDecision = "ACCEPTED";
  if (sortedFindings.some((f) => f.severity === "BLOCKING_ERROR")) {
    decision = "REJECTED";
  } else if (sortedFindings.some((f) => f.severity === "WARNING")) {
    decision = "ACCEPTED_WITH_WARNINGS";
  }

  return { decision, findings: sortedFindings, normalizedRules };
}
