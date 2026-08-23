-- ============================================================
-- Scanym LOT 2A — Modes de vente génériques (fondations).
--
-- Baseline : LOT 1B.2 (déployé). Remplace le mécanisme figé
-- restaurant_configs.allowed_service_modes (text[], CHECK implicite
-- via orders.service_mode) et le fichier lib/restaurants-config.ts
-- (dette technique auto-documentée : "ajouter un client impose un
-- déploiement") par un catalogue extensible + configuration par
-- établissement, suivant EXACTEMENT le même principe déjà audité
-- pour les langues (LOT 1A : supported_languages/
-- restaurant_active_languages).
--
-- Garde-fous CIO appliqués (design approuvé) :
--   1. Codes historiques 'table'/'pickup'/'delivery' CONSERVÉS tels
--      quels -- aucun renommage, zéro migration de données existantes
--      sur orders.service_mode.
--   2. provider/pricing_mode contraints par CHECK (vocabulaire stable,
--      interne, distinct du catalogue de modes lui-même qui doit
--      rester extensible).
--   3. Surcharge sale_mode_field_requirements PAR ÉTABLISSEMENT
--      implémentée -- nécessité RÉELLE démontrée par audit direct de
--      lib/restaurants-config.ts (illico-presto : pickup = nom seul ;
--      sanaa-cookies : pickup = nom+téléphone+email TOUS obligatoires,
--      livraison = email AUSSI obligatoire -- deux établissements
--      divergent chacun du défaut catalogue, jamais supposé).
--   4. restaurants-config.ts CONSERVÉ dans ce lot (filet de sécurité
--      transitoire, 2A uniquement) -- sa suppression appartient à 2B,
--      après test de parité.
--
-- Un mode du catalogue n'est JAMAIS supprimé physiquement (référentiel
-- pour les commandes historiques) -- seulement rendu indisponible aux
-- nouveaux établissements (is_available_for_new_establishments).
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Contrôle préalable (anti-dérive).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'service_mode'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: orders.service_mode introuvable — migration LOT 2A annulée. Prérequis : migration-orders.sql doit déjà être appliqué.';
  end if;
  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'sale_mode_catalog'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.sale_mode_catalog existe déjà — migration LOT 2A annulée pour éviter une double application.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_identity_arguments(p.oid) not like '%p_slug%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order existante a une signature inattendue — migration LOT 2A annulée. Examiner manuellement.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------
