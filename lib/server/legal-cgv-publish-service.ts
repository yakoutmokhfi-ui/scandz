import "server-only";
import { asUserSupabaseClientFactory } from "@/lib/server/supabase-as-user";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  renderCgv,
  type CgvTemplateControlledSections,
  type WithdrawalRegime,
  type PreparationTimeUnit,
  type PresentationVariant,
} from "@/lib/legal/render";

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1.1/v1.2 — AUDIT REMEDIATION
 * (Catimini). v1.1 closed Blocker 1 (CGV-V1-PUBLISH-AUTHORITY-01) and
 * Blocker 2 (CGV-V1-PROD-ACL-01) — both CONFIRMED CLOSED and not
 * reopened here. This file's v1.2 changes close a further, distinct
 * finding: CGV-V11-PUBLISH-CONTEXT-RACE-01 (HIGH).
 *
 * v1's dashboard sent a FULLY RENDERED HTML string (built client-side
 * by lib/legal/render.ts, running in the browser) to
 * `publish_merchant_cgv_version`, which persisted it after nothing more
 * than a non-empty check and a hash computation — the browser was the
 * de-facto authority over the published CGV body later rendered via
 * `dangerouslySetInnerHTML` (app/legal/[slug]/page.tsx). v1.1 fixed
 * that by splitting publication into two server-only calls (below).
 *
 * v1.1's split introduced a NEW, narrower problem (Catimini's targeted
 * re-audit): resolve_cgv_publication_context and persist_merchant_cgv_
 * version are two SEPARATE database calls with renderCgv() running in
 * Node in between — a merchant's legal/CGV profile (or its
 * authorization) could change in that window, letting a published
 * version record content rendered from OLD context under NEWER
 * metadata, or let a since-deauthorized caller still publish. v1.2
 * closes this WITHOUT reopening the v1.1 publication-authority
 * boundary: the browser still supplies only a restaurant id (see
 * lib/services/legal-cgv.ts) and still cannot reach persistence
 * directly (unchanged EXECUTE grants).
 *
 * This module is the ONLY place in the entire project that renders a
 * CGV document destined for actual publication. It follows the EXACT
 * same as-user / service_role split already established by
 * lib/server/product-photo-service.ts (BULK PRODUCT PHOTOS v1.4+):
 *
 *   1. `resolve_cgv_publication_context` — called AS THE CALLING USER
 *      (lib/server/supabase-as-user.ts, the caller's own access token,
 *      never a secret). Runs entirely server-side, but under the
 *      caller's own auth.uid()/role — this is what proves the caller
 *      is actually authorized (assert_legal_cgv_role: owner/manager/
 *      operator) without this module having to duplicate that logic.
 *      Returns EVERY input the renderer needs and NOTHING the browser
 *      supplied: no template id, no locale, no presentation variant,
 *      no rendered content — all of it is resolved by that RPC from
 *      already-stored, already-validated server state. v1.2 ADDS two
 *      more server-only outputs, `context_fingerprint` (a deterministic
 *      digest of every authoritative input) and `acting_user_id`
 *      (auth.uid() as resolved by THIS call, JWT-derived) — both are
 *      held ONLY in memory in this module, between these two RPC
 *      calls; NEITHER is ever part of the HTTP request/response shape
 *      the browser sees (app/api/dashboard/legal-cgv/publish/route.ts
 *      is unchanged: `{ restaurantId }` in, the published version row
 *      out — no fingerprint, no acting_user_id, ever reaches the
 *      client).
 *
 *   2. `renderCgv()` (lib/legal/render.ts) — the SAME deterministic
 *      renderer the dashboard's own advisory preview already used in
 *      v1 (never a second, divergent implementation) — now invoked
 *      HERE, in trusted Node code, not in the browser.
 *
 *   3. `persist_merchant_cgv_version` — called via the service_role
 *      client (lib/server/supabase-admin.ts). EXECUTE on this function
 *      is granted to service_role ONLY (revoked from anon/authenticated/
 *      PUBLIC — see DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql)
 *      — an authenticated browser cannot reach it directly at all,
 *      regardless of what it sends (see the mandatory DIRECT RPC
 *      BYPASS test in the SQL harness). The function itself still
 *      independently re-proves template applicability and computes the
 *      content hash itself — this module's own correctness is never
 *      the sole safeguard. v1.2 ADDS: the acting user's authorization is
 *      RE-CHECKED at this exact boundary (not merely trusted from step
 *      1), and the fingerprint from step 1 is RE-COMPARED against a
 *      freshly-locked, freshly-recomputed value inside an atomic
 *      Postgres row-lock/compare — any authoritative drift between
 *      steps 1 and 3 raises STALE_CONTEXT and persists nothing.
 *
 * The browser-facing surface (lib/services/legal-cgv.ts,
 * `publishMerchantCgvVersion`) sends ONLY a restaurant id to
 * app/api/dashboard/legal-cgv/publish/route.ts — no rendered HTML, no
 * template id, no locale, no presentation variant, no context
 * fingerprint, no acting user id, ever.
 */

