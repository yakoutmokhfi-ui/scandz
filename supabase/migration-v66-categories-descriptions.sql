-- ============================================================
-- Scanym V66 — Catégories, produits, descriptions courte/longue
--
-- À exécuter APRÈS migration-v65-order-note.sql.
--
-- Contenu :
--   1. Contrôle préalable de non-dérive du schéma (RÉELLEMENT
--      EXÉCUTÉ, comme en V65) — signatures RPC, propriétaire,
--      SECURITY DEFINER, search_path, droits, policy, index existant
--   2. Transaction unique englobant TOUT le reste, y compris la
--      réaffirmation des droits sur menu_categories (corrigé après
--      audit indépendant — voir note ci-dessous)
--   3. Ajout additif de menu_items.short_description + contraintes
--      CHECK de longueur (défense en profondeur, pas seulement RPC)
--   4. Évolution des RPC produits : suppression des signatures
--      exactes à 4 paramètres, recréation à 5 paramètres
--   5. get_merchant_catalogue : suppression + recréation, restructurée
--      en LEFT JOIN pour exposer les catégories vides (nécessaire
--      pour que la création de catégorie soit utilisable : sans ça,
--      une catégorie tout juste créée resterait invisible tant
--      qu'aucun produit n'y est ajouté)
--   6. Nouvelles RPC de catégories : create_category, update_category
--      (jamais set_category_active — hors périmètre V66)
--   7. Protection anti-doublon : index unique partiel sur les
--      catégories actives, par restaurant, insensible à la casse,
--      bordures normalisées, sensible aux accents
--
-- CORRECTION après audit indépendant — atomicité complète :
-- une première version de ce fichier exécutait le REVOKE sur
-- menu_categories AVANT le contrôle de dérive et AVANT begin;. Un
-- audit a relevé, à raison, que si le reste du script échouait
-- ensuite, ce REVOKE restait appliqué malgré tout : la migration
-- n'était donc pas réellement atomique de bout en bout, même si le
-- REVOKE lui-même est un droit déjà retiré manuellement et sans
-- risque à rejouer. Corrigé : le contrôle de dérive (lecture seule,
-- sans effet de bord) reste avant begin; — s'il échoue, rien n'a
-- encore été touché — mais le REVOKE est désormais la première
-- instruction À L'INTÉRIEUR de la transaction principale : un échec
-- plus loin dans le script annule tout, y compris ce REVOKE.
--
-- CORRECTION SA3-B01 (audit Work, 11 août 2026) — droits TRUNCATE/
-- REFERENCES/TRIGGER non couverts par le contrôle de dérive : celui-ci
-- ne vérifiait l'absence effective (PUBLIC compris) que pour INSERT/
-- UPDATE/DELETE. Un `grant truncate on table public.menu_categories
-- to public;` passait donc silencieusement, alors qu'il reste effectif
-- pour anon ET authenticated après le REVOKE de la section 2a (qui ne
-- cible que ces deux rôles, jamais PUBLIC). Corrigé par deux ajouts
-- complémentaires : (1) le contrôle PUBLIC pré-transaction (1d) couvre
-- désormais aussi TRUNCATE/REFERENCES/TRIGGER ; (2) une vérification
-- post-REVOKE (section 2a-bis, à l'intérieur de la transaction) relève
-- via has_table_privilege() tout droit encore effectif après le
-- REVOKE, qu'il vienne de PUBLIC ou d'un rôle hérité — un échec y
-- annule tout le REVOKE via le ROLLBACK de la transaction.
--
-- IMPORTANT — pourquoi drop function ici, contrairement à V65 :
-- create_product et update_product changent de VÉRITABLE signature
-- (4 → 5 paramètres). PostgreSQL identifie une fonction par son nom
-- ET ses types de paramètres : `create or replace function` avec un
-- paramètre en plus ne remplace PAS la version à 4 paramètres, il
-- crée une signature distincte à 5 paramètres, laissant les deux
-- actives simultanément (source d'ambiguïté PostgREST et de RPC
-- fantôme). Un `drop function` ciblant la signature EXACTE, suivi
-- d'une recréation immédiate, dans la même transaction, est donc
-- nécessaire — jamais `cascade`, jamais improvisé : la signature
-- exacte à supprimer a été confirmée par une requête réelle sur la
-- base Supabase avant d'écrire ce fichier (voir le contrôle
-- préalable ci-dessous, qui revérifie cette même signature avant
-- de la supprimer).
--
-- Trim explicite partout où ce fichier normalise du texte :
-- btrim(..., E' \t\n\r\f' || chr(11)) — JAMAIS E'\v', qui produit la
-- lettre "v" en PostgreSQL et non la tabulation verticale U+000B
-- (piège rencontré et corrigé en V65, vérifié empiriquement :
-- ascii(E'\v') = 118). Voir lib/catalogue-text.ts pour le miroir
-- JavaScript de ce même jeu de caractères.
--
-- DÉCISION EXPLICITE sur la défense en profondeur (suite à un audit
-- indépendant qui a relevé que les limites 100/500 n'étaient
-- protégées que dans les RPC, pas au niveau de la table) : cette
-- version ajoute des contraintes CHECK sur short_description et
-- description, sur le modèle exact d'orders.customer_note_check
-- (V65). Ce n'est PAS redondant ici (contrairement au cas V65 où une
-- contrainte équivalente existait déjà) : aucune contrainte de
-- longueur n'existait jusqu'ici sur ces colonnes. Voir section 3b.
-- ============================================================


