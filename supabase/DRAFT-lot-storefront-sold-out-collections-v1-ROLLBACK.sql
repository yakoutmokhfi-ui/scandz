-- ============================================================
-- Scanym — STOREFRONT SOLD-OUT COLLECTIONS v1 — ROLLBACK (issue #200)
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Restaure la définition ORIGINALE de get_restaurant_collections(uuid)
-- (lot COLLECTIONS / TAGS FOUNDATION v1, copie à l'identique) : les
-- produits indisponibles sont de nouveau exclus des collections et des
-- tags, quel que soit le réglage. Aucune donnée touchée ; droits inchangés.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.get_restaurant_collections(uuid)') is null
     or pg_get_functiondef('public.get_restaurant_collections(uuid)'::regprocedure) not like '%show_unavailable_products%' then
    raise exception 'SCANYM_ROLLBACK_DRIFT: STOREFRONT SOLD-OUT COLLECTIONS v1 absent -- rien à annuler. Annulé.';
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
    and mi.is_available = true
  group by t.id, t.name, t.display_order
  order by t.display_order, t.name;
end $$;

do $$
begin
  if pg_get_functiondef('public.get_restaurant_collections(uuid)'::regprocedure) like '%show_unavailable_products%' then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: définition non restaurée -- annulé.';
  end if;
  if not has_function_privilege('anon', 'public.get_restaurant_collections(uuid)', 'execute') then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: droit anon perdu -- annulé.';
  end if;
end $$;

commit;
