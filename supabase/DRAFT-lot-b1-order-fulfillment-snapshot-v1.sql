-- ============================================================
-- Scanym — DELIVERY PRICING v2 — B1 — ORDER FULFILLMENT/PRICING
-- SNAPSHOT v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- Baseline Production figée : 497efb9af3288ae63d2bed500b361a3dab9a7f8c
-- Prédécesseur direct (dernière redéfinition connue de create_order) :
-- supabase/DRAFT-lot-product-service-modes-v1.sql
--
-- ⚠️ NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION. Testable uniquement
-- via supabase/tests/b1-order-fulfillment-snapshot-v1-check.sh, sur
-- une base PostgreSQL jetable, jamais contre un projet Supabase réel
-- (garde P-7 ci-dessous : anti double-application, pas une garantie
-- contre une application accidentelle hors contexte de test).
--
-- OBJET : autorité de conception = contrat "Debussy" (issue #17,
-- commentaires 5911325633 / 5911326624, sections §0-§17). Ce fichier
-- implémente exclusivement §6 (schéma), §7.2 (delta create_order),
-- §7.3 (préflights P-1..P-8) et §12 (RLS/grants). Table ENFANT 1:1
-- IMMUABLE de `orders` : fige la décision de routage/tarification de
-- livraison réellement appliquée à la création de la commande, pour
-- qu'une édition marchande ultérieure des règles tarifaires ne puisse
-- JAMAIS changer rétroactivement ce que l'historique d'une commande
-- passée raconte.
--
-- ABSENCE DE LIGNE (D-B1-3 / §8.2, normatif, jamais re-débattu
-- ensuite) : une commande SANS ligne dans
-- order_delivery_fulfillment_snapshot n'a PAS été routée par le
-- nouveau moteur de règles de fulfillment de livraison -- table/
-- pickup/room_service, OU le chemin de livraison legacy sans règle de
-- fulfillment active, OU une commande antérieure à cette migration.
-- Une absence de ligne ne signifie JAMAIS "livraison gratuite", JAMAIS
-- "pas de configuration", JAMAIS une erreur.
--
-- AUCUNE CLÉ ÉTRANGÈRE de fulfillment_rule_id vers
-- restaurant_sale_mode_fulfillments (D-B1-3) : l'instantané doit
-- rester lisible même après suppression de la règle source (voir
-- orders.fulfillment_rule_id, qui LUI porte une FK ON DELETE SET
-- NULL vers la même table -- comportements délibérément différents :
-- orders est l'état COURANT, l'instantané est l'HISTOIRE).
--
-- ALIMENTATION EXCLUSIVEMENT PAR v_resolved, LU UNE SEULE FOIS plus
-- haut dans create_order (D-B1-6, Option 2) : aucune relecture de la
-- configuration tarifaire au moment de l'instantané, donc aucune
-- course possible avec une édition marchande concurrente entre la
-- résolution et l'écriture.
-- ============================================================

begin;

-- ------------------------------------------------------------------
-- §7.3 — PRÉFLIGHTS P-1..P-7, fail-closed, AVANT TOUTE DDL, dans la
-- même transaction que le reste de la migration : un échec laisse la
-- base totalement intacte (ROLLBACK implicite de toute la transaction).
-- ------------------------------------------------------------------

-- P-1 — public.orders : existence + colonnes attendues.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- migration B1 annulée.';
  end if;

  if (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in (
        'delivery_fee','fulfillment_rule_id','fulfillment_code',
        'provider_code','subtotal','total','currency','service_mode'
      )
  ) <> 8 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders n''a pas toutes les colonnes attendues (delivery_fee, fulfillment_rule_id, fulfillment_code, provider_code, subtotal, total, currency, service_mode) -- migration B1 annulée.';
  end if;
end $$;

-- P-2 — restaurant_sale_mode_fulfillments : existence + colonnes.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'restaurant_sale_mode_fulfillments'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_mode_fulfillments introuvable -- migration B1 annulée.';
  end if;

  if (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_sale_mode_fulfillments'
      and column_name in (
        'pricing_mode','fixed_fee','free_threshold','is_fallback',
        'customer_text','zone_prefixes'
      )
  ) <> 6 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_mode_fulfillments n''a pas toutes les colonnes attendues (pricing_mode, fixed_fee, free_threshold, is_fallback, customer_text, zone_prefixes) -- migration B1 annulée.';
  end if;
end $$;

-- P-3 — resolve_delivery_fulfillment : signature EXACTE + contrat de
-- retour EXACT (pg_catalog, jamais une comparaison de source/texte).
do $$
begin
  if to_regprocedure(
    'public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric)'
  ) is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric) introuvable avec cette signature EXACTE -- migration B1 annulée.';
  end if;

  if pg_get_function_result(
    'public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric)'::regprocedure
  ) is distinct from
    'TABLE(eligible boolean, fulfillment_rule_id uuid, fulfillment_code text, provider text, matched_prefix text, zone_prefixes text[], is_fallback boolean, min_items integer, customer_text text, display_order integer, pricing_mode text, fixed_fee numeric, free_threshold numeric, delivery_fee numeric, block text, missing integer)'
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.resolve_delivery_fulfillment a un contrat RETURNS TABLE inattendu -- migration B1 annulée pour éviter une régression silencieuse du contrat de sortie.';
  end if;
