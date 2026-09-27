-- =============================================================================
-- SCANYM — GAP-01 — CGV TEMPLATE VERSION 7
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO LEGAL-TEXT REVIEW + GO.
-- =============================================================================
--
-- NOUVELLE version CONTRÔLÉE du gabarit FR_FOOD_PERISHABLE_B2C. Aucune
-- version déjà publiée n'est modifiée : les versions 1 à 6 restent
-- intactes, toute CGV marchande déjà publiée reste inchangée, et
-- `merchant_cgv_version` n'est pas touché ici.
--
-- CE QUE LA VERSION 7 CHANGE, par rapport à la version 6 (TOUTES les
-- autres clauses sont REPRISES À L'IDENTIQUE, octet pour octet) :
--
--   * `withdrawal_acknowledgement_clause` — RÉÉCRITE pour décrire le
--     flux OPÉRATIONNEL RÉEL décidé par le CIO (« CIO DECISION — GAP-01
--     ACKNOWLEDGEMENT RECIPIENTS + MERCHANT FOLLOW-UP » et « CIO
--     DECISION — GAP-01 FLOW MUST BE REFLECTED IN CGV », issue #11) :
--       1. le Client soumet sa demande via la fonctionnalité en ligne ;
--       2. Scanym enregistre la demande (date/heure) et adresse au
--          Client un accusé de réception sur support durable, envoyé
--          depuis retractation@scanym.com ;
--       3. le Vendeur reçoit une COPIE de cet accusé de réception
--          (champ CC) ainsi qu'une notification correspondante dans
--          son interface de gestion (backoffice) ;
--       4. l'accusé de réception confirme la réception de la
--          déclaration, son contenu, sa date et son heure, et les
--          produits/quantités concernés ;
--       5. il NE contient PAS les modalités pratiques de retour : le
--          Vendeur les communique ensuite SÉPARÉMENT au Client -- deux
--          étapes distinctes, jamais confondues.
--     La version 6 disait seulement qu'un accusé de réception était
--     envoyé, sans jamais mentionner : qui l'envoie concrètement
--     (Scanym, pour le compte du Vendeur), que le Vendeur en reçoit
--     copie, la notification backoffice, ni la distinction entre
--     l'accusé de réception et les instructions de retour. La version
--     7 comble cet écart entre le texte contractuel et le mécanisme
--     RÉELLEMENT livré par ce lot (voir lib/server/ack-mailer.ts,
--     DRAFT-lot-gap-01-ack-transport-v1.sql).
--   * AUCUNE autre clé n'est modifiée. `withdrawal_clauses.EXEMPT_
--     PERISHABLE`/`STANDARD_14_DAYS`/`MIXED` restent EXACTEMENT ceux
--     de la version 6 -- ce lot ne touche NI la détermination du
--     régime marchand NI l'éligibilité produit par produit (voir
--     l'investigation postée sur l'issue #11 : ces mécanismes
--     existaient déjà et gouvernent déjà correctement qui voit
--     quoi).
--
-- AVERTISSEMENT DE SOURCE (identique à la version 6, non levé par ce
-- lot) : ce texte n'a PAS été validé contre le texte officiel par un
-- conseil juridique. Ce fichier pose la structure contrôlée du
-- CHANGEMENT FONCTIONNEL demandé par le CIO ; la formulation exacte
-- reste soumise à relecture juridique avant toute publication réelle
-- (« Full independent audit required before merge (code AND legal
-- text) »).
--
-- EFFET SUR LES MARCHANDS : aucun changement silencieux. Un marchand
-- reste sur la version qu'il a publiée ; il doit PUBLIER une nouvelle
-- version de ses CGV pour que le texte ci-dessous s'applique à ses
-- futures commandes. `is_default` est réassigné à la version 7 pour
-- les futures publications uniquement.
-- =============================================================================

do $$
begin
  if to_regclass('public.cgv_template') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: cgv_template absente -- CGV v7 annulé.';
  end if;
  if not exists (
    select 1 from public.cgv_template
    where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6 and is_default = true
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FR_FOOD_PERISHABLE_B2C version 6 (is_default) introuvable -- ONLINE WITHDRAWAL cgv-template-v6 doit être appliqué avant, annulé.';
  end if;
  if exists (
    select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 7
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: FR_FOOD_PERISHABLE_B2C version 7 existe déjà -- annulé.';
  end if;
end $$;

begin;

insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 7, 'fr',
  'PUBLISHED', true, true,
  -- Copie EXACTE de controlled_sections v6, avec UNE SEULE clé
  -- modifiée (withdrawal_acknowledgement_clause) -- voir le préambule
  -- ci-dessus pour la justification de chaque changement.
  jsonb_set(
    (select controlled_sections from public.cgv_template
     where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6),
    '{withdrawal_acknowledgement_clause}',
    to_jsonb(
      'Toute déclaration de rétractation effectuée au moyen de la fonctionnalité en ligne est enregistrée avec sa date et son heure, et son contenu est conservé sur un support durable. Scanym adresse au Client, pour le compte du Vendeur, sur un support durable et au moyen électronique indiqué par celui-ci, un accusé de réception mentionnant le contenu de sa déclaration ainsi que la date et l''heure de celle-ci ; cet accusé de réception est envoyé depuis l''adresse retractation@scanym.com. Le Vendeur reçoit une copie de cet accusé de réception ainsi qu''une notification correspondante dans son interface de gestion, mentionnant notamment les produits et quantités concernés par la déclaration. Cet accusé de réception confirme la seule réception de la déclaration de rétractation ; il ne constitue pas les modalités pratiques de retour des produits concernés, que le Vendeur communique ensuite séparément au Client.'::text
    )
  ),
  pg_catalog.now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 7);

-- Réassignation explicite de is_default : 6 -> 7, en deux instructions
-- délibérées (même discipline que v6/v2.4/v2.5). Une CGV DÉJÀ PUBLIÉE
-- par un marchand n'est JAMAIS modifiée par cette bascule.
update public.cgv_template
   set is_default = false
 where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6;

update public.cgv_template
   set is_default = true
 where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 7;

do $$
declare
  v6_sections jsonb;
  v7_sections jsonb;
  v6_without_ack jsonb;
  v7_without_ack jsonb;
begin
  select controlled_sections into v7_sections
  from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 7;
  select controlled_sections into v6_sections
  from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6;

  if v7_sections is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: version 7 absente après insertion.';
  end if;

  -- Le texte doit RÉELLEMENT décrire le mécanisme GAP-01 : expéditeur,
  -- copie marchand, notification backoffice, distinction accusé/retour.
  if (v7_sections->>'withdrawal_acknowledgement_clause') not like '%retractation@scanym.com%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la clause d''accusé de réception ne cite pas l''expéditeur retractation@scanym.com.';
  end if;
  if (v7_sections->>'withdrawal_acknowledgement_clause') not like '%copie%'
     or (v7_sections->>'withdrawal_acknowledgement_clause') not like '%interface de gestion%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la clause d''accusé de réception ne mentionne pas la copie marchand + la notification backoffice.';
  end if;
  if (v7_sections->>'withdrawal_acknowledgement_clause') not like '%ne constitue pas les modalités pratiques de retour%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la clause ne distingue pas accusé de réception et instructions de retour (deux étapes distinctes).';
  end if;

  -- TOUTES les autres clés doivent être BYTE-IDENTIQUES à la version 6
  -- (aucune extension de périmètre au-delà de la clause d'accusé).
  v6_without_ack := v6_sections - 'withdrawal_acknowledgement_clause';
  v7_without_ack := v7_sections - 'withdrawal_acknowledgement_clause';
  if v6_without_ack <> v7_without_ack then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 7 modifie autre chose que withdrawal_acknowledgement_clause par rapport à la version 6.';
  end if;

  -- Le régime marchand et l'éligibilité produit par produit restent
  -- STRICTEMENT identiques : ce lot ne change JAMAIS de classification
  -- légale (CIO SCOPE CLARIFICATION — issue #11).
  if (v7_sections->'withdrawal_clauses') <> (v6_sections->'withdrawal_clauses') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: withdrawal_clauses (EXEMPT_PERISHABLE/STANDARD_14_DAYS/MIXED) a changé -- hors périmètre GAP-01.';
  end if;

  -- La version 6 doit rester INTACTE et publiée.
  if not exists (
    select 1 from public.cgv_template
    where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 6 and status = 'PUBLISHED'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la version 6 a été altérée.';
  end if;

  if (select count(*) from public.cgv_template
      where template_code = 'FR_FOOD_PERISHABLE_B2C' and is_default = true) <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: is_default n''est pas unique.';
  end if;
end $$;

commit;

-- =============================================================================
-- AUCUNE CGV MARCHANDE DÉJÀ PUBLIÉE N'EST MODIFIÉE PAR CE FICHIER :
-- merchant_cgv_version, order_cgv_acceptance et les versions 1 à 6 du
-- gabarit restent intacts. Un marchand doit PUBLIER une nouvelle
-- version pour que le texte de la version 7 s'applique -- et la garde
-- de publication (_scanym_has_online_withdrawal_runtime(), qui inclut
-- désormais _scanym_has_operational_durable_ack_channel() redéfinie
-- par GAP-01) continue de bloquer cette publication tant qu'aucun
-- test de connectivité SMTP réel n'a réussi.
-- =============================================================================
