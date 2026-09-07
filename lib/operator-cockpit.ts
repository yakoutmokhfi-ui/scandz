/**
 * OB-1 — OPERATOR COCKPIT FOUNDATION.
 *
 * Logique PURE (aucun accès réseau/Supabase ici, volontairement) —
 * types partagés, dérivation des statuts de section, filtrage du
 * répertoire opérateur. Séparée des pages/services pour rester
 * testable directement (mêmes conventions que lib/establishment-text.ts
 * : import direct dans les tests, sans variable d'environnement
 * Supabase à fournir).
 *
 * PÉRIMÈTRE OB-1 : ce fichier ne fait QUE de l'orchestration de
 * lecture et de l'affichage. Aucune fonction ici n'écrit quoi que ce
 * soit, n'appelle une RPC de mutation, ni ne contourne une
 * autorisation existante — voir OB1-IMPLEMENTATION-SUMMARY.md (v1) et
 * OB1-V1.1-IMPLEMENTATION-SUMMARY.md (v1.1) pour le détail des
 * lectures réutilisées et des sections volontairement laissées
 * "unavailable" (accès opérateur pas encore publié côté backend pour
 * ces chemins précis).
 *
 * v1.1 : CATALOGUE (via get_merchant_catalogue, désormais opérateur-
 * autorisé depuis OB-2 v1.1) et PHOTOS (dérivé du même résultat déjà
 * chargé, aucun appel Storage) ne sont plus "unavailable" par défaut —
 * voir summarizeCatalogue/deriveCatalogueStatus/derivePhotosStatus
 * ci-dessous. PAYMENT et DELIVERY restent "unavailable" (re-vérifié :
 * aucun changement de ces RPC dans la publication OB-2 v1.1).
 */

/**
 * Statut d'affichage d'une section du cockpit.
 *
 *  - "ready"                : la donnée a été chargée et l'état
 *    métier correspondant est jugé complet.
 *  - "incomplete"           : la donnée a été chargée mais l'état
 *    métier correspondant est manquant/partiel.
 *  - "unavailable"          : la lecture n'est structurellement pas
 *    accessible à un opérateur avec les RPC/policies actuellement
 *    publiées (jamais contourné — voir commentaire dans
 *    app/admin/establishments/cockpit/page.tsx pour la RPC exacte et
 *    la raison).
 *  - "not_yet_implemented"  : la fonctionnalité elle-même n'existe
 *    pas encore dans ce lot (Health Checks -> OB-9, Ready to Publish
 *    -> action de publication -> OB-11).
 */
export type SectionStatus = "ready" | "incomplete" | "unavailable" | "not_yet_implemented";

