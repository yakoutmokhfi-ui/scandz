import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCgv, type CgvTemplateControlledSections } from "../lib/legal/render.ts";

// ====================================================================
// SELLER LEGAL PROFILE + CGV ENGINE v1 -- lib/legal/render.ts.
// Fonction PURE (aucune dépendance Supabase/réseau) : testable
// directement par `npm test`, même patron que
// lib/services/order-error.ts / tests/v65-order-note.test.ts.
// ====================================================================

const TEMPLATE: CgvTemplateControlledSections = {
  header: "Conditions Générales de Vente",
  identity_intro: "Les présentes conditions régissent les commandes.",
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause EXEMPT_PERISHABLE.",
    STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.",
    MIXED: null,
  },
  mediator_clause: "Médiateur :",
  preparation_clause: "Délai de préparation indicatif.",
  cancellation_clause_label: "Politique d'annulation",
  substitution_clause_label: "Politique de substitution",
  jurisdiction_clause: "Droit applicable du pays d'établissement.",
};

const LEGAL = {
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

const BUSINESS = {
  withdrawalRegime: "EXEMPT_PERISHABLE" as const,
  preparationTimeMin: 15,
  preparationTimeMax: 25,
  preparationTimeUnit: "MINUTES" as const,
  cancellationPolicyText: "Annulation possible avant préparation.",
  substitutionPolicyText: "Substitution équivalente si rupture.",
};

test("renderCgv: déterministe -- mêmes entrées, même sortie caractère pour caractère, à chaque appel", () => {
  const input = { sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: BUSINESS, locale: "fr", presentationVariant: "FORMAL" as const };
  const a = renderCgv(input);
  const b = renderCgv(input);
  assert.equal(a, b);
});

test("renderCgv: le contenu rendu contient la clause EXACTE du régime de rétractation choisi", () => {
  const out = renderCgv({ sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: BUSINESS, locale: "fr", presentationVariant: "FORMAL" });
  assert.match(out, /Clause EXEMPT_PERISHABLE\./);
  assert.doesNotMatch(out, /Clause STANDARD_14_DAYS\./);
});

test("renderCgv: changer uniquement le régime de rétractation change le contenu rendu (et donc son hash)", () => {
  const a = renderCgv({ sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: BUSINESS, locale: "fr", presentationVariant: "FORMAL" });
  const b = renderCgv({ sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: { ...BUSINESS, withdrawalRegime: "STANDARD_14_DAYS" }, locale: "fr", presentationVariant: "FORMAL" });
  assert.notEqual(a, b);
});

test("renderCgv: MIXED (ou tout régime sans clause résolue dans ce gabarit) échoue FERMÉ -- jamais une clause vide/silencieuse", () => {
  assert.throws(() => {
    renderCgv({ sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: { ...BUSINESS, withdrawalRegime: "MIXED" }, locale: "fr", presentationVariant: "FORMAL" });
  }, /SCANYM_CGV_RENDER/);
});

test("renderCgv: la variante de présentation ne modifie JAMAIS les clauses légales-cœur (rétractation, médiateur, juridiction) -- ton uniquement", () => {
  const formal = renderCgv({ sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: BUSINESS, locale: "fr", presentationVariant: "FORMAL" });
  const warm = renderCgv({ sellerName: "Resto A", template: TEMPLATE, legal: LEGAL, business: BUSINESS, locale: "fr", presentationVariant: "WARM" });
  const extractClause = (s: string) => s.match(/Clause EXEMPT_PERISHABLE\./)?.[0];
  assert.equal(extractClause(formal), extractClause(warm));
  assert.match(warm, /Nous sommes ravis/);
  assert.doesNotMatch(formal, /Nous sommes ravis/);
});

test("renderCgv: échappe le HTML des champs marchand (aucune injection de balise depuis un champ texte libre)", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE,
    legal: { ...LEGAL, legalForm: "<script>alert(1)</script>" },
    business: BUSINESS,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
});

// ====================================================================
// v1.1 -- AUDIT REMEDIATION (Catimini, Blocker 1, CGV-V1-PUBLISH-
// AUTHORITY-01) -- "Add tests including direct malicious inputs such
// as: <img src=x onerror=alert(1)>, <script>alert(1)</script>,
// event-handler attributes, javascript: URLs where relevant."
//
// renderCgv() is the ONE function in the entire project that produces
// content destined to become the authoritative published CGV body
// (see lib/server/legal-cgv-publish-service.ts) -- every merchant
// text field passes through `escapeHtml()` unconditionally, and the
// renderer never places any field inside an HTML attribute (only ever
// inside element text content), so an event-handler-attribute payload
// has no attribute context to break out into even before escaping.
// ====================================================================

