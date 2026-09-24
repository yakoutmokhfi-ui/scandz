import type { DeliveryStatus } from "@/lib/delivery";
import type { ServiceMode } from "@/lib/restaurants-config";
import type { SaleMode } from "@/lib/sale-modes-types";
import type { Lang } from "@/lib/i18n";
import { tCustomerNoticeText } from "@/lib/menu-i18n";

export interface DeliveryCustomerNotice {
  modeCode: "pickup" | "delivery";
  modeLabel: string;
  message: string;
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Resolves the notice from the already-public tenant configuration.
 * Pickup uses the sale-mode customer text. Delivery prefers the
 * matched fulfillment rule's CUSTOMER NOTICE TEXT, then uses the
 * generic delivery-mode text as a safe fallback. Provider names and
 * routing codes are deliberately absent from this customer model.
 *
 * v1.1 — source clarity: the rule text is read ONLY from the dedicated
 * `DeliveryStatus.customerNotice` field, which is populated exclusively
 * by the fulfillment adapter from `customer_text`. The generic
 * `DeliveryStatus.zone` (whose `label` is a GEOGRAPHIC area label on
 * the legacy path, e.g. "Paris", "Zone 1") is intentionally never read
 * here, so a geographic/zone label can never become a timing notice.
 */
/**
 * TRANSLATIONS MANAGEMENT v2 -- contexte de langue OPTIONNEL.
 * Absent : comportement STRICTEMENT identique à avant ce lot (texte
 * source). Présent : le texte retenu -- et lui seul -- est résolu dans
 * la langue du client par le contrat de repli générique
 * (tCustomerNoticeText -> resolveTranslatedField). La SÉLECTION de la
 * source (règle de fulfillment prioritaire, puis texte générique du
 * mode) reste INCHANGÉE et se fait toujours sur le TEXTE SOURCE : une
 * traduction ne peut donc jamais faire basculer d'une source à
 * l'autre, ni faire apparaître une notice là où il n'y en avait pas.
 */
export interface CustomerNoticeLangContext {
  lang: Lang;
  sourceLanguage: Lang;
}

export function resolveDeliveryCustomerNotice(
  serviceMode: ServiceMode | null,
  saleModes: ReadonlyArray<SaleMode>,
  deliveryStatus: DeliveryStatus,
  usesFulfillmentRules: boolean = false,
  langContext?: CustomerNoticeLangContext
): DeliveryCustomerNotice | null {
  if (serviceMode !== "pickup" && serviceMode !== "delivery") return null;

  const selectedMode = saleModes.find((mode) => mode.code === serviceMode);
  if (!selectedMode) return null;

  // UNE SEULE source est retenue, et elle porte SES PROPRES hash et
  // traductions -- texte, hash et traductions ne peuvent donc jamais
  // être dépareillés (traduire le texte d'une règle avec les
  // traductions du mode générique produirait un texte faux, présenté
  // comme validé).
  const fromRule =
    serviceMode === "delivery" && usesFulfillmentRules && optionalText(deliveryStatus.customerNotice)
      ? {
          customerText: optionalText(deliveryStatus.customerNotice),
          customerTextHash: deliveryStatus.customerNoticeHash ?? null,
          translations: deliveryStatus.customerNoticeTranslations ?? null,
        }
      : null;
  const source = fromRule ?? {
    customerText: optionalText(selectedMode.customerText),
    customerTextHash: selectedMode.customerTextHash ?? null,
    translations: selectedMode.translations ?? null,
  };
  const sourceMessage = source.customerText;

  const translated =
    sourceMessage === null || !langContext
      ? sourceMessage
      : tCustomerNoticeText(source, langContext.lang, langContext.sourceLanguage);

  // Repli ultime : jamais une chaîne vide à la place du texte source.
  const message = optionalText(translated) ?? sourceMessage;

  if (!message) return null;

  return {
    modeCode: serviceMode,
    modeLabel: selectedMode.label,
    message,
  };
}
