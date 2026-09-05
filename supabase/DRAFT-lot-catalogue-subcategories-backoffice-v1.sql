-- ============================================================
-- Scanym — CATALOGUE / BACK-OFFICE / SUBCATEGORIES v1
-- STREAM A — Category -> optional Subcategory -> Product
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis : 1844403cfd0d6109fe386ace5fca2cf52c1df47e
-- (main, incluant PAYMENT P3-B Monetico checkout runtime v4.6 et
-- RECEIPT / INVOICE TAX DETAIL, déjà mergés).
--
-- OBJECTIF (mandat STREAM A) : ajouter une couche OPTIONNELLE de
-- sous-catégorie entre catégorie et produit, pour les petits
-- commerçants spécialisés (ex. fromagerie : catégorie "Fromages" ->
-- sous-catégorie "Chèvres" -> produits "Charolais"/"Pélardon"), SANS
-- casser les commerçants qui n'utilisent que des catégories directes
-- (ex. "Boissons" -> "Eau"/"Jus", inchangé).
--
-- ANALYSE PRÉALABLE (mandat §6) : aucune construction hiérarchique
-- n'existe déjà dans le schéma (recherche exhaustive
-- "sub_categ|subcateg|parent_categ|parent_id|section_id|group_id" sur
-- tout supabase/*.sql -- 0 résultat). Le seul mécanisme à deux niveaux
-- existant est `menu_items.option_source_category_id`, qui pointe un
-- PRODUIT vers une CATÉGORIE fournissant ses options -- un mécanisme
-- de sélection croisée, pas une hiérarchie catalogue, et totalement
-- indépendant de ce lot (aucune modification).
--
-- CONCEPTION MINIMALE RETENUE (mandat §7-§8) :
--   - Nouvelle table ADDITIVE `menu_subcategories` (id, category_id,
--     name, display_order) -- aucune colonne inventée sans besoin
--     démontré (pas de `translations`/`updated_at` en v1, voir
--     LIMITES CONNUES ci-dessous).
--   - Nouvelle colonne ADDITIVE, NULLABLE,
--     `menu_items.subcategory_id` -- NULL = produit directement
--     rattaché à sa catégorie (comportement HISTORIQUE inchangé, zéro
--     migration de données, rétrocompatible par construction : mandat
--     §15, "existing merchants with no subcategories must continue to
--     behave exactly as before").
--   - `menu_items.category_id` reste INCHANGÉE, obligatoire, unique
--     autorité de rattachement catalogue -- une sous-catégorie ne
--     remplace jamais la catégorie, elle la précise. Un produit ne
--     peut être placé QUE dans une sous-catégorie de SA PROPRE
--     catégorie (contrainte applicative + trigger, section 3
--     ci-dessous) : "product moved category -> subcategory",
--     "subcategory -> category", "subcategory A -> subcategory B"
--     sont donc tous des mouvements INTRA-catégorie, exactement comme
--     `update_product` ne permet déjà pas de changer `category_id`
--     aujourd'hui (limite préexistante, non modifiée par ce lot).
--   - AUCUNE RPC `archive_subcategory`/`delete_subcategory` : par
--     symétrie EXACTE avec `menu_categories`, qui n'a elle-même aucune
--     RPC d'archivage/suppression (seulement `is_active`, jamais
--     touchée par `update_category`) -- confirmé par recherche
--     exhaustive sur supabase/*.sql. `create_subcategory`/
--     `update_subcategory` suffisent (création/renommage/réordonnancement
--     en un seul appel, même patron que `create_category`/
--     `update_category`, qui n'ont eux non plus jamais eu de RPC
--     d'ordre séparée). "Preserve products if subcategory is removed"
--     (mandat §9) est ainsi satisfait trivialement : aucune RPC ne
--     permet de supprimer une sous-catégorie en v1, donc aucun produit
--     ne peut perdre son rattachement par ce chemin ; en défense en
--     profondeur, la colonne reste tout de même `on delete set null`
--     au niveau FK, pour qu'une suppression manuelle future (hors RPC)
--     ne puisse jamais supprimer un produit en cascade.
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT (mandat §12) :
--   - Aucune modification de create_order, orders, order_items,
--     payment_*, Monetico, Stuart, tracking. La sous-catégorie est un
--     regroupement de PRÉSENTATION/CATALOGUE uniquement -- le prix de
--     ligne de commande reste EXACTEMENT
--     `menu_items.price × quantité entière` (create_order, inchangée).
--   - Aucune tarification au poids variable, aucun moteur de variante.
--   - Aucune modification des tables/RPC de paiement (un autre flux
--     Claude travaille en parallèle sur Monetico -- isolation stricte
--     mandat §13).
--
-- LIMITES CONNUES, DOCUMENTÉES EXPLICITEMENT (mandat §19-17) :
--   - `menu_subcategories.name` N'EST PAS traduisible en v1 (pas de
--     colonne `translations`, pas d'extension de la RPC générique
--     `write_translation`) -- affichée dans sa langue source pour
--     toutes les langues client, exactement comme `short_description`/
--     `description` avant l'architecture de traduction LOT 1B. Ce
--     choix limite délibérément la surface de risque de ce lot (ne
--     touche pas une RPC partagée par 3 types d'entité) ; une
--     extension future est possible sans redesign (ajouter une
--     colonne `translations jsonb` + un 4e type d'entité
--     'subcategory' à `write_translation` serait purement additif).
--   - Pas de colonne `updated_at`/trigger `touch_updated_at` sur
--     `menu_subcategories` en v1 -- aucun consommateur actuel n'en a
--     besoin (mandat §8, "do not invent fields without demonstrated
--     need").
--
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction -- si ce bloc échoue, rien n'a encore été
--    touché). Même patron que migration-v66/v67b/v81/CATALOGUE FISCAL
--    v1.3.
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_fn record;
begin
  -- 0a. Signatures RPC EXACTES actuelles (état CATALOGUE FISCAL v1.3).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte create_product (8 paramètres, CATALOGUE FISCAL v1.3) introuvable -- CATALOGUE / SUBCATEGORIES v1 annulé, aucune modification appliquée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_product_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte update_product (8 paramètres, CATALOGUE FISCAL v1.3) introuvable -- CATALOGUE / SUBCATEGORIES v1 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte get_merchant_catalogue(uuid,boolean) introuvable -- CATALOGUE / SUBCATEGORIES v1 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_category'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte create_category introuvable -- CATALOGUE / SUBCATEGORIES v1 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_category'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_display_order integer, p_description text'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte update_category (4 paramètres, V67b) introuvable -- CATALOGUE / SUBCATEGORIES v1 annulé.';
  end if;

  -- 0b. Aucune surcharge inattendue des fonctions modifiées par ce lot.
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue');
  if v_count <> 3 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: % fonctions trouvées pour create_product/update_product/get_merchant_catalogue, 3 attendues -- CATALOGUE / SUBCATEGORIES v1 annulé.',
      v_count;
  end if;

  -- 0c. Propriétaire, SECURITY DEFINER, search_path des fonctions
  -- existantes que ce lot recrée (drop + create).
  for v_fn in
    select pg_get_userbyid(p.proowner) as owner, p.proconfig as search_path, p.prosecdef as secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue', 'create_category', 'update_category', 'assert_product_role', 'assert_category_role')
  loop
    if v_fn.owner is distinct from 'postgres' then
      raise exception
        'SCANYM_SCHEMA_DRIFT: propriétaire inattendu (%) pour une des fonctions catalogue -- CATALOGUE / SUBCATEGORIES v1 annulé.',
        v_fn.owner;
    end if;
    if v_fn.secdef is not true then
      raise exception
        'SCANYM_SCHEMA_DRIFT: une des fonctions catalogue n''est pas SECURITY DEFINER -- CATALOGUE / SUBCATEGORIES v1 annulé.';
    end if;
    if v_fn.search_path is null or not exists (
      select 1 from unnest(v_fn.search_path) as cfg where cfg = 'search_path=""'
    ) then
      raise exception
        'SCANYM_SCHEMA_DRIFT: une des fonctions catalogue n''a pas search_path = '''' exactement -- CATALOGUE / SUBCATEGORIES v1 annulé.';
    end if;
  end loop;

  -- 0d. Garde anti-double-application : ni la table menu_subcategories,
  -- ni menu_items.subcategory_id ne doivent déjà exister.
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'menu_subcategories'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: la table public.menu_subcategories existe déjà -- CATALOGUE / SUBCATEGORIES v1 déjà appliqué ou conflit, annulé.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'subcategory_id'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items.subcategory_id existe déjà -- CATALOGUE / SUBCATEGORIES v1 déjà appliqué ou conflit, annulé.';
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_subcategory', 'update_subcategory', 'assert_subcategory_role')
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: au moins une RPC de sous-catégorie existe déjà -- CATALOGUE / SUBCATEGORIES v1 annulé.';
  end if;

  -- 0e. Droits EFFECTIFS actuels sur menu_items -- confirme qu'aucun
  -- droit d'écriture large n'existe déjà avant cette migration.
  if has_table_privilege('anon', 'public.menu_items', 'INSERT')
     or has_table_privilege('anon', 'public.menu_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.menu_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_items', 'UPDATE')
  then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items a déjà un droit INSERT/UPDATE direct pour anon/authenticated (attendu : uniquement via RPC SECURITY DEFINER) -- CATALOGUE / SUBCATEGORIES v1 annulé.';
  end if;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. NOUVELLE TABLE ADDITIVE menu_subcategories.
--
-- Pas de restaurant_id dupliqué : comme menu_items (rattaché à sa
-- catégorie uniquement, jamais directement au restaurant), l'isolation
-- multi-tenant se fait par jointure via category_id -> menu_categories
-- .restaurant_id, exactement le même patron que menu_items.
-- ------------------------------------------------------------------

create table public.menu_subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  name text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.menu_subcategories is
  'CATALOGUE / SUBCATEGORIES v1 -- regroupement OPTIONNEL de présentation entre une catégorie et ses produits (ex. catégorie "Fromages" -> sous-catégorie "Chèvres"). N''a AUCUNE incidence financière : le prix de commande reste menu_items.price × quantité (create_order, inchangée). ON DELETE CASCADE sur category_id par cohérence de portée (une sous-catégorie n''a de sens que rattachée à sa catégorie) -- sans incidence pratique aujourd''hui, aucune RPC de suppression de catégorie n''existe.';
comment on column public.menu_subcategories.display_order is
  'Ordre d''affichage de la sous-catégorie PARMI les sous-catégories de la MÊME catégorie. Indépendant de menu_items.display_order (portée différente -- voir get_merchant_catalogue pour la règle de tri déterministe complète).';

-- Protection anti-doublon, même mécanisme que
-- idx_menu_categories_unique_active_name (index unique partiel,
-- atomique, insensible à la casse, jamais un contrôle applicatif
-- SELECT-puis-INSERT vulnérable à une fenêtre de concurrence). Portée
-- category_id + nom normalisé -- pas de clause is_active ici (aucune
-- colonne d''archivage sur menu_subcategories en v1, voir LIMITES
-- CONNUES en tête de fichier).
create unique index idx_menu_subcategories_unique_name
  on public.menu_subcategories (category_id, lower(btrim(name, E' \t\n\r\f' || chr(11))));

alter table public.menu_subcategories enable row level security;

create policy "lecture publique sous-categories actives"
  on public.menu_subcategories for select
  to public
  using (
    exists (
      select 1 from public.menu_categories mc
      join public.restaurants r on r.id = mc.restaurant_id
      where mc.id = menu_subcategories.category_id
        and r.is_active = true and r.status = 'active'
    )
  );

create policy "lecture membre sous-categories"
  on public.menu_subcategories for select
  to authenticated
  using (
    exists (
      select 1 from public.menu_categories mc
      join public.restaurant_users ru on ru.restaurant_id = mc.restaurant_id
      where mc.id = menu_subcategories.category_id
        and ru.user_id = auth.uid()
    )
  );

-- Aucune policy INSERT/UPDATE/DELETE : toutes les écritures passent
-- exclusivement par create_subcategory/update_subcategory (SECURITY
-- DEFINER), même patron que menu_categories/menu_items. Révocation
-- explicite des droits d'écriture directs, quel que soit le privilège
-- par défaut hérité du schéma public (même prudence que
-- migration-v31-catalogue.sql/migration-v66 pour les 2 tables sœurs).
revoke insert, update, delete, truncate, references, trigger
  on public.menu_subcategories from anon, authenticated;

-- ------------------------------------------------------------------
-- 2. NOUVELLE COLONNE ADDITIVE, NULLABLE, menu_items.subcategory_id.
--
-- NULL = produit directement rattaché à sa catégorie (comportement
-- HISTORIQUE, valeur par défaut pour toute ligne existante -- AUCUNE
-- migration de données, mandat §15).
-- ------------------------------------------------------------------

alter table public.menu_items
  add column subcategory_id uuid references public.menu_subcategories(id) on delete set null;

comment on column public.menu_items.subcategory_id is
  'CATALOGUE / SUBCATEGORIES v1 -- sous-catégorie OPTIONNELLE de présentation, DOIT appartenir à la MÊME category_id que ce produit (garanti par trigger enforce_menu_item_subcategory_category_match, défense en profondeur en plus de la validation RPC create_product/update_product). NULL = produit directement rattaché à sa catégorie, comportement historique inchangé. N''affecte JAMAIS create_order/le prix de commande.';

create index idx_menu_items_subcategory_id on public.menu_items (subcategory_id);

-- ------------------------------------------------------------------
-- 3. COHÉRENCE subcategory_id / category_id -- DÉFENSE EN PROFONDEUR.
--
-- Un produit ne peut être placé que dans une sous-catégorie de SA
-- PROPRE catégorie -- jamais celle d'un autre restaurant, jamais celle
-- d'une autre catégorie du même restaurant. Les RPC create_product/
-- update_product valident déjà ce point (message d'erreur clair,
-- section 4/5 ci-dessous) ; ce trigger est le filet de sécurité
-- structurel, au niveau base, qui ne peut jamais être contourné même
-- par un futur chemin d'écriture qui oublierait la validation RPC --
-- même patron de défense en profondeur que les contraintes CHECK
-- tax_rate/unit_weight_grams (RPC + contrainte base, jamais l'un sans
-- l'autre).
-- ------------------------------------------------------------------

create function public.enforce_menu_item_subcategory_category_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subcategory_category_id uuid;
begin
  if new.subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms
    where ms.id = new.subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;

    if v_subcategory_category_id is distinct from new.category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  return new;
end $$;

create trigger trg_menu_items_subcategory_category_match
  before insert or update of category_id, subcategory_id on public.menu_items
  for each row
  execute function public.enforce_menu_item_subcategory_category_match();

revoke all on function public.enforce_menu_item_subcategory_category_match() from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 4. assert_subcategory_role -- même patron que assert_category_role/
--    assert_product_role, résolution sous-catégorie -> catégorie ->
--    restaurant.
-- ------------------------------------------------------------------

create function public.assert_subcategory_role(
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
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this subcategory';
  end if;

  return v_restaurant_id;
end $$;

-- ------------------------------------------------------------------
-- 5. create_subcategory -- même patron que create_category (nom +
--    ordre d'affichage optionnel, ajout en fin de catégorie par
--    défaut).
-- ------------------------------------------------------------------

create function public.create_subcategory(
  p_category_id   uuid,
  p_name          text,
  p_display_order integer default null
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
  perform public.assert_category_role(p_category_id, array['owner','manager']);

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_display_order is null then
    select coalesce(max(ms.display_order), 0) + 1 into v_order
    from public.menu_subcategories ms where ms.category_id = p_category_id;
  else
    v_order := p_display_order;
  end if;

  begin
    insert into public.menu_subcategories (category_id, name, display_order)
    values (p_category_id, v_name, v_order)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SCANYM_SUBCATEGORY_DUPLICATE_NAME' using errcode = '23505';
  end;

  return v_id;
end $$;

-- ------------------------------------------------------------------
-- 6. update_subcategory -- nom + ordre d'affichage, même patron que
--    update_category (une seule RPC couvre renommage ET
--    réordonnancement -- pas de RPC d'ordre séparée, par symétrie avec
--    update_category qui n'en a jamais eu non plus).
-- ------------------------------------------------------------------

create function public.update_subcategory(
  p_subcategory_id uuid,
  p_name           text,
  p_display_order  integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  perform public.assert_subcategory_role(p_subcategory_id, array['owner','manager']);

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

  begin
    update public.menu_subcategories
    set name = v_name, display_order = p_display_order
    where id = p_subcategory_id;
  exception when unique_violation then
    raise exception 'SCANYM_SUBCATEGORY_DUPLICATE_NAME' using errcode = '23505';
  end;

  if not found then
    raise exception using errcode = 'P0002', message = 'Subcategory not found';
  end if;
end $$;

revoke all on function public.assert_subcategory_role(uuid, text[]) from public;
revoke all on function public.create_subcategory(uuid, text, integer) from public, anon;
revoke all on function public.update_subcategory(uuid, text, integer) from public, anon;
grant execute on function public.create_subcategory(uuid, text, integer) to authenticated;
grant execute on function public.update_subcategory(uuid, text, integer) to authenticated;

-- ------------------------------------------------------------------
-- 7. create_product / update_product -- suppression + recréation,
--    ajout d'un 9e paramètre optionnel p_subcategory_id (default
--    null), 100% rétrocompatible : tout appelant existant qui omet ce
--    paramètre nommé obtient exactement le comportement historique
--    (produit directement rattaché à sa catégorie). Le corps EXISTANT
--    (validation, normalisation, ordre de précédence des erreurs) est
--    repris À L'IDENTIQUE -- seule l'extension sous-catégorie est
--    ajoutée, à la toute fin, après toutes les validations baseline +
--    fiscales (modèle "baseline behavior + extensions", jamais une
--    nouvelle approximation).
-- ------------------------------------------------------------------

drop function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean);

create function public.create_product(
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
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  -- Ordre de précédence des erreurs IDENTIQUE à CATALOGUE FISCAL v1.3
  -- (nom -> prix -> description -> short_description -> fiscal ->
  -- sous-catégorie, toujours en dernier -- la sous-catégorie est
  -- purement une extension de présentation, jamais prioritaire sur
  -- une validation de contenu/prix baseline).
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

  -- CATALOGUE / SUBCATEGORIES v1 -- validation explicite, message
  -- clair, AVANT l'insertion (le trigger reste le filet de sécurité
  -- structurel, jamais la seule ligne de défense -- mandat "défense en
  -- profondeur").
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

revoke all on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid) from public, anon;
grant execute on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid) to authenticated;

drop function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean);

create function public.update_product(
  p_product_id              uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_description text;
  v_short_description text;
  v_category_id uuid;
  v_subcategory_category_id uuid;
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  select mi.category_id into v_category_id
  from public.menu_items mi where mi.id = p_product_id;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
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

  -- CATALOGUE / SUBCATEGORIES v1 -- un produit ne peut être déplacé
  -- que vers une sous-catégorie de SA PROPRE catégorie ACTUELLE
  -- (update_product ne modifie jamais category_id -- limite
  -- préexistante, inchangée par ce lot). p_subcategory_id = null
  -- replace le produit directement sous sa catégorie (mouvement
  -- subcategory -> category, mandat §16).
  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from v_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  update public.menu_items
  set name                     = v_name,
      description               = v_description,
      price                     = round(p_price, 2),
      short_description         = v_short_description,
      tax_rate                  = p_tax_rate,
      unit_weight_grams         = p_unit_weight_grams,
      weight_is_approximate     = p_weight_is_approximate,
      subcategory_id            = p_subcategory_id
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

revoke all on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid) from public, anon;
grant execute on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid) to authenticated;

-- ------------------------------------------------------------------
-- 8. get_merchant_catalogue -- même signature (uuid, boolean), returns
--    table étendu de 3 colonnes de sous-catégorie. Restructuration
--    interne en CTE "groups" : un groupe réel par sous-catégorie
--    existante de la catégorie, PLUS TOUJOURS un groupe racine
--    (subcategory_id = null) représentant les produits directement
--    rattachés à la catégorie -- présent même si la catégorie n'a
--    AUCUNE sous-catégorie, ce qui reproduit EXACTEMENT le
--    comportement/nombre de lignes historique pour tout commerçant
--    sans sous-catégorie (aucune régression, voir harnais section
--    [régression get_merchant_catalogue] et rapport de non-régression).
--
--    Tri déterministe (mandat §10, "subcategory ordering must be
--    deterministic") : catégorie (ordre, nom) -> groupe racine
--    toujours avant les sous-catégories -> sous-catégories entre elles
--    par leur propre ordre d'affichage puis nom -> produits du groupe
--    par leur propre ordre d'affichage puis nom.
-- ------------------------------------------------------------------

drop function public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
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

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) then
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

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------
-- 9. VÉRIFICATION POST-APPLICATION -- TOUJOURS AVANT commit; (patron
--    établi par RECEIPT/INVOICE TAX DETAIL v1.1 et CATALOGUE FISCAL
--    v1.3 : un échec ici déclenche un ROLLBACK automatique complet,
--    aucune modification partielle ne peut jamais rester commitée).
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'menu_subcategories'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: table menu_subcategories introuvable après création.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'subcategory_id'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_items.subcategory_id introuvable après création.';
  end if;

  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'idx_menu_subcategories_unique_name';
  if v_count <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: index unique anti-doublon sous-catégorie introuvable.';
  end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'menu_items'
      and t.tgname = 'trg_menu_items_subcategory_category_match'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: trigger de cohérence sous-catégorie/catégorie introuvable.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean, p_subcategory_id uuid'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: nouvelle signature create_product (9 paramètres) introuvable.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_product_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean, p_subcategory_id uuid'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: nouvelle signature update_product (9 paramètres) introuvable.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_catalogue(uuid,boolean) introuvable après recréation.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_subcategory'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_subcategory introuvable.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_subcategory'
      and pg_get_function_identity_arguments(p.oid) = 'p_subcategory_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_subcategory introuvable.';
  end if;

  -- Droits : jamais anon/public sur les nouvelles RPC, jamais
  -- anon/authenticated en écriture directe sur menu_subcategories.
  if has_function_privilege('anon', 'public.create_subcategory(uuid, text, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_subcategory(uuid, text, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_merchant_catalogue(uuid, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur au moins une RPC catalogue/sous-catégorie, jamais attendu.';
  end if;

  if not has_function_privilege('authenticated', 'public.create_subcategory(uuid, text, integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.update_subcategory(uuid, text, integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_merchant_catalogue(uuid, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated n''a pas EXECUTE sur au moins une RPC catalogue/sous-catégorie.';
  end if;

  if has_table_privilege('anon', 'public.menu_subcategories', 'INSERT')
     or has_table_privilege('anon', 'public.menu_subcategories', 'UPDATE')
     or has_table_privilege('anon', 'public.menu_subcategories', 'DELETE')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'UPDATE')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'DELETE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_subcategories a un droit d''écriture direct pour anon/authenticated, jamais attendu.';
  end if;

  -- RLS toujours active.
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'menu_subcategories' and c.relrowsecurity = true;
  if v_count <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non active sur menu_subcategories.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport à l'état CATALOGUE FISCAL v1.3 :
--   + table menu_subcategories (id, category_id, name, display_order,
--     created_at), RLS + index unique anti-doublon (category_id, nom
--     normalisé), écriture exclusivement via RPC.
--   + menu_items.subcategory_id (nullable, NULL par défaut = inchangé
--     pour tout produit existant), index, trigger de cohérence avec
--     category_id.
--   + RPC assert_subcategory_role, create_subcategory, update_subcategory.
--   ~ create_product / update_product : +1 paramètre optionnel
--     p_subcategory_id (default null), rétrocompatible.
--   ~ get_merchant_catalogue : même signature, +3 colonnes
--     (subcategory_id, subcategory_name, subcategory_display_order),
--     restructuration interne en CTE "groups" garantissant zéro
--     régression de lignes/ordre pour un commerçant sans
--     sous-catégorie.
--   Aucune modification de create_order/orders/order_items/payment_*/
--   tracking. Aucune modification du prix, de la quantité, de la TVA,
--   du poids. Aucune modification de menu_categories.is_active/de
--   l'absence de RPC d'archivage catégorie.
-- ============================================================
