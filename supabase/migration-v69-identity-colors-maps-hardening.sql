-- ============================================================
-- Scanym V69 — Compléments identité visuelle : couleurs
-- personnalisées, lien Google Maps, durcissement logo/cover
--
-- À exécuter APRÈS migration-v68-establishment-assets.sql (dont
-- dépendent set_restaurant_logo/_cover et les policies
-- establishment_assets_* modifiées ici). NE PAS EXÉCUTER
-- AUTOMATIQUEMENT : le CIO exécute ce fichier manuellement.
--
-- Ce fichier NE RÉÉCRIT PAS migration-v68-establishment-assets.sql :
-- il le COMPLÈTE et le CORRIGE ponctuellement, exactement comme
-- migration-lotd-rls-reference-tables-fix.sql l'a fait pour
-- migration-lotd-establishment-creation.sql (précédent déjà présent
-- dans ce dépôt) — même méthode, appliquée ici au lot V68.
--
-- Contenu :
--   1. Contrôle préalable de non-dérive.
--   2. Transaction unique :
--      a. restaurant_configs : primary_color/secondary_color/
--         accent_color (#RRGGBB, nullable) + google_maps_url
--         (http(s), nullable) — additif, CHECK défensif ;
--      b. update_restaurant_colors / update_restaurant_maps_url —
--         nouvelles RPC, owner/manager UNIQUEMENT (pas d'extension du
--         périmètre scanym_operators : réglages cosmétiques
--         d'établissement, pas une ressource Storage) ;
--      c. CREATE OR REPLACE set_restaurant_logo / set_restaurant_cover
--         (même signature (uuid, text) qu'en V68 — pas de rupture) :
--         ajout d'une validation stricte du CHEMIN de l'URL enregistrée ;
--      d. DROP + CREATE des 4 policies establishment_assets_* (mêmes
--         noms qu'en V68) : ajoute la restriction du 2e segment de
--         chemin à {logo, cover} uniquement. Tous les autres contrôles
--         (restaurant concerné, owner/manager, opérateur Scanym, staff
--         interdit) restent EXACTEMENT ceux de V68, non réécrits.
--
-- SÉCURITÉ 7 — CE QUE LA VALIDATION D'URL DE set_restaurant_logo/_cover
-- COUVRE, ET CE QU'ELLE NE COUVRE PAS (limite documentée, pas cachée) :
-- la RPC exige désormais que l'URL corresponde EXACTEMENT au format
-- .../storage/v1/object/public/establishment-assets/{restaurant_id}/
-- {logo|cover}/{uuid}.{jpg|png|webp}, ancré du début à la fin de la
-- chaîne (regexp ^...$, pas une simple recherche de sous-chaîne) :
-- restaurant_id doit être CELUI de l'appel (empêche un owner autorisé
-- de pointer vers le dossier d'un AUTRE établissement même si son
-- propre appel est légitime), le sous-dossier doit correspondre à la
-- RPC appelée (set_restaurant_logo n'accepte jamais /cover/, et
-- inversement), le nom de fichier doit être un UUID + extension
-- autorisée (jamais un nom arbitraire). CE QUI N'EST PAS VÉRIFIABLE
-- PORTABLEMENT EN SQL : le nom d'hôte réel du projet Supabase (propre
-- à chaque environnement — local/staging/prod, potentiellement un
-- domaine personnalisé), donc non embarqué en dur ici pour rester une
-- migration additive portable ; le motif accepte tout hôte
-- https?://<hôte>/ suivi du chemin exact ci-dessus. Un attaquant
-- disposant DÉJÀ d'un accès owner/manager légitime au bon
-- restaurant_id pourrait théoriquement contourner ce contrôle en
-- appelant la RPC directement (hors de l'application) avec une URL
-- respectant ce chemin mais hébergée ailleurs — risque résiduel
-- documenté dans le rapport de livraison, pas masqué.
-- ============================================================

do $$
begin
  -- 1a. Le lot V68 doit déjà être en place (dépendance directe).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_restaurant_logo'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_url text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.set_restaurant_logo(uuid,text) introuvable — migration V69 annulée. Prérequis : migration-v68-establishment-assets.sql doit déjà être appliquée.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_restaurant_cover'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_url text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.set_restaurant_cover(uuid,text) introuvable — migration V69 annulée.';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'establishment_assets_select_authorized'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: policy establishment_assets_select_authorized introuvable — migration V69 annulée.';
  end if;

  -- 1b. Colonnes V69 ne doivent pas déjà exister.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs'
      and column_name in ('primary_color', 'secondary_color', 'accent_color', 'google_maps_url')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une colonne V69 existe déjà sur restaurant_configs — migration annulée.';
  end if;

  -- 1c. Nouvelles RPC ne doivent pas déjà exister.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('update_restaurant_colors', 'update_restaurant_maps_url')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_restaurant_colors ou update_restaurant_maps_url existe déjà — migration V69 annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. Colonnes additives, toutes nullables, aucun défaut. Aucun
-- établissement existant n'est affecté (NULL = comportement
-- strictement identique à avant V69, voir lib/themes.ts et
-- components/RestaurantHeader.tsx).
-- ------------------------------------------------------------

alter table public.restaurant_configs
  add column if not exists primary_color text,
  add column if not exists secondary_color text,
  add column if not exists accent_color text,
  add column if not exists google_maps_url text;

alter table public.restaurant_configs
  add constraint restaurant_configs_primary_color_format
    check (primary_color is null or primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  add constraint restaurant_configs_secondary_color_format
    check (secondary_color is null or secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  add constraint restaurant_configs_accent_color_format
    check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  add constraint restaurant_configs_google_maps_url_format
    check (
      google_maps_url is null
      or (length(google_maps_url) <= 500 and google_maps_url ~ '^https?://')
    );

comment on column public.restaurant_configs.primary_color is
  'Couleur personnalisée (V69), #RRGGBB strict. Surcharge --sc-accent (lib/themes.ts). NULL = thème Scanym par défaut, inchangé.';
comment on column public.restaurant_configs.secondary_color is
  'Couleur personnalisée (V69), #RRGGBB strict. Surcharge --sc-ink (lib/themes.ts). NULL = thème Scanym par défaut, inchangé.';
comment on column public.restaurant_configs.accent_color is
  'Couleur personnalisée (V69), #RRGGBB strict. Surcharge --sc-highlight (lib/themes.ts). NULL = thème Scanym par défaut, inchangé.';
comment on column public.restaurant_configs.google_maps_url is
  'Lien Google Maps fourni par le commerçant (V69), http(s) uniquement. NULL = pas de CTA "Itinéraire" sur la carte publique (le lien calculé depuis latitude/longitude, s''il existe, continue de s''afficher).';

-- ------------------------------------------------------------
-- 2b. update_restaurant_colors / update_restaurant_maps_url —
-- réservées owner/manager du restaurant (même modèle que
-- update_restaurant_settings/update_restaurant_whatsapp,
-- migration-v39/v64), PAS étendu aux opérateurs Scanym : ce sont des
-- réglages cosmétiques d'établissement, hors du périmètre Storage
-- multi-établissement de assert_restaurant_asset_role.
--
-- Les 3 couleurs sont mises à jour ENSEMBLE (un seul appel = un seul
-- formulaire côté dashboard) ; chacune reste individuellement
-- nullable (une couleur peut être vidée sans toucher aux deux
-- autres).
-- ------------------------------------------------------------

create function public.update_restaurant_colors(
  p_restaurant_id  uuid,
  p_primary_color   text,
  p_secondary_color text,
  p_accent_color    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_primary   text;
  v_secondary text;
  v_accent    text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  v_primary   := nullif(btrim(coalesce(p_primary_color, ''), E' \t\n\r\f' || chr(11)), '');
  v_secondary := nullif(btrim(coalesce(p_secondary_color, ''), E' \t\n\r\f' || chr(11)), '');
  v_accent    := nullif(btrim(coalesce(p_accent_color, ''), E' \t\n\r\f' || chr(11)), '');

  if v_primary is not null and v_primary !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception using errcode = '22023', message = 'Invalid primary color format: expected #RRGGBB';
  end if;
  if v_secondary is not null and v_secondary !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception using errcode = '22023', message = 'Invalid secondary color format: expected #RRGGBB';
  end if;
  if v_accent is not null and v_accent !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception using errcode = '22023', message = 'Invalid accent color format: expected #RRGGBB';
  end if;

  update public.restaurant_configs
  set primary_color = v_primary,
      secondary_color = v_secondary,
      accent_color = v_accent
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_colors(uuid, text, text, text) from public, anon;
grant execute on function public.update_restaurant_colors(uuid, text, text, text) to authenticated;

create function public.update_restaurant_maps_url(
  p_restaurant_id uuid,
  p_maps_url      text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  v_url := nullif(btrim(coalesce(p_maps_url, ''), E' \t\n\r\f' || chr(11)), '');

  if v_url is not null then
    if length(v_url) > 500 then
      raise exception using errcode = '22023', message = 'Google Maps URL too long';
    end if;
    if v_url !~ '^https?://' then
      raise exception using errcode = '22023', message = 'Invalid Google Maps URL: must start with http:// or https://';
    end if;
  end if;

  update public.restaurant_configs
  set google_maps_url = v_url
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_maps_url(uuid, text) from public, anon;
grant execute on function public.update_restaurant_maps_url(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 2c. set_restaurant_logo / set_restaurant_cover — CREATE OR REPLACE,
-- MÊME SIGNATURE (uuid, text) qu'en V68 : aucune rupture pour
-- lib/services/establishment-assets.ts, qui appelle ces RPC sans rien
-- changer. Seul le corps change : ajout d'une validation stricte du
-- CHEMIN de l'URL avant écriture (voir note SÉCURITÉ 7 en tête de
-- fichier). assert_restaurant_asset_role reste appelée en premier,
-- inchangée (owner/manager OU opérateur Scanym, comme en V68).
-- ------------------------------------------------------------

create or replace function public.set_restaurant_logo(
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

  -- Durcissement V69 : l'URL non NULL doit pointer vers le fichier
  -- attendu de CE restaurant, sous establishment-assets/{restaurant_id}/logo/,
  -- nom de fichier UUID + extension autorisée. Ancré ^...$ (pas une
  -- simple recherche de sous-chaîne) — voir note SÉCURITÉ 7.
  if v_url is not null and v_url !~ (
    '^https?://[^/]+/storage/v1/object/public/establishment-assets/'
    || p_restaurant_id::text
    || '/logo/[0-9a-fA-F-]{36}\.(jpg|png|webp)$'
  ) then
    raise exception using errcode = '22023',
      message = 'Logo URL does not match the expected establishment-assets storage path for this restaurant';
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

create or replace function public.set_restaurant_cover(
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

  if v_url is not null and v_url !~ (
    '^https?://[^/]+/storage/v1/object/public/establishment-assets/'
    || p_restaurant_id::text
    || '/cover/[0-9a-fA-F-]{36}\.(jpg|png|webp)$'
  ) then
    raise exception using errcode = '22023',
      message = 'Cover URL does not match the expected establishment-assets storage path for this restaurant';
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

-- ------------------------------------------------------------
-- 2d. Durcissement Storage (section 8 du brief) : restriction du 2e
-- segment de chemin à {logo, cover} uniquement — {restaurant_id}/anything/...
-- n'est plus autorisé. DROP + CREATE des 4 policies EXISTANTES (mêmes
-- noms qu'en V68, storage.objects ne permet pas ALTER POLICY sur
-- l'expression USING/WITH CHECK) : tous les autres contrôles (format
-- UUID du restaurant_id, owner/manager, opérateur Scanym, aucun accès
-- anon/staff) restent EXACTEMENT ceux de V68, recopiés à l'identique
-- ici, jamais assouplis.
-- ------------------------------------------------------------

drop policy "establishment_assets_select_authorized" on storage.objects;
drop policy "establishment_assets_insert_authorized" on storage.objects;
drop policy "establishment_assets_update_authorized" on storage.objects;
drop policy "establishment_assets_delete_authorized" on storage.objects;

create policy "establishment_assets_select_authorized"
on storage.objects for select
to authenticated
using (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
  and (storage.foldername(name))[2] in ('logo', 'cover')
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
  and (storage.foldername(name))[2] in ('logo', 'cover')
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
  and (storage.foldername(name))[2] in ('logo', 'cover')
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
  and (storage.foldername(name))[2] in ('logo', 'cover')
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
  and (storage.foldername(name))[2] in ('logo', 'cover')
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

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT AVANT VALIDATION (non exécutés ici,
-- voir preuve automatisée réelle dans
-- supabase/tests/v68-storage-policy-check.sh, étendu pour V69) :
--  ✓ couleur #RRGGBB valide acceptée par update_restaurant_colors
--  ✗ couleur mal formée ("red", "#fff", "#GGGGGG") refusée
--  ✓ couleur NULL/vide acceptée (efface la personnalisation)
--  ✓ lien Google Maps http(s) valide accepté
--  ✗ lien "javascript:...", "ftp://...", chaîne non-URL refusés
--  ✗ owner d'un AUTRE restaurant refusé sur les 2 nouvelles RPC
--  ✗ staff refusé sur les 2 nouvelles RPC
--  ✓ set_restaurant_logo avec l'URL exacte issue de l'upload (le bon
--    restaurant_id, /logo/, nom UUID.ext) acceptée
--  ✗ set_restaurant_logo avec une URL externe arbitraire refusée
--  ✗ set_restaurant_logo avec l'URL /cover/ d'un autre asset refusée
--  ✗ set_restaurant_logo avec le restaurant_id d'un AUTRE établissement
--    dans le chemin refusée (même appelant légitime pour son propre
--    restaurant_id)
--  ✗ upload storage.objects sous {restaurant_id}/autre/... refusé
--    (2e segment restreint à logo/cover)
--  ✓ upload storage.objects sous {restaurant_id}/logo/... et
--    {restaurant_id}/cover/... toujours acceptés (owner/manager/opérateur)
--  ✓ migration rejouée deux fois -> SCANYM_SCHEMA_DRIFT, aucune double
--    application
-- ============================================================
