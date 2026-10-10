-- ============================================================
-- Scanym — CHECKOUT SCHEDULING FOUNDATION v1  (CSDJ-1)
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Parent : main 412dbb53c5f180983860852b79425209c04b9c42
--          (tree b53db34c4897dff5dba150ba0bf9de1aff7ee873).
-- Rollback : DRAFT-lot-checkout-scheduling-foundation-v1-rollback.sql
--
-- Mandat : NOUGARO — CIO DESIGN DECISION / CHECKOUT SCHEDULING &
--          DELIVERY JOURNEY v1, sous-lot CSDJ-1 « SCHEDULING
--          FOUNDATION », conception approuvée avec deux ajustements
--          obligatoires (bornes de propriété Debussy, découpage en
--          trois sous-lots).
--
-- ────────────────────────────────────────────────────────────────────
-- CE QUE CE LOT AJOUTE (et rien d'autre)
--
-- A. CATALOGUES FERMÉS — quatre fonctions immuables, SEULES autorités
--    SQL des valeurs admissibles : politiques de sélection de date, de
--    sélection d'horaire, statuts rendus, motifs d'infaisabilité.
--    Miroirs exacts de lib/scheduling/schedule-model.ts, prouvés
--    caractère par caractère par tests/csdj1-sql-structural.test.ts.
--
-- B. MODÈLE DE PLANIFICATION PAR COMMERÇANT — quatre tables, portées
--    par le triplet (restaurant_id, mode_code, règle de fulfillment) :
--      - restaurant_fulfillment_schedule          : la politique
--      - restaurant_fulfillment_schedule_window   : fenêtres hebdo
--      - restaurant_fulfillment_schedule_slot     : créneaux nommés
--      - restaurant_fulfillment_schedule_closure  : fermetures
--    Fuseau IANA par portée, heure limite, délai de préparation,
--    minimum de jours, horizon de réservation, granularité.
--
-- C. CALCUL D'ÉLIGIBILITÉ SERVEUR — public.resolve_fulfillment_schedule()
--    lit l'horloge du SERVEUR et le fuseau du COMMERÇANT, et énumère
--    les dates et offres éligibles. Autorité interne, aucun GRANT.
--
-- D. LECTURE PUBLIQUE SÛRE — public.get_checkout_fulfillment_schedule()
--    accordée à anon/authenticated. Elle réutilise l'autorité de
--    tarification EXISTANTE (public.resolve_delivery_fulfillment) sans
--    la modifier, et ne laisse traverser NI provider, NI
--    fulfillment_code, NI fulfillment_rule_id, NI zone_prefixes, NI
--    config : strictement MOINS que la projection publique actuelle,
--    jamais plus.
--
--    ─ CSDJ1-V1-RESOLVER-COMMON-COLUMNS-01 ─
--    Elle ne lit de l'autorité de tarification que les colonnes
--    présentes dans TOUTES ses versions livrées : eligible, block,
--    fulfillment_rule_id, min_items, missing, customer_text,
--    pricing_mode, fixed_fee, free_threshold, delivery_fee. Les trois
--    colonnes de REMISE (discount_enabled / discount_threshold /
--    discount_percentage) n'existent que dans la variante du lot
--    DELIVERY PRICING v2-B5, qui est encore un DRAFT non appliqué :
--    les lire ici créerait une dépendance dure de CSDJ-1 envers un lot
--    qui n'est pas en Production, et l'application de CSDJ-1 échouerait
--    sur l'état réel. L'affichage de la remise appartient de toute
--    façon à CSDJ-2, qui lit la projection publique des règles de
--    livraison -- déjà porteuse de la remise -- exactement comme la
--    vitrine le fait aujourd'hui.
--
-- E. ÉCRITURE MARCHANDE PAR RPC — public.mutate_merchant_fulfillment_schedule()
--    et public.get_merchant_fulfillment_schedules(), accordées à
--    authenticated seul, réservées aux rôles owner/manager pour
--    l'écriture, sous verrou consultatif par tenant.
--
-- ────────────────────────────────────────────────────────────────────
-- CE QUE CE LOT NE FAIT PAS
--
--   - il ne touche à AUCUNE fonction préexistante. `create_order`,
--     `resolve_delivery_fulfillment`, `get_restaurant_public_delivery_fulfillments`
--     et les RPC MCC sont lues, jamais redéfinies. La revalidation
--     serveur dans `create_order` et l'instantané de commande sont le
--     périmètre de CSDJ-3, pas celui-ci ;
--   - il ne modifie AUCUNE sémantique de tarification : les frais, le
--     seuil de gratuité et la remise restent calculés par
--     `resolve_delivery_fulfillment` et recopiés tels quels ;
--   - il n'ajoute AUCUN emplacement de texte configurable, et en
--     particulier pas `how_to_order_button` / `how_to_order_title` /
--     `how_to_order_body` : cette surface éditoriale et visuelle
--     appartient au lot THEME & CONTENT SETTINGS v1 (Debussy) ;
--   - il n'appelle aucun transporteur, n'invente aucun calendrier de
--     jours fériés, aucun délai par défaut, aucun « J+2 » ;
--   - il n'écrit aucune donnée métier : les quatre tables NAISSENT
--     VIDES, sans aucun backfill, et le post-vol l'exige.
--
-- ────────────────────────────────────────────────────────────────────
-- INVARIANTS NOMMÉS
--
-- CSDJ-V1-SCHEDULE-ABSENT-01
--   Aucune ligne de planification pour une portée, ou une ligne
--   `enabled = false` : le statut rendu est `absent`, et le parcours de
--   commande est EXACTEMENT celui d'avant ce lot. L'absence de
--   configuration ne vaut jamais permission, et ne vaut jamais non plus
--   erreur. C'est l'état de 100 % des commerçants au moment de ce lot.
--
-- CSDJ-V1-UNFULFILLABLE-EXPLICIT-01
--   Une planification activée dont la politique EXIGE une date, et pour
--   laquelle aucune date n'est éligible, rend `unfulfillable` AVEC son
--   motif. Jamais une date de repli, jamais la date du jour, jamais
--   « dès que possible ». Décision du CIO, littérale : « A schedule
--   configured but impossible to fulfill must fail clearly. It must
--   NEVER silently fall back to an invented date. »
--
-- CSDJ-V1-SINGLE-OFFER-AUTHORITY-01
--   Une seule table d'offres fait foi à la fois, désignée par
--   `slot_selection_mode` : `time_within_window` lit les FENÊTRES et
--   ignore les créneaux, `fixed_slots` lit les CRÉNEAUX et ignore les
--   fenêtres. Deux autorités simultanées pourraient se contredire sur
--   le même jour.
--
-- CSDJ-V1-DAY-WITHOUT-OFFER-01
--   Un jour de semaine sans offre est un jour FERMÉ. Il n'existe
--   volontairement aucune table « jours fermés » : elle ferait une
--   seconde autorité capable de contredire la première.
--
-- CSDJ-V1-SCOPE-EXACT-01
--   La portée d'une planification est le triplet exact
--   (restaurant_id, mode_code, règle de fulfillment). Il n'y a AUCUN
--   héritage d'une portée vers une autre : une livraison routée vers
--   une règle sans planification est `absent`, elle n'emprunte pas la
--   planification d'une autre règle ni un défaut de mode. Un héritage
--   silencieux appliquerait au client les créneaux d'une zone qu'il
--   n'habite pas.
--
-- CSDJ-V1-SERVER-CLOCK-01
--   Toute éligibilité est calculée depuis `pg_catalog.now()` et le
--   fuseau IANA de la portée. Aucune heure fournie par un appelant
--   n'entre dans la décision : le paramètre `p_now` de la fonction
--   interne existe pour la FIXTURE DE PREUVE et n'est accessible à
--   aucun rôle applicatif, la RPC publique n'en expose pas d'équivalent.
--
-- ────────────────────────────────────────────────────────────────────
-- GARANTIES STRUCTURELLES MULTI-TENANT
--
--   1. chaque table porte `restaurant_id` en tête de clé primaire, et
--      une clé étrangère composite vers la ligne de planification
--      parente -- une fenêtre ne peut donc pas appartenir à un tenant
--      et sa planification à un autre ;
--   2. RLS activée sur les quatre tables, une policy SELECT par
--      appartenance réelle (`restaurant_users`), AUCUNE policy
--      d'écriture : l'écriture directe est structurellement impossible,
--      pas seulement interdite par convention ;
--   3. `revoke all` AVANT tout `grant`, jamais l'inverse (leçon
--      SEC-2A3-01) ;
--   4. toute RPC est `security definer set search_path = ''`, avec
--      double garde en tête : session authentifiée, puis appartenance
--      au tenant ; l'écriture exige en outre owner/manager ;
--   5. la recherche d'un créneau est jointe sur `restaurant_id` dans la
--      MÊME requête : une clé de créneau d'un autre établissement ne
--      peut pas correspondre, ce n'est pas une vérification ajoutée
--      mais une impossibilité ;
--   6. verrou consultatif par tenant avant toute mutation.
--
-- ────────────────────────────────────────────────────────────────────
-- ATOMICITÉ — CSDJ1-V1-SQL-ATOMICITY-01
--
-- Ce fichier est UNE SEULE transaction : un `begin;` explicite, le
-- pré-vol anti-dérive DEDANS, tout le DDL, le post-vol DEDANS, et
-- `commit;` comme DERNIÈRE instruction exécutable. La garantie ne
-- dépend donc pas de `-v ON_ERROR_STOP=1` : si quoi que ce soit échoue,
-- rien n'est appliqué.
-- ============================================================

