-- ORDER HELP TRANSLATIONS v1 rollback.
-- Refuses to discard merchant translations. Export or remove them first.
begin;
set local lock_timeout = '10s';
lock table public.merchant_communication_text in access exclusive mode;
do $$
declare
  v record;
  f record;
  v_acl text[];
  v_expected_acl text[];
begin
  if to_regclass('public.merchant_communication_text') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_communication_text is missing';
  end if;
  -- Compare exact function bodies (LF or CRLF) and all security-relevant metadata.
  for v in select * from (values
    ('get_restaurant_public_order_help_texts', 'public.get_restaurant_public_order_help_texts(uuid)',
     'a54c8f7f9335b4e5cc9ab9089ae46747', '3626228d450329e2e7ac58ecbe40e91d', 'sql', 's', true, 1000::real,
     'p_restaurant_id uuid', 'TABLE(text_key text, body text, body_hash text, translations jsonb)', true),
    ('write_order_help_translation', 'public.write_order_help_translation(uuid,text,text,text,text,text)',
     '0e922a7bd6a4308d8396ab8f69dd258d', '381ec172cf809fb96b1e469d9a814551', 'plpgsql', 'v', false, 0::real,
     'p_restaurant_id uuid, p_text_key text, p_lang text, p_value text, p_status text, p_expected_source_hash text DEFAULT NULL::text', 'void', false)
  ) as x(name, signature, body_lf, body_crlf, language, volatility, returns_set, row_count, args, result, public_read)
  loop
    select p.*, l.lanname, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
      into f from pg_proc p join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure(v.signature);
    if f.oid is null or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=v.name) <> 1 then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: function % missing or overloaded', v.name;
    end if;
    if md5(f.prosrc) not in (v.body_lf,v.body_crlf) or f.lanname<>v.language
       or f.prokind<>'f' or not f.prosecdef or f.proisstrict or f.proleakproof
       or f.provolatile::text<>v.volatility or f.proparallel<>'u' or f.proretset<>v.returns_set
       or f.procost<>100 or f.prorows<>v.row_count or f.prosupport<>0::oid or f.provariadic<>0::oid
       or f.proconfig is distinct from array['search_path=""']::text[]
       or f.args is distinct from v.args or f.result is distinct from v.result
       or obj_description(f.oid, 'pg_proc') is not null
       or pg_get_userbyid(f.proowner)<>current_user then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: function % definition changed', v.name;
    end if;
    select array_agg(entry order by entry) into v_acl from (
      select format('%s=%s/%s%s', case when a.grantee=0 then 'PUBLIC' else a.grantee::regrole::text end,
        a.privilege_type,a.grantor::regrole::text,case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
      from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
    ) grants;
    select array_agg(x order by x) into v_expected_acl from unnest(case when v.public_read then array[
      format('%s=EXECUTE/%s',f.proowner::regrole,f.proowner::regrole),
      format('%s=EXECUTE/%s',to_regrole('anon'),f.proowner::regrole),
      format('%s=EXECUTE/%s',to_regrole('authenticated'),f.proowner::regrole)] else array[
      format('%s=EXECUTE/%s',f.proowner::regrole,f.proowner::regrole),
      format('%s=EXECUTE/%s',to_regrole('authenticated'),f.proowner::regrole)] end) x;
    if v_acl is distinct from v_expected_acl then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: function % rights changed', v.name;
    end if;
  end loop;
  -- Do not drop columns whose definitions have changed since installation.
  if not exists (select 1 from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.merchant_communication_text'::regclass and a.attname='translations' and not a.attisdropped
      and format_type(a.atttypid,a.atttypmod)='jsonb' and a.attgenerated='' and not a.attnotnull and d.oid is null and a.attacl is null
      and col_description(a.attrelid,a.attnum)='ORDER HELP TRANSLATIONS v1: merchant-approved translations keyed by active language; only order_help_* entries are written by write_order_help_translation.')
     or not exists (select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.merchant_communication_text'::regclass and a.attname='body_hash' and not a.attisdropped
      and format_type(a.atttypid,a.atttypmod)='text' and a.attgenerated='s' and not a.attnotnull and a.attacl is null
      and col_description(a.attrelid,a.attnum)='Generated hash of the merchant-authored source text; used to mark translations stale when the source changes.'
      and pg_get_expr(d.adbin,d.adrelid)=$expr$md5(COALESCE(body, ''::text))$expr$) then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: order help column definition changed';
  end if;
  if exists (
    select 1 from public.merchant_communication_text
    where translations is not null and translations <> '{}'::jsonb
  ) then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: communication text translations exist; export them before rollback';
  end if;
end $$;
drop function public.get_restaurant_public_order_help_texts(uuid);
drop function public.write_order_help_translation(uuid,text,text,text,text,text);
alter table public.merchant_communication_text drop column body_hash, drop column translations;
commit;
