-- ============================================================
-- Scanym — CSDJ-BO-1 — RETOUR ARRIÈRE de save_fulfillment_configuration (v1)
-- Fichier  : supabase/DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1-rollback.sql
-- Statut   : DRAFT — NON APPLIQUÉ. Aucun SQL hébergé sans GO.
--
-- CE QUE FAIT CE FICHIER
--   Supprime les TROIS fonctions du lot (save_fulfillment_configuration,
--   get_fulfillment_configuration, csdjbo1_persisted_configuration) et RIEN
--   d'autre. Il ne touche aucune donnée : les portées déjà configurées (y
--   compris celles écrites par la nouvelle RPC) RESTENT, intactes -- elles
--   sont des lignes des tables CSDJ-1 / v1.2 et restent lisibles et
--   modifiables par les mutateurs historiques. Il ne touche pas CSDJ-1,
--   CSDJ v1.2, CSDJ-3.
--
-- ORDRE : ce retour est INDÉPENDANT de celui de la v1.2 (il ne la défait pas).
--   Si les deux sont défaits, défaire d'abord CE lot, puis CSDJ v1.2
--   (ce lot lit des colonnes v1.2 ; retirer la v1.2 d'abord le laisserait
--   sans objet -- mais ce retour est conçu pour rester exécutable même alors).
--
-- GARDES (refus nommés, avant toute modification)
--   [NOT_APPLICABLE]      aucune des trois fonctions n'existe, ou une seule
--                         partie du lot est présente (état partiel : on refuse
--                         plutôt que de deviner) ;
--   [DEPENDENT]           un objet enregistre une dépendance vers l'une des
--                         trois fonctions (vue, politique, valeur par défaut,
--                         déclencheur, fonction SQL BEGIN ATOMIC...) ;
--   [CALLER]              une routine d'un schéma non système cite l'une des
--                         trois fonctions par son nom (texte, mot entier,
--                         insensible à la casse) ;
--   [CRON_JOB]            une commande pg_cron la cite (si pg_cron est présent).
--
-- CE QUI RESTE HORS DE PORTÉE D'UNE ANALYSE STATIQUE (voir le contrat, §Limites)
--   SQL dynamique à nom recomposé, clients externes (PostgREST, fonctions edge,
--   interface Nougaro), commandes pg_cron indirectes. L'INTERFACE doit être
--   retirée AVANT le retour (CSDJ_BO1_WRITE_CONTRACT.available = false) : une
--   page qui appelle une fonction supprimée échoue (404), sans rien corrompre.
-- ============================================================

begin;