begin;

-- ============================================================
-- §0  PRÉ-VOL ANTI-DÉRIVE — FAIL-CLOSED, DANS LA TRANSACTION
-- ============================================================
do $csdj1_preflight$
declare
  v_missing text;
begin
  -- P-1. Tables prérequises. Ce lot se greffe sur le modèle de modes de
  --      vente et sur le moteur de routage/tarification : s'ils ne sont
  --      pas là, le reste n'a pas de sens.
  foreach v_missing in array array[
    'public.restaurants',
    'public.restaurant_users',
    'public.sale_mode_catalog',
    'public.restaurant_sale_modes',
    'public.restaurant_sale_mode_fulfillments'
  ] loop
    if pg_catalog.to_regclass(v_missing) is null then
      raise exception 'SCANYM_SCHEMA_DRIFT: table prérequise % absente -- CSDJ-1 annulé.', v_missing
        using errcode = '42P01';
    end if;
  end loop;

  -- P-2. Fonctions d'appui prérequises, dont l'AUTORITÉ DE TARIFICATION
  --      que ce lot réutilise sans la modifier.
  foreach v_missing in array array[
    'public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)',
    'public.is_member_of(uuid)',
    'public.has_role_in(uuid,text[])',
    'public.is_scanym_operator()'
  ] loop
    if pg_catalog.to_regprocedure(v_missing) is null then
      raise exception 'SCANYM_SCHEMA_DRIFT: fonction prérequise % absente -- CSDJ-1 annulé.', v_missing
        using errcode = '42883';
    end if;
  end loop;

  -- P-3. Anti-double-application. Aucun objet de ce lot ne doit déjà
  --      exister : ce fichier n'est pas idempotent, et le prétendre
  --      masquerait une application partielle antérieure.
  if pg_catalog.to_regclass('public.restaurant_fulfillment_schedule') is not null
     or pg_catalog.to_regclass('public.restaurant_fulfillment_schedule_window') is not null
     or pg_catalog.to_regclass('public.restaurant_fulfillment_schedule_slot') is not null
     or pg_catalog.to_regclass('public.restaurant_fulfillment_schedule_closure') is not null
     or pg_catalog.to_regprocedure('public.checkout_date_selection_modes()') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)') is not null
     or pg_catalog.to_regprocedure('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)') is not null
  then
    raise exception 'SCANYM_ALREADY_APPLIED: un objet de CHECKOUT SCHEDULING FOUNDATION v1 existe déjà -- annulé.'
      using errcode = '42710';
  end if;

  -- ════════════════════════════════════════════════════════════════
  -- P-3bis. FORME EXACTE DE L'AUTORITÉ DE TARIFICATION
  --         CSDJ-V1-RESOLVER-EXACT-SHAPE-01 — ferme CSDJ1-AUD-05
  --
  -- CSDJ-1 ne lit que les colonnes communes à toutes les versions
  -- livrées du résolveur (CSDJ1-V1-RESOLVER-COMMON-COLUMNS-01). La
  -- version précédente le vérifiait par SOUS-CHAÎNE sur le texte de la
  -- signature, ce qui acceptait des SOSIES : une colonne renommée
  -- `not_eligible` contient « eligible », une colonne `not_block`
  -- contient « block ». Le lot s'appliquait alors, et échouait plus
  -- tard en 42703 à la première lecture -- c'est-à-dire en production,
  -- et non à l'application.
  --
  -- La vérification porte désormais sur le CATALOGUE : nom EXACT et
  -- TYPE EXACT de chaque colonne de sortie, lus dans pg_proc. Aucune
  -- heuristique textuelle.
  -- ════════════════════════════════════════════════════════════════
  foreach v_missing in array array[
    'eligible=boolean', 'block=text', 'fulfillment_rule_id=uuid',
    'min_items=integer', 'missing=integer', 'customer_text=text',
    'pricing_mode=text', 'fixed_fee=numeric', 'free_threshold=numeric',
    'delivery_fee=numeric'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p,
      -- `unnest` à PLUSIEURS tableaux est une construction du parseur
      -- (sucre pour ROWS FROM), pas une surcharge de pg_catalog : la
      -- qualifier échoue. Même famille de leçon que coalesce, extract et
      -- greatest. `pg_catalog` reste implicitement en tête du chemin de
      -- recherche, la résolution n'est donc pas détournable.
      unnest(p.proargnames, p.proargmodes, p.proallargtypes)
             as a(argname, argmode, argtype)
      where p.oid = pg_catalog.to_regprocedure(
              'public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)')
        and a.argmode = 't'
        and a.argname = pg_catalog.split_part(v_missing, '=', 1)
        and pg_catalog.format_type(a.argtype, null) = pg_catalog.split_part(v_missing, '=', 2)
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: resolve_delivery_fulfillment ne renvoie pas la colonne de sortie attendue « % » -- CSDJ-1 annulé AVANT toute création d''objet.', v_missing
        using errcode = '42804';
    end if;
  end loop;

  -- Et une seule surcharge : deux résolveurs de même nom rendraient le
  -- contrôle ci-dessus ambigu, et l'appel du lot imprévisible.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'resolve_delivery_fulfillment') <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_delivery_fulfillment possède plusieurs surcharges -- CSDJ-1 annulé.'
      using errcode = '42725';
  end if;

  -- P-4. Le type `time` et l'arithmétique de fuseau sont employés pour
  --      la PREMIÈRE fois de ce dépôt. On vérifie que le serveur porte
  --      bien une base de fuseaux utilisable, sinon tout le calcul
  --      d'éligibilité serait faux en silence.
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = 'Europe/Paris') then
    raise exception 'SCANYM_SCHEMA_DRIFT: la base de fuseaux IANA du serveur est inutilisable -- CSDJ-1 annulé.'
      using errcode = '22023';
  end if;
end
$csdj1_preflight$;

-- ============================================================
-- §A  CATALOGUES FERMÉS
--
-- Miroirs exacts de lib/scheduling/schedule-model.ts. Aucun GRANT :
-- autorités internes, appelées par les CHECK et par les RPC de ce lot.
-- ============================================================

create function public.checkout_date_selection_modes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'customer_selectable',
    'derived_earliest',
    'informational_only'
  ]::text[]
$$;

comment on function public.checkout_date_selection_modes() is
  'CHECKOUT SCHEDULING FOUNDATION v1 — catalogue FERMÉ des politiques de sélection de date. Miroir exact de CHECKOUT_DATE_SELECTION_MODES (lib/scheduling/schedule-model.ts). Aucun GRANT applicatif.';

revoke all on function public.checkout_date_selection_modes() from public, anon, authenticated, service_role;

create function public.checkout_slot_selection_modes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'none',
    'time_within_window',
    'fixed_slots'
  ]::text[]
$$;

comment on function public.checkout_slot_selection_modes() is
  'CHECKOUT SCHEDULING FOUNDATION v1 — catalogue FERMÉ des politiques de sélection d''horaire. Miroir exact de CHECKOUT_SLOT_SELECTION_MODES. CSDJ-V1-SINGLE-OFFER-AUTHORITY-01 : cette valeur DÉSIGNE laquelle des deux tables d''offres fait foi.';

revoke all on function public.checkout_slot_selection_modes() from public, anon, authenticated, service_role;

create function public.checkout_schedule_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'absent',
    'blocked_upstream',
    'informational_only',
    'dates_available',
    'unfulfillable'
  ]::text[]
$$;

comment on function public.checkout_schedule_statuses() is
  'CHECKOUT SCHEDULING FOUNDATION v1 — catalogue FERMÉ des statuts rendus par l''autorité serveur. Miroir exact de CHECKOUT_SCHEDULE_STATUSES. `absent` couvre l''absence de ligne ET la désactivation, et n''est PAS une erreur (CSDJ-V1-SCHEDULE-ABSENT-01).';

revoke all on function public.checkout_schedule_statuses() from public, anon, authenticated, service_role;

create function public.checkout_unfulfillable_reasons()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'no_offer_configured',
    'granularity_missing',
    'all_dates_closed',
    'horizon_exhausted',
    'no_offer_in_horizon'
  ]::text[]
$$;

comment on function public.checkout_unfulfillable_reasons() is
  'CHECKOUT SCHEDULING FOUNDATION v1 — catalogue FERMÉ des motifs d''infaisabilité. Un statut `unfulfillable` porte TOUJOURS exactement un de ces motifs : un refus dont on ne sait pas dire la cause est un refus qu''on ne saura pas corriger.';

revoke all on function public.checkout_unfulfillable_reasons() from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- §A.2  POLITIQUE D'HEURE MURALE — CSDJ-V1-WALL-TIME-FAIL-CLOSED-01
--
-- Ferme CSDJ1-AUD-02. Deux heures murales locales ne désignent pas un
-- instant unique :
--   - l'heure INEXISTANTE du saut de printemps (à Paris, le 29 mars 2026
--     entre 02:00 et 03:00 : ces minutes n'ont jamais eu lieu) ;
--   - l'heure AMBIGUË du recul d'automne (le 25 octobre 2026 entre 02:00
--     et 03:00 : ces minutes ont eu lieu DEUX fois).
--
-- La politique de la v1 est le REFUS FERMÉ des deux cas. La
-- normalisation de PostgreSQL est un comportement de MOTEUR, pas une
-- décision commerciale : elle déplacerait l'heure inexistante après le
-- saut et choisirait l'une des deux occurrences ambiguës sans que ni le
-- commerçant ni le client ne le sachent. Pour une heure ambiguë, la
-- promesse « nous vous livrons à 02:30 » désignerait deux instants
-- distants d'une heure, et aucun des deux n'aurait été choisi par
-- quiconque.
--
-- Le refus porte sur l'OCCURRENCE d'une date, pas sur la configuration :
-- une fenêtre 02:00-03:00 reste valide les 364 autres jours de l'année,
-- et c'est pourquoi ce refus ne peut pas être prononcé à l'écriture.
-- ------------------------------------------------------------

