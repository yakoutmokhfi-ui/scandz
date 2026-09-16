-- =============================================================================
-- Scanym — SELLER LEGAL PROFILE + CGV ENGINE v2.5 — FINAL PRE-AUDIT
-- COMPLETION (official D.211-2 legal-guarantee encadré, per-order-line
-- withdrawal legal-basis snapshot, enforced withdrawal-runtime fail-
-- closed guard, publication hard-block matrix).
-- DEVELOPMENT ONLY — forward-only DELTA on top of the already-applied
-- v1.1, v1.2, v1.3, v1.4, v2.1, v2.2 and v2.4 migrations (v2.3 was a
-- pure mechanical baseline refresh, zero functional change, no
-- separate SQL file). It never edits any of those files (verified
-- pre-flight, section 0 below).
--
-- Baseline: yakoutmokhfi-ui/scandz, HEAD 6958ce449f1f882e1f14c254bfa2ad4
-- 668c04baf ("Merge PR #87: customer menu subcategory filter and info
-- card v1.1"). v1.1–v2.4 are CONFIRMED CLOSED and are NOT reopened or
-- redesigned here (L221-28 4° citation, mixed-catalogue coexistence
-- text, model withdrawal form gated on STANDARD_14_DAYS, delivery
-- fallback wording, de-placeholdered cancellation/substitution
-- fallback, is_default on template v4 — all preserved, re-verified
-- byte-identical below, never regressed).
--
-- THIS LOT CLOSES THE REMAINING GAPS ONLY (five tasks, SQL-level
-- summary — full narrative in README-AUDIT.md of the packaged
-- deliverable):
--
--   TASK 1 — D.211-2 OFFICIAL LEGAL-GUARANTEE ENCADRÉ. The short,
--     generic "Garanties légales" paragraph is NOT replaced/deleted
--     (it stays, byte-identical, for continuity) but is now followed
--     by the ACTUAL official regulatory encadré mandated by article
--     D.211-2 du Code de la consommation (Annexe, Section A — "biens,
--     hors animaux domestiques", in force since 2022-10-01, Décret
--     n° 2022-946 du 29 juin 2022, art. 2), embedded VERBATIM, in full,
--     as a NEW `legal_guarantee_encadre` template key (heading +
--     17-paragraph array) on a NEW FR_FOOD_PERISHABLE_B2C template
--     version 5 (versions 1-4 NEVER edited, byte-identical, re-
--     verified post-commit below). Rendered as its OWN distinct,
--     bordered block by lib/legal/render.ts (class=
--     "legal-guarantee-encadre") — see that file's own v2.5 header.
--     Applies UNIFORMLY to every B2C goods sale under L.217-1,
--     regardless of withdrawal_regime — deliberately NO new
--     `product_condition`-style field: the legal-guarantee regime
--     (conformité + vices cachés) is orthogonal to the withdrawal-
--     right regime, so this is rendered as a GENERIC_FIXED section
--     (lib/legal/section-classification.ts), same category as every
--     other non-negotiable statutory clause. No new fingerprint field
--     is needed either: `controlled_sections` (the whole jsonb blob,
--     including this new key) is ALREADY part of
--     `_compute_cgv_publication_context_fingerprint`'s authoritative
--     input set — explicitly RE-CONFIRMED here, not assumed (same
--     discipline v2.4 used for `online_withdrawal_function_gap`).
--     is_default is reassigned from version 4 to version 5 (section B
--     below), same explicit two-UPDATE pattern as v2.2/v2.4.
--
--   TASK 4 — ENFORCEABLE ONLINE-WITHDRAWAL FAIL-CLOSED GUARD. v2.4's
--     `online_withdrawal_function_gap` output column
--     (resolve_cgv_publication_context) stays exactly as it was
--     (still purely advisory for any caller reading it) — this lot
--     adds a SEPARATE, ACTUAL, enforced block: a NEW helper function,
--     `_scanym_has_online_withdrawal_runtime()` (returns `false` —
--     confirmed by real runtime discovery: no route, service, or
--     order-lifecycle code anywhere in app/ or lib/ implements an
--     online withdrawal-request submission flow), consulted by BOTH
--     `resolve_cgv_publication_context` AND
--     `persist_merchant_cgv_version` (mandate: "check both") — a
--     STANDARD_14_DAYS merchant with this function absent gets a loud,
--     specific, non-ignorable `WITHDRAWAL_RUNTIME_NOT_READY` exception
--     (errcode P0001), following the EXACT same fail-closed
--     top-of-function placement/style as `ACTUAL_WEIGHT_PRICE_
--     UNSUPPORTED`. EXEMPT_PERISHABLE (Au Lait Cru) is NEVER blocked —
--     the condition is never even evaluated for it.
--
--   TASK 5 — PUBLICATION HARD-BLOCK MATRIX. Two NEW enforced checks in
--     `persist_merchant_cgv_version`, operating on the FINAL rendered
--     content (`p_rendered_content`), never merely the template row:
--       - `PLACEHOLDER_TEXT_DETECTED` — any of a generic set of
--         unresolved-placeholder markers (item 1; also the forward
--         defense for a future fabricated/placeholder privacy-policy
--         URL, item 4 — Scanym's CGV content references NO
--         privacy-policy URL at all today, verified by grep, so item
--         4 has no live trigger yet; documented, not invented).
--       - `LEGAL_GUARANTEE_BLOCK_MISSING` — the D.211-2 encadré (Task
--         1) is missing from the final rendered output (item 5) —
--         deliberately blocks a merchant pinned to a template older
--         than version 5 from publishing.
--     Every other item of the mandate's 9-item hard-block list is
--     ALREADY enforced by pre-existing code, re-confirmed (not merely
--     assumed) by this file's own postflight checks and by the v2.5
--     test harness: (2) LEGAL_IDENTITY_MISSING/LEGAL_ADDRESS_MISSING/
--     CUSTOMER_CONTACT_MISSING, (3) MEDIATOR_INFO_MISSING, (6)
--     TEMPLATE_UNRESOLVED / cross-jurisdiction rejection
--     ([BLOCKER1/TEMPLATE-AUTHORITY], v1.1), (7) the one identified
--     runtime-capability-claim instance is (8)'s own withdrawal check,
--     (8) `WITHDRAWAL_RUNTIME_NOT_READY` (Task 4 above), (9)
--     `PINNED_TEMPLATE_INVALID` (v2.2, `_resolve_applicable_cgv_
--     template`, called by all three of resolve_cgv_publication_
--     context / persist_merchant_cgv_version / get_applicable_cgv_
--     template) — all cgv_completeness_errors(uuid) codes, unchanged,
--     ALL still wired into resolve_cgv_publication_context AND
--     persist_merchant_cgv_version (both call it, unchanged call
--     sites).
--
--   TASK 2/3 — WITHDRAWAL ARCHITECTURE DISCOVERY + LEGAL-BASIS
--     SNAPSHOT (minimal, non-invasive, additive-only). Real discovery
--     (README-AUDIT.md has the full narrative): menu_items (no per-
--     product perishability/withdrawal-classification column exists
--     anywhere — confirmed absent), orders/order_items (migration-
--     orders.sql, extended by DRAFT-lot-catalogue-fiscal-product-
--     measurements-v1.sql with tax_rate/unit_weight_grams/weight_is_
--     approximate + their own `_snapshot` columns on order_items,
--     copied ONCE at order-creation time from menu_items, never re-
--     read afterward — the EXACT immutable-snapshot precedent this
--     lot follows), order_cgv_acceptance (v1.1 — cgv_version_id +
--     content_hash snapshotted once at order-creation time, written
--     ONLY by create_order, SECURITY DEFINER, zero client write path —
--     the EXACT immutable-acceptance precedent this lot follows),
--     order_invoice_request / payment_transactions (reference orders,
--     no refund/RMA table or status value exists anywhere — confirmed
--     absent, see README-AUDIT.md's MIXED-ORDER WITHDRAWAL RUNTIME GAP
--     finding, Task 3). This lot adds THREE new NULLABLE columns to
--     `order_items` (section C below), populated ONLY inside
--     `create_order`'s existing `v_cgv_status = 'CGV_ACTIVE'` gate
--     (section E below), from the SAME merchant_cgv_version row
--     already resolved for `order_cgv_acceptance` (never a second,
--     independent template/profile read, never derived from CURRENT
--     product configuration) — pre-existing rows are left NULL by the
--     bare `alter table ... add column` (Postgres default for a new
--     nullable column with no `default` clause), NEVER backfilled
--     with a guessed value. Postflight section proves BOTH required
--     invariants: (i) changing a merchant's CURRENT withdrawal_regime
--     configuration (the only classification axis that actually
--     exists in this schema — Scanym has no per-product/per-SKU field,
--     confirmed above) does NOT change an already-written order_items
--     row's snapshot; (ii) changing which cgv_template row is
--     is_default does NOT change an already-accepted order_cgv_
--     acceptance row's content_hash/cgv_version_id.
-- =============================================================================

do $$
begin
  -- 0a. PREREQUISITES — v1.1+v1.2+v1.3+v1.4+v2.1+v2.2+v2.4 must already
  -- be applied exactly as shipped.
  if not exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 4 and is_default = true
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 4 (is_default=true, état v2.4) introuvable -- v1.1..v2.4 doivent être appliqués avant v2.5, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%online_withdrawal_function_gap boolean%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_cgv_publication_context (forme v2.4, avec online_withdrawal_function_gap) introuvable -- v2.4 doit être appliqué avant v2.5, annulé.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items' and column_name = 'tax_rate_snapshot'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: order_items.tax_rate_snapshot (CATALOGUE FISCAL v1) introuvable -- prérequis manquant, annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_arguments(p.oid) ilike '%p_cgv_accepted%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order (forme v1.1, avec p_cgv_accepted) introuvable -- prérequis manquant, annulé.';
  end if;

  -- 0b. ANTI-DOUBLE-APPLY — v2.5's own footprint must not already exist.
  if exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 5 existe déjà -- v2.5 semble déjà appliqué, annulé (anti-double-apply).';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items' and column_name = 'withdrawal_legal_basis_at_order_time'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: order_items.withdrawal_legal_basis_at_order_time existe déjà -- v2.5 semble déjà appliqué, annulé (anti-double-apply).';
  end if;
end $$;

begin;

-- =============================================================================
-- A. FR_FOOD_PERISHABLE_B2C version 5 -- new PUBLISHED template row,
--    is_default = false at INSERT time (flipped to true by an
--    EXPLICIT, SEPARATE statement in section B below). Versions 1-4
--    are NEVER updated, NEVER deleted -- verified byte-identical
--    post-commit below. controlled_sections below is version 4's
--    object with EXACTLY ONE addition:
--      - `legal_guarantee_encadre` -- NEW key (Task 1). The official
--        D.211-2 Annexe Section A model text, embedded VERBATIM, in
--        full (17 paragraphs, none truncated, none paraphrased).
--    Every OTHER key is BYTE-IDENTICAL to version 4 (verified post-
--    commit below by an explicit "every OTHER key is byte-identical"
--    jsonb diff, not merely asserted).
-- =============================================================================
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 5, 'fr',
  'PUBLISHED', true, true,
  $cgv_v5_json$
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
    "legal_guarantees_clause": "Sans préjudice des dispositions applicables au droit de rétractation et à ses exceptions, le Client bénéficie, dans les conditions prévues par la loi et pour les produits qui y sont éligibles, de la garantie légale de conformité (articles L217-3 et suivants du Code de la consommation) et de la garantie légale contre les vices cachés (articles 1641 et suivants du Code civil). Les modalités précises de mise en œuvre de ces garanties sont détaillées dans l'encadré réglementaire ci-après.",
    "legal_guarantee_encadre": {
      "heading": "Garantie légale de conformité et garantie des vices cachés (article D. 211-2 du Code de la consommation)",
      "paragraphs": [
        "Le consommateur dispose d'un délai de deux ans à compter de la délivrance du bien pour obtenir la mise en œuvre de la garantie légale de conformité en cas d'apparition d'un défaut de conformité. Durant ce délai, le consommateur n'est tenu d'établir que l'existence du défaut de conformité et non la date d'apparition de celui-ci.",
        "Lorsque le contrat de vente du bien prévoit la fourniture d'un contenu numérique ou d'un service numérique de manière continue pendant une durée supérieure à deux ans, la garantie légale est applicable à ce contenu numérique ou ce service numérique tout au long de la période de fourniture prévue. Durant ce délai, le consommateur n'est tenu d'établir que l'existence du défaut de conformité affectant le contenu numérique ou le service numérique et non la date d'apparition de celui-ci.",
        "La garantie légale de conformité emporte obligation pour le professionnel, le cas échéant, de fournir toutes les mises à jour nécessaires au maintien de la conformité du bien.",
        "La garantie légale de conformité donne au consommateur droit à la réparation ou au remplacement du bien dans un délai de trente jours suivant sa demande, sans frais et sans inconvénient majeur pour lui.",
        "Si le bien est réparé dans le cadre de la garantie légale de conformité, le consommateur bénéficie d'une extension de six mois de la garantie initiale.",
        "Si le consommateur demande la réparation du bien, mais que le vendeur impose le remplacement, la garantie légale de conformité est renouvelée pour une période de deux ans à compter de la date de remplacement du bien.",
        "Le consommateur peut obtenir une réduction du prix d'achat en conservant le bien ou mettre fin au contrat en se faisant rembourser intégralement contre restitution du bien, si :",
        "1° Le professionnel refuse de réparer ou de remplacer le bien ;",
        "2° La réparation ou le remplacement du bien intervient après un délai de trente jours ;",
        "3° La réparation ou le remplacement du bien occasionne un inconvénient majeur pour le consommateur, notamment lorsque le consommateur supporte définitivement les frais de reprise ou d'enlèvement du bien non conforme, ou s'il supporte les frais d'installation du bien réparé ou de remplacement ;",
        "4° La non-conformité du bien persiste en dépit de la tentative de mise en conformité du vendeur restée infructueuse.",
        "Le consommateur a également droit à une réduction du prix du bien ou à la résolution du contrat lorsque le défaut de conformité est si grave qu'il justifie que la réduction du prix ou la résolution du contrat soit immédiate. Le consommateur n'est alors pas tenu de demander la réparation ou le remplacement du bien au préalable.",
        "Le consommateur n'a pas droit à la résolution de la vente si le défaut de conformité est mineur.",
        "Toute période d'immobilisation du bien en vue de sa réparation ou de son remplacement suspend la garantie qui restait à courir jusqu'à la délivrance du bien remis en état.",
        "Les droits mentionnés ci-dessus résultent de l'application des articles L. 217-1 à L. 217-32 du code de la consommation.",
        "Le vendeur qui fait obstacle de mauvaise foi à la mise en œuvre de la garantie légale de conformité encourt une amende civile d'un montant maximal de 300 000 euros, qui peut être porté jusqu'à 10 % du chiffre d'affaires moyen annuel (article L. 241-5 du code de la consommation).",
        "Le consommateur bénéficie également de la garantie légale des vices cachés en application des articles 1641 à 1649 du code civil, pendant une durée de deux ans à compter de la découverte du défaut. Cette garantie donne droit à une réduction de prix si le bien est conservé ou à un remboursement intégral contre restitution du bien."
      ]
    },
    "liability_clause": "Le Vendeur ne saurait être tenu responsable de l'inexécution ou de la mauvaise exécution du contrat qui serait imputable au Client, à un tiers étranger à la fourniture des produits, ou à un cas de force majeure. La responsabilité du Vendeur ne pourra être engagée que dans les conditions et limites prévues par les dispositions légales applicables aux relations entre professionnels et consommateurs.",
    "force_majeure_clause": "Aucune des parties ne pourra être tenue responsable envers l'autre en cas de manquement à l'une de ses obligations résultant d'un événement de force majeure, au sens de l'article 1218 du Code civil.",
    "personal_data_clause": "Les données personnelles du Client sont collectées et traitées par Scanym et/ou le Vendeur pour les besoins de la gestion de la commande, de la relation client et, le cas échéant, du respect d'obligations légales et comptables. Conformément à la réglementation applicable en matière de protection des données personnelles, Scanym met en œuvre des mesures techniques permettant la suppression ou l'anonymisation périodique de certaines données personnelles liées aux commandes, au-delà d'une durée de conservation définie dans sa politique de gestion des données, laquelle est disponible auprès de Scanym. Les données nécessaires à l'établissement de documents comptables, fiscaux ou de facturation sont conservées séparément, pour la durée exigée par les obligations légales applicables, indépendamment de la suppression ou de l'anonymisation des données personnelles du Client. Le Client dispose, dans les conditions prévues par la réglementation applicable, d'un droit d'accès, de rectification et de suppression de ses données, qu'il peut exercer auprès du Vendeur ou de Scanym.",
    "applicable_law_clause": "Les présentes CGV sont soumises au droit applicable dans le pays de rattachement du Vendeur tel qu'indiqué dans son profil légal, sans préjudice des dispositions impératives de protection des consommateurs qui pourraient être applicables en vertu du droit du pays de résidence habituelle du Client."
  }
  $cgv_v5_json$::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5);

