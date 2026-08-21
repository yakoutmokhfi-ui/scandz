-- ============================================================
-- Scanym V72 — Corrections ciblées après contre-audit indépendant
-- Work sur V71 (findings V71-03, V71-07 — voir aussi les corrections
-- purement TypeScript/harnais pour V71-01/02/04/05/06, hors SQL)
--
-- À exécuter APRÈS migration-v71-hardening.sql.
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement, après audit indépendant ChatGPT Work.
--
-- Ce fichier NE RÉÉCRIT PAS migration-v68/v69/v70/v71 : il les
-- COMPLÈTE et les CORRIGE ponctuellement, même méthode que
-- migration-lotd-rls-reference-tables-fix.sql et V69/V70/V71 eux-mêmes
-- vis-à-vis de leurs prédécesseurs — convention du projet, pas
-- seulement une contrainte de production : aucune des migrations
-- V68/V69/V70/V71 n'a encore été exécutée sur Supabase à ce stade
-- (verdict Work sur V71 : SQL STOP), mais la même discipline de
-- traçabilité s'applique.
--
-- Findings SQL corrigés :
--
--   V71-03 : `new URL()` côté TypeScript s'est révélé TROP PERMISSIF
--   (accepte "https:///path" en normalisant le host en "path" --
--   vérifié empiriquement). La correction n'est PAS d'aligner le SQL
--   sur ce comportement trop permissif, mais de DURCIR les deux côtés
--   vers un sous-ensemble HTTPS strict et volontairement plus étroit
--   que la grammaire WHATWG complète -- jamais une tentative de
--   réimplémenter cette grammaire en SQL. La preuve de parité n'est
--   JAMAIS "ces deux regex se ressemblent" : la MÊME matrice de cas
--   (tests/maps-url-shared-matrix.tsv, source unique) est rejouée
--   des deux côtés -- voir tests/v72-hardening.test.ts (TypeScript)
--   et supabase/tests/v68-storage-policy-check.sh (SQL, section
--   dédiée V71-03/V72).
--
--   V71-07 : les policies UUID v4 strictes (corrige V70-07, déjà en
--   place depuis migration-v71-hardening.sql) n'avaient jamais été
--   précédées d'un contrôle sur les données HISTORIQUES déjà
--   présentes. Ce fichier ajoute ce contrôle en tête, AVANT toute
--   autre modification : si un restaurants.id existant ou un chemin
--   d'objet establishment-assets existant ne respecte pas le format
--   UUID v4 attendu, la migration s'arrête EXPLICITEMENT, sans rien
--   corriger ni ignorer silencieusement. Aucune donnée n'est
--   modifiée, aucun objet renommé -- ce lot ne fait que DÉTECTER.
-- ============================================================

do $$
declare
  v_bad_restaurants integer;
  v_bad_objects     integer;
  v_uuid_v4         constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
