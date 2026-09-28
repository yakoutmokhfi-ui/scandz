-- =============================================================================
-- Scanym — GAP-01 — E-MAIL MARCHAND OBLIGATOIRE POUR STANDARD_14_DAYS/MIXED
-- (v1). DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO PROD.
-- =============================================================================
--
-- CE QUE CE LOT CORRIGE (issue #11 — remédiation GAP-01, exécution
-- confirmée par la CIO/RAVEL, périmètre EXACT du plan minimal posté en
-- commentaire "MONET — GAP-01 plan de remédiation minimal") :
--
-- `cgv_completeness_errors` exige aujourd'hui un contact client
-- (e-mail OU téléphone) sans jamais lire le régime de rétractation du
-- marchand (`merchant_cgv_profile.withdrawal_regime` n'est chargé que
-- PLUS LOIN dans la fonction, après le garde-fou de contact). Or GAP-01
-- livre l'accusé de réception D.221-5 exclusivement par e-mail
-- (`lib/server/ack-mailer.ts`) : un marchand STANDARD_14_DAYS ou MIXED
-- qui ne renseigne qu'un téléphone n'a AUCUN moyen, aujourd'hui, de
-- recevoir la copie (CC) de l'accusé envoyé à son client — la CGV
-- publiée pour ce marchand reste néanmoins complète aux yeux du moteur.
--
-- CE LOT :
--   1. Redéfinit `cgv_completeness_errors` (CREATE OR REPLACE, même
--      signature/type de retour, aucun appelant à changer) : le
--      chargement de `merchant_cgv_profile` (`v_cgv`) est avancé AVANT
--      le garde-fou de contact, dont la condition est scindée par
--      régime :
--        - `withdrawal_regime in ('STANDARD_14_DAYS', 'MIXED')`
--          (même périmètre déjà utilisé plus bas dans cette même
--          fonction pour `WITHDRAWAL_REGIME_MIXED_UNSUPPORTED`'s
--          voisinage et dans l'UI, `app/dashboard/legal-cgv/page.tsx`,
--          `cgv.withdrawal_regime === "STANDARD_14_DAYS" ||
--          cgv.withdrawal_regime === "MIXED"`) -> exige SPÉCIFIQUEMENT
--          `customer_service_email is not null` : nouveau code
--          `CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL`, jamais l'ancien.
--        - tout autre cas (`EXEMPT_PERISHABLE`, régime non renseigné,
--          profil CGV absent) -> comportement INCHANGÉ, code
--          `CUSTOMER_CONTACT_MISSING` (e-mail OU téléphone) inchangé.
--      Aucune autre branche de la fonction n'est modifiée en substance
--      (LEGAL_IDENTITY_MISSING / LEGAL_ADDRESS_MISSING / TEMPLATE_
--      UNRESOLVED / MEDIATOR_INFO_MISSING / WITHDRAWAL_REGIME_MISSING /
--      WITHDRAWAL_REGIME_MIXED_UNSUPPORTED / PREPARATION_POLICY_
--      MISSING restent des vérifications strictement équivalentes,
--      seule leur ORDRE relatif au chargement de `v_cgv` change ; voir
--      note FOUND ci-dessous).
--   2. Redéfinit `claim_withdrawal_acknowledgement_send` (même
--      signature, même type composite `withdrawal_ack_claim_result`,
--      auquel une SEULE colonne est ajoutée par `ALTER TYPE ... ADD
--      ATTRIBUTE`, jamais recréé) pour renvoyer AUSSI
--      `merchant_withdrawal_regime` (lu dans le MÊME appel SECURITY
--      DEFINER, `merchant_cgv_profile.withdrawal_regime`) : c'est ce
--      que `sendWithdrawalAcknowledgement` (`lib/server/ack-mailer.ts`)
--      consulte pour sa garde défensive runtime (voir ce fichier) —
--      sans cette colonne, le runtime ne peut pas savoir si le contact
--      e-mail manquant concerne un régime où l'accusé est exigé.
--
-- POURQUOI UNE GARDE RUNTIME EN PLUS DE CE GATE SQL (défense en
-- profondeur, pas une redondance inutile) : ce gate bloque toute
-- NOUVELLE publication de CGV incomplète, mais ne réécrit — et ne DOIT
-- PAS réécrire, cf. décision CIO "aucun backfill" — aucune donnée déjà
-- publiée avant ce lot. Un marchand STANDARD_14_DAYS/MIXED
-- téléphone-seul déjà publié avant ce gate reste publié : la garde
-- runtime protège CE cas résiduel, en refusant d'envoyer l'accusé
-- silencieusement sans CC plutôt qu'en affirmant `ok:true`.
--
-- CE QUE CE LOT NE TOUCHE PAS : l'idempotence de la reprise d'envoi
-- (`p_stale_after_seconds`, risque résiduel documenté et ACCEPTÉ par
-- la CIO, aucun code touché ici — voir le commentaire dédié dans
-- `supabase/DRAFT-lot-gap-01-ack-transport-v1.sql`, section D) ; la
-- validation `SMTP_FROM` (fichier séparé, `lib/server/ack-mailer.ts`,
-- déjà remédiée indépendamment) ; le remboursement ; le gabarit CGV
-- lui-même (aucun texte juridique changé, seul le GATE qui en
-- conditionne la complétude est resserré) ; aucun backfill de données
-- marchand existantes (test uniquement, conformément à la décision
-- CIO issue #11).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. PRÉ-VOL — prérequis et anti-double-application (HORS transaction)
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.cgv_completeness_errors(uuid)') is null
     or to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is null
     or to_regprocedure('public.resolve_cgv_publication_context(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: moteur CGV / GAP-01 ack-transport introuvable -- GAP-01 e-mail obligatoire annulé (appliquer DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql puis DRAFT-lot-gap-01-ack-transport-v1.sql d''abord).';
  end if;

  -- Anti-double-application : la marque de ce lot dans le corps des
  -- deux fonctions réécrites.
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cgv_completeness_errors'
      and p.prosrc like '%GAP-01-MANDATORY-EMAIL-V1%'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: cgv_completeness_errors porte déjà la forme GAP-01 e-mail obligatoire v1 -- annulé.';
  end if;
end $$;

begin;

-- -----------------------------------------------------------------------------
-- B. cgv_completeness_errors — e-mail marchand obligatoire pour
--    STANDARD_14_DAYS/MIXED (GAP-01-MANDATORY-EMAIL-V1)
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
  v_cgv_found     boolean;
  v_template      public.cgv_template%rowtype;
  v_applicable    public.cgv_template%rowtype;
begin
  -- GAP-01-MANDATORY-EMAIL-V1 : marque d'anti-double-application (voir
  -- le bloc de pré-vol de ce fichier) — ne porte aucune signification
  -- fonctionnelle par elle-même.
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

  -- GAP-01-MANDATORY-EMAIL-V1 -- `v_cgv` est désormais chargé ICI,
  -- AVANT le garde-fou de contact (il n'était auparavant chargé que
  -- plus bas, pour le contrôle WITHDRAWAL_REGIME_MISSING), afin que ce
  -- garde-fou puisse conditionner son exigence au régime déclaré. Son
  -- FOUND est capturé dans `v_cgv_found`, à part : les deux blocs
  -- ci-dessus (LEGAL_IDENTITY_MISSING/LEGAL_ADDRESS_MISSING) sont déjà
  -- évalués et donc inchangés par ce déplacement ; le bloc
  -- MEDIATOR_INFO_MISSING plus bas continue, comme avant ce lot, de
  -- s'exécuter immédiatement après le SELECT INTO v_template (seul
  -- select entre les deux) -- ce déplacement ne modifie donc AUCUNE
  -- sémantique FOUND préexistante ailleurs dans cette fonction.
  select * into v_cgv from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;
  v_cgv_found := found;

  if v_cgv_found and v_cgv.withdrawal_regime in ('STANDARD_14_DAYS', 'MIXED') then
    -- GAP-01-MANDATORY-EMAIL-V1 -- l'accusé de réception D.221-5 n'est
    -- transporté QUE par e-mail (lib/server/ack-mailer.ts) : sous ces
    -- deux régimes, seul un e-mail marchand satisfait l'exigence de
    -- contact -- un marchand téléphone-seul reste bloqué, avec un code
    -- d'erreur dédié, distinct de CUSTOMER_CONTACT_MISSING.
    if v_legal.customer_service_email is null then
      v_errors := array_append(v_errors, 'CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL');
    end if;
  else
    -- Tout autre cas (EXEMPT_PERISHABLE, régime non renseigné, profil
    -- CGV absent) -- comportement INCHANGÉ : e-mail OU téléphone
    -- suffit. `v_legal` étant NULL sur toutes ses colonnes quand la
    -- ligne n'existe pas (SELECT INTO sans résultat), ce test reste
    -- correct même pour un profil légal absent, exactement comme
    -- avant ce lot.
    if v_legal.customer_service_email is null and v_legal.customer_service_phone is null then
      v_errors := array_append(v_errors, 'CUSTOMER_CONTACT_MISSING');
    end if;
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

  -- GAP-01-MANDATORY-EMAIL-V1 -- `v_cgv` déjà chargé ci-dessus (plus de
  -- second SELECT INTO ici) ; `not found` est remplacé par
  -- `not v_cgv_found`, capturé au bon endroit.
  if not v_cgv_found or v_cgv.withdrawal_regime is null then
    v_errors := array_append(v_errors, 'WITHDRAWAL_REGIME_MISSING');
  elsif v_cgv.withdrawal_regime = 'MIXED' then
    -- ONLINE WITHDRAWAL v1.1 -- inchangé : MIXED n'est plus refusé par
    -- principe, sauf si le gabarit RÉELLEMENT applicable à ce marchand
    -- ne porte aucune clause MIXED contrôlée.
    begin
      v_applicable := public._resolve_applicable_cgv_template(p_restaurant_id);
    exception when sqlstate '22023' then
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
  'GAP-01-MANDATORY-EMAIL-V1 — inchangée sauf le garde-fou de contact client : pour STANDARD_14_DAYS/MIXED (accusé D.221-5 transporté uniquement par e-mail), un e-mail marchand est désormais spécifiquement requis (CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL) ; tout autre régime garde le comportement e-mail OU téléphone (CUSTOMER_CONTACT_MISSING), inchangé.';

