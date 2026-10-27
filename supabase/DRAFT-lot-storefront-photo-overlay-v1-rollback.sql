-- ============================================================
-- Scanym — STOREFRONT PHOTO OVERLAY CONFIGURATION v1 — ROLLBACK
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Annule DRAFT-lot-storefront-photo-overlay-v1.sql : supprime le RPC,
-- la contrainte et la colonne. PERTE ASSUMÉE : le choix de voile de
-- chaque marchand est perdu ; la vitrine retombe, partout, sur le voile
-- historique (le code de l'application traite l'absence de la colonne
-- comme 'standard'). Aucun autre objet n'est touché.
--
-- Une seule transaction, garde-fou de dérive, `commit;` final.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.restaurant_configs') is null then
    raise exception 'SCANYM_ROLLBACK_DRIFT: restaurant_configs absente -- annulé.';
  end if;
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'storefront_photo_overlay' and not a.attisdropped
  ) or to_regprocedure('public.update_restaurant_photo_overlay(uuid,text)') is null then
    raise exception 'SCANYM_ROLLBACK_DRIFT: STOREFRONT PHOTO OVERLAY v1 absent ou incomplet -- rien à annuler automatiquement. Annulé.';
  end if;
end $$;

drop function public.update_restaurant_photo_overlay(uuid, text);

alter table public.restaurant_configs
  drop constraint restaurant_configs_storefront_photo_overlay_check;

alter table public.restaurant_configs
  drop column storefront_photo_overlay;

do $$
begin
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'storefront_photo_overlay' and not a.attisdropped
  ) or to_regprocedure('public.update_restaurant_photo_overlay(uuid,text)') is not null then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: objets encore présents -- annulé.';
  end if;
end $$;

commit;
