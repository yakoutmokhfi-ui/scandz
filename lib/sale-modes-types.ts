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
 *
 * Contrat "delivery_address" (LOT 2B.4a.1 — documentation seule,
 * réservée à l'implémentation de LOT 2B.4a.2, AUCUN code exécutable
 * ici) :
 *
 * Côté base (sale_mode_field_requirements / migration-v82-lot2a-
 * sale-modes.sql), le mode "delivery" exige un unique champ
 * `delivery_address` (requirement "required"), pas trois champs
 * séparés. Côté UI historique (FulfillmentSelector.tsx), l'adresse a
 * toujours été saisie via TROIS entrées distinctes : street,
 * postalCode, city (voir lib/customer.ts, CustomerInfo).
 *
 * Cette différence doit être préservée explicitement par LOT 2B.4a.2 :
 *   - CustomerData ne gagne PAS un CustomerData["street"] +
 *     CustomerData["postalCode"] + CustomerData["city"] séparés pour
 *     le mode delivery -- le contrat backend est UN SEUL champ
 *     `delivery_address: string` dans CustomerData ;
 *   - le futur formulaire qui rendra `delivery_address` doit afficher
 *     3 sous-champs UI mais ÉCRIRE une valeur unique combinée dans
 *     `customerData.delivery_address` avant validation/soumission ;
 *   - aucune fusion arbitraire (ex. simple concaténation par virgule)
 *     ni aucun parsing inverse (redécouper `delivery_address` en 3
 *     parties) n'est décidé ni implémenté ici -- ce choix de rendu
 *     appartient entièrement à LOT 2B.4a.2 ;
 *   - `getPublicFieldRequirements()`/`validateCustomerData()` ne
 *     traitent déjà `delivery_address` que comme un champ `string`
 *     required parmi d'autres -- aucune modification requise de ces
 *     fonctions pour ce contrat.
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
