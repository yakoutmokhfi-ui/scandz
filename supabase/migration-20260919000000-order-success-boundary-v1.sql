-- =============================================================================
-- Scanym — ORDER SUCCESS BOUNDARY v1
-- Migration identity: 20260919000000_order_success_boundary_v1
-- Forward-only candidate; never applied by this file to Production.
--
-- Invariant:
--   a successfully created order is authoritative business state;
--   notification enqueue and delivery are recoverable side effects.
--
-- The durable intent is stored on the order row itself.  A successful order
-- insert therefore cannot exist without its intent marker, while failure of
-- notification_outbox (or its enqueue helper) can no longer abort the order.
-- Existing orders are deliberately left NULL: this migration does not invent
-- historical notification intent or perform a backfill.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Fail closed on an unexpected predecessor state.
-- -----------------------------------------------------------------------------
do $$
declare
  v_create_order_definition text;
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders' and c.relkind = 'r'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders is missing.';
  end if;

  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and a.attname = 'order_received_notification_intent_at'
      and not a.attisdropped
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: order_received_notification_intent_at already exists.';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_order_received_notification'
      and pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification(uuid, uuid) is missing.';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_enqueue_order_received_trg'
      and not t.tgisinternal
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: predecessor trigger orders_enqueue_order_received_trg is missing.';
  end if;

  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
      and con.contype = 'u'
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(con.conkey) k
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
      ) = array['notification_type','order_id','restaurant_id']::name[]
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: notification outbox logical uniqueness is missing.';
  end if;

  select string_agg(pg_get_functiondef(p.oid), E'\n') into v_create_order_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';

  if v_create_order_definition is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.create_order is missing.';
  end if;

  -- A direct helper call inside create_order would still be able to propagate
  -- before the safe trigger runs. Refuse that predecessor rather than claim a
  -- success-boundary guarantee that is not true.
  if v_create_order_definition like '%create_order_received_notification%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order still directly invokes notification enqueue.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Durable intent: part of the authoritative order row, not the outbox.
-- -----------------------------------------------------------------------------
alter table public.orders
  add column order_received_notification_intent_at timestamptz;

comment on column public.orders.order_received_notification_intent_at is
  'ORDER SUCCESS BOUNDARY v1 — durable order_received notification intent. Set on every new order in the same row write. NULL is reserved for orders predating this forward migration; no historical intent is inferred.';

create function public.tg_orders_record_order_received_intent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Never trust or preserve a caller-supplied timestamp.  The database stamps
  -- the intent as part of the order row before it is inserted.
  new.order_received_notification_intent_at := transaction_timestamp();
  return new;
end $$;

comment on function public.tg_orders_record_order_received_intent() is
  'ORDER SUCCESS BOUNDARY v1 — stamps durable notification intent into each new order row. SECURITY INVOKER; trigger-only; no external I/O.';

revoke all on function public.tg_orders_record_order_received_intent()
  from public, anon, authenticated, service_role;

create trigger orders_record_order_received_intent_trg
before insert on public.orders
for each row
execute function public.tg_orders_record_order_received_intent();

-- -----------------------------------------------------------------------------
-- 2. Remove the synchronous enqueue path from the order transaction.
--
--    Catching WHEN OTHERS would still exclude PostgreSQL query_canceled and
--    assert_failure.  No exception handler can make a synchronous side effect
--    an absolute post-commit boundary.  The predecessor constraint trigger is
--    therefore removed forward-only.  The durable order-row intent created
--    above is the sole in-transaction notification artifact; section 3 turns
--    it into an outbox row only from a later, independent transaction.
-- -----------------------------------------------------------------------------
drop trigger orders_enqueue_order_received_trg on public.orders;
drop function public.tg_orders_enqueue_order_received();

