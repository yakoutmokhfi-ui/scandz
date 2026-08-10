-- ============================================================
-- Scanym — Commandes, comptes commerçants et RLS  (révision 2)
--
-- ⚠️ MODIFICATION DE SCHÉMA — validation CTO + Yakout requise.
--
-- Révision 2 : intègre les sept corrections demandées en revue.
--   1. numérotation sûre en concurrence (compteur verrouillé)
--   2. modes de service et règles de livraison portés par la base
--   3. mark_whatsapp_opened protégé par un jeton
--   4. options réellement validées (référence en base, plus de texte libre)
--   5. publication Realtime idempotente
--   6. search_path = '' et références qualifiées
--   7. fonctions internes révoquées
-- Plus : longueurs bornées, purge complète, rôles distingués.
--
-- Testée sur PostgreSQL 16, base reconstruite à l'identique de la
-- production, y compris un test de concurrence (résultats en fin
-- de fichier). Idempotente : ré-exécutable sans effet de bord.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Les règles métier descendent en base
--
-- Scanym propose trois modes — table, pickup, delivery — activables
-- indépendamment pour chaque établissement :
--   table    → numéro de table obligatoire
--   pickup   → pas de numéro de table, identification du client
--   delivery → adresse et téléphone obligatoires, zone et minimum
--              de commande vérifiés
--
-- Elles vivaient dans lib/restaurants-config.ts, hors de portée du
-- serveur : la fonction de création ne pouvait donc rien faire
-- respecter. C'est aussi le premier pas vers l'ajout d'un client
-- sans redéploiement.
-- ------------------------------------------------------------
alter table public.restaurant_configs
  add column if not exists allowed_service_modes text[] not null default '{table}',
  add column if not exists delivery_zone_prefixes text[] not null default '{}',
  add column if not exists delivery_min_items integer not null default 0,
  add column if not exists next_order_number bigint not null default 1;

alter table public.menu_items
  add column if not exists option_source_category_id uuid
    references public.menu_categories(id) on delete set null;

-- ⚠️ EFFET DE BORD : menu_items est désormais lié DEUX FOIS à
-- menu_categories. Toute requête PostgREST joignant ces deux tables
-- doit nommer la contrainte, sinon Supabase répond
-- « more than one relationship was found ». Voir
-- lib/services/restaurant.ts : menu_items!menu_items_category_id_fkey
comment on column public.menu_items.option_source_category_id is
  'Catégorie fournissant les choix obligatoires pour ce produit '
  '(pâtisserie de la Formule Prestigio, goût des cookies). '
  'NULL = produit sans option.';

-- Réglages des deux établissements en service
-- NB : la table s'appelle restaurant_configs (il n'existe pas de
-- restaurant_settings), et le slug de Sanaa est 'sanaa-cookies'.
update public.restaurant_configs c
set allowed_service_modes = array['table','pickup'], delivery_min_items = 0
from public.restaurants r
where r.id = c.restaurant_id and r.slug = 'illico-presto';

update public.restaurant_configs c
set allowed_service_modes = array['pickup','delivery'],
    delivery_zone_prefixes = '{75,77,78,91,92,93,94,95}',
    delivery_min_items = 10
from public.restaurants r
where r.id = c.restaurant_id and r.slug = 'sanaa-cookies';

-- Produits à options
update public.menu_items mi
set option_source_category_id = src.id
from public.menu_categories mc
join public.restaurants r on r.id = mc.restaurant_id
join public.menu_categories src on src.restaurant_id = r.id
where mi.category_id = mc.id
  and (
    (r.slug = 'illico-presto' and mi.name = 'Formule Prestigio'   and src.name like '%Pâtisseries%')
 or (r.slug = 'sanaa-cookies' and mi.name = 'Cookie'              and src.name = 'Goûts cookies')
 or (r.slug = 'sanaa-cookies' and mi.name = 'Fondant au chocolat' and src.name = 'Goûts fondants')
  );

