-- ============================================================
-- Scanym — Sanaa Cookies & Fondant (Île-de-France)
-- Deuxième établissement. À exécuter APRÈS schema.sql.
-- N'affecte pas Illico Presto.
--
-- Particularités :
--   • devise EUR
--   • pas de salle : retrait sur place ou livraison (92 / 95)
--     → max_tables = 0, le mode de service est réglé dans
--       lib/restaurants-config.ts
--   • livraison proposée si le code postal saisi par le client est
--     en Île-de-France (75, 77, 78, 91, 92, 93, 94, 95) ET si la
--     commande atteint 10 gâteaux
--     (zones et seuil réglés dans lib/restaurants-config.ts)
--   • les goûts vivent dans deux catégories MASQUÉES
--     (is_active = false) : elles n'apparaissent pas au menu et
--     alimentent uniquement la fenêtre de choix.
-- ============================================================

delete from restaurants where slug = 'sanaa-cookies';

with resto as (
  insert into restaurants (name, slug)
  values ('Sanaa Cookies & Fondant', 'sanaa-cookies')
  returning id
),
config as (
  insert into restaurant_configs
    (restaurant_id, max_tables, currency, whatsapp_number, address, logo_url)
  select
    id,
    0,                       -- pas de tables
    'EUR',
    '+33660273154',          -- 06 60 27 31 54
    'Retrait sur place · Livraison offerte dès 10 gâteaux dans toute l''Île-de-France',
    null
  from resto
),
c_cookies as (
  insert into menu_categories (restaurant_id, name, display_order, is_active)
  select id, 'Cookies', 1, true from resto returning id
),
c_fondants as (
  insert into menu_categories (restaurant_id, name, display_order, is_active)
  select id, 'Fondants', 2, true from resto returning id
),
g_cookies as (
  insert into menu_categories (restaurant_id, name, display_order, is_active)
  select id, 'Goûts cookies', 90, false from resto returning id
),
g_fondants as (
  insert into menu_categories (restaurant_id, name, display_order, is_active)
  select id, 'Goûts fondants', 91, false from resto returning id
)
insert into menu_items (category_id, name, description, price, image_url, display_order)
-- ---------- Produits ----------
select id, 'Cookie',
       'De généreux morceaux, un cœur fondant à chaque bouchée.',
       2.50, '/photos/sanaa/cookie.jpg', 1 from c_cookies
union all
select id, 'Fondant au chocolat',
       'Un cœur coulant, un goût intense de chocolat.',
       2.50, '/photos/sanaa/fondant.jpg', 1 from c_fondants
-- ---------- Goûts cookies (catégorie masquée) ----------
union all select id, 'Chocolat au lait', null, 0, null, 1 from g_cookies
union all select id, 'Triple chocolat',  null, 0, null, 2 from g_cookies
union all select id, 'Kinder',           null, 0, null, 3 from g_cookies
union all select id, 'Nutella',          null, 0, null, 4 from g_cookies
union all select id, 'M&M''s',           null, 0, null, 5 from g_cookies
-- ---------- Goûts fondants (catégorie masquée) ----------
union all select id, 'Chocolat noir',        null, 0, null, 1 from g_fondants
union all select id, 'Chocolat au lait',     null, 0, null, 2 from g_fondants
union all select id, 'Kinder',               null, 0, null, 3 from g_fondants
union all select id, 'Nutella',              null, 0, null, 4 from g_fondants
union all select id, 'Caramel beurre salé',  null, 0, null, 5 from g_fondants;
