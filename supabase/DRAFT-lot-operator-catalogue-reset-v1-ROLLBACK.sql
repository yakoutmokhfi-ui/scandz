-- ============================================================
-- Scanym — OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1.2 — ROLLBACK
-- (rollback CONDITIONNEL, fail-fast, atomique)
--
-- ------------------------------------------------------------------
-- CE QUE CE FICHIER FAIT EXACTEMENT (documentation littérale — la
-- version v1.1 de cet en-tête était contradictoire avec son propre
-- contenu, corrigé ici : ce rollback CONTIENT BIEN un DROP COLUMN,
-- et il n'est PAS purement additif)
-- ------------------------------------------------------------------
--
-- 1. SUPPRIME (DROP FUNCTION) les 2 RPC de ce lot :
--    reset_merchant_catalogue(uuid, text) -- et, défensivement,
--    l'ancienne signature v1 reset_merchant_catalogue(uuid) --
--    ainsi que preview_catalogue_reset(uuid).
-- 2. SUPPRIME (DROP TABLE) la table d'audit catalogue_reset_audit_log
--    et sa policy. Les lignes d'audit déjà écrites sont donc PERDUES
--    par ce rollback : c'est le comportement voulu (la table est
--    entièrement créée par ce lot, elle n'existe pas avant lui), mais
--    ce n'est PAS une opération neutre — à exporter avant rollback si
--    la traçabilité des resets déjà effectués doit être conservée.
-- 3. REMPLACE get_merchant_catalogue(uuid, boolean) par sa définition
--    EXACTE d'avant ce lot (29 colonnes, sans category_is_active ni
--    subcategory_is_active), c'est-à-dire celle établie par
--    DRAFT-lot-catalogue-operator-authorization-v1.sql (OB-2 v1.1 --
--    la DERNIÈRE définition avant ce lot dans la chaîne réelle, AVEC
--    le bypass is_scanym_operator()).
-- 4. RECONSTRUIT idx_menu_subcategories_unique_name en index unique
--    INCONDITIONNEL (état DRAFT-lot-catalogue-subcategories-
--    backoffice-v1.sql), c'est-à-dire SANS la clause
--    `where is_active = true` ajoutée par ce lot.
-- 5. SUPPRIME (ALTER TABLE ... DROP COLUMN) la colonne
--    menu_subcategories.is_active ajoutée par ce lot.
--
-- Ce rollback ne SUPPRIME, ne MODIFIE, ne RENOMME et ne RE-POINTE
-- AUCUNE ligne de menu_items / menu_categories / menu_subcategories /
-- orders / order_items. Il ne contient aucun DELETE et aucun UPDATE
-- de données marchandes, quelles que soient les circonstances.
--
-- ------------------------------------------------------------------
-- CE QUE CE ROLLBACK NE FAIT **PAS** (et ne peut pas faire)
-- ------------------------------------------------------------------
--
-- Il revient sur le SCHÉMA introduit par ce lot, jamais sur les
-- EFFETS DE DONNÉES des resets déjà exécutés :
--   - les produits archivés par un reset RESTENT archivés ;
--   - les catégories désactivées par un reset (menu_categories
--     .is_active = false) RESTENT désactivées — cette colonne est
--     PRÉEXISTANTE à ce lot (schema.sql) et n'est ni ajoutée ni
--     retirée ici ; une catégorie désactivée se comporte alors
--     exactement comme n'importe quelle catégorie volontairement
--     désactivée, état parfaitement représentable par le schéma
--     d'avant ce lot ;
--   - les sous-catégories désactivées perdent leur marqueur
--     `is_active` avec la colonne (étape 5) et redeviennent donc
--     indistinguables des sous-catégories actives.
-- Ré-activer ou désarchiver automatiquement serait une MUTATION DE
-- DONNÉES MARCHANDES (ressusciter un catalogue volontairement remis
-- à zéro), hors périmètre d'un rollback de schéma : ce fichier ne le
-- fait pas et ne doit pas le faire.
--
-- ------------------------------------------------------------------
-- POURQUOI CE ROLLBACK EST **CONDITIONNEL** (remédiation v1.2)
-- ------------------------------------------------------------------
--
-- L'audit CTO de v1.1 a identifié un défaut réel : l'étape 4
-- ci-dessus peut ÉCHOUER après une utilisation parfaitement légitime
-- de la fonctionnalité.
--
-- v1.1 autorise délibérément cet état (prouvé par le test [v1.1-R]) :
--
--     Chevres   is_active = false   (retenue par un reset, historique)
--     Chevres   is_active = true    (recréée par un réimport propre)
--
-- ...deux lignes de MÊME nom normalisé sous la MÊME catégorie, rendu
-- possible par l'index PARTIEL `where is_active = true`. L'index
-- INCONDITIONNEL restauré à l'étape 4 interdit exactement cet état :
-- son CREATE UNIQUE INDEX échoue alors avec une violation d'unicité.
--
-- En v1.1, cet échec survenait APRÈS les étapes 1 à 3 (fonctions et
-- table d'audit déjà supprimées, get_merchant_catalogue déjà
-- remplacée) ET APRÈS le `drop index` de l'étape 4 — laissant la base
-- dans un état à la fois PARTIELLEMENT rétrogradé et DÉPOURVU de tout
-- index d'unicité sur menu_subcategories. C'est ce comportement, et
-- non la fonctionnalité de reset elle-même, que corrige v1.2.
--
-- ------------------------------------------------------------------
-- STRATÉGIE RETENUE : « Outcome B » — refus fail-fast conditionnel
-- ------------------------------------------------------------------
--
-- Un rollback AUTOMATIQUE intégral est IMPOSSIBLE sans destruction ou
-- mutation silencieuse de données marchandes dès lors que des noms
-- normalisés dupliqués existent. Les 4 seules issues envisageables
-- ont toutes été examinées et écartées, avec preuve :
--
--   a. supprimer la sous-catégorie inactive retenue — détruit de
--      l'historique, et `menu_items.subcategory_id` étant
--      `ON DELETE SET NULL`, cela détacherait SILENCIEUSEMENT les
--      produits archivés de leur sous-catégorie d'origine. EXCLU
--      (interdit explicitement par le mandat, et destructeur).
--   b. fusionner les 2 lignes / re-pointer les produits archivés vers
--      la nouvelle ligne active — réécrit l'historique marchand sans
--      preuve que les 2 sous-catégories représentent la même réalité
--      métier. EXCLU (interdit explicitement par le mandat).
--   c. renommer l'une des 2 lignes — modifie silencieusement des
--      données de catalogue marchand. EXCLU (interdit explicitement
--      par le mandat).
--   d. conserver l'index PARTIEL et se contenter de retirer la
--      colonne — impossible techniquement : PostgreSQL supprime
--      automatiquement (CASCADE implicite) tout index dépendant d'une
--      colonne retirée, ce qui laisserait menu_subcategories SANS
--      AUCUN index d'unicité. EXCLU (affaiblissement silencieux du
--      schéma, pire que l'échec d'origine).
--
-- Donc : quand des doublons existent, ce rollback REFUSE, AVANT toute
-- mutation, avec SCANYM_ROLLBACK_BLOCKED (section 0b). Quand il n'y
-- en a pas — cas normal, y compris un reset exécuté sans réimport de
-- même nom — le rollback s'exécute INTÉGRALEMENT et automatiquement.
-- Un refus explicite vaut mieux qu'une réconciliation destructive
-- automatique.
--
-- ------------------------------------------------------------------
-- RECOURS EXACT EN CAS DE SCANYM_ROLLBACK_BLOCKED
-- ------------------------------------------------------------------
--
-- Le message d'erreur liste précisément chaque groupe fautif
-- (restaurant, catégorie, nom normalisé, identifiants des lignes et
-- leur état actif/inactif). La réconciliation est une DÉCISION
-- MÉTIER sur des données marchandes, jamais une opération que ce
-- script s'autorise : elle requiert une autorisation CIO explicite.
-- Trois issues, par ordre de préférence :
--
--   1. NE PAS ROLLBACK (recommandé par défaut) : conserver ce lot
--      installé. L'état dupliqué actif/inactif est parfaitement
--      valide et intentionnel sous les sémantiques v1.1/v1.2.
--   2. Renommer manuellement, marchand par marchand et après accord
--      du marchand, la sous-catégorie INACTIVE retenue (p. ex.
--      « Chevres (archivé 2026-09) »), puis relancer ce rollback.
--      L'historique est conservé, rien n'est supprimé.
--   3. Décider explicitement, marchand par marchand, du sort des
--      produits archivés rattachés à la ligne inactive, puis la
--      supprimer. Cette voie DÉTRUIT de l'historique et ne doit être
--      empruntée qu'avec une autorisation écrite.
--
-- ------------------------------------------------------------------
-- ATOMICITÉ
-- ------------------------------------------------------------------
--
-- La totalité du fichier s'exécute dans UNE SEULE transaction, et les
-- 3 contrôles préalables (0a/0b/0c) sont les PREMIÈRES instructions
-- de cette transaction — donc strictement avant toute suppression de
-- fonction, toute suppression de la table d'audit, toute
-- redéfinition de get_merchant_catalogue, toute reconstruction
-- d'index et tout DROP COLUMN.
--
-- Les contrôles sont placés À L'INTÉRIEUR de la transaction (et non
-- avant `begin;`, contrairement à migration-v66-rollback.sql) :
-- c'est délibéré. Un contrôle placé avant `begin;` ne protège que si
-- le client psql tourne avec `-v ON_ERROR_STOP=1` ; sans ce drapeau,
-- psql poursuivrait le fichier et appliquerait le rollback malgré
-- l'échec du contrôle. Placés dans la transaction, un échec avorte
-- la transaction entière : toutes les instructions suivantes sont
-- refusées et le `commit;` final agit comme un ROLLBACK. La garantie
-- « zéro mutation partielle » ne dépend donc d'AUCUN drapeau client.
--
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur Production par ce lot.
-- ============================================================

