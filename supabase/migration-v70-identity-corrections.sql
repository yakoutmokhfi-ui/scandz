-- ============================================================
-- Scanym V70 — Corrections ciblées identité visuelle, localisation
-- et hardening (findings F-01 à F-05 + fichiers Storage orphelins)
--
-- À exécuter APRÈS migration-v69-identity-colors-maps-hardening.sql.
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement, après audit indépendant ChatGPT Work.
--
-- Ce fichier NE RÉÉCRIT PAS migration-v68/v69 : il les COMPLÈTE et les
-- CORRIGE ponctuellement, même méthode que
-- migration-lotd-rls-reference-tables-fix.sql (déjà dans ce dépôt).
--
-- Findings traités :
--   F-01 Super Admin complet : update_restaurant_colors /
--        update_restaurant_maps_url réutilisent désormais
--        assert_restaurant_asset_role (owner/manager OU opérateur
--        Scanym), exactement comme set_restaurant_logo/_cover depuis
--        V68 — plus de logique dupliquée, plus d'incohérence entre
--        logo/cover et couleurs/localisation. + 2 policies SELECT
--        pour que l'opérateur puisse aussi LIRE (pas seulement
--        écrire) un établissement hors de ses propres rattachements
--        restaurant_users.
--   F-02 Localisation provider-neutral : colonne renommée
--        google_maps_url -> maps_url (migration sûre, RENAME COLUMN,
--        aucune perte de donnée si elle existait déjà), HTTPS
--        strictement obligatoire (http:// désormais refusé).
--   F-03 Contraste : déjà couvert en V69 (lib/color-contrast.ts,
--        --sc-accent-text) ; rien à corriger côté SQL.
--   F-04 Hardening logo/cover : assert_establishment_asset_url,
--        nouvelle fonction interne partagée, valide désormais AUSSI
--        le host/origin de l'URL via un réglage PostgreSQL par
--        environnement (app.storage_public_base_url), pas seulement
--        le chemin -- voir note ci-dessous.
--   F-05 Confirmation de suppression : déjà côté frontend uniquement
--        (window.confirm, app/dashboard/settings/page.tsx) ; rien à
--        corriger côté SQL.
--   Fichiers Storage orphelins : correction côté TypeScript
--        uniquement (lib/services/establishment-assets.ts) ; rien à
--        corriger côté SQL.
--
-- NOTE SÉCURITÉ F-04 — HOST/ORIGIN, SANS DOMAINE UNIQUE EN DUR :
-- set_restaurant_logo/_cover exigeaient déjà (V69) que l'URL
-- corresponde exactement au CHEMIN Storage attendu, mais acceptaient
-- N'IMPORTE QUEL host https (limite documentée dans V69 : le host réel
-- du projet Supabase n'est pas connu d'une migration portable). Ce
-- fichier ajoute une vérification du host RÉELLE mais CONFIGURABLE PAR
-- ENVIRONNEMENT, sans jamais hardcoder un domaine de production unique
-- dans le SQL : un réglage PostgreSQL par base (GUC applicatif),
--
--   alter database postgres set app.storage_public_base_url = 'https://<votre-projet>.supabase.co';
--
-- à exécuter UNE FOIS par le CIO, séparément, sur CHAQUE environnement
-- (local/staging/prod ont chacun leur propre host) — commande donnée
-- ici à titre indicatif, PAS exécutée par cette migration. Tant que ce
-- réglage n'est pas positionné pour un environnement donné (typiquement
-- en développement local), le comportement retombe sur la validation
-- V69 (chemin exact, host https arbitraire) — repli documenté, pas
-- silencieux : voir assert_establishment_asset_url ci-dessous.
-- ============================================================

