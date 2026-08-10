-- ============================================================
-- Scanym — Le Sirocco (établissement de DÉMONSTRATION)
--
-- Bar d'hôtel fictif, créé pour montrer qu'un établissement peut
-- avoir une identité visuelle et une carte radicalement différentes
-- de celles d'un café ou d'une pâtisserie.
--
-- ⚠️ ÉTABLISSEMENT FICTIF — ne correspond à aucun lieu réel.
-- Le numéro WhatsApp est un numéro de test.
--
-- NON DESTRUCTIF ET IDEMPOTENT : aucune suppression. Une seconde
-- exécution conserve les commandes, les prix modifiés depuis
-- « Ma carte » et les rattachements d'utilisateurs ; elle se
-- contente d'ajouter ce qui manque.
--
-- À exécuter après migration-v31-catalogue.sql.
-- ============================================================

do $$
declare
  v_resto uuid;
  v_cat   uuid;
  r record;
begin
  -- Établissement
  select id into v_resto from public.restaurants where slug = 'le-sirocco';
  if v_resto is null then
    insert into public.restaurants (name, slug)
    values ('Le Sirocco', 'le-sirocco')
    returning id into v_resto;
  end if;

  -- Configuration : créée si absente, jamais écrasée
  insert into public.restaurant_configs
    (restaurant_id, max_tables, currency, whatsapp_number,
     address, opening_hours, allowed_service_modes)
  values (
    v_resto, 24, 'DZD',
    '+33663602803',                -- numéro de test
    'Bar de l''hôtel — Oran',
    '16:00 – 01:00',
    array['table']                 -- service en salle uniquement
  )
  on conflict (restaurant_id) do nothing;

  -- Catégories et produits
  for r in
    select * from (values
      ('Cocktails', 1, 'Sirocco',           'Mangue, fruit de la passion, citron vert',   950.00, 1),
      ('Cocktails', 1, 'Sahara Sunset',     'Orange sanguine, grenadine, eau pétillante', 850.00, 2),
      ('Cocktails', 1, 'Menthe Royale',     'Menthe fraîche, citron, sirop de canne',     750.00, 3),
      ('Cocktails', 1, 'Virgin Mojito',     'Menthe, citron vert, sucre de canne',        800.00, 4),
      ('Smoothies', 2, 'Smoothie mangue',   'Mangue, banane, lait d''amande',             700.00, 1),
      ('Smoothies', 2, 'Smoothie fraise',   'Fraise, banane, yaourt',                     700.00, 2),
      ('Smoothies', 2, 'Smoothie détox',    'Épinard, pomme verte, citron, gingembre',    750.00, 3),
      ('Cafés & thés', 3, 'Espresso',        'Court et intense',                           200.00, 1),
      ('Cafés & thés', 3, 'Cappuccino',      'Mousse de lait onctueuse',                   320.00, 2),
      ('Cafés & thés', 3, 'Thé à la menthe', 'Servi en théière, deux verres',              400.00, 3),
      ('Cafés & thés', 3, 'Thé vert jasmin', 'Parfumé, servi en théière',                  400.00, 4),
      ('En-cas', 4, 'Club sandwich',        'Poulet, œuf, crudités, frites maison',      1200.00, 1),
      ('En-cas', 4, 'Club sandwich thon',   'Thon, œuf, crudités, frites maison',        1200.00, 2),
      ('En-cas', 4, 'Assiette de fruits',   'Fruits frais de saison',                     600.00, 3),
      ('En-cas', 4, 'Olives & amandes',     'À grignoter, servi frais',                   350.00, 4)
    ) as t(cat_name, cat_order, item_name, item_desc, item_price, item_order)
  loop
    select id into v_cat
    from public.menu_categories
    where restaurant_id = v_resto and name = r.cat_name;

    if v_cat is null then
      insert into public.menu_categories (restaurant_id, name, display_order)
      values (v_resto, r.cat_name, r.cat_order)
      returning id into v_cat;
    end if;

    -- Un produit déjà présent n'est pas retouché : un prix modifié
    -- depuis « Ma carte » doit survivre à une réexécution.
    if not exists (
      select 1 from public.menu_items
      where category_id = v_cat and name = r.item_name
    ) then
      insert into public.menu_items
        (category_id, name, description, price, display_order)
      values (v_cat, r.item_name, r.item_desc, r.item_price, r.item_order);
    end if;
  end loop;
end $$;

-- Contrôle
select r.name, count(mi.*) as produits
from public.restaurants r
join public.menu_categories mc on mc.restaurant_id = r.id
join public.menu_items mi on mi.category_id = mc.id
where r.slug = 'le-sirocco'
group by r.name;

-- ------------------------------------------------------------
-- RÉINITIALISATION DE LA DÉMONSTRATION (destructif)
--
-- À décommenter uniquement pour repartir d'une carte vierge. Efface
-- Le Sirocco et, par cascade, ses commandes et ses rattachements.
-- N'affecte aucun autre établissement.
-- ------------------------------------------------------------
-- delete from public.restaurants where slug = 'le-sirocco';