create function public.checkout_wall_time_status(
  p_date date, p_time time, p_timezone text
)
returns text
language sql
stable
set search_path = ''
as $$
  with naive as (select (p_date + p_time) as ts),
  mapped as (select n.ts, (n.ts at time zone p_timezone) as inst from naive n)
  select case
    -- ALLER-RETOUR : si l'instant obtenu, relu dans le fuseau, ne rend
    -- pas l'heure murale demandée, c'est que cette heure n'existe pas.
    when ((m.inst at time zone p_timezone) is distinct from m.ts) then 'nonexistent'
    -- VOISINS : si l'instant obtenu plus ou moins une heure rend la MÊME
    -- heure murale, c'est que cette heure a eu lieu deux fois.
    when (((m.inst - pg_catalog.make_interval(hours => 1)) at time zone p_timezone) = m.ts)
      or (((m.inst + pg_catalog.make_interval(hours => 1)) at time zone p_timezone) = m.ts)
      then 'ambiguous'
    else 'ok'
  end
  from mapped m
$$;

comment on function public.checkout_wall_time_status(date,time,text) is
  'CHECKOUT SCHEDULING FOUNDATION v1 — CLASSE une heure murale locale : `ok`, `nonexistent` (trou du saut de printemps) ou `ambiguous` (heure vécue deux fois au recul d''automne). Miroir de resolveWallTime (lib/scheduling/eligibility.ts). Autorité de la politique CSDJ-V1-WALL-TIME-FAIL-CLOSED-01.';

revoke all on function public.checkout_wall_time_status(date,time,text) from public, anon, authenticated, service_role;

