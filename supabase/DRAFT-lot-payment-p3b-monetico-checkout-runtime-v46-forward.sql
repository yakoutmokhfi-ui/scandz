-- ============================================================
-- Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.6
-- VRAIE MIGRATION FORWARD depuis le prédécesseur historique EXACT
-- (SHA-256 45da34c37550ea89a1441d73a3ebcef074e35ecfa1738812694c8075771b6af6,
-- confirmé par lecture caractère par caractère AVANT toute
-- modification -- ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)).
--
-- DÉCOUVERTE FONDAMENTALE DE CE LOT : les lots précédents (v4.2 à
-- v4.4) ont TOUS travaillé, sans le savoir, sur une version de
-- P3-B5 DÉJÀ enrichie par le patch candidat v4.2 lui-même (colonne
-- next_attempt_at, politique de nouvelle tentative/délai,
-- escalade au plafond -- AUCUN de ces éléments n'existe dans le
-- fichier RÉELLEMENT publié). "Restaurer l'original" en v4.3/v4.4
-- restaurait en réalité la version DÉJÀ ENRICHIE par v4.2, jamais le
-- VRAI historique. Ce fichier corrige cette erreur à la racine :
-- AUCUNE colonne, index, transition ou logique de cette politique de
-- reprise durable n'existe dans le fichier historique -- TOUT est
-- ajouté ICI, de façon strictement additive, forward-only.
--
-- Le fichier historique
-- (supabase/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql)
-- reste BYTE-IDENTIQUE au SHA-256 ci-dessus -- jamais retouché comme
-- véhicule de publication (mandat §20).
--
-- TRANSACTIONNEL DE BOUT EN BOUT (mandat §7) : préflight, DDL, ACL et
-- postchecks déterministes sont TOUS À L'INTÉRIEUR de la MÊME
-- transaction -- un échec de préflight OU de postcheck annule
-- INTÉGRALEMENT toute mutation déjà appliquée dans cette même
-- exécution (aucun COMMIT n'est jamais atteint avant que les
-- postchecks n'aient tous réussi).
-- ============================================================

begin;

-- ============================================================
-- PRÉFLIGHT (mandat §6) -- fail-closed explicite. Vérifie l'état
-- EXACT du prédécesseur historique attendu, AUCUNE adaptation
-- silencieuse si absent ou structurellement incompatible.
-- ============================================================
do $$
declare
  v_missing text[] := array[]::text[];
  v_next_attempt_at_already_exists boolean;
begin
  if to_regclass('public.payment_provider_events') is null then
    v_missing := array_append(v_missing, 'table public.payment_provider_events absente');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'processing_status'
  ) then
    v_missing := array_append(v_missing, 'colonne processing_status absente');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'retry_count'
  ) then
    v_missing := array_append(v_missing, 'colonne retry_count absente');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'claim_token'
  ) then
    v_missing := array_append(v_missing, 'colonne claim_token absente');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'claim_expires_at'
  ) then
    v_missing := array_append(v_missing, 'colonne claim_expires_at absente');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'last_error_class'
  ) then
    v_missing := array_append(v_missing, 'colonne last_error_class absente');
  end if;

  -- Signature EXACTE des deux fonctions prédécesseurs attendues.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_payment_provider_events'
      and pg_get_function_identity_arguments(p.oid) = 'p_batch_size integer, p_lease_seconds integer'
  ) then
    v_missing := array_append(v_missing, 'fonction prédécesseur claim_payment_provider_events(integer, integer) absente ou signature incompatible');
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_payment_provider_event_processing_status'
      and pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_claim_token uuid, p_new_status text, p_error_class text'
  ) then
    v_missing := array_append(v_missing, 'fonction prédécesseur update_payment_provider_event_processing_status(uuid, uuid, text, text) absente ou signature incompatible');
  end if;

  -- ACL/RLS attendue du prédécesseur : service_role EXECUTE
  -- uniquement, jamais public/anon/authenticated, sur les deux
  -- fonctions.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_payment_provider_events'
      and pg_get_function_identity_arguments(p.oid) = 'p_batch_size integer, p_lease_seconds integer'
  ) and (
    has_function_privilege('anon', 'public.claim_payment_provider_events(integer,integer)', 'execute')
    or has_function_privilege('authenticated', 'public.claim_payment_provider_events(integer,integer)', 'execute')
  ) then
    v_missing := array_append(v_missing, 'posture ACL prédécesseur inattendue -- anon/authenticated a déjà EXECUTE sur claim_payment_provider_events');
  end if;

  -- État CIBLE déjà installé : traité comme SÛR (idempotence de la
  -- migration, mandat §6 : "migration explicitly handles exact
  -- already-installed target state safely") -- jamais une erreur, ni
  -- une seconde installation destructrice, simplement un no-op
  -- documenté (le CREATE OR REPLACE FUNCTION / IF NOT EXISTS
  -- ci-dessous gèrent nativement ce cas).
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'next_attempt_at'
  ) into v_next_attempt_at_already_exists;
  if v_next_attempt_at_already_exists then
    raise notice 'SCANYM_PAYMENT_EVENT: next_attempt_at existe déjà -- migration v4.6 traitée comme idempotente (aucune réinstallation destructrice)';
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'SCANYM_SCHEMA_DRIFT: prérequis P3-B5 historique manquant(s) ou incompatible(s) pour la migration forward v4.6 -- %', array_to_string(v_missing, ' ; ')
      using errcode = '55000';
  end if;
