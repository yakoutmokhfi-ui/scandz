-- ============================================================
-- Scanym — TRANSLATIONS MANAGEMENT v2
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Parent : main da9969f5cc982f46f00b0a89f55453a2f33b4f50.
-- Rollback : DRAFT-lot-translations-management-v2-rollback.sql
-- Harness  : supabase/tests/translations-management-v2-check.sh
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--
-- A. SOUS-CATÉGORIES TRADUISIBLES
--    menu_subcategories reçoit EXACTEMENT le même couple que
--    menu_categories/menu_items depuis LOT 1B : `translations jsonb`
--    + `name_hash` GÉNÉRÉE (md5 du nom source). AUCUNE seconde table
--    de traductions, AUCUN second modèle : la structure JSONB
--    { "<lang>": { "name", "name_status", "name_source_hash" } } est
--    celle déjà en place, à l'identique.
--
-- B. TEXTES CLIENT CONFIGURABLES PAR LE COMMERÇANT ("popups")
--    Deux sources RÉELLES existent aujourd'hui dans le produit, et
--    une seule d'entre elles alimente `notice.message` de
--    components/DeliveryTimingNoticeDialog.tsx selon le cas :
--      1. restaurant_sale_modes.customer_text  (retrait + livraison,
--         texte générique du mode) ;
--      2. restaurant_sale_mode_fulfillments.customer_text (texte de
--         LA règle de livraison retenue, prioritaire quand le tenant
--         utilise les règles de fulfillment).
--    Les DEUX deviennent traduisibles, avec le MÊME modèle JSONB et
--    la MÊME colonne de hash générée. Aucun texte d'INTERFACE Scanym
--    (titres, boutons, « À emporter », « Livraison »…) n'est touché :
--    ceux-là restent dans les dictionnaires i18n (lib/i18n.ts) et ne
--    deviennent JAMAIS éditables par le commerçant.
--
--    restaurant_sale_modes n'avait pas de clé primaire uuid (PK
--    composite restaurant_id+mode_code). Une colonne `id uuid` NOT
--    NULL DEFAULT gen_random_uuid() UNIQUE est ajoutée -- PK
--    INCHANGÉE -- pour donner à ces textes un identifiant STABLE et
--    machine-lisible (exigence export/import : « never identify
--    entities only by display name »).
--
-- C. write_translation ÉTENDUE (même signature, mêmes garanties)
--    + entity_type 'subcategory'     -> field 'name' uniquement
--    + entity_type 'customer_notice' -> field 'customer_text' uniquement
--    Le corps des 3 types existants ('restaurant'/'category'/'item')
--    est repris MOT POUR MOT de migration-v81-lot1b-translations.sql :
--    aucune règle existante n'est réécrite, déplacée ni assouplie.
--    Conservé à l'identique : assert_restaurant_asset_role (owner/
--    manager/opérateur), interdiction d'écrire dans la langue source,
--    langue devant être supportée ET active, statuts limités à
--    to_review|validated ('stale' n'est JAMAIS écrit -- dérivé en
--    lecture), hash TOUJOURS relu côté serveur (jamais fourni par
--    l'appelant), search_path = '' explicite, aucun GRANT nouveau,
--    aucun droit anon/public.
--
-- D. LECTURES ÉTENDUES DE MANIÈRE STRICTEMENT ADDITIVE
--    (colonnes ajoutées EN FIN de `returns table`, rien de déplacé) :
--      - get_merchant_catalogue           + subcategory_name_hash,
--                                           subcategory_translations
--      - get_merchant_delivery_method_notices
--                                         + sale_mode_id,
--                                           customer_text_hash,
--                                           translations
--      - get_merchant_delivery_fulfillment_pricing
--                                         + customer_text_hash,
--                                           translations
--      - get_restaurant_public_sale_modes + customer_text_hash,
--                                           translations
--      - get_restaurant_public_delivery_fulfillments
--                                         + rule_id,
--                                           customer_text_hash,
--                                           translations
--    Les corps sont repris de la définition la PLUS RÉCENTE de chaque
--    fonction dans la chaîne réelle (get_merchant_catalogue : celle de
--    DRAFT-lot-operator-catalogue-reset-v1.sql, qui conserve le bypass
--    opérateur d'OB-2 v1.1) -- jamais une version antérieure, qui
--    régresserait silencieusement une autorisation.
--
-- PAS DANS CE LOT : aucun nouveau type d'entité au-delà des 2
-- ci-dessus, aucune RPC d'import en masse (l'import réutilise
-- write_translation ligne par ligne, donc TOUTES ses validations),
-- aucun changement de create_order/prix, aucun changement de RLS,
-- aucun droit anon/service_role nouveau.
--
-- UNE SEULE transaction explicite ; échec fermé si un prérequis
-- manque ou si le lot est déjà (partiellement) appliqué.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL : dérive de schéma / lot déjà appliqué.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.menu_subcategories') is null
     or to_regclass('public.menu_categories') is null
     or to_regclass('public.menu_items') is null
     or to_regclass('public.restaurant_sale_modes') is null
     or to_regclass('public.restaurant_sale_mode_fulfillments') is null
     or to_regclass('public.restaurant_configs') is null
     or to_regclass('public.restaurant_active_languages') is null
     or to_regclass('public.supported_languages') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: prérequis absents (menu_subcategories/menu_categories/menu_items/restaurant_sale_modes/restaurant_sale_mode_fulfillments/restaurant_configs/restaurant_active_languages/supported_languages) -- TRANSLATIONS MANAGEMENT v2 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'write_translation'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: write_translation introuvable (LOT 1B absent) -- lot annulé.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_restaurant_asset_role'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_restaurant_asset_role introuvable -- lot annulé.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator introuvable -- lot annulé.';
  end if;

  -- get_merchant_catalogue DOIT déjà porter le bypass opérateur
  -- (OB-2 v1.1) et les colonnes de reset : si ce n'est pas le cas, la
  -- chaîne appliquée n'est pas celle attendue et recopier notre corps
  -- RÉGRESSERAIT une autorisation.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
      and pg_get_functiondef(p.oid) ilike '%subcategory_is_active%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_catalogue courante n''est pas la version attendue (bypass opérateur OB-2 v1.1 + colonnes de reset) -- lot annulé plutôt que de recopier un corps périmé.';
  end if;

  if exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'menu_subcategories'
         and column_name in ('translations', 'name_hash')
     )
     or exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_sale_modes'
         and column_name in ('translations', 'customer_text_hash', 'id')
     )
     or exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_sale_mode_fulfillments'
         and column_name in ('translations', 'customer_text_hash')
     ) then
    raise exception 'SCANYM_ALREADY_APPLIED: TRANSLATIONS MANAGEMENT v2 déjà (partiellement) appliqué -- lot annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. SOUS-CATÉGORIES : traductions + hash source généré.
