-- ============================================================
-- Scanym — STOREFRONT PHOTO OVERLAY — DONNÉE Au Lait Cru
-- (DRAFT — NOT APPLIED — AUCUNE EXÉCUTION HÉBERGÉE — GO DISTINCT REQUIS)
--
-- Réglage souhaité pour Au Lait Cru : 'none'. C'est une DONNÉE
-- marchand, pas du code : le code de l'application reste générique et
-- ne nomme aucun marchand. Alternative équivalente, sans SQL : le
-- marchand (ou un opérateur) choisit « Aucun assombrissement » dans
-- Réglages > Assombrissement de la photo de couverture.
--
-- PRÉREQUIS : DRAFT-lot-storefront-photo-overlay-v1.sql appliqué.
-- Modifie UNE seule ligne (celle du slug 'au-lait-cru') ; annule tout
-- si le slug ne désigne pas exactement une ligne de configuration.
-- Retour arrière : remettre 'standard' (même requête, autre valeur).
-- ============================================================

begin;

do $$
declare
  v_count bigint;
begin
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'storefront_photo_overlay' and not a.attisdropped
  ) then
    raise exception 'SCANYM_DATA_PREREQ: colonne storefront_photo_overlay absente -- appliquer d''abord le lot. Annulé.';
  end if;

  with updated as (
    update public.restaurant_configs c
    set storefront_photo_overlay = 'none'
    from public.restaurants r
    where r.id = c.restaurant_id and r.slug = 'au-lait-cru'
    returning 1
  )
  select count(*) into v_count from updated;

  if v_count <> 1 then
    raise exception 'SCANYM_DATA_GUARD: % ligne(s) mise(s) à jour pour le slug au-lait-cru, 1 attendue -- annulé.', v_count;
  end if;
end $$;

commit;
