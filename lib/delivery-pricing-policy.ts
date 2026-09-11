/**
 * STUART LOT B — MERCHANT DELIVERY PRICING POLICY v1.1.
 * PROVIDER COST → CUSTOMER DELIVERY FEE.
 *
 * CORRECTIF v1.1 (CTO PRE-CONTROL) :
 *
 *   LOT-B-01 (duplicated customer delivery fee business logic) : v1
 *   prétendait "réutiliser exactement" `computeDeliveryFee`
 *   (lib/delivery.ts) mais en réimplémentait en réalité une SECONDE
 *   copie via `resolveCustomerDeliveryFee`/`normalizeSubtotal` --
 *   deux implémentations indépendamment maintenables de la même
 *   règle métier. CORRIGÉ : `computeDeliveryFee` (lib/delivery.ts,
 *   INCHANGÉ, importé tel quel) est désormais l'UNIQUE calculateur de
 *   `customerDeliveryFee`, appelé UNE SEULE FOIS. `resolveCustomerDeliveryFee`
 *   et `normalizeSubtotal` sont SUPPRIMÉS (jamais laissés inutilisés
 *   -- même discipline de suppression complète déjà établie par
 *   STUART LOT A v1.1 pour `VALIDATE_PATH`, afin qu'une
 *   réintroduction future soit visible en revue). `pricingReason` est
 *   SUPPRIMÉ (option B du mandat v1.1 : "omit pricingReason from v1.1
 *   if it is not necessary") -- le dériver du `config` +
 *   `fee` résultant sans re-comparer `subtotal`/`freeThreshold`
 *   (option A) se serait avéré AMBIGU dans un cas limite réel (mode
 *   `free_above_threshold` avec `fixedFee` marchand configuré à 0 :
 *   `fee === 0` ne permettrait alors plus de distinguer "seuil
 *   atteint" de "seuil non atteint mais frais fixe nul", sans
 *   ré-exécuter la même comparaison que `computeDeliveryFee` --
 *   exactement la duplication que ce correctif élimine). Autorité
 *   monétaire strictement single-source désormais.
 *
 *   LOT-B-02 (two-decimal money contract not enforced) : la
 *   validation runtime v1 ne prouvait que "fini" et ">= 0", jamais
 *   "au plus 2 décimales" (convention `numeric(_,2)` déjà en vigueur
 *   dans tout ce domaine, voir section "ARRONDI" plus bas) -- des
 *   valeurs comme `8.405` pouvaient donc entrer dans le moteur.
 *   Inspection du dépôt (mandat v1.1) pour un primitif de validation
 *   monétaire réutilisable : `AMOUNT_PATTERN`/`normalizeAmountExact`
 *   (lib/server/payment-provider-event-fingerprint.ts) existent mais
 *   (a) ne sont PAS exportés (privés à ce module Payment), (b)
 *   opèrent sur une représentation `string` déjà sérialisée (le
 *   format d'échange HTTP du prestataire de paiement carte existant,
 *   hors périmètre de ce lot), jamais sur le type `number` déjà établi
 *   dans TOUT ce domaine (`computeDeliveryFee`, `PublicDeliveryFulfillmentRule.
 *   fixedFee: number | null`, `lib/services/dashboard.ts`), et (c) les
 *   réutiliser exigerait soit de les exporter depuis ce module Payment
 *   (hors périmètre, "Do NOT modify ... Payment" et son prestataire),
 *   soit de
 *   changer le type d'entrée de ce lot de `number` à `string` (aurait
 *   cassé la compatibilité structurelle avec `computeDeliveryFee`
 *   exigée par LOT-B-01 -- portée bien plus large que le correctif
 *   demandé). AUCUN primitif générique `number` (indépendant de
 *   Payment) n'existe ailleurs dans ce dépôt. Plus petite extension
 *   locale implémentée : `hasAtMostTwoDecimalPlaces` (voir plus bas),
 *   basée sur la représentation textuelle EXACTE et sans perte que
 *   `Number.prototype.toString()` produit pour un littéral décimal
 *   JavaScript standard (`(8.405).toString() === "8.405"`,
 *   `(8.40).toString() === "8.4"` -- vérifié empiriquement, AUCUNE
 *   dérive flottante possible pour cette classe de valeurs, même
 *   principe "aucune conversion qui pourrait dériver" que
 *   `normalizeAmountExact` sans dupliquer son code Payment-spécifique
 *   ni changer la représentation `number` déjà établie). Rejet
 *   fail-closed, JAMAIS un arrondi silencieux d'une entrée malformée.
 *
 * ------------------------------------------------------------------
 *
 * Transforme un coût prestataire EXPLICITE (`providerCost`, fourni
 * par l'appelant -- mandat "IMPORTANT CONTRACT BOUNDARY" : ce lot
 * N'EXTRAIT PAS et NE PARSE PAS la réponse Stuart Pricing) en frais
 * de livraison client (`customerDeliveryFee`), selon la politique
 * tarifaire DÉJÀ PUBLIÉE du marchand
 * (`restaurant_sale_mode_fulfillments.pricing_mode`/`fixed_fee`/
 * `free_threshold`, DASHBOARD DELIVERY PRICING v1 -- INCHANGÉE ici),
 * et calcule le montant que le marchand absorbe
 * (`merchantSubsidy`).
 *
 * Principe métier (mandat, "BUSINESS PRINCIPLE") : coût prestataire
 * et frais client sont DEUX montants DISTINCTS -- jamais supposés
 * égaux silencieusement, sauf lorsque la politique marchande le
 * produit elle-même.
 *
 * PUR par construction (mandat, "PURE POLICY ENGINE") : aucun accès
 * réseau, aucun appel Stuart, aucune lecture/écriture base de
 * données, aucune mutation paiement. `customerDeliveryFee` est
 * calculé par un appel UNIQUE à `computeDeliveryFee` (lib/delivery.ts,
 * INCHANGÉ) -- jamais une seconde implémentation (voir CORRECTIF
 * v1.1, LOT-B-01, ci-dessus).
 *
 * DEVISE (mandat, "MONEY SAFETY", invariant "no cross-currency
 * calculation") : `merchantDeliveryPricingConfig`
 * (`restaurant_sale_mode_fulfillments`) ne porte AUCUNE colonne de
 * devise propre -- la SEULE colonne de devise existante dans ce
 * dépôt est `restaurant_configs.currency`. `computeDeliveryPricingPolicy`
 * accepte donc un second paramètre explicite `merchantCurrency`
 * (reflet direct de `restaurant_configs.currency`, résolu par
 * l'APPELANT -- cette fonction ne le lit jamais elle-même, aucun
 * accès base ici) et REJETTE (`DeliveryPricingCurrencyMismatchError`)
 * si `input.currency` diffère de `merchantCurrency`, plutôt que
 * d'effectuer un calcul cross-devise inventé. INCHANGÉ par v1.1
 * (mandat v1.1, "CURRENCY" : "Do not redesign currency handling").
 *
 * ARRONDI (mandat, "MONEY SAFETY", invariant "deterministic
 * rounding") : toutes les colonnes monétaires existantes de ce
 * domaine sont `numeric(10,2)`/`numeric(12,2)` (2 décimales) --
 * convention réutilisée ici via `roundMoney2` (arrondi à 2 décimales,
 * déterministe) pour `merchantSubsidy` UNIQUEMENT (résultat d'une
 * SOUSTRACTION flottante -- `providerCost`/`customerDeliveryFee` sont
 * des ENTRÉES/résultats déjà conformes à cette convention, jamais
 * réarrondis). Depuis v1.1, la conformité "au plus 2 décimales" de
 * `providerCost`/`fixedFee`/`freeThreshold` n'est plus une simple
 * supposition documentaire : elle est VÉRIFIÉE et REJETÉE
 * fail-closed si violée (voir CORRECTIF v1.1, LOT-B-02, ci-dessus).
 */

