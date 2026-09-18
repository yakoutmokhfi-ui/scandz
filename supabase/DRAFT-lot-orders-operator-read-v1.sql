-- ============================================================
-- Scanym — ORDERS OPERATOR READ v1
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO (GO MEP), jamais directement sur Production par
-- ce lot.
--
-- Baseline requis : 051893071fee337340af600cab7c01ffed8b8f7a (main).
--
-- CONTEXTE : Operator Dashboard Context v1.x résout correctement le
-- restaurant ciblé côté client pour un opérateur Scanym (`?r=<id>`
-- honoré seulement si is_scanym_operator()). Mais app/dashboard/page.tsx
-- lisait ensuite les commandes par un SELECT direct sur public.orders,
-- soumis à la policy RLS marchande `is_member_of(restaurant_id)` : un
-- opérateur sans ligne restaurant_users obtenait donc 0 ligne
-- ("Aucune commande à afficher") alors que les commandes existent.
--
-- OBJECTIF (strictement le mandat) : une lecture OPÉRATEUR, MINIMALE,
-- en LECTURE SEULE, de la liste des commandes d'un restaurant ciblé.
--
-- PÉRIMÈTRE STRICT :
--   + public.get_operator_restaurant_orders(uuid, boolean) -- NOUVELLE
--     RPC SECURITY DEFINER, autorisée UNIQUEMENT par
--     public.is_scanym_operator() (primitif déjà audité/publié,
--     migration-lotd-establishment-creation.sql). Aucune ligne
--     restaurant_users factice, aucun repli sur is_member_of.
--   Aucune table créée (décision CIO cycle 4 : pas de journal
--   fonctionnel de lecture opérateur dans ce lot).
--
-- COLONNES RETOURNÉES (liste FIGÉE, approuvée par le mandat) :
--   id, order_number, status, service_mode, created_at, updated_at,
--   total, currency, item_count, has_invoice_request.
--   JAMAIS : customer_name, customer_phone, customer_email,
--   delivery_address, delivery_zone, customer_note, public_token,
--   table_number, lignes de commande, contenu de la demande de facture.
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT :
--   - AUCUNE policy RLS de public.orders / order_items /
--     order_invoice_request modifiée : la lecture marchande
--     (getDashboardOrders, SELECT direct + RLS is_member_of) reste
--     STRICTEMENT inchangée.
--   - AUCUNE capacité d'écriture sur les commandes (update_order_status
--     non touchée, aucun nouveau chemin de mutation).
--   - AUCUNE modification de is_scanym_operator(), is_member_of(),
--     scanym_operators.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE (lecture seule, avant toute
--    transaction -- si ce bloc échoue, rien n'a été touché).
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable -- ORDERS OPERATOR READ v1 annulé, aucune modification appliquée.';
  end if;

  if to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
     or to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: orders / order_items / order_invoice_request introuvable -- ORDERS OPERATOR READ v1 annulé.';
  end if;

  if (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','restaurant_id','order_number','status','service_mode',
                          'created_at','updated_at','total','currency')
  ) <> 9 then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues de public.orders absentes -- ORDERS OPERATOR READ v1 annulé.';
  end if;

  -- Garde anti-double-application.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_operator_restaurant_orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_operator_restaurant_orders existe déjà -- ORDERS OPERATOR READ v1 déjà appliqué ou conflit, annulé.';
  end if;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. RPC opérateur de lecture minimale.
