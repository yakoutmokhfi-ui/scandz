-- ============================================================
-- Scanym — OPERATOR BACKOFFICE — OB-2
-- CATALOGUE RPC OPERATOR AUTHORIZATION v1 (+ v1.1 READ-PATH COMPLETION)
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis : d81eaba03b58e2cfd4af575113ab0ad08fec37da
-- (main, incluant MERCHANT LEGAL & TAX PROFILE v1.2 déjà publié).
--
-- OBJECTIF (mandat OB-2, complété par OB-2 v1.1) : permettre à un
-- opérateur Scanym autorisé (is_scanym_operator() = true) de LIRE et
-- créer/modifier des entités de catalogue pour N'IMPORTE QUEL
-- restaurant, en réutilisant EXACTEMENT le patron d'autorisation déjà
-- en place pour identité/couleurs/maps (assert_restaurant_asset_role,
-- migration-v68-establishment-assets.sql) : owner OU manager DU
-- restaurant, OU opérateur Scanym global (sans exiger de ligne
-- restaurant_users pour l'opérateur). RÈGLE MÉTIER CENTRALE (mandat
-- v1.1, rappelée explicitement) : cette capacité opérateur est
-- STRICTEMENT ADDITIVE -- elle ne retire, ne remplace, ni n'affaiblit
-- JAMAIS les permissions existantes owner/manager du commerçant, qui
-- gardent EXACTEMENT le même accès lecture/écriture à leur propre
-- catalogue qu'avant ce lot (non-régression prouvée dans
-- TEST-RESULTS.md).
--
-- v1.1 -- CATALOGUE OPERATOR READ-PATH COMPLETION : le lot v1
-- (livré, jamais publié) laissait délibérément get_merchant_catalogue
-- (RPC de LECTURE) hors périmètre, car non listée dans la
-- reconnaissance obligatoire du mandat OB-2 initial (qui ne citait
-- que des RPC de MUTATION). Un audit de suivi a demandé la
-- complétion : un opérateur pouvait déjà ÉCRIRE (v1) mais pas encore
-- LIRE le catalogue d'un restaurant dont il n'est pas membre --
-- incohérent pour une administration réellement zero-code. v1.1
-- ferme ce gap avec EXACTEMENT le même patron, au seul point de
-- contrôle de get_merchant_catalogue (section 6 ci-dessous),
-- réécrite en place dans ce même fichier (jamais publié à ce jour,
-- donc jamais recommité comme un fichier v1.1 séparé -- même
-- convention que MERCHANT LEGAL & TAX PROFILE v1 -> v1.1 -> v1.2).
--
-- ANALYSE PRÉALABLE (reconnaissance obligatoire du mandat, voir
-- AUTHORIZATION-MATRIX.md pour le détail RPC par RPC) :
--   - Trois fonctions d'autorisation centralisées, CHACUNE réutilisée
--     par PLUSIEURS RPC catalogue, ne connaissent aujourd'hui QUE
--     owner/manager (ou owner/manager/staff pour
--     set_product_availability, via son propre p_roles) :
--       assert_category_role(p_category_id, p_roles)   -- migration-v66
--       assert_product_role(p_product_id, p_roles)     -- migration-v31
--       assert_subcategory_role(p_subcategory_id, p_roles) -- DRAFT subcategories v1
--   - Deux RPC de CRÉATION n'ont PAS d'entité existante à interroger
--     au moment de l'appel (aucune catégorie/produit n'existe encore) :
--     elles vérifient l'appartenance au restaurant EN LIGNE, sans
--     passer par une fonction assert_*_role partagée :
--       create_category(p_restaurant_id, ...)   -- migration-v66
--       create_product(p_category_id, ...)      -- vérifie le
--         restaurant_id résolu depuis la catégorie -- signature
--         actuelle à 9 paramètres, DRAFT subcategories v1
--   - Une RPC de LECTURE, contrôle en ligne indépendant, AJOUTÉE au
--     périmètre par v1.1 :
--       get_merchant_catalogue(p_restaurant_id, p_archived) -- DRAFT
--         subcategories v1 (signature/forme de retour à 29 colonnes
--         inchangée, seul le corps de la vérification est modifié)
--
-- CONCEPTION MINIMALE RETENUE (mandat "narrowly scoped", "existing
-- RPC signatures unless strictly necessary") :
--   Une SEULE modification, répétée à l'identique aux 6 points de
--   contrôle ci-dessus (5 en v1 + get_merchant_catalogue en v1.1) :
--   la condition `if not exists (... ) then raise exception` devient
--   `if not exists (...) and not public.is_scanym_operator() then
--   raise exception`. AUCUNE signature ne change. AUCUN message
--   d'erreur ne change. AUCUN code d'erreur ne change. AUCUNE ligne
--   de validation métier (nom, prix, description, TVA, poids,
--   sous-catégorie) n'est touchée, ni la forme des données retournées
--   par get_merchant_catalogue -- seul le prédicat d'autorisation est
--   étendu, à l'identique du patron assert_restaurant_asset_role.
--
--   Conséquence DÉLIBÉRÉE et ATTENDUE (documentée dans FINDINGS.md) :
--   comme assert_product_role est PARTAGÉE, cette modification étend
--   AUSSI l'accès opérateur à update_product, archive_product,
--   restore_product, set_product_order, set_product_photo et
--   set_product_availability (déjà ouverte à staff, désormais aussi
--   à l'opérateur) -- sans qu'aucune de ces RPC ne soit elle-même
--   modifiée. Même mécanique pour assert_category_role
--   (update_category, create_subcategory) et assert_subcategory_role
--   (update_subcategory).
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT (mandat OB-2 + v1.1) :
--   - Aucune modification des policies storage.objects du bucket
--     product-photos (voir FINDINGS.md, section PHOTO PATH CHECK --
--     BLOCKED, nécessite un lot séparé -- mandat v1.1 le confirme
--     explicitement : "Do NOT modify the product-photos Storage RLS
--     in this lot").
--   - Aucune modification de lib/roles.ts ni d'app/dashboard/catalogue/
--     page.tsx (UI hors périmètre SQL de ce lot -- voir FINDINGS.md).
--   - Aucune nouvelle table. Aucun nouveau type. Aucune nouvelle
--     colonne. Aucune modification de Stuart/Monetico/Legal-Tax/
--     Tracking/sale modes/publish gate.
--   - Aucun octroi PUBLIC/anon. Aucune insertion factice dans
--     restaurant_users pour simuler un accès opérateur.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction -- si ce bloc échoue, rien n'a encore été
--    touché). Même patron que migration-v66/v67b/DRAFT subcategories.
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  -- 0a. Les 5 fonctions ciblées doivent exister avec EXACTEMENT la
  -- signature attendue (état courant, main d81eaba0).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_category_role'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_roles text[]'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_category_role(uuid, text[]) introuvable -- OB-2 annulé, aucune modification appliquée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_product_role'
      and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid, p_roles text[]'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_product_role(uuid, text[]) introuvable -- OB-2 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_subcategory_role'
      and pg_get_function_identity_arguments(p.oid) = 'p_subcategory_id uuid, p_roles text[]'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_subcategory_role(uuid, text[]) introuvable -- OB-2 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_category'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_category(uuid, text, integer) introuvable -- OB-2 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean, p_subcategory_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: signature exacte create_product (9 paramètres, CATALOGUE / SUBCATEGORIES v1) introuvable -- OB-2 annulé.';
  end if;

  -- 0a-bis (v1.1). get_merchant_catalogue doit exister avec EXACTEMENT
  -- la signature d'appel ET la forme de retour à 29 colonnes attendues
  -- (état courant, DRAFT subcategories v1) -- v1.1 ne doit JAMAIS
  -- s'appliquer sur une forme de retour différente de celle qu'elle
  -- documente et préserve à l'identique.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_catalogue(uuid, boolean) introuvable -- OB-2 v1.1 annulé.';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_result(p.oid) like 'TABLE(product_id uuid, category_id uuid, category_name text, category_name_hash text, category_translations jsonb, category_display_order integer, category_is_option_source boolean, category_description text, category_description_hash text, subcategory_id uuid, subcategory_name text, subcategory_display_order integer, name text, name_hash text, short_description text, short_description_hash text, description text, description_hash text, translations jsonb, price numeric, is_available boolean, archived_at timestamp with time zone, display_order integer, is_option_source boolean, image_url text, tax_rate numeric, unit_weight_grams integer, weight_is_approximate boolean, reference_price_per_kg numeric)'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: forme de retour exacte (29 colonnes, CATALOGUE / SUBCATEGORIES v1) de get_merchant_catalogue introuvable -- OB-2 v1.1 annulé, aucune modification appliquée.';
  end if;

  -- 0b. is_scanym_operator() doit déjà exister (dépendance directe).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable -- OB-2 annulé.';
  end if;

  -- 0c. Garde anti-double-application : aucune des 6 fonctions
  -- ciblées (5 v1 + get_merchant_catalogue v1.1) ne doit déjà
  -- référencer is_scanym_operator dans son corps.
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        (p.proname = 'assert_category_role' and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_roles text[]')
        or (p.proname = 'assert_product_role' and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid, p_roles text[]')
        or (p.proname = 'assert_subcategory_role' and pg_get_function_identity_arguments(p.oid) = 'p_subcategory_id uuid, p_roles text[]')
        or (p.proname = 'create_category' and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_name text, p_display_order integer')
        or (p.proname = 'create_product' and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean, p_subcategory_id uuid')
        or (p.proname = 'get_merchant_catalogue' and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean')
      )
  loop
    if v_def ilike '%is_scanym_operator%' then
      raise exception 'SCANYM_SCHEMA_DRIFT: au moins une des 6 fonctions ciblées référence déjà is_scanym_operator -- OB-2 v1.1 déjà appliqué ou conflit, annulé.';
    end if;
  end loop;

  -- 0d. Propriétaire, SECURITY DEFINER, search_path inchangés avant
  -- modification -- même prudence que tous les lots précédents.
  for v_def in
    select pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('assert_category_role', 'assert_product_role', 'assert_subcategory_role', 'create_category', 'create_product', 'get_merchant_catalogue', 'is_scanym_operator')
  loop
    if v_def not like 'postgres|true|%search_path=%' then
      raise exception 'SCANYM_SCHEMA_DRIFT: une fonction catalogue n''est pas postgres/SECURITY DEFINER/search_path fixé comme attendu (%) -- OB-2 v1.1 annulé.', v_def;
    end if;
  end loop;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. assert_category_role -- ajout du bypass opérateur, corps
--    identique par ailleurs (migration-v66-categories-descriptions.sql).
-- ------------------------------------------------------------------
create or replace function public.assert_category_role(
  p_category_id uuid,
  p_roles       text[]
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
  from public.menu_categories mc
  where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  -- OB-2 : owner/manager (ou tout autre rôle demandé par l'appelant
  -- via p_roles) DU restaurant, OU opérateur Scanym global (bypass
  -- inconditionnel, même patron que assert_restaurant_asset_role,
  -- migration-v68-establishment-assets.sql).
  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (p_roles)
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  return v_restaurant_id;
end $$;

-- ------------------------------------------------------------------
-- 2. assert_product_role -- ajout du bypass opérateur, corps
--    identique par ailleurs (migration-v31-catalogue.sql).
-- ------------------------------------------------------------------
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
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this product';
  end if;

  return v_restaurant_id;
end $$;

-- ------------------------------------------------------------------
-- 3. assert_subcategory_role -- ajout du bypass opérateur, corps
--    identique par ailleurs (DRAFT-lot-catalogue-subcategories-
--    backoffice-v1.sql).
-- ------------------------------------------------------------------
create or replace function public.assert_subcategory_role(
  p_subcategory_id uuid,
  p_roles          text[]
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
  from public.menu_subcategories ms
  join public.menu_categories mc on mc.id = ms.category_id
  where ms.id = p_subcategory_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Subcategory not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (p_roles)
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this subcategory';
  end if;

  return v_restaurant_id;
end $$;

-- ------------------------------------------------------------------
-- 4. create_category -- même ajout, contrôle en ligne (aucune
--    catégorie n'existe encore à ce stade, donc aucun assert_*_role
--    partagé à réutiliser -- corps identique par ailleurs,
--    migration-v66-categories-descriptions.sql).
-- ------------------------------------------------------------------
create or replace function public.create_category(
  p_restaurant_id  uuid,
  p_name           text,
  p_display_order  integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_order integer;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_display_order is null then
    select coalesce(max(mc.display_order), 0) + 1 into v_order
    from public.menu_categories mc where mc.restaurant_id = p_restaurant_id;
  else
    v_order := p_display_order;
  end if;

  begin
    insert into public.menu_categories (restaurant_id, name, display_order, is_active)
    values (p_restaurant_id, v_name, v_order, true)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SCANYM_CATEGORY_DUPLICATE_NAME' using errcode = '23505';
  end;

  return v_id;
end $$;

-- ------------------------------------------------------------------
-- 5. create_product -- même ajout, contrôle en ligne (signature
--    actuelle à 9 paramètres, corps identique par ailleurs,
--    DRAFT-lot-catalogue-subcategories-backoffice-v1.sql). Utilise
--    CREATE OR REPLACE (pas DROP + CREATE) : la signature ne change
--    pas, seul le corps est modifié -- préserve l'OID de la fonction
--    et les GRANT existants sans avoir besoin de les reformuler.
-- ------------------------------------------------------------------
create or replace function public.create_product(
  p_category_id             uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null
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
  v_name text;
  v_description text;
  v_short_description text;
  v_subcategory_category_id uuid;
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
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from p_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  insert into public.menu_items (
    category_id, name, description, short_description, price, display_order,
    tax_rate, unit_weight_grams, weight_is_approximate, subcategory_id
  )
  values (
    p_category_id, v_name, v_description, v_short_description, round(p_price, 2), v_order,
    p_tax_rate, p_unit_weight_grams, p_weight_is_approximate, p_subcategory_id
  )
  returning id into v_id;

  return v_id;
end $$;

-- ------------------------------------------------------------------
-- 6. get_merchant_catalogue -- AJOUT v1.1 (CATALOGUE OPERATOR
--    READ-PATH COMPLETION). Même ajout que les 5 fonctions
--    précédentes : un opérateur Scanym peut désormais aussi LIRE le
--    catalogue d'un restaurant dont il n'est membre d'aucune ligne
--    restaurant_users. Corps IDENTIQUE par ailleurs
--    (DRAFT-lot-catalogue-subcategories-backoffice-v1.sql) --
--    signature ET forme de retour à 29 colonnes INCHANGÉES (CREATE OR
--    REPLACE, pas DROP + CREATE : le type de retour ne change pas,
--    seule la ligne d'autorisation est modifiée, ce qui préserve
--    l'OID de la fonction et les GRANT existants).
--
--    Owner/manager DU restaurant gardent EXACTEMENT le même accès
--    lecture qu'avant ce lot (non-régression, mandat v1.1) : la
--    condition existante `exists(restaurant_users ...)` est
--    entièrement préservée, seul un `or is_scanym_operator()` est
--    ajouté à côté -- jamais une réécriture de la condition
--    owner/manager elle-même.
-- ------------------------------------------------------------------
create or replace function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id                 uuid,
  category_id                uuid,
  category_name               text,
  category_name_hash          text,
  category_translations       jsonb,
  category_display_order      integer,
  category_is_option_source   boolean,
  category_description        text,
  category_description_hash   text,
  subcategory_id               uuid,
  subcategory_name             text,
  subcategory_display_order    integer,
  name                        text,
  name_hash                   text,
  short_description            text,
  short_description_hash       text,
  description                  text,
  description_hash             text,
  translations                 jsonb,
  price                        numeric,
  is_available                 boolean,
  archived_at                  timestamptz,
  display_order                integer,
  is_option_source             boolean,
  image_url                    text,
  tax_rate                     numeric,
  unit_weight_grams            integer,
  weight_is_approximate        boolean,
  reference_price_per_kg       numeric
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

  -- OB-2 v1.1 : owner/manager/staff-membre DU restaurant (contrat
  -- existant, préservé À L'IDENTIQUE -- exists(restaurant_users ...)
  -- sans filtre de rôle, exactement comme avant ce lot), OU opérateur
  -- Scanym global (bypass inconditionnel, même patron que les 5
  -- fonctions v1 et que assert_restaurant_asset_role).
  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  with groups as (
    select ms.category_id as category_id, ms.id as subcategory_id,
           ms.name::text as subcategory_name, ms.display_order as subcategory_display_order
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order
    from public.menu_categories mc2
    where mc2.restaurant_id = p_restaurant_id
  )
  select mi.id, mc.id, mc.name::text, mc.name_hash, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description, mc.description_hash,
         g.subcategory_id, g.subcategory_name, g.subcategory_display_order,
         mi.name::text, mi.name_hash, mi.short_description, mi.short_description_hash,
         mi.description, mi.description_hash, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         ),
         mi.image_url,
         mi.tax_rate, mi.unit_weight_grams, mi.weight_is_approximate, mi.reference_price_per_kg
  from public.menu_categories mc
  join groups g on g.category_id = mc.id
  left join public.menu_items mi
    on mi.category_id = mc.id
    and mi.subcategory_id is not distinct from g.subcategory_id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name,
           case when g.subcategory_id is null then 0 else 1 end,
           g.subcategory_display_order nulls last, g.subcategory_name nulls last,
           mi.display_order nulls last, mi.name nulls last;
end $$;

-- ------------------------------------------------------------------
-- 7. VÉRIFICATION POST-APPLICATION -- TOUJOURS AVANT commit; (un
--    échec ici déclenche un ROLLBACK automatique complet, aucune
--    modification partielle ne peut jamais rester commitée).
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  -- 7a. Les 6 corps référencent désormais is_scanym_operator.
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        (p.proname = 'assert_category_role' and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_roles text[]')
        or (p.proname = 'assert_product_role' and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid, p_roles text[]')
        or (p.proname = 'assert_subcategory_role' and pg_get_function_identity_arguments(p.oid) = 'p_subcategory_id uuid, p_roles text[]')
        or (p.proname = 'create_category' and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_name text, p_display_order integer')
        or (p.proname = 'create_product' and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean, p_subcategory_id uuid')
        or (p.proname = 'get_merchant_catalogue' and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean')
      )
  loop
    if v_def not ilike '%is_scanym_operator%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une des 6 fonctions ciblées ne référence pas is_scanym_operator après application.';
    end if;
  end loop;

  -- 7b. SECURITY DEFINER / search_path / propriétaire préservés.
  for v_def in
    select pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('assert_category_role', 'assert_product_role', 'assert_subcategory_role', 'create_category', 'create_product', 'get_merchant_catalogue')
  loop
    if v_def not like 'postgres|true|%search_path=%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une fonction catalogue a perdu SECURITY DEFINER/search_path/propriétaire postgres après application (%).', v_def;
    end if;
  end loop;

  -- 7c. Forme de retour de get_merchant_catalogue inchangée (29
  -- colonnes) -- v1.1 ne doit JAMAIS modifier la forme des données
  -- retournées, seul le prédicat d'autorisation change.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
      and pg_get_function_result(p.oid) like 'TABLE(product_id uuid, category_id uuid, category_name text, category_name_hash text, category_translations jsonb, category_display_order integer, category_is_option_source boolean, category_description text, category_description_hash text, subcategory_id uuid, subcategory_name text, subcategory_display_order integer, name text, name_hash text, short_description text, short_description_hash text, description text, description_hash text, translations jsonb, price numeric, is_available boolean, archived_at timestamp with time zone, display_order integer, is_option_source boolean, image_url text, tax_rate numeric, unit_weight_grams integer, weight_is_approximate boolean, reference_price_per_kg numeric)'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la forme de retour de get_merchant_catalogue a changé après application, jamais attendu.';
  end if;

  -- 7d. Aucun octroi élargi : anon/public toujours sans EXECUTE,
  -- authenticated toujours avec EXECUTE (inchangé -- CREATE OR
  -- REPLACE préserve les GRANT existants, vérifié explicitement).
  if has_function_privilege('anon', 'public.create_category(uuid, text, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_category(uuid, text, integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_subcategory(uuid, text, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_subcategory(uuid, text, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_merchant_catalogue(uuid, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur au moins une RPC catalogue après application, jamais attendu.';
  end if;

  if not has_function_privilege('authenticated', 'public.create_category(uuid, text, integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.update_category(uuid, text, integer, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_merchant_catalogue(uuid, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur au moins une RPC catalogue après application.';
  end if;

  -- 7e. Aucun droit d'écriture direct élargi sur menu_items/
  -- menu_categories/menu_subcategories (ce lot ne touche aucune
  -- policy/GRANT de table -- contrôle de non-régression explicite).
  if has_table_privilege('anon', 'public.menu_items', 'INSERT')
     or has_table_privilege('anon', 'public.menu_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.menu_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_items', 'UPDATE')
     or has_table_privilege('anon', 'public.menu_categories', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_categories', 'INSERT')
     or has_table_privilege('anon', 'public.menu_subcategories', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'INSERT')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: un droit d''écriture direct anon/authenticated est apparu sur une table catalogue, jamais attendu.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport à l'état main d81eaba0 :
--   ~ assert_category_role(uuid, text[]) : ajout du bypass
--     is_scanym_operator(), corps identique par ailleurs. (v1)
--   ~ assert_product_role(uuid, text[]) : idem. (v1)
--   ~ assert_subcategory_role(uuid, text[]) : idem. (v1)
--   ~ create_category(uuid, text, integer) : idem (contrôle en
--     ligne). (v1)
--   ~ create_product(uuid, text, text, numeric, text, numeric,
--     integer, boolean, uuid) : idem (contrôle en ligne). (v1)
--   ~ get_merchant_catalogue(uuid, boolean) : idem (contrôle en
--     ligne, forme de retour à 29 colonnes INCHANGÉE). (v1.1 --
--     CATALOGUE OPERATOR READ-PATH COMPLETION)
--   AUCUNE signature modifiée. AUCUN message/code d'erreur modifié.
--   AUCUNE validation métier modifiée. AUCUNE nouvelle table/colonne.
--   AUCUN GRANT élargi (anon toujours sans EXECUTE, authenticated
--   inchangé). AUCUNE policy Storage modifiée (voir FINDINGS.md,
--   PHOTO PATH CHECK, toujours BLOCKED -- NEEDS SEPARATE LOT après
--   v1.1).
--   Conséquence transitive attendue (fonctions PARTAGÉES, non
--   modifiées elles-mêmes) : update_category, create_subcategory,
--   update_subcategory, update_product, archive_product,
--   restore_product, set_product_order, set_product_photo,
--   set_product_availability acceptent désormais aussi un opérateur
--   Scanym global, en plus de owner/manager (et staff pour
--   set_product_availability, inchangé).
--   Non-régression merchant (mandat v1.1, rappel) : owner/manager
--   gardent EXACTEMENT le même accès lecture ET écriture à leur
--   propre catalogue qu'avant ce lot -- la capacité opérateur est
--   strictement additive, jamais un remplacement ou un affaiblissement
--   du contrôle existant du commerçant sur son propre catalogue.
-- ============================================================
