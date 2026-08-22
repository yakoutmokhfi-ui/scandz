"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  createEstablishment,
  getEstablishmentSummary,
  isScanymOperator,
  linkPendingOwner,
  type CommerceType,
  type CreateEstablishmentInput,
  type CreateEstablishmentResult,
  type EstablishmentSummary,
  type Lang,
  InvalidSlugError,
  SlugTakenError,
  InvalidCountryError,
  InvalidCommerceTypeError,
  InvalidWhatsappError,
  InvalidLanguageError,
  SourceLanguageNotEnabledError,
  InvalidCurrencyError,
  InvalidOwnerEmailError,
  NotScanymOperatorError,
} from "@/lib/services/establishments";
import { suggestSlug, isValidSlug, COMMERCE_TYPES, SUPPORTED_COUNTRIES, SUPPORTED_CURRENCIES, isSupportedCountry, isSupportedCurrency } from "@/lib/establishment-text";
import { getSupportedLanguages } from "@/lib/services/dashboard";
import { tAdmin } from "@/lib/admin-i18n";

type FormState = {
  name: string;
  slug: string;
  slugManuallyEdited: boolean;
  commerceType: CommerceType;
  country: string;
  city: string;
  address: string;
  phone: string;
  whatsapp: string;
  sourceLanguage: Lang;
  enabledLanguages: Lang[];
  currency: string;
  openingHours: string;
  ownerEmail: string;
  categoryName: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  slug: "",
  slugManuallyEdited: false,
  commerceType: "restaurant",
  country: "",
  city: "",
  address: "",
  phone: "",
  whatsapp: "",
  sourceLanguage: "fr",
  enabledLanguages: ["fr"],
  currency: "",
  openingHours: "",
  ownerEmail: "",
  categoryName: "",
};

const COMMERCE_TYPE_LABEL_KEY: Record<CommerceType, Parameters<typeof tAdmin>[0]> = {
  restaurant: "commerceTypeRestaurant",
  cafe: "commerceTypeCafe",
  cheese_shop: "commerceTypeCheeseShop",
  bakery: "commerceTypeBakery",
  pastry_shop: "commerceTypePastryShop",
  hotel: "commerceTypeHotel",
  bar: "commerceTypeBar",
  other: "commerceTypeOther",
};

