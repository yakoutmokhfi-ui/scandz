-- ============================================================
-- Scanym — PRODUCT SERVICE MODES v1
-- (issue #11, CIO / Ravel — "OPEN NEW LOT: PRODUCT SERVICE MODES v1",
-- décisions de conception "PRODUCT SERVICE MODES v1 — DESIGN
-- DECISIONS APPROVED: RELATIONAL RESTRICTIONS + INLINE create_order
-- SNAPSHOT").
--
-- OBJECTIF : chaque produit peut être restreint à un SOUS-ENSEMBLE des
-- modes de service activés par son établissement (ex. Au Lait Cru :
-- œufs/lait cru = retrait uniquement, alors que l'établissement a
-- PICKUP + DELIVERY). Indépendant de withdrawal_eligible (droit de
-- rétractation légal) -- les deux attributs restent des colonnes/
-- structures séparées, jamais couplées, jamais l'un inféré de
-- l'autre.
--
-- DÉCISIONS CIO/RAVEL APPLIQUÉES (issue #11) :
--   1. Modélisation RELATIONNELLE, alignée sur restaurant_sale_modes
--      déjà en production (LOT 2A) -- PAS un array/jsonb sur
--      menu_items.
--   2. Sémantique "ALL par absence" : AUCUNE ligne de restriction pour
--      un produit = TOUS les modes établissement autorisés. Une ou
--      plusieurs lignes = sous-ensemble EXPLICITE. "Tous" côté UI =
--      vider les lignes de restriction, jamais les matérialiser.
--   3. Un produit restreint doit conserver AU MOINS un mode autorisé
--      (un tableau non-NULL mais VIDE est une erreur, jamais un repli
--      silencieux sur ALL).
--   4. Les modes sélectionnés doivent appartenir aux modes RÉELLEMENT
--      activés (enabled=true) de l'établissement -- jamais un mode
--      désactivé ou étranger.
--   5. Enforcement + snapshot INLINE dans create_order (l'unique
--      chemin serveur autoritaire de création de commande), PAS un
--      trigger séparé -- create_order valide déjà le mode de service
--      demandé au niveau établissement (restaurant_sale_modes,
--      ligne v_mode_enabled) ; ce lot ajoute la même vérification au
--      niveau PRODUIT, dans la même transaction.
--   6. Snapshot minimal : un simple booléen immuable prouvant que la
--      ligne a été validée éligible au mode demandé AU MOMENT de la
--      commande -- jamais une copie de la configuration produit
--      courante (même philosophie que withdrawal_eligible_at_order_
--      time / les colonnes CGV Engine v2.5 : NULLABLE, sans défaut,
--      NULL pour l'historique antérieur à ce lot, jamais deviné/
--      rétro-rempli).
--
-- Écriture : UNIQUEMENT via create_product / update_product (RPC
-- SECURITY DEFINER déjà existantes, LOT reprend leur patron exact --
-- "un seul nouveau paramètre optionnel en fin de signature, rétro-
-- compatible", voir commentaire section I de DRAFT-lot-online-
-- withdrawal-foundation-v1.sql). Aucun GRANT insert/update/delete sur
-- la nouvelle table pour anon/authenticated -- même patron que
-- sale_mode_catalog (donnée gérée exclusivement par RPC).
-- ============================================================

-- ------------------------------------------------------------------
-- 0. Contrôle préalable (anti-dérive).
-- ------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'menu_item_sale_modes'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.menu_item_sale_modes existe déjà — migration PRODUCT SERVICE MODES v1 annulée pour éviter une double application.';
  end if;
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'sale_mode_catalog'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.sale_mode_catalog introuvable — prérequis LOT 2A manquant.';
  end if;
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_modes'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurant_sale_modes introuvable — prérequis LOT 2A manquant.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order'
      and pg_get_function_identity_arguments(p.oid) like '%p_slug%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_order introuvable ou signature inattendue — migration PRODUCT SERVICE MODES v1 annulée. Examiner manuellement.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: create_product introuvable — migration PRODUCT SERVICE MODES v1 annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- A. menu_item_sale_modes — restrictions PAR PRODUIT, miroir
--    structurel de restaurant_sale_modes (LOT 2A). Contrairement à
--    restaurant_sale_modes (privée, provider/pricing_mode internes,
--    projection publique dédiée requise), cette table ne porte AUCUNE
--    donnée sensible -- juste une paire (produit, code de mode), aussi
--    publique que menu_items.is_available l'est déjà. Elle peut donc
--    être lue publiquement, scopée EXACTEMENT comme menu_items
--    ("lecture publique items actifs", migration-lotd-establishment-
--    creation.sql).
-- ------------------------------------------------------------------

create table public.menu_item_sale_modes (
  menu_item_id  uuid not null references public.menu_items(id) on delete cascade,
  mode_code     text not null references public.sale_mode_catalog(code),
  created_at    timestamptz not null default now(),
  primary key (menu_item_id, mode_code)
);

comment on table public.menu_item_sale_modes is
  'PRODUCT SERVICE MODES v1 — restriction de modes de service PAR PRODUIT. AUCUNE ligne pour un produit = TOUS les modes de l''établissement autorisés (sémantique "ALL par absence", décision CIO/Ravel issue #11). Une ou plusieurs lignes = sous-ensemble EXPLICITE des modes établissement. Géré EXCLUSIVEMENT par create_product/update_product (SECURITY DEFINER) -- jamais d''écriture directe cliente.';

create index idx_menu_item_sale_modes_menu_item on public.menu_item_sale_modes(menu_item_id);

alter table public.menu_item_sale_modes enable row level security;

create policy "menu_item_sale_modes_select_public_active"
on public.menu_item_sale_modes for select
to public
using (
  exists (
    select 1 from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    join public.restaurants r on r.id = mc.restaurant_id
    where mi.id = menu_item_sale_modes.menu_item_id
      and r.is_active = true and r.status = 'active'
  )
);

create policy "menu_item_sale_modes_select_member"
on public.menu_item_sale_modes for select
to authenticated
using (
  exists (
    select 1 from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    join public.restaurant_users ru on ru.restaurant_id = mc.restaurant_id
    where mi.id = menu_item_sale_modes.menu_item_id
      and ru.user_id = auth.uid()
  )
);

grant select on public.menu_item_sale_modes to anon, authenticated;
revoke insert, update, delete on public.menu_item_sale_modes from public, anon, authenticated;

-- ------------------------------------------------------------------
-- B. order_items.service_mode_eligible_at_order_time — snapshot
--    immuable, minimal, NULLABLE sans défaut (même mandat que les
--    colonnes CGV Engine v2.5 : jamais deviné/rétro-rempli pour
--    l'historique). Rempli à `true` UNIQUEMENT par create_order
--    ci-dessous, exactement au moment où la vérification par ligne
--    est passée -- une commande dont une ligne échoue cette
--    vérification est intégralement rejetée (raise exception), donc
--    aucune ligne persistée ne peut jamais porter `false` : ce n'est
--    pas une redondance, c'est une preuve historique figée, valable
--    même si menu_item_sale_modes change ensuite pour ce produit.
-- ------------------------------------------------------------------

alter table public.order_items
  add column service_mode_eligible_at_order_time boolean;

comment on column public.order_items.service_mode_eligible_at_order_time is
  'PRODUCT SERVICE MODES v1 — preuve immuable que cette ligne a été validée éligible au mode de service de la commande AU MOMENT de create_order. NULL pour toute commande antérieure à ce lot -- jamais rétro-rempli/deviné. Toujours true pour les commandes créées après ce lot (une ligne inéligible fait échouer toute la commande, elle n''atteint jamais order_items) -- la valeur reste néanmoins persistée pour figer la preuve indépendamment d''une évolution future de menu_item_sale_modes pour ce produit.';

-- ------------------------------------------------------------------
-- C. create_product — CREATE + DROP de l'ancienne signature (même
--    patron que ONLINE WITHDRAWAL v1 pour withdrawal_eligible, voir
--    commentaire section I de DRAFT-lot-online-withdrawal-foundation-
--    v1.sql) : UN seul nouveau paramètre optionnel en fin de
--    signature, rétro-compatible.
-- ------------------------------------------------------------------

drop function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean);

create function public.create_product(
  p_category_id             uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null,
  p_withdrawal_eligible     boolean default false,
  p_allowed_sale_modes      text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_order integer;
  v_id uuid;
  v_name text;
  v_description text;
  v_short_description text;
  v_subcategory_category_id uuid;
  v_modes text[];
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_categories mc where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;
  if p_withdrawal_eligible is null then
    p_withdrawal_eligible := false;
  end if;

  -- PRODUCT SERVICE MODES v1 -- NULL = ALL (aucune ligne créée). Un
  -- tableau non-NULL mais VIDE est une erreur explicite : jamais un
  -- repli silencieux sur ALL (décision CIO/Ravel #3). Dédoublonné via
  -- DISTINCT avant validation/insertion.
  if p_allowed_sale_modes is not null then
    select array_agg(distinct m) into v_modes from unnest(p_allowed_sale_modes) as m;
    if v_modes is null or array_length(v_modes, 1) is null then
      raise exception using errcode = '22023', message = 'SCANYM_SERVICE_MODES_EMPTY_RESTRICTION';
    end if;
    if exists (
      select 1 from unnest(v_modes) as m
      where not exists (
        select 1 from public.restaurant_sale_modes rsm
        where rsm.restaurant_id = v_restaurant_id and rsm.mode_code = m and rsm.enabled = true
      )
    ) then
      raise exception using errcode = '22023', message = 'SCANYM_INVALID_SALE_MODE_FOR_ESTABLISHMENT';
    end if;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from p_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  insert into public.menu_items (
    category_id, name, description, short_description, price, display_order,
    tax_rate, unit_weight_grams, weight_is_approximate, subcategory_id, withdrawal_eligible
  )
  values (
    p_category_id, v_name, v_description, v_short_description, round(p_price, 2), v_order,
    p_tax_rate, p_unit_weight_grams, p_weight_is_approximate, p_subcategory_id, p_withdrawal_eligible
  )
  returning id into v_id;

  if v_modes is not null then
    insert into public.menu_item_sale_modes (menu_item_id, mode_code)
    select v_id, m from unnest(v_modes) as m;
  end if;

  return v_id;
end $$;

revoke all on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean, text[]) from public, anon;
grant execute on function public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean, text[]) to authenticated;

-- ------------------------------------------------------------------
-- D. update_product — même patron exact que C.
-- ------------------------------------------------------------------

drop function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean);

