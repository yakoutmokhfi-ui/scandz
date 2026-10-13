-- ============================================================
-- Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2)
-- Calendriers de préparation / disponibilité, heure limite + J+X,
-- jours fériés explicites, capacité optionnelle par créneau.
-- (DRAFT — NOT APPLIED — ne PAS appliquer sans GO d'intégration)
--
-- Parent : main 03441a5ef1d371e90e3bfe3438e1a29e211d0537
--          (CSDJ-1 v1.10 fusionné via #145, appliqué en PROD).
-- Rollback : DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql
--
-- ADDITIF. Ce fichier n'édite AUCUN objet CSDJ-1 existant, sauf UN
-- renommage de fonction interne (voir §D) :
--   - il AJOUTE 5 colonnes à restaurant_fulfillment_schedule ;
--   - il crée 5 tables : deux tables de calendrier de préparation, deux
--     tables de calendrier férié, une table de réservation de capacité ;
--   - il crée les fonctions v1.2 ;
--   - il RENOMME l'ancienne résolution interne
--     resolve_fulfillment_schedule -> resolve_fulfillment_schedule_v1
--     (corps INCHANGÉ, octet pour octet) et la remplace, sous le MÊME
--     nom, MÊME signature et MÊMES colonnes de sortie, par un
--     répartiteur. get_checkout_fulfillment_schedule (lecture publique,
--     19 colonnes) n'est PAS modifiée : le contrat de réponse CSDJ-1
--     est donc préservé tel quel.
--
-- COMPATIBILITÉ. Une planification existante garde
-- schedule_method_version = 'v1' et se comporte EXACTEMENT comme avant.
-- La méthode 'v1.2' est une activation EXPLICITE, par commerçant et par
-- portée, via mutate_merchant_fulfillment_schedule_v12. Ce fichier
-- n'active aucune planification, ne crée aucune ligne de configuration
-- et ne contient aucune donnée métier (aucun jour férié, aucun délai).
--
-- NE TOUCHE PAS : create_order, update_order_status, le moteur de
-- paiement, l'autorité de tarification (resolve_delivery_fulfillment).
-- L'intégration de la capacité dans create_order appartient à
-- Debussy (CSDJ-3) ; le contrat est dans
-- docs/scheduling/csdj-v1.2-interface-contract.md.
--
-- ATOMICITÉ : une seule transaction, pré-vol et post-vol dedans.
--
-- IDENTITÉ ET ÉTAT ATTENDUS (CSDJ12-DEPLOY-01, audit Cat Greco).
-- Le pré-vol REFUSE, avant toute création d'objet, si :
--   * l'exécutant (current_user) n'est pas « postgres » : les fonctions
--     SECURITY DEFINER créées ici appartiendraient à un autre rôle ;
--   * l'un des 10 prédécesseurs dont dépend ce fichier (résolveur CSDJ-1,
--     lecture publique, mutation marchande CSDJ-1, deux horloges, deux
--     catalogues de modes, trois helpers d'autorisation) diffère de l'état
--     attendu : signature, surcharge unique, propriétaire, SECURITY
--     DEFINER/INVOKER, volatilité, type de retour, empreinte du corps
--     (md5 de prosrc, fins de ligne LF -- un stockage CRLF est neutre),
--     proconfig COMPLET, ACL EXECUTE exacte (PUBLIC, bénéficiaire,
--     DONNEUR, option de transmission) et privilèges EFFECTIFS de anon /
--     authenticated / service_role (héritage de rôle compris) ;
--   * un rôle applicatif ou le propriétaire des tables modifiées manque.
-- Le post-vol REJOUE ces vérifications sur l'état FINAL (neuf prédécesseurs
-- inchangés, ancien résolveur sous _v1, 14 fonctions créées) et vérifie le
-- propriétaire des 5 tables créées. Une seule source d'état attendu : la
-- fonction temporaire pg_temp.csdj12_pin_drift (§0.1), supprimée avant COMMIT.
-- Les empreintes sont celles de la chaîne du DÉPÔT : à confirmer en lecture
-- seule sur la production AVANT toute application (voir
-- docs/scheduling/csdj-v1.2-deploy-rollback-order.md). Toute différence
-- ARRÊTE l'aller : c'est voulu.
-- ============================================================

begin;

-- ============================================================
-- §0.0  IDENTITÉ DE L'EXÉCUTANT — FAIL-CLOSED (CSDJ12-DEPLOY-01)
--
-- Les fonctions et tables créées plus bas appartiennent à celui qui
-- exécute ce fichier. Un autre rôle (même superutilisateur) produirait
-- des fonctions SECURITY DEFINER aux droits de ce rôle : refus, avant
-- toute création d'objet.
-- ============================================================
do $csdj12_identity$
begin
  if current_user::text is distinct from 'postgres' then
    raise exception 'SCANYM_DEPLOY_IDENTITY: exécutant « % » (session « % »), « postgres » exigé -- CSDJ v1.2 annulé AVANT toute création d''objet.',
      current_user, session_user
      using errcode = '42501';
  end if;
end
$csdj12_identity$;


-- ------------------------------------------------------------
-- §0.1  ÉTAT ATTENDU — UNE SEULE SOURCE pour le pré-vol ET le post-vol
--
-- Fonction TEMPORAIRE de la transaction (supprimée avant COMMIT, jamais
-- visible d'un autre rôle ; appels toujours qualifiés pg_temp.). Elle
-- porte la liste d'état attendu et rend le PREMIER écart, ou null.
--   pre / post : la ligne est attendue AVANT / APRÈS l'aller.
--   body_md5   : md5(prosrc), fins de ligne normalisées en LF (empreinte
--                canonique du contrat §12.1) ; null = non épinglé.
--   acl        : ACL EXECUTE canonique, « bénéficiaire/donneur:EXECUTE »
--                suivi de « * » si option de transmission ; PUBLIC y est
--                nommé ; tri en collation C.
--   eff        : privilèges EFFECTIFS (héritage de rôle compris).
--   cfg        : proconfig COMPLET.
-- Les 9 premiers prédécesseurs sont attendus identiques avant ET après ;
-- le résolveur d'origine disparaît (renommé _v1, MÊME objet, mêmes
-- empreintes) ; les 14 dernières lignes sont créées par ce fichier.
-- ------------------------------------------------------------
create function pg_temp.csdj12_pin_drift(p_phase text)
returns text
language plpgsql
set search_path = ''
as $csdj12_pin_drift$
declare
  r     record;
  p     pg_catalog.pg_proc%rowtype;
  v_acl text;
  v_eff text;
  v_n   integer;
begin
  for r in
    select * from (values
      ('public.checkout_date_selection_modes()', true, true, false, 'i', 'a5b6c7aec22eec94d8bb631f0d5704a6', 'ca4565a3ffb3900a3c3b067ddd5dd6e4', 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.checkout_slot_selection_modes()', true, true, false, 'i', 'a5b6c7aec22eec94d8bb631f0d5704a6', 'aaa030b1534604228b33316137b3aa1b', 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.checkout_wall_time_instant(date,time without time zone,text)', true, true, false, 's', '78a4814f9534f1fcc5c04078c5611170', 'e7027cdb3d9335662639f12944bf2cd9', 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.checkout_wall_time_status(date,time without time zone,text)', true, true, false, 's', '1cb251ec0d568de6a929b520c4aed8d1', '0573db4bd07175cfe64bf8b853cdd518', 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)', true, true, true, 's', '0abfaedfc70e960ccd5df080a960c3c5', '25531db35f35e705f2377fb1ac1bb014', 'anon/postgres:EXECUTE,authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=true,authenticated=true,service_role=false', 'search_path=""'),
      ('public.has_role_in(uuid,text[])', true, true, true, 's', '84e2c64f38f78ba3ea5c905ab5a2da27', 'a9ea76dd1c2408e2ad564e31c9b26a6b', 'authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=false,authenticated=true,service_role=false', 'search_path=""'),
      ('public.is_member_of(uuid)', true, true, true, 's', '84e2c64f38f78ba3ea5c905ab5a2da27', 'd7dd47ab77431fac5305206bf831f1cf', 'authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=false,authenticated=true,service_role=false', 'search_path=""'),
      ('public.is_scanym_operator()', true, true, true, 's', '84e2c64f38f78ba3ea5c905ab5a2da27', '84eaaadf0528c5ba96ac5ecf556651af', 'authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=false,authenticated=true,service_role=false', 'search_path=""'),
      ('public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)', true, true, true, 'v', 'cab8111fd0b710a336c898e539090e34', '7acf06d46ee72a85cbe79a6bff470782', 'authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=false,authenticated=true,service_role=false', 'search_path=""'),
      ('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)', true, false, true, 's', '344a3fee5fcbf2e6ee04872540f9a07b', '37491276589e0bc5c4dfe114177d2422', 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)', false, true, true, 's', '344a3fee5fcbf2e6ee04872540f9a07b', '37491276589e0bc5c4dfe114177d2422', 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.checkout_schedule_day_offers_v12(public.restaurant_fulfillment_schedule,date,timestamp with time zone)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.checkout_unfulfillable_reasons_v12()', false, true, false, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.csdj12_availability_closed(public.restaurant_fulfillment_schedule,date)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.csdj12_preparation_open(public.restaurant_fulfillment_schedule,date)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.fulfillment_capacity_is_holding(text,text)', false, true, false, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.fulfillment_capacity_used(uuid,text,uuid,date,text)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.fulfillment_selection_reasons_v12()', false, true, false, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.get_merchant_fulfillment_schedules_v12(uuid)', false, true, true, null, null, null, 'authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=false,authenticated=true,service_role=false', 'search_path=""'),
      ('public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)', false, true, true, null, null, null, 'authenticated/postgres:EXECUTE,postgres/postgres:EXECUTE', 'anon=false,authenticated=true,service_role=false', 'search_path=""'),
      ('public.release_fulfillment_capacity(uuid)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.resolve_fulfillment_schedule_v12(uuid,text,uuid,timestamp with time zone,boolean)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""'),
      ('public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone)', false, true, true, null, null, null, 'postgres/postgres:EXECUTE', 'anon=false,authenticated=false,service_role=false', 'search_path=""')
    ) as pin(sig, pre, post, secdef, vol, res_md5, body_md5, acl, eff, cfg)
    where (p_phase = 'pre' and pre) or (p_phase = 'post' and post)
    order by sig, pre
  loop
    select * into p from pg_catalog.pg_proc
     where oid = pg_catalog.to_regprocedure(r.sig)::pg_catalog.oid;
    if not found then
      return r.sig || ' : absente';
    end if;
    select pg_catalog.count(*) into v_n from pg_catalog.pg_proc o
     where o.pronamespace = p.pronamespace and o.proname = p.proname;
    if v_n <> 1 then
      return pg_catalog.format('%s : %s surcharge(s) du même nom, 1 attendue', r.sig, v_n);
    end if;
    if pg_catalog.pg_get_userbyid(p.proowner)::text <> 'postgres' then
      return pg_catalog.format('%s : propriétaire « %s », « postgres » attendu', r.sig, pg_catalog.pg_get_userbyid(p.proowner));
    end if;
    if p.prosecdef is distinct from r.secdef then
      return pg_catalog.format('%s : %s, %s attendu', r.sig,
        case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end,
        case when r.secdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end);
    end if;
    if r.vol is not null and p.provolatile::pg_catalog.text is distinct from r.vol then
      return pg_catalog.format('%s : volatilité « %s », « %s » attendue', r.sig, p.provolatile, r.vol);
    end if;
    if coalesce(pg_catalog.array_to_string(p.proconfig, ','), '<null-config>') <> r.cfg then
      return pg_catalog.format('%s : proconfig « %s », « %s » attendu', r.sig,
        coalesce(pg_catalog.array_to_string(p.proconfig, ','), '<null-config>'), r.cfg);
    end if;
    if r.res_md5 is not null and pg_catalog.md5(pg_catalog.pg_get_function_result(p.oid)) <> r.res_md5 then
      return pg_catalog.format('%s : type de retour modifié (%s)', r.sig, pg_catalog.pg_get_function_result(p.oid));
    end if;
    if r.body_md5 is not null
       and pg_catalog.md5(pg_catalog.replace(p.prosrc, pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10))) <> r.body_md5 then
      return pg_catalog.format('%s : corps modifié (md5 LF %s, %s attendu)', r.sig,
        pg_catalog.md5(pg_catalog.replace(p.prosrc, pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10))), r.body_md5);
    end if;
    select coalesce(pg_catalog.string_agg(x.e, ',' order by x.e collate "C"), '<null-acl>') into v_acl
      from (select (case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end)
                   || '/' || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type
                   || (case when a.is_grantable then '*' else '' end) as e
              from pg_catalog.aclexplode(p.proacl) a) x;
    if v_acl <> r.acl then
      return pg_catalog.format('%s : ACL « %s », « %s » attendue', r.sig, v_acl, r.acl);
    end if;
    v_eff := 'anon=' || pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')::text
          || ',authenticated=' || pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
          || ',service_role=' || pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')::text;
    if v_eff <> r.eff then
      return pg_catalog.format('%s : privilèges effectifs « %s », « %s » attendus', r.sig, v_eff, r.eff);
    end if;
  end loop;
  return null;
