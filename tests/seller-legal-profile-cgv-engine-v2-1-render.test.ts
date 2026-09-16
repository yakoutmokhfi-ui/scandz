import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCgv,
  ActualWeightPriceUnsupportedError,
  type CgvTemplateControlledSections,
  type LegalProfileForRender,
  type CgvBusinessConditionsForRender,
} from "../lib/legal/render.ts";
import { CGV_SECTION_CLASSIFICATION, CGV_SECTION_KEYS } from "../lib/legal/section-classification.ts";

// renderCgv HTML-escapes every interpolated string (see escapeHtml in
// lib/legal/render.ts) -- literal clause text containing an apostrophe
// therefore comes out as `&#39;`, never a raw `'`. This helper mirrors
// that exact transform so assertions can compare against the ACTUAL
// escaped output, rather than the raw source text.
function escapedText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function escapedTextAsPattern(value: string): RegExp {
  return new RegExp(escapedText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

// ====================================================================
// CGV ENGINE ENRICHMENT v2 -- tests A-H (+ the fail-closed
// ACTUAL_WEIGHT_PRICE test) of the v2.1 deliverable, exercised as pure
// unit tests of renderCgv() (no Supabase/network dependency, same
// pattern as tests/seller-legal-profile-cgv-engine-v1-render.test.ts).
// Tests I (multi-tenant isolation), J (preview->publish->immutable
// version), K/L (old/new order snapshots), M (public route) are
// orchestration/SQL-level properties, covered by
// supabase/tests/seller-legal-profile-cgv-engine-v2-1-check.sh instead
// -- see that harness. Test N (existing tests remain green) = the full
// regression run reported alongside this package.
// ====================================================================

// The v1 subset of the template -- every v2 test below extends this,
// never replaces it, so any test that relies on a v2-only key being
// ABSENT can still build a valid, minimal template.
const V1_TEMPLATE_SUBSET = {
  header: "Conditions Générales de Vente",
  identity_intro: "Les présentes conditions régissent les commandes.",
  withdrawal_clauses: {
    EXEMPT_PERISHABLE:
      "Conformément à l'article L221-28 3° du Code de la consommation, le droit de rétractation ne s'applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement. Cette exclusion ne s'applique qu'aux produits susceptibles de se détériorer ou de se périmer rapidement ; les autres produits éventuellement proposés par le Vendeur, non concernés par cette exclusion légale, demeurent soumis au régime de rétractation qui leur est applicable.",
    STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.",
    MIXED: null,
  },
  mediator_clause: "Médiateur :",
  preparation_clause: "Délai de préparation indicatif.",
  cancellation_clause_label: "Politique d'annulation",
  substitution_clause_label: "Politique de substitution",
  jurisdiction_clause:
    "Les présentes conditions sont soumises au droit applicable dans le pays d'établissement du vendeur. Les dispositions impératives protectrices du consommateur prévues par la loi applicable au lieu de résidence habituelle du Client demeurent applicables et ne peuvent être écartées par les présentes CGV.",
} satisfies Pick<
  CgvTemplateControlledSections,
  | "header"
  | "identity_intro"
  | "withdrawal_clauses"
  | "mediator_clause"
  | "preparation_clause"
  | "cancellation_clause_label"
  | "substitution_clause_label"
  | "jurisdiction_clause"
>;

// The FULL v2 template -- every new key populated, mirroring
// DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql's seeded content
// (paraphrased slightly shorter for test fixture clarity, except the
// two clauses under direct assertion below, which are copied verbatim).
const TEMPLATE_V2: CgvTemplateControlledSections = {
  ...V1_TEMPLATE_SUBSET,
  purpose_scope_clause: "Les présentes CGV régissent les ventes à distance de produits alimentaires via Scanym.",
  products_characteristics_clause: "Les caractéristiques essentielles des produits sont présentées sur leur fiche.",
  portion_pricing_clauses: {
    FIXED_PORTION_PRICE:
      "Certains produits peuvent être préparés ou découpés à la demande. Le poids indiqué correspond à une portion approximative et peut varier légèrement en raison de la préparation ou de la découpe. Le prix affiché et accepté lors de la validation de la commande est fixe et ne fait l'objet d'aucun recalcul en fonction de cette légère variation de poids.",
  },
  prices_taxes_clause: "Les prix sont indiqués en euros TTC.",
  ordering_process_clause: "Le Client sélectionne ses produits puis valide sa commande.",
  contract_formation_clause: "La commande est réputée conclue lors de sa confirmation.",
  payment_clause: "Le règlement s'effectue en ligne au moment de la commande.",
  availability_clause: "Les produits sont proposés dans la limite des stocks disponibles.",
  pickup_clause: "Le Client est informé du lieu et du créneau de retrait.",
  delivery_clause: "La commande est acheminée selon les modalités présentées avant validation.",
  cold_chain_clauses: {
    transport:
      "Certains produits vendus par le Vendeur nécessitent d'être maintenus à température dirigée (chaîne du froid) afin de préserver leur qualité et leur sécurité sanitaire.",
    post_handover:
      "À compter de la remise de la commande au Client, il appartient à ce dernier de respecter les conditions de conservation indiquées.",
  },
  cancellation_clause_intro: "L'annulation reste possible tant que la préparation n'a pas débuté.",
  cancellation_clause_fallback: "Le Vendeur n'a pas encore renseigné de politique d'annulation spécifique.",
  substitution_clause_intro: "Aucun produit de substitution significativement différent n'est réputé accepté.",
  substitution_clause_fallback: "Le Vendeur n'a pas encore renseigné de politique de substitution spécifique.",
  complaints_clause: "Le Client est invité à signaler toute anomalie dans les meilleurs délais.",
  legal_guarantees_clause: "Le Client bénéficie des garanties légales de conformité et contre les vices cachés.",
  liability_clause: "Le Vendeur n'est responsable que dans les limites prévues par la loi.",
  force_majeure_clause: "Aucune partie n'est responsable en cas de force majeure.",
  personal_data_clause:
    "Les données personnelles du Client sont traitées par Scanym et/ou le Vendeur. Scanym met en œuvre des mesures de suppression ou d'anonymisation périodique au-delà d'une durée définie dans sa politique de gestion des données.",
  applicable_law_clause: "Les présentes CGV sont soumises au droit applicable dans le pays de rattachement du Vendeur.",
};

const LEGAL_BASE: LegalProfileForRender = {
  legalForm: "SARL",
  addressLine1: "1 rue Test",
  addressLine2: null,
  postalCode: "75001",
  city: "Paris",
  governingCountry: "FR",
  customerServiceEmail: "contact@test.local",
  customerServicePhone: null,
  mediatorName: "Médiateur Test",
  mediatorAddress: "2 rue Médiation",
  mediatorWebsite: "https://mediateur.test",
};

const BUSINESS_BASE: CgvBusinessConditionsForRender = {
  withdrawalRegime: "EXEMPT_PERISHABLE",
  preparationTimeMin: 15,
  preparationTimeMax: 25,
  preparationTimeUnit: "MINUTES",
  cancellationPolicyText: "Annulation possible avant préparation.",
  substitutionPolicyText: "Substitution équivalente si rupture.",
};

// Au Lait Cru / MANUYUAN -- the exact fixture data specified by the v2
// mandate (see the SQL harness's own [AU-LAIT-CRU] section for the
// full-fidelity database fixture; this is the render-layer subset).
const AU_LAIT_CRU_LEGAL: LegalProfileForRender = {
  legalForm: "SARL",
  addressLine1: "114 rue Ordener",
  addressLine2: null,
  postalCode: "75018",
  city: "Paris",
  governingCountry: "FR",
  customerServiceEmail: "contact@aulaitcru.com",
  customerServicePhone: null,
  mediatorName: "CM2C",
  mediatorAddress: "49 rue de Ponthieu, 75008 Paris, France",
  mediatorWebsite: "https://www.cm2c.net/declarer-un-litige.php",
  legalEntityName: "MANUYUAN",
  siren: "842925513",
  siret: "84292551300025",
  vatNumber: "FR34842925513",
  mediatorPhone: "01 89 47 00 14",
  mediatorEmail: "litiges@cm2c.net",
};

const AU_LAIT_CRU_BUSINESS: CgvBusinessConditionsForRender = {
  withdrawalRegime: "EXEMPT_PERISHABLE",
  preparationTimeMin: 3,
  preparationTimeMax: 6,
  preparationTimeUnit: "HOURS",
  cancellationPolicyText: null, // deliberately not supplied -- fallback expected
  substitutionPolicyText: null, // deliberately not supplied -- fallback expected
  coldChainApplicable: true,
  weightPricingMode: "FIXED_PORTION_PRICE",
};

function renderAuLaitCru(): string {
  return renderCgv({
    sellerName: "Au Lait Cru",
    template: TEMPLATE_V2,
    legal: AU_LAIT_CRU_LEGAL,
    business: AU_LAIT_CRU_BUSINESS,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
}

// --------------------------------------------------------------------
// Test A -- generic template renders all expected new sections.
// --------------------------------------------------------------------
test("A. renderCgv (v2 template, generic fixed sections): every new GENERIC_FIXED clause is rendered when present", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });

  for (const text of [
    TEMPLATE_V2.purpose_scope_clause,
    TEMPLATE_V2.products_characteristics_clause,
    TEMPLATE_V2.prices_taxes_clause,
    TEMPLATE_V2.ordering_process_clause,
    TEMPLATE_V2.contract_formation_clause,
    TEMPLATE_V2.payment_clause,
    TEMPLATE_V2.availability_clause,
    TEMPLATE_V2.pickup_clause,
    TEMPLATE_V2.delivery_clause,
    TEMPLATE_V2.complaints_clause,
    TEMPLATE_V2.legal_guarantees_clause,
    TEMPLATE_V2.liability_clause,
    TEMPLATE_V2.force_majeure_clause,
    TEMPLATE_V2.personal_data_clause,
    TEMPLATE_V2.applicable_law_clause,
  ]) {
    assert.ok(text, "fixture clause text must be defined");
    assert.match(out, escapedTextAsPattern(text as string), `expected clause missing from rendered output: ${text}`);
  }
});

test("A2. renderCgv (v1 template, no v2 keys): output is byte-identical in shape to v1 -- no v2 section renders, no error", () => {
  const out = renderCgv({
    sellerName: "Resto Legacy",
    template: V1_TEMPLATE_SUBSET as CgvTemplateControlledSections,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  for (const heading of [
    "Objet et champ d'application",
    "Prix et taxes",
    "Réclamations",
    "Loi applicable",
    "Chaîne du froid",
    "Poids et prix des portions",
  ]) {
    assert.ok(!out.includes(`<h2>${heading}</h2>`), `v1 template must not render the v2-only section "${heading}"`);
  }
});

// --------------------------------------------------------------------
// Test B -- merchant identity injection incl. SIREN/SIRET/VAT/
// legal_entity_name.
// --------------------------------------------------------------------
test("B. renderCgv: legal_entity_name + trade name + SIREN/SIRET/VAT all rendered when present", () => {
  const out = renderCgv({
    sellerName: "Au Lait Cru",
    template: TEMPLATE_V2,
    legal: AU_LAIT_CRU_LEGAL,
    business: AU_LAIT_CRU_BUSINESS,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.match(out, /MANUYUAN/);
  assert.match(out, /Au Lait Cru/);
  assert.match(out, /SIREN\s*:\s*842925513/);
  assert.match(out, /SIRET\s*:\s*84292551300025/);
  assert.match(out, /FR34842925513/);
});

test("B2. renderCgv: legal_entity_name absent -- falls back to the trade name alone, no error, no 'null'/'undefined' text", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE, // no legalEntityName/siren/siret/vatNumber
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.match(out, /Resto A/);
  assert.doesNotMatch(out, /SIREN/);
  assert.doesNotMatch(out, /SIRET/);
  assert.doesNotMatch(out, /null/i);
  assert.doesNotMatch(out, /undefined/i);
});

// --------------------------------------------------------------------
// Test C -- Au Lait Cru fixed-portion-price wording present + no
// recalculation claim.
// --------------------------------------------------------------------
test("C. renderCgv (Au Lait Cru): fixed-portion-price wording present, no post-order recalculation claim", () => {
  const out = renderAuLaitCru();
  assert.match(out, escapedTextAsPattern("prix affiché et accepté lors de la validation de la commande est fixe"));
  assert.match(out, escapedTextAsPattern("ne fait l'objet d'aucun recalcul"));
  // No recalculation-implying phrase anywhere in the output: the only
  // occurrence of "recalcul" must be inside the "aucun recalcul" (no
  // recalculation) phrase asserted above, never a standalone claim
  // that the price WILL be recalculated.
  assert.ok(!/prix\s+(sera|est)\s+recalcul/i.test(out), "must never claim the price will be recalculated");
  const recalcOccurrences = out.match(/recalcul\w*/gi) ?? [];
  for (const occurrence of recalcOccurrences) {
    const idx = out.indexOf(occurrence);
    const surrounding = out.slice(Math.max(0, idx - 20), idx);
    assert.match(surrounding, /aucun\s*$/i, `unexpected standalone "recalcul" occurrence not part of "aucun recalcul": ...${surrounding}${occurrence}`);
  }
});

// --------------------------------------------------------------------
// Test D -- perishable withdrawal exception rendered + coexistence
// caveat present.
// --------------------------------------------------------------------
test("D. renderCgv: EXEMPT_PERISHABLE withdrawal clause includes the v2 coexistence caveat", () => {
  const out = renderAuLaitCru();
  assert.match(out, escapedTextAsPattern("le droit de rétractation ne s'applique pas aux denrées périssables"));
  assert.match(
    out,
    escapedTextAsPattern(
      "les autres produits éventuellement proposés par le Vendeur, non concernés par cette exclusion légale, demeurent soumis au régime de rétractation"
    )
  );
});

// --------------------------------------------------------------------
// Test E -- cold-chain clause present when enabled / absent when
// disabled.
// --------------------------------------------------------------------
test("E. renderCgv: cold-chain clauses present when coldChainApplicable = true", () => {
  const out = renderAuLaitCru();
  assert.match(out, /Chaîne du froid/);
  assert.match(out, new RegExp(TEMPLATE_V2.cold_chain_clauses!.transport.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, new RegExp(TEMPLATE_V2.cold_chain_clauses!.post_handover.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("E2. renderCgv: cold-chain clauses absent when coldChainApplicable = false", () => {
  const out = renderCgv({
    sellerName: "Resto B",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: { ...BUSINESS_BASE, coldChainApplicable: false },
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(out, /Chaîne du froid/);
});

// --------------------------------------------------------------------
// Test F -- CM2C rendered for Au Lait Cru / a different merchant
// fixture does not inherit it.
// --------------------------------------------------------------------
test("F. renderCgv (Au Lait Cru): CM2C mediator block rendered with the given address/phone/email", () => {
  const out = renderAuLaitCru();
  assert.match(out, /CM2C/);
  assert.match(out, /49 rue de Ponthieu, 75008 Paris, France/);
  assert.match(out, /01 89 47 00 14/);
  assert.match(out, /litiges@cm2c\.net/);
});

test("F2. renderCgv (a different merchant): does NOT render CM2C or Au Lait Cru's mediator contact details", () => {
  const out = renderCgv({
    sellerName: "Resto B",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE, // Médiateur Test, not CM2C
    business: { ...BUSINESS_BASE, coldChainApplicable: false, weightPricingMode: null },
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(out, /CM2C/);
  assert.doesNotMatch(out, /litiges@cm2c\.net/);
  assert.doesNotMatch(out, /01 89 47 00 14/);
});

// --------------------------------------------------------------------
// Test G -- no fabricated retention duration ever appears in
// personal_data_clause output.
// --------------------------------------------------------------------
test("G. renderCgv: personal_data_clause output never contains a fabricated day/jour retention count", () => {
  const out = renderAuLaitCru();
  assert.match(out, /Données personnelles/);
  assert.doesNotMatch(out, /\d+\s*(jours?|days?)\b/i);
});

// --------------------------------------------------------------------
// Test H -- cancellation/substitution are merchant-specific with no
// cross-tenant leakage.
// --------------------------------------------------------------------
test("H. renderCgv: cancellation/substitution fallback text used when the merchant supplied none (Au Lait Cru) -- never fabricated specific policy", () => {
  const out = renderAuLaitCru();
  assert.match(out, escapedTextAsPattern(TEMPLATE_V2.cancellation_clause_fallback!));
  assert.match(out, escapedTextAsPattern(TEMPLATE_V2.substitution_clause_fallback!));
  assert.doesNotMatch(out, /Annulation possible avant préparation\./, "must never leak another merchant's cancellation text");
});

test("H2. renderCgv: a merchant WITH its own cancellation/substitution text renders it verbatim, never the fallback", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE, // has its own cancellation/substitution text
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.match(out, /Annulation possible avant préparation\./);
  assert.match(out, /Substitution équivalente si rupture\./);
  assert.doesNotMatch(out, escapedTextAsPattern(TEMPLATE_V2.cancellation_clause_fallback!));
});

test("H3. renderCgv: two different merchant profiles never leak each other's cancellation/substitution text (no cross-tenant leakage at the render layer)", () => {
  const outAuLaitCru = renderAuLaitCru();
  const outRestoA = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(outAuLaitCru, /Annulation possible avant préparation\./);
  assert.doesNotMatch(outRestoA, escapedTextAsPattern(TEMPLATE_V2.cancellation_clause_fallback!));
});

// --------------------------------------------------------------------
// ACTUAL_WEIGHT_PRICE -- fail-closed at the render layer (the
// enforcement point for the client-side advisory preview path, which
// never reaches persist_merchant_cgv_version's own equivalent check).
// --------------------------------------------------------------------
test("ActualWeightPriceUnsupportedError thrown for weightPricingMode = ACTUAL_WEIGHT_PRICE", () => {
  assert.throws(
    () =>
      renderCgv({
        sellerName: "Resto A",
        template: TEMPLATE_V2,
        legal: LEGAL_BASE,
        business: { ...BUSINESS_BASE, weightPricingMode: "ACTUAL_WEIGHT_PRICE" },
        locale: "fr",
        presentationVariant: "FORMAL",
      }),
    (err: unknown) => err instanceof ActualWeightPriceUnsupportedError
  );
});

test("weightPricingMode = FIXED_PORTION_PRICE succeeds and renders the fixed-portion-price clause; null renders nothing for that section", () => {
  const withMode = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: { ...BUSINESS_BASE, weightPricingMode: "FIXED_PORTION_PRICE" },
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.match(withMode, /Poids et prix des portions/);

  const withoutMode = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: { ...BUSINESS_BASE, weightPricingMode: null },
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(withoutMode, /Poids et prix des portions/);
});

// --------------------------------------------------------------------
// CGV ENGINE v2.2 -- mandate item 2 (dedup) + item 3 (mediation
// restructure). TEMPLATE_V3 below extends TEMPLATE_V2 exactly the way
// DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql's seeded version-3
// row extends version 2: identical byte-for-byte `applicable_law_
// clause`, a rewritten `jurisdiction_clause` that never restates
// governing law and never designates an exclusive forum, and the new
// optional `complaint_before_mediation_clause`.
// --------------------------------------------------------------------
const TEMPLATE_V3: CgvTemplateControlledSections = {
  ...TEMPLATE_V2,
  jurisdiction_clause:
    "En cas de litige, le Client et le Vendeur s'efforcent de trouver une solution amiable. À défaut, les tribunaux compétents sont ceux désignés par les règles de droit commun applicables ; les présentes CGV ne désignent aucune juridiction exclusive et ne peuvent écarter les dispositions impératives protectrices du consommateur, notamment son droit de saisir la juridiction du lieu où il demeurait au moment de la conclusion du contrat.",
  complaint_before_mediation_clause:
    "En cas de litige, le Client est invité à contacter en priorité le service client du Vendeur afin de rechercher une solution amiable.",
};

test("v2.2 I. renderCgv: 'Loi applicable' and 'Juridiction compétente' each render as exactly one section; the old confusable 'Droit applicable' heading never renders", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V3,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.equal((out.match(/<h2>Loi applicable<\/h2>/g) ?? []).length, 1);
  assert.equal((out.match(/<h2>Juridiction compétente<\/h2>/g) ?? []).length, 1);
  assert.ok(!out.includes("<h2>Droit applicable</h2>"), "the old, confusable heading must never render");
  assert.match(out, escapedTextAsPattern(TEMPLATE_V3.applicable_law_clause as string));
  assert.match(out, escapedTextAsPattern(TEMPLATE_V3.jurisdiction_clause));
});

test("v2.2 I2. renderCgv (v1/v2 template, no v3 jurisdiction rewrite): heading is still 'Juridiction compétente' (pure label rename, applies to every template version)", () => {
  const out = renderCgv({
    sellerName: "Resto Legacy",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.ok(out.includes("<h2>Juridiction compétente</h2>"), "heading rename applies universally, not just to template v3");
  assert.ok(!out.includes("<h2>Droit applicable</h2>"));
  assert.match(out, escapedTextAsPattern(TEMPLATE_V2.jurisdiction_clause));
});

test("v2.2 J. renderCgv: complaint_before_mediation_clause renders as a LEADING paragraph, in the SAME section, BEFORE the mediator identity block", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V3,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.match(out, escapedTextAsPattern(TEMPLATE_V3.complaint_before_mediation_clause as string));
  const mediationSectionMatch = out.match(/<section><h2>Médiation de la consommation<\/h2>[\s\S]*?<\/section>/);
  assert.ok(mediationSectionMatch, "expected exactly one 'Médiation de la consommation' section");
  assert.equal((out.match(/<h2>Médiation de la consommation<\/h2>/g) ?? []).length, 1, "must render as a single section, never a duplicated one");
  const complaintIndex = out.indexOf(TEMPLATE_V3.complaint_before_mediation_clause as string);
  const mediatorNameIndex = out.indexOf(LEGAL_BASE.mediatorName as string);
  assert.ok(complaintIndex >= 0 && mediatorNameIndex >= 0);
  assert.ok(complaintIndex < mediatorNameIndex, "the amicable-resolution instruction must precede the mediator identity block");
});

test("v2.2 J2. renderCgv: complaint_before_mediation_clause ABSENT (v1/v2 template) -- section unchanged, no leading paragraph, no error", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE_V2,
    legal: LEGAL_BASE,
    business: BUSINESS_BASE,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.equal((out.match(/<h2>Médiation de la consommation<\/h2>/g) ?? []).length, 1);
  assert.match(out, escapedTextAsPattern(LEGAL_BASE.mediatorName as string));
});

test("v2.2 K. renderCgv (Au Lait Cru, template v3): amiable-resolution text precedes CM2C mediator identity; law/jurisdiction sections each render exactly once", () => {
  const out = renderCgv({
    sellerName: "Au Lait Cru",
    template: TEMPLATE_V3,
    legal: AU_LAIT_CRU_LEGAL,
    business: AU_LAIT_CRU_BUSINESS,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  const complaintIndex = out.indexOf(TEMPLATE_V3.complaint_before_mediation_clause as string);
  const cm2cIndex = out.indexOf("CM2C");
  assert.ok(complaintIndex >= 0 && cm2cIndex >= 0);
  assert.ok(complaintIndex < cm2cIndex, "amicable-resolution text must precede CM2C's own identity block");
  assert.equal((out.match(/<h2>Loi applicable<\/h2>/g) ?? []).length, 1);
  assert.equal((out.match(/<h2>Juridiction compétente<\/h2>/g) ?? []).length, 1);
});

// --------------------------------------------------------------------
// Section classification map -- documentation/testability artifact.
// --------------------------------------------------------------------
test("CGV_SECTION_CLASSIFICATION: exactly 30 keys, each with a valid classification", () => {
  // CGV ENGINE v2.2 added ONE new key (`complaint_before_mediation`) --
  // the mandate's own 26-section narrative groups sections by rendered
  // heading/behavior, not by map-entry count (see that file's header),
  // and `complaint_before_mediation` intentionally shares its heading
  // with the pre-existing `mediator` entry (same section, paired,
  // exactly like `withdrawal`/`withdrawal_exception_caveat` already
  // were before this cycle) -- so 26 mandate sections, 27 map entries.
  // CGV ENGINE v2.4 (legal-correctness remediation) added TWO more
  // keys (`withdrawal_exercise_method`, `withdrawal_model_form`) --
  // same pattern, both paired with the pre-existing `withdrawal` entry
  // (same section/heading, both GENERIC_CONDITIONAL, gated on
  // STANDARD_14_DAYS only -- see lib/legal/render.ts) -- so 27 + 2 = 29
  // map entries.
  // CGV ENGINE v2.5 (Task 1) added ONE more key
  // (`legal_guarantee_encadre`) for the mandatory D.211-2 (Annexe,
  // Section A) verbatim encadré -- rendered unconditionally
  // (orthogonal to the withdrawal regime), fixed content, hence
  // GENERIC_FIXED -- so 29 + 1 = 30 map entries now.
  assert.equal(CGV_SECTION_KEYS.length, 30);
  const valid = new Set(["GENERIC_FIXED", "GENERIC_CONDITIONAL", "MERCHANT_VALUE", "MERCHANT_POLICY"]);
  for (const key of CGV_SECTION_KEYS) {
    assert.ok(valid.has(CGV_SECTION_CLASSIFICATION[key].classification), `invalid classification for ${key}`);
  }
});

test("CGV_SECTION_CLASSIFICATION: cold_chain is GENERIC_CONDITIONAL (the mandate's own worked example)", () => {
  assert.equal(CGV_SECTION_CLASSIFICATION.cold_chain.classification, "GENERIC_CONDITIONAL");
});

test("CGV_SECTION_CLASSIFICATION: seller_identity and mediator are MERCHANT_VALUE; cancellation/substitution are MERCHANT_POLICY", () => {
  assert.equal(CGV_SECTION_CLASSIFICATION.seller_identity.classification, "MERCHANT_VALUE");
  assert.equal(CGV_SECTION_CLASSIFICATION.mediator.classification, "MERCHANT_VALUE");
  assert.equal(CGV_SECTION_CLASSIFICATION.cancellation.classification, "MERCHANT_POLICY");
  assert.equal(CGV_SECTION_CLASSIFICATION.substitution.classification, "MERCHANT_POLICY");
});
