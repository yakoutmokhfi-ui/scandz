-- ============================================================================
-- OPTION « MISE SOUS VIDE » DES FROMAGES ET CHARCUTERIES v1  (DRAFT, NON APPLIQUÉ)
--
-- Besoin : Au Lait Cru veut laisser le client demander la mise sous vide de ses
-- fromages et charcuteries. Le choix accompagne la commande, survit au paiement
-- et se lit au back-office.
--
-- IDENTIFICATION DES PRODUITS (décision CIO) : AUCUN nom codé en dur. Le catalogue
-- ne porte aucun attribut « fromage / charcuterie » (catégories et sous-catégories
-- sont des textes libres du marchand). Source de vérité retenue : un INDICATEUR PAR
-- CATÉGORIE, `menu_categories.vacuum_packable` (faux par défaut), réglé par le
-- marchand. Les produits et sous-catégories en héritent via `menu_items.category_id`.
--
-- CE LOT (additif, un seul fichier, une seule transaction) :
--   1. menu_categories.vacuum_packable boolean not null default false.
--   2. orders.vacuum_packing_requested boolean not null default false.
--   3. create_order : UN bloc inséré immédiatement après `-- CSDJ-3 END`, par
--      remplacement ANCRÉ sur la définition HÉBERGÉE RÉELLE (jamais recopiée) :
--      prédécesseur épinglé par empreinte MD5, ancre exactement une fois, résultat
--      re-contrôlé. Signature, SECURITY DEFINER, search_path et droits INCHANGÉS.
--      Le choix est lu dans `p_customer->'vacuum_packing'` (booléen JSON), persisté
--      DANS la transaction de create_order (aucune fenêtre entre la création et
--      l'enregistrement du choix) ; l'autorité est ici : refus typé si la commande ne
--      contient aucun article d'une catégorie vacuum_packable.
--   4. set_category_vacuum_packable(uuid, boolean) : seul chemin d'écriture de
--      l'indicateur (propriétaire/gérant, même garde que update_category).
--
-- CE LOT NE TOUCHE PAS : la machine à états paiement, l'inbox Monetico, les
-- notifications, le moteur de livraison/créneaux, update_category/create_category,
-- get_merchant_catalogue, les politiques RLS ni aucun droit existant. Aucune donnée
-- n'est modifiée : TOUTES les catégories restent à `false` tant que le marchand (ou un
-- SQL de données distinct, avec GO explicite) ne les active pas.
--
-- ORDRE DE DÉPLOIEMENT : ce SQL d'abord, le front ensuite. Un front déployé AVANT ce
-- lot enverrait `vacuum_packing` à un create_order qui l'ignore : le choix serait perdu.
-- La case reste donc masquée tant qu'aucune catégorie n'est vacuum_packable (colonne
-- absente => la lecture publique renvoie `undefined` => aucune case).
--
-- Rollback : DRAFT-lot-vacuum-packing-option-v1-rollback.sql (restaure l'empreinte
-- exacte du prédécesseur ; refuse de supprimer des données).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. PRÉCONDITIONS (rien n'est modifié si l'une d'elles échoue)
-- ---------------------------------------------------------------------------
do $lot$
declare
  c_sig       constant text := 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)';
  c_md5       constant text := '5ed0f3e2eee78df7c3f9cd9c27cd3036';
  c_anchor    constant text := E'  -- CSDJ-3 END\n';
  v_n         integer;
  v_def       text;
  v_hits      integer;
