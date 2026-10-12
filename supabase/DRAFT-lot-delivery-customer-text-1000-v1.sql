-- ============================================================
-- Scanym — DELIVERY CUSTOMER TEXT 1000 v1 (DRAFT — NOT APPLIED)
--
-- DRAFT ONLY. DO NOT APPLY TO HOSTED SUPABASE.
--
-- CE QUE CE LOT FAIT, ET RIEN D'AUTRE : il porte la borne de longueur
-- du texte client d'une RÈGLE de livraison de 500 à 1000 caractères,
-- aux TROIS endroits qui l'imposent réellement aujourd'hui :
--
--   1. `restaurant_sale_mode_fulfillments.customer_text` — le CHECK de
--      la colonne SOURCE (DRAFT-lot-fulfillment-routing-model.sql).
--      C'est lui qui refuse réellement une valeur trop longue : le
--      writer courant (`mutate_merchant_delivery_rule`, B5 + DELIVERY
--      RULE DELETE v1) n'a pas de garde de longueur propre, il écrit et
--      laisse la contrainte juger.
--   2. `order_delivery_fulfillment_snapshot.customer_text`
--      (`odfs_customer_text_length`, lot B1) — le cliché recopie le
--      texte de la règle retenue au moment de la commande
--      (`create_order` -> `v_resolved.customer_text`). Laisser ce CHECK
--      à 500 pendant que la source monte à 1000 ferait ÉCHOUER la
--      création de commande dès qu'une règle porte un texte plus long :
--      la cohérence cliché/source n'est pas un confort, c'est la
--      condition pour que le lot ne casse pas le checkout.
--   3. `public.update_merchant_delivery_fulfillment_pricing` — la garde
--      applicative « customer_text exceeds 500 characters » (lot
--      DELIVERY PRICING OPERATOR AUTHORIZATION v1), encore atteignable
--      depuis `lib/services/dashboard.ts`. Une borne serveur restée à
--      500 refuserait ce que la colonne accepte désormais.
--
-- CE QUE CE LOT NE FAIT PAS
--
--   - `restaurant_sale_modes.customer_text` reste borné à 500 : c'est
--     le texte générique PAR MODE (retrait / livraison), une AUTRE
--     colonne, non visée par ce lot, et la borne de MERCHANT CUSTOMER
--     COMMUNICATIONS v1 s'y aligne explicitement par commentaire.
--     `update_merchant_delivery_method_notice` garde donc sa garde à
--     500, en cohérence avec SA colonne.
--   - aucune troncature, nulle part : au-delà de 1000, l'écriture est
--     REFUSÉE (violation de contrainte, ou 22023 pour la RPC). Jamais
--     un `left(...)`, jamais un texte coupé en silence.
--   - aucun tarif, aucun routage, aucun fournisseur, aucun code postal,
--     aucun ordre d'affichage, aucune suppression de règle, aucun
--     privilège, aucune RLS, aucune policy, aucun `create_order`,
--     aucun `mutate_merchant_delivery_rule` (dont DELIVERY RULE DELETE
--     v1 épingle l'empreinte md5 du corps : ce lot ne doit surtout pas
--     la modifier, et ne la modifie pas).
--
-- POURQUOI UNE RETOUCHE CHIRURGICALE DE LA FONCTION, ET NON UNE
-- RÉÉCRITURE : le corps de `update_merchant_delivery_fulfillment_pricing`
-- fait plus de cent lignes de règles d'autorisation et de validation
-- tarifaire, auditées ailleurs. Le recopier ici pour changer un nombre
-- serait le meilleur moyen d'y perdre une règle au passage. Ce fichier
-- reprend donc le patron du lot B5 : lire la définition RÉELLE avec
-- `pg_get_functiondef`, exiger que l'ancre à remplacer y figure EXACTEMENT
-- UNE fois, puis réexécuter la définition ainsi corrigée. Signature,
-- défauts, SECURITY DEFINER et ACL sont préservés par construction.
-- ============================================================

-- ------------------------------------------------------------
-- 0. TRANSACTION UNIQUE — ouverte AVANT toute garde.
-- ------------------------------------------------------------
begin;

-- Verrou pris AVANT le constat, relâché seulement au commit : aucune
-- écriture ne peut se glisser entre la garde et la bascule des
-- contraintes. SHARE est le niveau le plus faible qui entre en conflit
-- avec le ROW EXCLUSIVE de tout écrivain, et il laisse passer les
-- lecteurs. Ordre FIXE (source puis cliché) pour ne pas créer
-- d'interblocage avec une autre exécution de ce même fichier.
lock table public.restaurant_sale_mode_fulfillments in share mode;
lock table public.order_delivery_fulfillment_snapshot in share mode;

