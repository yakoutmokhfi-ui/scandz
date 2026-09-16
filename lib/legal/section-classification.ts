/**
 * CGV ENGINE ENRICHMENT v2 -- section classification map.
 *
 * DOCUMENTATION/TESTABILITY ARTIFACT ONLY -- this file changes no
 * rendering behavior whatsoever. It exists so tests (and future
 * reviewers) can assert, by a single stable name, which of four kinds
 * a given rendered CGV section is:
 *
 *   - GENERIC_FIXED: Scanym-authored text, always the same for every
 *     merchant, rendered unconditionally whenever the template
 *     provides the corresponding key (a v1 template that lacks a v2
 *     key simply omits that section -- never an error, never
 *     placeholder text).
 *   - GENERIC_CONDITIONAL: Scanym-authored text, but rendered only when
 *     a merchant-configured SELECTOR (withdrawal regime, cold-chain
 *     toggle, weight-pricing mode) resolves to a specific value. The
 *     TEXT itself is still Scanym's, never merchant-authored.
 *   - MERCHANT_VALUE: the section interpolates the merchant's own
 *     factual/structured data (legal identity, SIREN/SIRET/VAT,
 *     mediator identity, preparation time) into otherwise fixed
 *     surrounding text -- never merchant-authored free text.
 *   - MERCHANT_POLICY: the section is the merchant's OWN free-text
 *     policy (cancellation, substitution), with a Scanym-authored
 *     fallback used only when the merchant has not supplied one.
 *
 * The mandate's own narrative groups sections by number (e.g. "Section
 * 2 (seller identification)", "Sections 13/14 (cold chain)") to
 * describe expected rendering BEHAVIOR -- it does not mandate an exact
 * canonical 1-26 numbering independent of that behavioral description.
 * This file defines ITS OWN definitive, stable set of 26 semantic keys
 * (documented below, each with the section heading `renderCgv` renders
 * it under) satisfying every explicitly-specified numbered behavior in
 * the mandate (seller identification = MERCHANT_VALUE; portion pricing
 * = GENERIC_CONDITIONAL; cold chain (both sub-clauses) =
 * GENERIC_CONDITIONAL; withdrawal = GENERIC_CONDITIONAL; cancellation/
 * substitution = MERCHANT_POLICY; every other numbered/unnumbered
 * clause enumerated in the mandate's "sections 1/3/5/6/7/8/9/11/12/19/
 * 20/21/22/23/25/26" list = GENERIC_FIXED) -- see each entry's own
 * comment for the exact mandate cross-reference.
 */

export type CgvSectionClassification = "GENERIC_FIXED" | "GENERIC_CONDITIONAL" | "MERCHANT_VALUE" | "MERCHANT_POLICY";

export interface CgvSectionClassificationEntry {
  classification: CgvSectionClassification;
  /** The `<h2>` heading `renderCgv` renders this section under (for
   *  cross-reference only -- never asserted verbatim by a test, since
   *  headings are prose and may still evolve). */
  heading: string;
  /** One-line rationale, referencing the exact mandate behavior this
   *  classification satisfies. */
  note: string;
}

/**
 * All 26 mandate CGV sections, keyed by a stable semantic name.
 * `CGV_SECTION_CLASSIFICATION.cold_chain` is the canonical example the
 * v2 mandate itself gives for how this map is meant to be consumed.
 */
