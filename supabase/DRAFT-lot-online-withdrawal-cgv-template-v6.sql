-- =============================================================================
-- SCANYM — ONLINE WITHDRAWAL v1 — CGV TEMPLATE VERSION 6
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO PROD.
-- =============================================================================
--
-- NOUVELLE version CONTRÔLÉE du gabarit FR_FOOD_PERISHABLE_B2C. Aucune
-- version déjà publiée n'est modifiée : la version 5 reste intacte,
-- toute CGV marchande déjà publiée reste inchangée, et
-- `merchant_cgv_version` n'est pas touché.
--
-- CE QUE LA VERSION 6 AJOUTE, par rapport à la version 5 (toutes les
-- autres clauses sont REPRISES À L'IDENTIQUE) :
--
--   1. `withdrawal_exercise_method_clause` — RÉÉCRITE : la version 5
--      disait qu'aucune fonctionnalité de rétractation en ligne n'était
--      proposée. Ce lot en livre une : la clause décrit désormais son
--      accès (page de suivi, intitulé « Exercer mon droit de
--      rétractation »), les informations que le Client y fournit ou
--      confirme, et la confirmation explicite.
--   2. `mixed_order_withdrawal_clause` — NOUVELLE clé : règle des
--      commandes mixtes (formulation contrôlée fournie par le CIO,
--      reprise verbatim, citant l'article L221-28 et son 4°).
--   3. `withdrawal_return_and_refund_clause` — NOUVELLE clé : renvoi
--      au régime légal de restitution (L221-23) et de remboursement
--      (L221-24), SANS paraphrase de délais chiffrés.
--   4. `withdrawal_acknowledgement_clause` — NOUVELLE clé : accusé de
--      réception sur support durable mentionnant contenu, date et
--      heure de la déclaration.
--
-- AVERTISSEMENT DE SOURCE (à lever avant toute publication réelle) :
-- legifrance.gouv.fr n'est pas joignable depuis l'environnement de
-- développement (HTTP 403). Les clauses ci-dessus ont été rédigées à
-- partir de sources secondaires concordantes de cabinets d'avocats
-- français et des formulations contrôlées déjà présentes dans le
-- dépôt. Elles doivent être VALIDÉES PAR LE CONSEIL JURIDIQUE contre
-- le texte officiel avant publication. Ce fichier ne prétend à aucune
-- conformité : il pose la structure contrôlée.
--
-- EFFET SUR LES MARCHANDS : aucun changement silencieux. Un marchand
-- reste sur la version qu'il a publiée ; il doit PUBLIER une nouvelle
-- version de ses CGV pour que le texte ci-dessous s'applique à ses
-- futures commandes. `is_default` est réassigné à la version 6 pour
-- les futures publications uniquement.
-- =============================================================================

do $$
begin
  if to_regclass('public.cgv_template') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: cgv_template absente -- CGV v6 annulé.';
  end if;
  if not exists (
    select 1 from public.cgv_template
    where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5 and is_default = true
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 5 (is_default) introuvable -- CGV ENGINE v2.5 doit être appliqué avant, annulé.';
  end if;
  if exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: FR_FOOD_PERISHABLE_B2C version 6 existe déjà -- annulé.';
  end if;
  -- La fonctionnalité en ligne décrite par la version 6 doit RÉELLEMENT
  -- exister : sans elle, publier ce texte serait une affirmation fausse.
  if not public._scanym_has_online_withdrawal_runtime() then
    raise exception 'SCANYM_WITHDRAWAL_RUNTIME_MISSING: la version 6 décrit une fonctionnalité de rétractation en ligne que le runtime ne fournit pas -- appliquer DRAFT-lot-online-withdrawal-foundation-v1.sql d''abord, annulé.';
  end if;
end $$;

begin;

insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 6, 'fr',
  'PUBLISHED', true, true,
  $cgv_v6_json$
{
    "header": "Conditions Générales de Vente",
    "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
    "withdrawal_clauses": {
        "EXEMPT_PERISHABLE": "Conformément à l'article L221-28 4° du Code de la consommation, le droit de rétractation ne s'applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement. Cette exclusion ne s'applique qu'aux produits susceptibles de se détériorer ou de se périmer rapidement ; elle ne saurait être interprétée comme excluant du droit de rétractation l'ensemble des produits proposés par le Vendeur. Les autres produits éventuellement proposés par le Vendeur, non concernés par cette exclusion légale, demeurent soumis au régime de rétractation qui leur est applicable.",
        "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d'un délai de 14 jours pour exercer son droit de rétractation.",
        "MIXED": null
    },
    "withdrawal_exercise_method_clause": "Le droit de rétractation prévu ci-dessus peut être exercé au moyen de la fonctionnalité de rétractation en ligne mise à disposition par le Vendeur, accessible sans frais depuis la page de suivi de la commande sous l'intitulé « Exercer mon droit de rétractation », pendant toute la durée du délai de rétractation applicable. Le Client y indique ou confirme ses nom et prénom, les informations permettant d'identifier la commande concernée, ainsi que le moyen électronique par lequel il souhaite recevoir l'accusé de réception de sa déclaration, puis confirme explicitement sa rétractation. Le droit de rétractation peut également être exercé par tout autre moyen non équivoque adressé au Vendeur, notamment au moyen du formulaire type de rétractation ci-après ou par courrier électronique aux coordonnées de contact du Vendeur indiquées dans les présentes CGV.",
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
    "applicable_law_clause": "Les présentes CGV sont soumises au droit applicable dans le pays de rattachement du Vendeur tel qu'indiqué dans son profil légal, sans préjudice des dispositions impératives de protection des consommateurs qui pourraient être applicables en vertu du droit du pays de résidence habituelle du Client.",
    "mixed_order_withdrawal_clause": "Lorsque la commande comporte à la fois des produits bénéficiant du droit de rétractation et des produits qui en sont légalement exclus en application de l'article L221-28 du Code de la consommation, notamment les biens susceptibles de se détériorer ou de se périmer rapidement visés au 4° de cet article, le droit de rétractation ne peut être exercé que pour les produits éligibles.",
    "withdrawal_return_and_refund_clause": "En cas d'exercice du droit de rétractation, le Client renvoie ou restitue les biens au Vendeur dans les conditions et délais prévus à l'article L221-23 du Code de la consommation, selon les modalités de restitution que le Vendeur lui communique. Le Vendeur rembourse les sommes versées dans les conditions et délais prévus à l'article L221-24 du même code.",
    "withdrawal_acknowledgement_clause": "Toute déclaration de rétractation effectuée au moyen de la fonctionnalité en ligne est enregistrée avec sa date et son heure, et son contenu est conservé sur un support durable. Le Vendeur adresse au Client, sur un support durable et au moyen électronique indiqué par celui-ci, un accusé de réception mentionnant le contenu de sa déclaration ainsi que la date et l'heure de celle-ci."
}
$cgv_v6_json$::jsonb,
  pg_catalog.now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6);

-- Réassignation explicite de is_default : 5 -> 6, en deux instructions
-- délibérées (même discipline que v2.4/v2.5). Une CGV DÉJÀ PUBLIÉE par
-- un marchand n'est JAMAIS modifiée par cette bascule.
update public.cgv_template
   set is_default = false
 where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5;

update public.cgv_template
   set is_default = true
 where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6;

do $$
declare
  v_sections jsonb;
begin
  select controlled_sections into v_sections
  from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6;

  if v_sections is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: version 6 absente après insertion.';
  end if;
  if not (v_sections ? 'mixed_order_withdrawal_clause')
     or not (v_sections ? 'withdrawal_return_and_refund_clause')
     or not (v_sections ? 'withdrawal_acknowledgement_clause') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: clés de rétractation en ligne absentes de la version 6.';
  end if;

  if (v_sections->>'mixed_order_withdrawal_clause') not like '%L221-28%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la clause des commandes mixtes ne cite pas L221-28.';
  end if;

  if (v_sections->>'withdrawal_exercise_method_clause') like '%n''est pas encore propos%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 6 nie encore l''existence de la fonctionnalité en ligne.';
  end if;

  -- La version 5 doit rester INTACTE et publiée.
  if not exists (
    select 1 from public.cgv_template
    where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5 and status = 'PUBLISHED'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 5 a été altérée.';
  end if;

  if (select count(*) from public.cgv_template
      where template_code = 'FR_FOOD_PERISHABLE_B2C' and is_default = true) <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: is_default n''est pas unique.';
  end if;
end $$;

commit;

-- =============================================================================
-- AUCUNE CGV MARCHANDE DÉJÀ PUBLIÉE N'EST MODIFIÉE PAR CE FICHIER :
-- merchant_cgv_version, order_cgv_acceptance et les versions 1 à 5 du
-- gabarit restent intacts. Un marchand doit PUBLIER une nouvelle
-- version pour que le texte de la version 6 s'applique.
-- =============================================================================
