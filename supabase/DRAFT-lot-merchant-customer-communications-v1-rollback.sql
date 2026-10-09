-- ============================================================
-- Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — ROLLBACK
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Annule exactement, et SEULEMENT, ce qu'ajoute
-- supabase/DRAFT-lot-merchant-customer-communications-v1.sql.
--
-- CE QUE CE RETOUR FAIT :
--   1. supprime les deux tables du lot (donc les textes et les
--      interrupteurs d'événement qu'elles portaient) ;
--   2. supprime les cinq RPC et les six fonctions de catalogue ;
--   3. REMET le CHECK de notification_outbox.notification_type dans son
--      état N1-A EXACT (9 valeurs), après avoir vérifié qu'aucune ligne
--      ne porte l'un des 3 types ajoutés -- sinon il REFUSE, car
--      restaurer le CHECK violerait des données existantes.
--
-- CE QUE CE RETOUR NE FAIT PAS :
--   - ne touche à AUCUNE ligne de notification_outbox, orders,
--     order_items, withdrawal_requests, merchant_notification_profile
--     ni merchant_tracking_status_text ;
--   - ne redéfinit qu'UNE fonction préexistante, celle que l'aller avait
--     remplacée : create_order_received_notification est RÉÉCRITE dans
--     son état CFTE v1 EXACT (10 clés de payload, sans les 7 clés du
--     lot). Elle est réécrite AVANT la suppression des tables et
--     fonctions du lot, de sorte qu'aucun instant de la transaction ne
--     voit une fonction référencer un objet déjà supprimé ;
--   - ne supprime aucun rôle, aucun grant hérité, aucune extension.
--
-- PERTE DE DONNÉES ASSUMÉE ET EXPLICITE : les textes marchands et les
-- interrupteurs d'événement disparaissent. C'est le comportement VOULU
-- d'un retour sur un lot de configuration : l'absence de configuration
-- est l'état d'avant, et il est fonctionnellement complet (toutes les
-- surfaces retombent sur le texte plateforme générique). Aucun e-mail
-- déjà envoyé, aucune commande, aucune ligne de file n'est affecté.
--
-- ATOMICITÉ : UNE seule transaction, pré-vol et post-vol DEDANS,
-- `commit;` en dernière instruction exécutable -- même convention que
-- l'aller.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL.
-- ------------------------------------------------------------
do $$
declare
  v_rows bigint;
begin
  if to_regclass('public.notification_outbox') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: notification_outbox absente -- rollback annulé.';
  end if;

  -- Restaurer le CHECK à 9 valeurs est IMPOSSIBLE si une ligne porte
  -- l'un des 3 types ajoutés : PostgreSQL refuserait l'ADD CONSTRAINT,
  -- et un rollback qui échoue à mi-parcours est pire qu'un rollback
  -- refusé d'emblée. On DIT pourquoi, avec le compte exact.
  select count(*) into v_rows
  from public.notification_outbox
  where notification_type in ('carrier_handoff', 'local_delivery_handoff', 'withdrawal_request_received');

  if v_rows > 0 then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: % ligne(s) de notification_outbox portent un type ajouté par ce lot. Traiter ou purger ces lignes AVANT le rollback -- ce script ne supprime jamais une ligne de file.', v_rows;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. create_order_received_notification — RETOUR À L'ÉTAT CFTE v1.
--    D'ABORD, avant toute suppression : le nouveau corps ne doit plus
--    référencer merchant_communication_text ni
--    merchant_communication_contact au moment où celles-ci disparaissent.
--    Corps reproduit depuis
--    supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql
--    (section E) -- 10 clés de payload, pas 15.
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
  v_status_override text;
  v_merchant_name   text;
begin
  select * into v_order from public.orders where id = p_order_id;

  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %', p_order_id, p_restaurant_id
      using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language else 'fr' end;

  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    else 'pending'
  end;

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

  return v_outbox_id;
end $$;