export type LegalCgvPublishFailureReason =
  | "auth"
  | "forbidden"
  | "incomplete"
  | "template_unresolved"
  | "stale_context"
  | "unavailable";

export class LegalCgvPublishServerError extends Error {
  reason: LegalCgvPublishFailureReason;
  detail: string | null;

  constructor(reason: LegalCgvPublishFailureReason, detail: string | null = null, cause?: unknown) {
    super(`LegalCgvPublishServerError: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "LegalCgvPublishServerError";
    this.reason = reason;
    this.detail = detail;
    if (cause !== undefined) {
      // Node's Error `cause` option — kept for server-side diagnostics
      // only, never surfaced verbatim to the HTTP response (the route
      // maps `reason` to a generic client-facing outcome).
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

interface PublicationContextRow {
  restaurant_id: string;
  seller_name: string | null;
  template_id: string;
  template_version: number;
  controlled_sections: CgvTemplateControlledSections;
  merchant_profile_version: number;
  locale: string;
  presentation_variant: PresentationVariant;
  legal_form: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  governing_country: string | null;
  customer_service_email: string | null;
  customer_service_phone: string | null;
  mediator_name: string | null;
  mediator_address: string | null;
  mediator_website: string | null;
  withdrawal_regime: WithdrawalRegime | null;
  preparation_time_min: number | null;
  preparation_time_max: number | null;
  preparation_time_unit: PreparationTimeUnit | null;
  cancellation_policy_text: string | null;
  substitution_policy_text: string | null;
  /** v1.2 — server-computed digest of every authoritative input this
   *  context depends on. Opaque to this module (and to every caller
   *  of it): held only in memory, threaded straight through to
   *  persist_merchant_cgv_version, NEVER inspected, logged, or
   *  returned to the browser. */
  context_fingerprint: string;
  /** v1.2 — auth.uid() as resolved by resolve_cgv_publication_context
   *  itself (JWT-derived, via the as-user client) — threaded through to
   *  persist_merchant_cgv_version so it can recheck authorization
   *  against CURRENT state at the persistence boundary, not merely
   *  trust that this resolve call once succeeded. */
  acting_user_id: string;
}

/**
 * Forme brute renvoyée par `persist_merchant_cgv_version` (snake_case,
 * colonnes de public.merchant_cgv_version) -- transmise TELLE QUELLE
 * jusqu'à la route HTTP puis jusqu'à lib/services/legal-cgv.ts, qui la
 * fait déjà correspondre à `MerchantCgvVersion` (lib/dashboard-types.ts)
 * exactement comme get_merchant_cgv_profile/les autres RPC de ce
 * fichier -- aucune seconde convention de nommage introduite ici.
 */
export interface PublishedCgvVersionRow {
  id: string;
  restaurant_id: string;
  template_id: string;
  template_version: number;
  merchant_profile_version: number;
  locale: string;
  presentation_variant: string;
  rendered_content: string;
  content_hash: string;
  effective_from: string;
  published_at: string;
  status: string;
}

/**
 * Classifie une erreur RPC Supabase en raison stable, JAMAIS un message
 * SQL brut exposé au navigateur (même discipline que
 * InvoiceRequestServerError/ProductPhotoServerError déjà établis dans
 * ce dépôt).
 */
function classifyResolveError(error: { code?: string; message?: string } | null): LegalCgvPublishServerError {
  const message = error?.message ?? "";
  if (error?.code === "28000") return new LegalCgvPublishServerError("auth", null, error);
  if (error?.code === "42501") return new LegalCgvPublishServerError("forbidden", null, error);
  if (message.includes("CGV_INCOMPLETE")) return new LegalCgvPublishServerError("incomplete", message, error);
  if (message.includes("TEMPLATE_UNRESOLVED")) return new LegalCgvPublishServerError("template_unresolved", null, error);
  return new LegalCgvPublishServerError("unavailable", message || null, error);
}

function classifyPersistError(error: { code?: string; message?: string } | null): LegalCgvPublishServerError {
  const message = error?.message ?? "";
  // v1.2 — checked FIRST: a stale-context rejection is a distinct,
  // deterministic outcome (the authoritative context changed between
  // resolve and persist, or the acting user's authorization was
  // revoked in that same window — see classifyResolveError's own
  // 28000/42501 codes, which persist_merchant_cgv_version's
  // authorization recheck raises identically), never conflated with a
  // completeness or template-applicability failure.
  if (error?.code === "42501") return new LegalCgvPublishServerError("forbidden", null, error);
  if (message.includes("STALE_CONTEXT")) return new LegalCgvPublishServerError("stale_context", message, error);
  if (message.includes("CGV_INCOMPLETE")) return new LegalCgvPublishServerError("incomplete", message, error);
  if (message.includes("TEMPLATE_NOT_APPLICABLE") || message.includes("template_id")) {
    return new LegalCgvPublishServerError("template_unresolved", message, error);
  }
  return new LegalCgvPublishServerError("unavailable", message || null, error);
}

/**
 * Point d'entrée UNIQUE de la publication CGV serveur-autoritaire.
 * `accessToken` : jeton de la session du DEMANDEUR HTTP lui-même
 * (extrait par la route appelante de son PROPRE en-tête
 * `Authorization`) — jamais un secret, jamais réutilisé d'une requête
 * à l'autre (voir lib/server/supabase-as-user.ts).
 */
export async function publishMerchantCgvVersionServerAuthoritative(
  accessToken: string,
  restaurantId: string
): Promise<PublishedCgvVersionRow> {
  const asUser = asUserSupabaseClientFactory.create(accessToken);

  const { data: contextData, error: contextError } = await asUser.rpc("resolve_cgv_publication_context", {
    p_restaurant_id: restaurantId,
  });
  if (contextError) {
    throw classifyResolveError(contextError);
  }
  const ctx = (Array.isArray(contextData) ? contextData[0] : contextData) as PublicationContextRow | undefined;
  if (!ctx) {
    throw new LegalCgvPublishServerError("unavailable", "empty_context_row");
  }

  // Rendu -- TOUJOURS ici (Node, serveur), jamais dans le navigateur.
  // Le même moteur (lib/legal/render.ts) que l'aperçu du tableau de
  // bord marchand, jamais une seconde implémentation divergente.
  let renderedContent: string;
  try {
    renderedContent = renderCgv({
      sellerName: ctx.seller_name || "—",
      template: ctx.controlled_sections,
      legal: {
        legalForm: ctx.legal_form ?? "",
        addressLine1: ctx.address_line1 ?? "",
        addressLine2: ctx.address_line2 ?? null,
        postalCode: ctx.postal_code ?? "",
        city: ctx.city ?? "",
        governingCountry: ctx.governing_country ?? "",
        customerServiceEmail: ctx.customer_service_email ?? null,
        customerServicePhone: ctx.customer_service_phone ?? null,
        mediatorName: ctx.mediator_name ?? "",
        mediatorAddress: ctx.mediator_address ?? "",
        mediatorWebsite: ctx.mediator_website ?? "",
      },
      business: {
        withdrawalRegime: ctx.withdrawal_regime as WithdrawalRegime,
        preparationTimeMin: ctx.preparation_time_min as number,
        preparationTimeMax: ctx.preparation_time_max as number,
        preparationTimeUnit: ctx.preparation_time_unit as PreparationTimeUnit,
        cancellationPolicyText: ctx.cancellation_policy_text,
        substitutionPolicyText: ctx.substitution_policy_text,
      },
      locale: ctx.locale,
      presentationVariant: ctx.presentation_variant,
    });
  } catch (e) {
    // Cohérent avec le garde-fou SQL (cgv_completeness_errors) : un
    // régime de rétractation non résolu par le gabarit (MIXED, ou tout
    // état incohérent) échoue fermé ici aussi, jamais une publication
    // avec une clause manquante silencieusement omise.
    throw new LegalCgvPublishServerError("template_unresolved", e instanceof Error ? e.message : null, e);
  }

  const admin = getServiceRoleSupabaseClient();
  const { data: versionData, error: persistError } = await admin.rpc("persist_merchant_cgv_version", {
    p_restaurant_id: restaurantId,
    p_template_id: ctx.template_id,
    p_rendered_content: renderedContent,
    // v1.2 — both opaque, server-derived from step 1 above, never
    // touched by the browser at any point in this request's lifetime.
    p_expected_context_fingerprint: ctx.context_fingerprint,
    p_acting_user_id: ctx.acting_user_id,
  });
  if (persistError) {
    throw classifyPersistError(persistError);
  }
  const row = Array.isArray(versionData) ? versionData[0] : versionData;
  if (!row) {
    throw new LegalCgvPublishServerError("unavailable", "empty_version_row");
  }

  return row as PublishedCgvVersionRow;
}
