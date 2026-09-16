-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE v2.1 — ENRICHMENT CYCLE
-- CGV ENGINE ENRICHMENT v2 — FRENCH FOOD/PERISHABLE B2C MANDATE COVERAGE
-- DEVELOPMENT ONLY — this file is a forward-only DELTA on top of the
-- already-applied v1.1, v1.2, v1.3 and v1.4 migrations. It never edits
-- any of those files (verified pre-flight, section 0 below): same
-- convention as every prior delta in this lot's history.
--
-- Baseline: yakoutmokhfi-ui/scandz, origin
--   SHA  e4c90f4f57ba37b46ab388e05847fd57610275a3
--   TREE 30643c6c0a236cca5babe7e5baaf9afcf17695f5
--
-- v1.1 (CGV-V1-PUBLISH-AUTHORITY-01), v1.2
-- (CGV-V11-PUBLISH-CONTEXT-RACE-01), v1.3 (GAP 1/2/3) and v1.4
-- (serialization-only fingerprint fix) are all CONFIRMED CLOSED and are
-- NOT reopened or redesigned here. This lot is purely additive: it
-- extends the seller legal identity model, the merchant CGV business
-- profile, the FR_FOOD_PERISHABLE_B2C template, and the two closed-loop
-- integrity mechanisms (fingerprint, fail-closed pricing-mode gate)
-- those four cycles built, so that the engine can cover the mandate's
-- full 26-section French CGV structure (seller identification with
-- SIREN/SIRET/VAT, portion pricing, cold chain, and the remaining
-- generic/fixed clauses every French B2C food CGV needs) rather than
-- the narrower v1 clause set.
--
-- =============================================================================
-- HEADLINE CHANGES (Section 1-3 of the v2 mandate) — the three items
-- the mandate enumerated explicitly:
--   1. Eight new nullable/defaulted columns (additive only, zero
--      backward-compatibility breakage for any existing row):
--        merchant_legal_profile: legal_entity_name, siren, siret,
--          vat_number, consumer_mediator_phone, consumer_mediator_email
--        merchant_cgv_profile: cold_chain_applicable (not null default
--          false), weight_pricing_mode (nullable, checked)
--      + a new PUBLISHED template row, FR_FOOD_PERISHABLE_B2C version 2
--        (the v1 version 1 row is NEVER touched — verified byte-
--        identical post-commit below).
--   2. _compute_cgv_publication_context_fingerprint(uuid) — CREATE OR
--      REPLACE, SAME signature/return type — extended with 8 new
--      jsonb_build_object(...) keys (one per new column above), so a
--      concurrent change to any of them between resolve and persist is
--      detected as STALE_CONTEXT exactly like every field v1.2/v1.3/
--      v1.4 already covered. No new lock required: every new column
--      lives on a table (merchant_legal_profile, merchant_cgv_profile)
--      already locked FOR UPDATE by persist_merchant_cgv_version.
--   3. persist_merchant_cgv_version — CREATE OR REPLACE, SAME 5-argument
--      signature — gains ONE new fail-closed check, evaluated as the
--      VERY FIRST statement in the function body (before any lock, any
--      other read, any mutation): weight_pricing_mode =
--      'ACTUAL_WEIGHT_PRICE' raises ACTUAL_WEIGHT_PRICE_UNSUPPORTED with
--      zero side effects. Every other line of this function (the
--      GAP2/GAP3 five-step lock order, the fingerprint compare, the
--      supersede+insert) is IDENTICAL to v1.3/v1.4 — untouched.
--
-- =============================================================================
-- NECESSARY PLUMBING BEYOND THE THREE HEADLINE ITEMS (transparently
-- flagged here, and again in the deliverable's README-AUDIT.md/report —
-- never silently smuggled in as if it were "nothing else changed"):
--
-- The mandate's own Section 5 asks for functional merchant-editable
-- dashboard fields for every new merchant_legal_profile/merchant_cgv_
-- profile column. Without wiring those columns into the existing
-- read/write RPCs, the new dashboard fields could never actually be
-- saved or displayed — a materially broken deliverable, not a
-- conservative one. Four existing RPCs are therefore ALSO extended,
-- using the SAME "additive, backward-compatible, explicit-signature"
-- discipline v1.1 already established for create_order:
--   - get_merchant_legal_profile: UNCHANGED. It returns
--     public.merchant_legal_profile%rowtype (`select * into v_row ...`)
--     — the 6 new legal columns are picked up automatically by the
--     already-existing `select *`, zero lines changed.
--   - update_merchant_legal_profile(uuid,text,...): DROP + CREATE, 6
--     new trailing text parameters added (p_legal_entity_name, p_siren,
--     p_siret, p_vat_number, p_consumer_mediator_phone, p_consumer_
--     mediator_email), all defaulted to null. The exact pre-existing
--     12-argument signature is explicitly DROPped first (never left as
--     a stale, ambiguity-risking overload — the same lesson v1.1's
--     create_order fix already taught this project).
--   - update_merchant_cgv_profile(uuid,text,...): DROP + CREATE, 2 new
--     trailing parameters added (p_cold_chain_applicable boolean
--     default false, p_weight_pricing_mode text default null, checked
--     against the same enum the table itself enforces).
--   - get_merchant_cgv_profile(uuid): DROP + CREATE (a RETURNS TABLE
--     column-list change cannot be done via CREATE OR REPLACE — the
--     exact same constraint v1.2's own header documented for
--     resolve_cgv_publication_context), 2 new output columns added
--     (cold_chain_applicable, weight_pricing_mode).
--   - resolve_cgv_publication_context(uuid): DROP + CREATE (same
--     RETURNS TABLE constraint), 8 new output columns added (the exact
--     8 new authoritative fields) so the REAL server-authoritative
--     publish path (lib/server/legal-cgv-publish-service.ts) can pass
--     them to renderCgv() exactly like the dashboard's own advisory
--     preview (which already has direct access to these fields via
--     get_merchant_legal_profile/get_merchant_cgv_profile) — otherwise
--     the two rendering call-sites would silently diverge, which is
--     precisely the class of defect this engagement's prior cycles
--     exist to prevent.
--
-- None of the FOUR functions above changes cgv_completeness_errors,
-- assert_legal_cgv_role/_for_user, _resolve_applicable_cgv_template, or
-- create_order — those are entirely untouched (verified post-commit).
-- cgv_completeness_errors is DELIBERATELY NOT extended to require any
-- of the 8 new fields: per the v2 mandate, none of them (SIREN/SIRET/
-- VAT, mediator phone/email, cold_chain_applicable, weight_pricing_
-- mode) is made a hard publish-blocking requirement in this cycle —
-- confirmed unchanged behavior, tested explicitly below.
--
-- CONSEQUENCE for the existing v1.2 rollback file (DRAFT-lot-seller-
-- legal-profile-cgv-engine-v1-2-rollback.sql): its `drop function if
-- exists ...` statements match by (schema, name, INPUT argument type
-- list) only — untouched by a RETURNS TABLE column change, so it still
-- correctly drops resolve_cgv_publication_context(uuid) and
-- get_merchant_cgv_profile(uuid) regardless of their new output
-- columns. It does NOT, however, name the NEW 18-argument
-- update_merchant_legal_profile or the NEW 10-argument
-- update_merchant_cgv_profile signatures (it only names the old
-- 12-/8-argument ones) — those two would survive the old rollback as
-- orphaned, broken functions referencing a dropped table. A new,
-- narrowly-scoped v2.1 rollback file
-- (DRAFT-lot-seller-legal-profile-cgv-engine-v2-1-rollback.sql) is
-- therefore shipped alongside this migration for exactly that reason —
-- see that file's own header, and TEST-RESULTS.md for the harness proof
-- of both the gap and the fix.
-- =============================================================================

