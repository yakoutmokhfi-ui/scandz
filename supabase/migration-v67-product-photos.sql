-- ============================================================
-- Scanym V67 — Photo produit (Supabase Storage)
--
-- À exécuter APRÈS migration-v66-categories-descriptions.sql.
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement dans le SQL Editor Supabase, dans l'ordre indiqué dans
-- le rapport de livraison.
--
-- Contenu :
--   1. Contrôle préalable de non-dérive (signature exacte de
--      get_merchant_catalogue attendue, colonne menu_items.image_url
--      déjà présente depuis le schéma canonique, bucket/RPC pas déjà
--      créés) — RÉELLEMENT EXÉCUTÉ, comme en V65/V66.
--   2. Transaction unique : bucket Storage "product-photos" (public),
--      policies storage.objects (écriture réservée owner/manager du
--      bon restaurant), nouvelle RPC set_product_photo,
--      get_merchant_catalogue étendue avec image_url.
--
-- CHOIX STORAGE — bucket PUBLIC, justification :
-- Le menu (app/r/[slug]) est une page publique, sans authentification,
-- consultée par les clients via un QR code physique. Une image privée
-- nécessiterait soit une URL signée regénérée à chaque rendu (coût,
-- complexité, expiration à gérer côté client public), soit un appel
-- API supplémentaire par photo. Aucune donnée sensible n'est stockée
-- dans ces fichiers (ce sont des photos de produits déjà visibles sur
-- le menu public) : un bucket public expose exactement ce qui est de
-- toute façon déjà public, sans réduire la confidentialité de quoi
-- que ce soit. L'ÉCRITURE (insert/update/delete), elle, N'EST PAS
-- publique : réservée par policy aux owner/manager du restaurant
-- propriétaire du chemin (voir section 2b).
--
-- CONVENTION DE CHEMIN — {restaurant_id}/{product_id}/{fichier} :
-- Les deux premiers segments sont des UUID (jamais des slugs, jamais
-- fournis par l'utilisateur final) : aucune ambiguïté multi-tenant,
-- aucun risque de collision entre établissements. Le nom de fichier
-- lui-même est généré côté client (lib/services/product-photo.ts,
-- crypto.randomUUID() + extension dérivée du type MIME validé) —
-- JAMAIS le nom de fichier fourni par l'utilisateur : élimine tout
-- risque de traversée de chemin ou de collision via un nom de fichier
-- malveillant.
-- ============================================================

do $$
declare
  v_count integer;
begin
  -- 1a. get_merchant_catalogue doit exister avec exactement la
  -- signature V66 (sinon cette migration a déjà tourné, ou V66
  -- n'est pas encore en place).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte get_merchant_catalogue(uuid,boolean) introuvable — migration V67 annulée, aucune modification appliquée.';
  end if;

  -- 1b. image_url doit déjà exister sur menu_items (schéma canonique,
  -- supabase/schema.sql) : cette migration ne crée pas de colonne,
  -- elle réutilise l'existante.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'image_url'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items.image_url introuvable — migration V67 annulée.';
  end if;

  -- 1c. set_product_photo ne doit pas déjà exister (évite un doublon
  -- silencieux si cette migration a déjà tourné partiellement).
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_product_photo';
  if v_count <> 0 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.set_product_photo existe déjà (%) — migration V67 annulée, à examiner avant de relancer.',
      v_count;
  end if;

  -- 1d. Le bucket product-photos ne doit pas déjà exister (évite de
  -- reconfigurer silencieusement un bucket créé manuellement avec des
  -- réglages différents).
  if exists (select 1 from storage.buckets where id = 'product-photos') then
    raise exception
      'SCANYM_SCHEMA_DRIFT: le bucket storage "product-photos" existe déjà — migration V67 annulée, à examiner avant de relancer (la migration n''est pas conçue pour être rejouée après un premier succès).';
  end if;

  -- 1e. Aucune policy storage.objects du même nom ne doit déjà
  -- exister (mêmes raisons que 1d).
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'product_photos_%'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: une policy storage.objects "product_photos_%%" existe déjà — migration V67 annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. Bucket Storage. Public en lecture (voir justification en tête
-- de fichier) ; l'écriture est entièrement contrôlée par les policies
-- de la section 2b, pas par ce flag.
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-photos',
  'product-photos',
  true,
  5242880, -- 5 Mo — doit rester synchronisé avec MAX_FILE_SIZE_BYTES dans lib/services/product-photo.ts
  array['image/jpeg', 'image/png', 'image/webp']
);

-- ------------------------------------------------------------
-- 2b. Policies storage.objects — écriture réservée owner/manager du
-- restaurant propriétaire du chemin. Même modèle de rôle que
-- assert_product_role() (migration-v31-catalogue.sql) : owner et
-- manager seulement, jamais staff (cohérent avec update_product,
-- create_category — l'édition de fiche produit n'est pas une tâche
-- opérationnelle staff, contrairement à set_product_availability).
--
-- Une policy SELECT, restreinte à owner/manager du restaurant du
-- chemin, EST nécessaire malgré le bucket public : le rendu du menu
-- public ne passe jamais par elle (il utilise l'URL publique
-- /storage/v1/object/public/..., qui court-circuite entièrement RLS,
-- comportement standard Supabase pour un bucket public — c'est ce qui
-- justifie le bucket public en tête de fichier). Mais UPDATE et
-- DELETE, eux, doivent d'abord "voir" la ligne pour la cibler : sans
-- AUCUNE policy SELECT applicable, PostgreSQL ne trouve aucune ligne
-- à mettre à jour ou supprimer, même pour le propriétaire légitime —
-- vérifié empiriquement (harnais local, voir
-- supabase/tests/v67-storage-policy-check.sh) avant d'écrire ce
-- commentaire, pas supposé : un premier essai sans policy SELECT
-- laissait silencieusement `DELETE 0` même pour l'owner du bon
-- restaurant. Cette policy SELECT reste strictement limitée à
-- owner/manager de leur propre restaurant — aucun accès public via
-- l'API SQL/PostgREST, aucune capacité de listing exposée à
-- authenticated pour les fichiers des AUTRES établissements.
--
-- (storage.foldername(name))[1] = premier segment du chemin =
-- restaurant_id (texte, comparé en ::uuid).
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- 2c. set_product_photo — même gabarit que set_product_availability
-- (migration-v31-catalogue.sql) : un seul champ, assert_product_role
-- réutilisée telle quelle (aucune logique d'autorisation dupliquée).
--
-- p_image_url = null retire la photo (le menu public revient
-- immédiatement au rendu "sans photo", géré côté frontend par la
-- garde déjà existante `{item.image_url && (...)}`).
-- ------------------------------------------------------------

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
-- 2d. get_merchant_catalogue — suppression + recréation (ajout de
-- image_url ; PostgreSQL n'autorise pas create or replace function
-- avec un type de retour différent, comme en V66).
-- ------------------------------------------------------------

drop function if exists public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id              uuid,
  category_id             uuid,
  category_name           text,
  category_translations   jsonb,
  category_display_order  integer,
  category_is_option_source boolean,
  name                    text,
  short_description       text,
  description             text,
  translations            jsonb,
  price                   numeric,
  is_available            boolean,
  archived_at             timestamptz,
  display_order           integer,
  is_option_source        boolean,
  image_url               text
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
  order by mc.display_order, mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

commit;

-- ============================================================
-- Résumé des changements par rapport à V66 :
--   + bucket storage "product-photos" (public, 5 Mo max,
--     image/jpeg|png|webp uniquement au niveau bucket — défense en
--     profondeur, en plus de la validation côté client)
--   + 4 policies storage.objects (select/insert/update/delete),
--     réservées owner/manager du restaurant du chemin — SELECT
--     nécessaire pour qu'UPDATE/DELETE puissent cibler une ligne
--     (vérifié empiriquement, voir commentaire section 2b), sans
--     rapport avec le rendu du menu public (bucket public, bypass
--     RLS via l'URL /object/public/...)
--   + set_product_photo(uuid, text) — même gabarit que
--     set_product_availability, réutilise assert_product_role
--   ~ get_merchant_catalogue : drop + recréation, + image_url
-- Aucune colonne ajoutée (menu_items.image_url existait déjà).
-- Aucune fonction de commande touchée.
-- ============================================================
