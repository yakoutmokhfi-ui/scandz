"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { translate, type Lang } from "@/lib/i18n";
import Ltr from "@/components/Bidi";
import {
  validateFiscalMeasurementFields,
  referencePricePerKg,
  type FiscalMeasurementFields,
  type FiscalValidationErrorCode,
} from "@/lib/catalogue-fiscal";
import { FiscalMeasurementValidationError } from "@/lib/services/catalogue-error";

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
    for (const cat of categories) {
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
  }, [categories]);
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
      try {
        setCategories(await getMerchantCatalogue(id, archived));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("mcLoadFailed"));
      }
    },
    []
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
        const match = wanted
          ? next.find((m) => m.restaurant_id === wanted)
          : undefined;

        if (wanted && !match && opFlag) {
          // OPERATOR DASHBOARD CONTEXT v1 : opérateur Scanym consultant
          // un établissement hors de ses propres rattachements
          // restaurant_users (même correction F-01 que settings/page.tsx)
          // -- le lien ?r=<id> fait foi, la protection réelle reste
          // côté RPC (assert_product_role/assert_category_role/
          // assert_subcategory_role). JAMAIS de repli sur next[0] ici :
          // un opérateur qui n'a lui-même AUCUN rattachement (next
          // vide) doit quand même pouvoir consulter le restaurant
          // ciblé -- vérifié AVANT le test `next.length === 0`
          // ci-dessous, contrairement à l'ordre précédent de ce bloc.
          setRestaurantId(wanted);
          try {
            const summary = await getEstablishmentSummary(wanted);
            setOperatorRestaurantName(summary.name);
          } catch {
            // Best-effort : un nom introuvable n'empêche pas de
            // continuer (l'ID reste la source de vérité pour le
            // chargement du catalogue -- voir reload() plus haut).
          }
        } else if (next.length === 0) {
          setError(t("mcNoRestaurant"));
        } else {
          setRestaurantId((match ?? next[0]).restaurant_id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : t("mcLoadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    void reload(restaurantId, showArchived);
  }, [restaurantId, showArchived, reload]);

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
  useEffect(() => {
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

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? operatorRestaurantName ?? t("mcTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={staffLang}
        onSelectRestaurant={setRestaurantId}
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

        {categories.length === 0 && (
          <p className="rounded-xl bg-stone-100 p-4 text-sm text-stone-500">
            {showArchived ? t("mcEmptyArchived") : t("mcEmpty")}
          </p>
        )}

        {categories.map((cat) => (
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
              {cat.products.map((p) => renderProductRow(p, cat.subcategories))}
            </ul>

            {/* CATALOGUE / SUBCATEGORIES v1 -- chaque sous-catégorie de
                cette catégorie, avec ses PROPRES produits, sous les
                produits directs ci-dessus. Tableau vide pour tout
                commerçant sans sous-catégorie (comportement historique
                strictement inchangé). */}
            {cat.subcategories.map((sub) => (
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
                  {sub.products.map((p) => renderProductRow(p, cat.subcategories))}
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

      <input
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder={labels.name}
        className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
      />

      <div>
        <input
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
        <textarea
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

      <input
        value={draft.price}
        onChange={(e) =>
          setDraft({ ...draft, price: e.target.value.replace(",", ".") })
        }
        inputMode="decimal"
        placeholder={labels.price}
        className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
      />

      {/* CATALOGUE / SUBCATEGORIES v1 -- placement optionnel du
          produit dans une sous-catégorie de sa catégorie actuelle.
          N'apparaît que si cette catégorie a au moins une
          sous-catégorie : un commerçant qui n'en utilise aucune ne
          voit jamais ce sélecteur (formulaire inchangé). */}
      {subcategories.length > 0 && (
        <select
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
      )}

      {/* CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 (mandat §8) --
          modèle SIMPLIFIÉ portion-à-prix-fixe : champs indépendants
          (plus de mode de prix, plus d'unité de vente, plus de
          matrice de combinaison -- mandat §22). Le poids est une
          information catalogue/logistique, jamais un second calcul de
          prix (mandat §11). */}
      <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-2.5">
        <input
          value={draft.taxRate}
          onChange={(e) => setDraft({ ...draft, taxRate: e.target.value.replace(",", ".") })}
          inputMode="decimal"
          placeholder={t("fiscalTaxRateLabel")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />

        <input
          value={draft.unitWeightGrams}
          onChange={(e) => setDraft({ ...draft, unitWeightGrams: e.target.value })}
          inputMode="numeric"
          placeholder={t("fiscalUnitWeightLabel")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />

        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={draft.weightIsApproximate}
            onChange={(e) => setDraft({ ...draft, weightIsApproximate: e.target.checked })}
          />
          {t("fiscalWeightIsApproximateLabel")}
        </label>

        {referencePreview !== null && (
          <p className="text-xs text-stone-500">
            {t("fiscalReferencePricePerKgLabel")}: <Ltr>{referencePreview.toFixed(2)}</Ltr>
            {t("fiscalPerKgSuffix")}
          </p>
        )}

        {fiscalError && (
          <p className="text-xs font-semibold text-amber-700">{fiscalErrorMessage(fiscalError, t)}</p>
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
