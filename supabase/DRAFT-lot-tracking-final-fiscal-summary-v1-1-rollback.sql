-- ============================================================
-- Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 — TRACKING
-- FISCAL SUMMARY EXTENSION — ROLLBACK
-- (DRAFT — NOT YET APPLIED IN PRODUCTION)
--
-- Restores `public.get_order_tracking(uuid, uuid)` to EXACTLY the
-- CUSTOMER ORDER TRACKING FOUNDATION v1 10-column contract (function
-- body, comment, and grants copied verbatim from
-- supabase/DRAFT-lot-customer-order-tracking-foundation.sql) --
-- never a partial or approximate revert.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Precondition -- refuse to roll back a function that isn't
-- actually in the post-v1.1 (13-column) shape, rather than silently
-- no-op'ing or corrupting an unexpected state.
-- ------------------------------------------------------------
do $$
declare
  v_fn_oid    oid;
  v_out_count int;
begin
  select p.oid into v_fn_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_order_tracking';

  if v_fn_oid is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking introuvable -- rien à annuler, rollback annulé.';
  end if;

  -- Colonnes RETURNS TABLE = mode 't' dans proargmodes (vérifié
  -- empiriquement sur PostgreSQL 16 -- PAS 'o', qui désigne un OUT
  -- classique, distinct). NULL (aucun mode explicite) = 0 colonnes.
  select count(*) into v_out_count
  from unnest(coalesce((select proargmodes from pg_proc where oid = v_fn_oid), array[]::"char"[])) m
  where m = 't';

  if v_out_count = 10 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking a déjà 10 colonnes de sortie -- cette extension (v1.1) ne semble pas appliquée (ou déjà annulée), rollback annulé.';
  end if;

  if v_out_count <> 13 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking a % colonnes de sortie, 13 attendues (contrat v1.1) avant rollback -- état inattendu, rollback annulé.', v_out_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. DROP + recreate the ORIGINAL v1 10-column contract, verbatim.
-- ------------------------------------------------------------
drop function public.get_order_tracking(uuid, uuid);

create function public.get_order_tracking(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  order_status text,
  service_mode text,
  order_number bigint,
  created_at timestamptz,
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.status, o.service_mode, o.order_number,
    o.created_at, o.accepted_at, o.preparing_at, o.ready_at,
    o.completed_at, o.rejected_at, o.cancelled_at
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_tracking(uuid, uuid) is
  'SECURITY DEFINER, anon+authenticated -- CUSTOMER ORDER TRACKING FOUNDATION v1. Lecture client anonyme, possession-scoped (order_id + public_token, même patron que mark_whatsapp_opened/get_order_payment_status), du order_status (orders.status, INDÉPENDANT de payment_status) et de son horodatage de transition. Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable. Ne retourne JAMAIS payment_status, restaurant_id, total/subtotal/currency, ni aucune donnée personnelle client. get_order_payment_status (PAYMENT P3-B0) reste la lecture séparée et INCHANGÉE du payment_status -- les deux dimensions ne sont jamais fusionnées. Aucune écriture.';

revoke all on function public.get_order_tracking(uuid, uuid) from public;
grant execute on function public.get_order_tracking(uuid, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. Post-verification -- structural (10 columns) + ACL, same
-- explicit-introspection discipline as the forward migration.
-- ------------------------------------------------------------
do $$
declare
  v_fn_oid    oid;
  v_out_count int;
begin
  select oid into v_fn_oid from pg_proc where pronamespace = 'public'::regnamespace and proname = 'get_order_tracking';

  select count(*) into v_out_count
  from unnest(coalesce((select proargmodes from pg_proc where oid = v_fn_oid), array[]::"char"[])) m
  where m = 't';

  if v_out_count <> 10 then
    raise exception 'SCANYM_SCHEMA_DRIFT: post-vérification rollback -- public.get_order_tracking a % colonnes de sortie, 10 attendues après rollback.', v_out_count;
  end if;

  if has_function_privilege('public', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: PUBLIC ne doit JAMAIS conserver EXECUTE sur get_order_tracking.';
  end if;
  if not has_function_privilege('anon', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon doit conserver EXECUTE sur get_order_tracking après rollback.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: authenticated doit conserver EXECUTE sur get_order_tracking après rollback.';
  end if;
end $$;

commit;
