-- ============================================================
-- Scanym LOT 1A — Fondations DB : identité, apparence, réseaux
-- sociaux, configuration des langues.
--
-- Baseline : V79 Production (V68/V69/V70 installées ; V76/préflight/
-- V71-V73 non appliquées, hors périmètre de ce lot -- ce fichier ne
-- touche à rien de la chaîne Storage/origin).
--
-- Conforme au design final validé (Lot 1, 3 tours de revue CIO) :
--   - catalogue de langues en DONNÉES DE RÉFÉRENCE (supported_languages),
--     jamais un CHECK codé en dur -- ajouter DE/ES/IT plus tard = une
--     ligne insérée, aucune migration structurelle ;
--   - restaurant_active_languages (clé étrangère vers le catalogue,
--     display_order) remplace tout text[] avec CHECK figé ;
--   - invariant source_language ∈ active_languages appliqué en RPC
--     (update_restaurant_languages), pas par contrainte cross-table ;
--   - AUCUNE colonne de traduction ici : translations JSONB, statuts,
--     switch_source_language, TranslationProvider appartiennent aux
--     Sous-lots B/C/D, explicitement hors périmètre de 1A ;
--   - bg_color réutilise intégralement le mécanisme de contraste déjà
--     audité (readableAccentOnBg/mutedOnBg côté lib/color-contrast.ts)
--     -- aucune nouvelle logique de contraste introduite ici.
--
-- Additive, non destructive : toute colonne nouvelle est nullable ou
-- a un défaut neutre reproduisant exactement le comportement V79.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Contrôle préalable (anti-dérive).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_configs'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_configs introuvable — migration LOT 1A annulée. Prérequis : schema.sql doit déjà être appliqué.';
  end if;
  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'supported_languages'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.supported_languages existe déjà — migration LOT 1A annulée pour éviter une double application. Vérifier manuellement avant de relancer.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'update_restaurant_identity', 'update_restaurant_social_links',
      'update_restaurant_languages', 'update_restaurant_bg_color'
    )
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une ou plusieurs fonctions du LOT 1A existent déjà — migration annulée. Vérifier manuellement avant de relancer.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. Catalogue des langues supportées par Scanym (donnée de
-- référence, PAS un CHECK codé en dur) -- ajouter une langue future
-- (DE/ES/IT) = une ligne insérée ici, aucune migration structurelle.
-- Jamais exposé en écriture à anon/authenticated : lecture publique
-- uniquement (nécessaire pour peupler un sélecteur de langue côté
-- Dashboard), aucune modification hors opérateur Scanym.
-- ------------------------------------------------------------

create table public.supported_languages (
  code          text primary key,
  label         text not null,
  dir           text not null check (dir in ('ltr', 'rtl')),
  display_order integer not null default 0
);

comment on table public.supported_languages is
  'Catalogue des langues supportées par Scanym (données de référence, pas un CHECK codé en dur). Ajouter une langue = une ligne insérée ici, jamais une migration structurelle. Distinct de restaurant_active_languages (langues choisies par CE commerçant) -- ne jamais confondre les deux.';

insert into public.supported_languages (code, label, dir, display_order) values
  ('fr', 'Français', 'ltr', 1),
  ('en', 'English',  'ltr', 2),
  ('nl', 'Nederlands', 'ltr', 3),
  ('ar', 'العربية',   'rtl', 4);

alter table public.supported_languages enable row level security;

create policy "supported_languages_select_all"
on public.supported_languages for select
to anon, authenticated
using (true);

grant select on public.supported_languages to anon, authenticated;
revoke insert, update, delete on public.supported_languages from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2b. Langues actives par établissement -- remplace tout text[] avec
-- CHECK figé : la clé étrangère garantit structurellement qu'aucune
-- langue non supportée n'entre jamais dans les langues actives d'un
-- établissement, sans jamais lister les codes en dur. display_order
-- couvre l'ordre d'affichage demandé par le design.
-- ------------------------------------------------------------

create table public.restaurant_active_languages (
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  language_code  text not null references public.supported_languages(code),
  display_order  integer not null default 0,
  primary key (restaurant_id, language_code)
);

comment on table public.restaurant_active_languages is
  'Langues activées par CE commerçant pour sa carte publique (distinct de supported_languages, le catalogue Scanym). display_order pilote l''ordre du sélecteur de langue public.';

