-- =============================================================================
-- SCANYM — GAP-01 — E-MAIL MARCHAND OBLIGATOIRE — ROLLBACK
-- DRAFT ONLY.
-- =============================================================================
-- Remet les DEUX fonctions réécrites par
-- DRAFT-lot-gap-01-mandatory-merchant-email-v1.sql dans leur forme
-- antérieure, reprise À L'IDENTIQUE de leurs fichiers d'origine :
--   * cgv_completeness_errors -> forme ONLINE WITHDRAWAL v1.1
--     (DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql).
--   * claim_withdrawal_acknowledgement_send -> forme GAP-01
--     ack-transport v1 (DRAFT-lot-gap-01-ack-transport-v1.sql),
--     et retire l'attribut `merchant_withdrawal_regime` ajouté au
--     type composite `withdrawal_ack_claim_result`.
--
-- CE ROLLBACK NE TOUCHE À AUCUNE DONNÉE : aucune ligne
-- merchant_legal_profile / merchant_cgv_profile / withdrawal_requests
-- n'est modifiée ou supprimée. Un marchand publié entre-temps sous le
-- nouveau gate conserve sa CGV publiée -- il redevient seulement
-- possible de publier à nouveau sans e-mail marchand pour
-- STANDARD_14_DAYS/MIXED, exactement comme avant ce lot.
-- =============================================================================

begin;

create or replace function public.cgv_completeness_errors(p_restaurant_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_errors        text[] := '{}';
  v_country       text;
  v_legal         public.merchant_legal_profile%rowtype;
  v_cgv           public.merchant_cgv_profile%rowtype;
  v_template      public.cgv_template%rowtype;
  -- ONLINE WITHDRAWAL v1.1 -- gabarit RÉELLEMENT applicable (épinglé
  -- ou par défaut), seul à pouvoir dire si le régime MIXTE dispose
  -- d'une clause contrôlée pour CE marchand.
  v_applicable    public.cgv_template%rowtype;
begin
  select country into v_country from public.restaurants where id = p_restaurant_id;
  if v_country is null then
    v_errors := array_append(v_errors, 'COUNTRY_MISSING');
  end if;

  select * into v_legal from public.merchant_legal_profile where restaurant_id = p_restaurant_id;
  if not found or v_legal.legal_form is null or v_legal.governing_country is null then
    v_errors := array_append(v_errors, 'LEGAL_IDENTITY_MISSING');
  end if;
  if not found or v_legal.address_line1 is null or v_legal.postal_code is null or v_legal.city is null then
    v_errors := array_append(v_errors, 'LEGAL_ADDRESS_MISSING');
  end if;
  if not found or (v_legal.customer_service_email is null and v_legal.customer_service_phone is null) then
    v_errors := array_append(v_errors, 'CUSTOMER_CONTACT_MISSING');
  end if;

  -- Resolve the applicable template for the merchant's declared
  -- country to know whether mediator/preparation clauses are
  -- required (fail closed if no template can be resolved at all).
  if v_country is not null then
    select * into v_template
    from public.cgv_template
    where jurisdiction_country = v_country
      and business_scope = 'food_perishable_b2c'
      and status = 'PUBLISHED'
    order by version desc
    limit 1;
  end if;

  if v_template.id is null then
    v_errors := array_append(v_errors, 'TEMPLATE_UNRESOLVED');
  else
    if v_template.requires_mediator and (
      not found or v_legal.consumer_mediator_name is null
      or v_legal.consumer_mediator_address is null
      or v_legal.consumer_mediator_website is null
    ) then
      v_errors := array_append(v_errors, 'MEDIATOR_INFO_MISSING');
    end if;
  end if;

  select * into v_cgv from public.merchant_cgv_profile where restaurant_id = p_restaurant_id;
  if not found or v_cgv.withdrawal_regime is null then
    v_errors := array_append(v_errors, 'WITHDRAWAL_REGIME_MISSING');
  elsif v_cgv.withdrawal_regime = 'MIXED' then
    -- ONLINE WITHDRAWAL v1.1 -- MIXED n'est plus refusé par principe.
    -- La raison historique du refus (« v1 ne sait pas rendre ce régime
    -- sans classification produit par produit ») a disparu : la
    -- classification EXISTE désormais, par produit
    -- (menu_items.withdrawal_eligible) et figée par ligne de commande
    -- (order_items.withdrawal_eligible_at_order_time).
    --
    -- Ce qui reste exigé, et qui est vérifié RÉELLEMENT ici : le
    -- gabarit applicable à CE marchand doit porter une clause MIXED
    -- contrôlée. Un marchand épinglé à une version qui n'en a pas
    -- (v1 à v5) reste donc bloqué -- avec le même code stable qu'avant,
    -- que l'interface marchande sait déjà traduire -- jusqu'à ce qu'il
    -- soit rattaché à une version qui la porte. Jamais un rendu avec
    -- une clause manquante silencieusement omise.
    begin
      v_applicable := public._resolve_applicable_cgv_template(p_restaurant_id);
    exception when sqlstate '22023' then
      -- Épinglage cassé : le gabarit applicable n'est pas résoluble.
      -- Le publish path le signale bruyamment de son côté ; ici, on
      -- se contente de ne rien pouvoir affirmer sur la clause MIXED.
      v_applicable := null;
    end;

    if v_applicable.id is null
       or coalesce(btrim(v_applicable.controlled_sections->'withdrawal_clauses'->>'MIXED'), '') = ''
    then
      v_errors := array_append(v_errors, 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED');
    end if;
  end if;

  if v_template.id is not null and v_template.requires_preparation_clause and (
    not found or v_cgv.preparation_time_min is null or v_cgv.preparation_time_max is null
    or v_cgv.preparation_time_unit is null
  ) then
    v_errors := array_append(v_errors, 'PREPARATION_POLICY_MISSING');
  end if;

  return v_errors;
end $$;

comment on function public.cgv_completeness_errors(uuid) is
  'ONLINE WITHDRAWAL v1.1 — inchangée sauf pour le régime MIXTE : il n''est plus refusé par principe (la classification produit par produit existe désormais), mais uniquement lorsque le gabarit RÉELLEMENT applicable à ce marchand ne porte aucune clause MIXED contrôlée. Même code d''erreur stable qu''auparavant.';

revoke all on function public.cgv_completeness_errors(uuid) from public;
grant execute on function public.cgv_completeness_errors(uuid) to authenticated;

-- L'attribut ajouté au type composite doit être retiré AVANT de
-- restaurer `claim_withdrawal_acknowledgement_send` ci-dessous : le
-- type de retour déclaré d'une fonction SQL est vérifié contre le
-- nombre RÉEL d'attributs du type composite au moment du CREATE OR
-- REPLACE, jamais seulement contre ce que le corps de la fonction
-- sélectionne. Restaurer d'abord la forme à 10 colonnes alors que le
-- type en porte encore 11 échouerait avec "return type mismatch ...
-- Final statement returns too few columns" -- constaté à l'exécution
-- réelle sur PostgreSQL 16, pas par relecture.
do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_type t on t.typrelid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'withdrawal_ack_claim_result'
      and a.attname = 'merchant_withdrawal_regime'
      and not a.attisdropped
  ) then
    alter type public.withdrawal_ack_claim_result
      drop attribute merchant_withdrawal_regime;
  end if;
end $$;

create or replace function public.claim_withdrawal_acknowledgement_send(
  p_withdrawal_request_id uuid,
  p_stale_after_seconds    integer default 120
)
returns public.withdrawal_ack_claim_result
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.withdrawal_requests
    set acknowledgement_status = 'sending',
        acknowledgement_claimed_at = now(),
        acknowledgement_send_attempts = acknowledgement_send_attempts + 1
    where id = p_withdrawal_request_id
      and (
        acknowledgement_status = 'pending'
        or (
          acknowledgement_status = 'sending'
          and acknowledgement_claimed_at is not null
          and acknowledgement_claimed_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 1))
        )
      )
    returning *
  )
  select
    c.id, c.restaurant_id, c.order_id, c.acknowledgement_address,
    c.customer_first_name, c.customer_last_name, c.declaration_snapshot,
    r.name, mlp.customer_service_email, mlp.customer_service_phone
  from claimed c
  left join public.restaurants r on r.id = c.restaurant_id
  left join public.merchant_legal_profile mlp on mlp.restaurant_id = c.restaurant_id;
