-- ============================================================================
-- ISSUE #171 — COMMANDES NON PAYÉES NON OPÉRATIONNELLES AU BACK-OFFICE v1
--
-- Constat (issue #171) : une commande dont le paiement Monetico a été
-- refusé apparaissait « Nouvelle » avec Accepter/Refuser. Cause racine :
-- la lecture back-office (merchant : requête PostgREST `orders` ;
-- opérateur : get_operator_restaurant_orders_page) et la mutation
-- update_order_status ne regardaient QUE orders.status, jamais
-- orders.payment_status (machine à états paiement P1/P4-A, indépendante).
--
-- RÈGLE (commentaire CIO du 28/10/2026 sur l'issue) :
--   OPÉRATIONNEL  <=> payment_status in ('not_required', 'paid')
--   NON opérationnel : 'required', 'pending' (paiement attendu / tentative
--   en cours -- un refus Monetico `Annulation` laisse volontairement la
--   tentative pending pour permettre une nouvelle tentative) et
--   'failed', 'cancelled' (terminal négatif, conservés pour audit).
--   La garde est une LISTE NOIRE, jamais « paid uniquement » : les
--   marchands sans paiement en ligne ont des commandes légitimes
--   `not_required` et ne doivent jamais être bloqués.
--
-- CE LOT NE TOUCHE PAS : la machine à états paiement (initiate/confirm,
-- inbox Monetico), create_order, la projection « dix champs approuvés » de
-- l'opérateur (DASHBOARD PAGINATION v1 -- signature et colonnes INCHANGÉES,
-- seul le filtre change), les grants.
--
-- 1. get_operator_restaurant_orders_page : la vue OPÉRATIONNELLE
--    (p_include_completed = false) exclut désormais les commandes non
--    opérationnelles ; l'HISTORIQUE (true) continue de tout renvoyer
--    (audit). CREATE OR REPLACE à signature identique.
-- 2. update_order_status : refuse (42501, message stable
--    ORDER_PAYMENT_NOT_OPERATIONAL) toute transition sur une commande
--    dont payment_status n'est pas opérationnel. Le reste du corps v29
--    est reproduit À L'IDENTIQUE.
-- ============================================================================

-- §0 -- gardes
do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- migration annulée.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: orders.payment_status absent -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;
  if to_regprocedure('public.update_order_status(uuid,text)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_order_status(uuid,text) introuvable -- prérequis V29 manquant, migration annulée.';
  end if;
  if to_regprocedure('public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_operator_restaurant_orders_page introuvable -- prérequis DASHBOARD PAGINATION v1 manquant, migration annulée.';
  end if;
  if pg_get_functiondef(to_regprocedure('public.update_order_status(uuid,text)')) ilike '%ORDER_PAYMENT_NOT_OPERATIONAL%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: ISSUE #171 déjà appliqué (garde présente) -- double application refusée.';
  end if;
end $$;

-- §1 -- lecture opérateur : filtre opérationnel, projection INCHANGÉE
create or replace function public.get_operator_restaurant_orders_page(
  p_restaurant_id uuid,
  p_include_completed boolean default false,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  order_number bigint,
  status text,
  service_mode text,
  created_at timestamptz,
  updated_at timestamptz,
  total numeric,
  currency text,
  item_count integer,
  has_invoice_request boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;
  if p_restaurant_id is null then
    raise exception using errcode = '22004', message = 'p_restaurant_id requis';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'Both order cursor fields are required';
  end if;
  return query
  select
    o.id,
    o.order_number::bigint,
    o.status::text,
    o.service_mode::text,
    o.created_at,
    o.updated_at,
    o.total::numeric,
    o.currency::text,
    coalesce((select sum(oi.quantity) from public.order_items oi where oi.order_id = o.id), 0)::integer,
    exists (select 1 from public.order_invoice_request r where r.order_id = o.id)
  from public.orders o
  where o.restaurant_id = p_restaurant_id
    and (
      coalesce(p_include_completed, false)
      or (
        o.status not in ('completed', 'rejected', 'cancelled')
        -- ISSUE #171 : vue opérationnelle = paiement non bloquant uniquement.
        and o.payment_status in ('not_required', 'paid')
      )
    )
    and (p_before_created_at is null or (o.created_at, o.id) < (p_before_created_at, p_before_id))
  order by o.created_at desc, o.id desc
  limit 51;
end;
$$;

comment on function public.get_operator_restaurant_orders_page(uuid, boolean, timestamptz, uuid) is
  'Dashboard pagination v1 + ISSUE #171: operator-only, same ten approved fields; descending (created_at,id), strict cursor, 50 rows + lookahead. Operational view (p_include_completed=false) excludes orders whose payment_status is not in (not_required, paid); history returns everything for audit. No customer details. No writes or RLS changes.';

-- §2 -- garde serveur sur les transitions de statut
create or replace function public.update_order_status(
  p_order_id uuid,
  p_new_status text
)
returns table (
  order_id uuid,
  previous_status text,
  new_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_restaurant_id uuid;
  v_previous_status text;
  v_payment_status text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required';
  end if;

  if p_new_status is null or p_new_status not in (
    'new','accepted','preparing','ready','completed','rejected','cancelled'
  ) then
    raise exception using
      errcode = '22023',
      message = format('Invalid order status: %s', coalesce(p_new_status, 'null'));
  end if;

  select o.restaurant_id, o.status, o.payment_status
    into v_restaurant_id, v_previous_status, v_payment_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Order not found';
  end if;

  if not exists (
    select 1
    from public.restaurant_users ru
    where ru.user_id = v_user_id
      and ru.restaurant_id = v_restaurant_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Not authorized for this order';
  end if;

  -- ISSUE #171 : LISTE NOIRE -- une commande dont le paiement est attendu,
  -- en cours, refusé ou annulé n'est pas opérationnelle. `not_required`
  -- (marchands sans paiement en ligne) et `paid` passent. Toute valeur
  -- inconnue est refusée (fail-closed).
  if v_payment_status is null or v_payment_status not in ('not_required', 'paid') then
    raise exception using
      errcode = '42501',
      message = format('ORDER_PAYMENT_NOT_OPERATIONAL: payment_status=%s', coalesce(v_payment_status, 'null'));
  end if;

  if not (
       (v_previous_status = 'new'       and p_new_status in ('accepted','rejected','cancelled'))
    or (v_previous_status = 'accepted'  and p_new_status in ('preparing','cancelled'))
    or (v_previous_status = 'preparing' and p_new_status in ('ready','cancelled'))
    or (v_previous_status = 'ready'     and p_new_status = 'completed')
  ) then
    raise exception using
      errcode = '22023',
      message = format(
        'Invalid order transition: %s -> %s',
        v_previous_status,
        p_new_status
      );
  end if;

  update public.orders o
  set status = p_new_status,
      updated_at = now()
  where o.id = p_order_id;

  return query
  select p_order_id, v_previous_status, p_new_status;
end $$;

comment on function public.update_order_status(uuid, text) is
  'V29 merchant dashboard + ISSUE #171: authenticated member of the order''s restaurant only; kitchen transitions new->accepted/rejected/cancelled, accepted->preparing/cancelled, preparing->ready/cancelled, ready->completed. Refuses (42501 ORDER_PAYMENT_NOT_OPERATIONAL) any transition while orders.payment_status is not in (not_required, paid) -- deny list, never "paid only".';

-- §3 -- post-contrôles : grants et sécurité INCHANGÉS
do $$
declare
  v_page regprocedure := 'public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)'::regprocedure;
  v_upd regprocedure := 'public.update_order_status(uuid,text)'::regprocedure;
begin
  if not exists (select 1 from pg_proc where oid = v_page and prosecdef and provolatile = 's' and proconfig = array['search_path=""']) then
    raise exception 'SCANYM_POST_CHECK_FAILED: operator page security drift';
  end if;
  if not exists (select 1 from pg_proc where oid = v_upd and prosecdef and proconfig = array['search_path=""']) then
    raise exception 'SCANYM_POST_CHECK_FAILED: update_order_status security drift';
  end if;
  if has_function_privilege('anon', v_upd, 'EXECUTE') or not has_function_privilege('authenticated', v_upd, 'EXECUTE') then
    raise exception 'SCANYM_POST_CHECK_FAILED: update_order_status grants drift';
  end if;
  if has_function_privilege('anon', v_page, 'EXECUTE') or has_function_privilege('service_role', v_page, 'EXECUTE')
     or not has_function_privilege('authenticated', v_page, 'EXECUTE') then
    raise exception 'SCANYM_POST_CHECK_FAILED: operator page grants drift';
  end if;
end $$;