export const SECTION_KEYS = [
  "merchant",
  "legalTax",
  "catalogue",
  "photos",
  "payment",
  "delivery",
  "qrDomain",
  "healthChecks",
  "readyToPublish",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Une ligne du répertoire opérateur (public.restaurants, lecture RLS). */
export interface OperatorEstablishmentListItem {
  restaurantId: string;
  name: string;
  slug: string;
  country: string | null;
  status: string;
}

export interface DirectoryFilter {
  query?: string;
  country?: string;
  status?: string;
}

/**
 * Normalisation minimale pour une comparaison insensible à la casse
 * et aux espaces de bordure — jamais de correspondance floue au-delà
 * (mandat : recherche/filtre "simple" et déterministe, pas un moteur
 * de recherche).
 */
function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Filtre déterministe du répertoire opérateur : `query` teste une
 * sous-chaîne (nom OU slug), `country`/`status` exigent une
 * correspondance EXACTE (après normalisation de casse) quand fournis.
 * Un filtre vide/absent ne restreint rien. Aucun état caché, aucun tri
 * aléatoire : même entrée -> même sortie, toujours.
 */
export function filterEstablishments(
  list: OperatorEstablishmentListItem[],
  filter: DirectoryFilter
): OperatorEstablishmentListItem[] {
  const q = filter.query ? norm(filter.query) : "";
  const country = filter.country ? norm(filter.country) : "";
  const status = filter.status ? norm(filter.status) : "";

  return list.filter((item) => {
    if (q && !norm(item.name).includes(q) && !norm(item.slug).includes(q)) {
      return false;
    }
    if (country && norm(item.country ?? "") !== country) {
      return false;
    }
    if (status && norm(item.status) !== status) {
      return false;
    }
    return true;
  });
}

/**
 * MERCHANT LEGAL & TAX PROFILE v1.2 (get_receipt_settings, réutilisée
 * telle quelle) : "configuré" exige un minimum exploitable pour
 * l'établissement — raison sociale ET adresse légale toutes deux
 * renseignées. Un profil entièrement vide (établissement tout juste
 * onboardé, aucune ligne receipt_settings) est "incomplete", jamais
 * "ready" par défaut.
 */
export function deriveLegalTaxStatus(
  receipt: { legal_name: string | null; legal_address: string | null } | null
): SectionStatus {
  if (!receipt) return "incomplete";
  const hasLegalName = !!receipt.legal_name && receipt.legal_name.trim().length > 0;
  const hasLegalAddress = !!receipt.legal_address && receipt.legal_address.trim().length > 0;
  return hasLegalName && hasLegalAddress ? "ready" : "incomplete";
}

/**
 * READY TO PUBLISH — lecture seule de `restaurants.status`
 * (restaurants_status_chk : 'onboarding' | 'active' | 'suspended' |
 * 'inactive'). Cette fonction NE DÉCIDE JAMAIS de changer ce statut —
 * OB-1 n'implémente aucune action de publication (OB-11 en a la
 * charge).
 */
export function deriveReadyToPublishStatus(restaurantStatus: string): SectionStatus {
  return restaurantStatus === "active" ? "ready" : "incomplete";
}

/** MERCHANT — un résumé chargé avec succès pour l'établissement demandé vaut "ready". */
export function deriveMerchantStatus(hasSummary: boolean): SectionStatus {
  return hasSummary ? "ready" : "unavailable";
}

// ======================================================================
// OB-1 v1.1 — CATALOGUE / PHOTOS après publication d'OB-2 v1.1.
//
// get_merchant_catalogue (public.restaurants, DRAFT-lot-catalogue-
// operator-authorization-v1.sql, section 6) autorise désormais un
// opérateur Scanym (is_scanym_operator() = true) EXACTEMENT comme un
// membre restaurant_users -- inspecté directement dans le SQL publié
// (baseline e4740942…), jamais supposé. Ce module réutilise le MÊME
// type de retour que lib/services/dashboard.ts::getMerchantCatalogue
// (structurellement, pas par import, pour rester une dépendance zéro
// -- voir l'en-tête de ce fichier) : aucune logique catalogue n'est
// dupliquée ici, seulement un COMPTAGE en lecture sur des données déjà
// chargées par cette RPC existante.
// ======================================================================

interface CountableProduct {
  archived_at: string | null;
  image_url: string | null;
}

interface CountableSubcategory {
  products: CountableProduct[];
}

interface CountableCategory {
  products: CountableProduct[];
  subcategories: CountableSubcategory[];
}

export interface CatalogueSummary {
  categoryCount: number;
  /** Produits NON archivés uniquement -- un produit archivé ne compte
   *  ni pour le statut catalogue ni pour le statut photos. */
  productCount: number;
  productsWithPhotoCount: number;
}

/**
 * Agrège le résultat déjà chargé de `getMerchantCatalogue` (aucun
 * appel réseau ici). Une catégorie ou sous-catégorie totalement vide
 * (LEFT JOIN, V66) est comptée dans `categoryCount` mais n'ajoute
 * aucun produit -- comportement attendu, pas un bug.
 */
export function summarizeCatalogue(categories: CountableCategory[]): CatalogueSummary {
  let productCount = 0;
  let productsWithPhotoCount = 0;

  const countProducts = (products: CountableProduct[]) => {
    for (const p of products) {
      if (p.archived_at) continue;
      productCount++;
      if (p.image_url) productsWithPhotoCount++;
    }
  };

  for (const category of categories) {
    countProducts(category.products);
    for (const sub of category.subcategories) {
      countProducts(sub.products);
    }
  }

  return { categoryCount: categories.length, productCount, productsWithPhotoCount };
}

/**
 * CATALOGUE — "ready" seulement si au moins une catégorie contient au
 * moins un produit actif ; un établissement tout juste onboardé (aucune
 * catégorie, ou catégories vides) reste "incomplete", jamais "ready"
 * par défaut. Ne devient jamais "unavailable" ici : ce statut est
 * réservé à un véritable échec de lecture (géré par la page, pas par
 * cette fonction pure).
 */
export function deriveCatalogueStatus(summary: CatalogueSummary): SectionStatus {
  return summary.categoryCount > 0 && summary.productCount > 0 ? "ready" : "incomplete";
}

/**
 * PHOTOS — dérivé du MÊME résumé catalogue déjà chargé (aucune lecture
 * Storage, aucune policy RLS interrogée). "ready" seulement quand TOUS
 * les produits actifs ont une photo ; "incomplete" tant qu'au moins un
 * produit actif n'en a pas, ou qu'il n'y a aucun produit actif. Ne
 * couvre QUE la lecture : l'upload/remplacement de photo reste hors
 * périmètre (Storage RLS du bucket product-photos non modifiée par
 * OB-2 v1.1 -- voir le commentaire dédié dans
 * app/admin/establishments/cockpit/page.tsx).
 */
export function derivePhotosStatus(summary: CatalogueSummary): SectionStatus {
  if (summary.productCount === 0) return "incomplete";
  return summary.productsWithPhotoCount === summary.productCount ? "ready" : "incomplete";
}