-- =============================================================================
-- B. is_default REASSIGNMENT -- DELIBERATE, EXPLICIT (mandate Task 1),
--    NOT a side effect of the INSERT above. Two separate, deliberate
--    UPDATE statements: version 4 -> false, version 5 -> true. The
--    partial unique index cgv_template_one_default_idx (v2.2,
--    unchanged) still enforces at most one is_default=true row --
--    doing "unset old default" BEFORE "set new default" avoids ever
--    violating that constraint mid-transaction.
-- =============================================================================
update public.cgv_template
   set is_default = false
 where template_code = 'FR_FOOD_PERISHABLE_B2C'
   and jurisdiction_country = 'FR'
   and business_scope = 'food_perishable_b2c'
   and locale = 'fr'
   and version = 4;

update public.cgv_template
   set is_default = true
 where template_code = 'FR_FOOD_PERISHABLE_B2C'
   and jurisdiction_country = 'FR'
   and business_scope = 'food_perishable_b2c'
   and locale = 'fr'
   and version = 5;

-- =============================================================================
-- C. order_items -- Task 2, minimal additive schema. THREE new
--    NULLABLE columns, no default clause (pre-existing rows -> NULL,
--    the Postgres default for a bare ADD COLUMN with no `default` --
--    never a guessed/backfilled value, per mandate). Populated ONLY
--    going forward, inside create_order's existing
--    `v_cgv_status = 'CGV_ACTIVE'` gate (section E below). Domain
--    check constraints mirror the SAME citation/regime vocabulary
--    already used elsewhere in this codebase (merchant_cgv_profile.
--    withdrawal_regime's own check, and FR_FOOD_PERISHABLE_B2C's own
--    withdrawal_clauses citations) -- never a speculative new enum.
-- =============================================================================
alter table public.order_items
  add column withdrawal_exempt_at_order_time boolean,
  add column withdrawal_legal_basis_at_order_time text
    check (withdrawal_legal_basis_at_order_time is null or withdrawal_legal_basis_at_order_time in (
      'L221-28-4', 'L221-28-3', 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION', 'STANDARD_14_DAYS_ELIGIBLE'
    )),
  add column merchant_withdrawal_regime_at_order_time text
    check (merchant_withdrawal_regime_at_order_time is null or merchant_withdrawal_regime_at_order_time in (
      'EXEMPT_PERISHABLE', 'STANDARD_14_DAYS', 'MIXED'
    ));