create function public.checkout_wall_time_instant(
  p_date date, p_time time, p_timezone text
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  -- NULL dès que l'heure murale n'est pas univoque : l'appelant écarte
  -- alors l'offre. Un NULL n'est donc pas une absence de valeur, c'est
  -- un REFUS -- et c'est pour cela qu'il n'y a pas de repli.
  select case
    when public.checkout_wall_time_status(p_date, p_time, p_timezone) = 'ok'
      then ((p_date + p_time) at time zone p_timezone)
    else null
  end
$$;

comment on function public.checkout_wall_time_instant(date,time,text) is
  'CHECKOUT SCHEDULING FOUNDATION v1 — instant UTC d''une heure murale locale, ou NULL si cette heure est inexistante ou ambiguë. Le NULL est un REFUS, jamais une absence de valeur : l''appelant écarte l''offre (CSDJ-V1-WALL-TIME-FAIL-CLOSED-01).';

revoke all on function public.checkout_wall_time_instant(date,time,text) from public, anon, authenticated, service_role;

-- ============================================================
-- §B  MODÈLE DE PLANIFICATION
-- ============================================================

create table public.restaurant_fulfillment_schedule (
  restaurant_id            uuid not null
                           references public.restaurants(id) on delete cascade,
  mode_code                text not null
                           references public.sale_mode_catalog(code),
  -- NULL = portée de mode sans règle de livraison (cas du retrait).
  -- Pour la livraison, la règle est celle que le code postal a
  -- résolue. `on delete cascade` : supprimer une règle de livraison
  -- supprime sa planification -- une planification orpheline
  -- désignerait une zone qui n'existe plus.
  fulfillment_rule_id      uuid
                           references public.restaurant_sale_mode_fulfillments(id) on delete cascade
                           -- Le zéro UUID est RÉSERVÉ comme sentinelle
                           -- interne (voir `rule_key`) : aucune vraie
                           -- règle ne peut porter cette valeur, sinon
                           -- « portée de mode » et « portée de cette
                           -- règle-là » deviendraient indiscernables.
                           constraint rfs_rule_id_not_sentinel
                           check (fulfillment_rule_id is distinct from
                                  '00000000-0000-0000-0000-000000000000'::uuid),
  -- Colonne générée : PostgreSQL ne sait pas mettre une expression dans
  -- une clé primaire, et deux lignes NULL ne seraient pas en conflit --
  -- il serait donc possible de créer deux planifications de mode pour
  -- le même mode. Le zéro UUID matérialise « pas de règle ».
  rule_key                 uuid not null
                           generated always as
                           (coalesce(fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid))
                           stored,

  -- Fuseau IANA. La VALIDATION contre pg_timezone_names est faite par la
  -- RPC d'écriture : un CHECK ne peut pas interroger un catalogue, et
  -- une liste de fuseaux figée dans une contrainte serait périmée dès la
  -- prochaine mise à jour de la base IANA.
  timezone                 text not null
                           check (pg_catalog.length(pg_catalog.btrim(timezone)) between 1 and 64),

  -- FERMÉ AU REPOS. Créer une ligne ne change rien avant activation
  -- explicite.
  enabled                  boolean not null default false,

  date_selection_mode      text not null default 'informational_only'
                           check (date_selection_mode = any(public.checkout_date_selection_modes())),
  slot_selection_mode      text not null default 'none'
                           check (slot_selection_mode = any(public.checkout_slot_selection_modes())),

  time_granularity_minutes smallint
                           check (time_granularity_minutes is null
                                  or time_granularity_minutes between 5 and 240),

  lead_time_minutes        integer not null default 0
                           check (lead_time_minutes between 0 and 100000),
  min_lead_days            smallint not null default 0
                           check (min_lead_days between 0 and 365),

  -- CSDJ-V1-MINUTE-PRECISION-01 / CSDJ-V1-NO-24H-01 : toute heure de
  -- configuration est à la MINUTE, et 24:00 est refusé.
  cutoff_time              time
                           constraint rfs_cutoff_minute_precision
                           check (cutoff_time is null
                                  or (cutoff_time = pg_catalog.date_trunc('minute', cutoff_time)
                                      and cutoff_time < '24:00:00'::time)),
  cutoff_offset_days       smallint not null default 1
                           check (cutoff_offset_days between 0 and 30),

  -- 0 est admissible et signifie « aujourd'hui seulement » : un
  -- commerçant qui ne prend que des commandes du jour doit pouvoir le
  -- dire, et c'est aussi la forme minimale dans laquelle se reproduit
  -- CSDJ1-AUD-01.
  booking_horizon_days     smallint not null default 14
                           check (booking_horizon_days between 0 and 365),

  -- Versionne la MÉTHODE de calcul, pour la faire évoluer sans jamais
  -- réécrire un instantané de commande déjà persisté (CSDJ-3).
  schedule_method_version  text not null default 'v1'
                           check (pg_catalog.length(schedule_method_version) between 1 and 20),

  created_at               timestamptz not null default pg_catalog.now(),
  updated_at               timestamptz not null default pg_catalog.now(),

  primary key (restaurant_id, mode_code, rule_key),

  -- Cohérence des deux politiques : si le client ne choisit pas la
  -- date, il ne peut pas davantage choisir l'heure. Miroir de
  -- isSchedulePolicyCoherent().
  constraint rfs_policy_coherent
    check (date_selection_mode = 'customer_selectable' or slot_selection_mode = 'none'),

  -- `time_within_window` sans granularité ne décrit aucune grille
  -- d'horaires sélectionnables.
  constraint rfs_granularity_required
    check (slot_selection_mode <> 'time_within_window' or time_granularity_minutes is not null)
);

comment on table public.restaurant_fulfillment_schedule is
  'CHECKOUT SCHEDULING FOUNDATION v1 — politique de planification d''UNE portée (restaurant, mode de vente, règle de fulfillment). CSDJ-V1-SCOPE-EXACT-01 : aucun héritage entre portées. L''ABSENCE de ligne, comme `enabled = false`, signifie EXCLUSIVEMENT « aucune planification n''est proposée pour cette portée » et rend le parcours de commande identique à celui d''avant ce lot (CSDJ-V1-SCHEDULE-ABSENT-01) ; jamais « dès que possible », jamais une erreur, jamais une date. Cette table naît VIDE et ne reçoit aucun backfill.';

comment on column public.restaurant_fulfillment_schedule.rule_key is
  'Colonne générée = coalesce(fulfillment_rule_id, zéro UUID). Existe uniquement pour que la clé primaire distingue réellement « portée de mode » (une seule possible) de « portée de règle » : deux NULL ne seraient pas en conflit dans une clé primaire.';

comment on column public.restaurant_fulfillment_schedule.timezone is
  'Fuseau IANA de la portée, p. ex. Europe/Paris. Validé contre pg_timezone_names par la RPC d''écriture, jamais par un CHECK : une liste figée serait périmée à la prochaine mise à jour IANA. Toute éligibilité est calculée dans CE fuseau et avec l''horloge du SERVEUR (CSDJ-V1-SERVER-CLOCK-01).';

comment on column public.restaurant_fulfillment_schedule.cutoff_offset_days is
  'Nombre de jours AVANT la date demandée auquel s''applique `cutoff_time`. 1 = « la veille à telle heure » ; 0 = « le jour même à telle heure ». `cutoff_time` NULL signifie AUCUNE heure limite, et non « minuit ».';

create table public.restaurant_fulfillment_schedule_window (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  weekday       smallint not null check (weekday between 0 and 6),
  starts_at     time not null,
  ends_at       time not null,
  display_order smallint not null default 0,

  primary key (restaurant_id, mode_code, rule_key, weekday, starts_at),

  -- Clé étrangère COMPOSITE vers la planification parente : une fenêtre
  -- ne peut pas appartenir à un tenant et sa planification à un autre.
  constraint rfsw_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade,

  constraint rfsw_interval_valid check (ends_at > starts_at),

  -- CSDJ-V1-MINUTE-PRECISION-01 : secondes exactement 00, sinon la
  -- projection publique en HH:MM dirait autre chose que la
  -- configuration. CSDJ-V1-NO-24H-01 : 24:00 refusé.
  constraint rfsw_minute_precision
    check (starts_at = pg_catalog.date_trunc('minute', starts_at)
           and ends_at = pg_catalog.date_trunc('minute', ends_at)
           and starts_at < '24:00:00'::time
           and ends_at < '24:00:00'::time)
);

comment on table public.restaurant_fulfillment_schedule_window is
  'CHECKOUT SCHEDULING FOUNDATION v1 — fenêtres d''ouverture hebdomadaires. weekday : 0 = DIMANCHE, 6 = samedi, même convention que extract(dow) et que Date#getUTCDay. CSDJ-V1-DAY-WITHOUT-OFFER-01 : un jour de semaine SANS fenêtre est un jour FERMÉ -- il n''existe volontairement aucune table « jours fermés ». CSDJ-V1-SINGLE-OFFER-AUTHORITY-01 : cette table fait foi quand slot_selection_mode vaut `none` ou `time_within_window`, et est IGNORÉE quand il vaut `fixed_slots`. La non-superposition des fenêtres d''un même jour est validée par la RPC d''écriture.';

create table public.restaurant_fulfillment_schedule_slot (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  weekday       smallint not null check (weekday between 0 and 6),
  -- IDENTIFIANT STABLE. Il voyage dans la demande du client, dans
  -- l'instantané de commande (CSDJ-3) et dans le back-office ; sa forme
  -- est volontairement étroite pour qu'il n'ait jamais besoin d'être
  -- échappé. Miroir de SCHEDULE_SLOT_KEY_PATTERN.
  slot_key      text not null
                check (pg_catalog.length(slot_key) between 1 and 40
                       and slot_key ~ '^[a-z0-9_-]+$'),
  starts_at     time not null,
  ends_at       time not null,
  display_order smallint not null default 0,

  primary key (restaurant_id, mode_code, rule_key, weekday, slot_key),

  constraint rfss_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade,

  constraint rfss_interval_valid check (ends_at > starts_at),

  -- CSDJ-V1-MINUTE-PRECISION-01 / CSDJ-V1-NO-24H-01. Un créneau
  -- 09:00:01-09:00:59 publié en HH:MM deviendrait « 09:00-09:00 », une
  -- offre de durée nulle affichée comme disponible : c'est le défaut
  -- CSDJ1-AUD-04, et il se ferme ici, à la source.
  constraint rfss_minute_precision
    check (starts_at = pg_catalog.date_trunc('minute', starts_at)
           and ends_at = pg_catalog.date_trunc('minute', ends_at)
           and starts_at < '24:00:00'::time
           and ends_at < '24:00:00'::time)
);

comment on table public.restaurant_fulfillment_schedule_slot is
  'CHECKOUT SCHEDULING FOUNDATION v1 — créneaux NOMMÉS, à identifiant stable. La clé primaire inclut le jour de semaine : le même slot_key se répète d''un jour à l''autre avec ses propres bornes, et reste donc stable pour le client comme pour l''historique. CSDJ-V1-SINGLE-OFFER-AUTHORITY-01 : cette table fait foi UNIQUEMENT quand slot_selection_mode vaut `fixed_slots`, et est ignorée sinon.';

create table public.restaurant_fulfillment_schedule_closure (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  closed_on     date not null,
  label         text check (label is null or pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),

  primary key (restaurant_id, mode_code, rule_key, closed_on),

  constraint rfsc_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade
);

comment on table public.restaurant_fulfillment_schedule_closure is
  'CHECKOUT SCHEDULING FOUNDATION v1 — fermetures exceptionnelles, journée entière. Les jours fériés sont des fermetures EXPLICITES posées par le commerçant : ce lot n''embarque AUCUN calendrier légal et n''en déduit aucun (mandat : ne rien inventer comme date métier). Une fermeture partielle de journée n''est pas modélisée en v1.';

-- ------------------------------------------------------------
-- §B.2  RLS et GRANTS — revoke AVANT grant, jamais l'inverse
-- ------------------------------------------------------------

alter table public.restaurant_fulfillment_schedule          enable row level security;
alter table public.restaurant_fulfillment_schedule_window    enable row level security;
alter table public.restaurant_fulfillment_schedule_slot      enable row level security;
alter table public.restaurant_fulfillment_schedule_closure   enable row level security;

revoke all on table public.restaurant_fulfillment_schedule          from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_schedule_window   from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_schedule_slot     from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_schedule_closure  from public, anon, authenticated, service_role;

-- SELECT seulement, et pour `authenticated` seulement : la vitrine
-- publique ne lit JAMAIS ces tables en direct, elle passe par la RPC
-- qui filtre. Aucun INSERT/UPDATE/DELETE pour aucun rôle applicatif :
-- l'écriture directe est structurellement impossible.
grant select on table public.restaurant_fulfillment_schedule          to authenticated;
grant select on table public.restaurant_fulfillment_schedule_window   to authenticated;
grant select on table public.restaurant_fulfillment_schedule_slot     to authenticated;
grant select on table public.restaurant_fulfillment_schedule_closure  to authenticated;

create policy rfs_select_members on public.restaurant_fulfillment_schedule
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_schedule.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

create policy rfsw_select_members on public.restaurant_fulfillment_schedule_window
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_schedule_window.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

create policy rfss_select_members on public.restaurant_fulfillment_schedule_slot
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_schedule_slot.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

create policy rfsc_select_members on public.restaurant_fulfillment_schedule_closure
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_schedule_closure.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

-- ============================================================
-- §C  CALCUL D'ÉLIGIBILITÉ — AUTORITÉ SERVEUR
--
-- `p_now` par défaut `pg_catalog.now()`. Il est paramétrable pour que la
-- FIXTURE DE PREUVE puisse rejouer des instants précis, et cette
-- fonction n'est accordée à AUCUN rôle applicatif : aucun appelant
-- public ne peut donc choisir « maintenant » (CSDJ-V1-SERVER-CLOCK-01).
-- ============================================================

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
as $csdj1_resolve$
declare
  v_s            public.restaurant_fulfillment_schedule;
  v_rule_key     uuid := coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_uses_slots   boolean;
  v_today        date;
  v_start        date;
  v_last         date;
  v_d            date;
  v_dates        date[] := array[]::date[];
  v_offers       jsonb := '{}'::jsonb;
  v_day          jsonb;
  v_saw_closure  boolean := false;
  v_saw_open     boolean := false;
  v_has_offer    boolean;
  v_cutoff_at    timestamptz;
  v_min_instant  timestamptz;
  v_floor        timestamptz;
  v_off          record;
  v_start_min    integer;
  v_end_min      integer;
  v_t            integer;
  v_pick         integer;
  v_inst         timestamptz;
begin
  select * into v_s
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id
    and s.mode_code = p_mode_code
    and s.rule_key = v_rule_key;

  -- CSDJ-V1-SCHEDULE-ABSENT-01 -- absence ET désactivation donnent le
  -- MÊME état observable. Distinguer les deux laisserait une trace de
  -- comportement après une désactivation.
  if not found or v_s.enabled is not true then
    return query select 'absent'::text, null::text, null::text, null::text, null::text,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_s.date_selection_mode = 'informational_only' then
    return query select 'informational_only'::text, null::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  -- CSDJ-V1-SINGLE-OFFER-AUTHORITY-01
  v_uses_slots := (v_s.slot_selection_mode = 'fixed_slots');

  if v_s.slot_selection_mode = 'time_within_window'
     and v_s.time_granularity_minutes is null then
    -- La contrainte de table l'interdit déjà ; si une ligne y échappait,
    -- on refuse plutôt que de choisir une granularité à sa place.
    return query select 'unfulfillable'::text, 'granularity_missing'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_uses_slots then
    select exists (
      select 1 from public.restaurant_fulfillment_schedule_slot x
      where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
        and x.rule_key = v_rule_key
    ) into v_has_offer;
  else
    select exists (
      select 1 from public.restaurant_fulfillment_schedule_window x
      where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
        and x.rule_key = v_rule_key
    ) into v_has_offer;
  end if;

  if not v_has_offer then
    -- CSDJ-V1-UNFULFILLABLE-EXPLICIT-01
    return query select 'unfulfillable'::text, 'no_offer_configured'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  -- Date civile du COMMERÇANT, jamais celle du client.
  v_today := (p_now at time zone v_s.timezone)::date;
  -- `min_lead_days` est une contrainte de JOUR : elle borne l'intervalle.
  v_start := v_today + v_s.min_lead_days;
  v_last  := v_today + v_s.booking_horizon_days;

  -- ══════════════════════════════════════════════════════════════════
  -- CSDJ-V1-OFFER-START-INSTANT-01 — INSTANT MINIMAL DE RÉALISATION
  --
  -- Ferme CSDJ1-AUD-01. Le délai de préparation est une contrainte
  -- d'INSTANT, pas de jour. La version précédente ne l'appliquait qu'à
  -- la date de départ, ce qui laissait proposer un créneau 09:00-11:00
  -- avec 120 minutes de délai alors qu'il était 15:00 : la DATE passait
  -- le filtre, et personne ne regardait l'OFFRE.
  --
  --   minInstant = max( now + lead_time_minutes,
  --                     plancher de (today + min_lead_days) dans le fuseau )
  --
  -- Chaque offre est ensuite comparée à cet instant, et une offre dont
  -- le DÉBUT tombe avant est écartée -- y compris un créneau déjà
  -- commencé, qui n'est plus honorable en entier. Aucun « créneau
  -- suivant » n'est inventé : les offres sont filtrées, jamais
  -- fabriquées.
  -- ══════════════════════════════════════════════════════════════════
  v_floor := public.checkout_wall_time_instant(v_start, '00:00'::time, v_s.timezone);
  v_min_instant := greatest(
    p_now + pg_catalog.make_interval(mins => v_s.lead_time_minutes),
    coalesce(v_floor, p_now + pg_catalog.make_interval(mins => v_s.lead_time_minutes)));

  v_d := v_start;
  while v_d <= v_last loop
    -- CSDJ-V1-DAY-WITHOUT-OFFER-01 : un jour sans offre est un jour
    -- fermé. `date_part('dow')` vaut 0 le dimanche, comme le TypeScript.
    if v_uses_slots then
      select exists (
        select 1 from public.restaurant_fulfillment_schedule_slot x
        where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
          and x.rule_key = v_rule_key
          and x.weekday = pg_catalog.date_part('dow', v_d)::smallint
      ) into v_has_offer;
    else
      select exists (
        select 1 from public.restaurant_fulfillment_schedule_window x
        where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
          and x.rule_key = v_rule_key
          and x.weekday = pg_catalog.date_part('dow', v_d)::smallint
      ) into v_has_offer;
    end if;

    if not v_has_offer then
      v_d := v_d + 1;
      continue;
    end if;

    if exists (
      select 1 from public.restaurant_fulfillment_schedule_closure c
      where c.restaurant_id = p_restaurant_id and c.mode_code = p_mode_code
        and c.rule_key = v_rule_key and c.closed_on = v_d
    ) then
      v_saw_closure := true;
      v_d := v_d + 1;
      continue;
    end if;

    -- Heure limite, dans le fuseau du commerçant. Inégalité STRICTE :
    -- à la seconde de l'heure limite il est trop tard -- une limite
    -- qu'on peut atteindre pile n'est pas une limite.
    --
    -- Si cette heure limite tombe elle-même sur une heure murale
    -- inexistante ou ambiguë, la date est écartée : on ne devine pas
    -- l'instant d'une limite (CSDJ-V1-WALL-TIME-FAIL-CLOSED-01).
    if v_s.cutoff_time is not null then
      v_cutoff_at := public.checkout_wall_time_instant(
        v_d - v_s.cutoff_offset_days, v_s.cutoff_time, v_s.timezone);
      if v_cutoff_at is null or p_now >= v_cutoff_at then
        v_d := v_d + 1;
        continue;
      end if;
    end if;

    v_saw_open := true;
    v_day := '[]'::jsonb;

    for v_off in
      select * from (
        select x.slot_key, x.starts_at, x.ends_at
        from public.restaurant_fulfillment_schedule_slot x
        where v_uses_slots
          and x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
          and x.rule_key = v_rule_key
          and x.weekday = pg_catalog.date_part('dow', v_d)::smallint
        union all
        select null::text, w.starts_at, w.ends_at
        from public.restaurant_fulfillment_schedule_window w
        where not v_uses_slots
          and w.restaurant_id = p_restaurant_id and w.mode_code = p_mode_code
          and w.rule_key = v_rule_key
          and w.weekday = pg_catalog.date_part('dow', v_d)::smallint
      ) o
      order by o.starts_at, coalesce(o.slot_key, '')
    loop
      -- Raisonnement en MINUTES depuis minuit, comme le TypeScript :
      -- `time + interval` repasserait modulo 24 h et ferait boucler une
      -- fenêtre tardive.
      v_start_min := pg_catalog.date_part('hour', v_off.starts_at)::integer * 60
                   + pg_catalog.date_part('minute', v_off.starts_at)::integer;
      v_end_min   := pg_catalog.date_part('hour', v_off.ends_at)::integer * 60
                   + pg_catalog.date_part('minute', v_off.ends_at)::integer;

      if v_s.slot_selection_mode = 'time_within_window' then
        -- Le client choisit une HEURE dans la fenêtre : le début est
        -- AVANCÉ le long de la grille de granularité du commerçant
        -- jusqu'au premier point utilisable. La grille reste ancrée sur
        -- le début CONFIGURÉ, pour rester celle qu'il a décrite. Ce
        -- n'est pas une offre nouvelle, c'est la part encore utilisable
        -- d'une fenêtre existante.
        v_pick := null;
        v_t := v_start_min;
        while v_t < v_end_min loop
          v_inst := public.checkout_wall_time_instant(
            v_d, pg_catalog.make_time(v_t / 60, v_t % 60, 0), v_s.timezone);
          if v_inst is not null and v_inst >= v_min_instant then
            v_pick := v_t;
            exit;
          end if;
          v_t := v_t + v_s.time_granularity_minutes;
        end loop;
        if v_pick is null then
          continue;
        end if;
        v_day := v_day || pg_catalog.jsonb_build_object(
          'slot_key', null,
          'starts_at', pg_catalog.to_char(pg_catalog.make_time(v_pick / 60, v_pick % 60, 0), 'HH24:MI'),
          'ends_at', pg_catalog.to_char(v_off.ends_at, 'HH24:MI'));
        continue;
      end if;

      -- `fixed_slots` et `none` : l'offre est atomique, son DÉBUT décide.
      v_inst := public.checkout_wall_time_instant(v_d, v_off.starts_at, v_s.timezone);
      if v_inst is null or v_inst < v_min_instant then
        continue;
      end if;
      v_day := v_day || pg_catalog.jsonb_build_object(
        'slot_key', v_off.slot_key,
        'starts_at', pg_catalog.to_char(v_off.starts_at, 'HH24:MI'),
        'ends_at', pg_catalog.to_char(v_off.ends_at, 'HH24:MI'));
    end loop;

    -- Une date dont TOUTES les offres ont été écartées n'est pas une
    -- date éligible : la proposer afficherait un jour sans aucune heure.
    if pg_catalog.jsonb_array_length(v_day) = 0 then
      v_d := v_d + 1;
      continue;
    end if;

    v_dates := v_dates || v_d;
    v_offers := v_offers || pg_catalog.jsonb_build_object(v_d::text, v_day);

    if v_s.date_selection_mode = 'derived_earliest' then
      exit;
    end if;

    v_d := v_d + 1;
  end loop;

  if pg_catalog.cardinality(v_dates) = 0 then
    -- Trois causes distinctes, trois corrections distinctes :
    --   - des dates étaient ouvertes mais aucune offre ne tenait encore
    --     -> desserrer le délai, ou attendre ;
    --   - tout est fermé -> retirer une fermeture ;
    --   - la première date possible est au-delà de l'horizon
    --     -> allonger l'horizon ou réduire le minimum de jours.
    -- Les confondre livrerait au commerçant un refus qu'il ne sait pas
    -- corriger.
    return query select 'unfulfillable'::text,
                        case when v_saw_open then 'no_offer_in_horizon'
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
$csdj1_resolve$;

comment on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz) is
  'CHECKOUT SCHEDULING FOUNDATION v1 — AUTORITÉ d''éligibilité. Énumère les dates et offres éligibles d''une portée, dans le fuseau du commerçant, depuis l''horloge du serveur. Renvoie TOUJOURS exactement une ligne. `p_now` est paramétrable pour la fixture de preuve et cette fonction n''est accordée à AUCUN rôle applicatif : aucun appelant public ne peut choisir « maintenant » (CSDJ-V1-SERVER-CLOCK-01). Ne renvoie jamais de date de repli : une politique exigeant une date sans date éligible rend `unfulfillable` avec son motif (CSDJ-V1-UNFULFILLABLE-EXPLICIT-01).';

