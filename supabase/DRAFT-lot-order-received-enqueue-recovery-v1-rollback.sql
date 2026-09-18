-- =============================================================================
-- Scanym — P0 — ORDER-RECEIVED ENQUEUE REGRESSION RECOVERY v1 — ROLLBACK
-- DEVELOPMENT ONLY.
--
-- Annule STRICTEMENT les deux objets créés par
-- DRAFT-lot-order-received-enqueue-recovery-v1.sql, et rien d'autre.
--
-- Ne touche NI public.create_order, NI create_order_received_notification,
-- NI notification_outbox, NI aucune ligne de données : les lignes outbox
-- déjà enfilées par le déclencheur sont des ÉVÉNEMENTS RÉELS de commandes
-- réelles et sont délibérément CONSERVÉES (les supprimer recréerait la
-- perte d'événements que ce lot corrige).
--
-- Effet du rollback : les NOUVELLES commandes cessent d'enfiler leur
-- événement order_received -- c'est-à-dire un retour exact à l'état de
-- régression de la baseline d38b0fa1d57363419ee7ad8b23ea7fe4d6e7788c.
-- =============================================================================

begin;

drop trigger if exists orders_enqueue_order_received_trg on public.orders;
drop function if exists public.tg_orders_enqueue_order_received();

commit;

-- -----------------------------------------------------------------------------
-- POST-VOL du rollback.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_enqueue_order_received_trg'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: le déclencheur existe toujours après rollback.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'tg_orders_enqueue_order_received'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la fonction de déclenchement existe toujours après rollback.';
  end if;

  -- Les objets NON concernés doivent être intacts.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: public.create_order a disparu -- le rollback ne doit jamais y toucher.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_received_notification'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: create_order_received_notification a disparu -- jamais attendu.';
  end if;
end $$;
