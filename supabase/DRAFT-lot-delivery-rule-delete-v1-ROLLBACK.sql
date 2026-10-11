-- Scanym DELIVERY RULE DELETE v1 -- ROLLBACK. DRAFT; not deployed, not applied to any hosted database.
-- Restores the exact B5 body of public.mutate_merchant_delivery_rule (no 'delete' action).
-- No data is touched: rules already deleted stay deleted (orders keep their snapshots; their
-- fulfillment_rule_id stays NULL). Refuses to overwrite any body other than delete v1.
begin;

do $delete_v1_rollback_preflight$ begin
  if to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)') is null
     or to_regprocedure('public.preview_merchant_delivery_rule_save(uuid,uuid,boolean)') is null
     or to_regprocedure('scanym_internal.assert_delivery_zones(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 delivery rule writer prerequisites missing';
  end if;
  if (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc
      where oid=to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)'))
     is distinct from '4ea9c585d23a98696893f999be0a479b' then
    raise exception 'SCANYM_SCHEMA_DRIFT: rollback would overwrite a body that is not delivery rule delete v1';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='mutate_merchant_delivery_rule') <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: unexpected mutate_merchant_delivery_rule overloads';
  end if;
end $delete_v1_rollback_preflight$;

create or replace function public.mutate_merchant_delivery_rule(p_restaurant_id uuid,p_action text,p_rule_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.restaurant_sale_mode_fulfillments%rowtype; other_rule public.restaurant_sale_mode_fulfillments%rowtype;
  v_id uuid; v_order integer; spare integer; zones text[]; mode text; fee numeric; threshold numeric; transition text;
  discount_on boolean; discount_limit numeric; discount_percent numeric;
begin
  if auth.uid() is null then raise exception using errcode='28000',message='Authentication required'; end if;
  if not public.has_role_in(p_restaurant_id,array['owner','manager']) and not public.is_scanym_operator() then
    raise exception using errcode='42501',message='Not authorized for this restaurant';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_restaurant_id::text,234));
  if not exists(select 1 from public.restaurant_sale_modes where restaurant_id=p_restaurant_id and mode_code='delivery') then
    raise exception using errcode='22023',message='B234_DELIVERY_MODE_REQUIRED';
  end if;
  if p_rule_id is not null then
    select * into r from public.restaurant_sale_mode_fulfillments where id=p_rule_id and restaurant_id=p_restaurant_id and mode_code='delivery';
    if not found then raise exception using errcode='42501',message='Delivery rule unavailable'; end if;
  end if;
  if p_action='move' and p_rule_id is not null then
    select * into other_rule from public.restaurant_sale_mode_fulfillments
      where id=(p_payload->>'otherRuleId')::uuid and restaurant_id=p_restaurant_id and mode_code='delivery';
    if not found or other_rule.id=r.id then raise exception using errcode='42501',message='Delivery rule unavailable'; end if;
    -- Use an unused nonnegative order (bounded by row count), preserving the
    -- existing immediate unique constraint and avoiding max(integer) overflow.
    select x into spare from generate_series(0,(select count(*)::int+1 from public.restaurant_sale_mode_fulfillments
      where restaurant_id=p_restaurant_id and mode_code='delivery')) x
      where not exists(select 1 from public.restaurant_sale_mode_fulfillments f
        where f.restaurant_id=p_restaurant_id and f.mode_code='delivery' and f.display_order=x) limit 1;
    update public.restaurant_sale_mode_fulfillments set display_order=spare where id=r.id;
    update public.restaurant_sale_mode_fulfillments set display_order=r.display_order where id=other_rule.id;
    update public.restaurant_sale_mode_fulfillments set display_order=other_rule.display_order where id=r.id;
    v_id := r.id;
  elsif p_action='save' then
    if jsonb_typeof(p_payload) is distinct from 'object' or not p_payload ?& array['zones','fulfillmentCode','provider','enabled','isFallback','pricingMode','fixedFee','freeThreshold','customerText','minItems']
       or exists(select 1 from jsonb_object_keys(p_payload) k where k<>all(array['zones','fulfillmentCode','provider','enabled','isFallback','pricingMode','fixedFee','freeThreshold','customerText','minItems','legacyConfirmation','discountEnabled','discountThreshold','discountPercentage'])) then
      raise exception using errcode='22023',message='B234_INVALID_PAYLOAD';
    end if;
    if jsonb_typeof(p_payload->'zones') is distinct from 'array'
       or jsonb_array_length(p_payload->'zones')>500
       or exists(select 1 from jsonb_array_elements(p_payload->'zones') z where jsonb_typeof(z)<>'string')
       or jsonb_typeof(p_payload->'enabled')<>'boolean' or jsonb_typeof(p_payload->'isFallback')<>'boolean' then
      raise exception using errcode='22023',message='B234_INVALID_PAYLOAD';
    end if;
    -- Normalize separators in the UI; the server trims and deduplicates tokens,
    -- preserving their first ordinal (the resolver's matched_prefix contract).
    -- Recheck after acquiring the tenant lock. If another editor changed the
    -- active set or legacy behavior after preview, require fresh confirmation.
    transition := public.preview_merchant_delivery_rule_save(p_restaurant_id,p_rule_id,(p_payload->>'enabled')::boolean);
    if transition<>'none' and p_payload->>'legacyConfirmation' is distinct from transition then
      raise exception using errcode='22023',message='B234_CONFIRM_LEGACY_REQUIRED';
    end if;
    select coalesce(array_agg(z order by ord),'{}') into zones from (
      select btrim(value) z,min(ordinality) ord from jsonb_array_elements_text(p_payload->'zones') with ordinality group by btrim(value)
    ) q;
    if exists(select 1 from unnest(zones) z where z collate "C" !~ '^[A-Za-z0-9]+$' or length(z)>20) then
      raise exception using errcode='22023',message='ZV-FORM-INVALID';
    end if;
    mode := p_payload->>'pricingMode'; fee := (p_payload->>'fixedFee')::numeric; threshold := (p_payload->>'freeThreshold')::numeric;
    if mode is null or mode not in ('free','fixed','free_above_threshold')
       or (fee is not null and (public.scanym_numeric_is_non_finite(fee) or fee<0 or fee<>round(fee,2)))
       or (threshold is not null and (public.scanym_numeric_is_non_finite(threshold) or threshold<0 or threshold<>round(threshold,2)))
       or (mode='free' and (fee is not null or threshold is not null))
       or (mode='fixed' and (fee is null or threshold is not null))
       or (mode='free_above_threshold' and (fee is null or threshold is null)) then
      raise exception using errcode='22023',message='B234_INVALID_PRICE';
    end if;
    -- Old B234 clients omit all three fields: preserve existing policy on edit.
    -- A new policy is an all-or-nothing object; JSON strings/null booleans fail.
    discount_on := coalesce(r.discount_enabled,false);
    discount_limit := r.discount_threshold; discount_percent := r.discount_percentage;
    if p_payload ?| array['discountEnabled','discountThreshold','discountPercentage'] then
      if not p_payload ?& array['discountEnabled','discountThreshold','discountPercentage']
         or jsonb_typeof(p_payload->'discountEnabled') is distinct from 'boolean'
         or jsonb_typeof(p_payload->'discountThreshold') not in ('number','null')
         or jsonb_typeof(p_payload->'discountPercentage') not in ('number','null') then
        raise exception using errcode='22023',message='B5_INVALID_DISCOUNT';
      end if;
      discount_on := (p_payload->>'discountEnabled')::boolean;
      discount_limit := (p_payload->>'discountThreshold')::numeric;
      discount_percent := (p_payload->>'discountPercentage')::numeric;
    end if;
    if not ((not discount_on and discount_limit is null and discount_percent is null)
      or (discount_limit is not null and discount_percent is not null
        and not public.scanym_numeric_is_non_finite(discount_limit)
        and discount_limit between 0 and 99999999.99 and discount_limit=round(discount_limit,2)
        and not public.scanym_numeric_is_non_finite(discount_percent)
        and discount_percent between 0 and 100 and discount_percent=round(discount_percent,2))) then
      raise exception using errcode='22023',message='B5_INVALID_DISCOUNT';
    end if;
    if p_rule_id is null then
      select coalesce(max(display_order),-1)+1 into v_order from public.restaurant_sale_mode_fulfillments where restaurant_id=p_restaurant_id and mode_code='delivery';
      insert into public.restaurant_sale_mode_fulfillments(restaurant_id,mode_code,fulfillment_code,provider,zone_prefixes,is_fallback,enabled,
        display_order,pricing_mode,fixed_fee,free_threshold,customer_text,min_items,discount_enabled,discount_threshold,discount_percentage)
      values(p_restaurant_id,'delivery',btrim(p_payload->>'fulfillmentCode'),p_payload->>'provider',zones,(p_payload->>'isFallback')::boolean,
        (p_payload->>'enabled')::boolean,v_order,mode,fee,threshold,nullif(btrim(p_payload->>'customerText'),''),(p_payload->>'minItems')::integer,discount_on,discount_limit,discount_percent)
      returning id into v_id;
    else
      update public.restaurant_sale_mode_fulfillments set fulfillment_code=btrim(p_payload->>'fulfillmentCode'),provider=p_payload->>'provider',
        zone_prefixes=zones,is_fallback=(p_payload->>'isFallback')::boolean,enabled=(p_payload->>'enabled')::boolean,
        pricing_mode=mode,fixed_fee=fee,free_threshold=threshold,customer_text=nullif(btrim(p_payload->>'customerText'),''),
        min_items=(p_payload->>'minItems')::integer,discount_enabled=discount_on,
        discount_threshold=discount_limit,discount_percentage=discount_percent where id=r.id;
      v_id := r.id;
    end if;
  else raise exception using errcode='22023',message='B234_INVALID_ACTION'; end if;
  perform scanym_internal.assert_delivery_zones(p_restaurant_id);
  return v_id;
end $$;
revoke all on function public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb) to authenticated;

do $delete_v1_rollback_postcheck$ declare r text; begin
  if (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc
      where oid=to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)'))
     is distinct from 'b767b326459cbd05cb0b11d34919690f' then
    raise exception 'DELETE_V1_ROLLBACK_POSTCHECK: writer body mismatch';
  end if;
  if has_function_privilege('anon','public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)','EXECUTE')
     or has_function_privilege('service_role','public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)','EXECUTE')
     or not has_function_privilege('authenticated','public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)','EXECUTE')
     or not (select p.prosecdef from pg_proc p where p.oid=to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)')) then
    raise exception 'DELETE_V1_ROLLBACK_POSTCHECK: writer ACL / security-definer posture changed';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r,'public.restaurant_sale_mode_fulfillments','INSERT,UPDATE,DELETE')
       or has_any_column_privilege(r,'public.restaurant_sale_mode_fulfillments','INSERT,UPDATE') then
      raise exception 'DELETE_V1_ROLLBACK_POSTCHECK: direct write grant on delivery rules for %',r;
    end if;
  end loop;
end $delete_v1_rollback_postcheck$;

commit;
