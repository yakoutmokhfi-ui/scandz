-- ============================================================
-- Scanym — PAYMENT FOUNDATION P1 (DATABASE + SERVER AUTHORITY) — v3
-- CORRECTION ÉTROITE APRÈS AUDIT INDÉPENDANT DE LA v2 (DRAFT — NON
-- APPLIQUÉ EN PRODUCTION, P1 n'a JAMAIS été publié — cette version
-- REMPLACE intégralement la v2, reconstruite depuis le baseline réel
-- `origin/main` = 3ae0f2e7a15b37db59760322be71eff290c450dd, jamais
-- depuis un état hypothétique déjà fusionné).
--
-- Verdict Work audit v2 : « FAIL — PAYMENT P1 FOUNDATION v2 —
-- CORRECTION REQUIRED », porté PAR UN SEUL constat nouveau,
-- PAY-P1-V2-01 (MEDIUM) : orders.current_payment_transaction_id
-- n'était protégé que par une FK À UNE SEULE COLONNE vers
-- payment_transactions(id) -- elle garantissait l'EXISTENCE de la
-- tentative pointée, jamais son APPARTENANCE à la même commande.
-- L'audit a démontré concrètement (accès superutilisateur direct)
-- qu'un pointeur pouvait être forcé vers une tentative d'une AUTRE
-- commande / d'un AUTRE tenant sans qu'aucune contrainte ne le
-- bloque. Les constats PAY-P1-01 à 07 étaient déjà fermés et
-- confirmés indépendamment -- AUCUN d'entre eux n'est rouvert ni
-- modifié par cette version : correction strictement bornée à
-- PAY-P1-V2-01. Les constats V2-02 (écart arithmétique de rapport de
-- tests, cosmétique) / V2-03 (absence d'expiration des tentatives
-- pending, hors périmètre P1) / V2-04 (bypass superutilisateur
-- inhérent au modèle de privilèges PostgreSQL, pas un défaut du lot)
-- sont non bloquants et ne nécessitent aucune correction de schéma.
--
-- CORRECTION PAY-P1-V2-01 (voir section 4/5) : orders.id +
-- orders.current_payment_transaction_id référencent désormais
-- ENSEMBLE, via une FK COMPOSITE, payment_transactions.order_id +
-- payment_transactions.id -- structurellement, PostgreSQL refuse
-- désormais qu'une commande pointe vers une tentative de paiement
-- n'appartenant pas à elle-même, y compris en accès superutilisateur
-- direct (même garantie de niveau base que celle déjà appliquée à
-- payment_transactions.order_id/restaurant_id -> orders.id/
-- restaurant_id sous PAY-P1-11).
--
-- Verdict Work audit initial (v1) : « FAIL — PAYMENT P1 GENERIC
-- FOUNDATION — CORRECTION REQUIRED ». Findings fermés dès la v2
-- (inchangés depuis) :
--   PAY-P1-01 (HIGH)   plusieurs tentatives actives / plusieurs payées
--                       possibles -> voir section 4 (index uniques
--                       partiels) + section 8/9 (machine à états).
--   PAY-P1-02 (HIGH)   un callback ancien pouvait écraser l'état de
--                       la commande alors qu'une tentative plus
--                       récente était active -> voir section 7
--                       (pointeur current_payment_transaction_id) +
--                       section 9 (verrouillage terminal).
--   PAY-P1-03 (MEDIUM) service_role avait un GRANT direct
--                       INSERT/UPDATE sur payment_transactions,
--                       contournant les invariants des RPC -> RETIRÉ
--                       (voir section 6, RPC-ONLY AUTHORITY).
--   PAY-P1-04 (MEDIUM) normalisation insuffisante de
--                       provider_code/provider_reference -> voir
--                       section 5 (trim + jeu de caractères sûr pour
--                       provider_code, trim seul pour
--                       provider_reference, AUCUNE mise en
--                       minuscule imposée).
--   PAY-P1-05 (MEDIUM) tests manquant des scénarios de concurrence
--                       critiques -> voir
--                       supabase/tests/payment-p1-foundation-check.sh
--                       (sessions concurrentes réelles, PAS de
--                       simulation).
--   PAY-P1-06 (LOW)    vérification du helper par nom de fonction
--                       seul -> section 3, vérifie désormais la
--                       signature exacte (arguments, type de retour).
--   PAY-P1-07 (INFO)   montant zéro / sémantique remboursement ->
--                       décisions explicites sections 10 et 11.
--
-- PÉRIMÈTRE INCHANGÉ (toujours strictement hors périmètre) : aucun
-- adaptateur Monetico, aucune configuration Monetico/CIC, aucun
-- credential, aucun Vault/pgsodium/pgcrypto, aucun back-office
-- marchand, aucune intégration au tunnel de commande actif, aucun
-- email transactionnel, aucune exécution Production, aucun push,
-- aucun déploiement.
--
-- CE FICHIER EST GÉNÉRIQUE (aucun nom de prestataire codé en dur) et
-- DÉTERMINISTE — compatible PostgreSQL 17.6, même patron que les lots
-- précédents. Réutilise TEL QUEL public.is_member_of /
-- public.has_role_in (migration-orders.sql).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'total'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.total introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'restaurants'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurants introuvable -- prérequis manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.is_member_of introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_role_in'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.has_role_in introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.touch_updated_at introuvable -- prérequis migration-v55-updated-at.sql manquant, migration annulée.';
  end if;

  -- Garde anti double-application (couvre aussi la v2 corrigée : si
  -- payment_status ou current_payment_transaction_id existent déjà,
  -- ce lot -- initial OU corrigé -- a déjà été appliqué).
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.payment_status existe déjà -- migration déjà appliquée, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'current_payment_transaction_id'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.current_payment_transaction_id existe déjà -- migration déjà appliquée, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_transactions'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_transactions existe déjà -- migration déjà appliquée, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_provider_configs'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_configs existe déjà -- migration déjà appliquée, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. CORRECTION PAY-P1-06 (LOW) — HELPER scanym_numeric_is_non_finite.
-- Ne vérifie plus seulement le NOM de la fonction (insuffisant : une
-- fonction homonyme avec une signature différente aurait pu passer la
-- garde silencieusement) -- vérifie désormais la SIGNATURE EXACTE
-- (1 argument numeric, retour boolean) avant de décider si la
-- création est nécessaire. Créée avec les mêmes caractéristiques
-- déterministes que l'original (DRAFT-lot-merchant-delivery-pricing.sql,
-- correction DDP-V1-01) : IMMUTABLE, sans accès table, comparaison
-- d'égalité explicite contre les 3 valeurs spéciales (PostgreSQL a un
-- ordre non-IEEE-754 sur `numeric` où `'NaN'::numeric > 0` est VRAI et
-- `x <> x` échoue aussi).
-- ------------------------------------------------------------
do $$
declare
  v_has_exact_signature boolean;
