-- ============================================================
-- Scanym — SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING
-- FOUNDATION (DRAFT — NON APPLIQUÉ EN PRODUCTION).
--
-- ⚠️ NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION. Testable uniquement
-- dans le harnais PostgreSQL jetable
-- (supabase/tests/server-delivery-fulfillment-pricing-check.sh).
--
-- CONTEXTE : fait suite au rapport d'audit de préparation "AU LAIT CRU
-- — DELIVERY ACTIVATION READINESS AUDIT" (verdict `STOP — AU LAIT CRU
-- ACTIVATION REQUIRES PRICING/PRIVACY FOUNDATION`), qui a établi deux
-- lacunes structurelles cumulées :
--   1. aucune colonne de tarification n'existe au niveau de la RÈGLE
--      de fulfillment (restaurant_sale_mode_fulfillments) -- seul le
--      NIVEAU MODE (restaurant_sale_modes.pricing_mode/fixed_fee/
--      free_threshold) porte un tarif, structurellement incapable de
--      représenter deux tarifs différents pour deux règles du même
--      mode "delivery" (ex. Au Lait Cru : local_delivery payant chez
--      Stuart, refrigerated_shipping payant chez Chronofresh) ;
--   2. create_order n'utilise NI le modèle Lot A/B/C (restaurant_sale_
--      mode_fulfillments/resolve_delivery_fulfillment) NI aucune
--      notion de frais de livraison -- il valide encore la zone via
--      l'ancien champ JSONB restaurant_sale_modes.config->
--      'delivery_zone_prefixes', et calcule le total UNIQUEMENT comme
--      la somme des lignes produit.
--
-- Ce fichier ferme les deux lacunes, en réutilisant STRICTEMENT
-- l'existant :
--   - étend restaurant_sale_mode_fulfillments (Lot A, déjà mergé sur
--     main) de 3 colonnes de tarification PAR RÈGLE ;
--   - étend le résolveur interne PARTAGÉ resolve_delivery_fulfillment
--     (Lot B.1, DRAFT-lot-fulfillment-routing-lot-b-rpc.sql, NON
--     modifié par ce fichier -- ce DRAFT le REMPLACE par une nouvelle
--     définition, DROP puis CREATE, car sa signature/forme de retour
--     change) pour y calculer le frais résolu ;
--   - étend get_restaurant_public_delivery_fulfillments (même fichier
--     Lot B, même traitement DROP/CREATE) pour exposer les 3 champs de
--     tarification PUBLICS (jamais `provider`) nécessaires à un
--     aperçu client avant soumission ;
--   - étend orders d'un instantané figé de la décision de routage/
--     tarification prise à la commande (jamais réécrit par un futur
--     changement de configuration) ;
--   - REMPLACE create_order (migration-v82-lot2a-sale-modes.sql, même
--     traitement DROP/CREATE puisque la table de retour change) par
--     une version qui devient SERVEUR AUTORITATIF pour le fulfillment
--     et le frais de livraison, via un PONT DE MIGRATION serveur
--     symétrique au pont frontend déjà en production (Lot C,
--     resolveActiveDeliveryStatus, lib/delivery.ts) : au moins une
--     règle ACTIVE (règle + mode parent) existe pour ce
--     (restaurant, mode) -> nouveau moteur EXCLUSIF, jamais de repli
--     legacy ; sinon -> chemin legacy INCHANGÉ (Sanaa, tout tenant non
--     migré).
--
-- PORTÉE STRICTE -- CE LOT NE FAIT PAS :
--   - AUCUNE activation tenant : ce fichier n'insère STRICTEMENT
--     AUCUNE ligne dans restaurant_sale_mode_fulfillments, ni pour Au
--     Lait Cru, ni pour Sanaa, ni pour aucun établissement -- la table
--     reste vide après ce lot, exactement comme après LOT A/B/B.1/C.
--   - AUCUNE migration Sanaa : le pont de migration serveur préserve
--     EXACTEMENT son comportement actuel (aucune ligne de fulfillment
--     -> chemin legacy, byte-identique).
--   - AUCUN appel Stuart/Chronofresh : `provider` reste une colonne de
--     configuration interne, jamais lue par aucune RPC publique,
--     aucun appel réseau vers un prestataire externe.
--   - AUCUNE tarification au poids, AUCUN devis API en direct (Stuart
--     ou Chronofresh) -- `pricing_mode` reste volontairement limité à
--     ('free', 'fixed', 'free_above_threshold') pour ce lot.
--   - AUCUN changement de payment/paiement.
--   - AUCUNE case de consentement persistée (voir le frontend,
--     CartPanel.tsx : état local éphémère uniquement, aucune colonne
--     ajoutée ici pour ce sujet).
--
-- Compatibilité : pour un tenant SANS règle de fulfillment ACTIVE
-- (100% des tenants réels aujourd'hui), aucun comportement visible ne
-- change -- même messages d'erreur, même ordre de vérification, même
-- montant total, delivery_fee=0, aucune colonne d'instantané renseignée.
-- ============================================================

-- ------------------------------------------------------------------
-- Contrôle préalable (anti-dérive) : les prérequis (LOT A/B) doivent
-- déjà exister ; aucun objet nouveau de CE lot ne doit déjà exister
-- (empêche une double application accidentelle).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_mode_fulfillments')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_mode_fulfillments introuvable — prérequis LOT A manquant, DRAFT server delivery pricing annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_delivery_fulfillment'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.resolve_delivery_fulfillment (signature LOT B.1, 4 arguments) introuvable — prérequis LOT B manquant, DRAFT server delivery pricing annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_restaurant_public_delivery_fulfillments'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_restaurant_public_delivery_fulfillments introuvable — prérequis LOT B manquant, DRAFT server delivery pricing annulé.';
  end if;

  if not exists (select 1 from pg_proc where proname = 'create_order') then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.create_order introuvable — prérequis manquant, DRAFT server delivery pricing annulé.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_sale_mode_fulfillments' and column_name = 'pricing_mode'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_mode_fulfillments.pricing_mode existe déjà — DRAFT server delivery pricing déjà appliqué, application annulée.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'fulfillment_rule_id'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: orders.fulfillment_rule_id existe déjà — DRAFT server delivery pricing déjà appliqué, application annulée.';
  end if;
end $$;

begin;

-- ==================================================================
-- 1. TARIFICATION PAR RÈGLE DE FULFILLMENT (mission §3).
--
-- Vocabulaire volontairement PLUS RESTREINT que
-- restaurant_sale_modes.pricing_mode ('free','fixed',
-- 'free_above_threshold','external_quote') : 'external_quote' est
-- EXCLU ici -- aucune intégration API Stuart/Chronofresh n'existe dans
-- ce lot (mission §18), l'autoriser produirait une valeur qu'aucun
-- résolveur ne sait traduire en frais réel. Trois colonnes seulement
-- (pas de "poids"/"zone matrix"/"devis") -- smallest model suffisant
-- pour un tarif fixe configuré + seuil de gratuité optionnel (mission
-- §3 : "Do NOT implement weight-based pricing / live quote / zone
-- matrices").
--
-- La combinaison CHECK ci-dessous rend impossible tout état ambigu
-- (ex. pricing_mode='free' avec un fixed_fee non-null qui ne serait
-- jamais lu -- donnée fantôme trompeuse) -- réutilise DB CONSTRAINTS
-- plutôt que de laisser cette invariant dépendre d'une future UI
-- d'édition seule (même principe que le rapport ADMIN-MANAGED
-- COMMERCIAL CONFIGURATION, section "SAFETY / VALIDATION").
-- ------------------------------------------------------------------
alter table public.restaurant_sale_mode_fulfillments
  add column pricing_mode text not null default 'free'
    check (pricing_mode in ('free', 'fixed', 'free_above_threshold')),
  add column fixed_fee numeric(10,2)
    check (fixed_fee is null or fixed_fee >= 0),
  add column free_threshold numeric(10,2)
    check (free_threshold is null or free_threshold >= 0),
  add constraint restaurant_sale_mode_fulfillments_pricing_combo_valid check (
    (pricing_mode = 'free' and fixed_fee is null and free_threshold is null)
    or (pricing_mode = 'fixed' and fixed_fee is not null and free_threshold is null)
    or (pricing_mode = 'free_above_threshold' and fixed_fee is not null and free_threshold is not null)
  );

comment on column public.restaurant_sale_mode_fulfillments.pricing_mode is
  'SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION — tarification PAR RÈGLE (jamais par mode, voir restaurant_sale_modes.pricing_mode qui reste un concept SÉPARÉ, non lu par ce mécanisme). Vocabulaire volontairement restreint : pas de ''external_quote'' ici (aucune intégration API dans ce lot).';

-- ==================================================================
-- 2. RÉSOLVEUR INTERNE — REMPLACÉ (signature et forme de retour
-- changent : ajout de p_subtotal, ajout de fulfillment_rule_id/
-- pricing_mode/fixed_fee/free_threshold/delivery_fee). DROP requis
-- (CREATE OR REPLACE ne permet pas de changer la table de retour d'une
-- fonction).
--
-- Algorithme de correspondance/fallback/min_items INCHANGÉ (Lot B.1) —
-- seul l'ajout du calcul du frais est nouveau, jamais une seconde
-- implémentation de la correspondance elle-même.
--
-- CALCUL DU FRAIS (mission §8, IDENTIQUE à computeDeliveryFee,
-- lib/delivery.ts — prouvé cas par cas par
-- tests/fixtures/delivery-pricing-cases.json) :
--   - calculé UNIQUEMENT si une règle a été retenue (fallback ou non),
--     que le résultat soit eligible=true OU block='below-min' — même
--     convention déjà en vigueur pour fulfillment_code/customer_text
--     (LOT B.1) ;
--   - 'free'                -> 0 ;
--   - 'fixed'                -> fixed_fee ;
--   - 'free_above_threshold' -> 0 si coalesce(p_subtotal,0) >=
--     free_threshold, sinon fixed_fee. p_subtotal NULL/négatif traité
--     comme 0 (jamais une gratuité optimiste par accident).
-- ------------------------------------------------------------------
drop function public.resolve_delivery_fulfillment(uuid, text, text, integer);

create function public.resolve_delivery_fulfillment(
  p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer, p_subtotal numeric default null
)
returns table (
  eligible            boolean,
  fulfillment_rule_id uuid,
  fulfillment_code    text,
  provider            text,
  matched_prefix      text,
  zone_prefixes       text[],
  is_fallback         boolean,
  min_items           integer,
  customer_text       text,
  display_order       integer,
  pricing_mode        text,
  fixed_fee           numeric,
  free_threshold      numeric,
  delivery_fee        numeric,
  block               text,
  missing             integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with normalized as (
    select nullif(btrim(p_postal_code), '') as code
  ),
  parent_mode_enabled as (
    select exists (
      select 1
      from public.restaurant_sale_modes rsm
      where rsm.restaurant_id = p_restaurant_id
        and rsm.mode_code = p_mode_code
        and rsm.enabled = true
    ) as enabled
  ),
  candidate_rules as (
    select f.id, f.fulfillment_code, f.provider, f.zone_prefixes, f.is_fallback,
           f.min_items, f.customer_text, f.display_order,
           f.pricing_mode, f.fixed_fee, f.free_threshold
    from public.restaurant_sale_mode_fulfillments f
    where f.restaurant_id = p_restaurant_id
      and f.mode_code = p_mode_code
      and f.enabled = true
      and (select enabled from parent_mode_enabled)
      and (select code from normalized) is not null
  ),
  matched_rule as (
    select c.*,
      (select zp.prefix
         from unnest(c.zone_prefixes) with ordinality as zp(prefix, ord)
         where (select code from normalized) like zp.prefix || '%'
         order by zp.ord
         limit 1) as matched_prefix
    from candidate_rules c
    where c.is_fallback = false
      and exists (
        select 1 from unnest(c.zone_prefixes) as zp(prefix)
        where (select code from normalized) like zp.prefix || '%'
      )
    order by c.display_order asc
    limit 1
  ),
  fallback_rule as (
    select c.*, null::text as matched_prefix
    from candidate_rules c
    where c.is_fallback = true
      and not exists (select 1 from matched_rule)
    limit 1
  ),
  selected as (
    select * from matched_rule
    union all
    select * from fallback_rule
    limit 1
  )
  select
    (
      (select code from normalized) is not null
      and s.fulfillment_code is not null
      and not (
        s.min_items is not null
        and coalesce(p_total_count, 0) < s.min_items
      )
    ) as eligible,
    s.id as fulfillment_rule_id,
    s.fulfillment_code,
    s.provider,
    s.matched_prefix,
    s.zone_prefixes,
    s.is_fallback,
    s.min_items,
    s.customer_text,
    s.display_order,
    s.pricing_mode,
    s.fixed_fee,
    s.free_threshold,
    case
      when s.fulfillment_code is null then null
      when s.pricing_mode = 'free' then 0
      when s.pricing_mode = 'fixed' then s.fixed_fee
      when s.pricing_mode = 'free_above_threshold' then
        case when coalesce(p_subtotal, 0) >= s.free_threshold then 0 else s.fixed_fee end
      else null
    end as delivery_fee,
    case
      when (select code from normalized) is null then 'no-postal'
      when s.fulfillment_code is null then 'out-of-zone'
      when s.min_items is not null and coalesce(p_total_count, 0) < s.min_items then 'below-min'
      else null
    end as block,
    case
      when s.fulfillment_code is not null
       and s.min_items is not null
       and coalesce(p_total_count, 0) < s.min_items
        then s.min_items - coalesce(p_total_count, 0)
      else null
    end as missing
  from (select 1) one
  left join selected s on true;
$$;

comment on function public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric) is
  'SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION — étend le résolveur LOT B.1 (algorithme de correspondance INCHANGÉ) d''un paramètre p_subtotal et de 5 colonnes de sortie (fulfillment_rule_id, pricing_mode, fixed_fee, free_threshold, delivery_fee). delivery_fee calculé UNIQUEMENT si une règle est retenue (fallback ou non), IDENTIQUE à computeDeliveryFee (lib/delivery.ts), prouvé cas par cas par tests/fixtures/delivery-pricing-cases.json. Appelé désormais par create_order (seul appelant contrôlé) — jamais directement par un rôle applicatif (REVOKE ALL inchangé ci-dessous).';

revoke all on function public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric) from public, anon, authenticated;

-- ==================================================================
-- 3. RPC PUBLIQUE — REMPLACÉE (ajout de 3 colonnes de tarification
-- PUBLIQUES, jamais `provider`/`config`) pour permettre un aperçu du
-- frais de livraison AVANT soumission (mission §12) — le client
-- calcule un ESTIMÉ via computeDeliveryFee (lib/delivery.ts), le
-- serveur (create_order, ci-dessous) reste seul autoritatif au moment
-- réel de la commande (mission §13, déterminisme client/serveur :
-- MÊME algorithme des deux côtés, prouvé par
-- tests/fixtures/delivery-pricing-cases.json, jamais deux implémentations
-- indépendantes qui ne font que se ressembler).
-- ------------------------------------------------------------------
drop function public.get_restaurant_public_delivery_fulfillments(uuid);

create function public.get_restaurant_public_delivery_fulfillments(p_restaurant_id uuid)
returns table (
  fulfillment_code text,
  zone_prefixes    text[],
  is_fallback      boolean,
  min_items        integer,
  customer_text    text,
  display_order    integer,
  pricing_mode     text,
  fixed_fee        numeric,
  free_threshold   numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.fulfillment_code,
    f.zone_prefixes,
    f.is_fallback,
    f.min_items,
    f.customer_text,
    f.display_order,
    f.pricing_mode,
    f.fixed_fee,
    f.free_threshold
  from public.restaurant_sale_mode_fulfillments f
  join public.restaurant_sale_modes rsm
    on rsm.restaurant_id = f.restaurant_id
   and rsm.mode_code = f.mode_code
  join public.restaurants r on r.id = f.restaurant_id
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
    and f.enabled = true
    and rsm.enabled = true
    and r.is_active = true
    and r.status = 'active'
  order by f.display_order asc;
$$;

comment on function public.get_restaurant_public_delivery_fulfillments(uuid) is
  'FULFILLMENT ROUTING — projection publique des règles de routage fulfillment (mode delivery), étendue (SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION) de 3 champs de tarification PUBLICS (pricing_mode/fixed_fee/free_threshold) pour un aperçu client avant soumission. N''expose JAMAIS provider ni config JSONB brut. Vérifie explicitement restaurant_sale_modes.enabled ET restaurant_sale_mode_fulfillments.enabled (invariant LOT A, inchangé).';

revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from public;
revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from anon, authenticated, service_role;
grant execute on function public.get_restaurant_public_delivery_fulfillments(uuid) to anon, authenticated;

-- ==================================================================
-- 4. INSTANTANÉ DE COMMANDE (mission §9) — la décision de
-- fulfillment/tarification prise à la commande est figée sur la ligne
-- `orders` elle-même, jamais recalculée après coup : un futur
-- changement de configuration (nouveau tarif, règle supprimée) ne doit
-- jamais réécrire l'historique. fulfillment_rule_id référence la
-- règle (ON DELETE SET NULL — la suppression future d'une règle ne
-- doit jamais bloquer ni effacer une commande historique) ;
-- fulfillment_code/provider_code sont des COPIES texte indépendantes,
-- qui survivent même à la suppression de la ligne référencée.
-- `provider_code` reste une donnée STRICTEMENT interne (jamais lue par
-- aucune RPC publique, jamais par aucun composant customer-facing —
-- mission §10) ; SEUL le code (ex. 'stuart') est copié, JAMAIS de
-- configuration JSONB brute (mission §9 : "Do not persist raw
-- provider config").
--
-- CHECK total = subtotal + delivery_fee : invariant métier réutilisé
-- au niveau base (pas seulement en application), même principe que
-- documenté dans le rapport ADMIN-MANAGED COMMERCIAL CONFIGURATION,
-- section SAFETY/VALIDATION.
-- ------------------------------------------------------------------
alter table public.orders
  add column delivery_fee numeric(12,2) not null default 0
    check (delivery_fee >= 0),
  add column fulfillment_rule_id uuid
    references public.restaurant_sale_mode_fulfillments(id) on delete set null,
  add column fulfillment_code text,
  add column provider_code text,
  add constraint orders_total_equals_subtotal_plus_delivery_fee
    check (total = subtotal + delivery_fee);

comment on column public.orders.provider_code is
  'SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION — instantané STRICTEMENT interne du prestataire résolu à la commande (ex. ''stuart''). Jamais exposé par aucune RPC publique, jamais lu par aucun composant customer-facing (mission §10). Visible par le personnel authentifié via les mêmes privilèges SELECT déjà accordés sur cette table (aucun changement de GRANT nécessaire pour cette colonne).';

-- ==================================================================
-- 5. create_order — REMPLACÉ. Signature d'entrée INCHANGÉE (le client
-- ne fournit JAMAIS fulfillmentCode/provider/fee — mission "never
-- trust a delivery fee supplied by the frontend" ; aucun nouveau
-- paramètre p_*). Table de retour ÉTENDUE (subtotal/delivery_fee
-- explicites en plus de total) — DROP requis.
--
-- PONT DE MIGRATION SERVEUR (mission §6/§7), SYMÉTRIQUE au pont
-- frontend déjà en production (Lot C, resolveActiveDeliveryStatus,
-- lib/delivery.ts) :
--   - au moins une règle ACTIVE (règle ET mode parent enabled=true)
--     existe pour ce (restaurant_id, p_service_mode) -> NOUVEAU MOTEUR
--     EXCLUSIF : la validation de zone legacy
--     (restaurant_sale_modes.config->''delivery_zone_prefixes'') et le
--     minimum legacy (config->''delivery_min_items'') CESSENT d''être
--     consultés (mission §7 : "the following must cease to determine
--     delivery eligibility") — résolution intégrale déléguée à
--     resolve_delivery_fulfillment, JAMAIS une seconde implémentation ;
--   - aucune règle active -> chemin LEGACY, BYTE-IDENTIQUE au
--     comportement pré-existant (même requêtes, même ordre, mêmes
--     messages d''erreur) — Sanaa et tout tenant non migré ne voient
--     STRICTEMENT rien changer.
-- "Loading/error" (concept frontend, Lot C) n''existe pas ici : une
-- erreur de fonction/BD lève simplement l''exception PL/pgSQL standard
-- (fail-closed par construction du langage, mission §6).
--
-- Portée volontairement restreinte à p_service_mode=''delivery'' :
-- pickup/table/room_service restent ENTIÈREMENT inchangés (mission
-- §16 : "Pickup must not incur delivery fee... must not require
-- delivery routing... do not couple pickup to postal code") — même
-- périmètre que la validation de zone legacy qu''il remplace, jamais
-- étendu à d''autres modes dans ce lot.
-- ------------------------------------------------------------------
drop function public.create_order(text, text, jsonb, integer, jsonb, text, text);

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
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
  -- SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION :
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
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
    -- PONT DE MIGRATION SERVEUR (mission §6/§7, réordonné par la
    -- correction SADFP-01) : même critère que le pont frontend (Lot C)
    -- — au moins une règle ACTIVE (règle ET mode parent enabled=true),
    -- jamais une simple existence de ligne (une règle désactivée compte
    -- comme "pas de règle", cohérent avec
    -- get_restaurant_public_delivery_fulfillments qui la filtre déjà).
    -- Ce calcul doit se faire AVANT la dérivation du code postal
    -- puisque la SOURCE même du code postal diffère maintenant selon
    -- la branche (structuré pour le nouveau moteur, regex d'adresse
    -- pour le legacy) -- voir SADFP-01.
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
      -- SADFP-01 (CORRECTION) : le nouveau moteur route EXCLUSIVEMENT
      -- sur le code postal STRUCTURÉ transmis par le client dans
      -- p_customer->>'postalCode' -- jamais une extraction regex
      -- depuis l'adresse en texte libre (v_address), qui reste
      -- uniquement stockée/affichée mais ne doit plus jamais piloter
      -- le routage. Un client ne peut donc plus influencer le routage
      -- en injectant un faux numéro dans le champ adresse.
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      -- LEGACY — BYTE-IDENTIQUE au comportement pré-existant (tenant
      -- zéro-règle : la dérivation reste la regex d'adresse existante,
      -- jamais modifiée par cette correction).
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
    insert into public.order_delivery_address (order_id, formatted_address, postal_code)
    values (v_order_id, v_address, v_postal);
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
      quantity, unit_price, line_total
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    -- LEGACY minimum — BYTE-IDENTIQUE au comportement pré-existant.
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
    -- SERVEUR AUTORITATIF : résolution intégrale ici, réutilisant
    -- l'UNIQUE résolveur partagé — jamais une seconde implémentation.
    -- Ne fait JAMAIS confiance à une donnée fournie par le client (le
    -- payload p_customer ne porte ni fulfillmentCode, ni provider, ni
    -- aucun frais — voir lib/services/order-payload.ts, INCHANGÉ par
    -- ce lot).
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

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public, anon;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text) to authenticated, anon;

commit;

-- ============================================================
-- AUCUNE DONNÉE TENANT : ce fichier n'insère STRICTEMENT AUCUNE ligne
-- dans restaurant_sale_mode_fulfillments (ni Au Lait Cru, ni Sanaa, ni
-- aucun établissement) — la table reste vide après ce lot.
--
-- NON-RÉGRESSION CRITIQUE : pour Sanaa et tout tenant SANS règle de
-- fulfillment active, ce fichier ne change STRICTEMENT rien
-- d'observable — mêmes requêtes exécutées, même ordre, mêmes messages
-- d'erreur, delivery_fee=0, aucune colonne d'instantané renseignée.
--
-- TESTS AUTOMATISÉS : voir
-- supabase/tests/server-delivery-fulfillment-pricing-check.sh
-- (harnais PostgreSQL jetable, jamais exécuté contre Production).
-- ============================================================
