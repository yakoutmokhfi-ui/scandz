-- =============================================================================
-- SCANYM — N1-A — CUSTOMER EMAIL NOTIFICATION FOUNDATION + ORDER RECEIVED
-- Forward migration (Claude Monet)
--
-- OBJECTIF : fondation OUTBOX durable pour les notifications e-mail
-- transactionnelles. Premier (et SEUL) événement actif : ORDER_RECEIVED.
-- AUCUN envoi réel n'est autorisé par ce lot (voir la porte d'activation
-- côté TypeScript, lib/server/notifications/real-email-activation-gate.ts
-- — jamais un booléen SQL, jamais un NEXT_PUBLIC_*, fail-closed).
--
-- ARCHITECTURE (mandat, littéral) :
--   création de commande -> ligne outbox durable -> worker -> adaptateur
--   e-mail -> tentative de livraison enregistrée.
-- L'e-mail n'est JAMAIS envoyé dans le chemin de la requête de création
-- de commande. Un échec d'envoi ne peut JAMAIS invalider/annuler une
-- commande déjà créée avec succès (aucune des tables/fonctions ci-dessous
-- n'a la moindre autorité sur `orders.status`/paiement/Stuart/facture/
-- suivi/fulfillment -- lecture seule d'un événement d'ordre autoritaire).
--
-- RÉEMPLOI DÉLIBÉRÉ (gouvernance : jamais une seconde autorité) :
--   - jeton de possession de suivi : `orders.public_token` (existant,
--     déjà renvoyé par create_order) -- AUCUN second système de jeton.
--   - format e-mail client : la RÉGEX de create_order elle-même
--     ('^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$', déjà appliquée
--     inconditionnellement à tout customer_email non nul avant toute
--     insertion, DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql
--     ligne 1405) -- ce lot ne revalide donc QUE la présence (non nul),
--     jamais une seconde règle de format.
--   - identité tenant : restaurant_id + restaurant_users, via les
--     fonctions existantes public.is_member_of/public.has_role_in.
--   - opérateur transverse : public.is_scanym_operator() (existant).
--   - déclencheur updated_at : public.touch_updated_at() (existant,
--     migration-v55-updated-at.sql).
--   - primitive claim/lease + barème de reprise (30s/120s/600s/1800s,
--     5 tentatives max) : calquée EXACTEMENT sur
--     claim_stuart_provider_events / update_stuart_provider_event_
--     processing_status (DRAFT-lot-stuart-provider-events-foundation-
--     v1[-2-remediation].sql) -- aucun barème indépendant inventé.
--
-- VERROUS DE FLUX (ne touche RIEN de ce qui suit) : CGV v1.4, CCTF v1.1,
-- possession/sécurité du suivi, autorité Monetico/paiement, demande de
-- facture, Stuart D1/D2, catalogue, LOT C, remboursements. Stuart reste
-- CLOSED/PUBLISHED/PROD/LIVE DISABLED -- aucun appel Stuart réel ici.
--
-- create_order EST MODIFIÉ (CREATE OR REPLACE, signature ET colonnes de
-- retour INCHANGÉES -- 6 colonnes, 8 arguments, identiques à
-- DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql) : UNE SEULE ligne
-- ajoutée (`perform public.create_order_received_notification(...)`),
-- placée après la mise à jour finale de `orders` (total/delivery_fee
-- déjà arrêtés) et avant le `return query` -- dans LA MÊME transaction
-- implicite que la création de la commande (PL/pgSQL = atomique), donc
-- une commande validée ne perd jamais silencieusement son événement
-- ORDER_RECEIVED initial. AUCUNE autre ligne du corps hérité n'est
-- modifiée. Un échec de cette ligne annule la commande avec elle -- ce
-- n'est PAS un envoi d'e-mail (qui reste hors de ce chemin), seulement
-- l'insertion d'une ligne outbox déterministe ; ce choix est documenté
-- au README-AUDIT.md section 10 avec son alternative rejetée.
--
-- v1.2 — ADDENDUM REMÉDIATION (N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01) :
-- `notification_delivery_attempt.error_class` et
-- `notification_outbox.last_error_code` sont désormais contraints à
-- une TAXONOMIE FERMÉE (CHECK ... IN (...), voir plus bas) --
-- remplace l'ancienne garde par longueur+regex hexadécimale, jugée
-- insuffisante (un secret/jeton en FORME UUID peut contourner un
-- filtre hexadécimal). L'autorité PRINCIPALE reste applicative
-- (lib/server/notifications/notification-error-taxonomy.ts,
-- `normalizeNotificationErrorCode` -- appelée par le worker AVANT tout
-- appel à `complete_notification_attempt`) ; cette contrainte SQL est
-- une défense en profondeur, pas le mécanisme premier (mandat,
-- littéral). N1A-IDEMPOTENCY-KEY-CONTRACT-01 (clé d'idempotence
-- côté provider) est un remède PUREMENT applicatif
-- (EmailMessage.idempotencyKey, dérivée de notification_outbox.id) --
-- AUCUN changement de schéma n'est nécessaire ni introduit pour cette
-- seconde remédiation.
-- =============================================================================

