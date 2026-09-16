-- ============================================================
-- Scanym — CATALOGUE — COLLECTIONS / TAGS FOUNDATION v1
--
-- Étend l'architecture catalogue EXISTANTE. N'introduit ni second
-- modèle produit, ni second chemin d'import, ni troisième niveau de
-- hiérarchie.
--
-- ------------------------------------------------------------------
-- MODÈLE (décision CTO §1/§7)
-- ------------------------------------------------------------------
-- UNE seule entité canonique, `menu_tags`, propriété du tenant.
-- Un TAG est une métadonnée produit. Une COLLECTION est exactement le
-- MÊME tag, que le marchand a choisi d'exposer sur le menu client
-- (`visible_on_customer_menu = true`). Il n'existe donc jamais deux
-- taxonomies à tenir synchronisées.
--
-- La configuration de visibilité vit en COLONNES sur `menu_tags`
-- plutôt que dans une table 1:1 dédiée : une table séparée n'aurait
-- porté que 2 colonnes pour exactement une ligne par tag, sans rien
-- rendre possible de plus. `label_override` n'est PAS introduit (le
-- mandat ne l'autorise que « if cleanly justified ») : les tags étant
-- déjà locaux au tenant (§2), un marchand renomme simplement SON tag.
--
-- Hiérarchie (§7), strictement préservée :
--   catégorie / sous-catégorie = hiérarchie du catalogue ;
--   tag / collection           = classification TRANSVERSALE.
-- Un produit a 1 catégorie, 0 ou 1 sous-catégorie, 0..N tags. Aucun
-- tag n'est jamais une catégorie, et `menu_items` n'est pas touchée.
--
-- ------------------------------------------------------------------
-- PORTÉE TENANT (§2)
-- ------------------------------------------------------------------
-- `menu_tags.restaurant_id` est NOT NULL : aucun tag global partagé.
-- Deux établissements utilisant « Bio » possèdent deux lignes
-- distinctes -- visibilité, ordre et renommage futurs indépendants.
--
-- ------------------------------------------------------------------
-- CLÉ NORMALISÉE -- parité TS/SQL prouvée, jamais approximée
-- ------------------------------------------------------------------
-- `normalized_key` est une colonne GÉNÉRÉE STOCKÉE :
--   lower(btrim(name, E' \t\n\r\f' || chr(11)))
-- C'est EXACTEMENT la règle de lib/catalogue-import/normalization.ts
-- ::normalizedKey (qui applique lib/catalogue-text.ts::normalizeText,
-- jeu de 6 caractères d'espace en BORDURE uniquement, puis
-- toLowerCase) et EXACTEMENT celle des index uniques partiels déjà en
-- place sur menu_categories (migration-v66) et menu_subcategories
-- (OPERATOR CATALOGUE RESET v1.2). Ni retrait d'accent, ni
-- normalisation des espaces internes : « Café » et « Cafe » restent
-- deux tags DIFFÉRENTS, comme partout ailleurs dans ce catalogue.
--
-- La colonne est GÉNÉRÉE, donc elle ne peut pas dériver du `name` :
-- aucune RPC ne peut l'écrire, aucune divergence n'est représentable.
--
-- ------------------------------------------------------------------
-- IDEMPOTENCE (§8)
-- ------------------------------------------------------------------
-- Même modèle de convergence que l'importateur actuel : la sécurité
-- est STRUCTURELLE (contrainte serveur), jamais un « vérifier puis
-- écrire » applicatif.
--   - index unique PARTIEL (restaurant_id, normalized_key) where
--     is_active -- même patron que idx_menu_categories_unique_active_
--     name : un tag actif et un tag désactivé peuvent porter le même
--     nom, exactement comme pour les catégories ;
--   - `menu_item_tags` a une clé primaire COMPOSITE
--     (menu_item_id, tag_id) et les associations passent par
--     `on conflict do nothing` -- réimporter « Bio; Truffe » dix fois
--     ne crée ni tag en double, ni association en double.
--
-- ------------------------------------------------------------------
-- ISOLATION TENANT (§9)
-- ------------------------------------------------------------------
-- RLS activée sur les 2 tables, AUCUNE policy d'écriture, et AUCUNE
-- policy de lecture directe : tout accès passe par les RPC
-- SECURITY DEFINER ci-dessous, qui portent seules la règle
-- d'autorisation. Même discipline que menu_subcategories (aucune
-- policy INSERT/UPDATE/DELETE, écritures exclusivement par RPC).
-- Chaque RPC re-dérive le restaurant_id depuis la LIGNE CIBLE en base
-- (jamais depuis un paramètre client) avant d'autoriser quoi que ce
-- soit.
--
-- ------------------------------------------------------------------
-- AUTORISATION (§3) -- marchand ET opérateur, jamais opérateur seul
-- ------------------------------------------------------------------
-- `assert_tag_admin` : owner/manager du restaurant via
-- restaurant_users (patron assert_category_role, migration-v66) OU
-- opérateur Scanym via is_scanym_operator() (patron OB-2). Le
-- marchand décide quels tags deviennent des collections ; l'opérateur
-- peut le faire pour son compte.
--
-- ------------------------------------------------------------------
-- CONTRAT DE LECTURE (§4) -- séparé, jamais dans get_merchant_catalogue
-- ------------------------------------------------------------------
-- `get_merchant_catalogue` n'est PAS étendue : y injecter un
-- many-to-many multiplierait les lignes produit × tag et ferait
-- porter un risque de régression à tous ses appelants déjà nombreux.
-- Deux RPC dédiées la remplacent, sans aucune multiplication de
-- lignes (les identifiants produits sont AGRÉGÉS en uuid[]) :
--   - get_restaurant_tags        : vue backoffice (tous les tags).
--   - get_restaurant_collections : contrat client (collections
--     visibles uniquement, ordonnées, avec leurs produits).
-- AUCUN fichier d'UI client n'est touché par ce lot.
--
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur Production par ce lot.
-- ============================================================

