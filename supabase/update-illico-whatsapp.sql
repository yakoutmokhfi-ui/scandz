-- ============================================================
-- Illico Presto — bascule du WhatsApp vers le numéro algérien
--
-- Remplace le numéro de test français (+33 6 63 60 28 03) par le
-- numéro du restaurant à Oran, confirmé par Yakout : +213 666 51 09 01.
--
-- ⚠️ APRÈS EXÉCUTION : passer une commande de test depuis
-- /r/illico-presto et vérifier qu'elle arrive bien sur ce numéro,
-- AVANT toute impression ou réimpression de QR code.
-- ============================================================

update restaurant_configs
set whatsapp_number = '+213666510901'
where restaurant_id = (select id from restaurants where slug = 'illico-presto');

-- Vérification
select r.name, c.whatsapp_number
from restaurant_configs c
join restaurants r on r.id = c.restaurant_id
where r.slug = 'illico-presto';
