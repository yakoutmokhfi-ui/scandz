-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE + ACCEPTANCE SNAPSHOT v1.4
-- SCOPE-REVIEW-APPROVED NARROW REMEDIATION — SERIALIZATION-ONLY FIX
-- DEVELOPMENT ONLY — this file is a forward-only DELTA on top of the
-- already-applied v1.1, v1.2 and v1.3 migrations. It never edits any of
-- those files (verified pre-flight, section 0 below): same convention
-- as every prior delta in this lot's history.
--
-- Baseline: yakoutmokhfi-ui/scandz, main
--   SHA  11f0e15c6485edd91a6b00c6c599c2169d9e0c08
--   TREE 178f7b575856509eeb94114dc00a34b435b33563
--
-- ------------------------------------------------------------------
-- THE BUG (audit finding, post-v1.3)
--
-- v1.3's _compute_cgv_publication_context_fingerprint concatenates every
-- authoritative field with chr(31) (ASCII Unit Separator) as a field
-- delimiter, then md5()s the concatenation. This is an AMBIGUOUS
-- serialization: nothing in the schema prevents chr(31) from appearing
-- INSIDE a merchant-entered text field (legal_form, address_line1,
-- address_line2, city, cancellation_policy_text, ... — all plain
-- unconstrained `text` columns, reachable via update_merchant_legal_
-- profile / update_merchant_cgv_profile, both of which accept arbitrary
-- text from an authenticated owner/manager/operator). When a delimiter
-- byte lands inside one field's content, it is indistinguishable from a
-- genuine field boundary — two semantically DIFFERENT authoritative
-- states can concatenate to the IDENTICAL byte string, and therefore
-- hash to the IDENTICAL fingerprint.
--
-- Concrete collision pair (see the v1.4 harness, test T1):
--   State A: legal_form = 'SARL'
--            address_line1 = 'Rue' || chr(31) || '42'
--   State B: legal_form = 'SARL' || chr(31) || 'Rue'
--            address_line1 = '42'
-- Both concatenate (with the chr(31) separator already used between
-- legal_form and address_line1) to the same bytes:
--   'SARL' || chr(31) || 'Rue' || chr(31) || '42'
-- -> same md5(), even though the two states are not the same data.
--
-- A fingerprint is supposed to make "the authoritative context changed"
-- and "the authoritative context did not change" DISTINGUISHABLE
-- (persist_merchant_cgv_version's entire STALE_CONTEXT defense, added in
-- v1.2/v1.3, rests on that property). A delimiter-based concatenation
-- over unconstrained text fields cannot guarantee it. This is a
-- correctness gap in the fingerprint's SERIALIZATION, not in which
-- fields it covers (v1.3's field inventory, closed by GAP 1, is
-- complete and unchanged here) nor in its locking (v1.3's GAP 2/3 locks,
-- in persist_merchant_cgv_version, are untouched by this lot).
--
-- ------------------------------------------------------------------
-- THE FIX — canonical JSON serialization instead of delimited concatenation
--
-- Every authoritative field v1.3 already hashed is now placed into a
-- single jsonb_build_object(...) call under a fixed, literal, self-
-- documenting key (e.g. 'legal_form', 'address_line1', ...) instead of
-- being concatenated with a delimiter character. jsonb_build_object
-- (via to_jsonb under the hood) escapes every value as a proper JSON
-- string: a chr(31), a chr(30), a double quote, a backslash, or any
-- other byte inside a field's content is encoded IN PLACE inside that
-- field's own JSON string value — it can never be mistaken for a key
-- boundary, because JSON key/value structure is delimited by syntax
-- (quotes, colons, commas, braces), not by a single reserved byte value
-- that user content might also contain. Two different authoritative
-- states can no longer produce the same serialized bytes by shifting a
-- delimiter into content (see harness tests T1-T4).
--
-- Three further precision fixes, required for the serialization to be
-- unambiguous in general (not just for the specific chr(31) collision):
--   - NULL vs '' (empty string) are now DISTINGUISHABLE. v1.3's
--     coalesce(v_x, '') mapped both "field is NULL" and "field is the
--     empty string" to the same output. Every coalesce(...) wrapper is
--     removed here: a NULL column now produces a genuine JSON `null` for
--     that key, an empty string produces `""` — two different JSON
--     values, two different fingerprints (harness test T3).
--   - `controlled_sections` is nested as a NATIVE jsonb value inside the
--     outer jsonb_build_object call (never controlled_sections::text).
--     jsonb already normalizes to a canonical binary form on storage
--     (whitespace-insensitive, key order and duplicate-key handling
--     normalized at the type level — this was already true and relied
--     upon in v1.3); nesting it natively keeps that guarantee AND avoids
--     re-introducing a text-level ambiguity by stringifying it before
--     the final text cast (harness tests T6/T7).
--   - The finished jsonb object is cast to text EXACTLY ONCE, as the
--     very last step (`jsonb_build_object(...)::text`), then wrapped in
--     md5(...). There is no intermediate string concatenation anywhere
--     in the function body — the only place raw bytes are ever
--     assembled into one string is PostgreSQL's own deterministic jsonb
--     output routine, not ad hoc delimiter-joining.
--
-- Every authoritative field v1.3 covered is preserved here, with
-- nothing added and nothing dropped (see the field-by-field key list in
-- section A below, and README-AUDIT.md for the side-by-side inventory
-- against v1.3). The function's signature and return type
-- (p_restaurant_id uuid) -> text are UNCHANGED: this is a
-- serialization-only change to what happens *inside* the existing
-- helper, not a change to what it takes or returns, and not a change to
-- any other function. persist_merchant_cgv_version (its locking, its
-- authorization recheck, its STALE_CONTEXT comparison) is NOT modified
-- by this lot — it already calls this same helper by name and compares
-- the result to a caller-supplied fingerprint exactly as before; it
-- gets the collision fix "for free" because the helper it calls is
-- fixed underneath it, with no change to persist_merchant_cgv_version's
-- own body required or made.
--
-- No drop statement, no new grant, and no change to the v1.2 rollback
-- is required (verified post-commit below, and again in the SQL
-- harness's rollback section) — same reasoning as v1.3's own header:
-- signature unchanged, so CREATE OR REPLACE preserves existing grants
-- (zero grants before, zero grants after — this remains a private
-- helper, never callable directly by any granted role).
--
-- =============================================================================

-- ------------------------------------------------------------------
-- 0. PRE-FLIGHT: v1.1+v1.2+v1.3 must already be applied EXACTLY as
--    shipped (same _compute_cgv_publication_context_fingerprint(uuid)
--    returns text, same 5-argument persist_merchant_cgv_version — this
--    lot changes the BODY of the former only, never any signature), and
--    this lot must not have already been applied (anti-double-apply,
--    detected here by introspecting the current function body for the
--    jsonb_build_object marker this lot introduces — unlike v1.1/v1.2/
--    v1.3's own preflights, which could only document the limits of
--    body introspection, this lot's replacement is textually
--    detectable because it is a full rewrite of the return expression).
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) = 'text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _compute_cgv_publication_context_fingerprint(uuid) returns text (v1.3) introuvable -- v1.1+v1.2+v1.3 doivent être appliqués avant v1.4, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) (v1.3) introuvable -- v1.1+v1.2+v1.3 doivent être appliqués avant v1.4, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_assert_legal_cgv_role_for_user'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _assert_legal_cgv_role_for_user (v1.2) introuvable -- v1.1+v1.2+v1.3 doivent être appliqués avant v1.4, annulé.';
  end if;

  -- Anti-double-apply : contrairement à v1.1/v1.2/v1.3 (dont le
  -- remplacement restait une concaténation, indétectable de façon
  -- fiable par introspection), le remplacement introduit par CE lot est
  -- une réécriture complète de l'expression de retour vers
  -- jsonb_build_object(...)::text -- sa présence dans le corps actuel
  -- est donc un signal fiable que v1.4 a déjà été appliqué ici.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
      and pg_get_functiondef(p.oid) ilike '%jsonb_build_object%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _compute_cgv_publication_context_fingerprint utilise déjà jsonb_build_object -- v1.4 semble déjà appliqué sur cet environnement, annulé (anti-double-apply).';
  end if;
