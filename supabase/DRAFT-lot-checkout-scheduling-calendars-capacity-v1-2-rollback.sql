-- ============================================================
-- Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2) — RETOUR ARRIÈRE
-- (DRAFT — NOT APPLIED)
--
-- Aller : DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql
-- Parent de l'aller : main 03441a5ef1d371e90e3bfe3438e1a29e211d0537.
--
-- CE QUE CE RETOUR FAIT
--   1. supprime le répartiteur resolve_fulfillment_schedule puis
--      RESTAURE l'ancienne résolution CSDJ-1 sous son nom d'origine
--      (renommage resolve_fulfillment_schedule_v1 -> resolve_fulfillment_schedule,
--      corps et ACL INCHANGÉS : c'est le même objet, jamais recréé) ;
--   2. supprime les fonctions v1.2 ;
--   3. supprime les trois tables de calendrier/réservation puis les
--      deux tables de jours fériés ;
--   4. retire les cinq colonnes et leurs contraintes de
--      restaurant_fulfillment_schedule.
--
-- CE QU'IL NE FAIT PAS
--   - il ne touche NI create_order, NI update_order_status, NI le moteur
--     de paiement : l'aller n'en a modifié aucun ;
--   - il ne touche à aucune commande ni à aucune planification v1.
--
-- REFUS EXPLICITE PLUTÔT QUE PERTE SILENCIEUSE
--   Le retour REFUSE de s'appliquer tant qu'il existerait de la donnée
--   v1.2 à perdre : une planification de méthode v1.2, un jour de
--   préparation, une fermeture de préparation, un calendrier férié, ou
--   une réservation de capacité. Le commerçant doit d'abord repasser ses
--   planifications en v1 (ou les supprimer) ; les réservations sont des
--   enregistrements de commande et ne sont jamais détruites par un
--   retour. Ce refus est testé (harnais, section « Retour arrière »).
--
-- ORDRE INVERSE DU DÉPLOIEMENT (CSDJ12-RB-02, audit Cat Greco)
--   Déploiement : CSDJ-1 v1.10 -> CSDJ v1.2 -> CSDJ-3.
--   Retour      : CSDJ-3 d'abord, PUIS CE FICHIER.
--   CSDJ-3 fait appeler le moteur par create_order (validate_fulfillment_selection
--   TOUJOURS, reserve_fulfillment_capacity si la capacité s'applique). Ces
--   fonctions sont supprimées par ce retour : PostgreSQL ne suit PAS les
--   dépendances d'un corps plpgsql, le DROP réussirait et CHAQUE commande
--   échouerait ensuite (« function ... does not exist »). Le retour REFUSE
--   donc, avant toute modification, si :
--     R-1  la table marqueur de CSDJ-3 existe
--          (public.order_fulfillment_schedule_snapshot, contrat §9) ;
--     R-2  create_order n'est pas EXACTEMENT le prédécesseur pré-CSDJ-3 :
--          une seule surcharge, arité 8, md5(prosrc, fins de ligne LF) =
--          c327445751333e7908d60e6d7f838eb5 (contrat §12.2 / §12.3, valeur
--          lue en production) ;
--     R-3  un consommateur du moteur existe dans un schéma non système
--          quelconque (voir « DÉCOUVERTE DES CONSOMMATEURS » plus bas) ;
--     R-4  le jeton de revue (ce que le texte ne peut pas démontrer) est
--          absent ou périmé.
--   R-1 et R-2 sont indépendants : chacun suffit à refuser.
--
-- EXCLUSION MUTUELLE AVEC L'INSTALLATION DE CSDJ-3 (CSDJ12-RB02-RACE-02)
--   Les contrôles ci-dessus lisent un état validé ; sans exclusion, une
--   installation de CSDJ-3 qui valide entre ce contrôle et le DROP produirait
--   un create_order cassé. Ce fichier prend donc, en PREMIER (avant le contrôle
--   d'applicabilité et avant toute lecture de dépendance), le MÊME verrou
--   consultatif transactionnel que l'installation de CSDJ-3 :
--       pg_catalog.pg_advisory_xact_lock(
--         pg_catalog.hashtextextended('scanym.csdj3.order-persistence.v1', 0))
--   (expression issue du mandat Dirac -> Boulez ; NON VÉRIFIÉE contre le
--   candidat CSDJ-3 34cad9e, introuvable depuis cet environnement -- voir
--   docs/scheduling/csdj-v1.2-deploy-rollback-order.md, « Dépendance
--   d'interface avec CSDJ-3 »).
--   Garanties, avec une installation CSDJ-3 qui respecte le même protocole
--   (verrou d'abord, prérequis relus APRÈS le verrou, puis installation) :
--     - CSDJ-3 gagne  : ce retour ATTEND, puis voit le marqueur et REFUSE ;
--     - ce retour gagne : CSDJ-3 ATTEND, puis ne trouve plus ses prérequis
--       (fonctions du moteur) et REFUSE ;
--     - aucun entrelacement ne valide un create_order qui appelle un moteur
--       supprimé.
--   Le verrou ne protège que contre un installateur qui le prend : il ne
--   « verrouille » rien d'autre. Niveau d'isolation exigé : READ COMMITTED
--   (sous REPEATABLE READ, l'instantané précède l'attente du verrou et les
--   contrôles liraient un état périmé : refus [ISOLATION]).
--
-- DÉCOUVERTE DES CONSOMMATEURS DU MOTEUR (CSDJ12-RB02-CALLER-01)
--   PostgreSQL ne suit PAS les dépendances du corps d'une fonction plpgsql ni
--   d'un SQL dynamique : aucune inspection ne PROUVE l'absence de consommateur.
--   Ce retour combine donc quatre sources et assume une limite :
--     1. métadonnées pg_depend (vues, contraintes, déclencheurs, politiques,
--        valeurs par défaut, index, fonctions SQL ATOMIC...) vers les objets
--        du moteur, TOUS schémas non système : [ENGINE_DEPENDENT] ;
--     2. inspection du texte de TOUTES les routines des schémas non système
--        (mot entier, insensible à la casse), moteur exclu PAR OID EXACT et non
--        par nom : [ENGINE_CALLER] ; tâches pg_cron : [CRON_JOB] ;
--     3. inventaire explicite des consommateurs connus (docs/scheduling/
--        csdj-v1.2-engine-consumers.json), qui qualifie le message de refus ;
--     4. LIMITE ASSUMÉE : SQL dynamique, routines hors SQL/plpgsql, tâches
--        planifiées et clients externes ne sont pas démontrables par le texte.
--        Les routines concernées sont ÉNUMÉRÉES (mode revue) et liées à un
--        JETON DE REVUE : le retour REFUSE ([REVIEW_TOKEN]) tant que
--        l'opérateur ne présente pas le jeton calculé sur l'état exact qu'il
--        a relu. Toute routine dynamique ajoutée ou modifiée entre la revue et
--        l'application invalide le jeton.
--   Mode revue (aucune modification, énumère et imprime le jeton) :
--       set scanym.csdj12_rollback_mode = 'review';
--   Application :
--       set scanym.csdj12_rollback_review_token = '<jeton relu>';
--   Le jeton n'est PAS une preuve d'absence : c'est l'engagement vérifié que
--   l'état relu est l'état appliqué. Voir la politique complète dans la doc.
--
-- ATOMICITÉ : une seule transaction, pré-vol et post-vol dedans.
-- ============================================================

begin;

-- RB02-RACE-02. Niveau d'isolation : READ COMMITTED exigé, AVANT de prendre le
-- verrou (sous REPEATABLE READ l'instantané date d'avant l'attente).
do $csdj12_rb_isolation$
begin
  if pg_catalog.current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [ISOLATION] niveau d''isolation « % » -- READ COMMITTED exigé (les contrôles doivent relire l''état validé APRÈS l''attente du verrou).', pg_catalog.current_setting('transaction_isolation')
      using errcode = '55000';
  end if;
end
$csdj12_rb_isolation$;

-- RB02-RACE-02. Verrou partagé avec l'installation de CSDJ-3 : PREMIÈRE
-- instruction, avant l'applicabilité et avant toute lecture de dépendance.
-- Verrou transactionnel : libéré au COMMIT ou au ROLLBACK, jamais orphelin.
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scanym.csdj3.order-persistence.v1', 0));

do $csdj12_rb_preflight$
declare
  v_n       bigint;
  v_md5     text;
  v_hit     text;
  v_miss    text;
  v_eng_sigs constant text[] := array[
    'public.get_merchant_fulfillment_schedules_v12(uuid)',
    'public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)',
    'public.release_fulfillment_capacity(uuid)',
    'public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone)',
    'public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone)',
    'public.fulfillment_selection_reasons_v12()',
    'public.resolve_fulfillment_schedule_v12(uuid,text,uuid,timestamp with time zone,boolean)',
    'public.checkout_schedule_day_offers_v12(public.restaurant_fulfillment_schedule,date,timestamp with time zone)',
    'public.csdj12_availability_closed(public.restaurant_fulfillment_schedule,date)',
    'public.csdj12_preparation_open(public.restaurant_fulfillment_schedule,date)',
    'public.fulfillment_capacity_used(uuid,text,uuid,date,text)',
    'public.fulfillment_capacity_is_holding(text,text)',
    'public.checkout_unfulfillable_reasons_v12()',
    'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)',
    'public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)'];
  -- Noms surveillés dans le TEXTE des routines (le répartiteur est restauré
  -- sous son nom : ses appelants continuent de fonctionner ; en revanche
  -- resolve_fulfillment_schedule_v1 DISPARAÎT au renommage).
  v_names constant text[] := array[
    'validate_fulfillment_selection','reserve_fulfillment_capacity','release_fulfillment_capacity',
    'fulfillment_capacity_used','fulfillment_capacity_is_holding','fulfillment_selection_reasons_v12',
    'resolve_fulfillment_schedule_v12','checkout_unfulfillable_reasons_v12','checkout_schedule_day_offers_v12',
    'csdj12_preparation_open','csdj12_availability_closed','mutate_merchant_fulfillment_schedule_v12',
    'get_merchant_fulfillment_schedules_v12','resolve_fulfillment_schedule_v1',
    'order_fulfillment_capacity_reservation','restaurant_fulfillment_prep_closure','restaurant_fulfillment_prep_day',
    'public_holiday_calendar_day','public_holiday_calendar',
    'capacity_max_orders','capacity_enabled','availability_on_holidays','preparation_on_holidays','holiday_calendar_id'];
  v_tabs constant text[] := array[
    'order_fulfillment_capacity_reservation','restaurant_fulfillment_prep_closure','restaurant_fulfillment_prep_day',
    'public_holiday_calendar_day','public_holiday_calendar'];
  v_cols constant text[] := array[
    'capacity_max_orders','capacity_enabled','availability_on_holidays','preparation_on_holidays','holiday_calendar_id'];
  v_cons constant text[] := array[
    'rfs_v12_extensions_only','rfs_v12_no_cutoff_offset','rfs_capacity_needs_date','rfs_capacity_complete',
    'rfs_capacity_positive','rfs_holiday_requires_calendar','rfs_holiday_policy_values','rfs_method_version_known',
    'rfs_holiday_calendar_fk'];
  -- Routines dont le texte ne PROUVE pas l'absence d'appel : SQL dynamique,
  -- introspection du catalogue, ou langage autre que SQL / plpgsql.
  v_dyn_re constant text := '\m(execute|format|quote_ident|quote_literal|quote_nullable|pg_get_functiondef|to_regproc|to_regprocedure|regproc|regprocedure|pg_proc)\M';
  v_review_version constant text := 'csdj12-rollback-review-v1';
  v_eng      oid[];
  v_tab_oids oid[];
  v_typ_oids oid[];
  v_rfs      oid;
  v_attn     int2[];
  v_re       text;
  v_dep      text;
  v_cron     text;
  v_s2       text;
  v_s3       text;
  v_list     text;
  v_n_dyn    bigint;
  v_n_schema bigint;
  v_mode     text;
  v_given    text;
  v_token    text;
begin
  if pg_catalog.to_regclass('public.order_fulfillment_capacity_reservation') is null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)') is null then
    raise exception 'SCANYM_ROLLBACK_NOT_APPLICABLE: CSDJ v1.2 n''est pas appliqué (ou déjà retiré) -- retour annulé.'
      using errcode = '42P01';
  end if;

  -- R-1. Marqueur de schéma de CSDJ-3.
  if pg_catalog.to_regclass('public.order_fulfillment_schedule_snapshot') is not null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [CSDJ3_INSTALLED] CSDJ-3 est installé (table order_fulfillment_schedule_snapshot présente) -- retirer CSDJ-3 d''abord, puis ce retour (ordre inverse du déploiement).'
      using errcode = '55000';
  end if;

  -- R-2. create_order est EXACTEMENT le prédécesseur pré-CSDJ-3.
  select pg_catalog.count(*) into v_n
    from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'create_order';
  if v_n <> 1 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [CREATE_ORDER_FINGERPRINT] create_order a % surcharge(s), 1 attendue -- retour annulé.', v_n
      using errcode = '55000';
  end if;
  select pg_catalog.md5(pg_catalog.replace(p.prosrc, pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)))
    into v_md5
    from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)');
  if v_md5 is distinct from 'c327445751333e7908d60e6d7f838eb5' then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [CREATE_ORDER_FINGERPRINT] create_order n''est pas le prédécesseur pré-CSDJ-3 (md5 LF %, c327445751333e7908d60e6d7f838eb5 attendu) -- CSDJ-3 (ou une autre version) est probablement installé : le retirer d''abord.', coalesce(v_md5, '<absent>')
      using errcode = '55000';
  end if;

  -- R-3. Consommateurs du moteur, TOUS schémas non système (CSDJ12-RB02-CALLER-01).
  -- R-3a. La surface exacte du moteur, résolue PAR OID : c'est l'ensemble
  --       d'exclusion VÉRIFIÉ (aucune exemption par nom).
  select pg_catalog.array_agg(x.r::oid), pg_catalog.string_agg(x.s, ', ') filter (where x.r is null)
    into v_eng, v_miss
    from (select s, pg_catalog.to_regprocedure(s) as r from pg_catalog.unnest(v_eng_sigs) as s) x;
  if v_miss is not null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [ENGINE_SURFACE] objet(s) du moteur introuvable(s) : % -- état inattendu, aucune exclusion fiable possible.', v_miss
      using errcode = '55000';
  end if;
  select pg_catalog.array_agg(c.oid) into v_tab_oids
    from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any (v_tabs);
  if pg_catalog.cardinality(v_tab_oids) is distinct from pg_catalog.cardinality(v_tabs) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [ENGINE_SURFACE] tables du moteur : % trouvée(s) sur % attendues.', coalesce(pg_catalog.cardinality(v_tab_oids), 0), pg_catalog.cardinality(v_tabs)
      using errcode = '55000';
  end if;
  select pg_catalog.array_agg(t.oid) into v_typ_oids
    from pg_catalog.pg_type t
   where t.typrelid = any (v_tab_oids)
      or t.typelem in (select tt.oid from pg_catalog.pg_type tt where tt.typrelid = any (v_tab_oids));
  v_rfs := 'public.restaurant_fulfillment_schedule'::regclass::oid;
  select pg_catalog.array_agg(a.attnum) into v_attn
    from pg_catalog.pg_attribute a
   where a.attrelid = v_rfs and a.attname = any (v_cols) and not a.attisdropped;
  v_re := '\m(' || pg_catalog.array_to_string(v_names, '|') || ')\M';

  -- R-3b. Métadonnées de dépendance : tout objet qui dépend du moteur (par
  --       dépendance « normale ») sans faire PARTIE de ce que le retour retire
  --       lui-même (fermeture des dépendances auto/internes + les neuf
  --       contraintes et les cinq colonnes nommées).
  with recursive owned(classid, objid) as (
    select 'pg_proc'::regclass::oid, u from pg_catalog.unnest(v_eng) as u
    union
    select 'pg_class'::regclass::oid, u from pg_catalog.unnest(v_tab_oids) as u
    union
    select 'pg_type'::regclass::oid, u from pg_catalog.unnest(v_typ_oids) as u
    union
    select 'pg_constraint'::regclass::oid, c.oid
      from pg_catalog.pg_constraint c where c.conrelid = v_rfs and c.conname = any (v_cons)
    union
    select d.classid, d.objid from pg_catalog.pg_depend d
     where d.refclassid = 'pg_class'::regclass and d.refobjid = v_rfs and d.refobjsubid = any (v_attn)
       and d.deptype in ('a', 'i')
    union
    select d.classid, d.objid
      from pg_catalog.pg_depend d join owned o on d.refclassid = o.classid and d.refobjid = o.objid
     where d.deptype in ('a', 'i')
  )
  select pg_catalog.string_agg(distinct pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), '; ')
    into v_dep
    from pg_catalog.pg_depend d
   where d.deptype = 'n'
     and ((d.refclassid = 'pg_proc'::regclass and d.refobjid = any (v_eng))
       or (d.refclassid = 'pg_class'::regclass and (d.refobjid = any (v_tab_oids)
                                                     or (d.refobjid = v_rfs and d.refobjsubid = any (v_attn))))
       or (d.refclassid = 'pg_type'::regclass and d.refobjid = any (v_typ_oids)))
     and not exists (select 1 from owned o where o.classid = d.classid and o.objid = d.objid);
  if v_dep is not null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [ENGINE_DEPENDENT] des objets dépendent du moteur v1.2 (dépendance enregistrée par PostgreSQL) : % -- les retirer d''abord (ordre inverse du déploiement).', pg_catalog.left(v_dep, 400)
      using errcode = '55000';
  end if;

  -- R-3c. Texte de TOUTES les routines des schémas non système, moteur exclu
  --       par OID exact. (Un corps plpgsql ne déclare pas ses dépendances :
  --       c'est de l'inspection, pas une preuve -- voir la limite en tête.)
  create temp table csdj12_rb_routines on commit drop as
    select p.oid as oid,
           pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as sig,
           l.lanname::text as lanname,
           p.prosrc as prosrc,
           exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                      and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e') as is_ext
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
     where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
       and n.nspname !~ '^pg_(temp|toast_temp)_'
       and p.prokind in ('f', 'p')
       and l.lanname not in ('internal', 'c');
  select r.sig into v_hit
    from pg_temp.csdj12_rb_routines r
   where r.oid <> all (v_eng) and r.prosrc ~* v_re
   order by r.sig
   limit 1;
  if v_hit is not null then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [ENGINE_CALLER] la routine % cite un objet du moteur v1.2 -- la retirer d''abord (ordre inverse du déploiement). Le seul consommateur connu en base (create_order de CSDJ-3, inventaire docs/scheduling/csdj-v1.2-engine-consumers.json) est refusé plus tôt par les gardes CSDJ3_INSTALLED et CREATE_ORDER_FINGERPRINT : toute autre routine est un consommateur HORS INVENTAIRE.', v_hit
      using errcode = '55000';
  end if;
  -- R-3d. Tâches pg_cron (leur commande est du texte exécuté hors de toute routine).
  if pg_catalog.to_regclass('cron.job') is not null then
    execute 'select pg_catalog.string_agg(j.jobid::text, '', '' order by j.jobid) from cron.job j where j.command ~* $1'
      into v_cron using v_re;
    if v_cron is not null then
      raise exception 'SCANYM_ROLLBACK_REFUSED: [CRON_JOB] tâche(s) pg_cron citant un objet du moteur v1.2 (jobid % ) -- les retirer d''abord.', v_cron
        using errcode = '55000';
    end if;
  end if;

  select pg_catalog.count(*) into v_n from public.restaurant_fulfillment_schedule
   where schedule_method_version = 'v1.2';
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % planification(s) de méthode v1.2 -- repasser en v1 ou supprimer avant le retour.', v_n
      using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.restaurant_fulfillment_prep_day;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % jour(s) de préparation v1.2 -- supprimer avant le retour.', v_n using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.restaurant_fulfillment_prep_closure;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % fermeture(s) de préparation v1.2 -- supprimer avant le retour.', v_n using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.public_holiday_calendar;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % calendrier(s) férié(s) -- supprimer avant le retour.', v_n using errcode = '55000';
  end if;
  select pg_catalog.count(*) into v_n from public.order_fulfillment_capacity_reservation;
  if v_n > 0 then
    raise exception 'SCANYM_ROLLBACK_REFUSED: % réservation(s) de capacité -- ce sont des enregistrements de commande, le retour ne les détruit pas.', v_n
      using errcode = '55000';
  end if;

  -- R-4. Jeton de revue : ce que le texte ne peut pas démontrer (SQL dynamique,
  --      langages hors SQL/plpgsql, tâches planifiées) est énuméré et lié à un
  --      jeton calculé sur l'état exact relu par l'opérateur.
  select coalesce(pg_catalog.string_agg(r.sig || ':' || pg_catalog.md5(r.prosrc), ',' order by r.sig), ''),
         pg_catalog.count(*)
    into v_s2, v_n_dyn
    from pg_temp.csdj12_rb_routines r
   where r.oid <> all (v_eng) and not r.is_ext
     and (r.lanname not in ('sql', 'plpgsql') or r.prosrc ~* v_dyn_re);
  v_s3 := '';
  if pg_catalog.to_regclass('cron.job') is not null then
    execute 'select coalesce(pg_catalog.string_agg(j.jobid::text || '':'' || pg_catalog.md5(j.command), '','' order by j.jobid), '''') from cron.job j' into v_s3;
  end if;
  v_token := pg_catalog.md5(v_review_version || '|' || v_s2 || '|' || v_s3);
  v_mode  := coalesce(nullif(pg_catalog.current_setting('scanym.csdj12_rollback_mode', true), ''), 'apply');
  v_given := pg_catalog.current_setting('scanym.csdj12_rollback_review_token', true);
  select pg_catalog.count(distinct split_part(r.sig, '.', 1)) into v_n_schema from pg_temp.csdj12_rb_routines r;
  if v_mode = 'review' then
    select pg_catalog.string_agg(q.sig, E'\n  ' order by q.sig) into v_list
      from (select r.sig from pg_temp.csdj12_rb_routines r
             where r.oid <> all (v_eng) and not r.is_ext
               and (r.lanname not in ('sql', 'plpgsql') or r.prosrc ~* v_dyn_re)
             order by r.sig limit 60) q;
    raise notice E'SCANYM_ROLLBACK_REVIEW: % schéma(s) inspecté(s), % routine(s) dynamiques / hors SQL-plpgsql NON démontrables (liées au jeton)%, pg_cron : %.\n  %',
      v_n_schema, v_n_dyn, case when v_n_dyn > 60 then ' (60 premières listées)' else '' end,
      case when pg_catalog.to_regclass('cron.job') is not null then 'table cron.job présente (commandes liées au jeton)' else 'absent' end,
      coalesce(v_list, '(aucune)');
    raise exception 'SCANYM_ROLLBACK_REVIEW_ONLY: mode revue, AUCUNE modification. jeton = %', v_token
      using errcode = '55000';
  elsif v_mode <> 'apply' then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [MODE] scanym.csdj12_rollback_mode = « % » inconnu (review | apply).', v_mode
      using errcode = '55000';
  end if;
  if v_given is distinct from v_token then
    raise exception 'SCANYM_ROLLBACK_REFUSED: [REVIEW_TOKEN] jeton de revue absent ou périmé -- lancer le mode revue (set scanym.csdj12_rollback_mode = ''review'';), relire les % routine(s) non démontrables puis présenter le jeton (set scanym.csdj12_rollback_review_token = ''...'';).', v_n_dyn
      using errcode = '55000';
  end if;
end
$csdj12_rb_preflight$;

-- 1. Répartiteur -> ancien corps CSDJ-1 sous son nom d'origine.
drop function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone);
alter function public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)
  rename to resolve_fulfillment_schedule;

-- 2. Fonctions v1.2.
drop function public.get_merchant_fulfillment_schedules_v12(uuid);
drop function public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb);
drop function public.release_fulfillment_capacity(uuid);
drop function public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone);
drop function public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone);
drop function public.fulfillment_selection_reasons_v12();
drop function public.resolve_fulfillment_schedule_v12(uuid,text,uuid,timestamp with time zone,boolean);
drop function public.checkout_schedule_day_offers_v12(public.restaurant_fulfillment_schedule,date,timestamp with time zone);
drop function public.csdj12_availability_closed(public.restaurant_fulfillment_schedule,date);
drop function public.csdj12_preparation_open(public.restaurant_fulfillment_schedule,date);
drop function public.fulfillment_capacity_used(uuid,text,uuid,date,text);
drop function public.fulfillment_capacity_is_holding(text,text);
drop function public.checkout_unfulfillable_reasons_v12();

-- 3. Tables.
drop table public.order_fulfillment_capacity_reservation;
drop table public.restaurant_fulfillment_prep_closure;
drop table public.restaurant_fulfillment_prep_day;

-- 4. Colonnes et contraintes de la planification.
alter table public.restaurant_fulfillment_schedule
  drop constraint rfs_v12_extensions_only,
  drop constraint rfs_v12_no_cutoff_offset,
  drop constraint rfs_capacity_needs_date,
  drop constraint rfs_capacity_complete,
  drop constraint rfs_capacity_positive,
  drop constraint rfs_holiday_requires_calendar,
  drop constraint rfs_holiday_policy_values,
  drop constraint rfs_method_version_known,
  drop constraint rfs_holiday_calendar_fk;
alter table public.restaurant_fulfillment_schedule
  drop column capacity_max_orders,
  drop column capacity_enabled,
  drop column availability_on_holidays,
  drop column preparation_on_holidays,
  drop column holiday_calendar_id;

drop table public.public_holiday_calendar_day;
drop table public.public_holiday_calendar;

do $csdj12_rb_postflight$
begin
  if pg_catalog.to_regclass('public.restaurant_fulfillment_prep_day') is not null
     or pg_catalog.to_regclass('public.public_holiday_calendar') is not null
     or pg_catalog.to_regclass('public.order_fulfillment_capacity_reservation') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)') is null then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: état inattendu après le retour.';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
             where a.attrelid = 'public.restaurant_fulfillment_schedule'::regclass and not a.attisdropped
               and a.attname in ('holiday_calendar_id','preparation_on_holidays','availability_on_holidays',
                                 'capacity_enabled','capacity_max_orders')) then
    raise exception 'SCANYM_ROLLBACK_POSTFLIGHT: une colonne v1.2 subsiste.';
  end if;
end
$csdj12_rb_postflight$;

commit;
