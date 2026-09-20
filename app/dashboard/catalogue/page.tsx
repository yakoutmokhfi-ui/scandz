"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  archiveProduct,
  createCategory,
  createProduct,
  getMerchantCatalogue,
  getMerchantRestaurants,
  getRestaurantSettings,
  restoreProduct,
  setProductAvailability,
  setProductOrder,
  updateCategory,
  updateProduct,
  createSubcategory,
  updateSubcategory,
  CategoryDuplicateNameError,
  CategoryDescriptionTooLongError,
  DescriptionTooLongError,
  ShortDescriptionTooLongError,
  SubcategoryDuplicateNameError,
  SubcategoryCategoryMismatchError,
  type CatalogueCategory,
  type CatalogueProduct,
  type CatalogueSubcategory,
} from "@/lib/services/dashboard";
import {
  addOrReplaceProductPhoto,
  removeProductPhoto,
  retryOldPhotoCleanup,
  validateProductPhotoFile,
  InvalidFileTypeError,
  FileTooLargeError,
  PhotoUploadError,
  PhotoRemoveError,
  type OldImageCleanupOutcome,
} from "@/lib/services/product-photo";
import ProductPhotoPlaceholder from "@/components/ProductPhotoPlaceholder";
import BulkPhotoUpload from "@/components/dashboard/BulkPhotoUpload";
import type { BulkPhotoMatchProduct } from "@/lib/services/bulk-product-photo-matching";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { formatPrice } from "@/lib/whatsapp";
import { canEditProducts, canToggleAvailability } from "@/lib/roles";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import {
  normalizeText,
  SHORT_DESCRIPTION_MAX_LENGTH,
  LONG_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
} from "@/lib/catalogue-text";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { useRestaurantContextGuard } from "@/lib/restaurant-context-guard";
// CATALOGUE MANAGEMENT UX v1 -- fondation COLLECTIONS / TAGS déjà
// publiée, consommée telle quelle (aucun second modèle de tags).
import {
  addProductTags,
  removeProductTag,
  getRestaurantProductTags,
  getRestaurantTags,
  updateTagCollectionSettings,
  type ProductTags,
  type RestaurantTag,
} from "@/lib/services/catalogue-tags";
import {
  flattenCatalogue,
  applyCatalogueFilters,
  availableFilterOptions,
  isDefaultFilters,
  EMPTY_FILTERS,
  type CatalogueFilters,
  type SortKey,
} from "@/lib/catalogue-management/filtering";
import {
  buildCatalogueExport,
  catalogueExportFileName,
} from "@/lib/catalogue-management/export";
import { translate, type Lang } from "@/lib/i18n";
import Ltr from "@/components/Bidi";
import {
  validateFiscalMeasurementFields,
  referencePricePerKg,
  canProductBeAvailableWithTaxRate,
  type FiscalMeasurementFields,
  type FiscalValidationErrorCode,
} from "@/lib/catalogue-fiscal";
import {
  FiscalMeasurementValidationError,
  TaxRateRequiredForAvailabilityError,
} from "@/lib/services/catalogue-error";

type ProductDraft = {
  name: string;
  shortDescription: string;
  description: string;
  price: string;
  /** Photo choisie pendant la création (V67b) — jamais envoyée telle
   *  quelle à create_product : uploadée séparément une fois le vrai
   *  product_id obtenu. `null` : aucune photo choisie, la création
   *  reste possible (facultatif). */
  photoFile: File | null;
  /** CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 — voir
   *  lib/catalogue-fiscal.ts pour le modèle SIMPLIFIÉ (prix fixe par
   *  portion, poids purement informationnel). Champs texte (même
   *  convention que `price` ci-dessus) : "" représente `null`, jamais
   *  0 ou une valeur par défaut inventée. Parsés/validés par
   *  parseFiscalDraft() juste avant soumission. */
  taxRate: string;
  unitWeightGrams: string;
  weightIsApproximate: boolean;
  /** CATALOGUE / SUBCATEGORIES v1 -- sous-catégorie optionnelle où
   *  placer ce produit, DANS SA CATÉGORIE ACTUELLE (jamais un moyen de
   *  changer la catégorie elle-même). `null` = produit directement
   *  rattaché à sa catégorie (comportement historique, valeur par
   *  défaut ci-dessous). */
  subcategoryId: string | null;
};

type CategoryDraft = {
  name: string;
  displayOrder: string;
  description: string;
};

/** CATALOGUE / SUBCATEGORIES v1 -- même patron minimal que
 *  CategoryDraft : pas de description (les sous-catégories n'en ont
 *  pas, voir la migration), champ d'ordre affiché seulement en édition
 *  (create_subcategory calcule un ordre par défaut, comme
 *  create_category). */
type SubcategoryDraft = {
  name: string;
  displayOrder: string;
};

const EMPTY_PRODUCT_DRAFT: ProductDraft = {
  name: "",
  shortDescription: "",
  description: "",
  price: "",
  photoFile: null,
  taxRate: "",
  unitWeightGrams: "",
  weightIsApproximate: false,
  subcategoryId: null,
};

const EMPTY_SUBCATEGORY_DRAFT: SubcategoryDraft = {
  name: "",
  displayOrder: "",
};

/** Chaîne texte de champ fiscal -> valeur numérique/`null`, avec un
 *  filtre de format strict (jamais Number(), qui accepte silencieusement
 *  "1e5", "+5", "Infinity"…) — un champ non vide qui ne respecte pas le
 *  format est traité comme invalide, jamais comme `null`. */
function parseDecimalField(raw: string): { value: number | null; formatOk: boolean } {
  const s = raw.trim();
  if (s === "") return { value: null, formatOk: true };
  if (!/^\d+(\.\d+)?$/.test(s)) return { value: null, formatOk: false };
  return { value: Number(s), formatOk: true };
}
function parseIntegerField(raw: string): { value: number | null; formatOk: boolean } {
  const s = raw.trim();
  if (s === "") return { value: null, formatOk: true };
  if (!/^\d+$/.test(s)) return { value: null, formatOk: false };
  return { value: Number(s), formatOk: true };
}

/** Construit les 2 champs fiscaux/mesure éditables à partir du
 *  brouillon texte (mandat v1.1 §22 -- plus de matrice de combinaison,
 *  ces 2 champs sont indépendants), et signale si un des champs
 *  numériques a un format illisible. */
function parseFiscalDraft(draft: ProductDraft): {
  fields: FiscalMeasurementFields;
  formatOk: boolean;
} {
  const taxRate = parseDecimalField(draft.taxRate);
  const unitWeightGrams = parseIntegerField(draft.unitWeightGrams);
  return {
    fields: {
      taxRate: taxRate.value,
      unitWeightGrams: unitWeightGrams.value,
      weightIsApproximate: draft.weightIsApproximate,
    },
    formatOk: taxRate.formatOk && unitWeightGrams.formatOk,
  };
}

/** Traduit un code d'erreur RPC fiscal en message affichable -- 2
 *  clés i18n dédiées (v1.1 : seulement 2 codes possibles, plus de
 *  sales_unit/price_mode/weight_mode/combinaison). */
function fiscalErrorMessage(
  code: string,
  t: (k: string, p?: Record<string, string | number>) => string
): string {
  switch (code as FiscalValidationErrorCode) {
    case "SCANYM_INVALID_TAX_RATE":
      return t("fiscalErrorInvalidTaxRate");
    case "SCANYM_INVALID_WEIGHT_VALUE":
    default:
      return t("fiscalErrorInvalidWeightValue");
  }
}