end $$;

begin;

-- ------------------------------------------------------------------
-- A. _compute_cgv_publication_context_fingerprint — CREATE OR REPLACE,
--    same signature/return type (text), same grants (unaffected by
--    CREATE OR REPLACE when signature is unchanged). Replaces the
--    chr(31)-delimited concatenation with a canonical JSON object,
--    cast to text exactly once, then md5()'d. Data-gathering (the
--    three SELECTs and the template resolution) is byte-identical to
--    v1.3 — only the final serialization/hash expression changes.
--
--    Field inventory (25 keys — identical set to v1.3's 24 concatenated
--    fields + the 'fr' locale literal; nothing added, nothing dropped):
--      restaurant_country, restaurant_name,
--      legal_form, address_line1, address_line2, postal_code, city,
--      governing_country, customer_service_email, customer_service_phone,
--      consumer_mediator_name, consumer_mediator_address,
--      consumer_mediator_website,
--      withdrawal_regime, preparation_time_min, preparation_time_max,
--      preparation_time_unit, cancellation_policy_text,
--      substitution_policy_text, presentation_variant, profile_version,
--      template_id, template_version, controlled_sections (native
--      jsonb, not ::text), locale (fixed literal 'fr').
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
begin
  select r.name, r.country into v_name, v_country from public.restaurants r where r.id = p_restaurant_id;
  select * into v_legal from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id;
  select * into v_cgv from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id;
  v_template := public._resolve_applicable_cgv_template(v_country);

  -- v1.4 FIX: canonical JSON object, no delimiter, no ambiguity. Every
  -- field is passed RAW (no coalesce(...,'')) so that NULL produces a
  -- genuine JSON null, never an empty string masquerading as one.
  -- controlled_sections is nested as native jsonb (never ::text) —
  -- PostgreSQL's own jsonb canonicalization (whitespace/key-order/
  -- duplicate-key normalized at the type level) does the rest. The
  -- ENTIRE object is cast to text exactly once, as the last step,
  -- immediately before md5().
  return md5(
    jsonb_build_object(
      'restaurant_country',          v_country,
      'restaurant_name',             v_name,
      'legal_form',                  v_legal.legal_form,
      'address_line1',               v_legal.address_line1,
      'address_line2',               v_legal.address_line2,
      'postal_code',                 v_legal.postal_code,
      'city',                        v_legal.city,
      'governing_country',           v_legal.governing_country,
      'customer_service_email',      v_legal.customer_service_email,
      'customer_service_phone',      v_legal.customer_service_phone,
      'consumer_mediator_name',      v_legal.consumer_mediator_name,
      'consumer_mediator_address',   v_legal.consumer_mediator_address,
      'consumer_mediator_website',   v_legal.consumer_mediator_website,
      'withdrawal_regime',           v_cgv.withdrawal_regime,
      'preparation_time_min',        v_cgv.preparation_time_min,
      'preparation_time_max',        v_cgv.preparation_time_max,
      'preparation_time_unit',       v_cgv.preparation_time_unit,
      'cancellation_policy_text',    v_cgv.cancellation_policy_text,
      'substitution_policy_text',    v_cgv.substitution_policy_text,
      'presentation_variant',        v_cgv.presentation_variant,
      'profile_version',             v_cgv.profile_version,
      'template_id',                 v_template.id,
      'template_version',            v_template.version,
      'controlled_sections',         v_template.controlled_sections,
      'locale',                      'fr'
    )::text
  );
