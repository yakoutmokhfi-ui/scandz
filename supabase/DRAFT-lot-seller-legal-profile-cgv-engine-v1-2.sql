-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE + ACCEPTANCE SNAPSHOT v1.2
-- AUDIT REMEDIATION CYCLE 3 — FINAL FUNCTIONAL REMEDIATION CYCLE
-- DEVELOPMENT ONLY — this file is a forward-only DELTA on top of the
-- already-applied v1.1 migration (DRAFT-lot-seller-legal-profile-cgv-
-- engine-v1-1.sql). It never edits that file (verified pre-flight,
-- section 0 below): same convention as CATALOGUE / SUBCATEGORIES
-- BACKOFFICE v1 -> v1.1-remediation.
--
-- Baseline: yakoutmokhfi-ui/scandz, main
--   SHA  5a9e6aa300e5e2b3a7f50439f6760d04585ee382
--   TREE 040ba361a75cd8ef7db37add957478088246867c
-- (confirmed unchanged from Cycle 2 via `git fetch origin main` before
-- this cycle's work began — no STOP — BASELINE MOVED condition.)
--
-- Response to Catimini's targeted independent re-audit of v1.1: FAIL —
-- NOT READY FOR RELEASE, 2 blockers. The two v1.1 blockers
-- (CGV-V1-PUBLISH-AUTHORITY-01, CGV-V1-PROD-ACL-01) are confirmed
-- CLOSED and are NOT reopened or redesigned here — this lot only adds
-- the remediation below on top of that already-closed work.
--
-- ------------------------------------------------------------------
-- BLOCKER 1 — CGV-V11-PUBLISH-CONTEXT-RACE-01 (HIGH)
--
-- v1.1 split publication into resolve_cgv_publication_context
-- (as-user) then persist_merchant_cgv_version (service_role) as two
-- SEPARATE database calls, with lib/legal/render.ts running in Node
-- in between. Between the resolve call and the persist call, the
-- merchant's legal profile, CGV business-conditions profile, or the
-- applicable template could change — persist_merchant_cgv_version
-- re-validated completeness and template applicability against
-- CURRENT state, but had no way to detect that the p_rendered_content
-- it was handed had been rendered from a now-stale snapshot: a
-- published version could end up storing content rendered from OLD
-- context while its own metadata (template_version,
-- merchant_profile_version) reflected NEWER state read fresh at
-- persist time — an authoritative context mismatch baked permanently
-- into an "immutable" row.
--
-- Remediation (this lot):
--   1. resolve_cgv_publication_context now ALSO returns
--      `context_fingerprint` — a server-computed, deterministic
--      digest (see _compute_cgv_publication_context_fingerprint
--      below) of every authoritative input that can affect the
--      rendered content or publication eligibility: restaurant
--      country, every merchant_legal_profile field, every
--      merchant_cgv_profile field (including profile_version and
--      presentation_variant), the applicable template's id+version,
--      and the (currently fixed) locale. It ALSO now returns
--      `acting_user_id` — auth.uid() as resolved by THIS call, itself
--      JWT-derived, never browser-chosen.
--   2. lib/server/legal-cgv-publish-service.ts threads BOTH values
--      straight through to persist_merchant_cgv_version, entirely
--      inside trusted Node code — neither value is ever part of the
--      HTTP request/response shape the browser sees (app/api/
--      dashboard/legal-cgv/publish/route.ts still accepts only
--      { restaurantId } and returns only the published version row).
--   3. persist_merchant_cgv_version (new 5-argument signature —
--      p_expected_context_fingerprint, p_acting_user_id added) now:
--      a. re-checks publication authorization AT THE PERSISTENCE
--         BOUNDARY ITSELF, using p_acting_user_id against CURRENT
--         restaurant_users state (via the new private helper
--         _assert_legal_cgv_role_for_user) — a role revoked between
--         resolve and persist is caught HERE, not merely at resolve
--         time (see BLOCKER 1 "AUTHORIZATION RECHECK" test matrix
--         entries in the SQL harness).
--      b. takes an explicit row lock (`select ... for update`) on
--         both merchant_legal_profile and merchant_cgv_profile for
--         this restaurant BEFORE recomputing anything — a real
--         PostgreSQL row lock, so a concurrent update_merchant_legal_
--         profile/update_merchant_cgv_profile call on the SAME
--         restaurant genuinely blocks until this transaction commits
--         or rolls back (this IS the "atomic compare/lock boundary"
--         the mandate requires — not a comment, an actual lock).
--      c. recomputes the SAME fingerprint function, now, against the
--         just-locked/current rows, and requires an EXACT match
--         against p_expected_context_fingerprint — any authoritative
--         input that changed since resolution raises STALE_CONTEXT,
--         BEFORE any UPDATE (supersede) or INSERT statement runs, so
--         no stale version is ever inserted and no current version is
--         ever superseded on a mismatch.
--
-- The fingerprint is a plain md5() digest of concatenated field
-- values (never a client-suppliable value, never a timestamp, never a
-- bare merchant_profile_version alone — merchant_legal_profile has no
-- version counter of its own, only updated_at, so profile_version
-- alone would not cover legal-profile changes, exactly the case the
-- mandate warns against). It is computed ONLY from server-side state,
-- as a function of p_restaurant_id, both at resolve time and again at
-- persist time — a caller cannot choose or influence its value.
--
-- ------------------------------------------------------------------
-- BLOCKER 2 — CGV-V11-STRUCTURAL-INVENTORY-01 (MEDIUM, MECHANICAL)
--
-- Handled entirely OUTSIDE this SQL file, in three other lots' own
-- test files (tests/ob1-non-modification-proof.test.ts,
-- tests/v110c-payment-p3a1-structural.test.ts) — narrow, exact
-- additions only (one DashboardNav.tsx nav-entry exemption, one exact
-- lib/server import edge, one exact app/api/ route path), per the
-- mandate's explicit authorization. See README-AUDIT.md.
-- =============================================================================

-- ------------------------------------------------------------------
-- 0. PRE-FLIGHT: v1.1 must already be applied EXACTLY as shipped, and
--    this lot's own objects must not already exist (anti-double-apply,
--    same discipline as every migration in this repo).
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: persist_merchant_cgv_version(uuid,uuid,text) (v1.1) introuvable -- v1.1 doit être appliqué avant v1.2, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context introuvable -- v1.1 doit être appliqué avant v1.2, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _resolve_applicable_cgv_template (v1.1) introuvable -- v1.1 doit être appliqué avant v1.2, annulé.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) (v1.2) existe déjà -- v1.2 déjà appliqué ou conflit, annulé.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _compute_cgv_publication_context_fingerprint existe déjà -- v1.2 déjà appliqué ou conflit, annulé.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_assert_legal_cgv_role_for_user'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _assert_legal_cgv_role_for_user existe déjà -- v1.2 déjà appliqué ou conflit, annulé.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------------
-- A. _assert_legal_cgv_role_for_user — same authorization rule as
--    assert_legal_cgv_role, but keyed on an EXPLICIT user id rather
--    than auth.uid(). Needed because persist_merchant_cgv_version (a
--    service_role-only function) has no session of its own to read
--    auth.uid() from — it must recheck authorization for the ACTING
--    user, whose id is threaded through explicitly from the as-user
--    resolve step (never browser-chosen — see header). Deliberately
--    does NOT call public.is_scanym_operator() (which reads auth.uid()
--    internally and would silently check the wrong identity, or none,
--    in this context) — it mirrors that function's own one-line query
--    keyed on p_user_id instead. Zero grants: private helper, exactly
--    like _resolve_applicable_cgv_template.
-- ------------------------------------------------------------------
create function public._assert_legal_cgv_role_for_user(p_restaurant_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = p_user_id
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    return;
  end if;

  if exists (select 1 from public.scanym_operators so where so.user_id = p_user_id) then
    return;
  end if;

  raise exception using errcode = '42501',
    message = 'Not authorized for this restaurant';
end $$;

revoke all on function public._assert_legal_cgv_role_for_user(uuid,uuid) from public;

-- assert_legal_cgv_role now delegates to the user-keyed helper above
-- with auth.uid() — SAME signature/return type, so `create or replace`
-- keeps the same function identity and every existing grant on it
-- untouched; behaviorally IDENTICAL to the v1.1 body (same error
-- codes/messages, same two-tier owner/manager-then-operator check).
create or replace function public.assert_legal_cgv_role(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public._assert_legal_cgv_role_for_user(p_restaurant_id, auth.uid());
end $$;

-- ------------------------------------------------------------------
-- B. _compute_cgv_publication_context_fingerprint — the ONE place the
--    authoritative-context digest is computed, called identically at
--    resolve time and again at persist time so the two can never
--    drift apart. Deterministic md5() of every field that can affect
--    rendered content or publication eligibility (restaurant country;
--    every merchant_legal_profile field; every merchant_cgv_profile
--    field including profile_version and presentation_variant; the
--    applicable template's id+version; the fixed locale). chr(31)
--    (ASCII unit separator) delimits fields so that concatenation
--    ambiguity between adjacent free-text fields cannot produce a
--    false-positive match. Zero grants: private helper.
-- ------------------------------------------------------------------
create function public._compute_cgv_publication_context_fingerprint(p_restaurant_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_country  text;
  v_legal    public.merchant_legal_profile%rowtype;
  v_cgv      public.merchant_cgv_profile%rowtype;
  v_template public.cgv_template%rowtype;
  v_sep      constant text := chr(31);
begin
  select r.country into v_country from public.restaurants r where r.id = p_restaurant_id;
  select * into v_legal from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id;
  select * into v_cgv from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id;
  v_template := public._resolve_applicable_cgv_template(v_country);

  return md5(
    coalesce(v_country, '') || v_sep ||
    coalesce(v_legal.legal_form, '') || v_sep ||
    coalesce(v_legal.address_line1, '') || v_sep ||
    coalesce(v_legal.address_line2, '') || v_sep ||
    coalesce(v_legal.postal_code, '') || v_sep ||
    coalesce(v_legal.city, '') || v_sep ||
    coalesce(v_legal.governing_country, '') || v_sep ||
    coalesce(v_legal.customer_service_email, '') || v_sep ||
    coalesce(v_legal.customer_service_phone, '') || v_sep ||
    coalesce(v_legal.consumer_mediator_name, '') || v_sep ||
    coalesce(v_legal.consumer_mediator_address, '') || v_sep ||
    coalesce(v_legal.consumer_mediator_website, '') || v_sep ||
    coalesce(v_cgv.withdrawal_regime, '') || v_sep ||
    coalesce(v_cgv.preparation_time_min::text, '') || v_sep ||
    coalesce(v_cgv.preparation_time_max::text, '') || v_sep ||
    coalesce(v_cgv.preparation_time_unit, '') || v_sep ||
    coalesce(v_cgv.cancellation_policy_text, '') || v_sep ||
    coalesce(v_cgv.substitution_policy_text, '') || v_sep ||
    coalesce(v_cgv.presentation_variant, '') || v_sep ||
    coalesce(v_cgv.profile_version::text, '') || v_sep ||
    coalesce(v_template.id::text, '') || v_sep ||
    coalesce(v_template.version::text, '') || v_sep ||
    -- locale: fixed ('fr') for all of v1 scope at every layer (render,
    -- resolve, persist) — included as a literal so that the day it is
    -- derived from mutable merchant/template state, coverage is
    -- already correct without another remediation cycle.
    'fr'
  );
end $$;

revoke all on function public._compute_cgv_publication_context_fingerprint(uuid) from public;

-- ------------------------------------------------------------------
-- C. resolve_cgv_publication_context — DROP + CREATE (return type
--    gains two columns: context_fingerprint, acting_user_id — a
--    RETURNS TABLE column-list change cannot be done via CREATE OR
--    REPLACE). Body unchanged in substance from v1.1 (still as-user,
--    still fails closed on CGV_INCOMPLETE/TEMPLATE_UNRESOLVED, still
--    returns zero client-suppliable rendering inputs) except: captures
--    auth.uid() once into v_uid (reused for both the authorization
--    check and the returned acting_user_id column, guaranteeing they
--    can never diverge), and appends the two new output columns.
-- ------------------------------------------------------------------
drop function if exists public.resolve_cgv_publication_context(uuid);

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
  substitution_policy_text text,
  context_fingerprint      text,
  acting_user_id           uuid
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
  v_uid       uuid;
begin
  v_uid := auth.uid();
  perform public._assert_legal_cgv_role_for_user(p_restaurant_id, v_uid);

  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  select r.name, r.country into v_name, v_country
  from public.restaurants r where r.id = p_restaurant_id;

  select * into v_legal from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id;
  select * into v_cgv from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id;
  v_template := public._resolve_applicable_cgv_template(v_country);

  if v_template.id is null then
    raise exception using errcode = 'P0001', message = 'TEMPLATE_UNRESOLVED';
  end if;

  return query select
    p_restaurant_id, v_name,
    v_template.id, v_template.version, v_template.controlled_sections,
    v_cgv.profile_version,
    'fr'::text,
    v_cgv.presentation_variant,
    v_legal.legal_form, v_legal.address_line1, v_legal.address_line2,
    v_legal.postal_code, v_legal.city, v_legal.governing_country,
    v_legal.customer_service_email, v_legal.customer_service_phone,
    v_legal.consumer_mediator_name, v_legal.consumer_mediator_address, v_legal.consumer_mediator_website,
    v_cgv.withdrawal_regime, v_cgv.preparation_time_min, v_cgv.preparation_time_max, v_cgv.preparation_time_unit,
    v_cgv.cancellation_policy_text, v_cgv.substitution_policy_text,
    public._compute_cgv_publication_context_fingerprint(p_restaurant_id),
    v_uid;
end $$;

revoke all on function public.resolve_cgv_publication_context(uuid) from public;
grant execute on function public.resolve_cgv_publication_context(uuid) to authenticated;

-- ------------------------------------------------------------------
-- D. persist_merchant_cgv_version — DROP old 3-arg overload + CREATE
--    new 5-arg version (p_expected_context_fingerprint,
--    p_acting_user_id added). Explicit DROP first (never leave the old
--    3-arg overload reachable as a stale signature, even though it
--    would have zero grants of its own by default — "no stale function
--    overload" applies to the forward migration, not only rollback).
-- ------------------------------------------------------------------
drop function if exists public.persist_merchant_cgv_version(uuid,uuid,text);

create function public.persist_merchant_cgv_version(
  p_restaurant_id                uuid,
  p_template_id                  uuid,
  p_rendered_content             text,
  p_expected_context_fingerprint text,
  p_acting_user_id               uuid
)
returns public.merchant_cgv_version
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors             text[];
  v_country            text;
  v_template           public.cgv_template%rowtype;
  v_applicable         public.cgv_template%rowtype;
  v_cgv                public.merchant_cgv_profile%rowtype;
  v_new_row            public.merchant_cgv_version%rowtype;
  v_actual_fingerprint text;
begin
  -- AUTHORIZATION RECHECK (v1.2 Blocker 1) — re-run at the persistence
  -- boundary itself, against CURRENT restaurant_users state. A role
  -- revoked between resolve and persist is caught HERE.
  perform public._assert_legal_cgv_role_for_user(p_restaurant_id, p_acting_user_id);

  -- ATOMIC LOCK BOUNDARY (v1.2 Blocker 1) — a real PostgreSQL row lock
  -- on the exact rows the fingerprint below is a function of. Any
  -- concurrent update_merchant_legal_profile/update_merchant_cgv_
  -- profile call on this SAME restaurant_id now blocks until this
  -- transaction ends. If a concurrent writer already committed before
  -- this statement runs, its values are simply what we read (and
  -- fingerprint) below — either way, never an interleaved read.
  perform 1 from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id for update;
  perform 1 from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id for update;

  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  select * into v_template from public.cgv_template where id = p_template_id and status = 'PUBLISHED';
  if not found then
    raise exception using errcode = '22023', message = 'Unknown or unpublished template_id';
  end if;

  select r.country into v_country from public.restaurants r where r.id = p_restaurant_id;
  v_applicable := public._resolve_applicable_cgv_template(v_country);
  if v_applicable.id is null or v_applicable.id <> p_template_id then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_APPLICABLE';
  end if;

  -- ATOMIC COMPARE (v1.2 Blocker 1) — recompute the SAME fingerprint,
  -- now, against the just-locked/current rows, and require an EXACT
  -- match. Any authoritative input that changed since resolution fails
  -- this closed, BEFORE the supersede/insert below — no stale version
  -- inserted, no current version superseded, no partial publication.
  v_actual_fingerprint := public._compute_cgv_publication_context_fingerprint(p_restaurant_id);
  if p_expected_context_fingerprint is null or v_actual_fingerprint <> p_expected_context_fingerprint then
    raise exception using errcode = 'P0001', message = 'STALE_CONTEXT',
      detail = 'authoritative context changed between resolution and persistence';
  end if;

  select * into v_cgv from public.merchant_cgv_profile mcp2 where mcp2.restaurant_id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CGV_INCOMPLETE';
  end if;

  if p_rendered_content is null or btrim(p_rendered_content) = '' then
    raise exception using errcode = '22023', message = 'rendered_content must not be empty';
  end if;

  update public.merchant_cgv_version
     set status = 'SUPERSEDED'
   where restaurant_id = p_restaurant_id and status = 'ACTIVE';

  insert into public.merchant_cgv_version (
    restaurant_id, template_id, template_version, merchant_profile_version,
    locale, presentation_variant, rendered_content, content_hash,
    effective_from, published_at, status
  ) values (
    p_restaurant_id, p_template_id, v_template.version, v_cgv.profile_version,
    'fr',
    coalesce(v_cgv.presentation_variant, 'FORMAL'),
    p_rendered_content,
    md5(p_rendered_content),
    now(), now(), 'ACTIVE'
  )
  returning * into v_new_row;

  update public.merchant_cgv_profile
     set status = case when status = 'CGV_ACTIVE' then 'CGV_ACTIVE' else 'CGV_READY' end,
         updated_at = now()
   where restaurant_id = p_restaurant_id;

  return v_new_row;
end $$;

revoke all on function public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid) from public;
grant execute on function public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid) to service_role;
-- Deliberately NO grant to anon, NO grant to authenticated, NO grant
-- to PUBLIC — unchanged discipline from v1.1, re-asserted by the SQL
-- harness's mandatory Direct RPC Bypass test.

commit;

-- =============================================================================
-- POST-COMMIT VERIFICATION GUARD
-- =============================================================================
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: old 3-arg persist_merchant_cgv_version overload still present after v1.2 -- stale overload.';
  end if;

  if not has_function_privilege('service_role', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: service_role missing EXECUTE on persist_merchant_cgv_version (v1.2).';
  end if;
  if has_function_privilege('authenticated', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated must NOT have EXECUTE on persist_merchant_cgv_version (v1.2).';
  end if;
  if has_function_privilege('anon', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon must NOT have EXECUTE on persist_merchant_cgv_version (v1.2).';
  end if;

  if not has_function_privilege('authenticated', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated missing EXECUTE on resolve_cgv_publication_context after v1.2.';
  end if;
  if has_function_privilege('anon', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon must NOT have EXECUTE on resolve_cgv_publication_context.';
  end if;

  if has_function_privilege('authenticated', 'public._compute_cgv_publication_context_fingerprint(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated must NOT have EXECUTE on the private fingerprint helper.';
  end if;
  if has_function_privilege('authenticated', 'public._assert_legal_cgv_role_for_user(uuid,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated must NOT have EXECUTE on the private user-keyed authorization helper.';
  end if;

  -- This lot never touches create_order — sanity re-confirmation.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_arguments(p.oid) ilike '%p_cgv_accepted%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_order lost p_cgv_accepted -- this lot must never touch create_order.';
  end if;
end $$;

-- =============================================================================
-- Summary of changes relative to v1.1:
--   + public._assert_legal_cgv_role_for_user(uuid,uuid) — new private
--     helper, zero grants.
--   + public._compute_cgv_publication_context_fingerprint(uuid) — new
--     private helper, zero grants.
--   ~ public.assert_legal_cgv_role(uuid) — refactored to delegate to
--     the new helper; same signature, same behavior, same grants.
--   ~ public.resolve_cgv_publication_context(uuid) — dropped and
--     recreated with 2 added output columns (context_fingerprint,
--     acting_user_id); same input signature, same grants
--     (authenticated only), same fail-closed behavior otherwise.
--   ~ public.persist_merchant_cgv_version — dropped 3-arg overload,
--     created new 5-arg overload (p_expected_context_fingerprint,
--     p_acting_user_id added); same grants (service_role only), same
--     fail-closed behavior otherwise, PLUS the new authorization
--     recheck and atomic lock/compare described above.
--   No table changed. No RLS policy changed. No other RPC changed.
--   create_order untouched. No Stuart/Monetico/payment/tracking file
--   touched (SQL-only delta, this file, plus the 3 narrow structural
--   test-inventory updates covered separately).
-- =============================================================================
