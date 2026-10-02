-- Scanym B5 / Dirac — parametric delivery discount. DRAFT; not deployed.
-- Base 24dde51ac047100de7d23c6b28d78b54f013a72c (final B234); normative B1 arbitration:
-- https://github.com/yakoutmokhfi-ui/scanym-orchestrator/issues/17#issuecomment-5914325069
-- No Production/PREPROD execution in this lot. See DELIVERY-PRICING-B5.md.
-- Resolver and B1-A-01 change atomically. No configuration rows or history rewritten.
begin;

-- Exact final B234 and live-shaped public projection, normalized for CRLF only.
do $b5_composition_preflight$ begin
  if to_regprocedure('public.get_merchant_delivery_fulfillment_pricing(uuid)') is null or
     (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc where oid=to_regprocedure('public.get_merchant_delivery_fulfillment_pricing(uuid)'))
       is distinct from '9fb1ff0fbf866e7a1af7f3f50098d99e' then
    raise exception 'SCANYM_SCHEMA_DRIFT: expected final B234/public projection get_merchant_delivery_fulfillment_pricing';
  end if;
  if to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)') is null or
     (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc where oid=to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)'))
       is distinct from '73e2fcae7de89abbb9a225ccd5b6392a' then
    raise exception 'SCANYM_SCHEMA_DRIFT: expected final B234/public projection mutate_merchant_delivery_rule';
  end if;
  if to_regprocedure('public.get_restaurant_public_delivery_fulfillments(uuid)') is null or
     (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc where oid=to_regprocedure('public.get_restaurant_public_delivery_fulfillments(uuid)'))
       is distinct from 'e837469e43cef6ebf6e685dfe08ef91f' then
    raise exception 'SCANYM_SCHEMA_DRIFT: expected final B234/public projection get_restaurant_public_delivery_fulfillments';
  end if;
end $b5_composition_preflight$;
-- Rollback metadata contains definitions/ACL only, never customer/business data.
create table scanym_internal.b5_predecessor(sig text primary key,definition text not null,
  owner_name text not null,grants jsonb,description text,installed_md5 text);
alter table scanym_internal.b5_predecessor enable row level security;
revoke all on scanym_internal.b5_predecessor from public,anon,authenticated,service_role;
insert into scanym_internal.b5_predecessor(sig,definition,owner_name,grants,description)
select p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),
  (select jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'grantable',a.is_grantable))
   from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),obj_description(p.oid,'pg_proc')
from pg_proc p where p.oid in ('public.get_merchant_delivery_fulfillment_pricing(uuid)'::regprocedure,'public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)'::regprocedure,'public.get_restaurant_public_delivery_fulfillments(uuid)'::regprocedure);