revoke all on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz) from public, anon, authenticated, service_role;

-- ============================================================
-- §D  LECTURE PUBLIQUE SÛRE
--
-- Elle réutilise l'autorité de tarification EXISTANTE sans la modifier,
-- et expose STRICTEMENT MOINS que la projection publique actuelle :
-- ni provider, ni fulfillment_code, ni fulfillment_rule_id, ni
-- zone_prefixes, ni config.
-- ============================================================

create function public.get_checkout_fulfillment_schedule(
  p_restaurant_id uuid,
  p_mode_code text,
  p_postal_code text default null,
  p_total_count integer default 0,
  p_subtotal numeric default null
)
returns table (
  delivery_applicable      boolean,
  delivery_eligible        boolean,
  delivery_block           text,
  delivery_fee             numeric,
  delivery_min_items       integer,
  delivery_missing         integer,
  delivery_customer_text   text,
  pricing_mode             text,
  fixed_fee                numeric,
  free_threshold           numeric,
  schedule_status          text,
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
as $csdj1_public$
declare
  v_is_delivery boolean;
  v_rule_id     uuid;
  v_del         record;
  v_sch         record;
begin
  if p_restaurant_id is null or pg_catalog.btrim(coalesce(p_mode_code, '')) = '' then
    raise exception 'CSDJ1_INVALID_ARGUMENTS: restaurant et mode de vente requis.'
      using errcode = '22023';
  end if;

  -- L'établissement doit être réellement ouvert au public : même porte
  -- que les autres projections publiques, pas une porte plus permissive.
  if not exists (
    select 1 from public.restaurants r
    where r.id = p_restaurant_id and r.is_active = true and r.status = 'active'
  ) then
    raise exception 'CSDJ1_RESTAURANT_NOT_PUBLIC: établissement introuvable ou inactif.'
      using errcode = '42501';
  end if;

  select (c.category = 'delivery') into v_is_delivery
  from public.sale_mode_catalog c where c.code = p_mode_code;

  if v_is_delivery is null then
    raise exception 'CSDJ1_UNKNOWN_MODE: mode de vente hors catalogue.'
      using errcode = '22023';
  end if;

  -- ══════════════════════════════════════════════════════════════════
  -- CSDJ-V1-MODE-ENABLED-GATE-01 — ferme CSDJ1-AUD-03
  --
  -- Un mode de vente DÉSACTIVÉ pour cet établissement ne doit RIEN
  -- projeter : ni fuseau, ni politique, ni fenêtre, ni créneau, ni
  -- date. La version précédente ne vérifiait l'activation que pour la
  -- livraison, et seulement indirectement, via l'autorité de
  -- tarification : un retrait désactivé continuait donc de publier sa
  -- planification.
  --
  -- La réponse est celle d'une ABSENCE, volontairement indiscernable de
  -- « aucune planification » et de « planification désactivée » : si le
  -- statut distinguait ces cas, la surface publique deviendrait un
  -- moyen de sonder la configuration d'un commerçant.
  -- ══════════════════════════════════════════════════════════════════
  if not exists (
    select 1 from public.restaurant_sale_modes m
    where m.restaurant_id = p_restaurant_id
      and m.mode_code = p_mode_code
      and m.enabled = true
  ) then
    return query select v_is_delivery, null::boolean, null::text, null::numeric,
                        null::integer, null::integer, null::text,
                        null::text, null::numeric, null::numeric,
                        'absent'::text, null::text, null::text, null::text, null::text,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_is_delivery then
    -- AUTORITÉ DE TARIFICATION EXISTANTE, appelée telle quelle.
    select * into v_del
    from public.resolve_delivery_fulfillment(
      p_restaurant_id, p_mode_code, p_postal_code, coalesce(p_total_count, 0), p_subtotal);

    if v_del.eligible is not true then
      -- La planification n'est pas calculée : la demande n'a pas
      -- atteint la planification. Le motif appartient au moteur de
      -- livraison, pas à ce lot.
      return query select true, false, v_del.block, null::numeric,
                          v_del.min_items, v_del.missing, v_del.customer_text,
                          v_del.pricing_mode, v_del.fixed_fee, v_del.free_threshold,
                          'blocked_upstream'::text, null::text, null::text, null::text, null::text,
                          null::smallint, null::date, null::date[], null::jsonb;
      return;
    end if;

    v_rule_id := v_del.fulfillment_rule_id;

    select * into v_sch
    from public.resolve_fulfillment_schedule(p_restaurant_id, p_mode_code, v_rule_id);

    return query select true, true, v_del.block, v_del.delivery_fee,
                        v_del.min_items, v_del.missing, v_del.customer_text,
                        v_del.pricing_mode, v_del.fixed_fee, v_del.free_threshold,
                        v_sch.status, v_sch.unfulfillable_reason, v_sch.schedule_timezone,
                        v_sch.date_selection_mode, v_sch.slot_selection_mode,
                        v_sch.time_granularity_minutes, v_sch.first_eligible_date,
                        v_sch.eligible_dates, v_sch.offers;
    return;
  end if;

  -- Modes non-livraison : aucune règle de fulfillment, donc portée de
  -- mode (rule_key = zéro UUID). Aucune colonne de livraison n'est
  -- remplie -- `delivery_applicable = false` le dit explicitement,
  -- plutôt que de laisser un `null` ambigu.
  select * into v_sch
  from public.resolve_fulfillment_schedule(p_restaurant_id, p_mode_code, null);

  return query select false, null::boolean, null::text, null::numeric,
                      null::integer, null::integer, null::text,
                      null::text, null::numeric, null::numeric,
                      v_sch.status, v_sch.unfulfillable_reason, v_sch.schedule_timezone,
                      v_sch.date_selection_mode, v_sch.slot_selection_mode,
                      v_sch.time_granularity_minutes, v_sch.first_eligible_date,
                      v_sch.eligible_dates, v_sch.offers;
end
$csdj1_public$;

comment on function public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric) is
  'CHECKOUT SCHEDULING FOUNDATION v1 — LECTURE PUBLIQUE SÛRE. Réutilise public.resolve_delivery_fulfillment pour la décision de zone et de tarif, sans la modifier ni en dupliquer la formule, puis public.resolve_fulfillment_schedule pour les dates. Ne laisse traverser NI provider, NI fulfillment_code, NI fulfillment_rule_id, NI zone_prefixes, NI config : le client reçoit une POLITIQUE de planification, jamais un nom de transporteur -- il ne choisit donc pas son transporteur, c''est une configuration métier. N''accepte aucune heure de l''appelant.';

