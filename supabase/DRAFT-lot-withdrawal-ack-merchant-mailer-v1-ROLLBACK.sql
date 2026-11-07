-- =============================================================================
-- Scanym — ACCUSÉ DE RÉTRACTATION PAR LA MESSAGERIE DU COMMERÇANT (v1) — ROLLBACK
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO.
--
-- Retire exactement les objets de DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql.
-- Ne touche à AUCUNE demande de rétractation (aucune ligne supprimée ou modifiée) ni à
-- GAP-01.
--
-- ORDRE : TOUT est vérifié AVANT la première mutation, dans UN bloc, après avoir verrouillé
-- `withdrawal_requests` (pas de revendication concurrente entre le contrôle et le retrait).
-- À la moindre dérive, le script s'arrête (exception) et RIEN n'a été modifié. Contrôles :
--   * interrupteur FERMÉ (ligne unique id=1, enabled=false), table sans policy ni droit ;
--   * aucune preuve d'envoi (expéditeur / canal) -- la supprimer détruirait une preuve d'audit ;
--   * aucune demande `pending` ou `sending` (accusés en cours : ne pas retirer le lot « en vol » ;
--     un retrait ne doit jamais rouvrir un arriéré revendicable par le canal historique) ;
--   * CHAQUE fonction à supprimer est bien celle du lot : existence, signature exacte, type de
--     retour, langage, volatilité, SECURITY DEFINER, search_path, propriétaire (= propriétaire de
--     withdrawal_requests), droits d'exécution exacts (aucun PUBLIC / anon / authenticated ;
--     service_role seulement là où prévu), CORPS (empreinte MD5 après normalisation CRLF -> LF) ;
--   * le déclencheur est exactement celui du lot (BEFORE INSERT, ligne, activé, sans WHEN) ;
--   * aucun autre objet ne dépend de ces fonctions ni des colonnes de preuve (vues, index,
--     déclencheurs, autre fonction qui les nomme) ;
--   * les fonctions GAP-01 sont toujours présentes.
-- Les empreintes ci-dessous sont celles du lot ; elles doivent être recalculées si le corps
-- d'une fonction du lot change (un test les compare au fichier du lot).
-- =============================================================================

begin;

set local lock_timeout = '10s';
lock table public.withdrawal_requests in access exclusive mode;

do $$
declare
  v_owner        oid;
  v_owner_name   text;
  v_present      int;
  v_row          record;
  v_oid          oid;
  v_p            pg_catalog.pg_proc%rowtype;
  v_acl          text[];
  v_expected_acl text[];
  v_n            int;
  v_trg          pg_catalog.pg_trigger%rowtype;
  v_fn_oids      oid[] := '{}';
  v_attnum       smallint;
