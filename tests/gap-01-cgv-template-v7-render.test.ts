import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCgv,
  type CgvTemplateControlledSections,
  type LegalProfileForRender,
  type CgvBusinessConditionsForRender,
} from "../lib/legal/render.ts";

// ====================================================================
// GAP-01 — CGV template v7 : test de rendu AVANT/APRÈS.
//
// renderCgv() lui-même n'est PAS modifié par GAP-01 (voir
// DRAFT-lot-gap-01-cgv-template-v7.sql, préambule) : seul le CONTENU
// de `cgv_template.controlled_sections.withdrawal_acknowledgement_
// clause` change, d'une version de gabarit à l'autre. Ce test exerce
// donc directement la fonction de rendu PRODUCTION avec deux gabarits
// -- "avant" (texte v6) et "après" (texte v7, copié VERBATIM depuis
// DRAFT-lot-gap-01-cgv-template-v7.sql pour que ce test échoue si les
// deux textes divergent jamais) -- et prouve que seule cette clause
// change de rendu, jamais le reste du document.
// ====================================================================

const V6_ACK_CLAUSE =
  "Toute déclaration de rétractation effectuée au moyen de la fonctionnalité en ligne est enregistrée avec sa date et son heure, et son contenu est conservé sur un support durable. Le Vendeur adresse au Client, sur un support durable et au moyen électronique indiqué par celui-ci, un accusé de réception mentionnant le contenu de sa déclaration ainsi que la date et l'heure de celle-ci.";

// Copié VERBATIM depuis DRAFT-lot-gap-01-cgv-template-v7.sql (la
// valeur passée à to_jsonb(...) dans le jsonb_set qui construit la
// version 7) -- toute divergence future entre ce fichier et la
// migration SQL fait échouer ce test.
const V7_ACK_CLAUSE =
  "Toute déclaration de rétractation effectuée au moyen de la fonctionnalité en ligne est enregistrée avec sa date et son heure, et son contenu est conservé sur un support durable. Scanym adresse au Client, pour le compte du Vendeur, sur un support durable et au moyen électronique indiqué par celui-ci, un accusé de réception mentionnant le contenu de sa déclaration ainsi que la date et l'heure de celle-ci ; cet accusé de réception est envoyé depuis l'adresse retractation@scanym.com. Le Vendeur reçoit une copie de cet accusé de réception ainsi qu'une notification correspondante dans son interface de gestion, mentionnant notamment les produits et quantités concernés par la déclaration. Cet accusé de réception confirme la seule réception de la déclaration de rétractation ; il ne constitue pas les modalités pratiques de retour des produits concernés, que le Vendeur communique ensuite séparément au Client.";

function escapedText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const TEMPLATE_BASE = {
  header: "Conditions Générales de Vente",
  identity_intro: "Les présentes conditions régissent les commandes.",
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause EXEMPT_PERISHABLE.",
    STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.",
    MIXED: "Clause MIXED citant L221-28 et L221-18.",
  },
  mediator_clause: "Médiateur :",
  preparation_clause: "Délai de préparation indicatif.",
  cancellation_clause_label: "Politique d'annulation",
  substitution_clause_label: "Politique de substitution",
  jurisdiction_clause: "Juridiction applicable.",
  withdrawal_exercise_method_clause: "Méthode d'exercice du droit de rétractation.",
  mixed_order_withdrawal_clause: "Règle des commandes mixtes (L221-28).",
  withdrawal_return_and_refund_clause: "Renvoi et remboursement (L221-23, L221-24).",
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
  | "withdrawal_exercise_method_clause"
  | "mixed_order_withdrawal_clause"
  | "withdrawal_return_and_refund_clause"
>;

const TEMPLATE_V6: CgvTemplateControlledSections = {
  ...TEMPLATE_BASE,
  withdrawal_acknowledgement_clause: V6_ACK_CLAUSE,
};

const TEMPLATE_V7: CgvTemplateControlledSections = {
  ...TEMPLATE_BASE,
  withdrawal_acknowledgement_clause: V7_ACK_CLAUSE,
};

const LEGAL: LegalProfileForRender = {
  legalForm: "SARL",
  addressLine1: "1 rue Test",
  addressLine2: null,
  postalCode: "75001",
  city: "Paris",
  governingCountry: "FR",
  customerServiceEmail: "contact@le-gap-un.example",
  customerServicePhone: null,
  mediatorName: "Médiateur Test",
  mediatorAddress: "2 rue Médiation",
  mediatorWebsite: "https://mediateur.test",
};

const BUSINESS: CgvBusinessConditionsForRender = {
  withdrawalRegime: "STANDARD_14_DAYS",
  preparationTimeMin: 15,
  preparationTimeMax: 25,
  preparationTimeUnit: "MINUTES",
  cancellationPolicyText: "Annulation possible avant préparation.",
  substitutionPolicyText: "Substitution équivalente si rupture.",
};

function render(template: CgvTemplateControlledSections): string {
  return renderCgv({
    sellerName: "Le Gap Un",
    template,
    legal: LEGAL,
    business: BUSINESS,
    locale: "fr",
    presentationVariant: "FORMAL",
  });
}

test("CGV v6 (avant) : accuse réception mais ne mentionne NI l'expéditeur, NI la copie marchand, NI le backoffice", () => {
  const html = render(TEMPLATE_V6);
  assert.match(html, new RegExp(escapedText(V6_ACK_CLAUSE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /retractation@scanym\.com/);
  assert.doesNotMatch(html, /interface de gestion/);
});

test("CGV v7 (après) : mentionne l'expéditeur retractation@scanym.com, la copie marchand et la notification backoffice", () => {
  const html = render(TEMPLATE_V7);
  assert.match(html, new RegExp(escapedText(V7_ACK_CLAUSE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /retractation@scanym\.com/);
  assert.match(html, /interface de gestion/);
  assert.match(html, /ne constitue pas les modalités pratiques de retour/);
});

test("CGV v7 : TOUT LE RESTE du document est BYTE-IDENTIQUE à v6 -- seule la clause d'accusé de réception change", () => {
  const htmlV6 = render(TEMPLATE_V6);
  const htmlV7 = render(TEMPLATE_V7);

  const withoutAckV6 = htmlV6.replace(escapedText(V6_ACK_CLAUSE), "__ACK__");
  const withoutAckV7 = htmlV7.replace(escapedText(V7_ACK_CLAUSE), "__ACK__");
  assert.equal(withoutAckV7, withoutAckV6);
});

test("CGV v7 : EXEMPT_PERISHABLE reste exclu de la section additionnelle (aucun changement de régime par ce lot)", () => {
  // Le contenu de withdrawal_clauses.EXEMPT_PERISHABLE et le régime
  // marchand ne sont jamais touchés par GAP-01 -- vérifié ici en
  // rendant avec regime=EXEMPT_PERISHABLE : la clause d'accusé de
  // réception (droit de rétractation en ligne) ne doit alors PAS
  // apparaître, exactement comme avant ce lot.
  const htmlExempt = renderCgv({
    sellerName: "Le Gap Un",
    template: TEMPLATE_V7,
    legal: LEGAL,
    business: { ...BUSINESS, withdrawalRegime: "EXEMPT_PERISHABLE" },
    locale: "fr",
    presentationVariant: "FORMAL",
  });
  assert.doesNotMatch(htmlExempt, /retractation@scanym\.com/);
});
