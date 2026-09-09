-- ============================================================
-- Scanym — OPERATOR DASHBOARD — PAYMENT OPERATOR AUTHORIZATION v1
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis : 2af60c890ff146fafb94b7911fa3367eef0c774c (main).
--
-- CONTEXTE (reconnaissance obligatoire, voir SQL-AUTHORIZATION-
-- EVIDENCE.md pour le détail complet) : Operator Dashboard Context
-- v1/v1.1/v1.2 (déjà publié) résout CORRECTEMENT le restaurant ciblé
-- côté client pour un opérateur Scanym (F-01, ?r=<id> fait foi, pas
-- de repli silencieux). app/dashboard/payment/page.tsx (PAYMENT
-- P2B-B) applique déjà ce même patron F-01 -- MAIS reste
-- volontairement READ-ONLY (aucune écriture, aucune UI d'édition
-- n'existe) et documente explicitement, dans son propre en-tête,
-- que public.get_merchant_payment_provider_config(uuid) (PAYMENT
-- P2B-A, déjà publiée) n'autorise aujourd'hui QUE
-- public.is_member_of(p_restaurant_id) -- un opérateur consultant un
-- établissement hors de ses propres rattachements restaurant_users
-- voit donc désormais le BON restaurant (grâce à ODC v1), mais
-- l'appel RPC échoue de façon SÛRE (42501) faute d'autorisation
-- opérateur côté SQL. C'est EXACTEMENT le gap fermé par ce lot.
--
-- OBJECTIF (strictement celui du mandat) : permettre à un opérateur
-- Scanym légitimement autorisé (is_scanym_operator() = true) de LIRE
-- la configuration de paiement (métadonnées sûres UNIQUEMENT, voir
-- SECRET-NON-EXPOSURE-PROOF.md) d'un restaurant CIBLÉ, SANS aucune
-- ligne restaurant_users requise, en réutilisant EXACTEMENT le
-- primitif d'autorisation opérateur déjà audité et publié
-- (public.is_scanym_operator(), migration-lotd-establishment-
-- creation.sql) -- même patron que DRAFT-lot-catalogue-operator-
-- authorization-v1.sql (OB-2, `... or not public.is_scanym_operator()`
-- ajouté à côté d'un contrôle existant préservé À L'IDENTIQUE).
--
-- PÉRIMÈTRE STRICT :
--   - UNE SEULE fonction modifiée :
--     public.get_merchant_payment_provider_config(uuid).
--   - AUCUNE signature modifiée (p_restaurant_id uuid, inchangé).
--   - AUCUNE forme de retour modifiée (6 colonnes sûres, inchangées :
--     provider_code, mode, configuration_status, is_enabled,
--     last_verified_at, updated_at -- toujours AUCUNE colonne id,
--     restaurant_id, credentials_ref, toujours AUCUNE référence
--     vault.secrets/vault.decrypted_secrets).
--   - AUCUN message ni code d'erreur modifié.
--   - AUCUN GRANT élargi (anon/public restent sans EXECUTE ;
--     authenticated garde EXECUTE, inchangé).
--   - La condition existante `is_member_of(p_restaurant_id)` --
--     accès marchand owner/manager/staff -- est PRÉSERVÉE À
--     L'IDENTIQUE : un `or public.is_scanym_operator()` est
--     simplement ajouté À CÔTÉ, jamais une réécriture ou un
--     remplacement de la condition marchande existante.
--   - AUCUNE ligne restaurant_users factice n'est jamais créée pour
--     un opérateur -- is_scanym_operator() est un primitif
--     INDÉPENDANT (table public.scanym_operators), pas un
--     contournement de restaurant_users.
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT (mandat) :
--   - AUCUNE capacité d'ÉCRITURE. app/dashboard/payment/page.tsx est
--     structurellement READ-ONLY à ce jour (aucune RPC de mutation,
--     aucun bouton d'édition) -- il n'existe donc AUCUN "write
--     semantics" établi sur lequel bâtir une autorisation d'écriture
--     opérateur dans ce lot. Une éventuelle capacité d'écriture
--     marchande ET opérateur reste un lot futur séparé, hors mandat.
--   - AUCUNE modification de PAYMENT P1 (orders.payment_status,
--     payment_transactions, initiate/confirm_payment_attempt) ni de
--     PAYMENT P2A (colonne configuration_status, garde Vault,
--     set/clear credential RPC) -- fichiers DRAFT existants NON
--     touchés, aucune fonction déjà publiée par ces lots n'est
--     recréée ni altérée.
--   - AUCUNE modification de Delivery Pricing (le DELIVERY PRICING
--     SQL-AUTH GAP reste explicitement OPEN, mandat section dédiée --
--     get_merchant_delivery_fulfillment_pricing n'est PAS touchée
--     par ce lot).
--   - AUCUNE modification de Checkout, Invoice Request, email
--     validation, Catalogue, Bulk Product Photos, OB-4, Stuart,
--     Fulfillment -- zéro overlap avec les streams parallèles
--     (Claude Monet / Claude Nougaro / Cat Stevens), voir
--     NON-MODIFICATION-PROOF.md.
--   - AUCUN accès Vault, direct ou indirect : ce lot ne référence à
--     aucun moment vault.secrets, vault.decrypted_secrets, ni la
--     colonne credentials_ref -- la fonction modifiée ne le faisait
--     déjà pas (PAYMENT P2B-A), et ce lot ne change rien à son corps
--     de requête, seulement à son prédicat d'autorisation.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction -- si ce bloc échoue, rien n'a encore été
--    touché). Même patron que DRAFT-lot-catalogue-operator-
--    authorization-v1.sql.
-- ------------------------------------------------------------------
do $$
begin
  -- 0a. La fonction ciblée doit exister avec EXACTEMENT la signature
  -- et la forme de retour attendues (état courant, PAYMENT P2B-A
  -- déjà publiée, baseline 2af60c89).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_payment_provider_config(uuid) introuvable -- PAYMENT OPERATOR AUTHORIZATION v1 annulé, aucune modification appliquée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_function_result(p.oid) = 'TABLE(provider_code text, mode text, configuration_status text, is_enabled boolean, last_verified_at timestamp with time zone, updated_at timestamp with time zone)'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: forme de retour exacte (6 colonnes sûres, PAYMENT P2B-A) de get_merchant_payment_provider_config introuvable ou différente -- annulé, aucune modification appliquée.';
  end if;

  -- 0b. is_scanym_operator() doit déjà exister (dépendance directe,
  -- primitif d'autorisation déjà audité/publié -- réutilisé, jamais
  -- réinventé, conformément au mandat).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable -- PAYMENT OPERATOR AUTHORIZATION v1 annulé.';
  end if;

  -- 0c. Garde anti-double-application.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_payment_provider_config référence déjà is_scanym_operator -- PAYMENT OPERATOR AUTHORIZATION v1 déjà appliqué ou conflit, annulé.';
  end if;

  -- 0d. Propriétaire / SECURITY DEFINER / search_path inchangés
  -- avant modification.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_payment_provider_config n''est pas postgres/SECURITY DEFINER/search_path fixé comme attendu -- annulé.';
  end if;

  -- 0e. Frontière secret préexistante : le CODE (hors commentaires
  -- SQL `-- ...`, qui décrivent délibérément cette frontière en
  -- prose et contiendraient sinon un faux positif) de la définition
  -- actuelle ne référence jamais vault.secrets/vault.decrypted_secrets
  -- ni credentials_ref -- vérifié AVANT modification pour documenter
  -- l'état de départ (ce lot ne fera que le confirmer À L'IDENTIQUE
  -- après application, section 2 ci-dessous). Les commentaires
  -- eux-mêmes sont exclus de ce contrôle (regexp_replace retire
  -- chaque `-- ...` jusqu'à fin de ligne) : un test par simple `ilike`
  -- sur le texte brut serait un faux positif garanti, puisque cette
  -- même fonction documente déjà sa propre frontière secret en
  -- commentaire ("AUCUNE référence à id, restaurant_id,
  -- credentials_ref, vault.secrets ou vault.decrypted_secrets").
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and (regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') ilike '%vault.secrets%'
        or regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') ilike '%vault.decrypted_secrets%'
        or regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') ilike '%credentials_ref%')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_payment_provider_config référence déjà Vault/credentials_ref (hors commentaire) avant ce lot -- état inattendu, annulé par prudence.';
  end if;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. get_merchant_payment_provider_config -- ajout du bypass
--    opérateur, corps IDENTIQUE par ailleurs
--    (DRAFT-lot-payment-p2b-a-safe-merchant-read.sql, déjà publiée).
--    CREATE OR REPLACE : signature ET forme de retour INCHANGÉES,
--    préserve l'OID de la fonction et les GRANT existants sans les
--    reformuler.
--
--    Owner/manager/staff (membership sans filtre de rôle, contrat
--    existant PAYMENT P2B-A) gardent EXACTEMENT le même accès
--    lecture qu'avant ce lot : la condition `is_member_of(...)`
--    existante est intégralement préservée, seul un
--    `or public.is_scanym_operator()` est ajouté à côté -- jamais
--    une réécriture de la condition marchande elle-même.
-- ------------------------------------------------------------------
create or replace function public.get_merchant_payment_provider_config(
  p_restaurant_id uuid
)
returns table (
  provider_code        text,
  mode                 text,
  configuration_status text,
  is_enabled           boolean,
  last_verified_at     timestamptz,
  updated_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception using errcode = '22004', message = 'p_restaurant_id requis';
  end if;

  -- PAYMENT OPERATOR AUTHORIZATION v1 : membre (owner/manager/staff)
  -- DU restaurant (contrat existant, préservé À L'IDENTIQUE), OU
  -- opérateur Scanym global (bypass inconditionnel, même patron que
  -- DRAFT-lot-catalogue-operator-authorization-v1.sql / OB-2 --
  -- primitif is_scanym_operator() réutilisé sans modification).
  -- Aucune ligne restaurant_users factice n'est jamais créée pour un
  -- opérateur ; is_scanym_operator() reste un primitif indépendant
  -- (public.scanym_operators), jamais une substitution de
  -- membership.
  if not public.is_member_of(p_restaurant_id)
     and not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- Restaurant inexistant : is_member_of renvoie déjà FALSE (aucune
  -- ligne restaurant_users ne peut référencer un restaurant qui
  -- n'existe pas) ; is_scanym_operator() ne dépend que de l'identité
  -- de l'appelant, pas de l'existence de p_restaurant_id -- un
  -- opérateur AUTHENTIQUE appelant avec un p_restaurant_id inexistant
  -- passe donc le contrôle d'autorisation ci-dessus (comportement
  -- attendu, un opérateur global n'a pas à prouver l'existence d'un
  -- restaurant pour être reconnu comme opérateur) mais la requête
  -- ci-dessous ne retourne alors STRUCTURELLEMENT aucune ligne (0
  -- ligne dans payment_provider_configs pour un restaurant_id qui
  -- n'existe pas) -- jamais une erreur différente, jamais une fuite
  -- vers un autre restaurant, jamais un repli sur une valeur par
  -- défaut. Fail-closed par la forme même de la requête, pas par une
  -- vérification d'existence supplémentaire qui confirmerait/
  -- infirmerait l'existence d'un restaurant à l'appelant (même
  -- garantie de non-divulgation que le commentaire existant
  -- ci-dessus pour le cas marchand).

  -- Liste de colonnes EXPLICITE et FIGÉE -- jamais `select *`.
  -- AUCUNE référence à id, restaurant_id, credentials_ref,
  -- vault.secrets ou vault.decrypted_secrets -- INCHANGÉ par ce lot.
  return query
  select
    c.provider_code,
    c.mode,
    c.configuration_status,
    c.is_enabled,
    c.last_verified_at,
    c.updated_at
  from public.payment_provider_configs c
  where c.restaurant_id = p_restaurant_id
  order by c.provider_code;
end;
$$;

comment on function public.get_merchant_payment_provider_config(uuid) is
  'Lecture marchande ET opérateur SÛRE (PAYMENT OPERATOR AUTHORIZATION v1, sur la base de PAYMENT P2B-A) des métadonnées de configuration prestataire -- provider_code/mode/configuration_status/is_enabled/last_verified_at/updated_at UNIQUEMENT. Ne retourne JAMAIS id, restaurant_id, credentials_ref, ni aucun matériel Vault -- aucune référence à vault.secrets/vault.decrypted_secrets dans cette fonction. Autorisation : is_member_of(p_restaurant_id) [owner/manager/staff, contrat marchand inchangé] OR is_scanym_operator() [opérateur Scanym global, aucune ligne restaurant_users requise, aucun nouveau primitif]. Retourne TOUTES les configurations du restaurant (0, 1 ou plusieurs). SECURITY DEFINER, search_path vide, aucun SQL dynamique.';

-- GRANT inchangés : CREATE OR REPLACE préserve les GRANT existants
-- (authenticated conserve EXECUTE, anon/public restent sans EXECUTE)
-- -- reformulés ici uniquement pour rendre ce fichier idempotent et
-- explicite, jamais pour les élargir.
revoke all on function public.get_merchant_payment_provider_config(uuid) from public, anon;
grant execute on function public.get_merchant_payment_provider_config(uuid) to authenticated;

-- ------------------------------------------------------------------
-- 2. VÉRIFICATION POST-APPLICATION -- TOUJOURS AVANT commit; (un
--    échec ici déclenche un ROLLBACK automatique complet, aucune
--    modification partielle ne peut jamais rester committée).
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
  v_def_nocomment text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config';

  -- Texte de définition SANS les commentaires SQL `-- ...` -- utilisé
  -- pour les contrôles "doit être ABSENT" (2c/2d) ci-dessous, afin
  -- qu'un commentaire documentant délibérément la frontière secret
  -- (comme celui présent dans le corps de cette même fonction) ne
  -- déclenche jamais un faux positif. Les contrôles "doit être
  -- PRÉSENT" (2a/2b) restent sur le texte brut `v_def` -- un mot-clé
  -- attendu trouvé dans le CODE réel (pas seulement en commentaire)
  -- est ce qui est réellement vérifié pour ces deux-là (voir la
  -- section 1 : is_scanym_operator()/is_member_of(...) y apparaissent
  -- tous deux comme du CODE plpgsql exécutable, pas en commentaire).
  v_def_nocomment := regexp_replace(v_def, '--[^\n]*', '', 'g');

  -- 2a. Le corps référence désormais is_scanym_operator.
  if v_def not ilike '%is_scanym_operator%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_payment_provider_config ne référence pas is_scanym_operator après application.';
  end if;

  -- 2b. La condition marchande existante (is_member_of) est
  -- toujours présente, INCHANGÉE -- non-régression marchande.
  if v_def not ilike '%is_member_of(p_restaurant_id)%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_payment_provider_config a perdu sa condition marchande is_member_of après application.';
  end if;

  -- 2c. Frontière secret : toujours AUCUNE référence Vault/
  -- credentials_ref, HORS COMMENTAIRE, après application (ce lot ne
  -- touche que le prédicat d'autorisation, jamais le corps de la
  -- requête).
  if v_def_nocomment ilike '%vault.secrets%' or v_def_nocomment ilike '%vault.decrypted_secrets%' or v_def_nocomment ilike '%credentials_ref%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_payment_provider_config référence Vault/credentials_ref (hors commentaire) après application -- violation de la frontière secret, jamais attendu.';
  end if;

  -- 2d. Liste de colonnes toujours explicite -- pas de select *
  -- (hors commentaire -- une future note de documentation ne doit
  -- jamais pouvoir faire échouer ce contrôle par accident).
  if v_def_nocomment ilike '%select *%' or v_def_nocomment ilike '%select*%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: select * détecté (hors commentaire) après application -- jamais attendu.';
  end if;

  -- 2e. SECURITY DEFINER / search_path / propriétaire préservés.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_payment_provider_config a perdu SECURITY DEFINER/search_path/propriétaire postgres après application.';
  end if;

  -- 2f. Signature ET forme de retour INCHANGÉES (6 colonnes sûres).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) = 'TABLE(provider_code text, mode text, configuration_status text, is_enabled boolean, last_verified_at timestamp with time zone, updated_at timestamp with time zone)'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature ou forme de retour de get_merchant_payment_provider_config a changé après application, jamais attendu.';
  end if;

  -- 2g. Aucun octroi élargi : anon/public toujours sans EXECUTE,
  -- authenticated toujours avec EXECUTE.
  if has_function_privilege('anon', 'public.get_merchant_payment_provider_config(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur get_merchant_payment_provider_config après application, jamais attendu.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_merchant_payment_provider_config(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur get_merchant_payment_provider_config après application.';
  end if;

  -- 2h. Aucun octroi élargi sur la table sous-jacente : ce lot ne
  -- touche AUCUNE policy/GRANT de payment_provider_configs (RLS
  -- activée sans policy, tout accès direct révoqué -- PAYMENT P1 --
  -- reste l'état inchangé ; le seul chemin de lecture reste cette
  -- fonction SECURITY DEFINER).
  if has_table_privilege('anon', 'public.payment_provider_configs', 'SELECT')
     or has_table_privilege('authenticated', 'public.payment_provider_configs', 'SELECT')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: un accès direct anon/authenticated est apparu sur payment_provider_configs, jamais attendu -- le seul chemin de lecture doit rester la fonction SECURITY DEFINER.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport au baseline 2af60c890f (main) :
--   ~ get_merchant_payment_provider_config(uuid) : ajout du bypass
--     is_scanym_operator(), corps identique par ailleurs (CREATE OR
--     REPLACE, signature et forme de retour INCHANGÉES -- 6 colonnes
--     sûres, jamais de select *, jamais de référence Vault/
--     credentials_ref).
--   AUCUNE autre fonction modifiée. AUCUNE signature modifiée. AUCUN
--   message/code d'erreur modifié. AUCUNE nouvelle table/colonne.
--   AUCUN GRANT élargi (anon toujours sans EXECUTE, authenticated
--   inchangé ; payment_provider_configs reste sans accès direct
--   anon/authenticated).
--   AUCUNE capacité d'écriture ajoutée (READ AUTHORIZATION ONLY --
--   app/dashboard/payment/page.tsx reste structurellement READ-ONLY,
--   aucune RPC de mutation n'existe pour ce module).
--   DELIVERY PRICING SQL-AUTH GAP : reste OPEN, non touché par ce
--   lot (mandat, séparation intentionnelle).
-- ============================================================