-- ------------------------------------------------------------
-- 1. PRÉ-VOL — prérequis réels, anti-double-application,
--    anti-dérive. Dans la transaction : une garde qui lève rend
--    TOUTE la suite inatteignable, et le `commit;` final se comporte
--    en ROLLBACK.
-- ------------------------------------------------------------
do $dct1000_preflight$
declare
  v_src_def  text;
  v_snap_def text;
  v_fn_def   text;
begin
  if to_regclass('public.restaurant_sale_mode_fulfillments') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_mode_fulfillments absente -- DRAFT-lot-fulfillment-routing-model.sql doit être appliqué avant, annulé.';
  end if;
  if to_regclass('public.order_delivery_fulfillment_snapshot') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_delivery_fulfillment_snapshot absente -- le lot B1 (order snapshot) doit être appliqué avant, annulé.';
  end if;
  if to_regprocedure('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_delivery_fulfillment_pricing introuvable -- annulé.';
  end if;

  -- Contrainte SOURCE : une seule, et portant bien une borne de
  -- longueur sur customer_text. Le nom est GÉNÉRÉ par PostgreSQL
  -- (CHECK en ligne dans la déclaration de colonne), donc il est
  -- RETROUVÉ par sa définition, jamais supposé.
  select pg_get_constraintdef(c.oid) into v_src_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.restaurant_sale_mode_fulfillments'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%customer_text%length%';
  if v_src_def is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: aucun CHECK de longueur sur restaurant_sale_mode_fulfillments.customer_text -- annulé.';
  end if;

  select pg_get_constraintdef(c.oid) into v_snap_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.order_delivery_fulfillment_snapshot'::regclass
    and c.conname = 'odfs_customer_text_length';
  if v_snap_def is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: odfs_customer_text_length introuvable sur le cliché de commande -- annulé.';
  end if;

  v_fn_def := pg_get_functiondef('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure);

  -- Anti-double-application : si les trois endroits portent déjà 1000,
  -- ce lot est déjà appliqué.
  if v_src_def like '%1000%' and v_snap_def like '%1000%' and v_fn_def like '%exceeds 1000 characters%' then
    raise exception 'SCANYM_ALREADY_APPLIED: la borne du texte client de règle est déjà à 1000 caractères -- annulé.';
  end if;

  -- Anti-dérive : l'état d'entrée doit être EXACTEMENT l'état connu
  -- (500 partout). Un état mixte ou une autre valeur signifie qu'un
  -- travail non revu est passé par là ; ce fichier refuse plutôt que
  -- d'écraser une décision qu'il ne connaît pas.
  if v_src_def not like '%500%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: le CHECK source ne porte pas la borne 500 attendue (%) -- annulé.', v_src_def;
  end if;
  if v_snap_def not like '%500%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: odfs_customer_text_length ne porte pas la borne 500 attendue (%) -- annulé.', v_snap_def;
  end if;
  if v_fn_def not like '%customer_text exceeds 500 characters%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_delivery_fulfillment_pricing ne porte pas la garde 500 attendue -- annulé.';
  end if;

  -- Le texte générique PAR MODE n'est PAS concerné : si sa borne avait
  -- déjà bougé, ce serait un état inattendu dont ce lot n'est pas
  -- l'auteur.
  if exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.restaurant_sale_modes'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%customer_text%length%'
      and pg_get_constraintdef(c.oid) not like '%500%'
  ) then
    raise exception 'SCANYM_UNEXPECTED_STATE: restaurant_sale_modes.customer_text ne porte plus la borne 500 -- hors périmètre de ce lot, annulé.';
  end if;
end $dct1000_preflight$;

-- ------------------------------------------------------------
-- 2. COLONNE SOURCE — 500 -> 1000.
--
-- Le CHECK en ligne d'origine porte un nom GÉNÉRÉ ; il est retrouvé
-- par sa définition puis remplacé par un CHECK NOMMÉ, pour que ce lot
-- et son rollback aient tous deux un nom stable à manipuler.
-- ------------------------------------------------------------
do $dct1000_source$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.restaurant_sale_mode_fulfillments'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%customer_text%length%';
  execute format('alter table public.restaurant_sale_mode_fulfillments drop constraint %I', v_name);
end $dct1000_source$;

alter table public.restaurant_sale_mode_fulfillments
  add constraint rsmf_customer_text_length
  check (customer_text is null or length(customer_text) <= 1000);

comment on column public.restaurant_sale_mode_fulfillments.customer_text is
  'Texte client de la règle, affiché tel quel dans la fenêtre « Comment passer commande » de la vitrine. Au plus 1000 caractères (DELIVERY CUSTOMER TEXT 1000 v1) ; au-delà, l''écriture est refusée, jamais tronquée. Miroir de DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH (lib/delivery-rule-editor.ts).';

-- ------------------------------------------------------------
-- 3. CLICHÉ DE COMMANDE — 500 -> 1000, par COHÉRENCE avec la source.
-- ------------------------------------------------------------
alter table public.order_delivery_fulfillment_snapshot
  drop constraint odfs_customer_text_length;

alter table public.order_delivery_fulfillment_snapshot
  add constraint odfs_customer_text_length
  check (customer_text is null or length(customer_text) <= 1000);

-- ------------------------------------------------------------
-- 4. GARDE APPLICATIVE — retouche chirurgicale, UNE ancre unique.
-- ------------------------------------------------------------
do $dct1000_patch$
declare
  v_def text := replace(
    pg_get_functiondef('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure),
    chr(13) || chr(10), chr(10));
  v_old text;
  v_new text;
begin
  v_old := $dct_old$  if v_clean_text is not null and length(v_clean_text) > 500 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 500 characters';$dct_old$;
  v_new := $dct_new$  if v_clean_text is not null and length(v_clean_text) > 1000 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 1000 characters';$dct_new$;
  v_old := replace(v_old, chr(13) || chr(10), chr(10));
  v_new := replace(v_new, chr(13) || chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_SCHEMA_DRIFT: l''ancre de la garde de longueur n''est pas unique dans update_merchant_delivery_fulfillment_pricing -- annulé.';
  end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $dct1000_patch$;

-- ------------------------------------------------------------
-- 5. POSTCHECKS — exécutés PAR cette migration, avant commit.
-- ------------------------------------------------------------
do $dct1000_postcheck$
declare
  v_src_def  text;
  v_snap_def text;
  v_fn_def   text;
  v_count    integer;
begin
  select pg_get_constraintdef(c.oid) into v_src_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.restaurant_sale_mode_fulfillments'::regclass
    and c.conname = 'rsmf_customer_text_length';
  if v_src_def is null or v_src_def not like '%1000%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: rsmf_customer_text_length absente ou pas à 1000.';
  end if;

  -- Une seule contrainte de longueur sur cette colonne : deux
  -- coexistantes (l''ancienne générée + la nouvelle) laisseraient la
  -- plus stricte gagner en silence.
  select count(*) into v_count
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.restaurant_sale_mode_fulfillments'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%customer_text%length%';
  if v_count <> 1 then
    raise exception 'SCANYM_POSTCHECK_FAILED: % contrainte(s) de longueur sur customer_text, une seule attendue.', v_count;
  end if;

  select pg_get_constraintdef(c.oid) into v_snap_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.order_delivery_fulfillment_snapshot'::regclass
    and c.conname = 'odfs_customer_text_length';
  if v_snap_def is null or v_snap_def not like '%1000%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: odfs_customer_text_length absente ou pas à 1000 -- le cliché refuserait une règle longue.';
  end if;

  v_fn_def := pg_get_functiondef('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure);
  if v_fn_def not like '%customer_text exceeds 1000 characters%'
     or v_fn_def like '%exceeds 500 characters%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: la garde applicative n''est pas passée à 1000.';
  end if;
  -- La retouche n'a rien emporté d'autre : la fonction reste SECURITY
  -- DEFINER, et ses privilèges sont intacts.
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure
      and p.prosecdef
  ) then
    raise exception 'SCANYM_SECURITY_DRIFT: la fonction a perdu SECURITY DEFINER.';
  end if;
  if has_function_privilege('anon', 'public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: anon peut exécuter la RPC d''écriture.';
  end if;

  -- AUCUNE troncature nulle part : la fonction ne doit pas couper.
  if v_fn_def like '%left(%customer_text%' or v_fn_def like '%substring(v_clean_text%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: une troncature est apparue dans la garde de longueur.';
  end if;

  -- HORS PÉRIMÈTRE : le texte générique PAR MODE est toujours à 500.
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.restaurant_sale_modes'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%customer_text%length%'
      and pg_get_constraintdef(c.oid) like '%500%'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: restaurant_sale_modes.customer_text n''est plus à 500 -- hors périmètre.';
  end if;
end $dct1000_postcheck$;

commit;