begin
  select exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
    where n.nspname = 'public'
      and p.proname = 'scanym_numeric_is_non_finite'
      and rt.typname = 'bool'
      and p.pronargs = 1
      and (p.proargtypes::regtype[])[0] = 'numeric'::regtype
  ) into v_has_exact_signature;

  if not v_has_exact_signature then
    create or replace function public.scanym_numeric_is_non_finite(p numeric)
    returns boolean
    language sql
    immutable
    as $func$
      select coalesce(
        p = 'NaN'::numeric or p = 'Infinity'::numeric or p = '-Infinity'::numeric,
        false
      );
    $func$;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. orders.payment_status — MACHINE À ÉTATS SÉPARÉE de orders.status
-- (cycle cuisine, INCHANGÉ). not_required est la valeur par défaut.
--
-- CORRECTION SECTION 11 (REFUND STATUS DECISION) : 'refunded' est
-- RETIRÉ de l'énumération dans cette v2 corrigée. Le modèle initial le
-- laissait présent sans colonne refunded_at ni mécanisme de
-- transition -- un état d'énumération atteignable par aucune fonction
-- est un schéma incohérent (Work finding PAY-P1-07). Un remboursement
-- réel introduira sa PROPRE colonne refunded_at et sa PROPRE fonction
-- de transition dans un lot dédié et cohérent -- pas une valeur
-- d'énumération orpheline aujourd'hui.
-- ------------------------------------------------------------
alter table public.orders
  add column payment_status text not null default 'not_required'
    check (payment_status in ('not_required','pending','paid','failed','cancelled'));

