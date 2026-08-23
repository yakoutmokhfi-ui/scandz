-- ============================================================
-- Scanym LOT 2B.1 — Nouvelle RPC publique minimale
-- get_restaurant_public_delivery_info.
--
-- Baseline : LOT 2A.4 (vrai main, bd2980a1d3d708f9a51bd72874e9fd2c009b3516,
-- Production installée et validée). Ce fichier n'AJOUTE qu'une seule
-- fonction -- aucune table, aucune modification de l'existant.
--
-- Respecte strictement REVISION 4 de la spécification LOT 2B :
--   - projection minimale et typée, jamais le config JSONB brut ;
--   - aucun helper interne (lecture directe, une seule requête) ;
--   - les 4 conditions de filtrage exigées, toutes dans le WHERE ;
--   - conversion JSONB -> text[] réutilisant EXACTEMENT le patron
--     déjà audité dans create_order (jsonb_array_elements_text +
--     coalesce), jamais un nouveau format ;
--   - REVOKE explicite avant GRANT, jamais l'inverse ;
--   - EXECUTE uniquement pour anon et authenticated, aucun autre rôle.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_modes')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_modes introuvable — migration LOT 2B.1 annulée. Prérequis : LOT 2A.4 doit déjà être installé.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_restaurant_public_delivery_info'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_restaurant_public_delivery_info existe déjà — migration LOT 2B.1 annulée pour éviter une double application.';
  end if;
end $$;

begin;

create function public.get_restaurant_public_delivery_info(p_restaurant_id uuid)
returns table (
  delivery_zone_prefixes text[],
  delivery_min_items     integer,
  delivery_area_label    text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(
      (select array_agg(p)
       from jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p),
      array[]::text[]
    ) as delivery_zone_prefixes,
    coalesce((rsm.config->>'delivery_min_items')::integer, 0)
      as delivery_min_items,
    rsm.config->>'delivery_area_label'
      as delivery_area_label
  from public.restaurant_sale_modes rsm
  join public.restaurants r on r.id = rsm.restaurant_id
  where rsm.restaurant_id = p_restaurant_id
    and rsm.mode_code = 'delivery'
    and rsm.enabled = true
    and r.is_active = true
    and r.status = 'active';
$$;

comment on function public.get_restaurant_public_delivery_info(uuid) is
  'LOT 2B.1 -- projection publique minimale des informations de livraison (zones, minimum, libellé de zone) nécessaires au checkout public. N''expose jamais provider ni config JSONB brut. delivery_zone_prefixes n''est jamais NULL (toujours un tableau, potentiellement vide). Aucun helper interne : lecture directe en une seule requête, filtrée par établissement actif + mode delivery activé.';

-- REVOKE explicite AVANT tout GRANT -- jamais l'inverse (même
-- discipline que LOT 2A.4). Les rôles applicatifs sont révoqués
-- explicitement afin de neutraliser aussi les ALTER DEFAULT PRIVILEGES
-- Supabase éventuels : PUBLIC seul ne retire pas un grant direct.
revoke all on function public.get_restaurant_public_delivery_info(uuid) from public;
revoke all on function public.get_restaurant_public_delivery_info(uuid) from anon, authenticated, service_role;
grant execute on function public.get_restaurant_public_delivery_info(uuid) to anon, authenticated;

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT (preuve automatisée réelle dans
-- supabase/tests/v84-lot2b1-check.sh) :
--  ✓ actif + delivery activé -> 3 champs retournés, aucun NULL sur
--    delivery_zone_prefixes
--  ✗ delivery désactivé (enabled=false) -> aucune ligne
--  ✗ delivery absent de restaurant_sale_modes -> aucune ligne
--  ✗ onboarding + delivery activé -> aucune ligne
--  ✗ suspendu + delivery activé -> aucune ligne
--  ✗ inactif + delivery activé -> aucune ligne
--  ✓ clé delivery_zone_prefixes absente du config -> []
--  ✓ tableau delivery_zone_prefixes vide -> []
--  ✓ config NULL -> []
--  ✓ has_function_privilege(anon, ..., 'EXECUTE') = true
--  ✓ has_function_privilege(authenticated, ..., 'EXECUTE') = true
--  ✗ has_function_privilege(public, ..., 'EXECUTE') = false
--  ✗ le type retourné n'expose jamais provider ni config
-- ============================================================