comment on function public.create_order_received_notification(uuid, uuid) is
  'N1-A + CFTE v1 — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente (ON CONFLICT DO NOTHING sur (restaurant_id, order_id, notification_type)). Refuse toute substitution tenant croisée. CFTE v1 : le payload_snapshot porte en plus order_status, status_text_override, delivery_address (delivery uniquement) et merchant_name -- toutes ADDITIVES. Aucun envoi réseau.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 2. RPC et fonctions du lot. Ordre : d'abord ce qui APPELLE, ensuite
--    ce qui est APPELÉ -- et les tables avant les fonctions de
--    catalogue dont leurs CHECK dépendent.
-- ------------------------------------------------------------
drop function if exists public.create_order_communication_notification(uuid, uuid, text);
drop function if exists public.order_has_withdrawal_eligible_line(uuid, uuid);
drop function if exists public.get_restaurant_public_communication_texts(uuid);
drop function if exists public.set_merchant_communication_event_enabled(uuid, text, boolean);
drop function if exists public.set_merchant_communication_text(uuid, text, text);

-- ------------------------------------------------------------
-- 3. Tables du lot. `cascade` n'est PAS utilisé : les seules
--    dépendances sont les déclencheurs touch_updated_at et les CHECK
--    internes, que `drop table` emporte de lui-même. Un `cascade`
--    masquerait une dépendance inattendue au lieu de la révéler.
-- ------------------------------------------------------------
drop table if exists public.merchant_communication_event;
drop table if exists public.merchant_communication_text;

-- ------------------------------------------------------------
-- 4. Fonctions de catalogue, maintenant qu'aucun CHECK ne les référence.
-- ------------------------------------------------------------
drop function if exists public.merchant_communication_contact(uuid);
drop function if exists public.communication_template_unknown_variables(text);
drop function if exists public.communication_text_max_length(text);
drop function if exists public.communication_event_body_text_key(text);
drop function if exists public.communication_event_codes();
drop function if exists public.communication_template_variables();
drop function if exists public.public_communication_text_keys();
drop function if exists public.communication_text_keys();

-- ------------------------------------------------------------
-- 5. CHECK de notification_type — RETOUR À L'ÉTAT N1-A EXACT.
--    Les 9 valeurs sont reproduites littéralement depuis
--    DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql.
-- ------------------------------------------------------------
alter table public.notification_outbox
  drop constraint if exists notification_outbox_notification_type_check;

alter table public.notification_outbox
  add constraint notification_outbox_notification_type_check
  check (notification_type in (
    'order_received',
    'order_accepted', 'order_preparing', 'order_ready', 'order_delivered',
    'order_cancelled', 'order_rejected', 'delivery_failed', 'refund_issued'
  ));