begin
  if to_regclass('public.menu_categories') is null or to_regclass('public.orders') is null then
    raise exception 'SCANYM_PREREQUISITE_MISSING: menu_categories / orders absents -- migration annulée.';
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'vacuum_packable')
     or exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'orders' and column_name = 'vacuum_packing_requested') then
    raise exception 'SCANYM_ALREADY_APPLIED: double application refusée (colonne vacuum déjà présente).';
  end if;

  if to_regprocedure('public.assert_category_role(uuid,text[])') is null then
    raise exception 'SCANYM_PREREQUISITE_MISSING: assert_category_role(uuid,text[]) absent -- migration annulée.';
  end if;

  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';
  if v_n <> 1 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: create_order a % surcharge(s) (attendu: 1) -- migration annulée.', v_n;
  end if;

  if to_regprocedure(c_sig) is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: signature de create_order inattendue -- migration annulée.';
  end if;

  v_def := pg_get_functiondef(to_regprocedure(c_sig));
  if md5(v_def) <> c_md5 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: create_order a changé depuis la définition auditée (md5 % attendu %) -- migration annulée.', md5(v_def), c_md5;
  end if;

  v_hits := (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor);
  if v_hits <> 1 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: ancre CSDJ-3 END trouvée % fois (attendu: 1) -- migration annulée.', v_hits;
  end if;
end
$lot$;

-- ---------------------------------------------------------------------------
-- 1. COLONNES ADDITIVES (faux par défaut : aucun comportement existant ne change)
-- ---------------------------------------------------------------------------
alter table public.menu_categories
  add column vacuum_packable boolean not null default false;
comment on column public.menu_categories.vacuum_packable is
  'Les produits de cette catégorie (et de ses sous-catégories) sont éligibles à la mise sous vide demandée par le client. Réglé par le marchand via set_category_vacuum_packable ; faux par défaut.';

alter table public.orders
  add column vacuum_packing_requested boolean not null default false;
comment on column public.orders.vacuum_packing_requested is
  'Le client a demandé la mise sous vide des produits éligibles de CETTE commande. Écrit uniquement par create_order (dans sa transaction), après contrôle serveur d''au moins un article d''une catégorie vacuum_packable.';

-- ---------------------------------------------------------------------------
-- 2. create_order : insertion ANCRÉE du bloc « mise sous vide »
-- ---------------------------------------------------------------------------
do $lot$
declare
  c_sig    constant text := 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)';
  c_anchor constant text := E'  -- CSDJ-3 END\n';
  v_def    text;
  v_new    text;
  v_block  text;