-- 2z. Corrige L2A-02 (contre-audit Work) : room_number VALIDÉ mais
-- JAMAIS PERSISTÉ dans la version précédente. Colonne dédiée, même
-- patron exact que table_number (nullable, alimentée uniquement pour
-- le mode concerné) -- pas de duplication d'un champ déjà audité,
-- aucune colonne existante appropriée trouvée après inspection du
-- schéma (confirmé : aucune colonne "room"/"chambre" n'existe).
-- ------------------------------------------------------------

alter table public.orders
  add column if not exists room_number text check (room_number is null or length(room_number) <= 20);

comment on column public.orders.room_number is
  'LOT 2A -- numéro de chambre pour le mode room_service, alimenté par create_order. NULL pour tout autre mode.';

-- ------------------------------------------------------------
-- 2a. sale_mode_catalog -- donnée de référence, jamais supprimée
-- physiquement (référentiel pour les commandes historiques). Ajouter
-- un mode futur = une ligne insérée, aucune migration structurelle.
-- ------------------------------------------------------------

create table public.sale_mode_catalog (
  code                                  text primary key,
  category                              text not null check (category in ('dine_in', 'pickup', 'delivery')),
  label                                 text not null,
  display_order                         integer not null default 0,
  is_available_for_new_establishments   boolean not null default true
);

comment on table public.sale_mode_catalog is
  'LOT 2A — catalogue extensible des modes de vente Scanym (donnée de référence, pas un CHECK codé en dur). Un mode n''est JAMAIS supprimé physiquement : is_available_for_new_establishments=false le retire des nouveaux établissements tout en le conservant comme référentiel pour les commandes historiques.';

insert into public.sale_mode_catalog (code, category, label, display_order) values
  ('table',        'dine_in',  'Sur place / Table',  1),
  ('pickup',       'pickup',   'Retrait',             2),
  ('click_collect','pickup',   'Click & Collect',     3),
  ('room_service', 'dine_in',  'Chambre / Room Service', 4),
  ('delivery',     'delivery', 'Livraison',           5);

alter table public.sale_mode_catalog enable row level security;

create policy "sale_mode_catalog_select_all"
on public.sale_mode_catalog for select
to anon, authenticated
using (true);

grant select on public.sale_mode_catalog to anon, authenticated;
revoke insert, update, delete on public.sale_mode_catalog from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2b. restaurant_sale_modes -- configuration par établissement.
-- Propriétés communes à TOUS les modes : colonnes typées (jamais du
-- JSONB) -- enabled, provider, pricing_mode, display_order, texte,
-- délai. `config` JSONB résiduel : UNIQUEMENT ce qui est réellement
-- spécifique à certains modes (zones de livraison locale, créneaux de
-- retrait...), jamais une propriété commune.
--
-- Corrige garde-fou CIO #2 : provider/pricing_mode contraints par
-- CHECK -- vocabulaire technique stable et interne, distinct du
-- catalogue de modes (qui doit rester extensible sans CHECK).
-- ------------------------------------------------------------

create table public.restaurant_sale_modes (
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  mode_code       text not null references public.sale_mode_catalog(code),
  enabled         boolean not null default true,
  display_order   integer not null default 0,
  provider        text not null default 'internal'
                  check (provider in ('internal', 'stuart', 'chronofresh', 'other_external')),
  pricing_mode    text not null default 'free'
                  check (pricing_mode in ('free', 'fixed', 'free_above_threshold', 'external_quote')),
  fixed_fee       numeric(10,2) check (fixed_fee is null or fixed_fee >= 0),
  free_threshold  numeric(10,2) check (free_threshold is null or free_threshold >= 0),
  delay_value     integer check (delay_value is null or delay_value >= 0),
  delay_unit      text check (delay_unit is null or delay_unit in ('minutes', 'hours')),
  customer_text   text check (customer_text is null or length(customer_text) <= 500),
  config          jsonb,
  primary key (restaurant_id, mode_code)
);

comment on table public.restaurant_sale_modes is
  'LOT 2A — modes de vente activés et configurés par établissement. Propriétés communes structurées (enabled, provider, pricing_mode, délai, texte) -- jamais dans config JSONB, réservé au réellement spécifique par mode (ex. zones de livraison locale).';

create index idx_restaurant_sale_modes_restaurant on public.restaurant_sale_modes(restaurant_id);

alter table public.restaurant_sale_modes enable row level security;

-- Corrige L2A1-01 (contre-audit Work, 2e tour) : "to public" (même
-- reproduisant le patron déjà en production sur restaurant_configs/
-- menu_categories) s'applique aussi aux sessions AUTHENTIFIÉES, pas
-- seulement anon -- un membre de l'établissement A pouvait donc lire
-- la configuration COMPLÈTE (y compris provider/pricing_mode internes)
-- de tout établissement B actif, violant le contrat "membre A ne lit
-- pas B". Cette table redevient STRICTEMENT privée par tenant :
-- AUCUNE lecture publique/anon directe, authenticated limité à
-- l'appartenance réelle, sans aucune exception "établissement actif".
-- La consultation publique (menu/checkout) passe désormais par une
-- PROJECTION dédiée et minimale (get_restaurant_public_sale_modes,
-- voir plus bas) -- jamais un accès direct à cette table pour un
-- visiteur non authentifié.
create policy "restaurant_sale_modes_select_member"
on public.restaurant_sale_modes for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = restaurant_sale_modes.restaurant_id
      and ru.user_id = auth.uid()
  )
);

grant select on public.restaurant_sale_modes to authenticated;
revoke insert, update, delete on public.restaurant_sale_modes from public, anon, authenticated;
revoke all on public.restaurant_sale_modes from anon;

-- ------------------------------------------------------------
-- 2c. sale_mode_field_requirements -- règle par défaut du CATALOGUE
-- (niveau mode, pas établissement). Remplace toute logique dispersée
-- "if mode === X" par une déclaration relationnelle simple,
-- interrogeable et validable génériquement côté serveur.
-- ------------------------------------------------------------

