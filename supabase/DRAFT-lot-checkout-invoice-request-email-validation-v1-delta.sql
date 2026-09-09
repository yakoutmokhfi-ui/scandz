-- ============================================================
-- Scanym — CUSTOMER CHECKOUT — INVOICE REQUEST — EMAIL VALIDATION
-- DELTA v1 (DRAFT — NOT YET APPLIED IN PRODUCTION)
--
-- INVOICE REQUEST PRODUCTION PREREQUISITE GAP — Claude Monet.
--
-- SCOPE: this file changes EXACTLY ONE thing -- it adds a
-- server-side FORMAT check on the already-optional
-- order_invoice_request.contact_email field, inside
-- set_order_invoice_request. It is the same change originally
-- authorized under Checkout Email Validation v1/v1.1's CIO GO, now
-- isolated from foundation-object creation so it can be reviewed and
-- authorized independently.
--
-- PREREQUISITE: DRAFT-lot-invoice-request-foundation-v1.sql MUST
-- already be installed (table + RLS + policy + grants + both RPCs,
-- in their pre-email-lot form). This file's own precheck verifies
-- that and refuses to run otherwise.
--
-- THIS FILE DOES NOT, AND STRUCTURALLY CANNOT (see proof below):
--   - create any table
--   - create any index
--   - create or modify any RLS policy
--   - modify any GRANT or REVOKE
--   - broaden any authorization
--
-- WHY IT CANNOT: `create or replace function` with an UNCHANGED
-- argument signature (same name, same parameter types, same order)
-- replaces only the function's body -- PostgreSQL does not reset or
-- require re-declaring that function's existing GRANTs/REVOKEs, its
-- owner, or any RLS state on any other object when a function body
-- is replaced this way. The signature below
-- (uuid,uuid,text,text,text,text,text,text,text,text,text,text) is
-- byte-identical to the foundation file's signature. This is proven
-- empirically, not just asserted -- see the local Postgres proof in
-- TEST-RESULTS.md / the check script's dedicated "grants survive a
-- CREATE OR REPLACE" sub-test.
--
-- The added check reuses the EXACT SAME regex already used by
-- create_order() for customer_email (supabase/migration-orders.sql
-- and its successive redefinitions) -- never a second, independent
-- format rule -- and the same errcode '22023' already used for this
-- class of error elsewhere in this repository (merchant legal email,
-- supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql), already
-- recognized generically by the calling route
-- (app/api/checkout/invoice-request/route.ts, which treats
-- 22004/22023/22001 as a distinguishable validation error, never a
-- generic response) -- so no change to that route is required by
-- this file either.
--
-- contact_email remains OPTIONAL: this check only applies when a
-- non-empty value is supplied, exactly as before this delta.
-- ============================================================
begin;

-- ------------------------------------------------------------
-- Precheck: foundation must already be installed, and this delta
-- must not be applied twice redundantly (idempotency guard: if the
-- function's current body already contains the email-format check,
-- stop rather than silently no-op or risk drifting from a possible
-- later, different, evolution of this function).
-- ------------------------------------------------------------
do $$
declare
  v_def text;
begin
  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request missing -- install DRAFT-lot-invoice-request-foundation-v1.sql first.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'set_order_invoice_request' and pronargs = 12
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: set_order_invoice_request with the expected 12-argument signature is missing -- install the foundation first.';
  end if;

  select pg_get_functiondef(oid) into v_def
  from pg_proc
  where proname = 'set_order_invoice_request' and pronargs = 12;

  if v_def ilike '%p_contact_email invalide%' then
    raise exception 'SCANYM_ALREADY_APPLIED: set_order_invoice_request already contains an email-format check -- this delta appears to already be installed. Refusing to reapply blindly.';
  end if;
end $$;

