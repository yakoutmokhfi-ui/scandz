-- ============================================================
-- Scanym — CUSTOMER TRACKING v3.1 — ORDER-BOUND TRACKING CAPABILITY
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- BUSINESS PROBLEM
-- ------------------------------------------------------------
-- Tracking v2.1 carries the legacy possession proof (`order_id` +
-- `orders.public_token`) inside a 2-hour presentation session cookie.
-- Once that cookie expires and the URL fragment has been scrubbed, the
-- customer can no longer reopen their tracking page, and the legacy
-- token itself stays the long-lived read credential.
--
-- v3.1 CONTRACT
-- ------------------------------------------------------------
--   1. `public.order_tracking_capabilities` -- at most ONE legacy
--      (`kind = 'legacy_upgrade'`) capability per order (partial unique
--      index on `order_id`). A legacy row starts as a SECRETLESS
--      RESERVATION (`secret_hash is null`) and is CLAIMED exactly once
--      (`secret_hash`/`claimed_at` set together, never changed again).
--      Only the SHA-256 of the secret is stored; the secret itself is
--      returned once, to the one-shot upgrade caller, and never again.
--
--   2. `public.get_order_tracking_by_capability(p_order_id,
--      p_capability_id, p_secret)` -- the v3.1 tracking read. The
--      predicate binds the capability to the REQUESTED order
--      (`c.id = p_capability_id AND c.order_id = p_order_id AND o.id =
--      p_order_id`) and verifies the secret hash. It also returns
--      `bound_order_id` so the application can independently re-check
--      the binding. There is deliberately NO variant taking only
--      (capability_id, secret): a capability can never be used to
--      discover which order it belongs to.
--
--   3. `public.upgrade_legacy_tracking_capability(p_order_id,
--      p_public_token)` -- the ONE-SHOT exchange of the legacy proof for
--      a capability. Locks the order row (`FOR UPDATE`, serialises
--      concurrent upgrades of the same order), reuses the existing
--      reservation or creates one, then performs a single claim/mint.
--      Once claimed, any replay returns an EMPTY set -- no secret
--      rotation, no reissue, no second capability. A wrong pair returns
--      the same empty set (no observable distinction).
--
--   4. `public.issue_order_email_tracking_capability(p_order_id)` --
--      REUSABLE EMAIL CREDENTIAL for NEW order-received emails
--      (service_role ONLY, called by the notification worker at render
--      time). Mints a `kind = 'email'` capability born CLAIMED (secret
--      returned once to the worker, only sha256 stored) with a bounded
--      `expires_at` (30 days = the approved tracking session lifetime).
--      Reading it goes through the SAME bound read (2.) -- read-only,
--      so opening the link again, after cookie removal, or on a second
--      browser/device never rotates or invalidates it. Several email
--      capabilities may exist per order (one per send attempt, capped),
--      so a provider retry never invalidates a link already delivered.
--      The legacy one-shot capability stays unique per order
--      (`order_tracking_capabilities_one_legacy_per_order`).
--
-- NON-DRIFT
-- ------------------------------------------------------------
-- `create_order`, `get_order_tracking(uuid, uuid)` (13-column contract,
-- DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql), `mark_whatsapp_
-- opened`, `update_order_status` and every table grant on `orders` are
-- left untouched. `get_order_tracking_by_capability` projects exactly
-- the same 13 columns as `get_order_tracking`, preceded by
-- `bound_order_id`.
--
-- CRYPTO WITHOUT EXTENSION DEPENDENCY
-- ------------------------------------------------------------
-- Secret = two `pg_catalog.gen_random_uuid()` values without dashes
-- (64 lowercase hex chars, 244 bits from the server CSPRNG). Hash =
-- `pg_catalog.sha256()` (core since PostgreSQL 11). Neither needs
-- pgcrypto, so the functions keep `search_path = ''` with no
-- `extensions.` qualification.
--
-- Migration atomicity: ONE explicit transaction, fails closed.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Preconditions + anti-double-application guard.
-- ------------------------------------------------------------
do $$
declare
  v_fn_oid    oid;
  v_out_count int;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id', 'public_token', 'total', 'currency')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders(id, public_token, total, currency) introuvable -- migration annulée.';
  end if;

  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request introuvable -- prérequis manquant, migration annulée.';
  end if;

  select p.oid into v_fn_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_order_tracking'
    and p.proargtypes = '2950 2950'::oidvector;

  if v_fn_oid is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking(uuid, uuid) introuvable -- prérequis DRAFT-lot-customer-order-tracking-foundation.sql manquant, migration annulée.';
  end if;

  select count(*) into v_out_count
  from unnest(coalesce((select proargmodes from pg_proc where oid = v_fn_oid), array[]::"char"[])) m
  where m = 't';

  if v_out_count <> 13 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking a % colonnes de sortie, 13 attendues (DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql) -- migration annulée.', v_out_count;
  end if;

  if to_regclass('public.order_tracking_capabilities') is not null
     or exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('get_order_tracking_by_capability', 'upgrade_legacy_tracking_capability', 'issue_order_email_tracking_capability')
     ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: CUSTOMER TRACKING v3.1 déjà appliqué (table ou fonction présente) -- migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Capability table -- private, no direct access for any API role.