revoke all on function public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric) from public;
grant execute on function public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric) to anon, authenticated;

-- ============================================================
-- §E  ÉCRITURE MARCHANDE PAR RPC
-- ============================================================

create function public.get_merchant_fulfillment_schedules(p_restaurant_id uuid)
returns table (
  mode_code                text,
  fulfillment_rule_id      uuid,
  timezone                 text,
  enabled                  boolean,
  date_selection_mode      text,
  slot_selection_mode      text,
  time_granularity_minutes smallint,
  lead_time_minutes        integer,
  min_lead_days            smallint,
  cutoff_time              time,
  cutoff_offset_days       smallint,
  booking_horizon_days     smallint,
  windows                  jsonb,
  slots                    jsonb,
  closures                 jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj1_merchant_read$
begin
  if auth.uid() is null then
    raise exception 'CSDJ1_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception 'CSDJ1_FORBIDDEN: accès refusé à cet établissement.' using errcode = '42501';
  end if;

  return query
  select s.mode_code, s.fulfillment_rule_id, s.timezone, s.enabled,
         s.date_selection_mode, s.slot_selection_mode, s.time_granularity_minutes,
         s.lead_time_minutes, s.min_lead_days, s.cutoff_time, s.cutoff_offset_days,
         s.booking_horizon_days,
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'weekday', w.weekday,
                    'startsAt', pg_catalog.to_char(w.starts_at, 'HH24:MI'),
                    'endsAt', pg_catalog.to_char(w.ends_at, 'HH24:MI'))
                  order by w.weekday, w.starts_at)
           from public.restaurant_fulfillment_schedule_window w
           where w.restaurant_id = s.restaurant_id and w.mode_code = s.mode_code
             and w.rule_key = s.rule_key), '[]'::jsonb),
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'weekday', x.weekday, 'slotKey', x.slot_key,
                    'startsAt', pg_catalog.to_char(x.starts_at, 'HH24:MI'),
                    'endsAt', pg_catalog.to_char(x.ends_at, 'HH24:MI'))
                  order by x.weekday, x.starts_at, x.slot_key)
           from public.restaurant_fulfillment_schedule_slot x
           where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code
             and x.rule_key = s.rule_key), '[]'::jsonb),
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'closedOn', c.closed_on, 'label', c.label)
                  order by c.closed_on)
           from public.restaurant_fulfillment_schedule_closure c
           where c.restaurant_id = s.restaurant_id and c.mode_code = s.mode_code
             and c.rule_key = s.rule_key), '[]'::jsonb)
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id
  order by s.mode_code, s.rule_key;
end
$csdj1_merchant_read$;

comment on function public.get_merchant_fulfillment_schedules(uuid) is
  'CHECKOUT SCHEDULING FOUNDATION v1 — lecture back-office de TOUTES les planifications d''un établissement, fenêtres, créneaux et fermetures agrégés. Réservée aux membres de l''établissement et aux opérateurs Scanym.';

revoke all on function public.get_merchant_fulfillment_schedules(uuid) from public, anon;
grant execute on function public.get_merchant_fulfillment_schedules(uuid) to authenticated;

