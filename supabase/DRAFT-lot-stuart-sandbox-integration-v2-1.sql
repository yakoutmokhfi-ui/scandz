-- ============================================================
-- Scanym — DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.1
-- Remédiation ciblée de 7 findings HIGH + 1 MEDIUM (audit Work
-- indépendant sur v2). DÉVELOPPEMENT / TEST UNIQUEMENT -- jamais
-- exécuté en Production par ce lot (mandat §18, littéral).
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.stuart_delivery_jobs') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.stuart_delivery_jobs existe déjà -- migration Stuart déjà appliquée, application annulée.';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'orders_id_restaurant_id_unique'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte orders_id_restaurant_id_unique (PAYMENT P1) absente.';
  end if;
end $$;

-- ============================================================
-- TABLE
--
-- CORRECTIF v2.1 (STUART-V2-STATUS-FORWARD-COMPATIBILITY-01, HIGH) :
-- chaque domaine de statut est désormais scindé en une colonne RAW
-- (texte libre, JAMAIS rejetée pour une valeur future inconnue --
-- "no provider-state evidence is discarded") et une colonne KNOWN
-- (nullable, alignée sur le vocabulaire officiel actuellement connu
-- UNIQUEMENT si la valeur RAW y correspond exactement -- NULL
-- signifie explicitement "statut reçu mais non reconnu", JAMAIS
-- interprété comme "delivered" ni aucun autre état positif).
--
-- CORRECTIF v2.1 (STUART-V2-CORRELATION-INTEGRITY-01, HIGH) :
-- `stuart_job_id` devient IMMUABLE après sa première affectation --
-- voir la contrainte de trigger plus bas (jamais un simple CHECK,
-- qui ne peut pas comparer OLD/NEW).
-- ============================================================
create table public.stuart_delivery_jobs (
  id                    uuid primary key default gen_random_uuid(),

  restaurant_id         uuid not null references public.restaurants(id) on delete restrict,
  order_id              uuid not null,

  environment           text not null
                        check (environment in ('sandbox', 'production')),

  client_reference      text not null
                        check (length(client_reference) between 1 and 10)
                        check (client_reference ~ '^[0-9A-Za-z][0-9A-Za-z_-]*$'),

  -- CORRECTIF v2.1 (STUART-V2-CORRELATION-INTEGRITY-01) : NULL tant
  -- que non assigné, puis IMMUABLE (trigger dédié, voir plus bas).
  stuart_job_id         text
                        check (stuart_job_id is null or length(stuart_job_id) <= 100),

  -- CORRECTIF v2.1 (STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01, HIGH) :
  -- cycle de vie d'envoi durable, distinct du statut Stuart lui-même.
  -- `allocated` : ligne créée, aucun envoi tenté. `send_started` :
  -- persisté AVANT le POST réseau (mandat §13, "persist send_started
  -- BEFORE provider POST"). `send_ambiguous` : timeout/erreur réseau
  -- après l'envoi -- BLOQUE tout nouvel envoi automatique tant que
  -- cet état n'a pas été résolu manuellement (aucune réconciliation
  -- officielle confirmée, mandat §3). `created_confirmed` : réponse
  -- positive VALIDÉE reçue (implique stuart_job_id non NULL, voir
  -- contrainte plus bas). `terminal_failure` : réponse prouvant
  -- explicitement qu'AUCUN job n'a été créé (jamais une erreur
  -- réseau, qui reste `send_ambiguous`).
  send_state            text not null default 'allocated'
                        check (send_state in ('allocated', 'send_started', 'send_ambiguous', 'created_confirmed', 'terminal_failure')),

  -- Statuts Job -- RAW jamais rejeté, KNOWN nullable.
  job_status_raw        text
                        check (job_status_raw is null or length(job_status_raw) <= 60),
  job_status_known      text
                        check (job_status_known is null or job_status_known in
                          ('new','scheduled','searching','in_progress','finished','canceled','expired')),

  -- Statuts Delivery.
  delivery_status_raw   text
                        check (delivery_status_raw is null or length(delivery_status_raw) <= 60),
  delivery_status_known text
                        check (delivery_status_known is null or delivery_status_known in
                          ('pending','picking','almost_picking','waiting_at_pickup','delivering',
                           'almost_delivering','waiting_at_dropoff','delivered','cancelled')),

  -- Statuts Package.
  package_status_raw    text
                        check (package_status_raw is null or length(package_status_raw) <= 60),
  package_status_known  text
                        check (package_status_known is null or package_status_known in
                          ('package_created','courier_assigned','courier_arriving_at_pickup',
                           'courier_waiting_at_pickup','package_delivering','courier_arriving_at_dropoff',
                           'courier_waiting_at_dropoff','package_delivered','package_canceled')),

  is_active             boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_provider_sync_at timestamptz,

  constraint stuart_delivery_jobs_order_restaurant_fk
    foreign key (order_id, restaurant_id) references public.orders(id, restaurant_id) on delete restrict,

  -- CORRECTIF v2.1 (STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01) :
  -- `created_confirmed` DOIT avoir un `stuart_job_id` -- jamais un
  -- état "confirmé" sans identifiant de job réel.
  constraint stuart_delivery_jobs_confirmed_requires_job_id
    check (send_state != 'created_confirmed' or stuart_job_id is not null),

  -- Cohérence RAW/KNOWN : KNOWN ne peut être renseigné QUE si RAW
  -- l'est également (jamais une classification sans preuve brute
  -- sous-jacente).
  constraint stuart_delivery_jobs_job_status_pair
    check (job_status_known is null or job_status_raw is not null),
  constraint stuart_delivery_jobs_delivery_status_pair
    check (delivery_status_known is null or delivery_status_raw is not null),
  constraint stuart_delivery_jobs_package_status_pair
    check (package_status_known is null or package_status_raw is not null)
);

