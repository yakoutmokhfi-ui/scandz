-- Roll back MERCHANT SMTP PROVIDER CONFIG v1 (révision R1).
--
-- Refuse, AVANT toute écriture :
--   * si le claim n'est plus EXACTEMENT celui posé par le lot SMTP (empreinte du
--     corps, attributs, arguments, colonnes, propriétaire, ACL) ;
--   * (R4) si la fonction d'écriture du profil sous bail n'est plus EXACTEMENT celle posée par le lot
--     (corps sur les octets exacts, attributs dont STRICT / SECURITY DEFINER / search_path, signature,
--     propriétaire, droits, commentaire, surcharge unique) : elle est supprimée par ce script, et un
--     rollback ne supprime que ce que le lot a posé, à l'identique -- sinon refus, rien n'est modifié ;
--   * si le coffre contient des configurations (SCANYM_ROLLBACK_DATA_LOSS).
-- Restaure ensuite le claim de #180 OCTET POUR OCTET (même empreinte md5, même
-- commentaire) -- le rollback de #180 reste donc possible -- puis supprime le
-- coffre. Aucune tentative de notification ni lien de suivi n'est modifié.
-- Ordre : ce rollback d'abord, ensuite celui de #180.
--
-- Course (contre-audit R2) : le contrôle « le coffre est vide » et le DROP TABLE ne forment pas une
-- opération atomique face à une écriture concurrente (un commerçant qui enregistre pendant le retour
-- arrière) : sans verrou, la ligne insérée entre les deux est supprimée avec la table, en silence.
-- La table est donc verrouillée en ACCÈS EXCLUSIF avant tout contrôle et jusqu'au COMMIT : toute écriture
-- en cours se termine AVANT le contrôle (et le fait alors refuser), toute écriture suivante attend, puis
-- échoue proprement. Un verrou non obtenu en 10 s annule le retour arrière (rien n'est modifié).
-- À lancer Cron arrêté (le claim lit aussi cette table) -- voir docs/merchant-email-provider-v1.md.
--
-- Limite connue (R4) : une fonction ne se verrouille pas en SQL. Le contrôle d'identité de la fonction sous bail
-- et son DROP se suivent dans la même transaction, mais un ALTER/CREATE OR REPLACE FUNCTION exécuté par un autre
-- administrateur ENTRE les deux ne serait pas vu. Le DROP est volontairement sans IF EXISTS (une fonction
-- disparue entre-temps annule tout) ; aucune modification de schéma concurrente ne doit être lancée pendant le
-- retour arrière (même consigne que « Cron arrêté »).
begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regclass('public.merchant_email_provider_config') is null
     or to_regprocedure('public.claim_pending_notifications(integer,integer)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: SMTP migration is not installed';
  end if;
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_pending_notifications'
  ) <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: claim_pending_notifications doit exister en UNE seule surcharge. Annulé.';
  end if;
end $$;

lock table public.merchant_email_provider_config in access exclusive mode;

do $$
declare
  -- Empreinte du corps sur les OCTETS EXACTS de prosrc (aucune normalisation : un CR isolé dans
  -- un littéral changerait le comportement de la fonction sans changer une empreinte « sans CR »).
  -- Deux formes admises, rien d'autre : fins de ligne LF (dépôt) ou TOUTES en CRLF (extraction Windows).
  c_expected_body_md5      constant text := 'cf3cfb8055dab9cc93e3ce5b8563a46a';
  c_expected_body_md5_crlf constant text := 'e8b88f88d8334fb6ca62c18992057d2a';
  -- Le commentaire de la fonction fait partie de ce que le retour arrière restaure : il est épinglé.
  c_expected_comment_md5   constant text := '2686f2b19c67dd1aac715fad99c91d3e';
  c_expected_args     constant text := 'p_batch_size integer DEFAULT 10, p_lease_seconds integer DEFAULT 60';
  c_expected_result   constant text := 'TABLE(outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text, recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer, claim_token uuid, sender_name text, sender_email text, reply_to text)';
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
  v_comment_md5 text;
  v_expected_acl text[];
begin
  select p.oid,
         p.proowner,
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         md5(p.prosrc),
         format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s',
                p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')),
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e),
         md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
    into v_oid, v_owner, v_args, v_result, v_md5, v_attrs, v_acl, v_comment_md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'claim_pending_notifications';

  if v_oid is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: claim_pending_notifications est introuvable. Rollback annulé, rien modifié.';
  end if;

  if v_md5 not in (c_expected_body_md5, c_expected_body_md5_crlf) then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le corps de claim_pending_notifications (md5 %) n''est plus celui posé par le lot SMTP -- modifié depuis (md5 %). Rollback annulé, rien modifié.', v_md5, c_expected_body_md5;
  end if;

  if v_attrs is distinct from c_expected_attrs
     or v_args is distinct from c_expected_args
     or v_result is distinct from c_expected_result then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: attributs de claim_pending_notifications différents de ceux posés par le lot SMTP (SECURITY DEFINER, STRICT, volatilité, LEAKPROOF, PARALLEL, COST/ROWS, langage, search_path, arguments, colonnes retournées). Observé : % ; attendu : %.', v_attrs, c_expected_attrs;
  end if;

  if v_comment_md5 is distinct from c_expected_comment_md5 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le commentaire de claim_pending_notifications (md5 %) n''est pas celui posé par le lot SMTP (md5 %). Rollback annulé, rien modifié.', v_comment_md5, c_expected_comment_md5;
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
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits d''exécution de claim_pending_notifications différents de ceux posés par le lot SMTP (propriétaire = rôle appliquant le script ET service_role, rien d''autre, sans option de transmission). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié ni révoqué silencieusement.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;
end $$;

