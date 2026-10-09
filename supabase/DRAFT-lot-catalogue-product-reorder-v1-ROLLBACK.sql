-- ============================================================
-- Scanym — CATALOGUE PRODUCT REORDER v1 — ROLLBACK
--
-- CE QUE CE FICHIER FAIT EXACTEMENT : il supprime l'UNIQUE fonction
-- ajoutée par ce lot, et rien d'autre.
--
--   drop function public.move_product_order(uuid, text, uuid[])
--
-- AUCUNE donnée n'est perdue ni réécrite : ce lot ne crée aucune
-- table, aucune colonne, aucun index, et n'exécute aucun backfill.
--
-- ET LES ORDRES DÉJÀ ENREGISTRÉS ? Les valeurs menu_items.display_order
-- écrites par les marchands via Monter/Descendre pendant que le lot
-- était installé sont CONSERVÉES : ce sont des entiers ordinaires
-- dans la colonne d'ordre historique, issus d'actions marchandes
-- délibérées, et la carte client continue de les honorer exactement
-- comme avant ce lot (son contrat de tri -- display_order, puis nom
-- normalisé, puis id -- n'a jamais été modifié). Les « restaurer »
-- serait au contraire un remaniement destructif de l'ordre voulu par
-- le marchand ; ce rollback ne le fait donc pas, et aucune sauvegarde
-- préalable n'est nécessaire pour l'exécuter.
--
-- Après rollback, le back-office déployé avec ce lot afficherait une
-- erreur au clic sur Monter/Descendre (RPC absente) : le rollback SQL
-- doit donc accompagner le retour du code applicatif à la version
-- précédente. Le champ numérique historique (set_product_order, V67b)
-- reste disponible : ce lot ne l'a jamais modifié.
--
-- Le lot étant STRICTEMENT ADDITIF (1 fonction neuve, zéro objet
-- préexistant modifié), le rollback l'est symétriquement : il n'a rien
-- à restaurer, seulement à retirer.
--
-- ATOMICITÉ : transaction unique, contrôle de dérive en PREMIÈRE
-- instruction À L'INTÉRIEUR de celle-ci : un échec avorte tout et le
-- `commit;` final agit comme un ROLLBACK, indépendamment de tout
-- drapeau client (ON_ERROR_STOP).
--
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur une base hébergée par ce lot.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.move_product_order(uuid, text, uuid[])') is null then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: public.move_product_order(uuid, text, uuid[]) introuvable -- cette base ne semble pas avoir reçu CATALOGUE PRODUCT REORDER v1, rollback annulé (aucune mutation).';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'move_product_order') <> 1 then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: surcharge inattendue de move_product_order -- rollback annulé (aucune mutation), examiner manuellement.';
  end if;

  -- Empreintes AVANT, comparées après le retrait (locales à la
  -- transaction) : le rollback ne touche ni les données d'ordre, ni
  -- aucune autre fonction.
  perform set_config(
    'scanym.cpr1_rb_order_fingerprint',
    (select count(*)::text || ':' || coalesce(md5(string_agg(mi.id::text || '=' || mi.display_order::text, ',' order by mi.id)), 'empty')
     from public.menu_items mi),
    true
  );
  perform set_config(
    'scanym.cpr1_rb_function_fingerprint',
    (select count(*)::text || ':' || coalesce(md5(string_agg(
              p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(p.prosrc),
              ',' order by p.proname, pg_get_function_identity_arguments(p.oid))), 'empty')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname <> 'move_product_order'),
    true
  );
end $$;

drop function public.move_product_order(uuid, text, uuid[]);

do $$
declare
  v_expected text;
  v_actual   text;
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'move_product_order'
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: move_product_order subsiste -- rollback annulé.';
  end if;

  -- Le chemin historique et l'autorisation partagée doivent être
  -- intacts après rollback.
  if to_regprocedure('public.set_product_order(uuid, integer)') is null
     or to_regprocedure('public.assert_product_role(uuid, text[])') is null then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: set_product_order / assert_product_role a disparu -- rollback annulé.';
  end if;

  v_expected := current_setting('scanym.cpr1_rb_order_fingerprint', true);
  select count(*)::text || ':' || coalesce(md5(string_agg(mi.id::text || '=' || mi.display_order::text, ',' order by mi.id)), 'empty')
    into v_actual
  from public.menu_items mi;
  if v_expected is null or v_expected = '' or v_actual is distinct from v_expected then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: menu_items.display_order a changé pendant le rollback (% -> %) -- rollback annulé.',
      v_expected, v_actual;
  end if;

  v_expected := current_setting('scanym.cpr1_rb_function_fingerprint', true);
  select count(*)::text || ':' || coalesce(md5(string_agg(
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(p.prosrc),
           ',' order by p.proname, pg_get_function_identity_arguments(p.oid))), 'empty')
    into v_actual
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public';
  if v_expected is null or v_expected = '' or v_actual is distinct from v_expected then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une autre fonction du schéma public a été modifiée par le rollback (% -> %) -- rollback annulé.',
      v_expected, v_actual;
  end if;
end $$;

commit;

-- ============================================================
-- FIN — CATALOGUE PRODUCT REORDER v1 — ROLLBACK
-- ============================================================
