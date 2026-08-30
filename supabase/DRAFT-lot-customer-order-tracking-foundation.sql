-- ============================================================
-- Scanym — CUSTOMER ORDER TRACKING FOUNDATION + ORDER STATUS
-- MANAGEMENT — v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot construit un suivi de commande générique, indépendant
-- du paiement et du canal (WhatsApp, Click & Collect, boutique, table,
-- room service, livraison locale/prestataire, future expédition), sans
-- compte client, via la MÊME preuve de possession que le reste du
-- schéma : `order_id` + `public_token` (`public.orders.public_token`,
-- posé par migration-orders.sql, déjà réutilisé à l'identique par
-- `mark_whatsapp_opened` et par `get_order_payment_status`/
-- `get_order_payment_context`, PAYMENT P3-B0/P3-B2).
--
-- INSPECTION PRÉALABLE DU MODÈLE RÉEL (mandat : « ne suppose rien sur
-- le schéma existant ») -- résultat, AVANT toute décision de conception :
--
--   A. order_status EXISTE DÉJÀ, séparé de payment_status. C'est
--      `public.orders.status` (migration-orders.sql, RÉVISÉ par
--      migration-v29-merchant-dashboard.sql -- EXISTE dans le dépôt
--      source actuel, sans préfixe DRAFT-, prérequis requis de la base
--      courante pour ce lot ; aucune affirmation d'état Production réel
--      n'est faite ici à partir de cette seule convention de nommage --
--      cette session n'a et n'a jamais eu d'accès Production réel).
--      Cycle RÉEL, vérifié par introspection (`orders_status_check`),
--      PAS supposé :
--        new -> accepted -> preparing -> ready -> completed
--        exceptions : rejected, cancelled
--      C'est DÉJÀ, presque mot pour mot, le cycle conceptuel du mandat
--      (CREATED/ACCEPTED/PREPARING/READY/COMPLETED + REFUSED/CANCELLED,
--      new=CREATED, rejected=REFUSED). CE LOT NE CRÉE DONC AUCUNE
--      DEUXIÈME COLONNE DE STATUT CONCURRENTE (mandat explicite) --
--      `orders.status` EST le order_status, réutilisé tel quel.
--
--   B. La TRANSITION SÉCURISÉE marchande EXISTE DÉJÀ ELLE AUSSI :
--      `public.update_order_status(p_order_id, p_new_status)`
--      (migration-v29-merchant-dashboard.sql, contrat source courant du
--      dépôt -- aucune affirmation d'état Production réel n'est faite
--      ici) est SECURITY DEFINER, authenticated UNIQUEMENT, verrouille la
--      commande (`FOR UPDATE`, sérialise toute transition concurrente),
--      vérifie l'appartenance tenant via `restaurant_users` AVANT toute
--      mutation, et applique une machine à états explicite (transitions
--      autorisées listées une par une, tout le reste refusé). Elle
--      couvre déjà entièrement "transition sécurisée" + "autorisation
--      marchande" + "isolation tenant" + "concurrence" du mandat pour
--      le côté MARCHAND. CE LOT NE LA MODIFIE PAS (déjà testée, contrat
--      source courant, hors nécessité absolue -- mandat section "ne pas
--      toucher sauf nécessité").
--
--   C. payment_status EXISTE (PAYMENT P1 FOUNDATION,
--      DRAFT-lot-payment-p1-foundation.sql), déjà séparé de orders.status
--      (P1 le documente lui-même : « machine à états du PAIEMENT,
--      INDÉPENDANTE de orders.status »). Un client anonyme peut déjà le
--      lire seul via `get_order_payment_status(order_id, public_token)`
--      (PAYMENT P3-B0). CE LOT NE TOUCHE NI NE DUPLIQUE CETTE CAPACITÉ --
--      voir "INDÉPENDANCE VIS-À-VIS DU PAIEMENT" plus bas. État
--      Production réel de PAYMENT P1/P3-A*/P3-B* NON AFFIRMÉ ICI (cette
--      session n'a et n'a jamais eu d'accès Production réel, même limite
--      que documentée par les lots paiement eux-mêmes) -- ET SANS
--      CONSÉQUENCE : ce lot ne dépend d'AUCUN de ces états, quel qu'il
--      soit (voir ci-dessous).
--
--   D. delivery_status N'EXISTE NULLE PART dans le schéma réel (recherche
--      exhaustive : aucune colonne/table `delivery_status`/
--      `fulfillment_status` dans schema.sql, migration-orders*.sql,
--      migration-v29-merchant-dashboard.sql, ni dans AUCUN lot
--      livraison/fulfillment existant -- DRAFT-lot-fulfillment-routing-*,
--      DRAFT-lot-merchant-delivery-pricing.sql, DRAFT-lot-server-
--      delivery-fulfillment-pricing.sql. Ces lots livraison portent
--      EXCLUSIVEMENT sur le ROUTAGE et la TARIFICATION (zones,
--      frais, minimums) -- JAMAIS sur un cycle opérationnel de livraison
--      (répartition coursier, "en cours de livraison", "livré", etc.).
--
--      GAP ARCHITECTURAL EXPLICITE (mandat : « si le modèle actuel
--      impose une décision non triviale : STOP et rapporte le gap ») --
--      DÉCISION PRISE, DOCUMENTÉE, PAS DEVINÉE : inventer la forme de
--      delivery_status (valeurs, transitions, qui les déclenche -- un
--      coursier n'a aujourd'hui AUCUN compte, AUCUNE session, AUCUNE
--      RPC dans ce schéma) est une décision PRODUIT/ARCHITECTURE qui
--      n'est PAS spécifiée par le présent mandat FOUNDATION et qui
--      engagerait un modèle non trivial sans validation CTO/CIO
--      préalable. CE LOT NE CRÉE DONC PAS delivery_status -- il expose
--      fidèlement les DEUX dimensions qui existent RÉELLEMENT
--      aujourd'hui (order_status ici, payment_status via la RPC P3-B0
--      déjà publiée séparément), et laisse delivery_status à un LOT
--      DÉDIÉ FUTUR, une fois le modèle de dispatch/livraison
--      lui-même spécifié. Note de contrat future, CORRIGÉE (une version
--      antérieure de ce commentaire surestimait l'extensibilité) :
--      PostgreSQL n'autorise PAS `CREATE OR REPLACE FUNCTION` à changer
--      l'ensemble des colonnes d'un `RETURNS TABLE(...)` existant --
--      ajouter delivery_status plus tard nécessitera de RECRÉER la
--      fonction (`DROP FUNCTION` puis `CREATE`, ou une nouvelle fonction
--      versionnée, ex. `get_order_tracking_v2`), pas une simple
--      `CREATE OR REPLACE` additive. Ceci reste une note de
--      documentation : ce lot n'implémente PAS delivery_status et ne
--      décide d'aucune stratégie de versionnement ici.
--
-- MANQUE PRÉCIS COMBLÉ PAR CE LOT, ET STRICTEMENT CELUI-LÀ : aucune
-- capacité existante ne permet à un client ANONYME de lire le
-- order_status (cycle cuisine/service) de sa propre commande via sa
-- preuve de possession. Trois capacités existantes, examinées une à
-- une, se sont révélées insuffisantes (même méthode que PAYMENT P3-B2) :
--   A. `update_order_status` (V29) exige `authenticated` + appartenance
--      `restaurant_users` -- un client anonyme ne peut jamais l'appeler,
--      et elle MUTE la commande (pas une simple lecture).
--   B. `get_order_payment_status`/`get_order_payment_context` (P3-B0/
--      P3-B2) exposent DÉLIBÉRÉMENT payment_status SEUL (ou
--      restaurant_id+payment_status pour P3-B2, service_role uniquement)
--      -- AUCUNE des deux ne référence `orders.status`.
--   C. `mark_whatsapp_opened` vérifie la même preuve de possession mais
--      `returns void` et MUTE la commande (`whatsapp_opened = true`),
--      effet de bord inacceptable pour une simple lecture.
-- Aucune autre fonction du schéma n'accepte `public_token` en paramètre
-- (vérifié directement par introspection, jamais supposé, même méthode
-- que P3-B2). Ce lot ferme UNIQUEMENT ce manque précis.
--
-- INDÉPENDANCE VIS-À-VIS DU PAIEMENT (mandat : « ne jamais fusionner
-- order_status/payment_status/delivery_status » + « suivi indépendant
-- du paiement » + minimiser tout conflit avec PAYMENT P3-B MONETICO
-- CHECKOUT RUNTIME v2, en cours de développement en parallèle, PAS
-- encore fusionné sur main) :
--   - `get_order_tracking` (ce lot) NE RETOURNE JAMAIS payment_status,
--     ni aucune colonne payment_*/current_payment_transaction_id.
--   - Ce lot NE RÉFÉRENCE AUCUNE table/colonne posée par PAYMENT P1/
--     P3-A*/P3-B* -- AUCUNE garde préflight ci-dessous ne dépend de
--     `orders.payment_status` ni de `payment_transactions`. Ce lot est
--     donc applicable en Production INDÉPENDAMMENT de l'état
--     d'avancement du paiement, DANS N'IMPORTE QUEL ORDRE relatif à
--     PAYMENT P1/P3-A*/P3-B* (aucune dépendance croisée dans un sens ou
--     dans l'autre).
--   - Ce lot NE TOUCHE AUCUN fichier runtime/UI de paiement (aucune
--     route paiement, aucune page MenuView/OrderConfirmation, aucun
--     adaptateur Monetico, aucune configuration prestataire).
--   - Une future page de suivi client (lot UX séparé, après fusion de
--     PAYMENT P3-B MONETICO CHECKOUT RUNTIME v2) combinera les DEUX
--     lectures indépendantes côté client -- `get_order_tracking` (ce
--     lot) pour order_status, `get_order_payment_status` (déjà publiée,
--     inchangée) pour payment_status -- sans jamais les fusionner en une
--     seule RPC ni en un seul champ.
--
-- PATRON DE SÉCURITÉ REPRIS À L'IDENTIQUE de `get_order_payment_status`/
-- `get_order_payment_context` (PAYMENT P3-B0/P3-B2), même schéma de
-- preuve de possession que `mark_whatsapp_opened` :
--   - SECURITY DEFINER, `search_path` explicitement vide, AUCUNE clause
--     OWNER TO explicite (hérite du rôle exécutant la migration).
--   - `language sql`, `stable`, une SEULE instruction SQL PURE, sans
--     branche ni exception : `orders.id = p_order_id AND
--     orders.public_token = p_public_token`, aucun fallback, aucune
--     correspondance partielle, aucune recherche par order_number.
--   - CONFIDENTIALITÉ DE LA POSSESSION : toute paire incorrecte (mauvais
--     jeton, mauvaise commande, les deux, ou arguments NULL) produit
--     systématiquement un ensemble de résultats VIDE, de façon
--     identique dans tous les cas -- aucune distinction observable entre
--     « commande inexistante » et « commande existante, jeton
--     incorrect ».
--   - AUCUNE ÉCRITURE : SELECT uniquement, aucun verrou FOR UPDATE,
--     aucune mutation d'aucune sorte -- appels répétés strictement sans
--     effet de bord (donc trivialement idempotents et sûrs sous
--     concurrence : une lecture pure ne peut jamais entrer en conflit
--     avec elle-même ni avec `update_order_status`).
--   - AUCUN grant de table nouveau : la fonction est SECURITY DEFINER,
--     elle n'a besoin d'aucun privilège de table pour anon/authenticated
--     -- exactement comme `get_order_payment_status`.
--
-- CONTRAT DE RETOUR DÉLIBÉRÉMENT MINIMAL (documentation, pas décision
-- produit -- même posture que PAYMENT P3-B2 section 8) :
-- `order_status` (orders.status), `service_mode` (nécessaire pour
-- interpréter le cycle -- une commande pickup/table n'a pas la même
-- signification de "completed" qu'une livraison, mais AUCUNE
-- interprétation n'est faite ICI, elle reste à la charge d'une future
-- UX), `order_number` (déjà communiqué au client à la création, utile
-- pour l'affichage "Commande #42"), et les horodatages de transition
-- déjà posés par `orders_touch` (`created_at`, `accepted_at`,
-- `preparing_at`, `ready_at`, `completed_at`, `rejected_at`,
-- `cancelled_at`) -- nécessaires à une frise chronologique côté client.
-- Ne retourne JAMAIS payment_status, restaurant_id, total/subtotal/
-- currency, coordonnées client (nom/téléphone/email/adresse/note),
-- ni aucune autre colonne de `public.orders`. Une future UX pourra
-- étendre ce contrat via un lot dédié si un besoin précis émerge --
-- ce lot n'implémente AUCUNE page, AUCUN composant, AUCUNE route.
--
-- TESTÉ sur PostgreSQL 16 (communautaire vanilla), harnais reproductible
-- dans supabase/tests/customer-order-tracking-foundation-check.sh --
-- exécuté réellement, pas seulement déclaré (voir CUSTOMER-ORDER-
-- TRACKING-FOUNDATION-REPORT.md pour le résumé du harnais et le rapport
-- de gap complet).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
--
-- Dépend UNIQUEMENT de migration-orders.sql + migration-v29-merchant-
-- dashboard.sql (prérequis requis de la base source courante -- aucune
-- affirmation d'état Production réel n'est faite ici) -- AUCUNE
-- dépendance sur PAYMENT P1/P3-A*/P3-B* (voir "INDÉPENDANCE VIS-À-VIS DU
-- PAIEMENT" ci-dessus).
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in (
        'id','public_token','status','service_mode','order_number',
        'created_at','accepted_at','preparing_at','ready_at',
        'completed_at','rejected_at','cancelled_at'
      )
    having count(*) = 12
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis migration-orders.sql/migration-v29-merchant-dashboard.sql manquant ou incomplet, migration annulée.';
  end if;

  -- Garde de non-dérive STRICTE sur le modèle de statut lui-même --
  -- v3 (durcissement TRACK-V1-DRIFT-GUARD, résiduel LOW de l'audit Work
  -- sur v2) : vérification STRUCTURELLE de l'ENSEMBLE EXACT des valeurs
  -- autorisées (pas du nom de la contrainte, pas d'une correspondance
  -- texte exacte fragile). Recherche, sur public.orders, toute contrainte
  -- CHECK dont la définition correspond au PATRON structurel "status =
  -- ANY (ARRAY[...])" (forme que PostgreSQL restitue de façon identique
  -- que la contrainte ait été écrite avec `IN (...)` ou `= ANY
  -- (ARRAY[...])` -- vérifié empiriquement), quel que soit son nom
  -- (`conname`) -- une contrainte renommée mais sémantiquement identique
  -- est acceptée. Si exactement une telle contrainte existe et est
  -- validée, ses valeurs littérales sont extraites et comparées, comme
  -- ENSEMBLE trié dédupliqué (pas comme texte figé), à l'ensemble
  -- canonique attendu.
  --
  -- CORRECTION v3 (le constat Work) : v2 extrayait les littéraux avec le
  -- motif `'([a-z_]+)'::text`, restreint aux minuscules/underscore. Une
  -- valeur ajoutée à une contrainte élargie contenant un caractère hors
  -- de cette classe (par exemple `manual-review` avec un trait d'union,
  -- ou `X1` avec une majuscule et un chiffre) n'était alors PAS capturée
  -- du tout par la regex -- silencieusement absente de l'ensemble
  -- extrait, qui pouvait alors rester égal à l'ensemble canonique attendu
  -- et laisser passer une contrainte réellement élargie. Le motif est
  -- désormais `'((?:[^']|'')*)'::text` : il capture le contenu de TOUT
  -- littéral texte entre guillemets simples restitué par
  -- pg_get_constraintdef (gérant aussi l'échappement SQL standard d'un
  -- guillemet simple interne par doublement), quel que soit son
  -- contenu -- lettres, chiffres, tirets, majuscules, ou toute autre
  -- séquence de caractères. Toute valeur supplémentaire, quels que
  -- soient ses caractères, est donc désormais bien capturée, agrandit
  -- l'ensemble extrait au-delà des 7 valeurs canoniques, et fait
  -- échouer la comparaison d'ensemble ci-dessous -- fermant précisément
  -- le gap rapporté, sans dépendre d'une correspondance de texte intégral
  -- fragile (l'ensemble reste comparé trié/dédupliqué, insensible au
  -- réordonnancement des valeurs ou au renommage de la contrainte).
  --
  -- Si `orders_status_check` a disparu, n'est pas validée, a été
  -- renommée, ou porte un ensemble de valeurs différent (par exemple une
  -- base encore au modèle pré-V29, avec 'served' au lieu de 'completed'/
  -- 'rejected' -- reproduit et confirmé par ce lot), ce lot s'arrête
  -- plutôt que d'exposer un order_status dont le cycle réel ne
  -- correspondrait plus à celui documenté ci-dessus.
  declare
    v_struct_count int;
    v_def          text;
    v_validated    boolean;
    v_status_values   text[];
    v_expected_values constant text[] :=
      array['accepted','cancelled','completed','new','preparing','ready','rejected'];
  begin
    select count(*) into v_struct_count
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '^CHECK \(\(status = ANY \(ARRAY\[';

    if v_struct_count = 0 then
      raise exception 'SCANYM_SCHEMA_DRIFT: aucune contrainte CHECK structurelle sur orders.status (forme "status = ANY (ARRAY[...])") trouvée -- prérequis migration-v29-merchant-dashboard.sql manquant ou modèle de statut altéré, migration annulée.';
    end if;

    if v_struct_count > 1 then
      raise exception 'SCANYM_SCHEMA_DRIFT: % contraintes CHECK structurelles concurrentes trouvées sur orders.status -- modèle ambigu, migration annulée.', v_struct_count;
    end if;

    select convalidated, pg_get_constraintdef(oid)
      into v_validated, v_def
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '^CHECK \(\(status = ANY \(ARRAY\[';

    if not v_validated then
      raise exception 'SCANYM_SCHEMA_DRIFT: contrainte CHECK sur orders.status existe mais n''est pas validée (NOT VALID) -- migration annulée.';
    end if;

    select array_agg(distinct m[1] order by m[1])
      into v_status_values
    from regexp_matches(v_def, '''((?:[^'']|'''')*)''::text', 'g') as m;

    if v_status_values is distinct from v_expected_values then
      raise exception 'SCANYM_SCHEMA_DRIFT: ensemble de valeurs autorisées pour orders.status inattendu -- attendu %, trouvé % (définition : "%"). Migration annulée : le cycle order_status réel ne correspond peut-être plus à celui documenté par ce lot.', v_expected_values, v_status_values, v_def;
    end if;
  end;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_tracking'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_tracking existe déjà -- lot déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_order_tracking — LECTURE CLIENT ANONYME, possession-scoped,
-- `anon` + `authenticated` (même posture que `create_order`/
-- `get_order_payment_status`).
-- ------------------------------------------------------------
create or replace function public.get_order_tracking(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  order_status text,
  service_mode text,
  order_number bigint,
  created_at timestamptz,
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.status, o.service_mode, o.order_number,
    o.created_at, o.accepted_at, o.preparing_at, o.ready_at,
    o.completed_at, o.rejected_at, o.cancelled_at
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_tracking(uuid, uuid) is
  'SECURITY DEFINER, anon+authenticated -- CUSTOMER ORDER TRACKING FOUNDATION v1. Lecture client anonyme, possession-scoped (order_id + public_token, même patron que mark_whatsapp_opened/get_order_payment_status), du order_status (orders.status, INDÉPENDANT de payment_status) et de son horodatage de transition. Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable. Ne retourne JAMAIS payment_status, restaurant_id, total/subtotal/currency, ni aucune donnée personnelle client. get_order_payment_status (PAYMENT P3-B0) reste la lecture séparée et INCHANGÉE du payment_status -- les deux dimensions ne sont jamais fusionnées. Aucune écriture.';

revoke all on function public.get_order_tracking(uuid, uuid) from public;
grant execute on function public.get_order_tracking(uuid, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE : ce lot n'altère AUCUN privilège de
-- table existant, ni AUCUNE fonction existante -- update_order_status,
-- get_order_payment_status, get_order_payment_context,
-- get_order_active_payment_attempt, mark_whatsapp_opened, create_order
-- restent tous INCHANGÉS. Aucun grant de table nouveau n'est ajouté par
-- ce lot, pour quelque rôle que ce soit -- la fonction ci-dessus reste
-- la SEULE autorité nouvelle.
-- ------------------------------------------------------------

commit;
