-- ============================================================
-- Scanym — PAYMENT P3-B0 — CALLBACK CORRELATION + CUSTOMER PAYMENT
-- STATUS READ — SQL CAPABILITY LOT — v2 (DRAFT — NON APPLIQUÉ EN
-- PRODUCTION)
--
-- CORRECTION v2 (mandat PAYMENT P3-B0-V2) : PAYMENT P3-B0 v1 n'a
-- JAMAIS été installé en Production -- son audit indépendant a rendu
-- le verdict « FAIL — PAYMENT P3-B0 CORRELATION & STATUS READ v1 —
-- CALLBACK AMOUNT VERIFICATION CAPABILITY REQUIRED » (constat
-- PAY-P3-B0-01, MEDIUM, RELEASE-BLOCKING) : la vérification du MAC
-- Monetico prouve que les champs REÇUS du callback sont authentiques,
-- jamais que le `montant` reçu correspond à celui STOCKÉ par Scanym à
-- l'initiation -- sans un moyen de comparer les deux, une confirmation
-- de paiement resterait exposée à un montant falsifié malgré un MAC
-- par ailleurs valide. Ce fichier EST directement la forme finale v2 --
-- aucune séquence d'installation « v1 puis correction v2 » n'existe ni
-- n'est nécessaire, puisque v1 n'a jamais été appliqué nulle part.
--
-- OBJET (inchangé depuis v1) : ce lot existe parce que PAYMENT P3-B
-- MONETICO CHECKOUT RUNTIME v1 a effectué son audit d'architecture
-- obligatoire et s'est arrêté correctement avec :
--   STOP — PAYMENT P3-B CALLBACK CORRELATION CAPABILITY REQUIRED
--
-- Deux manques précis, et strictement ceux-là, ont été identifiés :
--
--   A. Un callback Monetico entrant ne porte AUCUN identifiant de
--      tenant Scanym -- seule sa `reference` (l'écho du
--      `provider_reference` que ce lot a lui-même choisi à
--      l'initiation, PAYMENT P3-A2 `deriveMoneticoReference`, un
--      hachage SHA-256 tronqué à sens unique) permet en théorie de
--      remonter à la tentative de paiement concernée. Cette
--      corrélation n'existe que dans `public.payment_transactions`
--      (unique sur (provider_code, provider_reference), PAYMENT P1) --
--      mais AUCUN rôle applicatif, PAS MÊME service_role, n'a le
--      moindre privilège direct sur cette table (`revoke all ... from
--      anon, authenticated, service_role, public`, PAY-P1-03,
--      RPC-ONLY AUTHORITY) et aucune RPC existante ne permet de lire
--      cette corrélation sans effet de bord :
--      `confirm_payment_attempt` MUTE la tentative trouvée -- l'appeler
--      avant vérification de MAC violerait le mandat "MAC FIRST" ;
--      `get_payment_provider_credential` exige `restaurant_id` en
--      ENTRÉE, elle ne peut donc pas le produire.
--
--   B. Un client anonyme qui revient du paiement (ou consulte l'état
--      de sa commande) ne détient que `(order_id, public_token)`
--      (`public.orders.public_token`, PAYMENT FOUNDATION, déjà utilisé
--      une fois par `mark_whatsapp_opened` comme preuve de possession)
--      -- mais `public.orders` n'accorde de SELECT qu'au personnel
--      authentifié (`personnel lit ses commandes`, RLS sur
--      `is_member_of`) : aucune capacité existante ne permet à un
--      client anonyme de lire son PROPRE `payment_status`, même en
--      présentant la bonne paire.
--
-- CE LOT FERME UNIQUEMENT CES DEUX MANQUES PRÉCIS -- rien de plus.
-- N'IMPLÉMENTE AUCUN checkout, AUCUNE route de callback, AUCUNE page
-- de retour navigateur, AUCUN bouton de paiement, AUCUNE requête
-- Monetico, AUCUN appel réseau prestataire, AUCUNE UI marchande,
-- AUCUNE saisie de credential, AUCUNE activation Production. C'est un
-- mini-lot SQL isolé, au même titre que PAYMENT P3-A0 l'a été pour la
-- lecture serveur de confiance du credential.
--
-- PRÉREQUIS (déjà publiés, INCHANGÉS et NON ROUVERTS par ce lot) :
-- PAYMENT P1 FOUNDATION (payment_transactions, orders.payment_status,
-- orders.public_token, orders.current_payment_transaction_id) et
-- migration-orders.sql (orders.public_token lui-même). Ce lot ne
-- dépend PAS de P2A/P2B-A/P3-A0 -- aucune des deux RPC ci-dessous ne
-- touche `payment_provider_configs` ni Supabase Vault, elles opèrent
-- exclusivement sur les tables déjà posées par P1/migration-orders.
--
-- PATRON DE SÉCURITÉ PRÉSERVÉ (mandat sections 3/7/8) : comme pour
-- tous les lots précédents (P1, P2A, P2B-A, P3-A0), AUCUN grant de
-- table nouveau n'est posé ici -- les deux fonctions sont
-- SECURITY DEFINER, `search_path` explicitement vide, et n'exposent
-- que le contrat de retour minimal demandé. AUCUNE clause OWNER TO
-- explicite -- la fonction hérite de la propriété du rôle exécutant
-- cette migration au déploiement (rôle de confiance), identique au
-- patron déjà établi partout ailleurs.
--
-- CORRÉLATION vs LECTURE STATUT (deux postures de confiance
-- DÉLIBÉRÉMENT différentes, mandat sections 3-6) :
--   RPC #1 (`get_payment_transaction_correlation`) sert un futur
--     callback Monetico -- un appelant SERVEUR DE CONFIANCE
--     (service_role seul), jamais le navigateur. Elle peut donc lever
--     des erreurs explicites (comme `get_payment_provider_credential`
--     le fait déjà) sans risque de fuite vers un tiers non authentifié.
--   RPC #2 (`get_order_payment_status`) sert un CLIENT ANONYME --
--     exactement la même posture que `create_order`/
--     `mark_whatsapp_opened` (EXECUTE à anon+authenticated). Elle
--     n'expose donc JAMAIS de distinction observable entre "mauvais
--     jeton" et "commande inexistante" : une seule instruction SQL
--     pure, sans branche, sans exception -- absence de correspondance
--     = ensemble de résultats vide, dans les deux cas, systématiquement.
--
-- AMOUNT/CURRENCY -- CORRECTION v2 (PAY-P3-B0-01, RELEASE-BLOCKING) :
-- v1 excluait délibérément `amount`/`currency` du contrat de RPC #1 au
-- motif que `confirm_payment_attempt` (P1, déjà publié) n'accepte
-- aucun montant/devise en entrée et ne pourrait donc rien en faire.
-- Ce raisonnement restait VRAI pour `confirm_payment_attempt`
-- lui-même (toujours inchangé, mandat P3-B0-V2 section 15) mais
-- ignorait une étape antérieure et distincte du futur chemin de
-- callback (mandat P3-B0-V2 section 14) : le MAC Monetico prouve
-- l'AUTHENTICITÉ des champs reçus (ils proviennent bien de Monetico,
-- avec la bonne clé), jamais leur COHÉRENCE avec ce que Scanym a
-- réellement stocké à l'initiation -- un `montant` authentique mais
-- FALSIFIÉ EN AMONT (ou correspondant à une tentative différente par
-- erreur d'intégration) resterait indétectable sans une valeur de
-- référence AUTORITATIVE à comparer. `amount`/`currency` sont donc
-- désormais INCLUS dans le contrat de retour de RPC #1, EXCLUSIVEMENT
-- pour permettre cette comparaison dans une future orchestration
-- (PAYMENT P3-B) -- jamais pour être transmis à
-- `confirm_payment_attempt`, qui reste volontairement inchangé (la
-- répartition des responsabilités reste : RPC #1 = lecture
-- autoritative, orchestration P3-B = comparaison, confirm_payment_
-- attempt = mutation d'état générique -- jamais mélangées).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_transactions'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_transactions introuvable -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_transactions'
      and column_name in ('restaurant_id','order_id','provider_code','provider_reference','status','id')
    having count(*) = 6
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_transactions -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'payment_transactions'
      and indexdef ilike '%unique%' and indexdef ilike '%provider_code%' and indexdef ilike '%provider_reference%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte unique (provider_code, provider_reference) introuvable sur public.payment_transactions -- invariant requis par la corrélation callback absent, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','restaurant_id','public_token','payment_status')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis migration-orders.sql/PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_payment_transaction_correlation'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_payment_transaction_correlation existe déjà -- PAYMENT P3-B0 déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_payment_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_payment_status existe déjà -- PAYMENT P3-B0 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_payment_transaction_correlation — LECTURE SERVEUR DE
-- CONFIANCE, SEULE, service_role UNIQUEMENT.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal (mandat section 3/6, CORRIGÉ
-- v2 -- PAY-P3-B0-01) : restaurant_id/order_id/transaction_id/status/
-- amount/currency -- exactement ce qu'il faut pour (a) choisir le bon
-- credential via get_payment_provider_credential(restaurant_id,
-- provider_code), (b) décider si un appel à confirm_payment_attempt a
-- un sens (ex. éviter un appel évident sur une tentative déjà
-- terminale), et (c) NOUVEAU EN v2 : permettre à une future
-- orchestration de comparer le `montant`/devise REÇU du callback
-- Monetico (après vérification MAC) contre la valeur AUTORITATIVE
-- stockée par Scanym à l'initiation, AVANT tout appel à
-- confirm_payment_attempt (mandat P3-B0-V2 section 14). Ne retourne
-- TOUJOURS PAS credentials_ref, aucun contenu de credential, aucun
-- identifiant Vault, aucune donnée personnelle client, aucune charge
-- brute de commande, aucun écho de provider_code/provider_reference
-- (l'appelant les connaît déjà, mandat P3-B0-V2 section 6), aucun
-- public_token.
--
-- amount/currency SONT AUTORITATIFS, JAMAIS dérivés du callback
-- (mandat P3-B0-V2 section 5) : cette fonction lit EXCLUSIVEMENT
-- `payment_transactions.amount`/`.currency`, la valeur posée UNIQUEMENT
-- par `initiate_payment_attempt` à partir de `orders.total`/
-- `.currency` au moment de l'initiation (P1, déjà publié, inchangé) --
-- cette fonction ne reçoit elle-même AUCUN paramètre `amount`/
-- `currency` en entrée, donc structurellement AUCUNE valeur fournie
-- par un appelant (a fortiori un futur callback prestataire) ne peut
-- jamais influencer ce qu'elle renvoie (mandat P3-B0-V2 section 18,
-- "the RPC itself does not receive callback amount/currency").
--
-- TYPES -- EXACTEMENT ceux déjà utilisés par le couple
-- initiate_payment_attempt/payment_transactions (mandat P3-B0-V2
-- section 4, "Use the exact underlying SQL types already used by
-- payment_transactions. Do not invent different precision/string
-- transformations") : `amount numeric` (la colonne est
-- `numeric(12,2)` ; le type de retour reste le `numeric` non contraint
-- déjà utilisé par la signature de retour de `initiate_payment_attempt`
-- elle-même -- aucune précision n'est perdue, PostgreSQL ne tronque ni
-- n'arrondit un `numeric(12,2)` en le retournant comme `numeric`) et
-- `currency text` (la colonne est `varchar(10)` ; `initiate_payment_
-- attempt` renvoie déjà `currency text` via un cast explicite
-- `v_order.currency::text` -- même convention reprise ici à
-- l'identique, `text`/`varchar` étant strictement équivalents en
-- stockage et en comparaison sous PostgreSQL). Voir
-- AMOUNT-CURRENCY-REPORT.txt (paquet livré) pour l'analyse complète du
-- risque de perte de précision côté PostgREST/client JS et la décision
-- prise dans l'enveloppe TypeScript en réponse.
--
-- CURRENCY -- AUCUNE NORMALISATION AJOUTÉE (mandat P3-B0-V2 section
-- 13) : ni PAYMENT P1 ni ce lot n'imposent de contrainte CHECK sur le
-- format de `payment_transactions.currency` (colonne `varchar(10)`
-- nue, aucune contrainte de longueur exacte, de casse, ni de jeu de
-- caractères ISO-4217) -- ce lot ne PEUT donc PAS documenter une
-- garantie de normalisation qui n'existe pas au niveau base, et
-- N'EN AJOUTE AUCUNE lui-même : la valeur est renvoyée EXACTEMENT
-- telle que stockée, sans validation ni transformation d'aucune sorte.
-- Une éventuelle normalisation amont (à la création de la commande)
-- reste hors périmètre de ce lot.
--
-- AUCUNE ÉCRITURE (mandat section 9) : SELECT uniquement, aucun verrou
-- FOR UPDATE (lecture pure, jamais destinée à préparer une mutation
-- dans CETTE fonction -- confirm_payment_attempt reste seule
-- responsable de toute mutation, avec son propre verrouillage).
--
-- CORRESPONDANCE UNIQUE GARANTIE STRUCTURELLEMENT (mandat section 3,
-- "one row maximum") : l'index unique déjà posé par PAYMENT P1 sur
-- (provider_code, provider_reference) rend une deuxième ligne
-- structurellement impossible -- vérifié explicitement ci-dessous par
-- défense en profondeur (ne dépend pas silencieusement de cette
-- contrainte externe, mandat section 3 "fail closed if ambiguous"),
-- exactement comme PAYMENT P3-A0 l'a déjà fait pour sa propre
-- garantie d'unicité équivalente.
-- ------------------------------------------------------------
create or replace function public.get_payment_transaction_correlation(
  p_provider_code text,
  p_provider_reference text
)
returns table (
  restaurant_id uuid,
  order_id uuid,
  transaction_id uuid,
  status text,
  amount numeric,
  currency text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_provider_reference text;
  v_match_count integer;
begin
  v_provider_code := btrim(coalesce(p_provider_code, ''));
  v_provider_reference := btrim(coalesce(p_provider_reference, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_CORRELATION: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;
  if length(v_provider_reference) = 0 then
    raise exception 'SCANYM_PAYMENT_CORRELATION: p_provider_reference requis (vide après normalisation)' using errcode = '22004';
  end if;

  select count(*) into v_match_count
    from public.payment_transactions t
    where t.provider_code = v_provider_code
      and t.provider_reference = v_provider_reference;

  if v_match_count = 0 then
    raise exception 'SCANYM_PAYMENT_CORRELATION: aucune tentative de paiement ne correspond à ce provider_code/provider_reference' using errcode = 'P0002';
  end if;

  -- Défense en profondeur (mandat section 3, "fail closed if
  -- ambiguous") : structurellement impossible tant que l'index unique
  -- de PAYMENT P1 reste en place (vérifié en garde préflight
  -- ci-dessus) -- cette fonction ne suppose néanmoins jamais
  -- silencieusement que cette garantie externe ne pourra jamais
  -- changer.
  if v_match_count > 1 then
    raise exception 'SCANYM_PAYMENT_CORRELATION: correspondance ambiguë (plusieurs tentatives) pour ce provider_code/provider_reference -- échec fermé, incohérence d''intégrité' using errcode = 'P0003';
  end if;

  return query
    select t.restaurant_id, t.order_id, t.id, t.status, t.amount, t.currency::text
    from public.payment_transactions t
    where t.provider_code = v_provider_code
      and t.provider_reference = v_provider_reference;
end;
$$;

comment on function public.get_payment_transaction_correlation(text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B0 v2 (corrige PAY-P3-B0-01). Corrélation SEULE, en LECTURE PURE, d''un callback prestataire (provider_code/provider_reference) vers son restaurant_id/order_id/transaction_id/status/amount/currency server-owned -- pont nécessaire avant tout choix de credential, toute vérification de MAC, et toute comparaison montant/devise (jamais un raccourci autour d''elles). amount/currency sont AUTORITATIFS (lus depuis payment_transactions, jamais reçus en paramètre -- structurellement non influençables par un appelant). Ne retourne JAMAIS de credential, de référence Vault, de public_token, d''écho provider_code/provider_reference, ni de donnée personnelle. Échec fermé si aucune correspondance ou si la correspondance est ambiguë (structurellement empêché par l''index unique de PAYMENT P1, revérifié ici en défense en profondeur). Aucune écriture, aucun verrou -- confirm_payment_attempt reste seule autorité de mutation et reste INCHANGÉ par ce lot.';

revoke all on function public.get_payment_transaction_correlation(text, text) from public, anon, authenticated;
grant execute on function public.get_payment_transaction_correlation(text, text) to service_role;

-- ------------------------------------------------------------
-- 3. get_order_payment_status — LECTURE CLIENT ANONYME, possession
-- scoped, `anon` + `authenticated`.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal (mandat section 5) :
-- `payment_status` SEUL. Ne retourne JAMAIS restaurant_id, aucun
-- identifiant de tentative interne, aucune provider_reference, aucun
-- credential, aucune donnée personnelle client, aucune ligne
-- payment_transactions, aucun détail d'erreur interne.
--
-- MODÈLE D'ACCÈS (mandat section 6) : la preuve de possession EXACTE
-- déjà établie par `mark_whatsapp_opened` (orders.id = p_order_id ET
-- orders.public_token = p_public_token) -- même patron, même posture
-- de confiance (`anon, authenticated`, comme `create_order`). Une
-- seule instruction SQL PURE, sans branche ni exception : une paire
-- incorrecte (mauvais jeton, mauvaise commande, ou les deux, y compris
-- des arguments NULL) produit systématiquement un ensemble de
-- résultats VIDE -- exactement le même comportement observable dans
-- les trois cas, aucune fuite d'information par un message d'erreur
-- distinct ou un comportement différent (mandat section 6, "same
-- observable behavior as wrong token if possible").
--
-- AUCUNE ÉCRITURE (mandat section 9) : SELECT uniquement.
-- ------------------------------------------------------------
create or replace function public.get_order_payment_status(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  payment_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.payment_status
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_payment_status(uuid, uuid) is
  'SECURITY DEFINER, anon+authenticated -- PAYMENT P3-B0. Lecture client anonyme, possession-scoped (order_id + public_token, même patron que mark_whatsapp_opened), du SEUL payment_status d''une commande. Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable. Ne retourne jamais restaurant_id, transaction_id, provider_reference, credential, ni donnée personnelle. Aucune écriture.';

revoke all on function public.get_order_payment_status(uuid, uuid) from public;
grant execute on function public.get_order_payment_status(uuid, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. NON-RÉGRESSION EXPLICITE (mandat section 8) : ce lot n'altère
-- AUCUN privilège de table existant. Redéclaré ici en NO-OP défensif
-- (déjà en vigueur depuis PAYMENT P1 FOUNDATION section 4/6 -- ce lot
-- confirme qu'il ne les affaiblit pas, il ne les réémet pas
-- différemment). Aucun grant de table nouveau n'est ajouté par ce lot,
-- pour quelque rôle que ce soit -- les deux fonctions ci-dessus
-- restent la SEULE autorité nouvelle.
-- ------------------------------------------------------------

commit;
