-- ============================================================
-- Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Parent : main 7bbb70b9f6f7f522b1b452a60b2092a69699ba95
--          (tree 8ad7238ffe4d5398f883072d63ee456e8ab4e713).
-- Rollback : DRAFT-lot-merchant-customer-communications-v1-rollback.sql
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--
-- A. CATALOGUES FERMÉS — quatre fonctions immuables qui sont les SEULES
--    autorités SQL : la liste des 14 emplacements de texte
--    configurables, le sous-ensemble exposé publiquement (11), la liste
--    blanche des 13 variables de gabarit, et la liste des 3 événements
--    e-mail additionnels. Toutes sont MIROIR EXACT de leurs homologues
--    TypeScript (lib/communications/*), et un test structurel compare
--    les deux listes caractère par caractère -- jamais la vigilance.
--
-- B. TEXTES MARCHANDS — public.merchant_communication_text : au plus un
--    texte par (restaurant, emplacement). MÊME modèle que
--    merchant_tracking_status_text (DDL, RLS, RPC-only en écriture,
--    suppression de la ligne quand le corps devient vide) ; DOMAINE
--    distinct, car un emplacement de communication n'est pas un statut
--    de commande et ne doit pas pouvoir en fabriquer un.
--    TEXTE BRUT uniquement -- aucun HTML marchand n'est stocké, aucun
--    n'est rendu : le modèle de rendu sûr déjà en place (lib/legal/
--    render.ts : valeur typée insérée dans une structure plateforme,
--    tout échappé) est conservé tel quel.
--
-- C. ÉVÉNEMENTS OPTIONNELS — public.merchant_communication_event :
--    interrupteur par (restaurant, événement), FERMÉ AU REPOS. Une
--    ligne absente ne vaut jamais permission d'émettre.
--    `order_received` n'y figure PAS : son autorité reste
--    merchant_notification_profile.email_enabled, non dupliquée.
--
-- D. PROJECTION PUBLIQUE — get_restaurant_public_communication_texts :
--    les 11 emplacements que le client doit voir, pour UN restaurant
--    passé en argument. Les 3 emplacements de gabarit d'e-mail n'y sont
--    JAMAIS inclus (lecture serveur seulement), même non affichés --
--    retrait fait à la frontière, pas à l'affichage, exactement comme
--    lib/services/restaurant.ts retire `withdrawal_eligible`.
--
-- E. PREUVE D'ÉLIGIBILITÉ RÉTRACTATION — public.
--    order_has_withdrawal_eligible_line(order_id, public_token) : un
--    BOOLÉEN, rien d'autre. LIT l'instantané existant
--    order_items.withdrawal_eligible_at_order_time. N'ÉCRIT RIEN, ne
--    recalcule rien, ne touche à AUCUNE règle d'éligibilité (mandat,
--    littéral : « Do NOT alter withdrawal eligibility rules in this
--    lot »). Même preuve de possession anonyme que
--    get_order_invoice_request, même posture service_role.
--
-- F. FILE EXISTANTE ÉTENDUE — le CHECK de
--    notification_outbox.notification_type reçoit 3 valeurs, et
--    public.create_order_communication_notification enfile dans la
--    MÊME table, avec la MÊME unicité logique
--    (restaurant_id, order_id, notification_type) -- donc la MÊME
--    idempotence, sans nouveau mécanisme.
--
-- CE QUE CE LOT NE FAIT PAS :
--   - AUCUN second système de notification : ni table de file, ni
--     worker, ni clé d'idempotence, ni taxonomie d'erreurs nouvelle ;
--   - AUCUNE modification de create_order (signature, corps, retour) ;
--   - AUCUNE modification de claim_pending_notifications, de
--     complete_notification_attempt, de reap_stale_notification_claims,
--     de merchant_notification_profile ni de
--     merchant_tracking_status_text ;
--
-- SEULE FONCTION PRÉEXISTANTE REDÉFINIE :
--   public.create_order_received_notification(uuid,uuid) — CREATE OR
--   REPLACE, MÊME signature, MÊME retour, MÊME garde anti-substitution
--   tenant, MÊME échelle d'éligibilité, MÊME idempotence. Son
--   payload_snapshot gagne 7 clés ADDITIVES (gabarits marchands de sujet
--   et de corps, les trois coordonnées du commerçant, la demande de
--   facture et l'éligibilité à la rétractation) — aucune clé
--   existante retirée ni renommée, donc un worker antérieur lit toujours
--   le même instantané.
--   POURQUOI LÀ ET PAS DANS LE WORKER : l'architecture de ce dépôt veut
--   qu'un e-mail soit rendu depuis un INSTANTANÉ FIGÉ à l'enfilement, et
--   que le worker ne refasse AUCUNE lecture métier. Faire lire les
--   gabarits au worker au moment de l'envoi violerait cette règle et
--   rendrait le contenu d'un e-mail dépendant de l'état de la
--   configuration à l'instant de l'envoi. C'est exactement le chemin que
--   CFTE v1 avait déjà pris pour status_text_override : ce lot le suit,
--   il n'en invente pas un autre.
--   - AUCUNE règle d'éligibilité à la rétractation touchée ; aucune
--     écriture dans withdrawal_requests ni dans order_items ;
--   - AUCUN appel fournisseur : ni Stuart, ni Chronofresh, ni aucune API
--     transporteur. Une « remise au transporteur » est un FAIT DÉCLARÉ
--     par le commerçant, jamais une information reçue d'un tiers ;
--   - AUCUN modèle de créneau/date de livraison inventé : il n'en
--     existe pas dans ce dépôt, et ce lot n'en crée pas. Les variables
--     {fulfillment_date}/{fulfillment_slot} sont RÉSERVÉES dans la liste
--     blanche et se rendent en chaîne vide tant qu'aucune donnée ne les
--     alimente (voir MCC-V1-UNKNOWN-VARIABLE-RULE) ;
--   - AUCUNE RLS affaiblie, AUCUN grant élargi, aucun backfill.
--
-- ISOLATION MULTI-TENANT (mandat §E) — trois garanties STRUCTURELLES,
-- pas trois intentions :
--   1. clé primaire (restaurant_id, text_key) : un texte APPARTIENT à un
--      restaurant, il n'existe pas de ligne « globale » qui pourrait
--      fuir ;
--   2. écriture RPC-only sous has_role_in(p_restaurant_id, ...) : aucun
--      GRANT INSERT/UPDATE/DELETE à authenticated, donc aucune écriture
--      directe possible même avec une RLS mal rédigée ;
--   3. lecture publique par projection SECURITY DEFINER filtrée sur le
--      p_restaurant_id reçu, et émission e-mail dont l'identité
--      d'expéditeur est résolue par claim_pending_notifications via le
--      restaurant_id DE LA LIGNE d'outbox -- jamais un identifiant
--      fourni par l'appelant. Cette jointure existante n'est pas
--      réécrite ici : elle porte déjà l'isolation.
--
-- ATOMICITÉ (reprise de CFTE-V1-SQL-ATOMICITY-01, convention du dépôt) :
-- UNE seule transaction explicite, et TOUT y est enfermé -- le pré-vol,
-- la totalité du DDL, ET le post-vol. `commit;` est la DERNIÈRE
-- instruction exécutable du fichier. Un pré-vol ou un post-vol qui lève
-- interrompt donc la transaction AVANT le commit : la base retombe à son
-- état antérieur, jamais un lot à moitié appliqué. Cette garantie ne
-- dépend pas de `-v ON_ERROR_STOP=1`.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL — anti-dérive et anti-double-application.
--    DANS la transaction : un prérequis absent annule tout.
-- ------------------------------------------------------------
do $$
declare
  v_check_name text;
begin
  if to_regclass('public.restaurants') is null
     or to_regclass('public.restaurant_users') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
     or to_regclass('public.notification_outbox') is null
     or to_regclass('public.merchant_notification_profile') is null
     or to_regclass('public.merchant_tracking_status_text') is null
     or to_regclass('public.restaurant_configs') is null
     or to_regclass('public.merchant_legal_profile') is null
     or to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: prérequis de table absents -- MERCHANT CUSTOMER COMMUNICATIONS v1 annulé.';
  end if;

  if to_regprocedure('public.is_member_of(uuid)') is null
     or to_regprocedure('public.has_role_in(uuid,text[])') is null
     or to_regprocedure('public.is_scanym_operator()') is null
     or to_regprocedure('public.touch_updated_at()') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: fonctions d''appui (is_member_of/has_role_in/is_scanym_operator/touch_updated_at) absentes -- annulé.';
  end if;

  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification(uuid,uuid) absente -- la file existante doit préexister. Annulé.';
  end if;

  -- Ce lot REMPLACE create_order_received_notification. Le remplacement
  -- n'est légitime que si le prédécesseur est bien la version CFTE v1
  -- (reconnaissable à ses 4 clés additives) : sur une version plus
  -- récente et inconnue, le remplacement perdrait silencieusement ce
  -- qu'elle aurait ajouté. On refuse plutôt que d'écraser.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_received_notification'
      and pg_get_functiondef(p.oid) like '%status_text_override%'
      and pg_get_functiondef(p.oid) like '%merchant_name%'
      and pg_get_functiondef(p.oid) like '%delivery_address%'
      and pg_get_functiondef(p.oid) like '%order_status%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification n''est pas la version CFTE v1 attendue -- le remplacer perdrait un ajout inconnu. Annulé.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_received_notification'
      and pg_get_functiondef(p.oid) like '%subject_template%'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: create_order_received_notification porte déjà subject_template -- annulé.';
  end if;

  -- L'instantané d'éligibilité à la rétractation est LU par ce lot. S'il
  -- n'existe pas, le bouton de rétractation du parcours client serait
  -- décidé sur une absence de donnée -- donc affiché par défaut ou
  -- masqué par hasard. On refuse plutôt que de deviner.
  if not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_items'
      and a.attname = 'withdrawal_eligible_at_order_time'
      and not a.attisdropped
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: order_items.withdrawal_eligible_at_order_time absente -- ONLINE WITHDRAWAL FOUNDATION v1 doit être appliqué avant. Annulé.';
  end if;

  -- Le CHECK de notification_type doit exister ET porter le nom attendu :
  -- ce lot le remplace, et un remplacement à l'aveugle sur une
  -- contrainte renommée en laisserait DEUX, dont l'ancienne refuserait
  -- les nouveaux types sans que rien ne le signale.
  select con.conname into v_check_name
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_outbox'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%notification_type%';

  if v_check_name is distinct from 'notification_outbox_notification_type_check' then
    raise exception 'SCANYM_SCHEMA_DRIFT: CHECK de notification_outbox.notification_type introuvable ou renommé (trouvé: %) -- annulé.', coalesce(v_check_name, '<aucun>');
  end if;

  -- Anti-double-application.
  if to_regclass('public.merchant_communication_text') is not null
     or to_regclass('public.merchant_communication_event') is not null
     or to_regprocedure('public.communication_text_keys()') is not null
     or to_regprocedure('public.communication_template_variables()') is not null
     or to_regprocedure('public.communication_event_body_text_key(text)') is not null
     or to_regprocedure('public.set_merchant_communication_text(uuid,text,text)') is not null
     or to_regprocedure('public.get_restaurant_public_communication_texts(uuid)') is not null
     or to_regprocedure('public.order_has_withdrawal_eligible_line(uuid,uuid)') is not null
     or to_regprocedure('public.create_order_communication_notification(uuid,uuid,text)') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: MERCHANT CUSTOMER COMMUNICATIONS v1 déjà (partiellement) appliqué -- annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- A. CATALOGUES FERMÉS — seules autorités SQL.
--    Fonctions et non tables de référence : une liste fermée qui ne
--    s'administre pas n'a pas besoin de RLS, et une fonction immuable ne
--    peut pas être modifiée par une écriture tenant.
--    MIROIR EXACT de lib/communications/text-keys.ts,
--    lib/communications/template-variables.ts et
--    lib/communications/events.ts.
-- ------------------------------------------------------------
create function public.communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'checkout_info',
    'pickup_explanation',
    'delivery_local_explanation',
    'delivery_carrier_explanation',
    'slot_warning',
    'sanitary_warning',
    'order_success_title',
    'order_success_body',
    'confirmation_pickup',
    'confirmation_delivery_local',
    'confirmation_delivery_carrier',
    'email_confirmation_subject',
    'email_confirmation_body',
    'confirmation_withdrawal_request'
  ]::text[]
$$;

comment on function public.communication_text_keys() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — catalogue FERMÉ des 14 emplacements de texte customer-facing configurables. Miroir exact de COMMUNICATION_TEXT_KEYS (lib/communications/text-keys.ts). Aucun GRANT applicatif : autorité interne, appelée par le CHECK et par les RPC de ce lot.';

revoke all on function public.communication_text_keys() from public, anon, authenticated, service_role;

-- Sous-ensemble EXPOSÉ au client anonyme. Les 3 gabarits d'e-mail en
-- sont ABSENTS : un gabarit est une configuration interne du
-- commerçant, pas un contenu de vitrine.
create function public.public_communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'checkout_info',
    'pickup_explanation',
    'delivery_local_explanation',
    'delivery_carrier_explanation',
    'slot_warning',
    'sanitary_warning',
    'order_success_title',
    'order_success_body',
    'confirmation_pickup',
    'confirmation_delivery_local',
    'confirmation_delivery_carrier'
  ]::text[]
$$;

comment on function public.public_communication_text_keys() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — les 11 emplacements exposés à la projection publique anonyme. Miroir exact de PUBLIC_COMMUNICATION_TEXT_KEYS. Les 3 gabarits d''e-mail (email_confirmation_subject/body, confirmation_withdrawal_request) en sont volontairement exclus.';

revoke all on function public.public_communication_text_keys() from public, anon, authenticated, service_role;

create function public.communication_template_variables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'merchant_name',
    'order_reference',
    'order_total',
    'fulfillment_type',
    'fulfillment_date',
    'fulfillment_slot',
    'merchant_address',
    'merchant_email',
    'merchant_phone',
    'carrier_name',
    'invoice_requested',
    'withdrawal_link',
    'withdrawal_eligible'
  ]::text[]
$$;

comment on function public.communication_template_variables() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — liste BLANCHE STRICTE des 13 variables de gabarit. Miroir exact de COMMUNICATION_TEMPLATE_VARIABLES (lib/communications/template-variables.ts). fulfillment_date/fulfillment_slot sont RÉSERVÉES : aucun modèle de créneau n''existe dans ce dépôt, elles se rendent en chaîne vide.';

revoke all on function public.communication_template_variables() from public, anon, authenticated, service_role;

create function public.communication_event_codes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'carrier_handoff',
    'local_delivery_handoff',
    'withdrawal_request_received'
  ]::text[]
$$;

comment on function public.communication_event_codes() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — les 3 événements e-mail additionnels. order_received n''y figure PAS : son autorité d''activation reste merchant_notification_profile.email_enabled, jamais dupliquée.';

revoke all on function public.communication_event_codes() from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- v1.1 — CARTOGRAPHIE ÉVÉNEMENT -> GABARIT DE CORPS.
--
-- Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 (audit indépendant
-- OpenAI/Codex, blocker 2).
--
-- v1 figeait dans l'instantané de CHAQUE événement additionnel le
-- couple GÉNÉRIQUE `email_confirmation_subject`/`email_confirmation_body`
-- ET, en plus, `confirmation_withdrawal_request` -- que le worker ne
-- lisait jamais. Deux défauts en un : la formulation d'accusé de
-- rétractation du commerçant était PERSISTÉE PUIS IGNORÉE, et les trois
-- événements se partageaient silencieusement la formulation de l'e-mail
-- de CONFIRMATION DE COMMANDE, dont le nom dit pourtant à quoi elle
-- sert.
--
-- Cette fonction est désormais la SEULE autorité de la correspondance,
-- et elle est LÉGIBLE : chaque événement reçoit l'emplacement du
-- catalogue dont le NOM décrit ce qu'il dit.
--
--   carrier_handoff             -> confirmation_delivery_carrier
--   local_delivery_handoff      -> confirmation_delivery_local
--   withdrawal_request_received -> confirmation_withdrawal_request
--
-- AUCUN nouvel emplacement, AUCUNE formulation inventée : les trois
-- clés existaient déjà au catalogue v1 (mandat §A les énumère : « carrier-
-- prepared/shipped wording », « local-delivery confirmation wording »,
-- « withdrawal request confirmation wording »).
--
-- `email_confirmation_subject` / `email_confirmation_body` ne concernent
-- donc PLUS que `order_received` -- l'e-mail de confirmation de commande,
-- celui dont ils portent le nom. Aucun événement additionnel ne peut
-- plus les emprunter : la fonction ne les renvoie jamais.
--
-- NOTE D'EXPOSITION, assumée : les deux clés de livraison sont dans la
-- projection PUBLIQUE, parce que l'écran de confirmation les affiche
-- aussi. C'est la MÊME formulation marchande sur les deux surfaces pour
-- le MÊME événement -- voulu, et non une fuite : ce texte est écrit par
-- le commerçant POUR ses clients. `confirmation_withdrawal_request`,
-- lui, reste hors projection publique (serveur seulement).
-- ------------------------------------------------------------
create function public.communication_event_body_text_key(p_event_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_event_code
    when 'carrier_handoff'             then 'confirmation_delivery_carrier'
    when 'local_delivery_handoff'      then 'confirmation_delivery_local'
    when 'withdrawal_request_received' then 'confirmation_withdrawal_request'
    else null
  end
$$;

comment on function public.communication_event_body_text_key(text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1.1 — SEULE autorité de la correspondance événement -> emplacement de CORPS. Miroir exact de COMMUNICATION_EVENT_BODY_TEXT_KEY (lib/communications/events.ts). Ne renvoie JAMAIS email_confirmation_subject/body : ceux-ci ne concernent que order_received. Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01.';

revoke all on function public.communication_event_body_text_key(text) from public, anon, authenticated, service_role;

-- Longueur maximale PAR emplacement. Miroir de
-- COMMUNICATION_TEXT_SPEC[...].maxLength.
create function public.communication_text_max_length(p_text_key text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_text_key = 'email_confirmation_subject' then 160 else 500 end
$$;

comment on function public.communication_text_max_length(text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — longueur maximale par emplacement : 160 pour un sujet d''e-mail (au-delà, le client de messagerie tronque lui-même), 500 ailleurs (aligné sur restaurant_sale_modes.customer_text). Miroir de COMMUNICATION_SUBJECT_MAX_LENGTH / COMMUNICATION_TEXT_MAX_LENGTH.';

revoke all on function public.communication_text_max_length(text) from public, anon, authenticated, service_role;

-- Jetons `{...}` d'un gabarit qui ne figurent PAS dans la liste blanche.
-- Même classe de caractères que PLACEHOLDER_PATTERN côté TypeScript
-- (`[a-z0-9_]`) : `{{`, `{ `, `{1+1}` ne sont pas des emplacements et
-- traversent intacts. Ce n'est pas un moteur de gabarit : il n'y a ni
-- expression, ni appel, ni chemin de propriété interprétable.
-- plpgsql et NON sql : une fonction `language sql` dont le corps est une
-- expression unique peut être INLINÉE par le planificateur, et son
-- sous-SELECT atterrirait alors dans l'expression de la contrainte CHECK
-- qui l'appelle -- ce que PostgreSQL refuse (« cannot use subquery in
-- check constraint »). Un corps plpgsql est opaque à l'inlining : la
-- contrainte reste un simple appel de fonction.
create function public.communication_template_unknown_variables(p_template text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_unknown text[];
begin
  select coalesce(pg_catalog.array_agg(distinct m[1]), '{}'::text[])
  into v_unknown
  from pg_catalog.regexp_matches(
         coalesce(p_template, ''),
         '\{([a-z0-9_]+)\}',
         'g'
       ) as m
  where not (m[1] = any(public.communication_template_variables()));

  return coalesce(v_unknown, '{}'::text[]);
end $$;

comment on function public.communication_template_unknown_variables(text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — jetons {x} hors liste blanche. Support de MCC-V1-UNKNOWN-VARIABLE-RULE côté ÉCRITURE : le RPC refuse le gabarit (22023). Au RENDU, l''inconnu est ignoré sans bruit (chaîne vide) -- voir lib/communications/template-variables.ts.';

revoke all on function public.communication_template_unknown_variables(text) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- B. TEXTES MARCHANDS.
--    Modèle repris de merchant_tracking_status_text : clé primaire
--    composite portant le tenant, RLS, lecture tenant par policy,
--    écriture RPC-only, texte BRUT borné.
-- ------------------------------------------------------------
create table public.merchant_communication_text (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  text_key      text not null,
  -- TEXTE BRUT. Jamais du HTML : l'échappement est appliqué à la
  -- frontière de rendu (lib/server/notifications/* pour l'e-mail, nœud
  -- texte React pour l'écran). Aucun chemin de ce dépôt ne transforme ce
  -- contenu en balisage.
  body          text,
  updated_at    timestamptz not null default pg_catalog.now(),
  primary key (restaurant_id, text_key),
  constraint merchant_communication_text_key_check
    check (text_key = any(public.communication_text_keys())),
  -- Borne GÉNÉRALE, défense en profondeur ; la borne PAR emplacement
  -- (160 pour un sujet) est appliquée par le RPC, seule voie d'écriture.
  constraint merchant_communication_text_body_length
    check (body is null or pg_catalog.length(pg_catalog.btrim(body)) <= 500),
  -- Liste blanche de variables appliquée EN BASE aussi : même un appel
  -- service_role direct ne peut pas stocker un gabarit à jeton inconnu.
  constraint merchant_communication_text_known_variables
    check (pg_catalog.cardinality(public.communication_template_unknown_variables(body)) = 0)
);

comment on table public.merchant_communication_text is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — au plus un texte customer-facing par (restaurant, emplacement). Texte BRUT borné, jamais du HTML. Écriture RPC-only (set_merchant_communication_text, owner/manager ou opérateur) ; lecture tenant par RLS ; lecture client par la projection publique filtrée get_restaurant_public_communication_texts. Une ligne absente = comportement actuel de la plateforme (compatibilité arrière exacte), jamais un texte vide affiché.';

create trigger trg_touch_updated_at
  before update on public.merchant_communication_text
  for each row execute function public.touch_updated_at();

alter table public.merchant_communication_text enable row level security;
revoke all on public.merchant_communication_text from public, anon, authenticated;
grant select on public.merchant_communication_text to authenticated;

-- Lecture back-office : membre du restaurant, ou opérateur Scanym.
-- Aucune policy INSERT/UPDATE/DELETE, et aucun GRANT correspondant :
-- l'écriture directe est structurellement impossible, pas seulement
-- interdite par une policy qu'un futur lot pourrait assouplir.
create policy "merchant_communication_text_select_member_or_operator"
on public.merchant_communication_text
for select
to authenticated
using (
  public.is_member_of(merchant_communication_text.restaurant_id)
  or public.is_scanym_operator()
);

-- ------------------------------------------------------------
-- C. ÉVÉNEMENTS OPTIONNELS — FERMÉS AU REPOS.
-- ------------------------------------------------------------
create table public.merchant_communication_event (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  event_code    text not null,
  enabled       boolean not null default false,
  updated_at    timestamptz not null default pg_catalog.now(),
  primary key (restaurant_id, event_code),
  constraint merchant_communication_event_code_check
    check (event_code = any(public.communication_event_codes()))
);

comment on table public.merchant_communication_event is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — interrupteur par (restaurant, événement e-mail additionnel). MCC-V1-FAIL-CLOSED-EVENTS : une ligne ABSENTE vaut DÉSACTIVÉ, jamais permission d''émettre -- y compris pour carrier_handoff. Écriture RPC-only.';

create trigger trg_touch_updated_at
  before update on public.merchant_communication_event
  for each row execute function public.touch_updated_at();

alter table public.merchant_communication_event enable row level security;
revoke all on public.merchant_communication_event from public, anon, authenticated;
grant select on public.merchant_communication_event to authenticated;

create policy "merchant_communication_event_select_member_or_operator"
on public.merchant_communication_event
for select
to authenticated
using (
  public.is_member_of(merchant_communication_event.restaurant_id)
  or public.is_scanym_operator()
);

-- ------------------------------------------------------------
-- D. ÉCRITURE DES TEXTES — RPC unique, ordre de contrôle identique à
--    set_merchant_tracking_status_text (séance d'abord, arguments,
--    autorisation, catalogue, longueur, puis effet).
-- ------------------------------------------------------------
create function public.set_merchant_communication_text(
  p_restaurant_id uuid,
  p_text_key      text,
  p_body          text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body    text;
  v_unknown text[];
begin
  if auth.uid() is null then
    raise exception 'SCANYM_NOT_AUTHENTICATED: session requise.' using errcode = '28000';
  end if;

  if p_restaurant_id is null or p_text_key is null then
    raise exception 'SCANYM_INVALID_ARGUMENT: p_restaurant_id/p_text_key requis.' using errcode = '22023';
  end if;

  if not (
    public.has_role_in(p_restaurant_id, array['owner', 'manager'])
    or public.is_scanym_operator()
  ) then
    -- Message volontairement NON informatif : il ne révèle pas si le
    -- restaurant existe (même posture que les RPC de ce dépôt).
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  if not (p_text_key = any(public.communication_text_keys())) then
    raise exception 'SCANYM_COMMUNICATION_UNKNOWN_TEXT_KEY: emplacement % inconnu.', p_text_key
      using errcode = '22023';
  end if;

  -- Blanc / vide / NULL = « pas de surcharge » : la LIGNE EST SUPPRIMÉE.
  -- Jamais stockée comme chaîne vide, qui serait ensuite indiscernable
  -- d'un texte volontairement vide et afficherait un bloc creux.
  v_body := nullif(pg_catalog.btrim(coalesce(p_body, '')), '');
  if v_body is null then
    delete from public.merchant_communication_text
    where restaurant_id = p_restaurant_id and text_key = p_text_key;
    return;
  end if;

  if pg_catalog.length(v_body) > public.communication_text_max_length(p_text_key) then
    raise exception 'SCANYM_COMMUNICATION_TEXT_TOO_LONG: % caractères maximum pour %.',
      public.communication_text_max_length(p_text_key), p_text_key
      using errcode = '22001';
  end if;

  -- MCC-V1-UNKNOWN-VARIABLE-RULE, moitié ÉCRITURE : échec de
  -- validation, rien n'est stocké. Le nom fautif EST renvoyé : c'est une
  -- saisie du commerçant lui-même, pas un secret.
  v_unknown := public.communication_template_unknown_variables(v_body);
  if pg_catalog.cardinality(v_unknown) > 0 then
    raise exception 'SCANYM_COMMUNICATION_UNKNOWN_VARIABLE: variable(s) inconnue(s) %.',
      pg_catalog.array_to_string(v_unknown, ', ')
      using errcode = '22023';
  end if;

  insert into public.merchant_communication_text (restaurant_id, text_key, body)
  values (p_restaurant_id, p_text_key, v_body)
  on conflict (restaurant_id, text_key)
  do update set body = excluded.body, updated_at = pg_catalog.now();
end $$;

comment on function public.set_merchant_communication_text(uuid, text, text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — SEULE voie d''écriture de merchant_communication_text. owner/manager du restaurant ou opérateur Scanym. Corps vide/blanc => la ligne est SUPPRIMÉE (repli sur le comportement actuel). Emplacement hors catalogue => 22023 ; trop long => 22001 ; variable hors liste blanche => 22023 (MCC-V1-UNKNOWN-VARIABLE-RULE, moitié écriture). N''écrit dans aucune autre table.';

revoke all on function public.set_merchant_communication_text(uuid, text, text) from public, anon;
grant execute on function public.set_merchant_communication_text(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- E. ÉCRITURE DES INTERRUPTEURS D'ÉVÉNEMENT.
-- ------------------------------------------------------------
create function public.set_merchant_communication_event_enabled(
  p_restaurant_id uuid,
  p_event_code    text,
  p_enabled       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'SCANYM_NOT_AUTHENTICATED: session requise.' using errcode = '28000';
  end if;

  if p_restaurant_id is null or p_event_code is null or p_enabled is null then
    raise exception 'SCANYM_INVALID_ARGUMENT: p_restaurant_id/p_event_code/p_enabled requis.' using errcode = '22023';
  end if;

  if not (
    public.has_role_in(p_restaurant_id, array['owner', 'manager'])
    or public.is_scanym_operator()
  ) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  if not (p_event_code = any(public.communication_event_codes())) then
    raise exception 'SCANYM_COMMUNICATION_UNKNOWN_EVENT: événement % inconnu.', p_event_code
      using errcode = '22023';
  end if;

  -- Désactiver = SUPPRIMER la ligne, pour que « absent » et « false »
  -- soient un seul et même état. Deux représentations du même refus
  -- finissent toujours par divergir.
  if p_enabled is not true then
    delete from public.merchant_communication_event
    where restaurant_id = p_restaurant_id and event_code = p_event_code;
    return;
  end if;

  insert into public.merchant_communication_event (restaurant_id, event_code, enabled)
  values (p_restaurant_id, p_event_code, true)
  on conflict (restaurant_id, event_code)
  do update set enabled = true, updated_at = pg_catalog.now();
end $$;

comment on function public.set_merchant_communication_event_enabled(uuid, text, boolean) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — SEULE voie d''écriture de merchant_communication_event. Désactiver SUPPRIME la ligne : « absent » et « désactivé » sont un seul état (MCC-V1-FAIL-CLOSED-EVENTS).';

revoke all on function public.set_merchant_communication_event_enabled(uuid, text, boolean) from public, anon;
grant execute on function public.set_merchant_communication_event_enabled(uuid, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- F. PROJECTION PUBLIQUE ANONYME — 11 emplacements, UN restaurant.
--    Même posture que get_restaurant_public_sale_modes : SECURITY
--    DEFINER, filtrée sur l'argument, n'expose aucune colonne de
--    configuration interne.
-- ------------------------------------------------------------
create function public.get_restaurant_public_communication_texts(
  p_restaurant_id uuid
)
returns table (
  text_key text,
  body     text
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.text_key, m.body
  from public.merchant_communication_text m
  where m.restaurant_id = p_restaurant_id
    -- Filtre d'EXPOSITION : les 3 gabarits d'e-mail ne sortent jamais
    -- par ce chemin, même si un appelant les demandait.
    and m.text_key = any(public.public_communication_text_keys())
    and m.body is not null
  order by m.text_key
$$;

comment on function public.get_restaurant_public_communication_texts(uuid) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — projection PUBLIQUE des 11 emplacements customer-facing d''UN restaurant. Les gabarits d''e-mail (email_confirmation_subject/body, confirmation_withdrawal_request) sont exclus STRUCTURELLEMENT. Ne révèle aucune configuration interne, aucun autre tenant.';

revoke all on function public.get_restaurant_public_communication_texts(uuid) from public;
grant execute on function public.get_restaurant_public_communication_texts(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- G. PREUVE D'ÉLIGIBILITÉ À LA RÉTRACTATION — un booléen, rien d'autre.
--    LIT l'instantané existant. N'ÉCRIT RIEN. NE CHANGE AUCUNE RÈGLE.
-- ------------------------------------------------------------
create function public.order_has_withdrawal_eligible_line(
  p_order_id     uuid,
  p_public_token uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.id = p_order_id
      and o.public_token = p_public_token
      -- `is true` et non `= true` : un instantané NULL (ligne
      -- antérieure au déclencheur, jamais rétro-remplie) ne vaut PAS
      -- éligible. L'absence de preuve ne vaut pas preuve.
      and oi.withdrawal_eligible_at_order_time is true
  )
$$;

comment on function public.order_has_withdrawal_eligible_line(uuid, uuid) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — « au moins une ligne de cette commande est-elle rétractable ? », sous la MÊME preuve de possession anonyme (order_id + public_token) que get_order_invoice_request. LIT order_items.withdrawal_eligible_at_order_time ; n''écrit rien et ne modifie AUCUNE règle d''éligibilité. Couple inconnu => false (fail-closed : pas de CTA), jamais une erreur qui révélerait l''existence de la commande.';

revoke all on function public.order_has_withdrawal_eligible_line(uuid, uuid) from public, anon, authenticated;
grant execute on function public.order_has_withdrawal_eligible_line(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- G-bis. COORDONNÉES DU COMMERÇANT — une seule autorité, appelée par
--        les DEUX fonctions d'enfilement, pour que les variables
--        {merchant_address}/{merchant_email}/{merchant_phone} aient
--        rigoureusement la même provenance partout.
--
--        PRÉCÉDENCE : les coordonnées PUBLIQUES explicitement destinées
--        aux clients (restaurant_configs.public_email/public_phone,
--        posées par CUSTOMER CONTACT + LIVE TRACKING v1) d'abord ;
--        à défaut, le contact du SERVICE CLIENT du profil légal
--        (merchant_legal_profile.customer_service_*), déjà employé
--        comme tel par l'accusé de rétractation existant. Jamais
--        l'adresse e-mail de NOTIFICATION (merchant_notification_profile
--        .sender_email) : c'est une identité d'expédition technique, pas
--        un contact client, et les confondre publierait l'une pour
--        l'autre.
-- ------------------------------------------------------------
create function public.merchant_communication_contact(p_restaurant_id uuid)
returns table (
  contact_address text,
  contact_email   text,
  contact_phone   text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    nullif(btrim(coalesce(
      rc.address,
      nullif(btrim(coalesce(lp.address_line1, '') || ' ' ||
                   coalesce(lp.postal_code, '')  || ' ' ||
                   coalesce(lp.city, '')), '')
    )), ''),
    nullif(btrim(coalesce(rc.public_email, lp.customer_service_email, '')), ''),
    nullif(btrim(coalesce(rc.public_phone, lp.customer_service_phone, '')), '')
  from public.restaurants r
  left join public.restaurant_configs rc on rc.restaurant_id = r.id
  left join public.merchant_legal_profile lp on lp.restaurant_id = r.id
  where r.id = p_restaurant_id
$$;

comment on function public.merchant_communication_contact(uuid) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — SEULE autorité de provenance des coordonnées commerçant insérées dans les gabarits. Précédence : contact PUBLIC (restaurant_configs.public_email/public_phone) puis contact SERVICE CLIENT (merchant_legal_profile). JAMAIS merchant_notification_profile.sender_email, qui est une identité d''expédition technique. Aucun GRANT applicatif : appelée par les fonctions d''enfilement SECURITY DEFINER de ce lot.';

revoke all on function public.merchant_communication_contact(uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- H. FILE EXISTANTE — 3 valeurs ajoutées au CHECK, aucune retirée.
--    DROP puis ADD de la MÊME contrainte nommée : jamais deux
--    contraintes concurrentes dont l'ancienne refuserait les nouveaux
--    types. Les 9 valeurs historiques sont reproduites À L'IDENTIQUE.
-- ------------------------------------------------------------
alter table public.notification_outbox
  drop constraint notification_outbox_notification_type_check;

alter table public.notification_outbox
  add constraint notification_outbox_notification_type_check
  check (notification_type in (
    -- Les 9 valeurs de N1-A, inchangées.
    'order_received',
    'order_accepted', 'order_preparing', 'order_ready', 'order_delivered',
    'order_cancelled', 'order_rejected', 'delivery_failed', 'refund_issued',
    -- MERCHANT CUSTOMER COMMUNICATIONS v1 — 3 ajouts, miroir exact de
    -- COMMUNICATION_EVENT_CODES (lib/communications/events.ts).
    'carrier_handoff', 'local_delivery_handoff', 'withdrawal_request_received'
  ));

-- ------------------------------------------------------------
-- I. ENFILEMENT GÉNÉRIQUE DES ÉVÉNEMENTS ADDITIONNELS.
--    MÊME table, MÊME unicité logique, MÊME échelle d'éligibilité que
--    create_order_received_notification -- dont le corps n'est PAS
--    modifié. Ce n'est pas une seconde file : c'est le même quai.
-- ------------------------------------------------------------
create function public.create_order_communication_notification(
  p_order_id          uuid,
  p_restaurant_id     uuid,
  p_notification_type text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order          public.orders%rowtype;
  v_profile        public.merchant_notification_profile%rowtype;
  v_event_enabled  boolean;
  v_locale         text;
  v_status         text;
  v_payload        jsonb;
  v_outbox_id      uuid;
  v_merchant_name  text;
  v_event_body_tpl text;
  v_withdrawable   boolean;
  v_contact        record;
  v_invoice        boolean;
begin
  if p_order_id is null or p_restaurant_id is null or p_notification_type is null then
    raise exception 'SCANYM_INVALID_ARGUMENT: p_order_id/p_restaurant_id/p_notification_type requis.'
      using errcode = '22023';
  end if;

  if not (p_notification_type = any(public.communication_event_codes())) then
    raise exception 'SCANYM_COMMUNICATION_UNKNOWN_EVENT: événement % inconnu.', p_notification_type
      using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  -- Substitution tenant croisée : refusée STRUCTURELLEMENT, jamais une
  -- absence silencieuse de résultat. Garde copiée telle quelle de
  -- create_order_received_notification -- jamais affaiblie.
  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %',
      p_order_id, p_restaurant_id using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  -- MCC-V1-FAIL-CLOSED-EVENTS : ligne absente => désactivé.
  select e.enabled into v_event_enabled
  from public.merchant_communication_event e
  where e.restaurant_id = p_restaurant_id and e.event_code = p_notification_type;

  v_locale := case
    when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language
    else 'fr'
  end;

  -- MÊME échelle que create_order_received_notification, avec UN barreau
  -- de plus pour l'interrupteur propre à l'événement. Une ligne est
  -- TOUJOURS créée (auditabilité : on sait pourquoi rien n'est parti),
  -- mais en 'skipped_*' et jamais en 'pending'.
  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    when v_event_enabled is not true then 'skipped_disabled'
    else 'pending'
  end;

  select r.name into v_merchant_name
  from public.restaurants r where r.id = p_restaurant_id;

  -- v1.1 — UN SEUL gabarit, celui que la cartographie désigne POUR CET
  -- ÉVÉNEMENT, FIGÉ dans l'instantané comme tout le reste : le worker ne
  -- refait aucune lecture métier au moment de l'envoi. Un changement de
  -- gabarit APRÈS enfilement n'altère donc pas un e-mail déjà en file --
  -- et ne peut pas non plus faire basculer son contenu vers celui d'un
  -- autre tenant, ni vers celui d'un autre ÉVÉNEMENT.
  --
  -- Absent (commerçant sans surcharge) : NULL, et le worker emploie la
  -- formulation PLATEFORME de cet événement. Jamais un repli silencieux
  -- sur le gabarit d'un autre événement -- c'est exactement le défaut
  -- que ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01.
  select m.body into v_event_body_tpl
  from public.merchant_communication_text m
  where m.restaurant_id = p_restaurant_id
    and m.text_key = public.communication_event_body_text_key(p_notification_type);

  -- Éligibilité LUE, jamais recalculée (voir G).
  select exists (
    select 1 from public.order_items oi
    where oi.order_id = p_order_id
      and oi.withdrawal_eligible_at_order_time is true
  ) into v_withdrawable;

  -- Coordonnées FIGÉES dans l'instantané, comme tout le reste.
  select * into v_contact from public.merchant_communication_contact(p_restaurant_id);

  -- Facture demandée : EXISTENCE seule de la ligne, jamais son contenu
  -- (aucune donnée de facturation n'entre dans un instantané d'e-mail).
  select exists (
    select 1 from public.order_invoice_request r where r.order_id = p_order_id
  ) into v_invoice;

  v_payload := jsonb_build_object(
    -- Les 6 clés que le worker existant exige déjà
    -- (isOrderReceivedPayload) : l'instantané d'un événement additionnel
    -- reste lisible par la même garde, aucune divergence de forme.
    'order_number', v_order.order_number,
    'total', v_order.total,
    'currency', v_order.currency,
    'service_mode', v_order.service_mode,
    'public_token', v_order.public_token,
    'created_at', v_order.created_at,
    'order_status', v_order.status,
    'merchant_name', v_merchant_name,
    'delivery_address',
      case when v_order.service_mode = 'delivery' then v_order.delivery_address else null end,
    -- Clés propres à ce lot, toutes ADDITIVES.
    'communication_event', p_notification_type,
    -- v1.1 : UNE clé de gabarit, celle de CET événement. Les clés
    -- `subject_template`/`body_template` ne sont PLUS posées ici : elles
    -- appartiennent à l'e-mail de confirmation de commande
    -- (order_received), et un événement additionnel ne doit pas pouvoir
    -- les emprunter. `withdrawal_template` disparaît aussi : elle était
    -- posée et jamais lue -- `event_body_template` la remplace et EST
    -- lue (tests/mcc-v1-email-events.test.ts §EVENT-TEMPLATE).
    'event_body_template', v_event_body_tpl,
    'withdrawal_eligible', v_withdrawable,
    'fulfillment_code', v_order.fulfillment_code,
    'provider_code', v_order.provider_code,
    'merchant_address', v_contact.contact_address,
    'merchant_email', v_contact.contact_email,
    'merchant_phone', v_contact.contact_phone,
    'invoice_requested', v_invoice
  );

  insert into public.notification_outbox (
    restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status
  ) values (
    p_restaurant_id, p_order_id, p_notification_type,
    v_order.customer_email, v_locale, v_payload, v_status
  )
  on conflict (restaurant_id, order_id, notification_type) do nothing
  returning id into v_outbox_id;

  -- NULL = une ligne logique existait déjà (rejeu idempotent). Ce n'est
  -- PAS une erreur : c'est exactement la garantie « pas de doublon à la
  -- reprise », portée par la contrainte d'unicité EXISTANTE.
  return v_outbox_id;
end $$;

comment on function public.create_order_communication_notification(uuid, uuid, text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — enfile un événement additionnel (carrier_handoff / local_delivery_handoff / withdrawal_request_received) dans la file EXISTANTE notification_outbox. Idempotente par la contrainte d''unicité existante (restaurant_id, order_id, notification_type). Refuse toute substitution tenant croisée. Fermée au repos : interrupteur d''événement absent => skipped_disabled. Les gabarits marchands sont FIGÉS dans payload_snapshot. Aucun envoi réseau, aucun appel fournisseur.';

revoke all on function public.create_order_communication_notification(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order_communication_notification(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- I-bis. create_order_received_notification — CREATE OR REPLACE.
--
--   MÊME signature (uuid, uuid), MÊME type de retour (uuid), MÊME garde
--   anti-substitution tenant, MÊME échelle d'éligibilité, MÊME
--   ON CONFLICT DO NOTHING (donc MÊME idempotence).
--
--   SEULE DIFFÉRENCE AVEC LA VERSION CFTE v1 : sept clés ADDITIVES dans
--   payload_snapshot — subject_template, body_template, merchant_address,
--   merchant_email, merchant_phone, invoice_requested,
--   withdrawal_eligible. Aucune clé existante n'est retirée
--   ni renommée : les 10 clés de CFTE v1 sont reproduites À L'IDENTIQUE,
--   dans le MÊME ORDRE, de sorte qu'un worker antérieur à ce lot lise
--   exactement le même instantané qu'avant.
--
--   Les gabarits sont lus ICI, à l'enfilement, et FIGÉS. Le worker ne
--   fait donc aucune lecture métier supplémentaire, et modifier un
--   gabarit après enfilement n'altère pas un e-mail déjà en file.
--
--   AUCUN ENFILEMENT N'EST AJOUTÉ NI RETIRÉ : cette fonction est, comme
--   avant, appelée par la reprise tenant (ORDER SUCCESS BOUNDARY v1) et
--   par service_role. create_order n'est pas touchée.
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
  -- MERCHANT CUSTOMER COMMUNICATIONS v1 (ajouts).
  v_subject_tpl     text;
  v_body_tpl        text;
  v_contact         record;
  v_invoice         boolean;
  v_withdrawable    boolean;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- Substitution tenant croisée : refusée structurellement, jamais une
  -- simple absence de résultat silencieuse.
  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %', p_order_id, p_restaurant_id
      using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  -- Snapshot déterministe de la locale -- jamais réinféré plus tard.
  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language else 'fr' end;

  -- Éligibilité INCHANGÉE (N1-A) : toujours une ligne outbox, marquée
  -- 'skipped_*' quand l'envoi n'est structurellement pas applicable.
  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    else 'pending'
  end;

  -- CFTE v1 — surcharge marchande applicable AU STATUT à cet instant.
  select m.body into v_status_override
  from public.merchant_tracking_status_text m
  where m.restaurant_id = p_restaurant_id
    and m.status = v_order.status;

  select r.name into v_merchant_name
  from public.restaurants r where r.id = p_restaurant_id;

  -- MCC v1 — gabarits marchands de l'e-mail de confirmation, FIGÉS.
  select m.body into v_subject_tpl
  from public.merchant_communication_text m
  where m.restaurant_id = p_restaurant_id and m.text_key = 'email_confirmation_subject';

  select m.body into v_body_tpl
  from public.merchant_communication_text m
  where m.restaurant_id = p_restaurant_id and m.text_key = 'email_confirmation_body';

  select * into v_contact from public.merchant_communication_contact(p_restaurant_id);

  select exists (
    select 1 from public.order_invoice_request r where r.order_id = p_order_id
  ) into v_invoice;

  -- Éligibilité à la rétractation LUE sur l'instantané par ligne de
  -- commande, jamais recalculée et jamais modifiée.
  select exists (
    select 1 from public.order_items oi
    where oi.order_id = p_order_id
      and oi.withdrawal_eligible_at_order_time is true
  ) into v_withdrawable;

  v_payload := jsonb_build_object(
    -- N1-A : les 6 clés d'origine, inchangées.
    'order_number', v_order.order_number,
    'total', v_order.total,
    'currency', v_order.currency,
    'service_mode', v_order.service_mode,
    'public_token', v_order.public_token,
    'created_at', v_order.created_at,
    -- CFTE v1 : les 4 clés additives, inchangées.
    'order_status', v_order.status,
    'status_text_override', v_status_override,
    'delivery_address',
      case when v_order.service_mode = 'delivery' then v_order.delivery_address else null end,
    'merchant_name', v_merchant_name,
    -- MCC v1 : 7 clés additives de plus.
    'subject_template', v_subject_tpl,
    'body_template', v_body_tpl,
    'merchant_address', v_contact.contact_address,
    'merchant_email', v_contact.contact_email,
    'merchant_phone', v_contact.contact_phone,
    'invoice_requested', v_invoice,
    'withdrawal_eligible', v_withdrawable
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
  'N1-A + CFTE v1 + MCC v1 — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente (ON CONFLICT DO NOTHING sur (restaurant_id, order_id, notification_type)). Refuse toute substitution tenant croisée. MCC v1 : le payload_snapshot porte EN PLUS subject_template, body_template, merchant_address, merchant_email, merchant_phone, invoice_requested et withdrawal_eligible -- toutes ADDITIVES, aucune clé CFTE/N1-A retirée ni renommée. Aucun envoi réseau.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- Z. POST-VOL — posture de sécurité VÉRIFIÉE par cette migration
--    elle-même, jamais seulement documentée. DANS la transaction :
--    un écart annule tout.
-- ------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- Z.1 Catalogues : cardinalités exactes attendues.
  if pg_catalog.cardinality(public.communication_text_keys()) <> 14 then
    raise exception 'SCANYM_POSTCHECK: communication_text_keys() doit porter 14 emplacements.';
  end if;
  if pg_catalog.cardinality(public.public_communication_text_keys()) <> 11 then
    raise exception 'SCANYM_POSTCHECK: public_communication_text_keys() doit porter 11 emplacements.';
  end if;
  if pg_catalog.cardinality(public.communication_template_variables()) <> 13 then
    raise exception 'SCANYM_POSTCHECK: communication_template_variables() doit porter 13 variables.';
  end if;
  if pg_catalog.cardinality(public.communication_event_codes()) <> 3 then
    raise exception 'SCANYM_POSTCHECK: communication_event_codes() doit porter 3 événements.';
  end if;

  -- Z.2 Le sous-ensemble public est bien un SOUS-ENSEMBLE, et il exclut
  --     bien les 3 gabarits d'e-mail. Une inclusion accidentelle
  --     exposerait une configuration interne à l'anonyme.
  select pg_catalog.count(*) into v_count
  from pg_catalog.unnest(public.public_communication_text_keys()) as k
  where not (k = any(public.communication_text_keys()));
  if v_count <> 0 then
    raise exception 'SCANYM_POSTCHECK: public_communication_text_keys() n''est pas un sous-ensemble du catalogue.';
  end if;
  if 'email_confirmation_subject' = any(public.public_communication_text_keys())
     or 'email_confirmation_body' = any(public.public_communication_text_keys())
     or 'confirmation_withdrawal_request' = any(public.public_communication_text_keys()) then
    raise exception 'SCANYM_POSTCHECK: un gabarit d''e-mail est exposé publiquement -- refusé.';
  end if;

  -- Z.3 Détection de variable inconnue : comportement prouvé, pas
  --     supposé.
  if pg_catalog.cardinality(public.communication_template_unknown_variables('Bonjour {merchant_name}')) <> 0 then
    raise exception 'SCANYM_POSTCHECK: une variable de la liste blanche est vue comme inconnue.';
  end if;
  if pg_catalog.cardinality(public.communication_template_unknown_variables('Bonjour {pirate}')) <> 1 then
    raise exception 'SCANYM_POSTCHECK: une variable hors liste blanche n''est pas détectée.';
  end if;
  -- `{ y }` (espaces), `{Z}` (majuscule), `{a-b}` (tiret) et `{}` (vide)
  -- ne sont PAS des emplacements : ils traversent intacts.
  if pg_catalog.cardinality(public.communication_template_unknown_variables('{ y } {Z} {a-b} {}')) <> 0 then
    raise exception 'SCANYM_POSTCHECK: un non-emplacement est traité comme une variable.';
  end if;
  -- `{{x}}` CONTIENT en revanche l'emplacement `{x}` : la détection le
  -- voit, et l'écriture est donc refusée tant que `x` n'est pas dans la
  -- liste blanche. Comportement VOULU et IDENTIQUE côté TypeScript
  -- (même classe de caractères, même balayage) -- vérifié ici pour que
  -- les deux ne puissent pas divergir en silence.
  if pg_catalog.cardinality(public.communication_template_unknown_variables('{{x}}')) <> 1 then
    raise exception 'SCANYM_POSTCHECK: {{x}} doit être vu comme portant l''emplacement {x}.';
  end if;

  -- Z.3-bis v1.1 — CARTOGRAPHIE ÉVÉNEMENT -> GABARIT (ferme
  --     MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01). Trois contrôles, pas un :
  --     la cartographie est TOTALE, elle ne désigne QUE des emplacements
  --     du catalogue, et elle n'emprunte JAMAIS le couple générique de
  --     l'e-mail de confirmation de commande.
  select pg_catalog.count(*) into v_count
  from pg_catalog.unnest(public.communication_event_codes()) as e
  where public.communication_event_body_text_key(e) is null;
  if v_count <> 0 then
    raise exception 'SCANYM_POSTCHECK: % événement(s) sans gabarit de corps -- la cartographie doit être TOTALE.', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.unnest(public.communication_event_codes()) as e
  where not (public.communication_event_body_text_key(e) = any(public.communication_text_keys()));
  if v_count <> 0 then
    raise exception 'SCANYM_POSTCHECK: la cartographie désigne % emplacement(s) hors catalogue.', v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.unnest(public.communication_event_codes()) as e
  where public.communication_event_body_text_key(e) in ('email_confirmation_subject', 'email_confirmation_body');
  if v_count <> 0 then
    raise exception 'SCANYM_POSTCHECK: un événement additionnel emprunte le gabarit de l''e-mail de confirmation de commande -- refusé.';
  end if;

  -- Chaque événement a un gabarit DISTINCT : deux événements partageant
  -- un emplacement reproduiraient la confusion que ce correctif ferme.
  select pg_catalog.count(distinct public.communication_event_body_text_key(e)) into v_count
  from pg_catalog.unnest(public.communication_event_codes()) as e;
  if v_count <> pg_catalog.cardinality(public.communication_event_codes()) then
    raise exception 'SCANYM_POSTCHECK: deux événements partagent le même gabarit de corps -- refusé.';
  end if;

  -- Un code hors catalogue n'a PAS de gabarit (fermé au repos).
  if public.communication_event_body_text_key('order_received') is not null
     or public.communication_event_body_text_key('pirate_event') is not null then
    raise exception 'SCANYM_POSTCHECK: la cartographie renvoie un gabarit pour un code qu''elle ne couvre pas.';
  end if;

  -- Z.4 Le CHECK de notification_type porte les 12 valeurs, et EXISTE en
  --     un seul exemplaire.
  select pg_catalog.count(*) into v_count
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_outbox'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%notification_type%';
  if v_count <> 1 then
    raise exception 'SCANYM_POSTCHECK: % CHECK(s) sur notification_type au lieu d''un seul.', v_count;
  end if;
  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
      and con.conname = 'notification_outbox_notification_type_check'
      and pg_get_constraintdef(con.oid) like '%order_received%'
      and pg_get_constraintdef(con.oid) like '%refund_issued%'
      and pg_get_constraintdef(con.oid) like '%carrier_handoff%'
      and pg_get_constraintdef(con.oid) like '%local_delivery_handoff%'
      and pg_get_constraintdef(con.oid) like '%withdrawal_request_received%'
  ) then
    raise exception 'SCANYM_POSTCHECK: le CHECK notification_type a perdu une valeur historique ou n''a pas reçu les 3 ajouts.';
  end if;

  -- Z.5 L'unicité logique qui PORTE l'idempotence est toujours là.
  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
      and con.conname = 'notification_outbox_logical_uniqueness'
  ) then
    raise exception 'SCANYM_POSTCHECK: notification_outbox_logical_uniqueness absente -- l''idempotence ne serait plus garantie.';
  end if;

  -- Z.6 RLS réellement activée sur les deux nouvelles tables.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'merchant_communication_text' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_POSTCHECK: RLS absente sur merchant_communication_text.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'merchant_communication_event' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_POSTCHECK: RLS absente sur merchant_communication_event.';
  end if;

  -- Z.7 AUCUN privilège d'écriture de table pour qui que ce soit
  --     d'applicatif : l'écriture ne peut passer QUE par les RPC.
  select pg_catalog.count(*) into v_count
  from (values ('merchant_communication_text'), ('merchant_communication_event')) as tbl(name)
  cross join (values ('anon'), ('authenticated')) as rol(name)
  cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as priv(name)
  where has_table_privilege(rol.name, 'public.' || tbl.name, priv.name);
  if v_count <> 0 then
    raise exception 'SCANYM_POSTCHECK: % privilège(s) d''écriture de table subsiste(nt) sur une table de communication -- refusé.', v_count;
  end if;

  -- anon ne doit même pas pouvoir LIRE la table : il passe par la
  -- projection publique filtrée, jamais par la table (qui porte les
  -- gabarits d'e-mail).
  if has_table_privilege('anon', 'public.merchant_communication_text', 'SELECT') then
    raise exception 'SCANYM_POSTCHECK: anon a un SELECT direct sur merchant_communication_text -- les gabarits d''e-mail fuiraient.';
  end if;
  if not has_table_privilege('authenticated', 'public.merchant_communication_text', 'SELECT') then
    raise exception 'SCANYM_POSTCHECK: authenticated a perdu le SELECT (lecture back-office) sur merchant_communication_text.';
  end if;

  -- Z.8 ACL des fonctions.
  if has_function_privilege('anon', 'public.set_merchant_communication_text(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_merchant_communication_event_enabled(uuid,text,boolean)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: anon peut exécuter une écriture de communication -- refusé.';
  end if;
  if not has_function_privilege('authenticated', 'public.set_merchant_communication_text(uuid,text,text)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: authenticated ne peut pas écrire ses propres textes.';
  end if;
  if not has_function_privilege('anon', 'public.get_restaurant_public_communication_texts(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: la projection publique n''est pas exécutable par anon.';
  end if;
  if has_function_privilege('anon', 'public.order_has_withdrawal_eligible_line(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.order_has_withdrawal_eligible_line(uuid,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: la preuve d''éligibilité rétractation est exécutable hors service_role -- refusé.';
  end if;
  if has_function_privilege('anon', 'public.create_order_communication_notification(uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.create_order_communication_notification(uuid,uuid,text)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: l''enfilement est exécutable hors service_role -- refusé.';
  end if;

  -- Z.9 Les fonctions N1-A/CFTE que ce lot NE DOIT PAS avoir touchées
  --     sont toujours présentes avec leur signature exacte.
  if to_regprocedure('public.claim_pending_notifications(integer,integer)') is null
     or to_regprocedure('public.set_merchant_tracking_status_text(uuid,text,text)') is null
     or to_regprocedure('public.reap_stale_notification_claims(integer)') is null then
    raise exception 'SCANYM_POSTCHECK: une fonction de la file existante a disparu.';
  end if;

  -- Z.10 La SEULE fonction redéfinie l'a été de façon ADDITIVE : elle a
  --      conservé sa garde tenant, son ON CONFLICT, ses 6 clés N1-A et
  --      ses 4 clés CFTE, et gagné les 5 clés de ce lot. Une seule de
  --      ces absences signifierait qu'un ajout antérieur a été écrasé.
  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_POSTCHECK: create_order_received_notification(uuid,uuid) a perdu sa signature.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_received_notification'
      and pg_get_functiondef(p.oid) like '%SCANYM_NOTIFICATION_TENANT_MISMATCH%'
      and pg_get_functiondef(p.oid) like '%on conflict (restaurant_id, order_id, notification_type) do nothing%'
      and pg_get_functiondef(p.oid) like '%''public_token'', v_order.public_token%'
      and pg_get_functiondef(p.oid) like '%''status_text_override'', v_status_override%'
      and pg_get_functiondef(p.oid) like '%''merchant_name'', v_merchant_name%'
      and pg_get_functiondef(p.oid) like '%''subject_template'', v_subject_tpl%'
      and pg_get_functiondef(p.oid) like '%''body_template'', v_body_tpl%'
      and pg_get_functiondef(p.oid) like '%''merchant_phone'', v_contact.contact_phone%'
  ) then
    raise exception 'SCANYM_POSTCHECK: la redéfinition de create_order_received_notification n''est pas strictement additive.';
  end if;
  -- Elle reste réservée à service_role.
  if has_function_privilege('anon', 'public.create_order_received_notification(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.create_order_received_notification(uuid,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: create_order_received_notification est exécutable hors service_role -- refusé.';
  end if;

  -- Z.10-bis v1.1 — l'enfilement d'un événement additionnel ne pose
  --     PLUS les clés génériques, et pose bien `event_body_template`.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_communication_notification'
      and pg_get_functiondef(p.oid) like '%''event_body_template'', v_event_body_tpl%'
      and pg_get_functiondef(p.oid) like '%communication_event_body_text_key(p_notification_type)%'
  ) then
    raise exception 'SCANYM_POSTCHECK: l''enfilement d''événement ne fige pas le gabarit propre à l''événement.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_communication_notification'
      and (pg_get_functiondef(p.oid) like '%''subject_template''%'
           or pg_get_functiondef(p.oid) like '%''body_template''%'
           or pg_get_functiondef(p.oid) like '%''withdrawal_template''%')
  ) then
    raise exception 'SCANYM_POSTCHECK: l''enfilement d''événement pose encore une clé de gabarit générique ou morte -- refusé.';
  end if;

  -- Z.11 Les coordonnées ne viennent JAMAIS de l'identité d'expédition
  --      technique : merchant_communication_contact ne doit pas lire
  --      merchant_notification_profile.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'merchant_communication_contact'
      and pg_get_functiondef(p.oid) like '%merchant_notification_profile%'
  ) then
    raise exception 'SCANYM_POSTCHECK: merchant_communication_contact lit l''identité d''expédition -- refusé.';
  end if;
end $$;

commit;
