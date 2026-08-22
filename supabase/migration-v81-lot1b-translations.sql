-- ============================================================
-- Scanym LOT 1B — Traductions manuelles des contenus.
--
-- Baseline : LOT 1A.2 (main = 7b4fdcfed92a6f3533ba893f7d5f8c19d89d168a,
-- déployé). Ce lot n'ouvre PAS le Sous-lot 1C (changement de langue
-- source) ni 1D (traduction automatique) : aucune RPC de bascule,
-- aucun appel externe, aucun secret/provider.
--
-- ------------------------------------------------------------------
-- Découverte pendant l'audit préalable (traitée, pas contournée) :
-- lib/menu-i18n.ts code en dur `if (lang === "fr") return entity.name`
-- comme langue source -- une hypothèse fausse dès qu'un établissement
-- a source_language != 'fr' (ex. Sirocco/AR, ou tout établissement
-- créé via create_establishment avec une autre langue source depuis
-- LOT 1A). Ce fichier ne modifie QUE le SQL ; la correction de la
-- résolution générique (section 4 de la mission, dépendante de
-- source_language) est traitée côté TypeScript
-- (lib/translation-resolver.ts, nouveau fichier), remplaçant le
-- contrat fr-figé de lib/menu-i18n.ts -- documenté explicitement dans
-- le rapport de livraison, pas silencieusement corrigé.
-- ------------------------------------------------------------------
--
-- Principe de stockage : réutilise EXACTEMENT le mécanisme JSONB déjà
-- en production sur menu_categories/menu_items (translations), étendu
-- avec un statut et un hash par champ et par langue, format identique
-- sur les 3 tables (restaurant_configs, menu_categories, menu_items) --
-- aucun système parallèle par type d'objet :
--   translations = {
--     "<lang>": {
--       "<field>": "...",
--       "<field>_status": "to_review" | "validated",
--       "<field>_source_hash": "<md5 de la valeur source AU MOMENT de
--                                l'écriture, calculé UNIQUEMENT côté
--                                SQL, jamais réimplémenté côté client>"
--     }
--   }
--
-- Hash canonique : colonnes GÉNÉRÉES (GENERATED ALWAYS AS ... STORED),
-- calculées par PostgreSQL lui-même à chaque écriture du champ source
-- -- élimine STRUCTURELLEMENT tout risque de divergence de calcul
-- entre client/serveur/SQL (erreur classique explicitement signalée
-- par la mission) : le client ne calcule jamais de hash, il compare
-- seulement deux chaînes déjà calculées par PostgreSQL.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Contrôle préalable (anti-dérive).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'intro_text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.intro_text introuvable — migration LOT 1B annulée. Prérequis : LOT 1A doit déjà être appliqué.';
  end if;
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'supported_languages'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.supported_languages introuvable — migration LOT 1B annulée. Prérequis : LOT 1A doit déjà être appliqué.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'translations'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.translations existe déjà — migration LOT 1B annulée pour éviter une double application.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'write_translation'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.write_translation existe déjà — migration LOT 1B annulée.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------
-- 2a. restaurant_configs : translations JSONB (même format que
-- menu_categories/menu_items), additive/nullable.
-- ------------------------------------------------------------

alter table public.restaurant_configs
  add column if not exists translations jsonb;

comment on column public.restaurant_configs.translations is
  'LOT 1B — traductions de intro_text/announcement_text, même format que menu_categories/menu_items.translations : {"<lang>": {"<field>": "...", "<field>_status": "to_review"|"validated", "<field>_source_hash": "..."}}. NULL = aucune traduction, comportement inchangé (repli sur la langue source).';

-- ------------------------------------------------------------
-- 2b. Colonnes de hash GÉNÉRÉES (source de vérité UNIQUE du hash,
-- calculée par PostgreSQL lui-même) -- 7 champs traduisibles au
-- total. coalesce(x, '') : un champ source NULL a un hash stable
-- (jamais NULL lui-même), distinct de "jamais haché".
-- ------------------------------------------------------------

alter table public.restaurant_configs
  add column if not exists intro_text_hash text generated always as (md5(coalesce(intro_text, ''))) stored,
  add column if not exists announcement_text_hash text generated always as (md5(coalesce(announcement_text, ''))) stored;

