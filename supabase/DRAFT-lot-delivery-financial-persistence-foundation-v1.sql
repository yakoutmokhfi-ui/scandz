-- ============================================================
-- Scanym — STUART LOT C — DELIVERY FINANCIAL PERSISTENCE
-- FOUNDATION v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET (STRICTEMENT) : donner à `provider_cost` (coût du
-- prestataire de livraison externe, ex. Stuart, facturé DIRECTEMENT
-- AU MARCHAND -- voir LOT-C-BIZ-01 ci-dessous, jamais un coût facturé
-- à Scanym) et
-- `merchant_delivery_subsidy` (= provider_cost - customer_delivery_fee
-- quand positif, jamais négatif) une existence PERSISTÉE, snapshotée
-- au niveau de la commande -- ces deux montants sont AUJOURD'HUI
-- calculés en mémoire par le moteur pur STUART LOT B
-- (lib/delivery-pricing-policy.ts, `computeDeliveryPricingPolicy`)
-- mais jamais écrits nulle part. N'exécute AUCUN job Stuart réel,
-- AUCUN paiement réel -- pure fondation de persistance/lecture.
--
-- CORRECTIF LOT-C-BIZ-01 (v1.1, CTO pre-control) : la version v1 de ce
-- fichier décrivait `provider_cost` comme un coût "facturé à Scanym"
-- -- description commerciale INCORRECTE. Modèle métier autoritatif
-- (mandat v1.1) : le marchand possède son propre compte Stuart,
-- contracte DIRECTEMENT avec Stuart, et est facturé DIRECTEMENT par
-- Stuart -- Scanym reste un simple orchestrateur technique, jamais
-- partie facturée. `provider_cost` représente donc le coût du
-- prestataire de livraison externe supporté/facturé AU MARCHAND,
-- jamais à Scanym. Correction PUREMENT rédactionnelle (commentaires
-- SQL/TypeScript uniquement) -- AUCUN changement de type, de
-- nullabilité, de règle de validation, de contrat de RPC, ni de
-- l'arithmétique `merchantSubsidy = providerCost - customerDeliveryFee`
-- elle-même (cette formule est indifférente à la question de savoir
-- QUI est facturé).
--
-- DÉCOUVERTE PRÉALABLE (mandat, "FIRST — REPOSITORY DISCOVERY") :
--
--   1. `orders.delivery_fee` (numeric(12,2), ajouté par
--      DRAFT-lot-server-delivery-fulfillment-pricing.sql, sommé dans
--      `orders.total` via la contrainte CHECK
--      `orders_total_equals_subtotal_plus_delivery_fee`) EST DÉJÀ,
--      exactement, le concept `customerDeliveryFee` de STUART LOT B --
--      AUCUNE nouvelle colonne n'est créée pour ce concept (mandat :
--      "Do NOT create duplicate concepts if equivalent persisted
--      fields already exist"). Ce lot ne touche ni cette colonne, ni
--      la contrainte CHECK existante, ni le calcul de `orders.total`.
--
--   2. `provider_cost`/`merchant_delivery_subsidy` N'EXISTENT NULLE
--      PART aujourd'hui -- confirmé par grep exhaustif (aucune
--      colonne, aucun champ TypeScript équivalent hors LOT B lui-même,
--      aucune fonction SQL). Les deux lots STUART précédents
--      (stuart-merchant-credential-foundation-v1,
--      stuart-quote-validate-foundation-v1) EXCLUENT explicitement
--      cette persistance de leur périmètre ("AUCUNE persistance
--      provider_cost/customer_delivery_fee/subsidy sur orders") --
--      terrain vierge, c'est exactement l'objet de ce lot.
--
--   3. `create_order` (dernière définition réelle : celle posée par
--      DRAFT-lot-server-delivery-fulfillment-pricing.sql, RE-VÉRIFIÉE
--      ici par grep exhaustif de TOUTES les occurrences de
--      `create or replace function public.create_order(`) est
--      EXÉCUTABLE PAR `anon`/`authenticated` (c'est la RPC de
--      soumission de commande côté client, appelée directement par le
--      navigateur du client au moment du checkout) -- confirmé par
--      `information_schema.routine_privileges`. AUCUN appelant
--      aujourd'hui ne connaît de valeur `provider_cost` réelle au
--      moment de `create_order` (le devis Stuart réel n'est ni
--      appelé, ni câblé au checkout -- LOT A :
--      `NormalizedStuartQuoteResult.providerCostAmount` reste
--      TOUJOURS `undefined` dans ce lot ; LOT B est un moteur pur
--      NON câblé au checkout, mandat LOT B "SCOPE — OUT: checkout UI
--      integration"). Ajouter un paramètre `provider_cost` à
--      `create_order` créerait donc un chemin CLIENT-AUTORITAIRE tout
--      neuf sur une donnée financière interne marchand -- exactement
--      l'écart que le mandat interdit ("Client must never be
--      authoritative for provider_cost"). `create_order` N'EST DONC
--      PAS MODIFIÉ par ce lot -- ni sa signature, ni son corps, ni son
--      contrat RETURNS TABLE (les nouvelles colonnes ne doivent de
--      toute façon JAMAIS être renvoyées par cette RPC publique --
--      "must NOT be exposed publicly").
--
--   4. Conséquence directe du point 3 : l'écriture atomique "à la
--      création" exigée en préférence par le mandat est IMPOSSIBLE
--      aujourd'hui sans câbler un vrai devis Stuart dans le checkout
--      (hors périmètre explicite de ce lot : "real Stuart call").
--      Le mandat autorise explicitement ce cas ("Do not create a
--      race... unless existing architecture requires this and
--      atomicity cannot be achieved") -- DÉCISION prise ici : une RPC
--      SÉPARÉE, SECURITY DEFINER, `service_role` UNIQUEMENT (jamais
--      `anon`/`authenticated` -- même posture que
--      `initiate_payment_attempt`/`set_order_billing_context`,
--      appelée exclusivement depuis du code serveur de confiance,
--      jamais depuis le navigateur), permet d'enregistrer le snapshot
--      APRÈS création, en ÉCRITURE UNIQUE (jamais de ré-écriture --
--      préserve "historical snapshot... must NOT retroactively
--      change"). Tant qu'aucun appelant réel (câblage Stuart réel,
--      hors périmètre) n'existe, ces deux colonnes restent NULL sur
--      TOUTE commande, y compris les commandes en livraison -- ceci
--      est le comportement ATTENDU de cette fondation, pas un bug
--      (mandat : "For non-delivery orders: fields may remain NULL" --
--      étendu ici, explicitement, aux commandes en livraison sans
--      prestataire externe réellement facturé).
--
--   5. `initiate_payment_attempt` (PAYMENT P1) dérive `amount`
--      UNIQUEMENT de `v_order.total` (= subtotal + delivery_fee,
--      DÉJÀ correct), jamais d'une valeur client, jamais recalculé
--      ailleurs. `provider_cost`/`merchant_delivery_subsidy` ne font
--      PAS partie de `orders.total` et n'ont donc AUCUN effet sur le
--      montant du paiement -- confirmé par lecture complète du corps
--      de la fonction. AUCUNE modification du runtime Payment/
--      Monetico n'est requise par ce lot (mandat, "PAYMENT BOUNDARY").
--
--   6. `get_order_tracking` (CUSTOMER ORDER TRACKING FOUNDATION) ne
--      renvoie JAMAIS total/subtotal/currency, à plus forte raison
--      aucune donnée financière de livraison -- confirmé par lecture
--      complète. Surface client déjà non-financière : rien à modifier
--      pour garantir la non-exposition de provider_cost/subsidy côté
--      client.
--
--   7. Devise : `orders.currency` reste l'UNIQUE autorité (déjà
--      alignée avec `restaurant_configs.currency` au moment de
--      `create_order`). Ce lot ne crée AUCUNE nouvelle autorité de
--      devise -- la nouvelle RPC exige une correspondance EXACTE avec
--      `orders.currency`, échoue fermé sinon (aucune conversion FX).
--
-- MATRICE D'IMPACT AVAL (mandat, classification A/B/C) :
--   - lib/receipt.ts (ticket) : A -- unique autorité `order.total`,
--     aucune lecture séparée de delivery_fee, ne lira jamais les deux
--     nouvelles colonnes -- inchangé, non affecté.
--   - lib/whatsapp.ts (message client) : A -- `AuthoritativeOrderTotals.
--     deliveryFee` provient déjà de `orders.delivery_fee` (le bon
--     concept, customer-facing) -- inchangé, non affecté.
--   - lib/services/orders.ts (`CreatedOrder`) : A -- alimenté par le
--     RETURNS TABLE de `create_order`, lui-même inchangé par ce lot.
--   - Suivi client (`get_order_tracking`) : A -- non financier, voir
--     point 6 ci-dessus.
--   - Tableau de bord marchand (lib/services/dashboard.ts) : B --
--     l'écart pré-existant (delivery_fee/provider_code/
--     fulfillment_rule_id/fulfillment_code déjà absents de son
--     SELECT, AVANT ce lot) n'est ni créé ni aggravé par ce lot ; les
--     deux nouvelles colonnes héritent de la même politique RLS
--     existante ("merchant reads restaurant orders") sans GRANT
--     supplémentaire -- consultables dès aujourd'hui par le personnel
--     via une lecture directe/une future RPC dédiée. Le câblage dans
--     le composant `OrderCard`/la liste marchande est un
--     élargissement UI explicitement hors périmètre ("broad dashboard
--     UI redesign") -- reporté à un lot ultérieur, PAS un consommateur
--     cassé par ce lot (aucune commande n'a aujourd'hui de valeur non
--     NULL à afficher de toute façon, voir point 4).
--   - Facture/demande de facture, catalogue, invoice-request : A --
--     aucune référence à delivery_fee/provider_cost/subsidy trouvée.
--
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- prérequis ORDERS FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('delivery_fee', 'currency', 'service_mode', 'total')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.delivery_fee/currency/service_mode/total introuvable -- prérequis DRAFT-lot-server-delivery-fulfillment-pricing.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc where proname = 'scanym_numeric_is_non_finite'
      and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.scanym_numeric_is_non_finite() introuvable -- prérequis DRAFT-lot-payment-p1-foundation.sql manquant, migration annulée.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'provider_cost'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.provider_cost existe déjà -- ce lot semble déjà appliqué, migration annulée (anti double-application).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. COLONNES DE SNAPSHOT -- additives, NULLABLE (mandat : "additive
-- and safely-backfilled" ; historique : préférer NULL/inconnu plutôt
-- qu'une valeur inventée). `numeric(12,2)`, identique à
-- `orders.subtotal`/`orders.total`/`orders.delivery_fee` (mandat :
-- "fixed precision compatible with current schema").
-- ------------------------------------------------------------
alter table public.orders
  add column provider_cost numeric(12,2),
  add column delivery_merchant_subsidy numeric(12,2);

comment on column public.orders.provider_cost is
  'STUART LOT C — coût EXPLICITE du prestataire de livraison externe (ex. Stuart) pour CETTE commande, supporté/facturé DIRECTEMENT AU MARCHAND (le marchand possède son propre compte Stuart et contracte directement avec lui -- Scanym reste un simple orchestrateur technique, jamais partie facturée -- correctif LOT-C-BIZ-01, v1.1), snapshoté au moment où il devient connu (jamais recalculé depuis la politique tarifaire marchande courante). STRICTEMENT INTERNE/MARCHAND -- ne JAMAIS exposer via une API/RPC accessible au client (même posture que orders.provider_code). NULL pour toute commande sans prestataire externe réellement facturé (y compris, aujourd''hui, TOUTES les commandes en livraison -- aucun câblage Stuart réel n''existe encore). Écrit UNIQUEMENT par set_order_delivery_provider_financials (service_role), jamais par create_order.';

comment on column public.orders.delivery_merchant_subsidy is
  'STUART LOT C — part du coût prestataire (provider_cost) que le marchand absorbe au-delà du frais facturé au client (= GREATEST(provider_cost - orders.delivery_fee, 0), jamais négatif -- calculé et validé une seule fois par STUART LOT B avant persistance, jamais recalculé au moment de la lecture). STRICTEMENT INTERNE/MARCHAND, jamais exposé côté client. NULL exactement quand provider_cost est NULL (voir contrainte orders_delivery_financials_pair).';

alter table public.orders
  add constraint orders_provider_cost_non_negative
    check (provider_cost is null or provider_cost >= 0),
  add constraint orders_provider_cost_finite
    check (provider_cost is null or not public.scanym_numeric_is_non_finite(provider_cost)),
  add constraint orders_delivery_merchant_subsidy_non_negative
    check (delivery_merchant_subsidy is null or delivery_merchant_subsidy >= 0),
  add constraint orders_delivery_merchant_subsidy_finite
    check (delivery_merchant_subsidy is null or not public.scanym_numeric_is_non_finite(delivery_merchant_subsidy)),
  add constraint orders_delivery_financials_pair
    check ((provider_cost is null) = (delivery_merchant_subsidy is null)),
  -- Invariant business LOT B (jamais réévalué depuis une politique
  -- marchande courante -- seulement une borne structurelle sur la
  -- PAIRE déjà persistée) : le subside ne peut jamais dépasser le
  -- coût prestataire lui-même.
  add constraint orders_delivery_merchant_subsidy_le_provider_cost
    check (delivery_merchant_subsidy is null or delivery_merchant_subsidy <= provider_cost);

revoke update (provider_cost, delivery_merchant_subsidy) on public.orders from anon, authenticated;

-- ------------------------------------------------------------
-- 3. RPC D'ÉCRITURE -- service_role UNIQUEMENT (jamais anon/
-- authenticated -- même posture que initiate_payment_attempt/
-- set_order_billing_context), ÉCRITURE UNIQUE (immuable -- rejette si
-- déjà enregistré, préserve le snapshot historique). Reçoit un
-- résultat DÉJÀ calculé par STUART LOT B
-- (computeDeliveryPricingPolicy) -- ne recalcule JAMAIS
-- customerDeliveryFee, ne fait AUCUN arrondi flottant supplémentaire ;
-- ne valide (défensivement) que la COHÉRENCE de la paire déjà fournie
-- avec orders.delivery_fee déjà persisté, sans jamais substituer une
-- valeur recalculée à celle fournie par l'appelant (mandat : "may
-- continue... for defensive invariant validation if necessary").
-- ------------------------------------------------------------
create function public.set_order_delivery_provider_financials(
  p_order_id uuid,
  p_provider_cost numeric,
  p_merchant_subsidy numeric,
  p_currency text
)
returns table(order_id uuid, provider_cost numeric, delivery_merchant_subsidy numeric, updated_at timestamptz)
language plpgsql
security definer
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_order public.orders%rowtype;
  v_expected_subsidy numeric(12,2);
begin
  if p_order_id is null then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: p_order_id requis' using errcode = '22004';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: commande introuvable' using errcode = 'P0002';
  end if;

  if v_order.service_mode <> 'delivery' then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: commande non éligible (service_mode != delivery)' using errcode = '42501';
  end if;

  -- Immuabilité -- snapshot historique, jamais ré-écrit (mandat :
  -- "Later merchant pricing-config changes must NOT retroactively
  -- change historical orders" -- étendu ici à toute ré-écriture,
  -- quelle qu'en soit la source).
  if v_order.provider_cost is not null then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: snapshot financier de livraison déjà enregistré pour cette commande -- immuable, nouvelle écriture refusée' using errcode = '42501';
  end if;

  if p_currency is null or length(btrim(p_currency)) = 0 or p_currency is distinct from v_order.currency then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: devise fournie incompatible avec orders.currency -- aucune conversion FX, échec fermé' using errcode = '22023';
  end if;

  if p_provider_cost is null or public.scanym_numeric_is_non_finite(p_provider_cost) or p_provider_cost < 0 then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: p_provider_cost invalide (requis, fini, non négatif)' using errcode = '22023';
  end if;
  if round(p_provider_cost, 2) is distinct from p_provider_cost then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: p_provider_cost dépasse 2 décimales -- rejeté (jamais arrondi silencieusement)' using errcode = '22023';
  end if;

  if p_merchant_subsidy is null or public.scanym_numeric_is_non_finite(p_merchant_subsidy) or p_merchant_subsidy < 0 then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: p_merchant_subsidy invalide (requis, fini, non négatif)' using errcode = '22023';
  end if;
  if round(p_merchant_subsidy, 2) is distinct from p_merchant_subsidy then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: p_merchant_subsidy dépasse 2 décimales -- rejeté (jamais arrondi silencieusement)' using errcode = '22023';
  end if;

  -- Validation défensive de COHÉRENCE (pas une source de vérité --
  -- STUART LOT B reste l'unique autorité de calcul) : reproduit
  -- exactement lib/delivery-pricing-policy.ts pour DÉTECTER une
  -- incohérence, jamais pour la corriger silencieusement.
  v_expected_subsidy := case
    when p_provider_cost > v_order.delivery_fee then round(p_provider_cost - v_order.delivery_fee, 2)
    else 0
  end;
  if p_merchant_subsidy is distinct from v_expected_subsidy then
    raise exception 'SCANYM_DELIVERY_FINANCIALS: p_merchant_subsidy incohérent avec provider_cost/orders.delivery_fee déjà persisté (attendu %, reçu %) -- rejeté', v_expected_subsidy, p_merchant_subsidy using errcode = '22023';
  end if;

  update public.orders o
    set provider_cost = p_provider_cost,
        delivery_merchant_subsidy = p_merchant_subsidy
    where o.id = p_order_id
    returning o.id, o.provider_cost, o.delivery_merchant_subsidy, o.updated_at
    into order_id, provider_cost, delivery_merchant_subsidy, updated_at;

  return next;
end;
$function$;

comment on function public.set_order_delivery_provider_financials(uuid, numeric, numeric, text) is
  'STUART LOT C — persiste, une seule fois (immuable), le snapshot financier de livraison (provider_cost/delivery_merchant_subsidy) déjà calculé par STUART LOT B (computeDeliveryPricingPolicy). SECURITY DEFINER, search_path vide, service_role UNIQUEMENT (jamais anon/authenticated -- create_order reste inchangé et ne doit jamais recevoir ces valeurs depuis le client). Aucun appel réseau, aucun job Stuart, aucun paiement.';

revoke all on function public.set_order_delivery_provider_financials(uuid, numeric, numeric, text) from public;
grant execute on function public.set_order_delivery_provider_financials(uuid, numeric, numeric, text) to service_role;

commit;
