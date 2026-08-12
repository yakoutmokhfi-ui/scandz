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
  CategoryDuplicateNameError,
  CategoryDescriptionTooLongError,
  DescriptionTooLongError,
  ShortDescriptionTooLongError,
  type CatalogueCategory,
  type CatalogueProduct,
} from "@/lib/services/dashboard";
import {
  addOrReplaceProductPhoto,
  removeProductPhoto,
  validateProductPhotoFile,
  InvalidFileTypeError,
  FileTooLargeError,
  PhotoUploadError,
  PhotoRemoveError,
} from "@/lib/services/product-photo";
import ProductPhotoPlaceholder from "@/components/ProductPhotoPlaceholder";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { formatPrice } from "@/lib/whatsapp";
import { canEditProducts, canToggleAvailability } from "@/lib/roles";
import {
  normalizeText,
  SHORT_DESCRIPTION_MAX_LENGTH,
  LONG_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
} from "@/lib/catalogue-text";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { translate, type Lang } from "@/lib/i18n";
import Ltr from "@/components/Bidi";

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
};

type CategoryDraft = {
  name: string;
  displayOrder: string;
  description: string;
};

const EMPTY_PRODUCT_DRAFT: ProductDraft = {
  name: "",
  shortDescription: "",
  description: "",
  price: "",
  photoFile: null,
};

export default function CataloguePage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [categories, setCategories] = useState<CatalogueCategory[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const [currency, setCurrency] = useState("DZD");
  const [staffLang, setStaffLang] = useState<string>("fr");

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEdit = canEditProducts(mapping?.role);
  const canToggle = canToggleAvailability(mapping?.role);
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
        const next = await getMerchantRestaurants();
        if (next.length === 0) {
          setError(t("mcNoRestaurant"));
        } else {
          setMappings(next);
          const wanted = new URLSearchParams(window.location.search).get("r");
          const match = wanted
            ? next.find((m) => m.restaurant_id === wanted)
            : undefined;
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
    setDraft(EMPTY_PRODUCT_DRAFT);
    setCategoryDraft({ name: "", displayOrder: "", description: "" });
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
      } else {
        setError(e instanceof Error ? e.message : t("mcRefused"));
      }
    } finally {
      setBusyId(null);
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
      await addOrReplaceProductPhoto(restaurantId, productId, file, null);
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

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? t("mcTitle")}
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
        </div>

        {error && (
          <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {error}
          </p>
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
                  onCancel={() => setCreatingIn(null)}
                  onSubmit={() =>
                    run("new", async () => {
                      const productId = await createProduct(
                        cat.category_id,
                        draft.name,
                        draft.description || null,
                        Number(draft.price),
                        draft.shortDescription || null
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

            {cat.products.length === 0 && creatingIn !== cat.category_id && (
              <p className="rounded-xl bg-stone-50 p-3 text-xs text-stone-400">
                {t("mcCategoryEmpty")}
              </p>
            )}

            <ul className="space-y-2">
              {cat.products.map((p) => {
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
                              await addOrReplaceProductPhoto(
                                restaurantId,
                                p.product_id,
                                file,
                                p.image_url
                              );
                            })
                          }
                          onRemove={() =>
                            run(p.product_id, async () => {
                              await removeProductPhoto(p.product_id, p.image_url);
                            })
                          }
                        />
                        <ProductForm
                          labels={productLabels}
                          draft={draft}
                          setDraft={setDraft}
                          submitLabel={t("mcSave")}
                          submitting={busyId === p.product_id}
                          onCancel={() => setEditingId(null)}
                          t={t}
                          onSubmit={() =>
                            run(p.product_id, async () => {
                              await updateProduct(
                                p.product_id,
                                draft.name,
                                draft.description || null,
                                Number(draft.price),
                                draft.shortDescription || null
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
              })}
            </ul>
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
}) {
  const shortState = normalizeText(draft.shortDescription, SHORT_DESCRIPTION_MAX_LENGTH);
  const longState = normalizeText(draft.description, LONG_DESCRIPTION_MAX_LENGTH);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const valid =
    draft.name.trim().length > 0 &&
    Number(draft.price) >= 0 &&
    draft.price.trim() !== "" &&
    shortState.isValid &&
    longState.isValid &&
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
