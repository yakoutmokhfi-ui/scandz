/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1/v2 — moteur de rendu déterministe.
 *
 * Fonctions PURES uniquement : aucun accès réseau, aucun appel IA,
 * aucune génération de texte juridique à la volée -- l'assemblage
 * consiste à combiner un gabarit Scanym FIXE (`cgv_template.
 * controlled_sections`, jamais modifiable par le marchand) avec les
 * paramètres business du marchand (régime de rétractation, délai de
 * préparation, politiques d'annulation/substitution, chaîne du froid,
 * tarification au poids, identité légale complète) et une variante de
 * présentation PRÉ-APPROUVÉE (mandat section G : "No arbitrary
 * AI-generated legal rewriting"). Le hash d'intégrité, lui, est
 * TOUJOURS recalculé côté serveur (SQL, `md5()`) à partir du texte
 * exact reçu -- jamais fait confiance à une valeur transmise (voir
 * persist_merchant_cgv_version dans
 * DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql).
 *
 * Déterminisme : render(sameInputs) produit TOUJOURS exactement la
 * même chaîne de sortie (aucune dépendance à Date.now()/Math.random()
 * -- toute donnée temporelle doit être un paramètre explicite si
 * jamais nécessaire, ce qui n'est pas le cas ici).
 *
 * CGV ENGINE ENRICHMENT v2 -- extends the v1 renderer with the
 * remaining sections the mandate's 26-section French B2C food/
 * perishable CGV structure requires (seller identification with
 * SIREN/SIRET/VAT, portion pricing, cold chain, and the generic fixed
 * clauses: purpose/scope, product characteristics, prices & taxes,
 * ordering process, contract formation, payment, availability, pickup,
 * delivery, complaints, legal guarantees, liability, force majeure,
 * personal data, applicable law). Every v2 template key is OPTIONAL on
 * `CgvTemplateControlledSections` and every v2 section is rendered
 * ONLY when the template actually provides the corresponding key --
 * this keeps a v1 template object (still referenced by any already-
 * published merchant_cgv_version row, and by any restaurant that has
 * not republished under the new template version) a fully valid input
 * to this function, with byte-identical output to before. See
 * lib/legal/section-classification.ts for the documentation/testability
 * map of every one of the 26 mandate sections.
 *
 * CGV ENGINE ENRICHMENT v2.2 -- two changes, neither breaking a v1/v2
 * template object:
 *   1. Section 26's heading is renamed from "Droit applicable" to
 *      "Juridiction compétente" -- UNIVERSALLY, for every template
 *      version -- because "Droit applicable" is a near-synonym of
 *      section 25's "Loi applicable" heading and was genuinely
 *      confusable (see FR_FOOD_PERISHABLE_B2C template version 3's own
 *      header for the companion CONTENT fix: version 3's
 *      jurisdiction_clause no longer restates governing law at all,
 *      addressing competent-court/venue only). This is a pure label
 *      change with zero effect on which text is shown for any
 *      template version.
 *   2. `complaint_before_mediation_clause` -- a new OPTIONAL,
 *      GENERIC_FIXED (merchant-agnostic) key. When the template
 *      provides it, it is rendered as a leading paragraph INSIDE the
 *      existing "Médiation de la consommation" section, BEFORE the
 *      merchant's own mediator identity paragraph (mediator_clause +
 *      interpolated name/address/website/phone/email, unchanged) --
 *      so the rendered flow is: contact the merchant/customer service
 *      first, THEN (only if unresolved) the designated mediator. A v1/
 *      v2 template (no such key) renders this section exactly as
 *      before -- no leading paragraph, never an error.
 *
 * CGV ENGINE v2.4 -- LEGAL-CORRECTNESS REMEDIATION. One rendering
 * change: within the existing "Droit de rétractation" section, two
 * new OPTIONAL, GENERIC_CONDITIONAL keys --
 * `withdrawal_exercise_method_clause` and `withdrawal_model_form_text`
 * -- are rendered as trailing paragraphs, gated on
 * `business.withdrawalRegime === "STANDARD_14_DAYS"` (the only regime
 * with a real withdrawal right, hence the only one the "online
 * withdrawal function" statutory disclosure applies to). NEVER
 * rendered for EXEMPT_PERISHABLE. Every other v2.4 change (citation
 * fix, delivery fallback sentence, cancellation/substitution fallback
 * rewording) is CONTENT-only, at the `cgv_template` row layer (see
 * DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql) -- zero further
 * code change in this file for those. `customerServicePhone` was
 * ALREADY rendered before v2.4 (Section "Service client" below,
 * unchanged since v1/v2) -- confirmed by reading this file, not a
 * v2.4 change.
 *
 * CGV ENGINE v2.5 -- D.211-2 LEGAL GUARANTEE ENCADRÉ (Task 1). One new
 * OPTIONAL, GENERIC_FIXED key, `legal_guarantee_encadre`, rendered as
 * its OWN distinct bordered block right after "Garanties légales" --
 * see `renderCgv` below. Rendered UNCONDITIONALLY on `withdrawalRegime`
 * (unlike the v2.4 withdrawal-only keys): the legal-guarantee regime
 * (conformité, articles L.217-1 à L.217-32, + vices cachés, articles
 * 1641 à 1649 du code civil) is orthogonal to the withdrawal-right
 * regime -- no `product_condition`-style new field was added or is
 * needed for this. See DRAFT-lot-seller-legal-profile-cgv-engine-v2-
 * 5.sql for the template row change and the new LEGAL_GUARANTEE_
 * BLOCK_MISSING / PLACEHOLDER_TEXT_DETECTED / WITHDRAWAL_RUNTIME_NOT_
 * READY enforced publication guards (Tasks 4/5).
 */

export type WithdrawalRegime = "EXEMPT_PERISHABLE" | "STANDARD_14_DAYS" | "MIXED";
export type PreparationTimeUnit = "MINUTES" | "HOURS";
export type PresentationVariant = "FORMAL" | "WARM" | "PREMIUM" | "SIMPLE";
export type WeightPricingMode = "FIXED_PORTION_PRICE" | "ACTUAL_WEIGHT_PRICE";

export interface CgvTemplateControlledSections {
  header: string;
  identity_intro: string;
  withdrawal_clauses: Record<WithdrawalRegime, string | null>;
  mediator_clause: string;
  preparation_clause: string;
  cancellation_clause_label: string;
  substitution_clause_label: string;
  jurisdiction_clause: string;

  // ------------------------------------------------------------------
  // v2 additions -- ALL OPTIONAL. A v1 template object (`version: 1`,
  // seeded by DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql) has
  // none of these keys at all and remains a perfectly valid value of
  // this type; every corresponding section below is skipped, never an
  // error, never a placeholder.
  // ------------------------------------------------------------------
  purpose_scope_clause?: string;
  products_characteristics_clause?: string;
  /** Only `FIXED_PORTION_PRICE` is ever populated by Scanym -- the
   *  deliberate absence of an `ACTUAL_WEIGHT_PRICE` key is enforced in
   *  code (see `renderCgv` below and `persist_merchant_cgv_version`),
   *  never merely by omission from this template object. */
  portion_pricing_clauses?: { FIXED_PORTION_PRICE?: string };
  prices_taxes_clause?: string;
  ordering_process_clause?: string;
  contract_formation_clause?: string;
  payment_clause?: string;
  availability_clause?: string;
  pickup_clause?: string;
  delivery_clause?: string;
  cold_chain_clauses?: { transport: string; post_handover: string };
  cancellation_clause_intro?: string;
  cancellation_clause_fallback?: string;
  substitution_clause_intro?: string;
  substitution_clause_fallback?: string;
  complaints_clause?: string;
  legal_guarantees_clause?: string;
  liability_clause?: string;
  force_majeure_clause?: string;
  personal_data_clause?: string;
  applicable_law_clause?: string;

  /** v2.2 -- OPTIONAL, GENERIC_FIXED. When present, rendered as a
   *  leading paragraph in the mediation section, BEFORE the merchant's
   *  own mediator identity paragraph -- see the file header. Absent
   *  (v1/v2 templates) -> that leading paragraph is simply omitted,
   *  never an error, never a placeholder. */
  complaint_before_mediation_clause?: string;

  /** v2.4 -- OPTIONAL, GENERIC_CONDITIONAL. States HOW the withdrawal
   *  right can currently be exercised (any unambiguous means -- the
   *  model form below, e-mail, or any other clear written statement --
   *  addressed to the seller's own contact details) and states plainly
   *  that a dedicated ONLINE withdrawal function is not yet available
   *  on the platform. Rendered ONLY when `business.withdrawalRegime
   *  === "STANDARD_14_DAYS"` (the only regime with a real withdrawal
   *  right, see `renderCgv` below) -- NEVER for EXEMPT_PERISHABLE,
   *  regardless of whether a template happens to provide this key,
   *  since no withdrawal right exists there at all. Absent (v1/v2/v3
   *  templates) -> omitted, never an error, never a placeholder. */
  withdrawal_exercise_method_clause?: string;

  /** v2.4 -- OPTIONAL, GENERIC_CONDITIONAL. The standard/model
   *  withdrawal form (formulaire type de rétractation), generic and
   *  non-merchant-specific -- the merchant's own contact details are
   *  referenced only via the seller-identification section already
   *  rendered above, never duplicated here. Same STANDARD_14_DAYS-only
   *  gate as `withdrawal_exercise_method_clause` above -- NEVER
   *  rendered for EXEMPT_PERISHABLE. */
  withdrawal_model_form_text?: string;

  /** CGV ENGINE v2.5 (Task 1) -- OPTIONAL, GENERIC_FIXED. The mandatory
   *  official encadré required by article D.211-2 du Code de la
   *  consommation (Annexe, Section A -- "biens, hors animaux
   *  domestiques"), in force since 2022-10-01 (Décret n° 2022-946 du
   *  29 juin 2022, art. 2). Applies UNIFORMLY to every B2C goods sale
   *  under L.217-1, regardless of `business.withdrawalRegime` -- the
   *  legal-guarantee (conformité + vices cachés) regime is entirely
   *  orthogonal to the withdrawal-right regime (see this file's own
   *  header). Rendered as a DISTINCT, visually set-off block (never
   *  blended into the surrounding "Garanties légales" prose) --
   *  see `renderCgv` below. Absent (v1-v4 templates) -> omitted,
   *  never an error, never a placeholder -- but see
   *  LEGAL_GUARANTEE_BLOCK_MISSING (persist_merchant_cgv_version,
   *  DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql) for why a
   *  merchant pinned to a template lacking this key can no longer
   *  actually PUBLISH once this lot ships. */
  legal_guarantee_encadre?: { heading: string; paragraphs: string[] };
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
  /** v2 -- dénomination sociale (raison sociale), distincte du nom
   *  commercial (`sellerName`, top-level). Null/absent -> the trade
   *  name alone is shown, never an invented value, never an error. */
  legalEntityName?: string | null;
  siren?: string | null;
  siret?: string | null;
  vatNumber?: string | null;
  mediatorPhone?: string | null;
  mediatorEmail?: string | null;
}

export interface CgvBusinessConditionsForRender {
  withdrawalRegime: WithdrawalRegime;
  preparationTimeMin: number;
  preparationTimeMax: number;
  preparationTimeUnit: PreparationTimeUnit;
  cancellationPolicyText: string | null;
  substitutionPolicyText: string | null;
  /** v2 -- renders the two cold-chain clauses (transport /
   *  post-handover) when, and only when, this is exactly `true`.
   *  Absent/false -> neither clause is rendered. */
  coldChainApplicable?: boolean;
  /** v2 -- `FIXED_PORTION_PRICE` renders the fixed-portion-price
   *  clause; `null`/absent renders nothing for that section;
   *  `ACTUAL_WEIGHT_PRICE` makes `renderCgv` throw
   *  `ActualWeightPriceUnsupportedError` -- see below. This is the
   *  fail-closed enforcement point for the CLIENT-SIDE ADVISORY
   *  PREVIEW path (app/dashboard/legal-cgv/page.tsx calls renderCgv()
   *  directly, bypassing persist_merchant_cgv_version's own equivalent
   *  check entirely) -- the two paths fail closed INDEPENDENTLY. */
  weightPricingMode?: WeightPricingMode | null;
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
 * v2 -- thrown by `renderCgv` when `business.weightPricingMode ===
 * "ACTUAL_WEIGHT_PRICE"`. Scanym does not currently support price
 * recalculation based on actual post-preparation weight. This is a
 * DISTINCT, typed error (never a generic `Error`) so callers (the
 * dashboard's advisory preview, and — defensively — the server
 * publish path) can distinguish it from every other render failure.
 * `persist_merchant_cgv_version` (SQL) enforces the exact same rule,
 * independently, for the real publish path -- see that function's own
 * ACTUAL_WEIGHT_PRICE_UNSUPPORTED check. Both enforcement points exist
 * because the client-side advisory preview (lib/services/legal-cgv.ts
 * / app/dashboard/legal-cgv/page.tsx) calls `renderCgv` directly and
 * NEVER goes through `persist_merchant_cgv_version` at all.
 */
export class ActualWeightPriceUnsupportedError extends Error {
  constructor() {
    super(
      "SCANYM_CGV_RENDER: ACTUAL_WEIGHT_PRICE_UNSUPPORTED -- Scanym does not currently support price " +
        "recalculation based on actual post-preparation weight; configure FIXED_PORTION_PRICE or leave " +
        "weight_pricing_mode null."
    );
    this.name = "ActualWeightPriceUnsupportedError";
  }
}

/**
 * Préfixes de section déterministes par variante de présentation --
 * TON UNIQUEMENT (mandat section G). Aucune de ces variantes ne
 * modifie, ne résume, ni ne remplace une clause légale-cœur : elles
 * habillent uniquement l'introduction, jamais le contenu normatif
 * (withdrawal_clauses, mediator_clause, jurisdiction_clause, et tout
 * autre nouveau contenu légal-cœur v2 restent mot pour mot le texte du
 * gabarit, quelle que soit la variante).
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
 * CGV DOCUMENT PRESENTATION v1 -- NUMÉROTATION DE CHAPITRE.
 *
 * Compteur de chapitres d'UN rendu. Il n'est PAS global : une instance
 * neuve est créée à chaque appel de `renderCgv`, donc le déterminisme
 * (mêmes entrées -> même sortie, caractère pour caractère) est intact,
 * et deux rendus concurrents ne peuvent pas se marcher dessus.
 *
 * Le numéro est attribué au moment où la section est RÉELLEMENT
 * poussée dans le document : une section conditionnelle absente ne
 * consomme aucun numéro, donc la suite est toujours 1, 2, 3, … sans
 * trou (mandat §3). Aucun numéro n'est écrit en dur dans un gabarit
 * légal contrôlé.
 *
 * L'encadré réglementaire D.211-2 n'est volontairement PAS un chapitre
 * (pas de numéro, pas de `data-chapter`) : c'est un bloc réglementaire
 * distinct inséré dans le document, pas une clause de plus.
 */
function createChapterCounter(): {
  section: (heading: string, bodyHtml: string, attrs?: string) => string;
  count: () => number;
} {
  let chapter = 0;
  return {
    section(heading: string, bodyHtml: string, attrs = ""): string {
      chapter += 1;
      return (
        `<section class="cgv-section" data-chapter="${chapter}"${attrs}>` +
        `<h2 class="cgv-section-heading">` +
        `<span class="cgv-chapter-number">${chapter}.</span> ` +
        `<span class="cgv-chapter-title">${escapeHtml(heading)}</span>` +
        `</h2>${bodyHtml}</section>`
      );
    },
    count: () => chapter,
  };
}

/** Pousse une section fixe simple (titre + un seul paragraphe) SI ET
 *  SEULEMENT SI le gabarit fournit la clé correspondante -- jamais un
 *  paragraphe vide, jamais une erreur pour une clé absente (v1 template
 *  compatibility), et jamais un numéro de chapitre consommé pour rien. */
function pushFixedSection(
  sections: string[],
  chapters: ReturnType<typeof createChapterCounter>,
  heading: string,
  text: string | undefined
): void {
  if (text) {
    sections.push(chapters.section(heading, `<p>${escapeHtml(text)}</p>`));
  }
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
    // persist_merchant_cgv_version : MIXED (ou tout régime sans clause
    // résolue dans ce gabarit) échoue fermé, jamais une publication
    // avec une clause manquante silencieusement omise.
    throw new Error(`SCANYM_CGV_RENDER: no controlled clause for withdrawal regime ${business.withdrawalRegime}`);
  }

  // v2 -- FAIL-CLOSED for ACTUAL_WEIGHT_PRICE at the render layer
  // itself. This is the ONLY enforcement point the client-side
  // advisory preview path ever passes through (it calls renderCgv()
  // directly and never reaches persist_merchant_cgv_version's own,
  // independent SQL-level check) -- both paths must fail closed on
  // their own, and this is this path's own.
  if (business.weightPricingMode === "ACTUAL_WEIGHT_PRICE") {
    throw new ActualWeightPriceUnsupportedError();
  }

  const introTone = INTRO_TONE[presentationVariant] ?? INTRO_TONE.FORMAL;
  const addressLine = [legal.addressLine1, legal.addressLine2, `${legal.postalCode} ${legal.city}`]
    .filter((part): part is string => !!part && part.trim() !== "")
    .join(", ");

  // CGV DOCUMENT PRESENTATION v1 (§4) -- en-tête de document. Le titre
  // reste EXACTEMENT `template.header` (texte contrôlé, jamais
  // réécrit) ; le nom du marchand affiché sous le titre vient des
  // seules entrées de rendu déjà fiables (`sellerName`), jamais d'une
  // métadonnée inventée. La date/référence de publication reste
  // affichée par la page publique, inchangée.
  const chapters = createChapterCounter();
  const sections: string[] = [
    `<header class="cgv-document-header">` +
      `<h1 class="cgv-document-title">${escapeHtml(template.header)}</h1>` +
      `<p class="cgv-document-seller">${escapeHtml(sellerName)}</p>` +
      `</header>`,
    `<p class="cgv-preamble">${escapeHtml(introTone(template.identity_intro))}</p>`,
  ];

  // ------------------------------------------------------------------
  // Section 2 -- Identité du vendeur (MERCHANT_VALUE). `legalEntityName`
  // (dénomination sociale) is shown when present, with the trade name
  // (`sellerName`) noted alongside it only when the two differ; absent
  // -> the trade name alone, never an error, never an invented value.
  // SIREN/SIRET/VAT are each rendered ONLY when present -- never a
  // "SIREN : —" or similar placeholder line for a missing value.
  // ------------------------------------------------------------------
  const legalEntityName = legal.legalEntityName && legal.legalEntityName.trim() !== "" ? legal.legalEntityName : null;
  const displayName = legalEntityName ?? sellerName;
  const tradeNameNote =
    legalEntityName && legalEntityName !== sellerName
      ? ` (exerçant sous le nom commercial « ${escapeHtml(sellerName)} »)`
      : "";
  // CGV DOCUMENT PRESENTATION v1 (§5) -- la MÊME identité, présentée en
  // lignes étiquetées (liste de définitions) plutôt qu'en un paragraphe
  // dense. Aucune valeur n'est ajoutée, retirée ni reformulée : seules
  // les étiquettes de présentation ("Dénomination", "Forme juridique",
  // …) encadrent des valeurs déjà rendues auparavant, dans le même
  // ordre. Une valeur optionnelle absente ne produit AUCUNE ligne --
  // jamais un "SIREN : —" fabriqué.
  const identityRows: Array<[string, string]> = [
    ["Dénomination", `${escapeHtml(displayName)}${tradeNameNote}`],
    ["Forme juridique", escapeHtml(legal.legalForm)],
    ["Adresse", escapeHtml(addressLine)],
    ["Pays", escapeHtml(legal.governingCountry)],
  ];
  if (legal.siren) identityRows.push(["SIREN", escapeHtml(legal.siren)]);
  if (legal.siret) identityRows.push(["SIRET", escapeHtml(legal.siret)]);
  if (legal.vatNumber) identityRows.push(["N° TVA intracommunautaire", escapeHtml(legal.vatNumber)]);
  const identityList =
    `<dl class="cgv-identity">` +
    identityRows
      .map(
        ([label, value]) =>
          `<div class="cgv-identity-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
      )
      .join("") +
    `</dl>`;
  sections.push(chapters.section("Identité du vendeur", identityList));

  // Section 3 (GENERIC_FIXED) -- objet et champ d'application.
  pushFixedSection(sections, chapters, "Objet et champ d'application", template.purpose_scope_clause);

  // CGV DOCUMENT PRESENTATION v1 (§2) -- mêmes coordonnées, étiquetées
  // ligne par ligne au lieu d'un "email / téléphone" collé. Chaque
  // ligne n'apparaît que si la valeur existe (comportement de
  // rendu conditionnel inchangé : la section entière reste omise quand
  // aucune coordonnée n'est renseignée).
  if (legal.customerServiceEmail || legal.customerServicePhone) {
    const contactRows: Array<[string, string]> = [];
    if (legal.customerServiceEmail) contactRows.push(["E-mail", escapeHtml(legal.customerServiceEmail)]);
    if (legal.customerServicePhone) contactRows.push(["Téléphone", escapeHtml(legal.customerServicePhone)]);
    const contactList =
      `<dl class="cgv-contact">` +
      contactRows
        .map(
          ([label, value]) =>
            `<div class="cgv-identity-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
        )
        .join("") +
      `</dl>`;
    sections.push(chapters.section("Service client", contactList));
  }

  // Section 5 (GENERIC_FIXED) -- caractéristiques des produits.
  pushFixedSection(sections, chapters, "Caractéristiques des produits", template.products_characteristics_clause);

  // ------------------------------------------------------------------
  // Section 4 -- Poids et prix des portions (GENERIC_CONDITIONAL).
  // Rendered ONLY when `weightPricingMode === "FIXED_PORTION_PRICE"`
  // AND the template actually provides the matching clause text.
  // `ACTUAL_WEIGHT_PRICE` already threw above; `null`/absent renders
  // nothing for this section -- never a placeholder, never an error.
  // ------------------------------------------------------------------
  if (business.weightPricingMode === "FIXED_PORTION_PRICE" && template.portion_pricing_clauses?.FIXED_PORTION_PRICE) {
    pushFixedSection(sections, chapters, "Poids et prix des portions", template.portion_pricing_clauses.FIXED_PORTION_PRICE);
  }

  // Sections 6-10 (GENERIC_FIXED).
  pushFixedSection(sections, chapters, "Prix et taxes", template.prices_taxes_clause);
  pushFixedSection(sections, chapters, "Processus de commande", template.ordering_process_clause);
  pushFixedSection(sections, chapters, "Formation du contrat", template.contract_formation_clause);
  pushFixedSection(sections, chapters, "Paiement", template.payment_clause);
  pushFixedSection(sections, chapters, "Disponibilité des produits", template.availability_clause);

  // Section 11 (MERCHANT_VALUE) -- délai de préparation (existing v1
  // section, unchanged logic: merchant-specific min/max values
  // interpolated into Scanym's fixed generic text).
  sections.push(
    chapters.section(
      "Délai de préparation",
      `<p>${escapeHtml(template.preparation_clause)} Délai indicatif : ${business.preparationTimeMin}–${
        business.preparationTimeMax
      } ${unitLabel(business.preparationTimeUnit)}.</p>`
    )
  );

  // Sections 12-13 (GENERIC_FIXED) -- retrait / livraison.
  pushFixedSection(sections, chapters, "Retrait de la commande", template.pickup_clause);
  pushFixedSection(sections, chapters, "Livraison", template.delivery_clause);

  // ------------------------------------------------------------------
  // Section 14 -- Chaîne du froid (GENERIC_CONDITIONAL). Rendered ONLY
  // when `coldChainApplicable === true`; both sub-clauses (transport,
  // post-handover) render together or not at all.
  // ------------------------------------------------------------------
  if (business.coldChainApplicable && template.cold_chain_clauses) {
    sections.push(
      chapters.section(
        "Chaîne du froid",
        `<p>${escapeHtml(template.cold_chain_clauses.transport)}</p><p>${escapeHtml(
          template.cold_chain_clauses.post_handover
        )}</p>`
      )
    );
  }

  // Section 15 (GENERIC_CONDITIONAL) -- droit de rétractation. Existing
  // v1 logic, UNCHANGED: picks the template's clause for the merchant's
  // chosen regime. The v2 template's EXEMPT_PERISHABLE string already
  // carries its own coexistence caveat -- no logic change needed here
  // to pick that up.
  //
  // v2.4 -- withdrawal_exercise_method_clause / withdrawal_model_form_
  // text are rendered ONLY when business.withdrawalRegime ===
  // "STANDARD_14_DAYS" -- the ONLY regime with a REAL withdrawal
  // right (the statutory "online withdrawal function" obligation this
  // content documents is itself conditional on such a right existing
  // at all). This regime gate is the PRIMARY control -- defence in
  // depth over merely omitting these keys from an EXEMPT_PERISHABLE
  // branch of a template: even if a future template mistakenly
  // populated these keys outside STANDARD_14_DAYS, this gate would
  // still prevent them from rendering for a merchant with no
  // withdrawal right. Absent template keys (v1/v2/v3 templates, or a
  // v4+ template that omits them) -> omitted, never an error.
  const withdrawalExtra: string[] = [];
  if (business.withdrawalRegime === "STANDARD_14_DAYS") {
    if (template.withdrawal_exercise_method_clause) {
      withdrawalExtra.push(`<p>${escapeHtml(template.withdrawal_exercise_method_clause)}</p>`);
    }
    if (template.withdrawal_model_form_text) {
      withdrawalExtra.push(`<p>${escapeHtml(template.withdrawal_model_form_text)}</p>`);
    }
  }
  sections.push(
    chapters.section("Droit de rétractation", `<p>${escapeHtml(withdrawalClause)}</p>${withdrawalExtra.join("")}`)
  );

  // Section 16 (MERCHANT_VALUE, paired with the v2.2 GENERIC_FIXED
  // complaint_before_mediation_clause below) -- médiation de la
  // consommation. Existing v1 fields (mediatorName/Address/Website)
  // plus the two v2 fields (phone/email), each rendered only when
  // present -- byte-identical to before.
  const mediatorContactParts = [legal.mediatorPhone, legal.mediatorEmail].filter(
    (part): part is string => !!part && part.trim() !== ""
  );
  const mediatorContactSuffix =
    mediatorContactParts.length > 0 ? ` (${mediatorContactParts.map((p) => escapeHtml(p)).join(" / ")})` : "";
  // v2.2 -- when the template provides complaint_before_mediation_clause,
  // render it as a LEADING paragraph, ahead of the merchant's own
  // mediator identity paragraph, so the amicable-resolution-first flow
  // is explicit in the rendered output (mandate item 3): contact the
  // merchant first, THEN (only if unresolved) the designated mediator.
  // Absent (v1/v2 templates) -> no leading paragraph, section unchanged.
  const complaintBeforeMediation = template.complaint_before_mediation_clause
    ? `<p>${escapeHtml(template.complaint_before_mediation_clause)}</p>`
    : "";
  sections.push(
    chapters.section(
      "Médiation de la consommation",
      `${complaintBeforeMediation}<p>${escapeHtml(template.mediator_clause)} ${escapeHtml(
        legal.mediatorName
      )}, ${escapeHtml(legal.mediatorAddress)}, ${escapeHtml(legal.mediatorWebsite)}${mediatorContactSuffix}.</p>`
    )
  );

  // ------------------------------------------------------------------
  // Sections 17-18 (MERCHANT_POLICY) -- annulation / substitution.
  // ALWAYS render the generic intro (when the template provides one),
  // then render the merchant's own policy text if non-null/non-empty,
  // else the template's fallback text (when provided) -- v1 templates
  // (no intro/fallback keys) keep their EXACT v1 output shape: empty
  // intro, and an EMPTY paragraph when the merchant's own text is also
  // null (never a fabricated fallback for a v1 template that has none).
  // ------------------------------------------------------------------
  const cancellationIntro = template.cancellation_clause_intro
    ? `<p>${escapeHtml(template.cancellation_clause_intro)}</p>`
    : "";
  const cancellationHasOwnPolicy = !!business.cancellationPolicyText && business.cancellationPolicyText.trim() !== "";
  const cancellationBody = cancellationHasOwnPolicy
    ? (business.cancellationPolicyText as string)
    : template.cancellation_clause_fallback ?? business.cancellationPolicyText ?? "";
  sections.push(
    chapters.section(
      template.cancellation_clause_label,
      `${cancellationIntro}<p>${escapeHtml(cancellationBody)}</p>`
    )
  );

  const substitutionIntro = template.substitution_clause_intro
    ? `<p>${escapeHtml(template.substitution_clause_intro)}</p>`
    : "";
  const substitutionHasOwnPolicy = !!business.substitutionPolicyText && business.substitutionPolicyText.trim() !== "";
  const substitutionBody = substitutionHasOwnPolicy
    ? (business.substitutionPolicyText as string)
    : template.substitution_clause_fallback ?? business.substitutionPolicyText ?? "";
  sections.push(
    chapters.section(
      template.substitution_clause_label,
      `${substitutionIntro}<p>${escapeHtml(substitutionBody)}</p>`
    )
  );

  // Sections 19-24 (GENERIC_FIXED) -- réclamations, garanties légales,
  // responsabilité, force majeure, données personnelles.
  pushFixedSection(sections, chapters, "Réclamations", template.complaints_clause);
  pushFixedSection(sections, chapters, "Garanties légales", template.legal_guarantees_clause);

  // CGV ENGINE v2.5 (Task 1) -- the mandatory D.211-2 encadré, rendered
  // as its OWN distinct, visually/structurally set-off block (bordered
  // section, own heading) -- NEVER blended into the "Garanties
  // légales" paragraph above. class="legal-guarantee-encadre" is a
  // stable, grep-testable marker of that distinctness (mandate: "the
  // rendered HTML must clearly present it as a distinct encadré").
  // Every paragraph is rendered verbatim, in order, none dropped.
  if (template.legal_guarantee_encadre) {
    const { heading, paragraphs } = template.legal_guarantee_encadre;
    const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
    // CGV DOCUMENT PRESENTATION v1 (§7) -- le bloc reste EXACTEMENT le
    // même texte, dans le même ordre, toujours visuellement détaché.
    // Il n'est volontairement PAS numéroté : c'est un encadré
    // réglementaire, pas un chapitre de plus (et le numéroter
    // décalerait toute la suite des chapitres). Le style en ligne
    // existant est conservé comme repli : il garantit la bordure même
    // si la feuille de style de la page n'est pas chargée (impression,
    // client mail, page légale servie sans CSS).
    sections.push(
      `<section class="legal-guarantee-encadre" style="border:2px solid #444;padding:12px 16px;margin:12px 0;"><h2 class="cgv-encadre-heading">${escapeHtml(
        heading
      )}</h2>${body}</section>`
    );
  }

  pushFixedSection(sections, chapters, "Responsabilité", template.liability_clause);
  pushFixedSection(sections, chapters, "Force majeure", template.force_majeure_clause);
  // Section 24 -- données personnelles. Deliberately a single fixed
  // template string, no interpolation of any dynamic retention-day
  // count -- this lot never invents a number of days (see mandate).
  pushFixedSection(sections, chapters, "Données personnelles", template.personal_data_clause);

  // Section 25 (GENERIC_FIXED) -- loi applicable (the ONLY section
  // that states which law governs, as of template version 3 -- see
  // that template row's own header for the v2.2 dedup fix).
  pushFixedSection(sections, chapters, "Loi applicable", template.applicable_law_clause);

  // Section 26 (GENERIC_FIXED) -- juridiction compétente / dispositions
  // impératives. v2.2 -- heading renamed from "Droit applicable" (a
  // near-synonym of section 25's "Loi applicable", genuinely confusable)
  // to "Juridiction compétente", UNIVERSALLY for every template
  // version -- a pure label change, zero effect on which text is
  // shown. The CONTENT fix (no longer restating governing law, never
  // designating an exclusive forum that would restrict a consumer's
  // right to sue in their own domicile's courts) lives in
  // FR_FOOD_PERISHABLE_B2C template version 3's jurisdiction_clause
  // string only -- template versions 1/2 keep their own unchanged text
  // under this same, now-clearer heading.
  sections.push(chapters.section("Juridiction compétente", `<p>${escapeHtml(template.jurisdiction_clause)}</p>`));

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