begin
  select c.relowner into v_owner from pg_catalog.pg_class c
   where c.oid = 'public.withdrawal_requests'::regclass;
  select r.rolname into v_owner_name from pg_catalog.pg_roles r where r.oid = v_owner;

  -- 0. Le lot est-il appliqué ? (aucun objet = sans objet ; objets partiels = dérive)
  v_present :=
      (case when to_regclass('public.scanym_ack_merchant_mailer_activation') is not null then 1 else 0 end)
    + (case when exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public'
                            and p.proname in ('scanym_ack_merchant_mailer_enabled', '_scanym_merchant_ack_channel_ready',
                                              '_scanym_ack_pending_when_merchant_mailer_ready',
                                              'claim_withdrawal_acknowledgement_send_v2',
                                              'record_withdrawal_acknowledgement_result_v2')) then 1 else 0 end)
    + (case when exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer') then 1 else 0 end)
    + (case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'withdrawal_requests'
                          and column_name in ('acknowledgement_sender', 'acknowledgement_transport')) then 1 else 0 end);
  if v_present = 0 then
    raise exception 'SCANYM_ROLLBACK_NOT_APPLICABLE: le lot n''est pas appliqué.';
  end if;
  if to_regclass('public.scanym_ack_merchant_mailer_activation') is null or v_present < 4 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: application partielle ou dérivée du lot (% des 4 familles d''objets présentes) -- aucune mutation.', v_present;
  end if;

  -- 1. Interrupteur : une ligne, id=1, FERMÉ ; table sans policy ni droit ; RLS actif.
  if (select count(*) from public.scanym_ack_merchant_mailer_activation) <> 1
     or not exists (select 1 from public.scanym_ack_merchant_mailer_activation where id = 1) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: la table de l''interrupteur ne contient pas exactement la ligne id=1.';
  end if;
  if (select enabled from public.scanym_ack_merchant_mailer_activation where id = 1) is distinct from false then
    raise exception 'SCANYM_ROLLBACK_REFUSED: l''interrupteur est OUVERT -- le fermer avant le retour arrière.';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.scanym_ack_merchant_mailer_activation'::regclass)
     or exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.scanym_ack_merchant_mailer_activation'::regclass)
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.scanym_ack_merchant_mailer_activation'::regclass) <> v_owner
     or exists (
          select 1 from pg_catalog.pg_class c,
                 lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           where c.oid = 'public.scanym_ack_merchant_mailer_activation'::regclass and a.grantee <> c.relowner) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: table de l''interrupteur dérivée (RLS, policy, propriétaire ou droits).';
  end if;

  -- 2. Aucune preuve d'envoi ; aucun accusé en vol.
  if exists (select 1 from public.withdrawal_requests where acknowledgement_sender is not null or acknowledgement_transport is not null) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: des accusés portent une preuve (expéditeur / canal) ; les colonnes ne sont pas supprimées sans décision explicite.';
  end if;
  if exists (select 1 from public.withdrawal_requests where acknowledgement_status in ('pending', 'sending')) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: des accusés sont pending/sending (en vol) -- ne pas retirer le lot tant qu''ils ne sont pas traités.';
  end if;

  -- 3. Colonnes de preuve : exactement celles du lot, sans objet dépendant.
  for v_row in
    select a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.withdrawal_requests'::regclass and a.attname in ('acknowledgement_sender', 'acknowledgement_transport') and not a.attisdropped
  loop
    if v_row.typ <> 'text' or v_row.attnotnull or v_row.atthasdef or v_row.attgenerated <> '' or v_row.attidentity <> '' then
      raise exception 'SCANYM_ROLLBACK_REFUSED: colonne % dérivée (type/NOT NULL/défaut).', v_row.attname;
    end if;
    v_n := (select count(*) from pg_catalog.pg_depend d
             where d.refobjid = 'public.withdrawal_requests'::regclass and d.refobjsubid = v_row.attnum
               and d.deptype in ('n', 'a') and d.classid <> 'pg_catalog.pg_constraint'::regclass);
    if v_n > 0 then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % objet(s) dépendent de la colonne % (vue, index, règle, politique...).', v_n, v_row.attname;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.withdrawal_requests'::regclass and a.attname in ('acknowledgement_sender', 'acknowledgement_transport') and not a.attisdropped) <> 2 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: les deux colonnes de preuve ne sont pas toutes présentes.';
  end if;
  if (select count(*) from pg_catalog.pg_constraint c
       where c.conrelid = 'public.withdrawal_requests'::regclass and c.conname = 'withdrawal_requests_ack_transport_check' and c.contype = 'c') <> 1
     or (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
          where c.conrelid = 'public.withdrawal_requests'::regclass and c.conname = 'withdrawal_requests_ack_transport_check')
        !~ '^CHECK \(\(\(acknowledgement_transport IS NULL\) OR \(acknowledgement_transport = ANY \(ARRAY\[''platform_smtp''::text, ''merchant_smtp''::text\]\)\)\)\)$' then
    raise exception 'SCANYM_ROLLBACK_REFUSED: contrainte withdrawal_requests_ack_transport_check absente ou dérivée.';
  end if;

  -- 4. Fonctions : EXACTEMENT celles du lot (signature, attributs, propriétaire, droits, corps).
  for v_row in
    select * from (values
      -- signature, arguments d'identité, résultat, langage, volatilité, retset, empreinte MD5 du corps (LF), droits EXECUTE attendus
      ('public.scanym_ack_merchant_mailer_enabled()', '', 'boolean', 'sql', 's', false,
         'b46895cf1710b3da251f01b87481bef4', array['{OWNER}', 'service_role']),
      ('public._scanym_merchant_ack_channel_ready(uuid)', 'p_restaurant_id uuid', 'boolean', 'sql', 's', false,
         'ee2335f980b01c7d1db2f692967e25ee', array['{OWNER}']),
      ('public._scanym_ack_pending_when_merchant_mailer_ready()', '', 'trigger', 'plpgsql', 'v', false,
         'bfd188c2c1070b8e95592fd83e373b80', array['{OWNER}']),
      ('public.claim_withdrawal_acknowledgement_send_v2(uuid)', 'p_withdrawal_request_id uuid',
         'TABLE(id uuid, restaurant_id uuid, order_id uuid, acknowledgement_address text, customer_first_name text, customer_last_name text, declaration_snapshot jsonb, merchant_name text, merchant_contact_email text, merchant_contact_phone text, merchant_withdrawal_regime text, profile_email_enabled boolean, sender_name text, sender_email text, reply_to text)',
         'sql', 'v', true, 'a749823ad7dc934b0985b8f898ce7557', array['{OWNER}', 'service_role']),
      ('public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)',
         'p_withdrawal_request_id uuid, p_ok boolean, p_to text, p_cc text, p_message_id text, p_content_version text, p_error text, p_sender text, p_transport text',
         'boolean', 'sql', 'v', false, 'b7a4382a3bb31c46824a28105df13740', array['{OWNER}', 'service_role'])
    ) as t(sig, idargs, result, lang, vol, retset, body_md5, acl)
  loop
    v_oid := to_regprocedure(v_row.sig);
    if v_oid is null then
      raise exception 'SCANYM_ROLLBACK_REFUSED: fonction % absente (signature différente ou supprimée).', v_row.sig;
    end if;
    v_fn_oids := v_fn_oids || v_oid;
    select * into v_p from pg_catalog.pg_proc where oid = v_oid;

    if pg_catalog.pg_get_function_identity_arguments(v_oid) <> v_row.idargs
       or pg_catalog.pg_get_function_result(v_oid) <> v_row.result
       or v_p.pronargdefaults <> 0 then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- arguments/résultat dérivés.', v_row.sig;
    end if;
    if (select l.lanname from pg_catalog.pg_language l where l.oid = v_p.prolang) <> v_row.lang
       or v_p.provolatile::text <> v_row.vol
       or v_p.proretset <> v_row.retset
       or v_p.prokind <> 'f' or v_p.proisstrict or v_p.proleakproof or v_p.proparallel <> 'u' then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- langage / volatilité / attributs dérivés.', v_row.sig;
    end if;
    if not v_p.prosecdef or v_p.proconfig is distinct from array['search_path=""']::text[] then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- SECURITY DEFINER / search_path dérivés.', v_row.sig;
    end if;
    if v_p.proowner <> v_owner then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- propriétaire différent de celui de withdrawal_requests (%).', v_row.sig, v_owner_name;
    end if;
    -- Corps : MD5 après normalisation CRLF -> LF (une copie Windows du lot donne le même corps logique).
    if pg_catalog.md5(pg_catalog.replace(v_p.prosrc, E'\r', '')) <> v_row.body_md5 then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- corps différent de celui du lot (empreinte).', v_row.sig;
    end if;
    -- Droits d'exécution EXACTS (aucun PUBLIC / anon / authenticated, aucun droit transmissible).
    select array_agg(distinct coalesce(r.rolname, 'PUBLIC') || case when a.is_grantable then '+grant' else '' end || case when a.privilege_type <> 'EXECUTE' then '+' || a.privilege_type else '' end
                     order by coalesce(r.rolname, 'PUBLIC') || case when a.is_grantable then '+grant' else '' end || case when a.privilege_type <> 'EXECUTE' then '+' || a.privilege_type else '' end)
      into v_acl
      from aclexplode(coalesce(v_p.proacl, acldefault('f', v_p.proowner))) a
      left join pg_catalog.pg_roles r on r.oid = a.grantee;
    select array_agg(x order by x) into v_expected_acl
      from unnest(array(select case when e = '{OWNER}' then v_owner_name else e end from unnest(v_row.acl) e)) x;
    if v_acl is distinct from v_expected_acl then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- droits d''exécution dérivés (attendu %, constaté %).', v_row.sig, v_expected_acl, v_acl;
    end if;
  end loop;

  -- 5. Déclencheur : exactement celui du lot.
  select count(*) into v_n from pg_catalog.pg_trigger
   where tgname = 'trg_withdrawal_ack_pending_merchant_mailer' and tgrelid = 'public.withdrawal_requests'::regclass and not tgisinternal;
  if v_n <> 1 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: déclencheur du lot absent ou dupliqué.';
  end if;
  select * into v_trg from pg_catalog.pg_trigger
   where tgname = 'trg_withdrawal_ack_pending_merchant_mailer' and tgrelid = 'public.withdrawal_requests'::regclass;
  if v_trg.tgfoid <> to_regprocedure('public._scanym_ack_pending_when_merchant_mailer_ready()')
     or v_trg.tgtype <> 7 or v_trg.tgenabled <> 'O' or v_trg.tgqual is not null or v_trg.tgattr::text <> '' or v_trg.tgnargs <> 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: déclencheur dérivé (fonction, moment, événement, activation, WHEN).';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger where tgfoid = v_trg.tgfoid and oid <> v_trg.oid) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: un autre déclencheur utilise la fonction du lot.';
  end if;

  -- 6. Aucun autre objet ne dépend de ces fonctions ; aucune autre fonction ne les nomme.
  v_n := (select count(*) from pg_catalog.pg_depend d
           where d.refobjid = any (v_fn_oids) and d.deptype in ('n', 'a')
             and not (d.classid = 'pg_catalog.pg_trigger'::regclass and d.objid = v_trg.oid));
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % objet(s) dépendent des fonctions du lot.', v_n;
  end if;
  v_n := (select count(*) from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname not in ('pg_catalog', 'information_schema') and p.oid <> all (v_fn_oids)
            and (p.prosrc ~ '(scanym_ack_merchant_mailer_enabled|_scanym_merchant_ack_channel_ready|_scanym_ack_pending_when_merchant_mailer_ready|claim_withdrawal_acknowledgement_send_v2|record_withdrawal_acknowledgement_result_v2|scanym_ack_merchant_mailer_activation)'));
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % autre(s) fonction(s) référencent des objets du lot.', v_n;
  end if;

  -- 7. GAP-01 intact (le retrait ne doit pas le laisser orphelin).
  if to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is null
     or to_regprocedure('public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)') is null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: les fonctions GAP-01 ne sont pas présentes.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- MUTATIONS (seulement si TOUS les contrôles ci-dessus ont réussi). Aucun « IF EXISTS » :
