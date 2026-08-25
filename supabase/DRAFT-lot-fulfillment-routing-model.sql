-- ============================================================
-- Scanym — FULFILLMENT ROUTING LOT A / A.1 (DRAFT — NON APPLIQUÉ EN
-- PRODUCTION) — Modèle de données uniquement.
--
-- LOT A.1 (contre-audit Work, aucun SQL exécuté en Production) —
-- corrections ciblées apportées à ce fichier par rapport à Lot A :
--   FRA-A-01 (HIGH)   : zone_prefixes accepte désormais UNIQUEMENT un
--                       tableau sans élément NULL ni vide/blanc-seul,
--                       via un helper SQL minimal (justifié plus bas).
--   FRA-A-02 (MEDIUM) : contrat de privilèges rendu déterministe et
--                       explicite pour PUBLIC/anon/authenticated/
--                       service_role (CRUD complet pour service_role,
--                       aucun privilège dangereux pour personne).
--   FRA-A-03 (MEDIUM) : voir le harnais de test — matrice ACL complète
--                       testée pour les 4 rôles × 8 privilèges, sans
--                       jamais utiliser current_user comme preuve de
--                       substitution pour service_role.
--
-- Objet : introduire le modèle générique
--   Sale Mode -> Fulfillment -> Provider
-- validé par le CIO dans RAPPORT-FULFILLMENT-ROUTING-DESIGN.md.
--
-- Le client ne choisit toujours QUE le sale mode (pickup/delivery).
-- Le routage derrière "delivery" (quel fulfillment, quel provider)
-- devient piloté par configuration au niveau ÉTABLISSEMENT, jamais
-- codé en dur au niveau géographique. Aucun nom de ville, de pays ni
-- d'aucune zone géographique réelle n'apparaît dans ce fichier : les
-- préfixes de zone sont une donnée de configuration tenant, jamais
-- une constante du moteur générique.
--
-- Portée STRICTE de ce lot (voir mission complète) :
--   - migration DRAFT (ce fichier)
--   - table restaurant_sale_mode_fulfillments
--   - contraintes (PK, unique, CHECK, FK composite, index partiel)
--   - RLS
--   - privilèges (GRANT/REVOKE durcis dès la création, cf. leçon
--     SEC-2A3-01 / migration-v83-lot2a4-privilege-hardening.sql)
--   - UN SEUL helper SQL, strictement nécessaire (FRA-A-01,
--     Lot A.1) : validation de zone_prefixes. Fonction pure,
--     IMMUTABLE, sans SECURITY DEFINER, non exposée à PUBLIC/anon/
--     authenticated — voir justification complète au point de
--     définition ci-dessous (PostgreSQL interdit les sous-requêtes
--     dans une contrainte CHECK inline, ce qui rend une fonction
--     strictement nécessaire pour cette validation élément-par-
--     élément, pas un choix de confort).
--   - AUCUNE RPC publique, AUCUNE modification create_order/orders,
--     AUCUN runtime frontend, AUCUNE configuration Au Lait Cru ou
--     Sanaa installée, AUCUN appel Stuart/Chronofresh.
--
-- Compatibilité : ce fichier est 100% ADDITIF. Il ne modifie, ne
-- lit ni n'altère restaurant_sale_modes, sale_mode_catalog, orders,
-- ni aucune RPC existante. Aucun comportement visible ne change pour
-- un tenant existant (Au Lait Cru, Sanaa, Illico, Sirocco...) tant
-- qu'aucune ligne n'est insérée dans cette nouvelle table — ce que ce
-- lot ne fait délibérément jamais (voir section "Aucune donnée
-- tenant" plus bas).
--
-- ⚠️ NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION. Testable
-- uniquement dans le harnais PostgreSQL jetable
-- (supabase/tests/fulfillment-routing-lot-a-check.sh).
-- ============================================================

-- ------------------------------------------------------------------
-- Contrôle préalable (anti-dérive) : le prérequis structurel
-- (restaurant_sale_modes, LOT 2A) doit déjà exister, et la nouvelle
-- table ne doit PAS déjà exister (empêche une double application
-- accidentelle de ce DRAFT).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_modes')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_modes introuvable — prérequis LOT 2A manquant, DRAFT fulfillment routing annulé.';
  end if;

  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_users')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_users introuvable — prérequis (RLS membre) manquant, DRAFT fulfillment routing annulé.';
  end if;

  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_mode_fulfillments')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_mode_fulfillments existe déjà — DRAFT fulfillment routing déjà appliqué, application annulée pour éviter une double définition.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------
-- Helper de validation STRICTEMENT nécessaire (FRA-A-01, contre-audit
-- Work) : garantit que zone_prefixes ne peut jamais contenir un
-- élément NULL ou "vide après trim" (y compris un élément composé
-- uniquement d'espaces/tabulations/autres blancs). Sans cette
-- garantie, un préfixe vide ('') deviendrait une correspondance
-- universelle dans les comparaisons de préfixe déjà utilisées
-- ailleurs dans le codebase (`code.startsWith(prefix)` côté
-- TypeScript, `v_postal like p || '%'` côté SQL) — un défaut de
-- sécurité/correction réel, pas hypothétique.
--
-- Pourquoi une fonction et NON une simple contrainte CHECK inline :
-- vérifié empiriquement dans ce lot, PostgreSQL refuse catégoriquement
-- toute sous-requête dans une contrainte CHECK, y compris une
-- sous-requête non corrélée portant uniquement sur la colonne de la
-- ligne elle-même (`ERROR: cannot use subquery in check constraint`).
-- Or valider "chaque élément du tableau" nécessite d'itérer via
-- unnest(), ce qui exige une sous-requête (EXISTS/NOT EXISTS sur
-- unnest()). Aucune expression scalaire pure (sans sous-requête) ne
-- permet cette itération élément par élément en PostgreSQL. Une
-- fonction SQL est donc STRICTEMENT nécessaire ici, pas un choix de
-- confort — le corps de la fonction peut contenir une sous-requête
-- (seule la contrainte CHECK elle-même ne le peut pas).
--
-- Conception délibérément minimale :
--   - LANGUAGE SQL (pas PL/pgSQL) : la logique est une unique requête,
--     aucun contrôle de flux n'est nécessaire.
--   - IMMUTABLE : dépend uniquement de son argument, aucun accès à
--     une autre table ni au contexte de session — condition
--     nécessaire pour qu'elle soit utilisable dans une contrainte
--     CHECK au demeurant.
--   - PAS de SECURITY DEFINER : elle ne lit ni n'écrit aucune donnée,
--     n'a besoin d'aucun privilège élevé — SECURITY DEFINER serait une
--     élévation de privilège injustifiée pour une fonction pure.
--   - Pas de search_path à fixer explicitement : elle ne référence
--     aucun objet non qualifié par un schéma (uniquement des fonctions
--     du catalogue système toujours résolues sans ambiguïté), donc
--     aucune surface de détournement par manipulation de search_path.
--   - btrim() seul ne suffit PAS : il ne retire que les espaces par
--     défaut (sans second argument), pas les tabulations ni autres
--     blancs — vérifié empiriquement (un élément composé uniquement
--     d'une tabulation passait à tort). La détection utilise donc le
--     motif regex '^\s*$' (vide ou uniquement blancs, toutes classes
--     de blancs confondues) plutôt que btrim() seul.
--   - Aucune ville, aucun format de code postal particulier : la
--     fonction ne valide qu'une propriété STRUCTURELLE (non-vide,
--     non-blanc), jamais un format géographique réel — le modèle
--     reste 100% ville-agnostique.
create or replace function public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(p text[])
returns boolean
language sql
immutable
as $func$
  select p is not null
     and not exists (
       select 1 from unnest(p) as v(x)
       where x is null or x ~ '^\s*$'
     );
$func$;

comment on function public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[]) is
  'FRA-A-01 — valide qu''un tableau zone_prefixes ne contient aucun élément NULL ni vide/blanc-seul après normalisation. Fonction pure, IMMUTABLE, sans SECURITY DEFINER, sans accès table. Utilisée uniquement par la contrainte CHECK de restaurant_sale_mode_fulfillments.';

-- Aucune exposition inutile : ni PUBLIC, ni anon, ni authenticated
-- n'ont besoin d'appeler cette fonction directement (ils n'écrivent
-- jamais dans restaurant_sale_mode_fulfillments, voir le bloc
-- privilèges plus bas) — seul service_role écrit, et l'EXECUTE lui
-- est donc accordé explicitement (vérifié empiriquement : sans ce
-- GRANT, le rôle exécutant l'INSERT/UPDATE obtient une erreur
-- "permission denied for function", même s'il a INSERT sur la table
-- — l'évaluation de la contrainte CHECK exige EXECUTE sur toute
-- fonction qu'elle invoque).
revoke all on function public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[]) from public, anon, authenticated;
grant execute on function public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(text[]) to service_role;

-- ------------------------------------------------------------
-- Table cible : une ligne = une règle de routage fulfillment pour
-- un (restaurant_id, mode_code) donné. restaurant_sale_modes garde
-- SA cardinalité actuelle inchangée : une ligne = un sale mode activé
-- pour un établissement (PK (restaurant_id, mode_code), toujours
-- vraie, non touchée par ce fichier). Cette nouvelle table est un
-- SIBLING additif qui permet 0..N règles de routage par sale mode,
-- résolvant le blocage structurel identifié dans
-- RAPPORT-ALC-FULFILLMENT-ROUTING-ANALYSIS.md (aujourd'hui un seul
-- provider scalaire par mode) SANS jamais créer de second sale mode
-- nommé d'après une zone géographique ou un prestataire, et SANS
-- jamais transformer un provider en sale mode.
-- ------------------------------------------------------------

create table public.restaurant_sale_mode_fulfillments (
  -- Clé de substitution : justifiée par la cardinalité multiple
  -- (0..N lignes par (restaurant_id, mode_code)) et cohérente avec
  -- le reste du schéma (orders, menu_categories, menu_items,
  -- restaurants utilisent tous une PK de substitution).
  id              uuid primary key default gen_random_uuid(),

  restaurant_id   uuid not null,
  mode_code       text not null,

  -- Identifiant du TYPE de fulfillment (ex. 'local_delivery',
  -- 'refrigerated_shipping'...). DÉCISION (voir RAPPORT §4/§7) :
  -- texte libre avec contrainte de forme minimale uniquement, PAS
  -- d'énumération CHECK fermée et PAS de table catalogue séparée
  -- dans ce lot. Un CHECK IN (...) recréerait exactement l'anti-
  -- patron "vocabulaire figé prématurément" que ce lot doit éviter
  -- (le jour où Scanym ajoute un 3e type de fulfillment, une
  -- migration serait nécessaire juste pour l'énumération). Une table
  -- catalogue séparée est une option B légitime mais non justifiée
  -- ici : rien dans ce lot n'a besoin de métadonnées par type de
  -- fulfillment (libellé, icône...) au-delà du code lui-même — cette
  -- décision est documentée pour ré-évaluation si ce besoin apparaît
  -- (Lot B ou ultérieur).
  fulfillment_code text not null
                   check (btrim(fulfillment_code) <> '' and length(fulfillment_code) <= 60),

  -- Vocabulaire IDENTIQUE (dupliqué, pas partagé) à
  -- restaurant_sale_modes.provider. DÉCISION (RAPPORT §8) : ce lot
  -- NE refactore PAS restaurant_sale_modes.provider même si une dette
  -- de duplication existe désormais entre les deux CHECK — la mission
  -- interdit explicitement de toucher à la table existante dans ce
  -- lot. Une éventuelle table catalogue provider commune est une
  -- recommandation FUTURE, documentée ici, non implémentée.
  provider        text not null default 'internal'
                  check (provider in ('internal', 'stuart', 'chronofresh', 'other_external')),

  -- Zone ciblée par cette règle, sous forme de préfixes de code
  -- postal (ou tout autre motif texte tenant-spécifique). AUCUNE
  -- valeur n'est insérée par ce lot — ce tableau reste vide pour
  -- toute ligne créée par ce fichier (ce fichier n'insère aucune
  -- ligne du tout, voir plus bas). Le contrat "tableau vide = aucune
  -- restriction de zone déclarée par cette règle" est délibérément
  -- distinct du contrat is_fallback (voir plus bas) : une règle non
  -- fallback avec zone_prefixes vide n'est PAS automatiquement
  -- éligible à tout — la sémantique d'évaluation (résolution) est
  -- hors périmètre de ce lot (Lot B), ce lot ne fait que rendre la
  -- donnée représentable proprement.
  -- FRA-A-01 : chaque élément doit être non NULL et non vide/blanc
  -- après normalisation — voir le helper
  -- restaurant_sale_mode_fulfillments_zone_prefixes_valid ci-dessus
  -- pour la justification complète (pourquoi une fonction, pas une
  -- contrainte inline). Le tableau vide reste explicitement valide.
  zone_prefixes   text[] not null default '{}'::text[]
                  check (public.restaurant_sale_mode_fulfillments_zone_prefixes_valid(zone_prefixes)),

  -- Drapeau de repli EXPLICITE. DÉCISION (RAPPORT §5) : "aucune règle
  -- ne correspond" doit rester structurellement distinct de "une
  -- règle de repli explicite a été configurée et a matché" — jamais
  -- une confusion implicite entre "pas de correspondance" et
  -- "fallback". Ce boolean rend le fallback une donnée de premier
  -- ordre, jamais déduite. Au plus UNE règle fallback par
  -- (restaurant_id, mode_code) — garanti par l'index unique partiel
  -- ci-dessous, pas seulement documenté.
  is_fallback     boolean not null default false,

  -- Nombre minimum d'articles pour que cette règle soit applicable.
  -- Nullable = pas de contrainte de minimum pour cette règle
  -- (cohérent avec le comportement actuel de delivery_min_items,
  -- qui n'impose pas de minimum par défaut). Pas de minimum implicite
  -- inventé par ce lot.
  min_items       integer check (min_items is null or min_items >= 0),

  -- Texte optionnel spécifique à CETTE règle (ex. "Livraison
  -- réfrigérée sous 48h"). Le texte général pickup/delivery reste
  -- exclusivement sur restaurant_sale_modes.customer_text — cette
  -- colonne ne le duplique ni ne le remplace. Même limite de longueur
  -- que restaurant_sale_modes.customer_text pour rester cohérent.
  customer_text   text check (customer_text is null or length(customer_text) <= 500),

  -- Ordre de résolution déterministe entre plusieurs règles d'un même
  -- (restaurant_id, mode_code). Jamais négatif (évite toute ambiguïté
  -- de tri). Unicité forcée via la contrainte unique ci-dessous plutôt
  -- que documentée seulement.
  display_order   integer not null default 0
                  check (display_order >= 0),

  -- Activation de LA RÈGLE elle-même. IMPORTANT (RAPPORT §12,
  -- documenté explicitement pour Lot B) : cette colonne ne garantit
  -- PAS que le sale mode parent est utilisable — la FK composite
  -- ci-dessous garantit uniquement l'EXISTENCE du sale mode parent,
  -- jamais son état d'activation. Une règle enabled=true rattachée à
  -- un restaurant_sale_modes.enabled=false ne doit jamais, par
  -- construction future, rendre le mode utilisable : c'est au futur
  -- résolveur (Lot B, hors périmètre ici) de vérifier explicitement
  -- l'état du sale mode parent en plus de celui de la règle. Ce lot
  -- ne construit aucun résolveur et ne peut donc pas, par nature,
  -- introduire ce bug — mais le documente pour que Lot B ne
  -- l'introduise pas non plus.
  enabled         boolean not null default true,

  -- Résiduel JSONB, STRICTEMENT non structurel. DÉCISION (RAPPORT
  -- §11) : ne doit JAMAIS porter provider/zone_prefixes/enabled/
  -- display_order/fulfillment_code — ces données restent des colonnes
  -- typées ci-dessus, jamais dans ce champ. Nullable SANS défaut
  -- '{}', par cohérence stricte avec restaurant_sale_modes.config qui
  -- a exactement la même forme (nullable, pas de défaut) — pas de
  -- nouvelle convention introduite pour ce seul champ.
  config          jsonb,

  -- Pas de created_at/updated_at : les tables tenant-override sœurs
  -- de LOT 2A (restaurant_sale_mode_field_requirements) n'en ont pas
  -- non plus — cohérence délibérée avec ce précédent plutôt
  -- qu'introduction d'une nouvelle convention dans ce lot.

  -- Unicité de l'ordre d'affichage/résolution par (restaurant, mode) :
  -- deux règles ne peuvent jamais partager le même display_order pour
  -- le même sale mode d'un même établissement — élimine toute
  -- ambiguïté de tri à la source, pas seulement par convention
  -- applicative.
  constraint restaurant_sale_mode_fulfillments_order_unique
    unique (restaurant_id, mode_code, display_order),

  -- FK composite VERS LA CLÉ COMPOSITE de restaurant_sale_modes : une
  -- règle de routage ne peut exister sans son sale mode parent
  -- ACTIVÉ POUR CET ÉTABLISSEMENT (restaurant_sale_modes n'a une ligne
  -- que pour les sale modes que l'établissement a effectivement
  -- configurés). Aucun précédent de FK composite (multi-colonnes)
  -- n'existe ailleurs dans ce schéma avant ce lot (audité : toutes
  -- les FK existantes sont mono-colonne) — construction SQL standard,
  -- pas un nouveau patron de sécurité, documentée comme nouvelle pour
  -- ce codebase par transparence. ON DELETE CASCADE : si
  -- l'établissement supprime/retire un sale mode (ligne
  -- restaurant_sale_modes supprimée), ses règles de routage associées
  -- n'ont plus de sens et doivent disparaître avec lui plutôt que de
  -- laisser une ligne orpheline nécessitant un nettoyage manuel — même
  -- posture que la FK restaurant_id -> restaurants(id) on delete
  -- cascade déjà en place partout dans ce schéma pour les données de
  -- configuration tenant (par opposition aux données transactionnelles
  -- comme orders, qui utilisent restrict).
  constraint restaurant_sale_mode_fulfillments_sale_mode_fkey
    foreign key (restaurant_id, mode_code)
    references public.restaurant_sale_modes (restaurant_id, mode_code)
    on delete cascade
);

comment on table public.restaurant_sale_mode_fulfillments is
  'FULFILLMENT ROUTING LOT A — modèle générique (ville-agnostique) de règles de routage fulfillment/provider par sale mode et par établissement. 0..N lignes par (restaurant_id, mode_code) de restaurant_sale_modes, qui garde sa cardinalité 1 ligne par (restaurant_id, mode_code) inchangée. Aucune donnée tenant insérée par ce lot. Aucune RPC de résolution dans ce lot (Lot B).';

comment on column public.restaurant_sale_mode_fulfillments.zone_prefixes is
  'Préfixes de zone (ex. codes postaux) — donnée de configuration TENANT, jamais une valeur codée en dur dans le moteur. Aucune ville ni aucun préfixe réel n''est écrit par ce lot.';

comment on column public.restaurant_sale_mode_fulfillments.enabled is
  'Active/désactive CETTE règle uniquement. Ne garantit PAS que le sale mode parent (restaurant_sale_modes.enabled) est lui-même activé — à vérifier explicitement par tout futur résolveur (Lot B).';

-- Au plus UNE règle de repli explicite par (restaurant_id, mode_code)
-- — contrainte SQL réelle (index unique partiel), pas seulement
-- documentée/applicative.
create unique index restaurant_sale_mode_fulfillments_one_fallback
  on public.restaurant_sale_mode_fulfillments (restaurant_id, mode_code)
  where is_fallback;

-- Index de consultation : résolution par (établissement, sale mode),
-- filtrée typiquement par enabled et ordonnée par display_order. Pas
-- d'index supplémentaire au-delà de ce qui est réellement utile ici
-- (l'unicité (restaurant_id, mode_code, display_order) ci-dessus crée
-- déjà un index qui sert aussi ce filtrage).
create index idx_restaurant_sale_mode_fulfillments_lookup
  on public.restaurant_sale_mode_fulfillments (restaurant_id, mode_code, enabled);

-- ------------------------------------------------------------
-- RLS — patron répliqué EXACTEMENT depuis
-- restaurant_sale_mode_field_requirements / restaurant_sale_modes
-- (table tenant strictement privée, LOT 2A) : aucun accès public/anon
-- direct, authenticated limité à l'appartenance réelle via
-- restaurant_users, aucune écriture directe depuis le frontend dans
-- ce lot (aucune RPC ni mutation applicative n'existe encore pour
-- cette table — écritures réservées à service_role/migrations tant
-- que Lot B n'introduit pas de flux applicatif dédié et audité).
-- ------------------------------------------------------------

alter table public.restaurant_sale_mode_fulfillments enable row level security;

create policy "restaurant_sale_mode_fulfillments_select_member"
on public.restaurant_sale_mode_fulfillments for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.restaurant_id = restaurant_sale_mode_fulfillments.restaurant_id
      and ru.user_id = auth.uid()
  )
);

-- Aucune policy INSERT/UPDATE/DELETE pour authenticated ni anon :
-- aucun flux applicatif de mutation n'existe pour cette table dans ce
-- lot (aucune RPC, aucun frontend). Les écritures accordées à
-- service_role ci-dessous (contrat FRA-A-02) s'appuient sur la
-- convention Supabase standard où service_role porte l'attribut de
-- rôle BYPASSRLS au niveau plateforme (comportement identique à tout
-- projet Supabase, hors du périmètre de ce fichier de migration —
-- aucune policy RLS supplémentaire n'est donc requise ni ajoutée ici
-- pour service_role). Le harnais de test reproduit explicitement
-- cette convention plateforme pour vérifier le contrat réellement.

-- ------------------------------------------------------------
-- Privilèges — contrat DÉTERMINISTE, explicite pour CHAQUE rôle
-- (FRA-A-02/FRA-A-03, contre-audit Work) : PUBLIC et anon n'ont
-- STRICTEMENT AUCUN privilège ; authenticated a UNIQUEMENT SELECT
-- (isolation par la policy RLS ci-dessus) ; service_role a le CRUD
-- applicatif complet (SELECT/INSERT/UPDATE/DELETE) mais AUCUN
-- privilège dangereux (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). Ce
-- contrat ne dépend JAMAIS des privilèges par défaut d'une plateforme
-- (leçon SEC-2A3-01 / migration-v83-lot2a4-privilege-hardening.sql) —
-- ceinture et bretelles : REVOKE ALL explicite sur les 4 rôles
-- applicatifs, puis réaffirmation individuelle du strict nécessaire
-- pour chacun. Aucune preuve de ce contrat ne doit jamais s'appuyer
-- sur current_user/le propriétaire de la table (qui a toujours tous
-- les droits par défaut et ne prouve rien sur service_role — défaut
-- FRA-A-02 du harnais Lot A, corrigé ici et dans le harnais).
-- ------------------------------------------------------------

revoke all on public.restaurant_sale_mode_fulfillments from public, anon, authenticated, service_role;

-- authenticated : lecture seule, isolation stricte par la policy RLS
-- ci-dessus. Aucun droit d'écriture direct.
grant select on public.restaurant_sale_mode_fulfillments to authenticated;

-- service_role : CRUD applicatif complet. Ce lot ne crée encore
-- aucune RPC/mutation frontend — ces droits permettent à un futur
-- Lot B d'écrire via une fonction SECURITY DEFINER exécutée par
-- service_role, sans qu'une migration ultérieure doive revenir
-- modifier les privilèges de base de cette table.
grant select, insert, update, delete on public.restaurant_sale_mode_fulfillments to service_role;

-- Réaffirmation explicite "ceinture et bretelles" : même si le
-- REVOKE ALL ci-dessus a déjà retiré TRUNCATE/REFERENCES/TRIGGER pour
-- les 4 rôles, ce bloc garantit qu'aucun mécanisme de privilège par
-- défaut ne les réintroduit silencieusement plus tard — y compris
-- pour service_role, contrairement au patron v83 (LOT 2A.4) qui ne
-- restreignait pas service_role : le contrat FRA-A-02 l'exige
-- explicitement pour cette table.
revoke truncate, references, trigger on public.restaurant_sale_mode_fulfillments from public, anon, authenticated, service_role;

-- MAINTAIN (FRA-A-02/FRA-A-03) : privilège introduit par PostgreSQL
-- 17, INEXISTANT sur PostgreSQL 16 et antérieur — vérifié
-- empiriquement dans ce lot : un simple
-- `revoke maintain on table ...` échoue avec
-- "unrecognized privilege type" sur une instance < 17. La version
-- PostgreSQL réelle de Supabase Production n'est pas vérifiable
-- depuis cet environnement (aucun accès Production autorisé dans ce
-- lot). Ce bloc est donc conditionnel à la version du serveur cible :
-- sans effet sur une instance < 17 (le privilège n'existe tout
-- simplement pas, donc rien à révoquer ni aucune exposition
-- possible), et couvre réellement le contrat si la Production
-- s'avère déjà en PostgreSQL 17+. Point à faire confirmer par Work/
-- CIO : la version PostgreSQL réelle du projet Supabase Production.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table public.restaurant_sale_mode_fulfillments from public, anon, authenticated, service_role';
  end if;
end $$;

commit;

-- ============================================================
-- AUCUNE DONNÉE TENANT : ce fichier n'insère STRICTEMENT AUCUNE
-- ligne dans restaurant_sale_mode_fulfillments (ni Au Lait Cru, ni
-- Sanaa, ni Illico, ni Sirocco, ni aucun autre établissement). Le
-- modèle est créé vide — la configuration réelle appartient à un lot
-- ultérieur, hors périmètre de LOT A.
--
-- AUCUNE RPC : get_restaurant_public_delivery_fulfillments (ou
-- équivalent) N'EST PAS créée ici — appartient à Lot B.
--
-- AUCUN changement à orders/create_order : le risque postalCode
-- identifié dans RAPPORT-FULFILLMENT-ROUTING-DESIGN.md reste
-- documenté mais NON corrigé par ce lot (Lot D).
--
-- DETTE VOLONTAIREMENT LAISSÉE (documentée, non corrigée ici) :
--  - Duplication du vocabulaire provider entre restaurant_sale_modes
--    et restaurant_sale_mode_fulfillments (voir §8 ci-dessus).
--  - fulfillment_code en texte libre sans catalogue séparé — à
--    réévaluer si des métadonnées par type deviennent nécessaires.
--  - Aucun résolveur/RPC : "enabled=true sur une règle" ne garantit
--    pas l'activation du sale mode parent — Lot B doit vérifier les
--    deux. Invariant obligatoire pour le futur Lot B (non implémenté
--    ici) :
--      restaurant_sale_modes.enabled = true
--      AND restaurant_sale_mode_fulfillments.enabled = true
--  - MAINTAIN (PostgreSQL 17+) : le REVOKE MAINTAIN de ce fichier est
--    conditionnel à la version du serveur (voir bloc ci-dessus) faute
--    de pouvoir vérifier la version PostgreSQL réelle de Supabase
--    Production depuis cet environnement — à confirmer par Work/CIO.
--
-- TESTS AUTOMATISÉS : voir
-- supabase/tests/fulfillment-routing-lot-a-check.sh (harnais
-- PostgreSQL jetable, jamais exécuté contre Production).
-- ============================================================
