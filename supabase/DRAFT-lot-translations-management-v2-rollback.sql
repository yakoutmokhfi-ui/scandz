-- ============================================================
-- Scanym — TRANSLATIONS MANAGEMENT v2
-- ROLLBACK (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Annule EXACTEMENT DRAFT-lot-translations-management-v2.sql :
--   - retire les colonnes ajoutées (traductions + hash générés + id
--     technique des modes de vente) ;
--   - REMET les 6 fonctions dans la version EXACTE qui précédait le
--     lot dans la chaîne réelle :
--       write_translation                           -> migration-v81-lot1b-translations.sql
--       get_merchant_catalogue                      -> DRAFT-lot-operator-catalogue-reset-v1.sql
--       get_merchant_delivery_method_notices        -> DRAFT-lot-delivery-delay-customer-notice-v1.sql
--       get_merchant_delivery_fulfillment_pricing   -> DRAFT-lot-merchant-delivery-pricing.sql
--       get_restaurant_public_sale_modes            -> migration-v82-lot2a-sale-modes.sql
--       get_restaurant_public_delivery_fulfillments -> DRAFT-lot-fulfillment-routing-lot-b-rpc.sql
--
-- CONSÉQUENCE À ACCEPTER AVANT EXÉCUTION : toutes les traductions de
-- sous-catégories et de textes client sont DÉTRUITES (colonnes
-- supprimées). Les traductions de restaurant/catégorie/produit ne
-- sont PAS touchées. Le code applicatif doit être revenu en arrière
-- dans la même livraison.
--
-- UNE SEULE transaction ; échec fermé si le lot n'est pas appliqué.
-- ============================================================

begin;

do $$
begin
  if not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'menu_subcategories'
         and column_name = 'translations'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_sale_modes'
         and column_name = 'customer_text_hash'
     ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: TRANSLATIONS MANAGEMENT v2 absent ou partiel -- rollback annulé.';
  end if;
end $$;

-- 1. Fonctions étendues -- retirées AVANT les colonnes qu'elles lisent.
-- v2.1 : la version du lot porte 8 arguments (p_expected_source_hash
-- optionnel). Les DEUX signatures sont retirées, pour qu'aucune
-- surcharge ne survive au rollback.
drop function if exists public.write_translation(uuid, text, uuid, text, text, text, text, text);
drop function if exists public.write_translation(uuid, text, uuid, text, text, text, text);
drop function if exists public.get_merchant_catalogue(uuid, boolean);
drop function if exists public.get_merchant_delivery_method_notices(uuid);
drop function if exists public.get_merchant_delivery_fulfillment_pricing(uuid);
drop function if exists public.get_restaurant_public_sale_modes(uuid);
drop function if exists public.get_restaurant_public_delivery_fulfillments(uuid);

-- 2. Colonnes ajoutées par le lot.
drop index if exists public.idx_restaurant_sale_modes_id;

alter table public.menu_subcategories
  drop column name_hash,
  drop column translations;

alter table public.restaurant_sale_modes
  drop column customer_text_hash,
  drop column translations,
  drop column id;

alter table public.restaurant_sale_mode_fulfillments
  drop column customer_text_hash,
  drop column translations;

-- 3. Fonctions REMISES dans leur version antérieure exacte.

-- 3a. write_translation (LOT 1B) -- EXACTEMENT 7 arguments, sans
--     précondition de hash : la version antérieure au lot.
create function public.write_translation(
  p_restaurant_id uuid,
  p_entity_type   text,
  p_entity_id     uuid,
  p_field         text,
  p_lang          text,
  p_value         text,
  p_status        text
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

-- 3b. get_merchant_catalogue (OPERATOR CATALOGUE RESET v1).
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
  subcategory_is_active        boolean
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
           ms.is_active as subcategory_is_active
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order,
           null::boolean as subcategory_is_active
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
         mc.is_active, g.subcategory_is_active
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

-- 3c. get_merchant_delivery_method_notices (DELIVERY DELAY CUSTOMER NOTICE v1).
create function public.get_merchant_delivery_method_notices(
  p_restaurant_id uuid
)
returns table (
  mode_code text,
  mode_label text,
  customer_text text
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
  select rsm.mode_code, smc.label, rsm.customer_text
  from public.restaurant_sale_modes rsm
  join public.sale_mode_catalog smc on smc.code = rsm.mode_code
  where rsm.restaurant_id = p_restaurant_id
    and rsm.enabled
    and rsm.mode_code in ('pickup', 'delivery')
  order by rsm.display_order, rsm.mode_code;
end;
$$;

comment on function public.get_merchant_delivery_method_notices(uuid) is
  'Tenant-safe merchant projection of enabled pickup/delivery customer_text only. No provider, config, routing code or disabled mode is exposed.';

revoke all on function public.get_merchant_delivery_method_notices(uuid)
  from public, anon;
grant execute on function public.get_merchant_delivery_method_notices(uuid)
  to authenticated;

-- 3d. get_merchant_delivery_fulfillment_pricing (MERCHANT DELIVERY PRICING v1).
create function public.get_merchant_delivery_fulfillment_pricing(
  p_restaurant_id uuid
)
returns table (
  rule_id           uuid,
  fulfillment_label text,
  pricing_mode      text,
  fixed_fee         numeric,
  free_threshold    numeric,
  customer_text     text
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
    f.customer_text
  from public.restaurant_sale_mode_fulfillments f
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
  order by f.display_order;
end;
$$;

revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public, anon;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;

-- 3e. get_restaurant_public_sale_modes (LOT 2A).
create function public.get_restaurant_public_sale_modes(p_restaurant_id uuid)
returns table (
  mode_code      text,
  customer_text  text,
  pricing_mode   text,
  fixed_fee      numeric,
  free_threshold numeric,
  delay_value    integer,
  delay_unit     text
)
language sql
stable
security definer
set search_path = ''
as $$
  select rsm.mode_code, rsm.customer_text, rsm.pricing_mode,
         rsm.fixed_fee, rsm.free_threshold, rsm.delay_value, rsm.delay_unit
  from public.restaurant_sale_modes rsm
  join public.restaurants r on r.id = rsm.restaurant_id
  where rsm.restaurant_id = p_restaurant_id
    and rsm.enabled = true
    and r.is_active = true and r.status = 'active'
  order by rsm.display_order;
$$;

comment on function public.get_restaurant_public_sale_modes(uuid) is
  'LOT 2A.2 -- projection publique minimale des modes de vente actifs (menu/checkout). N''expose jamais provider ni config JSONB (info interne) -- corrige L2A1-01.';

revoke all on function public.get_restaurant_public_sale_modes(uuid) from public;
grant execute on function public.get_restaurant_public_sale_modes(uuid) to anon, authenticated;

-- 3f. get_restaurant_public_delivery_fulfillments (FULFILLMENT ROUTING LOT B).
create function public.get_restaurant_public_delivery_fulfillments(p_restaurant_id uuid)
returns table (
  fulfillment_code text,
  zone_prefixes    text[],
  is_fallback      boolean,
  min_items        integer,
  customer_text    text,
  display_order    integer
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
    f.display_order
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
  'FULFILLMENT ROUTING LOT B — projection publique minimale des règles de routage fulfillment (mode delivery) : une ligne par règle active. N''expose jamais provider ni config JSONB brut. Ne prend pas de code postal : retourne la liste brute, la correspondance (voir resolveDeliveryFulfillment, lib/delivery.ts) est faite côté client pour un aperçu instantané. Vérifie explicitement restaurant_sale_modes.enabled ET restaurant_sale_mode_fulfillments.enabled (les deux, jamais l''un sans l''autre — invariant documenté par LOT A).';

revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from public;
revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from anon, authenticated, service_role;
grant execute on function public.get_restaurant_public_delivery_fulfillments(uuid) to anon, authenticated;

-- 4. Post-vérification du rollback.
do $$
declare
  v_def text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'menu_subcategories' and column_name in ('translations', 'name_hash'))
        or (table_name = 'restaurant_sale_modes' and column_name in ('translations', 'customer_text_hash', 'id'))
        or (table_name = 'restaurant_sale_mode_fulfillments' and column_name in ('translations', 'customer_text_hash'))
      )
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: colonnes TRANSLATIONS MANAGEMENT v2 encore présentes après rollback.';
  end if;

  -- v2.1 : exactement UNE version de write_translation, à 7 arguments,
  -- sans précondition de hash -- aucune surcharge résiduelle.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'write_translation') <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: plusieurs versions de write_translation après rollback.';
  end if;
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'write_translation';
  if v_def ilike '%p_expected_source_hash%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: write_translation porte encore la précondition v2.1 après rollback.';
  end if;
  if not has_function_privilege('authenticated', 'public.write_translation(uuid, text, uuid, text, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.write_translation(uuid, text, uuid, text, text, text, text)', 'execute') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: privilèges de write_translation incorrects après rollback.';
  end if;
end $$;

commit;
