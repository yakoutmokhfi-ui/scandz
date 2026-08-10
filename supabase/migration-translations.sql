-- ============================================================
-- Scanym — Traductions du contenu du menu
--
-- ⚠️ MODIFICATION DE SCHÉMA — À VALIDER PAR LE CTO AVANT EXÉCUTION.
--
-- Ajoute une colonne `translations` (JSONB) à menu_categories et
-- menu_items. Format retenu :
--   { "ar": { "name": "…", "description": "…" },
--     "en": { "name": "…", "description": "…" } }
--
-- Choix d'un JSONB plutôt que de colonnes name_ar / name_en :
--   • ajouter une langue ne modifie plus le schéma ;
--   • aucune colonne vide pour les établissements monolingues ;
--   • le français reste dans `name`, il fait toujours référence.
--
-- L'application fonctionne avec ou sans cette colonne : tant qu'elle
-- est absente, tout s'affiche en français. Elle peut donc être jouée
-- quand vous le souhaitez, sans coordination avec un déploiement.
-- ============================================================

alter table menu_categories add column if not exists translations jsonb;
alter table menu_items      add column if not exists translations jsonb;

-- ------------------------------------------------------------
-- Illico Presto — arabe littéraire (arabe standard moderne)
-- ------------------------------------------------------------

update menu_categories mc
set translations = jsonb_build_object('ar', jsonb_build_object('name', v.ar))
from (values
  ('Formules petit-déjeuner', 'عروض الفطور'),
  ('Boissons chaudes',        'المشروبات الساخنة'),
  ('Viennoiseries',           'المعجنات'),
  ('Pâtisseries',             'الحلويات'),
  ('Jus & boissons',          'العصائر والمشروبات')
) as v(fr, ar),
restaurants r
where mc.restaurant_id = r.id
  and r.slug = 'illico-presto'
  and mc.name = v.fr;

update menu_items mi
set translations = jsonb_build_object(
  'ar', jsonb_strip_nulls(jsonb_build_object('name', v.ar_name, 'description', v.ar_desc))
)
from (values
  -- Formules
  ('Formule Buongiorno',    'عرض بونجورنو',        'قهوة، عصير برتقال، بان أو شوكولا، ماء معدني'),
  ('Formule Dolce Mattina', 'عرض دولتشي ماتينا',   'قهوة، عصير برتقال، ميل فوي، ماء معدني'),
  ('Formule Prestigio',     'عرض بريستيجيو',       'قهوة، عصير برتقال، حلوى حسب الاختيار، ماء معدني'),
  -- Boissons chaudes
  ('Espresso',              'إسبريسو',             'قهوة مركزة على الطريقة الإيطالية'),
  ('Café allongé',          'قهوة مخففة',          'إسبريسو مخفف بالماء، ألطف مذاقاً'),
  ('Cappuccino',            'كابتشينو',            'إسبريسو مع رغوة الحليب'),
  ('Café Latte',            'كافيه لاتيه',         'قهوة بالحليب، غنية وناعمة'),
  ('Café Viennois',         'قهوة فيينية',         'قهوة مغطاة بالكريمة المخفوقة'),
  ('Chocolat chaud',        'شوكولاتة ساخنة',      'شوكولاتة ذائبة، غنية ودافئة'),
  ('Thé à la menthe',       'شاي بالنعناع',        'نعناع طازج، يُقدَّم ساخناً'),
  ('Thé citron',            'شاي بالليمون',        'شاي معطر بالليمون'),
  ('Thé noir',              'شاي أسود',            'كلاسيكي وقوي'),
  -- Viennoiseries
  ('Croissant',             'كرواسون',             'بالزبدة الصافية، مقرمش'),
  ('Pain au chocolat',      'بان أو شوكولا',       'عجين مورّق مع قطعتي شوكولاتة'),
  ('Brioche',               'بريوش',               'هشّة وذهبية'),
  ('Pain aux raisins',      'خبز بالزبيب',         'كريمة الحلواني والزبيب'),
  -- Pâtisseries
  ('Mille-feuille',         'ميل فوي',             'كريمة الحلواني مع طبقة سكرية مقرمشة'),
  ('Tiramisu',              'تيراميسو',            'ماسكاربوني، قهوة، كاكاو'),
  ('Cheesecake',            'تشيز كيك',            'ناعم على قاعدة بسكويت مقرمشة'),
  ('Fondant chocolat',      'فوندان بالشوكولاتة',  'قلب سائل من الشوكولاتة الداكنة'),
  ('Éclair café',           'إكلير بالقهوة',       'كريمة القهوة مع طبقة لامعة'),
  ('Éclair chocolat',       'إكلير بالشوكولاتة',   'كريمة الشوكولاتة مع طبقة كاكاو'),
  ('Tarte citron',          'تارت بالليمون',       'كريمة ليمون حامضة مع مرينغ'),
  ('Brownie',               'براوني',              'شوكولاتة مركزة بقلب طري'),
  ('Muffin chocolat',       'مافن بالشوكولاتة',    'بقطع الشوكولاتة'),
  ('Muffin myrtilles',      'مافن بالتوت البري',   'محشو بالتوت البري'),
  ('Donut chocolat',        'دونات بالشوكولاتة',   'مغطى بالشوكولاتة'),
  -- Jus & boissons
  ('Jus d''orange frais',   'عصير برتقال طازج',    'معصور في الحال'),
  ('Jus citron',            'عصير ليمون',          'ليموناضة منعشة'),
  ('Jus multifruits',       'عصير فواكه مشكلة',    'خليط من الفواكه'),
  ('Eau minérale',          'ماء معدني',           'قارورة ٥٠ سل'),
  ('Coca-Cola',             'كوكا كولا',           'علبة أو قارورة'),
  ('Coca Zero',             'كوكا زيرو',           'بدون سكر'),
  ('Sprite',                'سبرايت',              'بنكهة الليمون'),
  ('Fanta',                 'فانتا',               'برتقال فوّار'),
  ('Eau gazeuse',           'ماء غازي',            'فوّار خفيف')
) as v(fr_name, ar_name, ar_desc),
menu_categories mc,
restaurants r
where mi.category_id = mc.id
  and mc.restaurant_id = r.id
  and r.slug = 'illico-presto'
  and mi.name = v.fr_name;

-- ------------------------------------------------------------
-- Vérification : produits d'Illico encore sans traduction arabe
-- ------------------------------------------------------------
select mi.name
from menu_items mi
join menu_categories mc on mc.id = mi.category_id
join restaurants r on r.id = mc.restaurant_id
where r.slug = 'illico-presto'
  and (mi.translations -> 'ar' ->> 'name') is null;
