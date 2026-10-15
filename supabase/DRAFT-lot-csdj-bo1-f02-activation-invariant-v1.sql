-- ============================================================
-- Scanym — CSDJ-BO-1 — REMÉDIATION F-02 : INVARIANT D'ACTIVATION (v1)
-- Fichier  : supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1.sql
-- Statut   : DRAFT — NON APPLIQUÉ. Aucun SQL hébergé, aucun déploiement
--            sans GO CIO/CTO et re-audit indépendant (Cat Greco, #150).
-- Mandat   : DIRAC → BOULEZ, remédiation F-02 (PR #151, commentaire CTO).
-- Parent   : PR #151, de4600567bcd2be3e3faf7f3bfd44ee7e69a5e2c (inchangé).
--
-- LE DÉFAUT (F-02, HIGH)
--   mutate_merchant_fulfillment_schedule[_v12] restent exécutables par
--   `authenticated` et activent (`enabled:true`) une portée SANS créneau ni jour
--   de préparation. La nouvelle RPC refuse cette configuration ; le mutateur
--   historique non : « la nouvelle interface ne l'appelle pas » n'est pas une
--   frontière de sécurité.
--
-- LA FERMETURE : un INVARIANT SUR LES TABLES, pas sur les appelants
--   Une portée ACTIVE doit pouvoir proposer une date. La règle est vérifiée à la
--   FRONTIÈRE D'AUTORITÉ COMMUNE -- les tables elles-mêmes -- par des
--   déclencheurs de contrainte DIFFÉRÉS (évalués au COMMIT, sur l'état FINAL de la
--   transaction) :
--     - toute écriture qui laisserait une portée active incomplète est REFUSÉE et
--       la transaction ENTIÈRE est annulée (aucune mutation partielle) ;
--     - quel que soit l'écrivain : mutateur historique v1 ou v1.2, nouvelle RPC,
--       service_role, SQL direct d'un rôle propriétaire ;
--     - les conditions sont celles de publishBlockersOf et de l'étape 11 de
--       save_fulfillment_configuration (offer_missing, granularity_missing,
--       preparation_missing, capacity_incomplete, capacity_needs_date), même code
--       de refus : CSDJBO1_INCOMPLETE_CONFIGURATION (SQLSTATE 23514).
--
-- POURQUOI PAS UNE RÉVOCATION D'EXECUTE
--   Révoquer EXECUTE sur mutate_merchant_fulfillment_schedule retirerait aussi
--   l'action `delete_schedule`, qui n'a pas d'autre porte : la suppression d'une
--   portée par un commerçant disparaîtrait. Une révocation sélective exigerait
--   d'abord une RPC de suppression dédiée, la migration de tous les appelants
--   (inconnus : clients PostgREST externes) et une modification des fonctions
--   auditées. L'invariant ne casse aucun appelant, préserve `delete_schedule`
--   (supprimer une portée n'est jamais une activation incomplète) et ne modifie
--   AUCUNE fonction, AUCUNE table, AUCUNE donnée existante.
--
-- CE QUE FAIT CE FICHIER (et rien d'autre)
--   - 2 fonctions internes : public.csdjbo1_f02_scope_blockers(uuid,text,uuid) et
--     public.csdjbo1_f02_enforce() (SECURITY DEFINER, search_path vide, fermées à
--     tous les rôles applicatifs) ;
--   - 4 déclencheurs de contrainte différés, nommés csdjbo1_f02_activation_invariant,
--     sur restaurant_fulfillment_schedule (INSERT/UPDATE) et sur
--     restaurant_fulfillment_schedule_window / _slot / restaurant_fulfillment_prep_day
--     (UPDATE/DELETE : seuls événements qui peuvent RETIRER une offre) ;
--   - verrou consultatif de tenant, graine 1104, pris AU MOMENT DU CONTRÔLE : le
--     même que les mutateurs historiques (réentrant pour eux) ; il sérialise aussi
--     les écrivains qui ne le prennent pas, ce qui ferme l'écart « deux écritures
--     concurrentes, chacune valide seule ».
--   - Aucune table, colonne, contrainte, politique, droit de table ni donnée n'est
--     modifié. Les fonctions existantes ne changent pas d'un octet (post-vol).
--
-- PORTÉES DÉJÀ ACTIVES ET INCOMPLÈTES (données historiques)
--   Ce lot n'écrit AUCUNE donnée : il ne corrige pas ce qui existe. Une portée
--   déjà active et incomplète est SIGNALÉE (WARNING, avec son compte) et reste
--   telle quelle jusqu'à sa prochaine écriture : toute écriture qui la touche
--   exigera alors qu'elle soit complète ou désactivée. Pour exiger une base
--   propre AVANT application :   set scanym.csdjbo1.f02_require_clean = on;
--   (le pré-vol refuse alors, avec la liste). Requête de recensement en lecture
--   seule : voir docs/scheduling/csdj-bo1-f02-activation-invariant.md.
--
-- LIMITES (voir le document, §Limites)
--   - TRUNCATE ne déclenche pas de déclencheur de contrainte : réservé au
--     propriétaire (aucun droit de table pour un rôle applicatif -- prouvé) ;
--   - session_replication_role = replica, DISABLE TRIGGER, DROP TRIGGER : réservés
--     au propriétaire/superutilisateur ;
--   - hors READ COMMITTED (REPEATABLE READ/SERIALIZABLE), un écrivain qui ne prend
--     pas le verrou raisonne sur un instantané ancien : les mutateurs et la RPC
--     l'excluent déjà (ou échouent en sérialisation), un SQL direct non.
--
-- IDEMPOTENCE : NON ré-exécutable, volontairement (pré-vol : refus dès qu'un
-- objet du lot existe). Retour arrière :
--   supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1-rollback.sql
-- ============================================================

begin;

-- ============================================================
-- §A  PRÉ-VOL — refus nommés, avant toute création
-- ============================================================
do $csdjbo1_f02_preflight$
declare
  c_trg      constant text := 'csdjbo1_f02_activation_invariant';
  v_n        integer;
  v_t        text;
  v_owner    text;
  v_surface  text;
  v_data     text;
  v_viol     text;
begin
  -- A.1 Exécutant = propriétaire de l'autorité d'écriture existante.
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'mutate_merchant_fulfillment_schedule';
  if v_owner is null then
    raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: mutate_merchant_fulfillment_schedule absente -- CSDJ-1 n''est pas appliqué.' using errcode = '55000';
  end if;
  if v_owner is distinct from current_user then
    raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: exécutant % différent du propriétaire % de l''autorité d''écriture existante.', current_user, v_owner using errcode = '42501';
  end if;

  -- A.2 CSDJ-1 et CSDJ v1.2 présents (ce fichier n'applique ni l'un ni l'autre).
  foreach v_t in array array[
    'restaurant_fulfillment_schedule','restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot','restaurant_fulfillment_schedule_closure',
    'restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure',
    'public_holiday_calendar','public_holiday_calendar_day',
    'order_fulfillment_capacity_reservation'] loop
    if pg_catalog.to_regclass('public.' || v_t) is null then
      raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: table % absente -- CSDJ-1 / CSDJ v1.2 n''est pas appliqué.', v_t using errcode = '55000';
    end if;
  end loop;
  foreach v_t in array array['capacity_enabled','capacity_max_orders','schedule_method_version',
                             'date_selection_mode','slot_selection_mode','time_granularity_minutes','enabled','rule_key'] loop
    if not exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = 'public.restaurant_fulfillment_schedule'::regclass
                     and a.attname = v_t and a.attnum > 0 and not a.attisdropped) then
      raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: colonne % absente -- l''état attendu de CSDJ-1/v1.2 n''est pas là.', v_t using errcode = '55000';
    end if;
  end loop;
  if pg_catalog.to_regprocedure('public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)') is null
     or pg_catalog.to_regprocedure('public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)') is null then
    raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: les mutateurs historiques sont absents.' using errcode = '55000';
  end if;

  -- A.3 Aucun objet du lot n'existe déjà.
  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('csdjbo1_f02_scope_blockers','csdjbo1_f02_enforce');
  if v_n <> 0 then
    raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: % fonction(s) du lot existent déjà -- ce fichier n''est pas ré-exécutable.', v_n using errcode = '55000';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t where t.tgname = c_trg) then
    raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT: un déclencheur % existe déjà -- ce fichier n''est pas ré-exécutable.', c_trg using errcode = '55000';
  end if;

  -- A.4 Portées DÉJÀ actives et incomplètes (recensement, même définition que
  --     l'invariant ; calcul en ligne car les fonctions du lot n'existent pas encore).
  select pg_catalog.string_agg(q.k, ', ' order by q.k) into v_viol
  from (
    select s.restaurant_id::text || '/' || s.mode_code || '/' || s.rule_key::text as k
    from public.restaurant_fulfillment_schedule s
    where s.enabled
      and ( (s.date_selection_mode <> 'informational_only'
             and ( (s.slot_selection_mode = 'fixed_slots' and not exists (
                      select 1 from public.restaurant_fulfillment_schedule_slot x
                      where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key))
                or (s.slot_selection_mode <> 'fixed_slots' and not exists (
                      select 1 from public.restaurant_fulfillment_schedule_window x
                      where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key)) ))
         or (s.slot_selection_mode = 'time_within_window' and s.time_granularity_minutes is null)
         or (s.schedule_method_version = 'v1.2' and not exists (
               select 1 from public.restaurant_fulfillment_prep_day x
               where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key))
         or (s.capacity_enabled and (s.capacity_max_orders is null or s.capacity_max_orders < 1))
         or (s.capacity_enabled and s.date_selection_mode = 'informational_only') )
  ) q;
  if v_viol is not null
     and pg_catalog.current_setting('scanym.csdjbo1.f02_require_clean', true) = 'on' then
    raise exception 'SCANYM_CSDJBO1_F02_PREFLIGHT [DIRTY]: des portées actives sont déjà incomplètes (%) ; corrigez-les ou désactivez-les avant ce lot.', v_viol using errcode = '55000';
  end if;
  perform pg_catalog.set_config('scanym.csdjbo1.f02_pre_violations', coalesce(v_viol, ''), true);

  -- A.5 Empreinte de la surface EXISTANTE, relevée ici et comparée au post-vol :
  --     (a) toutes les fonctions de `public` ; (b) colonnes, contraintes (hors les
  --     lignes pg_constraint des déclencheurs de contrainte DU LOT), politiques,
  --     déclencheurs (hors ceux du lot), droits de table ; (c) le CONTENU des tables.
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
           p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|'
           || pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
           || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-') || '|'
           || pg_catalog.pg_get_function_result(p.oid),
           E'\n' order by p.oid::regprocedure::text), ''))
    into v_surface
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace;
  perform pg_catalog.set_config('scanym.csdjbo1.f02_pre_functions', v_surface, true);

  select pg_catalog.md5(
           coalesce((select pg_catalog.string_agg(table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '-'), E'\n' order by table_name, column_name)
                     from information_schema.columns where table_schema = 'public'), '')
        || coalesce((select pg_catalog.string_agg(conrelid::regclass::text || '|' || conname || '|' || pg_catalog.pg_get_constraintdef(oid), E'\n' order by conrelid::regclass::text, conname)
                     from pg_catalog.pg_constraint where connamespace = 'public'::regnamespace and conname <> c_trg), '')
        || coalesce((select pg_catalog.string_agg(tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '-') || '|' || coalesce(with_check, '-'), E'\n' order by tablename, policyname)
                     from pg_catalog.pg_policies where schemaname = 'public'), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid), E'\n' order by c.relname, t.tgname)
                     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
                     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> c_trg), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || coalesce(c.relacl::text, '-') || '|' || c.relrowsecurity::text, E'\n' order by c.relname)
                     from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'), ''))
    into v_surface;
  perform pg_catalog.set_config('scanym.csdjbo1.f02_pre_structure', v_surface, true);

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
  perform pg_catalog.set_config('scanym.csdjbo1.f02_pre_data', pg_catalog.md5(v_data), true);
