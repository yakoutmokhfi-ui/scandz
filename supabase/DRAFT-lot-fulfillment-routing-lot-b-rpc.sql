-- ============================================================
-- Scanym — FULFILLMENT ROUTING LOT B (DRAFT — NON APPLIQUÉ EN
-- PRODUCTION) — RPC additive + résolveur interne + rien d'autre.
--
-- ⚠️ CORRIGÉ EN LOT B.1 (audit Work) : ferme FRB-B-01 (HIGH — le
-- résolveur interne n'appliquait pas min_items et divergeait du
-- frontend sur le traitement d'un code postal invalide/absent) et
-- FRB-B-02 (MEDIUM — absence de preuve auditable que SQL et frontend
-- appliquent le même contrat). Voir le bloc de commentaire du
-- résolveur ci-dessous (section 1) pour le contrat de résolution
-- complet, et tests/fixtures/fulfillment-routing-cases.json pour la
-- preuve cas par cas. Cette correction ne touche STRICTEMENT rien
-- d'autre : même portée, mêmes exclusions (aucun runtime switch,
-- aucune activation tenant, aucun appel Stuart/Chronofresh) que la
-- version Lot B initiale — voir RAPPORT-FULFILLMENT-ROUTING-LOT-B1.md.
--
-- Prolonge directement LOT A / A.1
-- (supabase/DRAFT-lot-fulfillment-routing-model.sql, déjà mergé sur
-- main) — objet : introduire les DEUX pièces serveur nécessaires
-- (§4/§5/§9/§15 de RAPPORT-FULFILLMENT-ROUTING-DESIGN.md), et
-- STRICTEMENT rien de plus :
--
--   1. Fonction interne PARTAGÉE de résolution
--      public.resolve_delivery_fulfillment(restaurant_id, mode_code,
--      postal_code) -- réplique l'algorithme déterministe du §4 :
--      règles non-fallback triées par display_order, premier préfixe
--      qui matche = résultat ; sinon la règle fallback (au plus une) ;
--      sinon aucune ligne (mode non éligible pour cette adresse). Un
--      SEUL endroit où cet algorithme est écrit côté serveur --
--      jamais dupliqué. Patron IDENTIQUE à
--      effective_sale_mode_field_requirements (LOT 2A) : SECURITY
--      DEFINER, SET search_path = '', REVOQUÉE de tout accès direct
--      (public/anon/authenticated) -- AUCUN appelant ne l'invoque
--      encore dans ce lot (son futur appelant, create_order, est
--      LOT D, hors périmètre ici). Elle est prouvée par le harnais
--      SQL jetable de ce lot en l'appelant directement (connexion
--      propriétaire), exactement comme
--      effective_sale_mode_field_requirements l'a été en LOT 2A avant
--      d'avoir un premier appelant réel.
--
--   2. RPC PUBLIQUE additive
--      public.get_restaurant_public_delivery_fulfillments(restaurant_id)
--      -- projection minimale, une ligne par règle publique :
--      {fulfillment_code, zone_prefixes, is_fallback, min_items,
--      customer_text, display_order}. N'EXPOSE JAMAIS provider ni le
--      JSONB config. Ne prend PAS de code postal : retourne la liste
--      BRUTE des règles actives, laissant la résolution/l'aperçu
--      instantané au frontend (même raisonnement que
--      get_restaurant_public_delivery_info, LOT 2B.1 : la logique de
--      correspondance tourne côté client sans aller-retour réseau par
--      frappe -- voir lib/delivery.ts, resolveDeliveryFulfillment,
--      livré dans ce même lot). Patron de sécurité IDENTIQUE à
--      get_restaurant_public_delivery_info : SECURITY DEFINER, SET
--      search_path = '', REVOKE ALL puis GRANT EXECUTE explicite à
--      anon, authenticated uniquement. Vérifie EXPLICITEMENT les DEUX
--      moitiés de l'invariant documenté dans LOT A
--      (restaurant_sale_mode_fulfillments.enabled ET
--      restaurant_sale_modes.enabled), jamais l'une sans l'autre --
--      c'est exactement le bug que LOT A avait signalé comme piège
--      pour ce futur Lot B.
--
-- PORTÉE STRICTE (mission complète) -- CE LOT NE FAIT PAS :
--   - AUCUN runtime switch : aucun hook (usePublicDeliveryFulfillments
--     reste LOT C, non créé ici), AUCUNE modification de MenuView.tsx
--     ni FulfillmentSelector.tsx ni d'aucun composant. Le frontend
--     gagne uniquement des TYPES et des FONCTIONS PURES/HELPERS
--     additifs (lib/sale-modes-types.ts, lib/delivery.ts,
--     lib/sale-modes-public.ts) -- strictement non appelés par aucun
--     composant, prouvé par test.
--   - AUCUNE activation tenant : ce fichier n'insère STRICTEMENT
--     AUCUNE ligne dans restaurant_sale_mode_fulfillments, ni pour Au
--     Lait Cru, ni pour Sanaa, ni pour aucun établissement -- exactement
--     la même discipline que LOT A. La table reste vide après ce lot.
--   - AUCUN appel Stuart/Chronofresh : `provider` reste une colonne de
--     configuration interne, jamais lue par la RPC publique, et aucun
--     appel réseau vers un prestataire externe n'existe nulle part
--     dans ce lot (ni ici, ni dans le frontend additif).
--   - AUCUNE modification de create_order/orders (LOT D).
--   - AUCUNE modification de restaurant_sale_mode_fulfillments elle-
--     même (colonnes, contraintes, RLS, GRANT/REVOKE de la table) --
--     LOT A reste la source de vérité pour la table, intégralement
--     inchangée par ce fichier.
--
-- Compatibilité : 100% ADDITIF. Ne modifie, ne lit ni n'altère
-- restaurant_sale_modes, restaurant_sale_mode_fulfillments (structure),
-- orders, ni aucune RPC existante. Aucun comportement visible ne
-- change pour un tenant existant (Au Lait Cru, Sanaa, Illico,
-- Sirocco...) : la table restant vide, les deux nouvelles fonctions ne
-- retournent jamais aucune ligne pour aucun tenant réel tant qu'aucune
-- donnée n'y est insérée (Lot E, hors périmètre).
--
-- ⚠️ NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION. Testable uniquement
-- dans le harnais PostgreSQL jetable
-- (supabase/tests/fulfillment-routing-lot-b-check.sh).
-- ============================================================

