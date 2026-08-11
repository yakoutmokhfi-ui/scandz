-- ============================================================
-- Scanym V66 — Migration de retour arrière (rollback), dédiée et testée
--
-- À exécuter UNIQUEMENT sur une base ayant reçu
-- migration-v66-categories-descriptions.sql avec succès. Restaure
-- l'état RPC exact de V65 (signatures V31/V43 à 4 paramètres,
-- get_merchant_catalogue avec son type de retour d'origine), sans
-- laisser aucune RPC V66 exposée à authenticated.
--
-- ÉCRITE ET TESTÉE après second audit indépendant, qui a démontré
-- que la procédure décrite en prose dans la version précédente du
-- rapport ("réexécuter migration-v31 puis migration-v43 tels quels")
-- NE FONCTIONNE PAS, pour des raisons structurelles PostgreSQL, pas
-- de simples détails :
--
--   1. create_product/update_product à 4 paramètres via
--      `create or replace function` NE REMPLACERAIENT PAS les
--      versions V66 à 5 paramètres. PostgreSQL identifie une
--      fonction par son nom ET ses types de paramètres : une
--      signature différente est une fonction DISTINCTE. Réexécuter
--      migration-v31-catalogue.sql telle quelle créerait une
--      DEUXIÈME surcharge à 4 paramètres, laissant les DEUX versions
--      (4 et 5 paramètres) actives simultanément — pire qu'avant.
--
--   2. get_merchant_catalogue(uuid, boolean) a le MÊME nom et LES
--      MÊMES types de paramètres en V66 qu'en V65/V43, mais un type
--      de RETOUR différent (colonnes supplémentaires :
--      short_description, category_display_order,
--      category_is_option_source). `create or replace function` ne
--      peut JAMAIS changer le type de retour d'une fonction
--      existante — PostgreSQL refuse avec une erreur explicite.
--      Réexécuter migration-v43-catalogue-i18n.sql échouerait avant
--      même d'atteindre son propre `drop function`, car ce fichier
--      suppose partir de la version V31 (sans return type étendu),
--      pas de la version V66.
--
--   3. create_category, update_category et assert_category_role
--      resteraient en base et exécutables par authenticated, même
--      après restauration complète du dashboard V65 côté frontend —
--      un attaquant ou un client mal informé pourrait continuer à
--      créer des catégories via ces RPC orphelines.
--
-- Ce fichier corrige les trois points : suppression EXPLICITE de
-- toutes les fonctions V66 (catégories PUIS produits PUIS
-- catalogue), dans cet ordre, AVANT toute recréation, le tout dans
-- une seule transaction.
--
-- DÉCISION EXPLICITE sur la colonne additive et ses dépendances
-- (demandée après audit, tranchée ici plutôt que laissée implicite) :
-- menu_items.short_description, ses deux contraintes CHECK, et
-- l'index anti-doublon idx_menu_categories_unique_active_name sont
-- CONSERVÉS par défaut — ce rollback ne les supprime PAS. Rollback
-- non destructif : les données de description courte déjà saisies
-- par un commerçant entre la migration et ce retour arrière ne sont
-- jamais perdues, même si plus aucune RPC ne les expose. Leur
-- suppression est une opération séparée et destructive, fournie en
-- commentaire en fin de fichier, JAMAIS exécutée automatiquement.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE — confirme qu'on part bien d'un état V66
--    avant de commencer, pour éviter un rollback sur une base qui ne
--    serait pas dans l'état attendu (ex. rollback déjà appliqué, ou
--    V66 jamais appliquée).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid) =
        'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text'
  ) then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: signature V66 de create_product introuvable — cette base ne semble pas avoir reçu V66, rollback annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_category'
  ) then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: create_category introuvable — cette base ne semble pas avoir reçu V66, rollback annulé.';
  end if;
end $$;


-- ------------------------------------------------------------------
-- 1. Transaction unique : suppression V66 puis recréation V65.
-- ------------------------------------------------------------------

begin;

