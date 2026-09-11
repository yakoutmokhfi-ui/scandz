-- ============================================================
-- Scanym — ROLLBACK — DELIVERY PRICING OPERATOR AUTHORIZATION v1.1
-- DEVELOPMENT ONLY.
--
-- Restaure les DEUX fonctions modifiées par
-- DRAFT-lot-delivery-pricing-operator-authorization-v1.sql à leur
-- état EXACT tel que publié par DRAFT-lot-merchant-delivery-
-- pricing.sql (baseline 820bfee430, avant ce lot) -- corps
-- byte-identiques (vérifiés par pg_get_functiondef après rollback,
-- voir ROLLBACK-EVIDENCE.md), signatures et formes de retour
-- inchangées, GRANT inchangés.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. get_merchant_delivery_fulfillment_pricing -- retrait du bypass
--    opérateur, retour à la condition is_member_of seule.
-- ------------------------------------------------------------
create or replace function public.get_merchant_delivery_fulfillment_pricing(
  p_restaurant_id uuid
)
returns table (
  rule_id           uuid,
  fulfillment_label text,
  pricing_mode      text,
  fixed_fee         numeric,
  free_threshold    numeric,
  customer_text     text
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

  if not public.is_member_of(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  return query
  select
    f.id as rule_id,
    (
      (case when f.is_fallback then 'Livraison (option de repli)' else 'Livraison' end)
      || case
           when f.zone_prefixes is not null and array_length(f.zone_prefixes, 1) > 0
             then ' — zones ' || array_to_string(f.zone_prefixes, ', ')
           else ''
         end
    ) as fulfillment_label,
    f.pricing_mode,
    f.fixed_fee,
    f.free_threshold,
    f.customer_text
  from public.restaurant_sale_mode_fulfillments f
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
  order by f.display_order;
end;
$$;

comment on function public.get_merchant_delivery_fulfillment_pricing(uuid) is null;

revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public, anon;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. update_merchant_delivery_fulfillment_pricing -- retrait du
--    bypass opérateur, retour à la condition has_role_in seule.
-- ------------------------------------------------------------
create or replace function public.update_merchant_delivery_fulfillment_pricing(
  p_rule_id        uuid,
  p_pricing_mode   text,
  p_fixed_fee      numeric,
  p_free_threshold numeric,
  p_customer_text  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_mode_code     text;
  v_clean_text    text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  -- Résolution tenant AVANT toute vérification de rôle : une règle
  -- inexistante ou appartenant à un autre tenant échoue au même
  -- endroit (42501 via has_role_in ci-dessous, JAMAIS d'indice sur
  -- l'existence d'une règle chez un tenant tiers -- mutation
  -- cross-tenant rejetée, aucune ligne modifiée).
  select f.restaurant_id, f.mode_code into v_restaurant_id, v_mode_code
  from public.restaurant_sale_mode_fulfillments f
  where f.id = p_rule_id;

  if v_restaurant_id is null or v_mode_code is distinct from 'delivery' then
    raise exception using errcode = 'P0002', message = 'Delivery fulfillment rule not found';
  end if;

  if not public.has_role_in(v_restaurant_id, array['owner', 'manager']) then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- ------------------------------------------------------------
  -- Validation fail-closed, indépendante par mode (aucune valeur
  -- CIO/Production réelle ici -- ce sont des règles de validation
  -- génériques, pas des données tenant).
  -- ------------------------------------------------------------
  if p_pricing_mode is null or p_pricing_mode not in ('fixed', 'free_above_threshold') then
    raise exception using errcode = '22023', message = 'Invalid pricing_mode';
  end if;

  -- CORRECTION DDP-V1-01 : rejet explicite de NaN/Infinity/-Infinity,
  -- AVANT toute autre validation et AVANT toute mutation -- n'utilise
  -- PAS `< 0` / `>= 0` (contournables par NaN/+Infinity en
  -- PostgreSQL, voir scanym_numeric_is_non_finite ci-dessus) ni la
  -- validation côté client (insuffisante -- Number.isNaN() côté
  -- navigateur n'empêche pas un appel RPC direct avec
  -- 'NaN'::numeric).
  if p_fixed_fee is not null and public.scanym_numeric_is_non_finite(p_fixed_fee) then
    raise exception using errcode = '22023', message = 'fixed_fee must be a finite numeric value (NaN/Infinity not allowed)';
  end if;

  if p_fixed_fee is null or p_fixed_fee < 0 then
    raise exception using errcode = '22023', message = 'fixed_fee is required and must be >= 0';
  end if;

  if p_pricing_mode = 'fixed' then
    if p_free_threshold is not null then
      raise exception using errcode = '22023', message = 'free_threshold must be NULL when pricing_mode = fixed';
    end if;
  elsif p_pricing_mode = 'free_above_threshold' then
    -- CORRECTION DDP-V1-01 : même rejet explicite pour free_threshold.
    if p_free_threshold is not null and public.scanym_numeric_is_non_finite(p_free_threshold) then
      raise exception using errcode = '22023', message = 'free_threshold must be a finite numeric value (NaN/Infinity not allowed)';
    end if;
    if p_free_threshold is null or p_free_threshold < 0 then
      raise exception using errcode = '22023', message = 'free_threshold is required and must be >= 0 when pricing_mode = free_above_threshold';
    end if;
  end if;

  v_clean_text := nullif(trim(coalesce(p_customer_text, '')), '');
  if v_clean_text is not null and length(v_clean_text) > 500 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 500 characters';
  end if;

  update public.restaurant_sale_mode_fulfillments
  set pricing_mode   = p_pricing_mode,
      fixed_fee      = p_fixed_fee,
      free_threshold = p_free_threshold,
      customer_text  = v_clean_text
  where id = p_rule_id
    and mode_code = 'delivery';

  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery fulfillment rule not found';
  end if;
end;
$$;

comment on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) is null;

revoke all on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) to authenticated;

commit;
