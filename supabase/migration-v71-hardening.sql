-- ============================================================
-- Scanym V71 — Corrections ciblées après audit indépendant V70
-- (findings V70-01, V70-04, V70-05, V70-07 — voir aussi les
-- corrections purement TypeScript pour V70-02/03/06/08, hors SQL)
--
-- ⚠️ ÉDITÉ PAR V76 (contre-audit Work, 6e tour) — RUPTURE EXPLICITE ET
-- JUSTIFIÉE avec la convention "ne jamais réécrire une migration déjà
-- livrée" énoncée juste en dessous. Autorisé précisément parce que ce
-- fichier n'a JAMAIS été exécuté en production (confirmé : Production
-- est à V70, V71/V72/V73 non appliquées) ET que son mécanisme de
-- configuration d'origine (GUC personnalisé app.storage_public_base_url)
-- s'est révélé structurellement incompatible avec Supabase hébergé
-- (ALTER DATABASE ... SET refusé, 42501 permission denied -- comportement
-- documenté, pas spécifique à ce projet). Laisser ce fichier tel
-- quel produirait une migration qui s'applique sans erreur SQL, mais
-- qui bloquerait ENSUITE DÉFINITIVEMENT tout envoi de logo/cover en
-- production, sans aucun moyen de configurer le réglage requis --
-- un état pire que ne jamais appliquer V71 du tout. Seule la section
-- 2c (assert_establishment_asset_url) est modifiée : la lecture du
-- GUC est remplacée par un appel à
-- scanym_internal.get_storage_public_origin() (table de configuration,
-- voir migration-v76-storage-origin-config.sql). Toute la logique de
-- validation UUID v4/chemin/kind reste identique.
--
-- ⚠️ SÉQUENCE OPÉRATIONNELLE UNIQUE (corrige V77-01, contre-audit
-- Work, 8e tour -- cette mention REMPLACE toute mention antérieure
-- de séquence dans ce fichier, qui omettait l'étape de configuration
-- CIO) :
--
--   V70 (déjà en production)
--   → migration-v76-storage-origin-config.sql
--   → CONFIGURATION CIO DE L'ORIGINE (voir section 4 de ce dernier
--     fichier) -- DOIT avoir lieu ICI, avant le préflight, jamais
--     après
--   → preflight-historical-uuid-check.sql
--   → CE FICHIER (migration-v71-hardening.sql, édité)
--   → migration-v72-hardening.sql
--   → migration-v73-hardening.sql
--
-- Cette même séquence à 6 étapes doit être identique dans TOUS les
-- fichiers opérationnels de ce projet (migration-v76-storage-origin-config.sql,
-- preflight-historical-uuid-check.sql, migration-v73-hardening.sql,
-- ce fichier) -- jamais deux versions divergentes.
--
-- À exécuter APRÈS migration-v70-identity-corrections.sql ET APRÈS
-- migration-v76-storage-origin-config.sql, ET APRÈS que le CIO ait
-- configuré l'origine (voir séquence ci-dessus).
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement, après audit indépendant ChatGPT Work.
--
-- Ce fichier NE RÉÉCRIT PAS migration-v68/v69/v70 : il les COMPLÈTE
-- et les CORRIGE ponctuellement, même méthode que
-- migration-lotd-rls-reference-tables-fix.sql (déjà dans ce dépôt) et
-- que V69/V70 eux-mêmes vis-à-vis de leurs prédécesseurs — convention
-- du projet, pas seulement une contrainte de production : aucune des
-- migrations V68/V69/V70 n'a encore été exécutée sur Supabase à ce
-- stade (verdict Work sur V70 : SQL STOP), mais la même discipline de
-- traçabilité s'applique.
--
-- Findings SQL corrigés :
--   V70-01 assert_establishment_asset_url échoue désormais FERMÉ
--          (rejette explicitement) quand app.storage_public_base_url
--          n'est pas configuré, au lieu d'accepter n'importe quel
--          host https.
--   V70-04 update_restaurant_maps_url + contrainte CHECK sur maps_url
--          valident désormais une structure d'URL réelle (host non
--          vide, pas seulement le préfixe "https://").
--   V70-05 Contrôle préalable : si google_maps_url ET maps_url
--          existent SIMULTANÉMENT, la migration s'arrête explicitement
--          au lieu de deviner laquelle est la bonne donnée.
--   V70-07 Les 4 policies storage.objects ET
--          assert_establishment_asset_url exigent désormais un UUID
--          v4 réel (positions de tirets ET nibble de version/variant),
--          plus seulement 36 caractères hexadécimaux/tirets. Vérifié
--          empiriquement avant d'écrire ce fichier : gen_random_uuid()
--          (restaurant_id) ET crypto.randomUUID() côté client (nom de
--          fichier) produisent tous deux des UUID v4 réels — la
--          validation stricte ne rejette donc aucune donnée légitime.
--
-- (V70-02, V70-03, V70-06, V70-08 sont des corrections purement
-- applicatives — TypeScript/JSX/README — aucun changement SQL requis
-- pour ces quatre findings, voir le rapport de livraison V71.)
-- ============================================================