-- ------------------------------------------------------------------
-- 0. CONTRÔLES DE DÉRIVE -- l'état de départ attendu existe bien.
-- ------------------------------------------------------------------
do $$
begin
  if to_regclass('public.restaurants') is null
     or to_regclass('public.menu_items') is null
     or to_regclass('public.menu_categories') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: table catalogue de base manquante -- lot COLLECTIONS/TAGS annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable (OB-2 requis) -- lot COLLECTIONS/TAGS annulé.';
  end if;

  if to_regclass('public.menu_tags') is not null
     or to_regclass('public.menu_item_tags') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: menu_tags/menu_item_tags existent déjà -- ce lot n''est pas conçu pour être rejoué.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 1. TABLES
-- ------------------------------------------------------------------
create table public.menu_tags (
  id                       uuid primary key default gen_random_uuid(),
  restaurant_id            uuid not null references public.restaurants(id) on delete cascade,
  name                     text not null,
  normalized_key           text generated always as (
                             lower(btrim(name, E' \t\n\r\f' || chr(11)))
                           ) stored,
  is_active                boolean not null default true,
  visible_on_customer_menu boolean not null default false,
  display_order            integer not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint menu_tags_name_not_blank
    check (btrim(name, E' \t\n\r\f' || chr(11)) <> ''),
  constraint menu_tags_name_length
    check (char_length(name) <= 60)
);

comment on table public.menu_tags is
  'COLLECTIONS/TAGS FOUNDATION v1 -- classification TRANSVERSALE des produits, propriété du tenant (jamais partagée entre établissements). Un TAG devient une COLLECTION dès que visible_on_customer_menu = true : une seule entité, jamais deux taxonomies. N''est JAMAIS un niveau de hiérarchie du catalogue (celle-ci reste menu_categories -> menu_subcategories -> menu_items).';
comment on column public.menu_tags.normalized_key is
  'Colonne GÉNÉRÉE : lower(btrim(name, E'' \t\n\r\f'' || chr(11))). Règle STRICTEMENT identique à lib/catalogue-import/normalization.ts::normalizedKey et aux index uniques partiels de menu_categories/menu_subcategories. Générée, donc impossible à désynchroniser du nom.';
comment on column public.menu_tags.visible_on_customer_menu is
  'false = tag interne (métadonnée produit). true = COLLECTION exposée au menu client. Un tag créé par IMPORT vaut TOUJOURS false (décision CTO §1 : importer un tag ne publie jamais une collection) -- la publication est une décision marchand explicite via update_tag_collection_settings.';
