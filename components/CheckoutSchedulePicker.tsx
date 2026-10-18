"use client";

import type { CheckoutScheduleState } from "@/lib/checkout-schedule/use-checkout-schedule";
import {
  offersForDate,
  scheduleRequirement,
  selectableDates,
  windowTimes,
  type ScheduleSelection,
} from "@/lib/checkout-schedule/model";

/**
 * CSDJ-2 / issue #158 -- date et créneau du retrait (et de la livraison
 * quand le commerçant a configuré un calendrier) au checkout.
 *
 * PRÉSENTATIONNEL : ne lit rien, ne calcule aucune éligibilité. Il
 * affiche ce que le SERVEUR a proposé (`get_checkout_fulfillment_schedule`)
 * et ne laisse choisir QUE dans ces propositions : aucune saisie libre de
 * date ou d'heure. Le serveur revalide à `create_order`.
 *
 * Rien n'est rendu quand il n'y a rien à demander (aucun calendrier,
 * calendrier désactivé, information seule, livraison refusée en amont) :
 * le checkout des commerçants sans calendrier reste strictement inchangé.
 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-GB", ar: "ar", nl: "nl-BE" };

/** Libellé d'affichage d'une date ISO (aucune logique : l'ISO reste la valeur). */
export function formatScheduleDateLabel(isoDate: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(LOCALES[lang] ?? "fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${isoDate}T12:00:00Z`));
  } catch {
    return isoDate;
  }
}

const SELECT_CLASS =
  "w-full rounded-xl border border-stone-300 bg-white p-2.5 text-base text-stone-900 sm:text-sm";

