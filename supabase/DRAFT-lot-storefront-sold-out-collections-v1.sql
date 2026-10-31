-- ============================================================
-- Scanym — STOREFRONT SOLD-OUT COLLECTIONS v1 (issue #200, correction)
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Rollback : DRAFT-lot-storefront-sold-out-collections-v1-ROLLBACK.sql
-- Harnais  : supabase/tests/storefront-sold-out-collections-v1-check.sh
--
-- PROBLÈME CORRIGÉ : get_restaurant_collections (contrat de lecture
-- CLIENT des tags/collections) exclut `is_available = false`. Un produit
-- « En rupture » affiché par choix du commerçant (lot STOREFRONT
-- SOLD-OUT VISIBILITY v1) perdait donc ses tags ET ses collections --
-- et, comme les traductions publiques de tags (PR #202) sont dérivées de
-- cette même fonction, les traductions d'un tag porté seulement par des
-- produits en rupture disparaissaient aussi.
--
-- CE QUE CE LOT FAIT (et rien d'autre) :
--   Redéfinit get_restaurant_collections(uuid) -- MÊME signature, MÊME
--   type de retour, MÊMES droits -- avec UNE seule différence : un
--   produit indisponible reste inclus SI ET SEULEMENT SI la ligne
--   restaurant_configs de CET établissement a show_unavailable_products
--   = true. Tout le reste est identique : établissement actif ET publié,
--   tag actif ET visible, catégorie active, produit NON ARCHIVÉ (un
--   archivé reste exclu), isolation par p_restaurant_id.
--   Réglage false / ligne absente => résultat IDENTIQUE à aujourd'hui.
--
-- CE QUE CE LOT NE FAIT PAS : aucune table, colonne, donnée ni droit
-- modifiés ; create_order intact (une rupture reste NON commandable :
-- le serveur exige is_available = true).
--
-- PRÉREQUIS (pré-vol, sinon annulé) :
--   * get_restaurant_collections(uuid) existe (lot COLLECTIONS / TAGS) ;
--   * restaurant_configs.show_unavailable_products existe (lot STOREFRONT
--     SOLD-OUT VISIBILITY v1).
-- ORDRE : après ces deux lots. Appliqué avant eux, il est refusé.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.get_restaurant_collections(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_restaurant_collections(uuid) absente (lot COLLECTIONS / TAGS requis) -- annulé.';
  end if;
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'show_unavailable_products' and not a.attisdropped
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.show_unavailable_products absente (lot SOLD-OUT VISIBILITY v1 requis) -- annulé.';
  end if;
  if pg_get_functiondef('public.get_restaurant_collections(uuid)'::regprocedure) like '%show_unavailable_products%' then
    raise exception 'SCANYM_ALREADY_APPLIED: STOREFRONT SOLD-OUT COLLECTIONS v1 déjà appliqué -- annulé.';
  end if;
end $$;

create or replace function public.get_restaurant_collections(p_restaurant_id uuid)
returns table (
  id            uuid,
  label         text,
  display_order integer,
  menu_item_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.restaurants r
    where r.id = p_restaurant_id
      and r.is_active = true
      and r.status = 'active'
  ) then
    return;
  end if;

  return query
  select t.id,
         t.name,
         t.display_order,
         array_agg(mi.id order by mi.display_order, mi.name)
  from public.menu_tags t
  join public.menu_item_tags mit on mit.tag_id = t.id
  join public.menu_items mi on mi.id = mit.menu_item_id
  join public.menu_categories mc on mc.id = mi.category_id
  where t.restaurant_id = p_restaurant_id
    and t.is_active = true
    and t.visible_on_customer_menu = true
    and mc.restaurant_id = p_restaurant_id
    and mc.is_active = true
    and mi.archived_at is null
    and (
      mi.is_available = true
      or coalesce((
        select rc.show_unavailable_products
        from public.restaurant_configs rc
        where rc.restaurant_id = p_restaurant_id
      ), false)
    )
  group by t.id, t.name, t.display_order
  order by t.display_order, t.name;
end $$;

do $$
begin
  if pg_get_functiondef('public.get_restaurant_collections(uuid)'::regprocedure) not like '%show_unavailable_products%' then
    raise exception 'SCANYM_POSTFLIGHT: définition non remplacée -- annulé.';
  end if;
  if not has_function_privilege('anon', 'public.get_restaurant_collections(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_restaurant_collections(uuid)', 'execute') then
    raise exception 'SCANYM_POSTFLIGHT: droits anon/authenticated perdus -- annulé.';
  end if;
end $$;

commit;
