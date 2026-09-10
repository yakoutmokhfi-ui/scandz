-- ============================================================
-- Scanym — OPERATOR BACKOFFICE — OB-4 v1.1 -> v1.2
-- CATALOGUE IMPORT COMMIT / IDEMPOTENCY — SQL FOUNDATION
--
-- Fichier réécrit sur place (jamais publié/installé en Production --
-- DRAFT, même convention que legal-tax v1->v1.1->v1.2 et catalogue-
-- subcategories-backoffice v1->v1.1) : v1.2 est un correctif de
-- blocage sur v1.1, PAS une réécriture. Tout le corps v1.1 est
-- préservé À L'IDENTIQUE (voir sections 1 à 4 ci-dessous, inchangées
-- ligne pour ligne) ; SEULE la section 3bis (garde de préflight
-- fail-closed) est AJOUTÉE, entre la section 3 (normalisation) et
-- l'instruction CREATE UNIQUE INDEX elle-même.
--
-- CTO/CIO SQL GO (OB-4 v1.1). Périmètre AUTORISÉ, strictement :
--   1. Un index unique partiel sur menu_items, alignant enfin la base
--      sur le contrat d'identité produit déjà publié par OB-3
--      (lib/catalogue-import/resolution.ts) : restaurant (porté par
--      category_id, déjà scopé restaurant) + catégorie + nom normalisé
--      -- SANS la sous-catégorie (portée volontairement à la catégorie
--      entière, exactement comme le contrat OB-3).
--   2. Le changement MINIMAL sur create_product pour transformer la
--      violation d'unicité en erreur applicative stable, plutôt qu'une
--      23505 brute -- même patron EXACT que create_category (v66) et
--      create_subcategory (subcategories-backoffice-v1), déjà en
--      production, déjà audité.
--
-- CTO/CIO SQL GO (OB-4 v1.2 -- REMÉDIATION DE BLOCAGE). Audit
-- indépendant Cat Stevens : préflight Production AGRÉGÉ SEUL a détecté
-- 1 groupe de doublons actifs / 1 ligne excédentaire sous la future
-- clé d'unicité -- CREATE UNIQUE INDEX échouerait donc tel quel sur les
-- données Production actuelles. Ajout AUTORISÉ, strictement :
--   3bis. Une garde de préflight fail-closed, DANS CE MÊME FICHIER,
--      exécutée AVANT le CREATE UNIQUE INDEX : compte les groupes de
--      doublons actifs sous la clé exacte de l'index (category_id +
--      nom normalisé, archived_at is null) et ABORT proprement
--      (exception explicite SCANYM_PRODUCT_UNIQUENESS_PREFLIGHT_FAILED)
--      si au moins un groupe existe -- jamais un CREATE UNIQUE INDEX
--      aveugle dont l'échec serait un 23505 opaque comme premier
--      signal.
-- Aucune autre modification n'est autorisée par ce correctif : AUCUNE
-- remédiation automatique de données (voir PRODUCT-DUPLICATE-
-- PREFLIGHT.md et PRODUCTION-REMEDIATION-RUNBOOK.md, tous deux hors de
-- ce fichier -- une décision CIO explicite sur la ligne autoritaire
-- reste un préalable humain, jamais une heuristique SQL).
--
-- AUCUNE autre modification : pas de SKU/external_ref, pas de nouvelle
-- table, pas de RLS, pas de GRANT, pas de nouveau chemin
-- browser/service_role. update_product, archive_product,
-- restore_product, get_merchant_catalogue, assert_product_role :
-- INCHANGÉS (repris tels quels de DRAFT-lot-catalogue-operator-
-- authorization-v1.sql, aucune ligne modifiée).
--
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot
-- (PRODUCTION SQL INSTALLATION: NOT AUTHORIZED pour OB-4 v1.1 ni v1.2).
--
-- Baseline requis : main @ b4672684d0c86e754a0a1a4f6fa1ba034f11e202
-- (tree b7cd24d6fd0ce3ff0ff7f1fa9e3c8591e720d119), incluant
-- DRAFT-lot-catalogue-operator-authorization-v1.sql déjà appliqué.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. POURQUOI UN INDEX UNIQUE PARTIEL PLUTÔT QU'UN CONTRÔLE APPLICATIF
--
-- Identique au raisonnement DÉJÀ documenté et déjà éprouvé pour
-- menu_categories (migration-v66-categories-descriptions.sql) et
-- menu_subcategories (DRAFT-lot-catalogue-subcategories-backoffice-
-- v1.sql) : un contrôle "SELECT puis INSERT" côté fonction laisserait
-- une fenêtre de course entre les deux appels concurrents -- les DEUX
-- pourraient voir "aucun produit existant" et insérer chacun leur
-- ligne. Un index unique est une contrainte évaluée PAR POSTGRES au
-- moment de l'écriture elle-même : sous deux INSERT concurrents visant
-- la même (category_id, nom normalisé), le second échoue TOUJOURS avec
-- une violation d'unicité (23505), quel que soit l'ordre d'arrivée --
-- aucune fenêtre de course possible. C'est exactement l'exigence du
-- mandat ("Do not rely on client/browser pre-checks for concurrency
-- safety").
--
-- ------------------------------------------------------------------
-- 2. PÉRIMÈTRE DE LA CLÉ -- IDENTIQUE AU CONTRAT PUBLIÉ OB-3
--
-- lib/catalogue-import/resolution.ts (mandat OB-3, commentaire
-- existant) : "restaurant + category + normalized product name, SANS
-- la sous-catégorie (portée volontairement à la catégorie entière)".
-- category_id suffit à porter le restaurant (menu_categories.
-- restaurant_id, déjà la même colonne utilisée par l'index catégories)
-- -- aucun besoin de joindre restaurant_id explicitement. subcategory_id
-- n'entre PAS dans la clé, conformément au mandat OB-4 v1.1
-- ("Do NOT include subcategory_id in uniqueness").
--
-- Filtre partiel : "where archived_at is null" (et non "is_active",
-- qui n'existe pas sur menu_items -- c'est archived_at qui porte cette
-- sémantique ici, cf. migration-v31-catalogue.sql section 1). Un
-- produit archivé n'occupe donc plus la clé -- un nouvel import peut
-- recréer un produit du même nom dans la même catégorie après
-- archivage de l'ancien, cohérent avec le comportement déjà établi
-- pour les catégories (is_active = true) et repris ici avec la colonne
-- d'archivage propre aux produits.
--
-- ------------------------------------------------------------------
-- 3. NORMALISATION -- ÉQUIVALENCE VÉRIFIÉE, PAS SUPPOSÉE
--
-- Côté application, lib/catalogue-import/normalization.ts::normalizedKey
-- applique EXACTEMENT : trimEdges (lib/catalogue-text.ts, jeu de 6
-- caractères explicite -- espace, tab, LF, CR, FF, VT, IDENTIQUE au
-- jeu SQL E' \t\n\r\f' || chr(11)) puis .toLowerCase() (JS). Côté SQL,
-- lower(btrim(name, E' \t\n\r\f' || chr(11))) applique le MÊME jeu de
-- bordure puis lower() (PostgreSQL). Les deux jeux de caractères de
-- bordure sont identiques caractère pour caractère (vérifié en lisant
-- les DEUX sources, pas supposé) ; les deux fonctions de casse sont
-- une normalisation Unicode basique SANS repli sur les accents dans
-- les deux cas (aucun des deux ne retire les diacritiques -- "Café" et
-- "Cafe" restent des clés DIFFÉRENTES des deux côtés, cf. commentaire
-- normalizedKey déjà présent et déjà cohérent avec ce précédent
-- categories/subcategories). AUCUNE divergence matérielle constatée :
-- pas de STOP requis par le mandat ("NORMALIZATION CONSISTENCY").
-- ------------------------------------------------------------------
--
-- ------------------------------------------------------------------
-- 3bis. GARDE DE PRÉFLIGHT FAIL-CLOSED (OB-4 v1.2 -- remédiation du
--    blocage Cat Stevens). Exécutée EN PREMIER, avant toute tentative
--    de CREATE UNIQUE INDEX : recompte, avec EXACTEMENT la même clé
--    que l'index ci-dessous (category_id + lower(btrim(name, ...)),
--    produits actifs seulement), les groupes de doublons actuellement
--    présents. Si au moins un groupe existe, ABORT immédiat avec un
--    message Scanym stable et explicite -- jamais un CREATE UNIQUE
--    INDEX aveugle dont l'échec serait un 23505 opaque ("duplicate key
--    value violates unique constraint") comme premier signal donné à
--    l'opérateur qui installe ce lot.
--
-- Portée VOLONTAIREMENT agrégée : cette garde ne renvoie/n'affiche
-- JAMAIS de nom de produit, d'identifiant de restaurant/catégorie ni
-- aucune autre donnée métier -- seul le NOMBRE de groupes en conflit
-- apparaît dans le message d'exception (mandat : "must NOT expose
-- unnecessary customer or merchant data"). L'inspection détaillée
-- (identifiants des lignes concernées, pour décision CIO) est un
-- artefact SÉPARÉ, jamais exécuté ni inclus par ce fichier -- voir
-- PRODUCT-DUPLICATE-PREFLIGHT.md / PRODUCTION-REMEDIATION-RUNBOOK.md.
--
-- AUCUNE écriture : ce bloc ne fait que SELECT/COUNT, jamais un
-- UPDATE/DELETE/ARCHIVE -- vérifié par les tests SQL 9/10/11/12
-- (aucune ligne de menu_items modifiée, aucun archivage, aucune
-- suppression, que la garde passe ou échoue).
-- ------------------------------------------------------------------
do $$
declare
  v_duplicate_group_count integer;
begin
  select count(*) into v_duplicate_group_count
  from (
    select 1
    from public.menu_items
    where archived_at is null
    group by category_id, lower(btrim(name, E' \t\n\r\f' || chr(11)))
    having count(*) > 1
  ) dup_groups;

  if v_duplicate_group_count > 0 then
    raise exception 'SCANYM_PRODUCT_UNIQUENESS_PREFLIGHT_FAILED: % groupe(s) de produits actifs en doublon sous la future clé d''unicité (category_id + nom normalisé) -- remédiation de données catalogue requise AVANT installation de cette migration (voir PRODUCTION-REMEDIATION-RUNBOOK.md). Aucune ligne n''a été modifiée par cette vérification.', v_duplicate_group_count
      using errcode = 'P0001';
  end if;
end $$;

create unique index if not exists idx_menu_items_unique_active_name
  on public.menu_items (category_id, lower(btrim(name, E' \t\n\r\f' || chr(11))))
  where archived_at is null;

-- ------------------------------------------------------------------
-- 4. create_product -- CREATE OR REPLACE (signature inchangée,
--    préserve l'OID et les GRANT existants). Corps repris À
--    L'IDENTIQUE de DRAFT-lot-catalogue-operator-authorization-v1.sql
--    (autorisation propriétaire/gérant + bypass opérateur Scanym déjà
--    en place, validations, ordre de précédence des erreurs, gestion
--    sous-catégorie) -- SEUL changement : l'INSERT est enveloppé dans
--    un bloc begin/exception qui traduit une violation d'unicité
--    (23505, désormais possible grâce à l'index ci-dessus) en une
--    erreur applicative stable SCANYM_PRODUCT_DUPLICATE_NAME, exact
--    même patron que create_category et create_subcategory.
-- ------------------------------------------------------------------
create or replace function public.create_product(
  p_category_id             uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null
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
  v_subcategory_category_id uuid;
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
  ) and not public.is_scanym_operator() then
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

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from p_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  begin
    insert into public.menu_items (
      category_id, name, description, short_description, price, display_order,
      tax_rate, unit_weight_grams, weight_is_approximate, subcategory_id
    )
    values (
      p_category_id, v_name, v_description, v_short_description, round(p_price, 2), v_order,
      p_tax_rate, p_unit_weight_grams, p_weight_is_approximate, p_subcategory_id
    )
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SCANYM_PRODUCT_DUPLICATE_NAME' using errcode = '23505';
  end;

  return v_id;
end $$;

-- ------------------------------------------------------------------
-- 5. Droits -- AUCUN changement. create_product conserve exactement
--    les mêmes GRANT (CREATE OR REPLACE préserve l'OID de la
--    fonction) ; aucune nouvelle fonction, aucun nouveau GRANT/REVOKE
--    requis par ce lot.
-- ------------------------------------------------------------------

-- ============================================================
-- IDEMPOTENCE DE CE FICHIER
--
-- "create unique index if not exists" -- ré-exécutable sans erreur si
-- l'index existe déjà. "create or replace function" -- ré-exécutable
-- sans erreur, remplace le corps sans changer l'OID. Rejouable
-- plusieurs fois sans effet de bord, comme tous les lots de ce dépôt.
-- ============================================================
