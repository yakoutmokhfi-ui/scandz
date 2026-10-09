-- AU LAIT CRU DELIVERY ZONE REMEDIATION v1 / Dirac
-- PREPARATION ONLY: requires separate CIO execution approval. Never executed in Production here.
-- Base: 7bbb70b9f6f7f522b1b452a60b2092a69699ba95
-- Only two configuration rows; no engine, tariff, discount, notice or historical order changes.
-- State fingerprints include ALL seven tenant rows, including disabled rules.
-- A stale snapshot aborts before mutation; re-review rather than weakening checks.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $alc_zone_remediation$
declare
  v_restaurant constant uuid := 'e8647a29-4971-4629-a5e8-1f00650adfb4';
  v_hash text; v_count integer; v_case record; v_result record; v_subtotal numeric;
begin
  -- Same tenant lock as the B234 mutation RPC / triggers, then lock current rows.
  perform pg_advisory_xact_lock(hashtextextended(v_restaurant::text,234));
  perform 1 from public.restaurant_sale_mode_fulfillments
    where restaurant_id=v_restaurant order by id for update;
  if not exists(select 1 from public.restaurants where id=v_restaurant and slug='au-lait-cru' and is_active and status='active')
     or not exists(select 1 from public.restaurant_sale_modes where restaurant_id=v_restaurant and mode_code='delivery' and enabled)
     or not exists(select 1 from public.restaurant_delivery_countries where restaurant_id=v_restaurant and country_code='FR') then
    raise exception 'ALC_ZONE_REMEDIATION_TENANT_CONTEXT';
  end if;
  if md5(replace(pg_get_functiondef(to_regprocedure('public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)')),chr(13)||chr(10),chr(10)))
     is distinct from '91531a809117e3dc882b005c6e372774' then
    raise exception 'ALC_ZONE_REMEDIATION_RESOLVER_DRIFT';
  end if;
  select md5(jsonb_agg(to_jsonb(f) order by f.id)::text) into v_hash
    from public.restaurant_sale_mode_fulfillments f where restaurant_id=v_restaurant;
  if v_hash is distinct from '4f055edce98ab555e342969fc486d43a' then
    raise exception 'ALC_ZONE_REMEDIATION_STATE_DRIFT: expected BEFORE snapshot, got %',v_hash;
  end if;

  update public.restaurant_sale_mode_fulfillments
    set zone_prefixes=array_replace(zone_prefixes,'93008','93000')
    where restaurant_id=v_restaurant and id='1d222236-2958-4ada-a5e5-7ce52a52b438' and mode_code='delivery';
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'ALC_ZONE_REMEDIATION_ROW_COUNT: 1d222236-2958-4ada-a5e5-7ce52a52b438'; end if;

  update public.restaurant_sale_mode_fulfillments
    set zone_prefixes=array_replace(array_replace(array_replace(array_replace(zone_prefixes,'92051','92200'),'92009','92270'),'92004','92600'),'93045','93260'),provider='stuart'
    where restaurant_id=v_restaurant and id='6434ba6a-707f-41ff-8995-1476dc3c8f10' and mode_code='delivery';
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'ALC_ZONE_REMEDIATION_ROW_COUNT: 6434ba6a-707f-41ff-8995-1476dc3c8f10'; end if;

  -- Keep B234/B0 validation enabled; also check immediately before commit.
  perform scanym_internal.assert_delivery_zones(v_restaurant);
  select md5(jsonb_agg(to_jsonb(f) order by f.id)::text) into v_hash
    from public.restaurant_sale_mode_fulfillments f where restaurant_id=v_restaurant;
  if v_hash is distinct from '541b7e5773748b930f0edbe3224f2fc7' then
    raise exception 'ALC_ZONE_REMEDIATION_UNEXPECTED_DELTA: %',v_hash;
  end if;
  for v_case in select * from (values
    ('93000','stuart',10.90::numeric),('92600','stuart',15.90),
    ('92270','stuart',15.90),('92200','stuart',15.90),('93260','stuart',15.90),
    ('75018','stuart',6.90),('69001','chronofresh',18.90)
  ) c(postcode,provider,base_fee) loop
    foreach v_subtotal in array array[50::numeric,99.99,100,100.01] loop
      select * into strict v_result from public.resolve_delivery_fulfillment(v_restaurant,'delivery',v_case.postcode,1,v_subtotal);
      if v_result.eligible is distinct from true or v_result.provider is distinct from v_case.provider
         or v_result.fixed_fee is distinct from v_case.base_fee
         or v_result.delivery_fee is distinct from (
           case
             when v_subtotal >= 100
               then round(v_case.base_fee / 2, 2)
             else v_case.base_fee
           end
         )
         or v_result.is_fallback is distinct from (v_case.postcode='69001') then
        raise exception 'ALC_ZONE_REMEDIATION_RESOLVER: postcode %, subtotal %',v_case.postcode,v_subtotal;
      end if;
    end loop;
  end loop;
end $alc_zone_remediation$;
set constraints all immediate;
commit;
