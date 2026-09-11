import "server-only";
import type { StuartContact, StuartPackageType, StuartPartnerData } from "@/lib/server/delivery-providers/stuart/types";
import type { StuartQuoteErrorClassification } from "@/lib/server/delivery-providers/stuart/quote-errors";

/**
 * STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING FOUNDATION v1.
 *
 * Types Scanym-owned, NORMALISÉS, pour la frontière de service
 * `validateDelivery(...)`/`quoteDelivery(...)` (`quote-service.ts`).
 * Réutilise EXACTEMENT (jamais dupliqué) `StuartContact`/
 * `StuartPackageType`/`StuartPartnerData` de `types.ts` (LOT existant,
 * preuve documentaire déjà établie) -- aucun champ n'est ici inventé,
 * seule la FORME de la requête côté APPELANT Scanym diffère de la
 * forme de charge utile Stuart elle-même (`StuartCreateJobPayload`),
 * exactement comme `CreateStuartSandboxJobForOrderInput` (create-job.ts,
 * DELIVERY STREAM C) le fait déjà pour Create Job -- même patron,
 * appliqué ici au couple validate/pricing.
 *
 * `packageType` ET `clientReference` sont des entrées EXPLICITES
 * OBLIGATOIRES de l'appelant (mandat, "PACKAGE TYPE" / "CREDENTIAL
 * RESOLUTION") -- ce module n'invente AUCUNE logique de sélection
 * automatique. `clientReference` n'est PAS dérivée automatiquement ici
 * (contrairement à Create Job, qui utilise
 * `deriveStuartClientReferenceCandidate(orderId)`) -- au stade
 * quote/validate, AUCUN `orderId` n'existe encore (mandat : "NO order
 * financial persistence... NO Stuart job creation" -- ce lot est
 * strictement en amont de la commande).
 *
 * `pricing`/`validate` PARTAGENT la MÊME forme de requête (confirmé,
 * voir le commentaire de `pricing.ts` : "Même structure de charge
 * utile que Create Job") -- `StuartQuoteRequestInput` est donc
 * UNIQUE, réutilisé identiquement par `ValidateDeliveryInput` et
 * `QuoteDeliveryInput` (alias, pas une duplication).
 */

export interface StuartQuotePickupInput {
  address: string;
  contact: StuartContact;
  comment?: string;
}

export interface StuartQuoteDropoffInput {
  address: string;
  contact: StuartContact;
  /** OBLIGATOIRE, entrée explicite de l'appelant -- voir commentaire
   *  de fichier ci-dessus (aucune sélection automatique). */
  packageType: StuartPackageType;
  /** OBLIGATOIRE, entrée explicite de l'appelant -- non dérivée
   *  automatiquement à ce stade (pas d'orderId, voir commentaire de
   *  fichier ci-dessus). */
  clientReference: string;
  packageDescription?: string;
  comment?: string;
}

/**
 * Hook de planification CONNU (mandat) : `pickup_at` UNIQUEMENT
 * (`job.pickup_at`, preuve documentaire déjà établie dans `types.ts`).
 * AUCUN autre champ de planification (`delivery_at`, fenêtres de
 * créneaux futurs, cutoffs) n'est modélisé ici -- ZÉRO preuve
 * documentaire actuelle trouvée dans ce dépôt pour l'un quelconque de
 * ces éléments (voir le livrable final, "unresolved Stuart contract
 * questions").
 */
export interface StuartQuoteSchedulingInput {
  pickupAt?: string;
}

export interface StuartQuoteRequestInput {
  /** Doit provenir d'un contexte serveur DÉJÀ authentifié -- voir
   *  `credential-resolver.ts`, même règle non-négociable. */
  restaurantId: string;
  pickup: StuartQuotePickupInput;
  dropoff: StuartQuoteDropoffInput;
  scheduling?: StuartQuoteSchedulingInput;
  partnerData?: StuartPartnerData;
}

/** `/v2/jobs/validate` -- alias, MÊME forme de requête que le devis
 *  (voir commentaire de fichier). */
export type ValidateDeliveryInput = StuartQuoteRequestInput;
/** `/v2/jobs/pricing` -- alias, MÊME forme de requête que la
 *  validation (voir commentaire de fichier). */
export type QuoteDeliveryInput = StuartQuoteRequestInput;

/**
 * Résultat NORMALISÉ, Scanym-owned -- ne JAMAIS exposer l'objet brut
 * de réponse Stuart au reste de l'application (mandat, "QUOTE /
 * VALIDATE SERVICE BOUNDARY").
 *
 * `providerQuoteReference`/`providerCostAmount`/`currency`/`eta`
 * restent TOUJOURS `undefined` dans ce lot -- AUCUNE preuve
 * documentaire actuelle des noms de champs exacts de la réponse
 * pricing Stuart n'a été trouvée dans ce dépôt (seul un fixture de
 * test synthétique existe, `tests/v144-stuart-pricing.test.ts`,
 * explicitement NON traité comme preuve). Voir
 * `extractStuartCommercialFields` (`quote-service.ts`) et le livrable
 * final, section "unresolved Stuart contract questions" -- mandat :
 * "Do NOT fabricate ETA or quote reference if API does not provide
 * them."
 *
 * `scheduling` ÉCHO simplement `input.scheduling` -- il n'est JAMAIS
 * dérivé de la réponse Stuart (aucune preuve que la réponse renvoie
 * une quelconque confirmation de créneau).
 */
export interface NormalizedStuartQuoteResult {
  eligible: boolean;
  providerCode: "stuart";
  /** AUTORITATIF, identique à `ResolvedStuartMerchantCredential.mode`
   *  (LOT A-0/STUART LOT A, `credential-resolver.ts`) -- jamais une
   *  valeur dérivée de la réponse Stuart elle-même. */
  mode: "sandbox" | "production";
  httpStatus: number;
  providerQuoteReference?: string;
  providerCostAmount?: number;
  currency?: string;
  eta?: string;
  scheduling?: StuartQuoteSchedulingInput;
  errorClassification?: StuartQuoteErrorClassification;
}
