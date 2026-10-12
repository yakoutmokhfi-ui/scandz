-- ============================================================
-- Scanym — DELIVERY CUSTOMER TEXT 1000 v1 — ROLLBACK (DRAFT)
--
-- DRAFT ONLY. DO NOT APPLY TO HOSTED SUPABASE.
--
-- Remet EXACTEMENT l'état d'avant
-- DRAFT-lot-delivery-customer-text-1000-v1.sql : borne 500 sur la
-- colonne source, borne 500 sur le cliché de commande, garde
-- applicative « customer_text exceeds 500 characters ».
--
-- AVERTISSEMENT DONNÉES — et c'est la raison d'être de la garde
-- ci-dessous : redescendre la borne à 500 alors qu'un commerçant a
-- déjà saisi un texte plus long rendrait ces lignes INVALIDES au
-- regard de la nouvelle contrainte. PostgreSQL REFUSERAIT alors
-- l'ajout du CHECK (c'est déjà un échec fermé), mais l'échec
-- arriverait au milieu du fichier, sans dire quoi faire. Ce rollback
-- CONSTATE d'abord, nomme les lignes concernées, et refuse AVANT toute
-- destruction : exporter ou raccourcir ces textes est une décision
-- humaine, jamais une conséquence silencieuse d'un rollback.
--
-- SÛRETÉ TRANSACTIONNELLE : `begin;` est la PREMIÈRE instruction, les
-- verrous sont pris AVANT les gardes et tenus jusqu'au commit, les
-- gardes vivent DANS la transaction, et `commit;` est la DERNIÈRE
-- instruction. Une garde qui lève abandonne la transaction : toutes
-- les instructions suivantes échouent avec « current transaction is
-- aborted » et le `commit;` final se comporte en ROLLBACK. La bascule
-- est donc INATTEIGNABLE, que l'exécuteur s'arrête à la première
-- erreur ou non.
--
-- N'annule RIEN d'autre : ni tarif, ni routage, ni
-- `mutate_merchant_delivery_rule` (dont l'empreinte est épinglée par
-- DELIVERY RULE DELETE v1), ni `create_order`, ni la borne du texte
-- générique PAR MODE (restaurant_sale_modes.customer_text), restée à
-- 500 de bout en bout.
-- ============================================================

begin;

lock table public.restaurant_sale_mode_fulfillments in share mode;
lock table public.order_delivery_fulfillment_snapshot in share mode;

do $dct1000_rb_guard$
declare
  v_src_def   text;
  v_long_rules bigint;
  v_long_snaps bigint;
  v_fn_def    text;
