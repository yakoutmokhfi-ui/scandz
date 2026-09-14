-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE + ACCEPTANCE SNAPSHOT v1.3
-- SCOPE-REVIEW-APPROVED NARROW REMEDIATION — OPTION A (FULL)
-- DEVELOPMENT ONLY — this file is a forward-only DELTA on top of the
-- already-applied v1.1 and v1.2 migrations. It never edits either of
-- those files (verified pre-flight, section 0 below): same convention
-- as every prior delta in this lot's history.
--
-- Baseline: yakoutmokhfi-ui/scandz, main
--   SHA  11f0e15c6485edd91a6b00c6c599c2169d9e0c08
--   TREE 178f7b575856509eeb94114dc00a34b435b33563
-- (confirmed via `git fetch origin main` before this cycle's work
-- began; a mandatory collision analysis against the newly-published
-- CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 found zero SQL-object
-- collisions and zero table/function name overlap with anything this
-- lot touches — see README-AUDIT.md.)
--
-- Response to the CTO-approved scope review following Cycle 3's FAIL
-- verdict: CGV-V11-PUBLISH-CONTEXT-RACE-01 remains OPEN, with three
-- named residual gaps in the v1.2 remediation. This lot closes exactly
-- those three gaps, and nothing else. CGV-V1-PUBLISH-AUTHORITY-01,
-- CGV-V1-PROD-ACL-01, and CGV-V11-STRUCTURAL-INVENTORY-01 are all
-- confirmed CLOSED and are NOT reopened or redesigned here.
--
-- Approved architecture: OPTION A — keep the existing
--   resolve (as-user) -> Node canonical render -> persist (service_role)
-- pipeline exactly as-is. No second renderer, no SQL-side rendering, no
-- raw/session-scoped PostgreSQL connection introduced. Only the BODIES
-- of two already-existing functions change; NEITHER signature changes,
-- so NO drop statement, NO new grant, and NO change to the v1.2
-- rollback is required (verified post-commit below, and again in the
-- SQL harness's rollback section).
--
-- ------------------------------------------------------------------
-- GAP 1 — fingerprint omission (restaurants.name / seller_name;
-- cgv_template.controlled_sections)
--
-- _compute_cgv_publication_context_fingerprint previously hashed the
-- applicable template's `id` and `version` as a PROXY for its content,
-- relying on the fact that no granted role can ever UPDATE a
-- cgv_template row in place (zero grants on that table, see v1.1's
-- migration) — a correct assumption today, but an assumption, not a
-- proof, and one the fingerprint itself should not need to rest on.
-- It also never hashed `restaurants.name` (the seller_name printed
-- verbatim into the rendered document's "Identité du vendeur"
-- section) at all. Both are now included directly:
--   - `restaurants.name`, alongside the pre-existing `restaurants.
--     country`, in the same identity-field group;
--   - `controlled_sections::text` — `controlled_sections` is a
--     `jsonb` column (not `json`), so PostgreSQL already stores it in
--     a canonical binary form (whitespace-insensitive, key order and
--     duplicate-key handling normalized at the type level) — any text
--     cast of a `jsonb` value is therefore byte-for-byte deterministic
--     for equal JSON content, regardless of how the original value was
--     formatted at insert time. This satisfies "deterministic
--     canonical serialization" with no new function and no explicit
--     key-ordering logic.
-- Every other authoritative field the v1.2 fingerprint already covered
-- (every merchant_legal_profile column, every merchant_cgv_profile
-- column including profile_version and presentation_variant, the
-- template's id+version, the fixed locale literal) is preserved
-- unchanged, in the same order, with the same chr(31) delimiter.
--
-- ------------------------------------------------------------------
-- GAP 2 — insufficient locking (restaurants row not locked;
-- cgv_template row not locked)
--
-- persist_merchant_cgv_version now takes `for update` locks on the
-- COMPLETE authoritative publication context, in a fixed deterministic
-- order, before anything is fingerprinted or mutated:
--   1. restaurants        (NEW)
--   2. merchant_legal_profile
--   3. merchant_cgv_profile
--   4. cgv_template        (NEW — folded into the pre-existing
--      "does p_template_id exist and is it PUBLISHED" lookup, which
--      already had to run a SELECT there; adding FOR UPDATE to that
--      exact statement locks the exact row this function goes on to
--      fingerprint, at no extra statement)
--   5. the authorizing row (NEW — see GAP 3)
-- This is always the same five-step sequence, scoped to exactly one
-- restaurant_id (and one acting_user_id) per call: the only realistic
-- concurrent counterpart is another persist_merchant_cgv_version call
-- for the SAME restaurant, or an update_merchant_legal_profile/
-- update_merchant_cgv_profile call for the SAME restaurant — none of
-- which ever touch `restaurants`, `cgv_template`, `restaurant_users`,
-- or `scanym_operators`. A fixed, always-identical lock order removes
-- deadlock risk by construction, not by chance.
--
-- ------------------------------------------------------------------
-- GAP 3 — authorization race (checked, but not protected against
-- concurrent revocation between the check and the mutation)
--
-- The v1.2 authorization recheck (_assert_legal_cgv_role_for_user) ran
-- as a single unlocked read at the very top of the function — several
-- statements, and therefore a real wall-clock window, before the
-- eventual insert. A concurrent revoke (a DELETE on the caller's
-- restaurant_users row, or on their scanym_operators row) could commit
-- inside that window without ever being observed.
--
-- Fixed by locking the SPECIFIC authorizing row(s) for p_acting_user_id
-- — their restaurant_users row for THIS restaurant_id (composite PK
-- (user_id, restaurant_id), a single-row lock) AND their
-- scanym_operators row (PK user_id) — BEFORE calling
-- _assert_legal_cgv_role_for_user (itself UNCHANGED: same signature,
-- same body, same two-tier owner/manager-then-operator logic). Locking
-- a row that does not exist is a no-op (zero rows matched, nothing to
-- lock) — whichever row currently grants this user's authority (if
-- either does) is the one that matters, and it is now genuinely
-- protected: a concurrent DELETE on that exact row cannot complete
-- until this transaction ends, so the two operations can never
-- interleave in a torn state. Whichever transaction reaches the lock
-- first proceeds, per ordinary PostgreSQL semantics — this does not
-- guarantee a revoke always wins, it guarantees the two cannot
-- partially overlap, which is the actual property required.
--
-- =============================================================================

-- ------------------------------------------------------------------
-- 0. PRE-FLIGHT: v1.1+v1.2 must already be applied EXACTLY as shipped
--    (same 5-argument persist_merchant_cgv_version, same fingerprint
--    helper, same private role-check helper — this lot changes their
--    BODIES only, never their signatures/existence), and this lot must
--    not have already been applied (anti-double-apply). Nothing here
--    checks for a NEW object, because this lot introduces none.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) (v1.2) introuvable -- v1.1+v1.2 doivent être appliqués avant v1.3, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _compute_cgv_publication_context_fingerprint (v1.2) introuvable -- v1.1+v1.2 doivent être appliqués avant v1.3, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_assert_legal_cgv_role_for_user'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _assert_legal_cgv_role_for_user (v1.2) introuvable -- v1.1+v1.2 doivent être appliqués avant v1.3, annulé.';
  end if;

  -- Anti-double-apply : si la fonction contient déjà une référence à
  -- restaurants (verrouillage) au-delà de la simple lecture de country
  -- déjà présente en v1.2, on ne peut pas le détecter fiablement par
  -- introspection de pg_proc (le corps n'est pas structuré) -- ce
  -- garde-fou anti-double-apply s'appuie donc, comme pour toute
  -- CREATE OR REPLACE de ce projet qui ne change pas de signature, sur
  -- la discipline opérationnelle (un seul apply par environnement),
  -- pas sur une détection automatique. Documenté explicitement plutôt
  -- que de prétendre à une garantie qui n'existe pas.
end $$;

begin;

-- ------------------------------------------------------------------
-- A. _compute_cgv_publication_context_fingerprint — CREATE OR REPLACE,
--    same signature/return type (text), same grants (unaffected by
--    CREATE OR REPLACE when signature is unchanged). Adds
--    restaurants.name and controlled_sections::text to the digest;
--    every other field, delimiter, and ordering choice is unchanged
--    from v1.2.
-- ------------------------------------------------------------------
create or replace function public._compute_cgv_publication_context_fingerprint(p_restaurant_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name     text;
  v_country  text;
  v_legal    public.merchant_legal_profile%rowtype;
  v_cgv      public.merchant_cgv_profile%rowtype;
  v_template public.cgv_template%rowtype;
  v_sep      constant text := chr(31);
begin
  select r.name, r.country into v_name, v_country from public.restaurants r where r.id = p_restaurant_id;
  select * into v_legal from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id;
  select * into v_cgv from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id;
  v_template := public._resolve_applicable_cgv_template(v_country);

  return md5(
    coalesce(v_country, '') || v_sep ||
    -- v1.3 GAP 1 — seller_name is printed verbatim into the rendered
    -- document; a concurrent rename must invalidate the fingerprint
    -- exactly like any other authoritative-input change.
    coalesce(v_name, '') || v_sep ||
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
    -- v1.3 GAP 1 — actual authoritative template CONTENT, never just
    -- id/version as a substitute for it. `controlled_sections` is
    -- `jsonb` (not `json`): PostgreSQL normalizes jsonb to a canonical
    -- binary form on storage, so this text cast is deterministic for
    -- equal JSON content regardless of original formatting/whitespace
    -- — no explicit key-ordering logic is required.
    coalesce(v_template.controlled_sections::text, '') || v_sep ||
    -- locale: fixed ('fr') for all of v1 scope at every layer (render,
    -- resolve, persist) — included as a literal so that the day it is
    -- derived from mutable merchant/template state, coverage is
    -- already correct without another remediation cycle.
    'fr'
  );
end $$;

-- No grant statement here: CREATE OR REPLACE on an unchanged signature
-- leaves all existing grants exactly as they were (verified post-
-- commit below) — this function had zero grants before (private
-- helper) and has zero grants after.

-- ------------------------------------------------------------------
-- B. persist_merchant_cgv_version — CREATE OR REPLACE, same 5-argument
--    signature/return type, same grants (service_role EXECUTE only,
--    unaffected by CREATE OR REPLACE when signature is unchanged).
--    Adds the MANDATORY LOCK SET (restaurants, cgv_template, the
--    authorizing row) in the fixed deterministic order from the scope
--    review, and moves the authorization determination to run WHILE
--    HOLDING the authorizing row's lock instead of as an earlier,
--    unlocked read. Every other check (completeness, template-
--    applicability, fingerprint compare, supersede+insert, profile-
--    status update) is otherwise IDENTICAL in logic to v1.2 — only its
--    position relative to the now-earlier locks/auth-check moved.
-- ------------------------------------------------------------------
create or replace function public.persist_merchant_cgv_version(
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
  -- MANDATORY LOCK SET (v1.3 GAP 2/3) — fixed deterministic order:
  -- restaurants -> merchant_legal_profile -> merchant_cgv_profile ->
  -- cgv_template -> authorizing row. Every lock is acquired BEFORE
  -- authorization is determined and BEFORE the final context
  -- comparison/mutation, so nothing checked below can be invalidated
  -- by a concurrent writer for the remainder of this transaction. This
  -- exact sequence is scoped to one restaurant_id (and one
  -- acting_user_id) per call, so the only realistic concurrent
  -- counterpart never touches more than a strict subset of these same
  -- five rows — a fixed order removes deadlock risk by construction.

  -- 1. restaurants (NEW in v1.3) — same row _compute_cgv_publication_
  --    context_fingerprint reads for seller_name/country.
  select r.country into v_country from public.restaurants r where r.id = p_restaurant_id for update;

  -- 2/3. merchant_legal_profile / merchant_cgv_profile (unchanged from
  --    v1.2 — a concurrent update_merchant_legal_profile/update_
  --    merchant_cgv_profile call on this restaurant genuinely blocks
  --    until this transaction ends).
  perform 1 from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id for update;
  perform 1 from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id for update;

  -- 4. cgv_template (NEW in v1.3) — folded into the pre-existing
  --    exists-and-published lookup; no extra statement, the same query
  --    that already had to run now also takes the lock.
  select * into v_template from public.cgv_template where id = p_template_id and status = 'PUBLISHED' for update;
  if not found then
    raise exception using errcode = '22023', message = 'Unknown or unpublished template_id';
  end if;

  -- 5. authorizing row (NEW in v1.3) — whichever of these two rows (if
  --    either) currently grants p_acting_user_id's publication
  --    authority for this restaurant. Locking a row that does not
  --    exist is a no-op: zero rows matched, nothing to lock.
  perform 1 from public.restaurant_users ru
    where ru.user_id = p_acting_user_id and ru.restaurant_id = p_restaurant_id for update;
  perform 1 from public.scanym_operators so where so.user_id = p_acting_user_id for update;

  -- AUTHORIZATION RECHECK (v1.2), now DETERMINED WHILE HOLDING the
  -- authorizing row's lock (v1.3 GAP 3) instead of as an earlier,
  -- unlocked read — a role revoked before this point is caught here
  -- exactly as in v1.2; a role revoked AFTER this point cannot
  -- complete until this transaction ends, because the row is already
  -- locked above. _assert_legal_cgv_role_for_user itself is UNCHANGED.
  perform public._assert_legal_cgv_role_for_user(p_restaurant_id, p_acting_user_id);

  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  v_applicable := public._resolve_applicable_cgv_template(v_country);
  if v_applicable.id is null or v_applicable.id <> p_template_id then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_APPLICABLE';
  end if;

  -- ATOMIC COMPARE (v1.2, WIDENED in v1.3 — see fingerprint helper
  -- above) — recompute the SAME fingerprint, now, against the
  -- just-locked/current rows (including seller_name and the actual
  -- template content), and require an EXACT match. Any authoritative
  -- input that changed since resolution fails this closed, BEFORE the
  -- supersede/insert below — no stale version inserted, no current
  -- version superseded, no partial publication.
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

-- No grant statement here either — same reasoning as section A.

commit;

-- ------------------------------------------------------------------
-- POST-COMMIT VERIFICATION (own implicit transaction) — confirms
-- signatures/grants are BYTE-IDENTICAL to v1.2's, i.e. that this lot
-- changed exactly what it was authorized to change and nothing else.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_POST_VERIFY: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) introuvable après v1.3 -- signature accidentellement changée.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) <>
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_POST_VERIFY: un overload INATTENDU de persist_merchant_cgv_version existe après v1.3 -- signature changée par erreur.';
  end if;

  if not has_function_privilege('service_role',
      'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: service_role a perdu EXECUTE sur persist_merchant_cgv_version -- grant régressé par v1.3.';
  end if;
  if has_function_privilege('authenticated',
      'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: authenticated a EXECUTE sur persist_merchant_cgv_version -- régression d''autorité (CGV-V1-PUBLISH-AUTHORITY-01/CGV-V1-PROD-ACL-01).';
  end if;
  if has_function_privilege('anon',
      'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: anon a EXECUTE sur persist_merchant_cgv_version -- régression d''autorité.';
  end if;

  if has_function_privilege('authenticated',
      'public._compute_cgv_publication_context_fingerprint(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: _compute_cgv_publication_context_fingerprint a un grant EXECUTE -- helper privé régressé.';
  end if;

  -- resolve_cgv_publication_context est INCHANGÉE par ce lot (aucune
  -- ligne de son corps ni de sa signature n'est touchée ici) ; son
  -- grant EXECUTE pour authenticated doit rester intact.
  if not has_function_privilege('authenticated',
      'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: authenticated a perdu EXECUTE sur resolve_cgv_publication_context -- régression inattendue (fonction non touchée par v1.3).';
  end if;

  -- create_order reste totalement hors du périmètre de ce lot.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_identity_arguments(p.oid) like '%p_cgv_accepted%'
  ) then
    raise exception 'SCANYM_POST_VERIFY: create_order a perdu p_cgv_accepted -- ce lot ne doit JAMAIS toucher create_order.';
  end if;
end $$;

-- =============================================================================
-- RÉSUMÉ v1.3 : deux CREATE OR REPLACE, zéro nouvel objet, zéro
-- changement de signature, zéro changement de grant, zéro fichier
-- TypeScript modifié pour cette remédiation fonctionnelle (le rendu
-- Node, la forme de requête/réponse HTTP, et la forme envoyée par le
-- navigateur restent BYTE-IDENTIQUES à v1.2). Le rollback v1.2 existant
-- reste valide sans modification : il DROP les deux fonctions par leur
-- signature exacte, inchangée par ce lot -- quel que soit le corps
-- qu'elles contiennent au moment du DROP.
-- =============================================================================
