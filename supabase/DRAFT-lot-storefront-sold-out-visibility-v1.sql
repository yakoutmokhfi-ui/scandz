-- ============================================================
-- Scanym — STOREFRONT SOLD-OUT VISIBILITY v1 (issue #200)
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Rollback : DRAFT-lot-storefront-sold-out-visibility-v1-ROLLBACK.sql
-- Harnais  : supabase/tests/storefront-sold-out-visibility-v1-check.sh
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--
-- A. UNE colonne : restaurant_configs.show_unavailable_products
--    (boolean NOT NULL DEFAULT false).
--      * TOUTES les lignes EXISTANTES et toutes les NOUVELLES lignes
--        reçoivent false = comportement actuel : les produits
--        indisponibles restent masqués de la vitrine. Aucun marchand
--        ne change tant qu'il ne coche pas lui-même l'option.
--    Le réglage est porté PAR LIGNE (par restaurant_id), sous la même
--    RLS et la même lecture publique (`restaurant_configs ( * )`) que
--    les autres réglages de vitrine : aucune fuite entre marchands.
--
-- B. UN RPC d'écriture : update_restaurant_show_unavailable(uuid, boolean).
--    Même autorité que update_restaurant_photo_overlay :
--    assert_restaurant_asset_role (owner/manager du restaurant OU
--    opérateur Scanym). NULL refusé.
--
-- CE QUE CE LOT NE FAIT PAS :
--   - AUCUNE modification de create_order : le serveur refuse déjà tout
--     produit/option `is_available = false` (« Article indisponible ou
--     étranger à ce restaurant ») -- une commande forgée avec un produit
--     en rupture est donc rejetée, que le réglage soit actif ou non ;
--   - aucune nouvelle table, policy RLS ni GRANT sur restaurant_configs ;
--   - ne touche ni `is_available`, ni `archived_at`, ni aucune donnée
--     catalogue : un produit ARCHIVÉ reste exclu de la vitrine ;
--   - ne nomme aucun marchand.
--
-- ORDRE DE DÉPLOIEMENT SÛR : le code de l'application tolère l'absence
-- de la colonne (valeur absente => false = historique ; la section
-- Réglages se désactive sans rien écrire). Le SQL peut donc être appliqué
-- avant OU après le déploiement du code.
--
-- ATOMICITÉ : UNE seule transaction, pré-vol et post-vol DEDANS,
-- `commit;` en dernière instruction exécutable.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.restaurant_configs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs absente -- annulé.';
  end if;
  if to_regprocedure('public.assert_restaurant_asset_role(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_restaurant_asset_role(uuid) absente -- annulé.';
  end if;
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'show_unavailable_products' and not a.attisdropped
  )
  or to_regprocedure('public.update_restaurant_show_unavailable(uuid,boolean)') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: STOREFRONT SOLD-OUT VISIBILITY v1 déjà (partiellement) appliqué -- annulé.';
  end if;
end $$;

alter table public.restaurant_configs
  add column show_unavailable_products boolean not null default false;

comment on column public.restaurant_configs.show_unavailable_products is
  'true : les produits indisponibles (is_available=false, non archivés) restent visibles en vitrine avec la mention « En rupture », sans ajout au panier. false (défaut, comportement historique) : ils sont masqués. Les produits archivés ne sont jamais affichés.';

create function public.update_restaurant_show_unavailable(
  p_restaurant_id uuid,
  p_show          boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  if p_show is null then
    raise exception using errcode = '22023',
      message = 'Invalid show_unavailable_products: expected true or false';
  end if;

  update public.restaurant_configs
  set show_unavailable_products = p_show
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_show_unavailable(uuid, boolean) from public, anon;
grant execute on function public.update_restaurant_show_unavailable(uuid, boolean) to authenticated;

do $$
declare
  v_def  text;
  v_null boolean;
  v_type text;
  v_bad  bigint;
begin
  select a.attnotnull, format_type(a.atttypid, a.atttypmod),
         pg_get_expr(d.adbin, d.adrelid)
    into v_null, v_type, v_def
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relname = 'restaurant_configs'
    and a.attname = 'show_unavailable_products' and not a.attisdropped;

  if v_null is distinct from true or v_type <> 'boolean' or v_def is distinct from 'false' then
    raise exception 'SCANYM_POSTFLIGHT: colonne attendue boolean NOT NULL DEFAULT false, trouvé (not null=%, type=%, défaut=%).', v_null, v_type, v_def;
  end if;

  -- Aucun marchand existant ne doit avoir changé : toutes les lignes à false.
  select count(*) into v_bad from public.restaurant_configs
  where show_unavailable_products is distinct from false;
  if v_bad <> 0 then
    raise exception 'SCANYM_POSTFLIGHT: % ligne(s) existante(s) ne valent pas false -- annulé.', v_bad;
  end if;

  if has_function_privilege('anon', 'public.update_restaurant_show_unavailable(uuid,boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.update_restaurant_show_unavailable(uuid,boolean)', 'execute') then
    raise exception 'SCANYM_POSTFLIGHT: ACL du RPC incorrecte (anon doit être refusé, authenticated autorisé) -- annulé.';
  end if;
end $$;

commit;
