-- ============================================================
-- Sanaa — texte de la fiche établissement
-- Nouvelle zone : toute l'Île-de-France, livraison offerte dès
-- 10 gâteaux.
-- ============================================================

update restaurant_configs
set address = 'Retrait sur place · Livraison offerte dès 10 gâteaux dans toute l''Île-de-France'
where restaurant_id = (select id from restaurants where slug = 'sanaa-cookies');
