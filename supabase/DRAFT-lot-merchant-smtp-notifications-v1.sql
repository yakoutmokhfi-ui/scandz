-- MERCHANT SMTP PROVIDER CONFIG v1
-- Per-restaurant encrypted SMTP settings and tenant-safe notification claiming.
begin;

do $$
begin
  if to_regclass('public.merchant_notification_profile') is null
     or to_regclass('public.notification_outbox') is null
     or to_regclass('public.restaurants') is null
     or to_regprocedure('public.touch_updated_at()') is null
     or to_regprocedure('public.notification_send_gate_open(uuid,text)') is null
     or to_regprocedure('public.claim_pending_notifications(integer,integer)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: email notification foundation/payment gate is missing';
  end if;
  if to_regclass('public.merchant_email_provider_config') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_email_provider_config already exists';
  end if;
  if pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure)
       not like '%notification_send_gate_open%'
     or pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure)
       not like '%merchant_notification_profile%'
     or pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure)
       not like '%for update skip locked%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: claim_pending_notifications is not the expected payment-gated N1-A function';
  end if;
end $$;

create table public.merchant_email_provider_config (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  host text not null check (host = lower(host) and host ~ '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  port integer not null check (port = 465),
  username text not null check (username ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  enabled boolean not null default false,
  secret_ciphertext text,
  secret_iv text,
  secret_auth_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_email_provider_secret_complete check (
    (secret_ciphertext is null and secret_iv is null and secret_auth_tag is null)
    or (secret_ciphertext is not null and secret_iv is not null and secret_auth_tag is not null)
  ),
  constraint merchant_email_provider_enabled_requires_secret check (not enabled or secret_ciphertext is not null)
);

comment on table public.merchant_email_provider_config is
  'Encrypted per-restaurant SMTP settings. Ciphertext is AES-256-GCM encrypted by the application; no direct merchant table access. SMTP password is never returned to the browser.';

alter table public.merchant_email_provider_config enable row level security;
revoke all on public.merchant_email_provider_config from public, anon, authenticated, service_role;
grant select, insert, update on public.merchant_email_provider_config to service_role;

create trigger merchant_email_provider_config_touch_updated_at
before update on public.merchant_email_provider_config
for each row execute function public.touch_updated_at();

-- Same signature, payment gate, sender identity, lease and locking as v1.
-- The added join excludes unconfigured tenants before a row is claimed.
create or replace function public.claim_pending_notifications(
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  outbox_id uuid,
  restaurant_id uuid,
  order_id uuid,
  notification_type text,
  recipient_email text,
  locale text,
  payload_snapshot jsonb,
  attempt_count integer,
  claim_token uuid,
  sender_name text,
  sender_email text,
  reply_to text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 10), 100));
  v_lease integer := greatest(1, least(coalesce(p_lease_seconds, 60), 3600));
begin
  return query
  with eligible as (
    select o.id
    from public.notification_outbox o
    join public.merchant_email_provider_config ep
      on ep.restaurant_id = o.restaurant_id and ep.enabled and ep.secret_ciphertext is not null
    join public.merchant_notification_profile mp
      on mp.restaurant_id = o.restaurant_id and mp.email_enabled
    where o.status in ('pending', 'failed_retryable')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
      and public.notification_send_gate_open(o.order_id, o.notification_type)
    order by o.created_at, o.id
    limit v_batch_size
    for update of o skip locked
  ),
  claimed as (
    update public.notification_outbox o
    set status = 'processing',
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => v_lease)
    from eligible
    where o.id = eligible.id
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

comment on function public.claim_pending_notifications(integer,integer) is
  'Payment-gated transactional email claim; requires an enabled per-restaurant SMTP configuration with encrypted credentials. Missing provider never claims or consumes an attempt.';
revoke all on function public.claim_pending_notifications(integer,integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer,integer) to service_role;

do $$
begin
  if has_table_privilege('anon', 'public.merchant_email_provider_config', 'SELECT')
     or has_table_privilege('authenticated', 'public.merchant_email_provider_config', 'SELECT')
     or has_table_privilege('service_role', 'public.merchant_email_provider_config', 'DELETE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: unexpected access to merchant SMTP credentials';
  end if;
  if not has_table_privilege('service_role', 'public.merchant_email_provider_config', 'SELECT')
     or not has_table_privilege('service_role', 'public.merchant_email_provider_config', 'UPDATE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: service_role lacks SMTP configuration access';
  end if;
  if has_function_privilege('authenticated', 'public.claim_pending_notifications(integer,integer)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_pending_notifications(integer,integer)', 'execute') then
    raise exception 'SCANYM_POSTCHECK_FAILED: notification claim privileges changed unexpectedly';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.merchant_email_provider_config'::regclass)
     or pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure)
       not like '%notification_send_gate_open%'
     or pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure)
       not like '%for update of o skip locked%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: SMTP vault RLS or payment/locking claim guard is missing';
  end if;
end $$;
commit;