-- 1a. RPC de catégories (V66) — supprimées, jamais recréées. Ordre :
-- les fonctions appelantes (create_category, update_category)
-- d'abord, assert_category_role ensuite, par prudence même si
-- PostgreSQL ne suit pas de dépendance automatique entre fonctions
-- PL/pgSQL qui s'appellent entre elles (contrairement aux clés
-- étrangères) — aucun `cascade` nécessaire ni utilisé.
drop function if exists public.update_category(uuid, text, integer);
drop function if exists public.create_category(uuid, text, integer);
drop function if exists public.assert_category_role(uuid, text[]);

-- 1b. Signatures produits V66 (5 paramètres) — supprimées.
drop function if exists public.create_product(uuid, text, text, numeric, text);
drop function if exists public.update_product(uuid, text, text, numeric, text);

-- 1c. get_merchant_catalogue V66 — supprimée AVANT recréation
-- (type de retour différent, create or replace impossible ici).
drop function if exists public.get_merchant_catalogue(uuid, boolean);

-- 1d. Recréation EXACTE des 3 fonctions V31/V43 — corps copié
-- caractère pour caractère depuis migration-v31-catalogue.sql et
-- migration-v43-catalogue-i18n.sql, aucune modification.

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

-- 1e. Droits V65 réaffirmés exactement comme dans migration-v31/v43.
revoke all on function public.create_product(uuid, text, text, numeric) from public, anon;
revoke all on function public.update_product(uuid, text, text, numeric) from public, anon;
grant execute on function public.create_product(uuid, text, text, numeric) to authenticated;
grant execute on function public.update_product(uuid, text, text, numeric) to authenticated;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- 1f. Vérification finale, RÉELLEMENT EXÉCUTÉE dans la même
-- transaction : aucune signature V66 (5 paramètres, ou RPC de
-- catégories) ne doit subsister. Si cette vérification échoue, tout
-- le rollback est annulé — jamais d'état intermédiaire.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_product', 'update_product')
      and pg_get_function_identity_arguments(p.oid) like '%p_short_description%'
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une signature V66 à 5 paramètres subsiste — rollback annulé.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_category', 'update_category', 'assert_category_role')
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une RPC de catégories V66 subsiste — rollback annulé.';
  end if;
end $$;

commit;


-- ============================================================
-- Ce qui n'est PAS fait par ce rollback (décision explicite) :
--
--   - menu_items.short_description : CONSERVÉE, avec ses données.
--   - menu_items_short_description_length_chk,
--     menu_items_description_length_chk : CONSERVÉES.
--   - idx_menu_categories_unique_active_name : CONSERVÉ.
--   - Les catégories créées via create_category pendant que V66
--     était active : CONSERVÉES (aucune suppression physique,
--     cohérent avec la règle générale du projet).
--
-- Suppression DESTRUCTIVE de la colonne additive (à exécuter
-- SÉPARÉMENT, avec sauvegarde préalable, validation explicite, et
-- JAMAIS automatiquement) :
--
--   alter table public.menu_items drop column if exists short_description;
--   -- (les contraintes CHECK associées disparaissent avec la colonne)
--   drop index if exists public.idx_menu_categories_unique_active_name;
--
-- Retour arrière du CODE (frontend) : ce fichier ne couvre que la
-- base de données. Le nombre de fichiers couverts par le patch V66 a
-- changé À CHAQUE tour de correction (6, puis 14, puis 19, puis 20,
-- puis 21 à ce jour) : ne JAMAIS répéter un nombre écrit en dur sans
-- le revérifier. La commande qui fait foi, à exécuter avant toute
-- opération de retour arrière ou de relecture de ce commentaire :
--
--   grep -c '^diff --git' scanym-v66-patch.diff
--
-- (21 au moment de cette correction — audit Work du 11 août 2026,
-- 2e passage). Le retour arrière du code doit être l'application
-- inverse contrôlée du patch complet (`git apply -R
-- scanym-v66-patch.diff`) ou un `git revert` du commit V66 une fois
-- fusionné — jamais une restauration manuelle fichier par fichier, et
-- jamais un compte mémorisé plutôt que revérifié.
-- ============================================================
