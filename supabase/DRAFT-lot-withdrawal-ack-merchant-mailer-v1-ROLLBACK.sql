-- =============================================================================
-- Scanym — ACCUSÉ DE RÉTRACTATION PAR LA MESSAGERIE DU COMMERÇANT (v1) — ROLLBACK
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO.
--
-- Retire exactement les objets de DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql.
-- Ne touche à AUCUNE demande de rétractation (aucune ligne supprimée ou modifiée), à AUCUN objet
-- tiers (contrainte, index, statistique, déclencheur, droit de colonne ajoutés après l'installation)
-- ni à GAP-01.
--
-- ORDRE : TOUT est vérifié AVANT la première mutation, dans UN bloc, après avoir verrouillé
-- `withdrawal_requests` ET la table de l'interrupteur (pas de revendication ni de DDL concurrent
-- entre le contrôle et le retrait). À la moindre dérive, le script s'arrête (exception) et RIEN
-- n'a été modifié. Contrôles :
--   * interrupteur FERMÉ (ligne unique id=1, enabled=false), table de l'interrupteur de FORME EXACTE
--     (colonnes, défauts, contraintes, un seul index, ni déclencheur, ni règle, ni statistique, ni
--     héritage, ni droit, ni policy, ni objet dépendant) ;
--   * aucune preuve d'envoi (expéditeur / canal) -- la supprimer détruirait une preuve d'audit ;
--   * aucune demande `pending` ou `sending` (accusés en cours : ne pas retirer le lot « en vol » ;
--     un retrait ne doit jamais rouvrir un arriéré revendicable par le canal historique) ;
--   * colonnes de preuve : forme exacte, sans droit de colonne, et AUCUN objet qui s'y rattache en
--     dehors de NOTRE contrainte (identifiée par son OID, son nom ET sa définition exacte) :
--     PostgreSQL supprime en silence, avec la colonne, toute contrainte / index / statistique
--     portant uniquement sur elle ; un objet ajouté après l'installation serait donc détruit sans
--     message. Ces objets sont recherchés dans pg_constraint, pg_statistic_ext, pg_trigger (UPDATE
--     OF), pg_index et dans TOUT pg_depend ; la table ne doit pas avoir d'enfant (héritage) ;
--   * CHAQUE fonction à supprimer est bien celle du lot : existence, signature exacte, type de
--     retour, langage, volatilité, SECURITY DEFINER, search_path, propriétaire (= propriétaire de
--     withdrawal_requests), coût / lignes / support / attributs, droits d'exécution exacts (aucun
--     PUBLIC / anon / authenticated ; service_role seulement là où prévu), CORPS (SHA-256 après
--     normalisation STRICTE CRLF -> LF : un CR isolé ou toute autre différence est une dérive) ;
--     aucun homonyme (surcharge) dans aucun schéma ;
--   * le déclencheur est exactement celui du lot (BEFORE INSERT, ligne, activé, sans WHEN) ;
--   * aucun autre objet ne dépend de ces fonctions (vues, index, déclencheurs, règles) et aucune
--     autre fonction ne les nomme (recherche insensible à la casse) ;
--   * les fonctions GAP-01 sont toujours présentes ;
--   * APRÈS les suppressions, vérification que seuls les objets du lot ont disparu : tout objet tiers
--     recensé avant (contraintes, index, statistiques, déclencheurs, policies, règles, colonnes de
--     withdrawal_requests) doit exister encore, sinon la transaction entière est annulée.
-- Les empreintes ci-dessous sont celles du lot ; elles doivent être recalculées si le corps
-- d'une fonction du lot change (un test les compare au fichier du lot).
-- =============================================================================

begin;

set local lock_timeout = '10s';
lock table public.withdrawal_requests in access exclusive mode;