revoke all on function public.cgv_completeness_errors(uuid) from public;
grant execute on function public.cgv_completeness_errors(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C. claim_withdrawal_acknowledgement_send — renvoie aussi le régime de
--    rétractation du marchand (garde runtime défensive côté
--    ack-mailer.ts, section suivante).
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_type t on t.typrelid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'withdrawal_ack_claim_result'
      and a.attname = 'merchant_withdrawal_regime'
      and not a.attisdropped
  ) then
    alter type public.withdrawal_ack_claim_result
      add attribute merchant_withdrawal_regime text;
  end if;
end $$;

create or replace function public.claim_withdrawal_acknowledgement_send(
  p_withdrawal_request_id uuid,
  p_stale_after_seconds    integer default 120
)
returns public.withdrawal_ack_claim_result
language sql
security definer
set search_path = ''
as $$
  -- GAP-01-MANDATORY-EMAIL-V1
  with claimed as (
    update public.withdrawal_requests
    set acknowledgement_status = 'sending',
        acknowledgement_claimed_at = now(),
        acknowledgement_send_attempts = acknowledgement_send_attempts + 1
    where id = p_withdrawal_request_id
      and (
        acknowledgement_status = 'pending'
        or (
          acknowledgement_status = 'sending'
          and acknowledgement_claimed_at is not null
          and acknowledgement_claimed_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 1))
        )
      )
    returning *
  )
  select
    c.id, c.restaurant_id, c.order_id, c.acknowledgement_address,
    c.customer_first_name, c.customer_last_name, c.declaration_snapshot,
    r.name, mlp.customer_service_email, mlp.customer_service_phone,
    mcp.withdrawal_regime
  from claimed c
  left join public.restaurants r on r.id = c.restaurant_id
  left join public.merchant_legal_profile mlp on mlp.restaurant_id = c.restaurant_id
  left join public.merchant_cgv_profile mcp on mcp.restaurant_id = c.restaurant_id;