end
$csdj12_pin_drift$;

-- ============================================================
-- §0  PRÉ-VOL ANTI-DÉRIVE — FAIL-CLOSED, DANS LA TRANSACTION
-- ============================================================
do $csdj12_preflight$
declare
  v_item  text;
  v_n     integer;
  v_drift text;
begin
  -- P-1. Tables prérequises (CSDJ-1 + commandes).
  foreach v_item in array array[
    'public.restaurant_fulfillment_schedule',
    'public.restaurant_fulfillment_schedule_window',
    'public.restaurant_fulfillment_schedule_slot',
    'public.restaurant_fulfillment_schedule_closure',
    'public.orders'
  ] loop
    if pg_catalog.to_regclass(v_item) is null then
      raise exception 'SCANYM_SCHEMA_DRIFT: table prérequise % absente -- CSDJ v1.2 annulé.', v_item
        using errcode = '42P01';
    end if;
  end loop;

  -- P-2. Fonctions prérequises.
  foreach v_item in array array[
    'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)',
    'public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)',
    'public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)',
    'public.checkout_wall_time_instant(date,time without time zone,text)',
    'public.checkout_wall_time_status(date,time without time zone,text)',
    'public.has_role_in(uuid,text[])',
    'public.is_member_of(uuid)',
    'public.is_scanym_operator()'
  ] loop
    if pg_catalog.to_regprocedure(v_item) is null then
      raise exception 'SCANYM_SCHEMA_DRIFT: fonction prérequise % absente -- CSDJ v1.2 annulé.', v_item
        using errcode = '42883';
    end if;
  end loop;

  -- P-3. Colonnes de commande dont dépend la notion de « place tenue ».
  --      payment_status vient de PAYMENT P1 : s'il n'est pas appliqué,
  --      la fonction de décompte échouerait À L'EXÉCUTION, en
  --      production. On refuse donc ICI.
  foreach v_item in array array['id=uuid','restaurant_id=uuid','status=text','payment_status=text'] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = 'public.orders'::regclass
        and a.attname = pg_catalog.split_part(v_item, '=', 1)
        and pg_catalog.format_type(a.atttypid, null) = pg_catalog.split_part(v_item, '=', 2)
        and not a.attisdropped
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: orders.% absent ou de type inattendu -- CSDJ v1.2 annulé AVANT toute création d''objet.', v_item
        using errcode = '42804';
    end if;
  end loop;

  -- P-4. Forme EXACTE de la sortie du résolveur CSDJ-1 (catalogue, pas
  --      sous-chaîne) : le répartiteur doit la reproduire à l'identique.
  foreach v_item in array array[
    'status=text','unfulfillable_reason=text','schedule_timezone=text',
    'date_selection_mode=text','slot_selection_mode=text',
    'time_granularity_minutes=smallint','first_eligible_date=date',
    'eligible_dates=date[]','offers=jsonb'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p,
      unnest(p.proargnames, p.proargmodes, p.proallargtypes) as a(argname, argmode, argtype)
      where p.oid = pg_catalog.to_regprocedure(
              'public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)')
        and a.argmode = 't'
        and a.argname = pg_catalog.split_part(v_item, '=', 1)
        and pg_catalog.format_type(a.argtype, null) = pg_catalog.split_part(v_item, '=', 2)
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: resolve_fulfillment_schedule ne renvoie pas la colonne attendue « % » -- CSDJ v1.2 annulé.', v_item
        using errcode = '42804';
    end if;
  end loop;

  select pg_catalog.count(*) into v_n
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_fulfillment_schedule';
  if v_n <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: resolve_fulfillment_schedule a % surcharge(s), 1 attendue -- CSDJ v1.2 annulé.', v_n
      using errcode = '42723';
  end if;

  -- P-5. Anti-double-application : aucun objet v1.2 ne doit exister.
  if pg_catalog.to_regclass('public.restaurant_fulfillment_prep_day') is not null
     or pg_catalog.to_regclass('public.restaurant_fulfillment_prep_closure') is not null
     or pg_catalog.to_regclass('public.public_holiday_calendar') is not null
     or pg_catalog.to_regclass('public.public_holiday_calendar_day') is not null
     or pg_catalog.to_regclass('public.order_fulfillment_capacity_reservation') is not null
     or pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule_v1(uuid,text,uuid,timestamp with time zone)') is not null
     or pg_catalog.to_regprocedure('public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone)') is not null
     or pg_catalog.to_regprocedure('public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone)') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = 'public.restaurant_fulfillment_schedule'::regclass
                  and a.attname in ('holiday_calendar_id','preparation_on_holidays',
                                    'availability_on_holidays','capacity_enabled','capacity_max_orders')
                  and not a.attisdropped)
  then
    raise exception 'SCANYM_ALREADY_APPLIED: un objet de CSDJ v1.2 existe déjà -- annulé.'
      using errcode = '42710';
  end if;

  -- P-6. Toute planification existante est de méthode 'v1' : la
  --      contrainte ajoutée plus bas n'en invalide aucune.
  if exists (select 1 from public.restaurant_fulfillment_schedule s
             where s.schedule_method_version is distinct from 'v1') then
    raise exception 'SCANYM_SCHEMA_DRIFT: une planification porte une méthode autre que v1 -- CSDJ v1.2 annulé.'
      using errcode = '23514';
  end if;

  -- P-7. Base de fuseaux IANA utilisable.
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = 'Europe/Paris') then
    raise exception 'SCANYM_SCHEMA_DRIFT: la base de fuseaux IANA du serveur est inutilisable -- CSDJ v1.2 annulé.'
      using errcode = '58000';
  end if;

  -- P-8. Rôles applicatifs : sans eux les privilèges effectifs sont
  --      indécidables (CSDJ12-DEPLOY-01).
  foreach v_item in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v_item) then
      raise exception 'SCANYM_SCHEMA_DRIFT: rôle applicatif % absent -- CSDJ v1.2 annulé.', v_item
        using errcode = '42704';
    end if;
  end loop;

  -- P-9. Les tables que l'aller MODIFIE (ALTER TABLE, clés étrangères) ou
  --      référence appartiennent à « postgres » (le seul exécutant admis).
  foreach v_item in array array[
    'public.restaurant_fulfillment_schedule',
    'public.restaurant_fulfillment_schedule_window',
    'public.restaurant_fulfillment_schedule_slot',
    'public.restaurant_fulfillment_schedule_closure',
    'public.orders'
  ] loop
    if (select pg_catalog.pg_get_userbyid(c.relowner)::text
          from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_item)) is distinct from 'postgres' then
      raise exception 'SCANYM_SCHEMA_DRIFT: la table % n''appartient pas à « postgres » -- CSDJ v1.2 annulé.', v_item
        using errcode = '55000';
    end if;
  end loop;

  -- P-10. Identité EXACTE des 10 prédécesseurs (signature, surcharge
  --       unique, propriétaire, SECURITY, volatilité, type de retour,
  --       empreinte du corps, proconfig complet, ACL exacte -- PUBLIC,
  --       donneur, option de transmission -- et privilèges effectifs).
  v_drift := pg_temp.csdj12_pin_drift('pre');
  if v_drift is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: prédécesseur dérivé -- % -- CSDJ v1.2 annulé AVANT toute création d''objet.', v_drift
      using errcode = '55000';
  end if;
end
$csdj12_preflight$;

