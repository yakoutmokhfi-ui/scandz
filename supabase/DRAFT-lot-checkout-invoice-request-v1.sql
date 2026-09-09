-- ============================================================
-- Scanym — CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
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
-- INDÉPENDANCE STRUCTURELLE (mandat, littéral : "the persisted
-- invoice request must remain valid independently of payment
-- provider lifecycle", "Avoid hidden cross-table dependency that
-- would make invoices impossible without Monetico") : cette table
-- NE référence JAMAIS order_billing_context, ni aucune structure
-- propre à Monetico -- sa propre copie indépendante des champs
-- d'adresse de facturation est stockée ici, jamais une clé étrangère
-- vers le contexte de facturation Monetico. Une commande peut avoir
-- une demande de facture SANS jamais avoir de order_billing_context
-- (paiement non-Monetico, futur prestataire, ou mode de service sans
-- paiement en ligne), et réciproquement.
--
-- MODÈLE D'ACCÈS HYBRIDE (patron déjà établi dans ce dépôt) :
--   - ÉCRITURE : exclusivement via set_order_invoice_request,
--     SECURITY DEFINER, preuve de possession anonyme (id + public_token
--     de la commande doivent correspondre à la MÊME ligne) -- même
--     patron que set_order_billing_context (PAYMENT P3-B6).
--   - LECTURE CLIENTE : get_order_invoice_request, même preuve de
--     possession.
--   - LECTURE MARCHAND : policy RLS directe pour `authenticated`,
--     réservée aux membres du restaurant concerné -- même patron que
--     order_delivery_address_select_staff (LOT 2A).
-- Aucun accès table direct pour anon ni pour une écriture
-- authenticated -- GRANT minimal, jamais élargi accidentellement.
--
-- HORS PÉRIMÈTRE v1.1 (mandat, littéral) : génération PDF, numérotation
-- de facture, séquençage fiscal, export comptable, Peppol/e-invoicing,
-- validation fiscale du numéro de TVA (syntaxe uniquement, jamais une
-- validation d'autorité fiscale). Ce lot capture UNIQUEMENT la
-- demande et les données de facturation du client.
-- ============================================================

-- ============================================================
-- CORRECTIF v1.3 (Cat Woman INVOICE-V12-MIGRATION-ATOMICITY-01,
-- HIGH) : `psql -f` NE regroupe PAS automatiquement l'intégralité
-- d'un fichier en une seule transaction -- chaque instruction de
-- premier niveau s'auto-committe indépendamment en l'absence d'un
-- bloc BEGIN/COMMIT explicite. Sans cela, un postcheck qui échoue EN
-- FIN de fichier (ex. dérive de posture de sécurité) laisserait la
-- table/les fonctions/les GRANT DÉJÀ COMMITÉS -- une fondation
-- PARTIELLEMENT installée. Toute la migration est désormais
-- enveloppée dans UNE SEULE transaction explicite : tout succède
-- ensemble, ou ROLLBACK ramène la base EXACTEMENT à son état
-- pré-migration, sans dépendre d'un comportement implicite du
-- client psql.
-- ============================================================
begin;

do $$
begin
  if to_regclass('public.order_invoice_request') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request existe déjà -- migration déjà appliquée.';
  end if;
  if to_regclass('public.orders') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders absente -- prérequis manquant.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'create_order') then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order() absente -- prérequis manquant.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. order_invoice_request — table 1:1 dédiée, structurée,
-- INDÉPENDANTE de tout prestataire de paiement/livraison.
-- ------------------------------------------------------------
create table public.order_invoice_request (
  order_id            uuid primary key references public.orders(id) on delete cascade,

  -- 'individual' ou 'company' -- jamais NULL si une ligne existe (une
  -- ligne n'existe QUE si le client a explicitement demandé une
  -- facture -- "If NO: No order_invoice_request row is required.",
  -- mandat littéral).
  invoice_type        text not null check (invoice_type in ('individual', 'company')),

  -- Obligatoire UNIQUEMENT pour invoice_type = 'company' (mandat,
  -- littéral : "company_legal_name required"). Contrainte CHECK
  -- ci-dessous, jamais une validation applicative seule.
  company_legal_name  text check (company_legal_name is null or length(company_legal_name) between 1 and 120),

  -- Optionnel dans tous les cas (mandat, littéral : "VAT number:
  -- optional unless an existing country-specific rule already
  -- requires it" -- aucune règle par pays n'existe déjà dans ce
  -- dépôt, donc toujours optionnel ici). Validation de FORME
  -- uniquement (longueur) -- jamais une validation d'autorité
  -- fiscale (mandat, littéral : "Do not treat VAT syntax validation
  -- as tax authority validation").
  vat_number          text check (vat_number is null or length(vat_number) between 1 and 30),

  -- Nom du contact -- pertinent surtout pour une facture société
  -- (personne à contacter), mais autorisé aussi en individuel (peut
  -- différer du nom client de la commande elle-même, ex. quelqu'un
  -- qui commande pour un tiers).
  contact_name        text check (contact_name is null or length(contact_name) between 1 and 45),
  contact_email       text check (contact_email is null or length(contact_email) between 1 and 100),

  -- Adresse de facturation -- copie INDÉPENDANTE, jamais une
  -- référence croisée vers order_billing_context ni
  -- order_delivery_address. Mêmes bornes que order_billing_context
  -- pour cohérence de convention (pas par dépendance).
  address_line_1      text not null check (length(address_line_1) between 1 and 50),
  address_line_2      text check (address_line_2 is null or length(address_line_2) between 1 and 50),
  city                text not null check (length(city) between 1 and 50),
  postal_code         text not null check (length(postal_code) between 1 and 10),
  country             text not null check (country ~ '^[A-Z]{2}$'),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Garantit au niveau SCHÉMA (jamais seulement applicatif) qu'une
  -- facture société a toujours un nom légal -- fail-closed structurel.
  constraint order_invoice_request_company_requires_legal_name
    check (invoice_type <> 'company' or company_legal_name is not null)
);

comment on table public.order_invoice_request is
  'CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1. Attribut MÉTIER de la commande, INDÉPENDANT de tout prestataire de paiement (Monetico ou futur) et de tout prestataire de livraison (Stuart ou futur) -- décision CTO explicite. 1:1 avec orders, existe UNIQUEMENT lorsque le client a explicitement demandé une facture. Aucune référence croisée vers order_billing_context (Monetico) ni order_delivery_address -- copie indépendante de l''adresse de facturation. Hors périmètre v1.1 : génération PDF, numérotation fiscale, validation d''autorité fiscale du numéro de TVA.';

comment on column public.order_invoice_request.invoice_type is
  'individual ou company -- jamais NULL. Une ligne n''existe que si le client a explicitement demandé une facture.';

comment on column public.order_invoice_request.vat_number is
  'Validation de FORME uniquement (longueur) -- jamais une validation d''autorité fiscale ni une règle spécifique à un pays (hors périmètre v1.1, mandat littéral).';

alter table public.order_invoice_request enable row level security;

-- Lecture MARCHAND : réservée aux membres du restaurant concerné --
-- même patron que order_delivery_address_select_staff (LOT 2A).
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

-- GRANT minimal, jamais élargi accidentellement : SELECT pour
-- authenticated (via la policy ci-dessus), AUCUNE écriture directe
-- pour QUICONQUE, y compris service_role (posture la plus stricte
-- déjà établie dans ce dépôt, identique à order_billing_context) --
-- exclusivement via les fonctions SECURITY DEFINER ci-dessous.
grant select on public.order_invoice_request to authenticated;
revoke insert, update, delete on public.order_invoice_request from public, anon, authenticated, service_role;
revoke select on public.order_invoice_request from anon, service_role, public;

-- ------------------------------------------------------------
-- 2. set_order_invoice_request — ÉCRITURE/UPSERT, SECURITY DEFINER,
-- preuve de possession anonyme (même patron que
-- set_order_billing_context, PAYMENT P3-B6). Échec fermé sur toute
-- entrée invalide ou incomplète -- jamais une valeur par défaut
-- silencieuse, jamais une troncature silencieuse.
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

  -- Preuve de possession anonyme -- id ET public_token doivent
  -- correspondre à la MÊME commande (même patron que
  -- set_order_billing_context/get_order_payment_context).
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

  -- Adresse : politique "fourni-mais-invalide-rejette / absent-omet"
  -- pour les champs optionnels, échec fermé pour les champs
  -- obligatoires -- identique à set_order_billing_context, JAMAIS de
  -- troncature silencieuse (left()) sur une valeur réelle mais trop
  -- longue.
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

  -- `country` toujours explicitement fourni par l'appelant (même
  -- politique que set_order_billing_context) -- jamais une valeur par
  -- défaut silencieuse.
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

  -- Numéro de TVA : validation de FORME uniquement (longueur) --
  -- jamais une validation d'autorité fiscale ni une règle par pays
  -- (hors périmètre v1.1, mandat littéral). Optionnel même pour une
  -- facture société.
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

  -- UPSERT déterministe -- retry/re-soumission produit le MÊME état
  -- final pour les mêmes entrées, jamais une seconde ligne, jamais une
  -- commande dupliquée (mandat, littéral : "retry/upsert behavior
  -- deterministic", "no duplicate order").
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
  'SECURITY DEFINER -- CUSTOMER CHECKOUT INVOICE REQUEST v1.1. Écrit/met à jour (upsert déterministe) la demande de facture d''une commande, avec preuve de possession anonyme (id + public_token). Échec fermé sur toute entrée invalide/incomplète, jamais une troncature silencieuse. AUCUN déclenchement de paiement, de Stuart, ou de communication client -- capture de données uniquement.';

revoke all on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 3. get_order_invoice_request — LECTURE CLIENTE, même preuve de
-- possession que set_order_invoice_request/get_order_billing_context.
-- Absence de ligne = état légitime ("pas de facture demandée"),
-- jamais une erreur.
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
-- 4. Post-vérification -- posture de sécurité, exécutée par CETTE
-- migration elle-même (jamais seulement documentée) : échec explicite
-- si le GRANT/RLS s'écarte de la posture voulue.
-- ------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.order_invoice_request', 'select') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon ne doit JAMAIS pouvoir lire order_invoice_request';
  end if;
  if has_table_privilege('authenticated', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: authenticated ne doit JAMAIS pouvoir écrire directement dans order_invoice_request';
  end if;
  if has_table_privilege('service_role', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: service_role ne doit JAMAIS avoir de privilège table direct (exclusivement via les fonctions SECURITY DEFINER)';
  end if;
  if has_function_privilege('anon', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: set_order_invoice_request ne doit être exécutable que par service_role';
  end if;
end $$;

commit;
