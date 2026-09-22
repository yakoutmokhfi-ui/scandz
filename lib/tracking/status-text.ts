/**
 * Scanym — CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — TEXTE EXPLICATIF
 * customer-facing d'un statut de commande.
 *
 * Logique PURE (aucun réseau, aucun React, aucune dépendance Supabase)
 * -- même discipline que lib/tracking/status.ts, dont ce module est le
 * prolongement strict : `status.ts` nomme les CLÉS de libellé COURT
 * (le badge « Prête pour le retrait »), ce module-ci résout le TEXTE
 * EXPLICATIF LONG (« Votre commande est prête. Présentez-vous au
 * comptoir… ») qui accompagne ce badge.
 *
 * DISTINCTION STRUCTURELLE ESSENTIELLE (mandat §2, littéral :
 * « The merchant override must never change the canonical status/state
 * machine, only the displayed explanatory text ») :
 *
 *   - Les 7 statuts canoniques (`CANONICAL_ORDER_STATUSES`) restent
 *     l'UNIQUE autorité d'état, définie dans lib/tracking/status.ts et
 *     gardée côté SQL. Ce module ne les redéclare JAMAIS : il les
 *     importe. Aucune fonction d'ici ne peut produire, renommer ou
 *     masquer un statut -- toutes prennent un `OrderStatus` déjà
 *     canonique en ENTRÉE et ne renvoient que du TEXTE en SORTIE.
 *   - Aucun statut de livreur/prestataire n'est inventé (mandat §2 :
 *     « Do not invent delivery-driver statuses ») -- la surcharge
 *     marchande est un dictionnaire INDEXÉ par les 7 statuts existants,
 *     jamais un moyen d'en déclarer un 8e : toute clé non canonique
 *     reçue d'une configuration est IGNORÉE (voir
 *     `sanitizeMerchantStatusTextOverrides`).
 *
 * REPLI (mandat §2, littéral : « The base text must work with no
 * merchant configuration » / « An empty override means use the base
 * text ») : le texte de base vit dans lib/i18n.ts (fr/en/ar) sous les
 * clés `trackingStatusExplain_<status>`, exactement comme les libellés
 * courts vivent sous `trackingStatus_<status>`. Ce module ne contient
 * AUCUN texte littéral -- il ne fait que nommer des clés et arbitrer
 * entre surcharge et base, afin de rester indépendant de
 * l'architecture i18n concrète.
 */

import {
  CANONICAL_ORDER_STATUSES,
  isCanonicalOrderStatus,
  type OrderStatus,
} from "@/lib/tracking/status";

/**
 * Clé i18n du TEXTE EXPLICATIF de base pour un statut canonique.
 * Préfixe délibérément DISTINCT de `trackingStatus_` (libellé court,
 * lib/tracking/status.ts::statusLabelKey) : les deux familles de clés
 * coexistent sans collision possible, et une absence de traduction de
 * l'une ne peut jamais emprunter silencieusement le texte de l'autre.
 */
export function statusExplanationKey(status: OrderStatus): string {
  return `trackingStatusExplain_${status}`;
}

/**
 * Surcharges marchandes : au plus un texte par statut canonique.
 * `null`/chaîne vide/blancs = « pas de surcharge » (repli sur la base),
 * jamais « afficher un texte vide » -- mandat §2, littéral : « An empty
 * override means use the base text ».
 *
 * Volontairement `Partial<Record<OrderStatus, ...>>` et NON un
 * `Record<string, string>` libre : le typage lui-même interdit de
 * désigner un statut inexistant.
 */
export type MerchantStatusTextOverrides = Partial<
  Record<OrderStatus, string | null | undefined>
>;

/** Longueur maximale d'une surcharge -- MIROIR EXACT de la contrainte
 *  SQL `merchant_tracking_status_text_body_length` (voir
 *  supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql). Le
 *  serveur reste l'autorité ; cette constante évite seulement un
 *  aller-retour pour une saisie manifestement invalide. */
