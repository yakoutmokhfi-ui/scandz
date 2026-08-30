import "server-only";
import type {
  MoneticoBillingContext,
  MoneticoShippingContext,
} from "@/lib/server/payment-providers/monetico/billing-mapping";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 *
 * Types partagés du premier adaptateur de prestataire de paiement réel
 * de l'application. `provider_code = "monetico"` (mandat §7) -- aucun
 * adaptateur bancaire séparé (CIC/Crédit Mutuel) n'est créé : ces
 * banques utilisent la même plateforme technique Monetico.
 *
 * Toutes les valeurs de champ documentées ici proviennent de la
 * documentation officielle « Monetico Paiement — Documentation
 * Technique — Version 2.0 — Février 2025 » (mandat §2), à l'exception
 * explicite de la construction de la chaîne canonique utilisée pour le
 * calcul du MAC -- voir le commentaire de provenance en tête de
 * `canonicalization.ts`, et la section « CANONICALIZATION » du rapport
 * d'implémentation pour le détail complet de ce qui a pu, ou n'a pas
 * pu, être vérifié directement par l'agent.
 */

/**
 * Format de stockage du credential Monetico DANS Vault (mandat §8).
 * `set_payment_provider_credentials(p_secret text, ...)` (PAYMENT P2A,
 * déjà publié) n'impose AUCUNE structure au contenu de `p_secret` --
 * c'est une décision de CE lot, pas une exigence du protocole Monetico
 * lui-même ni de la couche de stockage P2A. Stocké comme une chaîne
 * JSON (`JSON.stringify(...)`) dans `p_secret` ; relu et validé
 * strictement par `parseMoneticoCredential` (credentials.ts) après
 * déchiffrement par `getPaymentProviderCredential` (P3-A0/P3-A1).
 */
export interface MoneticoCredentialPayload {
  /** TPE Monetico -- 7 caractères alphanumériques (v2.0 §1.4.2.2,
   *  p.12, plage atteinte et confirmée par l'agent). */
  tpe: string;
  /** Identifiant "société" généré à la création du contrat marchand
   *  (v2.0 §1.4.2.2, p.12 -- format exact non davantage précisé par le
   *  document au-delà de "chaîne de caractères" ; validé ici comme
   *  ASCII imprimable non vide, borne de longueur choisie par
   *  l'application, pas par le protocole). */
  societe: string;
  /** Clé de sécurité externe -- 40 caractères hexadécimaux (v2.0 §1.3,
   *  p.9-10, confirmé). Transformée en 20 octets avant tout calcul de
   *  MAC (voir mac.ts::transformSecurityKey). */
  securityKey: string;
}

/** Entrée de construction d'une requête de paiement Monetico. Le
 *  montant/devise DOIVENT provenir du résultat de
 *  `initiatePaymentAttempt()` (PAYMENT P1/P3-A1, déjà publié et
 *  audité) -- cette interface ne les accepte que comme des champs
 *  simples et n'a aucune connaissance d'une requête HTTP entrante ou
 *  d'une saisie navigateur (mandat §14 : aucune route publique
 *  n'existe dans ce lot, donc aucune donnée client ne peut de toute
 *  façon atteindre cette fonction directement). */
export interface BuildMoneticoRequestInput {
  credential: MoneticoCredentialPayload;
  /** Montant AUTORITAIRE, tel que renvoyé par `initiatePaymentAttempt`
   *  -- jamais recalculé, jamais accepté indépendamment. */
  amount: number;
  /** Devise AUTORITAIRE, tel que renvoyée par `initiatePaymentAttempt`. */
  currency: string;
  /** Amorce (seed) déterministe pour la dérivation de la référence
   *  Monetico (reference.ts) -- typiquement l'id de commande ; le
   *  choix exact appartient à la future orchestration (P3-B), hors
   *  périmètre de ce lot bibliothèque pur. */
  referenceSeed: string;
  /** Code langue ISO documenté (DE/EN/ES/FR/IT/JA/NL/PT/SV) -- "FR"
   *  par défaut. */
  language?: string;
  /** Identifiant de corrélation NON SECRET, optionnel, placé dans
   *  `contexte_commande` (mandat §18 : "minimum safe metadata needed
   *  for correlation", jamais de secret). */
  orderCorrelationId?: string;
  /**
   * PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1. Objet `billing` déjà
   * mappé au vocabulaire Monetico exact (voir
   * `billing-mapping.ts::mapToMoneticoBilling`) -- CE fichier
   * (`request.ts`) ne fait QUE le sérialiser dans `contexte_commande`,
   * il ne construit, ne valide, ni ne mappe jamais lui-même une
   * quelconque donnée de facturation. Optionnel et RÉTROCOMPATIBLE :
   * omis, `contexte_commande` reste BYTE-IDENTIQUE à son comportement
   * PAYMENT P3-A2 d'origine (mandat §18, non-régression MAC).
   */
  billingContext?: MoneticoBillingContext;
  /**
   * PAYMENT P3-B6 — objet `shipping` déjà mappé, envoyé UNIQUEMENT
   * lorsque le mode de service est réellement `delivery` (mandat §14)
   * -- cette décision appartient à l'appelant de
   * `buildMoneticoPaymentRequest`, jamais à ce fichier. Omis pour tout
   * mode addressless (pickup/click_collect/table/room_service) --
   * `request.ts` ne fabrique JAMAIS un objet `shipping` vide.
   */
  shippingContext?: MoneticoShippingContext;
}

/** Champs de la requête de paiement Monetico sortante (interface
 *  "Aller"), limités au sous-ensemble OBLIGATOIRE documenté et
 *  indépendamment confirmé (v2.0 §1.4.2.2, p.12-17) -- aucun champ
 *  optionnel non documenté ici n'est implémenté par ce lot v1 (mandat
 *  §13 : "Do not implement undocumented fields"). */
export interface MoneticoPaymentRequestFields {
  version: string;
  TPE: string;
  date: string;
  montant: string;
  reference: string;
  lgue: string;
  contexte_commande: string;
  societe: string;
  MAC: string;
}

/** Champs bruts reçus par un futur gestionnaire de callback -- forme
 *  d'un objet clé/valeur simple, avant toute validation. */
export interface MoneticoCallbackRawFields {
  [key: string]: unknown;
}

/** Résultat générique auquel ce lot réduit un callback Monetico
 *  vérifié (mandat §24) -- ne JAMAIS exposer les champs Monetico bruts
 *  au moteur de paiement générique au-delà de ce nécessaire. */
export type MoneticoResultStatus = "paid" | "failed" | "pending";

export interface MoneticoVerifiedCallbackResult {
  status: MoneticoResultStatus;
  /** `code-retour` brut, conservé pour traçabilité/diagnostic --
   *  jamais interprété comme secret. */
  codeRetour: string;
  /** Devient `provider_reference` pour la couche générique (mandat
   *  §25) -- correspond au champ `reference` du callback, qui échoue
   *  la valeur envoyée par le marchand dans la requête sortante
   *  (sémantique confirmée v2.0 §1.4.3.1, p.26-35). */
  providerReference: string;
  /** Devient `authorization_reference` pour la couche générique
   *  (mandat §25) -- correspond au champ `numauto` ("numéro
   *  d'autorisation, si accepté"), absent/`null` si non fourni. */
  authorizationReference: string | null;
  /** Montant brut du callback tel que reçu (optionnel côté protocole
   *  -- "uniquement dans le cas des modes de paiement hors
   *  préautorisation"), jamais reformaté ni réinterprété ici. */
  rawMontant: string | null;
}
