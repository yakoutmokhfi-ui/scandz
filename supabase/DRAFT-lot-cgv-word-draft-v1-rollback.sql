-- Stop CGV writes and revert application first. Never deletes saved drafts.
begin;
set local lock_timeout = '5s';
lock table public.merchant_cgv_word_draft in access exclusive mode;
lock table public.cgv_word_draft_install_manifest in access exclusive mode;
do $rollback$ declare actual jsonb; expected jsonb; begin
  if exists(select 1 from public.merchant_cgv_word_draft) then raise exception 'SCANYM_ROLLBACK_HAS_DATA'; end if;
  select snapshot into expected from public.cgv_word_draft_install_manifest where identity;
  actual := (select jsonb_build_object(
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
));
  if expected is null or actual is distinct from expected then raise exception 'SCANYM_ROLLBACK_DRIFT'; end if;
  -- PL/pgSQL / string-body SQL references need not appear in pg_depend.
  -- Reject visible third-party routine consumers as well as DROP dependencies.
  if exists(select 1 from pg_proc p where p.oid not in
      ('public.save_merchant_cgv_word_draft(uuid,text,jsonb)'::regprocedure,
       'public.get_merchant_cgv_word_draft(uuid,uuid)'::regprocedure)
      and p.prosrc ~* '(merchant_cgv_word_draft|cgv_word_draft_install_manifest)')
  then raise exception 'SCANYM_ROLLBACK_DRIFT: third party routine consumer'; end if;
end $rollback$;
-- RESTRICT (default), never CASCADE: any third-party consumer aborts transaction.
drop function public.get_merchant_cgv_word_draft(uuid,uuid);
drop function public.save_merchant_cgv_word_draft(uuid,text,jsonb);
drop table public.merchant_cgv_word_draft;
drop table public.cgv_word_draft_install_manifest;
commit;