do $b5_preflight$
begin
  if to_regclass('public.order_delivery_fulfillment_snapshot') is null
     or to_regprocedure('public.scanym_numeric_is_non_finite(numeric)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: B1 prerequisite missing';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='create_order') <> 1
     or to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)') is null
     or md5(replace(pg_get_functiondef('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure), chr(13)||chr(10), chr(10)))
        is distinct from '9de8eb2349d7ee5e1b28c3681739c717' then
    raise exception 'SCANYM_SCHEMA_DRIFT: expected audited B1 create_order; reconcile B234 before applying B5';
  end if;
  if to_regprocedure('public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)') is null
     or md5(replace(pg_get_functiondef('public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)'::regprocedure), chr(13)||chr(10), chr(10)))
        is distinct from '0277502f9f1647d6866b2b1d5fd2a994' then
    raise exception 'SCANYM_SCHEMA_DRIFT: expected baseline delivery resolver';
  end if;
end $b5_preflight$;

-- Exact decimals, validated BEFORE any scale coercion. Monetary bounds
-- match the existing numeric(10,2) rule fields; precision > cents is refused.
alter table public.restaurant_sale_mode_fulfillments
  add column discount_enabled boolean not null default false,
  add column discount_threshold numeric,
  add column discount_percentage numeric,
  add constraint rsmf_discount_policy_valid check (
    (not discount_enabled and discount_threshold is null and discount_percentage is null)
    or (discount_threshold is not null and discount_percentage is not null
        and not public.scanym_numeric_is_non_finite(discount_threshold)
        and discount_threshold between 0 and 99999999.99
        and discount_threshold = round(discount_threshold, 2)
        and not public.scanym_numeric_is_non_finite(discount_percentage)
        and discount_percentage between 0 and 100
        and discount_percentage = round(discount_percentage, 2))
  );
alter table public.order_delivery_fulfillment_snapshot
  add column discount_threshold numeric,
  add column discount_percentage numeric,
  add constraint odfs_discount_facts_valid check (
    (discount_threshold is null and discount_percentage is null)
    or (discount_threshold is not null and discount_percentage is not null
        and not public.scanym_numeric_is_non_finite(discount_threshold)
        and discount_threshold between 0 and 99999999.99
        and discount_threshold = round(discount_threshold, 2)
        and not public.scanym_numeric_is_non_finite(discount_percentage)
        and discount_percentage between 0 and 100
        and discount_percentage = round(discount_percentage, 2))
  );

-- Return type is internal only; never CASCADE. A dependent object makes this
-- release fail atomically instead of silently removing another lot's object.
drop function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric);
create function public.resolve_delivery_fulfillment(
  p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer, p_subtotal numeric default null
)
returns table (
  eligible            boolean,
  fulfillment_rule_id uuid,
  fulfillment_code    text,
  provider            text,
  matched_prefix      text,
  zone_prefixes       text[],
  is_fallback         boolean,
  min_items           integer,
  customer_text       text,
  display_order       integer,
  pricing_mode        text,
  fixed_fee           numeric,
  free_threshold      numeric,
  delivery_fee        numeric,
  block               text,
  missing             integer,
  discount_enabled    boolean,
  discount_threshold  numeric,
  discount_percentage numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with normalized as (
    select nullif(btrim(p_postal_code), '') as code
  ),
  parent_mode_enabled as (
    select exists (
      select 1
      from public.restaurant_sale_modes rsm
      where rsm.restaurant_id = p_restaurant_id
        and rsm.mode_code = p_mode_code
        and rsm.enabled = true
    ) as enabled
  ),
  candidate_rules as (
    select f.id, f.fulfillment_code, f.provider, f.zone_prefixes, f.is_fallback,
           f.min_items, f.customer_text, f.display_order,
           f.pricing_mode, f.fixed_fee, f.free_threshold,
           f.discount_enabled, f.discount_threshold, f.discount_percentage
    from public.restaurant_sale_mode_fulfillments f
    where f.restaurant_id = p_restaurant_id
      and f.mode_code = p_mode_code
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
        and coalesce(p_total_count, 0) < s.min_items
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
      when s.discount_enabled and coalesce(p_subtotal, 0) >= s.discount_threshold then
        round((case
      when s.fulfillment_code is null then null
      when s.pricing_mode = 'free' then 0
      when s.pricing_mode = 'fixed' then s.fixed_fee
      when s.pricing_mode = 'free_above_threshold' then
        case when coalesce(p_subtotal, 0) >= s.free_threshold then 0 else s.fixed_fee end
      else null
    end) * (1 - s.discount_percentage / 100), 2)
      else case
      when s.fulfillment_code is null then null
      when s.pricing_mode = 'free' then 0
      when s.pricing_mode = 'fixed' then s.fixed_fee
      when s.pricing_mode = 'free_above_threshold' then
        case when coalesce(p_subtotal, 0) >= s.free_threshold then 0 else s.fixed_fee end
      else null
    end
    end as delivery_fee,
    case
      when (select code from normalized) is null then 'no-postal'
      when s.fulfillment_code is null then 'out-of-zone'
      when s.min_items is not null and coalesce(p_total_count, 0) < s.min_items then 'below-min'
      else null
    end as block,
    case
      when s.fulfillment_code is not null
       and s.min_items is not null
       and coalesce(p_total_count, 0) < s.min_items
        then s.min_items - coalesce(p_total_count, 0)
      else null
    end as missing,
    s.discount_enabled,
    s.discount_threshold,
    s.discount_percentage
  from (select 1) one
  left join selected s on true;
$$;
revoke all on function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)
  from public, anon, authenticated, service_role;

-- Surgical replacement of the audited B1 body: four unique anchors only.
-- pg_get_functiondef preserves signature, defaults, SECURITY DEFINER and ACL.
do $b5_patch$
declare
  v_def text := replace(pg_get_functiondef('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure), chr(13)||chr(10), chr(10));
  v_old text;
  v_new text;
begin
  v_old := $b5_old0$  v_resolved           record;$b5_old0$;
  v_new := $b5_new0$  v_resolved           record;
  v_expected_delivery_fee numeric;$b5_new0$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 1 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := $b5_old1$    if v_delivery_fee is distinct from (
      case
        when v_resolved.pricing_mode = 'free' then 0
        when v_resolved.pricing_mode = 'fixed' then v_resolved.fixed_fee
        when v_resolved.pricing_mode = 'free_above_threshold' then
          case when coalesce(v_subtotal, 0) >= v_resolved.free_threshold
               then 0 else v_resolved.fixed_fee end
        else null
      end
    ) then
      raise exception
        'SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT: frais appliqué (%) incohérent avec le tarif résolu (mode %, fixe %, seuil %, sous-total %) -- commande refusée',
        v_delivery_fee, v_resolved.pricing_mode, v_resolved.fixed_fee,
        v_resolved.free_threshold, v_subtotal
        using errcode = '22023';
    end if;
$b5_old1$;
  v_new := $b5_new1$    -- B5: independently transcribe the resolver formula. Keep unknown modes
    -- NULL so that even a resolver returning zero fails closed (B1-T16).
    v_expected_delivery_fee := case
      when v_resolved.pricing_mode = 'free' then 0
      when v_resolved.pricing_mode = 'fixed' then v_resolved.fixed_fee
      when v_resolved.pricing_mode = 'free_above_threshold' then
        case when coalesce(v_subtotal, 0) >= v_resolved.free_threshold
             then 0 else v_resolved.fixed_fee end
      else null
    end;
    if v_resolved.discount_enabled then
      if coalesce(v_subtotal, 0) >= v_resolved.discount_threshold then
        v_expected_delivery_fee := round(
          v_expected_delivery_fee * (1 - v_resolved.discount_percentage / 100), 2);
      end if;
    end if;
    if v_resolved.discount_enabled is null
       or v_resolved.delivery_fee is distinct from v_expected_delivery_fee
       or v_delivery_fee is distinct from v_expected_delivery_fee then
      raise exception
        'SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT: resolved fee (%) differs from B1-A-01 (%) -- order refused',
        v_delivery_fee, v_expected_delivery_fee using errcode = '22023';
    end if;
$b5_new1$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 2 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := $b5_old2$      pricing_mode, fixed_fee, free_threshold, customer_text
$b5_old2$;
  v_new := $b5_new2$      pricing_mode, fixed_fee, free_threshold, customer_text,
      discount_threshold, discount_percentage, snapshot_method_version
$b5_new2$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 3 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := $b5_old3$      v_resolved.customer_text
$b5_old3$;
  v_new := $b5_new3$      v_resolved.customer_text,
      case when v_resolved.discount_enabled then v_resolved.discount_threshold end,
      case when v_resolved.discount_enabled then v_resolved.discount_percentage end,
      case when v_resolved.discount_enabled then 'v2' else 'v1' end
$b5_new3$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 4 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $b5_patch$;

comment on column public.restaurant_sale_mode_fulfillments.discount_enabled is
  'Apply the separately configured percentage discount to the existing base tariff when subtotal >= discount_threshold. False by default; never client-authoritative.';
comment on column public.restaurant_sale_mode_fulfillments.discount_threshold is
  'Basket subtotal in the rule currency, excluding delivery. Exact cents, zero allowed; required together with percentage when enabled.';
comment on column public.restaurant_sale_mode_fulfillments.discount_percentage is
  'Exact percentage from 0 through 100, at most two fractional digits. Retain valid values while disabled. Final fee rounded once to cents in PostgreSQL.';
comment on column public.order_delivery_fulfillment_snapshot.discount_threshold is
  'Enabled discount policy threshold copied from the single resolver row at checkout, including when below threshold. NULL for v1; never backfilled.';
comment on column public.order_delivery_fulfillment_snapshot.discount_percentage is
  'Enabled discount percentage copied at checkout. The applied amount is derivable from these facts, the base tariff, and orders.subtotal; final fee remains orders.delivery_fee.';
comment on function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric) is
  'B5: unchanged routing; base free/fixed/free_above_threshold tariff followed by an optional server-owned percentage discount at subtotal >= discount_threshold. Exact numeric arithmetic, round final fee to cents. Three policy fields appended to internal result; no application-role EXECUTE.';

do $b5_postflight$
declare v_role text; v_priv text;
begin
  if pg_get_function_result('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure)
       <> 'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)' then
    raise exception 'SCANYM_SCHEMA_DRIFT: checkout result changed';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.order_delivery_fulfillment_snapshot'::regclass)
     or not (select relrowsecurity from pg_class where oid='public.restaurant_sale_mode_fulfillments'::regclass) then
    raise exception 'SCANYM_SCHEMA_DRIFT: RLS must remain enabled';
  end if;
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(v_role, 'public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)', 'EXECUTE') then
      raise exception 'SCANYM_SCHEMA_DRIFT: internal resolver exposed to %', v_role;
    end if;
    foreach v_priv in array array['INSERT','UPDATE','DELETE','TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.order_delivery_fulfillment_snapshot', v_priv) then
        raise exception 'SCANYM_SCHEMA_DRIFT: snapshot write privilege for %', v_role;
      end if;
    end loop;
  end loop;
end $b5_postflight$;


-- B234 access checks, advisory lock, last-active confirmation and B0 remain verbatim.
drop function public.get_merchant_delivery_fulfillment_pricing(uuid);
create function public.get_merchant_delivery_fulfillment_pricing(p_restaurant_id uuid)
returns table(rule_id uuid,fulfillment_label text,pricing_mode text,fixed_fee numeric,free_threshold numeric,
  customer_text text,customer_text_hash text,translations jsonb,zone_prefixes text[],display_order integer,
  is_fallback boolean,enabled boolean,provider text,fulfillment_code text,min_items integer,discount_enabled boolean,discount_threshold numeric,discount_percentage numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='28000',message='Authentication required'; end if;
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception using errcode='42501',message='Not authorized for this restaurant';
  end if;
  return query select f.id,f.fulfillment_code,f.pricing_mode,f.fixed_fee,f.free_threshold,f.customer_text,
    f.customer_text_hash,f.translations,f.zone_prefixes,f.display_order,f.is_fallback,f.enabled,f.provider,f.fulfillment_code,f.min_items,f.discount_enabled,f.discount_threshold,f.discount_percentage
    from public.restaurant_sale_mode_fulfillments f where f.restaurant_id=p_restaurant_id and f.mode_code='delivery'
    order by f.display_order;
end $$;
revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public,anon,service_role;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;
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
drop function public.get_restaurant_public_delivery_fulfillments(uuid);
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
  translations     jsonb,
  pricing_mode text, fixed_fee numeric, free_threshold numeric,
  discount_enabled boolean, discount_threshold numeric, discount_percentage numeric
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
    f.translations,
    f.pricing_mode, f.fixed_fee, f.free_threshold,
    f.discount_enabled, f.discount_threshold, f.discount_percentage
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
revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_restaurant_public_delivery_fulfillments(uuid) to anon,authenticated;
comment on function public.get_restaurant_public_delivery_fulfillments(uuid) is
  'B5 public estimate facts: existing routing/customer translations plus base tariff and discount policy. No provider or raw config. Checkout remains authoritative.';
update scanym_internal.b5_predecessor set installed_md5=md5(replace(pg_get_functiondef(to_regprocedure(sig)),chr(13)||chr(10),chr(10)));
do $b5_column_acl$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r,'public.restaurant_sale_mode_fulfillments','INSERT,UPDATE,DELETE')
      or has_any_column_privilege(r,'public.restaurant_sale_mode_fulfillments','INSERT,UPDATE') then
      raise exception 'B5_DIRECT_WRITE_GRANT_UNEXPECTED: %',r;
    end if;
  end loop;
end $b5_column_acl$;

commit;