-- -----------------------------------------------------------------------
-- PRÉCONTRÔLES (anti double-application, anti-dérive de schéma)
-- -----------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('merchant_notification_profile', 'notification_outbox', 'notification_delivery_attempt')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une table N1-A existe déjà (merchant_notification_profile / notification_outbox / notification_delivery_attempt) -- double application refusée.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'set_merchant_notification_profile', 'create_order_received_notification',
        'claim_pending_notifications', 'complete_notification_attempt',
        'reap_stale_notification_claims'
      )
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une fonction N1-A existe déjà -- double application refusée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.is_member_of introuvable -- dépendance manquante.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_role_in'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.has_role_in introuvable -- dépendance manquante.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.is_scanym_operator introuvable -- dépendance manquante.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.touch_updated_at introuvable -- dépendance manquante.';
  end if;

  -- create_order doit être EXACTEMENT la définition CGV v1.1 (8
  -- arguments, table de retour à 6 colonnes) -- sinon ce lot modifierait
  -- une base différente de celle auditée.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_identity_arguments(p.oid) =
        'p_slug text, p_service_mode text, p_items jsonb, p_table_number integer, p_customer jsonb, p_note text, p_language text, p_cgv_accepted boolean'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order(text,text,jsonb,integer,jsonb,text,text,boolean) introuvable avec la signature attendue -- chaîne de migrations incomplète ou dérivée.';
  end if;

  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_result(p.oid) = 'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  ) <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order n''a pas exactement 6 colonnes de sortie (order_id, order_number, public_token, subtotal, delivery_fee, total) -- migration annulée.';
  end if;
end $$;