-- R4 (contre-contre-audit de c8e023e) : la fonction d'écriture du profil sous bail est supprimée plus bas. Elle
-- est donc vérifiée ICI, sous le même verrou et AVANT toute mutation, selon la même norme que le claim : identité
-- exacte ou refus. Sans ce contrôle, `ALTER FUNCTION ... STRICT` (ou toute autre dérive) était supprimée en silence.
do $$
declare
  c_lease_signature     constant text := 'public.set_merchant_notification_profile_under_save_lease(uuid,uuid,boolean,text,text,text,text)';
  -- Empreinte du corps sur les OCTETS EXACTS de prosrc : LF (dépôt) ou TOUTES fins de ligne CRLF (extraction Windows).
  c_lease_body_md5      constant text := '80c1a2d22298cde637c63a2b45b78d2a';
  c_lease_body_md5_crlf constant text := '716bfcc304ea7ed2ac40408fc6a2e286';
  c_lease_comment_md5   constant text := '3242a617c0f25c05ea5c00a8ddf4dc9b';
  c_lease_args   constant text := 'p_restaurant_id uuid, p_save_token uuid, p_email_enabled boolean, p_sender_name text DEFAULT NULL::text, p_sender_email text DEFAULT NULL::text, p_reply_to text DEFAULT NULL::text, p_default_locale text DEFAULT ''fr''::text';
  c_lease_result constant text := 'void';
  -- Attributs de pg_proc : un écart (STRICT, SECURITY INVOKER, search_path, volatilité, LEAKPROOF, PARALLEL,
  -- COST/ROWS, langage...) est une variante inconnue, jamais normalisée.
  c_lease_attrs  constant text := 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=f;cost=100;rows=0;support=0;variadic=0;nargs=7;ndefaults=4;config=search_path=""';
  v_oid      oid;
  v_owner    oid;
  v_args     text;
  v_result   text;
  v_md5      text;
  v_attrs    text;
  v_acl      text[];
  v_comment_md5 text;
  v_expected_acl text[];
begin
  select p.oid,
         p.proowner,
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         md5(p.prosrc),
         format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s',
                p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')),
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e),
         md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
    into v_oid, v_owner, v_args, v_result, v_md5, v_attrs, v_acl, v_comment_md5
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  where p.oid = to_regprocedure(c_lease_signature);

  if v_oid is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: set_merchant_notification_profile_under_save_lease est introuvable alors que le coffre existe : l''état n''est plus celui posé par le lot SMTP. Rollback annulé, rien modifié.';
  end if;

  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_merchant_notification_profile_under_save_lease'
  ) <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: set_merchant_notification_profile_under_save_lease doit exister en UNE seule surcharge. Rollback annulé, rien modifié.';
  end if;

  if v_md5 not in (c_lease_body_md5, c_lease_body_md5_crlf) then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le corps de set_merchant_notification_profile_under_save_lease (md5 %) n''est plus celui posé par le lot SMTP (md5 %) -- modifié depuis. Rollback annulé, rien modifié.', v_md5, c_lease_body_md5;
  end if;

  if v_attrs is distinct from c_lease_attrs
     or v_args is distinct from c_lease_args
     or v_result is distinct from c_lease_result then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: attributs de set_merchant_notification_profile_under_save_lease différents de ceux posés par le lot SMTP (SECURITY DEFINER, STRICT, volatilité, LEAKPROOF, PARALLEL, COST/ROWS, langage, search_path, arguments, résultat). Observé : % ; attendu : %. Rollback annulé, rien modifié.', v_attrs, c_lease_attrs;
  end if;

  if v_comment_md5 is distinct from c_lease_comment_md5 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le commentaire de set_merchant_notification_profile_under_save_lease (md5 %) n''est pas celui posé par le lot SMTP (md5 %). Rollback annulé, rien modifié.', v_comment_md5, c_lease_comment_md5;
  end if;

  -- Droits (politique explicite du lot) : EXACTEMENT {propriétaire, authenticated}, accordés par le propriétaire,
  -- sans option de transmission, sans PUBLIC, anon, service_role ni aucun autre rôle. Le propriétaire doit être le
  -- rôle qui applique ce script. Aucun droit inconnu n'est révoqué silencieusement : refus.
  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('authenticated')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
     or v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits d''exécution ou propriétaire de set_merchant_notification_profile_under_save_lease différents de ceux posés par le lot SMTP (propriétaire = rôle appliquant le script ET authenticated, rien d''autre, sans option de transmission). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié ni révoqué silencieusement.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;
