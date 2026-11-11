-- DRAFT, manual application only after independent audit. No hosted SQL run.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.merchant_cgv_word_draft') is not null
     or to_regclass('public.cgv_word_draft_install_manifest') is not null
     or to_regprocedure('public.get_merchant_cgv_word_draft(uuid,uuid)') is not null
     or to_regprocedure('public.save_merchant_cgv_word_draft(uuid,text,jsonb)') is not null
  then raise exception 'SCANYM_SCHEMA_DRIFT'; end if;
  if to_regprocedure('public.assert_legal_cgv_role(uuid)') is null
     or to_regprocedure('public._resolve_applicable_cgv_template(uuid)') is null
     or to_regprocedure('public._compute_cgv_publication_context_fingerprint(uuid)') is null
     or to_regprocedure('public.resolve_cgv_publication_context(uuid)') is null
     or to_regprocedure('public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)') is null
  then raise exception 'SCANYM_PREREQUISITE_MISSING'; end if;
end $$;
create table public.merchant_cgv_word_draft (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  base_fingerprint text not null check (base_fingerprint ~ '^[0-9a-f]{32}$'),
  document jsonb not null check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 1500000)
);
create index merchant_cgv_word_draft_latest on public.merchant_cgv_word_draft(restaurant_id,created_at desc,id desc);
alter table public.merchant_cgv_word_draft enable row level security;
revoke all on public.merchant_cgv_word_draft from public,anon,authenticated,service_role;
-- Append-only draft history. No UPDATE/DELETE grants or RPC. JSON from a direct
-- RPC caller is UNTRUSTED and always revalidated by Node before publication.
create function public.save_merchant_cgv_word_draft(p_restaurant_id uuid,p_expected_fingerprint text,p_document jsonb)
returns public.merchant_cgv_word_draft
language plpgsql security definer set search_path = '' as $$
declare v_result public.merchant_cgv_word_draft; v_context text;
begin
  perform public.assert_legal_cgv_role(p_restaurant_id);
  -- Same lock order as existing persistence, before authorization recheck.
  perform 1 from public.restaurants where id=p_restaurant_id for update;
  perform 1 from public.merchant_legal_profile where restaurant_id=p_restaurant_id for update;
  perform 1 from public.merchant_cgv_profile where restaurant_id=p_restaurant_id for update;
  perform 1 from public.cgv_template where id=(public._resolve_applicable_cgv_template(p_restaurant_id)).id for update;
  perform 1 from public.restaurant_users where restaurant_id=p_restaurant_id and user_id=auth.uid() for update;
  perform 1 from public.scanym_operators where user_id=auth.uid() for update;
  perform public.assert_legal_cgv_role(p_restaurant_id);
  v_context := public._compute_cgv_publication_context_fingerprint(p_restaurant_id);
  if p_expected_fingerprint is null or v_context is distinct from p_expected_fingerprint then raise exception 'STALE_CONTEXT'; end if;
  insert into public.merchant_cgv_word_draft(restaurant_id,created_by,base_fingerprint,document)
  values(p_restaurant_id,auth.uid(),v_context,p_document) returning * into v_result;
  return v_result;
end $$;
revoke all on function public.save_merchant_cgv_word_draft(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_merchant_cgv_word_draft(uuid,text,jsonb) to authenticated;
create function public.get_merchant_cgv_word_draft(p_restaurant_id uuid,p_draft_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.assert_legal_cgv_role(p_restaurant_id);
  select to_jsonb(d) || jsonb_build_object('published_hash',
    (select v.content_hash from public.merchant_cgv_version v where v.restaurant_id=p_restaurant_id and v.status='ACTIVE' order by v.published_at desc limit 1)) into v_result from public.merchant_cgv_word_draft d
    where d.restaurant_id=p_restaurant_id and (p_draft_id is null or d.id=p_draft_id)
    order by d.created_at desc,d.id desc limit 1;
  return v_result;
end $$;
revoke all on function public.get_merchant_cgv_word_draft(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_merchant_cgv_word_draft(uuid,uuid) to authenticated;
create table public.cgv_word_draft_install_manifest (identity boolean primary key check(identity), snapshot jsonb not null);
alter table public.cgv_word_draft_install_manifest enable row level security;
revoke all on public.cgv_word_draft_install_manifest from public,anon,authenticated,service_role;

insert into public.cgv_word_draft_install_manifest(identity,snapshot) select true,jsonb_build_object(
 'relations',(select jsonb_agg(jsonb_build_object('catalog',to_jsonb(c)-'reltuples'-'relpages'-'relallvisible'-'relfrozenxid'-'relminmxid',
   'columns',(select jsonb_agg(to_jsonb(a) order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0),
   'constraints',(select jsonb_agg(jsonb_build_object('catalog',to_jsonb(k),'def',pg_get_constraintdef(k.oid)) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
   'index',(select to_jsonb(ix) from pg_index ix where ix.indexrelid=c.oid),
   'defaults',(select jsonb_agg(pg_get_expr(d.adbin,d.adrelid) order by d.adnum) from pg_attrdef d where d.adrelid=c.oid),
   'policies',(select jsonb_agg(to_jsonb(p) order by p.polname) from pg_policy p where p.polrelid=c.oid),
   'triggers',(select jsonb_agg(to_jsonb(t) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid),
   'comment',obj_description(c.oid,'pg_class')) order by c.relname)
   from pg_class c where (c.oid in ('public.merchant_cgv_word_draft'::regclass,'public.cgv_word_draft_install_manifest'::regclass) or c.oid in (select indexrelid from pg_index where indrelid in ('public.merchant_cgv_word_draft'::regclass,'public.cgv_word_draft_install_manifest'::regclass)))),
 'routines',(select jsonb_agg(jsonb_build_object('catalog',to_jsonb(p),'comment',obj_description(p.oid,'pg_proc')) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('save_merchant_cgv_word_draft','get_merchant_cgv_word_draft'))
);
commit;
