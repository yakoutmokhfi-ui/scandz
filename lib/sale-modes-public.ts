import { supabase } from "@/lib/supabase";
import type {
  SaleMode,
  SaleModeFieldRequirement,
  PublicDeliveryInfo,
} from "@/lib/sale-modes-types";

/**
 * LOT 2B.1 — Service public de lecture des modes de vente.
 *
 * Encapsule get_restaurant_public_sale_modes,
 * get_restaurant_public_field_requirements,
 * get_restaurant_public_delivery_info, et la lecture de
 * sale_mode_catalog nécessaire pour enrichir mode_code avec
 * label/category (la RPC des modes ne les retourne pas — vérifié
 * directement dans le schéma LOT 2A.4).
 *
 * Aucun composant UI ne doit appeler supabase.rpc() ou
 * supabase.from() directement pour ces données : tout passe par ce
 * fichier.
 */

interface SaleModeCatalogEntry {
  code: string;
  label: string;
  category: string;
}

/** Cache mémoire simple : sale_mode_catalog est une donnée de
 *  référence globale, rarement modifiée, partagée par tous les
 *  établissements — évite une requête répétée pour chaque appel. */
let catalogCache: Map<string, SaleModeCatalogEntry> | null = null;

async function getCatalogMap(): Promise<Map<string, SaleModeCatalogEntry>> {
  if (catalogCache) return catalogCache;
  const { data, error } = await supabase
    .from("sale_mode_catalog")
    .select("code, label, category");
  if (error) throw new Error(error.message);
  catalogCache = new Map(
    (data ?? []).map((row: SaleModeCatalogEntry) => [row.code, row])
  );
  return catalogCache;
}

interface PublicSaleModeRow {
  mode_code: string;
  customer_text: string | null;
  pricing_mode: SaleMode["pricingMode"];
  fixed_fee: number | null;
  free_threshold: number | null;
  delay_value: number | null;
  delay_unit: "minutes" | "hours" | null;
}

/**
 * Modes de vente actifs pour un établissement, enrichis du
 * label/category du catalogue. Retourne un tableau vide (jamais une
 * exception) si l'établissement n'est pas actif ou n'a aucun mode
 * configuré — reflète fidèlement le contrat de la RPC sous-jacente.
 */
export async function getPublicSaleModes(restaurantId: string): Promise<SaleMode[]> {
  const [{ data, error }, catalog] = await Promise.all([
    supabase.rpc("get_restaurant_public_sale_modes", { p_restaurant_id: restaurantId }),
    getCatalogMap(),
  ]);
  if (error) throw new Error(error.message);

  return ((data ?? []) as PublicSaleModeRow[]).map((row) => {
    const entry = catalog.get(row.mode_code);
    return {
      code: row.mode_code,
      label: entry?.label ?? row.mode_code,
      category: entry?.category ?? "",
      customerText: row.customer_text,
      pricingMode: row.pricing_mode,
      fixedFee: row.fixed_fee,
      freeThreshold: row.free_threshold,
      delayValue: row.delay_value,
      delayUnit: row.delay_unit,
    };
  });
}

interface PublicFieldRequirementRow {
  field: string;
  requirement: SaleModeFieldRequirement["requirement"];
  one_of_group: string | null;
}

/**
 * Champs requis effectifs (surcharge établissement + catalogue déjà
 * fusionnés côté base) pour un mode donné. Retourne un tableau vide
 * si le mode n'est pas activé pour cet établissement, ou si
 * l'établissement n'est pas actif -- jamais une exception pour ce cas
 * attendu, reflète le contrat exact de la RPC.
 */
export async function getPublicFieldRequirements(
  restaurantId: string,
  modeCode: string
): Promise<SaleModeFieldRequirement[]> {
  const { data, error } = await supabase.rpc("get_restaurant_public_field_requirements", {
    p_restaurant_id: restaurantId,
    p_mode_code: modeCode,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as PublicFieldRequirementRow[]).map((row) => ({
    field: row.field,
    requirement: row.requirement,
    oneOfGroup: row.one_of_group,
  }));
}

interface PublicDeliveryInfoRow {
  delivery_zone_prefixes: string[];
  delivery_min_items: number;
  delivery_area_label: string | null;
}

/**
 * Informations de livraison publiques minimales (zones, minimum,
 * libellé). delivery_zone_prefixes n'est jamais null côté base
 * (toujours un tableau, potentiellement vide) -- reflété ici sans
 * coalescence supplémentaire nécessaire. Retourne null (pas un objet
 * à champs vides) si le mode delivery n'est pas activé/configuré, ou
 * si l'établissement n'est pas actif.
 */
export async function getPublicDeliveryInfo(
  restaurantId: string
): Promise<PublicDeliveryInfo | null> {
  const { data, error } = await supabase.rpc("get_restaurant_public_delivery_info", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as PublicDeliveryInfoRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    zonePrefixes: row.delivery_zone_prefixes,
    minItems: row.delivery_min_items,
    areaLabel: row.delivery_area_label,
  };
}

type CustomerDataLike = Record<string, string | undefined>;

/**
 * Groupe les exigences one_of par nom de groupe, sans jamais supposer
 * un nom particulier (ex. "contact"). Les champs required/optional
 * sont retournés séparément, non groupés.
 */
export function groupFieldRequirements(requirements: SaleModeFieldRequirement[]): {
  required: SaleModeFieldRequirement[];
  optional: SaleModeFieldRequirement[];
  oneOfGroups: Map<string, SaleModeFieldRequirement[]>;
} {
  const required: SaleModeFieldRequirement[] = [];
  const optional: SaleModeFieldRequirement[] = [];
  const oneOfGroups = new Map<string, SaleModeFieldRequirement[]>();

  for (const req of requirements) {
    if (req.requirement === "required") {
      required.push(req);
    } else if (req.requirement === "optional") {
      optional.push(req);
    } else if (req.requirement === "one_of" && req.oneOfGroup) {
      const group = oneOfGroups.get(req.oneOfGroup) ?? [];
      group.push(req);
      oneOfGroups.set(req.oneOfGroup, group);
    }
  }

  return { required, optional, oneOfGroups };
}

/**
 * Valide que les données client satisfont toutes les exigences :
 * chaque champ required non vide, et pour chaque groupe one_of, au
 * moins un champ du groupe non vide. Retourne la liste des champs
 * required manquants et des groupes one_of non satisfaits (les deux
 * vides = validation réussie) -- jamais un nom de groupe supposé à
 * l'avance, entièrement dérivé des données reçues.
 */
export function validateCustomerData(
  requirements: SaleModeFieldRequirement[],
  customerData: CustomerDataLike
): { missingRequired: string[]; unsatisfiedGroups: string[] } {
  const { required, oneOfGroups } = groupFieldRequirements(requirements);

  const missingRequired = required
    .filter((r) => !customerData[r.field]?.trim())
    .map((r) => r.field);

  const unsatisfiedGroups: string[] = [];
  for (const [groupName, fields] of oneOfGroups) {
    const satisfied = fields.some((f) => customerData[f.field]?.trim());
    if (!satisfied) unsatisfiedGroups.push(groupName);
  }

  return { missingRequired, unsatisfiedGroups };
}

/** Réservé aux tests : vide le cache mémoire du catalogue entre deux
 *  scénarios isolés. */
export function __resetCatalogCacheForTests(): void {
  catalogCache = null;
}
