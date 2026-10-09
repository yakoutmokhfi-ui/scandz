/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — ÉVÉNEMENTS E-MAIL
 * additionnels, et leur règle d'activation FERMÉE AU REPOS.
 *
 * Logique PURE. Ce module ne déclenche rien et n'envoie rien : il nomme
 * les événements et dit, pour un état de configuration donné, si un
 * envoi est AUTORISÉ.
 *
 * ──────────────────────────────────────────────────────────────────────
 * AUCUN SECOND SYSTÈME DE NOTIFICATION (mandat, littéral : « Do not
 * build a second notification system »).
 *
 * Tous les événements ci-dessous empruntent la file existante
 * `public.notification_outbox` et le worker existant
 * (lib/server/notifications/notification-worker.ts) :
 *   - même table, même unicité logique
 *     `(restaurant_id, order_id, notification_type)` -- donc la MÊME
 *     idempotence, sans nouveau mécanisme ;
 *   - même clé d'idempotence fournisseur
 *     `scanym:notification:<outbox_id>` ;
 *   - même échelle de reprise, même taxonomie fermée d'erreurs, même
 *     résolution d'identité d'expéditeur par jointure sur le
 *     `restaurant_id` de la LIGNE (jamais un identifiant fourni par
 *     l'appelant) -- c'est cette jointure qui porte l'isolation
 *     multi-tenant, et elle n'est pas réécrite ici.
 *
 * Ce lot n'ajoute donc QUE : des valeurs au CHECK de
 * `notification_type`, un aiguillage de gabarit dans le worker, et la
 * table d'activation ci-dessous.
 * ──────────────────────────────────────────────────────────────────────
 *
 * AUCUN APPEL FOURNISSEUR INVENTÉ (mandat, littéral : « Do not invent
 * provider API calls. Do not call Stuart or Chronofresh »). Un
 * événement « remise au transporteur » est ici un FAIT DÉCLARÉ par le
 * commerçant via son back-office, jamais une information reçue d'une
 * API transporteur : aucun module de ce lot ne contacte Stuart ni
 * Chronofresh, et `carrier_name` n'est qu'un libellé d'affichage issu
 * de la configuration du commerçant.
 */

import type { CommunicationTextKey } from "@/lib/communications/text-keys";

/**
 * `order_received` n'est PAS listé ici : son autorité d'activation reste
 * `merchant_notification_profile.email_enabled`, inchangée par ce lot.
 * Le dupliquer créerait deux interrupteurs pour un même e-mail, donc un
 * état contradictoire possible.
 */
export const COMMUNICATION_EVENT_CODES = [
  "carrier_handoff",
  "local_delivery_handoff",
  "withdrawal_request_received",
] as const;

export type CommunicationEventCode =
  (typeof COMMUNICATION_EVENT_CODES)[number];

/**
 * Type de notification porté par la ligne d'outbox pour chaque
 * événement. Volontairement IDENTIQUE au code d'événement : une seule
 * chaîne circule du back-office jusqu'au CHECK SQL, donc aucune table de
 * correspondance à maintenir et aucun décalage possible.
 */
export function notificationTypeForEvent(
  event: CommunicationEventCode
): CommunicationEventCode {
  return event;
}

export function isCommunicationEventCode(
  value: unknown
): value is CommunicationEventCode {
  return (
    typeof value === "string" &&
    (COMMUNICATION_EVENT_CODES as readonly string[]).includes(value)
  );
}

/**
 * ═══ CARTOGRAPHIE ÉVÉNEMENT -> GABARIT DE CORPS (v1.1) ═══
 *
 * Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 (audit indépendant
 * OpenAI/Codex, blocker 2).
 *
 * v1 figeait dans l'instantané de chaque événement le couple GÉNÉRIQUE
 * `email_confirmation_subject`/`email_confirmation_body` ET, en plus,
 * `confirmation_withdrawal_request` -- que le worker ne lisait jamais.
 * La formulation d'accusé de rétractation du commerçant était donc
 * PERSISTÉE PUIS IGNORÉE, et les trois événements se partageaient en
 * silence la formulation de l'e-mail de confirmation de COMMANDE.
 *
 * Désormais chaque événement a l'emplacement dont le NOM décrit ce
 * qu'il dit, et c'est cette table -- miroir exact de
 * `public.communication_event_body_text_key()` -- qui en décide.
 *
 * `email_confirmation_subject` / `email_confirmation_body` ne concernent
 * donc plus que `order_received`, l'e-mail dont ils portent le nom :
 * aucun événement additionnel ne figure ici avec ces valeurs, et un
 * test structurel l'interdit.
 *
 * Le typage lui-même rend la table TOTALE : `Record<CommunicationEventCode, …>`
 * ne compile pas si un événement est ajouté au catalogue sans gabarit.
 */
export const COMMUNICATION_EVENT_BODY_TEXT_KEY: Record<
  CommunicationEventCode,
  CommunicationTextKey
> = {
  carrier_handoff: "confirmation_delivery_carrier",
  local_delivery_handoff: "confirmation_delivery_local",
  withdrawal_request_received: "confirmation_withdrawal_request",
};

/**
 * Emplacement de corps d'UN événement. `null` pour tout code qui n'est
 * pas un événement additionnel -- `order_received` compris : son
 * gabarit n'est pas de ce domaine, et le renvoyer ici rouvrirait
 * exactement l'emprunt silencieux que ce correctif ferme.
 */
export function communicationEventBodyTextKey(
  value: unknown
): CommunicationTextKey | null {
  if (!isCommunicationEventCode(value)) return null;
  return COMMUNICATION_EVENT_BODY_TEXT_KEY[value];
}

export type CommunicationEventConfig = Partial<
  Record<CommunicationEventCode, boolean>
>;

/**
 * ═══ MCC-V1-FAIL-CLOSED-EVENTS ═══
 *
 * L'ABSENCE DE CONFIGURATION NE VAUT JAMAIS PERMISSION. Les trois
 * événements sont désactivés au repos, y compris `carrier_handoff` : un
 * e-mail non sollicité au client d'un commerçant est une décision qui
 * n'appartient qu'à ce commerçant, et une ligne de configuration absente
 * ne peut pas être lue comme un consentement.
 *
 * Seule la valeur BOOLÉENNE `true`, propriété PROPRE de l'objet de
 * configuration, autorise l'émission. `undefined`, `null`, `"true"`,
 * `1`, un objet, ou une clé héritée du prototype ne l'autorisent pas.
 */
export function isCommunicationEventEnabled(
  config: Readonly<Record<string, unknown>> | null | undefined,
  event: CommunicationEventCode
): boolean {
  if (!config || typeof config !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(config, event)) return false;
  return config[event] === true;
}

/**
 * Lit une configuration BRUTE (lignes `[{ event_code, enabled }]` d'une
 * lecture base, ou objet de formulaire) vers une configuration sûre :
 * tout code hors catalogue est ignoré, toute valeur non strictement
 * booléenne `true` devient `false`.
 */
export function sanitizeCommunicationEventConfig(
  rows:
    | ReadonlyArray<{ event_code?: unknown; enabled?: unknown }>
    | null
    | undefined
): CommunicationEventConfig {
  const safe: CommunicationEventConfig = {};
  if (!Array.isArray(rows)) return safe;
  for (const row of rows) {
    const code = row?.event_code;
    if (!isCommunicationEventCode(code)) continue;
    safe[code] = row?.enabled === true;
  }
  return safe;
}
