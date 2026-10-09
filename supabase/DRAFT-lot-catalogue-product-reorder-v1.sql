-- ============================================================
-- Scanym — CATALOGUE PRODUCT REORDER v1
-- (mandat VIVALDI « LOT: CATALOGUE PRODUCT REORDER v1 »)
-- DEVELOPMENT ONLY -- ce fichier est un DRAFT. Il N'A PAS ÉTÉ EXÉCUTÉ
-- sur une base hébergée par ce lot et ne doit l'être qu'après audit
-- indépendant et décision explicite.
--
-- Baseline requis : 412dbb53c5f180983860852b79425209c04b9c42 (main).
--
-- ------------------------------------------------------------------
-- OBJECTIF
-- ------------------------------------------------------------------
-- Permettre au marchand de réordonner ses produits avec deux gestes
-- simples (Monter / Descendre), l'ordre obtenu étant PERSISTÉ et
-- repris tel quel par la carte client.
--
-- Ce lot change un ORDRE, jamais une TAXONOMIE : la fonction ajoutée
-- n'écrit QUE menu_items.display_order. Elle n'écrit jamais
-- category_id ni subcategory_id -- un produit ne peut donc pas
-- changer de catégorie ou de sous-catégorie par ce chemin.
--
-- ------------------------------------------------------------------
-- ANALYSE PRÉALABLE (mandat « Inspect current product/order columns
-- first. Reuse an existing order field if semantically correct. »)
-- ------------------------------------------------------------------
--   - menu_items.display_order (integer NOT NULL DEFAULT 0) existe
--     depuis schema.sql. C'est DÉJÀ le champ d'ordre lu par la carte
--     client : lib/services/restaurant.ts trie chaque catégorie avec
--     compareMenuItemsForPublicDisplay (lib/catalogue-subcategory-
--     grouping.ts), c'est-à-dire, à l'intérieur d'un même groupe
--     (produits directs de la catégorie, ou UNE sous-catégorie) :
--     display_order, puis nom normalisé, puis id.
--   - Ce champ est donc sémantiquement EXACT pour ce lot et il est
--     RÉUTILISÉ. Aucune colonne, aucune table, aucun index, aucune
--     contrainte n'est ajouté. Aucun ordre flottant/fractionnaire.
--   - create_product attribue max(display_order de la catégorie) + 1
--     (un nouveau produit arrive donc en fin de groupe) ; l'import
--     catalogue crée via create_product dans l'ordre du fichier et ne
--     modifie JAMAIS display_order d'un produit existant
--     (update_product ne l'écrit pas). Rien de cela n'est modifié.
--   - set_product_order(uuid, integer) (V67b), champ numérique libre
--     du back-office, écrit UNE ligne sans verrou de périmètre et
--     peut créer des ex æquo. Elle est CONSERVÉE À L'IDENTIQUE
--     (aucune redéfinition) : les ex æquo restent départagés de façon
--     déterministe par la carte client (nom normalisé, puis id).
--
-- ------------------------------------------------------------------
-- MODÈLE D'ORDRE RETENU
-- ------------------------------------------------------------------
-- PÉRIMÈTRE d'un produit (mandat « FUNCTIONAL RULE ») :
--   1. subcategory_id non nul  -> les produits NON ARCHIVÉS de CETTE
--      sous-catégorie ;
--   2. subcategory_id nul      -> les produits NON ARCHIVÉS rattachés
--      DIRECTEMENT à sa catégorie (subcategory_id nul).
-- C'est exactement le groupe que la carte client affiche d'un bloc.
--
-- Un déplacement échange le produit avec son voisin immédiat dans ce
-- périmètre, puis RENUMÉROTE le périmètre en positions entières
-- DENSES et DISTINCTES 1..N. Seules les lignes dont la valeur change
-- sont écrites (2 lignes pour un périmètre déjà dense).
--
-- ------------------------------------------------------------------
-- RÉTROCOMPATIBILITÉ -- « MATÉRIALISATION AU PREMIER USAGE »
-- ------------------------------------------------------------------
-- Ce lot n'exécute AUCUN backfill, AUCUN UPDATE de données, AUCUNE
-- renumérotation à l'installation (vérifié par empreinte avant/après
-- en section 3). Un marchand qui n'utilise jamais Monter/Descendre
-- garde donc, bit pour bit, ses display_order actuels et donc son
-- ordre actuel.
--
-- Un catalogue historique peut porter des EX ÆQUO (plusieurs produits
-- au même display_order, typiquement 0). L'ordre RÉELLEMENT affiché
-- au client est alors celui du départage JavaScript de la carte
-- client. Plutôt que de faire recalculer ce départage par SQL (dont
-- la collation et lower() ne sont pas garantis identiques à
-- JavaScript sur tous les caractères), l'appelant transmet l'ordre
-- qu'il AFFICHE (p_expected_order), calculé par le MÊME comparateur
-- que la carte client, et le serveur le VALIDE contre l'état stocké :
--   - même ensemble exact que le périmètre non archivé courant ;
--   - display_order stocké NON DÉCROISSANT le long de cet ordre.
-- Autrement dit : le serveur n'accepte de l'appelant que le choix de
-- l'ordre entre EX ÆQUO ; partout où les valeurs stockées sont
-- distinctes, c'est l'état stocké qui fait autorité. Au premier
-- déplacement, le groupe est matérialisé dans l'ordre exact que le
-- client voyait déjà, plus le seul échange demandé -- aucun autre
-- produit ne change de position relative.
--
-- ------------------------------------------------------------------
-- STRATÉGIE DE CONCURRENCE
-- ------------------------------------------------------------------
--   1. pg_advisory_xact_lock(hashtextextended(restaurant_id, 2701)) :
--      les déplacements d'un même établissement sont SÉRIALISÉS (même
--      convention que mutate_merchant_delivery_rule, graine 234 ;
--      graine distincte ici, aucun couplage entre les deux lots).
--   2. FOR NO KEY UPDATE sur le produit puis sur toutes les lignes du
--      périmètre : toute autre écriture sur ces lignes
--      (set_product_order, update_product, archive_product) est
--      sérialisée avec le déplacement. NO KEY : ne bloque jamais le
--      FOR KEY SHARE pris par une commande en cours d'insertion
--      (order_items -> menu_items).
--   3. Contrôle optimiste : p_expected_order est validé APRÈS prise
--      des verrous. Une vue périmée (autre onglet, autre utilisateur,
--      produit créé/archivé/déplacé entre-temps) est REFUSÉE par
--      SCANYM_PRODUCT_ORDER_STALE (P0001, même code SQLSTATE que le
--      précédent STALE_CONTEXT du dépôt) : aucune écriture, le client
--      recharge. Deux déplacements concurrents ne peuvent donc ni se
--      perdre silencieusement, ni produire de positions dupliquées :
--      le résultat de chaque déplacement accepté est toujours 1..N.
--
-- ------------------------------------------------------------------
-- MULTI-TENANT
-- ------------------------------------------------------------------
-- Le tenant est DÉRIVÉ du produit ciblé par assert_product_role
-- (owner/manager de l'établissement, ou opérateur Scanym selon la
-- version installée -- jamais staff), jamais fourni par l'appelant.
-- Tout identifiant de p_expected_order qui n'appartient pas au
-- périmètre du produit ciblé fait échouer l'appel : un identifiant
-- d'un autre établissement ne peut ni être lu, ni être écrit.
--
-- ------------------------------------------------------------------
-- CE QUE CE LOT NE FAIT PAS
-- ------------------------------------------------------------------
--   - aucun ALTER TABLE, aucune colonne, aucun index, aucun trigger ;
--   - aucune donnée modifiée à l'installation (aucun backfill) ;
--   - aucune redéfinition de set_product_order, get_merchant_catalogue,
--     create_product, update_product, create_order ;
--   - aucun changement d'ordre des catégories ou des sous-catégories ;
--   - aucun changement de disponibilité ni de modes de vente.
--
-- ATOMICITÉ : transaction unique. Le contrôle de dérive est la
-- PREMIÈRE instruction À L'INTÉRIEUR de la transaction (et non avant
-- `begin;`) : un échec avorte tout et le `commit;` final agit comme
-- un ROLLBACK, indépendamment de tout drapeau client (ON_ERROR_STOP).
-- ============================================================