$$;

comment on function public.claim_withdrawal_acknowledgement_send(uuid, integer) is
  'GAP-01 — prise en charge atomique de l''envoi d''un accusé de réception : ne renvoie une ligne QUE si elle était ''pending'', ou ''sending'' depuis plus de p_stale_after_seconds (récupération après crash). Aucune ligne renvoyée -> aucun envoi ne doit être tenté (déjà en cours ailleurs, déjà envoyée, déjà en échec définitif, ou canal indisponible). Renvoie aussi l''identité/contact marchand (nom, e-mail et téléphone de service client de merchant_legal_profile), lus ICI sous SECURITY DEFINER -- service_role n''a par ailleurs aucun privilège de table sur restaurants/merchant_legal_profile. service_role uniquement.';

revoke all on function public.claim_withdrawal_acknowledgement_send(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_withdrawal_acknowledgement_send(uuid, integer) to service_role;

do $$
declare
  v_src_completeness text;
begin
  select p.prosrc into v_src_completeness from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cgv_completeness_errors';

  if v_src_completeness like '%GAP-01-MANDATORY-EMAIL-V1%'
     or v_src_completeness like '%CUSTOMER_EMAIL_REQUIRED_FOR_WITHDRAWAL%' then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: cgv_completeness_errors porte encore la forme GAP-01 e-mail obligatoire.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_type t on t.typrelid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'withdrawal_ack_claim_result'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: le type withdrawal_ack_claim_result a disparu.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_type t on t.typrelid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'withdrawal_ack_claim_result'
      and a.attname = 'merchant_withdrawal_regime'
      and not a.attisdropped
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: merchant_withdrawal_regime toujours présent sur le type composite.';
  end if;
end $$;

commit;
