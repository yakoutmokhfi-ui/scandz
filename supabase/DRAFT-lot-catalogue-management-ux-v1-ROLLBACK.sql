-- ============================================================
-- Scanym — CATALOGUE MANAGEMENT UX v1 — ROLLBACK
--
-- CE QUE CE FICHIER FAIT EXACTEMENT : il supprime les DEUX fonctions
-- ajoutées par ce lot, et rien d'autre.
--
--   drop function public.remove_product_tag(uuid, uuid)
--   drop function public.get_restaurant_product_tags(uuid)
--
-- AUCUNE donnée n'est perdue : ce lot ne crée aucune table, aucune
-- colonne, aucun index. Les tags, les associations produit-tag, la
-- visibilité et l'ordre des collections sont intégralement portés par
-- COLLECTIONS / TAGS FOUNDATION v1.1, que ce rollback ne touche pas.
-- Les associations retirées via `remove_product_tag` pendant que le
-- lot était installé ne sont évidemment pas restaurées -- ce sont des
-- actions marchandes délibérées, pas un effet du lot.
--
-- Le lot étant STRICTEMENT ADDITIF (2 fonctions neuves, zéro objet
-- préexistant modifié), le rollback l'est symétriquement : il n'a rien
-- à restaurer, seulement à retirer. Aucun précheck conditionnel n'est
-- donc nécessaire -- retirer une fonction neuve ne peut être bloqué
-- par aucun état de données.
--
-- ATOMICITÉ : transaction unique, contrôle de dérive en PREMIÈRE
-- instruction À L'INTÉRIEUR de celle-ci (et non avant `begin;`) -- un
-- contrôle placé avant ne protégerait que si psql tourne avec
-- -v ON_ERROR_STOP=1. Dans la transaction, un échec avorte tout et le
-- `commit;` final agit comme un ROLLBACK, indépendamment de tout
-- drapeau client.
--
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur Production par ce lot.
-- ============================================================

begin;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'remove_product_tag'
  ) then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: remove_product_tag introuvable -- cette base ne semble pas avoir reçu CATALOGUE MANAGEMENT UX v1, rollback annulé (aucune mutation).';
  end if;
end $$;

drop function if exists public.remove_product_tag(uuid, uuid);
drop function if exists public.get_restaurant_product_tags(uuid);

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('remove_product_tag', 'get_restaurant_product_tags')
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une RPC du lot subsiste -- rollback annulé.';
  end if;

  -- La fondation COLLECTIONS/TAGS doit être intacte après rollback.
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('assert_tag_admin', 'create_tag', 'add_product_tags',
                        'update_tag_collection_settings', 'get_restaurant_tags',
                        'get_restaurant_collections')
  ) <> 6 then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: la fondation COLLECTIONS/TAGS a été endommagée -- rollback annulé.';
  end if;

  if to_regclass('public.menu_tags') is null or to_regclass('public.menu_item_tags') is null then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une table de la fondation a disparu -- rollback annulé.';
  end if;
end $$;

commit;

-- ============================================================
-- FIN — CATALOGUE MANAGEMENT UX v1 — ROLLBACK
-- ============================================================