begin;

-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE (lecture seule).
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_fn    record;
begin
  -- 0a. Garde anti-double-application : aucune fonction de ce nom,
  --     quelle que soit sa signature.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'move_product_order'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.move_product_order existe déjà -- CATALOGUE PRODUCT REORDER v1 déjà appliqué ou conflit, annulé (aucune modification).';
  end if;

  -- 0b. Colonnes dont dépend la fonction, avec leur type exact.
  select count(*) into v_count
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'menu_items'
    and (
      (c.column_name = 'display_order'  and c.data_type = 'integer' and c.is_nullable = 'NO')
      or (c.column_name = 'category_id'    and c.data_type = 'uuid'    and c.is_nullable = 'NO')
      or (c.column_name = 'subcategory_id' and c.data_type = 'uuid'    and c.is_nullable = 'YES')
      or (c.column_name = 'archived_at'    and c.data_type = 'timestamp with time zone' and c.is_nullable = 'YES')
    );
  if v_count <> 4 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items.(display_order integer NOT NULL, category_id uuid NOT NULL, subcategory_id uuid NULL, archived_at timestamptz NULL) attendues, % trouvée(s) conforme(s) -- CATALOGUE PRODUCT REORDER v1 annulé.',
      v_count;
  end if;

  if to_regclass('public.menu_subcategories') is null
     or to_regclass('public.menu_categories') is null
     or to_regclass('public.restaurant_users') is null then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_subcategories / menu_categories / restaurant_users introuvable -- CATALOGUE PRODUCT REORDER v1 annulé.';
  end if;

  -- 0c. Fonction d'autorisation réutilisée : signature exacte, une
  --     seule surcharge, SECURITY DEFINER, search_path vide,
  --     propriétaire attendu.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_product_role';
  if v_count <> 1 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: % surcharge(s) de assert_product_role, 1 attendue -- CATALOGUE PRODUCT REORDER v1 annulé.',
      v_count;
  end if;

  select pg_get_function_identity_arguments(p.oid) as args,
         pg_get_function_result(p.oid)             as result,
         pg_get_userbyid(p.proowner)               as owner,
         p.prosecdef                               as secdef,
         p.proconfig                               as config
    into v_fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_product_role';

  if v_fn.args is distinct from 'p_product_id uuid, p_roles text[]'
     or v_fn.result is distinct from 'uuid' then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature inattendue de assert_product_role (% -> %) -- CATALOGUE PRODUCT REORDER v1 annulé.',
      v_fn.args, v_fn.result;
  end if;
  if v_fn.secdef is not true
     or v_fn.owner is distinct from 'postgres'
     or v_fn.config is null
     or not exists (select 1 from unnest(v_fn.config) as cfg where cfg = 'search_path=""') then
    raise exception
      'SCANYM_SCHEMA_DRIFT: assert_product_role n''est pas postgres / SECURITY DEFINER / search_path = '''' comme attendu -- CATALOGUE PRODUCT REORDER v1 annulé.';
  end if;

  -- 0d. Le chemin numérique historique doit être présent : ce lot
  --     cohabite avec lui et ne le redéfinit pas.
  if to_regprocedure('public.set_product_order(uuid, integer)') is null then
    raise exception
      'SCANYM_SCHEMA_DRIFT: set_product_order(uuid, integer) introuvable (V67b) -- CATALOGUE PRODUCT REORDER v1 annulé.';
  end if;

  -- 0e. Toute écriture catalogue passe par des RPC SECURITY DEFINER :
  --     RLS active, aucun droit d'écriture direct anon/authenticated.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.menu_items'::regclass) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: RLS désactivée sur public.menu_items -- CATALOGUE PRODUCT REORDER v1 annulé.';
  end if;
  if has_table_privilege('anon', 'public.menu_items', 'INSERT')
     or has_table_privilege('anon', 'public.menu_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.menu_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_items', 'UPDATE') then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items porte un droit INSERT/UPDATE direct pour anon/authenticated (attendu : uniquement via RPC SECURITY DEFINER) -- CATALOGUE PRODUCT REORDER v1 annulé.';
  end if;

  -- 0f. Empreintes AVANT, comparées en section 3 (local à la
  --     transaction) : preuve qu'aucune donnée d'ordre et qu'aucune
  --     fonction préexistante n'est modifiée par ce fichier.
  perform set_config(
    'scanym.cpr1_order_fingerprint',
    (select count(*)::text || ':' || coalesce(md5(string_agg(mi.id::text || '=' || mi.display_order::text, ',' order by mi.id)), 'empty')
     from public.menu_items mi),
    true
  );
  perform set_config(
    'scanym.cpr1_function_fingerprint',
    (select count(*)::text || ':' || coalesce(md5(string_agg(
              p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(p.prosrc),
              ',' order by p.proname, pg_get_function_identity_arguments(p.oid))), 'empty')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'),
    true
  );
end $$;

-- ------------------------------------------------------------------
-- 1. move_product_order -- déplace UN produit d'UNE position dans son
--    périmètre (sous-catégorie, sinon produits directs de la
--    catégorie).
--
--    p_product_id     : produit à déplacer.
--    p_direction      : 'up' (vers le début) ou 'down' (vers la fin).
--    p_expected_order : identifiants de TOUS les produits non
--                       archivés du périmètre, dans l'ordre AFFICHÉ
--                       par l'appelant AVANT le déplacement.
--
--    Retour : nouvelle position du produit (1 = premier).
--
--    Erreurs applicatives (jamais un code SQLSTATE inventé) :
--      28000 Authentication required            (assert_product_role)
--      P0002 Product not found                  (assert_product_role)
--      42501 Not authorized for this product    (assert_product_role)
--      22023 SCANYM_PRODUCT_ORDER_INVALID_DIRECTION
--      P0002 Product not found or archived      (même message que
--                                                set_product_order)
--      P0001 SCANYM_PRODUCT_ORDER_STALE         (vue périmée / liste
--                                                invalide : recharger)
--      22023 SCANYM_PRODUCT_ORDER_BOUNDARY      (premier vers le haut,
--                                                dernier vers le bas)
-- ------------------------------------------------------------------
create function public.move_product_order(
  p_product_id     uuid,
  p_direction      text,
  p_expected_order uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id  uuid;
  v_category_id    uuid;
  v_subcategory_id uuid;
  v_archived_at    timestamptz;
  v_scope_count    integer;
  v_expected_count integer;
  v_distinct_count integer;
  v_matched_count  integer;
  v_out_of_order   boolean;
  v_position       integer;
  v_target         integer;
begin
  -- 1. AUTORISATION -- owner/manager de l'établissement PROPRIÉTAIRE
  --    du produit (ou opérateur Scanym, selon assert_product_role
  --    installée). Jamais staff : réordonner la carte est une décision
  --    de merchandising (même règle que set_product_order, V67b).
  v_restaurant_id := public.assert_product_role(p_product_id, array['owner','manager']);

  if p_direction is null or p_direction not in ('up', 'down') then
    raise exception using errcode = '22023',
      message = 'SCANYM_PRODUCT_ORDER_INVALID_DIRECTION';
  end if;

  -- 2. SÉRIALISATION des déplacements d'un même établissement.
  perform pg_advisory_xact_lock(hashtextextended(v_restaurant_id::text, 2701));

  -- 3. Produit ciblé, verrouillé : son périmètre ne peut plus changer
  --    jusqu'à la fin de la transaction.
  select mi.category_id, mi.subcategory_id, mi.archived_at
    into v_category_id, v_subcategory_id, v_archived_at
  from public.menu_items mi
  where mi.id = p_product_id
  for no key update;

  if not found or v_archived_at is not null then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;

  -- Défense en profondeur : la catégorie relue SOUS VERROU appartient
  -- toujours à l'établissement pour lequel l'appelant a été autorisé.
  if not exists (
    select 1 from public.menu_categories mc
    where mc.id = v_category_id and mc.restaurant_id = v_restaurant_id
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this product';
  end if;

  -- 4. Verrouillage de TOUT le périmètre (ordre de verrouillage
  --    déterministe), puis comptage sur un instantané postérieur.
  perform mi.id
  from public.menu_items mi
  where mi.category_id = v_category_id
    and mi.subcategory_id is not distinct from v_subcategory_id
    and mi.archived_at is null
  order by mi.id
  for no key update;

  select count(*)::integer into v_scope_count
  from public.menu_items mi
  where mi.category_id = v_category_id
    and mi.subcategory_id is not distinct from v_subcategory_id
    and mi.archived_at is null;

  -- Garde de taille, AVANT tout dépliage du tableau reçu : une liste
  -- qui n'a pas exactement la taille du périmètre ne peut pas être la
  -- vue courante (et un tableau démesuré n'est jamais parcouru).
  if coalesce(cardinality(p_expected_order), 0) <> v_scope_count then
    raise exception using errcode = 'P0001',
      message = 'SCANYM_PRODUCT_ORDER_STALE';
  end if;

  -- 5. CONTRÔLE OPTIMISTE de l'ordre affiché par l'appelant.
  --      - aucun élément nul, aucun doublon ;
  --      - chaque élément appartient au périmètre (donc au même
  --        établissement, à la même catégorie, à la même
  --        sous-catégorie, et n'est pas archivé) ;
  --      - même cardinalité que le périmètre => même ENSEMBLE exact ;
  --      - display_order stocké non décroissant le long de la liste :
  --        l'appelant ne choisit que l'ordre entre ex æquo.
  --    La position est lue sur l'ORDINALITÉ (toujours 1..N), jamais
  --    sur les indices du tableau reçu (dont la borne inférieure peut
  --    être arbitraire pour un appel SQL direct).
  select count(*)::integer,
         count(distinct j.id)::integer,
         count(j.display_order)::integer,
         coalesce(bool_or(j.previous_display_order is not null
                          and j.display_order < j.previous_display_order), false),
         (max(j.ord) filter (where j.id = p_product_id))::integer
    into v_expected_count, v_distinct_count, v_matched_count, v_out_of_order, v_position
  from (
    select e.id,
           e.ord,
           mi.display_order,
           lag(mi.display_order) over (order by e.ord) as previous_display_order
    from unnest(p_expected_order) with ordinality as e(id, ord)
    left join public.menu_items mi
      on mi.id = e.id
     and mi.category_id = v_category_id
     and mi.subcategory_id is not distinct from v_subcategory_id
     and mi.archived_at is null
  ) j;

  if v_expected_count = 0
     or v_expected_count <> v_scope_count
     or v_distinct_count <> v_expected_count
     or v_matched_count <> v_expected_count
     or v_out_of_order
     or v_position is null then
    raise exception using errcode = 'P0001',
      message = 'SCANYM_PRODUCT_ORDER_STALE';
  end if;

  -- 6. BORNES -- le premier ne monte pas, le dernier ne descend pas.
  if p_direction = 'up' then
    if v_position <= 1 then
      raise exception using errcode = '22023',
        message = 'SCANYM_PRODUCT_ORDER_BOUNDARY';
    end if;
    v_target := v_position - 1;
  else
    if v_position >= v_expected_count then
      raise exception using errcode = '22023',
        message = 'SCANYM_PRODUCT_ORDER_BOUNDARY';
    end if;
    v_target := v_position + 1;
  end if;

  -- 7. ÉCRITURE -- échange des deux voisins, périmètre renuméroté en
  --    positions denses 1..N. SEULE colonne écrite : display_order.
  --    Seules les lignes dont la valeur change sont touchées.
  update public.menu_items mi
  set display_order = n.new_display_order
  from (
    select e.id,
           (case when e.ord = v_position then v_target
                 when e.ord = v_target   then v_position
                 else e.ord
            end)::integer as new_display_order
    from unnest(p_expected_order) with ordinality as e(id, ord)
  ) n
  where mi.id = n.id
    and mi.category_id = v_category_id
    and mi.subcategory_id is not distinct from v_subcategory_id
    and mi.archived_at is null
    and mi.display_order is distinct from n.new_display_order;

  return v_target;
end $$;

comment on function public.move_product_order(uuid, text, uuid[]) is
  'CATALOGUE PRODUCT REORDER v1 -- déplace un produit d''UNE position (up/down) dans son périmètre (sa sous-catégorie, sinon les produits directs de sa catégorie) et renumérote ce périmètre en positions denses 1..N. N''écrit QUE menu_items.display_order (jamais category_id/subcategory_id). owner/manager (ou opérateur via assert_product_role), jamais staff. p_expected_order = ordre affiché par l''appelant avant le déplacement, validé sous verrou : toute vue périmée est refusée (SCANYM_PRODUCT_ORDER_STALE).';

-- ------------------------------------------------------------------
-- 2. DROITS -- contrat BACK-OFFICE authentifié uniquement.
-- ------------------------------------------------------------------
revoke all on function public.move_product_order(uuid, text, uuid[]) from public, anon, service_role;
grant execute on function public.move_product_order(uuid, text, uuid[]) to authenticated;

-- ------------------------------------------------------------------
-- 3. VÉRIFICATION POST-APPLICATION -- toujours AVANT commit ; un
--    échec avorte la transaction (aucune modification conservée).
-- ------------------------------------------------------------------
do $$
declare
  v_fn       record;
  v_def      text;
  v_expected text;
  v_actual   text;
begin
  -- 3a. La fonction existe, avec la signature, le type de retour et
  --     les attributs de sécurité attendus.
  select pg_get_function_result(p.oid)   as result,
         pg_get_userbyid(p.proowner)     as owner,
         p.prosecdef                     as secdef,
         p.provolatile                   as volatility,
         p.proconfig                     as config,
         pg_get_functiondef(p.oid)       as def
    into v_fn
  from pg_proc p
  where p.oid = to_regprocedure('public.move_product_order(uuid, text, uuid[])');

  if not found then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: public.move_product_order(uuid, text, uuid[]) absente.';
  end if;
  if v_fn.result is distinct from 'integer'
     or v_fn.secdef is not true
     or v_fn.volatility is distinct from 'v'
     or v_fn.owner is distinct from 'postgres'
     or v_fn.config is null
     or not exists (select 1 from unnest(v_fn.config) as cfg where cfg = 'search_path=""') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order n''est pas integer / VOLATILE / postgres / SECURITY DEFINER / search_path = '''' comme attendu.';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'move_product_order') <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: surcharge inattendue de move_product_order.';
  end if;

  -- 3b. Garde tenant, verrou de sérialisation, verrou de périmètre et
  --     contrôle optimiste présents dans le corps installé.
  v_def := v_fn.def;
  if v_def not like '%public.assert_product_role(p_product_id, array[''owner'',''manager''])%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order sans garde assert_product_role owner/manager.';
  end if;
  if v_def ilike '%''staff''%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order ne doit jamais autoriser staff.';
  end if;
  if v_def not like '%pg_advisory_xact_lock(hashtextextended(v_restaurant_id::text, 2701))%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order sans verrou transactionnel d''établissement.';
  end if;
  if v_def not ilike '%for no key update%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order sans verrouillage des lignes du périmètre.';
  end if;
  if v_def not like '%SCANYM_PRODUCT_ORDER_STALE%' or v_def not like '%SCANYM_PRODUCT_ORDER_BOUNDARY%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order sans contrôle optimiste ou sans bornes.';
  end if;

  -- 3c. ORDRE, PAS TAXONOMIE : le corps installé contient UNE seule
  --     écriture, sur menu_items, dont la clause SET n'affecte que
  --     display_order ; aucun INSERT, aucun DELETE.
  if (select count(*) from regexp_matches(v_def, '\mupdate\s+public\.', 'gi')) <> 1
     or v_def !~* '\mupdate\s+public\.menu_items\s+mi\s+set\s+display_order\s*=\s*n\.new_display_order\s+from\M'
     or v_def ~* '\m(insert\s+into|delete\s+from|truncate)\M' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: move_product_order écrit autre chose que menu_items.display_order -- interdit.';
  end if;

  -- 3d. Droits effectifs : authenticated seulement.
  if has_function_privilege('anon', 'public.move_product_order(uuid, text, uuid[])', 'EXECUTE')
     or has_function_privilege('service_role', 'public.move_product_order(uuid, text, uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.move_product_order(uuid, text, uuid[])', 'EXECUTE')
     or exists (
       select 1
       from pg_proc p, aclexplode(p.proacl) a
       where p.oid = to_regprocedure('public.move_product_order(uuid, text, uuid[])')
         and a.grantee = 0 and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: droits EXECUTE inattendus sur move_product_order (attendu : authenticated uniquement).';
  end if;

  -- 3e. AUCUN BACKFILL : l'empreinte (id, display_order) de TOUS les
  --     produits est identique à celle relevée en section 0.
  v_expected := current_setting('scanym.cpr1_order_fingerprint', true);
  select count(*)::text || ':' || coalesce(md5(string_agg(mi.id::text || '=' || mi.display_order::text, ',' order by mi.id)), 'empty')
    into v_actual
  from public.menu_items mi;
  if v_expected is null or v_expected = '' or v_actual is distinct from v_expected then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_items.display_order a changé pendant l''installation (% -> %) -- ce lot ne doit modifier aucune donnée.',
      v_expected, v_actual;
  end if;

  -- 3f. AUCUNE fonction préexistante modifiée ou supprimée : hors la
  --     fonction ajoutée, l'empreinte de toutes les fonctions du
  --     schéma public (nom, signature, corps) est inchangée.
  v_expected := current_setting('scanym.cpr1_function_fingerprint', true);
  select count(*)::text || ':' || coalesce(md5(string_agg(
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(p.prosrc),
           ',' order by p.proname, pg_get_function_identity_arguments(p.oid))), 'empty')
    into v_actual
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname <> 'move_product_order';
  if v_expected is null or v_expected = '' or v_actual is distinct from v_expected then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une fonction préexistante du schéma public a été modifiée ou supprimée par ce fichier (% -> %).',
      v_expected, v_actual;
  end if;
end $$;

commit;

-- ============================================================
-- IDEMPOTENCE DE CE FICHIER
--
-- DRAFT, jamais installé automatiquement. `create function` (et non
-- `create or replace`) : une seconde application est REFUSÉE par la
-- section 0a (SCANYM_SCHEMA_DRIFT), sans rien modifier -- même
-- convention que les lots additifs précédents de ce dépôt.
--
-- ROLLBACK : DRAFT-lot-catalogue-product-reorder-v1-ROLLBACK.sql
-- (retire la fonction ; les display_order déjà écrits par les
-- marchands restent valides et continuent d'être honorés par la carte
-- client, dont le contrat d'ordre est inchangé).
--
-- FIN — CATALOGUE PRODUCT REORDER v1
-- ============================================================
