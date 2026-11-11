-- DRAFT rollback. Stop CGV writes and all concurrent DDL. Never CASCADE.
begin;
set local lock_timeout='5s';
lock table public.cgv_merchant_channel_guard_manifest in access exclusive mode;
do $rollback$ declare actual jsonb; saved public.cgv_merchant_channel_guard_manifest; definition text; begin
 if (select count(*) from public.cgv_merchant_channel_guard_manifest)<>1 then raise exception 'SCANYM_ROLLBACK_DRIFT';end if;
 select * into saved from public.cgv_merchant_channel_guard_manifest where id;
 actual := jsonb_build_object(
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
 ) order by c.oid) from pg_class c where c.oid='public.cgv_merchant_channel_guard_manifest'::regclass or c.oid in(select indexrelid from pg_index where indrelid='public.cgv_merchant_channel_guard_manifest'::regclass)));
 if saved.expected is null or actual is distinct from saved.expected then raise exception 'SCANYM_ROLLBACK_DRIFT';end if;
 if exists(select 1 from pg_proc p where p.oid not in('public.resolve_cgv_publication_context(uuid)'::regprocedure,'public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)'::regprocedure,'public._scanym_has_online_withdrawal_runtime_for_restaurant(uuid)'::regprocedure) and p.prosrc ~* '(_scanym_has_online_withdrawal_runtime_for_restaurant|cgv_merchant_channel_guard_manifest)') then raise exception 'SCANYM_ROLLBACK_DRIFT: third party routine';end if;
 if jsonb_array_length(saved.originals)<>2 then raise exception 'SCANYM_ROLLBACK_DRIFT';end if;
 for definition in select jsonb_array_elements_text(saved.originals) loop execute definition;end loop;
end $rollback$;
drop function public._scanym_has_online_withdrawal_runtime_for_restaurant(uuid);
drop table public.cgv_merchant_channel_guard_manifest;
commit;
