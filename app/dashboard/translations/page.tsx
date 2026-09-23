"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getMerchantCatalogue,
  getMerchantDeliveryMethodNotices,
  getMerchantDeliveryFulfillmentPricing,
  getRestaurantTranslationSettings,
  getRestaurantActiveLanguages,
  writeTranslation,
  type CatalogueCategory,
  type RestaurantTranslationSettingsRow,
  type TranslationEntityType,
} from "@/lib/services/dashboard";
import { getRestaurantProductTags, type ProductTags } from "@/lib/services/catalogue-tags";
import { isScanymOperator } from "@/lib/services/establishments";
import type {
  MerchantRestaurant,
  MerchantDeliveryMethodNotice,
  MerchantDeliveryFulfillmentPricingRule,
} from "@/lib/dashboard-types";
import { canEditProducts } from "@/lib/roles";
import { getTranslationStatus, type TranslationDisplayStatus } from "@/lib/translation-resolver";
import {
  buildTranslationRows,
  entityKey,
  type TranslationRow,
} from "@/lib/translations-management/rows";
import {
  applyTranslationFilters,
  availableTranslationFilterOptions,
  coherentSubcategoryOptions,
  countEntities,
  isDefaultTranslationFilters,
  statusCounts,
  EMPTY_TRANSLATION_FILTERS,
  type TranslationFilters,
  type TranslationStatusFilter,
} from "@/lib/translations-management/filtering";
import {
  buildTranslationExport,
  translationExportFileName,
} from "@/lib/translations-management/export";
import {
  applicableImportRows,
  buildTranslationImportPreview,
  parseTranslationWorkbook,
  IMPORT_VERDICT_LABELS,
  type TranslationImportPreview,
} from "@/lib/translations-management/import";
import type { SortKey } from "@/lib/catalogue-management/filtering";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { useRestaurantContextGuard } from "@/lib/restaurant-context-guard";
import { translate, dirOf, type Lang } from "@/lib/i18n";

type ActiveLang = { code: string; label: string; dir: "ltr" | "rtl"; display_order: number };
type TranslationsMap = Record<string, Record<string, string | undefined> | undefined> | null | undefined;

const STATUS_COLOR: Record<TranslationDisplayStatus, string> = {
  missing: "bg-stone-100 text-stone-500",
  to_review: "bg-amber-100 text-amber-800",
  validated: "bg-green-100 text-green-800",
  stale: "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<TranslationDisplayStatus, string> = {
  missing: "Manquant",
  to_review: "À relire",
  validated: "Validé",
  stale: "Périmé",
};

const ENTITY_LABEL: Record<TranslationEntityType, string> = {
  restaurant: "Établissement",
  category: "Catégorie",
  subcategory: "Sous-catégorie",
  item: "Produit",
  customer_notice: "Message client",
};

/** TRANSLATIONS MANAGEMENT v2 (mandat §15) -- l'écran doit rester
 *  utilisable au-delà de 300 produits : la liste est rendue par
 *  tranches, jamais en un mur unique. Le compteur affiche TOUJOURS le
 *  total filtré réel, jamais le nombre rendu. */
