/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1 — moteur de rendu déterministe.
 *
 * Fonctions PURES uniquement : aucun accès réseau, aucun appel IA,
 * aucune génération de texte juridique à la volée -- l'assemblage
 * consiste à combiner un gabarit Scanym FIXE (`cgv_template.
 * controlled_sections`, jamais modifiable par le marchand) avec les
 * paramètres business du marchand (régime de rétractation, délai de
 * préparation, politiques d'annulation/substitution) et une variante
 * de présentation PRÉ-APPROUVÉE (mandat section G : "No arbitrary
 * AI-generated legal rewriting"). Le hash d'intégrité, lui, est
 * TOUJOURS recalculé côté serveur (SQL, `md5()`) à partir du texte
 * exact reçu -- jamais fait confiance à une valeur transmise (voir
 * publish_merchant_cgv_version dans
 * DRAFT-lot-seller-legal-profile-cgv-engine-v1.sql).
 *
 * Déterminisme : render(sameInputs) produit TOUJOURS exactement la
 * même chaîne de sortie (aucune dépendance à Date.now()/Math.random()
 * -- toute donnée temporelle doit être un paramètre explicite si
 * jamais nécessaire, ce qui n'est pas le cas ici).
 */

export type WithdrawalRegime = "EXEMPT_PERISHABLE" | "STANDARD_14_DAYS" | "MIXED";
export type PreparationTimeUnit = "MINUTES" | "HOURS";
export type PresentationVariant = "FORMAL" | "WARM" | "PREMIUM" | "SIMPLE";

export interface CgvTemplateControlledSections {
  header: string;
  identity_intro: string;
  withdrawal_clauses: Record<WithdrawalRegime, string | null>;
  mediator_clause: string;
  preparation_clause: string;
  cancellation_clause_label: string;
  substitution_clause_label: string;
  jurisdiction_clause: string;
}

export interface LegalProfileForRender {
  legalForm: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  governingCountry: string;
  customerServiceEmail: string | null;
  customerServicePhone: string | null;
  mediatorName: string;
  mediatorAddress: string;
  mediatorWebsite: string;
}

export interface CgvBusinessConditionsForRender {
  withdrawalRegime: WithdrawalRegime;
  preparationTimeMin: number;
  preparationTimeMax: number;
  preparationTimeUnit: PreparationTimeUnit;
  cancellationPolicyText: string | null;
  substitutionPolicyText: string | null;
}

export interface RenderCgvInput {
  sellerName: string;
  template: CgvTemplateControlledSections;
  legal: LegalProfileForRender;
  business: CgvBusinessConditionsForRender;
  locale: string;
  presentationVariant: PresentationVariant;
}

/**
 * Préfixes de section déterministes par variante de présentation --
 * TON UNIQUEMENT (mandat section G). Aucune de ces variantes ne
 * modifie, ne résume, ni ne remplace une clause légale-cœur : elles
 * habillent uniquement l'introduction, jamais le contenu normatif
 * (withdrawal_clauses, mediator_clause, jurisdiction_clause restent
 * mot pour mot le texte du gabarit, quelle que soit la variante).
 */
const INTRO_TONE: Record<PresentationVariant, (base: string) => string> = {
  FORMAL: (base) => base,
  WARM: (base) => `${base} Nous sommes ravis de vous compter parmi nos clients.`,
  PREMIUM: (base) => `${base} Une attention particulière est portée à chaque commande.`,
  SIMPLE: (base) => base,
};

function unitLabel(unit: PreparationTimeUnit): string {
  return unit === "MINUTES" ? "minutes" : "heures";
}

/**
 * Assemble le texte CGV rendu. Sortie déterministe : mêmes entrées ->
 * même chaîne de sortie, caractère pour caractère, à chaque appel.
 */
export function renderCgv(input: RenderCgvInput): string {
  const { sellerName, template, legal, business, presentationVariant } = input;

  const withdrawalClause = template.withdrawal_clauses[business.withdrawalRegime];
  if (!withdrawalClause) {
    // Cohérent avec le garde-fou SQL cgv_completeness_errors /
    // publish_merchant_cgv_version : MIXED (ou tout régime sans
    // clause résolue dans ce gabarit) échoue fermé, jamais une
    // publication avec une clause manquante silencieusement omise.
    throw new Error(`SCANYM_CGV_RENDER: no controlled clause for withdrawal regime ${business.withdrawalRegime}`);
  }

  const introTone = INTRO_TONE[presentationVariant] ?? INTRO_TONE.FORMAL;
  const addressLine = [legal.addressLine1, legal.addressLine2, `${legal.postalCode} ${legal.city}`]
    .filter((part): part is string => !!part && part.trim() !== "")
    .join(", ");

  const sections: string[] = [
    `<h1>${escapeHtml(template.header)}</h1>`,
    `<p>${escapeHtml(introTone(template.identity_intro))}</p>`,
    `<section><h2>Identité du vendeur</h2><p>${escapeHtml(sellerName)} (${escapeHtml(legal.legalForm)}), ${escapeHtml(addressLine)}, ${escapeHtml(legal.governingCountry)}.</p></section>`,
  ];

  if (legal.customerServiceEmail || legal.customerServicePhone) {
    const contact = [legal.customerServiceEmail, legal.customerServicePhone].filter(Boolean).join(" / ");
    sections.push(`<section><h2>Service client</h2><p>${escapeHtml(contact)}</p></section>`);
  }

  sections.push(
    `<section><h2>${escapeHtml(template.cancellation_clause_label)}</h2><p>${escapeHtml(business.cancellationPolicyText ?? "")}</p></section>`
  );
  sections.push(
    `<section><h2>${escapeHtml(template.substitution_clause_label)}</h2><p>${escapeHtml(business.substitutionPolicyText ?? "")}</p></section>`
  );
  sections.push(
    `<section><h2>Délai de préparation</h2><p>${escapeHtml(template.preparation_clause)} Délai indicatif : ${business.preparationTimeMin}–${business.preparationTimeMax} ${unitLabel(business.preparationTimeUnit)}.</p></section>`
  );
  sections.push(
    `<section><h2>Droit de rétractation</h2><p>${escapeHtml(withdrawalClause)}</p></section>`
  );
  sections.push(`<section><h2>Médiation de la consommation</h2><p>${escapeHtml(template.mediator_clause)} ${escapeHtml(legal.mediatorName)}, ${escapeHtml(legal.mediatorAddress)}, ${escapeHtml(legal.mediatorWebsite)}.</p></section>`);
  sections.push(`<section><h2>Droit applicable</h2><p>${escapeHtml(template.jurisdiction_clause)}</p></section>`);

  return sections.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
