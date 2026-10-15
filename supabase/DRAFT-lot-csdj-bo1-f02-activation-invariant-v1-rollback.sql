-- ============================================================
-- Scanym — CSDJ-BO-1 — RETOUR ARRIÈRE de l'invariant d'activation F-02 (v1)
-- Fichier  : supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1-rollback.sql
-- Statut   : DRAFT — NON APPLIQUÉ. Aucun SQL hébergé sans GO.
--
-- CE QUE FAIT CE FICHIER
--   Supprime les 4 déclencheurs csdjbo1_f02_activation_invariant et les 2
--   fonctions du lot (csdjbo1_f02_enforce, csdjbo1_f02_scope_blockers), et RIEN
--   d'autre. Il ne touche aucune donnée : les portées configurées restent,
--   intactes. Il ne touche ni CSDJ-1, ni CSDJ v1.2, ni CSDJ-3, ni le lot
--   save_fulfillment_configuration.
--
-- EFFET À CONNAÎTRE : après ce retour, F-02 est de nouveau OUVERT (les mutateurs
--   historiques peuvent activer une portée incomplète). Ne le jouer que pour une
--   raison que le CTO a tranchée.
--
-- ORDRE : INDÉPENDANT du lot save_fulfillment_configuration (aucune dépendance
--   dans un sens ni dans l'autre) et de la v1.2.
--
-- GARDES (refus nommés, avant toute modification)
--   [NOT_APPLICABLE]  rien du lot n'existe, ou état PARTIEL (on refuse plutôt que de deviner) ;
--   [DEPENDENT]       un objet enregistre une dépendance vers une fonction du lot
--                     (autre que les 4 déclencheurs eux-mêmes) ;
--   [CALLER]          une routine d'un schéma non système cite une fonction du lot ;
--   [CRON_JOB]        une commande pg_cron la cite (si pg_cron est présent).
--
-- CE QUI RESTE HORS DE PORTÉE D'UNE ANALYSE STATIQUE : SQL dynamique à nom
--   recomposé, clients externes, commandes pg_cron indirectes.
-- ============================================================

begin;

do $csdjbo1_f02_rb_preflight$
declare
  c_names constant text[] := array['csdjbo1_f02_enforce','csdjbo1_f02_scope_blockers'];
  c_trg   constant text   := 'csdjbo1_f02_activation_invariant';
  v_n        integer;
  v_surface  text;
  v_data     text;
  v_t        text;
  v_hit      text;
  v_re       text;
begin
  -- [NOT_APPLICABLE]
  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = any(c_names);
  if v_n = 0 and not exists (select 1 from pg_catalog.pg_trigger t where t.tgname = c_trg) then
    raise exception 'SCANYM_CSDJBO1_F02_ROLLBACK_REFUSED [NOT_APPLICABLE]: le lot n''est pas appliqué.' using errcode = '55000';
  end if;
  if v_n <> 2
     or pg_catalog.to_regprocedure('public.csdjbo1_f02_enforce()') is null
     or pg_catalog.to_regprocedure('public.csdjbo1_f02_scope_blockers(uuid,text,uuid)') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger t where t.tgname = c_trg) <> 4 then
    raise exception 'SCANYM_CSDJBO1_F02_ROLLBACK_REFUSED [NOT_APPLICABLE]: état partiel du lot (% fonction(s) sur 2, % déclencheur(s) sur 4).',
      v_n, (select pg_catalog.count(*) from pg_catalog.pg_trigger t where t.tgname = c_trg) using errcode = '55000';
  end if;

  -- [DEPENDENT] dépendances ENREGISTRÉES vers les fonctions du lot, hors elles-mêmes
  -- et hors les 4 déclencheurs du lot (qui seront supprimés avec).
  select pg_catalog.string_agg(distinct d.classid::regclass::text || ':' || d.objid::text, ', ') into v_hit
  from pg_catalog.pg_depend d
  join pg_catalog.pg_proc p on p.oid = d.refobjid and d.refclassid = 'pg_catalog.pg_proc'::regclass
  where p.pronamespace = 'public'::regnamespace and p.proname = any(c_names)
    and d.deptype in ('n','a')
    and not (d.classid = 'pg_catalog.pg_proc'::regclass
             and d.objid in (select o.oid from pg_catalog.pg_proc o
                             where o.pronamespace = 'public'::regnamespace and o.proname = any(c_names)))
    and not (d.classid = 'pg_catalog.pg_trigger'::regclass
             and d.objid in (select t.oid from pg_catalog.pg_trigger t where t.tgname = c_trg));
  if v_hit is not null then
    raise exception 'SCANYM_CSDJBO1_F02_ROLLBACK_REFUSED [DEPENDENT]: des objets dépendent des fonctions du lot (%).', v_hit using errcode = '55000';
  end if;

  -- [CALLER] texte des routines de TOUS les schémas non système.
  v_re := '\m(' || pg_catalog.array_to_string(c_names, '|') || ')\M';
  select pg_catalog.string_agg(n.nspname || '.' || r.proname, ', ' order by n.nspname, r.proname) into v_hit
  from pg_catalog.pg_proc r
  join pg_catalog.pg_namespace n on n.oid = r.pronamespace
  where n.nspname !~ '^(pg_|information_schema$)'
    and r.prokind in ('f','p')
    and not (n.nspname = 'public' and r.proname = any(c_names))
    and not exists (select 1 from pg_catalog.pg_depend e where e.classid = 'pg_catalog.pg_proc'::regclass
                    and e.objid = r.oid and e.deptype = 'e')
    and r.prosrc ~* v_re;
  if v_hit is not null then
    raise exception 'SCANYM_CSDJBO1_F02_ROLLBACK_REFUSED [CALLER]: des routines citent les fonctions du lot (%).', v_hit using errcode = '55000';
  end if;

  -- [CRON_JOB]
  if pg_catalog.to_regclass('cron.job') is not null then
    execute pg_catalog.format('select pg_catalog.string_agg(jobid::text, '', '') from cron.job where command ~* %L', v_re) into v_hit;
    if v_hit is not null then
      raise exception 'SCANYM_CSDJBO1_F02_ROLLBACK_REFUSED [CRON_JOB]: des tâches pg_cron citent les fonctions du lot (jobid %).', v_hit using errcode = '55000';
    end if;
  end if;

  -- Empreinte de la surface RESTANTE (hors lot), relevée ici, comparée au post-vol.
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
           p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|'
           || pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
           || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-') || '|'
           || pg_catalog.pg_get_function_result(p.oid),
           E'\n' order by p.oid::regprocedure::text), ''))
    into v_surface
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname <> all(c_names);
  perform pg_catalog.set_config('scanym.csdjbo1.f02_rb_functions', v_surface, true);

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
  perform pg_catalog.set_config('scanym.csdjbo1.f02_rb_structure', v_surface, true);

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
  perform pg_catalog.set_config('scanym.csdjbo1.f02_rb_data', pg_catalog.md5(v_data), true);
