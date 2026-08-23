-- ============================================================
-- Scanym LOT 2A — Rollback (CORRIGÉ après contre-audit Work, tour
-- LOT 2A.1 -- L2A-01 et L2A-06).
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CIO en cas de besoin
-- réel, après revue.
--
-- ⚠️ CORRIGE L2A-01 : la version précédente restaurait create_order
-- vers le corps de migration-orders-lang.sql -- une baseline DÉJÀ
-- OBSOLÈTE au commit 7b4fdcf..., puisque migration-v65-order-note.sql
-- PUIS migration-lotd-establishment-creation.sql l'avaient toutes deux
-- redéfinie ensuite. Un rollback avec ce texte aurait donc RÉGRESSÉ
-- deux protections réelles (status='active', rejet des notes > 500
-- caractères) au lieu de revenir à l'état RÉELLEMENT antérieur. Ce
-- fichier restaure désormais le texte EXACT actif à 7b4fdcf...
-- (extraction programmatique depuis migration-lotd-establishment-creation.sql,
-- jamais retapé).
--
-- ⚠️ CORRIGE L2A-06 : le préflight précédent excluait les commandes
-- personal_data_purged=true de la détection d'incompatibilité. Or la
-- contrainte orders_service_mode_check restaurée par ce rollback
-- (CHECK simple sur service_mode, SANS clause d'échappement pour les
-- commandes purgées, contrairement à orders_mode_fields) rejetterait
-- TOUJOURS une ligne dont service_mode n'est pas dans
-- ('table','pickup','delivery'), qu'elle soit purgée ou non. Le
-- préflight vérifie désormais TOUTES les commandes incompatibles,
-- purgées ou non.
-- ============================================================

do $$
declare
  v_incompatible_count integer;
  v_report text;
begin
  select count(*), string_agg(format('  - commande #%s (%s) : mode %s%s', order_number, id, service_mode, case when personal_data_purged then ' [données personnelles purgées]' else '' end), E'\n' order by created_at)
  into v_incompatible_count, v_report
  from public.orders
  where service_mode not in ('table', 'pickup', 'delivery');

  if v_incompatible_count > 0 then
    raise exception E'SCANYM_ROLLBACK_BLOCKED: % commande(s) utilisent un mode introduit par LOT 2A (click_collect/room_service), incompatible avec orders_service_mode_check restaurée par ce rollback -- CETTE CONTRAINTE N''A AUCUNE CLAUSE D''ÉCHAPPEMENT POUR LES COMMANDES PURGÉES (contrairement à orders_mode_fields), donc même une commande personal_data_purged=true serait rejetée :\n%\nAUCUNE MODIFICATION N''A ÉTÉ EFFECTUÉE (préflight en lecture seule, hors transaction). Ces commandes doivent être traitées manuellement avant de relancer ce rollback.', v_incompatible_count, v_report;
  end if;

  raise notice 'SCANYM_ROLLBACK_PREFLIGHT: OK -- aucune commande incompatible (purgée ou non) avec les contraintes historiques. Le rollback peut se poursuivre en toute sécurité.';
end $$;

begin;

drop function if exists public.create_order(text, text, jsonb, integer, jsonb, text, text);

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
  v_note        text;
begin
  -- Corrigé après audit Work (Lot D) : status = 'active' exige
  -- explicitement le workflow owner finalisé, en plus de is_active
  -- (bascule manuelle historique). Un établissement onboarding,
  -- suspended ou inactive ne doit jamais pouvoir recevoir de
  -- commande, même en connaissant son slug exact.
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
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

  -- Note générale (V65) : rejet explicite, aucune troncature.
  -- Une seule note globale ; il n'y a pas de note par ligne.
  --
  -- btrim(..., E' \t\n\r\f' || chr(11)) plutôt que trim(...) : jeu de
  -- caractères explicite (espace, tabulation, LF, CR, FF, VT),
  -- STRICTEMENT identique à celui utilisé côté TypeScript dans
  -- lib/order-note.ts (fonction trimNoteEdges / EDGE_WHITESPACE).
  -- trim() natif de PostgreSQL ne retirerait que l'espace ASCII et
  -- laisserait tabulations/sauts de ligne en bordure — divergence
  -- volontairement évitée plutôt que présumée absente.
  --
  -- chr(11), pas \v : \v n'est PAS un échappement reconnu dans une
  -- chaîne E'...' de PostgreSQL (seuls \b \f \n \r \t le sont ; tout
  -- le reste est pris littéralement). E'\v' produirait la lettre "v",
  -- pas la tabulation verticale U+000B — vérifié empiriquement
  -- (ascii(E'\v') = 118). chr(11) produit le vrai caractère quel que
  -- soit le moteur. Un test statique interdit toute réapparition de
  -- \v dans cette chaîne (tests/v65-order-note.test.ts).
  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
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
    v_note,
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

revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public, anon;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text) to authenticated, anon;

-- Restaure les 2 contraintes CHECK historiques figées, texte EXACT
-- (extrait de migration-orders.sql, jamais retapé à la main).
alter table public.orders drop constraint if exists orders_service_mode_fkey;
alter table public.orders
  add constraint orders_service_mode_check check (service_mode = any (array['table','pickup','delivery']));

alter table public.orders
  add constraint orders_mode_fields check (
    personal_data_purged
 or (service_mode = 'table'    and table_number is not null)
 or (service_mode = 'pickup')
 or (service_mode = 'delivery' and delivery_address is not null
                               and customer_phone is not null)
  );

-- room_number : colonne NOUVELLE créée par LOT 2A (corrige L2A-02),
-- retirée -- aucune donnée pré-LOT-2A n'a jamais pu l'utiliser.
alter table public.orders drop column if exists room_number;

-- Tables LOT 2A -- ordre inverse de création. order_delivery_address
-- perd sa raison d'être une fois orders.delivery_address (texte)
-- redevenue l'unique source (jamais désynchronisée pendant LOT 2A,
-- donc aucune perte : le texte historique reste intact sur orders).
drop table if exists public.order_delivery_address;
drop table if exists public.restaurant_sale_mode_field_requirements;
drop table if exists public.sale_mode_field_requirements;
drop table if exists public.restaurant_sale_modes;
-- Fonctions LOT 2A.2 (projection publique + résolveur partagé) --
-- retirées avant les tables dont elles dépendent.
drop function if exists public.get_restaurant_public_field_requirements(uuid, text);
drop function if exists public.get_restaurant_public_sale_modes(uuid);
drop function if exists public.effective_sale_mode_field_requirements(uuid, text);

drop table if exists public.sale_mode_catalog;

commit;
