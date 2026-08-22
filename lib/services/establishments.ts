import { supabase } from "@/lib/supabase";

/**
 * Service Lot D — création interne d'établissement.
 *
 * Point de vigilance délibéré : ce module ne contient AUCUN appel à
 * l'API Admin Supabase (`auth.admin.*`), n'invente ni ne stocke
 * jamais de mot de passe, et ne nécessite aucune clé `service_role`
 * côté navigateur. Le rattachement du propriétaire (linkPendingOwner)
 * se contente de DÉCLENCHER le mécanisme serveur déjà défini
 * (RPC `link_pending_owner`, lecture seule sur `auth.users`) — il ne
 * crée jamais de compte lui-même.
 *
 * L'autorisation réelle est vérifiée par PostgreSQL dans chaque RPC
 * (via `is_scanym_operator()`), indépendamment de ce que montre
 * l'interface : isScanymOperator() ci-dessous sert uniquement à
 * l'affichage (masquer/rediriger), jamais seule protection.
 */

export type CommerceType =
  | "restaurant"
  | "cafe"
  | "cheese_shop"
  | "bakery"
  | "pastry_shop"
  | "hotel"
  | "bar"
  | "other";

/** LOT 1A — élargi de "fr"|"en"|"ar" (figé) à `string`, pour accepter
 *  toute langue du catalogue Scanym (supported_languages), y compris
 *  NL et les langues futures, sans modification ultérieure de ce
 *  fichier -- même raisonnement que lib/i18n.ts. */
export type Lang = string;

export interface CreateEstablishmentInput {
  name: string;
  slug: string;
  country: string;
  city: string;
  commerceType: CommerceType;
  address: string | null;
  phone: string | null;
  whatsappNumber: string;
  sourceLanguage: Lang;
  enabledLanguages: Lang[];
  currency: string;
  openingHours: string | null;
  ownerEmail: string;
  initialCategoryName: string | null;
}

export interface CreateEstablishmentResult {
  restaurantId: string;
  slug: string;
  status: string;
}

export interface EstablishmentSummary {
  restaurantId: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  ownerStatus: string | null;
}

export interface LinkOwnerResult {
  linked: boolean;
  ownerEmail: string;
}

// --- Classification d'erreurs, code+message strict (jamais || seul) ---

export const SLUG_TAKEN_CODE = "SCANYM_SLUG_TAKEN";
export const INVALID_SLUG_CODE = "SCANYM_INVALID_SLUG";
export const INVALID_COUNTRY_CODE = "SCANYM_INVALID_COUNTRY";
export const INVALID_COMMERCE_TYPE_CODE = "SCANYM_INVALID_COMMERCE_TYPE";
export const INVALID_WHATSAPP_CODE = "SCANYM_INVALID_WHATSAPP";
export const INVALID_LANGUAGE_CODE = "SCANYM_INVALID_LANGUAGE";
export const SOURCE_LANGUAGE_NOT_ENABLED_CODE = "SCANYM_SOURCE_LANGUAGE_NOT_ENABLED";
export const INVALID_CURRENCY_CODE = "SCANYM_INVALID_CURRENCY";
export const INVALID_OWNER_EMAIL_CODE = "SCANYM_INVALID_OWNER_EMAIL";

export class SlugTakenError extends Error {
  constructor() {
    super(SLUG_TAKEN_CODE);
    this.name = "SlugTakenError";
  }
}
export class InvalidSlugError extends Error {
  constructor() {
    super(INVALID_SLUG_CODE);
    this.name = "InvalidSlugError";
  }
}
export class InvalidCountryError extends Error {
  constructor() {
    super(INVALID_COUNTRY_CODE);
    this.name = "InvalidCountryError";
  }
}
export class InvalidCommerceTypeError extends Error {
  constructor() {
    super(INVALID_COMMERCE_TYPE_CODE);
    this.name = "InvalidCommerceTypeError";
  }
}
export class InvalidWhatsappError extends Error {
  constructor() {
    super(INVALID_WHATSAPP_CODE);
    this.name = "InvalidWhatsappError";
  }
}
export class InvalidLanguageError extends Error {
  constructor() {
    super(INVALID_LANGUAGE_CODE);
    this.name = "InvalidLanguageError";
  }
}
export class SourceLanguageNotEnabledError extends Error {
  constructor() {
    super(SOURCE_LANGUAGE_NOT_ENABLED_CODE);
    this.name = "SourceLanguageNotEnabledError";
  }
}
export class InvalidCurrencyError extends Error {
  constructor() {
    super(INVALID_CURRENCY_CODE);
    this.name = "InvalidCurrencyError";
  }
}
export class InvalidOwnerEmailError extends Error {
  constructor() {
    super(INVALID_OWNER_EMAIL_CODE);
    this.name = "InvalidOwnerEmailError";
  }
}
export class NotScanymOperatorError extends Error {
  constructor() {
    super("Not authorized: Scanym operator required");
    this.name = "NotScanymOperatorError";
  }
}

