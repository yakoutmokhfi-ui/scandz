-- ORDER HELP TRANSLATIONS v1
-- Add multilingual translations for the merchant-authored storefront
-- order-help button label, dialog title, and dialog body.
-- Apply after MERCHANT CUSTOMER COMMUNICATIONS v1, THEME & CONTENT
-- SETTINGS v1, TRANSLATIONS MANAGEMENT v2, and ORDER HELP BODY 5000 v1.
begin;

do $$
begin
  if to_regclass('public.merchant_communication_text') is null
     or to_regprocedure('public.has_role_in(uuid,text[])') is null
     or to_regprocedure('public.is_scanym_operator()') is null
     or to_regprocedure('public.communication_text_max_length(text)') is null
     or to_regprocedure('public.communication_template_unknown_variables(text)') is null
     or to_regclass('public.restaurant_active_languages') is null
     or to_regclass('public.supported_languages') is null
     or to_regclass('public.restaurant_configs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: order-help translation prerequisites missing';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='merchant_communication_text'
      and column_name in ('translations','body_hash')
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: order-help translation columns already exist';
  end if;
  if public.communication_text_max_length('order_help_body') <> 5000 then
    raise exception 'SCANYM_SCHEMA_DRIFT: order_help_body must have the approved 5000-character limit first';
  end if;
end $$;

alter table public.merchant_communication_text
  add column translations jsonb,
  add column body_hash text generated always as (md5(coalesce(body, ''))) stored;

comment on column public.merchant_communication_text.translations is
  'ORDER HELP TRANSLATIONS v1: merchant-approved translations keyed by active language; only order_help_* entries are written by write_order_help_translation.';
comment on column public.merchant_communication_text.body_hash is
  'Generated hash of the merchant-authored source text; used to mark translations stale when the source changes.';

create function public.write_order_help_translation(
  p_restaurant_id uuid,
  p_text_key text,
  p_lang text,
  p_value text,
  p_status text,
  p_expected_source_hash text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_language text;
  v_hash text;
  v_value text;
  v_unknown text[];
begin
  if auth.uid() is null then
    raise exception using errcode='28000', message='Authentication required';
  end if;
  if p_restaurant_id is null or p_text_key is null or p_lang is null then
    raise exception using errcode='22023', message='Required argument is missing';
  end if;
  if p_text_key not in ('order_help_button_label','order_help_title','order_help_body') then
    raise exception using errcode='22023', message='Invalid order-help translation field';
  end if;
  if p_status not in ('to_review','validated') then
    raise exception using errcode='22023', message='Invalid translation status';
  end if;
  if not public.has_role_in(p_restaurant_id, array['owner','manager'])
     and not public.is_scanym_operator() then
    raise exception using errcode='42501', message='Not authorized';
  end if;
  if not exists (select 1 from public.supported_languages where code=p_lang)
     or not exists (select 1 from public.restaurant_active_languages
                    where restaurant_id=p_restaurant_id and language_code=p_lang) then
    raise exception using errcode='22023', message='Language is not active for this restaurant';
  end if;
  select source_language into v_source_language
  from public.restaurant_configs where restaurant_id=p_restaurant_id;
  if p_lang is not distinct from v_source_language then
    raise exception using errcode='22023', message='Cannot translate into source language';
  end if;
  select body_hash into v_hash
  from public.merchant_communication_text
  where restaurant_id=p_restaurant_id and text_key=p_text_key and body is not null
  for update;
  if not found then
    raise exception using errcode='P0002', message='Order-help source text not configured';
  end if;
  if p_expected_source_hash is not null and p_expected_source_hash is distinct from v_hash then
    raise exception using errcode='40001', message='SCANYM_TRANSLATION_SOURCE_CHANGED';
  end if;
  v_value := nullif(pg_catalog.btrim(coalesce(p_value,'')), '');
  if v_value is not null then
    if pg_catalog.length(v_value) > public.communication_text_max_length(p_text_key) then
      raise exception using errcode='22001', message='Translation is too long';
    end if;
    v_unknown := public.communication_template_unknown_variables(v_value);
    if pg_catalog.cardinality(v_unknown) > 0 then
      raise exception using errcode='22023', message='Unknown template variable in translation';
    end if;
  end if;
  if v_value is null then
    update public.merchant_communication_text
    set translations = coalesce(translations, '{}'::jsonb)
      || jsonb_build_object(p_lang,
        coalesce(translations->p_lang,'{}'::jsonb) - p_text_key
          - (p_text_key || '_status') - (p_text_key || '_source_hash'))
    where restaurant_id=p_restaurant_id and text_key=p_text_key;
  else
    update public.merchant_communication_text
    set translations = coalesce(translations, '{}'::jsonb)
      || jsonb_build_object(p_lang,
        coalesce(translations->p_lang,'{}'::jsonb)
          || jsonb_build_object(p_text_key,v_value,
                                p_text_key || '_status',p_status,
                                p_text_key || '_source_hash',v_hash))
    where restaurant_id=p_restaurant_id and text_key=p_text_key;
  end if;
end $$;

revoke all on function public.write_order_help_translation(uuid,text,text,text,text,text) from public, anon;
grant execute on function public.write_order_help_translation(uuid,text,text,text,text,text) to authenticated;

create function public.get_restaurant_public_order_help_texts(p_restaurant_id uuid)
returns table(text_key text, body text, body_hash text, translations jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select m.text_key, m.body, m.body_hash, m.translations
  from public.merchant_communication_text m
  where m.restaurant_id=p_restaurant_id
    and m.text_key in ('order_help_button_label','order_help_title','order_help_body')
    and m.body is not null
  order by m.text_key
$$;

revoke all on function public.get_restaurant_public_order_help_texts(uuid) from public;
grant execute on function public.get_restaurant_public_order_help_texts(uuid) to anon, authenticated;

do $$
begin
  if not has_function_privilege('anon','public.get_restaurant_public_order_help_texts(uuid)','EXECUTE')
     or has_function_privilege('anon','public.write_order_help_translation(uuid,text,text,text,text,text)','EXECUTE') then
    raise exception 'SCANYM_POSTCHECK: public access boundaries incorrect';
  end if;
end $$;
commit;
