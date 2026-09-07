import { supabase } from "@/lib/supabase";
import type { OperatorEstablishmentListItem } from "@/lib/operator-cockpit";

/**
 * OB-1 — OPERATOR MERCHANT DIRECTORY.
 *
 * Lecture SEULE, directement sur `public.restaurants` — AUCUNE
 * nouvelle RPC, AUCUNE nouvelle policy RLS, AUCUNE migration. Cette
 * lecture dépend structurellement de la policy déjà publiée et déjà
 * auditée "lecture operateur restaurants"
 * (supabase/migration-v70-identity-corrections.sql, ligne ~389) :
 *
 *   create policy "lecture operateur restaurants"
 *     on public.restaurants for select
 *     to authenticated
 *     using (public.is_scanym_operator());
 *
 * -> tout appelant `authenticated` pour qui `is_scanym_operator()`
 * renvoie faux ne reçoit tout simplement AUCUNE ligne supplémentaire
 * de cette policy (RLS, appliqué par PostgreSQL, jamais par ce
 * fichier). Les commerçants ordinaires restent en outre gouvernés par
 * les policies "lecture publique restaurants actifs" et "lecture
 * membre restaurant_users" déjà en production — aucune des deux n'est
 * touchée par ce lot.
 *
 * Colonnes demandées : STRICTEMENT id/name/slug/country/status
 * (aucune colonne financière ni de credential — il n'en existe de
 * toute façon aucune sur `restaurants`).
 *
 * Isolation multi-tenant : chaque ligne renvoyée reste un
 * établissement RÉEL et DISTINCT (`restaurants.id`) ; ce module ne
 * fusionne, n'agrège ni ne mélange jamais deux établissements. Le
 * filtrage (recherche/pays/statut) est appliqué CÔTÉ CLIENT par
 * `filterEstablishments` (lib/operator-cockpit.ts) sur cette liste
 * déjà chargée — délibérément simple et déterministe, pas un moteur
 * de recherche serveur (hors mandat OB-1).
 */
export async function listOperatorEstablishments(): Promise<OperatorEstablishmentListItem[]> {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id, name, slug, country, status")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    restaurantId: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    country: (row.country as string | null) ?? null,
    status: row.status as string,
  }));
}