export default function CheckoutSchedulePicker({
  t,
  lang,
  mode,
  state,
  selection,
  onChange,
  onRetry,
  notice,
}: {
  t: Translate;
  lang: string;
  mode: "pickup" | "delivery";
  state: CheckoutScheduleState;
  selection: ScheduleSelection;
  onChange: (next: ScheduleSelection) => void;
  onRetry: () => void;
  /** Message d'une relecture déclenchée par un refus du serveur. */
  notice: string | null;
}) {
  if (state.status === "idle") return null;

  const title = t(mode === "pickup" ? "chkScheduleTitlePickup" : "chkScheduleTitleDelivery");

  const frame = (children: React.ReactNode) => (
    <section
      data-testid="checkout-schedule"
      aria-label={title}
      className="mt-4 rounded-xl border border-stone-200 bg-white/60 p-3"
    >
      <h3 className="text-sm font-semibold text-ink-on-bg">{title}</h3>
      {notice && (
        <p
          role="alert"
          data-testid="checkout-schedule-notice"
          className="mt-2 break-words rounded-lg bg-amber-50 px-3 py-2 text-sm text-stone-900"
        >
          {notice}
        </p>
      )}
      {children}
    </section>
  );

  if (state.status === "loading") {
    return frame(
      <p role="status" data-testid="checkout-schedule-loading" className="mt-2 text-sm text-ink-on-bg-muted">
        {t("chkScheduleLoading")}
      </p>
    );
  }

  if (state.status === "error") {
    return frame(
      <div className="mt-2">
        <p role="alert" data-testid="checkout-schedule-error" className="break-words text-sm text-stone-900">
          {t("chkScheduleError")}
        </p>
        <button
          type="button"
          data-testid="checkout-schedule-retry"
          onClick={onRetry}
          className="mt-2 min-h-[44px] rounded-xl border border-stone-400 bg-white px-4 text-sm font-semibold text-stone-900"
        >
          {t("chkScheduleRetry")}
        </button>
      </div>
    );
  }

  const view = state.view;
  const requirement = scheduleRequirement(view);

  if (requirement.kind === "none") {
    // Rien à demander : rien à afficher -- sauf l'avis d'une relecture.
    return notice ? frame(null) : null;
  }

  if (requirement.kind === "blocked") {
    return frame(
      <p role="alert" data-testid="checkout-schedule-blocked" className="mt-2 break-words text-sm text-stone-900">
        {t("chkScheduleBlocked")}
      </p>
    );
  }

  if (requirement.kind === "unreadable") {
    return frame(
      <div className="mt-2">
        <p role="alert" data-testid="checkout-schedule-unreadable" className="break-words text-sm text-stone-900">
          {t("chkScheduleUnreadable")}
        </p>
        <button
          type="button"
          data-testid="checkout-schedule-retry"
          onClick={onRetry}
          className="mt-2 min-h-[44px] rounded-xl border border-stone-400 bg-white px-4 text-sm font-semibold text-stone-900"
        >
          {t("chkScheduleRetry")}
        </button>
      </div>
    );
  }

  if (requirement.kind === "derived") {
    return frame(
      <p data-testid="checkout-schedule-derived" className="mt-2 break-words text-sm text-ink-on-bg">
        {t("chkScheduleDerived", { date: formatScheduleDateLabel(requirement.date, lang) })}
      </p>
    );
  }

  // requirement.kind === "choose"
  const dates = selectableDates(view, requirement);
  const offers = offersForDate(view, selection.date);
  const granularity = view.timeGranularityMinutes ?? 0;

  return frame(
    <div className="mt-2 space-y-3">
      <div>
        <label htmlFor="checkout-schedule-date" className="mb-1 block text-xs font-semibold text-stone-600">
          {t("chkScheduleDateLabel")}
        </label>
        <select
          id="checkout-schedule-date"
          data-testid="checkout-schedule-date"
          value={selection.date ?? ""}
          onChange={(e) =>
            onChange({ date: e.target.value === "" ? null : e.target.value, slotKey: null, time: null })
          }
          className={SELECT_CLASS}
        >
          <option value="">{t("chkScheduleChoosePlaceholder")}</option>
          {dates.map((d) => (
            <option key={d} value={d}>
              {formatScheduleDateLabel(d, lang)}
            </option>
          ))}
        </select>
      </div>

      {selection.date !== null && requirement.slotMode === "fixed_slots" && (
        <div role="group" aria-label={t("chkScheduleSlotLabel")}>
          <span className="mb-1 block text-xs font-semibold text-stone-600">
            {t("chkScheduleSlotLabel")}
          </span>
          <div className="grid grid-cols-2 gap-2">
            {offers.map((o) => (
              <button
                key={o.slotKey ?? `${o.startsAt}-${o.endsAt}`}
                type="button"
                data-testid={`checkout-schedule-slot-${o.slotKey}`}
                aria-pressed={selection.slotKey === o.slotKey}
                onClick={() => onChange({ date: selection.date, slotKey: o.slotKey, time: null })}
                className={
                  "min-h-[44px] rounded-xl px-3 text-sm font-semibold " +
                  (selection.slotKey === o.slotKey
                    ? "bg-caramel text-caramel-ink"
                    : "border border-stone-300 bg-white text-stone-900")
                }
              >
                <span dir="ltr">
                  {o.startsAt}–{o.endsAt}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selection.date !== null && requirement.slotMode === "time_within_window" && (
        <div>
          <label htmlFor="checkout-schedule-time" className="mb-1 block text-xs font-semibold text-stone-600">
            {t("chkScheduleTimeLabel")}
          </label>
          <select
            id="checkout-schedule-time"
            data-testid="checkout-schedule-time"
            value={selection.time ?? ""}
            onChange={(e) =>
              onChange({ date: selection.date, slotKey: null, time: e.target.value === "" ? null : e.target.value })
            }
            className={SELECT_CLASS}
          >
            <option value="">{t("chkScheduleChoosePlaceholder")}</option>
            {offers.flatMap((o) => windowTimes(o, granularity)).map((time) => (
              <option key={time} value={time}>
                {time}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
