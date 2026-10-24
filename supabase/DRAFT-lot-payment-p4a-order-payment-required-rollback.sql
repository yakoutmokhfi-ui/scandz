-- ============================================================
-- Scanym — PAYMENT P4-A / ORDER PAYMENT REQUIRED — ROLLBACK
-- (DRAFT — à n'exécuter que sur décision explicite.)
--
-- Retire require_order_payment et restaure la CHECK P1 à cinq valeurs.
-- Refuse (fail-closed) s'il reste une commande en `required` : il
-- faut d'abord la ramener à `not_required` (décision humaine, jamais
-- automatique ici) -- sinon la contrainte restaurée serait violée.
-- ============================================================

begin;

do $$
begin
  if exists (select 1 from public.orders where payment_status = 'required') then
    raise exception 'SCANYM_ROLLBACK_REFUSED: des commandes sont encore en payment_status=required -- rollback annulé.';
  end if;
end $$;

drop function if exists public.require_order_payment(uuid, uuid, text);

alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('not_required','pending','paid','failed','cancelled'));

comment on column public.orders.payment_status is
  'Machine à états du PAIEMENT, INDÉPENDANTE de orders.status (cycle cuisine). not_required = aucun paiement en ligne concerné (défaut, comportement historique). pending/paid/failed/cancelled = reflète EXCLUSIVEMENT la tentative pointée par current_payment_transaction_id -- jamais mis à jour par une tentative non courante (voir confirm_payment_attempt). Remboursement explicitement hors périmètre P1 (aucune valeur refunded ici -- lot dédié futur).';

commit;