import {
  DeliveryPricingCurrencyMismatchError,
  DeliveryPricingInvalidMerchantConfigError,
  DeliveryPricingInvalidProviderCostError,
} from "@/lib/delivery-pricing-policy-errors";
import { computeDeliveryFee } from "@/lib/delivery";

export type MerchantDeliveryPricingMode = "free" | "fixed" | "free_above_threshold";

/**
 * Sous-ensemble EXACT des colonnes marchandes éditables de
 * `restaurant_sale_mode_fulfillments` (DASHBOARD DELIVERY PRICING
 * v1, INCHANGÉ ici) -- même vocabulaire que
 * `Pick<PublicDeliveryFulfillmentRule, "pricingMode" | "fixedFee" |
 * "freeThreshold">` (lib/sale-modes-types.ts), structurellement
 * compatible SANS conversion avec le premier paramètre de
 * `computeDeliveryFee` (lib/delivery.ts) -- appelé directement avec
 * cette valeur, jamais un objet adapté/dupliqué. `pricingMode:
 * "free"` reste un mode STRUCTUREL valide (contrainte CHECK côté
 * base) même s'il n'est pas proposé par
 * `update_merchant_delivery_fulfillment_pricing` (RPC marchande, qui
 * restreint volontairement l'écriture à `'fixed'`/
 * `'free_above_threshold'` -- une règle `'free'` reste configurable
 * par Scanym, jamais par le marchand lui-même) -- accepté ici pour
 * rester fidèle au domaine COMPLET existant.
 */
export interface MerchantDeliveryPricingConfig {
  pricingMode: MerchantDeliveryPricingMode;
  fixedFee: number | null;
  freeThreshold: number | null;
}

