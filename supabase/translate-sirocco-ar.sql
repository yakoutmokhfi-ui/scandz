-- ============================================================
-- Scanym — Le Sirocco : traductions arabes de la carte
--
-- Additif et idempotent. Ne renseigne que ce qui MANQUE :
--   • les autres langues sont préservées (fusion d'objets) ;
--   • une traduction arabe déjà présente, y compris corrigée à la
--     main, n'est jamais écrasée à la réexécution.
-- Pour reprendre une traduction, l'effacer d'abord (voir la
-- requête commentée en fin de fichier).
--
-- ⚠️ Arabe littéraire (arabe standard moderne). À faire relire par
-- un arabophone avant présentation : les noms de cocktails et de
-- préparations occidentales admettent plusieurs transcriptions, et
-- l'usage local prime sur la transcription littéraire.
--
-- À exécuter après seed-sirocco-demo.sql.
-- ============================================================

-- ------------------------------------------------------------
-- Catégories
-- ------------------------------------------------------------
update public.menu_categories mc
set translations = coalesce(mc.translations, '{}'::jsonb)
                 || jsonb_build_object('ar', jsonb_build_object('name', v.ar))
from (values
  ('Cocktails',    'كوكتيلات'),
  ('Smoothies',    'سموذي'),
  ('Cafés & thés', 'قهوة وشاي'),
  ('En-cas',       'وجبات خفيفة')
) as v(fr, ar),
public.restaurants r
where mc.restaurant_id = r.id
  and r.slug = 'le-sirocco'
  and mc.name = v.fr
  and (mc.translations -> 'ar' ->> 'name') is null;  -- jamais d'écrasement

-- ------------------------------------------------------------
-- Produits
-- ------------------------------------------------------------
update public.menu_items mi
set translations = coalesce(mi.translations, '{}'::jsonb)
                 || jsonb_build_object(
                      'ar',
                      jsonb_strip_nulls(
                        jsonb_build_object('name', v.ar_name, 'description', v.ar_desc)
                      )
                    )
from (values
  -- Cocktails
  ('Sirocco',            'سيروكو',              'مانجو، فاكهة العاطفة، ليمون أخضر'),
  ('Sahara Sunset',      'غروب الصحراء',        'برتقال أحمر، شراب الرمان، ماء غازي'),
  ('Menthe Royale',      'نعناع ملكي',          'نعناع طازج، ليمون، شراب القصب'),
  ('Virgin Mojito',      'موهيتو بدون كحول',    'نعناع، ليمون أخضر، سكر القصب'),
  -- Smoothies
  ('Smoothie mangue',    'سموذي بالمانجو',      'مانجو، موز، حليب اللوز'),
  ('Smoothie fraise',    'سموذي بالفراولة',     'فراولة، موز، لبن'),
  ('Smoothie détox',     'سموذي منعش',          'سبانخ، تفاح أخضر، ليمون، زنجبيل'),
  -- Cafés et thés
  ('Espresso',           'إسبريسو',             'قصير ومركّز'),
  ('Cappuccino',         'كابتشينو',            'رغوة حليب ناعمة'),
  ('Thé à la menthe',    'شاي بالنعناع',        'يُقدَّم في إبريق مع كأسين'),
  ('Thé vert jasmin',    'شاي أخضر بالياسمين',  'معطّر، يُقدَّم في إبريق'),
  -- En-cas
  ('Club sandwich',      'كلوب ساندويتش',       'دجاج، بيض، خضار، بطاطس مقلية منزلية'),
  ('Club sandwich thon', 'كلوب ساندويتش بالتونة','تونة، بيض، خضار، بطاطس مقلية منزلية'),
  ('Assiette de fruits', 'طبق فواكه',           'فواكه طازجة حسب الموسم'),
  ('Olives & amandes',   'زيتون ولوز',          'للتسلية، يُقدَّم بارداً')
) as v(fr_name, ar_name, ar_desc),
public.menu_categories mc,
public.restaurants r
where mi.category_id = mc.id
  and mc.restaurant_id = r.id
  and r.slug = 'le-sirocco'
  and mi.name = v.fr_name
  and (mi.translations -> 'ar' ->> 'name') is null;  -- jamais d'écrasement

-- ------------------------------------------------------------
-- Contrôle : produits du Sirocco encore sans traduction arabe
-- ------------------------------------------------------------
select mi.name as sans_traduction
from public.menu_items mi
join public.menu_categories mc on mc.id = mi.category_id
join public.restaurants r on r.id = mc.restaurant_id
where r.slug = 'le-sirocco'
  and (mi.translations -> 'ar' ->> 'name') is null;

-- ------------------------------------------------------------
-- REPRENDRE UNE TRADUCTION (destructif, à décommenter au besoin)
--
-- Efface l'arabe d'un produit précis pour que le script puisse le
-- réinsérer. Les autres langues sont conservées.
-- ------------------------------------------------------------
-- update public.menu_items mi
-- set translations = mi.translations - 'ar'
-- from public.menu_categories mc, public.restaurants r
-- where mi.category_id = mc.id and mc.restaurant_id = r.id
--   and r.slug = 'le-sirocco' and mi.name = 'Sirocco';
