-- ============================================================
-- Scanym — CATALOGUE MANAGEMENT UX v1
--
-- EXTENSION MINIMALE de COLLECTIONS / TAGS FOUNDATION v1.1, déjà
-- publiée (Release Train v1.1). Ce lot n'introduit AUCUN nouveau
-- modèle de tags : `menu_tags` et `menu_item_tags` sont utilisées
-- telles quelles, sans la moindre modification de structure -- aucun
-- ALTER TABLE, aucune colonne, aucun index, aucune contrainte.
--
-- ------------------------------------------------------------------
-- POURQUOI CE FICHIER EXISTE (à lire avant de le relire)
-- ------------------------------------------------------------------
-- Le mandat CATALOGUE MANAGEMENT UX v1 exige, côté marchand :
--   §5 « remove a tag association » ;
--   §5 « show current tags » sur chaque produit ;
--   §7 filtrer le catalogue par tag.
--
-- Or les contrats publiés ne permettent AUCUN des trois :
--
--   1. RETRAIT. Il n'existe aucune RPC de retrait d'association, et
--      `menu_item_tags` a RLS activée SANS policy d'écriture : un
--      DELETE direct est refusé même au propriétaire du restaurant
--      (comportement volontaire de la fondation, prouvé par son
--      propre harnais). Le retrait est donc structurellement
--      impossible sans une RPC dédiée.
--
--   2. LECTURE MARCHAND. `get_restaurant_tags` retourne les tags et
--      un simple COMPTE de produits, jamais la carte produit -> tags.
--      `get_restaurant_collections` retourne bien cette carte, mais
--      UNIQUEMENT pour les collections PUBLIÉES
--      (visible_on_customer_menu = true), d'un établissement PUBLIÉ,
--      et seulement pour les produits disponibles et non archivés :
--      c'est le contrat CLIENT. Le backoffice marchand doit au
--      contraire voir TOUS les tags de TOUS ses produits, y compris
--      les tags non publiés et les produits indisponibles ou
--      archivés -- sinon il ne peut ni les afficher ni les filtrer.
--
-- Ce fichier ajoute donc exactement DEUX fonctions, sur les tables
-- existantes, en réutilisant l'autorisation existante
-- (`assert_tag_admin` : owner/manager du restaurant OU opérateur
-- Scanym). Rien d'autre.
--
-- ------------------------------------------------------------------
-- CE QUE CE LOT NE FAIT PAS
-- ------------------------------------------------------------------
--   - aucune modification de `menu_tags` / `menu_item_tags` ;
--   - aucune modification des 6 RPC de la fondation ;
--   - `get_merchant_catalogue` n'est NI redéfinie NI étendue (la
--     décision CTO de la fondation -- pas de multiplication de lignes
--     produit × tag -- reste intégralement respectée) ;
--   - aucune suppression de TAG : retirer une association ne supprime
--     jamais l'entité tag du tenant (mandat §5, littéral).
--
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur Production par ce lot.
-- ============================================================

-- ------------------------------------------------------------------
-- 0. CONTRÔLES DE DÉRIVE -- la fondation doit être présente.
-- ------------------------------------------------------------------
do $$
begin
  if to_regclass('public.menu_tags') is null or to_regclass('public.menu_item_tags') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: COLLECTIONS/TAGS FOUNDATION absente -- lot CATALOGUE MANAGEMENT UX annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_tag_admin'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_tag_admin() introuvable -- lot CATALOGUE MANAGEMENT UX annulé.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 1. remove_product_tag -- retire UNE association produit <-> tag.
