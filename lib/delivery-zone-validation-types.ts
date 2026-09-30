/**
 * DELIVERY PRICING v2 — B0 — DELIVERY ZONE VALIDATION.
 *
 * Types publics du module de validation géométrique des zones de
 * livraison (voir lib/delivery-zone-validation.ts pour l'algorithme).
 *
 * Contrat figé (Ravel/CIO, issue #11, commentaire canonique
 * "DELIVERY PRICING v2 — B0 — CANONICAL CONTRACT NOW PROVIDED",
 * SHA-256 du contrat source : `6cb185117ea923457d268f4134d79d1768107c2bb1d588be39ea42212c355f0b`,
 * baseline `50f0775258607b99fc72323326e6d2c2b0f05ae2`) — ces types
 * reproduisent EXACTEMENT le contrat public §5.
 *
 * AMENDEMENT (arbitrage de conception Debussy après audit FAIL de
 * Chateaubriand sur le candidat `25ce692e962d03258d0b4462abeffd5f1cc575d5`,
 * issue #11, commentaires `5905379897`/`5905402555`, "PR #120 — B0
 * CONTRACT ARBITRATION FINAL — REMEDIATION GO") :
 *   - D-B0-3 : le tri des findings n'utilise plus JAMAIS `ruleId`
 *     (voir lib/delivery-zone-validation.ts -- bug racine trouvé par
 *     Chateaubriand : une règle NON SAUVEGARDÉE peut légitimement
 *     avoir `ruleId: null` tout en étant rattachée à un tarif précis).
 *   - D-B0-4 : accessibilité COMPLÈTE d'une zone -- domination par
 *     paire (§4 d'origine, inchangée) PUIS saturation COLLECTIVE par
 *     réduction en antichaîne des zones antérieures qui l'étendent.
 *     Nouveau code bloquant `ZV-UNREACHABLE-BY-HIGHER-SET` et nouveau
 *     champ relationnel structuré `relatedZoneRefs` (une cause
 *     collective n'a pas une seule règle/zone liée, mais un ensemble ;
 *     voir aussi la clarification Debussy "Option C", commentaire
 *     `5908021131`, qui remplace les trois tableaux parallèles d'une
 *     version antérieure de cet amendement par ce champ unique).
 *   - re-audit ultérieur (comment `5906573419`) : H(R) exclut aussi les
 *     tarifs à `displayOrder` ÉGAL (pas seulement la même règle) --
 *     voir lib/delivery-zone-validation.ts, étapes 1 et 2.
 *   - Nouveau code `ZV-REACHABILITY-NOT-COMPUTED` (INFO) : abstention
 *     explicite quand le calcul combinatoire dépasserait la précision
 *     entière sûre de JavaScript (2^53).
 *   - D-B0-6 : table des `remedy` amendée -- seul changement réel par
 *     rapport à la première livraison : `ZV-REDUNDANT-WITHIN` ne
 *     recommande plus `REMOVE_ZONE` (retirer la zone la plus
 *     spécifique changerait le `matched_prefix` réel du résolveur --
 *     un remedy non neutre, signalé par Chateaubriand).
 */

/**
 * Forme d'un code postal pour un pays donné.
 *
 * Décision figée D-B0-1 : B0 ne connaît AUCUN pays, ne fait AUCUN
 * mapping pays -> descripteur (réservé à un futur lot B2) et ne parse
 * aucune regex depuis des données. Cet objet est fourni par
 * l'appelant, déjà résolu.
 */
export type PostalCodeShape = {
  allowedChars: "digits" | "alnum";
  exactLength: number;
  minPrefixLength: number;
};

/**
 * Une règle tarifaire de livraison, telle que fournie par l'appelant
 * (pas encore persistée -- `ruleId` peut donc légitimement valoir
 * `null` pour une règle en cours de saisie, non encore sauvegardée en
 * base ; elle reste néanmoins un TARIF réel avec son propre
 * `displayOrder`, voir D-B0-3 dans lib/delivery-zone-validation.ts).
 *
 * Précondition de PARTICIPATION (clarification Debussy, non un champ
 * -- volontairement PAS ajoutée ici) : l'appelant ne doit transmettre
 * que les tarifs qui participent RÉELLEMENT à la résolution (règle
 * `enabled`, mode de vente parent `enabled`) -- exactement comme le
 * fait `candidate_rules` dans `resolve_delivery_fulfillment`
 * (`f.enabled = true and (select enabled from parent_mode_enabled)`).
 * B0 lui-même ne reçoit et ne connaît AUCUN champ `enabled` -- ce
 * filtrage reste une précondition d'ENTRÉE, à la charge de l'appelant.
 */
export type ZoneRuleInput = {
  ruleId: string | null;
  label: string;
  displayOrder: number;
  isDefault: boolean;
  zones: string[];
};

export type ZoneValidationInput = {
  shape: PostalCodeShape;
  rules: ZoneRuleInput[];
};

export type ZoneFindingSeverity = "BLOCKING_ERROR" | "WARNING" | "INFO";

export type ZoneFindingRemedy =
  | "REORDER_BEFORE"
  | "REMOVE_ZONE"
  | "ADD_ZONE"
  | "FIX_FORMAT"
  | null;

