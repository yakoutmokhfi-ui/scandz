-- ============================================================
-- Scanym — BULK PRODUCT PHOTOS v1.8 — FINAL DURABLE CLEANUP STATE
-- MACHINE — ROLLBACK
--
-- Annule EXACTEMENT DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql
-- (forme v1.8, cumulative depuis V67 -- inclut le contenu
-- v1.4/v1.5/v1.6/v1.7) : restaure l'état PUBLIÉ EXACT de la migration
-- V67 (migration-v67-product-photos.sql) --
--   (a) DROP de la TABLE product_photo_pending_cleanups (v1.7,
--       colonnes étendues v1.8) ;
--   (b) DROP des HUIT fonctions v1.4/v1.5/v1.6/v1.7/v1.8
--       (create_product_photo_pending_cleanup/
--       claim_product_photo_pending_cleanup/
--       finalize_product_photo_pending_cleanup/
--       release_product_photo_pending_cleanup/
--       begin_product_photo_replacement/apply_product_photo_replacement/
--       assert_product_role_for/_product_photo_path_segments/
--       _product_photo_relative_path_shape) -- note : ce compte est de
--       NEUF objets au total en comptant la table, HUIT fonctions
--       stricto sensu (retry_product_photo_cleanup_path -- v1.6 -- et
--       reopen_product_photo_pending_cleanup -- v1.7 -- ne sont PAS
--       dans cette liste -- ce fichier v1.8 ne les a jamais recréées,
--       elles n'existent donc déjà plus avant même ce rollback) ;
--   (c) recréation de public.set_product_photo(uuid, text) avec son
--       CORPS EXACT d'origine V67 -- aucune capture de provenance,
--       aucune validation de forme de chemin, aucun verrouillage
--       explicite (même contenu que les rollbacks v1.3/v1.4/v1.5/v1.6/
--       v1.7, puisque le rollback de CE dépôt restaure toujours l'état
--       PUBLIÉ le plus récent, jamais un état intermédiaire non
--       publié type v1.1..v1.7) ;
--   (d) les 4 policies storage.objects du bucket product-photos dans
--       leur état publié EXACT (migration-v67-product-photos.sql,
--       section 2b) -- owner/manager du restaurant du chemin
--       uniquement, SANS le bypass is_scanym_operator(), SANS liaison
--       d'entité, SANS forme exacte de chemin, SANS using(false).
--
-- ADDENDUM v2.2 -- voir ADDENDUM v2.2 du fichier direct
-- (DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql) : le
-- mécanisme v2.1 (paramètre p_idempotency_key + colonne
-- menu_items.photo_idempotency_key) est retiré, remplacé par un
-- mécanisme strictement côté Node (chemin Storage déterministe). Ce
-- fichier ROLLBACK est donc lui aussi redevenu BYTE POUR BYTE
-- identique à la forme v1.8/v2.0 déjà validée pour cet état précis --
-- rien de plus à annuler pour v2.2 côté SQL (voir ADDENDUM v2.2.1
-- ci-dessous pour la mise à jour ultérieure).
--
-- ADDENDUM v2.2.1 -- voir ADDENDUM v2.2.1 du fichier direct pour le
-- détail complet du correctif de course fermé. apply_product_photo_
-- replacement gagne un 5ème paramètre additif,
-- `p_is_retry boolean default false` -- ce rollback DROP la fonction
-- avec sa signature EXACTE à 5 arguments (le DROP FUNCTION doit
-- toujours cibler la signature réellement installée) ; la précondition
-- de dérive de schéma ci-dessous (pg_get_function_identity_arguments)
-- est mise à jour en conséquence. Aucun autre objet SQL de ce fichier
-- n'est affecté -- ce correctif reste strictement scopé à
-- apply_product_photo_replacement.
--
-- Après ce rollback SEUL (SQL uniquement), le code applicatif
-- (lib/services/product-photo.ts, lib/server/product-photo-service.ts,
-- les routes app/api/dashboard/catalogue/product-photo/*) reste dans
-- sa forme v1.8 -- il continuerait d'appeler begin_/apply_/create_/
-- claim_/finalize_/release_product_photo_pending_cleanup, qui
-- n'existeraient plus, et échouerait donc explicitement (jamais
-- silencieusement) tant qu'un rollback applicatif correspondant n'est
-- pas également déployé. Ce comportement fail-closed est documenté ici
-- et dans ROLLBACK-EVIDENCE.md -- inchangé dans sa nature depuis les
-- rollbacks précédents de ce lot.
--
-- Usage (development/staging uniquement, jamais Production par ce
-- lot) : appliquer après DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql
-- (forme v1.8) si un rollback est requis.
-- ============================================================

do $$
begin
  if (
    select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in (
        'product_photos_select_own_restaurant',
        'product_photos_insert_own_restaurant',
        'product_photos_update_own_restaurant',
        'product_photos_delete_own_restaurant'
      )
  ) <> 4 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: les 4 policies product_photos_%% attendues sont introuvables -- rollback annulé, rien modifié.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'begin_product_photo_replacement'
      and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_product_photo_replacement'
      and pg_get_function_identity_arguments(p.oid) = 'p_caller_user_id uuid, p_product_id uuid, p_new_image_url text, p_expected_origin text, p_is_retry boolean'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_product_role_for'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_product_photo_path_segments'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_product_id uuid, p_image_url text, p_expected_origin text'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_product_photo_relative_path_shape'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product_photo_pending_cleanup'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_product_photo_pending_cleanup'
      and pg_get_function_identity_arguments(p.oid) = 'p_caller_user_id uuid, p_product_id uuid, p_cleanup_id uuid, p_expected_origin text, p_lease_seconds integer'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_product_photo_pending_cleanup'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'release_product_photo_pending_cleanup'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: begin_/apply_/assert_product_role_for/_product_photo_path_segments/_product_photo_relative_path_shape/create_/claim_(v1.8 signature)/finalize_/release_product_photo_pending_cleanup introuvables avec la signature v1.8 attendue -- rollback annulé.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'product_photo_pending_cleanups'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_photo_pending_cleanups' and column_name = 'lease_until'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.product_photo_pending_cleanups introuvable ou ne correspond pas au contrat v1.8 (colonne lease_until manquante) -- rollback annulé.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------
-- (a) + (b) -- DROP de la table v1.7 (colonnes étendues v1.8) puis des
-- 8 fonctions v1.4/v1.5/v1.6/v1.7/v1.8 (ordre : fonctions dépendantes
-- de la table d'abord, ne serait-ce que pour la lisibilité -- aucune
-- dépendance FK/vue n'existe réellement entre ces objets, chaque DROP
-- est indépendant).
-- ------------------------------------------------------------

drop function public.create_product_photo_pending_cleanup(uuid, uuid, text, text);
drop function public.claim_product_photo_pending_cleanup(uuid, uuid, uuid, text, integer);
drop function public.finalize_product_photo_pending_cleanup(uuid, uuid, uuid, uuid);
drop function public.release_product_photo_pending_cleanup(uuid, uuid, uuid, uuid);
drop table public.product_photo_pending_cleanups;
drop function public.begin_product_photo_replacement(uuid);
drop function public.apply_product_photo_replacement(uuid, uuid, text, text, boolean);
drop function public.assert_product_role_for(uuid, uuid, text[]);
drop function public._product_photo_path_segments(uuid, uuid, text, text);
drop function public._product_photo_relative_path_shape(uuid, uuid, text);

create function public.set_product_photo(
  p_product_id uuid,
  p_image_url  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_image_url text;
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  v_image_url := nullif(btrim(coalesce(p_image_url, ''), E' \t\n\r\f' || chr(11)), '');
  if v_image_url is not null and length(v_image_url) > 2048 then
    raise exception using errcode = '22023', message = 'Image URL too long';
  end if;

  update public.menu_items
  set image_url = v_image_url
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

revoke all on function public.set_product_photo(uuid, text) from public, anon;
grant execute on function public.set_product_photo(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- (d) Policies -- restauration de l'état publié V67 exact.
-- ------------------------------------------------------------

drop policy "product_photos_select_own_restaurant" on storage.objects;
create policy "product_photos_select_own_restaurant"
on storage.objects for select
to authenticated
using (
  bucket_id = 'product-photos'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
      and ru.role = any (array['owner','manager'])
  )
);

drop policy "product_photos_insert_own_restaurant" on storage.objects;
create policy "product_photos_insert_own_restaurant"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'product-photos'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
      and ru.role = any (array['owner','manager'])
  )
);

drop policy "product_photos_update_own_restaurant" on storage.objects;
create policy "product_photos_update_own_restaurant"
on storage.objects for update
to authenticated
using (
  bucket_id = 'product-photos'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
      and ru.role = any (array['owner','manager'])
  )
)
with check (
  bucket_id = 'product-photos'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
      and ru.role = any (array['owner','manager'])
  )
);

drop policy "product_photos_delete_own_restaurant" on storage.objects;
create policy "product_photos_delete_own_restaurant"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'product-photos'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
      and ru.role = any (array['owner','manager'])
  )
);

commit;
