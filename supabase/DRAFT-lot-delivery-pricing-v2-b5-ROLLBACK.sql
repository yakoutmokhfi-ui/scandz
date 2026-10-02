-- Scanym B5 / Dirac — parametric delivery discount. DRAFT; not deployed.
-- Base 74b83a3cf21784066c3704156cadf80655598df6; normative B1 arbitration:
-- https://github.com/yakoutmokhfi-ui/scanym-orchestrator/issues/17#issuecomment-5914325069
-- No Production/PREPROD execution in this lot. See DELIVERY-PRICING-B5.md.
-- Resolver and B1-A-01 change atomically. No configuration rows or history rewritten.
begin;

-- NON-DESTRUCTIVE ROLLBACK. First explicitly disable all policies through
-- an authorized server configuration operation. Never silently change prices.
-- Columns, constraints, configuration values, v1/v2 history, RLS and ACL stay.
do $b5_rollback$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='create_order') <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: unexpected checkout overloads';
  end if;
  if exists(select 1 from public.restaurant_sale_mode_fulfillments where discount_enabled) then
    raise exception 'SCANYM_B5_ROLLBACK_ACTIVE_POLICY: disable discounts explicitly before rollback';
  end if;
  if (select md5(replace(prosrc, chr(13)||chr(10), chr(10))) from pg_proc
      where oid='public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)'::regprocedure)
      is distinct from 'd222dfa84dd4500fa371f5e2ee9cde48' then
    raise exception 'SCANYM_SCHEMA_DRIFT: rollback would overwrite non-B5 resolver changes';
  end if;
end $b5_rollback$;

-- Surgical replacement of the audited B1 body: four unique anchors only.
-- pg_get_functiondef preserves signature, defaults, SECURITY DEFINER and ACL.
do $b5_patch$
declare
  v_def text := replace(pg_get_functiondef('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure), chr(13)||chr(10), chr(10));
  v_old text;
  v_new text;
begin
  v_old := $b5_old0$  v_resolved           record;
  v_expected_delivery_fee numeric;$b5_old0$;
  v_new := $b5_new0$  v_resolved           record;$b5_new0$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 1 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := $b5_old1$    -- B5: independently transcribe the resolver formula. Keep unknown modes
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
$b5_old1$;
  v_new := $b5_new1$    if v_delivery_fee is distinct from (
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
$b5_new1$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 2 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := $b5_old2$      pricing_mode, fixed_fee, free_threshold, customer_text,
      discount_threshold, discount_percentage, snapshot_method_version
$b5_old2$;
  v_new := $b5_new2$      pricing_mode, fixed_fee, free_threshold, customer_text
$b5_new2$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 3 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := $b5_old3$      v_resolved.customer_text,
      case when v_resolved.discount_enabled then v_resolved.discount_threshold end,
      case when v_resolved.discount_enabled then v_resolved.discount_percentage end,
      case when v_resolved.discount_enabled then 'v2' else 'v1' end
$b5_old3$;
  v_new := $b5_new3$      v_resolved.customer_text
$b5_new3$;
  v_old := replace(v_old, chr(13)||chr(10), chr(10));
  v_new := replace(v_new, chr(13)||chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: B5 create_order anchor 4 not unique';
  end if;
  v_def := replace(v_def, v_old, v_new);
  if md5(v_def) <> '9de8eb2349d7ee5e1b28c3681739c717' then
    raise exception 'SCANYM_SCHEMA_DRIFT: rollback would overwrite non-B5 create_order changes';
  end if;
  execute v_def;
end $b5_patch$;

-- Prevent future activation while the restored B1 calculator ignores B5.
alter table public.restaurant_sale_mode_fulfillments
  add constraint rsmf_discount_disabled_during_rollback check (not discount_enabled);
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
  missing             integer
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
           f.pricing_mode, f.fixed_fee, f.free_threshold
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
      when s.fulfillment_code is null then null
      when s.pricing_mode = 'free' then 0
      when s.pricing_mode = 'fixed' then s.fixed_fee
      when s.pricing_mode = 'free_above_threshold' then
        case when coalesce(p_subtotal, 0) >= s.free_threshold then 0 else s.fixed_fee end
      else null
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
    end as missing
  from (select 1) one
  left join selected s on true;
$$;
comment on function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric) is
  'B1 calculator restored by B5 rollback. Discount activation is prohibited by rsmf_discount_disabled_during_rollback until a reviewed forward migration restores B5 atomically.';
revoke all on function public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)
  from public, anon, authenticated, service_role;

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


-- Restore the exact installed B234/public predecessors (body, owner, ACL, comment).
do $b5_restore$ declare r record; g jsonb; grantee_sql text; begin
  for r in select * from scanym_internal.b5_predecessor order by sig loop
    if md5(replace(pg_get_functiondef(to_regprocedure(r.sig)),chr(13)||chr(10),chr(10))) is distinct from r.installed_md5 then
      raise exception 'SCANYM_SCHEMA_DRIFT: rollback would overwrite modified %',r.sig;
    end if;
  end loop;
  for r in select * from scanym_internal.b5_predecessor order by sig loop
    execute 'drop function '||r.sig;
    execute r.definition;
    execute format('alter function %s owner to %I',r.sig,r.owner_name);
    execute 'revoke all on function '||r.sig||' from public,anon,authenticated,service_role';
    for g in select value from jsonb_array_elements(r.grants) loop
      grantee_sql := case when g->>'grantee'='PUBLIC' then 'PUBLIC' else quote_ident(g->>'grantee') end;
      execute 'grant execute on function '||r.sig||' to '||grantee_sql||case when (g->>'grantable')::boolean then ' with grant option' else '' end;
    end loop;
    execute format('comment on function %s is %L',r.sig,r.description);
  end loop;
end $b5_restore$;
drop table scanym_internal.b5_predecessor;

commit;
