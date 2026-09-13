import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { getOrderTracking } from "@/lib/server/tracking-service";
import {
  TrackingLinkInvalidError,
  TrackingServerUnavailableError,
} from "@/lib/server/tracking-errors";
import {
  TRACKING_SESSION_COOKIE_NAME,
  verifyTrackingSessionToken,
} from "@/lib/server/tracking-session";
import {
  buildTimeline,
  isTerminalStatus,
  statusLabelKey,
  statusLabelKeyForServiceMode,
} from "@/lib/tracking/status";
import { buildCleanTrackingPath } from "@/lib/tracking/link";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { translate, resolveLangFromParam } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";
import TrackingAutoRefresh from "@/components/TrackingAutoRefresh";
import TrackingEntryGate from "@/components/TrackingEntryGate";
import TrackingFragmentScrubber from "@/components/TrackingFragmentScrubber";
import Ltr from "@/components/Bidi";

/**
 * CUSTOMER TRACKING EXPERIENCE v2 — page de suivi client PUBLIQUE,
 * sans compte (mandat §3/§20).
 *
 * ROUTE À UN SEUL SEGMENT DYNAMIQUE (mandat §7) : `/track/[orderId]`,
 * JAMAIS `/track/[orderId]/[token]` (route v1, SUPPRIMÉE par ce lot --
 * ferme le blocage de publication CTE-V1-TOKEN-LOG-01). Le jeton de
 * possession n'apparaît plus JAMAIS dans le chemin de requête HTTP
 * envoyé au serveur -- voir TOKEN-TRANSPORT-SECURITY-REPORT.txt.
 *
 * Server Component DÉLIBÉRÉMENT (mandat §5/§40) : la lecture de
 * `get_order_tracking` se fait entièrement côté serveur, à partir
 * d'une preuve de possession reconstituée depuis le COOKIE DE SESSION
 * HttpOnly (lib/server/tracking-session.ts) -- jamais depuis l'URL, et
 * jamais lisible par du JavaScript navigateur.
 *
 * `force-dynamic` (mandat §21, "no cache of private content") --
 * inchangé depuis v1. Combiné à `next.config.mjs`
 * (Cache-Control/Referrer-Policy/X-Robots-Tag pour `/track/:path*`) et
 * à `metadata.robots` ci-dessous.
 */
export const dynamic = "force-dynamic";

/**
 * CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "FR/EN/AR i18n") —
 * CORRECTIF : le `<title>` d'onglet était un objet `metadata` STATIQUE,
 * donc littéralement figé en français quelle que soit `?lang=`, alors
 * même que le reste de la page traduit déjà correctement son contenu
 * (mandat §25). Converti en `generateMetadata` (mécanisme Next.js
 * standard pour un titre dépendant des `searchParams`) et réutilise
 * `resolveLang`/`translate("trackingPageTitle")` -- SEULE autorité
 * pour cette chaîne, jamais un second texte dupliqué.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string | string[] }>;
}): Promise<Metadata> {
  const lang = resolveLang((await searchParams).lang);
  return {
    title: `Scanym — ${translate(lang, "trackingPageTitle")}`,
    robots: { index: false, follow: false, nocache: true },
  };
}

/**
 * CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "FR/EN/AR i18n") —
 * CORRECTIF : la version précédente ne pouvait renvoyer que "en" ou
 * "fr" (`value === "en" ? "en" : "fr"`), rendant `?lang=ar`
 * STRUCTURELLEMENT inatteignable alors que le dictionnaire `ar` existe
 * déjà avec une parité complète pour toutes les clés de cette page
 * (`trackingStatus_*`, `trackingPageTitle`, etc. -- voir
 * lib/i18n.ts et le test de parité des clés,
 * tests/v64-auth-whatsapp.test.ts). Délègue désormais à
 * `resolveLangFromParam` (lib/i18n.ts), SEULE autorité -- jamais une
 * seconde liste dupliquée qui pourrait diverger. Repli français
 * inchangé pour toute valeur absente/inconnue.
 */
const resolveLang = resolveLangFromParam;

