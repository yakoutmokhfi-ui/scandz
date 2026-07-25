-- ============================================================
-- ScanDZ — Menu complet Illico Presto Coffee (V2)
-- Prix validés par le CTO le 25/07/2026.
-- Remplace toute version précédente (temp ou v1).
--
-- Numéro WhatsApp : le seed utilise le numéro de TEST français
-- de Yakout. Pour basculer vers le numéro du restaurant à Oran,
-- exécuter l'UPDATE en fin de fichier (après vérification du
-- numéro).
-- Les photos (image_url) seront ajoutées ensuite via Supabase
-- Storage, par simple UPDATE, sans toucher au code.
-- ============================================================

delete from restaurants where slug = 'illico-presto';

with resto as (
  insert into restaurants (name, slug)
  values ('Illico Presto Coffee', 'illico-presto')
  returning id
),
config as (
  insert into restaurant_configs
    (restaurant_id, max_tables, currency, whatsapp_number,
     address, latitude, longitude)
  select
    id, 15, 'DZD',
    '+33663602803',             -- Numéro de TEST (Yakout, FR)
    'Oran, Algérie',
    35.70296000, -0.64530300    -- coordonnées Google Maps fournies
  from resto
),
c1 as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '🍳 Formules petit-déjeuner', 1 from resto returning id
),
c2 as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '☕ Boissons chaudes', 2 from resto returning id
),
c3 as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '🥐 Viennoiseries', 3 from resto returning id
),
c4 as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '🍰 Pâtisseries', 4 from resto returning id
),
c5 as (
  insert into menu_categories (restaurant_id, name, display_order)
  select id, '🥤 Jus & boissons', 5 from resto returning id
)
insert into menu_items (category_id, name, description, price, display_order)
-- ---------- Formules ----------
select id, 'Formule Buongiorno', 'Café, jus d''orange, pain au chocolat, eau minérale', 350.00, 1 from c1
union all select id, 'Formule Dolce Mattina', 'Café, jus d''orange, mille-feuille, eau minérale', 400.00, 2 from c1
union all select id, 'Formule Prestigio', 'Café, jus d''orange, pâtisserie au choix, eau minérale', 550.00, 3 from c1
-- ---------- Boissons chaudes ----------
union all select id, 'Espresso', 'Court et intense, à l''italienne', 150.00, 1 from c2
union all select id, 'Café allongé', 'Espresso allongé, plus doux', 170.00, 2 from c2
union all select id, 'Cappuccino', 'Espresso, mousse de lait onctueuse', 250.00, 3 from c2
union all select id, 'Café Latte', 'Café au lait crémeux et généreux', 280.00, 4 from c2
union all select id, 'Café Viennois', 'Café nappé de chantilly', 300.00, 5 from c2
union all select id, 'Chocolat chaud', 'Chocolat fondu, riche et réconfortant', 300.00, 6 from c2
union all select id, 'Thé à la menthe', 'Menthe fraîche, servi bien chaud', 180.00, 7 from c2
union all select id, 'Thé citron', 'Thé parfumé au citron', 180.00, 8 from c2
union all select id, 'Thé noir', 'Classique et corsé', 170.00, 9 from c2
-- ---------- Viennoiseries ----------
union all select id, 'Croissant', 'Pur beurre, croustillant', 120.00, 1 from c3
union all select id, 'Pain au chocolat', 'Feuilleté, deux barres de chocolat', 150.00, 2 from c3
union all select id, 'Brioche', 'Moelleuse et dorée', 180.00, 3 from c3
union all select id, 'Pain aux raisins', 'Crème pâtissière et raisins', 180.00, 4 from c3
-- ---------- Pâtisseries ----------
union all select id, 'Mille-feuille', 'Crème pâtissière, glaçage croquant', 250.00, 1 from c4
union all select id, 'Tiramisu', 'Mascarpone, café, cacao', 450.00, 2 from c4
union all select id, 'Cheesecake', 'Onctueux, sur biscuit croquant', 450.00, 3 from c4
union all select id, 'Fondant chocolat', 'Cœur coulant au chocolat noir', 380.00, 4 from c4
union all select id, 'Éclair café', 'Crème au café, glaçage brillant', 250.00, 5 from c4
union all select id, 'Éclair chocolat', 'Crème chocolat, glaçage cacao', 250.00, 6 from c4
union all select id, 'Tarte citron', 'Crème citron acidulée, meringue', 350.00, 7 from c4
union all select id, 'Brownie', 'Chocolat intense, cœur fondant', 280.00, 8 from c4
union all select id, 'Muffin chocolat', 'Pépites de chocolat', 250.00, 9 from c4
union all select id, 'Muffin myrtilles', 'Garni de myrtilles', 250.00, 10 from c4
union all select id, 'Donut chocolat', 'Nappage chocolat', 220.00, 11 from c4
-- ---------- Jus & boissons ----------
union all select id, 'Jus d''orange frais', 'Pressé minute', 250.00, 1 from c5
union all select id, 'Jus citron', 'Citronnade fraîche', 220.00, 2 from c5
union all select id, 'Jus multifruits', 'Cocktail de fruits', 250.00, 3 from c5
union all select id, 'Eau minérale', 'Bouteille 50 cl', 100.00, 4 from c5
union all select id, 'Coca-Cola', 'Canette ou bouteille', 180.00, 5 from c5
union all select id, 'Coca Zero', 'Sans sucres', 180.00, 6 from c5
union all select id, 'Sprite', 'Citron-citron vert', 180.00, 7 from c5
union all select id, 'Fanta', 'Orange pétillante', 180.00, 8 from c5
union all select id, 'Eau gazeuse', 'Finement pétillante', 120.00, 9 from c5;

-- ============================================================
-- BASCULE VERS LE NUMÉRO DU RESTAURANT (à exécuter plus tard)
-- Numéro confirmé par Yakout le 25/07/2026 : +213 666 51 09 01.
-- Décommenter et exécuter l'UPDATE ci-dessous pour basculer les
-- commandes vers le restaurant. Faire un test WhatsApp réel vers
-- ce numéro avant toute impression de QR code.
-- ============================================================
-- update restaurant_configs
-- set whatsapp_number = '+213666510901'
-- where restaurant_id = (select id from restaurants where slug = 'illico-presto');
