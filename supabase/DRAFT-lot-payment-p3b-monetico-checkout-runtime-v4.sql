-- ============================================================
-- Scanym — PAYMENT P3-B / MONETICO CHECKOUT RUNTIME v4 — SQL LOT
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ferme la partie BASE DE DONNÉES des 7 blocages nommés par
-- l'audit de travail v3 indépendant (P3B-V3-*). Ce lot ajoute
-- EXACTEMENT DEUX fonctions nouvelles, DISJOINTES de tout contrat
-- existant :
--   - public.get_order_service_mode(uuid, uuid)      [LECTURE PURE]
--   - public.claim_payment_provider_event_by_id(uuid, integer)
--       [MUTATION -- même famille que claim_payment_provider_events,
--       PAYMENT P3-B5 v2, INCHANGÉE, jamais rouverte]
-- AUCUNE table, colonne, contrainte, index ou fonction déjà publiée
-- n'est modifiée, recréée ou rouverte par ce lot.
--
-- RECONNAISSANCE PRÉALABLE (mandat v4 section 9) : aucune capacité
-- possession-scoped existante n'expose `orders.service_mode` à un
-- futur runtime de paiement -- `get_order_payment_context` (PAYMENT
-- P3-B2) l'exclut délibérément de son contrat minimal
-- (restaurant_id/payment_status uniquement). `get_order_service_mode`
-- ci-dessous suit EXACTEMENT le même patron d'accès que
-- get_order_payment_context (même preuve de possession, même
-- SECURITY DEFINER/search_path vide, même absence de grant de table
-- nouveau) -- aucune table exposée plus largement qu'avant.
--
-- POURQUOI `claim_payment_provider_event_by_id` PLUTÔT QUE DE
-- RÉUTILISER `claim_payment_provider_events` (mandat v4 section 15-17,
-- "do not create a second processing implementation") :
-- `claim_payment_provider_events` (PAYMENT P3-B5 v2) est un primitif
-- de FILE DE TRAVAIL GÉNÉRIQUE -- il ne cible jamais un id précis,
-- uniquement "le lot le plus ancien actuellement éligible, tous
-- restaurants confondus". Le chemin SYNCHRONE (immédiatement après
-- l'ingestion d'UN callback donné) a besoin de revendiquer
-- PRÉCISÉMENT l'évènement qu'il vient d'enregistrer -- jamais un
-- évènement plus ancien d'un AUTRE restaurant qui se trouverait être
-- en tête de file. `claim_payment_provider_event_by_id` applique
-- EXACTEMENT la même politique d'éligibilité et de bail
-- (`processing_status in ('received','failed_retryable')`,
-- `claim_expires_at is null or claim_expires_at <= now()`, verrouillage
-- `for update skip locked`) que sa sœur par lot -- une différence de
-- PORTÉE de la revendication (un id précis vs un lot ordonné), jamais
-- une deuxième politique de traitement métier : le TRAITEMENT lui-même
-- (vérification de corrélation/montant/devise, application
-- confirm_payment_attempt, finalisation via
-- update_payment_provider_event_processing_status) reste une SEULE
-- fonction TypeScript partagée (payment-provider-event-processor.ts,
-- ce lot), appelée identiquement par le chemin synchrone ET par le
-- futur worker de reprise (tous deux revendiquent via une fonction SQL
-- de CETTE famille, puis appellent CE MÊME processeur).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'service_mode'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: orders.service_mode introuvable -- prérequis migration-orders.sql/LOT 2A manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','public_token','service_mode')
    having count(*) = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_provider_events'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_events introuvable -- prérequis PAYMENT P3-B5 manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_payment_provider_events'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.claim_payment_provider_events introuvable -- prérequis PAYMENT P3-B5 v2 manquant, migration annulée.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_service_mode'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_service_mode existe déjà -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_payment_provider_event_by_id'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.claim_payment_provider_event_by_id existe déjà -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_order_service_mode — LECTURE SERVEUR DE CONFIANCE SEULE,