alter table public.menu_categories
  add column if not exists name_hash text generated always as (md5(coalesce(name, ''))) stored,
  add column if not exists description_hash text generated always as (md5(coalesce(description, ''))) stored;

alter table public.menu_items
  add column if not exists name_hash text generated always as (md5(coalesce(name, ''))) stored,
  add column if not exists short_description_hash text generated always as (md5(coalesce(short_description, ''))) stored,
  add column if not exists description_hash text generated always as (md5(coalesce(description, ''))) stored;

comment on column public.menu_categories.name_hash is
  'LOT 1B — hash canonique de name, calculé par PostgreSQL (colonne générée). Jamais recalculé côté client : comparer ce hash à translations[lang].name_source_hash suffit à déterminer la fraîcheur d''une traduction.';
comment on column public.menu_items.name_hash is
  'LOT 1B — hash canonique de name, calculé par PostgreSQL (colonne générée).';

-- ------------------------------------------------------------
-- 2b-bis. Corrige L1B-01 (contre-audit Work, tour 1B.1) : BACKFILL
-- ATOMIQUE ET BORNÉ des traductions HISTORIQUES (format
-- migration-translations.sql, ex. Illico Presto -- ar/name, ar/description
-- sans AUCUNE clé _status/_source_hash). Le nouveau résolveur
-- (lib/translation-resolver.ts) exige désormais <field>_status =
-- 'validated' ET <field>_source_hash = hash actuel pour publier une
-- traduction -- sans ce backfill, toute traduction historique non
-- vide devient invisible publiquement (repli sur la source), bien
-- que sa valeur reste intacte en base : une régression réelle
-- confirmée AVANT correction (reproduit avec le format exact
-- d'Illico Presto).
--
-- Portée STRICTEMENT bornée : ne touche QUE les entrées où la clé de
-- statut est TOTALEMENT ABSENTE (données historiques, jamais un enregistrement
-- déjà écrit par write_translation, qui pose toujours un statut
-- explicite -- 'to_review' ou 'validated'). Une traduction déjà
-- 'to_review' n'est donc JAMAIS auto-validée par ce backfill. Chaque
-- valeur existante et TOUTE autre clé JSONB sont préservées à
-- l'identique ; seules 2 nouvelles clés (<field>_status,
-- <field>_source_hash) sont ajoutées quand elles manquent.
-- ------------------------------------------------------------

do $$
declare
  r record;
  lang_key text;
  lang_val jsonb;
  new_trans jsonb;
begin
  -- menu_categories : name, description
  for r in
    select id, translations, name_hash, description_hash
    from public.menu_categories
    where translations is not null
  loop
    new_trans := r.translations;
    for lang_key in select jsonb_object_keys(r.translations) loop
      lang_val := r.translations -> lang_key;
      if (lang_val ->> 'name') is not null and (lang_val ->> 'name') != ''
         and not (lang_val ? 'name_status') then
        new_trans := jsonb_set(new_trans, array[lang_key, 'name_status'], '"validated"'::jsonb, true);
        new_trans := jsonb_set(new_trans, array[lang_key, 'name_source_hash'], to_jsonb(r.name_hash), true);
      end if;
      if (lang_val ->> 'description') is not null and (lang_val ->> 'description') != ''
         and not (lang_val ? 'description_status') then
        new_trans := jsonb_set(new_trans, array[lang_key, 'description_status'], '"validated"'::jsonb, true);
        new_trans := jsonb_set(new_trans, array[lang_key, 'description_source_hash'], to_jsonb(r.description_hash), true);
      end if;
    end loop;
    if new_trans is distinct from r.translations then
      update public.menu_categories set translations = new_trans where id = r.id;
    end if;
  end loop;

  -- menu_items : name, short_description, description
  for r in
    select id, translations, name_hash, short_description_hash, description_hash
    from public.menu_items
    where translations is not null
  loop
    new_trans := r.translations;
    for lang_key in select jsonb_object_keys(r.translations) loop
      lang_val := r.translations -> lang_key;
      if (lang_val ->> 'name') is not null and (lang_val ->> 'name') != ''
         and not (lang_val ? 'name_status') then
        new_trans := jsonb_set(new_trans, array[lang_key, 'name_status'], '"validated"'::jsonb, true);
        new_trans := jsonb_set(new_trans, array[lang_key, 'name_source_hash'], to_jsonb(r.name_hash), true);
      end if;
      if (lang_val ->> 'short_description') is not null and (lang_val ->> 'short_description') != ''
         and not (lang_val ? 'short_description_status') then
        new_trans := jsonb_set(new_trans, array[lang_key, 'short_description_status'], '"validated"'::jsonb, true);
        new_trans := jsonb_set(new_trans, array[lang_key, 'short_description_source_hash'], to_jsonb(r.short_description_hash), true);
      end if;
      if (lang_val ->> 'description') is not null and (lang_val ->> 'description') != ''
         and not (lang_val ? 'description_status') then
        new_trans := jsonb_set(new_trans, array[lang_key, 'description_status'], '"validated"'::jsonb, true);
        new_trans := jsonb_set(new_trans, array[lang_key, 'description_source_hash'], to_jsonb(r.description_hash), true);
      end if;
    end loop;
    if new_trans is distinct from r.translations then
      update public.menu_items set translations = new_trans where id = r.id;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2c. write_translation -- RPC UNIQUE couvrant les 3 types d'entité
