-- ============================================================
-- ScanDZ — DONNÉES TEMPORAIRES DE DÉVELOPPEMENT
-- ⚠️ À REMPLACER par le menu réel d'Illico Presto avant mise
-- en production. Tout est préfixé [TEMP] pour éviter toute
-- confusion avec des données réelles.
-- À exécuter APRÈS supabase/schema.sql
-- ============================================================

with resto as (
  insert into restaurants (name, slug)
  values ('Illico Presto Coffee', 'illico-presto')
  returning id
),
config as (
  insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number, address)
  select id, 15, 'DZD', '+213000000000', '[TEMP] Adresse à confirmer — Oran'
  from resto
),
cat_boissons as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '[TEMP] Boissons chaudes', 1 from resto
  returning id
),
cat_patisseries as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '[TEMP] Pâtisseries', 2 from resto
  returning id
)
insert into menu_items (category_id, name, description, price, display_order)
select id, '[TEMP] Espresso', 'Donnée temporaire de développement', 150.00, 1 from cat_boissons
union all
select id, '[TEMP] Cappuccino', 'Donnée temporaire de développement', 250.00, 2 from cat_boissons
union all
select id, '[TEMP] Croissant', 'Donnée temporaire de développement', 120.00, 1 from cat_patisseries;
