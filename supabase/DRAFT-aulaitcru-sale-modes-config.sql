-- ============================================================
-- DRAFT SQL — AU LAIT CRU — CLICK & COLLECT ONLY (v2, corrige ALC-SM-04)
-- (SCANYM — AU LAIT CRU — CASE 1A / ALC-SM-04 — CLICK & COLLECT SQL HARDENING)
-- ============================================================
-- STATUT : BROUILLON NON EXÉCUTÉ. Ce fichier N'A JAMAIS été exécuté
-- contre Supabase (aucun accès Production dans cette session). Il ne
-- fait PAS partie de la chaîne de migrations numérotée
-- (supabase/migration-vXX-*.sql) -- volontairement nommé "DRAFT-..."
-- pour ne jamais être confondu avec une migration appliquée. Il ne
-- doit être exécuté qu'après audit indépendant par "Work" puis
-- autorisation explicite du CIO (GO).
--
-- CORRIGE ALC-SM-04 (audit Work, HIGH, mission "AU LAIT CRU — CASE 1A
-- / SALE MODES HARDENING + CLICK & COLLECT ONLY / CORRECTION
-- ALC-SM-01/02/03" -- verdict `STOP — AU LAIT CRU CLICK & COLLECT
-- AUDIT FINDING`). REMPLACE la version précédente (livrée avec le
-- package CASE 1A) qui, bien que déjà scope-restreinte à
-- pickup/table (sans aucune trace de delivery, Stuart, Chronofresh),
-- présentait 4 lacunes fail-closed identifiées par l'audit :
--
--   1. tenant absent -> l'ancienne version se contentait d'un
--      `raise notice` et terminait SANS ERREUR (script "silencieusement
--      sans effet" plutôt qu'un échec explicite) ;
--   2. slug dupliqué -> l'ancienne version bouclait
--      (`for r in select id from ... loop`) et aurait modifié TOUS les
--      tenants correspondants si le slug 'au-lait-cru' avait été
--      dupliqué par erreur, au lieu de refuser une résolution ambiguë ;
--   3. delivery préexistant -> l'ancienne version s'interdisait
--      explicitement de toucher une éventuelle ligne 'delivery'
--      préexistante, la laissant ACTIVE si elle existait déjà --
--      incompatible avec la cible CLICK & COLLECT ONLY, qui exige
--      delivery INACTIF, pas seulement "jamais activé par ce script" ;
--   4. aucun test SQL -- seules des requêtes SELECT de vérification
--      manuelle étaient fournies, aucun harnais reproductible.
--
-- Les 4 points sont corrigés ci-dessous (voir chaque section). Le
-- harnais SQL dédié (supabase/tests/alc-sm-04-check.sh) couvre les 5
-- scénarios exigés par l'audit : tenant absent, slug dupliqué,
-- delivery préexistant actif, réexécution (idempotence), et un tenant
-- témoin non affecté.
--
-- RÈGLE ABSOLUE DE CE LOT (ALC-SM-04 ONLY) : uniquement ce fichier
-- (et son harnais de test dédié) sont modifiés. Aucun runtime déjà
-- audité (usePublicSaleModes, MenuView, CartPanel, i18n) n'est
-- retouché -- aucune nécessité démontrée de le faire, la correction
-- ALC-SM-04 est strictement un renforcement SQL. Aucun autre finding
-- n'est traité ici. Aucun delivery réel, aucun Stuart, aucun
-- Chronofresh, aucune Production, aucun Git distant, aucun Vercel.
--
-- OBJET : pour l'établissement "au-lait-cru" UNIQUEMENT, résolu de
-- manière NON AMBIGUË (exactement 1 ligne, jamais 0, jamais >1) --
--   1. retire le mode 'table' (ligne + éventuelle surcharge de champs
--      requis tenant-scopées) ;
--   2. retire EXPLICITEMENT le mode 'delivery' (ligne + éventuelle
--      surcharge de champs requis tenant-scopées) -- NOUVEAU en v2 :
--      contrairement à la version précédente, une ligne 'delivery'
--      préexistante est désormais activement supprimée, jamais
--      laissée active ;
--   3. active le mode 'pickup' ("Click & Collect" / "Retrait en
--      boutique" -- réutilise le code de mode déjà connu du frontend,
--      jamais le code dormant 'click_collect') ;
--   4. normalise DÉTERMINISTE les champs requis 'pickup' pour ce
--      tenant (surcharge explicite désormais posée par ce script,
--      plutôt qu'un repli implicite sur le catalogue -- voir section
--      dédiée ci-dessous) -- toute surcharge 'pickup' incompatible
--      préexistante est remplacée, jamais laissée en l'état.
--
-- Aucun autre établissement n'est touché (illico-presto,
-- sanaa-cookies, le-sirocco restent strictement inchangés -- prouvé
-- par le harnais, scénario "E. autre tenant"). Aucune modification du
-- catalogue global (sale_mode_catalog, sale_mode_field_requirements).
--
-- Réutilise le patron déjà audité et en production du backfill LOT 2A
-- (voir supabase/migration-v82-lot2a-sale-modes.sql, section 2e) pour
-- le retrait de mode (DELETE tenant-scopé, jamais une désactivation
-- via une colonne 'enabled' qui n'existe d'ailleurs pas dans ce sens
-- pour la suppression complète d'un mode -- le pattern canonique du
-- schéma pour "ce mode n'existe plus pour ce tenant" est bien un
-- DELETE de la ligne restaurant_sale_modes, jamais un simple
-- enabled=false, qui laisserait une ligne fantôme) -- même table,
-- aucune nouvelle table ni colonne créée par ce script.
--
-- Idempotent (DELETE sans erreur si absent, INSERT ... ON CONFLICT DO
-- UPDATE, réexécution prouvée produire un état final identique --
-- scénario "D. réexécution" du harnais), ciblé tenant (uniquement le
-- restaurant_id résolu explicitement pour slug = 'au-lait-cru'),
-- fail-closed (résolution tenant en échec = exception + rollback,
-- aucune mutation partielle possible -- voir section 1 ci-dessous),
-- sans secret, sans identifiant, sans référence
-- Stuart/Chronofresh/shipping/zone/minimum/label de livraison.
-- ============================================================

do $$
declare
  v_tenant_count   integer;
  v_restaurant_id  uuid;
begin
  -- ------------------------------------------------------------
  -- 1. RÉSOLUTION TENANT FAIL-CLOSED (corrige ALC-SM-04, points 1 et 2)
  --
  -- Exige COUNT(*) = 1 sur le tenant ciblé, AVANT toute mutation :
  --   - 0 tenant trouvé  -> RAISE EXCEPTION (jamais un simple NOTICE) ;
  --   - >1 tenant trouvé -> RAISE EXCEPTION (jamais une boucle qui
  --     modifierait tous les tenants correspondants -- résolution
  --     ambiguë = refus, pas une meilleure estimation).
  --
  -- Une exception non interceptée dans un bloc PL/pgSQL annule TOUT
  -- le bloc de façon atomique (comportement standard PL/pgSQL/Postgres
  -- pour une exception non gérée) -- mais ici, le contrôle est de
  -- toute façon placé AVANT la moindre instruction de mutation :
  -- aucune ligne n'est jamais touchée dans les cas 0/>1, qu'il y ait
  -- ou non un rollback à faire. Aucune boucle sur plusieurs tenants
  -- nulle part dans ce script : `v_restaurant_id` est un uuid unique,
  -- résolu une seule fois, explicitement.
  -- ------------------------------------------------------------
  select count(*) into v_tenant_count
  from public.restaurants
  where slug = 'au-lait-cru';

  if v_tenant_count = 0 then
    raise exception 'SCANYM_ALC_TENANT_NOT_FOUND: aucun restaurant avec slug = ''au-lait-cru'' -- script annulé, aucune mutation appliquée. Vérifier le slug réel avant réexécution.';
  elsif v_tenant_count > 1 then
    raise exception 'SCANYM_ALC_TENANT_AMBIGUOUS: % restaurants trouvés avec slug = ''au-lait-cru'' -- résolution ambiguë, script annulé, aucune mutation appliquée. Corriger la duplication de slug avant réexécution.', v_tenant_count;
  end if;

  select id into v_restaurant_id
  from public.restaurants
  where slug = 'au-lait-cru';

  -- ------------------------------------------------------------
  -- 2. RETRAIT DU MODE 'table' -- ligne + toute surcharge de champs
  -- requis tenant-scopée pour ce mode (nettoyage : évite une ligne
  -- restaurant_sale_mode_field_requirements orpheline référençant un
  -- mode retiré). Uniquement pour v_restaurant_id. Sans effet si
  -- aucune ligne n'existe déjà (idempotent).
  -- ------------------------------------------------------------
  delete from public.restaurant_sale_modes
  where restaurant_id = v_restaurant_id and mode_code = 'table';

  delete from public.restaurant_sale_mode_field_requirements
  where restaurant_id = v_restaurant_id and mode_code = 'table';

  -- ------------------------------------------------------------
  -- 3. RETRAIT EXPLICITE DU MODE 'delivery' -- corrige ALC-SM-04,
  -- point 3. Contrairement à la version précédente de ce script (qui
  -- s'interdisait explicitement d'y toucher), une ligne 'delivery'
  -- préexistante -- active ou non -- est désormais activement
  -- supprimée pour ce tenant : la cible CLICK & COLLECT ONLY exige
  -- delivery INACTIF pour Au Lait Cru, pas seulement "non activé par
  -- ce script". Même pattern DELETE tenant-scopé que pour 'table'
  -- ci-dessus. AUCUNE configuration fonctionnelle de livraison
  -- (zones, minimum, label, provider Stuart/Chronofresh) n'est créée
  -- ni lue ici -- ce bloc ne fait que RETIRER une éventuelle ligne
  -- existante, jamais en créer une. Le gap architectural livraison
  -- réfrigérée reste ouvert et hors scope (voir RAPPORT.md).
  -- ------------------------------------------------------------
  delete from public.restaurant_sale_modes
  where restaurant_id = v_restaurant_id and mode_code = 'delivery';

  delete from public.restaurant_sale_mode_field_requirements
  where restaurant_id = v_restaurant_id and mode_code = 'delivery';

  -- ------------------------------------------------------------
  -- 4. ACTIVATION DE 'pickup' ("Click & Collect" / "Retrait en
  -- boutique") -- mode_code 'pickup', provider 'internal' (retrait
  -- interne, aucun transporteur tiers). Idempotent (ON CONFLICT DO
  -- UPDATE) : une réexécution ne duplique jamais la ligne, ne fait que
  -- réaffirmer le même état cible.
  -- ------------------------------------------------------------
  insert into public.restaurant_sale_modes
    (restaurant_id, mode_code, enabled, display_order, provider)
  values
    (v_restaurant_id, 'pickup', true, 1, 'internal')
  on conflict (restaurant_id, mode_code) do update
    set enabled = true, display_order = 1, provider = 'internal';

  -- ------------------------------------------------------------
  -- 5. CHAMPS REQUIS 'pickup' -- NORMALISATION DÉTERMINISTE (corrige
  -- ALC-SM-04, section 4 de la mission).
  --
  -- La version précédente de ce script ne posait AUCUNE surcharge
  -- pour 'pickup' (les valeurs catalogue par défaut -- customer_name
  -- required, phone/email one_of groupe 'contact' -- correspondaient
  -- déjà exactement à la cible). Ce raisonnement reste VRAI
  -- aujourd'hui (voir supabase/migration-v82-lot2a-sale-modes.sql,
  -- section 2c), mais n'est plus suffisant pour une idempotence
  -- DÉMONTRÉE sur les requirements eux-mêmes : si une surcharge
  -- 'pickup' incompatible existait déjà pour ce tenant (ex. héritée
  -- d'une configuration antérieure erronée, ou d'un test manuel), le
  -- repli implicite sur le catalogue ne l'aurait jamais corrigée --
  -- une ligne restaurant_sale_mode_field_requirements existante
  -- REMPLACE ENTIÈREMENT la règle catalogue pour ce champ (voir
  -- commentaire de la table, migration-v82, section 2c-bis).
  --
  -- Ce script pose donc désormais une surcharge EXPLICITE et
  -- déterministe pour 'pickup' : purge de toute ligne existante pour
  -- (v_restaurant_id, 'pickup'), puis réinsertion des 3 règles cible
  -- (identiques aux valeurs catalogue actuelles -- aucune divergence
  -- métier introduite, seulement une garantie d'idempotence/normalisation
  -- explicite, qui ne dépend plus d'un état catalogue non modifié par
  -- ailleurs). Idempotent par construction (delete-puis-insert produit
  -- le même résultat à chaque exécution).
  -- ------------------------------------------------------------
  delete from public.restaurant_sale_mode_field_requirements
  where restaurant_id = v_restaurant_id and mode_code = 'pickup';

  insert into public.restaurant_sale_mode_field_requirements
    (restaurant_id, mode_code, field, requirement, one_of_group, display_order)
  values
    (v_restaurant_id, 'pickup', 'customer_name', 'required', null, 1),
    (v_restaurant_id, 'pickup', 'phone',         'one_of',   'contact', 2),
    (v_restaurant_id, 'pickup', 'email',         'one_of',   'contact', 3);
end $$;

-- ============================================================
-- VÉRIFICATION MANUELLE SUGGÉRÉE APRÈS EXÉCUTION (hors périmètre de
-- ce script, à faire par Work/CIO après GO -- couverte automatiquement
-- par supabase/tests/alc-sm-04-check.sh, assertions post-condition) :
--
--   select mode_code, enabled, display_order, provider, config
--   from public.restaurant_sale_modes rsm
--   join public.restaurants r on r.id = rsm.restaurant_id
--   where r.slug = 'au-lait-cru'
--   order by display_order;
--
-- Résultat attendu : EXACTEMENT 1 ligne ('pickup', enabled=true),
-- aucune ligne 'table', aucune ligne 'delivery' -- y compris si une
-- ligne 'delivery' active préexistait avant exécution de ce script.
--
--   select mode_code, field, requirement, one_of_group, display_order
--   from public.restaurant_sale_mode_field_requirements rsmfr
--   join public.restaurants r on r.id = rsmfr.restaurant_id
--   where r.slug = 'au-lait-cru'
--   order by mode_code, display_order;
--
-- Résultat attendu : EXACTEMENT 3 lignes, toutes mode_code='pickup' :
-- customer_name/required, phone/one_of('contact'), email/one_of('contact').
-- Aucune ligne 'table' ni 'delivery' (nettoyées par ce script).
--
--   select count(*) from public.restaurants where slug = 'au-lait-cru';
--
-- Résultat attendu avant toute exécution : EXACTEMENT 1 -- si ce
-- n'est pas le cas, NE PAS exécuter ce script (il refusera de toute
-- façon, voir section 1 ci-dessus, mais une vérification manuelle
-- préalable reste recommandée).
-- ============================================================
