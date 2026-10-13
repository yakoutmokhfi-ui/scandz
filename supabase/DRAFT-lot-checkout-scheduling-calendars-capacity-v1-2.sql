-- ============================================================
-- Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2)
-- Calendriers de préparation / disponibilité, heure limite + J+X,
-- jours fériés explicites, capacité optionnelle par créneau.
-- (DRAFT — NOT APPLIED — ne PAS appliquer sans GO d'intégration)
--
-- Parent : main 03441a5ef1d371e90e3bfe3438e1a29e211d0537
--          (CSDJ-1 v1.10 fusionné via #145, appliqué en PROD).
-- Rollback : DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql
--
-- ADDITIF. Ce fichier n'édite AUCUN objet CSDJ-1 existant, sauf UN
-- renommage de fonction interne (voir §D) :
--   - il AJOUTE 5 colonnes à restaurant_fulfillment_schedule ;
--   - il crée 5 tables : deux tables de calendrier de préparation, deux
--     tables de calendrier férié, une table de réservation de capacité ;
--   - il crée les fonctions v1.2 ;
--   - il RENOMME l'ancienne résolution interne
--     resolve_fulfillment_schedule -> resolve_fulfillment_schedule_v1
--     (corps INCHANGÉ, octet pour octet) et la remplace, sous le MÊME
--     nom, MÊME signature et MÊMES colonnes de sortie, par un
--     répartiteur. get_checkout_fulfillment_schedule (lecture publique,
--     19 colonnes) n'est PAS modifiée : le contrat de réponse CSDJ-1
--     est donc préservé tel quel.
--
-- COMPATIBILITÉ. Une planification existante garde
-- schedule_method_version = 'v1' et se comporte EXACTEMENT comme avant.
-- La méthode 'v1.2' est une activation EXPLICITE, par commerçant et par
-- portée, via mutate_merchant_fulfillment_schedule_v12. Ce fichier
-- n'active aucune planification, ne crée aucune ligne de configuration
-- et ne contient aucune donnée métier (aucun jour férié, aucun délai).
--
-- NE TOUCHE PAS : create_order, update_order_status, le moteur de
-- paiement, l'autorité de tarification (resolve_delivery_fulfillment).
-- L'intégration de la capacité dans create_order appartient à
-- Debussy (CSDJ-3) ; le contrat est dans
-- docs/scheduling/csdj-v1.2-interface-contract.md.
--
-- ATOMICITÉ : une seule transaction, pré-vol et post-vol dedans.
-- ============================================================

begin;

-- ============================================================
-- §0  PRÉ-VOL ANTI-DÉRIVE — FAIL-CLOSED, DANS LA TRANSACTION
-- ============================================================
do $csdj12_preflight$
declare
  v_item text;
  v_n    integer;
begin
  -- P-1. Tables prérequises (CSDJ-1 + commandes).
  foreach v_item in array array[
    'public.restaurant_fulfillment_schedule',
    'public.restaurant_fulfillment_schedule_window',
    'public.restaurant_fulfillment_schedule_slot',
    'public.restaurant_fulfillment_schedule_closure',
    'public.orders'
  ] loop
    if pg_catalog.to_regclass(v_item) is null then
      raise exception 'SCANYM_SCHEMA_DRIFT: table prérequise % absente -- CSDJ v1.2 annulé.', v_item
        using errcode = '42P01';
    end if;
  end loop;

  -- P-2. Fonctions prérequises.
  foreach v_item in array array[
    'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)',
    'public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)',
    'public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)',
    'public.checkout_wall_time_instant(date,time without time zone,text)',
    'public.checkout_wall_time_status(date,time without time zone,text)',
    'public.has_role_in(uuid,text[])',
    'public.is_member_of(uuid)',
    'public.is_scanym_operator()'
  ] loop
    if pg_catalog.to_regprocedure(v_item) is null then
      raise exception 'SCANYM_SCHEMA_DRIFT: fonction prérequise % absente -- CSDJ v1.2 annulé.', v_item
        using errcode = '42883';
    end if;
  end loop;

  -- P-3. Colonnes de commande dont dépend la notion de « place tenue ».
  --      payment_status vient de PAYMENT P1 : s'il n'est pas appliqué,
  --      la fonction de décompte échouerait À L'EXÉCUTION, en
  --      production. On refuse donc ICI.
  foreach v_item in array array['id=uuid','restaurant_id=uuid','status=text','payment_status=text'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = 'public.orders'::regclass
        and a.attname = pg_catalog.split_part(v_item, '=', 1)
        and pg_catalog.format_type(a.atttypid, null) = pg_catalog.split_part(v_item, '=', 2)
        and not a.attisdropped
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: orders.% absent ou de type inattendu -- CSDJ v1.2 annulé AVANT toute création d''objet.', v_item
        using errcode = '42804';
    end if;
  end loop;

  -- P-4. Forme EXACTE de la sortie du résolveur CSDJ-1 (catalogue, pas
  --      sous-chaîne) : le répartiteur doit la reproduire à l'identique.
  foreach v_item in array array[
    'status=text','unfulfillable_reason=text','schedule_timezone=text',
    'date_selection_mode=text','slot_selection_mode=text',
    'time_granularity_minutes=smallint','first_eligible_date=date',
    'eligible_dates=date[]','offers=jsonb'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p,
      unnest(p.proargnames, p.proargmodes, p.proallargtypes) as a(argname, argmode, argtype)
      where p.oid = pg_catalog.to_regprocedure(
              'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)')
        and a.argmode = 't'
        and a.argname = pg_catalog.split_part(v_item, '=', 1)
        and pg_catalog.format_type(a.argtype, null) = pg_catalog.split_part(v_item, '=', 2)
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: resolve_fulfillment_schedule ne renvoie pas la colonne attendue « % » -- CSDJ v1.2 annulé.', v_item
        using errcode = '42804';
    end if;
  end loop;

  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_fulfillment_schedule';
  if v_n <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_fulfillment_schedule a % surcharge(s), 1 attendue -- CSDJ v1.2 annulé.', v_n
      using errcode = '42723';
  end if;

  -- P-5. Anti-double-application : aucun objet v1.2 ne doit exister.
  if pg_catalog.to_regclass('public.restaurant_fulfillment_prep_day') is not null
     or pg_catalog.to_regclass('public.restaurant_fulfillment_prep_closure') is not null
     or pg_catalog.to_regclass('public.public_holiday_calendar') is not null
     or pg_catalog.to_regclass('public.public_holiday_calendar_day') is not null
     or pg_catalog.to_regclass('public.order_fulfillment_capacity_reservation') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)') is not null
     or pg_catalog.to_regprocedure('public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,timestamp with time zone)') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = 'public.restaurant_fulfillment_schedule'::regclass
                  and a.attname in ('holiday_calendar_id','preparation_on_holidays',
                                    'availability_on_holidays','capacity_enabled','capacity_max_orders')
                  and not a.attisdropped)
  then
    raise exception 'SCANYM_ALREADY_APPLIED: un objet de CSDJ v1.2 existe déjà -- annulé.'
      using errcode = '42710';
  end if;

  -- P-6. Toute planification existante est de méthode 'v1' : la
  --      contrainte ajoutée plus bas n'en invalide aucune.
  if exists (select 1 from public.restaurant_fulfillment_schedule s
             where s.schedule_method_version is distinct from 'v1') then
    raise exception 'SCANYM_SCHEMA_DRIFT: une planification porte une méthode autre que v1 -- CSDJ v1.2 annulé.'
      using errcode = '23514';
  end if;

  -- P-7. Base de fuseaux IANA utilisable.
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = 'Europe/Paris') then
    raise exception 'SCANYM_SCHEMA_DRIFT: la base de fuseaux IANA du serveur est inutilisable -- CSDJ v1.2 annulé.'
      using errcode = '58000';
  end if;
end
$csdj12_preflight$;

-- ============================================================
-- §A  CALENDRIERS FÉRIÉS — STRUCTURE SEULE, AUCUNE DONNÉE
--
-- Aucune juridiction n'est choisie, aucun jeu de données n'est livré.
-- Les tables sont VIDES. Les peupler est une décision de produit
-- (voir docs/scheduling/csdj-v1.2-architecture.md §5). Tant qu'aucun
-- calendrier n'est rattaché à une planification ET qu'une politique
-- « closed » n'est pas posée, aucun jour n'est traité comme férié.
-- ============================================================
create table public.public_holiday_calendar (
  id           uuid primary key default pg_catalog.gen_random_uuid(),
  code         text not null unique
               check (pg_catalog.length(code) between 1 and 60 and code ~ '^[a-z0-9_-]+$'),
  label        text not null
               check (pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  region_code  text check (region_code is null or region_code ~ '^[A-Z0-9-]{1,10}$'),
  created_at   timestamptz not null default pg_catalog.now(),
  -- une région n'a de sens que dans un pays
  constraint phc_region_needs_country check (region_code is null or country_code is not null)
);

create table public.public_holiday_calendar_day (
  calendar_id uuid not null references public.public_holiday_calendar (id) on delete cascade,
  holiday_on  date not null,
  label       text check (label is null or pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  primary key (calendar_id, holiday_on)
);

comment on table public.public_holiday_calendar is
  'CSDJ v1.2 — calendriers de jours fériés NOMMÉS (pays/région optionnels). Table VIDE à la livraison : aucun jeu de données, aucune juridiction supposée.';

-- ============================================================
-- §B  PLANIFICATION : colonnes v1.2 et contraintes
-- ============================================================
alter table public.restaurant_fulfillment_schedule
  add column holiday_calendar_id       uuid,
  add column preparation_on_holidays   text    not null default 'open',
  add column availability_on_holidays  text    not null default 'open',
  add column capacity_enabled          boolean not null default false,
  add column capacity_max_orders       integer;

alter table public.restaurant_fulfillment_schedule
  add constraint rfs_holiday_calendar_fk
    foreign key (holiday_calendar_id) references public.public_holiday_calendar (id) on delete restrict,
  add constraint rfs_method_version_known
    check (schedule_method_version in ('v1', 'v1.2')),
  add constraint rfs_holiday_policy_values
    check (preparation_on_holidays in ('open', 'closed') and availability_on_holidays in ('open', 'closed')),
  -- Une politique « closed » sans calendrier ne ferme rien : on la refuse
  -- plutôt que de la laisser avoir l'air active.
  add constraint rfs_holiday_requires_calendar
    check (holiday_calendar_id is not null
           or (preparation_on_holidays = 'open' and availability_on_holidays = 'open')),
  add constraint rfs_capacity_positive
    check (capacity_max_orders is null or capacity_max_orders > 0),
  add constraint rfs_capacity_complete
    check (not capacity_enabled or capacity_max_orders is not null),
  add constraint rfs_capacity_needs_date
    check (not capacity_enabled or date_selection_mode <> 'informational_only'),
  -- En v1.2 le décalage de l'heure limite n'existe plus : l'origine se
  -- déplace sur le prochain jour de préparation. Un réglage ignoré en
  -- silence serait une deuxième autorité ; il est donc REFUSÉ.
  add constraint rfs_v12_no_cutoff_offset
    check (schedule_method_version <> 'v1.2' or cutoff_offset_days = 0),
  -- Les extensions v1.2 n'existent que pour la méthode v1.2 (jamais un
  -- réglage de capacité ou de férié posé sur une planification v1 qui
  -- l'ignorerait).
  add constraint rfs_v12_extensions_only
    check (schedule_method_version = 'v1.2'
           or (holiday_calendar_id is null and capacity_enabled = false));

-- ============================================================
-- §C  TABLES v1.2
-- ============================================================
create table public.restaurant_fulfillment_prep_day (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  weekday       smallint not null check (weekday between 0 and 6),
  primary key (restaurant_id, mode_code, rule_key, weekday),
  constraint rfpd_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade
);

create table public.restaurant_fulfillment_prep_closure (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  closed_on     date not null,
  label         text check (label is null or pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  primary key (restaurant_id, mode_code, rule_key, closed_on),
  constraint rfpc_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade
);

comment on table public.restaurant_fulfillment_prep_day is
  'CSDJ v1.2 — CALENDRIER DE PRÉPARATION : jours de la semaine où le commerçant prépare (0 = dimanche). Indépendant des fenêtres/créneaux, qui sont le calendrier de DISPONIBILITÉ client.';
comment on table public.restaurant_fulfillment_prep_closure is
  'CSDJ v1.2 — fermetures exceptionnelles de PRÉPARATION (journée entière). Les fermetures de disponibilité restent dans restaurant_fulfillment_schedule_closure.';

-- Réservation de capacité : UNE commande = UNE unité, quelle que soit la
-- quantité de produits. La ligne ne dit pas « place tenue » : c'est la
-- jointure avec la commande (fulfillment_capacity_is_holding) qui le dit,
-- donc une commande refusée/annulée libère sa place sans qu'aucun
-- appelant n'ait à « libérer » quoi que ce soit.
create table public.order_fulfillment_capacity_reservation (
  order_id         uuid primary key references public.orders (id) on delete cascade,
  restaurant_id    uuid not null,
  mode_code        text not null,
  rule_key         uuid not null,
  fulfillment_date date not null,
  slot_key         text not null default ''
                   check (slot_key = '' or (pg_catalog.length(slot_key) between 1 and 40 and slot_key ~ '^[a-z0-9_-]+$')),
  created_at       timestamptz not null default pg_catalog.now()
);

create index order_fulfillment_capacity_reservation_bucket_idx
  on public.order_fulfillment_capacity_reservation
  (restaurant_id, mode_code, rule_key, fulfillment_date, slot_key);

comment on table public.order_fulfillment_capacity_reservation is
  'CSDJ v1.2 — une ligne par commande ayant consommé UNE unité de capacité. Écrite uniquement par reserve_fulfillment_capacity (seule autorité transactionnelle). Aucun accès direct pour aucun rôle applicatif.';

-- ------------------------------------------------------------
-- RLS et GRANTS — revoke AVANT grant
-- ------------------------------------------------------------
alter table public.public_holiday_calendar               enable row level security;
alter table public.public_holiday_calendar_day           enable row level security;
alter table public.restaurant_fulfillment_prep_day       enable row level security;
alter table public.restaurant_fulfillment_prep_closure   enable row level security;
alter table public.order_fulfillment_capacity_reservation enable row level security;

revoke all on table public.public_holiday_calendar                from public, anon, authenticated, service_role;
revoke all on table public.public_holiday_calendar_day            from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_prep_day        from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_prep_closure    from public, anon, authenticated, service_role;
revoke all on table public.order_fulfillment_capacity_reservation from public, anon, authenticated, service_role;

grant select on table public.public_holiday_calendar              to authenticated;
grant select on table public.public_holiday_calendar_day          to authenticated;
grant select on table public.restaurant_fulfillment_prep_day      to authenticated;
grant select on table public.restaurant_fulfillment_prep_closure  to authenticated;
-- order_fulfillment_capacity_reservation : AUCUN grant.

-- Calendriers fériés : données de référence, non rattachées à un tenant.
create policy phc_select_authenticated on public.public_holiday_calendar
  for select to authenticated using (true);
create policy phcd_select_authenticated on public.public_holiday_calendar_day
  for select to authenticated using (true);

create policy rfpd_select_members on public.restaurant_fulfillment_prep_day
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_prep_day.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

create policy rfpc_select_members on public.restaurant_fulfillment_prep_closure
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_prep_closure.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

-- ============================================================
-- §D  FONCTIONS INTERNES (aucun accès pour aucun rôle applicatif)
-- ============================================================

-- Catalogue FERMÉ des motifs d'infaisabilité, version 1.2 : les cinq
-- motifs CSDJ-1 (dans le même ordre) puis les motifs v1.2.
create function public.checkout_unfulfillable_reasons_v12()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'no_offer_configured','granularity_missing','all_dates_closed',
    'horizon_exhausted','no_offer_in_horizon',
    'preparation_calendar_missing','no_preparation_day_in_horizon',
    'cutoff_unresolvable','capacity_exhausted'
  ]::text[];
$$;

-- Une place est TENUE tant que la commande n'est ni refusée ni annulée.
--
-- Le statut de PAIEMENT n'entre PAS dans la décision, volontairement :
--   * « pending » tient la place : aucune expiration n'est inventée ici
--     (décision CTO requise, voir l'architecture §6) ;
--   * « failed » / « cancelled » la tiennent AUSSI. Une nouvelle tentative
--     de paiement reste possible sur la même commande
--     (initiate_payment_attempt ne refuse que paid/pending) et remet
--     payment_status à « pending » : si la place avait été rendue entre
--     temps, la reprise la REPRENDRAIT sans contrôle et le créneau serait
--     surréservé. Rendre la place sur échec de paiement exige donc un
--     contrôle de capacité à la reprise, c'est-à-dire un point
--     d'intégration dans le moteur de paiement, qui n'est pas à ce lot.
--     Le primitif de libération explicite existe
--     (release_fulfillment_capacity) ; son branchement est la décision.
-- Le second paramètre est conservé pour que la politique approuvée ne
-- change QUE ce corps de fonction.
create function public.fulfillment_capacity_is_holding(p_status text, p_payment_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status is distinct from 'rejected'
     and p_status is distinct from 'cancelled';
$$;

create function public.fulfillment_capacity_used(
  p_restaurant_id uuid, p_mode_code text, p_rule_key uuid, p_date date, p_slot_key text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from public.order_fulfillment_capacity_reservation r
  join public.orders o on o.id = r.order_id
  where r.restaurant_id = p_restaurant_id
    and r.mode_code = p_mode_code
    and r.rule_key = p_rule_key
    and r.fulfillment_date = p_date
    and r.slot_key = coalesce(p_slot_key, '')
    and public.fulfillment_capacity_is_holding(o.status, o.payment_status);
$$;

create function public.csdj12_preparation_open(
  p_s public.restaurant_fulfillment_schedule, p_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.restaurant_fulfillment_prep_day d
           where d.restaurant_id = p_s.restaurant_id and d.mode_code = p_s.mode_code
             and d.rule_key = p_s.rule_key
             and d.weekday = pg_catalog.date_part('dow', p_date)::smallint)
     and not exists (
           select 1 from public.restaurant_fulfillment_prep_closure c
           where c.restaurant_id = p_s.restaurant_id and c.mode_code = p_s.mode_code
             and c.rule_key = p_s.rule_key and c.closed_on = p_date)
     and not (
           p_s.preparation_on_holidays = 'closed'
           and p_s.holiday_calendar_id is not null
           and exists (select 1 from public.public_holiday_calendar_day h
                       where h.calendar_id = p_s.holiday_calendar_id and h.holiday_on = p_date));
$$;

create function public.csdj12_availability_closed(
  p_s public.restaurant_fulfillment_schedule, p_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.restaurant_fulfillment_schedule_closure c
           where c.restaurant_id = p_s.restaurant_id and c.mode_code = p_s.mode_code
             and c.rule_key = p_s.rule_key and c.closed_on = p_date)
      or (p_s.availability_on_holidays = 'closed'
          and p_s.holiday_calendar_id is not null
          and exists (select 1 from public.public_holiday_calendar_day h
                      where h.calendar_id = p_s.holiday_calendar_id and h.holiday_on = p_date));
$$;

-- Offres d'UNE date : construction REPRISE VERBATIM du résolveur CSDJ-1
-- v1.10 (occurrence tout-ou-rien, grille validée, instant minimal). Seuls
-- les noms de variables changent. Elle ne connaît NI heure limite, NI
-- fermeture, NI capacité : ces décisions sont prises par l'appelant.
create function public.checkout_schedule_day_offers_v12(
  p_s public.restaurant_fulfillment_schedule, p_date date, p_min_instant timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_day$
declare
  v_uses_slots boolean := (p_s.slot_selection_mode = 'fixed_slots');
  v_day        jsonb := '[]'::jsonb;
  v_off        record;
  v_start_min  integer;
  v_end_min    integer;
  v_t          integer;
  v_pick       integer;
  v_grid_sound boolean;
  v_inst       timestamptz;
begin
  for v_off in
    select * from (
      select x.slot_key, x.starts_at, x.ends_at
      from public.restaurant_fulfillment_schedule_slot x
      where v_uses_slots
        and x.restaurant_id = p_s.restaurant_id and x.mode_code = p_s.mode_code
        and x.rule_key = p_s.rule_key
        and x.weekday = pg_catalog.date_part('dow', p_date)::smallint
      union all
      select null::text, w.starts_at, w.ends_at
      from public.restaurant_fulfillment_schedule_window w
      where not v_uses_slots
        and w.restaurant_id = p_s.restaurant_id and w.mode_code = p_s.mode_code
        and w.rule_key = p_s.rule_key
        and w.weekday = pg_catalog.date_part('dow', p_date)::smallint
    ) o
    order by o.starts_at, coalesce(o.slot_key, '')
  loop
    v_start_min := pg_catalog.date_part('hour', v_off.starts_at)::integer * 60
                 + pg_catalog.date_part('minute', v_off.starts_at)::integer;
    v_end_min   := pg_catalog.date_part('hour', v_off.ends_at)::integer * 60
                 + pg_catalog.date_part('minute', v_off.ends_at)::integer;

    -- CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01 (repris)
    if public.checkout_wall_time_status(p_date, v_off.ends_at, p_s.timezone)
         <> 'valid_unique' then
      continue;
    end if;

    if p_s.slot_selection_mode = 'time_within_window' then
      v_pick := null;
      v_grid_sound := true;
      v_t := v_start_min;
      while v_t < v_end_min loop
        if public.checkout_wall_time_status(
             p_date, pg_catalog.make_time(v_t / 60, v_t % 60, 0), p_s.timezone)
           <> 'valid_unique' then
          v_grid_sound := false;
          exit;
        end if;
        if v_pick is null then
          v_inst := public.checkout_wall_time_instant(
            p_date, pg_catalog.make_time(v_t / 60, v_t % 60, 0), p_s.timezone);
          if v_inst is not null and v_inst >= p_min_instant then
            v_pick := v_t;
          end if;
        end if;
        v_t := v_t + p_s.time_granularity_minutes;
      end loop;
      if not v_grid_sound or v_pick is null then
        continue;
      end if;
      v_day := v_day || pg_catalog.jsonb_build_object(
        'slot_key', null,
        'starts_at', pg_catalog.to_char(pg_catalog.make_time(v_pick / 60, v_pick % 60, 0), 'HH24:MI'),
        'ends_at', pg_catalog.to_char(v_off.ends_at, 'HH24:MI'));
      continue;
    end if;

    v_inst := public.checkout_wall_time_instant(p_date, v_off.starts_at, p_s.timezone);
    if v_inst is null or v_inst < p_min_instant then
      continue;
    end if;
    v_day := v_day || pg_catalog.jsonb_build_object(
      'slot_key', v_off.slot_key,
      'starts_at', pg_catalog.to_char(v_off.starts_at, 'HH24:MI'),
      'ends_at', pg_catalog.to_char(v_off.ends_at, 'HH24:MI'));
  end loop;
  return v_day;
end
$csdj12_day$;

-- ============================================================
-- §E  RÉSOLUTION v1.2 — AUTORITÉ SERVEUR
--
--   1. origine : aujourd'hui si c'est un jour de préparation ET que
--      l'heure limite n'est pas atteinte ; sinon le prochain jour de
--      préparation STRICTEMENT postérieur. Heure limite atteinte =
--      « maintenant >= limite » (l'instant exact compte comme atteint).
--      Un jour sans préparation ne consulte pas l'heure limite.
--   2. J+X : cible = origine + min_lead_days, en jours CALENDAIRES.
--   3. de la cible à l'horizon, on retient les dates qui ont une offre,
--      ne sont ni fermées en disponibilité ni fériées-fermées, et dont
--      au moins une offre survit à l'instant minimal ; « avancer
--      jusqu'à la prochaine date éligible » est ce parcours.
--   4. capacité (si activée et demandée) : une offre pleine est retirée,
--      une date sans offre restante est retirée. Aucun compte exposé.
--   Aucune date n'est inventée, aucun repli silencieux : un refus a un
--   motif nommé.
-- ============================================================
create function public.resolve_fulfillment_schedule_v12(
  p_restaurant_id uuid,
  p_mode_code text,
  p_fulfillment_rule_id uuid default null,
  p_now timestamptz default pg_catalog.now(),
  p_apply_capacity boolean default true
)
returns table (
  status                   text,
  unfulfillable_reason     text,
  schedule_timezone        text,
  date_selection_mode      text,
  slot_selection_mode      text,
  time_granularity_minutes smallint,
  first_eligible_date      date,
  eligible_dates           date[],
  offers                   jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_resolve$
declare
  v_s            public.restaurant_fulfillment_schedule;
  v_rule_key     uuid := coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_uses_slots   boolean;
  v_has_offer    boolean;
  v_today        date;
  v_last         date;
  v_origin       date;
  v_target       date;
  v_d            date;
  v_cut_at       timestamptz;
  v_cut_reached  boolean := false;
  v_floor        timestamptz;
  v_min_instant  timestamptz;
  v_day          jsonb;
  v_kept         jsonb;
  v_el           jsonb;
  v_dates        date[] := array[]::date[];
  v_offers       jsonb := '{}'::jsonb;
  v_saw_closure  boolean := false;
  v_saw_open     boolean := false;
  v_saw_full     boolean := false;
begin
  select * into v_s
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code and s.rule_key = v_rule_key;

  if not found or v_s.enabled is not true then
    return query select 'absent'::text, null::text, null::text, null::text, null::text,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_s.schedule_method_version <> 'v1.2' then
    raise exception 'CSDJ12_WRONG_METHOD: resolve_fulfillment_schedule_v12 appelée sur une planification de méthode %.', v_s.schedule_method_version
      using errcode = '22023';
  end if;

  if v_s.date_selection_mode = 'informational_only' then
    return query select 'informational_only'::text, null::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  v_uses_slots := (v_s.slot_selection_mode = 'fixed_slots');

  if v_s.slot_selection_mode = 'time_within_window' and v_s.time_granularity_minutes is null then
    return query select 'unfulfillable'::text, 'granularity_missing'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_uses_slots then
    select exists (select 1 from public.restaurant_fulfillment_schedule_slot x
                   where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
                     and x.rule_key = v_rule_key) into v_has_offer;
  else
    select exists (select 1 from public.restaurant_fulfillment_schedule_window x
                   where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
                     and x.rule_key = v_rule_key) into v_has_offer;
  end if;
  if not v_has_offer then
    return query select 'unfulfillable'::text, 'no_offer_configured'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  -- Un calendrier de préparation VIDE est une configuration impossible,
  -- pas un « tous les jours » implicite.
  if not exists (select 1 from public.restaurant_fulfillment_prep_day d
                 where d.restaurant_id = p_restaurant_id and d.mode_code = p_mode_code
                   and d.rule_key = v_rule_key) then
    return query select 'unfulfillable'::text, 'preparation_calendar_missing'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  v_today := (p_now at time zone v_s.timezone)::date;
  v_last  := v_today + v_s.booking_horizon_days;

  -- ── 1. ORIGINE ────────────────────────────────────────────
  if public.csdj12_preparation_open(v_s, v_today) then
    if v_s.cutoff_time is not null then
      v_cut_at := public.checkout_wall_time_instant(v_today, v_s.cutoff_time, v_s.timezone);
      if v_cut_at is null then
        -- L'heure limite d'aujourd'hui tombe sur une heure murale
        -- inexistante ou ambiguë : on ne devine pas sa position.
        return query select 'unfulfillable'::text, 'cutoff_unresolvable'::text, v_s.timezone,
                            v_s.date_selection_mode, v_s.slot_selection_mode,
                            case when v_s.slot_selection_mode = 'time_within_window'
                                 then v_s.time_granularity_minutes end,
                            null::date, null::date[], null::jsonb;
        return;
      end if;
      v_cut_reached := (p_now >= v_cut_at);
    end if;
  end if;

  if public.csdj12_preparation_open(v_s, v_today) and not v_cut_reached then
    v_origin := v_today;
  else
    v_d := v_today + 1;
    while v_d <= v_last loop
      if public.csdj12_preparation_open(v_s, v_d) then
        v_origin := v_d;
        exit;
      end if;
      v_d := v_d + 1;
    end loop;
    if v_origin is null then
      return query select 'unfulfillable'::text, 'no_preparation_day_in_horizon'::text, v_s.timezone,
                          v_s.date_selection_mode, v_s.slot_selection_mode,
                          case when v_s.slot_selection_mode = 'time_within_window'
                               then v_s.time_granularity_minutes end,
                          null::date, null::date[], null::jsonb;
      return;
    end if;
  end if;

  -- ── 2. J+X, en jours calendaires depuis l'origine ─────────
  v_target := v_origin + v_s.min_lead_days;
  if v_target > v_last then
    return query select 'unfulfillable'::text, 'horizon_exhausted'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  -- ── 3. instant minimal (repris de CSDJ-V1-OFFER-START-INSTANT-01) ──
  v_floor := public.checkout_wall_time_instant(v_target, '00:00'::time, v_s.timezone);
  v_min_instant := greatest(
    p_now + pg_catalog.make_interval(mins => v_s.lead_time_minutes),
    coalesce(v_floor, p_now + pg_catalog.make_interval(mins => v_s.lead_time_minutes)));

  v_d := v_target;
  while v_d <= v_last loop
    if not exists (
      select 1 from (
        select x.weekday from public.restaurant_fulfillment_schedule_slot x
        where v_uses_slots and x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
          and x.rule_key = v_rule_key
        union all
        select w.weekday from public.restaurant_fulfillment_schedule_window w
        where not v_uses_slots and w.restaurant_id = p_restaurant_id and w.mode_code = p_mode_code
          and w.rule_key = v_rule_key
      ) o where o.weekday = pg_catalog.date_part('dow', v_d)::smallint
    ) then
      v_d := v_d + 1;
      continue;
    end if;

    if public.csdj12_availability_closed(v_s, v_d) then
      v_saw_closure := true;
      v_d := v_d + 1;
      continue;
    end if;

    v_saw_open := true;
    v_day := public.checkout_schedule_day_offers_v12(v_s, v_d, v_min_instant);
    if pg_catalog.jsonb_array_length(v_day) = 0 then
      v_d := v_d + 1;
      continue;
    end if;

    -- ── 4. capacité : filtrage, jamais de compte exposé ──────
    if p_apply_capacity and v_s.capacity_enabled then
      if v_uses_slots then
        v_kept := '[]'::jsonb;
        for v_el in select * from pg_catalog.jsonb_array_elements(v_day) loop
          if public.fulfillment_capacity_used(
               p_restaurant_id, p_mode_code, v_rule_key, v_d, v_el->>'slot_key')
             < v_s.capacity_max_orders then
            v_kept := v_kept || pg_catalog.jsonb_build_array(v_el);
          end if;
        end loop;
        v_day := v_kept;
      elsif public.fulfillment_capacity_used(p_restaurant_id, p_mode_code, v_rule_key, v_d, '')
            >= v_s.capacity_max_orders then
        v_day := '[]'::jsonb;
      end if;
      if pg_catalog.jsonb_array_length(v_day) = 0 then
        v_saw_full := true;
        v_d := v_d + 1;
        continue;
      end if;
    end if;

    v_dates := v_dates || v_d;
    v_offers := v_offers || pg_catalog.jsonb_build_object(v_d::text, v_day);

    -- derived_earliest : le client ne voit que la première date. En mode
    -- interne (p_apply_capacity = false, réservé à reserve_...), on garde
    -- TOUTES les dates éligibles : la réservation doit pouvoir juger si
    -- une date antérieure plus tôt avait encore de la place.
    if v_s.date_selection_mode = 'derived_earliest' and p_apply_capacity then
      exit;
    end if;
    v_d := v_d + 1;
  end loop;

  if pg_catalog.cardinality(v_dates) = 0 then
    return query select 'unfulfillable'::text,
                        case when v_saw_full then 'capacity_exhausted'
                             when v_saw_open then 'no_offer_in_horizon'
                             when v_saw_closure then 'all_dates_closed'
                             else 'horizon_exhausted' end::text,
                        v_s.timezone, v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  return query select 'dates_available'::text, null::text, v_s.timezone,
                      v_s.date_selection_mode, v_s.slot_selection_mode,
                      case when v_s.slot_selection_mode = 'time_within_window'
                           then v_s.time_granularity_minutes end,
                      v_dates[1], v_dates, v_offers;
end
$csdj12_resolve$;

-- ── RÉPARTITEUR : même nom, même signature, mêmes colonnes ─────────
alter function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)
  rename to resolve_fulfillment_schedule_v1;

create function public.resolve_fulfillment_schedule(
  p_restaurant_id uuid,
  p_mode_code text,
  p_fulfillment_rule_id uuid default null,
  p_now timestamptz default pg_catalog.now()
)
returns table (
  status                   text,
  unfulfillable_reason     text,
  schedule_timezone        text,
  date_selection_mode      text,
  slot_selection_mode      text,
  time_granularity_minutes smallint,
  first_eligible_date      date,
  eligible_dates           date[],
  offers                   jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_dispatch$
declare
  v_method text;
begin
  select s.schedule_method_version into v_method
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code
    and s.rule_key = coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_method = 'v1.2' then
    return query select * from public.resolve_fulfillment_schedule_v12(
      p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now, true);
  else
    -- absence, désactivation et méthode v1 : comportement CSDJ-1 inchangé.
    return query select * from public.resolve_fulfillment_schedule_v1(
      p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now);
  end if;
end
$csdj12_dispatch$;

-- ============================================================
-- §F  RÉSERVATION DE CAPACITÉ — SEULE AUTORITÉ TRANSACTIONNELLE
--
-- À appeler DANS la transaction de create_order, APRÈS l'insertion de la
-- commande (la ligne de réservation référence la commande). Une unité
-- par commande. Verrou consultatif par seau (restaurant, mode, règle,
-- date, créneau) : deux sessions visant la dernière place se
-- sérialisent, la seconde recalcule après la première.
--
-- Rend (result, reason) :
--   ('not_required', null)     planification absente/désactivée/v1, ou
--                              capacité désactivée : rien n'est réservé ;
--   ('reserved', null)         une unité consommée ;
--   ('unavailable', <motif>)   schedule_not_fulfillable | date_not_offered
--                              | slot_not_offered | capacity_full.
-- Lève une exception (donc annule create_order) sur erreur d'usage :
-- commande inconnue/étrangère/inactive, double réservation, isolation
-- autre que READ COMMITTED.
-- ============================================================
create function public.reserve_fulfillment_capacity(
  p_order_id uuid,
  p_restaurant_id uuid,
  p_mode_code text,
  p_fulfillment_rule_id uuid,
  p_fulfillment_date date,
  p_slot_key text default null,
  p_now timestamptz default pg_catalog.now()
)
returns table (result text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $csdj12_reserve$
declare
  v_o        record;
  v_s        public.restaurant_fulfillment_schedule;
  v_rule_key uuid := coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_slot     text := coalesce(p_slot_key, '');
  v_r        record;
  v_day      jsonb;
  v_used     integer;
  v_e        date;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'CSDJ12_ISOLATION_REQUIRED: la réservation exige READ COMMITTED (le verrou de seau repose sur un instantané frais).'
      using errcode = '25000';
  end if;
  if p_order_id is null or p_restaurant_id is null or p_mode_code is null or p_fulfillment_date is null then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: commande, établissement, mode et date requis.' using errcode = '22023';
  end if;
  if v_slot <> '' and (pg_catalog.length(v_slot) > 40 or v_slot !~ '^[a-z0-9_-]+$') then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: slot_key invalide.' using errcode = '22023';
  end if;
  if v_rule_key = '00000000-0000-0000-0000-000000000000'::uuid and p_fulfillment_rule_id is not null then
    raise exception 'CSDJ12_RESERVED_RULE_ID: le zéro UUID est une sentinelle interne.' using errcode = '22023';
  end if;

  select o.restaurant_id, o.status, o.payment_status into v_o
  from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'CSDJ12_ORDER_NOT_FOUND: commande introuvable.' using errcode = '22023';
  end if;
  -- Tenant : la commande doit appartenir à CET établissement.
  if v_o.restaurant_id is distinct from p_restaurant_id then
    raise exception 'CSDJ12_FOREIGN_ORDER: commande d''un autre établissement.' using errcode = '42501';
  end if;
  if not public.fulfillment_capacity_is_holding(v_o.status, v_o.payment_status) then
    raise exception 'CSDJ12_ORDER_NOT_ACTIVE: une commande refusée/annulée ne peut pas réserver de capacité.' using errcode = '55000';
  end if;

  select * into v_s
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code and s.rule_key = v_rule_key;

  if not found or v_s.enabled is not true
     or v_s.schedule_method_version <> 'v1.2' or v_s.capacity_enabled is not true then
    return query select 'not_required'::text, null::text;
    return;
  end if;

  if exists (select 1 from public.order_fulfillment_capacity_reservation r where r.order_id = p_order_id) then
    raise exception 'CSDJ12_ALREADY_RESERVED: cette commande a déjà consommé une unité.' using errcode = '23505';
  end if;

  -- Verrou de seau. Tenu jusqu'à la fin de la transaction appelante.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_restaurant_id::text || '|' || p_mode_code || '|' || v_rule_key::text || '|'
      || p_fulfillment_date::text || '|' || v_slot, 1204));

  -- Revalidation côté serveur, SANS le filtre de capacité (le décompte
  -- autoritaire est refait ci-dessous, sous verrou).
  select * into v_r
  from public.resolve_fulfillment_schedule_v12(
         p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now, false);
  if v_r.status is distinct from 'dates_available' then
    return query select 'unavailable'::text, 'schedule_not_fulfillable'::text;
    return;
  end if;
  v_day := v_r.offers -> p_fulfillment_date::text;
  if v_day is null then
    return query select 'unavailable'::text, 'date_not_offered'::text;
    return;
  end if;
  if v_s.slot_selection_mode = 'fixed_slots' then
    if v_slot = '' or not exists (
         select 1 from pg_catalog.jsonb_array_elements(v_day) e where e->>'slot_key' = v_slot) then
      return query select 'unavailable'::text, 'slot_not_offered'::text;
      return;
    end if;
  elsif v_slot <> '' then
    return query select 'unavailable'::text, 'slot_not_offered'::text;
    return;
  end if;

  v_used := public.fulfillment_capacity_used(p_restaurant_id, p_mode_code, v_rule_key, p_fulfillment_date, v_slot);
  if v_used >= v_s.capacity_max_orders then
    return query select 'unavailable'::text, 'capacity_full'::text;
    return;
  end if;

  -- derived_earliest : la date est choisie PAR LE SERVEUR (la première
  -- qui a encore de la place). Une date plus tardive n'est valide que si
  -- toutes les dates éligibles antérieures sont pleines ; sinon le client
  -- tient une date que le serveur ne lui aurait pas donnée. (La
  -- contrainte rfs_policy_coherent de CSDJ-1 interdit derived_earliest
  -- avec des créneaux : le compte est donc toujours au niveau de la date.)
  if v_s.date_selection_mode = 'derived_earliest' then
    for v_e in select e::date from unnest(v_r.eligible_dates) e where e < p_fulfillment_date order by e loop
      if public.fulfillment_capacity_used(
           p_restaurant_id, p_mode_code, v_rule_key, v_e, '') < v_s.capacity_max_orders then
        return query select 'unavailable'::text, 'date_not_offered'::text;
        return;
      end if;
    end loop;
  end if;

  insert into public.order_fulfillment_capacity_reservation
    (order_id, restaurant_id, mode_code, rule_key, fulfillment_date, slot_key)
  values (p_order_id, p_restaurant_id, p_mode_code, v_rule_key, p_fulfillment_date, v_slot);

  return query select 'reserved'::text, null::text;
end
$csdj12_reserve$;

-- Libération EXPLICITE (primitif de la décision « échec de paiement »).
-- Supprime la ligne de réservation d'UNE commande ; idempotente ; sans
-- verrou de seau (rendre une place ne peut pas surréserver : au pire une
-- réservation concurrente voit « plein » un instant de trop, et refuse).
-- Rend true si une unité a été rendue. Interne : aucun rôle applicatif.
create function public.release_fulfillment_capacity(p_order_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $csdj12_release$
declare
  v_n integer;
begin
  if p_order_id is null then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: commande requise.' using errcode = '22023';
  end if;
  delete from public.order_fulfillment_capacity_reservation r where r.order_id = p_order_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$csdj12_release$;

-- ============================================================
-- §G  ÉCRITURE ET LECTURE MARCHANDES v1.2
-- ============================================================
create function public.mutate_merchant_fulfillment_schedule_v12(
  p_restaurant_id uuid,
  p_action text,
  p_payload jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $csdj12_mutate$
declare
  v_mode      text;
  v_rule      uuid;
  v_rule_key  uuid;
  v_tz        text;
  v_date_mode text;
  v_slot_mode text;
  v_cal       uuid;
  v_prep_h    text;
  v_avail_h   text;
  v_cap_on    boolean;
  v_cap_max   integer;
  v_item      jsonb;
  v_method    text;
begin
  if auth.uid() is null then
    raise exception 'CSDJ12_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.has_role_in(p_restaurant_id, array['owner','manager']) then
    raise exception 'CSDJ12_FORBIDDEN: rôle owner ou manager requis.' using errcode = '42501';
  end if;
  if p_action is null or p_action <> all(array['save_schedule_v12','replace_prep_days','replace_prep_closures']) then
    raise exception 'CSDJ12_UNKNOWN_ACTION: action inconnue.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'CSDJ12_INVALID_PAYLOAD: objet JSON attendu.' using errcode = '22023';
  end if;

  -- MÊME verrou par tenant que mutate_merchant_fulfillment_schedule :
  -- les éditions v1 et v1.2 d'un établissement se sérialisent ensemble.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1104));

  v_mode := p_payload->>'modeCode';
  if v_mode is null or not exists (select 1 from public.sale_mode_catalog c where c.code = v_mode) then
    raise exception 'CSDJ12_UNKNOWN_MODE: mode de vente hors catalogue.' using errcode = '22023';
  end if;

  if p_payload ? 'fulfillmentRuleId' and p_payload->>'fulfillmentRuleId' is not null then
    v_rule := (p_payload->>'fulfillmentRuleId')::uuid;
    if v_rule = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception 'CSDJ12_RESERVED_RULE_ID: le zéro UUID est réservé comme sentinelle interne.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.restaurant_sale_mode_fulfillments f
      where f.id = v_rule and f.restaurant_id = p_restaurant_id and f.mode_code = v_mode
    ) then
      raise exception 'CSDJ12_FOREIGN_RULE: règle de livraison inconnue pour cet établissement et ce mode.' using errcode = '42501';
    end if;
  end if;
  v_rule_key := coalesce(v_rule, '00000000-0000-0000-0000-000000000000'::uuid);

  if p_action = 'save_schedule_v12' then
    v_tz := p_payload->>'timezone';
    if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
      raise exception 'CSDJ12_INVALID_TIMEZONE: fuseau IANA inconnu du serveur.' using errcode = '22023';
    end if;
    v_date_mode := coalesce(p_payload->>'dateSelectionMode', 'informational_only');
    v_slot_mode := coalesce(p_payload->>'slotSelectionMode', 'none');
    if v_date_mode <> all(public.checkout_date_selection_modes())
       or v_slot_mode <> all(public.checkout_slot_selection_modes()) then
      raise exception 'CSDJ12_INVALID_POLICY: politique hors catalogue.' using errcode = '22023';
    end if;
    if nullif(p_payload->>'cutoffTime','') is not null then
      if (p_payload->>'cutoffTime')::time
           is distinct from pg_catalog.date_trunc('minute', (p_payload->>'cutoffTime')::time) then
        raise exception 'CSDJ12_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).' using errcode = '22023';
      end if;
    end if;

    -- v1.2 n'a plus de décalage d'heure limite : une valeur non nulle est
    -- REFUSÉE (jamais ignorée en silence).
    if nullif(p_payload->>'cutoffOffsetDays','') is not null
       and (p_payload->>'cutoffOffsetDays')::smallint <> 0 then
      raise exception 'CSDJ12_CUTOFF_OFFSET_REMOVED: cutoffOffsetDays n''existe pas en v1.2 (l''origine se déplace sur le prochain jour de préparation).' using errcode = '22023';
    end if;

    v_cal := nullif(p_payload->>'holidayCalendarId','')::uuid;
    if v_cal is not null and not exists (select 1 from public.public_holiday_calendar c where c.id = v_cal) then
      raise exception 'CSDJ12_UNKNOWN_CALENDAR: calendrier férié inconnu.' using errcode = '22023';
    end if;
    v_prep_h  := coalesce(p_payload->>'preparationOnHolidays', 'open');
    v_avail_h := coalesce(p_payload->>'availabilityOnHolidays', 'open');
    if v_prep_h not in ('open','closed') or v_avail_h not in ('open','closed') then
      raise exception 'CSDJ12_INVALID_HOLIDAY_POLICY: « open » ou « closed » attendu.' using errcode = '22023';
    end if;
    if v_cal is null and (v_prep_h = 'closed' or v_avail_h = 'closed') then
      raise exception 'CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR: une politique « closed » exige un calendrier férié.' using errcode = '22023';
    end if;

    v_cap_on := coalesce((p_payload->>'capacityEnabled')::boolean, false);
    v_cap_max := nullif(p_payload->>'capacityMaxOrders','')::integer;
    if v_cap_on and (v_cap_max is null or v_cap_max < 1) then
      raise exception 'CSDJ12_INVALID_CAPACITY: capacité activée => maximum strictement positif requis.' using errcode = '22023';
    end if;
    if v_cap_on and v_date_mode = 'informational_only' then
      raise exception 'CSDJ12_CAPACITY_NEEDS_DATE: la capacité exige une politique de date choisie ou dérivée.' using errcode = '22023';
    end if;

    insert into public.restaurant_fulfillment_schedule as t (
      restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
      date_selection_mode, slot_selection_mode, time_granularity_minutes,
      lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days,
      booking_horizon_days, schedule_method_version,
      holiday_calendar_id, preparation_on_holidays, availability_on_holidays,
      capacity_enabled, capacity_max_orders)
    values (
      p_restaurant_id, v_mode, v_rule, v_tz,
      coalesce((p_payload->>'enabled')::boolean, false),
      v_date_mode, v_slot_mode,
      nullif(p_payload->>'timeGranularityMinutes','')::smallint,
      coalesce(nullif(p_payload->>'leadTimeMinutes','')::integer, 0),
      coalesce(nullif(p_payload->>'minLeadDays','')::smallint, 0::smallint),
      nullif(p_payload->>'cutoffTime','')::time,
      0,
      coalesce(nullif(p_payload->>'bookingHorizonDays','')::smallint, 14::smallint),
      'v1.2',
      v_cal, v_prep_h, v_avail_h, v_cap_on, case when v_cap_on then v_cap_max else v_cap_max end)
    on conflict (restaurant_id, mode_code, rule_key) do update set
      timezone = excluded.timezone,
      enabled = excluded.enabled,
      date_selection_mode = excluded.date_selection_mode,
      slot_selection_mode = excluded.slot_selection_mode,
      time_granularity_minutes = excluded.time_granularity_minutes,
      lead_time_minutes = excluded.lead_time_minutes,
      min_lead_days = excluded.min_lead_days,
      cutoff_time = excluded.cutoff_time,
      cutoff_offset_days = 0,
      booking_horizon_days = excluded.booking_horizon_days,
      schedule_method_version = 'v1.2',
      holiday_calendar_id = excluded.holiday_calendar_id,
      preparation_on_holidays = excluded.preparation_on_holidays,
      availability_on_holidays = excluded.availability_on_holidays,
      capacity_enabled = excluded.capacity_enabled,
      capacity_max_orders = excluded.capacity_max_orders,
      updated_at = pg_catalog.now();
    return;
  end if;

  -- Actions sur les calendriers de préparation : la planification doit
  -- exister ET être de méthode v1.2.
  select s.schedule_method_version into v_method
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = v_mode and s.rule_key = v_rule_key;
  if v_method is null then
    raise exception 'CSDJ12_NO_SCHEDULE: enregistrez d''abord la planification (save_schedule_v12).' using errcode = '22023';
  end if;
  if v_method <> 'v1.2' then
    raise exception 'CSDJ12_NOT_V12: la planification n''est pas de méthode v1.2.' using errcode = '22023';
  end if;

  if p_action = 'replace_prep_days' then
    if pg_catalog.jsonb_typeof(p_payload->'weekdays') is distinct from 'array' then
      raise exception 'CSDJ12_INVALID_PAYLOAD: weekdays (tableau) attendu.' using errcode = '22023';
    end if;
    delete from public.restaurant_fulfillment_prep_day d
    where d.restaurant_id = p_restaurant_id and d.mode_code = v_mode and d.rule_key = v_rule_key;
    for v_item in select * from pg_catalog.jsonb_array_elements(p_payload->'weekdays') loop
      if pg_catalog.jsonb_typeof(v_item) <> 'number' or (v_item #>> '{}') !~ '^[0-6]$' then
        raise exception 'CSDJ12_INVALID_WEEKDAY: 0 (dimanche) à 6 (samedi).' using errcode = '22023';
      end if;
      insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday)
      values (p_restaurant_id, v_mode, v_rule_key, (v_item #>> '{}')::smallint)
      on conflict do nothing;
    end loop;
    return;
  end if;

  -- replace_prep_closures
  if pg_catalog.jsonb_typeof(p_payload->'closures') is distinct from 'array' then
    raise exception 'CSDJ12_INVALID_PAYLOAD: closures (tableau) attendu.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_payload->'closures') > 731 then
    raise exception 'CSDJ12_TOO_MANY_CLOSURES: 731 fermetures au plus.' using errcode = '22023';
  end if;
  delete from public.restaurant_fulfillment_prep_closure c
  where c.restaurant_id = p_restaurant_id and c.mode_code = v_mode and c.rule_key = v_rule_key;
  for v_item in select * from pg_catalog.jsonb_array_elements(p_payload->'closures') loop
    insert into public.restaurant_fulfillment_prep_closure (restaurant_id, mode_code, rule_key, closed_on, label)
    values (p_restaurant_id, v_mode, v_rule_key, (v_item->>'closedOn')::date, nullif(v_item->>'label',''))
    on conflict do nothing;
  end loop;
end
$csdj12_mutate$;

create function public.get_merchant_fulfillment_schedules_v12(p_restaurant_id uuid)
returns table (
  mode_code                 text,
  fulfillment_rule_id       uuid,
  schedule_method_version   text,
  holiday_calendar_id       uuid,
  preparation_on_holidays   text,
  availability_on_holidays  text,
  capacity_enabled          boolean,
  capacity_max_orders       integer,
  preparation_weekdays      jsonb,
  preparation_closures      jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_read$
begin
  if auth.uid() is null then
    raise exception 'CSDJ12_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception 'CSDJ12_FORBIDDEN: accès refusé à cet établissement.' using errcode = '42501';
  end if;
  return query
  select s.mode_code, s.fulfillment_rule_id, s.schedule_method_version,
         s.holiday_calendar_id, s.preparation_on_holidays, s.availability_on_holidays,
         s.capacity_enabled, s.capacity_max_orders,
         coalesce((select pg_catalog.jsonb_agg(d.weekday order by d.weekday)
                   from public.restaurant_fulfillment_prep_day d
                   where d.restaurant_id = s.restaurant_id and d.mode_code = s.mode_code
                     and d.rule_key = s.rule_key), '[]'::jsonb),
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                           'closedOn', c.closed_on, 'label', c.label) order by c.closed_on)
                   from public.restaurant_fulfillment_prep_closure c
                   where c.restaurant_id = s.restaurant_id and c.mode_code = s.mode_code
                     and c.rule_key = s.rule_key), '[]'::jsonb)
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id
  order by s.mode_code, s.rule_key;
end
$csdj12_read$;

-- ------------------------------------------------------------
-- ACL des fonctions : tout est fermé, puis les deux seules ouvertures
-- (RPC marchandes, rôle authenticated ; contrôle d'accès DANS le corps).
-- ------------------------------------------------------------
revoke all on function public.checkout_unfulfillable_reasons_v12() from public, anon, authenticated, service_role;
revoke all on function public.fulfillment_capacity_is_holding(text,text) from public, anon, authenticated, service_role;
revoke all on function public.fulfillment_capacity_used(uuid,text,uuid,date,text) from public, anon, authenticated, service_role;
revoke all on function public.csdj12_preparation_open(public.restaurant_fulfillment_schedule,date) from public, anon, authenticated, service_role;
revoke all on function public.csdj12_availability_closed(public.restaurant_fulfillment_schedule,date) from public, anon, authenticated, service_role;
revoke all on function public.checkout_schedule_day_offers_v12(public.restaurant_fulfillment_schedule,date,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.resolve_fulfillment_schedule_v12(uuid,text,uuid,timestamp with time zone,boolean) from public, anon, authenticated, service_role;
revoke all on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.release_fulfillment_capacity(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb) from public, anon;
revoke all on function public.get_merchant_fulfillment_schedules_v12(uuid) from public, anon;
grant execute on function public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb) to authenticated;
grant execute on function public.get_merchant_fulfillment_schedules_v12(uuid) to authenticated;

comment on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone) is
  'CSDJ v1.2 — RÉPARTITEUR. Méthode v1.2 -> resolve_fulfillment_schedule_v12 ; sinon -> resolve_fulfillment_schedule_v1 (ancien corps CSDJ-1, inchangé). Mêmes colonnes de sortie : le contrat de get_checkout_fulfillment_schedule est préservé.';
comment on function public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,timestamp with time zone) is
  'CSDJ v1.2 — SEULE autorité transactionnelle de réservation de capacité. Une commande = une unité. À appeler dans la transaction de create_order après l''insertion de la commande. Verrou consultatif par seau, revalidation serveur, aucun compte exposé.';

-- ============================================================
-- §H  POST-VOL — DANS LA TRANSACTION
-- ============================================================
do $csdj12_postflight$
declare
  v_item text;
  v_bad  text;
begin
  -- Objets présents
  foreach v_item in array array[
    'public.restaurant_fulfillment_prep_day','public.restaurant_fulfillment_prep_closure',
    'public.public_holiday_calendar','public.public_holiday_calendar_day',
    'public.order_fulfillment_capacity_reservation'
  ] loop
    if pg_catalog.to_regclass(v_item) is null then
      raise exception 'SCANYM_POSTFLIGHT: table % absente.', v_item;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_item)) then
      raise exception 'SCANYM_POSTFLIGHT: RLS non activée sur %.', v_item;
    end if;
    -- Aucun droit d'ÉCRITURE pour aucun rôle applicatif, et aucun droit
    -- du tout pour anon.
    if exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role_name)
               where pg_catalog.has_table_privilege(r.role_name, v_item, 'INSERT')
                  or pg_catalog.has_table_privilege(r.role_name, v_item, 'UPDATE')
                  or pg_catalog.has_table_privilege(r.role_name, v_item, 'DELETE')
                  or pg_catalog.has_table_privilege(r.role_name, v_item, 'TRUNCATE')) then
      raise exception 'SCANYM_POSTFLIGHT: droit d''écriture applicatif sur %.', v_item;
    end if;
    if pg_catalog.has_table_privilege('anon', v_item, 'SELECT') then
      raise exception 'SCANYM_POSTFLIGHT: anon peut lire %.', v_item;
    end if;
  end loop;
  if pg_catalog.has_table_privilege('authenticated', 'public.order_fulfillment_capacity_reservation', 'SELECT') then
    raise exception 'SCANYM_POSTFLIGHT: la table de réservation ne doit être lisible par aucun rôle applicatif.';
  end if;

  -- Fonctions internes : AUCUN accès applicatif, y compris PUBLIC.
  for v_bad in
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('checkout_unfulfillable_reasons_v12','fulfillment_capacity_is_holding',
                        'fulfillment_capacity_used','csdj12_preparation_open','csdj12_availability_closed',
                        'checkout_schedule_day_offers_v12','resolve_fulfillment_schedule_v12',
                        'resolve_fulfillment_schedule','resolve_fulfillment_schedule_v1',
                        'reserve_fulfillment_capacity','release_fulfillment_capacity')
      and (p.proacl is null
           or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
           or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
  loop
    raise exception 'SCANYM_POSTFLIGHT: la fonction interne % est exécutable par un rôle applicatif.', v_bad;
  end loop;

  -- RPC marchandes : authenticated oui, anon non.
  foreach v_item in array array[
    'public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)',
    'public.get_merchant_fulfillment_schedules_v12(uuid)'
  ] loop
    if not pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(v_item), 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(v_item), 'EXECUTE') then
      raise exception 'SCANYM_POSTFLIGHT: ACL inattendue sur %.', v_item;
    end if;
  end loop;

  -- La lecture publique CSDJ-1 est intacte : signature et ACL.
  if pg_catalog.to_regprocedure('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)') is null
     or not pg_catalog.has_function_privilege('anon',
          'public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)', 'EXECUTE') then
    raise exception 'SCANYM_POSTFLIGHT: la lecture publique CSDJ-1 a été altérée.';
  end if;

  -- Le répartiteur garde les 9 colonnes de sortie de CSDJ-1.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p,
        unnest(p.proargmodes) m(mode)
      where p.oid = pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)')
        and m.mode = 't') <> 9 then
    raise exception 'SCANYM_POSTFLIGHT: le répartiteur ne rend pas 9 colonnes.';
  end if;

  -- Aucune configuration créée ni modifiée par ce fichier.
  if exists (select 1 from public.restaurant_fulfillment_schedule s
             where s.schedule_method_version <> 'v1' or s.capacity_enabled
                or s.holiday_calendar_id is not null) then
    raise exception 'SCANYM_POSTFLIGHT: une planification a été activée en v1.2 par la migration.';
  end if;
  if exists (select 1 from public.public_holiday_calendar) then
    raise exception 'SCANYM_POSTFLIGHT: un calendrier férié a été créé par la migration.';
  end if;
end
$csdj12_postflight$;

commit;