-- service_role UNIQUEMENT, possession-scoped. Ferme
-- P3B-V4-SHIPPING-AUTHORITY-01 : le NAVIGATEUR ne décide plus jamais
-- de l'applicabilité shipping (`isDeliveryOrder` client JSON, v3,
-- SUPPRIMÉ) -- seule cette lecture serveur AUTORITAIRE le fait.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal : `service_mode` SEUL. Ne
-- retourne jamais order_number/total/currency/adresse/téléphone/email
-- ni aucune autre colonne de `public.orders`.
--
-- MODÈLE D'ACCÈS : preuve de possession EXACTE, même patron que
-- get_order_payment_context/get_order_active_payment_attempt/
-- get_order_billing_context (orders.id = p_order_id ET
-- orders.public_token = p_public_token) -- aucun fallback, aucune
-- correspondance partielle, aucun restaurant_id fourni par l'appelant.
-- Instruction SQL pure sans branche : ensemble de résultats vide pour
-- toute paire incorrecte, y compris des arguments NULL.
--
-- AUCUNE ÉCRITURE : SELECT uniquement.
-- ------------------------------------------------------------
create or replace function public.get_order_service_mode(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  service_mode text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.service_mode
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_service_mode(uuid, uuid) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4, ferme P3B-V4-SHIPPING-AUTHORITY-01. Lecture serveur de confiance SEULE, possession-scoped (même patron que get_order_payment_context/get_order_billing_context), de service_mode SEUL -- source AUTORITAIRE unique pour dériver l''applicabilité shipping Monetico (delivery uniquement), remplaçant le booléen isDeliveryOrder précédemment accepté depuis le JSON navigateur (v3, jamais fiable). Instruction SQL pure sans branche : toute paire incorrecte produit un ensemble de résultats vide, identique dans tous les cas. Aucune écriture.';

revoke all on function public.get_order_service_mode(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_service_mode(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 3. claim_payment_provider_event_by_id — MUTATION, SECURITY DEFINER,
-- service_role UNIQUEMENT. Ferme P3B-V4-ACK-RECOVERY-01 (chemin de
-- traitement synchrone RÉUTILISANT la même politique d'éligibilité/
-- bail que la reprise par lot, voir en-tête de fichier).
--
-- ÉLIGIBILITÉ IDENTIQUE à claim_payment_provider_events (AJOUT v4.2,
-- ferme P3BV41-RECOVERY-STARVATION-01 : les deux fonctions de
-- revendication DOIVENT rester une SEULE politique d'éligibilité,
-- jamais deux définitions divergentes), restreinte à UN id précis :
-- processing_status in ('received','failed_retryable') ET (jamais
-- revendiqué OU bail expiré) ET (jamais échoué OU délai d'éligibilité
-- de nouvelle tentative atteint -- next_attempt_at). Ne renvoie AUCUNE ligne
-- (jamais une exception) si l'id n'existe pas, est déjà dans un état
-- terminal (applied/ignored/failed_terminal -- rejeu d'un évènement
-- déjà traité), ou est actuellement revendiqué par un bail NON expiré
-- (traitement concurrent déjà en cours) -- l'appelant traite une
-- réponse vide comme "rien à faire ici, ACK déjà acquis par
-- l'enregistrement durable", jamais une erreur.
--
-- MÊME bail temporel que claim_payment_provider_events -- un appelant
-- qui revendique puis crashe avant de finaliser n'orpheline JAMAIS
-- l'évènement : dès expiration du bail, il redevient éligible à une
-- future revendication PAR LOT (claim_payment_provider_events, worker
-- de reprise) OU par un futur appel synchrone sur le MÊME id (rejeu
-- Monetico exact après un crash).
-- ------------------------------------------------------------
create or replace function public.claim_payment_provider_event_by_id(
  p_event_id uuid,
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
  v_lease_seconds integer;
begin
  v_lease_seconds := coalesce(p_lease_seconds, 60);

  if p_event_id is null then
    return;
  end if;

  if v_lease_seconds < 5 or v_lease_seconds > 3600 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_lease_seconds hors bornes (entre 5 et 3600 attendu)' using errcode = '22023';
  end if;

  return query
  with eligible as (
    select e.id
      from public.payment_provider_events e
      where e.id = p_event_id
        and e.processing_status in ('received', 'failed_retryable')
        and (e.claim_expires_at is null or e.claim_expires_at <= now())
        and (e.next_attempt_at is null or e.next_attempt_at <= now())
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
                e.claim_token, e.claim_expires_at
  )
  select claimed.id, claimed.restaurant_id, claimed.order_id, claimed.payment_transaction_id,
         claimed.provider_code, claimed.provider_reference, claimed.event_fingerprint,
         claimed.provider_event_type, claimed.provider_event_code, claimed.amount, claimed.currency,
         claimed.authorization_reference, claimed.processing_status, claimed.retry_count,
         claimed.claim_token, claimed.claim_expires_at
    from claimed;
end;
$$;

comment on function public.claim_payment_provider_event_by_id(uuid, integer) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4, ferme P3B-V4-ACK-RECOVERY-01. Sœur ciblée-par-id de claim_payment_provider_events (PAYMENT P3-B5 v2, INCHANGÉE) -- MÊME politique d''éligibilité/bail (processing_status in (received,failed_retryable), claim_expires_at expiré ou NULL, for update skip locked), restreinte à un seul id. Renvoie un ensemble VIDE (jamais une erreur) si l''id est absent, déjà terminal, ou revendiqué par un bail non expiré -- permet au chemin de traitement SYNCHRONE de revendiquer précisément l''évènement qu''il vient d''enregistrer sans jamais piocher dans le lot générique d''un autre restaurant. Le jeton de bail retourné DOIT être fourni tel quel à update_payment_provider_event_processing_status (PAYMENT P3-B5 v2, INCHANGÉE) pour finaliser -- un jeton périmé est rejeté fail-closed, empêchant un appelant périmé d''écraser une revendication plus récente (worker de reprise ou nouvel appel synchrone).';

revoke all on function public.claim_payment_provider_event_by_id(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_payment_provider_event_by_id(uuid, integer) to service_role;

-- ------------------------------------------------------------
-- 4. NON-RÉGRESSION EXPLICITE — ce lot n'altère AUCUN privilège de
-- table existant, ni AUCUNE fonction existante (P1, P2A, P3-A0..A2,
-- P3-B0..P3-B6, PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 restent tous
-- INCHANGÉS). AUCUN grant de table nouveau n'est ajouté par ce lot,
-- pour quelque rôle que ce soit, y compris service_role.
-- ------------------------------------------------------------

commit;
