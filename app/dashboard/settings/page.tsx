"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getRestaurantSettings,
  updateRestaurantSettings,
  updateRestaurantWhatsapp,
} from "@/lib/services/dashboard";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { canEditProducts } from "@/lib/roles";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { translate, type Lang } from "@/lib/i18n";
import { isValidWhatsappNumber, normalizeWhatsappNumber } from "@/lib/whatsapp";

const LANGUAGES = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
];

export default function SettingsPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [lang, setLang] = useState("fr");
  const [address, setAddress] = useState("");
  const [hours, setHours] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEdit = canEditProducts(mapping?.role);
  // Les réglages s'affichent dans la langue enregistrée, pas dans
  // celle en cours d'édition : le libellé ne saute pas pendant le
  // choix, il suit après enregistrement.
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(uiLang, k, p);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const s = await getRestaurantSettings(id);
      setLang(s.staff_receipt_language ?? "fr");
      setUiLang((s.staff_receipt_language ?? "fr") as Lang);
      setAddress(s.address ?? "");
      setHours(s.opening_hours ?? "");
      setWhatsapp(s.whatsapp_number ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("mcLoadFailed"));
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
    void load(restaurantId);
  }, [restaurantId, load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    // Validation effective côté interface, avant tout appel réseau :
    // le SQL revalide de la même façon, mais on évite ici un
    // aller-retour serveur pour une saisie manifestement invalide,
    // et on affiche un message explicite plutôt que l'erreur brute
    // renvoyée par la RPC.
    const cleanWhatsapp = normalizeWhatsappNumber(whatsapp);
    if (!isValidWhatsappNumber(cleanWhatsapp)) {
      setError(t("stWhatsappInvalid"));
      return;
    }

    setSaving(true);
    try {
      // Le numéro WhatsApp est enregistré EN PREMIER et son échec
      // interrompt l'enregistrement : cela évite qu'une adresse ou des
      // horaires soient sauvegardés alors que le numéro WhatsApp,
      // rejeté par la RPC dédiée (autorisation, format...), ne l'est
      // pas — l'utilisateur verrait alors un message d'échec global
      // alors qu'une partie des réglages aurait quand même changé.
      await updateRestaurantWhatsapp(restaurantId, cleanWhatsapp);
      setWhatsapp(cleanWhatsapp);

      await updateRestaurantSettings(
        restaurantId,
        lang,
        address.trim() || null,
        hours.trim() || null
      );

      setSaved(true);
      setUiLang(lang as Lang);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("stSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? t("stTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={setRestaurantId}
      />

      <main
        dir={uiLang === "ar" ? "rtl" : "ltr"}
        className="mx-auto max-w-2xl px-4 py-6"
      >
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          &larr; {t("dsBackToOrders")}
        </a>

        <h2 className="text-xl font-black text-stone-900">{t("stTitle")}</h2>

        {!canEdit && (
          <p className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-600">
            {t("stStaffOnly")}
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {error}
          </p>
        )}

        <form onSubmit={submit}>
        <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stLangTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">
            {t("stLangHint")}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => canEdit && setLang(l.code)}
                disabled={!canEdit}
                aria-pressed={lang === l.code}
                className={
                  "flex-1 rounded-xl px-4 py-3 text-sm font-bold " +
                  (lang === l.code
                    ? "bg-stone-900 text-white"
                    : "border border-stone-300 bg-white text-stone-800") +
                  (canEdit ? "" : " opacity-60")
                }
              >
                {l.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stInfoTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">
            {t("stInfoHint")}
          </p>

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stAddress")}
          </label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={!canEdit}
            maxLength={300}
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stHours")}
          </label>
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            disabled={!canEdit}
            maxLength={120}
            placeholder="07:00 - 23:00"
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />
          <p className="mt-1 text-xs text-stone-500">
            {t("stHoursHint")}
          </p>
        </section>

        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stWhatsappTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stWhatsappHint")}</p>

          <input
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            disabled={!canEdit}
            required
            maxLength={50}
            pattern="^\+?[0-9 \-]{6,50}$"
            title={t("stWhatsappInvalid")}
            placeholder="+213 550 00 00 00"
            dir="ltr"
            className="mt-3 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />
        </section>

        {canEdit && (
          <div className="mt-5 flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-stone-900 px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              {saving ? t("stSaving") : t("mcSave")}
            </button>
            {saved && (
              <span className="text-sm font-semibold text-green-700">
                {t("stSaved")}
              </span>
            )}
          </div>
        )}
        </form>
      </main>
    </>
  );
}
