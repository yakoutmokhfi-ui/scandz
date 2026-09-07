import type { SectionStatus } from "@/lib/operator-cockpit";
import { tAdmin } from "@/lib/admin-i18n";

/**
 * OB-1 — carte de présentation d'une section du cockpit opérateur.
 *
 * Composant PUREMENT PRÉSENTATIONNEL : aucun accès réseau, aucune
 * action de mutation (`onAction` — quand fourni — n'est utilisé que
 * pour un lien de NAVIGATION vers un écran existant, jamais pour
 * déclencher une écriture). Nouveau composant délibérément petit et
 * générique (pas une duplication d'un composant métier existant) —
 * réutilisé identiquement par les 9 sections du cockpit
 * (app/admin/establishments/cockpit/page.tsx), au lieu de dupliquer la
 * mise en page carte neuf fois.
 */

const STATUS_BADGE: Record<SectionStatus, { labelKey: Parameters<typeof tAdmin>[0]; className: string }> = {
  ready: { labelKey: "badgeReady", className: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  incomplete: { labelKey: "badgeIncomplete", className: "bg-amber-100 text-amber-800 border-amber-300" },
  unavailable: { labelKey: "badgeUnavailable", className: "bg-stone-100 text-stone-600 border-stone-300" },
  not_yet_implemented: {
    labelKey: "badgeNotYetImplemented",
    className: "bg-stone-100 text-stone-500 border-stone-300",
  },
};

export function StatusBadge({ status }: { status: SectionStatus }) {
  const badge = STATUS_BADGE[status];
  return (
    <span
      data-testid="section-status-badge"
      data-status={status}
      className={
        "inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide " +
        badge.className
      }
    >
      {tAdmin(badge.labelKey)}
    </span>
  );
}

export default function CockpitSectionCard({
  title,
  status,
  children,
  actionHref,
  actionLabel,
}: {
  title: string;
  status: SectionStatus;
  /** Corps de la carte : texte explicatif court, JAMAIS un formulaire d'édition. */
  children: React.ReactNode;
  /** Lien vers l'écran EXISTANT pertinent — navigation uniquement, jamais une action de mutation inline. */
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <section
      data-testid="cockpit-section"
      data-section-title={title}
      className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-stone-900">{title}</h3>
        <StatusBadge status={status} />
      </div>
      <div className="text-sm text-stone-600">{children}</div>
      {actionHref && actionLabel && (
        <a
          href={actionHref}
          className="mt-3 inline-block text-sm font-semibold text-emerald-700 underline"
        >
          {actionLabel}
        </a>
      )}
    </section>
  );
}
