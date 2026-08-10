-- ============================================================
-- Le Sirocco — photos des cocktails
--
-- À exécuter après seed-sirocco-demo.sql.
-- Additif et idempotent : ne renseigne que les produits visés,
-- et n'écrase rien d'autre.
--
-- Les images sont servies par l'application (public/photos/sirocco).
-- Quand elles passeront dans Supabase Storage, il suffira de
-- remplacer ces chemins par les URL publiques du bucket.
-- ============================================================

update public.menu_items mi
set image_url = v.url
from (values
  ('Sirocco',       '/photos/sirocco/sirocco.jpg'),
  ('Sahara Sunset', '/photos/sirocco/sahara-sunset.jpg'),
  ('Menthe Royale', '/photos/sirocco/menthe-royale.jpg'),
  ('Virgin Mojito', '/photos/sirocco/virgin-mojito.jpg')
) as v(item_name, url),
public.menu_categories mc,
public.restaurants r
where mi.category_id = mc.id
  and mc.restaurant_id = r.id
  and r.slug = 'le-sirocco'
  and mi.name = v.item_name;

-- Contrôle
select mi.name, mi.image_url
from public.menu_items mi
join public.menu_categories mc on mc.id = mi.category_id
join public.restaurants r on r.id = mc.restaurant_id
where r.slug = 'le-sirocco' and mi.image_url is not null
order by mi.name;
