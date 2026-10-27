-- ============================================================
-- Scanym — ORDER NOTE TOGGLE v1 (UX LOT 2026-10, demande Emmanuel)
-- (DRAFT — NON APPLIQUÉ — AUCUNE EXÉCUTION HÉBERGÉE dans ce lot :
--  à appliquer UNIQUEMENT sur décision explicite, après revue de la PR.)
--
-- BESOIN : « Pour Au Lait Cru seulement, supprimer la note destinée au
-- restaurant » SANS introduire le nom d'un marchand dans une logique
-- générique. Le champ « Note pour le restaurant » du checkout devient
-- donc une CONFIGURATION PAR ÉTABLISSEMENT, portée par
-- restaurant_configs comme les autres réglages de vitrine (couleurs,
-- display_name, theme_tokens…), lue par la vitrine via le même
-- `restaurant_configs ( * )` (aucun nouveau RPC de lecture, aucune
-- nouvelle policy : même RLS, même isolation par restaurant_id).
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--   A. UNE colonne additive : restaurant_configs.order_note_enabled
--      boolean NOT NULL DEFAULT true. true = champ affiché (comportement
--      historique, tous les établissements existants) ; false = champ
--      non rendu, note jamais transmise (components/CartPanel.tsx,
--      components/MenuView.tsx).
--   B. AUCUN RPC d'écriture dans ce lot (voir « LIMITE »).
--
-- CE QUE CE LOT NE FAIT PAS : ne touche ni create_order (p_note reste
-- accepté : un appel direct avec une note reste valide), ni la colonne
-- orders.note, ni aucune commande existante.
--
-- LIMITE ASSUMÉE : pas d'interface back-office pour ce réglage dans ce
-- lot -- la bascule se fait par l'opérateur (section C ci-dessous).
-- Un RPC update_restaurant_order_note_enabled(uuid, boolean) sur le
-- modèle de update_restaurant_theme_tokens (même assert_restaurant_
-- asset_role) est le prolongement naturel si le commerçant doit pouvoir
-- la changer lui-même.
--
-- ROLLBACK : alter table public.restaurant_configs
--              drop column order_note_enabled;
-- ============================================================

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_configs'
      and column_name = 'order_note_enabled'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: restaurant_configs.order_note_enabled existe déjà -- ORDER NOTE TOGGLE v1 annulé.';
  end if;
end $$;

-- A. Colonne additive, vraie par défaut : aucun établissement existant
--    ne change de comportement.
alter table public.restaurant_configs
  add column order_note_enabled boolean not null default true;

comment on column public.restaurant_configs.order_note_enabled is
  'ORDER NOTE TOGGLE v1 — champ « Note pour le restaurant » du checkout. true (défaut) = affiché ; false = non rendu et note jamais transmise par la vitrine. Réglage PAR ÉTABLISSEMENT, jamais un nom de marchand codé en dur.';

commit;

-- ============================================================
-- C. OPÉRATION DE DONNÉES SÉPARÉE (à exécuter À PART, après revue, par
--    l'opérateur) -- désactive le champ pour UN établissement, identifié
--    par son slug, SANS que ce slug n'apparaisse nulle part dans le code
--    applicatif :
--
--    update public.restaurant_configs c
--       set order_note_enabled = false
--      from public.restaurants r
--     where r.id = c.restaurant_id
--       and r.slug = 'au-lait-cru';
--    -- attendu : UPDATE 1
--
--    Retour : même ordre avec `= true`.
-- ============================================================
