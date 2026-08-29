-- ============================================================
-- Scanym — ORDERS SERVICE_ROLE SELECT HARDENING — v1 (DRAFT — NON
-- APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot existe parce que PAYMENT P3-B2 ORDER PAYMENT CONTEXT
-- READ v1 a été bloquée avant mutation par le constat suivant :
-- Production (`ctqfpszwunfomrbxgigu`) rapporterait actuellement
-- `service_role=r/postgres` sur `public.orders`, c'est-à-dire un SELECT
-- direct de table pour `service_role`, alors que `service_role` porte
-- l'attribut `BYPASSRLS` -- un tel privilège, s'il existe réellement,
-- contourne INTÉGRALEMENT la RLS/policy d'`orders` pour ce rôle.
--
-- IMPORTANT -- LIMITE D'ACCÈS, DOCUMENTÉE EXPLICITEMENT : cette session
-- de développement n'a et n'a jamais eu d'accès Production réel au
-- projet `ctqfpszwunfomrbxgigu` (aucune credential, aucune chaîne de
-- connexion, aucune atteignabilité réseau -- vérifié directement).
-- L'état ACL Production cité ci-dessus est un INTRANT du mandat, non
-- une lecture que ce lot a lui-même effectuée ou peut vérifier. Cette
-- migration est conçue pour être SÛRE et STRICTEMENT IDEMPOTENTE que ce
-- constat soit exact ou non : un `REVOKE` sur un privilège déjà absent
-- est un no-op silencieux en PostgreSQL, jamais une erreur -- voir
-- IDEMPOTENCY (section dédiée du rapport de livraison) pour la preuve
-- comportementale directe de cette propriété.
--
-- PÉRIMÈTRE -- STRICTEMENT CE QUI EST DEMANDÉ, RIEN DE PLUS :
--
--   REVOKE SELECT ON TABLE public.orders FROM service_role;
--
-- Aucune autre table n'est touchée (order_items, payment_transactions,
-- payment_provider_configs, restaurants, restaurant_users, tables de
-- livraison -- toutes hors périmètre, mandat section 13). Aucun GRANT
-- n'est ajouté ou modifié : `authenticated` conserve EXACTEMENT son
-- SELECT existant (nécessaire au Dashboard marchand, filtré par la
-- policy RLS "merchant reads restaurant orders" déjà en place depuis
-- PAYMENT v29 -- inchangée, non rouverte). `anon` reste sans privilège.
-- `postgres` (propriétaire de la table) n'est pas affecté. AUCUN
-- `ALTER DEFAULT PRIVILEGES` n'est posé ici (mandat section 12) --
-- l'intrant Production indique que les défauts actuels de la
-- plateforme n'incluent pas SELECT pour service_role sur les tables ;
-- modifier les défauts élargirait le périmètre de ce lot et exigerait
-- une analyse séparée. AUCUNE policy, AUCUN trigger, AUCUNE colonne,
-- AUCUNE fonction n'est créée ou modifiée par ce fichier.
--
-- MODÈLE CIBLE (mandat section 7) : service_role n'a plus d'accès
-- direct de table sur orders -- toute lecture serveur de confiance
-- passe exclusivement par des RPC SECURITY DEFINER déjà publiées
-- (get_order_payment_status, mark_whatsapp_opened,
-- initiate_payment_attempt, get_payment_transaction_correlation,
-- get_payment_runtime_provider_config) ou par le candidat audité
-- PAYMENT P3-B2 (get_order_payment_context, non encore publié,
-- appliqué UNIQUEMENT dans le harnais de test de ce lot pour prouver
-- la compatibilité -- JAMAIS dans cette migration elle-même, mandat
-- section 9). SECURITY DEFINER exécute avec les privilèges du
-- PROPRIÉTAIRE de la fonction, jamais ceux de l'appelant -- retirer le
-- SELECT direct de service_role sur la table ne change donc rien au
-- fonctionnement de ces RPC, prouvé comportementalement (appels réels,
-- pas seulement une assertion de présence) dans le harnais de ce lot.
--
-- RECHERCHE DE CODE (mandat sections 19/20, ré-exécutée fraîchement
-- pour ce lot, pas seulement reprise de l'audit précédent) : AUCUN
-- fichier serveur du dépôt n'appelle `.from("orders")`/`.from('orders')`
-- via le client service_role -- le seul site d'appel existant
-- (lib/services/dashboard.ts) utilise le client anon/session
-- authentifié standard, jamais le client service_role construit par
-- lib/server/supabase-admin.ts. Aucune dépendance applicative réelle
-- sur ce privilège n'a été trouvée -- ce lot ne modifie donc AUCUN
-- fichier TypeScript.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) -- confirme que la forme attendue
-- d'orders (table, RLS, policy marchande) est bien celle documentée
-- par ce lot avant de toucher son ACL, sans jamais supposer une forme
-- différente.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- migration annulée.';
  end if;

  if not exists (
    select 1 from pg_class
    where relname = 'orders' and relnamespace = 'public'::regnamespace and relrowsecurity = true
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: row level security n''est pas active sur public.orders -- forme de schéma inattendue, migration annulée (ce lot ne doit jamais s''appliquer sur une table sans RLS déjà active).';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'orders' and policyname = 'merchant reads restaurant orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: la policy "merchant reads restaurant orders" (PAYMENT v29) est introuvable sur public.orders -- prérequis manquant, migration annulée.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. DURCISSEMENT ACL -- SEULE ET UNIQUE MODIFICATION DE CE LOT.
--
-- REVOKE est intrinsèquement idempotent en PostgreSQL : révoquer un
-- privilège déjà absent ne lève AUCUNE erreur (contrairement à un
-- GRANT redondant, qui reste lui aussi sans erreur mais qui ajouterait
-- un privilège -- ici il n'y a structurellement rien à ajouter). Ce
-- fichier peut donc être rejoué sans risque sur une base où
-- service_role n'a déjà plus ce privilège (mandat section 11).
--
-- `authenticated` n'est PAS mentionné dans cette instruction -- son
-- SELECT existant (posé par une revoke-all suivie d'un grant select
-- implicite via l'ACL déjà en place depuis migration-orders.sql/
-- PAYMENT v29, jamais rouverte ici) reste donc structurellement
-- intact : un REVOKE ciblant explicitement UN SEUL rôle ne peut, par
-- construction, affecter le privilège d'un rôle différent.
-- ------------------------------------------------------------
revoke select on table public.orders from service_role;

commit;
