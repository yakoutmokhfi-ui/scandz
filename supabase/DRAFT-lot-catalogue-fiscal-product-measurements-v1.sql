-- ============================================================
-- Scanym — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3
-- SIMPLIFIED FIXED-PRICE PORTION MODEL — WEIGHT = INFORMATIONAL ONLY
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis : a2f93da3851f48200dd839aeef9dc299538a2a7b
-- (main, incluant CUSTOMER TRACKING EXPERIENCE v2.1, déjà mergé).
--
-- HISTORIQUE -- v1.3 (ce fichier) corrige un blocage identifié par
-- l'audit Work indépendant de v1.2 :
--   FAIL — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.2 —
--   NOT READY FOR CIO GO
-- Constat bloquant (CAT-FISCAL-V12-RPC-ERROR-PRECEDENCE-01, MEDIUM) :
-- v1.2 avait correctement restauré la normalisation btrim et la
-- validation-sur-valeur-normalisée pour name/description/
-- short_description (fermeture de CAT-FISCAL-V11-RPC-NONREGRESSION-01),
-- mais avait placé la validation de p_price APRÈS la validation de
-- description/short_description, alors que la baseline
-- (migration-v66-categories-descriptions.sql) la place ENTRE le nom et
-- la description. Conséquence observable : avec plusieurs entrées
-- invalides simultanément (ex. prix négatif ET description trop
-- longue), le PREMIER code/message d'erreur renvoyé différait de la
-- baseline (22001/SCANYM_DESCRIPTION_TOO_LONG au lieu de 22023/
-- Invalid price) -- une régression de sémantique d'erreur RPC, pas
-- seulement d'ordre de calcul. v1.3 restaure l'ordre EXACT de la
-- baseline dans create_product (name -> price -> description ->
-- short_description), sans jamais toucher au fait que chaque champ
-- est normalisé AVANT sa propre validation de longueur (cette partie
-- restait correcte en v1.2 et n'a pas été touchée). update_product
-- suivait déjà l'ordre baseline exact (name -> description ->
-- short_description -> price) et n'a PAS été modifié (mandat v1.3
-- §6 -- comparaison directe faite, aucune régression trouvée). Voir
-- reports/03-RPC-ERROR-PRECEDENCE-MATRIX-REPORT.txt pour la matrice de
-- précédence complète, dérivée ligne par ligne de la baseline.
-- Constat non-bloquant fermé en même temps (CAT-FISCAL-V12-REPORT-
-- REF-01, LOW) : références de rapport erronées dans les commentaires
-- de ce fichier, corrigées ci-dessous -- voir
-- reports/09-REPORT-REFERENCE-RECONCILIATION-REPORT.txt.
--
-- HISTORIQUE -- v1.2 avait déjà corrigé un blocage identifié par
-- l'audit Work indépendant de v1.1 :
--   FAIL — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 —
--   NOT READY FOR CIO GO
-- Cause racine (CAT-FISCAL-V11-RPC-NONREGRESSION-01) : la réécriture
-- v1.1 de create_product/update_product (nécessaire pour ajouter les
-- 3 paramètres fiscaux) avait reconstruit CES DEUX FONCTIONS de façon
-- trop partielle -- 3 éléments du comportement HISTORIQUE (baseline
-- migration-v66-categories-descriptions.sql, jamais demandés au
-- changement par le mandat fiscal) avaient disparu silencieusement :
--   1. display_order : create_product n'ajoutait plus le nouveau
--      produit en fin de catégorie (coalesce(max(display_order),0)+1)
--      -- retombait sur le défaut de colonne (0) pour CHAQUE nouveau
--      produit.
--   2. Normalisation : `btrim(value, E' \t\n\r\f' || chr(11))`
--      (baseline) remplacé par `trim()` (v1.1, qui ne retire que
--      l'espace ASCII 32 en PostgreSQL) sur name/description/
--      short_description, dans les deux fonctions.
--   3. Ordre de validation : la baseline valide la LONGUEUR sur la
--      valeur NORMALISÉE ; v1.1 validait sur le paramètre BRUT, avant
--      normalisation -- pour description/short_description, dans les
--      deux fonctions.
-- v1.2 a restauré ces 3 comportements À L'IDENTIQUE de la baseline,
-- SANS toucher aux 3 paramètres/validations fiscaux ajoutés par v1.1
-- (mandat v1.2 §4 : modèle `baseline behavior + fiscal extensions`,
-- jamais une nouvelle approximation de la baseline) -- CE PRINCIPE
-- RESTE LE MODÈLE DIRECTEUR DE v1.3. Voir la section 3 (create_product)
-- et la section 4 (update_product) ci-dessous pour le détail précis de
-- chaque restauration, et
-- reports/02-BASELINE-V66-V12-V13-RECONCILIATION-REPORT.txt pour la
-- classification sémantique ligne par ligne (BASELINE PRESERVED /
-- FISCAL EXTENSION / V1.1 REGRESSION RESTORED / V1.2 PRECEDENCE
-- RESTORED), couvrant baseline V66, v1.2 et v1.3.
--
-- Les 4 constats CAT-FISCAL-01 à 04 (fermés par v1.1) NE SONT PAS
-- rouverts ni reconçus par ce lot -- voir reports/07-FISCAL-INVARIANTS-
-- REPORT.txt pour la preuve de non-régression des capacités fiscales.
--
-- HISTORIQUE -- v1 (jamais poussée/mergée, jamais appliquée nulle
-- part) a été REJETÉE par l'audit Work indépendant :
--   FAIL — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1 —
--   NOT READY FOR CIO GO
-- Cause racine (CAT-FISCAL-01) : v1 introduisait un second mode de
-- prix `price_mode = 'price_per_weight'`, annoncé comme l'autorité
-- (prix/kg × poids), alors que create_order (INCHANGÉE, protégée par
-- l'isolation paiement) calcule TOUJOURS
-- `menu_items.price × quantity` -- un produit "au poids" pouvait donc
-- être AFFICHÉ à un prix, et FACTURÉ à un autre. v1 n'ayant jamais été
-- déployée nulle part (aucun push, aucun merge), ce fichier REMPLACE
-- intégralement sa conception plutôt que de préserver une abstraction
-- désormais reconnue incorrecte pour le besoin produit réel (mandat
-- v1.1 §17, "feel free to replace its design cleanly").
--
-- DÉCISION PRODUIT v1.1 (mandat §2) -- SCANYM v1 NE SUPPORTE PAS la
-- tarification au poids variable. Tout produit commandable a :
--   - un prix de vente FIXE par produit/portion (`menu_items.price`,
--     colonne EXISTANTE, INCHANGÉE -- toujours l'autorité unique).
--   - une quantité ENTIÈRE choisie par le client (jamais des grammes).
-- Le poids n'est JAMAIS une autorité financière -- uniquement une
-- information catalogue/logistique. Exemple canonique (mandat §2/§26) :
--   Portion de raclette : prix fixe 7.50 €, poids de portion 200 g.
--   Client commande quantité 2.
--   Montant de commande : 2 × 7.50 = 15.00 € (INCHANGÉ, create_order).
--   Poids logistique estimé (informatif) : 2 × 200 g = 400 g.
--   Le client ne saisit JAMAIS "400 g" comme quantité de commande.
--
-- PÉRIMÈTRE (mandat v1.1 §3-§16) :
--   1. Contrôle préalable de non-dérive du schéma (lecture seule),
--      même patron que migration-v66/v81 : signatures RPC EXACTES
--      actuelles (5 paramètres, jamais modifiées par une v1 qui n'a
--      jamais été appliquée), colonnes fiscales/mesure ABSENTES
--      (garde anti-double-application).
--   2. Transaction unique.
--   3. Ajout additif de SEULEMENT 4 colonnes menu_items (tax_rate,
--      unit_weight_grams, weight_is_approximate,
--      reference_price_per_kg) + contraintes CHECK simples -- AUCUNE
--      matrice de combinaison (mandat §22, "do not create an
--      unnecessarily complex state matrix" -- il n'y a plus d'états
--      interdépendants à valider, chaque champ est indépendant).
--   4. create_product / update_product : nouvelle signature (mêmes
--      paramètres existants + 3 nouveaux -- reference_price_per_kg
--      n'est JAMAIS un paramètre, colonne GÉNÉRÉE, voir section 1),
--      suppression+recréation de la signature exacte (patron V66).
--   5. get_merchant_catalogue : même signature (uuid, boolean),
--      `returns table` étendu aux 4 nouvelles colonnes.
--   6. Réaffirmation des droits (authenticated uniquement, jamais
--      anon/public) sur les 3 fonctions modifiées.
--   7. Vérification post-migration déplacée AVANT `commit;` (corrige
--      CAT-FISCAL-03 -- voir section 6 : un échec de vérification
--      provoque désormais un ROLLBACK automatique de la transaction,
--      plus jamais un état commité-mais-invalide).
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT (mandat v1.1 §12/§13/§24 -- isolation
-- paiement stricte, PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.1
-- travaille en parallèle) :
--   - create_order N'EST PAS MODIFIÉE PAR CE FICHIER. Aucune colonne
--     order_items n'est ajoutée. Aucun calcul pondéré n'existe nulle
--     part dans ce lot (v1.1 supprime `price_per_weight`, donc le
--     chevauchement create_order de v1 n'a même plus de raison
--     d'exister -- voir reports/07-FISCAL-INVARIANTS-REPORT.txt, section
--     "non-régression create_order", pour la preuve).
--   - Aucune table/colonne payment_* touchée.
--   - orders.subtotal/total/currency inchangés.
--
-- MODÈLE v1.1 (mandat §3-§7, décisions explicites documentées) :
--   - tax_rate numeric(5,2), NULLABLE : taux de TVA du produit, 0-100,
--     générique -- AUCUNE valeur française codée en dur. NULL =
--     aucune TVA renseignée (rétrocompatible, produits existants).
--   - unit_weight_grams integer, NULLABLE, positif : poids
--     estimé/nominal d'UN produit/portion, en grammes ENTIERS (jamais
--     un kg décimal flottant -- écarte toute imprécision binaire sur
--     la donnée elle-même). NULL = poids non pertinent pour ce
--     produit (mandat §4, "nullable for products where it is not
--     relevant").
--   - weight_is_approximate boolean, NOT NULL DEFAULT false :
--     indicateur PUREMENT informatif (mandat §5, "This flag is
--     informational only. It must NOT affect price calculation.") --
--     jamais lu par aucun calcul de prix.
--   - reference_price_per_kg numeric(10,2), colonne GÉNÉRÉE (jamais
--     stockée manuellement, jamais un paramètre RPC) : dérivée
--     automatiquement de price/unit_weight_grams (mandat §6, "Prefer
--     deriving it where possible... Do not create a second financial
--     pricing engine"). NULL si unit_weight_grams est NULL ou <= 0.
--     Recalculée automatiquement par PostgreSQL à chaque UPDATE de la
--     ligne (price OU unit_weight_grams) -- ne peut structurellement
--     JAMAIS diverger de price/unit_weight_grams, donc ne peut jamais
--     devenir une seconde autorité de prix.
--
-- CE QUI A ÉTÉ SUPPRIMÉ PAR RAPPORT À v1 (mandat §16) : sales_unit,
-- price_mode, weight_mode, fixed_weight_grams, indicative_weight_grams,
-- price_per_weight_rate, la contrainte de combinaison
-- menu_items_fiscal_measurement_combination_chk. Tous les produits
-- Scanym v1.1 sont vendus "à la pièce/portion" par construction (un
-- fromage à la coupe de 200 g reste vendu comme UNE portion, avec
-- unit_weight_grams=200 pour information, jamais comme une quantité
-- de kilogrammes saisie par le client -- mandat §15).
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction -- si ce bloc échoue, rien n'a encore été
--    touché). Même patron que migration-v66/v81. Les signatures
--    attendues sont les signatures ORIGINALES (5 paramètres) : v1
--    n'ayant jamais été appliquée nulle part, la baseline réelle n'a
--    jamais été modifiée par elle.
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_fn record;
begin
  -- 0a. Signatures RPC EXACTES actuelles (5 paramètres, V66).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte create_product(uuid,text,text,numeric,text) introuvable -- CATALOGUE FISCAL v1.3 annulé, aucune modification appliquée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_product_id uuid, p_name text, p_description text, p_price numeric, p_short_description text'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte update_product(uuid,text,text,numeric,text) introuvable -- CATALOGUE FISCAL v1.3 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte get_merchant_catalogue(uuid,boolean) introuvable -- CATALOGUE FISCAL v1.3 annulé.';
  end if;

  -- 0b. Aucune surcharge inattendue de ces trois noms.
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue');

  if v_count <> 3 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: % fonctions trouvées pour create_product/update_product/get_merchant_catalogue, 3 attendues -- CATALOGUE FISCAL v1.3 annulé.',
      v_count;
  end if;

  -- 0c. Propriétaire, SECURITY DEFINER, search_path des 3 fonctions.
  for v_fn in
    select pg_get_userbyid(p.proowner) as owner, p.proconfig as search_path, p.prosecdef as secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_product', 'update_product', 'get_merchant_catalogue')
  loop
    if v_fn.owner is distinct from 'postgres' then
      raise exception
        'SCANYM_SCHEMA_DRIFT: propriétaire inattendu (%) pour une des 3 fonctions catalogue -- CATALOGUE FISCAL v1.3 annulé.',
        v_fn.owner;
    end if;
    if v_fn.secdef is not true then
      raise exception
        'SCANYM_SCHEMA_DRIFT: une des 3 fonctions catalogue n''est pas SECURITY DEFINER -- CATALOGUE FISCAL v1.3 annulé.';
    end if;
    if v_fn.search_path is null or not exists (
      select 1 from unnest(v_fn.search_path) as cfg where cfg = 'search_path=""'
    ) then
      raise exception
        'SCANYM_SCHEMA_DRIFT: une des 3 fonctions catalogue n''a pas search_path = '''' exactement -- CATALOGUE FISCAL v1.3 annulé.';
    end if;
  end loop;

  -- 0d. Garde anti-double-application : aucune des 4 nouvelles
  -- colonnes ne doit déjà exister sur menu_items.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items'
      and column_name in (
        'tax_rate', 'unit_weight_grams', 'weight_is_approximate', 'reference_price_per_kg'
      )
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: au moins une colonne fiscale/mesure existe déjà sur menu_items -- CATALOGUE FISCAL v1.3 déjà appliqué ou conflit, annulé.';
  end if;

  -- 0e. Droits EFFECTIFS actuels sur menu_items -- confirme qu'aucun
  -- droit d'écriture large n'existe déjà avant cette migration
  -- (mandat §23, ne doit jamais en introduire).
  if has_table_privilege('anon', 'public.menu_items', 'INSERT')
     or has_table_privilege('anon', 'public.menu_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.menu_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_items', 'UPDATE')
  then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items a déjà un droit INSERT/UPDATE direct pour anon/authenticated (attendu : uniquement via RPC SECURITY DEFINER) -- CATALOGUE FISCAL v1.3 annulé.';
  end if;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. COLONNES ADDITIVES -- voir commentaire de tête pour le modèle
--    complet. Toutes rétrocompatibles : les lignes existantes
--    reçoivent NULL/false (mandat §17 -- "no VAT rate may be
--    invented", "no weight may be invented").
-- ------------------------------------------------------------------

alter table public.menu_items
  add column tax_rate numeric(5,2),
  add column unit_weight_grams integer,
  add column weight_is_approximate boolean not null default false,
  add column reference_price_per_kg numeric(10,2)
    generated always as (
      case
        when unit_weight_grams is not null and unit_weight_grams > 0
          then round(price / (unit_weight_grams::numeric / 1000), 2)
        else null
      end
    ) stored;

comment on column public.menu_items.tax_rate is
  'CATALOGUE FISCAL v1.3 -- taux de TVA/taxe du produit, pourcentage 0-100, générique (aucun pays codé en dur). NULL = non renseigné.';
comment on column public.menu_items.unit_weight_grams is
  'CATALOGUE FISCAL v1.3 -- poids estimé/nominal d''UN produit/portion, en grammes entiers. INFORMATIONNEL/LOGISTIQUE UNIQUEMENT (mandat §4/§11) -- ne participe JAMAIS au calcul du prix (menu_items.price reste l''unique autorité, multipliée par la quantité entière commandée dans create_order, inchangée). NULL = poids non pertinent pour ce produit.';
comment on column public.menu_items.weight_is_approximate is
  'CATALOGUE FISCAL v1.3 -- indicateur purement informatif (ex. portion de fromage nominalement ~200 g). N''affecte JAMAIS le calcul du prix.';
comment on column public.menu_items.reference_price_per_kg is
  'CATALOGUE FISCAL v1.3 -- colonne GÉNÉRÉE (price / unit_weight_grams), métadonnée de RÉFÉRENCE pour le commerçant uniquement. Ne peut structurellement jamais diverger de price/unit_weight_grams (recalculée automatiquement par PostgreSQL) -- n''est JAMAIS une autorité de panier, de commande ou de paiement (mandat §6, "Do not create a second financial pricing engine").';

-- ------------------------------------------------------------------
-- 2. CONTRAINTES CHECK -- SIMPLES, indépendantes les unes des autres
--    (mandat §22, "Keep DB constraints simple. Do not create an
--    unnecessarily complex state matrix.") : contrairement à v1, il
--    n'existe plus AUCUN état croisé à valider entre price_mode/
--    weight_mode/sales_unit -- ces trois colonnes ont été supprimées.
--    reference_price_per_kg n'a besoin d'aucune contrainte : c'est une
--    colonne GÉNÉRÉE, sa cohérence avec price/unit_weight_grams est
--    garantie STRUCTURELLEMENT par PostgreSQL, jamais par une règle
--    applicative qui pourrait diverger.
-- ------------------------------------------------------------------

alter table public.menu_items
  add constraint menu_items_tax_rate_range_chk
    check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100));

alter table public.menu_items
  add constraint menu_items_unit_weight_grams_chk
    check (unit_weight_grams is null or unit_weight_grams > 0);

-- ------------------------------------------------------------------
-- 3. create_product -- nouvelle signature (5 -> 8 paramètres : 5
--    existants + tax_rate/unit_weight_grams/weight_is_approximate).
--    reference_price_per_kg N'EST JAMAIS un paramètre -- colonne
--    générée, toute tentative de l'écrire directement échouerait de
--    toute façon au niveau SQL (Postgres l'interdit sur une colonne
--    GENERATED ALWAYS).
--
--    CATALOGUE FISCAL v1.3 -- ferme CAT-FISCAL-V11-RPC-NONREGRESSION-01
--    (audit de travail v1.1 indépendant, FAIL). v1.1 avait reconstruit
--    ce corps de fonction de façon trop partielle : trois éléments du
--    comportement HISTORIQUE (baseline migration-v66) avaient disparu
--    sans jamais avoir été demandés par le mandat fiscal. v1.2 restaure
--    le modèle `baseline behavior + fiscal extensions`, PAS une
--    nouvelle approximation de la baseline (mandat v1.2 §4) :
--      1. `display_order` : la baseline calcule
--         `coalesce(max(mi.display_order), 0) + 1`, scopé à la
--         catégorie, et l'insère explicitement. v1.1 avait omis cette
--         colonne de l'INSERT -- chaque nouveau produit retombait donc
--         sur le défaut de colonne (0), au lieu de s'ajouter en fin de
--         liste. RESTAURÉ ici via `v_order`, IDENTIQUE à la baseline.
--      2. Normalisation : la baseline utilise
--         `btrim(value, E' \t\n\r\f' || chr(11))` (espace, tabulation,
--         LF, CR, form feed, tabulation verticale) pour name/
--         description/short_description. v1.1 utilisait `trim()` seul
--         (qui ne retire QUE l'espace ASCII 32 en PostgreSQL) --
--         RESTAURÉ ici à l'identique de la baseline.
--      3. Ordre de validation : la baseline normalise D'ABORD (stocke
--         le résultat dans une variable locale), PUIS valide la
--         longueur sur cette valeur normalisée. v1.1 validait la
--         longueur sur le paramètre BRUT, avant normalisation --
--         RESTAURÉ ici à l'identique de la baseline (normaliser, puis
--         valider).
--    Les 3 paramètres/validations fiscaux (tax_rate/unit_weight_grams/
--    weight_is_approximate, mandat v1.1 §3-§7) sont des AJOUTS
--    (`FISCAL EXTENSION`) préservés sans changement -- voir le rapport
--    de réconciliation sémantique pour la classification ligne par
--    ligne complète (BASELINE PRESERVED / FISCAL EXTENSION / V1.1
--    REGRESSION RESTORED).
-- ------------------------------------------------------------------

drop function public.create_product(uuid, text, text, numeric, text);

create function public.create_product(
  p_category_id             uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false
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

  -- CATALOGUE FISCAL v1.3 -- normalisation IDENTIQUE à la baseline
  -- (migration-v66-categories-descriptions.sql) : `btrim` sur le jeu
  -- de caractères espace/tabulation/LF/CR/form-feed/tabulation
  -- verticale, PAS le `trim()` à un seul argument de v1.1 (qui ne
  -- retire que l'espace ASCII 32). Validation de longueur EFFECTUÉE
  -- SUR LA VALEUR NORMALISÉE (v_name/v_description/v_short_description),
  -- jamais sur le paramètre brut.
  --
  -- ORDRE DE PRÉCÉDENCE DES ERREURS -- ferme
  -- CAT-FISCAL-V12-RPC-ERROR-PRECEDENCE-01 (audit Work v1.2, FAIL).
  -- v1.2 avait normalisé PUIS validé chaque champ correctement (name,
  -- description, short_description), mais avait déplacé la validation
  -- de p_price APRÈS description/short_description au lieu de sa
  -- position historique -- entre le nom et la description. Ordre
  -- EXACT restauré, identique ligne pour ligne à la baseline : nom
  -- normalisé -> prix -> description normalisée -> short_description
  -- normalisée. La normalisation a toujours lieu AVANT la validation
  -- de longueur du champ correspondant (mandat v1.3 §5/§18) ; seule la
  -- POSITION de la validation du prix, relative à description/
  -- short_description, a été corrigée (mandat v1.3 §4/§7). Voir
  -- reports/03-RPC-ERROR-PRECEDENCE-MATRIX-REPORT.txt pour la matrice
  -- de précédence complète, dérivée de la baseline, pas inventée.
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

  -- Mandat v1.1 §3/§7 -- validation TVA/poids, défense en profondeur
  -- (les CHECK de table restent l'autorité finale, jamais
  -- contournables). AUCUNE validation de combinaison ici : chaque
  -- champ est indépendant, il n'y a plus de matrice d'états (mandat
  -- v1.1 §22). FISCAL EXTENSION -- inchangée par v1.2/v1.3 (évaluée
  -- APRÈS toutes les validations baseline, ordre fiscal historique
  -- préservé).
  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;

  -- CATALOGUE FISCAL v1.3 -- ordre d'affichage IDENTIQUE à la baseline
  -- (V1.1 REGRESSION RESTORED) : chaque nouveau produit s'ajoute
  -- APRÈS le dernier existant DE SA CATÉGORIE, jamais une séquence
  -- globale (mandat v1.2 §5). Catégorie vide -> coalesce(...,0)+1 = 1,
  -- identique à la baseline.
  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  insert into public.menu_items (
    category_id, name, description, short_description, price, display_order,
    tax_rate, unit_weight_grams, weight_is_approximate
  )
  values (
    p_category_id, v_name, v_description, v_short_description, round(p_price, 2), v_order,
    p_tax_rate, p_unit_weight_grams, p_weight_is_approximate
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean) from public, anon;
grant execute on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean) to authenticated;

-- ------------------------------------------------------------------
-- 4. update_product -- même extension, même patron.
--
--    CATALOGUE FISCAL v1.3 -- ferme CAT-FISCAL-V11-RPC-NONREGRESSION-01
--    pour update_product : mêmes 2 régressions que create_product
--    (normalisation `btrim` + ordre validation-après-normalisation),
--    RESTAURÉES à l'identique de la baseline (migration-v66). Pas de
--    régression display_order ici -- la baseline update_product ne
--    touche jamais display_order (ordre géré séparément par
--    set_product_order, V67b, hors périmètre de ce lot).
-- ------------------------------------------------------------------

drop function public.update_product(uuid, text, text, numeric, text);

create function public.update_product(
  p_product_id              uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false
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

  -- CATALOGUE FISCAL v1.3 -- normalisation + ordre de validation
  -- IDENTIQUES à la baseline (V1.1 REGRESSION RESTORED), même patron
  -- que create_product ci-dessus.
  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  -- FISCAL EXTENSION -- inchangée par v1.2.
  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;

  update public.menu_items
  set name                     = v_name,
      description               = v_description,
      price                     = round(p_price, 2),
      short_description         = v_short_description,
      tax_rate                  = p_tax_rate,
      unit_weight_grams         = p_unit_weight_grams,
      weight_is_approximate     = p_weight_is_approximate
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

revoke all on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean) from public, anon;
grant execute on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean) to authenticated;

-- ------------------------------------------------------------------
-- 5. get_merchant_catalogue -- même signature (uuid, boolean),
--    returns table étendu aux 4 nouvelles colonnes.
-- ------------------------------------------------------------------

drop function public.get_merchant_catalogue(uuid, boolean);

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
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  select mi.id, mc.id, mc.name::text, mc.name_hash, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description, mc.description_hash,
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
  left join public.menu_items mi
    on mi.category_id = mc.id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name, mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------
-- 6. VÉRIFICATION AVANT COMMIT (corrige CAT-FISCAL-03 -- v1 exécutait
--    ce contrôle APRÈS `commit;`, rendant un échec de vérification
--    NON rollback-capable : les changements étaient déjà commités. Ce
--    bloc est désormais TOUJOURS exécuté À L'INTÉRIEUR de la
--    transaction, AVANT `commit;` : tout échec ici déclenche un
--    ROLLBACK automatique de l'intégralité de la migration -- aucune
--    modification partielle/invalide ne peut jamais rester commitée.
--    Toutes les vérifications requises pour la réussite de
--    l'installation sont déterministes et se prêtent à ce placement ;
--    AUCUNE vérification post-commit ne subsiste dans ce fichier
--    (rien n'est purement diagnostique ici).
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'menu_items'
    and column_name in (
      'tax_rate', 'unit_weight_grams', 'weight_is_approximate', 'reference_price_per_kg'
    );
  if v_count <> 4 then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: % / 4 colonnes fiscales/mesure trouvées sur menu_items.', v_count;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_category_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean'
  ) then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: nouvelle signature create_product introuvable.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_product'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_product_id uuid, p_name text, p_description text, p_price numeric, p_short_description text, p_tax_rate numeric, p_unit_weight_grams integer, p_weight_is_approximate boolean'
  ) then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: nouvelle signature update_product introuvable.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: get_merchant_catalogue(uuid,boolean) introuvable après recréation.';
  end if;

  if has_function_privilege('anon', 'public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: anon a EXECUTE sur create_product/update_product, jamais attendu.';
  end if;

  if not has_function_privilege('authenticated', 'public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: authenticated n''a pas EXECUTE sur create_product/update_product.';
  end if;

  if has_function_privilege('anon', 'public.get_merchant_catalogue(uuid, boolean)', 'EXECUTE') then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: anon a EXECUTE sur get_merchant_catalogue, jamais attendu.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_merchant_catalogue(uuid, boolean)', 'EXECUTE') then
    raise exception 'SCANYM_PRE_COMMIT_CHECK_FAILED: authenticated n''a pas EXECUTE sur get_merchant_catalogue.';
  end if;
end $$;

commit;