export default function CataloguePage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [categories, setCategories] = useState<CatalogueCategory[]>([]);
  /**
   * CONTEXT HARDENING v1.1 (§5) -- PROVENANCE explicite du catalogue
   * actuellement en mémoire : pour QUEL établissement a-t-il été
   * chargé ? `null` = rien de fiable en mémoire pour le contexte
   * courant. Rien de dérivé du locataire n'est rendu tant que cette
   * provenance ne désigne pas exactement `restaurantId`.
   */
  const [catalogueLoadedRestaurantId, setCatalogueLoadedRestaurantId] = useState<string | null>(null);
  /** CONTEXT HARDENING v1.1 -- contrat anti-réponse-périmée partagé. */
  const guard = useRestaurantContextGuard();
  /**
   * CONTEXT HARDENING v1 (§4.B) -- établissement explicitement demandé
   * par `?r=` mais non résoluble (ni rattaché au compte, ni accessible
   * en tant qu'opérateur). On n'en sélectionne alors AUCUN : aucune
   * donnée métier n'est chargée, et un état dédié est affiché.
   */
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);
  /**
   * CONTEXT HARDENING v1.1 (§5) -- SEULE source d'affichage locataire.
   * Le rendu exige `provenance === contexte courant` : tant que le
   * catalogue de l'établissement affiché n'est pas revenu, rien du
   * précédent ne reste lisible sous son entête. CATALOGUE MANAGEMENT
   * UX v1.1 : c'est aussi la SEULE source que consomment désormais la
   * recherche/les filtres/le tri/l'export (`flatProducts` ci-dessous),
   * afin qu'aucun de ces dérivés n'expose jamais un catalogue encore
   * périmé.
   */
  const categoriesInContext =
    catalogueLoadedRestaurantId === restaurantId && restaurantId ? categories : [];
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // BULK PRODUCT PHOTOS v1.6 (MEDIUM cleanup retry, Cat Stevens :
  // "console-only warning is not enough") -- statut VISIBLE, retriable,
  // par produit. `outcome === "failed"` : un `cleanupId` OPAQUE est
  // connu (v1.7 -- REMPLACE `oldPath`), un bouton de retry
  // (retryOldPhotoCleanup) est proposé -- ne rejoue JAMAIS
  // addOrReplaceProductPhoto/removeProductPhoto. `outcome ===
  // "skipped_unsafe_legacy"` : purement informationnel, aucun retry
  // (la référence historique n'a jamais été jugée sûre -- rien de
  // légitime à retenter).
  const [cleanupAttention, setCleanupAttention] = useState<
    Record<string, { cleanupId: string | null; outcome: OldImageCleanupOutcome }>
  >({});
  const [retryingCleanupId, setRetryingCleanupId] = useState<string | null>(null);

  // BULK PRODUCT PHOTOS v1 -- panneau d'envoi groupé, fermé par
  // défaut. N'affecte jamais `categories`/`reload()` tant qu'aucune
  // application n'a été confirmée dans le panneau lui-même (voir
  // BulkPhotoUpload.tsx : la prévisualisation ne fait aucune
  // mutation).
  const [showBulkPhoto, setShowBulkPhoto] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(EMPTY_PRODUCT_DRAFT);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);

  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft>({
    name: "",
    displayOrder: "",
    description: "",
  });
  const [creatingCategory, setCreatingCategory] = useState(false);

  /** CATALOGUE / SUBCATEGORIES v1 -- même patron que les 3 états
   *  catégorie ci-dessus, pour les sous-catégories. */
  const [editingSubcategoryId, setEditingSubcategoryId] = useState<string | null>(null);
  const [subcategoryDraft, setSubcategoryDraft] = useState<SubcategoryDraft>(EMPTY_SUBCATEGORY_DRAFT);
  const [creatingSubcategoryIn, setCreatingSubcategoryIn] = useState<string | null>(null);

  const [currency, setCurrency] = useState("DZD");
  const [staffLang, setStaffLang] = useState<string>("fr");

  // OPERATOR DASHBOARD CONTEXT v1 (corrige le rendu cross-tenant : un
  // opérateur Scanym (scanym_operators) n'a généralement AUCUNE ligne
  // dans restaurant_users -- il consulte/édite un établissement via un
  // lien direct (?r=<restaurant_id>, depuis le Cockpit Opérateur),
  // jamais via le sélecteur "mes établissements" ci-dessous. Même
  // patron, déjà audité et publié, que app/dashboard/settings/page.tsx
  // (F-01) : isScanymOperator()/getEstablishmentSummary() ne servent
  // qu'à l'affichage (masquer/rediriger, résoudre le nom affiché) --
  // la protection réelle reste côté RPC (assert_product_role /
  // assert_category_role / assert_subcategory_role, qui acceptent déjà
  // is_scanym_operator() en plus de owner/manager, voir
  // supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql).
  const [isOperator, setIsOperator] = useState(false);
  const [operatorRestaurantName, setOperatorRestaurantName] = useState<string | null>(null);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  // Un opérateur peut éditer N'IMPORTE QUEL établissement (RPC déjà
  // autorisées côté SQL, cf. commentaire ci-dessus), MÊME sans rôle
  // owner/manager réel -- exactement le même raisonnement que
  // settings/page.tsx (canEdit = isOperator || canEditFull).
  const canEdit = isOperator || canEditProducts(mapping?.role);
  const canToggle = isOperator || canToggleAvailability(mapping?.role);

  // BULK PRODUCT PHOTOS v1 -- catalogue courant mis à plat pour le
  // module d'appariement (produits directement rattachés à une
  // catégorie + produits de chaque sous-catégorie, même règle de
  // regroupement que le reste de cet écran, voir CatalogueCategory /
  // CatalogueSubcategory). Recalculé UNIQUEMENT quand `categories`
  // change (déjà strictement scoped à `restaurantId` par
  // getMerchantCatalogue -- reload() ci-dessus) : aucune fuite
  // cross-tenant possible, la liste passée à BulkPhotoUpload ne
  // contient jamais que les produits du restaurant actuellement
  // chargé.
  const flatProductsForBulkPhoto: BulkPhotoMatchProduct[] = useMemo(() => {
    const flat: BulkPhotoMatchProduct[] = [];
    for (const cat of categoriesInContext) {
      for (const p of cat.products) {
        flat.push({
          product_id: p.product_id,
          name: p.name,
          category_name: cat.category_name,
          archived_at: p.archived_at,
          image_url: p.image_url,
        });
      }
      for (const sub of cat.subcategories) {
        for (const p of sub.products) {
          flat.push({
            product_id: p.product_id,
            name: p.name,
            category_name: `${cat.category_name} — ${sub.subcategory_name}`,
            archived_at: p.archived_at,
            image_url: p.image_url,
          });
        }
      }
    }
    return flat;
  }, [categoriesInContext]);
  const lang = staffLang as Lang;
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  /**
   * Nom/description affichés dans la langue du gérant. La valeur de
   * base (française) reste celle qu'il modifie : les traductions ne
   * sont pas éditables depuis cet écran (V66 n'ajoute aucune
   * interface d'édition des traductions de contenu).
   */
  const shown = (
    base: string | null,
    tr: Record<string, { name?: string; description?: string; short_description?: string }> | null,
    field: "name" | "description" | "short_description"
  ) => (lang === "fr" ? base : (tr?.[lang]?.[field] ?? base));

  /* ================================================================
   * CATALOGUE MANAGEMENT UX v1 -- recherche / filtres / tri / export.
   *
   * ÉTAT STRICTEMENT D'AFFICHAGE : `categories` (la source chargée par
   * getMerchantCatalogue) n'est jamais modifiée par un filtre. Les
   * listes filtrées sont dérivées à chaque rendu, donc basculer un
   * filtre ne peut ni altérer le catalogue ni la charge utile d'une
   * écriture ultérieure.
   * ================================================================ */
  const [filters, setFilters] = useState<CatalogueFilters>(EMPTY_FILTERS);
  const [productTags, setProductTags] = useState<ProductTags[]>([]);
  const [knownTags, setKnownTags] = useState<RestaurantTag[]>([]);

  /** Carte produit -> tags, indexée une seule fois par chargement. */
  const tagsByProductId = useMemo(() => {
    const m = new Map<string, { tagIds: string[]; tagNames: string[] }>();
    for (const pt of productTags) m.set(pt.menuItemId, { tagIds: pt.tagIds, tagNames: pt.tagNames });
    return m;
  }, [productTags]);

  // CONTEXT HARDENING v1.1 -- dérivé de `categoriesInContext`, jamais de
  // `categories` brut : recherche, filtres, tri et export ne doivent
  // jamais exposer un catalogue qui n'a pas encore été confirmé comme
  // appartenant au restaurant actuellement affiché.
  const flatProducts = useMemo(
    () => flattenCatalogue(categoriesInContext, tagsByProductId),
    [categoriesInContext, tagsByProductId]
  );
  const filteredProducts = useMemo(
    () => applyCatalogueFilters(flatProducts, filters),
    [flatProducts, filters]
  );
  const filterOptions = useMemo(() => availableFilterOptions(flatProducts), [flatProducts]);
  /** Identifiants des produits retenus par la recherche/les filtres.
   *  Le rendu reste GROUPÉ PAR CATÉGORIE -- la structure que le
   *  marchand connaît -- et se contente de masquer ce qui ne
   *  correspond pas, plutôt que de réorganiser l'écran sous ses yeux. */
  const visibleProductIds = useMemo(
    () => new Set(filteredProducts.map((f) => f.product.product_id)),
    [filteredProducts]
  );
  /**
   * Rang de chaque produit dans la liste TRIÉE. Le regroupement par
   * catégorie / sous-catégorie est conservé (voir ci-dessus), mais
   * l'ordre À L'INTÉRIEUR de chaque groupe suit le tri demandé : sans
   * cela le sélecteur « Trier par » n'aurait AUCUN effet visible, ce
   * qui serait pire que de ne pas l'offrir.
   */
  const productRank = useMemo(() => {
    const m = new Map<string, number>();
    filteredProducts.forEach((f, i) => m.set(f.product.product_id, i));
    return m;
  }, [filteredProducts]);
  /** Produits d'un groupe, restreints aux visibles puis réordonnés
   *  selon le tri courant. Ne mute jamais le tableau reçu. */
  const orderForDisplay = useCallback(
    (products: CatalogueProduct[]) =>
      products
        .filter((p) => visibleProductIds.has(p.product_id))
        .sort(
          (a, b) =>
            (productRank.get(a.product_id) ?? 0) - (productRank.get(b.product_id) ?? 0)
        ),
    [visibleProductIds, productRank]
  );
  const filtersActive = !isDefaultFilters(filters);

  /* ================================================================
   * CATALOGUE MANAGEMENT UX v1.1 -- GARDE ANTI-RÉPONSE PÉRIMÉE
   * (remédiation ciblée CMUX-V1-TAG-CONTEXT-RACE-01, HIGH).
   *
   * LE DÉFAUT CORRIGÉ. En v1, `reloadTags(id)` écrivait
   * `setProductTags` / `setKnownTags` SANS vérifier que la réponse
   * appartenait encore au restaurant affiché. Scénario réel :
   *
   *   1. le restaurant A est actif ;
   *   2. une requête de tags A part et reste en attente ;
   *   3. l'utilisateur bascule sur le restaurant B ;
   *   4. le catalogue et les tags de B se chargent ;
   *   5. la requête A se résout APRÈS ;
   *   6. son écriture écrase l'état partagé ;
   *   7. l'écran de B expose alors des métadonnées de tags de A.
   *
   * Les RPC restent sûres (chacune vérifie le tenant côté serveur) :
   * la fuite est purement côté client, mais elle est réelle et visible.
   *
   * LA PROTECTION. Deux barrières INDÉPENDANTES, toutes deux exigées
   * avant la moindre écriture d'état :
   *
   *   1. GÉNÉRATION MONOTONE. Chaque chargement réserve un numéro
   *      strictement croissant. Une réponse n'écrit que si son numéro
   *      est TOUJOURS le dernier réservé. Cela couvre aussi le cas de
   *      deux requêtes CONCURRENTES SUR LE MÊME RESTAURANT : si la
   *      requête n°1 se résout après la n°2, elle est rejetée -- la
   *      plus récente reste l'autorité (une comparaison d'identifiant
   *      de restaurant seule ne verrait pas ce cas).
   *
   *   2. PROVENANCE DE TENANT. La réponse n'écrit que si elle porte
   *      l'identifiant du restaurant ACTUELLEMENT actif.
   *
   * DEUX compteurs distincts, et non un seul partagé : sans cela, un
   * rechargement de tags (après ajout/retrait) invaliderait le
   * chargement de catalogue légitime en cours, qui serait alors
   * silencieusement perdu. Catalogue et tags ont des cycles de vie
   * propres ; leurs générations aussi.
   *
   * Les deux compteurs sont également incrémentés au CHANGEMENT DE
   * RESTAURANT (voir l'effet d'invalidation plus bas), de sorte que
   * toute requête déjà en vol est périmée AVANT même que la nouvelle
   * ne parte. Vider l'état ne suffirait pas : une écriture tardive le
   * re-remplirait.
   * ================================================================ */
  const catalogueGenerationRef = useRef(0);
  const tagGenerationRef = useRef(0);
  const currentRestaurantRef = useRef("");

  /** Réserve une génération de chargement de CATALOGUE. */
  const beginCatalogueLoad = useCallback(() => ++catalogueGenerationRef.current, []);
  /** Réserve une génération de chargement de TAGS. */
  const beginTagLoad = useCallback(() => ++tagGenerationRef.current, []);

  /** La réponse peut-elle encore écrire ? Génération toujours la plus
   *  récente ET restaurant toujours actif -- les deux, jamais l'une. */
  const isCurrentCatalogueLoad = useCallback(
    (gen: number, id: string) =>
      gen === catalogueGenerationRef.current && id === currentRestaurantRef.current,
    []
  );
  const isCurrentTagLoad = useCallback(
    (gen: number, id: string) =>
      gen === tagGenerationRef.current && id === currentRestaurantRef.current,
    []
  );

  /**
   * Charge les tags du tenant COURANT. Tolérant à l'échec : un tenant
   * dont la migration tags n'est pas encore appliquée doit continuer à
   * voir et éditer son catalogue -- l'absence de tags n'est jamais une
   * raison de casser l'écran.
   *
   * AUCUNE écriture n'a lieu si la réponse n'est plus d'actualité --
   * ni en succès, ni en échec : un échec tardif venant de A ne doit
   * pas davantage vider les tags de B qu'un succès tardif ne doit les
   * remplacer.
   */
  const reloadTags = useCallback(
    async (id: string) => {
      const gen = beginTagLoad();
      if (!id) {
        setProductTags([]);
        setKnownTags([]);
        return;
      }
      try {
        const [pt, kt] = await Promise.all([getRestaurantProductTags(id), getRestaurantTags(id)]);
        if (!isCurrentTagLoad(gen, id)) return;
        setProductTags(pt);
        setKnownTags(kt);
      } catch {
        if (!isCurrentTagLoad(gen, id)) return;
        setProductTags([]);
        setKnownTags([]);
      }
    },
    [beginTagLoad, isCurrentTagLoad]
  );

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
  }

  /** Télécharge un classeur .xlsx. Best-effort : un environnement sans
   *  API de téléchargement n'interrompt jamais l'écran. */
  function downloadXlsx(scope: "complet" | "filtre") {
    const rows = scope === "complet" ? flatProducts : filteredProducts;
    const bytes = buildCatalogueExport(rows);
    try {
      // `bytes.buffer` est typé ArrayBufferLike ; on en extrait la
      // tranche exacte pour obtenir un ArrayBuffer strict, seul type
      // accepté par BlobPart.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const blob = new Blob([ab], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = catalogueExportFileName(scope);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      /* environnement sans téléchargement : ignoré volontairement */
    }
  }

  const productLabels = {
    name: t("mcName"),
    shortDescription: t("mcShortDescription"),
    description: t("mcDescription"),
    price: t("mcPrice"),
    cancel: t("mcCancel"),
    baseHint: lang === "fr" ? undefined : t("mcEditBaseHint"),
  };

  const reload = useCallback(
    async (id: string, archived: boolean) => {
      if (!id) return;
      // CONTEXT HARDENING v1.1 -- ferme CTXHARD-V1-STALE-RESPONSE-01.
      // La requête est ouverte AVANT tout appel : son jeton devra
      // prouver, au retour, qu'il appartient toujours au restaurant
      // actif ET à la génération courante.
      const token = guard.beginRequest(id);
      // §5 -- invalidation IMMÉDIATE : le catalogue précédent cesse
      // d'être considéré comme chargé dès l'instant du changement,
      // sans attendre la moindre réponse réseau.
      setCatalogueLoadedRestaurantId(null);
      // CATALOGUE MANAGEMENT UX v1.1 -- même garde que pour les tags,
      // mais via un compteur INDÉPENDANT du guard partagé ci-dessus
      // (remédiation CMUX-V1-TAG-CONTEXT-RACE-01) : un rechargement de
      // tags seul (après ajout/retrait) ne doit jamais invalider un
      // chargement de catalogue légitime en cours, ce qu'un compteur
      // unique partagé entre catalogue et tags ferait. Les deux gardes
      // sont donc appliquées ENSEMBLE ci-dessous, aucune ne remplace
      // l'autre : un catalogue de A qui arrive alors que B est affiché
      // est REJETÉ par l'une ET l'autre, au lieu d'écraser l'écran de B.
      const gen = beginCatalogueLoad();
      try {
        const next = await getMerchantCatalogue(id, archived);
        // Réponse PÉRIMÉE -> ABANDONNÉE intégralement. Aucun setState :
        // ni les données, ni l'effacement de l'erreur, sans quoi une
        // réponse d'un AUTRE établissement influencerait encore l'écran.
        if (!token.isCurrent() || !isCurrentCatalogueLoad(gen, id)) return;
        // Commit ATOMIQUE (même passe de rendu) : les données et leur
        // provenance sont posées ensemble et ne peuvent jamais se
        // contredire, même un instant.
        setCategories(next);
        setCatalogueLoadedRestaurantId(id);
        // CATALOGUE MANAGEMENT UX v1 -- les tags suivent EXACTEMENT le
        // cycle de vie du catalogue : même identifiant de restaurant,
        // même rechargement. Aucun état de tags ne peut donc survivre
        // à un changement d'établissement.
        await reloadTags(id);
        if (!token.isCurrent() || !isCurrentCatalogueLoad(gen, id)) return;
        setError(null);
      } catch (e) {
        // Une erreur PÉRIMÉE ne s'affiche pas davantage qu'une donnée
        // périmée : elle porterait sur un établissement que
        // l'utilisateur ne regarde plus.
        if (!token.isCurrent() || !isCurrentCatalogueLoad(gen, id)) return;
        setError(e instanceof Error ? e.message : t("mcLoadFailed"));
      }
    },
    [guard, reloadTags, beginCatalogueLoad, isCurrentCatalogueLoad]
  );

  /**
   * CONTEXT HARDENING v1.1 (§5) -- bascule d'établissement pilotée par
   * l'utilisateur. `enterContext` et `setRestaurantId` sont appelés dans
   * le MÊME gestionnaire : React regroupe ces mises à jour en un seul
   * rendu, il ne peut donc exister aucun rendu intermédiaire où le
   * contexte a déjà changé alors qu'une réponse de l'ancien
   * établissement serait encore acceptée.
   */
  const handleSelectRestaurant = useCallback(
    (id: string) => {
      guard.enterContext(id);
      setCategories([]);
      setCatalogueLoadedRestaurantId(null);
      setRestaurantId(id);
    },
    [guard]
  );

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      try {
        const [next, opFlag] = await Promise.all([
          getMerchantRestaurants(),
          isScanymOperator(),
        ]);
        setIsOperator(opFlag);
        setMappings(next);

        const wanted = new URLSearchParams(window.location.search).get("r");
        // CONTEXT HARDENING v1 -- résolution UNIQUE et partagée
        // (lib/dashboard-nav.ts). Remplace la logique de sélection
        // propre à cette page : plus aucun `match ?? next[0]`, donc plus
        // aucun basculement silencieux d'établissement. L'autorité
        // opérateur continue de venir d'isScanymOperator() -- jamais de
        // l'URL (mandat §11).
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: next,
          isOperator: opFlag,
        });

        if (resolution.kind === "unavailable") {
          // §4.B -- fail closed : aucun établissement sélectionné, donc
          // aucun chargement (reload() est gardée par un id vide).
          setUnavailableContextId(resolution.requestedId);
        } else if (resolution.kind === "none") {
          setError(t("mcNoRestaurant"));
        } else {
          setUnavailableContextId(null);
          guard.enterContext(resolution.restaurantId);
          setRestaurantId(resolution.restaurantId);
          if (resolution.source === "operator") {
            // OPERATOR DASHBOARD CONTEXT v1 : opérateur Scanym consultant
            // un établissement hors de ses propres rattachements
            // restaurant_users -- la protection réelle reste côté RPC
            // (assert_product_role / assert_category_role /
            // assert_subcategory_role).
            try {
              const summary = await getEstablishmentSummary(resolution.restaurantId);
              setOperatorRestaurantName(summary.name);
            } catch {
              // Best-effort : un nom introuvable n'empêche pas de
              // continuer (l'ID reste la source de vérité).
            }
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : t("mcLoadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  // Corrigé après audit indépendant (M-06) : un utilisateur autorisé
  // sur plusieurs établissements pouvait changer de restaurant sans
  // que les modes création/édition en cours ne se réinitialisent —
  // le formulaire restait affiché, lié à un category_id/product_id du
  // PRÉCÉDENT restaurant, alors que l'écran affichait déjà le nouveau.
  // Les RPC vérifient l'appartenance au restaurant (aucune fuite de
  // sécurité), mais une soumission accidentelle aurait échoué de façon
  // confuse pour l'utilisateur, ou pire, aurait pu viser le mauvais
  // category_id si deux restaurants partageaient par coïncidence un
  // id affiché de façon ambiguë dans l'UI. Réinitialisation explicite
  // à chaque changement de restaurant, avant même le rechargement.
  //
  // CATALOGUE MANAGEMENT UX v1.1 (CMUX-V1-TAG-CONTEXT-RACE-01) : cet
  // effet est désormais déclaré AVANT celui qui recharge, afin de
  // s'exécuter le premier -- ce que son propre commentaire décrivait
  // déjà (« avant même le rechargement ») sans que l'ordre de
  // déclaration ne le garantisse. Il devient le point d'invalidation
  // du contexte :
  //
  //   - les DEUX générations sont incrémentées : toute requête déjà en
  //     vol pour l'établissement précédent devient périmée AVANT que
  //     la nouvelle ne parte, et ne pourra plus écrire ;
  //   - `currentRestaurantRef` devient la provenance de référence ;
  //   - les métadonnées de tags du tenant précédent (associations ET
  //     suggestions) sont vidées IMMÉDIATEMENT : elles ne doivent pas
  //     rester affichées pendant que le nouveau contexte charge.
  //
  // Vider ne suffit PAS à lui seul (une réponse tardive re-remplirait
  // l'état) ; garder ne suffit pas non plus (l'ancien contenu resterait
  // visible pendant le chargement). Les deux sont nécessaires.
  useEffect(() => {
    currentRestaurantRef.current = restaurantId;
    catalogueGenerationRef.current += 1;
    tagGenerationRef.current += 1;

    setProductTags([]);
    setKnownTags([]);
    // Un filtre par catégorie/sous-catégorie/tag porte des
    // identifiants du tenant PRÉCÉDENT : le conserver laisserait un
    // critère invisible et inapplicable actif sur le nouveau
    // catalogue. La recherche et le tri repartent donc aussi de leur
    // état par défaut.
    setFilters(EMPTY_FILTERS);

    setEditingId(null);
    setCreatingIn(null);
    setEditingCategoryId(null);
    setCreatingCategory(false);
    setEditingSubcategoryId(null);
    setCreatingSubcategoryIn(null);
    setDraft(EMPTY_PRODUCT_DRAFT);
    setCategoryDraft({ name: "", displayOrder: "", description: "" });
    setSubcategoryDraft(EMPTY_SUBCATEGORY_DRAFT);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  useEffect(() => {
    void reload(restaurantId, showArchived);
  }, [restaurantId, showArchived, reload]);

  useEffect(() => {
    if (!restaurantId) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getRestaurantSettings(restaurantId);
        if (!cancelled) {
          setCurrency(s.currency ?? "DZD");
          setStaffLang(s.staff_receipt_language ?? "fr");
        }
      } catch {
        /* la devise par défaut reste affichée */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  /**
   * `action` peut retourner `true` pour signaler qu'un message
   * post-action a déjà été posé (via setError) et doit être PRÉSERVÉ :
   * dans ce cas, run() n'exécute pas son reload() automatique, qui
   * effacerait sinon ce message via reload()'s propre setError(null).
   * Corrigé après audit Work (bug reproductible : le message
   * "mcProductCreatedPhotoFailed" posé par tryAttachPhotoAfterCreate
   * était immédiatement effacé par ce second reload()). Toutes les
   * autres actions existantes retournent `void`/`undefined`
   * (falsy) : leur comportement — reload automatique après succès —
   * reste strictement inchangé.
   */
  async function run(id: string, action: () => Promise<boolean | void>) {
    setBusyId(id);
    setError(null);
    try {
      const preserveMessage = await action();
      if (!preserveMessage) {
        await reload(restaurantId, showArchived);
      }
    } catch (e) {
      if (e instanceof ShortDescriptionTooLongError) {
        setError(t("mcShortDescriptionTooLong"));
      } else if (e instanceof DescriptionTooLongError) {
        setError(t("mcDescriptionTooLong"));
      } else if (e instanceof CategoryDuplicateNameError) {
        setError(t("mcCategoryDuplicate"));
      } else if (e instanceof CategoryDescriptionTooLongError) {
        setError(t("mcCategoryDescriptionTooLong"));
      } else if (e instanceof SubcategoryDuplicateNameError) {
        setError(t("mcSubcategoryDuplicate"));
      } else if (e instanceof SubcategoryCategoryMismatchError) {
        setError(t("mcSubcategoryMismatch"));
      } else if (e instanceof InvalidFileTypeError) {
        setError(t("mcPhotoInvalidType"));
      } else if (e instanceof FileTooLargeError) {
        setError(t("mcPhotoTooLarge"));
      } else if (e instanceof PhotoUploadError) {
        // Le message technique (Storage/RPC, souvent en anglais brut)
        // n'est jamais affiché à l'utilisateur -- seulement journalisé
        // pour le débogage (corrigé après audit Work, M-01).
        console.error("Photo upload failed:", e.cause);
        setError(t("mcPhotoUploadError"));
      } else if (e instanceof PhotoRemoveError) {
        console.error("Photo remove failed:", e.cause);
        setError(t("mcPhotoRemoveError"));
      } else if (e instanceof FiscalMeasurementValidationError) {
        setError(fiscalErrorMessage(e.code, t));
      } else if (e instanceof TaxRateRequiredForAvailabilityError) {
        // CATALOGUE VAT COMPLETENESS GUARD v1 -- update_product/
        // set_product_availability rejettent (jamais ne désactivent
        // silencieusement) toute tentative de laisser/rendre un
        // produit disponible sans taux de TVA. Message applicatif
        // clair, jamais le texte brut de la contrainte Postgres.
        setError(t("mcTaxRateRequiredForAvailability"));
      } else {
        setError(e instanceof Error ? e.message : t("mcRefused"));
      }
    } finally {
      setBusyId(null);
    }
  }

  /**
   * BULK PRODUCT PHOTOS v1.6 (MEDIUM cleanup retry) -- enregistre/efface
   * l'état VISIBLE de nettoyage pour un produit, à partir du résultat
   * déjà renvoyé par addOrReplaceProductPhoto/removeProductPhoto
   * (jamais une valeur reconstruite ici). Un nettoyage réussi
   * ("removed") ou sans objet ("not_applicable") efface toute alerte
   * précédente pour ce produit.
   */
  function noteCleanupOutcome(
    productId: string,
    outcome: OldImageCleanupOutcome,
    cleanupId: string | null
  ) {
    if (outcome === "failed" || outcome === "skipped_unsafe_legacy") {
      setCleanupAttention((prev) => ({ ...prev, [productId]: { cleanupId, outcome } }));
    } else {
      setCleanupAttention((prev) => {
        if (!(productId in prev)) return prev;
        const next = { ...prev };
        delete next[productId];
        return next;
      });
    }
  }

  /**
   * Retente UNIQUEMENT le nettoyage Storage de l'ancienne image --
   * délégation à retryOldPhotoCleanup (lib/services/product-photo.ts),
   * qui n'appelle JAMAIS addOrReplaceProductPhoto/removeProductPhoto :
   * aucun nouvel upload, aucune écriture menu_items rejouée (BULK
   * RETRY INVARIANT). N'est proposé QUE pour outcome === "failed" --
   * "skipped_unsafe_legacy" n'a jamais eu de chemin légitime à
   * retenter.
   */
  async function handleRetryCleanup(productId: string) {
    const pending = cleanupAttention[productId];
    if (!pending || pending.outcome !== "failed" || !pending.cleanupId) return;
    setRetryingCleanupId(productId);
    try {
      const result = await retryOldPhotoCleanup(productId, pending.cleanupId);
      noteCleanupOutcome(productId, result.oldImageCleanup, pending.cleanupId);
    } catch {
      // Échec du RETRY lui-même (réseau/serveur) -- l'alerte reste
      // affichée EXACTEMENT comme avant, jamais effacée sur un échec.
    } finally {
      setRetryingCleanupId(null);
    }
  }

  /**
   * Tentative de photo pendant la CRÉATION d'un produit (V67b).
   *
   * Appelée UNIQUEMENT après que create_product a déjà réussi (le
   * `productId` réel est requis par l'architecture Storage existante,
   * voir lib/services/product-photo.ts). Ne relance JAMAIS l'erreur :
   * un échec ici ne doit jamais faire croire que le produit n'a pas
   * été créé — il l'a été, et reste visible après reload(). Message
   * dédié, jamais générique, jamais le message technique brut.
   *
   * Retourne `true` en cas d'échec photo : signale à run() de NE PAS
   * exécuter son propre reload() automatique après cette fonction,
   * qui effacerait sinon le message qu'on vient de poser (bug
   * corrigé après audit Work — le reload() de run() appelait
   * setError(null) juste après que ce message ait été affiché).
   */
  async function tryAttachPhotoAfterCreate(
    productId: string,
    file: File
  ): Promise<boolean> {
    try {
      const result = await addOrReplaceProductPhoto(restaurantId, productId, file);
      // BULK PRODUCT PHOTOS v1.5 (Cat Stevens MEDIUM -- cleanup status
      // désormais propagé jusqu'ici, jamais silencieusement ignoré).
      // Le remplacement lui-même a réussi (imageUrl autoritaire déjà
      // en DB) -- un nettoyage non garanti de l'ancienne image n'est
      // jamais bloquant pour l'utilisateur. v1.6 (Cat Stevens MEDIUM --
      // "console-only warning is not enough") : statut désormais
      // VISIBLE et retriable (noteCleanupOutcome), jamais un simple
      // console.warn (produit venant d'être créé, la seule photo
      // "ancienne" possible est déjà connue comme inexistante en
      // pratique ; ceci couvre le cas résiduel où ce ne serait pas le
      // cas).
      noteCleanupOutcome(productId, result.oldImageCleanup, result.cleanupId);
      await reload(restaurantId, showArchived);
      return false;
    } catch (photoErr) {
      if (photoErr instanceof PhotoUploadError) {
        console.error("Photo upload failed after product creation:", photoErr.cause);
      } else if (
        !(photoErr instanceof InvalidFileTypeError) &&
        !(photoErr instanceof FileTooLargeError)
      ) {
        console.error("Photo upload failed after product creation:", photoErr);
      }
      await reload(restaurantId, showArchived);
      setError(t("mcProductCreatedPhotoFailed"));
      return true;
    }
  }

  function startEdit(p: CatalogueProduct) {
    setEditingId(p.product_id);
    setCreatingIn(null);
    setDraft({
      name: p.name,
      shortDescription: p.short_description ?? "",
      description: p.description ?? "",
      price: String(p.price),
      photoFile: null,
      taxRate: p.tax_rate != null ? String(p.tax_rate) : "",
      unitWeightGrams: p.unit_weight_grams != null ? String(p.unit_weight_grams) : "",
      weightIsApproximate: p.weight_is_approximate ?? false,
      subcategoryId: p.subcategory_id,
    });
  }

  function startCreate(categoryId: string) {
    setCreatingIn(categoryId);
    setEditingId(null);
    setDraft(EMPTY_PRODUCT_DRAFT);
  }

  function startEditCategory(cat: CatalogueCategory) {
    setEditingCategoryId(cat.category_id);
    setCreatingCategory(false);
    setCategoryDraft({
      name: cat.category_name,
      displayOrder: String(cat.category_display_order),
      description: cat.category_description ?? "",
    });
  }

  function startCreateCategory() {
    setCreatingCategory(true);
    setEditingCategoryId(null);
    setCategoryDraft({ name: "", displayOrder: "", description: "" });
  }

  /** CATALOGUE / SUBCATEGORIES v1 -- même patron que
   *  startEditCategory/startCreateCategory ci-dessus. */
  function startEditSubcategory(sub: CatalogueSubcategory) {
    setEditingSubcategoryId(sub.subcategory_id);
    setCreatingSubcategoryIn(null);
    setSubcategoryDraft({
      name: sub.subcategory_name,
      displayOrder: String(sub.subcategory_display_order),
    });
  }

  function startCreateSubcategory(categoryId: string) {
    setCreatingSubcategoryIn(categoryId);
    setEditingSubcategoryId(null);
    setSubcategoryDraft(EMPTY_SUBCATEGORY_DRAFT);
  }

  /**
   * CATALOGUE / SUBCATEGORIES v1 -- rendu d'une ligne produit, extrait
   * de l'ancien `.map()` inline pour être réutilisé tel quel à la fois
   * pour les produits directs d'une catégorie (`cat.products`) et pour
   * les produits d'une de ses sous-catégories (`sub.products`) --
   * AUCUN changement de comportement, seule la liste de sous-catégories
   * à proposer dans le sélecteur du formulaire (`subcategories`) varie
   * selon l'appelant (toujours celles de la catégorie PARENTE du
   * produit, jamais celles d'une autre catégorie).
   */
  function renderProductRow(p: CatalogueProduct, subcategories: CatalogueSubcategory[]) {
    const busy = busyId === p.product_id;
    return (
      <li
        key={p.product_id}
        className={
          "rounded-2xl border p-3 " +
          (p.is_available && !p.archived_at
            ? "border-stone-200 bg-white"
            : "border-stone-200 bg-stone-100")
        }
      >
        {editingId === p.product_id ? (
          <>
            <ProductPhotoField
              productId={p.product_id}
              imageUrl={p.image_url}
              productName={shown(p.name, p.translations, "name") ?? p.name}
              busy={busyId === p.product_id}
              t={t}
              onAddOrReplace={(file) =>
                run(p.product_id, async () => {
                  const result = await addOrReplaceProductPhoto(
                    restaurantId,
                    p.product_id,
                    file
                  );
                  // BULK PRODUCT PHOTOS v1.5 (Cat Stevens MEDIUM) --
                  // même posture que tryAttachPhotoAfterCreate
                  // ci-dessus : le remplacement a réussi, un nettoyage
                  // non garanti de l'ancienne image n'est jamais
                  // bloquant. v1.6 : statut VISIBLE et retriable,
                  // jamais console-only (voir noteCleanupOutcome).
                  noteCleanupOutcome(p.product_id, result.oldImageCleanup, result.cleanupId);
                })
              }
              onRemove={() =>
                run(p.product_id, async () => {
                  const result = await removeProductPhoto(p.product_id);
                  noteCleanupOutcome(p.product_id, result.oldImageCleanup, result.cleanupId);
                })
              }
            />
            {cleanupAttention[p.product_id] && (
              <div
                role="status"
                className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
              >
                <span>
                  {cleanupAttention[p.product_id].outcome === "skipped_unsafe_legacy"
                    ? t("mcPhotoCleanupSkipped")
                    : t("mcPhotoCleanupAttention")}
                </span>
                {cleanupAttention[p.product_id].outcome === "failed" && (
                  <button
                    type="button"
                    onClick={() => handleRetryCleanup(p.product_id)}
                    disabled={retryingCleanupId === p.product_id}
                    className="rounded-md border border-amber-400 bg-white px-2 py-1 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                  >
                    {retryingCleanupId === p.product_id ? t("mcPhotoCleanupRetrying") : t("mcPhotoCleanupRetry")}
                  </button>
                )}
              </div>
            )}
            {/* CATALOGUE MANAGEMENT UX v1 -- tags du produit en cours
                d'édition. Placé AU-DESSUS du formulaire parce que les
                tags sont enregistrés immédiatement par leurs propres
                RPC (idempotentes) : ils ne font pas partie du brouillon
                soumis par « Enregistrer », et les mêler aux champs du
                formulaire laisserait croire le contraire. */}
            <ProductTagsEditor
              productId={p.product_id}
              tagNames={tagsByProductId.get(p.product_id)?.tagNames ?? []}
              tagIds={tagsByProductId.get(p.product_id)?.tagIds ?? []}
              knownTags={knownTags.map((kt) => ({ id: kt.id, name: kt.name }))}
              onChanged={() => reloadTags(restaurantId)}
              t={t}
            />

            <ProductForm
              labels={productLabels}
              draft={draft}
              setDraft={setDraft}
              submitLabel={t("mcSave")}
              submitting={busyId === p.product_id}
              onCancel={() => setEditingId(null)}
              t={t}
              subcategories={subcategories}
              onSubmit={() =>
                run(p.product_id, async () => {
                  const { fields: fiscalFields } = parseFiscalDraft(draft);
                  await updateProduct(
                    p.product_id,
                    draft.name,
                    draft.description || null,
                    Number(draft.price),
                    draft.shortDescription || null,
                    {
                      taxRate: fiscalFields.taxRate,
                      unitWeightGrams: fiscalFields.unitWeightGrams,
                      weightIsApproximate: fiscalFields.weightIsApproximate,
                    },
                    draft.subcategoryId
                  );
                  setEditingId(null);
                })
              }
            />
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              {p.image_url && (
                <img
                  src={p.image_url}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-lg object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-900">
                  {shown(p.name, p.translations, "name")}
                </p>
                {p.short_description && (
                  <p className="mt-0.5 text-sm text-stone-500">
                    {shown(p.short_description, p.translations, "short_description")}
                  </p>
                )}
                <p className="mt-1 font-bold text-amber-800">
                  <Ltr>{formatPrice(Number(p.price), currency)}</Ltr>
                </p>
              </div>

              {!p.archived_at && canToggle && (
                <button
                  onClick={() =>
                    run(p.product_id, () =>
                      setProductAvailability(
                        p.product_id,
                        !p.is_available
                      )
                    )
                  }
                  disabled={busy}
                  aria-pressed={p.is_available}
                  className={
                    "shrink-0 rounded-full px-4 py-2 text-sm font-bold " +
                    (p.is_available
                      ? "bg-green-600 text-white"
                      : "bg-stone-300 text-stone-700")
                  }
                >
                  {p.is_available ? t("mcAvailable") : t("mcSoldOut")}
                </button>
              )}
              {!p.archived_at && !canToggle && (
                <span
                  className={
                    "shrink-0 rounded-full px-4 py-2 text-sm font-bold " +
                    (p.is_available
                      ? "bg-green-100 text-green-800"
                      : "bg-stone-200 text-stone-600")
                  }
                >
                  {p.is_available ? t("mcAvailable") : t("mcSoldOut")}
                </span>
              )}
            </div>

            {canEdit && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!p.archived_at ? (
                  <>
                    <button
                      onClick={() => startEdit(p)}
                      className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm font-semibold"
                    >
                      {t("mcEdit")}
                    </button>
                    <button
                      onClick={() =>
                        run(p.product_id, () =>
                          archiveProduct(p.product_id)
                        )
                      }
                      disabled={busy || p.is_option_source}
                      title={
                        p.is_option_source
                          ? t("mcIsOption")
                          : undefined
                      }
                      className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
                    >
                      {t("mcArchive")}
                    </button>
                    <OrderField
                      label={t("mcProductOrder")}
                      value={p.display_order}
                      disabled={busy}
                      onSave={(order) =>
                        run(p.product_id, () =>
                          setProductOrder(p.product_id, order)
                        )
                      }
                    />
                  </>
                ) : (
                  <button
                    onClick={() =>
                      run(p.product_id, () =>
                        restoreProduct(p.product_id)
                      )
                    }
                    disabled={busy}
                    className="rounded-xl bg-stone-900 px-3 py-1.5 text-sm font-semibold text-white"
                  >
                    {t("mcRestore")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </li>
    );
  }

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  // CONTEXT HARDENING v1 (§4.B) -- contexte explicitement demandé mais
  // non résoluble : état dédié, aucun établissement sélectionné, aucune
  // donnée métier chargée.
  if (unavailableContextId) {
    return (
      <main className="p-6">
        <div
          role="alert"
          data-context-unavailable={unavailableContextId}
          className="mx-auto max-w-2xl rounded-2xl bg-white p-6 text-sm font-semibold text-red-700 shadow-sm"
        >
          {t("dsContextUnavailable")}
        </div>
      </main>
    );
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? operatorRestaurantName ?? t("mcTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={staffLang}
        onSelectRestaurant={handleSelectRestaurant}
      />

      <main
        dir={lang === "ar" ? "rtl" : "ltr"}
        className="mx-auto max-w-3xl px-4 py-6"
      >
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          ← Retour aux commandes
        </a>

        <p className="mb-4 text-sm text-stone-500">
          {canEdit ? t("mcHintEdit") : t("mcHintStaff")}
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold"
          >
            {showArchived ? t("mcSeeMenu") : t("mcSeeArchived")}
          </button>
          {canEdit && !showArchived && (
            <button
              onClick={startCreateCategory}
              className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900"
            >
              {t("mcAddCategory")}
            </button>
          )}
          {canEdit && !showArchived && !showBulkPhoto && (
            <button
              onClick={() => setShowBulkPhoto(true)}
              className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900"
            >
              {t("mcBulkPhotoOpen")}
            </button>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {error}
          </p>
        )}

        {/* BULK PRODUCT PHOTOS v1 -- même garde canEdit/!showArchived
            que le bouton qui l'ouvre : un rôle sans droit d'édition,
            ou le mode "voir archives", ne peut jamais faire
            apparaître ce panneau (défense en profondeur côté UI --
            l'autorité réelle reste la route de confiance serveur
            app/api/dashboard/catalogue/product-photo/route.ts (BULK
            PRODUCT PHOTOS v1.4), appelée une fois par photo confirmée,
            jamais modifiée par ce composant). */}
        {canEdit && !showArchived && showBulkPhoto && (
          <BulkPhotoUpload
            restaurantId={restaurantId}
            products={flatProductsForBulkPhoto}
            t={t}
            onApplied={() => {
              void reload(restaurantId, showArchived);
            }}
            onClose={() => setShowBulkPhoto(false)}
          />
        )}

        {creatingCategory && (
          <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-3">
            <CategoryForm
              mode="create"
              draft={categoryDraft}
              setDraft={setCategoryDraft}
              onCancel={() => setCreatingCategory(false)}
              onSubmit={() =>
                run("new-category", async () => {
                  await createCategory(restaurantId, categoryDraft.name, null);
                  setCreatingCategory(false);
                })
              }
              t={t}
            />
          </div>
        )}

        {/* ============================================================
            CATALOGUE MANAGEMENT UX v1 -- barre de gestion.
            Recherche, filtres combinables (ET), tri, compteur de
            résultats, réinitialisation et export. Tout est PUREMENT
            d'affichage : `categories` n'est jamais modifié ici.
            ============================================================ */}
        {flatProducts.length > 0 && (
          <div
            data-testid="catalogue-toolbar"
            className="mb-4 space-y-3 rounded-xl border border-stone-200 bg-white p-3"
          >
            <div>
              <label htmlFor="catalogue-search" className="mb-1 block text-xs font-semibold text-stone-600">
                {t("mcSearchLabel")}
              </label>
              <input
                id="catalogue-search"
                data-testid="catalogue-search"
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                placeholder={t("mcSearchPlaceholder")}
                className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="filter-category" className="mb-1 block text-xs font-semibold text-stone-600">
                  {t("mcFilterCategory")}
                </label>
                <select
                  id="filter-category"
                  data-testid="filter-category"
                  value={filters.categoryId ?? ""}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      categoryId: e.target.value === "" ? null : e.target.value,
                      // Une sous-catégorie appartient à une catégorie :
                      // changer de catégorie rendrait le filtre de
                      // sous-catégorie incohérent, il est donc remis à
                      // zéro plutôt que de produire zéro résultat
                      // inexplicable.
                      subcategoryId: null,
                    })
                  }
                  className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">{t("mcFilterAll")}</option>
                  {filterOptions.categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="filter-subcategory" className="mb-1 block text-xs font-semibold text-stone-600">
                  {t("mcFilterSubcategory")}
                </label>
                <select
                  id="filter-subcategory"
                  data-testid="filter-subcategory"
                  value={filters.subcategoryId ?? ""}
                  onChange={(e) =>
                    setFilters({ ...filters, subcategoryId: e.target.value === "" ? null : e.target.value })
                  }
                  className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">{t("mcFilterAll")}</option>
                  {filterOptions.subcategories
                    .filter((sc) => filters.categoryId === null || sc.categoryId === filters.categoryId)
                    .map((sc) => (
                      <option key={sc.id} value={sc.id}>{sc.name}</option>
                    ))}
                </select>
              </div>

              <div>
                <label htmlFor="filter-tag" className="mb-1 block text-xs font-semibold text-stone-600">
                  {t("mcFilterTag")}
                </label>
                <select
                  id="filter-tag"
                  data-testid="filter-tag"
                  value={filters.tagId ?? ""}
                  onChange={(e) => setFilters({ ...filters, tagId: e.target.value === "" ? null : e.target.value })}
                  className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">{t("mcFilterAll")}</option>
                  {filterOptions.tags.map((tg) => (
                    <option key={tg.id} value={tg.id}>{tg.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="filter-availability" className="mb-1 block text-xs font-semibold text-stone-600">
                  {t("mcFilterAvailability")}
                </label>
                <select
                  id="filter-availability"
                  data-testid="filter-availability"
                  value={filters.available === null ? "" : filters.available ? "yes" : "no"}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      available: e.target.value === "" ? null : e.target.value === "yes",
                    })
                  }
                  className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">{t("mcFilterAll")}</option>
                  <option value="yes">{t("mcFilterAvailableYes")}</option>
                  <option value="no">{t("mcFilterAvailableNo")}</option>
                </select>
              </div>

              <div>
                <label htmlFor="catalogue-sort" className="mb-1 block text-xs font-semibold text-stone-600">
                  {t("mcSortLabel")}
                </label>
                <select
                  id="catalogue-sort"
                  data-testid="catalogue-sort"
                  value={filters.sort}
                  onChange={(e) => setFilters({ ...filters, sort: e.target.value as SortKey })}
                  className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="name-asc">{t("mcSortNameAsc")}</option>
                  <option value="name-desc">{t("mcSortNameDesc")}</option>
                  <option value="price-asc">{t("mcSortPriceAsc")}</option>
                  <option value="price-desc">{t("mcSortPriceDesc")}</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-stone-700" data-testid="catalogue-result-count" aria-live="polite">
                {t("mcResultCount", { shown: filteredProducts.length, total: flatProducts.length })}
              </p>
              {filtersActive && (
                <button
                  type="button"
                  data-testid="catalogue-reset-filters"
                  onClick={resetFilters}
                  className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-800"
                >
                  {t("mcResetFilters")}
                </button>
              )}
              <span className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="catalogue-export-all"
                  onClick={() => downloadXlsx("complet")}
                  className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm text-stone-800"
                >
                  {t("mcExportAll")} ({flatProducts.length})
                </button>
                <button
                  type="button"
                  data-testid="catalogue-export-filtered"
                  onClick={() => downloadXlsx("filtre")}
                  className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm text-stone-800"
                >
                  {t("mcExportFiltered")} ({filteredProducts.length})
                </button>
              </span>
            </div>

            {filteredProducts.length === 0 && (
              <p className="rounded-xl bg-stone-100 p-3 text-sm text-stone-500" data-testid="catalogue-no-result">
                {t("mcNoResult")}
              </p>
            )}
          </div>
        )}

        {/* P1 CUSTOMER COLLECTIONS BY TAGS -- réglage restaurant des
            collections client, sur les tags du restaurant COURANT.
            Remonté à chaque changement de restaurant (key). */}
        {canEdit && !showArchived && restaurantId && catalogueLoadedRestaurantId === restaurantId && (
          <CustomerCollectionsSettings
            key={restaurantId}
            restaurantId={restaurantId}
            tags={knownTags}
            isCurrentRestaurant={(id) => id === currentRestaurantRef.current}
            onSaved={(id) => reloadTags(id)}
            t={t}
          />
        )}

        {categoriesInContext.length === 0 && (
          <p className="rounded-xl bg-stone-100 p-4 text-sm text-stone-500">
            {showArchived ? t("mcEmptyArchived") : t("mcEmpty")}
          </p>
        )}

        {categoriesInContext
          .filter(
            (cat) =>
              // Sans filtre actif, le comportement historique est
              // strictement conservé : toutes les catégories sont
              // affichées, y compris les vides (le marchand doit
              // pouvoir y créer un produit). Avec un filtre actif, une
              // catégorie sans aucun produit retenu n'a rien à montrer
              // et serait un titre vide de plus à faire défiler.
              !filtersActive ||
              cat.products.some((p) => visibleProductIds.has(p.product_id)) ||
              cat.subcategories.some((sub) =>
                sub.products.some((p) => visibleProductIds.has(p.product_id))
              )
          )
          .map((cat) => (
          <section key={cat.category_id} className="mb-6">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-sm font-bold uppercase tracking-wide text-amber-800">
                  {shown(cat.category_name, cat.category_translations, "name")}
                </h2>
                {cat.category_is_option_source && (
                  <span
                    className="shrink-0 rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-semibold text-stone-700"
                    title={t("mcTechnicalBadgeHint")}
                  >
                    {t("mcTechnicalBadge")}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {canEdit && !showArchived && (
                  <button
                    onClick={() => startEditCategory(cat)}
                    className="rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold"
                  >
                    {t("mcEditCategory")}
                  </button>
                )}
                {canEdit && !showArchived && (
                  <button
                    onClick={() => startCreate(cat.category_id)}
                    className="rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold"
                  >
                    {t("mcAddProduct")}
                  </button>
                )}
                {canEdit && !showArchived && (
                  <button
                    onClick={() => startCreateSubcategory(cat.category_id)}
                    className="rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold"
                  >
                    {t("mcAddSubcategory")}
                  </button>
                )}
              </div>
            </div>

            {editingCategoryId === cat.category_id && (
              <div className="mb-3 rounded-2xl border border-stone-300 bg-white p-3">
                <CategoryForm
                  mode="edit"
                  draft={categoryDraft}
                  setDraft={setCategoryDraft}
                  onCancel={() => setEditingCategoryId(null)}
                  onSubmit={() =>
                    run(cat.category_id, async () => {
                      await updateCategory(
                        cat.category_id,
                        categoryDraft.name,
                        Number(categoryDraft.displayOrder),
                        categoryDraft.description || null
                      );
                      setEditingCategoryId(null);
                    })
                  }
                  t={t}
                />
              </div>
            )}

            {editingSubcategoryId && cat.subcategories.some((s) => s.subcategory_id === editingSubcategoryId) && (
              <div className="mb-3 rounded-2xl border border-stone-300 bg-white p-3">
                <SubcategoryForm
                  mode="edit"
                  draft={subcategoryDraft}
                  setDraft={setSubcategoryDraft}
                  onCancel={() => setEditingSubcategoryId(null)}
                  onSubmit={() =>
                    run(editingSubcategoryId, async () => {
                      await updateSubcategory(
                        editingSubcategoryId,
                        subcategoryDraft.name,
                        Number(subcategoryDraft.displayOrder)
                      );
                      setEditingSubcategoryId(null);
                    })
                  }
                  t={t}
                />
              </div>
            )}

            {creatingSubcategoryIn === cat.category_id && (
              <div className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3">
                <SubcategoryForm
                  mode="create"
                  draft={subcategoryDraft}
                  setDraft={setSubcategoryDraft}
                  onCancel={() => setCreatingSubcategoryIn(null)}
                  onSubmit={() =>
                    run("new-subcategory", async () => {
                      await createSubcategory(cat.category_id, subcategoryDraft.name);
                      setCreatingSubcategoryIn(null);
                    })
                  }
                  t={t}
                />
              </div>
            )}

            {creatingIn === cat.category_id && (
              <div className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3">
                <ProductForm
                  labels={productLabels}
                  draft={draft}
                  setDraft={setDraft}
                  submitLabel={t("mcCreate")}
                  submitting={busyId === "new"}
                  showPhotoPicker
                  t={t}
                  subcategories={cat.subcategories}
                  onCancel={() => setCreatingIn(null)}
                  onSubmit={() =>
                    run("new", async () => {
                      const { fields: fiscalFields } = parseFiscalDraft(draft);
                      const productId = await createProduct(
                        cat.category_id,
                        draft.name,
                        draft.description || null,
                        Number(draft.price),
                        draft.shortDescription || null,
                        {
                          taxRate: fiscalFields.taxRate,
                          unitWeightGrams: fiscalFields.unitWeightGrams,
                          weightIsApproximate: fiscalFields.weightIsApproximate,
                        },
                        draft.subcategoryId
                      );
                      const photoFile = draft.photoFile;
                      setCreatingIn(null);
                      setDraft(EMPTY_PRODUCT_DRAFT);
                      // Photo facultative (V67b) : uploadée SEULEMENT
                      // une fois le vrai product_id obtenu (le chemin
                      // Storage l'exige, voir lib/services/product-photo.ts).
                      // Gérée hors du catch de run() : un échec ici ne
                      // doit jamais faire croire que la création a
                      // échoué, le produit est déjà créé à ce stade.
                      // La valeur de retour (true en cas d'échec photo)
                      // indique à run() de préserver le message déjà
                      // posé par tryAttachPhotoAfterCreate, au lieu de
                      // l'effacer via son propre reload().
                      if (photoFile) {
                        return await tryAttachPhotoAfterCreate(productId, photoFile);
                      }
                      return false;
                    })
                  }
                />
              </div>
            )}

            {cat.products.length === 0 && cat.subcategories.length === 0 && creatingIn !== cat.category_id && (
              <p className="rounded-xl bg-stone-50 p-3 text-xs text-stone-400">
                {t("mcCategoryEmpty")}
              </p>
            )}

            <ul className="space-y-2">
              {orderForDisplay(cat.products).map((p) =>
                renderProductRow(p, cat.subcategories)
              )}
            </ul>

            {/* CATALOGUE / SUBCATEGORIES v1 -- chaque sous-catégorie de
                cette catégorie, avec ses PROPRES produits, sous les
                produits directs ci-dessus. Tableau vide pour tout
                commerçant sans sous-catégorie (comportement historique
                strictement inchangé). */}
            {cat.subcategories
              .filter(
                (sub) =>
                  !filtersActive || sub.products.some((p) => visibleProductIds.has(p.product_id))
              )
              .map((sub) => (
              <div key={sub.subcategory_id} className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="truncate text-xs font-bold uppercase tracking-wide text-stone-600">
                    {sub.subcategory_name}
                  </h3>
                  {canEdit && !showArchived && (
                    <button
                      onClick={() => startEditSubcategory(sub)}
                      className="shrink-0 rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold"
                    >
                      {t("mcEditCategory")}
                    </button>
                  )}
                </div>

                {sub.products.length === 0 && (
                  <p className="rounded-xl bg-stone-50 p-3 text-xs text-stone-400">
                    {t("mcSubcategoryEmpty")}
                  </p>
                )}

                <ul className="space-y-2">
                  {orderForDisplay(sub.products).map((p) =>
                    renderProductRow(p, cat.subcategories)
                  )}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </main>
    </>
  );
}

/**
 * Zone photo produit (V67), pour un produit EXISTANT (product_id
 * réel requis pour construire le chemin de stockage). Toujours
 * réservée à l'édition — depuis V67b, la CRÉATION dispose de son
 * propre sélecteur de photo (voir showPhotoPicker dans ProductForm) :
 * le fichier choisi est mémorisé côté client, puis uploadé séparément
 * une fois le vrai product_id obtenu après création (voir
 * tryAttachPhotoAfterCreate). Les deux mécanismes restent distincts
 * parce que le chemin de stockage multi-tenant exige un product_id
 * réel, jamais un identifiant temporaire côté client.
 *
 * La validation réelle du fichier (taille, signature binaire) a lieu
 * dans lib/services/product-photo.ts, pas ici : ce composant ne fait
 * que déclencher l'action et refléter son état (busy), sans dupliquer
 * de logique de validation.
 */

/**
 * CATALOGUE MANAGEMENT UX v1 -- champ à LIBELLÉ PERSISTANT.
 *
 * Avant ce lot, les champs du formulaire produit n'avaient qu'un
 * `placeholder` comme libellé. Un placeholder DISPARAÎT dès qu'une
 * valeur est saisie : un produit enregistré s'affichait donc comme une
 * colonne de valeurs nues -- « 5.4 / Raclette / 5.5 / 200 » -- que
 * seul quelqu'un connaissant l'ordre des champs pouvait interpréter.
 * Le prix, le taux de TVA et le poids étaient en particulier
 * indiscernables.
 *
 * Le libellé est ici un vrai <label> lié au champ par `htmlFor` : il
 * reste visible en permanence ET il est associé au champ pour les
 * lecteurs d'écran, ce qu'un placeholder ne fait pas.
 */
function LabeledField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-stone-600">
        {label}
      </label>
      {children}
      {hint && <p className="mt-0.5 text-xs text-stone-400">{hint}</p>}
    </div>
  );
}

/**
 * CATALOGUE MANAGEMENT UX v1 -- affichage et édition des tags d'un
 * produit, sur la fondation COLLECTIONS / TAGS déjà publiée.
 *
 * Consomme les contrats existants, sans second modèle de tags :
 *   - `addProductTags` résout-ou-crée côté SERVEUR puis associe, de
 *     façon idempotente et strictement additive -- ajouter un tag déjà
 *     présent ne crée donc aucun doublon (le bouton reste inoffensif) ;
 *   - `removeProductTag` retire UNE association, sans jamais supprimer
 *     l'entité tag du tenant : le tag reste disponible pour les autres
 *     produits.
 *
 * Le même champ sert à ajouter un tag EXISTANT (proposé par la liste
 * de suggestions) et à en créer un nouveau : côté serveur c'est la
 * même opération « résoudre ou créer », il n'y a donc aucune raison
 * d'imposer deux gestes différents au marchand.
 */
function ProductTagsEditor({
  productId,
  tagNames,
  tagIds,
  knownTags,
  onChanged,
  t,
}: {
  productId: string;
  tagNames: string[];
  tagIds: string[];
  knownTags: { id: string; name: string }[];
  onChanged: () => void | Promise<void>;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setTagError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setTagError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-2.5" data-testid="product-tags-editor">
      <p className="text-xs font-semibold text-stone-600">{t("mcProductTagsLabel")}</p>

      {tagNames.length === 0 ? (
        <p className="text-xs text-stone-400" data-testid="product-tags-empty">
          {t("mcProductTagsNone")}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {tagNames.map((name, i) => (
            <li key={tagIds[i] ?? name}>
              <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs text-stone-800 ring-1 ring-stone-300">
                <span data-testid="product-tag-name">{name}</span>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="product-tag-remove"
                  data-tag-id={tagIds[i]}
                  aria-label={t("mcProductTagRemove", { name })}
                  onClick={() => run(() => removeProductTag(productId, tagIds[i]))}
                  className="text-stone-500 hover:text-red-700"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <input
          list="product-tag-suggestions"
          value={input}
          disabled={busy}
          data-testid="product-tag-input"
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("mcProductTagNewPlaceholder")}
          aria-label={t("mcProductTagAdd")}
          className="min-w-0 flex-1 rounded-xl border border-stone-300 p-2 text-sm"
        />
        <datalist id="product-tag-suggestions">
          {knownTags.map((tg) => (
            <option key={tg.id} value={tg.name} />
          ))}
        </datalist>
        <button
          type="button"
          disabled={busy || input.trim() === ""}
          data-testid="product-tag-add"
          onClick={() =>
            run(async () => {
              await addProductTags(productId, [input.trim()]);
              setInput("");
            })
          }
          className="rounded-xl border border-stone-300 px-3 py-2 text-sm font-medium text-stone-800 disabled:text-stone-400"
        >
          {t("mcProductTagAdd")}
        </button>
      </div>

      {tagError && (
        <p className="text-xs font-semibold text-amber-700" data-testid="product-tag-error">
          {tagError}
        </p>
      )}
    </div>
  );
}

/**
 * P1 CUSTOMER COLLECTIONS BY TAGS -- réglage RESTAURANT des collections
 * client, sur les tags déjà chargés (`knownTags`, get_restaurant_tags).
 *
 * Une ligne par tag actif : état public/interne, ordre d'affichage.
 * L'unique écriture est `updateTagCollectionSettings` (RPC
 * update_tag_collection_settings, autorisation owner/manager/opérateur
 * et isolation tenant SERVEUR). Après succès, `onSaved` recharge les
 * tags depuis le serveur ; en échec, l'erreur est annoncée (role=alert)
 * et rien n'est présenté comme enregistré.
 *
 * Contexte restaurant : `restaurantId` est capturé au clic ; si
 * `isCurrentRestaurant` ne le reconnaît plus à la réponse (bascule
 * A -> B pendant l'appel), la réponse est ignorée -- aucun
 * rechargement, aucun message sur l'écran de B. Le parent remonte ce
 * composant à chaque changement de restaurant (key).
 */
function CustomerCollectionsSettings({
  restaurantId,
  tags,
  isCurrentRestaurant,
  onSaved,
  t,
}: {
  restaurantId: string;
  tags: RestaurantTag[];
  isCurrentRestaurant: (id: string) => boolean;
  onSaved: (id: string) => void | Promise<void>;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <section
      aria-labelledby="customer-collections-title"
      data-testid="customer-collections-settings"
      className="mb-4 space-y-2 rounded-xl border border-stone-200 bg-white p-3"
    >
      <h2 id="customer-collections-title" className="text-sm font-bold text-stone-800">
        {t("mcCollectionsTitle")}
      </h2>
      <p className="text-xs text-stone-500">{t("mcCollectionsHint")}</p>
      {tags.length === 0 ? (
        <p className="text-xs text-stone-400" data-testid="customer-collections-empty">
          {t("mcCollectionsNone")}
        </p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {tags.map((tag) => (
            <CustomerCollectionRow
              // Remonté à chaque nouvelle valeur SERVEUR : le brouillon
              // repart toujours de l'état rechargé.
              key={`${tag.id}:${tag.visibleOnCustomerMenu}:${tag.displayOrder}`}
              restaurantId={restaurantId}
              tag={tag}
              isCurrentRestaurant={isCurrentRestaurant}
              onSaved={onSaved}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CustomerCollectionRow({
  restaurantId,
  tag,
  isCurrentRestaurant,
  onSaved,
  t,
}: {
  restaurantId: string;
  tag: RestaurantTag;
  isCurrentRestaurant: (id: string) => boolean;
  onSaved: (id: string) => void | Promise<void>;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const [visible, setVisible] = useState(tag.visibleOnCustomerMenu);
  const [order, setOrder] = useState(String(tag.displayOrder));
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const orderValid = /^-?\d+$/.test(order.trim()) && Number.isSafeInteger(Number(order.trim()));
  const dirty = visible !== tag.visibleOnCustomerMenu || order.trim() !== String(tag.displayOrder);

  async function save() {
    if (busy) return;
    if (!orderValid) {
      setRowError(t("mcCollectionOrderInvalid"));
      return;
    }
    const contextId = restaurantId;
    setBusy(true);
    setRowError(null);
    try {
      await updateTagCollectionSettings(tag.id, visible, Number(order.trim()));
      if (!isCurrentRestaurant(contextId)) return;
      await onSaved(contextId);
    } catch (e) {
      if (!isCurrentRestaurant(contextId)) return;
      setRowError(t("mcCollectionSaveFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const checkboxId = `collection-visible-${tag.id}`;
  const orderId = `collection-order-${tag.id}`;
  const errorId = `collection-error-${tag.id}`;

  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="customer-collection-row">
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-semibold text-stone-800" data-testid="customer-collection-name">
          {tag.name}
        </span>{" "}
        <span className="text-xs text-stone-500">
          · {t("mcCollectionProducts", { n: tag.productCount })} ·{" "}
          <span data-testid="customer-collection-state">
            {tag.visibleOnCustomerMenu ? t("mcCollectionPublic") : t("mcCollectionPrivate")}
          </span>
        </span>
      </span>
      <input
        id={checkboxId}
        type="checkbox"
        checked={visible}
        disabled={busy}
        data-testid="customer-collection-visible"
        onChange={(e) => setVisible(e.target.checked)}
        aria-describedby={rowError ? errorId : undefined}
        className="h-4 w-4"
      />
      <label htmlFor={checkboxId} className="text-xs text-stone-700">
        {t("mcCollectionVisible", { name: tag.name })}
      </label>
      <label htmlFor={orderId} className="sr-only">
        {t("mcCollectionOrder", { name: tag.name })}
      </label>
      <input
        id={orderId}
        type="number"
        inputMode="numeric"
        step={1}
        value={order}
        disabled={busy}
        data-testid="customer-collection-order"
        onChange={(e) => setOrder(e.target.value)}
        aria-invalid={!orderValid}
        aria-describedby={rowError ? errorId : undefined}
        className="w-20 rounded-xl border border-stone-300 p-2 text-sm"
      />
      <button
        type="button"
        disabled={busy || !dirty}
        data-testid="customer-collection-save"
        aria-label={t("mcCollectionSaveFor", { name: tag.name })}
        onClick={() => void save()}
        className="rounded-xl border border-stone-300 px-3 py-2 text-sm font-medium text-stone-800 disabled:text-stone-400"
      >
        {t("mcCollectionSave")}
      </button>
      {rowError && (
        <p
          id={errorId}
          role="alert"
          className="w-full text-xs font-semibold text-red-700"
          data-testid="customer-collection-error"
        >
          {rowError}
        </p>
      )}
    </li>
  );
}

function ProductPhotoField({
  productId,
  imageUrl,
  productName,
  busy,
  t,
  onAddOrReplace,
  onRemove,
}: {
  productId: string;
  imageUrl: string | null;
  productName: string;
  busy: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
  onAddOrReplace: (file: File) => void;
  onRemove: () => void;
}) {
  const inputId = `product-photo-${productId}`;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permet de re-choisir le même fichier ensuite
    if (file) onAddOrReplace(file);
  }

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-stone-200 bg-stone-50 p-2.5">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={t("ariaProductPhotoPreview", { name: productName })}
          className="h-14 w-14 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-stone-300 text-[10px] text-stone-400">
          {t("mcPhotoNone")}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          aria-disabled={busy}
          className={
            "cursor-pointer rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold " +
            (busy ? "pointer-events-none opacity-40" : "")
          }
        >
          {busy ? t("mcPhotoUploading") : imageUrl ? t("mcPhotoReplace") : t("mcPhotoAdd")}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          disabled={busy}
          onChange={handleFileChange}
        />
        {imageUrl && (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 disabled:opacity-40"
          >
            {t("mcPhotoRemove")}
          </button>
        )}
      </div>
    </div>
  );
}

function CategoryForm({
  mode,
  draft,
  setDraft,
  onSubmit,
  onCancel,
  t,
}: {
  mode: "create" | "edit";
  draft: CategoryDraft;
  setDraft: (d: CategoryDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const nameState = normalizeText(draft.name, CATEGORY_NAME_MAX_LENGTH);
  const descriptionState = normalizeText(draft.description, LONG_DESCRIPTION_MAX_LENGTH);
  const orderValid =
    mode === "create" ||
    (draft.displayOrder.trim() !== "" && Number.isFinite(Number(draft.displayOrder)));
  const valid =
    !nameState.isEmpty && nameState.isValid && orderValid && descriptionState.isValid;

  return (
    <div className="space-y-2">
      <input
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder={t("mcCategoryName")}
        className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
      />
      <p
        className={
          "text-right text-xs " +
          (nameState.isValid ? "text-stone-400" : "font-semibold text-amber-700")
        }
      >
        {t("mcCounter", { count: nameState.length, max: CATEGORY_NAME_MAX_LENGTH })}
      </p>

      {/* Description longue de catégorie (V67b) — facultative, jamais
          pré-remplie depuis une autre donnée : startEditCategory ne
          lit que menu_categories.description telle qu'elle est, sans
          reclasser une description produit ou toute autre valeur
          historique. Édition uniquement : create_category reste à 3
          paramètres (décision documentée dans la migration), la
          description s'ajoute après coup, pas à la création. */}
      {mode === "edit" && (
        <div>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder={t("mcCategoryDescription")}
            rows={2}
            className={
              "w-full rounded-xl border p-2.5 text-sm " +
              (descriptionState.isValid ? "border-stone-300" : "border-amber-500 bg-amber-50")
            }
          />
          <p
            className={
              "mt-0.5 text-right text-xs " +
              (descriptionState.isValid ? "text-stone-400" : "font-semibold text-amber-700")
            }
          >
            {t("mcCounter", { count: descriptionState.length, max: LONG_DESCRIPTION_MAX_LENGTH })}
          </p>
        </div>
      )}
      {mode === "edit" && (
        <input
          value={draft.displayOrder}
          onChange={(e) => setDraft({ ...draft, displayOrder: e.target.value })}
          inputMode="numeric"
          placeholder={t("mcCategoryOrder")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid}
          className="flex-1 rounded-xl bg-stone-900 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {mode === "create" ? t("mcCreate") : t("mcSave")}
        </button>
        <button
          onClick={onCancel}
          className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold"
        >
          {t("mcCancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * CATALOGUE / SUBCATEGORIES v1 -- même patron minimal que CategoryForm
 * ci-dessus : nom + ordre d'affichage (édition uniquement, comme pour
 * une catégorie -- create_subcategory calcule un ordre par défaut).
 * Pas de champ description (les sous-catégories n'en ont pas, voir la
 * migration -- limite documentée, pas une omission).
 */
function SubcategoryForm({
  mode,
  draft,
  setDraft,
  onSubmit,
  onCancel,
  t,
}: {
  mode: "create" | "edit";
  draft: SubcategoryDraft;
  setDraft: (d: SubcategoryDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const nameState = normalizeText(draft.name, CATEGORY_NAME_MAX_LENGTH);
  const orderValid =
    mode === "create" ||
    (draft.displayOrder.trim() !== "" && Number.isFinite(Number(draft.displayOrder)));
  const valid = !nameState.isEmpty && nameState.isValid && orderValid;

  return (
    <div className="space-y-2">
      <input
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder={t("mcSubcategoryName")}
        className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
      />
      <p
        className={
          "text-right text-xs " +
          (nameState.isValid ? "text-stone-400" : "font-semibold text-amber-700")
        }
      >
        {t("mcCounter", { count: nameState.length, max: CATEGORY_NAME_MAX_LENGTH })}
      </p>

      {mode === "edit" && (
        <input
          value={draft.displayOrder}
          onChange={(e) => setDraft({ ...draft, displayOrder: e.target.value })}
          inputMode="numeric"
          placeholder={t("mcCategoryOrder")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid}
          className="flex-1 rounded-xl bg-stone-900 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {mode === "create" ? t("mcCreate") : t("mcSave")}
        </button>
        <button
          onClick={onCancel}
          className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold"
        >
          {t("mcCancel")}
        </button>
      </div>
    </div>
  );
}

function ProductForm({
  draft,
  setDraft,
  submitLabel,
  labels,
  onSubmit,
  onCancel,
  t,
  submitting = false,
  showPhotoPicker = false,
  subcategories = [],
}: {
  draft: ProductDraft;
  setDraft: (d: ProductDraft) => void;
  submitLabel: string;
  labels: {
    name: string;
    shortDescription: string;
    description: string;
    price: string;
    cancel: string;
    baseHint?: string;
  };
  onSubmit: () => void;
  onCancel: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
  /** Empêche le double-clic pendant qu'une soumission est déjà en vol. */
  submitting?: boolean;
  /** Sélecteur de photo (V67b) — création uniquement. En édition, la
   *  photo se gère via ProductPhotoField (product_id déjà réel). */
  showPhotoPicker?: boolean;
  /** CATALOGUE / SUBCATEGORIES v1 -- sous-catégories DE LA CATÉGORIE
   *  ACTUELLE de ce produit, proposées dans un sélecteur optionnel.
   *  Tableau vide (commerçant sans sous-catégorie) = aucun sélecteur
   *  affiché, formulaire strictement identique à avant ce lot. */
  subcategories?: CatalogueSubcategory[];
}) {
  const shortState = normalizeText(draft.shortDescription, SHORT_DESCRIPTION_MAX_LENGTH);
  const longState = normalizeText(draft.description, LONG_DESCRIPTION_MAX_LENGTH);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const { fields: fiscalFields, formatOk: fiscalFormatOk } = parseFiscalDraft(draft);
  const fiscalFieldError = validateFiscalMeasurementFields(fiscalFields);
  const fiscalError = !fiscalFormatOk ? "SCANYM_INVALID_WEIGHT_VALUE" : fiscalFieldError;
  // Aperçu du prix de référence au kg (métadonnée de RÉFÉRENCE
  // uniquement, mandat §6) -- affiché en confort si un poids valide
  // est renseigné, jamais transmis au serveur (colonne générée).
  const referencePreview =
    fiscalFieldError === null && fiscalFields.unitWeightGrams !== null
      ? referencePricePerKg(Number(draft.price) || 0, fiscalFields.unitWeightGrams)
      : null;
  const valid =
    draft.name.trim().length > 0 &&
    Number(draft.price) >= 0 &&
    draft.price.trim() !== "" &&
    shortState.isValid &&
    longState.isValid &&
    fiscalError === null &&
    !submitting;

  const previewUrl = useMemo(
    () => (draft.photoFile ? URL.createObjectURL(draft.photoFile) : null),
    [draft.photoFile]
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoError(null);
    try {
      // Validation immédiate côté client (taille + signature binaire
      // réelle, jamais l'extension ni file.type) : même logique que
      // l'upload réel, réutilisée pour ne jamais dupliquer les règles
      // — un fichier qui échoue ici échouerait de toute façon à
      // l'upload, autant le dire avant de créer le produit.
      await validateProductPhotoFile(file);
      setDraft({ ...draft, photoFile: file });
    } catch (err) {
      if (err instanceof InvalidFileTypeError) setPhotoError(t("mcPhotoInvalidType"));
      else if (err instanceof FileTooLargeError) setPhotoError(t("mcPhotoTooLarge"));
      else setPhotoError(t("mcPhotoInvalidType"));
    }
  }

  return (
    <div className="space-y-2">
      {labels.baseHint && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          {labels.baseHint}
        </p>
      )}

      {showPhotoPicker && (
        <div className="flex items-center gap-3 rounded-xl border border-stone-200 bg-stone-50 p-2.5">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={t("mcPhotoPreviewAlt")}
              className="h-14 w-14 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <ProductPhotoPlaceholder className="h-14 w-14 shrink-0 rounded-lg" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label
              htmlFor="new-product-photo"
              className="w-fit cursor-pointer rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold"
            >
              {draft.photoFile ? t("mcPhotoReplace") : t("mcPhotoAdd")}
            </label>
            <input
              id="new-product-photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handlePhotoChange}
            />
            <p className="text-[11px] text-stone-400">{t("mcPhotoOptionalHint")}</p>
            {photoError && (
              <p className="text-xs font-semibold text-amber-700">{photoError}</p>
            )}
          </div>
          {draft.photoFile && (
            <button
              type="button"
              onClick={() => setDraft({ ...draft, photoFile: null })}
              className="shrink-0 rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700"
            >
              {t("mcPhotoRemove")}
            </button>
          )}
        </div>
      )}

      <LabeledField id="product-name" label={labels.name}>
        <input
          id="product-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={labels.name}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      </LabeledField>

      <div>
        <label htmlFor="product-short-description" className="mb-1 block text-xs font-semibold text-stone-600">
          {labels.shortDescription}
        </label>
        <input
          id="product-short-description"
          value={draft.shortDescription}
          onChange={(e) => setDraft({ ...draft, shortDescription: e.target.value })}
          placeholder={labels.shortDescription}
          className={
            "w-full rounded-xl border p-2.5 text-sm " +
            (shortState.isValid ? "border-stone-300" : "border-amber-500 bg-amber-50")
          }
        />
        <p
          className={
            "mt-0.5 text-right text-xs " +
            (shortState.isValid ? "text-stone-400" : "font-semibold text-amber-700")
          }
        >
          {t("mcCounter", { count: shortState.length, max: SHORT_DESCRIPTION_MAX_LENGTH })}
        </p>
      </div>

      <div>
        <label htmlFor="product-description" className="mb-1 block text-xs font-semibold text-stone-600">
          {labels.description}
        </label>
        <textarea
          id="product-description"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder={labels.description}
          rows={2}
          className={
            "w-full rounded-xl border p-2.5 text-sm " +
            (longState.isValid ? "border-stone-300" : "border-amber-500 bg-amber-50")
          }
        />
        <p
          className={
            "mt-0.5 text-right text-xs " +
            (longState.isValid ? "text-stone-400" : "font-semibold text-amber-700")
          }
        >
          {t("mcCounter", { count: longState.length, max: LONG_DESCRIPTION_MAX_LENGTH })}
        </p>
      </div>

      <LabeledField id="product-price" label={labels.price}>
        <input
          id="product-price"
          value={draft.price}
          onChange={(e) =>
            setDraft({ ...draft, price: e.target.value.replace(",", ".") })
          }
          inputMode="decimal"
          placeholder={labels.price}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      </LabeledField>

      {/* CATALOGUE / SUBCATEGORIES v1 -- placement optionnel du
          produit dans une sous-catégorie de sa catégorie actuelle.
          N'apparaît que si cette catégorie a au moins une
          sous-catégorie : un commerçant qui n'en utilise aucune ne
          voit jamais ce sélecteur (formulaire inchangé). */}
      {subcategories.length > 0 && (
        <LabeledField id="product-subcategory" label={t("mcProductSubcategoryLabel")}>
        <select
          id="product-subcategory"
          value={draft.subcategoryId ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              subcategoryId: e.target.value === "" ? null : e.target.value,
            })
          }
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        >
          <option value="">{t("mcProductSubcategoryNone")}</option>
          {subcategories.map((s) => (
            <option key={s.subcategory_id} value={s.subcategory_id}>
              {s.subcategory_name}
            </option>
          ))}
        </select>
        </LabeledField>
      )}

      {/* CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 (mandat §8) --
          modèle SIMPLIFIÉ portion-à-prix-fixe : champs indépendants
          (plus de mode de prix, plus d'unité de vente, plus de
          matrice de combinaison -- mandat §22). Le poids est une
          information catalogue/logistique, jamais un second calcul de
          prix (mandat §11). */}
      <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-2.5">
        <LabeledField id="product-tax-rate" label={t("fiscalTaxRateLabel")}>
          <input
            id="product-tax-rate"
            value={draft.taxRate}
            onChange={(e) => setDraft({ ...draft, taxRate: e.target.value.replace(",", ".") })}
            inputMode="decimal"
            placeholder={t("fiscalTaxRateLabel")}
            className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          />
        </LabeledField>

        <LabeledField id="product-unit-weight" label={t("fiscalUnitWeightLabel")}>
          <input
            id="product-unit-weight"
            value={draft.unitWeightGrams}
            onChange={(e) => setDraft({ ...draft, unitWeightGrams: e.target.value })}
            inputMode="numeric"
            placeholder={t("fiscalUnitWeightLabel")}
            className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          />
        </LabeledField>

        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={draft.weightIsApproximate}
            onChange={(e) => setDraft({ ...draft, weightIsApproximate: e.target.checked })}
          />
          {t("fiscalWeightIsApproximateLabel")}
        </label>

        {/* CATALOGUE MANAGEMENT UX v1 -- le libellé du prix de
            référence est désormais TOUJOURS affiché (mandat §4 le
            liste parmi les champs devant porter un libellé explicite).
            Auparavant, faute de poids saisi, la ligne disparaissait
            entièrement et le marchand ne savait pas que cette donnée
            existait. La valeur reste, elle, calculée par la base. */}
        <p className="text-xs text-stone-500" data-testid="reference-price-per-kg">
          {t("fiscalReferencePricePerKgLabel")}:{" "}
          {referencePreview !== null ? (
            <>
              <Ltr>{referencePreview.toFixed(2)}</Ltr>
              {t("fiscalPerKgSuffix")}
            </>
          ) : (
            "—"
          )}
        </p>

        {fiscalError && (
          <p className="text-xs font-semibold text-amber-700">{fiscalErrorMessage(fiscalError, t)}</p>
        )}

        {/* CATALOGUE VAT COMPLETENESS GUARD v1 -- avertissement NON
            BLOQUANT (Layer A) : n'affecte jamais `valid` ci-dessus.
            Affiché uniquement quand le champ TVA lui-même est par
            ailleurs valide (fiscalError === null) et vide -- une
            erreur de format/plage a déjà sa propre alerte ci-dessus,
            pas besoin de doubler le message. */}
        {fiscalError === null && !canProductBeAvailableWithTaxRate(fiscalFields.taxRate) && (
          <p className="text-xs text-stone-500">{t("fiscalTaxMissingAvailabilityNotice")}</p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid}
          aria-busy={submitting}
          className="flex-1 rounded-xl bg-stone-900 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {submitting ? t("mcSaving") : submitLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={submitting}
          className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
        >
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}

/**
 * Contrôle d'ordre numérique réutilisable (V67b) — catégories et
 * produits. Pas de glisser-déposer (hors périmètre V67b, un contrôle
 * numérique suffit). La valeur locale n'est envoyée qu'au clic sur
 * "Enregistrer", jamais à chaque frappe.
 */
function OrderField({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onSave: (order: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  const changed = local.trim() !== "" && Number(local) !== value && Number.isFinite(Number(local));

  return (
    <div className="flex items-center gap-1.5">
      <label className="text-xs font-medium text-stone-500">{label}</label>
      <input
        type="number"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        disabled={disabled}
        className="w-16 rounded-lg border border-stone-300 p-1.5 text-center text-xs"
      />
      {changed && (
        <button
          type="button"
          onClick={() => onSave(Number(local))}
          disabled={disabled}
          className="rounded-lg bg-stone-900 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          ✓
        </button>
      )}
    </div>
  );
}