create function public.update_product(
  p_product_id              uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null,
  p_withdrawal_eligible     boolean default false,
  p_allowed_sale_modes      text[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_category_id uuid;
  v_name text;
  v_description text;
  v_short_description text;
  v_subcategory_category_id uuid;
  v_modes text[];
  v_has_restriction boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id, mc.id into v_restaurant_id, v_category_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_product_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this product';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;
  if p_withdrawal_eligible is null then
    p_withdrawal_eligible := false;
  end if;

  v_has_restriction := p_allowed_sale_modes is not null;
  if v_has_restriction then
    select array_agg(distinct m) into v_modes from unnest(p_allowed_sale_modes) as m;
    if v_modes is null or array_length(v_modes, 1) is null then
      raise exception using errcode = '22023', message = 'SCANYM_SERVICE_MODES_EMPTY_RESTRICTION';
    end if;
    if exists (
      select 1 from unnest(v_modes) as m
      where not exists (
        select 1 from public.restaurant_sale_modes rsm
        where rsm.restaurant_id = v_restaurant_id and rsm.mode_code = m and rsm.enabled = true
      )
    ) then
      raise exception using errcode = '22023', message = 'SCANYM_INVALID_SALE_MODE_FOR_ESTABLISHMENT';
    end if;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from v_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  update public.menu_items
  set name                     = v_name,
      description               = v_description,
      price                     = round(p_price, 2),
      short_description         = v_short_description,
      tax_rate                  = p_tax_rate,
      unit_weight_grams         = p_unit_weight_grams,
      weight_is_approximate     = p_weight_is_approximate,
      subcategory_id            = p_subcategory_id,
      withdrawal_eligible       = p_withdrawal_eligible
  where id = p_product_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;

  -- Remplacement intégral et idempotent des restrictions -- jamais un
  -- delta partiel. NULL/pas de restriction => aucune ligne (ALL).
  delete from public.menu_item_sale_modes where menu_item_id = p_product_id;
  if v_has_restriction then
    insert into public.menu_item_sale_modes (menu_item_id, mode_code)
    select p_product_id, m from unnest(v_modes) as m;
  end if;
end $$;

revoke all on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean, text[]) from public, anon;
grant execute on function public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean, text[]) to authenticated;

