CREATE OR REPLACE FUNCTION public.create_order(p_slug text, p_service_mode text, p_items jsonb, p_table_number integer DEFAULT NULL::integer, p_customer jsonb DEFAULT '{}'::jsonb, p_note text DEFAULT NULL::text, p_language text DEFAULT NULL::text, p_cgv_accepted boolean DEFAULT false)
 RETURNS TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
  v_mode_enabled boolean;
  v_req         record;
  v_field_value text;
  v_room_number text;
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
  v_expected_delivery_fee numeric;
  v_street      text;
  v_city        text;
  v_cgv_status         text;
  v_cgv_version_id     uuid;
  v_cgv_content_hash   text;
  v_withdrawal_regime_snapshot text;
  v_template_sections_snapshot jsonb;
  v_withdrawal_legal_basis     text;
  -- CFTE v1 (changement 1) -- prénom/nom saisis séparément puis
  -- RECOMPOSÉS ; aucune de ces deux valeurs n'est persistée telle
  -- quelle, aucune colonne n'existe pour elles.
  v_first_name  text;
  v_last_name   text;
  v_tracked     boolean := false;
  -- DELIVERY COUNTRY SCOPE v1 -- pays de livraison RÉSOLU et AUTORISÉ.
  v_country          text;
  v_country_count    integer := 0;
  v_country_cap      public.scanym_country_delivery_capability%rowtype;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select status into v_cgv_status
  from public.merchant_cgv_profile where restaurant_id = v_restaurant.id;

  if v_cgv_status = 'CGV_ACTIVE' then
    select v.id, v.content_hash into v_cgv_version_id, v_cgv_content_hash
    from public.merchant_cgv_version v
    where v.restaurant_id = v_restaurant.id and v.status = 'ACTIVE'
    order by v.published_at desc
    limit 1;

    if v_cgv_version_id is null then
      raise exception using errcode = 'P0001', message = 'CGV_REQUIRED_BUT_NOT_PUBLISHED';
    end if;

    if not coalesce(p_cgv_accepted, false) then
      raise exception using errcode = 'P0001', message = 'CGV_ACCEPTANCE_REQUIRED';
    end if;

    select mcp.withdrawal_regime, ct.controlled_sections
      into v_withdrawal_regime_snapshot, v_template_sections_snapshot
    from public.merchant_cgv_version mcv
    join public.cgv_template ct on ct.id = mcv.template_id
    join public.merchant_cgv_profile mcp on mcp.restaurant_id = mcv.restaurant_id
    where mcv.id = v_cgv_version_id;

    if v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE' then
      if (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 4°%' then
        v_withdrawal_legal_basis := 'L221-28-4';
      elsif (v_template_sections_snapshot->'withdrawal_clauses'->>'EXEMPT_PERISHABLE') ilike '%L221-28 3°%' then
        v_withdrawal_legal_basis := 'L221-28-3';
      else
        v_withdrawal_legal_basis := 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION';
      end if;
    elsif v_withdrawal_regime_snapshot = 'STANDARD_14_DAYS' then
      v_withdrawal_legal_basis := 'STANDARD_14_DAYS_ELIGIBLE';
    else
      v_withdrawal_legal_basis := null;
    end if;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  select enabled into v_mode_enabled
  from public.restaurant_sale_modes
  where restaurant_id = v_restaurant.id and mode_code = p_service_mode;

  if v_mode_enabled is null or not v_mode_enabled then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');
  v_room_number := nullif(left(trim(coalesce(p_customer->>'room_number','')), 20), '');
  v_street := nullif(left(trim(coalesce(p_customer->>'street','')), 200), '');
  v_city   := nullif(left(trim(coalesce(p_customer->>'city','')), 120), '');

  -- CFTE v1 (changement 2) -- prénom/nom séparés, puis NOM D'AFFICHAGE
  -- NORMALISÉ recomposé côté SERVEUR. Dès qu'au moins l'un des deux est
  -- fourni, la valeur composée REMPLACE `name` reçu du navigateur : le
  -- client ne peut pas faire diverger le nom affiché de ce qu'il a
  -- réellement saisi. Aucun des deux champs n'est persisté séparément.
  v_first_name := nullif(left(trim(coalesce(p_customer->>'first_name','')), 60), '');
  v_last_name  := nullif(left(trim(coalesce(p_customer->>'last_name','')), 60), '');

  if v_first_name is not null or v_last_name is not null then
    v_name := nullif(left(btrim(concat_ws(' ', v_first_name, v_last_name)), 120), '');
  end if;

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  -- CFTE v1 (changement 3) -- PRÉCÉDENCE NON RELAXABLE des modes suivis,
  -- appliquée ICI en plus du résolveur : aucune surcharge tenant, et
  -- aucune redéfinition future du résolveur, ne peut rendre l'e-mail
  -- optionnel pour un mode suivi. N'écrit rien, ne lit aucune
  -- configuration tenant : garde purement structurelle.
  v_tracked := p_service_mode = any (public.customer_tracked_service_modes());

  if v_tracked then
    if v_email is null then
      raise exception using errcode = 'P0001', message = 'SCANYM_CUSTOMER_EMAIL_REQUIRED';
    end if;
    if v_first_name is null then
      raise exception using errcode = 'P0001', message = 'SCANYM_CUSTOMER_FIRST_NAME_REQUIRED';
    end if;
  end if;

  if p_service_mode = 'delivery' and v_last_name is null then
    raise exception using errcode = 'P0001', message = 'SCANYM_CUSTOMER_LAST_NAME_REQUIRED';
  end if;

  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  insert into tmp_field_reqs (field, requirement, one_of_group, resolved_value)
  select x.field, x.requirement, x.one_of_group,
    case x.field
      when 'customer_name' then v_name
      when 'phone' then v_phone
      when 'email' then v_email
      when 'delivery_address' then v_address
      when 'table_number' then p_table_number::text
      when 'room_number' then v_room_number
      -- CFTE v1 (changement 4).
      when 'first_name' then v_first_name
      when 'last_name' then v_last_name
      else null
    end
  from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;

  for v_req in select field, resolved_value from tmp_field_reqs where requirement = 'required' loop
    if v_req.resolved_value is null then
      raise exception 'Champ requis manquant pour ce mode: %', v_req.field;
    end if;
  end loop;

  for v_req in
    select one_of_group, bool_or(resolved_value is not null) as satisfied
    from tmp_field_reqs
    where requirement = 'one_of' and one_of_group is not null
    group by one_of_group
  loop
    if not v_req.satisfied then
      raise exception 'Au moins un champ du groupe % est requis', v_req.one_of_group;
    end if;
  end loop;

  if p_service_mode = 'delivery' then
    -- ================================================================
    -- DELIVERY COUNTRY SCOPE v1 -- L2 : PAYS DE LIVRAISON DU MARCHAND.
    --
    -- Trois décisions DISTINCTES, dans cet ordre, avec trois erreurs
    -- distinctes (decision CIO v1.2) :
    --   1. le pays est-il autorise POUR CE MARCHAND ?   -> COUNTRY_NOT_ALLOWED
    --   2. le code postal a-t-il le format DE CE PAYS ? -> POSTAL_CODE_INVALID
    --   3. le code postal est-il commercialement servi ? -> OUT_OF_DELIVERY_ZONE
    --
    -- L'ecran ne propose jamais un pays non autorise ; cela ne prouve
    -- rien : une charge utile est un objet JSON que n'importe qui peut
    -- fabriquer. L'autorite est ici, par etablissement, jamais globale.
    -- ================================================================
    v_country := nullif(upper(btrim(coalesce(p_customer->>'country', ''), E' \t\n\r\f' || chr(11))), '');

    select count(*) into v_country_count
    from public.restaurant_delivery_countries dc
    where dc.restaurant_id = v_restaurant.id;

    -- Aucun pays configure = livraison indisponible. Le silence ne vaut
    -- jamais permission (meme discipline fail-closed que
    -- fieldRequirementsReady cote client).
    if v_country_count = 0 then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: aucun pays de livraison configure pour cet etablissement';
    end if;

    if v_country is null then
      -- Compatibilite ascendante : les clients deployes n'envoient
      -- AUCUN pays. Un seul pays autorise => il est resolu sans
      -- ambiguite. Plusieurs => on refuse, on ne devine pas.
      if v_country_count = 1 then
        select dc.country_code into v_country
        from public.restaurant_delivery_countries dc
        where dc.restaurant_id = v_restaurant.id;
      else
        raise exception using errcode = '22004',
          message = 'SCANYM_DELIVERY_COUNTRY_REQUIRED: pays de livraison requis (plusieurs pays autorises)';
      end if;
    end if;

    if not exists (
      select 1 from public.restaurant_delivery_countries dc
      where dc.restaurant_id = v_restaurant.id and dc.country_code = v_country
    ) then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: ' || v_country;
    end if;

    -- L1 : le pays doit AUSSI etre livrable au niveau plateforme. Un
    -- pays connu de Scanym (onboarding d'etablissement) n'est pas pour
    -- autant livrable -- TN et MA en sont l'exemple.
    select * into v_country_cap
    from public.scanym_country_delivery_capability c
    where c.country_code = v_country;

    if not found or not v_country_cap.delivery_capable then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: ' || v_country || ' non livrable au niveau plateforme';
    end if;

    select exists (
      select 1
      from public.restaurant_sale_mode_fulfillments f
      join public.restaurant_sale_modes rsm
        on rsm.restaurant_id = f.restaurant_id and rsm.mode_code = f.mode_code
      where f.restaurant_id = v_restaurant.id
        and f.mode_code = p_service_mode
        and f.enabled = true
        and rsm.enabled = true
    ) into v_new_engine;

    -- DELIVERY COUNTRY SCOPE v1.1 -- DCS-LEGACY-BE-01.
    -- Le chemin historique ci-dessous (aucune regle de fulfillment
    -- ACTIVE) extrait un code postal FRANCAIS a cinq chiffres du texte
    -- libre de l'adresse et le compare a delivery_zone_prefixes. Il est
    -- par construction propre a la France : il est donc RESERVE au pays
    -- FR. Tout autre pays resolu sans regle active est refuse ici,
    -- AVANT toute extraction postale et avant toute ecriture (fail
    -- closed). Le comportement FR est strictement inchange.
    if not v_new_engine and v_country is distinct from 'FR' then
      raise exception using errcode = '42501',
        message = 'SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED: ' || coalesce(v_country, '?')
          || ' sans regle de livraison active (chemin postal historique reserve a FR)';
    end if;

    if v_new_engine then
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      v_postal := substring(v_address from '\m(\d{5})\M');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;

      select p into v_zone
      from public.restaurant_sale_modes rsm,
           jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p
      where rsm.restaurant_id = v_restaurant.id and rsm.mode_code = 'delivery'
        and v_postal like p || '%'
      limit 1;

      if v_zone is null then
        raise exception using errcode = 'P0002',
          message = 'SCANYM_OUT_OF_DELIVERY_ZONE: Zone non desservie: ' || v_postal;
      end if;
    end if;

    -- DELIVERY COUNTRY SCOPE v1 -- decision 2/3 : FORMAT du code postal,
    -- selon le pays resolu. Distincte de la decision 3 : un code postal
    -- peut etre parfaitement VALIDE en France et n'etre pas SERVI par ce
    -- marchand (97200 Fort-de-France, par exemple).
    if v_country_cap.postal_code_pattern is not null
       and v_postal is not null
       and v_postal !~ v_country_cap.postal_code_pattern then
      raise exception using errcode = '22023',
        message = 'SCANYM_POSTAL_CODE_INVALID: ' || v_postal || ' (pays ' || v_country || ')';
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number, room_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    case when p_service_mode = 'room_service' then v_room_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  if p_service_mode = 'delivery' and v_address is not null then
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city, country)
    values (v_order_id, v_address, v_postal, v_street, v_city, coalesce(v_country, 'FR'));
  end if;

  if v_cgv_version_id is not null then
    insert into public.order_cgv_acceptance (
      order_id, restaurant_id, cgv_version_id, content_hash,
      accepted_at, acceptance_channel, locale, terms_url
    ) values (
      v_order_id, v_restaurant.id, v_cgv_version_id, v_cgv_content_hash,
      now(), 'web_checkout',
      nullif(left(trim(coalesce(p_language,'')), 10), ''),
      '/legal/' || v_restaurant.slug
    );
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    -- PRODUCT SERVICE MODES v1 -- vérification PAR LIGNE, même patron
    -- que le check établissement (v_mode_enabled) plus haut. Sémantique
    -- ALL-par-absence : une ligne sans restriction (aucune ligne dans
    -- menu_item_sale_modes) n'est jamais bloquée ici. Indépendant de
    -- withdrawal_eligible -- aucune référence croisée.
    if exists (
      select 1 from public.menu_item_sale_modes mism
      where mism.menu_item_id = v_menu_item.id
    ) and not exists (
      select 1 from public.menu_item_sale_modes mism
      where mism.menu_item_id = v_menu_item.id and mism.mode_code = p_service_mode
    ) then
      raise exception using errcode = 'P0002',
        message = 'SCANYM_PRODUCT_NOT_AVAILABLE_FOR_SERVICE_MODE: ' || v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total,
      tax_rate_snapshot, unit_weight_grams_snapshot, weight_is_approximate_snapshot,
      withdrawal_exempt_at_order_time, withdrawal_legal_basis_at_order_time,
      merchant_withdrawal_regime_at_order_time, service_mode_eligible_at_order_time
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty,
      v_menu_item.tax_rate, v_menu_item.unit_weight_grams, v_menu_item.weight_is_approximate,
      case when v_withdrawal_regime_snapshot is null then null
           else (v_withdrawal_regime_snapshot = 'EXEMPT_PERISHABLE') end,
      v_withdrawal_legal_basis,
      v_withdrawal_regime_snapshot, true
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    declare
      v_delivery_min_items integer;
    begin
      select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
      from public.restaurant_sale_modes
      where restaurant_id = v_restaurant.id and mode_code = 'delivery';

      if v_qty_total < coalesce(v_delivery_min_items, 0) then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_delivery_min_items, v_qty_total;
      end if;
    end;
  elsif p_service_mode = 'delivery' and v_new_engine then
    select * into v_resolved
    from public.resolve_delivery_fulfillment(v_restaurant.id, p_service_mode, v_postal, v_qty_total, v_subtotal);

    if not v_resolved.eligible then
      if v_resolved.block = 'no-postal' then
        raise exception 'Code postal absent de l''adresse';
      elsif v_resolved.block = 'below-min' then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_resolved.min_items, v_qty_total;
      else
        raise exception using errcode = 'P0002',
          message = 'SCANYM_OUT_OF_DELIVERY_ZONE: Zone non desservie: ' || v_postal;
      end if;
    end if;

    v_zone := v_resolved.matched_prefix;
    v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);
    v_fulfillment_rule_id := v_resolved.fulfillment_rule_id;
    v_fulfillment_code := v_resolved.fulfillment_code;
    v_provider_code := v_resolved.provider;
  end if;

  update public.orders
  set subtotal = v_subtotal,
      delivery_fee = v_delivery_fee,
      total = v_subtotal + v_delivery_fee,
      fulfillment_rule_id = v_fulfillment_rule_id,
      fulfillment_code = v_fulfillment_code,
      provider_code = v_provider_code
  where id = v_order_id;

  -- B1 — INSTANTANÉ IMMUABLE DE LA DÉCISION DE LIVRAISON.
  -- Alimenté EXCLUSIVEMENT par v_resolved, lu une seule fois plus haut :
  -- aucune relecture de la configuration, donc aucune course possible
  -- avec une édition tarifaire marchande concurrente (D-B1-6, Option 2).
  -- v_fulfillment_rule_id non nul <=> une règle a été retenue par le
  -- nouveau moteur ; nul pour tout autre mode et pour le chemin legacy.
  if v_fulfillment_rule_id is not null then

    -- B1-A-01 — cohérence frais <-> tarif instantané, FAIL-CLOSED.
    -- Seul instant où les deux valeurs sont en main (le frais n'est pas
    -- dupliqué dans l'instantané, §5.2). Même discipline fail-closed que
    -- compute_delivery_fee_tax_allocation v1.2.
    -- B5: independently transcribe the resolver formula. Keep unknown modes
    -- NULL so that even a resolver returning zero fails closed (B1-T16).
    v_expected_delivery_fee := case
      when v_resolved.pricing_mode = 'free' then 0
      when v_resolved.pricing_mode = 'fixed' then v_resolved.fixed_fee
      when v_resolved.pricing_mode = 'free_above_threshold' then
        case when coalesce(v_subtotal, 0) >= v_resolved.free_threshold
             then 0 else v_resolved.fixed_fee end
      else null
    end;
    if v_resolved.discount_enabled then
      if coalesce(v_subtotal, 0) >= v_resolved.discount_threshold then
        v_expected_delivery_fee := round(
          v_expected_delivery_fee * (1 - v_resolved.discount_percentage / 100), 2);
      end if;
    end if;
    if v_resolved.discount_enabled is null
       or v_resolved.delivery_fee is distinct from v_expected_delivery_fee
       or v_delivery_fee is distinct from v_expected_delivery_fee then
      raise exception
        'SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT: resolved fee (%) differs from B1-A-01 (%) -- order refused',
        v_delivery_fee, v_expected_delivery_fee using errcode = '22023';
    end if;

    insert into public.order_delivery_fulfillment_snapshot (
      order_id, fulfillment_rule_id, is_fallback, matched_prefix,
      pricing_mode, fixed_fee, free_threshold, customer_text,
      discount_threshold, discount_percentage, snapshot_method_version
    ) values (
      v_order_id,
      v_fulfillment_rule_id,
      v_resolved.is_fallback,
      v_resolved.matched_prefix,
      v_resolved.pricing_mode,
      v_resolved.fixed_fee,
      v_resolved.free_threshold,
      v_resolved.customer_text,
      case when v_resolved.discount_enabled then v_resolved.discount_threshold end,
      case when v_resolved.discount_enabled then v_resolved.discount_percentage end,
      case when v_resolved.discount_enabled then 'v2' else 'v1' end
    );
  end if;

  -- CSDJ-3 BEGIN -- order schedule persistence (canonical contract v3.1, sections 5-9).
  --
  -- ONE contiguous block, inserted immediately before the final `return query`.
  -- It runs in create_order's own transaction: any RAISE below aborts the order
  -- row, the order-number increment, the items, the delivery snapshot, the
  -- capacity reservation and the schedule snapshot together.
  --
  --   T1  structure check of p_customer->'schedule'          (this block)
  --   T2  validate_fulfillment_selection(...)  ALWAYS called   (engine decides)
  --   T3  interpret: unavailable -> typed error; not_required -> nothing;
  --       valid -> echo equality (strict HH:MM strings)       (this block)
  --   T4  reserve_fulfillment_capacity(...) iff capacity_applies (engine decides)
  --   T5  immutable snapshot from the VALIDATE ROW             (this block)
  --
  -- No eligibility rule, no counting, no bucket key, no hold predicate and no
  -- lock live here: the engine owns all of them. Nothing the browser sent is
  -- ever stored; echoed times are only COMPARED. No notification object is read
  -- or written (notifications are intent-based, see contract section 9.4).
  declare
    v_sc_raw   jsonb := p_customer -> 'schedule';
    v_sc_sent  boolean := false;
    v_sc_ok    boolean;
    v_sc_y     integer;
    v_sc_m     integer;
    v_sc_d     integer;
    v_sc_dim   integer;
    v_sc_k     text;
    v_sc_t     text;
    v_sc_v     text;
    v_sc_date  date;
    v_sc_slot  text;
    v_sc_start text;
    v_sc_end   text;
    v_sc_time  text;
    v_sc_val   record;
    v_sc_rsv   record;
    v_sc_why   text;
    v_sc_code  text;
  begin
    -- T1 -- structure only (contract 5.2). The SHAPE of a slot key or of a time
    -- is NOT judged here: the engine owns it (selection_invalid).
    if v_sc_raw is not null and pg_catalog.jsonb_typeof(v_sc_raw) <> 'null' then
      v_sc_sent := true;
      v_sc_ok := pg_catalog.jsonb_typeof(v_sc_raw) = 'object';
      if v_sc_ok then
        v_sc_ok := not exists (
          select 1 from pg_catalog.jsonb_object_keys(v_sc_raw) as k(key)
          where k.key not in ('date', 'slot_key', 'starts_at', 'ends_at'));
      end if;
      if v_sc_ok then
        v_sc_ok := coalesce(pg_catalog.jsonb_typeof(v_sc_raw -> 'date') = 'string'
                            and (v_sc_raw ->> 'date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false);
      end if;
      if v_sc_ok then
        -- a REAL calendar date (proleptic Gregorian); years 0000-0099 are refused,
        -- exactly like the TypeScript reference (Date.UTC maps them to 19xx).
        v_sc_y := pg_catalog.substr(v_sc_raw ->> 'date', 1, 4)::integer;
        v_sc_m := pg_catalog.substr(v_sc_raw ->> 'date', 6, 2)::integer;
        v_sc_d := pg_catalog.substr(v_sc_raw ->> 'date', 9, 2)::integer;
        v_sc_dim := case
          when v_sc_m in (1, 3, 5, 7, 8, 10, 12) then 31
          when v_sc_m in (4, 6, 9, 11) then 30
          when (v_sc_y % 4 = 0 and v_sc_y % 100 <> 0) or v_sc_y % 400 = 0 then 29
          else 28 end;
        v_sc_ok := v_sc_y between 100 and 9999
                   and v_sc_m between 1 and 12
                   and v_sc_d between 1 and v_sc_dim;
      end if;
      if v_sc_ok then
        v_sc_date := (v_sc_raw ->> 'date')::date;
        foreach v_sc_k in array array['slot_key', 'starts_at', 'ends_at'] loop
          v_sc_t := pg_catalog.jsonb_typeof(v_sc_raw -> v_sc_k);
          v_sc_v := null;
          if v_sc_t is null or v_sc_t = 'null' then
            null;                                     -- absent or JSON null: nothing sent
          elsif v_sc_t = 'string' and (v_sc_raw ->> v_sc_k) <> '' then
            v_sc_v := v_sc_raw ->> v_sc_k;            -- verbatim: no trim, no parse, no reformat
          else
            v_sc_ok := false;
          end if;
          if v_sc_k = 'slot_key' then v_sc_slot := v_sc_v;
          elsif v_sc_k = 'starts_at' then v_sc_start := v_sc_v;
          else v_sc_end := v_sc_v;
          end if;
        end loop;
      end if;
      if v_sc_ok is not true then
        raise exception using errcode = 'P0001', message = 'SCANYM_SCHEDULE_MALFORMED';
      end if;
    end if;

    -- T2 -- normalisation (contract 5.3): starts_at is the chosen time ONLY when no
    -- slot key is sent; with a slot key it is an echo and is not forwarded. ends_at
    -- is never forwarded. p_now is omitted: the engine uses the transaction timestamp.
    v_sc_time := case when v_sc_sent and v_sc_slot is null then v_sc_start else null end;

    select * into v_sc_val
    from public.validate_fulfillment_selection(
           v_restaurant.id, p_service_mode, v_fulfillment_rule_id,
           case when v_sc_sent then v_sc_date else null end,
           case when v_sc_sent then v_sc_slot else null end,
           v_sc_time);

    -- T3 -- interpretation. An unknown result is an engine/contract defect (XX000),
    -- never converted into a customer code.
    v_sc_why := null;
    v_sc_code := null;
    if v_sc_val.result = 'unavailable' then
      v_sc_why := coalesce(v_sc_val.reason, '<null>');
    elsif v_sc_val.result = 'not_required' then
      if v_sc_sent then
        raise exception using errcode = 'XX000',
          message = 'CSDJ3_ENGINE_CONTRACT_DEFECT: not_required returned although a selection was sent';
      end if;
    elsif v_sc_val.result = 'valid' then
      if not v_sc_sent
         or v_sc_val.selection_date is null
         or v_sc_val.schedule_timezone is null
         or v_sc_val.date_selection_mode is null
         or v_sc_val.slot_selection_mode is null
         or v_sc_val.capacity_applies is null then
        raise exception using errcode = 'XX000',
          message = 'CSDJ3_ENGINE_CONTRACT_DEFECT: valid selection row is incomplete';
      end if;
      if v_sc_val.selection_date <> v_sc_date then
        raise exception using errcode = 'XX000',
          message = 'CSDJ3_ENGINE_CONTRACT_DEFECT: engine retained a date the customer did not send';
      end if;

      -- Echo equality (contract 5.4): exact string equality on HH:MM; the scope is
      -- read from the VALIDATE ROW, never from the client. A stale display is
      -- refused, never corrected.
      if v_sc_val.selection_slot_key is not null then
        if (v_sc_start is not null and v_sc_start is distinct from v_sc_val.window_starts_at)
           or (v_sc_end is not null and v_sc_end is distinct from v_sc_val.window_ends_at) then
          v_sc_code := 'SCANYM_SCHEDULE_SLOT_INVALID';
        end if;
      elsif v_sc_val.selection_time is not null then
        if v_sc_end is not null and v_sc_end is distinct from v_sc_val.window_ends_at then
          v_sc_code := 'SCANYM_SCHEDULE_TIME_INVALID';
        end if;
      elsif v_sc_start is not null or v_sc_end is not null then
        v_sc_code := 'SCANYM_SCHEDULE_SLOT_INVALID';
      end if;

      -- T4 -- capacity: iff the engine said so, with the values the SERVER retained.
      if v_sc_code is null and v_sc_val.capacity_applies then
        select * into v_sc_rsv
        from public.reserve_fulfillment_capacity(
               v_order_id, v_restaurant.id, p_service_mode, v_fulfillment_rule_id,
               v_sc_val.selection_date, v_sc_val.selection_slot_key, v_sc_val.selection_time);
        if v_sc_rsv.result = 'unavailable' then
          v_sc_why := coalesce(v_sc_rsv.reason, '<null>');
        elsif not ((v_sc_rsv.result = 'reserved' or v_sc_rsv.result = 'not_required')
                   and v_sc_rsv.reason is null) then
          raise exception using errcode = 'XX000',
            message = 'CSDJ3_ENGINE_CONTRACT_DEFECT: unexpected reserve_fulfillment_capacity outcome';
        end if;
      end if;

      -- T5 -- immutable snapshot, from the VALIDATE ROW only.
      if v_sc_code is null and v_sc_why is null then
        insert into public.order_fulfillment_schedule_snapshot (
          order_id, restaurant_id, mode_code, fulfillment_rule_id,
          scheduled_date, slot_key, selected_time, window_starts_at, window_ends_at,
          instant_starts_at, origin, timezone, date_selection_mode, slot_selection_mode,
          resolved_at
        ) values (
          v_order_id, v_restaurant.id, p_service_mode, v_fulfillment_rule_id,
          v_sc_val.selection_date, v_sc_val.selection_slot_key, v_sc_val.selection_time,
          v_sc_val.window_starts_at, v_sc_val.window_ends_at,
          v_sc_val.instant_starts_at,
          case when v_sc_val.date_selection_mode = 'derived_earliest'
               then 'server_derived' else 'customer' end,
          v_sc_val.schedule_timezone, v_sc_val.date_selection_mode, v_sc_val.slot_selection_mode,
          pg_catalog.transaction_timestamp()
        );
      end if;
    else
      raise exception using errcode = 'XX000',
        message = 'CSDJ3_ENGINE_CONTRACT_DEFECT: unexpected validate_fulfillment_selection result';
    end if;

    -- Engine reason -> typed customer code (contract 10): ONE table, the whole closed
    -- catalogue of fulfillment_selection_reasons_v12(). An unmapped reason is a defect.
    if v_sc_why is not null then
      v_sc_code := case v_sc_why
        when 'schedule_not_fulfillable' then 'SCANYM_SCHEDULE_UNFULFILLABLE'
        when 'selection_required'       then 'SCANYM_SCHEDULE_REQUIRED'
        when 'selection_not_expected'   then 'SCANYM_SCHEDULE_NOT_SELECTABLE'
        when 'selection_invalid'        then 'SCANYM_SCHEDULE_MALFORMED'
        when 'date_not_offered'         then 'SCANYM_SCHEDULE_DATE_NOT_ELIGIBLE'
        when 'slot_not_offered'         then 'SCANYM_SCHEDULE_SLOT_INVALID'
        when 'time_not_offered'         then 'SCANYM_SCHEDULE_TIME_INVALID'
        when 'capacity_full'            then 'SCANYM_SCHEDULE_SLOT_FULL'
        else null end;
      if v_sc_code is null then
        raise exception using errcode = 'XX000',
          message = 'CSDJ3_ENGINE_CONTRACT_DEFECT: unmapped selection reason ' || v_sc_why;
      end if;
    end if;
    if v_sc_code is not null then
      raise exception using errcode = 'P0001', message = v_sc_code;
    end if;
  end;
  -- CSDJ-3 END

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $function$
