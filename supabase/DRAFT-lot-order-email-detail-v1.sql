-- ORDER EMAIL DETAIL v1 (issue #211) — e-mail de confirmation COMPLET.
--
-- DRAFT : JAMAIS appliqué par le dépôt ni par l'intégration continue. Aucune étape de ce fichier n'a été
-- exécutée sur une base hébergée. À appliquer SEULEMENT après décision explicite (un GO distinct), AVANT le
-- déploiement du code applicatif de la même PR (le code lit des clés absentes comme « pas de récapitulatif »,
-- donc l'ordre inverse est sans danger, mais le SQL d'abord évite un e-mail sans détail).
--
-- Ce que le lot change (rien d'autre) :
--   1. public.create_order_received_notification(uuid, uuid) — CREATE OR REPLACE. MÊME signature, MÊME type de
--      retour, MÊME garde anti-substitution tenant, MÊME échelle d'éligibilité, MÊME ON CONFLICT DO NOTHING (donc
--      MÊME idempotence). Le payload_snapshot GAGNE des clés ADDITIVES, jamais une clé retirée ni renommée :
--        order_email_detail_v1  true (marqueur de version du récapitulatif)
--        items                  [{item_name, option_name, quantity, unit_price, line_total}] lus dans
--                               public.order_items (valeurs HISTORIQUES de la commande ; aucune lecture de
--                               menu_items : un produit renommé, repricé ou archivé après coup ne change rien)
--        subtotal, delivery_fee lus sur public.orders (le total reste `total`, déjà présent)
--        schedule               {mode_code, scheduled_date (YYYY-MM-DD), selected_time, window_starts_at,
--                               window_ends_at, timezone, date_selection_mode, slot_selection_mode, origin} lu
--                               dans public.order_fulfillment_schedule_snapshot ; ABSENT (null) si la commande
--                               n'en porte pas (mode table, planning informatif sans date). `slot_key` (clé
--                               interne) n'est JAMAIS recopiée.
--        fulfillment_date       date civile ISO persistée (ou null)
--        fulfillment_slot       heure persistée « HH:MM » ou « HH:MM–HH:MM » (ou null : jour seul, Chronofresh)
--                               (tiret ASCII « - » si la base n'est pas en UTF8 : cette fonction tourne dans le
--                               déclencheur différé de création de commande et ne doit JAMAIS lever d'erreur
--                               d'encodage ; le worker recompose l'affichage depuis les clés de `schedule`)
--      La locale `nl` est conservée (elle retombait sur `fr` avant ce lot).
--   2. public.notification_outbox : le CHECK de `locale` passe de ('fr','en','ar') à ('fr','en','ar','nl'),
--      sous son nom canonique notification_outbox_locale_check. Élargissement pur : aucune ligne existante
--      n'est touchée ni invalidée.
--
-- Ce que le lot NE fait PAS : ni create_order, ni le déclencheur différé de #205, ni la reprise, ni les RPC
-- claim_* / porte de paiement / époque d'activation / bail, ni merchant_notification_profile.default_locale
-- (réglage du MARCHAND, sans rapport avec la langue du client), ni create_order_communication_notification
-- (événements additionnels : ils continuent de retomber sur `fr` pour `nl`, inchangés). Aucune ligne n'est
-- supprimée, aucune file historique n'est rouverte, aucun e-mail n'est (re)généré : les lignes DÉJÀ en file
-- gardent leur snapshot d'origine et sont rendues SANS récapitulatif par le nouveau code.
--
-- Compatibilité : ancien code + nouveau snapshot = les clés ajoutées sont ignorées (rendu antérieur inchangé) ;
-- nouveau code + ancien snapshot = pas de récapitulatif (jamais de valeur inventée).
--
-- Source des données du récapitulatif : create_order écrit orders → order_items → … → planning (CSDJ-3) dans une
-- seule transaction ; le déclencheur de #205 est DEFERRABLE INITIALLY DEFERRED et appelle cette fonction à la
-- fin de la transaction, donc APRÈS l'écriture des lignes et du planning (prouvé sur PostgreSQL réel dans
-- tests/order-email-detail-pg.test.ts). La reprise #205 relit les mêmes tables déjà commitées.
--
-- Rollback : supabase/DRAFT-lot-order-email-detail-v1-rollback.sql (refuse toute dérive du corps, des attributs,
-- du propriétaire, des droits et du commentaire ; refuse s'il existe des lignes de file en `nl` ; ne supprime
-- ni snapshot ni décision).
begin;
set local lock_timeout = '10s';