do $$
begin
  -- 0a. PREREQUISITES — v1.1+v1.2+v1.3+v1.4 must already be applied
  -- exactly as shipped. Reuses the same detection v1.4 itself used for
  -- its own anti-double-apply guard (a textual marker that is reliable
  -- specifically because it is a full rewrite of the function body).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_compute_cgv_publication_context_fingerprint'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_functiondef(p.oid) ilike '%jsonb_build_object%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _compute_cgv_publication_context_fingerprint (v1.4, jsonb_build_object) introuvable -- v1.1+v1.2+v1.3+v1.4 doivent être appliqués avant v2.1, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) introuvable -- v1.1+v1.2+v1.3+v1.4 doivent être appliqués avant v2.1, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%acting_user_id uuid%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context (v1.2 shape, avec acting_user_id) introuvable -- v1.1+v1.2 doivent être appliqués avant v2.1, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_legal_profile'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_legal_form text, p_address_line1 text, p_address_line2 text, p_postal_code text, p_city text, p_governing_country text, p_customer_service_email text, p_customer_service_phone text, p_consumer_mediator_name text, p_consumer_mediator_address text, p_consumer_mediator_website text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_legal_profile (v1.1, 12 arguments) introuvable -- annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_cgv_profile'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_withdrawal_regime text, p_preparation_time_min integer, p_preparation_time_max integer, p_preparation_time_unit text, p_cancellation_policy_text text, p_substitution_policy_text text, p_presentation_variant text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_cgv_profile (v1.1, 8 arguments) introuvable -- annulé.';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('merchant_legal_profile', 'merchant_cgv_profile', 'cgv_template')
    group by 1 having count(*) = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une table CGV attendue est absente -- v1.1 doit être appliqué avant v2.1, annulé.';
  end if;

  -- 0b. ANTI-DOUBLE-APPLY — the 8 new columns must not already exist.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_legal_profile'
      and column_name in ('legal_entity_name','siren','siret','vat_number','consumer_mediator_phone','consumer_mediator_email')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une colonne v2.1 de merchant_legal_profile existe déjà -- v2.1 semble déjà appliqué, annulé (anti-double-apply).';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_cgv_profile'
      and column_name in ('cold_chain_applicable','weight_pricing_mode')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une colonne v2.1 de merchant_cgv_profile existe déjà -- v2.1 semble déjà appliqué, annulé (anti-double-apply).';
  end if;

  if exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 2 existe déjà -- v2.1 semble déjà appliqué, annulé (anti-double-apply).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_result(p.oid) ilike '%weight_pricing_mode%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context expose déjà weight_pricing_mode -- v2.1 semble déjà appliqué, annulé (anti-double-apply).';
  end if;
end $$;

begin;

-- =============================================================================
-- A. merchant_legal_profile — 6 new nullable columns. Additive only:
--    every existing row gets NULL for all six, byte-identical read
--    behavior for every column that already existed.
-- =============================================================================
alter table public.merchant_legal_profile add column legal_entity_name text;
alter table public.merchant_legal_profile add column siren text;
alter table public.merchant_legal_profile add column siret text;
alter table public.merchant_legal_profile add column vat_number text;
alter table public.merchant_legal_profile add column consumer_mediator_phone text;
alter table public.merchant_legal_profile add column consumer_mediator_email text;

comment on column public.merchant_legal_profile.legal_entity_name is
  'CGV ENGINE v2.1 -- dénomination sociale (raison sociale) enregistrée du vendeur, distincte du nom commercial/d''affichage (restaurants.name). French CGV seller-identification requires both when they differ. Nullable -- falls back to the trade name alone at render time (lib/legal/render.ts), never invented.';
