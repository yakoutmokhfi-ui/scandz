-- ============================================================
-- Scanym V29 - Merchant security foundation and receipt settings
-- Additive migration. Existing orders and customer data are preserved.
-- ============================================================

begin;

-- 1. Merchant mappings -------------------------------------------------------
alter table public.restaurant_users enable row level security;

drop policy if exists "membre lit son rattachement" on public.restaurant_users;
drop policy if exists "merchant reads own mappings" on public.restaurant_users;
create policy "merchant reads own mappings"
on public.restaurant_users
for select
to authenticated
using (user_id = auth.uid());

-- 2. Order status model ------------------------------------------------------
-- Stop rather than coercing data if an old/unknown status is present.
do $$
declare
  v_invalid text;
begin
  select string_agg(distinct status, ', ' order by status)
    into v_invalid
  from public.orders
  where status not in (
    'new','accepted','preparing','ready','completed','rejected','cancelled'
  );

  if v_invalid is not null then
    raise exception
      'V29 blocked: unsupported values exist in public.orders.status: %',
      v_invalid;
  end if;
end $$;

-- Remove every CHECK constraint on orders whose expression references status.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* '\mstatus\M'
  loop
    execute format(
      'alter table public.orders drop constraint if exists %I',
      v_constraint.conname
    );
  end loop;
end $$;

alter table public.orders
  add constraint orders_status_check
  check (status in (
    'new','accepted','preparing','ready','completed','rejected','cancelled'
  ));

alter table public.orders
  add column if not exists completed_at timestamptz,
  add column if not exists rejected_at timestamptz;

create or replace function public.orders_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();

  if new.status is distinct from old.status then
    case new.status
      when 'accepted'  then new.accepted_at  := coalesce(new.accepted_at, now());
      when 'preparing' then new.preparing_at := coalesce(new.preparing_at, now());
      when 'ready'     then new.ready_at     := coalesce(new.ready_at, now());
      when 'completed' then new.completed_at := coalesce(new.completed_at, now());
      when 'rejected'  then new.rejected_at  := coalesce(new.rejected_at, now());
      when 'cancelled' then new.cancelled_at := coalesce(new.cancelled_at, now());
      else null;
    end case;
  end if;

  return new;
end $$;

-- 3. Read isolation and removal of generic updates --------------------------
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "personnel lit ses commandes" on public.orders;
drop policy if exists "merchant reads restaurant orders" on public.orders;
create policy "merchant reads restaurant orders"
on public.orders
for select
to authenticated
using (
  exists (
    select 1
    from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = orders.restaurant_id
  )
);

drop policy if exists "personnel modifie ses commandes" on public.orders;
drop policy if exists "merchant updates restaurant orders" on public.orders;
revoke update on table public.orders from authenticated;

drop policy if exists "personnel lit les lignes" on public.order_items;
drop policy if exists "merchant reads restaurant order items" on public.order_items;
create policy "merchant reads restaurant order items"
on public.order_items
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    join public.restaurant_users ru
      on ru.restaurant_id = o.restaurant_id
    where o.id = order_items.order_id
      and ru.user_id = auth.uid()
  )
);

-- 4. Restricted status transition RPC --------------------------------------
drop function if exists public.update_order_status(uuid, text);
create function public.update_order_status(
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

  -- Lock first: concurrent transitions are serialized on this order.
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

revoke all on function public.update_order_status(uuid, text) from public;
revoke all on function public.update_order_status(uuid, text) from anon;
grant execute on function public.update_order_status(uuid, text) to authenticated;

-- Retire the old, permissive RPC from browser roles if it exists.
do $$
begin
  if to_regprocedure('public.set_order_status(uuid,text)') is not null then
    execute 'revoke all on function public.set_order_status(uuid,text) from public';
    execute 'revoke all on function public.set_order_status(uuid,text) from anon';
    execute 'revoke all on function public.set_order_status(uuid,text) from authenticated';
  end if;
end $$;

-- 5. Configurable receipt profile -------------------------------------------
create table if not exists public.receipt_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  business_name text,
  legal_name text,
  legal_address text,
  phone text,
  tax_identifier text,
  registration_number text,
  paper_width_mm integer not null default 58 check (paper_width_mm in (58, 80)),
  show_tax_summary boolean not null default false,
  prices_include_tax boolean not null default true,
  tax_label text not null default 'TVA',
  default_tax_rate numeric(5,2) not null default 0 check (default_tax_rate between 0 and 100),
  footer_text text,
  updated_at timestamptz not null default now()
);

alter table public.receipt_settings enable row level security;
revoke all on table public.receipt_settings from anon;
grant select on table public.receipt_settings to authenticated;

drop policy if exists "merchant reads receipt settings" on public.receipt_settings;
create policy "merchant reads receipt settings"
on public.receipt_settings
for select
to authenticated
using (
  exists (
    select 1
    from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = receipt_settings.restaurant_id
  )
);

insert into public.receipt_settings (restaurant_id, business_name, legal_address)
select r.id, r.name, rc.address
from public.restaurants r
left join public.restaurant_configs rc on rc.restaurant_id = r.id
on conflict (restaurant_id) do nothing;

-- Make sure Realtime includes order changes. Idempotent.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;

commit;
