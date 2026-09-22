-- SCANYM — DELIVERY DELAY CUSTOMER NOTICE v1
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO PROD.
--
-- Reuses restaurant_sale_modes.customer_text. No table, column,
-- provider model, tenant data or delivery-routing semantic is changed.

begin;

do $$
begin
  if to_regclass('public.restaurant_sale_modes') is null
     or to_regclass('public.sale_mode_catalog') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: sale-mode tables missing -- delivery notice migration cancelled.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'restaurant_sale_modes'
      and column_name = 'customer_text'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_modes.customer_text missing -- delivery notice migration cancelled.';
  end if;
  if to_regprocedure('public.is_member_of(uuid)') is null
     or to_regprocedure('public.has_role_in(uuid,text[])') is null
     or to_regprocedure('public.is_scanym_operator()') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: authorization helpers missing -- delivery notice migration cancelled.';
  end if;
end $$;

create or replace function public.get_merchant_delivery_method_notices(
  p_restaurant_id uuid
)
returns table (
  mode_code text,
  mode_label text,
  customer_text text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not public.is_member_of(p_restaurant_id)
     and not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  return query
  select rsm.mode_code, smc.label, rsm.customer_text
  from public.restaurant_sale_modes rsm
  join public.sale_mode_catalog smc on smc.code = rsm.mode_code
  where rsm.restaurant_id = p_restaurant_id
    and rsm.enabled
    and rsm.mode_code in ('pickup', 'delivery')
  order by rsm.display_order, rsm.mode_code;
end;
$$;

comment on function public.get_merchant_delivery_method_notices(uuid) is
  'Tenant-safe merchant projection of enabled pickup/delivery customer_text only. No provider, config, routing code or disabled mode is exposed.';

revoke all on function public.get_merchant_delivery_method_notices(uuid)
  from public, anon;
grant execute on function public.get_merchant_delivery_method_notices(uuid)
  to authenticated;

create or replace function public.update_merchant_delivery_method_notice(
  p_restaurant_id uuid,
  p_mode_code text,
  p_customer_text text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean_text text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not public.has_role_in(p_restaurant_id, array['owner', 'manager'])
     and not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  if p_mode_code is null or p_mode_code not in ('pickup', 'delivery') then
    raise exception using errcode = '22023', message = 'Unsupported delivery method';
  end if;

  v_clean_text := nullif(trim(coalesce(p_customer_text, '')), '');
  if v_clean_text is not null and length(v_clean_text) > 500 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 500 characters';
  end if;

  update public.restaurant_sale_modes
  set customer_text = v_clean_text
  where restaurant_id = p_restaurant_id
    and mode_code = p_mode_code
    and enabled;

  if not found then
    raise exception using errcode = 'P0002', message = 'Enabled delivery method not found';
  end if;
end;
$$;

comment on function public.update_merchant_delivery_method_notice(uuid, text, text) is
  'Updates only customer_text on an enabled pickup/delivery mode for an authorized tenant owner/manager or Scanym operator.';

revoke all on function public.update_merchant_delivery_method_notice(uuid, text, text)
  from public, anon;
grant execute on function public.update_merchant_delivery_method_notice(uuid, text, text)
  to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.get_merchant_delivery_method_notices(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.update_merchant_delivery_method_notice(uuid,text,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon can execute merchant delivery-notice functions.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_merchant_delivery_method_notices(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.update_merchant_delivery_method_notice(uuid,text,text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated grants missing on merchant delivery-notice functions.';
  end if;
end $$;

commit;
