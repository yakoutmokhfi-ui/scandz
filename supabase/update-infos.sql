-- ============================================================
-- ScanDZ — Coordonnées affichées (adresse + horaires)
-- À exécuter après seed-illico-v2.sql (avant ou après
-- update-photos.sql, indifférent).
--
-- ⚠️ VALEURS DE DÉMO fournies par le CTO le 25/07/2026 :
-- l'adresse provient de la maquette et les horaires restent à
-- confirmer par le gérant. À corriger par simple UPDATE avant
-- la mise en service réelle.
-- ============================================================

update restaurant_configs
set address = '4 Rue Ferroukhi Mustapha, Oran 31000, Algérie',
    opening_hours = 'Tous les jours : 07:00 – 23:00'
where restaurant_id = (select id from restaurants where slug = 'illico-presto');
