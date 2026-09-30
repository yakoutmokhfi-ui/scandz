-- Delivery Pricing v2 B2+B3+B4. LOCAL / DRAFT ONLY. No Production/PREPROD execution.
-- B1 must be installed first. No changes to create_order, resolver or snapshots.
begin;
do $$ begin
  if to_regclass('public.order_delivery_fulfillment_snapshot') is null then
    raise exception 'B234_REQUIRES_B1';
  end if;
end $$;
create schema if not exists scanym_internal;

-- SQL enforcement of the BLOCKING subset of the B0 contract. Advisory findings
-- remain in the existing TypeScript validator; this function never calculates fees.
-- Tested differentially against B0 fixtures and generated configurations.
create function scanym_internal.delivery_zone_blockers(p_rules jsonb, p_shape jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  r jsonb; earlier jsonb; z text; ez text; code text; found_cover boolean;
  findings jsonb := '[]'; seen_orders integer[] := '{}'; has_default boolean := false;
  any_zone boolean := false; n integer := (p_shape->>'exactLength')::integer;
  alphabet integer := case when p_shape->>'allowedChars' = 'digits' then 10 else 62 end;
  pattern text := case when p_shape->>'allowedChars' = 'digits' then '^[0-9]+$' else '^[A-Za-z0-9]+$' end;
  covering text[]; kept text[]; total numeric;
begin
  if jsonb_array_length(p_rules)=0 then return '[]'; end if;
  for r in select value from jsonb_array_elements(p_rules) loop
    if (r->>'displayOrder')::integer = any(seen_orders) then
      findings := findings || jsonb_build_object('code','ZV-INPUT-DUPLICATE-ORDER','ruleId',r->'ruleId','zone',null);
    end if;
    seen_orders := array_append(seen_orders,(r->>'displayOrder')::integer);
    if (r->>'isDefault')::boolean then
      if has_default then
        findings := findings || jsonb_build_object('code','ZV-INPUT-MULTIPLE-DEFAULTS','ruleId',r->'ruleId','zone',null);
      end if;
      has_default := true;
    elsif jsonb_array_length(r->'zones') = 0 then
      findings := findings || jsonb_build_object('code','ZV-EMPTY-ZONES','ruleId',r->'ruleId','zone',null);
    end if;
    for z in select value from jsonb_array_elements_text(r->'zones') loop
      any_zone := true;
      code := case when z collate "C" !~ pattern then 'ZV-FORM-INVALID'
                   when length(z) > n then 'ZV-TOO-LONG' else null end;
      if code is not null then
        findings := findings || jsonb_build_object('code',code,'ruleId',r->'ruleId','zone',z);
      end if;
    end loop;
  end loop;
  if not has_default and not any_zone then
    findings := findings || jsonb_build_object('code','ZV-NO-DEFAULT-NO-ZONES','ruleId',null,'zone',null);
  end if;
  for r in select value from jsonb_array_elements(p_rules) loop
    if (r->>'isDefault')::boolean then continue; end if;
    for z in select distinct value from jsonb_array_elements_text(r->'zones') loop
      if z collate "C" !~ pattern or length(z) > n then continue; end if;
      found_cover := false; covering := '{}';
      for earlier in select value from jsonb_array_elements(p_rules)
          where not (value->>'isDefault')::boolean
            and (value->>'displayOrder')::integer < (r->>'displayOrder')::integer
          order by (value->>'displayOrder')::integer loop
        for ez in select value from jsonb_array_elements_text(earlier->'zones') loop
          if ez collate "C" !~ pattern or length(ez) > n then continue; end if;
          if starts_with(z,ez) then
            findings := findings || jsonb_build_object('code',case when z=ez then 'ZV-DUPLICATE-ACROSS' else 'ZV-COVERED-BY-HIGHER' end,
              'ruleId',r->'ruleId','zone',z);
            found_cover := true; exit;
          elsif starts_with(ez,z) then covering := array_append(covering,ez); end if;
        end loop;
        if found_cover then exit; end if;
      end loop;
      -- B0 abstains above 2^53; do not claim a stronger B0 decision there.
      if not found_cover and length(z)<n and power(alphabet::numeric,n)<=9007199254740992 then
        kept := '{}'; total := 0;
        for ez in select x from (select distinct unnest(covering) x) q order by x collate "C" loop
          if not exists(select 1 from unnest(kept) k where starts_with(ez,k)) then
            kept := array_append(kept,ez); total := total + power(alphabet::numeric,n-length(ez));
          end if;
        end loop;
        if total = power(alphabet::numeric,n-length(z)) then
          findings := findings || jsonb_build_object('code','ZV-UNREACHABLE-BY-HIGHER-SET','ruleId',r->'ruleId','zone',z);
        end if;
      end if;
    end loop;
  end loop;
  return findings;
end $$;
revoke all on function scanym_internal.delivery_zone_blockers(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Adapter for the fixed-length numeric formats actually supported by L1.
-- It accepts a precisely bounded grammar, never an arbitrary regex approximation.
create function scanym_internal.delivery_postal_shape(p_pattern text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare m text[];
begin
  m := regexp_match(p_pattern, '^\^\[0-9\]\{([1-9][0-9]?)\}[$]$');
  if m is null or m[1]::int > 15 then
    raise exception using errcode='22023', message='B234_POSTAL_SHAPE_UNSUPPORTED';
  end if;
  return jsonb_build_object('allowedChars','digits','exactLength',m[1]::int,'minPrefixLength',2);
end $$;
revoke all on function scanym_internal.delivery_postal_shape(text) from public,anon,authenticated,service_role;

create function scanym_internal.assert_delivery_zones(p_restaurant_id uuid)
returns void language plpgsql set search_path = '' as $$
declare rules jsonb; shapes jsonb; shape jsonb; all_findings jsonb := '[]'; f jsonb; bad jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('ruleId',f.id,'label',f.fulfillment_code,
    'displayOrder',f.display_order,'isDefault',f.is_fallback,'zones',f.zone_prefixes)
    order by f.display_order),'[]') into rules
  from public.restaurant_sale_mode_fulfillments f join public.restaurant_sale_modes m
    on m.restaurant_id=f.restaurant_id and m.mode_code=f.mode_code
  where f.restaurant_id=p_restaurant_id and f.mode_code='delivery' and f.enabled and m.enabled;
  -- An empty active set is legitimate: create_order retains its existing legacy
  -- path. It is NOT a B0 configuration containing an empty non-default tariff.
  if jsonb_array_length(rules)=0 then return; end if;
  select coalesce(jsonb_agg(distinct scanym_internal.delivery_postal_shape(c.postal_code_pattern)),'[]') into shapes
  from public.restaurant_delivery_countries dc join public.scanym_country_delivery_capability c using(country_code)
  where dc.restaurant_id=p_restaurant_id and c.delivery_capable;
  -- No deliverable country => no participating postal domain. Revalidate when
  -- the country set changes, not against an invented default country.
  if jsonb_array_length(shapes)=0 then return; end if;
  for shape in select value from jsonb_array_elements(shapes) loop
    for f in select value from jsonb_array_elements(scanym_internal.delivery_zone_blockers(rules,shape)) loop
      all_findings := all_findings || (f || jsonb_build_object('shape',shape));
    end loop;
  end loop;
  -- Rules are country-agnostic in the existing resolver. A zone may be reachable
  -- in ANY enabled country's domain (e.g. 4-digit BE vs 5-digit FR). Reject it
  -- only if B0 blocks that zone in EVERY domain. Global/rule findings apply in all.
  select jsonb_agg(b.item - 'shape') into bad from (
    select distinct on (value->>'ruleId',value->>'zone') value item
    from jsonb_array_elements(all_findings) a(value)
    where (select count(distinct x->'shape') from jsonb_array_elements(all_findings) x
      where x->'ruleId' = a.value->'ruleId' and x->'zone' = a.value->'zone') = jsonb_array_length(shapes)
    order by value->>'ruleId',value->>'zone',value->>'code'
  ) b;
  if bad is not null then
    raise exception using errcode='22023',message='B234_INVALID_ZONES',detail=bad::text;
  end if;
end $$;
revoke all on function scanym_internal.assert_delivery_zones(uuid) from public,anon,authenticated,service_role;

-- Trigger validation also covers the old pricing RPC and operator paths. An
-- advisory transaction lock prevents concurrent inserts validating stale sets.
create function scanym_internal.lock_delivery_rules() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(new.restaurant_id,old.restaurant_id)::text,234));
  return coalesce(new,old);