create table public.sale_mode_field_requirements (
  mode_code       text not null references public.sale_mode_catalog(code),
  field           text not null,
  requirement     text not null check (requirement in ('required', 'optional', 'one_of')),
  one_of_group    text,
  display_order   integer not null default 0,
  primary key (mode_code, field),
  -- Corrige L2A1-02 (contre-audit Work) : une règle one_of SANS groupe
  -- (NULL, vide ou uniquement des espaces) est ignorée silencieusement
  -- par create_order -- désactivant de fait la validation sans qu'aucune
  -- erreur ne le signale à l'écriture. Inversement, required/optional
  -- ne doivent jamais porter un groupe (qui n'aurait aucun sens et
  -- serait tout aussi silencieusement ignoré).
  constraint sale_mode_field_requirements_one_of_group_check check (
    (requirement = 'one_of' and one_of_group is not null and btrim(one_of_group) <> '')
    or (requirement in ('required', 'optional') and one_of_group is null)
  )
);

comment on table public.sale_mode_field_requirements is
  'LOT 2A — champs client requis PAR DÉFAUT pour un mode (règle du catalogue). one_of_group regroupe des champs alternatifs (ex. phone/email pour Click & Collect : au moins l''un des deux). Surchargeable par établissement via restaurant_sale_mode_field_requirements, uniquement si nécessaire (voir cette table).';

-- Règles par défaut, alignées sur la mission (section 18) :
insert into public.sale_mode_field_requirements (mode_code, field, requirement, one_of_group, display_order) values
  ('table', 'table_number', 'required', null, 1),

  ('pickup', 'customer_name', 'required', null, 1),
  ('pickup', 'phone', 'one_of', 'contact', 2),
  ('pickup', 'email', 'one_of', 'contact', 3),

  ('click_collect', 'customer_name', 'required', null, 1),
  ('click_collect', 'phone', 'one_of', 'contact', 2),
  ('click_collect', 'email', 'one_of', 'contact', 3),

  ('room_service', 'room_number', 'required', null, 1),
  ('room_service', 'customer_name', 'required', null, 2),

  ('delivery', 'customer_name', 'required', null, 1),
  ('delivery', 'delivery_address', 'required', null, 2),
  ('delivery', 'phone', 'required', null, 3),
  ('delivery', 'email', 'optional', null, 4);

alter table public.sale_mode_field_requirements enable row level security;

create policy "sale_mode_field_requirements_select_all"
on public.sale_mode_field_requirements for select
to anon, authenticated
using (true);

grant select on public.sale_mode_field_requirements to anon, authenticated;
revoke insert, update, delete on public.sale_mode_field_requirements from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2c-bis. restaurant_sale_mode_field_requirements -- SURCHARGE PAR
-- ÉTABLISSEMENT, nécessité réelle démontrée par audit direct (garde-
-- fou CIO #3, PAS spéculatif) :
--   - illico-presto : pickup = nom SEUL (pas de contact requis) ;
--   - sanaa-cookies : pickup = nom+téléphone+email TOUS obligatoires
--     (pas un one_of) ; livraison = email AUSSI obligatoire (le
--     catalogue le laisse optionnel par défaut).
-- Même forme que la table catalogue, jamais un mécanisme parallèle.
-- Une ligne présente ICI remplace ENTIÈREMENT la règle catalogue pour
-- ce champ précis, pour cet établissement précis -- absence de ligne
-- = repli sur la règle catalogue, jamais un mélange partiel ambigu.
-- ------------------------------------------------------------

create table public.restaurant_sale_mode_field_requirements (
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  mode_code       text not null references public.sale_mode_catalog(code),
  field           text not null,
  requirement     text not null check (requirement in ('required', 'optional', 'one_of')),
  one_of_group    text,
  display_order   integer not null default 0,
  primary key (restaurant_id, mode_code, field),
  -- Corrige L2A1-02 : même contrainte que sale_mode_field_requirements,
  -- appliquée aux deux tables de règles (jamais une seule).
  constraint restaurant_sale_mode_field_req_one_of_group_check check (
    (requirement = 'one_of' and one_of_group is not null and btrim(one_of_group) <> '')
    or (requirement in ('required', 'optional') and one_of_group is null)
  )
);

comment on table public.restaurant_sale_mode_field_requirements is
  'LOT 2A — surcharge PAR ÉTABLISSEMENT des exigences de champs client, nécessité démontrée par audit (illico-presto, sanaa-cookies). Absence de ligne pour un (restaurant_id, mode_code) donné = repli intégral sur sale_mode_field_requirements (catalogue). Ne pas ajouter de nouvelles surcharges sans nécessité métier réelle démontrée (garde-fou CIO).';

alter table public.restaurant_sale_mode_field_requirements enable row level security;

-- Corrige L2A1-01 (même correctif que restaurant_sale_modes juste
-- au-dessus) : cette table redevient strictement privée par tenant --
-- aucune lecture publique/anon directe.
create policy "restaurant_sale_mode_field_requirements_select_member"
on public.restaurant_sale_mode_field_requirements for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = restaurant_sale_mode_field_requirements.restaurant_id
      and ru.user_id = auth.uid()
  )
);

