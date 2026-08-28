"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getMerchantPaymentProviderConfig,
  getRestaurantSettings,
} from "@/lib/services/dashboard";
import type {
  MerchantPaymentProviderConfig,
  MerchantRestaurant,
} from "@/lib/dashboard-types";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { translate, type Lang } from "@/lib/i18n";

/**
 * Dashboard Payment Module v1 — mission "SCANYM — PAYMENT P2B-B —
 * DASHBOARD PAYMENT MODULE v1 — MERCHANT READ-ONLY UI — NO SQL — NO
 * SECRET EXPOSURE — NO PAYMENT RUNTIME".
 *
 * PÉRIMÈTRE STRICT : affiche EXCLUSIVEMENT les métadonnées sûres
 * renvoyées par la RPC publiée public.get_merchant_payment_provider_config
 * (PAYMENT P2B-A) -- provider_code/mode/configuration_status/
 * is_enabled/last_verified_at/updated_at. AUCUNE écriture, AUCUN champ
 * secret, AUCUNE logique de runtime de paiement (Monetico/CIC,
 * checkout, callback) : ce module est un lot v1 volontairement
 * READ-ONLY (décision produit CIO), distinct de la disponibilité
 * réelle du paiement en ligne pour les clients (voir la note
 * `payTechnicalNote` affichée en permanence sur cette page).
 *
 * Lecture ouverte à tout membre (owner/manager/staff), exactement
 * comme l'autorise la RPC elle-même (is_member_of, sans restriction de
 * rôle) -- aucune notion de `canEdit` n'existe ici, il n'y a rien à
 * éditer.
 *
 * CORRECTIONS v2 (mission "PAYMENT P2B-B v2 CORRECTION", contre-audit
 * Work FAIL) -- toutes les propriétés ci-dessus restent inchangées,
 * seuls trois défauts applicatifs sont corrigés :
 *  - PAY-P2B-B-01 : un changement d'établissement réinitialise
 *    IMMÉDIATEMENT et SYNCHRONE les données affichées (rows/erreur)
 *    avant même l'appel RPC, et une garde de séquence ignore toute
 *    réponse RPC périmée (arrivée hors-ordre) -- la configuration de
 *    paiement d'un restaurant A ne peut plus jamais s'afficher sous
 *    l'en-tête d'un restaurant B.
 *  - PAY-P2B-B-02 : la langue d'affichage suit désormais
 *    staff_receipt_language (même source que dashboard/page.tsx,
 *    catalogue/page.tsx, settings/page.tsx), au lieu d'être figée sur
 *    "fr".
 *  - PAY-P2B-B-03 : la barre de navigation du Dashboard (composant
 *    partagé) reçoit `flex-wrap` pour absorber le 6e onglet sans risque
 *    de débordement sur petit écran (voir components/dashboard/
 *    DashboardNav.tsx).
 *
 * CORRECTION v3 (mission "PAYMENT P2B-B v3 CORRECTION", contre-audit
 * Work FAIL -- partie restante de PAY-P2B-B-01) -- P2B-B-02/03 restent
 * fermés et INCHANGÉS. Le Work a prouvé qu'un unique rendu React
 * pouvait encore afficher `restaurantId = B` alors que `rows`
 * appartenait encore à A : la garde de séquence v2 protégeait contre
 * les réponses RPC tardives (asynchrone), mais pas contre cet ÉCART DE
 * RENDU synchrone (setRestaurantId(B) commité AVANT que
 * useEffect(load(B)) n'ait eu la chance de vider `rows`). v3 introduit
 * une invariance STRUCTURELLE de PROPRIÉTÉ des données, pas seulement
 * de timing :
 *  - `loadedRestaurantId` mémorise à QUEL restaurant les `rows`
 *    actuellement en état appartiennent réellement.
 *  - Les cartes (et l'état vide) ne sont rendus QUE si
 *    `loadedRestaurantId === restaurantId` -- jamais sur la seule foi
 *    d'un `payLoading` retombé à faux.
 *  - Le sélecteur de restaurant (handleSelectRestaurant) réinitialise
 *    `rows`/`pageError`/`loadedRestaurantId`/`payLoading` de façon
 *    SYNCHRONE, dans le MÊME gestionnaire d'événement que
 *    `setRestaurantId(id)` -- React les regroupe (batching) en UN SEUL
 *    rendu, donc il ne peut plus exister de rendu intermédiaire où
 *    `restaurantId` a changé mais où `rows`/`loadedRestaurantId`
 *    appartiennent encore à l'ancien restaurant.
 *  - La garde `requestSeqRef` (protection asynchrone, hors-ordre) est
 *    CONSERVÉE intégralement, en complément -- pas en remplacement --
 *    de cette invariance de propriété.
 */

