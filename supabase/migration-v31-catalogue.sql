-- ============================================================
-- Scanym V31 — Gestion du catalogue par le commerçant
--
-- ⚠️ MODIFICATION DE SCHÉMA — validation CTO obtenue.
-- Additive et idempotente : ré-exécutable sans effet de bord.
--
-- Principe de sécurité : le navigateur n'obtient AUCUN droit
-- d'UPDATE générique sur menu_items. Toute modification passe par
-- une fonction dédiée qui vérifie l'identité, le rattachement à
-- l'établissement et le rôle, et n'écrit que les colonnes prévues.
--
-- Matrice des rôles (validée) :
--   action                      owner  manager  staff
--   disponibilité                oui     oui     oui
--   prix / libellés              oui     oui     non
--   création / archivage         oui     oui     non
-- ============================================================

-- ------------------------------------------------------------
-- 1. Archivage
--
-- Trois états distincts, et aucune suppression définitive :
--   archived_at null + is_available true  → au menu
--   archived_at null + is_available false → rupture temporaire
--   archived_at renseigné                 → retiré de la carte,
--                                            récupérable
-- ------------------------------------------------------------
alter table public.menu_items
  add column if not exists archived_at timestamptz;

create index if not exists idx_menu_items_active
  on public.menu_items(category_id)
  where archived_at is null;

-- ------------------------------------------------------------
-- 2. Retrait de l'écriture directe
--
-- La politique d'UPDATE ouverte aux gérants est remplacée par les
-- fonctions ci-dessous : plus aucun chemin d'écriture directe.
-- ------------------------------------------------------------
drop policy if exists "gerant modifie ses produits" on public.menu_items;
revoke insert, update, delete on table public.menu_items from authenticated;
revoke insert, update, delete on table public.menu_items from anon;

-- ------------------------------------------------------------
-- 3. Contrôle d'accès commun
--
-- Résout l'établissement propriétaire d'un produit et vérifie que
-- l'utilisateur connecté y détient l'un des rôles attendus.
-- ------------------------------------------------------------
create or replace function public.assert_product_role(
  p_product_id uuid,
  p_roles      text[]
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_product_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (p_roles)
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this product';
  end if;

  return v_restaurant_id;
end $$;

-- ------------------------------------------------------------
-- 4. Disponibilité — geste opérationnel, ouvert au personnel
-- ------------------------------------------------------------
create or replace function public.set_product_availability(
  p_product_id   uuid,
  p_is_available boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_product_role(
    p_product_id, array['owner','manager','staff']
  );

  update public.menu_items
  set is_available = coalesce(p_is_available, true)
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

-- ------------------------------------------------------------
-- 5. Libellés et prix — données commerciales, gérants seulement
-- ------------------------------------------------------------
create or replace function public.update_product(
  p_product_id  uuid,
  p_name        text,
  p_description text,
  p_price       numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(trim(p_name)) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;
  if p_description is not null and length(p_description) > 500 then
    raise exception using errcode = '22023', message = 'Description too long';
  end if;
  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  update public.menu_items
  set name        = trim(p_name),
      description = nullif(trim(coalesce(p_description, '')), ''),
      price       = round(p_price, 2)
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. Création
-- ------------------------------------------------------------
create or replace function public.create_product(
  p_category_id uuid,
  p_name        text,
  p_description text,
  p_price       numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_order integer;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_categories mc where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  insert into public.menu_items
    (category_id, name, description, price, display_order, is_available)
  values (
    p_category_id, trim(p_name),
    nullif(trim(coalesce(p_description, '')), ''),
    round(p_price, 2), v_order, true
  )
  returning id into v_id;

  return v_id;
end $$;

-- ------------------------------------------------------------
-- 7. Archivage et restauration — jamais de suppression
-- ------------------------------------------------------------
create or replace function public.archive_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  -- Un produit servant de source d'options (goûts, pâtisseries) ne
  -- peut pas être archivé isolément sans casser le produit parent.
  if exists (
    select 1 from public.menu_items parent
    join public.menu_items child on child.category_id = parent.option_source_category_id
    where child.id = p_product_id
      and parent.archived_at is null
  ) then
    raise exception using errcode = '23503',
      message = 'This product is used as an option and cannot be archived';
  end if;

  update public.menu_items
  set archived_at = now(), is_available = false
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or already archived';
  end if;
end $$;

create or replace function public.restore_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  update public.menu_items
  set archived_at = null, is_available = true
  where id = p_product_id and archived_at is not null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or not archived';
  end if;
end $$;

-- ------------------------------------------------------------
-- 8. Lecture du catalogue par le commerçant
--
-- Les produits archivés ne sont pas lisibles publiquement : cette
-- fonction les expose au seul personnel rattaché.
-- ------------------------------------------------------------
create or replace function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id    uuid,
  category_id   uuid,
  category_name text,
  name          text,
  description   text,
  price         numeric,
  is_available  boolean,
  archived_at   timestamptz,
  display_order integer,
  is_option_source boolean
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
  select mi.id, mc.id, mc.name::text, mi.name::text, mi.description,
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

-- ------------------------------------------------------------
-- 9. Droits d'exécution
-- ------------------------------------------------------------
revoke all on function public.assert_product_role(uuid, text[]) from public;
revoke all on function public.set_product_availability(uuid, boolean) from public, anon;
revoke all on function public.update_product(uuid, text, text, numeric) from public, anon;
revoke all on function public.create_product(uuid, text, text, numeric) from public, anon;
revoke all on function public.archive_product(uuid) from public, anon;
revoke all on function public.restore_product(uuid) from public, anon;
revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;

grant execute on function public.set_product_availability(uuid, boolean) to authenticated;
grant execute on function public.update_product(uuid, text, text, numeric) to authenticated;
grant execute on function public.create_product(uuid, text, text, numeric) to authenticated;
grant execute on function public.archive_product(uuid) to authenticated;
grant execute on function public.restore_product(uuid) to authenticated;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- ============================================================
-- TESTS EXÉCUTÉS — PostgreSQL 16, chaîne migratoire complète
--
-- MATRICE DES RÔLES
--  ✓ staff bascule la disponibilité
--  ✗ staff modifie le prix               → Not authorized
--  ✗ staff archive                       → Not authorized
--  ✓ owner modifie prix et libellés
--  ✓ owner archive puis restaure
--
-- VALIDATION DES ENTRÉES
--  ✗ prix négatif                        → Invalid price
--  ✗ nom vide                            → Name is required
--
-- CLOISONNEMENT
--  ✗ owner Illico modifie un produit Sanaa   → Not authorized
--  ✗ owner Illico bascule un produit Sanaa   → Not authorized
--  ✗ owner Illico lit le catalogue Sanaa     → Not authorized
--  ✓ owner Illico lit ses 36 produits
--
-- INTÉGRITÉ
--  ✗ archiver un produit servant d'option    → refusé
--  ✓ archivage : 36 → 35 actifs, 1 archivé
--
-- ANONYME
--  ✗ appel des fonctions                 → permission denied
--  ✗ UPDATE direct sur menu_items        → permission denied
--
-- EFFET SUR LE MENU PUBLIC
--  ✓ produit épuisé  → invisible côté client
--  ✓ produit archivé → invisible côté client
--  ✗ commander un produit archivé        → refusé par create_order
--
-- IDEMPOTENCE
--  ✓ migration rejouée deux fois : 0 erreur
-- ============================================================
