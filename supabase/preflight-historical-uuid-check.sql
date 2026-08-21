-- ============================================================
-- Scanym — Contrôle préalable des données historiques UUID
-- (avant durcissement strict Storage)
--
-- ⚠️ CORRIGE V72-04 (contre-audit Work, 3e tour) — LIRE ATTENTIVEMENT
-- CETTE SECTION AVANT D'EXÉCUTER QUOI QUE CE SOIT.
--
-- PROBLÈME IDENTIFIÉ : migration-v71-hardening.sql installe déjà des
-- policies storage.objects strictes (UUID v4 obligatoire) SANS
-- qu'aucun contrôle des données historiques n'ait encore eu lieu à ce
-- stade de la chaîne. Le contrôle qui existait jusqu'ici vivait dans
-- migration-v72-hardening.sql -- c'est-à-dire APRÈS que V71 ait déjà
-- rendu inaccessibles (via ses propres policies) tout objet Storage
-- historique non conforme. Le contrôle détectait le problème, mais
-- UNE FOIS le dommage fonctionnel déjà fait par V71.
--
-- CE FICHIER EST LE VRAI GARDE-FOU. Il ne modifie RIEN : il vérifie
-- seulement, EN LECTURE SEULE, que les données existantes sont déjà
-- compatibles avec le format strict que V71 s'apprête à imposer.
--
-- ORDRE D'EXÉCUTION CORRECT (remplace tout ordre antérieur, corrigé
-- V77-01 contre-audit Work 8e tour -- ce fichier omettait
-- migration-v76-storage-origin-config.sql et la configuration CIO,
-- introduits après la rédaction initiale de ce préflight) :
--
--   ... migration-v70-identity-corrections.sql
--   → migration-v76-storage-origin-config.sql
--   → CONFIGURATION CIO DE L'ORIGINE (voir section 4 de ce dernier
--     fichier) -- avant CE FICHIER, jamais après
--   → CE FICHIER (preflight-historical-uuid-check.sql)
--   → migration-v71-hardening.sql
--   → migration-v72-hardening.sql
--   → migration-v73-hardening.sql
--
-- Si ce fichier échoue : NE PAS exécuter migration-v71-hardening.sql.
-- Examiner et corriger manuellement les données signalées (jamais de
-- correction automatique depuis ce fichier ni depuis aucune
-- migration de ce lot), puis relancer ce contrôle avant de
-- poursuivre.
--
-- Ce fichier est un pur contrôle EN LECTURE SEULE (aucun BEGIN/COMMIT
-- nécessaire, aucune écriture) : il peut être exécuté autant de fois
-- que nécessaire, à tout moment, sans aucun risque ni effet de bord.
-- Une redondance équivalente reste volontairement présente dans
-- migration-v72-hardening.sql comme filet de sécurité tardif, au cas
-- où ce contrôle précoce serait par erreur sauté par le CIO -- il ne
-- remplace jamais ce fichier-ci, qui reste le VRAI point de contrôle
-- destiné à s'exécuter avant toute restriction.
-- ============================================================

do $$
declare
  v_bad_restaurants integer;
  v_bad_objects     integer;
  v_uuid_v4         constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
  v_bucket_exists    boolean;
begin
  -- Ce contrôle suppose que restaurants existe déjà (Lot D et
  -- antérieurs). Si establishment-assets n'existe pas encore
  -- (migration-v68 pas encore appliquée), il n'y a par définition
  -- aucun objet Storage à vérifier -- ce n'est pas une anomalie.
  select exists (
    select 1 from storage.buckets where id = 'establishment-assets'
  ) into v_bucket_exists;

  select count(*) into v_bad_restaurants
  from public.restaurants
  where id::text !~ v_uuid_v4;

  if v_bad_restaurants > 0 then
    raise exception 'SCANYM_HISTORICAL_DATA_DRIFT: % restaurant(s) existant(s) ont un restaurants.id non conforme au format UUID v4 attendu -- NE PAS exécuter migration-v71-hardening.sql tant que ce point n''est pas résolu (ses policies strictes rendraient ces établissements inaccessibles via Storage). Exemple : %. Aucune correction automatique : examiner manuellement ces lignes.',
      v_bad_restaurants,
      (select string_agg(id::text, ', ') from (select id from public.restaurants where id::text !~ v_uuid_v4 limit 5) s);
  end if;

  if v_bucket_exists then
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
      raise exception 'SCANYM_HISTORICAL_DATA_DRIFT: % objet(s) existant(s) du bucket establishment-assets ne respectent pas le format {uuid-v4}/{logo|cover}/{uuid-v4}.ext -- NE PAS exécuter migration-v71-hardening.sql tant que ce point n''est pas résolu (ses policies strictes rendraient ces objets inaccessibles). Exemple : %. Aucun renommage automatique : examiner manuellement ces objets.',
        v_bad_objects,
        (select string_agg(name, ', ') from (
          select name from storage.objects
          where bucket_id = 'establishment-assets'
            and not (
              (storage.foldername(name))[1] ~ v_uuid_v4
              and (storage.foldername(name))[2] in ('logo', 'cover')
              and name ~ ('^' || substring(v_uuid_v4 from 2 for length(v_uuid_v4) - 2) || '/(logo|cover)/'
                           || substring(v_uuid_v4 from 2 for length(v_uuid_v4) - 2) || '\.(jpg|png|webp)$')
            )
          limit 5
        ) s);
    end if;
  end if;

  raise notice 'SCANYM_HISTORICAL_DATA_CHECK: OK -- % restaurants, % objets establishment-assets, tous conformes au format UUID v4 attendu. migration-v71-hardening.sql peut être exécutée en toute sécurité.',
    (select count(*) from public.restaurants),
    (case when v_bucket_exists then (select count(*) from storage.objects where bucket_id = 'establishment-assets') else 0 end);
end $$;