begin;

-- ------------------------------------------------------------------
-- 0a. CONTRÔLE PRÉALABLE — état de départ attendu
--     Confirme que cette base a bien reçu ce lot. Refus fail-closed
--     sinon (rollback déjà appliqué, ou lot jamais appliqué).
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_merchant_catalogue'
  ) then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: reset_merchant_catalogue introuvable — cette base ne semble pas avoir reçu OPERATOR CATALOGUE RESET, rollback annulé (aucune mutation).';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_subcategories'
      and column_name = 'is_active'
  ) then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: menu_subcategories.is_active introuvable — cette base ne semble pas avoir reçu OPERATOR CATALOGUE RESET v1.1+, rollback annulé (aucune mutation).';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 0b. CONTRÔLE PRÉALABLE — compatibilité des données avec l'index
--     unique INCONDITIONNEL restauré à l'étape 4.
--
--     Le contrôle reproduit EXACTEMENT la contrainte que
--     CREATE UNIQUE INDEX appliquera — (category_id, nom normalisé),
--     toutes lignes confondues — plutôt qu'un proxy (« une active +
--     une inactive »), afin qu'aucun état bloquant ne puisse lui
--     échapper.
-- ------------------------------------------------------------------
do $$
declare
  v_groups   integer;
  v_rows     integer;
  v_details  text;
