-- TAG TRANSLATIONS v1. No hosted changes are made by this file until applied.
begin;
do $$
begin
  if to_regclass('public.menu_tags') is null
     or to_regprocedure('public.assert_tag_admin(uuid)') is null
     or to_regprocedure('public.get_restaurant_collections(uuid)') is null
     or to_regclass('public.restaurant_active_languages') is null
     or to_regclass('public.restaurant_configs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: missing tag translation prerequisites';
  end if;
  if to_regclass('public.menu_tag_translations') is not null
     or to_regprocedure('public.write_tag_translation(uuid,uuid,text,text,text,text)') is not null
     or to_regprocedure('public.get_merchant_tag_translations(uuid)') is not null
     or to_regprocedure('public.get_public_tag_translations(uuid)') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: tag translation objects already exist';
  end if;
end $$;

create table public.menu_tag_translations (
  tag_id uuid not null references public.menu_tags(id) on delete cascade,
  language_code text not null,
  value text not null check (length(btrim(value)) between 1 and 60),
  source_hash text not null,
  status text not null check (status in ('to_review','validated')),
  primary key (tag_id, language_code)
);
alter table public.menu_tag_translations enable row level security;
revoke all on public.menu_tag_translations from public, anon, authenticated;

create function public.get_merchant_tag_translations(p_restaurant_id uuid)
returns table(id uuid, name text, name_hash text, translations jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_tag_admin(p_restaurant_id);
  return query
  select t.id, t.name, md5(t.name), coalesce((
    select jsonb_object_agg(tr.language_code, jsonb_build_object('name',tr.value,'name_status',tr.status,'name_source_hash',tr.source_hash))
    from public.menu_tag_translations tr where tr.tag_id=t.id
  ), '{}'::jsonb)
  from public.menu_tags t where t.restaurant_id=p_restaurant_id and t.is_active
  order by t.display_order,t.name;
end $$;
revoke all on function public.get_merchant_tag_translations(uuid) from public, anon;
grant execute on function public.get_merchant_tag_translations(uuid) to authenticated;

create function public.write_tag_translation(p_restaurant_id uuid,p_tag_id uuid,p_lang text,p_value text,p_status text,p_expected_source_hash text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text; v_hash text; v_source text; v_value text;
begin
  perform public.assert_tag_admin(p_restaurant_id);
  if p_status is null or p_status not in ('to_review','validated') then
    raise exception using errcode='22023', message='Invalid translation status';
  end if;
  if p_lang is null or not exists(select 1 from public.restaurant_active_languages where restaurant_id=p_restaurant_id and language_code=p_lang) then
    raise exception using errcode='22023', message='Language not active';
  end if;
  select source_language into v_source from public.restaurant_configs where restaurant_id=p_restaurant_id;
  if v_source is null or p_lang=v_source then
    raise exception using errcode='22023', message='Cannot translate into source language';
  end if;
  select name into v_name from public.menu_tags where id=p_tag_id and restaurant_id=p_restaurant_id and is_active for update;
  if not found then raise exception using errcode='P0002', message='Tag not found'; end if;
  v_hash := md5(v_name);
  if p_expected_source_hash is null or p_expected_source_hash <> v_hash then
    raise exception using errcode='40001', message='SCANYM_TRANSLATION_SOURCE_CHANGED';
  end if;
  v_value := nullif(btrim(coalesce(p_value,'')), '');
  if v_value is null then
    delete from public.menu_tag_translations where tag_id=p_tag_id and language_code=p_lang;
  else
    if length(v_value)>60 then raise exception using errcode='22001', message='Translation is too long'; end if;
    insert into public.menu_tag_translations(tag_id,language_code,value,source_hash,status)
    values(p_tag_id,p_lang,v_value,v_hash,p_status)
    on conflict(tag_id,language_code) do update set value=excluded.value,source_hash=excluded.source_hash,status=excluded.status;
  end if;
end $$;
revoke all on function public.write_tag_translation(uuid,uuid,text,text,text,text) from public, anon;
grant execute on function public.write_tag_translation(uuid,uuid,text,text,text,text) to authenticated;

-- Reuse the public collection boundary: hidden tags and unavailable merchants remain private.
create function public.get_public_tag_translations(p_restaurant_id uuid)
returns table(tag_id uuid,language_code text,value text)
language sql stable security definer set search_path = '' as $$
  select t.id,tr.language_code,tr.value
  from public.get_restaurant_collections(p_restaurant_id) c
  join public.menu_tags t on t.id=c.id and t.restaurant_id=p_restaurant_id
  join public.menu_tag_translations tr on tr.tag_id=t.id
  join public.restaurant_active_languages al on al.restaurant_id=p_restaurant_id and al.language_code=tr.language_code
  where tr.status='validated' and tr.source_hash=md5(t.name)
$$;
revoke all on function public.get_public_tag_translations(uuid) from public;
grant execute on function public.get_public_tag_translations(uuid) to anon, authenticated;
commit;
