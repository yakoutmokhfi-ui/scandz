/**
 * Scanym — CUSTOMER CONTACT + LIVE TRACKING v1.
 *
 * Logique PURE (aucun réseau, aucun React) :
 *
 *  1. WhatsApp OPTIONNEL PAR COMMERÇANT — SEULE autorité côté client
 *     pour décider si WhatsApp fait partie du parcours. WhatsApp est
 *     utilisé UNIQUEMENT si le commerçant ne l'a pas désactivé
 *     (`whatsapp_enabled !== false`) ET si le numéro stocké est
 *     réellement utilisable. Dans tous les autres cas : aucun bouton,
 *     aucun lien wa.me, aucun texte WhatsApp, aucun repli WhatsApp —
 *     la commande est enregistrée et le suivi reste le parcours
 *     principal.
 *     `whatsapp_enabled` absent (lot SQL pas encore appliqué) =
 *     comportement historique (activé), jamais un changement silencieux.
 *
 *  2. CONTACT PUBLIC — règles de forme MIROIR de la RPC
 *     update_restaurant_public_contact (le serveur reste l'autorité ;
 *     ces règles évitent seulement un aller-retour pour une saisie
 *     manifestement invalide).
 */
import type { RestaurantConfig } from "@/lib/types";
import { isValidWhatsappNumber } from "@/lib/whatsapp";

type WhatsappFields = Pick<RestaurantConfig, "whatsapp_number" | "whatsapp_enabled">;

export function isWhatsappEnabled(config: WhatsappFields | null | undefined): boolean {
  if (!config) return false;
  if (config.whatsapp_enabled === false) return false;
  return typeof config.whatsapp_number === "string" && isValidWhatsappNumber(config.whatsapp_number);
}

/**
 * Retire le numéro WhatsApp de la configuration transmise au navigateur
 * quand WhatsApp n'est PAS utilisé : aucune donnée WhatsApp n'a de
 * raison de voyager jusqu'au client dans ce cas. Ne modifie jamais
 * l'objet reçu.
 */
export function withoutUnusedWhatsapp<T extends WhatsappFields>(config: T): T {
  if (isWhatsappEnabled(config)) return config;
  return { ...config, whatsapp_number: "", whatsapp_enabled: false };
}

export interface PublicContact {
  phone: string | null;
  email: string | null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Contact public affichable ; `null` quand rien n'est renseigné. */
export function publicContactOf(
  source: { public_phone?: string | null; public_email?: string | null } | null | undefined
): PublicContact | null {
  const phone = cleanText(source?.public_phone);
  const email = cleanText(source?.public_email);
  if (!phone && !email) return null;
  return { phone, email };
}

/** `tel:` sans espaces ni ponctuation (le `+` initial est conservé). */
export function telHref(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return `tel:${plus}${trimmed.replace(/[^0-9]/g, "")}`;
}

// MIROIR EXACT des contraintes SQL (restaurant_configs_public_phone_format
// / restaurant_configs_public_email_format).
const PUBLIC_PHONE_PATTERN = /^\+?[0-9][0-9 .()-]{5,28}[0-9]$/;
const PUBLIC_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Vide = autorisé (effacement). */
export function isValidPublicPhone(raw: string): boolean {
  const v = raw.trim();
  return v === "" || PUBLIC_PHONE_PATTERN.test(v);
}

/** Vide = autorisé (effacement). */
export function isValidPublicEmail(raw: string): boolean {
  const v = raw.trim();
  return v === "" || (v.length <= 254 && PUBLIC_EMAIL_PATTERN.test(v));
}
