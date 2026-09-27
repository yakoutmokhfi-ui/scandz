import "server-only";

import { supabase } from "@/lib/supabase";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

/**
 * SCANYM — ONLINE WITHDRAWAL / RETRACTATION FOUNDATION v1.
 *
 * Accès serveur au runtime de rétractation en ligne (art. L221-21 et
 * D.221-5 du code de la consommation). Deux règles structurent ce
 * module :
 *
 *  1. L'AUTORITÉ CLIENT est la CAPACITÉ DE SUIVI déjà auditée
 *     (order_id + capability_id + secret, ensemble). Aucune fonction
 *     ici n'accepte un `order_id` seul, ni un e-mail, ni un numéro de
 *     commande comme preuve de possession -- la liaison est vérifiée
 *     côté SQL, et revérifiée ici en défense en profondeur.
 *  2. L'ÉLIGIBILITÉ n'est JAMAIS décidée côté client : elle vient de
 *     l'instantané immuable `order_items.withdrawal_eligible_at_order_time`,
 *     lu par la RPC. Une valeur d'éligibilité envoyée par le navigateur
 *     n'est pas lue -- elle n'existe même pas dans le contrat d'entrée.
 */

export class WithdrawalAccessError extends Error {
  constructor() {
    super("SCANYM_WITHDRAWAL_ACCESS_DENIED");
    this.name = "WithdrawalAccessError";
  }
}

export class WithdrawalUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "SCANYM_WITHDRAWAL_UNAVAILABLE");
    this.name = "WithdrawalUnavailableError";
  }
}

/** Erreur MÉTIER renvoyée telle quelle au client (code stable, jamais un détail serveur). */
export class WithdrawalRejectedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "WithdrawalRejectedError";
    this.code = code;
  }
}

export interface WithdrawalCapabilityInput {
  orderId: string;
  capabilityId: string;
  secret: string;
}

/** Une ligne de commande ENCORE rétractable (instantané = true, reste > 0). */
export interface WithdrawalOption {
  orderItemId: string;
  itemName: string;
  optionName: string | null;
  orderedQuantity: number;
  alreadyRequested: number;
  remainingQuantity: number;
}

export interface WithdrawalOptions {
  orderNumber: number;
  options: WithdrawalOption[];
}

export interface WithdrawalSubmission extends WithdrawalCapabilityInput {
  firstName: string;
  lastName: string;
  acknowledgementChannel: "email";
  acknowledgementAddress: string;
  items: Array<{ orderItemId: string; quantity: number }>;
  clientRequestId: string;
}

export interface WithdrawalReceipt {
  withdrawalRequestId: string;
  requestedAt: string;
  /**
   * État RÉEL de l'accusé de réception. `unavailable_no_channel`
   * signifie : la déclaration est enregistrée de façon durable, mais
   * aucun canal d'envoi opérationnel n'existe pour la transmettre --
   * jamais "envoyé" par défaut (voir le rapport de lot, section
   * ACCUSÉ DE RÉCEPTION).
   */
  acknowledgementStatus: "pending" | "unavailable_no_channel" | "sent" | "failed";
  /** Vrai quand un rejeu a retourné la déclaration déjà enregistrée. */
  replayed: boolean;
}

function assertCapabilityShape(input: WithdrawalCapabilityInput): void {
  if (
    !isPlausibleUuid(input.orderId) ||
    !isPlausibleUuid(input.capabilityId) ||
    !isPlausibleCapabilitySecret(input.secret)
  ) {
    throw new WithdrawalAccessError();
  }
}

/**
 * Lignes rétractables de la commande. AUCUNE écriture : ouvrir l'écran
 * de rétractation ne crée jamais de demande (mandat §E de l'addendum
 * UX). Une commande sans aucune ligne éligible retourne une liste vide
 * -- l'appelant ne doit alors afficher AUCUN point d'entrée.
 */
