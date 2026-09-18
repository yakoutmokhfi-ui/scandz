-- =============================================================================
-- Scanym — P0 — ORDER-RECEIVED ENQUEUE REGRESSION RECOVERY v1
-- DEVELOPMENT ONLY — remédiation ADDITIVE, périmètre strictement minimal.
--
-- Baseline gelée : yakoutmokhfi-ui/scandz, main
--   SHA  d38b0fa1d57363419ee7ad8b23ea7fe4d6e7788c
--   TREE 0d6c5676d63256e688ee10f95eeca842da40bc48
--
-- -----------------------------------------------------------------------------
-- RÉGRESSION CORRIGÉE (prouvée empiriquement, jamais supposée)
-- -----------------------------------------------------------------------------
-- N1-A (posé sur main le 14/09/2026) appelait, dans public.create_order :
--     perform public.create_order_received_notification(v_order_id, v_restaurant.id);
-- Un lot CGV ultérieur (DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql,
-- posé le 16/09/2026) redéfinit public.create_order avec la MÊME signature :
-- `create or replace` remplace donc intégralement le corps précédent (aucune
-- surcharge ne coexiste, le dernier appliqué gagne) et l'appel a disparu.
--
-- Preuve empirique (base scratch, chaîne de migrations réelle, vraie commande) :
--   ordre réel   (n1a puis cgv) -> commande créée, notification_outbox = 0 lignes
--   contrôle     (cgv puis n1a) -> commande créée, notification_outbox = 1 ligne
--
-- -----------------------------------------------------------------------------
-- POURQUOI UN DÉCLENCHEUR PLUTÔT QU'UN CORRECTIF DANS create_order
-- -----------------------------------------------------------------------------
-- public.create_order n'est NI modifiée, NI supprimée, NI recréée, NI recopiée
-- par ce lot. C'est délibéré et c'est le cœur de la remédiation :
--
--   1. Reproduire ce corps est précisément ce qui a causé la perte
--      silencieuse de fonctionnalité -- refaire le même geste réarmerait
--      le même piège.
--   2. Un déclencheur SURVIT à la prochaine redéfinition de create_order.
--      C'est la seule forme de correctif qui empêche la RÉCURRENCE, et pas
--      seulement l'occurrence actuelle.
--
-- Déclencheur de CONTRAINTE, DEFERRABLE INITIALLY DEFERRED : il s'exécute à
-- la fin de la transaction, donc après la mise à jour finale des totaux --
-- exactement la même position logique que l'appel d'origine, qui était placé
-- après le dernier `update public.orders`.
--
-- -----------------------------------------------------------------------------
-- CE QUE CE LOT NE FAIT PAS
-- -----------------------------------------------------------------------------
-- Il ARRÊTE LA PERTE D'ÉVÉNEMENTS. Il ne rend AUCUN e-mail livrable :
-- l'éligibilité (merchant_notification_profile), le worker, et le fournisseur
-- réel restent non câblés ; la génération et la livraison de facture ne sont
-- pas implémentées. Aucun de ces points n'est touché ici.
--
-- Aucun envoi réseau, aucun appel fournisseur, aucun e-mail : le déclencheur
-- n'insère qu'une ligne outbox déterministe, dans la transaction de la
-- commande.
--
-- AUCUN RATTRAPAGE HISTORIQUE. Les commandes passées pendant la régression
-- n'ont jamais eu de ligne ; ce lot n'en fabrique aucune (mandat §11).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. PRÉ-VOL — garde anti-dérive et anti-double-application.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders' and c.relkind = 'r'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- P0 ORDER-RECEIVED ENQUEUE RECOVERY v1 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_order_received_notification'
      and pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification(uuid, uuid) introuvable -- le lot N1-A doit être appliqué avant. Annulé.';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.notification_outbox introuvable -- annulé.';
  end if;

  -- L'idempotence de ce lot REPOSE sur cette contrainte préexistante :
  -- on refuse de s'appliquer si elle a disparu, plutôt que de créer un
  -- déclencheur capable de produire des doublons.
  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'notification_outbox' and con.contype = 'u'
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(con.conkey) k
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
      ) = array['notification_type','order_id','restaurant_id']::name[]
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: la contrainte unique (restaurant_id, order_id, notification_type) est absente de notification_outbox -- l''idempotence ne serait plus garantie. Annulé.';
  end if;

  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_enqueue_order_received_trg'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: le déclencheur orders_enqueue_order_received_trg existe déjà -- lot déjà appliqué, annulé.';
  end if;
end $$;

begin;

