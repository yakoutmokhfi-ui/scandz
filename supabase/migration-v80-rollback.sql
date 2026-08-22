-- ============================================================
-- Scanym LOT 1A — Rollback
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- ⚠️ IMPORTANT -- corrige un défaut réel trouvé par le harnais PostgreSQL
-- pendant le développement (rollback -> réapplication échouait) :
-- source_language est une colonne Lot D (migration-lotd-establishment-
-- creation.sql), PAS créée par LOT 1A -- elle ne doit JAMAIS être
-- supprimée ici, seulement sa contrainte restaurée à sa forme Lot D
-- d'origine (CHECK figé fr/en/ar). De même, create_establishment a été
-- redéfinie par LOT 1A (CREATE OR REPLACE) : ce rollback la restaure
-- à son corps EXACT de Lot D (extrait programmatiquement du fichier
-- réel, jamais retapé à la main) AVANT de supprimer
-- supported_languages/restaurant_active_languages -- sinon la fonction
-- restaurée référencerait des tables qui n'existent plus.
--
-- ⚠️ CORRECTION L1A-01 (contre-audit Work, tour 1A.1) — deux défauts
-- réels confirmés empiriquement avant correction :
--   1. Le rollback pouvait échouer BRUTALEMENT (erreur PostgreSQL brute
--      de violation de contrainte, sans préflight ni rapport clair) si
--      un établissement avait été configuré avec une langue hors
--      fr/en/ar (ex. source_language='nl', créé via create_establishment
--      redéfinie par LOT 1A -- reproduit et confirmé avant correctif).
--   2. restaurant_configs_enabled_languages_chk n'était JAMAIS restaurée
--      du tout (absence totale, pas un oubli partiel) -- un rollback
--      pouvait donc "réussir" tout en laissant un état structurellement
--      incomplet par rapport à V79 réel (enabled_languages resterait
--      capable d'accepter silencieusement une langue hors fr/en/ar,
--      ce que le vrai schéma V79 n'a jamais permis).
--   3. Cas supplémentaire découvert pendant la correction (non cité
--      explicitement par Work, mais du même ordre) : une langue
--      ajoutée via le Dashboard APRÈS la création de l'établissement
--      (update_restaurant_languages) n'existe QUE dans
--      restaurant_active_languages -- jamais dans l'ancien
--      enabled_languages (conception LOT 1A délibérée : cette colonne
--      Lot D devient un instantané figé à la création, plus la source
--      de vérité). Une telle langue serait donc DÉFINITIVEMENT PERDUE
--      si seule la table était supprimée sans vérification préalable.
--
-- Ce fichier ajoute donc un PRÉFLIGHT en LECTURE SEULE, hors de toute
-- transaction, AVANT le moindre DROP/ALTER : il vérifie les 3 sources
-- possibles de données incompatibles avec le modèle V79
-- (source_language, enabled_languages, restaurant_active_languages),
-- et lève une exception EXPLICITE avec le détail exact des
-- établissements/langues bloquants si la moindre incompatibilité est
-- détectée -- AUCUNE modification n'est alors effectuée, jamais un
-- retour partiel. Restaure aussi désormais
-- restaurant_configs_enabled_languages_chk (absente jusqu'ici).
--
-- Ordre : PRÉFLIGHT (hors transaction) -> fonctions LOT 1A supprimées
-- -> create_establishment restaurée (Lot D) -> les DEUX contraintes
-- CHECK Lot D restaurées (source_language ET enabled_languages) ->
-- colonnes LOT 1A supprimées (source_language PRÉSERVÉE) -> tables
-- LOT 1A supprimées.
-- ============================================================

do $$
declare
  v_bad_source   text;
  v_bad_enabled  text;
  v_bad_active   text;
  v_report       text := '';
begin
  select string_agg(format('  - %s (%s) : source_language=%s', r.name, r.slug, rc.source_language), E'\n' order by r.slug)
  into v_bad_source
  from public.restaurant_configs rc
  join public.restaurants r on r.id = rc.restaurant_id
  where rc.source_language not in ('fr', 'en', 'ar');

  select string_agg(format('  - %s (%s) : enabled_languages=%s', r.name, r.slug, rc.enabled_languages::text), E'\n' order by r.slug)
  into v_bad_enabled
  from public.restaurant_configs rc
  join public.restaurants r on r.id = rc.restaurant_id
  where not (rc.enabled_languages <@ array['fr', 'en', 'ar']::text[])
     or array_length(rc.enabled_languages, 1) is null;

  select string_agg(distinct format('  - %s (%s) : langue active "%s" (hors fr/en/ar, potentiellement ajoutée via le Dashboard après création -- perte définitive si non traitée)', r.name, r.slug, ral.language_code), E'\n' order by format('  - %s (%s) : langue active "%s" (hors fr/en/ar, potentiellement ajoutée via le Dashboard après création -- perte définitive si non traitée)', r.name, r.slug, ral.language_code))
  into v_bad_active
  from public.restaurant_active_languages ral
  join public.restaurants r on r.id = ral.restaurant_id
  where ral.language_code not in ('fr', 'en', 'ar');

  if v_bad_source is not null then
    v_report := v_report || E'\nÉtablissements avec source_language incompatible avec V79 :\n' || v_bad_source;
  end if;
  if v_bad_enabled is not null then
    v_report := v_report || E'\nÉtablissements avec enabled_languages incompatible avec V79 :\n' || v_bad_enabled;
  end if;
  if v_bad_active is not null then
    v_report := v_report || E'\nÉtablissements avec une langue active incompatible avec V79 :\n' || v_bad_active;
  end if;

  if v_report != '' then
    raise exception E'SCANYM_ROLLBACK_BLOCKED: le retour à l''état V79 est IMPOSSIBLE sans perte de données -- au moins un établissement utilise une configuration incompatible avec le modèle historique (fr/en/ar uniquement).\n%\nAUCUNE MODIFICATION N''A ÉTÉ EFFECTUÉE (préflight en lecture seule, hors transaction). Examiner et migrer manuellement ces établissements (ex. changer leur langue vers fr/en/ar, ou accepter de perdre cette configuration après validation explicite du CIO) avant de relancer ce rollback.', v_report;
  end if;

  raise notice 'SCANYM_ROLLBACK_PREFLIGHT: OK -- aucun établissement incompatible avec V79 détecté. Le rollback peut se poursuivre en toute sécurité.';
end $$;

begin;

drop function if exists public.get_restaurant_active_languages(uuid);
drop function if exists public.update_restaurant_languages(uuid, text[]);
drop function if exists public.update_restaurant_social_links(uuid, text, text, text);
drop function if exists public.update_restaurant_bg_color(uuid, text);
drop function if exists public.update_restaurant_identity(uuid, text, text, text, boolean);

-- Restaure create_establishment à son corps EXACT de Lot D (avant
-- l'édition LOT 1A) -- redéfinie ici en dernier recours, jamais
-- réécrite dans son fichier d'origine (migration-lotd-establishment-
-- creation.sql, déjà en production, jamais modifié).
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

-- Restaure la contrainte CHECK figée de Lot D sur source_language --
-- cette colonne N'EST PAS supprimée (elle appartient à Lot D, pas à
-- LOT 1A).
alter table public.restaurant_configs
  drop constraint if exists restaurant_configs_source_language_fkey;

alter table public.restaurant_configs
  add constraint restaurant_configs_source_language_check
  check (source_language in ('fr', 'en', 'ar'));

-- Corrige L1A-01 : cette contrainte n'était JAMAIS restaurée avant ce
-- correctif (absence totale, confirmée par inspection directe du
-- fichier avant correction) -- restaurée ici avec le texte EXACT de
-- Lot D (migration-lotd-establishment-creation.sql), pas une
-- reconstruction approximative.
alter table public.restaurant_configs
  add constraint restaurant_configs_enabled_languages_chk
  check (
    array_length(enabled_languages, 1) > 0
    and enabled_languages <@ array['fr','en','ar']::text[]
  );

-- Corrige L1A1-02 (contre-audit Work, tour LOT 1A.2) : V79/Lot D ne
-- définissait AUCUN commentaire sur source_language ni
-- enabled_languages (vérifié directement dans
-- migration-lotd-establishment-creation.sql avant ce correctif) --
-- restaure donc l'ABSENCE de commentaire (COMMENT ... IS NULL),
-- jamais un texte de remplacement qui n'existait pas non plus en V79.
-- Corrige en particulier le commentaire posé par la migration LOT 1A
-- sur enabled_languages, qui référence restaurant_active_languages --
-- une table que CE MÊME rollback vient de supprimer plus haut ;
-- laisser ce commentaire en l'état aurait constitué une référence
-- pendante vers un objet inexistant.
comment on column public.restaurant_configs.source_language is null;
comment on column public.restaurant_configs.enabled_languages is null;

-- Colonnes ajoutées par LOT 1A -- source_language N'EST PAS ICI,
-- volontairement (voir en-tête).
alter table public.restaurant_configs
  drop column if exists facebook_url,
  drop column if exists tiktok_url,
  drop column if exists instagram_url,
  drop column if exists bg_color,
  drop column if exists announcement_active,
  drop column if exists announcement_text,
  drop column if exists intro_text,
  drop column if exists display_name;

drop table if exists public.restaurant_active_languages;
drop table if exists public.supported_languages;

commit;
