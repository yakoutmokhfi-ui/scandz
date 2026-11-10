-- DRAFT. Stop BOTH invoice workers and schema edits first. No CASCADE. No deletion of issued invoices.
begin;
lock table public.invoice_pdf_documents,public.invoice_pdf_settings,public.invoice_pdf_deliveries,public.invoice_pdf_blocked,public.invoice_pdf_manifest in access exclusive mode;
do $$ begin
  if (select count(*) from public.invoice_pdf_manifest)<>1 or
    (select fingerprint from public.invoice_pdf_manifest) is distinct from (select encode(sha256(convert_to(jsonb_build_object(
  'functions',(select jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
    'owner',p.proowner,'acl',p.proacl,'comment',obj_description(p.oid,'pg_proc')) order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('invoice_pdf_source','invoice_pdf_issue','invoice_pdf_store','invoice_pdf_claim_delivery','invoice_pdf_finish_delivery','invoice_pdf_candidates','invoice_pdf_block','invoice_pdf_fingerprint','invoice_pdf_guard_document','invoice_pdf_activation_boundary')),
  'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'columns',(select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl,pg_get_expr(ad.adbin,ad.adrelid),a.attidentity::text,a.attgenerated::text,a.attcollation,a.attstorage::text,a.attstattarget,a.attoptions::text,a.atthasdef) order by a.attnum)
      from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid=c.oid),
    'indexes',(select jsonb_agg(pg_get_indexdef(indexrelid) order by indexrelid::regclass::text) from pg_index where indrelid=c.oid),
    'triggers',(select jsonb_agg(jsonb_build_array(pg_get_triggerdef(oid),tgenabled::text) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
    'statistics',(select jsonb_agg(jsonb_build_array(stxname,pg_get_statisticsobjdef(oid)) order by stxname) from pg_statistic_ext where stxrelid=c.oid),
    'rules',(select jsonb_agg(rulename order by rulename) from pg_rewrite where ev_class=c.oid),
    'storage',jsonb_build_array(c.reloptions::text,c.relreplident::text,obj_description(c.oid,'pg_class')),
    'column_comments',(select jsonb_agg(jsonb_build_array(a.attname,col_description(c.oid,a.attnum)) order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'policies',(select jsonb_agg(jsonb_build_array(polname,polcmd,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)) order by polname) from pg_policy where polrelid=c.oid)) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in
      ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))
 )::text,'UTF8')),'hex')) then
    raise exception 'SCANYM_INVOICE_ROLLBACK_DRIFT'; end if;
  -- Any object that depends on these tables, other than their own constraints/indexes/defaults/triggers/policies, would
  -- be silently dropped (statistics, rules, publications, sequences) or would break the drop (views, foreign keys).
  if exists(select 1 from pg_depend d
    where d.refclassid='pg_class'::regclass and d.deptype<>'i'
      and d.refobjid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in
        ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))
      and not (d.classid='pg_constraint'::regclass and d.objid in (select k.oid from pg_constraint k where k.conrelid in (select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname='public' and c2.relname in ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))))
      and not (d.classid='pg_class'::regclass and d.objid in (select i.indexrelid from pg_index i where i.indrelid in (select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname='public' and c2.relname in ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))))
      and not (d.classid='pg_attrdef'::regclass and d.objid in (select a.oid from pg_attrdef a where a.adrelid in (select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname='public' and c2.relname in ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))))
      and not (d.classid='pg_trigger'::regclass and d.objid in (select t.oid from pg_trigger t where t.tgrelid in (select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname='public' and c2.relname in ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))))
      and not (d.classid='pg_policy'::regclass and d.objid in (select o.oid from pg_policy o where o.polrelid in (select c2.oid from pg_class c2 join pg_namespace n2 on n2.oid=c2.relnamespace where n2.nspname='public' and c2.relname in ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))))) then
    raise exception 'SCANYM_INVOICE_ROLLBACK_DEPENDENCY'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
      and position('invoice_pdf_' in lower(p.prosrc))>0
      and not (n.nspname='public' and p.proname in
        ('invoice_pdf_source','invoice_pdf_issue','invoice_pdf_store','invoice_pdf_claim_delivery','invoice_pdf_finish_delivery','invoice_pdf_candidates','invoice_pdf_block','invoice_pdf_fingerprint','invoice_pdf_guard_document','invoice_pdf_activation_boundary'))) then
    raise exception 'SCANYM_INVOICE_ROLLBACK_CONSUMER'; end if;
  if exists(select 1 from public.invoice_pdf_blocked) or exists(select 1 from public.invoice_pdf_documents) or exists(select 1 from public.invoice_pdf_deliveries)
    or exists(select 1 from public.invoice_pdf_settings where enabled or next_number<>1) then
    raise exception 'SCANYM_INVOICE_ROLLBACK_HAS_RECORDS'; end if;
end $$;
drop function public.invoice_pdf_candidates();
drop function public.invoice_pdf_block(uuid,jsonb);
drop function public.invoice_pdf_finish_delivery(uuid,uuid,text);
drop function public.invoice_pdf_claim_delivery(uuid,uuid);
drop function public.invoice_pdf_store(uuid,text);
drop function public.invoice_pdf_issue(uuid,jsonb);
drop function public.invoice_pdf_source(uuid);
drop function public.invoice_pdf_fingerprint();
drop table public.invoice_pdf_manifest;
drop trigger invoice_pdf_archive_guard on public.invoice_pdf_documents;
drop trigger invoice_pdf_activation_guard on public.invoice_pdf_settings;
drop function public.invoice_pdf_guard_document();
drop function public.invoice_pdf_activation_boundary();
drop table public.invoice_pdf_blocked;
drop table public.invoice_pdf_deliveries;
drop table public.invoice_pdf_documents;
drop table public.invoice_pdf_settings;
commit;
