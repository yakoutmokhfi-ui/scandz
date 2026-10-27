-- ============================================================
-- Scanym — STOREFRONT PHOTO OVERLAY CONFIGURATION v1
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Rollback : DRAFT-lot-storefront-photo-overlay-v1-rollback.sql
-- Donnée Au Lait Cru : DRAFT-data-storefront-photo-overlay-au-lait-cru.sql
--                      (SÉPARÉE, NON incluse ici, GO distinct).
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--
-- A. UNE colonne : restaurant_configs.storefront_photo_overlay
--    (text NOT NULL, CHECK in ('none','light','standard')).
--      * TOUTES les lignes EXISTANTES reçoivent 'standard' = le voile
--        historique de la vitrine : aucun marchand existant ne change
--        d'apparence tant qu'il ne choisit pas lui-même.
--      * Le DÉFAUT de la colonne est ensuite basculé sur 'none' : toute
--        NOUVELLE ligne (create_establishment n'écrit pas cette colonne)
--        reçoit 'none'.
--    Le réglage est porté PAR LIGNE (par restaurant_id), sous la même
--    RLS et la même lecture publique (`restaurant_configs ( * )`) que
--    les autres réglages de vitrine : aucune fuite entre marchands.
--
-- B. UN RPC d'écriture : update_restaurant_photo_overlay(uuid, text).
--    Même autorité que update_restaurant_bg_color / _colors :
--    assert_restaurant_asset_role (owner/manager du restaurant OU
--    opérateur Scanym). Jeu fermé strict, aucune normalisation
--    silencieuse (espace, casse -> refus).
--
-- CE QUE CE LOT NE FAIT PAS :
--   - aucune nouvelle table, aucune policy RLS, aucun GRANT sur
--     restaurant_configs, aucune modification de create_establishment,
--     du checkout, du paiement, de la livraison, du suivi ;
--   - ne modifie AUCUN autre réglage de personnalisation ;
--   - ne nomme aucun marchand (la valeur Au Lait Cru est un script de
--     donnée séparé) ;
--   - ne stocke ni CSS, ni HTML, ni URL : un mot d'un jeu de trois.
--
-- ORDRE DE DÉPLOIEMENT SÛR : le code de l'application tolère l'absence
-- de la colonne (valeur absente => 'standard' = rendu historique ; la
-- section Réglages se désactive sans rien écrire). Le SQL peut donc être
-- appliqué avant OU après le déploiement du code.
--
-- ATOMICITÉ : UNE seule transaction, pré-vol et post-vol DEDANS,
-- `commit;` en dernière instruction exécutable.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL ANTI-DÉRIVE.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.restaurant_configs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs absente -- annulé.';
  end if;

  if to_regprocedure('public.assert_restaurant_asset_role(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_restaurant_asset_role(uuid) absente -- annulé.';
  end if;

  -- Anti-double-application.
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'storefront_photo_overlay' and not a.attisdropped
  )
  or to_regprocedure('public.update_restaurant_photo_overlay(uuid,text)') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: STOREFRONT PHOTO OVERLAY v1 déjà (partiellement) appliqué -- annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Colonne. `add column ... not null default 'standard'` renseigne
--    TOUTES les lignes existantes avec 'standard' (sans réécriture de
--    table : la valeur par défaut constante est mémorisée par le
--    catalogue). Le défaut est ensuite basculé sur 'none' : il ne
--    s'applique qu'aux lignes insérées APRÈS ce lot ; les lignes
--    existantes gardent 'standard'.
-- ------------------------------------------------------------
alter table public.restaurant_configs
  add column storefront_photo_overlay text not null default 'standard';

alter table public.restaurant_configs
  add constraint restaurant_configs_storefront_photo_overlay_check
  check (storefront_photo_overlay in ('none', 'light', 'standard'));

alter table public.restaurant_configs
  alter column storefront_photo_overlay set default 'none';

comment on column public.restaurant_configs.storefront_photo_overlay is
  'Voile sombre de la photo principale de la vitrine : none (aucun) | light (léger) | standard (voile historique). Lignes existantes à la pose du lot : standard. Nouvelles lignes : none.';

-- ------------------------------------------------------------
-- 2. RPC d'écriture.
-- ------------------------------------------------------------
create function public.update_restaurant_photo_overlay(
  p_restaurant_id uuid,
  p_overlay       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Même autorité que update_restaurant_bg_color / _colors :
  -- owner/manager OU opérateur Scanym. Jamais un contrôle réinventé.
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  -- Jeu fermé STRICT : la chaîne brute est validée, jamais nettoyée
  -- silencieusement (' none', 'None', 'NONE' sont refusés).
  if p_overlay is null or p_overlay not in ('none', 'light', 'standard') then
    raise exception using errcode = '22023',
      message = 'Invalid storefront photo overlay: expected none, light or standard';
  end if;

  update public.restaurant_configs
  set storefront_photo_overlay = p_overlay
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_photo_overlay(uuid, text) from public, anon;
grant execute on function public.update_restaurant_photo_overlay(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. POST-VOL (dans la transaction : toute anomalie annule tout).
-- ------------------------------------------------------------
do $$
declare
  v_def   text;
  v_null  boolean;
  v_type  text;
  v_bad   bigint;
begin
  select a.attnotnull, format_type(a.atttypid, a.atttypmod),
         pg_get_expr(d.adbin, d.adrelid)
    into v_null, v_type, v_def
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relname = 'restaurant_configs'
    and a.attname = 'storefront_photo_overlay' and not a.attisdropped;

  if v_null is distinct from true or v_type <> 'text' or v_def not like '''none''%' then
    raise exception 'SCANYM_POSTFLIGHT: colonne attendue text NOT NULL DEFAULT ''none'', trouvé (not null=%, type=%, défaut=%).', v_null, v_type, v_def;
  end if;

  -- Aucune ligne existante ne doit avoir changé d'apparence : toutes
  -- doivent être à 'standard' à la pose du lot.
  select count(*) into v_bad from public.restaurant_configs
  where storefront_photo_overlay <> 'standard';
  if v_bad <> 0 then
    raise exception 'SCANYM_POSTFLIGHT: % ligne(s) existante(s) ne valent pas ''standard'' -- annulé.', v_bad;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.restaurant_configs'::regclass
      and conname = 'restaurant_configs_storefront_photo_overlay_check' and contype = 'c' and convalidated
  ) then
    raise exception 'SCANYM_POSTFLIGHT: contrainte CHECK absente ou non validée -- annulé.';
  end if;

  if has_function_privilege('anon', 'public.update_restaurant_photo_overlay(uuid,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.update_restaurant_photo_overlay(uuid,text)', 'execute') then
    raise exception 'SCANYM_POSTFLIGHT: ACL du RPC incorrecte (anon doit être refusé, authenticated autorisé) -- annulé.';
  end if;
end $$;

commit;