const MALICIOUS_PAYLOADS: Record<string, string> = {
  imgOnerror: '<img src=x onerror=alert(1)>',
  scriptTag: '<script>alert(1)</script>',
  eventHandlerAttribute: '" onmouseover="alert(1)" x="',
  javascriptUrl: 'javascript:alert(1)',
};

function assertNeverExecutable(out: string, payload: string, label: string) {
  // Aucune balise ouvrante active (échappée -> "&lt;img"/"&lt;script",
  // jamais "<img"/"<script" en clair) -- vrai pour TOUS les payloads,
  // qu'ils contiennent ou non des caractères échappables.
  assert.doesNotMatch(out, /<img\b/i, `${label}: aucune balise <img> active`);
  assert.doesNotMatch(out, /<script\b/i, `${label}: aucune balise <script> active`);
  // Jamais placé dans un contexte d'attribut HTML actif (renderCgv ne
  // place jamais un champ marchand à l'intérieur d'un attribut,
  // uniquement dans du contenu texte) -- donc jamais suivi d'un "="
  // d'attribut actif juste après une balise ouvrante non échappée.
  assert.doesNotMatch(out, /<[a-z]+[^>]*\s(onerror|onmouseover|onload|onclick)\s*=/i, `${label}: aucun attribut d'évènement actif`);
  assert.doesNotMatch(out, /\shref\s*=\s*["']?javascript:/i, `${label}: jamais une URL javascript: dans un attribut href actif`);
  // Un payload contenant au moins un caractère échappable (<, >, ", ')
  // ne doit JAMAIS apparaître tel quel : il doit ressortir échappé.
  // Un payload SANS caractère échappable (ex. "javascript:alert(1)"
  // seul, sans balise/attribut autour) n'a rien à échapper -- il
  // ressort en clair comme texte inerte, ce qui est le comportement
  // SÛR attendu (couvert séparément par le test "mediatorWebsite
  // n'est jamais rendu comme lien cliquable" ci-dessous, qui prouve
  // qu'aucun attribut href n'existe pour lui donner un sens actif).
  if (/[<>"']/.test(payload)) {
    assert.ok(!out.includes(payload), `${label}: le payload brut ne doit jamais apparaître tel quel (contient des caractères échappables)`);
  }
}

for (const [label, payload] of Object.entries(MALICIOUS_PAYLOADS)) {
  test(`renderCgv: payload malveillant (${label}) dans legalForm ne devient jamais exécutable`, () => {
    const out = renderCgv({
      sellerName: "Resto A",
      template: TEMPLATE,
      legal: { ...LEGAL, legalForm: payload },
      business: BUSINESS,
      locale: "fr",
      presentationVariant: "FORMAL",
    });
    assertNeverExecutable(out, payload, `legalForm/${label}`);
  });

  test(`renderCgv: payload malveillant (${label}) dans mediatorName ne devient jamais exécutable`, () => {
    const out = renderCgv({
      sellerName: "Resto A",
      template: TEMPLATE,
      legal: { ...LEGAL, mediatorName: payload },
      business: BUSINESS,
      locale: "fr",
      presentationVariant: "FORMAL",
    });
    assertNeverExecutable(out, payload, `mediatorName/${label}`);
  });

  test(`renderCgv: payload malveillant (${label}) dans cancellationPolicyText ne devient jamais exécutable`, () => {
    const out = renderCgv({
      sellerName: "Resto A",
      template: TEMPLATE,
      legal: LEGAL,
      business: { ...BUSINESS, cancellationPolicyText: payload },
      locale: "fr",
      presentationVariant: "FORMAL",
    });
    assertNeverExecutable(out, payload, `cancellationPolicyText/${label}`);
  });

  test(`renderCgv: payload malveillant (${label}) dans addressLine1 ne devient jamais exécutable`, () => {
    const out = renderCgv({
      sellerName: "Resto A",
      template: TEMPLATE,
      legal: { ...LEGAL, addressLine1: payload },
      business: BUSINESS,
      locale: "fr",
      presentationVariant: "FORMAL",
    });
    assertNeverExecutable(out, payload, `addressLine1/${label}`);
  });
}

test("renderCgv: mediatorWebsite n'est jamais rendu comme lien cliquable (href) -- un payload javascript: reste du texte inerte, jamais une navigation", () => {
  const out = renderCgv({
    sellerName: "Resto A",
    template: TEMPLATE,
    legal: { ...LEGAL, mediatorWebsite: "javascript:alert(1)" },
    business: BUSINESS,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(out, /<a\s/i);
  assert.doesNotMatch(out, /href\s*=/i);
});
