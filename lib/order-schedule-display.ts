/**
 * ISSUE #170 — affichage du jour et du créneau figés avec une commande
 * (public.order_fulfillment_schedule_snapshot, écrit par `create_order`
 * hébergé, bloc CSDJ-3). Fonctions PURES, partagées par la fiche
 * commande du back-office (components/dashboard/OrderCard.tsx) et le
 * ticket imprimé (lib/receipt.ts).
 *
 * Règles :
 *  - `scheduled_date` est une DATE CIVILE (« YYYY-MM-DD ») dans le fuseau
 *    de l'établissement : elle est formatée à partir de ses composantes
 *    (Date.UTC + timeZone "UTC"), jamais via `new Date("YYYY-MM-DD")`
 *    interprété dans le fuseau du navigateur (décalage d'un jour possible
 *    pour un gérant hors d'Europe) ;
 *  - l'heure est `selected_time` (créneau libre) ou la fenêtre
 *    `window_starts_at`–`window_ends_at` (créneau fixe) ; chaînes
 *    « HH:MM » reprises TELLES QUELLES (contraintes CHECK hébergées),
 *    jamais recalculées ;
 *  - une forme inattendue (date malformée) => `null` : rien n'est
 *    affiché plutôt qu'une valeur inventée.
 */
import type { DashboardOrderScheduleSnapshot } from "@/lib/dashboard-types";
import type { Lang } from "@/lib/i18n";

export interface OrderScheduleDisplay {
  /** Ex. « jeu. 30 oct. 2026 » (fr), « Thu, Oct 30, 2026 » (en). */
  dateLabel: string;
  /** Ex. « 16:00–20:00 », « 12:30 », ou `null` si aucune heure figée. */
  timeLabel: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const LOCALES: Record<string, string> = { fr: "fr-FR", en: "en-GB", ar: "ar", nl: "nl-NL" };

export function formatOrderScheduleDate(scheduledDate: string, lang: Lang): string | null {
  const m = DATE_RE.exec(scheduledDate);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const utc = new Date(Date.UTC(y, mo - 1, d));
  // Une date impossible (31/02) serait normalisée par Date.UTC : refusée.
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return new Intl.DateTimeFormat(LOCALES[lang] ?? "fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(utc);
}

export function formatOrderScheduleTime(
  snapshot: Pick<DashboardOrderScheduleSnapshot, "selected_time" | "window_starts_at" | "window_ends_at">
): string | null {
  const ok = (v: string | null | undefined): v is string => typeof v === "string" && TIME_RE.test(v);
  if (ok(snapshot.selected_time)) return snapshot.selected_time;
  if (ok(snapshot.window_starts_at) && ok(snapshot.window_ends_at)) {
    return `${snapshot.window_starts_at}–${snapshot.window_ends_at}`;
  }
  if (ok(snapshot.window_starts_at)) return snapshot.window_starts_at;
  return null;
}

export function formatOrderSchedule(
  snapshot: DashboardOrderScheduleSnapshot | null | undefined,
  lang: Lang
): OrderScheduleDisplay | null {
  if (!snapshot) return null;
  const dateLabel = formatOrderScheduleDate(snapshot.scheduled_date, lang);
  if (dateLabel === null) return null;
  return { dateLabel, timeLabel: formatOrderScheduleTime(snapshot) };
}

/** Clé i18n du libellé selon le mode de la commande (jamais le nom d'un
 *  transporteur : le snapshot n'en porte pas). */
export function orderScheduleLabelKey(modeCode: string): "dsScheduledPickup" | "dsScheduledDelivery" | "dsScheduledOther" {
  if (modeCode === "pickup") return "dsScheduledPickup";
  if (modeCode === "delivery") return "dsScheduledDelivery";
  return "dsScheduledOther";
}