-- ------------------------------------------------------------
-- Z. POST-VOL — la réversibilité est VÉRIFIÉE, pas affirmée.
-- ------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- Z.1 Plus aucun objet du lot.
  if to_regclass('public.merchant_communication_text') is not null
     or to_regclass('public.merchant_communication_event') is not null then
    raise exception 'SCANYM_POSTCHECK_RB: une table du lot subsiste.';
  end if;
  if to_regprocedure('public.communication_text_keys()') is not null
     or to_regprocedure('public.public_communication_text_keys()') is not null
     or to_regprocedure('public.communication_template_variables()') is not null
     or to_regprocedure('public.communication_event_codes()') is not null
     or to_regprocedure('public.communication_text_max_length(text)') is not null
     or to_regprocedure('public.communication_template_unknown_variables(text)') is not null
     or to_regprocedure('public.set_merchant_communication_text(uuid,text,text)') is not null
     or to_regprocedure('public.set_merchant_communication_event_enabled(uuid,text,boolean)') is not null
     or to_regprocedure('public.get_restaurant_public_communication_texts(uuid)') is not null
     or to_regprocedure('public.order_has_withdrawal_eligible_line(uuid,uuid)') is not null
     or to_regprocedure('public.create_order_communication_notification(uuid,uuid,text)') is not null
     or to_regprocedure('public.merchant_communication_contact(uuid)') is not null
     or to_regprocedure('public.communication_event_body_text_key(text)') is not null then
    raise exception 'SCANYM_POSTCHECK_RB: une fonction du lot subsiste.';
  end if;

  -- create_order_received_notification est revenue à CFTE v1 : elle a
  -- PERDU les 5 clés du lot et GARDÉ les 10 d'avant. Vérifié, pas
  -- affirmé -- c'est le cœur de la réversibilité de ce lot.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_received_notification'
      and (pg_get_functiondef(p.oid) like '%subject_template%'
           or pg_get_functiondef(p.oid) like '%body_template%'
           or pg_get_functiondef(p.oid) like '%merchant_communication_text%'
           or pg_get_functiondef(p.oid) like '%merchant_communication_contact%')
  ) then
    raise exception 'SCANYM_POSTCHECK_RB: create_order_received_notification porte encore un ajout du lot.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_received_notification'
      and pg_get_functiondef(p.oid) like '%SCANYM_NOTIFICATION_TENANT_MISMATCH%'
      and pg_get_functiondef(p.oid) like '%''status_text_override'', v_status_override%'
      and pg_get_functiondef(p.oid) like '%''merchant_name'', v_merchant_name%'
      and pg_get_functiondef(p.oid) like '%on conflict (restaurant_id, order_id, notification_type) do nothing%'
  ) then
    raise exception 'SCANYM_POSTCHECK_RB: create_order_received_notification n''est pas revenue à son état CFTE v1.';
  end if;

  -- Z.2 Le CHECK est revenu à 9 valeurs, en UN seul exemplaire, et il
  --     REFUSE bien les 3 types ajoutés.
  select pg_catalog.count(*) into v_count
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_outbox'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%notification_type%';
  if v_count <> 1 then
    raise exception 'SCANYM_POSTCHECK_RB: % CHECK(s) sur notification_type au lieu d''un seul.', v_count;
  end if;
  if exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
      and con.conname = 'notification_outbox_notification_type_check'
      and (pg_get_constraintdef(con.oid) like '%carrier_handoff%'
           or pg_get_constraintdef(con.oid) like '%local_delivery_handoff%'
           or pg_get_constraintdef(con.oid) like '%withdrawal_request_received%')
  ) then
    raise exception 'SCANYM_POSTCHECK_RB: le CHECK accepte encore un type ajouté par ce lot.';
  end if;
  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
      and con.conname = 'notification_outbox_notification_type_check'
      and pg_get_constraintdef(con.oid) like '%order_received%'
      and pg_get_constraintdef(con.oid) like '%refund_issued%'
  ) then
    raise exception 'SCANYM_POSTCHECK_RB: le CHECK a perdu une valeur historique N1-A.';
  end if;

  -- Z.3 Rien de l'écosystème existant n'a été emporté au passage.
  if to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null
     or to_regprocedure('public.claim_pending_notifications(integer,integer)') is null
     or to_regprocedure('public.complete_notification_attempt(uuid,uuid,integer,text,text,text,text)') is null
     or to_regprocedure('public.set_merchant_tracking_status_text(uuid,text,text)') is null
     or to_regclass('public.merchant_tracking_status_text') is null
     or to_regclass('public.merchant_notification_profile') is null
     or to_regclass('public.withdrawal_requests') is null then
    raise exception 'SCANYM_POSTCHECK_RB: un objet PRÉEXISTANT a disparu -- ce rollback ne doit retirer que le lot.';
  end if;

  -- Z.4 L'unicité logique qui porte l'idempotence est intacte.
  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
      and con.conname = 'notification_outbox_logical_uniqueness'
  ) then
    raise exception 'SCANYM_POSTCHECK_RB: notification_outbox_logical_uniqueness absente.';
  end if;
end $$;

commit;
