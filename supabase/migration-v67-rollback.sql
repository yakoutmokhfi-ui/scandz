-- ============================================================
-- Scanym V67 — Rollback (photo produit)
--
-- À exécuter manuellement par le CIO si besoin de revenir en arrière
-- après une V67 déjà appliquée. NE PAS EXÉCUTER AUTOMATIQUEMENT.
--
-- Comportement NON destructif par défaut : les photos déjà uploadées
-- restent dans le bucket Storage et menu_items.image_url garde sa
-- valeur actuelle (une chaîne d'URL, colonne déjà présente avant V67)
-- — seules les RPC/policies introduites par V67 sont retirées. Voir
-- section destructive optionnelle en bas de fichier (jamais exécutée
-- automatiquement).
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature get_merchant_catalogue(uuid,boolean) introuvable — rollback V67 annulé.';
  end if;
end $$;

begin;

-- Retour de get_merchant_catalogue à la forme V66 (sans image_url).
drop function if exists public.get_merchant_catalogue(uuid, boolean);

create function public.get_merchant_catalogue(
  p_restaurant_id uuid,
  p_archived      boolean default false
)
returns table (
  product_id              uuid,
  category_id             uuid,
  category_name           text,
  category_translations   jsonb,
  category_display_order  integer,
  category_is_option_source boolean,
  name                    text,
  short_description       text,
  description             text,
  translations            jsonb,
  price                   numeric,
  is_available            boolean,
  archived_at             timestamptz,
  display_order           integer,
  is_option_source        boolean
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
  select mi.id, mc.id, mc.name::text, mc.translations,
         mc.display_order,
         exists (
           select 1 from public.menu_items opt_parent
           where opt_parent.option_source_category_id = mc.id
             and opt_parent.archived_at is null
         ),
         mi.name::text, mi.short_description, mi.description, mi.translations,
         mi.price, mi.is_available, mi.archived_at, mi.display_order,
         (
           mi.id is not null and exists (
             select 1 from public.menu_items parent
             where parent.option_source_category_id = mc.id
               and parent.archived_at is null
           )
         )
  from public.menu_categories mc
  left join public.menu_items mi
    on mi.category_id = mc.id
    and (case when p_archived then mi.archived_at is not null
              else mi.archived_at is null end)
  where mc.restaurant_id = p_restaurant_id
  order by mc.display_order, mi.display_order nulls last, mi.name nulls last;
end $$;

revoke all on function public.get_merchant_catalogue(uuid, boolean) from public, anon;
grant execute on function public.get_merchant_catalogue(uuid, boolean) to authenticated;

drop function if exists public.set_product_photo(uuid, text);

drop policy if exists "product_photos_select_own_restaurant" on storage.objects;
drop policy if exists "product_photos_insert_own_restaurant" on storage.objects;
drop policy if exists "product_photos_update_own_restaurant" on storage.objects;
drop policy if exists "product_photos_delete_own_restaurant" on storage.objects;

-- Le bucket lui-même N'EST PAS supprimé ici : storage.buckets ne peut
-- être supprimé tant qu'il contient des objets (delete from
-- storage.buckets échoue avec des fichiers présents), et le supprimer
-- romprait immédiatement toutes les URL déjà affichées sur le menu
-- public de chaque établissement l'ayant utilisé. Décision explicite
-- non destructive.

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_catalogue'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid, p_archived boolean'
  ) then
    raise exception using errcode = 'P0001', message = 'SCANYM_ROLLBACK_INCOMPLETE';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_product_photo'
  ) then
    raise exception using errcode = 'P0001', message = 'SCANYM_ROLLBACK_INCOMPLETE';
  end if;
end $$;

commit;

-- ============================================================
-- Suppression DESTRUCTIVE optionnelle du bucket et de tout son
-- contenu (photos de TOUS les établissements) — jamais exécutée
-- automatiquement, décision produit à part entière :
--
--   delete from storage.objects where bucket_id = 'product-photos';
--   delete from storage.buckets where id = 'product-photos';
--
-- Retour arrière du CODE (frontend) : ce fichier ne couvre que la
-- base de données / Storage. Utiliser `git revert` du commit V67 ou
-- l'application inverse du patch fourni — jamais une restauration
-- manuelle fichier par fichier.
-- ============================================================