-- INVARIANT 1 (idempotence) : une seule tentative active par commande.
create unique index stuart_delivery_jobs_one_active_per_order
  on public.stuart_delivery_jobs(order_id)
  where is_active;

-- INVARIANT 2 (contrat Stuart, portée provider/environment).
create unique index stuart_delivery_jobs_unique_active_client_reference
  on public.stuart_delivery_jobs(environment, client_reference)
  where is_active;

-- CORRECTIF v2.1 (STUART-V2-CORRELATION-INTEGRITY-01, HIGH) :
-- unicité de `stuart_job_id` PAR ENVIRONNEMENT, pour les valeurs non
-- NULL uniquement -- un même identifiant de job Stuart ne peut être
-- attribué qu'à UNE SEULE ligne de corrélation Scanym.
create unique index stuart_delivery_jobs_unique_provider_job_id
  on public.stuart_delivery_jobs(environment, stuart_job_id)
  where stuart_job_id is not null;

create index idx_stuart_delivery_jobs_restaurant
  on public.stuart_delivery_jobs(restaurant_id, created_at desc);

-- ============================================================
-- CORRECTIF v2.1 (STUART-V2-CORRELATION-INTEGRITY-01, HIGH) :
-- IMMUTABILITÉ de `stuart_job_id` après première affectation --
-- JAMAIS un simple CHECK (ne peut comparer OLD/NEW), un TRIGGER
-- dédié. Règles exactes (mandat §7, littéral) :
--   NULL -> JOB123 : autorisé (première affectation)
--   JOB123 -> JOB123 : autorisé (rejeu idempotent)
--   JOB123 -> JOB456 : REJETÉ
-- ============================================================
create function public.stuart_delivery_jobs_enforce_job_id_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.stuart_job_id is not null
     and new.stuart_job_id is not null
     and old.stuart_job_id != new.stuart_job_id then
    raise exception 'SCANYM_STUART: stuart_job_id est immuable après première affectation (ancien=%, nouveau=%)', old.stuart_job_id, new.stuart_job_id using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_stuart_delivery_jobs_job_id_immutable
  before update on public.stuart_delivery_jobs
  for each row
  execute function public.stuart_delivery_jobs_enforce_job_id_immutability();