-- -----------------------------------------------------------------------------
-- 3. Tenant-scoped recovery. Row locks serialize concurrent recovery and the
--    pre-existing unique constraint is the second idempotency barrier.
-- -----------------------------------------------------------------------------
create function public.recover_missing_order_received_notifications(
  p_restaurant_id uuid,
  p_batch_size integer default 100
)
returns table (
  recovered_order_id uuid,
  recovery_outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 100), 500));
  v_order record;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_NOTIFICATION_RECOVERY_RESTAURANT_REQUIRED'
      using errcode = '22004';
  end if;

  for v_order in
    select o.id
    from public.orders o
    where o.restaurant_id = p_restaurant_id
      and o.order_received_notification_intent_at is not null
      and not exists (
        select 1
        from public.notification_outbox n
        where n.restaurant_id = o.restaurant_id
          and n.order_id = o.id
          and n.notification_type = 'order_received'
      )
    order by o.order_received_notification_intent_at, o.id
    limit v_batch_size
    for update of o skip locked
  loop
    begin
      perform public.create_order_received_notification(v_order.id, p_restaurant_id);

      if exists (
        select 1
        from public.notification_outbox n
        where n.restaurant_id = p_restaurant_id
          and n.order_id = v_order.id
          and n.notification_type = 'order_received'
      ) then
        recovered_order_id := v_order.id;
        recovery_outcome := 'recovered';
      else
        -- Defensive only: the current helper always inserts or finds the
        -- unique logical row. Keep an explicit closed outcome if that contract
        -- changes in a future migration.
        recovered_order_id := v_order.id;
        recovery_outcome := 'still_missing';
      end if;
    exception
      when others then
        -- Continue the bounded batch without exposing raw diagnostics. The
        -- intent remains missing and will be eligible on the next retry.
        recovered_order_id := v_order.id;
        recovery_outcome := 'retry_required';
    end;
    return next;
  end loop;
end $$;

comment on function public.recover_missing_order_received_notifications(uuid, integer) is
  'ORDER SUCCESS BOUNDARY v1 — service-role-only, tenant-scoped, bounded and concurrency-safe recovery of durable order_received intents lacking an outbox row. Outcomes never expose raw SQL/provider errors.';

revoke all on function public.recover_missing_order_received_notifications(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.recover_missing_order_received_notifications(uuid, integer)
  to service_role;

create function public.count_missing_order_received_notifications(
  p_restaurant_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)
  from public.orders o
  where o.restaurant_id = p_restaurant_id
    and o.order_received_notification_intent_at is not null
    and not exists (
      select 1
      from public.notification_outbox n
      where n.restaurant_id = o.restaurant_id
        and n.order_id = o.id
        and n.notification_type = 'order_received'
    )
$$;

comment on function public.count_missing_order_received_notifications(uuid) is
  'ORDER SUCCESS BOUNDARY v1 — service-role-only tenant-scoped observability count. Returns no customer fields.';

revoke all on function public.count_missing_order_received_notifications(uuid)
  from public, anon, authenticated;
grant execute on function public.count_missing_order_received_notifications(uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 4. Postconditions. No data backfill is performed.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_record_order_received_intent_trg'
      and not t.tgisinternal
      and (t.tgtype & 1) <> 0
      and (t.tgtype & 2) <> 0
      and (t.tgtype & 4) <> 0
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: durable intent trigger shape is invalid.';
  end if;

  if exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_enqueue_order_received_trg'
      and not t.tgisinternal
  ) or to_regprocedure('public.tg_orders_enqueue_order_received()') is not null then
    raise exception 'SCANYM_POSTCHECK_FAILED: synchronous notification enqueue path still exists.';
  end if;

  if has_function_privilege('anon', 'public.recover_missing_order_received_notifications(uuid,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.recover_missing_order_received_notifications(uuid,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.recover_missing_order_received_notifications(uuid,integer)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: recovery RPC ACL is invalid.';
  end if;

  if has_function_privilege('anon', 'public.count_missing_order_received_notifications(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.count_missing_order_received_notifications(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.count_missing_order_received_notifications(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: observability RPC ACL is invalid.';
  end if;
end $$;

commit;