create index idx_restaurant_active_languages_restaurant on public.restaurant_active_languages(restaurant_id);

alter table public.restaurant_active_languages enable row level security;

-- Lecture publique nécessaire : la carte publique (app/r/[slug]) est
-- consultée sans authentification et doit connaître les langues
-- actives pour peupler LanguageSelector.
create policy "restaurant_active_languages_select_public"
on public.restaurant_active_languages for select
to anon, authenticated
using (true);

-- Corrige un oubli détecté en test réel : une policy RLS SELECT ne
-- suffit PAS sans le GRANT SELECT de base sur la table -- PostgreSQL
-- exige les deux (privilège de table ET ligne autorisée par RLS).
-- Reproduit ("permission denied for table restaurant_active_languages")
-- puis corrigé avant d'aller plus loin.
grant select on public.restaurant_active_languages to anon, authenticated;

-- Écriture réservée à la RPC SECURITY DEFINER ci-dessous -- aucun
-- accès direct table pour authenticated (jamais de contournement RLS
-- pour "faire fonctionner" une fonction, conformément à la checklist
-- erreurs classiques).
revoke insert, update, delete on public.restaurant_active_languages from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2c. RÉCONCILIATION avec le mécanisme déjà en production (Lot D,
-- migration-lotd-establishment-creation.sql) -- découverte pendant le
-- développement de ce lot, PAS anticipée par le design initial. Cette
-- migration NE RÉÉCRIT PAS ce fichier déjà appliqué en production :
-- elle le complète, comme V71 avait complété V70.
--
-- Lot D avait déjà ajouté restaurant_configs.source_language (CHECK
-- codé en dur 'fr'/'en'/'ar') et .enabled_languages (text[], même
-- CHECK figé), utilisés par create_establishment() -- déjà consommé
-- en production par lib/services/establishments.ts. Le catalogue
-- supported_languages/restaurant_active_languages remplace désormais
-- CES DEUX CHECK figés par une référence au catalogue -- l'objectif
-- "ajouter une langue sans migration structurelle" s'applique aussi à
-- la création d'établissement, pas seulement à la configuration
-- après coup.
--
-- enabled_languages (colonne) N'EST PAS supprimée : elle reste remplie
-- par create_establishment (compatibilité), mais n'est plus la source
-- de vérité pour rien de nouveau -- restaurant_active_languages est
-- désormais l'unique référence pour LanguageSelector/Dashboard/
-- update_restaurant_languages. Migration de données : chaque valeur
-- déjà présente dans enabled_languages (PAS seulement 'fr' -- un
-- établissement existant avec ['fr','ar'] doit conserver 'ar' actif,
-- vérifié explicitement par test) est reportée dans
-- restaurant_active_languages, dans l'ordre du tableau existant.
-- ------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'enabled_languages'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.enabled_languages introuvable — migration LOT 1A annulée. Prérequis attendu (Lot D) absent ou déjà modifié de façon inattendue.';
  end if;
end $$;

insert into public.restaurant_active_languages (restaurant_id, language_code, display_order)
select rc.restaurant_id, lang, ord
from public.restaurant_configs rc,
     unnest(rc.enabled_languages) with ordinality as u(lang, ord)
where lang in (select code from public.supported_languages)
on conflict (restaurant_id, language_code) do nothing;

-- Établissement dont enabled_languages contiendrait (par anomalie
-- passée) une valeur hors catalogue : garantit au moins 'fr' actif,
-- jamais un établissement sans aucune langue active après migration.
insert into public.restaurant_active_languages (restaurant_id, language_code, display_order)
select rc.restaurant_id, 'fr', 1
from public.restaurant_configs rc
where not exists (
  select 1 from public.restaurant_active_languages ral where ral.restaurant_id = rc.restaurant_id
);

alter table public.restaurant_configs
  drop constraint if exists restaurant_configs_source_language_check,
  drop constraint if exists restaurant_configs_enabled_languages_chk;

alter table public.restaurant_configs
  add constraint restaurant_configs_source_language_fkey
  foreign key (source_language) references public.supported_languages(code);

comment on column public.restaurant_configs.enabled_languages is
  'Lot D (historique) — figé par create_establishment() à la création. N''EST PLUS la source de vérité : restaurant_active_languages (LOT 1A) pilote désormais LanguageSelector/Dashboard/update_restaurant_languages. Conservée pour compatibilité, jamais lue par le nouveau code.';