-- ------------------------------------------------------------
create table public.order_tracking_capabilities (
  id          uuid primary key default pg_catalog.gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  kind        text not null default 'legacy_upgrade',
  secret_hash bytea,
  created_at  timestamptz not null default pg_catalog.now(),
  claimed_at  timestamptz,
  expires_at  timestamptz,
  constraint order_tracking_capabilities_kind
    check (kind in ('legacy_upgrade', 'email')),
  constraint order_tracking_capabilities_claim_atomic
    check ((secret_hash is null) = (claimed_at is null)),
  constraint order_tracking_capabilities_secret_hash_sha256
    check (secret_hash is null or octet_length(secret_hash) = 32),
  -- Email credentials are born claimed and always bounded; the legacy
  -- one-shot capability never carries an expiry (its browser session is
  -- the bound).
  constraint order_tracking_capabilities_email_bounded
    check (
      (kind = 'email' and secret_hash is not null and expires_at is not null)
      or (kind = 'legacy_upgrade' and expires_at is null)
    )
);

-- At most ONE legacy one-shot capability per order.
create unique index order_tracking_capabilities_one_legacy_per_order
  on public.order_tracking_capabilities (order_id)
  where kind = 'legacy_upgrade';

comment on table public.order_tracking_capabilities is
  'CUSTOMER TRACKING v3.1 -- capacités de suivi liées à une commande. kind=legacy_upgrade : au plus une par commande, réservation sans secret (secret_hash NULL) puis claim unique (secret_hash = sha256(secret), claimed_at). kind=email : identifiant réutilisable des e-mails de commande, né réclamé, borné par expires_at. Le secret n''est jamais stocké. Aucun accès direct anon/authenticated/service_role : lecture via get_order_tracking_by_capability, émission via upgrade_legacy_tracking_capability / issue_order_email_tracking_capability uniquement.';