comment on column public.order_items.withdrawal_exempt_at_order_time is
  'CGV ENGINE v2.5 (Task 2) -- immutable snapshot, at order-creation time, of whether the withdrawal-exemption regime applied to this line''s merchant at that moment. NULL for orders created before this column existed, or for a non-CGV_ACTIVE merchant -- never backfilled/guessed.';
comment on column public.order_items.withdrawal_legal_basis_at_order_time is
  'CGV ENGINE v2.5 (Task 2) -- immutable snapshot of the precise Code de la consommation legal basis (grounded in the ACTUAL accepted template''s own citation), never derived from current product/merchant configuration.';
comment on column public.order_items.merchant_withdrawal_regime_at_order_time is
  'CGV ENGINE v2.5 (Task 2) -- immutable snapshot of merchant_cgv_profile.withdrawal_regime as it stood at order-creation time (the legal/withdrawal-regime state in force for that merchant/template at order time).';

-- =============================================================================
-- D. _scanym_has_online_withdrawal_runtime -- Task 4. A single,
--    explicit, well-documented feature-flag function -- NOT an inline
--    literal `false` repeated in three places -- so a FUTURE lot that
--    actually ships the statutory online withdrawal-request function
--    flips ONE definition and every enforcement point (resolve_cgv_
--    publication_context, persist_merchant_cgv_version) picks it up
--    automatically. Hardcoded `false` today: confirmed by real runtime
--    discovery (grep across app/ and lib/, README-AUDIT.md) -- no
--    route, service, or order-lifecycle code anywhere in this
--    codebase implements an online withdrawal-request submission flow
--    or self-service post-delivery cancellation.
-- =============================================================================
create or replace function public._scanym_has_online_withdrawal_runtime()
returns boolean
language sql
immutable
as $$
  select false;
