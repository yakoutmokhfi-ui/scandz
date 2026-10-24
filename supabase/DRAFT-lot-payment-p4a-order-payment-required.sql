-- ============================================================
-- Scanym — PAYMENT P4-A / ORDER PAYMENT REQUIRED — SQL LOT
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION : à appliquer UNIQUEMENT sur
-- décision explicite du CIO, après revue de la PR.)
--
-- POURQUOI CE LOT : PAYMENT P1 crée toute commande avec
-- `orders.payment_status = 'not_required'` (« aucun paiement en ligne
-- concerné ») et le runtime P3-B (lib/server/payment-checkout-runtime.ts)
-- répond alors `checkout_not_needed` : AUCUNE commande ne peut donc
-- aujourd'hui être payée en ligne, même pour un établissement dont la
-- configuration prestataire est activée ET vérifiée (Au Lait Cru,
-- Monetico, mode test, 24/10/2026). Il manque l'état intermédiaire
-- « paiement requis, aucune tentative encore initiée ».
--
-- CE QUE FAIT CE LOT (strictement additif) :
--   1. ajoute la valeur `required` à la contrainte CHECK de
--      `orders.payment_status` (les cinq valeurs P1 sont conservées à
--      l'identique ; aucune ligne existante n'est modifiée) ;
--   2. crée `public.require_order_payment(p_order_id, p_public_token,
--      p_provider_code)` -- SECURITY DEFINER, service_role UNIQUEMENT,
--      possession-scoped (même patron que get_order_payment_context) :
--      fait passer UNE commande de `not_required` à `required` SI ET
--      SEULEMENT SI (a) elle est encore `status = 'new'` (jamais une
--      commande déjà acceptée/préparée/terminée/refusée/annulée),
--      (b) son total est > 0, (c) son établissement possède, pour ce
--      prestataire, une configuration `is_enabled = true` ET
--      `configuration_status = 'verified'` (la MÊME autorité que celle
--      lue par le runtime via get_payment_runtime_provider_environment).
--      Dans tous les autres cas la fonction ne modifie RIEN et renvoie
--      l'état courant (idempotente : rappeler sur une commande déjà
--      `required`/`pending`/`paid`/... ne change rien).
--
-- CE QUE CE LOT NE FAIT PAS : il ne touche ni create_order, ni
-- initiate_payment_attempt / confirm_payment_attempt (P1, inchangées :
-- `required` -> `pending` reste posé EXCLUSIVEMENT par
-- initiate_payment_attempt, et seule confirm_payment_attempt pose
-- paid/failed/cancelled), ni aucune fonction de lecture existante
-- (get_order_payment_context / get_order_payment_status_snapshot
-- renvoient la nouvelle valeur telle quelle -- leurs appelants
-- TypeScript traitent déjà payment_status comme une chaîne). Aucun
-- grant de table n'est ajouté pour aucun rôle.
--
-- DÉCISION MÉTIER PORTÉE PAR CE LOT (CIO, 24/10/2026) : « le paiement
-- est toujours obligatoire pour Au Lait Cru » -- l'obligation est
-- dérivée de la configuration prestataire activée+vérifiée de
-- l'établissement, jamais d'un paramètre envoyé par le navigateur.
--
-- ROLLBACK : voir DRAFT-lot-payment-p4a-order-payment-required-rollback.sql
-- (retire la fonction ; la valeur `required` n'est retirée de la CHECK
-- que s'il ne reste AUCUNE commande dans cet état).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','public_token','restaurant_id','status','total','payment_status')
    having count(*) = 6
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_status_check'
      and contype = 'c'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte orders_payment_status_check introuvable -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_configs'
      and column_name in ('restaurant_id','provider_code','is_enabled','configuration_status')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_provider_configs -- prérequis PAYMENT P1/P2A manquant, migration annulée.';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_status_check'
      and pg_get_constraintdef(oid) ilike '%''required''%'
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'require_order_payment'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: PAYMENT P4-A déjà appliqué (valeur required déjà présente ou require_order_payment existe déjà), migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. orders.payment_status : ajout de la valeur `required`.
-- Les cinq valeurs P1 sont reprises À L'IDENTIQUE et dans le même
-- ordre ; aucune ligne existante ne change (toutes restent valides).
-- ------------------------------------------------------------
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('not_required','required','pending','paid','failed','cancelled'));

