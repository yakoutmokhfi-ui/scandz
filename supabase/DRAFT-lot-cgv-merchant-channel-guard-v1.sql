-- DRAFT: independent audit + explicit SQL GO required. No CGV text is changed.
-- Changes publication readiness per restaurant; never enables a mailer.
begin;
set local lock_timeout='5s';
do $preflight$ begin
 if to_regclass('public.cgv_merchant_channel_guard_manifest') is not null
 or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_scanym_has_online_withdrawal_runtime_for_restaurant') then raise exception 'SCANYM_SCHEMA_DRIFT';end if;
 if to_regprocedure('public._scanym_has_online_withdrawal_primitives()') is null
 or to_regprocedure('public._scanym_has_operational_durable_ack_channel()') is null
 or to_regprocedure('public.scanym_ack_merchant_mailer_enabled()') is null
 or to_regprocedure('public._scanym_merchant_ack_channel_ready(uuid)') is null then raise exception 'SCANYM_PREREQUISITE_MISSING';end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.resolve_cgv_publication_context(uuid)') and md5(prosrc)='742e05dfac933d0dc8f69a4dd7166ca5' and prosecdef and proconfig=array['search_path=""'] and pg_get_userbyid(proowner)='postgres' and proacl::text='{postgres=X/postgres,authenticated=X/postgres}')
 or not exists(select 1 from pg_proc where oid=to_regprocedure('public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)') and md5(prosrc)='fbd1c39b9fb48bdb91dc8220828ecebe' and prosecdef and proconfig=array['search_path=""'] and pg_get_userbyid(proowner)='postgres' and proacl::text='{postgres=X/postgres,service_role=X/postgres}') then raise exception 'SCANYM_PREDECESSOR_DRIFT';end if;
end $preflight$;
create table public.cgv_merchant_channel_guard_manifest(id boolean primary key check(id), originals jsonb not null, expected jsonb);
alter table public.cgv_merchant_channel_guard_manifest enable row level security;
revoke all on public.cgv_merchant_channel_guard_manifest from public,anon,authenticated,service_role;
insert into public.cgv_merchant_channel_guard_manifest(id,originals) select true,jsonb_agg(pg_get_functiondef(p.oid) order by p.proname) from pg_proc p where p.oid in ('public.resolve_cgv_publication_context(uuid)'::regprocedure,'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)'::regprocedure);
create function public._scanym_has_online_withdrawal_runtime_for_restaurant(p_restaurant_id uuid)
returns boolean language sql stable security definer set search_path='' as $body$
 select p_restaurant_id is not null and exists(select 1 from public.restaurants where id=p_restaurant_id)
 and public._scanym_has_online_withdrawal_primitives()
 and (
  public._scanym_has_operational_durable_ack_channel()
  or (
   public.scanym_ack_merchant_mailer_enabled()
   and public._scanym_merchant_ack_channel_ready(p_restaurant_id)
   and exists(select 1 from public.merchant_email_provider_config c
     join public.merchant_legal_profile l on l.restaurant_id=c.restaurant_id
     where c.restaurant_id=p_restaurant_id and c.last_test_at is not null and c.last_error_class is null
     and length(l.customer_service_email)<=254 and l.customer_service_email !~ '[[:cntrl:]]'
     and l.customer_service_email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+[.][A-Za-z]{2,}$')
  )
 );
$body$;
revoke all on function public._scanym_has_online_withdrawal_runtime_for_restaurant(uuid) from public,anon,authenticated,service_role;
-- Replace only the executable guard occurrence; no change to auth/content/history.
do $patch$ declare ident text; src text; needle text := 'and not public._scanym_has_online_withdrawal_runtime()'; begin
 foreach ident in array array['public.resolve_cgv_publication_context(uuid)','public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)'] loop
  select pg_get_functiondef(ident::regprocedure) into src;
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'SCANYM_PREDECESSOR_DRIFT';end if;
  execute replace(src,needle,'and not public._scanym_has_online_withdrawal_runtime_for_restaurant(p_restaurant_id)');
 end loop;
end $patch$;
update public.cgv_merchant_channel_guard_manifest set expected=jsonb_build_object(
 'routines',(select jsonb_agg(jsonb_build_object('catalog',to_jsonb(p),'comment',obj_description(p.oid,'pg_proc')) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('resolve_cgv_publication_context','persist_merchant_cgv_version','_scanym_has_online_withdrawal_runtime_for_restaurant')),
 'relations',(select jsonb_agg(jsonb_build_object(
 'catalog',to_jsonb(c)-'reltuples'-'relpages'-'relallvisible'-'relallfrozen'-'relfrozenxid'-'relminmxid',
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attnum) from pg_attribute a where a.attrelid=c.oid),
 'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k where k.conrelid=c.oid),
 'defaults',(select jsonb_agg(to_jsonb(a) order by a.adnum) from pg_attrdef a where a.adrelid=c.oid),
 'indexes',(select to_jsonb(i) from pg_index i where i.indexrelid=c.oid),
 'dependencies',(select jsonb_agg(to_jsonb(d) order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype) from pg_depend d where (d.classid='pg_class'::regclass and d.objid=c.oid) or (d.refclassid='pg_class'::regclass and d.refobjid=c.oid)),
 'comments',(select jsonb_agg(to_jsonb(d) order by d.objsubid) from pg_description d where d.classoid='pg_class'::regclass and d.objoid=c.oid),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p where p.polrelid=c.oid),
 'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgrelid=c.oid)
 ) order by c.oid) from pg_class c where c.oid='public.cgv_merchant_channel_guard_manifest'::regclass or c.oid in(select indexrelid from pg_index where indrelid='public.cgv_merchant_channel_guard_manifest'::regclass))) where id;
commit;