comment on column public.merchant_legal_profile.siren is 'CGV ENGINE v2.1 -- numéro SIREN du vendeur. Nullable, informational, never invented -- rendered only when present.';
comment on column public.merchant_legal_profile.siret is 'CGV ENGINE v2.1 -- numéro SIRET du vendeur. Nullable, informational, never invented -- rendered only when present.';
comment on column public.merchant_legal_profile.vat_number is 'CGV ENGINE v2.1 -- numéro de TVA intracommunautaire du vendeur. Nullable, informational, never invented -- rendered only when present.';
comment on column public.merchant_legal_profile.consumer_mediator_phone is 'CGV ENGINE v2.1 -- téléphone du médiateur de la consommation désigné par le vendeur. Nullable, complète consumer_mediator_name/address/website (v1).';
comment on column public.merchant_legal_profile.consumer_mediator_email is 'CGV ENGINE v2.1 -- e-mail du médiateur de la consommation désigné par le vendeur. Nullable.';

-- =============================================================================
-- B. merchant_cgv_profile — 2 new columns.
--    cold_chain_applicable: not null default false -- every existing
--    row is unambiguously "no cold chain" after this migration, never
--    an ambiguous NULL for a boolean toggle that drives an on/off
--    rendering decision (lib/legal/render.ts renders the two cold-chain
--    clauses only when this is exactly true).
--    weight_pricing_mode: nullable (absence == "no weight-based
--    pricing mode configured", never a silent default to either
--    enumerated value), checked against the exact two values the v2
--    mandate defines.
-- =============================================================================
alter table public.merchant_cgv_profile add column cold_chain_applicable boolean not null default false;
alter table public.merchant_cgv_profile add column weight_pricing_mode text
  check (weight_pricing_mode is null or weight_pricing_mode in ('FIXED_PORTION_PRICE','ACTUAL_WEIGHT_PRICE'));

comment on column public.merchant_cgv_profile.cold_chain_applicable is
  'CGV ENGINE v2.1 -- true si au moins un produit du vendeur nécessite une chaîne du froid (transport à température dirigée). Pilote le rendu des clauses 13/14 (transport / post-remise) de lib/legal/render.ts. NOT NULL DEFAULT false -- toute ligne existante devient explicitement "pas de chaîne du froid", jamais un état ambigu.';
comment on column public.merchant_cgv_profile.weight_pricing_mode is
  'CGV ENGINE v2.1 -- FIXED_PORTION_PRICE (poids indicatif, prix fixe jamais recalculé) ou ACTUAL_WEIGHT_PRICE (recalcul au poids réel -- NON PRIS EN CHARGE, échoue fermé à la persistance ET au rendu -- voir persist_merchant_cgv_version et lib/legal/render.ts ActualWeightPriceUnsupportedError). NULL = aucun mode configuré, section "poids et prix des portions" simplement omise du rendu.';

-- No RLS/grant changes: these are plain columns on tables whose RLS
-- policies and table-level grants (SELECT to authenticated; every
-- write via a SECURITY DEFINER function) already cover every column,
-- new or old, automatically -- verified explicitly post-commit below
-- via has_column_privilege, never a new grant statement.

