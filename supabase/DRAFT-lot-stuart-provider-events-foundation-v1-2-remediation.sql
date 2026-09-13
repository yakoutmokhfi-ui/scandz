-- ============================================================
-- Scanym — STUART LOT D1 v1.2 — TARGETED AUDIT REMEDIATION
-- (Cat Stevens, independent audit — FAIL, NOT READY FOR RELEASE,
-- 3 blockers ; ce fichier corrige les 2 blockers SQL, HIGH tous
-- les deux).
--
-- BLOCKER 1 (HIGH) — PROVIDER-EVENT RETRIES UNBOUNDED / NO BACKOFF :
--   `failed_retryable` était immédiatement re-revendicable, sans
--   plafond de tentatives ni délai de nouvelle tentative -- un
--   évènement "poison" pouvait être re-revendiqué en boucle chaude et
--   affamer la file. Corrigé en réutilisant TEL QUEL le modèle déjà
--   établi et publié pour `payment_provider_events`
--   (supabase/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v46-forward.sql,
--   colonne `next_attempt_at`, barème 30/120/600/1800s plafonné,
--   plafond de 5 tentatives, escalade autoritaire vers
--   `failed_terminal`) -- ici nommée `next_retry_at` (mandat v1.2,
--   littéral) mais SÉMANTIQUE et BARÈME strictement identiques. AUCUNE
--   politique de reprise différente n'est inventée.
--
-- BLOCKER 2 (HIGH) — WRONG JOB ENVIRONMENT AUTHORITY :
--   `orchestration.ts` (D1 v1/v1.1) allouait avec `environment:
--   "sandbox"` codé en dur, jamais l'autorité marchand réelle. Corrigé
--   en étendant `get_stuart_delivery_eligibility` (lecture pure,
--   INCHANGÉE dans son ordre de vérification, mandat D1 §A) pour
--   renvoyer AUSSI `merchant_environment` -- DÉRIVÉ EXCLUSIVEMENT de
--   `delivery_provider_configs.mode` (LOT A-0, déjà lu par cette même
--   RPC pour `configuration_status` -- AUCUNE requête
--   supplémentaire, AUCUN nouveau signal introduit), avec un nouveau
--   motif d'inéligibilité fail-closed défensif si cette valeur
--   s'écartait un jour de l'énumération CHECK existante
--   ('sandbox','production' -- delivery_provider_configs.mode, LOT
--   A-0, INCHANGÉE). AUCUN fallback vers une variable d'environnement
--   globale ni un mode plateforme -- l'AUTHORITY reste
--   STRICTEMENT le couple (restaurant_id, provider_code='stuart').
--
-- Le fichier historique
-- (supabase/DRAFT-lot-stuart-provider-events-foundation-v1.sql, D1
-- v1) reste BYTE-IDENTIQUE -- jamais retouché comme véhicule de
-- publication (même discipline que PAYMENT P3-B v4.6-forward). TOUT
-- est ADDITIF/forward-only ici.
--
-- HORS PÉRIMÈTRE (mandat v1.2, littéral) : aucune autre modification
-- fonctionnelle -- autorité de paiement, sémantique du hook
-- post-paiement, comportement du transport Stuart non-live, LOT A-0/
-- A/B/C, suivi client, CGV, contrat d'authentification webhook,
-- transport Stuart réel, validation de signature webhook réelle :
-- AUCUN changement.
--
-- DÉVELOPPEMENT/TEST UNIQUEMENT -- jamais exécuté en Production par
-- ce lot. NO Production SQL.
-- ============================================================

begin;

-- ============================================================
-- PRÉFLIGHT (mandat v1.2, "keep it additive and deterministic") --
-- fail-closed explicite si le prédécesseur exact D1 v1/v1.1 est
-- absent ou structurellement incompatible. Traite une ré-application
-- de CE fichier comme un no-op idempotent documenté (jamais une
-- erreur, jamais une seconde installation destructrice) -- même
-- discipline que PAYMENT P3-B v4.6-forward.
-- ============================================================
do $$
declare
  v_missing text[] := array[]::text[];
  v_next_retry_at_already_exists boolean;