end
$csdjbo1_f02_preflight$;

-- ============================================================
-- §B  LA DÉFINITION UNIQUE DE « COMPLÈTE »
-- ============================================================
-- Lit l'état STOCKÉ d'une portée et rend la liste de ses bloqueurs (vide = peut
-- proposer une date), NULL si la portée n'existe pas. Mêmes cinq conditions, même
-- ordre que publishBlockersOf et que l'étape 11 de save_fulfillment_configuration.
-- Elle ne regarde PAS `enabled` : l'appelant décide s'il s'applique.
create function public.csdjbo1_f02_scope_blockers(
  p_restaurant_id uuid,
  p_mode_code     text,
  p_rule_key      uuid
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $csdjbo1_f02_blockers$
declare
  s public.restaurant_fulfillment_schedule%rowtype;
  b text[] := array[]::text[];
begin
  select * into s
  from public.restaurant_fulfillment_schedule x
  where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code and x.rule_key = p_rule_key;
  if not found then
    return null;
  end if;

  -- offer_missing : une date choisie ou dérivée sans rien à proposer.
  if s.date_selection_mode <> 'informational_only' then
    if s.slot_selection_mode = 'fixed_slots' then
      if not exists (select 1 from public.restaurant_fulfillment_schedule_slot x
                     where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key) then
        b := pg_catalog.array_append(b, 'offer_missing'::text);
      end if;
    elsif not exists (select 1 from public.restaurant_fulfillment_schedule_window x
                      where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key) then
      b := pg_catalog.array_append(b, 'offer_missing'::text);
    end if;
  end if;
  -- granularity_missing
  if s.slot_selection_mode = 'time_within_window' and s.time_granularity_minutes is null then
    b := pg_catalog.array_append(b, 'granularity_missing'::text);
  end if;
  -- preparation_missing : la méthode v1.2 exige au moins un jour de préparation.
  if s.schedule_method_version = 'v1.2'
     and not exists (select 1 from public.restaurant_fulfillment_prep_day x
                     where x.restaurant_id = s.restaurant_id and x.mode_code = s.mode_code and x.rule_key = s.rule_key) then
    b := pg_catalog.array_append(b, 'preparation_missing'::text);
  end if;
  -- capacity_incomplete / capacity_needs_date (les contraintes de la table les
  -- interdisent déjà ; redits ici pour que la définition soit complète en soi).
  if s.capacity_enabled then
    if s.capacity_max_orders is null or s.capacity_max_orders < 1 then
      b := pg_catalog.array_append(b, 'capacity_incomplete'::text);
    end if;
    if s.date_selection_mode = 'informational_only' then
      b := pg_catalog.array_append(b, 'capacity_needs_date'::text);
    end if;
  end if;
  return b;
end
$csdjbo1_f02_blockers$;

comment on function public.csdjbo1_f02_scope_blockers(uuid,text,uuid) is
  'CSDJ-BO-1 F-02 — définition unique de « portée complète » : bloqueurs d''activation de l''état STOCKÉ (offer_missing, granularity_missing, preparation_missing, capacity_incomplete, capacity_needs_date). Interne : aucun rôle applicatif ne l''exécute.';

-- ============================================================
-- §C  LE CONTRÔLE — fonction de déclencheur
-- ============================================================
create function public.csdjbo1_f02_enforce()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $csdjbo1_f02_enforce$
declare
  v_rid     uuid[] := array[]::uuid[];
  v_mode    text[] := array[]::text[];
  v_key     uuid[] := array[]::uuid[];
  i         integer;
  v_enabled boolean;
  v_b       text[];
begin
  -- Les portées touchées par l'événement : la nouvelle, et l'ancienne si elle
  -- diffère (une ligne enfant peut changer de portée).
  if tg_op in ('INSERT', 'UPDATE') then
    v_rid := pg_catalog.array_append(v_rid, new.restaurant_id);
    v_mode := pg_catalog.array_append(v_mode, new.mode_code);
    v_key := pg_catalog.array_append(v_key, new.rule_key);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if tg_op = 'DELETE'
       or old.restaurant_id is distinct from new.restaurant_id
       or old.mode_code is distinct from new.mode_code
       or old.rule_key is distinct from new.rule_key then
      v_rid := pg_catalog.array_append(v_rid, old.restaurant_id);
      v_mode := pg_catalog.array_append(v_mode, old.mode_code);
      v_key := pg_catalog.array_append(v_key, old.rule_key);
    end if;
  end if;

  for i in 1 .. pg_catalog.cardinality(v_rid) loop
    -- MÊME verrou par tenant que les deux mutateurs historiques et la nouvelle
    -- RPC (réentrant pour eux). Il est pris AU CONTRÔLE, à la fin de la
    -- transaction : un écrivain qui ne le prenait pas est sérialisé ici, puis
    -- relit l'état VALIDÉ des autres (chaque instruction READ COMMITTED voit
    -- un instantané neuf une fois le verrou obtenu).
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_rid[i]::text, 1104));

    select s.enabled into v_enabled
    from public.restaurant_fulfillment_schedule s
    where s.restaurant_id = v_rid[i] and s.mode_code = v_mode[i] and s.rule_key = v_key[i];
    if not found or not v_enabled then
      continue;   -- portée supprimée ou brouillon : rien n'est « actif ».
    end if;

    v_b := public.csdjbo1_f02_scope_blockers(v_rid[i], v_mode[i], v_key[i]);
    if pg_catalog.cardinality(v_b) > 0 then
      raise exception 'CSDJBO1_INCOMPLETE_CONFIGURATION: une portée active doit pouvoir proposer une date ; écriture refusée, rien n''est enregistré.'
        using errcode = '23514',
              detail = 'blockers=' || pg_catalog.array_to_string(v_b, ',') || ' source=invariant';
    end if;
  end loop;
  return null;
