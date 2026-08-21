-- ============================================================
-- Scanym V76 — Rollback (suppression de scanym_internal)
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- ⚠️ ORDRE DE ROLLBACK STRICT -- CONTRAIREMENT AUX AUTRES ROLLBACKS DE
-- CE PROJET, CELUI-CI NE PEUT PAS S'EXÉCUTER INDÉPENDAMMENT SI V71 A
-- ÉTÉ APPLIQUÉE : la fonction public.assert_establishment_asset_url
-- (redéfinie par migration-v71-hardening.sql tel qu'édité par V76)
-- appelle scanym_internal.get_storage_public_origin(). Supprimer ce
-- schéma alors que V71 est encore en place casserait immédiatement
-- tout envoi de logo/cover (la fonction échouerait à chaque appel,
-- schéma introuvable).
--
-- Séquence de rollback correcte, dans cet ordre :
--   1. Si V73/V72/V71 ont été appliquées : les annuler d'abord, dans
--      l'ordre inverse (migration-v73-rollback.sql, puis V72, puis
--      migration-v71-rollback.sql -- ce dernier restaure la forme
--      GUC de V70, qui ne dépend plus de scanym_internal).
--   2. Seulement ENSUITE exécuter ce fichier.
--
-- Ce fichier vérifie cette précondition avant toute suppression et
-- s'arrête explicitement si assert_establishment_asset_url dépend
-- encore de scanym_internal.
-- ============================================================

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url'
      and pg_get_functiondef(p.oid) like '%scanym_internal.get_storage_public_origin%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_establishment_asset_url dépend encore de scanym_internal.get_storage_public_origin() -- ce rollback est annulé pour éviter de casser tout envoi de logo/cover. Annuler d''abord migration-v71-hardening.sql (via migration-v71-rollback.sql) avant de relancer ce fichier.';
  end if;
end $$;

begin;

-- Corrige V76-03 (contre-audit Work) : plus de DROP SCHEMA ... CASCADE
-- non borné -- vérifie D'ABORD que scanym_internal contient EXACTEMENT
-- les objets attendus (table storage_config, fonction
-- get_storage_public_origin, fonction is_valid_storage_origin) et
-- RIEN D'AUTRE. Toute dérive (objet inattendu présent) arrête la
-- migration explicitement plutôt que de tout supprimer aveuglément.
do $$
declare
  v_unexpected_tables    text;
  v_unexpected_functions text;
begin
  select string_agg(c.relname, ', ')
  into v_unexpected_tables
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'scanym_internal'
    and c.relkind in ('r', 'p')
    and c.relname != 'storage_config';

  if v_unexpected_tables is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: objet(s) TABLE inattendu(s) dans scanym_internal : %. Rollback V76 annulé -- ce schéma ne doit contenir que storage_config. Examiner manuellement avant de relancer, aucune suppression automatique de ce qui n''est pas explicitement reconnu.', v_unexpected_tables;
  end if;

  select string_agg(p.proname, ', ')
  into v_unexpected_functions
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'scanym_internal'
    and p.proname not in ('get_storage_public_origin', 'is_valid_storage_origin');

  if v_unexpected_functions is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: fonction(s) inattendue(s) dans scanym_internal : %. Rollback V76 annulé -- ce schéma ne doit contenir que get_storage_public_origin et is_valid_storage_origin. Examiner manuellement avant de relancer.', v_unexpected_functions;
  end if;
end $$;

-- Suppression EXPLICITE des seuls objets connus et attendus, jamais
-- une suppression en cascade aveugle. drop table sans cascade échoue
-- s'il existe une dépendance non prévue (ex. une contrainte externe
-- ajoutée par erreur) -- préféré à un cascade qui la supprimerait
-- silencieusement.
drop table scanym_internal.storage_config;
drop function scanym_internal.get_storage_public_origin();
drop function scanym_internal.is_valid_storage_origin(text);

-- Le schéma n'est supprimé que s'il est désormais VIDE -- si les DROP
-- ci-dessus ont réussi (aucune dépendance imprévue), il l'est
-- nécessairement ; ce DROP SCHEMA sans CASCADE échouerait explicitement
-- si un objet imprévu subsistait malgré tout, plutôt que de le
-- supprimer silencieusement.
drop schema scanym_internal;

commit;

-- Après ce rollback : le mécanisme app.storage_public_base_url (GUC)
-- redevient la seule source possible pour assert_establishment_asset_url
-- -- rappel : ce GUC ne peut pas être configuré sur Supabase hébergé
-- (voir migration-v76-storage-origin-config.sql). N'exécuter ce
-- rollback que si V71 (édité) a déjà été annulée au préalable.
