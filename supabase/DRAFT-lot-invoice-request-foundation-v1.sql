-- ============================================================
-- Scanym — CUSTOMER CHECKOUT — INVOICE REQUEST FOUNDATION v1
-- (DRAFT — NOT YET APPLIED IN PRODUCTION)
--
-- INVOICE REQUEST PRODUCTION PREREQUISITE GAP — Claude Monet.
--
-- WHY THIS FILE EXISTS: Catimini's audit of Checkout Email
-- Validation v1.1 correctly stopped Production SQL installation
-- because supabase/DRAFT-lot-checkout-invoice-request-v1.sql is NOT
-- a narrow Email-only delta -- it also creates the foundational
-- Invoice Request table, RLS policy, and grants, none of which were
-- ever authorized for Production under the Email release's CIO GO.
-- This file extracts EXACTLY that foundation layer -- the table,
-- its RLS/policy/grants, and both RPCs -- AS THEY EXISTED BEFORE
-- Checkout Email Validation v1 touched set_order_invoice_request
-- (i.e. contact_email is checked for LENGTH only here, never
-- FORMAT). The format check is intentionally NOT included in this
-- file -- see the separate, additive-only
-- DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql,
-- which depends on this file already being installed and changes
-- NOTHING except that one function's body (no new grants, no RLS
-- change, no new table).
--
-- This file's SQL content (table DDL, RLS, policy, grants, function
-- bodies) is copied verbatim from the audited, git-merged
-- supabase/DRAFT-lot-checkout-invoice-request-v1.sql (commit
-- ea8e18b49c9f075a5d2db98c8261a50a5092cd25, "release: customer
-- checkout invoice request v1.4 final refresh") -- that file's own
-- header already states, literally: "DRAFT — NON APPLIQUÉ EN
-- PRODUCTION" ("DRAFT — NOT APPLIED IN PRODUCTION"). Nothing here is
-- redesigned, improved, or refactored -- this is a pure extraction.
--
-- ORIGINAL DESIGN RATIONALE (preserved verbatim from the source
-- file, for anyone reviewing this extraction against the original):
--
-- OBJET : permet au client de demander une facture (individuelle ou
-- société) pendant le checkout. Décision CTO explicite (mandat
-- littéral) : "USE A DEDICATED ORDER INVOICE REQUEST MODEL. Do NOT
-- extend order_billing_context with invoice business semantics." --
-- la demande de facture est un ATTRIBUT MÉTIER DE LA COMMANDE,
-- conceptuellement indépendant de Monetico, de tout futur
-- prestataire de paiement, de la méthode de paiement, de Stuart, et
-- de tout prestataire de livraison.
--
-- INDÉPENDANCE STRUCTURELLE : cette table NE référence JAMAIS
-- order_billing_context, ni aucune structure propre à Monetico -- sa
-- propre copie indépendante des champs d'adresse de facturation est
-- stockée ici, jamais une clé étrangère vers le contexte de
-- facturation Monetico.
--
-- MODÈLE D'ACCÈS HYBRIDE (patron déjà établi dans ce dépôt) :
--   - ÉCRITURE : exclusivement via set_order_invoice_request,
--     SECURITY DEFINER, preuve de possession anonyme (id + public_token
--     de la commande doivent correspondre à la MÊME ligne).
--   - LECTURE CLIENTE : get_order_invoice_request, même preuve de
--     possession.
--   - LECTURE MARCHAND : policy RLS directe pour `authenticated`,
--     réservée aux membres du restaurant concerné.
-- Aucun accès table direct pour anon ni pour une écriture
-- authenticated -- GRANT minimal, jamais élargi accidentellement.
-- ============================================================

-- ============================================================
-- Migration atomicity: `psql -f` does NOT automatically wrap an
-- entire file in one transaction -- every top-level statement
-- auto-commits independently without an explicit BEGIN/COMMIT block.
-- Without this, a postcheck that fails at the END of the file (e.g.
-- a security posture drift) would leave the table/functions/GRANTs
-- ALREADY COMMITTED -- a PARTIALLY installed foundation. The entire
-- migration is wrapped in ONE explicit transaction: everything
-- succeeds together, or ROLLBACK returns the database to EXACTLY
-- its pre-migration state.
-- ============================================================
begin;

do $$
begin
  if to_regclass('public.order_invoice_request') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request already exists -- foundation already installed.';
  end if;
  if to_regclass('public.orders') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders missing -- prerequisite not satisfied.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'create_order') then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order() missing -- prerequisite not satisfied.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. order_invoice_request — dedicated 1:1 table, INDEPENDENT of any
