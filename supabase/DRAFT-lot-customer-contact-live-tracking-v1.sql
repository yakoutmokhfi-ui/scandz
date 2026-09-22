-- ============================================================
-- Scanym — CUSTOMER CONTACT + LIVE TRACKING v1
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Parent : main a8e8517698775f96186455a8461699ff4e1697fa.
-- Rollback : DRAFT-lot-customer-contact-live-tracking-v1-rollback.sql
-- Harness  : supabase/tests/customer-contact-live-tracking-v1-check.sh
--
-- WHAT THIS LOT ADDS (and only this):
--
-- A. WhatsApp OPTIONAL PER MERCHANT
--    restaurant_configs.whatsapp_enabled boolean NOT NULL DEFAULT true.
--    Default TRUE = every existing merchant keeps today's behaviour.
--    WhatsApp is NOT removed globally; whatsapp_number is untouched
--    (still NOT NULL, still written only by update_restaurant_whatsapp).
--    New RPC update_restaurant_whatsapp_enabled (owner/manager only).
--    Enabling requires the stored number to be valid (same rule as
--    update_restaurant_whatsapp) -- never an enabled WhatsApp without a
--    usable number.
--
-- B. PUBLIC MERCHANT CONTACT (distinct from operational contacts)
--    restaurant_configs.public_phone / public_email (nullable, format
--    checked). New RPC update_restaurant_public_contact (owner/manager).
--    These are PUBLIC by nature (shown to customers where appropriate).
--
-- C. TRACKING CUSTOMER CONTEXT (read-only, same capability proof)
--    get_order_tracking_customer_context_by_capability(order, capability,
--    secret): EXACTLY the v3.1 capability predicate (copied, not
--    weakened; get_order_tracking_by_capability is NOT modified).
--    Returns, for the proven order only: bound order id, the order's
--    restaurant name and its PUBLIC contact. Never WhatsApp, never
--    internal merchant data, never another order/merchant.
--
-- NOT IN THIS LOT: no order-status change, no second status engine, no
-- delivery/provider state, no change to create_order /
-- get_order_tracking* / update_order_status / tracking capability
-- issuance.
--
-- ONE explicit transaction; fails closed on missing prerequisites or
-- if the lot is already applied.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.restaurant_configs') is null
     or to_regclass('public.restaurant_users') is null
     or to_regclass('public.restaurants') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.order_tracking_capabilities') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: prérequis absents (restaurant_configs/restaurant_users/restaurants/orders/order_tracking_capabilities) -- lot annulé.';
  end if;
  if exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_configs'
         and column_name in ('whatsapp_enabled', 'public_phone', 'public_email')
     )
     or exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('update_restaurant_whatsapp_enabled', 'update_restaurant_public_contact',
                           'get_order_tracking_customer_context_by_capability')
     ) then
    raise exception 'SCANYM_ALREADY_APPLIED: CUSTOMER CONTACT + LIVE TRACKING v1 déjà (partiellement) appliqué -- lot annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- A/B. restaurant_configs : WhatsApp optionnel + contact public.
-- ------------------------------------------------------------
alter table public.restaurant_configs
  add column whatsapp_enabled boolean not null default true,
  add column public_phone text,
  add column public_email text;

