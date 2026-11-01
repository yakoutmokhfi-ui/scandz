-- Forward migration: activate bounded recovery only for NEW intents.
-- The installation timestamp is deliberately persistent. It is not reset on
-- worker restart or merchant settings changes; historic orders are excluded.
begin;

do $$
begin
  if to_regclass('public.order_email_recovery_boundary') is not null
     or to_regclass('public.order_email_recovery_failures') is not null
     or to_regclass('public.order_email_activation_epoch') is not null
     or to_regprocedure('public.capture_order_email_activation_epoch()') is not null
     or to_regprocedure('public.claim_new_order_notifications(integer,integer)') is not null
     or to_regprocedure('public.recover_new_order_received_notifications(integer)') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: recovery worker already installed';
  end if;
  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: notification helper missing';
  end if;
  if to_regprocedure('public.notification_send_gate_open(uuid,text)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: payment gate missing';
  end if;
  -- Resolve all columns used by the recovery before creating any objects.
  perform o.id, o.restaurant_id, o.order_received_notification_intent_at,
    o.customer_email, o.payment_status, o.payment_mode_final from public.orders o limit 0;
  perform p.restaurant_id, p.email_enabled, p.sender_name, p.sender_email, p.reply_to from public.merchant_notification_profile p limit 0;
  perform c.restaurant_id, c.enabled, c.secret_ciphertext from public.merchant_email_provider_config c limit 0;
  perform n.id, n.order_id, n.restaurant_id, n.notification_type, n.status, n.created_at,
    n.next_attempt_at, n.claimed_at, n.claim_token, n.claim_expires_at,
    n.recipient_email, n.locale, n.payload_snapshot, n.attempt_count from public.notification_outbox n limit 0;
end $$;

create table public.order_email_recovery_boundary (
  singleton boolean primary key default true check (singleton),
  starts_at timestamptz not null
);
alter table public.order_email_recovery_boundary enable row level security;
revoke all on public.order_email_recovery_boundary from public, anon, authenticated, service_role;
insert into public.order_email_recovery_boundary (singleton, starts_at) values (true, clock_timestamp());

-- Initial baseline for currently enabled merchants is the installation time.
-- Each later off->on transition advances that merchant's independent baseline.
create table public.order_email_activation_epoch (
  restaurant_id uuid primary key,
  starts_at timestamptz not null
);
alter table public.order_email_activation_epoch enable row level security;
revoke all on public.order_email_activation_epoch from public, anon, authenticated, service_role;
insert into public.order_email_activation_epoch
select restaurant_id, (select starts_at from public.order_email_recovery_boundary where singleton)
from public.merchant_notification_profile where email_enabled;

create function public.capture_order_email_activation_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.email_enabled then
      insert into public.order_email_activation_epoch values (new.restaurant_id, clock_timestamp())
      on conflict (restaurant_id) do update set starts_at = excluded.starts_at;
    end if;
  elsif new.email_enabled and not old.email_enabled then
    insert into public.order_email_activation_epoch values (new.restaurant_id, clock_timestamp())
    on conflict (restaurant_id) do update set starts_at = excluded.starts_at;
  elsif not new.email_enabled and old.email_enabled then
    delete from public.order_email_activation_epoch where restaurant_id = new.restaurant_id;
  end if;
  return new;
end $$;
revoke all on function public.capture_order_email_activation_epoch() from public, anon, authenticated, service_role;
create trigger order_email_activation_epoch_trg after insert or update of email_enabled
on public.merchant_notification_profile for each row execute function public.capture_order_email_activation_epoch();

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
    join public.order_email_activation_epoch e on e.restaurant_id = o.restaurant_id
    where o.order_received_notification_intent_at >= start_time
      and o.order_received_notification_intent_at >= e.starts_at
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

-- Claim filtering is applied inside the same SQL statement as the row lock;
-- previously queued old confirmations stay untouched and cannot be sent.
-- Other notification types retain their existing eligibility rules.
create function public.claim_new_order_notifications(p_batch_size integer default 10, p_lease_seconds integer default 60)
returns table(outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text,
  recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer, claim_token uuid,
  sender_name text, sender_email text, reply_to text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with eligible as (
    select n.id from public.notification_outbox n
    join public.merchant_email_provider_config ep on ep.restaurant_id=n.restaurant_id and ep.enabled and ep.secret_ciphertext is not null
    join public.merchant_notification_profile mp on mp.restaurant_id=n.restaurant_id and mp.email_enabled
    where n.status in ('pending','failed_retryable')
      and (n.next_attempt_at is null or n.next_attempt_at <= now())
      and public.notification_send_gate_open(n.order_id,n.notification_type)
      and (n.notification_type <> 'order_received' or exists (
        select 1 from public.orders ord
        join public.order_email_activation_epoch epoch on epoch.restaurant_id=ord.restaurant_id
        join public.order_email_recovery_boundary boundary on boundary.singleton
        where ord.id=n.order_id and ord.restaurant_id=n.restaurant_id
          and ord.order_received_notification_intent_at >= epoch.starts_at
          and ord.order_received_notification_intent_at >= boundary.starts_at
          and n.created_at >= boundary.starts_at
      ))
    order by n.created_at,n.id
    limit greatest(1,least(coalesce(p_batch_size,10),100))
    for update of n skip locked
  ), claimed as (
    update public.notification_outbox n set status='processing', claim_token=gen_random_uuid(),
      claimed_at=now(), claim_expires_at=now()+make_interval(secs => greatest(1,least(coalesce(p_lease_seconds,60),3600)))
    from eligible where n.id=eligible.id
    returning n.id,n.restaurant_id,n.order_id,n.notification_type,n.recipient_email,n.locale,n.payload_snapshot,n.attempt_count,n.claim_token
  )
  select c.id,c.restaurant_id,c.order_id,c.notification_type,c.recipient_email,c.locale,c.payload_snapshot,c.attempt_count,c.claim_token,
    mp.sender_name,mp.sender_email,mp.reply_to from claimed c
  left join public.merchant_notification_profile mp on mp.restaurant_id=c.restaurant_id order by c.id;
end $$;
revoke all on function public.claim_new_order_notifications(integer,integer) from public, anon, authenticated;
grant execute on function public.claim_new_order_notifications(integer,integer) to service_role;
commit;
