-- ============================================================
-- Scanym LOT D — Création interne d'établissement
--
-- VERSION CORRIGÉE après audit Work (verdict initial : FAIL — 5
-- findings bloquants B-01 à B-05, tous confirmés fondés par le CTO,
-- 4 acceptés tels quels, 1 reformulé pour éviter de surconstruire).
--
-- À exécuter APRÈS migration-v67b-category-description-product-order.sql.
--
-- Contenu :
--   1. Contrôle préalable de non-dérive du schéma (RÉELLEMENT EXÉCUTÉ)
--   2. Transaction unique :
--      a. restaurants : status (séquence sûre ADD → backfill → DEFAULT
--         → NOT NULL, corrige B-01), country, commerce_type, created_by
--      b. restaurant_configs : city, phone, source_language,
--         enabled_languages
--      c. Réaffirmation documentaire des droits sur restaurants,
--         PUBLIC compris (corrige B-04)
--      d. Tables de référence scanym_supported_countries/currencies
--         (allowlist métier maintenable, corrige B-05)
--      e. Table scanym_operators (liste blanche d'opérateurs internes)
--      f. Table establishment_owner_invitations (état explicite,
--         jamais de mot de passe, jamais de service_role)
--      g. RPC is_scanym_operator()
--      h. RPC create_establishment(...) — atomique, opérateur
--         uniquement, valide pays/devise contre les tables de référence
--      i. RPC link_pending_owner(...) — rattachement différé et sûr,
--         RÉELLEMENT idempotent (corrige B-02), upsert le rôle owner
--         sans jamais toucher un autre établissement (corrige B-03)
--      j. RPC get_establishment_summary(...)
--
-- WORKFLOW OWNER — inchangé, modèle déjà validé par le CTO : aucun
-- mot de passe créé/stocké, aucun service_role côté navigateur,
-- aucun appel à l'API Admin Supabase. L'établissement se crée
-- immédiatement (statut 'onboarding'), avec une invitation 'pending'.
-- Le rattachement n'a lieu que lorsque link_pending_owner() trouve,
-- PAR LECTURE SEULE, un auth.users dont l'e-mail correspond — ce
-- compte doit avoir été créé entre-temps par le CTO via le tableau de
-- bord Supabase (action opérateur hors de cette migration).
--
-- VISIBILITÉ PUBLIQUE — décision produit tranchée par le CTO après
-- l'audit : un établissement 'onboarding', 'suspended' ou 'inactive'
-- N'EST PAS accessible publiquement, même en connaissant son slug.
-- Seul 'active' l'est. lib/services/restaurant.ts (getRestaurantBySlug)
-- doit exiger `status = 'active'` EN PLUS de `is_active = true`
-- (deux mécanismes distincts : is_active est la bascule manuelle déjà
-- existante, status est le nouveau cycle de vie Lot D — les deux
-- sont requis, pas l'un ou l'autre). Aucun mode preview construit
-- dans ce lot.
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
  v_fn record;
  v_tbl record;
begin
  -- 1a. Colonnes attendues absentes (pas de doublon)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurants' and column_name in ('status', 'country', 'commerce_type', 'created_by')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une colonne Lot D existe déjà sur restaurants — migration annulée (vérifier avant de relancer).';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name in ('city', 'phone', 'source_language', 'enabled_languages')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une colonne Lot D existe déjà sur restaurant_configs — migration annulée.';
  end if;

  -- 1b. Tables attendues absentes
  if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('scanym_operators','establishment_owner_invitations','scanym_supported_countries','scanym_supported_currencies')) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une table Lot D existe déjà — migration annulée.';
  end if;

  -- 1c. RPC attendues absentes
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('is_scanym_operator','create_establishment','link_pending_owner','get_establishment_summary')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une RPC Lot D existe déjà — migration annulée.';
  end if;

  -- 1d. Forme exacte attendue de restaurants/restaurant_configs (les
  -- RPC ci-dessous s'appuient sur ces colonnes existant déjà).
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='restaurants' and column_name='slug'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurants.slug introuvable — le schéma de base a peut-être changé de forme inattendue.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='restaurant_configs' and column_name='allowed_service_modes'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.allowed_service_modes introuvable — chaîne de migrations incomplète (V29 non appliquée ?).';
  end if;

  -- 1e. Droits EFFECTIFS sur les tables sensibles concernées par ce
  -- lot — corrige B-04 (audit Work, 2 tours) : has_table_privilege()
  -- résout correctement les droits directs, via PUBLIC, ET via
  -- héritage de rôle — vérifié empiriquement sur PostgreSQL 16 avant
  -- intégration (leçon SA3-B01 réappliquée).
  --
  -- IMPORTANT — pourquoi `restaurants` n'est PAS incluse dans cette
  -- boucle de précondition d'écriture, contrairement à
  -- `restaurant_configs` : `restaurant_configs` a déjà été révoquée
  -- explicitement (migration-v39-settings.sql), donc l'absence de
  -- droit d'écriture y est une précondition VALIDE avant ce lot. Sur
  -- `restaurants`, c'est l'inverse : la découverte même qui a motivé
  -- ce lot est qu'AUCUNE révocation n'a jamais eu lieu — vérifier ici
  -- "aucun droit préexistant" ferait donc échouer la migration sur la
  -- vraie base de production, précisément l'état qu'elle doit
  -- corriger. La détection pour `restaurants` a lieu APRÈS le REVOKE
  -- (section 2a ci-dessous), où elle vérifie le RÉSULTAT de la
  -- révocation plutôt qu'une précondition impossible à satisfaire.
  for v_fn in select r as role_name from unnest(array['anon','authenticated']) as r loop
    if not has_table_privilege(v_fn.role_name, 'public.restaurants', 'SELECT') then
      raise exception 'SCANYM_SCHEMA_DRIFT: % n''a pas le droit SELECT effectif sur restaurants (menu public cassé) — migration annulée.', v_fn.role_name;
    end if;
    for v_tbl in select t as table_name from unnest(array['public.restaurant_configs']) as t loop
      if has_table_privilege(v_fn.role_name, v_tbl.table_name, 'INSERT')
        or has_table_privilege(v_fn.role_name, v_tbl.table_name, 'UPDATE')
        or has_table_privilege(v_fn.role_name, v_tbl.table_name, 'DELETE') then
        raise exception 'SCANYM_SCHEMA_DRIFT: % dispose d''un droit d''écriture EFFECTIF préexistant sur % — migration annulée, à examiner avant de relancer.', v_fn.role_name, v_tbl.table_name;
      end if;
    end loop;
  end loop;
end $$;


-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- 2a. Droits sur restaurants — réaffirmation documentaire de
-- l'INSERT/UPDATE/DELETE direct, jamais explicitement révoqués avant
-- ce lot. Corrige B-04 (audit Work, 2 tours) : révoque aussi
-- explicitement PUBLIC, pas seulement anon/authenticated — un GRANT
-- accordé un jour à PUBLIC serait autrement hérité par tous les rôles
-- qui en découlent, y compris de futurs rôles non encore créés.
-- SELECT reste intact (menu public via policy dédiée, voir plus bas) :
-- cette révocation ne retire jamais un droit de LECTURE nécessaire à
-- l'application existante.
revoke insert, update, delete on table public.restaurants from anon, authenticated, public;

-- Vérification POST-REVOKE — corrige le 2e tour d'audit Work sur B-04.
-- Un REVOKE direct sur un rôle ne retire JAMAIS un privilège que ce
-- rôle obtient par HÉRITAGE (appartenance à un autre rôle qui, lui,
-- détient le privilège) : par exemple `grant insert on restaurants to
-- test_writer; grant test_writer to authenticated;` laisserait
-- authenticated avec un droit INSERT effectif malgré le REVOKE direct
-- ci-dessus. has_table_privilege() résout correctement ce cas
-- (vérifié empiriquement, voir le harnais de tests) : s'il détecte
-- encore un droit effectif après la révocation directe, la migration
-- ÉCHOUE EXPLICITEMENT ici — elle ne tente JAMAIS de deviner ou de
-- révoquer un rôle parent inconnu à sa place (pourrait casser un rôle
-- externe légitime sans rapport avec ce lot). Détecter et bloquer,
-- jamais corriger automatiquement à l'aveugle.
do $$
declare
  v_role text;
  v_priv text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(v_role, 'public.restaurants', v_priv) then
        raise exception 'SCANYM_SCHEMA_DRIFT: % dispose encore du droit % EFFECTIF sur restaurants après révocation directe — probablement hérité via un rôle parent non identifié. Migration annulée : examiner et corriger manuellement ce rôle parent avant de relancer (jamais de correction automatique d''un rôle externe inconnu).', v_role, v_priv;
      end if;
    end loop;
  end loop;
end $$;

-- 2b. restaurants — identité et cycle de vie.
--
-- Corrige B-01 (audit Work) : `add column status text not null
-- default 'onboarding'` ferait passer TOUTES les lignes existantes
-- (Illico Presto, Sirocco, etc.) à 'onboarding' au moment même de la
-- migration -- une réinterprétation SILENCIEUSE de données de
-- production réelles, précisément ce que la règle de préservation
-- sémantique des données historiques interdit. Séquence sûre :
--   1. ADD COLUMN nullable, SANS default
--   2. BACKFILL explicite des lignes existantes à 'active'
--   3. DEFAULT 'onboarding' -- s'applique seulement aux INSERT futurs
--   4. NOT NULL -- sûr maintenant, aucune ligne n'est plus NULL
alter table public.restaurants
  add column if not exists status text,
  add column if not exists country text,
  add column if not exists commerce_type text
    check (commerce_type in ('restaurant','cafe','cheese_shop','bakery','pastry_shop','hotel','bar','other')),
  add column if not exists created_by uuid references auth.users(id);

update public.restaurants set status = 'active' where status is null;

alter table public.restaurants
  alter column status set default 'onboarding';

alter table public.restaurants
  add constraint restaurants_status_chk
  check (status in ('onboarding', 'active', 'suspended', 'inactive'));

alter table public.restaurants
  alter column status set not null;

-- 2c. restaurant_configs — localisation, contact, langues.
alter table public.restaurant_configs
  add column if not exists city text,
  add column if not exists phone text,
  add column if not exists source_language text not null default 'fr'
    check (source_language in ('fr', 'en', 'ar')),
  add column if not exists enabled_languages text[] not null default '{fr}';

alter table public.restaurant_configs
  add constraint restaurant_configs_enabled_languages_chk
  check (
    array_length(enabled_languages, 1) > 0
    and enabled_languages <@ array['fr','en','ar']::text[]
  );

-- 2d. Allowlist métier des pays/devises supportés par Scanym —
-- corrige B-05 (audit Work, reformulation CTO). Ni une infrastructure
-- ISO exhaustive embarquée (explicitement écartée), ni un simple
-- format regex (insuffisant : "ZZ"/"ZZZ" le satisferaient). Deux
-- petites tables de référence, étendables par un simple INSERT (pas
-- une migration de schéma) quand Scanym ouvre un nouveau marché.
-- Utilisées de façon cohérente par la validation SQL
-- (create_establishment), l'UI (menus déroulants alimentés depuis les
-- mêmes codes, voir lib/establishment-text.ts) et les tests (un test
-- dédié vérifie que la liste TypeScript reste synchronisée avec le
-- contenu réel de ces tables). AUCUN couplage pays → devise : les
-- deux tables sont indépendantes, validées séparément.
--
-- Liste de lancement (marchés réellement visés à ce stade, comme
-- demandé) : Algérie, France, Tunisie, Maroc pour les pays ; DZD,
-- EUR, TND, MAD, USD pour les devises (USD ajouté comme devise de
-- référence internationale, sans pays associé dans cette liste —
-- confirme explicitement l'absence de couplage). Étendre cette liste
-- plus tard ne nécessite qu'un INSERT, jamais un ALTER TABLE.
create table public.scanym_supported_countries (
  code  text primary key check (code ~ '^[A-Z]{2}$'),
  name  text not null
);
revoke insert, update, delete on table public.scanym_supported_countries from anon, authenticated, public;
grant select on table public.scanym_supported_countries to authenticated;

create table public.scanym_supported_currencies (
  code  text primary key check (code ~ '^[A-Z]{3}$'),
  name  text not null
);
revoke insert, update, delete on table public.scanym_supported_currencies from anon, authenticated, public;
grant select on table public.scanym_supported_currencies to authenticated;

insert into public.scanym_supported_countries (code, name) values
  ('DZ', 'Algérie'),
  ('FR', 'France'),
  ('TN', 'Tunisie'),
  ('MA', 'Maroc');

insert into public.scanym_supported_currencies (code, name) values
  ('DZD', 'Dinar algérien'),
  ('EUR', 'Euro'),
  ('TND', 'Dinar tunisien'),
  ('MAD', 'Dirham marocain'),
  ('USD', 'Dollar américain');

-- Contrainte différée jusqu'ici (nécessite la table ci-dessus).
-- `country` reste NULLABLE : les établissements historiques n'ont
-- jamais eu ce champ et ne sont JAMAIS renseignés automatiquement ici
-- (aucune valeur inventée pour eux) — une clé étrangère NULL est
-- toujours valide, la contrainte ne s'applique donc qu'aux valeurs
-- réellement fournies pour les NOUVEAUX établissements.
alter table public.restaurants
  add constraint restaurants_country_fk
  foreign key (country) references public.scanym_supported_countries(code);

-- restaurant_configs.currency est une colonne PRÉEXISTANTE (avant ce
-- lot), déjà peuplée pour tous les établissements historiques.
-- Volontairement AUCUNE contrainte FK ajoutée dessus ici : le
-- contenu réel de cette colonne pour les lignes existantes n'est pas
-- connu avec certitude depuis ce fichier de migration, et lui
-- imposer une contrainte a posteriori risquerait exactement le même
-- type de dérive que B-01 (une valeur historique légitime mais
-- absente de la liste de lancement ci-dessus ferait échouer la
-- migration, ou pire, une valeur invalide déjà présente empêcherait
-- l'ALTER TABLE). La validation contre scanym_supported_currencies
-- s'applique uniquement aux NOUVELLES créations, dans
-- create_establishment ci-dessous — strictement dans le périmètre de
-- ce lot.

-- 2e. Liste blanche des opérateurs Scanym internes autorisés à créer
-- un établissement. RLS activée, AUCUNE policy : ni lecture ni
-- écriture directe pour quiconque, y compris authenticated — seules
-- les fonctions SECURITY DEFINER ci-dessous peuvent la consulter
-- (elles s'exécutent avec les privilèges du propriétaire de la
-- fonction, pas ceux de l'appelant). Alimentée manuellement par le
-- CTO via l'éditeur SQL Supabase : action opérateur documentée dans
-- le rapport de livraison, jamais exécutée par cette migration ni
-- par du code applicatif.
create table public.scanym_operators (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  note        text
);
alter table public.scanym_operators enable row level security;
revoke all on table public.scanym_operators from anon, authenticated, public;

-- 2f. Invitation propriétaire — état explicite, jamais de mot de
-- passe, jamais de secret. RLS activée, aucune policy directe : accès
-- exclusivement via les RPC ci-dessous.
create table public.establishment_owner_invitations (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  email           text not null,
  status          text not null default 'pending'
    check (status in ('pending', 'linked', 'cancelled')),
  created_at      timestamptz not null default now(),
  linked_at       timestamptz,
  linked_user_id  uuid references auth.users(id)
);
create index idx_establishment_owner_invitations_restaurant
  on public.establishment_owner_invitations(restaurant_id);
alter table public.establishment_owner_invitations enable row level security;
revoke all on table public.establishment_owner_invitations from anon, authenticated, public;

-- 2g. Fonction utilitaire : l'appelant est-il un opérateur Scanym
-- autorisé ? Utilisable côté client UNIQUEMENT pour l'affichage
-- (masquer l'entrée du menu) — jamais comme seule protection : chaque
-- RPC d'écriture ci-dessous revérifie elle-même, indépendamment de ce
-- que montre l'interface (masquage UI ≠ autorisation).
create function public.is_scanym_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.scanym_operators where user_id = auth.uid()
  );
$$;
revoke all on function public.is_scanym_operator() from public, anon;
grant execute on function public.is_scanym_operator() to authenticated;

-- 2h. Création atomique de l'établissement.
--
-- Un seul appel = une seule transaction implicite (le corps d'une
-- fonction PL/pgSQL s'exécute atomiquement) : établissement, config,
-- catégorie initiale optionnelle et invitation propriétaire réussissent
-- ou échouent ENSEMBLE, jamais d'établissement à moitié créé.
--
-- La catégorie initiale est insérée directement ici (pas via
-- create_category, qui vérifie l'appartenance de l'appelant à
-- l'établissement — l'opérateur Scanym n'est justement pas encore
-- membre de restaurant_users pour ce nouvel établissement).
create function public.create_establishment(
  p_name               text,
  p_slug               text,
  p_country            text,
  p_city               text,
  p_commerce_type      text,
  p_address            text,
  p_phone              text,
  p_whatsapp_number    text,
  p_source_language    text,
  p_enabled_languages  text[],
  p_currency           text,
  p_opening_hours      text,
  p_owner_email        text,
  p_initial_category_name text default null
)
returns table (restaurant_id uuid, slug text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_slug text;
  v_country text;
  v_city text;
  v_address text;
  v_phone text;
  v_whatsapp text;
  v_currency text;
  v_opening_hours text;
  v_owner_email text;
  v_category_name text;
  v_restaurant_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized: Scanym operator required';
  end if;

  -- Nom
  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  -- Slug : normalisé, URL-safe, minuscule, jamais réparé
  -- silencieusement — un slug mal formé est rejeté explicitement, pas
  -- corrigé à la place de l'opérateur (aucune surprise sur l'URL
  -- publique finale).
  v_slug := btrim(coalesce(p_slug, ''), E' \t\n\r\f' || chr(11));
  if v_slug = '' then
    raise exception using errcode = '22023', message = 'Slug is required';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'SCANYM_INVALID_SLUG' using errcode = '22023';
  end if;
  if length(v_slug) > 255 then
    raise exception using errcode = '22023', message = 'Slug too long';
  end if;

  -- Pays : allowlist métier (corrige B-05, audit Work). Un format
  -- ISO seul laisserait passer des codes fictifs comme "ZZ".
  v_country := upper(btrim(coalesce(p_country, ''), E' \t\n\r\f' || chr(11)));
  if v_country = '' or not exists (select 1 from public.scanym_supported_countries where code = v_country) then
    raise exception 'SCANYM_INVALID_COUNTRY' using errcode = '22023';
  end if;

  v_city := nullif(btrim(coalesce(p_city, ''), E' \t\n\r\f' || chr(11)), '');
  if v_city is not null and length(v_city) > 255 then
    raise exception using errcode = '22023', message = 'City too long';
  end if;

  if p_commerce_type is null or p_commerce_type not in
    ('restaurant','cafe','cheese_shop','bakery','pastry_shop','hotel','bar','other') then
    raise exception 'SCANYM_INVALID_COMMERCE_TYPE' using errcode = '22023';
  end if;

  v_address := nullif(btrim(coalesce(p_address, ''), E' \t\n\r\f' || chr(11)), '');

  v_phone := nullif(btrim(coalesce(p_phone, ''), E' \t\n\r\f' || chr(11)), '');
  if v_phone is not null and length(v_phone) > 50 then
    raise exception using errcode = '22023', message = 'Phone too long';
  end if;

  -- WhatsApp : même règle exacte que update_restaurant_whatsapp
  -- (migration-v64), synchronisée volontairement avec
  -- lib/whatsapp.ts (normalizeWhatsappNumber/isValidWhatsappNumber).
  v_whatsapp := regexp_replace(
    btrim(coalesce(p_whatsapp_number, ''), E' \t\n\r\f' || chr(11)),
    '[ \-]', '', 'g'
  );
  if v_whatsapp = '' then
    raise exception using errcode = '22023', message = 'WhatsApp number required';
  end if;
  if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'SCANYM_INVALID_WHATSAPP' using errcode = '22023';
  end if;

  if p_source_language is null or p_source_language not in ('fr','en','ar') then
    raise exception 'SCANYM_INVALID_LANGUAGE' using errcode = '22023';
  end if;
  if p_enabled_languages is null or array_length(p_enabled_languages, 1) is null then
    raise exception 'SCANYM_INVALID_LANGUAGE' using errcode = '22023';
  end if;
  if not (p_enabled_languages <@ array['fr','en','ar']::text[]) then
    raise exception 'SCANYM_INVALID_LANGUAGE' using errcode = '22023';
  end if;
  if not (array[p_source_language] <@ p_enabled_languages) then
    raise exception 'SCANYM_SOURCE_LANGUAGE_NOT_ENABLED' using errcode = '22023';
  end if;

  -- Devise : allowlist métier (corrige B-05, audit Work), totalement
  -- INDÉPENDANTE du pays — aucun couplage forcé pays → devise, comme
  -- explicitement tranché par le CTO (ex. un établissement au Maroc
  -- pourrait légitimement facturer en EUR).
  v_currency := upper(btrim(coalesce(p_currency, ''), E' \t\n\r\f' || chr(11)));
  if v_currency = '' or not exists (select 1 from public.scanym_supported_currencies where code = v_currency) then
    raise exception 'SCANYM_INVALID_CURRENCY' using errcode = '22023';
  end if;

  v_opening_hours := nullif(btrim(coalesce(p_opening_hours, ''), E' \t\n\r\f' || chr(11)), '');

  -- E-mail propriétaire : format simple, pas de résolution DNS/SMTP
  -- (hors périmètre), rejet explicite d'un format manifestement
  -- invalide.
  v_owner_email := lower(btrim(coalesce(p_owner_email, ''), E' \t\n\r\f' || chr(11)));
  if v_owner_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'SCANYM_INVALID_OWNER_EMAIL' using errcode = '22023';
  end if;

  v_category_name := nullif(btrim(coalesce(p_initial_category_name, ''), E' \t\n\r\f' || chr(11)), '');
  if v_category_name is not null and length(v_category_name) > 255 then
    raise exception using errcode = '22023', message = 'Category name too long';
  end if;

  -- Insertion. Le slug est UNIQUE en base (contrainte déjà existante,
  -- schema.sql) : une collision remonte ici en violation d'unicité,
  -- traduite en code stable plutôt que le texte Postgres brut.
  begin
    insert into public.restaurants (name, slug, is_active, status, country, commerce_type, created_by)
    values (v_name, v_slug, true, 'onboarding', v_country, p_commerce_type, auth.uid())
    returning id into v_restaurant_id;
  exception when unique_violation then
    raise exception 'SCANYM_SLUG_TAKEN' using errcode = '23505';
  end;

  insert into public.restaurant_configs (
    restaurant_id, currency, whatsapp_number, address, city, phone,
    opening_hours, source_language, enabled_languages
  ) values (
    v_restaurant_id, v_currency, v_whatsapp, v_address, v_city, v_phone,
    v_opening_hours, p_source_language, p_enabled_languages
  );

  if v_category_name is not null then
    insert into public.menu_categories (restaurant_id, name, display_order, is_active)
    values (v_restaurant_id, v_category_name, 1, true);
  end if;

  insert into public.establishment_owner_invitations (restaurant_id, email, status)
  values (v_restaurant_id, v_owner_email, 'pending');

  return query select v_restaurant_id, v_slug, 'onboarding'::text;
end $$;

revoke all on function public.create_establishment(
  text, text, text, text, text, text, text, text, text, text[], text, text, text, text
) from public, anon;
grant execute on function public.create_establishment(
  text, text, text, text, text, text, text, text, text, text[], text, text, text, text
) to authenticated;

-- 2i. Rattachement différé et sûr du propriétaire.
--
-- Ne crée JAMAIS de compte Supabase Auth, ne lit un mot de passe nulle
-- part : cherche seulement, en LECTURE SEULE, un auth.users existant
-- dont l'e-mail correspond exactement (insensible à la casse) à
-- celui de l'invitation en attente. Si absent, échec explicite et
-- attendu (pas une anomalie) : le CTO doit d'abord créer ce compte
-- via le tableau de bord Supabase.
create function public.link_pending_owner(
  p_restaurant_id uuid
)
returns table (linked boolean, owner_email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation record;
  v_user_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized: Scanym operator required';
  end if;

  -- La dernière invitation, quel que soit son statut -- pas
  -- seulement 'pending'. Corrige B-02 (audit Work) : un second appel
  -- après un rattachement déjà réussi doit rester réellement
  -- idempotent (même état logique renvoyé), pas échouer avec "No
  -- pending owner invitation".
  select * into v_invitation
  from public.establishment_owner_invitations
  where restaurant_id = p_restaurant_id
  order by created_at desc
  limit 1;

  if v_invitation.id is null then
    -- Cas réellement différent : aucune invitation n'a JAMAIS existé
    -- pour cet établissement (restaurant_id invalide, ou créé hors du
    -- flux normal). Reste une erreur, distincte du cas idempotent
    -- ci-dessous.
    raise exception using errcode = 'P0002', message = 'No owner invitation found for this establishment';
  end if;

  if v_invitation.status = 'linked' then
    -- IDEMPOTENCE RÉELLE (corrige B-02) : déjà rattaché par un appel
    -- précédent -- même état logique renvoyé, aucune écriture
    -- supplémentaire, aucune exception.
    return query select true, v_invitation.email;
    return;
  end if;

  if v_invitation.status = 'cancelled' then
    raise exception using errcode = 'P0002', message = 'Owner invitation was cancelled for this establishment';
  end if;

  -- status = 'pending' à partir d'ici.
  select id into v_user_id
  from auth.users
  where lower(email) = v_invitation.email
  limit 1;

  if v_user_id is null then
    -- Cas attendu, pas une anomalie : le compte Supabase Auth n'existe
    -- pas encore. Renvoie un résultat structuré (linked=false), ne
    -- lève pas d'exception -- l'opérateur doit pouvoir retenter sans
    -- que l'appelant traite ceci comme une erreur système.
    return query select false, v_invitation.email;
    return;
  end if;

  -- Corrige B-03 (audit Work) : `ON CONFLICT DO NOTHING` laisserait
  -- un utilisateur déjà staff/manager de CET établissement conserver
  -- son ancien rôle tout en marquant l'invitation comme liée --
  -- l'invariant "après rattachement réussi, le rôle est réellement
  -- owner" ne serait pas garanti. `DO UPDATE SET role = 'owner'`
  -- couvre les 4 cas : aucun membership (insertion), staff/manager sur
  -- CE MÊME établissement (promotion explicite à owner), déjà owner
  -- (réaffectation à la même valeur, sans effet). Le conflit ne peut
  -- porter que sur la clé (user_id, restaurant_id) : aucun autre
  -- établissement de cet utilisateur n'est jamais touché.
  insert into public.restaurant_users (user_id, restaurant_id, role)
  values (v_user_id, p_restaurant_id, 'owner')
  on conflict (user_id, restaurant_id) do update set role = 'owner';

  update public.establishment_owner_invitations
  set status = 'linked', linked_at = now(), linked_user_id = v_user_id
  where id = v_invitation.id;

  update public.restaurants
  set status = 'active'
  where id = p_restaurant_id and status = 'onboarding';

  return query select true, v_invitation.email;
end $$;

revoke all on function public.link_pending_owner(uuid) from public, anon;
grant execute on function public.link_pending_owner(uuid) to authenticated;

-- 2j. Résumé de l'établissement pour l'écran de confirmation et le
-- suivi de l'invitation — opérateur uniquement.
create function public.get_establishment_summary(
  p_restaurant_id uuid
)
returns table (
  restaurant_id uuid,
  name          text,
  slug          text,
  status        text,
  owner_email   text,
  owner_status  text
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
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized: Scanym operator required';
  end if;

  return query
  select r.id, r.name::text, r.slug::text, r.status,
         eoi.email, eoi.status
  from public.restaurants r
  left join lateral (
    select o.email, o.status
    from public.establishment_owner_invitations o
    where o.restaurant_id = r.id
    order by o.created_at desc
    limit 1
  ) eoi on true
  where r.id = p_restaurant_id;
end $$;

revoke all on function public.get_establishment_summary(uuid) from public, anon;
grant execute on function public.get_establishment_summary(uuid) to authenticated;

-- 2k. CYCLE DE VIE PUBLIC APPLIQUÉ PARTOUT — corrige le 2e tour
-- d'audit Work : le filtre `status = 'active'` n'était appliqué que
-- côté TypeScript (getRestaurantBySlug), pas sur les autres voies
-- publiques réelles. Recherche explicite menée dans le dépôt (grep
-- sur "is_active = true" côté SQL) : exactement 3 occurrences,
-- toutes dans des définitions successives de la MÊME fonction
-- create_order (migration-orders.sql, migration-orders-lang.sql,
-- migration-v65-order-note.sql) — la version RÉELLEMENT active
-- aujourd'hui est celle de migration-v65-order-note.sql (la dernière
-- à la redéfinir). Corrigée ci-dessous par un nouveau
-- `create or replace function` avec la MÊME signature exacte (aucun
-- changement de signature, donc aucun drop nécessaire), copiée
-- caractère pour caractère depuis sa version V65 active, à
-- l'exception de la seule condition ajoutée.
--
-- Aucune autre RPC publique ne lit `restaurants` par ailleurs
-- (mark_whatsapp_opened et set_order_status opèrent sur `orders`,
-- pas directement sur `restaurants`).

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
)
returns table (order_id uuid, order_number bigint, public_token uuid, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
begin
  -- Corrigé après audit Work (Lot D) : status = 'active' exige
  -- explicitement le workflow owner finalisé, en plus de is_active
  -- (bascule manuelle historique). Un établissement onboarding,
  -- suspended ou inactive ne doit jamais pouvoir recevoir de
  -- commande, même en connaissant son slug exact.
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  if not (p_service_mode = any (v_config.allowed_service_modes)) then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  -- Note générale (V65) : rejet explicite, aucune troncature.
  -- Une seule note globale ; il n'y a pas de note par ligne.
  --
  -- btrim(..., E' \t\n\r\f' || chr(11)) plutôt que trim(...) : jeu de
  -- caractères explicite (espace, tabulation, LF, CR, FF, VT),
  -- STRICTEMENT identique à celui utilisé côté TypeScript dans
  -- lib/order-note.ts (fonction trimNoteEdges / EDGE_WHITESPACE).
  -- trim() natif de PostgreSQL ne retirerait que l'espace ASCII et
  -- laisserait tabulations/sauts de ligne en bordure — divergence
  -- volontairement évitée plutôt que présumée absente.
  --
  -- chr(11), pas \v : \v n'est PAS un échappement reconnu dans une
  -- chaîne E'...' de PostgreSQL (seuls \b \f \n \r \t le sont ; tout
  -- le reste est pris littéralement). E'\v' produirait la lettre "v",
  -- pas la tabulation verticale U+000B — vérifié empiriquement
  -- (ascii(E'\v') = 118). chr(11) produit le vrai caractère quel que
  -- soit le moteur. Un test statique interdit toute réapparition de
  -- \v dans cette chaîne (tests/v65-order-note.test.ts).
  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  if p_service_mode = 'table' and p_table_number is null then
    raise exception 'Numéro de table requis';
  end if;

  if p_service_mode = 'delivery' then
    if v_address is null or v_phone is null then
      raise exception 'Adresse et téléphone requis pour une livraison';
    end if;
    v_postal := substring(v_address from '\m(\d{5})\M');
    if v_postal is null then
      raise exception 'Code postal absent de l''adresse';
    end if;
    select p into v_zone
    from unnest(v_config.delivery_zone_prefixes) as p
    where v_postal like p || '%'
    limit 1;
    if v_zone is null then
      raise exception 'Zone non desservie: %', v_postal;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and v_qty_total < v_config.delivery_min_items then
    raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
      v_config.delivery_min_items, v_qty_total;
  end if;

  update public.orders
  set subtotal = v_subtotal, total = v_subtotal
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal;
end $$;

revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text)
  to anon, authenticated;

-- 2l. Policy de lecture publique de `restaurants` — corrigée pour
-- respecter le cycle de vie. L'ancienne policy unique
-- ("lecture publique restaurants", using(true)) rendait TOUT
-- établissement lisible via l'API Supabase directe (PostgREST),
-- indépendamment du filtre appliqué côté TypeScript — un appel API
-- brut aurait pu contourner entièrement getRestaurantBySlug.
--
-- Remplacée par DEUX policies distinctes (RLS combine plusieurs
-- policies permissives par OR, jamais par AND) :
--   - lecture publique restaurants actifs : accessible à TOUS les
--     rôles (anon ET authenticated), mais UNIQUEMENT si
--     status='active' ET is_active=true — c'est le chemin "carte
--     publique", plus jamais un accès total ;
--   - lecture membre restaurant_users : accessible SEULEMENT à
--     authenticated, pour les établissements dont l'utilisateur est
--     réellement membre (owner/manager/staff), QUEL QUE SOIT leur
--     statut — indispensable pour que le tableau de bord commerçant
--     continue de fonctionner pendant qu'un établissement est encore
--     onboarding ou temporairement suspended : un commerçant doit
--     pouvoir voir son propre établissement même avant/pendant que
--     le workflow owner se termine.
drop policy if exists "lecture publique restaurants" on public.restaurants;

create policy "lecture publique restaurants actifs"
  on public.restaurants for select
  to public
  using (status = 'active' and is_active = true);

create policy "lecture membre restaurant_users"
  on public.restaurants for select
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurants.id and ru.user_id = auth.uid()
    )
  );

-- 2m. Policies publiques des TABLES ENFANT — corrige le 3e tour
-- d'audit Work : sécuriser `restaurants` seule ne protège PAS
-- `restaurant_configs`, `menu_categories`, `menu_items`. Leurs
-- policies historiques (schema.sql) restaient `using (true)` —
-- lisibles par QUICONQUE via l'API Supabase directe, indépendamment
-- du statut du restaurant parent, même après la correction de la
-- section 2l ci-dessus. Même patron que restaurants, EXACTEMENT
-- répliqué : deux policies séparées par table (publique restreinte à
-- active, + membre via restaurant_users), jamais une policy unique
-- mêlant les deux conditions — plus lisible et plus auditable.
--
-- Clés de rattachement VÉRIFIÉES avant modification (pas supposées) :
--   restaurant_configs.restaurant_id -> restaurants(id) directement
--   menu_categories.restaurant_id -> restaurants(id) directement
--   menu_items.category_id -> menu_categories(id) -- PAS
--     restaurant_id directement : remonter jusqu'au restaurant exige
--     une jointure via menu_categories, pas un lien direct.
--
-- Régression vérifiée avant d'écrire ces policies : le tableau de
-- bord (getMerchantCatalogue) passe par la RPC get_merchant_catalogue
-- (SECURITY DEFINER, ignore RLS, vérifie déjà l'appartenance en
-- interne) -- aucun risque de régression sur les catégories/produits
-- affichés au commerçant. En revanche, getRestaurantSettings fait un
-- SELECT direct sur restaurant_configs, dépendant RÉELLEMENT de RLS
-- -- la policy "membre" ci-dessous est donc strictement nécessaire
-- pour que la page réglages du tableau de bord continue de
-- fonctionner pour un établissement non actif.

drop policy if exists "lecture publique configs" on public.restaurant_configs;

create policy "lecture publique configs actifs"
  on public.restaurant_configs for select
  to public
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = restaurant_configs.restaurant_id
        and r.is_active = true and r.status = 'active'
    )
  );

