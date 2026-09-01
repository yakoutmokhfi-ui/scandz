/**
 * Scanym — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1.
 * SIMPLIFIED FIXED-PRICE PORTION MODEL — WEIGHT = INFORMATIONAL ONLY.
 *
 * Couche PURE (mandat v1.1) : aucune dépendance Supabase, aucun accès
 * réseau, testable sans variables d'environnement — même discipline
 * que lib/tracking/*.ts.
 *
 * HISTORIQUE — v1 (jamais poussée/mergée) introduisait un second mode
 * de prix (`price_mode = 'price_per_weight'`) annoncé comme
 * l'autorité financière d'une ligne de commande, alors que
 * create_order (protégée par l'isolation paiement, jamais modifiée)
 * calcule TOUJOURS `menu_items.price × quantity`. Work a rejeté ce
 * candidat (CAT-FISCAL-01, FAIL). v1.1 SUPPRIME entièrement ce second
 * mode : voir DÉCISION PRODUIT ci-dessous.
 *
 * DÉCISION PRODUIT v1.1 (mandat §2) — SCANYM v1 NE SUPPORTE PAS la
 * tarification au poids variable :
 *   - `price` (menu_items, colonne EXISTANTE, INCHANGÉE) est
 *     l'UNIQUE autorité de prix, pour TOUT produit, sans exception.
 *   - la quantité commandée par le client est TOUJOURS un entier de
 *     produits/portions, jamais des grammes.
 *   - le poids (`unitWeightGrams`) est une métadonnée
 *     INFORMATIONNELLE/LOGISTIQUE, ne participe JAMAIS au calcul du
 *     prix — ni ici, ni dans create_order (inchangée), ni nulle part.
 *
 * Exemple canonique (mandat §2/§26, raclette) :
 *   price = 7.50, unitWeightGrams = 200, quantity = 2
 *   -> montant de commande = 2 × 7.50 = 15.00 € (create_order, INCHANGÉ)
 *   -> poids logistique estimé (informatif) = 2 × 200 = 400 g
 *   Aucun chemin de code ne calcule "400g × prix/kg" pour un montant.
 *
 * Ce module ne contient plus de matrice de validation croisée (les
 * deux champs restants, tax_rate et unit_weight_grams, sont
 * INDÉPENDANTS l'un de l'autre — mandat §22, "do not create an
 * unnecessarily complex state matrix").
 */

/**
 * Métadonnées fiscales/de mesure d'un produit, exactement les 3
 * champs éditables (reference_price_per_kg est TOUJOURS dérivé,
 * jamais éditable — voir referencePricePerKg ci-dessous).
 */
export interface FiscalMeasurementFields {
  taxRate: number | null;
  /** Poids nominal/estimé d'UNE portion, en grammes entiers.
   *  INFORMATIONNEL/LOGISTIQUE UNIQUEMENT — ne participe jamais au
   *  calcul d'un prix. `null` = non pertinent pour ce produit. */
  unitWeightGrams: number | null;
  /** Indicateur purement informatif (ex. "portion ~200 g"). N'affecte
   *  JAMAIS un calcul de prix. */
  weightIsApproximate: boolean;
}

export const DEFAULT_FISCAL_MEASUREMENT_FIELDS: FiscalMeasurementFields = {
  taxRate: null,
  unitWeightGrams: null,
  weightIsApproximate: false,
};

/**
 * Codes d'erreur de validation — MÊMES constantes que les messages
 * `raise exception` de create_product/update_product (voir le
 * fichier SQL). Seulement 2 codes en v1.1 (contre 7 en v1) : plus de
 * sales_unit/price_mode/weight_mode/combinaison, ces concepts ont été
 * supprimés (mandat §16).
 */
export type FiscalValidationErrorCode = "SCANYM_INVALID_TAX_RATE" | "SCANYM_INVALID_WEIGHT_VALUE";

/**
 * Valide un jeu de champs fiscaux/de mesure. Les deux champs sont
 * INDÉPENDANTS — contrairement à v1, il n'existe plus aucune
 * combinaison croisée à vérifier (mandat §22). Retourne le premier
 * code d'erreur rencontré, ou `null` si tout est valide.
 *
 * Validation client = confort (retour immédiat) ; l'autorité reste
 * TOUJOURS les contraintes CHECK en base (mandat §23).
 */
export function validateFiscalMeasurementFields(fields: FiscalMeasurementFields): FiscalValidationErrorCode | null {
  const { taxRate, unitWeightGrams } = fields;
  if (taxRate !== null && (taxRate < 0 || taxRate > 100)) return "SCANYM_INVALID_TAX_RATE";
  if (unitWeightGrams !== null && unitWeightGrams <= 0) return "SCANYM_INVALID_WEIGHT_VALUE";
  return null;
}

/**
 * Prix de référence au kilogramme — MÉTADONNÉE DE RÉFÉRENCE
 * UNIQUEMENT (mandat §6), jamais une autorité de panier/commande/
 * paiement. Reproduit CÔTÉ CLIENT (pour un affichage immédiat avant
 * tout aller-retour serveur) exactement la même formule que la
 * colonne générée `menu_items.reference_price_per_kg` :
 *   price / (unit_weight_grams / 1000), arrondi au centime.
 * Retourne `null` si le poids est absent ou non positif — jamais une
 * valeur inventée.
 *
 * Ce n'est PAS un second moteur de calcul de prix : aucune fonction
 * de ce module ne multiplie ce taux par une quantité ou un poids pour
 * produire un montant de commande. Il n'existe, dans ce dépôt,
 * QU'UNE seule opération financière pour une ligne de commande :
 * `price × quantity`, dans create_order (inchangée, hors périmètre de
 * ce module).
 */
export function referencePricePerKg(price: number, unitWeightGrams: number | null): number | null {
  if (unitWeightGrams === null || unitWeightGrams <= 0) return null;
  // Entier de centimes pour éviter toute imprécision flottante sur le
  // prix avant division — cohérent avec la discipline decimal-safe du
  // reste du dépôt, même si cette valeur n'est jamais elle-même une
  // autorité financière.
  const priceCents = Math.round(price * 100);
  const kg = unitWeightGrams / 1000;
  return Math.round((priceCents / kg)) / 100;
}

/**
 * Poids logistique estimé d'une ligne (mandat §14) —
 * `unit_weight_grams × quantity`. Fondation de DONNÉES uniquement
 * pour un futur usage logistique (transporteur, tranches de frais de
 * livraison) : AUCUN lot de tarification de livraison ne consomme
 * cette fonction dans ce dépôt à ce jour. JAMAIS utilisée pour
 * calculer un montant financier. Retourne `null` si le poids
 * unitaire est absent.
 */
export function estimatedLogisticalWeightGrams(unitWeightGrams: number | null, quantity: number): number | null {
  if (unitWeightGrams === null) return null;
  return unitWeightGrams * quantity;
}

/** Grammes -> représentation kg décimale pour AFFICHAGE uniquement.
 *  Une décimale si < 10 kg (ex. "1,8 kg"), entier au-delà. */
export function gramsToKgDisplayValue(grams: number): number {
  const kg = grams / 1000;
  return kg < 10 ? Math.round(kg * 10) / 10 : Math.round(kg);
}