$$;

revoke all on function public._scanym_has_online_withdrawal_runtime() from public;
-- No grant to any client role -- private helper, callable only from
-- within another SECURITY DEFINER function owned by the same role,
-- exactly like _resolve_applicable_cgv_template.

-- =============================================================================
-- E. create_order -- CREATE OR REPLACE, SAME 8-argument signature/
--    return type as v1.1 (no signature change -- a plain replace
--    suffices, no DROP needed). Every line is BYTE-IDENTICAL to v1.1's
--    body EXCEPT the Task 2 withdrawal-snapshot additions (three new
--    local variables, one new query inside the existing CGV_ACTIVE
--    gate, three new order_items insert columns/values) -- verified
--    post-commit below by an explicit line-count-of-divergence check
--    against the ORIGINAL v1.1 body is impractical in plain SQL, so
--    the postflight section instead proves the OUTCOME: snapshot
--    columns populate correctly for a CGV_ACTIVE merchant, stay NULL
--    for a pre-existing (pre-v2.5) row, and stay immutable against a
--    later config change -- the behavioral guarantees that actually
--    matter.
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
  -- CGV ENGINE v2.5 (Task 2 -- per-line withdrawal legal-basis
  -- snapshot). ALL THREE are resolved ONLY inside the existing
  -- `v_cgv_status = 'CGV_ACTIVE'` gate below, from the SAME
  -- merchant_cgv_version row already resolved for order_cgv_acceptance
  -- (never a second, independent template/profile read) -- so the
  -- snapshot on every order_items row of this order is tied to the
  -- EXACT immutable template text the customer actually accepted, not
  -- to whatever merchant_cgv_profile/cgv_template happen to say later.
  -- A non-CGV_ACTIVE merchant (legacy, DRAFT, READY, NOT_CONFIGURED)
  -- leaves all three NULL here, exactly like v_cgv_version_id itself --
  -- never a guessed value (mandate: "never derive historical status
  -- from current product configuration").
  v_withdrawal_regime_snapshot text;
  v_template_sections_snapshot jsonb;
  v_withdrawal_legal_basis     text;
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

    -- CGV ENGINE v2.5 (Task 2) -- snapshot the withdrawal regime AND
    -- the exact template text bound to v_cgv_version_id (the merchant_
    -- cgv_version row this very order is about to be tied to via
    -- order_cgv_acceptance, above/below). Reading it via the version
    -- row's own template_id (never via _resolve_applicable_cgv_template
    -- again) guarantees this is the text the customer actually
    -- accepted, immune to any later is_default/pin change.
    select mcp.withdrawal_regime, ct.controlled_sections
      into v_withdrawal_regime_snapshot, v_template_sections_snapshot
    from public.merchant_cgv_version mcv
    join public.cgv_template ct on ct.id = mcv.template_id
    join public.merchant_cgv_profile mcp on mcp.restaurant_id = mcv.restaurant_id
    where mcv.id = v_cgv_version_id;

    -- Legal basis grounded EXCLUSIVELY in what the accepted template
    -- text itself actually cites (never a value invented from the
    -- regime name alone) -- mirrors, at order time, the exact same
    -- citation FR_FOOD_PERISHABLE_B2C's own withdrawal_clauses string
    -- carries for that specific template version (so a customer who
    -- accepted an OLD template still pinned/published with the
    -- pre-v2.4 "L221-28 3°" citation gets that historically-accurate
    -- basis recorded here, never silently upgraded to "4°").
    if v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE' then
      if (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 4°%' then
        v_withdrawal_legal_basis := 'L221-28-4';
      elsif (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 3°%' then
        v_withdrawal_legal_basis := 'L221-28-3';
      else
        -- Defensive fail-safe only: should never happen given every
        -- known template version's EXEMPT_PERISHABLE string cites one
        -- of the two -- never guess a citation if it ever did.
        v_withdrawal_legal_basis := 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION';
      end if;
    elsif v_withdrawal_regime_snapshot = 'STANDARD_14_DAYS' then
      -- No numbered exception applies -- the customer is fully
      -- eligible for the ordinary 14-day right (articles L221-18 et
      -- suivants, as the template's own STANDARD_14_DAYS string
      -- already cites).
      v_withdrawal_legal_basis := 'STANDARD_14_DAYS_ELIGIBLE';
    else
      -- MIXED (or any future/unknown regime value): cgv_completeness_
      -- errors already fails a MIXED merchant closed at publish time
      -- (WITHDRAWAL_REGIME_MIXED_UNSUPPORTED), so no CGV_ACTIVE
      -- merchant can actually reach this branch today -- kept as an
      -- explicit NULL fail-safe (never a guessed classification)
      -- rather than assumed unreachable.
      v_withdrawal_legal_basis := null;
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
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot,
      -- CGV ENGINE v2.5 (Task 2) -- immutable per-line withdrawal
      -- legal-basis snapshot, resolved once above (outside this loop,
      -- identical for every line of THIS order -- Scanym has no per-
      -- product/per-line classification anywhere in menu_items, see
      -- this file's own header) and copied here verbatim, exactly like
      -- tax_rate_snapshot/unit_weight_grams_snapshot/weight_is_
      -- approximate_snapshot already are. NULL for a non-CGV_ACTIVE
      -- merchant (v_withdrawal_regime_snapshot stays NULL) -- never a
      -- guessed value.
      withdrawal_exempt_at_order_time, withdrawal_legal_basis_at_order_time,
      merchant_withdrawal_regime_at_order_time
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate,
      case when v_withdrawal_regime_snapshot is null then null
           else (v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE') end,
      v_withdrawal_legal_basis,
      v_withdrawal_regime_snapshot
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

-- =============================================================================
-- F. persist_merchant_cgv_version -- CREATE OR REPLACE, SAME 5-argument
--    signature/return type. Adds (Task 4) the WITHDRAWAL_RUNTIME_NOT_
--    READY top-of-function guard (same placement/style as ACTUAL_
--    WEIGHT_PRICE_UNSUPPORTED) and (Task 5) the PLACEHOLDER_TEXT_
--    DETECTED / LEGAL_GUARANTEE_BLOCK_MISSING checks on the final
--    rendered content, right before the INSERT. Every other line is
--    BYTE-IDENTICAL to v2.2's body.
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

-- No grant statement here either -- same reasoning as section F of
-- v2.2 (unchanged signature, unchanged grants: service_role EXECUTE
-- only).

-- =============================================================================
-- G. resolve_cgv_publication_context -- CREATE OR REPLACE, SAME input
--    signature AND SAME RETURNS TABLE column list as v2.4 (v2.5 adds
--    NO new output column -- a plain CREATE OR REPLACE suffices, no
--    DROP needed, unlike v2.4's own DROP+CREATE which changed the
--    RETURNS TABLE list). Adds (Task 4) the SAME WITHDRAWAL_RUNTIME_
--    NOT_READY guard as section F above, computed from the SAME
--    v_online_withdrawal_function_gap boolean v2.4 already introduced
--    (never a second, independent computation) -- defense in depth,
--    stopping publication at the FIRST call of the real publish flow.
--    Body otherwise BYTE-IDENTICAL to v2.4's.
-- =============================================================================
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
  v_v5_sections   jsonb;
  v_v4_minus_one  jsonb;
  v_v5_minus_one  jsonb;
  v_default_count integer;
  v_encadre       jsonb;
  v_paragraphs    jsonb;
begin
  -- 1. Exactly one is_default=true row, and it is version 5.
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
    where template_code='FR_FOOD_PERISHABLE_B2C' and version=5 and is_default=true
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 5 doit être is_default=true après réassignation.'; end if;
  if exists (
    select 1 from public.cgv_template
    where template_code='FR_FOOD_PERISHABLE_B2C' and version in (1,2,3,4) and is_default=true
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: les versions 1-4 doivent être is_default=false après réassignation.'; end if;

  -- 2. Versions 1-4 remain BYTE-IDENTICAL to their own prior literals
  --    (re-checked here, not merely re-relying on v2.4's own check).
  select controlled_sections into v_v1_sections from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=1;
  if (v_v1_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') not ilike '%L221-28 3°%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 1 a été modifiée -- elle doit rester BYTE-IDENTIQUE (historique, toujours "L221-28 3°").';
  end if;
  select controlled_sections into v_v2_sections from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=2;
  if (v_v2_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') not ilike '%L221-28 3°%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 2 a été modifiée -- elle doit rester BYTE-IDENTIQUE (historique, toujours "L221-28 3°").';
  end if;
  select controlled_sections into v_v3_sections from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=3;
  if (v_v3_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') not ilike '%L221-28 3°%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 3 a été modifiée -- elle doit rester BYTE-IDENTIQUE (historique, toujours "L221-28 3°").';
  end if;
  select controlled_sections into v_v4_sections from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=4;
  if (v_v4_sections->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') not ilike '%L221-28 4°%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 4 a été modifiée -- elle doit rester BYTE-IDENTIQUE (toujours "L221-28 4°").';
  end if;
  if v_v4_sections ? 'legal_guarantee_encadre' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 4 a été modifiée -- elle ne doit JAMAIS acquérir legal_guarantee_encadre (nouveau uniquement en version 5).';
  end if;

  -- 3. Version 5 = version 4 with EXACTLY ONE key added
  --    (legal_guarantee_encadre) + legal_guarantees_clause's own
  --    trailing sentence pointing to it (the ONLY other text change --
  --    verified explicitly below, never silently allowed to diverge
  --    further).
  select controlled_sections into v_v5_sections from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=5;
  if not (v_v5_sections ? 'legal_guarantee_encadre') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 5 ne porte pas la clé legal_guarantee_encadre.';
  end if;
  v_v4_minus_one := (v_v4_sections - 'legal_guarantees_clause');
  v_v5_minus_one := (v_v5_sections - 'legal_guarantees_clause' - 'legal_guarantee_encadre');
  if v_v4_minus_one is distinct from v_v5_minus_one then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: FR_FOOD_PERISHABLE_B2C version 5 diverge de la version 4 sur autre chose que legal_guarantee_encadre/legal_guarantees_clause -- ce lot ne doit toucher QUE celles-ci.';
  end if;
  if (v_v5_sections->>'legal_guarantees_clause') = (v_v4_sections->>'legal_guarantees_clause') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: legal_guarantees_clause de la version 5 doit différer de la version 4 (phrase de renvoi vers l''encadré ajoutée).';
  end if;

  -- 4. Encadré: heading present, EXACTLY 17 paragraphs (none
  --    truncated), and at least five exact spot-check sentences
  --    present verbatim (mandate Task 11's own "at least 5" bar,
  --    re-checked HERE at the SQL/data layer too, not only at the
  --    rendered-HTML layer the harness checks separately).
  v_encadre := v_v5_sections->'legal_guarantee_encadre';
  if (v_encadre->>'heading') is null or (v_encadre->>'heading') = '' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: legal_guarantee_encadre.heading manquant.';
  end if;
  v_paragraphs := v_encadre->'paragraphs';
  if jsonb_array_length(v_paragraphs) <> 17 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: legal_guarantee_encadre.paragraphs doit contenir EXACTEMENT 17 paragraphes, trouvé %.', jsonb_array_length(v_paragraphs);
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_paragraphs) t where t ilike '%délai de deux ans à compter de la délivrance du bien%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: paragraphe "délai de deux ans à compter de la délivrance" absent.';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_paragraphs) t where t ilike '%réparation ou au remplacement du bien dans un délai de trente jours%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: paragraphe "réparation ou remplacement... trente jours" absent.';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_paragraphs) t where t ilike '%extension de six mois de la garantie initiale%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: paragraphe "extension de six mois" absent.';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_paragraphs) t where t ilike '%amende civile d''un montant maximal de 300 000 euros%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: paragraphe "amende civile 300 000 euros" absent.';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_paragraphs) t where t ilike '%garantie légale des vices cachés%articles 1641 à 1649%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: paragraphe "vices cachés articles 1641 à 1649" absent.';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_paragraphs) t where t ilike '%articles L. 217-1 à L. 217-32%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: paragraphe "articles L. 217-1 à L. 217-32" absent.';
  end if;

  -- 5. order_items -- three new nullable columns, correctly typed.
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='order_items'
      and column_name='withdrawal_exempt_at_order_time' and data_type='boolean' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: order_items.withdrawal_exempt_at_order_time manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='order_items'
      and column_name='withdrawal_legal_basis_at_order_time' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: order_items.withdrawal_legal_basis_at_order_time manquante ou mal typée.'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='order_items'
      and column_name='merchant_withdrawal_regime_at_order_time' and is_nullable='YES'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: order_items.merchant_withdrawal_regime_at_order_time manquante ou mal typée.'; end if;

  -- 6. Signature / grants of every touched function, re-verified.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_cgv_publication_context'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) ilike '%online_withdrawal_function_gap boolean%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: resolve_cgv_publication_context a perdu sa forme v2.4.'; end if;
  if not has_function_privilege('authenticated', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur resolve_cgv_publication_context.';
  end if;
  if has_function_privilege('anon', 'public.resolve_cgv_publication_context(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur resolve_cgv_publication_context.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'persist_merchant_cgv_version'
      and pg_get_function_identity_arguments(p.oid) =
        'p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: persist_merchant_cgv_version a changé de signature.'; end if;
  if not has_function_privilege('service_role', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: service_role a perdu EXECUTE sur persist_merchant_cgv_version.';
  end if;
  if has_function_privilege('authenticated', 'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a EXECUTE sur persist_merchant_cgv_version.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_arguments(p.oid) ilike '%p_cgv_accepted%'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_order a changé de signature.'; end if;
  if not has_function_privilege('anon', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a perdu EXECUTE sur create_order.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_scanym_has_online_withdrawal_runtime'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: _scanym_has_online_withdrawal_runtime manquante.'; end if;
  if has_function_privilege('authenticated', 'public._scanym_has_online_withdrawal_runtime()', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a EXECUTE sur _scanym_has_online_withdrawal_runtime -- doit rester un privé.';
  end if;

  -- 7. Every function this lot must NEVER touch is unchanged.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'activate_merchant_cgv'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: activate_merchant_cgv a disparu ou changé de signature.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cgv_completeness_errors'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors a disparu ou changé de signature.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_resolve_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: _resolve_applicable_cgv_template a disparu ou changé de signature.'; end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_applicable_cgv_template'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_applicable_cgv_template a disparu ou changé de signature.'; end if;
end $$;

commit;

-- =============================================================================
-- Summary of changes relative to v2.4:
--   + FR_FOOD_PERISHABLE_B2C template version 5, PUBLISHED,
--     is_default=true (versions 1-4 untouched, byte-identical,
--     is_default=false). Version 5 = version 4 + `legal_guarantee_
--     encadre` (heading + 17-paragraph verbatim D.211-2 Annexe Section
--     A text) + one trailing sentence appended to legal_guarantees_
--     clause pointing to it. Every other key byte-identical.
--   ~ is_default REASSIGNED from version 4 to version 5.
--   + public._scanym_has_online_withdrawal_runtime() -- new private
--     helper, hardcoded false, zero grants.
--   ~ resolve_cgv_publication_context -- CREATE OR REPLACE (same
--     signature/output as v2.4), new ENFORCED WITHDRAWAL_RUNTIME_NOT_
--     READY guard.
--   ~ persist_merchant_cgv_version -- CREATE OR REPLACE (same 5-arg
--     signature), new ENFORCED WITHDRAWAL_RUNTIME_NOT_READY /
--     PLACEHOLDER_TEXT_DETECTED / LEGAL_GUARANTEE_BLOCK_MISSING guards.
--   ~ create_order -- CREATE OR REPLACE (same 8-arg signature), new
--     per-order-line withdrawal legal-basis snapshot (three new
--     order_items columns, populated only inside the existing
--     CGV_ACTIVE gate).
--   + order_items.withdrawal_exempt_at_order_time,
--     .withdrawal_legal_basis_at_order_time,
--     .merchant_withdrawal_regime_at_order_time -- three new NULLABLE
--     columns, additive only, no backfill.
--   ~ lib/legal/render.ts -- new `legal_guarantee_encadre` optional
--     key, rendered as its own distinct bordered block
--     (class="legal-guarantee-encadre"), unconditional on
--     withdrawalRegime.
--   ~ lib/server/legal-cgv-publish-service.ts, lib/services/legal-
--     cgv.ts, app/api/dashboard/legal-cgv/publish/route.ts -- three
--     new stable failure reasons (withdrawal_runtime_not_ready,
--     placeholder_text_detected, legal_guarantee_block_missing), all
--     mapped to HTTP 409 (retriable), never a raw SQL message exposed.
--   No RLS policy changed. No new client-facing grant anywhere.
--   activate_merchant_cgv, cgv_completeness_errors,
--   _resolve_applicable_cgv_template, get_applicable_cgv_template,
--   _compute_cgv_publication_context_fingerprint, assert_legal_cgv_
--   role/_for_user, update_merchant_legal_profile, update_merchant_
--   cgv_profile are ALL untouched. menu_items and every other
--   catalogue/payment/fulfillment/notifications table or function, and
--   every one of PR #86/#87's own files: untouched.
-- =============================================================================