-- payment/delivery provider. Verbatim from the audited source file.
-- ------------------------------------------------------------
create table public.order_invoice_request (
  order_id            uuid primary key references public.orders(id) on delete cascade,

  invoice_type        text not null check (invoice_type in ('individual', 'company')),

  company_legal_name  text check (company_legal_name is null or length(company_legal_name) between 1 and 120),

  vat_number          text check (vat_number is null or length(vat_number) between 1 and 30),

  contact_name        text check (contact_name is null or length(contact_name) between 1 and 45),
  contact_email       text check (contact_email is null or length(contact_email) between 1 and 100),

  address_line_1      text not null check (length(address_line_1) between 1 and 50),
  address_line_2      text check (address_line_2 is null or length(address_line_2) between 1 and 50),
  city                text not null check (length(city) between 1 and 50),
  postal_code         text not null check (length(postal_code) between 1 and 10),
  country             text not null check (country ~ '^[A-Z]{2}$'),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint order_invoice_request_company_requires_legal_name
    check (invoice_type <> 'company' or company_legal_name is not null)
);

comment on table public.order_invoice_request is
  'CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST FOUNDATION v1. Attribut MÉTIER de la commande, INDÉPENDANT de tout prestataire de paiement (Monetico ou futur) et de tout prestataire de livraison (Stuart ou futur). 1:1 avec orders, existe UNIQUEMENT lorsque le client a explicitement demandé une facture. Cette installation FOUNDATION ne contient PAS le contrôle de FORMAT sur contact_email (longueur uniquement) -- voir DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql pour ce contrôle additif.';

comment on column public.order_invoice_request.invoice_type is
  'individual ou company -- jamais NULL. Une ligne n''existe que si le client a explicitement demandé une facture.';

comment on column public.order_invoice_request.vat_number is
  'Validation de FORME uniquement (longueur) -- jamais une validation d''autorité fiscale ni une règle spécifique à un pays.';

alter table public.order_invoice_request enable row level security;

create policy "order_invoice_request_select_staff"
on public.order_invoice_request for select
to authenticated
using (
  exists (
    select 1 from public.orders o
    join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id
    where o.id = order_invoice_request.order_id and ru.user_id = auth.uid()
  )
);

grant select on public.order_invoice_request to authenticated;
revoke insert, update, delete on public.order_invoice_request from public, anon, authenticated, service_role;
revoke select on public.order_invoice_request from anon, service_role, public;

