/**
 * LOT 2B.1 — Types frontend pour les modes de vente génériques.
 *
 * Aucun type restaurant-spécifique. Aucun nom de groupe one_of codé
 * en dur (les groupes sont des chaînes ouvertes, déclarées côté base,
 * jamais une énumération figée ici).
 */

/**
 * Mode de vente public tel que retourné par
 * get_restaurant_public_sale_modes, enrichi du libellé/catégorie lus
 * séparément depuis sale_mode_catalog (la RPC elle-même ne retourne
 * ni l'un ni l'autre — vérifié directement dans le schéma LOT 2A.4).
 */
export interface SaleMode {
  code: string;
  label: string;
  category: string;
  customerText: string | null;
  pricingMode: "free" | "fixed" | "free_above_threshold" | "external_quote";
  fixedFee: number | null;
  freeThreshold: number | null;
  delayValue: number | null;
  delayUnit: "minutes" | "hours" | null;
}

export type RequirementType = "required" | "optional" | "one_of";

/**
 * Une exigence de champ pour un mode donné, telle que retournée par
 * get_restaurant_public_field_requirements. `oneOfGroup` est une
 * chaîne ouverte lue depuis la base — jamais une valeur supposée ou
 * comparée à un nom fixe (ex. "contact") dans le code applicatif.
 */
export interface SaleModeFieldRequirement {
  field: string;
  requirement: RequirementType;
  oneOfGroup: string | null;
}

/**
 * Données client saisies, indexées par nom de champ. Remplace un type
 * figé à liste de propriétés nommées : un nouveau champ retourné par
 * le backend (ex. futur "delivery_instructions") doit fonctionner
 * sans modification de ce type.
 */
export type CustomerData = Record<string, string>;

/**
 * Projection publique minimale des informations de livraison, telle
 * que retournée par get_restaurant_public_delivery_info.
 * delivery_zone_prefixes n'est jamais null côté base (toujours un
 * tableau, potentiellement vide) — reflété ici par un tableau
 * garanti non-null.
 */
export interface PublicDeliveryInfo {
  zonePrefixes: string[];
  minItems: number;
  areaLabel: string | null;
}