end
$csdjbo1_f02_enforce$;

comment on function public.csdjbo1_f02_enforce() is
  'CSDJ-BO-1 F-02 — fonction des déclencheurs de contrainte différés csdjbo1_f02_activation_invariant : au COMMIT, refuse (CSDJBO1_INCOMPLETE_CONFIGURATION, 23514) tout état final où une portée ACTIVE est incomplète. Verrou de tenant graine 1104. Interne.';

-- ============================================================
-- §D  LES DÉCLENCHEURS — différés, par ligne, sur les quatre tables qui décident
--     de la complétude. Les INSERT d'enfants ne peuvent qu'AJOUTER une offre : ils
--     ne sont pas surveillés (moins d'événements, même garantie).
-- ============================================================
create constraint trigger csdjbo1_f02_activation_invariant
  after insert or update on public.restaurant_fulfillment_schedule
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();

create constraint trigger csdjbo1_f02_activation_invariant
  after update or delete on public.restaurant_fulfillment_schedule_window
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();

create constraint trigger csdjbo1_f02_activation_invariant
  after update or delete on public.restaurant_fulfillment_schedule_slot
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();

create constraint trigger csdjbo1_f02_activation_invariant
  after update or delete on public.restaurant_fulfillment_prep_day
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();

-- ============================================================
-- §E  ACL — fermées : seul le propriétaire (un déclencheur n'exige aucun droit
--     d'exécution de la part de celui qui écrit).
-- ============================================================
revoke all on function public.csdjbo1_f02_scope_blockers(uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.csdjbo1_f02_enforce() from public, anon, authenticated, service_role;

-- ============================================================
-- §Z  POST-VOL — DANS la transaction, avant le COMMIT
-- ============================================================
do $csdjbo1_f02_postflight$
declare
  c_trg      constant text := 'csdjbo1_f02_activation_invariant';
  v_n        integer;
  v_t        text;
  v_role     text;
  v_owner    text;
  v_surface  text;
  v_data     text;
  v_grantees text;
  v_viol     text;
  v_viol_n   integer;
begin
  -- Z.1 Une seule surcharge chacune, propriétaire = celui de l'autorité existante,
  --     SECURITY DEFINER, search_path vide, ACL = propriétaire SEUL.
  select pg_catalog.pg_get_userbyid(p.proowner) into v_owner
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'mutate_merchant_fulfillment_schedule';
  foreach v_t in array array['csdjbo1_f02_scope_blockers','csdjbo1_f02_enforce'] loop
    select pg_catalog.count(*) into v_n
    from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = v_t;
    if v_n <> 1 then
      raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: public.% a % surcharge(s) au lieu d''une.', v_t, v_n;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p
                   where p.pronamespace = 'public'::regnamespace and p.proname = v_t
                     and p.prosecdef
                     and pg_catalog.pg_get_userbyid(p.proowner) = v_owner
                     and p.proconfig = array['search_path=""']) then
      raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: public.% n''est pas SECURITY DEFINER / search_path vide / propriétaire % .', v_t, v_owner;
    end if;
    select coalesce(pg_catalog.string_agg(distinct
             case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end, ',' order by
             case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end), '')
      into v_grantees
    from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace and p.proname = v_t and a.privilege_type = 'EXECUTE';
    if v_grantees <> v_owner then
      raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: public.% a pour bénéficiaires « % » au lieu du seul propriétaire.', v_t, v_grantees;
    end if;
    foreach v_role in array array['anon','authenticated','service_role'] loop
      if pg_catalog.has_function_privilege(v_role, (select p.oid from pg_catalog.pg_proc p
                                                    where p.pronamespace = 'public'::regnamespace and p.proname = v_t), 'EXECUTE') then
        raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: % peut exécuter public.%.', v_role, v_t;
      end if;
    end loop;
  end loop;

  -- Z.2 Exactement les quatre déclencheurs attendus : différés, par ligne, actifs
  --     (origine), contraintes, rattachés à la bonne fonction et aux bons événements.
  select pg_catalog.count(*) into v_n from pg_catalog.pg_trigger t where t.tgname = c_trg;
  if v_n <> 4 then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: % déclencheur(s) % au lieu de 4.', v_n, c_trg;
  end if;
  if exists (
       select 1 from pg_catalog.pg_trigger t
       where t.tgname = c_trg
         and not (t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred
                  and t.tgenabled = 'O'
                  and (t.tgtype & 1) = 1                  -- par ligne
                  and (t.tgtype & 2) = 0                  -- ni BEFORE ni INSTEAD OF
                  and t.tgfoid = 'public.csdjbo1_f02_enforce()'::regprocedure)) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: un déclencheur % n''est pas un déclencheur de contrainte différé, par ligne, actif.', c_trg;
  end if;
  for v_t in
    select x.rel || ':' || x.ev from (values
      ('restaurant_fulfillment_schedule', 4 | 16),
      ('restaurant_fulfillment_schedule_window', 8 | 16),
      ('restaurant_fulfillment_schedule_slot', 8 | 16),
      ('restaurant_fulfillment_prep_day', 8 | 16)) x(rel, ev)
  loop
    -- tgtype : 4 = INSERT, 8 = DELETE, 16 = UPDATE ; ici (INSERT|UPDATE) = 20, (DELETE|UPDATE) = 24.
    if not exists (select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
                   where t.tgname = c_trg and c.relnamespace = 'public'::regnamespace
                     and c.relname = split_part(v_t, ':', 1)
                     and (t.tgtype & 28) = split_part(v_t, ':', 2)::int) then
      raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: le déclencheur % de % n''a pas les événements attendus.', c_trg, split_part(v_t, ':', 1);
    end if;
  end loop;

  -- Z.3 SURFACE EXISTANTE INCHANGÉE D'UN OCTET : fonctions (hors les deux du lot),
  --     structure (hors les lignes du lot), contenu des tables de configuration.
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
           p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|'
           || pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
           || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-') || '|'
           || pg_catalog.pg_get_function_result(p.oid),
           E'\n' order by p.oid::regprocedure::text), ''))
    into v_surface
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname not in ('csdjbo1_f02_scope_blockers','csdjbo1_f02_enforce');
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_pre_functions', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: une fonction EXISTANTE a changé (corps, ACL, propriétaire ou signature).';
  end if;

  select pg_catalog.md5(
           coalesce((select pg_catalog.string_agg(table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '-'), E'\n' order by table_name, column_name)
                     from information_schema.columns where table_schema = 'public'), '')
        || coalesce((select pg_catalog.string_agg(conrelid::regclass::text || '|' || conname || '|' || pg_catalog.pg_get_constraintdef(oid), E'\n' order by conrelid::regclass::text, conname)
                     from pg_catalog.pg_constraint where connamespace = 'public'::regnamespace and conname <> c_trg), '')
        || coalesce((select pg_catalog.string_agg(tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '-') || '|' || coalesce(with_check, '-'), E'\n' order by tablename, policyname)
                     from pg_catalog.pg_policies where schemaname = 'public'), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid), E'\n' order by c.relname, t.tgname)
                     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
                     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> c_trg), '')
        || coalesce((select pg_catalog.string_agg(c.relname || '|' || coalesce(c.relacl::text, '-') || '|' || c.relrowsecurity::text, E'\n' order by c.relname)
                     from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'), ''))
    into v_surface;
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_pre_structure', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: la structure existante (colonnes, contraintes, politiques, déclencheurs, droits de table) a changé.';
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
  if pg_catalog.md5(v_data) is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_pre_data', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: ce lot ne doit insérer, modifier ni supprimer AUCUNE ligne de configuration.';
  end if;

  -- Z.4 Recensement APRÈS lot, par la fonction du lot : doit redonner exactement
  --     celui du pré-vol (même définition, deux implémentations). Signalé, jamais corrigé.
  select pg_catalog.count(*), pg_catalog.string_agg(q.k, ', ' order by q.k)
    into v_viol_n, v_viol
  from (
    select s.restaurant_id::text || '/' || s.mode_code || '/' || s.rule_key::text as k
    from public.restaurant_fulfillment_schedule s
    where s.enabled and pg_catalog.cardinality(public.csdjbo1_f02_scope_blockers(s.restaurant_id, s.mode_code, s.rule_key)) > 0
  ) q;
  if coalesce(v_viol, '') is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_pre_violations', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: le recensement des portées actives incomplètes diffère entre le pré-vol et le post-vol (définitions divergentes).';
  end if;
  if v_viol_n > 0 then
    raise warning 'SCANYM_CSDJBO1_F02 [LEGACY_VIOLATIONS=%]: portée(s) déjà active(s) et incomplète(s), NON modifiée(s) : %', v_viol_n, v_viol;
  else
    raise notice 'SCANYM_CSDJBO1_F02 [LEGACY_VIOLATIONS=0]: aucune portée active incomplète.';
  end if;
end
$csdjbo1_f02_postflight$;

commit;

-- ============================================================
-- IDEMPOTENCE : non ré-exécutable (voir A.3). Retour arrière :
-- supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1-rollback.sql
-- ============================================================
