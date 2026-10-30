-- =============================================================================
-- Scanym — ORDER_RECEIVED PAYMENT GATE v1 — ROLLBACK (DEVELOPMENT ONLY)
-- Restaure claim_pending_notifications À L'IDENTIQUE du lot N1-A et retire la
-- porte. Aucune donnée outbox n'est modifiée.
--
-- PRÉREQUIS (hors SQL, à confirmer AVANT exécution) :
--   * les workers de notification sont ARRÊTÉS : sans porte, un worker réclame
--     et enverrait n'importe quel order_received (paiement non confirmé inclus) ;
--   * stratégie explicite pour les décisions perdues : le retour arrière
--     supprime la colonne orders.payment_mode_final (décisions « sans paiement
--     en ligne » comprises). Le nombre de décisions concernées est signalé en
--     NOTICE (SCANYM_ROLLBACK_NOTICE) ; aucune n'est restaurable ensuite.
--
-- PRÉ-VOL (T180-02, étendu par T180-R4-01) : AUCUNE écriture n'a lieu tant que
-- TOUS les objets que ce script remplace ou supprime ne sont pas encore tels que ce
-- lot les a posés. Sinon : SCANYM_PREDECESSOR_DRIFT, transaction annulée, rien
-- supprimé, rien modifié, aucune décision payment_mode_final perdue.
--   * claim_pending_notifications (remplacée) : empreinte exacte du corps + TOUS les
--     attributs de pg_proc (STRICT compris) + ensemble COMPLET des droits EXECUTE =
--     {propriétaire, service_role}, sans option de transmission ; mêmes règles que le lot.
--   * notification_send_gate_open, orders_payment_mode_final_guard,
--     finalize_order_payment_mode_none (supprimées) : présence, empreinte du corps,
--     arguments, type de retour, TOUS les attributs de pg_proc, propriétaire = rôle
--     qui applique le script, droits EXECUTE sans option de transmission :
--       - finalize : exactement {propriétaire, service_role} ;
--       - porte et garde : {propriétaire} ou {propriétaire, service_role} (le second cas
--         est ce que donnent des privilèges par défaut de plateforme) ; tout autre
--         bénéficiaire (PUBLIC, anon, authenticated, rôle supplémentaire) est refusé.
--   * déclencheur orders_payment_mode_final_guard_trg : empreinte de pg_trigger
--     (moment, évènements, colonnes, clause WHEN, état d'activation, fonction appelée…).
--   * contrainte orders_payment_mode_final_check : type, validée, différable, définition.
--   * colonne orders.payment_mode_final : type, NOT NULL, défaut, génération, identité ;
--     aucun objet inconnu (index, déclencheur de colonne, vue, politique, statistique…)
--     ne dépend d'elle en dehors de la contrainte ci-dessus.
-- Le retour arrière reste ce qu'il était : il SUPPRIME la colonne
-- payment_mode_final ; les décisions « sans paiement en ligne » ne sont pas conservées
-- (signalées en NOTICE, une fois seulement que tous les contrôles ont réussi).
--
-- LIMITES ASSUMÉES (contrat borné, à ne pas présenter comme une garantie totale) :
--   * Les commentaires (COMMENT ON) des fonctions et de la colonne ne sont pas comparés.
--   * Les droits au niveau de la colonne et les dépendances non enregistrées dans
--     pg_depend (un corps plpgsql qui appellerait la porte par son nom) ne sont pas
--     détectables ; un objet dépendant ENREGISTRÉ fait échouer les DROP sans CASCADE
--     (transaction annulée).
--   * La définition de la contrainte est comparée sans espaces ni parenthèses,
--     en minuscules (robustesse entre versions de PostgreSQL).
--   * Les contrôles sont faits dans la même transaction que les suppressions, workers
--     arrêtés (prérequis ci-dessus) : une modification concurrente exactement entre
--     le contrôle et la suppression n'est pas verrouillée.
--   * Privilèges par défaut hébergés : non vérifiés sur la base hébergée (INCONCLUSIF).
-- =============================================================================

begin;

do $$
declare
  c_gated_body_md5 constant text := '16d75b38372fd5dfd0ca1a4e20dfa3a8';
  c_expected_args  constant text := 'p_batch_size integer DEFAULT 10, p_lease_seconds integer DEFAULT 60';
  c_expected_result constant text := 'TABLE(outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text, recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer, claim_token uuid, sender_name text, sender_email text, reply_to text)';
  -- Attributs de pg_proc que CREATE OR REPLACE réécrit (explicitement ou par valeur
  -- par défaut) : un écart est une variante opérationnelle inconnue, jamais normalisée.
  c_expected_attrs constant text := 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=t;cost=100;rows=1000;support=0;variadic=0;nargs=2;ndefaults=2;config=search_path=""';
  v_oid      oid;
  v_owner    oid;
  v_args     text;
  v_result   text;
  v_md5      text;
  v_attrs    text;
  v_acl      text[];
  v_expected_acl text[];
begin
  if to_regprocedure('public.notification_send_gate_open(uuid, text)') is null then
    raise exception 'SCANYM_ROLLBACK_PREFLIGHT_FAILED: notification_send_gate_open est absente -- lot non appliqué ou déjà annulé. Rollback annulé, rien modifié.';
  end if;

  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_pending_notifications'
  ) <> 1 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: claim_pending_notifications doit exister en UNE seule surcharge. Rollback annulé, rien modifié.';
  end if;

  select p.oid,
         p.proowner,
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         md5(replace(p.prosrc, E'\r', '')),
         format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s',
                p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')),
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
    into v_oid, v_owner, v_args, v_result, v_md5, v_attrs, v_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'claim_pending_notifications';

  if v_md5 is distinct from c_gated_body_md5 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: claim_pending_notifications (md5 %) n''est plus celle posée par ce lot (md5 %) -- modifiée depuis. Rollback annulé, rien modifié.', v_md5, c_gated_body_md5;
  end if;

  if v_attrs is distinct from c_expected_attrs
     or v_args is distinct from c_expected_args
     or v_result is distinct from c_expected_result then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: attributs de claim_pending_notifications différents de ceux posés par ce lot (SECURITY DEFINER, STRICT, volatilité, LEAKPROOF, PARALLEL, COST/ROWS, langage, search_path, arguments, colonnes retournées). Observé : % ; attendu : %.', v_attrs, c_expected_attrs;
  end if;

  -- Droits (politique explicite) : l'ENSEMBLE COMPLET des bénéficiaires EXECUTE doit
  -- être exactement {propriétaire, service_role}, accordé par le propriétaire, sans
  -- option de transmission, sans PUBLIC ni aucun autre rôle (anon, authenticated ou
  -- tout rôle supplémentaire). Le propriétaire doit être le rôle qui applique ce
  -- script. Aucun droit inconnu n'est révoqué ni accordé silencieusement : refus.
  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
     or v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits d''exécution de claim_pending_notifications différents de ceux posés par ce lot (propriétaire = rôle appliquant le script ET service_role, rien d''autre, sans option de transmission). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié ni révoqué silencieusement.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;