-- ------------------------------------------------------------------
-- 1. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA — RÉELLEMENT EXÉCUTÉ
--    (pas un commentaire à lire manuellement), sur le modèle de la
--    section 0bis de migration-v65-order-note.sql. S'arrête AVANT la
--    transaction principale si l'état réel diffère de ce qui a été
--    confirmé par vos requêtes de contrôle.
--
--    Renforcé après DEUX audits indépendants successifs :
--    - 1er audit : propriétaire, SECURITY DEFINER, search_path,
--      définition de la policy de lecture publique (condition).
--    - 2e audit (celui-ci) : le 1er audit avait révélé que
--      "droits EXECUTE effectifs" était ANNONCÉ dans un commentaire
--      sans être réellement implémenté (aucun appel à
--      has_function_privilege ni aclexplode). Corrigé : vérifie
--      désormais réellement, pour les 3 fonctions historiques,
--      que PUBLIC et anon N'ONT PAS EXECUTE et qu'authenticated
--      L'A (via has_function_privilege + aclexplode/acldefault pour
--      détecter PUBLIC, y compris quand proacl est NULL — vérifié
--      empiriquement sur PostgreSQL 16 avant d'écrire ce bloc, pas
--      supposé). Vérifie aussi que menu_categories a EXACTEMENT l'un
--      de deux états explicitement acceptés (voir 1d), que la policy
--      de lecture publique a bien cmd=SELECT, roles={public}, mode
--      PERMISSIVE (pas seulement sa condition), et refuse
--      catégoriquement toute préexistence de l'index anti-doublon
--      (qualifiée par schéma ET table) plutôt que d'essayer de
--      valider une définition existante par sous-chaînes, jugé trop
--      permissif par le 2e audit.
-- ------------------------------------------------------------------

do $$
declare
  v_count integer;
  v_fn record;
  v_policy record;