create index if not exists idx_orders_payment_status
  on public.orders(restaurant_id, payment_status);

comment on column public.orders.payment_status is
  'Machine à états du PAIEMENT, INDÉPENDANTE de orders.status (cycle cuisine). not_required = aucun paiement en ligne concerné (défaut, comportement historique). pending/paid/failed/cancelled = reflète EXCLUSIVEMENT la tentative pointée par current_payment_transaction_id -- jamais mis à jour par une tentative non courante (voir confirm_payment_attempt). Remboursement explicitement hors périmètre P1 (aucune valeur refunded ici -- lot dédié futur).';

-- ------------------------------------------------------------
-- 4. payment_transactions — "1 commande -> N tentatives de paiement",
-- avec CORRECTION PAY-P1-01/02 : au plus UNE tentative ACTIVE
-- (status='pending') et au plus UNE tentative PAYÉE (status='paid')
-- par commande, appliqué au NIVEAU BASE via deux index uniques
-- PARTIELS -- jamais seulement une vérification applicative dans les
-- RPC (celles-ci restent une première ligne de défense pour un
-- message d'erreur clair, mais l'index est le garant final, y compris
-- contre un futur bug serveur ou un accès direct par un rôle de
-- confiance).
--
-- CORRECTION PAY-P1-04 : provider_code/provider_reference sont
-- normalisés (trim) AVANT stockage par les deux RPC ci-dessous --
-- contrainte CHECK ici en défense en profondeur, garantissant qu'une
-- valeur stockée est TOUJOURS déjà triminée, quel que soit le chemin
-- d'écriture. provider_code est en outre restreint à un jeu de
-- caractères sûr et générique (lettres/chiffres/tiret/underscore) --
-- AUCUNE mise en minuscule imposée (la casse d'origine du prestataire
-- est préservée telle quelle, aucune convention de casse n'étant
-- encore définie par l'architecture à ce stade).
--
-- CORRECTION PAY-P1-07 (montant zéro) : `amount > 0` (strictement),
-- plus strict que la version initiale (`>= 0`) -- décision explicite
-- section 10 : aucune tentative de paiement en ligne n'est jamais
-- créée pour une commande à 0.00, donc aucune ligne payment_transactions
-- ne devrait jamais légitimement porter un montant nul.
--
-- CORRECTION PAY-P1-11 (isolation tenant structurelle) : order_id et
-- restaurant_id ne sont plus deux FK indépendantes -- la paire est
-- liée par une FK COMPOSITE vers orders(id, restaurant_id) (rendue
-- possible par la contrainte unique(id, restaurant_id) ajoutée sur
-- orders ci-dessous). Un couple order_id/restaurant_id incohérent est
-- désormais REJETÉ AU NIVEAU BASE, y compris par un rôle de confiance
-- accédant directement à la table -- pas seulement par la logique des
-- RPC.
-- ------------------------------------------------------------
alter table public.orders
  add constraint orders_id_restaurant_id_unique unique (id, restaurant_id);

create table public.payment_transactions (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id) on delete restrict,
  order_id            uuid not null,

  provider_code       text not null
                       check (length(provider_code) between 1 and 40)
                       check (provider_code = btrim(provider_code))
                       check (provider_code ~ '^[a-zA-Z0-9_-]+$'),

  provider_reference  text not null
                       check (length(provider_reference) between 1 and 100)
                       check (provider_reference = btrim(provider_reference)),

  status              text not null default 'pending'
                       check (status in ('pending','paid','failed','cancelled')),

  -- Montant/devise TOUJOURS dérivés SERVEUR depuis orders.total /
  -- orders.currency au moment de la création de la tentative (voir
  -- initiate_payment_attempt) -- jamais une valeur fournie par le
  -- navigateur.
  amount              numeric(12,2) not null check (amount > 0),
  currency            varchar(10) not null,

  -- Référence d'autorisation bancaire si fournie par le prestataire
  -- (ex. futur `numauto` Monetico) -- champ non sensible, technique.
  authorization_reference text check (authorization_reference is null or length(authorization_reference) <= 100),

  created_at          timestamptz not null default now(),
  paid_at             timestamptz,
  failed_at           timestamptz,
  cancelled_at        timestamptz,

  constraint payment_transactions_amount_finite
    check (not public.scanym_numeric_is_non_finite(amount)),

  constraint payment_transactions_paid_at_consistency
    check ((status = 'paid') = (paid_at is not null)),
  constraint payment_transactions_failed_at_consistency
    check ((status = 'failed') = (failed_at is not null)),
  constraint payment_transactions_cancelled_at_consistency
    check ((status = 'cancelled') = (cancelled_at is not null)),

  -- Unicité fonctionnelle prestataire : jamais unique par order_id
  -- seul (N tentatives par commande autorisées dans le temps).
  unique (provider_code, provider_reference),

  -- CORRECTION PAY-P1-11 : FK composite -- rejette structurellement
  -- tout couple (order_id, restaurant_id) qui ne correspond pas à une
  -- commande RÉELLE de CE restaurant, quel que soit l'appelant.
  constraint payment_transactions_order_restaurant_fk
    foreign key (order_id, restaurant_id) references public.orders(id, restaurant_id) on delete restrict,

  -- CORRECTION PAY-P1-V2-01 : support de clé composite pour la FK
  -- ajoutée sur orders.current_payment_transaction_id (section 5
  -- ci-dessous). id étant déjà clé primaire, cette contrainte unique
  -- est triviale à satisfaire mais nécessaire : PostgreSQL exige que
  -- le couple de colonnes référencé par une FK composite porte
  -- lui-même une contrainte unique/PK couvrant exactement ce couple.
  constraint payment_transactions_id_order_id_unique
    unique (id, order_id)
);

