-- =============================================================================
-- SCANYM — ONLINE WITHDRAWAL v1.1 — RÉGIME MIXTE DE PLEIN EXERCICE
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO PROD.
-- =============================================================================
--
-- CE QUE CE LOT CORRIGE
--
-- ONLINE WITHDRAWAL v1 a livré l'éligibilité PRODUIT PAR PRODUIT et les
-- commandes mixtes côté RUNTIME, mais le MOTEUR CGV, lui, refusait
-- toujours le régime MIXTE par principe, avec une justification devenue
-- fausse : « v1 ne sait pas rendre ce régime sans classification
-- produit par produit ». La classification existe désormais. Un
-- marchand qui vend À LA FOIS des produits rétractables et des produits
-- légalement exclus (L221-28) ne pouvait donc décrire sa situation dans
-- aucune CGV publiable -- exactement le cas que le runtime sait traiter.
--
-- CE FICHIER NE FAIT PAS de MIXED un alias de STANDARD_14_DAYS. MIXED
-- devient un régime CONTRÔLÉ, avec sa propre clause (version 6 du
-- gabarit FR_FOOD_PERISHABLE_B2C, fichier frère), ses propres gardes,
-- et son propre instantané légal PAR LIGNE (fichier de fondation).
--
-- TROIS FONCTIONS RÉÉCRITES, chacune par CREATE OR REPLACE à signature
-- et type de retour INCHANGÉS (aucune n'est supprimée, aucun appelant
-- n'a à changer) :
--
--   1. `cgv_completeness_errors` -- MIXED n'est plus refusé par
--      principe ; il l'est SI ET SEULEMENT SI le gabarit RÉELLEMENT
--      applicable à ce marchand (épinglé ou par défaut) ne porte aucune
--      clause MIXED contrôlée. Même code d'erreur stable qu'avant
--      (`WITHDRAWAL_REGIME_MIXED_UNSUPPORTED`), déjà traduit côté
--      marchand -- la condition change, pas le contrat.
--   2. `resolve_cgv_publication_context` -- `online_withdrawal_function_
--      gap` couvre désormais MIXED, et la garde runtime fail-closed
--      s'applique donc aussi à lui.
--   3. `persist_merchant_cgv_version` -- même extension, au point de
--      persistance (défense en profondeur : les deux chemins échouent
--      fermé indépendamment, comme pour ACTUAL_WEIGHT_PRICE).
--
-- RAPPEL SUR LA GARDE RUNTIME (fichier de fondation, section H) : elle
-- exige désormais, en plus des primitives de déclaration, un canal
-- d'accusé de réception sur support durable RÉELLEMENT opérationnel.
-- L'article D.221-5, transposant l'article 11 bis de la directive
-- 2011/83/UE (inséré par la directive (UE) 2023/2673, applicable depuis
-- le 19 juin 2026), impose au professionnel d'ENVOYER au consommateur,
-- sans retard excessif, un accusé de réception mentionnant le contenu
-- de sa déclaration, sa date et son heure. Scanym ne dispose d'aucun
-- canal d'envoi transactionnel (email-provider-resolution.ts retourne
-- null par conception, aucune autorisation CIO d'envoi réel). En
-- conséquence, et délibérément, AUCUN marchand STANDARD_14_DAYS NI
-- MIXTE ne peut publier de CGV tant que ce canal n'existe pas. Ce lot
-- rend donc le régime MIXTE COMPLET et CORRECT dans le moteur, tout en
-- le laissant, comme STANDARD_14_DAYS, derrière la même porte fermée.
--
-- CE QUE CE LOT NE TOUCHE PAS : le remboursement (hors périmètre),
-- `payment_status`, le cycle de vie des commandes, le lot adresse, la
-- logique des prestataires de livraison.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. PRÉ-VOL — prérequis et anti-double-application (HORS transaction)
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.cgv_completeness_errors(uuid)') is null
     or to_regprocedure('public.resolve_cgv_publication_context(uuid)') is null
     or to_regprocedure('public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)') is null
     or to_regprocedure('public._resolve_applicable_cgv_template(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: moteur CGV (v2.2/v2.5) introuvable -- ONLINE WITHDRAWAL v1.1 annulé.';
  end if;

  -- La forme v2.4+ de resolve_cgv_publication_context (colonne de
  -- sortie online_withdrawal_function_gap) est celle que ce fichier
  -- réécrit : sans elle, on écraserait une autre version.
  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and 'online_withdrawal_function_gap' = any(p.proargnames)
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context (forme v2.4, avec online_withdrawal_function_gap) introuvable -- ONLINE WITHDRAWAL v1.1 annulé.';
  end if;

  -- ONLINE WITHDRAWAL v1 doit être appliqué : ce lot s'appuie sur ses
  -- primitives et sur la garde qu'il a redéfinie.
  if to_regprocedure('public._scanym_has_online_withdrawal_primitives()') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: _scanym_has_online_withdrawal_primitives() absente -- appliquer DRAFT-lot-online-withdrawal-foundation-v1.sql d''abord, annulé.';
  end if;

  -- Anti-double-application : la marque de ce lot dans le corps des
  -- fonctions réécrites.
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cgv_completeness_errors'
      and p.prosrc like '%ONLINE WITHDRAWAL v1.1%'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: cgv_completeness_errors porte déjà la forme ONLINE WITHDRAWAL v1.1 -- annulé.';
  end if;
end $$;

begin;

-- -----------------------------------------------------------------------------
-- B. cgv_completeness_errors — MIXED conditionné au GABARIT APPLICABLE
-- -----------------------------------------------------------------------------
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
  -- ONLINE WITHDRAWAL v1.1 -- gabarit RÉELLEMENT applicable (épinglé
  -- ou par défaut), seul à pouvoir dire si le régime MIXTE dispose
  -- d'une clause contrôlée pour CE marchand.
  v_applicable    public.cgv_template%rowtype;
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
    -- ONLINE WITHDRAWAL v1.1 -- MIXED n'est plus refusé par principe.
    -- La raison historique du refus (« v1 ne sait pas rendre ce régime
    -- sans classification produit par produit ») a disparu : la
    -- classification EXISTE désormais, par produit
    -- (menu_items.withdrawal_eligible) et figée par ligne de commande
    -- (order_items.withdrawal_eligible_at_order_time).
    --
    -- Ce qui reste exigé, et qui est vérifié RÉELLEMENT ici : le
    -- gabarit applicable à CE marchand doit porter une clause MIXED
    -- contrôlée. Un marchand épinglé à une version qui n'en a pas
    -- (v1 à v5) reste donc bloqué -- avec le même code stable qu'avant,
    -- que l'interface marchande sait déjà traduire -- jusqu'à ce qu'il
    -- soit rattaché à une version qui la porte. Jamais un rendu avec
    -- une clause manquante silencieusement omise.
    begin
      v_applicable := public._resolve_applicable_cgv_template(p_restaurant_id);
    exception when sqlstate '22023' then
      -- Épinglage cassé : le gabarit applicable n'est pas résoluble.
      -- Le publish path le signale bruyamment de son côté ; ici, on
      -- se contente de ne rien pouvoir affirmer sur la clause MIXED.
      v_applicable := null;
    end;

    if v_applicable.id is null
       or coalesce(btrim(v_applicable.controlled_sections->'withdrawal_clauses'->>'MIXED'), '') = ''
    then
      v_errors := array_append(v_errors, 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED');
    end if;
  end if;

  if v_template.id is not null and v_template.requires_preparation_clause and (
    not found or v_cgv.preparation_time_min is null or v_cgv.preparation_time_max is null
    or v_cgv.preparation_time_unit is null
  ) then
    v_errors := array_append(v_errors, 'PREPARATION_POLICY_MISSING');
  end if;

  return v_errors;
end $$;

comment on function public.cgv_completeness_errors(uuid) is
  'ONLINE WITHDRAWAL v1.1 — inchangée sauf pour le régime MIXTE : il n''est plus refusé par principe (la classification produit par produit existe désormais), mais uniquement lorsque le gabarit RÉELLEMENT applicable à ce marchand ne porte aucune clause MIXED contrôlée. Même code d''erreur stable qu''auparavant.';

-- Privilèges INCHANGÉS (réaffirmés explicitement, comme à chaque cycle).
revoke all on function public.cgv_completeness_errors(uuid) from public;
grant execute on function public.cgv_completeness_errors(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C. resolve_cgv_publication_context — la garde couvre aussi MIXED
-- -----------------------------------------------------------------------------
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

  -- ONLINE WITHDRAWAL v1.1 -- même exigence qu'au point de
  -- persistance : un marchand MIXTE ne peut pas publier sur un
  -- gabarit dépourvu de clause MIXED contrôlée (défense en profondeur
  -- -- cgv_completeness_errors l'a normalement déjà refusé).
  if v_cgv.withdrawal_regime = 'MIXED'
     and coalesce(btrim(v_template.controlled_sections->'withdrawal_clauses'->>'MIXED'), '') = ''
  then
    raise exception using errcode = 'P0001', message = 'CGV_INCOMPLETE',
      detail = 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED';
  end if;

  -- v2.4 -- pure function of withdrawal_regime, computed here so it is
  -- derived from the SAME authoritative merchant_cgv_profile row this
  -- function already read above, never a second, independent read.
  -- ONLINE WITHDRAWAL v1.1 -- le régime MIXTE est lui aussi concerné
  -- par l'obligation de fonctionnalité en ligne : il comporte, par
  -- définition, des produits ouvrant droit à rétractation.
  v_online_withdrawal_function_gap := (v_cgv.withdrawal_regime in ('STANDARD_14_DAYS', 'MIXED'));

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
      detail = 'This merchant''s withdrawal regime (STANDARD_14_DAYS or MIXED) legally requires a COMPLETE statutory online withdrawal function: the declaration runtime AND an acknowledgement of receipt actually sent to the consumer on a durable medium (D.221-5). Scanym provides the declaration runtime but has no operational durable acknowledgement channel -- publication is blocked until that channel ships or the merchant''s regime/configuration changes.';
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

-- -----------------------------------------------------------------------------
-- D. persist_merchant_cgv_version — même garde au point de persistance
-- -----------------------------------------------------------------------------
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
  -- ONLINE WITHDRAWAL v1.1 -- même valeur, relue sous un nom explicite
  -- au point où le gabarit applicable est connu (jamais une seconde
  -- lecture de merchant_cgv_profile).
  v_cgv_regime_for_mixed_check text;
begin
  select weight_pricing_mode, withdrawal_regime
    into v_weight_pricing_mode, v_withdrawal_regime_early
  from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;
  v_cgv_regime_for_mixed_check := v_withdrawal_regime_early;

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
  -- ONLINE WITHDRAWAL v1.1 -- MÊME garde, étendue au régime MIXTE.
  -- Un marchand MIXTE vend AUSSI des produits ouvrant droit à
  -- rétractation : l'obligation de fournir la fonctionnalité en ligne
  -- (L221-21 / D.221-5) le vise donc exactement comme un marchand
  -- STANDARD_14_DAYS, pour la part éligible de ses commandes. Le
  -- laisser publier sans cette garde aurait été la faille exacte que
  -- le régime MIXTE ouvrait. EXEMPT_PERISHABLE n'est toujours JAMAIS
  -- évalué ici.
  --
  -- Rappel v1.1 : `_scanym_has_online_withdrawal_runtime()` exige
  -- désormais DEUX choses -- les primitives de déclaration ET un canal
  -- d'accusé de réception durable réellement opérationnel. La seconde
  -- manque : cette garde bloque donc toujours, et c'est délibéré.
  if v_withdrawal_regime_early in ('STANDARD_14_DAYS', 'MIXED')
     and not public._scanym_has_online_withdrawal_runtime()
  then
    raise exception using errcode = 'P0001', message = 'WITHDRAWAL_RUNTIME_NOT_READY',
      detail = 'This merchant''s withdrawal regime (STANDARD_14_DAYS or MIXED) legally requires a COMPLETE statutory online withdrawal function: the declaration runtime AND an acknowledgement of receipt actually sent to the consumer on a durable medium (D.221-5). Scanym provides the declaration runtime but has no operational durable acknowledgement channel -- publication is blocked until that channel ships or the merchant''s regime/configuration changes.';
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

  -- ONLINE WITHDRAWAL v1.1 -- régime MIXTE : le gabarit RÉELLEMENT
  -- applicable doit porter une clause MIXED contrôlée. Sans elle,
  -- renderCgv échouerait fermé de son côté ; on refuse ici aussi,
  -- avec le code déjà connu de l'interface marchande, plutôt que de
  -- laisser la publication se terminer par une erreur opaque.
  if v_cgv_regime_for_mixed_check = 'MIXED'
     and coalesce(btrim(v_applicable.controlled_sections->'withdrawal_clauses'->>'MIXED'), '') = ''
  then
    raise exception using errcode = 'P0001', message = 'CGV_INCOMPLETE',
      detail = 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED';
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

-- Aucun grant ici : signature inchangée, privilèges inchangés
-- (service_role EXECUTE uniquement), comme à chaque cycle du moteur.

-- -----------------------------------------------------------------------------
-- E. VÉRIFICATION POST-APPLICATION — toujours AVANT commit
-- -----------------------------------------------------------------------------
do $$
declare
  v_src_completeness text;
  v_src_resolve      text;
  v_src_persist      text;
begin
  select p.prosrc into v_src_completeness from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cgv_completeness_errors';

  select p.prosrc into v_src_resolve from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context';

  select p.prosrc into v_src_persist from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version';

  -- 1. MIXED n'est plus refusé inconditionnellement.
  if v_src_completeness not like '%_resolve_applicable_cgv_template%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors ne consulte pas le gabarit applicable pour le régime MIXTE.';
  end if;

  -- 2. Les deux chemins de publication couvrent MIXED.
  if v_src_resolve not like '%''STANDARD_14_DAYS'', ''MIXED''%'
     or v_src_persist not like '%''STANDARD_14_DAYS'', ''MIXED''%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la garde de fonctionnalité en ligne ne couvre pas le régime MIXTE sur les deux chemins.';
  end if;

  -- 3. Les deux chemins interrogent toujours la MÊME garde runtime.
  if v_src_resolve not like '%_scanym_has_online_withdrawal_runtime%'
     or v_src_persist not like '%_scanym_has_online_withdrawal_runtime%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: un chemin de publication ne consulte plus la garde runtime.';
  end if;

  -- 4. La forme de sortie de resolve_cgv_publication_context est
  --    inchangée (aucune colonne ajoutée/retirée par ce lot).
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and 'online_withdrawal_function_gap' = any(p.proargnames)
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: resolve_cgv_publication_context a perdu sa forme v2.4.';
  end if;

  -- 5. Privilèges : toujours aucun accès anon.
  if has_function_privilege('anon', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cgv_completeness_errors(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: fonction du moteur CGV exposée à anon.';
  end if;

  -- 6. ET SURTOUT : la fonctionnalité statutaire reste INCOMPLÈTE tant
  --    qu'aucun canal d'accusé de réception durable n'existe. Si cette
  --    assertion venait à échouer sans qu'un lot de transport ait été
  --    livré, c'est que quelqu'un a forcé la garde à true.
  if public._scanym_has_online_withdrawal_runtime()
     and not public._scanym_has_operational_durable_ack_channel() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la garde runtime affirme une fonctionnalité complète sans canal d''accusé de réception.';
  end if;
end $$;

commit;

-- =============================================================================
-- APRÈS CE FICHIER : appliquer
-- supabase/DRAFT-lot-online-withdrawal-cgv-template-v6.sql pour que la
-- version 6 du gabarit (qui PORTE la clause MIXED) entre au catalogue.
-- Un marchand MIXTE devra ensuite être rattaché à cette version ET
-- attendre qu'un canal d'accusé de réception durable existe pour
-- publier. Les deux conditions sont vérifiées par la base, pas par une
-- procédure humaine.
-- =============================================================================
