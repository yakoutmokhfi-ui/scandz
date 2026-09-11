/**
 * STUART LOT B — MERCHANT DELIVERY PRICING POLICY v1.1.
 * PROVIDER COST → CUSTOMER DELIVERY FEE.
 *
 * Erreurs typées, dédiées, levées UNIQUEMENT par
 * `computeDeliveryPricingPolicy` (delivery-pricing-policy.ts) --
 * jamais une exception PostgreSQL/HTTP relayée telle quelle (ce
 * module est PUR : zéro HTTP, zéro appel Stuart, zéro mutation base,
 * zéro mutation paiement -- mandat "PURE POLICY ENGINE").
 *
 * Même discipline "fail-closed déterministe" déjà établie et
 * CTO-vérifiée par STUART LOT A v1.1 (voir quote-errors.ts,
 * `StuartValidateContractUnverifiedError`) : une classe DÉDIÉE par
 * catégorie de rejet, jamais un message générique, jamais une
 * agrégation en une seule exception fourre-tout -- chaque classe est
 * distinguable programmatiquement par l'appelant (`instanceof`),
 * impossible à confondre avec une autre catégorie de rejet.
 *
 * CORRECTIF v1.1 (CTO PRE-CONTROL, LOT-B-02) : `DeliveryPricingInvalidProviderCostError`
 * et `DeliveryPricingInvalidMerchantConfigError` couvrent désormais
 * AUSSI le rejet d'un montant à plus de 2 décimales (convention
 * `numeric(_,2)`, vérifiée par `hasAtMostTwoDecimalPlaces`,
 * delivery-pricing-policy.ts) -- AUCUNE nouvelle classe d'erreur
 * ajoutée (mandat v1.1 : correctif ciblé, périmètre non élargi), le
 * rejet "montant invalide" reste une seule catégorie par champ,
 * qu'il s'agisse de finitude, de signe, ou d'échelle décimale.
 */

export class DeliveryPricingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryPricingPolicyError";
  }
}

/**
 * `providerCost` absent, non fini (NaN/Infinity/-Infinity),
 * strictement négatif, ou comportant plus de 2 décimales (CORRECTIF
 * v1.1, LOT-B-02 -- convention `numeric(_,2)`). Mandat, invariant "no
 * negative provider cost" / "no NaN" -- rejeté AVANT tout calcul,
 * jamais normalisé silencieusement à 0 (contrairement à
 * `basketSubtotal`, dont la
 * normalisation défensive `<0 ou non fini -> 0` est un comportement
 * DÉJÀ existant et délibérément préservé, voir `computeDeliveryFee`,
 * lib/delivery.ts -- `providerCost` est un montant FACTURÉ réel par
 * le prestataire, jamais une valeur d'affichage tolérante aux entrées
 * incomplètes).
 */
export class DeliveryPricingInvalidProviderCostError extends DeliveryPricingPolicyError {
  constructor(message: string = "DELIVERY_PRICING_INVALID_PROVIDER_COST") {
    super(message);
    this.name = "DeliveryPricingInvalidProviderCostError";
  }
}

/**
 * `merchantDeliveryPricingConfig` absent, `pricingMode` hors du
 * vocabulaire existant (`'free' | 'fixed' | 'free_above_threshold'`,
 * voir `restaurant_sale_mode_fulfillments.pricing_mode` CHECK,
 * DRAFT-lot-server-delivery-fulfillment-pricing.sql), ou combinaison
 * `fixedFee`/`freeThreshold` incohérente avec ce mode (même invariant
 * que la contrainte
 * `restaurant_sale_mode_fulfillments_pricing_combo_valid` déjà en
 * base -- réutilisé ici en TypeScript, jamais une seconde règle
 * divergente), ou `fixedFee`/`freeThreshold` non fini, négatif, ou
 * comportant plus de 2 décimales (CORRECTIF v1.1, LOT-B-02 --
 * convention `numeric(_,2)`) (mandat, "no negative customer fee" /
 * "no NaN" -- même discipline que `scanym_numeric_is_non_finite` côté
 * SQL).
 */
export class DeliveryPricingInvalidMerchantConfigError extends DeliveryPricingPolicyError {
  constructor(message: string = "DELIVERY_PRICING_INVALID_MERCHANT_CONFIG") {
    super(message);
    this.name = "DeliveryPricingInvalidMerchantConfigError";
  }
}

/**
 * `currency` (devise du `providerCost` fourni par l'appelant) diffère
 * de la devise marchande autoritaire (`merchantCurrency`, reflet de
 * `restaurant_configs.currency` -- seule colonne de devise existante
 * dans ce dépôt, aucune colonne de devise n'existe sur
 * `restaurant_sale_mode_fulfillments`). Mandat, invariant "no
 * cross-currency calculation" -- rejeté AVANT tout calcul, jamais une
 * conversion inventée (aucun taux de change n'existe dans ce dépôt).
 * Comparaison par égalité stricte de chaîne, jamais une normalisation
 * de casse/alias inventée ici (même convention que la colonne
 * `restaurant_configs.currency`, simple `varchar`, jamais un type
 * énuméré contraint côté base).
 */
export class DeliveryPricingCurrencyMismatchError extends DeliveryPricingPolicyError {
  constructor(message: string = "DELIVERY_PRICING_CURRENCY_MISMATCH") {
    super(message);
    this.name = "DeliveryPricingCurrencyMismatchError";
  }
}
