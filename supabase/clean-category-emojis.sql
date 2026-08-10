-- ============================================================
-- Scanym — Retrait des émojis des noms de catégories
--
-- Motif : les émojis donnent un aspect amateur sur une carte, et
-- certains sont impropres (une poêle pour des formules sucrées).
-- Les titres nus font plus soignés.
--
-- Additif et idempotent : les noms français ET leurs traductions
-- sont nettoyés, dans les trois établissements. Rejouable sans
-- effet de bord — une seconde exécution ne trouve plus rien à
-- retirer.
--
-- ⚠️ Le nom de catégorie sert de clé de rapprochement dans
-- plusieurs scripts (traductions, options). Ceux-ci devront être
-- adaptés si vous les rejouez après ce nettoyage.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nom de base (français)
--
-- Retire tout ce qui précède la première lettre : émoji, espaces
-- et espaces insécables. Les noms sans émoji ne bougent pas.
-- ------------------------------------------------------------
update public.menu_categories
set name = trim(regexp_replace(name, '^[^[:alpha:]]+', ''))
where name ~ '^[^[:alpha:]]';

-- ------------------------------------------------------------
-- 2. Traductions
--
-- Même nettoyage sur chaque langue. jsonb_set conserve les autres
-- clés de l'objet, description comprise. Les langues absentes sont
-- ignorées.
-- ------------------------------------------------------------
do $$
declare
  v_lang text;
begin
  foreach v_lang in array array['fr', 'en', 'ar'] loop
    update public.menu_categories
    set translations = jsonb_set(
          translations,
          array[v_lang, 'name'],
          to_jsonb(trim(regexp_replace(
            translations -> v_lang ->> 'name', '^[^[:alpha:]]+', '')))
        )
    where translations -> v_lang ->> 'name' is not null
      and translations -> v_lang ->> 'name' ~ '^[^[:alpha:]]';
  end loop;
end $$;

-- ------------------------------------------------------------
-- Contrôle : plus aucune catégorie ne commence par un émoji
-- ------------------------------------------------------------
select r.slug, mc.name, mc.translations -> 'ar' ->> 'name' as arabe
from public.menu_categories mc
join public.restaurants r on r.id = mc.restaurant_id
order by r.slug, mc.display_order;
