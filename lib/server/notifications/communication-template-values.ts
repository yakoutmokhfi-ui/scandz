import "server-only";
import { translate, type Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";
import {
  COMMUNICATION_TEMPLATE_VARIABLES,
  type CommunicationTemplateValues,
} from "@/lib/communications/template-variables";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — construction des
 * VALEURS de variables à partir du SEUL instantané de la ligne d'outbox.
 *
 * ──────────────────────────────────────────────────────────────────────
 * AUCUNE LECTURE MÉTIER (mandat N1-A §"NO BUSINESS COUPLING", conservé
 * tel quel ici). Cette fonction ne consulte ni base, ni réseau, ni
 * horloge : TOUT vient de `payload_snapshot`, figé à l'enfilement par
 * create_order_received_notification / create_order_communication_
 * notification. Conséquence voulue : le contenu d'un e-mail ne peut pas
 * changer entre l'enfilement et l'envoi, ni emprunter la configuration
 * d'un autre commerçant -- l'instantané appartient à une ligne, et cette
 * ligne appartient à un restaurant.
 * ──────────────────────────────────────────────────────────────────────
 *
 * TOUTES les clés de la liste blanche sont posées, même absentes de
 * l'instantané, et valent alors la chaîne vide. C'est la moitié RENDU de
 * MCC-V1-UNKNOWN-VARIABLE-RULE : une variable connue sans valeur
 * disparaît proprement du texte, jamais « undefined », jamais le jeton.
 */

type Snapshot = Readonly<Record<string, unknown>>;

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export interface CommunicationTemplateValuesInput {
  readonly locale: Lang;
  readonly payload: Snapshot;
  /**
   * Lien de suivi/rétractation déjà construit par l'appelant (il porte
   * la capacité v3.1 et son secret). `null` quand aucune capacité n'a
   * été émise -- cas NORMAL des événements additionnels, qui n'en
   * exigent pas : `{withdrawal_link}` vaut alors la chaîne vide plutôt
   * qu'un lien inventé ou un jeton visible.
   */
  readonly withdrawalLink: string | null;
}

export function buildCommunicationTemplateValues(
  input: CommunicationTemplateValuesInput
): CommunicationTemplateValues {
  const { locale, payload } = input;
  const t = (key: string) => translate(locale, key);
  const flag = (value: unknown) => (value === true ? t("commFlagYes") : t("commFlagNo"));

  const currency = str(payload.currency);
  const totalRaw = payload.total;
  const total =
    typeof totalRaw === "number" || (typeof totalRaw === "string" && totalRaw !== "")
      ? formatPrice(Number(totalRaw), currency || "EUR")
      : "";

  const values: CommunicationTemplateValues = {
    merchant_name: str(payload.merchant_name),
    order_reference: str(payload.order_number),
    order_total: total,
    fulfillment_type: str(payload.service_mode),
    // AUCUN modèle de créneau ni de date de livraison n'existe dans ce
    // dépôt (vérifié : ni colonne, ni table, ni RPC). Ces deux variables
    // sont RÉSERVÉES dans la liste blanche pour que les gabarits écrits
    // aujourd'hui restent valides le jour où un tel modèle existera ;
    // d'ici là elles valent la chaîne vide. Ne RIEN inventer est ici le
    // comportement correct -- une date fabriquée serait une promesse
    // faite au client au nom du commerçant.
    fulfillment_date: str(payload.fulfillment_date),
    fulfillment_slot: str(payload.fulfillment_slot),
    merchant_address: str(payload.merchant_address),
    merchant_email: str(payload.merchant_email),
    merchant_phone: str(payload.merchant_phone),
    // Libellé d'affichage issu de la configuration du commerçant, figé
    // sur la commande. JAMAIS une information lue chez un transporteur :
    // ce lot n'appelle ni Stuart ni Chronofresh.
    carrier_name: str(payload.provider_code) || str(payload.fulfillment_code),
    invoice_requested: flag(payload.invoice_requested),
    withdrawal_link: input.withdrawalLink ?? "",
    withdrawal_eligible: flag(payload.withdrawal_eligible),
  };

  // Garde structurelle : si la liste blanche gagne une variable sans que
  // ce constructeur la pose, elle serait silencieusement vide PARTOUT.
  // On préfère le dire. Aucune valeur n'est inventée -- la clé manquante
  // est simplement posée à la chaîne vide, de façon explicite.
  for (const name of COMMUNICATION_TEMPLATE_VARIABLES) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      (values as Record<string, string>)[name] = "";
    }
  }

  return values;
}