export const CGV_SECTION_CLASSIFICATION: Record<string, CgvSectionClassificationEntry> = {
  header: {
    classification: "GENERIC_FIXED",
    heading: "(document title)",
    note: "Mandate's generic-fixed list (section 1) -- Scanym's own title, identical for every merchant.",
  },
  seller_identity: {
    classification: "MERCHANT_VALUE",
    heading: "Identité du vendeur",
    note: "Mandate section 2 -- interpolates the merchant's own legal_entity_name/trade name/legal_form/address/SIREN/SIRET/VAT.",
  },
  purpose_scope: {
    classification: "GENERIC_FIXED",
    heading: "Objet et champ d'application",
    note: "Mandate's generic-fixed list (section 3) -- purpose_scope_clause, identical for every merchant.",
  },
  portion_pricing: {
    classification: "GENERIC_CONDITIONAL",
    heading: "Poids et prix des portions",
    note: "Mandate section 4 -- rendered only when weight_pricing_mode = FIXED_PORTION_PRICE; ACTUAL_WEIGHT_PRICE fails closed (ActualWeightPriceUnsupportedError), null renders nothing.",
  },
  products_characteristics: {
    classification: "GENERIC_FIXED",
    heading: "Caractéristiques des produits",
    note: "Mandate's generic-fixed list (section 5).",
  },
  prices_taxes: {
    classification: "GENERIC_FIXED",
    heading: "Prix et taxes",
    note: "Mandate's generic-fixed list (section 6).",
  },
  ordering_process: {
    classification: "GENERIC_FIXED",
    heading: "Processus de commande",
    note: "Mandate's generic-fixed list (section 7).",
  },
  contract_formation: {
    classification: "GENERIC_FIXED",
    heading: "Formation du contrat",
    note: "Mandate's generic-fixed list (section 8).",
  },
  payment: {
    classification: "GENERIC_FIXED",
    heading: "Paiement",
    note: "Mandate's generic-fixed list (section 9).",
  },
  availability: {
    classification: "GENERIC_FIXED",
    heading: "Disponibilité des produits",
    note: "Scanym-authored, identical for every merchant -- availability_clause.",
  },
  preparation: {
    classification: "MERCHANT_VALUE",
    heading: "Délai de préparation",
    note: "Mandate's generic-fixed list (section 11) names this position, but the rendered text interpolates the merchant's own preparation_time_min/max -- classified MERCHANT_VALUE, same reasoning as seller_identity.",
  },
  pickup: {
    classification: "GENERIC_FIXED",
    heading: "Retrait de la commande",
    note: "Mandate's generic-fixed list (section 12).",
  },
  delivery: {
    classification: "GENERIC_FIXED",
    heading: "Livraison",
    note: "Scanym-authored, identical for every merchant -- delivery_clause.",
  },
  cold_chain: {
    classification: "GENERIC_CONDITIONAL",
    heading: "Chaîne du froid",
    note: "Mandate sections 13/14 -- rendered (both sub-clauses together) only when cold_chain_applicable = true.",
  },
  withdrawal: {
    classification: "GENERIC_CONDITIONAL",
    heading: "Droit de rétractation",
    note: "Mandate sections 15/16 -- withdrawal_clauses[regime], unchanged v1 logic; the v2 EXEMPT_PERISHABLE string now carries its own coexistence caveat.",
  },
  withdrawal_exception_caveat: {
    classification: "GENERIC_CONDITIONAL",
    heading: "Droit de rétractation",
    note: "Mandate sections 15/16 (paired with `withdrawal` above) -- the coexistence-caveat sentence now baked into the v2 EXEMPT_PERISHABLE string itself (never a separate template key or a separate rendered paragraph), documented here as its own classified concept per the mandate's explicit two-number framing for the withdrawal area.",
  },
  withdrawal_exercise_method: {
    classification: "GENERIC_CONDITIONAL",
    heading: "Droit de rétractation",
    note: "CGV ENGINE v2.4 -- legal-correctness remediation (statutory online-withdrawal-function disclosure). Scanym-authored, merchant-agnostic text (withdrawal_exercise_method_clause, OPTIONAL) stating the withdrawal right can currently be exercised by any unambiguous means and that a dedicated online function is not yet available. Rendered ONLY when business.withdrawalRegime === STANDARD_14_DAYS (the only regime with a real withdrawal right) -- NEVER for EXEMPT_PERISHABLE, even if a template happened to provide the key.",
  },
  withdrawal_model_form: {
    classification: "GENERIC_CONDITIONAL",
    heading: "Droit de rétractation",
    note: "CGV ENGINE v2.4 -- the standard/model withdrawal form (formulaire type de rétractation), generic and non-merchant-specific (withdrawal_model_form_text, OPTIONAL). Same STANDARD_14_DAYS-only gate as withdrawal_exercise_method above -- NEVER rendered for EXEMPT_PERISHABLE.",
  },
  complaint_before_mediation: {
    classification: "GENERIC_FIXED",
    heading: "Médiation de la consommation",
    note: "CGV ENGINE v2.2 mandate item 3 -- Scanym-authored, merchant-agnostic instruction (complaint_before_mediation_clause, OPTIONAL) rendered as a LEADING paragraph in the same section as `mediator` below, BEFORE the merchant's own mediator identity paragraph: contact the merchant/customer service first and attempt an amicable resolution, THEN (only if unresolved) the designated consumer mediator. Absent on a v1/v2 template -> no leading paragraph, section unchanged.",
  },
  mediator: {
    classification: "MERCHANT_VALUE",
    heading: "Médiation de la consommation",
    note: "Interpolates the merchant's own mediator name/address/website/phone/email into Scanym's fixed mediator_clause text. Paired with `complaint_before_mediation` above (same section, same heading) -- mediator_clause's own text is unchanged by v2.2.",
  },
  cancellation: {
    classification: "MERCHANT_POLICY",
    heading: "Politique d'annulation",
    note: "Mandate sections 17/18 -- always renders the generic intro, then the merchant's own cancellation_policy_text, else the template's fallback text.",
  },
  substitution: {
    classification: "MERCHANT_POLICY",
    heading: "Politique de substitution de produit",
    note: "Mandate sections 17/18 -- same pattern as cancellation, for substitution_policy_text.",
  },
  complaints: {
    classification: "GENERIC_FIXED",
    heading: "Réclamations",
    note: "Mandate's generic-fixed list (section 19).",
  },
  legal_guarantees: {
    classification: "GENERIC_FIXED",
    heading: "Garanties légales",
    note: "Mandate's generic-fixed list (section 20).",
  },
  legal_guarantee_encadre: {
    classification: "GENERIC_FIXED",
    heading: "Garantie légale de conformité et garantie des vices cachés (article D. 211-2 du Code de la consommation)",
    note: "CGV ENGINE v2.5 (Task 1) -- the mandatory official encadré required by article D.211-2 (Annexe, Section A) of the Code de la consommation, exact-verbatim statutory text, rendered as its OWN distinct bordered block (class=\"legal-guarantee-encadre\") immediately after `legal_guarantees` above. Scanym-authored in the sense that it is a fixed, non-negotiable statutory model text, identical for every merchant subject to L.217-1 -- never merchant-configurable, never conditioned on withdrawal_regime (orthogonal legal regime -- see lib/legal/render.ts's own v2.5 header note).",
  },
  liability: {
    classification: "GENERIC_FIXED",
    heading: "Responsabilité",
    note: "Mandate's generic-fixed list (section 21).",
  },
  force_majeure: {
    classification: "GENERIC_FIXED",
    heading: "Force majeure",
    note: "Mandate's generic-fixed list (section 22).",
  },
  personal_data: {
    classification: "GENERIC_FIXED",
    heading: "Données personnelles",
    note: "Mandate section 23, named explicitly -- fixed text, deliberately never interpolates any specific retention-day count.",
  },
  applicable_law: {
    classification: "GENERIC_FIXED",
    heading: "Loi applicable",
    note: "Mandate's generic-fixed list (section 25) -- the ONLY section that states which law governs, as of FR_FOOD_PERISHABLE_B2C template version 3 (CGV ENGINE v2.2 dedup fix -- see that template row's own header). Byte-identical text across v2 and v3.",
  },
  jurisdiction: {
    classification: "GENERIC_FIXED",
    heading: "Juridiction compétente",
    note: "Mandate's generic-fixed list (section 26) -- competent court/venue + preservation of mandatory consumer-protection provisions. CGV ENGINE v2.2: heading renamed from \"Droit applicable\" (near-synonym of section 25's heading, genuinely confusable) to \"Juridiction compétente\", universally for every template version (pure label change). Template version 3's jurisdiction_clause CONTENT is also rewritten to stop restating governing law and to never designate an exclusive forum overriding a consumer's statutory right to sue in their own domicile's courts -- versions 1/2 keep their own prior text, now under this same clearer heading.",
  },
};

/** Convenience export for tests that want the flat list of keys. */
export const CGV_SECTION_KEYS = Object.keys(CGV_SECTION_CLASSIFICATION);