end $$;
create function scanym_internal.check_delivery_rules() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform scanym_internal.assert_delivery_zones(coalesce(new.restaurant_id,old.restaurant_id));
  return null;
end $$;
revoke all on function scanym_internal.lock_delivery_rules(),scanym_internal.check_delivery_rules() from public,anon,authenticated,service_role;
create trigger b234_lock_rules before insert or update or delete on public.restaurant_sale_mode_fulfillments
  for each row execute function scanym_internal.lock_delivery_rules();
create constraint trigger b234_check_rules after insert or update or delete on public.restaurant_sale_mode_fulfillments
  deferrable initially deferred for each row execute function scanym_internal.check_delivery_rules();
create trigger b234_lock_modes before insert or update or delete on public.restaurant_sale_modes
  for each row execute function scanym_internal.lock_delivery_rules();
create constraint trigger b234_check_modes after insert or update or delete on public.restaurant_sale_modes
  deferrable initially deferred for each row execute function scanym_internal.check_delivery_rules();
create trigger b234_lock_countries before insert or update or delete on public.restaurant_delivery_countries
  for each row execute function scanym_internal.lock_delivery_rules();
create constraint trigger b234_check_countries after insert or update or delete on public.restaurant_delivery_countries
  deferrable initially deferred for each row execute function scanym_internal.check_delivery_rules();