do $$
declare
  v_count       integer;
  v_oid         oid;
  v_rettype     text;
  v_volatile    "char";
  v_secdef      boolean;
  v_owner       text;
  v_funcdef     text;
begin
  -- 1a. Le lot V70 doit déjà être en place -- corrige V77-03
  -- (contre-audit Work, 8e tour) : contrôles STRUCTURELS via pg_proc
  -- (signature, type de retour, volatilité, SECURITY DEFINER,
  -- search_path, propriétaire, absence de surcharge) ET un marqueur
  -- ciblé dans pg_get_functiondef -- jamais un hash fragile du corps
  -- SQL formaté (sensible aux espaces/formatage). Chaque contrôle
  -- vérifié empiriquement (scénarios de dérive simulés un par un)
  -- avant d'écrire ce bloc, voir rapport de livraison V78.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url';

  if v_count = 0 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_establishment_asset_url introuvable — migration V71 annulée. Prérequis : migration-v70-identity-corrections.sql doit déjà être appliquée.';
  end if;
  if v_count > 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: % fonction(s) public.assert_establishment_asset_url détectée(s), une seule attendue (surcharge inattendue) — migration V71 annulée. Examiner manuellement avant de relancer.', v_count;
  end if;

  select p.oid into v_oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url';

  if pg_get_function_identity_arguments(v_oid) != 'p_restaurant_id uuid, p_kind text, p_url text' then
    raise exception 'SCANYM_SCHEMA_DRIFT: la signature de public.assert_establishment_asset_url ne correspond pas à celle attendue (p_restaurant_id uuid, p_kind text, p_url text) — dérive détectée, migration V71 annulée. Examiner manuellement avant de relancer.';
  end if;

  select prorettype::regtype::text, provolatile, prosecdef, pg_get_userbyid(proowner)
  into v_rettype, v_volatile, v_secdef, v_owner
  from pg_proc where oid = v_oid;

  if v_rettype != 'void' then
    raise exception 'SCANYM_SCHEMA_DRIFT: type de retour de assert_establishment_asset_url attendu "void", obtenu "%" — dérive détectée, migration V71 annulée.', v_rettype;
  end if;
  if v_volatile != 's' then
    raise exception 'SCANYM_SCHEMA_DRIFT: volatilité de assert_establishment_asset_url attendue STABLE, obtenue "%" — dérive détectée, migration V71 annulée.', v_volatile;
  end if;
  if not v_secdef then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_establishment_asset_url attendue SECURITY DEFINER, absente — dérive détectée, migration V71 annulée.';
  end if;
  if v_owner != 'postgres' then
    raise exception 'SCANYM_SCHEMA_DRIFT: propriétaire de assert_establishment_asset_url attendu "postgres" (convention standard de ce projet), obtenu "%" — dérive détectée, migration V71 annulée.', v_owner;
  end if;
  if not exists (
    select 1 from pg_proc where oid = v_oid and 'search_path=""' = any(proconfig)
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_establishment_asset_url attendue avec search_path = '''' , absent ou différent — dérive détectée, migration V71 annulée.';
  end if;

  v_funcdef := pg_get_functiondef(v_oid);
  if v_funcdef !~ 'current_setting\(''app\.storage_public_base_url''' then
    raise exception 'SCANYM_SCHEMA_DRIFT: le corps de assert_establishment_asset_url ne contient pas le marqueur caractéristique de V70 (lecture de app.storage_public_base_url) — dérive détectée (fonction potentiellement déjà modifiée de façon inattendue), migration V71 annulée. Examiner manuellement avant de relancer.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_restaurant_maps_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.update_restaurant_maps_url introuvable — migration V71 annulée.';
  end if;
  -- Ajouté par V76 : la table de configuration Storage doit exister
  -- AVANT que la fonction ci-dessous (section 2c) ne soit (re)définie
  -- pour la lire -- voir migration-v76-storage-origin-config.sql,
  -- qui doit s'exécuter entre migration-v70-identity-corrections.sql
  -- et ce fichier.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'scanym_internal' and p.proname = 'get_storage_public_origin'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: scanym_internal.get_storage_public_origin introuvable — migration V71 annulée. Prérequis : migration-v76-storage-origin-config.sql doit être exécutée avant ce fichier (remplace le mécanisme GUC incompatible avec Supabase hébergé).';
  end if;

  -- 1b. Corrige V70-05 : si google_maps_url ET maps_url existent
  -- SIMULTANÉMENT (état incohérent — un rejeu partiel antérieur, ou
  -- une intervention manuelle), arrêt explicite. Ne jamais deviner
  -- quelle colonne contient la donnée à jour, ne jamais écraser
  -- silencieusement. Ce contrôle est NOUVEAU : le contrôle préalable
  -- de V70 (section 1b de migration-v70-identity-corrections.sql)
  -- vérifiait seulement qu'AU MOINS UNE des deux existe, jamais que
  -- les deux ne coexistent pas.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'google_maps_url'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'maps_url'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs porte SIMULTANÉMENT google_maps_url ET maps_url — état incohérent (corrige V70-05). Migration V71 annulée : examiner manuellement laquelle des deux colonnes contient la donnée à jour avant de relancer (jamais de fusion/écrasement automatique).';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. V70-04 — Renforcement de la contrainte CHECK sur maps_url :
-- exige désormais un host non vide après "https://", pas seulement le
-- préfixe. DROP + ADD (Postgres ne permet pas ALTER CHECK en place).
-- Toute donnée existante conforme à l'ancienne règle moins stricte
-- reste conforme à celle-ci (un host non vide est un sur-ensemble
-- strict) : aucune ligne existante ne peut être rejetée par ce
-- durcissement, seules les nouvelles écritures via
-- update_restaurant_maps_url en bénéficient réellement (la RPC est
-- l'unique chemin d'écriture, voir REVOKE/GRANT V68/V69/V70 déjà en
-- place).
-- ------------------------------------------------------------

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
  'Lien externe de localisation/itinéraire fourni par le commerçant (V69, renommé F-02/V70). HTTPS strictement obligatoire, host non vide requis (corrige V70-04, migration V71). NULL = pas de CTA "Itinéraire" sur la carte publique (aucun lien de repli fabriqué depuis latitude/longitude — corrige V70-06, décision CTO : les coordonnées restent des données neutres, jamais transformées en lien Google implicite).';

-- ------------------------------------------------------------
-- 2b. V70-04 — Même durcissement dans update_restaurant_maps_url
-- (défense en profondeur : la contrainte CHECK ci-dessus protège la
-- table même en cas d'appel hors RPC, mais le message d'erreur de la
-- RPC reste le chemin normal, plus précis que le message générique de
-- violation de contrainte). CREATE OR REPLACE, MÊME SIGNATURE : aucune
-- rupture pour lib/services/dashboard.ts.
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
    -- Corrige V70-04 : structure réelle exigée (host non vide),
    -- plus seulement le préfixe "https://". Rejette explicitement
    -- http:// (message dédié, distinct du message de structure
    -- générale, pour rester aussi clair qu'avant ce durcissement).
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

-- ------------------------------------------------------------
-- 2c. V70-01 — assert_establishment_asset_url : ÉCHEC FERMÉ quand
-- aucune origine Storage n'est configurée, au lieu du repli "host
-- https arbitraire accepté" documenté (mais dangereux) de V70.
-- CREATE OR REPLACE, MÊME SIGNATURE (uuid, text, text).
--
-- ⚠️ ÉDITÉ PAR V76 (jamais appliqué en production à ce stade -- voir
-- migration-v76-storage-origin-config.sql pour la justification
-- complète) : la lecture de app.storage_public_base_url (GUC
-- personnalisé, confirmé IMPOSSIBLE à configurer sur Supabase hébergé
-- -- ALTER DATABASE ... SET refusé avec 42501 permission denied) est
-- remplacée par un appel à scanym_internal.get_storage_public_origin()
-- (table de configuration ordinaire, lecture/écriture par privilège
-- normal, compatible Supabase hébergé). Toute la logique de
-- validation UUID v4/chemin/kind reste STRICTEMENT IDENTIQUE à avant
-- cette édition -- seule la source de la valeur change.
--
-- Combine aussi V70-07 : le nom de fichier doit désormais être un UUID
-- v4 réel (positions de tirets + nibble version '4' + nibble variant
-- parmi 8/9/a/b), plus seulement 36 caractères hex/tirets — vérifié
-- empiriquement : crypto.randomUUID() (client, nom de fichier) produit
-- bien des UUID v4 réels.
-- ------------------------------------------------------------

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
  v_base_url     text := scanym_internal.get_storage_public_origin();
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

  -- Corrige V70-01 : plus de repli "host arbitraire" -- si aucune
  -- origine Storage n'est configurée dans
  -- scanym_internal.storage_config, l'enregistrement échoue
  -- EXPLICITEMENT plutôt que d'accepter silencieusement n'importe quel
  -- host https. Le CIO configure CETTE valeur, UNE FOIS par
  -- environnement (local/staging/prod ont chacun leur propre origine,
  -- jamais codée en dur ici), via une insertion SQL ordinaire -- voir
  -- migration-v76-storage-origin-config.sql, section 4, pour la
  -- commande exacte (ne nécessite aucun privilège élevé, contrairement
  -- à l'ancien mécanisme GUC). Tant que cette table est vide, AUCUN
  -- logo ni cover ne peut être enregistré via set_restaurant_logo/_cover
  -- (le retrait, p_url = null, reste toujours possible : voir le
  -- retour anticipé ci-dessus, avant ce contrôle).
  if v_base_url is null then
    raise exception using errcode = '22023',
      message = 'Storage origin is not configured for this environment (scanym_internal.storage_config) -- establishment asset URLs cannot be validated safely, so they are rejected. Ask the CIO to configure this value for this environment before uploading a logo or cover.';
  end if;

  -- Le réglage doit lui-même respecter le contrat d'origine strict --
  -- corrige V76-04 (contre-audit Work) : réutilise le MÊME helper
  -- partagé que la contrainte CHECK de scanym_internal.storage_config
  -- (scanym_internal.is_valid_storage_origin), jamais une regex
  -- dupliquée ou plus permissive maintenue séparément ici. Un réglage
  -- mal formé est traité comme un environnement NON configuré --
  -- échec fermé. Défense en profondeur : la contrainte CHECK garantit
  -- déjà ce format à l'écriture, mais cette revérification à la
  -- lecture ne coûte rien et protège contre toute anomalie future de
  -- cette contrainte (ex. contournement par un futur correctif qui
  -- l'assouplirait par erreur).
  if not scanym_internal.is_valid_storage_origin(v_base_url) then
    raise exception using errcode = '22023',
      message = 'Storage origin configuration is malformed (must be a strict https origin with no path, e.g. https://<project-ref>.supabase.co) -- establishment asset URLs are rejected until this is corrected.';
  end if;

  -- V70-07 : UUID v4 réel (tirets aux bonnes positions, nibble
  -- version '4', nibble variant 8/9/a/b), plus seulement 36
  -- caractères hex/tirets en vrac.
  v_path_pattern := '/storage/v1/object/public/establishment-assets/'
    || p_restaurant_id::text || '/' || p_kind
    || '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(jpg|png|webp)$';

  -- Host EXACT vérifié (v_base_url garanti non-null à ce stade).
  -- Échappe les caractères spéciaux regex éventuellement présents
  -- dans le host (essentiellement '.').
  v_escaped_base := regexp_replace(v_base_url, '([.^$|()\[\]{}*+?\\])', '\\\1', 'g');
  v_full_pattern := '^' || v_escaped_base || v_path_pattern;

  if p_url !~ v_full_pattern then
    raise exception using errcode = '22023',
      message = format('%s URL does not match the expected establishment-assets storage path for this restaurant', p_kind);
  end if;
end $$;

revoke all on function public.assert_establishment_asset_url(uuid, text, text) from public;

-- ------------------------------------------------------------
-- 2d. V70-07 — Les 4 policies storage.objects establishment_assets_* :
-- restaurant_id (1er segment de chemin) doit désormais être un UUID v4
-- réel, plus seulement 36 caractères hex/tirets. DROP + CREATE (mêmes
-- noms qu'en V68/V69, storage.objects ne permet pas ALTER POLICY sur
-- l'expression). Tous les autres contrôles (2e segment restreint à
-- logo/cover, owner/manager, opérateur Scanym, aucun accès anon/staff)
-- restent EXACTEMENT ceux de V69, recopiés à l'identique ici, jamais
-- assouplis.
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

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT AVANT VALIDATION (non exécutés ici,
-- voir preuve automatisée réelle dans
-- supabase/tests/v68-storage-policy-check.sh, étendu pour V71) :
--  ✗ set_restaurant_logo/_cover avec app.storage_public_base_url NON
--    configuré et une URL non-null -> échec explicite (corrige V70-01,
--    plus jamais d'acceptation d'un host arbitraire)
--  ✓ set_restaurant_logo/_cover avec app.storage_public_base_url
--    configuré + URL exacte de ce host -> succès
--  ✗ même host correct mais un AUTRE host dans l'URL -> refusé
--  ✗ maps_url "https:///chemin" (host vide) -> refusé (corrige V70-04)
--  ✗ maps_url "https://" seul -> refusé
--  ✓ maps_url "https://maps.app.goo.gl/xyz" -> toujours accepté
--  ✗ migration lancée avec google_maps_url ET maps_url présentes
--    simultanément -> SCANYM_SCHEMA_DRIFT explicite (corrige V70-05),
--    aucune modification appliquée
--  ✗ chemin storage avec un nom de fichier UUID malformé
--    (mauvais placement de tirets, "------------------------------------",
--    trop court, trop long) -> refusé (corrige V70-07)
--  ✓ chemin storage avec un vrai UUID v4 généré par
--    crypto.randomUUID() -> toujours accepté
--  ✓ migration rejouée après un premier succès -> SCANYM_SCHEMA_DRIFT,
--    aucune double application
-- ============================================================