begin
  if to_regclass('public.stuart_provider_events') is null then
    v_missing := array_append(v_missing, 'table public.stuart_provider_events absente -- STUART LOT D1 v1 requis avant v1.2');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stuart_provider_events'
      and column_name = 'processing_status'
  ) then
    v_missing := array_append(v_missing, 'colonne stuart_provider_events.processing_status absente');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stuart_provider_events'
      and column_name = 'retry_count'
  ) then
    v_missing := array_append(v_missing, 'colonne stuart_provider_events.retry_count absente');
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_stuart_provider_events'
      and pg_get_function_identity_arguments(p.oid) = 'p_batch_size integer, p_lease_seconds integer'
  ) then
    v_missing := array_append(v_missing, 'fonction prédécesseur claim_stuart_provider_events(integer, integer) absente ou signature incompatible');
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_stuart_provider_event_processing_status'
      and pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_claim_token uuid, p_new_status text, p_error_class text, p_resolved_stuart_delivery_job_id uuid'
  ) then
    v_missing := array_append(v_missing, 'fonction prédécesseur update_stuart_provider_event_processing_status(uuid, uuid, text, text, uuid) absente ou signature incompatible');
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_stuart_delivery_eligibility'
      and pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_restaurant_id uuid'
  ) then
    v_missing := array_append(v_missing, 'fonction prédécesseur get_stuart_delivery_eligibility(uuid, uuid) absente ou signature incompatible');
  end if;

  if to_regclass('public.delivery_provider_configs') is null then
    v_missing := array_append(v_missing, 'table public.delivery_provider_configs absente -- LOT A-0 requis');
  end if;

  -- État CIBLE déjà installé : no-op idempotent documenté, jamais une
  -- erreur (le "add column if not exists"/"create or replace
  -- function"/"drop function if exists ; create function" ci-dessous
  -- gèrent nativement ce cas).
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stuart_provider_events'
      and column_name = 'next_retry_at'
  ) into v_next_retry_at_already_exists;
  if v_next_retry_at_already_exists then
    raise notice 'SCANYM_STUART_EVENT: next_retry_at existe déjà -- migration v1.2 traitée comme idempotente (aucune réinstallation destructrice)';
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'SCANYM_SCHEMA_DRIFT: prérequis STUART LOT D1 v1/v1.1 manquant(s) ou incompatible(s) pour la remédiation v1.2 -- %', array_to_string(v_missing, ' ; ')
      using errcode = '55000';
  end if;
end $$;

-- ============================================================
-- BLOCKER 1 — DDL additif : horodatage d'éligibilité de nouvelle
-- tentative, SÉPARÉ de claim_expires_at (qui borne la possession d'un
-- bail DÉJÀ posé). NULL = éligible immédiatement (received jamais
-- tenté, ou tout état terminal où la colonne est sans objet).
-- ============================================================
alter table public.stuart_provider_events
  add column if not exists next_retry_at timestamptz;

comment on column public.stuart_provider_events.next_retry_at is
  'STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 1 HIGH) -- horodatage d''éligibilité de nouvelle tentative, MÊME modèle que payment_provider_events.next_attempt_at (PAYMENT P3-B v4.6-forward). NULL = éligible immédiatement. Renseigné UNIQUEMENT par update_stuart_provider_event_processing_status lors d''une transition RÉELLE vers failed_retryable -- jamais modifié ailleurs, jamais NULL réinitialisé pour une autre raison que ce même appel.';

-- Index d'éligibilité ÉTENDU -- remplace idx_stuart_provider_events_
-- claimable par une version incluant next_retry_at comme colonne
-- couvrante (même discipline que l'index équivalent payment_provider_
-- events, v4.6-forward).
drop index if exists idx_stuart_provider_events_claimable;
create index idx_stuart_provider_events_claimable
  on public.stuart_provider_events(created_at, next_retry_at)
  where processing_status in ('received', 'failed_retryable');