-- ------------------------------------------------------------
-- 2. set_order_invoice_request — FOUNDATION version. Identical to
-- the audited source file's function EXCEPT it does NOT include the
-- contact_email FORMAT check added later by Checkout Email
-- Validation v1 (that check is applied on top by the separate,
-- additive-only Email Validation delta file -- see above). Every
-- other validation rule (required fields, length caps, no silent
-- truncation, company-requires-legal-name, deterministic upsert,
-- anonymous possession proof) is verbatim and unchanged.
-- ------------------------------------------------------------
create or replace function public.set_order_invoice_request(
  p_order_id           uuid,
  p_public_token       uuid,
  p_invoice_type       text,
  p_address_line_1     text,
  p_city               text,
  p_postal_code        text,
  p_country            text,
  p_address_line_2     text default null,
  p_company_legal_name text default null,
  p_vat_number         text default null,
  p_contact_name       text default null,
  p_contact_email      text default null
)
returns table (
  order_id      uuid,
  invoice_type  text,
  updated_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_order               public.orders%rowtype;
  v_invoice_type        text;
  v_address_line_1      text;
  v_address_line_2      text;
  v_city                text;
  v_postal_code         text;
  v_country             text;
  v_company_legal_name  text;
  v_vat_number          text;
  v_contact_name        text;
  v_contact_email       text;
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.public_token = p_public_token;

  if not found then
    raise exception 'SCANYM_INVOICE_REQUEST: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  v_invoice_type := btrim(coalesce(p_invoice_type, ''));
  if v_invoice_type not in ('individual', 'company') then
    raise exception 'SCANYM_INVOICE_REQUEST: p_invoice_type doit valoir exactement ''individual'' ou ''company''' using errcode = '22023';
  end if;

  v_address_line_1 := nullif(btrim(coalesce(p_address_line_1, '')), '');
  if v_address_line_1 is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_1 requis' using errcode = '22004';
  end if;
  if length(v_address_line_1) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_1 dépasse 50 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_address_line_2 := nullif(btrim(coalesce(p_address_line_2, '')), '');
  if v_address_line_2 is not null and length(v_address_line_2) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_2 dépasse 50 caractères' using errcode = '22001';
  end if;

  v_city := nullif(btrim(coalesce(p_city, '')), '');
  if v_city is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_city requis' using errcode = '22004';
  end if;
  if length(v_city) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_city dépasse 50 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_postal_code := nullif(btrim(coalesce(p_postal_code, '')), '');
  if v_postal_code is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_postal_code requis' using errcode = '22004';
  end if;
  if length(v_postal_code) > 10 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_postal_code dépasse 10 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_country := upper(btrim(coalesce(p_country, '')));
  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'SCANYM_INVOICE_REQUEST: p_country doit être un code ISO 3166-1 alpha-2 (2 lettres)' using errcode = '22023';
  end if;

  v_company_legal_name := nullif(btrim(coalesce(p_company_legal_name, '')), '');
  if v_invoice_type = 'company' and v_company_legal_name is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_company_legal_name requis lorsque p_invoice_type = ''company''' using errcode = '22004';
  end if;
  if v_company_legal_name is not null and length(v_company_legal_name) > 120 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_company_legal_name dépasse 120 caractères' using errcode = '22001';
  end if;

  v_vat_number := nullif(btrim(coalesce(p_vat_number, '')), '');
  if v_vat_number is not null and length(v_vat_number) > 30 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_vat_number dépasse 30 caractères' using errcode = '22001';
  end if;

  v_contact_name := nullif(btrim(coalesce(p_contact_name, '')), '');
  if v_contact_name is not null and length(v_contact_name) > 45 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_name dépasse 45 caractères' using errcode = '22001';
  end if;

  v_contact_email := nullif(btrim(coalesce(p_contact_email, '')), '');
  if v_contact_email is not null and length(v_contact_email) > 100 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email dépasse 100 caractères' using errcode = '22001';
  end if;
  -- FOUNDATION v1: LENGTH-ONLY check on contact_email, intentionally.
  -- No FORMAT check here -- this is the pre-Email-Validation-lot
  -- behavior, preserved exactly so this file matches what was
  -- actually git-merged and audited BEFORE the email lot. The format
  -- check is applied on top by the separate delta file.

  insert into public.order_invoice_request (
    order_id, invoice_type, company_legal_name, vat_number,
    contact_name, contact_email,
    address_line_1, address_line_2, city, postal_code, country,
    updated_at
  ) values (
    p_order_id, v_invoice_type, v_company_legal_name, v_vat_number,
    v_contact_name, v_contact_email,
    v_address_line_1, v_address_line_2, v_city, v_postal_code, v_country,
    now()
  )
  on conflict (order_id) do update set
    invoice_type        = excluded.invoice_type,
    company_legal_name  = excluded.company_legal_name,
    vat_number           = excluded.vat_number,
    contact_name         = excluded.contact_name,
    contact_email        = excluded.contact_email,
    address_line_1       = excluded.address_line_1,
    address_line_2       = excluded.address_line_2,
    city                 = excluded.city,
    postal_code          = excluded.postal_code,
    country              = excluded.country,
    updated_at           = now();

  return query
    select r.order_id, r.invoice_type, r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$$;

comment on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) is
  'SECURITY DEFINER -- CUSTOMER CHECKOUT INVOICE REQUEST FOUNDATION v1. Écrit/met à jour (upsert déterministe) la demande de facture d''une commande, avec preuve de possession anonyme (id + public_token). LENGTH-only check sur contact_email (voir le delta Email Validation pour le contrôle de FORMAT). AUCUN déclenchement de paiement, de Stuart, ou de communication client.';

revoke all on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 3. get_order_invoice_request — read, same possession proof.
-- Verbatim, unaffected by the email lot either way.
-- ------------------------------------------------------------
create or replace function public.get_order_invoice_request(
  p_order_id      uuid,
  p_public_token  uuid
)
returns table (
  invoice_type         text,
  company_legal_name   text,
  vat_number           text,
  contact_name         text,
  contact_email        text,
  address_line_1       text,
  address_line_2       text,
  city                 text,
  postal_code          text,
  country              text,
  updated_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.public_token = p_public_token
  ) then
    raise exception 'SCANYM_INVOICE_REQUEST: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  return query
    select r.invoice_type, r.company_legal_name, r.vat_number,
           r.contact_name, r.contact_email,
           r.address_line_1, r.address_line_2, r.city, r.postal_code, r.country,
           r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$$;

comment on function public.get_order_invoice_request(uuid, uuid) is
  'SECURITY DEFINER, lecture -- même preuve de possession anonyme que set_order_invoice_request. Absence de ligne = "pas de facture demandée", jamais une erreur.';

revoke all on function public.get_order_invoice_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_invoice_request(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 4. Post-verification — security posture, executed BY this
-- migration itself (never only documented): fails explicitly if
-- GRANT/RLS drift from the intended posture.
-- ------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.order_invoice_request', 'select') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon must NEVER be able to read order_invoice_request';
  end if;
  if has_table_privilege('authenticated', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: authenticated must NEVER write directly to order_invoice_request';
  end if;
  if has_table_privilege('service_role', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: service_role must NEVER have a direct table privilege (SECURITY DEFINER functions only)';
  end if;
  if has_function_privilege('anon', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: set_order_invoice_request must be executable only by service_role';
  end if;
end $$;

commit;
