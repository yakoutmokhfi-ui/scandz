-- ============================================================
-- Scanym V68 — Rollback (identité visuelle établissement)
--
-- À exécuter manuellement par le CIO si besoin de revenir en arrière
-- après une V68 déjà appliquée. NE PAS EXÉCUTER AUTOMATIQUEMENT.
--
-- Comportement NON destructif par défaut : les fichiers déjà
-- uploadés restent dans le bucket Storage, restaurant_configs.logo_url
-- garde sa valeur actuelle (colonne préexistante, jamais touchée par
-- V68). cover_url N'EST PAS supprimée par défaut (une colonne
-- nullable déjà en place ne gêne rien) — suppression optionnelle en
-- bas de fichier, jamais exécutée automatiquement. Seules les
-- RPC/policies introduites par V68 sont retirées.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'cover_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.cover_url introuvable — rollback V68 annulé (V68 ne semble pas appliquée).';
  end if;
end $$;

begin;

drop function if exists public.set_restaurant_logo(uuid, text);
drop function if exists public.set_restaurant_cover(uuid, text);
drop function if exists public.assert_restaurant_asset_role(uuid);

drop policy if exists "establishment_assets_select_authorized" on storage.objects;
drop policy if exists "establishment_assets_insert_authorized" on storage.objects;
drop policy if exists "establishment_assets_update_authorized" on storage.objects;
drop policy if exists "establishment_assets_delete_authorized" on storage.objects;

-- Le bucket lui-même N'EST PAS supprimé ici (mêmes raisons que le
-- rollback V67 : storage.buckets refuse la suppression tant qu'il
-- contient des objets, et cela romprait immédiatement les logos/
-- covers déjà affichés publiquement). Suppression destructive
-- optionnelle en bas de fichier.

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('set_restaurant_logo', 'set_restaurant_cover', 'assert_restaurant_asset_role')
  ) then
    raise exception using errcode = 'P0001', message = 'SCANYM_ROLLBACK_INCOMPLETE';
  end if;
end $$;

commit;

-- ============================================================
-- Suppression DESTRUCTIVE optionnelle du bucket et de tout son
-- contenu (logos/covers de TOUS les établissements) — jamais exécutée
-- automatiquement, décision produit à part entière :
--
--   delete from storage.objects where bucket_id = 'establishment-assets';
--   delete from storage.buckets where id = 'establishment-assets';
--
-- Suppression DESTRUCTIVE optionnelle de la colonne cover_url (perd
-- toute référence de cover déjà enregistrée) — jamais exécutée
-- automatiquement :
--
--   alter table public.restaurant_configs drop column if exists cover_url;
--
-- Retour arrière du CODE (frontend) : ce fichier ne couvre que la
-- base de données / Storage. Utiliser `git revert` du commit V68 ou
-- l'application inverse du patch fourni — jamais une restauration
-- manuelle fichier par fichier.
-- ============================================================
