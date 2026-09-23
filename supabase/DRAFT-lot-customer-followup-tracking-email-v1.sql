-- ============================================================
-- Scanym — CUSTOMER FOLLOW-UP + TRACKING EMAIL v1
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Parent : main cb56f0c6099f7517c300bfa577ddd06f02d7b7a9.
-- Rollback : DRAFT-lot-customer-followup-tracking-email-v1-rollback.sql
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--
-- A. MODES SUIVIS — public.customer_tracked_service_modes()
--    SEULE autorité SQL de la liste des modes pour lesquels le suivi par
--    e-mail fait partie du parcours client de cette version : pickup et
--    delivery. Jamais recopiée ailleurs : le résolveur d'exigences ET
--    create_order l'appellent tous les deux.
--
-- B. PRÉCÉDENCE E-MAIL (non relaxable par surcharge tenant)
--    public.effective_sale_mode_field_requirements est REDÉFINIE
--    (CREATE OR REPLACE, MÊME signature, MÊME type de retour) :
--      - le champ `email` est FORCÉ `required` pour les modes suivis,
--        quelle que soit la règle catalogue ou la surcharge tenant ;
--      - AUCUNE ligne tenant/catalogue n'est modifiée ni supprimée : la
--        précédence est appliquée à la RÉSOLUTION, jamais aux données
--        historiques (mandat : "Do not silently mutate historical tenant
--        rows merely to achieve this") ;
--      - les autres membres d'un groupe `one_of` qui contenait `email`
--        deviennent `optional` pour ces modes : le groupe est désormais
--        satisfait INCONDITIONNELLEMENT par l'e-mail obligatoire, donc
--        exiger en plus le téléphone serait STRICTEMENT PLUS CONTRAIGNANT
--        qu'aujourd'hui -- jamais une régression imposée au client ;
--      - le système configurable reste intact pour TOUS les autres
--        champs et pour TOUS les autres modes (table, click_collect,
--        room_service) : ceux-ci traversent le résolveur inchangés.
--
-- C. PRÉNOM + NOM (sans aucune colonne persistante nouvelle)
--    Pour les modes suivis, le résolveur remplace `customer_name` par
--    `first_name` (toujours required) et `last_name` (required en
--    delivery, optional en pickup). AUCUNE colonne n'est ajoutée à
--    public.orders : create_order COMPOSE le nom d'affichage normalisé
--    et le persiste dans la colonne EXISTANTE orders.customer_name.
--
-- D. TEXTE DE STATUT MARCHAND (affichage seul)
--    public.merchant_tracking_status_text : au plus un texte par
--    (restaurant, statut canonique). NE TOUCHE JAMAIS orders.status ni
--    aucune transition d'état -- aucune fonction de ce lot n'écrit dans
--    public.orders. Écriture RPC-only (owner/manager), lecture tenant
--    par RLS, lecture client par la MÊME preuve de capacité v3.1 que
--    get_order_tracking_by_capability (prédicat copié, jamais affaibli).
--
-- E. E-MAIL DE CONFIRMATION
--    public.create_order_received_notification est REDÉFINIE (MÊME
--    signature, MÊME idempotence, MÊME garde anti-substitution tenant) :
--    son payload_snapshot porte en plus le statut de la commande, la
--    surcharge de texte marchande applicable À CET INSTANT, l'adresse de
--    livraison (mode delivery uniquement) et le nom du commerçant.
--    AUCUN envoi réseau n'est ajouté : le rendu et l'envoi restent le
--    domaine du worker, provider toujours résolu à `null`.
--
-- CE QUE CE LOT NE FAIT PAS :
--   - aucun nouveau statut, aucune 8e valeur, aucun statut livreur ;
--   - aucun rattrapage/backfill, aucune écriture de données historiques ;
--   - aucune modification de get_order_tracking* / update_order_status /
--     émission de capacité de suivi / notification_outbox (structure) ;
--   - aucun travail retrait/paiement/Monetico ;
--   - aucune RLS affaiblie, aucun grant élargi.
--
-- FRONTIÈRE DE SUCCÈS DE COMMANDE (ORDER SUCCESS BOUNDARY v1,
-- migration-20260919000000) : create_order est redéfinie ici, et son
-- corps N'APPELLE DÉLIBÉRÉMENT PAS create_order_received_notification --
-- l'enfilement reste porté par le marqueur d'intention durable
-- (orders.order_received_notification_intent_at, posé par le déclencheur
-- orders_record_order_received_intent_trg) et par la reprise tenant. Le
-- pré-vol REFUSE de s'appliquer si ce déclencheur ou cette colonne ont
-- disparu : sur un tel prédécesseur, remplacer create_order ferait
-- silencieusement perdre l'événement order_received -- exactement la
-- régression déjà vécue le 16/09/2026 (voir
-- DRAFT-lot-order-received-enqueue-recovery-v1.sql).
--
-- ATOMICITÉ (CFTE-V1-SQL-ATOMICITY-01) : UNE seule transaction
-- explicite, et TOUT y est enfermé -- le pré-vol, la totalité du DDL, ET
-- le post-vol. `commit;` est la DERNIÈRE instruction exécutable du
-- fichier : aucune vérification ne s'exécute après lui. Un pré-vol ou un
-- post-vol qui lève interrompt donc la transaction AVANT le commit, et
-- la base retombe à son état antérieur -- jamais un lot à moitié
-- appliqué que seule une lecture attentive du journal aurait révélé.
-- Cette garantie ne dépend PAS de `-v ON_ERROR_STOP=1` : même sans lui,
-- psql exécuterait `commit;` sur une transaction déjà avortée, ce que
-- PostgreSQL traite comme un ROLLBACK.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL — anti-dérive et anti-double-application.
--    DANS la transaction : un prérequis absent annule tout.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.restaurants') is null
     or to_regclass('public.restaurant_configs') is null
     or to_regclass('public.restaurant_users') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.order_tracking_capabilities') is null
     or to_regclass('public.notification_outbox') is null
     or to_regclass('public.sale_mode_field_requirements') is null
     or to_regclass('public.restaurant_sale_mode_field_requirements') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: prérequis de table absents -- CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 annulé.';
  end if;

  if to_regprocedure('public.effective_sale_mode_field_requirements(uuid,text)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: effective_sale_mode_field_requirements(uuid,text) absente -- annulé.';
  end if;
  if to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order 8 arguments absente -- annulé.';
  end if;
  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification(uuid,uuid) absente -- annulé.';
  end if;

  -- ORDER SUCCESS BOUNDARY v1 : garde de NON-RÉGRESSION de l'enfilement.
  -- Ce lot remplace create_order ; sur un prédécesseur où l'enfilement
  -- vivait ENCORE dans le corps de create_order (ou dans un déclencheur
  -- ultérieurement retiré), ce remplacement le perdrait silencieusement.
  -- On refuse plutôt que de prétendre une garantie fausse.
  if not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and a.attname = 'order_received_notification_intent_at'
      and not a.attisdropped
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: orders.order_received_notification_intent_at absente -- ORDER SUCCESS BOUNDARY v1 doit être appliqué avant. Annulé.';
  end if;
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_record_order_received_intent_trg'
      and not t.tgisinternal
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: déclencheur orders_record_order_received_intent_trg absent -- l''enfilement order_received serait perdu par ce lot. Annulé.';
  end if;

  if to_regclass('public.merchant_tracking_status_text') is not null
     or to_regprocedure('public.customer_tracked_service_modes()') is not null
     or to_regprocedure('public.set_merchant_tracking_status_text(uuid,text,text)') is not null
     or to_regprocedure('public.get_order_tracking_status_text_by_capability(uuid,uuid,text)') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 déjà (partiellement) appliqué -- annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- A. Modes suivis — SEULE autorité SQL.
-- ------------------------------------------------------------
create function public.customer_tracked_service_modes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['pickup', 'delivery']::text[];
$$;

comment on function public.customer_tracked_service_modes() is
  'CFTE v1 — SEULE autorité SQL des modes de vente dont le suivi par e-mail fait partie du parcours client de cette version (pickup, delivery). Utilisée par effective_sale_mode_field_requirements ET create_order -- jamais recopiée en dur ailleurs. Aucune lecture de données, aucun effet de bord.';

-- Helper strictement interne, même posture que
-- effective_sale_mode_field_requirements : appelé uniquement depuis des
-- fonctions SECURITY DEFINER du même propriétaire.
revoke all on function public.customer_tracked_service_modes() from public, anon, authenticated;

-- ------------------------------------------------------------
-- B/C. Résolveur d'exigences — précédence e-mail + prénom/nom.
--      CREATE OR REPLACE : MÊME signature, MÊME type de retour, MÊME
--      posture de sécurité (SECURITY DEFINER, aucun grant applicatif).
--      La résolution historique (surcharge tenant puis catalogue) est
--      reprise VERBATIM dans la CTE `configured` -- aucune règle
--      existante n'est perdue, aucune donnée n'est écrite.
-- ------------------------------------------------------------
create or replace function public.effective_sale_mode_field_requirements(
  p_restaurant_id uuid, p_mode_code text
)
returns table (field text, requirement text, one_of_group text)
language sql
stable
security definer
set search_path = ''
as $$
  with configured as (
    -- VERBATIM LOT 2A : surcharge établissement, puis repli catalogue
    -- pour les seuls champs non surchargés.
    select o.field, o.requirement, o.one_of_group
    from public.restaurant_sale_mode_field_requirements o
    where o.restaurant_id = p_restaurant_id and o.mode_code = p_mode_code
    union all
    select c.field, c.requirement, c.one_of_group
    from public.sale_mode_field_requirements c
    where c.mode_code = p_mode_code
      and not exists (
        select 1 from public.restaurant_sale_mode_field_requirements o2
        where o2.restaurant_id = p_restaurant_id
          and o2.mode_code = p_mode_code
          and o2.field = c.field
      )
  ),
  tracked as (
    select p_mode_code = any (public.customer_tracked_service_modes()) as is_tracked
  ),
  email_groups as (
    -- Groupes `one_of` dont l'e-mail est membre : une fois l'e-mail
    -- rendu obligatoire, ces groupes sont satisfaits d'office.
    select distinct c.one_of_group
    from configured c
    where c.field = 'email'
      and c.requirement = 'one_of'
      and c.one_of_group is not null
  )
  select
    c.field,
    case
      when t.is_tracked and c.field = 'email' then 'required'
      when t.is_tracked
           and c.one_of_group is not null
           and c.one_of_group in (select eg.one_of_group from email_groups eg)
        then 'optional'
      else c.requirement
    end,
    case
      when t.is_tracked and c.field = 'email' then null
      when t.is_tracked
           and c.one_of_group is not null
           and c.one_of_group in (select eg.one_of_group from email_groups eg)
        then null
      else c.one_of_group
    end
  from configured c
  cross join tracked t
  -- Modes suivis : le nom est saisi en DEUX champs (first_name /
  -- last_name) et recomposé serveur dans orders.customer_name --
  -- `customer_name` n'est donc plus un champ de saisie pour ces modes.
  -- first_name/last_name sont émis ci-dessous de façon inconditionnelle
  -- (jamais deux fois, même si une configuration tenant les déclarait).
  where not (t.is_tracked and c.field in ('customer_name', 'first_name', 'last_name'))
  union all
  -- E-mail exigé même lorsque AUCUNE règle ne le mentionne pour ce mode.
  select 'email', 'required', null
  from tracked t
  where t.is_tracked
    and not exists (select 1 from configured c2 where c2.field = 'email')
  union all
  select 'first_name', 'required', null
  from tracked t
  where t.is_tracked
  union all
  select 'last_name',
         case when p_mode_code = 'delivery' then 'required' else 'optional' end,
         null
  from tracked t
  where t.is_tracked;
$$;

comment on function public.effective_sale_mode_field_requirements(uuid, text) is
  'LOT 2A + CFTE v1 — exigences EFFECTIVES (surcharge établissement puis catalogue), plus la précédence non relaxable de CFTE v1 pour les modes suivis (customer_tracked_service_modes) : email TOUJOURS required, first_name required, last_name required en delivery / optional en pickup, customer_name remplacé par ce couple. Aucune ligne de configuration n''est modifiée : la précédence est appliquée à la résolution seule. Strictement interne (aucun grant applicatif).';

revoke all on function public.effective_sale_mode_field_requirements(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- D. Texte de statut marchand — AFFICHAGE SEUL.
-- ------------------------------------------------------------
create table public.merchant_tracking_status_text (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  status        text not null,
  body          text,
  updated_at    timestamptz not null default pg_catalog.now(),
  primary key (restaurant_id, status),
  -- Les 7 statuts CANONIQUES, et EXACTEMENT eux : cette contrainte est
  -- ce qui rend structurellement impossible l'introduction d'un 8e
  -- statut (ou d'un statut livreur) par simple configuration marchande.
  constraint merchant_tracking_status_text_status_check
    check (status in ('new', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')),
  -- MIROIR EXACT de MERCHANT_STATUS_TEXT_MAX_LENGTH (lib/tracking/status-text.ts).
  constraint merchant_tracking_status_text_body_length
    check (body is null or pg_catalog.length(pg_catalog.btrim(body)) <= 400)
);

comment on table public.merchant_tracking_status_text is
  'CFTE v1 — surcharge DE TEXTE customer-facing, par établissement et par statut CANONIQUE. Configuration D''AFFICHAGE uniquement : ne modifie jamais orders.status ni aucune transition d''état. body NULL/vide = repli sur le texte de base i18n. Écriture RPC-only (set_merchant_tracking_status_text, owner/manager). Lecture tenant par RLS ; lecture client uniquement par preuve de capacité de suivi v3.1.';

alter table public.merchant_tracking_status_text enable row level security;

-- Même posture que restaurant_sale_mode_field_requirements : lecture
-- réservée aux membres du tenant, aucune lecture anon, écriture par RPC.
create policy "merchant_tracking_status_text_select_member"
on public.merchant_tracking_status_text for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = merchant_tracking_status_text.restaurant_id
      and ru.user_id = auth.uid()
  )
);

revoke all on public.merchant_tracking_status_text from public, anon, authenticated;
grant select on public.merchant_tracking_status_text to authenticated;

create function public.set_merchant_tracking_status_text(
  p_restaurant_id uuid,
  p_status        text,
  p_body          text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  if p_restaurant_id is null or p_status is null then
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

  -- Statut non canonique : REFUSÉ explicitement (jamais une ligne
  -- ignorée en silence, jamais un statut inventé par configuration).
  if p_status not in ('new', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled') then
    raise exception using errcode = '22023', message = 'SCANYM_UNKNOWN_ORDER_STATUS';
  end if;

  if v_body is not null and pg_catalog.length(v_body) > 400 then
    raise exception using errcode = '22001', message = 'SCANYM_TRACKING_STATUS_TEXT_TOO_LONG';
  end if;

  -- Surcharge vidée = REPLI sur le texte de base : la ligne est retirée
  -- plutôt que conservée à vide (un seul état pour "pas de surcharge").
  if v_body is null then
    delete from public.merchant_tracking_status_text
    where restaurant_id = p_restaurant_id and status = p_status;
    return;
  end if;

  insert into public.merchant_tracking_status_text (restaurant_id, status, body, updated_at)
  values (p_restaurant_id, p_status, v_body, pg_catalog.now())
  on conflict (restaurant_id, status)
  do update set body = excluded.body, updated_at = excluded.updated_at;
end;
$$;

comment on function public.set_merchant_tracking_status_text(uuid, text, text) is
  'CFTE v1 — SEULE autorité d''écriture de merchant_tracking_status_text. owner/manager du tenant uniquement. Statut hors des 7 canoniques : refusé. Corps vide/blanc : la ligne est SUPPRIMÉE (repli sur le texte de base). N''écrit JAMAIS dans public.orders.';

revoke all on function public.set_merchant_tracking_status_text(uuid, text, text) from public, anon;
grant execute on function public.set_merchant_tracking_status_text(uuid, text, text) to authenticated;

-- Lecture CLIENT : MÊME prédicat de capacité v3.1 que
-- get_order_tracking_by_capability / get_order_tracking_customer_context_
-- by_capability (copié, jamais affaibli). Ne retourne QUE les surcharges
-- du commerçant de LA commande prouvée.
create function public.get_order_tracking_status_text_by_capability(
  p_order_id      uuid,
  p_capability_id uuid,
  p_secret        text
)
returns table (
  bound_order_id uuid,
  status         text,
  body           text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.order_id,
    m.status,
    m.body
  from public.order_tracking_capabilities c
  join public.orders o on o.id = c.order_id
  join public.merchant_tracking_status_text m on m.restaurant_id = o.restaurant_id
  where c.id = p_capability_id
    and c.order_id = p_order_id
    and o.id = p_order_id
    and c.secret_hash is not null
    and (c.expires_at is null or c.expires_at > pg_catalog.now())
    and pg_catalog.length(p_secret) = 64
    and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))
    and m.body is not null;
$$;

comment on function public.get_order_tracking_status_text_by_capability(uuid, uuid, text) is
  'SECURITY DEFINER, anon+authenticated -- CFTE v1. Même prédicat de capacité que get_order_tracking_by_capability (v3.1, non modifiée). Retourne UNIQUEMENT les surcharges de texte du commerçant de la commande prouvée. Entrée incorrecte ou commerçant sans surcharge : ensemble vide (le client retombe alors sur le texte de base). Aucune écriture.';

revoke all on function public.get_order_tracking_status_text_by_capability(uuid, uuid, text) from public;
grant execute on function public.get_order_tracking_status_text_by_capability(uuid, uuid, text) to anon, authenticated;

-- ------------------------------------------------------------
-- E. create_order_received_notification — MÊME signature, MÊME
--    idempotence, MÊME garde tenant. Seul le payload_snapshot gagne
--    quatre clés (statut, surcharge de texte applicable, adresse de
--    livraison, nom du commerçant). Aucune nouvelle écriture.
-- ------------------------------------------------------------
create or replace function public.create_order_received_notification(
  p_order_id      uuid,
  p_restaurant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order           public.orders%rowtype;
  v_profile         public.merchant_notification_profile%rowtype;
  v_locale          text;
  v_status          text;
  v_payload         jsonb;
  v_outbox_id       uuid;
  -- CFTE v1 (ajouts).
  v_status_override text;
  v_merchant_name   text;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- Substitution tenant croisée : refusée structurellement, jamais une
  -- simple absence de résultat silencieuse (mandat : "cross-tenant
  -- order_id substitution fails").
  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %', p_order_id, p_restaurant_id
      using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  -- Snapshot déterministe de la locale -- jamais réinféré plus tard.
  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language else 'fr' end;

  -- Éligibilité (mandat §"ORDER EMAIL ELIGIBILITY") : choix retenu --
  -- TOUJOURS une ligne outbox créée (auditabilité maximale), jamais
  -- absente, mais marquée 'skipped_*' (jamais 'pending') quand l'envoi
  -- n'est structurellement pas applicable.
  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    else 'pending'
  end;

  -- CFTE v1 — surcharge marchande APPLICABLE AU STATUT DE LA COMMANDE à
  -- cet instant, figée dans le snapshot comme tout le reste (le worker
  -- ne refait aucune lecture métier -- mandat §"NO BUSINESS COUPLING").
  -- Absente : la clé vaut NULL et le rendu retombe sur le texte de base.
  select m.body into v_status_override
  from public.merchant_tracking_status_text m
  where m.restaurant_id = p_restaurant_id
    and m.status = v_order.status;

  select r.name into v_merchant_name
  from public.restaurants r where r.id = p_restaurant_id;

  v_payload := jsonb_build_object(
    'order_number', v_order.order_number,
    'total', v_order.total,
    'currency', v_order.currency,
    'service_mode', v_order.service_mode,
    'public_token', v_order.public_token,
    'created_at', v_order.created_at,
    -- CFTE v1 — quatre clés ADDITIVES (aucune clé existante retirée ni
    -- renommée : un worker antérieur lit toujours le même snapshot).
    'order_status', v_order.status,
    'status_text_override', v_status_override,
    'delivery_address',
      case when v_order.service_mode = 'delivery' then v_order.delivery_address else null end,
    'merchant_name', v_merchant_name
  );

  insert into public.notification_outbox (
    restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status
  ) values (
    p_restaurant_id, p_order_id, 'order_received', v_order.customer_email, v_locale, v_payload, v_status
  )
  on conflict (restaurant_id, order_id, notification_type) do nothing
  returning id into v_outbox_id;

  -- v_outbox_id reste NULL si une ligne logique existait déjà (rejeu
  -- idempotent) -- ce n'est PAS une erreur.
  return v_outbox_id;
end $$;

comment on function public.create_order_received_notification(uuid, uuid) is
  'N1-A + CFTE v1 — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente (ON CONFLICT DO NOTHING sur (restaurant_id, order_id, notification_type)). Refuse toute substitution tenant croisée. CFTE v1 : le payload_snapshot porte en plus order_status, status_text_override, delivery_address (delivery uniquement) et merchant_name -- toutes ADDITIVES. Aucun envoi réseau.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- C-bis. create_order — CREATE OR REPLACE, MÊME signature 8 arguments,
--        MÊME type de retour 6 colonnes.
--
--        Corps hérité VERBATIM de DRAFT-lot-seller-legal-profile-cgv-
--        engine-v2-5.sql (dernière définition appliquée). CHANGEMENT
--        MINIMAL EXACT, et rien d'autre :
--          1. trois variables locales (v_first_name, v_last_name,
--             v_tracked) ;
--          2. extraction de first_name/last_name puis COMPOSITION du
--             nom d'affichage normalisé dans v_name -- qui continue
--             d'alimenter la colonne EXISTANTE orders.customer_name
--             (aucune colonne ajoutée) ;
--          3. garde serveur des modes suivis (e-mail + prénom, et nom
--             de famille en delivery) -- défense en profondeur DOUBLANT
--             le résolveur, pour que la précédence survive même à une
--             redéfinition future du résolveur ;
--          4. deux entrées dans la table de correspondance champ ->
--             valeur (first_name/last_name).
--        Aucune autre ligne n'est modifiée : mêmes lectures, mêmes
--        insertions, même ordre, mêmes sémantiques transactionnelles.
--        L'enfilement order_received reste HORS de ce corps (ORDER
--        SUCCESS BOUNDARY v1) -- vérifié en post-vol.
-- ------------------------------------------------------------
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
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city)
    values (v_order_id, v_address, v_postal, v_street, v_city);
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

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot,
      withdrawal_exempt_at_order_time, withdrawal_legal_basis_at_order_time,
      merchant_withdrawal_regime_at_order_time
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate,
      case when v_withdrawal_regime_snapshot is null then null
           else (v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE') end,
      v_withdrawal_legal_basis,
      v_withdrawal_regime_snapshot
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

revoke all on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) from public;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to anon;
grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to authenticated;

-- ------------------------------------------------------------
-- POST-VOL — vérifications réelles sur le schéma RÉELLEMENT modifié,
-- exécutées AVANT `commit;` et DANS LA MÊME TRANSACTION
-- (CFTE-V1-SQL-ATOMICITY-01).
--
-- Les objets créés/redéfinis ci-dessus sont pleinement visibles ici
-- (catalogues système, privilèges, RLS, et même les résultats de
-- effective_sale_mode_field_requirements sur les données réelles) :
-- ces vérifications portent donc sur l'état qui SERAIT publié, et
-- n'importe laquelle qui lève EMPÊCHE le commit au lieu de le
-- constater trop tard.
-- ------------------------------------------------------------
do $$
declare
  v_create_order_definition text;
begin
  -- 1. create_order : forme de sortie et ACL inchangées.
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_result(p.oid) = 'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  ) <> 1 then
    raise exception 'SCANYM_POSTCHECK_FAILED: create_order n''a plus exactement 6 colonnes de sortie.';
  end if;
  if not has_function_privilege('anon', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_REGRESSION: anon/authenticated ont perdu EXECUTE sur create_order.';
  end if;
  if has_function_privilege('public', 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_SECURITY_DRIFT: PUBLIC dispose d''EXECUTE sur create_order.';
  end if;

  -- 2. FRONTIÈRE DE SUCCÈS DE COMMANDE : l'enfilement order_received ne
  --    doit ni revenir dans create_order, ni disparaître du schéma.
  select string_agg(pg_get_functiondef(p.oid), E'\n') into v_create_order_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';

  if v_create_order_definition like '%create_order_received_notification%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: create_order appelle directement l''enfilement -- ORDER SUCCESS BOUNDARY v1 rompue.';
  end if;
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_record_order_received_intent_trg'
      and not t.tgisinternal
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: le déclencheur d''intention order_received a disparu.';
  end if;
  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_POSTCHECK_FAILED: create_order_received_notification a disparu.';
  end if;
  if not has_function_privilege('service_role', 'public.create_order_received_notification(uuid,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: service_role a perdu EXECUTE sur create_order_received_notification.';
  end if;
  if has_function_privilege('anon', 'public.create_order_received_notification(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.create_order_received_notification(uuid,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon/authenticated disposent d''EXECUTE sur create_order_received_notification.';
  end if;

  -- 3. Résolveur : toujours strictement interne, projection publique
  --    toujours ouverte au checkout public.
  if has_function_privilege('anon', 'public.effective_sale_mode_field_requirements(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.effective_sale_mode_field_requirements(uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_SECURITY_DRIFT: le résolveur d''exigences est devenu directement exécutable par un rôle applicatif.';
  end if;
  if not has_function_privilege('anon', 'public.get_restaurant_public_field_requirements(uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_REGRESSION: anon a perdu EXECUTE sur get_restaurant_public_field_requirements.';
  end if;

  -- 4. PRÉCÉDENCE E-MAIL réellement effective, sur les données RÉELLES,
  --    pour chaque (établissement, mode suivi) activé -- jamais une
  --    simple inspection de texte. Aucune donnée n'est écrite.
  if exists (
    select 1
    from public.restaurant_sale_modes rsm
    cross join lateral public.effective_sale_mode_field_requirements(rsm.restaurant_id, rsm.mode_code) e
    where rsm.mode_code = any (public.customer_tracked_service_modes())
      and e.field = 'email'
      and e.requirement <> 'required'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: l''e-mail n''est pas requis pour au moins un (établissement, mode suivi).';
  end if;
  if exists (
    select 1
    from public.restaurant_sale_modes rsm
    where rsm.mode_code = any (public.customer_tracked_service_modes())
      and not exists (
        select 1
        from public.effective_sale_mode_field_requirements(rsm.restaurant_id, rsm.mode_code) e
        where e.field = 'first_name' and e.requirement = 'required'
      )
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: first_name n''est pas requis pour au moins un (établissement, mode suivi).';
  end if;
  if exists (
    select 1
    from public.restaurant_sale_modes rsm
    where rsm.mode_code = 'delivery'
      and not exists (
        select 1
        from public.effective_sale_mode_field_requirements(rsm.restaurant_id, rsm.mode_code) e
        where e.field = 'last_name' and e.requirement = 'required'
      )
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: last_name n''est pas requis en livraison pour au moins un établissement.';
  end if;

  -- 5. AUCUNE colonne prénom/nom n'a été ajoutée à public.orders.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('first_name', 'last_name', 'customer_first_name', 'customer_last_name')
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: une colonne prénom/nom a été ajoutée à public.orders -- interdit par le mandat.';
  end if;

  -- 6. Surcharge de texte : RLS active, aucune lecture anon, aucune
  --    écriture directe par un rôle applicatif.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'merchant_tracking_status_text' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: RLS inactive sur merchant_tracking_status_text.';
  end if;
  if has_table_privilege('anon', 'public.merchant_tracking_status_text', 'SELECT') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon peut lire directement merchant_tracking_status_text.';
  end if;
  if not has_table_privilege('authenticated', 'public.merchant_tracking_status_text', 'SELECT') then
    raise exception 'SCANYM_POSTCHECK_FAILED: authenticated devrait disposer d''un SELECT (RLS) sur merchant_tracking_status_text.';
  end if;
  if has_table_privilege('authenticated', 'public.merchant_tracking_status_text', 'INSERT')
     or has_table_privilege('authenticated', 'public.merchant_tracking_status_text', 'UPDATE')
     or has_table_privilege('authenticated', 'public.merchant_tracking_status_text', 'DELETE') then
    raise exception 'SCANYM_SECURITY_DRIFT: écriture directe possible sur merchant_tracking_status_text (doit passer par set_merchant_tracking_status_text).';
  end if;
  if not has_function_privilege('authenticated', 'public.set_merchant_tracking_status_text(uuid,text,text)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: authenticated ne peut pas appeler set_merchant_tracking_status_text.';
  end if;
  if has_function_privilege('anon', 'public.set_merchant_tracking_status_text(uuid,text,text)', 'EXECUTE') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon peut appeler set_merchant_tracking_status_text.';
  end if;
  if not has_function_privilege('anon', 'public.get_order_tracking_status_text_by_capability(uuid,uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: anon ne peut pas lire le texte de statut par capacité.';
  end if;

  -- 7. Le moteur d'état reste INTOUCHÉ : aucune fonction de ce lot
  --    n'écrit dans public.orders.
  if (
    select string_agg(pg_get_functiondef(p.oid), E'\n')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_merchant_tracking_status_text',
                        'get_order_tracking_status_text_by_capability',
                        'customer_tracked_service_modes')
  ) ~* '(update|insert into|delete from)[[:space:]]+public\.orders' then
    raise exception 'SCANYM_POSTCHECK_FAILED: une fonction de texte de statut écrit dans public.orders -- interdit.';
  end if;
end $$;

-- DERNIÈRE instruction exécutable du fichier : rien ne s'exécute après
-- elle, donc aucune vérification ne peut être "constatée après coup".
commit;

-- ============================================================
-- RÉSUMÉ
--   Créés    : customer_tracked_service_modes(),
--              merchant_tracking_status_text (+ RLS, policy),
--              set_merchant_tracking_status_text(uuid,text,text),
--              get_order_tracking_status_text_by_capability(uuid,uuid,text).
--   Redéfinis: effective_sale_mode_field_requirements(uuid,text),
--              create_order(8 args),
--              create_order_received_notification(uuid,uuid).
--   Supprimés: AUCUN objet.
--   Données  : AUCUNE écriture, aucun backfill, aucune ligne tenant
--              modifiée.
--   RLS      : une nouvelle policy (nouvelle table) ; aucune policy
--              existante touchée.
-- ============================================================
