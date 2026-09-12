-- ============================================================
-- Scanym — STUART LOT C v1.2 — DELIVERY FEE VAT ALLOCATION
-- FOUNDATION v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET (STRICTEMENT) : ferme LOT-C-TAX-01 (STOP de gouvernance levé
-- par décision fiscale CIO/CTO explicite -- voir ci-dessous). Persiste
-- la ventilation de TVA du frais de livraison CLIENT
-- (`orders.delivery_fee`, déjà existant, INCHANGÉ) entre les taux de
-- taxe réellement présents sur la commande, en tant qu'instantané
-- IMMUABLE par commande. N'exécute AUCUN job Stuart réel, AUCUN
-- paiement réel, ne modifie NI `create_order` NI le calcul de
-- `orders.total`/`orders.delivery_fee` eux-mêmes (mandat : "the tax
-- allocation logic is separate and only allocates the already-final
-- customer_delivery_fee across tax-rate groups").
--
-- v1.2 (CTO PRE-CONTROL REMEDIATION, 3 blockers) : LOT-C-12-01 (fermeture
-- fail-open->fail-closed RÉELLE, transaction create_order échoue
-- désormais entièrement si la TVA livraison ne peut pas être ventilée
-- complètement, delivery_fee>0), LOT-C-12-02 (résidu de centime
-- recalculé gross->net->tax au lieu d'un patch indépendant, corrige un
-- risque de TVA négative), LOT-C-12-03 (lib/receipt.ts corrigé pour les
-- commandes multi-taux -- voir sections révisées ci-dessous et fichiers
-- TypeScript modifiés séparément).
--
-- ============================================================
-- DÉCISION FISCALE AUTORITATIVE (CIO/CTO, Au Lait Cru / France)
-- ============================================================
-- Le frais de livraison facturé au client DANS LA MÊME commande que
-- les produits est un coût ACCESSOIRE à la vente de produits -- CE
-- N'EST PAS une prestation de transport Stuart vendue séparément au
-- client. Conséquence directe :
--   - `orders.delivery_fee` (= customerDeliveryFee, LOT B) participe
--     à la TVA client.
--   - `orders.provider_cost` NE détermine JAMAIS la TVA client.
--   - `orders.delivery_merchant_subsidy` NE détermine JAMAIS la TVA
--     client.
-- Ce fichier ne touche NI `provider_cost` NI `delivery_merchant_subsidy`
-- -- lus nulle part ici, aucune dépendance.
--
-- ============================================================
-- ALGORITHME DE VENTILATION (règle multi-taux)
-- ============================================================
-- Commande à UN SEUL taux : 100% du frais de livraison suit ce taux
-- (aucune ventilation nécessaire -- cas particulier de la règle
-- générale ci-dessous, où elle produit exactement ce résultat).
--
-- Commande à PLUSIEURS taux : le frais de livraison est réparti au
-- prorata de la base produit TTC déjà persistée (`order_items.
-- line_total`, jamais une base HT -- mandat : "Do NOT mix HT and TTC
-- bases") groupée par `order_items.tax_rate_snapshot` (déjà figé par
-- commande, RECEIPT/INVOICE TAX DETAIL v1 -- jamais
-- `menu_items.tax_rate` courant, même discipline que
-- MLTP-V1-HISTORICAL-TAX-01) :
--   delivery_fee_share_r = round(delivery_fee × basis_r / total_basis, 2)
-- où `basis_r` = somme des `line_total` des lignes portant le taux r,
-- `total_basis` = somme de TOUS les `line_total` de la commande.
--
-- ============================================================
-- ARRONDI / RÉSIDU DE CENTIME (règle déterministe, documentée)
-- (RÉVISÉ v1.2 -- CTO PRE-CONTROL LOT-C-12-02)
-- ============================================================
-- Chaque part est arrondie AU CENTIME (convention monétaire du
-- dépôt, numeric(12,2)). La somme des parts arrondies peut différer
-- du frais de livraison total de ±1 centime par construction
-- (arrondis indépendants). Règle de résidu, STABLE et DÉTERMINISTE :
-- le ou les centime(s) résiduel(s) sont intégralement appliqués au
-- groupe de taux le PLUS ÉLEVÉ (`max(tax_rate_snapshot)` -- toujours
-- le MÊME groupe pour une commande donnée, jamais un ordre
-- d'itération non déterministe) -- garantit EXACTEMENT
-- sum(delivery_fee_gross_share) = orders.delivery_fee, sans exception
-- (vérifié par une garde de réconciliation explicite en fin de
-- déclencheur, v1.2). Cas à un seul taux : le résidu est TOUJOURS nul
-- par construction (la part unique = delivery_fee × 1, arrondi =
-- delivery_fee lui-même).
--
-- CORRECTIF v1.2 (LOT-C-12-02) : le patron v1.1
-- (`gross_share += résidu; tax_amount += résidu`, `net_share`
-- INCHANGÉ) pouvait produire une TVA NÉGATIVE, violant sa propre
-- contrainte CHECK ...tax_non_negative -- reproduit et confirmé AVANT
-- correctif : delivery_fee=0.01, deux groupes de base identique =>
-- parts arrondies indépendamment 0.01 + 0.01 = 0.02, résidu = -0.01 ;
-- le groupe au taux le plus élevé (destinataire déterministe du
-- résidu) avait par ailleurs une part TVA arrondie à 0.00 (0.01/1.20 =
-- 0.00833 -> net arrondi à 0.01 -> tax = 0.00) ; patcher tax seul avec
-- le patron v1.1 aurait donné delivery_fee_tax_amount = -0.01. Patron
-- v1.2 (jamais de patch indépendant) : (1) gross_new := gross_old +
-- résidu ; (2) net_new := round(gross_new / (1 + taux/100), 2)
-- -- RECALCULÉ à partir du gross ajusté, jamais l'inverse ; (3)
-- tax_new := gross_new - net_new -- RECALCULÉ, jamais patché.
-- Garantit gross = net + tax PAR CONSTRUCTION pour la ligne ajustée.
-- Sélection du destinataire INCHANGÉE (toujours déterministe, mandat
-- v1.2 : "Keep deterministic recipient selection if still
-- appropriate").
--
-- ============================================================
-- FERMETURE (fail-closed) -- AUCUNE RÈGLE FISCALE INVENTÉE
-- (RÉVISÉ v1.2 -- CTO PRE-CONTROL LOT-C-12-01)
-- ============================================================
-- COMPORTEMENT v1.1 (RÉVOLU, CONSERVÉ CI-DESSUS POUR HISTORIQUE DE
-- REVUE UNIQUEMENT) : si delivery_fee > 0 et que la base d'allocation
-- était inutilisable, AUCUNE ligne n'était écrite mais `create_order`
-- ABOUTISSAIT QUAND MÊME (`return new;` silencieux). Le CTO
-- pre-control a jugé ce comportement RÉELLEMENT FAIL-OPEN pour la
-- finalisation fiscale (la commande réussit malgré une donnée fiscale
-- incomplète), malgré sa documentation comme "fail-closed sans
-- bloquer le checkout" -- LOT-C-12-01, blocage formel.
--
-- COMPORTEMENT v1.2/v1.3 (ACTUEL) : si delivery_fee > 0 et que la
-- ventilation TVA ne peut pas être calculée complètement et
-- déterministement, LA TRANSACTION D'AUTORITÉ DE CRÉATION DE COMMANDE
-- ÉCHOUE ENTIÈREMENT -- aucune commande partiellement fiscalisée n'est
-- acceptée. Conditions couvertes (raise exception, errcode 22023,
-- message déterministe, JAMAIS de taux par défaut/20%/5,5%/zéro
-- inventé) : au moins une ligne sans `tax_rate_snapshot` ; aucune
-- ligne order_items ; base totale d'allocation nulle/négative ;
-- devise absente (défensif). Une exception levée dans un déclencheur
-- AFTER UPDATE annule TOUTE la transaction appelante (`create_order`,
-- y compris tous les `order_items` déjà insérés) -- comportement
-- intentionnel et requis, `create_order` cesse d'accepter une
-- commande à livraison payante fiscalement incomplète.
--
-- RÉVISÉ v1.3 (CIO/CTO Décision 2, scope review post-v1.2) : v1.2
-- ajoutait ICI une condition de fermeture supplémentaire sur
-- `tax_settings_snapshot_prices_include_tax IS DISTINCT FROM true`
-- (marchand HT), motivée par une lecture stricte de "For consumer TTC
-- pricing" dans le mandat v1.1. La scope review CIO/CTO a établi que
-- ce motif était INEXACT : `prices_include_tax` est un réglage de
-- PRÉSENTATION DU TICKET uniquement (`lib/receipt.ts`), sans AUCUN
-- effet sur le panier/`create_order`/le frais de livraison/
-- `orders.total` (grep exhaustif du dépôt, confirmé) --
-- `order_items.line_total` reste TOUJOURS le montant TTC réellement
-- facturé, quel que soit ce réglage. Cette condition BLOQUAIT donc à
-- tort une capacité checkout PRÉEXISTANTE et FONCTIONNELLE (paiement
-- de la livraison pour un marchand HT) -- une régression, pas une
-- fermeture fiscale légitime. **CONDITION RETIRÉE EN v1.3** (voir
-- section fail-closed du corps de la fonction ci-dessous, point (b)) :
-- `prices_include_tax=false` ne bloque plus `create_order`.
--
-- Livraison gratuite reste INCHANGÉE et distincte : `delivery_fee = 0`
-- => zéro ligne de ventilation, TOUJOURS un état VALIDE (aucune
-- exception), jamais confondu avec une fermeture fiscale.
--
-- ============================================================
-- LIVRAISON GRATUITE
-- ============================================================
-- `delivery_fee = 0` => AUCUNE ligne de ventilation écrite (TVA
-- livraison nulle par construction, rien à ventiler).
-- `provider_cost` peut rester non nul en interne -- jamais lu ici,
-- aucune TVA client n'en dérive jamais (voir décision fiscale
-- ci-dessus).
--
-- ============================================================
-- CHEMIN D'ÉCRITURE / AUTORITÉ SERVEUR
-- ============================================================
-- AUCUNE valeur externe/client n'entre dans ce calcul : la seule
-- entrée est `NEW.delivery_fee` (déjà autoritatif, LOT B via
-- create_order, INCHANGÉ) et `order_items.line_total`/
-- `tax_rate_snapshot` (déjà autoritatifs, insérés par create_order
-- AVANT sa mise à jour finale de `orders.delivery_fee` dans la MÊME
-- transaction -- vérifié par lecture complète du corps actuel de
-- create_order). Le calcul est donc entièrement DÉRIVÉ de données
-- déjà server-authoritative -- AUCUN risque de chemin
-- client-autoritaire (contrairement à `provider_cost`, qui lui reste
-- une RPC service_role séparée, LOT C v1, INCHANGÉE). Un déclencheur
-- `AFTER UPDATE OF delivery_fee ON orders` (même patron que
-- `snapshot_receipt_tax_settings`, MERCHANT LEGAL & TAX PROFILE v1)
-- calcule et persiste ATOMIQUEMENT, DANS LA MÊME TRANSACTION que
-- `create_order`, sans nouvel appelant, sans fenêtre de course.
-- `orders.delivery_fee` n'est mis à jour qu'UNE SEULE FOIS dans tout
-- le dépôt (vérifié par grep exhaustif de "delivery_fee =" -- les 3
-- occurrences trouvées sont les 3 redéfinitions successives de la
-- MÊME instruction UPDATE dans create_order) -- ce déclencheur ne
-- peut donc se déclencher qu'une fois par commande. Garde
-- d'idempotence explicite conservée néanmoins (défense en
-- profondeur, même discipline que l'écriture unique de
-- `provider_cost`).
--
-- ============================================================
-- CORRECTIF LOT-C-BIZ-01
-- ============================================================
-- Ce fichier ne décrit ni ne suppose JAMAIS que `provider_cost` est
-- facturé à Scanym -- voir le correctif appliqué à
-- DRAFT-lot-delivery-financial-persistence-foundation-v1.sql (LOT C
-- v1) : le coût prestataire est supporté/facturé DIRECTEMENT AU
-- MARCHAND (compte Stuart propre au marchand), Scanym restant un
-- orchestrateur technique. Sans incidence sur ce fichier (qui ne lit
-- jamais `provider_cost`), noté ici pour traçabilité de la
-- remédiation v1.1 complète.
--
-- ============================================================
-- MATRICE D'IMPACT AVAL -- consommateurs fiscaux actuels
-- (RÉVISÉ v1.2 -- CTO PRE-CONTROL LOT-C-12-03)
-- ============================================================
-- Recherche exhaustive (grep) des consommateurs RÉELS d'un calcul de
-- taxe dans ce dépôt : UN SEUL existe, `lib/receipt.ts`
-- (`buildReceiptHtml`). Aucune autre page/composant/service ne
-- calcule de décomposition HT/TVA/TTC (`app/dashboard/settings/
-- page.tsx` est l'écran de CONFIGURATION du taux marchand, pas un
-- consommateur de calcul).
--
--   - `lib/receipt.ts` : CLASSE B EN v1.1 (INCORRECTEMENT ÉTIQUETÉE
--     "classe A / unchanged" à l'époque) -- REMÉDIÉ dans ce lot v1.2.
--     Le CTO pre-control a jugé la classification v1.1 incorrecte :
--     "the fiscal discovery explicitly concluded that LOT-C-TAX-01
--     implementation is compliant only if current consumers using a
--     flat tax rate are corrected. Therefore: classifying
--     lib/receipt.ts as 'A / unchanged' is incorrect for LOT C."
--     Comportement v1.1 : calcule sa propre décomposition à partir de
--     `orders.tax_settings_snapshot_default_tax_rate` (taux UNIQUE
--     marchand, appliqué à `orders.total` EN BLOC) -- FAUX pour une
--     commande multi-taux (ne peut pas représenter correctement
--     plusieurs taux TVA produits ni la ventilation du frais de
--     livraison créée par ce lot). Remédiation v1.2 (correctif MINIMAL
--     et CIBLÉ, PAS une réécriture substantielle -- confiné à 3
--     fichiers déjà existants, `lib/receipt.ts` +
--     `lib/dashboard-types.ts` + `lib/services/dashboard.ts`, aucune
--     nouvelle page/route/endpoint, aucun changement du déclenchement
--     d'impression du ticket) : nouvelle branche multi-taux, active
--     UNIQUEMENT quand `hasTaxSnapshot && pricesIncludeTax===true &&`
--     chaque `order_items[].tax_rate_snapshot` est renseigné -- groupe
--     les lignes produit par `tax_rate_snapshot` (jamais
--     `menu_items.tax_rate` courant), fusionne les parts de
--     `order_delivery_tax_allocations` par taux correspondant (jamais
--     `provider_cost`/`delivery_merchant_subsidy`, jamais lus par ce
--     fichier), affiche une ligne TVA par taux. Repli INCHANGÉ sur
--     l'ancien calcul à taux unique dans tous les autres cas (données
--     historiques/HT/incomplètes) -- comportement byte-for-byte
--     identique à v1.1 pour ces cas, aucune régression. Équivalence
--     algébrique vérifiée pour une commande à taux unique où le taux
--     produit coïncide avec le taux marchand par défaut : le nouveau
--     calcul groupé se réduit exactement à l'ancien calcul à plat
--     (un seul groupe couvrant subtotal+delivery_fee=total au taux r
--     donne net=round(total/(1+r/100),2), la même expression que
--     l'ancien code) -- compatibilité ascendante confirmée par test,
--     pas seulement par argument.
--   - Demande de facture (`lib/invoice-request*.ts`) : classe A --
--     confirmé par grep, aucune référence à un montant/taxe, contact
--     de facturation uniquement.
--   - Tableau de bord marchand : classe A -- aucune décomposition
--     fiscale affichée (confirmé, LOT C v1 §12).
--   - `get_order_tracking` (client) : classe A -- non financier,
--     confirmé LOT C v1 §11.
-- Après remédiation v1.2, aucun consommateur actuel ne reste FAUX pour
-- une commande multi-taux -- `lib/receipt.ts` est désormais correct
-- (classe A après remédiation), plus aucune classe C ouverte.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('delivery_fee', 'currency')
    having count(*) = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.delivery_fee/currency introuvable -- prérequis DRAFT-lot-server-delivery-fulfillment-pricing.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name in ('order_id', 'line_total', 'tax_rate_snapshot')
    having count(*) = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_items.line_total/tax_rate_snapshot introuvable -- prérequis DRAFT-lot-receipt-invoice-tax-detail-v1.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc where proname = 'scanym_numeric_is_non_finite'
      and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.scanym_numeric_is_non_finite() introuvable -- prérequis DRAFT-lot-payment-p1-foundation.sql manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_orders_touch'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: trigger trg_orders_touch introuvable -- prérequis migration-v55-updated-at.sql manquant, migration annulée.';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'order_delivery_tax_allocations'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_delivery_tax_allocations existe déjà -- ce lot semble déjà appliqué, migration annulée (anti double-application).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. TABLE DE VENTILATION -- une ligne par commande + taux de taxe.
-- Instantané immuable (écrit une seule fois, par le déclencheur
-- ci-dessous, jamais recalculé à la lecture).
-- ------------------------------------------------------------
create table public.order_delivery_tax_allocations (
  order_id uuid not null references public.orders(id) on delete cascade,
  tax_rate_snapshot numeric(5,2) not null,
  delivery_fee_gross_share numeric(12,2) not null,
  delivery_fee_net_share numeric(12,2) not null,
  delivery_fee_tax_amount numeric(12,2) not null,
  currency character varying(10) not null,
  allocation_method_version text not null default 'v1',
  created_at timestamptz not null default now(),
  primary key (order_id, tax_rate_snapshot)
);

comment on table public.order_delivery_tax_allocations is
  'STUART LOT C v1.3 — ventilation TVA du frais de livraison CLIENT (orders.delivery_fee) entre les taux de taxe présents sur la commande (base : order_items.line_total groupé par tax_rate_snapshot). Instantané IMMUABLE écrit une seule fois par compute_delivery_fee_tax_allocation() (déclencheur AFTER UPDATE OF delivery_fee ON orders), jamais recalculé depuis menu_items.tax_rate/receipt_settings courants (même discipline que MLTP-V1-HISTORICAL-TAX-01). SÉMANTIQUE ZÉRO LIGNE (révisée v1.3, documentation seule -- DOCUMENTATION LOW de la scope review) : pour une commande CRÉÉE APRÈS le durcissement fail-closed v1.2/v1.3, zéro ligne signifie EXCLUSIVEMENT livraison gratuite (delivery_fee=0, seul état valide produisant zéro ligne -- une commande delivery_fee>0 avec donnée fiscale incomplète/incohérente ne peut plus être créée du tout, la transaction create_order échoue entièrement, voir compute_delivery_fee_tax_allocation()). Une commande HISTORIQUE (créée avant ce durcissement, sous LOT C v1.1) peut légitimement porter zéro ligne avec delivery_fee>0 -- vestige de l''ancien comportement fail-open v1.1, à ne jamais confondre avec une livraison gratuite pour ces commandes antérieures uniquement.';

comment on column public.order_delivery_tax_allocations.tax_rate_snapshot is
  'Taux de TVA (%), même domaine que order_items.tax_rate_snapshot -- jamais menu_items.tax_rate courant ni receipt_settings courant.';
comment on column public.order_delivery_tax_allocations.delivery_fee_gross_share is
  'Part TTC du frais de livraison allouée à ce taux. sum(delivery_fee_gross_share) sur toutes les lignes d''une commande = orders.delivery_fee EXACTEMENT (règle de résidu déterministe -- voir en-tête de ce fichier).';
comment on column public.order_delivery_tax_allocations.delivery_fee_net_share is
  'Part HT correspondante (= delivery_fee_gross_share / (1 + tax_rate_snapshot/100), arrondi au centime).';
comment on column public.order_delivery_tax_allocations.delivery_fee_tax_amount is
  'Montant de TVA correspondant (= delivery_fee_gross_share - delivery_fee_net_share, absorbe le résidu de centime le cas échéant -- invariant delivery_fee_gross_share = delivery_fee_net_share + delivery_fee_tax_amount toujours vrai, voir contrainte CHECK).';
comment on column public.order_delivery_tax_allocations.allocation_method_version is
  'Version stable de la règle d''allocation/résidu -- permet de faire évoluer la méthode SANS jamais altérer le résultat déjà persisté pour une commande existante (mandat : "prevent future recalculation rules from changing historical output").';

alter table public.order_delivery_tax_allocations
  add constraint order_delivery_tax_allocations_rate_range
    check (tax_rate_snapshot >= 0 and tax_rate_snapshot <= 100),
  add constraint order_delivery_tax_allocations_gross_non_negative
    check (delivery_fee_gross_share >= 0),
  add constraint order_delivery_tax_allocations_net_non_negative
    check (delivery_fee_net_share >= 0),
  add constraint order_delivery_tax_allocations_tax_non_negative
    check (delivery_fee_tax_amount >= 0),
  add constraint order_delivery_tax_allocations_gross_finite
    check (not public.scanym_numeric_is_non_finite(delivery_fee_gross_share)),
  add constraint order_delivery_tax_allocations_net_finite
    check (not public.scanym_numeric_is_non_finite(delivery_fee_net_share)),
  add constraint order_delivery_tax_allocations_tax_finite
    check (not public.scanym_numeric_is_non_finite(delivery_fee_tax_amount)),
  -- Invariant par ligne (test matrix #6) : gross = net + tax, toujours.
  add constraint order_delivery_tax_allocations_gross_eq_net_plus_tax
    check (delivery_fee_gross_share = delivery_fee_net_share + delivery_fee_tax_amount);

create index idx_order_delivery_tax_allocations_order on public.order_delivery_tax_allocations(order_id);

-- ------------------------------------------------------------
-- 3. RLS -- même posture que order_items (lecture marchande
-- authentifiée uniquement, scope restaurant_users -- JAMAIS anon).
-- Aucune donnée client-autoritaire n'entre jamais dans cette table
-- (écrite exclusivement par le déclencheur SECURITY DEFINER
-- ci-dessous) -- aucune policy INSERT/UPDATE/DELETE nécessaire pour
-- authenticated/anon (déni par défaut, RLS activée sans policy
-- d'écriture).
-- ------------------------------------------------------------
alter table public.order_delivery_tax_allocations enable row level security;

create policy "merchant reads restaurant delivery tax allocations"
  on public.order_delivery_tax_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.orders o
      join public.restaurant_users ru on ru.restaurant_id = o.restaurant_id
      where o.id = order_delivery_tax_allocations.order_id
        and ru.user_id = auth.uid()
    )
  );

revoke all on public.order_delivery_tax_allocations from public, anon, authenticated;
grant select on public.order_delivery_tax_allocations to authenticated;

-- ------------------------------------------------------------
-- 4. DÉCLENCHEUR -- calcule et persiste la ventilation, une seule
-- fois, à la fin de la transaction create_order (au moment exact où
-- orders.delivery_fee reçoit sa valeur finale -- order_items déjà
-- tous insérés à ce stade dans la même transaction). AUCUNE entrée
-- externe/client -- entièrement dérivé de orders.delivery_fee/
-- currency et order_items.line_total/tax_rate_snapshot, déjà
-- server-authoritative.
-- ------------------------------------------------------------
create function public.compute_delivery_fee_tax_allocation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_total_basis numeric(14,2);
  v_allocated_gross numeric(12,2) := 0;
  v_residual numeric(12,2);
  v_row record;
  v_share numeric(12,2);
  v_net numeric(12,2);
  v_tax numeric(12,2);
  v_top_rate numeric(5,2);
  v_gross_new numeric(12,2);
  v_net_new numeric(12,2);
  v_tax_new numeric(12,2);
  v_sum_check numeric(12,2);
begin
  -- Immuabilité / idempotence défensive : ne recalcule jamais si déjà
  -- écrit (garde de profondeur -- orders.delivery_fee n'est mis à
  -- jour qu'une seule fois dans tout le dépôt aujourd'hui, voir
  -- en-tête de ce fichier). PAS une condition de fermeture fiscale --
  -- inchangé en v1.2.
  if exists (
    select 1 from public.order_delivery_tax_allocations where order_id = new.id
  ) then
    return new;
  end if;

  -- Livraison gratuite : aucune ligne à écrire, TVA livraison nulle
  -- par construction (décision fiscale, section "FREE DELIVERY").
  -- Reste un état VALIDE, jamais une fermeture fiscale -- distinct par
  -- construction d'une commande delivery_fee>0 avec donnée incomplète
  -- (qui échoue désormais franchement, voir ci-dessous, LOT-C-12-01).
  if new.delivery_fee is null or new.delivery_fee = 0 then
    return new;
  end if;

  -- ==========================================================
  -- FERMETURE FAIL-CLOSED RÉELLE (LOT-C-12-01, v1.2)
  -- ==========================================================
  -- delivery_fee > 0 exige une ventilation TVA complète et
  -- déterministe. Si elle est impossible, LA TRANSACTION D'AUTORITÉ DE
  -- CRÉATION DE COMMANDE ÉCHOUE ENTIÈREMENT (raise exception dans un
  -- déclencheur AFTER UPDATE annule toute la transaction appelante,
  -- donc create_order au complet, y compris tous les order_items déjà
  -- insérés) -- AUCUNE commande partiellement fiscalisée n'est
  -- acceptée. Corrige le comportement v1.1 (`return new;` silencieux)
  -- qui était RÉELLEMENT fail-OPEN pour la finalisation fiscale
  -- (l'erreur v1.1 : documenté comme "fail-closed sans bloquer le
  -- checkout", mais une commande à TVA livraison incomplète ÉTAIT
  -- acceptée quand même -- CTO pre-control LOT-C-12-01). Erreur
  -- déterministe, errcode = '22023' (même convention que
  -- DRAFT-lot-delivery-financial-persistence-foundation-v1.sql).
  -- Aucun taux/règle fiscale n'est jamais inventé ici (toujours zéro
  -- fallback -- seule alternative à une ventilation complète et
  -- correcte est l'échec de la transaction, jamais une valeur
  -- inventée).

  -- (a) devise absente -- défensif (déjà NOT NULL en base sur
  -- orders.currency, mais gardé en profondeur -- mandat v1.1,
  -- "currency mismatch" listé explicitement comme condition de
  -- fermeture).
  if new.currency is null then
    raise exception 'SCANYM_DELIVERY_TAX_ALLOCATION: orders.currency manquant -- ventilation TVA livraison impossible, commande refusée (fail-closed)' using errcode = '22023';
  end if;

  -- (b) [RETIRÉE EN v1.3 -- CIO/CTO Décision 2, scope review] v1.2
  -- rejetait ici toute commande dont
  -- `tax_settings_snapshot_prices_include_tax IS DISTINCT FROM true`
  -- (marchand HT ou instantané absent), au motif que la formule de
  -- ventilation (net = round(gross/(1+rate/100),2)) supposerait
  -- strictement un prix client TTC. La scope review CIO/CTO a établi,
  -- par inspection exhaustive du dépôt, que ce motif était INEXACT :
  -- `prices_include_tax` est un réglage de PRÉSENTATION du ticket
  -- (`lib/receipt.ts` uniquement, RPC `upsertReceiptSettings`,
  -- checkbox `app/dashboard/settings/page.tsx`) -- il ne pilote NULLE
  -- PART le calcul du panier/de `create_order`/du frais de
  -- livraison/de `orders.total` (grep exhaustif du dépôt, zéro
  -- référence en dehors de la présentation du ticket). `order_items.
  -- line_total` est TOUJOURS le montant TTC réellement facturé au
  -- client, QUEL QUE SOIT ce réglage d'affichage -- la formule de
  -- ventilation reste donc valide indépendamment de
  -- `prices_include_tax`. Condition RETIRÉE : un marchand HT (ou sans
  -- instantané fiscal) n'est PLUS bloqué au checkout pour une commande
  -- à livraison payante -- corrige une régression de capacité
  -- checkout existante introduite par erreur en v1.2 (mandat v1.3,
  -- "REMOVE prices_include_tax HARD CHECKOUT BLOCK" : "Paid delivery
  -- MUST NOT be blocked merely because prices_include_tax = false").
  -- AUCUN nouveau moteur de tarification HT n'est introduit ici --
  -- la base d'allocation reste EXCLUSIVEMENT `order_items.line_total`
  -- (montant réellement facturé, immuable) groupé par
  -- `tax_rate_snapshot`, inchangée (mandat v1.3, "IMPORTANT SEMANTIC
  -- BOUNDARY").

  -- (c) toute ligne sans tax_rate_snapshot rend la ventilation entière
  -- inutilisable.
  if exists (
    select 1 from public.order_items oi
    where oi.order_id = new.id and oi.tax_rate_snapshot is null
  ) then
    raise exception 'SCANYM_DELIVERY_TAX_ALLOCATION: au moins une ligne order_items sans tax_rate_snapshot -- ventilation TVA livraison impossible, commande refusée (fail-closed)' using errcode = '22023';
  end if;

  -- (d) aucune ligne order_items.
  if not exists (select 1 from public.order_items oi where oi.order_id = new.id) then
    raise exception 'SCANYM_DELIVERY_TAX_ALLOCATION: aucune ligne order_items -- ventilation TVA livraison impossible, commande refusée (fail-closed)' using errcode = '22023';
  end if;

  select sum(line_total) into v_total_basis
  from public.order_items where order_id = new.id;

  -- (e) base totale d'allocation inutilisable (nulle/négative).
  if v_total_basis is null or v_total_basis <= 0 then
    raise exception 'SCANYM_DELIVERY_TAX_ALLOCATION: base d''allocation totale nulle ou négative -- ventilation TVA livraison impossible, commande refusée (fail-closed)' using errcode = '22023';
  end if;

  -- Ventilation proportionnelle, ordre déterministe (tax_rate_snapshot
  -- ASC) -- l'ordre d'itération n'affecte jamais le résultat par
  -- construction (chaque part est calculée indépendamment), mais un
  -- ordre stable est conservé pour la reproductibilité des tests/du
  -- résidu ci-dessous.
  for v_row in
    select tax_rate_snapshot as rate, sum(line_total) as basis
    from public.order_items
    where order_id = new.id
    group by tax_rate_snapshot
    order by tax_rate_snapshot asc
  loop
    v_share := round(new.delivery_fee * v_row.basis / v_total_basis, 2);
    v_net := round(v_share / (1 + v_row.rate / 100), 2);
    v_tax := v_share - v_net;
    v_allocated_gross := v_allocated_gross + v_share;

    insert into public.order_delivery_tax_allocations (
      order_id, tax_rate_snapshot, delivery_fee_gross_share,
      delivery_fee_net_share, delivery_fee_tax_amount, currency,
      allocation_method_version
    ) values (
      new.id, v_row.rate, v_share, v_net, v_tax, new.currency, 'v1'
    );
  end loop;

  -- ==========================================================
  -- RÉSIDU DE CENTIME -- RECALCUL, JAMAIS PATCH INDÉPENDANT
  -- (LOT-C-12-02, v1.2)
  -- ==========================================================
  -- Sélection du destinataire toujours déterministe : le taux le PLUS
  -- ÉLEVÉ (max(tax_rate_snapshot), inchangé depuis v1.1 -- "Keep
  -- deterministic recipient selection if still appropriate", mandat
  -- v1.2). CE QUI CHANGE : l'ancien patron v1.1
  -- (`gross += résidu; tax += résidu; net inchangé`) pouvait produire
  -- une TVA NÉGATIVE -- édge case reproduit et confirmé AVANT correctif
  -- (delivery_fee=0.01, deux groupes de base égale : parts arrondies
  -- indépendamment 0.01+0.01=0.02, résidu=-0.01 ; si le groupe au taux
  -- le plus élevé avait par ailleurs une TVA arrondie à 0.00, patcher
  -- tax seul donnait delivery_fee_tax_amount = -0.01, violant la
  -- contrainte CHECK ...tax_non_negative -- LOT-C-12-02). Nouveau
  -- patron, en 3 étapes, TOUJOURS dans cet ordre : (1) ajuster la part
  -- GROSS du destinataire ; (2) RECALCULER sa part NET à partir du
  -- gross ajusté (round(gross_new/(1+taux/100),2) -- jamais l'inverse,
  -- jamais indépendant) ; (3) RECALCULER tax = gross_new - net_new.
  -- Garantit gross = net + tax PAR CONSTRUCTION, jamais par coïncidence
  -- -- élimine structurellement toute possibilité de tax/net négatif
  -- pour ce mécanisme (une valeur négative ne peut plus survenir QUE si
  -- gross_new lui-même était négatif, ce qu'un résidu de ±1 centime sur
  -- une part déjà positive ne peut jamais produire pour un
  -- delivery_fee positif -- voir vérification de réconciliation finale
  -- ci-dessous, qui reste une garde de profondeur explicite au-delà des
  -- contraintes CHECK de la table).
  v_residual := new.delivery_fee - v_allocated_gross;
  if v_residual <> 0 then
    select max(tax_rate_snapshot) into v_top_rate
    from public.order_delivery_tax_allocations
    where order_id = new.id;

    select delivery_fee_gross_share into v_gross_new
    from public.order_delivery_tax_allocations
    where order_id = new.id and tax_rate_snapshot = v_top_rate;

    v_gross_new := v_gross_new + v_residual;
    v_net_new := round(v_gross_new / (1 + v_top_rate / 100), 2);
    v_tax_new := v_gross_new - v_net_new;

    update public.order_delivery_tax_allocations
      set delivery_fee_gross_share = v_gross_new,
          delivery_fee_net_share = v_net_new,
          delivery_fee_tax_amount = v_tax_new
      where order_id = new.id and tax_rate_snapshot = v_top_rate;
  end if;

  -- ==========================================================
  -- VÉRIFICATION FINALE DE RÉCONCILIATION (défense en profondeur,
  -- LOT-C-12-02) -- au-delà des contraintes CHECK par ligne de la
  -- table (qui ne peuvent pas exprimer une somme inter-lignes), garde
  -- explicite avec message diagnostique clair. sum(gross) doit
  -- toujours égaler EXACTEMENT orders.delivery_fee (mandat : "sum(all
  -- gross shares) = orders.delivery_fee exactly").
  -- ==========================================================
  select sum(delivery_fee_gross_share) into v_sum_check
  from public.order_delivery_tax_allocations
  where order_id = new.id;

  if v_sum_check is distinct from new.delivery_fee then
    raise exception 'SCANYM_DELIVERY_TAX_ALLOCATION: réconciliation de la ventilation TVA livraison échouée (somme des parts % != delivery_fee %) -- commande refusée (fail-closed)', v_sum_check, new.delivery_fee using errcode = '22023';
  end if;

  if exists (
    select 1 from public.order_delivery_tax_allocations
    where order_id = new.id
      and (delivery_fee_gross_share < 0 or delivery_fee_net_share < 0 or delivery_fee_tax_amount < 0)
  ) then
    raise exception 'SCANYM_DELIVERY_TAX_ALLOCATION: ventilation TVA livraison invalide (montant négatif détecté après résidu) -- commande refusée (fail-closed)' using errcode = '22023';
  end if;

  return new;
end;
$function$;

comment on function public.compute_delivery_fee_tax_allocation() is
  'STUART LOT C v1.3 — déclencheur AFTER UPDATE OF delivery_fee ON orders. Ventile orders.delivery_fee (déjà autoritatif) entre les taux de order_items.tax_rate_snapshot (déjà autoritatifs, tous insérés avant cette mise à jour dans la même transaction create_order), au prorata de line_total (base TTC = montant réellement facturé au client, indépendant du réglage d''affichage prices_include_tax -- v1.3, CIO/CTO Décision 2). Écriture unique, immuable. FAIL-CLOSED RÉEL (LOT-C-12-01, v1.2) : pour delivery_fee>0, toute donnée fiscale incomplète/incohérente (tax_rate_snapshot manquant, aucune ligne, base<=0, devise absente) fait ÉCHOUER LA TRANSACTION create_order ENTIÈRE (raise exception, errcode 22023) -- corrige le comportement fail-open v1.1. La précondition prices_include_tax=true (ajoutée à tort en v1.2) est RETIRÉE en v1.3 -- ne bloque plus le checkout d''un marchand HT. Résidu de centime recalculé (gross->net->tax, jamais patché indépendamment, LOT-C-12-02) avec vérification de réconciliation finale explicite.';

create trigger trg_compute_delivery_fee_tax_allocation
  after update of delivery_fee on public.orders
  for each row
  execute function public.compute_delivery_fee_tax_allocation();

commit;