-- ------------------------------------------------------------------
-- Contrôle préalable (anti-dérive) : le prérequis structurel (LOT A,
-- restaurant_sale_mode_fulfillments) doit déjà exister, et aucune des
-- deux nouvelles fonctions ne doit déjà exister (empêche une double
-- application accidentelle de ce DRAFT).
-- ------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_mode_fulfillments')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_mode_fulfillments introuvable — prérequis LOT A manquant, DRAFT fulfillment routing Lot B annulé.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_delivery_fulfillment'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.resolve_delivery_fulfillment existe déjà — DRAFT fulfillment routing Lot B déjà appliqué, application annulée pour éviter une double définition.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_restaurant_public_delivery_fulfillments'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_restaurant_public_delivery_fulfillments existe déjà — DRAFT fulfillment routing Lot B déjà appliqué, application annulée pour éviter une double définition.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------------
-- 1. Résolveur interne partagé (§4/§9 du rapport de conception).
--
-- CORRIGÉ EN LOT B.1 (audit Work, findings FRB-B-01/HIGH et
-- FRB-B-02/MEDIUM) — la version Lot B initiale (a) ne recevait jamais
-- la quantité panier et n'appliquait donc JAMAIS min_items (elle se
-- contentait de retourner la ligne résolue, min_items compris, sans
-- jamais comparer cette valeur à quoi que ce soit), et (b) traitait
-- un code postal NULL comme "aucune zone déclarée" (le fallback
-- s'appliquait quand même), alors que le résolveur frontend
-- (resolveDeliveryFulfillment, lib/delivery.ts) refusait DÉJÀ tout
-- code postal invalide/absent IMMÉDIATEMENT, avant même de considérer
-- une règle fallback — deux comportements incompatibles pour la même
-- situation, jamais prouvés identiques par les tests initiaux. Ce
-- fichier corrige les DEUX cotés du contrat ; le frontend est
-- désormais strictement aligné (voir lib/delivery.ts) plutôt que
-- l'inverse, car son traitement du "no-postal" était déjà correct.
--
-- CONTRAT DE RÉSOLUTION LOT B.1 (IDENTIQUE SQL/TypeScript, prouvé cas
-- par cas par tests/fixtures/fulfillment-routing-cases.json — voir
-- FRB-B-02, supabase/tests/fulfillment-routing-lot-b-check.sh section
-- "FIXTURE COMMUNE") :
--
--   Entrées : les règles ACTIVES de ce (restaurant_id, mode_code)
--   (implicites ici, lues directement en base), un code postal brut,
--   une quantité totale de panier (p_total_count).
--
--   1. NORMALISATION : trim() des espaces de bord uniquement. AUCUNE
--      validation de FORMAT (ni longueur, ni chiffres) — moteur
--      GÉNÉRIQUE, jamais de règle France-specific ici. (Le champ
--      customer-facing isValidPostalCode à 5 chiffres, utilisé par
--      les résolveurs LEGACY getDeliveryStatus/
--      getDeliveryStatusFromPublicInfo, LOT 2B.2, reste un concept UI
--      distinct et hors périmètre de CE résolveur.)
--   2. CODE POSTAL INVALIDE (NULL, ou vide après trim) : eligible=
--      false, block='no-postal', AUCUNE règle retenue — même le
--      fallback ne s'applique PAS. Vérifié EN PREMIER.
--   3. Sinon, le mode PARENT (restaurant_sale_modes) doit exister et
--      être enabled=true — invariant documenté par LOT A. S'il ne
--      l'est pas : traité comme "aucune règle disponible", même
--      classification que l'étape 5 (voir note ci-dessous).
--   4. Sinon, parmi les règles NON-fallback (enabled=true) triées par
--      display_order ASC : la première dont un élément de
--      zone_prefixes (dans l'ordre du TABLEAU, jamais réordonné)
--      préfixe le code postal normalisé est retenue — matched_prefix
--      = ce préfixe précis, arrêt immédiat.
--   5. Sinon, la règle fallback (enabled=true, is_fallback=true) si
--      elle existe — au plus une, garantie par LOT A — matched_prefix
--      = NULL (aucun préfixe n'est requis pour un fallback).
--   6. Sinon (ni parent activé, ni non-fallback, ni fallback) :
--      eligible=false, block='out-of-zone', aucune règle retenue.
--      SIMPLIFICATION DOCUMENTÉE : le "mode parent désactivé" (étape
--      3) partage la même classification 'out-of-zone' que "aucune
--      règle ne correspond" — le résolveur frontend n'a de toute
--      façon aucun moyen de distinguer les deux cas (son tableau
--      `rules` est déjà pré-filtré par la RPC AVANT qu'il ne s'exécute
--      : un mode parent désactivé se traduit pour lui par un tableau
--      vide, indiscernable de "aucune règle configurée"). Prouvé
--      identique par le cas fixture
--      parent-mode-disabled-parity-with-empty-rules.
--   7. Une fois une règle retenue (fallback ou non, étape 4 ou 5) :
--      si min_items IS NOT NULL et p_total_count < min_items, alors
--      eligible=false, block='below-min', missing=min_items-
--      p_total_count — MAIS fulfillment_code/matched_prefix/
--      customer_text restent renseignés (contrairement aux étapes 2
--      et 6, où aucune règle n'a pu être identifiée du tout).
--   8. Sinon eligible=true, block=NULL, missing=NULL.
--
--   p_total_count NULL est traité comme 0 (coalesce défensif) — un
--   appelant qui ne connaît pas la quantité ne doit jamais obtenir une
--   éligibilité optimiste par accident de logique ternaire SQL
--   (NULL < min_items produirait NULL, pas false, sans ce garde-fou).
--
--   CETTE FONCTION RETOURNE TOUJOURS EXACTEMENT UNE LIGNE (jamais 0,
--   jamais plusieurs) — corrigé en Lot B.1 : la version initiale
--   retournait 0 ou 1 ligne selon les cas, rendant la comparaison
--   avec le contrat frontend (qui retourne toujours un objet, jamais
--   `undefined`) structurellement asymétrique et invérifiable
--   directement. `eligible`/`block`/`missing` portent désormais
--   explicitement la décision plutôt que de la faire déduire du
--   nombre de lignes retournées par l'appelant.
--
-- Reçoit un code postal DÉJÀ extrait (jamais l'adresse brute -- cette
-- fonction ne fait aucune extraction regex, ce qui reste la
-- responsabilité de l'appelant, exactement comme create_order le fait
-- déjà aujourd'hui pour le modèle mono-provider).
--
-- LANGUAGE SQL (pas PL/pgSQL) : la logique reste une composition de
-- requêtes simples (CTE), aucun contrôle de flux impératif nécessaire
-- -- même choix de conception minimale que le helper FRA-A-01 de
-- LOT A.1.
--
-- STABLE (pas IMMUTABLE) : dépend du contenu des tables
-- restaurant_sale_modes/restaurant_sale_mode_fulfillments, qui peut
-- changer entre deux transactions -- STABLE est la classification
-- correcte pour une fonction qui lit des tables sans les modifier
-- (même classification que get_restaurant_public_delivery_info et
-- effective_sale_mode_field_requirements).
--
-- SECURITY DEFINER + SET search_path = '' : patron identique à
-- effective_sale_mode_field_requirements -- exécute avec les
-- privilèges du propriétaire (contourne la RLS SELECT-member de
-- restaurant_sale_mode_fulfillments pour un usage interne contrôlé),
-- search_path figé pour éliminer toute résolution ambiguë d'objet non
-- qualifié par schéma.
--
-- Ne vérifie PAS explicitement restaurants.is_active/status ici --
-- exactement le même choix que effective_sale_mode_field_requirements
-- (LOT 2A), qui ne le fait pas non plus : cette vérification reste la
-- responsabilité de CHAQUE appelant contrôlé (create_order la fait
-- déjà pour son propre flux, LOT D). Dupliquer cette vérification ici
-- ajouterait une seconde source de vérité pour la même règle, jamais
-- souhaitable.
create function public.resolve_delivery_fulfillment(
  p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer
)
returns table (
  eligible         boolean,
  fulfillment_code text,
  provider         text,
  matched_prefix   text,
  zone_prefixes    text[],
  is_fallback      boolean,
  min_items        integer,
  customer_text    text,
  display_order    integer,
  block            text,
  missing          integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with normalized as (
    select nullif(btrim(p_postal_code), '') as code
  ),
  parent_mode_enabled as (
    select exists (
      select 1
      from public.restaurant_sale_modes rsm
      where rsm.restaurant_id = p_restaurant_id
        and rsm.mode_code = p_mode_code
        and rsm.enabled = true
    ) as enabled
  ),
  candidate_rules as (
    select f.fulfillment_code, f.provider, f.zone_prefixes, f.is_fallback,
           f.min_items, f.customer_text, f.display_order
    from public.restaurant_sale_mode_fulfillments f
    where f.restaurant_id = p_restaurant_id
      and f.mode_code = p_mode_code
      and f.enabled = true
      and (select enabled from parent_mode_enabled)
      and (select code from normalized) is not null
  ),
  matched_rule as (
    select c.*,
      (select zp.prefix
         from unnest(c.zone_prefixes) with ordinality as zp(prefix, ord)
         where (select code from normalized) like zp.prefix || '%'
         order by zp.ord
         limit 1) as matched_prefix
    from candidate_rules c
    where c.is_fallback = false
      and exists (
        select 1 from unnest(c.zone_prefixes) as zp(prefix)
        where (select code from normalized) like zp.prefix || '%'
      )
    order by c.display_order asc
    limit 1
  ),
  fallback_rule as (
    select c.*, null::text as matched_prefix
    from candidate_rules c
    where c.is_fallback = true
      and not exists (select 1 from matched_rule)
    limit 1
  ),
  selected as (
    select * from matched_rule
    union all
    select * from fallback_rule
    limit 1
  )
  select
    (
      (select code from normalized) is not null
      and s.fulfillment_code is not null
      and not (
        s.min_items is not null
        and coalesce(p_total_count, 0) < s.min_items
      )
    ) as eligible,
    s.fulfillment_code,
    s.provider,
    s.matched_prefix,
    s.zone_prefixes,
    s.is_fallback,
    s.min_items,
    s.customer_text,
    s.display_order,
    case
      when (select code from normalized) is null then 'no-postal'
      when s.fulfillment_code is null then 'out-of-zone'
      when s.min_items is not null and coalesce(p_total_count, 0) < s.min_items then 'below-min'
      else null
    end as block,
    case
      when s.fulfillment_code is not null
       and s.min_items is not null
       and coalesce(p_total_count, 0) < s.min_items
        then s.min_items - coalesce(p_total_count, 0)
      else null
    end as missing
  from (select 1) one
  left join selected s on true;
$$;

comment on function public.resolve_delivery_fulfillment(uuid, text, text, integer) is
  'FULFILLMENT ROUTING LOT B.1 — résolveur interne PARTAGÉ (algorithme §4/§9 du rapport de conception, contrat corrigé FRB-B-01) : retourne TOUJOURS exactement une ligne portant la décision complète (eligible, fulfillment_code, matched_prefix, min_items, customer_text, block, missing) pour ce (restaurant, mode, code postal, quantité). Code postal invalide/absent => eligible=false, block=''no-postal'', même le fallback ne s''applique pas — IDENTIQUE au contrat frontend (resolveDeliveryFulfillment, lib/delivery.ts), prouvé cas par cas par tests/fixtures/fulfillment-routing-cases.json. Expose `provider` — usage STRICTEMENT interne (create_order, LOT D, pas encore branché). REVOQUÉE de tout accès direct (public/anon/authenticated), patron effective_sale_mode_field_requirements. AUCUN appelant dans ce lot.';

-- REVOKE explicite -- patron EXACT de effective_sale_mode_field_requirements
-- (LOT 2A2-01) : ni public, ni anon, ni authenticated. service_role
-- n'a jamais eu de grant explicite non plus (aucun appelant contrôlé
-- de ce lot ne l'invoque avec ce rôle) -- même choix que le patron
-- réutilisé, pas une omission.
revoke all on function public.resolve_delivery_fulfillment(uuid, text, text, integer) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 2. RPC publique additive (§5 du rapport de conception).
--
-- Projection minimale, lecture directe (comme
-- get_restaurant_public_delivery_info -- pas besoin d'appeler le
-- résolveur interne ici : cette RPC retourne la liste BRUTE des
-- règles actives pour permettre au frontend de faire lui-même
-- l'aperçu instantané à chaque frappe, sans aller-retour réseau ni
-- dupliquer une correspondance déjà faite côté serveur pour rien).
--
-- Vérifie EXPLICITEMENT les deux moitiés de l'invariant d'activation
-- documenté par LOT A pour ce lot :
--   restaurant_sale_modes.enabled = true
--   AND restaurant_sale_mode_fulfillments.enabled = true
-- -- jamais l'une sans l'autre.
--
-- N'expose JAMAIS `provider` ni le JSONB `config` brut -- seules les
-- 6 colonnes listées ci-dessous, mêmes garanties de confidentialité
-- que get_restaurant_public_delivery_info pour `provider`/`config`.
create function public.get_restaurant_public_delivery_fulfillments(p_restaurant_id uuid)
returns table (
  fulfillment_code text,
  zone_prefixes    text[],
  is_fallback      boolean,
  min_items        integer,
  customer_text    text,
  display_order    integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.fulfillment_code,
    f.zone_prefixes,
    f.is_fallback,
    f.min_items,
    f.customer_text,
    f.display_order
  from public.restaurant_sale_mode_fulfillments f
  join public.restaurant_sale_modes rsm
    on rsm.restaurant_id = f.restaurant_id
   and rsm.mode_code = f.mode_code
  join public.restaurants r on r.id = f.restaurant_id
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
    and f.enabled = true
    and rsm.enabled = true
    and r.is_active = true
    and r.status = 'active'
  order by f.display_order asc;
$$;

comment on function public.get_restaurant_public_delivery_fulfillments(uuid) is
  'FULFILLMENT ROUTING LOT B — projection publique minimale des règles de routage fulfillment (mode delivery) : une ligne par règle active. N''expose jamais provider ni config JSONB brut. Ne prend pas de code postal : retourne la liste brute, la correspondance (voir resolveDeliveryFulfillment, lib/delivery.ts) est faite côté client pour un aperçu instantané. Vérifie explicitement restaurant_sale_modes.enabled ET restaurant_sale_mode_fulfillments.enabled (les deux, jamais l''un sans l''autre — invariant documenté par LOT A).';

-- REVOKE explicite AVANT tout GRANT -- jamais l'inverse (même
-- discipline que LOT 2B.1 / get_restaurant_public_delivery_info).
revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from public;
revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from anon, authenticated, service_role;
grant execute on function public.get_restaurant_public_delivery_fulfillments(uuid) to anon, authenticated;

commit;

-- ============================================================
-- AUCUNE DONNÉE TENANT : ce fichier n'insère STRICTEMENT AUCUNE ligne
-- dans restaurant_sale_mode_fulfillments (ni Au Lait Cru, ni Sanaa, ni
-- Illico, ni Sirocco, ni aucun autre établissement) — la table reste
-- vide après ce lot, exactement comme après LOT A. Aucune des deux
-- nouvelles fonctions ne retourne donc jamais aucune ligne pour un
-- tenant réel tant qu'aucune donnée n'a été insérée (Lot E, hors
-- périmètre de ce fichier).
--
-- AUCUN RUNTIME SWITCH : aucun hook, aucune modification de
-- MenuView.tsx/FulfillmentSelector.tsx/CartPanel.tsx. Le frontend
-- gagne uniquement des types et fonctions pures/additives, non
-- appelées par aucun composant — voir lib/sale-modes-types.ts,
-- lib/delivery.ts (resolveDeliveryFulfillment), lib/sale-modes-public.ts
-- (getPublicDeliveryFulfillments), et leurs tests dédiés prouvant
-- explicitement cette absence de branchement.
--
-- AUCUN changement à create_order/orders : le résolveur interne livré
-- ici n'a encore AUCUN appelant — son branchement dans create_order
-- (persistance fulfillment_code/provider_code/fulfillment_rule_id sur
-- orders) reste LOT D, hors périmètre de ce fichier.
--
-- DETTE VOLONTAIREMENT LAISSÉE (documentée, non corrigée ici) :
--  - resolve_delivery_fulfillment n'a aucun appelant contrôlé dans ce
--    lot -- prouvé uniquement par appel direct (connexion
--    propriétaire) dans le harnais SQL jetable, comme
--    effective_sale_mode_field_requirements l'a été avant d'avoir son
--    premier appelant réel en LOT 2A.
--  - get_restaurant_public_delivery_fulfillments ne fait aucune
--    résolution serveur (liste brute uniquement) -- la duplication
--    CONTRÔLÉE de l'algorithme de correspondance côté client
--    (resolveDeliveryFulfillment, TypeScript) reste nécessaire pour
--    l'aperçu instantané sans aller-retour réseau. Depuis LOT B.1,
--    cette duplication n'est plus seulement documentée : elle est
--    prouvée cas par cas (mêmes entrées, même décision publique) par
--    tests/fixtures/fulfillment-routing-cases.json, consommé à la
--    fois par tests/v97-fulfillment-routing-lot-b1-determinism.test.ts
--    (TypeScript) et par le harnais SQL ci-dessous (section "FIXTURE
--    COMMUNE"), au lieu de deux suites indépendantes qui ne faisaient
--    que se ressembler (FRB-B-02, fermé par ce fichier).
--
-- TESTS AUTOMATISÉS : voir
-- supabase/tests/fulfillment-routing-lot-b-check.sh (harnais
-- PostgreSQL jetable, jamais exécuté contre Production).
-- ============================================================