-- ------------------------------------------------------------------
-- E. get_merchant_catalogue — même signature, une colonne de plus
--    (allowed_sale_modes, NULL = ALL -- array_agg sur ensemble vide
--    est NULL par construction Postgres, sémantique gratuite, aucun
--    CASE nécessaire).
-- ------------------------------------------------------------------

drop function public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id                 uuid,
  category_id                uuid,
  category_name               text,
  category_name_hash          text,
  category_translations       jsonb,
  category_display_order      integer,
  category_is_option_source   boolean,
  category_description        text,
  category_description_hash   text,
  subcategory_id               uuid,
  subcategory_name             text,
  subcategory_display_order    integer,
  name                        text,
  name_hash                   text,
  short_description            text,
  short_description_hash       text,
  description                  text,
  description_hash             text,
  translations                 jsonb,
  price                        numeric,
  is_available                 boolean,
  archived_at                  timestamptz,
  display_order                integer,
  is_option_source             boolean,
  image_url                    text,
  tax_rate                     numeric,
  unit_weight_grams            integer,
  weight_is_approximate        boolean,
  reference_price_per_kg       numeric,
  withdrawal_eligible          boolean,
  allowed_sale_modes           text[]
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
  with groups as (
    select ms.category_id as category_id, ms.id as subcategory_id,
           ms.name::text as subcategory_name, ms.display_order as subcategory_display_order
    from public.menu_subcategories ms
    join public.menu_categories mc2 on mc2.id = ms.category_id
    where mc2.restaurant_id = p_restaurant_id
    union all
    select mc2.id as category_id, null::uuid as subcategory_id,
           null::text as subcategory_name, null::integer as subcategory_display_order
    from public.menu_categories mc2
    where mc2.restaurant_id = p_restaurant_id
  )
  select mi.id, mc.id, mc.name::text, mc.name_hash, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mc.description, mc.description_hash,
         g.subcategory_id, g.subcategory_name, g.subcategory_display_order,
         mi.name::text, mi.name_hash, mi.short_description, mi.short_description_hash,
         mi.description, mi.description_hash, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         ),
         mi.image_url,
         mi.tax_rate, mi.unit_weight_grams, mi.weight_is_approximate, mi.reference_price_per_kg,
         mi.withdrawal_eligible,
         (
           select array_agg(mism.mode_code order by mism.mode_code)
           from public.menu_item_sale_modes mism
           where mism.menu_item_id = mi.id
         )
  from public.menu_categories mc
  join groups g on g.category_id = mc.id
  left join public.menu_items mi
    on mi.category_id = mc.id
    and mi.subcategory_id is not distinct from g.subcategory_id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mc.name,
           case when g.subcategory_id is null then 0 else 1 end,
           g.subcategory_display_order nulls last, g.subcategory_name nulls last,
           mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------