begin
  select count(*), coalesce(sum(x.n), 0), string_agg(
           format('restaurant %s / catégorie %s (« %s ») / nom normalisé « %s » : %s lignes [%s]',
                  x.restaurant_id, x.category_id, x.category_name, x.norm, x.n, x.ids),
           E'\n  ')
    into v_groups, v_rows, v_details
  from (
    select mc.restaurant_id                                                  as restaurant_id,
           ms.category_id                                                    as category_id,
           mc.name::text                                                     as category_name,
           lower(btrim(ms.name, E' \t\n\r\f' || chr(11)))                    as norm,
           count(*)                                                          as n,
           string_agg(
             ms.id::text || case when ms.is_active then ' (active)' else ' (inactive)' end,
             ', ' order by ms.is_active desc, ms.id
           )                                                                 as ids
    from public.menu_subcategories ms
    join public.menu_categories mc on mc.id = ms.category_id
    group by mc.restaurant_id, ms.category_id, mc.name::text,
             lower(btrim(ms.name, E' \t\n\r\f' || chr(11)))
    having count(*) > 1
  ) x;

  if v_groups > 0 then
    raise exception
      'SCANYM_ROLLBACK_BLOCKED: duplicate active/inactive subcategory names created under reset v1.1 semantics require manual reconciliation.'
      using
        detail = format(
          '%s groupe(s) de sous-catégories (%s lignes) partagent un nom normalisé sous une même catégorie. L''index unique INCONDITIONNEL idx_menu_subcategories_unique_name restauré par ce rollback ne peut pas être construit sur ces données. Groupes concernés :%s',
          v_groups, v_rows, E'\n  ' || v_details),
        hint =
          'AUCUNE mutation n''a été appliquée (transaction avortée avant toute suppression de fonction, de table d''audit, de colonne ou d''index). Recours possibles, par ordre de préférence : (1) ne pas rollback et conserver ce lot installé — l''état dupliqué actif/inactif est valide et intentionnel sous les sémantiques v1.1/v1.2 ; (2) renommer manuellement la sous-catégorie INACTIVE retenue, après accord du marchand, puis relancer ce rollback ; (3) statuer explicitement sur les produits archivés rattachés à la ligne inactive avant de la supprimer — cette voie DÉTRUIT de l''historique et exige une autorisation écrite. Ce script ne renomme, ne fusionne, ne re-pointe et ne supprime JAMAIS de données marchandes de lui-même.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 0c. CONTRÔLE PRÉALABLE — dépendances sur la colonne retirée.
