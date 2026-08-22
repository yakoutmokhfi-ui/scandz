-- ============================================================
-- Scanym LOT 1B — Rollback
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- Analyse de sécurité du rollback (leçon L1A-01 appliquée) :
--   - restaurant_configs.translations, .intro_text_hash,
--     .announcement_text_hash sont des colonnes NOUVELLES créées par
--     LOT 1B : les supprimer perd toute traduction restaurant-level
--     déjà saisie, mais c'est la conséquence ATTENDUE et ACCEPTÉE d'un
--     rollback de lot (même principe que LOT 1A pour display_name/
--     bg_color) -- PAS une incompatibilité structurelle type L1A-01
--     (aucun CHECK ne serait violé par une réapplication ultérieure).
--     Un préflight INFORMATIF (NOTICE, pas un blocage) signale le
--     volume concerné avant suppression, par transparence.
--   - menu_categories.translations / menu_items.translations
--     EXISTAIENT AVANT LOT 1B (migration-translations.sql, historique) :
--     ce rollback ne les supprime PAS, ne les vide PAS -- seules les
--     colonnes de hash GÉNÉRÉES (name_hash, description_hash,
--     short_description_hash) sont retirées. Les clés de statut/hash
--     ajoutées par LOT 1B À L'INTÉRIEUR de ces JSONB existants
--     redeviennent simplement inertes (plus aucun code ne les lit),
--     jamais supprimées : aucune perte de contenu traduit déjà validé
--     sur catégories/produits.
--   - get_merchant_catalogue restaurée à son corps EXACT d'avant LOT
--     1B (v67b, extrait programmatiquement, jamais retapé à la main).
--
-- Ordre : préflight informatif -> write_translation supprimée ->
-- get_restaurant_translation_settings supprimée -> get_merchant_catalogue
-- restaurée (DROP + CREATE, changement de type de retour) -> colonnes
-- de hash retirées (3 tables) -> restaurant_configs.translations retirée.
-- ============================================================

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.restaurant_configs
  where translations is not null;
  raise notice 'SCANYM_ROLLBACK_LOT1B: % établissement(s) ont des traductions restaurant-level (intro_text/announcement_text) qui seront perdues par ce rollback (colonne restaurant_configs.translations, introduite par LOT 1B). Les traductions de catégories/produits (menu_categories/menu_items.translations, colonne PRÉ-EXISTANTE) ne sont PAS affectées.', v_count;
end $$;

begin;

drop function if exists public.write_translation(uuid, text, uuid, text, text, text, text);
drop function if exists public.get_restaurant_translation_settings(uuid);

drop function if exists public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id                 uuid,
  category_id                uuid,
  category_name               text,
  category_translations       jsonb,
  category_display_order      integer,
  category_is_option_source   boolean,
  category_description        text,
  name                        text,
  short_description            text,
  description                  text,
  translations                 jsonb,
  price                        numeric,
  is_available                 boolean,
  archived_at                  timestamptz,
  display_order                integer,
  is_option_source             boolean,
  image_url                    text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  select mi.id, mc.id, mc.name::text, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description,
         mi.name::text, mi.short_description, mi.description, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         ),
         mi.image_url
  from public.menu_categories mc
  left join public.menu_items mi
    on mi.category_id = mc.id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name, mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- Colonnes de hash GÉNÉRÉES retirées -- purement dérivées, aucune
-- perte de contenu source ou traduit (menu_categories/menu_items.name/
-- description/short_description et leurs translations restent
-- intacts, seule la colonne de hash calculée disparaît).
alter table public.menu_items
  drop column if exists description_hash,
  drop column if exists short_description_hash,
  drop column if exists name_hash;

alter table public.menu_categories
  drop column if exists description_hash,
  drop column if exists name_hash;

-- restaurant_configs.translations : NOUVELLE colonne LOT 1B, retirée
-- avec ses 2 colonnes de hash générées associées (voir préflight
-- informatif ci-dessus pour le volume concerné).
alter table public.restaurant_configs
  drop column if exists announcement_text_hash,
  drop column if exists intro_text_hash,
  drop column if exists translations;

commit;
