import type { DashboardOrder, ReceiptSettings } from "@/lib/dashboard-types";
import { formatPrice } from "@/lib/whatsapp";
import { translate, type Lang } from "@/lib/i18n";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function serviceLabel(order: DashboardOrder, lang: Lang): string {
  const t = (k: string, p?: Record<string, string | number>) => translate(lang, k, p);
  if (order.service_mode === "table")
    return t("rcTable", { n: order.table_number ?? "-" });
  if (order.service_mode === "pickup") return t("rcPickup");
  return t("rcDelivery");
}

// ============================================================
// STUART LOT C v1.2/v1.3 (LOT-C-12-03, puis CIO/CTO Décision 1 v1.3)
// -- REMÉDIATION CTO PRE-CONTROL + SCOPE REVIEW
// ============================================================
// Le CTO pre-control a jugé la classification v1.1 de ce fichier
// ("classe A / unchanged") incorrecte pour LOT C : le bloc fiscal
// ci-dessus (avant ce commentaire, INCHANGÉ) applique TOUJOURS le SEUL
// taux marchand par défaut (tax_settings_snapshot_default_tax_rate) à
// orders.total EN BLOC -- faux dès qu'une commande porte plusieurs
// taux TVA produits, situation que LOT C v1.1 rend désormais RÉELLE
// (order_items.tax_rate_snapshot par produit + ventilation TVA du
// frais de livraison, order_delivery_tax_allocations).
//
// Correctif MINIMAL et CIBLÉ (PAS une réécriture substantielle de
// l'architecture ticket -- confiné à ce fichier + 2 fichiers de type
// annexes, aucune nouvelle page/route, aucun changement du
// déclenchement d'impression) : une branche multi-taux, active
// UNIQUEMENT quand les 3 conditions ci-dessous tiennent TOUTES :
//   1. hasTaxSnapshot -- instantané fiscal marchand disponible ;
//   2. pricesIncludeTax === true -- GARDE DE COMPATIBILITÉ CONSERVÉE EN
//      v1.3 (mandat v1.3, "HT RECEIPT COMPATIBILITY" : "If the existing
//      mixed-rate receipt branch is currently gated to TTC mode, that
//      compatibility gate MAY remain") -- NOTE v1.3 : cette garde
//      N'EST PLUS requise par le déclencheur SQL lui-même (la
//      précondition prices_include_tax=true a été RETIRÉE du
//      déclencheur, voir DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql,
//      CIO/CTO Décision 2) -- elle reste ici uniquement pour ne PAS
//      construire un moteur de rendu ticket multi-taux HT non demandé
//      ("Do not claim that LOT C provides a complete new multi-rate HT
//      receipt engine. That is outside this lot"). Un marchand HT
//      garde donc le repli PLAT existant (inchangé) pour son ticket,
//      MÊME SI sa commande porte désormais une ventilation TVA
//      livraison persistée (le checkout n'est plus bloqué, v1.3
//      Décision 2) ;
//   3. itemsHaveRateSnapshots -- CHAQUE order_items[].tax_rate_snapshot
//      est renseigné (jamais un taux inventé pour une ligne
//      manquante).
// Repli INCHANGÉ (comportement byte-for-byte identique à v1.1) dans
// tous les autres cas -- commande historique/HT/incomplète : le bloc
// existant ci-dessus reste l'unique chemin, sans aucune régression.
//
// Source des données EXCLUSIVEMENT des instantanés déjà persistés,
// SERVEUR-AUTORITATIFS et IMMUABLES : order_items.tax_rate_snapshot
// (RECEIPT / INVOICE TAX DETAIL v1.1) et
// order.order_delivery_tax_allocations (LOT C v1.1/v1.2/v1.3, déjà
// calculée et persistée par compute_delivery_fee_tax_allocation() --
// AUCUN recalcul de delivery_fee_gross_share/_net_share/_tax_amount
// ici, seulement une LECTURE DIRECTE, "no duplicated calculation" --
// voir buildMixedRateTaxGroups() ci-dessous pour le détail de la
// correction v1.3, CIO/CTO Décision 1). Jamais menu_items.tax_rate
// courant, ni le taux marchand courant (même discipline que
// MLTP-V1-HISTORICAL-TAX-01) -- historique garanti même après un
// changement de configuration marchand. `provider_cost` et
// `delivery_merchant_subsidy` ne sont NI lus NI exposés ici
// (LOT-C-BIZ-01, mandat v1.1 "public/internal exposure").
//
// Équivalence à taux unique -- NUANCÉE en v1.3 (ne PAS surdéclarer une
// garantie mathématique universelle) : depuis v1.3, le côté produit et
// le côté livraison sont chacun arrondis SÉPARÉMENT puis SOMMÉS
// (jamais fusionnés avant arrondi, voir Décision 1) -- c'est
// EXACTEMENT la correction requise pour fermer la divergence
// confirmée par le CTO (§ buildMixedRateTaxGroups). Pour une commande
// à un seul taux, cette somme de deux arrondis séparés COÏNCIDE avec
// l'ancien calcul plat à arrondi unique dans le cas standard (vérifié
// par test, voir tests/cart-and-price.test.ts) -- mais AUCUNE garantie
// mathématique universelle n'est faite que les deux méthodes
// produisent TOUJOURS le même centime dans un cas limite arbitraire :
// sommer deux montants indépendamment arrondis peut légitimement
// différer d'un arrondi unique de leur somme de ±0,01 dans un cas
// limite pathologique -- c'est un compromis ACCEPTÉ et VOULU (mandat
// v1.3, Décision 1), puisque c'est précisément en arrondissant à la
// frontière combinée que v1.2 divergeait de l'instantané TVA livraison
// autoritatif. Aucune régression n'a été observée sur les scénarios
// testés.
// ============================================================

