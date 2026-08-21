-- ============================================================
-- Scanym V70 — Rollback (corrections F-01/F-02/F-04, hardening)
--
-- À exécuter manuellement par le CIO si besoin de revenir en arrière
-- après une V70 déjà appliquée. NE PAS EXÉCUTER AUTOMATIQUEMENT.
--
-- Comportement NON destructif par défaut : les couleurs et le lien de
-- localisation déjà enregistrés restent en base (maps_url n'est PAS
-- renommée en sens inverse par défaut -- section destructive
-- optionnelle en bas de fichier si un retour strict à google_maps_url
-- est explicitement voulu). Revient set_restaurant_logo/_cover,
-- update_restaurant_colors et update_restaurant_maps_url EXACTEMENT à
-- leur état V69 ; supprime assert_establishment_asset_url et les 2
-- policies opérateur introduites par V70.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_establishment_asset_url introuvable — rollback V70 annulé (V70 ne semble pas appliquée).';
  end if;
end $$;

begin;

drop policy if exists "lecture operateur restaurants" on public.restaurants;
drop policy if exists "lecture operateur configs" on public.restaurant_configs;

-- Retour de update_restaurant_colors à la forme V69 (owner/manager
-- uniquement, pas d'opérateur).
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

-- Retour de update_restaurant_maps_url à la forme V69 (owner/manager
-- uniquement, http(s) accepté, colonne maps_url conservée -- le
-- renommage n'est pas défait ici, voir section destructive optionnelle).
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
      raise exception using errcode = '22023', message = 'Maps URL too long';
    end if;
    if v_url !~ '^https?://' then
      raise exception using errcode = '22023', message = 'Invalid maps URL: must start with http:// or https://';
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

-- Retour de set_restaurant_logo/_cover à la forme V69 (validation de
-- chemin inline, sans vérification de host).
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

drop function if exists public.assert_establishment_asset_url(uuid, text, text);

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url'
  ) then
    raise exception using errcode = 'P0001', message = 'SCANYM_ROLLBACK_INCOMPLETE';
  end if;
end $$;

commit;

-- ============================================================
-- Suppression DESTRUCTIVE optionnelle : retour strict à
-- google_maps_url (perd le bénéfice du renommage F-02) — jamais
-- exécutée automatiquement :
--
--   alter table public.restaurant_configs rename column maps_url to google_maps_url;
--   alter table public.restaurant_configs drop constraint if exists restaurant_configs_maps_url_format;
--   alter table public.restaurant_configs add constraint restaurant_configs_google_maps_url_format
--     check (google_maps_url is null or (length(google_maps_url) <= 500 and google_maps_url ~ '^https?://'));
--
-- Retour arrière du CODE (frontend) : ce fichier ne couvre que la
-- base de données / Storage. Utiliser `git revert` du commit V70 ou
-- l'application inverse du patch fourni — jamais une restauration
-- manuelle fichier par fichier.
-- ============================================================
