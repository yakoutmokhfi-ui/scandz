-- Forward migration: activate bounded recovery only for NEW intents.
-- The installation timestamp is deliberately persistent. It is not reset on
-- worker restart or merchant settings changes; historic orders are excluded.
begin;

do $$
begin
  if to_regclass('public.order_email_recovery_boundary') is not null
     or to_regclass('public.order_email_recovery_failures') is not null
     or to_regprocedure('public.recover_new_order_received_notifications(integer)') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: recovery worker already installed';
  end if;
  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: notification helper missing';
  end if;
end $$;

create table public.order_email_recovery_boundary (
  singleton boolean primary key default true check (singleton),
  starts_at timestamptz not null
);
alter table public.order_email_recovery_boundary enable row level security;
revoke all on public.order_email_recovery_boundary from public, anon, authenticated, service_role;
insert into public.order_email_recovery_boundary (singleton, starts_at) values (true, clock_timestamp());

-- A broken intent must not block subsequent orders forever. No customer data
-- or SQL error text is retained; each failed order is retried after 5 minutes.
create table public.order_email_recovery_failures (
  order_id uuid primary key references public.orders(id) on delete cascade,
  retry_after timestamptz not null
);
alter table public.order_email_recovery_failures enable row level security;
revoke all on public.order_email_recovery_failures from public, anon, authenticated, service_role;

create function public.recover_new_order_received_notifications(p_batch_size integer default 25)
returns table(recovered integer, failed integer)
language plpgsql security definer set search_path = ''
as $$
declare
  item record;
  start_time timestamptz;
begin
  select starts_at into strict start_time from public.order_email_recovery_boundary where singleton;
  recovered := 0;
  failed := 0;
  for item in
    select o.id, o.restaurant_id
    from public.orders o
    join public.merchant_notification_profile p on p.restaurant_id = o.restaurant_id and p.email_enabled
    join public.merchant_email_provider_config c on c.restaurant_id = o.restaurant_id and c.enabled and c.secret_ciphertext is not null
    where o.order_received_notification_intent_at >= start_time
      and o.customer_email is not null and o.customer_email <> ''
      and (o.payment_status = 'paid' or (o.payment_status = 'not_required' and o.payment_mode_final = 'none'))
      and not exists (select 1 from public.notification_outbox n
        where n.order_id = o.id and n.restaurant_id = o.restaurant_id and n.notification_type = 'order_received')
      and not exists (select 1 from public.order_email_recovery_failures f
        where f.order_id = o.id and f.retry_after > clock_timestamp())
    order by o.order_received_notification_intent_at, o.id
    limit greatest(1, least(coalesce(p_batch_size, 25), 100))
    for update of o skip locked
  loop
    begin
      perform public.create_order_received_notification(item.id, item.restaurant_id);
      delete from public.order_email_recovery_failures where order_id = item.id;
      recovered := recovered + 1;
    exception when others then
      insert into public.order_email_recovery_failures (order_id, retry_after)
      values (item.id, clock_timestamp() + interval '5 minutes')
      on conflict (order_id) do update set retry_after = excluded.retry_after;
      failed := failed + 1;
    end;
  end loop;
  return next;
end $$;
revoke all on function public.recover_new_order_received_notifications(integer) from public, anon, authenticated;
grant execute on function public.recover_new_order_received_notifications(integer) to service_role;
commit;
