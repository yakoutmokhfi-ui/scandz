-- AFTER is simulated only; uses unchanged resolver body over a CTE.
begin read only; set local statement_timeout='30s'; with proposed_rules as (select (jsonb_populate_record(null::public.restaurant_sale_mode_fulfillments, to_jsonb(f) || case when f.id='1d222236-2958-4ada-a5e5-7ce52a52b438' then jsonb_build_object('zone_prefixes',array_replace(f.zone_prefixes,'93008','93000')) when f.id='6434ba6a-707f-41ff-8995-1476dc3c8f10' then jsonb_build_object('zone_prefixes',array_replace(array_replace(array_replace(array_replace(f.zone_prefixes,'92051','92200'),'92009','92270'),'92004','92600'),'93045','93260'),'provider','stuart') else '{}'::jsonb end)).* from public.restaurant_sale_mode_fulfillments f where f.restaurant_id='e8647a29-4971-4629-a5e8-1f00650adfb4'), cases(postcode,expected_provider,base_fee) as (values ('93000','stuart',10.90::numeric),('92600','stuart',15.90),('92270','stuart',15.90),('92200','stuart',15.90),('93260','stuart',15.90),('75018','stuart',6.90),('69001','chronofresh',18.90)), t as (select *,1 as total_count from cases cross join (values(50::numeric),(99.99),(100),(100.01)) s(subtotal)) select t.postcode,t.subtotal,t.expected_provider,t.base_fee,before.provider before_provider,before.delivery_fee before_fee,after.provider after_provider,after.delivery_fee after_fee,after.fulfillment_rule_id after_rule,after.is_fallback, (after.eligible and after.provider=t.expected_provider and after.delivery_fee=case when t.subtotal>=100 then round(t.base_fee/2,2) else t.base_fee end) as pass from t cross join lateral public.resolve_delivery_fulfillment('e8647a29-4971-4629-a5e8-1f00650adfb4','delivery',t.postcode,t.total_count,t.subtotal) before cross join lateral (with normalized as (
    select nullif(btrim(t.postcode), '') as code
  ),
  parent_mode_enabled as (
    select exists (
      select 1
      from public.restaurant_sale_modes rsm
      where rsm.restaurant_id = 'e8647a29-4971-4629-a5e8-1f00650adfb4'::uuid
        and rsm.mode_code = 'delivery'::text
        and rsm.enabled = true
    ) as enabled
  ),
  candidate_rules as (
    select f.id, f.fulfillment_code, f.provider, f.zone_prefixes, f.is_fallback,
           f.min_items, f.customer_text, f.display_order,
           f.pricing_mode, f.fixed_fee, f.free_threshold,
           f.discount_enabled, f.discount_threshold, f.discount_percentage
    from proposed_rules f
    where f.restaurant_id = 'e8647a29-4971-4629-a5e8-1f00650adfb4'::uuid
      and f.mode_code = 'delivery'::text
      and f.enabled = true
      and (select enabled from parent_mode_enabled)
      and (select code from normalized) is not null
  ),
  matched_rule as (
    select c.*,
      (select zp.prefix
         from unnest(c.zone_prefixes) with ordinality as zp(prefix, ord)
         where (select code from normalized) like zp.prefix || '%'
         order by zp.ord
         limit 1) as matched_prefix
    from candidate_rules c
    where c.is_fallback = false
      and exists (
        select 1 from unnest(c.zone_prefixes) as zp(prefix)
        where (select code from normalized) like zp.prefix || '%'
      )
    order by c.display_order asc
    limit 1
  ),
  fallback_rule as (
    select c.*, null::text as matched_prefix
    from candidate_rules c
    where c.is_fallback = true
      and not exists (select 1 from matched_rule)
    limit 1
  ),
  selected as (
    select * from matched_rule
    union all
    select * from fallback_rule
    limit 1
  )
  select
    (
      (select code from normalized) is not null
      and s.fulfillment_code is not null
      and not (
        s.min_items is not null
        and coalesce(t.total_count, 0) < s.min_items
      )
    ) as eligible,
    s.id as fulfillment_rule_id,
    s.fulfillment_code,
    s.provider,
    s.matched_prefix,
    s.zone_prefixes,
    s.is_fallback,
    s.min_items,
    s.customer_text,
    s.display_order,
    s.pricing_mode,
    s.fixed_fee,
    s.free_threshold,
    case
      when s.discount_enabled and coalesce(t.subtotal, 0) >= s.discount_threshold then
        round((case
      when s.fulfillment_code is null then null
      when s.pricing_mode = 'free' then 0
      when s.pricing_mode = 'fixed' then s.fixed_fee
      when s.pricing_mode = 'free_above_threshold' then
        case when coalesce(t.subtotal, 0) >= s.free_threshold then 0 else s.fixed_fee end
      else null
    end) * (1 - s.discount_percentage / 100), 2)
      else case
      when s.fulfillment_code is null then null
      when s.pricing_mode = 'free' then 0
      when s.pricing_mode = 'fixed' then s.fixed_fee
      when s.pricing_mode = 'free_above_threshold' then
        case when coalesce(t.subtotal, 0) >= s.free_threshold then 0 else s.fixed_fee end
      else null
    end
    end as delivery_fee,
    case
      when (select code from normalized) is null then 'no-postal'
      when s.fulfillment_code is null then 'out-of-zone'
      when s.min_items is not null and coalesce(t.total_count, 0) < s.min_items then 'below-min'
      else null
    end as block,
    case
      when s.fulfillment_code is not null
       and s.min_items is not null
       and coalesce(t.total_count, 0) < s.min_items
        then s.min_items - coalesce(t.total_count, 0)
      else null
    end as missing,
    s.discount_enabled,
    s.discount_threshold,
    s.discount_percentage
  from (select 1) one
  left join selected s on true) after order by t.postcode,t.subtotal; commit;
