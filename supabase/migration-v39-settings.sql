-- ============================================================
-- Scanym V39 — Paramètres de l'établissement
--
-- ⚠️ MODIFICATION DE SCHÉMA — validation CTO obtenue.
-- Additive et idempotente.
--
-- Périmètre volontairement restreint :
--   • langue du ticket destiné au personnel ;
--   • adresse et horaires, déjà stockés en base.
--
-- HORS PÉRIMÈTRE : le nombre de tables. Le réduire invaliderait
-- des QR codes imprimés et orphelinerait des commandes existantes.
-- À traiter dans un futur module Tables et QR codes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Langue du ticket
--
-- Indépendante de la langue choisie par le client sur le menu :
-- c'est le personnel qui lit le ticket, et les noms de produits
-- doivent correspondre à la carte en cuisine.
-- ------------------------------------------------------------
alter table public.restaurant_configs
  add column if not exists staff_receipt_language text not null default 'fr';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurant_configs_staff_language_check'
  ) then
    alter table public.restaurant_configs
      add constraint restaurant_configs_staff_language_check
      check (staff_receipt_language in ('fr', 'en', 'ar'));
  end if;
end $$;

-- Reprise des valeurs actuellement codées dans l'application,
-- uniquement si la colonne est encore à sa valeur par défaut.
update public.restaurant_configs c
set staff_receipt_language = 'ar'
from public.restaurants r
where r.id = c.restaurant_id
  and r.slug = 'illico-presto'
  and c.staff_receipt_language = 'fr';

-- ------------------------------------------------------------
-- 2. Mise à jour des paramètres
--
-- Réservée à owner et manager. Aucun droit d'UPDATE direct n'est
-- accordé sur restaurant_configs : tout passe par cette fonction.
-- ------------------------------------------------------------
create or replace function public.update_restaurant_settings(
  p_restaurant_id   uuid,
  p_staff_language  text,
  p_address         text default null,
  p_opening_hours   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  if p_staff_language is null or p_staff_language not in ('fr', 'en', 'ar') then
    raise exception using errcode = '22023', message = 'Invalid language';
  end if;
  if p_address is not null and length(p_address) > 300 then
    raise exception using errcode = '22023', message = 'Address too long';
  end if;
  if p_opening_hours is not null and length(p_opening_hours) > 120 then
    raise exception using errcode = '22023', message = 'Opening hours too long';
  end if;

  update public.restaurant_configs
  set staff_receipt_language = p_staff_language,
      address       = nullif(trim(coalesce(p_address, '')), ''),
      opening_hours = nullif(trim(coalesce(p_opening_hours, '')), '')
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke insert, update, delete on table public.restaurant_configs from anon, authenticated;
revoke all on function public.update_restaurant_settings(uuid, text, text, text) from public, anon;
grant execute on function public.update_restaurant_settings(uuid, text, text, text)
  to authenticated;

-- ============================================================
-- TESTS EXÉCUTÉS — PostgreSQL 16, chaîne migratoire complète
--
--  ✗ staff modifie les réglages          → Not authorized
--  ✓ owner change la langue du ticket, l'adresse et les horaires
--  ✗ langue invalide ('de')              → Invalid language
--  ✗ owner Illico modifie Sanaa          → Not authorized
--  ✗ UPDATE direct sur restaurant_configs → permission denied
--  ✗ appel anonyme                       → permission denied
--  ✓ reprise des valeurs existantes : Illico en 'ar'
--  ✓ migration rejouée deux fois : 0 erreur
-- ============================================================
