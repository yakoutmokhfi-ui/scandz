-- ============================================================
-- Scanym V73 — Rollback du correctif ciblé (V72-05/V72-06/V72-07)
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- IMPORTANT — SYMÉTRIE MIGRATION/ROLLBACK, PAS UN ÉTAT SÛR DURABLE :
-- ce rollback ramène EXACTEMENT l'état de migration-v72-hardening.sql
-- (rien avant, rien après). Ni V71, ni V72, ni V73 n'ont été validés
-- par un contre-audit Work favorable au moment de l'écriture de ce
-- fichier -- revenir à V72 ne constitue donc PAS un état de
-- production sûr, seulement le retour mécanique au palier précédent
-- de CE lot précis. Après ce rollback, les findings V72-05
-- (segments Storage non bornés), V72-06 (espace/retour ligne
-- périphérique silencieusement accepté) et V72-07 (port hors plage
-- accepté) réapparaissent tous les trois -- c'est attendu, ce
-- rollback annule précisément leur correction.
-- ============================================================

begin;

alter table public.restaurant_configs drop constraint if exists restaurant_configs_maps_url_format;
alter table public.restaurant_configs add constraint restaurant_configs_maps_url_format
  check (
    maps_url is null
    or (
      length(maps_url) <= 500
      and maps_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(:[0-9]+)?(/\S*)?$'
    )
  );

comment on column public.restaurant_configs.maps_url is
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70). Sous-ensemble HTTPS strict et commun TypeScript/SQL (V72) : host non vide obligatoire. NULL = pas de CTA "Itinéraire" sur la carte publique.';

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
    if v_url !~ '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(:[0-9]+)?(/\S*)?$' then
      raise exception using errcode = '22023', message = 'Invalid maps URL: host is missing or malformed';
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

drop policy "establishment_assets_select_authorized" on storage.objects;
drop policy "establishment_assets_insert_authorized" on storage.objects;
drop policy "establishment_assets_update_authorized" on storage.objects;
drop policy "establishment_assets_delete_authorized" on storage.objects;

create policy "establishment_assets_select_authorized"
on storage.objects for select
to authenticated
using (
  bucket_id = 'establishment-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
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
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
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
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
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
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
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
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
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
