"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getMerchantCatalogue,
  getRestaurantTranslationSettings,
  getRestaurantActiveLanguages,
  writeTranslation,
  type CatalogueCategory,
  type RestaurantTranslationSettingsRow,
} from "@/lib/services/dashboard";
import { isScanymOperator } from "@/lib/services/establishments";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { canEditProducts } from "@/lib/roles";
import { getTranslationStatus, type TranslationDisplayStatus } from "@/lib/translation-resolver";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { translate, dirOf, type Lang } from "@/lib/i18n";

type ActiveLang = { code: string; label: string; dir: "ltr" | "rtl"; display_order: number };
type TranslationsMap = Record<string, Record<string, string | undefined> | undefined> | null | undefined;

const STATUS_COLOR: Record<TranslationDisplayStatus, string> = {
  missing: "bg-stone-100 text-stone-500",
  to_review: "bg-amber-100 text-amber-800",
  validated: "bg-green-100 text-green-800",
  stale: "bg-red-100 text-red-800",
};

export default function TranslationsPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [isOperator, setIsOperator] = useState(false);
  const [uiLang] = useState<Lang>("fr");
  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<RestaurantTranslationSettingsRow | null>(null);
  const [activeLanguages, setActiveLanguages] = useState<ActiveLang[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueCategory[]>([]);
  const [targetLang, setTargetLang] = useState<string>("");

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEditFull = canEditProducts(mapping?.role);
  const canEdit = isOperator || canEditFull;

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const [s, langs, cat] = await Promise.all([
        getRestaurantTranslationSettings(id),
        getRestaurantActiveLanguages(id),
        getMerchantCatalogue(id),
      ]);
      setSettings(s);
      setActiveLanguages(langs);
      setCatalogue(cat);
      setTargetLang((prev) => {
        if (prev && langs.some((l) => l.code === prev) && prev !== s?.source_language) return prev;
        return langs.find((l) => l.code !== s?.source_language)?.code ?? "";
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec du chargement");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      try {
        const [next, opFlag] = await Promise.all([getMerchantRestaurants(), isScanymOperator()]);
        setIsOperator(opFlag);
        setMappings(next);
        if (next.length > 0) setRestaurantId(next[0].restaurant_id);
        else setError("Aucun établissement rattaché à ce compte.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Échec du chargement");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    void load(restaurantId);
  }, [restaurantId, load]);

  const dir = dirOf(uiLang, activeLanguages);

  async function handleSave(
    entityType: "restaurant" | "category" | "item",
    entityId: string,
    field: string,
    value: string,
    status: "to_review" | "validated"
  ) {
    if (!targetLang) return;
    try {
      await writeTranslation(restaurantId, entityType, entityId, field, targetLang, value, status);
      await load(restaurantId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de l'enregistrement");
    }
  }

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">Chargement…</main>;
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? "Langues & traductions"}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={setRestaurantId}
      />
      <main dir={dir} className="mx-auto max-w-2xl px-4 py-6">
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          &larr; Retour
        </a>

        <h2 className="text-xl font-black text-stone-900">Langues &amp; traductions</h2>

        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}

        {!canEdit && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            Vous pouvez consulter mais pas modifier les traductions de cet établissement.
          </p>
        )}

        {/* Identité : jamais traduite -- affichée pour contexte uniquement */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <p className="text-xs font-semibold text-stone-500">Identité de l'établissement</p>
          <p className="text-lg font-bold text-stone-900">{mapping?.restaurants?.name}</p>
          <p className="mt-1 text-xs text-stone-400">
            Le nom commercial n'est jamais traduit — il reste identique dans toutes les langues.
          </p>
        </section>

        {/* Langues */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <p className="text-xs font-semibold text-stone-500">Langue source</p>
          <p className="text-sm text-stone-900">
            {activeLanguages.find((l) => l.code === settings?.source_language)?.label ??
              settings?.source_language}
          </p>

          <p className="mt-3 text-xs font-semibold text-stone-500">Langue à traduire</p>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          >
            {activeLanguages
              .filter((l) => l.code !== settings?.source_language)
              .map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
          </select>
          {activeLanguages.length <= 1 && (
            <p className="mt-2 text-xs text-stone-400">
              Cet établissement n'a qu'une seule langue active — aucune traduction possible tant
              qu'une deuxième langue n'est pas activée dans Réglages.
            </p>
          )}
        </section>

        {targetLang && settings && (
          <>
            <TranslationField
              label="Texte de présentation"
              sourceValue={settings.intro_text}
              sourceHash={settings.intro_text_hash}
              translations={settings.translations}
              field="intro_text"
              lang={targetLang}
              canEdit={canEdit}
              onSave={(v, status) => handleSave("restaurant", restaurantId, "intro_text", v, status)}
            />
            <TranslationField
              label="Message temporaire"
              sourceValue={settings.announcement_text}
              sourceHash={settings.announcement_text_hash}
              translations={settings.translations}
              field="announcement_text"
              lang={targetLang}
              canEdit={canEdit}
              onSave={(v, status) => handleSave("restaurant", restaurantId, "announcement_text", v, status)}
            />

            {catalogue.map((cat) => (
              <section key={cat.category_id} className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
                <h3 className="font-bold text-stone-900">{cat.category_name}</h3>

                <TranslationField
                  label="Nom de catégorie"
                  sourceValue={cat.category_name}
                  sourceHash={cat.category_name_hash}
                  translations={cat.category_translations}
                  field="name"
                  lang={targetLang}
                  canEdit={canEdit}
                  onSave={(v, status) => handleSave("category", cat.category_id, "name", v, status)}
                />
                {cat.category_description && (
                  <TranslationField
                    label="Description de catégorie"
                    sourceValue={cat.category_description}
                    sourceHash={cat.category_description_hash}
                    translations={cat.category_translations}
                    field="description"
                    lang={targetLang}
                    canEdit={canEdit}
                    onSave={(v, status) => handleSave("category", cat.category_id, "description", v, status)}
                  />
                )}

                {cat.products.map((p) => (
                  <div key={p.product_id} className="mt-3 border-t border-stone-100 pt-3">
                    <p className="text-xs font-semibold text-stone-500">{p.name}</p>
                    <TranslationField
                      label="Nom du produit"
                      sourceValue={p.name}
                      sourceHash={p.name_hash}
                      translations={p.translations}
                      field="name"
                      lang={targetLang}
                      canEdit={canEdit}
                      onSave={(v, status) => handleSave("item", p.product_id, "name", v, status)}
                    />
                    {p.short_description && (
                      <TranslationField
                        label="Description courte"
                        sourceValue={p.short_description}
                        sourceHash={p.short_description_hash}
                        translations={p.translations}
                        field="short_description"
                        lang={targetLang}
                        canEdit={canEdit}
                        onSave={(v, status) => handleSave("item", p.product_id, "short_description", v, status)}
                      />
                    )}
                    {p.description && (
                      <TranslationField
                        label="Description longue"
                        sourceValue={p.description}
                        sourceHash={p.description_hash}
                        translations={p.translations}
                        field="description"
                        lang={targetLang}
                        canEdit={canEdit}
                        onSave={(v, status) => handleSave("item", p.product_id, "description", v, status)}
                      />
                    )}
                  </div>
                ))}
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}

/**
 * Un champ traduisible : texte source affiché à côté du champ de
 * traduction, statut visible (À relire / Validé / Périmé / Manquant),
 * validation explicite distincte du simple enregistrement.
 */
function TranslationField({
  label,
  sourceValue,
  sourceHash,
  translations,
  field,
  lang,
  canEdit,
  onSave,
}: {
  label: string;
  sourceValue: string | null;
  sourceHash: string | null | undefined;
  translations: TranslationsMap;
  field: string;
  lang: string;
  canEdit: boolean;
  onSave: (value: string, status: "to_review" | "validated") => void;
}) {
  const status = getTranslationStatus(sourceHash, translations, lang, field);
  const storedValue = translations?.[lang]?.[field] ?? "";
  const [draft, setDraft] = useState(storedValue);

  useEffect(() => {
    setDraft(storedValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, field, storedValue]);

  return (
    <div className="mt-4 border-t border-stone-100 pt-3 first:mt-0 first:border-0 first:pt-0">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-stone-600">{label}</label>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[status]}`}>
          {
            {
              missing: "Manquant",
              to_review: "À relire",
              validated: "Validé",
              stale: "Périmé",
            }[status]
          }
        </span>
      </div>
      <p className="mt-1 rounded-lg bg-stone-50 p-2 text-xs text-stone-500">{sourceValue}</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={!canEdit}
        rows={2}
        className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
      />
      {canEdit && (
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            onClick={() => onSave(draft, "to_review")}
            className="rounded-lg border border-stone-300 px-3 py-1 text-xs font-semibold text-stone-700"
          >
            Enregistrer
          </button>
          <button
            type="button"
            onClick={() => onSave(draft, "validated")}
            className="rounded-lg bg-stone-900 px-3 py-1 text-xs font-semibold text-white"
          >
            Valider
          </button>
        </div>
      )}
    </div>
  );
}
