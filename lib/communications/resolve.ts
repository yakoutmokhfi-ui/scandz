/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — SEULE autorité de
 * résolution d'un texte customer-facing configurable.
 *
 * Logique PURE. `translate` est INJECTÉ (jamais importé ici) pour que ce
 * module reste testable sans charger lib/i18n.ts et pour qu'il se
 * comporte identiquement côté serveur (e-mail) et côté client (écran de
 * confirmation, checkout) -- même discipline que
 * lib/tracking/status-text.ts::resolveStatusText.
 *
 * ORDRE STRICT, trois issues, aucun quatrième repli inventé :
 *
 *   1. surcharge marchande non vide         -> source `merchant_override`
 *   2. texte de base fourni EXPLICITEMENT   -> source `base`
 *      (cas MCC-V1-DEFAULT-ABSENT-01 b : base conditionnelle, c'est
 *       l'appelant qui connaît la condition)
 *   3. clé i18n de base du catalogue        -> source `base`
 *   4. sinon                                -> source `absent`, texte null
 *
 * `absent` n'est PAS une erreur : c'est l'état par défaut légitime des
 * emplacements ADDITIFS (`checkout_info`, `sanitary_warning`...) pour
 * lesquels la plateforme n'affiche rien aujourd'hui. L'appelant ne rend
 * alors AUCUN élément -- jamais un bloc vide, jamais un texte inventé.
 * C'est ce qui garantit la compatibilité arrière exacte (mandat §G :
 * « no custom template => generic current wording »).
 */

import {
  COMMUNICATION_TEXT_SPEC,
  normalizeCommunicationText,
  type CommunicationTextKey,
  type CommunicationTextOverrides,
} from "@/lib/communications/text-keys";
import {
  renderCommunicationTemplate,
  type CommunicationTemplateValues,
} from "@/lib/communications/template-variables";

export type CommunicationTextSource = "merchant_override" | "base" | "absent";

export interface ResolvedCommunicationText {
  /** L'emplacement demandé, renvoyé TEL QUEL -- preuve structurelle
   *  qu'une résolution de texte ne peut pas changer d'emplacement. */
  readonly key: CommunicationTextKey;
  /** `null` uniquement lorsque `source === "absent"`. Jamais `""`. */
  readonly text: string | null;
  readonly source: CommunicationTextSource;
}

export function resolveCommunicationText(
  key: CommunicationTextKey,
  overrides: CommunicationTextOverrides | null | undefined,
  translate: (i18nKey: string) => string,
  explicitBase?: string | null
): ResolvedCommunicationText {
  const override = normalizeCommunicationText(key, overrides?.[key]);
  if (override !== undefined) {
    return { key, text: override, source: "merchant_override" };
  }

  if (typeof explicitBase === "string" && explicitBase.trim() !== "") {
    return { key, text: explicitBase, source: "base" };
  }

  const defaultI18nKey = COMMUNICATION_TEXT_SPEC[key].defaultI18nKey;
  if (defaultI18nKey !== null) {
    return { key, text: translate(defaultI18nKey), source: "base" };
  }

  return { key, text: null, source: "absent" };
}

/**
 * Résout PUIS substitue les variables, en un seul appel, pour les
 * emplacements qui en portent.
 *
 * La substitution s'applique à l'issue de la résolution, QUELLE QU'ELLE
 * SOIT : un texte de base de la plateforme peut lui aussi contenir un
 * emplacement. Un texte `absent` reste `null` -- on ne substitue pas
 * dans le vide pour obtenir une chaîne vide affichable.
 */
export function resolveAndRenderCommunicationText(
  key: CommunicationTextKey,
  overrides: CommunicationTextOverrides | null | undefined,
  translate: (i18nKey: string) => string,
  values: CommunicationTemplateValues | null | undefined,
  explicitBase?: string | null
): ResolvedCommunicationText {
  const resolved = resolveCommunicationText(
    key,
    overrides,
    translate,
    explicitBase
  );
  if (resolved.text === null) return resolved;
  const rendered = renderCommunicationTemplate(resolved.text, values);
  // Une substitution qui vide entièrement le texte (gabarit réduit à un
  // seul emplacement sans valeur) ne doit pas produire un bloc vide
  // affiché : elle retombe sur `absent`, donc sur « ne rien rendre ».
  if (rendered.trim() === "") {
    return { key, text: null, source: "absent" };
  }
  return { key, text: rendered, source: resolved.source };
}
