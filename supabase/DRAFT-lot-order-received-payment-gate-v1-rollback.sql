-- =============================================================================
-- Scanym — ORDER_RECEIVED PAYMENT GATE v1 — ROLLBACK (DEVELOPMENT ONLY)
-- Restaure claim_pending_notifications À L'IDENTIQUE du lot N1-A et retire la
-- porte. Aucune donnée outbox n'est modifiée.
--
-- PRÉREQUIS (hors SQL, à confirmer AVANT exécution) :
--   * les workers de notification sont ARRÊTÉS : sans porte, un worker réclame
--     et enverrait n'importe quel order_received (paiement non confirmé inclus) ;
--   * stratégie explicite pour les décisions perdues : le retour arrière
--     supprime la colonne orders.payment_mode_final (décisions « sans paiement
--     en ligne » comprises). Le nombre de décisions concernées est signalé en
--     NOTICE (SCANYM_ROLLBACK_NOTICE) ; aucune n'est restaurable ensuite.
--
-- PRÉ-VOL (T180-02) : le rollback ne remplace le claim QUE s'il est encore tel
-- que ce lot l'a posé (empreinte exacte du corps + TOUS les attributs de pg_proc,
-- STRICT compris + ensemble COMPLET des droits EXECUTE = {propriétaire,
-- service_role}, sans option de transmission ; mêmes règles que le lot). Une
-- variante introduite depuis lors n'est jamais écrasée à l'aveugle :
-- SCANYM_PREDECESSOR_DRIFT, transaction annulée, rien modifié.
-- =============================================================================

begin;

do $$
declare
  c_gated_body_md5 constant text := '16d75b38372fd5dfd0ca1a4e20dfa3a8';
  c_expected_args  constant text := 'p_batch_size integer DEFAULT 10, p_lease_seconds integer DEFAULT 60';
  c_expected_result constant text := 'TABLE(outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text, recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer, claim_token uuid, sender_name text, sender_email text, reply_to text)';
  -- Attributs de pg_proc que CREATE OR REPLACE réécrit (explicitement ou par valeur
  -- par défaut) : un écart est une variante opérationnelle inconnue, jamais normalisée.
  c_expected_attrs constant text := 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=t;cost=100;rows=1000;support=0;variadic=0;nargs=2;ndefaults=2;config=search_path=""';
  v_oid      oid;
  v_owner    oid;
  v_args     text;
  v_result   text;
  v_md5      text;
  v_attrs    text;
  v_acl      text[];
  v_expected_acl text[];
  v_lost   bigint;
begin
  if to_regprocedure('public.notification_send_gate_open(uuid, text)') is null then
    raise exception 'SCANYM_ROLLBACK_PREFLIGHT_FAILED: notification_send_gate_open est absente -- lot non appliqué ou déjà annulé. Rollback annulé, rien modifié.';
  end if;

  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_pending_notifications'
  ) <> 1 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: claim_pending_notifications doit exister en UNE seule surcharge. Rollback annulé, rien modifié.';
  end if;

  select p.oid,
         p.proowner,
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         md5(replace(p.prosrc, E'\r', '')),
         format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s',
                p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')),
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
    into v_oid, v_owner, v_args, v_result, v_md5, v_attrs, v_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'claim_pending_notifications';

  if v_md5 is distinct from c_gated_body_md5 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: claim_pending_notifications (md5 %) n''est plus celle posée par ce lot (md5 %) -- modifiée depuis. Rollback annulé, rien modifié.', v_md5, c_gated_body_md5;
  end if;

  if v_attrs is distinct from c_expected_attrs
     or v_args is distinct from c_expected_args
     or v_result is distinct from c_expected_result then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: attributs de claim_pending_notifications différents de ceux posés par ce lot (SECURITY DEFINER, STRICT, volatilité, LEAKPROOF, PARALLEL, COST/ROWS, langage, search_path, arguments, colonnes retournées). Observé : % ; attendu : %.', v_attrs, c_expected_attrs;
  end if;

  -- Droits (politique explicite) : l'ENSEMBLE COMPLET des bénéficiaires EXECUTE doit
  -- être exactement {propriétaire, service_role}, accordé par le propriétaire, sans
  -- option de transmission, sans PUBLIC ni aucun autre rôle (anon, authenticated ou
  -- tout rôle supplémentaire). Le propriétaire doit être le rôle qui applique ce
  -- script. Aucun droit inconnu n'est révoqué ni accordé silencieusement : refus.
  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
     or v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits d''exécution de claim_pending_notifications différents de ceux posés par ce lot (propriétaire = rôle appliquant le script ET service_role, rien d''autre, sans option de transmission). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié ni révoqué silencieusement.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_mode_final'
  ) then
    execute 'select count(*) from public.orders where payment_mode_final is not null' into v_lost;
    raise notice 'SCANYM_ROLLBACK_NOTICE: % décision(s) payment_mode_final seront définitivement perdues par ce retour arrière.', v_lost;
  end if;
end $$;

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
