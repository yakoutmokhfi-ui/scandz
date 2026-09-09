-- ============================================================
-- Scanym — INVOICE REQUEST PRODUCTION ACL REMEDIATION v1
-- (DRAFT — NOT YET APPLIED IN PRODUCTION)
--
-- INVOICE REQUEST PRODUCTION PREREQUISITE GAP — Claude Monet.
--
-- WHY THIS FILE EXISTS
-- ------------------------------------------------------------
-- Catimini's post-install security gate on the just-installed
-- Foundation (main @ af448e800b4dafebe90b96e895e9aed1bd6db01e /
-- tree 0e5019d9a54c8e1ee3c6fa12b699f58bc8ce140e) reported FAIL on
-- GRANTS: Production PostgreSQL 17's effective default privileges
-- left `public.order_invoice_request` with unexpected effective
-- table privileges (at minimum TRUNCATE, REFERENCES, TRIGGER,
-- MAINTAIN) for roles including anon, authenticated, and
-- service_role -- privileges the audited Foundation contract never
-- intended for any of those roles (see AUDITED-EXPECTED-ACL.md /
-- RLS-GRANTS-MATRIX.md: authenticated gets SELECT only, gated by
-- RLS; anon and service_role get nothing at the table level at
-- all). The table, RLS, policies, and both RPCs' definitions and
-- EXECUTE grants were all independently confirmed unaffected -- this
-- is an ACL-only drift, most likely caused by a schema-level
-- ALTER DEFAULT PRIVILEGES (or equivalent Production-side default)
-- applying broader-than-audited grants to newly created tables --
-- see ACL-DIFF.md for the full reasoning and its CONFIRMED/SUSPECTED
-- classification.
--
-- SCOPE, PER THE EXPLICIT MANDATE FOR THIS LOT
-- ------------------------------------------------------------
-- This file touches ONLY privileges (GRANT/REVOKE) on the ALREADY
-- CREATED `public.order_invoice_request` table, its user columns,
-- and the two existing Invoice Request RPCs. It does NOT:
--   - drop, recreate, or alter the table's schema, constraints,
--     or indexes;
--   - touch RLS enabled/forced state or any policy;
--   - touch either function's body, language, security mode, or
--     search_path;
--   - modify any schema- or database-level ALTER DEFAULT PRIVILEGES
--     (even if that is the root cause -- see ACL-DIFF.md: changing
--     global default-privilege behavior is a broader Production
--     governance decision explicitly out of scope for this lot;
--     object-level remediation was independently proven sufficient
--     to correct THIS already-created object, both here and in the
--     local convergence tests in
--     invoice-request-production-acl-remediation-v1-check.sh).
--   - install the Email Validation Delta (explicitly deferred until
--     after this gate passes and a fresh CIO GO).
--
-- HOW IT WORKS -- GENERIC, NOT A HARDCODED PRIVILEGE/ROLE LIST
-- ------------------------------------------------------------
-- Rather than hardcoding "REVOKE TRUNCATE, REFERENCES, TRIGGER,
-- MAINTAIN FROM anon, authenticated, service_role" (which would
-- silently miss any OTHER unexpected privilege/role PostgreSQL 17 --
-- or a future PostgreSQL version -- might also have produced), this
-- script:
--   1. Expands the ACTUAL current ACL for the table (pg_class.relacl),
--      every live user column (pg_attribute.attacl), and both RPCs
--      (pg_proc.proacl) via aclexplode() -- the same non-whitelisted
--      technique already proven in the Foundation rollback's v1.2/
--      v1.3 fingerprint guard.
--   2. Classifies each individual (grantee, privilege_type) row as
--      EXPECTED only if it is the object's own owner (discovered
--      dynamically via relowner/proowner -- never hardcoded as
--      "postgres", since Production's owning role name is not
--      assumed) or the two explicit grants the audited Foundation
--      SQL itself makes (authenticated:SELECT on the table;
--      service_role:EXECUTE on each RPC). Every other row --
--      regardless of which privilege type or which role it names --
--      is UNEXPECTED and is REVOKED, individually, by an explicit
--      `revoke <privilege> on ... from <role>` statement generated
--      from the row itself (never a blanket `revoke all`).
--   3. Re-expands the ACL after all revokes and RAISES an exception
--      (aborting the whole transaction, leaving Production
--      untouched) if ANY unexpected row still remains -- fail
--      closed, exactly like the rollback guard, rather than
--      reporting partial success.
-- No column, in particular, is ever named literally: the column loop
-- iterates every live, non-dropped user column of the table
-- generically, so it also covers any column added after this file
-- was written.
--
-- WHAT THIS FILE DOES NOT DO
-- ------------------------------------------------------------
-- It does not run itself against Production. It is not applied,
-- installed, or executed against Production by Claude Monet under
-- this lot's governance. It is proven, end-to-end, against a real,
-- disposable local PostgreSQL instance with the EXACT reported drift
-- pattern deliberately reproduced first (see
-- ROLLBACK-CLASSIFICATION.md and TEST-RESULTS.md for why a rollback
-- of the remediation itself is classified MANUAL ONLY / NOT
-- RECOMMENDED, never automatic).
-- ============================================================

