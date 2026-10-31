-- Roll back MERCHANT SMTP PROVIDER CONFIG v1 only when no merchant
-- configuration would be lost. Email processing returns to the prior
-- claim function; no notification attempts or tracking links are changed.
begin;
do $$
begin
  if to_regclass('public.merchant_email_provider_config') is null
     or to_regprocedure('public.claim_pending_notifications(integer,integer)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: SMTP migration is not installed';
  end if;
  if pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure)
       not like '%merchant_email_provider_config%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: claim_pending_notifications changed since SMTP migration';
  end if;
  if exists (select 1 from public.merchant_email_provider_config) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: SMTP configurations exist; export or remove them explicitly first';
  end if;
end $$;

create or replace function public.claim_pending_notifications(
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text,
  recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer,
  claim_token uuid, sender_name text, sender_email text, reply_to text
)
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 10), 100));
  v_lease integer := greatest(1, least(coalesce(p_lease_seconds, 60), 3600));
begin
  return query
  with eligible as (
    select o.id
    from public.notification_outbox o
    where o.status in ('pending', 'failed_retryable')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
      and public.notification_send_gate_open(o.order_id, o.notification_type)
    order by o.created_at, o.id
    limit v_batch_size
    for update skip locked
  ),
  claimed as (
    update public.notification_outbox o
    set status = 'processing', claim_token = gen_random_uuid(), claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => v_lease)
    from eligible where o.id = eligible.id
    returning o.id, o.restaurant_id, o.order_id, o.notification_type,
      o.recipient_email, o.locale, o.payload_snapshot, o.attempt_count, o.claim_token
  )
  select c.id, c.restaurant_id, c.order_id, c.notification_type,
    c.recipient_email, c.locale, c.payload_snapshot, c.attempt_count, c.claim_token,
    p.sender_name, p.sender_email, p.reply_to
  from claimed c
  left join public.merchant_notification_profile p on p.restaurant_id = c.restaurant_id
  order by c.id;
end $$;
revoke all on function public.claim_pending_notifications(integer,integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer,integer) to service_role;

drop table public.merchant_email_provider_config;
commit;