create policy "lecture membre configs"
  on public.restaurant_configs for select
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_configs.restaurant_id
        and ru.user_id = auth.uid()
    )
  );

drop policy if exists "lecture publique categories" on public.menu_categories;

create policy "lecture publique categories actives"
  on public.menu_categories for select
  to public
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = menu_categories.restaurant_id
        and r.is_active = true and r.status = 'active'
    )
  );

create policy "lecture membre categories"
  on public.menu_categories for select
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = menu_categories.restaurant_id
        and ru.user_id = auth.uid()
    )
  );

drop policy if exists "lecture publique items" on public.menu_items;

create policy "lecture publique items actifs"
  on public.menu_items for select
  to public
  using (
    exists (
      select 1 from public.menu_categories mc
      join public.restaurants r on r.id = mc.restaurant_id
      where mc.id = menu_items.category_id
        and r.is_active = true and r.status = 'active'
    )
  );

create policy "lecture membre items"
  on public.menu_items for select
  to authenticated
  using (
    exists (
      select 1 from public.menu_categories mc
      join public.restaurant_users ru on ru.restaurant_id = mc.restaurant_id
      where mc.id = menu_items.category_id
        and ru.user_id = auth.uid()
    )
  );

commit;

-- ============================================================
-- Résumé des changements :
--   + restaurants.status (séquence ADD → backfill 'active' → DEFAULT
--     'onboarding' → NOT NULL -- corrige B-01, aucune ligne
--     historique réinterprétée)
--   + restaurants.country/commerce_type/created_by
--   + restaurant_configs.city/phone/source_language/enabled_languages
--   + revoke insert/update/delete sur restaurants pour anon,
--     authenticated ET public, avec vérification POST-REVOKE des
--     droits effectifs (détecte un héritage de rôle résiduel, échoue
--     explicitement sans jamais corriger un rôle parent inconnu à
--     l'aveugle -- corrige B-04, 2 tours d'audit)
--   + create_order redéfinie (même signature) : exige désormais
--     status='active' en plus de is_active=true -- un établissement
--     onboarding/suspended/inactive ne peut plus recevoir de
--     commande, même en connaissant son slug
--   ~ policy "lecture publique restaurants" remplacée par deux
--     policies distinctes : lecture publique restreinte aux
--     établissements status='active', + lecture membre
--     restaurant_users (authenticated, tout statut, pour que le
--     tableau de bord commerçant continue de fonctionner)
--   ~ policies publiques de restaurant_configs/menu_categories/
--     menu_items (historiquement using(true)) remplacées chacune par
--     deux policies distinctes (publique restreinte à active via
--     EXISTS sur le restaurant parent, + membre via
--     restaurant_users) -- corrige le 3e tour d'audit Work : ces
--     tables enfant restaient lisibles par quiconque via l'API
--     directe même après la correction de restaurants elle-même
--   + scanym_supported_countries/scanym_supported_currencies
--     (allowlist métier maintenable, corrige B-05, sans couplage
--     pays → devise)
--   + scanym_operators (liste blanche, alimentée manuellement par le CTO)
--   + establishment_owner_invitations (état explicite, jamais de
--     mot de passe, jamais de service_role)
--   + is_scanym_operator(), create_establishment(...) [atomique],
--     link_pending_owner(...) [lecture seule sur auth.users, jamais
--     d'écriture ; réellement idempotent -- corrige B-02 ; upsert du
--     rôle owner sans jamais toucher un autre établissement -- corrige
--     B-03], get_establishment_summary(...)
-- Aucune fonction de commande/catalogue/photo/options existante
-- modifiée. lib/restaurants-config.ts non touché (dette technique
-- confirmée non bloquante, hors périmètre de ce lot).
--
-- RAPPEL — visibilité publique (décision CTO après audit) :
-- lib/services/restaurant.ts (getRestaurantBySlug) doit exiger
-- `status = 'active'` EN PLUS de `is_active = true` pour qu'un
-- établissement soit accessible publiquement. Ce fichier SQL seul ne
-- suffit pas à garantir cette règle -- voir le patch TypeScript joint.
-- ============================================================