begin
  v_def := pg_get_functiondef(to_regprocedure(c_sig));

  v_block := $blk$
  -- VACUUM-PACKING BEGIN -- option « mise sous vide » des fromages et charcuteries.
  --
  -- Une SEULE intention booléenne, p_customer->'vacuum_packing', persistée AVEC la
  -- commande dans la transaction de create_order : aucune fenêtre entre la création
  -- de la commande et l'enregistrement du choix, y compris avant tout paiement.
  -- Autorité serveur : le choix n'est retenu que si la commande contient au moins un
  -- article dont la CATÉGORIE est marquée menu_categories.vacuum_packable (aucun
  -- produit n'est identifié par son nom) ; sinon refus typé. Ne lit et n'écrit aucun
  -- objet de paiement, de notification, de livraison ou de créneau.
  declare
    v_vp_raw       jsonb := p_customer -> 'vacuum_packing';
    v_vp_requested boolean := false;
  begin
    if v_vp_raw is not null and pg_catalog.jsonb_typeof(v_vp_raw) <> 'null' then
      if pg_catalog.jsonb_typeof(v_vp_raw) <> 'boolean' then
        raise exception using errcode = 'P0001', message = 'SCANYM_VACUUM_PACKING_MALFORMED';
      end if;
      v_vp_requested := (v_vp_raw #>> '{}')::boolean;
    end if;

    if v_vp_requested then
      if not exists (
        select 1
        from public.order_items oi
        join public.menu_items mi on mi.id = oi.menu_item_id
        join public.menu_categories mc on mc.id = mi.category_id
        where oi.order_id = v_order_id and mc.vacuum_packable
      ) then
        raise exception using errcode = 'P0001', message = 'SCANYM_VACUUM_PACKING_NOT_APPLICABLE';
      end if;

      update public.orders set vacuum_packing_requested = true where id = v_order_id;
    end if;
  end;
  -- VACUUM-PACKING END
$blk$;

  v_new := replace(v_def, c_anchor, c_anchor || v_block);

  if v_new = v_def then
    raise exception 'SCANYM_PATCH_FAILED: aucun remplacement effectué -- migration annulée.';
  end if;

  execute v_new;
end
$lot$;

-- ---------------------------------------------------------------------------
-- 3. set_category_vacuum_packable : seul chemin d'écriture de l'indicateur
-- ---------------------------------------------------------------------------
create function public.set_category_vacuum_packable(
  p_category_id uuid,
  p_vacuum_packable boolean
) returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  -- Même garde que update_category : propriétaire ou gérant de l'établissement de la catégorie.
  perform public.assert_category_role(p_category_id, array['owner','manager']);

  if p_vacuum_packable is null then
    raise exception using errcode = '22023', message = 'vacuum_packable is required';
  end if;

  update public.menu_categories
  set vacuum_packable = p_vacuum_packable
  where id = p_category_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;
end
$fn$;

revoke all on function public.set_category_vacuum_packable(uuid, boolean) from public, anon;
grant execute on function public.set_category_vacuum_packable(uuid, boolean) to authenticated;

comment on function public.set_category_vacuum_packable(uuid, boolean) is
  'Marque une catégorie comme éligible (ou non) à la mise sous vide. Propriétaire/gérant uniquement (assert_category_role). Ne touche à aucune autre colonne.';

-- ---------------------------------------------------------------------------
-- 4. POST-CONTRÔLES (échec => tout le lot est annulé)
-- ---------------------------------------------------------------------------
do $lot$
declare
  c_sig    constant text := 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)';
  v_def    text;
  v_acl    text;
  v_n      integer;
begin
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order';
  if v_n <> 1 then
    raise exception 'SCANYM_POSTCHECK: create_order a % surcharge(s) -- migration annulée.', v_n;
  end if;

  v_def := pg_get_functiondef(to_regprocedure(c_sig));
  if (length(v_def) - length(replace(v_def, '-- VACUUM-PACKING BEGIN', ''))) / length('-- VACUUM-PACKING BEGIN') <> 1
     or (length(v_def) - length(replace(v_def, '-- VACUUM-PACKING END', ''))) / length('-- VACUUM-PACKING END') <> 1 then
    raise exception 'SCANYM_POSTCHECK: bloc VACUUM-PACKING absent ou dupliqué dans create_order -- migration annulée.';
  end if;
  if position('-- CSDJ-3 BEGIN' in v_def) = 0 or position('-- CSDJ-3 END' in v_def) = 0
     or position('-- CSDJ-3 END' in v_def) > position('-- VACUUM-PACKING BEGIN' in v_def) then
    raise exception 'SCANYM_POSTCHECK: le bloc CSDJ-3 a été altéré ou le bloc vacuum n''est pas après lui -- migration annulée.';
  end if;

  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(c_sig)
                 and p.prosecdef and p.proconfig = array['search_path=""']) then
    raise exception 'SCANYM_POSTCHECK: create_order a perdu SECURITY DEFINER ou son search_path -- migration annulée.';
  end if;

  select string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' order by a.grantee::regrole::text)
    into v_acl
  from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.oid = to_regprocedure(c_sig);
  if v_acl is distinct from 'anon:EXECUTE,authenticated:EXECUTE,postgres:EXECUTE' then
    raise exception 'SCANYM_POSTCHECK: droits de create_order modifiés (%) -- migration annulée.', v_acl;
  end if;

  select string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' order by a.grantee::regrole::text)
    into v_acl
  from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.oid = to_regprocedure('public.set_category_vacuum_packable(uuid,boolean)');
  if v_acl is distinct from 'authenticated:EXECUTE,postgres:EXECUTE' then
    raise exception 'SCANYM_POSTCHECK: droits de set_category_vacuum_packable inattendus (%) -- migration annulée.', v_acl;
  end if;

  if (select count(*) from public.menu_categories where vacuum_packable) <> 0 then
    raise exception 'SCANYM_POSTCHECK: une catégorie est déjà vacuum_packable -- le lot ne doit activer aucune catégorie.';
  end if;
end
$lot$;

commit;
