-- =============================================================================
-- Scanym — DIAGNOSTIC EN LECTURE SEULE — accusés de rétractation non envoyés
-- DRAFT ONLY. SELECT uniquement : aucune écriture, aucun envoi, aucun effet de bord.
-- À exécuter par un opérateur Scanym (SQL editor) AVANT toute décision sur :
--   (a) l'ouverture de l'interrupteur du canal « messagerie du commerçant » ;
--   (b) le traitement des demandes déjà enregistrées sans accusé.
-- Aucune donnée personnelle du client n'est sélectionnée (ni nom, ni adresse complète).
-- Aucun renvoi automatique n'existe : le code ne revendique jamais une demande
-- `failed`, `sent` ou `unavailable_no_channel`.
-- =============================================================================

-- 1. Demandes sans accusé envoyé, par établissement et par état.
select r.name                                   as etablissement,
       wr.restaurant_id,
       wr.acknowledgement_status                as etat_accuse,
       count(*)                                 as demandes,
       min(wr.requested_at)                     as plus_ancienne,
       max(wr.requested_at)                     as plus_recente,
       max(wr.acknowledgement_last_error)       as derniere_erreur
from public.withdrawal_requests wr
join public.restaurants r on r.id = wr.restaurant_id
where wr.acknowledgement_status <> 'sent'
group by r.name, wr.restaurant_id, wr.acknowledgement_status
order by plus_ancienne;

-- 2. Les établissements concernés ont-ils une messagerie prête, et quel est le
--    destinataire de la copie (profil légal) ? Une ligne par établissement ayant au
--    moins une demande sans accusé. `copie_vers` est la SEULE source de la copie.
--    `copie_etat` : ABSENTE ou INVALIDE => le code REFUSE l'envoi (échec explicite
--    ACK_COPY_RECIPIENT_MISSING / ACK_COPY_RECIPIENT_INVALID), pour tout régime : à
--    corriger dans le profil légal AVANT d'ouvrir l'interrupteur.
select r.name                                                    as etablissement,
       wr.restaurant_id,
       coalesce(c.enabled, false)                                as coffre_active,
       (c.secret_ciphertext is not null)                         as coffre_avec_secret,
       c.last_error_class                                        as coffre_derniere_erreur,
       coalesce(np.email_enabled, false)                         as profil_envoi_active,
       np.sender_email                                           as expediteur,
       np.reply_to                                               as repondre_a,
       mlp.customer_service_email                                as copie_vers,
       case when mlp.customer_service_email is null or btrim(mlp.customer_service_email) = '' then 'ABSENTE'
            when btrim(mlp.customer_service_email) ~ '^[^[:space:][:cntrl:]@<>",;:\\()\[\]'']+@[^[:space:][:cntrl:]@<>",;:\\()\[\]'']+\.[A-Za-z]{2,}$' then 'OK'
            else 'INVALIDE' end
                                                                 as copie_etat,
       mcp.withdrawal_regime                                     as regime,
       count(*)                                                  as demandes_sans_accuse
from public.withdrawal_requests wr
join public.restaurants r on r.id = wr.restaurant_id
left join public.merchant_email_provider_config c on c.restaurant_id = wr.restaurant_id
left join public.merchant_notification_profile np on np.restaurant_id = wr.restaurant_id
left join public.merchant_legal_profile mlp on mlp.restaurant_id = wr.restaurant_id
left join public.merchant_cgv_profile mcp on mcp.restaurant_id = wr.restaurant_id
where wr.acknowledgement_status <> 'sent'
group by r.name, wr.restaurant_id, c.enabled, c.secret_ciphertext, c.last_error_class,
         np.email_enabled, np.sender_email, np.reply_to, mlp.customer_service_email, mcp.withdrawal_regime
order by r.name;

-- 3. Texte des CGV actuellement publiées : annoncent-elles l'expéditeur de la
--    plateforme ? Si oui, les ré-publier avec un texte conforme AVANT d'ouvrir
--    l'interrupteur (sinon l'expéditeur réel contredit le texte contractuel).
select r.name                                                           as etablissement,
       v.template_version,
       v.published_at,
       (v.rendered_content ilike '%retractation@scanym.com%')           as annonce_expediteur_plateforme
from public.merchant_cgv_version v
join public.restaurants r on r.id = v.restaurant_id
where v.status = 'ACTIVE'
order by r.name;

-- 4. Vérification d'un établissement par son nom (remplacer le motif) : adresse
--    de copie actuellement configurée, régime, messagerie. Ex. motif '%lait cru%'.
select r.id as restaurant_id, r.name,
       mlp.customer_service_email as copie_vers,
       case when mlp.customer_service_email is null or btrim(mlp.customer_service_email) = '' then 'ABSENTE'
            when btrim(mlp.customer_service_email) ~ '^[^[:space:][:cntrl:]@<>",;:\\()\[\]'']+@[^[:space:][:cntrl:]@<>",;:\\()\[\]'']+\.[A-Za-z]{2,}$' then 'OK'
            else 'INVALIDE' end as copie_etat,
       mcp.withdrawal_regime      as regime,
       np.sender_email            as expediteur,
       coalesce(c.enabled, false) as coffre_active
from public.restaurants r
left join public.merchant_legal_profile mlp on mlp.restaurant_id = r.id
left join public.merchant_cgv_profile mcp on mcp.restaurant_id = r.id
left join public.merchant_notification_profile np on np.restaurant_id = r.id
left join public.merchant_email_provider_config c on c.restaurant_id = r.id
where r.name ilike '%lait cru%';   -- <== motif à adapter ; aucune adresse n'est codée en dur

-- 5. Accusés `sending` (issue AMBIGUË) : message peut-être parti, résultat non enregistré, ou
--    processus disparu avant l'envoi. Le canal marchand ne les reprend JAMAIS. Avant toute
--    décision, chercher dans le dossier « Envoyés » de la messagerie du commerçant le
--    Message-ID `message_id_recherche` (canal marchand : dérivé de l'identifiant de la demande).
select r.name                                                     as etablissement,
       wr.id                                                      as demande,
       wr.acknowledgement_claimed_at                              as revendiquee_le,
       now() - wr.acknowledgement_claimed_at                      as depuis,
       'scanym-withdrawal-ack-' || wr.id || '@mail.scanym.com'    as message_id_recherche
from public.withdrawal_requests wr
join public.restaurants r on r.id = wr.restaurant_id
where wr.acknowledgement_status = 'sending'
order by wr.acknowledgement_claimed_at;

-- 6. État de l'interrupteur (après application du lot SQL uniquement).
-- select enabled, updated_at, note from public.scanym_ack_merchant_mailer_activation;
