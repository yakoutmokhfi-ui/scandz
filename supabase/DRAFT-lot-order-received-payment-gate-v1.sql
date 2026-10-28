-- =============================================================================
-- Scanym — ORDER_RECEIVED PAYMENT GATE v1 (issue #172, complément)
-- DEVELOPMENT ONLY — candidat additif ; JAMAIS appliqué par ce fichier à la
-- Production ni à une base hébergée sans GO distinct.
--
-- Décision métier (Yakout, 28/10/2026) :
--   * paiement en ligne : l'e-mail de confirmation ne part que lorsque
--     orders.payment_status = 'paid' ;
--   * parcours sans paiement en ligne (payment_status = 'not_required') : un
--     délai de grâce de 5 minutes après la création de la commande, pour que
--     le client ait le temps de basculer vers le paiement en ligne (la
--     bascule not_required -> required se fait APRÈS la création, voir
--     DRAFT-lot-payment-p4a-order-payment-required.sql).
--   * 'required', 'pending', 'failed', 'cancelled' : jamais d'envoi. La ligne
--     outbox reste 'pending' (aucune tentative consommée) ; si le client
--     repaie plus tard et que le statut devient 'paid', l'e-mail part alors.
--
-- Pourquoi ici et pas dans le worker TypeScript : le barème de reprise
-- (30/120/600/1800 s, 5 tentatives) s'épuise en ~42 minutes, moins que la
-- fenêtre de saisie carte Monetico (45 minutes). Différer côté worker par
-- « retryable_failure » pourrait donc perdre définitivement l'e-mail.
--
-- Forme : la porte est une fonction à part (notification_send_gate_open) ;
-- claim_pending_notifications n'y ajoute qu'UN prédicat. Son corps est repris
-- À L'IDENTIQUE du lot N1-A (seule définition de la fonction dans le dépôt) :
-- le piège documenté par DRAFT-lot-order-received-enqueue-recovery-v1.sql
-- (une redéfinition qui perd silencieusement du comportement) est couvert par
-- tests/v172-order-received-payment-gate.test.ts, qui exécute le SQL réel.
--
-- Hors périmètre : ne crée AUCUN e-mail, ne touche ni create_order, ni
-- complete_notification_attempt, ni le gabarit, ni la politique de
-- rétractation. Aucun backfill.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. PRÉ-VOL — échec fermé sur un état prédécesseur inattendu.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.payment_status est introuvable -- le lot PAYMENT P1 doit être appliqué avant. Annulé.';
  end if;

  if to_regclass('public.notification_outbox') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.notification_outbox est introuvable -- le lot N1-A doit être appliqué avant. Annulé.';
  end if;

  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_pending_notifications'
  ) <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: claim_pending_notifications doit exister en UNE seule surcharge. Annulé.';
  end if;

  if to_regprocedure('public.notification_send_gate_open(uuid, text)') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: notification_send_gate_open existe déjà -- lot déjà appliqué (double application refusée).';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Porte d'envoi.
--    Seul 'order_received' est concerné : les autres types (placeholders
--    N1-A, événements de communication) gardent EXACTEMENT leur comportement.
--    Commande introuvable -> porte fermée (jamais d'envoi sans commande).
-- -----------------------------------------------------------------------------
create function public.notification_send_gate_open(
  p_order_id          uuid,
  p_notification_type text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payment_status text;
  v_created_at     timestamptz;
begin
  if p_notification_type is distinct from 'order_received' then
    return true;
  end if;

  select o.payment_status, o.created_at
    into v_payment_status, v_created_at
  from public.orders o
  where o.id = p_order_id;

  if not found then
    return false;
  end if;

  return case v_payment_status
    when 'paid' then true
    -- Délai de grâce : 5 minutes après la création de la commande.
    when 'not_required' then now() >= v_created_at + interval '5 minutes'
    else false
  end;
end $$;

comment on function public.notification_send_gate_open(uuid, text) is
  'ORDER_RECEIVED PAYMENT GATE v1 -- ordre de lecture : order_received uniquement. paid -> ouvert ; not_required -> ouvert 5 minutes après orders.created_at ; required/pending/failed/cancelled -> fermé. Autres types : toujours ouvert. Lecture seule, aucune écriture.';

revoke all on function public.notification_send_gate_open(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. claim_pending_notifications — corps du lot N1-A + UN prédicat.
--    Signature, colonnes retournées, verrouillage, bail et droits INCHANGÉS.
-- -----------------------------------------------------------------------------
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
      -- ORDER_RECEIVED PAYMENT GATE v1 : seul ajout par rapport à N1-A.
      and public.notification_send_gate_open(o.order_id, o.notification_type)
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
  'N1-A + ORDER_RECEIVED PAYMENT GATE v1 — réclame un lot de notifications éligibles (FOR UPDATE SKIP LOCKED + bail). Résout l''identité d''expéditeur FRAÎCHE via jointure sur le restaurant_id de la ligne outbox elle-même. ORDER_RECEIVED n''est éligible que si notification_send_gate_open() est vraie (paid, ou not_required après 5 minutes). Deux workers concurrents ne peuvent jamais réclamer la même ligne.';

revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 3. POST-VOL.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.notification_send_gate_open(uuid, text)') is null then
    raise exception 'SCANYM_POSTCHECK_FAILED: notification_send_gate_open est absente.';
  end if;

  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_pending_notifications'
  ) <> 1 then
    raise exception 'SCANYM_POSTCHECK_FAILED: claim_pending_notifications doit rester en UNE surcharge.';
  end if;

  if position('notification_send_gate_open' in pg_get_functiondef('public.claim_pending_notifications(integer, integer)'::regprocedure)) = 0 then
    raise exception 'SCANYM_POSTCHECK_FAILED: claim_pending_notifications ne consulte pas la porte.';
  end if;

  if has_function_privilege('anon', 'public.claim_pending_notifications(integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_pending_notifications(integer, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_pending_notifications(integer, integer)', 'execute') then
    raise exception 'SCANYM_POSTCHECK_FAILED: droits d''exécution de claim_pending_notifications altérés.';
  end if;
end $$;

commit;
