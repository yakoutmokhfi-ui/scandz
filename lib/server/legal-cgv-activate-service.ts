import "server-only";
import { revalidatePath } from "next/cache";
import { asUserSupabaseClientFactory } from "@/lib/server/supabase-as-user";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * CGV W2 — PUBLICATION BOUNDARY FIXES (Noether, scanym-orchestrator#23).
 *
 * W2-6 : avant ce lot, aucune activation de CGV ne passait par une
 * frontière serveur -- `activateMerchantCgv` (lib/services/legal-cgv.ts)
 * appelait directement `supabase.rpc("activate_merchant_cgv", ...)`
 * depuis le NAVIGATEUR. Ce module ajoute la frontière serveur
 * manquante, par le MÊME patron déjà établi par
 * lib/server/legal-cgv-publish-service.ts (as-user / service_role,
 * app/api/dashboard/legal-cgv/publish/route.ts) -- jamais une seconde
 * convention.
 *
 * ZÉRO SQL (mandat §"DECISION Q4 NOETHER") : `activate_merchant_cgv`
 * elle-même n'est ni modifiée, ni redéfinie, ni re-grantée ici --
 * seul le POINT D'APPEL change (serveur au lieu du navigateur), à
 * l'identique de ses autorisations actuelles (appel as-user, sous le
 * jeton de l'appelant -- `assert_legal_cgv_role` continue de
 * s'exécuter sous l'auth.uid() réel de l'appelant, inchangé). Ce
 * n'est donc PAS un nouveau modèle métier (INVARIANTS du mandat :
 * "nouvelle route activation = frontière serveur technique, pas
 * nouveau modèle métier") -- uniquement un déplacement de point
 * d'appel plus l'ajout, au même endroit, de l'invalidation de cache
 * publique que seul du code serveur peut déclencher (`revalidatePath`
 * n'existe que dans un Server Action / Route Handler Next.js, jamais
 * dans un composant client).
 *
 * `invalidatePublicLegalPage` ci-dessous est exportée et réutilisée
 * TELLE QUELLE par app/api/dashboard/legal-cgv/publish/route.ts (W2-6
 * exige l'invalidation après publication ET après activation, par le
 * MÊME mécanisme) -- jamais une seconde implémentation divergente.
 * lib/server/legal-cgv-publish-service.ts lui-même reste
 * STRICTEMENT inchangé (hors périmètre W2) : l'appel d'invalidation
 * est donc fait depuis la ROUTE publish elle-même (fichier autorisé),
 * jamais injecté dans ce service qu'il ne faut pas toucher.
 */

export type LegalCgvActivateFailureReason =
  | "auth"
  | "forbidden"
  | "incomplete"
  | "not_published"
  | "unavailable";

export class LegalCgvActivateServerError extends Error {
  reason: LegalCgvActivateFailureReason;
  detail: string | null;

  constructor(reason: LegalCgvActivateFailureReason, detail: string | null = null, cause?: unknown) {
    super(`LegalCgvActivateServerError: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "LegalCgvActivateServerError";
    this.reason = reason;
    this.detail = detail;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Classifie une erreur RPC `activate_merchant_cgv` -- mêmes codes que
 * `assert_legal_cgv_role` déjà utilisés par
 * lib/server/legal-cgv-publish-service.ts (28000/42501), plus les deux
 * messages propres à `activate_merchant_cgv`
 * (DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql, section K) :
 * jamais un message SQL brut renvoyé au navigateur.
 */
function classifyActivateError(error: { code?: string; message?: string } | null): LegalCgvActivateServerError {
  const message = error?.message ?? "";
  if (error?.code === "28000") return new LegalCgvActivateServerError("auth", null, error);
  if (error?.code === "42501") return new LegalCgvActivateServerError("forbidden", null, error);
  if (message.includes("CGV_INCOMPLETE")) return new LegalCgvActivateServerError("incomplete", message, error);
  if (message.includes("CGV_NOT_PUBLISHED")) return new LegalCgvActivateServerError("not_published", message, error);
  return new LegalCgvActivateServerError("unavailable", message || null, error);
}

/**
 * Point d'entrée UNIQUE de l'activation CGV serveur-autoritaire.
 * `accessToken` : jeton de la session du DEMANDEUR HTTP lui-même
 * (extrait par la route appelante de son PROPRE en-tête
 * `Authorization`) -- jamais un secret, jamais réutilisé d'une requête
 * à l'autre (même discipline que
 * publishMerchantCgvVersionServerAuthoritative).
 */
export async function activateMerchantCgvServerAuthoritative(
  accessToken: string,
  restaurantId: string
): Promise<void> {
  const asUser = asUserSupabaseClientFactory.create(accessToken);

  const { error } = await asUser.rpc("activate_merchant_cgv", { p_restaurant_id: restaurantId });
  if (error) {
    throw classifyActivateError(error);
  }

  // W2-6 -- best-effort : un échec d'invalidation de cache ne doit
  // jamais transformer une activation RÉUSSIE (déjà persistée) en
  // réponse d'erreur côté navigateur -- la base de données reste la
  // source de vérité ; seule la vitrine publique mettrait jusqu'à 60s
  // (app/legal/[slug]/page.tsx, `revalidate = 60`) à refléter le
  // changement si cet appel échoue.
  try {
    await invalidatePublicLegalPage(restaurantId);
  } catch {
    // best-effort, voir commentaire ci-dessus.
  }
}

/**
 * Invalide le cache ISR de la page légale publique (`/legal/<slug>`,
 * app/legal/[slug]/page.tsx, `export const revalidate = 60`) pour le
 * marchand désigné par `restaurantId`. Partagée par CE module
 * (activation) ET app/api/dashboard/legal-cgv/publish/route.ts
 * (publication) -- W2-6 exige l'identique invalidation dans les deux
 * cas, jamais deux implémentations.
 *
 * Résout le `slug` via une LECTURE directe, triviale et non sensible
 * de `restaurants.slug` (colonne déjà publique -- elle apparaît telle
 * quelle dans l'URL publique `/legal/<slug>` elle-même) -- ZÉRO SQL
 * nouveau (ni RPC, ni fonction, ni colonne : table et colonne déjà
 * existantes, schema.sql). Le client service_role est utilisé ici
 * (lecture best-effort post-succès, jamais la source d'autorisation :
 * l'activation/la publication elle-même a déjà été vérifiée et
 * autorisée en amont, sous l'identité réelle de l'appelant).
 */
export async function invalidatePublicLegalPage(restaurantId: string): Promise<void> {
  const admin = getServiceRoleSupabaseClient();
  const { data, error } = await admin.from("restaurants").select("slug").eq("id", restaurantId).single();
  if (error || !data?.slug) return;
  revalidatePath(`/legal/${data.slug}`);
}