grant select on public.restaurant_sale_mode_field_requirements to authenticated;
revoke insert, update, delete on public.restaurant_sale_mode_field_requirements from public, anon, authenticated;
revoke all on public.restaurant_sale_mode_field_requirements from anon;

-- ------------------------------------------------------------
-- 2c-ter. Corrige L2A1-01 (contre-audit Work, 2e tour) : projection
-- PUBLIQUE minimale pour le menu/checkout public, distincte des
-- tables tenant privées ci-dessus. Patron réutilisé de l'existant déjà
-- audité (get_restaurant_active_languages, LOT 1A) : RPC
-- SECURITY DEFINER retournant une projection contrôlée, jamais un accès
-- direct à la table. Exclut explicitement provider (info interne),
-- config JSONB brut (zones de livraison internes) -- expose
-- uniquement ce dont un client a besoin pour comprendre/choisir un
-- mode et construire le formulaire (texte, délai, tarif visible,
-- champs requis). Filtrée par is_active=true AND status='active',
-- comme toute lecture publique déjà en place (restaurant_configs,
-- menu_categories).
--
-- effective_sale_mode_field_requirements() : fonction interne
-- partagée, fusionnant surcharge établissement + catalogue (même
-- logique EXACTE que create_order, extraite ici en un point unique
-- pour n'être écrite qu'UNE SEULE FOIS -- réutilisée par create_order
-- ET par la projection publique, renforçant encore le principe
-- "résolveur centralisé" de L2A-04).
-- ------------------------------------------------------------

create function public.effective_sale_mode_field_requirements(
  p_restaurant_id uuid, p_mode_code text
)
returns table (field text, requirement text, one_of_group text)
language sql
stable
security definer
set search_path = ''
as $$
  select field, requirement, one_of_group from public.restaurant_sale_mode_field_requirements
  where restaurant_id = p_restaurant_id and mode_code = p_mode_code
  union all
  select field, requirement, one_of_group from public.sale_mode_field_requirements c
  where c.mode_code = p_mode_code
    and not exists (
      select 1 from public.restaurant_sale_mode_field_requirements o
      where o.restaurant_id = p_restaurant_id and o.mode_code = p_mode_code and o.field = c.field
    );
$$;

-- Corrige L2A2-01 (contre-audit Work, 3e tour) : cette fonction
-- SECURITY DEFINER exécutable par authenticated permettait à
-- N'IMPORTE QUEL utilisateur authentifié (membre ou non d'aucun
-- établissement) de l'appeler DIRECTEMENT avec le restaurant_id de
-- son choix, contournant entièrement la RLS des tables tenant --
-- une porte dérobée réelle, indépendante de toute vérification
-- d'appartenance. Redevient STRICTEMENT interne : aucun rôle
-- (public, anon, authenticated) n'a plus le droit d'EXECUTE.
-- Seules les RPC contrôlées (create_order, get_restaurant_public_field_requirements)
-- peuvent l'invoquer, APRÈS avoir elles-mêmes vérifié l'autorisation
-- nécessaire (appartenance réelle pour create_order, établissement
-- actif + mode activé pour la projection publique -- voir L2A2-02
-- ci-dessous). Aucun auth.uid() ajouté à l'intérieur du helper lui-même :
-- l'architecture ne l'exige pas, la vérification appartient aux
-- appelants contrôlés, jamais dupliquée ici.
revoke all on function public.effective_sale_mode_field_requirements(uuid, text) from public, anon, authenticated;