-- ------------------------------------------------------------
-- The delta itself: CREATE OR REPLACE FUNCTION with the identical
-- signature, body identical to the foundation version PLUS exactly
-- one added validation block (marked below). No GRANT/REVOKE
-- statement appears anywhere in this file -- none is needed.
-- ------------------------------------------------------------
create or replace function public.set_order_invoice_request(
  p_order_id           uuid,
  p_public_token       uuid,
  p_invoice_type       text,
  p_address_line_1     text,
  p_city               text,
  p_postal_code        text,
  p_country            text,
  p_address_line_2     text default null,
  p_company_legal_name text default null,
  p_vat_number         text default null,
  p_contact_name       text default null,
  p_contact_email      text default null
)
returns table (
  order_id      uuid,
  invoice_type  text,
  updated_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_order               public.orders%rowtype;
  v_invoice_type        text;
  v_address_line_1      text;
  v_address_line_2      text;
  v_city                text;
  v_postal_code         text;
  v_country             text;
  v_company_legal_name  text;
  v_vat_number          text;
  v_contact_name        text;
  v_contact_email       text;
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.public_token = p_public_token;

  if not found then
    raise exception 'SCANYM_INVOICE_REQUEST: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  v_invoice_type := btrim(coalesce(p_invoice_type, ''));
  if v_invoice_type not in ('individual', 'company') then
    raise exception 'SCANYM_INVOICE_REQUEST: p_invoice_type doit valoir exactement ''individual'' ou ''company''' using errcode = '22023';
  end if;

  v_address_line_1 := nullif(btrim(coalesce(p_address_line_1, '')), '');
  if v_address_line_1 is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_1 requis' using errcode = '22004';
  end if;
  if length(v_address_line_1) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_1 dépasse 50 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_address_line_2 := nullif(btrim(coalesce(p_address_line_2, '')), '');
  if v_address_line_2 is not null and length(v_address_line_2) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_2 dépasse 50 caractères' using errcode = '22001';
  end if;

  v_city := nullif(btrim(coalesce(p_city, '')), '');
  if v_city is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_city requis' using errcode = '22004';
  end if;
  if length(v_city) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_city dépasse 50 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_postal_code := nullif(btrim(coalesce(p_postal_code, '')), '');
  if v_postal_code is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_postal_code requis' using errcode = '22004';
  end if;
  if length(v_postal_code) > 10 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_postal_code dépasse 10 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_country := upper(btrim(coalesce(p_country, '')));
  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'SCANYM_INVOICE_REQUEST: p_country doit être un code ISO 3166-1 alpha-2 (2 lettres)' using errcode = '22023';
  end if;

  v_company_legal_name := nullif(btrim(coalesce(p_company_legal_name, '')), '');
  if v_invoice_type = 'company' and v_company_legal_name is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_company_legal_name requis lorsque p_invoice_type = ''company''' using errcode = '22004';
  end if;
  if v_company_legal_name is not null and length(v_company_legal_name) > 120 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_company_legal_name dépasse 120 caractères' using errcode = '22001';
  end if;

  v_vat_number := nullif(btrim(coalesce(p_vat_number, '')), '');
  if v_vat_number is not null and length(v_vat_number) > 30 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_vat_number dépasse 30 caractères' using errcode = '22001';
  end if;

  v_contact_name := nullif(btrim(coalesce(p_contact_name, '')), '');
  if v_contact_name is not null and length(v_contact_name) > 45 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_name dépasse 45 caractères' using errcode = '22001';
  end if;

  v_contact_email := nullif(btrim(coalesce(p_contact_email, '')), '');
  if v_contact_email is not null and length(v_contact_email) > 100 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email dépasse 100 caractères' using errcode = '22001';
  end if;
  -- ====== EMAIL VALIDATION DELTA v1 — the ONLY added block ======
  -- Reuses EXACTLY create_order's customer_email regex and the
  -- existing '22023' errcode convention. contact_email stays
  -- OPTIONAL -- this only fires when a non-empty value is supplied.
  if v_contact_email is not null and v_contact_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email invalide' using errcode = '22023';
  end if;
  -- ====== end of the added block ======

  insert into public.order_invoice_request (
    order_id, invoice_type, company_legal_name, vat_number,
    contact_name, contact_email,
    address_line_1, address_line_2, city, postal_code, country,
    updated_at
  ) values (
    p_order_id, v_invoice_type, v_company_legal_name, v_vat_number,
    v_contact_name, v_contact_email,
    v_address_line_1, v_address_line_2, v_city, v_postal_code, v_country,
    now()
  )
  on conflict (order_id) do update set
    invoice_type        = excluded.invoice_type,
    company_legal_name  = excluded.company_legal_name,
    vat_number           = excluded.vat_number,
    contact_name         = excluded.contact_name,
    contact_email        = excluded.contact_email,
    address_line_1       = excluded.address_line_1,
    address_line_2       = excluded.address_line_2,
    city                 = excluded.city,
    postal_code          = excluded.postal_code,
    country              = excluded.country,
    updated_at           = now();

  return query
    select r.order_id, r.invoice_type, r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$$;

comment on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) is
  'SECURITY DEFINER -- CUSTOMER CHECKOUT INVOICE REQUEST v1.1 (foundation + email validation delta applied). Écrit/met à jour (upsert déterministe) la demande de facture d''une commande, avec preuve de possession anonyme (id + public_token). Échec fermé sur toute entrée invalide/incomplète, y compris désormais le FORMAT de contact_email lorsqu''il est fourni. AUCUN déclenchement de paiement, de Stuart, ou de communication client.';

-- ------------------------------------------------------------
-- Postcheck: prove the delta changed ONLY the function body --
-- table/RLS/grants are exactly as the foundation left them.
-- ------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.order_invoice_request', 'select') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon must NEVER be able to read order_invoice_request (drift introduced by the email delta)';
  end if;
  if has_table_privilege('authenticated', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: authenticated must NEVER write directly to order_invoice_request (drift introduced by the email delta)';
  end if;
  if has_table_privilege('service_role', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: service_role must NEVER have a direct table privilege (drift introduced by the email delta)';
  end if;
  if has_function_privilege('anon', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: set_order_invoice_request must remain executable only by service_role after the email delta';
  end if;
  if not has_function_privilege('service_role', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception 'SCANYM_REGRESSION: service_role lost EXECUTE on set_order_invoice_request after the email delta -- CREATE OR REPLACE must never drop an existing grant';
  end if;
  if not (select relrowsecurity from pg_class where relname = 'order_invoice_request') then
    raise exception 'SCANYM_SECURITY_DRIFT: RLS was disabled on order_invoice_request by the email delta';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'order_invoice_request' and policyname = 'order_invoice_request_select_staff') then
    raise exception 'SCANYM_SECURITY_DRIFT: order_invoice_request_select_staff policy is missing after the email delta';
  end if;
end $$;

commit;