-- un objet manquant ici est une anomalie qui annule la transaction entière.
-- ---------------------------------------------------------------------------
drop trigger trg_withdrawal_ack_pending_merchant_mailer on public.withdrawal_requests;
drop function public._scanym_ack_pending_when_merchant_mailer_ready();
drop function public.record_withdrawal_acknowledgement_result_v2(uuid, boolean, text, text, text, text, text, text, text);
drop function public.claim_withdrawal_acknowledgement_send_v2(uuid);
drop function public._scanym_merchant_ack_channel_ready(uuid);
drop function public.scanym_ack_merchant_mailer_enabled();

alter table public.withdrawal_requests drop constraint withdrawal_requests_ack_transport_check;
alter table public.withdrawal_requests
  drop column acknowledgement_sender,
  drop column acknowledgement_transport;

drop table public.scanym_ack_merchant_mailer_activation;

do $$
begin
  if to_regclass('public.scanym_ack_merchant_mailer_activation') is not null
     or to_regprocedure('public.claim_withdrawal_acknowledgement_send_v2(uuid)') is not null
     or to_regprocedure('public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)') is not null
     or to_regprocedure('public.scanym_ack_merchant_mailer_enabled()') is not null
     or to_regprocedure('public._scanym_merchant_ack_channel_ready(uuid)') is not null
     or to_regprocedure('public._scanym_ack_pending_when_merchant_mailer_ready()') is not null
     or exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer')
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'withdrawal_requests'
                 and column_name in ('acknowledgement_sender', 'acknowledgement_transport')) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: un objet du lot subsiste.';
  end if;
  if to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is null
     or to_regprocedure('public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)') is null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: les fonctions GAP-01 ne sont plus présentes.';
  end if;
end $$;

commit;