-- ============================================================
-- §A  CALENDRIERS FÉRIÉS — STRUCTURE SEULE, AUCUNE DONNÉE
--
-- Aucune juridiction n'est choisie, aucun jeu de données n'est livré.
-- Les tables sont VIDES. Les peupler est une décision de produit
-- (voir docs/scheduling/csdj-v1.2-architecture.md §5). Tant qu'aucun
-- calendrier n'est rattaché à une planification ET qu'une politique
-- « closed » n'est pas posée, aucun jour n'est traité comme férié.
-- ============================================================
create table public.public_holiday_calendar (
  id           uuid primary key default pg_catalog.gen_random_uuid(),
  code         text not null unique
               check (pg_catalog.length(code) between 1 and 60 and code ~ '^[a-z0-9_-]+$'),
  label        text not null
               check (pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  region_code  text check (region_code is null or region_code ~ '^[A-Z0-9-]{1,10}$'),
  created_at   timestamptz not null default pg_catalog.now(),
  -- une région n'a de sens que dans un pays
  constraint phc_region_needs_country check (region_code is null or country_code is not null)
);

create table public.public_holiday_calendar_day (
  calendar_id uuid not null references public.public_holiday_calendar (id) on delete cascade,
  holiday_on  date not null,
  label       text check (label is null or pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  primary key (calendar_id, holiday_on)
);

comment on table public.public_holiday_calendar is
  'CSDJ v1.2 — calendriers de jours fériés NOMMÉS (pays/région optionnels). Table VIDE à la livraison : aucun jeu de données, aucune juridiction supposée.';

-- ============================================================
-- §B  PLANIFICATION : colonnes v1.2 et contraintes
-- ============================================================
alter table public.restaurant_fulfillment_schedule
  add column holiday_calendar_id       uuid,
  add column preparation_on_holidays   text    not null default 'open',
  add column availability_on_holidays  text    not null default 'open',
  add column capacity_enabled          boolean not null default false,
  add column capacity_max_orders       integer;

alter table public.restaurant_fulfillment_schedule
  add constraint rfs_holiday_calendar_fk
    foreign key (holiday_calendar_id) references public.public_holiday_calendar (id) on delete restrict,
  add constraint rfs_method_version_known
    check (schedule_method_version in ('v1', 'v1.2')),
  add constraint rfs_holiday_policy_values
    check (preparation_on_holidays in ('open', 'closed') and availability_on_holidays in ('open', 'closed')),
  -- Une politique « closed » sans calendrier ne ferme rien : on la refuse
  -- plutôt que de la laisser avoir l'air active.
  add constraint rfs_holiday_requires_calendar
    check (holiday_calendar_id is not null
           or (preparation_on_holidays = 'open' and availability_on_holidays = 'open')),
  add constraint rfs_capacity_positive
    check (capacity_max_orders is null or capacity_max_orders > 0),
  add constraint rfs_capacity_complete
    check (not capacity_enabled or capacity_max_orders is not null),
  add constraint rfs_capacity_needs_date
    check (not capacity_enabled or date_selection_mode <> 'informational_only'),
  -- En v1.2 le décalage de l'heure limite n'existe plus : l'origine se
  -- déplace sur le prochain jour de préparation. Un réglage ignoré en
  -- silence serait une deuxième autorité ; il est donc REFUSÉ.
  add constraint rfs_v12_no_cutoff_offset
    check (schedule_method_version <> 'v1.2' or cutoff_offset_days = 0),
  -- Les extensions v1.2 n'existent que pour la méthode v1.2 (jamais un
  -- réglage de capacité ou de férié posé sur une planification v1 qui
  -- l'ignorerait).
  add constraint rfs_v12_extensions_only
    check (schedule_method_version = 'v1.2'
           or (holiday_calendar_id is null and capacity_enabled = false));

-- ============================================================
-- §C  TABLES v1.2
-- ============================================================
create table public.restaurant_fulfillment_prep_day (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  weekday       smallint not null check (weekday between 0 and 6),
  primary key (restaurant_id, mode_code, rule_key, weekday),
  constraint rfpd_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade
);

create table public.restaurant_fulfillment_prep_closure (
  restaurant_id uuid not null,
  mode_code     text not null,
  rule_key      uuid not null,
  closed_on     date not null,
  label         text check (label is null or pg_catalog.length(pg_catalog.btrim(label)) between 1 and 120),
  primary key (restaurant_id, mode_code, rule_key, closed_on),
  constraint rfpc_schedule_fk
    foreign key (restaurant_id, mode_code, rule_key)
    references public.restaurant_fulfillment_schedule (restaurant_id, mode_code, rule_key)
    on delete cascade
);

comment on table public.restaurant_fulfillment_prep_day is
  'CSDJ v1.2 — CALENDRIER DE PRÉPARATION : jours de la semaine où le commerçant prépare (0 = dimanche). Indépendant des fenêtres/créneaux, qui sont le calendrier de DISPONIBILITÉ client.';
comment on table public.restaurant_fulfillment_prep_closure is
  'CSDJ v1.2 — fermetures exceptionnelles de PRÉPARATION (journée entière). Les fermetures de disponibilité restent dans restaurant_fulfillment_schedule_closure.';

-- Réservation de capacité : UNE commande = UNE unité, quelle que soit la
-- quantité de produits. La ligne ne dit pas « place tenue » : c'est la
-- jointure avec la commande (fulfillment_capacity_is_holding) qui le dit,
-- donc une commande refusée/annulée libère sa place sans qu'aucun
-- appelant n'ait à « libérer » quoi que ce soit.
create table public.order_fulfillment_capacity_reservation (
  order_id         uuid primary key references public.orders (id) on delete cascade,
  restaurant_id    uuid not null,
  mode_code        text not null,
  rule_key         uuid not null,
  fulfillment_date date not null,
  slot_key         text not null default ''
                   check (slot_key = '' or (pg_catalog.length(slot_key) between 1 and 40 and slot_key ~ '^[a-z0-9_-]+$')),
  created_at       timestamptz not null default pg_catalog.now()
);

create index order_fulfillment_capacity_reservation_bucket_idx
  on public.order_fulfillment_capacity_reservation
  (restaurant_id, mode_code, rule_key, fulfillment_date, slot_key);

comment on table public.order_fulfillment_capacity_reservation is
  'CSDJ v1.2 — une ligne par commande ayant consommé UNE unité de capacité. Écrite uniquement par reserve_fulfillment_capacity (seule autorité transactionnelle). Aucun accès direct pour aucun rôle applicatif.';

-- ------------------------------------------------------------
-- RLS et GRANTS — revoke AVANT grant
-- ------------------------------------------------------------
alter table public.public_holiday_calendar               enable row level security;
alter table public.public_holiday_calendar_day           enable row level security;
alter table public.restaurant_fulfillment_prep_day       enable row level security;
alter table public.restaurant_fulfillment_prep_closure   enable row level security;
alter table public.order_fulfillment_capacity_reservation enable row level security;

revoke all on table public.public_holiday_calendar                from public, anon, authenticated, service_role;
revoke all on table public.public_holiday_calendar_day            from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_prep_day        from public, anon, authenticated, service_role;
revoke all on table public.restaurant_fulfillment_prep_closure    from public, anon, authenticated, service_role;
revoke all on table public.order_fulfillment_capacity_reservation from public, anon, authenticated, service_role;

grant select on table public.public_holiday_calendar              to authenticated;
grant select on table public.public_holiday_calendar_day          to authenticated;
grant select on table public.restaurant_fulfillment_prep_day      to authenticated;
grant select on table public.restaurant_fulfillment_prep_closure  to authenticated;
-- order_fulfillment_capacity_reservation : AUCUN grant.

-- Calendriers fériés : données de référence, non rattachées à un tenant.
create policy phc_select_authenticated on public.public_holiday_calendar
  for select to authenticated using (true);
create policy phcd_select_authenticated on public.public_holiday_calendar_day
  for select to authenticated using (true);

create policy rfpd_select_members on public.restaurant_fulfillment_prep_day
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_prep_day.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

create policy rfpc_select_members on public.restaurant_fulfillment_prep_closure
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_users ru
      where ru.restaurant_id = restaurant_fulfillment_prep_closure.restaurant_id
        and ru.user_id = auth.uid()
    )
    or public.is_scanym_operator()
  );

-- ============================================================
-- §D  FONCTIONS INTERNES (aucun accès pour aucun rôle applicatif)
-- ============================================================

-- Catalogue FERMÉ des motifs d'infaisabilité, version 1.2 : les cinq
-- motifs CSDJ-1 (dans le même ordre) puis les motifs v1.2.
create function public.checkout_unfulfillable_reasons_v12()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'no_offer_configured','granularity_missing','all_dates_closed',
    'horizon_exhausted','no_offer_in_horizon',
    'preparation_calendar_missing','no_preparation_day_in_horizon',
    'cutoff_unresolvable','capacity_exhausted'
  ]::text[];
$$;

