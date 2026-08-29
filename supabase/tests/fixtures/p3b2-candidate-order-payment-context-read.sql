-- ============================================================
-- Scanym — PAYMENT P3-B2 — ORDER PAYMENT CONTEXT READ CAPABILITY —
-- v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot existe parce que PAYMENT P3-B MONETICO CHECKOUT
-- RUNTIME v1 a effectué son inspection d'architecture obligatoire et
-- s'est arrêté correctement avec :
--   STOP — PAYMENT P3-B CUSTOMER ORDER AUTHORITY GAP
--
-- Constat précis : le point d'entrée client du futur runtime de
-- paiement ne peut recevoir, en provenance du navigateur, QUE la
-- preuve de possession déjà établie par le modèle existant --
-- `order_id` + `public_token` (`public.orders.public_token`, posé par
-- migration-orders.sql, déjà réutilisé à l'identique par
-- `mark_whatsapp_opened` et par `get_order_payment_status`). Avant
-- tout appel à `getPaymentRuntimeProviderConfig(...)` (PAYMENT P3-B1),
-- ce runtime doit pourtant déjà connaître un `restaurant_id` DE
-- CONFIANCE -- et trois capacités existantes, examinées une à une,
-- se sont révélées insuffisantes :
--
--   A. `get_order_payment_status(p_order_id, p_public_token)`
--      (PAYMENT P3-B0) vérifie exactement la même preuve de
--      possession mais son propre commentaire documente un contrat de
--      retour DÉLIBÉRÉMENT minimal : « Ne retourne jamais
--      restaurant_id [...] ». Exclusion volontaire, pas un oubli --
--      cette fonction reste un contrat CLIENT public stable
--      (mandat section 4) et n'est PAS modifiée par ce lot.
--
--   B. `mark_whatsapp_opened(p_order_id, p_token)` (PAYMENT
--      FOUNDATION) vérifie la même preuve de possession mais
--      `returns void` -- ne produit aucune donnée exploitable, et
--      MUTE en plus la commande (`whatsapp_opened = true`), effet de
--      bord inacceptable pour une simple lecture de contexte.
--
--   C. `initiate_payment_attempt(p_order_id, p_provider_code,
--      p_provider_reference)` (PAYMENT P1) ne reçoit et ne vérifie
--      AUCUN `public_token` -- elle fait confiance à l'appelant pour
--      avoir déjà établi la possession, et ne résout `restaurant_id`
--      qu'en INTERNE, trop tard pour la vérification d'activation
--      runtime (PAYMENT P3-B1) qui doit précéder toute initiation.
--
-- Aucune autre fonction du schéma n'accepte `public_token` en
-- paramètre (vérifié directement par introspection avant d'écrire ce
-- fichier, jamais supposé). Ce lot ferme UNIQUEMENT ce manque précis --
-- une lecture SEULE, en LECTURE PURE, du couple minimal
-- (restaurant_id, payment_status) nécessaire à un futur PAYMENT P3-B
-- pour établir l'autorité tenant AVANT tout appel à
-- `getPaymentRuntimeProviderConfig(...)` puis
-- `initiatePaymentAttempt(...)`. N'IMPLÉMENTE AUCUN checkout, AUCUNE
-- route de paiement/callback, AUCUN appel réseau Monetico, AUCUNE
-- activation de tenant, AUCUNE mutation. Mini-lot SQL isolé, au même
-- titre que PAYMENT P3-A0/P3-B0/P3-B1 l'ont été.
--
-- PRÉREQUIS (déjà publiés, INCHANGÉS et NON ROUVERTS par ce lot) :
-- migration-orders.sql (orders.id, orders.restaurant_id,
-- orders.public_token) et PAYMENT P1 FOUNDATION (orders.payment_status,
-- avec sa contrainte CHECK (payment_status in ('not_required',
-- 'pending','paid','failed','cancelled'))). Ce lot NE dépend PAS de
-- PAYMENT P2A/P2B-A/P3-A0/P3-B0/P3-B1 -- aucune de ces capacités
-- soeurs n'ajoute de colonne/contrainte requise ici ; elles ne sont
-- pas rouvertes.
--
-- PAYMENT_STATUS -- VALEURS AUTORISÉES (inspectées directement dans
-- supabase/DRAFT-lot-payment-p1-foundation.sql avant d'écrire ce
-- fichier, jamais devinées) : EXACTEMENT 'not_required' | 'pending' |
-- 'paid' | 'failed' | 'cancelled' (contrainte CHECK déjà posée par
-- PAYMENT P1, non modifiée, non dupliquée ici). Ce lot ne décide
-- d'AUCUNE politique d'éligibilité sur ces valeurs -- il expose
-- fidèlement la valeur stockée, telle quelle. Documentation, PAS
-- décision : un futur PAYMENT P3-B décidera seul de l'éligibilité
-- (mandat section 15, "Future P3-B will decide eligibility").
--
-- POURQUOI service_role SEUL, PAS anon/authenticated (mandat section
-- 5) : contrairement à `get_order_payment_status` (contrat CLIENT
-- public, le navigateur a besoin de connaître son propre
-- payment_status), `restaurant_id` n'a AUCUNE utilité pour le
-- navigateur -- seul le runtime serveur de confiance en a besoin,
-- pour choisir la bonne configuration prestataire (PAYMENT P3-B1)
-- avant d'initier un paiement. Le navigateur transmettra
-- `order_id`/`public_token` au point d'entrée serveur du futur
-- PAYMENT P3-B, qui appelle LUI-MÊME cette RPC via service_role --
-- jamais directement depuis le navigateur. Élargir l'EXECUTE à
-- anon/authenticated exposerait `restaurant_id` sans aucun bénéfice
-- fonctionnel, en violation du principe de moindre privilège déjà
-- appliqué à `get_payment_transaction_correlation`/
-- `get_payment_runtime_provider_config` (mandat section 5, "Do not
-- broaden access by default").
--
-- CONFIDENTIALITÉ DE LA POSSESSION (mandat sections 7/17) : comme
-- `get_order_payment_status`, une SEULE instruction SQL pure, sans
-- branche ni exception -- toute paire incorrecte (mauvais jeton,
-- mauvaise commande, les deux, ou arguments NULL) produit
-- systématiquement un ensemble de résultats VIDE, de façon identique
-- dans tous les cas. Aucune distinction observable entre « commande
-- inexistante » et « commande existante, jeton incorrect ».
--
-- AUCUNE ÉCRITURE (mandat section 12) : SELECT uniquement, aucun
-- verrou FOR UPDATE, aucune mutation de `whatsapp_opened`, de
-- `status`, ni de `payment_status`. Appels répétés strictement sans
-- effet de bord.
--
-- PATRON DE SÉCURITÉ PRÉSERVÉ (mandat section 10) : comme pour tous
-- les lots précédents, AUCUN grant de table nouveau n'est posé ici --
-- la fonction est SECURITY DEFINER, `search_path` explicitement vide,
-- aucune identité de schéma/objet contrôlée par l'appelant, aucun SQL
-- dynamique. AUCUNE clause OWNER TO explicite -- la fonction hérite de
-- la propriété du rôle exécutant cette migration au déploiement,
-- identique au patron déjà établi partout ailleurs.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
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
      and column_name in ('id','restaurant_id','public_token','payment_status')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis migration-orders.sql/PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and conname = 'orders_payment_status_check'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte CHECK orders_payment_status_check introuvable sur public.orders -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_payment_context'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_payment_context existe déjà -- PAYMENT P3-B2 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_order_payment_context — LECTURE SERVEUR DE CONFIANCE SEULE,
-- service_role UNIQUEMENT, possession-scoped.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal (mandat section 8) :
-- `restaurant_id` + `payment_status`. Ne retourne JAMAIS order_number,
-- total, currency, provider_reference, transaction_id,
-- credentials_ref, donnée de livraison, téléphone/email,
-- horodatages, ni aucune autre colonne de `public.orders`.
--
-- MODÈLE D'ACCÈS (mandat section 6) : preuve de possession EXACTE,
-- même patron que `mark_whatsapp_opened`/`get_order_payment_status`
-- (orders.id = p_order_id ET orders.public_token = p_public_token) --
-- aucun fallback, aucune correspondance partielle, aucune recherche
-- par order_number, aucun tenant/provider_code fourni par l'appelant.
-- Une seule instruction SQL PURE, sans branche ni exception :
-- ensemble de résultats vide pour toute paire incorrecte, y compris
-- des arguments NULL.
--
-- AUCUNE ÉCRITURE (mandat section 12) : SELECT uniquement.
-- ------------------------------------------------------------
create or replace function public.get_order_payment_context(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  restaurant_id uuid,
  payment_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.restaurant_id, o.payment_status
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_payment_context(uuid, uuid) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B2. Lecture serveur de confiance SEULE, possession-scoped (order_id + public_token, même patron que mark_whatsapp_opened/get_order_payment_status), du couple minimal restaurant_id/payment_status nécessaire à un futur runtime de paiement pour établir l''autorité tenant AVANT getPaymentRuntimeProviderConfig(...) puis initiatePaymentAttempt(...). Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable. Ne retourne jamais order_number, total, currency, provider_reference, transaction_id, credentials_ref, donnée de livraison, ni donnée personnelle. Aucune écriture. get_order_payment_status (PAYMENT P3-B0, contrat CLIENT public) reste INCHANGÉ -- postures de confiance délibérément distinctes.';

revoke all on function public.get_order_payment_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_payment_context(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE (mandat section 23) : ce lot n'altère
-- AUCUN privilège de table existant, ni AUCUNE fonction existante --
-- get_order_payment_status, mark_whatsapp_opened,
-- initiate_payment_attempt, get_payment_transaction_correlation,
-- get_payment_provider_credential et get_payment_runtime_provider_config
-- restent tous INCHANGÉS. Aucun grant de table nouveau n'est ajouté
-- par ce lot, pour quelque rôle que ce soit -- la fonction ci-dessus
-- reste la SEULE autorité nouvelle.
-- ------------------------------------------------------------

commit;