-- CORRECTION PAY-P1-01 : au plus UNE tentative ACTIVE (pending) par
-- commande -- index unique PARTIEL, appliqué au niveau base.
create unique index payment_transactions_one_active_per_order
  on public.payment_transactions (order_id)
  where status = 'pending';

-- CORRECTION PAY-P1-01/02 : au plus UNE tentative PAYÉE par commande
-- -- index unique PARTIEL, protège même contre deux confirmations
-- concurrentes ou un accès direct par un rôle de confiance.
create unique index payment_transactions_one_paid_per_order
  on public.payment_transactions (order_id)
  where status = 'paid';

create index if not exists idx_payment_transactions_order
  on public.payment_transactions(order_id);
create index if not exists idx_payment_transactions_restaurant_status
  on public.payment_transactions(restaurant_id, status);

comment on table public.payment_transactions is
  '1 commande -> N tentatives de paiement dans le temps, mais AU PLUS UNE active (pending) et AU PLUS UNE payée (paid) à tout instant -- appliqué par index uniques partiels, pas seulement par les RPC. Aucune charge utile brute du prestataire stockée. Écriture réservée aux fonctions SECURITY DEFINER (initiate_payment_attempt/confirm_payment_attempt) -- AUCUN GRANT direct (INSERT/UPDATE/DELETE) à quelque rôle applicatif que ce soit, y compris service_role (CORRECTION PAY-P1-03, RPC-ONLY AUTHORITY).';

alter table public.payment_transactions enable row level security;

create policy "personnel lit les tentatives de paiement de ses commandes"
  on public.payment_transactions
  for select using (public.is_member_of(restaurant_id));

-- CORRECTION PAY-P1-03 : AUCUN grant direct (INSERT/UPDATE/DELETE) à
-- anon/authenticated/service_role/public. La SEULE écriture possible
-- passe par les deux fonctions SECURITY DEFINER ci-dessous, qui
-- s'exécutent avec les privilèges de LEUR PROPRIÉTAIRE (pas de
-- l'appelant) et n'ont donc besoin d'AUCUN grant de table pour
-- fonctionner. authenticated conserve un SELECT en lecture seule
-- (RLS-filtré), comme avant.
revoke all on table public.payment_transactions from anon, authenticated, service_role, public;
grant select on table public.payment_transactions to authenticated;