-- Une place est TENUE tant que la commande n'est ni refusée ni annulée.
--
-- Le statut de PAIEMENT n'entre PAS dans la décision, volontairement :
--   * « pending » tient la place : aucune expiration n'est inventée ici
--     (décision CTO requise, voir l'architecture §6) ;
--   * « failed » / « cancelled » la tiennent AUSSI. Une nouvelle tentative
--     de paiement reste possible sur la même commande
--     (initiate_payment_attempt ne refuse que paid/pending) et remet
--     payment_status à « pending » : si la place avait été rendue entre
--     temps, la reprise la REPRENDRAIT sans contrôle et le créneau serait
--     surréservé. Rendre la place sur échec de paiement exige donc un
--     contrôle de capacité à la reprise, c'est-à-dire un point
--     d'intégration dans le moteur de paiement, qui n'est pas à ce lot.
--     Le primitif de libération explicite existe
--     (release_fulfillment_capacity) ; son branchement est la décision.
-- Le second paramètre est conservé pour que la politique approuvée ne
-- change QUE ce corps de fonction.
create function public.fulfillment_capacity_is_holding(p_status text, p_payment_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status is distinct from 'rejected'
     and p_status is distinct from 'cancelled';
$$;

create function public.fulfillment_capacity_used(
  p_restaurant_id uuid, p_mode_code text, p_rule_key uuid, p_date date, p_slot_key text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from public.order_fulfillment_capacity_reservation r
  join public.orders o on o.id = r.order_id
  where r.restaurant_id = p_restaurant_id
    and r.mode_code = p_mode_code
    and r.rule_key = p_rule_key
    and r.fulfillment_date = p_date
    and r.slot_key = coalesce(p_slot_key, '')
    and public.fulfillment_capacity_is_holding(o.status, o.payment_status);
$$;

create function public.csdj12_preparation_open(
  p_s public.restaurant_fulfillment_schedule, p_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.restaurant_fulfillment_prep_day d
           where d.restaurant_id = p_s.restaurant_id and d.mode_code = p_s.mode_code
             and d.rule_key = p_s.rule_key
             and d.weekday = pg_catalog.date_part('dow', p_date)::smallint)
     and not exists (
           select 1 from public.restaurant_fulfillment_prep_closure c
           where c.restaurant_id = p_s.restaurant_id and c.mode_code = p_s.mode_code
             and c.rule_key = p_s.rule_key and c.closed_on = p_date)
     and not (
           p_s.preparation_on_holidays = 'closed'
           and p_s.holiday_calendar_id is not null
           and exists (select 1 from public.public_holiday_calendar_day h
                       where h.calendar_id = p_s.holiday_calendar_id and h.holiday_on = p_date));
$$;

create function public.csdj12_availability_closed(
  p_s public.restaurant_fulfillment_schedule, p_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.restaurant_fulfillment_schedule_closure c
           where c.restaurant_id = p_s.restaurant_id and c.mode_code = p_s.mode_code
             and c.rule_key = p_s.rule_key and c.closed_on = p_date)
      or (p_s.availability_on_holidays = 'closed'
          and p_s.holiday_calendar_id is not null
          and exists (select 1 from public.public_holiday_calendar_day h
                      where h.calendar_id = p_s.holiday_calendar_id and h.holiday_on = p_date));
$$;

-- Offres d'UNE date : construction REPRISE VERBATIM du résolveur CSDJ-1
-- v1.10 (occurrence tout-ou-rien, grille validée, instant minimal). Seuls
-- les noms de variables changent. Elle ne connaît NI heure limite, NI
-- fermeture, NI capacité : ces décisions sont prises par l'appelant.
create function public.checkout_schedule_day_offers_v12(
  p_s public.restaurant_fulfillment_schedule, p_date date, p_min_instant timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_day$
declare
  v_uses_slots boolean := (p_s.slot_selection_mode = 'fixed_slots');
  v_day        jsonb := '[]'::jsonb;
  v_off        record;
  v_start_min  integer;
  v_end_min    integer;
  v_t          integer;
  v_pick       integer;
  v_grid_sound boolean;
  v_inst       timestamptz;
begin
  for v_off in
    select * from (
      select x.slot_key, x.starts_at, x.ends_at
      from public.restaurant_fulfillment_schedule_slot x
      where v_uses_slots
        and x.restaurant_id = p_s.restaurant_id and x.mode_code = p_s.mode_code
        and x.rule_key = p_s.rule_key
        and x.weekday = pg_catalog.date_part('dow', p_date)::smallint
      union all
      select null::text, w.starts_at, w.ends_at
      from public.restaurant_fulfillment_schedule_window w
      where not v_uses_slots
        and w.restaurant_id = p_s.restaurant_id and w.mode_code = p_s.mode_code
        and w.rule_key = p_s.rule_key
        and w.weekday = pg_catalog.date_part('dow', p_date)::smallint
    ) o
    order by o.starts_at, coalesce(o.slot_key, '')
  loop
    v_start_min := pg_catalog.date_part('hour', v_off.starts_at)::integer * 60
                 + pg_catalog.date_part('minute', v_off.starts_at)::integer;
    v_end_min   := pg_catalog.date_part('hour', v_off.ends_at)::integer * 60
                 + pg_catalog.date_part('minute', v_off.ends_at)::integer;

    -- CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01 (repris)
    if public.checkout_wall_time_status(p_date, v_off.ends_at, p_s.timezone)
         <> 'valid_unique' then
      continue;
    end if;

    if p_s.slot_selection_mode = 'time_within_window' then
      v_pick := null;
      v_grid_sound := true;
      v_t := v_start_min;
      while v_t < v_end_min loop
        if public.checkout_wall_time_status(
             p_date, pg_catalog.make_time(v_t / 60, v_t % 60, 0), p_s.timezone)
           <> 'valid_unique' then
          v_grid_sound := false;
          exit;
        end if;
        if v_pick is null then
          v_inst := public.checkout_wall_time_instant(
            p_date, pg_catalog.make_time(v_t / 60, v_t % 60, 0), p_s.timezone);
          if v_inst is not null and v_inst >= p_min_instant then
            v_pick := v_t;
          end if;
        end if;
        v_t := v_t + p_s.time_granularity_minutes;
      end loop;
      if not v_grid_sound or v_pick is null then
        continue;
      end if;
      v_day := v_day || pg_catalog.jsonb_build_object(
        'slot_key', null,
        'starts_at', pg_catalog.to_char(pg_catalog.make_time(v_pick / 60, v_pick % 60, 0), 'HH24:MI'),
        'ends_at', pg_catalog.to_char(v_off.ends_at, 'HH24:MI'));
      continue;
    end if;

    v_inst := public.checkout_wall_time_instant(p_date, v_off.starts_at, p_s.timezone);
    if v_inst is null or v_inst < p_min_instant then
      continue;
    end if;
    v_day := v_day || pg_catalog.jsonb_build_object(
      'slot_key', v_off.slot_key,
      'starts_at', pg_catalog.to_char(v_off.starts_at, 'HH24:MI'),
      'ends_at', pg_catalog.to_char(v_off.ends_at, 'HH24:MI'));
  end loop;
  return v_day;
end
$csdj12_day$;

-- ============================================================
-- §E  RÉSOLUTION v1.2 — AUTORITÉ SERVEUR
--
--   1. origine : aujourd'hui si c'est un jour de préparation ET que
--      l'heure limite n'est pas atteinte ; sinon le prochain jour de
--      préparation STRICTEMENT postérieur. Heure limite atteinte =
--      « maintenant >= limite » (l'instant exact compte comme atteint).
--      Un jour sans préparation ne consulte pas l'heure limite.
--   2. J+X : cible = origine + min_lead_days, en jours CALENDAIRES.
--   3. de la cible à l'horizon, on retient les dates qui ont une offre,
--      ne sont ni fermées en disponibilité ni fériées-fermées, et dont
--      au moins une offre survit à l'instant minimal ; « avancer
--      jusqu'à la prochaine date éligible » est ce parcours.
--   4. capacité (si activée et demandée) : une offre pleine est retirée,
--      une date sans offre restante est retirée. Aucun compte exposé.
--   Aucune date n'est inventée, aucun repli silencieux : un refus a un
--   motif nommé.
-- ============================================================
create function public.resolve_fulfillment_schedule_v12(
  p_restaurant_id uuid,
  p_mode_code text,
  p_fulfillment_rule_id uuid default null,
  p_now timestamptz default pg_catalog.now(),
  p_apply_capacity boolean default true
)
returns table (
  status                   text,
  unfulfillable_reason     text,
  schedule_timezone        text,
  date_selection_mode      text,
  slot_selection_mode      text,
  time_granularity_minutes smallint,
  first_eligible_date      date,
  eligible_dates           date[],
  offers                   jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_resolve$
declare
  v_s            public.restaurant_fulfillment_schedule;
  v_rule_key     uuid := coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_uses_slots   boolean;
  v_has_offer    boolean;
  v_today        date;
  v_last         date;
  v_origin       date;
  v_target       date;
  v_d            date;
  v_cut_at       timestamptz;
  v_cut_reached  boolean := false;
  v_floor        timestamptz;
  v_min_instant  timestamptz;
  v_day          jsonb;
  v_kept         jsonb;
  v_el           jsonb;
  v_dates        date[] := array[]::date[];
  v_offers       jsonb := '{}'::jsonb;
  v_saw_closure  boolean := false;
  v_saw_open     boolean := false;
  v_saw_full     boolean := false;
begin
  select * into v_s
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code and s.rule_key = v_rule_key;

  if not found or v_s.enabled is not true then
    return query select 'absent'::text, null::text, null::text, null::text, null::text,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_s.schedule_method_version <> 'v1.2' then
    raise exception 'CSDJ12_WRONG_METHOD: resolve_fulfillment_schedule_v12 appelée sur une planification de méthode %.', v_s.schedule_method_version
      using errcode = '22023';
  end if;

  if v_s.date_selection_mode = 'informational_only' then
    return query select 'informational_only'::text, null::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  v_uses_slots := (v_s.slot_selection_mode = 'fixed_slots');

  if v_s.slot_selection_mode = 'time_within_window' and v_s.time_granularity_minutes is null then
    return query select 'unfulfillable'::text, 'granularity_missing'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        null::smallint, null::date, null::date[], null::jsonb;
    return;
  end if;

  if v_uses_slots then
    select exists (select 1 from public.restaurant_fulfillment_schedule_slot x
                   where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
                     and x.rule_key = v_rule_key) into v_has_offer;
  else
    select exists (select 1 from public.restaurant_fulfillment_schedule_window x
                   where x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
                     and x.rule_key = v_rule_key) into v_has_offer;
  end if;
  if not v_has_offer then
    return query select 'unfulfillable'::text, 'no_offer_configured'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  -- Un calendrier de préparation VIDE est une configuration impossible,
  -- pas un « tous les jours » implicite.
  if not exists (select 1 from public.restaurant_fulfillment_prep_day d
                 where d.restaurant_id = p_restaurant_id and d.mode_code = p_mode_code
                   and d.rule_key = v_rule_key) then
    return query select 'unfulfillable'::text, 'preparation_calendar_missing'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  v_today := (p_now at time zone v_s.timezone)::date;
  v_last  := v_today + v_s.booking_horizon_days;

  -- ── 1. ORIGINE ────────────────────────────────────────────
  if public.csdj12_preparation_open(v_s, v_today) then
    if v_s.cutoff_time is not null then
      v_cut_at := public.checkout_wall_time_instant(v_today, v_s.cutoff_time, v_s.timezone);
      if v_cut_at is null then
        -- L'heure limite d'aujourd'hui tombe sur une heure murale
        -- inexistante ou ambiguë : on ne devine pas sa position.
        return query select 'unfulfillable'::text, 'cutoff_unresolvable'::text, v_s.timezone,
                            v_s.date_selection_mode, v_s.slot_selection_mode,
                            case when v_s.slot_selection_mode = 'time_within_window'
                                 then v_s.time_granularity_minutes end,
                            null::date, null::date[], null::jsonb;
        return;
      end if;
      v_cut_reached := (p_now >= v_cut_at);
    end if;
  end if;

  if public.csdj12_preparation_open(v_s, v_today) and not v_cut_reached then
    v_origin := v_today;
  else
    v_d := v_today + 1;
    while v_d <= v_last loop
      if public.csdj12_preparation_open(v_s, v_d) then
        v_origin := v_d;
        exit;
      end if;
      v_d := v_d + 1;
    end loop;
    if v_origin is null then
      return query select 'unfulfillable'::text, 'no_preparation_day_in_horizon'::text, v_s.timezone,
                          v_s.date_selection_mode, v_s.slot_selection_mode,
                          case when v_s.slot_selection_mode = 'time_within_window'
                               then v_s.time_granularity_minutes end,
                          null::date, null::date[], null::jsonb;
      return;
    end if;
  end if;

  -- ── 2. J+X, en jours calendaires depuis l'origine ─────────
  v_target := v_origin + v_s.min_lead_days;
  if v_target > v_last then
    return query select 'unfulfillable'::text, 'horizon_exhausted'::text, v_s.timezone,
                        v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  -- ── 3. instant minimal (repris de CSDJ-V1-OFFER-START-INSTANT-01) ──
  v_floor := public.checkout_wall_time_instant(v_target, '00:00'::time, v_s.timezone);
  v_min_instant := greatest(
    p_now + pg_catalog.make_interval(mins => v_s.lead_time_minutes),
    coalesce(v_floor, p_now + pg_catalog.make_interval(mins => v_s.lead_time_minutes)));

  v_d := v_target;
  while v_d <= v_last loop
    if not exists (
      select 1 from (
        select x.weekday from public.restaurant_fulfillment_schedule_slot x
        where v_uses_slots and x.restaurant_id = p_restaurant_id and x.mode_code = p_mode_code
          and x.rule_key = v_rule_key
        union all
        select w.weekday from public.restaurant_fulfillment_schedule_window w
        where not v_uses_slots and w.restaurant_id = p_restaurant_id and w.mode_code = p_mode_code
          and w.rule_key = v_rule_key
      ) o where o.weekday = pg_catalog.date_part('dow', v_d)::smallint
    ) then
      v_d := v_d + 1;
      continue;
    end if;

    if public.csdj12_availability_closed(v_s, v_d) then
      v_saw_closure := true;
      v_d := v_d + 1;
      continue;
    end if;

    v_saw_open := true;
    v_day := public.checkout_schedule_day_offers_v12(v_s, v_d, v_min_instant);
    if pg_catalog.jsonb_array_length(v_day) = 0 then
      v_d := v_d + 1;
      continue;
    end if;

    -- ── 4. capacité : filtrage, jamais de compte exposé ──────
    if p_apply_capacity and v_s.capacity_enabled then
      if v_uses_slots then
        v_kept := '[]'::jsonb;
        for v_el in select * from pg_catalog.jsonb_array_elements(v_day) loop
          if public.fulfillment_capacity_used(
               p_restaurant_id, p_mode_code, v_rule_key, v_d, v_el->>'slot_key')
             < v_s.capacity_max_orders then
            v_kept := v_kept || pg_catalog.jsonb_build_array(v_el);
          end if;
        end loop;
        v_day := v_kept;
      elsif public.fulfillment_capacity_used(p_restaurant_id, p_mode_code, v_rule_key, v_d, '')
            >= v_s.capacity_max_orders then
        v_day := '[]'::jsonb;
      end if;
      if pg_catalog.jsonb_array_length(v_day) = 0 then
        v_saw_full := true;
        v_d := v_d + 1;
        continue;
      end if;
    end if;

    v_dates := v_dates || v_d;
    v_offers := v_offers || pg_catalog.jsonb_build_object(v_d::text, v_day);

    -- derived_earliest : le client ne voit que la première date. En mode
    -- interne (p_apply_capacity = false, réservé à reserve_...), on garde
    -- TOUTES les dates éligibles : la réservation doit pouvoir juger si
    -- une date antérieure plus tôt avait encore de la place.
    if v_s.date_selection_mode = 'derived_earliest' and p_apply_capacity then
      exit;
    end if;
    v_d := v_d + 1;
  end loop;

  if pg_catalog.cardinality(v_dates) = 0 then
    return query select 'unfulfillable'::text,
                        case when v_saw_full then 'capacity_exhausted'
                             when v_saw_open then 'no_offer_in_horizon'
                             when v_saw_closure then 'all_dates_closed'
                             else 'horizon_exhausted' end::text,
                        v_s.timezone, v_s.date_selection_mode, v_s.slot_selection_mode,
                        case when v_s.slot_selection_mode = 'time_within_window'
                             then v_s.time_granularity_minutes end,
                        null::date, null::date[], null::jsonb;
    return;
  end if;

  return query select 'dates_available'::text, null::text, v_s.timezone,
                      v_s.date_selection_mode, v_s.slot_selection_mode,
                      case when v_s.slot_selection_mode = 'time_within_window'
                           then v_s.time_granularity_minutes end,
                      v_dates[1], v_dates, v_offers;
end
$csdj12_resolve$;

-- ── RÉPARTITEUR : même nom, même signature, mêmes colonnes ─────────
alter function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)
  rename to resolve_fulfillment_schedule_v1;

create function public.resolve_fulfillment_schedule(
  p_restaurant_id uuid,
  p_mode_code text,
  p_fulfillment_rule_id uuid default null,
  p_now timestamptz default pg_catalog.now()
)
returns table (
  status                   text,
  unfulfillable_reason     text,
  schedule_timezone        text,
  date_selection_mode      text,
  slot_selection_mode      text,
  time_granularity_minutes smallint,
  first_eligible_date      date,
  eligible_dates           date[],
  offers                   jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_dispatch$
declare
  v_method text;
begin
  select s.schedule_method_version into v_method
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code
    and s.rule_key = coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_method = 'v1.2' then
    return query select * from public.resolve_fulfillment_schedule_v12(
      p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now, true);
  else
    -- absence, désactivation et méthode v1 : comportement CSDJ-1 inchangé.
    return query select * from public.resolve_fulfillment_schedule_v1(
      p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now);
  end if;
end
$csdj12_dispatch$;

-- ============================================================
-- §F  VALIDATION DE SÉLECTION ET RÉSERVATION DE CAPACITÉ
--
-- DEUX portes, UNE seule autorité de décision.
--
--   validate_fulfillment_selection  LECTURE SEULE. Dit si (date, créneau,
--     heure) est une sélection valide MAINTENANT, capacité comprise
--     (décompte consultatif, sans verrou). À appeler par create_order,
--     TOUJOURS, que la capacité soit activée ou non : c'est elle qui
--     refuse une date forgée, périmée ou hors offre (décision CTO).
--   reserve_fulfillment_capacity    Prend le verrou de seau, REJOUE la
--     même validation sous verrou, puis consomme UNE unité. Une seule
--     implémentation de la règle : reserve appelle validate.
--
-- Aucun deuxième algorithme de comptage, aucun deuxième verrou : le
-- décompte est fulfillment_capacity_used, le verrou est celui de reserve.
-- ============================================================
create function public.fulfillment_selection_reasons_v12()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'schedule_not_fulfillable',
    'selection_required',
    'selection_not_expected',
    'selection_invalid',
    'date_not_offered',
    'slot_not_offered',
    'time_not_offered',
    'capacity_full'
  ]::text[]
$$;

-- Rend UNE ligne :
--   result            'not_required' | 'valid' | 'unavailable'
--   reason            null sauf 'unavailable' (catalogue ci-dessus)
--   selection_*       la sélection RETENUE par le serveur (à figer dans
--                     le snapshot de commande) ; null si non applicable
--   window_*, instant_starts_at
--                     l'offre retenue (créneau nommé, ou fenêtre de
--                     l'heure choisie) ; null en mode « date seule »
--   capacity_applies  vrai si reserve_fulfillment_capacity consommera
--                     une unité pour cette sélection
--
-- 'not_required' : aucune planification activée pour la portée, ou
-- date informative seulement ; AUCUNE sélection ne doit alors être
-- fournie (sinon 'unavailable'/'selection_not_expected').
create function public.validate_fulfillment_selection(
  p_restaurant_id       uuid,
  p_mode_code           text,
  p_fulfillment_rule_id uuid,
  p_fulfillment_date    date default null,
  p_slot_key            text default null,
  p_selected_time       text default null,
  p_now                 timestamptz default pg_catalog.now()
)
returns table (
  result              text,
  reason              text,
  selection_date      date,
  selection_slot_key  text,
  selection_time      text,
  window_starts_at    text,
  window_ends_at      text,
  instant_starts_at   timestamptz,
  schedule_timezone   text,
  date_selection_mode text,
  slot_selection_mode text,
  capacity_applies    boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_validate$
declare
  v_s        public.restaurant_fulfillment_schedule;
  v_rule_key uuid := coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_slot     text := nullif(p_slot_key, '');
  v_time     time;
  v_r        record;
  v_day      jsonb;
  v_o        jsonb;
  v_cap      boolean := false;
  v_e        date;
  v_result   text;
  v_reason   text;
  v_out_slot text;
  v_out_time text;
  v_ws       text;
  v_we       text;
  v_inst     timestamptz;
begin
  if p_restaurant_id is null or p_mode_code is null then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: établissement et mode requis.' using errcode = '22023';
  end if;
  if v_rule_key = '00000000-0000-0000-0000-000000000000'::uuid and p_fulfillment_rule_id is not null then
    raise exception 'CSDJ12_RESERVED_RULE_ID: le zéro UUID est une sentinelle interne.' using errcode = '22023';
  end if;

  <<chk>>
  loop
    select * into v_s
    from public.restaurant_fulfillment_schedule s
    where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code and s.rule_key = v_rule_key;

    -- Rien à sélectionner : planification absente, désactivée, ou date
    -- purement informative. Une sélection fournie est un défaut du
    -- client (ou une forgerie) : refus, jamais d'oubli silencieux.
    if not found or v_s.enabled is not true or v_s.date_selection_mode = 'informational_only' then
      if p_fulfillment_date is null and v_slot is null and p_selected_time is null then
        v_result := 'not_required';
      else
        v_result := 'unavailable'; v_reason := 'selection_not_expected';
      end if;
      exit chk;
    end if;

    -- Formes : un texte mal formé n'est jamais interprété.
    if v_slot is not null and (pg_catalog.length(v_slot) > 40 or v_slot !~ '^[a-z0-9_-]+$') then
      v_result := 'unavailable'; v_reason := 'selection_invalid'; exit chk;
    end if;
    if p_selected_time is not null and p_selected_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      v_result := 'unavailable'; v_reason := 'selection_invalid'; exit chk;
    end if;

    v_cap := (v_s.schedule_method_version = 'v1.2' and v_s.capacity_enabled is true);

    -- UNE source d'offres : le résolveur de la méthode de la planification.
    if v_s.schedule_method_version = 'v1.2' then
      select * into v_r from public.resolve_fulfillment_schedule_v12(
        p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now, false);
    else
      select * into v_r from public.resolve_fulfillment_schedule_v1(
        p_restaurant_id, p_mode_code, p_fulfillment_rule_id, p_now);
    end if;
    if v_r.status is distinct from 'dates_available' then
      v_result := 'unavailable'; v_reason := 'schedule_not_fulfillable'; exit chk;
    end if;

    if p_fulfillment_date is null then
      v_result := 'unavailable'; v_reason := 'selection_required'; exit chk;
    end if;
    v_day := v_r.offers -> p_fulfillment_date::text;
    if v_day is null then
      v_result := 'unavailable'; v_reason := 'date_not_offered'; exit chk;
    end if;

    -- derived_earliest : la date est CHOISIE PAR LE SERVEUR. Le client ne
    -- fait que la rappeler (ce qu'il a affiché) ; toute autre date est
    -- refusée. Une date plus tardive n'est valide que si toutes les dates
    -- éligibles antérieures sont pleines (capacité activée) -- jamais
    -- sinon. (rfs_policy_coherent interdit derived_earliest avec créneaux
    -- ou heure : le décompte est donc toujours au niveau de la date.)
    if v_s.date_selection_mode = 'derived_earliest' then
      if v_slot is not null or p_selected_time is not null then
        v_result := 'unavailable'; v_reason := 'selection_not_expected'; exit chk;
      end if;
      for v_e in select e::date from pg_catalog.unnest(v_r.eligible_dates) e
                 where e < p_fulfillment_date order by e loop
        if not v_cap
           or public.fulfillment_capacity_used(p_restaurant_id, p_mode_code, v_rule_key, v_e, '')
              < v_s.capacity_max_orders then
          v_result := 'unavailable'; v_reason := 'date_not_offered'; exit chk;
        end if;
      end loop;
    end if;

    if v_s.slot_selection_mode = 'fixed_slots' then
      if p_selected_time is not null then
        v_result := 'unavailable'; v_reason := 'selection_not_expected'; exit chk;
      end if;
      if v_slot is null then
        v_result := 'unavailable'; v_reason := 'selection_required'; exit chk;
      end if;
      select e into v_o from pg_catalog.jsonb_array_elements(v_day) e
      where e->>'slot_key' = v_slot limit 1;
      if v_o is null then
        v_result := 'unavailable'; v_reason := 'slot_not_offered'; exit chk;
      end if;
      v_out_slot := v_slot;
      v_ws := v_o->>'starts_at'; v_we := v_o->>'ends_at';
      v_inst := public.checkout_wall_time_instant(p_fulfillment_date, v_ws::time, v_s.timezone);

    elsif v_s.slot_selection_mode = 'time_within_window' then
      if v_slot is not null then
        v_result := 'unavailable'; v_reason := 'selection_not_expected'; exit chk;
      end if;
      if p_selected_time is null then
        v_result := 'unavailable'; v_reason := 'selection_required'; exit chk;
      end if;
      v_time := p_selected_time::time;
      -- L'heure doit tomber DANS une fenêtre offerte et SUR la grille :
      -- le début exposé est un point de grille (le premier réalisable),
      -- la grille est donc celle de ce début, par pas de granularité.
      select e into v_o from pg_catalog.jsonb_array_elements(v_day) e
      where (e->>'starts_at')::time <= v_time
        and v_time < (e->>'ends_at')::time
        and (extract(epoch from (v_time - (e->>'starts_at')::time))::integer / 60)
            % v_r.time_granularity_minutes = 0
      limit 1;
      v_inst := case when v_o is null then null
                else public.checkout_wall_time_instant(p_fulfillment_date, v_time, v_s.timezone) end;
      if v_o is null or v_inst is null then
        v_result := 'unavailable'; v_reason := 'time_not_offered'; exit chk;
      end if;
      v_out_time := p_selected_time;
      v_ws := v_o->>'starts_at'; v_we := v_o->>'ends_at';

    else
      -- `none` : la date seule est sélectionnée.
      if v_slot is not null or p_selected_time is not null then
        v_result := 'unavailable'; v_reason := 'selection_not_expected'; exit chk;
      end if;
    end if;

    -- Capacité : décompte consultatif ICI ; l'autorité sous verrou est
    -- reserve_fulfillment_capacity, qui rejoue cette fonction.
    if v_cap
       and public.fulfillment_capacity_used(
             p_restaurant_id, p_mode_code, v_rule_key, p_fulfillment_date, coalesce(v_out_slot, ''))
           >= v_s.capacity_max_orders then
      v_result := 'unavailable'; v_reason := 'capacity_full'; exit chk;
    end if;

    v_result := 'valid';
    exit chk;
  end loop;

  if v_result = 'valid' then
    return query select v_result, null::text, p_fulfillment_date, v_out_slot, v_out_time,
                        v_ws, v_we, v_inst, v_s.timezone, v_s.date_selection_mode,
                        v_s.slot_selection_mode, v_cap;
  else
    return query select v_result, v_reason, null::date, null::text, null::text,
                        null::text, null::text, null::timestamptz, null::text, null::text,
                        null::text, false;
  end if;
end
$csdj12_validate$;

-- À appeler DANS la transaction de create_order, APRÈS l'insertion de la
-- commande (la ligne de réservation référence la commande). Une unité
-- par commande. Verrou consultatif par seau (restaurant, mode, règle,
-- date, créneau) : deux sessions visant la dernière place se
-- sérialisent, la seconde recalcule après la première.
--
-- Rend (result, reason) :
--   ('not_required', null)     planification absente/désactivée/v1, ou
--                              capacité désactivée : rien n'est réservé
--                              (la VALIDATION reste due, via
--                              validate_fulfillment_selection) ;
--   ('reserved', null)         une unité consommée ;
--   ('unavailable', <motif>)   catalogue fulfillment_selection_reasons_v12().
-- Lève une exception (donc annule create_order) sur erreur d'usage :
-- commande inconnue/étrangère/inactive, double réservation, isolation
-- autre que READ COMMITTED.
create function public.reserve_fulfillment_capacity(
  p_order_id            uuid,
  p_restaurant_id       uuid,
  p_mode_code           text,
  p_fulfillment_rule_id uuid,
  p_fulfillment_date    date,
  p_slot_key            text default null,
  p_selected_time       text default null,
  p_now                 timestamptz default pg_catalog.now()
)
returns table (result text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $csdj12_reserve$
declare
  v_o        record;
  v_s        public.restaurant_fulfillment_schedule;
  v_rule_key uuid := coalesce(p_fulfillment_rule_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_slot     text := coalesce(p_slot_key, '');
  v_v        record;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'CSDJ12_ISOLATION_REQUIRED: la réservation exige READ COMMITTED (le verrou de seau repose sur un instantané frais).'
      using errcode = '25000';
  end if;
  if p_order_id is null or p_restaurant_id is null or p_mode_code is null or p_fulfillment_date is null then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: commande, établissement, mode et date requis.' using errcode = '22023';
  end if;
  if v_slot <> '' and (pg_catalog.length(v_slot) > 40 or v_slot !~ '^[a-z0-9_-]+$') then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: slot_key invalide.' using errcode = '22023';
  end if;
  if v_rule_key = '00000000-0000-0000-0000-000000000000'::uuid and p_fulfillment_rule_id is not null then
    raise exception 'CSDJ12_RESERVED_RULE_ID: le zéro UUID est une sentinelle interne.' using errcode = '22023';
  end if;

  select o.restaurant_id, o.status, o.payment_status into v_o
  from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'CSDJ12_ORDER_NOT_FOUND: commande introuvable.' using errcode = '22023';
  end if;
  -- Tenant : la commande doit appartenir à CET établissement.
  if v_o.restaurant_id is distinct from p_restaurant_id then
    raise exception 'CSDJ12_FOREIGN_ORDER: commande d''un autre établissement.' using errcode = '42501';
  end if;
  if not public.fulfillment_capacity_is_holding(v_o.status, v_o.payment_status) then
    raise exception 'CSDJ12_ORDER_NOT_ACTIVE: une commande refusée/annulée ne peut pas réserver de capacité.' using errcode = '55000';
  end if;

  select * into v_s
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = p_mode_code and s.rule_key = v_rule_key;

  if not found or v_s.enabled is not true
     or v_s.schedule_method_version <> 'v1.2' or v_s.capacity_enabled is not true then
    return query select 'not_required'::text, null::text;
    return;
  end if;

  if exists (select 1 from public.order_fulfillment_capacity_reservation r where r.order_id = p_order_id) then
    raise exception 'CSDJ12_ALREADY_RESERVED: cette commande a déjà consommé une unité.' using errcode = '23505';
  end if;

  -- Verrou de seau. Tenu jusqu'à la fin de la transaction appelante.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_restaurant_id::text || '|' || p_mode_code || '|' || v_rule_key::text || '|'
      || p_fulfillment_date::text || '|' || v_slot, 1204));

  -- Revalidation SOUS verrou, par la MÊME fonction que celle de
  -- create_order : un seul algorithme de décision et de décompte.
  select * into v_v
  from public.validate_fulfillment_selection(
         p_restaurant_id, p_mode_code, p_fulfillment_rule_id,
         p_fulfillment_date, p_slot_key, p_selected_time, p_now);
  if v_v.result is distinct from 'valid' then
    return query select 'unavailable'::text,
                        coalesce(v_v.reason, 'schedule_not_fulfillable'::text);
    return;
  end if;

  insert into public.order_fulfillment_capacity_reservation
    (order_id, restaurant_id, mode_code, rule_key, fulfillment_date, slot_key)
  values (p_order_id, p_restaurant_id, p_mode_code, v_rule_key, p_fulfillment_date,
          coalesce(v_v.selection_slot_key, ''));

  return query select 'reserved'::text, null::text;
end
$csdj12_reserve$;

-- Libération EXPLICITE (primitif de la décision « échec de paiement »).
-- Supprime la ligne de réservation d'UNE commande ; idempotente ; sans
-- verrou de seau (rendre une place ne peut pas surréserver : au pire une
-- réservation concurrente voit « plein » un instant de trop, et refuse).
-- Rend true si une unité a été rendue. Interne : aucun rôle applicatif.
create function public.release_fulfillment_capacity(p_order_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $csdj12_release$
declare
  v_n integer;
begin
  if p_order_id is null then
    raise exception 'CSDJ12_INVALID_ARGUMENTS: commande requise.' using errcode = '22023';
  end if;
  delete from public.order_fulfillment_capacity_reservation r where r.order_id = p_order_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$csdj12_release$;

-- ============================================================
-- §G  ÉCRITURE ET LECTURE MARCHANDES v1.2
-- ============================================================
create function public.mutate_merchant_fulfillment_schedule_v12(
  p_restaurant_id uuid,
  p_action text,
  p_payload jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $csdj12_mutate$
declare
  v_mode      text;
  v_rule      uuid;
  v_rule_key  uuid;
  v_tz        text;
  v_date_mode text;
  v_slot_mode text;
  v_cal       uuid;
  v_prep_h    text;
  v_avail_h   text;
  v_cap_on    boolean;
  v_cap_max   integer;
  v_item      jsonb;
  v_method    text;
begin
  if auth.uid() is null then
    raise exception 'CSDJ12_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.has_role_in(p_restaurant_id, array['owner','manager']) then
    raise exception 'CSDJ12_FORBIDDEN: rôle owner ou manager requis.' using errcode = '42501';
  end if;
  if p_action is null or p_action <> all(array['save_schedule_v12','replace_prep_days','replace_prep_closures']) then
    raise exception 'CSDJ12_UNKNOWN_ACTION: action inconnue.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'CSDJ12_INVALID_PAYLOAD: objet JSON attendu.' using errcode = '22023';
  end if;

  -- MÊME verrou par tenant que mutate_merchant_fulfillment_schedule :
  -- les éditions v1 et v1.2 d'un établissement se sérialisent ensemble.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1104));

  v_mode := p_payload->>'modeCode';
  if v_mode is null or not exists (select 1 from public.sale_mode_catalog c where c.code = v_mode) then
    raise exception 'CSDJ12_UNKNOWN_MODE: mode de vente hors catalogue.' using errcode = '22023';
  end if;

  if p_payload ? 'fulfillmentRuleId' and p_payload->>'fulfillmentRuleId' is not null then
    v_rule := (p_payload->>'fulfillmentRuleId')::uuid;
    if v_rule = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception 'CSDJ12_RESERVED_RULE_ID: le zéro UUID est réservé comme sentinelle interne.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.restaurant_sale_mode_fulfillments f
      where f.id = v_rule and f.restaurant_id = p_restaurant_id and f.mode_code = v_mode
    ) then
      raise exception 'CSDJ12_FOREIGN_RULE: règle de livraison inconnue pour cet établissement et ce mode.' using errcode = '42501';
    end if;
  end if;
  v_rule_key := coalesce(v_rule, '00000000-0000-0000-0000-000000000000'::uuid);

  if p_action = 'save_schedule_v12' then
    v_tz := p_payload->>'timezone';
    if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
      raise exception 'CSDJ12_INVALID_TIMEZONE: fuseau IANA inconnu du serveur.' using errcode = '22023';
    end if;
    v_date_mode := coalesce(p_payload->>'dateSelectionMode', 'informational_only');
    v_slot_mode := coalesce(p_payload->>'slotSelectionMode', 'none');
    if v_date_mode <> all(public.checkout_date_selection_modes())
       or v_slot_mode <> all(public.checkout_slot_selection_modes()) then
      raise exception 'CSDJ12_INVALID_POLICY: politique hors catalogue.' using errcode = '22023';
    end if;
    if nullif(p_payload->>'cutoffTime','') is not null then
      if (p_payload->>'cutoffTime')::time
           is distinct from pg_catalog.date_trunc('minute', (p_payload->>'cutoffTime')::time) then
        raise exception 'CSDJ12_SUBMINUTE_TIME: les heures de planification sont à la minute (secondes = 00).' using errcode = '22023';
      end if;
    end if;

    -- v1.2 n'a plus de décalage d'heure limite : une valeur non nulle est
    -- REFUSÉE (jamais ignorée en silence).
    if nullif(p_payload->>'cutoffOffsetDays','') is not null
       and (p_payload->>'cutoffOffsetDays')::smallint <> 0 then
      raise exception 'CSDJ12_CUTOFF_OFFSET_REMOVED: cutoffOffsetDays n''existe pas en v1.2 (l''origine se déplace sur le prochain jour de préparation).' using errcode = '22023';
    end if;

    v_cal := nullif(p_payload->>'holidayCalendarId','')::uuid;
    if v_cal is not null and not exists (select 1 from public.public_holiday_calendar c where c.id = v_cal) then
      raise exception 'CSDJ12_UNKNOWN_CALENDAR: calendrier férié inconnu.' using errcode = '22023';
    end if;
    v_prep_h  := coalesce(p_payload->>'preparationOnHolidays', 'open');
    v_avail_h := coalesce(p_payload->>'availabilityOnHolidays', 'open');
    if v_prep_h not in ('open','closed') or v_avail_h not in ('open','closed') then
      raise exception 'CSDJ12_INVALID_HOLIDAY_POLICY: « open » ou « closed » attendu.' using errcode = '22023';
    end if;
    if v_cal is null and (v_prep_h = 'closed' or v_avail_h = 'closed') then
      raise exception 'CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR: une politique « closed » exige un calendrier férié.' using errcode = '22023';
    end if;

    v_cap_on := coalesce((p_payload->>'capacityEnabled')::boolean, false);
    v_cap_max := nullif(p_payload->>'capacityMaxOrders','')::integer;
    if v_cap_on and (v_cap_max is null or v_cap_max < 1) then
      raise exception 'CSDJ12_INVALID_CAPACITY: capacité activée => maximum strictement positif requis.' using errcode = '22023';
    end if;
    if v_cap_on and v_date_mode = 'informational_only' then
      raise exception 'CSDJ12_CAPACITY_NEEDS_DATE: la capacité exige une politique de date choisie ou dérivée.' using errcode = '22023';
    end if;

    insert into public.restaurant_fulfillment_schedule as t (
      restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
      date_selection_mode, slot_selection_mode, time_granularity_minutes,
      lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days,
      booking_horizon_days, schedule_method_version,
      holiday_calendar_id, preparation_on_holidays, availability_on_holidays,
      capacity_enabled, capacity_max_orders)
    values (
      p_restaurant_id, v_mode, v_rule, v_tz,
      coalesce((p_payload->>'enabled')::boolean, false),
      v_date_mode, v_slot_mode,
      nullif(p_payload->>'timeGranularityMinutes','')::smallint,
      coalesce(nullif(p_payload->>'leadTimeMinutes','')::integer, 0),
      coalesce(nullif(p_payload->>'minLeadDays','')::smallint, 0::smallint),
      nullif(p_payload->>'cutoffTime','')::time,
      0,
      coalesce(nullif(p_payload->>'bookingHorizonDays','')::smallint, 14::smallint),
      'v1.2',
      v_cal, v_prep_h, v_avail_h, v_cap_on, case when v_cap_on then v_cap_max else v_cap_max end)
    on conflict (restaurant_id, mode_code, rule_key) do update set
      timezone = excluded.timezone,
      enabled = excluded.enabled,
      date_selection_mode = excluded.date_selection_mode,
      slot_selection_mode = excluded.slot_selection_mode,
      time_granularity_minutes = excluded.time_granularity_minutes,
      lead_time_minutes = excluded.lead_time_minutes,
      min_lead_days = excluded.min_lead_days,
      cutoff_time = excluded.cutoff_time,
      cutoff_offset_days = 0,
      booking_horizon_days = excluded.booking_horizon_days,
      schedule_method_version = 'v1.2',
      holiday_calendar_id = excluded.holiday_calendar_id,
      preparation_on_holidays = excluded.preparation_on_holidays,
      availability_on_holidays = excluded.availability_on_holidays,
      capacity_enabled = excluded.capacity_enabled,
      capacity_max_orders = excluded.capacity_max_orders,
      updated_at = pg_catalog.now();
    return;
  end if;

  -- Actions sur les calendriers de préparation : la planification doit
  -- exister ET être de méthode v1.2.
  select s.schedule_method_version into v_method
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id and s.mode_code = v_mode and s.rule_key = v_rule_key;
  if v_method is null then
    raise exception 'CSDJ12_NO_SCHEDULE: enregistrez d''abord la planification (save_schedule_v12).' using errcode = '22023';
  end if;
  if v_method <> 'v1.2' then
    raise exception 'CSDJ12_NOT_V12: la planification n''est pas de méthode v1.2.' using errcode = '22023';
  end if;

  if p_action = 'replace_prep_days' then
    if pg_catalog.jsonb_typeof(p_payload->'weekdays') is distinct from 'array' then
      raise exception 'CSDJ12_INVALID_PAYLOAD: weekdays (tableau) attendu.' using errcode = '22023';
    end if;
    delete from public.restaurant_fulfillment_prep_day d
    where d.restaurant_id = p_restaurant_id and d.mode_code = v_mode and d.rule_key = v_rule_key;
    for v_item in select * from pg_catalog.jsonb_array_elements(p_payload->'weekdays') loop
      if pg_catalog.jsonb_typeof(v_item) <> 'number' or (v_item #>> '{}') !~ '^[0-6]$' then
        raise exception 'CSDJ12_INVALID_WEEKDAY: 0 (dimanche) à 6 (samedi).' using errcode = '22023';
      end if;
      insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday)
      values (p_restaurant_id, v_mode, v_rule_key, (v_item #>> '{}')::smallint)
      on conflict do nothing;
    end loop;
    return;
  end if;

  -- replace_prep_closures
  if pg_catalog.jsonb_typeof(p_payload->'closures') is distinct from 'array' then
    raise exception 'CSDJ12_INVALID_PAYLOAD: closures (tableau) attendu.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_payload->'closures') > 731 then
    raise exception 'CSDJ12_TOO_MANY_CLOSURES: 731 fermetures au plus.' using errcode = '22023';
  end if;
  delete from public.restaurant_fulfillment_prep_closure c
  where c.restaurant_id = p_restaurant_id and c.mode_code = v_mode and c.rule_key = v_rule_key;
  for v_item in select * from pg_catalog.jsonb_array_elements(p_payload->'closures') loop
    insert into public.restaurant_fulfillment_prep_closure (restaurant_id, mode_code, rule_key, closed_on, label)
    values (p_restaurant_id, v_mode, v_rule_key, (v_item->>'closedOn')::date, nullif(v_item->>'label',''))
    on conflict do nothing;
  end loop;
end
$csdj12_mutate$;

create function public.get_merchant_fulfillment_schedules_v12(p_restaurant_id uuid)
returns table (
  mode_code                 text,
  fulfillment_rule_id       uuid,
  schedule_method_version   text,
  holiday_calendar_id       uuid,
  preparation_on_holidays   text,
  availability_on_holidays  text,
  capacity_enabled          boolean,
  capacity_max_orders       integer,
  preparation_weekdays      jsonb,
  preparation_closures      jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $csdj12_read$
begin
  if auth.uid() is null then
    raise exception 'CSDJ12_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then
    raise exception 'CSDJ12_FORBIDDEN: accès refusé à cet établissement.' using errcode = '42501';
  end if;
  return query
  select s.mode_code, s.fulfillment_rule_id, s.schedule_method_version,
         s.holiday_calendar_id, s.preparation_on_holidays, s.availability_on_holidays,
         s.capacity_enabled, s.capacity_max_orders,
         coalesce((select pg_catalog.jsonb_agg(d.weekday order by d.weekday)
                   from public.restaurant_fulfillment_prep_day d
                   where d.restaurant_id = s.restaurant_id and d.mode_code = s.mode_code
                     and d.rule_key = s.rule_key), '[]'::jsonb),
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                           'closedOn', c.closed_on, 'label', c.label) order by c.closed_on)
                   from public.restaurant_fulfillment_prep_closure c
                   where c.restaurant_id = s.restaurant_id and c.mode_code = s.mode_code
                     and c.rule_key = s.rule_key), '[]'::jsonb)
  from public.restaurant_fulfillment_schedule s
  where s.restaurant_id = p_restaurant_id
  order by s.mode_code, s.rule_key;
end
$csdj12_read$;

-- ------------------------------------------------------------
-- ACL des fonctions : tout est fermé, puis les deux seules ouvertures
-- (RPC marchandes, rôle authenticated ; contrôle d'accès DANS le corps).
-- ------------------------------------------------------------
revoke all on function public.checkout_unfulfillable_reasons_v12() from public, anon, authenticated, service_role;
revoke all on function public.fulfillment_capacity_is_holding(text,text) from public, anon, authenticated, service_role;
revoke all on function public.fulfillment_capacity_used(uuid,text,uuid,date,text) from public, anon, authenticated, service_role;
revoke all on function public.csdj12_preparation_open(public.restaurant_fulfillment_schedule,date) from public, anon, authenticated, service_role;
revoke all on function public.csdj12_availability_closed(public.restaurant_fulfillment_schedule,date) from public, anon, authenticated, service_role;
revoke all on function public.checkout_schedule_day_offers_v12(public.restaurant_fulfillment_schedule,date,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.resolve_fulfillment_schedule_v12(uuid,text,uuid,timestamp with time zone,boolean) from public, anon, authenticated, service_role;
revoke all on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.fulfillment_selection_reasons_v12() from public, anon, authenticated, service_role;
revoke all on function public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.release_fulfillment_capacity(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb) from public, anon, service_role;
revoke all on function public.get_merchant_fulfillment_schedules_v12(uuid) from public, anon, service_role;
grant execute on function public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb) to authenticated;
grant execute on function public.get_merchant_fulfillment_schedules_v12(uuid) to authenticated;

comment on function public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone) is
  'CSDJ v1.2 — RÉPARTITEUR. Méthode v1.2 -> resolve_fulfillment_schedule_v12 ; sinon -> resolve_fulfillment_schedule_v1 (ancien corps CSDJ-1, inchangé). Mêmes colonnes de sortie : le contrat de get_checkout_fulfillment_schedule est préservé.';
comment on function public.validate_fulfillment_selection(uuid,text,uuid,date,text,text,timestamp with time zone) is
  'CSDJ v1.2 — VALIDATION serveur de la sélection (date, créneau, heure), LECTURE SEULE, capacité comprise (décompte consultatif). À appeler par create_order TOUJOURS, capacité activée ou non. derived_earliest : la date est celle du serveur, le client ne fait que la rappeler. Aucun accès applicatif.';
comment on function public.fulfillment_selection_reasons_v12() is
  'CSDJ v1.2 — catalogue FERMÉ des motifs de validate_fulfillment_selection / reserve_fulfillment_capacity. Miroir de FULFILLMENT_SELECTION_REASONS_V12. Aucun accès applicatif.';
comment on function public.reserve_fulfillment_capacity(uuid,uuid,text,uuid,date,text,text,timestamp with time zone) is
  'CSDJ v1.2 — SEULE autorité transactionnelle de réservation de capacité. Une commande = une unité. À appeler dans la transaction de create_order après l''insertion de la commande. Verrou consultatif par seau, revalidation serveur, aucun compte exposé.';

-- ============================================================
-- §H  POST-VOL — DANS LA TRANSACTION
-- ============================================================
do $csdj12_postflight$
declare
  v_item  text;
  v_bad   text;
  v_drift text;
begin
  -- Objets présents
  foreach v_item in array array[
    'public.restaurant_fulfillment_prep_day','public.restaurant_fulfillment_prep_closure',
    'public.public_holiday_calendar','public.public_holiday_calendar_day',
    'public.order_fulfillment_capacity_reservation'
  ] loop
    if pg_catalog.to_regclass(v_item) is null then
      raise exception 'SCANYM_POSTFLIGHT: table % absente.', v_item;
    end if;
    -- CSDJ12-DEPLOY-01 : propriétaire attendu des tables créées.
    if (select pg_catalog.pg_get_userbyid(c.relowner)::text
          from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_item)) is distinct from 'postgres' then
      raise exception 'SCANYM_POSTFLIGHT: la table % n''appartient pas à « postgres ».', v_item;
    end if;
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(v_item)) then
      raise exception 'SCANYM_POSTFLIGHT: RLS non activée sur %.', v_item;
    end if;
    -- Aucun droit d'ÉCRITURE pour aucun rôle applicatif, et aucun droit
    -- du tout pour anon.
    if exists (select 1 from unnest(array['anon','authenticated','service_role']) r(role_name)
               where pg_catalog.has_table_privilege(r.role_name, v_item, 'INSERT')
                  or pg_catalog.has_table_privilege(r.role_name, v_item, 'UPDATE')
                  or pg_catalog.has_table_privilege(r.role_name, v_item, 'DELETE')
                  or pg_catalog.has_table_privilege(r.role_name, v_item, 'TRUNCATE')) then
      raise exception 'SCANYM_POSTFLIGHT: droit d''écriture applicatif sur %.', v_item;
    end if;
    if pg_catalog.has_table_privilege('anon', v_item, 'SELECT') then
      raise exception 'SCANYM_POSTFLIGHT: anon peut lire %.', v_item;
    end if;
  end loop;
  if pg_catalog.has_table_privilege('authenticated', 'public.order_fulfillment_capacity_reservation', 'SELECT') then
    raise exception 'SCANYM_POSTFLIGHT: la table de réservation ne doit être lisible par aucun rôle applicatif.';
  end if;

  -- Fonctions internes : AUCUN accès applicatif, y compris PUBLIC.
  for v_bad in
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('checkout_unfulfillable_reasons_v12','fulfillment_capacity_is_holding',
                        'fulfillment_capacity_used','csdj12_preparation_open','csdj12_availability_closed',
                        'checkout_schedule_day_offers_v12','resolve_fulfillment_schedule_v12',
                        'resolve_fulfillment_schedule','resolve_fulfillment_schedule_v1',
                        'reserve_fulfillment_capacity','release_fulfillment_capacity',
                        'validate_fulfillment_selection','fulfillment_selection_reasons_v12')
      and (p.proacl is null
           or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
           or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
  loop
    raise exception 'SCANYM_POSTFLIGHT: la fonction interne % est exécutable par un rôle applicatif.', v_bad;
  end loop;

  -- RPC marchandes : authenticated oui, anon non.
  foreach v_item in array array[
    'public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)',
    'public.get_merchant_fulfillment_schedules_v12(uuid)'
  ] loop
    if not pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(v_item), 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(v_item), 'EXECUTE') then
      raise exception 'SCANYM_POSTFLIGHT: ACL inattendue sur %.', v_item;
    end if;
  end loop;

  -- La lecture publique CSDJ-1 est intacte : signature et ACL.
  if pg_catalog.to_regprocedure('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)') is null
     or not pg_catalog.has_function_privilege('anon',
          'public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)', 'EXECUTE') then
    raise exception 'SCANYM_POSTFLIGHT: la lecture publique CSDJ-1 a été altérée.';
  end if;

  -- Le répartiteur garde les 9 colonnes de sortie de CSDJ-1.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p,
        unnest(p.proargmodes) m(mode)
      where p.oid = pg_catalog.to_regprocedure('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)')
        and m.mode = 't') <> 9 then
    raise exception 'SCANYM_POSTFLIGHT: le répartiteur ne rend pas 9 colonnes.';
  end if;

  -- Aucune configuration créée ni modifiée par ce fichier.
  if exists (select 1 from public.restaurant_fulfillment_schedule s
             where s.schedule_method_version <> 'v1' or s.capacity_enabled
                or s.holiday_calendar_id is not null) then
    raise exception 'SCANYM_POSTFLIGHT: une planification a été activée en v1.2 par la migration.';
  end if;
  if exists (select 1 from public.public_holiday_calendar) then
    raise exception 'SCANYM_POSTFLIGHT: un calendrier férié a été créé par la migration.';
  end if;

  -- CSDJ12-DEPLOY-01 : ÉTAT FINAL de chaque fonction -- les 9 prédécesseurs
  -- inchangés, l'ancien résolveur sous _v1 (même objet, mêmes empreintes),
  -- et les 14 fonctions créées : propriétaire, SECURITY, proconfig complet,
  -- ACL exacte (PUBLIC, donneur, option de transmission), privilèges
  -- effectifs de anon / authenticated / service_role.
  v_drift := pg_temp.csdj12_pin_drift('post');
  if v_drift is not null then
    raise exception 'SCANYM_POSTFLIGHT: état final dérivé -- %', v_drift;
  end if;
end
$csdj12_postflight$;

drop function pg_temp.csdj12_pin_drift(text);

commit;
