-- ============================================================
-- Scanym — STOREFRONT SOLD-OUT VISIBILITY v1 — ROLLBACK (issue #200)
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Annule DRAFT-lot-storefront-sold-out-visibility-v1.sql : supprime le
-- RPC et la colonne. PERTE ASSUMÉE : le choix de chaque marchand est
-- perdu ; la vitrine retombe, partout, sur le comportement historique
-- (produits indisponibles masqués ; le code traite l'absence de la
-- colonne comme false). Aucun autre objet n'est touché.
--
-- Contrôle préalable (lecture seule, à exécuter avant) :
--   select restaurant_id from public.restaurant_configs
--   where show_unavailable_products;   -- marchands qui perdraient leur choix
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
      and a.attname = 'show_unavailable_products' and not a.attisdropped
  ) or to_regprocedure('public.update_restaurant_show_unavailable(uuid,boolean)') is null then
    raise exception 'SCANYM_ROLLBACK_DRIFT: STOREFRONT SOLD-OUT VISIBILITY v1 absent ou incomplet -- rien à annuler automatiquement. Annulé.';
  end if;
end $$;

drop function public.update_restaurant_show_unavailable(uuid, boolean);

alter table public.restaurant_configs
  drop column show_unavailable_products;

do $$
begin
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'show_unavailable_products' and not a.attisdropped
  ) or to_regprocedure('public.update_restaurant_show_unavailable(uuid,boolean)') is not null then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: objets encore présents -- annulé.';
  end if;
end $$;

commit;