--
--    Ne supprime JAMAIS le tag lui-même (mandat §5). Idempotente :
--    retirer une association déjà absente retourne 0 sans erreur, de
--    sorte qu'un double clic ou un retry réseau ne produit jamais
--    d'échec visible pour le marchand.
--
--    Le tenant est re-dérivé depuis le PRODUIT ciblé, jamais fourni
--    par l'appelant -- même règle que `add_product_tags`. Le tag doit
--    en outre appartenir AU MÊME restaurant : un identifiant de tag
--    appartenant à un autre établissement ne peut donc pas être
--    utilisé pour sonder ou modifier quoi que ce soit.
-- ------------------------------------------------------------------
create or replace function public.remove_product_tag(
  p_menu_item_id uuid,
  p_tag_id       uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id     uuid;
  v_tag_restaurant_id uuid;
  v_removed           integer := 0;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_menu_item_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  perform public.assert_tag_admin(v_restaurant_id);

  select t.restaurant_id into v_tag_restaurant_id
  from public.menu_tags t
  where t.id = p_tag_id;

  -- Tag inexistant OU appartenant à un autre établissement : traité
  -- exactement comme "rien à retirer". Jamais un message distinct,
  -- qui permettrait de deviner l'existence d'un tag d'un autre tenant.
  if v_tag_restaurant_id is null or v_tag_restaurant_id <> v_restaurant_id then
    return 0;
  end if;

  delete from public.menu_item_tags mit
  where mit.menu_item_id = p_menu_item_id
    and mit.tag_id = p_tag_id;

  get diagnostics v_removed = row_count;
  return v_removed;
end $$;

-- ------------------------------------------------------------------
-- 2. get_restaurant_product_tags -- carte produit -> tags, vue
--    BACKOFFICE.
--
--    Une ligne par PRODUIT portant au moins un tag, avec ses tags
--    AGRÉGÉS : aucune multiplication produit × tag, exactement la
--    même discipline que `get_restaurant_collections`.
--
--    Contrairement au contrat client, cette vue expose TOUS les tags
--    actifs du tenant -- publiés ou non -- et TOUS ses produits, y
--    compris indisponibles et archivés : c'est précisément ce que le
--    marchand doit pouvoir voir et filtrer dans son backoffice.
--    Elle n'est jamais accessible à `anon`.
-- ------------------------------------------------------------------
create or replace function public.get_restaurant_product_tags(p_restaurant_id uuid)
returns table (
  menu_item_id uuid,
  tag_ids      uuid[],
  tag_names    text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_tag_admin(p_restaurant_id);

  return query
  select mi.id,
         array_agg(t.id   order by t.display_order, t.name),
         array_agg(t.name order by t.display_order, t.name)
  from public.menu_item_tags mit
  join public.menu_tags t on t.id = mit.tag_id
  join public.menu_items mi on mi.id = mit.menu_item_id
  join public.menu_categories mc on mc.id = mi.category_id
  where mc.restaurant_id = p_restaurant_id
    and t.restaurant_id = p_restaurant_id
    and t.is_active = true
  group by mi.id;
end $$;

-- ------------------------------------------------------------------
-- 3. DROITS -- jamais `anon` : ce sont des contrats BACKOFFICE.
-- ------------------------------------------------------------------
revoke all on function public.remove_product_tag(uuid, uuid) from public, anon;
grant execute on function public.remove_product_tag(uuid, uuid) to authenticated;

revoke all on function public.get_restaurant_product_tags(uuid) from public, anon;
grant execute on function public.get_restaurant_product_tags(uuid) to authenticated;

-- ------------------------------------------------------------------
-- 4. VÉRIFICATION POST-APPLICATION -- échec = ROLLBACK automatique.
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('remove_product_tag', 'get_restaurant_product_tags')
  loop
    if v_def not ilike '%security definer%' or v_def not ilike '%search_path%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RPC sans SECURITY DEFINER / search_path explicite.';
    end if;
    if v_def not ilike '%assert_tag_admin%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RPC sans contrôle d''autorisation assert_tag_admin.';
    end if;
  end loop;

  -- Aucune RPC de ce lot ne doit supprimer un TAG ni muter le catalogue.
  for v_def in
    select pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('remove_product_tag', 'get_restaurant_product_tags')
  loop
    if v_def ilike '%delete from public.menu_tags%'
       or v_def ilike '%update public.menu_tags%'
       or v_def ilike '%delete from public.menu_items%'
       or v_def ilike '%update public.menu_items%'
       or v_def ilike '%menu_categories mc set%' then
      raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une RPC du lot supprime un tag ou mute le catalogue -- interdit.';
    end if;
  end loop;

  -- La fondation doit être intacte : 6 RPC toujours présentes.
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('assert_tag_admin', 'create_tag', 'add_product_tags',
                        'update_tag_collection_settings', 'get_restaurant_tags',
                        'get_restaurant_collections')
  ) <> 6 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: une RPC de la fondation COLLECTIONS/TAGS a disparu.';
  end if;

  -- get_merchant_catalogue ne doit toujours pas exposer de tags.
  select pg_get_function_result(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_merchant_catalogue';
  if v_def ilike '%tag%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_catalogue a été étendue avec des tags -- interdit.';
  end if;
end $$;

-- ============================================================
-- FIN — CATALOGUE MANAGEMENT UX v1
-- ============================================================
