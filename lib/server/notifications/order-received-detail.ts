/**
 * ORDER EMAIL DETAIL v1 (issue #211) — lecture DÉFENSIVE du récapitulatif de commande figé dans
 * `notification_outbox.payload_snapshot` par `create_order_received_notification`.
 *
 * Module PUR (aucun réseau, aucune base, aucune horloge) : tout vient du snapshot, écrit en une fois à
 * l'enfilement. Conséquences voulues :
 *   - le contenu de l'e-mail ne dépend d'AUCUNE lecture du catalogue courant ni des tables de commande au
 *     moment de l'envoi : un produit renommé, repricé ou archivé après la commande ne change rien ;
 *   - une ligne de file écrite AVANT ce lot (aucune des clés ci-dessous) est rendue SANS récapitulatif, jamais
 *     avec une valeur devinée ;
 *   - une valeur mal formée n'est JAMAIS corrigée ni complétée : le bloc concerné disparaît (récapitulatif
 *     d'articles : tout ou rien, pour ne pas présenter un panier amputé comme complet).
 *
 * Aucune clé interne n'est lue : la clé de créneau (`slot_key`) n'existe pas dans le snapshot, et ce module ne
 * la reconnaîtrait pas si elle y était (créneau affiché = heure/fenêtre persistée, jamais un identifiant).
 */

/** Une ligne de commande telle que persistée (valeurs HISTORIQUES de `order_items`). */
export interface OrderDetailItem {
  name: string;
  option: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/** Jour (date civile ISO) et heure/fenêtre retenus, avec le fuseau dans lequel la date civile est exprimée. */
export interface OrderDetailSchedule {
  /** « YYYY-MM-DD », date civile dans `timezone` — jamais convertie via un fuseau local. */
  date: string;
  /** « HH:MM » (heure choisie) ou « HH:MM–HH:MM » (fenêtre) ; `null` : jour seul (aucune heure inventée). */
  time: string | null;
  timezone: string | null;
}

export interface OrderReceivedDetail {
  items: OrderDetailItem[] | null;
  subtotal: number | null;
  deliveryFee: number | null;
  schedule: OrderDetailSchedule | null;
  merchantAddress: string | null;
  /**
   * `true` : ce snapshot est au format ORDER EMAIL DETAIL v1 (marqueur `order_email_detail_v1` ou clé `schedule`
   * présente, même `null`). `schedule` est alors la SEULE autorité de jour/créneau : un planning rejeté (date
   * impossible, mode contradictoire, forme inconnue) ne doit réapparaître sous aucune autre forme — ni via les clés
   * « à plat » `fulfillment_date` / `fulfillment_slot`, ni via les variables marchandes. `false` : ligne antérieure
   * au lot, seul le repli antérieur (#172) s'applique.
   */
  scheduleAuthoritative: boolean;
}

/** Borne dure de lignes rendues : un snapshot absurde ne doit pas produire un e-mail démesuré. */
export const ORDER_DETAIL_MAX_ITEMS = 200;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Identifiant de fuseau IANA plausible (« Europe/Paris », « UTC », « America/Argentina/Buenos_Aires »).
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** Date civile valide (le 31 février est refusé, jamais normalisé). */
export function isValidCivilDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const utc = new Date(Date.UTC(y, mo - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === mo - 1 && utc.getUTCDate() === d;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Montant : nombre fini ≥ 0, ou chaîne décimale stricte (PostgREST peut sérialiser un numeric en chaîne). */
function asAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function parseItems(raw: unknown): OrderDetailItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ORDER_DETAIL_MAX_ITEMS) return null;
  const items: OrderDetailItem[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) return null;
    const name = asText(rec.item_name);
    const quantity = typeof rec.quantity === "number" ? rec.quantity : Number.NaN;
    const unitPrice = asAmount(rec.unit_price);
    const lineTotal = asAmount(rec.line_total);
    if (name === null || !Number.isInteger(quantity) || quantity <= 0 || unitPrice === null || lineTotal === null) {
      return null;
    }
    items.push({ name, option: asText(rec.option_name), quantity, unitPrice, lineTotal });
  }
  return items;
}

/** Heure persistée : l'heure choisie l'emporte, sinon la fenêtre, sinon son début. Rien d'autre n'est lu. */
function persistedTime(rec: Record<string, unknown>): string | null {
  const ok = (v: unknown): v is string => typeof v === "string" && TIME_RE.test(v);
  if (ok(rec.selected_time)) return rec.selected_time;
  if (ok(rec.window_starts_at) && ok(rec.window_ends_at)) return `${rec.window_starts_at}–${rec.window_ends_at}`;
  if (ok(rec.window_starts_at)) return rec.window_starts_at;
  return null;
}

/**
 * Jour/créneau retenus. Aucun planning pour un mode sans retrait/livraison planifiable (table, chambre), ni
 * lorsque le mode du planning contredit celui de la commande, ni sans date civile valide.
 */
function parseSchedule(raw: unknown, serviceMode: string): OrderDetailSchedule | null {
  if (serviceMode !== "pickup" && serviceMode !== "delivery") return null;
  const rec = asRecord(raw);
  if (!rec) return null;
  if (typeof rec.mode_code === "string" && rec.mode_code !== serviceMode) return null;
  const date = typeof rec.scheduled_date === "string" ? rec.scheduled_date : "";
  if (!isValidCivilDate(date)) return null;
  const tz = typeof rec.timezone === "string" && TZ_RE.test(rec.timezone) ? rec.timezone : null;
  return { date, time: persistedTime(rec), timezone: tz };
}

export function parseOrderReceivedDetail(
  snapshot: Readonly<Record<string, unknown>>,
  serviceMode: string
): OrderReceivedDetail {
  return {
    items: parseItems(snapshot.items),
    subtotal: asAmount(snapshot.subtotal),
    deliveryFee: asAmount(snapshot.delivery_fee),
    schedule: parseSchedule(snapshot.schedule, serviceMode),
    merchantAddress: asText(snapshot.merchant_address),
    scheduleAuthoritative:
      snapshot.order_email_detail_v1 === true || Object.prototype.hasOwnProperty.call(snapshot, "schedule"),
  };
}

/**
 * Le détail des montants (sous-total, frais) n'est affiché que s'il est COHÉRENT avec les lignes et le total
 * autoritaire : sous-total = somme des lignes ET sous-total + frais = total (au centime). Sinon seul le total
 * (autoritaire) est affiché — jamais deux chiffres qui se contredisent.
 */
export function coherentBreakdown(
  items: ReadonlyArray<OrderDetailItem> | null,
  subtotal: number | null,
  deliveryFee: number | null,
  total: number
): { subtotal: number; deliveryFee: number } | null {
  if (!items || subtotal === null || deliveryFee === null || !Number.isFinite(total)) return null;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const sum = items.reduce((acc, it) => acc + it.lineTotal, 0);
  if (!near(sum, subtotal) || !near(subtotal + deliveryFee, total)) return null;
  return { subtotal, deliveryFee };
}
