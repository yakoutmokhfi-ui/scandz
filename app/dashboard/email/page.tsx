"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { getUser, getSession } from "@/lib/services/auth";
import { getMerchantRestaurants, getRestaurantSettings } from "@/lib/services/dashboard";
import { getEstablishmentSummary } from "@/lib/services/establishments";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { translate, type Lang } from "@/lib/i18n";

type ProviderState = {
  configured: boolean;
  provider: { host: string; port: number; username: string; enabled: boolean } | null;
  lastError: { errorClass: string; at: string | null } | null;
  profile: { email_enabled: boolean; sender_name: string | null; sender_email: string | null; reply_to: string | null; default_locale: string } | null;
};

// Classe d'incident normalisée (jamais un texte du serveur SMTP) -> clé de traduction.
const LAST_ERROR_KEYS: Record<string, string> = {
  PROVIDER_AUTHENTICATION_FAILED: "dsEmailErrAuth",
  PROVIDER_CONFIGURATION_ERROR: "dsEmailErrConfig",
  PROVIDER_TIMEOUT: "dsEmailErrTimeout",
  PROVIDER_TEMPORARY_UNAVAILABLE: "dsEmailErrTemporary",
  PROVIDER_RATE_LIMITED: "dsEmailErrTemporary",
  INVALID_RECIPIENT: "dsEmailErrRecipient",
};