type RpcErrorLike = { code?: string; message?: string } | null | undefined;

/**
 * Classification stricte : code PostgreSQL ET message doivent
 * correspondre exactement (jamais l'un ou l'autre seul) — même règle
 * que lib/services/catalogue-error.ts, pour éviter qu'un message
 * générique portant accidentellement la même chaîne dans un contexte
 * différent soit mal classé.
 */
function classify(error: RpcErrorLike): Error {
  if (!error) return new Error("Unknown error");
  const { code, message } = error;
  if (code === "23505" && message === SLUG_TAKEN_CODE) return new SlugTakenError();
  if (code === "22023" && message === INVALID_SLUG_CODE) return new InvalidSlugError();
  if (code === "22023" && message === INVALID_COUNTRY_CODE) return new InvalidCountryError();
  if (code === "22023" && message === INVALID_COMMERCE_TYPE_CODE) return new InvalidCommerceTypeError();
  if (code === "22023" && message === INVALID_WHATSAPP_CODE) return new InvalidWhatsappError();
  if (code === "22023" && message === INVALID_LANGUAGE_CODE) return new InvalidLanguageError();
  if (code === "22023" && message === SOURCE_LANGUAGE_NOT_ENABLED_CODE) return new SourceLanguageNotEnabledError();
  if (code === "22023" && message === INVALID_CURRENCY_CODE) return new InvalidCurrencyError();
  if (code === "22023" && message === INVALID_OWNER_EMAIL_CODE) return new InvalidOwnerEmailError();
  if (code === "42501" && /Scanym operator required/.test(message ?? "")) return new NotScanymOperatorError();
  return new Error(message ?? "Unknown error");
}

/**
 * Vérifie si l'utilisateur courant est un opérateur Scanym autorisé.
 * USAGE UI UNIQUEMENT (masquer/rediriger) : la vraie autorisation est
 * revérifiée côté serveur par chaque RPC ci-dessous, indépendamment
 * de ce que renvoie cette fonction.
 */
export async function isScanymOperator(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_scanym_operator");
  if (error) return false;
  return data === true;
}

export async function createEstablishment(
  input: CreateEstablishmentInput
): Promise<CreateEstablishmentResult> {
  const { data, error } = await supabase.rpc("create_establishment", {
    p_name: input.name,
    p_slug: input.slug,
    p_country: input.country,
    p_city: input.city,
    p_commerce_type: input.commerceType,
    p_address: input.address,
    p_phone: input.phone,
    p_whatsapp_number: input.whatsappNumber,
    p_source_language: input.sourceLanguage,
    p_enabled_languages: input.enabledLanguages,
    p_currency: input.currency,
    p_opening_hours: input.openingHours,
    p_owner_email: input.ownerEmail,
    p_initial_category_name: input.initialCategoryName,
  });
  if (error) throw classify(error);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    restaurantId: row.restaurant_id,
    slug: row.slug,
    status: row.status,
  };
}

/**
 * Déclenche le rattachement du propriétaire déjà défini côté serveur.
 * Ne crée JAMAIS de compte : cherche seulement un auth.users existant
 * dont l'e-mail correspond à l'invitation en attente. `linked: false`
 * est un résultat NORMAL (pas une exception) quand ce compte n'existe
 * pas encore — l'opérateur doit pouvoir retenter sans traiter cela
 * comme une erreur système.
 */
export async function linkPendingOwner(restaurantId: string): Promise<LinkOwnerResult> {
  const { data, error } = await supabase.rpc("link_pending_owner", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw classify(error);
  const row = Array.isArray(data) ? data[0] : data;
  return { linked: row.linked, ownerEmail: row.owner_email };
}

export async function getEstablishmentSummary(
  restaurantId: string
): Promise<EstablishmentSummary> {
  const { data, error } = await supabase.rpc("get_establishment_summary", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw classify(error);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    restaurantId: row.restaurant_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    ownerEmail: row.owner_email,
    ownerStatus: row.owner_status,
  };
}