--
--    STABLE : la fonction n'écrit rien.
--    Même filtre et même plafond que la lecture marchande
--    (lib/services/dashboard.ts getDashboardOrders) : actives seulement
--    (hors completed/rejected/cancelled) plafonnées à 50, ou historique
--    complet plafonné à 100, triées par created_at décroissant.
--    item_count = somme des quantités des lignes de commande.
-- ------------------------------------------------------------------
create function public.get_operator_restaurant_orders(
  p_restaurant_id     uuid,
  p_include_completed boolean default false
)
returns table (
  id                  uuid,
  order_number        bigint,
  status              text,
  service_mode        text,
  created_at          timestamptz,
  updated_at          timestamptz,
  total               numeric,
  currency            text,
  item_count          integer,
  has_invoice_request boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_include_completed boolean := coalesce(p_include_completed, false);
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using errcode = '22004', message = 'p_restaurant_id requis';
  end if;

  -- Autorité opérateur EXPLICITE uniquement. Un membre du restaurant
  -- (owner/manager/staff) qui n'est pas opérateur Scanym est refusé ici :
  -- il conserve sa propre lecture marchande (RLS is_member_of),
  -- inchangée. Aucun repli sur la membership.
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- Liste de colonnes EXPLICITE et FIGÉE -- jamais `select *`, jamais
  -- de donnée client.
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
    and (v_include_completed or o.status not in ('completed', 'rejected', 'cancelled'))
  order by o.created_at desc
  limit case when v_include_completed then 100 else 50 end;
end;
$$;

comment on function public.get_operator_restaurant_orders(uuid, boolean) is
  'ORDERS OPERATOR READ v1 -- liste MINIMALE et en LECTURE SEULE des commandes d''un restaurant pour un opérateur Scanym (is_scanym_operator() requis, aucune membership restaurant_users utilisée). Colonnes : id, order_number, status, service_mode, created_at, updated_at, total, currency, item_count, has_invoice_request -- jamais de donnée client. SECURITY DEFINER, search_path vide, aucun SQL dynamique.';

revoke all on function public.get_operator_restaurant_orders(uuid, boolean) from public, anon, service_role;
grant execute on function public.get_operator_restaurant_orders(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------
-- 2. VÉRIFICATION POST-APPLICATION -- TOUJOURS AVANT commit; (un échec
--    ici annule la transaction complète).
-- ------------------------------------------------------------------
do $$
declare
  v_def_nocomment text;
begin
  select regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') into v_def_nocomment
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_operator_restaurant_orders';

  if v_def_nocomment not ilike '%is_scanym_operator()%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_operator_restaurant_orders ne référence pas is_scanym_operator().';
  end if;

  if v_def_nocomment ilike '%is_member_of%' or v_def_nocomment ilike '%restaurant_users%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_operator_restaurant_orders ne doit pas reposer sur la membership marchande.';
  end if;

  if v_def_nocomment ~* '(customer_name|customer_phone|customer_email|delivery_address|delivery_zone|customer_note|public_token|table_number)' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_operator_restaurant_orders référence une donnée client.';
  end if;

  if v_def_nocomment ilike '%select *%' or v_def_nocomment ilike '%select*%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: select * détecté dans get_operator_restaurant_orders.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_operator_restaurant_orders'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_include_completed boolean'
      and pg_get_function_result(p.oid) = 'TABLE(id uuid, order_number bigint, status text, service_mode text, created_at timestamp with time zone, updated_at timestamp with time zone, total numeric, currency text, item_count integer, has_invoice_request boolean)'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature / forme de retour / SECURITY DEFINER / search_path de get_operator_restaurant_orders inattendus.';
  end if;

  if has_function_privilege('anon', 'public.get_operator_restaurant_orders(uuid, boolean)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur get_operator_restaurant_orders.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_operator_restaurant_orders(uuid, boolean)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated n''a pas EXECUTE sur get_operator_restaurant_orders.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport au baseline 0518930710 (main) :
--   + fonction public.get_operator_restaurant_orders(uuid, boolean)
--     (SECURITY DEFINER, is_scanym_operator() requis, 10 colonnes
--     approuvées).
--   AUCUNE table créée. AUCUNE policy RLS modifiée. AUCUNE fonction existante modifiée.
--   AUCUNE capacité d'écriture sur les commandes.
--   Rollback : DRAFT-lot-orders-operator-read-v1-rollback.sql.
-- ============================================================