-- =============================================================================
-- C. FR_FOOD_PERISHABLE_B2C version 2 -- new PUBLISHED template row.
--    The version 1 row (seeded by v1.1) is NEVER updated, NEVER
--    deleted -- verified byte-identical post-commit below by exact
--    jsonb structural equality against the literal v1.1 inserted it.
--    controlled_sections below is the v1 object EXTENDED with new keys
--    (every v1 key preserved verbatim except withdrawal_clauses.
--    EXEMPT_PERISHABLE and jurisdiction_clause, each appended-to per
--    the v2 mandate's exact instructions -- never paraphrased).
-- =============================================================================
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 2, 'fr',
  'PUBLISHED', true, true,
  $cgv_v2_json$
  {
    "header": "Conditions Générales de Vente",
    "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
    "withdrawal_clauses": {
      "EXEMPT_PERISHABLE": "Conformément à l'article L221-28 3° du Code de la consommation, le droit de rétractation ne s'applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement. Cette exclusion ne s'applique qu'aux produits susceptibles de se détériorer ou de se périmer rapidement ; les autres produits éventuellement proposés par le Vendeur, non concernés par cette exclusion légale, demeurent soumis au régime de rétractation qui leur est applicable.",
      "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d'un délai de 14 jours pour exercer son droit de rétractation.",
      "MIXED": null
    },
    "mediator_clause": "En cas de litige, le client peut recourir gratuitement au médiateur de la consommation désigné par le vendeur.",
    "preparation_clause": "Le vendeur indique un délai de préparation prévisionnel, communiqué au client avant validation de la commande.",
    "cancellation_clause_label": "Politique d'annulation",
    "substitution_clause_label": "Politique de substitution de produit",
    "jurisdiction_clause": "Les présentes conditions sont soumises au droit applicable dans le pays d'établissement du vendeur. Les dispositions impératives protectrices du consommateur prévues par la loi applicable au lieu de résidence habituelle du Client demeurent applicables et ne peuvent être écartées par les présentes CGV.",
    "purpose_scope_clause": "Les présentes Conditions Générales de Vente (les « CGV ») régissent les ventes de produits alimentaires conclues à distance, par l'intermédiaire de la plateforme Scanym, entre le Vendeur identifié ci-après et tout client agissant en qualité de consommateur (le « Client »). Toute commande passée sur la plateforme implique l'acceptation sans réserve des présentes CGV, dont le contenu applicable est celui en vigueur à la date de la commande.",
    "products_characteristics_clause": "Les produits proposés à la vente, leurs caractéristiques essentielles, leur composition, leurs allergènes le cas échéant et leur prix sont présentés sur la fiche de chaque produit, telle qu'affichée sur la plateforme au moment de la commande. Le Vendeur s'efforce de présenter ces informations avec exactitude ; en cas de question sur la composition ou les allergènes d'un produit, le Client est invité à contacter le Vendeur avant de finaliser sa commande.",
    "portion_pricing_clauses": {
      "FIXED_PORTION_PRICE": "Certains produits peuvent être préparés ou découpés à la demande. Le poids indiqué correspond à une portion approximative et peut varier légèrement en raison de la préparation ou de la découpe. Le prix affiché et accepté lors de la validation de la commande est fixe et ne fait l'objet d'aucun recalcul en fonction de cette légère variation de poids."
    },
    "prices_taxes_clause": "Les prix des produits sont indiqués en euros, toutes taxes comprises (TTC), incluant la taxe sur la valeur ajoutée (TVA) applicable au taux en vigueur au jour de la commande. Le Vendeur reste seul responsable de la détermination du taux de TVA applicable à chaque produit. Les frais additionnels éventuels (frais de livraison notamment) sont indiqués distinctement avant validation de la commande et inclus dans le montant total dû par le Client.",
    "ordering_process_clause": "Le Client sélectionne les produits de son choix, les ajoute à son panier, puis procède à la validation de sa commande en suivant les étapes indiquées par la plateforme, incluant le choix du mode de retrait ou de livraison et, le cas échéant, l'acceptation des présentes CGV. Le Client est invité à vérifier le contenu et le prix total de sa commande avant validation finale.",
    "contract_formation_clause": "La commande est réputée définitivement conclue lorsque le Client valide le paiement de sa commande et que celle-ci est confirmée par la plateforme. Cette confirmation vaut acceptation de la commande par le Vendeur et formation du contrat de vente entre le Vendeur et le Client, sous réserve de la disponibilité effective des produits commandés.",
    "payment_clause": "Le règlement de la commande s'effectue en ligne, au moyen des modes de paiement proposés par la plateforme au moment de la commande. Le paiement est exigible immédiatement à la validation de la commande. Les données de paiement sont traitées par l'intermédiaire de prestataires de paiement sécurisés ; le Vendeur n'a à aucun moment accès aux données bancaires complètes du Client.",
    "availability_clause": "Les produits sont proposés à la vente dans la limite des stocks et de la capacité de préparation disponibles. Si, après validation de la commande, un ou plusieurs produits commandés s'avèrent indisponibles, le Client en est informé dans les meilleurs délais et la commande est ajustée ou annulée pour la partie concernée, avec remboursement correspondant le cas échéant.",
    "pickup_clause": "Lorsque le Client a choisi le retrait de sa commande auprès du Vendeur, il est informé, via la plateforme, du lieu et du créneau indicatif de retrait. Le Client est invité à se présenter dans les meilleurs délais suivant la mise à disposition de sa commande, dans les conditions communiquées par le Vendeur.",
    "delivery_clause": "Lorsqu'un mode de livraison est proposé et sélectionné par le Client, la commande est acheminée selon les modalités (zone, délai indicatif, prestataire) présentées au Client avant validation de la commande. Le Vendeur ou le prestataire de livraison qu'il mandate met en œuvre les moyens appropriés pour que la commande parvienne au Client dans les meilleurs délais et dans des conditions adaptées à la nature des produits commandés.",
    "cold_chain_clauses": {
      "transport": "Certains produits vendus par le Vendeur nécessitent d'être maintenus à température dirigée (chaîne du froid) afin de préserver leur qualité et leur sécurité sanitaire. Le Vendeur s'engage à préparer et à remettre ces produits au Client, ou au prestataire de livraison, dans des conditions de conservation conformes à leurs exigences de température jusqu'à la remise effective au Client.",
      "post_handover": "À compter de la remise de la commande au Client (retrait ou livraison), il appartient à ce dernier de respecter les conditions de conservation indiquées sur les produits ou communiquées par le Vendeur, notamment en les plaçant sans délai excessif dans un environnement réfrigéré adapté. Le Vendeur ne saurait être tenu responsable d'une dégradation résultant du non-respect de ces conditions par le Client après la remise de la commande."
    },
    "cancellation_clause_intro": "L'annulation d'une commande par le Client peut être possible tant que sa préparation n'a pas débuté. Les conditions précises d'annulation applicables aux commandes passées auprès du Vendeur sont précisées ci-après.",
    "cancellation_clause_fallback": "Le Vendeur n'a pas encore renseigné de politique d'annulation spécifique ; en l'absence d'indication contraire du Vendeur, l'annulation reste soumise aux dispositions légales applicables et, le cas échéant, à un accord entre le Client et le Vendeur.",
    "substitution_clause_intro": "Sauf accord exprès du Client, aucun produit de substitution présentant une différence significative avec le produit commandé — notamment en matière d'allergènes, de prix, de nature du produit, de quantité ou de caractéristiques diététiques — ne saurait être considéré comme accepté par le Client du seul fait de sa livraison ou de sa mise à disposition. Les conditions de substitution propres au Vendeur sont précisées ci-après.",
    "substitution_clause_fallback": "Le Vendeur n'a pas encore renseigné de politique de substitution spécifique au-delà de la règle générale énoncée ci-dessus.",
    "complaints_clause": "En cas de produit manquant, endommagé, non conforme à la commande, ou de toute autre anomalie constatée à la réception, le Client est invité à en informer le Vendeur dans les meilleurs délais, via les coordonnées de contact du Vendeur indiquées dans les présentes CGV, en précisant si possible la nature de l'anomalie et en fournissant, le cas échéant, des photographies illustrant le problème constaté. Cette information ne constitue pas un délai contractuel de réclamation et ne saurait restreindre les droits légaux du Client.",
    "legal_guarantees_clause": "Sans préjudice des dispositions applicables au droit de rétractation et à ses exceptions, le Client bénéficie, dans les conditions prévues par la loi et pour les produits qui y sont éligibles, de la garantie légale de conformité (articles L217-3 et suivants du Code de la consommation) et de la garantie légale contre les vices cachés (articles 1641 et suivants du Code civil).",
    "liability_clause": "Le Vendeur ne saurait être tenu responsable de l'inexécution ou de la mauvaise exécution du contrat qui serait imputable au Client, à un tiers étranger à la fourniture des produits, ou à un cas de force majeure. La responsabilité du Vendeur ne pourra être engagée que dans les conditions et limites prévues par les dispositions légales applicables aux relations entre professionnels et consommateurs.",
    "force_majeure_clause": "Aucune des parties ne pourra être tenue responsable envers l'autre en cas de manquement à l'une de ses obligations résultant d'un événement de force majeure, au sens de l'article 1218 du Code civil.",
    "personal_data_clause": "Les données personnelles du Client sont collectées et traitées par Scanym et/ou le Vendeur pour les besoins de la gestion de la commande, de la relation client et, le cas échéant, du respect d'obligations légales et comptables. Conformément à la réglementation applicable en matière de protection des données personnelles, Scanym met en œuvre des mesures techniques permettant la suppression ou l'anonymisation périodique de certaines données personnelles liées aux commandes, au-delà d'une durée de conservation définie dans sa politique de gestion des données, laquelle est disponible auprès de Scanym. Les données nécessaires à l'établissement de documents comptables, fiscaux ou de facturation sont conservées séparément, pour la durée exigée par les obligations légales applicables, indépendamment de la suppression ou de l'anonymisation des données personnelles du Client. Le Client dispose, dans les conditions prévues par la réglementation applicable, d'un droit d'accès, de rectification et de suppression de ses données, qu'il peut exercer auprès du Vendeur ou de Scanym.",
    "applicable_law_clause": "Les présentes CGV sont soumises au droit applicable dans le pays de rattachement du Vendeur tel qu'indiqué dans son profil légal, sans préjudice des dispositions impératives de protection des consommateurs qui pourraient être applicables en vertu du droit du pays de résidence habituelle du Client."
  }
  $cgv_v2_json$::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 2);

