-- ============================================================
-- Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2) — RETOUR ARRIÈRE
-- (DRAFT — NOT APPLIED)
--
-- Aller : DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql
-- Parent de l'aller : main 03441a5ef1d371e90e3bfe3438e1a29e211d0537.
--
-- CE QUE CE RETOUR FAIT
--   1. supprime le répartiteur resolve_fulfillment_schedule puis
--      RESTAURE l'ancienne résolution CSDJ-1 sous son nom d'origine
--      (renommage resolve_fulfillment_schedule_v1 -> resolve_fulfillment_schedule,
--      corps et ACL INCHANGÉS : c'est le même objet, jamais recréé) ;
--   2. supprime les fonctions v1.2 ;
--   3. supprime les trois tables de calendrier/réservation puis les
--      deux tables de jours fériés ;
--   4. retire les cinq colonnes et leurs contraintes de
--      restaurant_fulfillment_schedule.
--
-- CE QU'IL NE FAIT PAS
--   - il ne touche NI create_order, NI update_order_status, NI le moteur
--     de paiement : l'aller n'en a modifié aucun ;
--   - il ne touche à aucune commande ni à aucune planification v1.
--
-- REFUS EXPLICITE PLUTÔT QUE PERTE SILENCIEUSE
--   Le retour REFUSE de s'appliquer tant qu'il existerait de la donnée
--   v1.2 à perdre : une planification de méthode v1.2, un jour de
--   préparation, une fermeture de préparation, un calendrier férié, ou
--   une réservation de capacité. Le commerçant doit d'abord repasser ses
--   planifications en v1 (ou les supprimer) ; les réservations sont des
--   enregistrements de commande et ne sont jamais détruites par un
--   retour. Ce refus est testé (harnais, section « Retour arrière »).
--
-- ATOMICITÉ : une seule transaction, pré-vol et post-vol dedans.
-- ============================================================

begin;

do $csdj12_rb_preflight$
declare
  v_n bigint;
begin
  if pg_catalog.to_regclass('public.order_fulfillment_capacity_reservation') is null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)') is null then
    raise exception 'SCANYM_ROLLBACK_NOT_APPLICABLE: CSDJ v1.2 n''est pas appliqué (ou déjà retiré) -- retour annulé.'
      using errcode = '42P01';
  end if;

  select pg_catalog.count(*) into v_n from public.restaurant_fulfillment_schedule
   where schedule_method_version = 'v1.2';
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % planification(s) de méthode v1.2 -- repasser en v1 ou supprimer avant le retour.', v_n
      using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.restaurant_fulfillment_prep_day;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % jour(s) de préparation v1.2 -- supprimer avant le retour.', v_n using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.restaurant_fulfillment_prep_closure;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % fermeture(s) de préparation v1.2 -- supprimer avant le retour.', v_n using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.public_holiday_calendar;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % calendrier(s) férié(s) -- supprimer avant le retour.', v_n using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.order_fulfillment_capacity_reservation;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % réservation(s) de capacité -- ce sont des enregistrements de commande, le retour ne les détruit pas.', v_n
      using errcode = '55000';
  end if;
end
$csdj12_rb_preflight$;

-- 1. Répartiteur -> ancien corps CSDJ-1 sous son nom d'origine.
drop function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone);
alter function public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)
  rename to resolve_fulfillment_schedule;

-- 2. Fonctions v1.2.
drop function public.get_merchant_fulfillment_schedules_v12(uuid);
drop function public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb);
drop function public.release_fulfillment_capacity(uuid);
drop function public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone);
drop function public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone);
drop function public.fulfillment_selection_reasons_v12();
drop function public.resolve_fulfillment_schedule_v12(uuid,text,uuid,timestamp with time zone,boolean);
drop function public.checkout_schedule_day_offers_v12(public.restaurant_fulfillment_schedule,date,timestamp with time zone);
drop function public.csdj12_availability_closed(public.restaurant_fulfillment_schedule,date);
drop function public.csdj12_preparation_open(public.restaurant_fulfillment_schedule,date);
drop function public.fulfillment_capacity_used(uuid,text,uuid,date,text);
drop function public.fulfillment_capacity_is_holding(text,text);
drop function public.checkout_unfulfillable_reasons_v12();

-- 3. Tables.
drop table public.order_fulfillment_capacity_reservation;
drop table public.restaurant_fulfillment_prep_closure;
drop table public.restaurant_fulfillment_prep_day;

-- 4. Colonnes et contraintes de la planification.
alter table public.restaurant_fulfillment_schedule
  drop constraint rfs_v12_extensions_only,
  drop constraint rfs_v12_no_cutoff_offset,
  drop constraint rfs_capacity_needs_date,
  drop constraint rfs_capacity_complete,
  drop constraint rfs_capacity_positive,
  drop constraint rfs_holiday_requires_calendar,
  drop constraint rfs_holiday_policy_values,
  drop constraint rfs_method_version_known,
  drop constraint rfs_holiday_calendar_fk;
alter table public.restaurant_fulfillment_schedule
  drop column capacity_max_orders,
  drop column capacity_enabled,
  drop column availability_on_holidays,
  drop column preparation_on_holidays,
  drop column holiday_calendar_id;

drop table public.public_holiday_calendar_day;
drop table public.public_holiday_calendar;

do $csdj12_rb_postflight$
begin
  if pg_catalog.to_regclass('public.restaurant_fulfillment_prep_day') is not null
     or pg_catalog.to_regclass('public.public_holiday_calendar') is not null
     or pg_catalog.to_regclass('public.order_fulfillment_capacity_reservation') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)') is null then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: état inattendu après le retour.';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
             where a.attrelid = 'public.restaurant_fulfillment_schedule'::regclass and not a.attisdropped
               and a.attname in ('holiday_calendar_id','preparation_on_holidays','availability_on_holidays',
                                 'capacity_enabled','capacity_max_orders')) then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: une colonne v1.2 subsiste.';
  end if;
end
$csdj12_rb_postflight$;

commit;