-- =============================================================================
-- 1. merchant_notification_profile — configuration tenant, RLS directe
--    (lecture) + RPC dédiée (écriture) -- même patron que
--    restaurant_sale_modes (migration-v83-lot2a4-privilege-hardening.sql) :
--    SELECT direct sous RLS pour authenticated, AUCUN INSERT/UPDATE direct
--    (écriture exclusivement via set_merchant_notification_profile).
--    AUCUN secret prestataire stocké ici (mandat, littéral).
-- =============================================================================
create table public.merchant_notification_profile (
  restaurant_id   uuid primary key references public.restaurants(id) on delete cascade,
  email_enabled   boolean not null default false,
  sender_name     text check (sender_name is null or length(sender_name) between 1 and 120),
  sender_email    text check (sender_email is null or length(sender_email) <= 254),
  reply_to        text check (reply_to is null or length(reply_to) <= 254),
  default_locale  text not null default 'fr' check (default_locale in ('fr', 'en', 'ar')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- email_enabled=true exige une identité d'expéditeur exploitable --
  -- jamais un envoi "activé" sans nom/adresse résolus.
  constraint merchant_notification_profile_enabled_requires_sender
    check (not email_enabled or (sender_name is not null and sender_email is not null)),
  constraint merchant_notification_profile_sender_email_format
    check (sender_email is null or sender_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'),
  constraint merchant_notification_profile_reply_to_format
    check (reply_to is null or reply_to ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$')
);

comment on table public.merchant_notification_profile is
  'N1-A — configuration de notification e-mail par tenant. AUCUN secret/identifiant prestataire ici (uniquement identité d''expéditeur/opt-in/locale par défaut). Écriture EXCLUSIVEMENT via set_merchant_notification_profile (SECURITY DEFINER) -- jamais d''INSERT/UPDATE direct, même pour le propriétaire du restaurant. Ne contient AUCUNE valeur codée en dur pour un marchand particulier (ex. Au Lait Cru) -- table vide par défaut pour tout restaurant, fail-closed (email_enabled=false).';

create trigger trg_touch_updated_at
  before update on public.merchant_notification_profile
  for each row execute function public.touch_updated_at();

alter table public.merchant_notification_profile enable row level security;

revoke all on public.merchant_notification_profile from public, anon, authenticated, service_role;
grant select on public.merchant_notification_profile to authenticated;

create policy "merchant_notification_profile_select_own_or_operator"
  on public.merchant_notification_profile
  for select
  using (public.is_member_of(restaurant_id) or public.is_scanym_operator());

-- -----------------------------------------------------------------------
-- 1b. Écriture — RPC dédiée, jamais un GRANT table direct.
-- -----------------------------------------------------------------------
create function public.set_merchant_notification_profile(
  p_restaurant_id  uuid,
  p_email_enabled  boolean,
  p_sender_name    text default null,
  p_sender_email   text default null,
  p_reply_to       text default null,
  p_default_locale text default 'fr'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender_name  text;
  v_sender_email text;
  v_reply_to     text;
  v_locale       text;
begin
  if not (public.has_role_in(p_restaurant_id, array['owner', 'manager']) or public.is_scanym_operator()) then
    raise exception 'SCANYM_NOTIFICATION_PROFILE_FORBIDDEN: rôle owner/manager (ou opérateur) requis pour %', p_restaurant_id
      using errcode = '42501';
  end if;

  v_sender_name  := nullif(left(trim(coalesce(p_sender_name, '')), 120), '');
  v_sender_email := nullif(left(trim(coalesce(p_sender_email, '')), 254), '');
  v_reply_to     := nullif(left(trim(coalesce(p_reply_to, '')), 254), '');
  v_locale       := case when p_default_locale in ('fr', 'en', 'ar') then p_default_locale else 'fr' end;

  if v_sender_email is not null and v_sender_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'SCANYM_NOTIFICATION_PROFILE: sender_email invalide' using errcode = '22023';
  end if;

  if v_reply_to is not null and v_reply_to !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'SCANYM_NOTIFICATION_PROFILE: reply_to invalide' using errcode = '22023';
  end if;

  if p_email_enabled and (v_sender_name is null or v_sender_email is null) then
    raise exception 'SCANYM_NOTIFICATION_PROFILE: email_enabled=true exige sender_name et sender_email' using errcode = '23514';
  end if;

  insert into public.merchant_notification_profile (
    restaurant_id, email_enabled, sender_name, sender_email, reply_to, default_locale
  ) values (
    p_restaurant_id, p_email_enabled, v_sender_name, v_sender_email, v_reply_to, v_locale
  )
  on conflict (restaurant_id) do update set
    email_enabled  = excluded.email_enabled,
    sender_name    = excluded.sender_name,
    sender_email   = excluded.sender_email,
    reply_to       = excluded.reply_to,
    default_locale = excluded.default_locale;
end $$;

comment on function public.set_merchant_notification_profile(uuid, boolean, text, text, text, text) is
  'N1-A — seul point d''écriture de merchant_notification_profile. Exige owner/manager (ou is_scanym_operator()) -- jamais une simulation d''appartenance restaurant_users. AUCUN secret prestataire accepté ici.';

revoke all on function public.set_merchant_notification_profile(uuid, boolean, text, text, text, text) from public, anon;
grant execute on function public.set_merchant_notification_profile(uuid, boolean, text, text, text, text) to authenticated;

-- =============================================================================
-- 2. notification_outbox — RPC-only, calqué sur stuart_provider_events
--    (RLS activée, ZÉRO policy, ZÉRO grant table, même pour service_role
--    -- tout accès passe par une fonction SECURITY DEFINER dédiée).
-- =============================================================================
create table public.notification_outbox (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants(id) on delete cascade,
  order_id          uuid not null references public.orders(id) on delete cascade,
  -- Placeholders structurels pour de futurs types -- AUCUNE émission
  -- active au-delà de 'order_received' dans ce lot (mandat, littéral :
  -- "must NOT be implemented yet ... unless needed only as enum/schema
  -- placeholders and without active emission"). Colonne texte + CHECK
  -- (pas un type ENUM Postgres) : extensible par un simple ALTER TABLE
  -- ... DROP/ADD CONSTRAINT dans un futur lot, jamais par une migration
  -- de type destructive.
  notification_type text not null check (notification_type in (
    'order_received',
    'order_accepted', 'order_preparing', 'order_ready', 'order_delivered',
    'order_cancelled', 'order_rejected', 'delivery_failed', 'refund_issued'
  )),
  recipient_email   text check (recipient_email is null or length(recipient_email) <= 254),
  -- Snapshot au moment de la création -- jamais réinféré plus tard
  -- (mandat : "Do NOT infer locale later from ... Fallback behavior
  -- must be deterministic").
  locale            text not null check (locale in ('fr', 'en', 'ar')),
  -- Snapshot des données nécessaires au rendu -- jamais une dépendance
  -- au catalogue/tarifs courants au moment de l'envoi (mandat,
  -- littéral). Ne contient QUE des champs propres à la commande, déjà
  -- arrêtés par create_order (order_number/total/currency/service_mode/
  -- public_token/created_at) -- JAMAIS l'identité d'expéditeur (résolue
  -- fraîche depuis merchant_notification_profile au moment de l'envoi,
  -- voir claim_pending_notifications -- documenté README-AUDIT.md §7).
  payload_snapshot  jsonb not null,
  status            text not null default 'pending' check (status in (
    'pending', 'skipped_no_email', 'skipped_disabled',
    'processing', 'sent', 'failed_retryable', 'failed_terminal'
  )),
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  next_attempt_at   timestamptz,
  claim_token       uuid,
  claimed_at        timestamptz,
  claim_expires_at  timestamptz,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  failed_at         timestamptz,
  -- v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 : taxonomie FERMÉE,
  -- IDENTIQUE à celle de notification_delivery_attempt.error_class
  -- plus bas et à lib/server/notifications/notification-error-
  -- taxonomy.ts (NOTIFICATION_ERROR_TAXONOMY) -- une seule autorité de
  -- classification, jamais deux ensembles divergents. Défense en
  -- profondeur uniquement ; l'autorité PRINCIPALE est la normalisation
  -- applicative AVANT tout appel RPC.
  last_error_code   text check (last_error_code is null or last_error_code in (
    'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_TEMPORARY_UNAVAILABLE',
    'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_CONFIGURATION_ERROR',
    'INVALID_RECIPIENT', 'TEMPLATE_RENDER_ERROR',
    'SENDER_IDENTITY_UNRESOLVED', 'RECIPIENT_EMAIL_MISSING', 'PAYLOAD_SNAPSHOT_MALFORMED',
    'UNKNOWN_PROVIDER_ERROR'
  )),
  -- IDEMPOTENCE (mandat, littéral) : "Only one logical ORDER_RECEIVED
  -- notification may exist for one order" -- appliqué au niveau base,
  -- pas seulement applicatif.
  constraint notification_outbox_logical_uniqueness
    unique (restaurant_id, order_id, notification_type),
  -- Les trois champs de claim sont tous nuls ou tous renseignés
  -- ensemble -- même garde que stuart_provider_events.
  constraint notification_outbox_claim_fields_together
    check (
      (claim_token is null and claimed_at is null and claim_expires_at is null)
      or (claim_token is not null and claimed_at is not null and claim_expires_at is not null)
    )
);

comment on table public.notification_outbox is
  'N1-A — file durable des notifications e-mail. RPC-only (aucune policy RLS, aucun GRANT table, y compris service_role) -- accès exclusivement via create_order_received_notification / claim_pending_notifications / complete_notification_attempt / reap_stale_notification_claims (toutes SECURITY DEFINER, service_role uniquement). payload_snapshot ne contient QUE des champs de commande déjà arrêtés -- jamais de donnée catalogue mutable, jamais l''identité d''expéditeur du marchand.';

alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from public, anon, authenticated, service_role;

create index idx_notification_outbox_claimable
  on public.notification_outbox (status, next_attempt_at)
  where status in ('pending', 'failed_retryable');

create index idx_notification_outbox_restaurant
  on public.notification_outbox (restaurant_id);

-- =============================================================================
-- 3. notification_delivery_attempt — même patron RPC-only.
-- =============================================================================
create table public.notification_delivery_attempt (
  id                   uuid primary key default gen_random_uuid(),
  outbox_id            uuid not null references public.notification_outbox(id) on delete cascade,
  attempt_number       integer not null check (attempt_number >= 1),
  provider             text not null check (length(provider) between 1 and 40),
  started_at           timestamptz not null,
  completed_at         timestamptz not null default now(),
  -- 'skipped' : couvre le cas défensif où une ligne outbox atteindrait
  -- ce stade sans jamais devoir être envoyée (garde de cohérence, ne
  -- devrait structurellement jamais se produire puisque
  -- skipped_no_email/skipped_disabled sont tranchés AVANT toute mise en
  -- file 'pending' -- voir create_order_received_notification).
  result               text not null check (result in ('success', 'retryable_failure', 'terminal_failure', 'skipped')),
  provider_message_id  text check (provider_message_id is null or length(provider_message_id) <= 200),
  -- Classification NORMALISÉE uniquement -- jamais un message brut de
  -- prestataire, jamais un jeton de suivi (mandat, littéral : "Do NOT
  -- store tracking tokens in logs/error fields" / "normalized error
  -- classification"). v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 :
  -- taxonomie FERMÉE (égalité stricte contre un ensemble connu),
  -- remplace l'ancienne garde longueur+regex hexadécimale (jugée
  -- insuffisante -- un secret en FORME UUID, ex.
  -- 'dddddddd-0000-4000-8000-000000000001', contient des tirets qui
  -- cassent la détection de séquence hexadécimale continue et
  -- contournaient donc l'ancien filtre). Défense en profondeur
  -- uniquement -- l'autorité PRINCIPALE est
  -- normalizeNotificationErrorCode() côté application, appelée AVANT
  -- tout appel à complete_notification_attempt.
  error_class          text check (error_class is null or error_class in (
    'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_TEMPORARY_UNAVAILABLE',
    'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_CONFIGURATION_ERROR',
    'INVALID_RECIPIENT', 'TEMPLATE_RENDER_ERROR',
    'SENDER_IDENTITY_UNRESOLVED', 'RECIPIENT_EMAIL_MISSING', 'PAYLOAD_SNAPSHOT_MALFORMED',
    'UNKNOWN_PROVIDER_ERROR'
  )),
  constraint notification_delivery_attempt_unique_per_outbox
    unique (outbox_id, attempt_number)
);

comment on table public.notification_delivery_attempt is
  'N1-A — journal d''audit des tentatives d''envoi. RPC-only, écrit exclusivement par complete_notification_attempt. error_class est une classification NORMALISÉE (jamais un message brut de prestataire, jamais un jeton) -- v1.2 : garde structurelle par TAXONOMIE FERMÉE (CHECK ... IN, égalité stricte contre un ensemble connu, identique à notification_outbox.last_error_code et à NOTIFICATION_ERROR_TAXONOMY côté application) -- remplace l''ancienne garde longueur+regex hexadécimale, insuffisante contre un secret en forme UUID.';

alter table public.notification_delivery_attempt enable row level security;
revoke all on public.notification_delivery_attempt from public, anon, authenticated, service_role;

create index idx_notification_delivery_attempt_outbox
  on public.notification_delivery_attempt (outbox_id);

-- =============================================================================
-- 4. create_order_received_notification — SEULE autorité d'insertion
--    ORDER_RECEIVED. Appelée par create_order (même transaction) ET
--    directement testable (service_role) pour la garde anti-substitution
--    tenant croisée.
-- =============================================================================
create function public.create_order_received_notification(
  p_order_id      uuid,
  p_restaurant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order       public.orders%rowtype;
  v_profile     public.merchant_notification_profile%rowtype;
  v_locale      text;
  v_status      text;
  v_payload     jsonb;
  v_outbox_id   uuid;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- Substitution tenant croisée : refusée structurellement, jamais une
  -- simple absence de résultat silencieuse (mandat : "cross-tenant
  -- order_id substitution fails").
  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %', p_order_id, p_restaurant_id
      using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  -- Snapshot déterministe de la locale -- jamais réinféré plus tard.
  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language else 'fr' end;

  -- Éligibilité (mandat §"ORDER EMAIL ELIGIBILITY") : choix retenu --
  -- TOUJOURS une ligne outbox créée (auditabilité maximale), jamais
  -- absente, mais marquée 'skipped_*' (jamais 'pending') quand l'envoi
  -- n'est structurellement pas applicable. Alternative rejetée (aucune
  -- ligne du tout) documentée README-AUDIT.md §"ORDER EMAIL
  -- ELIGIBILITY". Le format de v_order.customer_email est déjà garanti
  -- par create_order lui-même (regex appliquée avant toute insertion) --
  -- ce contrôle ne revérifie donc QUE la présence, jamais le format.
  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    else 'pending'
  end;

  v_payload := jsonb_build_object(
    'order_number', v_order.order_number,
    'total', v_order.total,
    'currency', v_order.currency,
    'service_mode', v_order.service_mode,
    'public_token', v_order.public_token,
    'created_at', v_order.created_at
  );

  insert into public.notification_outbox (
    restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status
  ) values (
    p_restaurant_id, p_order_id, 'order_received', v_order.customer_email, v_locale, v_payload, v_status
  )
  on conflict (restaurant_id, order_id, notification_type) do nothing
  returning id into v_outbox_id;

  -- v_outbox_id reste NULL si une ligne logique existait déjà (rejeu
  -- idempotent, mandat : "Retries must not create duplicate outbox
  -- rows" / "Repeated order hooks must not create duplicate logical
  -- notifications") -- ce n'est PAS une erreur.
  return v_outbox_id;
end $$;

comment on function public.create_order_received_notification(uuid, uuid) is
  'N1-A — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente (ON CONFLICT DO NOTHING sur (restaurant_id, order_id, notification_type)). Refuse toute substitution tenant croisée (order_id/restaurant_id incohérents). Appelée par create_order dans la MÊME transaction (atomique) -- également accessible directement à service_role pour test/rejeu défensif.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- =============================================================================
-- 5. claim_pending_notifications — FOR UPDATE SKIP LOCKED + bail, calqué
--    sur claim_stuart_provider_events. Résout l'identité d'expéditeur
--    FRAÎCHE (jointure sur le restaurant_id de la ligne outbox elle-même
--    -- jamais une valeur fournie par l'appelant -- garantit
--    structurellement qu'un worker ne peut jamais envoyer la commande
--    d'un tenant avec l'expéditeur d'un autre, mandat : "worker cannot
--    send order B using merchant A sender configuration").
-- =============================================================================
create function public.claim_pending_notifications(
  p_batch_size    integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  outbox_id           uuid,
  restaurant_id       uuid,
  order_id            uuid,
  notification_type   text,
  recipient_email      text,
  locale              text,
  payload_snapshot    jsonb,
  attempt_count       integer,
  claim_token         uuid,
  sender_name         text,
  sender_email        text,
  reply_to            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 10), 100));
  v_lease      integer := greatest(1, least(coalesce(p_lease_seconds, 60), 3600));
begin
  return query
  with eligible as (
    select o.id
    from public.notification_outbox o
    where o.status in ('pending', 'failed_retryable')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
    order by o.created_at, o.id
    limit v_batch_size
    for update skip locked
  ),
  claimed as (
    update public.notification_outbox o
    set status = 'processing',
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => v_lease)
    from eligible
    where o.id = eligible.id
    returning o.id, o.restaurant_id, o.order_id, o.notification_type,
              o.recipient_email, o.locale, o.payload_snapshot, o.attempt_count, o.claim_token
  )
  select
    c.id, c.restaurant_id, c.order_id, c.notification_type,
    c.recipient_email, c.locale, c.payload_snapshot, c.attempt_count, c.claim_token,
    p.sender_name, p.sender_email, p.reply_to
  from claimed c
  left join public.merchant_notification_profile p on p.restaurant_id = c.restaurant_id
  order by c.id;
end $$;

comment on function public.claim_pending_notifications(integer, integer) is
  'N1-A — réclame un lot de notifications éligibles (FOR UPDATE SKIP LOCKED + bail, calqué sur claim_stuart_provider_events). Résout l''identité d''expéditeur FRAÎCHE via jointure sur le restaurant_id de la ligne outbox elle-même -- jamais un restaurant_id fourni par l''appelant -- garantit structurellement l''isolation tenant du worker. Deux workers concurrents ne peuvent jamais réclamer la même ligne (verrouillage ligne + SKIP LOCKED). Fenêtre de crash résiduelle documentée README-AUDIT.md §10 (reap_stale_notification_claims).';

revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer, integer) to service_role;

-- =============================================================================
-- 6. complete_notification_attempt — seule autorité de transition
--    d'état + barème de reprise (30s/120s/600s/1800s, 5 tentatives max --
--    calqué EXACTEMENT sur update_stuart_provider_event_processing_
--    status).
-- =============================================================================
create function public.complete_notification_attempt(
  p_outbox_id           uuid,
  p_claim_token         uuid,
  p_attempt_number      integer,
  p_provider            text,
  p_result              text,
  p_provider_message_id text default null,
  p_error_class         text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_retry_attempts constant integer := 5;
  v_row               public.notification_outbox%rowtype;
  v_new_attempt_count integer;
  v_next_attempt_at   timestamptz;
  v_new_status        text;
begin
  if p_result not in ('success', 'retryable_failure', 'terminal_failure', 'skipped') then
    raise exception 'SCANYM_NOTIFICATION_INVALID_RESULT: % invalide', p_result using errcode = '22023';
  end if;

  select * into v_row
  from public.notification_outbox
  where id = p_outbox_id
  for update;

  if not found then
    raise exception 'SCANYM_NOTIFICATION_NOT_FOUND: ligne outbox % introuvable', p_outbox_id using errcode = 'P0002';
  end if;

  -- Jeton de claim invalide/périmé/statut inattendu : refusé
  -- structurellement -- protège contre une double complétion par deux
  -- workers concurrents et contre la complétion d'une réclamation
  -- expirée (récupérée entretemps par reap_stale_notification_claims).
  if v_row.status <> 'processing' or v_row.claim_token is distinct from p_claim_token
     or v_row.claim_expires_at is null or v_row.claim_expires_at <= now() then
    raise exception 'SCANYM_NOTIFICATION_CLAIM_INVALID: jeton de réclamation invalide/périmé pour %', p_outbox_id
      using errcode = '42501';
  end if;

  insert into public.notification_delivery_attempt (
    outbox_id, attempt_number, provider, started_at, completed_at, result, provider_message_id, error_class
  ) values (
    p_outbox_id, p_attempt_number, p_provider, coalesce(v_row.claimed_at, now()), now(), p_result,
    p_provider_message_id, p_error_class
  );

  if p_result = 'success' then
    v_new_status := 'sent';
    v_new_attempt_count := v_row.attempt_count + 1;
    v_next_attempt_at := null;
  elsif p_result = 'skipped' then
    v_new_status := v_row.status; -- garde défensive, ne devrait jamais être atteint (voir commentaire de table)
    v_new_attempt_count := v_row.attempt_count;
    v_next_attempt_at := null;
  else
    v_new_attempt_count := v_row.attempt_count + 1;
    if p_result = 'terminal_failure' or v_new_attempt_count >= c_max_retry_attempts then
      v_new_status := 'failed_terminal';
      v_next_attempt_at := null;
    else
      v_new_status := 'failed_retryable';
      v_next_attempt_at := now() + make_interval(secs =>
        case v_new_attempt_count
          when 1 then 30
          when 2 then 120
          when 3 then 600
          else 1800
        end);
    end if;
  end if;

  update public.notification_outbox
  set status = v_new_status,
      attempt_count = v_new_attempt_count,
      next_attempt_at = v_next_attempt_at,
      claim_token = null,
      claimed_at = null,
      claim_expires_at = null,
      sent_at = case when v_new_status = 'sent' then now() else sent_at end,
      failed_at = case when v_new_status = 'failed_terminal' then now() else failed_at end,
      last_error_code = case when p_result in ('retryable_failure', 'terminal_failure') then p_error_class else last_error_code end
  where id = p_outbox_id;
end $$;

comment on function public.complete_notification_attempt(uuid, uuid, integer, text, text, text, text) is
  'N1-A — seule autorité de transition d''état de notification_outbox après une tentative. Barème de reprise 30s/120s/600s/1800s, 5 tentatives max, calqué sur update_stuart_provider_event_processing_status. AUCUNE autorité sur orders/paiement/Stuart/facture/suivi/fulfillment -- observateur uniquement.';

revoke all on function public.complete_notification_attempt(uuid, uuid, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_notification_attempt(uuid, uuid, integer, text, text, text, text) to service_role;

-- =============================================================================
-- 7. reap_stale_notification_claims — balayage de récupération après
--    crash, calqué sur reap_stale_stuart_delivery_job_send_started.
-- =============================================================================
create function public.reap_stale_notification_claims(
  p_batch_size integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 100), 1000));
  v_count      integer;
begin
  with stale as (
    select id
    from public.notification_outbox
    where status = 'processing'
      and claim_expires_at is not null
      and claim_expires_at < now()
    order by claimed_at
    limit v_batch_size
    for update skip locked
  )
  update public.notification_outbox o
  set status = 'pending',
      claim_token = null,
      claimed_at = null,
      claim_expires_at = null
  from stale
  where o.id = stale.id;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

comment on function public.reap_stale_notification_claims(integer) is
  'N1-A — récupère les réclamations expirées après un crash worker (bail dépassé), calqué sur reap_stale_stuart_delivery_job_send_started. Fenêtre de crash résiduelle : un worker qui plante APRÈS un envoi réussi côté prestataire mais AVANT complete_notification_attempt(''success'') verra sa ligne redevenir éligible et un futur envoi prestataire réel pourrait produire un doublon -- risque résiduel documenté (non éliminable sans idempotency-key prestataire, hors de portée du provider Fake de ce lot ; voir README-AUDIT.md §10).';

revoke all on function public.reap_stale_notification_claims(integer) from public, anon, authenticated;
grant execute on function public.reap_stale_notification_claims(integer) to service_role;

-- =============================================================================
-- 8. create_order — ajout d'UNE seule ligne (voir en-tête de fichier).
--    Corps hérité intégralement de DRAFT-lot-seller-legal-profile-cgv-
--    engine-v1-1.sql, AUCUNE autre ligne modifiée.
-- =============================================================================
create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null,
  p_cgv_accepted  boolean default false
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
  v_mode_enabled boolean;
  v_req         record;
  v_field_value text;
  v_room_number text;
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
  v_street      text;
  v_city        text;
  v_cgv_status         text;
  v_cgv_version_id     uuid;
  v_cgv_content_hash   text;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select status into v_cgv_status
  from public.merchant_cgv_profile where restaurant_id = v_restaurant.id;

  if v_cgv_status = 'CGV_ACTIVE' then
    select v.id, v.content_hash into v_cgv_version_id, v_cgv_content_hash
    from public.merchant_cgv_version v
    where v.restaurant_id = v_restaurant.id and v.status = 'ACTIVE'
    order by v.published_at desc
    limit 1;

    if v_cgv_version_id is null then
      raise exception using errcode = 'P0001', message = 'CGV_REQUIRED_BUT_NOT_PUBLISHED';
    end if;

    if not coalesce(p_cgv_accepted, false) then
      raise exception using errcode = 'P0001', message = 'CGV_ACCEPTANCE_REQUIRED';
    end if;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  select enabled into v_mode_enabled
  from public.restaurant_sale_modes
  where restaurant_id = v_restaurant.id and mode_code = p_service_mode;

  if v_mode_enabled is null or not v_mode_enabled then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');
  v_room_number := nullif(left(trim(coalesce(p_customer->>'room_number','')), 20), '');
  v_street := nullif(left(trim(coalesce(p_customer->>'street','')), 200), '');
  v_city   := nullif(left(trim(coalesce(p_customer->>'city','')), 120), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  insert into tmp_field_reqs (field, requirement, one_of_group, resolved_value)
  select x.field, x.requirement, x.one_of_group,
    case x.field
      when 'customer_name' then v_name
      when 'phone' then v_phone
      when 'email' then v_email
      when 'delivery_address' then v_address
      when 'table_number' then p_table_number::text
      when 'room_number' then v_room_number
      else null
    end
  from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;

  for v_req in select field, resolved_value from tmp_field_reqs where requirement = 'required' loop
    if v_req.resolved_value is null then
      raise exception 'Champ requis manquant pour ce mode: %', v_req.field;
    end if;
  end loop;

  for v_req in
    select one_of_group, bool_or(resolved_value is not null) as satisfied
    from tmp_field_reqs
    where requirement = 'one_of' and one_of_group is not null
    group by one_of_group
  loop
    if not v_req.satisfied then
      raise exception 'Au moins un champ du groupe % est requis', v_req.one_of_group;
    end if;
  end loop;

  if p_service_mode = 'delivery' then
    select exists (
      select 1
      from public.restaurant_sale_mode_fulfillments f
      join public.restaurant_sale_modes rsm
        on rsm.restaurant_id = f.restaurant_id and rsm.mode_code = f.mode_code
      where f.restaurant_id = v_restaurant.id
        and f.mode_code = p_service_mode
        and f.enabled = true
        and rsm.enabled = true
    ) into v_new_engine;

    if v_new_engine then
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      v_postal := substring(v_address from '\m(\d{5})\M');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;

      select p into v_zone
      from public.restaurant_sale_modes rsm,
           jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p
      where rsm.restaurant_id = v_restaurant.id and rsm.mode_code = 'delivery'
        and v_postal like p || '%'
      limit 1;

      if v_zone is null then
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number, room_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    case when p_service_mode = 'room_service' then v_room_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  if p_service_mode = 'delivery' and v_address is not null then
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city)
    values (v_order_id, v_address, v_postal, v_street, v_city);
  end if;

  if v_cgv_version_id is not null then
    insert into public.order_cgv_acceptance (
      order_id, restaurant_id, cgv_version_id, content_hash,
      accepted_at, acceptance_channel, locale, terms_url
    ) values (
      v_order_id, v_restaurant.id, v_cgv_version_id, v_cgv_content_hash,
      now(), 'web_checkout',
      nullif(left(trim(coalesce(p_language,'')), 10), ''),
      '/legal/' || v_restaurant.slug
    );
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    declare
      v_delivery_min_items integer;
    begin
      select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
      from public.restaurant_sale_modes
      where restaurant_id = v_restaurant.id and mode_code = 'delivery';

      if v_qty_total < coalesce(v_delivery_min_items, 0) then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_delivery_min_items, v_qty_total;
      end if;
    end;
  elsif p_service_mode = 'delivery' and v_new_engine then
    select * into v_resolved
    from public.resolve_delivery_fulfillment(v_restaurant.id, p_service_mode, v_postal, v_qty_total, v_subtotal);

    if not v_resolved.eligible then
      if v_resolved.block = 'no-postal' then
        raise exception 'Code postal absent de l''adresse';
      elsif v_resolved.block = 'below-min' then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_resolved.min_items, v_qty_total;
      else
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;

    v_zone := v_resolved.matched_prefix;
    v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);
    v_fulfillment_rule_id := v_resolved.fulfillment_rule_id;
    v_fulfillment_code := v_resolved.fulfillment_code;
    v_provider_code := v_resolved.provider;
  end if;

  update public.orders
  set subtotal = v_subtotal,
      delivery_fee = v_delivery_fee,
      total = v_subtotal + v_delivery_fee,
      fulfillment_rule_id = v_fulfillment_rule_id,
      fulfillment_code = v_fulfillment_code,
      provider_code = v_provider_code
  where id = v_order_id;

  -- N1-A — SEULE ligne ajoutée à ce corps hérité. Même transaction
  -- implicite que la commande (PL/pgSQL) : un échec ici annule la
  -- commande avec lui, garantissant qu'une commande validée ne perd
  -- JAMAIS silencieusement son événement ORDER_RECEIVED (mandat,
  -- littéral : "a committed order does not silently lose its initial
  -- notification event"). N'envoie AUCUN e-mail -- insertion d'une
  -- ligne outbox déterministe uniquement.
  perform public.create_order_received_notification(v_order_id, v_restaurant.id);

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

revoke all on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) from public;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to anon;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to authenticated;

-- =============================================================================
-- POSTCONTRÔLES
-- =============================================================================
do $$
begin
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_result(p.oid) = 'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  ) <> 1 then
    raise exception 'SCANYM_POSTCHECK_FAILED: create_order n''a plus exactement 6 colonnes de sortie après migration.';
  end if;

  if not has_function_privilege('anon', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_REGRESSION: anon a perdu EXECUTE sur create_order.';
  end if;
  if not has_function_privilege('authenticated', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_REGRESSION: authenticated a perdu EXECUTE sur create_order.';
  end if;
  if has_function_privilege('public', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_SECURITY_DRIFT: PUBLIC dispose d''EXECUTE sur create_order.';
  end if;

  if has_table_privilege('anon', 'public.notification_outbox', 'SELECT')
     or has_table_privilege('authenticated', 'public.notification_outbox', 'SELECT')
     or has_table_privilege('public', 'public.notification_outbox', 'SELECT') then
    raise exception 'SCANYM_SECURITY_DRIFT: notification_outbox lisible en dehors de service_role via GRANT direct.';
  end if;

  if has_table_privilege('anon', 'public.notification_delivery_attempt', 'SELECT')
     or has_table_privilege('authenticated', 'public.notification_delivery_attempt', 'SELECT')
     or has_table_privilege('public', 'public.notification_delivery_attempt', 'SELECT') then
    raise exception 'SCANYM_SECURITY_DRIFT: notification_delivery_attempt lisible en dehors de service_role via GRANT direct.';
  end if;

  if has_table_privilege('anon', 'public.merchant_notification_profile', 'SELECT') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon dispose d''un SELECT direct sur merchant_notification_profile.';
  end if;
  if not has_table_privilege('authenticated', 'public.merchant_notification_profile', 'SELECT') then
    raise exception 'SCANYM_POSTCHECK_FAILED: authenticated devrait disposer d''un SELECT (gated RLS) sur merchant_notification_profile.';
  end if;
  if has_table_privilege('authenticated', 'public.merchant_notification_profile', 'INSERT')
     or has_table_privilege('authenticated', 'public.merchant_notification_profile', 'UPDATE') then
    raise exception 'SCANYM_SECURITY_DRIFT: authenticated dispose d''un GRANT table direct en écriture sur merchant_notification_profile (doit passer par set_merchant_notification_profile).';
  end if;

  if not has_function_privilege('service_role', 'public.claim_pending_notifications(integer,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.complete_notification_attempt(uuid,uuid,integer,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.create_order_received_notification(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reap_stale_notification_claims(integer)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: service_role devrait disposer d''EXECUTE sur les 4 fonctions worker N1-A.';
  end if;

  if has_function_privilege('anon', 'public.claim_pending_notifications(integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_pending_notifications(integer,integer)', 'EXECUTE') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon/authenticated disposent d''EXECUTE sur claim_pending_notifications.';
  end if;

  -- v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 : les deux colonnes de
  -- diagnostic doivent être contraintes par la taxonomie FERMÉE
  -- (défense en profondeur), plus l'ancienne garde longueur+regex
  -- hexadécimale (remplacée, jugée insuffisante contre un secret en
  -- forme UUID -- voir adversarial tests SQL harness).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notification_delivery_attempt'::regclass
      and pg_get_constraintdef(oid) like '%UNKNOWN_PROVIDER_ERROR%'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: notification_delivery_attempt.error_class n''a plus de contrainte de taxonomie fermée.';
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.notification_delivery_attempt'::regclass
      and pg_get_constraintdef(oid) like '%[0-9a-f]{16,}%'
  ) then
    raise exception 'SCANYM_REGRESSION: notification_delivery_attempt.error_class utilise encore l''ancienne garde regex hexadécimale (v1.2 doit l''avoir remplacée).';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notification_outbox'::regclass
      and pg_get_constraintdef(oid) like '%UNKNOWN_PROVIDER_ERROR%'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: notification_outbox.last_error_code n''a plus de contrainte de taxonomie fermée.';
  end if;
end $$;