create function public.get_restaurant_public_sale_modes(p_restaurant_id uuid)
returns table (
  mode_code      text,
  customer_text  text,
  pricing_mode   text,
  fixed_fee      numeric,
  free_threshold numeric,
  delay_value    integer,
  delay_unit     text
)
language sql
stable
security definer
set search_path = ''
as $$
  select rsm.mode_code, rsm.customer_text, rsm.pricing_mode,
         rsm.fixed_fee, rsm.free_threshold, rsm.delay_value, rsm.delay_unit
  from public.restaurant_sale_modes rsm
  join public.restaurants r on r.id = rsm.restaurant_id
  where rsm.restaurant_id = p_restaurant_id
    and rsm.enabled = true
    and r.is_active = true and r.status = 'active'
  order by rsm.display_order;
$$;

comment on function public.get_restaurant_public_sale_modes(uuid) is
  'LOT 2A.2 -- projection publique minimale des modes de vente actifs (menu/checkout). N''expose jamais provider ni config JSONB (info interne) -- corrige L2A1-01.';

revoke all on function public.get_restaurant_public_sale_modes(uuid) from public;
grant execute on function public.get_restaurant_public_sale_modes(uuid) to anon, authenticated;

create function public.get_restaurant_public_field_requirements(p_restaurant_id uuid, p_mode_code text)
returns table (field text, requirement text, one_of_group text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.field, e.requirement, e.one_of_group
  from public.effective_sale_mode_field_requirements(p_restaurant_id, p_mode_code) e
  where exists (
    select 1 from public.restaurants r
    where r.id = p_restaurant_id and r.is_active = true and r.status = 'active'
  )
  -- Corrige L2A2-02 (contre-audit Work, 3e tour) : vérifie désormais
  -- EXPLICITEMENT que le mode demandé est réellement activé pour CET
  -- établissement (restaurant_sale_modes.enabled = true) -- sans cette
  -- vérification, la projection publique retournait les règles du
  -- CATALOGUE pour n'importe quel mode, même désactivé, jamais
  -- configuré, ou obsolète pour cet établissement précis : une
  -- configuration exposée publiquement mais dénuée de sens côté
  -- client (aucun formulaire de checkout ne devrait jamais se
  -- construire pour un mode que l'établissement n'a pas choisi).
  and exists (
    select 1 from public.restaurant_sale_modes rsm
    where rsm.restaurant_id = p_restaurant_id
      and rsm.mode_code = p_mode_code
      and rsm.enabled = true
  );
$$;

comment on function public.get_restaurant_public_field_requirements(uuid, text) is
  'LOT 2A.2 -- champs requis effectifs (surcharge + catalogue déjà fusionnés) pour construire le formulaire de checkout public. Corrige L2A1-01.';

revoke all on function public.get_restaurant_public_field_requirements(uuid, text) from public;
grant execute on function public.get_restaurant_public_field_requirements(uuid, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 2d. order_delivery_address -- table 1:1 dédiée, structurée. N'existe
-- QUE pour les commandes en mode livraison (jamais de colonnes NULL
-- pour tous les autres modes sur orders elle-même). orders.delivery_address
-- (texte) RESTE INCHANGÉE : seule source pour les commandes
-- historiques, alimentée EN PARALLÈLE (même transaction) pour toute
-- nouvelle commande -- jamais deux sources concurrentes désynchronisées.
-- ------------------------------------------------------------

create table public.order_delivery_address (
  order_id           uuid primary key references public.orders(id) on delete cascade,
  formatted_address  text not null check (length(formatted_address) <= 300),
  house_number       text check (house_number is null or length(house_number) <= 20),
  street             text check (street is null or length(street) <= 200),
  complement         text check (complement is null or length(complement) <= 200),
  postal_code        text check (postal_code is null or length(postal_code) <= 10),
  city               text check (city is null or length(city) <= 120),
  country            text not null default 'FR' check (length(country) <= 60),
  latitude           numeric(9,6),
  longitude          numeric(9,6)
);

comment on table public.order_delivery_address is
  'LOT 2A — adresse de livraison structurée, table 1:1 (n''existe que pour les commandes en mode livraison). orders.delivery_address (texte) reste la source pour l''historique -- les deux sont alimentées ensemble à la création pour toute nouvelle commande, jamais désynchronisées.';

alter table public.order_delivery_address enable row level security;

-- Même posture que orders elle-même (RLS déjà en place sur orders,
-- reproduite ici à l'identique -- lecture réservée aux membres de
-- l'établissement concerné, écriture uniquement via create_order
-- SECURITY DEFINER).
create policy "order_delivery_address_select_staff"
on public.order_delivery_address for select
to authenticated
using (
  exists (
    select 1 from public.orders o
    join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id
    where o.id = order_delivery_address.order_id and ru.user_id = auth.uid()
  )
);

-- Corrige L2A-05 (contre-audit Work) : la RLS seule ne suffit pas --
-- sans GRANT explicite, authenticated ne peut lire AUCUNE ligne même
-- si la policy l'autoriserait (patron déjà établi partout ailleurs
-- dans ce projet : RLS restreint QUELLES lignes, GRANT autorise
-- l'opération elle-même). Portée minimale : authenticated seulement,
-- jamais anon (l'adresse de livraison n'est jamais publique).
grant select on public.order_delivery_address to authenticated;
revoke insert, update, delete on public.order_delivery_address from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2e. Backfill des 4 cas exacts (audité, pas supposé) :
--   1. illico-presto  : table+pickup, pickup surchargé (nom seul)
--   2. sanaa-cookies  : pickup+delivery, tous deux surchargés
--   3. le-sirocco     : table seul, aucune surcharge (comportement
--      par défaut du catalogue déjà correct pour ce cas)
--   4. tout autre établissement : table seul (reproduit DEFAULT_SETTINGS)
-- ------------------------------------------------------------

do $$
declare
  r record;
begin
  -- Cas 4 (défaut) : TOUS les établissements reçoivent d'abord 'table'
  -- actif -- reproduit exactement DEFAULT_SETTINGS = { allowedServiceModes: ["table"] }.
  -- Les 3 cas spécifiques (1/2/3) sont appliqués PAR-DESSUS ensuite.
  insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order)
  select id, 'table', true, 1 from public.restaurants
  on conflict (restaurant_id, mode_code) do nothing;

  -- Cas 1 : illico-presto -- table + pickup (allowedServiceModes: ["table","pickup"])
  for r in select id from public.restaurants where slug = 'illico-presto' loop
    insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order)
    values (r.id, 'pickup', true, 2)
    on conflict (restaurant_id, mode_code) do nothing;

    -- Surcharge : pickup = nom seul. Les règles catalogue (phone/email
    -- en one_of) s'appliquent par défaut à tout champ NON surchargé --
    -- il faut donc explicitement neutraliser phone/email en 'optional'
    -- pour annuler réellement l'exigence de contact catalogue, sinon
    -- le repli catalogue continuerait à exiger l'un des deux (bug
    -- réel trouvé et corrigé pendant le test empirique de ce backfill).
    insert into public.restaurant_sale_mode_field_requirements (restaurant_id, mode_code, field, requirement, display_order) values
      (r.id, 'pickup', 'customer_name', 'required', 1),
      (r.id, 'pickup', 'phone', 'optional', 2),
      (r.id, 'pickup', 'email', 'optional', 3)
    on conflict (restaurant_id, mode_code, field) do nothing;
  end loop;

  -- Cas 2 : sanaa-cookies -- pickup + delivery (allowedServiceModes: ["pickup","delivery"])
  -- ⚠️ sanaa-cookies n'a PAS 'table' dans son allowedServiceModes
  -- d'origine -- le cas 4 (défaut) l'a inséré à tort, retiré ici pour
  -- fidélité exacte au comportement historique.
  for r in select id from public.restaurants where slug = 'sanaa-cookies' loop
    delete from public.restaurant_sale_modes where restaurant_id = r.id and mode_code = 'table';

    insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order, config) values
      (r.id, 'pickup', true, 1, null),
      (r.id, 'delivery', true, 2, jsonb_build_object(
        'delivery_zone_prefixes', array['75','77','78','91','92','93','94','95'],
        'delivery_min_items', 10,
        'delivery_area_label', 'Île-de-France'
      ))
    on conflict (restaurant_id, mode_code) do nothing;

    -- Surcharges audités : pickup tout obligatoire (pas un one_of) ;
    -- delivery avec email AUSSI obligatoire (catalogue = optional).
    insert into public.restaurant_sale_mode_field_requirements (restaurant_id, mode_code, field, requirement, display_order) values
      (r.id, 'pickup', 'customer_name', 'required', 1),
      (r.id, 'pickup', 'phone', 'required', 2),
      (r.id, 'pickup', 'email', 'required', 3),
      (r.id, 'delivery', 'customer_name', 'required', 1),
      (r.id, 'delivery', 'delivery_address', 'required', 2),
      (r.id, 'delivery', 'phone', 'required', 3),
      (r.id, 'delivery', 'email', 'required', 4)
    on conflict (restaurant_id, mode_code, field) do nothing;
  end loop;

  -- Cas 3 : le-sirocco -- table seul, AUCUNE surcharge (comportement
  -- par défaut déjà correct : allowedServiceModes: ["table"], pas de
  -- requiredCustomerFields défini pour cet établissement). Déjà
  -- couvert par le cas 4 (défaut) -- rien à faire de plus ici,
  -- documenté explicitement pour que ce cas ne soit jamais oublié
  -- lors d'une future revue.
