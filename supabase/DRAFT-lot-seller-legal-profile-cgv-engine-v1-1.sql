-- =============================================================================
-- SCANYM — SELLER LEGAL PROFILE + CGV ENGINE + ACCEPTANCE SNAPSHOT v1.1
-- AUDIT REMEDIATION CYCLE 2 (Catimini, FAIL — 2 HIGH blockers) —
-- RECONSTRUCTED FROM SCRATCH ON THE NEW AUTHORITATIVE BASELINE, NOT A
-- SILENT REBASE OF THE OLD v1 CANDIDATE.
--
-- New baseline : 5a9e6aa300e5e2b3a7f50439f6760d04585ee382 /
--                 TREE 040ba361a75cd8ef7db37add957478088246867c
--                 (main after Stuart LOT D1 v1.2 publication)
-- Superseded baseline (v1, never applied to Production) :
--                 77e37cfda843ba5f91349519643beaa969f3e532 /
--                 TREE 1c635a22d26c7c7c6eee35bef31aa5c07afb23e1
--
-- Confirmed: none of the 17 files that changed on main between the two
-- baselines (Stuart LOT D1 v1.2 — see COLLISION-CHECK.md) touch
-- create_order, or any name introduced by this lot. The inherited
-- create_order body (DRAFT-lot-receipt-invoice-tax-detail-v1.sql,
-- still the true final pre-lot definition — re-verified by the same
-- chronological-redefinition method used in v1, see README-AUDIT.md)
-- is byte-identical on both baselines (sha256 confirmed). Stuart D1
-- content is therefore preserved untouched by construction — this
-- migration adds nothing to, and removes nothing from, any Stuart
-- table/function/file.
--
-- Additive only, additional-parameter-only change to create_order
-- (existing 7-arg signature untouched, new 8th arg defaulted false).
-- NO Production execution. Candidate package only.
--
-- SCOPE NOTE (Section E, fulfillment routing ambiguity): this lot does
-- NOT read/depend on restaurant_sale_mode_fulfillments or any
-- fulfillment-derived clause. It uses ONLY restaurants.country,
-- merchant_legal_profile and merchant_cgv_profile — already-proven
-- merchant configuration, per mandate's own fallback instruction.
--
-- HASH ALGORITHM NOTE: pgcrypto is NOT proven active on this project
-- (see DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql,
-- DRAFT-lot-stuart-sandbox-integration-v2-1.sql — both explicitly
-- avoid introducing it; supabase/schema.sql line 9 keeps
-- `create extension pgcrypto` commented out). This lot follows the
-- same discipline: content_hash uses `md5()`, a PostgreSQL built-in
-- requiring no extension. "Deterministic content hash" (mandate K) is
-- satisfied — the algorithm itself is not mandated — and the hash is
-- ALWAYS computed by the SECURITY DEFINER function from the exact
-- content string it receives, never accepted as a value from a
-- caller (closes test-matrix #20, "browser cannot forge content_hash").
--
-- =============================================================================
-- v1.1 — BLOCKER 1 (CGV-V1-PUBLISH-AUTHORITY-01, HIGH) — REMEDIATED
-- =============================================================================
-- v1's `publish_merchant_cgv_version(p_restaurant_id, p_template_id,
-- p_locale, p_presentation_variant, p_rendered_content)` accepted
-- `p_rendered_content` directly from an authenticated browser caller —
-- the DB only checked non-emptiness and hashed whatever string it was
-- given. The browser was therefore the authority over the published
-- CGV body later rendered via `dangerouslySetInnerHTML`
-- (app/legal/[slug]/page.tsx). REMOVED ENTIRELY — no function of that
-- name/signature exists after this migration. Replaced by a two-part,
-- server-authoritative publication path:
--
--   1. public.resolve_cgv_publication_context(p_restaurant_id) —
--      SECURITY DEFINER, callable by `authenticated` only (assert_
--      legal_cgv_role — write authority, same as before). Takes NO
--      parameter beyond the restaurant id — no template_id, no locale,
--      no presentation_variant, no content of any kind. Independently
--      resolves and returns EVERY input the deterministic renderer
--      needs, entirely from already-role-gated, already-validated
--      server state (restaurants.name, merchant_legal_profile,
--      merchant_cgv_profile, and the applicable cgv_template row —
--      country + business_scope + latest PUBLISHED, fail-closed via
--      the pre-existing TEMPLATE_UNRESOLVED completeness code if no
--      unambiguous match exists). Called by the new server-only route
--      (app/api/dashboard/legal-cgv/publish/route.ts via
--      lib/server/legal-cgv-publish-service.ts) using the CALLER's own
--      access token (lib/server/supabase-as-user.ts — the exact
--      established as-user pattern already used by
--      lib/server/product-photo-service.ts), never a secret.
--
--   2. public.persist_merchant_cgv_version(p_restaurant_id,
--      p_template_id, p_rendered_content) — SECURITY DEFINER, EXECUTE
--      REVOKED from PUBLIC/anon/authenticated, GRANTED ONLY to
--      service_role. Independently RE-PROVES template applicability
--      (re-runs the exact same country/business_scope/latest-PUBLISHED
--      resolution query and rejects a mismatched p_template_id — never
--      simply trusts the caller, even though the caller is now trusted
--      server code) and re-checks completeness before writing anything.
--      Computes content_hash itself via md5() over the exact string it
--      receives — NEVER accepts or trusts a caller-supplied hash (same
--      discipline as v1, now doubly enforced since this function is
--      also unreachable by any untrusted caller at all).
--
-- The actual HTML rendering (lib/legal/render.ts — the SAME
-- deterministic renderer used for the merchant dashboard's own advisory
-- preview, never a second/divergent implementation) happens in Node,
-- server-side, inside lib/server/legal-cgv-publish-service.ts, between
-- steps 1 and 2 — the browser never transmits rendered HTML, a
-- template id, a locale, a presentation variant, or a content hash to
-- any part of the publication authority. See README-AUDIT.md section
-- "Blocker 1 remediation" for the full trust-boundary diagram.
--
-- =============================================================================
-- v1.1 — BLOCKER 2 (CGV-V1-PROD-ACL-01, HIGH) — REMEDIATED
-- =============================================================================
-- Catimini's read-only Production preflight found unexpected default
-- table privileges (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — the
-- latter PG17+, matching the confirmed Production version 17.6) already
-- inherited by authenticated/service_role on this project, most likely
-- via a project-level `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
-- TABLES TO ...` predating this lot. v1's per-table ACL statements were
-- purely ADDITIVE (`grant select ... to authenticated`) — additive
-- grants never strip an already-inherited excess privilege. Concretely:
-- RLS (enabled, SELECT-policy-only on every new table) already blocks
-- INSERT/UPDATE/DELETE without a matching policy, but RLS does NOT
-- govern TRUNCATE at all — an authenticated role with an inherited
-- TRUNCATE grant could wipe an entire immutable table (merchant_cgv_
-- version, order_cgv_acceptance) with zero row-level check, regardless
-- of any policy. This is the real HIGH-severity defect, not merely a
-- theoretical ACL nicety.
--
-- Fixed: every new table now does, in this exact order, immediately
-- after `enable row level security`: `revoke all privileges ... from
-- public/anon/authenticated/service_role` (all four, individually,
-- converging from ANY inherited state — unknown or not), THEN grants
-- back only the exact minimum (SELECT to authenticated where a read
-- policy exists; nothing at all to anon; nothing at all directly to
-- service_role — every service_role-driven write in this lot goes
-- through a SECURITY DEFINER function owned by the migration role,
-- which does not need or receive its own direct table grant).
-- `revoke all privileges` / `grant ... on tables` (never an enumerated
-- privilege list) is deliberately version-portable: it closes MAINTAIN
-- on a real PostgreSQL 17 Production server without this file
-- containing any PG17-specific syntax, and is a no-op for a privilege
-- type (MAINTAIN) that does not exist at all on a PostgreSQL 16 local
-- harness (see TEST-RESULTS.md for the exact convergence assertions
-- and the explicit PG16/PG17 caveat).
-- =============================================================================

do $$
begin
  -- 0a. PRE-FLIGHT SCHEMA DRIFT GUARD — expected new objects absent.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'merchant_legal_profile', 'cgv_template', 'merchant_cgv_profile',
        'merchant_cgv_version', 'order_cgv_acceptance'
      )
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: a Seller Legal Profile / CGV table already exists — migration aborted.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assert_legal_cgv_role', 'assert_legal_cgv_read_access',
        'cgv_completeness_errors', 'get_applicable_cgv_template',
        'get_merchant_legal_profile',
        'update_merchant_legal_profile', 'get_merchant_cgv_profile',
        'update_merchant_cgv_profile',
        'resolve_cgv_publication_context', 'persist_merchant_cgv_version',
        'activate_merchant_cgv', 'get_restaurant_public_cgv',
        'get_restaurant_cgv_version_by_id'
      )
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: a Seller Legal Profile / CGV RPC already exists — migration aborted.';
  end if;

  -- 0b. Expected prerequisites present (fail closed rather than guess).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
  ) then
    raise exception 'SCANYM_PREREQUISITE_MISSING: public.is_scanym_operator() not found.';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'scanym_supported_countries'
  ) then
    raise exception 'SCANYM_PREREQUISITE_MISSING: public.scanym_supported_countries not found.';
  end if;
end $$;

begin;

-- =============================================================================
-- A. merchant_legal_profile — Section B. Reuses nothing from
--    receipt_settings (dedicated table, per mandate's own preference
--    when extending receipt_settings would create unrelated coupling:
--    receipt/invoice identity vs. CGV/legal-mediation identity serve
--    different consumers and different lifecycles). Does NOT
--    duplicate business_name/legal_name/legal_address/phone/email/
--    tax_identifier/registration_number — those stay authoritative in
--    receipt_settings and are read from there where still relevant
--    (see get_merchant_legal_profile).
-- =============================================================================
create table if not exists public.merchant_legal_profile (
  restaurant_id            uuid primary key references public.restaurants(id) on delete cascade,
  legal_form               text,
  address_line1            text,
  address_line2            text,
  postal_code              text,
  city                     text,
  -- Basis for the applicable governing-law/jurisdiction clause.
  -- References the SAME allowlist as restaurants.country (Section 0b
  -- prerequisite) — never a free-text jurisdiction string.
  governing_country         text references public.scanym_supported_countries(code),
  customer_service_email   text,
  customer_service_phone   text,
  consumer_mediator_name   text,
  consumer_mediator_address text,
  consumer_mediator_website text,
  updated_at               timestamptz not null default now()
);

alter table public.merchant_legal_profile enable row level security;
-- v1.1 Blocker 2 (CGV-V1-PROD-ACL-01) — converge from ANY inherited
-- Production default-privilege state (unknown to this migration) by
-- explicitly revoking from all four roles individually before granting
-- back only the minimum. `all privileges` (never an enumerated list)
-- so TRUNCATE/REFERENCES/TRIGGER/MAINTAIN are closed regardless of
-- PostgreSQL version — RLS alone does not govern TRUNCATE.
revoke all privileges on table public.merchant_legal_profile from public;
revoke all privileges on table public.merchant_legal_profile from anon;
revoke all privileges on table public.merchant_legal_profile from authenticated;
revoke all privileges on table public.merchant_legal_profile from service_role;
grant select on table public.merchant_legal_profile to authenticated;

drop policy if exists "restaurant members read legal profile" on public.merchant_legal_profile;
create policy "restaurant members read legal profile"
on public.merchant_legal_profile
for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = merchant_legal_profile.restaurant_id
  )
  or public.is_scanym_operator()
);

-- =============================================================================
-- B. cgv_template — Section F. Scanym-controlled, immutable once
--    published. Merchant cannot write to this table (no grant at all,
--    read only via SECURITY DEFINER RPCs when needed for rendering
--    context). `controlled_sections` holds the fixed legal-core
--    clause library (per withdrawal_regime value, mediator clause,
--    jurisdiction clause, etc.) — never merchant-editable free text.
-- =============================================================================
create table if not exists public.cgv_template (
  id                          uuid primary key default gen_random_uuid(),
  template_code               text not null,
  jurisdiction_country         text not null references public.scanym_supported_countries(code),
  business_scope               text not null default 'food_perishable_b2c',
  version                      integer not null,
  locale                       text not null default 'fr',
  status                       text not null default 'PUBLISHED' check (status in ('DRAFT', 'PUBLISHED')),
  -- Whether this template's rendered clause set requires mediator
  -- fields / a preparation-time clause to be resolvable (drives
  -- cgv_completeness_errors — Section I: "where required by template").
  requires_mediator            boolean not null default true,
  requires_preparation_clause  boolean not null default true,
  controlled_sections          jsonb not null,
  created_at                   timestamptz not null default now(),
  published_at                 timestamptz,
  unique (template_code, version)
);

alter table public.cgv_template enable row level security;
-- v1.1 Blocker 2 — same convergence discipline as every other new
-- table in this lot; cgv_template additionally receives ZERO grant
-- back to any of the four roles (not even SELECT) — access is only
-- ever through the SECURITY DEFINER RPCs below.
revoke all privileges on table public.cgv_template from public;
revoke all privileges on table public.cgv_template from anon;
revoke all privileges on table public.cgv_template from authenticated;
revoke all privileges on table public.cgv_template from service_role;
-- No policy created: default-deny. Access only through SECURITY
-- DEFINER RPCs below, which run as the function owner (same
-- established pattern as assert_receipt_settings_role and friends).

-- Seed exactly one canonical FR / food_perishable_b2c template — a
-- fixed clause library, not merchant-facing free text, not
-- AI-generated: authored here as ordinary delivered scaffolding
-- content, same as any other static copy shipped in a migration.
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 1, 'fr',
  'PUBLISHED', true, true,
  '{
     "header": "Conditions Générales de Vente",
     "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
     "withdrawal_clauses": {
       "EXEMPT_PERISHABLE": "Conformément à l''article L221-28 3° du Code de la consommation, le droit de rétractation ne s''applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement.",
       "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d''un délai de 14 jours pour exercer son droit de rétractation.",
       "MIXED": null
     },
     "mediator_clause": "En cas de litige, le client peut recourir gratuitement au médiateur de la consommation désigné par le vendeur.",
     "preparation_clause": "Le vendeur indique un délai de préparation prévisionnel, communiqué au client avant validation de la commande.",
     "cancellation_clause_label": "Politique d''annulation",
     "substitution_clause_label": "Politique de substitution de produit",
     "jurisdiction_clause": "Les présentes conditions sont soumises au droit applicable dans le pays d''établissement du vendeur."
   }'::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 1);

-- =============================================================================
-- C. merchant_cgv_profile — Section H. Merchant-editable business
--    conditions + rollout status (Section P). Deliberately separate
--    from merchant_legal_profile (pure identity) so the merchant UX
--    (Section M) can visually separate "3. Business conditions" /
--    "4. Preparation conditions" / "5. Withdrawal regime" from
--    "2. Mandatory legal information" while both feed completeness.
-- =============================================================================
create table if not exists public.merchant_cgv_profile (
  restaurant_id           uuid primary key references public.restaurants(id) on delete cascade,
  -- Section C: v1 enum, merchant-level only, no product-level override.
  withdrawal_regime        text check (withdrawal_regime in ('EXEMPT_PERISHABLE', 'STANDARD_14_DAYS', 'MIXED')),
  -- Section D: dedicated preparation-time fields, NEVER derived from
  -- restaurant_sale_modes.delay_value/delay_unit (semantics unproven,
  -- Phase 0 finding) and distinct from any provider/delivery ETA.
  preparation_time_min     integer check (preparation_time_min is null or preparation_time_min >= 0),
  preparation_time_max     integer check (preparation_time_max is null or preparation_time_max >= 0),
  preparation_time_unit    text check (preparation_time_unit is null or preparation_time_unit in ('MINUTES', 'HOURS')),
  cancellation_policy_text text,
  substitution_policy_text text,
  -- Section G: deterministic presentation variant, tone only, never a
  -- substitute for legal-core wording.
  presentation_variant     text not null default 'FORMAL' check (presentation_variant in ('FORMAL', 'WARM', 'PREMIUM', 'SIMPLE')),
  -- Section P: explicit rollout/activation model. Legacy merchants
  -- default here (row absent == CGV_NOT_CONFIGURED, see
  -- get_merchant_cgv_profile) until an authorized rollout step
  -- explicitly moves them forward. Never silently advanced by this
  -- migration itself — no backfill insert for existing restaurants.
  status                   text not null default 'CGV_NOT_CONFIGURED'
                            check (status in ('CGV_NOT_CONFIGURED', 'CGV_DRAFT', 'CGV_READY', 'CGV_ACTIVE')),
  profile_version          integer not null default 0,
  updated_at               timestamptz not null default now(),
  check (
    preparation_time_min is null or preparation_time_max is null
    or preparation_time_min <= preparation_time_max
  )
);

alter table public.merchant_cgv_profile enable row level security;
-- v1.1 Blocker 2 — see merchant_legal_profile above for rationale.
revoke all privileges on table public.merchant_cgv_profile from public;
revoke all privileges on table public.merchant_cgv_profile from anon;
revoke all privileges on table public.merchant_cgv_profile from authenticated;
revoke all privileges on table public.merchant_cgv_profile from service_role;
grant select on table public.merchant_cgv_profile to authenticated;

drop policy if exists "restaurant members read cgv profile" on public.merchant_cgv_profile;
create policy "restaurant members read cgv profile"
on public.merchant_cgv_profile
for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = merchant_cgv_profile.restaurant_id
  )
  or public.is_scanym_operator()
);

-- =============================================================================
-- D. merchant_cgv_version — Section J. Immutable once inserted.
--    Content columns are NEVER updated in place; only `status` moves
--    ACTIVE -> SUPERSEDED when a newer version is published for the
--    same restaurant (lifecycle bookkeeping, not content mutation).
-- =============================================================================
create table if not exists public.merchant_cgv_version (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  template_id            uuid not null references public.cgv_template(id),
  template_version       integer not null,
  merchant_profile_version integer not null,
  locale                 text not null,
  presentation_variant   text not null,
  rendered_content       text not null,
  content_hash           text not null,
  effective_from         timestamptz not null default now(),
  published_at           timestamptz not null default now(),
  status                 text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUPERSEDED'))
);

create index if not exists merchant_cgv_version_restaurant_idx
  on public.merchant_cgv_version (restaurant_id, status, published_at desc);

-- Exactly one ACTIVE (== "current") version per restaurant.
create unique index if not exists merchant_cgv_version_one_active_idx
  on public.merchant_cgv_version (restaurant_id)
  where status = 'ACTIVE';

alter table public.merchant_cgv_version enable row level security;
-- v1.1 Blocker 2 — see merchant_legal_profile above for rationale.
-- Especially load-bearing here: this table is meant to be immutable,
-- and TRUNCATE bypasses RLS entirely regardless of any policy — an
-- inherited TRUNCATE grant on this table was a real integrity risk.
revoke all privileges on table public.merchant_cgv_version from public;
revoke all privileges on table public.merchant_cgv_version from anon;
revoke all privileges on table public.merchant_cgv_version from authenticated;
revoke all privileges on table public.merchant_cgv_version from service_role;
grant select on table public.merchant_cgv_version to authenticated;

drop policy if exists "restaurant members read cgv version" on public.merchant_cgv_version;
create policy "restaurant members read cgv version"
on public.merchant_cgv_version
for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = merchant_cgv_version.restaurant_id
  )
  or public.is_scanym_operator()
);
-- No update/delete grant to any role at any privilege level:
-- immutability is enforced by the absence of a write path, not merely
-- by application discipline (closes test-matrix #12).

-- =============================================================================
-- E. order_cgv_acceptance — Section O. 1:1 with orders. Written
--    exclusively by create_order (SECURITY DEFINER), never directly
--    by a client. terms_url is informational only; cgv_version_id +
--    content_hash are authoritative (mandate O).
-- =============================================================================
create table if not exists public.order_cgv_acceptance (
  order_id            uuid primary key references public.orders(id) on delete cascade,
  restaurant_id        uuid not null references public.restaurants(id) on delete restrict,
  cgv_version_id       uuid not null references public.merchant_cgv_version(id),
  content_hash         text not null,
  accepted_at          timestamptz not null default now(),
  acceptance_channel    text not null default 'web_checkout',
  locale               text,
  terms_url            text
);

alter table public.order_cgv_acceptance enable row level security;
-- v1.1 Blocker 2 — see merchant_legal_profile above for rationale.
-- Same TRUNCATE-bypasses-RLS concern as merchant_cgv_version: this
-- table is the legally significant per-order acceptance snapshot.
revoke all privileges on table public.order_cgv_acceptance from public;
revoke all privileges on table public.order_cgv_acceptance from anon;
revoke all privileges on table public.order_cgv_acceptance from authenticated;
revoke all privileges on table public.order_cgv_acceptance from service_role;
grant select on table public.order_cgv_acceptance to authenticated;
-- No insert/update/delete grant to anon/authenticated at all: the
-- only writer is create_order (SECURITY DEFINER, below), matching the
-- CRITICAL TRUST RULE — a customer session can never write this table
-- directly, forged or otherwise.

drop policy if exists "restaurant members read order cgv acceptance" on public.order_cgv_acceptance;
create policy "restaurant members read order cgv acceptance"
on public.order_cgv_acceptance
for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = order_cgv_acceptance.restaurant_id
  )
  or public.is_scanym_operator()
);

-- =============================================================================
-- F. assert_legal_cgv_role / assert_legal_cgv_read_access — EXACT same
--    two-tier pattern as assert_receipt_settings_role /
--    assert_receipt_settings_read_access
--    (DRAFT-lot-merchant-legal-tax-profile-v1.sql). Write: owner/
--    manager + operator only (mandate Section H, explicit). Read:
--    any restaurant_users member + operator — deliberate design
--    choice, NOT explicitly mandated by Section H (which speaks only
--    to write authority); mirrors receipt_settings for dashboard
--    consistency (a staff member handling a customer legal question
--    can view the CGV without owner/manager elevation), flagged here
--    rather than silently assumed. See deliverable Section 16.
-- =============================================================================
create function public.assert_legal_cgv_role(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    return;
  end if;

  if public.is_scanym_operator() then
    return;
  end if;

  raise exception using errcode = '42501',
    message = 'Not authorized for this restaurant';
end $$;

revoke all on function public.assert_legal_cgv_role(uuid) from public;

create function public.assert_legal_cgv_read_access(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
  ) then
    return;
  end if;

  if public.is_scanym_operator() then
    return;
  end if;

  raise exception using errcode = '42501',
    message = 'Not authorized for this restaurant';
end $$;

revoke all on function public.assert_legal_cgv_read_access(uuid) from public;

-- =============================================================================
-- G. cgv_completeness_errors — Section I. Deterministic, no silent
--    defaults. Returns an array of stable error codes; empty array =
--    complete. Used both by the merchant UX (status display) and as a
--    hard gate inside resolve_cgv_publication_context /
--    persist_merchant_cgv_version / activate_merchant_cgv.
-- =============================================================================
create function public.cgv_completeness_errors(p_restaurant_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_errors        text[] := '{}';
  v_country       text;
  v_legal         public.merchant_legal_profile%rowtype;
  v_cgv           public.merchant_cgv_profile%rowtype;
  v_template      public.cgv_template%rowtype;
begin
  select country into v_country from public.restaurants where id = p_restaurant_id;
  if v_country is null then
    v_errors := array_append(v_errors, 'COUNTRY_MISSING');
  end if;

  select * into v_legal from public.merchant_legal_profile where restaurant_id = p_restaurant_id;
  if not found or v_legal.legal_form is null or v_legal.governing_country is null then
    v_errors := array_append(v_errors, 'LEGAL_IDENTITY_MISSING');
  end if;
  if not found or v_legal.address_line1 is null or v_legal.postal_code is null or v_legal.city is null then
    v_errors := array_append(v_errors, 'LEGAL_ADDRESS_MISSING');
  end if;
  if not found or (v_legal.customer_service_email is null and v_legal.customer_service_phone is null) then
    v_errors := array_append(v_errors, 'CUSTOMER_CONTACT_MISSING');
  end if;

  -- Resolve the applicable template for the merchant's declared
  -- country to know whether mediator/preparation clauses are
  -- required (fail closed if no template can be resolved at all).
  if v_country is not null then
    select * into v_template
    from public.cgv_template
    where jurisdiction_country = v_country
      and business_scope = 'food_perishable_b2c'
      and status = 'PUBLISHED'
    order by version desc
    limit 1;
  end if;

  if v_template.id is null then
    v_errors := array_append(v_errors, 'TEMPLATE_UNRESOLVED');
  else
    if v_template.requires_mediator and (
      not found or v_legal.consumer_mediator_name is null
      or v_legal.consumer_mediator_address is null
      or v_legal.consumer_mediator_website is null
    ) then
      v_errors := array_append(v_errors, 'MEDIATOR_INFO_MISSING');
    end if;
  end if;

  select * into v_cgv from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;
  if not found or v_cgv.withdrawal_regime is null then
    v_errors := array_append(v_errors, 'WITHDRAWAL_REGIME_MISSING');
  elsif v_cgv.withdrawal_regime = 'MIXED' then
    -- Section C: MIXED is a reserved value; v1 cannot render it
    -- correctly without product-level classification. Fail closed.
    v_errors := array_append(v_errors, 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED');
  end if;

  if v_template.id is not null and v_template.requires_preparation_clause and (
    not found or v_cgv.preparation_time_min is null or v_cgv.preparation_time_max is null
    or v_cgv.preparation_time_unit is null
  ) then
    v_errors := array_append(v_errors, 'PREPARATION_POLICY_MISSING');
  end if;

  return v_errors;
end $$;

revoke all on function public.cgv_completeness_errors(uuid) from public;
grant execute on function public.cgv_completeness_errors(uuid) to authenticated;

-- =============================================================================
-- G-bis. get_applicable_cgv_template — dashboard-facing read. Resolves
--    the SAME template cgv_completeness_errors and publish_merchant_
--    cgv_version use (jurisdiction_country = restaurants.country,
--    business_scope = 'food_perishable_b2c', latest PUBLISHED
--    version). Required for the merchant UX (Section M, "6. CGV
--    preview") to render an ADVISORY, non-authoritative preview via
--    lib/legal/render.ts before publishing (v1.1: the actual publish
--    call no longer sends this or any other rendering input to the
--    server — see resolve_cgv_publication_context/
--    persist_merchant_cgv_version above). Read-access gated (same tier
--    as the rest of this lot's merchant-facing RPCs) — cgv_template
--    itself keeps zero direct grant to any client role.
-- =============================================================================
create function public.get_applicable_cgv_template(p_restaurant_id uuid)
returns public.cgv_template
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_country  text;
  v_row      public.cgv_template%rowtype;
begin
  perform public.assert_legal_cgv_read_access(p_restaurant_id);

  select country into v_country from public.restaurants where id = p_restaurant_id;
  if v_country is null then
    return v_row; -- toutes colonnes null : aucun pays résolu, aucun gabarit à proposer.
  end if;

  select * into v_row
  from public.cgv_template
  where jurisdiction_country = v_country
    and business_scope = 'food_perishable_b2c'
    and status = 'PUBLISHED'
  order by version desc
  limit 1;

  return v_row;
end $$;

revoke all on function public.get_applicable_cgv_template(uuid) from public;
grant execute on function public.get_applicable_cgv_template(uuid) to authenticated;

-- =============================================================================
-- H. get_merchant_legal_profile / update_merchant_legal_profile
-- =============================================================================
create function public.get_merchant_legal_profile(p_restaurant_id uuid)
returns public.merchant_legal_profile
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.merchant_legal_profile%rowtype;
begin
  perform public.assert_legal_cgv_read_access(p_restaurant_id);
  select * into v_row from public.merchant_legal_profile where restaurant_id = p_restaurant_id;
  return v_row;
end $$;

revoke all on function public.get_merchant_legal_profile(uuid) from public;
grant execute on function public.get_merchant_legal_profile(uuid) to authenticated;

create function public.update_merchant_legal_profile(
  p_restaurant_id             uuid,
  p_legal_form                text,
  p_address_line1             text,
  p_address_line2             text,
  p_postal_code               text,
  p_city                      text,
  p_governing_country         text,
  p_customer_service_email    text,
  p_customer_service_phone    text,
  p_consumer_mediator_name    text,
  p_consumer_mediator_address text,
  p_consumer_mediator_website text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_legal_form                text;
  v_address_line1              text;
  v_address_line2              text;
  v_postal_code                text;
  v_city                       text;
  v_governing_country          text;
  v_customer_service_email     text;
  v_customer_service_phone     text;
  v_consumer_mediator_name     text;
  v_consumer_mediator_address  text;
  v_consumer_mediator_website  text;
begin
  perform public.assert_legal_cgv_role(p_restaurant_id);

  v_legal_form               := nullif(btrim(coalesce(p_legal_form, '')), '');
  v_address_line1            := nullif(btrim(coalesce(p_address_line1, '')), '');
  v_address_line2            := nullif(btrim(coalesce(p_address_line2, '')), '');
  v_postal_code               := nullif(btrim(coalesce(p_postal_code, '')), '');
  v_city                      := nullif(btrim(coalesce(p_city, '')), '');
  v_governing_country         := nullif(upper(btrim(coalesce(p_governing_country, ''))), '');
  v_customer_service_email    := nullif(btrim(coalesce(p_customer_service_email, '')), '');
  v_customer_service_phone    := nullif(btrim(coalesce(p_customer_service_phone, '')), '');
  v_consumer_mediator_name    := nullif(btrim(coalesce(p_consumer_mediator_name, '')), '');
  v_consumer_mediator_address := nullif(btrim(coalesce(p_consumer_mediator_address, '')), '');
  v_consumer_mediator_website := nullif(btrim(coalesce(p_consumer_mediator_website, '')), '');

  -- Do not invent a silent default: an explicitly-provided but
  -- unrecognized country code is rejected rather than silently
  -- dropped to NULL (the FK would reject it anyway; this gives a
  -- clearer, deterministic error).
  if v_governing_country is not null and not exists (
    select 1 from public.scanym_supported_countries where code = v_governing_country
  ) then
    raise exception using errcode = '22023', message = 'Unknown governing_country code';
  end if;

  insert into public.merchant_legal_profile (
    restaurant_id, legal_form, address_line1, address_line2, postal_code, city,
    governing_country, customer_service_email, customer_service_phone,
    consumer_mediator_name, consumer_mediator_address, consumer_mediator_website,
    updated_at
  ) values (
    p_restaurant_id, v_legal_form, v_address_line1, v_address_line2, v_postal_code, v_city,
    v_governing_country, v_customer_service_email, v_customer_service_phone,
    v_consumer_mediator_name, v_consumer_mediator_address, v_consumer_mediator_website,
    now()
  )
  on conflict (restaurant_id) do update set
    legal_form = excluded.legal_form,
    address_line1 = excluded.address_line1,
    address_line2 = excluded.address_line2,
    postal_code = excluded.postal_code,
    city = excluded.city,
    governing_country = excluded.governing_country,
    customer_service_email = excluded.customer_service_email,
    customer_service_phone = excluded.customer_service_phone,
    consumer_mediator_name = excluded.consumer_mediator_name,
    consumer_mediator_address = excluded.consumer_mediator_address,
    consumer_mediator_website = excluded.consumer_mediator_website,
    updated_at = now();
end $$;

revoke all on function public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text) to authenticated;

-- =============================================================================
-- I. get_merchant_cgv_profile / update_merchant_cgv_profile
--    Status transitions live ONLY here and in publish/activate below:
--    NOT_CONFIGURED -> DRAFT happens automatically on first save
--    (Section P allows this — it is not activation, no enforcement
--    begins). DRAFT/READY -> ACTIVE NEVER happens here (Section P:
--    "Do not silently auto-activate" — only activate_merchant_cgv,
--    an explicit separate call, can set ACTIVE).
-- =============================================================================
create function public.get_merchant_cgv_profile(p_restaurant_id uuid)
returns table (
  restaurant_id uuid,
  withdrawal_regime text,
  preparation_time_min integer,
  preparation_time_max integer,
  preparation_time_unit text,
  cancellation_policy_text text,
  substitution_policy_text text,
  presentation_variant text,
  status text,
  profile_version integer,
  updated_at timestamptz,
  completeness_errors text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_legal_cgv_read_access(p_restaurant_id);
  return query
  select
    p_restaurant_id,
    cp.withdrawal_regime, cp.preparation_time_min, cp.preparation_time_max,
    cp.preparation_time_unit, cp.cancellation_policy_text, cp.substitution_policy_text,
    coalesce(cp.presentation_variant, 'FORMAL'),
    coalesce(cp.status, 'CGV_NOT_CONFIGURED'),
    coalesce(cp.profile_version, 0),
    cp.updated_at,
    public.cgv_completeness_errors(p_restaurant_id)
  from (select 1) as _dummy
  left join public.merchant_cgv_profile cp on cp.restaurant_id = p_restaurant_id;
end $$;

revoke all on function public.get_merchant_cgv_profile(uuid) from public;
grant execute on function public.get_merchant_cgv_profile(uuid) to authenticated;

create function public.update_merchant_cgv_profile(
  p_restaurant_id           uuid,
  p_withdrawal_regime       text,
  p_preparation_time_min    integer,
  p_preparation_time_max    integer,
  p_preparation_time_unit   text,
  p_cancellation_policy_text text,
  p_substitution_policy_text text,
  p_presentation_variant     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_withdrawal_regime        text;
  v_preparation_time_unit    text;
  v_cancellation_policy_text text;
  v_substitution_policy_text text;
  v_presentation_variant     text;
begin
  perform public.assert_legal_cgv_role(p_restaurant_id);

  v_withdrawal_regime        := nullif(upper(btrim(coalesce(p_withdrawal_regime, ''))), '');
  v_preparation_time_unit    := nullif(upper(btrim(coalesce(p_preparation_time_unit, ''))), '');
  v_cancellation_policy_text := nullif(btrim(coalesce(p_cancellation_policy_text, '')), '');
  v_substitution_policy_text := nullif(btrim(coalesce(p_substitution_policy_text, '')), '');
  v_presentation_variant     := nullif(upper(btrim(coalesce(p_presentation_variant, ''))), 'FORMAL');
  if v_presentation_variant is null then
    v_presentation_variant := 'FORMAL';
  end if;

  if v_withdrawal_regime is not null and v_withdrawal_regime not in ('EXEMPT_PERISHABLE','STANDARD_14_DAYS','MIXED') then
    raise exception using errcode = '22023', message = 'Unknown withdrawal_regime value';
  end if;
  if v_preparation_time_unit is not null and v_preparation_time_unit not in ('MINUTES','HOURS') then
    raise exception using errcode = '22023', message = 'Unknown preparation_time_unit value';
  end if;
  if v_presentation_variant not in ('FORMAL','WARM','PREMIUM','SIMPLE') then
    raise exception using errcode = '22023', message = 'Unknown presentation_variant value';
  end if;
  if p_preparation_time_min is not null and p_preparation_time_max is not null
     and p_preparation_time_min > p_preparation_time_max then
    raise exception using errcode = '22023', message = 'preparation_time_min must be <= preparation_time_max';
  end if;

  insert into public.merchant_cgv_profile (
    restaurant_id, withdrawal_regime, preparation_time_min, preparation_time_max,
    preparation_time_unit, cancellation_policy_text, substitution_policy_text,
    presentation_variant, status, profile_version, updated_at
  ) values (
    p_restaurant_id, v_withdrawal_regime, p_preparation_time_min, p_preparation_time_max,
    v_preparation_time_unit, v_cancellation_policy_text, v_substitution_policy_text,
    v_presentation_variant, 'CGV_DRAFT', 1, now()
  )
  on conflict (restaurant_id) do update set
    withdrawal_regime = excluded.withdrawal_regime,
    preparation_time_min = excluded.preparation_time_min,
    preparation_time_max = excluded.preparation_time_max,
    preparation_time_unit = excluded.preparation_time_unit,
    cancellation_policy_text = excluded.cancellation_policy_text,
    substitution_policy_text = excluded.substitution_policy_text,
    presentation_variant = excluded.presentation_variant,
    -- NOT_CONFIGURED -> DRAFT on first save only; a merchant already
    -- at READY or ACTIVE keeps that status across further edits (an
    -- edit does not by itself deactivate an already-live CGV — a new
    -- publish is required to reflect the edited content in a new
    -- immutable version; see resolve_cgv_publication_context /
    -- persist_merchant_cgv_version).
    status = case
      when public.merchant_cgv_profile.status = 'CGV_NOT_CONFIGURED' then 'CGV_DRAFT'
      else public.merchant_cgv_profile.status
    end,
    profile_version = public.merchant_cgv_profile.profile_version + 1,
    updated_at = now();
end $$;

revoke all on function public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text) from public;
grant execute on function public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text) to authenticated;

-- =============================================================================
-- J. Server-authoritative CGV publication (v1.1 Blocker 1 remediation
--    — CGV-V1-PUBLISH-AUTHORITY-01). Rendering (the actual clause
--    assembly) still happens in TypeScript (lib/legal/render.ts,
--    deterministic, no AI/network call) — but now exclusively inside
--    lib/server/legal-cgv-publish-service.ts (Node, server-only),
--    never in the browser. Two functions, split by trust boundary.
-- =============================================================================

-- J-0. Private helper — the ONE place the "applicable template"
-- resolution query is written. cgv_completeness_errors/
-- get_applicable_cgv_template (above) each still run their own
-- equivalent inline query (unchanged from v1, kept byte-identical to
-- avoid touching working code) — this helper is consumed only by the
-- two new functions below, so the publication path's OWN two
-- resolution points (context vs. persistence) can never drift from
-- each other. No grant to any role: callable only by its owner (i.e.
-- only from within another SECURITY DEFINER function owned by the
-- same role) — PUBLIC/anon/authenticated/service_role can never reach
-- it directly.
create function public._resolve_applicable_cgv_template(p_country text)
returns public.cgv_template
language sql
stable
security definer
set search_path = ''
as $$
  select t.*
  from public.cgv_template t
  where t.jurisdiction_country = p_country
    and t.business_scope = 'food_perishable_b2c'
    and t.status = 'PUBLISHED'
  order by t.version desc
  limit 1;
$$;

revoke all on function public._resolve_applicable_cgv_template(text) from public;

-- J-1. resolve_cgv_publication_context — as-user (assert_legal_cgv_role:
-- owner/manager/operator, same write-authority gate v1 already used
-- for publish). Takes ONLY p_restaurant_id — no template_id, no
-- locale, no presentation_variant, no content of any kind. Returns
-- every input lib/legal/render.ts needs, resolved ENTIRELY from
-- already-role-gated, already-validated server state; fails closed
-- (CGV_INCOMPLETE) rather than return a partial context. Called from
-- lib/server/legal-cgv-publish-service.ts using the caller's OWN
-- access token (lib/server/supabase-as-user.ts) — never a secret, and
-- this function never persists anything (STABLE-safe read path).
create function public.resolve_cgv_publication_context(p_restaurant_id uuid)
returns table (
  restaurant_id            uuid,
  seller_name              text,
  template_id              uuid,
  template_version         integer,
  controlled_sections      jsonb,
  merchant_profile_version integer,
  locale                   text,
  presentation_variant     text,
  legal_form               text,
  address_line1            text,
  address_line2            text,
  postal_code              text,
  city                     text,
  governing_country        text,
  customer_service_email   text,
  customer_service_phone   text,
  mediator_name            text,
  mediator_address         text,
  mediator_website         text,
  withdrawal_regime        text,
  preparation_time_min     integer,
  preparation_time_max     integer,
  preparation_time_unit    text,
  cancellation_policy_text text,
  substitution_policy_text text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors    text[];
  v_country   text;
  v_name      text;
  v_legal     public.merchant_legal_profile%rowtype;
  v_cgv       public.merchant_cgv_profile%rowtype;
  v_template  public.cgv_template%rowtype;
begin
  perform public.assert_legal_cgv_role(p_restaurant_id);

  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  select r.name, r.country into v_name, v_country
  from public.restaurants r where r.id = p_restaurant_id;

  -- NOTE (fixed during v1.1 harness verification): this function's own
  -- RETURNS TABLE(restaurant_id uuid, ...) makes `restaurant_id` an
  -- implicit PL/pgSQL variable inside this body, colliding with the
  -- identically-named table column below — table-qualify explicitly
  -- (mlp./mcp.) rather than leaving a bare `restaurant_id` that
  -- PostgreSQL would otherwise reject as ambiguous.
  select * into v_legal from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id;
  select * into v_cgv from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id;
  v_template := public._resolve_applicable_cgv_template(v_country);

  if v_template.id is null then
    -- Unreachable in practice — cgv_completeness_errors above already
    -- raised TEMPLATE_UNRESOLVED if this were true. Defense in depth:
    -- never a silent/partial row returned.
    raise exception using errcode = 'P0001', message = 'TEMPLATE_UNRESOLVED';
  end if;

  return query select
    p_restaurant_id, v_name,
    v_template.id, v_template.version, v_template.controlled_sections,
    v_cgv.profile_version,
    'fr'::text, -- v1 scope is France B2C food/perishable only — fixed here, never client-supplied at any layer.
    v_cgv.presentation_variant,
    v_legal.legal_form, v_legal.address_line1, v_legal.address_line2,
    v_legal.postal_code, v_legal.city, v_legal.governing_country,
    v_legal.customer_service_email, v_legal.customer_service_phone,
    v_legal.consumer_mediator_name, v_legal.consumer_mediator_address, v_legal.consumer_mediator_website,
    v_cgv.withdrawal_regime, v_cgv.preparation_time_min, v_cgv.preparation_time_max, v_cgv.preparation_time_unit,
    v_cgv.cancellation_policy_text, v_cgv.substitution_policy_text;
end $$;

revoke all on function public.resolve_cgv_publication_context(uuid) from public;
grant execute on function public.resolve_cgv_publication_context(uuid) to authenticated;

-- J-2. persist_merchant_cgv_version — THE trust boundary itself
-- (Blocker 1). EXECUTE granted to service_role ONLY — never anon,
-- never authenticated, never PUBLIC (see the mandatory DIRECT RPC
-- BYPASS test in the SQL harness, which proves this with a live
-- permission-denied assertion, not merely by reading this grant list).
-- Called exclusively from lib/server/legal-cgv-publish-service.ts
-- (Node, server-only, service_role client — lib/server/
-- supabase-admin.ts), AFTER that same server code has rendered
-- p_rendered_content itself via lib/legal/render.ts from the context
-- resolve_cgv_publication_context returned — never from anything the
-- browser sent. Still never trusts a client-supplied hash (computes
-- md5() itself, unchanged from v1) and, new in v1.1, never simply
-- trusts p_template_id either — it independently RE-PROVES applicable-
-- template authority below, even against this now-trusted caller.
create function public.persist_merchant_cgv_version(
  p_restaurant_id    uuid,
  p_template_id      uuid,
  p_rendered_content text
)
returns public.merchant_cgv_version
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors        text[];
  v_country       text;
  v_template      public.cgv_template%rowtype;
  v_applicable    public.cgv_template%rowtype;
  v_cgv           public.merchant_cgv_profile%rowtype;
  v_new_row       public.merchant_cgv_version%rowtype;
begin
  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  select * into v_template from public.cgv_template where id = p_template_id and status = 'PUBLISHED';
  if not found then
    raise exception using errcode = '22023', message = 'Unknown or unpublished template_id';
  end if;

  -- APPLICABLE TEMPLATE AUTHORITY (v1.1): never trust p_template_id
  -- merely because it names a PUBLISHED row somewhere — independently
  -- re-resolve the template this restaurant is ACTUALLY entitled to
  -- (by its own country) and require an EXACT id match. A template
  -- id for a different jurisdiction, however validly PUBLISHED in
  -- general, is rejected here exactly as firmly as an unpublished or
  -- nonexistent one — fail closed, no unambiguous applicable template
  -- means no persistence.
  select country into v_country from public.restaurants where id = p_restaurant_id;
  v_applicable := public._resolve_applicable_cgv_template(v_country);
  if v_applicable.id is null or v_applicable.id <> p_template_id then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_APPLICABLE';
  end if;

  select * into v_cgv from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CGV_INCOMPLETE';
  end if;

  if p_rendered_content is null or btrim(p_rendered_content) = '' then
    raise exception using errcode = '22023', message = 'rendered_content must not be empty';
  end if;

  -- Supersede the current ACTIVE (== "current") version, if any —
  -- content rows themselves are never touched, only their status.
  update public.merchant_cgv_version
     set status = 'SUPERSEDED'
   where restaurant_id = p_restaurant_id and status = 'ACTIVE';

  insert into public.merchant_cgv_version (
    restaurant_id, template_id, template_version, merchant_profile_version,
    locale, presentation_variant, rendered_content, content_hash,
    effective_from, published_at, status
  ) values (
    p_restaurant_id, p_template_id, v_template.version, v_cgv.profile_version,
    'fr', -- fixed — matches resolve_cgv_publication_context; never client-supplied at any layer (v1.1).
    coalesce(v_cgv.presentation_variant, 'FORMAL'),
    p_rendered_content,
    md5(p_rendered_content),
    now(), now(), 'ACTIVE'
  )
  returning * into v_new_row;

  -- A first successful publish moves DRAFT -> READY (published,
  -- previewable) — NEVER to ACTIVE (Section P: explicit activation
  -- required). A merchant already ACTIVE stays ACTIVE (enforcement
  -- continues uninterrupted under the new version).
  update public.merchant_cgv_profile
     set status = case when status = 'CGV_ACTIVE' then 'CGV_ACTIVE' else 'CGV_READY' end,
         updated_at = now()
   where restaurant_id = p_restaurant_id;

  return v_new_row;
end $$;

revoke all on function public.persist_merchant_cgv_version(uuid,uuid,text) from public;
grant execute on function public.persist_merchant_cgv_version(uuid,uuid,text) to service_role;
-- Deliberately NO grant to anon, NO grant to authenticated, NO grant
-- to PUBLIC. This is the entire point of Blocker 1's remediation —
-- see the DIRECT RPC BYPASS test in
-- supabase/tests/seller-legal-profile-cgv-engine-v1-1-check.sh.

-- =============================================================================
-- K. activate_merchant_cgv — Section P. Explicit, separate,
--    non-silent activation. Requires an existing ACTIVE-status
--    (== published/current) merchant_cgv_version row and a complete
--    profile. Never invoked automatically by publish/update above.
-- =============================================================================
create function public.activate_merchant_cgv(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors text[];
begin
  perform public.assert_legal_cgv_role(p_restaurant_id);

  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  if not exists (
    select 1 from public.merchant_cgv_version
    where restaurant_id = p_restaurant_id and status = 'ACTIVE'
  ) then
    raise exception using errcode = 'P0001', message = 'CGV_NOT_PUBLISHED';
  end if;

  update public.merchant_cgv_profile
     set status = 'CGV_ACTIVE', updated_at = now()
   where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'CGV_NOT_PUBLISHED';
  end if;
end $$;

revoke all on function public.activate_merchant_cgv(uuid) from public;
grant execute on function public.activate_merchant_cgv(uuid) to authenticated;

-- =============================================================================
-- L. Public, tenant-safe read RPCs — Section L. Both are
--    SECURITY DEFINER, granted to anon (customer checkout is often
--    unauthenticated) and authenticated, hardened search_path, and
--    return data ONLY for an exact (slug) or (id, restaurant_id) match
--    — no enumeration path, no cross-tenant leak (closes #23).
-- =============================================================================
create function public.get_restaurant_public_cgv(p_slug text)
returns table (
  restaurant_id uuid,
  cgv_version_id uuid,
  rendered_content text,
  content_hash text,
  locale text,
  published_at timestamptz,
  -- Distinct from "a version exists" (true as soon as CGV_READY, i.e.
  -- published but not yet enforced): `enforced` reflects the
  -- merchant's own rollout status (Section P) so the checkout UI
  -- knows whether the acceptance checkbox is actually mandatory right
  -- now, matching EXACTLY the server-side gate in create_order (which
  -- checks merchant_cgv_profile.status = 'CGV_ACTIVE', not merely the
  -- existence of a version row).
  enforced boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select v.restaurant_id, v.id, v.rendered_content, v.content_hash, v.locale, v.published_at,
         coalesce(cp.status = 'CGV_ACTIVE', false)
  from public.merchant_cgv_version v
  join public.restaurants r on r.id = v.restaurant_id
  left join public.merchant_cgv_profile cp on cp.restaurant_id = v.restaurant_id
  where r.slug = p_slug and v.status = 'ACTIVE';
end $$;

revoke all on function public.get_restaurant_public_cgv(text) from public;
grant execute on function public.get_restaurant_public_cgv(text) to anon;
grant execute on function public.get_restaurant_public_cgv(text) to authenticated;

-- Historical, evidence-grade lookup: requires BOTH the immutable
-- version id AND the restaurant_id it was published for. A caller
-- that does not already know both cannot browse arbitrary versions.
create function public.get_restaurant_cgv_version_by_id(p_version_id uuid, p_restaurant_id uuid)
returns table (
  cgv_version_id uuid,
  rendered_content text,
  content_hash text,
  locale text,
  published_at timestamptz,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select v.id, v.rendered_content, v.content_hash, v.locale, v.published_at, v.status
  from public.merchant_cgv_version v
  where v.id = p_version_id and v.restaurant_id = p_restaurant_id;
end $$;

revoke all on function public.get_restaurant_cgv_version_by_id(uuid,uuid) from public;
grant execute on function public.get_restaurant_cgv_version_by_id(uuid,uuid) to anon;
grant execute on function public.get_restaurant_cgv_version_by_id(uuid,uuid) to authenticated;

-- =============================================================================
-- M. create_order — additive 8th parameter, defaulted, existing
--    7-arg call sites unaffected.
--
--    IMPORTANT (found by this lot's own SQL harness, test "après
--    rollback, create_order n'a plus p_cgv_accepted" — initially
--    FAILED): `create or replace function` identifies a function by
--    name + parameter TYPE LIST. Adding a trailing parameter changes
--    that type list, so `create or replace` with 8 params does NOT
--    replace the existing 7-param function — it creates a SECOND,
--    separate overload alongside it. Left uncorrected, this would
--    have left the pre-lot 7-arg create_order fully callable and
--    completely bypassing CGV enforcement (a live security bypass,
--    not merely a cosmetic issue) — any caller still invoking it with
--    exactly 7 positional arguments (the untouched frontend, until
--    lib/services/order-payload.ts is updated by this same lot, or
--    any other/future direct RPC caller) would silently skip the
--    entire CGV gate. Fixed by explicitly DROPping the exact old
--    7-arg signature first, so exactly one create_order exists after
--    this migration; existing callers passing only 7 arguments keep
--    resolving correctly against the new function via its 8th
--    parameter's default (false) — no behavior change for them.
-- =============================================================================
drop function if exists public.create_order(text,text,jsonb,integer,jsonb,text,text);

-- Body is the TRUE current final
--    definition (DRAFT-lot-receipt-invoice-tax-detail-v1.sql,
--    2026-09-01, commit 3e70c22 — chronologically last of the 8 files
--    that redefine create_order; see deliverable Section 2 for the
--    correction of a stale in-repo comment claiming otherwise), with
--    ONLY the CGV enforcement block added (Sections N/O + CRITICAL
--    TRUST RULE + ORDER CREATION ATOMICITY). No other line of the
--    inherited body is altered.
-- =============================================================================
create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null,
  p_cgv_accepted  boolean default false
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
  v_mode_enabled boolean;
  v_req         record;
  v_field_value text;
  v_room_number text;
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
  v_street      text;
  v_city        text;
  -- CGV enforcement (this lot only — everything above is inherited
  -- verbatim from DRAFT-lot-receipt-invoice-tax-detail-v1.sql).
  v_cgv_status         text;
  v_cgv_version_id     uuid;
  v_cgv_content_hash   text;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  -- CRITICAL TRUST RULE / Sections N,O,P — resolved EARLY, before any
  -- item/pricing work, so an unmet CGV requirement fails fast without
  -- side effects. Legacy/non-ACTIVE merchants (status absent,
  -- NOT_CONFIGURED, DRAFT or READY) are completely unaffected —
  -- v_cgv_status simply won't equal 'CGV_ACTIVE' and this whole block
  -- is skipped (closes test-matrix #24: legacy behavior unchanged).
  select status into v_cgv_status
  from public.merchant_cgv_profile where restaurant_id = v_restaurant.id;

  if v_cgv_status = 'CGV_ACTIVE' then
    -- Server independently resolves the authoritative version + hash.
    -- The client cannot supply or influence either value (closes
    -- test-matrix #19, #20) — p_cgv_accepted is the ONLY CGV-related
    -- input accepted from the caller, and it is a plain boolean.
    select v.id, v.content_hash into v_cgv_version_id, v_cgv_content_hash
    from public.merchant_cgv_version v
    where v.restaurant_id = v_restaurant.id and v.status = 'ACTIVE'
    order by v.published_at desc
    limit 1;

    if v_cgv_version_id is null then
      raise exception using errcode = 'P0001', message = 'CGV_REQUIRED_BUT_NOT_PUBLISHED';
    end if;

    if not coalesce(p_cgv_accepted, false) then
      raise exception using errcode = 'P0001', message = 'CGV_ACCEPTANCE_REQUIRED';
    end if;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  select enabled into v_mode_enabled
  from public.restaurant_sale_modes
  where restaurant_id = v_restaurant.id and mode_code = p_service_mode;

  if v_mode_enabled is null or not v_mode_enabled then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');
  v_room_number := nullif(left(trim(coalesce(p_customer->>'room_number','')), 20), '');
  v_street := nullif(left(trim(coalesce(p_customer->>'street','')), 200), '');
  v_city   := nullif(left(trim(coalesce(p_customer->>'city','')), 120), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  insert into tmp_field_reqs (field, requirement, one_of_group, resolved_value)
  select x.field, x.requirement, x.one_of_group,
    case x.field
      when 'customer_name' then v_name
      when 'phone' then v_phone
      when 'email' then v_email
      when 'delivery_address' then v_address
      when 'table_number' then p_table_number::text
      when 'room_number' then v_room_number
      else null
    end
  from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;

  for v_req in select field, resolved_value from tmp_field_reqs where requirement = 'required' loop
    if v_req.resolved_value is null then
      raise exception 'Champ requis manquant pour ce mode: %', v_req.field;
    end if;
  end loop;

  for v_req in
    select one_of_group, bool_or(resolved_value is not null) as satisfied
    from tmp_field_reqs
    where requirement = 'one_of' and one_of_group is not null
    group by one_of_group
  loop
    if not v_req.satisfied then
      raise exception 'Au moins un champ du groupe % est requis', v_req.one_of_group;
    end if;
  end loop;

  if p_service_mode = 'delivery' then
    select exists (
      select 1
      from public.restaurant_sale_mode_fulfillments f
      join public.restaurant_sale_modes rsm
        on rsm.restaurant_id = f.restaurant_id and rsm.mode_code = f.mode_code
      where f.restaurant_id = v_restaurant.id
        and f.mode_code = p_service_mode
        and f.enabled = true
        and rsm.enabled = true
    ) into v_new_engine;

    if v_new_engine then
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      v_postal := substring(v_address from '\m(\d{5})\M');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;

      select p into v_zone
      from public.restaurant_sale_modes rsm,
           jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p
      where rsm.restaurant_id = v_restaurant.id and rsm.mode_code = 'delivery'
        and v_postal like p || '%'
      limit 1;

      if v_zone is null then
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number, room_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    case when p_service_mode = 'room_service' then v_room_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  if p_service_mode = 'delivery' and v_address is not null then
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city)
    values (v_order_id, v_address, v_postal, v_street, v_city);
  end if;

  -- SELLER LEGAL PROFILE + CGV ENGINE v1 (Sections N/O/CRITICAL TRUST
  -- RULE/ORDER CREATION ATOMICITY) : la ligne d'acceptation n'est
  -- écrite QUE lorsque le gate ci-dessus a résolu un
  -- (v_cgv_version_id, v_cgv_content_hash) autoritatif -- c'est-à-dire
  -- uniquement pour un marchand CGV_ACTIVE. Aucune valeur reçue du
  -- client n'entre dans cet insert : les deux colonnes qui font foi
  -- proviennent exclusivement de la résolution serveur effectuée plus
  -- haut. Un marchand non-ACTIVE (v_cgv_version_id resté null) ne
  -- produit ici aucune ligne -- comportement legacy inchangé.
  if v_cgv_version_id is not null then
    insert into public.order_cgv_acceptance (
      order_id, restaurant_id, cgv_version_id, content_hash,
      accepted_at, acceptance_channel, locale, terms_url
    ) values (
      v_order_id, v_restaurant.id, v_cgv_version_id, v_cgv_content_hash,
      now(), 'web_checkout',
      nullif(left(trim(coalesce(p_language,'')), 10), ''),
      '/legal/' || v_restaurant.slug
    );
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    declare
      v_delivery_min_items integer;
    begin
      select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
      from public.restaurant_sale_modes
      where restaurant_id = v_restaurant.id and mode_code = 'delivery';

      if v_qty_total < coalesce(v_delivery_min_items, 0) then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_delivery_min_items, v_qty_total;
      end if;
    end;
  elsif p_service_mode = 'delivery' and v_new_engine then
    select * into v_resolved
    from public.resolve_delivery_fulfillment(v_restaurant.id, p_service_mode, v_postal, v_qty_total, v_subtotal);

    if not v_resolved.eligible then
      if v_resolved.block = 'no-postal' then
        raise exception 'Code postal absent de l''adresse';
      elsif v_resolved.block = 'below-min' then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_resolved.min_items, v_qty_total;
      else
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;

    v_zone := v_resolved.matched_prefix;
    v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);
    v_fulfillment_rule_id := v_resolved.fulfillment_rule_id;
    v_fulfillment_code := v_resolved.fulfillment_code;
    v_provider_code := v_resolved.provider;
  end if;

  update public.orders
  set subtotal = v_subtotal,
      delivery_fee = v_delivery_fee,
      total = v_subtotal + v_delivery_fee,
      fulfillment_rule_id = v_fulfillment_rule_id,
      fulfillment_code = v_fulfillment_code,
      provider_code = v_provider_code
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

revoke all on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) from public;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to anon;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to authenticated;

-- The pre-existing 7-arg overload no longer exists after `create or
-- replace` with an added defaulted parameter (Postgres treats this as
-- the SAME function identity, not a new overload) — existing 7-arg
-- callers (buildCreateOrderPayload today) keep working unchanged,
-- p_cgv_accepted resolves to its default (false) for them until
-- lib/services/order-payload.ts is updated (this lot updates it).

commit;

-- =============================================================================
-- POST-APPLICATION VERIFICATION GUARD
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_arguments(p.oid) ilike '%p_cgv_accepted%'
  ) then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: create_order missing p_cgv_accepted.';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'merchant_cgv_version'
  ) then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: merchant_cgv_version missing.';
  end if;

  if not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C') then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: seed template missing.';
  end if;

  -- v1.1 Blocker 1 — structural proof, baked into the migration itself
  -- (not merely asserted by the harness): the old client-reachable
  -- publish_merchant_cgv_version no longer exists in ANY signature,
  -- and the new persistence function is executable by service_role
  -- but NOT by authenticated/anon/PUBLIC.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'publish_merchant_cgv_version'
  ) then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: publish_merchant_cgv_version must not exist after v1.1.';
  end if;

  if not has_function_privilege('service_role', 'public.persist_merchant_cgv_version(uuid,uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: service_role missing EXECUTE on persist_merchant_cgv_version.';
  end if;

  if has_function_privilege('authenticated', 'public.persist_merchant_cgv_version(uuid,uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: authenticated must NOT have EXECUTE on persist_merchant_cgv_version.';
  end if;

  if has_function_privilege('anon', 'public.persist_merchant_cgv_version(uuid,uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: anon must NOT have EXECUTE on persist_merchant_cgv_version.';
  end if;

  -- v1.1 Blocker 2 — structural proof that every new table's grants
  -- were expressed as "all privileges" convergence (never an
  -- enumerated per-privilege list that could accidentally omit one),
  -- so a future PostgreSQL version adding a new privilege type is
  -- closed automatically. This checks the MIGRATION FILE's own text
  -- discipline is not something SQL can introspect after the fact —
  -- see the SQL harness (grep-based) and README-AUDIT.md instead for
  -- that specific proof; this guard focuses on the resulting ACL state.
  if has_table_privilege('anon', 'public.merchant_cgv_version', 'SELECT')
     or has_table_privilege('anon', 'public.merchant_legal_profile', 'SELECT')
     or has_table_privilege('anon', 'public.merchant_cgv_profile', 'SELECT')
     or has_table_privilege('anon', 'public.order_cgv_acceptance', 'SELECT')
     or has_table_privilege('anon', 'public.cgv_template', 'SELECT') then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: anon must have zero privileges on any new CGV/legal table.';
  end if;

  if has_table_privilege('authenticated', 'public.cgv_template', 'SELECT') then
    raise exception 'SCANYM_POST_APPLY_CHECK_FAILED: authenticated must have zero privileges on cgv_template.';
  end if;
end $$;
