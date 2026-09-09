-- ============================================================
-- Scanym — INVOICE REQUEST PRODUCTION ACL REMEDIATION v1
-- READ-ONLY PRODUCTION ACL SNAPSHOT
--
-- Purpose: capture the COMPLETE actual ACL state for
-- public.order_invoice_request (table, every user column) and both
-- Invoice Request RPCs, with zero mutation and zero data rows
-- returned. Intended to be run directly against Production by
-- someone with Production access (Catimini) BEFORE and AFTER
-- INVOICE-REQUEST-ACL-REMEDIATION.sql, to independently confirm the
-- actual drift and its correction. This session has no access to
-- real Production and has NOT run this file there -- see
-- PRODUCTION-ACL-STATE.md.
--
-- Safe to run at any time: read-only, no data rows, no schema
-- changes, no privilege changes.
-- ============================================================

-- ------------------------------------------------------------
-- [1] TABLE-LEVEL ACL — every (grantee, privilege, grantor,
-- grantability) row, including PostgreSQL 17 privileges such as
-- MAINTAIN, via aclexplode() (no privilege-type whitelist).
-- ------------------------------------------------------------
select
  'TABLE'                                                   as object_level,
  'public.order_invoice_request'                            as object_name,
  null::text                                                as column_name,
  coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC')   as grantee,
  coalesce(g.grantor::regrole::text, '')                    as grantor,
  g.privilege_type,
  g.is_grantable
from pg_class c
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) g
where c.oid = 'public.order_invoice_request'::regclass
order by grantee, privilege_type;

-- ------------------------------------------------------------
-- [2] COLUMN-LEVEL ACL — every live, non-dropped user column,
-- generically (no column named literally).
-- ------------------------------------------------------------
select
  'COLUMN'                                                  as object_level,
  'public.order_invoice_request'                            as object_name,
  att.attname                                               as column_name,
  coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC')   as grantee,
  coalesce(g.grantor::regrole::text, '')                    as grantor,
  g.privilege_type,
  g.is_grantable
from pg_attribute att
cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid = att.attrelid)))) g
where att.attrelid = 'public.order_invoice_request'::regclass
  and att.attnum > 0 and not att.attisdropped
order by column_name, grantee, privilege_type;

-- ------------------------------------------------------------
-- [3] FUNCTION-LEVEL ACL — set_order_invoice_request (identified
-- by name + exact argument count, never a hardcoded signature
-- string, matching the same technique already used by the
-- Foundation rollback's drift guard).
-- ------------------------------------------------------------
select
  'FUNCTION'                                                as object_level,
  p.oid::regprocedure::text                                 as object_name,
  null::text                                                as column_name,
  coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC')   as grantee,
  coalesce(g.grantor::regrole::text, '')                    as grantor,
  g.privilege_type,
  g.is_grantable
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
where p.proname = 'set_order_invoice_request' and p.pronargs = 12
order by grantee, privilege_type;

-- ------------------------------------------------------------
-- [4] FUNCTION-LEVEL ACL — get_order_invoice_request.
-- ------------------------------------------------------------
select
  'FUNCTION'                                                as object_level,
  p.oid::regprocedure::text                                 as object_name,
  null::text                                                as column_name,
  coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC')   as grantee,
  coalesce(g.grantor::regrole::text, '')                    as grantor,
  g.privilege_type,
  g.is_grantable
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
where p.proname = 'get_order_invoice_request' and p.pronargs = 2
order by grantee, privilege_type;

-- ------------------------------------------------------------
-- [5] OWNER identification — read-only, so the rows above can be
-- attributed to "owner's own implicit privilege" vs. "explicit
-- grant" without guessing the owning role's name.
-- ------------------------------------------------------------
select
  'public.order_invoice_request'::text as object_name,
  (select relowner::regrole::text from pg_class where oid = 'public.order_invoice_request'::regclass) as table_owner,
  (select proowner::regrole::text from pg_proc where proname = 'set_order_invoice_request' and pronargs = 12) as set_fn_owner,
  (select proowner::regrole::text from pg_proc where proname = 'get_order_invoice_request' and pronargs = 2) as get_fn_owner;

-- ------------------------------------------------------------
-- [6] DIAGNOSTIC ONLY, NOT REQUIRED — schema-level default ACLs
-- for schema `public`, to help determine whether the drift is
-- explained by ALTER DEFAULT PRIVILEGES (CONFIRMED) vs. some other
-- Production-side mechanism (SUSPECTED/UNKNOWN). Read-only; reports
-- default-ACL metadata, never touches it.
-- ------------------------------------------------------------
select
  pg_get_userbyid(d.defaclrole)                             as defacl_role,
  n.nspname                                                 as defacl_schema,
  d.defaclobjtype,
  coalesce(nullif(g.grantee, 0)::regrole::text, 'PUBLIC')   as grantee,
  g.privilege_type
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) g
where n.nspname = 'public'
order by defacl_role, defaclobjtype, grantee, privilege_type;

-- ------------------------------------------------------------
-- [7] RLS / policy sanity (read-only cross-check, no data rows) —
-- confirms the security MODEL itself (as opposed to grants) is
-- still exactly the audited one before any remediation is applied.
-- ------------------------------------------------------------
select
  relrowsecurity, relforcerowsecurity
from pg_class where oid = 'public.order_invoice_request'::regclass;

select
  policyname, permissive, cmd, roles
from pg_policies where schemaname = 'public' and tablename = 'order_invoice_request';
