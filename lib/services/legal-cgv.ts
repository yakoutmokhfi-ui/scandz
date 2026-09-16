import { supabase } from "@/lib/supabase";
import { getSession } from "@/lib/services/auth";
import type {
  MerchantLegalProfile,
  MerchantCgvProfile,
  MerchantCgvVersion,
  WithdrawalRegime,
  PreparationTimeUnit,
  CgvPresentationVariant,
  WeightPricingMode,
} from "@/lib/dashboard-types";

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1 -- Phase 1. Enveloppes minces
 * autour des RPC serveur (même patron que getReceiptSettings/
 * updateReceiptSettings dans lib/services/dashboard.ts) : aucune
 * logique métier ici, la validation/autorisation/complétude vit
 * entièrement côté SQL (assert_legal_cgv_role, cgv_completeness_errors,
 * ...).
 *
 * v1.1 (Catimini, Blocker 1, CGV-V1-PUBLISH-AUTHORITY-01) — EXCEPTION
 * À CE PATRON pour `publishMerchantCgvVersion` ci-dessous : la
 * publication ne parle plus JAMAIS directement à une RPC Supabase
 * depuis le navigateur (l'ancienne RPC de ce nom, qui acceptait un
 * contenu rendu fourni par le client, n'existe plus du tout). Voir sa
 * propre documentation plus bas.
 */

export async function getMerchantLegalProfile(restaurantId: string): Promise<MerchantLegalProfile | null> {
  const { data, error } = await supabase.rpc("get_merchant_legal_profile", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.restaurant_id == null) return null;
  return row as MerchantLegalProfile;
}

export async function updateMerchantLegalProfile(params: {
  restaurantId: string;
  legalForm: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  governingCountry: string | null;
  customerServiceEmail: string | null;
  customerServicePhone: string | null;
  consumerMediatorName: string | null;
  consumerMediatorAddress: string | null;
  consumerMediatorWebsite: string | null;
  /** CGV ENGINE v2.1 */
  legalEntityName?: string | null;
  siren?: string | null;
  siret?: string | null;
  vatNumber?: string | null;
  consumerMediatorPhone?: string | null;
  consumerMediatorEmail?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc("update_merchant_legal_profile", {
    p_restaurant_id: params.restaurantId,
    p_legal_form: params.legalForm,
    p_address_line1: params.addressLine1,
    p_address_line2: params.addressLine2,
    p_postal_code: params.postalCode,
    p_city: params.city,
    p_governing_country: params.governingCountry,
    p_customer_service_email: params.customerServiceEmail,
    p_customer_service_phone: params.customerServicePhone,
    p_consumer_mediator_name: params.consumerMediatorName,
    p_consumer_mediator_address: params.consumerMediatorAddress,
    p_consumer_mediator_website: params.consumerMediatorWebsite,
    p_legal_entity_name: params.legalEntityName ?? null,
    p_siren: params.siren ?? null,
    p_siret: params.siret ?? null,
    p_vat_number: params.vatNumber ?? null,
    p_consumer_mediator_phone: params.consumerMediatorPhone ?? null,
    p_consumer_mediator_email: params.consumerMediatorEmail ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function getMerchantCgvProfile(restaurantId: string): Promise<MerchantCgvProfile> {
  const { data, error } = await supabase.rpc("get_merchant_cgv_profile", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row as MerchantCgvProfile;
}

export async function updateMerchantCgvProfile(params: {
  restaurantId: string;
  withdrawalRegime: WithdrawalRegime | null;
  preparationTimeMin: number | null;
  preparationTimeMax: number | null;
  preparationTimeUnit: PreparationTimeUnit | null;
  cancellationPolicyText: string | null;
  substitutionPolicyText: string | null;
  presentationVariant: CgvPresentationVariant;
  /** CGV ENGINE v2.1 */
  coldChainApplicable?: boolean;
  weightPricingMode?: WeightPricingMode | null;
}): Promise<void> {
  const { error } = await supabase.rpc("update_merchant_cgv_profile", {
    p_restaurant_id: params.restaurantId,
    p_withdrawal_regime: params.withdrawalRegime,
    p_preparation_time_min: params.preparationTimeMin,
    p_preparation_time_max: params.preparationTimeMax,
    p_preparation_time_unit: params.preparationTimeUnit,
    p_cancellation_policy_text: params.cancellationPolicyText,
    p_substitution_policy_text: params.substitutionPolicyText,
    p_presentation_variant: params.presentationVariant,
    p_cold_chain_applicable: params.coldChainApplicable ?? false,
    p_weight_pricing_mode: params.weightPricingMode ?? null,
  });
  if (error) throw new Error(error.message);
}

/**
 * Erreur de publication -- distincte d'une simple `Error(message)` pour
 * que le tableau de bord puisse afficher un message adapté au `reason`
 * stable renvoyé par la route (jamais un message serveur brut).
 */
export class PublishCgvError extends Error {
  reason:
    | "auth"
    | "forbidden"
    | "incomplete"
    | "template_unresolved"
    | "stale_context"
    | "unavailable"
    | "invalid_field"
    // CGV ENGINE v2.5 (Tasks 4/5) -- see lib/server/legal-cgv-publish-
    // service.ts's own LegalCgvPublishFailureReason for the SQL-level
    // origin of each.
    | "withdrawal_runtime_not_ready"
    | "placeholder_text_detected"
    | "legal_guarantee_block_missing";
  constructor(reason: PublishCgvError["reason"]) {
    super(`PublishCgvError: ${reason}`);
    this.name = "PublishCgvError";
    this.reason = reason;
  }
}

/**
 * Publie une nouvelle version CGV immuable.
 *
 * v1.1 (Catimini, Blocker 1, CGV-V1-PUBLISH-AUTHORITY-01) -- CE MODULE
 * NE RESTITUE PLUS JAMAIS de contenu rendu, de template id, de locale
 * ni de variante de présentation au serveur : la SEULE information
 * transmise est `restaurantId`. Toute la résolution (gabarit applicable,
 * profil légal, conditions commerciales, rendu déterministe, hash) a
 * désormais lieu ENTIÈREMENT côté serveur, dans
 * lib/server/legal-cgv-publish-service.ts, appelé via la route de
 * confiance app/api/dashboard/legal-cgv/publish/route.ts -- même patron
 * que lib/services/product-photo.ts (BULK PRODUCT PHOTOS v1.4+) et
 * lib/services/invoice-request.ts. Aucune RPC Supabase n'est appelée
 * directement ici : l'ancienne RPC de ce nom qui acceptait un contenu
 * rendu client n'existe plus (voir la migration SQL v1.1) -- il n'y a
 * donc plus rien à appeler directement même en cas de régression.
 */
const PUBLISH_ROUTE = "/api/dashboard/legal-cgv/publish";

export async function publishMerchantCgvVersion(params: { restaurantId: string }): Promise<MerchantCgvVersion> {
  const session = await getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    throw new PublishCgvError("auth");
  }

  let response: Response;
  try {
    response = await fetch(PUBLISH_ROUTE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ restaurantId: params.restaurantId }),
    });
  } catch {
    throw new PublishCgvError("unavailable");
  }

  let body: { outcome?: string; version?: Record<string, unknown> } = {};
  try {
    body = await response.json();
  } catch {
    // pas de corps JSON exploitable -- l'erreur générique suffit.
  }

  if (!response.ok || body.outcome !== "ok") {
    const reason = body.outcome as PublishCgvError["reason"] | undefined;
    throw new PublishCgvError(
      reason &&
      [
        "auth",
        "forbidden",
        "incomplete",
        "template_unresolved",
        "stale_context",
        "invalid_field",
        "withdrawal_runtime_not_ready",
        "placeholder_text_detected",
        "legal_guarantee_block_missing",
      ].includes(reason)
        ? reason
        : "unavailable"
    );
  }

  // `version` arrive déjà sous la forme snake_case des colonnes de
  // public.merchant_cgv_version (voir lib/server/legal-cgv-publish-
  // service.ts, PublishedCgvVersionRow) -- aucune conversion de casse
  // nécessaire ici, contrairement à un remaniement risquant d'inverser
  // un champ par erreur.
  return body.version as unknown as MerchantCgvVersion;
}

export async function activateMerchantCgv(restaurantId: string): Promise<void> {
  const { error } = await supabase.rpc("activate_merchant_cgv", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
}

export interface PublicCgv {
  restaurantId: string;
  cgvVersionId: string;
  renderedContent: string;
  contentHash: string;
  locale: string;
  publishedAt: string;
  /** true UNIQUEMENT si le marchand est CGV_ACTIVE (statut réel côté
   *  serveur) -- distinct de "une version existe" (vrai dès
   *  CGV_READY, publié mais pas encore exécutoire). Piloté le
   *  checkbox obligatoire au checkout (components/CartPanel.tsx) ;
   *  reflète EXACTEMENT le garde-fou serveur de create_order, jamais
   *  une approximation côté client. */
  enforced: boolean;
}

/** Page légale publique cliente -- app/legal/[slug]/page.tsx, et
 *  checkout (components/MenuView.tsx) pour savoir si l'acceptation est
 *  actuellement obligatoire pour ce marchand. */
export async function getRestaurantPublicCgv(slug: string): Promise<PublicCgv | null> {
  const { data, error } = await supabase.rpc("get_restaurant_public_cgv", { p_slug: slug });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    restaurantId: row.restaurant_id,
    cgvVersionId: row.cgv_version_id,
    renderedContent: row.rendered_content,
    contentHash: row.content_hash,
    locale: row.locale,
    publishedAt: row.published_at,
    enforced: !!row.enforced,
  };
}