end $$;

do $$
begin
  if exists (select 1 from public.merchant_email_provider_config) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: SMTP configurations exist; export or remove them explicitly first';
  end if;
end $$;

-- Restauration VERBATIM du claim posé par #180 (extrait du lot #180 par génération,
-- jamais retapé ; tests/merchant-smtp-notifications-sql.test.ts compare les empreintes).
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
      -- ORDER_RECEIVED PAYMENT GATE v1 : seul ajout par rapport à N1-A.
      and public.notification_send_gate_open(o.order_id, o.notification_type)
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
  'N1-A + ORDER_RECEIVED PAYMENT GATE v1 — réclame un lot de notifications éligibles (FOR UPDATE SKIP LOCKED + bail). Résout l''identité d''expéditeur FRAÎCHE via jointure sur le restaurant_id de la ligne outbox elle-même. ORDER_RECEIVED n''est éligible que si notification_send_gate_open() est vraie (paid, ou not_required avec mode final none). Deux workers concurrents ne peuvent jamais réclamer la même ligne.';

revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer, integer) to service_role;

-- R3 : la fonction d'écriture du profil sous bail dépend du coffre (jeton) : elle part avec lui.
-- R4 : son identité vient d'être vérifiée (bloc ci-dessus) ; le DROP est volontairement SANS « if exists » :
-- une fonction disparue entre le contrôle et ici annule tout le retour arrière.
drop function public.set_merchant_notification_profile_under_save_lease(uuid, uuid, boolean, text, text, text, text);

drop table public.merchant_email_provider_config;

do $$
declare
  c_gated_body_md5      constant text := '16d75b38372fd5dfd0ca1a4e20dfa3a8';
  c_gated_body_md5_crlf constant text := 'b72e191ff8ee6332bd4ed4a09409060b';
  c_gated_comment_md5   constant text := 'dba8c60099d3bb7348201fe39b6fdae4';
  v_owner oid;
  v_acl   text[];
begin
  if to_regclass('public.merchant_email_provider_config') is not null then
    raise exception 'SCANYM_POSTCHECK_FAILED: SMTP vault still exists after rollback';
  end if;
  if to_regprocedure('public.set_merchant_notification_profile_under_save_lease(uuid,uuid,boolean,text,text,text,text)') is not null then
    raise exception 'SCANYM_POSTCHECK_FAILED: set_merchant_notification_profile_under_save_lease still exists after rollback';
  end if;
  if (select md5(p.prosrc) from pg_proc p
       where p.oid = 'public.claim_pending_notifications(integer,integer)'::regprocedure) not in (c_gated_body_md5, c_gated_body_md5_crlf) then
    raise exception 'SCANYM_POSTCHECK_FAILED: claim_pending_notifications is not byte-identical to the #180 claim after rollback';
  end if;
  if (select md5(coalesce(obj_description(p.oid, 'pg_proc'), '')) from pg_proc p
       where p.oid = 'public.claim_pending_notifications(integer,integer)'::regprocedure) is distinct from c_gated_comment_md5 then
    raise exception 'SCANYM_POSTCHECK_FAILED: claim_pending_notifications comment is not the #180 comment after rollback';
  end if;
  select p.proowner,
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
    into v_owner, v_acl
  from pg_proc p where p.oid = 'public.claim_pending_notifications(integer,integer)'::regprocedure;
  if v_acl is distinct from (select array_agg(x order by x) from unnest(array[
       format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
       format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)]) as x) then
    raise exception 'SCANYM_POSTCHECK_FAILED: claim privileges differ from #180 after rollback (%)', v_acl;
  end if;
end $$;

commit;