end $$;

-- T180-R4-01 : pré-vol des objets AUXILIAIRES du lot, avant toute écriture (cf. en-tête).
do $$
declare
  -- Constantes = ce que PostgreSQL stocke après l'installation du lot (vérifié par
  -- les tests [172-PRE-11], PGlite et PostgreSQL réel).
  c_trigger_fp    constant text := 'tgtype=19;enabled=O;function_is_guard=t;columns=payment_status;has_when=f;nargs=0;internal=f;deferrable=f;initdeferred=f;constraint=0;oldtable=;newtable=';
  c_constraint_fp constant text := 'type=c;validated=t;deferrable=f;initdeferred=f;def=checkpayment_mode_finalisnullorpayment_mode_final=anyarray[''online''::text,''none''::text]';
  c_column_fp     constant text := 'type=text;notnull=f;hasdef=f;generated=;identity=;dims=0';
  r              record;
  v_owner        oid;
  v_args         text;
  v_result       text;
  v_md5          text;
  v_attrs        text;
  v_acl          text[];
  v_owner_entry  text;
  v_service_entry text;
  v_expected_acl text[];
  v_acl_ok       boolean;
  v_fp           text;
  v_oid          oid;
  v_attnum       smallint;
  v_deps         text;
  v_lost         bigint;