end $$;

-- P-4 — scanym_numeric_is_non_finite : prérequis des CHECK odfs_*_finite.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'scanym_numeric_is_non_finite'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.scanym_numeric_is_non_finite() introuvable -- prérequis DRAFT-lot-payment-p1-foundation.sql manquant, migration B1 annulée.';
  end if;
end $$;

-- P-5 — create_order : EXACTEMENT UNE surcharge. Vérification la plus
-- importante de ce préflight : empêche une coexistence silencieuse de
-- surcharges PostgreSQL (bug déjà vécu par ce dépôt -- voir le
-- commentaire de post-mortem du lot CGV v1.1, qui a dû explicitement
-- DROPper une 8e-arg fantôme avant de republier la sienne).
do $$
declare
  v_overload_count integer;
begin
  select count(*) into v_overload_count
  from pg_proc where proname = 'create_order' and pronamespace = 'public'::regnamespace;

  if v_overload_count <> 1 then
    raise exception 'SCANYM_CREATE_ORDER_OVERLOAD_AMBIGUOUS: % surcharge(s) de public.create_order trouvée(s), exactement 1 attendue -- migration B1 annulée (coexistence de surcharges non résolue).', v_overload_count;
  end if;
end $$;

-- P-6 — cette unique surcharge de create_order : signature de
-- paramètres EXACTE + contrat RETURNS TABLE EXACT, tous deux épinglés
-- littéralement (jamais devinés/recopiés depuis un commentaire).
do $$
begin
  if to_regprocedure(
    'public.create_order(text, text, jsonb, integer, jsonb, text, text, boolean)'
  ) is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.create_order(text, text, jsonb, integer, jsonb, text, text, boolean) introuvable avec cette signature EXACTE -- migration B1 annulée.';
  end if;

  if pg_get_function_result(
    'public.create_order(text, text, jsonb, integer, jsonb, text, text, boolean)'::regprocedure
  ) is distinct from
    'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.create_order a un contrat RETURNS TABLE inattendu -- migration B1 annulée pour éviter une régression silencieuse du contrat de sortie.';
  end if;
end $$;

-- P-7 — anti double-application.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'order_delivery_fulfillment_snapshot'
  ) then
    raise exception 'SCANYM_B1_ALREADY_APPLIED: public.order_delivery_fulfillment_snapshot existe déjà -- migration B1 déjà appliquée, application annulée pour éviter une double définition.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- §6 — SCHÉMA (verbatim contrat Debussy).
-- ------------------------------------------------------------------

