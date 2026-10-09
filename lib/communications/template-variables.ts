/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — LISTE BLANCHE STRICTE
 * des variables de gabarit, et SEULE autorité de substitution.
 *
 * Logique PURE : aucun réseau, aucun React, aucune lecture de base,
 * aucune horloge. Même fonction appelée côté serveur (rendu d'e-mail) et
 * côté client (prévisualisation back-office) -- une seule autorité, donc
 * jamais deux rendus divergents pour un même gabarit.
 *
 * ──────────────────────────────────────────────────────────────────────
 * TEXTE BRUT, PAS DE BALISAGE (mandat §A, littéral : « avoid arbitrary
 * unsafe HTML storage unless the existing safe rendering model already
 * supports it »).
 *
 * Le modèle de rendu sûr déjà en place dans ce dépôt est celui de
 * lib/legal/render.ts : l'entrée marchande est une VALEUR TYPÉE ou un
 * CHOIX ÉNUMÉRÉ inséré dans une structure détenue par la plateforme, et
 * TOUTE interpolation passe par `escapeHtml`. Il n'existe AUCUN modèle
 * de stockage de HTML marchand dans ce dépôt, et
 * `merchant_tracking_status_text.body` stocke du texte brut.
 *
 * Ce module reste donc strictement dans ce modèle :
 *   - entrée = texte BRUT + emplacements `{variable}` d'une liste FERMÉE ;
 *   - sortie = texte BRUT ;
 *   - l'échappement HTML est appliqué PLUS TARD, à la frontière de
 *     rendu (lib/server/notifications/* pour l'e-mail, nœud texte React
 *     pour l'écran) -- jamais ici, pour qu'un même gabarit rendu puisse
 *     alimenter indifféremment la variante HTML et la variante texte
 *     d'un e-mail sans double échappement.
 *
 * Conséquence directement testée (MCC-V1-MALICIOUS-TEXT) : un corps
 * marchand contenant `<script>alert(1)</script>` ressort TEL QUEL comme
 * texte -- il est échappé par la frontière e-mail et rendu comme nœud
 * texte par React. Il n'existe aucun chemin où il devienne du balisage.
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * Les 13 variables autorisées -- MIROIR EXACT de
 * `public.communication_template_variables()` (voir
 * supabase/DRAFT-lot-merchant-customer-communications-v1.sql). Toute
 * divergence entre les deux listes est détectée par un test structurel
 * (tests/mcc-v1-sql-structural.test.ts), jamais laissée à la vigilance.
 *
 * Aucune variable ne désigne une donnée d'un AUTRE tenant, ni une donnée
 * mutable du catalogue : toutes sont soit l'identité du commerçant
 * propriétaire, soit un fait déjà figé de la commande.
 */
export const COMMUNICATION_TEMPLATE_VARIABLES = [
  "merchant_name",
  "order_reference",
  "order_total",
  "fulfillment_type",
  "fulfillment_date",
  "fulfillment_slot",
  "merchant_address",
  "merchant_email",
  "merchant_phone",
  "carrier_name",
  "invoice_requested",
  "withdrawal_link",
  "withdrawal_eligible",
] as const;

export type CommunicationTemplateVariable =
  (typeof COMMUNICATION_TEMPLATE_VARIABLES)[number];

/**
 * Syntaxe d'emplacement : `{nom_de_variable}`, identique à celle déjà
 * employée par lib/i18n.ts (`{name}`, `{n}`, `{zone}`) -- le commerçant
 * n'apprend pas une seconde syntaxe.
 *
 * Le jeu de caractères admis est volontairement restreint à
 * `[a-z0-9_]` : `{ y }` (espaces), `{Z}` (majuscule), `{a-b}` (tiret),
 * `{1+1}` et `{}` ne sont PAS des emplacements et traversent le gabarit
 * intacts. Aucune expression, aucun appel, aucun chemin de propriété
 * n'est interprétable -- ce n'est pas un moteur de gabarit, c'est une
 * substitution de jetons.
 *
 * Un cas limite assumé et VÉRIFIÉ des deux côtés (ici et par le post-vol
 * SQL) : `{{x}}` CONTIENT la sous-chaîne `{x}`, qui est donc bien vue
 * comme un emplacement. À l'écriture le gabarit est refusé tant que `x`
 * n'est pas dans la liste blanche ; au rendu `{{x}}` donnerait `{}`.
 * Ce n'est pas une échappatoire : doubler l'accolade ne protège rien et
 * ne permet pas d'injecter quoi que ce soit -- la sortie reste du texte.
 */
const PLACEHOLDER_PATTERN = /\{([a-z0-9_]+)\}/g;

export function isCommunicationTemplateVariable(
  value: unknown
): value is CommunicationTemplateVariable {
  return (
    typeof value === "string" &&
    (COMMUNICATION_TEMPLATE_VARIABLES as readonly string[]).includes(value)
  );
}

/**
 * Tous les jetons `{...}` présents dans un gabarit, dans l'ordre
 * d'apparition, doublons compris retirés. N'interprète rien.
 */
export function extractTemplatePlaceholders(
  template: string | null | undefined
): string[] {
  if (typeof template !== "string" || template === "") return [];
  const seen = new Set<string>();
  const found: string[] = [];
  // `matchAll` sur une regex globale : pas d'état `lastIndex` partagé
  // entre deux appels (piège classique de `regex.exec` en boucle).
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

/** Les jetons présents qui ne figurent PAS dans la liste blanche. */
export function findUnknownTemplateVariables(
  template: string | null | undefined
): string[] {
  return extractTemplatePlaceholders(template).filter(
    (name) => !isCommunicationTemplateVariable(name)
  );
}

export type TemplateValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly unknownVariables: readonly string[] };

/**
 * ═══ MCC-V1-UNKNOWN-VARIABLE-RULE (règle documentée, mandat §D) ═══
 *
 * Le mandat autorise deux comportements pour une variable inconnue :
 * « must fail validation or be safely ignored according to a documented
 * rule ». Ce lot applique les DEUX, à deux moments distincts, et c'est
 * cette frontière qui est la règle :
 *
 *   1. À L'ÉCRITURE — ÉCHEC DE VALIDATION, rien n'est stocké.
 *      `validateCommunicationTemplate` (ici) et le RPC SQL
 *      `set_merchant_communication_text` (erreur 22023
 *      `SCANYM_COMMUNICATION_UNKNOWN_VARIABLE`) refusent le gabarit.
 *      Le commerçant apprend immédiatement sa faute de frappe plutôt
 *      que de découvrir un trou dans un e-mail déjà parti.
 *      Le SERVEUR est l'autorité : la validation client n'est qu'un
 *      aller-retour épargné.
 *
 *   2. AU RENDU — IGNORÉE SANS BRUIT, remplacée par la chaîne vide.
 *      `renderCommunicationTemplate` (ici) ne peut rencontrer un jeton
 *      inconnu que pour une ligne écrite AVANT un resserrement de la
 *      liste blanche. Un envoi ne doit jamais échouer pour cela, et le
 *      jeton ne doit jamais être recraché tel quel au client (il
 *      exposerait un nom interne). Il disparaît donc.
 *
 * Même traitement pour une variable CONNUE sans valeur disponible
 * (ex. `{fulfillment_slot}` alors qu'aucun modèle de créneau n'existe) :
 * chaîne vide. Jamais « undefined », jamais « null », jamais le jeton.
 *
 * NON-RÉCURSIVITÉ : la substitution est faite en UN SEUL passage. Une
 * valeur qui contiendrait elle-même `{merchant_name}` n'est jamais
 * re-développée -- aucune expansion en cascade, donc aucune bombe de
 * substitution possible depuis une donnée de commande.
 */
export function validateCommunicationTemplate(
  template: string | null | undefined
): TemplateValidation {
  const unknownVariables = findUnknownTemplateVariables(template);
  if (unknownVariables.length > 0) return { ok: false, unknownVariables };
  return { ok: true };
}

export type CommunicationTemplateValues = Partial<
  Record<CommunicationTemplateVariable, string | null | undefined>
>;

/**
 * Substitue les variables d'un gabarit. Texte brut en entrée, texte brut
 * en sortie (voir l'en-tête du module : l'échappement appartient à la
 * frontière de rendu).
 *
 * Voir MCC-V1-UNKNOWN-VARIABLE-RULE ci-dessus pour le sort d'un jeton
 * inconnu ou sans valeur : chaîne vide, dans les deux cas.
 */
export function renderCommunicationTemplate(
  template: string | null | undefined,
  values: CommunicationTemplateValues | null | undefined
): string {
  if (typeof template !== "string" || template === "") return "";
  return template.replace(PLACEHOLDER_PATTERN, (_whole, rawName: string) => {
    if (!isCommunicationTemplateVariable(rawName)) return "";
    // Propriété PROPRE uniquement : un gabarit ne peut pas atteindre
    // `{constructor}` ou une clé héritée du prototype -- la garde de
    // liste blanche l'interdit déjà, celle-ci est la défense en
    // profondeur.
    if (!values || !Object.prototype.hasOwnProperty.call(values, rawName)) {
      return "";
    }
    const value = values[rawName];
    return typeof value === "string" ? value : "";
  });
}