const LOCALE_BY_LANG: Record<string, string> = { fr: "fr-FR", en: "en-US", ar: "ar" };

function formatDateTime(iso: string, lang: string): string {
  try {
    return new Date(iso).toLocaleString(LOCALE_BY_LANG[lang] ?? "fr-FR", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    // Repli sûr : ne jamais planter l'affichage sur une valeur de date
    // inattendue -- montre la valeur brute plutôt qu'une page cassée.
    return iso;
  }
}

/** Libellés d'affichage pour les prestataires CONNUS -- présentation
 *  UNIQUEMENT, aucune logique de runtime de paiement associée (mission
 *  section 11 : "Do NOT implement provider-specific runtime logic").
 *  Un prestataire non listé ici (y compris un prestataire futur non
 *  encore connu de ce lot) obtient un repli lisible généré
 *  automatiquement à partir de son code, jamais un crash ni un code
 *  brut illisible. */
const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  monetico: "Monetico",
};

function providerLabel(code: string): string {
  const known = KNOWN_PROVIDER_LABELS[code.toLowerCase()];
  if (known) return known;
  return code
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function statusLabel(
  t: (k: string) => string,
  status: string
): string {
  switch (status) {
    case "not_configured":
      return t("payStatusNotConfigured");
    case "configured":
      return t("payStatusConfigured");
    case "verified":
      return t("payStatusVerified");
    default:
      // Repli sûr pour toute future valeur de statut inconnue de ce
      // lot (mission section 12) -- jamais de crash, jamais un code
      // brut affiché au marchand.
      return t("payStatusUnknown");
  }
}

function modeLabel(t: (k: string) => string, mode: string): string {
  switch (mode) {
    case "test":
      return t("payModeTest");
    case "live":
      return t("payModeLive");
    default:
      return t("payModeUnknown");
  }
}

export default function PaymentPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const [rows, setRows] = useState<MerchantPaymentProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  // Chargement PROPRE au bloc paiement (distinct du `loading` initial
  // ci-dessus, qui ne couvre que l'auth + la résolution du restaurant) :
  // affiché à chaque changement d'établissement, pendant qu'une
  // nouvelle requête RPC est en vol (mission section 2/4 : "set loading
  // state consistently" / "loading state shown").
  const [payLoading, setPayLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  // v3 -- PROPRIÉTÉ des données affichées : le restaurant auquel `rows`
  // appartient RÉELLEMENT, mis à jour UNIQUEMENT au moment exact où
  // `rows` est commité pour ce restaurant (jamais avant, jamais de
  // façon optimiste). Tant que `loadedRestaurantId !== restaurantId`,
  // AUCUNE carte ni état vide n'est rendu, quel que soit l'état de
  // `payLoading` -- c'est l'invariant structurel exigé par le
  // contre-audit Work (mission v3 section 2/3), une garantie de
  // PROPRIÉTÉ des données, pas seulement de timing.
  const [loadedRestaurantId, setLoadedRestaurantId] = useState<string | null>(null);

  // PAY-P2B-B-01/03 -- garde anti-réponse-tardive : incrémentée à
  // chaque nouvel appel de load() ET à chaque sélection synchrone d'un
  // nouveau restaurant (voir handleSelectRestaurant ci-dessous),
  // permet d'ignorer toute réponse RPC qui arriverait APRÈS qu'un
  // changement de restaurant plus récent a déjà invalidé la requête
  // précédente (out-of-order response). Complète -- ne remplace pas --
  // l'invariant `loadedRestaurantId` ci-dessus : l'un protège contre
  // les réponses tardives (asynchrone), l'autre contre l'écart de
  // rendu synchrone entre un changement de restaurantId et le
  // nettoyage des données de l'ancien restaurant.
  const requestSeqRef = useRef(0);
  // Miroir de `uiLang` lisible depuis load() (fonction stable, voir
  // deps `[]` ci-dessous) sans recréer load() à chaque changement de
  // langue -- évite une boucle de rechargement inutile du bloc paiement
  // au seul changement de langue (aucun changement de restaurant).
  const uiLangRef = useRef<Lang>("fr");
  useEffect(() => {
    uiLangRef.current = uiLang;
  }, [uiLang]);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    const seq = ++requestSeqRef.current;
    // Réinitialise IMMÉDIATEMENT et de façon SYNCHRONE -- avant même
    // l'appel RPC. Redondant avec handleSelectRestaurant pour une
    // bascule pilotée par l'utilisateur (déjà appliqué dans le MÊME
    // rendu que le changement de restaurantId), mais c'est ICI le SEUL
    // point de réinitialisation pour le tout premier chargement
    // (montage initial), qui ne passe jamais par
    // handleSelectRestaurant.
    setRows([]);
    setPageError(null);
    setLoadedRestaurantId(null);
    setPayLoading(true);

    // PAY-P2B-B-02 : langue du commerçant, même source que le reste du
    // Dashboard (dashboard/page.tsx, catalogue/page.tsx, settings/
    // page.tsx) -- restaurant_configs.staff_receipt_language via le
    // service déjà existant getRestaurantSettings(). Appel "best
    // effort" (fire and forget, comme dans dashboard/page.tsx) : un
    // échec ici ne bloque JAMAIS l'affichage des données de paiement,
    // il retombe simplement sur le français (repli sûr, mission
    // section 7).
    getRestaurantSettings(id)
      .then((s) => {
        if (seq === requestSeqRef.current) {
          setUiLang((s.staff_receipt_language as Lang) ?? "fr");
        }
      })
      .catch(() => {
        if (seq === requestSeqRef.current) setUiLang("fr");
      });

    try {
      const next = await getMerchantPaymentProviderConfig(id);
      // Garde anti-réponse-tardive (out-of-order) : si un changement de
      // restaurant plus récent a démarré une nouvelle requête depuis
      // que celle-ci a été émise, cette réponse est PÉRIMÉE -- on
      // l'ignore intégralement plutôt que de risquer d'écraser l'état
      // du restaurant réellement sélectionné (mission v2 section 3/6,
      // toujours en vigueur en v3).
      if (seq !== requestSeqRef.current) return;
      // v3 -- commit ATOMIQUE : `rows` et `loadedRestaurantId` sont
      // posés dans le MÊME passage synchrone (React les regroupe en un
      // seul rendu), jamais l'un sans l'autre. `rows` ne peut donc
      // JAMAIS être rendu sans que `loadedRestaurantId` ne pointe
      // exactement vers le restaurant dont il provient (mission v3
      // section 6 : "Never tag rows with a different/current tenant
      // after the fact").
      setRows(next);
      setLoadedRestaurantId(id);
    } catch {
      // Erreur SÛRE uniquement -- jamais de SQLSTATE, de détail Supabase,
      // de nom de table/fonction, d'UUID ou d'identifiant de tenant
      // (mission section 22).
      if (seq !== requestSeqRef.current) return;
      setPageError(translate(uiLangRef.current, "payLoadFailed"));
      // v3 section 7 : un échec ne doit JAMAIS laisser `rows` associé à
      // un restaurant -- l'échec de B ne doit jamais être confondu avec
      // "A encore chargé".
      setLoadedRestaurantId(null);
    } finally {
      if (seq === requestSeqRef.current) setPayLoading(false);
    }
  }, []);

  // v3 -- INVALIDATION SYNCHRONE dans le MÊME gestionnaire d'événement
  // que le changement de restaurant sélectionné. React 18/19 regroupe
  // (batch) tous les appels setState d'un même gestionnaire d'événement
  // discret en UN SEUL rendu -- il ne peut donc JAMAIS exister de rendu
  // où `restaurantId` a déjà changé (ex. "B") mais où `rows`/
  // `loadedRestaurantId` appartiennent encore à l'ancien restaurant
  // ("A"). C'est nécessaire (mission v3 section 2/4) mais PAS
  // suffisant à lui seul : le garde-fou de rendu
  // `loadedRestaurantId === restaurantId` (voir le JSX plus bas) reste
  // l'invariant qui fait foi, y compris pour le tout premier montage
  // qui ne passe pas par ce gestionnaire.
  const handleSelectRestaurant = useCallback((id: string) => {
    requestSeqRef.current += 1;
    setRows([]);
    setPageError(null);
    setLoadedRestaurantId(null);
    setPayLoading(true);
    setRestaurantId(id);
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
        setMappings(next);
        const wanted = new URLSearchParams(window.location.search).get("r");
        const match = wanted ? next.find((m) => m.restaurant_id === wanted) : undefined;
        if (next.length === 0) {
          // Aucun restaurant : load() ne sera jamais appelée (elle
          // n'est déclenchée que par un restaurantId non vide), donc
          // rien d'autre ne ferait jamais retomber payLoading à false
          // -- sans ce cas explicite, l'indicateur de chargement
          // resterait affiché indéfiniment au lieu du message d'erreur.
          setPageError(t("mcNoRestaurant"));
          setPayLoading(false);
        } else {
          setRestaurantId((match ?? next[0]).restaurant_id);
        }
      } catch {
        setPageError(t("payLoadFailed"));
        setPayLoading(false);
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [router]);

  useEffect(() => {
    void load(restaurantId);
  }, [restaurantId, load]);

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? t("payTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={handleSelectRestaurant}
      />

      <main
        className="mx-auto max-w-2xl px-4 py-6"
        dir={uiLang === "ar" ? "rtl" : "ltr"}
      >
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          &larr; {t("dsBackToOrders")}
        </a>

        <h2 className="text-xl font-black text-stone-900">{t("payTitle")}</h2>
        <p className="mt-1 text-sm text-stone-500">{t("payHint")}</p>

        {/* Distinction produit explicite (mission section 15) : ce lot
            n'affiche qu'un état TECHNIQUE de configuration, jamais une
            promesse de disponibilité du paiement en ligne pour le
            client -- affiché en permanence, indépendamment de l'état
            des configurations ci-dessous. */}
        <p className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-600">
          {t("payTechnicalNote")}
        </p>

        {/* PAY-P2B-B-01 : pendant le (re)chargement d'un établissement
            (y compris un changement d'établissement), ni l'erreur, ni
            l'état vide, ni les cartes de l'établissement précédent ne
            sont rendus -- seul cet indicateur neutre l'est, réutilisant
            la même clé i18n `mcLoading` que le reste du Dashboard. */}
        {payLoading && (
          <p className="mt-3 text-sm text-stone-500">{t("mcLoading")}</p>
        )}

        {!payLoading && pageError && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {pageError}
          </p>
        )}

        {/* v3 -- invariant de PROPRIÉTÉ des données (mission v3 section
            3) : l'état vide et les cartes ci-dessous ne sont JAMAIS
            rendus sur la seule foi de `!payLoading` -- il faut EN PLUS
            que `loadedRestaurantId === restaurantId`, c'est-à-dire que
            les données actuellement en état appartiennent bien au
            restaurant actuellement sélectionné. Impossible d'afficher
            la configuration de A alors que B est sélectionné, même
            l'espace d'un seul rendu. */}
        {!payLoading && !pageError && loadedRestaurantId === restaurantId && rows.length === 0 && (
          <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-500">
            <p>{t("payEmpty")}</p>
            <p className="mt-1 text-stone-400">{t("payEmptyHint")}</p>
          </div>
        )}

        {!payLoading && loadedRestaurantId === restaurantId && rows.map((config) => (
          <section
            key={config.providerCode}
            className="mt-4 rounded-2xl border border-stone-200 bg-white p-4"
          >
            <h3 className="font-bold text-stone-900">{providerLabel(config.providerCode)}</h3>

            <p className="mt-3 text-xs font-semibold text-stone-600">
              {t("payProviderLabel")}
            </p>
            <p className="text-sm text-stone-900">{providerLabel(config.providerCode)}</p>

            <p className="mt-3 text-xs font-semibold text-stone-600">
              {t("payEnvironmentLabel")}
            </p>
            <p className="text-sm text-stone-900">{modeLabel(t, config.mode)}</p>

            <p className="mt-3 text-xs font-semibold text-stone-600">
              {t("payStatusLabel")}
            </p>
            <p className="text-sm text-stone-900">
              {statusLabel(t, config.configurationStatus)}
            </p>

            {/* Pas d'en-tête générique séparé ici : le libellé lui-même
                (payEnabledLabel/payDisabledLabel) est une phrase
                complète et auto-descriptive -- l'état n'est jamais
                porté par la seule couleur (mission section 26,
                accessibilité). */}
            <p
              className={
                "mt-3 text-sm font-semibold " +
                (config.isEnabled ? "text-green-700" : "text-stone-500")
              }
            >
              {config.isEnabled ? t("payEnabledLabel") : t("payDisabledLabel")}
            </p>

            <p className="mt-3 text-xs font-semibold text-stone-600">
              {t("payLastVerifiedLabel")}
            </p>
            <p className="text-sm text-stone-900">
              {config.lastVerifiedAt
                ? formatDateTime(config.lastVerifiedAt, uiLang)
                : t("payNotVerified")}
            </p>

            {config.updatedAt && (
              <p className="mt-3 text-xs text-stone-400">
                {t("payUpdatedLabel")} : {formatDateTime(config.updatedAt, uiLang)}
              </p>
            )}
          </section>
        ))}
      </main>
    </>
  );
}
