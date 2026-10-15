-- ============================================================
-- Scanym — CSDJ-BO-1 — ÉCRITURE TRANSACTIONNELLE PAR COMMERÇANT  (v1)
-- Fichier  : supabase/DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1.sql
-- Statut   : DRAFT — NON APPLIQUÉ. Aucun SQL hébergé, aucun déploiement
--            sans GO CIO/CTO et audit indépendant (Cat Greco).
-- Mandat   : issue #148 [BOULEZ] ; demande de contrat :
--            docs/scheduling/csdj-bo1-write-contract-request.md ;
--            contrat livré : docs/scheduling/csdj-bo1-save-fulfillment-configuration-contract.md
--
-- CE QUE FAIT CE FICHIER (et RIEN d'autre)
--   Crée TROIS fonctions dans `public`, rien de plus :
--     1. save_fulfillment_configuration(p_restaurant_id uuid, p_payload jsonb) returns jsonb
--        ÉCRIT l'état voulu d'UNE portée (restaurant, mode, règle de livraison)
--        EN ENTIER, en UNE transaction : politique, fenêtres, créneaux,
--        fermetures, calendrier de préparation, jours fériés, capacité ET
--        activation. Remplacement intégral, jamais de delta, jamais d'état
--        partiel observable. Renvoie la configuration RELUE dans la même
--        transaction, sans aucun compte de capacité.
--     2. get_fulfillment_configuration(p_restaurant_id uuid, p_mode_code text,
--        p_fulfillment_rule_id uuid default null) returns jsonb
--        LECTURE de cette même configuration (même forme que la réponse de
--        l'écriture), avec `updatedAt` et `revision` : sans elle, l'éditeur
--        n'aurait aucun jeton d'anti-concurrence AVANT sa première
--        sauvegarde. Aucune écriture. Ajout ADDITIF : get_merchant_fulfillment_schedules
--        n'est PAS modifiée (demande §2.3, seconde branche).
--     3. csdjbo1_persisted_configuration(uuid,text,uuid) : constructeur
--        INTERNE partagé par 1 et 2 ; fermé à tous les rôles applicatifs.
--
-- CE QUE CE FICHIER NE FAIT PAS
--   - Il ne crée, ne modifie et ne supprime AUCUN objet existant : ni table,
--     ni colonne, ni contrainte, ni politique RLS, ni déclencheur, ni droit,
--     ni fonction. Le pré-vol relève une empreinte de la surface existante
--     (corps, ACL, propriétaire de TOUTES les fonctions de `public`, colonnes,
--     contraintes, politiques, déclencheurs, droits de table) ; le post-vol la
--     compare et ANNULE tout si elle a bougé d'un octet.
--   - Il ne touche NI CSDJ-1, NI CSDJ v1.2, NI CSDJ-3 (create_order,
--     validate_fulfillment_selection, reserve_fulfillment_capacity restent
--     byte à byte ce qu'ils sont). Il ne les réapplique pas.
--   - Il n'insère AUCUNE ligne : pas de donnée d'exemple, pas de règle de
--     commerçant, pas de calendrier, pas de défaut global. Les règles d'un
--     commerçant (p. ex. Au Lait Cru) n'existent que dans SES lignes.
--   - Il n'ajoute aucune intégration de transporteur.
--
-- PERMISSIONS (identiques à l'autorité d'écriture existante)
--   authenticated UNIQUEMENT (ni PUBLIC, ni anon, ni service_role) ;
--   contrôle de rôle DANS le corps : has_role_in(restaurant, owner|manager).
--   Aucune dérogation opérateur Scanym à l'écriture. SECURITY DEFINER,
--   search_path = '' (tout objet est qualifié).
--
-- PROPRIÉTÉS (preuves : supabase/tests/csdj-bo1-save-configuration-check.sh)
--   - une transaction : une erreur à n'importe quel instant ne laisse RIEN ;
--   - verrou consultatif de tenant, graine 1104 : le MÊME que les deux
--     mutateurs existants, pour se sérialiser avec eux ;
--   - READ COMMITTED exigé (le verrou ne vaut que pour des lectures fraîches) ;
--   - complétude ÉVALUÉE avant activation : CSDJBO1_INCOMPLETE_CONFIGURATION ;
--   - anti-concurrence : CSDJBO1_STALE_CONFIGURATION (expectedUpdatedAt, et
--     expectedRevision quand il est fourni) ;
--   - CSDJBO1_METHOD_MISMATCH : sections d'une autre méthode.
--
-- LIMITE CONNUE, DOCUMENTÉE, NON FERMÉE ICI (décision CTO requise)
--   Les mutateurs EXISTANTS (mutate_merchant_fulfillment_schedule[_v12])
--   restent exécutables par authenticated : ils peuvent encore activer une
--   portée incomplète, et leurs actions `replace_*` ne font pas bouger
--   `updated_at`. Les fermer exigerait de modifier ou de révoquer des
--   fonctions existantes — hors mandat. Mitigation livrée : la révision
--   (`revision`) couvre le contenu des listes ; l'interface N'APPELLE QUE la
--   nouvelle fonction. Voir le contrat, §Limites.
--
-- IDEMPOTENCE : NON ré-exécutable, volontairement (pré-vol : refus dès que
-- l'un des trois objets existe).
-- ============================================================

begin;

-- ============================================================
-- §A  PRÉ-VOL — refus nommés, avant toute création
-- ============================================================
do $csdjbo1_preflight$
declare
  v_n        integer;
  v_t        text;
  v_owner    text;
  v_surface  text;
  v_data     text;
begin
  -- A.1 Exécutant = propriétaire de l'autorité d'écriture existante. La
  --     fonction est SECURITY DEFINER : son propriétaire est la frontière de
  --     privilège. Elle doit être possédée par celui qui possède déjà
  --     mutate_merchant_fulfillment_schedule, jamais par un autre rôle.
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'mutate_merchant_fulfillment_schedule';
  if v_owner is null then
    raise exception 'SCANYM_CSDJBO1_PREFLIGHT: mutate_merchant_fulfillment_schedule absente -- CSDJ-1 n''est pas appliqué.' using errcode = '55000';
  end if;
  if v_owner is distinct from current_user then
    raise exception 'SCANYM_CSDJBO1_PREFLIGHT: exécutant % différent du propriétaire % de l''autorité d''écriture existante.', current_user, v_owner using errcode = '42501';
  end if;

  -- A.2 CSDJ-1 présent : quatre tables, lectures et écritures v1.
  foreach v_t in array array[
    'restaurant_fulfillment_schedule','restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot','restaurant_fulfillment_schedule_closure'] loop
    if pg_catalog.to_regclass('public.' || v_t) is null then
      raise exception 'SCANYM_CSDJBO1_PREFLIGHT: table % absente -- CSDJ-1 n''est pas appliqué.', v_t using errcode = '55000';
    end if;
  end loop;
  if pg_catalog.to_regprocedure('public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)') is null
     or pg_catalog.to_regprocedure('public.get_merchant_fulfillment_schedules(uuid)') is null then
    raise exception 'SCANYM_CSDJBO1_PREFLIGHT: RPC CSDJ-1 absentes.' using errcode = '55000';
  end if;

  -- A.3 CSDJ v1.2 présent. Ce fichier n'applique PAS la v1.2 : il refuse de
  --     s'appliquer sans elle (les colonnes et tables qu'il écrit n'existent
  --     pas) et ne la réapplique jamais.
  foreach v_t in array array[
    'restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure',
    'public_holiday_calendar','public_holiday_calendar_day',
    'order_fulfillment_capacity_reservation'] loop
    if pg_catalog.to_regclass('public.' || v_t) is null then
      raise exception 'SCANYM_CSDJBO1_PREFLIGHT: table % absente -- CSDJ v1.2 n''est pas appliquée.', v_t using errcode = '55000';
    end if;
  end loop;
  foreach v_t in array array[
    'holiday_calendar_id','preparation_on_holidays','availability_on_holidays',
    'capacity_enabled','capacity_max_orders'] loop
    if not exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = 'public.restaurant_fulfillment_schedule'::regclass
                     and a.attname = v_t and a.attnum > 0 and not a.attisdropped) then
      raise exception 'SCANYM_CSDJBO1_PREFLIGHT: colonne % absente -- CSDJ v1.2 n''est pas appliquée.', v_t using errcode = '55000';
    end if;
  end loop;
  if pg_catalog.to_regprocedure('public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)') is null
     or pg_catalog.to_regprocedure('public.get_merchant_fulfillment_schedules_v12(uuid)') is null then
    raise exception 'SCANYM_CSDJBO1_PREFLIGHT: RPC CSDJ v1.2 absentes.' using errcode = '55000';
  end if;
  -- Les contraintes qui font autorité sur la forme des données.
  foreach v_t in array array[
    'rfs_policy_coherent','rfs_granularity_required','rfs_v12_no_cutoff_offset',
    'rfs_v12_extensions_only','rfs_capacity_complete','rfs_capacity_needs_date',
    'rfs_holiday_requires_calendar','rfs_method_version_known'] loop
    if not exists (select 1 from pg_catalog.pg_constraint c
                   where c.conrelid = 'public.restaurant_fulfillment_schedule'::regclass and c.conname = v_t) then
      raise exception 'SCANYM_CSDJBO1_PREFLIGHT: contrainte % absente -- l''état attendu de CSDJ-1/v1.2 n''est pas là.', v_t using errcode = '55000';
    end if;
  end loop;

  -- A.4 Fonctions d'autorisation et catalogues dont dépend le corps.
  if pg_catalog.to_regprocedure('public.has_role_in(uuid,text[])') is null
     or pg_catalog.to_regprocedure('public.is_member_of(uuid)') is null
     or pg_catalog.to_regprocedure('public.is_scanym_operator()') is null
     or pg_catalog.to_regclass('public.sale_mode_catalog') is null
     or pg_catalog.to_regclass('public.restaurant_sale_mode_fulfillments') is null
     or pg_catalog.to_regprocedure('public.checkout_date_selection_modes()') is null
     or pg_catalog.to_regprocedure('public.checkout_slot_selection_modes()') is null then
    raise exception 'SCANYM_CSDJBO1_PREFLIGHT: une dépendance d''autorisation ou de catalogue est absente.' using errcode = '55000';
  end if;

  -- A.5 Aucune des trois fonctions n'existe, sous aucune signature.
  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p
  where p.proname in ('save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration');
  if v_n <> 0 then
    raise exception 'SCANYM_CSDJBO1_PREFLIGHT: % fonction(s) du lot existent déjà -- ce fichier n''est pas ré-exécutable.', v_n using errcode = '55000';
  end if;

  -- A.6 Empreinte de la surface EXISTANTE, relevée ici et comparée au post-vol.
  --     (a) toutes les fonctions de `public` : signature, corps, ACL,
  --         propriétaire, SECURITY, volatilité, configuration, type de retour ;
  --     (b) colonnes, contraintes, politiques, déclencheurs, droits de table ;
  --     (c) le CONTENU des tables de configuration.
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
           p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|'
           || pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
           || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-') || '|'
           || pg_catalog.pg_get_function_result(p.oid),
           E'\n' order by p.oid::regprocedure::text), ''))
    into v_surface
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace;
  perform pg_catalog.set_config('scanym.csdjbo1.pre_functions', v_surface, true);

  select pg_catalog.md5(
           coalesce((select pg_catalog.string_agg(table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '-'), E'\n' order by table_name, column_name)
                     from information_schema.columns where table_schema = 'public'), '')
        || coalesce((select pg_catalog.string_agg(conrelid::regclass::text || '|' || conname || '|' || pg_catalog.pg_get_constraintdef(oid), E'\n' order by conrelid::regclass::text, conname)
                     from pg_catalog.pg_constraint where connamespace = 'public'::regnamespace), '')
        || coalesce((select pg_catalog.string_agg(tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '-') || '|' || coalesce(with_check, '-'), E'\n' order by tablename, policyname)
                     from pg_catalog.pg_policies where schemaname = 'public'), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid), E'\n' order by c.relname, t.tgname)
                     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
                     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || coalesce(c.relacl::text, '-') || '|' || c.relrowsecurity::text, E'\n' order by c.relname)
                     from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'), ''))
    into v_surface;
  perform pg_catalog.set_config('scanym.csdjbo1.pre_structure', v_surface, true);

  v_data := '';
  foreach v_t in array array[
    'restaurant_fulfillment_schedule','restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot','restaurant_fulfillment_schedule_closure',
    'restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure',
    'public_holiday_calendar','public_holiday_calendar_day',
    'order_fulfillment_capacity_reservation'] loop
    execute pg_catalog.format(
      'select pg_catalog.md5(coalesce(pg_catalog.string_agg(x::text, E''\n'' order by x::text), '''')) from public.%I x', v_t)
      into v_surface;
    v_data := v_data || v_t || '=' || v_surface || ';';
  end loop;
  perform pg_catalog.set_config('scanym.csdjbo1.pre_data', pg_catalog.md5(v_data), true);
end
$csdjbo1_preflight$;

-- ============================================================
-- §B  CONSTRUCTEUR INTERNE DE LA CONFIGURATION PERSISTÉE
-- ============================================================
-- Une seule définition de « la configuration relue » : celle de l'écriture
-- et celle de la lecture ne peuvent donc pas diverger. AUCUN compte, aucune
-- place restante, aucun compteur : `capacity.maxOrders` est la LIMITE
-- configurée, pas un remplissage.
create function public.csdjbo1_persisted_configuration(
  p_restaurant_id uuid,
  p_mode_code     text,
  p_rule_key      uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $csdjbo1_build$
declare
  s     public.restaurant_fulfillment_schedule%rowtype;
  v_cfg jsonb;
begin
  select x.* into s
  from public.restaurant_fulfillment_schedule x
  where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code and x.rule_key = p_rule_key;
  if not found then
    return null;
  end if;

  v_cfg := pg_catalog.jsonb_build_object(
    'modeCode', s.mode_code,
    'fulfillmentRuleId', s.fulfillment_rule_id,
    'method', s.schedule_method_version,
    'enabled', s.enabled,
    'policy', pg_catalog.jsonb_build_object(
      'timezone', s.timezone,
      'dateSelectionMode', s.date_selection_mode,
      'slotSelectionMode', s.slot_selection_mode,
      'timeGranularityMinutes', s.time_granularity_minutes,
      'leadTimeMinutes', s.lead_time_minutes,
      'minLeadDays', s.min_lead_days,
      'cutoffTime', pg_catalog.to_char(s.cutoff_time, 'HH24:MI'),
      'cutoffOffsetDays', s.cutoff_offset_days,
      'bookingHorizonDays', s.booking_horizon_days),
    'windows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'weekday', w.weekday,
               'startsAt', pg_catalog.to_char(w.starts_at, 'HH24:MI'),
               'endsAt', pg_catalog.to_char(w.ends_at, 'HH24:MI'),
               'displayOrder', w.display_order) order by w.weekday, w.starts_at)
      from public.restaurant_fulfillment_schedule_window w
      where w.restaurant_id = s.restaurant_id and w.mode_code = s.mode_code and w.rule_key = s.rule_key), '[]'::jsonb),
    'slots', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'weekday', x.weekday,
               'slotKey', x.slot_key,
               'startsAt', pg_catalog.to_char(x.starts_at, 'HH24:MI'),
               'endsAt', pg_catalog.to_char(x.ends_at, 'HH24:MI'),
               'displayOrder', x.display_order) order by x.weekday, x.starts_at, x.slot_key)
      from public.restaurant_fulfillment_schedule_slot x
      where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key), '[]'::jsonb),
    'closures', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'closedOn', c.closed_on, 'label', c.label) order by c.closed_on)
      from public.restaurant_fulfillment_schedule_closure c
      where c.restaurant_id = s.restaurant_id and c.mode_code = s.mode_code and c.rule_key = s.rule_key), '[]'::jsonb));

  if s.schedule_method_version = 'v1.2' then
    v_cfg := v_cfg || pg_catalog.jsonb_build_object(
      'preparation', pg_catalog.jsonb_build_object(
        'weekdays', coalesce((
          select pg_catalog.jsonb_agg(d.weekday order by d.weekday)
          from public.restaurant_fulfillment_prep_day d
          where d.restaurant_id = s.restaurant_id and d.mode_code = s.mode_code and d.rule_key = s.rule_key), '[]'::jsonb),
        'closures', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'closedOn', c.closed_on, 'label', c.label) order by c.closed_on)
          from public.restaurant_fulfillment_prep_closure c
          where c.restaurant_id = s.restaurant_id and c.mode_code = s.mode_code and c.rule_key = s.rule_key), '[]'::jsonb)),
      'holidays', pg_catalog.jsonb_build_object(
        'calendarId', s.holiday_calendar_id,
        'preparationOnHolidays', s.preparation_on_holidays,
        'availabilityOnHolidays', s.availability_on_holidays),
      'capacity', pg_catalog.jsonb_build_object(
        'enabled', s.capacity_enabled,
        'maxOrders', s.capacity_max_orders));
  end if;

  -- `revision` = empreinte du CONTENU (sans jeton) : elle bouge aussi quand
  -- une liste est réécrite par un mutateur existant, qui ne touche pas
  -- `updated_at`. `updatedAt` : microsecondes, UTC -- à renvoyer tel quel.
  return v_cfg || pg_catalog.jsonb_build_object(
    'updatedAt', pg_catalog.to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'revision', pg_catalog.md5(v_cfg::text));
end
$csdjbo1_build$;

comment on function public.csdjbo1_persisted_configuration(uuid,text,uuid) is
  'CSDJ-BO-1 — constructeur INTERNE de la configuration persistée d''une portée (forme identique en lecture et en réponse d''écriture). Aucun compte de capacité. Aucun accès applicatif : appelé par save_fulfillment_configuration et get_fulfillment_configuration, qui portent les contrôles d''accès.';

-- ============================================================
-- §C  ÉCRITURE : save_fulfillment_configuration
-- ============================================================
create function public.save_fulfillment_configuration(
  p_restaurant_id uuid,
  p_payload       jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $csdjbo1_save$
declare
  c_nil        constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_k          text;
  v_item       jsonb;
  v_mode       text;
  v_rule       uuid;
  v_rule_key   uuid;
  v_method     text;
  v_enabled    boolean;
  v_pol        jsonb;
  v_tz         text;
  v_date_mode  text;
  v_slot_mode  text;
  v_gran       smallint;
  v_lead       integer;
  v_minlead    smallint;
  v_cutoff     time;
  v_cut_off    smallint;
  v_horizon    smallint;
  v_windows    jsonb;
  v_slots      jsonb;
  v_closures   jsonb;
  v_prep       jsonb;
  v_prep_days  jsonb;
  v_prep_clos  jsonb;
  v_hol        jsonb;
  v_cal        uuid;
  v_prep_h     text;
  v_avail_h    text;
  v_cap        jsonb;
  v_cap_on     boolean;
  v_cap_max    integer;
  v_exist      public.restaurant_fulfillment_schedule%rowtype;
  v_found      boolean;
  v_exp_txt    text;
  v_exp_ts     timestamptz;
  v_exp_rev    text;
  v_blockers   text[] := array[]::text[];
  v_new_upd    timestamptz;
  v_result     jsonb;
  c_time_re    constant text := '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?$';
  c_date_re    constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
begin
  -- 1. Session et rôle : mêmes refus, mêmes codes que les mutateurs existants.
  if auth.uid() is null then
    raise exception 'CSDJ1_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.has_role_in(p_restaurant_id, array['owner','manager']) then
    raise exception 'CSDJ1_FORBIDDEN: rôle owner ou manager requis.' using errcode = '42501';
  end if;

  -- 2. Le verrou de tenant ne protège que des lectures FRAÎCHES : sous
  --    REPEATABLE READ l'instantané daterait d'avant l'attente du verrou.
  if pg_catalog.current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'CSDJ12_ISOLATION_REQUIRED: l''écriture de configuration exige READ COMMITTED.' using errcode = '55000';
  end if;

  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'CSDJ1_INVALID_PAYLOAD: objet JSON attendu.' using errcode = '22023';
  end if;

  -- 3. Verrou consultatif par tenant, graine 1104 : le MÊME que
  --    mutate_merchant_fulfillment_schedule et sa variante v1.2. Pris avant
  --    toute lecture de la configuration : deux éditions se sérialisent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1104));

  -- 4. FORME STRICTE : toute clé inconnue est refusée (une faute de frappe
  --    ne doit jamais être ignorée en silence), toute liste est obligatoire
  --    (« absent » ne veut pas dire « inchangé » -- il n'y a pas de delta).
  for v_k in select pg_catalog.jsonb_object_keys(p_payload) loop
    if v_k <> all(array['modeCode','fulfillmentRuleId','expectedUpdatedAt','expectedRevision','method',
                        'enabled','policy','windows','slots','closures','preparation','holidays','capacity']) then
      raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « % ».', pg_catalog.left(v_k, 40) using errcode = '22023';
    end if;
  end loop;
  v_pol := p_payload->'policy';
  if pg_catalog.jsonb_typeof(v_pol) is distinct from 'object' then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `policy` doit être un objet.' using errcode = '22023';
  end if;
  for v_k in select pg_catalog.jsonb_object_keys(v_pol) loop
    if v_k <> all(array['timezone','dateSelectionMode','slotSelectionMode','timeGranularityMinutes','leadTimeMinutes',
                        'minLeadDays','cutoffTime','cutoffOffsetDays','bookingHorizonDays']) then
      raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « policy.% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
    end if;
  end loop;
  foreach v_k in array array['windows','slots','closures'] loop
    if pg_catalog.jsonb_typeof(p_payload->v_k) is distinct from 'array' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `%` doit être un tableau (remplacement intégral : liste vide explicite si rien).', v_k using errcode = '22023';
    end if;
  end loop;
  v_windows  := p_payload->'windows';
  v_slots    := p_payload->'slots';
  v_closures := p_payload->'closures';
  if pg_catalog.jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `enabled` doit être un booléen.' using errcode = '22023';
  end if;
  v_enabled := (p_payload->>'enabled')::boolean;

  -- 5. Mode et règle de livraison : appartenance vérifiée dans la même
  --    requête (une règle d'un autre tenant ne peut pas correspondre).
  if pg_catalog.jsonb_typeof(p_payload->'modeCode') is distinct from 'string' then
    raise exception 'CSDJ1_UNKNOWN_MODE: mode de vente hors catalogue.' using errcode = '22023';
  end if;
  v_mode := p_payload->>'modeCode';
  if not exists (select 1 from public.sale_mode_catalog c where c.code = v_mode) then
    raise exception 'CSDJ1_UNKNOWN_MODE: mode de vente hors catalogue.' using errcode = '22023';
  end if;
  if p_payload ? 'fulfillmentRuleId' and pg_catalog.jsonb_typeof(p_payload->'fulfillmentRuleId') <> 'null' then
    if pg_catalog.jsonb_typeof(p_payload->'fulfillmentRuleId') <> 'string'
       or (p_payload->>'fulfillmentRuleId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `fulfillmentRuleId` doit être un UUID ou null.' using errcode = '22023';
    end if;
    v_rule := (p_payload->>'fulfillmentRuleId')::uuid;
    if v_rule = c_nil then
      raise exception 'CSDJ1_RESERVED_RULE_ID: le zéro UUID est réservé comme sentinelle interne.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.restaurant_sale_mode_fulfillments f
      where f.id = v_rule and f.restaurant_id = p_restaurant_id and f.mode_code = v_mode
    ) then
      raise exception 'CSDJ1_FOREIGN_RULE: règle de livraison inconnue pour cet établissement et ce mode.' using errcode = '42501';
    end if;
  end if;
  v_rule_key := coalesce(v_rule, c_nil);

  -- 6. Méthode, et sections qui n'appartiennent pas à cette méthode.
  if pg_catalog.jsonb_typeof(p_payload->'method') is distinct from 'string'
     or (p_payload->>'method') <> all(array['v1','v1.2']) then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `method` doit valoir « v1 » ou « v1.2 ».' using errcode = '22023';
  end if;
  v_method := p_payload->>'method';
  if v_method = 'v1' then
    if p_payload ? 'preparation' or p_payload ? 'holidays' or p_payload ? 'capacity' then
      raise exception 'CSDJBO1_METHOD_MISMATCH: une charge de méthode v1 ne porte ni `preparation`, ni `holidays`, ni `capacity`.'
        using errcode = '22023', detail = 'sections=preparation,holidays,capacity';
    end if;
    if not (v_pol ? 'cutoffOffsetDays') then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `policy.cutoffOffsetDays` est obligatoire en méthode v1.' using errcode = '22023';
    end if;
  else
    if v_pol ? 'cutoffOffsetDays'
       and (pg_catalog.jsonb_typeof(v_pol->'cutoffOffsetDays') <> 'number' or (v_pol->>'cutoffOffsetDays') <> '0') then
      raise exception 'CSDJBO1_METHOD_MISMATCH: un décalage d''heure limite non nul n''existe pas en méthode v1.2.'
        using errcode = '22023', detail = 'field=policy.cutoffOffsetDays';
    end if;
    foreach v_k in array array['preparation','holidays','capacity'] loop
      if pg_catalog.jsonb_typeof(p_payload->v_k) is distinct from 'object' then
        raise exception 'CSDJ1_INVALID_PAYLOAD: `%` est obligatoire (objet) en méthode v1.2.', v_k using errcode = '22023';
      end if;
    end loop;
  end if;

  -- 7. ANTI-CONCURRENCE. Sous le verrou, relu en READ COMMITTED : on voit
  --    tout ce qui a été validé avant nous.
  v_exp_txt := case when pg_catalog.jsonb_typeof(p_payload->'expectedUpdatedAt') = 'string'
                    then p_payload->>'expectedUpdatedAt' end;
  if p_payload ? 'expectedUpdatedAt' and pg_catalog.jsonb_typeof(p_payload->'expectedUpdatedAt') not in ('string','null') then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `expectedUpdatedAt` doit être une chaîne ou absent.' using errcode = '22023';
  end if;
  if v_exp_txt is not null then
    if v_exp_txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `expectedUpdatedAt` doit être un horodatage ISO 8601 UTC (« Z »), tel que rendu par le serveur.' using errcode = '22023';
    end if;
    begin
      v_exp_ts := v_exp_txt::timestamptz;
    exception when others then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `expectedUpdatedAt` illisible.' using errcode = '22023';
    end;
  end if;
  v_exp_rev := case when pg_catalog.jsonb_typeof(p_payload->'expectedRevision') = 'string'
                    then p_payload->>'expectedRevision' end;
  if p_payload ? 'expectedRevision' and pg_catalog.jsonb_typeof(p_payload->'expectedRevision') not in ('string','null') then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `expectedRevision` doit être une chaîne ou absent.' using errcode = '22023';
  end if;
  if v_exp_rev is not null and v_exp_rev !~ '^[0-9a-f]{32}$' then
    raise exception 'CSDJ1_INVALID_PAYLOAD: `expectedRevision` illisible.' using errcode = '22023';
  end if;

  select x.* into v_exist
  from public.restaurant_fulfillment_schedule x
  where x.restaurant_id = p_restaurant_id and x.mode_code = v_mode and x.rule_key = v_rule_key
  for update;
  v_found := found;

  if v_found then
    if v_exp_ts is null then
      raise exception 'CSDJBO1_STALE_CONFIGURATION: cette portée existe déjà ; relisez-la avant de l''enregistrer.'
        using errcode = '23505', detail = 'reason=expectedUpdatedAt_required';
    end if;
    if v_exp_ts is distinct from v_exist.updated_at then
      raise exception 'CSDJBO1_STALE_CONFIGURATION: la configuration a été modifiée depuis votre lecture.'
        using errcode = '23505', detail = 'reason=updated_at_changed';
    end if;
    if v_exp_rev is not null
       and v_exp_rev is distinct from (public.csdjbo1_persisted_configuration(p_restaurant_id, v_mode, v_rule_key)->>'revision') then
      raise exception 'CSDJBO1_STALE_CONFIGURATION: le contenu de la configuration a changé depuis votre lecture.'
        using errcode = '23505', detail = 'reason=revision_changed';
    end if;
  else
    if v_exp_ts is not null or v_exp_rev is not null then
      raise exception 'CSDJBO1_STALE_CONFIGURATION: cette portée n''existe plus ; relisez avant de l''enregistrer.'
        using errcode = '23505', detail = 'reason=scope_missing';
    end if;
  end if;

  -- 8. POLITIQUE : types, catalogues, bornes (miroir des contraintes de table,
  --    pour que chaque refus ait un NOM et jamais un message de contrainte).
  foreach v_k in array array['timezone','dateSelectionMode','slotSelectionMode','timeGranularityMinutes',
                             'leadTimeMinutes','minLeadDays','cutoffTime','bookingHorizonDays'] loop
    if not (v_pol ? v_k) then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `policy.%` est obligatoire (aucune valeur par défaut côté serveur).', v_k using errcode = '22023';
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(v_pol->'timezone') <> 'string' then
    raise exception 'CSDJ1_INVALID_TIMEZONE: fuseau IANA inconnu du serveur.' using errcode = '22023';
  end if;
  v_tz := v_pol->>'timezone';
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
    raise exception 'CSDJ1_INVALID_TIMEZONE: fuseau IANA inconnu du serveur.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_pol->'dateSelectionMode') <> 'string' or pg_catalog.jsonb_typeof(v_pol->'slotSelectionMode') <> 'string'
     or (v_pol->>'dateSelectionMode') <> all(public.checkout_date_selection_modes())
     or (v_pol->>'slotSelectionMode') <> all(public.checkout_slot_selection_modes()) then
    raise exception 'CSDJ1_INVALID_POLICY: politique hors catalogue.' using errcode = '22023';
  end if;
  v_date_mode := v_pol->>'dateSelectionMode';
  v_slot_mode := v_pol->>'slotSelectionMode';
  -- Cohérence des deux politiques (miroir de rfs_policy_coherent).
  if v_date_mode <> 'customer_selectable' and v_slot_mode <> 'none' then
    raise exception 'CSDJ1_INVALID_POLICY: sans choix de date par le client, aucun choix d''heure ou de créneau n''est possible.' using errcode = '22023';
  end if;
  foreach v_k in array array['leadTimeMinutes','minLeadDays','bookingHorizonDays'] loop
    if pg_catalog.jsonb_typeof(v_pol->v_k) <> 'number' or (v_pol->>v_k) !~ '^[0-9]{1,9}$' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `policy.%` doit être un entier positif ou nul.', v_k using errcode = '22023';
    end if;
  end loop;
  v_lead    := (v_pol->>'leadTimeMinutes')::integer;
  v_minlead := case when (v_pol->>'minLeadDays')::integer     <= 365 then (v_pol->>'minLeadDays')::smallint     end;
  v_horizon := case when (v_pol->>'bookingHorizonDays')::integer <= 365 then (v_pol->>'bookingHorizonDays')::smallint end;
  if v_lead > 100000 or v_minlead is null or v_horizon is null then
    raise exception 'CSDJ1_INVALID_PAYLOAD: délai ou horizon hors bornes.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_pol->'timeGranularityMinutes') = 'null' then
    v_gran := null;
  else
    if pg_catalog.jsonb_typeof(v_pol->'timeGranularityMinutes') <> 'number'
       or (v_pol->>'timeGranularityMinutes') !~ '^[0-9]{1,3}$'
       or (v_pol->>'timeGranularityMinutes')::integer not between 5 and 240 then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `policy.timeGranularityMinutes` doit valoir null ou 5 à 240.' using errcode = '22023';
    end if;
    v_gran := (v_pol->>'timeGranularityMinutes')::smallint;
  end if;
  if pg_catalog.jsonb_typeof(v_pol->'cutoffTime') = 'null' then
    v_cutoff := null;
  else
    if pg_catalog.jsonb_typeof(v_pol->'cutoffTime') <> 'string' or (v_pol->>'cutoffTime') !~ c_time_re then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `policy.cutoffTime` doit valoir null ou « HH:MM ».' using errcode = '22023';
    end if;
    v_cutoff := (v_pol->>'cutoffTime')::time;
    if v_cutoff is distinct from pg_catalog.date_trunc('minute', v_cutoff) then
      raise exception 'CSDJ1_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).' using errcode = '22023';
    end if;
  end if;
  if v_method = 'v1' then
    if pg_catalog.jsonb_typeof(v_pol->'cutoffOffsetDays') <> 'number' or (v_pol->>'cutoffOffsetDays') !~ '^[0-9]{1,2}$'
       or (v_pol->>'cutoffOffsetDays')::integer > 30 then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `policy.cutoffOffsetDays` doit valoir 0 à 30.' using errcode = '22023';
    end if;
    v_cut_off := (v_pol->>'cutoffOffsetDays')::smallint;
  else
    v_cut_off := 0;
  end if;
  -- Une grille de pas inconnu ne décrit rien. Brouillon : refus nommé tout de
  -- suite (la table ne peut pas stocker « heure libre » sans pas). Activation :
  -- le défaut rejoint la liste complète des bloqueurs (étape 11).
  if v_slot_mode = 'time_within_window' and v_gran is null and not v_enabled then
    raise exception 'CSDJBO1_INCOMPLETE_CONFIGURATION: la politique « heure libre » exige un pas de grille.'
      using errcode = '23514', detail = 'blockers=granularity_missing';
  end if;

  -- 9. LISTES : forme, types, bornes, doublons -- chaque défaut a un nom.
  if pg_catalog.jsonb_array_length(v_windows) > 100 or pg_catalog.jsonb_array_length(v_slots) > 200 then
    raise exception 'CSDJ1_INVALID_PAYLOAD: trop de fenêtres (100 au plus) ou de créneaux (200 au plus).' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_closures) > 731 then
    raise exception 'CSDJ12_TOO_MANY_CLOSURES: 731 fermetures au plus.' using errcode = '22023';
  end if;
  for v_item in select * from pg_catalog.jsonb_array_elements(v_windows) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: chaque fenêtre doit être un objet.' using errcode = '22023';
    end if;
    for v_k in select pg_catalog.jsonb_object_keys(v_item) loop
      if v_k <> all(array['weekday','startsAt','endsAt','displayOrder']) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « windows[].% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(v_item->'weekday') is distinct from 'number' or (v_item->>'weekday') !~ '^[0-6]$' then
      raise exception 'CSDJ12_INVALID_WEEKDAY: 0 (dimanche) à 6 (samedi).' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_item->'startsAt') is distinct from 'string' or (v_item->>'startsAt') !~ c_time_re
       or pg_catalog.jsonb_typeof(v_item->'endsAt') is distinct from 'string' or (v_item->>'endsAt') !~ c_time_re then
      raise exception 'CSDJ1_INVALID_PAYLOAD: heures de fenêtre invalides (« HH:MM »).' using errcode = '22023';
    end if;
    if (v_item->>'startsAt')::time is distinct from pg_catalog.date_trunc('minute', (v_item->>'startsAt')::time)
       or (v_item->>'endsAt')::time is distinct from pg_catalog.date_trunc('minute', (v_item->>'endsAt')::time) then
      raise exception 'CSDJ1_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).' using errcode = '22023';
    end if;
    if (v_item->>'endsAt')::time <= (v_item->>'startsAt')::time then
      raise exception 'CSDJ1_INVALID_PAYLOAD: une fenêtre doit finir après son début.' using errcode = '22023';
    end if;
    if v_item ? 'displayOrder' and (pg_catalog.jsonb_typeof(v_item->'displayOrder') <> 'number'
       or (v_item->>'displayOrder') !~ '^[0-9]{1,4}$') then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `displayOrder` invalide.' using errcode = '22023';
    end if;
  end loop;
  for v_item in select * from pg_catalog.jsonb_array_elements(v_slots) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: chaque créneau doit être un objet.' using errcode = '22023';
    end if;
    for v_k in select pg_catalog.jsonb_object_keys(v_item) loop
      if v_k <> all(array['weekday','slotKey','startsAt','endsAt','displayOrder']) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « slots[].% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(v_item->'weekday') is distinct from 'number' or (v_item->>'weekday') !~ '^[0-6]$' then
      raise exception 'CSDJ12_INVALID_WEEKDAY: 0 (dimanche) à 6 (samedi).' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_item->'slotKey') is distinct from 'string' or (v_item->>'slotKey') !~ '^[a-z0-9_-]{1,40}$' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `slotKey` invalide (a-z, 0-9, _ et -, 1 à 40 caractères).' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_item->'startsAt') is distinct from 'string' or (v_item->>'startsAt') !~ c_time_re
       or pg_catalog.jsonb_typeof(v_item->'endsAt') is distinct from 'string' or (v_item->>'endsAt') !~ c_time_re then
      raise exception 'CSDJ1_INVALID_PAYLOAD: heures de créneau invalides (« HH:MM »).' using errcode = '22023';
    end if;
    if (v_item->>'startsAt')::time is distinct from pg_catalog.date_trunc('minute', (v_item->>'startsAt')::time)
       or (v_item->>'endsAt')::time is distinct from pg_catalog.date_trunc('minute', (v_item->>'endsAt')::time) then
      raise exception 'CSDJ1_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).' using errcode = '22023';
    end if;
    if (v_item->>'endsAt')::time <= (v_item->>'startsAt')::time then
      raise exception 'CSDJ1_INVALID_PAYLOAD: un créneau doit finir après son début.' using errcode = '22023';
    end if;
    if v_item ? 'displayOrder' and (pg_catalog.jsonb_typeof(v_item->'displayOrder') <> 'number'
       or (v_item->>'displayOrder') !~ '^[0-9]{1,4}$') then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `displayOrder` invalide.' using errcode = '22023';
    end if;
  end loop;
  -- Doublons de créneau (jour, clé) : la clé primaire les refuserait en brut.
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_slots) e
             group by e->>'weekday', e->>'slotKey' having pg_catalog.count(*) > 1) then
    raise exception 'CSDJ1_INVALID_PAYLOAD: deux créneaux portent la même clé le même jour.' using errcode = '22023';
  end if;
  -- NON-SUPERPOSITION des fenêtres d'un même jour : contre le MAXIMUM des fins
  -- déjà vues. Même verdict que le mutateur existant (trié par début, la
  -- comparaison à la fenêtre précédente suffit déjà) ; le maximum glissant le
  -- rend évident à relire. Le contact (fin = début) reste permis.
  if exists (
    select 1 from (
      select (e->>'startsAt')::time as s,
             pg_catalog.max((e->>'endsAt')::time) over (
               partition by (e->>'weekday')::smallint
               order by (e->>'startsAt')::time, (e->>'endsAt')::time
               rows between unbounded preceding and 1 preceding) as prev_max_end
      from pg_catalog.jsonb_array_elements(v_windows) e) q
    where q.prev_max_end > q.s
  ) then
    raise exception 'CSDJ1_WINDOW_OVERLAP: deux fenêtres du même jour se superposent.' using errcode = '23514';
  end if;
  -- Fermetures (disponibilité).
  for v_item in select * from pg_catalog.jsonb_array_elements(v_closures) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: chaque fermeture doit être un objet.' using errcode = '22023';
    end if;
    for v_k in select pg_catalog.jsonb_object_keys(v_item) loop
      if v_k <> all(array['closedOn','label']) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « closures[].% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(v_item->'closedOn') is distinct from 'string' or (v_item->>'closedOn') !~ c_date_re then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `closedOn` doit être une date « AAAA-MM-JJ ».' using errcode = '22023';
    end if;
    begin
      perform (v_item->>'closedOn')::date;
    exception when others then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `closedOn` n''est pas une date valide.' using errcode = '22023';
    end;
    if v_item ? 'label' and pg_catalog.jsonb_typeof(v_item->'label') not in ('string','null') then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `label` doit être une chaîne ou null.' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_item->'label') = 'string' and pg_catalog.length(pg_catalog.btrim(v_item->>'label')) > 120 then
      raise exception 'CSDJ1_INVALID_PAYLOAD: libellé de fermeture trop long (120 au plus).' using errcode = '22023';
    end if;
  end loop;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_closures) e
             group by (e->>'closedOn')::date having pg_catalog.count(*) > 1) then
    raise exception 'CSDJ1_INVALID_PAYLOAD: deux fermetures portent la même date.' using errcode = '22023';
  end if;

  -- 10. SECTIONS v1.2 : préparation, fériés, capacité.
  v_cap_on := false;
  v_cap_max := null;
  v_prep_days := '[]'::jsonb;
  v_prep_clos := '[]'::jsonb;
  if v_method = 'v1.2' then
    v_prep := p_payload->'preparation';
    for v_k in select pg_catalog.jsonb_object_keys(v_prep) loop
      if v_k <> all(array['weekdays','closures']) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « preparation.% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(v_prep->'weekdays') is distinct from 'array'
       or pg_catalog.jsonb_typeof(v_prep->'closures') is distinct from 'array' then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `preparation.weekdays` et `preparation.closures` doivent être des tableaux.' using errcode = '22023';
    end if;
    v_prep_days := v_prep->'weekdays';
    v_prep_clos := v_prep->'closures';
    if pg_catalog.jsonb_array_length(v_prep_days) > 7 then
      raise exception 'CSDJ12_INVALID_WEEKDAY: 0 (dimanche) à 6 (samedi).' using errcode = '22023';
    end if;
    for v_item in select * from pg_catalog.jsonb_array_elements(v_prep_days) loop
      if pg_catalog.jsonb_typeof(v_item) <> 'number' or (v_item #>> '{}') !~ '^[0-6]$' then
        raise exception 'CSDJ12_INVALID_WEEKDAY: 0 (dimanche) à 6 (samedi).' using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_array_length(v_prep_clos) > 731 then
      raise exception 'CSDJ12_TOO_MANY_CLOSURES: 731 fermetures au plus.' using errcode = '22023';
    end if;
    for v_item in select * from pg_catalog.jsonb_array_elements(v_prep_clos) loop
      if pg_catalog.jsonb_typeof(v_item) <> 'object' then
        raise exception 'CSDJ1_INVALID_PAYLOAD: chaque fermeture de préparation doit être un objet.' using errcode = '22023';
      end if;
      for v_k in select pg_catalog.jsonb_object_keys(v_item) loop
        if v_k <> all(array['closedOn','label']) then
          raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « preparation.closures[].% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
        end if;
      end loop;
      if pg_catalog.jsonb_typeof(v_item->'closedOn') is distinct from 'string' or (v_item->>'closedOn') !~ c_date_re then
        raise exception 'CSDJ1_INVALID_PAYLOAD: `closedOn` doit être une date « AAAA-MM-JJ ».' using errcode = '22023';
      end if;
      begin
        perform (v_item->>'closedOn')::date;
      exception when others then
        raise exception 'CSDJ1_INVALID_PAYLOAD: `closedOn` n''est pas une date valide.' using errcode = '22023';
      end;
      if v_item ? 'label' and pg_catalog.jsonb_typeof(v_item->'label') not in ('string','null') then
        raise exception 'CSDJ1_INVALID_PAYLOAD: `label` doit être une chaîne ou null.' using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(v_item->'label') = 'string' and pg_catalog.length(pg_catalog.btrim(v_item->>'label')) > 120 then
        raise exception 'CSDJ1_INVALID_PAYLOAD: libellé de fermeture trop long (120 au plus).' using errcode = '22023';
      end if;
    end loop;
    if exists (select 1 from pg_catalog.jsonb_array_elements(v_prep_clos) e
               group by (e->>'closedOn')::date having pg_catalog.count(*) > 1) then
      raise exception 'CSDJ1_INVALID_PAYLOAD: deux fermetures de préparation portent la même date.' using errcode = '22023';
    end if;

    v_hol := p_payload->'holidays';
    for v_k in select pg_catalog.jsonb_object_keys(v_hol) loop
      if v_k <> all(array['calendarId','preparationOnHolidays','availabilityOnHolidays']) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « holidays.% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    foreach v_k in array array['calendarId','preparationOnHolidays','availabilityOnHolidays'] loop
      if not (v_hol ? v_k) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: `holidays.%` est obligatoire.', v_k using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(v_hol->'calendarId') <> 'null' then
      if pg_catalog.jsonb_typeof(v_hol->'calendarId') <> 'string'
         or (v_hol->>'calendarId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'CSDJ12_UNKNOWN_CALENDAR: calendrier férié inconnu.' using errcode = '22023';
      end if;
      v_cal := (v_hol->>'calendarId')::uuid;
      if not exists (select 1 from public.public_holiday_calendar c where c.id = v_cal) then
        raise exception 'CSDJ12_UNKNOWN_CALENDAR: calendrier férié inconnu.' using errcode = '22023';
      end if;
    end if;
    if pg_catalog.jsonb_typeof(v_hol->'preparationOnHolidays') <> 'string' or pg_catalog.jsonb_typeof(v_hol->'availabilityOnHolidays') <> 'string'
       or (v_hol->>'preparationOnHolidays') <> all(array['open','closed'])
       or (v_hol->>'availabilityOnHolidays') <> all(array['open','closed']) then
      raise exception 'CSDJ12_INVALID_HOLIDAY_POLICY: « open » ou « closed » attendu.' using errcode = '22023';
    end if;
    v_prep_h := v_hol->>'preparationOnHolidays';
    v_avail_h := v_hol->>'availabilityOnHolidays';
    if v_cal is null and (v_prep_h = 'closed' or v_avail_h = 'closed') then
      raise exception 'CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR: une politique « closed » exige un calendrier férié.' using errcode = '22023';
    end if;

    v_cap := p_payload->'capacity';
    for v_k in select pg_catalog.jsonb_object_keys(v_cap) loop
      if v_k <> all(array['enabled','maxOrders']) then
        raise exception 'CSDJ1_INVALID_PAYLOAD: clé inconnue « capacity.% ».', pg_catalog.left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_typeof(v_cap->'enabled') is distinct from 'boolean' or not (v_cap ? 'maxOrders') then
      raise exception 'CSDJ1_INVALID_PAYLOAD: `capacity.enabled` (booléen) et `capacity.maxOrders` (entier ou null) sont obligatoires.' using errcode = '22023';
    end if;
    v_cap_on := (v_cap->>'enabled')::boolean;
    if pg_catalog.jsonb_typeof(v_cap->'maxOrders') = 'null' then
      v_cap_max := null;
    else
      if pg_catalog.jsonb_typeof(v_cap->'maxOrders') <> 'number' or (v_cap->>'maxOrders') !~ '^-?[0-9]{1,9}$'
         or (v_cap->>'maxOrders')::integer not between 1 and 1000000 then
        raise exception 'CSDJ12_INVALID_CAPACITY: le maximum doit être un entier de 1 à 1 000 000 (ou null).' using errcode = '22023';
      end if;
      v_cap_max := (v_cap->>'maxOrders')::integer;
    end if;
  end if;

  -- 11. COMPLÉTUDE AVANT ACTIVATION. « enabled : true » est VALIDÉ, pas
  --     déclaré : il est refusé -- dans cette transaction, avec un nom -- si
  --     la configuration RÉSULTANTE ne peut pas proposer de date. Les cinq
  --     conditions sont celles de publishBlockersOf (lib/availability-editor.ts).
  if v_enabled then
    if v_date_mode <> 'informational_only' then
      if v_slot_mode = 'fixed_slots' then
        if pg_catalog.jsonb_array_length(v_slots) = 0 then v_blockers := pg_catalog.array_append(v_blockers, 'offer_missing'::text); end if;
      elsif pg_catalog.jsonb_array_length(v_windows) = 0 then
        v_blockers := pg_catalog.array_append(v_blockers, 'offer_missing'::text);
      end if;
    end if;
    if v_slot_mode = 'time_within_window' and v_gran is null then
      v_blockers := pg_catalog.array_append(v_blockers, 'granularity_missing'::text);
    end if;
    if v_method = 'v1.2' and pg_catalog.jsonb_array_length(v_prep_days) = 0 then
      v_blockers := pg_catalog.array_append(v_blockers, 'preparation_missing'::text);
    end if;
    if v_cap_on then
      if v_cap_max is null or v_cap_max < 1 then v_blockers := pg_catalog.array_append(v_blockers, 'capacity_incomplete'::text); end if;
      if v_date_mode = 'informational_only' then v_blockers := pg_catalog.array_append(v_blockers, 'capacity_needs_date'::text); end if;
    end if;
    if pg_catalog.cardinality(v_blockers) > 0 then
      raise exception 'CSDJBO1_INCOMPLETE_CONFIGURATION: configuration incomplète, activation refusée.'
        using errcode = '23514', detail = 'blockers=' || pg_catalog.array_to_string(v_blockers, ',');
    end if;
  else
    -- Brouillon : il peut être incomplet, jamais incohérent (la table
    -- refuserait une capacité active sans maximum ou sans date).
    if v_cap_on and (v_cap_max is null or v_cap_max < 1) then
      raise exception 'CSDJ12_INVALID_CAPACITY: capacité activée => maximum strictement positif requis.' using errcode = '22023';
    end if;
    if v_cap_on and v_date_mode = 'informational_only' then
      raise exception 'CSDJ12_CAPACITY_NEEDS_DATE: la capacité exige une politique de date choisie ou dérivée.' using errcode = '22023';
    end if;
  end if;

  -- 12. ÉCRITURE -- à partir d'ici plus aucun refus de validation : tout a été
  --     jugé. Toute erreur restante (panne, contrainte) annule la
  --     transaction ENTIÈRE.
  --     Jeton strictement croissant : jamais deux états sous le même jeton.
  v_new_upd := greatest(pg_catalog.clock_timestamp(),
                        coalesce(v_exist.updated_at, '-infinity'::timestamptz) + interval '1 microsecond');

  insert into public.restaurant_fulfillment_schedule as t (
    restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
    date_selection_mode, slot_selection_mode, time_granularity_minutes,
    lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days,
    booking_horizon_days, schedule_method_version,
    holiday_calendar_id, preparation_on_holidays, availability_on_holidays,
    capacity_enabled, capacity_max_orders, updated_at)
  values (
    p_restaurant_id, v_mode, v_rule, v_tz, v_enabled,
    v_date_mode, v_slot_mode, v_gran,
    v_lead, v_minlead, v_cutoff, v_cut_off,
    v_horizon, v_method,
    v_cal, coalesce(v_prep_h, 'open'), coalesce(v_avail_h, 'open'),
    v_cap_on, v_cap_max, v_new_upd)
  on conflict (restaurant_id, mode_code, rule_key) do update set
    timezone = excluded.timezone,
    enabled = excluded.enabled,
    date_selection_mode = excluded.date_selection_mode,
    slot_selection_mode = excluded.slot_selection_mode,
    time_granularity_minutes = excluded.time_granularity_minutes,
    lead_time_minutes = excluded.lead_time_minutes,
    min_lead_days = excluded.min_lead_days,
    cutoff_time = excluded.cutoff_time,
    cutoff_offset_days = excluded.cutoff_offset_days,
    booking_horizon_days = excluded.booking_horizon_days,
    schedule_method_version = excluded.schedule_method_version,
    holiday_calendar_id = excluded.holiday_calendar_id,
    preparation_on_holidays = excluded.preparation_on_holidays,
    availability_on_holidays = excluded.availability_on_holidays,
    capacity_enabled = excluded.capacity_enabled,
    capacity_max_orders = excluded.capacity_max_orders,
    updated_at = excluded.updated_at;

  delete from public.restaurant_fulfillment_schedule_window w
  where w.restaurant_id = p_restaurant_id and w.mode_code = v_mode and w.rule_key = v_rule_key;
  insert into public.restaurant_fulfillment_schedule_window
    (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at, display_order)
  select p_restaurant_id, v_mode, v_rule_key,
         (e->>'weekday')::smallint, (e->>'startsAt')::time, (e->>'endsAt')::time,
         coalesce((e->>'displayOrder')::smallint, 0::smallint)
  from pg_catalog.jsonb_array_elements(v_windows) e;

  delete from public.restaurant_fulfillment_schedule_slot x
  where x.restaurant_id = p_restaurant_id and x.mode_code = v_mode and x.rule_key = v_rule_key;
  insert into public.restaurant_fulfillment_schedule_slot
    (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at, display_order)
  select p_restaurant_id, v_mode, v_rule_key,
         (e->>'weekday')::smallint, e->>'slotKey', (e->>'startsAt')::time, (e->>'endsAt')::time,
         coalesce((e->>'displayOrder')::smallint, 0::smallint)
  from pg_catalog.jsonb_array_elements(v_slots) e;

  delete from public.restaurant_fulfillment_schedule_closure c
  where c.restaurant_id = p_restaurant_id and c.mode_code = v_mode and c.rule_key = v_rule_key;
  insert into public.restaurant_fulfillment_schedule_closure
    (restaurant_id, mode_code, rule_key, closed_on, label)
  select p_restaurant_id, v_mode, v_rule_key,
         (e->>'closedOn')::date, nullif(pg_catalog.btrim(coalesce(e->>'label', '')), '')
  from pg_catalog.jsonb_array_elements(v_closures) e;

  -- Préparation : vidée à chaque écriture ; réécrite en v1.2 seulement.
  delete from public.restaurant_fulfillment_prep_day d
  where d.restaurant_id = p_restaurant_id and d.mode_code = v_mode and d.rule_key = v_rule_key;
  delete from public.restaurant_fulfillment_prep_closure c
  where c.restaurant_id = p_restaurant_id and c.mode_code = v_mode and c.rule_key = v_rule_key;
  if v_method = 'v1.2' then
    insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday)
    select distinct p_restaurant_id, v_mode, v_rule_key, (e #>> '{}')::smallint
    from pg_catalog.jsonb_array_elements(v_prep_days) e;
    insert into public.restaurant_fulfillment_prep_closure (restaurant_id, mode_code, rule_key, closed_on, label)
    select p_restaurant_id, v_mode, v_rule_key,
           (e->>'closedOn')::date, nullif(pg_catalog.btrim(coalesce(e->>'label', '')), '')
    from pg_catalog.jsonb_array_elements(v_prep_clos) e;
  end if;

  -- 13. La configuration RELUE, dans la même transaction.
  v_result := public.csdjbo1_persisted_configuration(p_restaurant_id, v_mode, v_rule_key);
  if v_result is null then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: la configuration écrite est introuvable à la relecture.' using errcode = 'XX000';
  end if;
  return v_result;
end
$csdjbo1_save$;

comment on function public.save_fulfillment_configuration(uuid,jsonb) is
  'CSDJ-BO-1 — SEULE écriture de la configuration complète d''une portée : politique, fenêtres, créneaux, fermetures, préparation, fériés, capacité, activation, en UNE transaction (remplacement intégral). owner/manager uniquement, verrou de tenant 1104, READ COMMITTED exigé. Refus nommés : CSDJBO1_INCOMPLETE_CONFIGURATION, CSDJBO1_STALE_CONFIGURATION, CSDJBO1_METHOD_MISMATCH et les refus CSDJ1_*/CSDJ12_* existants. Renvoie la configuration relue, sans compte de capacité.';

-- ============================================================
-- §D  LECTURE : get_fulfillment_configuration
-- ============================================================
create function public.get_fulfillment_configuration(
  p_restaurant_id        uuid,
  p_mode_code            text,
  p_fulfillment_rule_id  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $csdjbo1_get$
declare
  c_nil constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if auth.uid() is null then
    raise exception 'CSDJ1_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  -- Mêmes droits de LECTURE que get_merchant_fulfillment_schedules.
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception 'CSDJ1_FORBIDDEN: accès refusé à cet établissement.' using errcode = '42501';
  end if;
  if p_mode_code is null or not exists (select 1 from public.sale_mode_catalog c where c.code = p_mode_code) then
    raise exception 'CSDJ1_UNKNOWN_MODE: mode de vente hors catalogue.' using errcode = '22023';
  end if;
  if p_fulfillment_rule_id is not null then
    if p_fulfillment_rule_id = c_nil then
      raise exception 'CSDJ1_RESERVED_RULE_ID: le zéro UUID est réservé comme sentinelle interne.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.restaurant_sale_mode_fulfillments f
      where f.id = p_fulfillment_rule_id and f.restaurant_id = p_restaurant_id and f.mode_code = p_mode_code
    ) then
      raise exception 'CSDJ1_FOREIGN_RULE: règle de livraison inconnue pour cet établissement et ce mode.' using errcode = '42501';
    end if;
  end if;
  -- NULL (JSON null) = aucune configuration pour cette portée.
  return public.csdjbo1_persisted_configuration(p_restaurant_id, p_mode_code, coalesce(p_fulfillment_rule_id, c_nil));
end
$csdjbo1_get$;

comment on function public.get_fulfillment_configuration(uuid,text,uuid) is
  'CSDJ-BO-1 — lecture de la configuration complète d''UNE portée (même forme que la réponse de save_fulfillment_configuration, avec updatedAt et revision pour l''anti-concurrence). NULL si la portée n''a pas de configuration. Membres de l''établissement et opérateurs Scanym en lecture ; aucun compte de capacité.';

-- ============================================================
-- §E  ACL — tout fermé, puis les deux seules ouvertures
-- ============================================================
revoke all on function public.csdjbo1_persisted_configuration(uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_fulfillment_configuration(uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_fulfillment_configuration(uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_fulfillment_configuration(uuid,jsonb) to authenticated;
grant execute on function public.get_fulfillment_configuration(uuid,text,uuid) to authenticated;

-- ============================================================
-- §Z  POST-VOL — DANS la transaction, avant le COMMIT
-- ============================================================
do $csdjbo1_postflight$
declare
  v_n        integer;
  v_t        text;
  v_role     text;
  v_owner    text;
  v_surface  text;
  v_data     text;
  v_grantees text;
begin
  -- Z.1 Une seule surcharge chacune, propriétaire = celui de l'autorité existante,
  --     SECURITY DEFINER, search_path vide.
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'mutate_merchant_fulfillment_schedule';
  foreach v_t in array array['save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration'] loop
    select pg_catalog.count(*) into v_n
    from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = v_t;
    if v_n <> 1 then
      raise exception 'SCANYM_CSDJBO1_POSTCHECK: public.% a % surcharge(s) au lieu d''une.', v_t, v_n;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p
                   where p.pronamespace = 'public'::regnamespace and p.proname = v_t
                     and p.prosecdef
                     and pg_catalog.pg_get_userbyid(p.proowner) = v_owner
                     and p.proconfig = array['search_path=""']) then
      raise exception 'SCANYM_CSDJBO1_POSTCHECK: public.% n''est pas SECURITY DEFINER / search_path vide / propriétaire % .', v_t, v_owner;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
                 and p.proname = 'save_fulfillment_configuration' and p.provolatile = 'v' and p.prorettype = 'jsonb'::regtype) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: save_fulfillment_configuration doit être VOLATILE et rendre jsonb.';
  end if;

  -- Z.2 ACL EXACTE : propriétaire + authenticated pour les deux RPC ; propriétaire
  --     seul pour le constructeur ; AUCUN autre bénéficiaire (PUBLIC compris).
  foreach v_t in array array[
    'public.save_fulfillment_configuration(uuid,jsonb)',
    'public.get_fulfillment_configuration(uuid,text,uuid)',
    'public.csdjbo1_persisted_configuration(uuid,text,uuid)'] loop
    select coalesce(pg_catalog.string_agg(distinct
             case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end, ',' order by
             case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end), '')
      into v_grantees
    from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = pg_catalog.to_regprocedure(v_t) and a.privilege_type = 'EXECUTE';
    if v_t like '%csdjbo1_persisted%' then
      if v_grantees <> v_owner then
        raise exception 'SCANYM_CSDJBO1_POSTCHECK: le constructeur interne a des bénéficiaires inattendus (%).', v_grantees;
      end if;
    elsif v_grantees <> (select pg_catalog.string_agg(x, ',' order by x) from (values (v_owner), ('authenticated')) q(x)) then
      raise exception 'SCANYM_CSDJBO1_POSTCHECK: % a pour bénéficiaires « % » au lieu de « % + authenticated ».', v_t, v_grantees, v_owner;
    end if;
    foreach v_role in array array['anon','service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_t, 'EXECUTE') then
        raise exception 'SCANYM_CSDJBO1_POSTCHECK: % peut exécuter %.', v_role, v_t;
      end if;
    end loop;
    if v_t like '%csdjbo1_persisted%' and pg_catalog.has_function_privilege('authenticated', v_t, 'EXECUTE') then
      raise exception 'SCANYM_CSDJBO1_POSTCHECK: authenticated peut exécuter le constructeur interne.';
    end if;
    if v_t not like '%csdjbo1_persisted%' and not pg_catalog.has_function_privilege('authenticated', v_t, 'EXECUTE') then
      raise exception 'SCANYM_CSDJBO1_POSTCHECK: authenticated devrait pouvoir exécuter %.', v_t;
    end if;
  end loop;

  -- Z.3 SURFACE EXISTANTE INCHANGÉE D'UN OCTET : fonctions (hors les trois du
  --     lot), structure, contenu des tables de configuration.
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
           p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|'
           || pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
           || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-') || '|'
           || pg_catalog.pg_get_function_result(p.oid),
           E'\n' order by p.oid::regprocedure::text), ''))
    into v_surface
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname not in ('save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration');
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.pre_functions', true) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: une fonction EXISTANTE a changé (corps, ACL, propriétaire ou signature).';
  end if;

  select pg_catalog.md5(
           coalesce((select pg_catalog.string_agg(table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '-'), E'\n' order by table_name, column_name)
                     from information_schema.columns where table_schema = 'public'), '')
        || coalesce((select pg_catalog.string_agg(conrelid::regclass::text || '|' || conname || '|' || pg_catalog.pg_get_constraintdef(oid), E'\n' order by conrelid::regclass::text, conname)
                     from pg_catalog.pg_constraint where connamespace = 'public'::regnamespace), '')
        || coalesce((select pg_catalog.string_agg(tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '-') || '|' || coalesce(with_check, '-'), E'\n' order by tablename, policyname)
                     from pg_catalog.pg_policies where schemaname = 'public'), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid), E'\n' order by c.relname, t.tgname)
                     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
                     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || coalesce(c.relacl::text, '-') || '|' || c.relrowsecurity::text, E'\n' order by c.relname)
                     from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'), ''))
    into v_surface;
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.pre_structure', true) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: la structure existante (colonnes, contraintes, politiques, déclencheurs, droits de table) a changé.';
  end if;

  v_data := '';
  foreach v_t in array array[
    'restaurant_fulfillment_schedule','restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot','restaurant_fulfillment_schedule_closure',
    'restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure',
    'public_holiday_calendar','public_holiday_calendar_day',
    'order_fulfillment_capacity_reservation'] loop
    execute pg_catalog.format(
      'select pg_catalog.md5(coalesce(pg_catalog.string_agg(x::text, E''\n'' order by x::text), '''')) from public.%I x', v_t)
      into v_surface;
    v_data := v_data || v_t || '=' || v_surface || ';';
  end loop;
  if pg_catalog.md5(v_data) is distinct from pg_catalog.current_setting('scanym.csdjbo1.pre_data', true) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: ce lot ne doit insérer, modifier ni supprimer AUCUNE ligne de configuration.';
  end if;
end
$csdjbo1_postflight$;

commit;

-- ============================================================
-- IDEMPOTENCE : non ré-exécutable (voir A.5). Retour arrière :
-- supabase/DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1-rollback.sql
-- ============================================================