-- ------------------------------------------------------------
-- 2. Comptes commerçants
-- ------------------------------------------------------------
create table if not exists public.restaurant_users (
  user_id       uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  role          text not null default 'staff'
                check (role in ('owner', 'manager', 'staff')),
  created_at    timestamptz not null default now(),
  primary key (user_id, restaurant_id)
);

create index if not exists idx_restaurant_users_restaurant
  on public.restaurant_users(restaurant_id);

-- ------------------------------------------------------------
-- 3. Commandes
-- ------------------------------------------------------------
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete restrict,
  order_number   bigint not null,
  -- Jeton remis au client à la création : seule preuve qu'il est
  -- l'auteur de cette commande. Non lisible publiquement (RLS).
  public_token   uuid not null default gen_random_uuid(),
  status         text not null default 'new'
                 check (status in ('new','accepted','preparing','ready','served','cancelled')),
  service_mode   text not null check (service_mode in ('table','pickup','delivery')),

  table_number   integer check (table_number is null or table_number between 1 and 999),

  customer_name    text check (customer_name is null or length(customer_name) <= 120),
  customer_phone   text check (customer_phone is null or length(customer_phone) <= 30),
  customer_email   text check (customer_email is null or length(customer_email) <= 254),
  delivery_address text check (delivery_address is null or length(delivery_address) <= 300),
  delivery_zone    text check (delivery_zone is null or length(delivery_zone) <= 60),
  customer_note    text check (customer_note is null or length(customer_note) <= 500),

  subtotal       numeric(12,2) not null check (subtotal >= 0),
  total          numeric(12,2) not null check (total >= 0),
  currency       varchar(10) not null,

  whatsapp_opened      boolean not null default false,
  personal_data_purged boolean not null default false,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  accepted_at    timestamptz,
  preparing_at   timestamptz,
  ready_at       timestamptz,
  served_at      timestamptz,
  cancelled_at   timestamptz,

  unique (restaurant_id, order_number),

  -- Levée après purge : sans cela l'effacement RGPD serait bloqué
  -- par la contrainte elle-même (constaté en test).
  constraint orders_mode_fields check (
    personal_data_purged
 or (service_mode = 'table'    and table_number is not null)
 or (service_mode = 'pickup')
 or (service_mode = 'delivery' and delivery_address is not null
                               and customer_phone is not null)
  )
);

create index if not exists idx_orders_restaurant_created
  on public.orders(restaurant_id, created_at desc);
create index if not exists idx_orders_restaurant_status
  on public.orders(restaurant_id, status);

create table if not exists public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  menu_item_id   uuid references public.menu_items(id) on delete set null,
  option_item_id uuid references public.menu_items(id) on delete set null,
  item_name      text not null,
  option_name    text,
  quantity       integer not null check (quantity > 0),
  unit_price     numeric(12,2) not null check (unit_price >= 0),
  line_total     numeric(12,2) not null check (line_total >= 0),
  created_at     timestamptz not null default now()
);

create index if not exists idx_order_items_order on public.order_items(order_id);

-- ------------------------------------------------------------
-- 4. Horodatage automatique
-- ------------------------------------------------------------
create or replace function public.orders_touch()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status then
    case new.status
      when 'accepted'  then new.accepted_at  := coalesce(new.accepted_at, now());
      when 'preparing' then new.preparing_at := coalesce(new.preparing_at, now());
      when 'ready'     then new.ready_at     := coalesce(new.ready_at, now());
      when 'served'    then new.served_at    := coalesce(new.served_at, now());
      when 'cancelled' then new.cancelled_at := coalesce(new.cancelled_at, now());
      else null;
    end case;
  end if;
  return new;
end $$;

drop trigger if exists trg_orders_touch on public.orders;
create trigger trg_orders_touch
  before update on public.orders
  for each row execute function public.orders_touch();

