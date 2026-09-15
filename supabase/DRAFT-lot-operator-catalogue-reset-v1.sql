-- ============================================================
-- Scanym — CLAUDE NOUGARO
-- OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1.1
-- TENANT-SCOPED RESET — PREVIEW FIRST — SERVER-ENFORCED STRONG
-- CONFIRMATION — CLEAN POST-RESET STRUCTURE — PRESERVE ORDER HISTORY
-- — NO CROSS-TENANT IMPACT
--
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
-- Baseline autorisé : main 6958ce449f1f882e1f14c254bfa2ad4668c04baf
-- (tree 6f26f39fb782180dc5b8c92e65fb94a6778e4c21), fetché au début de
-- ce lot et RE-VÉRIFIÉ INCHANGÉ (git fetch origin main, même SHA) au
-- début de cette révision v1.1 -- pas de "BASELINE MOVED".
--
-- ------------------------------------------------------------------
-- v1.1 -- TARGETED REMEDIATION (revue CTO) -- ce fichier N'A JAMAIS
-- été appliqué à une base réelle (v1 n'a été exécuté que sur des
-- bases PostgreSQL jetables de test) : cette révision ÉDITE le
-- brouillon EN PLACE plutôt que d'empiler un second fichier de
-- migration par-dessus une v1 qui n'a jamais été "publiée" nulle
-- part -- rien à faire migrer, seulement à corriger avant tout envoi
-- à l'audit indépendant.
--
-- Point 1 (MAJOR) -- STRONG CONFIRMATION SERVEUR :
--   v1 validait la phrase de confirmation UNIQUEMENT côté client (UI)
--   -- `reset_merchant_catalogue(uuid)` ne recevait jamais la phrase,
--   un appel RPC direct (bypass UI) suffisait donc à déclencher un
--   reset réel sans jamais prouver la confirmation. Corrigé : la
--   fonction accepte désormais `p_confirmation_phrase text` et
--   dérive elle-même la phrase attendue depuis `restaurants.name`
--   (jamais depuis une valeur fournie par le client) : "RESET " ||
--   nom du marchand, seuls les espaces de BORDURE de la saisie
--   opérateur sont ignorés (btrim), AUCUNE autre normalisation
--   (jamais de casse, jamais d'espaces internes) -- comparaison
--   EXACTE, littérale, comme demandé ("Prefer exact literal
--   confirmation"). v1 dérivait la phrase affichée en MAJUSCULES
--   (`toLocaleUpperCase("fr-FR")`) côté client uniquement -- ce choix
--   est abandonné en v1.1 : PostgreSQL `upper()` n'est pas garanti
--   identique à `String.prototype.toLocaleUpperCase("fr-FR")` sur des
--   caractères accentués selon la locale/collation de la base, ce qui
--   aurait pu un jour REJETER une confirmation pourtant correctement
--   recopiée par un opérateur (bug de robustesse, pas seulement de
--   sécurité). v1.1 compare donc le nom du marchand tel quel
--   (respectant sa casse réelle), éliminant totalement ce risque de
--   divergence client/serveur -- voir lib/services/catalogue-reset.ts.
--   Une phrase absente/vide/erronée/pour un AUTRE marchand échoue
--   TOUJOURS la comparaison (FAIL CLOSED) : zéro mutation, zéro
--   archivage, zéro suppression structurelle, zéro événement d'audit
--   "completed"/"no_op" -- un événement d'audit DÉDIÉ
--   ('rejected_confirmation', compteurs de mutation à zéro) est
--   quand même écrit, dans la MÊME transaction que le reste de cette
--   fonction (elle retourne normalement, elle ne lève jamais
--   d'exception pour ce cas précis -- voir note technique ci-dessous)
--   -- traçabilité complète de toute tentative, y compris un
--   éventuel bypass UI. "F. Direct RPC invocation bypassing UI with
--   no/wrong confirmation: IMPOSSIBLE" est ainsi prouvé au niveau
--   PostgreSQL réel, pas seulement au niveau UI (voir harnais).
--
--   Note technique -- pourquoi un RETOUR normal plutôt qu'une
--   EXCEPTION pour ce cas précis (contrairement à 28000/42501/P0002
--   ci-dessous, qui restent des exceptions dures) : PostgreSQL ne
--   propose pas de transaction autonome native (sans extension type
--   dblink/pg_background, hors de portée de ce lot, "no broad new
--   logging subsystem"). Une exception levée DANS cette fonction fait
--   échouer ET annuler la TOTALITÉ de la transaction implicite de cet
--   appel RPC, y compris tout INSERT déjà exécuté dans un bloc
--   `exception when others` -- il serait donc impossible d'auditer un
--   rejet de confirmation tout en le signalant par une exception SQL,
--   sans une complexité (savepoint imbriqué + re-raise, ou extension
--   externe) largement disproportionnée pour ce cas. Une confirmation
--   erronée est par ailleurs un flux UI ATTENDU et récupérable (une
--   faute de frappe d'opérateur, pas une erreur de programmation) --
--   contrairement à 28000/42501/P0002, qui représentent un appel qui
--   n'aurait jamais dû être tenté. `result = 'rejected_confirmation'`
--   dans la ligne retournée est donc le signal d'échec, vérifié et
--   traduit en erreur explicite côté service TypeScript
--   (`resetMerchantCatalogue` lève toujours une erreur dans ce cas --
--   jamais un appelant ne peut confondre ce retour avec un succès).
--
-- Point 2 (structure propre après reset) :
--   v1 archivait les produits mais RETENAIT catégories/sous-
--   catégories encore peuplées (même de produits désormais archivés)
--   -- sûr, mais laissait potentiellement TOUTE la structure de
--   catégories visible/active, ce qui ne satisfaisait pas pleinement
--   l'objectif métier "prêt pour un réimport propre". v1.1 ajoute une
--   étape de DÉSACTIVATION (jamais une suppression) : chaque
--   catégorie/sous-catégorie RETENUE (parce qu'elle porte encore au
--   moins un produit, même archivé) est en plus marquée
--   `is_active = false` -- sans supprimer la moindre ligne, sans
--   toucher au moindre produit. Ceci ne réintroduit AUCUNE nouvelle
--   colonne pour `menu_categories` : `is_active` y existe DÉJÀ dans
--   le schéma depuis toujours (schema.sql) et y est DÉJÀ honoré, sans
--   aucune modification de ce lot, par toutes les requêtes commerçant/
--   client existantes qui filtrent explicitement `mc.is_active = true`
--   (orders.sql, migration-orders-lang.sql, migration-v65-order-note,
--   migration-v82-lot2a-sale-modes, DRAFT-lot-payment-p3b6-checkout-
--   billing-context, DRAFT-lot-receipt-invoice-tax-detail-v1,
--   DRAFT-lot-server-delivery-fulfillment-pricing, DRAFT-lot-n1a-
--   customer-email-notification-foundation-v1, et l'ensemble des lots
--   liés au profil légal vendeur -- confirmé par recherche exhaustive)
--   -- une catégorie désactivée par ce lot devient donc IMMÉDIATEMENT
--   et SANS AUCUNE modification supplémentaire invisible à toute
--   commande/facture/document légal/tracking/notification client,
--   exactement le comportement "clean catalogue" recherché, en
--   réutilisant un mécanisme déjà existant, déjà éprouvé, jamais
--   dupliqué. (Ce lot lui-même ne lit ni n'écrit AUCUNE de ces tables
--   -- seul menu_categories.is_active, déjà lu par elles, est modifié.)
--
--   `menu_subcategories` n'a en revanche AUCUNE colonne équivalente
--   avant ce lot (limite connue, documentée explicitement dans
--   DRAFT-lot-catalogue-subcategories-backoffice-v1.sql : "aucune
--   colonne d'archivage sur menu_subcategories en v1"). Ce lot
--   introduit donc l'extension MINIMALE strictement nécessaire :
--   `menu_subcategories.is_active boolean not null default true`
--   (colonne additive, valeur par défaut = comportement historique
--   inchangé pour toute ligne existante et pour toute création future
--   via create_subcategory, qui ne référence jamais cette colonne et
--   continue de produire des sous-catégories actives par défaut,
--   exactement comme create_category pour menu_categories.is_active
--   depuis migration-v66) -- symétrie exacte avec menu_categories,
--   "smallest archival semantics for structural rows if required".
--
--   RISQUE IDENTIFIÉ ET CORRIGÉ -- "clean import must not accidentally
--   reuse unwanted legacy structure" (mandat v1.1 §3/§4) :
--   `get_merchant_catalogue` (la RPC de lecture du catalogue
--   commerçant, RÉUTILISÉE TELLE QUELLE par la résolution de l'import,
--   lib/catalogue-import/resolution.ts -- jamais dupliquée) NE
--   FILTRAIT PAS sur `is_active` (confirmé : commentaire préexistant
--   dans resolution.ts lui-même, "get_merchant_catalogue ne filtre
--   pas par is_active, une collision réelle entre catégories
--   existantes reste possible"). Sans correction, une catégorie/
--   sous-catégorie RETENUE-MAIS-DÉSACTIVÉE par ce reset continuerait
--   donc d'apparaître comme "EXISTING" dans la résolution d'un import
--   ultérieur, et un réimport "propre" réutiliserait SILENCIEUSEMENT
--   son identifiant -- exactement le risque que ce point 2 doit
--   éliminer. Corrigé par le chemin le PLUS ÉTROIT possible, sans
--   toucher à la moindre autre RPC/écran :
--     a. `get_merchant_catalogue(uuid, boolean)` est étendue de façon
--        STRICTEMENT ADDITIVE (2 colonnes ajoutées EN FIN de
--        `returns table`, aucune colonne existante déplacée/retirée/
--        renommée -- même patron d'extension additive déjà appliqué
--        6 fois à cette même fonction par des lots précédents : v43,
--        v66, v67, v67b, v81-lot1b, subcategories-backoffice-v1,
--        fiscal-measurements, operator-authorization-v1.1) :
--        `category_is_active`, `subcategory_is_active`. AUCUN
--        appelant existant n'est cassé (tous consomment les colonnes
--        par NOM, jamais par position -- lib/services/dashboard.ts
--        mappe déjà chaque colonne explicitement par nom, avec repli
--        défensif `??` pour toute base non encore migrée -- même
--        patron réutilisé ici pour les 2 nouvelles colonnes).
--     b. lib/catalogue-import/resolution.ts (module PUR, aucun accès
--        réseau, "il classe seulement") ignore désormais toute
--        catégorie/sous-catégorie `is_active = false` lors de la
--        construction de son index "EXISTING" -- une ligne d'import
--        dont le nom correspond UNIQUEMENT à une structure retenue-
--        désactivée résout donc en `WOULD_CREATE` (nouvelle catégorie/
--        sous-catégorie active), jamais en `EXISTING`/`AMBIGUOUS`.
--        Rien d'autre n'est modifié dans le module d'import (aucune
--        RPC de commit touchée, mandat "must not alter import schema/
--        row-type semantics/product import idempotency").
--     c. L'index unique partiel `idx_menu_categories_unique_active_name`
--        (migration-v66, `WHERE is_active = true`) permettait DÉJÀ,
--        avant ce lot, la coexistence d'une catégorie active et d'une
--        catégorie inactive de même nom pour un même restaurant --
--        conçu EXPRÈS pour ce cas ("catégories techniques/inactives
--        sont exclues de la contrainte", commentaire préexistant).
--        `idx_menu_subcategories_unique_name` n'avait, elle, AUCUNE
--        clause `WHERE` (unicité inconditionnelle par catégorie) --
--        ce lot la reconstruit à l'identique EXCEPTÉ l'ajout de
--        `WHERE is_active = true`, pour offrir EXACTEMENT la même
--        garantie de non-collision à la création d'une nouvelle
--        sous-catégorie après reset. `create_subcategory` capture déjà
--        `unique_violation` de façon générique (par SQLSTATE 23505,
--        jamais par nom d'index) : ce changement est totalement
--        transparent pour son comportement existant.
--
--   Compteurs "après reset" (mandat v1.1 §5) : `preview_catalogue_reset`
--   et `reset_merchant_catalogue` exposent désormais
--   `categories_active_after_reset`/`subcategories_active_after_reset`
--   -- TOUJOURS 0 pour un reset qui s'exécute réellement, PAR
--   CONSTRUCTION : ce lot désactive INCONDITIONNELLEMENT (jamais une
--   suppression, jamais un cas "impossible à désactiver" -- une
--   simple colonne booléenne n'a aucune dépendance de sécurité,
--   contrairement à une suppression physique) chaque ligne
--   structurelle retenue. Aucun cas "CATALOGUE RESET STRUCTURAL
--   DECISION REQUIRED" n'existe donc pour ce schéma : la désactivation
--   atteint toujours un catalogue actif proprement vide, sans jamais
--   avoir besoin de masquer quoi que ce soit uniquement côté UI.
-- ------------------------------------------------------------------
--
-- ANALYSE PRÉALABLE (mandat §4, "Discovery first", INCHANGÉE depuis
-- v1) -- résumé, voir FINDINGS.md du paquet livré pour le rapport
-- complet fichier par fichier/ligne par ligne :
--
--   menu_items       : archived_at (soft-delete, migration-v31),
--                       category_id NOT NULL references menu_categories
--                       on delete cascade (schema.sql), subcategory_id
--                       nullable references menu_subcategories on
--                       delete set null (subcategories backoffice v1).
--                       AUCUNE autre table ne référence menu_items(id)
--                       sauf order_items.menu_item_id/option_item_id,
--                       toutes deux "on delete set null" -- ET
--                       order_items stocke une COPIE FIGÉE
--                       (item_name/unit_price/line_total + snapshots
--                       fiscaux) jamais relue depuis menu_items :
--                       l'historique de commande survit intact même à
--                       une suppression physique d'un produit. Malgré
--                       cela, ce lot n'introduit JAMAIS de suppression
--                       physique de produit (mandat §2 absolu) --
--                       seul l'archivage existant (archived_at = now(),
--                       is_available = false, EXACTEMENT le même geste
--                       que archive_product, migration-v31) est utilisé.
--
--   menu_categories  : `is_active boolean not null default true`
--                       EXISTE DÉJÀ (schema.sql), jamais touchée par
--                       update_category/create_category (toujours
--                       true) AVANT ce lot -- v1.1 est la PREMIÈRE RPC
--                       à jamais la faire passer à false, de façon
--                       ciblée et documentée ci-dessus.
--                       menu_items.category_id et
--                       menu_subcategories.category_id référencent
--                       toutes deux menu_categories(id) ON DELETE
--                       CASCADE -- une suppression physique de
--                       catégorie supprimerait donc physiquement ses
--                       produits (même archivés) et ses
--                       sous-catégories. AUCUNE RPC de suppression de
--                       catégorie n'existe avant ce lot.
--
--   menu_subcategories : AUCUNE colonne d'archivage avant ce lot
--                       (`is_active` ajoutée ici, voir ci-dessus).
--                       Seule menu_items.subcategory_id la référence,
--                       en ON DELETE SET NULL (jamais CASCADE) -- une
--                       suppression physique de sous-catégorie ne
--                       supprime donc JAMAIS un produit, elle détache
--                       seulement son rattachement fin (le produit
--                       reste entièrement intact, sous sa catégorie).
--                       AUCUNE autre table ne référence
--                       menu_subcategories(id). AUCUNE RPC de
--                       suppression de sous-catégorie n'existe avant
--                       ce lot.
--
-- ------------------------------------------------------------------
-- STRATÉGIE DE RESET RETENUE (mandat §2/§11/§12/§13, "prouver la
-- sécurité, ne jamais la supposer") :
--
--   PRODUITS      -> TOUJOURS archivés (archived_at = now(),
--                    is_available = false), JAMAIS supprimés
--                    physiquement, quelle que soit leur historique de
--                    commande -- règle absolue, sans exception, sans
--                    branchement conditionnel sur order_items (la plus
--                    simple et la plus sûre des deux lectures
--                    possibles du mandat, retenue délibérément :
--                    "Preferred behavior: PRODUCTS -> archive").
--
--   SOUS-CATÉGORIES -> supprimées physiquement SEULEMENT si, au moment
--                    du commit, elles ne portent plus AUCUNE ligne
--                    menu_items (active OU archivée) -- c-à-d
--                    seulement les sous-catégories qui n'ont jamais
--                    contenu le moindre produit. Une sous-catégorie
--                    RETENUE (a un jour contenu un produit, même
--                    désormais archivé) est en plus DÉSACTIVÉE
--                    (`is_active = false`, v1.1) -- jamais forcée à
--                    disparaître physiquement.
--
--   CATÉGORIES    -> supprimées physiquement SEULEMENT si, au moment
--                    du commit, elles ne portent plus AUCUNE ligne
--                    menu_items NI AUCUNE ligne menu_subcategories.
--                    Une catégorie RETENUE est de même DÉSACTIVÉE
--                    (`is_active = false`, v1.1) -- car ON DELETE
--                    CASCADE sur menu_categories -> menu_items rendrait
--                    toute suppression physique de catégorie ENCORE
--                    PEUPLÉE équivalente à une suppression physique de
--                    produit, formellement interdite par ce lot
--                    (mandat §2, absolu, sans exception).
--
--   Conséquence assumée et honnêtement documentée (mandat §15,
--   "Do not silently claim a full reset if structural rows remain") :
--   un marchand dont TOUTES les catégories contiennent au moins un
--   produit (le cas courant, y compris Au Lait Cru selon toute
--   vraisemblance) verra ses produits archivés et ses catégories
--   DÉSACTIVÉES (v1.1) MAIS PHYSIQUEMENT RETENUES -- rapporté
--   explicitement comme "retained due to references", jamais comme
--   "removed". Seules les catégories/sous-catégories structurellement
--   VIDES (jamais peuplées) sont physiquement supprimées. C'est le
--   prix de la garantie absolue "jamais de suppression physique de
--   produit" -- un choix de sécurité délibéré, pas un oubli. La
--   désactivation (v1.1) garantit néanmoins qu'AUCUNE catégorie/
--   sous-catégorie retenue ne reste ACTIVE après un reset réel :
--   `categories_active_after_reset`/`subcategories_active_after_reset`
--   valent 0 dans tous les cas où `result <> 'rejected_confirmation'`
--   et qu'un travail réel a eu lieu.
--
-- ------------------------------------------------------------------
-- IDEMPOTENCY (mandat §16) : un second appel (avec la BONNE phrase de
-- confirmation, toujours dérivée du nom courant du marchand) ne
-- trouve plus aucun produit actif à archiver, plus aucune ligne
-- structurelle nouvellement vide à supprimer, ni aucune ligne encore
-- active à désactiver (toutes déjà `is_active = false` depuis le
-- premier reset) -- tous les compteurs retombent à zéro, `result`
-- passe à 'no_op', aucune exception.
--
-- CONCURRENCY (mandat §17) : chaque étape est une seule instruction
-- SQL ensembliste (UPDATE/DELETE), exécutée atomiquement dans la
-- transaction implicite du corps de fonction PL/pgSQL -- aucune
-- lecture préalable côté client n'est jamais réutilisée pour décider
-- quoi muter (tout est recalculé par les clauses WHERE au moment de
-- l'exécution serveur). Aucun système de verrouillage distribué n'est
-- introduit -- inutile ici, chaque instruction est déjà atomique et
-- idempotente par construction.
--
-- AUTORISATION (mandat §8/§9) : `reset_merchant_catalogue` et
-- `preview_catalogue_reset` exigent TOUTES DEUX `is_scanym_operator()`
-- -- AUCUN repli owner/manager (à la différence de
-- create_category/archive_product/etc.) : ce lot est une action
-- Operator Backoffice, jamais une auto-réinitialisation marchand,
-- même patron strict que `create_establishment`
-- (migration-lotd-establishment-creation.sql). Tenant isolation :
-- chaque instruction est scopée à p_restaurant_id, sans exception --
-- voir tests réels (supabase/tests/operator-catalogue-reset-v1-check.sh)
-- pour la preuve empirique de non-fuite entre deux établissements
-- portant les mêmes noms de catégorie/produit.
--
-- AUDIT (mandat §14) : aucune table d'audit générique n'existe déjà
-- dans le schéma (recherche exhaustive "audit|event_log" sur tout
-- supabase/*.sql -- 0 résultat avant ce lot). Une table UNIQUE et
-- ÉTROITEMENT SCOPÉE à cette seule action est ajoutée ci-dessous
-- (`catalogue_reset_audit_log`) -- PAS un sous-système de logging
-- générique. v1.1 y ajoute une valeur `result` supplémentaire
-- ('rejected_confirmation') et 2 colonnes de comptage -- toujours la
-- même table étroite, jamais un nouveau système.
-- ============================================================

-- ------------------------------------------------------------------
-- 0. VÉRIFICATIONS PRÉALABLES -- échoue tôt et proprement si une
--    dépendance attendue est absente (schema drift), jamais une
--    application partielle.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'menu_items'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: menu_items introuvable -- CATALOGUE RESET v1.1 annulé, aucune modification appliquée.';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'menu_subcategories'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: menu_subcategories introuvable -- CATALOGUE RESET v1.1 annulé.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable -- CATALOGUE RESET v1.1 annulé.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_catalogue() introuvable -- CATALOGUE RESET v1.1 annulé.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'is_active'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: menu_categories.is_active introuvable -- CATALOGUE RESET v1.1 annulé.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurants' and column_name = 'name'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurants.name introuvable -- CATALOGUE RESET v1.1 annulé.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 1. Table d'audit dédiée -- ADDITIVE, écriture UNIQUEMENT via
--    reset_merchant_catalogue (SECURITY DEFINER), jamais de GRANT
--    direct à anon/authenticated. Lecture : opérateur Scanym
--    uniquement (RLS). v1.1 : + 'rejected_confirmation' dans
--    `result`, + 2 colonnes de comptage post-reset.
-- ------------------------------------------------------------------
create table if not exists public.catalogue_reset_audit_log (
  id                          uuid primary key default gen_random_uuid(),
  restaurant_id               uuid not null references public.restaurants(id) on delete cascade,
  operator_user_id            uuid not null references auth.users(id),
  created_at                  timestamptz not null default now(),
  products_archived           integer not null check (products_archived >= 0),
  subcategories_removed       integer not null check (subcategories_removed >= 0),
  subcategories_retained      integer not null check (subcategories_retained >= 0),
  categories_removed          integer not null check (categories_removed >= 0),
  categories_retained         integer not null check (categories_retained >= 0),
  categories_active_after_reset    integer not null check (categories_active_after_reset >= 0),
  subcategories_active_after_reset integer not null check (subcategories_active_after_reset >= 0),
  result                      text not null check (result in ('completed', 'no_op', 'rejected_confirmation'))
);

create index if not exists idx_catalogue_reset_audit_restaurant
  on public.catalogue_reset_audit_log(restaurant_id, created_at desc);

alter table public.catalogue_reset_audit_log enable row level security;
revoke all on table public.catalogue_reset_audit_log from anon, authenticated, public;

drop policy if exists "lecture operateur audit reset catalogue" on public.catalogue_reset_audit_log;
create policy "lecture operateur audit reset catalogue"
  on public.catalogue_reset_audit_log for select
  to authenticated
  using (public.is_scanym_operator());

-- ------------------------------------------------------------------
-- 1b. menu_subcategories.is_active -- colonne ADDITIVE, symétrique
--     exacte de menu_categories.is_active (schema.sql). Valeur par
--     défaut `true` : comportement historique inchangé pour toute
--     ligne existante ET pour toute création future via
--     create_subcategory (jamais modifiée, continue de produire des
--     lignes actives par défaut). Jamais lue/filtrée par aucune RPC
--     avant ce lot -- exactement le même statut que
--     menu_categories.is_active avant v1.1 (voir en-tête).
-- ------------------------------------------------------------------
alter table public.menu_subcategories
  add column if not exists is_active boolean not null default true;

comment on column public.menu_subcategories.is_active is
  'OPERATOR CATALOGUE RESET v1.1 -- symétrique de menu_categories.is_active. false = sous-catégorie RETENUE par un reset (portait au moins un produit, même archivé) mais désactivée -- jamais réutilisée par un import ultérieur (voir lib/catalogue-import/resolution.ts), jamais affichée comme active. Ni create_subcategory ni update_subcategory ne modifient cette colonne (toujours true à la création, même patron que create_category/menu_categories.is_active).';

-- Index unique reconstruit à l'IDENTIQUE, EXCEPTÉ l'ajout de
-- `where is_active = true` -- même patron que
-- idx_menu_categories_unique_active_name (migration-v66), qui permet
-- DÉJÀ à une catégorie active et une catégorie inactive de partager
-- le même nom pour un même restaurant. create_subcategory capture
-- `unique_violation` par SQLSTATE (23505), jamais par nom d'index --
-- ce changement est totalement transparent pour son comportement.
drop index if exists public.idx_menu_subcategories_unique_name;
create unique index idx_menu_subcategories_unique_name
  on public.menu_subcategories (category_id, lower(btrim(name, E' \t\n\r\f' || chr(11))))
  where is_active = true;

-- ------------------------------------------------------------------
-- 1c. get_merchant_catalogue -- extension STRICTEMENT ADDITIVE (2
--     colonnes ajoutées EN FIN de returns table, rien d'existant
--     déplacé/retiré/renommé) : `category_is_active`,
--     `subcategory_is_active`. Corps repris de la définition la PLUS
--     RÉCENTE avant ce lot dans la chaîne réelle -- celle de
--     DRAFT-lot-catalogue-operator-authorization-v1.sql (OB-2 v1.1,
--     qui ajoute le bypass `is_scanym_operator()` sur l'autorisation
--     -- s'applique APRÈS subcategories-backoffice-v1 mais AVANT ce
--     fichier), PAS celle de subcategories-backoffice-v1.sql qui l'a
--     précédée -- toute copie de la mauvaise version régresserait le
--     bypass opérateur (détecté et corrigé via le harnais réel,
--     section [N], "get_merchant_catalogue reste utilisable après
--     reset" échouait 42501 pour un appelant opérateur seul). Corps
--     INCHANGÉ au-delà de ces 2 valeurs supplémentaires portées par
--     la CTE `groups` puis le SELECT final -- même patron d'extension
--     additive déjà appliqué par v43/v66/v67/v67b/v81-lot1b/
--     subcategories-backoffice-v1/fiscal-measurements/operator-
--     authorization-v1.1 à cette même fonction. Nécessaire pour que
--     lib/catalogue-import/
--     resolution.ts puisse ignorer toute catégorie/sous-catégorie
--     désactivée par un reset lors de la résolution d'un import
--     ultérieur (voir en-tête, "RISQUE IDENTIFIÉ ET CORRIGÉ").
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
  reference_price_per_kg       numeric,
  category_is_active           boolean,
  subcategory_is_active        boolean
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

  -- OB-2 v1.1 : owner/manager/staff-membre DU restaurant (contrat
  -- préservé À L'IDENTIQUE), OU opérateur Scanym global (bypass
  -- inconditionnel) -- CONSERVÉ tel quel par ce lot (DRAFT-lot-
  -- catalogue-operator-authorization-v1.sql s'applique AVANT ce
  -- fichier dans la chaîne de migration ; copier la version
  -- antérieure, sans ce bypass, aurait RÉGRESSÉ l'accès opérateur à
  -- get_merchant_catalogue -- détecté et corrigé via le harnais réel,
  -- section [N]).
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
           ms.name::text as subcategory_name, ms.display_order as subcategory_display_order,
           ms.is_active as subcategory_is_active
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order,
           null::boolean as subcategory_is_active
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
         mi.tax_rate, mi.unit_weight_grams, mi.weight_is_approximate, mi.reference_price_per_kg,
         mc.is_active, g.subcategory_is_active
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
-- 2. preview_catalogue_reset -- LECTURE SEULE, aucune mutation.
--    Répétable sans effet de bord (mandat §6, "Repeated preview: NO
--    mutation"). v1.1 : + categories_active_after_reset/
--    subcategories_active_after_reset (mandat v1.1 §5).
-- ------------------------------------------------------------------
create or replace function public.preview_catalogue_reset(
  p_restaurant_id uuid
)
returns table (
  restaurant_id            uuid,
  active_products_count    integer,
  archived_products_count  integer,
  subcategories_total      integer,
  subcategories_removable  integer,
  subcategories_retained   integer,
  categories_total         integer,
  categories_removable     integer,
  categories_retained      integer,
  products_with_order_history integer,
  categories_active_after_reset    integer,
  subcategories_active_after_reset integer
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

  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized: Scanym operator required';
  end if;

  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;

  return query
  select
    p_restaurant_id,
    (select count(*)::integer from public.menu_items mi
       join public.menu_categories mc on mc.id = mi.category_id
       where mc.restaurant_id = p_restaurant_id and mi.archived_at is null),
    (select count(*)::integer from public.menu_items mi
       join public.menu_categories mc on mc.id = mi.category_id
       where mc.restaurant_id = p_restaurant_id and mi.archived_at is not null),
    (select count(*)::integer from public.menu_subcategories ms
       join public.menu_categories mc on mc.id = ms.category_id
       where mc.restaurant_id = p_restaurant_id),
    (select count(*)::integer from public.menu_subcategories ms
       join public.menu_categories mc on mc.id = ms.category_id
       where mc.restaurant_id = p_restaurant_id
         and not exists (select 1 from public.menu_items mi where mi.subcategory_id = ms.id)),
    (select count(*)::integer from public.menu_subcategories ms
       join public.menu_categories mc on mc.id = ms.category_id
       where mc.restaurant_id = p_restaurant_id
         and exists (select 1 from public.menu_items mi where mi.subcategory_id = ms.id)),
    (select count(*)::integer from public.menu_categories mc
       where mc.restaurant_id = p_restaurant_id),
    (select count(*)::integer from public.menu_categories mc
       where mc.restaurant_id = p_restaurant_id
         and not exists (select 1 from public.menu_items mi where mi.category_id = mc.id)
         and not exists (select 1 from public.menu_subcategories ms where ms.category_id = mc.id)),
    (select count(*)::integer from public.menu_categories mc
       where mc.restaurant_id = p_restaurant_id
         and (
           exists (select 1 from public.menu_items mi where mi.category_id = mc.id)
           or exists (select 1 from public.menu_subcategories ms where ms.category_id = mc.id)
         )),
    -- Signal optionnel "cheaply available" (mandat §6) : nombre de
    -- produits ACTIFS de ce restaurant qui apparaissent déjà dans au
    -- moins une commande historique de CE MÊME restaurant --
    -- jointure scopée via orders.restaurant_id (idx_orders_restaurant_
    -- created déjà existant) PUIS order_items.order_id
    -- (idx_order_items_order déjà existant) : aucun nouvel index
    -- requis, aucun scan de order_items hors du périmètre du
    -- restaurant ciblé.
    (select count(distinct mi.id)::integer from public.menu_items mi
       join public.menu_categories mc on mc.id = mi.category_id
       where mc.restaurant_id = p_restaurant_id
         and mi.archived_at is null
         and exists (
           select 1 from public.order_items oi
           join public.orders o on o.id = oi.order_id
           where o.restaurant_id = p_restaurant_id
             and (oi.menu_item_id = mi.id or oi.option_item_id = mi.id)
         )),
    -- v1.1 -- TOUJOURS 0 : chaque catégorie/sous-catégorie RETENUE
    -- (structurellement non-vide) est désactivée SANS CONDITION par
    -- reset_merchant_catalogue (une simple colonne booléenne n'a
    -- aucune dépendance de sécurité qui pourrait un jour empêcher
    -- cette désactivation, contrairement à une suppression physique)
    -- -- voir en-tête de ce fichier, section v1.1 point 2. Littéral
    -- documenté plutôt que dérivé : si cette invariance devait un
    -- jour changer, ce commentaire est le point d'entrée évident pour
    -- la corriger.
    0,
    0;
end $$;

-- ------------------------------------------------------------------
-- 3. reset_merchant_catalogue -- MUTATION, transactionnelle (corps de
--    fonction PL/pgSQL = une seule transaction implicite), scopée à
--    p_restaurant_id à CHAQUE instruction, sans exception. v1.1 :
--    exige désormais `p_confirmation_phrase`, dérivée et comparée
--    EXCLUSIVEMENT côté serveur (voir en-tête, point 1) ; désactive
--    (jamais ne supprime) chaque ligne structurelle retenue (voir
--    en-tête, point 2).
-- ------------------------------------------------------------------
drop function if exists public.reset_merchant_catalogue(uuid);

create or replace function public.reset_merchant_catalogue(
  p_restaurant_id uuid,
  p_confirmation_phrase text
)
returns table (
  restaurant_id            uuid,
  products_archived        integer,
  subcategories_removed    integer,
  subcategories_retained   integer,
  categories_removed       integer,
  categories_retained      integer,
  categories_active_after_reset    integer,
  subcategories_active_after_reset integer,
  historical_orders_preserved boolean,
  result                   text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_name        text;
  v_expected_phrase         text;
  v_confirmation_ok         boolean;
  v_products_archived       integer := 0;
  v_subcategories_removed   integer := 0;
  v_subcategories_retained  integer := 0;
  v_categories_removed      integer := 0;
  v_categories_retained     integer := 0;
  v_categories_deactivated  integer := 0;
  v_subcategories_deactivated integer := 0;
  v_categories_active_after    integer := 0;
  v_subcategories_active_after integer := 0;
  v_result                  text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  -- Operator-only, AUCUN repli owner/manager -- action Operator
  -- Backoffice, jamais une auto-réinitialisation marchand (mandat §8,
  -- "Unauthorized users: FAIL CLOSED").
  if not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized: Scanym operator required';
  end if;

  select r.name into v_restaurant_name
  from public.restaurants r where r.id = p_restaurant_id;

  if v_restaurant_name is null then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;

  -- v1.1 -- CONFIRMATION SERVEUR (mandat v1.1 §1) : la phrase
  -- attendue est dérivée ICI, exclusivement à partir du nom ACTUEL du
  -- marchand tel que stocké en base -- JAMAIS depuis une valeur
  -- fournie par le client. Seuls les espaces de bordure de la saisie
  -- opérateur sont ignorés (btrim) ; aucune autre normalisation
  -- (casse, espaces internes) -- comparaison EXACTE et littérale.
  v_expected_phrase := 'RESET ' || btrim(v_restaurant_name, E' \t\n\r\f' || chr(11));
  v_confirmation_ok := (
    btrim(coalesce(p_confirmation_phrase, ''), E' \t\n\r\f' || chr(11)) = v_expected_phrase
  );

  if not v_confirmation_ok then
    -- FAIL CLOSED : zéro mutation, zéro archivage, zéro suppression
    -- structurelle, zéro événement "completed"/"no_op" -- mais un
    -- événement d'audit DÉDIÉ est quand même écrit (voir en-tête,
    -- note technique sur le choix RETURN plutôt que RAISE pour ce cas
    -- précis) : traçabilité complète de toute tentative de reset,
    -- confirmée ou non, y compris un éventuel appel RPC direct
    -- contournant l'UI (mandat v1.1 §2.F).
    select count(*)::integer into v_categories_active_after
    from public.menu_categories mc
    where mc.restaurant_id = p_restaurant_id and mc.is_active = true;

    select count(*)::integer into v_subcategories_active_after
    from public.menu_subcategories ms
    join public.menu_categories mc on mc.id = ms.category_id
    where mc.restaurant_id = p_restaurant_id and ms.is_active = true;

    insert into public.catalogue_reset_audit_log (
      restaurant_id, operator_user_id, products_archived,
      subcategories_removed, subcategories_retained,
      categories_removed, categories_retained,
      categories_active_after_reset, subcategories_active_after_reset,
      result
    ) values (
      p_restaurant_id, auth.uid(), 0,
      0, 0,
      0, 0,
      v_categories_active_after, v_subcategories_active_after,
      'rejected_confirmation'
    );

    return query select
      p_restaurant_id, 0, 0,
      0, 0, 0,
      v_categories_active_after, v_subcategories_active_after,
      true, 'rejected_confirmation'::text;
    return;
  end if;

  -- ÉTAPE 1 -- Archivage produits (mandat §11). JAMAIS de suppression
  -- physique. Recalculé fraîchement ici, jamais depuis un Preview
  -- potentiellement obsolète (mandat §10, "Do not rely only on stale
  -- preview counts").
  update public.menu_items mi
  set archived_at = now(), is_available = false
  where mi.archived_at is null
    and mi.category_id in (
      select mc.id from public.menu_categories mc where mc.restaurant_id = p_restaurant_id
    );
  get diagnostics v_products_archived = row_count;

  -- ÉTAPE 2 -- Sous-catégories : suppression physique UNIQUEMENT si
  -- structurellement vides (mandat §12, "remove only if safe"). ON
  -- DELETE SET NULL protège de toute façon tout produit qui y
  -- resterait malgré tout rattaché -- défense en profondeur, jamais
  -- invoquée en pratique ici puisque la clause NOT EXISTS exclut déjà
  -- ce cas.
  delete from public.menu_subcategories ms
  where ms.category_id in (
      select mc.id from public.menu_categories mc where mc.restaurant_id = p_restaurant_id
    )
    and not exists (select 1 from public.menu_items mi where mi.subcategory_id = ms.id);
  get diagnostics v_subcategories_removed = row_count;

  -- ÉTAPE 2b (v1.1) -- Sous-catégories RETENUES : désactivées, jamais
  -- supprimées (mandat v1.1 §2/§5, "clean import must not accidentally
  -- reuse unwanted legacy structure"). Scopée `is_active = true` :
  -- naturellement idempotente (un second appel ne trouve plus rien à
  -- désactiver).
  update public.menu_subcategories ms
  set is_active = false
  where ms.category_id in (
      select mc.id from public.menu_categories mc where mc.restaurant_id = p_restaurant_id
    )
    and ms.is_active = true;
  get diagnostics v_subcategories_deactivated = row_count;

  select count(*) into v_subcategories_retained
  from public.menu_subcategories ms
  join public.menu_categories mc on mc.id = ms.category_id
  where mc.restaurant_id = p_restaurant_id;

  -- ÉTAPE 3 -- Catégories : suppression physique UNIQUEMENT si
  -- structurellement vides de produits ET de sous-catégories (mandat
  -- §13, "remove only if... empty/safe... Do not cascade blindly").
  -- Une catégorie encore peuplée (produits archivés compris) est
  -- TOUJOURS retenue -- ON DELETE CASCADE sur menu_items rendrait
  -- sinon cette suppression équivalente à une suppression physique de
  -- produit, interdite (mandat §2).
  delete from public.menu_categories mc
  where mc.restaurant_id = p_restaurant_id
    and not exists (select 1 from public.menu_items mi where mi.category_id = mc.id)
    and not exists (select 1 from public.menu_subcategories ms where ms.category_id = mc.id);
  get diagnostics v_categories_removed = row_count;

  -- ÉTAPE 3b (v1.1) -- Catégories RETENUES : désactivées, jamais
  -- supprimées. Même garantie/idempotence que l'étape 2b.
  update public.menu_categories mc
  set is_active = false
  where mc.restaurant_id = p_restaurant_id
    and mc.is_active = true;
  get diagnostics v_categories_deactivated = row_count;

  select count(*) into v_categories_retained
  from public.menu_categories mc
  where mc.restaurant_id = p_restaurant_id;

  -- v1.1 -- État actif final (mandat v1.1 §5) : toujours 0/0 après un
  -- reset qui s'exécute réellement, calculé ici honnêtement plutôt
  -- que supposé -- voir aussi le commentaire équivalent dans
  -- preview_catalogue_reset ci-dessus.
  select count(*)::integer into v_categories_active_after
  from public.menu_categories mc
  where mc.restaurant_id = p_restaurant_id and mc.is_active = true;

  select count(*)::integer into v_subcategories_active_after
  from public.menu_subcategories ms
  join public.menu_categories mc on mc.id = ms.category_id
  where mc.restaurant_id = p_restaurant_id and ms.is_active = true;

  -- ÉTAPE 4 -- Idempotency (mandat §16) : un second appel ne trouve
  -- plus rien à muter -> 'no_op', jamais d'échec, jamais de double
  -- comptage. v1.1 : la désactivation (étapes 2b/3b) fait DÉSORMAIS
  -- elle aussi partie de cette détermination -- un catalogue déjà
  -- archivé manuellement (via archive_product) AVANT tout premier
  -- reset, mais dont les catégories/sous-catégories étaient encore
  -- `is_active = true`, effectue un premier travail réel (la
  -- désactivation) même si products_archived/*_removed valent 0 :
  -- ce cas doit être rapporté comme 'completed', jamais comme un
  -- 'no_op' trompeur.
  if v_products_archived = 0 and v_subcategories_removed = 0 and v_categories_removed = 0
     and v_subcategories_deactivated = 0 and v_categories_deactivated = 0 then
    v_result := 'no_op';
  else
    v_result := 'completed';
  end if;

  -- ÉTAPE 5 -- Audit (mandat §14), même transaction implicite --
  -- écrit même pour un 'no_op' (traçabilité complète : un opérateur a
  -- bien déclenché ce reset à cet instant, même si rien n'a changé).
  insert into public.catalogue_reset_audit_log (
    restaurant_id, operator_user_id, products_archived,
    subcategories_removed, subcategories_retained,
    categories_removed, categories_retained,
    categories_active_after_reset, subcategories_active_after_reset,
    result
  ) values (
    p_restaurant_id, auth.uid(), v_products_archived,
    v_subcategories_removed, v_subcategories_retained,
    v_categories_removed, v_categories_retained,
    v_categories_active_after, v_subcategories_active_after,
    v_result
  );

  return query select
    p_restaurant_id, v_products_archived, v_subcategories_removed,
    v_subcategories_retained, v_categories_removed, v_categories_retained,
    v_categories_active_after, v_subcategories_active_after,
    true, v_result;
end $$;

-- ------------------------------------------------------------------
-- 4. Droits d'exécution -- même patron que toutes les RPC du domaine
--    catalogue : revoke large, grant ciblé authenticated seulement
--    (l'autorisation réelle reste vérifiée DANS le corps, jamais
--    déléguée au GRANT -- un compte authenticated non-opérateur
--    échoue toujours avec 42501).
-- ------------------------------------------------------------------
revoke all on function public.preview_catalogue_reset(uuid) from public, anon;
revoke all on function public.reset_merchant_catalogue(uuid, text) from public, anon;
grant execute on function public.preview_catalogue_reset(uuid) to authenticated;
grant execute on function public.reset_merchant_catalogue(uuid, text) to authenticated;

-- ------------------------------------------------------------------
-- 5. VÉRIFICATION POST-APPLICATION -- un échec ici déclenche un
--    ROLLBACK automatique complet (aucune modification partielle ne
--    peut jamais rester commitée).
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  -- v1.1 -- l'ANCIENNE signature à 1 argument (sans confirmation) ne
  -- doit JAMAIS exister -- sinon un appelant pourrait la cibler pour
  -- contourner la confirmation serveur (mandat v1.1 §1/§2.F).
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_merchant_catalogue' and p.pronargs = 1
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une signature reset_merchant_catalogue(uuid) à 1 argument existe encore -- contournerait la confirmation serveur v1.1.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_merchant_catalogue' and p.pronargs = 2
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: reset_merchant_catalogue(uuid, text) introuvable.';
  end if;

  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('preview_catalogue_reset', 'reset_merchant_catalogue')
  loop
    if v_def not ilike '%is_scanym_operator%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une des 2 fonctions ne référence pas is_scanym_operator.';
    end if;
    -- Motif STRICT (immédiatement adjacent : "delete from"/"delete
    -- from public." suivi SANS RIEN ENTRE des deux directement par
    -- "menu_items") -- volontairement PAS un simple "%delete
    -- from%menu_items%", qui ferait un faux positif sur nos propres
    -- "delete from public.menu_categories ... where not exists
    -- (select 1 from public.menu_items ...)" légitimes (ILIKE avec
    -- % ignore les frontières d'instruction). Ce motif strict ne
    -- matche que "delete from [public.]menu_items", jamais un DELETE
    -- FROM menu_categories/menu_subcategories qui référence
    -- menu_items plus loin dans une sous-requête.
    if v_def ilike '%delete from menu_items%'
       or v_def ilike '%delete from public.menu_items%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: suppression physique de menu_items détectée -- interdit par ce lot.';
    end if;
  end loop;

  -- v1.1 -- reset_merchant_catalogue doit référencer explicitement le
  -- paramètre de confirmation ET dériver la phrase depuis
  -- restaurants.name (jamais un raccourci qui ignorerait le
  -- paramètre).
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reset_merchant_catalogue' and p.pronargs = 2;
  if v_def not ilike '%p_confirmation_phrase%' or v_def not ilike '%r.name%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: reset_merchant_catalogue ne dérive pas la phrase de confirmation depuis restaurants.name.';
  end if;

  -- v1.1 -- get_merchant_catalogue doit exposer les 2 nouvelles
  -- colonnes is_active (import-safety, voir en-tête).
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_merchant_catalogue';
  if v_def not ilike '%category_is_active%' or v_def not ilike '%subcategory_is_active%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_catalogue n''expose pas category_is_active/subcategory_is_active.';
  end if;

  for v_def in
    select pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('preview_catalogue_reset', 'reset_merchant_catalogue', 'get_merchant_catalogue')
  loop
    if v_def not like 'postgres|true|%search_path=%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: SECURITY DEFINER/search_path/owner inattendu -- %', v_def;
    end if;
  end loop;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'catalogue_reset_audit_log' and c.relrowsecurity
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non activée sur catalogue_reset_audit_log.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_subcategories' and column_name = 'is_active'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_subcategories.is_active introuvable.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'idx_menu_subcategories_unique_name'
      and indexdef ilike '%where%is_active%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: idx_menu_subcategories_unique_name n''est pas un index partiel sur is_active.';
  end if;
end $$;

-- ============================================================
-- FIN — OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1.1
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur Production par ce lot.
-- Preuve d'exécution réelle : supabase/tests/operator-catalogue-
-- reset-v1-check.sh (PostgreSQL réel, base jetable locale, jamais
-- Production).
-- ============================================================
