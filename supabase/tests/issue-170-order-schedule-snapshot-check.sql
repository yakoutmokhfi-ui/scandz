-- ISSUE #170 — PREUVE HÉBERGÉE, LECTURE SEULE (à exécuter dans l'éditeur SQL
-- Supabase ou via psql, jamais depuis l'application). Aucune écriture.
--
-- Vérifie que le jour/créneau choisi au checkout est bien FIGÉ avec la
-- commande par `create_order` hébergé (bloc CSDJ-3) dans
-- public.order_fulfillment_schedule_snapshot, et que le staff de
-- l'établissement peut le lire (policy order_fulfillment_schedule_snapshot_
-- select_staff). Le dépôt ne porte PAS le SQL de cette table : ce fichier
-- est le moyen reproductible de constater son état.

-- 1. La table et ses colonnes lues par lib/services/dashboard.ts existent.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'order_fulfillment_schedule_snapshot'
   and column_name in ('order_id','mode_code','scheduled_date','slot_key','selected_time',
                       'window_starts_at','window_ends_at','timezone','origin')
 order by ordinal_position;
-- attendu : 9 lignes.

-- 2. create_order hébergé écrit bien ce snapshot (bloc CSDJ-3, étape T5).
select position('insert into public.order_fulfillment_schedule_snapshot' in pg_get_functiondef(p.oid)) > 0 as create_order_writes_snapshot
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'create_order';
-- attendu : true.

-- 3. Le staff (authenticated + restaurant_users) peut lire les lignes de SON établissement.
select policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and tablename = 'order_fulfillment_schedule_snapshot';
-- attendu : order_fulfillment_schedule_snapshot_select_staff | SELECT | {authenticated}

-- 4. Dernières commandes planifiées d'un établissement (remplacer le slug).
select o.order_number, o.service_mode, o.created_at,
       s.scheduled_date, s.slot_key, s.selected_time, s.window_starts_at, s.window_ends_at, s.origin
  from public.orders o
  join public.order_fulfillment_schedule_snapshot s on s.order_id = o.id
  join public.restaurants r on r.id = o.restaurant_id
 where r.slug = 'au-lait-cru'
 order by o.created_at desc
 limit 10;
-- attendu (28/10/2026, lecture seule) : des commandes « pickup » avec une date
-- et une fenêtre (ex. 2026-10-30 · 16:00–20:00), origin = customer.