end $$;

-- ============================================================
-- DDL -- ajout ADDITIF de la colonne d'éligibilité différée.
-- ============================================================
alter table public.payment_provider_events
  add column if not exists next_attempt_at timestamptz;

comment on column public.payment_provider_events.next_attempt_at is
  'AJOUT v4.6 (migration forward depuis le prédécesseur historique --
   ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)). Horodatage d''ÉLIGIBILITÉ de
   nouvelle tentative -- SÉPARÉ de claim_expires_at (qui borne la
   possession d''un bail DÉJÀ posé). NULL = éligible immédiatement (cas
   received jamais tenté, ou tout état terminal où la colonne est sans
   objet). Renseigné UNIQUEMENT par
   update_payment_provider_event_processing_status lors d''une
   transition RÉELLE vers failed_retryable -- jamais modifié
   ailleurs.';

-- Index d''éligibilité ÉTENDU (mandat §4, "required eligibility
-- index(es)") -- remplace idx_payment_provider_events_claimable par
-- une version incluant next_attempt_at comme colonne couvrante (le
-- prédicat partiel reste IMMUTABLE -- uniquement processing_status --
-- next_attempt_at <= now() ne peut pas être un prédicat de RLS/index
-- partiel, il reste un filtre résiduel appliqué par le planificateur
-- à l'intérieur du sous-ensemble déjà étroitement filtré par statut).
drop index if exists idx_payment_provider_events_claimable;
create index idx_payment_provider_events_claimable
  on public.payment_provider_events(created_at, next_attempt_at)
  where processing_status in ('received', 'failed_retryable');

-- ============================================================
-- claim_payment_provider_events -- ÉLIGIBILITÉ ÉTENDUE (next_attempt_at)
-- ============================================================
create or replace function public.claim_payment_provider_events(
  p_batch_size integer default 20,
  p_lease_seconds integer default 60
)
returns table (
  id uuid,
  restaurant_id uuid,
  order_id uuid,
  payment_transaction_id uuid,
  provider_code text,
  provider_reference text,
  event_fingerprint text,
  provider_event_type text,
  provider_event_code text,
  amount numeric,
  currency text,
  authorization_reference text,
  processing_status text,
  retry_count integer,
  claim_token uuid,
  claim_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer;
  v_lease_seconds integer;
begin
  v_batch_size := coalesce(p_batch_size, 20);
  v_lease_seconds := coalesce(p_lease_seconds, 60);

  if v_batch_size < 1 or v_batch_size > 100 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_batch_size hors bornes (entre 1 et 100 attendu)' using errcode = '22023';
  end if;
  if v_lease_seconds < 5 or v_lease_seconds > 3600 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_lease_seconds hors bornes (entre 5 et 3600 attendu)' using errcode = '22023';
  end if;

  return query
  with eligible as (
    select e.id
      from public.payment_provider_events e
      where e.processing_status in ('received', 'failed_retryable')
        and (e.claim_expires_at is null or e.claim_expires_at <= now())
        -- AJOUT v4.6 (ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)) : un
        -- évènement failed_retryable avec un délai de nouvelle
        -- tentative pas encore atteint n'est PAS éligible -- ferme la
        -- famine potentielle du prédécesseur historique (aucun délai
        -- du tout : re-revendicable IMMÉDIATEMENT après chaque échec).
        and (e.next_attempt_at is null or e.next_attempt_at <= now())
      order by e.created_at, e.id
      limit v_batch_size
      for update skip locked
  ),
  claimed as (
    update public.payment_provider_events e
      set claim_token = gen_random_uuid(),
          claimed_at = now(),
          claim_expires_at = now() + make_interval(secs => v_lease_seconds)
      from eligible
      where e.id = eligible.id
      returning e.id, e.restaurant_id, e.order_id, e.payment_transaction_id,
                e.provider_code, e.provider_reference, e.event_fingerprint,
                e.provider_event_type, e.provider_event_code, e.amount, e.currency::text,
                e.authorization_reference, e.processing_status, e.retry_count,
                e.claim_token, e.claim_expires_at, e.created_at
  )
  select claimed.id, claimed.restaurant_id, claimed.order_id, claimed.payment_transaction_id,
         claimed.provider_code, claimed.provider_reference, claimed.event_fingerprint,
         claimed.provider_event_type, claimed.provider_event_code, claimed.amount, claimed.currency,
         claimed.authorization_reference, claimed.processing_status, claimed.retry_count,
         claimed.claim_token, claimed.claim_expires_at
    from claimed
    order by claimed.created_at, claimed.id;
end;
$$;

comment on function public.claim_payment_provider_events(integer, integer) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B5 v2 + migration forward v4.6 (ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)). Éligibilité désormais AUSSI conditionnée par next_attempt_at (NULL ou passé) -- ferme la famine potentielle d''une reprise sans délai. Tout le reste du comportement (FOR UPDATE SKIP LOCKED, bail temporel, ordonnancement déterministe) reste IDENTIQUE au prédécesseur historique.';

revoke all on function public.claim_payment_provider_events(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_payment_provider_events(integer, integer) to service_role;

-- ============================================================
-- update_payment_provider_event_processing_status -- POLITIQUE DE
-- REPRISE DURABLE COMPLÈTE (backoff, plafond, escalade,
-- received -> failed_terminal)
-- ============================================================
create or replace function public.update_payment_provider_event_processing_status(
  p_event_id uuid,
  p_claim_token uuid,
  p_new_status text,
  p_error_class text default null
)
returns table (
  id uuid,
  processing_status text,
  retry_count integer,
  processed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_status text;
  v_error_class text;
  v_event public.payment_provider_events%rowtype;
  -- AJOUT v4.6 (ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6), politique
  -- déjà justifiée dans les lots précédents mais jamais publiée par
  -- une VRAIE migration forward) : nombre MAXIMAL de tentatives
  -- failed_retryable avant escalade AUTOMATIQUE et AUTORITAIRE vers
  -- failed_terminal.
  c_max_retry_attempts constant integer := 5;
  v_next_attempt_at timestamptz;
begin
  if p_event_id is null then
    raise exception 'SCANYM_PAYMENT_EVENT: p_event_id requis' using errcode = '22004';
  end if;
  if p_claim_token is null then
    raise exception 'SCANYM_PAYMENT_EVENT: p_claim_token requis -- l''évènement doit avoir été revendiqué via claim_payment_provider_events avant toute transition' using errcode = '22004';
  end if;
  v_new_status := btrim(coalesce(p_new_status, ''));
  if v_new_status not in ('applied','ignored','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: p_new_status invalide (attendu applied/ignored/failed_retryable/failed_terminal)' using errcode = '22023';
  end if;
  v_error_class := nullif(btrim(coalesce(p_error_class, '')), '');
  if v_error_class is not null and length(v_error_class) > 200 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_error_class trop long (200 caractères maximum -- classification courte uniquement, jamais une pile d''appel)' using errcode = '22023';
  end if;

  select * into v_event from public.payment_provider_events where payment_provider_events.id = p_event_id for update;
  if not found then
    raise exception 'SCANYM_PAYMENT_EVENT: évènement introuvable' using errcode = 'P0002';
  end if;

  if v_event.claim_token is not null and v_event.claim_token is distinct from p_claim_token then
    raise exception 'SCANYM_PAYMENT_EVENT: jeton de revendication invalide -- un bail existe sur cet évènement et ne correspond pas au jeton fourni (fail-closed)' using errcode = 'P0004';
  end if;

  if v_event.processing_status = v_new_status
     and v_new_status <> 'failed_retryable'
     and v_event.processing_status in ('applied','ignored','failed_terminal') then
    return query select v_event.id, v_event.processing_status, v_event.retry_count, v_event.processed_at;
    return;
  end if;

  if v_event.processing_status in ('applied','ignored','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: évènement déjà dans un état de traitement terminal (%) -- transition vers % refusée (fail-closed)', v_event.processing_status, v_new_status using errcode = '42501';
  end if;

  if v_event.claim_token is distinct from p_claim_token
     or v_event.claim_token is null
     or v_event.claim_expires_at is null
     or v_event.claim_expires_at <= now() then
    raise exception 'SCANYM_PAYMENT_EVENT: jeton de revendication invalide ou bail expiré -- cet appelant n''est pas (ou plus) le détenteur exclusif de cet évènement (fail-closed, reprise après crash requiert une nouvelle revendication via claim_payment_provider_events)' using errcode = 'P0004';
  end if;

  -- TRANSITIONS AUTORISÉES -- AJOUT v4.6 (ferme
  -- P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)) : received -> failed_terminal
  -- désormais AUSSI autorisée (un échec DÉTERMINISTE dès la toute
  -- première tentative ne doit pas transiter artificiellement par
  -- failed_retryable, ce qui poserait à tort un délai de nouvelle
  -- tentative sur un évènement dont on sait déjà qu'aucune nouvelle
  -- tentative ne réussira jamais). failed_retryable -> failed_terminal
  -- existait DÉJÀ dans le prédécesseur historique, INCHANGÉE.
  if v_event.processing_status = 'received'
     and v_new_status not in ('applied','ignored','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: transition received -> % non autorisée', v_new_status using errcode = '42501';
  end if;
  if v_event.processing_status = 'failed_retryable'
     and v_new_status not in ('applied','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: transition failed_retryable -> % non autorisée', v_new_status using errcode = '42501';
  end if;

  -- AJOUT v4.6 (ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)) : ESCALADE
  -- AUTOMATIQUE ET AUTORITAIRE -- si CE serait la
  -- (c_max_retry_attempts + 1)-ième tentative ratée (retry_count
  -- COURANT, avant incrémentation, déjà au plafond), la transition
  -- RÉELLEMENT appliquée devient failed_terminal à la place. Le
  -- contrat de retour reflète TOUJOURS l'état RÉELLEMENT appliqué.
  if v_new_status = 'failed_retryable' and v_event.retry_count >= c_max_retry_attempts then
    v_new_status := 'failed_terminal';
  end if;

  -- AJOUT v4.6 (ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)) : délai EXPLICITE,
  -- CROISSANT, PLAFONNÉ, fonction UNIQUEMENT du NOUVEAU retry_count
  -- (après incrémentation ci-dessous). Barème (secondes) : 1re
  -- tentative ratée -> 30s ; 2e -> 120s (2min) ; 3e -> 600s (10min) ;
  -- 4e et au-delà -> 1800s (30min, plafond). NULL pour toute AUTRE
  -- transition (applied/ignored/failed_terminal).
  if v_new_status = 'failed_retryable' then
    v_next_attempt_at := now() + make_interval(secs =>
      case v_event.retry_count + 1
        when 1 then 30
        when 2 then 120
        when 3 then 600
        else 1800
      end);
  else
    v_next_attempt_at := null;
  end if;

  update public.payment_provider_events
    set processing_status = v_new_status,
        retry_count = case when v_new_status = 'failed_retryable' then payment_provider_events.retry_count + 1 else payment_provider_events.retry_count end,
        last_error_class = case when v_new_status in ('failed_retryable','failed_terminal') then v_error_class else payment_provider_events.last_error_class end,
        last_attempt_at = case when v_new_status = 'failed_retryable' then now() else payment_provider_events.last_attempt_at end,
        next_attempt_at = v_next_attempt_at,
        processed_at = now(),
        claim_token = null,
        claimed_at = null,
        claim_expires_at = null
    where payment_provider_events.id = p_event_id;

  select * into v_event from public.payment_provider_events where payment_provider_events.id = p_event_id;
  return query select v_event.id, v_event.processing_status, v_event.retry_count, v_event.processed_at;
end;
$$;

comment on function public.update_payment_provider_event_processing_status(uuid, uuid, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B5 v2 + migration forward v4.6 (ferme P3BV44-FORWARD-PREDECESSOR-01 (v4.5)/P3BV45-SQL-INSTALL-CHAIN-01 (v4.6)). Transitions autorisées ÉTENDUES : received->{applied,ignored,failed_retryable,failed_terminal}, failed_retryable->{applied,failed_retryable,failed_terminal} (cette dernière ligne INCHANGÉE depuis le prédécesseur historique). Ajoute : escalade automatique au plafond de tentatives (5), délai de nouvelle tentative croissant plafonné (30/120/600/1800s) via next_attempt_at. Tout le reste (verrouillage terminal, propriété du bail, libération inconditionnelle du bail) reste IDENTIQUE au prédécesseur historique.';

revoke all on function public.update_payment_provider_event_processing_status(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_payment_provider_event_processing_status(uuid, uuid, text, text) to service_role;

-- ============================================================
-- POSTCHECKS DÉTERMINISTES (mandat §7) -- AUCUN COMMIT avant que
-- TOUS ces contrôles n'aient réussi. Un échec ICI annule
-- INTÉGRALEMENT toute la migration (DDL + fonctions + ACL compris).
-- ============================================================
do $$
declare
  v_prosecdef_claim boolean;
  v_proconfig_claim text[];
  v_prosecdef_update boolean;
  v_proconfig_update text[];
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'next_attempt_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- next_attempt_at absente ou de type incorrect après migration forward v4.6' using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'payment_provider_events'
      and indexname = 'idx_payment_provider_events_claimable'
      and indexdef ilike '%next_attempt_at%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- index d''éligibilité étendu absent après migration forward v4.6' using errcode = '55000';
  end if;

  select p.prosecdef, p.proconfig into v_prosecdef_claim, v_proconfig_claim
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_payment_provider_events'
    and pg_get_function_identity_arguments(p.oid) = 'p_batch_size integer, p_lease_seconds integer';
  if v_prosecdef_claim is distinct from true or v_proconfig_claim is null or not ('search_path=""' = any (v_proconfig_claim)) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- SECURITY DEFINER/search_path claim_payment_provider_events non préservé' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.claim_payment_provider_events(integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_payment_provider_events(integer,integer)', 'execute')
     or has_function_privilege('public', 'public.claim_payment_provider_events(integer,integer)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur claim_payment_provider_events' using errcode = '55000';
  end if;
  if not has_function_privilege('service_role', 'public.claim_payment_provider_events(integer,integer)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- service_role a perdu EXECUTE sur claim_payment_provider_events' using errcode = '55000';
  end if;

  select p.prosecdef, p.proconfig into v_prosecdef_update, v_proconfig_update
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'update_payment_provider_event_processing_status'
    and pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_claim_token uuid, p_new_status text, p_error_class text';
  if v_prosecdef_update is distinct from true or v_proconfig_update is null or not ('search_path=""' = any (v_proconfig_update)) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- SECURITY DEFINER/search_path update_payment_provider_event_processing_status non préservé' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.update_payment_provider_event_processing_status(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.update_payment_provider_event_processing_status(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('public', 'public.update_payment_provider_event_processing_status(uuid,uuid,text,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur update_payment_provider_event_processing_status' using errcode = '55000';
  end if;
  if not has_function_privilege('service_role', 'public.update_payment_provider_event_processing_status(uuid,uuid,text,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- service_role a perdu EXECUTE sur update_payment_provider_event_processing_status' using errcode = '55000';
  end if;
end $$;

commit;