create function public.mutate_merchant_fulfillment_schedule(
  p_restaurant_id uuid,
  p_action text,
  p_payload jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $csdj1_mutate$
declare
  v_mode      text;
  v_rule      uuid;
  v_rule_key  uuid;
  v_tz        text;
  v_date_mode text;
  v_slot_mode text;
  v_item      jsonb;
  v_prev_end  time;
  v_prev_day  smallint;
begin
  if auth.uid() is null then
    raise exception 'CSDJ1_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.has_role_in(p_restaurant_id, array['owner','manager']) then
    raise exception 'CSDJ1_FORBIDDEN: rôle owner ou manager requis.' using errcode = '42501';
  end if;
  if p_action is null or p_action <> all(array['save_schedule','delete_schedule','replace_windows','replace_slots','replace_closures']) then
    raise exception 'CSDJ1_UNKNOWN_ACTION: action inconnue.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'CSDJ1_INVALID_PAYLOAD: objet JSON attendu.' using errcode = '22023';
  end if;

  -- Verrou consultatif par tenant : deux éditions concurrentes du même
  -- établissement se sérialisent, elles ne s'entrelacent pas.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_restaurant_id::text, 1104));

  v_mode := p_payload->>'modeCode';
  if v_mode is null or not exists (select 1 from public.sale_mode_catalog c where c.code = v_mode) then
    raise exception 'CSDJ1_UNKNOWN_MODE: mode de vente hors catalogue.' using errcode = '22023';
  end if;

  -- Une règle de fulfillment désignée doit appartenir à CET
  -- établissement ET à CE mode. Vérifié dans la même requête : une
  -- règle d'un autre tenant ne peut pas correspondre.
  if p_payload ? 'fulfillmentRuleId' and p_payload->>'fulfillmentRuleId' is not null then
    v_rule := (p_payload->>'fulfillmentRuleId')::uuid;
    -- Le zéro UUID est la sentinelle interne de « portée de mode » : le
    -- laisser désigner une vraie règle rendrait les deux portées
    -- indiscernables. La contrainte de table le refuse aussi ; ici le
    -- refus porte un nom.
    if v_rule = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception 'CSDJ1_RESERVED_RULE_ID: le zéro UUID est réservé comme sentinelle interne.'
        using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.restaurant_sale_mode_fulfillments f
      where f.id = v_rule and f.restaurant_id = p_restaurant_id and f.mode_code = v_mode
    ) then
      raise exception 'CSDJ1_FOREIGN_RULE: règle de livraison inconnue pour cet établissement et ce mode.'
        using errcode = '42501';
    end if;
  end if;
  v_rule_key := coalesce(v_rule, '00000000-0000-0000-0000-000000000000'::uuid);

  if p_action = 'delete_schedule' then
    delete from public.restaurant_fulfillment_schedule s
    where s.restaurant_id = p_restaurant_id and s.mode_code = v_mode and s.rule_key = v_rule_key;
    return;
  end if;

  if p_action = 'save_schedule' then
    v_tz := p_payload->>'timezone';
    -- Validation du fuseau contre le CATALOGUE du serveur, jamais
    -- contre une liste figée.
    if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
      raise exception 'CSDJ1_INVALID_TIMEZONE: fuseau IANA inconnu du serveur.' using errcode = '22023';
    end if;
    v_date_mode := coalesce(p_payload->>'dateSelectionMode', 'informational_only');
    v_slot_mode := coalesce(p_payload->>'slotSelectionMode', 'none');
    if v_date_mode <> all(public.checkout_date_selection_modes())
       or v_slot_mode <> all(public.checkout_slot_selection_modes()) then
      raise exception 'CSDJ1_INVALID_POLICY: politique hors catalogue.' using errcode = '22023';
    end if;
    -- CSDJ-V1-MINUTE-PRECISION-01 : une heure limite sous-minute est
    -- REFUSÉE par un message qui la nomme, plutôt que par la contrainte
    -- de table seule -- et jamais tronquée.
    if nullif(p_payload->>'cutoffTime','') is not null then
      if (p_payload->>'cutoffTime')::time
           is distinct from pg_catalog.date_trunc('minute', (p_payload->>'cutoffTime')::time) then
        raise exception 'CSDJ1_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).'
          using errcode = '22023';
      end if;
    end if;

    insert into public.restaurant_fulfillment_schedule as t (
      restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
      date_selection_mode, slot_selection_mode, time_granularity_minutes,
      lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days,
      booking_horizon_days)
    values (
      p_restaurant_id, v_mode, v_rule, v_tz,
      coalesce((p_payload->>'enabled')::boolean, false),
      v_date_mode, v_slot_mode,
      nullif(p_payload->>'timeGranularityMinutes','')::smallint,
      coalesce(nullif(p_payload->>'leadTimeMinutes','')::integer, 0),
      coalesce(nullif(p_payload->>'minLeadDays','')::smallint, 0::smallint),
      nullif(p_payload->>'cutoffTime','')::time,
      coalesce(nullif(p_payload->>'cutoffOffsetDays','')::smallint, 1::smallint),
      coalesce(nullif(p_payload->>'bookingHorizonDays','')::smallint, 14::smallint))
    on conflict (restaurant_id, mode_code, rule_key) do update set
      timezone = excluded.timezone,
      enabled = excluded.enabled,
      date_selection_mode = excluded.date_selection_mode,
      slot_selection_mode = excluded.slot_selection_mode,
      time_granularity_minutes = excluded.time_granularity_minutes,
      lead_time_minutes = excluded.lead_time_minutes,
      min_lead_days = excluded.min_lead_days,
      cutoff_time = excluded.cutoff_time,
      cutoff_offset_days = excluded.cutoff_offset_days,
      booking_horizon_days = excluded.booking_horizon_days,
      updated_at = pg_catalog.now();
    return;
  end if;

  -- Les trois actions de remplacement exigent une planification
  -- existante : une fenêtre sans politique ne décrirait rien.
  if not exists (
    select 1 from public.restaurant_fulfillment_schedule s
    where s.restaurant_id = p_restaurant_id and s.mode_code = v_mode and s.rule_key = v_rule_key
  ) then
    raise exception 'CSDJ1_SCHEDULE_ABSENT: aucune planification pour cette portée.' using errcode = '23503';
  end if;

  if p_action = 'replace_windows' then
    if pg_catalog.jsonb_typeof(p_payload->'windows') is distinct from 'array' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `windows` doit être un tableau.' using errcode = '22023';
    end if;
    -- CSDJ-V1-MINUTE-PRECISION-01, nommé avant la contrainte de table.
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_payload->'windows') e
      where (e->>'startsAt')::time is distinct from pg_catalog.date_trunc('minute', (e->>'startsAt')::time)
         or (e->>'endsAt')::time is distinct from pg_catalog.date_trunc('minute', (e->>'endsAt')::time)
    ) then
      raise exception 'CSDJ1_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).'
        using errcode = '22023';
    end if;
    delete from public.restaurant_fulfillment_schedule_window w
    where w.restaurant_id = p_restaurant_id and w.mode_code = v_mode and w.rule_key = v_rule_key;
    insert into public.restaurant_fulfillment_schedule_window
      (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at, display_order)
    select p_restaurant_id, v_mode, v_rule_key,
           (e->>'weekday')::smallint, (e->>'startsAt')::time, (e->>'endsAt')::time,
           coalesce(nullif(e->>'displayOrder','')::smallint, 0::smallint)
    from pg_catalog.jsonb_array_elements(p_payload->'windows') e;

    -- NON-SUPERPOSITION. Une contrainte d'exclusion n'est pas
    -- disponible sur `time` sans type d'intervalle dédié ; la règle est
    -- donc vérifiée ici, APRÈS insertion et DANS la transaction : si
    -- elle est violée, rien n'est appliqué.
    v_prev_day := null;
    v_prev_end := null;
    for v_item in
      select pg_catalog.jsonb_build_object('d', w.weekday, 's', w.starts_at, 'e', w.ends_at)
      from public.restaurant_fulfillment_schedule_window w
      where w.restaurant_id = p_restaurant_id and w.mode_code = v_mode and w.rule_key = v_rule_key
      order by w.weekday, w.starts_at
    loop
      if v_prev_day is not null and (v_item->>'d')::smallint = v_prev_day
         and (v_item->>'s')::time < v_prev_end then
        raise exception 'CSDJ1_WINDOW_OVERLAP: deux fenêtres du même jour se superposent.'
          using errcode = '23514';
      end if;
      v_prev_day := (v_item->>'d')::smallint;
      v_prev_end := (v_item->>'e')::time;
    end loop;
    return;
  end if;

  if p_action = 'replace_slots' then
    if pg_catalog.jsonb_typeof(p_payload->'slots') is distinct from 'array' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `slots` doit être un tableau.' using errcode = '22023';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_payload->'slots') e
      where (e->>'startsAt')::time is distinct from pg_catalog.date_trunc('minute', (e->>'startsAt')::time)
         or (e->>'endsAt')::time is distinct from pg_catalog.date_trunc('minute', (e->>'endsAt')::time)
    ) then
      raise exception 'CSDJ1_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).'
        using errcode = '22023';
    end if;
    delete from public.restaurant_fulfillment_schedule_slot x
    where x.restaurant_id = p_restaurant_id and x.mode_code = v_mode and x.rule_key = v_rule_key;
    insert into public.restaurant_fulfillment_schedule_slot
      (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at, display_order)
    select p_restaurant_id, v_mode, v_rule_key,
           (e->>'weekday')::smallint, e->>'slotKey',
           (e->>'startsAt')::time, (e->>'endsAt')::time,
           coalesce(nullif(e->>'displayOrder','')::smallint, 0::smallint)
    from pg_catalog.jsonb_array_elements(p_payload->'slots') e;
    return;
  end if;

  -- replace_closures
  if pg_catalog.jsonb_typeof(p_payload->'closures') is distinct from 'array' then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `closures` doit être un tableau.' using errcode = '22023';
  end if;
  delete from public.restaurant_fulfillment_schedule_closure c
  where c.restaurant_id = p_restaurant_id and c.mode_code = v_mode and c.rule_key = v_rule_key;
  insert into public.restaurant_fulfillment_schedule_closure
    (restaurant_id, mode_code, rule_key, closed_on, label)
  select p_restaurant_id, v_mode, v_rule_key,
         (e->>'closedOn')::date, nullif(pg_catalog.btrim(coalesce(e->>'label','')), '')
  from pg_catalog.jsonb_array_elements(p_payload->'closures') e;
end
$csdj1_mutate$;

comment on function public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb) is
  'CHECKOUT SCHEDULING FOUNDATION v1 — SEULE autorité d''écriture du modèle de planification. Réservée aux rôles owner/manager, sous verrou consultatif par tenant. Valide le fuseau contre pg_timezone_names, les politiques contre les catalogues fermés, l''appartenance d''une règle de livraison à l''établissement ET au mode, et la non-superposition des fenêtres d''un même jour. Les tables n''ont aucun GRANT d''écriture : il n''existe aucun autre chemin.';