-- ------------------------------------------------------------
-- A. PRÉ-VOL — rien n'est modifié si un contrôle échoue.
-- ------------------------------------------------------------
do $$
declare
  v_missing text;
  v_wrong   text;
begin
  -- A.1 Colonnes lues par la nouvelle définition (la fonction étant plpgsql, une colonne absente ne serait vue
  -- qu'à l'exécution : on la refuse ICI plutôt que de laisser tomber l'enfilement de TOUTES les commandes).
  select string_agg(r.tbl || '.' || r.col, ', ' order by r.tbl, r.col)
    into v_missing
  from (values
    ('orders', 'id'), ('orders', 'restaurant_id'), ('orders', 'order_number'), ('orders', 'subtotal'),
    ('orders', 'delivery_fee'), ('orders', 'total'), ('orders', 'currency'), ('orders', 'service_mode'),
    ('orders', 'customer_language'), ('orders', 'customer_email'), ('orders', 'delivery_address'),
    ('orders', 'status'), ('orders', 'public_token'), ('orders', 'created_at'),
    ('order_items', 'order_id'), ('order_items', 'id'), ('order_items', 'item_name'), ('order_items', 'option_name'),
    ('order_items', 'quantity'), ('order_items', 'unit_price'), ('order_items', 'line_total'),
    ('order_items', 'withdrawal_eligible_at_order_time'),
    ('order_fulfillment_schedule_snapshot', 'order_id'), ('order_fulfillment_schedule_snapshot', 'mode_code'),
    ('order_fulfillment_schedule_snapshot', 'scheduled_date'), ('order_fulfillment_schedule_snapshot', 'selected_time'),
    ('order_fulfillment_schedule_snapshot', 'window_starts_at'), ('order_fulfillment_schedule_snapshot', 'window_ends_at'),
    ('order_fulfillment_schedule_snapshot', 'timezone'), ('order_fulfillment_schedule_snapshot', 'date_selection_mode'),
    ('order_fulfillment_schedule_snapshot', 'slot_selection_mode'), ('order_fulfillment_schedule_snapshot', 'origin'),
    ('notification_outbox', 'locale'), ('notification_outbox', 'payload_snapshot')
  ) as r(tbl, col)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = r.tbl and c.relkind in ('r', 'p')
      and a.attname = r.col and a.attnum > 0 and not a.attisdropped
  );
  if v_missing is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes absentes : % -- ORDER EMAIL DETAIL v1 annulé, rien modifié.', v_missing;
  end if;

  -- A.2 TYPES des colonnes de planning : l'instantané hébergé stocke des chaînes « HH:MM » (contraintes CHECK
  -- hébergées) et une date civile. Un autre type (time, timestamptz) changerait silencieusement le format
  -- recopié dans l'e-mail : refus, jamais conversion devinée. Le DDL de cette table n'est PAS dans le dépôt.
  select string_agg(format('%s.%s=%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ', ')
    into v_wrong
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'order_fulfillment_schedule_snapshot' and a.attnum > 0 and not a.attisdropped
    and (
      (a.attname = 'scheduled_date' and a.atttypid <> 'date'::regtype)
      or (a.attname in ('selected_time', 'window_starts_at', 'window_ends_at', 'timezone', 'mode_code',
                        'date_selection_mode', 'slot_selection_mode', 'origin')
          and a.atttypid not in ('text'::regtype, 'character varying'::regtype))
      or (a.attname = 'order_id' and a.atttypid <> 'uuid'::regtype)
    );
  if v_wrong is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: types inattendus pour order_fulfillment_schedule_snapshot : % -- annulé, rien modifié.', v_wrong;
  end if;

  select string_agg(format('orders.%s=%s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ')
    into v_wrong
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'orders' and a.attnum > 0 and not a.attisdropped
    and a.attname in ('subtotal', 'delivery_fee', 'total')
    and a.atttypid <> 'numeric'::regtype;
  if v_wrong is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: montants de orders non numériques : % -- annulé, rien modifié.', v_wrong;
  end if;

  select string_agg(format('order_items.%s=%s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ')
    into v_wrong
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'order_items' and a.attnum > 0 and not a.attisdropped
    and (
      (a.attname in ('unit_price', 'line_total') and a.atttypid <> 'numeric'::regtype)
      or (a.attname = 'quantity' and a.atttypid <> 'integer'::regtype)
      or (a.attname in ('item_name', 'option_name') and a.atttypid not in ('text'::regtype, 'character varying'::regtype))
    );
  if v_wrong is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: types inattendus pour order_items : % -- annulé, rien modifié.', v_wrong;
  end if;
end $$;

do $$
declare
  c_pred_md5      constant text := '59499e52e702da31820e52f646251c90';
  c_pred_md5_crlf constant text := 'e500afdf2cd10c177890efb5028085a8';
  c_pred_comment  constant text := '56d146abf359a0977bb96f6bfd71e966';
  c_args          constant text := 'p_order_id uuid, p_restaurant_id uuid';
  c_result        constant text := 'uuid';
  c_attrs         constant text := 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=f;cost=100;rows=0;support=0;variadic=0;nargs=2;ndefaults=0;config=search_path=""';
  v_count   integer;
  v_oid     oid;
  v_owner   oid;
  v_args    text;
  v_result  text;
  v_src     text;
  v_md5     text;
  v_attrs   text;
  v_acl     text[];
  v_expected_acl text[];
  v_comment_md5  text;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order_received_notification';
  if v_count <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order_received_notification doit exister en UNE seule surcharge (trouvé %). Annulé, rien modifié.', v_count;
  end if;

  select p.oid, p.proowner, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosrc, md5(p.prosrc),
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
    into v_oid, v_owner, v_args, v_result, v_src, v_md5, v_attrs, v_acl, v_comment_md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'create_order_received_notification';

  if position('order_email_detail_v1' in v_src) > 0 then
    raise exception 'SCANYM_ALREADY_APPLIED: create_order_received_notification porte déjà order_email_detail_v1 -- annulé, rien modifié.';
  end if;

  -- Le remplacement n'est légitime que sur le corps EXACT posé par MERCHANT CUSTOMER COMMUNICATIONS v1 : sur toute
  -- autre version (modifiée à la main, ou plus récente), il écraserait en silence ce qu'elle porte.
  if v_md5 not in (c_pred_md5, c_pred_md5_crlf) then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le corps de create_order_received_notification (md5 %) n''est pas celui de MERCHANT CUSTOMER COMMUNICATIONS v1 (md5 %). Le remplacer perdrait un ajout inconnu. Annulé, rien modifié.', v_md5, c_pred_md5;
  end if;
  if v_args is distinct from c_args or v_result is distinct from c_result or v_attrs is distinct from c_attrs then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: signature ou attributs de create_order_received_notification inattendus. Observé : % / % / % ; attendu : % / % / %. Annulé, rien modifié.', v_args, v_result, v_attrs, c_args, c_result, c_attrs;
  end if;
  if v_comment_md5 is distinct from c_pred_comment then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le commentaire de create_order_received_notification (md5 %) n''est pas celui de MERCHANT CUSTOMER COMMUNICATIONS v1 (md5 %). Annulé, rien modifié.', v_comment_md5, c_pred_comment;
  end if;

  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
     or v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits de create_order_received_notification inattendus (propriétaire = rôle appliquant le script ET service_role, rien d''autre). Observé : propriétaire %, droits % ; attendu : %. Annulé, rien modifié.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;
end $$;

-- A.3 CHECK de locale : exactement un, et exactement ('fr','en','ar'). Toute autre forme = dérive inconnue.
--     Comparaison EXACTE (AUD214-01) : le squelette de la définition (littéraux remplacés par un marqueur, espaces
--     de structure ignorés) ET la liste ordonnée des littéraux, octet pour octet. Une espace DANS un littéral
--     ('f r', ' fr', 'fr ') ou une valeur en plus/en moins/dans un autre ordre n'est donc JAMAIS assimilée à la forme
--     attendue ; seuls les espaces entre les éléments de la définition sont ignorés.
do $$
declare
  c_ref3  constant text := 'CHECK ((locale = ANY (ARRAY[''fr''::text, ''en''::text, ''ar''::text])))';
  c_ref4  constant text := 'CHECK ((locale = ANY (ARRAY[''fr''::text, ''en''::text, ''ar''::text, ''nl''::text])))';
  v_count integer;
  v_raw   text;
  v_skel  text;
  v_vals  text[];
begin
  select count(*), min(pg_get_constraintdef(con.oid))
    into v_count, v_raw
  from pg_constraint con
  where con.conrelid = 'public.notification_outbox'::regclass
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%locale%';
  if v_count <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: notification_outbox doit porter exactement UN CHECK sur locale (trouvé %). Annulé, rien modifié.', v_count;
  end if;
  v_skel := regexp_replace(regexp_replace(v_raw, '''[^'']*''', '''L''', 'g'), '\s', '', 'g');
  v_vals := (select coalesce(array_agg(t.m[1] order by t.n), '{}'::text[]) from regexp_matches(v_raw, '''([^'']*)''', 'g') with ordinality as t(m, n));
  if v_vals = array['fr', 'en', 'ar', 'nl']::text[] and v_skel = regexp_replace(regexp_replace(c_ref4, '''[^'']*''', '''L''', 'g'), '\s', '', 'g') then
    raise exception 'SCANYM_ALREADY_APPLIED: le CHECK de locale accepte déjà nl -- annulé, rien modifié.';
  end if;
  if v_vals is distinct from array['fr', 'en', 'ar']::text[] or v_skel is distinct from regexp_replace(regexp_replace(c_ref3, '''[^'']*''', '''L''', 'g'), '\s', '', 'g') then
    raise exception 'SCANYM_SCHEMA_DRIFT: le CHECK de locale n''est pas ceux de N1-A (fr, en, ar) : % -- annulé, rien modifié.', v_raw;
  end if;
end $$;

-- ------------------------------------------------------------
-- B. LOCALE `nl` — élargissement du CHECK (aucune ligne existante n'est touchée).
--    Verrou exclusif court : la file est lue par claim_* ; le CHECK est vérifié sur les lignes existantes (elles
--    sont toutes dans ('fr','en','ar'), donc valides).
-- ------------------------------------------------------------
lock table public.notification_outbox in access exclusive mode;

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
  add constraint notification_outbox_locale_check check (locale in ('fr', 'en', 'ar', 'nl'));

-- ------------------------------------------------------------
-- C. create_order_received_notification — CREATE OR REPLACE.
-- ------------------------------------------------------------
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
  -- ORDER EMAIL DETAIL v1 (ajouts) -- order_email_detail_v1.
  v_items           jsonb;
  v_sched           record;
  v_schedule        jsonb;
  v_time_label      text;
  v_dash            text := '-';
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
  -- ORDER EMAIL DETAIL v1 : `nl` est désormais conservé (il retombait sur
  -- `fr` avant ce lot). Toute autre valeur retombe toujours sur `fr`.
  v_locale := case when v_order.customer_language in ('fr', 'en', 'ar', 'nl') then v_order.customer_language else 'fr' end;

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

  -- ORDER EMAIL DETAIL v1 — lignes de commande, telles que FIGÉES à la
  -- commande dans order_items (nom, option, quantité, prix unitaire et
  -- total de ligne HISTORIQUES). AUCUNE lecture du catalogue courant :
  -- renommer, repricer ou archiver un produit après la commande ne
  -- change pas ce récapitulatif. Ordre déterministe (aucune
  -- colonne de position n'existe, created_at est identique pour toutes
  -- les lignes d'une même transaction).
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'item_name', oi.item_name,
               'option_name', oi.option_name,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price,
               'line_total', oi.line_total
             )
             order by oi.item_name, oi.option_name nulls first, oi.id
           ),
           '[]'::jsonb
         )
    into v_items
  from public.order_items oi
  where oi.order_id = p_order_id;

  -- ORDER EMAIL DETAIL v1 — jour et créneau RETENUS, lus sur l'instantané
  -- de planning écrit par create_order (CSDJ-3) dans la MÊME transaction,
  -- avant l'exécution du déclencheur différé (#205). Aucune ligne
  -- (mode table, planning informatif sans date, commande antérieure) =>
  -- aucune clé de planning, jamais une valeur inventée. La clé interne
  -- de créneau n'est volontairement JAMAIS recopiée.
  select s.mode_code, s.scheduled_date, s.selected_time,
         s.window_starts_at, s.window_ends_at, s.timezone,
         s.date_selection_mode, s.slot_selection_mode, s.origin
    into v_sched
  from public.order_fulfillment_schedule_snapshot s
  where s.order_id = p_order_id;

  if found and v_sched.scheduled_date is not null then
    -- Tiret demi-cadratin seulement si la base est en UTF8 : l'expression est dans une affectation PL/pgSQL
    -- conditionnelle (planifiée uniquement si la branche est prise), pour que cette fonction ne puisse JAMAIS
    -- lever d'erreur d'encodage dans le déclencheur différé de création de commande.
    if pg_catalog.getdatabaseencoding() = 'UTF8' then
      v_dash := pg_catalog.chr(8211);
    end if;
    v_time_label := case
      when v_sched.selected_time is not null then v_sched.selected_time
      when v_sched.window_starts_at is not null and v_sched.window_ends_at is not null
        then v_sched.window_starts_at || v_dash || v_sched.window_ends_at
      when v_sched.window_starts_at is not null then v_sched.window_starts_at
      else null
    end;
    v_schedule := jsonb_build_object(
      'mode_code', v_sched.mode_code,
      'scheduled_date', pg_catalog.to_char(v_sched.scheduled_date, 'YYYY-MM-DD'),
      'selected_time', v_sched.selected_time,
      'window_starts_at', v_sched.window_starts_at,
      'window_ends_at', v_sched.window_ends_at,
      'timezone', v_sched.timezone,
      'date_selection_mode', v_sched.date_selection_mode,
      'slot_selection_mode', v_sched.slot_selection_mode,
      'origin', v_sched.origin
    );
  else
    v_time_label := null;
    v_schedule := null;
  end if;

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
    -- MCC v1 : 7 clés additives de plus, inchangées.
    'subject_template', v_subject_tpl,
    'body_template', v_body_tpl,
    'merchant_address', v_contact.contact_address,
    'merchant_email', v_contact.contact_email,
    'merchant_phone', v_contact.contact_phone,
    'invoice_requested', v_invoice,
    'withdrawal_eligible', v_withdrawable
  ) || jsonb_build_object(
    -- ORDER EMAIL DETAIL v1 : clés ADDITIVES (optionnelles pour tout
    -- lecteur antérieur). `fulfillment_date` / `fulfillment_slot` sont les
    -- noms DÉJÀ lus par le worker et par les variables marchandes
    -- {fulfillment_date} / {fulfillment_slot} : date civile ISO et libellé
    -- d'heure persistés, jamais formatés ici.
    'order_email_detail_v1', true,
    'items', v_items,
    'subtotal', v_order.subtotal,
    'delivery_fee', v_order.delivery_fee,
    'schedule', v_schedule,
    'fulfillment_date', case when v_schedule is null then null else v_schedule ->> 'scheduled_date' end,
    'fulfillment_slot', v_time_label
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
  'N1-A + CFTE v1 + MCC v1 + ORDER EMAIL DETAIL v1 — seule autorité d''insertion ORDER_RECEIVED dans notification_outbox. Idempotente (ON CONFLICT DO NOTHING sur (restaurant_id, order_id, notification_type)). Refuse toute substitution tenant croisée. MCC v1 : subject_template, body_template, merchant_address, merchant_email, merchant_phone, invoice_requested, withdrawal_eligible. ORDER EMAIL DETAIL v1 : le payload_snapshot porte EN PLUS order_email_detail_v1, items (nom, option, quantité, prix unitaire et total de ligne HISTORIQUES de order_items), subtotal, delivery_fee, schedule (jour et créneau retenus de order_fulfillment_schedule_snapshot, sans slot_key), fulfillment_date et fulfillment_slot -- toutes ADDITIVES, aucune clé antérieure retirée ni renommée ; la locale nl est conservée. Aucune lecture du catalogue courant, aucun envoi réseau.';

revoke all on function public.create_order_received_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- Z. POST-VOL — vérifié par le lot lui-même, DANS la transaction : un écart annule tout.
-- ------------------------------------------------------------
do $$
declare
  c_new_md5      constant text := '7729300a66a37fafcfeb95878a64d572';
  c_new_md5_crlf constant text := 'e46b55daec59649a214185879dd89068';
  c_new_comment  constant text := '95eee794ae1c2edee83f16e64b305a69';
  v_src     text;
  v_owner   oid;
  v_acl     text[];
  v_expected_acl text[];
  v_key     text;
  v_def     text;
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

  if md5(v_src) not in (c_new_md5, c_new_md5_crlf) then
    raise exception 'SCANYM_POSTCHECK: le corps installé de create_order_received_notification n''est pas celui du lot.';
  end if;
  if md5(coalesce(obj_description('public.create_order_received_notification(uuid,uuid)'::regprocedure, 'pg_proc'), '')) <> c_new_comment then
    raise exception 'SCANYM_POSTCHECK: commentaire de create_order_received_notification inattendu.';
  end if;

  -- Strictement additif : toute clé d'avant le lot est encore écrite.
  foreach v_key in array array[
    'order_number', 'total', 'currency', 'service_mode', 'public_token', 'created_at', 'order_status',
    'status_text_override', 'delivery_address', 'merchant_name', 'subject_template', 'body_template',
    'merchant_address', 'merchant_email', 'merchant_phone', 'invoice_requested', 'withdrawal_eligible'
  ] loop
    if position(format('''%s'',', v_key) in v_src) = 0 then
      raise exception 'SCANYM_POSTCHECK: la clé % n''est plus écrite -- la redéfinition n''est pas strictement additive.', v_key;
    end if;
  end loop;

  -- Aucune lecture du catalogue courant ni de la clé interne de créneau.
  if position('menu_items' in v_src) > 0 or position('slot_key' in v_src) > 0 then
    raise exception 'SCANYM_POSTCHECK: la fonction ne doit lire ni menu_items ni slot_key.';
  end if;

  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_POSTCHECK: droits de create_order_received_notification inattendus : %.', v_acl;
  end if;

  select pg_get_constraintdef(con.oid) into v_def
  from pg_constraint con
  where con.conrelid = 'public.notification_outbox'::regclass and con.conname = 'notification_outbox_locale_check';
  if v_def is null
     or (select coalesce(array_agg(t.m[1] order by t.n), '{}'::text[]) from regexp_matches(v_def, '''([^'']*)''', 'g') with ordinality as t(m, n)) is distinct from array['fr', 'en', 'ar', 'nl']::text[]
     or regexp_replace(regexp_replace(v_def, '''[^'']*''', '''L''', 'g'), '\s', '', 'g') is distinct from regexp_replace(regexp_replace('CHECK ((locale = ANY (ARRAY[''fr''::text, ''en''::text, ''ar''::text, ''nl''::text])))', '''[^'']*''', '''L''', 'g'), '\s', '', 'g') then
    raise exception 'SCANYM_POSTCHECK: le CHECK de locale n''est pas exactement (fr, en, ar, nl) : %.', v_def;
  end if;
end $$;

commit;