-- ============================================================
-- DELIVERY PRICING v2 — B1 — ORDER FULFILLMENT/PRICING SNAPSHOT
-- Instantané IMMUABLE, 1:1, de la décision de routage et de
-- tarification réellement appliquée à la création de la commande.
-- ============================================================

create table public.order_delivery_fulfillment_snapshot (
  order_id              uuid primary key
                          references public.orders(id) on delete cascade,

  -- Identité historique de la règle appliquée. AUCUNE clé étrangère
  -- vers restaurant_sale_mode_fulfillments : voir D-B1-3.
  fulfillment_rule_id   uuid    not null,

  -- Décision de routage.
  is_fallback           boolean not null,
  matched_prefix        text,

  -- Tarification appliquée, copiée depuis l'UNIQUE ligne de résolveur.
  pricing_mode          text    not null,
  fixed_fee             numeric(10,2),
  free_threshold        numeric(10,2),

  -- Texte réellement présenté au client pour cette règle.
  customer_text         text,

  -- Version de la méthode d'instantané (précédent : allocation_method_version,
  -- DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql:306, :322-323).
  snapshot_method_version text not null default 'v1',

  created_at            timestamptz not null default now(),

  -- Domaines. AUCUNE énumération n'est recopiée : voir §6.2.
  constraint odfs_rule_id_present
    check (fulfillment_rule_id is not null),
  constraint odfs_pricing_mode_non_blank
    check (btrim(pricing_mode) <> '' and length(pricing_mode) <= 60),
  constraint odfs_matched_prefix_shape
    check (matched_prefix is null
           or (btrim(matched_prefix) = matched_prefix
               and matched_prefix <> ''
               and length(matched_prefix) <= 20)),
  constraint odfs_fixed_fee_non_negative
    check (fixed_fee is null or fixed_fee >= 0),
  constraint odfs_fixed_fee_finite
    check (fixed_fee is null or not public.scanym_numeric_is_non_finite(fixed_fee)),
  constraint odfs_free_threshold_non_negative
    check (free_threshold is null or free_threshold >= 0),
  constraint odfs_free_threshold_finite
    check (free_threshold is null
           or not public.scanym_numeric_is_non_finite(free_threshold)),
  constraint odfs_customer_text_length
    check (customer_text is null or length(customer_text) <= 500),
  constraint odfs_method_version_non_blank
    check (btrim(snapshot_method_version) <> ''
           and length(snapshot_method_version) <= 20)
);

-- ------------------------------------------------------------------
-- §8.2 — sémantique de l'absence de ligne, NORMATIVE, jamais
-- re-débattue plus tard (voir en-tête de ce fichier).
-- ------------------------------------------------------------------
comment on table public.order_delivery_fulfillment_snapshot is
  'DELIVERY PRICING v2 — B1 — instantané IMMUABLE, 1:1 avec orders, de la décision de routage/tarification de livraison RÉELLEMENT appliquée à la création de la commande. Alimenté EXCLUSIVEMENT par create_order, depuis v_resolved (un seul appel à resolve_delivery_fulfillment, jamais relu ensuite) -- aucune écriture directe (RLS + REVOKE ALL, voir §12). UNE ABSENCE DE LIGNE POUR UNE COMMANDE DONNÉE SIGNIFIE EXCLUSIVEMENT : (a) service_mode = table, pickup ou room_service, (b) service_mode = delivery par le chemin LEGACY (aucune règle de fulfillment active pour cet établissement/mode), ou (c) une commande antérieure à cette migration. Une absence de ligne NE SIGNIFIE JAMAIS "livraison gratuite", JAMAIS "aucune configuration", JAMAIS une erreur -- ne jamais l''interpréter autrement dans une lecture future (D-B1-3 / §8.2).';

comment on column public.order_delivery_fulfillment_snapshot.fulfillment_rule_id is
  'Identité HISTORIQUE de la règle de fulfillment réellement appliquée. AUCUNE clé étrangère vers restaurant_sale_mode_fulfillments(id) par construction (D-B1-3) : reste lisible même si la règle source est supprimée ensuite (contrairement à orders.fulfillment_rule_id, qui porte lui une FK ON DELETE SET NULL vers la même table -- orders reflète l''état COURANT, cet instantané reflète l''HISTOIRE).';