export interface DeliveryPricingPolicyInput {
  /** Coût prestataire EXPLICITE (ex. Stuart Pricing), fourni par
   *  l'appelant -- JAMAIS extrait par cette fonction. Doit respecter
   *  la convention `numeric(_,2)` (au plus 2 décimales, voir
   *  CORRECTIF v1.1 LOT-B-02) -- sinon rejeté fail-closed. */
  providerCost: number;
  /** Devise dans laquelle `providerCost` est exprimé. */
  currency: string;
  /** Sous-total panier (HORS frais de livraison lui-même -- même
   *  convention déjà en vigueur côté `create_order`). Passé TEL QUEL
   *  à `computeDeliveryFee`, qui applique déjà sa propre
   *  normalisation défensive (NULL/non fini/négatif -> 0) --
   *  JAMAIS renormalisé une seconde fois ici (voir CORRECTIF v1.1,
   *  LOT-B-01 : `normalizeSubtotal` local supprimé). */
  basketSubtotal: number;
  /** Politique tarifaire marchande DÉJÀ PUBLIÉE (DASHBOARD DELIVERY
   *  PRICING v1) -- jamais réinventée ici. `fixedFee`/`freeThreshold`
   *  (quand non-null) doivent respecter la convention `numeric(_,2)`
   *  (voir CORRECTIF v1.1 LOT-B-02) -- sinon rejetés fail-closed. */
  merchantDeliveryPricingConfig: MerchantDeliveryPricingConfig;
}

export interface DeliveryPricingPolicyResult {
  providerCost: number;
  /** Calculé par un appel UNIQUE à `computeDeliveryFee`
   *  (lib/delivery.ts, INCHANGÉ) -- AUCUNE seconde implémentation
   *  (CORRECTIF v1.1, LOT-B-01). */
  customerDeliveryFee: number;
  /** Montant absorbé par le marchand -- TOUJOURS >= 0 (mandat : "Do
   *  not allow negative subsidy through accidental arithmetic" --
   *  lorsque `customerDeliveryFee >= providerCost`, ce champ vaut
   *  STRICTEMENT 0, jamais une valeur négative -- le surplus éventuel
   *  n'est ni calculé ni exposé ici). */
  merchantSubsidy: number;
  currency: string;
}

/**
 * Arrondi déterministe à 2 décimales (convention `numeric(_,2)` déjà
 * en vigueur dans tout ce domaine), appliqué UNIQUEMENT à
 * `merchantSubsidy` (résultat d'une soustraction flottante -- voir
 * commentaire de fichier, section "ARRONDI"). Toutes les valeurs
 * traitées ici sont déjà validées `>= 0` avant tout appel à cette
 * fonction -- `Math.round` suffit donc, aucune divergence possible
 * avec un arrondi "loin de zéro" qui ne s'appliquerait qu'à des
 * valeurs négatives, absentes ici par construction.
 */