export async function getWithdrawalOptions(
  input: WithdrawalCapabilityInput
): Promise<WithdrawalOptions> {
  assertCapabilityShape(input);

  const { data, error } = await supabase.rpc("get_withdrawal_options_by_capability", {
    p_order_id: input.orderId,
    p_capability_id: input.capabilityId,
    p_secret: input.secret,
  });

  if (error) throw new WithdrawalUnavailableError(error.message);

  const rows = (data ?? []) as Array<{
    bound_order_id: string;
    order_number: number | string;
    order_item_id: string;
    item_name: string;
    option_name: string | null;
    ordered_quantity: number;
    already_requested: number;
    remaining_quantity: number;
  }>;

  if (rows.length === 0) {
    return { orderNumber: 0, options: [] };
  }

  // Défense en profondeur : la RPC lie déjà la capacité à la commande,
  // on revérifie le lien retourné avant de rendre quoi que ce soit.
  for (const row of rows) {
    if (row.bound_order_id !== input.orderId) {
      throw new WithdrawalAccessError();
    }
  }

  return {
    orderNumber: Number(rows[0]!.order_number),
    options: rows.map((row) => ({
      orderItemId: row.order_item_id,
      itemName: row.item_name,
      optionName: row.option_name,
      orderedQuantity: Number(row.ordered_quantity),
      alreadyRequested: Number(row.already_requested),
      remainingQuantity: Number(row.remaining_quantity),
    })),
  };
}

/** Codes métier que la RPC peut renvoyer, repris tels quels vers le client. */
const KNOWN_REJECTION_CODES = new Set([
  "WITHDRAWAL_CAPABILITY_INVALID",
  "WITHDRAWAL_ORDER_NOT_FOUND",
  "WITHDRAWAL_IDENTITY_REQUIRED",
  "WITHDRAWAL_ACK_CHANNEL_UNSUPPORTED",
  "WITHDRAWAL_ACK_ADDRESS_INVALID",
  "WITHDRAWAL_NO_ITEM_SELECTED",
  "WITHDRAWAL_INVALID_ITEM_PAYLOAD",
  "WITHDRAWAL_LINE_NOT_IN_ORDER",
  "WITHDRAWAL_LINE_NOT_ELIGIBLE",
  "WITHDRAWAL_QUANTITY_EXCEEDS_ORDERED",
]);

/**
 * Enregistre la DÉCLARATION de rétractation. Appelée UNIQUEMENT après
 * la confirmation explicite du consommateur (« Confirmer la
 * rétractation ») -- ni l'ouverture de l'écran ni la sélection des
 * produits n'atteignent cette fonction.
 */
export async function submitWithdrawalRequest(
  input: WithdrawalSubmission
): Promise<WithdrawalReceipt> {
  assertCapabilityShape(input);

  if (!isPlausibleUuid(input.clientRequestId)) {
    throw new WithdrawalRejectedError("WITHDRAWAL_INVALID_ITEM_PAYLOAD");
  }
  if (input.items.length === 0) {
    throw new WithdrawalRejectedError("WITHDRAWAL_NO_ITEM_SELECTED");
  }
  for (const item of input.items) {
    if (!isPlausibleUuid(item.orderItemId) || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new WithdrawalRejectedError("WITHDRAWAL_INVALID_ITEM_PAYLOAD");
    }
  }

  const { data, error } = await supabase.rpc("submit_withdrawal_request_by_capability", {
    p_order_id: input.orderId,
    p_capability_id: input.capabilityId,
    p_secret: input.secret,
    p_first_name: input.firstName,
    p_last_name: input.lastName,
    p_ack_channel: input.acknowledgementChannel,
    p_ack_address: input.acknowledgementAddress,
    // L'ÉLIGIBILITÉ N'EST PAS TRANSMISE : seuls l'identifiant de ligne
    // et la quantité voyagent. Le serveur relit l'instantané.
    p_items: input.items.map((item) => ({
      order_item_id: item.orderItemId,
      quantity: item.quantity,
    })),
    p_client_request_id: input.clientRequestId,
  });

  if (error) {
    const code = KNOWN_REJECTION_CODES.has(error.message) ? error.message : null;
    if (code) throw new WithdrawalRejectedError(code);
    throw new WithdrawalUnavailableError(error.message);
  }

  const row = (data ?? [])[0] as
    | {
        withdrawal_request_id: string;
        requested_at: string;
        acknowledgement_status: WithdrawalReceipt["acknowledgementStatus"];
        replayed: boolean;
      }
    | undefined;

  if (!row) throw new WithdrawalUnavailableError();

  return {
    withdrawalRequestId: row.withdrawal_request_id,
    requestedAt: row.requested_at,
    acknowledgementStatus: row.acknowledgement_status,
    replayed: row.replayed === true,
  };
}