comment on column public.order_delivery_fulfillment_snapshot.pricing_mode is
  'Copie de resolve_delivery_fulfillment.pricing_mode au moment de la commande. AUCUNE énumération CHECK fermée (§6.2) : une future valeur de vocabulaire tarifaire (ex. lot B5) n''est jamais bloquée à l''écriture par ce lot -- seule la cohérence frais/tarif (contrainte B1-A-01, côté create_order) est vérifiée.';

-- ------------------------------------------------------------------
-- §12 — RLS / GRANTS (verbatim contrat Debussy).
-- ------------------------------------------------------------------

alter table public.order_delivery_fulfillment_snapshot enable row level security;

create policy "order_delivery_fulfillment_snapshot_select_staff"
on public.order_delivery_fulfillment_snapshot for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id
    where o.id = order_delivery_fulfillment_snapshot.order_id
      and ru.user_id = auth.uid()
  )
);

revoke all on public.order_delivery_fulfillment_snapshot
  from public, anon, authenticated, service_role;

grant select on public.order_delivery_fulfillment_snapshot to authenticated;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table public.order_delivery_fulfillment_snapshot
             from public, anon, authenticated, service_role';
  end if;
end $$;

-- ------------------------------------------------------------------
-- §7.2 — create_order : REMPLACÉ. Corps repris À L'IDENTIQUE de
-- DRAFT-lot-product-service-modes-v1.sql (signature INCHANGÉE --
-- 8 paramètres, aucun nouveau p_*, mission "never trust a delivery
-- fee/fulfillment decision supplied by the frontend"). SEUL AJOUT :
-- le bloc B1 (checked B1-A-01 + insert snapshot), splicé
-- IMMÉDIATEMENT APRÈS le `update public.orders set subtotal = ...`
-- qui clôt la résolution de livraison, et AVANT `return query`. Tout
-- le reste du corps, y compris les commentaires hérités des lots
-- précédents (DELIVERY COUNTRY SCOPE v1, CFTE v1, PRODUCT SERVICE
-- MODES v1...), est byte-identique -- pure addition, rien retiré,
-- rien réordonné.
-- ------------------------------------------------------------------

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
  v_withdrawal_regime_snapshot text;
  v_template_sections_snapshot jsonb;
  v_withdrawal_legal_basis     text;
  -- CFTE v1 (changement 1) -- prénom/nom saisis séparément puis
  -- RECOMPOSÉS ; aucune de ces deux valeurs n'est persistée telle
  -- quelle, aucune colonne n'existe pour elles.
  v_first_name  text;
  v_last_name   text;
  v_tracked     boolean := false;
  -- DELIVERY COUNTRY SCOPE v1 -- pays de livraison RÉSOLU et AUTORISÉ.
  v_country          text;
  v_country_count    integer := 0;
  v_country_cap      public.scanym_country_delivery_capability%rowtype;
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

    select mcp.withdrawal_regime, ct.controlled_sections
      into v_withdrawal_regime_snapshot, v_template_sections_snapshot
    from public.merchant_cgv_version mcv
    join public.cgv_template ct on ct.id = mcv.template_id
    join public.merchant_cgv_profile mcp on mcp.restaurant_id = mcv.restaurant_id
    where mcv.id = v_cgv_version_id;

    if v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE' then
      if (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 4°%' then
        v_withdrawal_legal_basis := 'L221-28-4';
      elsif (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 3°%' then
        v_withdrawal_legal_basis := 'L221-28-3';
      else
        v_withdrawal_legal_basis := 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION';
      end if;
    elsif v_withdrawal_regime_snapshot = 'STANDARD_14_DAYS' then
      v_withdrawal_legal_basis := 'STANDARD_14_DAYS_ELIGIBLE';
    else
      v_withdrawal_legal_basis := null;
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

  -- CFTE v1 (changement 2) -- prénom/nom séparés, puis NOM D'AFFICHAGE
  -- NORMALISÉ recomposé côté SERVEUR. Dès qu'au moins l'un des deux est
  -- fourni, la valeur composée REMPLACE `name` reçu du navigateur : le
  -- client ne peut pas faire diverger le nom affiché de ce qu'il a
  -- réellement saisi. Aucun des deux champs n'est persisté séparément.
  v_first_name := nullif(left(trim(coalesce(p_customer->>'first_name','')), 60), '');
  v_last_name  := nullif(left(trim(coalesce(p_customer->>'last_name','')), 60), '');

  if v_first_name is not null or v_last_name is not null then
    v_name := nullif(left(btrim(concat_ws(' ', v_first_name, v_last_name)), 120), '');
  end if;

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  -- CFTE v1 (changement 3) -- PRÉCÉDENCE NON RELAXABLE des modes suivis,
  -- appliquée ICI en plus du résolveur : aucune surcharge tenant, et
  -- aucune redéfinition future du résolveur, ne peut rendre l'e-mail
  -- optionnel pour un mode suivi. N'écrit rien, ne lit aucune
  -- configuration tenant : garde purement structurelle.
  v_tracked := p_service_mode = any (public.customer_tracked_service_modes());

  if v_tracked then
    if v_email is null then
      raise exception using errcode = 'P0001', message = 'SCANYM_CUSTOMER_EMAIL_REQUIRED';
    end if;
    if v_first_name is null then
      raise exception using errcode = 'P0001', message = 'SCANYM_CUSTOMER_FIRST_NAME_REQUIRED';
    end if;
  end if;

  if p_service_mode = 'delivery' and v_last_name is null then
    raise exception using errcode = 'P0001', message = 'SCANYM_CUSTOMER_LAST_NAME_REQUIRED';
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
      -- CFTE v1 (changement 4).
      when 'first_name' then v_first_name
      when 'last_name' then v_last_name
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
    -- ================================================================
    -- DELIVERY COUNTRY SCOPE v1 -- L2 : PAYS DE LIVRAISON DU MARCHAND.
    --
    -- Trois décisions DISTINCTES, dans cet ordre, avec trois erreurs
    -- distinctes (decision CIO v1.2) :
    --   1. le pays est-il autorise POUR CE MARCHAND ?   -> COUNTRY_NOT_ALLOWED
    --   2. le code postal a-t-il le format DE CE PAYS ? -> POSTAL_CODE_INVALID
    --   3. le code postal est-il commercialement servi ? -> OUT_OF_DELIVERY_ZONE
    --
    -- L'ecran ne propose jamais un pays non autorise ; cela ne prouve
    -- rien : une charge utile est un objet JSON que n'importe qui peut
    -- fabriquer. L'autorite est ici, par etablissement, jamais globale.
    -- ================================================================
    v_country := nullif(upper(btrim(coalesce(p_customer->>'country', ''), E' \t\n\r\f' || chr(11))), '');

    select count(*) into v_country_count
    from public.restaurant_delivery_countries dc
    where dc.restaurant_id = v_restaurant.id;

    -- Aucun pays configure = livraison indisponible. Le silence ne vaut
    -- jamais permission (meme discipline fail-closed que
    -- fieldRequirementsReady cote client).
    if v_country_count = 0 then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: aucun pays de livraison configure pour cet etablissement';
    end if;

    if v_country is null then
      -- Compatibilite ascendante : les clients deployes n'envoient
      -- AUCUN pays. Un seul pays autorise => il est resolu sans
      -- ambiguite. Plusieurs => on refuse, on ne devine pas.
      if v_country_count = 1 then
        select dc.country_code into v_country
        from public.restaurant_delivery_countries dc
        where dc.restaurant_id = v_restaurant.id;
      else
        raise exception using errcode = '22004',
          message = 'SCANYM_DELIVERY_COUNTRY_REQUIRED: pays de livraison requis (plusieurs pays autorises)';
      end if;
    end if;

    if not exists (
      select 1 from public.restaurant_delivery_countries dc
      where dc.restaurant_id = v_restaurant.id and dc.country_code = v_country
    ) then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: ' || v_country;
    end if;

    -- L1 : le pays doit AUSSI etre livrable au niveau plateforme. Un
    -- pays connu de Scanym (onboarding d'etablissement) n'est pas pour
    -- autant livrable -- TN et MA en sont l'exemple.
    select * into v_country_cap
    from public.scanym_country_delivery_capability c
    where c.country_code = v_country;

    if not found or not v_country_cap.delivery_capable then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: ' || v_country || ' non livrable au niveau plateforme';
    end if;

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

    -- DELIVERY COUNTRY SCOPE v1.1 -- DCS-LEGACY-BE-01.
    -- Le chemin historique ci-dessous (aucune regle de fulfillment
    -- ACTIVE) extrait un code postal FRANCAIS a cinq chiffres du texte
    -- libre de l'adresse et le compare a delivery_zone_prefixes. Il est
    -- par construction propre a la France : il est donc RESERVE au pays
    -- FR. Tout autre pays resolu sans regle active est refuse ici,
    -- AVANT toute extraction postale et avant toute ecriture (fail
    -- closed). Le comportement FR est strictement inchange.
    if not v_new_engine and v_country is distinct from 'FR' then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: ' || coalesce(v_country, '?')
          || ' sans regle de livraison active (chemin postal historique reserve a FR)';
    end if;

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
        raise exception using errcode = 'P0002',
          message = 'SCANYM_OUT_OF_DELIVERY_ZONE: Zone non desservie: ' || v_postal;
      end if;
    end if;

    -- DELIVERY COUNTRY SCOPE v1 -- decision 2/3 : FORMAT du code postal,
    -- selon le pays resolu. Distincte de la decision 3 : un code postal
    -- peut etre parfaitement VALIDE en France et n'etre pas SERVI par ce
    -- marchand (97200 Fort-de-France, par exemple).
    if v_country_cap.postal_code_pattern is not null
       and v_postal is not null
       and v_postal !~ v_country_cap.postal_code_pattern then
      raise exception using errcode = '22023',
        message = 'SCANYM_POSTAL_CODE_INVALID: ' || v_postal || ' (pays ' || v_country || ')';
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
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city, country)
    values (v_order_id, v_address, v_postal, v_street, v_city, coalesce(v_country, 'FR'));
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

    -- PRODUCT SERVICE MODES v1 -- vérification PAR LIGNE, même patron
    -- que le check établissement (v_mode_enabled) plus haut. Sémantique
    -- ALL-par-absence : une ligne sans restriction (aucune ligne dans
    -- menu_item_sale_modes) n'est jamais bloquée ici. Indépendant de
    -- withdrawal_eligible -- aucune référence croisée.
    if exists (
      select 1 from public.menu_item_sale_modes mism
      where mism.menu_item_id = v_menu_item.id
    ) and not exists (
      select 1 from public.menu_item_sale_modes mism
      where mism.menu_item_id = v_menu_item.id and mism.mode_code = p_service_mode
    ) then
      raise exception using errcode = 'P0002',
        message = 'SCANYM_PRODUCT_NOT_AVAILABLE_FOR_SERVICE_MODE: ' || v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot,
      withdrawal_exempt_at_order_time, withdrawal_legal_basis_at_order_time,
      merchant_withdrawal_regime_at_order_time, service_mode_eligible_at_order_time
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate,
      case when v_withdrawal_regime_snapshot is null then null
           else (v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE') end,
      v_withdrawal_legal_basis,
      v_withdrawal_regime_snapshot, true
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
        raise exception using errcode = 'P0002',
          message = 'SCANYM_OUT_OF_DELIVERY_ZONE: Zone non desservie: ' || v_postal;
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

  -- B1 — INSTANTANÉ IMMUABLE DE LA DÉCISION DE LIVRAISON.
  -- Alimenté EXCLUSIVEMENT par v_resolved, lu une seule fois plus haut :
  -- aucune relecture de la configuration, donc aucune course possible
  -- avec une édition tarifaire marchande concurrente (D-B1-6, Option 2).
  -- v_fulfillment_rule_id non nul <=> une règle a été retenue par le
  -- nouveau moteur ; nul pour tout autre mode et pour le chemin legacy.
  if v_fulfillment_rule_id is not null then

    -- B1-A-01 — cohérence frais <-> tarif instantané, FAIL-CLOSED.
    -- Seul instant où les deux valeurs sont en main (le frais n'est pas
    -- dupliqué dans l'instantané, §5.2). Même discipline fail-closed que
    -- compute_delivery_fee_tax_allocation v1.2.
    if v_delivery_fee is distinct from (
      case
        when v_resolved.pricing_mode = 'free' then 0
        when v_resolved.pricing_mode = 'fixed' then v_resolved.fixed_fee
        when v_resolved.pricing_mode = 'free_above_threshold' then
          case when coalesce(v_subtotal, 0) >= v_resolved.free_threshold
               then 0 else v_resolved.fixed_fee end
        else null
      end
    ) then
      raise exception
        'SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT: frais appliqué (%) incohérent avec le tarif résolu (mode %, fixe %, seuil %, sous-total %) -- commande refusée',
        v_delivery_fee, v_resolved.pricing_mode, v_resolved.fixed_fee,
        v_resolved.free_threshold, v_subtotal
        using errcode = '22023';
    end if;

    insert into public.order_delivery_fulfillment_snapshot (
      order_id, fulfillment_rule_id, is_fallback, matched_prefix,
      pricing_mode, fixed_fee, free_threshold, customer_text
    ) values (
      v_order_id,
      v_fulfillment_rule_id,
      v_resolved.is_fallback,
      v_resolved.matched_prefix,
      v_resolved.pricing_mode,
      v_resolved.fixed_fee,
      v_resolved.free_threshold,
      v_resolved.customer_text
    );
  end if;

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

-- ------------------------------------------------------------------
-- §7.3 — P-8 (post-commit, vérifié ICI dans la même transaction,
-- immédiatement après la DDL, avant le COMMIT final).
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'order_delivery_fulfillment_snapshot'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: public.order_delivery_fulfillment_snapshot absente après DDL.';
  end if;

  if has_table_privilege('authenticated', 'public.order_delivery_fulfillment_snapshot', 'UPDATE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated porte UPDATE sur order_delivery_fulfillment_snapshot -- table censée être écrite EXCLUSIVEMENT par create_order (SECURITY DEFINER).';
  end if;
  if has_table_privilege('authenticated', 'public.order_delivery_fulfillment_snapshot', 'INSERT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated porte INSERT sur order_delivery_fulfillment_snapshot.';
  end if;
  if has_table_privilege('authenticated', 'public.order_delivery_fulfillment_snapshot', 'DELETE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated porte DELETE sur order_delivery_fulfillment_snapshot.';
  end if;
end $$;

commit;

-- ============================================================
-- IDEMPOTENCE DE CE FICHIER
--
-- Ce fichier est un DRAFT, jamais installé automatiquement plus d'une
-- fois (même convention que tous les fichiers DRAFT-lot-*.sql de ce
-- dépôt : réécrit sur place si correction nécessaire avant
-- installation, jamais ré-exécuté tel quel après installation).
-- "create or replace function" (create_order) serait ré-exécutable
-- sans erreur, mais "create table" ne l'est pas -- le préflight P-7
-- (anti-dérive) refuse explicitement une double application de ce
-- fichier précis, et comme TOUTE la migration tourne dans UNE seule
-- transaction (begin;...commit;), un échec P-7 annule AUSSI le
-- CREATE OR REPLACE FUNCTION qui suit : aucune moitié de migration ne
-- peut jamais rester appliquée.
-- ============================================================
