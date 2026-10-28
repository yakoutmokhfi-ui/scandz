-- =============================================================================
-- Scanym — ORDER_RECEIVED PAYMENT GATE v1 — ROLLBACK (DEVELOPMENT ONLY)
-- Restaure claim_pending_notifications À L'IDENTIQUE du lot N1-A et retire la
-- porte. Aucune donnée outbox n'est modifiée.
-- =============================================================================

begin;

create or replace function public.claim_pending_notifications(
  p_batch_size    integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  outbox_id           uuid,
  restaurant_id       uuid,
  order_id            uuid,
  notification_type   text,
  recipient_email      text,
  locale              text,
  payload_snapshot    jsonb,
  attempt_count       integer,
  claim_token         uuid,
  sender_name         text,
  sender_email        text,
  reply_to            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 10), 100));
  v_lease      integer := greatest(1, least(coalesce(p_lease_seconds, 60), 3600));
begin
  return query
  with eligible as (
    select o.id
    from public.notification_outbox o
    where o.status in ('pending', 'failed_retryable')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
    order by o.created_at, o.id
    limit v_batch_size
    for update skip locked
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
  select
    c.id, c.restaurant_id, c.order_id, c.notification_type,
    c.recipient_email, c.locale, c.payload_snapshot, c.attempt_count, c.claim_token,
    p.sender_name, p.sender_email, p.reply_to
  from claimed c
  left join public.merchant_notification_profile p on p.restaurant_id = c.restaurant_id
  order by c.id;
end $$;

comment on function public.claim_pending_notifications(integer, integer) is
  'N1-A — réclame un lot de notifications éligibles (FOR UPDATE SKIP LOCKED + bail, calqué sur claim_stuart_provider_events). Résout l''identité d''expéditeur FRAÎCHE via jointure sur le restaurant_id de la ligne outbox elle-même -- jamais un restaurant_id fourni par l''appelant -- garantit structurellement l''isolation tenant du worker. Deux workers concurrents ne peuvent jamais réclamer la même ligne (verrouillage ligne + SKIP LOCKED). Fenêtre de crash résiduelle documentée README-AUDIT.md §10 (reap_stale_notification_claims).';

revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer, integer) to service_role;

drop function public.notification_send_gate_open(uuid, text);

drop trigger if exists orders_payment_mode_final_guard_trg on public.orders;
drop function if exists public.orders_payment_mode_final_guard();
drop function if exists public.finalize_order_payment_mode_none(uuid, uuid);
alter table public.orders drop constraint if exists orders_payment_mode_final_check;
alter table public.orders drop column if exists payment_mode_final;

commit;
