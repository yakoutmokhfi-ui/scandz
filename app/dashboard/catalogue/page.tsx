"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  archiveProduct,
  createProduct,
  getMerchantCatalogue,
  getMerchantRestaurants,
  getRestaurantSettings,
  restoreProduct,
  setProductAvailability,
  updateProduct,
  type CatalogueProduct,
} from "@/lib/services/dashboard";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { formatPrice } from "@/lib/whatsapp";
import { canEditProducts, canToggleAvailability } from "@/lib/roles";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { translate, type Lang } from "@/lib/i18n";
import Ltr from "@/components/Bidi";

type Draft = { name: string; description: string; price: string };

export default function CataloguePage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", description: "", price: "" });
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [currency, setCurrency] = useState("DZD");
  const [staffLang, setStaffLang] = useState<string>("fr");

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEdit = canEditProducts(mapping?.role);
  const canToggle = canToggleAvailability(mapping?.role);
  const lang = staffLang as Lang;
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  /**
   * Nom affiché dans la langue du gérant. La valeur de base
   * (française) reste celle qu'il modifie : les traductions ne sont
   * pas éditables depuis cet écran.
   */
  const shown = (
    base: string | null,
    tr: Record<string, { name?: string; description?: string }> | null,
    field: "name" | "description"
  ) => (lang === "fr" ? base : (tr?.[lang]?.[field] ?? base));

  const formLabels = {
    name: t("mcName"),
    description: t("mcDescription"),
    price: t("mcPrice"),
    cancel: t("mcCancel"),
    // Affiché seulement quand le gérant ne travaille pas dans la
    // langue de base de sa carte.
    baseHint: lang === "fr" ? undefined : t("mcEditBaseHint"),
  };

  const reload = useCallback(
    async (id: string, archived: boolean) => {
      if (!id) return;
      try {
        setProducts(await getMerchantCatalogue(id, archived));
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
          // Conserve l'établissement choisi sur la page commandes
          // Lu depuis l'URL côté client : évite d'imposer une
          // frontière Suspense au prérendu.
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

  // La devise suit l'établissement sélectionné : DA pour Illico,
  // € pour Sanaa.
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

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await reload(restaurantId, showArchived);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("mcRefused"));
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(p: CatalogueProduct) {
    setEditingId(p.product_id);
    setCreatingIn(null);
    setDraft({
      name: p.name,
      description: p.description ?? "",
      price: String(p.price),
    });
  }

  function startCreate(categoryId: string) {
    setCreatingIn(categoryId);
    setEditingId(null);
    setDraft({ name: "", description: "", price: "" });
  }

  // Regroupement par catégorie, en conservant l'ordre du serveur
  const categories: {
    id: string;
    name: string;
    translations: Record<string, { name?: string }> | null;
    items: CatalogueProduct[];
  }[] = [];
  for (const p of products) {
    let group = categories.find((c) => c.id === p.category_id);
    if (!group) {
      group = {
        id: p.category_id,
        name: p.category_name,
        translations: p.category_translations,
        items: [],
      };
      categories.push(group);
    }
    group.items.push(p);
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
        {/* Retour explicite : le commerçant ne doit jamais avoir
            besoin du bouton retour du navigateur. */}
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          ← Retour aux commandes
        </a>

        <p className="mb-4 text-sm text-stone-500">
          {canEdit
            ? t("mcHintEdit")
            : t("mcHintStaff")}
        </p>


      {/* Sélecteur d'établissement et navigation vivent désormais
          dans DashboardNav : ne reste ici que ce qui est propre au
          catalogue. */}
      <div className="mb-4">
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold"
        >
          {showArchived ? t("mcSeeMenu") : t("mcSeeArchived")}
        </button>
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          {error}
        </p>
      )}

      {categories.length === 0 && (
        <p className="rounded-xl bg-stone-100 p-4 text-sm text-stone-500">
          {showArchived ? t("mcEmptyArchived") : t("mcEmpty")}
        </p>
      )}

      {categories.map((cat) => (
        <section key={cat.id} className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-amber-800">
              {shown(cat.name, cat.translations, "name")}
            </h2>
            {canEdit && !showArchived && (
              <button
                onClick={() => startCreate(cat.id)}
                className="rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold"
              >
                {t("mcAddProduct")}
              </button>
            )}
          </div>

          {creatingIn === cat.id && (
            <div className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3">
              <DraftForm
                labels={formLabels}
                draft={draft}
                setDraft={setDraft}
                submitLabel={t("mcCreate")}
                onCancel={() => setCreatingIn(null)}
                onSubmit={() =>
                  run("new", async () => {
                    await createProduct(
                      cat.id,
                      draft.name,
                      draft.description || null,
                      Number(draft.price)
                    );
                    setCreatingIn(null);
                  })
                }
              />
            </div>
          )}

          <ul className="space-y-2">
            {cat.items.map((p) => {
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
                    <DraftForm
                      labels={formLabels}
                      draft={draft}
                      setDraft={setDraft}
                      submitLabel={t("mcSave")}
                      onCancel={() => setEditingId(null)}
                      onSubmit={() =>
                        run(p.product_id, async () => {
                          await updateProduct(
                            p.product_id,
                            draft.name,
                            draft.description || null,
                            Number(draft.price)
                          );
                          setEditingId(null);
                        })
                      }
                    />
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-stone-900">
                            {shown(p.name, p.translations, "name")}
                          </p>
                          {p.description && (
                            <p className="mt-0.5 text-sm text-stone-500">
                              {shown(p.description, p.translations, "description")}
                            </p>
                          )}
                          <p className="mt-1 font-bold text-amber-800">
                            <Ltr>{formatPrice(Number(p.price), currency)}</Ltr>
                          </p>
                        </div>

                        {/* Disponibilité : geste le plus fréquent,
                            accessible à tous les rôles. */}
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
                        <div className="mt-3 flex flex-wrap gap-2">
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

function DraftForm({
  draft,
  setDraft,
  submitLabel,
  labels,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  submitLabel: string;
  labels: {
    name: string;
    description: string;
    price: string;
    cancel: string;
    /** Averti que l'édition porte sur la langue de base */
    baseHint?: string;
  };
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const valid = draft.name.trim().length > 0 && Number(draft.price) >= 0
    && draft.price.trim() !== "";

  return (
    <div className="space-y-2">
      {labels.baseHint && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          {labels.baseHint}
        </p>
      )}
      <input
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder={labels.name}
        className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
      />
      <textarea
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        placeholder={labels.description}
        rows={2}
        className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
      />
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
          className="flex-1 rounded-xl bg-stone-900 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold"
        >
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}