const PAGE_SIZE = 40;

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
  const [productTags, setProductTags] = useState<ProductTags[]>([]);
  const [methodNotices, setMethodNotices] = useState<MerchantDeliveryMethodNotice[]>([]);
  const [fulfillmentNotices, setFulfillmentNotices] = useState<
    MerchantDeliveryFulfillmentPricingRule[]
  >([]);
  const [targetLang, setTargetLang] = useState<string>("");
  const [filters, setFilters] = useState<TranslationFilters>(EMPTY_TRANSLATION_FILTERS);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  /** Import : aperçu EN MÉMOIRE uniquement tant que le commerçant n'a
   *  pas confirmé (mandat §12 -- jamais d'écriture à la sélection du
   *  fichier). */
  const [importPreview, setImportPreview] = useState<TranslationImportPreview | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [allowOverwriteValidated, setAllowOverwriteValidated] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [lastParsedFile, setLastParsedFile] = useState<{
    header: string[];
    rows: string[][];
    rowNumbers: number[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * CONTEXT HARDENING v1.1 (§5) -- PROVENANCE explicite du contenu en
   * mémoire (réglages, langues actives, catalogue). `null` = rien de
   * fiable pour le contexte courant.
   */
  const [contentLoadedRestaurantId, setContentLoadedRestaurantId] = useState<string | null>(null);
  /** CONTEXT HARDENING v1.1 -- contrat anti-réponse-périmée partagé. */
  const guard = useRestaurantContextGuard();
  /** CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble. */
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEditFull = canEditProducts(mapping?.role);
  const canEdit = isOperator || canEditFull;

  const load = useCallback(async (id: string) => {
    if (!id) return;
    // CONTEXT HARDENING v1.1 -- ferme CTXHARD-V1-STALE-RESPONSE-01 sur
    // ce module (même contrat partagé que les autres pages).
    const token = guard.beginRequest(id);
    // §5 -- invalidation IMMÉDIATE de la provenance.
    setContentLoadedRestaurantId(null);
    // Les compléments arrivent APRÈS le commit du noyau (voir plus
    // bas) : sans cette invalidation, les tags/textes client du
    // contexte PRÉCÉDENT resteraient en mémoire et pourraient être
    // peints sous le nouveau contexte pendant l'intervalle.
    setProductTags([]);
    setMethodNotices([]);
    setFulfillmentNotices([]);
    try {
      // NOYAU (réglages, langues, catalogue) : ce sont les seules
      // lectures dont dépend l'affichage des traductions.
      const [s, langs, cat] = await Promise.all([
        getRestaurantTranslationSettings(id),
        getRestaurantActiveLanguages(id),
        getMerchantCatalogue(id),
      ]);
      // Réponse PÉRIMÉE -> ABANDONNÉE intégralement.
      if (!token.isCurrent()) return;
      setSettings(s);
      setActiveLanguages(langs);
      setCatalogue(cat);
      // COMPLÉMENTS (tags pour le filtre, textes client configurables)
      // -- DÉLIBÉRÉMENT NON BLOQUANTS : un établissement sans mode
      // retrait/livraison activé, une base non encore migrée ou une
      // lecture lente ne doivent jamais retarder ni empêcher l'écran de
      // traduction. Chaque réponse repasse par la MÊME garde de
      // contexte : une réponse périmée est abandonnée, jamais peinte.
      void (async () => {
        const [tags, notices, rules] = await Promise.all([
          getRestaurantProductTags(id).catch(() => [] as ProductTags[]),
          getMerchantDeliveryMethodNotices(id).catch(() => [] as MerchantDeliveryMethodNotice[]),
          getMerchantDeliveryFulfillmentPricing(id).catch(
            () => [] as MerchantDeliveryFulfillmentPricingRule[]
          ),
        ]);
        if (!token.isCurrent()) return;
        setProductTags(tags);
        setMethodNotices(notices);
        setFulfillmentNotices(rules);
      })();
      setTargetLang((prev) => {
        if (prev && langs.some((l) => l.code === prev) && prev !== s?.source_language) return prev;
        return langs.find((l) => l.code !== s?.source_language)?.code ?? "";
      });
      // Commit ATOMIQUE : contenu et provenance dans la même passe.
      setContentLoadedRestaurantId(id);
      setError(null);
    } catch (e) {
      if (!token.isCurrent()) return;
      setError(e instanceof Error ? e.message : "Échec du chargement");
    }
  }, [guard]);

  /**
   * CONTEXT HARDENING v1.1 (§5) -- bascule pilotée par l'utilisateur :
   * invalidation et changement de contexte dans le MÊME gestionnaire.
   */
  const handleSelectRestaurant = useCallback(
    (id: string) => {
      guard.enterContext(id);
      setSettings(null);
      setActiveLanguages([]);
      setCatalogue([]);
      setProductTags([]);
      setMethodNotices([]);
      setFulfillmentNotices([]);
      setContentLoadedRestaurantId(null);
      setFilters(EMPTY_TRANSLATION_FILTERS);
      setImportPreview(null);
      setLastParsedFile(null);
      setImportFileName(null);
      setImportResult(null);
      setRestaurantId(id);
    },
    [guard]
  );

  /**
   * CONTEXT HARDENING v1.1 (§5) -- SEULES sources d'affichage
   * locataire : le rendu exige `provenance === contexte courant`.
   */
  const contentInContext = contentLoadedRestaurantId === restaurantId && !!restaurantId;
  const settingsInContext = contentInContext ? settings : null;
  const activeLanguagesInContext = contentInContext ? activeLanguages : [];
  const catalogueInContext = contentInContext ? catalogue : [];
  const methodNoticesInContext = contentInContext ? methodNotices : [];
  const fulfillmentNoticesInContext = contentInContext ? fulfillmentNotices : [];

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
        // CONTEXT HARDENING v1 -- cette page IGNORAIT `?r=` et ouvrait
        // toujours le premier rattachement : venir de "Réglages / Au
        // lait cru" atterrissait sur un AUTRE établissement. Elle
        // utilise désormais le même résolveur partagé que les autres.
        const wanted = new URLSearchParams(window.location.search).get("r");
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: next,
          isOperator: opFlag,
        });
        if (resolution.kind === "unavailable") {
          setUnavailableContextId(resolution.requestedId);
        } else if (resolution.kind === "none") {
          setError("Aucun établissement rattaché à ce compte.");
        } else {
          setUnavailableContextId(null);
          guard.enterContext(resolution.restaurantId);
          setRestaurantId(resolution.restaurantId);
        }
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

  const dir = dirOf(uiLang, activeLanguagesInContext);

  /** Carte produit -> tags, indexée une seule fois par chargement --
   *  MÊME structure que l'écran Catalogue (jamais une seconde forme). */
  const tagsByProductId = useMemo(() => {
    const m = new Map<string, { tagIds: string[]; tagNames: string[] }>();
    if (!contentInContext) return m;
    for (const pt of productTags) m.set(pt.menuItemId, { tagIds: pt.tagIds, tagNames: pt.tagNames });
    return m;
  }, [productTags, contentInContext]);

  /**
   * TOUTES les lignes traduisibles de l'établissement -- y compris les
   * produits rattachés à une SOUS-CATÉGORIE (défaut corrigé par ce
   * lot) : la construction délègue à `flattenCatalogue`, la même
   * fonction que l'écran Catalogue.
   */
  const allRows = useMemo(
    () =>
      buildTranslationRows({
        restaurant:
          settingsInContext && restaurantId
            ? {
                restaurantId,
                restaurantName: mapping?.restaurants?.name ?? "",
                introText: settingsInContext.intro_text,
                introTextHash: settingsInContext.intro_text_hash,
                announcementText: settingsInContext.announcement_text,
                announcementTextHash: settingsInContext.announcement_text_hash,
                translations: settingsInContext.translations,
              }
            : null,
        categories: catalogueInContext,
        tagsByProductId,
        methodNotices: methodNoticesInContext,
        fulfillmentNotices: fulfillmentNoticesInContext,
      }),
    [
      settingsInContext,
      restaurantId,
      mapping,
      catalogueInContext,
      tagsByProductId,
      methodNoticesInContext,
      fulfillmentNoticesInContext,
    ]
  );

  const filteredRows = useMemo(
    () => (targetLang ? applyTranslationFilters(allRows, filters, targetLang) : []),
    [allRows, filters, targetLang]
  );
  const filterOptions = useMemo(() => availableTranslationFilterOptions(allRows), [allRows]);
  const subcategoryOptions = useMemo(
    () => coherentSubcategoryOptions(filterOptions.subcategories, filters.categoryId),
    [filterOptions.subcategories, filters.categoryId]
  );
  const tagOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const [, tags] of tagsByProductId) {
      tags.tagIds.forEach((id, i) => m.set(id, tags.tagNames[i] ?? ""));
    }
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }, [tagsByProductId]);
  const counts = useMemo(
    () => (targetLang ? statusCounts(allRows, targetLang) : null),
    [allRows, targetLang]
  );
  const resultCount = countEntities(filteredRows);

  /** Regroupement d'affichage : une carte par ENTITÉ, dans l'ordre déjà
   *  décidé par `applyTranslationFilters` (hiérarchie conservée). */
  const entityGroups = useMemo(() => {
    const groups: { key: string; rows: TranslationRow[] }[] = [];
    const index = new Map<string, number>();
    for (const row of filteredRows) {
      const key = entityKey(row);
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, groups.length);
        groups.push({ key, rows: [row] });
      } else {
        groups[at].rows.push(row);
      }
    }
    return groups;
  }, [filteredRows]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filters, targetLang, restaurantId]);

  async function handleSave(
    entityType: TranslationEntityType,
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

  /** Télécharge un classeur .xlsx. Best-effort : un environnement sans
   *  API de téléchargement n'interrompt jamais l'écran. */
  function downloadXlsx(scope: "complet" | "filtre") {
    if (!targetLang) return;
    const rows = scope === "complet" ? allRows : filteredRows;
    const bytes = buildTranslationExport(rows, targetLang);
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const blob = new Blob([ab], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = translationExportFileName(scope, targetLang);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      /* environnement sans téléchargement : ignoré volontairement */
    }
  }

  /** PHASE 1 -- lecture + validation + aperçu. AUCUNE écriture ici. */
  async function handleImportFile(file: File) {
    setImportResult(null);
    setImportPreview(null);
    setLastParsedFile(null);
    setImportFileName(file.name);
    try {
      const parsed = parseTranslationWorkbook(await file.arrayBuffer());
      setLastParsedFile(parsed);
      setImportPreview(
        buildTranslationImportPreview(parsed, {
          rows: allRows,
          sourceLanguage: settingsInContext?.source_language ?? "",
          activeLanguages: activeLanguagesInContext.map((l) => l.code),
          targetLanguage: targetLang,
          allowOverwriteValidated,
        })
      );
    } catch (e) {
      setImportPreview({
        totalRows: 0,
        recognizedRows: 0,
        applicableRows: 0,
        rows: [],
        counts: {
          applicable: 0,
          unknown_entity: 0,
          unsupported_entity_type: 0,
          invalid_field: 0,
          wrong_language: 0,
          source_language: 0,
          stale_source: 0,
          duplicate: 0,
          invalid_status: 0,
          empty_translation: 0,
          overwrites_validated: 0,
        },
        fileError: e instanceof Error ? e.message : "Fichier illisible",
      });
    }
  }

  /** Re-valide l'aperçu quand l'autorisation d'écrasement change --
   *  sans relire le fichier, et TOUJOURS sans écrire. */
  useEffect(() => {
    if (!lastParsedFile) return;
    setImportPreview(
      buildTranslationImportPreview(lastParsedFile, {
        rows: allRows,
        sourceLanguage: settingsInContext?.source_language ?? "",
        activeLanguages: activeLanguagesInContext.map((l) => l.code),
        targetLanguage: targetLang,
        allowOverwriteValidated,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowOverwriteValidated, lastParsedFile]);

  /** PHASE 2 -- écriture, UNIQUEMENT après confirmation explicite, et
   *  UNIQUEMENT des lignes classées applicables. Chaque ligne passe par
   *  la RPC existante `write_translation` : toutes ses validations
   *  serveur (locataire, langue active, langue source, rôle) restent
   *  appliquées. Les échecs sont comptés et rapportés, jamais masqués. */
  async function handleConfirmImport() {
    if (!importPreview || importBusy || !canEdit) return;
    const rows = applicableImportRows(importPreview);
    if (rows.length === 0) return;
    setImportBusy(true);
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await writeTranslation(
          restaurantId,
          row.entityType as TranslationEntityType,
          row.entityId,
          row.field,
          row.targetLanguage,
          row.translation,
          row.status
        );
        done += 1;
      } catch {
        failed += 1;
      }
    }
    setImportBusy(false);
    setImportPreview(null);
    setLastParsedFile(null);
    setImportResult(
      failed === 0
        ? `${done} traduction(s) importée(s).`
        : `${done} traduction(s) importée(s), ${failed} refusée(s) par le serveur.`
    );
    if (fileInputRef.current) fileInputRef.current.value = "";
    await load(restaurantId);
  }

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">Chargement…</main>;
  }

  // CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble :
  // état dédié, aucun établissement sélectionné, aucune donnée chargée.
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
        restaurantName={mapping?.restaurants?.name ?? "Langues & traductions"}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={handleSelectRestaurant}
      />
      <main dir={dir} className="mx-auto max-w-3xl px-4 py-6">
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
            {activeLanguagesInContext.find((l) => l.code === settingsInContext?.source_language)?.label ??
              settingsInContext?.source_language}
          </p>

          <label htmlFor="translations-target-lang" className="mt-3 block text-xs font-semibold text-stone-500">
            Langue à traduire
          </label>
          <select
            id="translations-target-lang"
            data-translations-target-lang=""
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          >
            {activeLanguagesInContext
              .filter((l) => l.code !== settingsInContext?.source_language)
              .map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
          </select>
          {activeLanguagesInContext.length <= 1 && (
            <p className="mt-2 text-xs text-stone-400">
              Cet établissement n'a qu'une seule langue active — aucune traduction possible tant
              qu'une deuxième langue n'est pas activée dans Réglages.
            </p>
          )}
        </section>

        {targetLang && settingsInContext && (
          <>
            {/* ------------------------------------------------------
                FILTRES -- mêmes critères que l'écran Catalogue (mandat
                §7), plus le filtre de statut de traduction (§8).
               ------------------------------------------------------ */}
            <section
              data-translations-filters=""
              className="mt-4 rounded-2xl border border-stone-200 bg-white p-4"
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-stone-500">Filtrer</p>
                <p data-translations-result-count="" className="text-xs font-semibold text-stone-600">
                  {resultCount} élément(s)
                </p>
              </div>

              <input
                type="search"
                data-translations-search=""
                aria-label="Rechercher"
                placeholder="Rechercher (nom, catégorie, texte source…)"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                className="mt-2 w-full rounded-xl border border-stone-300 p-2.5 text-sm"
              />

              <div className="mt-2 grid grid-cols-2 gap-2">
                <select
                  data-translations-filter-category=""
                  aria-label="Catégorie"
                  value={filters.categoryId ?? ""}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      categoryId: e.target.value || null,
                      // Cohérence (mandat §15) : une sous-catégorie qui
                      // n'appartient pas à la catégorie choisie ne peut
                      // pas rester sélectionnée.
                      subcategoryId: null,
                    }))
                  }
                  className="rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">Toutes les catégories</option>
                  {filterOptions.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>

                <select
                  data-translations-filter-subcategory=""
                  aria-label="Sous-catégorie"
                  value={filters.subcategoryId ?? ""}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, subcategoryId: e.target.value || null }))
                  }
                  className="rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">Toutes les sous-catégories</option>
                  {subcategoryOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <select
                  data-translations-filter-tag=""
                  aria-label="Tag"
                  value={filters.tagId ?? ""}
                  onChange={(e) => setFilters((f) => ({ ...f, tagId: e.target.value || null }))}
                  className="rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">Tous les tags</option>
                  {tagOptions.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>

                <select
                  data-translations-filter-availability=""
                  aria-label="Disponibilité"
                  value={filters.available === null ? "" : filters.available ? "yes" : "no"}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      available: e.target.value === "" ? null : e.target.value === "yes",
                    }))
                  }
                  className="rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="">Disponibles et indisponibles</option>
                  <option value="yes">Disponibles</option>
                  <option value="no">Indisponibles</option>
                </select>

                <select
                  data-translations-filter-status=""
                  aria-label="Statut de traduction"
                  value={filters.status}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, status: e.target.value as TranslationStatusFilter }))
                  }
                  className="rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="all">Tous les statuts</option>
                  <option value="missing">Manquant{counts ? ` (${counts.missing})` : ""}</option>
                  <option value="to_review">À relire{counts ? ` (${counts.to_review})` : ""}</option>
                  <option value="validated">Validé{counts ? ` (${counts.validated})` : ""}</option>
                  <option value="stale">Périmé{counts ? ` (${counts.stale})` : ""}</option>
                </select>

                <select
                  data-translations-sort=""
                  aria-label="Tri"
                  value={filters.sort}
                  onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortKey }))}
                  className="rounded-xl border border-stone-300 p-2.5 text-sm"
                >
                  <option value="name-asc">Nom A → Z</option>
                  <option value="name-desc">Nom Z → A</option>
                  <option value="price-asc">Prix croissant</option>
                  <option value="price-desc">Prix décroissant</option>
                </select>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-translations-reset-filters=""
                  onClick={() => setFilters(EMPTY_TRANSLATION_FILTERS)}
                  disabled={isDefaultTranslationFilters(filters)}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 disabled:opacity-40"
                >
                  Réinitialiser les filtres
                </button>
                <button
                  type="button"
                  data-translations-export=""
                  onClick={() => downloadXlsx(isDefaultTranslationFilters(filters) ? "complet" : "filtre")}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700"
                >
                  Exporter les traductions (.xlsx)
                </button>
                <label className="cursor-pointer rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700">
                  Importer des traductions
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx"
                    data-translations-import-input=""
                    disabled={!canEdit}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImportFile(file);
                    }}
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-stone-400">
                L'import se fait en deux temps : le fichier est d'abord analysé et affiché, rien
                n'est enregistré avant votre confirmation.
              </p>
            </section>

            {/* APERÇU D'IMPORT -- phase 1, aucune écriture */}
            {importResult && (
              <p data-translations-import-result="" className="mt-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
                {importResult}
              </p>
            )}

            {importPreview && (
              <section
                data-translations-import-preview=""
                className="mt-4 rounded-2xl border border-stone-300 bg-white p-4"
              >
                <h3 className="font-bold text-stone-900">
                  Aperçu de l'import{importFileName ? ` — ${importFileName}` : ""}
                </h3>

                {importPreview.fileError ? (
                  <p data-translations-import-file-error="" className="mt-2 text-sm text-red-700">
                    {importPreview.fileError}
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-sm text-stone-700">
                      {importPreview.totalRows} ligne(s) lue(s), {importPreview.recognizedRows}{" "}
                      reconnue(s),{" "}
                      <strong data-translations-import-applicable="">
                        {importPreview.applicableRows}
                      </strong>{" "}
                      prête(s) à être importée(s).
                    </p>

                    <ul className="mt-2 space-y-1 text-xs text-stone-600">
                      {(Object.keys(importPreview.counts) as Array<keyof typeof importPreview.counts>)
                        .filter((verdict) => verdict !== "applicable" && importPreview.counts[verdict] > 0)
                        .map((verdict) => (
                          <li key={verdict} data-import-verdict={verdict}>
                            {IMPORT_VERDICT_LABELS[verdict]} : {importPreview.counts[verdict]}
                          </li>
                        ))}
                    </ul>

                    {importPreview.counts.overwrites_validated > 0 && (
                      <label className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                        <input
                          type="checkbox"
                          data-translations-allow-overwrite=""
                          checked={allowOverwriteValidated}
                          onChange={(e) => setAllowOverwriteValidated(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span>
                          Remplacer aussi les traductions déjà validées ({importPreview.counts.overwrites_validated}).
                          Par défaut, elles ne sont jamais écrasées.
                        </span>
                      </label>
                    )}

                    <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-stone-200">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-stone-50 text-stone-500">
                          <tr>
                            <th className="p-2">Ligne</th>
                            <th className="p-2">Élément</th>
                            <th className="p-2">Champ</th>
                            <th className="p-2">Verdict</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.rows.map((row) => (
                            <tr key={`${row.excelRow}-${row.entityId}-${row.field}`} className="border-t border-stone-100">
                              <td className="p-2">{row.excelRow}</td>
                              <td className="p-2">{row.label ?? row.entityId}</td>
                              <td className="p-2">{row.field}</td>
                              <td className="p-2">{IMPORT_VERDICT_LABELS[row.verdict]}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        data-translations-import-confirm=""
                        disabled={!canEdit || importBusy || importPreview.applicableRows === 0}
                        onClick={() => void handleConfirmImport()}
                        className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                      >
                        {importBusy
                          ? "Import en cours…"
                          : `Confirmer l'import (${importPreview.applicableRows})`}
                      </button>
                      <button
                        type="button"
                        data-translations-import-cancel=""
                        onClick={() => {
                          setImportPreview(null);
                          setLastParsedFile(null);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700"
                      >
                        Annuler
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}

            {/* ------------------------------------------------------
                LISTE -- une carte par entité, hiérarchie visible.
               ------------------------------------------------------ */}
            {entityGroups.length === 0 && (
              <p data-translations-empty="" className="mt-4 rounded-2xl bg-stone-50 p-4 text-sm text-stone-500">
                Aucun élément ne correspond à ces filtres.
              </p>
            )}

            {entityGroups.slice(0, visibleCount).map((group) => {
              const head = group.rows[0];
              return (
                <section
                  key={group.key}
                  data-translation-entity={head.entityType}
                  data-translation-entity-id={head.entityId}
                  className="mt-4 rounded-2xl border border-stone-200 bg-white p-4"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                    {ENTITY_LABEL[head.entityType]}
                  </p>
                  <h3 className="font-bold text-stone-900">{head.entityLabel}</h3>
                  {(head.categoryName || head.subcategoryName) && (
                    <p data-translation-breadcrumb="" className="text-xs text-stone-500">
                      {[head.categoryName, head.subcategoryName, head.entityType === "item" ? head.entityLabel : null]
                        .filter(Boolean)
                        .join(" > ")}
                    </p>
                  )}

                  {group.rows.map((row) => (
                    <TranslationField
                      key={`${row.entityType}-${row.entityId}-${row.field}`}
                      label={row.fieldLabel}
                      sourceValue={row.sourceText}
                      sourceHash={row.sourceHash}
                      translations={row.translations as TranslationsMap}
                      field={row.field}
                      lang={targetLang}
                      canEdit={canEdit}
                      onSave={(v, status) =>
                        handleSave(row.entityType, row.entityId, row.field, v, status)
                      }
                    />
                  ))}
                </section>
              );
            })}

            {entityGroups.length > visibleCount && (
              <button
                type="button"
                data-translations-load-more=""
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                className="mt-4 w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
              >
                Afficher plus ({entityGroups.length - visibleCount} restant(s))
              </button>
            )}
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
        <span
          data-translation-status={status}
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[status]}`}
        >
          {STATUS_LABEL[status]}
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
