-- ============================================================
-- Scanym V72 — Rollback du correctif ciblé (V71-03/V71-07)
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- IMPORTANT — SYMÉTRIE MIGRATION/ROLLBACK, PAS UN ÉTAT SÛR DURABLE :
-- ce rollback ramène EXACTEMENT l'état de migration-v71-hardening.sql
-- (rien avant, rien après). Work a confirmé que V71 restaurait
-- volontairement V70, lui-même NON VALIDÉ par le contre-audit --
-- la même remarque s'applique ici à l'identique : revenir à V71 ne
-- constitue PAS un état de production sûr, seulement le retour au
-- palier précédent de CE lot précis. V71 lui-même n'a jamais été
-- validé par Work avant l'audit qui a produit V72 -- ce rollback ne
-- doit donc JAMAIS être interprété comme "revenir à un état
-- sécurisé connu", seulement comme l'annulation MÉCANIQUE des deux
-- changements de V72 (grammaire maps_url plus stricte, contrôle
-- préalable des données historiques). Le contrôle préalable
-- lui-même n'existant qu'en V72, ce rollback ne le restaure PAS
-- (V71 n'en avait pas) -- après ce rollback, les policies UUID v4
-- strictes de V71 restent en place SANS le filet de sécurité
-- préalable de V72.
-- ============================================================

begin;

alter table public.restaurant_configs drop constraint if exists restaurant_configs_maps_url_format;
alter table public.restaurant_configs add constraint restaurant_configs_maps_url_format
  check (
    maps_url is null
    or (
      length(maps_url) <= 500
      and maps_url ~ '^https://[^/\s]+(/[^\s]*)?$'
    )
  );

comment on column public.restaurant_configs.maps_url is
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70). HTTPS strictement obligatoire, host non vide requis (V71). NULL = pas de CTA "Itinéraire" sur la carte publique (aucun lien de repli fabriqué depuis latitude/longitude — corrige V70-06).';

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
    if v_url !~ '^https://[^/\s]+(/[^\s]*)?$' then
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

commit;

-- Après ce rollback : le finding V71-03 (grammaire trop souple,
-- "https:///path" de nouveau accepté côté SQL) et V71-07 (aucun
-- contrôle préalable des données historiques avant un futur
-- durcissement) réapparaissent -- c'est attendu, ce rollback annule
-- précisément leur correction. Rappel : ni V71 ni V72 n'ont été
-- exécutés sur Supabase à ce stade (gouvernance SQL STOP) -- ce
-- rollback est documenté par symétrie et par discipline de
-- traçabilité, pas parce qu'un état intermédiaire aurait déjà été
-- déployé.