-- =============================================================================
-- D. _compute_cgv_publication_context_fingerprint — CREATE OR REPLACE,
--    SAME signature/return type (text uuid -> text). Data-gathering
--    (the three SELECTs, the template resolution) is byte-identical to
--    v1.4 -- only the jsonb_build_object(...) key list is extended with
--    the 8 new keys below, in the same "raw value, no coalesce" style
--    v1.4 established (a NULL column produces a genuine JSON null).
-- =============================================================================
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
      'locale',                      'fr',
      -- v2.1 -- 8 new authoritative fields, same "raw value, no
      -- coalesce" discipline as every v1.4 key above: a NULL column
      -- produces a genuine JSON null (distinguishable from '""'),
      -- never a masked empty string.
      'legal_entity_name',           v_legal.legal_entity_name,
      'siren',                       v_legal.siren,
      'siret',                       v_legal.siret,
      'vat_number',                  v_legal.vat_number,
      'consumer_mediator_phone',     v_legal.consumer_mediator_phone,
      'consumer_mediator_email',     v_legal.consumer_mediator_email,
      'cold_chain_applicable',       v_cgv.cold_chain_applicable,
      'weight_pricing_mode',         v_cgv.weight_pricing_mode
    )::text
  );
end $$;

-- No grant statement here: CREATE OR REPLACE on an unchanged signature
-- leaves all existing grants exactly as they were (verified post-
-- commit below) -- zero grants before, zero grants after (private
-- helper).

-- =============================================================================
-- E. persist_merchant_cgv_version — CREATE OR REPLACE, SAME 5-argument
--    signature/return type. Every line below the new check is BYTE-
--    IDENTICAL to v1.3/v1.4's body (the GAP2/GAP3 five-step lock order,
--    the completeness check, the template-applicability re-proof, the
--    atomic fingerprint compare, the supersede+insert, the profile-
--    status update) -- only ONE new statement is added, as the FIRST
--    statement in the function body, so it runs before any lock is
--    acquired and before any other read: zero side effects on a
--    rejection.
-- =============================================================================
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
begin
  -- v2.1 FAIL-CLOSED CHECK (mandate Section 3) -- checked FIRST, before
  -- any lock is taken and before any other statement runs, so a
  -- merchant configured for ACTUAL_WEIGHT_PRICE can never cause ANY
  -- side effect here, not even a lock acquisition. A plain (non-
  -- locking) read is sufficient: this function either raises
  -- immediately below or proceeds to acquire the real locks itself in
  -- the very next statements -- there is no window in which this read
  -- being unlocked could matter, because nothing has been decided or
  -- written yet.
  select weight_pricing_mode into v_weight_pricing_mode
  from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;

  if v_weight_pricing_mode = 'ACTUAL_WEIGHT_PRICE' then
    raise exception using errcode = 'P0001', message = 'ACTUAL_WEIGHT_PRICE_UNSUPPORTED',
      detail = 'Scanym does not currently support price recalculation based on actual post-preparation weight; configure FIXED_PORTION_PRICE or leave weight_pricing_mode null.';
  end if;

  -- MANDATORY LOCK SET (v1.3 GAP 2/3, UNCHANGED) -- fixed deterministic
  -- order: restaurants -> merchant_legal_profile -> merchant_cgv_profile
  -- -> cgv_template -> authorizing row.
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

  v_applicable := public._resolve_applicable_cgv_template(v_country);
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

-- No grant statement here either -- same reasoning as section D
-- (unchanged signature, unchanged grants: service_role EXECUTE only).