do $$
begin
  -- 1a. Le lot V69 doit déjà être en place (dépendance directe).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_restaurant_colors'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.update_restaurant_colors introuvable — migration V70 annulée. Prérequis : migration-v69-identity-colors-maps-hardening.sql doit déjà être appliquée.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_restaurant_asset_role'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_restaurant_asset_role introuvable — migration V70 annulée.';
  end if;

  -- 1b. restaurant_configs doit avoir soit google_maps_url (V69),
  -- soit déjà maps_url (rejeu partiel) -- l'un des deux, pas ni l'un
  -- ni l'autre (schéma inattendu).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs'
      and column_name in ('google_maps_url', 'maps_url')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: ni google_maps_url ni maps_url trouvée sur restaurant_configs — migration V70 annulée.';
  end if;

  -- 1c. Nouvelle fonction interne ne doit pas déjà exister.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_establishment_asset_url existe déjà — migration V70 annulée.';
  end if;

  -- 1d. Policies opérateur ne doivent pas déjà exister.
  if exists (
    select 1 from pg_policies
    where policyname in ('lecture operateur restaurants', 'lecture operateur configs')
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: une policy "lecture operateur ..." existe déjà — migration V70 annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. F-02 — Renommage sûr google_maps_url -> maps_url (aucune perte
-- de donnée : RENAME COLUMN préserve le contenu). Idempotent :
-- fonctionne que V69 ait déjà tourné (rename réel) ou pas encore
-- (colonne créée directement sous son nom définitif).
-- ------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'google_maps_url'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'maps_url'
  ) then
    alter table public.restaurant_configs rename column google_maps_url to maps_url;
  elsif not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'maps_url'
  ) then
    alter table public.restaurant_configs add column maps_url text;
  end if;
end $$;

-- Contrainte CHECK re-posée sous son nom définitif, HTTPS strictement
-- obligatoire (corrige F-02 : http:// n'est plus accepté). DROP IF
-- EXISTS des deux noms possibles (avant/après renommage) puis
-- recréation : idempotent, fonctionne quel que soit l'état de départ.
alter table public.restaurant_configs drop constraint if exists restaurant_configs_google_maps_url_format;
alter table public.restaurant_configs drop constraint if exists restaurant_configs_maps_url_format;
alter table public.restaurant_configs add constraint restaurant_configs_maps_url_format
  check (maps_url is null or (length(maps_url) <= 500 and maps_url ~ '^https://'));

comment on column public.restaurant_configs.maps_url is
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70 pour rester indépendant de tout fournisseur de cartographie). HTTPS strictement obligatoire. NULL = pas de CTA "Itinéraire" sur la carte publique (le lien calculé depuis latitude/longitude, s''il existe, continue de s''afficher).';