-- Existing read, additive fields, preserving translation metadata and operator access.
drop function public.get_merchant_delivery_fulfillment_pricing(uuid);
create function public.get_merchant_delivery_fulfillment_pricing(p_restaurant_id uuid)
returns table(rule_id uuid,fulfillment_label text,pricing_mode text,fixed_fee numeric,free_threshold numeric,
  customer_text text,customer_text_hash text,translations jsonb,zone_prefixes text[],display_order integer,
  is_fallback boolean,enabled boolean,provider text,fulfillment_code text,min_items integer)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='28000',message='Authentication required'; end if;
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception using errcode='42501',message='Not authorized for this restaurant';
  end if;
  return query select f.id,f.fulfillment_code,f.pricing_mode,f.fixed_fee,f.free_threshold,f.customer_text,
    f.customer_text_hash,f.translations,f.zone_prefixes,f.display_order,f.is_fallback,f.enabled,f.provider,f.fulfillment_code,f.min_items
    from public.restaurant_sale_mode_fulfillments f where f.restaurant_id=p_restaurant_id and f.mode_code='delivery'
    order by f.display_order;
end $$;
revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public,anon,service_role;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;

create function public.mutate_merchant_delivery_rule(p_restaurant_id uuid,p_action text,p_rule_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.restaurant_sale_mode_fulfillments%rowtype; other_rule public.restaurant_sale_mode_fulfillments%rowtype;
  v_id uuid; v_order integer; spare integer; zones text[]; mode text; fee numeric; threshold numeric;
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
       or exists(select 1 from jsonb_object_keys(p_payload) k where k<>all(array['zones','fulfillmentCode','provider','enabled','isFallback','pricingMode','fixedFee','freeThreshold','customerText','minItems'])) then
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
    if p_rule_id is null then
      select coalesce(max(display_order),-1)+1 into v_order from public.restaurant_sale_mode_fulfillments where restaurant_id=p_restaurant_id and mode_code='delivery';
      insert into public.restaurant_sale_mode_fulfillments(restaurant_id,mode_code,fulfillment_code,provider,zone_prefixes,is_fallback,enabled,
        display_order,pricing_mode,fixed_fee,free_threshold,customer_text,min_items)
      values(p_restaurant_id,'delivery',btrim(p_payload->>'fulfillmentCode'),p_payload->>'provider',zones,(p_payload->>'isFallback')::boolean,
        (p_payload->>'enabled')::boolean,v_order,mode,fee,threshold,nullif(btrim(p_payload->>'customerText'),''),(p_payload->>'minItems')::integer)
      returning id into v_id;
    else
      update public.restaurant_sale_mode_fulfillments set fulfillment_code=btrim(p_payload->>'fulfillmentCode'),provider=p_payload->>'provider',
        zone_prefixes=zones,is_fallback=(p_payload->>'isFallback')::boolean,enabled=(p_payload->>'enabled')::boolean,
        pricing_mode=mode,fixed_fee=fee,free_threshold=threshold,customer_text=nullif(btrim(p_payload->>'customerText'),''),
        min_items=(p_payload->>'minItems')::integer where id=r.id;
      v_id := r.id;
    end if;
  else raise exception using errcode='22023',message='B234_INVALID_ACTION'; end if;
  perform scanym_internal.assert_delivery_zones(p_restaurant_id);
  return v_id;
end $$;
revoke all on function public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb) to authenticated;

