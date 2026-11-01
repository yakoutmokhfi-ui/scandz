-- ============================================================
-- Scanym — STOREFRONT SOLD-OUT COLLECTIONS v1 — ROLLBACK (issue #200)
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Garde anti-écrasement : refuse si la fonction en place n'est pas EXACTEMENT celle de
-- ce lot (SCANYM_ROLLBACK_DRIFT). Restaure la définition ORIGINALE de get_restaurant_collections(uuid)
-- (lot COLLECTIONS / TAGS FOUNDATION v1, copie à l'identique) : les
-- produits indisponibles sont de nouveau exclus des collections et des
-- tags, quel que soit le réglage. Aucune donnée touchée ; droits inchangés.
-- ============================================================

begin;

do $$
declare
  v_oid  oid;
  v_md5  text;
begin
  v_oid := to_regprocedure('public.get_restaurant_collections(uuid)');
  if v_oid is null then
    raise exception 'SCANYM_ROLLBACK_DRIFT: get_restaurant_collections(uuid) absente -- rien à annuler. Annulé.';
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p where p.oid = v_oid;
  if v_md5 = '62469954066d750857dc0153534be55d' then
    raise exception 'SCANYM_ROLLBACK_DRIFT: définition déjà celle d''origine -- rien à annuler. Annulé.';
  end if;
  -- GARDE ANTI-ÉCRASEMENT (audit TURING, P2) : on ne restaure l'original que
  -- si la fonction en place est EXACTEMENT celle posée par ce lot. Toute
  -- modification ultérieure (restriction de publication, autre version) est
  -- refusée au lieu d'être écrasée silencieusement.
  if v_md5 is distinct from '364c52f3d561593421b2e6deb034069d' then
    raise exception 'SCANYM_ROLLBACK_DRIFT: get_restaurant_collections(uuid) a été modifiée depuis le lot (md5 %) -- annulé, rien n''est écrasé.', v_md5;
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
  if (select md5(p.prosrc) from pg_proc p where p.oid = 'public.get_restaurant_collections(uuid)'::regprocedure) is distinct from '62469954066d750857dc0153534be55d' then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: définition d''origine non restaurée -- annulé.';
  end if;
  if not has_function_privilege('anon', 'public.get_restaurant_collections(uuid)', 'execute') then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: droit anon perdu -- annulé.';
  end if;
end $$;

commit;
