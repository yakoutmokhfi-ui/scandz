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
 * reproduisent EXACTEMENT le contrat public §5, sans aucune
 * extension ni simplification.
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

/** Une règle tarifaire de livraison, telle que fournie par l'appelant (pas encore persistée). */
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
 * Taxonomie figée (contrat §3). Bloquants : rejettent la
 * configuration (decision = REJECTED). Avertissements/info : jamais
 * bloquants (ZV-NO-DEFAULT est INFO, jamais WARNING -- ne fait donc
 * jamais basculer decision vers ACCEPTED_WITH_WARNINGS à lui seul,
 * voir §5 "frozen invariants" et le cas d'acceptation "no default =>
 * NO_DEFAULT INFO only").
 */
export type ZoneFindingCode =
  // Bloquants
  | "ZV-FORM-INVALID"
  | "ZV-TOO-LONG"
  | "ZV-COVERED-BY-HIGHER"
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
  | "ZV-NO-DEFAULT";

export type ZoneFinding = {
  code: ZoneFindingCode;
  severity: ZoneFindingSeverity;
  ruleId: string | null;
  ruleLabel: string;
  zone: string | null;
  relatedRuleId: string | null;
  relatedRuleLabel: string | null;
  relatedZone: string | null;
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