export default function CreateEstablishmentPage() {
  const router = useRouter();

  // Autorisation : vérifiée ici UNIQUEMENT pour l'affichage
  // (rediriger un utilisateur non autorisé) -- la vraie protection
  // vit côté serveur dans chaque RPC (is_scanym_operator()), revérifiée
  // indépendamment de ce que montre cette page.
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // LOT 1A — catalogue des langues supportées par Scanym, chargé
  // dynamiquement (remplace l'ancienne constante figée LANGUAGES de
  // lib/establishment-text.ts) : ajouter une langue au catalogue la
  // rend immédiatement disponible ici, sans modification de ce
  // fichier. Le libellé natif du catalogue (ex. "Nederlands",
  // "العربية") est utilisé directement, jamais une clé de traduction
  // par langue à maintenir séparément.
  const [supportedLanguages, setSupportedLanguages] = useState<
    Array<{ code: string; label: string; dir: "ltr" | "rtl" }>
  >([]);

  const [result, setResult] = useState<CreateEstablishmentResult | null>(null);
  const [summary, setSummary] = useState<EstablishmentSummary | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      const ok = await isScanymOperator();
      setAuthorized(ok);
      setAuthChecked(true);
      if (!ok) {
        // Ne laisse jamais la page affichée à un utilisateur légitime
        // mais non-opérateur : redirection vers son propre tableau de
        // bord, pas un simple masquage de bouton.
        router.replace("/dashboard");
      }
    })();
  }, [router]);

  useEffect(() => {
    (async () => {
      try {
        setSupportedLanguages(await getSupportedLanguages());
      } catch {
        // Best-effort : sans catalogue, les sélecteurs de langue
        // restent simplement vides plutôt que de bloquer toute la
        // page de création d'établissement.
      }
    })();
  }, []);

  function updateName(name: string) {
    setForm((f) => ({
      ...f,
      name,
      slug: f.slugManuallyEdited ? f.slug : suggestSlug(name),
    }));
  }

  function updateSlug(slug: string) {
    setForm((f) => ({ ...f, slug, slugManuallyEdited: true }));
  }

  function toggleLanguage(lang: Lang) {
    setForm((f) => {
      const has = f.enabledLanguages.includes(lang);
      const next = has
        ? f.enabledLanguages.filter((l) => l !== lang)
        : [...f.enabledLanguages, lang];
      return { ...f, enabledLanguages: next };
    });
  }

  const valid =
    form.name.trim().length > 0 &&
    isValidSlug(form.slug) &&
    isSupportedCountry(form.country) &&
    form.city.trim().length > 0 &&
    form.whatsapp.trim().length > 0 &&
    isSupportedCurrency(form.currency) &&
    form.ownerEmail.trim().length > 0 &&
    form.enabledLanguages.length > 0 &&
    form.enabledLanguages.includes(form.sourceLanguage) &&
    !submitting;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const input: CreateEstablishmentInput = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        country: form.country.trim().toUpperCase(),
        city: form.city.trim(),
        commerceType: form.commerceType,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        whatsappNumber: form.whatsapp.trim(),
        sourceLanguage: form.sourceLanguage,
        enabledLanguages: form.enabledLanguages,
        currency: form.currency.trim().toUpperCase(),
        openingHours: form.openingHours.trim() || null,
        ownerEmail: form.ownerEmail.trim(),
        initialCategoryName: form.categoryName.trim() || null,
      };
      const created = await createEstablishment(input);
      setResult(created);
      const s = await getEstablishmentSummary(created.restaurantId);
      setSummary(s);
    } catch (e) {
      if (e instanceof InvalidSlugError) setError(tAdmin("errInvalidSlug"));
      else if (e instanceof SlugTakenError) setError(tAdmin("errSlugTaken"));
      else if (e instanceof InvalidCountryError) setError(tAdmin("errInvalidCountry"));
      else if (e instanceof InvalidCommerceTypeError) setError(tAdmin("errInvalidCommerceType"));
      else if (e instanceof InvalidWhatsappError) setError(tAdmin("errInvalidWhatsapp"));
      else if (e instanceof InvalidOwnerEmailError) setError(tAdmin("errInvalidOwnerEmail"));
      else if (e instanceof SourceLanguageNotEnabledError) setError(tAdmin("errSourceLanguageNotEnabled"));
      else if (e instanceof InvalidLanguageError) setError(tAdmin("errEnabledLanguagesEmpty"));
      else if (e instanceof InvalidCurrencyError) setError(tAdmin("errInvalidCurrency"));
      else if (e instanceof NotScanymOperatorError) setError(tAdmin("errNotOperator"));
      else setError(tAdmin("errGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLinkOwner() {
    if (!result) return;
    setLinkBusy(true);
    setLinkMessage(null);
    try {
      const r = await linkPendingOwner(result.restaurantId);
      if (r.linked) {
        setLinkMessage(tAdmin("linkOwnerSuccess"));
      } else {
        setLinkMessage(tAdmin("linkOwnerNotFoundYet", { email: r.ownerEmail }));
      }
      const s = await getEstablishmentSummary(result.restaurantId);
      setSummary(s);
    } catch {
      setLinkMessage(tAdmin("errGeneric"));
    } finally {
      setLinkBusy(false);
    }
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setResult(null);
    setSummary(null);
    setLinkMessage(null);
    setError(null);
  }

  if (!authChecked) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminLoading")}</main>;
  }
  if (!authorized) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminNotOperator")}</main>;
  }

  if (result) {
    const ownerLinked = summary?.ownerStatus === "linked";
    return (
      <main className="mx-auto max-w-lg space-y-4 p-6">
        <h1 className="text-xl font-bold text-stone-900">{tAdmin("successTitle")}</h1>
        <div className="space-y-1 rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm">
          <p>
            <strong>{result.slug}</strong> —{" "}
            <a
              href={`/r/${result.slug}`}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-700 underline"
            >
              {tAdmin("viewPublicMenu")}
            </a>
          </p>
          <p>
            {tAdmin("successStatusLabel")} {summary?.status ?? result.status}
          </p>
          <p>
            <a
              href={`/dashboard/settings?r=${result.restaurantId}`}
              className="text-emerald-700 underline"
            >
              {tAdmin("configureIdentity")}
            </a>
          </p>
        </div>

        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          {ownerLinked ? (
            <p className="text-sm text-emerald-800">
              {tAdmin("successOwnerLinkedBody", { email: summary?.ownerEmail ?? "" })}
            </p>
          ) : (
            <>
              <h2 className="mb-1 text-sm font-bold text-amber-900">
                {tAdmin("successOwnerPendingTitle")}
              </h2>
              <p className="mb-3 text-sm text-amber-900">
                {tAdmin("successOwnerPendingBody", { email: summary?.ownerEmail ?? form.ownerEmail })}
              </p>
              <button
                onClick={handleLinkOwner}
                disabled={linkBusy}
                className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
              >
                {linkBusy ? tAdmin("linkOwnerChecking") : tAdmin("linkOwnerButton")}
              </button>
              {linkMessage && <p className="mt-2 text-sm text-stone-700">{linkMessage}</p>}
            </>
          )}
        </div>

        <button
          onClick={resetForm}
          className="rounded-xl border border-stone-300 px-4 py-2 text-sm font-semibold"
        >
          {tAdmin("createAnother")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-6 p-6">
      <div>
        <h1 className="text-xl font-bold text-stone-900">{tAdmin("adminTitle")}</h1>
        <p className="text-sm text-stone-500">{tAdmin("adminSubtitle")}</p>
      </div>

      {error && (
        <p className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-stone-500">{tAdmin("sectionIdentity")}</h2>
        <input
          value={form.name}
          onChange={(e) => updateName(e.target.value)}
          placeholder={tAdmin("fieldName")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
        <div>
          <input
            value={form.slug}
            onChange={(e) => updateSlug(e.target.value)}
            placeholder={tAdmin("fieldSlug")}
            className={
              "w-full rounded-xl border p-2.5 text-sm " +
              (form.slug === "" || isValidSlug(form.slug)
                ? "border-stone-300"
                : "border-amber-500 bg-amber-50")
            }
          />
          <p className="mt-0.5 text-xs text-stone-400">
            {tAdmin("fieldSlugHint", { slug: form.slug || "…" })}
          </p>
        </div>
        <select
          value={form.commerceType}
          onChange={(e) => setForm((f) => ({ ...f, commerceType: e.target.value as CommerceType }))}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        >
          {COMMERCE_TYPES.map((c) => (
            <option key={c} value={c}>
              {tAdmin(COMMERCE_TYPE_LABEL_KEY[c])}
            </option>
          ))}
        </select>
        <div>
          <label className="text-xs text-stone-500">{tAdmin("fieldStatus")}</label>
          <p className="rounded-xl border border-stone-200 bg-stone-100 p-2.5 text-sm text-stone-500">
            {tAdmin("fieldStatusOnboarding")}
          </p>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-stone-500">{tAdmin("sectionLocation")}</h2>
        <div>
          <label className="text-xs text-stone-500">{tAdmin("fieldCountry")}</label>
          <select
            value={form.country}
            onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
            className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          >
            <option value="" disabled>
              {tAdmin("fieldCountryPlaceholder")}
            </option>
            {SUPPORTED_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </div>
        <input
          value={form.city}
          onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
          placeholder={tAdmin("fieldCity")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
        <input
          value={form.address}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          placeholder={tAdmin("fieldAddress")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-stone-500">{tAdmin("sectionContact")}</h2>
        <input
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          placeholder={tAdmin("fieldPhone")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
        <input
          value={form.whatsapp}
          onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))}
          placeholder={tAdmin("fieldWhatsapp")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-stone-500">{tAdmin("sectionConfig")}</h2>
        <div>
          <label className="text-xs text-stone-500">{tAdmin("fieldSourceLanguage")}</label>
          <select
            value={form.sourceLanguage}
            onChange={(e) => setForm((f) => ({ ...f, sourceLanguage: e.target.value as Lang }))}
            className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          >
            {supportedLanguages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-stone-500">{tAdmin("fieldEnabledLanguages")}</label>
          <div className="flex gap-3">
            {supportedLanguages.map((l) => (
              <label key={l.code} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabledLanguages.includes(l.code)}
                  onChange={() => toggleLanguage(l.code)}
                />
                {l.label}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs text-stone-500">{tAdmin("fieldCurrency")}</label>
          <select
            value={form.currency}
            onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
            className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
          >
            <option value="" disabled>
              {tAdmin("fieldCurrencyPlaceholder")}
            </option>
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </div>
        <input
          value={form.openingHours}
          onChange={(e) => setForm((f) => ({ ...f, openingHours: e.target.value }))}
          placeholder={tAdmin("fieldOpeningHours")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-stone-500">{tAdmin("sectionOwner")}</h2>
        <input
          value={form.ownerEmail}
          onChange={(e) => setForm((f) => ({ ...f, ownerEmail: e.target.value }))}
          placeholder={tAdmin("fieldOwnerEmail")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
        <p className="text-xs text-stone-400">{tAdmin("fieldOwnerEmailHint")}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase text-stone-500">{tAdmin("sectionCategory")}</h2>
        <input
          value={form.categoryName}
          onChange={(e) => setForm((f) => ({ ...f, categoryName: e.target.value }))}
          placeholder={tAdmin("fieldCategoryName")}
          className="w-full rounded-xl border border-stone-300 p-2.5 text-sm"
        />
      </section>

      <button
        onClick={handleSubmit}
        disabled={!valid}
        aria-busy={submitting}
        className="w-full rounded-xl bg-stone-900 py-3 text-sm font-bold text-white disabled:opacity-40"
      >
        {submitting ? tAdmin("submitting") : tAdmin("submit")}
      </button>
    </main>
  );
}