alter table public.order_tracking_capabilities enable row level security;
revoke all on table public.order_tracking_capabilities from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Bound capability read (3 arguments, no unbound variant).
-- ------------------------------------------------------------
create function public.get_order_tracking_by_capability(
  p_order_id uuid,
  p_capability_id uuid,
  p_secret text
)
returns table (
  bound_order_id uuid,
  order_status text,
  service_mode text,
  order_number bigint,
  created_at timestamptz,
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  order_total numeric,
  order_currency text,
  invoice_requested boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.order_id,
    o.status, o.service_mode, o.order_number,
    o.created_at, o.accepted_at, o.preparing_at, o.ready_at,
    o.completed_at, o.rejected_at, o.cancelled_at,
    o.total, o.currency,
    exists (
      select 1 from public.order_invoice_request oir
      where oir.order_id = o.id
    )
  from public.order_tracking_capabilities c
  join public.orders o on o.id = c.order_id
  where c.id = p_capability_id
    and c.order_id = p_order_id
    and o.id = p_order_id
    and c.secret_hash is not null
    and (c.expires_at is null or c.expires_at > pg_catalog.now())
    and pg_catalog.length(p_secret) = 64
    and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'));
$$;

comment on function public.get_order_tracking_by_capability(uuid, uuid, text) is
  'SECURITY DEFINER, anon+authenticated -- CUSTOMER TRACKING v3.1. Lecture du suivi par capacité LIÉE À LA COMMANDE DEMANDÉE (capability_id + order_id + sha256(secret)). Retourne bound_order_id puis exactement les 13 colonnes de get_order_tracking. Toute entrée incorrecte (mauvais secret, capacité d''une autre commande, réservation non réclamée, capacité e-mail expirée, NULL) produit un ensemble vide, de façon identique. Aucune écriture.';

revoke all on function public.get_order_tracking_by_capability(uuid, uuid, text) from public;
grant execute on function public.get_order_tracking_by_capability(uuid, uuid, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. One-shot legacy upgrade.
-- ------------------------------------------------------------
create function public.upgrade_legacy_tracking_capability(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  capability_id uuid,
  capability_secret text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order_id    uuid;
  v_cap_id      uuid;
  v_secret_hash bytea;
  v_secret      text;
begin
  if p_order_id is null or p_public_token is null then
    return;
  end if;

  -- Legacy possession proof + order row lock: concurrent upgrades of
  -- the same order are serialised here, before any capability read.
  select o.id into v_order_id
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token
  for update;

  if v_order_id is null then
    return;
  end if;

  -- Reuse the existing legacy reservation (claimed or not) -- email
  -- capabilities never count as a legacy claim ...
  select c.id, c.secret_hash into v_cap_id, v_secret_hash
  from public.order_tracking_capabilities c
  where c.order_id = v_order_id
    and c.kind = 'legacy_upgrade'
  for update;

  -- ... or create the secretless reservation.
  if v_cap_id is null then
    insert into public.order_tracking_capabilities (order_id, kind)
    values (v_order_id, 'legacy_upgrade')
    returning id into v_cap_id;
    v_secret_hash := null;
  end if;

  -- Replay: already claimed -> never rotate, never reissue.
  if v_secret_hash is not null then
    return;
  end if;

  v_secret := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
           || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  -- Single claim/mint: only a still-secretless reservation can be claimed.
  update public.order_tracking_capabilities
  set secret_hash = pg_catalog.sha256(pg_catalog.convert_to(v_secret, 'UTF8')),
      claimed_at = pg_catalog.now()
  where id = v_cap_id
    and kind = 'legacy_upgrade'
    and secret_hash is null;

  if not found then
    return;
  end if;

  capability_id := v_cap_id;
  capability_secret := v_secret;
  return next;
end;
$$;

comment on function public.upgrade_legacy_tracking_capability(uuid, uuid) is
  'SECURITY DEFINER, anon+authenticated -- CUSTOMER TRACKING v3.1. Échange UNIQUE (one-shot) de la preuve legacy order_id + public_token contre une capacité de suivi liée à la commande. Verrouille la ligne orders (FOR UPDATE), réutilise ou crée la réservation sans secret, puis claim/mint unique. Rejeu, mauvaise paire ou NULL : ensemble vide identique -- jamais de rotation ni de réémission du secret.';

revoke all on function public.upgrade_legacy_tracking_capability(uuid, uuid) from public;
grant execute on function public.upgrade_legacy_tracking_capability(uuid, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. Reusable email credential (service_role only).
-- ------------------------------------------------------------
create function public.issue_order_email_tracking_capability(
  p_order_id uuid
)
returns table (
  capability_id uuid,
  capability_secret text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_count    int;
  v_cap_id   uuid;
  v_secret   text;
begin
  if p_order_id is null then
    return;
  end if;

  -- Order row lock: serialises concurrent issues so the cap holds.
  select o.id into v_order_id
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_order_id is null then
    return;
  end if;

  -- One credential per send attempt; bounded so a runaway retry loop
  -- can never mint an unbounded number of live credentials.
  select pg_catalog.count(*) into v_count
  from public.order_tracking_capabilities c
  where c.order_id = v_order_id
    and c.kind = 'email';

  if v_count >= 16 then
    return;
  end if;

  v_secret := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
           || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.order_tracking_capabilities (order_id, kind, secret_hash, claimed_at, expires_at)
  values (
    v_order_id,
    'email',
    pg_catalog.sha256(pg_catalog.convert_to(v_secret, 'UTF8')),
    pg_catalog.now(),
    pg_catalog.now() + interval '30 days'
  )
  returning id into v_cap_id;

  capability_id := v_cap_id;
  capability_secret := v_secret;
  return next;
end;
$$;

comment on function public.issue_order_email_tracking_capability(uuid) is
  'SECURITY DEFINER, service_role UNIQUEMENT -- CUSTOMER TRACKING v3.1. Émet l''identifiant de suivi RÉUTILISABLE d''un e-mail de commande : capacité kind=email liée à la commande, née réclamée (seul sha256(secret) stocké), expirant après 30 jours. Le secret n''est renvoyé qu''à l''appelant (worker de notification). Plafond de 16 par commande. Commande inexistante, NULL ou plafond atteint : ensemble vide.';

revoke all on function public.issue_order_email_tracking_capability(uuid) from public, anon, authenticated;
grant execute on function public.issue_order_email_tracking_capability(uuid) to service_role;

-- ------------------------------------------------------------
-- 6. Post-verification (structure + effective ACL).
-- ------------------------------------------------------------
do $$
declare
  v_read_count int;
begin
  select count(*) into v_read_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_order_tracking_by_capability';
  if v_read_count <> 1 then
    raise exception 'SCANYM_SECURITY_DRIFT: get_order_tracking_by_capability doit exister en UNE seule surcharge (3 arguments), trouvé %.', v_read_count;
  end if;

  if has_function_privilege('public', 'public.get_order_tracking_by_capability(uuid, uuid, text)', 'execute')
     or has_function_privilege('public', 'public.upgrade_legacy_tracking_capability(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: PUBLIC ne doit conserver EXECUTE sur aucune fonction CUSTOMER TRACKING v3.1.';
  end if;
  if not has_function_privilege('anon', 'public.get_order_tracking_by_capability(uuid, uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_order_tracking_by_capability(uuid, uuid, text)', 'execute')
     or not has_function_privilege('anon', 'public.upgrade_legacy_tracking_capability(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.upgrade_legacy_tracking_capability(uuid, uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon/authenticated doivent avoir EXECUTE sur les fonctions CUSTOMER TRACKING v3.1.';
  end if;
  if has_function_privilege('public', 'public.issue_order_email_tracking_capability(uuid)', 'execute')
     or has_function_privilege('anon', 'public.issue_order_email_tracking_capability(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.issue_order_email_tracking_capability(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.issue_order_email_tracking_capability(uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: issue_order_email_tracking_capability doit être EXECUTE service_role UNIQUEMENT.';
  end if;
  if has_table_privilege('anon', 'public.order_tracking_capabilities', 'select')
     or has_table_privilege('authenticated', 'public.order_tracking_capabilities', 'select')
     or has_table_privilege('anon', 'public.order_tracking_capabilities', 'insert')
     or has_table_privilege('authenticated', 'public.order_tracking_capabilities', 'update') then
    raise exception 'SCANYM_SECURITY_DRIFT: aucun accès direct API à public.order_tracking_capabilities n''est autorisé.';
  end if;
end $$;

commit;
