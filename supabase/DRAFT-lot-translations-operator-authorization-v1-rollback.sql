-- ============================================================
-- Scanym — LOT 02 — TRANSLATIONS OPERATOR AUTHORIZATION v1 — ROLLBACK
-- DEVELOPMENT ONLY. Restaure le corps EXACT de
-- get_restaurant_translation_settings(uuid) tel que publié par
-- migration-v81-lot1b-translations.sql (section 2e) : membership
-- restaurant_users uniquement, sans bypass opérateur. CREATE OR
-- REPLACE : signature, forme de retour et GRANT préservés.
-- ============================================================

begin;

create or replace function public.get_restaurant_translation_settings(p_restaurant_id uuid)
returns table (
  source_language        text,
  intro_text             text,
  intro_text_hash        text,
  announcement_text      text,
  announcement_text_hash text,
  translations           jsonb
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

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  select rc.source_language, rc.intro_text, rc.intro_text_hash,
         rc.announcement_text, rc.announcement_text_hash, rc.translations
  from public.restaurant_configs rc
  where rc.restaurant_id = p_restaurant_id;
end $$;

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_restaurant_translation_settings'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: get_restaurant_translation_settings référence encore is_scanym_operator.';
  end if;
  if has_function_privilege('anon', 'public.get_restaurant_translation_settings(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_restaurant_translation_settings(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: GRANT de get_restaurant_translation_settings modifiés.';
  end if;
end $$;

commit;