-- ------------------------------------------------------------
-- 5. orders.current_payment_transaction_id — CORRECTION PAY-P1-02.
-- Pointeur explicite vers la tentative AUTORITAIRE actuelle. Ajouté
-- APRÈS payment_transactions (dépendance de la FK). NULL tant
-- qu'aucune tentative n'a jamais été initiée. Positionné UNIQUEMENT
-- par initiate_payment_attempt (nouvelle tentative = nouvelle
-- autorité) -- confirm_payment_attempt ne le modifie JAMAIS, il le
-- LIT pour décider si la tentative confirmée a le droit de modifier
-- orders.payment_status.
--
-- CORRECTION PAY-P1-V2-01 (audit indépendant v2, MEDIUM) : la v2
-- posait ici une FK À UNE SEULE COLONNE vers payment_transactions(id)
-- -- elle garantissait seulement que l'UUID pointé EXISTAIT quelque
-- part dans payment_transactions, jamais qu'il appartenait à CETTE
-- commande. Démontré exploitable en accès superutilisateur direct
-- (UPDATE orders SET current_payment_transaction_id = <transaction
-- d'une AUTRE commande/tenant> accepté sans erreur). Remplacée par
-- une FK COMPOSITE : (current_payment_transaction_id, id) référence
-- payment_transactions(id, order_id). PostgreSQL vérifie désormais,
-- au niveau base et pour tout appelant y compris superutilisateur,
-- que la tentative pointée porte bien order_id = orders.id --
-- structurellement impossible de faire pointer une commande vers la
-- tentative d'une autre commande. MATCH SIMPLE (comportement par
-- défaut) : la contrainte est ignorée tant que
-- current_payment_transaction_id est NULL (aucune tentative encore
-- initiée) -- orders.id, clé primaire, n'est lui-même jamais NULL.
-- ------------------------------------------------------------
alter table public.orders
  add column current_payment_transaction_id uuid;

alter table public.orders
  add constraint orders_current_payment_transaction_fk
    foreign key (current_payment_transaction_id, id)
    references public.payment_transactions(id, order_id)
    on delete restrict;

comment on column public.orders.current_payment_transaction_id is
  'Pointeur vers la tentative de paiement AUTORITAIRE actuelle (voir payment_transactions). Positionné uniquement à l''initiation d''une nouvelle tentative. Une confirmation reçue pour une tentative qui n''est PLUS la tentative courante (callback tardif/rejoué sur une tentative dépassée) ne modifie JAMAIS orders.payment_status (CORRECTION PAY-P1-02). CORRECTION PAY-P1-V2-01 : FK COMPOSITE avec orders.id vers payment_transactions(id, order_id) -- garantit STRUCTURELLEMENT (pas seulement par la logique RPC) que la tentative pointée appartient à CETTE commande ; un pointeur vers la tentative d''une autre commande est désormais REJETÉ AU NIVEAU BASE, y compris en accès superutilisateur direct.';

-- ------------------------------------------------------------
-- 6. payment_provider_configs — table NUE (AUCUN credential/secret/
-- Vault dans ce lot). CORRECTION SECTION 13 (validation générique) :
-- même durcissement provider_code (trim + jeu de caractères sûr) que
-- payment_transactions, par cohérence -- toujours AUCUNE énumération
-- de prestataire nommé.
-- ------------------------------------------------------------
create table public.payment_provider_configs (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  provider_code   text not null
                  check (length(provider_code) between 1 and 40)
                  check (provider_code = btrim(provider_code))
                  check (provider_code ~ '^[a-zA-Z0-9_-]+$'),

  mode            text not null default 'test' check (mode in ('test','live')),
  status          text not null default 'inactive'
                   check (status in ('inactive','pending_setup','active','disabled')),
  is_enabled      boolean not null default false,
  last_verified_at timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (restaurant_id, provider_code)

  -- AUCUNE colonne credentials_ref/secret/api_key/vault_id dans ce
  -- lot : explicitement hors périmètre P1.
);

