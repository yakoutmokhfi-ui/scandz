-- ============================================================
-- Scanym — Langue du client sur la commande  (additif)
--
-- À exécuter APRÈS migration-orders.sql, qui est déjà en place.
-- Additif et idempotent : ne touche à aucune donnée existante.
--
-- Pourquoi : la table orders ne conservait pas la langue dans
-- laquelle le client a commandé. C'est une information utile pour
-- le dashboard (savoir en quelle langue rappeler un client) et
-- pour mesurer l'usage réel du multilingue.
--
-- La fonction create_order est remplacée, et non surchargée : une
-- surcharge avec paramètre par défaut rendrait l'appel ambigu.
-- ============================================================

alter table public.orders
  add column if not exists customer_language text
    check (customer_language is null or length(customer_language) <= 10);

drop function if exists public.create_order(text, text, jsonb, integer, jsonb, text);

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
)
returns table (order_id uuid, order_number bigint, public_token uuid, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
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
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true;
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  if not (p_service_mode = any (v_config.allowed_service_modes)) then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  if p_service_mode = 'table' and p_table_number is null then
    raise exception 'Numéro de table requis';
  end if;

  if p_service_mode = 'delivery' then
    if v_address is null or v_phone is null then
      raise exception 'Adresse et téléphone requis pour une livraison';
    end if;
    v_postal := substring(v_address from '\m(\d{5})\M');
    if v_postal is null then
      raise exception 'Code postal absent de l''adresse';
    end if;
    select p into v_zone
    from unnest(v_config.delivery_zone_prefixes) as p
    where v_postal like p || '%'
    limit 1;
    if v_zone is null then
      raise exception 'Zone non desservie: %', v_postal;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    nullif(left(trim(coalesce(p_note,'')), 500), ''),
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

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

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and v_qty_total < v_config.delivery_min_items then
    raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
      v_config.delivery_min_items, v_qty_total;
  end if;

  update public.orders
  set subtotal = v_subtotal, total = v_subtotal
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal;
end $$;

revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text)
  to anon, authenticated;