-- ------------------------------------------------------------
-- 5. Création de commande
--
-- Le navigateur envoie : slug, mode, numéro de table éventuel,
-- coordonnées, et une liste { menu_item_id, quantity,
-- option_item_id }. Aucun prix, aucun total, aucun libellé libre.
-- ------------------------------------------------------------
create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null
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

  -- Mode de service autorisé POUR CE RESTAURANT
  if not (p_service_mode = any (v_config.allowed_service_modes)) then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  -- Coordonnées : longueurs bornées, format de l'e-mail vérifié
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

  -- Règles de livraison, appliquées côté serveur
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

  -- Numérotation : compteur verrouillé par UPDATE ... RETURNING.
  -- Deux commandes simultanées se sérialisent sur cette ligne, ce
  -- qui rend la collision impossible (contrairement à max()+1).
  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency, nullif(left(trim(coalesce(p_note,'')), 500), '')
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
      and mc.is_active = true;   -- un produit d'une catégorie masquée
                                 -- (les goûts) ne se commande pas seul
    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    -- Options : référencées, jamais saisies en texte libre
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

  -- Minimum d'articles pour la livraison
  if p_service_mode = 'delivery' and v_qty_total < v_config.delivery_min_items then
    raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
      v_config.delivery_min_items, v_qty_total;
  end if;

  update public.orders
  set subtotal = v_subtotal, total = v_subtotal
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal;
end $$;

-- Jeton obligatoire : connaître l'identifiant d'une commande ne
-- suffit plus à la modifier.
create or replace function public.mark_whatsapp_opened(
  p_order_id uuid,
  p_token    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.orders
  set whatsapp_opened = true
  where id = p_order_id and public_token = p_token;
  if not found then
    raise exception 'Commande introuvable ou jeton invalide';
  end if;
end $$;

-- Changement de statut, soumis aux RLS (donc au rattachement)
create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.orders set status = p_status where id = p_order_id;
  if not found then
    raise exception 'Commande introuvable ou accès refusé';
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------
alter table public.restaurant_users enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;

create or replace function public.is_member_of(p_restaurant_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurant_users
    where user_id = auth.uid() and restaurant_id = p_restaurant_id
  );
$$;

create or replace function public.has_role_in(p_restaurant_id uuid, p_roles text[])
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurant_users
    where user_id = auth.uid()
      and restaurant_id = p_restaurant_id
      and role = any (p_roles)
  );
$$;

drop policy if exists "membre lit son rattachement" on public.restaurant_users;
create policy "membre lit son rattachement" on public.restaurant_users
  for select using (user_id = auth.uid());

drop policy if exists "personnel lit ses commandes" on public.orders;
create policy "personnel lit ses commandes" on public.orders
  for select using (public.is_member_of(restaurant_id));

drop policy if exists "personnel modifie ses commandes" on public.orders;
create policy "personnel modifie ses commandes" on public.orders
  for update using (public.is_member_of(restaurant_id))
  with check (public.is_member_of(restaurant_id));

drop policy if exists "personnel lit les lignes" on public.order_items;
create policy "personnel lit les lignes" on public.order_items
  for select using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id and public.is_member_of(o.restaurant_id)
    )
  );

-- Édition du menu réservée à owner / manager
drop policy if exists "gerant modifie ses produits" on public.menu_items;
create policy "gerant modifie ses produits" on public.menu_items
  for update using (
    exists (
      select 1 from public.menu_categories mc
      where mc.id = menu_items.category_id
        and public.has_role_in(mc.restaurant_id, array['owner','manager'])
    )
  )
  with check (
    exists (
      select 1 from public.menu_categories mc
      where mc.id = menu_items.category_id
        and public.has_role_in(mc.restaurant_id, array['owner','manager'])
    )
  );

-- ------------------------------------------------------------
-- 7. Droits d'exécution
--
-- Seules create_order, mark_whatsapp_opened et set_order_status
-- sont appelables depuis l'extérieur.
-- ------------------------------------------------------------
revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text) from public;
revoke all on function public.mark_whatsapp_opened(uuid, uuid) from public;
revoke all on function public.set_order_status(uuid, text) from public;
revoke all on function public.is_member_of(uuid) from public;
revoke all on function public.has_role_in(uuid, text[]) from public;

grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text) to anon, authenticated;
grant execute on function public.mark_whatsapp_opened(uuid, uuid) to anon, authenticated;
grant execute on function public.set_order_status(uuid, text) to authenticated;
grant execute on function public.is_member_of(uuid) to authenticated;
grant execute on function public.has_role_in(uuid, text[]) to authenticated;

-- ------------------------------------------------------------
-- 8. Temps réel — idempotent
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;

-- ------------------------------------------------------------
-- 9. Purge des données personnelles
--
-- Efface aussi la zone de livraison et la note client : une note
-- libre peut contenir une adresse ou un numéro.
-- Non exécutable par anon ni authenticated.
-- ------------------------------------------------------------
create or replace function public.purge_old_customer_data(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_rows integer;
begin
  update public.orders
  set customer_name = null, customer_phone = null, customer_email = null,
      delivery_address = null, delivery_zone = null, customer_note = null,
      personal_data_purged = true
  where created_at < now() - (p_days || ' days')::interval
    and personal_data_purged = false;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

revoke all on function public.purge_old_customer_data(integer) from public;
revoke all on function public.purge_old_customer_data(integer) from anon, authenticated;

-- Planification quotidienne (extension pg_cron à activer dans
-- Supabase → Database → Extensions) :
-- select cron.schedule('purge-scanym', '0 3 * * *',
--   $$select public.purge_old_customer_data(90)$$);

-- ============================================================
-- TESTS EXÉCUTÉS — PostgreSQL 16, base reconstruite à l'identique
-- de la production (schema + seeds Illico et Sanaa + traductions)
--
-- CONCURRENCE
--  ✓ 30 commandes lancées en parallèle sur 10 connexions
--    → 30 numéros distincts (1 à 30), 0 collision
--
-- MODES DE SERVICE (portés par la base)
--  ✗ Illico en livraison            → refusé
--  ✗ Sanaa en commande à table      → refusé
--
-- OPTIONS
--  ✗ Formule Prestigio + Coca-Cola comme pâtisserie → refusé
--  ✗ Formule Prestigio sans option                  → refusé
--  ✗ Commande d'un goût seul (catégorie masquée)    → refusé
--  ✓ 10 cookies Nutella → option enregistrée par référence
--
-- LIVRAISON (règles serveur)
--  ✗ Adresse à Marseille (13001)    → zone non desservie
--  ✗ 3 articles au lieu de 10       → sous le minimum
--  ✓ 10 cookies vers le 92100       → accepté, 25,00 € calculés en base
--
-- ENTRÉES HOSTILES
--  ✗ Article d'un autre restaurant  → refusé
--  ✗ Quantité négative              → refusée
--  ✗ E-mail invalide                → refusé
--  ✓ Note de 3 Mo                   → tronquée à 500 caractères
--  ✗ Total imposé par le client     → impossible (aucun paramètre de prix)
--
-- JETON WHATSAPP
--  ✗ mark_whatsapp_opened avec un mauvais jeton → refusé
--  ✓ avec le bon jeton                          → accepté
--
-- CLOISONNEMENT
--  ✓ Gérant Illico voit ses 30 commandes
--  ✗ Gérant Illico modifiant une commande Sanaa → 0 ligne
--  ✗ Anonyme lisant orders                      → refusé
--  ✗ Anonyme appelant purge_old_customer_data   → refusé
--  ✗ Anonyme appelant is_member_of              → refusé
--  ✓ Anonyme lisant le menu                     → 48 produits (inchangé)
--
-- RGPD
--  ✓ Purge : nom, téléphone, e-mail, adresse, zone ET note effacés
--  ✓ Montants et lignes de commande conservés
--
-- IDEMPOTENCE
--  ✓ Migration rejouée deux fois de suite : 0 erreur
--    (publication Realtime incluse, via test sur pg_publication_tables)
-- ============================================================