/**
 * Taxonomie figée (contrat §3, étendue par l'amendement D-B0-4).
 * Bloquants : rejettent la configuration (decision = REJECTED).
 * Avertissements/info : jamais bloquants (ZV-NO-DEFAULT et
 * ZV-REACHABILITY-NOT-COMPUTED sont INFO, jamais WARNING -- ne font
 * donc jamais basculer decision vers ACCEPTED_WITH_WARNINGS à eux
 * seuls, voir §5 "frozen invariants" et le cas d'acceptation "no
 * default => NO_DEFAULT INFO only").
 */
export type ZoneFindingCode =
  // Bloquants
  | "ZV-FORM-INVALID"
  | "ZV-TOO-LONG"
  | "ZV-COVERED-BY-HIGHER"
  | "ZV-UNREACHABLE-BY-HIGHER-SET" // D-B0-4 : saturation COLLECTIVE (aucune zone individuelle ne domine, mais leur UNION couvre tout l'espace restant).
  | "ZV-DUPLICATE-ACROSS"
  | "ZV-EMPTY-ZONES"
  | "ZV-NO-DEFAULT-NO-ZONES"
  | "ZV-INPUT-DUPLICATE-ORDER"
  | "ZV-INPUT-MULTIPLE-DEFAULTS"
  // Avertissements / info
  | "ZV-DUPLICATE-WITHIN"
  | "ZV-REDUNDANT-WITHIN"
  | "ZV-VERY-BROAD"
  | "ZV-DEFAULT-HAS-ZONES"
  | "ZV-NO-DEFAULT"
  | "ZV-REACHABILITY-NOT-COMPUTED"; // D-B0-4 : abstention explicite -- le calcul dépasserait 2^53, jamais une réponse inexacte.

/**
 * D-B0-4, clarification de conception Debussy "Option C" (issue #11,
 * commentaire `5908021131`, remplaçant les trois tableaux parallèles
 * `relatedRuleIds`/`relatedRuleLabels`/`relatedZones` de l'amendement
 * précédent -- ceux-ci obligeaient l'appelant à recombiner trois
 * tableaux par INDEX pour reconstituer une seule zone liée, fragile et
 * sans garantie structurelle qu'ils restent alignés). Un enregistrement
 * par membre de S* (l'antichaîne minimale de zones antérieures dont
 * l'union sature l'espace restant sous la zone courante) : une zone
 * COMPLÈTE (jamais un suffixe) et le tarif qui la porte.
 *
 * `ruleId` peut légitimement valoir `null` -- exactement la même raison
 * que `ZoneRuleInput.ruleId` : le tarif responsable peut être une règle
 * non encore sauvegardée. `displayOrder`, `ruleLabel` et `zone` ne sont
 * eux JAMAIS `null`.
 */
export type ZoneRelatedRef = {
  displayOrder: number;
  ruleId: string | null;
  ruleLabel: string;
  zone: string;
};

export type ZoneFinding = {
  code: ZoneFindingCode;
  severity: ZoneFindingSeverity;
  ruleId: string | null;
  ruleLabel: string;
  zone: string | null;
  /**
   * `null` pour tout finding portant sur une cause COLLECTIVE
   * (`ZV-UNREACHABLE-BY-HIGHER-SET`, quand `relatedZoneRefs` est
   * présent) -- voir `relatedZoneRefs` ci-dessous.
   */
  relatedRuleId: string | null;
  relatedRuleLabel: string | null;
  relatedZone: string | null;
  /**
   * D-B0-4, clarification Debussy "Option C" (comment `5908021131`) :
   * champ structuré PLURIEL, utilisé SI ET SEULEMENT SI
   * `code === "ZV-UNREACHABLE-BY-HIGHER-SET"` -- une cause COLLECTIVE
   * n'a pas une seule règle/zone liée, mais l'antichaîne minimale de
   * zones antérieures dont l'UNION sature l'espace restant. Exactement
   * un enregistrement par membre de S*, sans omission, regroupement ni
   * duplication ; ordre normatif : `displayOrder` ASC puis position
   * D'ORIGINE de la zone ASC (si la même zone complète apparaît dans
   * plusieurs tarifs antérieurs, seule la première occurrence selon cet
   * ordre est conservée). Quand ce champ est présent, les champs
   * singuliers `relatedRuleId`/`relatedRuleLabel`/`relatedZone`
   * ci-dessus valent `null`. Absent pour tout autre code (jamais un
   * tableau vide).
   */
  relatedZoneRefs?: ZoneRelatedRef[];
  remedy: ZoneFindingRemedy;
};

export type ZoneValidationDecision = "ACCEPTED" | "ACCEPTED_WITH_WARNINGS" | "REJECTED";

export type ZoneValidationResult = {
  decision: ZoneValidationDecision;
  findings: ZoneFinding[];
  /**
   * Mêmes règles, dans le MÊME ORDRE que `rules` en entrée (jamais
   * réordonnées par tarif -- contrat §5, "normalizedRules must not
   * reorder tariffs") ; seules les zones EXACTEMENT dupliquées au sein
   * d'une même règle sont dédupliquées (première occurrence
   * conservée, ordre des zones restantes préservé -- "normalizedRules
   * may deduplicate zones but must preserve remaining zone order").
   * Aucune zone mal formée n'est retirée ici : B0 ne nettoie jamais
   * silencieusement l'entrée (décision D-B0-2) -- seule la
   * déduplication EXACTE est une "déduplication", pas un nettoyage.
   */
  normalizedRules: ZoneRuleInput[];
};
