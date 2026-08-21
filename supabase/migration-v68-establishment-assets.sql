-- ============================================================
-- Scanym V68 — Identité visuelle de l'établissement (logo & cover)
--
-- À exécuter APRÈS migration-lotd-establishment-creation.sql (utilise
-- public.is_scanym_operator(), créée par cette migration).
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement dans le SQL Editor Supabase.
--
-- ATTENTION NOMMAGE : ce lot est distinct du lot déjà fusionné sous le
-- nom « Lot D — création interne d'établissement »
-- (migration-lotd-establishment-creation.sql). Ce fichier est
-- volontairement nommé "v68" (suite de la numérotation existante,
-- v67/v67b) pour éviter toute confusion avec ce lot déjà en
-- production. Contenu strictement additif, aucun rapport avec la
-- création d'établissement.
--
-- Contenu :
--   1. Contrôle préalable de non-dérive.
--   2. Transaction unique :
--      a. colonne restaurant_configs.cover_url (nullable, additive) ;
--      b. bucket Storage "establishment-assets" (public, distinct du
--         bucket "product-photos" — voir justification ci-dessous) ;
--      c. policies storage.objects DÉDIÉES à ce bucket, PAS de
--         réutilisation ni d'extension des policies product_photos_* ;
--      d. fonction interne assert_restaurant_asset_role ;
--      e. RPC set_restaurant_logo / set_restaurant_cover.
--
-- POURQUOI UN BUCKET SÉPARÉ (et pas product-photos) :
-- product-photos est scopé par produit ({restaurant_id}/{product_id}/
-- ...) et ses 4 policies (product_photos_select|insert|update|delete
-- _own_restaurant) sont écrites, testées et auditées pour CE
-- périmètre précis (fiche produit, rôle owner/manager uniquement).
-- L'identité d'établissement a une portée différente : (1) le chemin
-- n'a qu'un segment de portée ({restaurant_id}/...), aucun product_id
-- n'existe pour un logo ou un cover ; (2) un opérateur Scanym interne
-- (scanym_operators, table du Lot D création d'établissement) doit
-- pouvoir administrer les assets de N'IMPORTE QUEL établissement,
-- alors que product-photos reste strictement borné à l'owner/manager
-- du restaurant concerné. Modifier les policies product_photos_* pour
-- accueillir ce second besoin les aurait rendues plus complexes et
-- aurait fait courir un risque de régression sur une fonctionnalité
-- déjà en production ; un bucket et des policies dédiés isolent
-- entièrement les deux périmètres — changement dans l'un ne peut pas
-- affecter l'autre.
--
-- CONVENTION DE CHEMIN — {restaurant_id}/{logo|cover}/{fichier} :
-- Premier segment = restaurant_id (UUID), comme product-photos :
-- c'est ce que vérifient les policies. Le nom de fichier est généré
-- côté client (crypto.randomUUID() + extension dérivée du type MIME
-- réellement détecté, jamais du nom fourni par l'utilisateur ni de
-- son extension déclarée) : chaque upload obtient une URL NEUVE, ce
-- qui évite tout souci de cache CDU/navigateur lors d'un remplacement
-- (contrairement à un nom fixe "logo.png" réécrit en place).
-- ============================================================

do $$
declare
  v_count integer;
begin
  -- 1a. is_scanym_operator doit déjà exister (Lot D — création
  -- d'établissement, déjà fusionné) : cette migration s'appuie dessus
  -- sans la redéfinir ni modifier scanym_operators.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.is_scanym_operator() introuvable — migration V68 annulée. Prérequis : migration-lotd-establishment-creation.sql doit déjà être appliquée.';
  end if;

  -- 1b. restaurant_users et restaurant_configs doivent exister (base
  -- déjà en place depuis migration-orders.sql / schema.sql).
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'restaurant_users'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_users introuvable — migration V68 annulée.';
  end if;

  -- 1c. cover_url ne doit pas déjà exister.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'cover_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.cover_url existe déjà — migration V68 annulée.';
  end if;

  -- 1d. Aucune des fonctions/RPC créées ici ne doit déjà exister.
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('assert_restaurant_asset_role', 'set_restaurant_logo', 'set_restaurant_cover');
  if v_count <> 0 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: une ou plusieurs fonctions V68 existent déjà (%) — migration annulée, à examiner avant de relancer.',
      v_count;
  end if;

  -- 1e. Le bucket establishment-assets ne doit pas déjà exister.
  if exists (select 1 from storage.buckets where id = 'establishment-assets') then
    raise exception
      'SCANYM_SCHEMA_DRIFT: le bucket storage "establishment-assets" existe déjà — migration V68 annulée.';
  end if;

  -- 1f. Aucune policy storage.objects du même nom ne doit déjà exister.
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'establishment_assets_%'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: une policy storage.objects "establishment_assets_%%" existe déjà — migration V68 annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. Colonne cover_url — additive, nullable, aucun défaut.
-- logo_url N'EST PAS TOUCHÉE (ni renommée, ni retirée, ni redéfinie) :
-- tout établissement existant garde exactement son logo_url actuel et
-- un cover_url NULL, sans migration de données ni action requise.
-- ------------------------------------------------------------

alter table public.restaurant_configs
  add column if not exists cover_url text;

comment on column public.restaurant_configs.cover_url is
  'Photo de couverture de la carte publique (V68, Supabase Storage, bucket establishment-assets). Nullable : NULL = aucune bascule, le rendu public garde son repli actuel (bannière /banners/<slug>.jpg). Distincte de logo_url (identité/logo de l''établissement, inchangée).';

-- ------------------------------------------------------------
-- 2b. Bucket Storage. Public en lecture, pour la même raison que
-- product-photos (carte publique consultée sans authentification) :
-- aucune donnée sensible dans ces fichiers. L'écriture est entièrement
-- contrôlée par les policies de la section 2c, pas par ce flag.
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'establishment-assets',
  'establishment-assets',
  true,
  5242880, -- 5 Mo — doit rester synchronisé avec MAX_FILE_SIZE_BYTES dans lib/services/establishment-assets.ts
  array['image/jpeg', 'image/png', 'image/webp']
);

-- ------------------------------------------------------------
-- 2c. Policies storage.objects — DÉDIÉES à establishment-assets,
-- indépendantes des policies product_photos_* (non modifiées, non
-- réutilisées, non étendues).
--
-- Autorisé à écrire dans {restaurant_id}/... :
--   - un membre de restaurant_users pour CE restaurant_id, rôle
--     owner ou manager (staff exclu, même modèle que product-photos
--     et update_restaurant_whatsapp : l'identité visuelle n'est pas
--     une tâche opérationnelle staff) ;
--   - OU un opérateur Scanym (public.is_scanym_operator()), pour
--     N'IMPORTE QUEL restaurant_id — c'est le seul mécanisme
--     d'administration multi-établissement de ce lot, et il réutilise
--     tel quel is_scanym_operator() sans toucher à scanym_operators
--     ni à ses policies (aucune policy directe sur cette table,
--     conforme à son modèle défini dans le Lot D création
--     d'établissement).
--
-- Aucun accès anonyme en écriture : policies "to authenticated"
-- uniquement. La lecture publique passe par le flag public du bucket
-- (URL /storage/v1/object/public/..., hors RLS), pas par une policy
-- SELECT ouverte à anon.
--
-- Une policy SELECT restreinte (mêmes autorisés que l'écriture) reste
-- nécessaire pour qu'UPDATE/DELETE puissent cibler une ligne — même
-- constat empirique que product-photos (voir
-- supabase/migration-v67-product-photos.sql, section 2b, et
-- supabase/tests/v67-storage-policy-check.sh), revérifié ici pour ce
-- bucket dans supabase/tests/v68-storage-policy-check.sh.
-- ------------------------------------------------------------

create policy "establishment_assets_select_authorized"
on storage.objects for select
to authenticated
using (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and (
    public.is_scanym_operator()
    or exists (
      select 1 from public.restaurant_users ru
      where ru.user_id = auth.uid()
        and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
        and ru.role = any (array['owner','manager'])
    )
  )
);

create policy "establishment_assets_insert_authorized"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and (
    public.is_scanym_operator()
    or exists (
      select 1 from public.restaurant_users ru
      where ru.user_id = auth.uid()
        and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
        and ru.role = any (array['owner','manager'])
    )
  )
);

create policy "establishment_assets_update_authorized"
on storage.objects for update
to authenticated
using (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and (
    public.is_scanym_operator()
    or exists (
      select 1 from public.restaurant_users ru
      where ru.user_id = auth.uid()
        and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
        and ru.role = any (array['owner','manager'])
    )
  )
)
with check (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and (
    public.is_scanym_operator()
    or exists (
      select 1 from public.restaurant_users ru
      where ru.user_id = auth.uid()
        and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
        and ru.role = any (array['owner','manager'])
    )
  )
);

create policy "establishment_assets_delete_authorized"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and (
    public.is_scanym_operator()
    or exists (
      select 1 from public.restaurant_users ru
      where ru.user_id = auth.uid()
        and ru.restaurant_id = ((storage.foldername(name))[1])::uuid
        and ru.role = any (array['owner','manager'])
    )
  )
);

-- ------------------------------------------------------------
-- 2d. assert_restaurant_asset_role — fonction interne partagée par
-- les deux RPC ci-dessous, même gabarit que assert_product_role
-- (migration-v31-catalogue.sql) : centralise la même règle
-- d'autorisation que les policies Storage ci-dessus, pour la
-- vérifier À NOUVEAU côté RPC (défense en profondeur : le masquage
-- de l'UI ou une policy Storage ne sont jamais la seule protection).
--
-- "revoke all ... from public" sans grant à authenticated : cette
-- fonction n'est PAS un point d'entrée RPC direct, seulement un
-- utilitaire interne appelé depuis set_restaurant_logo/_cover
-- (SECURITY DEFINER, donc exécuté avec les privilèges du
-- propriétaire de la fonction, indépendamment de qui a appelé la RPC).
-- ------------------------------------------------------------

create function public.assert_restaurant_asset_role(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    return;
  end if;

  if public.is_scanym_operator() then
    return;
  end if;

  raise exception using errcode = '42501',
    message = 'Not authorized for this restaurant';
end $$;

revoke all on function public.assert_restaurant_asset_role(uuid) from public;

-- ------------------------------------------------------------
-- 2e. set_restaurant_logo / set_restaurant_cover — un champ chacune,
-- même gabarit que set_product_photo (migration-v67). p_url = null
-- retire l'asset (reset explicite de la colonne à NULL).
--
-- Deux RPC distinctes plutôt qu'une seule paramétrée par nom de
-- colonne : chaque fonction ne touche littéralement qu'UNE colonne en
-- dur dans son UPDATE, ce qui élimine par construction tout risque de
-- construire dynamiquement un nom de colonne à partir d'une entrée
-- utilisateur.
-- ------------------------------------------------------------

create function public.set_restaurant_logo(
  p_restaurant_id uuid,
  p_url           text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_url := nullif(btrim(coalesce(p_url, ''), E' \t\n\r\f' || chr(11)), '');
  if v_url is not null and length(v_url) > 2048 then
    raise exception using errcode = '22023', message = 'Logo URL too long';
  end if;

  update public.restaurant_configs
  set logo_url = v_url
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.set_restaurant_logo(uuid, text) from public, anon;
grant execute on function public.set_restaurant_logo(uuid, text) to authenticated;

create function public.set_restaurant_cover(
  p_restaurant_id uuid,
  p_url           text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_url := nullif(btrim(coalesce(p_url, ''), E' \t\n\r\f' || chr(11)), '');
  if v_url is not null and length(v_url) > 2048 then
    raise exception using errcode = '22023', message = 'Cover URL too long';
  end if;

  update public.restaurant_configs
  set cover_url = v_url
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.set_restaurant_cover(uuid, text) from public, anon;
grant execute on function public.set_restaurant_cover(uuid, text) to authenticated;

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT AVANT VALIDATION (non exécutés ici,
-- voir preuve automatisée réelle dans
-- supabase/tests/v68-storage-policy-check.sh) :
--  ✓ owner du restaurant A upload dans A/logo/... et A/cover/...  → OK
--  ✗ owner du restaurant A upload dans B/...                     → refusé (RLS)
--  ✓ opérateur Scanym (scanym_operators) upload dans A/... et B/... → OK
--  ✗ utilisateur anonyme tente un upload                          → refusé (RLS, to authenticated)
--  ✗ staff du restaurant A upload dans A/...                       → refusé (assert_restaurant_asset_role)
--  ✓ set_restaurant_logo par owner de A                            → logo_url mis à jour
--  ✓ set_restaurant_cover par owner de A                           → cover_url mis à jour
--  ✗ set_restaurant_logo par owner d'un AUTRE restaurant            → Not authorized
--  ✗ appel anonyme à set_restaurant_logo/_cover                     → permission denied
--  ✓ migration rejouée après un premier succès                      → SCANYM_SCHEMA_DRIFT (bucket déjà présent), aucune double application
-- ============================================================
