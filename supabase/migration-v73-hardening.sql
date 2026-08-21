-- ============================================================
-- Scanym V73 — Corrections ciblées après contre-audit indépendant
-- Work sur V72 (findings V72-05, V72-06, V72-07 — voir aussi
-- preflight-historical-uuid-check.sql pour V72-04, et le rapport de
-- livraison pour les corrections purement applicatives V72-01/02/03/08)
--
-- ⚠️ SÉQUENCE OPÉRATIONNELLE UNIQUE (corrige V77-01, contre-audit
-- Work, 8e tour -- REMPLACE la mention "V72-04" ci-dessous, devenue
-- incomplète depuis l'introduction de migration-v76-storage-origin-config.sql
-- : elle omettait ce fichier et l'étape de configuration CIO) :
--
--   V70 (déjà en production)
--   → migration-v76-storage-origin-config.sql
--   → CONFIGURATION CIO DE L'ORIGINE (voir section 4 de ce fichier)
--   → preflight-historical-uuid-check.sql
--   → migration-v71-hardening.sql (édité, lit scanym_internal)
--   → migration-v72-hardening.sql
--   → CE FICHIER (migration-v73-hardening.sql)
--
-- [Historique -- V72-04, ne plus utiliser comme instruction
-- d'installation] : ce fichier supposait auparavant que
-- supabase/preflight-historical-uuid-check.sql s'exécutait juste
-- avant migration-v71-hardening.sql, sans mentionner
-- migration-v76-storage-origin-config.sql (introduit après ce
-- correctif V72-04) ni la configuration CIO de l'origine.
--
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement, après audit indépendant ChatGPT Work.
--
-- Ce fichier NE RÉÉCRIT PAS migration-v68/v69/v70/v71/v72 : il les
-- COMPLÈTE et les CORRIGE ponctuellement, même méthode que les
-- migrations précédentes vis-à-vis de leurs prédécesseurs.
--
-- Findings SQL corrigés :
--
--   V72-05 : les 4 policies storage.objects vérifiaient séparément
--   (storage.foldername(name))[1] (restaurant_id) et [2] (logo/cover),
--   sans jamais s'assurer qu'AUCUN segment supplémentaire n'existe.
--   Un chemin comme "{uuid}/logo/sous-dossier/{uuid}.jpg" (4 segments)
--   satisfaisait les deux contrôles existants. Corrigé en ajoutant une
--   regex sur le CHEMIN COMPLET (ancrée ^...$), qui exclut par
--   construction tout segment intermédiaire, tout slash double, toute
--   fin de chemin sans nom de fichier — vérifié empiriquement sur les
--   8 cas exigés (voir tests/v73-hardening.test.ts) avant intégration.
--
--   V72-06 : la chaîne maps_url était nettoyée (trim) PUIS validée,
--   acceptant silencieusement un espace/retour ligne en tête ou fin.
--   Corrigé : la chaîne BRUTE reçue par la RPC est désormais comparée
--   à sa version nettoyée -- toute différence (espace/retour ligne
--   périphérique sur une valeur NON VIDE) est refusée explicitement.
--
--   V72-07 : le port explicite après ":" n'était pas borné (":99999"
--   était accepté). Corrigé : plage stricte 1-65535, motif identique
--   caractère pour caractère à MAPS_URL_STRICT_RE (lib/maps-url.ts),
--   vérifié exhaustivement sur les bornes (0, 1, 65535, 65536, 99999)
--   avant intégration.
--
-- (V72-01 harnais, V72-02/03 contraste, V72-08 rapport sont des
-- corrections purement applicatives/documentaires — aucun changement
-- SQL requis pour ces quatre findings, voir le rapport de livraison.)
-- ============================================================

do $$
begin
  -- 1a. Le lot V72 doit déjà être en place (dépendance directe).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_restaurant_maps_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.update_restaurant_maps_url introuvable — migration V73 annulée. Prérequis : migration-v72-hardening.sql doit déjà être appliquée.';
  end if;

  -- 1b. V72-04 (redondance de défense en profondeur) : re-vérifie les
  -- données historiques MÊME À CE STADE tardif, au cas où le CIO
  -- aurait sauté par erreur le contrôle précoce
  -- (preflight-historical-uuid-check.sql, censé s'exécuter avant V71).
  -- Ce contrôle-ci ne PRÉVIENT plus le dommage fonctionnel de V71 s'il
  -- a déjà eu lieu (les policies strictes sont déjà en place depuis
  -- V71) -- il reste néanmoins une détection utile en dernier
  -- recours, jamais un substitut au contrôle précoce.
  declare
    v_bad_restaurants integer;
    v_bad_objects     integer;
    v_uuid_v4         constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
  begin
    select count(*) into v_bad_restaurants
    from public.restaurants
    where id::text !~ v_uuid_v4;

    if v_bad_restaurants > 0 then
      raise exception 'SCANYM_SCHEMA_DRIFT: % restaurant(s) existant(s) ont un restaurants.id non conforme au format UUID v4 -- migration V73 annulée. Ce point aurait dû être détecté par preflight-historical-uuid-check.sql AVANT migration-v71-hardening.sql (voir son en-tête) ; s''il ne l''a pas été, les policies Storage strictes de V71 rendent déjà ces établissements inaccessibles via Storage -- examiner manuellement avant de poursuivre, aucune correction automatique.',
        v_bad_restaurants;
    end if;

    select count(*) into v_bad_objects
    from storage.objects
    where bucket_id = 'establishment-assets'
      and not (
        (storage.foldername(name))[1] ~ v_uuid_v4
        and (storage.foldername(name))[2] in ('logo', 'cover')
        and name ~ ('^' || substring(v_uuid_v4 from 2 for length(v_uuid_v4) - 2) || '/(logo|cover)/'
                     || substring(v_uuid_v4 from 2 for length(v_uuid_v4) - 2) || '\.(jpg|png|webp)$')
      );

    if v_bad_objects > 0 then
      raise exception 'SCANYM_SCHEMA_DRIFT: % objet(s) existant(s) du bucket establishment-assets ne respectent pas le format attendu -- migration V73 annulée. Même remarque que ci-dessus : ce point aurait dû être détecté avant V71.',
        v_bad_objects;
    end if;
  end;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. V72-06/V72-07 — Contrainte CHECK sur maps_url : port borné
-- 1-65535 (corrige V72-07). La validation "chaîne brute, jamais
-- nettoyée avant contrôle" (V72-06) est appliquée dans
-- update_restaurant_maps_url ci-dessous (seul chemin d'écriture) ;
-- la contrainte CHECK reste une protection structurelle sur la valeur
-- FINALE déjà nettoyée par la RPC (jamais sur une valeur brute non
-- nettoyée, puisque la colonne ne stocke jamais l'espace périphérique
-- lui-même une fois la RPC passée).
-- ------------------------------------------------------------

alter table public.restaurant_configs drop constraint if exists restaurant_configs_maps_url_format;
alter table public.restaurant_configs add constraint restaurant_configs_maps_url_format
  check (
    maps_url is null
    or (
      length(maps_url) <= 500
      and maps_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/\S*)?$'
    )
  );

comment on column public.restaurant_configs.maps_url is
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70). Sous-ensemble HTTPS strict et commun TypeScript/SQL : host non vide, port explicite borné 1-65535 (corrige V72-07), chaîne brute validée telle que reçue par la RPC (corrige V72-06). NULL = pas de CTA "Itinéraire" (aucun lien de repli fabriqué depuis latitude/longitude — corrige V70-06).';

-- ------------------------------------------------------------
-- 2b. update_restaurant_maps_url : corrige V72-06 (chaîne brute
-- validée telle que reçue, jamais nettoyée puis validée) ET V72-07
-- (port borné). CREATE OR REPLACE, MÊME SIGNATURE.
-- ------------------------------------------------------------

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
  v_raw     text;
  v_trimmed text;
  v_url     text;
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_raw := coalesce(p_maps_url, '');
  v_trimmed := btrim(v_raw, E' \t\n\r\f' || chr(11));

  if v_trimmed = '' then
    -- Champ vidé (chaîne vide ou uniquement des espaces/retours
    -- ligne) : préoccupation DISTINCTE de la grammaire stricte,
    -- toujours acceptée, équivalente à NULL.
    v_url := null;
  else
    if v_trimmed != v_raw then
      -- Corrige V72-06 : un espace/retour ligne en tête ou fin d'une
      -- valeur NON VIDE est refusé EXPLICITEMENT, jamais nettoyé
      -- silencieusement puis validé comme si l'entrée avait été
      -- propre dès le départ.
      raise exception using errcode = '22023', message = 'Invalid maps URL: leading or trailing whitespace is not accepted';
    end if;

    if length(v_trimmed) > 500 then
      raise exception using errcode = '22023', message = 'Maps URL too long';
    end if;
    if v_trimmed !~ '^https://' then
      raise exception using errcode = '22023', message = 'Invalid maps URL: must start with https:// (http:// is not accepted)';
    end if;
    -- Corrige V72-07 : port explicite borné 1-65535, motif identique
    -- caractère pour caractère à MAPS_URL_STRICT_RE (lib/maps-url.ts).
    if v_trimmed !~ '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/\S*)?$' then
      raise exception using errcode = '22023', message = 'Invalid maps URL: host is missing/malformed, or port is out of range (1-65535)';
    end if;
    v_url := v_trimmed;
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
-- 2c. V72-05 — Les 4 policies storage.objects establishment_assets_* :
-- ajoute une regex sur le CHEMIN COMPLET (name ~ ...), en plus des
-- contrôles [1]/[2] déjà en place (conservés pour la lisibilité et la
-- cohérence avec la jointure restaurant_users ci-dessous). DROP +
-- CREATE (mêmes noms qu'en V68/V69/V71).
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
  and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  and (storage.foldername(name))[2] in ('logo', 'cover')
  -- Corrige V72-05 : chemin COMPLET ancré, exclut tout segment
  -- supplémentaire, slash double, ou fin de chemin sans nom de
  -- fichier -- vérifié empiriquement sur les 8 cas exigés.
  and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/(logo|cover)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(jpg|png|webp)$'
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
  and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/(logo|cover)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(jpg|png|webp)$'
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
  and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/(logo|cover)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(jpg|png|webp)$'
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
  and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/(logo|cover)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(jpg|png|webp)$'
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
  and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/(logo|cover)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(jpg|png|webp)$'
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
-- TESTS À REJOUER MANUELLEMENT (voir preuve automatisée réelle dans
-- supabase/tests/v68-storage-policy-check.sh, étendu pour V73) :
--  ✗ chemin avec segment intermédiaire (uuid/logo/a/file) -> refusé
--  ✗ chemin avec segment avant kind (uuid/x/logo/file) -> refusé
--  ✗ double slash (uuid//logo/file) -> refusé
--  ✗ chemin sans nom de fichier (uuid/logo/) -> refusé
--  ✗ chemin à 5 segments (uuid/logo/a/b/c) -> refusé
--  ✓ chemin exact (uuid/logo/uuid.jpg) -> accepté
--  ✗ maps_url " https://example.com" (espace en tête) -> refusé
--  ✗ maps_url "https://example.com:99999" (port hors plage) -> refusé
--  ✓ maps_url "https://example.com:8443/a" -> accepté
-- ============================================================
