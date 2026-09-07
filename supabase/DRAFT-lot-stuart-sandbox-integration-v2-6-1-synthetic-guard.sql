-- ============================================================
-- Scanym — STUART SANDBOX INTEGRATION v2.6.1
-- Désignation persistante et vérifiable côté serveur qu'une commande
-- est réservée EXCLUSIVEMENT au test Stuart Sandbox
-- (STUART-V26-SYNTHETIC-GUARD-01, HIGH).
--
-- DÉVELOPPEMENT / TEST UNIQUEMENT -- jamais exécuté en Production par
-- ce lot. AUCUNE ligne insérée par cette migration (mandat, littéral :
-- "do not create a real test order during migration") -- crée
-- UNIQUEMENT la structure vide.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.stuart_sandbox_synthetic_test_orders') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.stuart_sandbox_synthetic_test_orders existe déjà -- migration déjà appliquée.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_id_restaurant_id_unique') then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte orders_id_restaurant_id_unique (PAYMENT P1) absente.';
  end if;
  -- CORRECTIF v2.6.5 (STUART-V264-SYNTHETIC-PII-INVENTORY-01) :
  -- prérequis EXPLICITES sur les tables du graphe de persistance
  -- réel identifiées par la reconnaissance complète du baseline
  -- (BASELINE-SCHEMA-RECONNAISSANCE.md) -- jamais supposées présentes
  -- sans vérification.
  if to_regclass('public.order_delivery_address') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_delivery_address absente -- prérequis LOT 2A manquant.';
  end if;
  if to_regclass('public.order_billing_context') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_billing_context absente -- prérequis PAYMENT P3-B6 manquant.';
  end if;
end $$;

-- ============================================================
-- TABLE — désignation synthétique. La SEULE preuve acceptée qu'une
-- commande est réservée au test Stuart Sandbox est la PRÉSENCE d'une
-- ligne ici -- jamais une variable d'environnement seule (mandat §7,
-- littéral : "A normal production/customer order cannot satisfy the
-- invariant only because someone misconfigured Vercel environment
-- variables"). Isolation tenant structurelle via FK composite,
-- réutilisant orders_id_restaurant_id_unique -- même patron déjà
-- établi (stuart_delivery_jobs, payment_provider_events).
--
-- CRÉÉE UNIQUEMENT via un accès administratif direct (ex. Supabase
-- Studio / SQL manuel par un opérateur de confiance) -- AUCUNE RPC de
-- CRÉATION n'est fournie dans ce lot (mandat : "The synthetic marker
-- MUST NOT be controllable by the HTTP request... request must not be
-- able to mark an order synthetic") -- seule une RPC de LECTURE/
-- VÉRIFICATION est exposée (voir plus bas).
-- ============================================================
create table public.stuart_sandbox_synthetic_test_orders (
  order_id      uuid primary key,
  restaurant_id uuid not null,
  designated_at timestamptz not null default now(),
  designated_by text,

  constraint stuart_sandbox_synthetic_test_orders_order_restaurant_fk
    foreign key (order_id, restaurant_id) references public.orders(id, restaurant_id) on delete cascade
);

comment on table public.stuart_sandbox_synthetic_test_orders is
  'STUART SANDBOX INTEGRATION v2.6.1 — désignation persistante et vérifiable qu''une commande est réservée EXCLUSIVEMENT au test Stuart Sandbox. AUCUNE ligne créée par la migration elle-même. AUCUNE RPC de création exposée -- désignation strictement administrative (accès direct), jamais via une requête HTTP.';

-- ============================================================
-- RLS + REVOKE -- posture RPC-only stricte, même patron que
-- stuart_delivery_jobs (v2.1+, déjà audité) : AUCUN accès direct,
-- même pour service_role.
-- ============================================================
alter table public.stuart_sandbox_synthetic_test_orders enable row level security;
revoke all on table public.stuart_sandbox_synthetic_test_orders from public, anon, authenticated, service_role;