comment on table public.payment_provider_configs is
  'Table NUE de configuration prestataire par tenant -- AUCUN credential/secret/Vault dans ce lot (P1). Chaque restaurant doit détenir son PROPRE contrat prestataire -- Scanym ne devient jamais le destinataire financier. Configuration technique (identifiants, bascule TEST/PROD) INFRASTRUCTURE gérée exclusivement par Scanym.';

create trigger trg_touch_updated_at
  before update on public.payment_provider_configs
  for each row execute function public.touch_updated_at();

alter table public.payment_provider_configs enable row level security;
-- Aucune policy RLS, aucun grant à anon/authenticated/service_role
-- dans ce lot -- aucun back-office marchand, aucune écriture ne se
-- produit encore sur cette table en P1.
revoke all on table public.payment_provider_configs from anon, authenticated, service_role, public;

-- ------------------------------------------------------------
-- 7. initiate_payment_attempt — SECURITY DEFINER, service_role
-- UNIQUEMENT (EXECUTE seulement -- AUCUN grant de table nécessaire,
-- voir section 4/CORRECTION PAY-P1-03).
--
-- CORRECTION PAY-P1-01/04 (INITIATION CONCURRENCY) :
--   1. Normalise (trim) provider_code/provider_reference AVANT toute
--      utilisation -- rejette si vide après trim.
--   2. Verrouille la commande (`SELECT ... FOR UPDATE`) -- toute
--      initiation concurrente sur la MÊME commande est sérialisée ici.
--   3. Sous verrou : refuse si la commande est déjà payée, refuse si
--      une commande a un montant <= 0 (CORRECTION section 10, ZERO
--      AMOUNT DECISION), refuse si une tentative ACTIVE (pending)
--      existe déjà pour cette commande -- vérification applicative en
--      première ligne, l'index unique partiel
--      payment_transactions_one_active_per_order restant le garant
--      final structurel même si cette vérification était un jour
--      contournée par un bug.
--   4. Positionne orders.current_payment_transaction_id sur la
--      NOUVELLE tentative -- elle devient l'autorité.
-- ------------------------------------------------------------
create or replace function public.initiate_payment_attempt(
  p_order_id uuid,
  p_provider_code text,
  p_provider_reference text
)
returns table (transaction_id uuid, amount numeric, currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_provider_code text;
  v_provider_reference text;
  v_transaction_id uuid;
begin
  if p_order_id is null then
    raise exception 'SCANYM_PAYMENT: p_order_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  v_provider_reference := btrim(coalesce(p_provider_reference, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;
  if length(v_provider_reference) = 0 then
    raise exception 'SCANYM_PAYMENT: p_provider_reference requis (vide après normalisation)' using errcode = '22004';
  end if;

  -- Verrou sur la commande : sérialise toute initiation concurrente
  -- pour CETTE commande (CORRECTION section 4, INITIATION CONCURRENCY).
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'SCANYM_PAYMENT: commande introuvable' using errcode = 'P0002';
  end if;

  if v_order.payment_status = 'paid' then
    raise exception 'SCANYM_PAYMENT: commande déjà payée -- nouvelle tentative refusée (fail-closed)' using errcode = '42501';
  end if;

  -- CORRECTION section 10 (ZERO AMOUNT DECISION) : aucune tentative de
  -- paiement en ligne n'est créée pour une commande dont le montant
  -- n'est pas strictement positif.
  if v_order.total <= 0 then
    raise exception 'SCANYM_PAYMENT: montant de la commande <= 0 -- aucune tentative de paiement en ligne ne peut être initiée' using errcode = '22023';
  end if;

  -- CORRECTION PAY-P1-01 : refuse une seconde tentative ACTIVE tant
  -- qu'une autre est en cours (sous le verrou commande ci-dessus,
  -- donc sans fenêtre de course pour CETTE commande) -- l'index
  -- unique partiel payment_transactions_one_active_per_order reste le
  -- garant final structurel.
  if exists (
    select 1 from public.payment_transactions
    where order_id = p_order_id and status = 'pending'
  ) then
    raise exception 'SCANYM_PAYMENT: une tentative active existe déjà pour cette commande -- nouvelle tentative refusée (une seule tentative active à la fois)' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.payment_transactions
    where order_id = p_order_id and status = 'paid'
  ) then
    raise exception 'SCANYM_PAYMENT: une tentative payée existe déjà pour cette commande -- nouvelle tentative refusée (fail-closed)' using errcode = '42501';
  end if;

  insert into public.payment_transactions (
    restaurant_id, order_id, provider_code, provider_reference,
    status, amount, currency
  ) values (
    v_order.restaurant_id, v_order.id, v_provider_code, v_provider_reference,
    'pending', v_order.total, v_order.currency
  )
  returning id into v_transaction_id;

  -- CORRECTION PAY-P1-02 : la nouvelle tentative devient l'autorité.
  update public.orders
    set payment_status = 'pending',
        current_payment_transaction_id = v_transaction_id
    where id = v_order.id;

  return query select v_transaction_id, v_order.total, v_order.currency::text;