comment on column public.orders.payment_status is
  'Machine à états du PAIEMENT, INDÉPENDANTE de orders.status (cycle cuisine). not_required = aucun paiement en ligne concerné (défaut, comportement historique). required (PAYMENT P4-A) = paiement en ligne exigé par la configuration prestataire activée+vérifiée de l''établissement, aucune tentative encore initiée -- posé UNIQUEMENT par require_order_payment, uniquement depuis not_required, uniquement sur une commande status=new. pending/paid/failed/cancelled = reflète EXCLUSIVEMENT la tentative pointée par current_payment_transaction_id (P1, inchangé). Remboursement hors périmètre.';

-- ------------------------------------------------------------
-- 3. require_order_payment — MUTATION ÉTROITE, SECURITY DEFINER,
-- service_role UNIQUEMENT, possession-scoped.
-- ------------------------------------------------------------
create or replace function public.require_order_payment(
  p_order_id uuid,
  p_public_token uuid,
  p_provider_code text
)
returns table (
  payment_status text,
  changed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_order record;
  v_config_ok boolean;
begin
  if p_order_id is null or p_public_token is null then
    return;
  end if;

  -- Même normalisation que PAYMENT P1 (initiate_payment_attempt) :
  -- trim + jeu de caractères sûr, jamais de mise en minuscule imposée.
  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if v_provider_code = '' or length(v_provider_code) > 40 or v_provider_code !~ '^[a-zA-Z0-9_-]+$' then
    raise exception 'SCANYM_PAYMENT_P4A: p_provider_code invalide' using errcode = '22023';
  end if;

  -- Preuve de possession EXACTE (id + public_token), verrou de ligne :
  -- une seule décision à la fois pour une commande donnée.
  select o.id, o.restaurant_id, o.status, o.total, o.payment_status
    into v_order
    from public.orders o
   where o.id = p_order_id
     and o.public_token = p_public_token
   for update;

  if not found then
    return;
  end if;

  -- Déjà décidé (required/pending/paid/failed/cancelled) : rien à
  -- faire, état courant renvoyé tel quel (idempotence).
  if v_order.payment_status <> 'not_required' then
    return query select v_order.payment_status::text, false;
    return;
  end if;

  -- Jamais sur une commande déjà prise en charge ou close : le
  -- paiement en ligne ne concerne que le tout début du cycle.
  if v_order.status <> 'new' then
    return query select v_order.payment_status::text, false;
    return;
  end if;

  if v_order.total is null or v_order.total <= 0 then
    return query select v_order.payment_status::text, false;
    return;
  end if;

  -- AUTORITÉ UNIQUE de l'obligation : la configuration prestataire de
  -- l'établissement, activée ET vérifiée (même lecture que
  -- get_payment_runtime_provider_environment).
  select exists (
    select 1 from public.payment_provider_configs c
     where c.restaurant_id = v_order.restaurant_id
       and c.provider_code = v_provider_code
       and c.is_enabled = true
       and c.configuration_status = 'verified'
  ) into v_config_ok;

  if not v_config_ok then
    return query select v_order.payment_status::text, false;
    return;
  end if;

  update public.orders o
     set payment_status = 'required'
   where o.id = v_order.id
     and o.payment_status = 'not_required';

  return query select 'required'::text, true;
end;
$$;

comment on function public.require_order_payment(uuid, uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P4-A ORDER PAYMENT REQUIRED. Mutation ÉTROITE et idempotente : fait passer une commande de not_required à required (aucune autre transition, jamais vers pending/paid/failed/cancelled -- celles-ci restent la propriété exclusive de initiate_payment_attempt/confirm_payment_attempt, P1 inchangées) SI ET SEULEMENT SI la preuve de possession (id + public_token) est exacte, la commande est encore status=new, son total est > 0 et son établissement possède pour ce prestataire une configuration is_enabled=true ET configuration_status=verified (autorité unique, jamais un paramètre navigateur). Sinon ne modifie rien et renvoie l''état courant (changed=false). Ensemble vide pour toute paire incorrecte ou argument NULL. Verrou FOR UPDATE sur la commande. Aucune lecture de credential, aucune donnée personnelle renvoyée.';

revoke all on function public.require_order_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.require_order_payment(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 4. POST-CHECK.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_status_check'
      and pg_get_constraintdef(oid) ilike '%''required''%'
      and pg_get_constraintdef(oid) ilike '%''not_required''%'
      and pg_get_constraintdef(oid) ilike '%''pending''%'
      and pg_get_constraintdef(oid) ilike '%''paid''%'
      and pg_get_constraintdef(oid) ilike '%''failed''%'
      and pg_get_constraintdef(oid) ilike '%''cancelled''%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- contrainte orders_payment_status_check incomplète après migration' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.require_order_payment(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.require_order_payment(uuid,uuid,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- require_order_payment exposée à un rôle public' using errcode = '55000';
  end if;
end $$;

commit;