-- ============================================================
-- RPC — verify_stuart_sandbox_synthetic_order
--
-- Vérifie TOUTES les conditions exigées par le mandat (§1-§7) EN UNE
-- SEULE opération atomique, jamais fractionnée (évite toute fenêtre
-- de course entre vérifications) :
--   1. désignation persistante présente (table ci-dessus) ;
--   2. la commande appartient au restaurant attendu ;
--   3. AUCUNE donnée personnelle client réelle -- `customer_phone`/
--      `customer_name` DOIVENT correspondre EXACTEMENT aux constantes
--      synthétiques fournies par l'appelant (jamais dérivées ici,
--      jamais acceptées depuis la requête HTTP -- l'appelant, la
--      route Stuart, les fournit en dur depuis son propre code
--      serveur, jamais depuis le corps de la requête) ;
--   4-5. environnement/URL : vérifiés côté application
--        (environment.ts, INCHANGÉ) -- hors du périmètre SQL ;
--   6. aucune corrélation Stuart ACTIVE incompatible (autre
--      environnement) n'existe déjà pour cette commande.
-- ============================================================
create function public.verify_stuart_sandbox_synthetic_order(
  p_order_id uuid,
  p_restaurant_id uuid,
  p_expected_customer_phone text,
  p_expected_customer_name text,
  p_expected_customer_email text,
  p_expected_delivery_address text,
  p_expected_delivery_zone text,
  p_expected_customer_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_designated boolean;
  v_delivery_addr record;
begin
  -- 1+2. Désignation persistante ET appartenance au restaurant
  -- attendu, vérifiées ENSEMBLE via la FK composite elle-même.
  select exists (
    select 1 from public.stuart_sandbox_synthetic_test_orders s
    where s.order_id = p_order_id and s.restaurant_id = p_restaurant_id
  ) into v_designated;

  if not v_designated then
    return false;
  end if;

  -- 3. Les 6 champs scalaires de public.orders -- confirmés par
  -- purge_old_customer_data() (autorité RGPD existante du système).
  select o.customer_phone, o.customer_name, o.customer_email,
         o.delivery_address, o.delivery_zone, o.customer_note
    into v_order
  from public.orders o
  where o.id = p_order_id and o.restaurant_id = p_restaurant_id;

  if not found then
    return false;
  end if;
  if v_order.customer_phone is distinct from p_expected_customer_phone then return false; end if;
  if v_order.customer_name is distinct from p_expected_customer_name then return false; end if;
  if v_order.customer_email is distinct from p_expected_customer_email then return false; end if;
  if v_order.delivery_address is distinct from p_expected_delivery_address then return false; end if;
  if v_order.delivery_zone is distinct from p_expected_delivery_zone then return false; end if;
  if v_order.customer_note is distinct from p_expected_customer_note then return false; end if;

  -- 4. CORRECTIF v2.6.5 (STUART-V264-SYNTHETIC-PII-INVENTORY-01,
  -- STUART-V264-REAL-DROPOFF-ADDRESS-01) -- public.order_delivery_address
  -- (LOT 2A, table structurée 1:1, alimentée par create_order() EN
  -- PARALLÈLE de orders.delivery_address pour TOUTE commande
  -- delivery). OPTION B retenue (BASELINE-SCHEMA-RECONNAISSANCE.md) :
  -- la ligne DOIT exister (structurellement inévitable pour une
  -- commande delivery) et TOUS les champs pertinents DOIVENT
  -- correspondre EXACTEMENT à la fixture synthétique approuvée --
  -- formatted_address/postal_code = valeurs attendues ;
  -- house_number/street/complement/city/latitude/longitude = NULL
  -- (jamais peuplés par create_order actuel -- toute valeur non-NULL
  -- ici est un signal fail-closed explicite) ; country = 'FR'
  -- (défaut constant de la colonne, jamais autre chose).
  select d.formatted_address, d.postal_code, d.house_number, d.street,
         d.complement, d.city, d.country, d.latitude, d.longitude
    into v_delivery_addr
  from public.order_delivery_address d
  where d.order_id = p_order_id;

  if not found then
    -- Absence de ligne structurée : n'est acceptable QUE si la
    -- commande synthétique n'est structurellement PAS en mode
    -- delivery (impossible ici, car customer_phone/delivery_address
    -- sont déjà exigés non NULL par orders_mode_fields pour ce mode
    -- -- fail-closed explicite si ce cas imprévu survenait).
    return false;
  end if;
  if v_delivery_addr.formatted_address is distinct from p_expected_delivery_address then return false; end if;
  if v_delivery_addr.postal_code is distinct from p_expected_delivery_zone then return false; end if;
  if v_delivery_addr.house_number is not null then return false; end if;
  if v_delivery_addr.street is not null then return false; end if;
  if v_delivery_addr.complement is not null then return false; end if;
  if v_delivery_addr.city is not null then return false; end if;
  if v_delivery_addr.country is distinct from 'FR' then return false; end if;
  if v_delivery_addr.latitude is not null then return false; end if;
  if v_delivery_addr.longitude is not null then return false; end if;

  -- 5. CORRECTIF v2.6.5 -- public.order_billing_context (PAYMENT
  -- P3-B6, table 1:1, JAMAIS peuplée par create_order() lui-même,
  -- UNIQUEMENT par un appel explicite et séparé à
  -- set_order_billing_context()). Invariant retenu
  -- (BASELINE-SCHEMA-RECONNAISSANCE.md) : AUCUNE ligne ne doit
  -- exister -- une commande de test Stuart Sandbox n'a
  -- structurellement aucune raison d'avoir un contexte de
  -- facturation assemblé (elle ne passe jamais par un flux de
  -- paiement Monetico réel).
  if exists (
    select 1 from public.order_billing_context b where b.order_id = p_order_id
  ) then
    return false;
  end if;

  -- 6. Aucune corrélation Stuart ACTIVE incompatible.
  if exists (
    select 1 from public.stuart_delivery_jobs d
    where d.order_id = p_order_id and d.is_active and d.environment != 'sandbox'
  ) then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.verify_stuart_sandbox_synthetic_order(uuid, uuid, text, text, text, text, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT -- STUART SANDBOX INTEGRATION v2.6.5 (STUART-V26-SYNTHETIC-GUARD-01 + STUART-V264-SYNTHETIC-PII-INVENTORY-01, inventaire EXHAUSTIF sur le GRAPHE COMPLET de persistance -- reconnaissance complète documentée dans BASELINE-SCHEMA-RECONNAISSANCE.md). Vérifie ATOMIQUEMENT : désignation synthétique persistante ; les 6 champs scalaires de public.orders ; la cohérence EXACTE de public.order_delivery_address (LOT 2A, structurée, OPTION B -- doit exister et correspondre exactement, y compris les colonnes structurellement NULL) ; l''ABSENCE de toute ligne public.order_billing_context (PAYMENT P3-B6, jamais peuplée par create_order lui-même) ; l''absence de corrélation Stuart active incompatible. Retourne false pour TOUT écart.';

revoke all on function public.verify_stuart_sandbox_synthetic_order(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.verify_stuart_sandbox_synthetic_order(uuid, uuid, text, text, text, text, text, text) to service_role;

-- ============================================================
-- POSTCHECKS DÉTERMINISTES
-- ============================================================
do $$
declare
  v_priv boolean;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'stuart_sandbox_synthetic_test_orders' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- RLS non activée' using errcode = '55000';
  end if;

  if exists (select 1 from public.stuart_sandbox_synthetic_test_orders) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- une ligne existe déjà juste après la migration, jamais attendu (mandat: aucune commande de test réelle créée par la migration)' using errcode = '55000';
  end if;

  foreach v_priv in array array[
    has_table_privilege('anon', 'public.stuart_sandbox_synthetic_test_orders', 'select'),
    has_table_privilege('authenticated', 'public.stuart_sandbox_synthetic_test_orders', 'select'),
    has_table_privilege('service_role', 'public.stuart_sandbox_synthetic_test_orders', 'select'),
    has_table_privilege('service_role', 'public.stuart_sandbox_synthetic_test_orders', 'insert')
  ]
  loop
    if v_priv then
      raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- privilège direct inattendu sur stuart_sandbox_synthetic_test_orders' using errcode = '55000';
    end if;
  end loop;

  if has_function_privilege('anon', 'public.verify_stuart_sandbox_synthetic_order(uuid,uuid,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.verify_stuart_sandbox_synthetic_order(uuid,uuid,text,text,text,text,text,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel' using errcode = '55000';
  end if;
end $$;

commit;
