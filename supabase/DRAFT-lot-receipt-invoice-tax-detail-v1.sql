-- ============================================================
-- Scanym — RECEIPT / INVOICE TAX DETAIL v1.1 — ORDER FISCAL SNAPSHOT
-- FOUNDATION (DRAFT — NON APPLIQUÉ EN PRODUCTION)
-- TARGETED FIX OF v1 WORK AUDIT FINDINGS
--
-- ------------------------------------------------------------
-- HISTORIQUE (mandat v1.1)
-- ------------------------------------------------------------
-- v1 (jamais poussée, jamais mergée, jamais appliquée à Production,
-- package SHA-256 e842e33556d3928af9be0c579c539f0da8ce0bf407165c5c5
-- adcf96037266976) a été REJETÉE par l'audit Work indépendant :
--   FAIL — RECEIPT / INVOICE TAX DETAIL v1 — NOT READY FOR CIO GO
-- Constats bloquants :
--   RITD-V1-NAME-HISTORY-01 (MEDIUM, release-blocking) -- corrigé
--     HORS de ce fichier SQL, dans components/dashboard/OrderCard.tsx
--     (rendu marchand non-français retombait sur une traduction
--     catalogue COURANTE au lieu de l'instantané order_items.item_name/
--     option_name -- voir NAME-HISTORY-FIX-REPORT du package v1.1).
--   RITD-V1-MIGRATION-POSTCHECK-01 (MEDIUM, release-blocking) --
--     corrigé CI-DESSOUS : le postcheck déterministe s'exécutait APRÈS
--     COMMIT (section 4 de v1), si bien qu'un échec de postcheck
--     pouvait laisser les DDL/CREATE OR REPLACE FUNCTION déjà commités
--     alors même que la migration se signalait en échec. Corrigé en
--     déplaçant BEGIN avant le préflight (section 0) et le postcheck
--     (désormais section 4, ci-dessous) AVANT COMMIT -- toute
--     RAISE EXCEPTION, où qu'elle survienne dans ce fichier, annule
--     désormais la TOTALITÉ de la migration (DDL, contraintes,
--     fonction, droits compris), jamais un sous-ensemble commité.
-- Constat non-bloquant :
--   RITD-V1-WEIGHT-OVERFLOW-01 (LOW) -- corrigé CI-DESSOUS :
--     total_weight_grams_snapshot multipliait deux valeurs integer
--     (unit_weight_grams_snapshot * quantity) sans garde de
--     débordement -- aucune des deux colonnes sources ne porte de
--     borne supérieure (seul un CHECK > 0 existe), un produit avec un
--     poids légitimement élevé combiné à une quantité élevée pouvait
--     donc dépasser int4 (2 147 483 647) et faire échouer TOUTE
--     l'insertion de la ligne de commande avec une erreur "integer out
--     of range", y compris pour des valeurs individuellement valides.
--     Corrigé en changeant total_weight_grams_snapshot en bigint et en
--     castant explicitement les deux opérandes en bigint AVANT la
--     multiplication -- aucune limite métier n'étant documentée nulle
--     part dans le dépôt pour un poids de produit, ce lot ne contraint
--     PAS artificiellement les poids légitimes pour rester dans int4.
--
-- v1.1 corrige UNIQUEMENT ces trois constats (le second et le
-- troisième dans ce fichier, le premier dans OrderCard.tsx). Le reste
-- de l'architecture v1 (schéma additif, atomicité create_order,
-- isolation paiement/tracking, ACL/RLS, autorité financière) est
-- INCHANGÉ et considéré sain par l'audit Work -- repris VERBATIM.
-- ------------------------------------------------------------
--
-- OBJET (mandat RECEIPT / INVOICE TAX DETAIL v1) : construire une
-- fondation DURABLE de détail fiscal par ligne de commande, telle
-- qu'une ancienne commande n'est JAMAIS recalculée depuis le catalogue
-- courant. Invariant central (mandat §6, verbatim) :
--   "AN OLD ORDER MUST NEVER BE RECALCULATED FROM THE CURRENT
--   CATALOGUE."
-- Ce lot N'EST PAS une facture légale, ne prétend à AUCUNE conformité
-- légale de facturation, n'invente AUCUNE numérotation de facture,
-- AUCUNE mention légale obligatoire, AUCUNE règle d'identité fiscale
-- marchand/client, AUCUNE règle de facturation électronique ni
-- spécifique à une juridiction (Algérie/France/Belgique). Ce qui
-- manque pour une facture légale est documenté séparément dans le
-- rapport 21-LEGAL-INVOICE-GAP-REPORT.txt (ARCHITECTURE GAP —
-- LEGAL INVOICE ISSUANCE REQUIRES JURISDICTION-SPECIFIC LOT,
-- explicitement NON bloquant pour cette fondation).
--
-- PRÉREQUIS PUBLIÉ : CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3
-- (mergée sur main, commit 5ec5085/2cb4cfd) — ce lot NE redessine PAS
-- v1.3, il consomme uniquement les colonnes déjà publiées de
-- menu_items (tax_rate, unit_weight_grams, weight_is_approximate) au
-- moment de create_order pour en figer une copie ligne-par-ligne.
--
-- RECONNAISSANCE (mandat §5, résumée ici — détail complet dans le
-- rapport 01-ARCHITECTURE-RECONNAISSANCE-REPORT.txt) :
--   - order_items (migration-orders.sql) snapshote DÉJÀ item_name et
--     unit_price depuis menu_items au moment de create_order — c'est
--     le patron existant que ce lot ÉTEND, ne remplace pas.
--   - create_order (actuellement publié par
--     DRAFT-lot-payment-p3b6-checkout-billing-context.sql) charge déjà
--     la ligne menu_items ENTIÈRE dans une variable locale
--     `v_menu_item public.menu_items%rowtype` (select mi.* into
--     v_menu_item ...) AVANT l'INSERT dans order_items — cette
--     variable contient donc DÉJÀ tax_rate/unit_weight_grams/
--     weight_is_approximate (colonnes CATALOGUE FISCAL v1.3, déjà sur
--     main à cette baseline) sans qu'aucune requête SQL
--     supplémentaire ne soit nécessaire.
--   - reference_price_per_kg (colonne GÉNÉRÉE de menu_items) N'EST PAS
--     dupliquée ici : elle est déterministiquement reconstructible
--     depuis unit_price (déjà snapshoté) et
--     unit_weight_grams_snapshot (nouveau, ci-dessous) —
--     round(unit_price / (unit_weight_grams_snapshot::numeric/1000),2)
--     quand unit_weight_grams_snapshot > 0, NULL sinon. Dupliquer son
--     stockage violerait le principe "smallest additive schema"
--     (mandat §26) sans bénéfice d'intégrité historique : elle
--     dérive uniquement de deux valeurs DÉJÀ figées.
--   - AUCUNE colonne tax_category/tax_code/fiscal_label n'existe sur
--     menu_items — rien de tel n'est donc snapshoté (mandat §8 :
--     dériver, ne jamais halluciner un champ absent).
--   - Sémantique d'inclusion de taxe (prix TTC vs HT) : NON explicite
--     dans le modèle actuel. `receipt_settings.prices_include_tax`
--     (migration-v29) est un booléen PAR RESTAURANT, jamais lié à
--     menu_items.tax_rate ni à order_items — ARCHITECTURE GAP — PRICE
--     TAX-INCLUSION SEMANTICS NOT EXPLICIT (mandat §14). Conséquence
--     directe (mandat §15) : ce lot snapshote tax_rate en MÉTADONNÉE
--     SEULE — il NE calcule JAMAIS de décomposition HT/TVA/TTC. Aucun
--     montant de taxe n'est stocké ni dérivé par ce lot.
--   - Politique d'arrondi fiscal : AUCUNE politique explicite
--     n'existe dans le dépôt (aucune fonction/colonne d'arrondi TVA).
--     Conséquence directe (mandat §16) : ce lot ne calcule AUCUN
--     montant de taxe (voir ci-dessus) — la question de l'arrondi ne
--     se pose donc pas pour ce lot ; documentée quand même comme gap
--     dans le rapport 07-TAX-ROUNDING-REPORT.txt pour un futur lot de
--     facturation légale.
--   - Identité fiscale marchand (receipt_settings.legal_name/
--     legal_address/tax_identifier/registration_number, migration-v29)
--     : n'est PAS snapshotée par ce lot. C'est un profil MUTABLE,
--     jamais copié sur orders/order_items aujourd'hui. Reportée comme
--     gap séparé (mandat §20) dans le rapport
--     09-MERCHANT-CUSTOMER-IDENTITY-GAP-REPORT.txt — hors périmètre
--     v1 (pas de duplication aveugle d'un profil complet, mandat §20).
--   - Identité fiscale client : non rendue obligatoire (mandat §21).
--     order_delivery_address (PAYMENT P3-B6, insert-only, jamais
--     modifiée après création) reste la seule extension de contexte
--     de facturation déjà publiée et suffisante — aucune nouvelle
--     collecte n'est ajoutée ici.
--   - Devise : orders.currency est déjà copiée depuis
--     restaurant_configs.currency au moment de create_order, JAMAIS
--     réécrite ensuite — déjà une autorité historique immuable par
--     commande. Aucune colonne devise supplémentaire nécessaire.
--   - Concurrence (mandat §52) : le `select mi.* into v_menu_item`
--     existant COPIE les valeurs scalaires de menu_items dans une
--     variable PL/pgSQL locale au moment de son exécution — cette
--     copie n'est plus jamais mise à jour même si un autre backend
--     modifie la ligne menu_items juste après, et chaque appel
--     create_order s'exécute dans sa PROPRE transaction implicite (une
--     fonction PL/pgSQL SECURITY DEFINER appelée via RPC s'exécute
--     dans la transaction ouverte par l'appelant, isolée des autres
--     commandes concurrentes). Étendre l'INSERT order_items avec des
--     champs DÉJÀ présents dans v_menu_item ne change donc RIEN au
--     comportement transactionnel existant, ne nécessite AUCUN
--     verrou supplémentaire (ni FOR UPDATE ni FOR SHARE) — la garantie
--     d'absence de contamination croisée entre commandes simultanées
--     est déjà structurelle. Détail complet :
--     rapport 15-CONCURRENCY-RACE-REPORT.txt.
--
-- PORTÉE DE CE FICHIER — STRICTEMENT ADDITIVE (mandat §26/§27) :
--   1. order_items : 4 colonnes additives (aucune nouvelle table —
--      les données sont vraiment 1:1 par ligne de commande, le
--      patron existant item_name/unit_price est directement étendu) :
--      3 colonnes écrites explicitement par create_order
--      (tax_rate_snapshot, unit_weight_grams_snapshot,
--      weight_is_approximate_snapshot) + 1 colonne GÉNÉRÉE (bigint)
--      dérivée UNIQUEMENT de colonnes locales déjà figées sur la même
--      ligne (total_weight_grams_snapshot =
--      unit_weight_grams_snapshot::bigint * quantity::bigint, jamais
--      de menu_items -- autorisé par mandat §29, contrairement à une
--      colonne générée qui dépendrait d''une ligne étrangère mutable ;
--      castée en bigint, v1.1, ferme RITD-V1-WEIGHT-OVERFLOW-01).
--   2. create_order : CREATE OR REPLACE, signature/type de retour
--      IDENTIQUES (mandat §24) — seul le corps de l'INSERT
--      order_items change, pour y ajouter 3 valeurs DÉJÀ chargées en
--      mémoire. AUCUN autre comportement de create_order n'est
--      modifié (fulfillment, delivery, totals, public_token,
--      contraintes de champs — tous repris VERBATIM).
-- AUCUNE nouvelle table, AUCUNE colonne generated dépendant d'une
-- ligne étrangère MUTABLE (mandat §29 — les 2 colonnes nullable ne
-- sont PAS générées, elles sont écrites explicitement par
-- create_order au moment de l'INSERT, donc immuables une fois
-- écrites, jamais recalculées). AUCUN nouveau GRANT, AUCUNE nouvelle
-- policy RLS : la policy "merchant reads restaurant order items"
-- (migration-v29, scope RESTAURANT via restaurant_users) couvre
-- automatiquement les nouvelles colonnes par la RLS de LIGNE déjà en
-- place — aucune RLS par colonne n'existe ni n'est requise dans ce
-- modèle. AUCUN fichier payment_*/Monetico/checkout/callback touché
-- (mandat §32, isolation stricte — voir rapport
-- 12-PAYMENT-ISOLATION-REPORT.txt). get_order_tracking (CUSTOMER
-- TRACKING EXPERIENCE v2.1) NE LIT NI NE RETOURNE order_items — donc
-- structurellement inatteignable par ce lot, aucune fuite possible
-- (voir rapport 13-TRACKING-ISOLATION-REPORT.txt).
-- ============================================================