begin;

do $acl_remediation_guard$
declare
  v_table_owner       text;
  v_set_fn_oid        oid;
  v_get_fn_oid        oid;
  v_set_fn_owner      text;
  v_get_fn_owner      text;
  v_grantee           text;
  v_grantee_sql       text;
  v_privilege         text;
  v_column            text;
  v_revoked_count     int := 0;
  v_residual_count    int;
  r                   record;
begin
  -- ----------------------------------------------------------
  -- Existence preconditions -- fail closed if the object graph
  -- this remediation targets is not exactly what it expects.
  -- ----------------------------------------------------------
  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: public.order_invoice_request does not exist -- aborting, nothing changed.';
  end if;

  select oid into v_set_fn_oid from pg_proc where proname = 'set_order_invoice_request' and pronargs = 12;
  if v_set_fn_oid is null then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: set_order_invoice_request(12 args) not found -- aborting, nothing changed.';
  end if;

  select oid into v_get_fn_oid from pg_proc where proname = 'get_order_invoice_request' and pronargs = 2;
  if v_get_fn_oid is null then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: get_order_invoice_request(2 args) not found -- aborting, nothing changed.';
  end if;

  -- Sanity: RLS must already be enabled and exactly one policy must
  -- exist -- this remediation assumes, and never re-verifies beyond
  -- this cheap check, that the security MODEL itself is intact
  -- (Catimini already independently confirmed RLS/POLICIES: PASS).
  -- This is a belt-and-suspenders precondition, not a redundant
  -- redesign of that check.
  if not exists (
    select 1 from pg_class where oid = 'public.order_invoice_request'::regclass and relrowsecurity
  ) then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: RLS is not enabled on public.order_invoice_request -- aborting, refusing to touch grants on a table whose RLS state is not the expected one.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'order_invoice_request') <> 1 then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: expected exactly 1 policy on public.order_invoice_request, found %  -- aborting.', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'order_invoice_request');
  end if;

  -- Dynamic owner discovery -- never hardcoded.
  select relowner::regrole::text into v_table_owner from pg_class where oid = 'public.order_invoice_request'::regclass;
  select proowner::regrole::text into v_set_fn_owner from pg_proc where oid = v_set_fn_oid;
  select proowner::regrole::text into v_get_fn_owner from pg_proc where oid = v_get_fn_oid;

  -- ----------------------------------------------------------
  -- TABLE-LEVEL: revoke every ACL row that is not the owner's own
  -- implicit privilege and not the single audited explicit grant
  -- (authenticated:SELECT).
  -- ----------------------------------------------------------
  for r in
    select coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') as grantee, g.privilege_type
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) g
    where c.oid = 'public.order_invoice_request'::regclass
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_table_owner
      and not (coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') = 'authenticated' and g.privilege_type = 'SELECT')
  loop
    v_grantee_sql := case when r.grantee = 'PUBLIC' then 'PUBLIC' else quote_ident(r.grantee) end;
    execute format('revoke %s on table public.order_invoice_request from %s', r.privilege_type, v_grantee_sql);
    v_revoked_count := v_revoked_count + 1;
    raise notice 'SCANYM_ACL_REMEDIATION: revoked table-level % from % (unexpected -- not owner, not the audited authenticated:SELECT grant)', r.privilege_type, r.grantee;
  end loop;

  -- ----------------------------------------------------------
  -- COLUMN-LEVEL: the audited contract grants NO column-level
  -- privilege to anyone (table-level SELECT for `authenticated`
  -- already covers every column) -- so ANY column ACL row that is
  -- not the owner's own implicit privilege is unexpected. Iterates
  -- every live, non-dropped user column generically -- no column
  -- named literally.
  -- ----------------------------------------------------------
  for r in
    select att.attname as colname,
           coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') as grantee,
           g.privilege_type
    from pg_attribute att
    cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid = att.attrelid)))) g
    where att.attrelid = 'public.order_invoice_request'::regclass
      and att.attnum > 0 and not att.attisdropped
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_table_owner
  loop
    v_grantee_sql := case when r.grantee = 'PUBLIC' then 'PUBLIC' else quote_ident(r.grantee) end;
    execute format('revoke %s (%I) on table public.order_invoice_request from %s', r.privilege_type, r.colname, v_grantee_sql);
    v_revoked_count := v_revoked_count + 1;
    raise notice 'SCANYM_ACL_REMEDIATION: revoked column-level % (%) from % (unexpected -- audited contract grants zero column-level privileges to anyone)', r.privilege_type, r.colname, r.grantee;
  end loop;

  -- ----------------------------------------------------------
  -- FUNCTION-LEVEL: set_order_invoice_request -- only
  -- service_role:EXECUTE and the owner's own implicit grant are
  -- expected.
  -- ----------------------------------------------------------
  for r in
    select coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') as grantee, g.privilege_type
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
    where p.oid = v_set_fn_oid
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_set_fn_owner
      and not (coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') = 'service_role' and g.privilege_type = 'EXECUTE')
  loop
    v_grantee_sql := case when r.grantee = 'PUBLIC' then 'PUBLIC' else quote_ident(r.grantee) end;
    execute format('revoke %s on function %s from %s', r.privilege_type, v_set_fn_oid::regprocedure::text, v_grantee_sql);
    v_revoked_count := v_revoked_count + 1;
    raise notice 'SCANYM_ACL_REMEDIATION: revoked function-level % on set_order_invoice_request from % (unexpected)', r.privilege_type, r.grantee;
  end loop;

  -- ----------------------------------------------------------
  -- FUNCTION-LEVEL: get_order_invoice_request -- same rule.
  -- ----------------------------------------------------------
  for r in
    select coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') as grantee, g.privilege_type
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
    where p.oid = v_get_fn_oid
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_get_fn_owner
      and not (coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') = 'service_role' and g.privilege_type = 'EXECUTE')
  loop
    v_grantee_sql := case when r.grantee = 'PUBLIC' then 'PUBLIC' else quote_ident(r.grantee) end;
    execute format('revoke %s on function %s from %s', r.privilege_type, v_get_fn_oid::regprocedure::text, v_grantee_sql);
    v_revoked_count := v_revoked_count + 1;
    raise notice 'SCANYM_ACL_REMEDIATION: revoked function-level % on get_order_invoice_request from % (unexpected)', r.privilege_type, r.grantee;
  end loop;

  raise notice 'SCANYM_ACL_REMEDIATION: % unexpected ACL row(s) revoked in total', v_revoked_count;

  -- ----------------------------------------------------------
  -- CONVERGENCE CHECK -- fail closed if anything unexpected
  -- remains anywhere, rather than reporting partial success.
  -- ----------------------------------------------------------
  select count(*) into v_residual_count from (
    select 1
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) g
    where c.oid = 'public.order_invoice_request'::regclass
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_table_owner
      and not (coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') = 'authenticated' and g.privilege_type = 'SELECT')
    union all
    select 1
    from pg_attribute att
    cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid = att.attrelid)))) g
    where att.attrelid = 'public.order_invoice_request'::regclass
      and att.attnum > 0 and not att.attisdropped
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_table_owner
    union all
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
    where p.oid = v_set_fn_oid
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_set_fn_owner
      and not (coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') = 'service_role' and g.privilege_type = 'EXECUTE')
    union all
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
    where p.oid = v_get_fn_oid
      and coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') <> v_get_fn_owner
      and not (coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC') = 'service_role' and g.privilege_type = 'EXECUTE')
  ) residual;

  if v_residual_count <> 0 then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: % unexpected ACL row(s) still remain after remediation -- aborting the whole transaction, Production would be left untouched if this were run for real.', v_residual_count;
  end if;

  -- ----------------------------------------------------------
  -- Belt-and-suspenders: the two audited grants must still be
  -- PRESENT (this remediation must never have accidentally revoked
  -- a legitimate privilege along the way).
  -- ----------------------------------------------------------
  if not has_table_privilege('authenticated', 'public.order_invoice_request', 'select') then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: authenticated lost its audited SELECT privilege -- aborting.';
  end if;
  if not has_function_privilege('service_role', v_set_fn_oid, 'execute') then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: service_role lost its audited EXECUTE privilege on set_order_invoice_request -- aborting.';
  end if;
  if not has_function_privilege('service_role', v_get_fn_oid, 'execute') then
    raise exception 'SCANYM_ACL_REMEDIATION_GUARD: service_role lost its audited EXECUTE privilege on get_order_invoice_request -- aborting.';
  end if;

  raise notice 'SCANYM_ACL_REMEDIATION: convergence confirmed -- table/column/function ACLs now match the audited Foundation contract exactly, and both audited grants remain present.';
end
$acl_remediation_guard$;

commit;
