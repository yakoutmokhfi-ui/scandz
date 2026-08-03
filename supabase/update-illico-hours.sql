-- ============================================================
-- Illico Presto — horaires en format neutre
--
-- Les horaires étaient stockés en français ("Tous les jours :
-- 07:00 – 23:00") et restaient donc en français quand le client
-- choisissait l'arabe ou l'anglais.
--
-- On ne conserve désormais que les heures : l'application ajoute
-- elle-même le libellé "Tous les jours" / "Every day" / "كل الأيام"
-- dans la langue choisie.
--
-- ⚠️ Horaires à confirmer par le gérant (07:00 – 23:00 provient de
-- la maquette).
-- ============================================================

update restaurant_configs
set opening_hours = '07:00 – 23:00'
where restaurant_id = (select id from restaurants where slug = 'illico-presto');
