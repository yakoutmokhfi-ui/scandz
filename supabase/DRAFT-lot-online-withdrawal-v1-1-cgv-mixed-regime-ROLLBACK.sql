-- =============================================================================
-- SCANYM — ONLINE WITHDRAWAL v1.1 — RÉGIME MIXTE — ROLLBACK
-- DRAFT ONLY.
-- =============================================================================
-- Remet les TROIS fonctions du moteur CGV dans leur forme antérieure :
-- cgv_completeness_errors dans sa forme CGV ENGINE v1.1 (MIXED refusé
-- par principe) et resolve_cgv_publication_context /
-- persist_merchant_cgv_version dans leur forme CGV ENGINE v2.5 (garde
-- de fonctionnalité en ligne limitée à STANDARD_14_DAYS). Les corps
-- ci-dessous sont repris À L'IDENTIQUE de ces deux fichiers.
--
-- CE ROLLBACK NE TOUCHE À AUCUNE DONNÉE : ni merchant_cgv_version, ni
-- order_cgv_acceptance, ni cgv_template. Un marchand MIXTE ayant publié
-- entre-temps conserve sa version publiée -- il ne pourra simplement
-- plus en publier de nouvelle, le régime redevenant refusé par
-- principe. Les instantanés légaux de ligne déjà pris ne sont pas
-- réécrits (ils sont immuables par construction) : le rollback du
-- fichier de fondation traite leur cas séparément.
-- =============================================================================

begin;

create or replace function public.cgv_completeness_errors(p_restaurant_id uuid)
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