-- et les 7 champs (aucun système parallèle par type d'objet). Écrit
-- TOUJOURS le hash RECALCULÉ SERVEUR de la valeur source actuelle au
-- moment de l'écriture -- jamais une valeur fournie par l'appelant.
-- Réutilise assert_restaurant_asset_role (owner/manager/opérateur,
-- patron déjà audité V70/LOT 1A), jamais un contrôle réinventé.
-- ------------------------------------------------------------

create function public.write_translation(
  p_restaurant_id uuid,
  p_entity_type   text,   -- 'restaurant' | 'category' | 'item'
  p_entity_id     uuid,   -- ignoré si p_entity_type = 'restaurant'
  p_field         text,
  p_lang          text,
  p_value         text,
  p_status        text    -- 'to_review' | 'validated' -- jamais 'stale' (dérivé en lecture, jamais écrit)
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_language text;
  v_current_hash     text;
  v_value            text;
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  if p_entity_type not in ('restaurant', 'category', 'item') then
    raise exception using errcode = '22023', message = 'Invalid entity type';
  end if;
  if p_status not in ('to_review', 'validated') then
    raise exception using errcode = '22023', message = 'Invalid status: must be to_review or validated';
  end if;
  if not exists (select 1 from public.supported_languages where code = p_lang) then
    raise exception using errcode = '22023', message = 'Unsupported language code';
  end if;
  if not exists (
    select 1 from public.restaurant_active_languages
    where restaurant_id = p_restaurant_id and language_code = p_lang
  ) then
    raise exception using errcode = '22023', message = 'Language is not active for this restaurant';
  end if;

  select source_language into v_source_language
  from public.restaurant_configs where restaurant_id = p_restaurant_id;
  if p_lang = v_source_language then
    raise exception using errcode = '22023', message = 'Cannot write a translation into the source language';
  end if;

  v_value := nullif(p_value, '');

  if p_entity_type = 'restaurant' then
    if p_field not in ('intro_text', 'announcement_text') then
      raise exception using errcode = '22023', message = 'Invalid field for entity type restaurant';
    end if;
    if p_field = 'intro_text' then
      select intro_text_hash into v_current_hash from public.restaurant_configs where restaurant_id = p_restaurant_id;
    else
      select announcement_text_hash into v_current_hash from public.restaurant_configs where restaurant_id = p_restaurant_id;
    end if;

    update public.restaurant_configs
    set translations = coalesce(translations, '{}'::jsonb)
      || jsonb_build_object(
        p_lang,
        coalesce(translations -> p_lang, '{}'::jsonb)
          || jsonb_build_object(
            p_field, v_value,
            p_field || '_status', p_status,
            p_field || '_source_hash', v_current_hash
          )
      )
    where restaurant_id = p_restaurant_id;

  elsif p_entity_type = 'category' then
    if p_field not in ('name', 'description') then
      raise exception using errcode = '22023', message = 'Invalid field for entity type category';
    end if;
    if not exists (
      select 1 from public.menu_categories where id = p_entity_id and restaurant_id = p_restaurant_id
    ) then
      raise exception using errcode = 'P0002', message = 'Category not found for this restaurant';
    end if;
    if p_field = 'name' then
      select name_hash into v_current_hash from public.menu_categories where id = p_entity_id;
    else
      select description_hash into v_current_hash from public.menu_categories where id = p_entity_id;
    end if;

    update public.menu_categories
    set translations = coalesce(translations, '{}'::jsonb)
      || jsonb_build_object(
        p_lang,
        coalesce(translations -> p_lang, '{}'::jsonb)
          || jsonb_build_object(
            p_field, v_value,
            p_field || '_status', p_status,
            p_field || '_source_hash', v_current_hash
          )
      )
    where id = p_entity_id;

  else -- 'item'
    if p_field not in ('name', 'short_description', 'description') then
      raise exception using errcode = '22023', message = 'Invalid field for entity type item';
    end if;
    if not exists (
      select 1 from public.menu_items mi
      join public.menu_categories mc on mc.id = mi.category_id
      where mi.id = p_entity_id and mc.restaurant_id = p_restaurant_id
    ) then
      raise exception using errcode = 'P0002', message = 'Item not found for this restaurant';
    end if;
    if p_field = 'name' then
      select name_hash into v_current_hash from public.menu_items where id = p_entity_id;
    elsif p_field = 'short_description' then
      select short_description_hash into v_current_hash from public.menu_items where id = p_entity_id;
    else
      select description_hash into v_current_hash from public.menu_items where id = p_entity_id;
    end if;

    update public.menu_items
    set translations = coalesce(translations, '{}'::jsonb)
      || jsonb_build_object(
        p_lang,
        coalesce(translations -> p_lang, '{}'::jsonb)
          || jsonb_build_object(
            p_field, v_value,
            p_field || '_status', p_status,
            p_field || '_source_hash', v_current_hash
          )
      )
    where id = p_entity_id;
  end if;
end $$;

revoke all on function public.write_translation(uuid, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.write_translation(uuid, text, uuid, text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 2d. get_merchant_catalogue redéfinie (CREATE OR REPLACE, MÊME
-- SIGNATURE) : expose désormais aussi les colonnes de hash générées,
-- nécessaires au Dashboard pour déterminer la fraîcheur d'une
-- traduction sans jamais recalculer de hash côté client.
-- ------------------------------------------------------------

drop function if exists public.get_merchant_catalogue(uuid, boolean);

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
  select mi.id, mc.id, mc.name::text, mc.name_hash, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description, mc.description_hash,
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

-- ------------------------------------------------------------
-- 2e. get_restaurant_translation_settings -- expose intro_text/
-- announcement_text, leurs hash et traductions, pour le Dashboard
-- (distinct de get_restaurant_settings déjà existante, non modifiée).
-- ------------------------------------------------------------

create function public.get_restaurant_translation_settings(p_restaurant_id uuid)
returns table (
  source_language        text,
  intro_text             text,
  intro_text_hash        text,
  announcement_text      text,
  announcement_text_hash text,
  translations           jsonb
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
  select rc.source_language, rc.intro_text, rc.intro_text_hash,
         rc.announcement_text, rc.announcement_text_hash, rc.translations
  from public.restaurant_configs rc
  where rc.restaurant_id = p_restaurant_id;
end $$;

revoke all on function public.get_restaurant_translation_settings(uuid) from public, anon;
grant execute on function public.get_restaurant_translation_settings(uuid) to authenticated;

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT (preuve automatisée réelle dans
-- supabase/tests/v81-lot1b-check.sh) :
--  ✓ écriture to_review puis validated, hash source correctement
--    capturé au moment de la validation
--  ✓ modification du texte source -> ancienne traduction validated
--    devient stale À LA LECTURE (hash différent), jamais supprimée
--  ✗ écriture dans la langue source refusée
--  ✗ écriture pour une langue non active refusée
--  ✗ cross-tenant (catégorie/produit d'un autre restaurant) refusé
--  ✗ staff refusé, owner/manager/opérateur acceptés
-- ============================================================