--    Mêmes noms de colonnes, même type, même expression md5 que
--    menu_categories/menu_items (LOT 1B) -- jamais une variante.
-- ------------------------------------------------------------
alter table public.menu_subcategories
  add column translations jsonb,
  add column name_hash text generated always as (md5(coalesce(name, ''))) stored;

comment on column public.menu_subcategories.translations is
  'TRANSLATIONS MANAGEMENT v2 -- MÊME modèle JSONB que menu_categories/menu_items (LOT 1B) : {"<lang>": {"name", "name_status", "name_source_hash"}}. Seul le champ `name` est traduisible pour une sous-catégorie. Écrit EXCLUSIVEMENT par write_translation (SECURITY DEFINER) ; "stale" n''est jamais stocké (dérivé en lecture par comparaison de hash).';
comment on column public.menu_subcategories.name_hash is
  'TRANSLATIONS MANAGEMENT v2 -- hash canonique du nom source (colonne GÉNÉRÉE, jamais écrite par l''application ni recalculée côté client). Même expression que menu_categories.name_hash.';

-- ------------------------------------------------------------
-- 2. TEXTES CLIENT DU COMMERÇANT (source 1 : mode de vente).
--
--    `id` : identifiant STABLE exposé à l'export/import. PK
--    composite (restaurant_id, mode_code) INCHANGÉE -- aucune
--    dépendance existante n'est touchée ; l'unicité de `id` est
--    garantie par un index unique dédié.
-- ------------------------------------------------------------
alter table public.restaurant_sale_modes
  add column id uuid not null default gen_random_uuid(),
  add column translations jsonb,
  add column customer_text_hash text generated always as (md5(coalesce(customer_text, ''))) stored;

