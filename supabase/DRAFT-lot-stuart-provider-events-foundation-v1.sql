-- ============================================================
-- Scanym — STUART LOT D1 — POST-PAYMENT ORCHESTRATION + CRASH
-- RECOVERY + WEBHOOK INBOX FOUNDATION.
-- PHASE 1 IMPLEMENTATION AUTHORIZATION (CIO/CTO). MOCK/FIXTURE
-- ONLY -- AUCUN appel Stuart réel n'est autorisé par ce lot.
-- Claude développe, teste et package. Claude ne pousse pas, ne
-- merge pas, ne déploie pas et ne touche pas à Production sans
-- autorisation explicite. Ce fichier n'est JAMAIS exécuté en
-- Production par ce lot.
--
-- PÉRIMÈTRE (mandat D1 §A/§C/§D/§G) :
--   1. get_stuart_delivery_eligibility -- autorité d'éligibilité
--      livraison SERVEUR ÉTROITE, lecture pure, fail-closed,
--      réutilisant EXCLUSIVEMENT des signaux autoritatifs déjà
--      existants (orders.payment_status, orders.status,
--      restaurants.is_active, delivery_provider_configs,
--      restaurant_sale_modes/restaurant_sale_mode_fulfillments).
--      N'INVENTE aucune deuxième autorité de paiement. N'utilise
--      JAMAIS de credential Stuart global.
--   2. stuart_provider_events -- inbox durable GÉNÉRIQUE, modelée
--      sur payment_provider_events (PAYMENT P3-B5 v2,
--      supabase/DRAFT-lot-payment-p3b5-durable-provider-callback-
--      inbox.sql, lu intégralement avant d'écrire ce fichier) --
--      MÊME posture RPC-only stricte (RLS + REVOKE ALL, y compris
--      service_role sur la table elle-même), MÊME primitif de
--      revendication/bail `FOR UPDATE SKIP LOCKED`
--      (claim_stuart_provider_events), MÊME machine à états de
--      traitement à verrouillage terminal
--      (update_stuart_provider_event_processing_status). DIFFÈRE
--      DÉLIBÉRÉMENT sur un point structurel (mandat D1 §D,
--      "UNKNOWN JOB / EARLY WEBHOOK") : la corrélation vers
--      stuart_delivery_jobs est TOUJOURS NULLABLE -- un évènement
--      prestataire peut arriver AVANT que la corrélation locale ne
--      soit résolvable (job pas encore créé/confirmé localement,
--      ordonnancement inattendu) ; ce lot DOIT persister l'évènement
--      quand même, jamais renvoyer une erreur 500 pour ce seul motif.
--   3. Extensions ÉTROITES de stuart_delivery_jobs (mandat D1 §C/§G,
--      "do NOT redesign... core identity/idempotency model") :
--        - reap_stale_stuart_delivery_job_send_started -- ferme le
--          gap PHASE 0 (crash entre mark_stuart_delivery_job_
--          send_started et la confirmation/l'ambiguïté -- ligne
--          bloquée définitivement à send_started, aucune reprise
--          existante). Réutilise EXACTEMENT la même transition que
--          mark_stuart_delivery_job_ambiguous (send_started ->
--          send_ambiguous, déjà existante et déjà la sémantique
--          "issue distante inconnue, ne jamais renvoyer
--          aveuglément") -- AUCUN nouvel état n'est introduit,
--          AUCUNE tentative de renvoi HTTP n'est effectuée ici (ce
--          RPC ne fait qu'un balayage/une transition SQL). Sûr sous
--          plusieurs workers concurrents via `FOR UPDATE SKIP
--          LOCKED`, jamais de verrou global restaurant, jamais de
--          boucle chaude (appel BORNÉ, un seul balayage par appel).
--        - deux colonnes ADDITIVES (`requires_local_cancellation`,
--          `local_cancellation_requested_at`) + un RPC dédié
--          (record_stuart_delivery_job_local_cancellation) pour le
--          §G CANCELLATION -- état LOCAL uniquement ("commande
--          annulée après allocation/création du job, réconciliation
--          prestataire requise plus tard"), JAMAIS un appel Stuart
--          réel d'annulation (non autorisé en D1). N'altère NI
--          send_state NI stuart_job_id -- ORTHOGONAL au cycle de vie
--          d'envoi existant, aucune régression sur celui-ci.
--
-- RECONNAISSANCE PRÉALABLE (source réelle de ce baseline, jamais
-- supposée) :
--   - public.stuart_delivery_jobs / ses 6 RPC (allocate_stuart_
--     delivery_job, mark_stuart_delivery_job_send_started, mark_
--     stuart_delivery_job_ambiguous, confirm_stuart_delivery_job_
--     created, mark_stuart_delivery_job_terminal_failure, update_
--     stuart_delivery_job_status) proviennent de supabase/DRAFT-lot-
--     stuart-sandbox-integration-v2-1.sql -- INCHANGÉ par ce fichier,
--     seules des fonctions et colonnes STRICTEMENT NOUVELLES sont
--     ajoutées.
--   - public.orders.payment_status (P1) est la SEULE autorité de
--     paiement confirmé -- valeurs 'not_required'|'pending'|'paid'|
--     'failed'|'cancelled'. Ce lot ne lit JAMAIS payment_transactions
--     directement (hors périmètre, non nécessaire -- orders.
--     payment_status='paid' suffit et est déjà la projection
--     autoritative posée par confirm_payment_attempt, P1, inchangé).
--   - public.orders.status (valeurs 'new'|'accepted'|'preparing'|
--     'ready'|'served'|'cancelled') est la SEULE autorité de cycle de
--     vie opérationnel de la commande -- 'cancelled' rend une
--     commande inéligible, quel que soit payment_status.
--   - public.restaurants.is_active (boolean) est la SEULE autorité
--     d'activation d'un établissement.
--   - public.delivery_provider_configs (LOT A-0/STUART LOT A) porte
--     `mode`/`configuration_status` -- posture crédential UNIQUEMENT,
--     jamais l'activation métier (voir constat Phase 0 : ces deux
--     systèmes ne sont aujourd'hui JAMAIS joints nulle part).
--   - public.restaurant_sale_modes (LOT 2A) porte `enabled`/
--     `provider` pour mode_code='delivery' -- l'AUTORITÉ business de
--     routage/activation de la livraison. `provider` in ('internal',
--     'stuart','chronofresh','other_external').
--   - public.restaurant_sale_mode_fulfillments (LOT fulfillment
--     routing model) est CONFIRMÉ VIDE pour tout tenant à ce jour
--     (documenté dans 3 fichiers de migration distincts) -- ce lot ne
--     le suppose PAS peuplé ; son absence de ligne active pour un
--     couple (restaurant_id, 'delivery') donné est un motif
--     d'inéligibilité EXPLICITE et déterministe (reason_code dédié),
--     jamais une exception non gérée ni un repli permissif.
--   - Aucune colonne orders.provider_code/fulfillment_code/
--     fulfillment_rule_id n'est référencée par ce lot -- ces colonnes
--     appartiennent à DRAFT-lot-server-delivery-fulfillment-pricing.sql
--     (LOT B), qui dépend lui-même de resolve_delivery_fulfillment
--     (LOT B.1, hors périmètre de ce baseline D1 -- non appliqué,
--     non requis par le mandat D1 §A qui liste explicitement les
--     signaux à utiliser, aucun d'eux n'étant orders.provider_code).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.stuart_delivery_jobs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.stuart_delivery_jobs introuvable -- prérequis STUART SANDBOX INTEGRATION v2.1 manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stuart_delivery_jobs'
      and column_name in ('id','restaurant_id','order_id','send_state','stuart_job_id','is_active')
    having count(*) = 6
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.stuart_delivery_jobs -- prérequis incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mark_stuart_delivery_job_ambiguous'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.mark_stuart_delivery_job_ambiguous introuvable -- prérequis STUART SANDBOX INTEGRATION v2.1 manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','restaurant_id','status','service_mode','payment_status',
                           'delivery_address','delivery_zone','customer_phone')
    having count(*) = 8
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders (payment_status -- prérequis PAYMENT P1 -- ou colonnes de base) -- migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'u'
      and conname = 'orders_id_restaurant_id_unique'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte unique orders_id_restaurant_id_unique introuvable -- prérequis PAYMENT P1 manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurants' and column_name = 'is_active'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurants.is_active introuvable -- prérequis schéma canonique manquant, migration annulée.';
  end if;

  if to_regclass('public.delivery_provider_configs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.delivery_provider_configs introuvable -- prérequis LOT A-0 manquant, migration annulée.';
  end if;

  if to_regclass('public.restaurant_sale_modes') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_modes introuvable -- prérequis LOT 2A manquant, migration annulée.';
  end if;

  if to_regclass('public.restaurant_sale_mode_fulfillments') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_mode_fulfillments introuvable -- prérequis fulfillment routing model manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_sale_mode_fulfillments'
      and column_name in ('restaurant_id','mode_code','provider')
    having count(*) = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.restaurant_sale_mode_fulfillments -- migration annulée.';
  end if;

  -- Garde anti double-application.
  if to_regclass('public.stuart_provider_events') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.stuart_provider_events existe déjà -- STUART LOT D1 déjà appliqué, migration annulée (double application refusée).';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_stuart_delivery_eligibility'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_stuart_delivery_eligibility existe déjà -- STUART LOT D1 déjà appliqué, migration annulée (double application refusée).';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stuart_delivery_jobs'
      and column_name = 'requires_local_cancellation'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.stuart_delivery_jobs.requires_local_cancellation existe déjà -- STUART LOT D1 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. get_stuart_delivery_eligibility — autorité d'éligibilité
-- livraison Stuart, SECURITY DEFINER, service_role UNIQUEMENT
-- (mandat D1 §A).
--
-- FAIL CLOSED : chaque vérification est une clause AND indépendante
-- -- la moindre condition non satisfaite renvoie eligible=false avec
-- UN reason_code déterministe (le PREMIER motif rencontré dans
-- l'ordre ci-dessous, jamais une liste -- un appelant qui veut
-- diagnostiquer plusieurs motifs simultanés doit itérer après avoir
-- corrigé le premier, mandat D1 §A "Return deterministic reason
-- codes for ineligibility"). AUCUNE mutation, AUCUN verrou --
-- lecture pure, STABLE.
--
-- N'INVENTE JAMAIS une deuxième autorité de paiement (mandat D1 §A) :
-- la SEULE vérification de paiement est orders.payment_status =
-- 'paid' (P1, inchangé) -- ce RPC ne lit ni ne suppose jamais
-- payment_transactions.status directement.
--
-- N'UTILISE JAMAIS de credential Stuart global (mandat D1 §I) : ce
-- RPC ne lit QUE delivery_provider_configs.mode/configuration_status
-- (métadonnées, jamais le secret Vault) -- il ne résout et ne
-- retourne AUCUN secret.
-- ------------------------------------------------------------
create function public.get_stuart_delivery_eligibility(
  p_order_id uuid,
  p_restaurant_id uuid
)
returns table (
  eligible boolean,
  reason_code text
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
    return query select false, 'INVALID_INPUT'::text;
    return;
  end if;

  -- 1. La commande existe ET appartient réellement à ce restaurant
  -- (isolation tenant STRUCTURELLE -- jamais un order_id seul).
  select o.id, o.restaurant_id, o.status, o.service_mode, o.payment_status,
         o.delivery_address, o.delivery_zone, o.customer_phone
    into v_order
    from public.orders o
    where o.id = p_order_id and o.restaurant_id = p_restaurant_id;
  if not found then
    return query select false, 'ORDER_NOT_FOUND'::text;
    return;
  end if;

  -- 2. Le restaurant est actif.
  select r.id, r.is_active into v_restaurant
    from public.restaurants r
    where r.id = p_restaurant_id;
  if not found or v_restaurant.is_active is not true then
    return query select false, 'RESTAURANT_INACTIVE'::text;
    return;
  end if;

  -- 3. La commande n'est pas annulée (autorité orders.status, P1
  -- inchangé -- jamais payment_status seul).
  if v_order.status = 'cancelled' then
    return query select false, 'ORDER_CANCELLED'::text;
    return;
  end if;

  -- 4. Paiement CONFIRMÉ -- SEULE autorité : orders.payment_status =
  -- 'paid'. Jamais une deuxième autorité de paiement inventée.
  if v_order.payment_status is distinct from 'paid' then
    return query select false, 'PAYMENT_NOT_CONFIRMED'::text;
    return;
  end if;

  -- 5. Mode de service compatible livraison.
  if v_order.service_mode is distinct from 'delivery' then
    return query select false, 'FULFILLMENT_MODE_NOT_DELIVERY'::text;
    return;
  end if;

  -- 6. Données d'adresse/contact requises déjà exigées par le modèle
  -- existant (orders_mode_fields, migration-orders.sql) pour
  -- service_mode='delivery' -- revérifié ici en défense en profondeur
  -- (jamais supposé silencieusement).
  if v_order.delivery_address is null or v_order.customer_phone is null then
    return query select false, 'DELIVERY_CONTACT_DATA_MISSING'::text;
    return;
  end if;

  -- 7. Mode de vente 'delivery' activé pour ce marchand ET routé vers
  -- Stuart (public.restaurant_sale_modes -- autorité business de
  -- routage/activation, LOT 2A).
  select rsm.enabled, rsm.provider into v_sale_mode
    from public.restaurant_sale_modes rsm
    where rsm.restaurant_id = p_restaurant_id and rsm.mode_code = 'delivery';
  if not found or v_sale_mode.enabled is not true then
    return query select false, 'DELIVERY_MODE_NOT_ENABLED'::text;
    return;
  end if;
  if v_sale_mode.provider is distinct from 'stuart' then
    return query select false, 'DELIVERY_PROVIDER_NOT_STUART'::text;
    return;
  end if;

  -- 8. Au moins une règle de routage fulfillment active existe pour
  -- ce couple (restaurant_id, 'delivery') avec provider='stuart'
  -- (public.restaurant_sale_mode_fulfillments -- signal de routage
  -- fin, JOINT au signal ci-dessus per mandat D1 §A "join both
  -- signals"). Table confirmée vide pour tout tenant réel à ce jour
  -- (constat Phase 0) -- absence de ligne est un motif
  -- d'inéligibilité EXPLICITE, jamais un repli permissif sur le
  -- signal #7 seul.
  select count(*) into v_fulfillment_count
    from public.restaurant_sale_mode_fulfillments f
    where f.restaurant_id = p_restaurant_id
      and f.mode_code = 'delivery'
      and f.provider = 'stuart';
  if v_fulfillment_count = 0 then
    return query select false, 'NO_ACTIVE_STUART_FULFILLMENT_RULE'::text;
    return;
  end if;

  -- 9. Configuration credential Stuart du marchand suffisamment
  -- avancée (delivery_provider_configs -- métadonnées UNIQUEMENT,
  -- JAMAIS le secret Vault, jamais un fallback global -- mandat D1
  -- §I).
  select dpc.mode, dpc.configuration_status into v_stuart_config
    from public.delivery_provider_configs dpc
    where dpc.restaurant_id = p_restaurant_id and dpc.provider_code = 'stuart';
  if not found then
    return query select false, 'STUART_CREDENTIAL_NOT_CONFIGURED'::text;
    return;
  end if;
  if v_stuart_config.configuration_status not in ('configured', 'verified') then
    return query select false, 'STUART_CREDENTIAL_NOT_CONFIGURED'::text;
    return;
  end if;

  -- 10. Aucune ligne stuart_delivery_jobs ACTIVE incompatible
  -- n'existe déjà pour cette commande dans un état terminal
  -- d'échec/annulation locale qui interdirait une nouvelle
  -- allocation implicite -- lecture seule, ne mute rien ; renvoie un
  -- motif informatif distinct plutôt que de laisser l'appelant croire
  -- qu'aucune tentative n'a jamais existé.
  if exists (
    select 1 from public.stuart_delivery_jobs sdj
    where sdj.order_id = p_order_id and sdj.is_active
      and sdj.send_state = 'terminal_failure'
  ) then
    return query select false, 'PRIOR_TERMINAL_FAILURE_EXISTS'::text;
    return;
  end if;

  return query select true, 'ELIGIBLE'::text;
end;
$$;

comment on function public.get_stuart_delivery_eligibility(uuid, uuid) is
  'STUART LOT D1 §A — autorité d''éligibilité livraison Stuart, lecture pure, fail-closed, service_role UNIQUEMENT. Vérifie SÉQUENTIELLEMENT (retour au premier motif rencontré) : existence+tenant de la commande, restaurant actif, commande non annulée, orders.payment_status=''paid'' (SEULE autorité de paiement, jamais une deuxième inventée), service_mode=''delivery'', données d''adresse/contact présentes, restaurant_sale_modes.enabled+provider=''stuart'' pour mode_code=''delivery'', AU MOINS une règle restaurant_sale_mode_fulfillments active provider=''stuart'' pour ce couple (JOINT au signal précédent, jamais l''un sans l''autre), delivery_provider_configs.configuration_status IN (configured,verified) pour provider_code=''stuart'' (métadonnées credential UNIQUEMENT, jamais le secret Vault, jamais un fallback global), absence de stuart_delivery_jobs.terminal_failure actif préexistant. N''ALLOUE, NE CRÉE ET N''ENVOIE RIEN -- lecture seule.';

revoke all on function public.get_stuart_delivery_eligibility(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_stuart_delivery_eligibility(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 1bis. UNIQUE(id, restaurant_id) sur stuart_delivery_jobs — ADDITION
-- ÉTROITE requise structurellement par la FK composite de la section
-- 2 ci-dessous (stuart_provider_events_job_restaurant_fk). id est
-- déjà PK (donc déjà unique seul) -- cet index unique COMPOSITE est
-- redondant en tant que garantie d'unicité mais nécessaire car
-- PostgreSQL exige que la cible d'une FK composite soit couverte par
-- une contrainte UNIQUE/PK portant EXACTEMENT ces colonnes, dans cet
-- ordre. AUCUNE colonne modifiée, AUCUNE ligne existante affectée --
-- pure ADDITION, même patron déjà établi par PAYMENT P1 (orders_id_
-- restaurant_id_unique, payment_transactions_id_order_id_unique).
-- ------------------------------------------------------------
alter table public.stuart_delivery_jobs
  add constraint stuart_delivery_jobs_id_restaurant_id_unique unique (id, restaurant_id);

-- ------------------------------------------------------------
-- 2. stuart_provider_events — inbox durable GÉNÉRIQUE, modelée sur
-- payment_provider_events (mandat D1 §D). MÊME posture RPC-only
-- stricte (RLS + REVOKE ALL, y compris service_role).
--
-- DIFFÉRENCE STRUCTURELLE délibérée par rapport à payment_provider_
-- events (mandat D1 "UNKNOWN JOB / EARLY WEBHOOK") : AUCUNE colonne
-- de corrélation n'est NOT NULL -- un évènement peut arriver AVANT
-- que stuart_job_id/stuart_delivery_job_id ne soit résolvable
-- localement. `provider_job_id_raw` (texte brut REÇU du prestataire,
-- jamais validé) est TOUJOURS stocké tel quel -- la résolution vers
-- stuart_delivery_jobs.id (`stuart_delivery_job_id`) est une
-- meilleure-effort, refaite à chaque traitement (jamais figée à la
-- réception), jamais requise pour la persistance durable elle-même.
-- ------------------------------------------------------------
create table public.stuart_provider_events (
  id                      uuid primary key default gen_random_uuid(),

  -- Corrélation MEILLEURE-EFFORT, TOUJOURS NULLABLE (mandat D1 §D,
  -- "must NOT 500 merely because job id is unknown"). Reste NULL tant
  -- qu'aucune ligne stuart_delivery_jobs correspondante n'est
  -- résolue -- une future reprise peut la renseigner rétroactivement
  -- (via update_stuart_provider_event_processing_status, jamais un
  -- second chemin d'écriture).
  stuart_delivery_job_id  uuid references public.stuart_delivery_jobs(id) on delete restrict,
  -- Dérivé de stuart_delivery_job_id UNIQUEMENT s'il est résolu (FK
  -- composite ci-dessous garantit la cohérence tenant AU NIVEAU BASE
  -- dès que les deux colonnes sont renseignées) -- sinon NULL,
  -- JAMAIS fourni de façon indépendante par l'appelant.
  restaurant_id           uuid references public.restaurants(id) on delete restrict,

  -- Identifiant de job BRUT tel que reçu du prestataire (peut être
  -- absent selon le type d'évènement) -- JAMAIS validé/normalisé ici,
  -- stocké fidèlement pour permettre une réconciliation manuelle même
  -- si la résolution automatique échoue.
  provider_job_id_raw     text
                         check (provider_job_id_raw is null or length(provider_job_id_raw) <= 100),

  -- SHA-256 complet (64 hex minuscules), calculé par l'appelant
  -- serveur de confiance à partir de la charge canonicalisée -- MÊME
  -- convention exacte que payment_provider_events.event_fingerprint.
  event_fingerprint       text not null
                         check (event_fingerprint ~ '^[0-9a-f]{64}$'),

  -- Classification GÉNÉRIQUE de l'évènement -- jamais une énumération
  -- fermée Stuart codée en dur (même convention que payment_provider_
  -- events.provider_event_type).
  provider_event_type     text not null
                         check (length(provider_event_type) between 1 and 40)
                         check (provider_event_type = btrim(provider_event_type))
                         check (provider_event_type ~ '^[a-zA-Z0-9_-]+$'),

  -- Statut brut fixture/prestataire éventuel porté par CET évènement
  -- (ex. job_status/delivery_status/package_status Stuart) -- stocké
  -- fidèlement, JAMAIS rejeté pour une valeur inconnue (mandat D1 §F,
  -- "raw value may be stored, only recognized mapped values populate
  -- normalized known status" -- la normalisation elle-même reste une
  -- responsabilité du processeur applicatif, pas de cette table).
  provider_status_raw     text
                         check (provider_status_raw is null or length(provider_status_raw) <= 60),

  processing_status       text not null default 'received'
                         check (processing_status in ('received','applied','ignored','failed_retryable','failed_terminal')),
  retry_count             integer not null default 0
                         check (retry_count >= 0),
  last_error_class        text
                         check (last_error_class is null or length(last_error_class) <= 200),

  created_at              timestamptz not null default now(),
  last_attempt_at         timestamptz,
  processed_at            timestamptz,

  claim_token             uuid,
  claimed_at              timestamptz,
  claim_expires_at        timestamptz,

  constraint stuart_provider_events_processed_at_consistency
    check ((processing_status = 'received') = (processed_at is null)),
  constraint stuart_provider_events_claim_consistency
    check ((claim_token is null) = (claimed_at is null)
       and (claim_token is null) = (claim_expires_at is null)),

  -- Corrélation job<->restaurant TOUJOURS COHÉRENTE quand les deux
  -- sont renseignées (mandat D1 §D tenant correlation) -- MAIS
  -- jamais imposée (les deux peuvent être NULL ensemble, cas
  -- "unknown job"). Une FK composite classique rejetterait NULL
  -- silencieusement (comportement standard PostgreSQL, MATCH SIMPLE)
  -- -- documenté explicitement ici plutôt que supposé.
  constraint stuart_provider_events_job_restaurant_fk
    foreign key (stuart_delivery_job_id, restaurant_id)
    references public.stuart_delivery_jobs(id, restaurant_id) on delete restrict,

  -- Idempotence de rejeu -- MÊME convention que payment_provider_
  -- events : jamais unique sur provider_job_id_raw seul (plusieurs
  -- évènements légitimes dans le temps pour le même job), idempotence
  -- portée par le fingerprint complet.
  unique (event_fingerprint)
);

create index idx_stuart_provider_events_job
  on public.stuart_provider_events(stuart_delivery_job_id)
  where stuart_delivery_job_id is not null;
create index idx_stuart_provider_events_restaurant_status
  on public.stuart_provider_events(restaurant_id, processing_status)
  where restaurant_id is not null;
create index idx_stuart_provider_events_unresolved
  on public.stuart_provider_events(created_at)
  where stuart_delivery_job_id is null;
create index idx_stuart_provider_events_claimable
  on public.stuart_provider_events(created_at)
  where processing_status in ('received', 'failed_retryable');

comment on table public.stuart_provider_events is
  'STUART LOT D1 §D — inbox durable GÉNÉRIQUE d''évènements prestataire Stuart, modelée sur payment_provider_events (PAYMENT P3-B5 v2). AUCUNE vérification de signature ici (adaptateur d''authentification hors périmètre D1, voir mandat §E) -- fait confiance à l''appelant serveur. Corrélation vers stuart_delivery_jobs TOUJOURS NULLABLE (cas "unknown job"/évènement précoce, mandat §D) -- ne jamais échouer la persistance pour ce seul motif. AUCUN accès direct (SELECT/INSERT/UPDATE/DELETE) à quelque rôle applicatif que ce soit, y compris service_role -- posture RPC-only stricte, même patron que payment_provider_events/stuart_delivery_jobs.';

alter table public.stuart_provider_events enable row level security;
revoke all on table public.stuart_provider_events from anon, authenticated, service_role, public;

-- ------------------------------------------------------------
-- 3. record_stuart_provider_event — SEULE autorité d'ÉCRITURE
-- initiale, SECURITY DEFINER, service_role UNIQUEMENT.
--
-- CORRÉLATION MEILLEURE-EFFORT (mandat D1 §D) : si
-- p_provider_job_id_raw correspond EXACTEMENT (après btrim) à un
-- stuart_delivery_jobs.stuart_job_id existant, restaurant_id/
-- stuart_delivery_job_id sont renseignés ; SINON les deux restent
-- NULL -- JAMAIS une erreur, JAMAIS un blocage. Un job_id ambigu
-- (correspondance multiple -- structurellement impossible ici grâce
-- à l'index unique partiel stuart_delivery_jobs_unique_provider_
-- job_id, mais vérifié en défense en profondeur) laisse également la
-- corrélation NULL plutôt que de deviner.
-- ------------------------------------------------------------
create function public.record_stuart_provider_event(
  p_event_fingerprint text,
  p_provider_event_type text,
  p_provider_job_id_raw text default null,
  p_provider_status_raw text default null
)
returns table (
  id uuid,
  stuart_delivery_job_id uuid,
  restaurant_id uuid,
  processing_status text,
  created_at timestamptz,
  is_new_event boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_fingerprint text;
  v_provider_event_type text;
  v_provider_job_id_raw text;
  v_provider_status_raw text;
  v_match_count integer;
  v_job_id uuid;
  v_restaurant_id uuid;
  v_inserted_id uuid;
  v_row record;
  v_is_new boolean;
begin
  v_event_fingerprint := lower(btrim(coalesce(p_event_fingerprint, '')));
  v_provider_event_type := btrim(coalesce(p_provider_event_type, ''));
  v_provider_job_id_raw := nullif(btrim(coalesce(p_provider_job_id_raw, '')), '');
  v_provider_status_raw := nullif(btrim(coalesce(p_provider_status_raw, '')), '');

  if v_event_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'SCANYM_STUART_EVENT: p_event_fingerprint invalide (attendu exactement 64 caractères hexadécimaux minuscules -- SHA-256 non tronqué)' using errcode = '22023';
  end if;
  if length(v_provider_event_type) = 0 then
    raise exception 'SCANYM_STUART_EVENT: p_provider_event_type requis (vide après normalisation)' using errcode = '22004';
  end if;
  if v_provider_event_type !~ '^[a-zA-Z0-9_-]+$' then
    raise exception 'SCANYM_STUART_EVENT: p_provider_event_type invalide (jeu de caractères non sûr)' using errcode = '22023';
  end if;

  -- CORRÉLATION MEILLEURE-EFFORT -- jamais requise, jamais fermée.
  v_job_id := null;
  v_restaurant_id := null;
  if v_provider_job_id_raw is not null then
    select count(*) into v_match_count
      from public.stuart_delivery_jobs sdj
      where sdj.stuart_job_id = v_provider_job_id_raw;
    if v_match_count = 1 then
      select sdj.id, sdj.restaurant_id into v_job_id, v_restaurant_id
        from public.stuart_delivery_jobs sdj
        where sdj.stuart_job_id = v_provider_job_id_raw;
    end if;
    -- v_match_count = 0 (job pas encore connu localement) OU > 1
    -- (ne devrait structurellement jamais arriver, index unique
    -- partiel) : dans les deux cas, corrélation laissée NULL --
    -- JAMAIS une exception, l'évènement DOIT quand même être
    -- persisté (mandat D1 §D).
  end if;

  insert into public.stuart_provider_events (
    stuart_delivery_job_id, restaurant_id,
    provider_job_id_raw, event_fingerprint,
    provider_event_type, provider_status_raw
  ) values (
    v_job_id, v_restaurant_id,
    v_provider_job_id_raw, v_event_fingerprint,
    v_provider_event_type, v_provider_status_raw
  )
  on conflict (event_fingerprint) do nothing
  returning stuart_provider_events.id into v_inserted_id;

  v_is_new := (v_inserted_id is not null);

  select * into v_row
    from public.stuart_provider_events e
    where e.event_fingerprint = v_event_fingerprint;

  return query select
    v_row.id, v_row.stuart_delivery_job_id, v_row.restaurant_id,
    v_row.processing_status, v_row.created_at, v_is_new;
end;
$$;

comment on function public.record_stuart_provider_event(text, text, text, text) is
  'STUART LOT D1 §D — SECURITY DEFINER, service_role UNIQUEMENT. Seule autorité d''ÉCRITURE INITIALE de public.stuart_provider_events. NE VÉRIFIE AUCUNE signature -- fait confiance à l''appelant serveur (adaptateur d''authentification distinct, hors périmètre D1). Corrélation vers stuart_delivery_jobs MEILLEURE-EFFORT via p_provider_job_id_raw (jamais requise, jamais fermée -- un job inconnu localement laisse stuart_delivery_job_id/restaurant_id NULL, JAMAIS une exception). Idempotent sous concurrence réelle via INSERT...ON CONFLICT(event_fingerprint) DO NOTHING -- un rejeu exact renvoie la MÊME ligne logique (is_new_event=false).';

revoke all on function public.record_stuart_provider_event(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_stuart_provider_event(text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 4. claim_stuart_provider_events — primitif de revendication/bail,
-- SECURITY DEFINER, service_role UNIQUEMENT. Patron IDENTIQUE à
-- claim_payment_provider_events (PAYMENT P3-B5 v2) : `FOR UPDATE
-- SKIP LOCKED` puis UPDATE atomique, ordonnancement déterministe
-- (created_at, id), bail temporel borné.
-- ------------------------------------------------------------
create function public.claim_stuart_provider_events(
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
  'STUART LOT D1 §D — SECURITY DEFINER, service_role UNIQUEMENT. Primitif de file de travail identique à claim_payment_provider_events (PAYMENT P3-B5 v2) : FOR UPDATE SKIP LOCKED puis UPDATE atomique -- deux workers concurrents ne peuvent jamais revendiquer la même ligne. Éligibilité : processing_status in (received, failed_retryable) ET (jamais revendiqué ou bail expiré). Bail temporel (claim_token/claimed_at/claim_expires_at) -- reprise après crash sans orphelinat permanent.';

revoke all on function public.claim_stuart_provider_events(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_stuart_provider_events(integer, integer) to service_role;

-- ------------------------------------------------------------
-- 5. update_stuart_provider_event_processing_status — SEULE autorité
-- de TRANSITION, SECURITY DEFINER, service_role UNIQUEMENT. Machine
-- à états IDENTIQUE à update_payment_provider_event_processing_status
-- (verrouillage terminal, bail requis pour toute transition réelle,
-- replay idempotent exempté).
--
-- ADDITIF par rapport au patron payment_provider_events (mandat D1
-- §D, résolution tardive) : si l'évènement n'a pas encore de
-- corrélation (stuart_delivery_job_id NULL) et qu'un
-- p_resolved_stuart_delivery_job_id valide est fourni (possession
-- vérifiée : la ligne stuart_delivery_jobs référencée DOIT exister),
-- la corrélation est renseignée à cette occasion -- UNIQUEMENT si
-- elle était NULL (jamais réécrite une fois posée, cohérence avec
-- l'immutabilité déjà pratiquée ailleurs dans ce domaine, ex.
-- stuart_job_id lui-même).
-- ------------------------------------------------------------
create function public.update_stuart_provider_event_processing_status(
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

  -- RÉSOLUTION TARDIVE DE CORRÉLATION -- UNIQUEMENT si jamais posée,
  -- UNIQUEMENT si la ligne stuart_delivery_jobs référencée existe
  -- réellement (possession vérifiée par lecture directe, jamais
  -- supposée). Jamais réécrite si déjà renseignée (immutabilité,
  -- même discipline que stuart_job_id sur stuart_delivery_jobs).
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
  'STUART LOT D1 §D — SECURITY DEFINER, service_role UNIQUEMENT. Seule autorité de TRANSITION de stuart_provider_events.processing_status -- machine à états à verrouillage terminal, IDENTIQUE à update_payment_provider_event_processing_status (bail requis pour toute transition réelle, replay idempotent exempté). ADDITIF : peut résoudre tardivement stuart_delivery_job_id/restaurant_id (UNIQUEMENT si NULL jusqu''alors, UNIQUEMENT vers une ligne stuart_delivery_jobs existante réellement vérifiée) -- ferme le cas "unknown job résolu plus tard" sans second chemin d''écriture.';

revoke all on function public.update_stuart_provider_event_processing_status(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.update_stuart_provider_event_processing_status(uuid, uuid, text, text, uuid) to service_role;

-- ------------------------------------------------------------
-- 6. reap_stale_stuart_delivery_job_send_started — ferme le gap
-- PHASE 0 (mandat D1 §C). SECURITY DEFINER, service_role UNIQUEMENT.
--
-- TRANSITION UTILISÉE : send_started -> send_ambiguous -- EXACTEMENT
-- la transition déjà existante et déjà validée par mark_stuart_
-- delivery_job_ambiguous (v2.1, INCHANGÉE) ; ce RPC ne fait
-- qu'AUTOMATISER son déclenchement pour les lignes RÉELLEMENT
-- bloquées depuis plus de p_stale_after_seconds, au lieu d'exiger un
-- appelant applicatif encore vivant pour l'invoquer manuellement
-- (impossible par définition après un crash). AUCUN nouvel état
-- n'est introduit -- send_ambiguous porte DÉJÀ la sémantique exacte
-- requise ("issue distante inconnue, ne JAMAIS renvoyer aveuglément
-- -- voir StuartCreateJobBlockedByAmbiguityError, create-job.ts,
-- INCHANGÉ") : une ligne send_ambiguous bloque déjà toute nouvelle
-- tentative de création pour la même commande, exactement l'effet
-- de sécurité exigé par le mandat ("do NOT auto-resend when remote
-- success may already have occurred").
--
-- SÛR SOUS CONCURRENCE (mandat D1 §C "concurrent-worker-safe") :
-- `FOR UPDATE SKIP LOCKED` -- deux workers de reprise exécutés en
-- même temps ne traitent jamais la même ligne deux fois. AUCUN verrou
-- global restaurant (jamais pg_advisory_xact_lock ici -- ce lot
-- balaie plusieurs commandes à la fois par construction, un verrou
-- par order_id serait un verrou PAR LIGNE naturellement fourni par
-- FOR UPDATE lui-même, pas besoin d'un verrou consultatif
-- supplémentaire).
--
-- AUCUNE BOUCLE CHAUDE (mandat D1 §C "no hot loop") : un seul
-- balayage BORNÉ (p_batch_size) par appel -- l'ordonnancement d'appels
-- répétés (cron/worker externe) reste hors périmètre SQL de ce RPC.
-- ------------------------------------------------------------
create function public.reap_stale_stuart_delivery_job_send_started(
  p_stale_after_seconds integer default 120,
  p_batch_size integer default 50
)
returns table (
  id uuid,
  order_id uuid,
  restaurant_id uuid,
  previous_send_state text,
  new_send_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stale_after_seconds integer;
  v_batch_size integer;
begin
  v_stale_after_seconds := coalesce(p_stale_after_seconds, 120);
  v_batch_size := coalesce(p_batch_size, 50);

  if v_stale_after_seconds < 10 or v_stale_after_seconds > 86400 then
    raise exception 'SCANYM_STUART: p_stale_after_seconds hors bornes (entre 10 et 86400 attendu)' using errcode = '22023';
  end if;
  if v_batch_size < 1 or v_batch_size > 200 then
    raise exception 'SCANYM_STUART: p_batch_size hors bornes (entre 1 et 200 attendu)' using errcode = '22023';
  end if;

  return query
  with stale as (
    select sdj.id
      from public.stuart_delivery_jobs sdj
      where sdj.send_state = 'send_started'
        and sdj.updated_at <= now() - make_interval(secs => v_stale_after_seconds)
      order by sdj.updated_at
      limit v_batch_size
      for update skip locked
  ),
  reaped as (
    update public.stuart_delivery_jobs sdj
      set send_state = 'send_ambiguous',
          updated_at = now()
      from stale
      where sdj.id = stale.id
      returning sdj.id, sdj.order_id, sdj.restaurant_id
  )
  select reaped.id, reaped.order_id, reaped.restaurant_id,
         'send_started'::text, 'send_ambiguous'::text
    from reaped;
end;
$$;

comment on function public.reap_stale_stuart_delivery_job_send_started(integer, integer) is
  'STUART LOT D1 §C — SECURITY DEFINER, service_role UNIQUEMENT. Ferme le gap PHASE 0 (crash entre mark_stuart_delivery_job_send_started et confirmation/ambiguïté, ligne bloquée définitivement). Transition send_started -> send_ambiguous EXACTEMENT identique à mark_stuart_delivery_job_ambiguous (v2.1, INCHANGÉE) -- aucun nouvel état introduit, aucune tentative de renvoi HTTP effectuée ici (RPC SQL pur). Sûr sous plusieurs workers concurrents (FOR UPDATE SKIP LOCKED, jamais de verrou global). Balayage BORNÉ (p_batch_size), aucune boucle chaude. Une ligne send_ambiguous bloque déjà (comportement EXISTANT, create-job.ts INCHANGÉ) toute nouvelle tentative de création pour la même commande -- ferme structurellement "do NOT auto-resend when remote success may already have occurred".';

revoke all on function public.reap_stale_stuart_delivery_job_send_started(integer, integer) from public, anon, authenticated;
grant execute on function public.reap_stale_stuart_delivery_job_send_started(integer, integer) to service_role;

-- ------------------------------------------------------------
-- 6bis. apply_stuart_delivery_job_status_if_newer — mandat D1 §F
-- ("out-of-order older events must not regress newer authoritative
-- state"). SECURITY DEFINER, service_role UNIQUEMENT.
--
-- POURQUOI UN NOUVEAU RPC PLUTÔT QUE MODIFIER update_stuart_delivery_
-- job_status (v2.1) : ce dernier n'a AUCUNE notion d'ordonnancement
-- temporel prestataire (il écrase inconditionnellement, appelant
-- INEXISTANT à ce jour -- constat Phase 0) -- l'ALTÉRER violerait le
-- mandat "do not redesign stuart_delivery_jobs core identity/
-- idempotency model". Ce nouveau RPC ENVELOPPE la même logique de
-- classification connue/inconnue (dupliquée ici À L'IDENTIQUE,
-- jamais divergente) mais n'applique la mise à jour QUE si
-- p_provider_event_at est STRICTEMENT postérieur au
-- last_provider_sync_at actuellement enregistré (ou si aucun
-- last_provider_sync_at n'existe encore) -- un évènement fixture plus
-- ancien qu'un évènement déjà appliqué est silencieusement IGNORÉ
-- (retour applied=false), JAMAIS une erreur, JAMAIS une régression
-- d'état.
-- ------------------------------------------------------------
create function public.apply_stuart_delivery_job_status_if_newer(
  p_id uuid,
  p_order_id uuid,
  p_restaurant_id uuid,
  p_provider_event_at timestamptz,
  p_job_status_raw text default null,
  p_delivery_status_raw text default null,
  p_package_status_raw text default null
)
returns table (
  applied boolean,
  job_status_known text,
  delivery_status_known text,
  package_status_known text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current record;
  v_job_known text;
  v_delivery_known text;
  v_package_known text;
begin
  if p_provider_event_at is null then
    raise exception 'SCANYM_STUART: p_provider_event_at requis (horodatage prestataire de l''évènement, jamais l''horodatage de réception locale)' using errcode = '22004';
  end if;

  select sdj.last_provider_sync_at, sdj.job_status_known, sdj.delivery_status_known, sdj.package_status_known
    into v_current
    from public.stuart_delivery_jobs sdj
    where sdj.id = p_id and sdj.order_id = p_order_id and sdj.restaurant_id = p_restaurant_id
    for update;
  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable ou possession invalide' using errcode = 'P0002';
  end if;

  if v_current.last_provider_sync_at is not null and p_provider_event_at <= v_current.last_provider_sync_at then
    -- ÉVÈNEMENT HORS-ORDRE (plus ancien qu'un évènement déjà appliqué)
    -- -- IGNORÉ SANS ERREUR, état actuel renvoyé fidèlement, AUCUNE
    -- régression.
    return query select false, v_current.job_status_known, v_current.delivery_status_known, v_current.package_status_known;
    return;
  end if;

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
        last_provider_sync_at = p_provider_event_at
    where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id;

  return query select true,
    case when p_job_status_raw is not null then v_job_known else v_current.job_status_known end,
    case when p_delivery_status_raw is not null then v_delivery_known else v_current.delivery_status_known end,
    case when p_package_status_raw is not null then v_package_known else v_current.package_status_known end;
end;
$$;

comment on function public.apply_stuart_delivery_job_status_if_newer(uuid, uuid, uuid, timestamptz, text, text, text) is
  'STUART LOT D1 §F — SECURITY DEFINER, service_role UNIQUEMENT. Enveloppe additive de update_stuart_delivery_job_status (v2.1, INCHANGÉE) qui n''applique la mise à jour que si p_provider_event_at (horodatage PRESTATAIRE de l''évènement) est strictement postérieur au last_provider_sync_at déjà enregistré -- un évènement hors-ordre plus ancien est IGNORÉ (applied=false), jamais une erreur, jamais une régression d''état. Statuts inconnus stockés en RAW mais jamais classés KNOWN (identique à v2.1) -- ne crashe jamais sur une valeur non répertoriée.';

revoke all on function public.apply_stuart_delivery_job_status_if_newer(uuid, uuid, uuid, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_stuart_delivery_job_status_if_newer(uuid, uuid, uuid, timestamptz, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 7. CANCELLATION LOCALE — mandat D1 §G. Extension ADDITIVE et
-- ORTHOGONALE de stuart_delivery_jobs : n'altère JAMAIS send_state ni
-- stuart_job_id -- ce lot n'appelle et ne peut jamais appeler une
-- annulation Stuart réelle (non autorisée en D1, mandat §J).
-- ------------------------------------------------------------
alter table public.stuart_delivery_jobs
  add column requires_local_cancellation boolean not null default false,
  add column local_cancellation_requested_at timestamptz;

alter table public.stuart_delivery_jobs
  add constraint stuart_delivery_jobs_local_cancellation_consistency
  check (requires_local_cancellation = (local_cancellation_requested_at is not null));

comment on column public.stuart_delivery_jobs.requires_local_cancellation is
  'STUART LOT D1 §G — vrai si la commande associée a été annulée APRÈS allocation/envoi/confirmation du job Stuart, ET qu''aucune annulation prestataire réelle n''a été exécutée (non autorisée en D1) -- signale qu''une réconciliation/action manuelle prestataire reste requise. N''ALTÈRE JAMAIS send_state/stuart_job_id -- orthogonal au cycle de vie d''envoi.';
comment on column public.stuart_delivery_jobs.local_cancellation_requested_at is
  'Horodatage de la demande d''annulation LOCALE (jamais une confirmation d''annulation prestataire réelle, qui n''existe pas dans ce lot).';

create function public.record_stuart_delivery_job_local_cancellation(
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
  set requires_local_cancellation = true,
      local_cancellation_requested_at = now(),
      updated_at = now()
  where id = p_id and order_id = p_order_id and restaurant_id = p_restaurant_id
    and send_state in ('allocated', 'send_started', 'send_ambiguous', 'created_confirmed')
    and requires_local_cancellation = false;

  if not found then
    raise exception 'SCANYM_STUART: ligne introuvable, possession invalide, déjà marquée, ou état non éligible (terminal_failure exclu -- aucun job actif à réconcilier)' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.record_stuart_delivery_job_local_cancellation(uuid, uuid, uuid) is
  'STUART LOT D1 §G — SECURITY DEFINER, service_role UNIQUEMENT. Enregistre LOCALEMENT qu''une commande a été annulée après allocation/envoi/confirmation d''un job Stuart et qu''une réconciliation prestataire manuelle reste requise. N''APPELLE JAMAIS Stuart -- "do not fake remote cancellation" (mandat §G). Possession-scopée (id, order_id, restaurant_id ensemble, jamais UUID seul). N''ALTÈRE JAMAIS send_state/stuart_job_id. Idempotence délibérément REFUSÉE (pas un no-op sur rejeu) -- un second appel sur une ligne déjà marquée échoue fermé (P0002) plutôt que de masquer un appelant qui rejoue par erreur une action de réconciliation déjà enregistrée.';

revoke all on function public.record_stuart_delivery_job_local_cancellation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_stuart_delivery_job_local_cancellation(uuid, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 8. POSTCHECK DÉTERMINISTE — RLS + ACL, même convention que
-- STUART SANDBOX INTEGRATION v2.1 / PAYMENT P3-B5 v2.
-- ------------------------------------------------------------
do $$
declare
  v_priv boolean;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'stuart_provider_events' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- RLS non activée sur stuart_provider_events' using errcode = '55000';
  end if;

  foreach v_priv in array array[
    has_table_privilege('anon', 'public.stuart_provider_events', 'select'),
    has_table_privilege('anon', 'public.stuart_provider_events', 'insert'),
    has_table_privilege('anon', 'public.stuart_provider_events', 'update'),
    has_table_privilege('anon', 'public.stuart_provider_events', 'delete'),
    has_table_privilege('authenticated', 'public.stuart_provider_events', 'select'),
    has_table_privilege('authenticated', 'public.stuart_provider_events', 'insert'),
    has_table_privilege('authenticated', 'public.stuart_provider_events', 'update'),
    has_table_privilege('authenticated', 'public.stuart_provider_events', 'delete'),
    has_table_privilege('service_role', 'public.stuart_provider_events', 'select'),
    has_table_privilege('service_role', 'public.stuart_provider_events', 'insert'),
    has_table_privilege('service_role', 'public.stuart_provider_events', 'update'),
    has_table_privilege('service_role', 'public.stuart_provider_events', 'delete')
  ]
  loop
    if v_priv then
      raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- un rôle applicatif dispose d''un privilège direct inattendu sur stuart_provider_events' using errcode = '55000';
    end if;
  end loop;

  if has_function_privilege('anon', 'public.get_stuart_delivery_eligibility(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.get_stuart_delivery_eligibility(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur get_stuart_delivery_eligibility' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.record_stuart_provider_event(text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.record_stuart_provider_event(text,text,text,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur record_stuart_provider_event' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.claim_stuart_provider_events(integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_stuart_provider_events(integer,integer)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur claim_stuart_provider_events' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.update_stuart_provider_event_processing_status(uuid,uuid,text,text,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.update_stuart_provider_event_processing_status(uuid,uuid,text,text,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur update_stuart_provider_event_processing_status' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.reap_stale_stuart_delivery_job_send_started(integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.reap_stale_stuart_delivery_job_send_started(integer,integer)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur reap_stale_stuart_delivery_job_send_started' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.apply_stuart_delivery_job_status_if_newer(uuid,uuid,uuid,timestamptz,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.apply_stuart_delivery_job_status_if_newer(uuid,uuid,uuid,timestamptz,text,text,text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur apply_stuart_delivery_job_status_if_newer' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.record_stuart_delivery_job_local_cancellation(uuid,uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.record_stuart_delivery_job_local_cancellation(uuid,uuid,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur record_stuart_delivery_job_local_cancellation' using errcode = '55000';
  end if;
end $$;

-- ------------------------------------------------------------
-- 9. NON-RÉGRESSION EXPLICITE (mandat D1, "closed foundations do not
-- reopen") : ce lot n'altère AUCUNE fonction/colonne/contrainte
-- EXISTANTE de stuart_delivery_jobs (allocate_stuart_delivery_job,
-- mark_stuart_delivery_job_send_started, mark_stuart_delivery_job_
-- ambiguous, confirm_stuart_delivery_job_created, mark_stuart_
-- delivery_job_terminal_failure, update_stuart_delivery_job_status
-- restent TOUS inchangés), AUCUNE table/fonction de LOT A-0/A/B/C, ni
-- de payment_provider_events/payment_transactions/orders (P1). Les
-- deux colonnes ADDITIVES de stuart_delivery_jobs (section 7) et les
-- fonctions/table STRICTEMENT NOUVELLES ci-dessus sont la SEULE
-- surface ajoutée par ce lot.
-- ------------------------------------------------------------

commit;
