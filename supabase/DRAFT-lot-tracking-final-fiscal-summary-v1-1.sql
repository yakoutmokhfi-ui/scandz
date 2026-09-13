-- ============================================================
-- Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 — TRACKING
-- FISCAL SUMMARY EXTENSION (DRAFT — NOT YET APPLIED IN PRODUCTION)
--
-- WHY THIS FILE EXISTS
-- ------------------------------------------------------------
-- Cat Woman's independent audit of the v1 package (verdict FAIL,
-- CCTF-V1-TRACKING-FISCAL-SUMMARY-01, HIGH, release-blocking): the
-- tracking page (`get_order_tracking`) never exposed the order's
-- authoritative historical total, nor whether an invoice request was
-- actually PERSISTED -- both already exposed on the confirmation
-- screen (from `create_order`'s own return value / from
-- `completeOrderFlow`'s own gating), but unreachable again once the
-- customer later revisits their tracking link. Explicitly authorized
-- remediation: extend the existing possession-protected tracking
-- contract with the MINIMUM additional fields needed, reading
-- EXISTING persisted order data only -- no new financial authority,
-- no catalogue recomputation, no browser-supplied invoice state.
--
-- WHY A NEW FILE, NOT AN EDIT TO
-- DRAFT-lot-customer-order-tracking-foundation.sql
-- ------------------------------------------------------------
-- Two structural reasons, both documented by that file itself:
--   1. `CREATE OR REPLACE FUNCTION` cannot change the column set of
--      an existing `RETURNS TABLE(...)` -- adding columns REQUIRES
--      `DROP FUNCTION` + recreate (see that file's own "GAP
--      ARCHITECTURAL" note, D. above the migration body).
--   2. That file's own anti-double-application guard raises
--      `SCANYM_SCHEMA_DRIFT` the moment `public.get_order_tracking`
--      already exists -- so it can never be reapplied to a database
--      where v1 already ran. This is therefore a SEPARATE, additive
--      migration: it requires the v1 function to ALREADY exist (the
--      opposite precondition) and replaces it, in place, with an
--      extended-but-otherwise-identical one.
--
-- WHAT IS ADDED, AND WHY EACH FIELD IS SAFE
-- ------------------------------------------------------------
--   order_total (numeric)     : `orders.total` verbatim -- the SAME
--     single authoritative total already used by
--     lib/services/orders.ts::CreatedOrder (create_order's own
--     return value) and by the confirmation screen (`totalAmount`
--     prop, CUSTOMER CONFIRMATION + TRACKING FINAL v1). `orders.total`
--     already equals subtotal + delivery_fee where applicable
--     (DRAFT-lot-delivery-financial-persistence-foundation-v1.sql,
--     "orders.total (= subtotal + delivery_fee)") -- this migration
--     does NOT touch, read, or reason about `provider_cost`,
--     `customer_delivery_fee`, `merchant_delivery_subsidy`, or any
--     delivery VAT allocation column: it reads the single already-
--     computed, already-persisted `orders.total` column exactly as
--     it stands, HISTORICAL by construction (set once at order
--     creation/finalization, never recomputed from current catalogue
--     prices/VAT/delivery rules/product state by this RPC -- this
--     function contains no arithmetic whatsoever, a pure SELECT).
--   order_currency (text)     : `orders.currency` verbatim -- needed
--     to FORMAT `order_total` correctly (same pairing already used by
--     `formatPrice(totalAmount, restaurant.config.currency)` on the
--     confirmation screen); no new authority, a plain persisted
--     column already read by numerous existing RPCs.
--   invoice_requested (boolean): `exists(select 1 from
--     public.order_invoice_request where order_id = o.id)` -- TRUE
--     if and only if `set_order_invoice_request` (CUSTOMER CHECKOUT
--     INVOICE REQUEST FOUNDATION v1) has already been called
--     successfully for this order (that RPC performs a deterministic
--     upsert keyed on `order_id`, so a row's mere EXISTENCE already
--     means "successfully persisted", never "customer clicked
--     invoice" -- that intent, if ever unpersisted due to a failed
--     request, leaves no row at all). This migration reads ONLY the
--     boolean existence of that row -- never `invoice_type`,
--     `contact_email`, `contact_name`, `vat_number`, or any other
--     column of `order_invoice_request` (no PII, no invoice content,
--     no invoice generation of any kind is added by this lot).
--
-- SECURITY POSTURE -- UNCHANGED, RE-VERIFIED EXPLICITLY
-- ------------------------------------------------------------
-- Same possession proof as v1 (`p_order_id` + `p_public_token` must
-- match the SAME `orders` row, pure SQL, no branch -- an incorrect
-- pair still produces an empty result set, identically in every
-- case). Same grants: `anon`+`authenticated` EXECUTE, nothing else,
-- no table-level grant added or needed (SECURITY DEFINER, exactly as
-- v1). No new RPC, no new public unauthenticated enumeration surface
-- -- this is the SAME function name, SAME two arguments, SAME
-- possession-scoped WHERE clause; only the projected column list
-- grows. Cross-order/cross-tenant isolation is structurally
-- unaffected (unchanged WHERE clause; `order_invoice_request`'s own
-- RLS is irrelevant here since this function is SECURITY DEFINER and
-- never queries that table through the browser's own role).
--
-- LESSON APPLIED FROM THE CGV STREAM'S ACL ISSUE (mandat, explicit
-- instruction "must not repeat the ACL issue found in the CGV
-- stream"): rather than trusting the textual REVOKE/GRANT statements
-- alone (which is exactly what silently drifted for
-- `order_invoice_request` on Production PostgreSQL 17, see
-- DRAFT-lot-invoice-request-production-acl-remediation-v1.sql's own
-- postmortem), section 4 below RE-VERIFIES the actual resulting ACL
-- via `has_function_privilege()` for every relevant role explicitly,
-- INCLUDING an explicit check that PUBLIC itself retains no EXECUTE
-- (PostgreSQL grants EXECUTE to PUBLIC by default on every new
-- function unless explicitly revoked -- this is precisely the kind
-- of silent-default gap this lesson is about, here checked for a
-- FUNCTION rather than a TABLE, since this migration creates no new
-- table).
--
-- Migration atomicity: same discipline as the files it extends --
-- ONE explicit transaction, fails closed, never a partially-applied
-- state.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Preconditions + anti-double-application guard.
-- ------------------------------------------------------------
do $$
declare
  v_fn_oid     oid;
  v_out_count  int;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('total', 'currency')
    having count(*) = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.total/currency introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request introuvable -- prérequis DRAFT-lot-invoice-request-foundation-v1.sql manquant, migration annulée.';
  end if;

  select p.oid into v_fn_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_order_tracking';

  if v_fn_oid is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking introuvable -- prérequis DRAFT-lot-customer-order-tracking-foundation.sql manquant, migration annulée.';
  end if;

  -- Nombre de colonnes de sortie (RETURNS TABLE) -- garde anti double-
  -- application STRUCTURELLE (jamais un simple test d'existence, qui
  -- serait toujours vrai après la première application de CE fichier
  -- lui-même) : compte les paramètres en mode TABLE ('t', PAS 'o' --
  -- vérifié empiriquement sur PostgreSQL 16 : une colonne
  -- `RETURNS TABLE(...)` porte le mode 't' dans `pg_proc.proargmodes`,
  -- distinct du mode `OUT` classique 'o') ; ce tableau contient une
  -- entrée par paramètre (IN et TABLE) dès qu'au moins un paramètre
  -- porte un mode explicite -- absence totale (NULL) = aucune colonne
  -- TABLE, donc 0, jamais une valeur de repli inventée.
  select count(*) into v_out_count
  from unnest(
    coalesce(
      (select proargmodes from pg_proc where oid = v_fn_oid),
      array[]::"char"[]
    )
  ) m
  where m = 't';

  if v_out_count = 13 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking a déjà 13 colonnes de sortie -- cette extension (TRACKING FISCAL SUMMARY v1.1) semble déjà appliquée, migration annulée (double application refusée).';
  end if;

  if v_out_count <> 10 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking a % colonnes de sortie, 10 attendues (contrat v1) avant cette extension -- schéma inattendu, migration annulée.', v_out_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. DROP + recreate -- seule voie PostgreSQL valide pour étendre un
-- RETURNS TABLE(...) existant (voir en-tête).
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
  cancelled_at timestamptz,
  order_total numeric,
  order_currency text,
  invoice_requested boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.status, o.service_mode, o.order_number,
    o.created_at, o.accepted_at, o.preparing_at, o.ready_at,
    o.completed_at, o.rejected_at, o.cancelled_at,
    o.total, o.currency,
    exists (
      select 1 from public.order_invoice_request oir
      where oir.order_id = o.id
    )
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_tracking(uuid, uuid) is
  'SECURITY DEFINER, anon+authenticated -- CUSTOMER ORDER TRACKING FOUNDATION v1, ÉTENDU par CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 (remédiation CCTF-V1-TRACKING-FISCAL-SUMMARY-01). Lecture client anonyme, possession-scoped (order_id + public_token, INCHANGÉ). Ajoute order_total/order_currency (orders.total/orders.currency, valeurs PERSISTÉES HISTORIQUES, jamais recalculées depuis le catalogue/TVA/tarification livraison courants -- ne touche ni ne lit provider_cost/customer_delivery_fee/merchant_delivery_subsidy/allocation TVA livraison) et invoice_requested (existence, et EXISTENCE SEULE, d''une ligne public.order_invoice_request pour cette commande -- jamais son contenu : aucune donnée de facturation/PII n''est exposée par ce champ, aucune génération de facture n''est ajoutée). Ne retourne toujours JAMAIS payment_status, restaurant_id, ni aucune coordonnée client (nom/téléphone/email/adresse/note). Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable, comportement inchangé depuis v1.';

revoke all on function public.get_order_tracking(uuid, uuid) from public;
grant execute on function public.get_order_tracking(uuid, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. Post-vérification structurelle -- le contrat a bien grandi de
-- 10 à 13 colonnes de sortie, jamais un no-op silencieux.
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

  if v_out_count <> 13 then
    raise exception 'SCANYM_SCHEMA_DRIFT: post-vérification -- public.get_order_tracking a % colonnes de sortie après cette migration, 13 attendues -- migration incomplète ou incorrecte.', v_out_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. Post-vérification ACL -- introspection EXPLICITE (jamais une
-- confiance aveugle dans le texte REVOKE/GRANT ci-dessus), leçon
-- directement tirée de l'incident ACL du flux CGV (voir en-tête).
-- ------------------------------------------------------------
do $$
begin
  if has_function_privilege('public', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: PUBLIC ne doit JAMAIS conserver EXECUTE sur get_order_tracking (défaut PostgreSQL implicite non révoqué).';
  end if;
  if not has_function_privilege('anon', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon doit conserver EXECUTE sur get_order_tracking (contrat inchangé depuis v1).';
  end if;
  if not has_function_privilege('authenticated', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: authenticated doit conserver EXECUTE sur get_order_tracking (contrat inchangé depuis v1).';
  end if;
  if has_function_privilege('service_role', 'public.get_order_tracking(uuid, uuid)', 'execute')
     and not has_function_privilege('anon', 'public.get_order_tracking(uuid, uuid)', 'execute') then
    -- Défensif seulement : service_role hérite normalement d'un accès
    -- superutilisateur/propriétaire distinct de ce GRANT explicite ;
    -- cette branche ne devrait jamais se déclencher seule (elle exige
    -- aussi que anon ait PERDU son propre accès), gardée uniquement
    -- pour ne jamais laisser un état incohérent passer silencieusement.
    raise exception 'SCANYM_SECURITY_DRIFT: état de grant incohérent détecté sur get_order_tracking.';
  end if;
end $$;

commit;
