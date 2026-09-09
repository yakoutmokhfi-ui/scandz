-- ============================================================
-- Scanym — INVOICE REQUEST PRODUCTION PREREQUISITE GAP — Claude Monet
-- PRODUCTION READ-ONLY PRECHECK
--
-- THIS SCRIPT WAS NEVER RUN AGAINST REAL PRODUCTION BY THIS SESSION.
-- This sandboxed development environment holds no Production
-- Supabase credentials, no Production network path, and no
-- Supabase MCP connector -- there was no way to execute this
-- against the real database, and none was invented. This script is
-- prepared so that whoever DOES have Production read access (the
-- CIO, an operator with the Supabase SQL editor, or a future session
-- with real credentials) can run it in one step and get exactly the
-- fields the mandate's Step 2 asked for.
--
-- READ-ONLY: every statement below is a SELECT. Nothing here
-- creates, alters, drops, inserts, updates, or deletes anything.
-- Safe to run directly against Production via the Supabase SQL
-- editor or `psql --set ON_ERROR_STOP=1 -f this-file.sql`.
--
-- Run this BEFORE installing DRAFT-lot-invoice-request-foundation-v1.sql
-- or DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql
-- against Production, to confirm the actual starting state matches
-- what this package assumes (table/functions/RLS/grants entirely
-- ABSENT).
-- ============================================================

select '--- TABLE: public.order_invoice_request ---' as section;
select
  case when to_regclass('public.order_invoice_request') is null then 'MISSING' else 'EXISTS' end as table_state;

select '--- COLUMNS (only meaningful if table EXISTS above) ---' as section;
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'order_invoice_request'
order by ordinal_position;

select '--- INDEXES ---' as section;
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'order_invoice_request';

select '--- CONSTRAINTS ---' as section;
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = to_regclass('public.order_invoice_request');

select '--- RLS ENABLED ---' as section;
select
  case when to_regclass('public.order_invoice_request') is null then 'N/A (table missing)'
       when (select relrowsecurity from pg_class where relname = 'order_invoice_request') then 'YES'
       else 'NO' end as rls_state;

select '--- POLICIES ---' as section;
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where tablename = 'order_invoice_request';

select '--- TABLE GRANTS (anon / authenticated / service_role) ---' as section;
select
  'anon'          as role, 'select' as privilege, has_table_privilege('anon', 'public.order_invoice_request', 'select') as granted
where to_regclass('public.order_invoice_request') is not null
union all select 'anon', 'insert', has_table_privilege('anon', 'public.order_invoice_request', 'insert') where to_regclass('public.order_invoice_request') is not null
union all select 'authenticated', 'select', has_table_privilege('authenticated', 'public.order_invoice_request', 'select') where to_regclass('public.order_invoice_request') is not null
union all select 'authenticated', 'insert', has_table_privilege('authenticated', 'public.order_invoice_request', 'insert') where to_regclass('public.order_invoice_request') is not null
union all select 'service_role', 'select', has_table_privilege('service_role', 'public.order_invoice_request', 'select') where to_regclass('public.order_invoice_request') is not null
union all select 'service_role', 'insert', has_table_privilege('service_role', 'public.order_invoice_request', 'insert') where to_regclass('public.order_invoice_request') is not null;

select '--- RPC: public.set_order_invoice_request ---' as section;
select
  case when not exists (select 1 from pg_proc where proname = 'set_order_invoice_request') then 'MISSING'
       else 'EXISTS' end as function_state;
select pg_get_functiondef(oid) as function_signature_and_body
from pg_proc where proname = 'set_order_invoice_request';
select
  'anon' as role, has_function_privilege('anon', oid, 'execute') as can_execute
from pg_proc where proname = 'set_order_invoice_request'
union all
select 'authenticated', has_function_privilege('authenticated', oid, 'execute')
from pg_proc where proname = 'set_order_invoice_request'
union all
select 'service_role', has_function_privilege('service_role', oid, 'execute')
from pg_proc where proname = 'set_order_invoice_request';

select '--- RPC: public.get_order_invoice_request ---' as section;
select
  case when not exists (select 1 from pg_proc where proname = 'get_order_invoice_request') then 'MISSING'
       else 'EXISTS' end as function_state;
select pg_get_functiondef(oid) as function_signature_and_body
from pg_proc where proname = 'get_order_invoice_request';
select
  'anon' as role, has_function_privilege('anon', oid, 'execute') as can_execute
from pg_proc where proname = 'get_order_invoice_request'
union all
select 'authenticated', has_function_privilege('authenticated', oid, 'execute')
from pg_proc where proname = 'get_order_invoice_request'
union all
select 'service_role', has_function_privilege('service_role', oid, 'execute')
from pg_proc where proname = 'get_order_invoice_request';

select '--- PREREQUISITES this lot depends on (must already exist) ---' as section;
select
  case when to_regclass('public.orders') is null then 'MISSING' else 'EXISTS' end as orders_table,
  case when not exists (select 1 from pg_proc where proname = 'create_order') then 'MISSING' else 'EXISTS' end as create_order_function,
  case when to_regclass('public.restaurant_users') is null then 'MISSING' else 'EXISTS' end as restaurant_users_table;

-- No customer data, no secrets, and no row from any business table
-- is selected anywhere in this script -- every query above reads
-- only catalog/metadata (information_schema, pg_catalog, pg_policies,
-- has_table_privilege/has_function_privilege) or the DDL of the two
-- specific functions this lot concerns. Nothing here can leak a
-- customer's name, email, address, order content, or any secret.