begin
  -- 1a. Signatures RPC exactes attendues (confirmées par votre requête 3)
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_description text, p_price numeric'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte create_product(uuid,text,text,numeric) introuvable — migration V66 annulée, aucune modification appliquée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_product'
      and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid, p_name text, p_description text, p_price numeric'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte update_product(uuid,text,text,numeric) introuvable — migration V66 annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte get_merchant_catalogue(uuid,boolean) introuvable — migration V66 annulée.';
  end if;

  -- 1b. Aucune surcharge inattendue de ces trois noms de fonction
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue');

  if v_count <> 3 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: % fonctions trouvées pour create_product/update_product/get_merchant_catalogue, 3 attendues (une surcharge existe peut-être déjà) — migration V66 annulée.',
      v_count;
  end if;

  -- 1c. Propriétaire, SECURITY DEFINER et search_path des 3 fonctions
  -- existantes, avant de les supprimer/recréer — confirmé par votre
  -- requête 3 (SECURITY DEFINER + propriétaire postgres).
  for v_fn in
    select pg_get_userbyid(p.proowner) as owner, p.proconfig as search_path, p.prosecdef as secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue')
  loop
    if v_fn.owner is distinct from 'postgres' then
      raise exception
        'SCANYM_SCHEMA_DRIFT: propriétaire inattendu (%) pour une des 3 fonctions catalogue, "postgres" attendu — migration V66 annulée.',
        v_fn.owner;
    end if;
    if v_fn.secdef is not true then
      raise exception
        'SCANYM_SCHEMA_DRIFT: une des 3 fonctions catalogue n''est pas SECURITY DEFINER — migration V66 annulée.';
    end if;
    if v_fn.search_path is null or not exists (
      select 1 from unnest(v_fn.search_path) as cfg where cfg = 'search_path=""'
    ) then
      raise exception
        'SCANYM_SCHEMA_DRIFT: une des 3 fonctions catalogue n''a pas search_path = '''' exactement (proconfig: %) — migration V66 annulée.',
        v_fn.search_path;
    end if;
  end loop;

  -- 1d. Droits EFFECTIFS sur menu_categories — corrigé après 3e audit
  -- indépendant : la version précédente n'agrégeait que les lignes
  -- de information_schema.role_table_grants où grantee = 'anon' ou
  -- 'authenticated', ce qui NE DÉTECTE JAMAIS un droit accordé à
  -- PUBLIC (effectif pour tous les rôles, y compris anon et
  -- authenticated, sans lui être explicitement attribué). Un état
  -- tel que `grant insert on menu_categories to public;` passait donc
  -- silencieusement ce contrôle. Corrigé en utilisant
  -- has_table_privilege(), qui résout correctement les droits via
  -- PUBLIC — vérifié empiriquement sur PostgreSQL 16 avant d'écrire
  -- ce bloc (has_table_privilege('anon', 't', 'INSERT') renvoie bien
  -- true quand seul `grant insert ... to public` a été fait, sans
  -- aucun grant direct à anon).
  --
  -- Exigé : SELECT effectif pour anon ET authenticated (sinon la
  -- carte publique est cassée). INSERT/UPDATE/DELETE NON effectifs
  -- pour anon ET authenticated (l'écriture ne doit passer que par
  -- les RPC créées plus bas) — quelle que soit la source du droit
  -- (grant direct, appartenance à un rôle, ou PUBLIC).
  for v_fn in
    select r as role_name
    from unnest(array['anon', 'authenticated']) as r
  loop
    if not has_table_privilege(v_fn.role_name, 'public.menu_categories', 'SELECT') then
      raise exception
        'SCANYM_SCHEMA_DRIFT: % n''a PAS le droit SELECT effectif sur menu_categories (carte publique cassée) — migration V66 annulée.',
        v_fn.role_name;
    end if;
    if has_table_privilege(v_fn.role_name, 'public.menu_categories', 'INSERT') then
      raise exception
        'SCANYM_SCHEMA_DRIFT: % dispose d''un droit INSERT EFFECTIF sur menu_categories (direct, via un rôle, ou via PUBLIC) — migration V66 annulée.',
        v_fn.role_name;
    end if;
    if has_table_privilege(v_fn.role_name, 'public.menu_categories', 'UPDATE') then
      raise exception
        'SCANYM_SCHEMA_DRIFT: % dispose d''un droit UPDATE EFFECTIF sur menu_categories (direct, via un rôle, ou via PUBLIC) — migration V66 annulée.',
        v_fn.role_name;
    end if;
    if has_table_privilege(v_fn.role_name, 'public.menu_categories', 'DELETE') then
      raise exception
        'SCANYM_SCHEMA_DRIFT: % dispose d''un droit DELETE EFFECTIF sur menu_categories (direct, via un rôle, ou via PUBLIC) — migration V66 annulée.',
        v_fn.role_name;
    end if;
  end loop;

  -- Vérification complémentaire explicite, symétrique à celle déjà
  -- faite pour les fonctions (section 1c/1g) : inspection directe de
  -- l'ACL de PUBLIC (grantee = 0) sur menu_categories elle-même, pour
  -- un message d'erreur qui identifie précisément PUBLIC comme
  -- source du droit plutôt que de laisser has_table_privilege() seul
  -- porter toute la preuve.
  --
  -- Étendu après correction SA3-B01 (audit Work, 11 août 2026) : TRUNCATE,
  -- REFERENCES et TRIGGER ajoutés à la liste. Sans danger pour les états
  -- A/B légitimes (grant select[,references,trigger,truncate] on all
  -- tables in schema public TO anon, authenticated) : ces grants directs
  -- ciblent anon/authenticated (grantee = oid du rôle), jamais PUBLIC
  -- (grantee = 0) — seul un grant explicite `... to public` déclenche ce
  -- bloc. `grant truncate on ... to public` restait jusqu'ici invisible
  -- à ce contrôle (qui ne portait que sur INSERT/UPDATE/DELETE) : c'est
  -- exactement l'exemple signalé par l'audit.
  if exists (
    select 1
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where c.relnamespace = 'public'::regnamespace and c.relname = 'menu_categories'
      and a.grantee = 0
      and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: PUBLIC dispose d''un droit INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER explicite sur menu_categories — migration V66 annulée.';
  end if;

  -- 1e. Policy de lecture publique : doit exister, viser SELECT,
  -- rôle {public}, mode PERMISSIVE, condition "true" (aucune
  -- restriction de lecture). Corrigé après second audit indépendant :
  -- la version précédente ne vérifiait que la condition, pas cmd,
  -- roles, ni le mode permissif.
  select policyname, permissive, roles, cmd, qual
  into v_policy
  from pg_policies
  where schemaname = 'public' and tablename = 'menu_categories'
    and policyname = 'lecture publique categories';

  if v_policy.policyname is null then
    raise exception
      'SCANYM_SCHEMA_DRIFT: policy "lecture publique categories" introuvable sur menu_categories — migration V66 annulée.';
  end if;
  if v_policy.cmd is distinct from 'SELECT' then
    raise exception
      'SCANYM_SCHEMA_DRIFT: la policy de lecture publique ne vise pas SELECT (cmd=%) — migration V66 annulée.', v_policy.cmd;
  end if;
  if v_policy.roles is distinct from array['public']::name[] then
    raise exception
      'SCANYM_SCHEMA_DRIFT: la policy de lecture publique ne vise pas le rôle public (roles=%) — migration V66 annulée.', v_policy.roles;
  end if;
  if v_policy.permissive is distinct from 'PERMISSIVE' then
    raise exception
      'SCANYM_SCHEMA_DRIFT: la policy de lecture publique n''est pas en mode PERMISSIVE (%) — migration V66 annulée.', v_policy.permissive;
  end if;
  if v_policy.qual is distinct from 'true' then
    raise exception
      'SCANYM_SCHEMA_DRIFT: condition inattendue sur la policy de lecture publique (%), "true" attendu — migration V66 annulée.',
      v_policy.qual;
  end if;

  -- 1f. Aucune policy d'écriture ne doit exister sur menu_categories
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'menu_categories'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: une policy d''écriture existe déjà sur menu_categories — migration V66 annulée, à examiner avant de relancer.';
  end if;

  -- 1g. Droits EXECUTE RÉELS sur les 3 RPC existantes — corrigé après
  -- second audit indépendant : la version précédente ne vérifiait que
  -- signature/propriétaire/SECURITY DEFINER/search_path, jamais les
  -- droits d'exécution effectifs. Vérifie ici, pour chacune des 3
  -- fonctions : PUBLIC ne peut PAS exécuter, anon ne peut PAS
  -- exécuter, authenticated PEUT exécuter. PUBLIC est représenté par
  -- grantee=0 dans aclexplode() ; un proacl NULL signifie qu'aucun
  -- REVOKE explicite n'a jamais été fait, auquel cas PUBLIC a
  -- EXECUTE par défaut (acldefault('f', owner) reproduit ce défaut
  -- pour le détecter même quand proacl est NULL).
  for v_fn in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue')
  loop
    if exists (
      select 1 from aclexplode(coalesce(
        (select proacl from pg_proc where oid = v_fn.oid),
        acldefault('f', (select proowner from pg_proc where oid = v_fn.oid))
      )) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
      raise exception
        'SCANYM_SCHEMA_DRIFT: PUBLIC dispose du droit EXECUTE sur % — migration V66 annulée.', v_fn.proname;
    end if;
    if has_function_privilege('anon', v_fn.oid, 'EXECUTE') then
      raise exception
        'SCANYM_SCHEMA_DRIFT: anon dispose du droit EXECUTE sur % — migration V66 annulée.', v_fn.proname;
    end if;
    if not has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
      raise exception
        'SCANYM_SCHEMA_DRIFT: authenticated NE dispose PAS du droit EXECUTE sur % — migration V66 annulée.', v_fn.proname;
    end if;
  end loop;

  -- 1h. Index anti-doublon — corrigé après le 3e audit indépendant :
  -- la version précédente ne rejetait l'objet que s'il s'agissait
  -- déjà d'un index sur public.menu_categories précisément — un objet
  -- HOMONYME attaché à une AUTRE relation du schéma public (les noms
  -- de relations partagent le même espace de noms en PostgreSQL,
  -- quelle que soit la table sur laquelle un index porte) n'était pas
  -- détecté, et `create unique index if not exists` s'en accommoderait
  -- silencieusement (NOTICE, pas d'erreur), laissant la protection
  -- anti-doublon absente sans que la migration échoue. La source V65
  -- attendue ne contient aucun objet de ce nom, quelle qu'en soit la
  -- nature : rejet catégorique de toute préexistence dans le schéma
  -- public, sans restreindre la recherche à menu_categories ni au
  -- type "index".
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'idx_menu_categories_unique_active_name'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: un objet nommé public.idx_menu_categories_unique_active_name existe déjà (quelle que soit la table concernée) — migration V66 annulée, à examiner manuellement avant de relancer (la migration n''est pas conçue pour être rejouée après un premier succès).';
  end if;
end $$;


-- ------------------------------------------------------------------
-- 2. Transaction principale — englobe TOUT, y compris le REVOKE
--    documentaire (corrigé après audit, voir note en tête de fichier).
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. Droits sur menu_categories — réaffirmation documentaire.
--
-- État constaté sur la base réelle avant cette migration :
--   anon           : REFERENCES, SELECT, TRIGGER, TRUNCATE
--   authenticated  : REFERENCES, SELECT, TRIGGER, TRUNCATE
-- Révoqué manuellement le jour de l'audit ; cette instruction est
-- reprise ici pour que le dépôt documente fidèlement l'état réel et
-- reste rejouable sans danger (REVOKE sur un droit déjà absent ne
-- produit pas d'erreur). Aucune donnée n'est modifiée par cette
-- ligne. DÉSORMAIS À L'INTÉRIEUR DE LA TRANSACTION : si une étape
-- suivante échoue, ce REVOKE est annulé avec le reste.
-- ------------------------------------------------------------

revoke references, trigger, truncate
on table public.menu_categories
from anon, authenticated;

-- ------------------------------------------------------------
-- 2a-bis. Vérification post-REVOKE — SA3-B01, correction après audit
-- Work du 11 août 2026.
--
-- Le REVOKE ci-dessus ne cible que anon et authenticated. Il ne
-- retire rien d'un droit accordé à PUBLIC (`grant truncate on table
-- public.menu_categories to public;`) ni d'un droit accordé à un
-- rôle tiers dont anon/authenticated hériteraient par appartenance
-- (`grant truncate ... to un_role_tiers; grant un_role_tiers to
-- anon;`) : dans les deux cas le droit reste EFFECTIF pour anon et/ou
-- authenticated après le REVOKE, alors que role_table_grants ou une
-- lecture superficielle des ACL directes semblerait indiquer une
-- table propre.
--
-- has_table_privilege() résout correctement l'origine du droit,
-- qu'elle soit directe, via PUBLIC, ou via un rôle hérité (vérifié
-- empiriquement sur PostgreSQL 16, voir 1d) : ce contrôle est donc
-- exécuté ICI, APRÈS le REVOKE, à l'intérieur de la transaction.
-- INSERT/UPDATE/DELETE sont revérifiés par la même occasion (défense
-- en profondeur ; déjà vérifiés en 1d mais avant toute écriture de ce
-- script). Un échec ici lève une exception qui annule TOUT, y compris
-- le REVOKE ci-dessus, via le ROLLBACK implicite de la transaction —
-- la migration est réellement bloquée, pas seulement signalée.
-- ------------------------------------------------------------

do $$
declare
  v_role text;
  v_priv text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.menu_categories', v_priv) then
        raise exception
          'SCANYM_SCHEMA_DRIFT: % dispose encore d''un droit % EFFECTIF sur menu_categories après le REVOKE (direct, via un rôle, ou via PUBLIC) — migration V66 annulée.',
          v_role, v_priv;
      end if;
    end loop;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2b. Colonne additive : description courte
--
-- menu_items.description (existant, inchangé) devient la description
-- LONGUE au sens fonctionnel (affichée via le bouton (i)). Aucune
-- donnée existante n'est déplacée, renommée ou réinterprétée.
-- ------------------------------------------------------------

alter table public.menu_items
  add column if not exists short_description text;

-- ------------------------------------------------------------
-- 2c. Contraintes CHECK — défense en profondeur (décision explicite,
-- voir note en tête de fichier). Contrairement à orders.customer_note
-- en V65, AUCUNE contrainte de longueur n'existait jusqu'ici sur ces
-- deux colonnes : ce n'est pas redondant, c'est un premier filet de
-- sécurité au niveau de la table, indépendant des RPC d'écriture.
--
-- Sans `not valid` : Postgres valide immédiatement les lignes
-- existantes. Pour `description`, colonne déjà peuplée (ex. les 36
-- produits Illico Presto), la validation porte donc sur des données
-- réelles — si une ligne existante dépassait 500 caractères, cette
-- ligne échouerait ici et la migration s'arrêterait, sans rien
-- corriger automatiquement. Pour `short_description`, colonne toute
-- neuve (ajoutée juste au-dessus, aucune ligne ne peut encore la
-- peupler), la validation est donc triviale à ce stade.
-- ------------------------------------------------------------

alter table public.menu_items
  add constraint menu_items_short_description_length_chk
  check (short_description is null or char_length(short_description) <= 100);

alter table public.menu_items
  add constraint menu_items_description_length_chk
  check (description is null or char_length(description) <= 500);

-- ------------------------------------------------------------
-- 2d. create_product / update_product — suppression des signatures
-- exactes à 4 paramètres, recréation à 5 paramètres.
-- ------------------------------------------------------------

drop function if exists public.create_product(uuid, text, text, numeric);
drop function if exists public.update_product(uuid, text, text, numeric);

create function public.create_product(
  p_category_id       uuid,
  p_name              text,
  p_description       text,
  p_price             numeric,
  p_short_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_order integer;
  v_id uuid;
  v_name text;
  v_description text;
  v_short_description text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_categories mc where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  -- Description longue (existant, comportement renforcé : rejet
  -- explicite au lieu du message générique précédent, sur le modèle
  -- V65 — jamais de troncature silencieuse).
  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception 'SCANYM_DESCRIPTION_TOO_LONG' using errcode = '22001';
  end if;

  -- Description courte (nouvelle, V66)
  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception 'SCANYM_SHORT_DESCRIPTION_TOO_LONG' using errcode = '22001';
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  insert into public.menu_items
    (category_id, name, description, short_description, price, display_order, is_available)
  values (
    p_category_id, v_name, v_description, v_short_description,
    round(p_price, 2), v_order, true
  )
  returning id into v_id;

  return v_id;
end $$;

create function public.update_product(
  p_product_id        uuid,
  p_name              text,
  p_description       text,
  p_price             numeric,
  p_short_description text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_description text;
  v_short_description text;
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception 'SCANYM_DESCRIPTION_TOO_LONG' using errcode = '22001';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception 'SCANYM_SHORT_DESCRIPTION_TOO_LONG' using errcode = '22001';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  update public.menu_items
  set name               = v_name,
      description        = v_description,
      short_description  = v_short_description,
      price              = round(p_price, 2)
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

revoke all on function public.create_product(uuid, text, text, numeric, text) from public, anon;
revoke all on function public.update_product(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.create_product(uuid, text, text, numeric, text) to authenticated;
grant execute on function public.update_product(uuid, text, text, numeric, text) to authenticated;

-- ------------------------------------------------------------
-- 2e. get_merchant_catalogue — suppression + recréation.
--
-- Restructurée en LEFT JOIN depuis menu_categories (au lieu d'un
-- JOIN depuis menu_items) : une catégorie tout juste créée, sans
-- aucun produit, doit rester visible dans le dashboard, sinon la
-- création de catégorie serait inutilisable (impossible de voir la
-- catégorie pour y ajouter un premier produit). Conséquence : les
-- colonnes liées au produit (product_id, name, description, prix…)
-- deviennent NULL pour une catégorie vide — le TypeScript appelant
-- (lib/services/dashboard.ts) doit filtrer sur product_id non nul
-- avant de construire sa liste de produits, tout en conservant les
-- métadonnées de catégorie de chaque ligne.
--
-- Ajouts : short_description (produit), category_display_order et
-- category_is_option_source (catégorie — détecte une catégorie
-- technique servant de source d'options, sans stocker de drapeau
-- dédié : recalculé à chaque lecture, jamais désynchronisable).
-- ------------------------------------------------------------

drop function if exists public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id              uuid,
  category_id             uuid,
  category_name           text,
  category_translations   jsonb,
  category_display_order  integer,
  category_is_option_source boolean,
  name                    text,
  short_description       text,
  description             text,
  translations            jsonb,
  price                   numeric,
  is_available            boolean,
  archived_at             timestamptz,
  display_order           integer,
  is_option_source        boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  select mi.id, mc.id, mc.name::text, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mi.name::text, mi.short_description, mi.description, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         )
  from public.menu_categories mc
  left join public.menu_items mi
    on mi.category_id = mc.id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 2f. Catégories — contrôle d'accès commun.
-- ------------------------------------------------------------

create or replace function public.assert_category_role(
  p_category_id uuid,
  p_roles       text[]
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_categories mc
  where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (p_roles)
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  return v_restaurant_id;
end $$;

-- ------------------------------------------------------------
-- 2g. create_category — is_active = true imposé par le serveur.
--
-- Aucun paramètre p_is_active : la valeur par défaut de la colonne
-- (true) s'applique systématiquement, sans possibilité pour
-- l'appelant de créer directement une catégorie technique inactive.
-- ------------------------------------------------------------

create function public.create_category(
  p_restaurant_id  uuid,
  p_name           text,
  p_display_order  integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_order integer;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_display_order is null then
    select coalesce(max(mc.display_order), 0) + 1 into v_order
    from public.menu_categories mc where mc.restaurant_id = p_restaurant_id;
  else
    v_order := p_display_order;
  end if;

  begin
    insert into public.menu_categories (restaurant_id, name, display_order, is_active)
    values (p_restaurant_id, v_name, v_order, true)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SCANYM_CATEGORY_DUPLICATE_NAME' using errcode = '23505';
  end;

  return v_id;
end $$;

-- ------------------------------------------------------------
-- 2h. update_category — nom et display_order uniquement.
--
-- Ne touche jamais is_active : ni paramètre, ni colonne modifiée.
-- Une catégorie technique conserve son état ; une catégorie normale
-- ne peut pas être basculée depuis cette fonction.
-- ------------------------------------------------------------

create function public.update_category(
  p_category_id   uuid,
  p_name          text,
  p_display_order integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  perform public.assert_category_role(p_category_id, array['owner','manager']);

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;
  if p_display_order is null then
    raise exception using errcode = '22023', message = 'Display order is required';
  end if;

  begin
    update public.menu_categories
    set name = v_name, display_order = p_display_order
    where id = p_category_id;
  exception when unique_violation then
    raise exception 'SCANYM_CATEGORY_DUPLICATE_NAME' using errcode = '23505';
  end;

  if not found then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;
end $$;

revoke all on function public.assert_category_role(uuid, text[]) from public;
revoke all on function public.create_category(uuid, text, integer) from public, anon;
revoke all on function public.update_category(uuid, text, integer) from public, anon;
grant execute on function public.create_category(uuid, text, integer) to authenticated;
grant execute on function public.update_category(uuid, text, integer) to authenticated;

-- ------------------------------------------------------------
-- 2i. Protection anti-doublon — index unique partiel.
--
-- MÉCANISME : index unique partiel, pas un contrôle applicatif dans
-- la RPC. Choix délibéré pour la concurrence : un contrôle
-- "SELECT puis INSERT" dans la RPC laisserait une fenêtre entre les
-- deux requêtes où deux appels concurrents pourraient tous les deux
-- passer le SELECT avant qu'aucun des deux INSERT n'ait eu lieu,
-- créant malgré tout un doublon. Un index unique est appliqué de
-- façon atomique par PostgreSQL au moment de l'écriture (INSERT ou
-- UPDATE) : le second des deux appels concurrents échoue toujours
-- avec une violation d'unicité (23505), quel que soit l'ordre
-- d'arrivée — aucune fenêtre de course possible.
--
-- Portée : restaurant_id + nom normalisé (même jeu de caractères que
-- les RPC ci-dessus, insensible à la casse via lower()). Sensible aux
-- accents (aucune fonction unaccent() appliquée — "Café" et "Cafe"
-- restent distincts, tel que demandé). Limité aux catégories
-- is_active = true : les catégories techniques/inactives sont
-- exclues de la contrainte par la clause WHERE de l'index lui-même,
-- pas par une logique applicative séparée qui pourrait diverger.
-- ------------------------------------------------------------

create unique index idx_menu_categories_unique_active_name
  on public.menu_categories (restaurant_id, lower(btrim(name, E' \t\n\r\f' || chr(11))))
  where is_active = true;

commit;

-- ============================================================
-- Résumé des changements par rapport à l'état V65 :
--   + menu_items.short_description (colonne additive)
--   + contraintes CHECK menu_items_short_description_length_chk (100)
--     et menu_items_description_length_chk (500) — défense en
--     profondeur ajoutée après audit indépendant (voir note en tête
--     de fichier), pas seulement une validation dans les RPC
--   ~ create_product / update_product : drop + recréation à 5
--     paramètres (p_short_description ajouté), signature exacte
--     supprimée confirmée par contrôle préalable, jamais cascade
--   ~ get_merchant_catalogue : drop + recréation, LEFT JOIN
--     (catégories vides visibles), + short_description,
--     + category_display_order, + category_is_option_source
--   + assert_category_role, create_category, update_category
--     (jamais set_category_active)
--   + index unique partiel anti-doublon sur catégories actives.
--     Corrigé après 3e audit indépendant : la préexistence de tout
--     objet portant ce nom dans le schéma public (quelle que soit la
--     table concernée) fait échouer la migration catégoriquement —
--     aucune tentative de valider une définition existante, aucun
--     IF NOT EXISTS sur la création réelle (qui masquerait
--     silencieusement une collision de nom résiduelle).
--   + droits de menu_categories vérifiés via has_table_privilege()
--     (résout correctement les droits accordés à PUBLIC, pas
--     seulement les grants directs à anon/authenticated) — couvre
--     SELECT/INSERT/UPDATE/DELETE avant transaction et, après
--     correction SA3-B01, TRUNCATE/REFERENCES/TRIGGER en plus,
--     vérifiés une seconde fois APRÈS le REVOKE (2a-bis) pour
--     couvrir aussi les droits hérités via un rôle tiers
--   + revoke references/trigger/truncate sur menu_categories,
--     désormais À L'INTÉRIEUR de la transaction principale (corrigé
--     après 2e audit indépendant — voir note en tête de fichier)
-- Aucune fonction d'options existante modifiée. Aucune fonction de
-- commande (create_order, update_order_status) touchée.
-- ============================================================