export default function DashboardEmailPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [lastError, setLastError] = useState<ProviderState["lastError"]>(null);
  // Cible enregistrée : changer l'hôte ou l'identifiant exige de ressaisir le mot de passe (A196-01).
  const [savedTarget, setSavedTarget] = useState<{ host: string; username: string } | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("smtp.ionos.fr");
  const [port, setPort] = useState("465");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [locale, setLocale] = useState("fr");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const contextGeneration = useRef(0);
  const currentRestaurantId = useRef("");
  currentRestaurantId.current = restaurantId;
  const t = (key: string) => translate(uiLang, key);

  const token = useCallback(async () => (await getSession())?.access_token ?? "", []);
  const call = useCallback(async (url: string, init?: RequestInit) => {
    const accessToken = await token();
    if (!accessToken) throw new Error(t("dsEmailSessionExpired"));
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const keys: Record<string, string> = {
        EMAIL_PROVIDER_FORBIDDEN: "dsEmailForbidden",
        EMAIL_PROVIDER_LOAD_FAILED: "dsEmailLoadFailed",
        EMAIL_PROFILE_SAVE_FAILED: "dsEmailSaveFailed",
        EMAIL_PROVIDER_SAVE_FAILED: "dsEmailSaveFailed",
        EMAIL_SECRET_ENCRYPTION_UNAVAILABLE: "dsEmailPlatformUnavailable",
        SMTP_HOST_INVALID: "dsEmailInvalidHost",
        SMTP_TLS_PORT_UNSUPPORTED: "dsEmailPortUnsupported",
        SMTP_EMAIL_INVALID: "dsEmailInvalidAddress",
        SMTP_PASSWORD_REQUIRED: "dsEmailPasswordRequired",
        SMTP_PASSWORD_INVALID: "dsEmailPasswordInvalid",
        SMTP_SENDER_NAME_REQUIRED: "dsEmailSenderNameRequired",
        SMTP_SENDER_NAME_INVALID: "dsEmailSenderNameInvalid",
        EMAIL_PROVIDER_CONFLICT: "dsEmailConflict",
        EMAIL_PROVIDER_TEST_RATE_LIMITED: "dsEmailTestRateLimited",
        EMAIL_PROVIDER_NOT_CONFIGURED: "dsEmailTestPrereq",
        SMTP_CONNECTION_FAILED: "dsEmailErrConfig",
      };
      throw new Error(t(keys[String(body.code ?? "")] ?? "dsEmailOperationFailed"));
    }
    return body;
  }, [token, uiLang]);

  const load = useCallback(async (id: string, generation: number) => {
    if (!id) return;
    setError("");
    try {
      const data = await call(`/api/dashboard/email-provider?r=${encodeURIComponent(id)}`) as ProviderState;
      if (contextGeneration.current !== generation || currentRestaurantId.current !== id) return;
      setConfigured(data.configured);
      setLastError(data.lastError ?? null);
      setSavedTarget(data.configured && data.provider ? { host: data.provider.host, username: data.provider.username } : null);
      setEnabled(data.provider?.enabled === true && data.profile?.email_enabled === true);
      setHost(data.provider?.host ?? "smtp.ionos.fr");
      setPort(String(data.provider?.port ?? 465));
      setUsername(data.provider?.username ?? "");
      setSenderName(data.profile?.sender_name ?? "");
      setSenderEmail(data.profile?.sender_email ?? "");
      setReplyTo(data.profile?.reply_to ?? "");
      setLocale(data.profile?.default_locale ?? "fr");
      setPassword("");
    } catch (e) {
      if (contextGeneration.current === generation && currentRestaurantId.current === id) setError(e instanceof Error ? e.message : t("dsEmailLoadFailed"));
    } finally {
      if (contextGeneration.current === generation && currentRestaurantId.current === id) setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) { router.replace("/dashboard/login"); return; }
      try {
        const list = await getMerchantRestaurants();
        setMappings(list);
        const resolution = resolveRestaurantContext({
          requestedId: new URLSearchParams(window.location.search).get("r"),
          mappings: list,
          isOperator: false,
        });
        if (resolution.kind === "selected") setRestaurantId(resolution.restaurantId);
        else setError(t("dsEmailNoRestaurant"));
      } catch { setError(t("dsEmailRestaurantsLoadFailed")); }
    })();
  }, [router]);

  useEffect(() => {
    const generation = ++contextGeneration.current;
    currentRestaurantId.current = restaurantId;
    setLoading(Boolean(restaurantId));
    setConfigured(false); setLastError(null); setSavedTarget(null); setEnabled(false); setPassword("");
    setHost("smtp.ionos.fr"); setPort("465"); setUsername("");
    setSenderName(""); setSenderEmail(""); setReplyTo(""); setLocale("fr");
    setError(""); setMessage(""); setBusy(false);
    if (!restaurantId) { setLoading(false); return; }
    const mapping = mappings.find((item) => item.restaurant_id === restaurantId);
    if (mapping?.role !== "owner" && mapping?.role !== "manager") {
      setError(t("dsEmailOwnerOnly"));
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const summary = await getEstablishmentSummary(restaurantId);
        if (contextGeneration.current !== generation || currentRestaurantId.current !== restaurantId) return;
        setRestaurantName(summary?.name ?? "");
      } catch {
        if (contextGeneration.current !== generation || currentRestaurantId.current !== restaurantId) return;
        setRestaurantName("");
      }
      try {
        const settings = await getRestaurantSettings(restaurantId);
        if (contextGeneration.current === generation && currentRestaurantId.current === restaurantId) {
          setUiLang((settings.staff_receipt_language as Lang) ?? "fr");
        }
      } catch {
        if (contextGeneration.current === generation && currentRestaurantId.current === restaurantId) setUiLang("fr");
      }
      await load(restaurantId, generation);
    })();
  }, [restaurantId, mappings, load]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const targetRestaurantId = restaurantId;
    // Seul un nouveau mot de passe efface l'incident côté serveur ; sinon il reste affiché.
    const enteredNewPassword = password.length > 0;
    try {
      const result = await call("/api/dashboard/email-provider", { method: "POST", body: JSON.stringify({
        action: "save", restaurantId, enabled, host, port, username, password,
        senderName, senderEmail, replyTo, locale,
      }) });
      if (currentRestaurantId.current !== targetRestaurantId) return;
      setConfigured(result.configured === true); setPassword("");
      setSavedTarget(result.configured === true ? { host: host.trim().toLowerCase(), username: username.trim() } : null);
      if (enteredNewPassword) setLastError(null);
      setMessage(enabled ? t("dsEmailSavedEnabled") : t("dsEmailSavedDisabled"));
    } catch (e) { if (currentRestaurantId.current === targetRestaurantId) setError(e instanceof Error ? e.message : t("dsEmailSaveFailed")); }
    finally { if (currentRestaurantId.current === targetRestaurantId) setBusy(false); }
  }

  async function testConnection() {
    setBusy(true); setError(""); setMessage("");
    const targetRestaurantId = restaurantId;
    try {
      const result = await call("/api/dashboard/email-provider", { method: "POST", body: JSON.stringify({ action: "test", restaurantId }) });
      if (currentRestaurantId.current !== targetRestaurantId) return;
      if (result.checkOk) { setMessage(t("dsEmailTestSuccess")); setLastError(null); }
      else {
        const known = LAST_ERROR_KEYS[String(result.reason ?? "")];
        setError(known ? `${t("dsEmailTestFailure")} ${t(known)}` : t("dsEmailTestFailure"));
      }
    } catch (e) { if (currentRestaurantId.current === targetRestaurantId) setError(e instanceof Error ? e.message : t("dsEmailTestPrereq")); }
    finally { if (currentRestaurantId.current === targetRestaurantId) setBusy(false); }
  }

  const mapping = mappings.find((item) => item.restaurant_id === restaurantId);
  const targetChanged = savedTarget !== null && (host.trim().toLowerCase() !== savedTarget.host || username.trim() !== savedTarget.username);
  const suspended = configured && !enabled && lastError?.errorClass === "PROVIDER_AUTHENTICATION_FAILED";
  const chooseRestaurant = (id: string) => {
    setRestaurantId(id);
    router.replace(`/dashboard/email?r=${encodeURIComponent(id)}`);
  };

  return <div dir={uiLang === "ar" ? "rtl" : "ltr"} className="min-h-screen bg-stone-50">
    <DashboardNav restaurantName={restaurantName || t("dsEmailProvider")} restaurantId={restaurantId} mappings={mappings} onSelectRestaurant={chooseRestaurant} staffLanguage={uiLang} />
    <main className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black text-stone-900">{t("dsEmailTitle")}</h2>
        <p className="mt-2 text-sm text-stone-600">{t("dsEmailIntro")}</p>
      </section>
      {loading ? <p className="p-4">{t("dsEmailLoading")}</p> : restaurantId && mapping?.role !== "owner" && mapping?.role !== "manager" ? <p role="alert" className="rounded-xl bg-amber-50 p-4 text-amber-900">{t("dsEmailOwnerOnly")}</p> : restaurantId ? <form onSubmit={save} className="space-y-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="rounded-xl bg-blue-50 p-4 text-sm text-blue-950">{t("dsEmailTrackingNote")}</div>
        {lastError && <div role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-950"><p className="font-bold">{t("dsEmailLastErrorTitle")}</p><p className="mt-1">{t(LAST_ERROR_KEYS[lastError.errorClass] ?? "dsEmailErrOther")}</p>{suspended && <p className="mt-2 font-semibold">{t("dsEmailSuspended")}</p>}</div>}
        <label className="flex items-start gap-3 text-sm font-semibold"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-1" /> {t("dsEmailEnabled")}</label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold">{t("dsEmailHost")}<input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.ionos.fr" className="mt-1 w-full rounded-xl border p-3 font-normal" /></label>
          <label className="text-sm font-semibold">{t("dsEmailPort")}<input required type="number" value={port} onChange={(e) => setPort(e.target.value)} className="mt-1 w-full rounded-xl border p-3 font-normal" /><span className="mt-1 block text-xs font-normal text-stone-500">{t("dsEmailPortHint")}</span></label>
          <label className="text-sm font-semibold">{t("dsEmailUsername")}<input required type="email" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded-xl border p-3 font-normal" /></label>
          <label className="text-sm font-semibold">{t("dsEmailPassword")}<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={configured && !targetChanged ? t("dsEmailPasswordKeep") : t("dsEmailPasswordPlaceholder")} className="mt-1 w-full rounded-xl border p-3 font-normal" required={(!configured && enabled) || targetChanged} />{targetChanged && <span className="mt-1 block text-xs font-normal text-amber-800">{t("dsEmailPasswordChangedTarget")}</span>}</label>
          <label className="text-sm font-semibold">{t("dsEmailSenderName")}<input required value={senderName} onChange={(e) => setSenderName(e.target.value)} className="mt-1 w-full rounded-xl border p-3 font-normal" /></label>
          <label className="text-sm font-semibold">{t("dsEmailSenderAddress")}<input required type="email" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} className="mt-1 w-full rounded-xl border p-3 font-normal" /></label>
          <label className="text-sm font-semibold">{t("dsEmailReplyTo")}<input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} className="mt-1 w-full rounded-xl border p-3 font-normal" /></label>
          <label className="text-sm font-semibold">{t("dsEmailDefaultLanguage")}<select value={locale} onChange={(e) => setLocale(e.target.value)} className="mt-1 w-full rounded-xl border bg-white p-3 font-normal"><option value="fr">{t("dsEmailFrench")}</option><option value="en">{t("dsEmailEnglish")}</option><option value="ar">{t("dsEmailArabic")}</option></select></label>
        </div>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {message && <p role="status" className="rounded-xl bg-green-50 p-3 text-sm text-green-800">{message}</p>}
        <div className="flex flex-wrap gap-3"><button disabled={busy} className="rounded-xl bg-stone-900 px-5 py-3 font-bold text-white disabled:opacity-50">{busy ? t("dsEmailWait") : t("dsEmailSave")}</button><button type="button" disabled={busy || !configured} onClick={testConnection} className="rounded-xl border border-stone-300 px-5 py-3 font-bold disabled:opacity-50">{t("dsEmailTestConnection")}</button></div>
        <p className="text-xs text-stone-500">{t("dsEmailPlatformGate")}</p>
      </form> : error ? <p role="alert" className="rounded-xl bg-amber-50 p-4 text-amber-900">{error}</p> : <p className="rounded-xl bg-white p-5">{t("dsEmailNoRestaurant")}</p>}
    </main>
  </div>;
}
