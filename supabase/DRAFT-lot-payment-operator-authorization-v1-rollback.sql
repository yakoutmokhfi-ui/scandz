-- ============================================================
-- Scanym — OPERATOR DASHBOARD — PAYMENT OPERATOR AUTHORIZATION v1
-- ROLLBACK / REVERSAL
-- DEVELOPMENT ONLY -- fichier de réversion, jamais exécuté
-- directement sur Production par ce lot.
--
-- OBJET : restaurer public.get_merchant_payment_provider_config(uuid)
-- EXACTEMENT dans l'état publié par PAYMENT P2B-A
-- (DRAFT-lot-payment-p2b-a-safe-merchant-read.sql), c'est-à-dire
-- annuler UNIQUEMENT l'ajout du bypass is_scanym_operator() -- même
-- signature, même forme de retour, mêmes GRANT, corps byte-pour-byte
-- identique à P2B-A avant PAYMENT OPERATOR AUTHORIZATION v1.
--
-- Ce fichier ne touche AUCUNE autre fonction, AUCUNE table, AUCUN
-- GRANT en dehors de get_merchant_payment_provider_config(uuid).
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
  ) then
    raise exception 'SCANYM_ROLLBACK_DRIFT: get_merchant_payment_provider_config(uuid) introuvable -- rollback annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_ROLLBACK_DRIFT: get_merchant_payment_provider_config ne référence pas is_scanym_operator -- PAYMENT OPERATOR AUTHORIZATION v1 ne semble pas appliqué, rollback annulé (rien à annuler).';
  end if;
end $$;

begin;

-- Restauration EXACTE du corps PAYMENT P2B-A (is_member_of
-- uniquement, aucun bypass opérateur) -- byte-pour-byte identique à
-- DRAFT-lot-payment-p2b-a-safe-merchant-read.sql.
create or replace function public.get_merchant_payment_provider_config(
  p_restaurant_id uuid
)
returns table (
  provider_code        text,
  mode                 text,
  configuration_status text,
  is_enabled           boolean,
  last_verified_at     timestamptz,
  updated_at           timestamptz
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

  if p_restaurant_id is null then
    raise exception using errcode = '22004', message = 'p_restaurant_id requis';
  end if;

  if not public.is_member_of(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- Restaurant inexistant : is_member_of renvoie déjà FALSE (aucune
  -- ligne restaurant_users ne peut référencer un restaurant qui
  -- n'existe pas), donc déjà rejeté ci-dessus avec 42501 -- pas de
  -- distinction "restaurant absent" vs "non membre" exposée à
  -- l'appelant (évite de confirmer/infirmer l'existence d'un
  -- restaurant à un utilisateur qui n'y est pas rattaché).

  -- Liste de colonnes EXPLICITE et FIGÉE -- jamais `select *`.
  -- AUCUNE référence à id, restaurant_id, credentials_ref,
  -- vault.secrets ou vault.decrypted_secrets.
  return query
  select
    c.provider_code,
    c.mode,
    c.configuration_status,
    c.is_enabled,
    c.last_verified_at,
    c.updated_at
  from public.payment_provider_configs c
  where c.restaurant_id = p_restaurant_id
  order by c.provider_code;
end;
$$;

comment on function public.get_merchant_payment_provider_config(uuid) is
  'Lecture marchande SÛRE et SEULE (PAYMENT P2B-A) des métadonnées de configuration prestataire -- provider_code/mode/configuration_status/is_enabled/last_verified_at/updated_at UNIQUEMENT. Ne retourne JAMAIS id, restaurant_id, credentials_ref, ni aucun matériel Vault -- aucune référence à vault.secrets/vault.decrypted_secrets dans cette fonction. Autorisation via is_member_of (aucun nouveau primitif). Retourne TOUTES les configurations du restaurant (0, 1 ou plusieurs -- unique(restaurant_id, provider_code) permet plusieurs prestataires par restaurant), jamais un LIMIT 1 arbitraire. SECURITY DEFINER, search_path vide, aucun SQL dynamique.';

revoke all on function public.get_merchant_payment_provider_config(uuid) from public, anon;
grant execute on function public.get_merchant_payment_provider_config(uuid) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_ROLLBACK_POST_CHECK_FAILED: is_scanym_operator toujours référencé après rollback.';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
      and pg_get_functiondef(p.oid) ilike '%is_member_of(p_restaurant_id)%'
  ) then
    raise exception 'SCANYM_ROLLBACK_POST_CHECK_FAILED: is_member_of(p_restaurant_id) absent après rollback.';
  end if;
end $$;

commit;