end
$csdjbo1_f02_rb_preflight$;

drop trigger csdjbo1_f02_activation_invariant on public.restaurant_fulfillment_schedule;
drop trigger csdjbo1_f02_activation_invariant on public.restaurant_fulfillment_schedule_window;
drop trigger csdjbo1_f02_activation_invariant on public.restaurant_fulfillment_schedule_slot;
drop trigger csdjbo1_f02_activation_invariant on public.restaurant_fulfillment_prep_day;
drop function public.csdjbo1_f02_enforce();
drop function public.csdjbo1_f02_scope_blockers(uuid,text,uuid);

do $csdjbo1_f02_rb_postflight$
declare
  c_names constant text[] := array['csdjbo1_f02_enforce','csdjbo1_f02_scope_blockers'];
  c_trg   constant text   := 'csdjbo1_f02_activation_invariant';
  v_surface text;
  v_data    text;
  v_t       text;
begin
  if exists (select 1 from pg_catalog.pg_proc p where p.proname = any(c_names))
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgname = c_trg)
     or exists (select 1 from pg_catalog.pg_constraint c where c.conname = c_trg) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: un objet du lot subsiste.';
  end if;
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
           p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|'
           || pg_catalog.pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
           || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-') || '|'
           || pg_catalog.pg_get_function_result(p.oid),
           E'\n' order by p.oid::regprocedure::text), ''))
    into v_surface
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace;
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_rb_functions', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: une fonction hors lot a changé pendant le retour.';
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
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_rb_structure', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: la structure hors lot a changé pendant le retour.';
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
  if pg_catalog.md5(v_data) is distinct from pg_catalog.current_setting('scanym.csdjbo1.f02_rb_data', true) then
    raise exception 'SCANYM_CSDJBO1_F02_POSTCHECK: le retour ne doit modifier AUCUNE donnée de configuration.';
  end if;
end
$csdjbo1_f02_rb_postflight$;

commit;