end;
$$;

comment on function public.initiate_payment_attempt(uuid, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only). Crée une tentative de paiement -- montant/devise dérivés SERVEUR, restaurant_id dérivé de la commande. Verrouille la commande (FOR UPDATE) : au plus une tentative active à la fois (CORRECTION PAY-P1-01), garanti aussi par index unique partiel. Refuse une commande déjà payée ou de montant <= 0.';

revoke all on function public.initiate_payment_attempt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.initiate_payment_attempt(uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- 8. confirm_payment_attempt — SECURITY DEFINER, service_role
-- UNIQUEMENT.
--
-- CORRECTION PAY-P1-02 (CONFIRMATION CONCURRENCY + OLD CALLBACK
-- PROTECTION) :
--   1. Normalise (trim) provider_code/provider_reference.
--   2. Résout la tentative visée (SANS verrou), en déduit order_id.
--   3. Verrouille la COMMANDE PARENTE (`FOR UPDATE`) -- sérialise
--      toute confirmation concurrente pour CETTE commande, quelle que
--      soit la tentative visée.
--   4. Verrouille la tentative visée elle-même (`FOR UPDATE`).
--   5. MACHINE À ÉTATS "VERROUILLAGE TERMINAL" : paid/failed/cancelled
--      sont des états TERMINAUX -- une fois atteints, seule une
--      confirmation IDENTIQUE (replay) est acceptée (no-op idempotent) ;
--      toute transition vers un état DIFFÉRENT est REFUSÉE. Une
--      tentative ne peut donc jamais "ressusciter" après être devenue
--      failed/cancelled, ni être rétrogradée après paid.
--   6. La mise à jour de orders.payment_status ne se produit QUE si la
--      tentative confirmée EST la tentative courante
--      (orders.current_payment_transaction_id) -- un callback tardif
--      sur une tentative dépassée ne modifie JAMAIS orders (CORRECTION
--      PAY-P1-02, "OLD CALLBACK MUST NOT OVERRIDE NEWER ATTEMPT").
--   7. L'index unique partiel payment_transactions_one_paid_per_order
--      reste le garant final structurel même si cette logique
--      contenait un jour un bug.
-- ------------------------------------------------------------
create or replace function public.confirm_payment_attempt(
  p_provider_code text,
  p_provider_reference text,
  p_status text,
  p_authorization_reference text default null
)
returns table (transaction_id uuid, order_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_provider_reference text;
  v_order_id uuid;
  v_order public.orders%rowtype;
  v_txn public.payment_transactions%rowtype;
  v_is_current boolean;
begin
  v_provider_code := btrim(coalesce(p_provider_code, ''));
  v_provider_reference := btrim(coalesce(p_provider_reference, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;
  if length(v_provider_reference) = 0 then
    raise exception 'SCANYM_PAYMENT: p_provider_reference requis (vide après normalisation)' using errcode = '22004';
  end if;
  if p_status not in ('paid','failed','cancelled') then
    raise exception 'SCANYM_PAYMENT: p_status invalide (attendu paid/failed/cancelled)' using errcode = '22023';
  end if;

  select payment_transactions.order_id into v_order_id
    from public.payment_transactions
    where provider_code = v_provider_code and provider_reference = v_provider_reference;
  if not found then
    raise exception 'SCANYM_PAYMENT: tentative de paiement introuvable pour ce prestataire/référence' using errcode = 'P0002';
  end if;

  -- CORRECTION section 5 (CONFIRMATION CONCURRENCY) : verrouille la
  -- commande PARENTE avant la tentative -- sérialise toute
  -- confirmation concurrente pour cette commande (protège aussi
  -- contre une course entre une confirmation sur une tentative morte
  -- et une confirmation sur la tentative courante).
  select * into v_order from public.orders where id = v_order_id for update;
  if not found then
    raise exception 'SCANYM_PAYMENT: commande introuvable pour cette tentative' using errcode = 'P0002';
  end if;

  select * into v_txn from public.payment_transactions
    where provider_code = v_provider_code and provider_reference = v_provider_reference
    for update;
  if not found then
    raise exception 'SCANYM_PAYMENT: tentative de paiement introuvable pour ce prestataire/référence' using errcode = 'P0002';
  end if;

  v_is_current := (v_order.current_payment_transaction_id = v_txn.id);

  -- Idempotence : rejouer exactement le même statut final est un no-op,
  -- quel que soit l'état "courant" ou non de la tentative.
  if v_txn.status = p_status then
    return query select v_txn.id, v_txn.order_id, v_txn.status;
    return;
  end if;

  -- VERROUILLAGE TERMINAL (CORRECTION PAY-P1-02) : paid/failed/cancelled
  -- sont terminaux -- toute transition vers un statut DIFFÉRENT du
  -- statut terminal déjà atteint est refusée. Ceci ferme à la fois :
  --   - la rétrogradation d'une tentative payée (paid -> failed/cancelled)
  --   - la "résurrection" d'une tentative morte (failed/cancelled -> paid)
  --   - tout callback tardif/rejoué sur une tentative NON courante,
  --     qui ne peut de toute façon plus être 'pending' (seule une
  --     tentative 'pending' peut encore transitionner).
  if v_txn.status in ('paid','failed','cancelled') then
    raise exception 'SCANYM_PAYMENT: tentative déjà dans un état terminal (%) -- transition vers % refusée (fail-closed)', v_txn.status, p_status using errcode = '42501';
  end if;

  -- Ici : v_txn.status = 'pending'. Par construction (voir
  -- initiate_payment_attempt), une tentative 'pending' est TOUJOURS la
  -- tentative courante de sa commande -- vérifié explicitement malgré
  -- tout (défense en profondeur, CORRECTION PAY-P1-02) : si par
  -- anomalie ce n'était pas le cas, la tentative elle-même est mise à
  -- jour mais orders.payment_status n'est PAS touché.
  update public.payment_transactions
    set status = p_status,
        authorization_reference = coalesce(p_authorization_reference, authorization_reference),
        paid_at = case when p_status = 'paid' then now() else paid_at end,
        failed_at = case when p_status = 'failed' then now() else failed_at end,
        cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end
    where id = v_txn.id;

  if v_is_current then
    update public.orders
      set payment_status = p_status
      where id = v_txn.order_id;
  end if;

  return query select v_txn.id, v_txn.order_id, p_status;
end;
$$;

comment on function public.confirm_payment_attempt(text, text, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT. Verrouille la commande PUIS la tentative (CORRECTION PAY-P1-02, CONFIRMATION CONCURRENCY). Machine à états à verrouillage terminal : paid/failed/cancelled sont définitifs, seule une confirmation identique (replay) est un no-op idempotent, toute autre transition est refusée. orders.payment_status n''est mis à jour QUE si la tentative confirmée est orders.current_payment_transaction_id -- un callback tardif sur une tentative dépassée ne modifie jamais la commande (OLD CALLBACK PROTECTION).';

revoke all on function public.confirm_payment_attempt(text, text, text, text) from public, anon, authenticated;
grant execute on function public.confirm_payment_attempt(text, text, text, text) to service_role;

commit;
