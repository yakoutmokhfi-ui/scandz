-- Roll back ORDER EMAIL DETAIL v1 (issue #211).
--
-- DRAFT : jamais appliqué par le dépôt. Restaure, OCTET POUR OCTET, l'état posé par MERCHANT CUSTOMER
-- COMMUNICATIONS v1 :
--   * public.create_order_received_notification(uuid, uuid) : corps, commentaire, attributs et droits d'avant ;
--   * le CHECK de notification_outbox.locale revient à ('fr','en','ar').
--
-- Refuse, AVANT toute écriture (rien n'est modifié) :
--   * si la fonction n'est plus EXACTEMENT celle posée par le lot (corps sur les octets exacts, LF ou CRLF
--     complet ; signature ; attributs dont SECURITY DEFINER / STRICT / search_path ; propriétaire = rôle qui
--     applique le script ; droits = propriétaire + service_role, rien d'autre ; commentaire ; surcharge unique) ;
--   * si le CHECK de locale n'est plus exactement ('fr','en','ar','nl') ;
--   * s'il existe des lignes de file en locale `nl` (SCANYM_ROLLBACK_REFUSED_NL_ROWS) : les ramener à `fr`
--     reviendrait à MODIFIER des décisions/instantanés déjà figés, ce que ce retour arrière ne fait jamais. Il
--     faut alors décider explicitement (garder le CHECK élargi et ne restaurer que la fonction, par exemple).
-- Ne supprime AUCUN snapshot, AUCUNE décision, ne rouvre AUCUNE file : les lignes déjà enfilées avec les clés
-- ajoutées les gardent (additives, ignorées par le code antérieur).
-- À lancer Cron arrêté (la file est lue par claim_*) ; verrou exclusif 10 s maximum, sinon annulé.
begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regclass('public.notification_outbox') is null
     or to_regprocedure('public.create_order_received_notification(uuid,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: ORDER EMAIL DETAIL v1 n''est pas installé (file ou fonction absente). Rien modifié.';
  end if;
end $$;

lock table public.notification_outbox in access exclusive mode;

do $$
declare
  c_new_md5      constant text := '7729300a66a37fafcfeb95878a64d572';
  c_new_md5_crlf constant text := 'e46b55daec59649a214185879dd89068';
  c_new_comment  constant text := '95eee794ae1c2edee83f16e64b305a69';
  c_args         constant text := 'p_order_id uuid, p_restaurant_id uuid';
  c_result       constant text := 'uuid';
  c_attrs        constant text := 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=f;cost=100;rows=0;support=0;variadic=0;nargs=2;ndefaults=0;config=search_path=""';
  v_count   integer;
  v_owner   oid;
  v_args    text;
  v_result  text;
  v_md5     text;
  v_attrs   text;
  v_acl     text[];
  v_expected_acl text[];
  v_comment_md5  text;
  v_def     text;
  v_nl_rows bigint;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order_received_notification';
  if v_count <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification doit exister en UNE seule surcharge (trouvé %). Rollback annulé, rien modifié.', v_count;
  end if;

  select p.proowner, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), md5(p.prosrc),
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
    into v_owner, v_args, v_result, v_md5, v_attrs, v_acl, v_comment_md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'create_order_received_notification';

  if v_md5 not in (c_new_md5, c_new_md5_crlf) then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le corps de create_order_received_notification (md5 %) n''est plus celui posé par ORDER EMAIL DETAIL v1 (md5 %) -- modifié depuis. Rollback annulé, rien modifié.', v_md5, c_new_md5;
  end if;
  if v_args is distinct from c_args or v_result is distinct from c_result or v_attrs is distinct from c_attrs then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: signature ou attributs de create_order_received_notification différents de ceux posés par le lot. Observé : % / % / % ; attendu : % / % / %. Rollback annulé, rien modifié.', v_args, v_result, v_attrs, c_args, c_result, c_attrs;
  end if;
  if v_comment_md5 is distinct from c_new_comment then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le commentaire de create_order_received_notification (md5 %) n''est pas celui posé par le lot (md5 %). Rollback annulé, rien modifié.', v_comment_md5, c_new_comment;
  end if;

  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
     or v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits de create_order_received_notification différents de ceux posés par le lot (propriétaire = rôle appliquant le script ET service_role, rien d''autre). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié silencieusement. Rollback annulé, rien modifié.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;

  select count(*), min(regexp_replace(pg_get_constraintdef(con.oid), '\s', '', 'g'))
    into v_count, v_def
  from pg_constraint con
  where con.conrelid = 'public.notification_outbox'::regclass
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%locale%';
  if v_count <> 1
     or v_def is distinct from regexp_replace('CHECK ((locale = ANY (ARRAY[''fr''::text, ''en''::text, ''ar''::text, ''nl''::text])))', '\s', '', 'g') then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le CHECK de locale de notification_outbox n''est plus exactement (fr, en, ar, nl) : % (% contrainte(s)). Rollback annulé, rien modifié.', v_def, v_count;
  end if;

  select count(*) into v_nl_rows from public.notification_outbox where locale = 'nl';
  if v_nl_rows > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED_NL_ROWS: % ligne(s) de notification_outbox ont la locale nl. Les ramener à fr modifierait des instantanés figés : décision explicite requise (par exemple ne restaurer que la fonction). Rollback annulé, rien modifié.', v_nl_rows;
  end if;
end $$;

-- ------------------------------------------------------------
-- Restauration — le CHECK d'abord (rétrécissement, sans ligne nl), puis la fonction d'avant.
-- ------------------------------------------------------------
do $$
declare
  v_name text;
begin
  select con.conname into v_name
  from pg_constraint con
  where con.conrelid = 'public.notification_outbox'::regclass
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%locale%';
  execute format('alter table public.notification_outbox drop constraint %I', v_name);
end $$;

alter table public.notification_outbox
  add constraint notification_outbox_locale_check check (locale in ('fr', 'en', 'ar'));

create or replace function public.create_order_received_notification(
  p_order_id      uuid,
  p_restaurant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order           public.orders%rowtype;
  v_profile         public.merchant_notification_profile%rowtype;
  v_locale          text;
  v_status          text;
  v_payload         jsonb;
  v_outbox_id       uuid;
  -- CFTE v1 (ajouts).
  v_status_override text;
  v_merchant_name   text;
  -- MERCHANT CUSTOMER COMMUNICATIONS v1 (ajouts).
  v_subject_tpl     text;
  v_body_tpl        text;
  v_contact         record;
  v_invoice         boolean;
  v_withdrawable    boolean;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- Substitution tenant croisée : refusée structurellement, jamais une
  -- simple absence de résultat silencieuse.
  if not found or v_order.restaurant_id <> p_restaurant_id then
    raise exception 'SCANYM_NOTIFICATION_TENANT_MISMATCH: la commande % n''appartient pas au restaurant %', p_order_id, p_restaurant_id
      using errcode = '42501';
  end if;

  select * into v_profile
  from public.merchant_notification_profile where restaurant_id = p_restaurant_id;

  -- Snapshot déterministe de la locale -- jamais réinféré plus tard.
  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar') then v_order.customer_language else 'fr' end;

  -- Éligibilité INCHANGÉE (N1-A) : toujours une ligne outbox, marquée
  -- 'skipped_*' quand l'envoi n'est structurellement pas applicable.
  v_status := case
    when v_order.customer_email is null then 'skipped_no_email'
    when v_profile.restaurant_id is null or not v_profile.email_enabled then 'skipped_disabled'
    else 'pending'
  end;

  -- CFTE v1 — surcharge marchande applicable AU STATUT à cet instant.
  select m.body into v_status_override
  from public.merchant_tracking_status_text m
  where m.restaurant_id = p_restaurant_id
    and m.status = v_order.status;

  select r.name into v_merchant_name
  from public.restaurants r where r.id = p_restaurant_id;

  -- MCC v1 — gabarits marchands de l'e-mail de confirmation, FIGÉS.
  select m.body into v_subject_tpl
  from public.merchant_communication_text m
  where m.restaurant_id = p_restaurant_id and m.text_key = 'email_confirmation_subject';

  select m.body into v_body_tpl
  from public.merchant_communication_text m
  where m.restaurant_id = p_restaurant_id and m.text_key = 'email_confirmation_body';

  select * into v_contact from public.merchant_communication_contact(p_restaurant_id);

  select exists (
    select 1 from public.order_invoice_request r where r.order_id = p_order_id
  ) into v_invoice;

  -- Éligibilité à la rétractation LUE sur l'instantané par ligne de
  -- commande, jamais recalculée et jamais modifiée.
  select exists (
    select 1 from public.order_items oi
    where oi.order_id = p_order_id
      and oi.withdrawal_eligible_at_order_time is true
  ) into v_withdrawable;

  v_payload := jsonb_build_object(
    -- N1-A : les 6 clés d'origine, inchangées.
    'order_number', v_order.order_number,
    'total', v_order.total,
    'currency', v_order.currency,
    'service_mode', v_order.service_mode,
    'public_token', v_order.public_token,
    'created_at', v_order.created_at,
    -- CFTE v1 : les 4 clés additives, inchangées.
    'order_status', v_order.status,
    'status_text_override', v_status_override,
    'delivery_address',
      case when v_order.service_mode = 'delivery' then v_order.delivery_address else null end,
    'merchant_name', v_merchant_name,
    -- MCC v1 : 7 clés additives de plus.
    'subject_template', v_subject_tpl,
    'body_template', v_body_tpl,
    'merchant_address', v_contact.contact_address,
    'merchant_email', v_contact.contact_email,
    'merchant_phone', v_contact.contact_phone,
    'invoice_requested', v_invoice,
    'withdrawal_eligible', v_withdrawable
  );

  insert into public.notification_outbox (
    restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status
  ) values (
    p_restaurant_id, p_order_id, 'order_received', v_order.customer_email, v_locale, v_payload, v_status
  )
  on conflict (restaurant_id, order_id, notification_type) do nothing
  returning id into v_outbox_id;

  -- v_outbox_id reste NULL si une ligne logique existait déjà (rejeu
  -- idempotent) -- ce n'est PAS une erreur.
  return v_outbox_id;
end $$;

comment on function public.create_order_received_notification(uuid, uuid) is
  'N1-A + CFTE v1 + MCC v1 — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente (ON CONFLICT DO NOTHING sur (restaurant_id, order_id, notification_type)). Refuse toute substitution tenant croisée. MCC v1 : le payload_snapshot porte EN PLUS subject_template, body_template, merchant_address, merchant_email, merchant_phone, invoice_requested et withdrawal_eligible -- toutes ADDITIVES, aucune clé CFTE/N1-A retirée ni renommée. Aucun envoi réseau.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- POST-VOL : identité du prédécesseur rétablie, vérifiée DANS la transaction.
do $$
declare
  c_pred_md5      constant text := '59499e52e702da31820e52f646251c90';
  c_pred_md5_crlf constant text := 'e500afdf2cd10c177890efb5028085a8';
  c_pred_comment  constant text := '56d146abf359a0977bb96f6bfd71e966';
  v_src   text;
  v_owner oid;
  v_acl   text[];
  v_expected_acl text[];
  v_def   text;
begin
  select p.prosrc, p.proowner,
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
    into v_src, v_owner, v_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order_received_notification';

  if md5(v_src) not in (c_pred_md5, c_pred_md5_crlf) then
    raise exception 'SCANYM_POSTCHECK: le corps restauré de create_order_received_notification n''est pas celui de MERCHANT CUSTOMER COMMUNICATIONS v1.';
  end if;
  if md5(coalesce(obj_description('public.create_order_received_notification(uuid,uuid)'::regprocedure, 'pg_proc'), '')) <> c_pred_comment then
    raise exception 'SCANYM_POSTCHECK: commentaire restauré inattendu.';
  end if;
  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_POSTCHECK: droits restaurés inattendus : %.', v_acl;
  end if;
  select pg_get_constraintdef(con.oid) into v_def
  from pg_constraint con
  where con.conrelid = 'public.notification_outbox'::regclass and con.conname = 'notification_outbox_locale_check';
  if v_def is null or v_def like '%''nl''%' then
    raise exception 'SCANYM_POSTCHECK: le CHECK de locale restauré est inattendu.';
  end if;
end $$;

commit;