-- Inventaire des objets TIERS de withdrawal_requests (remplie par le bloc de contrôle, relue après
-- les suppressions). Table temporaire de la transaction : aucune trace après commit / rollback.
create temp table _ackmm_rb_snapshot (kind text not null, oid oid not null) on commit drop;

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
  v_wr           oid := 'public.withdrawal_requests'::regclass;
  v_act          oid;
  v_cons         oid;
  v_att_sender   smallint;
  v_att_transport smallint;
  v_atts         smallint[];
  v_lot_names    text[] := array['scanym_ack_merchant_mailer_enabled', '_scanym_merchant_ack_channel_ready',
                                 '_scanym_ack_pending_when_merchant_mailer_ready',
                                 'claim_withdrawal_acknowledgement_send_v2', 'record_withdrawal_acknowledgement_result_v2'];
begin
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = v_wr;
  select r.rolname into v_owner_name from pg_catalog.pg_roles r where r.oid = v_owner;

  -- 0. Le lot est-il appliqué ? (aucun objet = sans objet ; objets partiels = dérive)
  v_present :=
      (case when to_regclass('public.scanym_ack_merchant_mailer_activation') is not null then 1 else 0 end)
    + (case when exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = any (v_lot_names)) then 1 else 0 end)
    + (case when exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer') then 1 else 0 end)
    + (case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'withdrawal_requests'
                          and column_name in ('acknowledgement_sender', 'acknowledgement_transport')) then 1 else 0 end);
  if v_present = 0 then
    raise exception 'SCANYM_ROLLBACK_NOT_APPLICABLE: le lot n''est pas appliqué.';
  end if;
  if to_regclass('public.scanym_ack_merchant_mailer_activation') is null or v_present < 4 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: application partielle ou dérivée du lot (% des 4 familles d''objets présentes) -- aucune mutation.', v_present;
  end if;

  v_act := 'public.scanym_ack_merchant_mailer_activation'::regclass;
  lock table public.scanym_ack_merchant_mailer_activation in access exclusive mode;

  -- 1. Interrupteur : une ligne, id=1, FERMÉ ; RLS actif, sans policy ni droit ; FORME EXACTE.
  if (select count(*) from public.scanym_ack_merchant_mailer_activation) <> 1
     or not exists (select 1 from public.scanym_ack_merchant_mailer_activation where id = 1) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: la table de l''interrupteur ne contient pas exactement la ligne id=1.';
  end if;
  if (select enabled from public.scanym_ack_merchant_mailer_activation where id = 1) is distinct from false then
    raise exception 'SCANYM_ROLLBACK_REFUSED: l''interrupteur est OUVERT -- le fermer avant le retour arrière.';
  end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_act)
     or exists (select 1 from pg_catalog.pg_policy where polrelid = v_act)
     or (select c.relowner from pg_catalog.pg_class c where c.oid = v_act) <> v_owner
     or exists (
          select 1 from pg_catalog.pg_class c,
                 lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           where c.oid = v_act and a.grantee <> c.relowner) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: table de l''interrupteur dérivée (RLS, policy, propriétaire ou droits).';
  end if;
  if (select c.relkind from pg_catalog.pg_class c where c.oid = v_act) <> 'r'
     or (select c.relispartition or c.relpersistence <> 'p' or c.reloptions is not null from pg_catalog.pg_class c where c.oid = v_act)
     or exists (select 1 from pg_catalog.pg_inherits where inhrelid = v_act or inhparent = v_act)
     or (select string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
           from pg_catalog.pg_attribute a where a.attrelid = v_act and a.attnum > 0 and not a.attisdropped)
        is distinct from 'id:integer:true,enabled:boolean:true,updated_at:timestamp with time zone:true,note:text:false'
     or (select string_agg(a.attname || '=' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ',' order by a.attnum)
           from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
          where d.adrelid = v_act)
        is distinct from 'id=1,enabled=false,updated_at=now()'
     or exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_act and a.attnum > 0 and not a.attisdropped
                   and (a.attacl is not null or a.attgenerated <> '' or a.attidentity <> ''))
     or (select string_agg(c.contype::text || ':' || pg_catalog.pg_get_constraintdef(c.oid), ',' order by c.contype::text)
           from pg_catalog.pg_constraint c where c.conrelid = v_act and c.contype <> 'n')
        is distinct from 'c:CHECK ((id = 1)),p:PRIMARY KEY (id)'
     or exists (select 1 from pg_catalog.pg_constraint c where c.confrelid = v_act)
     or (select count(*) from pg_catalog.pg_index i where i.indrelid = v_act) <> 1
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = v_act)
     or exists (select 1 from pg_catalog.pg_rewrite r where r.ev_class = v_act)
     or exists (select 1 from pg_catalog.pg_statistic_ext s where s.stxrelid = v_act)
     or exists (
          select 1 from pg_catalog.pg_depend d
           where d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = v_act and d.deptype <> 'i'
             and not (d.classid = 'pg_catalog.pg_constraint'::regclass and d.objid in (select c.oid from pg_catalog.pg_constraint c where c.conrelid = v_act))
             and not (d.classid = 'pg_catalog.pg_class'::regclass and d.objid in (select i.indexrelid from pg_catalog.pg_index i where i.indrelid = v_act))
             and not (d.classid = 'pg_catalog.pg_attrdef'::regclass and d.objid in (select ad.oid from pg_catalog.pg_attrdef ad where ad.adrelid = v_act))) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: table de l''interrupteur dérivée (structure : colonnes, défauts, contraintes, index, déclencheur, règle, statistique, héritage ou objet dépendant).';
  end if;

  -- 2. Aucune preuve d'envoi ; aucun accusé en vol.
  if exists (select 1 from public.withdrawal_requests where acknowledgement_sender is not null or acknowledgement_transport is not null) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: des accusés portent une preuve (expéditeur / canal) ; les colonnes ne sont pas supprimées sans décision explicite.';
  end if;
  if exists (select 1 from public.withdrawal_requests where acknowledgement_status in ('pending', 'sending')) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: des accusés sont pending/sending (en vol) -- ne pas retirer le lot tant qu''ils ne sont pas traités.';
  end if;

  -- 3. Colonnes de preuve : exactement celles du lot ; notre contrainte ; AUCUN objet tiers rattaché.
  if (select c.relkind from pg_catalog.pg_class c where c.oid = v_wr) <> 'r'
     or exists (select 1 from pg_catalog.pg_inherits where inhparent = v_wr) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: withdrawal_requests est partitionnée ou possède des tables enfants (héritage) -- supprimer les colonnes de preuve les supprimerait aussi des enfants.';
  end if;
  for v_row in
    select a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull, a.atthasdef,
           a.attgenerated, a.attidentity, a.attacl, a.attoptions, a.attfdwoptions, a.attislocal, a.attinhcount
      from pg_catalog.pg_attribute a
     where a.attrelid = v_wr and a.attname in ('acknowledgement_sender', 'acknowledgement_transport') and not a.attisdropped
  loop
    if v_row.typ <> 'text' or v_row.attnotnull or v_row.atthasdef or v_row.attgenerated <> '' or v_row.attidentity <> ''
       or v_row.attoptions is not null or v_row.attfdwoptions is not null or not v_row.attislocal or v_row.attinhcount <> 0 then
      raise exception 'SCANYM_ROLLBACK_REFUSED: colonne % dérivée (type/NOT NULL/défaut/options).', v_row.attname;
    end if;
    if v_row.attacl is not null then
      raise exception 'SCANYM_ROLLBACK_REFUSED: droit de colonne présent sur % (GRANT/REVOKE sur la colonne) -- il serait supprimé en silence avec elle.', v_row.attname;
    end if;
    if v_row.attname = 'acknowledgement_sender' then v_att_sender := v_row.attnum; else v_att_transport := v_row.attnum; end if;
  end loop;
  if v_att_sender is null or v_att_transport is null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: les deux colonnes de preuve ne sont pas toutes présentes.';
  end if;
  v_atts := array[v_att_sender, v_att_transport];

  -- Notre contrainte : une seule, nom + type + colonne + définition + état exacts ; on retient son OID.
  if (select count(*) from pg_catalog.pg_constraint c
       where c.conrelid = v_wr and c.conname = 'withdrawal_requests_ack_transport_check') <> 1 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: contrainte withdrawal_requests_ack_transport_check absente ou dérivée.';
  end if;
  select c.oid into v_cons from pg_catalog.pg_constraint c
   where c.conrelid = v_wr and c.conname = 'withdrawal_requests_ack_transport_check';
  if not exists (
       select 1 from pg_catalog.pg_constraint c
        where c.oid = v_cons and c.contype = 'c' and c.conkey = array[v_att_transport]::smallint[]
          and c.convalidated and not c.condeferrable and not c.condeferred and c.conislocal and c.coninhcount = 0
          and not c.connoinherit and c.confrelid = 0
          and pg_catalog.pg_get_constraintdef(c.oid) ~ '^CHECK \(\(\(acknowledgement_transport IS NULL\) OR \(acknowledgement_transport = ANY \(ARRAY\[''platform_smtp''::text, ''merchant_smtp''::text\]\)\)\)\)$') then
    raise exception 'SCANYM_ROLLBACK_REFUSED: contrainte withdrawal_requests_ack_transport_check absente ou dérivée.';
  end if;

  -- Rien d'autre ne doit se rattacher aux colonnes de preuve (sinon PostgreSQL le supprimerait en silence).
  if exists (select 1 from pg_catalog.pg_constraint c
              where c.oid <> v_cons and ((c.conrelid = v_wr and c.conkey && v_atts) or (c.confrelid = v_wr and c.confkey && v_atts))) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: une contrainte tierce (CHECK, UNIQUE, clé étrangère...) porte sur une colonne de preuve -- elle serait supprimée en silence avec la colonne.';
  end if;
  if exists (select 1 from pg_catalog.pg_statistic_ext s where s.stxrelid = v_wr and s.stxkeys::int2[] && v_atts) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: une statistique étendue porte sur une colonne de preuve -- elle serait supprimée en silence avec la colonne.';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = v_wr and not t.tgisinternal and t.tgattr::int2[] && v_atts) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: un déclencheur UPDATE OF porte sur une colonne de preuve.';
  end if;
  if exists (select 1 from pg_catalog.pg_index i where i.indrelid = v_wr and i.indkey::int2[] && v_atts) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: un index porte sur une colonne de preuve -- il serait supprimé en silence avec la colonne.';
  end if;
  v_n := (select count(*) from pg_catalog.pg_depend d
           where d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = v_wr and d.refobjsubid = any (v_atts)
             and not (d.classid = 'pg_catalog.pg_constraint'::regclass and d.objid = v_cons));
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % objet(s) dépendent des colonnes de preuve (vue, index, règle, policy, statistique, publication...).', v_n;
  end if;

  -- 4. Fonctions : EXACTEMENT celles du lot (signature, attributs, propriétaire, droits, corps).
  if exists (select 1 from pg_catalog.pg_proc p
              where p.proname = any (v_lot_names)
                and p.oid not in (select to_regprocedure(x)::oid from unnest(array[
                      'public.scanym_ack_merchant_mailer_enabled()',
                      'public._scanym_merchant_ack_channel_ready(uuid)',
                      'public._scanym_ack_pending_when_merchant_mailer_ready()',
                      'public.claim_withdrawal_acknowledgement_send_v2(uuid)',
                      'public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)']) x
                    where to_regprocedure(x) is not null)) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: un homonyme (surcharge ou autre schéma) d''une fonction du lot existe.';
  end if;
  for v_row in
    select * from (values
      -- signature, arguments d'identité, résultat, langage, volatilité, retset, empreinte SHA-256 du corps (LF), droits EXECUTE attendus
      ('public.scanym_ack_merchant_mailer_enabled()', '', 'boolean', 'sql', 's', false,
         'f0ef37d9dcdd6aad50682f91d092fe8afee6a790a0295e83cb40c8aefb2815d3', array['{OWNER}', 'service_role']),
      ('public._scanym_merchant_ack_channel_ready(uuid)', 'p_restaurant_id uuid', 'boolean', 'sql', 's', false,
         '0d5df5f26274e78bc859c271c723d94b428f50ded43ed943e4f91b06aa2ff985', array['{OWNER}']),
      ('public._scanym_ack_pending_when_merchant_mailer_ready()', '', 'trigger', 'plpgsql', 'v', false,
         '341b056bf2bed09eb733f3bf34324c4839778d5ba3bdbda8649fc8472d8da4d4', array['{OWNER}']),
      ('public.claim_withdrawal_acknowledgement_send_v2(uuid)', 'p_withdrawal_request_id uuid',
         'TABLE(id uuid, restaurant_id uuid, order_id uuid, acknowledgement_address text, customer_first_name text, customer_last_name text, declaration_snapshot jsonb, merchant_name text, merchant_contact_email text, merchant_contact_phone text, merchant_withdrawal_regime text, profile_email_enabled boolean, sender_name text, sender_email text, reply_to text)',
         'sql', 'v', true, '570e1fcdabf402591ae8f5a6a4cdbcbb46f2c5120b7268d4281e2357cb3cb19e', array['{OWNER}', 'service_role']),
      ('public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)',
         'p_withdrawal_request_id uuid, p_ok boolean, p_to text, p_cc text, p_message_id text, p_content_version text, p_error text, p_sender text, p_transport text',
         'boolean', 'sql', 'v', false, 'c41e2978c90f8fd0d85c8bec7925bcf4d2d4b8438766100d65793d2cedae7abc', array['{OWNER}', 'service_role'])
    ) as t(sig, idargs, result, lang, vol, retset, body_sha256, acl)
  loop
    v_oid := to_regprocedure(v_row.sig);
    if v_oid is null then
      raise exception 'SCANYM_ROLLBACK_REFUSED: fonction % absente (signature différente ou supprimée).', v_row.sig;
    end if;
    v_fn_oids := v_fn_oids || v_oid;
    select * into v_p from pg_catalog.pg_proc where oid = v_oid;

    if pg_catalog.pg_get_function_identity_arguments(v_oid) <> v_row.idargs
       or pg_catalog.pg_get_function_result(v_oid) <> v_row.result
       or v_p.pronargdefaults <> 0 or v_p.provariadic <> 0 or v_p.protrftypes is not null then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- arguments/résultat dérivés.', v_row.sig;
    end if;
    if (select l.lanname from pg_catalog.pg_language l where l.oid = v_p.prolang) <> v_row.lang
       or v_p.provolatile::text <> v_row.vol
       or v_p.proretset <> v_row.retset
       or v_p.prokind <> 'f' or v_p.proisstrict or v_p.proleakproof or v_p.proparallel <> 'u'
       or v_p.procost <> 100 or v_p.prorows <> (case when v_row.retset then 1000 else 0 end)
       or v_p.prosupport <> 0 or v_p.probin is not null or v_p.prosqlbody is not null then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- langage / volatilité / coût / attributs dérivés.', v_row.sig;
    end if;
    if not v_p.prosecdef or v_p.proconfig is distinct from array['search_path=""']::text[] then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- SECURITY DEFINER / search_path dérivés.', v_row.sig;
    end if;
    if v_p.proowner <> v_owner then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- propriétaire différent de celui de withdrawal_requests (%).', v_row.sig, v_owner_name;
    end if;
    -- Corps : SHA-256 après normalisation STRICTE CRLF -> LF (une copie Windows du lot donne le même
    -- corps logique ; un CR isolé, une tabulation ou tout autre écart est une dérive).
    if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(v_p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') <> v_row.body_sha256 then
      raise exception 'SCANYM_ROLLBACK_REFUSED: % -- corps différent de celui du lot (empreinte SHA-256).', v_row.sig;
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
   where tgname = 'trg_withdrawal_ack_pending_merchant_mailer' and tgrelid = v_wr and not tgisinternal;
  if v_n <> 1 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: déclencheur du lot absent ou dupliqué.';
  end if;
  select * into v_trg from pg_catalog.pg_trigger
   where tgname = 'trg_withdrawal_ack_pending_merchant_mailer' and tgrelid = v_wr;
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
            and (p.prosrc ~* '(scanym_ack_merchant_mailer_enabled|_scanym_merchant_ack_channel_ready|_scanym_ack_pending_when_merchant_mailer_ready|claim_withdrawal_acknowledgement_send_v2|record_withdrawal_acknowledgement_result_v2|scanym_ack_merchant_mailer_activation)'));
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % autre(s) fonction(s) référencent des objets du lot.', v_n;
  end if;

  -- 7. GAP-01 intact (le retrait ne doit pas le laisser orphelin).
  if to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is null
     or to_regprocedure('public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)') is null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: les fonctions GAP-01 ne sont pas présentes.';
  end if;

  -- 8. Inventaire des objets TIERS de withdrawal_requests, relu après les suppressions.
  insert into _ackmm_rb_snapshot (kind, oid)
    select 'constraint', c.oid from pg_catalog.pg_constraint c where c.conrelid = v_wr and c.oid <> v_cons
    union all select 'index', i.indexrelid from pg_catalog.pg_index i where i.indrelid = v_wr
    union all select 'statistic', s.oid from pg_catalog.pg_statistic_ext s where s.stxrelid = v_wr
    union all select 'trigger', t.oid from pg_catalog.pg_trigger t where t.tgrelid = v_wr and t.oid <> v_trg.oid
    union all select 'policy', p.oid from pg_catalog.pg_policy p where p.polrelid = v_wr
    union all select 'rule', r.oid from pg_catalog.pg_rewrite r where r.ev_class = v_wr
    union all select 'column', a.attnum::oid from pg_catalog.pg_attribute a
               where a.attrelid = v_wr and a.attnum > 0 and not a.attisdropped and a.attnum <> all (v_atts);
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
declare
  v_wr  oid := 'public.withdrawal_requests'::regclass;
  v_lost int;
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
  -- Aucun objet tiers n'a disparu avec les colonnes (la transaction entière est annulée sinon).
  select count(*) into v_lost
    from _ackmm_rb_snapshot s
   where not exists (
     select 1 from (
       select 'constraint' as kind, c.oid from pg_catalog.pg_constraint c where c.conrelid = v_wr
       union all select 'index', i.indexrelid from pg_catalog.pg_index i where i.indrelid = v_wr
       union all select 'statistic', st.oid from pg_catalog.pg_statistic_ext st where st.stxrelid = v_wr
       union all select 'trigger', t.oid from pg_catalog.pg_trigger t where t.tgrelid = v_wr
       union all select 'policy', p.oid from pg_catalog.pg_policy p where p.polrelid = v_wr
       union all select 'rule', r.oid from pg_catalog.pg_rewrite r where r.ev_class = v_wr
       union all select 'column', a.attnum::oid from pg_catalog.pg_attribute a where a.attrelid = v_wr and a.attnum > 0 and not a.attisdropped
     ) cur where cur.kind = s.kind and cur.oid = s.oid);
  if v_lost > 0 then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: % objet(s) tiers de withdrawal_requests ont disparu avec le retrait -- transaction annulée.', v_lost;
  end if;
end $$;

commit;
