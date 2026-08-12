-- ============================================================
-- Scanym V67b — Description longue de catégorie, ordre produit,
-- correctifs création photo/placeholder (partie SQL)
--
-- À exécuter APRÈS migration-v67-product-photos.sql.
--
-- Contenu :
--   1. Contrôle préalable de non-dérive du schéma (RÉELLEMENT
--      EXÉCUTÉ), sur le modèle V65/V66/V67 — vérifie les signatures
--      exactes attendues avant toute modification.
--   2. Transaction unique :
--      a. menu_categories.description (colonne additive) + contrainte
--         CHECK de longueur (≤500, même patron que V66 pour les
--         descriptions produit) — défense en profondeur dès l'ajout,
--         pas seulement validation RPC.
--      b. update_category : suppression de la signature exacte à 3
--         paramètres, recréation à 4 paramètres
--         (p_description ajouté). create_category reste INCHANGÉE
--         (3 paramètres) : une catégorie se crée toujours sans
--         description, la description s'ajoute ensuite via
--         update_category — évite d'élargir la surface de la RPC de
--         création pour un besoin qui n'existe qu'à l'édition.
--      c. get_merchant_catalogue : suppression + recréation (le type
--         de retour change encore : + category_description).
--      d. Nouvelle RPC set_product_order — même patron que
--         set_product_availability/set_product_photo (fonction
--         dédiée à un seul effet, owner/manager uniquement, jamais
--         staff : c'est une décision de merchandising, pas un geste
--         opérationnel comme signaler une rupture).
--      e. Tri secondaire déterministe sur le nom de catégorie dans
--         get_merchant_catalogue, en cas d'égalité de display_order
--         (le tri produit avait déjà ce filet depuis V66/V67 ; la
--         catégorie ne l'avait pas).
--
-- IMPORTANT — pourquoi drop function ici (déjà expliqué en V66/V67,
-- rappelé) : update_category et get_merchant_catalogue changent tous
-- les deux de signature/type de retour réels. `create or replace`
-- avec un paramètre en plus crée une signature DISTINCTE (laisse les
-- deux versions actives) ; `create or replace` ne peut JAMAIS changer
-- le type de retour d'une fonction existante. Un `drop function`
-- ciblant la signature EXACTE, confirmée par le contrôle préalable,
-- suivi d'une recréation immédiate dans la même transaction, est donc
-- nécessaire — jamais `cascade`.
--
-- Trim explicite partout où ce fichier normalise du texte :
-- btrim(..., E' \t\n\r\f' || chr(11)) — jamais E'\v' (piège V65,
-- vérifié empiriquement : ascii(E'\v') = 118, code de la lettre "v").
-- ============================================================


-- ------------------------------------------------------------------
-- 1. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA — RÉELLEMENT EXÉCUTÉ.
-- ------------------------------------------------------------------

do $$
declare
  v_count integer;
begin
  -- 1a. Signature exacte attendue de update_category (V66, 3 params)
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_category'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte update_category(uuid,text,integer) introuvable — migration V67b annulée, aucune modification appliquée.';
  end if;

  -- 1b. Signature exacte attendue de get_merchant_catalogue (V67, avec image_url)
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
      and pg_get_function_result(p.oid) like '%image_url text%'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature/type de retour attendu de get_merchant_catalogue (V67, avec image_url) introuvable — migration V67b annulée.';
  end if;

  -- 1c. Aucune surcharge inattendue
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('update_category', 'get_merchant_catalogue', 'create_category', 'assert_category_role', 'assert_product_role');
  if v_count <> 5 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: % fonctions trouvées pour update_category/get_merchant_catalogue/create_category/assert_category_role/assert_product_role, 5 attendues — migration V67b annulée.',
      v_count;
  end if;

  -- 1d. Aucune colonne description sur menu_categories (pas de doublon)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'description'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_categories.description existe déjà — migration V67b annulée (vérifier avant de relancer si c''est attendu).';
  end if;

  -- 1e. Aucune RPC set_product_order déjà présente (pas de doublon)
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_product_order'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: set_product_order existe déjà — migration V67b annulée.';
  end if;
end $$;


-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- 2a. Colonne additive : description longue de catégorie.
alter table public.menu_categories
  add column if not exists description text;

alter table public.menu_categories
  add constraint menu_categories_description_length_chk
  check (description is null or char_length(description) <= 500);

-- 2b. update_category — suppression de la signature exacte à 3
-- paramètres, recréation à 4 (p_description ajouté). Ne touche
-- jamais is_active (règle V66 inchangée).
drop function if exists public.update_category(uuid, text, integer);

create function public.update_category(
  p_category_id   uuid,
  p_name          text,
  p_display_order integer,
  p_description   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_description text;
begin
  perform public.assert_category_role(p_category_id, array['owner','manager']);

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;
  if p_display_order is null then
    raise exception using errcode = '22023', message = 'Display order is required';
  end if;

  -- Description longue (V67b) : rejet explicite au-delà de 500
  -- caractères, jamais de troncature silencieuse (même patron que
  -- les descriptions produit en V66).
  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception 'SCANYM_CATEGORY_DESCRIPTION_TOO_LONG' using errcode = '22001';
  end if;

  begin
    update public.menu_categories
    set name = v_name, display_order = p_display_order, description = v_description
    where id = p_category_id;
  exception when unique_violation then
    raise exception 'SCANYM_CATEGORY_DUPLICATE_NAME' using errcode = '23505';
  end;

  if not found then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;
end $$;

revoke all on function public.update_category(uuid, text, integer, text) from public, anon;
grant execute on function public.update_category(uuid, text, integer, text) to authenticated;

-- 2c. get_merchant_catalogue — suppression + recréation (nouveau
-- type de retour : + category_description). Corps V67 repris à
-- l'identique, hors les 2 ajouts explicitement listés dans le résumé
-- de fin de fichier.
drop function if exists public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id                 uuid,
  category_id                uuid,
  category_name               text,
  category_translations       jsonb,
  category_display_order      integer,
  category_is_option_source   boolean,
  category_description        text,
  name                        text,
  short_description            text,
  description                  text,
  translations                 jsonb,
  price                        numeric,
  is_available                 boolean,
  archived_at                  timestamptz,
  display_order                integer,
  is_option_source             boolean,
  image_url                    text
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
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description,
         mi.name::text, mi.short_description, mi.description, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         ),
         mi.image_url
  from public.menu_categories mc
  left join public.menu_items mi
    on mi.category_id = mc.id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name, mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- 2d. set_product_order — nouvelle RPC dédiée (même patron que
-- set_product_availability/set_product_photo). owner/manager
-- uniquement : réordonner le catalogue est une décision de
-- merchandising, pas un geste opérationnel ouvert à staff (à la
-- différence de signaler une rupture de stock). Ne peut jamais
-- modifier un produit d'un autre restaurant : assert_product_role
-- vérifie déjà l'appartenance, comme pour update_product/
-- set_product_availability/set_product_photo.
create function public.set_product_order(
  p_product_id    uuid,
  p_display_order integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  if p_display_order is null then
    raise exception using errcode = '22023', message = 'Display order is required';
  end if;

  update public.menu_items
  set display_order = p_display_order
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

revoke all on function public.set_product_order(uuid, integer) from public, anon;
grant execute on function public.set_product_order(uuid, integer) to authenticated;

commit;

-- ============================================================
-- Résumé des changements par rapport à l'état V67 :
--   + menu_categories.description (colonne additive)
--   + contrainte menu_categories_description_length_chk (≤500)
--   ~ update_category : drop + recréation à 4 paramètres
--     (p_description ajouté), signature exacte à 3 paramètres
--     supprimée après confirmation par le contrôle préalable
--   ~ get_merchant_catalogue : drop + recréation, + category_description
--     dans le type de retour, + tri secondaire par nom de catégorie
--   + set_product_order (nouvelle RPC, owner/manager uniquement)
-- create_category INCHANGÉE (toujours 3 paramètres, is_active=true
-- imposé) : une catégorie se crée sans description, ajoutée ensuite.
-- Aucune fonction d'options, de commande, ou de photo existante
-- modifiée.
-- ============================================================
