-- Stop writes before rollback; refuse to destroy any merchant translations.
begin;
set local lock_timeout = '10s';
lock table public.menu_tag_translations in access exclusive mode;
do $$
declare
  v_oid oid;
  v_name text;
  v_expected_hash text;
  v_expected_crlf_hash text;
  v_expected_volatility "char";
begin
  -- Refuse to overwrite a later change to any of the functions we remove.
  -- Match exact LF or exact CRLF bodies; mixed endings are not normalised.
  for v_name, v_expected_hash, v_expected_crlf_hash, v_expected_volatility in
    values ('get_merchant_tag_translations','5c49c6acb670898c6cb472a230c942f5','6b1d01435a71e464e5c9d19b962970bb','s'::"char"),
           ('get_public_tag_translations','102bb5baa67d29798056b17f91583939','4c205fe2f461b8b77855b571fe1ca6d2','s'::"char"),
           ('write_tag_translation','fad342b18dd425a2e5e7f24e1b0b43ee','5af1446ba259b60b40c5aab47de4f758','v'::"char")
  loop
    select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name
        and md5(p.prosrc) in (v_expected_hash, v_expected_crlf_hash) and p.prosecdef and not p.proisstrict
        and not p.proleakproof and p.provolatile=v_expected_volatility and p.proparallel='u'
        and p.proconfig=array['search_path=""']::text[] and pg_get_userbyid(p.proowner)=current_user;
    if v_oid is null or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name) <> 1 then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: % changed', v_name;
    end if;
    if exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=v_oid and (a.is_grantable or (a.grantee <> p.proowner and
        a.grantee not in (select oid from pg_roles where rolname=any(case when v_name='get_public_tag_translations'
          then array['anon','authenticated'] else array['authenticated'] end))))) then
      raise exception 'SCANYM_PREDECESSOR_DRIFT: % grants changed', v_name;
    end if;
    v_oid := null;
  end loop;
  if exists(select 1 from public.menu_tag_translations) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: tag translations exist';
  end if;
end $$;
drop function public.get_public_tag_translations(uuid);
drop function public.get_merchant_tag_translations(uuid);
drop function public.write_tag_translation(uuid,uuid,text,text,text,text);
drop table public.menu_tag_translations;
commit;
