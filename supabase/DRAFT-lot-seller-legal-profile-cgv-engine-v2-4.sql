-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE v2.4 — LEGAL-CORRECTNESS
-- REMEDIATION (citation fix, withdrawal-function disclosure, delivery
-- fallback wording, publication-facing placeholder cleanup, DEFAULT
-- TEMPLATE REASSIGNMENT).
-- DEVELOPMENT ONLY — forward-only DELTA on top of the already-applied
-- v1.1, v1.2, v1.3, v1.4, v2.1 and v2.2 migrations (v2.3 was a pure
-- mechanical baseline refresh, zero functional change, no separate SQL
-- file). It never edits any of those files (verified pre-flight,
-- section 0 below).
--
-- Baseline: yakoutmokhfi-ui/scandz, HEAD 6958ce449f1f882e1f14c254bfa2ad4
-- 668c04baf ("Merge PR #87: customer menu subcategory filter and info
-- card v1.1"). v1.1–v2.2 are CONFIRMED CLOSED and are NOT reopened or
-- redesigned here.
--
-- THIS IS A LEGAL-CORRECTNESS REMEDIATION PASS, NOT A REFRESH — real
-- content changes are made and are REQUIRED, on the following six
-- items (each documented in full in README-AUDIT.md of the packaged
-- deliverable — this header gives the SQL-level summary only):
--
--   1. CITATION FIX. Article L221-28 of the Code de la consommation
--      currently numbers the "goods liable to deteriorate or expire
--      rapidly" withdrawal exception as 4°, not 3° — every prior
--      template version (1, 2, 3, all immutable) cites "3°", which is
--      now incorrect. FR_FOOD_PERISHABLE_B2C version 4 (this file)
--      corrects `withdrawal_clauses.EXEMPT_PERISHABLE` to cite
--      "art. L221-28 4°". Versions 1–3 are NEVER edited (immutable
--      historical record — every merchant who published under one of
--      them keeps that exact byte-for-byte text; only NEW publications
--      going forward, via the is_default reassignment below, get the
--      corrected citation). The v2.2 coexistence caveat sentence
--      (this exclusion applies only to actually-perishable products,
--      never to a merchant's whole catalogue) is preserved and
--      strengthened, never weakened or removed.
--
--   2. ONLINE WITHDRAWAL FUNCTION (new statutory obligation, in force
--      since 19 June 2026, transposing an EU-mandated withdrawal
--      function for e-commerce sellers WHERE a withdrawal right
--      actually exists — it explicitly does NOT apply to contracts
--      exempted from withdrawal, e.g. perishables). Scanym has no such
--      dedicated online function today (confirmed by runtime grep —
--      see README-AUDIT.md's own "runtime inspection" section: no
--      route, service or order-lifecycle code implementing an online
--      withdrawal/self-service post-delivery cancellation anywhere in
--      this codebase). This lot therefore:
--        a) adds HONEST, non-apologetic wording to
--           `withdrawal_clauses.STANDARD_14_DAYS`'s surrounding content
--           (two NEW, OPTIONAL template keys —
--           `withdrawal_exercise_method_clause` and
--           `withdrawal_model_form_text`, see lib/legal/render.ts) that
--           states the right can currently be exercised by any
--           unambiguous means (the model form, email, or any other
--           clear written statement) and that a dedicated online
--           function is not yet available — NEVER phrased as an
--           apology, NEVER "under construction".
--        b) gates both new keys, in lib/legal/render.ts, on
--           `business.withdrawalRegime === 'STANDARD_14_DAYS'` — the
--           ONLY regime where a real withdrawal right exists. Neither
--           key is EVER rendered for EXEMPT_PERISHABLE, regardless of
--           whether the template happens to provide them (defence in
--           depth: the regime gate is the primary control, not merely
--           "don't put these keys on the EXEMPT_PERISHABLE branch").
--        c) MIXED — confirmed, by reading persist_merchant_cgv_version
--           and resolve_cgv_publication_context's actual current
--           bodies (v2.2, unchanged by this lot), that
--           `withdrawal_clauses.MIXED` is still `null` and both
--           functions still fail closed with
--           WITHDRAWAL_REGIME_MIXED_UNSUPPORTED /
--           SCANYM_CGV_RENDER errors for this regime. Scanym has no
--           per-product perishability attribute anywhere in the
--           catalogue schema (no menu_items/menu_categories column for
--           it) — true product-level withdrawal differentiation is a
--           genuine, separate, larger catalogue-schema feature, out of
--           scope for this legal-TEXT remediation lot. Left
--           deliberately UNCHANGED (no regression); documented as an
--           explicit follow-up gap in README-AUDIT.md, same pattern as
--           the v2.1 cold-chain/fulfillment-mode gap.
--        d) `resolve_cgv_publication_context` gains ONE new ADVISORY
--           output column, `online_withdrawal_function_gap boolean` —
--           true iff the resolved withdrawal_regime = 'STANDARD_14_DAYS'
--           (the only regime with a real withdrawal right, hence the
--           only one where the online-function obligation could even
--           apply), false otherwise (EXEMPT_PERISHABLE, and MIXED —
--           which is unpublishable anyway). This is PURELY ADVISORY:
--           it never blocks persist_merchant_cgv_version or
--           activate_merchant_cgv (neither of which is touched by this
--           lot) — it exists so the calling Node/dashboard code MAY
--           show a warning banner to whoever configures a
--           STANDARD_14_DAYS merchant. This is an explicit, flagged
--           judgment call (documented in README-AUDIT.md for human
--           review) given the mandate's own ambiguity between
--           "document" and "block" — the conservative, additive,
--           non-destructive reading was implemented.
--      `resolve_cgv_publication_context`'s RETURNS TABLE column list
--      changes (one new column appended) — like v2.1's own equivalent
--      change, this requires DROP FUNCTION + CREATE FUNCTION (a plain
--      CREATE OR REPLACE cannot change a function's output columns),
--      NOT a change to persist_merchant_cgv_version, which never calls
--      resolve_cgv_publication_context and needs no new field for
--      this. `_compute_cgv_publication_context_fingerprint` ALSO needs
--      no new field: `online_withdrawal_function_gap` is a pure
--      function of `withdrawal_regime`, which the fingerprint already
--      covers (mandate item 7 — explicitly re-confirmed here, not
--      assumed).
--
--   3. DELIVERY WORDING (Code de la consommation article L216-1's
--      default/fallback delivery-timing rule). `delivery_clause`
--      (version 4 only) gains one appended sentence stating that,
--      absent an agreed delivery date/period, the applicable legal
--      delivery-timing provisions remain in force — a FALLBACK-ONLY
--      statement, never a merchant promise, never a literal day count
--      (no "30 jours" anywhere), and never phrased so as to override
--      or outrank the merchant's own displayed preparation/delivery
--      timing.
--
--   4. PLACEHOLDER WORDING REMOVED. `cancellation_clause_fallback` and
--      `substitution_clause_fallback` (version 4 only) are rewritten
--      so neither reads as an admission of incompleteness ("Le
--      Vendeur n'a pas encore renseigné...") while remaining truthful
--      and inventing no merchant-specific policy — each now reads as a
--      complete, genuine, generic legal clause in its own right.
--      lib/legal/render.ts is UNCHANGED for this item: it already
--      layers the merchant's own `cancellation_policy_text`/
--      `substitution_policy_text` over these fallbacks exactly as
--      before — only the NO-VALUE fallback CONTENT changes here.
--
--   5. PHONE RENDERING. Confirmed, by reading lib/legal/render.ts in
--      full (not assumed): `legal.customerServicePhone` is ALREADY
--      rendered — the "Service client" section already joins email
--      and phone with " / " whenever either is present (see that
--      file's Section "Service client" block, unchanged since v1/v2).
--      NO CODE CHANGE was needed or made for this item; this file
--      makes no SQL change either. Documented here, and in
--      README-AUDIT.md, as a confirmation rather than a fix.
--
--   6. DEFAULT TEMPLATE REASSIGNMENT. The wrong citation is a genuine
--      defect in whatever is currently the DEFAULT template (version
--      1, is_default = true since v2.2) — every future UNPINNED
--      merchant would otherwise keep getting the wrong citation
--      indefinitely. This migration explicitly and deliberately
--      reassigns is_default from version 1 to version 4 — ONE clean,
--      intentional pair of UPDATE statements, exactly the kind of
--      "future merchants migrated intentionally" action the v2.2
--      is_default/pinned_template_id architecture exists to support.
--      Versions 1, 2 and 3 remain BYTE-IDENTICAL and immutable
--      (historical record only — verified post-commit below, exactly
--      like every prior cycle's own re-verification of its
--      predecessors); none of them is resolved by ANY unpinned
--      merchant going forward once this migration commits. Au Lait
--      Cru's own `pinned_template_id` is re-pointed to version 4 ONLY
--      in the test harness fixture (supabase/tests/seller-legal-
--      profile-cgv-engine-v2-4-check.sh) — this migration file itself
--      never references Au Lait Cru or any specific merchant, exactly
--      like every prior cycle.
-- =============================================================================

do $$
begin
  -- 0a. PREREQUISITES — v1.1+v1.2+v1.3+v1.4+v2.1+v2.2 must already be
  -- applied exactly as shipped.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cgv_template' and column_name = 'is_default'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: cgv_template.is_default (v2.2) introuvable -- v1.1..v2.2 doivent être appliqués avant v2.4, annulé.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_cgv_profile' and column_name = 'pinned_template_id'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_cgv_profile.pinned_template_id (v2.2) introuvable -- v1.1..v2.2 doivent être appliqués avant v2.4, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: _resolve_applicable_cgv_template(uuid) (v2.2) introuvable -- v2.2 doit être appliqué avant v2.4, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%weight_pricing_mode text%'
      and pg_get_function_result(p.oid) not ilike '%online_withdrawal_function_gap%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context (forme v2.2, sans online_withdrawal_function_gap) introuvable -- v2.2 doit être appliqué avant v2.4, annulé.';
  end if;

  if not exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 1 and is_default = true
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 1 (is_default=true, état v2.2) introuvable -- v1.1..v2.2 doivent être appliqués avant v2.4, annulé.';
  end if;
  if not exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 3 introuvable -- v2.2 doit être appliqué avant v2.4, annulé.';
  end if;

  -- 0b. ANTI-DOUBLE-APPLY — v2.4's own footprint must not already exist.
  if exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 4 existe déjà -- v2.4 semble déjà appliqué, annulé (anti-double-apply).';
  end if;
end $$;

begin;

-- =============================================================================
-- A. FR_FOOD_PERISHABLE_B2C version 4 -- new PUBLISHED template row,
--    is_default = false at INSERT time (the column's own DEFAULT --
--    flipped to true by an EXPLICIT, SEPARATE statement in section B
--    below, never a side effect of this INSERT). Versions 1, 2 and 3
--    are NEVER updated, NEVER deleted -- verified byte-identical
--    post-commit below. controlled_sections below is version 3's
--    object with EXACTLY the following changes (verified post-commit
--    below by an explicit "every OTHER key is byte-identical" jsonb
--    diff, not merely asserted):
--      - `withdrawal_clauses.EXEMPT_PERISHABLE` -- citation corrected
--        from "art. L221-28 3°" to "art. L221-28 4°" (mandate item 1);
--        coexistence caveat sentence PRESERVED and STRENGTHENED (never
--        weakened, never removed).
--      - `withdrawal_clauses.STANDARD_14_DAYS` -- BYTE-IDENTICAL to
--        version 3 (the new model-form/exercise-method content lives
--        in two NEW, SEPARATE, OPTIONAL keys below, gated in
--        lib/legal/render.ts on the merchant's ACTUAL regime, never
--        baked into this string itself -- see this file's own header,
--        mandate item 2).
--      - `withdrawal_clauses.MIXED` -- BYTE-IDENTICAL (still `null`,
--        deliberately unchanged -- mandate item 2c).
--      - `withdrawal_exercise_method_clause` -- NEW, OPTIONAL key.
--      - `withdrawal_model_form_text` -- NEW, OPTIONAL key.
--      - `delivery_clause` -- one sentence appended (mandate item 3).
--      - `cancellation_clause_fallback` -- rewritten, no more "n'a pas
--        encore renseigné" (mandate item 4).
--      - `substitution_clause_fallback` -- rewritten, same reason.
--    Every OTHER key (header, identity_intro, mediator_clause,
--    complaint_before_mediation_clause, preparation_clause,
--    cancellation/substitution labels and intros, jurisdiction_clause,
--    purpose_scope_clause, products_characteristics_clause,
--    portion_pricing_clauses, prices_taxes_clause,
--    ordering_process_clause, contract_formation_clause,
--    payment_clause, availability_clause, pickup_clause,
--    cold_chain_clauses, complaints_clause, legal_guarantees_clause,
--    liability_clause, force_majeure_clause, personal_data_clause,
--    applicable_law_clause) is BYTE-IDENTICAL to version 3.
-- =============================================================================
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 4, 'fr',
  'PUBLISHED', true, true,
  $cgv_v4_json$
  {
    "header": "Conditions Générales de Vente",
    "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
    "withdrawal_clauses": {
      "EXEMPT_PERISHABLE": "Conformément à l'article L221-28 4° du Code de la consommation, le droit de rétractation ne s'applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement. Cette exclusion ne s'applique qu'aux produits susceptibles de se détériorer ou de se périmer rapidement ; elle ne saurait être interprétée comme excluant du droit de rétractation l'ensemble des produits proposés par le Vendeur. Les autres produits éventuellement proposés par le Vendeur, non concernés par cette exclusion légale, demeurent soumis au régime de rétractation qui leur est applicable.",
      "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d'un délai de 14 jours pour exercer son droit de rétractation.",
      "MIXED": null
    },
    "withdrawal_exercise_method_clause": "Le droit de rétractation prévu ci-dessus peut être exercé par tout moyen non équivoque adressé au Vendeur, notamment au moyen du formulaire type de rétractation ci-après, par courrier électronique aux coordonnées de contact du Vendeur indiquées dans les présentes CGV, ou par toute autre déclaration écrite dénuée d'ambiguïté. Une fonctionnalité de rétractation en ligne dédiée n'est pas encore proposée sur la plateforme à ce jour.",
    "withdrawal_model_form_text": "Formulaire type de rétractation (à compléter et renvoyer uniquement si le Client souhaite se rétracter du contrat, à l'attention du Vendeur, aux coordonnées de contact indiquées dans les présentes CGV) -- Je/nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien ci-dessous / la prestation de service ci-dessous (*) : Commandé le (*) / reçu le (*) : Nom du (des) consommateur(s) : Adresse du (des) consommateur(s) : Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) : Date. (*) Rayer la mention inutile.",
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
    "delivery_clause": "Lorsqu'un mode de livraison est proposé et sélectionné par le Client, la commande est acheminée selon les modalités (zone, délai indicatif, prestataire) présentées au Client avant validation de la commande. Le Vendeur ou le prestataire de livraison qu'il mandate met en œuvre les moyens appropriés pour que la commande parvienne au Client dans les meilleurs délais et dans des conditions adaptées à la nature des produits commandés. À défaut de date ou de délai de livraison convenu avec le Client au moment de la commande, les dispositions légales applicables en matière de délai de livraison demeurent en vigueur, sans que cela ne remette en cause les modalités de livraison effectivement communiquées au Client avant validation de sa commande.",
    "cold_chain_clauses": {
      "transport": "Certains produits vendus par le Vendeur nécessitent d'être maintenus à température dirigée (chaîne du froid) afin de préserver leur qualité et leur sécurité sanitaire. Le Vendeur s'engage à préparer et à remettre ces produits au Client, ou au prestataire de livraison, dans des conditions de conservation conformes à leurs exigences de température jusqu'à la remise effective au Client.",
      "post_handover": "À compter de la remise de la commande au Client (retrait ou livraison), il appartient à ce dernier de respecter les conditions de conservation indiquées sur les produits ou communiquées par le Vendeur, notamment en les plaçant sans délai excessif dans un environnement réfrigéré adapté. Le Vendeur ne saurait être tenu responsable d'une dégradation résultant du non-respect de ces conditions par le Client après la remise de la commande."
    },
    "cancellation_clause_intro": "L'annulation d'une commande par le Client peut être possible tant que sa préparation n'a pas débuté. Les conditions précises d'annulation applicables aux commandes passées auprès du Vendeur sont précisées ci-après.",
    "cancellation_clause_fallback": "Sauf indication contraire communiquée par le Vendeur, l'annulation d'une commande par le Client reste possible tant que sa préparation n'a pas débuté ; au-delà, elle demeure soumise aux dispositions légales applicables et, le cas échéant, à un accord entre le Client et le Vendeur.",
    "substitution_clause_intro": "Sauf accord exprès du Client, aucun produit de substitution présentant une différence significative avec le produit commandé — notamment en matière d'allergènes, de prix, de nature du produit, de quantité ou de caractéristiques diététiques — ne saurait être considéré comme accepté par le Client du seul fait de sa livraison ou de sa mise à disposition. Les conditions de substitution propres au Vendeur sont précisées ci-après.",
    "substitution_clause_fallback": "Sauf indication contraire communiquée par le Vendeur, la règle générale énoncée ci-dessus constitue la politique de substitution applicable : aucun produit de substitution présentant une différence significative ne peut être imposé au Client sans son accord exprès.",
    "complaints_clause": "En cas de produit manquant, endommagé, non conforme à la commande, ou de toute autre anomalie constatée à la réception, le Client est invité à en informer le Vendeur dans les meilleurs délais, via les coordonnées de contact du Vendeur indiquées dans les présentes CGV, en précisant si possible la nature de l'anomalie et en fournissant, le cas échéant, des photographies illustrant le problème constaté. Cette information ne constitue pas un délai contractuel de réclamation et ne saurait restreindre les droits légaux du Client.",
    "legal_guarantees_clause": "Sans préjudice des dispositions applicables au droit de rétractation et à ses exceptions, le Client bénéficie, dans les conditions prévues par la loi et pour les produits qui y sont éligibles, de la garantie légale de conformité (articles L217-3 et suivants du Code de la consommation) et de la garantie légale contre les vices cachés (articles 1641 et suivants du Code civil).",
    "liability_clause": "Le Vendeur ne saurait être tenu responsable de l'inexécution ou de la mauvaise exécution du contrat qui serait imputable au Client, à un tiers étranger à la fourniture des produits, ou à un cas de force majeure. La responsabilité du Vendeur ne pourra être engagée que dans les conditions et limites prévues par les dispositions légales applicables aux relations entre professionnels et consommateurs.",
    "force_majeure_clause": "Aucune des parties ne pourra être tenue responsable envers l'autre en cas de manquement à l'une de ses obligations résultant d'un événement de force majeure, au sens de l'article 1218 du Code civil.",
    "personal_data_clause": "Les données personnelles du Client sont collectées et traitées par Scanym et/ou le Vendeur pour les besoins de la gestion de la commande, de la relation client et, le cas échéant, du respect d'obligations légales et comptables. Conformément à la réglementation applicable en matière de protection des données personnelles, Scanym met en œuvre des mesures techniques permettant la suppression ou l'anonymisation périodique de certaines données personnelles liées aux commandes, au-delà d'une durée de conservation définie dans sa politique de gestion des données, laquelle est disponible auprès de Scanym. Les données nécessaires à l'établissement de documents comptables, fiscaux ou de facturation sont conservées séparément, pour la durée exigée par les obligations légales applicables, indépendamment de la suppression ou de l'anonymisation des données personnelles du Client. Le Client dispose, dans les conditions prévues par la réglementation applicable, d'un droit d'accès, de rectification et de suppression de ses données, qu'il peut exercer auprès du Vendeur ou de Scanym.",
    "applicable_law_clause": "Les présentes CGV sont soumises au droit applicable dans le pays de rattachement du Vendeur tel qu'indiqué dans son profil légal, sans préjudice des dispositions impératives de protection des consommateurs qui pourraient être applicables en vertu du droit du pays de résidence habituelle du Client."
  }
  $cgv_v4_json$::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 4);

-- =============================================================================
-- B. is_default REASSIGNMENT -- DELIBERATE, EXPLICIT, LEGAL-CORRECTNESS-
--    DRIVEN default change (mandate item 6), NOT a side effect of the
--    INSERT above (version 4's own INSERT sets is_default to the
--    column's DEFAULT, false, exactly like version 3's own v2.2
--    INSERT did). Two separate, deliberate UPDATE statements: version 1
--    -> false, version 4 -> true. The partial unique index
--    cgv_template_one_default_idx (v2.2, unchanged) still enforces at
--    most one is_default=true row per (template_code,
--    jurisdiction_country, business_scope, locale) -- doing the
--    "unset old default" UPDATE BEFORE the "set new default" UPDATE
--    avoids ever violating that constraint mid-transaction.
-- =============================================================================
update public.cgv_template
   set is_default = false
 where template_code = 'FR_FOOD_PERISHABLE_B2C'
   and jurisdiction_country = 'FR'
   and business_scope = 'food_perishable_b2c'
   and locale = 'fr'
   and version = 1;

update public.cgv_template
   set is_default = true
 where template_code = 'FR_FOOD_PERISHABLE_B2C'
   and jurisdiction_country = 'FR'
   and business_scope = 'food_perishable_b2c'
   and locale = 'fr'
   and version = 4;

-- =============================================================================
-- C. resolve_cgv_publication_context -- DROP + CREATE (a change to the
--    RETURNS TABLE column list cannot be done with a plain CREATE OR
--    REPLACE -- same treatment v2.1 used for its own new output
--    columns). SAME input signature (p_restaurant_id uuid). Every line
--    of the body is BYTE-IDENTICAL to v2.2's except: one new local
--    variable (v_online_withdrawal_function_gap), one new RETURNS
--    TABLE column (online_withdrawal_function_gap boolean, appended at
--    the end), and that column's value appended to the final `return
--    query select` list. PURELY ADVISORY -- never referenced by, and
--    never blocks, persist_merchant_cgv_version or
--    activate_merchant_cgv (neither of which is touched by this file).
-- =============================================================================
drop function if exists public.resolve_cgv_publication_context(uuid);

create function public.resolve_cgv_publication_context(p_restaurant_id uuid)
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
  -- v2.4 -- NEW, ADVISORY-ONLY output column (mandate item 2d). true
  -- iff withdrawal_regime = 'STANDARD_14_DAYS' -- the only regime with
  -- a real withdrawal right, hence the only one where the "online
  -- withdrawal function" statutory obligation could even apply. Never
  -- used to block publication/activation; surfaced purely so calling
  -- code MAY warn whoever configures such a merchant.
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
-- No grant to anon -- same posture as every prior cycle, re-verified
-- post-commit below.

-- =============================================================================
-- POST-FLIGHT VERIFICATION
-- =============================================================================
do $$
declare
  v_v1_sections   jsonb;
  v_v2_sections   jsonb;
  v_v3_sections   jsonb;
  v_v4_sections   jsonb;
  v_v3_minus_five jsonb;
  v_v4_minus_five jsonb;
  v_default_count integer;
begin
  -- 1. Exactly one is_default=true row for FR_FOOD_PERISHABLE_B2C, and
  --    it is version 4 -- version 1 is now false.
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
    where template_code='FR_FOOD_PERISHABLE_B2C' and version=4 and is_default=true
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 4 doit être is_default=true après réassignation.'; end if;
  if exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version in (1,2,3) and is_default=true
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: les versions 1, 2 et 3 doivent être is_default=false après réassignation.'; end if;

  -- 2. Version 4 exists, PUBLISHED, has the two new withdrawal keys and
  --    the citation fix.
  if not exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version=4 and status='PUBLISHED'
      and controlled_sections ? 'withdrawal_exercise_method_clause'
      and controlled_sections ? 'withdrawal_model_form_text'
      and controlled_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE' ilike '%L221-28 4°%'
      and controlled_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE' not ilike '%L221-28 3°%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 4 manquante ou incomplète (citation/nouvelles clés).'; end if;

  if (select controlled_sections->>'delivery_clause' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=4) ilike '%30 jours%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: delivery_clause de la version 4 contient un littéral "30 jours" -- interdit par le mandat.';
  end if;
  if (select controlled_sections->>'cancellation_clause_fallback' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=4) ilike '%n''a pas encore renseigné%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cancellation_clause_fallback de la version 4 contient encore le libellé "n''a pas encore renseigné".';
  end if;
  if (select controlled_sections->>'substitution_clause_fallback' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=4) ilike '%n''a pas encore renseigné%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: substitution_clause_fallback de la version 4 contient encore le libellé "n''a pas encore renseigné".';
  end if;

  -- 3. Versions 1, 2 and 3 remain BYTE-IDENTICAL to their own prior
  --    literals (re-checked here, not merely re-relying on v2.2's own
  --    check, since this migration also touches cgv_template rows).
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

  select controlled_sections into v_v3_sections
  from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=3;
  if (v_v3_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') not ilike '%L221-28 3°%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 3 a été modifiée par ce lot -- elle doit rester BYTE-IDENTIQUE (toujours "L221-28 3°", l''ancienne citation, historique).';
  end if;

  -- 4. Version 4 = version 3 with EXACTLY the five documented keys
  --    changed/added (withdrawal_clauses.EXEMPT_PERISHABLE,
  --    withdrawal_exercise_method_clause, withdrawal_model_form_text,
  --    delivery_clause, cancellation_clause_fallback,
  --    substitution_clause_fallback) -- verified here by removing all
  --    six from BOTH objects (withdrawal_clauses handled as a whole
  --    since it is a nested object with one changed sub-key) and
  --    comparing what remains for exact jsonb structural equality.
  select controlled_sections into v_v4_sections
  from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=4;
  v_v3_minus_five := (v_v3_sections - 'withdrawal_clauses' - 'delivery_clause' - 'cancellation_clause_fallback' - 'substitution_clause_fallback');
  v_v4_minus_five := (v_v4_sections - 'withdrawal_clauses' - 'withdrawal_exercise_method_clause' - 'withdrawal_model_form_text' - 'delivery_clause' - 'cancellation_clause_fallback' - 'substitution_clause_fallback');
  if v_v3_minus_five is distinct from v_v4_minus_five then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 4 diverge de la version 3 sur autre chose que les clés documentées -- ce lot ne doit toucher QUE celles-ci.';
  end if;
  if (v_v4_sections->'withdrawal_clauses'->>'STANDARD_14_DAYS') is distinct from (v_v3_sections->'withdrawal_clauses'->>'STANDARD_14_DAYS') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: withdrawal_clauses.STANDARD_14_DAYS doit rester BYTE-IDENTIQUE entre les versions 3 et 4.';
  end if;
  if (v_v4_sections->'withdrawal_clauses'->'MIXED') is distinct from (v_v3_sections->'withdrawal_clauses'->'MIXED') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: withdrawal_clauses.MIXED doit rester BYTE-IDENTIQUE (null) entre les versions 3 et 4.';
  end if;
  if (v_v4_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') = (v_v3_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: withdrawal_clauses.EXEMPT_PERISHABLE de la version 4 est identique à la version 3 -- le correctif de citation n''a pas été appliqué.';
  end if;
  if (v_v4_sections->>'applicable_law_clause') is distinct from (v_v3_sections->>'applicable_law_clause') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: applicable_law_clause doit rester BYTE-IDENTIQUE entre les versions 3 et 4.';
  end if;
  if (v_v4_sections->>'jurisdiction_clause') is distinct from (v_v3_sections->>'jurisdiction_clause') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: jurisdiction_clause doit rester BYTE-IDENTIQUE entre les versions 3 et 4.';
  end if;

  -- 5. Signature / grants of resolve_cgv_publication_context.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%online_withdrawal_function_gap boolean%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: resolve_cgv_publication_context n''expose pas online_withdrawal_function_gap.'; end if;
  if not has_function_privilege('authenticated', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur resolve_cgv_publication_context.';
  end if;
  if has_function_privilege('anon', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur resolve_cgv_publication_context.';
  end if;

  -- 6. Every function this lot must NEVER touch is unchanged.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: persist_merchant_cgv_version a changé de signature -- ce lot ne devait JAMAIS y toucher.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'activate_merchant_cgv'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: activate_merchant_cgv a disparu ou changé de signature -- ce lot ne devait JAMAIS y toucher.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cgv_completeness_errors'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors a disparu ou changé de signature -- ce lot ne devait JAMAIS y toucher.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: _resolve_applicable_cgv_template a disparu ou changé de signature -- ce lot ne devait JAMAIS y toucher.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_applicable_cgv_template a disparu ou changé de signature -- ce lot ne devait JAMAIS y toucher.'; end if;
end $$;

commit;

-- =============================================================================
-- Summary of changes relative to v2.2:
--   + FR_FOOD_PERISHABLE_B2C template version 4, PUBLISHED,
--     is_default=true (versions 1/2/3 untouched, byte-identical,
--     is_default=false). Version 4 = version 3 with: citation fix
--     (L221-28 3° -> 4°) + strengthened coexistence caveat in
--     withdrawal_clauses.EXEMPT_PERISHABLE; two new OPTIONAL keys
--     (withdrawal_exercise_method_clause, withdrawal_model_form_text);
--     one sentence appended to delivery_clause; cancellation_clause_
--     fallback and substitution_clause_fallback rewritten (no more
--     "n'a pas encore renseigné"). withdrawal_clauses.STANDARD_14_DAYS/
--     MIXED, applicable_law_clause, jurisdiction_clause and every
--     other key byte-identical to version 3.
--   ~ is_default REASSIGNED from version 1 to version 4 (two explicit
--     UPDATE statements) -- every future UNPINNED merchant now
--     resolves version 4, not version 1.
--   ~ resolve_cgv_publication_context -- DROP + CREATE (RETURNS TABLE
--     column list changed), same input signature, ONE new advisory
--     output column (online_withdrawal_function_gap boolean), body
--     otherwise byte-identical to v2.2.
--   ~ lib/legal/render.ts -- withdrawal section renders
--     withdrawal_exercise_method_clause/withdrawal_model_form_text
--     ONLY when business.withdrawalRegime === 'STANDARD_14_DAYS' AND
--     the template provides the key; NEVER for EXEMPT_PERISHABLE.
--   No RLS policy changed. No new client-facing grant anywhere.
--   persist_merchant_cgv_version, activate_merchant_cgv,
--   cgv_completeness_errors, _resolve_applicable_cgv_template,
--   get_applicable_cgv_template, _compute_cgv_publication_context_
--   fingerprint, assert_legal_cgv_role/_for_user, create_order,
--   update_merchant_legal_profile, update_merchant_cgv_profile are ALL
--   untouched. menu_items and every other catalogue/payment/
--   fulfillment/notifications table or function, and every one of PR
--   #86/#87's own files: untouched.
-- =============================================================================