$$;

comment on function public.claim_withdrawal_acknowledgement_send(uuid, integer) is
  'GAP-01-MANDATORY-EMAIL-V1 — inchangée sauf l''ajout de merchant_withdrawal_regime (merchant_cgv_profile.withdrawal_regime) à la ligne renvoyée, lu ICI sous SECURITY DEFINER pour la même raison que le contact marchand : service_role n''a aucun privilège de table sur merchant_cgv_profile. Consommé par la garde défensive runtime de sendWithdrawalAcknowledgement (lib/server/ack-mailer.ts). service_role uniquement.';

revoke all on function public.claim_withdrawal_acknowledgement_send(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_withdrawal_acknowledgement_send(uuid, integer) to service_role;

-- -----------------------------------------------------------------------------
-- D. VÉRIFICATION POST-COMMIT (dans la même transaction)
-- -----------------------------------------------------------------------------
do $$
declare
  v_src_completeness text;
  v_src_claim        text;
begin
  select p.prosrc into v_src_completeness from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cgv_completeness_errors';

  select p.prosrc into v_src_claim from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_withdrawal_acknowledgement_send';

  -- 1. Le nouveau code d'erreur existe bien dans la fonction.
  if v_src_completeness not like '%CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors ne porte pas le nouveau code CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL.';
  end if;

  -- 2. L'ancien code n'a pas disparu (comportement EXEMPT_PERISHABLE
  --    inchangé).
  if v_src_completeness not like '%CUSTOMER_CONTACT_MISSING%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: cgv_completeness_errors a perdu CUSTOMER_CONTACT_MISSING.';
  end if;

  -- 3. Le périmètre régime est le même prédicat que le reste du
  --    fichier (jamais retapé indépendamment).
  if v_src_completeness not like '%''STANDARD_14_DAYS'', ''MIXED''%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: le nouveau garde-fou ne réutilise pas le prédicat régime standard.';
  end if;

  -- 4. claim_withdrawal_acknowledgement_send expose bien le régime.
  if v_src_claim not like '%withdrawal_regime%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: claim_withdrawal_acknowledgement_send ne lit plus withdrawal_regime.';
  end if;

  -- 5. Privilèges : toujours aucun accès anon.
  if has_function_privilege('anon', 'public.cgv_completeness_errors(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: privilège inattendu exposé à anon/authenticated.';
  end if;
end $$;

commit;

-- =============================================================================
-- APRÈS CE FICHIER : `lib/i18n.ts` porte la clé
-- `legalCgvError_CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL` (FR/EN/AR) et
-- `lib/server/ack-mailer.ts` porte la garde runtime défensive
-- correspondante. Aucune autre modification applicative n'est requise
-- (le rendu de la liste d'erreurs et la désactivation du bouton de
-- publication, dans app/dashboard/legal-cgv/page.tsx, sont déjà
-- génériques : `t(\`legalCgvError_${code}\`)`, code inconnu affiché
-- tel quel).
-- =============================================================================
