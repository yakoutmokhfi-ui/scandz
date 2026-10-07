-- DRAFT ONLY — independent audit required. NO PRODUCTION / NO PREPROD.
-- Additive endpoint: the old two-argument RPC remains for old clients/rollback.
-- The dashboard uses this endpoint exclusively; 51 = 50 + one lookahead.
begin;

do $$
begin
  if to_regprocedure('public.get_operator_restaurant_orders(uuid,boolean)') is null
     or to_regprocedure('public.is_scanym_operator()') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: operator read v1 must exist';
  end if;
  if to_regprocedure('public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: pagination already exists';
  end if;
  if pg_get_function_result('public.get_operator_restaurant_orders(uuid,boolean)'::regprocedure)
     <> 'TABLE(id uuid, order_number bigint, status text, service_mode text, created_at timestamp with time zone, updated_at timestamp with time zone, total numeric, currency text, item_count integer, has_invoice_request boolean)' then
    raise exception 'SCANYM_SCHEMA_DRIFT: approved operator projection changed';
  end if;
end $$;

create function public.get_operator_restaurant_orders_page(
  p_restaurant_id uuid,
  p_include_completed boolean default false,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  order_number bigint,
  status text,
  service_mode text,
  created_at timestamptz,
  updated_at timestamptz,
  total numeric,
  currency text,
  item_count integer,
  has_invoice_request boolean
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
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;
  if p_restaurant_id is null then
    raise exception using errcode = '22004', message = 'p_restaurant_id requis';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'Both order cursor fields are required';
  end if;
  return query
  select
    o.id,
    o.order_number::bigint,
    o.status::text,
    o.service_mode::text,
    o.created_at,
    o.updated_at,
    o.total::numeric,
    o.currency::text,
    coalesce((select sum(oi.quantity) from public.order_items oi where oi.order_id = o.id), 0)::integer,
    exists (select 1 from public.order_invoice_request r where r.order_id = o.id)
  from public.orders o
  where o.restaurant_id = p_restaurant_id
    and (coalesce(p_include_completed, false) or o.status not in ('completed', 'rejected', 'cancelled'))
    and (p_before_created_at is null or (o.created_at, o.id) < (p_before_created_at, p_before_id))
  order by o.created_at desc, o.id desc
  limit 51;
end;
$$;

revoke all on function public.get_operator_restaurant_orders_page(uuid, boolean, timestamptz, uuid)
  from public, anon, service_role;
grant execute on function public.get_operator_restaurant_orders_page(uuid, boolean, timestamptz, uuid)
  to authenticated;

comment on function public.get_operator_restaurant_orders_page(uuid, boolean, timestamptz, uuid) is
  'Dashboard pagination v1: operator-only, same ten approved fields; descending (created_at,id), strict cursor, 50 rows + lookahead. No customer details. No writes or RLS changes.';

do $$
declare
  v_fn regprocedure := 'public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)'::regprocedure;
begin
  if pg_get_function_result(v_fn) <>
     pg_get_function_result('public.get_operator_restaurant_orders(uuid,boolean)'::regprocedure)
     or not exists (select 1 from pg_proc where oid = v_fn and prosecdef and provolatile = 's'
                    and proconfig = array['search_path=""']) then
    raise exception 'SCANYM_POST_CHECK_FAILED: operator projection/security drift';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE')
     or has_function_privilege('service_role', v_fn, 'EXECUTE')
     or not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'SCANYM_POST_CHECK_FAILED: operator execute grants';
  end if;
end $$;
commit;
