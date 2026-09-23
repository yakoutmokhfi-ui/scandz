-- ============================================================
-- Scanym — CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — ROLLBACK
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Restaure EXACTEMENT l'état antérieur :
--   - effective_sale_mode_field_requirements -> corps LOT 2A
--     (migration-v82-lot2a-sale-modes.sql) ;
--   - create_order -> corps CGV ENGINE v2.5
--     (DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql) ;
--   - create_order_received_notification -> corps N1-A
--     (DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql) ;
--   - suppression de merchant_tracking_status_text et des 3 fonctions
--     créées par le lot.
--
-- AUCUNE donnée de commande n'est touchée. Les surcharges de texte
-- marchandes saisies pendant la vie du lot sont supprimées avec la table
-- (c'est de la configuration d'affichage, jamais de l'état métier) : le
-- suivi retombe alors sur les textes de base, sans perte de commande.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order absente -- rollback annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Résolveur d'exigences -> corps LOT 2A, VERBATIM.
-- ------------------------------------------------------------
create or replace function public.effective_sale_mode_field_requirements(
  p_restaurant_id uuid, p_mode_code text
)
returns table (field text, requirement text, one_of_group text)
language sql
stable
security definer
set search_path = ''
as $$
  select field, requirement, one_of_group from public.restaurant_sale_mode_field_requirements
  where restaurant_id = p_restaurant_id and mode_code = p_mode_code
  union all
  select field, requirement, one_of_group from public.sale_mode_field_requirements c
  where c.mode_code = p_mode_code
    and not exists (
      select 1 from public.restaurant_sale_mode_field_requirements o
      where o.restaurant_id = p_restaurant_id and o.mode_code = p_mode_code and o.field = c.field
    );
$$;

comment on function public.effective_sale_mode_field_requirements(uuid, text) is
  'LOT 2A.2 -- exigences effectives (surcharge établissement + catalogue). Strictement interne (aucun grant applicatif).';

revoke all on function public.effective_sale_mode_field_requirements(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. create_order_received_notification -> corps N1-A, VERBATIM.
-- ------------------------------------------------------------
create or replace function public.create_order_received_notification(
  p_order_id      uuid,
  p_restaurant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order       public.orders%rowtype;
  v_profile     public.merchant_notification_profile%rowtype;
  v_locale      text;
  v_status      text;
  v_payload     jsonb;
  v_outbox_id   uuid;
begin
  select * into v_order from public.orders where id = p_order_id;

  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %', p_order_id, p_restaurant_id
      using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language else 'fr' end;

  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    else 'pending'
  end;

  v_payload := jsonb_build_object(
    'order_number', v_order.order_number,
    'total', v_order.total,
    'currency', v_order.currency,
    'service_mode', v_order.service_mode,
    'public_token', v_order.public_token,
    'created_at', v_order.created_at
  );

  insert into public.notification_outbox (
    restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status
  ) values (
    p_restaurant_id, p_order_id, 'order_received', v_order.customer_email, v_locale, v_payload, v_status
  )
  on conflict (restaurant_id, order_id, notification_type) do nothing
  returning id into v_outbox_id;

  return v_outbox_id;
end $$;

comment on function public.create_order_received_notification(uuid, uuid) is
  'N1-A — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente. Refuse toute substitution tenant croisée.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 3. create_order -> corps CGV ENGINE v2.5, VERBATIM.
-- ------------------------------------------------------------
create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null,
  p_cgv_accepted  boolean default false
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
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
  v_mode_enabled boolean;
  v_req         record;
  v_field_value text;
  v_room_number text;
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
  v_street      text;
  v_city        text;
  v_cgv_status         text;
  v_cgv_version_id     uuid;
  v_cgv_content_hash   text;
  v_withdrawal_regime_snapshot text;
  v_template_sections_snapshot jsonb;
  v_withdrawal_legal_basis     text;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select status into v_cgv_status
  from public.merchant_cgv_profile where restaurant_id = v_restaurant.id;

  if v_cgv_status = 'CGV_ACTIVE' then
    select v.id, v.content_hash into v_cgv_version_id, v_cgv_content_hash
    from public.merchant_cgv_version v
    where v.restaurant_id = v_restaurant.id and v.status = 'ACTIVE'
    order by v.published_at desc
    limit 1;

    if v_cgv_version_id is null then
      raise exception using errcode = 'P0001', message = 'CGV_REQUIRED_BUT_NOT_PUBLISHED';
    end if;

    if not coalesce(p_cgv_accepted, false) then
      raise exception using errcode = 'P0001', message = 'CGV_ACCEPTANCE_REQUIRED';
    end if;

    select mcp.withdrawal_regime, ct.controlled_sections
      into v_withdrawal_regime_snapshot, v_template_sections_snapshot
    from public.merchant_cgv_version mcv
    join public.cgv_template ct on ct.id = mcv.template_id
    join public.merchant_cgv_profile mcp on mcp.restaurant_id = mcv.restaurant_id
    where mcv.id = v_cgv_version_id;

    if v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE' then
      if (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 4°%' then
        v_withdrawal_legal_basis := 'L221-28-4';
      elsif (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 3°%' then
        v_withdrawal_legal_basis := 'L221-28-3';
      else
        v_withdrawal_legal_basis := 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION';
      end if;
    elsif v_withdrawal_regime_snapshot = 'STANDARD_14_DAYS' then
      v_withdrawal_legal_basis := 'STANDARD_14_DAYS_ELIGIBLE';
    else
      v_withdrawal_legal_basis := null;
    end if;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  select enabled into v_mode_enabled
  from public.restaurant_sale_modes
  where restaurant_id = v_restaurant.id and mode_code = p_service_mode;

  if v_mode_enabled is null or not v_mode_enabled then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');
  v_room_number := nullif(left(trim(coalesce(p_customer->>'room_number','')), 20), '');
  v_street := nullif(left(trim(coalesce(p_customer->>'street','')), 200), '');
  v_city   := nullif(left(trim(coalesce(p_customer->>'city','')), 120), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  insert into tmp_field_reqs (field, requirement, one_of_group, resolved_value)
  select x.field, x.requirement, x.one_of_group,
    case x.field
      when 'customer_name' then v_name
      when 'phone' then v_phone
      when 'email' then v_email
      when 'delivery_address' then v_address
      when 'table_number' then p_table_number::text
      when 'room_number' then v_room_number
      else null
    end
  from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;

  for v_req in select field, resolved_value from tmp_field_reqs where requirement = 'required' loop
    if v_req.resolved_value is null then
      raise exception 'Champ requis manquant pour ce mode: %', v_req.field;
    end if;
  end loop;

  for v_req in
    select one_of_group, bool_or(resolved_value is not null) as satisfied
    from tmp_field_reqs
    where requirement = 'one_of' and one_of_group is not null
    group by one_of_group
  loop
    if not v_req.satisfied then
      raise exception 'Au moins un champ du groupe % est requis', v_req.one_of_group;
    end if;
  end loop;

  if p_service_mode = 'delivery' then
    select exists (
      select 1
      from public.restaurant_sale_mode_fulfillments f
      join public.restaurant_sale_modes rsm
        on rsm.restaurant_id = f.restaurant_id and rsm.mode_code = f.mode_code
      where f.restaurant_id = v_restaurant.id
        and f.mode_code = p_service_mode
        and f.enabled = true
        and rsm.enabled = true
    ) into v_new_engine;

    if v_new_engine then
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      v_postal := substring(v_address from '\m(\d{5})\M');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;

      select p into v_zone
      from public.restaurant_sale_modes rsm,
           jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p
      where rsm.restaurant_id = v_restaurant.id and rsm.mode_code = 'delivery'
        and v_postal like p || '%'
      limit 1;

      if v_zone is null then
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number, room_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    case when p_service_mode = 'room_service' then v_room_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  if p_service_mode = 'delivery' and v_address is not null then
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city)
    values (v_order_id, v_address, v_postal, v_street, v_city);
  end if;

  if v_cgv_version_id is not null then
    insert into public.order_cgv_acceptance (
      order_id, restaurant_id, cgv_version_id, content_hash,
      accepted_at, acceptance_channel, locale, terms_url
    ) values (
      v_order_id, v_restaurant.id, v_cgv_version_id, v_cgv_content_hash,
      now(), 'web_checkout',
      nullif(left(trim(coalesce(p_language,'')), 10), ''),
      '/legal/' || v_restaurant.slug
    );
  end if;

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
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot,
      withdrawal_exempt_at_order_time, withdrawal_legal_basis_at_order_time,
      merchant_withdrawal_regime_at_order_time
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate,
      case when v_withdrawal_regime_snapshot is null then null
           else (v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE') end,
      v_withdrawal_legal_basis,
      v_withdrawal_regime_snapshot
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    declare
      v_delivery_min_items integer;
    begin
      select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
      from public.restaurant_sale_modes
      where restaurant_id = v_restaurant.id and mode_code = 'delivery';

      if v_qty_total < coalesce(v_delivery_min_items, 0) then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_delivery_min_items, v_qty_total;
      end if;
    end;
  elsif p_service_mode = 'delivery' and v_new_engine then
    select * into v_resolved
    from public.resolve_delivery_fulfillment(v_restaurant.id, p_service_mode, v_postal, v_qty_total, v_subtotal);

    if not v_resolved.eligible then
      if v_resolved.block = 'no-postal' then
        raise exception 'Code postal absent de l''adresse';
      elsif v_resolved.block = 'below-min' then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_resolved.min_items, v_qty_total;
      else
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;

    v_zone := v_resolved.matched_prefix;
    v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);
    v_fulfillment_rule_id := v_resolved.fulfillment_rule_id;
    v_fulfillment_code := v_resolved.fulfillment_code;
    v_provider_code := v_resolved.provider;
  end if;

  update public.orders
  set subtotal = v_subtotal,
      delivery_fee = v_delivery_fee,
      total = v_subtotal + v_delivery_fee,
      fulfillment_rule_id = v_fulfillment_rule_id,
      fulfillment_code = v_fulfillment_code,
      provider_code = v_provider_code
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

revoke all on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) from public;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to anon;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to authenticated;

-- ------------------------------------------------------------
-- 4. Suppression des objets créés par le lot.
-- ------------------------------------------------------------
drop function if exists public.get_order_tracking_status_text_by_capability(uuid, uuid, text);
drop function if exists public.set_merchant_tracking_status_text(uuid, text, text);
drop table if exists public.merchant_tracking_status_text;
drop function if exists public.customer_tracked_service_modes();

commit;

-- ------------------------------------------------------------
-- POST-VOL du rollback.
-- ------------------------------------------------------------
do $$
declare
  v_def text;
begin
  if to_regclass('public.merchant_tracking_status_text') is not null
     or to_regprocedure('public.customer_tracked_service_modes()') is not null
     or to_regprocedure('public.set_merchant_tracking_status_text(uuid,text,text)') is not null
     or to_regprocedure('public.get_order_tracking_status_text_by_capability(uuid,uuid,text)') is not null then
    raise exception 'SCANYM_ROLLBACK_FAILED: un objet CFTE v1 subsiste.';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';

  if v_def like '%customer_tracked_service_modes%' or v_def like '%first_name%' then
    raise exception 'SCANYM_ROLLBACK_FAILED: create_order porte encore du code CFTE v1.';
  end if;
  if v_def like '%create_order_received_notification%' then
    raise exception 'SCANYM_ROLLBACK_FAILED: create_order appelle l''enfilement -- ORDER SUCCESS BOUNDARY v1 rompue.';
  end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_record_order_received_intent_trg'
      and not t.tgisinternal
  ) then
    raise exception 'SCANYM_ROLLBACK_FAILED: le déclencheur d''intention order_received a disparu.';
  end if;
end $$;
