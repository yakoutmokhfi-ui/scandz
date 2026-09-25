-- =============================================================================
-- SCANYM — ONLINE WITHDRAWAL / RETRACTATION FOUNDATION v1
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO PROD.
-- =============================================================================
--
-- Ce lot pose la FONDATION de la rétractation en ligne :
--
--   1. `menu_items.withdrawal_eligible` -- classification OPÉRATIONNELLE
--      du produit par le MARCHAND (interne, jamais publique).
--   2. `order_items.withdrawal_eligible_at_order_time` -- instantané
--      IMMUABLE pris UNE SEULE FOIS à l'insertion de la ligne.
--   3. `withdrawal_requests` / `withdrawal_request_items` -- le modèle
--      durable de la DÉCLARATION de rétractation.
--   4. Deux RPC client, liées à la CAPACITÉ DE SUIVI existante
--      (order_id + capability_id + secret, jamais order_id seul).
--   5. `_scanym_has_online_withdrawal_primitives()` -- les primitives
--      de déclaration existent-elles RÉELLEMENT (jamais un littéral) ?
--   6. `_scanym_has_online_withdrawal_runtime()` -- la fonctionnalité
--      statutaire est-elle COMPLÈTE ? v1.1 : primitives ET canal
--      d'accusé de réception opérationnel (voir section H).
--
-- CE QUE CE LOT NE FAIT PAS, DÉLIBÉRÉMENT :
--   - il ne touche pas `orders.status` (la rétractation n'est PAS un
--     statut de commande : les sept statuts canoniques -- new, accepted,
--     preparing, ready, completed, rejected, cancelled -- sont inchangés) ;
--   - il ne réutilise pas `payment_status` ;
--   - il n'implémente AUCUN remboursement (hors périmètre) ;
--   - il n'invente AUCUNE date de réception/remise des biens : le dépôt
--     a établi qu'aucun horodatage de remise réelle au client n'existe
--     pour aucun mode de service (voir section H) ;
--   - il ne déduit JAMAIS l'éligibilité d'une catégorie, d'un nom, d'une
--     DLC/DDM, du régime marchand ou d'une IA : seul le marchand classe.
--
-- IDEMPOTENCE : le bloc de pré-vol ci-dessous échoue si une primitive
-- de ce lot existe déjà (anti-double-application), comme CATALOGUE /
-- SUBCATEGORIES BACKOFFICE v1.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. PRÉ-VOL — prérequis et anti-double-application (HORS transaction)
-- -----------------------------------------------------------------------------
do $$
begin
  -- Prérequis structurels.
  if to_regclass('public.menu_items') is null
     or to_regclass('public.order_items') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.restaurants') is null
     or to_regclass('public.order_tracking_capabilities') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: tables de base absentes (menu_items/order_items/orders/restaurants/order_tracking_capabilities) -- ONLINE WITHDRAWAL v1 annulé.';
  end if;

  -- CGV ENGINE v2.5 doit être appliqué (instantanés légaux de ligne +
  -- garde runtime que ce lot redéfinit).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'withdrawal_exempt_at_order_time'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: order_items.withdrawal_exempt_at_order_time absente -- CGV ENGINE v2.5 doit être appliqué avant ce lot, annulé.';
  end if;
  if to_regprocedure('public._scanym_has_online_withdrawal_runtime()') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: _scanym_has_online_withdrawal_runtime() absente -- CGV ENGINE v2.5 doit être appliqué avant ce lot, annulé.';
  end if;

  -- Les RPC catalogue étendues par ce lot doivent exister dans leur
  -- forme CATALOGUE / SUBCATEGORIES v1 (9 arguments), sinon une autre
  -- version est en place et ce lot ne doit pas l'écraser à l'aveugle.
  if to_regprocedure('public.create_product(uuid,text,text,numeric,text,numeric,integer,boolean,uuid)') is null
     or to_regprocedure('public.update_product(uuid,text,text,numeric,text,numeric,integer,boolean,uuid)') is null
     or to_regprocedure('public.get_merchant_catalogue(uuid,boolean)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_product/update_product/get_merchant_catalogue (forme SUBCATEGORIES v1) introuvables -- ONLINE WITHDRAWAL v1 annulé.';
  end if;

  -- Anti-double-application.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'withdrawal_eligible'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: menu_items.withdrawal_eligible existe déjà -- ONLINE WITHDRAWAL v1 annulé.';
  end if;
  if to_regclass('public.withdrawal_requests') is not null
     or to_regclass('public.withdrawal_request_items') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: withdrawal_requests/withdrawal_request_items existent déjà -- ONLINE WITHDRAWAL v1 annulé.';
  end if;
  if to_regprocedure('public._scanym_has_online_withdrawal_primitives()') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: _scanym_has_online_withdrawal_primitives() existe déjà -- ONLINE WITHDRAWAL v1 annulé.';
  end if;
end $$;

begin;

-- -----------------------------------------------------------------------------
-- B. ATTRIBUT PRODUIT — classification marchande, INTERNE
-- -----------------------------------------------------------------------------
alter table public.menu_items
  add column withdrawal_eligible boolean not null default false;

comment on column public.menu_items.withdrawal_eligible is
  'ONLINE WITHDRAWAL v1 — classification OPÉRATIONNELLE par le MARCHAND : ce produit est-il éligible au droit de rétractation ? Défaut false pour tout produit (existant ou nouveau) : l''éligibilité est une décision explicite du marchand, jamais déduite d''une catégorie, d''un nom, d''une DLC/DDM, du régime de rétractation marchand ni d''une IA. Attribut INTERNE : il n''est exposé ni par la carte publique, ni par les traductions publiques, ni par aucune réponse client -- seules les RPC marchandes (get_merchant_catalogue) et l''export/import XLSX marchand le voient.';

-- -----------------------------------------------------------------------------
-- C. INSTANTANÉ DE LIGNE DE COMMANDE — immuable, pris UNE SEULE FOIS
-- -----------------------------------------------------------------------------
alter table public.order_items
  add column withdrawal_eligible_at_order_time boolean;

comment on column public.order_items.withdrawal_eligible_at_order_time is
  'ONLINE WITHDRAWAL v1 — instantané IMMUABLE de menu_items.withdrawal_eligible au moment EXACT de la création de la ligne. NULL = ligne historique créée avant ce lot : l''absence de valeur n''est JAMAIS interprétée comme éligible (fail-closed), et aucun remplissage rétroactif deviné n''est fait. Après insertion, cette valeur n''est jamais recalculée depuis menu_items : changer le produit de Oui à Non (ou l''inverse) ne modifie donc aucune commande déjà passée.';

-- v1.1 — le vocabulaire des bases légales de ligne (CGV ENGINE v2.5)
-- accueille la valeur propre au régime MIXTE dont le gabarit accepté
-- ne porte aucune citation identifiable. La contrainte est retrouvée
-- par son DÉFINITION (jamais par un nom auto-généré supposé), puis
-- remplacée par une contrainte NOMMÉE -- la liste reste FERMÉE : une
-- valeur hors vocabulaire est toujours refusée par la base.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cls on cls.oid = con.conrelid
  join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
  where nsp.nspname = 'public' and cls.relname = 'order_items' and con.contype = 'c'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%withdrawal_legal_basis_at_order_time%';

  if v_conname is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte de vocabulaire de order_items.withdrawal_legal_basis_at_order_time introuvable -- CGV ENGINE v2.5 attendu, annulé.';
  end if;

  execute pg_catalog.format('alter table public.order_items drop constraint %I', v_conname);
end $$;

alter table public.order_items
  add constraint order_items_withdrawal_legal_basis_at_order_time_check
  check (withdrawal_legal_basis_at_order_time is null or withdrawal_legal_basis_at_order_time in (
    'L221-28-4', 'L221-28-3', 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION', 'STANDARD_14_DAYS_ELIGIBLE',
    -- v1.1 — régime MIXTE : gabarit accepté sans citation identifiable.
    'MIXED_UNSPECIFIED_CITATION'
  ));

-- Le snapshot est pris par un déclencheur BEFORE INSERT plutôt qu''en
-- redéclarant create_order (400 lignes) : il s'applique à TOUT chemin
-- d'insertion d'une ligne de commande, il s'exécute dans la MÊME
-- transaction que create_order, et il ne peut pas diverger d'une
-- future redéfinition de create_order. BEFORE INSERT uniquement : rien
-- ne recalcule la valeur ensuite.
create function public.snapshot_order_item_withdrawal_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mixed_clause text;
begin
  if new.withdrawal_eligible_at_order_time is null and new.menu_item_id is not null then
    select mi.withdrawal_eligible into new.withdrawal_eligible_at_order_time
    from public.menu_items mi
    where mi.id = new.menu_item_id;
  end if;

  -- ---------------------------------------------------------------
  -- v1.1 — RÉGIME MIXTE : instantané légal PAR LIGNE
  -- ---------------------------------------------------------------
  -- `create_order` (CGV ENGINE v2.5) calcule la base légale à partir
  -- du régime du MARCHAND seul : EXEMPT_PERISHABLE -> la citation du
  -- gabarit accepté, STANDARD_14_DAYS -> éligible, tout autre régime
  -- (donc MIXED) -> NULL, et `withdrawal_exempt_at_order_time` y vaut
  -- `regime = 'EXEMPT_PERISHABLE'`, soit `false` pour un marchand
  -- MIXTE -- ce qui reviendrait à affirmer que TOUTES ses lignes sont
  -- rétractables. En régime MIXTE, la vérité est PAR LIGNE, et elle
  -- est déjà là : l'instantané d'éligibilité pris juste au-dessus.
  --
  -- La base légale d'une ligne EXCLUE n'est pas devinée : elle est
  -- lue dans la clause MIXED du gabarit RÉELLEMENT accepté par ce
  -- client (order_cgv_acceptance -> merchant_cgv_version ->
  -- cgv_template), exactement comme create_order le fait pour
  -- EXEMPT_PERISHABLE. Un gabarit qui ne cite ni 4° ni 3° donne
  -- 'MIXED_UNSPECIFIED_CITATION' -- jamais une citation inventée.
  --
  -- Une ligne dont l'éligibilité est inconnue (NULL : produit absent
  -- du catalogue) ne reçoit AUCUNE de ces valeurs : ne rien affirmer
  -- vaut mieux qu'affirmer faux.
  if new.merchant_withdrawal_regime_at_order_time = 'MIXED'
     and new.withdrawal_legal_basis_at_order_time is null
     and new.withdrawal_eligible_at_order_time is not null
  then
    if new.withdrawal_eligible_at_order_time then
      new.withdrawal_exempt_at_order_time := false;
      new.withdrawal_legal_basis_at_order_time := 'STANDARD_14_DAYS_ELIGIBLE';
    else
      select ct.controlled_sections->'withdrawal_clauses'->>'MIXED'
        into v_mixed_clause
      from public.order_cgv_acceptance oca
      join public.merchant_cgv_version mcv on mcv.id = oca.cgv_version_id
      join public.cgv_template ct on ct.id = mcv.template_id
      where oca.order_id = new.order_id;

      new.withdrawal_exempt_at_order_time := true;
      -- Deux formulations sont reconnues, et deux seulement : la forme
      -- COMPACTE employée par les clauses EXEMPT_PERISHABLE du dépôt
      -- (« L221-28 4° »), et la forme DÉVELOPPÉE employée par la clause
      -- MIXTE (« 4° de l'article L221-28 »). Toute autre rédaction
      -- donne 'MIXED_UNSPECIFIED_CITATION' : on préfère dire « je ne
      -- sais pas » plutôt que de déduire une citation d'un texte qui ne
      -- la porte pas explicitement.
      if v_mixed_clause ilike '%L221-28 4°%'
         or v_mixed_clause ilike '%4° de l''article L221-28%' then
        new.withdrawal_legal_basis_at_order_time := 'L221-28-4';
      elsif v_mixed_clause ilike '%L221-28 3°%'
            or v_mixed_clause ilike '%3° de l''article L221-28%' then
        new.withdrawal_legal_basis_at_order_time := 'L221-28-3';
      else
        new.withdrawal_legal_basis_at_order_time := 'MIXED_UNSPECIFIED_CITATION';
      end if;
    end if;
  end if;

  return new;
end $$;

comment on function public.snapshot_order_item_withdrawal_eligibility() is
  'ONLINE WITHDRAWAL v1 — BEFORE INSERT sur order_items : copie menu_items.withdrawal_eligible dans l''instantané de ligne, une seule fois, à l''insertion. Ne s''exécute jamais sur UPDATE : un instantané pris est définitif. Une ligne sans menu_item_id (produit supprimé du catalogue) garde NULL, jamais une valeur devinée. v1.1 — en régime MIXTE, renseigne aussi la base légale et l''exclusion PAR LIGNE : éligible -> STANDARD_14_DAYS_ELIGIBLE, exclue -> la citation portée par la clause MIXED du gabarit RÉELLEMENT accepté (L221-28-4 / L221-28-3, à défaut MIXED_UNSPECIFIED_CITATION). Une éligibilité inconnue (NULL) ne produit aucune affirmation.';

create trigger trg_order_items_snapshot_withdrawal_eligibility
  before insert on public.order_items
  for each row execute function public.snapshot_order_item_withdrawal_eligibility();

-- -----------------------------------------------------------------------------
-- D. MODÈLE DE DONNÉES — déclaration de rétractation
-- -----------------------------------------------------------------------------
-- MODÈLE RETENU : une commande peut porter PLUSIEURS demandes (le
-- consommateur peut se rétracter en deux fois sur deux produits
-- différents, ou compléter une rétractation partielle). L'invariant
-- protégé n'est donc pas "une demande par commande" mais :
--
--     somme des quantités demandées (demandes non annulées)
--     <= quantité commandée de la ligne
--
-- vérifié sous verrou dans submit_withdrawal_request_by_capability.
--
-- restaurant_id est stocké ET contraint à correspondre à orders.restaurant_id
-- (contrainte d'intégrité ci-dessous) : l'isolation locataire ne dépend
-- donc pas d'une jointure correcte côté appelant.
create table public.withdrawal_requests (
  id                        uuid primary key default pg_catalog.gen_random_uuid(),
  restaurant_id             uuid not null references public.restaurants(id) on delete cascade,
  order_id                  uuid not null references public.orders(id) on delete cascade,
  requested_at              timestamptz not null default pg_catalog.now(),

  -- Statut de la DEMANDE (jamais un statut de commande).
  status                    text not null default 'recorded'
                            check (status in ('recorded', 'cancelled')),

  -- D.221-5 : le consommateur fournit ou confirme ses nom et prénom.
  customer_last_name        text not null check (pg_catalog.btrim(customer_last_name) <> '' and pg_catalog.length(customer_last_name) <= 120),
  customer_first_name       text not null check (pg_catalog.btrim(customer_first_name) <> '' and pg_catalog.length(customer_first_name) <= 120),

  -- D.221-5 : moyen électronique CHOISI/CONFIRMÉ par le consommateur
  -- pour recevoir l'accusé de réception.
  acknowledgement_channel   text not null check (acknowledgement_channel in ('email')),
  acknowledgement_address   text not null check (pg_catalog.btrim(acknowledgement_address) <> '' and pg_catalog.length(acknowledgement_address) <= 320),

  -- État RÉEL de l'accusé de réception. 'sent' n'est JAMAIS écrit par
  -- l'enregistrement de la demande : il ne peut l'être que par un
  -- prestataire d'envoi confirmant l'envoi. 'unavailable_no_channel'
  -- est l'état honnête quand aucun canal d'envoi réel n'est opérationnel.
  acknowledgement_status    text not null default 'pending'
                            check (acknowledgement_status in ('pending', 'unavailable_no_channel', 'sent', 'failed')),
  acknowledgement_sent_at   timestamptz,
  acknowledgement_last_error text,

  -- Contenu DURABLE de la déclaration (D.221-5 : l'accusé mentionne le
  -- contenu de la déclaration, sa date et son heure). Figé à l'écriture,
  -- jamais recalculé depuis le catalogue courant.
  declaration_snapshot      jsonb not null,

  -- Liaison à la capacité de suivi qui a émis la demande (traçabilité
  -- de la possession, jamais une identité déclarative côté client).
  tracking_capability_id    uuid not null references public.order_tracking_capabilities(id) on delete restrict,

  -- Idempotence/rejeu : deux envois du même formulaire ne créent
  -- qu'une seule déclaration.
  client_request_id         uuid not null,

  created_at                timestamptz not null default pg_catalog.now(),

  constraint withdrawal_requests_ack_sent_requires_timestamp
    check ((acknowledgement_status = 'sent') = (acknowledgement_sent_at is not null)),
  constraint withdrawal_requests_client_request_unique
    unique (order_id, client_request_id)
);

create index idx_withdrawal_requests_order on public.withdrawal_requests(order_id);
create index idx_withdrawal_requests_restaurant on public.withdrawal_requests(restaurant_id, requested_at desc);

comment on table public.withdrawal_requests is
  'ONLINE WITHDRAWAL v1 — déclaration de rétractation du consommateur (art. L221-21 / D.221-5). N''altère JAMAIS orders.status ni payment_status : la rétractation est un évènement juridique distinct du cycle de vie de la commande. Aucun remboursement n''est géré ici (hors périmètre). Écriture exclusivement via submit_withdrawal_request_by_capability (SECURITY DEFINER, liée à la capacité de suivi) -- aucun rôle client n''a de privilège direct sur cette table.';

create table public.withdrawal_request_items (
  id                     uuid primary key default pg_catalog.gen_random_uuid(),
  withdrawal_request_id  uuid not null references public.withdrawal_requests(id) on delete cascade,
  order_item_id          uuid not null references public.order_items(id) on delete restrict,
  quantity               integer not null check (quantity > 0),
  created_at             timestamptz not null default pg_catalog.now(),
  constraint withdrawal_request_items_unique_line unique (withdrawal_request_id, order_item_id)
);

create index idx_withdrawal_request_items_order_item on public.withdrawal_request_items(order_item_id);

comment on table public.withdrawal_request_items is
  'ONLINE WITHDRAWAL v1 — lignes visées par une déclaration de rétractation, avec la quantité demandée (rétractation partielle possible). La somme des quantités demandées pour une même ligne, toutes demandes non annulées confondues, ne peut jamais dépasser la quantité commandée (vérifiée sous verrou dans la RPC d''écriture).';

alter table public.withdrawal_requests enable row level security;
alter table public.withdrawal_request_items enable row level security;

revoke all on table public.withdrawal_requests from public, anon, authenticated;
revoke all on table public.withdrawal_request_items from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E. RPC CLIENT — lecture des lignes éligibles, liée à la CAPACITÉ
-- -----------------------------------------------------------------------------
-- Même liaison que get_order_tracking_by_capability (CUSTOMER TRACKING
-- v3.1) : capability_id + order_id + sha256(secret), ensemble. Toute
-- entrée incorrecte produit un ensemble VIDE, de façon identique --
-- aucune information observable sur l'existence de la commande.
create function public.get_withdrawal_options_by_capability(
  p_order_id      uuid,
  p_capability_id uuid,
  p_secret        text
)
returns table (
  bound_order_id        uuid,
  order_number          bigint,
  order_item_id         uuid,
  item_name             text,
  option_name           text,
  ordered_quantity      integer,
  already_requested     integer,
  remaining_quantity    integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.order_id,
    o.order_number,
    oi.id,
    oi.item_name::text,
    oi.option_name::text,
    oi.quantity,
    coalesce(req.requested_qty, 0)::integer,
    (oi.quantity - coalesce(req.requested_qty, 0))::integer
  from public.order_tracking_capabilities c
  join public.orders o on o.id = c.order_id
  join public.order_items oi on oi.order_id = o.id
  left join lateral (
    select sum(wri.quantity)::integer as requested_qty
    from public.withdrawal_request_items wri
    join public.withdrawal_requests wr on wr.id = wri.withdrawal_request_id
    where wri.order_item_id = oi.id
      and wr.status = 'recorded'
  ) req on true
  where c.id = p_capability_id
    and c.order_id = p_order_id
    and o.id = p_order_id
    and c.secret_hash is not null
    and (c.expires_at is null or c.expires_at > pg_catalog.now())
    and pg_catalog.length(p_secret) = 64
    and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))
    -- FAIL-CLOSED : seules les lignes dont l'instantané dit
    -- EXPLICITEMENT `true` sont proposées. NULL (ligne historique)
    -- n'est jamais traité comme éligible.
    and oi.withdrawal_eligible_at_order_time is true
    and (oi.quantity - coalesce(req.requested_qty, 0)) > 0
  order by oi.item_name, oi.id;
$$;

comment on function public.get_withdrawal_options_by_capability(uuid, uuid, text) is
  'ONLINE WITHDRAWAL v1 — lignes de commande ENCORE rétractables, pour le titulaire de la capacité de suivi liée à CETTE commande. Ne retourne que les lignes dont l''instantané immuable vaut true (NULL historique exclu, fail-closed) et dont la quantité restante est > 0. Aucune écriture : ouvrir l''écran de rétractation ne crée jamais de demande.';

revoke all on function public.get_withdrawal_options_by_capability(uuid, uuid, text) from public;
grant execute on function public.get_withdrawal_options_by_capability(uuid, uuid, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- F. RPC CLIENT — enregistrement de la déclaration
-- -----------------------------------------------------------------------------
create function public.submit_withdrawal_request_by_capability(
  p_order_id           uuid,
  p_capability_id      uuid,
  p_secret             text,
  p_first_name         text,
  p_last_name          text,
  p_ack_channel        text,
  p_ack_address        text,
  p_items              jsonb,
  p_client_request_id  uuid
)
returns table (
  withdrawal_request_id uuid,
  requested_at          timestamptz,
  acknowledgement_status text,
  replayed              boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order            public.orders%rowtype;
  v_request_id       uuid;
  v_existing         public.withdrawal_requests%rowtype;
  v_item             jsonb;
  v_order_item_id    uuid;
  v_quantity         integer;
  v_line             public.order_items%rowtype;
  v_already          integer;
  v_lines            jsonb := '[]'::jsonb;
  v_requested_at     timestamptz;
  v_ack_status       text;
  v_count            integer := 0;
begin
  -- 1. AUTORITÉ : la capacité de suivi, liée à CETTE commande.
  --    Jamais order_id seul, jamais public_token, jamais un e-mail
  --    fourni par le client comme preuve de possession.
  if not exists (
    select 1
    from public.order_tracking_capabilities c
    where c.id = p_capability_id
      and c.order_id = p_order_id
      and c.secret_hash is not null
      and (c.expires_at is null or c.expires_at > pg_catalog.now())
      and pg_catalog.length(p_secret) = 64
      and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))
  ) then
    raise exception using errcode = '42501', message = 'WITHDRAWAL_CAPABILITY_INVALID';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WITHDRAWAL_ORDER_NOT_FOUND';
  end if;

  -- 2. IDEMPOTENCE : un rejeu du même formulaire retourne la demande
  --    déjà enregistrée, sans jamais double-compter les quantités.
  select * into v_existing
  from public.withdrawal_requests wr
  where wr.order_id = p_order_id and wr.client_request_id = p_client_request_id;
  if found then
    return query select v_existing.id, v_existing.requested_at, v_existing.acknowledgement_status, true;
    return;
  end if;

  -- 3. Identité (D.221-5) et moyen électronique d'accusé de réception.
  if p_first_name is null or pg_catalog.btrim(p_first_name) = ''
     or p_last_name is null or pg_catalog.btrim(p_last_name) = '' then
    raise exception using errcode = '22023', message = 'WITHDRAWAL_IDENTITY_REQUIRED';
  end if;
  if p_ack_channel is distinct from 'email' then
    raise exception using errcode = '22023', message = 'WITHDRAWAL_ACK_CHANNEL_UNSUPPORTED';
  end if;
  if p_ack_address is null or pg_catalog.btrim(p_ack_address) = ''
     or pg_catalog.strpos(p_ack_address, '@') < 2 then
    raise exception using errcode = '22023', message = 'WITHDRAWAL_ACK_ADDRESS_INVALID';
  end if;

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'WITHDRAWAL_NO_ITEM_SELECTED';
  end if;

  -- Alias `wr` sur la table insérée : sans lui, `returning requested_at`
  -- est AMBIGU avec la colonne de sortie homonyme de cette fonction
  -- (défaut détecté par l'exécution réelle sur PostgreSQL 16, pas par
  -- relecture).
  insert into public.withdrawal_requests as wr (
    restaurant_id, order_id, customer_last_name, customer_first_name,
    acknowledgement_channel, acknowledgement_address, acknowledgement_status,
    declaration_snapshot, tracking_capability_id, client_request_id
  ) values (
    v_order.restaurant_id, p_order_id,
    pg_catalog.btrim(p_last_name), pg_catalog.btrim(p_first_name),
    'email', pg_catalog.btrim(p_ack_address),
    -- État honnête : tant qu'aucun canal d'envoi réel n'est
    -- opérationnel, l'accusé n'est ni "envoyé" ni même "en attente
    -- d'envoi" -- il est indisponible, et le client en est informé.
    case when public._scanym_has_operational_durable_ack_channel() then 'pending' else 'unavailable_no_channel' end,
    '{}'::jsonb, p_capability_id, p_client_request_id
  )
  returning wr.id, wr.requested_at, wr.acknowledgement_status
    into v_request_id, v_requested_at, v_ack_status;

  -- 4. Lignes demandées : éligibilité par INSTANTANÉ, quantités bornées.
  for v_item in select * from pg_catalog.jsonb_array_elements(p_items)
  loop
    v_order_item_id := (v_item->>'order_item_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;

    if v_order_item_id is null or v_quantity is null or v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'WITHDRAWAL_INVALID_ITEM_PAYLOAD';
    end if;

    -- Verrou de ligne : la vérification cumulative ci-dessous ne peut
    -- pas être contournée par deux demandes concurrentes.
    select * into v_line
    from public.order_items oi
    where oi.id = v_order_item_id and oi.order_id = p_order_id
    for update;

    if not found then
      raise exception using errcode = 'P0002', message = 'WITHDRAWAL_LINE_NOT_IN_ORDER';
    end if;

    -- Éligibilité : SEUL l'instantané fait foi. Une valeur fournie par
    -- le client est ignorée (elle n'est même pas lue), et NULL
    -- (historique) n'est jamais interprété comme éligible.
    if v_line.withdrawal_eligible_at_order_time is not true then
      raise exception using errcode = '42501', message = 'WITHDRAWAL_LINE_NOT_ELIGIBLE';
    end if;

    select coalesce(sum(wri.quantity), 0)::integer into v_already
    from public.withdrawal_request_items wri
    join public.withdrawal_requests wr on wr.id = wri.withdrawal_request_id
    where wri.order_item_id = v_order_item_id
      and wr.status = 'recorded'
      and wr.id <> v_request_id;

    if v_already + v_quantity > v_line.quantity then
      raise exception using errcode = '22023', message = 'WITHDRAWAL_QUANTITY_EXCEEDS_ORDERED';
    end if;

    insert into public.withdrawal_request_items (withdrawal_request_id, order_item_id, quantity)
    values (v_request_id, v_order_item_id, v_quantity);

    v_lines := v_lines || pg_catalog.jsonb_build_object(
      'order_item_id', v_order_item_id,
      'item_name', v_line.item_name,
      'option_name', v_line.option_name,
      'quantity', v_quantity,
      'ordered_quantity', v_line.quantity
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception using errcode = '22023', message = 'WITHDRAWAL_NO_ITEM_SELECTED';
  end if;

  -- 5. Contenu DURABLE de la déclaration (D.221-5 : contenu, date, heure).
  update public.withdrawal_requests
  set declaration_snapshot = pg_catalog.jsonb_build_object(
        'order_number', v_order.order_number,
        'order_id', p_order_id,
        'customer_first_name', pg_catalog.btrim(p_first_name),
        'customer_last_name', pg_catalog.btrim(p_last_name),
        'acknowledgement_channel', 'email',
        'acknowledgement_address', pg_catalog.btrim(p_ack_address),
        'declared_at', v_requested_at,
        'lines', v_lines
      )
  where id = v_request_id;

  return query select v_request_id, v_requested_at, v_ack_status, false;
end $$;

comment on function public.submit_withdrawal_request_by_capability(uuid, uuid, text, text, text, text, text, jsonb, uuid) is
  'ONLINE WITHDRAWAL v1 — enregistre la DÉCLARATION de rétractation (art. L221-21 / D.221-5) pour le titulaire de la capacité de suivi liée à cette commande. Fail-closed : capacité invalide, ligne d''une autre commande, ligne non éligible par instantané (NULL historique compris), quantité cumulée dépassant la quantité commandée, identité ou moyen électronique manquant -> exception, aucune écriture. Rejeu du même client_request_id -> la demande déjà enregistrée est retournée telle quelle (replayed = true), jamais un double décompte. N''écrit jamais acknowledgement_status = ''sent'' : seul un envoi réellement confirmé par un prestataire peut le faire.';

revoke all on function public.submit_withdrawal_request_by_capability(uuid, uuid, text, text, text, text, text, jsonb, uuid) from public;
grant execute on function public.submit_withdrawal_request_by_capability(uuid, uuid, text, text, text, text, text, jsonb, uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- G. CANAL D'ACCUSÉ DE RÉCEPTION — état RÉEL, jamais supposé
-- -----------------------------------------------------------------------------
-- D.221-5 exige un accusé de réception sur support durable. Le dépôt
-- possède la machinerie d'outbox et un worker, mais AUCUN prestataire
-- d'envoi réel : lib/server/notifications/email-provider-resolution.ts
-- retourne `null` même quand la porte d'activation est ouverte. Cette
-- fonction dit donc `false` -- et le dira jusqu'à ce qu'un canal réel
-- existe. Elle n'est PAS un littéral : elle teste la primitive de
-- transport (une table d'envois confirmés), de sorte qu'un futur lot
-- qui livre réellement le canal la fasse basculer par construction.
create function public._scanym_has_operational_durable_ack_channel()
returns boolean
language sql
stable
set search_path = ''
as $$
  select to_regclass('public.withdrawal_acknowledgement_deliveries') is not null;
$$;

comment on function public._scanym_has_operational_durable_ack_channel() is
  'ONLINE WITHDRAWAL v1 — le canal d''accusé de réception sur support durable est-il RÉELLEMENT opérationnel ? Aujourd''hui false : aucun prestataire d''envoi transactionnel n''est câblé dans ce dépôt (email-provider-resolution.ts retourne null par conception). La demande de rétractation est malgré tout enregistrée de façon durable -- c''est l''ENVOI qui manque, pas la trace. Un lot futur qui livre le transport créera la table d''envois confirmés et cette fonction basculera d''elle-même.';

revoke all on function public._scanym_has_operational_durable_ack_channel() from public;

-- -----------------------------------------------------------------------------
-- H. GARDE CGV — runtime de rétractation en ligne, VÉRIFIÉ
-- -----------------------------------------------------------------------------
-- CGV ENGINE v2.5 renvoyait `false` en dur, faute de runtime. Ce lot
-- livre les PRIMITIVES de déclaration ; la garde les teste réellement
-- (jamais un `true` littéral) : si une primitive disparaît, la
-- publication CGV redevient fail-closed automatiquement.
--
-- v1.1 — DEUX fonctions, DEUX questions distinctes :
--
--   * `_scanym_has_online_withdrawal_primitives()` — le mécanisme de
--     DÉCLARATION existe-t-il ? (tables, RPC liées à la capacité,
--     instantané d'éligibilité de ligne). Vrai depuis ce lot. C'est
--     cette question, et elle seule, qui conditionne l'INSERTION d'un
--     gabarit CGV décrivant la fonctionnalité : le texte doit
--     correspondre au mécanisme réel.
--
--   * `_scanym_has_online_withdrawal_runtime()` — la fonctionnalité
--     STATUTAIRE est-elle COMPLÈTE ? C'est la question que posent
--     `resolve_cgv_publication_context` et
--     `persist_merchant_cgv_version` avant d'autoriser un marchand à
--     PUBLIER des CGV qui annoncent cette fonctionnalité. Or l'article
--     D.221-5 du code de la consommation, transposant l'article 11 bis
--     de la directive 2011/83/UE (inséré par la directive (UE)
--     2023/2673, applicable depuis le 19 juin 2026), n'exige pas
--     seulement de recueillir la déclaration : le professionnel ENVOIE
--     au consommateur, sans retard excessif, un accusé de réception sur
--     support durable mentionnant le contenu de la déclaration, sa date
--     et son heure. Enregistrer sans pouvoir envoyer ne remplit donc
--     PAS l'obligation.
--
-- Conséquence assumée (v1.1) : tant qu'aucun canal d'envoi durable
-- n'est opérationnel, cette garde vaut FALSE et la publication d'une
-- CGV annonçant la fonctionnalité complète reste BLOQUÉE. Ce n'est pas
-- une régression : c'est le refus de faire dire au texte contractuel
-- plus que ce que la plateforme sait faire. Le jour où un lot autorisé
-- livre le transport, `_scanym_has_operational_durable_ack_channel()`
-- bascule et cette garde bascule avec elle, sans retouche.
create function public._scanym_has_online_withdrawal_primitives()
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    to_regclass('public.withdrawal_requests') is not null
    and to_regclass('public.withdrawal_request_items') is not null
    and to_regprocedure('public.submit_withdrawal_request_by_capability(uuid,uuid,text,text,text,text,text,jsonb,uuid)') is not null
    and to_regprocedure('public.get_withdrawal_options_by_capability(uuid,uuid,text)') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'order_items'
        and column_name = 'withdrawal_eligible_at_order_time'
    );
$$;

comment on function public._scanym_has_online_withdrawal_primitives() is
  'ONLINE WITHDRAWAL v1.1 — les PRIMITIVES de déclaration existent-elles réellement (tables, RPC liées à la capacité de suivi, instantané d''éligibilité par ligne) ? Vérification, jamais un littéral. Ne dit RIEN de l''accusé de réception : voir _scanym_has_online_withdrawal_runtime().';

revoke all on function public._scanym_has_online_withdrawal_primitives() from public;

create or replace function public._scanym_has_online_withdrawal_runtime()
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    public._scanym_has_online_withdrawal_primitives()
    and public._scanym_has_operational_durable_ack_channel();
$$;

comment on function public._scanym_has_online_withdrawal_runtime() is
  'ONLINE WITHDRAWAL v1.1 — la fonctionnalité statutaire de rétractation en ligne est-elle COMPLÈTE ? Deux conditions CUMULATIVES, toutes deux vérifiées et jamais supposées : (1) les primitives de déclaration existent ; (2) un canal d''accusé de réception sur support durable est réellement opérationnel. La seconde manque aujourd''hui : D.221-5 (art. 11 bis de la directive 2011/83/UE) impose d''ENVOYER au consommateur, sans retard excessif, un accusé mentionnant le contenu, la date et l''heure de sa déclaration -- un enregistrement visible de la seule plateforme n''y suffit pas. Cette garde vaut donc false, et la publication d''une CGV annonçant la fonctionnalité complète reste bloquée : fail-closed délibéré, jamais un true de confort.';

revoke all on function public._scanym_has_online_withdrawal_runtime() from public;

-- -----------------------------------------------------------------------------
-- I. RPC CATALOGUE MARCHANDES — withdrawal_eligible
-- -----------------------------------------------------------------------------
-- Même patron que CATALOGUE / SUBCATEGORIES v1 : drop + create, UN seul
-- nouveau paramètre optionnel en fin de signature, rétro-compatible.
drop function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid);

create function public.create_product(
  p_category_id             uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null,
  p_withdrawal_eligible     boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_order integer;
  v_id uuid;
  v_name text;
  v_description text;
  v_short_description text;
  v_subcategory_category_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_categories mc where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;
  -- ONLINE WITHDRAWAL v1 -- null (appelant antérieur à ce lot) == Non :
  -- le défaut produit reste "non rétractable", jamais une éligibilité
  -- supposée.
  if p_withdrawal_eligible is null then
    p_withdrawal_eligible := false;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from p_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  insert into public.menu_items (
    category_id, name, description, short_description, price, display_order,
    tax_rate, unit_weight_grams, weight_is_approximate, subcategory_id, withdrawal_eligible
  )
  values (
    p_category_id, v_name, v_description, v_short_description, round(p_price, 2), v_order,
    p_tax_rate, p_unit_weight_grams, p_weight_is_approximate, p_subcategory_id, p_withdrawal_eligible
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean) from public, anon;
grant execute on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean) to authenticated;

drop function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid);

create function public.update_product(
  p_product_id              uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null,
  p_withdrawal_eligible     boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_category_id uuid;
  v_name text;
  v_description text;
  v_short_description text;
  v_subcategory_category_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id, mc.id into v_restaurant_id, v_category_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_product_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this product';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;
  if p_withdrawal_eligible is null then
    p_withdrawal_eligible := false;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from v_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  update public.menu_items
  set name                     = v_name,
      description               = v_description,
      price                     = round(p_price, 2),
      short_description         = v_short_description,
      tax_rate                  = p_tax_rate,
      unit_weight_grams         = p_unit_weight_grams,
      weight_is_approximate     = p_weight_is_approximate,
      subcategory_id            = p_subcategory_id,
      withdrawal_eligible       = p_withdrawal_eligible
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

revoke all on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean) from public, anon;
grant execute on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean) to authenticated;

-- get_merchant_catalogue -- même signature, une colonne de plus.
drop function public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id                 uuid,
  category_id                uuid,
  category_name               text,
  category_name_hash          text,
  category_translations       jsonb,
  category_display_order      integer,
  category_is_option_source   boolean,
  category_description        text,
  category_description_hash   text,
  subcategory_id               uuid,
  subcategory_name             text,
  subcategory_display_order    integer,
  name                        text,
  name_hash                   text,
  short_description            text,
  short_description_hash       text,
  description                  text,
  description_hash             text,
  translations                 jsonb,
  price                        numeric,
  is_available                 boolean,
  archived_at                  timestamptz,
  display_order                integer,
  is_option_source             boolean,
  image_url                    text,
  tax_rate                     numeric,
  unit_weight_grams            integer,
  weight_is_approximate        boolean,
  reference_price_per_kg       numeric,
  withdrawal_eligible          boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  with groups as (
    select ms.category_id as category_id, ms.id as subcategory_id,
           ms.name::text as subcategory_name, ms.display_order as subcategory_display_order
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order
    from public.menu_categories mc2
    where mc2.restaurant_id = p_restaurant_id
  )
  select mi.id, mc.id, mc.name::text, mc.name_hash, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description, mc.description_hash,
         g.subcategory_id, g.subcategory_name, g.subcategory_display_order,
         mi.name::text, mi.name_hash, mi.short_description, mi.short_description_hash,
         mi.description, mi.description_hash, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         ),
         mi.image_url,
         mi.tax_rate, mi.unit_weight_grams, mi.weight_is_approximate, mi.reference_price_per_kg,
         mi.withdrawal_eligible
  from public.menu_categories mc
  join groups g on g.category_id = mc.id
  left join public.menu_items mi
    on mi.category_id = mc.id
    and mi.subcategory_id is not distinct from g.subcategory_id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name,
           case when g.subcategory_id is null then 0 else 1 end,
           g.subcategory_display_order nulls last, g.subcategory_name nulls last,
           mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- J. VÉRIFICATION POST-APPLICATION — toujours AVANT commit
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items'
      and column_name = 'withdrawal_eligible' and is_nullable = 'NO'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_items.withdrawal_eligible absente ou nullable.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'withdrawal_eligible_at_order_time' and is_nullable = 'YES'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: order_items.withdrawal_eligible_at_order_time absente ou NOT NULL (l''historique doit rester NULL).';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_order_items_snapshot_withdrawal_eligibility' and not tgisinternal
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: déclencheur d''instantané absent.';
  end if;

  if to_regclass('public.withdrawal_requests') is null
     or to_regclass('public.withdrawal_request_items') is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: tables de déclaration absentes.';
  end if;

  -- Aucun rôle client ne touche les tables directement.
  if has_table_privilege('anon', 'public.withdrawal_requests', 'SELECT')
     or has_table_privilege('anon', 'public.withdrawal_requests', 'INSERT')
     or has_table_privilege('authenticated', 'public.withdrawal_requests', 'INSERT')
     or has_table_privilege('anon', 'public.withdrawal_request_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.withdrawal_request_items', 'INSERT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: privilège direct sur les tables de rétractation.';
  end if;

  if not (
    select relrowsecurity from pg_class where oid = 'public.withdrawal_requests'::regclass
  ) or not (
    select relrowsecurity from pg_class where oid = 'public.withdrawal_request_items'::regclass
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non activée sur les tables de rétractation.';
  end if;

  -- Les RPC client existent et sont exécutables par anon/authenticated.
  if not has_function_privilege('anon', 'public.get_withdrawal_options_by_capability(uuid,uuid,text)', 'EXECUTE')
     or not has_function_privilege('anon', 'public.submit_withdrawal_request_by_capability(uuid,uuid,text,text,text,text,text,jsonb,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RPC de rétractation non exécutables par le client.';
  end if;

  -- Les helpers privés restent privés.
  if has_function_privilege('authenticated', 'public._scanym_has_online_withdrawal_runtime()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._scanym_has_online_withdrawal_primitives()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._scanym_has_operational_durable_ack_channel()', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: helper privé exposé à un rôle client.';
  end if;

  -- Les PRIMITIVES de déclaration sont livrées : la garde doit les voir.
  if not public._scanym_has_online_withdrawal_primitives() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: les primitives de rétractation sont livrées mais la garde les nie.';
  end if;

  -- Le canal d'accusé de réception reste, lui, honnêtement absent.
  if public._scanym_has_operational_durable_ack_channel() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: canal d''accusé déclaré opérationnel alors qu''aucun transport n''est livré par ce lot.';
  end if;

  -- v1.1 — et donc, la fonctionnalité STATUTAIRE reste incomplète :
  -- la garde de publication CGV DOIT valoir false. Cette assertion
  -- est l'inverse exact de celle que portait v1 ; elle est là pour
  -- qu''une bascule silencieuse à true (par exemple un futur `select
  -- true` de confort) fasse échouer la migration plutôt que de
  -- laisser publier une affirmation fausse.
  if public._scanym_has_online_withdrawal_runtime() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la fonctionnalité statutaire est déclarée complète alors qu''aucun canal d''accusé de réception durable n''est livré (D.221-5 exige un ENVOI au consommateur).';
  end if;

  -- Catalogue marchand étendu, sans exposition anon.
  if to_regprocedure('public.create_product(uuid,text,text,numeric,text,numeric,integer,boolean,uuid,boolean)') is null
     or to_regprocedure('public.update_product(uuid,text,text,numeric,text,numeric,integer,boolean,uuid,boolean)') is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_product/update_product non étendues.';
  end if;
  if has_function_privilege('anon', 'public.get_merchant_catalogue(uuid,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_catalogue exposée à anon.';
  end if;
  if pg_get_function_result('public.get_merchant_catalogue(uuid,boolean)'::regprocedure) not like '%withdrawal_eligible boolean%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_catalogue n''expose pas withdrawal_eligible.';
  end if;
end $$;

commit;

-- =============================================================================
-- AUCUNE DONNÉE LOCATAIRE N'EST INSÉRÉE, MODIFIÉE NI SUPPRIMÉE PAR CE
-- FICHIER. `withdrawal_eligible` vaut false pour tous les produits
-- existants (défaut de colonne), et `withdrawal_eligible_at_order_time`
-- reste NULL pour toutes les lignes de commande déjà passées : aucune
-- éligibilité rétroactive n'est devinée.
-- =============================================================================