--     ALTER TABLE ... DROP COLUMN supprime AUTOMATIQUEMENT (cascade
--     implicite) tout objet dépendant de la colonne. Le seul
--     dépendant attendu est l'index partiel de ce lot, remplacé à
--     l'étape 4 avant le DROP COLUMN. Si un AUTRE objet (vue, index,
--     contrainte, policy d'un lot ultérieur) s'est appuyé sur
--     is_active, ce rollback le détruirait silencieusement : refus.
-- ------------------------------------------------------------------
do $$
declare
  v_attnum  smallint;
  v_idx_oid oid;
  v_others  text;
begin
  select a.attnum into v_attnum
  from pg_attribute a
  where a.attrelid = 'public.menu_subcategories'::regclass
    and a.attname = 'is_active' and not a.attisdropped;

  v_idx_oid := coalesce(to_regclass('public.idx_menu_subcategories_unique_name')::oid, 0::oid);

  -- Deux dépendances sont ATTENDUES et ne doivent pas déclencher un
  -- refus :
  --   - l'index partiel de ce lot (remplacé à l'étape 3, avant le
  --     DROP COLUMN) -- exclu par son OID ;
  --   - la valeur par défaut de la colonne elle-même (pg_attrdef :
  --     `default true`), qui fait partie intégrante de la définition
  --     de la colonne et disparaît légitimement avec elle -- exclue
  --     par sa classe. (Faux positif réel, détecté par le harnais
  --     PostgreSQL réel : sans cette exclusion, AUCUN rollback ne
  --     pourrait jamais s'exécuter.)
  select string_agg(distinct pg_describe_object(d.classid, d.objid, d.objsubid), '; ')
    into v_others
  from pg_depend d
  where d.refclassid = 'pg_class'::regclass
    and d.refobjid   = 'public.menu_subcategories'::regclass
    and d.refobjsubid = v_attnum
    and d.objid   <> v_idx_oid
    and d.classid <> 'pg_attrdef'::regclass;

  if v_others is not null then
    raise exception
      'SCANYM_ROLLBACK_BLOCKED: des objets non prévus dépendent de menu_subcategories.is_active — rollback annulé (aucune mutation).'
      using
        detail = format('Objets dépendants inattendus : %s', v_others),
        hint   = 'Ces objets seraient supprimés silencieusement par ALTER TABLE ... DROP COLUMN. Les examiner et les retirer explicitement avant de relancer ce rollback.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 1. RPC de ce lot + table d'audit.
-- ------------------------------------------------------------------
drop function if exists public.reset_merchant_catalogue(uuid, text);
drop function if exists public.reset_merchant_catalogue(uuid);
drop function if exists public.preview_catalogue_reset(uuid);
drop policy if exists "lecture operateur audit reset catalogue" on public.catalogue_reset_audit_log;
drop table if exists public.catalogue_reset_audit_log;

-- ------------------------------------------------------------------
-- 2. Restaure get_merchant_catalogue(uuid, boolean) à sa définition
--    EXACTE établie par DRAFT-lot-catalogue-operator-authorization-v1
--    .sql (OB-2 v1.1 -- la DERNIÈRE définition avant ce lot dans la
--    chaîne de migration réelle, avec bypass is_scanym_operator() ;
--    29 colonnes, sans category_is_active/subcategory_is_active).
-- ------------------------------------------------------------------
drop function if exists public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id                 uuid,
  category_id                uuid,
  category_name               text,
  category_name_hash          text,
  category_translations       jsonb,
  category_display_order      integer,
  category_is_option_source   boolean,
  category_description        text,
  category_description_hash   text,
  subcategory_id               uuid,
  subcategory_name             text,
  subcategory_display_order    integer,
  name                        text,
  name_hash                   text,
  short_description            text,
  short_description_hash       text,
  description                  text,
  description_hash             text,
  translations                 jsonb,
  price                        numeric,
  is_available                 boolean,
  archived_at                  timestamptz,
  display_order                integer,
  is_option_source             boolean,
  image_url                    text,
  tax_rate                     numeric,
  unit_weight_grams            integer,
  weight_is_approximate        boolean,
  reference_price_per_kg       numeric
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
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  with groups as (
    select ms.category_id as category_id, ms.id as subcategory_id,
           ms.name::text as subcategory_name, ms.display_order as subcategory_display_order
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order
    from public.menu_categories mc2
    where mc2.restaurant_id = p_restaurant_id
  )
  select mi.id, mc.id, mc.name::text, mc.name_hash, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description, mc.description_hash,
         g.subcategory_id, g.subcategory_name, g.subcategory_display_order,
         mi.name::text, mi.name_hash, mi.short_description, mi.short_description_hash,
         mi.description, mi.description_hash, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         ),
         mi.image_url,
         mi.tax_rate, mi.unit_weight_grams, mi.weight_is_approximate, mi.reference_price_per_kg
  from public.menu_categories mc
  join groups g on g.category_id = mc.id
  left join public.menu_items mi
    on mi.category_id = mc.id
    and mi.subcategory_id is not distinct from g.subcategory_id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name,
           case when g.subcategory_id is null then 0 else 1 end,
           g.subcategory_display_order nulls last, g.subcategory_name nulls last,
           mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------