create function public.test_merchant_delivery_postcode(p_restaurant_id uuid,p_postal_code text,p_country_code text,p_subtotal numeric,p_total_count integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare country text := nullif(upper(btrim(p_country_code)),''); pattern text; answer jsonb; mode_enabled boolean;
begin
  if auth.uid() is null then raise exception using errcode='28000',message='Authentication required'; end if;
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception using errcode='42501',message='Not authorized for this restaurant';
  end if;
  if p_subtotal is null or public.scanym_numeric_is_non_finite(p_subtotal) or p_subtotal<0
    or p_total_count is null or p_total_count<0 then raise exception using errcode='22023',message='B234_INVALID_CART'; end if;
  if country is null and (select count(*) from public.restaurant_delivery_countries where restaurant_id=p_restaurant_id)=1 then
    select country_code into country from public.restaurant_delivery_countries where restaurant_id=p_restaurant_id;
  end if;
  if country is null then return jsonb_build_object('status','country-required','eligible',false); end if;
  select c.postal_code_pattern into pattern from public.restaurant_delivery_countries dc
    join public.scanym_country_delivery_capability c using(country_code)
    where dc.restaurant_id=p_restaurant_id and dc.country_code=country and c.delivery_capable;
  if not found then return jsonb_build_object('status','country-not-allowed','eligible',false); end if;
  if nullif(btrim(p_postal_code),'') is null or btrim(p_postal_code) !~ pattern then
    return jsonb_build_object('status','invalid-postcode','eligible',false);
  end if;
  select enabled into mode_enabled from public.restaurant_sale_modes where restaurant_id=p_restaurant_id and mode_code='delivery';
  if not coalesce(mode_enabled,false) then return jsonb_build_object('status','mode-disabled','eligible',false); end if;
  if not exists(select 1 from public.restaurant_sale_mode_fulfillments where restaurant_id=p_restaurant_id and mode_code='delivery' and enabled) then
    -- Do not approximate legacy address parsing/pricing and do not modify B1.
    return jsonb_build_object('status','legacy','eligible',null);
  end if;
  select to_jsonb(r) into answer from public.resolve_delivery_fulfillment(p_restaurant_id,'delivery',p_postal_code,p_total_count,p_subtotal) r;
  return answer || jsonb_build_object('status','resolved');
end $$;
revoke all on function public.test_merchant_delivery_postcode(uuid,text,text,numeric,integer) from public,anon,service_role;
grant execute on function public.test_merchant_delivery_postcode(uuid,text,text,numeric,integer) to authenticated;

do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'public.restaurant_sale_mode_fulfillments','INSERT,UPDATE,DELETE') then
      raise exception 'B234_DIRECT_WRITE_GRANT_UNEXPECTED: %',role_name;
    end if;
  end loop;
end $$;
commit;