export const MERCHANT_STATUS_TEXT_MAX_LENGTH = 400;

/**
 * Normalise UNE surcharge : `undefined` quand elle est absente, vide ou
 * uniquement composée de blancs (repli sur la base) ; sinon le texte
 * débarrassé de ses blancs de bordure.
 *
 * Ne tronque JAMAIS silencieusement : une surcharge trop longue est
 * traitée comme absente (repli sur le texte de base, qui est toujours
 * correct) plutôt que coupée au milieu d'une phrase. L'écriture est de
 * toute façon refusée en amont par la contrainte SQL -- ce cas ne peut
 * donc provenir que d'une donnée déjà en base antérieure à la
 * contrainte, jamais d'une saisie acceptée.
 */
export function normalizeMerchantStatusText(
  raw: string | null | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MERCHANT_STATUS_TEXT_MAX_LENGTH) return undefined;
  return trimmed;
}

/**
 * Filtre une configuration marchande BRUTE (telle que lue en base ou
 * reçue d'un formulaire) vers des surcharges sûres :
 *
 *   - toute clé NON canonique est ignorée (un marchand ne peut pas
 *     introduire un statut « en route »/« livré » par ce chemin) ;
 *   - toute valeur vide/blanche/trop longue est ignorée (repli base) ;
 *   - la valeur d'entrée n'est jamais modifiée.
 *
 * Résultat : un objet ne contenant QUE des statuts canoniques associés
 * à un texte réellement affichable.
 */
export function sanitizeMerchantStatusTextOverrides(
  raw: Readonly<Record<string, unknown>> | null | undefined
): MerchantStatusTextOverrides {
  const safe: MerchantStatusTextOverrides = {};
  if (!raw || typeof raw !== "object") return safe;
  for (const status of CANONICAL_ORDER_STATUSES) {
    // Propriété PROPRE uniquement -- jamais la chaîne de prototypes
    // (même discipline que `resolveLangFromParam`, lib/i18n.ts v1.1).
    if (!Object.prototype.hasOwnProperty.call(raw, status)) continue;
    const normalized = normalizeMerchantStatusText(
      raw[status] as string | null | undefined
    );
    if (normalized !== undefined) safe[status] = normalized;
  }
  return safe;
}

/** Origine RÉELLE du texte affiché -- exposée pour l'observabilité et
 *  pour les tests de non-régression du repli (jamais pour décider d'un
 *  comportement d'état : le statut, lui, est inchangé dans les deux
 *  cas). */
export type StatusTextSource = "merchant_override" | "base";

export interface ResolvedStatusText {
  /** Le statut CANONIQUE reçu, renvoyé TEL QUEL -- preuve structurelle
   *  qu'aucune résolution de texte ne peut le transformer. */
  status: OrderStatus;
  text: string;
  source: StatusTextSource;
}

/**
 * SEULE autorité de résolution du texte explicatif customer-facing.
 *
 * `translate` est injecté (jamais importé ici) pour que ce module reste
 * pur et testable sans charger tout lib/i18n.ts, et pour qu'il
 * fonctionne identiquement côté serveur (e-mail de confirmation) et
 * côté page de suivi.
 *
 * Ordre STRICT : surcharge marchande non vide -> texte de base i18n.
 * Aucun troisième repli n'est inventé ; `translate` garantit déjà son
 * propre repli (langue inconnue -> fr, clé inconnue -> la clé).
 */
export function resolveStatusText(
  status: OrderStatus,
  overrides: MerchantStatusTextOverrides | null | undefined,
  translate: (key: string) => string
): ResolvedStatusText {
  const override = normalizeMerchantStatusText(overrides?.[status]);
  if (override !== undefined) {
    return { status, text: override, source: "merchant_override" };
  }
  return { status, text: translate(statusExplanationKey(status)), source: "base" };
}