-- F. create_order — CREATE OR REPLACE (signature INCHANGÉE, corps
--    repris À L'IDENTIQUE de DRAFT-lot-delivery-country-scope-v1.sql,
--    baseline actuelle vérifiée par traçage de commit -- SEUL
--    changement : (1) une vérification par ligne, juste après la
--    résolution de l'option et AVANT l'insert dans order_items,
--    utilisant EXACTEMENT le patron déjà en place pour le check
--    établissement (v_mode_enabled, plus haut dans cette même
--    fonction) ; (2) la colonne service_mode_eligible_at_order_time
--    ajoutée à l'insert. Aucune autre ligne touchée -- idempotence,
--    tarification livraison, CGV/rétractation, tout le reste est
--    repris mot pour mot.
-- ------------------------------------------------------------------

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null,
  p_cgv_accepted  boolean default false
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
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

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

-- ------------------------------------------------------------------
-- G. VÉRIFICATION POST-APPLICATION — toujours AVANT commit.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'menu_item_sale_modes'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: public.menu_item_sale_modes absente.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'service_mode_eligible_at_order_time' and is_nullable = 'YES'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: order_items.service_mode_eligible_at_order_time absente ou NOT NULL (l''historique doit rester NULL).';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid) like '%p_allowed_sale_modes%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: create_product ne porte pas p_allowed_sale_modes.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_product'
      and pg_get_function_identity_arguments(p.oid) like '%p_allowed_sale_modes%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_product ne porte pas p_allowed_sale_modes.';
  end if;
end $$;

-- ============================================================
-- IDEMPOTENCE DE CE FICHIER
--
-- Ce fichier est un DRAFT, jamais installé automatiquement plus d'une
-- fois (même convention que tous les fichiers DRAFT-lot-*.sql de ce
-- dépôt : réécrit sur place si correction nécessaire avant
-- installation, jamais ré-exécuté tel quel après installation).
-- "create or replace function" (create_order) est ré-exécutable sans
-- erreur ; "create table"/"drop function ... create function" ne le
-- sont pas -- section 0 (anti-dérive) refuse explicitement une double
-- application de ce fichier précis.
-- ============================================================