-- ------------------------------------------------------------------
-- ATOMICITÉ DE MIGRATION (mandat v1.1 §9, ferme
-- RITD-V1-MIGRATION-POSTCHECK-01) : BEGIN englobe désormais le
-- préflight, les DDL, la fonction, les droits, ET le postcheck
-- déterministe (section 4, tout en bas de ce fichier) -- COMMIT
-- n'intervient qu'APRÈS que le postcheck a réussi. Toute
-- RAISE EXCEPTION, à N'IMPORTE QUELLE étape de ce fichier, annule
-- désormais la transaction ENTIÈRE : aucun état intermédiaire où une
-- partie des DDL serait commitée pendant qu'une autre échoue. Preuve
-- comportementale (pas seulement une lecture de la syntaxe) : voir
-- rapport MIGRATION-ROLLBACK-EXECUTION-REPORT.txt (harnais, section
-- [15]) -- une base de test où un postcheck est forcé en échec ne
-- conserve, après exécution, AUCUNE des nouvelles colonnes/fonction.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (à l'intérieur de la
--    même transaction que tout le reste -- si ce bloc échoue, rien
--    n'a encore été DDL-modifié et la transaction, jamais commitée,
--    est abandonnée sans laisser de trace). Même patron que
--    CATALOGUE FISCAL v1.3 / migration-v66.
-- ------------------------------------------------------------------
do $$
declare
  v_fn record;