-- -----------------------------------------------------------------------------
-- 1. Fonction de déclenchement.
--
--    SECURITY DEFINER : create_order_received_notification n'a EXECUTE que
--    pour service_role (N1-A l'a révoqué à public/anon/authenticated). Une
--    commande est créée par un client ANONYME via create_order (elle-même
--    SECURITY DEFINER). Rendre cette fonction SECURITY DEFINER garantit que
--    l'enqueue aboutit quel que soit le rôle appelant, sans élargir aucun
--    droit applicatif.
--
--    AUCUN bloc exception : une erreur d'enqueue doit REMONTER et annuler la
--    commande avec elle (mandat §5 -- "Do not silently swallow unexpected
--    enqueue failures"). C'est exactement le contrat d'origine de N1-A :
--    une commande validée ne perd JAMAIS silencieusement son événement.
-- -----------------------------------------------------------------------------
create function public.tg_orders_enqueue_order_received()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.create_order_received_notification(new.id, new.restaurant_id);
  return null; -- déclencheur AFTER : la valeur de retour est ignorée.
end $$;

comment on function public.tg_orders_enqueue_order_received() is
  'P0 ORDER-RECEIVED ENQUEUE RECOVERY v1 — enfile l''événement order_received pour une commande nouvellement créée, en appelant la fonction N1-A existante. Ne modifie JAMAIS public.create_order. Aucun appel réseau, aucun envoi d''e-mail : insertion outbox déterministe uniquement, dans la transaction de la commande. Idempotence assurée par la contrainte unique (restaurant_id, order_id, notification_type) + ON CONFLICT DO NOTHING du helper. Aucune capture d''exception : un échec d''enqueue annule la commande, conformément au contrat transactionnel d''origine.';

-- Non exécutable directement par les rôles applicatifs (mandat §10). Un
-- déclencheur n'exige pas le privilège EXECUTE de l'utilisateur déclencheur :
-- le harnais le PROUVE en créant une commande en tant qu'anon après cette
-- révocation.
revoke all on function public.tg_orders_enqueue_order_received() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Déclencheur de contrainte, différé en fin de transaction.
-- -----------------------------------------------------------------------------
create constraint trigger orders_enqueue_order_received_trg
after insert on public.orders
deferrable initially deferred
for each row
execute function public.tg_orders_enqueue_order_received();

commit;

-- -----------------------------------------------------------------------------
-- 3. POST-VOL — vérifications réelles après application.
-- -----------------------------------------------------------------------------
do $$
declare
  v_tg record;
  v_def text;
begin
  select t.tgname, t.tgtype, t.tgdeferrable, t.tginitdeferred, t.tgconstraint
    into v_tg
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'orders'
    and t.tgname = 'orders_enqueue_order_received_trg';

  if v_tg is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: déclencheur absent après application.';
  end if;
  if not v_tg.tgdeferrable or not v_tg.tginitdeferred then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: le déclencheur n''est pas DEFERRABLE INITIALLY DEFERRED.';
  end if;
  if v_tg.tgconstraint = 0 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: ce n''est pas un déclencheur de CONTRAINTE.';
  end if;
  -- tgtype : bit 0 = ROW, bit 2 = INSERT (AFTER = bit 1 à 0).
  if (v_tg.tgtype & 1) = 0 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: le déclencheur n''est pas FOR EACH ROW.';
  end if;
  if (v_tg.tgtype & 4) = 0 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: le déclencheur n''est pas sur INSERT.';
  end if;
  if (v_tg.tgtype & 2) <> 0 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: le déclencheur est BEFORE, or AFTER est requis.';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tg_orders_enqueue_order_received';

  if v_def is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: fonction de déclenchement absente.';
  end if;
  if not (v_def like '%SECURITY DEFINER%' and v_def like '%search_path%') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: fonction de déclenchement sans SECURITY DEFINER / search_path fixé.';
  end if;
  if v_def like '%exception%when%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la fonction de déclenchement capture des exceptions -- interdit (§5).';
  end if;

  if has_function_privilege('anon', 'public.tg_orders_enqueue_order_received()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.tg_orders_enqueue_order_received()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.tg_orders_enqueue_order_received()', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: un rôle applicatif peut exécuter directement la fonction de déclenchement -- jamais attendu.';
  end if;

  -- public.create_order ne doit avoir été ni modifiée ni supprimée.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: public.create_order a disparu -- jamais attendu, ce lot ne doit pas y toucher.';
  end if;
end $$;

-- =============================================================================
-- RÉSUMÉ
--   Créés    : public.tg_orders_enqueue_order_received() (fonction de
--              déclenchement) + orders_enqueue_order_received_trg
--              (déclencheur de contrainte différé sur public.orders).
--   Modifiés : AUCUN objet existant. public.create_order n'est pas touchée.
--   Grants   : AUCUN accordé ; EXECUTE révoqué à tous les rôles applicatifs.
--   Données  : AUCUNE écriture, aucun rattrapage historique.
--   RLS      : inchangée, aucune policy touchée.
-- =============================================================================
