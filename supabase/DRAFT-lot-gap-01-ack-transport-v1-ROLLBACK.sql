-- =============================================================================
-- Scanym — GAP-01 — ACKNOWLEDGEMENT TRANSPORT v1 — ROLLBACK.
--
-- Restaure `_scanym_has_operational_durable_ack_channel()` à son état
-- ONLINE WITHDRAWAL v1.2 (`select false;`, immutable, fail-closed en
-- dur) et retire les objets ajoutés par ce lot. N'ALTÈRE AUCUNE
-- déclaration de rétractation déjà enregistrée (withdrawal_requests/
-- withdrawal_request_items ne sont jamais tronquées ni supprimées) :
-- seules les colonnes/contraintes/fonctions/policy propres à GAP-01
-- sont retirées.
-- =============================================================================

begin;

drop policy if exists "restaurant members read own withdrawal requests" on public.withdrawal_requests;
revoke select on table public.withdrawal_requests from authenticated;

drop function if exists public.record_withdrawal_acknowledgement_result(uuid, boolean, text, text, text, text, text);
drop function if exists public.record_ack_transport_health_check(boolean, boolean, text, uuid);
drop function if exists public.claim_withdrawal_acknowledgement_send(uuid, integer);
drop type if exists public.withdrawal_ack_claim_result;

-- Cible PRÉCISÉMENT la contrainte à CINQ valeurs posée par GAP-01
-- (celle qui mentionne 'sending') -- jamais
-- withdrawal_requests_ack_sent_requires_timestamp (contrainte
-- D'ÉGALITÉ distincte, dont le texte mentionne aussi
-- `acknowledgement_status` mais n'énumère aucune valeur de
-- vocabulaire, et ne doit jamais être touchée ici).
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cls on cls.oid = con.conrelid
  join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
  where nsp.nspname = 'public' and cls.relname = 'withdrawal_requests' and con.contype = 'c'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%''sending''%';

  if v_conname is not null then
    execute pg_catalog.format('alter table public.withdrawal_requests drop constraint %I', v_conname);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint con
    join pg_catalog.pg_class cls on cls.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
    where nsp.nspname = 'public' and cls.relname = 'withdrawal_requests' and con.contype = 'c'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%''pending''%'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%''unavailable_no_channel''%'
  ) then
    alter table public.withdrawal_requests
      add constraint withdrawal_requests_acknowledgement_status_check
      check (acknowledgement_status in ('pending', 'unavailable_no_channel', 'sent', 'failed'));
  end if;
end $$;

alter table public.withdrawal_requests
  drop column if exists acknowledgement_cc,
  drop column if exists acknowledgement_message_id,
  drop column if exists acknowledgement_content_version,
  drop column if exists acknowledgement_attempted_at,
  drop column if exists acknowledgement_claimed_at,
  drop column if exists acknowledgement_send_attempts;

create or replace function public._scanym_has_operational_durable_ack_channel()
returns boolean
language sql
immutable
set search_path = ''
as $$
  select false;
$$;

comment on function public._scanym_has_operational_durable_ack_channel() is
  'ONLINE WITHDRAWAL v1.2 (restauré par rollback GAP-01 ack-transport-v1) — aucun prestataire d''envoi transactionnel n''est câblé ni autorisé. Fail-closed explicite, littéral.';

revoke all on function public._scanym_has_operational_durable_ack_channel() from public;

drop table if exists public.scanym_ack_transport_health;

do $$
begin
  if public._scanym_has_operational_durable_ack_channel() then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la garde reste vraie après rollback.';
  end if;
  if to_regclass('public.scanym_ack_transport_health') is not null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: scanym_ack_transport_health existe encore.';
  end if;
end $$;

commit;