function roundMoney2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * CORRECTIF v1.1 (LOT-B-02) : prouve qu'un `number` respecte la
 * convention `numeric(_,2)` (au plus 2 décimales après le point) --
 * SANS aucune arithmétique flottante qui pourrait dériver (mandat :
 * "Do not silently round malformed input to two decimals. Reject it
 * fail-closed."). Utilise la représentation textuelle EXACTE produite
 * par `Number.prototype.toString()` -- pour un littéral décimal
 * JavaScript standard (la seule façon dont un montant `numeric(_,2)`
 * atteint ce code : saisie utilisateur via `Number(...)`, JSON, ou
 * littéral de test), cette représentation est TOUJOURS la forme
 * décimale la plus courte qui redonne exactement la même valeur
 * flottante -- vérifié empiriquement : `(8.405).toString() ===
 * "8.405"`, `(8.40).toString() === "8.4"`, `(8).toString() === "8"`.
 * Rejette toute notation exponentielle (`"1e21"`, jamais produite
 * pour les montants de cette échelle mais exclue par prudence,
 * jamais silencieusement acceptée).
 *
 * N'est PAS une duplication de `normalizeAmountExact`
 * (lib/server/payment-provider-event-fingerprint.ts, module Payment
 * PRIVÉ et `string`-first, hors périmètre de ce lot) : ce primitif
 * est local, minimal, opère sur le type `number` déjà établi dans ce
 * domaine, et ne fait AUCUNE normalisation (aucune réécriture de
 * valeur) -- uniquement un rejet booléen.
 */
function hasAtMostTwoDecimalPlaces(value: number): boolean {
  const text = value.toString();
  if (/[eE]/.test(text)) {
    return false;
  }
  const dotIndex = text.indexOf(".");
  if (dotIndex === -1) {
    return true;
  }
  return text.length - dotIndex - 1 <= 2;
}

function isValidMoneyAmount(value: number): boolean {
  return isFiniteNonNegative(value) && hasAtMostTwoDecimalPlaces(value);
}

/**
 * Valide `merchantDeliveryPricingConfig` selon EXACTEMENT la même
 * combinaison que la contrainte CHECK déjà en base
 * (`restaurant_sale_mode_fulfillments_pricing_combo_valid`) :
 *   - 'free'                -> fixedFee et freeThreshold DOIVENT être null ;
 *   - 'fixed'                -> fixedFee requis (numeric(_,2) valide), freeThreshold DOIT être null ;
 *   - 'free_above_threshold' -> fixedFee ET freeThreshold requis (numeric(_,2) valides).
 * Toute violation lève `DeliveryPricingInvalidMerchantConfigError`
 * (fail-closed). Validation UNIQUEMENT -- ne calcule AUCUN montant
 * (n'entre pas en conflit avec CORRECTIF v1.1 LOT-B-01, qui concerne
 * le CALCUL du frais, jamais sa validation d'entrée).
 */
function assertValidMerchantConfig(
  config: MerchantDeliveryPricingConfig | null | undefined
): asserts config is MerchantDeliveryPricingConfig {
  if (!config) {
    throw new DeliveryPricingInvalidMerchantConfigError();
  }

  const { pricingMode, fixedFee, freeThreshold } = config;

  if (
    pricingMode !== "free" &&
    pricingMode !== "fixed" &&
    pricingMode !== "free_above_threshold"
  ) {
    throw new DeliveryPricingInvalidMerchantConfigError();
  }

  if (fixedFee !== null && !isValidMoneyAmount(fixedFee)) {
    throw new DeliveryPricingInvalidMerchantConfigError();
  }
  if (freeThreshold !== null && !isValidMoneyAmount(freeThreshold)) {
    throw new DeliveryPricingInvalidMerchantConfigError();
  }

  if (pricingMode === "free") {
    if (fixedFee !== null || freeThreshold !== null) {
      throw new DeliveryPricingInvalidMerchantConfigError();
    }
  } else if (pricingMode === "fixed") {
    if (fixedFee === null || freeThreshold !== null) {
      throw new DeliveryPricingInvalidMerchantConfigError();
    }
  } else {
    // 'free_above_threshold'
    if (fixedFee === null || freeThreshold === null) {
      throw new DeliveryPricingInvalidMerchantConfigError();
    }
  }
}

/**
 * STUART LOT B — moteur de politique tarifaire marchande, PUR.
 *
 * @param input `providerCost`/`currency`/`basketSubtotal`/
 *   `merchantDeliveryPricingConfig` -- mandat "PURE POLICY ENGINE".
 * @param merchantCurrency Devise marchande autoritaire (reflet de
 *   `restaurant_configs.currency`, résolue par l'APPELANT).
 * @throws {DeliveryPricingInvalidProviderCostError} `providerCost`
 *   absent, non fini, négatif, ou avec plus de 2 décimales.
 * @throws {DeliveryPricingInvalidMerchantConfigError}
 *   `merchantDeliveryPricingConfig` absent, incohérent, ou avec
 *   `fixedFee`/`freeThreshold` ayant plus de 2 décimales.
 * @throws {DeliveryPricingCurrencyMismatchError} `input.currency`
 *   diffère de `merchantCurrency`.
 */
export function computeDeliveryPricingPolicy(
  input: DeliveryPricingPolicyInput,
  merchantCurrency: string
): DeliveryPricingPolicyResult {
  if (!isValidMoneyAmount(input.providerCost)) {
    throw new DeliveryPricingInvalidProviderCostError();
  }

  if (
    typeof input.currency !== "string" ||
    input.currency.length === 0 ||
    typeof merchantCurrency !== "string" ||
    merchantCurrency.length === 0 ||
    input.currency !== merchantCurrency
  ) {
    throw new DeliveryPricingCurrencyMismatchError();
  }

  assertValidMerchantConfig(input.merchantDeliveryPricingConfig);

  // CORRECTIF v1.1 (LOT-B-01) : UNIQUE calculateur de frais client --
  // computeDeliveryFee (lib/delivery.ts), INCHANGÉ, appelé UNE SEULE
  // FOIS. Aucune renormalisation locale de basketSubtotal (la
  // fonction applique déjà sa propre normalisation défensive).
  const customerDeliveryFee = computeDeliveryFee(
    input.merchantDeliveryPricingConfig,
    input.basketSubtotal
  );

  const providerCost = input.providerCost;
  const merchantSubsidy =
    customerDeliveryFee < providerCost
      ? roundMoney2(providerCost - customerDeliveryFee)
      : 0;

  return {
    providerCost,
    customerDeliveryFee,
    merchantSubsidy,
    currency: input.currency,
  };
}
