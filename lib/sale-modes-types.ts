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

/**
 * FULFILLMENT ROUTING LOT B — une règle de routage fulfillment
 * publique, telle que retournée par
 * get_restaurant_public_delivery_fulfillments. Jamais `provider` : la
 * RPC elle-même ne le retourne pas (reste une donnée strictement
 * interne, voir supabase/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql)
 * — ce type ne l'expose donc pas non plus, par construction, pas
 * seulement par convention.
 *
 * `minItems` reste `number | null` (contrairement à
 * PublicDeliveryInfo.minItems, toujours un `number` via un
 * `coalesce(...,0)` côté SQL pour l'ancien modèle) : la colonne
 * `restaurant_sale_mode_fulfillments.min_items` est nullable SANS
 * valeur de repli forcée côté base (voir LOT A) — "aucun minimum
 * déclaré pour CETTE règle" reste une valeur distincte de "minimum
 * explicite de 0", jamais confondue ici. `resolveDeliveryFulfillment`
 * (lib/delivery.ts) applique le repli `?? 0` au moment de la
 * résolution, pas ce type.
 *
 * `isFallback` : au plus une règle avec `isFallback: true` par
 * `(restaurant, mode)` reçue — garanti côté base par un index unique
 * partiel (LOT A), jamais revérifié côté client.
 */
export interface PublicDeliveryFulfillmentRule {
  fulfillmentCode: string;
  zonePrefixes: string[];
  isFallback: boolean;
  minItems: number | null;
  customerText: string | null;
  displayOrder: number;
}

/**
 * FULFILLMENT ROUTING LOT B — raison de refus lorsque
 * resolveDeliveryFulfillment() ne retient aucune règle éligible.
 * Vocabulaire IDENTIQUE à DeliveryBlock (lib/delivery.ts) — jamais un
 * second vocabulaire parallèle pour le même concept (hors zone, sous
 * le minimum, code postal absent/invalide).
 */
export type DeliveryFulfillmentBlock = "below-min" | "no-postal" | "out-of-zone";

/**
 * FULFILLMENT ROUTING LOT B — résultat de resolveDeliveryFulfillment().
 * `matchedRule` n'est présent que si une règle (fallback ou non) a
 * été retenue — y compris lorsque `eligible` est `false` par
 * `below-min` (la règle est identifiée, mais son minimum n'est pas
 * atteint), pour permettre à un futur appelant (LOT C, non branché
 * ici) d'afficher le texte/la règle concernée même en cas de refus.
 *
 * `matchedPrefix` — AJOUTÉ EN LOT B.1 (FRB-B-02) : le préfixe précis
 * (parmi `matchedRule.zonePrefixes`) qui a effectivement matché le
 * code postal, dans l'ordre du tableau — `undefined` quand aucune
 * règle non-fallback n'a été retenue (fallback appliqué, ou aucune
 * règle du tout). Fait partie du contrat public comparé
 * mécaniquement au résolveur SQL (resolve_delivery_fulfillment,
 * colonne `matched_prefix`) par
 * tests/fixtures/fulfillment-routing-cases.json — ajouté précisément
 * pour rendre cette comparaison possible cas par cas, pas seulement
 * un champ de confort.
 */
export interface DeliveryFulfillmentStatus {
  eligible: boolean;
  matchedRule?: PublicDeliveryFulfillmentRule;
  fulfillmentCode?: string;
  matchedPrefix?: string;
  customerText?: string | null;
  block?: DeliveryFulfillmentBlock;
  /** Nombre d'articles restant à ajouter pour que la règle résolue devienne éligible */
  missing?: number;
}