-- =============================================================================
-- F. resolve_cgv_publication_context -- DROP + CREATE (RETURNS TABLE
--    column-list change; a RETURNS TABLE column-list change cannot be
--    done via CREATE OR REPLACE -- see v1.2's own header for this same
--    constraint). Input signature UNCHANGED (p_restaurant_id uuid);
--    body UNCHANGED in substance from v1.2 except the 8 new output
--    columns, read straight off v_legal/v_cgv (already selected via
--    `select *`, so no new SELECT statement is required).
-- =============================================================================
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
  acting_user_id           uuid,
  -- v2.1 -- 8 new authoritative fields, resolved for the REAL
  -- server-authoritative publish path (lib/server/legal-cgv-publish-
  -- service.ts) exactly as the dashboard's own advisory preview already
  -- reads them via get_merchant_legal_profile/get_merchant_cgv_profile
  -- -- keeps the two rendering call-sites in agreement.
  legal_entity_name        text,
  siren                    text,
  siret                    text,
  vat_number               text,
  consumer_mediator_phone  text,
  consumer_mediator_email  text,
  cold_chain_applicable    boolean,
  weight_pricing_mode      text
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
    v_uid,
    v_legal.legal_entity_name, v_legal.siren, v_legal.siret, v_legal.vat_number,
    v_legal.consumer_mediator_phone, v_legal.consumer_mediator_email,
    v_cgv.cold_chain_applicable, v_cgv.weight_pricing_mode;
end $$;

revoke all on function public.resolve_cgv_publication_context(uuid) from public;
grant execute on function public.resolve_cgv_publication_context(uuid) to authenticated;

-- =============================================================================
-- G. update_merchant_legal_profile -- DROP the exact pre-existing
--    12-argument signature (never left as a stale overload -- the same
--    lesson v1.1's create_order fix already taught this project), then
--    CREATE a new 18-argument signature (6 new trailing text
--    parameters, all defaulted to null). Body otherwise byte-identical
--    to v1.1's -- same normalization style, same on-conflict update.
-- =============================================================================
drop function if exists public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text);

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
  p_consumer_mediator_website text,
  p_legal_entity_name         text default null,
  p_siren                     text default null,
  p_siret                     text default null,
  p_vat_number                text default null,
  p_consumer_mediator_phone   text default null,
  p_consumer_mediator_email   text default null
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
  v_legal_entity_name          text;
  v_siren                      text;
  v_siret                      text;
  v_vat_number                 text;
  v_consumer_mediator_phone    text;
  v_consumer_mediator_email    text;
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
  v_legal_entity_name         := nullif(btrim(coalesce(p_legal_entity_name, '')), '');
  v_siren                     := nullif(btrim(coalesce(p_siren, '')), '');
  v_siret                     := nullif(btrim(coalesce(p_siret, '')), '');
  v_vat_number                := nullif(btrim(coalesce(p_vat_number, '')), '');
  v_consumer_mediator_phone   := nullif(btrim(coalesce(p_consumer_mediator_phone, '')), '');
  v_consumer_mediator_email   := nullif(btrim(coalesce(p_consumer_mediator_email, '')), '');

  if v_governing_country is not null and not exists (
    select 1 from public.scanym_supported_countries where code = v_governing_country
  ) then
    raise exception using errcode = '22023', message = 'Unknown governing_country code';
  end if;

  insert into public.merchant_legal_profile (
    restaurant_id, legal_form, address_line1, address_line2, postal_code, city,
    governing_country, customer_service_email, customer_service_phone,
    consumer_mediator_name, consumer_mediator_address, consumer_mediator_website,
    legal_entity_name, siren, siret, vat_number,
    consumer_mediator_phone, consumer_mediator_email,
    updated_at
  ) values (
    p_restaurant_id, v_legal_form, v_address_line1, v_address_line2, v_postal_code, v_city,
    v_governing_country, v_customer_service_email, v_customer_service_phone,
    v_consumer_mediator_name, v_consumer_mediator_address, v_consumer_mediator_website,
    v_legal_entity_name, v_siren, v_siret, v_vat_number,
    v_consumer_mediator_phone, v_consumer_mediator_email,
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
    legal_entity_name = excluded.legal_entity_name,
    siren = excluded.siren,
    siret = excluded.siret,
    vat_number = excluded.vat_number,
    consumer_mediator_phone = excluded.consumer_mediator_phone,
    consumer_mediator_email = excluded.consumer_mediator_email,
    updated_at = now();
end $$;

revoke all on function public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) to authenticated;

-- =============================================================================
-- H. update_merchant_cgv_profile -- DROP the exact pre-existing
--    8-argument signature, CREATE a new 10-argument signature (2 new
--    trailing parameters: p_cold_chain_applicable boolean default
--    false, p_weight_pricing_mode text default null). Body otherwise
--    byte-identical to v1.1's.
-- =============================================================================
drop function if exists public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text);