-- ------------------------------------------------------------
-- 2c-bis. create_establishment redéfinie (MÊME SIGNATURE) : valide
-- désormais p_source_language/p_enabled_languages contre le catalogue
-- supported_languages au lieu du tableau figé 'fr'/'en'/'ar', et
-- alimente aussi restaurant_active_languages en plus de
-- enabled_languages (compatibilité). Tout le reste de la fonction
-- (validation whatsapp/devise/email/catégorie, insertion restaurants/
-- restaurant_configs/establishment_owner_invitations) reste
-- STRICTEMENT identique à la version Lot D -- seule la validation des
-- langues et l'alimentation du catalogue changent.
-- ------------------------------------------------------------

create or replace function public.create_establishment(
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
  v_unsupported text;
  v_lang text;
  v_position integer;
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

  -- Corrige la réconciliation LOT 1A (2c) : validation contre le
  -- catalogue supported_languages, plus le tableau figé 'fr'/'en'/'ar'
  -- de Lot D -- ajouter une langue au catalogue rend immédiatement
  -- possible la création d'un établissement dans cette langue, sans
  -- toucher à cette fonction.
  if p_source_language is null or not exists (select 1 from public.supported_languages where code = p_source_language) then
    raise exception 'SCANYM_INVALID_LANGUAGE' using errcode = '22023';
  end if;
  if p_enabled_languages is null or array_length(p_enabled_languages, 1) is null then
    raise exception 'SCANYM_INVALID_LANGUAGE' using errcode = '22023';
  end if;
  if array_length(p_enabled_languages, 1) != (select count(distinct x) from unnest(p_enabled_languages) as x) then
    raise exception 'SCANYM_INVALID_LANGUAGE' using errcode = '22023';
  end if;
  select string_agg(x, ', ') into v_unsupported
  from unnest(p_enabled_languages) as x
  where x not in (select code from public.supported_languages);
  if v_unsupported is not null then
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

  -- Corrige la réconciliation LOT 1A (2c) : alimente désormais aussi
  -- restaurant_active_languages, source de vérité pour tout le
  -- nouveau code (LanguageSelector, Dashboard, update_restaurant_languages).
  v_position := 1;
  foreach v_lang in array p_enabled_languages loop
    insert into public.restaurant_active_languages (restaurant_id, language_code, display_order)
    values (v_restaurant_id, v_lang, v_position);
    v_position := v_position + 1;
  end loop;

  if v_category_name is not null then
    insert into public.menu_categories (restaurant_id, name, display_order, is_active)
    values (v_restaurant_id, v_category_name, 1, true);
  end if;

  insert into public.establishment_owner_invitations (restaurant_id, email, status)
  values (v_restaurant_id, v_owner_email, 'pending');

  return query select v_restaurant_id, v_slug, 'onboarding'::text;
end $$;

-- Droits préservés par CREATE OR REPLACE FUNCTION à signature
-- identique (vérifié empiriquement) -- réaffirmés ici explicitement
-- pour que ce fichier documente intégralement la posture de sécurité
-- de la fonction qu'il redéfinit, sans dépendre implicitement de
-- migration-lotd-establishment-creation.sql.
revoke all on function public.create_establishment(
  text, text, text, text, text, text, text, text, text, text[], text, text, text, text
) from public, anon;
grant execute on function public.create_establishment(
  text, text, text, text, text, text, text, text, text, text[], text, text, text, text
) to authenticated;

-- ------------------------------------------------------------
-- 2d. Colonnes identité / apparence / réseaux sociaux / langue
-- source -- toutes additives, nullable ou défaut neutre.
-- ------------------------------------------------------------

alter table public.restaurant_configs
  add column if not exists display_name       text,
  add column if not exists intro_text         text,
  add column if not exists announcement_text  text,
  add column if not exists announcement_active boolean not null default false,
  add column if not exists bg_color           text,
  add column if not exists instagram_url      text,
  add column if not exists tiktok_url         text,
  add column if not exists facebook_url       text;

-- source_language existe déjà (Lot D) -- traitée en section 2c
-- ci-dessus (ancien CHECK figé retiré, clé étrangère vers le
-- catalogue ajoutée). Ne pas la redéclarer ici : "add column if not
-- exists" serait un no-op silencieux qui laisserait croire, à tort, à
-- une lecture rapide de ce fichier, que la clé étrangère vient de
-- cette ligne plutôt que de la section 2c.

comment on column public.restaurant_configs.display_name is
  'Nom affiché de l''établissement sur la carte publique (LOT 1A). NULL = repli sur restaurants.name (comportement V79 inchangé). Jamais traduit (décision CIO Lot 1) : identique dans toutes les langues.';
comment on column public.restaurant_configs.intro_text is
  'Texte de présentation multiligne, langue source uniquement (LOT 1A). Traductions : Sous-lot B, hors périmètre ici. NULL = pas de texte affiché.';
comment on column public.restaurant_configs.announcement_text is
  'Message temporaire/actualité, langue source uniquement (LOT 1A). Voir announcement_active pour l''état affiché/masqué -- jamais supprimé/recréé, juste désactivé.';
comment on column public.restaurant_configs.announcement_active is
  'Bascule affiché/masqué du message temporaire, indépendante du contenu (LOT 1A). false par défaut : aucun établissement existant ne voit apparaître un message non désiré.';
comment on column public.restaurant_configs.bg_color is
  'Couleur de fond personnalisée (LOT 1A), #RRGGBB strict. Surcharge --sc-bg (lib/themes.ts), réutilise le mécanisme de contraste déjà audité (readableAccentOnBg/mutedOnBg) sans nouvelle logique. NULL = fond du thème par défaut, rendu V79 strictement inchangé.';
comment on column public.restaurant_configs.instagram_url is
  'URL Instagram (LOT 1A). Validée serveur : https strict, domaine instagram.com/www.instagram.com exact. NULL = icône non affichée.';
comment on column public.restaurant_configs.tiktok_url is
  'URL TikTok (LOT 1A). Validée serveur : https strict, domaine tiktok.com/www.tiktok.com exact, chemin @handle. NULL = icône non affichée.';
comment on column public.restaurant_configs.facebook_url is
  'URL Facebook (LOT 1A). Validée serveur : https strict, domaine facebook.com/www.facebook.com exact. NULL = icône non affichée.';
comment on column public.restaurant_configs.source_language is
  'Langue source du contenu de cet établissement -- colonne héritée de Lot D (migration-lotd-establishment-creation.sql), dont la contrainte CHECK figée est remplacée par LOT 1A par une clé étrangère vers supported_languages (voir section 2c). Doit toujours appartenir aux langues actives (restaurant_active_languages) -- invariant appliqué en RPC (update_restaurant_languages, create_establishment), pas par contrainte cross-table. FR par défaut : comportement V79 inchangé pour tout établissement existant. Changement de langue source après création : Sous-lot C (switch_source_language), hors périmètre ici -- cette colonne reste donc en LECTURE SEULE après création dans ce lot (aucune RPC de bascule fournie).';

-- ------------------------------------------------------------
-- 2e. update_restaurant_identity -- nom affiché, introduction,
-- message temporaire. Même modèle que update_restaurant_colors :
-- owner/manager uniquement, réglages cosmétiques hors périmètre
-- Storage multi-établissement.
-- ------------------------------------------------------------

create function public.update_restaurant_identity(
  p_restaurant_id       uuid,
  p_display_name        text,
  p_intro_text          text,
  p_announcement_text   text,
  p_announcement_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name      text;
  v_intro_text        text;
  v_announcement_text text;
begin
  -- Corrige la cohérence avec le patron établi F-01 Super Admin
  -- (V70) : réutilise assert_restaurant_asset_role (déjà audité),
  -- owner/manager OU opérateur Scanym -- même posture que
  -- update_restaurant_colors/update_restaurant_maps_url, dont ces
  -- champs identité/apparence/réseaux sociaux sont la même classe de
  -- réglage. Jamais un contrôle manuel réinventé.
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_display_name      := nullif(btrim(coalesce(p_display_name, ''), E' \t\n\r\f' || chr(11)), '');
  v_intro_text        := nullif(btrim(coalesce(p_intro_text, ''), E' \t\n\r\f' || chr(11)), '');
  v_announcement_text := nullif(btrim(coalesce(p_announcement_text, ''), E' \t\n\r\f' || chr(11)), '');

  if v_display_name is not null and length(v_display_name) > 255 then
    raise exception using errcode = '22023', message = 'Display name too long (max 255 characters)';
  end if;
  if v_intro_text is not null and length(v_intro_text) > 2000 then
    raise exception using errcode = '22023', message = 'Intro text too long (max 2000 characters)';
  end if;
  if v_announcement_text is not null and length(v_announcement_text) > 500 then
    raise exception using errcode = '22023', message = 'Announcement text too long (max 500 characters)';
  end if;

  update public.restaurant_configs
  set display_name        = v_display_name,
      intro_text          = v_intro_text,
      announcement_text   = v_announcement_text,
      announcement_active = coalesce(p_announcement_active, false)
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_identity(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.update_restaurant_identity(uuid, text, text, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 2f. update_restaurant_bg_color -- réutilise EXACTEMENT le format
-- déjà validé pour primary/secondary/accent_color (V69), aucune
-- nouvelle grammaire de couleur.
-- ------------------------------------------------------------

create function public.update_restaurant_bg_color(
  p_restaurant_id uuid,
  p_bg_color      text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bg text;
begin
  -- Corrige la cohérence avec le patron établi F-01 Super Admin
  -- (V70) : réutilise assert_restaurant_asset_role (déjà audité),
  -- owner/manager OU opérateur Scanym -- même posture que
  -- update_restaurant_colors/update_restaurant_maps_url, dont ces
  -- champs identité/apparence/réseaux sociaux sont la même classe de
  -- réglage. Jamais un contrôle manuel réinventé.
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_bg := nullif(btrim(coalesce(p_bg_color, '')), '');

  if v_bg is not null and v_bg !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception using errcode = '22023', message = 'Invalid background color format: expected #RRGGBB';
  end if;

  update public.restaurant_configs
  set bg_color = v_bg
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_bg_color(uuid, text) from public, anon;
grant execute on function public.update_restaurant_bg_color(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 2g. update_restaurant_social_links -- validation HTTPS + domaine
-- exact SERVEUR (jamais seulement côté UI), un réseau par champ,
-- résistante aux sous-domaines trompeurs, credentials, ports
-- inhabituels, espaces/retours ligne, query/fragment.
-- ------------------------------------------------------------

create function public.update_restaurant_social_links(
  p_restaurant_id  uuid,
  p_instagram_url  text,
  p_tiktok_url     text,
  p_facebook_url   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instagram text;
  v_tiktok    text;
  v_facebook  text;
begin
  -- Corrige la cohérence avec le patron établi F-01 Super Admin
  -- (V70) : réutilise assert_restaurant_asset_role (déjà audité),
  -- owner/manager OU opérateur Scanym -- même posture que
  -- update_restaurant_colors/update_restaurant_maps_url, dont ces
  -- champs identité/apparence/réseaux sociaux sont la même classe de
  -- réglage. Jamais un contrôle manuel réinventé.
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_instagram := nullif(p_instagram_url, '');
  v_tiktok    := nullif(p_tiktok_url, '');
  v_facebook  := nullif(p_facebook_url, '');

  -- Corrige la même classe d'erreur déjà rencontrée pour maps_url
  -- (V72-06) : la chaîne BRUTE est validée, jamais nettoyée/trim
  -- silencieusement avant validation -- un espace en tête/fin est
  -- refusé explicitement, pas ignoré.
  if v_instagram is not null and (
    v_instagram !~ '^https://(www\.)?instagram\.com/[A-Za-z0-9._]{1,30}/?$'
  ) then
    raise exception using errcode = '22023', message = 'Invalid Instagram URL: must be https://instagram.com/<username> or https://www.instagram.com/<username>';
  end if;

  if v_tiktok is not null and (
    v_tiktok !~ '^https://(www\.)?tiktok\.com/@[A-Za-z0-9._]{1,30}/?$'
  ) then
    raise exception using errcode = '22023', message = 'Invalid TikTok URL: must be https://tiktok.com/@<username> or https://www.tiktok.com/@<username>';
  end if;

  if v_facebook is not null and (
    v_facebook !~ '^https://(www\.)?facebook\.com/[A-Za-z0-9.]{1,50}/?$'
  ) then
    raise exception using errcode = '22023', message = 'Invalid Facebook URL: must be https://facebook.com/<page> or https://www.facebook.com/<page>';
  end if;

  update public.restaurant_configs
  set instagram_url = v_instagram,
      tiktok_url    = v_tiktok,
      facebook_url  = v_facebook
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_social_links(uuid, text, text, text) from public, anon;
grant execute on function public.update_restaurant_social_links(uuid, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 2h. update_restaurant_languages -- remplace ATOMIQUEMENT
-- l'ensemble des langues actives d'un établissement (delete + insert
-- dans la même transaction implicite de fonction). Impose
-- l'invariant source_language ∈ langues actives : refuse si la
-- langue source n'est pas incluse dans la liste fournie, refuse
-- toute langue absente de supported_languages (portée par la clé
-- étrangère elle-même -- l'INSERT échouerait de toute façon, mais un
-- message explicite est préférable à une erreur de contrainte brute).
-- ------------------------------------------------------------

create function public.update_restaurant_languages(
  p_restaurant_id     uuid,
  p_language_codes    text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_language text;
  v_code            text;
  v_position        integer;
  v_unsupported     text;
begin
  -- Corrige la cohérence avec le patron établi F-01 Super Admin
  -- (V70) : réutilise assert_restaurant_asset_role (déjà audité),
  -- owner/manager OU opérateur Scanym -- même posture que
  -- update_restaurant_colors/update_restaurant_maps_url, dont ces
  -- champs identité/apparence/réseaux sociaux sont la même classe de
  -- réglage. Jamais un contrôle manuel réinventé.
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  if p_language_codes is null or array_length(p_language_codes, 1) is null or array_length(p_language_codes, 1) = 0 then
    raise exception using errcode = '22023', message = 'At least one active language is required';
  end if;

  if array_length(p_language_codes, 1) != (select count(distinct x) from unnest(p_language_codes) as x) then
    raise exception using errcode = '22023', message = 'Duplicate language codes are not allowed';
  end if;

  select string_agg(x, ', ') into v_unsupported
  from unnest(p_language_codes) as x
  where x not in (select code from public.supported_languages);

  if v_unsupported is not null then
    raise exception using errcode = '22023', message = format('Unsupported language code(s): %s', v_unsupported);
  end if;

  select source_language into v_source_language
  from public.restaurant_configs
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;

  if not (v_source_language = any (p_language_codes)) then
    raise exception using errcode = '22023',
      message = format('Cannot remove the source language (%s) from active languages', v_source_language);
  end if;

  delete from public.restaurant_active_languages where restaurant_id = p_restaurant_id;

  v_position := 1;
  foreach v_code in array p_language_codes loop
    insert into public.restaurant_active_languages (restaurant_id, language_code, display_order)
    values (p_restaurant_id, v_code, v_position);
    v_position := v_position + 1;
  end loop;
end $$;

revoke all on function public.update_restaurant_languages(uuid, text[]) from public, anon;
grant execute on function public.update_restaurant_languages(uuid, text[]) to authenticated;

-- ------------------------------------------------------------
-- 2i. get_restaurant_active_languages -- lecture ordonnée, utilisée
-- par le Dashboard (le composant public lit directement la table via
-- la policy select_public, ce helper est un confort dashboard pour
-- obtenir langues actives + libellé/dir en un seul appel).
-- ------------------------------------------------------------

create function public.get_restaurant_active_languages(p_restaurant_id uuid)
returns table (code text, label text, dir text, display_order integer)
language sql
stable
security definer
set search_path = ''
as $$
  select sl.code, sl.label, sl.dir, ral.display_order
  from public.restaurant_active_languages ral
  join public.supported_languages sl on sl.code = ral.language_code
  where ral.restaurant_id = p_restaurant_id
  order by ral.display_order;
$$;

revoke all on function public.get_restaurant_active_languages(uuid) from public;
grant execute on function public.get_restaurant_active_languages(uuid) to anon, authenticated;

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT (voir preuve automatisée réelle dans
-- supabase/tests/v80-lot1a-check.sh) :
--  ✓ établissement V79 existant -> display_name/intro/announcement
--    NULL, bg_color NULL, source_language='fr', 1 seule langue active
--    (fr) -> rendu strictement inchangé
--  ✗ owner d'un AUTRE restaurant ne peut appeler aucune RPC ci-dessus
--  ✗ staff ne peut pas (owner/manager uniquement)
--  ✗ URL Instagram http, sous-domaine trompeur, credentials, port,
--    query, espace -> toutes refusées
--  ✗ retrait de la langue source des langues actives -> refusé
--  ✗ langue non supportée -> refusée
--  ✓ FR/EN, FR/NL/EN, AR/FR/EN -> tous acceptés, ordre respecté
-- ============================================================
