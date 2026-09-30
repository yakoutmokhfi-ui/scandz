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
 *
 * AMENDEMENT (arbitrage de conception Debussy après audit FAIL de
 * Chateaubriand sur le candidat `25ce692e962d03258d0b4462abeffd5f1cc575d5`,
 * issue #11, commentaires `5905379897`/`5905402555`, "PR #120 — B0
 * CONTRACT ARBITRATION FINAL — REMEDIATION GO") :
 *   - D-B0-3 : le tri des findings n'utilise plus JAMAIS `ruleId` --
 *     bug racine trouvé par Chateaubriand : une règle NON SAUVEGARDÉE
 *     (`ruleId: null`) peut légitimement être rattachée à un TARIF
 *     précis (son propre `displayOrder`), donc `ruleId === null`
 *     n'est jamais un proxy valide pour "finding global, sans tarif".
 *     Chaque finding porte désormais sa propre clé de tri, calculée à
 *     sa CRÉATION directement depuis l'objet règle réel (`rule`,
 *     jamais re-dérivée après coup via une structure indexée par
 *     `ruleId`) -- voir `makeFinding`/`SortKey` ci-dessous.
 *   - D-B0-4 : accessibilité COMPLÈTE d'une zone se vérifie en DEUX
 *     étapes : (1) domination PAR PAIRE (§4 d'origine, INCHANGÉE --
 *     une zone antérieure unique couvre déjà entièrement la zone
 *     courante) ; (2) NOUVEAU -- saturation COLLECTIVE : si aucune
 *     zone antérieure unique ne domine la zone courante, un ENSEMBLE
 *     de zones antérieures qui l'ÉTENDENT (préfixe = la zone
 *     courante) peut néanmoins saturer collectivement tout l'espace
 *     restant sous cette zone (ex. "7" mort par "70".."79" réunies,
 *     bien qu'aucune seule ne domine "7"). Nouveau code bloquant
 *     `ZV-UNREACHABLE-BY-HIGHER-SET`, avec des champs relationnels
 *     PLURIELS (une cause collective n'a pas une seule règle/zone
 *     liée, mais l'antichaîne minimale retenue).
 *   - Nouveau code `ZV-REACHABILITY-NOT-COMPUTED` (INFO) : abstention
 *     EXPLICITE quand le calcul combinatoire de la saturation
 *     collective dépasserait la précision entière sûre de JavaScript
 *     (2^53) -- jamais une réponse inexacte calculée en flottant.
 *   - D-B0-6 : `ZV-REDUNDANT-WITHIN` ne recommande plus `REMOVE_ZONE`
 *     (`remedy: null`) -- retirer la zone la plus spécifique
 *     changerait le `matched_prefix` RÉEL retourné par le résolveur
 *     pour les codes qu'elle seule matchait exactement ; ce n'était
 *     donc pas un remedy neutre (signalé par Chateaubriand). Aucune
 *     autre association `remedy` n'a changé.
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
 * "Advisory findings", étendue par l'amendement D-B0-4).
 * ZV-NO-DEFAULT et ZV-REACHABILITY-NOT-COMPUTED sont les SEULS codes à
 * sévérité INFO (jamais WARNING) : contrat §11, cas d'acceptation
 * "no default => NO_DEFAULT INFO only" -- ne font donc JAMAIS
 * basculer `decision` vers ACCEPTED_WITH_WARNINGS à eux seuls (§5,
 * "frozen invariants": "one BLOCKING_ERROR => REJECTED; else WARNING
 * => ACCEPTED_WITH_WARNINGS; else ACCEPTED" -- INFO n'est ni l'un ni
 * l'autre).
 */
const SEVERITY_BY_CODE: Record<ZoneFindingCode, "BLOCKING_ERROR" | "WARNING" | "INFO"> = {
  "ZV-FORM-INVALID": "BLOCKING_ERROR",
  "ZV-TOO-LONG": "BLOCKING_ERROR",
  "ZV-COVERED-BY-HIGHER": "BLOCKING_ERROR",
  "ZV-UNREACHABLE-BY-HIGHER-SET": "BLOCKING_ERROR",
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
  "ZV-REACHABILITY-NOT-COMPUTED": "INFO",
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
 * ZV-NO-DEFAULT, ZV-NO-DEFAULT-NO-ZONES, ZV-UNREACHABLE-BY-HIGHER-SET,
 * ZV-REACHABILITY-NOT-COMPUTED) : `remedy: null`, faute d'une action
 * ciblée unique et non ambiguë sur UNE zone/règle précise (pour les
 * deux derniers, amendement D-B0-4/D-B0-6 : une cause COLLECTIVE n'a,
 * par nature, aucune zone unique dont le retrait serait un remedy non
 * ambigu -- voir aussi D-B0-6 ci-dessus pour ZV-REDUNDANT-WITHIN, dont
 * le remedy est passé de REMOVE_ZONE à null) -- voir les appels
 * `makeFinding` correspondants plus bas.
 */

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

/**
 * Réduit un ensemble de suffixes (déjà dédupliqué EXACTEMENT -- un
 * `Set`) à son ANTICHAÎNE minimale (D-B0-4) : retire tout suffixe
 * ayant un suffixe STRICTEMENT plus court déjà retenu comme préfixe --
 * ce suffixe plus court sature déjà TOUT l'espace de codes couvert par
 * le plus long (un préfixe plus court impose moins de contraintes,
 * donc couvre un sur-ensemble strict). Traite les suffixes du plus
 * court au plus long : à longueur égale, deux suffixes distincts ne
 * peuvent jamais être l'un le préfixe de l'autre (ils seraient
 * identiques), donc aucune comparaison inter-longueur-égale n'est
 * nécessaire.
 */
function reduceToAntichain(suffixes: Set<string>): Set<string> {
  const sorted = Array.from(suffixes).sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const suffix of sorted) {
    const dominated = kept.some((shorter) => suffix.startsWith(shorter));
    if (!dominated) kept.push(suffix);
  }
  return new Set(kept);
}

type SortKey = {
  /** 0 = finding rattaché à une règle réelle (tarif-scoped) ; 1 = finding GLOBAL, sans règle (ZV-NO-DEFAULT, ZV-NO-DEFAULT-NO-ZONES). Trie tout finding tarif-scoped AVANT tout finding global (contrat §8, comportement inchangé -- seule la CLASSIFICATION change, voir D-B0-3 ci-dessus). */
  scopeRank: 0 | 1;
  /** displayOrder du tarif propriétaire ; 0 (sentinelle) pour un finding global. */
  displayOrder: number;
  /** Position BRUTE (pré-déduplication) de la zone dans le tableau `zones` de sa règle ; NO_ZONE_SORT_POSITION (-1) si le finding n'a pas de zone précise ou est global. */
  zoneIndex: number;
};

type InternalFinding = ZoneFinding & { __sortKey: SortKey };

function makeFinding(
  code: ZoneFindingCode,
  fields: {
    /**
     * La règle RÉELLE propriétaire de ce finding, ou `null` UNIQUEMENT
     * pour un finding GLOBAL (ZV-NO-DEFAULT, ZV-NO-DEFAULT-NO-ZONES).
     * C'est cet objet -- jamais `ruleId` -- qui détermine la clé de
     * tri (D-B0-3) : un `rule` non-null avec `ruleId: null` (règle non
     * sauvegardée) reste correctement classé "tarif-scoped".
     */
    rule: ZoneRuleInput | null;
    /** Position BRUTE (pré-déduplication) de la zone dans `rule.zones`, quand ce finding porte sur une zone précise d'une règle réelle. */
    zoneIndexInRule?: number;
    zone: string | null;
    relatedRuleId?: string | null;
    relatedRuleLabel?: string | null;
    relatedZone?: string | null;
    relatedRuleIds?: (string | null)[];
    relatedRuleLabels?: string[];
    relatedZones?: string[];
    remedy?: ZoneFindingRemedy;
  }
): InternalFinding {
  const sortKey: SortKey =
    fields.rule === null
      ? { scopeRank: 1, displayOrder: 0, zoneIndex: NO_ZONE_SORT_POSITION }
      : {
          scopeRank: 0,
          displayOrder: fields.rule.displayOrder,
          zoneIndex: fields.zoneIndexInRule ?? NO_ZONE_SORT_POSITION,
        };
  const finding: InternalFinding = {
    code,
    severity: SEVERITY_BY_CODE[code],
    ruleId: fields.rule?.ruleId ?? null,
    ruleLabel: fields.rule?.label ?? "",
    zone: fields.zone,
    relatedRuleId: fields.relatedRuleId ?? null,
    relatedRuleLabel: fields.relatedRuleLabel ?? null,
    relatedZone: fields.relatedZone ?? null,
    remedy: fields.remedy ?? null,
    __sortKey: sortKey,
  };
  if (fields.relatedRuleIds) finding.relatedRuleIds = fields.relatedRuleIds;
  if (fields.relatedRuleLabels) finding.relatedRuleLabels = fields.relatedRuleLabels;
  if (fields.relatedZones) finding.relatedZones = fields.relatedZones;
  return finding;
}

type ZonePosition = {
  ruleIndex: number;
  rule: ZoneRuleInput;
  zone: string;
  /** Position de CETTE occurrence dans le tableau `zones` BRUT (avant déduplication) de sa règle -- clé de tri "zone position" (contrat §8). */
  zonePositionInRule: number;
};

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

  const findings: InternalFinding[] = [];

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
          rule,
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
          rule,
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
    rule.zones.forEach((zone, zoneIndex) => {
      if (!hasValidForm(zone, shape)) {
        findings.push(
          makeFinding("ZV-FORM-INVALID", {
            rule,
            zoneIndexInRule: zoneIndex,
            zone,
            remedy: "FIX_FORMAT",
          })
        );
        return;
      }
      if (zone.length > shape.exactLength) {
        findings.push(
          makeFinding("ZV-TOO-LONG", {
            rule,
            zoneIndexInRule: zoneIndex,
            zone,
            remedy: "FIX_FORMAT",
          })
        );
        return;
      }
      if (zone.length < shape.minPrefixLength) {
        findings.push(
          makeFinding("ZV-VERY-BROAD", {
            rule,
            zoneIndexInRule: zoneIndex,
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
    rule.zones.forEach((zone, zoneIndex) => {
      const isValid = validZonesByRuleIndex[ruleIndex].includes(zone);
      if (isValid) {
        if (seenValid.has(zone)) {
          findings.push(
            makeFinding("ZV-DUPLICATE-WITHIN", {
              rule,
              zoneIndexInRule: zoneIndex,
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
  //    D-B0-6 : remedy `null` -- retirer la zone spécifique changerait
  //    le `matched_prefix` RÉEL retourné par le résolveur pour les
  //    codes qu'elle seule matchait exactement (remedy non neutre).
  // ------------------------------------------------------------------

  rules.forEach((rule, ruleIndex) => {
    const zones = dedupedValidZonesByRuleIndex[ruleIndex];
    zones.forEach((zoneB) => {
      const covering = zones.find((zoneA) => zoneA !== zoneB && zoneB.startsWith(zoneA));
      if (covering) {
        findings.push(
          makeFinding("ZV-REDUNDANT-WITHIN", {
            rule,
            zoneIndexInRule: rule.zones.indexOf(zoneB),
            zone: zoneB,
            relatedRuleId: rule.ruleId,
            relatedRuleLabel: rule.label,
            relatedZone: covering,
            remedy: null,
          })
        );
      }
    });
  });

  // ------------------------------------------------------------------
  // 5) Couverture INTER-RÈGLES -- règles NON-DÉFAUT uniquement (contrat
  //    §4, "Default/fallback rules are excluded from inter-rule
  //    coverage analysis"), ordonnées par displayOrder ASC puis par
  //    ordre de saisie à displayOrder égal (contrat §8, déterminisme).
  //
  //    Étape 1 (§4 d'origine, INCHANGÉE) : domination PAR PAIRE --
  //    ZV-DUPLICATE-ACROSS / ZV-COVERED-BY-HIGHER.
  //    Étape 2 (D-B0-4, NOUVEAU) : si la zone courante n'est PAS déjà
  //    signalée par l'étape 1, saturation COLLECTIVE -- un ENSEMBLE de
  //    zones antérieures qui ÉTENDENT la zone courante (préfixe =
  //    zone courante) peut néanmoins couvrir tout l'espace restant
  //    sous elle. L'étape 1 a PRIORITÉ : si elle signale déjà la zone,
  //    l'étape 2 n'est jamais évaluée pour cette zone (un seul finding
  //    par zone dans cette section).
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

  const ALPHABET_SIZE = shape.allowedChars === "digits" ? 10 : 62;
  // Garde de sécurité numérique (D-B0-4) : si l'espace total de codes
  // possibles dépasse 2^53 (précision entière sûre de JavaScript),
  // TOUT calcul de saturation collective pour cette forme s'abstient
  // explicitement (ZV-REACHABILITY-NOT-COMPUTED) plutôt que de risquer
  // une réponse inexacte calculée en flottant.
  const reachabilityComputable = Math.pow(ALPHABET_SIZE, shape.exactLength) <= 2 ** 53;

  for (let rank = 0; rank < rankedIndices.length; rank += 1) {
    const current = rankedPositions[rankedIndices[rank]];

    // ---- Étape 1 : domination PAR PAIRE (inchangée). ----
    let flaggedByStep1 = false;
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
            rule: current.rule,
            zoneIndexInRule: current.zonePositionInRule,
            zone: current.zone,
            relatedRuleId: earlier.rule.ruleId,
            relatedRuleLabel: earlier.rule.label,
            relatedZone: earlier.zone,
            remedy: "REMOVE_ZONE",
          })
        );
        flaggedByStep1 = true;
        break;
      }
      if (current.zone.startsWith(earlier.zone)) {
        findings.push(
          makeFinding("ZV-COVERED-BY-HIGHER", {
            rule: current.rule,
            zoneIndexInRule: current.zonePositionInRule,
            zone: current.zone,
            relatedRuleId: earlier.rule.ruleId,
            relatedRuleLabel: earlier.rule.label,
            relatedZone: earlier.zone,
            remedy: "REORDER_BEFORE",
          })
        );
        flaggedByStep1 = true;
        break;
      }
    }
    if (flaggedByStep1) continue;

    // ---- Étape 2 (D-B0-4) : saturation COLLECTIVE par antichaîne. ----
    if (current.zone.length >= shape.exactLength) continue; // aucun espace restant à saturer.

    const extendingSuffixes = new Set<string>();
    for (let earlierRank = 0; earlierRank < rank; earlierRank += 1) {
      const earlier = rankedPositions[rankedIndices[earlierRank]];
      if (earlier.zone === current.zone) continue;
      if (earlier.zone.startsWith(current.zone)) {
        extendingSuffixes.add(earlier.zone.slice(current.zone.length));
      }
    }
    if (extendingSuffixes.size === 0) continue; // aucune zone antérieure ne l'étend -- rien à saturer.

    if (!reachabilityComputable) {
      findings.push(
        makeFinding("ZV-REACHABILITY-NOT-COMPUTED", {
          rule: current.rule,
          zoneIndexInRule: current.zonePositionInRule,
          zone: current.zone,
          remedy: null,
        })
      );
      continue;
    }

    const antichain = reduceToAntichain(extendingSuffixes);
    const k = shape.exactLength - current.zone.length;
    const target = Math.pow(ALPHABET_SIZE, k);
    let total = 0;
    antichain.forEach((suffix) => {
      total += Math.pow(ALPHABET_SIZE, k - suffix.length);
    });
    // Invariant interne D-B0-4 : une antichaîne de suffixes induit des
    // ensembles de codes DEUX-À-DEUX DISJOINTS (aucun suffixe n'est
    // préfixe d'un autre), donc `total` ne peut JAMAIS dépasser
    // `target`. Une violation signale un défaut d'implémentation dans
    // `reduceToAntichain` -- ne JAMAIS continuer silencieusement avec
    // un verdict potentiellement faux (contrat §8, déterminisme et
    // correction avant tout).
    if (total > target) {
      throw new Error(
        `B0 internal invariant violated (D-B0-4): collective coverage total (${total}) exceeds target (${target}) for zone "${current.zone}"`
      );
    }
    if (total === target) {
      // Reconstruit, pour le rapport, les zones ANTÉRIEURES dont les
      // suffixes forment l'antichaîne retenue -- ordonnées par
      // displayOrder ASC puis position de zone ASC, dédupliquées par
      // zone EXACTE (première occurrence, la plus prioritaire pour le
      // résolveur, conservée).
      const relatedByZone = new Map<string, ZonePosition>();
      for (let earlierRank = 0; earlierRank < rank; earlierRank += 1) {
        const earlier = rankedPositions[rankedIndices[earlierRank]];
        if (earlier.zone === current.zone) continue;
        if (!earlier.zone.startsWith(current.zone)) continue;
        const suffix = earlier.zone.slice(current.zone.length);
        if (!antichain.has(suffix)) continue;
        if (!relatedByZone.has(earlier.zone)) relatedByZone.set(earlier.zone, earlier);
      }
      const related = Array.from(relatedByZone.values()).sort((a, b) => {
        if (a.rule.displayOrder !== b.rule.displayOrder) return a.rule.displayOrder - b.rule.displayOrder;
        return a.zonePositionInRule - b.zonePositionInRule;
      });
      findings.push(
        makeFinding("ZV-UNREACHABLE-BY-HIGHER-SET", {
          rule: current.rule,
          zoneIndexInRule: current.zonePositionInRule,
          zone: current.zone,
          relatedRuleIds: related.map((entry) => entry.rule.ruleId),
          relatedRuleLabels: related.map((entry) => entry.rule.label),
          relatedZones: related.map((entry) => entry.zone),
          remedy: null,
        })
      );
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
          rule,
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
      rule.zones.forEach((zone, zoneIndex) => {
        if (seen.has(zone)) return; // déjà signalée une fois par ZV-DUPLICATE-WITHIN si bien formée -- pas la peine de la répéter ici pour DEFAULT_HAS_ZONES.
        seen.add(zone);
        findings.push(
          makeFinding("ZV-DEFAULT-HAS-ZONES", {
            rule,
            zoneIndexInRule: zoneIndex,
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
        rule: null,
        zone: null,
      })
    );
  }
  if (!hasDefault && !hasAnyZoneAnywhere) {
    findings.push(
      makeFinding("ZV-NO-DEFAULT-NO-ZONES", {
        rule: null,
        zone: null,
      })
    );
  }

  // ------------------------------------------------------------------
  // 8) Tri final (contrat §8, amendé D-B0-3) : `scopeRank` (finding
  //    tarif-scoped avant finding global) ASC, puis `displayOrder` ASC
  //    (0 pour un finding global), puis position BRUTE de la zone dans
  //    le tableau de sa règle (findings sans zone en premier), puis
  //    code ASCII/littéral -- comparaison par `<`/`>` sur des chaînes
  //    JS, jamais localeCompare/toLocale*, et JAMAIS `ruleId` (voir
  //    D-B0-3 en tête de fichier : chaque clé a été calculée à la
  //    CRÉATION du finding, directement depuis l'objet règle réel,
  //    jamais re-dérivée après coup via une structure indexée par
  //    `ruleId`). Tri STABLE (Array#sort de Node est stable) : à clés
  //    identiques, l'ordre de génération ci-dessus (lui-même
  //    entièrement déterministe) tranche.
  // ------------------------------------------------------------------

  const sortedFindings: ZoneFinding[] = findings
    .map((finding, originalIndex) => ({ finding, originalIndex }))
    .sort((a, b) => {
      const scopeDiff = a.finding.__sortKey.scopeRank - b.finding.__sortKey.scopeRank;
      if (scopeDiff !== 0) return scopeDiff;
      const orderDiff = a.finding.__sortKey.displayOrder - b.finding.__sortKey.displayOrder;
      if (orderDiff !== 0) return orderDiff;
      const positionDiff = a.finding.__sortKey.zoneIndex - b.finding.__sortKey.zoneIndex;
      if (positionDiff !== 0) return positionDiff;
      if (a.finding.code !== b.finding.code) return a.finding.code < b.finding.code ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ finding }) => {
      // Retire la clé de tri interne avant de retourner un ZoneFinding
      // public (jamais exposée dans le contrat §5).
      const { __sortKey, ...publicFinding } = finding;
      return publicFinding;
    });

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