begin
  -- 0a. CATALOGUE FISCAL v1.3 doit déjà être installée : les 3
  -- colonnes source doivent exister sur menu_items.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items'
      and column_name = 'tax_rate'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items'
      and column_name = 'unit_weight_grams'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items'
      and column_name = 'weight_is_approximate'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_items ne porte pas tax_rate/unit_weight_grams/weight_is_approximate — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3 doit être installée AVANT ce lot, migration annulée.';
  end if;

  -- 0b. Garde anti-double-application : aucune des 3 nouvelles
  -- colonnes ne doit déjà exister sur order_items.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name in (
        'tax_rate_snapshot', 'unit_weight_grams_snapshot',
        'weight_is_approximate_snapshot'
      )
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: au moins une colonne de snapshot fiscal existe déjà sur order_items — RECEIPT / INVOICE TAX DETAIL v1 déjà appliqué ou conflit, migration annulée.';
  end if;

  -- 0c. order_items doit avoir EXACTEMENT la forme attendue
  -- (baseline migration-orders.sql, jamais altérée depuis).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'item_name'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'unit_price'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'line_total'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: order_items n''a pas la forme baseline attendue (item_name/unit_price/line_total) — migration annulée.';
  end if;

  -- 0d. Signature EXACTE actuelle de create_order (7 paramètres,
  -- publiée par PAYMENT P3-B6). Aucune surcharge inattendue.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_identity_arguments(p.oid)
        = 'p_slug text, p_service_mode text, p_items jsonb, p_table_number integer, p_customer jsonb, p_note text, p_language text'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte create_order(text,text,jsonb,integer,jsonb,text,text) introuvable — prérequis PAYMENT P3-B6 manquant ou signature incompatible, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_result(p.oid)
        = 'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.create_order a un contrat RETURNS TABLE inattendu — migration annulée pour éviter une régression silencieuse du contrat de sortie.';
  end if;

  for v_fn in
    select pg_get_userbyid(p.proowner) as owner, p.proconfig as search_path, p.prosecdef as secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
  loop
    if v_fn.owner is distinct from 'postgres' then
      raise exception
        'SCANYM_SCHEMA_DRIFT: propriétaire inattendu (%) pour create_order — migration annulée.', v_fn.owner;
    end if;
    if v_fn.secdef is not true then
      raise exception
        'SCANYM_SCHEMA_DRIFT: create_order n''est pas SECURITY DEFINER — migration annulée.';
    end if;
    if v_fn.search_path is null or not exists (
      select 1 from unnest(v_fn.search_path) as cfg where cfg = 'search_path=""'
    ) then
      raise exception
        'SCANYM_SCHEMA_DRIFT: create_order n''a pas search_path = '''' exactement — migration annulée.';
    end if;
  end loop;

  -- 0e. Droits EFFECTIFS actuels sur order_items — confirme qu'aucun
  -- droit d'écriture directe n'existe déjà pour anon/authenticated
  -- (toute écriture doit continuer à passer exclusivement par
  -- create_order SECURITY DEFINER).
  if has_table_privilege('anon', 'public.order_items', 'INSERT')
     or has_table_privilege('anon', 'public.order_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.order_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_items', 'UPDATE')
  then
    raise exception
      'SCANYM_SCHEMA_DRIFT: order_items a déjà un droit INSERT/UPDATE direct pour anon/authenticated — migration annulée.';
  end if;
end $$;


-- ------------------------------------------------------------------
-- 1. COLONNES ADDITIVES sur order_items — extension du patron DÉJÀ
--    EN PLACE (item_name/unit_price sont déjà des snapshots figés au
--    moment de create_order ; ce lot ajoute 3 colonnes au même
--    patron, jamais une nouvelle table).
--
--    DÉCISIONS DE NULLABILITÉ EXPLICITES (mandat §27, une par
--    colonne — aucun défaut fictif) :
--
--    - tax_rate_snapshot : NULLABLE. Double raison : (a) optionnelle
--      par nature — menu_items.tax_rate lui-même est NULLABLE (un
--      produit peut n'avoir aucun taux configuré), une valeur NULL
--      ici pour une commande POST-lot signifie fidèlement "aucun
--      taux n'était configuré sur ce produit à l'instant de la
--      commande" ; (b) nullable-pour-historique — les lignes
--      order_items créées AVANT ce lot n'ont structurellement aucune
--      valeur à y placer, ALTER TABLE ADD COLUMN sans DEFAULT leur
--      assigne NULL, ce qui est honnête (pas de taux inventé,
--      mandat §17/§45 : "no VAT rate may be invented").
--
--    - unit_weight_grams_snapshot : NULLABLE, mêmes deux raisons
--      (menu_items.unit_weight_grams est lui-même NULLABLE ; lignes
--      historiques).
--
--    - weight_is_approximate_snapshot : NULLABLE — bien que sa
--      colonne source (menu_items.weight_is_approximate) soit NOT
--      NULL DEFAULT false, cette colonne SERT AUSSI de marqueur de
--      complétude du snapshot fiscal : create_order (ci-dessous)
--      l'écrit TOUJOURS avec une valeur booléenne concrète
--      (jamais NULL) pour toute commande créée à partir de ce lot —
--      donc weight_is_approximate_snapshot IS NULL identifie sans
--      ambiguïté ni colonne supplémentaire une ligne ANTÉRIEURE à ce
--      lot ("LEGACY ORDER — FISCAL SNAPSHOT UNAVAILABLE", mandat
--      §25), tandis qu'une valeur false pour une commande post-lot
--      signifie authentiquement "poids non approximatif". Inventer
--      `false` par défaut pour les lignes historiques effacerait
--      cette distinction et fabriquerait une donnée fiscale non
--      observée — explicitement interdit (mandat §27, "no fake
--      defaults merely to satisfy NOT NULL").
-- ------------------------------------------------------------------

alter table public.order_items
  add column tax_rate_snapshot numeric(5,2),
  add column unit_weight_grams_snapshot integer,
  add column weight_is_approximate_snapshot boolean,
  add column total_weight_grams_snapshot bigint
    generated always as (
      case
        when unit_weight_grams_snapshot is not null
          then unit_weight_grams_snapshot::bigint * quantity::bigint
        else null
      end
    ) stored;

comment on column public.order_items.tax_rate_snapshot is
  'RECEIPT / INVOICE TAX DETAIL v1 -- copie FIGÉE de menu_items.tax_rate au moment de create_order (jamais relue depuis menu_items ensuite). NULL = soit aucun taux configuré sur le produit à cet instant, soit ligne antérieure à ce lot (voir weight_is_approximate_snapshot pour distinguer). MÉTADONNÉE FISCALE UNIQUEMENT -- ce lot ne calcule JAMAIS de montant de taxe (HT/TVA/TTC) depuis cette valeur : la sémantique d''inclusion de taxe (prix TTC vs HT) n''est pas explicite dans le modèle actuel (ARCHITECTURE GAP -- PRICE TAX-INCLUSION SEMANTICS NOT EXPLICIT).';
comment on column public.order_items.unit_weight_grams_snapshot is
  'RECEIPT / INVOICE TAX DETAIL v1 -- copie FIGÉE de menu_items.unit_weight_grams au moment de create_order. PUREMENT INFORMATIF/LOGISTIQUE (mandat §7/§17) -- ne participe JAMAIS au calcul du prix ni du total de ligne : unit_price (déjà snapshoté) x quantity reste l''unique autorité financière. NULL = non pertinent pour ce produit, ou ligne antérieure à ce lot.';
comment on column public.order_items.weight_is_approximate_snapshot is
  'RECEIPT / INVOICE TAX DETAIL v1 -- copie FIGÉE de menu_items.weight_is_approximate au moment de create_order. Sert AUSSI de marqueur de complétude : NULL = ligne créée AVANT ce lot ("LEGACY ORDER -- FISCAL SNAPSHOT UNAVAILABLE"), true/false = ligne créée par ce lot avec un snapshot fiscal complet. N''affecte JAMAIS le calcul du prix.';
comment on column public.order_items.total_weight_grams_snapshot is
  'RECEIPT / INVOICE TAX DETAIL v1.1 -- colonne GÉNÉRÉE (unit_weight_grams_snapshot::bigint * quantity::bigint), dépend UNIQUEMENT de colonnes locales déjà figées sur cette même ligne (jamais de menu_items -- mandat §29, "must depend only on immutable row-local snapshot values"). Type bigint et opérandes explicitement castés en bigint AVANT multiplication (ferme RITD-V1-WEIGHT-OVERFLOW-01, v1.1) -- ni unit_weight_grams_snapshot ni quantity ne portent de borne supérieure au-delà de "> 0", une multiplication int4*int4 pouvait donc dépasser 2 147 483 647 et faire échouer l''insertion de la ligne. Total logistique INFORMATIF (mandat §6, exemple de référence "200g x qty 2 = 400g historical logistical total") -- ne participe JAMAIS au calcul du prix ni du total de ligne financier (line_total reste l''unique autorité, toujours numeric(12,2), jamais affecté par ce changement de type). NULL quand unit_weight_grams_snapshot est NULL.';

-- ------------------------------------------------------------------
-- 2. CONTRAINTES CHECK -- mêmes bornes que menu_items (mandat §28,
--    "add DB constraints for true invariants... historical integrity
--    benefits" justifie de dupliquer une borne déjà garantie en
--    amont, pour que l'intégrité historique ne dépende jamais
--    uniquement de la validation applicative au moment de l'écriture).
-- ------------------------------------------------------------------

alter table public.order_items
  add constraint order_items_tax_rate_snapshot_chk
    check (tax_rate_snapshot is null or (tax_rate_snapshot >= 0 and tax_rate_snapshot <= 100));

alter table public.order_items
  add constraint order_items_unit_weight_grams_snapshot_chk
    check (unit_weight_grams_snapshot is null or unit_weight_grams_snapshot > 0);

-- ------------------------------------------------------------------
-- 3. create_order -- CREATE OR REPLACE, signature et type de retour
--    STRICTEMENT IDENTIQUES à la version publiée par PAYMENT P3-B6
--    (mandat §24, "Must preserve the released public create_order
--    contract... unless a compelling reason exists"). Corps repris
--    VERBATIM à l'exception du seul bloc INSERT INTO order_items, qui
--    ajoute 3 colonnes + 3 valeurs DÉJÀ chargées en mémoire dans
--    v_menu_item (aucune requête SQL supplémentaire, aucun nouveau
--    verrou, voir en-tête section CONCURRENCE). Droits (revoke/grant)
--    repris à l'identique, ré-émis explicitement pour rester
--    idempotent et auditable (même patron que PAYMENT P3-B6
--    lui-même vis-à-vis du lot qui le précède).
-- ------------------------------------------------------------------

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
  v_mode_enabled boolean;
  v_req         record;
  v_field_value text;
  v_room_number text;
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
  v_street      text;
  v_city        text;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  select enabled into v_mode_enabled
  from public.restaurant_sale_modes
  where restaurant_id = v_restaurant.id and mode_code = p_service_mode;

  if v_mode_enabled is null or not v_mode_enabled then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');
  v_room_number := nullif(left(trim(coalesce(p_customer->>'room_number','')), 20), '');
  v_street := nullif(left(trim(coalesce(p_customer->>'street','')), 200), '');
  v_city   := nullif(left(trim(coalesce(p_customer->>'city','')), 120), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  insert into tmp_field_reqs (field, requirement, one_of_group, resolved_value)
  select x.field, x.requirement, x.one_of_group,
    case x.field
      when 'customer_name' then v_name
      when 'phone' then v_phone
      when 'email' then v_email
      when 'delivery_address' then v_address
      when 'table_number' then p_table_number::text
      when 'room_number' then v_room_number
      else null
    end
  from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;

  for v_req in select field, resolved_value from tmp_field_reqs where requirement = 'required' loop
    if v_req.resolved_value is null then
      raise exception 'Champ requis manquant pour ce mode: %', v_req.field;
    end if;
  end loop;

  for v_req in
    select one_of_group, bool_or(resolved_value is not null) as satisfied
    from tmp_field_reqs
    where requirement = 'one_of' and one_of_group is not null
    group by one_of_group
  loop
    if not v_req.satisfied then
      raise exception 'Au moins un champ du groupe % est requis', v_req.one_of_group;
    end if;
  end loop;

  if p_service_mode = 'delivery' then
    select exists (
      select 1
      from public.restaurant_sale_mode_fulfillments f
      join public.restaurant_sale_modes rsm
        on rsm.restaurant_id = f.restaurant_id and rsm.mode_code = f.mode_code
      where f.restaurant_id = v_restaurant.id
        and f.mode_code = p_service_mode
        and f.enabled = true
        and rsm.enabled = true
    ) into v_new_engine;

    if v_new_engine then
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      v_postal := substring(v_address from '\m(\d{5})\M');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;

      select p into v_zone
      from public.restaurant_sale_modes rsm,
           jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p
      where rsm.restaurant_id = v_restaurant.id and rsm.mode_code = 'delivery'
        and v_postal like p || '%'
      limit 1;

      if v_zone is null then
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number, room_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    case when p_service_mode = 'room_service' then v_room_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  if p_service_mode = 'delivery' and v_address is not null then
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city)
    values (v_order_id, v_address, v_postal, v_street, v_city);
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    -- RECEIPT / INVOICE TAX DETAIL v1 : v_menu_item est un
    -- %rowtype -- ce SELECT charge DÉJÀ tax_rate/unit_weight_grams/
    -- weight_is_approximate (CATALOGUE FISCAL v1.3) en mémoire locale
    -- au moment précis de cette instruction. Cette copie n'est plus
    -- jamais mise à jour ensuite, y compris si menu_items change
    -- avant la fin de cette transaction ou avant celle d'une autre
    -- commande concurrente (chaque appel create_order a sa propre
    -- transaction) -- garantie structurelle contre toute
    -- contamination croisée, sans verrou supplémentaire requis
    -- (mandat §52, rapport 15-CONCURRENCY-RACE-REPORT.txt).
    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    -- RECEIPT / INVOICE TAX DETAIL v1 : SEUL changement de ce bloc
    -- par rapport à la version PAYMENT P3-B6 -- 3 colonnes/valeurs
    -- ajoutées, aucune autre colonne/valeur touchée. Le total de
    -- ligne (line_total = v_menu_item.price * v_qty) et le prix
    -- unitaire (unit_price = v_menu_item.price) restent l'UNIQUE
    -- autorité financière, inchangés (mandat §7) -- les 3 nouvelles
    -- colonnes sont purement fiscales/informatives, jamais lues par
    -- un calcul de montant.
    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    declare
      v_delivery_min_items integer;
    begin
      select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
      from public.restaurant_sale_modes
      where restaurant_id = v_restaurant.id and mode_code = 'delivery';

      if v_qty_total < coalesce(v_delivery_min_items, 0) then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_delivery_min_items, v_qty_total;
      end if;
    end;
  elsif p_service_mode = 'delivery' and v_new_engine then
    select * into v_resolved
    from public.resolve_delivery_fulfillment(v_restaurant.id, p_service_mode, v_postal, v_qty_total, v_subtotal);

    if not v_resolved.eligible then
      if v_resolved.block = 'no-postal' then
        raise exception 'Code postal absent de l''adresse';
      elsif v_resolved.block = 'below-min' then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_resolved.min_items, v_qty_total;
      else
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;

    v_zone := v_resolved.matched_prefix;
    v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);
    v_fulfillment_rule_id := v_resolved.fulfillment_rule_id;
    v_fulfillment_code := v_resolved.fulfillment_code;
    v_provider_code := v_resolved.provider;
  end if;

  update public.orders
  set subtotal = v_subtotal,
      delivery_fee = v_delivery_fee,
      total = v_subtotal + v_delivery_fee,
      fulfillment_rule_id = v_fulfillment_rule_id,
      fulfillment_code = v_fulfillment_code,
      provider_code = v_provider_code
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

-- Droits préservés par CREATE OR REPLACE FUNCTION à signature
-- identique (repris VERBATIM de PAYMENT P3-B6, ré-émis pour rester
-- idempotent et auditable).
revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public, anon;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text) to authenticated, anon;

-- ------------------------------------------------------------------
-- 4. VÉRIFICATION POST-APPLICATION (mandat v1.1 §8-10, ferme
--    RITD-V1-MIGRATION-POSTCHECK-01) : DÉLIBÉRÉMENT à l'intérieur de
--    la MÊME transaction que les sections 0-3 ci-dessus, AVANT COMMIT
--    -- toute RAISE EXCEPTION ici annule la TOTALITÉ des DDL/fonction/
--    droits déjà exécutés dans cette transaction, jamais un état
--    partiellement commité.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'tax_rate_snapshot' and is_nullable = 'YES'
      and numeric_precision = 5 and numeric_scale = 2
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: order_items.tax_rate_snapshot absente ou de forme inattendue.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'unit_weight_grams_snapshot' and is_nullable = 'YES'
      and data_type = 'integer'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: order_items.unit_weight_grams_snapshot absente ou de forme inattendue.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'weight_is_approximate_snapshot' and is_nullable = 'YES'
      and data_type = 'boolean'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: order_items.weight_is_approximate_snapshot absente ou de forme inattendue.';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'order_items_tax_rate_snapshot_chk'
  ) or not exists (
    select 1 from pg_constraint where conname = 'order_items_unit_weight_grams_snapshot_chk'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: contraintes CHECK manquantes sur order_items.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'total_weight_grams_snapshot' and is_generated = 'ALWAYS'
      and data_type = 'bigint'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: order_items.total_weight_grams_snapshot absente, n''est pas une colonne GÉNÉRÉE, ou n''est pas de type bigint.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_result(p.oid)
        = 'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: create_order n''a plus le contrat de retour attendu après application.';
  end if;

  if has_table_privilege('anon', 'public.order_items', 'INSERT')
     or has_table_privilege('anon', 'public.order_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.order_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_items', 'UPDATE')
  then
    raise exception 'SCANYM_POSTCHECK_FAILED: order_items a maintenant un droit INSERT/UPDATE direct pour anon/authenticated -- régression de posture ACL.';
  end if;
end $$;

commit;
-- ============================================================
-- FIN — RECEIPT / INVOICE TAX DETAIL v1.1
-- ============================================================