-- 3. Restaure idx_menu_subcategories_unique_name SANS clause WHERE
--    (état DRAFT-lot-catalogue-subcategories-backoffice-v1.sql), puis
--    4. retire la colonne is_active de menu_subcategories.
--
--    L'ordre est imposé : l'index partiel de ce lot dépend de
--    is_active ; en le remplaçant d'abord par un index qui n'en
--    dépend pas, le DROP COLUMN qui suit ne peut plus emporter aucun
--    index par cascade implicite. La faisabilité du CREATE UNIQUE
--    INDEX sur les données présentes a déjà été prouvée en 0b.
-- ------------------------------------------------------------------
drop index if exists public.idx_menu_subcategories_unique_name;
create unique index idx_menu_subcategories_unique_name
  on public.menu_subcategories (category_id, lower(btrim(name, E' \t\n\r\f' || chr(11))));

alter table public.menu_subcategories drop column if exists is_active;

-- ------------------------------------------------------------------
-- 5. CONTRÔLE FINAL — rollback complet, jamais partiel. Exécuté dans
--    la même transaction : un échec ici annule TOUT ce qui précède.
-- ------------------------------------------------------------------
do $$
declare
  v_idxdef text;
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('reset_merchant_catalogue', 'preview_catalogue_reset')
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une RPC de reset de catalogue subsiste — rollback annulé.';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'catalogue_reset_audit_log'
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: la table catalogue_reset_audit_log subsiste — rollback annulé.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_subcategories'
      and column_name = 'is_active'
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: menu_subcategories.is_active subsiste — rollback annulé.';
  end if;

  select indexdef into v_idxdef
  from pg_indexes
  where schemaname = 'public' and indexname = 'idx_menu_subcategories_unique_name';

  if v_idxdef is null then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: idx_menu_subcategories_unique_name absent — menu_subcategories resterait sans index d''unicité, rollback annulé.';
  end if;

  if v_idxdef ilike '%where%' then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: idx_menu_subcategories_unique_name est encore un index PARTIEL — rollback annulé.';
  end if;

  -- get_merchant_catalogue doit être revenue à 29 colonnes ET avoir
  -- conservé le bypass opérateur d'OB-2 v1.1 (garde anti-régression :
  -- restaurer par erreur une définition antérieure à OB-2 retirerait
  -- silencieusement l'accès opérateur au catalogue marchand).
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and (
        pg_get_function_result(p.oid) ilike '%category_is_active%'
        or pg_get_function_result(p.oid) ilike '%subcategory_is_active%'
      )
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: get_merchant_catalogue expose encore category_is_active/subcategory_is_active — rollback annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: get_merchant_catalogue a perdu le bypass is_scanym_operator() d''OB-2 v1.1 — rollback annulé.';
  end if;
end $$;

commit;

-- ============================================================
-- FIN — OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1.2 — ROLLBACK
-- ============================================================