begin
  select pg_get_constraintdef(c.oid) into v_src_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.restaurant_sale_mode_fulfillments'::regclass
    and c.conname = 'rsmf_customer_text_length';
  if v_src_def is null then
    raise exception 'SCANYM_NOTHING_TO_ROLL_BACK: rsmf_customer_text_length absente -- DELIVERY CUSTOMER TEXT 1000 v1 n''est pas appliqué.';
  end if;
  if v_src_def not like '%1000%' then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: rsmf_customer_text_length ne porte pas la borne 1000 attendue (%) -- révision manuelle requise.', v_src_def;
  end if;

  v_fn_def := pg_get_functiondef('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure);
  if v_fn_def not like '%customer_text exceeds 1000 characters%' then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: la garde applicative n''est pas dans l''état de ce lot -- une modification ultérieure non revue peut exister, révision manuelle requise.';
  end if;

  -- GARDE DE DONNÉES : des textes réellement saisis au-delà de 500.
  select count(*) into v_long_rules
  from public.restaurant_sale_mode_fulfillments
  where customer_text is not null and length(customer_text) > 500;
  if v_long_rules > 0 then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: % règle(s) de livraison portent un texte client de plus de 500 caractères saisi par le commerçant ; redescendre la borne les rendrait invalides. Exporter ou raccourcir ces textes et décider explicitement avant de rejouer ce rollback.', v_long_rules;
  end if;

  -- Idem côté cliché de commande : une commande HISTORIQUE porte une
  -- trace légale du texte affiché au client. Elle ne se raccourcit
  -- pas : si une seule existe, le rollback est refusé.
  select count(*) into v_long_snaps
  from public.order_delivery_fulfillment_snapshot
  where customer_text is not null and length(customer_text) > 500;
  if v_long_snaps > 0 then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: % cliché(s) de commande portent un texte client de plus de 500 caractères -- trace historique d''une commande, jamais raccourcie par un rollback. Révision manuelle requise.', v_long_snaps;
  end if;
end $dct1000_rb_guard$;

-- À partir d'ici, et seulement si AUCUNE garde n'a levé.

-- 1. Colonne source — retour à 500, sous le nom NOMMÉ posé par le lot
--    aller (le nom généré d'origine n'est pas reproductible ; un CHECK
--    nommé portant la MÊME condition est strictement équivalent).
alter table public.restaurant_sale_mode_fulfillments
  drop constraint rsmf_customer_text_length;

alter table public.restaurant_sale_mode_fulfillments
  add constraint rsmf_customer_text_length
  check (customer_text is null or length(customer_text) <= 500);

comment on column public.restaurant_sale_mode_fulfillments.customer_text is
  'Texte client de la règle, affiché tel quel dans la fenêtre « Comment passer commande » de la vitrine. Au plus 500 caractères ; au-delà, l''écriture est refusée, jamais tronquée.';

-- 2. Cliché de commande — retour à 500.
alter table public.order_delivery_fulfillment_snapshot
  drop constraint odfs_customer_text_length;

alter table public.order_delivery_fulfillment_snapshot
  add constraint odfs_customer_text_length
  check (customer_text is null or length(customer_text) <= 500);

-- 3. Garde applicative — retour à 500, même retouche chirurgicale.
do $dct1000_rb_patch$
declare
  v_def text := replace(
    pg_get_functiondef('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure),
    chr(13) || chr(10), chr(10));
  v_old text;
  v_new text;
begin
  v_old := $dct_rb_old$  if v_clean_text is not null and length(v_clean_text) > 1000 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 1000 characters';$dct_rb_old$;
  v_new := $dct_rb_new$  if v_clean_text is not null and length(v_clean_text) > 500 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 500 characters';$dct_rb_new$;
  v_old := replace(v_old, chr(13) || chr(10), chr(10));
  v_new := replace(v_new, chr(13) || chr(10), chr(10));
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: l''ancre de la garde de longueur n''est pas unique -- révision manuelle requise.';
  end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $dct1000_rb_patch$;

-- 4. VÉRIFICATIONS DE ROLLBACK.
do $dct1000_rb_check$
declare
  v_src_def  text;
  v_snap_def text;
  v_fn_def   text;
begin
  select pg_get_constraintdef(c.oid) into v_src_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.restaurant_sale_mode_fulfillments'::regclass
    and c.conname = 'rsmf_customer_text_length';
  if v_src_def is null or v_src_def not like '%500%' or v_src_def like '%1000%' then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la borne source n''est pas revenue à 500.';
  end if;

  select pg_get_constraintdef(c.oid) into v_snap_def
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.order_delivery_fulfillment_snapshot'::regclass
    and c.conname = 'odfs_customer_text_length';
  if v_snap_def is null or v_snap_def not like '%500%' or v_snap_def like '%1000%' then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la borne du cliché n''est pas revenue à 500.';
  end if;

  v_fn_def := pg_get_functiondef('public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure);
  if v_fn_def not like '%customer_text exceeds 500 characters%' or v_fn_def like '%exceeds 1000 characters%' then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la garde applicative n''est pas revenue à 500.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)'::regprocedure
      and p.prosecdef
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la fonction a perdu SECURITY DEFINER.';
  end if;

  -- HORS PÉRIMÈTRE, intact : le writer de règles de B5 / DELIVERY RULE
  -- DELETE v1, dont l'empreinte est épinglée ailleurs, et le texte
  -- générique PAR MODE.
  if to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)') is null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: mutate_merchant_delivery_rule a disparu -- hors périmètre de ce lot.';
  end if;
end $dct1000_rb_check$;

commit;