begin
  for r in
    select * from (values
      ('public.notification_send_gate_open(uuid, text)', 'af45d47018ebf6e1b1ac379c9036eb23', 'p_order_id uuid, p_notification_type text', 'boolean', 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=s;parallel=u;retset=f;cost=100;rows=0;support=0;variadic=0;nargs=2;ndefaults=0;config=search_path=""', false),
      ('public.orders_payment_mode_final_guard()', 'b09144732b553043b69b0f6dbbceafb5', '', 'trigger', 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=f;cost=100;rows=0;support=0;variadic=0;nargs=0;ndefaults=0;config=search_path=""', false),
      ('public.finalize_order_payment_mode_none(uuid, uuid)', 'ba2b1dab8544d364aec5b90b561c15f3', 'p_order_id uuid, p_public_token uuid', 'TABLE(payment_status text, payment_mode_final text)', 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=t;cost=100;rows=1000;support=0;variadic=0;nargs=2;ndefaults=0;config=search_path=""', true)
    ) as t(sig, body_md5, args, result, attrs, service_role_required)
  loop
    select p.proowner,
           pg_get_function_arguments(p.oid),
           pg_get_function_result(p.oid),
           md5(replace(p.prosrc, E'\r', '')),
           format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s',
                  p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                  p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                  p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')),
           (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
              from (select format('%s=%s/%s%s',
                                  case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                  a.privilege_type, a.grantor::regrole::text,
                                  case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
      into v_owner, v_args, v_result, v_md5, v_attrs, v_acl
    from pg_proc p
    join pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure(r.sig)::oid;

    if not found then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: % est absent -- supprimé depuis l''installation du lot. Rollback annulé, rien supprimé ni modifié.', r.sig;
    end if;

    if v_md5 is distinct from r.body_md5 then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: le corps de % (md5 %) n''est plus celui posé par ce lot (md5 %) -- modifié depuis. Rollback annulé, rien supprimé ni modifié.', r.sig, v_md5, r.body_md5;
    end if;

    if v_attrs is distinct from r.attrs
       or v_args is distinct from r.args
       or v_result is distinct from r.result then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: attributs de % différents de ceux posés par ce lot (SECURITY DEFINER, STRICT, volatilité, LEAKPROOF, PARALLEL, COST/ROWS, langage, search_path, arguments, type de retour). Observé : % / % / % ; attendu : % / % / %. Rollback annulé, rien supprimé ni modifié.',
        r.sig, v_attrs, v_args, v_result, r.attrs, r.args, r.result;
    end if;

    -- Droits : propriétaire = rôle qui applique le script ; aucun bénéficiaire inconnu,
    -- aucune option de transmission. service_role est OBLIGATOIRE pour finalize (le lot
    -- le lui accorde) et TOLÉRÉ pour la porte et la garde (privilège par défaut possible).
    v_owner_entry   := format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text);
    v_service_entry := format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text);
    v_expected_acl  := (select array_agg(x order by x) from unnest(array[v_owner_entry, v_service_entry]) as x);
    v_acl_ok := v_acl is not distinct from v_expected_acl
                or (not r.service_role_required and v_acl is not distinct from array[v_owner_entry]);
    if v_owner is distinct from (select ro.oid from pg_roles ro where ro.rolname = current_user)
       or not v_acl_ok then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: droits d''exécution de % différents de ceux posés par ce lot (propriétaire = rôle appliquant le script, % service_role, rien d''autre, sans option de transmission). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié ni révoqué silencieusement. Rollback annulé, rien supprimé ni modifié.',
        r.sig,
        case when r.service_role_required then 'plus' else 'éventuellement plus' end,
        v_owner::regrole::text, v_acl, v_expected_acl;
    end if;
  end loop;

  -- Déclencheur : empreinte de pg_trigger (et non pg_get_triggerdef, qui dépend du search_path).
  -- La clause WHEN n'est pas déparsée (pg_get_expr échoue sur OLD/NEW) : sa seule présence est un écart.
  select format('tgtype=%s;enabled=%s;function_is_guard=%s;columns=%s;has_when=%s;nargs=%s;internal=%s;deferrable=%s;initdeferred=%s;constraint=%s;oldtable=%s;newtable=%s',
                t.tgtype, t.tgenabled, t.tgfoid = to_regprocedure('public.orders_payment_mode_final_guard()'),
                (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)),
                t.tgqual is not null, t.tgnargs, t.tgisinternal, t.tgdeferrable, t.tginitdeferred,
                t.tgconstraint, coalesce(t.tgoldtable, ''), coalesce(t.tgnewtable, ''))
    into v_fp
  from pg_trigger t
  where t.tgrelid = 'public.orders'::regclass and t.tgname = 'orders_payment_mode_final_guard_trg';
  if v_fp is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: déclencheur orders_payment_mode_final_guard_trg est absent de public.orders -- supprimé depuis l''installation du lot. Rollback annulé, rien supprimé ni modifié.';
  end if;
  if v_fp is distinct from c_trigger_fp then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: déclencheur orders_payment_mode_final_guard_trg différent de celui posé par ce lot (moment, colonnes, clause WHEN, activation, fonction). Observé : % ; attendu : %. Rollback annulé, rien supprimé ni modifié.', v_fp, c_trigger_fp;
  end if;

  -- Contrainte.
  select c.oid,
         format('type=%s;validated=%s;deferrable=%s;initdeferred=%s;def=%s',
                c.contype, c.convalidated, c.condeferrable, c.condeferred,
                regexp_replace(lower(pg_get_constraintdef(c.oid)), '[\s()]', '', 'g'))
    into v_oid, v_fp
  from pg_constraint c
  where c.conrelid = 'public.orders'::regclass and c.conname = 'orders_payment_mode_final_check';
  if v_fp is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: contrainte orders_payment_mode_final_check est absente de public.orders -- supprimée depuis l''installation du lot. Rollback annulé, rien supprimé ni modifié.';
  end if;
  if v_fp is distinct from c_constraint_fp then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: contrainte orders_payment_mode_final_check différente de celle posée par ce lot. Observé : % ; attendu : %. Rollback annulé, rien supprimé ni modifié.', v_fp, c_constraint_fp;
  end if;

  -- Colonne.
  select a.attnum,
         format('type=%s;notnull=%s;hasdef=%s;generated=%s;identity=%s;dims=%s',
                format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity, a.attndims)
    into v_attnum, v_fp
  from pg_attribute a
  where a.attrelid = 'public.orders'::regclass and a.attname = 'payment_mode_final' and not a.attisdropped;
  if v_fp is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: colonne orders.payment_mode_final est absente -- supprimée depuis l''installation du lot. Rollback annulé, rien supprimé ni modifié.';
  end if;
  if v_fp is distinct from c_column_fp then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: colonne orders.payment_mode_final différente de celle posée par ce lot. Observé : % ; attendu : %. Rollback annulé, rien supprimé ni modifié.', v_fp, c_column_fp;
  end if;

  -- Aucun objet INCONNU ne doit dépendre de la colonne (index, déclencheur de colonne,
  -- vue, politique, statistique…) : la suppression de la colonne l'emporterait ou échouerait.
  select string_agg(distinct pg_describe_object(d.classid, d.objid, d.objsubid), ', ')
    into v_deps
  from pg_depend d
  where d.refclassid = 'pg_class'::regclass
    and d.refobjid = 'public.orders'::regclass
    and d.refobjsubid = v_attnum
    and not (d.classid = 'pg_constraint'::regclass and d.objid = v_oid);
  if v_deps is not null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: des objets inconnus dépendent de orders.payment_mode_final : %. Rollback annulé, rien supprimé ni modifié.', v_deps;
  end if;

  -- Tous les contrôles ont réussi : seulement maintenant, l'avertissement sur les décisions perdues.
  execute 'select count(*) from public.orders where payment_mode_final is not null' into v_lost;
  raise notice 'SCANYM_ROLLBACK_NOTICE: % décision(s) payment_mode_final seront définitivement perdues par ce retour arrière.', v_lost;
end $$;

create or replace function public.claim_pending_notifications(
  p_batch_size    integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  outbox_id           uuid,
  restaurant_id       uuid,
  order_id            uuid,
  notification_type   text,
  recipient_email      text,
  locale              text,
  payload_snapshot    jsonb,
  attempt_count       integer,
  claim_token         uuid,
  sender_name         text,
  sender_email        text,
  reply_to            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 10), 100));
  v_lease      integer := greatest(1, least(coalesce(p_lease_seconds, 60), 3600));
begin
  return query
  with eligible as (
    select o.id
    from public.notification_outbox o
    where o.status in ('pending', 'failed_retryable')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
    order by o.created_at, o.id
    limit v_batch_size
    for update skip locked
  ),
  claimed as (
    update public.notification_outbox o
    set status = 'processing',
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => v_lease)
    from eligible
    where o.id = eligible.id
    returning o.id, o.restaurant_id, o.order_id, o.notification_type,
              o.recipient_email, o.locale, o.payload_snapshot, o.attempt_count, o.claim_token
  )
  select
    c.id, c.restaurant_id, c.order_id, c.notification_type,
    c.recipient_email, c.locale, c.payload_snapshot, c.attempt_count, c.claim_token,
    p.sender_name, p.sender_email, p.reply_to
  from claimed c
  left join public.merchant_notification_profile p on p.restaurant_id = c.restaurant_id
  order by c.id;
end $$;

comment on function public.claim_pending_notifications(integer, integer) is
  'N1-A — réclame un lot de notifications éligibles (FOR UPDATE SKIP LOCKED + bail, calqué sur claim_stuart_provider_events). Résout l''identité d''expéditeur FRAÎCHE via jointure sur le restaurant_id de la ligne outbox elle-même -- jamais un restaurant_id fourni par l''appelant -- garantit structurellement l''isolation tenant du worker. Deux workers concurrents ne peuvent jamais réclamer la même ligne (verrouillage ligne + SKIP LOCKED). Fenêtre de crash résiduelle documentée README-AUDIT.md §10 (reap_stale_notification_claims).';

revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer, integer) to service_role;

drop function public.notification_send_gate_open(uuid, text);

drop trigger if exists orders_payment_mode_final_guard_trg on public.orders;
drop function if exists public.orders_payment_mode_final_guard();
drop function if exists public.finalize_order_payment_mode_none(uuid, uuid);
alter table public.orders drop constraint if exists orders_payment_mode_final_check;
alter table public.orders drop column if exists payment_mode_final;

commit;