create unique index idx_restaurant_sale_modes_id on public.restaurant_sale_modes (id);

comment on column public.restaurant_sale_modes.id is
  'TRANSLATIONS MANAGEMENT v2 -- identifiant technique STABLE du mode de vente de CE commerçant, pour identifier sans ambiguïté un texte client dans l''export/import de traductions (jamais par libellé affiché). La clé primaire reste (restaurant_id, mode_code) : cette colonne n''est PAS une nouvelle identité métier.';
comment on column public.restaurant_sale_modes.translations is
  'TRANSLATIONS MANAGEMENT v2 -- MÊME modèle JSONB que le reste du produit : {"<lang>": {"customer_text", "customer_text_status", "customer_text_source_hash"}}. Concerne UNIQUEMENT le texte client configurable par le commerçant -- jamais un libellé d''interface Scanym (ceux-ci restent dans lib/i18n.ts).';
comment on column public.restaurant_sale_modes.customer_text_hash is
  'TRANSLATIONS MANAGEMENT v2 -- hash canonique du texte client source (colonne GÉNÉRÉE).';

-- ------------------------------------------------------------
-- 3. TEXTES CLIENT DU COMMERÇANT (source 2 : règle de livraison).
-- ------------------------------------------------------------
alter table public.restaurant_sale_mode_fulfillments
  add column translations jsonb,
  add column customer_text_hash text generated always as (md5(coalesce(customer_text, ''))) stored;

comment on column public.restaurant_sale_mode_fulfillments.translations is
  'TRANSLATIONS MANAGEMENT v2 -- traductions du texte client de CETTE règle de livraison (même modèle JSONB, champ `customer_text`). C''est ce texte qui alimente DeliveryTimingNoticeDialog quand le tenant utilise les règles de fulfillment.';
comment on column public.restaurant_sale_mode_fulfillments.customer_text_hash is
  'TRANSLATIONS MANAGEMENT v2 -- hash canonique du texte client source (colonne GÉNÉRÉE).';

-- ------------------------------------------------------------
-- 4. write_translation -- 5 types d'entité (3 existants INCHANGÉS
--    + 2 nouveaux). MÊME signature, MÊMES garanties, MÊMES GRANTS.
-- ------------------------------------------------------------
drop function if exists public.write_translation(uuid, text, uuid, text, text, text, text);

