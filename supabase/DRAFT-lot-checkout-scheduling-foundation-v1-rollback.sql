-- ============================================================
-- Scanym — CHECKOUT SCHEDULING FOUNDATION v1  (CSDJ-1) — RETOUR ARRIÈRE
-- (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Parent : main 412dbb53c5f180983860852b79425209c04b9c42
--          (tree b53db34c4897dff5dba150ba0bf9de1aff7ee873).
-- Aller : DRAFT-lot-checkout-scheduling-foundation-v1.sql
--
-- ────────────────────────────────────────────────────────────────────
-- CE QUE CE RETOUR FAIT
--
--   1. supprime les quatre RPC et l'autorité d'éligibilité du lot ;
--   2. supprime les quatre catalogues fermés du lot et les deux
--      fonctions de politique d'heure murale ;
--   3. supprime les quatre tables du lot, dans l'ordre inverse de
--      leurs dépendances -- les trois tables filles d'abord, la table
--      de planification ensuite.
--
-- ────────────────────────────────────────────────────────────────────
-- CE QUE CE RETOUR NE FAIT PAS
--
--   - il ne touche à AUCUNE fonction préexistante, pour la raison
--     simple que l'aller n'en a redéfini aucune : `create_order`,
--     `resolve_delivery_fulfillment` et les projections publiques de
--     livraison sont exactement celles d'avant, et le post-vol de
--     l'aller le prouve. Il n'y a donc RIEN à restaurer verbatim ;
--   - il ne touche à aucune donnée de commande, de tarification ou de
--     communication : l'aller n'en a créé ni modifié aucune ;
--   - il ne supprime aucune règle de livraison ni aucun mode de vente.
--
-- ────────────────────────────────────────────────────────────────────
-- PERTE DE DONNÉES ASSUMÉE ET EXPLICITE
--
-- Toute planification configurée après l'application de l'aller --
-- fuseau, politiques, fenêtres, créneaux nommés, fermetures
-- exceptionnelles -- est DÉFINITIVEMENT PERDUE par ce retour. Ce sont
-- des données de CONFIGURATION marchande, jamais des données de
-- commande : aucune commande n'y fait référence en CSDJ-1, puisque
-- l'instantané de commande est le périmètre de CSDJ-3 et n'existe pas
-- encore. Ce retour est donc sans danger pour l'historique, et
-- destructeur pour la configuration.
--
-- ────────────────────────────────────────────────────────────────────
-- ATOMICITÉ — CSDJ1-V1-SQL-ATOMICITY-01
--
-- Une seule transaction, pré-vol dedans, `commit;` en dernière
-- instruction exécutable.
-- ============================================================

begin;

-- ============================================================
-- §0  PRÉ-VOL — anti-double-application du RETOUR
-- ============================================================
do $csdj1_rollback_preflight$
begin
  -- Si plus rien du lot n'existe, ce retour a déjà été passé. Le
  -- rejouer silencieusement ferait croire à un succès là où il n'y a
  -- rien eu à faire.
  if pg_catalog.to_regclass('public.restaurant_fulfillment_schedule') is null
     and pg_catalog.to_regprocedure('public.checkout_date_selection_modes()') is null
     and pg_catalog.to_regprocedure('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)') is null
  then
    raise exception 'SCANYM_ALREADY_REVERTED: aucun objet de CHECKOUT SCHEDULING FOUNDATION v1 n''est présent -- retour annulé.'
      using errcode = '42704';
  end if;

  -- Garde de périmètre : si une table d'instantané de CSDJ-3 existe,
  -- elle référence la planification, et supprimer celle-ci sous elle
  -- casserait un historique de commandes. On refuse plutôt que de
  -- détruire.
  if pg_catalog.to_regclass('public.order_fulfillment_schedule_snapshot') is not null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: order_fulfillment_schedule_snapshot (CSDJ-3) est présente -- retirer CSDJ-3 avant CSDJ-1.'
      using errcode = '2BP01';
  end if;
end
$csdj1_rollback_preflight$;

-- ============================================================
-- §A  RPC et autorité d'éligibilité
-- ============================================================
drop function if exists public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb);
drop function if exists public.get_merchant_fulfillment_schedules(uuid);
drop function if exists public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric);
drop function if exists public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz);
drop function if exists public.checkout_wall_time_instant(date,time,text);
drop function if exists public.checkout_wall_time_status(date,time,text);
drop function if exists public.checkout_wall_time_statuses();

-- ============================================================
-- §B  Tables — filles d'abord
--
-- Les CHECK des tables appellent les catalogues : il faut donc
-- supprimer les tables AVANT les fonctions, sinon la suppression d'un
-- catalogue serait refusée pour dépendance.
-- ============================================================
drop table if exists public.restaurant_fulfillment_schedule_closure;
drop table if exists public.restaurant_fulfillment_schedule_slot;
drop table if exists public.restaurant_fulfillment_schedule_window;
drop table if exists public.restaurant_fulfillment_schedule;

-- ============================================================
-- §C  Catalogues fermés
-- ============================================================
drop function if exists public.checkout_unfulfillable_reasons();
drop function if exists public.checkout_schedule_statuses();
drop function if exists public.checkout_slot_selection_modes();
drop function if exists public.checkout_date_selection_modes();

-- ============================================================
-- §Z  POST-VOL DU RETOUR
-- ============================================================
do $csdj1_rollback_postflight$
declare
  v_name text;
  v_n    integer;
begin
  foreach v_name in array array[
    'public.restaurant_fulfillment_schedule',
    'public.restaurant_fulfillment_schedule_window',
    'public.restaurant_fulfillment_schedule_slot',
    'public.restaurant_fulfillment_schedule_closure'
  ] loop
    if pg_catalog.to_regclass(v_name) is not null then
      raise exception 'SCANYM_POSTCHECK: % subsiste après le retour.', v_name;
    end if;
  end loop;

  foreach v_name in array array[
    'public.checkout_date_selection_modes()',
    'public.checkout_slot_selection_modes()',
    'public.checkout_schedule_statuses()',
    'public.checkout_unfulfillable_reasons()',
    'public.checkout_wall_time_statuses()',
    'public.checkout_wall_time_status(date,time without time zone,text)',
    'public.checkout_wall_time_instant(date,time without time zone,text)',
    'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)',
    'public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)',
    'public.get_merchant_fulfillment_schedules(uuid)',
    'public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)'
  ] loop
    if pg_catalog.to_regprocedure(v_name) is not null then
      raise exception 'SCANYM_POSTCHECK: % subsiste après le retour.', v_name;
    end if;
  end loop;

  -- L'environnement préexistant est INTACT : l'aller n'y avait pas
  -- touché, le retour ne doit donc pas l'avoir abîmé.
  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';
  if v_n <> 1 then
    raise exception 'SCANYM_POSTCHECK: create_order a % surcharge(s) après le retour.', v_n;
  end if;
  if pg_catalog.to_regprocedure('public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)') is null then
    raise exception 'SCANYM_POSTCHECK: l''autorité de tarification a disparu.';
  end if;
  if pg_catalog.to_regclass('public.restaurant_sale_mode_fulfillments') is null then
    raise exception 'SCANYM_POSTCHECK: restaurant_sale_mode_fulfillments a disparu.';
  end if;
end
$csdj1_rollback_postflight$;

commit;
