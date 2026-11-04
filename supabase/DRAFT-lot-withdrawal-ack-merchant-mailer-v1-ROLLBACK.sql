-- =============================================================================
-- Scanym — ACCUSÉ DE RÉTRACTATION PAR LA MESSAGERIE DU COMMERÇANT (v1) — ROLLBACK
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO.
--
-- Retire exactement les objets de DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql.
-- Ne touche à AUCUNE demande de rétractation (aucune ligne supprimée ou modifiée) ni à
-- GAP-01. Précautions :
--   * refuse si l'interrupteur est OUVERT (le fermer d'abord) ;
--   * refuse si des accusés portent déjà une preuve de ce lot (expéditeur / canal) :
--     supprimer les colonnes détruirait une preuve d'audit -- décision explicite requise.
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.scanym_ack_merchant_mailer_activation') is null then
    raise exception 'SCANYM_ROLLBACK_NOT_APPLICABLE: le lot n''est pas appliqué.';
  end if;
  if (select enabled from public.scanym_ack_merchant_mailer_activation where id = 1) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: l''interrupteur est OUVERT -- le fermer avant le retour arrière.';
  end if;
  if exists (
    select 1 from public.withdrawal_requests
    where acknowledgement_sender is not null or acknowledgement_transport is not null
  ) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: des accusés portent une preuve (expéditeur / canal) ; les colonnes ne sont pas supprimées sans décision explicite.';
  end if;
end $$;

drop trigger if exists trg_withdrawal_ack_pending_merchant_mailer on public.withdrawal_requests;
drop function if exists public._scanym_ack_pending_when_merchant_mailer_ready();
drop function if exists public.record_withdrawal_acknowledgement_result_v2(uuid, boolean, text, text, text, text, text, text, text);
drop function if exists public.claim_withdrawal_acknowledgement_send_v2(uuid, integer);
drop function if exists public._scanym_merchant_ack_channel_ready(uuid);
drop function if exists public.scanym_ack_merchant_mailer_enabled();

alter table public.withdrawal_requests drop constraint if exists withdrawal_requests_ack_transport_check;
alter table public.withdrawal_requests
  drop column if exists acknowledgement_sender,
  drop column if exists acknowledgement_transport;

drop table if exists public.scanym_ack_merchant_mailer_activation;

do $$
begin
  if to_regclass('public.scanym_ack_merchant_mailer_activation') is not null
     or to_regprocedure('public.claim_withdrawal_acknowledgement_send_v2(uuid,integer)') is not null
     or exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer') then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: un objet du lot subsiste.';
  end if;
  -- GAP-01 intact.
  if to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is null
     or to_regprocedure('public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)') is null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: les fonctions GAP-01 ne sont plus présentes.';
  end if;
end $$;

commit;