comment on column public.menu_tags.is_active is
  'Même sémantique que menu_categories.is_active : false = tag retiré du catalogue actif sans perte d''historique. L''index unique est PARTIEL sur is_active, donc un tag actif et un tag désactivé peuvent porter le même nom.';

create unique index idx_menu_tags_unique_active_key
  on public.menu_tags (restaurant_id, normalized_key)
  where is_active = true;

create index idx_menu_tags_restaurant on public.menu_tags (restaurant_id);

create table public.menu_item_tags (
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  tag_id       uuid not null references public.menu_tags(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (menu_item_id, tag_id)
);

comment on table public.menu_item_tags is
  'COLLECTIONS/TAGS FOUNDATION v1 -- association many-to-many produit <-> tag. Clé primaire COMPOSITE : la ré-association du même couple est structurellement impossible (support de `on conflict do nothing`, idempotence §8). ON DELETE CASCADE des deux côtés : supprimer un produit ou un tag retire ses associations, jamais l''inverse.';

create index idx_menu_item_tags_tag on public.menu_item_tags (tag_id);

-- ------------------------------------------------------------------
-- 2. RLS -- aucun accès direct, tout passe par les RPC.
-- ------------------------------------------------------------------
alter table public.menu_tags enable row level security;
alter table public.menu_item_tags enable row level security;

revoke all on table public.menu_tags from public, anon, authenticated;
revoke all on table public.menu_item_tags from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 3. AUTORISATION -- marchand (owner/manager) OU opérateur Scanym.
-- ------------------------------------------------------------------
create or replace function public.assert_tag_admin(p_restaurant_id uuid)
returns void
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
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 4. create_tag -- création manuelle (backoffice marchand/opérateur).
--    L'unicité est tranchée par l'index, jamais par un SELECT préalable.
-- ------------------------------------------------------------------
create or replace function public.create_tag(
  p_restaurant_id uuid,
  p_name          text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_id   uuid;
begin
  perform public.assert_tag_admin(p_restaurant_id);

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if char_length(v_name) > 60 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  begin
    insert into public.menu_tags (restaurant_id, name)
    values (p_restaurant_id, v_name)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SCANYM_TAG_DUPLICATE_NAME' using errcode = '23505';
  end;

  return v_id;
end $$;

-- ------------------------------------------------------------------
-- 5. add_product_tags -- LE point d'entrée de l'importateur.
--
--    Résout-ou-crée les tags canoniques du tenant PROPRIÉTAIRE DU
--    PRODUIT (jamais un restaurant_id fourni par le client) puis
--    associe, le tout dans UNE transaction implicite par appel --
--    exactement la granularité « un appel RPC par ligne » du modèle
--    best-effort de l'importateur actuel.
--
--    STRICTEMENT ADDITIF : n'enlève JAMAIS une association existante.
--    Un tag posé à la main en backoffice survit donc à tout réimport.
--    (Le retrait est une action backoffice explicite, hors de ce
--    chemin -- un import ne supprime rien, comme partout ailleurs
--    dans ce catalogue.)
-- ------------------------------------------------------------------
create or replace function public.add_product_tags(
  p_menu_item_id uuid,
  p_tag_names    text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_raw           text;
  v_name          text;
  v_key           text;
  v_tag_id        uuid;
  v_added         integer := 0;
  v_seen          text[] := array[]::text[];
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  -- Le tenant est TOUJOURS re-dérivé depuis le produit ciblé.
  select mc.restaurant_id into v_restaurant_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_menu_item_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  perform public.assert_tag_admin(v_restaurant_id);

  foreach v_raw in array coalesce(p_tag_names, array[]::text[])
  loop
    v_name := btrim(coalesce(v_raw, ''), E' \t\n\r\f' || chr(11));
    continue when v_name = '';
    if char_length(v_name) > 60 then
      raise exception using errcode = '22023', message = 'Name too long';
    end if;

    -- Déduplication insensible à la casse À L'INTÉRIEUR de l'appel
    -- (« Bio; bio » ne doit produire qu'un seul tag), même règle que
    -- splitTagsColumn côté TypeScript.
    v_key := lower(v_name);
    continue when v_key = any (v_seen);
    v_seen := v_seen || v_key;

    select t.id into v_tag_id
    from public.menu_tags t
    where t.restaurant_id = v_restaurant_id
      and t.normalized_key = v_key
      and t.is_active = true;

    if v_tag_id is null then
      -- Création : visible_on_customer_menu reste au DÉFAUT false --
      -- importer un tag ne publie jamais une collection (§1).
      begin
        insert into public.menu_tags (restaurant_id, name)
        values (v_restaurant_id, v_name)
        returning id into v_tag_id;
      exception when unique_violation then
        -- Concurrence : un autre appel vient de créer ce même tag.
        -- La contrainte serveur a tranché ; on converge dessus.
        select t.id into v_tag_id
        from public.menu_tags t
        where t.restaurant_id = v_restaurant_id
          and t.normalized_key = v_key
          and t.is_active = true;
      end;
    end if;

    if v_tag_id is null then
      continue;
    end if;

    insert into public.menu_item_tags (menu_item_id, tag_id)
    values (p_menu_item_id, v_tag_id)
    on conflict (menu_item_id, tag_id) do nothing;

    if found then
      v_added := v_added + 1;
    end if;
  end loop;

  return v_added;
end $$;

-- ------------------------------------------------------------------
-- 6. update_tag_collection_settings -- activer/désactiver/ordonner
--    une collection. NE SUPPRIME RIEN (décision CTO §6).
-- ------------------------------------------------------------------
create or replace function public.update_tag_collection_settings(
  p_tag_id                   uuid,
  p_visible_on_customer_menu boolean,
  p_display_order            integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
begin
  select t.restaurant_id into v_restaurant_id
  from public.menu_tags t
  where t.id = p_tag_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Tag not found';
  end if;

  perform public.assert_tag_admin(v_restaurant_id);

  if p_visible_on_customer_menu is null then
    raise exception using errcode = '22023', message = 'Visibility is required';
  end if;

  -- Désactiver une collection ne touche QUE ce drapeau : le tag
  -- reste, ses associations produit restent, catégories /
  -- sous-catégories / produits ne sont jamais lus ni écrits ici.
  update public.menu_tags t
  set visible_on_customer_menu = p_visible_on_customer_menu,
      display_order            = coalesce(p_display_order, t.display_order),
      updated_at               = now()
  where t.id = p_tag_id;
end $$;

-- ------------------------------------------------------------------
-- 7. get_restaurant_tags -- lecture BACKOFFICE (marchand/opérateur).
--    Tous les tags actifs du tenant + leur configuration + le nombre
--    de produits associés. AUCUNE multiplication de lignes.
-- ------------------------------------------------------------------
create or replace function public.get_restaurant_tags(p_restaurant_id uuid)
returns table (
  id                       uuid,
  name                     text,
  normalized_key           text,
  visible_on_customer_menu boolean,
  display_order            integer,
  product_count            integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_tag_admin(p_restaurant_id);

  return query
  select t.id,
         t.name,
         t.normalized_key,
         t.visible_on_customer_menu,
         t.display_order,
         (
           select count(*)::integer
           from public.menu_item_tags mit
           join public.menu_items mi on mi.id = mit.menu_item_id
           where mit.tag_id = t.id
             and mi.archived_at is null
         )
  from public.menu_tags t
  where t.restaurant_id = p_restaurant_id
    and t.is_active = true
  order by t.display_order, t.name;
end $$;

-- ------------------------------------------------------------------
-- 8. get_restaurant_collections -- CONTRAT DE LECTURE CLIENT (§4).
--
--    Uniquement les collections VISIBLES d'un établissement PUBLIÉ,
--    ordonnées par display_order, chacune avec ses identifiants
--    produits AGRÉGÉS (uuid[]) -- jamais une ligne par produit × tag.
--    Fournit d'un coup (A) les collections ordonnées et (B) la carte
--    tag -> produits nécessaire au filtrage.
--
--    Appelable par `anon` : le menu client est public. La sécurité ne
--    vient donc PAS de l'authentification mais du filtrage interne,
--    qui reproduit exactement les conditions déjà appliquées au menu
--    public par getRestaurantBySlug (restaurants.is_active = true ET
--    restaurants.status = 'active') -- un établissement en
--    onboarding/suspendu n'expose aucune collection, même si son id
--    est connu. Les produits archivés et indisponibles sont exclus,
--    et une collection sans aucun produit visible n'est pas
--    retournée (jamais une pilule vide côté client).
--
--    Ce lot fournit le CONTRAT ; sa consommation dans l'UI client
--    appartient à Claude Monet (aucun fichier client touché ici).
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- 9. DROITS
-- ------------------------------------------------------------------
revoke all on function public.assert_tag_admin(uuid) from public, anon, authenticated;

revoke all on function public.create_tag(uuid, text) from public, anon;
grant execute on function public.create_tag(uuid, text) to authenticated;

revoke all on function public.add_product_tags(uuid, text[]) from public, anon;
grant execute on function public.add_product_tags(uuid, text[]) to authenticated;

revoke all on function public.update_tag_collection_settings(uuid, boolean, integer) from public, anon;
grant execute on function public.update_tag_collection_settings(uuid, boolean, integer) to authenticated;

revoke all on function public.get_restaurant_tags(uuid) from public, anon;
grant execute on function public.get_restaurant_tags(uuid) to authenticated;

-- Contrat client : lecture publique assumée, filtrée en interne.
revoke all on function public.get_restaurant_collections(uuid) from public;
grant execute on function public.get_restaurant_collections(uuid) to anon, authenticated;

-- ------------------------------------------------------------------
-- 10. VÉRIFICATION POST-APPLICATION -- échec = ROLLBACK automatique.
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  if to_regclass('public.menu_tags') is null or to_regclass('public.menu_item_tags') is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: table manquante.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'idx_menu_tags_unique_active_key'
      and indexdef ilike '%where%is_active%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: idx_menu_tags_unique_active_key absent ou non partiel.';
  end if;

  -- La clé primaire composite est ce qui rend l'association idempotente.
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.menu_item_tags'::regclass
      and c.contype = 'p'
      and array_length(c.conkey, 1) = 2
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: clé primaire composite manquante sur menu_item_tags.';
  end if;

  if not exists (
    select 1 from pg_attribute a
    where a.attrelid = 'public.menu_tags'::regclass
      and a.attname = 'normalized_key'
      and a.attgenerated = 's'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: normalized_key n''est pas une colonne générée stockée.';
  end if;

  -- Le défaut de publication DOIT être false (§1).
  if (
    select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_tags'
      and column_name = 'visible_on_customer_menu'
  ) not ilike '%false%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: visible_on_customer_menu doit valoir false par défaut.';
  end if;

  if not (
    select relrowsecurity from pg_class where oid = 'public.menu_tags'::regclass
  ) or not (
    select relrowsecurity from pg_class where oid = 'public.menu_item_tags'::regclass
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non activée.';
  end if;

  -- get_merchant_catalogue ne doit PAS avoir été touchée par ce lot.
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_merchant_catalogue';
  if v_def ilike '%tag%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_catalogue a été étendue avec des tags -- interdit (décision CTO §4).';
  end if;

  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_tag', 'add_product_tags', 'update_tag_collection_settings',
                        'get_restaurant_tags', 'get_restaurant_collections', 'assert_tag_admin')
  loop
    if v_def not ilike '%security definer%' or v_def not ilike '%search_path%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une RPC du lot n''est pas SECURITY DEFINER avec search_path explicite.';
    end if;
    -- Aucune RPC de ce lot ne doit pouvoir écrire dans le catalogue.
    if v_def ilike '%update public.menu_items%'
       or v_def ilike '%delete from public.menu_items%'
       or v_def ilike '%update public.menu_categories%'
       or v_def ilike '%delete from public.menu_categories%'
       or v_def ilike '%update public.menu_subcategories%'
       or v_def ilike '%delete from public.menu_subcategories%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une RPC du lot mute le catalogue -- interdit.';
    end if;
  end loop;
end $$;

-- ============================================================
-- FIN — CATALOGUE — COLLECTIONS / TAGS FOUNDATION v1
-- ============================================================
