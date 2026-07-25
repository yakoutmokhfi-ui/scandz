-- ============================================================
-- ScanDZ — Branchement des photos de démo (menu complet)
-- À exécuter APRÈS seed-illico-v2.sql.
--
-- Les photos de démo sont servies par l'application elle-même
-- (dossier public/photos), d'où les chemins relatifs : aucun
-- bucket Supabase Storage nécessaire pour la démo.
-- Plus tard, les vraies photos du café iront dans Supabase
-- Storage : il suffira de remplacer ces chemins par les URL
-- publiques du bucket, sans toucher au code (consigne CTO).
-- ============================================================

-- Logo (affiché dans la bannière)
update restaurant_configs
set logo_url = '/logo.png'
where restaurant_id = (select id from restaurants where slug = 'illico-presto');

-- Horaires (source : maquette — À VALIDER avec le gérant avant
-- de décommenter)
-- update restaurant_configs
-- set opening_hours = 'Tous les jours : 07:00 – 22:00'
-- where restaurant_id = (select id from restaurants where slug = 'illico-presto');

-- Photos des produits
update menu_items
set image_url = v.url
from (values
  -- Formules
  ('Formule Buongiorno',    '/photos/formule-buongiorno.jpg'),
  ('Formule Dolce Mattina', '/photos/formule-dolce-mattina.jpg'),
  ('Formule Prestigio',     '/photos/formule-prestigio.jpg'),
  -- Boissons chaudes
  ('Espresso',              '/photos/espresso.jpg'),
  ('Café allongé',          '/photos/cafe-allonge.jpg'),
  ('Cappuccino',            '/photos/cappuccino.jpg'),
  ('Café Latte',            '/photos/cafe-latte.jpg'),
  ('Café Viennois',         '/photos/cafe-viennois.jpg'),
  ('Chocolat chaud',        '/photos/chocolat-chaud.jpg'),
  ('Thé à la menthe',       '/photos/the-menthe.jpg'),
  ('Thé citron',            '/photos/the-citron.jpg'),
  ('Thé noir',              '/photos/the-noir.jpg'),
  -- Viennoiseries
  ('Croissant',             '/photos/croissant.jpg'),
  ('Pain au chocolat',      '/photos/pain-chocolat.jpg'),
  ('Brioche',               '/photos/brioche.jpg'),
  ('Pain aux raisins',      '/photos/pain-raisins.jpg'),
  -- Pâtisseries
  ('Mille-feuille',         '/photos/mille-feuille.jpg'),
  ('Tiramisu',              '/photos/tiramisu.jpg'),
  ('Cheesecake',            '/photos/cheesecake.jpg'),
  ('Fondant chocolat',      '/photos/fondant-chocolat.jpg'),
  ('Éclair café',           '/photos/eclair-cafe.jpg'),
  ('Éclair chocolat',       '/photos/eclair-chocolat.jpg'),
  ('Tarte citron',          '/photos/tarte-citron.jpg'),
  ('Brownie',               '/photos/brownie.jpg'),
  ('Muffin chocolat',       '/photos/muffin-chocolat.jpg'),
  ('Muffin myrtilles',      '/photos/muffin-myrtilles.jpg'),
  ('Donut chocolat',        '/photos/donut-chocolat.jpg'),
  -- Jus & boissons
  ('Jus d''orange frais',   '/photos/jus-orange.jpg'),
  ('Jus citron',            '/photos/jus-citron.jpg'),
  ('Jus multifruits',       '/photos/jus-multifruits.jpg'),
  ('Eau minérale',          '/photos/eau-minerale.jpg'),
  ('Eau gazeuse',           '/photos/eau-gazeuse.jpg'),
  ('Coca-Cola',             '/photos/coca-cola.jpg'),
  ('Coca Zero',             '/photos/coca-zero.jpg'),
  ('Sprite',                '/photos/sprite.jpg'),
  ('Fanta',                 '/photos/fanta.jpg')
) as v(item_name, url),
menu_categories mc,
restaurants r
where menu_items.category_id = mc.id
  and mc.restaurant_id = r.id
  and r.slug = 'illico-presto'
  and menu_items.name = v.item_name;