end $$;

-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 2f-pre. orders_mode_fields -- contrainte CHECK HISTORIQUE, figée
-- sur 'table'/'pickup'/'delivery' uniquement (l'anti-pattern exact
-- que ce lot élimine, découvert non pas par audit préalable mais par
-- ÉCHEC RÉEL en test empirique : toute commande click_collect/
-- room_service violait structurellement cette contrainte, aucune des
-- 3 branches OR ne pouvant jamais être vraie pour un mode absent de
-- son texte). Retirée : la validation des champs requis est
-- désormais centralisée dans create_order (exécutée AVANT l'insertion,
-- lue depuis sale_mode_field_requirements/restaurant_sale_mode_field_requirements),
-- jamais une seconde source de vérité dupliquée au niveau contrainte.
-- Confirmé sans danger : orders n'a AUCUN GRANT INSERT direct pour
-- anon/authenticated (vérifié : seul SELECT accordé) -- create_order
-- (SECURITY DEFINER) reste l'unique chemin d'écriture, donc l'unique
-- point de validation nécessaire.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 2f-pre2. orders_service_mode_check -- SECOND CHECK historique
-- figé, distinct de orders_mode_fields, découvert par le même échec
-- empirique (click_collect bloqué). Remplacé par une FK vers
-- sale_mode_catalog : jamais de fragilité historique possible,
-- puisque ce catalogue n'autorise AUCUNE suppression physique de code
-- (garde-fou CIO #4) -- une commande passée restera toujours
-- résolvable, quel que soit son ancienneté.
-- ------------------------------------------------------------

alter table public.orders drop constraint if exists orders_service_mode_check;
alter table public.orders
  add constraint orders_service_mode_fkey foreign key (service_mode) references public.sale_mode_catalog(code);

alter table public.orders drop constraint if exists orders_mode_fields;

-- ------------------------------------------------------------
-- 2f. create_order redéfinie -- CORRIGÉ après contre-audit Work
-- (L2A-01) : ma version précédente avait été construite par-dessus
-- migration-orders-lang.sql, une baseline DÉJÀ OBSOLÈTE au commit
-- 7b4fdcf... -- j'avais manqué DEUX redéfinitions ultérieures
-- (migration-v65-order-note.sql, PUIS
-- migration-lotd-establishment-creation.sql), cette dernière étant la
-- SEULE réellement active. Reconstruite ici depuis ce texte exact
-- (extraction programmatique, jamais retapée), avec édition
-- chirurgicale assertée pour chaque changement. AUCUNE régression :
--   - is_active = true AND status = 'active' PRÉSERVÉ (protection Lot D) ;
--   - rejet explicite SCANYM_ORDER_NOTE_TOO_LONG (>500) PRÉSERVÉ,
--     aucune troncature silencieuse (protection V65) ;
--   - btrim() avec le jeu de caractères exact (espace/tab/LF/CR/FF/VT)
--     PRÉSERVÉ à l'identique.
--
-- Signature réelle actuelle confirmée : 7 arguments (p_language).
-- DROP explicite de l'ancienne signature à 6 arguments par précaution.
-- ------------------------------------------------------------

drop function if exists public.create_order(text, text, jsonb, integer, jsonb, text);

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
)
returns table (order_id uuid, order_number bigint, public_token uuid, total numeric)
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
begin
  -- Corrigé après audit Work (Lot D) : status = 'active' exige
  -- explicitement le workflow owner finalisé, en plus de is_active
  -- (bascule manuelle historique). Un établissement onboarding,
  -- suspended ou inactive ne doit jamais pouvoir recevoir de
  -- commande, même en connaissant son slug exact.
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  -- Corrige LOT 2A : mode de service vérifié via restaurant_sale_modes
  -- (activé pour CET établissement), plus allowed_service_modes text[].
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

  -- Note générale (V65) : rejet explicite, aucune troncature.
  -- Une seule note globale ; il n'y a pas de note par ligne.
  --
  -- btrim(..., E' \t\n\r\f' || chr(11)) plutôt que trim(...) : jeu de
  -- caractères explicite (espace, tabulation, LF, CR, FF, VT),
  -- STRICTEMENT identique à celui utilisé côté TypeScript dans
  -- lib/order-note.ts (fonction trimNoteEdges / EDGE_WHITESPACE).
  -- trim() natif de PostgreSQL ne retirerait que l'espace ASCII et
  -- laisserait tabulations/sauts de ligne en bordure — divergence
  -- volontairement évitée plutôt que présumée absente.
  --
  -- chr(11), pas \v : \v n'est PAS un échappement reconnu dans une
  -- chaîne E'...' de PostgreSQL (seuls \b \f \n \r \t le sont ; tout
  -- le reste est pris littéralement). E'\v' produirait la lettre "v",
  -- pas la tabulation verticale U+000B — vérifié empiriquement
  -- (ascii(E'\v') = 118). chr(11) produit le vrai caractère quel que
  -- soit le moteur. Un test statique interdit toute réapparition de
  -- \v dans cette chaîne (tests/v65-order-note.test.ts).
  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  -- Corrige LOT 2A (et L2A-04, contre-audit Work) : validation
  -- générique des champs requis, RÉSOLVEUR UNIQUE ET CENTRALISÉ
  -- (aucun champ mappé deux fois, aucun IF dispersé par mode). Les
  -- groupes one_of sont traités de façon totalement générique --
  -- AUCUN nom de groupe (ex. "contact") n'est codé en dur : la
  -- satisfaction d'un groupe est déterminée par agrégation SQL
  -- (bool_or) sur les valeurs déjà résolues, quel que soit le nom du
  -- groupe déclaré en base.
  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  -- Corrige L2A1-01/L2A-04 (contre-audit Work) : fusion surcharge +
  -- catalogue désormais lue via effective_sale_mode_field_requirements(),
  -- UNIQUE endroit où cette logique est écrite (réutilisée aussi par
  -- la projection publique get_restaurant_public_field_requirements)
  -- -- jamais deux copies de la même fusion.
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

  -- Zone de livraison locale : lue depuis restaurant_sale_modes.config
  -- (mode 'delivery'), plus delivery_zone_prefixes sur restaurant_configs.
  if p_service_mode = 'delivery' then
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

  -- Corrige LOT 2A : adresse structurée alimentée EN PARALLÈLE (même
  -- transaction) de orders.delivery_address, jamais désynchronisée.
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

  -- Corrige LOT 2A : minimum d'articles lu depuis
  -- restaurant_sale_modes.config, jamais deux sources concurrentes.
  declare
    v_delivery_min_items integer;
  begin
    select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
    from public.restaurant_sale_modes
    where restaurant_id = v_restaurant.id and mode_code = 'delivery';

    if p_service_mode = 'delivery' and v_qty_total < coalesce(v_delivery_min_items, 0) then
      raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
        v_delivery_min_items, v_qty_total;
    end if;
  end;

  update public.orders
  set subtotal = v_subtotal, total = v_subtotal
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal;
end $$;

-- Droits préservés par CREATE OR REPLACE FUNCTION à signature identique.
revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public, anon;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text) to authenticated, anon;




commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT (preuve automatisée réelle dans
-- supabase/tests/v82-lot2a-check.sh) :
--  ✓ backfill exact des 4 cas (illico-presto, sanaa-cookies,
--    le-sirocco, établissement par défaut)
--  ✓ Click & Collect : nom + téléphone accepté, nom + email accepté,
--    ni l'un ni l'autre refusé
--  ✓ illico-presto pickup : nom seul suffit (surcharge)
--  ✓ sanaa-cookies pickup : nom+téléphone+email tous obligatoires (surcharge)
--  ✓ sanaa-cookies delivery : email désormais obligatoire (surcharge)
--  ✗ livraison sans adresse refusée, sans téléphone refusée
--  ✓ room service avec numéro de chambre
--  ✗ mode non activé pour l'établissement refusé
--  ✗ cross-tenant impossible
-- ============================================================
