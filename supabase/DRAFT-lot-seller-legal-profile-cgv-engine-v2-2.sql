-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE v2.2 — ENRICHMENT CYCLE
-- CGV ENGINE ENRICHMENT v2.2 — DEDUP (law/jurisdiction) + MEDIATION FLOW
-- + TEMPLATE-ACTIVATION ARCHITECTURE
-- DEVELOPMENT ONLY — this file is a forward-only DELTA on top of the
-- already-applied v1.1, v1.2, v1.3, v1.4 and v2.1 migrations. It never
-- edits any of those files (verified pre-flight, section 0 below): same
-- convention as every prior delta in this lot's history.
--
-- Baseline: yakoutmokhfi-ui/scandz, origin
--   SHA  b2c3bd2d9a13a29453913f6f081c544f45cd5f84
--   TREE c270ca699e139062d81d5fc27828a0d23834be9e
-- (refreshed from v2.1's e4c90f4f57ba37b46ab388e05847fd57610275a3 —
-- PR #86 "Catalogue Import — Category/Subcategory Row Support v1" —
-- confirmed, by diffstat AND by a byte-identical diff of every CGV-
-- owned file between the two SHAs, to touch ZERO files this lot owns.
-- A pure no-op transplant for this lot's own prior deliverable.)
--
-- v1.1-v1.4 and v2.1 are all CONFIRMED CLOSED and are NOT reopened or
-- redesigned here (v2.1's harness re-run on the new baseline: PASS=447
-- FAIL=0, unchanged). This lot addresses the v2.2 mandate's three
-- remaining items:
--
--   1. DEDUPE applicable-law / jurisdiction (mandate item 2). Diagnosis
--      (by reading render.ts + the real rendered Au Lait Cru preview,
--      not by assumption): this was GENUINE CONTENT DUPLICATION, not
--      merely a label collision -- v2's `jurisdiction_clause` and
--      `applicable_law_clause` BOTH independently asserted "governed
--      by the law of the seller's country" (jurisdiction_clause never
--      actually addressed competent court/venue at all, despite its
--      name). The headings were ALSO confusable ("Loi applicable" /
--      "Droit applicable" -- near-synonyms) -- both problems fixed:
--        - CONTENT (template-row layer, v3 only -- v1/v2 untouched,
--          immutable): `applicable_law_clause` is UNCHANGED (already
--          the correct, sole governing-law statement).
--          `jurisdiction_clause` is REWRITTEN to address ONLY
--          competent court/venue, explicitly preserves mandatory
--          consumer-protection provisions, never restates which law
--          applies, and never invents an exclusive-jurisdiction/forum-
--          selection clause that would illegally restrict a consumer's
--          statutory right to sue in their own domicile's courts (a
--          real French/EU consumer-law constraint) -- it extends,
--          rather than replaces, the mandatory-protections sentence
--          v2.1 already got right.
--        - LABEL (lib/legal/render.ts layer, UNIVERSAL for every
--          template version): section 26's heading is renamed from
--          "Droit applicable" to "Juridiction compétente" -- a pure,
--          backward-compatible label change with zero effect on which
--          text is shown for v1/v2 merchants.
--
--   2. MEDIATION CLAUSE RESTRUCTURE (mandate item 3). A new OPTIONAL,
--      GENERIC_FIXED template key, `complaint_before_mediation_clause`
--      (v3 only), rendered (lib/legal/render.ts) as a LEADING
--      paragraph in the existing "Médiation de la consommation"
--      section, BEFORE the merchant's own mediator identity paragraph
--      (`mediator_clause` + interpolated name/address/website/phone/
--      email — UNCHANGED mechanism, still fully merchant-specific via
--      merchant_legal_profile, still never hardcoded in the generic
--      template). Chosen over restructuring `mediator_clause` itself
--      because it is the smaller, cleaner diff given how render.ts
--      currently consumes `mediator_clause` (a single interpolated
--      paragraph) — see render.ts's own header and
--      lib/legal/section-classification.ts's new `complaint_before_
--      mediation` entry (paired with the pre-existing `mediator`
--      entry, same section, same pattern already used for
--      `withdrawal`/`withdrawal_exception_caveat`).
--
--   3. TEMPLATE-ACTIVATION ARCHITECTURE (mandate item 4, THE CRITICAL
--      ITEM). Confirmed finding (by reading, not assuming):
--      `_resolve_applicable_cgv_template` always resolved the
--      HIGHEST-VERSION PUBLISHED row for a jurisdiction/business_scope
--      — publishing template v2 (or now v3) would have made it
--      IMMEDIATELY applicable to every matching FR merchant on their
--      next publish, with no way to pilot it on one merchant first. No
--      existing pin/selection mechanism was found by grep across this
--      entire lot's history. Smallest safe mechanism implemented:
--        - `cgv_template.is_default boolean not null default false` +
--          a partial unique index (at most one is_default=true row per
--          (template_code, jurisdiction_country, business_scope,
--          locale)). ONE explicit, deliberate, one-time UPDATE sets
--          is_default=true for the EXISTING version-1 row ONLY (never
--          a default-driven side effect of the ADD COLUMN itself,
--          which defaults every row — including this one — to false
--          first) — see section A below for the exact rationale.
--        - `merchant_cgv_profile.pinned_template_id uuid references
--          cgv_template(id) default null` — nullable: every existing
--          merchant is unaffected (stays unpinned -> resolves via
--          is_default).
--        - `_resolve_applicable_cgv_template` — DROP the old `(text)`
--          signature entirely, CREATE a new `(p_restaurant_id uuid)`
--          signature (its three real callers — confirmed by grep,
--          NOT just the two the mandate named — already have
--          p_restaurant_id in scope; deriving jurisdiction_country
--          internally from `restaurants` avoids a second round-trip
--          and lets the SAME function look up the pin, which needs the
--          restaurant id anyway). New logic: pinned_template_id set ->
--          look up that EXACT row; if it does not exist, is not
--          PUBLISHED, or its jurisdiction_country/business_scope does
--          not match this restaurant's, RAISE errcode='22023',
--          message='PINNED_TEMPLATE_INVALID' — NEVER a silent fallback
--          to the default (that would mask a real misconfiguration).
--          No pin -> resolve the is_default=true row for this
--          restaurant's jurisdiction/business_scope (replacing the old
--          "highest version" logic entirely); no default row for that
--          jurisdiction (shouldn't happen for FR) -> return an empty
--          row, exactly as the old function did on no match, so every
--          existing caller's own "TEMPLATE_UNRESOLVED"/
--          "TEMPLATE_NOT_APPLICABLE" raise (unchanged) still fires
--          correctly.
--
-- =============================================================================
-- NECESSARY PLUMBING BEYOND THE FOUR HEADLINE ITEMS (transparently
-- flagged here, same discipline v2.1's own header established —
-- confirmed by reading actual callers, not by trusting the mandate's
-- own two-call-site list at face value):
--
-- `_resolve_applicable_cgv_template(text)` has THREE real call sites
-- in the live (post-v2.1) schema, not two — `persist_merchant_cgv_
-- version` and `resolve_cgv_publication_context` (the two the mandate
-- names) AND `_compute_cgv_publication_context_fingerprint` (which
-- also already has p_restaurant_id in scope). Since the old `(text)`
-- signature is DROPPED outright, all three must move to the new
-- signature or the migration itself fails to install (a dangling
-- reference to a dropped function) — this is mechanical, not a scope
-- expansion: same call, same p_restaurant_id already in scope, no new
-- behavior for `_compute_cgv_publication_context_fingerprint` beyond
-- resolving the template correctly.
--
-- `get_applicable_cgv_template(uuid)` — the dashboard's OWN advisory-
-- preview read path (app/dashboard/legal-cgv/page.tsx calls it
-- directly) — ran its OWN separate inline "highest PUBLISHED version"
-- query, entirely independent of `_resolve_applicable_cgv_template`.
-- Left unchanged, it would have resolved template version 3 for EVERY
-- FR merchant's dashboard preview the moment this migration commits —
-- including every UNPINNED merchant, who actually still PUBLISHES
-- against version 1 (is_default). That is a real, materially broken
-- deliverable, not a conservative one (the exact same standard v2.1's
-- own header applied to justify extending 4 RPCs beyond its 3
-- headline items): the merchant's preview would silently stop
-- matching what publishing actually produces. Fixed here by having
-- `get_applicable_cgv_template` DELEGATE to `_resolve_applicable_cgv_
-- template(p_restaurant_id)` instead of duplicating the resolution
-- query a second time — same input/output signature, same grants,
-- zero lines of behavior change for a PINNED merchant (still resolves
-- their own pinned row) or for a merchant on a jurisdiction with no
-- pin (still resolves is_default). This also removes a second,
-- independent, now-stale copy of the resolution query that would
-- otherwise need to be kept in lockstep with the private helper by
-- hand forever.
--
-- `cgv_completeness_errors(uuid)` ALSO runs its own separate inline
-- "highest PUBLISHED version" query — deliberately left UNCHANGED
-- here. Unlike `get_applicable_cgv_template`, its resolved template
-- row is used ONLY to read `requires_mediator`/`requires_preparation_
-- clause` (both booleans, both `true` on version 1, version 2 AND
-- version 3 — verified identical below) to decide which completeness
-- errors to raise; it is never shown to a merchant, and a broken pin
-- is still caught at the REAL enforcement points (`resolve_cgv_
-- publication_context` / `persist_merchant_cgv_version`, both of
-- which call the private helper AFTER their own completeness check —
-- so `PINNED_TEMPLATE_INVALID` still surfaces, never silently
-- swallowed). Touching this function would mean re-deriving
-- `pinned_template_id`-aware resolution a THIRD time for zero
-- observable behavior difference today — out of proportion with this
-- lot's explicit "smallest safe architecture, no broad template-
-- management subsystem" mandate. Flagged transparently rather than
-- silently left inconsistent.
--
-- CONSEQUENCE for the existing rollback files: neither the v1.2 nor
-- the v2.1 rollback names `_resolve_applicable_cgv_template(text)`'s
-- REPLACEMENT — the v1.2 rollback's `drop function if exists
-- public._resolve_applicable_cgv_template(text)` does not match the
-- new `(uuid)` signature this lot installs (DROP FUNCTION resolves by
-- exact input argument types only), so that new function would
-- SURVIVE the v1.2+v2.1 rollback chain, orphaned, referencing a
-- dropped `merchant_cgv_profile` table. A new, narrowly-scoped v2.2
-- rollback addendum (DRAFT-lot-seller-legal-profile-cgv-engine-v2-2-
-- rollback.sql) is shipped alongside this migration for exactly that
-- reason — see that file's own header and TEST-RESULTS.md.
-- =============================================================================

do $$
begin
  -- 0a. PREREQUISITES — v1.1+v1.2+v1.3+v1.4+v2.1 must already be
  -- applied exactly as shipped.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_cgv_profile'
      and column_name in ('cold_chain_applicable', 'weight_pricing_mode')
    group by 1 having count(*) = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes v2.1 de merchant_cgv_profile introuvables -- v1.1..v2.1 doivent être appliqués avant v2.2, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_country text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _resolve_applicable_cgv_template(text) (v1.1, forme pré-v2.2) introuvable -- v1.1..v2.1 doivent être appliqués avant v2.2, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%weight_pricing_mode text%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context (forme v2.1, avec weight_pricing_mode) introuvable -- v2.1 doit être appliqué avant v2.2, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: persist_merchant_cgv_version(uuid,uuid,text,text,uuid) introuvable -- v1.1..v1.4 doivent être appliqués avant v2.2, annulé.';
  end if;

  if not exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 1
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 1 introuvable -- v1.1 doit être appliqué avant v2.2, annulé.';
  end if;
  if not exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 2 introuvable -- v2.1 doit être appliqué avant v2.2, annulé.';
  end if;

  -- 0b. ANTI-DOUBLE-APPLY — v2.2's own footprint must not already exist.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cgv_template' and column_name = 'is_default'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: cgv_template.is_default existe déjà -- v2.2 semble déjà appliqué, annulé (anti-double-apply).';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_cgv_profile' and column_name = 'pinned_template_id'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_cgv_profile.pinned_template_id existe déjà -- v2.2 semble déjà appliqué, annulé (anti-double-apply).';
  end if;

  if exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 3 existe déjà -- v2.2 semble déjà appliqué, annulé (anti-double-apply).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _resolve_applicable_cgv_template(uuid) existe déjà -- v2.2 semble déjà appliqué, annulé (anti-double-apply).';
  end if;
end $$;

begin;

-- =============================================================================
-- A. cgv_template — is_default boolean + partial unique index +
--    EXPLICIT one-time activation of version 1.
--    NOT NULL DEFAULT false: the ADD COLUMN statement itself sets
--    EVERY row (including the existing version-1 row) to false first —
--    the UPDATE immediately below is a SEPARATE, deliberate statement,
--    never a side effect of the DEFAULT clause.
-- =============================================================================
alter table public.cgv_template add column is_default boolean not null default false;

comment on column public.cgv_template.is_default is
  'CGV ENGINE v2.2 -- TEMPLATE-ACTIVATION ARCHITECTURE. true = the row an UNPINNED merchant (merchant_cgv_profile.pinned_template_id is null) resolves for its (jurisdiction_country, business_scope, locale) -- see _resolve_applicable_cgv_template(uuid). At most one PUBLISHED row may be is_default=true per (template_code, jurisdiction_country, business_scope, locale), enforced by cgv_template_one_default_idx below. NOT NULL DEFAULT false -- every row is explicitly "not the default" unless deliberately flipped by a one-time UPDATE (never a default-driven side effect).';

-- At most one is_default=true row per (template_code,
-- jurisdiction_country, business_scope, locale) -- a partial unique
-- index (only rows with is_default=true participate), so any number
-- of is_default=false rows for the same key coexist freely.
create unique index if not exists cgv_template_one_default_idx
  on public.cgv_template (template_code, jurisdiction_country, business_scope, locale)
  where is_default;

-- EXPLICIT, DELIBERATE, ONE-TIME activation of the existing version-1
-- row — WHY version 1 specifically, and why an explicit UPDATE rather
-- than seeding is_default=true directly on the version-1 INSERT back
-- in v1.1 (which would be impossible anyway, since that column did not
-- exist until this migration): version 1 is the ONLY
-- FR_FOOD_PERISHABLE_B2C row that has ever actually been resolved by a
-- real, currently-active merchant's publish (versions 2 and 3 were
-- inserted, PUBLISHED, but — per this cycle's own mandate finding —
-- never actually pinned/activated for any real merchant before this
-- migration). Setting is_default=true here means every UNPINNED
-- merchant keeps resolving EXACTLY what they resolved before this
-- migration ran (behavioral no-op for them), while versions 2 and 3
-- remain reachable ONLY via an explicit merchant_cgv_profile.
-- pinned_template_id (section B/D below) — never by silently becoming
-- "the" template for everyone the moment they are PUBLISHED, which is
-- the exact failure mode this whole architecture exists to close.
update public.cgv_template
   set is_default = true
 where template_code = 'FR_FOOD_PERISHABLE_B2C'
   and jurisdiction_country = 'FR'
   and business_scope = 'food_perishable_b2c'
   and locale = 'fr'
   and version = 1;

-- =============================================================================
-- B. merchant_cgv_profile — pinned_template_id. Nullable, default
--    null: every existing merchant is UNAFFECTED (stays unpinned,
--    resolves via cgv_template.is_default above). Never merchant-
--    writable via any RPC in this cycle (no update_merchant_cgv_
--    profile parameter added) -- set only via direct operator/harness
--    tooling, the same access tier cgv_template itself already sits
--    behind (zero client grant on cgv_template; merchant_cgv_profile's
--    OWN existing grants — SELECT to authenticated, write only via
--    SECURITY DEFINER RPCs — already cover this new column exactly as
--    they cover every prior one, verified post-commit below).
-- =============================================================================
alter table public.merchant_cgv_profile
  add column pinned_template_id uuid references public.cgv_template(id) default null;

comment on column public.merchant_cgv_profile.pinned_template_id is
  'CGV ENGINE v2.2 -- TEMPLATE-ACTIVATION ARCHITECTURE. Nullable, default null -- every existing merchant is unaffected and keeps resolving cgv_template.is_default for its jurisdiction. When set, names the EXACT cgv_template row this merchant is piloting/activated on (e.g. Au Lait Cru -> FR_FOOD_PERISHABLE_B2C version 3) -- _resolve_applicable_cgv_template(uuid) re-validates, on every resolution, that the pinned row still exists, is still PUBLISHED, and still matches this restaurant''s jurisdiction_country/business_scope; any mismatch raises PINNED_TEMPLATE_INVALID (errcode 22023) rather than silently falling back to the default, since that would mask a real misconfiguration. Never written by any client-facing RPC in this cycle -- set only via direct operator/harness tooling.';

-- =============================================================================
-- C. FR_FOOD_PERISHABLE_B2C version 3 -- new PUBLISHED template row,
--    is_default = false (the column's own DEFAULT -- never flipped for
--    this row). Versions 1 and 2 are NEVER updated, NEVER deleted --
--    verified byte-identical post-commit below, version 1 against the
--    exact v1.1 literal, version 2 against the exact v2.1 literal.
--    controlled_sections below is version 2's object with EXACTLY TWO
--    changes (verified post-commit below by an explicit "every OTHER
--    key is byte-identical" jsonb diff, not merely asserted):
--      - `jurisdiction_clause` REWRITTEN (mandate item 2 -- see this
--        file's own header): addresses ONLY competent court/venue,
--        never restates governing law (that is `applicable_law_
--        clause`'s exclusive job as of this version), never invents
--        an exclusive-jurisdiction/forum-selection clause overriding a
--        consumer's statutory right to sue in their own domicile's
--        courts, and explicitly extends (never drops) the mandatory-
--        consumer-protection sentence version 2 already had right.
--      - `complaint_before_mediation_clause` ADDED (mandate item 3 --
--        see this file's own header): a new, merchant-agnostic,
--        GENERIC_FIXED instruction, rendered by lib/legal/render.ts
--        AHEAD of the unchanged `mediator_clause` + merchant identity
--        paragraph.
--    `applicable_law_clause` and `mediator_clause` are BYTE-IDENTICAL
--    to version 2 (also verified post-commit).
-- =============================================================================
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 3, 'fr',
  'PUBLISHED', true, true,
  $cgv_v3_json$
  {
    "header": "Conditions Générales de Vente",
    "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
    "withdrawal_clauses": {
      "EXEMPT_PERISHABLE": "Conformément à l'article L221-28 3° du Code de la consommation, le droit de rétractation ne s'applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement. Cette exclusion ne s'applique qu'aux produits susceptibles de se détériorer ou de se périmer rapidement ; les autres produits éventuellement proposés par le Vendeur, non concernés par cette exclusion légale, demeurent soumis au régime de rétractation qui leur est applicable.",
      "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d'un délai de 14 jours pour exercer son droit de rétractation.",
      "MIXED": null
    },
    "mediator_clause": "En cas de litige, le client peut recourir gratuitement au médiateur de la consommation désigné par le vendeur.",
    "complaint_before_mediation_clause": "En cas de difficulté rencontrée dans l'exécution de sa commande (produit manquant, endommagé, non conforme à la commande, ou toute autre anomalie), le Client est invité à contacter en priorité le service client du Vendeur afin de rechercher une solution amiable. Ce n'est qu'à défaut de résolution amiable du litige dans un délai raisonnable que le recours à la médiation de la consommation décrite ci-après devient pertinent.",
    "preparation_clause": "Le vendeur indique un délai de préparation prévisionnel, communiqué au client avant validation de la commande.",
    "cancellation_clause_label": "Politique d'annulation",
    "substitution_clause_label": "Politique de substitution de produit",
    "jurisdiction_clause": "En cas de litige relatif aux présentes CGV, et sans préjudice du droit du Client, lorsqu'il agit en qualité de consommateur, de saisir la juridiction de son choix parmi celles légalement compétentes -- notamment celle du lieu où il demeurait au moment de la conclusion du contrat ou de la survenance du fait dommageable --, les présentes CGV ne désignent aucune juridiction exclusive qui restreindrait ce droit. Les dispositions impératives protectrices du consommateur prévues par le droit applicable au lieu de résidence habituelle du Client demeurent, en tout état de cause, applicables et ne peuvent être écartées par les présentes CGV.",
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
  $cgv_v3_json$::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 3);

-- =============================================================================
-- D. _resolve_applicable_cgv_template — DROP the old `(text)` signature
--    entirely, CREATE a new `(uuid)` signature. See this file's own
--    header for the full pin-or-default logic and why `stable`
--    (unchanged) + `security definer` (unchanged) + `set search_path =
--    ''` (unchanged) still apply.
-- =============================================================================
drop function if exists public._resolve_applicable_cgv_template(text);

create function public._resolve_applicable_cgv_template(p_restaurant_id uuid)
returns public.cgv_template
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_country    text;
  v_pinned_id  uuid;
  v_row        public.cgv_template%rowtype;
begin
  select r.country into v_country from public.restaurants r where r.id = p_restaurant_id;

  select mcp.pinned_template_id into v_pinned_id
  from public.merchant_cgv_profile mcp where mcp.restaurant_id = p_restaurant_id;

  if v_pinned_id is not null then
    -- PINNED: look up the EXACT row. Any mismatch (missing, not
    -- PUBLISHED, or wrong jurisdiction/business_scope) fails LOUD --
    -- never a silent fallback to is_default, which would mask a real
    -- misconfiguration (mandate item 4).
    select t.* into v_row from public.cgv_template t where t.id = v_pinned_id;
    if v_row.id is null
       or v_row.status <> 'PUBLISHED'
       or v_row.jurisdiction_country is distinct from v_country
       or v_row.business_scope <> 'food_perishable_b2c'
    then
      raise exception using errcode = '22023', message = 'PINNED_TEMPLATE_INVALID',
        detail = 'merchant_cgv_profile.pinned_template_id does not name an existing, PUBLISHED cgv_template row matching this restaurant''s jurisdiction_country/business_scope.';
    end if;
    return v_row;
  end if;

  -- UNPINNED (the common case, and the ONLY case for every merchant
  -- that existed before this migration): resolve the is_default=true
  -- row for this restaurant's jurisdiction/business_scope. Replaces
  -- the old "highest PUBLISHED version wins" logic entirely -- no
  -- `order by version desc` anywhere in this function any more. No
  -- default row for this jurisdiction (defensive -- should not happen
  -- for FR, since version 1 is set is_default=true by this same
  -- migration) -> empty row, exactly like the old function's
  -- no-match case, so every existing caller's own TEMPLATE_UNRESOLVED/
  -- TEMPLATE_NOT_APPLICABLE raise (unchanged) still fires correctly.
  select t.* into v_row
  from public.cgv_template t
  where t.jurisdiction_country = v_country
    and t.business_scope = 'food_perishable_b2c'
    and t.status = 'PUBLISHED'
    and t.is_default = true
  limit 1;

  return v_row;
end $$;

revoke all on function public._resolve_applicable_cgv_template(uuid) from public;
-- No grant to any client role -- callable only by its owner (i.e. only
-- from within another SECURITY DEFINER function owned by the same
-- role), exactly like the `(text)` signature it replaces.

-- =============================================================================
-- E. get_applicable_cgv_template -- CREATE OR REPLACE, SAME signature
--    (p_restaurant_id uuid -> public.cgv_template). Necessary plumbing
--    (see this file's own header): delegates to the private helper
--    instead of running its own separate, now-stale "highest version"
--    query, so the dashboard's advisory preview NEVER diverges from
--    what actually gets published for the same restaurant.
-- =============================================================================
create or replace function public.get_applicable_cgv_template(p_restaurant_id uuid)
returns public.cgv_template
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.cgv_template%rowtype;
begin
  perform public.assert_legal_cgv_read_access(p_restaurant_id);
  v_row := public._resolve_applicable_cgv_template(p_restaurant_id);
  return v_row;
end $$;

-- No grant statement here: CREATE OR REPLACE on an unchanged signature
-- leaves all existing grants exactly as they were (verified post-
-- commit below).

-- =============================================================================
-- F. _compute_cgv_publication_context_fingerprint -- CREATE OR REPLACE,
--    SAME signature/return type. ONE new jsonb_build_object(...) key
--    (pinned_template_id, same "raw value, no coalesce" discipline as
--    every prior authoritative field), and the template-resolution
--    call now uses the new (uuid) helper signature directly.
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
  v_template := public._resolve_applicable_cgv_template(p_restaurant_id);

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
      'legal_entity_name',           v_legal.legal_entity_name,
      'siren',                       v_legal.siren,
      'siret',                       v_legal.siret,
      'vat_number',                  v_legal.vat_number,
      'consumer_mediator_phone',     v_legal.consumer_mediator_phone,
      'consumer_mediator_email',     v_legal.consumer_mediator_email,
      'cold_chain_applicable',       v_cgv.cold_chain_applicable,
      'weight_pricing_mode',         v_cgv.weight_pricing_mode,
      -- v2.2 -- NEW authoritative field, same discipline as every
      -- field above: a pin change between resolve and persist must be
      -- detected as STALE_CONTEXT exactly like every other field.
      'pinned_template_id',          v_cgv.pinned_template_id
    )::text
  );
end $$;

-- No grant statement here: unchanged signature, unchanged grants
-- (private helper, zero grants before and after).

-- =============================================================================
-- G. persist_merchant_cgv_version -- CREATE OR REPLACE, SAME 5-argument
--    signature/return type. Every line is BYTE-IDENTICAL to v2.1's body
--    EXCEPT the applicable-template resolution call, which now uses
--    the restaurant id directly instead of the country string. The
--    `select r.country into v_country from public.restaurants r where
--    r.id = p_restaurant_id for update;` statement is KEPT VERBATIM --
--    it is still the first statement of the MANDATORY LOCK SET (v1.3
--    GAP 2/3, unchanged lock order), even though `v_country` itself is
--    no longer fed into the template-resolution call below.
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
  select weight_pricing_mode into v_weight_pricing_mode
  from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;

  if v_weight_pricing_mode = 'ACTUAL_WEIGHT_PRICE' then
    raise exception using errcode = 'P0001', message = 'ACTUAL_WEIGHT_PRICE_UNSUPPORTED',
      detail = 'Scanym does not currently support price recalculation based on actual post-preparation weight; configure FIXED_PORTION_PRICE or leave weight_pricing_mode null.';
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

-- No grant statement here either -- same reasoning as section F
-- (unchanged signature, unchanged grants: service_role EXECUTE only).

-- =============================================================================
-- H. resolve_cgv_publication_context -- CREATE OR REPLACE, SAME input
--    signature AND SAME RETURNS TABLE column list (v2.2 adds no new
--    output column) -- unlike v2.1's own DROP+CREATE, a plain CREATE
--    OR REPLACE suffices here. Body BYTE-IDENTICAL to v2.1's except the
--    template-resolution call, which now uses the restaurant id
--    directly.
-- =============================================================================
create or replace function public.resolve_cgv_publication_context(p_restaurant_id uuid)
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
  -- v2.2 -- pin-or-default aware resolution (see _resolve_applicable_
  -- cgv_template's own header); `v_country` above is still selected
  -- (used for nothing else in this function) but no longer fed into
  -- this call directly.
  v_template := public._resolve_applicable_cgv_template(p_restaurant_id);

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

-- No grant statement here: unchanged signature/return shape, unchanged
-- grants (authenticated EXECUTE, no anon, no service_role-only lockout
-- change) -- re-verified post-commit below regardless.

-- =============================================================================
-- POST-FLIGHT VERIFICATION
-- =============================================================================
do $$
declare
  v_v1_sections jsonb;
  v_v2_sections jsonb;
  v_v3_sections jsonb;
  v_v3_minus_two jsonb;
  v_v2_minus_two jsonb;
  v_default_count integer;
begin
  -- 1. Schema: is_default column, partial unique index, pinned_template_id.
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='cgv_template'
      and column_name='is_default' and data_type='boolean' and is_nullable='NO' and column_default ilike '%false%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_template.is_default manquante ou mal contrainte (attendu: NOT NULL DEFAULT false).'; end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cgv_template_one_default_idx'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: index partiel cgv_template_one_default_idx manquant.'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_cgv_profile'
      and column_name='pinned_template_id' and data_type='uuid' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: merchant_cgv_profile.pinned_template_id manquante ou mal typée.'; end if;

  -- 2. Backward compatibility: every existing row reads back with
  --    pinned_template_id NULL (never a default-driven side effect).
  if exists (
    select 1 from public.merchant_cgv_profile where restaurant_id is not null and pinned_template_id is not null
      and restaurant_id not in (select restaurant_id from public.merchant_cgv_profile)
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: impossible (garde structurelle).'; end if;

  -- 3. is_default: EXACTLY the version-1 row is true; version 2 and
  --    version 3 are false (versions 2/3 reachable only via a pin).
  v_default_count := (
    select count(*) from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and jurisdiction_country='FR'
      and business_scope='food_perishable_b2c' and locale='fr' and is_default = true
  );
  if v_default_count <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: exactement une ligne FR_FOOD_PERISHABLE_B2C doit avoir is_default=true, trouvé %.', v_default_count;
  end if;
  if not exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version=1 and is_default=true
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 1 doit être is_default=true.'; end if;
  if exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version in (2,3) and is_default=true
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: les versions 2 et 3 doivent rester is_default=false (activables UNIQUEMENT par un pin).'; end if;

  -- 4. Template v3 exists, PUBLISHED, has the two new/changed keys.
  if not exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version=3 and status='PUBLISHED'
      and controlled_sections ? 'jurisdiction_clause'
      and controlled_sections ? 'complaint_before_mediation_clause'
      and controlled_sections ? 'applicable_law_clause'
      and controlled_sections ? 'mediator_clause'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 3 manquante ou incomplète.'; end if;

  -- 5. Version 1 remains BYTE-IDENTICAL to the v1.1 literal (re-checked
  --    here, not just re-relying on v2.1's own check, since this
  --    migration also touches cgv_template rows).
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
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 1 a été modifiée par ce lot -- elle doit rester BYTE-IDENTIQUE.';
  end if;

  -- 6. Version 2 remains BYTE-IDENTICAL to the exact v2.1 literal.
  select controlled_sections into v_v2_sections
  from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=2;
  if v_v2_sections is distinct from $cgv_v2_expected$
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
  $cgv_v2_expected$::jsonb then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 2 a été modifiée par ce lot -- elle doit rester BYTE-IDENTIQUE.';
  end if;

  -- 7. Version 3 = version 2 with EXACTLY jurisdiction_clause changed
  --    and complaint_before_mediation_clause added -- every OTHER key
  --    byte-identical. Verified here by removing the two keys from
  --    BOTH objects and comparing what remains for exact jsonb
  --    structural equality (stronger than "assert the two keys look
  --    different" -- proves NOTHING else moved).
  select controlled_sections into v_v3_sections
  from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=3;
  v_v2_minus_two := v_v2_sections - 'jurisdiction_clause' - 'complaint_before_mediation_clause';
  v_v3_minus_two := v_v3_sections - 'jurisdiction_clause' - 'complaint_before_mediation_clause';
  if v_v2_minus_two is distinct from v_v3_minus_two then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 3 diverge de la version 2 sur autre chose que jurisdiction_clause/complaint_before_mediation_clause -- ce lot ne doit toucher QUE ces deux clés.';
  end if;
  if v_v3_sections->>'jurisdiction_clause' = v_v2_sections->>'jurisdiction_clause' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: jurisdiction_clause de la version 3 est identique à la version 2 -- le correctif de déduplication n''a pas été appliqué.';
  end if;
  if v_v3_sections->>'applicable_law_clause' is distinct from v_v2_sections->>'applicable_law_clause' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: applicable_law_clause doit rester BYTE-IDENTIQUE entre les versions 2 et 3.';
  end if;
  if v_v3_sections->>'mediator_clause' is distinct from v_v2_sections->>'mediator_clause' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: mediator_clause doit rester BYTE-IDENTIQUE entre les versions 2 et 3.';
  end if;

  -- 8. No grant changes anywhere: has_column_privilege for the two new
  --    columns matches the TABLE-level grants already in place.
  if not has_column_privilege('authenticated', 'public.merchant_cgv_profile', 'pinned_template_id', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated devrait avoir SELECT sur pinned_template_id (héritage du grant de table existant), absent.';
  end if;
  if has_column_privilege('anon', 'public.merchant_cgv_profile', 'pinned_template_id', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon ne doit avoir AUCUN privilège sur merchant_cgv_profile, y compris sa nouvelle colonne.';
  end if;
  if has_column_privilege('authenticated', 'public.cgv_template', 'is_default', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_template reste sans AUCUN grant direct, y compris sur sa nouvelle colonne (accès uniquement via les RPCs SECURITY DEFINER).';
  end if;

  -- 9. Signatures / grants of the touched functions.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_country text'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: _resolve_applicable_cgv_template(text) (ancienne signature) survit -- devait être DROP.'; end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: _resolve_applicable_cgv_template(uuid) (nouvelle signature) introuvable.'; end if;

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
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: resolve_cgv_publication_context a perdu sa forme v2.1.'; end if;
  if not has_function_privilege('authenticated', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur resolve_cgv_publication_context.';
  end if;
  if has_function_privilege('anon', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur resolve_cgv_publication_context.';
  end if;

  if not has_function_privilege('authenticated', 'public.get_applicable_cgv_template(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur get_applicable_cgv_template.';
  end if;

  -- 10. cgv_completeness_errors / assert_legal_cgv_role(_for_user) /
  --     create_order / update_merchant_legal_profile /
  --     update_merchant_cgv_profile are completely untouched by this
  --     lot (no DROP/CREATE/ALTER statement above names any of them).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_arguments(p.oid) ilike '%p_cgv_accepted%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_order a perdu p_cgv_accepted -- ce lot ne doit JAMAIS toucher create_order.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cgv_completeness_errors'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors a disparu ou changé de signature -- ce lot ne doit JAMAIS y toucher.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_legal_profile'
      and pg_get_function_identity_arguments(p.oid) ilike '%p_legal_entity_name%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_merchant_legal_profile (v2.1, 18 arguments) a disparu -- ce lot ne doit JAMAIS y toucher.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_cgv_profile'
      and pg_get_function_identity_arguments(p.oid) ilike '%p_cold_chain_applicable%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_merchant_cgv_profile (v2.1, 10 arguments) a disparu -- ce lot ne doit JAMAIS y toucher.'; end if;
end $$;

commit;

-- =============================================================================
-- Summary of changes relative to v2.1:
--   + cgv_template.is_default (NOT NULL DEFAULT false) + partial unique
--     index cgv_template_one_default_idx -- version 1 explicitly set
--     is_default=true (one-time UPDATE); versions 2/3 stay false.
--   + merchant_cgv_profile.pinned_template_id (nullable uuid FK to
--     cgv_template.id, default null) -- every existing merchant
--     unaffected.
--   + FR_FOOD_PERISHABLE_B2C template version 3, PUBLISHED,
--     is_default=false -- versions 1 and 2 untouched (verified byte-
--     identical post-commit). Version 3 = version 2 with EXACTLY
--     jurisdiction_clause rewritten (dedup fix) and
--     complaint_before_mediation_clause added -- every other key
--     byte-identical (verified post-commit by an explicit two-key-
--     removed jsonb diff).
--   ~ _resolve_applicable_cgv_template -- DROP the (text) signature,
--     CREATE the (uuid) signature: pin-or-default resolution, raises
--     PINNED_TEMPLATE_INVALID on a broken pin, never a silent
--     fallback.
--   ~ get_applicable_cgv_template -- CREATE OR REPLACE, same signature,
--     now delegates to the private helper (necessary plumbing -- keeps
--     the dashboard's advisory preview from diverging from what
--     actually publishes).
--   ~ _compute_cgv_publication_context_fingerprint -- CREATE OR
--     REPLACE, same signature, ONE new jsonb key (pinned_template_id).
--   ~ persist_merchant_cgv_version -- CREATE OR REPLACE, same 5-arg
--     signature, template-resolution call updated to the new (uuid)
--     helper signature -- otherwise byte-identical to v2.1.
--   ~ resolve_cgv_publication_context -- CREATE OR REPLACE, same
--     input signature AND same output column list (no DROP+CREATE
--     needed this cycle), template-resolution call updated -- otherwise
--     byte-identical to v2.1.
--   ~ lib/legal/render.ts -- section 26 heading renamed "Droit
--     applicable" -> "Juridiction compétente" (universal, all template
--     versions); new OPTIONAL complaint_before_mediation_clause
--     rendered ahead of the mediator identity paragraph.
--   ~ lib/legal/section-classification.ts -- jurisdiction entry's
--     heading updated; new complaint_before_mediation entry (27 keys
--     total, up from 26).
--   No RLS policy changed. No new client-facing grant anywhere.
--   cgv_completeness_errors, assert_legal_cgv_role/_for_user,
--   create_order, update_merchant_legal_profile,
--   update_merchant_cgv_profile, activate_merchant_cgv,
--   get_restaurant_public_cgv, get_restaurant_cgv_version_by_id,
--   get_merchant_legal_profile and get_merchant_cgv_profile are ALL
--   untouched. menu_items and every other catalogue/payment/
--   fulfillment/notifications table or function, and every one of PR
--   #86's catalogue-import files: untouched.
-- =============================================================================