alter table public.restaurant_configs
  add constraint restaurant_configs_public_phone_format
    check (public_phone is null or public_phone ~ '^\+?[0-9][0-9 .()-]{5,28}[0-9]$'),
  add constraint restaurant_configs_public_email_format
    check (
      public_email is null
      or (pg_catalog.length(public_email) <= 254
          and public_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    );

comment on column public.restaurant_configs.whatsapp_enabled is
  'CCLT v1 -- WhatsApp optionnel par commerçant. false = aucun bouton/lien/texte/repli WhatsApp côté client. Défaut true (comportement historique).';
comment on column public.restaurant_configs.public_phone is
  'CCLT v1 -- téléphone commercial PUBLIC (affichable au client). Distinct des contacts opérationnels.';
comment on column public.restaurant_configs.public_email is
  'CCLT v1 -- e-mail commercial PUBLIC (affichable au client). Distinct des contacts opérationnels.';

create function public.update_restaurant_whatsapp_enabled(
  p_restaurant_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_restaurant_id is null or p_enabled is null then
    raise exception using errcode = '22023', message = 'SCANYM_INVALID_ARGUMENT';
  end if;
  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) then
    raise exception using errcode = '42501', message = 'Forbidden';
  end if;

  select rc.whatsapp_number into v_number
  from public.restaurant_configs rc
  where rc.restaurant_id = p_restaurant_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SCANYM_RESTAURANT_CONFIG_NOT_FOUND';
  end if;

  if p_enabled and (v_number is null or v_number !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception using errcode = '22023', message = 'SCANYM_WHATSAPP_NUMBER_REQUIRED';
  end if;

  update public.restaurant_configs
  set whatsapp_enabled = p_enabled
  where restaurant_id = p_restaurant_id;
end;
$$;

revoke all on function public.update_restaurant_whatsapp_enabled(uuid, boolean) from public, anon;
grant execute on function public.update_restaurant_whatsapp_enabled(uuid, boolean) to authenticated;

create function public.update_restaurant_public_contact(
  p_restaurant_id uuid,
  p_public_phone text,
  p_public_email text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := nullif(pg_catalog.btrim(coalesce(p_public_phone, '')), '');
  v_email text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_public_email, '')), ''));
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_restaurant_id is null then
    raise exception using errcode = '22023', message = 'SCANYM_INVALID_ARGUMENT';
  end if;
  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) then
    raise exception using errcode = '42501', message = 'Forbidden';
  end if;

  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 .()-]{5,28}[0-9]$' then
    raise exception using errcode = '22023', message = 'SCANYM_INVALID_PUBLIC_PHONE';
  end if;
  if v_email is not null and (
       pg_catalog.length(v_email) > 254
       or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     ) then
    raise exception using errcode = '22023', message = 'SCANYM_INVALID_PUBLIC_EMAIL';
  end if;

  update public.restaurant_configs
  set public_phone = v_phone,
      public_email = v_email
  where restaurant_id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'SCANYM_RESTAURANT_CONFIG_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.update_restaurant_public_contact(uuid, text, text) from public, anon;
grant execute on function public.update_restaurant_public_contact(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- C. Contexte client du suivi (lecture seule, même preuve v3.1).
-- ------------------------------------------------------------
create function public.get_order_tracking_customer_context_by_capability(
  p_order_id uuid,
  p_capability_id uuid,
  p_secret text
)
returns table (
  bound_order_id uuid,
  restaurant_name text,
  public_phone text,
  public_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.order_id,
    r.name::text,
    rc.public_phone,
    rc.public_email
  from public.order_tracking_capabilities c
  join public.orders o on o.id = c.order_id
  join public.restaurants r on r.id = o.restaurant_id
  left join public.restaurant_configs rc on rc.restaurant_id = o.restaurant_id
  where c.id = p_capability_id
    and c.order_id = p_order_id
    and o.id = p_order_id
    and c.secret_hash is not null
    and (c.expires_at is null or c.expires_at > pg_catalog.now())
    and pg_catalog.length(p_secret) = 64
    and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'));
$$;

comment on function public.get_order_tracking_customer_context_by_capability(uuid, uuid, text) is
  'SECURITY DEFINER, anon+authenticated -- CCLT v1. Même prédicat de capacité que get_order_tracking_by_capability (v3.1, non modifiée). Retourne, pour LA commande prouvée uniquement : nom du commerçant et contact PUBLIC. Jamais WhatsApp, jamais de donnée interne marchand. Entrée incorrecte : ensemble vide. Aucune écriture.';

revoke all on function public.get_order_tracking_customer_context_by_capability(uuid, uuid, text) from public;
grant execute on function public.get_order_tracking_customer_context_by_capability(uuid, uuid, text) to anon, authenticated;

commit;