begin
  -- 1a. Le lot V71 doit déjà être en place (dépendance directe).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_restaurant_maps_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.update_restaurant_maps_url introuvable — migration V72 annulée. Prérequis : migration-v71-hardening.sql doit déjà être appliquée.';
  end if;
  -- Note : ce fichier ne redéfinit qu'une contrainte et une fonction
  -- déjà EXISTANTES (DROP+ADD / CREATE OR REPLACE), toutes deux
  -- naturellement idempotentes -- contrairement aux migrations
  -- précédentes qui introduisaient des objets NOMMÉS nouveaux, il n'y
  -- a ici aucun risque de collision à détecter par un simple test
  -- d'existence (la contrainte redéfinie porte volontairement le même
  -- nom qu'en V71). Rejouer ce fichier plusieurs fois reste sûr.

  -- 1b. V71-07 — CONTRÔLE PRÉALABLE DES DONNÉES HISTORIQUES, avant
  -- toute autre action de cette migration. Ne corrige, ne renomme, ni
  -- n'ignore rien : détecte et arrête explicitement si une anomalie
  -- existe. Exécuté avec les privilèges de la migration (bypass RLS
  -- par construction, comme toute exécution de migration), donc
  -- visible même si des policies restrictives masqueraient certaines
  -- lignes à un rôle applicatif ordinaire.
  select count(*) into v_bad_restaurants
  from public.restaurants
  where id::text !~ v_uuid_v4;

  if v_bad_restaurants > 0 then
    raise exception 'SCANYM_SCHEMA_DRIFT: % restaurant(s) existant(s) ont un restaurants.id non conforme au format UUID v4 attendu (corrige V71-07) — migration V72 annulée AVANT toute modification. Exemple de restaurants.id concerné : %. Aucune donnée n''est corrigée ni ignorée silencieusement : examiner manuellement ces lignes avant de relancer (ce lot ne renomme ni ne migre aucun identifiant).',
      v_bad_restaurants,
      (select string_agg(id::text, ', ') from (select id from public.restaurants where id::text !~ v_uuid_v4 limit 5) s);
  end if;

  select count(*) into v_bad_objects
  from storage.objects
  where bucket_id = 'establishment-assets'
    and not (
      (storage.foldername(name))[1] ~ v_uuid_v4
      and (storage.foldername(name))[2] in ('logo', 'cover')
      and name ~ ('/' || substring(v_uuid_v4 from 2 for length(v_uuid_v4) - 2) || '\.(jpg|png|webp)$')
    );

  if v_bad_objects > 0 then
    raise exception 'SCANYM_SCHEMA_DRIFT: % objet(s) existant(s) du bucket establishment-assets ne respectent pas le format de chemin attendu {uuid-v4}/{logo|cover}/{uuid-v4}.ext (corrige V71-07) — migration V72 annulée AVANT toute modification. Exemple de chemin concerné : %. Aucun renommage ni suppression automatique : examiner manuellement ces objets avant de relancer.',
      v_bad_objects,
      (select string_agg(name, ', ') from (select name from storage.objects where bucket_id = 'establishment-assets' and not ((storage.foldername(name))[1] ~ v_uuid_v4 and (storage.foldername(name))[2] in ('logo', 'cover') and name ~ ('/' || substring(v_uuid_v4 from 2 for length(v_uuid_v4) - 2) || '\.(jpg|png|webp)$')) limit 5) s);
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. V71-03 — Sous-ensemble HTTPS strict et commun (TypeScript ET
-- SQL), défini une seule fois conceptuellement, répliqué caractère
-- pour caractère ici depuis MAPS_URL_STRICT_RE (lib/maps-url.ts) :
--   - schéma "https://" minuscule strictement obligatoire ;
--   - host non vide, débutant par un caractère alphanumérique --
--     jamais par "/", "?", "#", ":" ni la fin de chaîne (exclut
--     explicitement "https:///path", "https://", "https://?x",
--     "https://#x", "https://:443") ;
--   - libellés de host séparés par des points, motif de nom d'hôte
--     standard ;
--   - port optionnel (":" suivi de chiffres uniquement) ;
--   - chemin optionnel après "/", sans espace ni retour ligne ;
--   - aucun espace ni retour ligne nulle part (exclu par construction
--     via les classes de caractères, pas par un test séparé).
-- DROP + ADD (Postgres ne permet pas ALTER CHECK en place).
-- ------------------------------------------------------------

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
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70). Sous-ensemble HTTPS strict et commun TypeScript/SQL (corrige V71-03, migration V72) : host non vide obligatoire, "https:///path" désormais refusé comme le reste de la matrice partagée (tests/maps-url-shared-matrix.tsv). NULL = pas de CTA "Itinéraire" sur la carte publique (aucun lien de repli fabriqué depuis latitude/longitude — corrige V70-06).';

-- ------------------------------------------------------------
-- 2b. Même durcissement dans update_restaurant_maps_url. CREATE OR
-- REPLACE, MÊME SIGNATURE : aucune rupture.
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
  v_url text;
begin
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  v_url := nullif(btrim(coalesce(p_maps_url, ''), E' \t\n\r\f' || chr(11)), '');

  if v_url is not null then
    if length(v_url) > 500 then
      raise exception using errcode = '22023', message = 'Maps URL too long';
    end if;
    -- Message dédié pour http:// (distinct du message de structure
    -- générale, pour rester aussi clair qu'avant ce durcissement).
    if v_url !~ '^https://' then
      raise exception using errcode = '22023', message = 'Invalid maps URL: must start with https:// (http:// is not accepted)';
    end if;
    -- Corrige V71-03 : sous-ensemble HTTPS strict et commun,
    -- caractère pour caractère identique à MAPS_URL_STRICT_RE
    -- (lib/maps-url.ts) et à la contrainte CHECK ci-dessus.
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

commit;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT AVANT VALIDATION (non exécutés ici,
-- voir preuve automatisée réelle dans
-- supabase/tests/v68-storage-policy-check.sh, étendu pour V72) :
--  ✗ maps_url "https:///path" (host normalisé en "path" côté
--    `new URL()`, mais explicitement refusé par le contrat V72)
--  ✗ maps_url "https://", "https://?x", "https://#x", "https://:443"
--  ✓ maps_url "https://example.com", "https://example.com/path",
--    "https://maps.app.goo.gl/abc" (matrice partagée complète, voir
--    tests/maps-url-shared-matrix.tsv)
--  ✓ NULL toujours accepté
--  ✓ migration lancée avec tous les restaurants.id / chemins
--    establishment-assets conformes -> continue normalement
--  ✗ migration lancée avec un restaurants.id non-v4 simulé -> STOP
--    explicite, aucune modification appliquée
--  ✗ migration lancée avec un chemin establishment-assets non
--    conforme simulé -> STOP explicite, aucune modification appliquée
--  ✓ migration rejouée après un premier succès -> SCANYM_SCHEMA_DRIFT
--    (contrainte déjà sous sa forme V72), aucune double application
-- ============================================================
