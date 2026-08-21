-- ============================================================
-- Scanym V71 — Rollback du correctif ciblé (V70-01/04/05/07)
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- NOTE (V76, 6e tour) : ce fichier restaure volontairement le
-- mécanisme GUC (current_setting('app.storage_public_base_url', true))
-- ci-dessous, PAS la nouvelle table scanym_internal.storage_config --
-- c'est intentionnel et correct : ce rollback ramène l'état de V70,
-- qui EST RÉELLEMENT en production avec ce mécanisme GUC (sous sa
-- forme fail-open d'origine). Revenir à V70 signifie revenir à ce
-- que V70 contient réellement, pas à une version réécrite après coup.
--
-- Ce rollback ramène EXACTEMENT l'état de
-- migration-v70-identity-corrections.sql (rien avant, rien après) :
--   - assert_establishment_asset_url : repli "host https arbitraire"
--     de V70 restauré (CREATE OR REPLACE avec le corps exact de V70,
--     recopié ici) ;
--   - update_restaurant_maps_url : validation "^https://" simple de
--     V70 restaurée ;
--   - contrainte CHECK maps_url : reposée sous sa forme V70 ;
--   - les 4 policies storage.objects establishment_assets_* :
--     recréées avec la regex UUID permissive de V69/V70
--     ([0-9a-fA-F-]{36}), pas la version stricte v4 de V71.
--
-- Ne touche ni V68 ni V69 ni V70 par ailleurs : aucune table, aucune
-- donnée, aucun bucket Storage n'est modifié — seules les
-- fonctions/policies que migration-v71-hardening.sql avait
-- elles-mêmes modifiées sont ramenées à leur état antérieur exact.
-- ============================================================

begin;

-- Contrainte maps_url : forme V70 (préfixe seul).
alter table public.restaurant_configs drop constraint if exists restaurant_configs_maps_url_format;
alter table public.restaurant_configs add constraint restaurant_configs_maps_url_format
  check (maps_url is null or (length(maps_url) <= 500 and maps_url ~ '^https://'));

comment on column public.restaurant_configs.maps_url is
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70). HTTPS strictement obligatoire. NULL = pas de CTA "Itinéraire" sur la carte publique (le lien calculé depuis latitude/longitude, s''il existe, continue de s''afficher).';

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

create or replace function public.assert_establishment_asset_url(
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
    v_escaped_base := regexp_replace(v_base_url, '([.^$|()\[\]{}*+?\\])', '\\\1', 'g');
    v_full_pattern := '^' || v_escaped_base || v_path_pattern;
  else
    v_full_pattern := '^https://[^/]+' || v_path_pattern;
  end if;

  if p_url !~ v_full_pattern then
    raise exception using errcode = '22023',
      message = format('%s URL does not match the expected establishment-assets storage path for this restaurant', p_kind);
  end if;
end $$;

revoke all on function public.assert_establishment_asset_url(uuid, text, text) from public;

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

-- Après ce rollback : le finding V70-01 (fail-open host) et V70-07
-- (regex UUID permissive) réapparaissent -- c'est attendu, ce
-- rollback annule précisément leur correction. V70-05 (coexistence de
-- colonnes) reste indétectable par la migration normale une fois ce
-- rollback appliqué (le contrôle vivait dans migration-v71-hardening.sql
-- uniquement) ; V70-04 (structure maps_url) revient à la validation
-- "préfixe seul" de V70.
