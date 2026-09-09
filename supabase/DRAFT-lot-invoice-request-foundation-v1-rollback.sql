-- ============================================================
-- Scanym — CUSTOMER CHECKOUT — INVOICE REQUEST FOUNDATION v1 —
-- ROLLBACK (v1.1 — HARDENED DRIFT GUARD)
-- (DRAFT — NOT YET APPLIED IN PRODUCTION)
--
-- INVOICE REQUEST PRODUCTION PREREQUISITE REMEDIATION v1.1 —
-- TARGETED ROLLBACK DRIFT-GUARD HARDENING ONLY — Claude Monet.
--
-- ROLLBACK CLASSIFICATION: GUARDED. Drops
-- get_order_invoice_request, set_order_invoice_request, and the
-- order_invoice_request table (RLS/policy/grants go with the table,
-- automatically, via normal PostgreSQL object-drop semantics -- no
-- separate DROP POLICY/REVOKE statement is needed or included).
--
-- ORDERING REQUIREMENT: if
-- DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql
-- has been applied, roll IT back FIRST
-- (DRAFT-lot-checkout-invoice-request-email-validation-v1-delta-rollback.sql)
-- before running this file. This file's own guard below does not
-- require that (it accepts either the foundation-only or the
-- delta-applied function body -- dropping a function does not care
-- about its body), but rolling back the delta first keeps the two
-- rollback units independently auditable and reversible one at a
-- time, per the mandate's "smallest safe remediation" principle.
--
-- ============================================================
-- v1.1 HARDENING — WHY THIS FILE CHANGED (Catimini findings,
-- release-blocking, both HIGH severity; see
-- CATIMINI-FINDINGS-REMEDIATION.md and
-- ROLLBACK-DRIFT-GUARD-EVIDENCE.md for the full writeup):
--
-- BLOCKER 1 (function drift): the v1 guard checked only function
-- NAME + ARGUMENT COUNT before dropping set_order_invoice_request /
-- get_order_invoice_request. A later, legitimate function evolution
-- that preserved the same name and argument count (e.g. a changed
-- body, a changed SECURITY DEFINER/search_path posture, a changed
-- return type via CREATE OR REPLACE) could pass that shallow guard
-- and be silently destroyed. FIXED below: before dropping either
-- function, this file captures pg_get_functiondef(oid) for the
-- CURRENTLY INSTALLED function and requires an EXACT, byte-for-byte
-- (whitespace-normalized) match against the known-good canonical
-- text captured from a real PostgreSQL 16 instance immediately after
-- this lot's own install. pg_get_functiondef's output already
-- encodes function identity, argument types, return type, language,
-- volatility, SECURITY DEFINER state, search_path, and the complete
-- function body in one canonical string -- so one exact-string
-- comparison per function covers every element Catimini named.
-- set_order_invoice_request has TWO acceptable known-good states
-- (FOUNDATION-only, or FOUNDATION+EMAIL-DELTA applied on top -- both
-- are legitimate, already-audited states this rollback may be run
-- against); get_order_invoice_request has exactly ONE (the email
-- delta never touches it). If the installed definition matches
-- NEITHER known-good state, the guard refuses -- fails CLOSED.
--
-- BLOCKER 2 (table/security drift): the v1 guard checked only
-- COLUMN NAMES/COUNT and POLICY NAMES/COUNT -- it did not check
-- column data types, nullability, or defaults; constraint
-- definitions; index definitions; RLS forced-state; full policy
-- definitions (command, roles, USING, WITH CHECK); or exact GRANT
-- state. A future schema or security evolution with the same
-- shallow shape (same column/policy NAMES and COUNTS, but a changed
-- type, constraint, index, RLS-forced flag, policy predicate, or
-- grant) could have been silently destroyed. FIXED below: this file
-- computes a single deterministic FINGERPRINT text -- one line per
-- column (name/type/udt/length/nullability/default), per constraint
-- (name + pg_get_constraintdef), per index (name + definition), the
-- table's RLS enabled AND forced flags, per policy (name/command/
-- roles/USING/WITH CHECK), and every relevant GRANT
-- (anon/authenticated/service_role/public x select/insert/update/
-- delete on the table, and anon/authenticated/service_role x execute
-- on both RPCs) -- sorted deterministically and joined with newlines
-- -- and requires it to match, EXACTLY, the fingerprint captured from
-- a real PostgreSQL 16 instance immediately after this lot's own
-- foundation install. This single fingerprint is proven (see
-- ROLLBACK-DRIFT-GUARD-EVIDENCE.md) to be IDENTICAL whether or not
-- the email delta has been applied on top (the delta touches only
-- one function's body, never the table/RLS/policy/grants), so ONE
-- expected fingerprint value correctly covers both states this
-- rollback may legitimately run against.
--
-- ATOMIC SAFETY: every guard below runs INSIDE ONE do $rollback_guard$
-- ... end $rollback_guard$ block, BEFORE any DROP statement. If ANY
-- guard fails, the RAISE EXCEPTION aborts the entire enclosing
-- transaction (this file is wrapped in one explicit BEGIN/COMMIT) --
-- there is no code path by which one object can be dropped while a
-- later guard is still pending. DRIFT DETECTED means ZERO MUTATION,
-- always.
--
-- FORWARD SQL UNCHANGED: this hardening touches ONLY this rollback
-- file. DRAFT-lot-invoice-request-foundation-v1.sql (the forward
-- Foundation SQL) and its security model are NOT modified by this
-- lot -- see NON-MODIFICATION-PROOF.md / CATIMINI-FINDINGS-REMEDIATION.md.
-- ============================================================
--
-- ============================================================
-- v1.2 ADDENDUM -- Catimini's re-audit of v1.1 confirmed the
-- function drift guard (Blocker 1, above) is CLOSED, and re-confirmed
-- Foundation forward SQL / Email delta / tenant isolation / server
-- email validation / Payment Operator Authorization preservation all
-- remain PASS. It raised three further HIGH findings, all against
-- the TABLE/SECURITY fingerprint (the v1.1 Blocker 2 fix), which was
-- not yet exhaustive:
--
-- CATIMINI HIGH 1 (grant fingerprint incomplete): v1.1's grant
-- fingerprint checked only a hardcoded role list
-- (anon/authenticated/service_role/public) and a hardcoded privilege
-- subset (select/insert/update/delete). A grant to any OTHER role,
-- or of TRUNCATE/REFERENCES/TRIGGER, was invisible. FIXED: the
-- fingerprint below now uses aclexplode() directly against
-- pg_class.relacl (table) and pg_proc.proacl (both RPCs) -- the
-- actual catalogue ACL, exploded into one row per (grantee,
-- privilege_type, grantor, is_grantable) tuple, with NO role list and
-- NO privilege-type list assumed. Every grantee (including the table/
-- function owner's own implicit full privilege set) and every
-- privilege type PostgreSQL recognizes is included automatically.
-- Falls back to acldefault() when relacl/proacl is NULL (PostgreSQL's
-- own default-ACL semantics), so a NULL-ACL state is fingerprinted
-- correctly too, never skipped.
--
-- CATIMINI HIGH 2 (policy permissive/restrictive omitted): v1.1's
-- policy fingerprint checked name/command/roles/USING/WITH CHECK but
-- not the PERMISSIVE vs RESTRICTIVE flag. FIXED: the fingerprint now
-- includes pg_policies.permissive for every policy.
--
-- CATIMINI HIGH 3 (column fingerprint incomplete -- collation named
-- specifically): v1.1's column fingerprint omitted collation,
-- domain identity, identity/generated column state, and full
-- numeric/datetime precision. FIXED: the fingerprint now also
-- includes, per column, numeric_precision, numeric_scale,
-- datetime_precision, is_identity, identity_generation, is_generated,
-- generation_expression, collation_catalog, collation_schema,
-- collation_name, domain_schema, and domain_name from
-- information_schema.columns -- verified empirically (not assumed)
-- to report a non-default collation explicitly (e.g. "C") while
-- reporting the default collation as empty, so a collation change in
-- EITHER direction changes the fingerprint.
--
-- EXACT-STATE PRINCIPLE: this fingerprint change is not a best-effort
-- widening -- it is exhaustive by construction (aclexplode over the
-- real ACL; every information_schema.columns field relevant to the
-- table's on-disk definition) rather than an enumerated whitelist, so
-- no future privilege type, grantee, or column-level engine state can
-- silently bypass it the way a hardcoded list could.
--
-- OWNER-ROLE CAVEAT (disclosed, not hidden): because aclexplode()
-- includes the table/function OWNER's own implicit full privilege
-- grant as an explicit row, the captured fingerprint below is tied to
-- the exact owner role name in the environment where it was captured
-- (this sandbox's local test database, owned by role "postgres").
-- If the Foundation is ever installed in an environment where the
-- owning role has a different name (e.g. a managed Postgres
-- platform's own migration role), this guard will correctly REFUSE
-- rather than silently proceed -- exactly the same fail-closed
-- behavior already documented for the function-body guards against
-- a PostgreSQL version whose pg_get_functiondef formatting differs.
-- A human must re-capture and re-embed the fingerprint for the exact
-- target environment before relying on this guard there. This is the
-- same caveat category as the PostgreSQL 16-vs-17 formatting note in
-- ROLLBACK-DRIFT-GUARD-EVIDENCE.md, not a new kind of risk.
--
-- ============================================================
-- v1.3 ADDENDUM -- Catimini's re-audit of v1.2 confirmed every prior
-- gate CLOSED/PASS (function guard, column exact-schema, collation,
-- constraints, indexes, RLS state, policy permissiveness/definition,
-- relation+function grant exhaustiveness, atomicity) and found
-- exactly ONE remaining HIGH: the grant fingerprint covered relation
-- ACLs (pg_class.relacl) and function ACLs (pg_proc.proacl) but not
-- COLUMN ACLs (pg_attribute.attacl) -- so a later
-- `GRANT SELECT (contact_email) ON ... TO some_role` would have been
-- invisible and the rollback could have destroyed that later
-- legitimate privilege state.
--
-- FIXED: the fingerprint below now also explodes
-- pg_attribute.attacl for every live (non-dropped) user column of
-- order_invoice_request, via the identical aclexplode() technique
-- already used for the table and both functions -- no hardcoded
-- role, privilege, or COLUMN whitelist. Falls back to
-- acldefault('c', <table owner>) when a column's attacl is NULL.
-- Verified empirically (not assumed) on a probe table: with no
-- column-level grant, acldefault('c', owner) explodes to ZERO rows
-- (column ACLs, unlike relation/function ACLs, do NOT default the
-- owner into an implicit row) -- so the Foundation's current
-- known-good state contributes zero GRANT_COLUMN rows to the
-- fingerprint, and the embedded expected fingerprint text is
-- therefore UNCHANGED from v1.2 (re-verified by direct capture
-- against the real Foundation to be byte-identical to the v1.2
-- value). The moment ANY column-level grant is added, a GRANT_COLUMN
-- row appears and the fingerprint changes -- proven in
-- ROLLBACK-DRIFT-GUARD-EVIDENCE.md via SELECT/UPDATE/REFERENCES
-- column grants to a genuinely arbitrary, locally-created synthetic
-- role never seen anywhere else in this fingerprint or guard.
-- ============================================================
begin;

do $rollback_guard$
declare
  v_set_def          text;
  v_get_def          text;
  v_fingerprint      text;
  v_expected_fingerprint text;
begin
  -- ---- existence checks (nothing to roll back / partial state) ----
  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request does not exist -- nothing to roll back.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'set_order_invoice_request' and pronargs = 12) then
    raise exception 'SCANYM_SCHEMA_DRIFT: set_order_invoice_request (12-arg) does not exist -- refusing to proceed with a partial rollback.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'get_order_invoice_request' and pronargs = 2) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_order_invoice_request (2-arg) does not exist -- refusing to proceed with a partial rollback.';
  end if;

  -- ---- BLOCKER 1 FIX: exact function-definition drift guard ----
  select btrim(pg_get_functiondef(oid), E' \t\n\r') into v_set_def
  from pg_proc where proname = 'set_order_invoice_request' and pronargs = 12;

  if v_set_def <> btrim($qq_expected_foundation_set$CREATE OR REPLACE FUNCTION public.set_order_invoice_request(p_order_id uuid, p_public_token uuid, p_invoice_type text, p_address_line_1 text, p_city text, p_postal_code text, p_country text, p_address_line_2 text DEFAULT NULL::text, p_company_legal_name text DEFAULT NULL::text, p_vat_number text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, invoice_type text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- FOUNDATION v1: LENGTH-ONLY check on contact_email, intentionally.
  -- No FORMAT check here -- this is the pre-Email-Validation-lot
  -- behavior, preserved exactly so this file matches what was
  -- actually git-merged and audited BEFORE the email lot. The format
  -- check is applied on top by the separate delta file.

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
$function$$qq_expected_foundation_set$, E' \t\n\r')
     and v_set_def <> btrim($qq_expected_delta_set$CREATE OR REPLACE FUNCTION public.set_order_invoice_request(p_order_id uuid, p_public_token uuid, p_invoice_type text, p_address_line_1 text, p_city text, p_postal_code text, p_country text, p_address_line_2 text DEFAULT NULL::text, p_company_legal_name text DEFAULT NULL::text, p_vat_number text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, invoice_type text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$$qq_expected_delta_set$, E' \t\n\r')
  then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: set_order_invoice_request current definition does not match either known-good state (FOUNDATION-only or FOUNDATION+EMAIL-DELTA) -- a later, unreviewed change may exist. Refusing to drop automatically. Manual review required.';
  end if;

  select btrim(pg_get_functiondef(oid), E' \t\n\r') into v_get_def
  from pg_proc where proname = 'get_order_invoice_request' and pronargs = 2;

  if v_get_def <> btrim($qq_expected_get_def$CREATE OR REPLACE FUNCTION public.get_order_invoice_request(p_order_id uuid, p_public_token uuid)
 RETURNS TABLE(invoice_type text, company_legal_name text, vat_number text, contact_name text, contact_email text, address_line_1 text, address_line_2 text, city text, postal_code text, country text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.public_token = p_public_token
  ) then
    raise exception 'SCANYM_INVOICE_REQUEST: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  return query
    select r.invoice_type, r.company_legal_name, r.vat_number,
           r.contact_name, r.contact_email,
           r.address_line_1, r.address_line_2, r.city, r.postal_code, r.country,
           r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$function$$qq_expected_get_def$, E' \t\n\r') then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: get_order_invoice_request current definition does not match the known-good state -- a later, unreviewed change may exist. Refusing to drop automatically. Manual review required.';
  end if;

  -- ---- BLOCKER 2 FIX (v1.1) + v1.2/v1.3 EXHAUSTIVENESS FIX: exact
  -- table/RLS/policy/grant fingerprint drift guard ----
  -- Covers, in one deterministic comparison: column data types,
  -- nullability, defaults, numeric/datetime precision, identity and
  -- generated-column state, collation, and domain identity; every
  -- constraint's exact definition (PK/FK/UNIQUE/CHECK); every
  -- index's exact definition; RLS enabled AND forced state; every
  -- policy's exact permissive/restrictive flag, command, roles,
  -- USING and WITH CHECK predicates; and the COMPLETE actual ACL --
  -- relation-level (pg_class.relacl), function-level
  -- (pg_proc.proacl), AND column-level (pg_attribute.attacl) -- every
  -- grantee, every privilege type, grantor, is_grantable -- on the
  -- table, on every live column, and on both RPCs, via aclexplode()
  -- -- never a hardcoded role, privilege-type, or column list.
  select string_agg(x, E'\n' order by x) into v_fingerprint from (
  select 'COL:' || lpad(ordinal_position::text,3,'0') || ':' || column_name || ':' || data_type || ':' || coalesce(udt_name,'') || ':' || coalesce(character_maximum_length::text,'') || ':' || coalesce(numeric_precision::text,'') || ':' || coalesce(numeric_scale::text,'') || ':' || coalesce(datetime_precision::text,'') || ':' || is_nullable || ':' || coalesce(column_default,'') || ':' || is_identity || ':' || coalesce(identity_generation,'') || ':' || is_generated || ':' || coalesce(generation_expression,'') || ':' || coalesce(collation_catalog,'') || ':' || coalesce(collation_schema,'') || ':' || coalesce(collation_name,'') || ':' || coalesce(domain_schema,'') || ':' || coalesce(domain_name,'') as x
  from information_schema.columns where table_schema='public' and table_name='order_invoice_request'
  union all
  select 'CONSTRAINT:' || conname || ':' || pg_get_constraintdef(oid)
  from pg_constraint where conrelid = 'public.order_invoice_request'::regclass
  union all
  select 'INDEX:' || indexname || ':' || indexdef
  from pg_indexes where schemaname='public' and tablename='order_invoice_request'
  union all
  select 'RLS:' || relrowsecurity::text || ':' || relforcerowsecurity::text
  from pg_class where oid = 'public.order_invoice_request'::regclass
  union all
  select 'POLICY:' || policyname || ':' || permissive || ':' || cmd || ':' || roles::text || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'')
  from pg_policies where schemaname='public' and tablename='order_invoice_request'
  union all
  select 'GRANT_TABLE:' || coalesce(nullif(a.grantee,0)::regrole::text, 'PUBLIC') || ':' || a.privilege_type || ':' || coalesce(a.grantor::regrole::text,'') || ':' || a.is_grantable::text
  from pg_class c
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where c.oid = 'public.order_invoice_request'::regclass
  union all
  select 'GRANT_COLUMN:' || att.attname || ':' || coalesce(nullif(g.grantee,0)::regrole::text, 'PUBLIC') || ':' || g.privilege_type || ':' || coalesce(g.grantor::regrole::text,'') || ':' || g.is_grantable::text
  from pg_attribute att
  cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid = att.attrelid)))) g
  where att.attrelid = 'public.order_invoice_request'::regclass and att.attnum > 0 and not att.attisdropped
  union all
  select 'GRANT_FUNC:set_order_invoice_request:' || coalesce(nullif(a.grantee,0)::regrole::text, 'PUBLIC') || ':' || a.privilege_type || ':' || coalesce(a.grantor::regrole::text,'') || ':' || a.is_grantable::text
  from pg_proc p
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.proname = 'set_order_invoice_request' and p.pronargs = 12
  union all
  select 'GRANT_FUNC:get_order_invoice_request:' || coalesce(nullif(a.grantee,0)::regrole::text, 'PUBLIC') || ':' || a.privilege_type || ':' || coalesce(a.grantor::regrole::text,'') || ':' || a.is_grantable::text
  from pg_proc p
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.proname = 'get_order_invoice_request' and p.pronargs = 2
) s;

  v_expected_fingerprint := btrim($qq_expected_fingerprint_v12$COL:001:order_id:uuid:uuid:::::NO::NO::NEVER::::::
COL:002:invoice_type:text:text:::::NO::NO::NEVER::::::
COL:003:company_legal_name:text:text:::::YES::NO::NEVER::::::
COL:004:vat_number:text:text:::::YES::NO::NEVER::::::
COL:005:contact_name:text:text:::::YES::NO::NEVER::::::
COL:006:contact_email:text:text:::::YES::NO::NEVER::::::
COL:007:address_line_1:text:text:::::NO::NO::NEVER::::::
COL:008:address_line_2:text:text:::::YES::NO::NEVER::::::
COL:009:city:text:text:::::NO::NO::NEVER::::::
COL:010:postal_code:text:text:::::NO::NO::NEVER::::::
COL:011:country:text:text:::::NO::NO::NEVER::::::
COL:012:created_at:timestamp with time zone:timestamptz::::6:NO:now():NO::NEVER::::::
COL:013:updated_at:timestamp with time zone:timestamptz::::6:NO:now():NO::NEVER::::::
CONSTRAINT:order_invoice_request_address_line_1_check:CHECK (((length(address_line_1) >= 1) AND (length(address_line_1) <= 50)))
CONSTRAINT:order_invoice_request_address_line_2_check:CHECK (((address_line_2 IS NULL) OR ((length(address_line_2) >= 1) AND (length(address_line_2) <= 50))))
CONSTRAINT:order_invoice_request_city_check:CHECK (((length(city) >= 1) AND (length(city) <= 50)))
CONSTRAINT:order_invoice_request_company_legal_name_check:CHECK (((company_legal_name IS NULL) OR ((length(company_legal_name) >= 1) AND (length(company_legal_name) <= 120))))
CONSTRAINT:order_invoice_request_company_requires_legal_name:CHECK (((invoice_type <> 'company'::text) OR (company_legal_name IS NOT NULL)))
CONSTRAINT:order_invoice_request_contact_email_check:CHECK (((contact_email IS NULL) OR ((length(contact_email) >= 1) AND (length(contact_email) <= 100))))
CONSTRAINT:order_invoice_request_contact_name_check:CHECK (((contact_name IS NULL) OR ((length(contact_name) >= 1) AND (length(contact_name) <= 45))))
CONSTRAINT:order_invoice_request_country_check:CHECK ((country ~ '^[A-Z]{2}$'::text))
CONSTRAINT:order_invoice_request_invoice_type_check:CHECK ((invoice_type = ANY (ARRAY['individual'::text, 'company'::text])))
CONSTRAINT:order_invoice_request_order_id_fkey:FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
CONSTRAINT:order_invoice_request_pkey:PRIMARY KEY (order_id)
CONSTRAINT:order_invoice_request_postal_code_check:CHECK (((length(postal_code) >= 1) AND (length(postal_code) <= 10)))
CONSTRAINT:order_invoice_request_vat_number_check:CHECK (((vat_number IS NULL) OR ((length(vat_number) >= 1) AND (length(vat_number) <= 30))))
GRANT_FUNC:get_order_invoice_request:postgres:EXECUTE:postgres:false
GRANT_FUNC:get_order_invoice_request:service_role:EXECUTE:postgres:false
GRANT_FUNC:set_order_invoice_request:postgres:EXECUTE:postgres:false
GRANT_FUNC:set_order_invoice_request:service_role:EXECUTE:postgres:false
GRANT_TABLE:authenticated:SELECT:postgres:false
GRANT_TABLE:postgres:DELETE:postgres:false
GRANT_TABLE:postgres:INSERT:postgres:false
GRANT_TABLE:postgres:REFERENCES:postgres:false
GRANT_TABLE:postgres:SELECT:postgres:false
GRANT_TABLE:postgres:TRIGGER:postgres:false
GRANT_TABLE:postgres:TRUNCATE:postgres:false
GRANT_TABLE:postgres:UPDATE:postgres:false
INDEX:order_invoice_request_pkey:CREATE UNIQUE INDEX order_invoice_request_pkey ON public.order_invoice_request USING btree (order_id)
POLICY:order_invoice_request_select_staff:PERMISSIVE:SELECT:{authenticated}:(EXISTS ( SELECT 1
   FROM (orders o
     JOIN restaurant_users ru ON ((ru.restaurant_id = o.restaurant_id)))
  WHERE ((o.id = order_invoice_request.order_id) AND (ru.user_id = auth.uid())))):
RLS:true:false$qq_expected_fingerprint_v12$, E' \t\n\r');

  if btrim(coalesce(v_fingerprint, ''), E' \t\n\r') <> v_expected_fingerprint then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: order_invoice_request schema/constraint/index/RLS/policy/grant fingerprint does not match the exact known-good state -- a later, unreviewed schema or security change may exist (column type/nullability/default, constraint, index, RLS forced-state, policy predicate/command/role, or grant). Refusing to drop automatically. Manual review required.';
  end if;
end $rollback_guard$;

-- ------------------------------------------------------------
-- Every guard above passed -- proceed. Dropping the table cascades
-- the RLS policy and every GRANT/REVOKE on it -- PostgreSQL removes
-- an object's own policies and privileges automatically when the
-- object itself is dropped; no separate DROP POLICY/REVOKE statement
-- exists or is needed.
-- ------------------------------------------------------------
drop function public.get_order_invoice_request(uuid, uuid);
drop function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text);
drop table public.order_invoice_request;

do $$
begin
  if to_regclass('public.order_invoice_request') is not null then
    raise exception 'SCANYM_ROLLBACK_FAILED: order_invoice_request still exists after DROP TABLE.';
  end if;
  if exists (select 1 from pg_proc where proname = 'set_order_invoice_request') then
    raise exception 'SCANYM_ROLLBACK_FAILED: set_order_invoice_request still exists after DROP FUNCTION.';
  end if;
  if exists (select 1 from pg_proc where proname = 'get_order_invoice_request') then
    raise exception 'SCANYM_ROLLBACK_FAILED: get_order_invoice_request still exists after DROP FUNCTION.';
  end if;
  -- Collateral-damage guard: prerequisites this foundation depended
  -- on, and never touched, must still be present.
  if to_regclass('public.orders') is null then
    raise exception 'SCANYM_ROLLBACK_COLLATERAL_DAMAGE: public.orders no longer exists -- this rollback must never touch orders.';
  end if;
end $$;

commit;