end $$;

-- No grant statement here: CREATE OR REPLACE on an unchanged signature
-- leaves all existing grants exactly as they were (verified post-
-- commit below) — this function had zero grants before (private
-- helper) and has zero grants after.
--
-- persist_merchant_cgv_version itself is NOT touched by this lot: no
-- CREATE OR REPLACE, no DROP, no grant change. It already calls
-- public._compute_cgv_publication_context_fingerprint(p_restaurant_id)
-- by name and compares the result to p_expected_context_fingerprint —
-- it automatically picks up this lot's fixed serialization the next
-- time it runs, with zero change to its own source.

commit;

-- ------------------------------------------------------------------
-- POST-COMMIT VERIFICATION (own implicit transaction) — confirms
-- signatures/grants are BYTE-IDENTICAL to v1.3's, i.e. that this lot
-- changed exactly what it was authorized to change (one function BODY)
-- and nothing else.
-- ------------------------------------------------------------------
do $$
begin
  -- Signature/return type of the fingerprint helper unchanged.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) = 'text'
  ) then
    raise exception 'SCANYM_POST_VERIFY: _compute_cgv_publication_context_fingerprint(uuid) returns text introuvable après v1.4 -- signature accidentellement changée.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
      and pg_get_function_identity_arguments(p.oid) <> 'p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_POST_VERIFY: un overload INATTENDU de _compute_cgv_publication_context_fingerprint existe après v1.4 -- signature changée par erreur.';
  end if;

  -- The fix actually took effect (positive control — catches a
  -- no-op CREATE OR REPLACE or a body that silently reverted).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
      and pg_get_functiondef(p.oid) ilike '%jsonb_build_object%'
  ) then
    raise exception 'SCANYM_POST_VERIFY: _compute_cgv_publication_context_fingerprint ne contient pas jsonb_build_object après v1.4 -- le remplacement n''a pas pris effet.';
  end if;

  -- persist_merchant_cgv_version : signature UNCHANGED, and this lot
  -- must NEVER have touched it (no CREATE OR REPLACE for it appears
  -- anywhere above — this check simply reconfirms it still exists
  -- exactly as v1.3 left it).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_POST_VERIFY: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) introuvable après v1.4 -- ce lot ne doit JAMAIS toucher cette fonction.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) <>
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_POST_VERIFY: un overload INATTENDU de persist_merchant_cgv_version existe après v1.4 -- signature changée par erreur alors que ce lot ne doit jamais toucher cette fonction.';
  end if;

  -- Grants: no new grant anywhere, none regressed.
  if not has_function_privilege('service_role',
      'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: service_role a perdu EXECUTE sur persist_merchant_cgv_version -- grant régressé par v1.4 (alors que cette fonction n''a même pas été touchée).';
  end if;
  if has_function_privilege('authenticated',
      'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: authenticated a EXECUTE sur persist_merchant_cgv_version -- régression d''autorité.';
  end if;
  if has_function_privilege('anon',
      'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: anon a EXECUTE sur persist_merchant_cgv_version -- régression d''autorité.';
  end if;

  if has_function_privilege('authenticated',
      'public._compute_cgv_publication_context_fingerprint(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: _compute_cgv_publication_context_fingerprint a un grant EXECUTE -- helper privé régressé (aucun grant n''a jamais été ajouté par v1.4, aucun ne doit apparaître).';
  end if;
  if has_function_privilege('anon',
      'public._compute_cgv_publication_context_fingerprint(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: _compute_cgv_publication_context_fingerprint a un grant EXECUTE pour anon -- helper privé régressé.';
  end if;

  -- resolve_cgv_publication_context est totalement INCHANGÉE par ce lot.
  if not has_function_privilege('authenticated',
      'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_VERIFY: authenticated a perdu EXECUTE sur resolve_cgv_publication_context -- régression inattendue (fonction non touchée par v1.4).';
  end if;

  -- create_order reste totalement hors du périmètre de ce lot.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_identity_arguments(p.oid) like '%p_cgv_accepted%'
  ) then
    raise exception 'SCANYM_POST_VERIFY: create_order a perdu p_cgv_accepted -- ce lot ne doit JAMAIS toucher create_order.';
  end if;

  -- Aucune table nouvelle et aucun droit de table nouveau ne doit être
  -- apparu — ce lot ne fait qu'un CREATE OR REPLACE sur une seule
  -- fonction, zéro DDL de table.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon','authenticated')
      and table_name in ('merchant_legal_profile','cgv_template','merchant_cgv_profile','merchant_cgv_version','order_cgv_acceptance')
      and privilege_type <> 'SELECT'
  ) then
    raise exception 'SCANYM_POST_VERIFY: un grant de table INATTENDU (autre que SELECT pour authenticated) existe sur une table CGV après v1.4.';
  end if;
end $$;

-- =============================================================================
-- RÉSUMÉ v1.4 : UN SEUL CREATE OR REPLACE (le corps de
-- _compute_cgv_publication_context_fingerprint uniquement), zéro nouvel
-- objet, zéro changement de signature, zéro changement de grant, zéro
-- fichier TypeScript modifié pour cette remédiation (le rendu Node, la
-- forme de requête/réponse HTTP, et la forme envoyée par le navigateur
-- restent BYTE-IDENTIQUES à v1.3 — cette fonction est un helper SQL
-- privé, jamais appelé depuis Node). persist_merchant_cgv_version n'est
-- ni recréée ni modifiée : elle continue d'appeler ce même helper par
-- son nom et hérite du correctif sans qu'une seule ligne de son propre
-- corps ne change. Le rollback v1.2 existant reste valide sans
-- modification : il DROP les deux fonctions par leur signature exacte,
-- inchangée par ce lot -- quel que soit le corps qu'elles contiennent
-- au moment du DROP.
-- =============================================================================
