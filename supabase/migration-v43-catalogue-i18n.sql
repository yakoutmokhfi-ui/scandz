-- ============================================================
-- Scanym V43 — Traductions dans le catalogue commerçant
--
-- Additive et idempotente. Aucune table modifiée : seule la
-- fonction de lecture est remplacée.
--
-- Motif : « Ma carte » affichait les noms et descriptions dans
-- leur langue de base (français), même pour un gérant travaillant
-- en arabe. La fonction renvoie désormais aussi les traductions,
-- que l'interface applique selon la langue du gérant.
--
-- La langue de base reste la valeur modifiable : c'est elle que
-- le gérant édite, et elle sert de repli quand une traduction
-- manque.
-- ============================================================

drop function if exists public.get_merchant_catalogue(uuid, boolean);

create or replace function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id           uuid,
  category_id          uuid,
  category_name        text,
  category_translations jsonb,
  name                 text,
  description          text,
  translations         jsonb,
  price                numeric,
  is_available         boolean,
  archived_at          timestamptz,
  display_order        integer,
  is_option_source     boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  select mi.id, mc.id, mc.name::text, mc.translations,
         mi.name::text, mi.description, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         exists (
           select 1 from public.menu_items parent
           where parent.option_source_category_id = mc.id
             and parent.archived_at is null
         )
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mc.restaurant_id = p_restaurant_id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  order by mc.display_order, mi.display_order, mi.name;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;