-- ------------------------------------------------------------
-- 2b. F-04 — assert_establishment_asset_url : fonction interne
-- partagée par set_restaurant_logo/_cover (remplace la validation
-- dupliquée de V69). Valide le CHEMIN (restaurant_id + type d'asset +
-- nom de fichier UUID + extension, exactement comme V69) ET,
-- lorsqu'un environnement l'a configuré, le HOST via
-- current_setting('app.storage_public_base_url', true) -- voir note
-- SÉCURITÉ F-04 en tête de fichier. p_url = null toujours accepté
-- (retrait de l'asset).
-- ------------------------------------------------------------

create function public.assert_establishment_asset_url(
  p_restaurant_id uuid,
  p_kind          text,
  p_url           text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base_url     text := nullif(btrim(coalesce(current_setting('app.storage_public_base_url', true), '')), '');
  v_escaped_base text;
  v_path_pattern text;
  v_full_pattern text;
begin
  if p_url is null then
    return;
  end if;

  if p_kind not in ('logo', 'cover') then
    raise exception using errcode = '22023', message = 'Invalid establishment asset kind';
  end if;

  v_path_pattern := '/storage/v1/object/public/establishment-assets/'
    || p_restaurant_id::text || '/' || p_kind || '/[0-9a-fA-F-]{36}\.(jpg|png|webp)$';

  if v_base_url is not null then
    -- Environnement configuré (CIO) : host EXACT vérifié, pas
    -- seulement le chemin. Échappe les caractères spéciaux regex
    -- éventuellement présents dans le host (essentiellement '.').
    v_escaped_base := regexp_replace(v_base_url, '([.^$|()\[\]{}*+?\\])', '\\\1', 'g');
    v_full_pattern := '^' || v_escaped_base || v_path_pattern;
  else
    -- Repli DOCUMENTÉ (pas silencieux) pour un environnement où
    -- app.storage_public_base_url n'a pas encore été positionné :
    -- host https arbitraire accepté, chemin toujours exact. Voir
    -- note SÉCURITÉ F-04 en tête de fichier.
    v_full_pattern := '^https://[^/]+' || v_path_pattern;
  end if;

  if p_url !~ v_full_pattern then
    raise exception using errcode = '22023',
      message = format('%s URL does not match the expected establishment-assets storage path for this restaurant', p_kind);
  end if;
end $$;

revoke all on function public.assert_establishment_asset_url(uuid, text, text) from public;

-- ------------------------------------------------------------
-- 2c. set_restaurant_logo / set_restaurant_cover — CREATE OR REPLACE,
-- MÊME SIGNATURE (uuid, text) que V68/V69 : aucune rupture. Corps mis
-- à jour pour appeler assert_establishment_asset_url au lieu de
-- dupliquer la regex de validation de chemin.
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

  perform public.assert_establishment_asset_url(p_restaurant_id, 'logo', v_url);

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

  perform public.assert_establishment_asset_url(p_restaurant_id, 'cover', v_url);

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
-- 2d. F-01 — update_restaurant_colors / update_restaurant_maps_url :
-- CREATE OR REPLACE, MÊME SIGNATURE. Remplace le contrôle
-- owner/manager dupliqué par assert_restaurant_asset_role (owner/
-- manager OU opérateur Scanym) : même règle, même fonction, que
-- set_restaurant_logo/_cover — plus de logique dupliquée, le Super
-- Admin peut désormais aussi modifier couleurs et localisation.
-- update_restaurant_maps_url : colonne renommée maps_url, HTTPS
-- strictement obligatoire (corrige F-02, http:// refusé).
-- ------------------------------------------------------------

create or replace function public.update_restaurant_colors(
  p_restaurant_id   uuid,
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
  perform public.assert_restaurant_asset_role(p_restaurant_id);

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

create or replace function public.update_restaurant_maps_url(
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
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_url := nullif(btrim(coalesce(p_maps_url, ''), E' \t\n\r\f' || chr(11)), '');

  if v_url is not null then
    if length(v_url) > 500 then
      raise exception using errcode = '22023', message = 'Maps URL too long';
    end if;
    if v_url !~ '^https://' then
      raise exception using errcode = '22023', message = 'Invalid maps URL: must start with https:// (http:// is not accepted)';
    end if;
  end if;

  update public.restaurant_configs
  set maps_url = v_url
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_maps_url(uuid, text) from public, anon;
grant execute on function public.update_restaurant_maps_url(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 2e. F-01 — Lecture opérateur : deux policies SELECT supplémentaires
-- (restaurants, restaurant_configs), même patron EXACT que "lecture
-- membre restaurants"/"lecture membre configs"
-- (migration-lotd-establishment-creation.sql), pour que l'opérateur
-- Scanym puisse aussi LIRE un établissement hors de ses propres
-- rattachements restaurant_users (pas seulement écrire via les RPC
-- déjà ouvertes à assert_restaurant_asset_role) -- indispensable pour
-- que Dashboard Settings affiche les valeurs actuelles avant
-- modification, y compris pour un établissement encore 'onboarding'
-- (non couvert par la policy "lecture publique ... actifs").
-- ------------------------------------------------------------

create policy "lecture operateur restaurants"
  on public.restaurants for select
  to authenticated
  using (public.is_scanym_operator());

create policy "lecture operateur configs"
  on public.restaurant_configs for select
  to authenticated
  using (public.is_scanym_operator());

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT AVANT VALIDATION (non exécutés ici,
-- voir preuve automatisée réelle dans
-- supabase/tests/v68-storage-policy-check.sh, étendu pour V70) :
--  ✓ opérateur Scanym appelle update_restaurant_colors pour un
--    établissement où il n'a AUCUN rôle restaurant_users -> succès
--  ✓ opérateur Scanym appelle update_restaurant_maps_url de même -> succès
--  ✗ owner d'un AUTRE établissement toujours refusé sur ces 2 RPC
--  ✗ staff toujours refusé sur ces 2 RPC
--  ✓ opérateur Scanym peut SELECT restaurant_configs/restaurants d'un
--    établissement 'onboarding' (pas encore actif), hors restaurant_users
--  ✗ manager B ne peut toujours pas SELECT restaurant_configs de A
--  ✓ lien maps_url https:// accepté
--  ✗ lien maps_url http:// désormais REFUSÉ (F-02)
--  ✓ colonne google_maps_url absente après migration, maps_url présente
--  ✓ set_restaurant_logo avec l'URL exacte (bon restaurant_id, /logo/,
--    UUID.ext) toujours acceptée après le refactor 2c
--  ✗ set_restaurant_logo avec un host différent de
--    app.storage_public_base_url (quand ce réglage est positionné)
--    refusé
--  ✓ migration rejouée après un premier succès -> SCANYM_SCHEMA_DRIFT,
--    aucune double application
-- ============================================================
