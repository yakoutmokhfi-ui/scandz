-- ============================================================================
-- ISSUE #171 — COMMANDES NON PAYÉES NON OPÉRATIONNELLES v1 — ROLLBACK
-- Restaure À L'IDENTIQUE les corps antérieurs de
-- get_operator_restaurant_orders_page (DASHBOARD PAGINATION v1) et de
-- update_order_status (V29). Signatures, grants et attributs de sécurité
-- inchangés. Aucune donnée touchée.
-- ============================================================================
do $$
begin
  if not pg_get_functiondef(to_regprocedure('public.update_order_status(uuid,text)')) ilike '%ORDER_PAYMENT_NOT_OPERATIONAL%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: ISSUE #171 non appliqué (garde absente) -- rien à annuler.';
  end if;
end $$;

create or replace function public.get_operator_restaurant_orders_page(
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

comment on function public.get_operator_restaurant_orders_page(uuid, boolean, timestamptz, uuid) is
  'Dashboard pagination v1: operator-only, same ten approved fields; descending (created_at,id), strict cursor, 50 rows + lookahead. No customer details. No writes or RLS changes.';

create or replace function public.update_order_status(
  p_order_id uuid,
  p_new_status text
)
returns table (
  order_id uuid,
  previous_status text,
  new_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_restaurant_id uuid;
  v_previous_status text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required';
  end if;

  if p_new_status is null or p_new_status not in (
    'new','accepted','preparing','ready','completed','rejected','cancelled'
  ) then
    raise exception using
      errcode = '22023',
      message = format('Invalid order status: %s', coalesce(p_new_status, 'null'));
  end if;

  select o.restaurant_id, o.status
    into v_restaurant_id, v_previous_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found';
  end if;

  if not exists (
    select 1
    from public.restaurant_users ru
    where ru.user_id = v_user_id
      and ru.restaurant_id = v_restaurant_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Not authorized for this order';
  end if;


  if not (
       (v_previous_status = 'new'       and p_new_status in ('accepted','rejected','cancelled'))
    or (v_previous_status = 'accepted'  and p_new_status in ('preparing','cancelled'))
    or (v_previous_status = 'preparing' and p_new_status in ('ready','cancelled'))
    or (v_previous_status = 'ready'     and p_new_status = 'completed')
  ) then
    raise exception using
      errcode = '22023',
      message = format(
        'Invalid order transition: %s -> %s',
        v_previous_status,
        p_new_status
      );
  end if;

  update public.orders o
  set status = p_new_status,
      updated_at = now()
  where o.id = p_order_id;

  return query
  select p_order_id, v_previous_status, p_new_status;
end $$;

comment on function public.update_order_status(uuid, text) is
  'V29 merchant dashboard: authenticated member of the order''s restaurant only; kitchen transitions new->accepted/rejected/cancelled, accepted->preparing/cancelled, preparing->ready/cancelled, ready->completed.';