-- ============================================================
-- BLOCKER 1 — claim_stuart_provider_events : ÉLIGIBILITÉ ÉTENDUE
-- (next_retry_at NULL ou passé). SIGNATURE INCHANGÉE -- CREATE OR
-- REPLACE suffit (aucune colonne ajoutée au contrat de retour).
-- ============================================================
create or replace function public.claim_stuart_provider_events(
  p_batch_size integer default 20,
  p_lease_seconds integer default 60
)
returns table (
  id uuid,
  stuart_delivery_job_id uuid,
  restaurant_id uuid,
  provider_job_id_raw text,
  event_fingerprint text,
  provider_event_type text,
  provider_status_raw text,
  processing_status text,
  retry_count integer,
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz
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
    raise exception 'SCANYM_STUART_EVENT: p_batch_size hors bornes (entre 1 et 100 attendu)' using errcode = '22023';
  end if;
  if v_lease_seconds < 5 or v_lease_seconds > 3600 then
    raise exception 'SCANYM_STUART_EVENT: p_lease_seconds hors bornes (entre 5 et 3600 attendu)' using errcode = '22023';
  end if;

  return query
  with eligible as (
    select e.id
      from public.stuart_provider_events e
      where e.processing_status in ('received', 'failed_retryable')
        and (e.claim_expires_at is null or e.claim_expires_at <= now())
        -- STUART LOT D1 v1.2 (blocker 1) : un évènement failed_retryable
        -- avec un délai de nouvelle tentative pas encore atteint n'est
        -- PAS éligible -- ferme la famine potentielle (re-revendicable
        -- immédiatement après chaque échec, boucle chaude sur un
        -- évènement poison). Un poison event dont next_retry_at est
        -- dans le futur est donc EXCLU de cet ensemble -- il ne
        -- consomme jamais de place dans le LIMIT ci-dessous, si bien
        -- qu'un autre évènement plus récent MAIS éligible est claimé
        -- normalement (pas de starvation).
        and (e.next_retry_at is null or e.next_retry_at <= now())
      order by e.created_at, e.id
      limit v_batch_size
      for update skip locked
  ),
  claimed as (
    update public.stuart_provider_events e
      set claim_token = gen_random_uuid(),
          claimed_at = now(),
          claim_expires_at = now() + make_interval(secs => v_lease_seconds)
      from eligible
      where e.id = eligible.id
      returning e.id, e.stuart_delivery_job_id, e.restaurant_id, e.provider_job_id_raw,
                e.event_fingerprint, e.provider_event_type, e.provider_status_raw,
                e.processing_status, e.retry_count, e.claim_token, e.claim_expires_at,
                e.created_at
  )
  select claimed.id, claimed.stuart_delivery_job_id, claimed.restaurant_id, claimed.provider_job_id_raw,
         claimed.event_fingerprint, claimed.provider_event_type, claimed.provider_status_raw,
         claimed.processing_status, claimed.retry_count, claimed.claim_token, claimed.claim_expires_at,
         claimed.created_at
    from claimed
    order by claimed.created_at, claimed.id;
end;
$$;

comment on function public.claim_stuart_provider_events(integer, integer) is
  'STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 1 HIGH) -- éligibilité désormais AUSSI conditionnée par next_retry_at (NULL ou passé), ferme la famine potentielle d''une reprise sans délai. Tout le reste (FOR UPDATE SKIP LOCKED, bail temporel, ordonnancement déterministe) reste IDENTIQUE à D1 v1.';

revoke all on function public.claim_stuart_provider_events(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_stuart_provider_events(integer, integer) to service_role;

-- ============================================================
-- BLOCKER 1 — update_stuart_provider_event_processing_status :
-- PLAFOND DÉTERMINISTE (5 tentatives, MÊME valeur que
-- payment_provider_events -- "already-established model", mandat
-- v1.2), ESCALADE AUTORITAIRE received/failed_retryable ->
-- failed_terminal au plafond, DÉLAI CROISSANT PLAFONNÉ (30/120/
-- 600/1800s, IDENTIQUE au barème payment_provider_events -- mandat
-- v1.2, "do not invent a different platform-wide policy if a
-- canonical one already exists"). SIGNATURE INCHANGÉE -- CREATE OR
-- REPLACE suffit.
-- ============================================================
create or replace function public.update_stuart_provider_event_processing_status(
  p_event_id uuid,
  p_claim_token uuid,
  p_new_status text,
  p_error_class text default null,
  p_resolved_stuart_delivery_job_id uuid default null
)
returns table (
  id uuid,
  processing_status text,
  retry_count integer,
  processed_at timestamptz,
  stuart_delivery_job_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_status text;
  v_error_class text;
  v_event public.stuart_provider_events%rowtype;
  v_resolved_restaurant_id uuid;
  -- STUART LOT D1 v1.2 (blocker 1, HIGH) -- MÊME plafond que
  -- payment_provider_events (c_max_retry_attempts, PAYMENT P3-B
  -- v4.6-forward) -- "already-established model", jamais une
  -- politique différente inventée pour Stuart.
  c_max_retry_attempts constant integer := 5;
  v_next_retry_at timestamptz;
begin
  if p_event_id is null then
    raise exception 'SCANYM_STUART_EVENT: p_event_id requis' using errcode = '22004';
  end if;
  if p_claim_token is null then
    raise exception 'SCANYM_STUART_EVENT: p_claim_token requis -- l''évènement doit avoir été revendiqué via claim_stuart_provider_events avant toute transition' using errcode = '22004';
  end if;
  v_new_status := btrim(coalesce(p_new_status, ''));
  if v_new_status not in ('applied','ignored','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_STUART_EVENT: p_new_status invalide (attendu applied/ignored/failed_retryable/failed_terminal)' using errcode = '22023';
  end if;
  v_error_class := nullif(btrim(coalesce(p_error_class, '')), '');
  if v_error_class is not null and length(v_error_class) > 200 then
    raise exception 'SCANYM_STUART_EVENT: p_error_class trop long (200 caractères maximum)' using errcode = '22023';
  end if;

  select * into v_event from public.stuart_provider_events where stuart_provider_events.id = p_event_id for update;
  if not found then
    raise exception 'SCANYM_STUART_EVENT: évènement introuvable' using errcode = 'P0002';
  end if;

  if v_event.claim_token is not null and v_event.claim_token is distinct from p_claim_token then
    raise exception 'SCANYM_STUART_EVENT: jeton de revendication invalide -- un bail existe sur cet évènement et ne correspond pas au jeton fourni (fail-closed)' using errcode = 'P0004';
  end if;

  if v_event.processing_status = v_new_status
     and v_new_status <> 'failed_retryable'
     and v_event.processing_status in ('applied','ignored','failed_terminal') then
    return query select v_event.id, v_event.processing_status, v_event.retry_count, v_event.processed_at, v_event.stuart_delivery_job_id;
    return;
  end if;

  if v_event.processing_status in ('applied','ignored','failed_terminal') then
    raise exception 'SCANYM_STUART_EVENT: évènement déjà dans un état de traitement terminal (%) -- transition vers % refusée (fail-closed)', v_event.processing_status, v_new_status using errcode = '42501';
  end if;

  if v_event.claim_token is distinct from p_claim_token
     or v_event.claim_token is null
     or v_event.claim_expires_at is null
     or v_event.claim_expires_at <= now() then
    raise exception 'SCANYM_STUART_EVENT: jeton de revendication invalide ou bail expiré -- cet appelant n''est pas (ou plus) le détenteur exclusif de cet évènement (fail-closed)' using errcode = 'P0004';
  end if;

  if v_event.processing_status = 'received'
     and v_new_status not in ('applied','ignored','failed_retryable') then
    raise exception 'SCANYM_STUART_EVENT: transition received -> % non autorisée', v_new_status using errcode = '42501';
  end if;
  if v_event.processing_status = 'failed_retryable'
     and v_new_status not in ('applied','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_STUART_EVENT: transition failed_retryable -> % non autorisée', v_new_status using errcode = '42501';
  end if;

  -- STUART LOT D1 v1.2 (blocker 1, HIGH) -- ESCALADE AUTOMATIQUE ET
  -- AUTORITAIRE : si CE serait la (c_max_retry_attempts + 1)-ième
  -- tentative ratée (retry_count COURANT, avant incrémentation, déjà
  -- au plafond), la transition RÉELLEMENT appliquée devient
  -- failed_terminal à la place ('failed_retryable' est déjà une cible
  -- valide depuis 'received' ET depuis 'failed_retryable', voir les
  -- deux vérifications ci-dessus -- la validité de la transition est
  -- donc déjà établie avant cette substitution). Le contrat de retour
  -- reflète TOUJOURS l'état RÉELLEMENT appliqué.
  if v_new_status = 'failed_retryable' and v_event.retry_count >= c_max_retry_attempts then
    v_new_status := 'failed_terminal';
  end if;

  -- STUART LOT D1 v1.2 (blocker 1, HIGH) -- délai EXPLICITE,
  -- CROISSANT, PLAFONNÉ, fonction UNIQUEMENT du NOUVEAU retry_count
  -- (après incrémentation ci-dessous). Barème (secondes) IDENTIQUE à
  -- payment_provider_events (PAYMENT P3-B v4.6-forward) : 1re tentative
  -- ratée -> 30s ; 2e -> 120s (2min) ; 3e -> 600s (10min) ; 4e et
  -- au-delà -> 1800s (30min, plafond). NULL pour toute AUTRE
  -- transition (applied/ignored/failed_terminal).
  if v_new_status = 'failed_retryable' then
    v_next_retry_at := now() + make_interval(secs =>
      case v_event.retry_count + 1
        when 1 then 30
        when 2 then 120
        when 3 then 600
        else 1800
      end);
  else
    v_next_retry_at := null;
  end if;

  -- RÉSOLUTION TARDIVE DE CORRÉLATION -- INCHANGÉ depuis D1 v1.
  if v_event.stuart_delivery_job_id is null and p_resolved_stuart_delivery_job_id is not null then
    select sdj.restaurant_id into v_resolved_restaurant_id
      from public.stuart_delivery_jobs sdj
      where sdj.id = p_resolved_stuart_delivery_job_id;
    if v_resolved_restaurant_id is null then
      raise exception 'SCANYM_STUART_EVENT: p_resolved_stuart_delivery_job_id ne correspond à aucune ligne stuart_delivery_jobs existante' using errcode = 'P0002';
    end if;
  end if;

  update public.stuart_provider_events
    set processing_status = v_new_status,
        retry_count = case when v_new_status = 'failed_retryable' then stuart_provider_events.retry_count + 1 else stuart_provider_events.retry_count end,
        last_error_class = case when v_new_status in ('failed_retryable','failed_terminal') then v_error_class else stuart_provider_events.last_error_class end,
        last_attempt_at = case when v_new_status = 'failed_retryable' then now() else stuart_provider_events.last_attempt_at end,
        next_retry_at = v_next_retry_at,
        processed_at = now(),
        stuart_delivery_job_id = coalesce(stuart_provider_events.stuart_delivery_job_id, p_resolved_stuart_delivery_job_id),
        restaurant_id = coalesce(stuart_provider_events.restaurant_id, v_resolved_restaurant_id),
        claim_token = null,
        claimed_at = null,
        claim_expires_at = null
    where stuart_provider_events.id = p_event_id;

  select * into v_event from public.stuart_provider_events where stuart_provider_events.id = p_event_id;
  return query select v_event.id, v_event.processing_status, v_event.retry_count, v_event.processed_at, v_event.stuart_delivery_job_id;
end;
$$;

comment on function public.update_stuart_provider_event_processing_status(uuid, uuid, text, text, uuid) is
  'STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 1 HIGH) -- plafond déterministe de tentatives (5, MÊME valeur que payment_provider_events), escalade autoritaire vers failed_terminal au plafond, délai de nouvelle tentative croissant plafonné (30/120/600/1800s) via next_retry_at -- MÊME barème EXACT que payment_provider_events (PAYMENT P3-B v4.6-forward), "already-established model" réutilisé tel quel. Verrouillage terminal/propriété du bail/résolution tardive de corrélation INCHANGÉS depuis D1 v1.';

revoke all on function public.update_stuart_provider_event_processing_status(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.update_stuart_provider_event_processing_status(uuid, uuid, text, text, uuid) to service_role;

-- ============================================================
-- BLOCKER 2 — get_stuart_delivery_eligibility : renvoie DÉSORMAIS
-- AUSSI merchant_environment (dérivé EXCLUSIVEMENT de
-- delivery_provider_configs.mode, déjà lu par cette même RPC --
-- AUCUNE requête supplémentaire). SIGNATURE DE RETOUR CHANGÉE (colonne
-- ajoutée) -- DROP puis CREATE requis (PostgreSQL refuse un CREATE OR
-- REPLACE qui changerait le type de retour d'une fonction existante).
-- Ordre de vérification séquentiel INCHANGÉ (D1 v1, mandat §A) --
-- SEUL ajout : un nouveau motif d'inéligibilité défensif
-- (STUART_MERCHANT_ENVIRONMENT_INVALID) si delivery_provider_configs.
-- mode s'écartait un jour de l'énumération CHECK existante (défense en
-- profondeur -- ne devrait structurellement jamais se produire, la
-- colonne est déjà `not null check (mode in ('sandbox','production'))`
-- côté LOT A-0, INCHANGÉ).
-- ============================================================
drop function if exists public.get_stuart_delivery_eligibility(uuid, uuid);

create function public.get_stuart_delivery_eligibility(
  p_order_id uuid,
  p_restaurant_id uuid
)
returns table (
  eligible boolean,
  reason_code text,
  merchant_environment text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_restaurant record;
  v_stuart_config record;
  v_sale_mode record;
  v_fulfillment_count integer;
begin
  if p_order_id is null or p_restaurant_id is null then
    return query select false, 'INVALID_INPUT'::text, null::text;
    return;
  end if;

  select o.id, o.restaurant_id, o.status, o.service_mode, o.payment_status,
         o.delivery_address, o.delivery_zone, o.customer_phone
    into v_order
    from public.orders o
    where o.id = p_order_id and o.restaurant_id = p_restaurant_id;
  if not found then
    return query select false, 'ORDER_NOT_FOUND'::text, null::text;
    return;
  end if;

  select r.id, r.is_active into v_restaurant
    from public.restaurants r
    where r.id = p_restaurant_id;
  if not found or v_restaurant.is_active is not true then
    return query select false, 'RESTAURANT_INACTIVE'::text, null::text;
    return;
  end if;

  if v_order.status = 'cancelled' then
    return query select false, 'ORDER_CANCELLED'::text, null::text;
    return;
  end if;

  if v_order.payment_status is distinct from 'paid' then
    return query select false, 'PAYMENT_NOT_CONFIRMED'::text, null::text;
    return;
  end if;

  if v_order.service_mode is distinct from 'delivery' then
    return query select false, 'FULFILLMENT_MODE_NOT_DELIVERY'::text, null::text;
    return;
  end if;

  if v_order.delivery_address is null or v_order.customer_phone is null then
    return query select false, 'DELIVERY_CONTACT_DATA_MISSING'::text, null::text;
    return;
  end if;

  select rsm.enabled, rsm.provider into v_sale_mode
    from public.restaurant_sale_modes rsm
    where rsm.restaurant_id = p_restaurant_id and rsm.mode_code = 'delivery';
  if not found or v_sale_mode.enabled is not true then
    return query select false, 'DELIVERY_MODE_NOT_ENABLED'::text, null::text;
    return;
  end if;
  if v_sale_mode.provider is distinct from 'stuart' then
    return query select false, 'DELIVERY_PROVIDER_NOT_STUART'::text, null::text;
    return;
  end if;

  select count(*) into v_fulfillment_count
    from public.restaurant_sale_mode_fulfillments f
    where f.restaurant_id = p_restaurant_id
      and f.mode_code = 'delivery'
      and f.provider = 'stuart';
  if v_fulfillment_count = 0 then
    return query select false, 'NO_ACTIVE_STUART_FULFILLMENT_RULE'::text, null::text;
    return;
  end if;

  select dpc.mode, dpc.configuration_status into v_stuart_config
    from public.delivery_provider_configs dpc
    where dpc.restaurant_id = p_restaurant_id and dpc.provider_code = 'stuart';
  if not found then
    return query select false, 'STUART_CREDENTIAL_NOT_CONFIGURED'::text, null::text;
    return;
  end if;
  if v_stuart_config.configuration_status not in ('configured', 'verified') then
    return query select false, 'STUART_CREDENTIAL_NOT_CONFIGURED'::text, null::text;
    return;
  end if;

  -- STUART LOT D1 v1.2 (blocker 2, HIGH) — AUTORITÉ D'ENVIRONNEMENT :
  -- defense en profondeur -- delivery_provider_configs.mode est déjà
  -- `not null check (mode in ('sandbox','production'))` (LOT A-0,
  -- INCHANGÉ) -- ce cas ne devrait structurellement jamais se
  -- produire pour une ligne réelle, mais n'est JAMAIS supposé
  -- silencieusement (mandat v1.2, "missing/invalid/unrecognized mode
  -- -> fail closed / ineligible"). AUCUN fallback -- ni variable
  -- d'environnement globale, ni mode plateforme.
  if v_stuart_config.mode not in ('sandbox', 'production') then
    return query select false, 'STUART_MERCHANT_ENVIRONMENT_INVALID'::text, null::text;
    return;
  end if;

  if exists (
    select 1 from public.stuart_delivery_jobs sdj
    where sdj.order_id = p_order_id and sdj.is_active
      and sdj.send_state = 'terminal_failure'
  ) then
    return query select false, 'PRIOR_TERMINAL_FAILURE_EXISTS'::text, null::text;
    return;
  end if;

  return query select true, 'ELIGIBLE'::text, v_stuart_config.mode;
end;
$$;

comment on function public.get_stuart_delivery_eligibility(uuid, uuid) is
  'STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 2 HIGH) — MÊME autorité d''éligibilité livraison Stuart que D1 v1 (dix vérifications séquentielles INCHANGÉES, retour au premier motif rencontré), ÉTENDUE pour renvoyer AUSSI merchant_environment (dérivé EXCLUSIVEMENT de delivery_provider_configs.mode déjà lu pour configuration_status -- AUCUNE requête supplémentaire, AUCUN fallback global). Nouveau motif défensif STUART_MERCHANT_ENVIRONMENT_INVALID si ce mode s''écartait de l''énumération CHECK existante (ne devrait structurellement jamais se produire). N''ALLOUE, NE CRÉE ET N''ENVOIE RIEN -- lecture seule.';

revoke all on function public.get_stuart_delivery_eligibility(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_stuart_delivery_eligibility(uuid, uuid) to service_role;

-- ============================================================
-- POSTCHECKS DÉTERMINISTES -- AUCUN COMMIT avant que TOUS ces
-- contrôles n'aient réussi. Un échec ICI annule INTÉGRALEMENT toute
-- cette migration (DDL + fonctions + ACL compris).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stuart_provider_events'
      and column_name = 'next_retry_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- next_retry_at absente ou de type incorrect' using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'stuart_provider_events'
      and indexname = 'idx_stuart_provider_events_claimable'
      and indexdef ilike '%next_retry_at%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- idx_stuart_provider_events_claimable ne couvre pas next_retry_at' using errcode = '55000';
  end if;

  if (select prosrc from pg_proc where proname = 'claim_stuart_provider_events') not ilike '%next_retry_at%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- claim_stuart_provider_events ne filtre pas sur next_retry_at' using errcode = '55000';
  end if;

  if (select prosrc from pg_proc where proname = 'update_stuart_provider_event_processing_status') not ilike '%next_retry_at%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- update_stuart_provider_event_processing_status ne calcule pas next_retry_at' using errcode = '55000';
  end if;
  if (select prosrc from pg_proc where proname = 'update_stuart_provider_event_processing_status') not ilike '%c_max_retry_attempts%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- update_stuart_provider_event_processing_status ne référence pas un plafond de tentatives' using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_stuart_delivery_eligibility'
      and pg_get_function_result(p.oid) ilike '%merchant_environment text%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- get_stuart_delivery_eligibility ne renvoie pas merchant_environment' using errcode = '55000';
  end if;
  if (select prosrc from pg_proc where proname = 'get_stuart_delivery_eligibility') ilike '%STUART_ENV%'
     or (select prosrc from pg_proc where proname = 'get_stuart_delivery_eligibility') ilike '%current_setting%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- get_stuart_delivery_eligibility référence un fallback global inattendu' using errcode = '55000';
  end if;

  -- ACL/RLS INCHANGÉE -- jamais un élargissement accidentel.
  if has_function_privilege('anon', 'public.claim_stuart_provider_events(integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_stuart_provider_events(integer,integer)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur claim_stuart_provider_events' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.update_stuart_provider_event_processing_status(uuid,uuid,text,text,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.update_stuart_provider_event_processing_status(uuid,uuid,text,text,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur update_stuart_provider_event_processing_status' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.get_stuart_delivery_eligibility(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.get_stuart_delivery_eligibility(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur get_stuart_delivery_eligibility' using errcode = '55000';
  end if;
end $$;

-- ============================================================
-- NON-RÉGRESSION (mandat v1.2) : stuart_delivery_jobs (v2.1),
-- reap_stale_stuart_delivery_job_send_started,
-- apply_stuart_delivery_job_status_if_newer,
-- record_stuart_delivery_job_local_cancellation,
-- record_stuart_provider_event, LOT A-0/A/B/C — AUCUNE ligne touchée
-- par ce fichier. L'invariant "une seule tentative Stuart active par
-- commande, tous environnements confondus"
-- (stuart_delivery_jobs_one_active_per_order, LOT avant D1, v2.1)
-- reste INTACT et INCHANGÉ -- ce fichier ne modifie ni ne redéfinit
-- allocate_stuart_delivery_job.
-- ============================================================

commit;
