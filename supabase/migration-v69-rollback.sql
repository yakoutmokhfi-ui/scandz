-- ============================================================
-- Scanym V69 — Rollback (couleurs, lien Maps, durcissement logo/cover)
--
-- À exécuter manuellement par le CIO si besoin de revenir en arrière
-- après une V69 déjà appliquée. NE PAS EXÉCUTER AUTOMATIQUEMENT.
--
-- Comportement NON destructif par défaut : les couleurs et le lien
-- Google Maps déjà enregistrés restent en base (colonnes non
-- supprimées, cf. section destructive optionnelle en bas de fichier).
-- Revient set_restaurant_logo/_cover et les 4 policies
-- establishment_assets_* EXACTEMENT à leur état V68 (pas de
-- validation de chemin, pas de restriction du 2e segment) ; supprime
-- les 2 RPC introduites par V69.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'primary_color'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.primary_color introuvable — rollback V69 annulé (V69 ne semble pas appliquée).';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_restaurant_asset_role'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_restaurant_asset_role introuvable — rollback V69 annulé (prérequis V68 absent).';
  end if;
end $$;

begin;

drop function if exists public.update_restaurant_colors(uuid, text, text, text);
drop function if exists public.update_restaurant_maps_url(uuid, text);

-- Retour de set_restaurant_logo/_cover à la forme V68 exacte (sans
-- validation de chemin), même signature, aucune rupture.
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

  update public.restaurant_configs
  set cover_url = v_url
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.set_restaurant_cover(uuid, text) from public, anon;
grant execute on function public.set_restaurant_cover(uuid, text) to authenticated;

-- Policies : retour à la forme V68 exacte (sans restriction du 2e segment).
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

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('update_restaurant_colors', 'update_restaurant_maps_url')
  ) then
    raise exception using errcode = 'P0001', message = 'SCANYM_ROLLBACK_INCOMPLETE';
  end if;
end $$;

commit;

-- ============================================================
-- Suppression DESTRUCTIVE optionnelle des colonnes V69 (perd toute
-- couleur/lien Maps déjà enregistré) — jamais exécutée automatiquement :
--
--   alter table public.restaurant_configs
--     drop column if exists primary_color,
--     drop column if exists secondary_color,
--     drop column if exists accent_color,
--     drop column if exists google_maps_url;
--
-- Retour arrière du CODE (frontend) : ce fichier ne couvre que la
-- base de données / Storage. Utiliser `git revert` du commit V69 ou
-- l'application inverse du patch fourni — jamais une restauration
-- manuelle fichier par fichier.
-- ============================================================