do $csdjbo1_rb_preflight$
declare
  c_names constant text[] := array['save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration'];
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
  if v_n = 0 then
    raise exception 'SCANYM_CSDJBO1_ROLLBACK_REFUSED [NOT_APPLICABLE]: le lot n''est pas appliqué (aucune des trois fonctions n''existe).' using errcode = '55000';
  end if;
  if v_n <> 3
     or pg_catalog.to_regprocedure('public.save_fulfillment_configuration(uuid,jsonb)') is null
     or pg_catalog.to_regprocedure('public.get_fulfillment_configuration(uuid,text,uuid)') is null
     or pg_catalog.to_regprocedure('public.csdjbo1_persisted_configuration(uuid,text,uuid)') is null then
    raise exception 'SCANYM_CSDJBO1_ROLLBACK_REFUSED [NOT_APPLICABLE]: état partiel du lot (% fonction(s) sur 3, ou signature inattendue).', v_n using errcode = '55000';
  end if;

  -- [DEPENDENT] dépendances ENREGISTRÉES vers les trois fonctions, hors elles-mêmes.
  select pg_catalog.string_agg(distinct d.classid::regclass::text || ':' || d.objid::text, ', ') into v_hit
  from pg_catalog.pg_depend d
  join pg_catalog.pg_proc p on p.oid = d.refobjid and d.refclassid = 'pg_catalog.pg_proc'::regclass
  where p.pronamespace = 'public'::regnamespace and p.proname = any(c_names)
    and d.deptype in ('n','a')
    and not (d.classid = 'pg_catalog.pg_proc'::regclass
             and d.objid in (select o.oid from pg_catalog.pg_proc o
                             where o.pronamespace = 'public'::regnamespace and o.proname = any(c_names)));
  if v_hit is not null then
    raise exception 'SCANYM_CSDJBO1_ROLLBACK_REFUSED [DEPENDENT]: des objets dépendent des fonctions du lot (%).', v_hit using errcode = '55000';
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
    raise exception 'SCANYM_CSDJBO1_ROLLBACK_REFUSED [CALLER]: des routines citent les fonctions du lot (%).', v_hit using errcode = '55000';
  end if;

  -- [CRON_JOB]
  if pg_catalog.to_regclass('cron.job') is not null then
    execute pg_catalog.format('select pg_catalog.string_agg(jobid::text, '', '') from cron.job where command ~* %L', v_re) into v_hit;
    if v_hit is not null then
      raise exception 'SCANYM_CSDJBO1_ROLLBACK_REFUSED [CRON_JOB]: des tâches pg_cron citent les fonctions du lot (jobid %).', v_hit using errcode = '55000';
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
  perform pg_catalog.set_config('scanym.csdjbo1.rb_functions', v_surface, true);

  v_data := '';
  foreach v_t in array array[
    'restaurant_fulfillment_schedule','restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot','restaurant_fulfillment_schedule_closure',
    'restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure',
    'public_holiday_calendar','public_holiday_calendar_day',
    'order_fulfillment_capacity_reservation'] loop
    if pg_catalog.to_regclass('public.' || v_t) is not null then
      execute pg_catalog.format(
        'select pg_catalog.md5(coalesce(pg_catalog.string_agg(x::text, E''\n'' order by x::text), '''')) from public.%I x', v_t)
        into v_surface;
      v_data := v_data || v_t || '=' || v_surface || ';';
    end if;
  end loop;
  perform pg_catalog.set_config('scanym.csdjbo1.rb_data', pg_catalog.md5(v_data), true);
end
$csdjbo1_rb_preflight$;

drop function public.save_fulfillment_configuration(uuid,jsonb);
drop function public.get_fulfillment_configuration(uuid,text,uuid);
drop function public.csdjbo1_persisted_configuration(uuid,text,uuid);

do $csdjbo1_rb_postflight$
declare
  c_names constant text[] := array['save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration'];
  v_surface text;
  v_data    text;
  v_t       text;
begin
  if exists (select 1 from pg_catalog.pg_proc p where p.proname = any(c_names)) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: une fonction du lot subsiste.';
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
  if v_surface is distinct from pg_catalog.current_setting('scanym.csdjbo1.rb_functions', true) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: une fonction hors lot a changé pendant le retour.';
  end if;
  v_data := '';
  foreach v_t in array array[
    'restaurant_fulfillment_schedule','restaurant_fulfillment_schedule_window',
    'restaurant_fulfillment_schedule_slot','restaurant_fulfillment_schedule_closure',
    'restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure',
    'public_holiday_calendar','public_holiday_calendar_day',
    'order_fulfillment_capacity_reservation'] loop
    if pg_catalog.to_regclass('public.' || v_t) is not null then
      execute pg_catalog.format(
        'select pg_catalog.md5(coalesce(pg_catalog.string_agg(x::text, E''\n'' order by x::text), '''')) from public.%I x', v_t)
        into v_surface;
      v_data := v_data || v_t || '=' || v_surface || ';';
    end if;
  end loop;
  if pg_catalog.md5(v_data) is distinct from pg_catalog.current_setting('scanym.csdjbo1.rb_data', true) then
    raise exception 'SCANYM_CSDJBO1_POSTCHECK: le retour ne doit modifier AUCUNE donnée de configuration.';
  end if;
end
$csdjbo1_rb_postflight$;

commit;