create function public.update_merchant_cgv_profile(
  p_restaurant_id             uuid,
  p_withdrawal_regime         text,
  p_preparation_time_min      integer,
  p_preparation_time_max      integer,
  p_preparation_time_unit     text,
  p_cancellation_policy_text  text,
  p_substitution_policy_text  text,
  p_presentation_variant      text,
  p_cold_chain_applicable     boolean default false,
  p_weight_pricing_mode       text default null
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
  v_weight_pricing_mode      text;
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
  v_weight_pricing_mode      := nullif(upper(btrim(coalesce(p_weight_pricing_mode, ''))), '');

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
  -- v2.1 -- same table-level CHECK constraint restated here for a
  -- clearer, deterministic error message (same discipline as the three
  -- checks above), never a silent coercion.
  if v_weight_pricing_mode is not null and v_weight_pricing_mode not in ('FIXED_PORTION_PRICE','ACTUAL_WEIGHT_PRICE') then
    raise exception using errcode = '22023', message = 'Unknown weight_pricing_mode value';
  end if;

  insert into public.merchant_cgv_profile (
    restaurant_id, withdrawal_regime, preparation_time_min, preparation_time_max,
    preparation_time_unit, cancellation_policy_text, substitution_policy_text,
    presentation_variant, cold_chain_applicable, weight_pricing_mode,
    status, profile_version, updated_at
  ) values (
    p_restaurant_id, v_withdrawal_regime, p_preparation_time_min, p_preparation_time_max,
    v_preparation_time_unit, v_cancellation_policy_text, v_substitution_policy_text,
    v_presentation_variant, coalesce(p_cold_chain_applicable, false), v_weight_pricing_mode,
    'CGV_DRAFT', 1, now()
  )
  on conflict (restaurant_id) do update set
    withdrawal_regime = excluded.withdrawal_regime,
    preparation_time_min = excluded.preparation_time_min,
    preparation_time_max = excluded.preparation_time_max,
    preparation_time_unit = excluded.preparation_time_unit,
    cancellation_policy_text = excluded.cancellation_policy_text,
    substitution_policy_text = excluded.substitution_policy_text,
    presentation_variant = excluded.presentation_variant,
    cold_chain_applicable = excluded.cold_chain_applicable,
    weight_pricing_mode = excluded.weight_pricing_mode,
    status = case
      when public.merchant_cgv_profile.status = 'CGV_NOT_CONFIGURED' then 'CGV_DRAFT'
      else public.merchant_cgv_profile.status
    end,
    profile_version = public.merchant_cgv_profile.profile_version + 1,
    updated_at = now();
end $$;

revoke all on function public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text,boolean,text) from public;
grant execute on function public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text,boolean,text) to authenticated;

-- =============================================================================
-- I. get_merchant_cgv_profile -- DROP + CREATE (RETURNS TABLE column-
--    list change), input signature UNCHANGED (p_restaurant_id uuid).
--    2 new output columns (cold_chain_applicable, weight_pricing_mode),
--    same coalesce-to-a-safe-default style already used for
--    presentation_variant/status/profile_version above them.
-- =============================================================================
drop function if exists public.get_merchant_cgv_profile(uuid);

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
  completeness_errors text[],
  cold_chain_applicable boolean,
  weight_pricing_mode text
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
    public.cgv_completeness_errors(p_restaurant_id),
    coalesce(cp.cold_chain_applicable, false),
    cp.weight_pricing_mode
  from (select 1) as _dummy
  left join public.merchant_cgv_profile cp on cp.restaurant_id = p_restaurant_id;
end $$;

revoke all on function public.get_merchant_cgv_profile(uuid) from public;
grant execute on function public.get_merchant_cgv_profile(uuid) to authenticated;

commit;

-- =============================================================================
-- POST-COMMIT VERIFICATION GUARD
-- =============================================================================
do $$
declare
  v_v1_sections jsonb;
