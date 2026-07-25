-- ============================================================
-- ScanDZ — Schéma canonique
-- Référence : docs/DATABASE.md
-- Aucune modification sans validation Yakout + revue CTO
-- À exécuter dans l'éditeur SQL de Supabase
-- ============================================================

-- Extension nécessaire pour gen_random_uuid() (déjà active sur Supabase)
-- create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- restaurants
-- ------------------------------------------------------------
create table restaurants (
    id          uuid primary key default gen_random_uuid(),
    name        varchar(255) not null,
    slug        varchar(255) not null unique,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- restaurant_configs (relation 1-1 avec restaurants)
-- ------------------------------------------------------------
create table restaurant_configs (
    restaurant_id    uuid primary key references restaurants(id) on delete cascade,
    max_tables       integer not null default 15,
    currency         varchar(10) not null default 'DZD',
    whatsapp_number  varchar(50) not null,
    address          text,
    latitude         decimal(10,8),
    longitude        decimal(11,8),
    logo_url         text,
    opening_hours    text
);

-- ------------------------------------------------------------
-- menu_categories
-- ------------------------------------------------------------
create table menu_categories (
    id             uuid primary key default gen_random_uuid(),
    restaurant_id  uuid not null references restaurants(id) on delete cascade,
    name           varchar(255) not null,
    display_order  integer not null default 0,
    is_active      boolean not null default true
);

-- ------------------------------------------------------------
-- menu_items
-- ------------------------------------------------------------
create table menu_items (
    id             uuid primary key default gen_random_uuid(),
    category_id    uuid not null references menu_categories(id) on delete cascade,
    name           varchar(255) not null,
    description    text,
    price          decimal(10,2) not null,
    image_url      text,
    display_order  integer not null default 0,
    is_available   boolean not null default true
);

-- ------------------------------------------------------------
-- Index utiles pour la lecture du menu par slug
-- (lecture seule, aucun impact sur le modèle)
-- ------------------------------------------------------------
create index idx_menu_categories_restaurant on menu_categories(restaurant_id);
create index idx_menu_items_category on menu_items(category_id);

-- ------------------------------------------------------------
-- RLS : lecture publique (le menu est public par nature)
-- Écriture bloquée côté client — les insertions se font
-- via l'éditeur SQL / service role uniquement pour le MVP.
-- ------------------------------------------------------------
alter table restaurants enable row level security;
alter table restaurant_configs enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;

create policy "lecture publique restaurants"
    on restaurants for select using (true);

create policy "lecture publique configs"
    on restaurant_configs for select using (true);

create policy "lecture publique categories"
    on menu_categories for select using (true);

create policy "lecture publique items"
    on menu_items for select using (true);