comment on table public.stuart_delivery_jobs is
  'DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.1. Corrélation durable Stuart, JAMAIS l''autorité de statut de commande ni de paiement. RLS activée + REVOKE ALL explicite -- posture RPC-only stricte, AUCUN accès direct même pour service_role. stuart_job_id immuable après première affectation (trigger dédié). Statuts RAW jamais rejetés (compatibilité future), classification KNOWN nullable.';

-- ============================================================
-- CORRECTIF v2.1 (STUART-V2-TABLE-SECURITY-01, HIGH) : RLS + REVOKE
-- explicite en COUCHES -- REVOKE ALL (même patron strict que
-- payment_transactions, PAYMENT P1, PAY-P1-03) ET RLS activée SANS
-- AUCUNE POLICY (deny-all par défaut) en défense supplémentaire
-- explicitement exigée par le mandat au-delà du patron établi.
-- ============================================================
alter table public.stuart_delivery_jobs enable row level security;
revoke all on table public.stuart_delivery_jobs from public, anon, authenticated, service_role;

-- ============================================================
-- RPC — allocate_stuart_delivery_job v2.1
--
-- CORRECTIF v2.1 (STUART-V2-PGCRYPTO-QUALIFICATION-01, HIGH) :
-- AUCUNE dépendance pgcrypto/digest -- `pgcrypto` n'est PAS prouvée
-- active sur le projet Supabase réel (schema.sql commente
-- explicitement sa création). Même décision déjà actée pour
-- `payment_provider_events` (P3B5) : tout calcul de hachage reste à
-- la charge du code serveur Node de confiance (déjà établi,
-- lib/server/payment-providers/monetico/{reference,mac}.ts) --
-- AVANT l'appel RPC, jamais recalculé côté SQL.
--
-- CORRECTIF v2.1 (STUART-V2-ALLOCATION-CONCURRENCY-01, HIGH) :
-- `pg_advisory_xact_lock` scopé à `order_id` -- SÉRIALISE tous les
-- appels concurrents pour LA MÊME commande (verrou automatiquement
-- libéré à la fin de la transaction, jamais orphelin même en cas de
-- crash serveur). Deux appels simultanés pour la MÊME commande ne
-- peuvent plus jamais s'exécuter en parallèle -- le second attend la
-- fin du premier, puis voit sa ligne déjà créée via le contrôle
-- d'idempotence (aucune fenêtre de course résiduelle).
--
-- SÉMANTIQUE DE COLLISION (mandat §4, "Do NOT treat every
-- unique_violation as client_reference collision") : la fonction
-- distingue explicitement, via `GET STACKED DIAGNOSTICS ...
-- CONSTRAINT_NAME`, la violation de l'index d'unicité de
-- client_reference (collision RÉELLE, retournée à l'appelant qui
-- doit fournir une NOUVELLE candidate calculée côté Node -- AUCUNE
-- boucle de retry interne côté SQL) de toute autre violation
-- inattendue (jamais absorbée silencieusement, re-levée telle quelle).
-- ============================================================
create function public.allocate_stuart_delivery_job(
  p_order_id uuid,
  p_restaurant_id uuid,
  p_environment text,
  p_candidate_reference text
)
returns table (
  id uuid,
  client_reference text,
  is_new_allocation boolean,
  collision boolean,
  send_state text,
  stuart_job_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_new_id uuid;
  v_constraint text;
begin
  if p_environment not in ('sandbox', 'production') then
    raise exception 'SCANYM_STUART: environnement invalide' using errcode = '22023';
  end if;
  if p_candidate_reference is null or length(btrim(p_candidate_reference)) = 0 then
    raise exception 'SCANYM_STUART: référence candidate requise' using errcode = '22004';
  end if;

  -- SÉRIALISATION (mandat §4) : verrou consultatif scopé à la
  -- commande -- toute la suite de cette fonction s'exécute pour CETTE
  -- commande de façon strictement séquentielle entre transactions
  -- concurrentes.
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));

  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.restaurant_id = p_restaurant_id
  ) then
    raise exception 'SCANYM_STUART: commande introuvable pour ce restaurant (isolation tenant)' using errcode = '42501';
  end if;

  -- IDEMPOTENCE (désormais race-free grâce au verrou ci-dessus).
  select s.id, s.client_reference, s.send_state, s.stuart_job_id into v_existing
  from public.stuart_delivery_jobs s
  where s.order_id = p_order_id and s.is_active and s.environment = p_environment;

  if found then
    return query select v_existing.id, v_existing.client_reference, false, false, v_existing.send_state, v_existing.stuart_job_id;
    return;
  end if;

  if exists (
    select 1 from public.stuart_delivery_jobs s
    where s.order_id = p_order_id and s.is_active
  ) then
    raise exception 'SCANYM_STUART: une tentative de livraison Stuart active existe déjà pour cette commande dans un autre environnement' using errcode = '42501';
  end if;

  -- TENTATIVE UNIQUE (mandat §2 littéral : "perform exactly one
  -- provider request" s'applique de façon analogue ici -- une seule
  -- tentative d'INSERT par appel RPC, jamais de boucle interne).
  begin
    insert into public.stuart_delivery_jobs (restaurant_id, order_id, environment, client_reference)
    values (p_restaurant_id, p_order_id, p_environment, p_candidate_reference)
    returning stuart_delivery_jobs.id into v_new_id;

    return query select v_new_id, p_candidate_reference, true, false, 'allocated'::text, null::text;
    return;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'stuart_delivery_jobs_unique_active_client_reference' then
        -- Collision RÉELLE -- signalée à l'appelant, JAMAIS résolue
        -- ici (aucune dépendance pgcrypto, aucune boucle SQL).
        return query select null::uuid, null::text, false, true, null::text, null::text;
        return;
      elsif v_constraint = 'stuart_delivery_jobs_one_active_per_order' then
        -- Ne devrait structurellement plus se produire grâce au
        -- verrou consultatif -- filet de sécurité défensif
        -- uniquement : re-lit et retourne la ligne existante plutôt
        -- que de faire échouer l'appelant.
        select s.id, s.client_reference, s.send_state, s.stuart_job_id into v_existing
        from public.stuart_delivery_jobs s
        where s.order_id = p_order_id and s.is_active and s.environment = p_environment;
        if found then
          return query select v_existing.id, v_existing.client_reference, false, false, v_existing.send_state, v_existing.stuart_job_id;
          return;
        end if;
        raise;
      else
        raise;
      end if;
  end;
end;
$$;

comment on function public.allocate_stuart_delivery_job(uuid, uuid, text, text) is
  'SECURITY DEFINER, aucun rôle applicatif -- appelé uniquement via getServiceRoleSupabaseClient() avec la clé service_role (dont l''EXECUTE est explicitement accordé ci-dessous). Verrou consultatif par commande (sérialisation concurrente), aucune dépendance pgcrypto, distingue explicitement collision de client_reference (retournée à l''appelant pour nouvelle tentative) des autres violations (jamais absorbées).';

revoke all on function public.allocate_stuart_delivery_job(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.allocate_stuart_delivery_job(uuid, uuid, text, text) to service_role;

-- ============================================================
-- RPC — mark_stuart_delivery_job_send_started
--
-- CORRECTIF v2.1 (STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01,
-- STUART-V2-CREATE-JOB-ALLOCATION-COUPLING-01) : persiste
-- `send_started` AVANT tout appel réseau Stuart -- appelée par
-- l'orchestration TypeScript, JAMAIS directement par un appelant
-- externe à la fondation.
--
-- Bornée à `possession` (mandat §7) : requiert order_id/restaurant_id
-- en plus de id -- jamais une mutation par UUID seul.
-- ============================================================
create function public.mark_stuart_delivery_job_send_started(
  p_id uuid,
  p_order_id uuid,
  p_restaurant_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stuart_delivery_jobs
  set send_state = 'send_started',
      updated_at = now()
  where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id
    and send_state = 'allocated';

  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable, possession invalide, ou transition invalide (attendu depuis allocated)' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.mark_stuart_delivery_job_send_started(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_stuart_delivery_job_send_started(uuid, uuid, uuid) to service_role;

-- ============================================================
-- RPC — mark_stuart_delivery_job_ambiguous
--
-- CORRECTIF v2.1 (STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01) :
-- transition send_started -> send_ambiguous UNIQUEMENT -- jamais
-- depuis un autre état (fail-closed structurel sur la séquence).
-- ============================================================
create function public.mark_stuart_delivery_job_ambiguous(
  p_id uuid,
  p_order_id uuid,
  p_restaurant_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stuart_delivery_jobs
  set send_state = 'send_ambiguous',
      updated_at = now()
  where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id
    and send_state = 'send_started';

  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable, possession invalide, ou transition invalide (attendu depuis send_started)' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.mark_stuart_delivery_job_ambiguous(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_stuart_delivery_job_ambiguous(uuid, uuid, uuid) to service_role;

-- ============================================================
-- RPC — confirm_stuart_delivery_job_created
--
-- CORRECTIF v2.1 : transition send_started -> created_confirmed,
-- EXIGE stuart_job_id non NULL (contrainte de table déjà fail-closed
-- sur ce point). Immutabilité de stuart_job_id appliquée par le
-- trigger dédié -- un rejeu avec le MÊME job_id est idempotent
-- (autorisé), un job_id DIFFÉRENT est REJETÉ par le trigger.
-- ============================================================
create function public.confirm_stuart_delivery_job_created(
  p_id uuid,
  p_order_id uuid,
  p_restaurant_id uuid,
  p_stuart_job_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_stuart_job_id is null or length(btrim(p_stuart_job_id)) = 0 then
    raise exception 'SCANYM_STUART: stuart_job_id requis pour confirmer la création' using errcode = '22004';
  end if;

  update public.stuart_delivery_jobs
  set send_state = 'created_confirmed',
      stuart_job_id = p_stuart_job_id,
      updated_at = now(),
      last_provider_sync_at = now()
  where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id
    and send_state in ('send_started', 'send_ambiguous', 'created_confirmed');

  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable, possession invalide, ou transition invalide' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.confirm_stuart_delivery_job_created(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_stuart_delivery_job_created(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- RPC — mark_stuart_delivery_job_terminal_failure
--
-- UNIQUEMENT pour une réponse PROUVANT explicitement qu'aucun job
-- n'a été créé (mandat §12, "only for provider response proving no
-- job was created") -- JAMAIS pour une erreur réseau (qui reste
-- send_ambiguous).
-- ============================================================
create function public.mark_stuart_delivery_job_terminal_failure(
  p_id uuid,
  p_order_id uuid,
  p_restaurant_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stuart_delivery_jobs
  set send_state = 'terminal_failure',
      updated_at = now()
  where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id
    and send_state in ('send_started', 'send_ambiguous');

  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable, possession invalide, ou transition invalide' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.mark_stuart_delivery_job_terminal_failure(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_stuart_delivery_job_terminal_failure(uuid, uuid, uuid) to service_role;

-- ============================================================
-- RPC — update_stuart_delivery_job_status v2.1
--
-- CORRECTIF v2.1 (forward-compat + possession) : accepte les valeurs
-- RAW (jamais rejetées) et dérive automatiquement KNOWN si la valeur
-- correspond au vocabulaire officiel actuel -- sinon KNOWN reste
-- NULL explicitement (jamais interprété comme "delivered").
-- Bornée à possession (order_id/restaurant_id), même patron que les
-- fonctions de transition ci-dessus.
-- ============================================================
create function public.update_stuart_delivery_job_status(
  p_id uuid,
  p_order_id uuid,
  p_restaurant_id uuid,
  p_job_status_raw text default null,
  p_delivery_status_raw text default null,
  p_package_status_raw text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_known text;
  v_delivery_known text;
  v_package_known text;
begin
  v_job_known := case when p_job_status_raw in
    ('new','scheduled','searching','in_progress','finished','canceled','expired')
    then p_job_status_raw else null end;
  v_delivery_known := case when p_delivery_status_raw in
    ('pending','picking','almost_picking','waiting_at_pickup','delivering',
     'almost_delivering','waiting_at_dropoff','delivered','cancelled')
    then p_delivery_status_raw else null end;
  v_package_known := case when p_package_status_raw in
    ('package_created','courier_assigned','courier_arriving_at_pickup',
     'courier_waiting_at_pickup','package_delivering','courier_arriving_at_dropoff',
     'courier_waiting_at_dropoff','package_delivered','package_canceled')
    then p_package_status_raw else null end;

  update public.stuart_delivery_jobs
  set job_status_raw        = coalesce(p_job_status_raw, stuart_delivery_jobs.job_status_raw),
      job_status_known      = case when p_job_status_raw is not null then v_job_known else stuart_delivery_jobs.job_status_known end,
      delivery_status_raw   = coalesce(p_delivery_status_raw, stuart_delivery_jobs.delivery_status_raw),
      delivery_status_known = case when p_delivery_status_raw is not null then v_delivery_known else stuart_delivery_jobs.delivery_status_known end,
      package_status_raw    = coalesce(p_package_status_raw, stuart_delivery_jobs.package_status_raw),
      package_status_known  = case when p_package_status_raw is not null then v_package_known else stuart_delivery_jobs.package_status_known end,
      updated_at            = now(),
      last_provider_sync_at = now()
  where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id;

  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable ou possession invalide' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_stuart_delivery_job_status(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.update_stuart_delivery_job_status(uuid, uuid, uuid, text, text, text) to service_role;

-- ============================================================
-- POSTCHECKS DÉTERMINISTES
-- ============================================================
do $$
declare
  v_priv boolean;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'stuart_delivery_jobs' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- RLS non activée sur stuart_delivery_jobs' using errcode = '55000';
  end if;

  foreach v_priv in array array[
    has_table_privilege('anon', 'public.stuart_delivery_jobs', 'select'),
    has_table_privilege('anon', 'public.stuart_delivery_jobs', 'insert'),
    has_table_privilege('anon', 'public.stuart_delivery_jobs', 'update'),
    has_table_privilege('anon', 'public.stuart_delivery_jobs', 'delete'),
    has_table_privilege('authenticated', 'public.stuart_delivery_jobs', 'select'),
    has_table_privilege('authenticated', 'public.stuart_delivery_jobs', 'insert'),
    has_table_privilege('authenticated', 'public.stuart_delivery_jobs', 'update'),
    has_table_privilege('authenticated', 'public.stuart_delivery_jobs', 'delete'),
    has_table_privilege('service_role', 'public.stuart_delivery_jobs', 'select'),
    has_table_privilege('service_role', 'public.stuart_delivery_jobs', 'insert'),
    has_table_privilege('service_role', 'public.stuart_delivery_jobs', 'update'),
    has_table_privilege('service_role', 'public.stuart_delivery_jobs', 'delete')
  ]
  loop
    if v_priv then
      raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- un rôle applicatif dispose d''un privilège direct inattendu sur stuart_delivery_jobs' using errcode = '55000';
    end if;
  end loop;

  if has_function_privilege('anon', 'public.allocate_stuart_delivery_job(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.allocate_stuart_delivery_job(uuid,uuid,text,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur allocate_stuart_delivery_job' using errcode = '55000';
  end if;
end $$;

commit;