create function public.write_translation(
  p_restaurant_id uuid,
  p_entity_type   text,   -- 'restaurant' | 'category' | 'item' | 'subcategory' | 'customer_notice'
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
  v_notice_kind      text;
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  if p_entity_type not in ('restaurant', 'category', 'item', 'subcategory', 'customer_notice') then
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

  elsif p_entity_type = 'subcategory' then
    -- TRANSLATIONS MANAGEMENT v2 -- SEUL `name` est traduisible pour
    -- une sous-catégorie (elle n'a aucun autre champ textuel).
    if p_field not in ('name') then
      raise exception using errcode = '22023', message = 'Invalid field for entity type subcategory';
    end if;
    -- Isolation multi-tenant par JOINTURE via la catégorie -- EXACTEMENT
    -- le patron de menu_items ci-dessous (menu_subcategories ne porte
    -- pas de restaurant_id, par conception : voir
    -- DRAFT-lot-catalogue-subcategories-backoffice-v1.sql).
    if not exists (
      select 1 from public.menu_subcategories ms
      join public.menu_categories mc on mc.id = ms.category_id
      where ms.id = p_entity_id and mc.restaurant_id = p_restaurant_id
    ) then
      raise exception using errcode = 'P0002', message = 'Subcategory not found for this restaurant';
    end if;
    select name_hash into v_current_hash from public.menu_subcategories where id = p_entity_id;

    update public.menu_subcategories
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

  elsif p_entity_type = 'customer_notice' then
    -- TRANSLATIONS MANAGEMENT v2 -- texte client CONFIGURABLE PAR LE
    -- COMMERÇANT, provenant de l'une des 2 sources réelles du produit.
    -- L'identifiant décide de la source ; les DEUX sont vérifiées
    -- contre p_restaurant_id (jamais de substitution cross-tenant).
    if p_field not in ('customer_text') then
      raise exception using errcode = '22023', message = 'Invalid field for entity type customer_notice';
    end if;

    if exists (
      select 1 from public.restaurant_sale_modes rsm
      where rsm.id = p_entity_id and rsm.restaurant_id = p_restaurant_id
    ) then
      v_notice_kind := 'sale_mode';
    elsif exists (
      select 1 from public.restaurant_sale_mode_fulfillments f
      where f.id = p_entity_id and f.restaurant_id = p_restaurant_id
    ) then
      v_notice_kind := 'fulfillment';
    else
      raise exception using errcode = 'P0002', message = 'Customer notice not found for this restaurant';
    end if;

    if v_notice_kind = 'sale_mode' then
      select customer_text_hash into v_current_hash
      from public.restaurant_sale_modes where id = p_entity_id;

      update public.restaurant_sale_modes
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
    else
      select customer_text_hash into v_current_hash
      from public.restaurant_sale_mode_fulfillments where id = p_entity_id;

      update public.restaurant_sale_mode_fulfillments
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

comment on function public.write_translation(uuid, text, uuid, text, text, text, text) is
  'LOT 1B + TRANSLATIONS MANAGEMENT v2 -- RPC UNIQUE de traduction, 5 types d''entité : restaurant (intro_text/announcement_text), category (name/description), subcategory (name), item (name/short_description/description), customer_notice (customer_text, mode de vente OU règle de livraison du MÊME tenant). Autorisation déléguée à assert_restaurant_asset_role. Hash source TOUJOURS relu côté serveur. Écriture dans la langue source INTERDITE. Statut limité à to_review|validated ("stale" est dérivé en lecture, jamais stocké).';

revoke all on function public.write_translation(uuid, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.write_translation(uuid, text, uuid, text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 5. get_merchant_catalogue -- extension STRICTEMENT ADDITIVE
--    (+2 colonnes en FIN de returns table). Corps repris de la
--    définition la PLUS RÉCENTE de la chaîne réelle
--    (DRAFT-lot-operator-catalogue-reset-v1.sql), bypass opérateur
--    OB-2 v1.1 CONSERVÉ tel quel.
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
  reference_price_per_kg       numeric,
  category_is_active           boolean,
  subcategory_is_active        boolean,
  subcategory_name_hash        text,
  subcategory_translations     jsonb
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
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  with groups as (
    select ms.category_id as category_id, ms.id as subcategory_id,
           ms.name::text as subcategory_name, ms.display_order as subcategory_display_order,
           ms.is_active as subcategory_is_active,
           ms.name_hash as subcategory_name_hash, ms.translations as subcategory_translations
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order,
           null::boolean as subcategory_is_active,
           null::text as subcategory_name_hash, null::jsonb as subcategory_translations
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
         mi.tax_rate, mi.unit_weight_grams, mi.weight_is_approximate, mi.reference_price_per_kg,
         mc.is_active, g.subcategory_is_active,
         g.subcategory_name_hash, g.subcategory_translations
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

-- ------------------------------------------------------------
-- 6. LECTURES MARCHAND des textes client -- extension ADDITIVE.
-- ------------------------------------------------------------
drop function if exists public.get_merchant_delivery_method_notices(uuid);

create function public.get_merchant_delivery_method_notices(
  p_restaurant_id uuid
)
returns table (
  mode_code text,
  mode_label text,
  customer_text text,
  sale_mode_id uuid,
  customer_text_hash text,
  translations jsonb
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

  if not public.is_member_of(p_restaurant_id)
     and not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  return query
  select rsm.mode_code, smc.label, rsm.customer_text,
         rsm.id, rsm.customer_text_hash, rsm.translations
  from public.restaurant_sale_modes rsm
  join public.sale_mode_catalog smc on smc.code = rsm.mode_code
  where rsm.restaurant_id = p_restaurant_id
    and rsm.enabled
    and rsm.mode_code in ('pickup', 'delivery')
  order by rsm.display_order, rsm.mode_code;
end;
$$;

comment on function public.get_merchant_delivery_method_notices(uuid) is
  'Tenant-safe merchant projection of enabled pickup/delivery customer_text only. No provider, config, routing code or disabled mode is exposed. TRANSLATIONS MANAGEMENT v2 : + sale_mode_id (identifiant stable), customer_text_hash (colonne générée) et translations, pour la gestion des traductions.';

revoke all on function public.get_merchant_delivery_method_notices(uuid)
  from public, anon;
grant execute on function public.get_merchant_delivery_method_notices(uuid)
  to authenticated;

drop function if exists public.get_merchant_delivery_fulfillment_pricing(uuid);

create function public.get_merchant_delivery_fulfillment_pricing(
  p_restaurant_id uuid
)
returns table (
  rule_id           uuid,
  fulfillment_label text,
  pricing_mode      text,
  fixed_fee         numeric,
  free_threshold    numeric,
  customer_text     text,
  customer_text_hash text,
  translations      jsonb
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

  if not public.is_member_of(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  return query
  select
    f.id as rule_id,
    (
      (case when f.is_fallback then 'Livraison (option de repli)' else 'Livraison' end)
      || case
           when f.zone_prefixes is not null and array_length(f.zone_prefixes, 1) > 0
             then ' — zones ' || array_to_string(f.zone_prefixes, ', ')
           else ''
         end
    ) as fulfillment_label,
    f.pricing_mode,
    f.fixed_fee,
    f.free_threshold,
    f.customer_text,
    f.customer_text_hash,
    f.translations
  from public.restaurant_sale_mode_fulfillments f
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
  order by f.display_order;
end;
$$;

revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public, anon;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7. LECTURES PUBLIQUES -- extension ADDITIVE, pour que le
--    storefront puisse résoudre le texte client dans la langue du
--    visiteur avec EXACTEMENT les mêmes règles de repli que le reste
--    du contenu marchand (validé + hash à jour, sinon source).
--    Aucune donnée interne supplémentaire n'est exposée : seulement
--    le hash (déjà dérivable du texte source, lui-même public) et les
--    traductions de CE texte.
-- ------------------------------------------------------------
drop function if exists public.get_restaurant_public_sale_modes(uuid);

create function public.get_restaurant_public_sale_modes(p_restaurant_id uuid)
returns table (
  mode_code      text,
  customer_text  text,
  pricing_mode   text,
  fixed_fee      numeric,
  free_threshold numeric,
  delay_value    integer,
  delay_unit     text,
  customer_text_hash text,
  translations   jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select rsm.mode_code, rsm.customer_text, rsm.pricing_mode,
         rsm.fixed_fee, rsm.free_threshold, rsm.delay_value, rsm.delay_unit,
         rsm.customer_text_hash, rsm.translations
  from public.restaurant_sale_modes rsm
  join public.restaurants r on r.id = rsm.restaurant_id
  where rsm.restaurant_id = p_restaurant_id
    and rsm.enabled = true
    and r.is_active = true and r.status = 'active'
  order by rsm.display_order;
$$;

comment on function public.get_restaurant_public_sale_modes(uuid) is
  'LOT 2A.2 -- projection publique minimale des modes de vente actifs (menu/checkout). N''expose jamais provider ni config JSONB (info interne) -- corrige L2A1-01. TRANSLATIONS MANAGEMENT v2 : + customer_text_hash et translations du SEUL texte client (déjà public), pour la résolution multilingue côté client.';

revoke all on function public.get_restaurant_public_sale_modes(uuid) from public;
grant execute on function public.get_restaurant_public_sale_modes(uuid) to anon, authenticated;

drop function if exists public.get_restaurant_public_delivery_fulfillments(uuid);

create function public.get_restaurant_public_delivery_fulfillments(p_restaurant_id uuid)
returns table (
  fulfillment_code text,
  zone_prefixes    text[],
  is_fallback      boolean,
  min_items        integer,
  customer_text    text,
  display_order    integer,
  rule_id          uuid,
  customer_text_hash text,
  translations     jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.fulfillment_code,
    f.zone_prefixes,
    f.is_fallback,
    f.min_items,
    f.customer_text,
    f.display_order,
    f.id,
    f.customer_text_hash,
    f.translations
  from public.restaurant_sale_mode_fulfillments f
  join public.restaurant_sale_modes rsm
    on rsm.restaurant_id = f.restaurant_id
   and rsm.mode_code = f.mode_code
  join public.restaurants r on r.id = f.restaurant_id
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
    and f.enabled = true
    and rsm.enabled = true
    and r.is_active = true and r.status = 'active'
  order by f.display_order;
$$;

comment on function public.get_restaurant_public_delivery_fulfillments(uuid) is
  'FULFILLMENT ROUTING LOT B — projection publique minimale des règles de routage fulfillment (mode delivery) : une ligne par règle active. N''expose jamais provider ni config JSONB brut. TRANSLATIONS MANAGEMENT v2 : + rule_id, customer_text_hash et translations du SEUL texte client, pour la résolution multilingue côté client.';

revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from public;
revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from anon, authenticated, service_role;
grant execute on function public.get_restaurant_public_delivery_fulfillments(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 8. POST-VÉRIFICATION -- échec fermé si un invariant du lot n'est
--    pas réellement en place (jamais un commit optimiste).
-- ------------------------------------------------------------
do $$
declare
  v_def text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_subcategories'
      and column_name = 'name_hash' and is_generated = 'ALWAYS'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_subcategories.name_hash n''est pas une colonne générée.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_sale_modes'
      and column_name = 'customer_text_hash' and is_generated = 'ALWAYS'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: restaurant_sale_modes.customer_text_hash n''est pas une colonne générée.';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'write_translation';
  if v_def not ilike '%assert_restaurant_asset_role%'
     or v_def not ilike '%Cannot write a translation into the source language%'
     or v_def not ilike '%subcategory%'
     or v_def not ilike '%customer_notice%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: write_translation ne combine pas autorisation, interdiction de langue source et les 2 nouveaux types.';
  end if;

  -- Aucun droit d'exécution PUBLIC/anon sur l'écriture.
  if has_function_privilege('public', 'public.write_translation(uuid, text, uuid, text, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.write_translation(uuid, text, uuid, text, text, text, text)', 'execute') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: write_translation exécutable par public/anon.';
  end if;

  -- Aucun droit d'ÉCRITURE directe nouveau sur les tables touchées.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('menu_subcategories', 'restaurant_sale_modes', 'restaurant_sale_mode_fulfillments')
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: droit d''écriture directe anon/authenticated sur une table de ce lot.';
  end if;
end $$;

commit;