create or replace function public.resolve_cgv_publication_context(p_restaurant_id uuid)
returns table (
  restaurant_id                     uuid,
  seller_name                       text,
  template_id                       uuid,
  template_version                  integer,
  controlled_sections               jsonb,
  merchant_profile_version          integer,
  locale                             text,
  presentation_variant              text,
  legal_form                         text,
  address_line1                     text,
  address_line2                     text,
  postal_code                       text,
  city                               text,
  governing_country                 text,
  customer_service_email            text,
  customer_service_phone            text,
  mediator_name                     text,
  mediator_address                  text,
  mediator_website                  text,
  withdrawal_regime                 text,
  preparation_time_min              integer,
  preparation_time_max              integer,
  preparation_time_unit             text,
  cancellation_policy_text          text,
  substitution_policy_text          text,
  context_fingerprint               text,
  acting_user_id                    uuid,
  legal_entity_name                 text,
  siren                              text,
  siret                              text,
  vat_number                        text,
  consumer_mediator_phone           text,
  consumer_mediator_email           text,
  cold_chain_applicable              boolean,
  weight_pricing_mode                text,
  online_withdrawal_function_gap     boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors                          text[];
  v_country                         text;
  v_name                             text;
  v_legal                           public.merchant_legal_profile%rowtype;
  v_cgv                             public.merchant_cgv_profile%rowtype;
  v_template                        public.cgv_template%rowtype;
  v_uid                              uuid;
  v_online_withdrawal_function_gap  boolean;
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
  -- pin-or-default aware resolution (v2.2, unchanged here); `v_country`
  -- above is still selected (used for nothing else in this function)
  -- but is not fed into this call directly.
  v_template := public._resolve_applicable_cgv_template(p_restaurant_id);

  if v_template.id is null then
    raise exception using errcode = 'P0001', message = 'TEMPLATE_UNRESOLVED';
  end if;

  -- v2.4 -- pure function of withdrawal_regime, computed here so it is
  -- derived from the SAME authoritative merchant_cgv_profile row this
  -- function already read above, never a second, independent read.
  v_online_withdrawal_function_gap := (v_cgv.withdrawal_regime = 'STANDARD_14_DAYS');

  -- CGV ENGINE v2.5 (Task 4) -- ENFORCED, not merely advisory. v2.4's
  -- own output column above stays exactly as it was (still purely
  -- informational for any caller that reads it) -- this is a SEPARATE,
  -- additional fail-closed gate, checked here too (defense in depth,
  -- per mandate: "check both" resolve_cgv_publication_context and
  -- persist_merchant_cgv_version) so a STANDARD_14_DAYS merchant
  -- without the statutory online withdrawal function is stopped at the
  -- FIRST call of the real publish flow (lib/server/legal-cgv-publish-
  -- service.ts), before renderCgv() even runs -- never merely at the
  -- final persist_merchant_cgv_version boundary. EXEMPT_PERISHABLE
  -- (Au Lait Cru) never reaches this branch.
  if v_online_withdrawal_function_gap and not public._scanym_has_online_withdrawal_runtime() then
    raise exception using errcode = 'P0001', message = 'WITHDRAWAL_RUNTIME_NOT_READY',
      detail = 'This merchant''s withdrawal regime (STANDARD_14_DAYS) legally requires a statutory online withdrawal-request function; Scanym''s runtime does not currently provide one -- publication is blocked until either the runtime function ships or the merchant''s regime/configuration changes.';
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
    v_uid,
    v_legal.legal_entity_name, v_legal.siren, v_legal.siret, v_legal.vat_number,
    v_legal.consumer_mediator_phone, v_legal.consumer_mediator_email,
    v_cgv.cold_chain_applicable, v_cgv.weight_pricing_mode,
    v_online_withdrawal_function_gap;
end $$;

revoke all on function public.resolve_cgv_publication_context(uuid) from public;
grant execute on function public.resolve_cgv_publication_context(uuid) to authenticated;

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
  v_weight_pricing_mode text;
  -- CGV ENGINE v2.5 (Task 4) -- same top-of-function fail-closed
  -- placement/style as v_weight_pricing_mode/ACTUAL_WEIGHT_PRICE_
  -- UNSUPPORTED immediately below.
  v_withdrawal_regime_early text;
begin
  select weight_pricing_mode, withdrawal_regime
    into v_weight_pricing_mode, v_withdrawal_regime_early
  from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;

  if v_weight_pricing_mode = 'ACTUAL_WEIGHT_PRICE' then
    raise exception using errcode = 'P0001', message = 'ACTUAL_WEIGHT_PRICE_UNSUPPORTED',
      detail = 'Scanym does not currently support price recalculation based on actual post-preparation weight; configure FIXED_PORTION_PRICE or leave weight_pricing_mode null.';
  end if;

  -- CGV ENGINE v2.5 (Task 4) -- ENFORCED fail-closed guard, upgrading
  -- v2.4's purely-advisory `online_withdrawal_function_gap` output
  -- column (resolve_cgv_publication_context, unchanged by this check)
  -- into an actual publication blocker, exactly like
  -- ACTUAL_WEIGHT_PRICE_UNSUPPORTED above. STANDARD_14_DAYS is the
  -- ONLY regime with a real withdrawal right, hence the ONLY one the
  -- statutory online-withdrawal-function obligation could ever apply
  -- to -- EXEMPT_PERISHABLE (Au Lait Cru) is NEVER blocked by this
  -- check, regardless of `public._scanym_has_online_withdrawal_runtime()`'s
  -- value, because the condition below is never even evaluated for it.
  if v_withdrawal_regime_early = 'STANDARD_14_DAYS'
     and not public._scanym_has_online_withdrawal_runtime()
  then
    raise exception using errcode = 'P0001', message = 'WITHDRAWAL_RUNTIME_NOT_READY',
      detail = 'This merchant''s withdrawal regime (STANDARD_14_DAYS) legally requires a statutory online withdrawal-request function; Scanym''s runtime does not currently provide one (verified: no such route/service/order-lifecycle code exists) -- publication is blocked until either the runtime function ships or the merchant''s regime/configuration changes.';
  end if;

  -- MANDATORY LOCK SET (v1.3 GAP 2/3, UNCHANGED) -- fixed deterministic
  -- order: restaurants -> merchant_legal_profile -> merchant_cgv_profile
  -- -> cgv_template -> authorizing row. `v_country` is kept only for
  -- this lock's own read -- it is NOT fed into the template-resolution
  -- call below any more (v2.2: that call now takes p_restaurant_id
  -- directly, which also internally re-derives + re-locks-consistent
  -- country and re-reads merchant_cgv_profile.pinned_template_id --
  -- merchant_cgv_profile is already locked FOR UPDATE by this same
  -- function two statements below, so that internal read sees a
  -- transaction-consistent value, no new lock required).
  select r.country into v_country from public.restaurants r where r.id = p_restaurant_id for update;

  perform 1 from public.merchant_legal_profile mlp where mlp.restaurant_id = p_restaurant_id for update;
  perform 1 from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id for update;

  select * into v_template from public.cgv_template where id = p_template_id and status = 'PUBLISHED' for update;
  if not found then
    raise exception using errcode = '22023', message = 'Unknown or unpublished template_id';
  end if;

  perform 1 from public.restaurant_users ru
    where ru.user_id = p_acting_user_id and ru.restaurant_id = p_restaurant_id for update;
  perform 1 from public.scanym_operators so where so.user_id = p_acting_user_id for update;

  perform public._assert_legal_cgv_role_for_user(p_restaurant_id, p_acting_user_id);

  v_errors := public.cgv_completeness_errors(p_restaurant_id);
  if array_length(v_errors, 1) is not null then
    raise exception using errcode = 'P0001',
      message = 'CGV_INCOMPLETE', detail = array_to_string(v_errors, ',');
  end if;

  -- v2.2 -- APPLICABLE TEMPLATE AUTHORITY, pin-or-default aware. Never
  -- trust p_template_id merely because it names a PUBLISHED row
  -- somewhere -- independently re-resolve the template this restaurant
  -- is ACTUALLY entitled to (pinned row if set and valid, else the
  -- is_default row for its jurisdiction) and require an EXACT id
  -- match. A broken pin raises PINNED_TEMPLATE_INVALID from inside the
  -- helper itself -- propagated here with zero side effects, since it
  -- is raised before this function's own INSERT/UPDATE statements run.
  v_applicable := public._resolve_applicable_cgv_template(p_restaurant_id);
  if v_applicable.id is null or v_applicable.id <> p_template_id then
    raise exception using errcode = '22023', message = 'TEMPLATE_NOT_APPLICABLE';
  end if;

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

  -- CGV ENGINE v2.5 (Task 5, item 1) -- PLACEHOLDER_TEXT_DETECTED.
  -- Enforced rejection, not a warning: scans the FINAL rendered HTML
  -- (never merely the template row -- a merchant's own free-text
  -- cancellation_policy_text/substitution_policy_text could
  -- reintroduce one of these markers even though every FR_FOOD_
  -- PERISHABLE_B2C template fallback string has been placeholder-free
  -- since v2.4) for every known unresolved-placeholder marker. Case-
  -- insensitive; deliberately generic (never enumerates a merchant-
  -- specific fabricated value) so it also catches a future accidental
  -- URL placeholder (e.g. "example.com") without this lot inventing an
  -- unrequested new mandatory field for item 4 below (see README-
  -- AUDIT.md -- Scanym's CGV content references no privacy-policy URL
  -- at all today, verified by grep, so item 4 has no live trigger yet;
  -- this generic guard is the forward defense for it).
  if p_rendered_content ilike '%n''a pas encore renseigné%'
     or p_rendered_content ilike '%{{%' or p_rendered_content ilike '%}}%'
     or p_rendered_content ilike '%TODO%'
     or p_rendered_content ilike '%lorem ipsum%'
     or p_rendered_content ilike '%PLACEHOLDER%'
     or p_rendered_content ilike '%à compléter%'
     or p_rendered_content ilike '%example.com%'
     or p_rendered_content ilike '%XXX-XXX%'
  then
    raise exception using errcode = 'P0001', message = 'PLACEHOLDER_TEXT_DETECTED',
      detail = 'The rendered CGV content contains an unresolved placeholder marker; publication is blocked.';
  end if;

  -- CGV ENGINE v2.5 (Task 5, item 5) -- LEGAL_GUARANTEE_BLOCK_MISSING.
  -- Enforced rejection that the mandatory D.211-2 encadré (Task 1)
  -- actually made it into the FINAL rendered content -- not merely
  -- that the resolved template happens to carry the key (belt AND
  -- suspenders: this also protects against a future renderCgv() bug
  -- that silently drops the section). A merchant pinned to a template
  -- version older than FR_FOOD_PERISHABLE_B2C v5 (which lacks this
  -- encadré entirely) is BLOCKED from publishing until re-pinned to a
  -- version that has it -- deliberate, since the mandatory statutory
  -- disclosure applies to every B2C goods contract under L.217-1,
  -- never merely to new/future templates.
  if p_rendered_content not ilike '%L. 217-1 à L. 217-32%'
     or p_rendered_content not ilike '%vices cachés%'
     or p_rendered_content not ilike '%trente jours%'
  then
    raise exception using errcode = 'P0001', message = 'LEGAL_GUARANTEE_BLOCK_MISSING',
      detail = 'The rendered CGV content is missing the mandatory D.211-2 legal-guarantee encadré (article D.211-2 du Code de la consommation, Annexe section A); publication is blocked.';
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

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cgv_completeness_errors';

  if v_src like '%ONLINE WITHDRAWAL v1.1%' then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: cgv_completeness_errors porte encore la forme v1.1.';
  end if;

  select p.prosrc into v_src from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version';

  if v_src like '%''STANDARD_14_DAYS'', ''MIXED''%' then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: persist_merchant_cgv_version couvre encore le régime MIXTE.';
  end if;
end $$;

commit;
