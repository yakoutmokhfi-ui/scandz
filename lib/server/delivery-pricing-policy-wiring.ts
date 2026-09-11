/**
 * STUART LOT B — MERCHANT DELIVERY PRICING POLICY v1.1.
 * MINIMAL SERVER/DOMAIN WIRING (mandat, "SCOPE — IN": "minimal
 * server/domain wiring needed for later checkout integration").
 *
 * Adaptateur STRICTEMENT MINIMAL au-dessus du moteur pur
 * `computeDeliveryPricingPolicy` (lib/delivery-pricing-policy.ts) :
 * porte l'IDENTITÉ tenant/règle (`restaurantId`/`fulfillmentRuleId`)
 * à travers l'appel, SANS jamais la dériver ni la résoudre lui-même
 * (AUCUN accès base ici -- ce fichier ne lit ni
 * `restaurant_sale_mode_fulfillments`, ni `restaurant_configs`,
 * AUCUNE requête réseau, AUCUNE mutation). La résolution de
 * `merchantDeliveryPricingConfig`/`merchantCurrency` pour un
 * restaurant donné (ex. via `get_merchant_delivery_fulfillment_pricing`
 * / `restaurant_configs.currency`) reste ENTIÈREMENT hors périmètre
 * de ce lot (mandat, "SCOPE — OUT": "checkout UI integration") --
 * l'APPELANT (une future intégration checkout, non branchée ici) doit
 * fournir ces valeurs déjà résolues, exactement comme
 * `computeDeliveryPricingPolicy` lui-même.
 *
 * Objectif UNIQUE de ce fichier : prouver/garantir qu'un futur
 * appelant ne peut PAS accidentellement mélanger l'identité
 * tenant/règle d'un appel avec le résultat d'un autre (mandat, test
 * matrix #16, "tenant/provider identity not mixed if IDs are carried
 * through") -- `restaurantId`/`fulfillmentRuleId` sont de simples
 * valeurs OPAQUES échouées telles quelles dans le résultat, jamais
 * comparées, jamais utilisées pour une quelconque logique de
 * résolution ou de repli.
 */

import "server-only";
import {
  computeDeliveryPricingPolicy,
  type DeliveryPricingPolicyInput,
  type DeliveryPricingPolicyResult,
} from "@/lib/delivery-pricing-policy";

export interface DeliveryPricingPolicyIdentity {
  /** Opaque -- jamais interprété, jamais utilisé pour une résolution. */
  restaurantId: string;
  /** Opaque -- jamais interprété, jamais utilisé pour une résolution. */
  fulfillmentRuleId: string;
}

export interface DeliveryPricingPolicyResultWithIdentity
  extends DeliveryPricingPolicyResult,
    DeliveryPricingPolicyIdentity {}

/**
 * Calcule la politique tarifaire (via `computeDeliveryPricingPolicy`,
 * comportement/erreurs IDENTIQUES, jamais dupliqués) et échoue
 * l'identité tenant/règle fournie par l'appelant dans le résultat.
 * Zéro E/S, zéro résolution -- une pure fonction d'assemblage.
 */
export function computeDeliveryPricingPolicyWithIdentity(
  identity: DeliveryPricingPolicyIdentity,
  input: DeliveryPricingPolicyInput,
  merchantCurrency: string
): DeliveryPricingPolicyResultWithIdentity {
  const result = computeDeliveryPricingPolicy(input, merchantCurrency);
  return {
    ...result,
    restaurantId: identity.restaurantId,
    fulfillmentRuleId: identity.fulfillmentRuleId,
  };
}