interface MixedRateTaxGroup {
  rate: number;
  gross: number;
  net: number;
  tax: number;
}

/**
 * Arrondi déterministe à 2 décimales -- même convention que
 * `roundMoney2` (lib/delivery-pricing-policy.ts) et que le
 * déclencheur SQL `compute_delivery_fee_tax_allocation()`
 * (`round(x,2)`, arrondi au plus proche). Toutes les valeurs traitées
 * ici sont des sommes de montants déjà non négatifs
 * (`order_items.line_total >= 0`,
 * `delivery_fee_gross_share/net_share/tax_amount >= 0`, contraintes
 * CHECK persistées) -- `Math.round` suffit.
 */
function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * STUART LOT C v1.3 (CIO/CTO Décision 1, ex-Finding 1 de la scope
 * review) -- CORRIGE une divergence d'arrondi confirmée en v1.2.
 *
 * v1.2 (RÉVOLU) fusionnait la base produit TTC et le
 * `delivery_fee_gross_share` DÉJÀ PERSISTÉ en UNE SEULE somme par
 * taux, puis dérivait net/tax de cette somme combinée -- ce qui
 * change la frontière d'arrondi et peut diverger de l'instantané TVA
 * livraison réellement persisté (`delivery_fee_net_share`/
 * `delivery_fee_tax_amount`, jamais lus par v1.2). Cas concret
 * confirmé par le CTO : taux 20%, gross produit=0.01, ventilation
 * livraison persistée gross=0.03/net=0.03/tax=0.00 -- v1.2 affichait
 * gross=0.04/net=0.03/tax=0.01 (combiné puis arrondi une fois), alors
 * que l'instantané autoritatif est gross=0.04/net=0.04/tax=0.00.
 *
 * v1.3 (CORRIGÉ) : CHAQUE composante est calculée dans sa PROPRE
 * frontière d'arrondi, jamais fusionnée avant arrondi :
 *   - CÔTÉ PRODUIT : net/tax DÉRIVÉS depuis le gross produit SEUL
 *     (`round(productGross/(1+rate/100),2)`, même formule qu'avant --
 *     order_items ne persiste aucun net/tax, seulement line_total
 *     (gross) + tax_rate_snapshot, donc le côté produit reste
 *     nécessairement dérivé, jamais un recalcul du côté serveur).
 *   - CÔTÉ LIVRAISON : `delivery_fee_gross_share`/`_net_share`/
 *     `_tax_amount` LUS TELS QUELS depuis
 *     `order.order_delivery_tax_allocations` -- AUCUN recalcul, y
 *     compris pour une ligne ayant reçu l'ajustement de résidu de
 *     centime côté SQL (compute_delivery_fee_tax_allocation()) : cet
 *     ajustement DOIT survivre intact jusqu'au ticket, jamais être
 *     re-dérivé ici ("no duplicated calculation").
 *   - COMBINÉ (par taux) : gross = productGross + deliveryGross ;
 *     net = productNet + deliveryNet ; tax = productTax + deliveryTax.
 *     `gross = net + tax` tient PAR CONSTRUCTION (somme de deux paires
 *     déjà cohérentes chacune), sans aucun arrondi supplémentaire à la
 *     frontière combinée.
 *
 * Retourne un tableau VIDE si une donnée est incohérente (ex. taux de
 * ventilation livraison sans ligne produit correspondante -- ne
 * devrait jamais survenir par construction du déclencheur SQL, mais
 * jamais de rendu multi-taux fabriqué si c'était pourtant le cas) --
 * l'appelant se replie alors sur le calcul à taux unique existant.
 */
function buildMixedRateTaxGroups(order: DashboardOrder): MixedRateTaxGroup[] {
  const productByRate = new Map<number, { gross: number; net: number; tax: number }>();

  for (const item of order.order_items) {
    if (item.tax_rate_snapshot === null || item.tax_rate_snapshot === undefined) {
      return [];
    }
    const rate = Number(item.tax_rate_snapshot);
    const prior = productByRate.get(rate);
    productByRate.set(rate, {
      gross: roundCents((prior?.gross ?? 0) + Number(item.line_total)),
      net: 0,
      tax: 0,
    });
  }
  // Dérivation produit -- frontière d'arrondi PROPRE au côté produit,
  // jamais fusionnée avec le côté livraison avant ce calcul.
  for (const [rate, group] of productByRate) {
    const net = roundCents(group.gross / (1 + rate / 100));
    productByRate.set(rate, { gross: group.gross, net, tax: roundCents(group.gross - net) });
  }

  const deliveryByRate = new Map<number, { gross: number; net: number; tax: number }>();
  for (const allocation of order.order_delivery_tax_allocations ?? []) {
    const rate = Number(allocation.tax_rate_snapshot);
    if (!productByRate.has(rate)) {
      return [];
    }
    // Lecture DIRECTE de l'instantané déjà persisté -- AUCUN recalcul,
    // AUCUNE fusion avec le gross produit avant d'obtenir net/tax.
    deliveryByRate.set(rate, {
      gross: Number(allocation.delivery_fee_gross_share),
      net: Number(allocation.delivery_fee_net_share),
      tax: Number(allocation.delivery_fee_tax_amount),
    });
  }

  return Array.from(productByRate.entries())
    .sort(([rateA], [rateB]) => rateA - rateB)
    .map(([rate, product]) => {
      const delivery = deliveryByRate.get(rate) ?? { gross: 0, net: 0, tax: 0 };
      return {
        rate,
        gross: roundCents(product.gross + delivery.gross),
        net: roundCents(product.net + delivery.net),
        tax: roundCents(product.tax + delivery.tax),
      };
    });
}

/**
 * STUART LOT C v1.4 (LOT-C-HISTORICAL-DELIVERY-TAX-01, post-v1.3 scope
 * review) -- garde de COMPLÉTUDE de l'instantané TVA livraison,
 * ÉVALUÉE AVANT d'autoriser buildMixedRateTaxGroups() à produire un
 * rendu. AUCUN recalcul, AUCUNE réparation ici -- uniquement une
 * décision booléenne "l'instantané persistant est-il assez complet et
 * cohérent pour être affiché tel quel ?".
 *
 * Pourquoi cette garde est nécessaire : `order_items.tax_rate_snapshot`
 * provient d'un lot ANTÉRIEUR et INDÉPENDANT (RECEIPT / INVOICE TAX
 * DETAIL v1.1), tandis que `order_delivery_tax_allocations` n'existe
 * que depuis LOT C v1.1. Une commande historique peut donc légitimement
 * porter des lignes produit entièrement fiscalisées
 * (`itemsHaveRateSnapshots === true`) ET `delivery_fee > 0` ET un
 * tableau `order_delivery_tax_allocations` VIDE (créée avant LOT C) --
 * sans qu'aucune des conditions d'éligibilité précédentes (v1.2/v1.3)
 * ne le détecte. `buildMixedRateTaxGroups()` traitait alors ce vide
 * comme `{gross:0,net:0,tax:0}` (`deliveryByRate.get(rate) ?? {...}`)
 * -- une TVA livraison FABRIQUÉE à zéro, alors que le frais de
 * livraison lui-même reste inclus dans `order.total`, provoquant un
 * écart de réconciliation visible sur le ticket (Total HT + somme des
 * lignes TVA != Total TTC).
 *
 * Décision CIO/CTO v1.4 (section "IMPORTANT CIO/CTO SAFETY DECISION") :
 * si l'instantané est incomplet, NE JAMAIS fabriquer de TVA livraison à
 * zéro, et NE JAMAIS reclasser la commande vers l'ancien calcul PLAT à
 * taux marchand unique (ce calcul appliquerait ce taux à `order.total`
 * EN BLOC, y compris la part livraison dont la TVA réelle est
 * précisément inconnue -- une décomposition tout aussi fabriquée). La
 * SEULE alternative sûre est la SUPPRESSION complète de la
 * décomposition HT/TVA détaillée pour ce ticket (repli "option B",
 * même principe déjà établi par MERCHANT LEGAL & TAX PROFILE v1.1 pour
 * un instantané fiscal marchand absent -- voir commentaire en tête de
 * buildReceiptHtml) -- seul le total autoritaire déjà persisté
 * (`order.total`) reste affiché.
 *
 * Complétude vérifiée (mandat v1.4, section "COMPLETENESS GUARD"),
 * dans l'ordre :
 *   1. le tableau d'allocation n'est pas vide ;
 *   2. aucune ligne ne porte un `tax_rate_snapshot` absent de
 *      `productRates` (pas de taux orphelin) ;
 *   3. chaque taux de `productRates` a une ligne d'allocation
 *      correspondante (pas de taux produit manquant -- LA correction
 *      de ce lot, absente en v1.2/v1.3) ;
 *   4. aucun taux n'apparaît deux fois (pas de doublon) ;
 *   5. la somme des `delivery_fee_gross_share` égale EXACTEMENT le
 *      frais de livraison dérivé (`order.total - order.subtotal`,
 *      comparaison cent-safe via roundCents -- même convention que le
 *      déclencheur SQL, "sum(all gross shares) = orders.delivery_fee
 *      exactly") ;
 *   6. chaque ligne est non négative (gross/net/tax >= 0) et vérifie
 *      gross = net + tax (comparaison cent-safe).
 *
 * `deliveryFeeGross <= 0` (livraison gratuite, ou dérive anormale
 * jamais attendue) : aucune ventilation n'est requise, retourne
 * toujours `true` -- inchangé, comportement livraison gratuite
 * préservé (mandat v1.4, section "FREE DELIVERY").
 *
 * Bien qu'un ensemble PARTIEL (taux orphelin/manquant/dupliqué,
 * somme incohérente, ligne gross != net + tax) ne soit structurellement
 * PAS atteignable par le chemin d'écriture actuel
 * (`compute_delivery_fee_tax_allocation()` : un seul INSERT, une ligne
 * par taux produit distinct, tout-ou-rien par transaction -- confirmé
 * par revue de périmètre), cette fonction le traite DÉFENSIVEMENT
 * comme incomplet plutôt que de supposer qu'il ne peut jamais survenir
 * (mandat v1.4, section "PARTIAL / CORRUPT SNAPSHOT" : "treat it
 * defensively as incomplete... Do NOT attempt repair at read time").
 */
function hasCompleteDeliveryTaxSnapshot(
  productRates: number[],
  allocations: { tax_rate_snapshot: number; delivery_fee_gross_share: number; delivery_fee_net_share: number; delivery_fee_tax_amount: number }[],
  deliveryFeeGross: number
): boolean {
  if (deliveryFeeGross <= 0) {
    return true;
  }
  if (allocations.length === 0) {
    return false;
  }

  const seenRates = new Set<number>();
  let grossSum = 0;

  for (const row of allocations) {
    const rate = Number(row.tax_rate_snapshot);
    const gross = Number(row.delivery_fee_gross_share);
    const net = Number(row.delivery_fee_net_share);
    const tax = Number(row.delivery_fee_tax_amount);

    // (4) pas de taux dupliqué.
    if (seenRates.has(rate)) return false;
    seenRates.add(rate);

    // (2) pas de taux orphelin (sans groupe produit correspondant).
    if (!productRates.includes(rate)) return false;

    // (6) montants non négatifs, gross = net + tax (cent-safe).
    if (gross < 0 || net < 0 || tax < 0) return false;
    if (roundCents(gross) !== roundCents(net + tax)) return false;

    grossSum = roundCents(grossSum + gross);
  }

  // (3) chaque taux produit doit avoir une ligne d'allocation
  // correspondante -- une ventilation qui n'en couvre pas un est
  // incomplète (état historique/partiel), jamais comblée par zéro.
  for (const rate of productRates) {
    if (!seenRates.has(rate)) return false;
  }

  // (5) réconciliation exacte avec le frais de livraison dérivé.
  if (roundCents(grossSum) !== roundCents(deliveryFeeGross)) return false;

  return true;
}

export function buildReceiptHtml(params: {
  order: DashboardOrder;
  restaurantName: string;
  settings: ReceiptSettings | null;
}, lang: Lang = "fr"): string {
  const { order, restaurantName, settings } = params;
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  const width = settings?.paper_width_mm ?? 58;

  // MERCHANT LEGAL & TAX PROFILE v1.1 -- ferme MLTP-V1-HISTORICAL-TAX-01.
  //
  // AVANT v1.1, ce bloc lisait TOUJOURS les réglages fiscaux COURANTS
  // (settings?.default_tax_rate / .prices_include_tax / .show_tax_summary
  // / .tax_label), quelle que soit la date de la commande. Tant que
  // receipt_settings était en lecture seule (v1, avant l'écriture
  // marchand), ce défaut était latent -- ces réglages ne changeaient
  // jamais. MERCHANT LEGAL & TAX PROFILE v1 les rend éditables par le
  // marchand : réimprimer une ANCIENNE commande après un changement de
  // taux/option affichait alors une décomposition HT/TVA/TTC
  // rétroactivement FAUSSE (constat bloquant de l'audit Work,
  // MLTP-V1-HISTORICAL-TAX-01).
  //
  // Stratégie retenue (option A -- instantané immuable, voir
  // supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql section 5 et
  // HISTORICAL-TAX-STRATEGY.md du package d'audit v1.1) : la
  // décomposition fiscale utilise EXCLUSIVEMENT l'instantané figé au
  // moment de la commande (order.tax_settings_snapshot_*, capturé par
  // un déclencheur BEFORE INSERT sur orders, jamais recalculé
  // ensuite) -- JAMAIS les réglages COURANTS du marchand pour ce
  // calcul. `menu_items.tax_rate` n'est délibérément PAS utilisé ici
  // (mandat : "Do NOT silently make menu_items.tax_rate authoritative
  // for old orders" -- ce calcul reste le taux PLAT par restaurant,
  // désormais figé par commande, jamais un taux par produit).
  //
  // Repli (option B, mandat : "for orders without sufficient
  // immutable tax data, suppress the tax breakdown and display only
  // the authoritative historical order total") : une commande sans
  // instantané (antérieure à ce lot, ou restaurant sans aucune ligne
  // receipt_settings au moment de la commande --
  // `tax_settings_snapshot_prices_include_tax === null`, même
  // convention de marqueur de complétude que
  // order_items.weight_is_approximate_snapshot dans RECEIPT / INVOICE
  // TAX DETAIL v1.1) n'affiche JAMAIS de décomposition HT/TVA/TTC
  // fabriquée -- uniquement le total autoritaire de la commande
  // (order.total, inchangé, toujours l'unique autorité financière).
  //
  // Les champs d'AFFICHAGE du profil marchand (business_name,
  // legal_name, legal_address, phone, tax_identifier,
  // registration_number, footer_text, paper_width_mm ci-dessus)
  // restent volontairement pilotés par les réglages COURANTS : ce sont
  // des informations d'identité/de présentation du commerce, pas un
  // calcul de taxe -- un commerçant qui change son adresse légale
  // affichée veut que TOUS ses tickets, y compris une réimpression
  // d'ancienne commande, reflètent l'adresse ACTUELLE. Seule la
  // décomposition fiscale (HT/TVA/TTC) est concernée par
  // MLTP-V1-HISTORICAL-TAX-01 et donc par ce figement.
  const hasTaxSnapshot = order.tax_settings_snapshot_prices_include_tax !== null
    && order.tax_settings_snapshot_prices_include_tax !== undefined;
  const rate = hasTaxSnapshot ? Number(order.tax_settings_snapshot_default_tax_rate ?? 0) : 0;
  const pricesIncludeTax = hasTaxSnapshot
    ? Boolean(order.tax_settings_snapshot_prices_include_tax)
    : false;
  const taxLabel = hasTaxSnapshot
    ? (order.tax_settings_snapshot_tax_label || "TVA")
    : (settings?.tax_label || "TVA");
  const showTax = hasTaxSnapshot
    && Boolean(order.tax_settings_snapshot_show_tax_summary && rate > 0);
  const total = Number(order.total);
  const taxAmount = showTax
    ? pricesIncludeTax
      ? total - total / (1 + rate / 100)
      : total * (rate / 100)
    : 0;
  const excludingTax = pricesIncludeTax ? total - taxAmount : total;
  const includingTax = pricesIncludeTax ? total : total + taxAmount;

  // STUART LOT C v1.2 (LOT-C-12-03) -- voir bloc de commentaires
  // au-dessus de buildMixedRateTaxGroups() pour le détail des 3
  // conditions d'éligibilité. Le bloc flat ci-dessus reste
  // TOTALEMENT INCHANGÉ et sert de repli dans tous les autres cas.
  const itemsHaveRateSnapshots =
    order.order_items.length > 0 &&
    order.order_items.every(
      (item) => item.tax_rate_snapshot !== null && item.tax_rate_snapshot !== undefined
    );

  // STUART LOT C v1.4 (LOT-C-HISTORICAL-DELIVERY-TAX-01) -- frais de
  // livraison DÉRIVÉ (aucune colonne delivery_fee n'est sélectionnée
  // par lib/services/dashboard.ts / exposée sur DashboardOrder --
  // invariant déjà établi et testé ailleurs dans ce dépôt : "total =
  // subtotal + delivery_fee toujours vrai" -- voir
  // delivery-financial-persistence-foundation-v1-check.sh, [4]).
  // Comparaison cent-safe via roundCents, jamais une soustraction
  // flottante brute comparée directement.
  const deliveryFeeGross = roundCents(Number(order.total) - Number(order.subtotal));
  const productTaxRates = itemsHaveRateSnapshots
    ? Array.from(new Set(order.order_items.map((item) => Number(item.tax_rate_snapshot))))
    : [];
  const hasCompleteDeliverySnapshot = hasCompleteDeliveryTaxSnapshot(
    productTaxRates,
    order.order_delivery_tax_allocations ?? [],
    deliveryFeeGross
  );
  const canUseMixedRateSnapshot =
    hasTaxSnapshot && pricesIncludeTax === true && itemsHaveRateSnapshots && hasCompleteDeliverySnapshot;
  const mixedRateGroups = canUseMixedRateSnapshot ? buildMixedRateTaxGroups(order) : [];

  // STUART LOT C v1.4 -- une commande par ailleurs éligible au rendu
  // multi-taux (instantané fiscal marchand présent, TTC, toutes les
  // lignes produit fiscalisées) mais dont l'instantané TVA livraison
  // est incomplet/incohérent alors que delivery_fee > 0 NE DOIT PAS
  // retomber sur l'ancien calcul PLAT (celui-ci appliquerait le taux
  // marchand par défaut à `order.total` EN BLOC, y compris la part
  // livraison dont la TVA réelle est inconnue -- une décomposition
  // tout aussi fabriquée que la TVA à zéro qu'il remplacerait, mandat
  // v1.4 "IMPORTANT CIO/CTO SAFETY DECISION"). Dans ce cas précis,
  // force le repli "option B" (total autoritaire seul, aucune
  // décomposition HT/TVA) -- ne change RIEN pour tout autre état
  // (marchand HT, commande sans instantané par ligne, instantané
  // complet) : voir usage de ce drapeau au niveau du rendu ci-dessous.
  const suppressVatBreakdownForIncompleteHistory =
    hasTaxSnapshot &&
    pricesIncludeTax === true &&
    itemsHaveRateSnapshots &&
    deliveryFeeGross > 0 &&
    !hasCompleteDeliverySnapshot;
  const showTaxSummarySetting =
    hasTaxSnapshot && Boolean(order.tax_settings_snapshot_show_tax_summary);
  // STUART LOT C v1.5 (LOT-C-RECEIPT-ZERO-RATE-01, post-v1.4 failed-audit
  // scope review, Cat Stevens) -- CORRIGE une exigence erronée : v1.2/v1.3/
  // v1.4 exigeaient qu'AU MOINS un groupe de `mixedRateGroups` porte un
  // taux STRICTEMENT POSITIF (`.some((g) => g.rate > 0)`) pour activer le
  // rendu par instantané -- alors qu'un instantané COMPLET et
  // AUTORITATIF composé UNIQUEMENT de taux à 0% (légal : `order_items.
  // tax_rate_snapshot` et `order_delivery_tax_allocations.tax_rate_
  // snapshot` acceptent tous deux explicitement 0, contraintes CHECK
  // `>= 0 and <= 100`) est tout aussi valide qu'un instantané portant un
  // taux positif -- rien dans sa complétude/cohérence ne dépend du signe
  // du taux. L'ancienne condition faisait donc REJETER un instantané
  // pourtant déjà validé COMPLET par `canUseMixedRateSnapshot` (lui-même
  // inchangé, y compris la garde de complétude v1.4
  // `hasCompleteDeliveryTaxSnapshot`), et retombait sur l'ancien calcul
  // PLAT à taux marchand par défaut -- lequel pouvait fabriquer une TVA
  // positive totalement absente de l'instantané persistant (cas confirmé
  // par l'audit Stevens : instantané complet 100% à taux 0%, taux
  // marchand par défaut 20%, TVA fabriquée à 2,00 € au lieu de 0,00 €).
  //
  // Correctif MINIMAL : l'éligibilité au rendu par instantané ne dépend
  // plus QUE de la complétude déjà validée (`canUseMixedRateSnapshot`) et
  // de la présence d'au moins un groupe (`mixedRateGroups.length > 0`,
  // garde défensive résiduelle -- toujours vraie par construction dès que
  // `canUseMixedRateSnapshot` tient, `order_items` étant alors non vide).
  // AUCUN changement à `canUseMixedRateSnapshot`,
  // `hasCompleteDeliveryTaxSnapshot`, ni à l'arithmétique de
  // `buildMixedRateTaxGroups` -- seule cette exigence de signe, en trop,
  // est retirée.
  //
  // Convention de présentation à 0% INCHANGÉE (décision CIO/CTO v1.5,
  // section "0% PRESENTATION DECISION") : le filtre existant
  // `mixedRateGroups.filter((g) => g.rate > 0)` (ligne de rendu des
  // lignes "TVA {taux}%", INCHANGÉ ci-dessous) continue de n'afficher une
  // ligne TVA explicite QUE pour un taux strictement positif -- un
  // instantané exclusivement à 0% affiche donc Total HT = Total TTC,
  // SANS ligne "TVA 0%" explicite (intentionnel, pas un oubli) -- mais
  // avec la valeur CORRECTE, jamais fabriquée. Un instantané mixte (ex.
  // 0%+5,5% ou 0%+20%) continue d'afficher sa ligne TVA positive comme
  // avant (comportement déjà correct, non modifié) ; la part HT du
  // groupe à 0% continue de contribuer normalement à `mixedRateTotalNet`
  // (aucun filtre sur ce total, inchangé).
  const useMixedRateRendering =
    canUseMixedRateSnapshot &&
    showTaxSummarySetting &&
    mixedRateGroups.length > 0;
  const mixedRateTotalNet = useMixedRateRendering
    ? roundCents(mixedRateGroups.reduce((acc, g) => acc + g.net, 0))
    : 0;

  const itemRows = order.order_items
    .map(
      (item) => `
        <div class="item-row">
          <div><strong>${item.quantity} x ${esc(item.item_name)}</strong>${
            item.option_name ? `<div class="option">+ ${esc(item.option_name)}</div>` : ""
          }</div>
          <div>${esc(formatPrice(Number(item.line_total), order.currency))}</div>
        </div>`
    )
    .join("");

  const customer = [
    order.customer_name,
    order.customer_phone,
    order.delivery_address,
  ]
    .filter(Boolean)
    .map((line) => `<div>${esc(String(line))}</div>`)
    .join("");

  return `<!doctype html>
<html lang="${esc(order.customer_language || "fr")}" dir="auto">
<head>
<meta charset="utf-8" />
<title>${esc(t("rcOrder", { n: order.order_number }))}</title>
<style>
  @page { size: ${width}mm auto; margin: 3mm; }
  * { box-sizing: border-box; }
  body { width: ${width - 6}mm; margin: 0; font-family: Arial, "Noto Sans Arabic", sans-serif; color: #111; font-size: 11px; }
  h1 { margin: 0; font-size: 16px; text-align: center; }
  .center { text-align: center; }
  .muted { color: #444; }
  .rule { border-top: 1px dashed #111; margin: 8px 0; }
  .item-row, .total-row { display: flex; justify-content: space-between; gap: 8px; margin: 6px 0; }
  .item-row > div:first-child { flex: 1; }
  .option { padding-inline-start: 10px; font-size: 10px; }
  .grand-total { font-size: 14px; font-weight: 700; }
  .footer { margin-top: 10px; text-align: center; white-space: pre-wrap; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <h1>${esc(settings?.business_name || restaurantName)}</h1>
  ${settings?.legal_name ? `<div class="center">${esc(settings.legal_name)}</div>` : ""}
  ${settings?.legal_address ? `<div class="center muted">${esc(settings.legal_address)}</div>` : ""}
  ${settings?.phone ? `<div class="center muted">${esc(settings.phone)}</div>` : ""}
  ${settings?.tax_identifier ? `<div class="center muted">${esc(settings.tax_label)}: ${esc(settings.tax_identifier)}</div>` : ""}
  ${settings?.registration_number ? `<div class="center muted">N°: ${esc(settings.registration_number)}</div>` : ""}
  <div class="rule"></div>
  <div><strong>${esc(t("rcOrder", { n: order.order_number }))}</strong></div>
  <div>${esc(new Date(order.created_at).toLocaleString("fr-FR"))}</div>
  <div><strong>${esc(serviceLabel(order, lang))}</strong></div>
  ${customer}
  ${order.customer_note ? `<div>Note: ${esc(order.customer_note)}</div>` : ""}
  <div class="rule"></div>
  ${itemRows}
  <div class="rule"></div>
  ${useMixedRateRendering ? `
    <div class="total-row"><span>Total HT</span><span>${esc(formatPrice(mixedRateTotalNet, order.currency))}</span></div>
    ${mixedRateGroups
      .filter((g) => g.rate > 0)
      .map(
        (g) =>
          `<div class="total-row"><span>${esc(taxLabel)} ${g.rate}%</span><span>${esc(formatPrice(g.tax, order.currency))}</span></div>`
      )
      .join("")}
    <div class="total-row grand-total"><span>Total TTC</span><span>${esc(formatPrice(total, order.currency))}</span></div>
  ` : (showTax && !suppressVatBreakdownForIncompleteHistory) ? `
    <div class="total-row"><span>Total HT</span><span>${esc(formatPrice(excludingTax, order.currency))}</span></div>
    <div class="total-row"><span>${esc(taxLabel)} ${rate}%</span><span>${esc(formatPrice(taxAmount, order.currency))}</span></div>
    <div class="total-row grand-total"><span>Total TTC</span><span>${esc(formatPrice(includingTax, order.currency))}</span></div>
  ` : `
    <div class="total-row grand-total"><span>${esc(t("rcTotal"))}</span><span>${esc(formatPrice(total, order.currency))}</span></div>
  `}
  ${settings?.footer_text ? `<div class="footer">${esc(settings.footer_text)}</div>` : ""}
  <script>window.addEventListener('load', () => { window.print(); });</script>
</body>
</html>`;
}

export function printReceipt(params: {
  order: DashboardOrder;
  restaurantName: string;
  settings: ReceiptSettings | null;
}, lang: Lang = "fr"): void {
  const popup = window.open("", "_blank", "width=420,height=720");
  if (!popup) throw new Error("Le navigateur a bloque la fenetre d'impression.");
  popup.document.open();
  popup.document.write(buildReceiptHtml(params, lang));
  popup.document.close();
}