begin
  -- 1. The 8 new columns exist, with the exact expected types/defaults/
  --    nullability.
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_legal_profile'
      and column_name='legal_entity_name' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_legal_profile.legal_entity_name manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_legal_profile'
      and column_name='siren' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_legal_profile.siren manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_legal_profile'
      and column_name='siret' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_legal_profile.siret manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_legal_profile'
      and column_name='vat_number' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_legal_profile.vat_number manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_legal_profile'
      and column_name='consumer_mediator_phone' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_legal_profile.consumer_mediator_phone manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_legal_profile'
      and column_name='consumer_mediator_email' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_legal_profile.consumer_mediator_email manquante ou mal typée.'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_cgv_profile'
      and column_name='cold_chain_applicable' and data_type='boolean' and is_nullable='NO' and column_default ilike '%false%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_cgv_profile.cold_chain_applicable manquante ou mal contrainte (attendu: NOT NULL DEFAULT false).'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_cgv_profile'
      and column_name='weight_pricing_mode' and data_type='text' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_cgv_profile.weight_pricing_mode manquante ou mal typée.'; end if;

  -- 2. Backward compatibility: an existing row (created before this
  --    migration) reads back with NULL/false for every new column --
  --    a plain assertion here confirms the DEFAULT applied to existing
  --    rows as well as new ones (ALTER TABLE ... ADD COLUMN ... DEFAULT
  --    on Postgres 11+ back-fills existing rows without a table
  --    rewrite; this positively confirms it took effect rather than
  --    assuming it).
  if exists (
    select 1 from public.merchant_cgv_profile where cold_chain_applicable is null
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: au moins une ligne merchant_cgv_profile existante a cold_chain_applicable NULL -- le défaut ne s''est pas appliqué aux lignes préexistantes.'; end if;

  -- 3. Template v2 row exists with the expected new keys; template v1
  --    row is BYTE-IDENTICAL to before (exact jsonb structural equality
  --    against the literal v1.1 inserted it -- stronger than a hash
  --    compare, and needs no separate snapshot mechanism).
  if not exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version=2 and status='PUBLISHED'
      and controlled_sections ? 'purpose_scope_clause'
      and controlled_sections ? 'portion_pricing_clauses'
      and controlled_sections ? 'cold_chain_clauses'
      and controlled_sections ? 'personal_data_clause'
      and controlled_sections ? 'applicable_law_clause'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 2 manquante ou incomplète.'; end if;

  select controlled_sections into v_v1_sections
  from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=1;

  if v_v1_sections is distinct from $cgv_v1_expected$
  {
     "header": "Conditions Générales de Vente",
     "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
     "withdrawal_clauses": {
       "EXEMPT_PERISHABLE": "Conformément à l'article L221-28 3° du Code de la consommation, le droit de rétractation ne s'applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement.",
       "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d'un délai de 14 jours pour exercer son droit de rétractation.",
       "MIXED": null
     },
     "mediator_clause": "En cas de litige, le client peut recourir gratuitement au médiateur de la consommation désigné par le vendeur.",
     "preparation_clause": "Le vendeur indique un délai de préparation prévisionnel, communiqué au client avant validation de la commande.",
     "cancellation_clause_label": "Politique d'annulation",
     "substitution_clause_label": "Politique de substitution de produit",
     "jurisdiction_clause": "Les présentes conditions sont soumises au droit applicable dans le pays d'établissement du vendeur."
   }
  $cgv_v1_expected$::jsonb then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 1 a été modifiée par ce lot -- elle doit rester BYTE-IDENTIQUE (comparaison structurelle jsonb exacte contre le littéral v1.1).';
  end if;

  -- 4. No grant changes: has_column_privilege for a new column matches
  --    the TABLE-level grant already in place (SELECT to authenticated
  --    via the existing table grant, nothing to anon, nothing directly
  --    to service_role) -- never a NEW grant statement.
  if not has_column_privilege('authenticated', 'public.merchant_legal_profile', 'legal_entity_name', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated devrait avoir SELECT sur legal_entity_name (héritage du grant de table existant), absent.';
  end if;
  if has_column_privilege('anon', 'public.merchant_legal_profile', 'legal_entity_name', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon ne doit avoir AUCUN privilège sur merchant_legal_profile, y compris ses nouvelles colonnes.';
  end if;
  if has_column_privilege('anon', 'public.merchant_cgv_profile', 'cold_chain_applicable', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon ne doit avoir AUCUN privilège sur merchant_cgv_profile, y compris ses nouvelles colonnes.';
  end if;

  -- 5. persist_merchant_cgv_version / resolve_cgv_publication_context:
  --    input signatures as expected; persist_merchant_cgv_version's
  --    grants unchanged (service_role only); resolve_cgv_publication_
  --    context keeps its authenticated-only EXECUTE grant.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: persist_merchant_cgv_version a changé de signature -- ne devait JAMAIS changer.'; end if;

  if not has_function_privilege('service_role', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: service_role a perdu EXECUTE sur persist_merchant_cgv_version.';
  end if;
  if has_function_privilege('authenticated', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a EXECUTE sur persist_merchant_cgv_version -- régression d''autorité.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%weight_pricing_mode text%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: resolve_cgv_publication_context n''expose pas weight_pricing_mode après v2.1.'; end if;
  if not has_function_privilege('authenticated', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur resolve_cgv_publication_context.';
  end if;
  if has_function_privilege('anon', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur resolve_cgv_publication_context.';
  end if;

  -- 6. Old signatures of the 3 extended write/read RPCs no longer
  --    exist (no stale overload left reachable).
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_legal_profile' and pg_get_function_identity_arguments(p.oid) not ilike '%p_legal_entity_name%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: un overload obsolète (v1.1, 12 arguments) de update_merchant_legal_profile subsiste.'; end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_cgv_profile' and pg_get_function_identity_arguments(p.oid) not ilike '%p_cold_chain_applicable%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: un overload obsolète (v1.1, 8 arguments) de update_merchant_cgv_profile subsiste.'; end if;
  if not has_function_privilege('authenticated', 'public.update_merchant_legal_profile(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated devrait avoir EXECUTE sur le nouveau update_merchant_legal_profile.';
  end if;
  if not has_function_privilege('authenticated', 'public.update_merchant_cgv_profile(uuid,text,integer,integer,text,text,text,text,boolean,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated devrait avoir EXECUTE sur le nouveau update_merchant_cgv_profile.';
  end if;

  -- 7. cgv_completeness_errors / assert_legal_cgv_role(_for_user) /
  --    _resolve_applicable_cgv_template / create_order are completely
  --    untouched by this lot.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_arguments(p.oid) ilike '%p_cgv_accepted%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_order a perdu p_cgv_accepted -- ce lot ne doit JAMAIS toucher create_order.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cgv_completeness_errors'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors a disparu ou changé de signature -- ce lot ne doit JAMAIS y toucher.';
  end if;
end $$;

-- =============================================================================
-- Summary of changes relative to v1.4:
--   + 6 new nullable columns on merchant_legal_profile (legal_entity_
--     name, siren, siret, vat_number, consumer_mediator_phone,
--     consumer_mediator_email).
--   + 2 new columns on merchant_cgv_profile (cold_chain_applicable NOT
--     NULL DEFAULT false, weight_pricing_mode nullable/checked).
--   + FR_FOOD_PERISHABLE_B2C template version 2, PUBLISHED -- version 1
--     untouched (verified byte-identical post-commit).
--   ~ _compute_cgv_publication_context_fingerprint(uuid) -- CREATE OR
--     REPLACE, same signature, 8 new jsonb_build_object keys.
--   ~ persist_merchant_cgv_version -- CREATE OR REPLACE, same 5-arg
--     signature, ONE new fail-closed check (ACTUAL_WEIGHT_PRICE_
--     UNSUPPORTED) as the first statement, otherwise byte-identical to
--     v1.3/v1.4.
--   ~ resolve_cgv_publication_context -- DROP + CREATE, same input
--     signature, 8 new output columns (necessary plumbing, see header).
--   ~ update_merchant_legal_profile -- DROP the 12-arg signature,
--     CREATE an 18-arg signature (6 new trailing defaulted params).
--   ~ update_merchant_cgv_profile -- DROP the 8-arg signature, CREATE a
--     10-arg signature (2 new trailing defaulted params).
--   ~ get_merchant_cgv_profile -- DROP + CREATE, same input signature,
--     2 new output columns.
--   No RLS policy changed. No new grant beyond re-granting EXECUTE on
--   the 4 recreated functions to the SAME role (authenticated) they
--   already had it for. cgv_completeness_errors, assert_legal_cgv_role/
--   _for_user, _resolve_applicable_cgv_template, activate_merchant_cgv,
--   get_restaurant_public_cgv, get_restaurant_cgv_version_by_id,
--   get_merchant_legal_profile and create_order are ALL untouched.
--   menu_items and every other catalogue/payment/fulfillment/
--   notifications table or function: untouched.
-- =============================================================================