export default async function TrackingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const { orderId } = await params;
  const lang = resolveLang((await searchParams).lang);
  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);

  // Mandat §13 : un order_id manifestement malformé dans le chemin
  // lui-même reçoit la MÊME réponse générique qu'un jeton incorrect --
  // jamais une distinction observable, jamais de tentative de session.
  if (!isPlausibleUuid(orderId)) {
    return (
      <TrackingShell>
        <StatusMessage title={t("trackingInvalidTitle")} message={t("trackingInvalidMessage")} />
      </TrackingShell>
    );
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(TRACKING_SESSION_COOKIE_NAME)?.value ?? null;
  const session = sessionCookie ? verifyTrackingSessionToken(sessionCookie, orderId) : null;

  if (!session) {
    // Aucune session de présentation valide pour CETTE commande
    // (absente, expirée, altérée, ou appartenant à une autre commande
    // -- mandat §11, ces cas restent indistinguables ici). Le composant
    // client décide ensuite, à partir du seul fragment d'URL, s'il
    // s'agit d'une première visite légitime (mandat §8) ou d'un état
    // réellement invalide (mandat §13) -- voir
    // components/TrackingEntryGate.tsx.
    return (
      <TrackingShell>
        <TrackingEntryGate orderId={orderId} lang={lang} />
      </TrackingShell>
    );
  }

  let tracking;
  try {
    tracking = await getOrderTracking({ orderId: session.orderId, publicToken: session.publicToken });
  } catch (err) {
    if (err instanceof TrackingLinkInvalidError) {
      return (
        <TrackingShell>
          <StatusMessage title={t("trackingInvalidTitle")} message={t("trackingInvalidMessage")} />
        </TrackingShell>
      );
    }
    if (err instanceof TrackingServerUnavailableError) {
      return (
        <TrackingShell>
          <StatusMessage
            title={t("trackingUnavailableTitle")}
            message={t("trackingUnavailableMessage")}
          />
        </TrackingShell>
      );
    }
    // Défensif : toute autre exception inattendue reste traitée comme
    // une panne d'infrastructure GÉNÉRIQUE, jamais propagée telle
    // quelle (mandat §13).
    return (
      <TrackingShell>
        <StatusMessage
          title={t("trackingUnavailableTitle")}
          message={t("trackingUnavailableMessage")}
        />
      </TrackingShell>
    );
  }

  const timeline = buildTimeline(tracking.orderStatus, {
    created_at: tracking.createdAt,
    accepted_at: tracking.acceptedAt,
    preparing_at: tracking.preparingAt,
    ready_at: tracking.readyAt,
    completed_at: tracking.completedAt,
    rejected_at: tracking.rejectedAt,
    cancelled_at: tracking.cancelledAt,
  });
  const isException = tracking.orderStatus === "rejected" || tracking.orderStatus === "cancelled";
  const currentLabelKey = isException
    ? statusLabelKey(tracking.orderStatus)
    : statusLabelKeyForServiceMode(tracking.orderStatus, tracking.serviceMode);
  const cleanPath = buildCleanTrackingPath(orderId);
  const terminal = isTerminalStatus(tracking.orderStatus);

  return (
    <TrackingShell>
      {/* Mandat §19 : rafraîchissement automatique léger tant que le
          statut n'est pas terminal. */}
      <TrackingAutoRefresh enabled={!terminal} />

      <h1 className="text-2xl font-bold text-ink-on-bg">{t("trackingPageTitle")}</h1>
      <p className="mt-1 text-sm text-ink-on-bg-muted">
        {t("trackingOrderNumber", { n: tracking.orderNumber })}
      </p>

      {/* CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 (remédiation
          CCTF-V1-TRACKING-FISCAL-SUMMARY-01) : montant total
          AUTORITATIF ET HISTORIQUE (orders.total/orders.currency,
          jamais recalculé -- voir lib/server/tracking-service.ts).
          Mêmes libellés/i18n que l'écran de confirmation
          (components/OrderConfirmation.tsx, "confirmTotalLabel"),
          SEULE autorité de traduction, jamais un second texte dupliqué.
          Absent (null) : aucune ligne rendue, jamais un montant
          inventé -- ne devrait structurellement jamais se produire
          (colonne `not null`), mais reste défensif. */}
      {tracking.orderTotal !== null && tracking.orderCurrency !== null && (
        <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-ink-on-bg-muted">
          <span>{t("confirmTotalLabel")}</span>
          <Ltr>{formatPrice(tracking.orderTotal, tracking.orderCurrency)}</Ltr>
        </p>
      )}

      {/* CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 : indicateur de
          facture -- `invoiceRequested` reflète UNIQUEMENT l'existence
          d'une demande PERSISTÉE (jamais un état "facture en cours"
          par défaut). Même libellé que l'écran de confirmation. */}
      {tracking.invoiceRequested && (
        <p className="mt-1 text-sm text-ink-on-bg-muted">{t("confirmInvoiceRequested")}</p>
      )}

      <p
        className="mt-6 inline-block rounded-full bg-caramel px-4 py-1.5 text-sm font-bold text-caramel-ink"
        aria-live="polite"
      >
        {t(currentLabelKey)}
      </p>

      {/* Mandat §24 : jamais la couleur seule -- chaque étape porte un
          symbole texte ("✓"/"○") ET un libellé. */}
      <ol className="mt-6 space-y-3 text-left">
        {timeline.map((step) => (
          <li
            key={step.status}
            className="flex items-start gap-3 text-sm"
            aria-current={step.isCurrent ? "step" : undefined}
          >
            <span
              aria-hidden="true"
              className={
                step.reached
                  ? "mt-0.5 text-green-600"
                  : "mt-0.5 text-ink-on-bg-muted"
              }
            >
              {step.reached ? "✓" : "○"}
            </span>
            <span
              className={
                step.isCurrent
                  ? "font-bold text-ink-on-bg"
                  : step.reached
                    ? "text-ink-on-bg"
                    : "text-ink-on-bg-muted"
              }
            >
              {t(statusLabelKey(step.status))}
            </span>
          </li>
        ))}
      </ol>

      {isException && (
        <p className="mt-6 rounded-2xl bg-crema p-4 text-sm font-bold text-ink-on-bg" role="status">
          {t(statusLabelKey(tracking.orderStatus))}
        </p>
      )}

      {/* Repli SANS JavaScript (mandat §19, option secours conservée) :
          une navigation classique vers le MÊME chemin PROPRE (jamais de
          jeton) re-déclenche ce Server Component, qui relit alors la
          session déjà posée en cookie.
          Mandat §24 (ferme CTE-V1-ACCESSIBILITY-01) : le symbole "⟳"
          seul, sans nom accessible, est INTERDIT -- ce lien porte
          désormais un libellé visible ET un aria-label équivalent,
          avec une cible tactile mobile d'environ 44×44px. */}
      <Link
        href={cleanPath}
        aria-label={t("trackingRefreshLabel")}
        className="mt-8 inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border border-caramel px-4 py-2 text-sm font-bold text-accent-dark-on-bg"
      >
        <span aria-hidden="true">⟳</span>
        <span>{t("trackingRefreshLabel")}</span>
      </Link>
    </TrackingShell>
  );
}

function TrackingShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center bg-crema px-6 py-10 text-center">
      {/* CUSTOMER TRACKING EXPERIENCE v2.1 -- ferme CTE-V2-HISTORY-01
          (blocage de publication, Work re-audit de v2). Monté ICI,
          INCONDITIONNELLEMENT, pour que CHAQUE branche renvoyée par
          cette page (order_id mal formé, aucune session, échec RPC,
          succès RPC/frise complète) retire tout fragment résiduel de
          l'URL affichée -- y compris, et surtout, la branche "session
          déjà valide" ci-dessus, qui ne rendait JAMAIS
          TrackingEntryGate (donc jamais son propre history.replaceState)
          avant ce correctif. Voir components/TrackingFragmentScrubber.tsx
          pour le détail complet -- ce composant ne fait rien d'autre
          que cela : aucun réseau, aucun second échange, aucun rendu
          visible. */}
      <TrackingFragmentScrubber />
      {children}
    </main>
  );
}

function StatusMessage({ title, message }: { title: string; message: string }) {
  return (
    <div>
      <h1 className="text-xl font-bold text-ink-on-bg">{title}</h1>
      <p className="mt-3 text-sm text-ink-on-bg-muted">{message}</p>
    </div>
  );
}