revoke all on function public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb) from public, anon;
grant execute on function public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb) to authenticated;

-- ============================================================
-- §Z  POST-VOL — DANS LA TRANSACTION, AVANT LE COMMIT
-- ============================================================
do $csdj1_postflight$
declare
  v_t    text;
  v_role text;
  v_priv text;
  v_n    integer;
begin
  -- Z.1 Les quatre tables existent et portent RLS.
  foreach v_t in array array[
    'restaurant_fulfillment_schedule',
    'restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot',
    'restaurant_fulfillment_schedule_closure'
  ] loop
    if pg_catalog.to_regclass('public.' || v_t) is null then
      raise exception 'SCANYM_POSTCHECK: table % absente.', v_t;
    end if;
    if not exists (select 1 from pg_catalog.pg_class c
                   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = v_t and c.relrowsecurity) then
      raise exception 'SCANYM_POSTCHECK: RLS inactive sur %.', v_t;
    end if;

    -- Z.2 IMMUABILITÉ PAR ABSENCE DE GRANT : aucun rôle applicatif ne
    --     peut écrire, y compris service_role, y compris TRUNCATE que
    --     RLS ne gouverne pas.
    foreach v_role in array array['anon','authenticated','service_role'] loop
      foreach v_priv in array array['INSERT','UPDATE','DELETE','TRUNCATE'] loop
        if pg_catalog.has_table_privilege(v_role, 'public.' || v_t, v_priv) then
          raise exception 'SCANYM_POSTCHECK: % possède % sur % -- écriture directe possible.',
            v_role, v_priv, v_t;
        end if;
      end loop;
    end loop;

    -- Z.3 anon ne lit AUCUNE de ces tables en direct.
    if pg_catalog.has_table_privilege('anon', 'public.' || v_t, 'SELECT') then
      raise exception 'SCANYM_POSTCHECK: anon possède SELECT sur %.', v_t;
    end if;
    if not pg_catalog.has_table_privilege('authenticated', 'public.' || v_t, 'SELECT') then
      raise exception 'SCANYM_POSTCHECK: authenticated devrait posséder SELECT sur %.', v_t;
    end if;

    -- Z.4 Exactement une policy, de type SELECT, et AUCUNE policy
    --     d'écriture.
    select pg_catalog.count(*) into v_n from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename = v_t;
    if v_n <> 1 then
      raise exception 'SCANYM_POSTCHECK: % porte % policy/policies au lieu d''une.', v_t, v_n;
    end if;
    select pg_catalog.count(*) into v_n from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename = v_t and p.cmd = 'SELECT';
    if v_n <> 1 then
      raise exception 'SCANYM_POSTCHECK: la policy de % n''est pas une policy SELECT.', v_t;
    end if;

    -- Z.5 AUCUN BACKFILL : les tables naissent vides.
    execute pg_catalog.format('select pg_catalog.count(*) from public.%I', v_t) into v_n;
    if v_n <> 0 then
      raise exception 'SCANYM_POSTCHECK: % contient % ligne(s) -- ce lot ne doit rien insérer.', v_t, v_n;
    end if;
  end loop;

  -- Z.6 Les sept fonctions existent, en UNE SEULE surcharge chacune.
  foreach v_t in array array[
    'checkout_date_selection_modes',
    'checkout_slot_selection_modes',
    'checkout_schedule_statuses',
    'checkout_unfulfillable_reasons',
    'checkout_wall_time_status',
    'checkout_wall_time_instant',
    'resolve_fulfillment_schedule',
    'get_checkout_fulfillment_schedule',
    'get_merchant_fulfillment_schedules',
    'mutate_merchant_fulfillment_schedule'
  ] loop
    select pg_catalog.count(*) into v_n
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_t;
    if v_n <> 1 then
      raise exception 'SCANYM_POSTCHECK: public.% a % surcharge(s) au lieu d''une.', v_t, v_n;
    end if;
  end loop;

  -- Z.7 SEULE la lecture publique est accordée à anon.
  if not pg_catalog.has_function_privilege('anon',
       'public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: anon devrait pouvoir exécuter la lecture publique.';
  end if;
  foreach v_t in array array[
    'public.checkout_wall_time_status(date,time without time zone,text)',
    'public.checkout_wall_time_instant(date,time without time zone,text)',
    'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)',
    'public.get_merchant_fulfillment_schedules(uuid)',
    'public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)',
    'public.checkout_date_selection_modes()',
    'public.checkout_slot_selection_modes()',
    'public.checkout_schedule_statuses()',
    'public.checkout_unfulfillable_reasons()'
  ] loop
    foreach v_role in array array['anon','authenticated','service_role'] loop
      if v_role = 'authenticated'
         and v_t in ('public.get_merchant_fulfillment_schedules(uuid)',
                     'public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)') then
        continue;
      end if;
      if pg_catalog.has_function_privilege(v_role, v_t, 'EXECUTE') then
        raise exception 'SCANYM_POSTCHECK: % peut exécuter % -- autorité interne exposée.', v_role, v_t;
      end if;
    end loop;
  end loop;

  -- Z.8 AUCUNE FUITE DE FOURNISSEUR. La signature de retour de la
  --     lecture publique ne doit contenir aucune des colonnes
  --     interdites ; on inspecte le TEXTE de la définition, donc ce
  --     contrôle survit à un ajout de colonne ultérieur.
  foreach v_t in array array['provider', 'fulfillment_code', 'fulfillment_rule_id', 'zone_prefixes'] loop
    if pg_catalog.pg_get_function_result(
         pg_catalog.to_regprocedure('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)')
       ) like '%' || v_t || '%' then
      raise exception 'SCANYM_POSTCHECK: la lecture publique exposerait la colonne %.', v_t;
    end if;
  end loop;

  -- Z.9 Les catalogues ont la cardinalité attendue, et les statuts
  --     contiennent bien les deux valeurs porteuses des invariants.
  if pg_catalog.cardinality(public.checkout_date_selection_modes()) <> 3
     or pg_catalog.cardinality(public.checkout_slot_selection_modes()) <> 3
     or pg_catalog.cardinality(public.checkout_schedule_statuses()) <> 5
     or pg_catalog.cardinality(public.checkout_unfulfillable_reasons()) <> 5 then
    raise exception 'SCANYM_POSTCHECK: cardinalité de catalogue inattendue.';
  end if;
  if not ('absent' = any(public.checkout_schedule_statuses()))
     or not ('unfulfillable' = any(public.checkout_schedule_statuses())) then
    raise exception 'SCANYM_POSTCHECK: les statuts porteurs des invariants sont absents.';
  end if;

  -- Z.9bis LA POLITIQUE D'HEURE MURALE EST EFFECTIVE. On ne vérifie pas
  --        que la fonction existe, mais qu'elle REFUSE : une heure du
  --        trou de printemps et une heure ambiguë d'automne doivent
  --        rendre NULL, et une heure ordinaire un instant.
  if public.checkout_wall_time_instant('2026-03-29'::date, '02:30'::time, 'Europe/Paris') is not null then
    raise exception 'SCANYM_POSTCHECK: une heure murale INEXISTANTE est acceptée -- CSDJ-V1-WALL-TIME-FAIL-CLOSED-01 violé.';
  end if;
  if public.checkout_wall_time_instant('2026-10-25'::date, '02:30'::time, 'Europe/Paris') is not null then
    raise exception 'SCANYM_POSTCHECK: une heure murale AMBIGUË est acceptée -- CSDJ-V1-WALL-TIME-FAIL-CLOSED-01 violé.';
  end if;
  if public.checkout_wall_time_instant('2026-10-13'::date, '09:00'::time, 'Europe/Paris') is null then
    raise exception 'SCANYM_POSTCHECK: une heure murale ORDINAIRE est refusée : la politique sur-refuse.';
  end if;
  if public.checkout_wall_time_status('2026-03-29'::date, '02:30'::time, 'Europe/Paris') <> 'nonexistent'
     or public.checkout_wall_time_status('2026-10-25'::date, '02:30'::time, 'Europe/Paris') <> 'ambiguous' then
    raise exception 'SCANYM_POSTCHECK: la CLASSIFICATION des heures murales est fausse.';
  end if;

  -- Z.9ter LA GARDE DE MODE DÉSACTIVÉ EST PRÉSENTE dans la lecture
  --        publique. Le comportement est prouvé par le harnais ; ici on
  --        constate que la garde n'a pas disparu du corps.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_checkout_fulfillment_schedule'
        and pg_catalog.pg_get_functiondef(p.oid) like '%restaurant_sale_modes%') <> 1 then
    raise exception 'SCANYM_POSTCHECK: la lecture publique ne vérifie plus l''activation du mode de vente.';
  end if;

  -- Z.10 AUCUNE FONCTION PRÉEXISTANTE REDÉFINIE. `create_order` et
  --      l'autorité de tarification doivent être exactement celles
  --      d'avant : ce lot ne les touche pas.
  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';
  if v_n <> 1 then
    raise exception 'SCANYM_POSTCHECK: create_order a % surcharge(s) -- ce lot ne doit pas y toucher.', v_n;
  end if;
  if pg_catalog.to_regprocedure('public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)') is null then
    raise exception 'SCANYM_POSTCHECK: l''autorité de tarification a disparu.';
  end if;
end
$csdj1_postflight$;

commit;

-- ============================================================
-- IDEMPOTENCE DE CE FICHIER
--
-- Il n'est PAS ré-exécutable : le pré-vol P-3 refuse dès qu'un objet du
-- lot existe. C'est voulu -- une seconde application silencieuse
-- masquerait une première application partielle.
-- ============================================================
