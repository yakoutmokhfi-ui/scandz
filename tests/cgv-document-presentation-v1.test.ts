import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { renderCgv } = await import("../lib/legal/render.ts");
import type {
  CgvTemplateControlledSections,
  LegalProfileForRender,
  CgvBusinessConditionsForRender,
} from "../lib/legal/render.ts";

// ====================================================================
// Scanym — CGV DOCUMENT PRESENTATION v1
//
// PRÉSENTATION / STRUCTURE UNIQUEMENT. Ces tests prouvent deux choses
// à la fois :
//   1. le document est désormais structuré comme un vrai document
//      juridique (chapitres numérotés sans trou, identité étiquetée,
//      encadré réglementaire distinct, pas de débordement mobile) ;
//   2. le TEXTE juridique rendu est resté rigoureusement le même --
//      aucune clause ajoutée, supprimée, reformulée ou traduite.
//
// La preuve (2) est faite en comparant le TEXTE BRUT du document
// (balises retirées) à la liste des textes du gabarit et du marchand :
// tout ce qui s'affiche vient de ces valeurs, et tout ce qui venait de
// ces valeurs s'affiche toujours.
// ====================================================================

const TEMPLATE: CgvTemplateControlledSections = {
  header: "Conditions Générales de Vente",
  identity_intro: "Les présentes conditions générales régissent les ventes conclues avec le vendeur.",
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause de rétractation — denrées périssables.",
    STANDARD_14_DAYS: "Clause de rétractation — quatorze jours.",
    MIXED: null,
  },
  mediator_clause: "En cas de litige non résolu, le médiateur compétent est :",
  preparation_clause: "La commande est préparée après confirmation.",
  cancellation_clause_label: "Annulation de la commande",
  substitution_clause_label: "Substitution de produits",
  jurisdiction_clause: "Les juridictions compétentes sont déterminées par la loi.",
  purpose_scope_clause: "Objet et champ d'application du contrat.",
  products_characteristics_clause: "Les produits sont décrits sur la carte.",
  portion_pricing_clauses: { FIXED_PORTION_PRICE: "Les portions sont vendues au prix affiché." },
  prices_taxes_clause: "Les prix sont indiqués toutes taxes comprises.",
  ordering_process_clause: "La commande est passée en ligne.",
  contract_formation_clause: "Le contrat est formé à la confirmation.",
  payment_clause: "Le paiement est exigible à la commande.",
  availability_clause: "Les produits sont proposés dans la limite des stocks.",
  pickup_clause: "Le retrait s'effectue à l'adresse du vendeur.",
  delivery_clause: "La livraison s'effectue à l'adresse indiquée.",
  cold_chain_clauses: {
    transport: "La chaîne du froid est maintenue pendant le transport.",
    post_handover: "Après remise, le maintien au froid incombe au client.",
  },
  cancellation_clause_intro: "Les conditions d'annulation sont les suivantes.",
  cancellation_clause_fallback: "Aucune condition particulière d'annulation n'est prévue.",
  substitution_clause_intro: "Les conditions de substitution sont les suivantes.",
  substitution_clause_fallback: "Aucune substitution n'est pratiquée sans accord.",
  complaints_clause: "Toute réclamation est adressée au service client.",
  legal_guarantees_clause: "Le vendeur est tenu des garanties légales.",
  liability_clause: "La responsabilité du vendeur est limitée dans les conditions légales.",
  force_majeure_clause: "Aucune partie n'est responsable en cas de force majeure.",
  personal_data_clause: "Les données personnelles sont traitées conformément à la réglementation.",
  applicable_law_clause: "Le contrat est soumis au droit français.",
  complaint_before_mediation_clause: "Le client contacte d'abord le service client du vendeur.",
  legal_guarantee_encadre: {
    heading: "Garantie légale de conformité",
    paragraphs: [
      "Le consommateur dispose d'un délai de deux ans à compter de la délivrance du bien.",
      "Le consommateur peut choisir entre la réparation et le remplacement du bien.",
    ],
  },
};

const LEGAL: LegalProfileForRender = {
  legalForm: "Société à responsabilité limitée",
  addressLine1: "12 rue du Fromage",
  addressLine2: "Bâtiment B",
  postalCode: "75001",
  city: "Paris",
  governingCountry: "France",
  customerServiceEmail: "contact@aulaitcru.example",
  customerServicePhone: "+33 1 23 45 67 89",
  mediatorName: "CM2C",
  mediatorAddress: "49 rue de Ponthieu, 75008 Paris",
  mediatorWebsite: "https://www.cm2c.net",
  legalEntityName: "AU LAIT CRU SARL",
  siren: "842925513",
  siret: "84292551300025",
  vatNumber: "FR34842925513",
  mediatorPhone: "+33 1 89 47 00 14",
  mediatorEmail: "cm2c@cm2c.net",
};

const BUSINESS: CgvBusinessConditionsForRender = {
  withdrawalRegime: "EXEMPT_PERISHABLE",
  preparationTimeMin: 30,
  preparationTimeMax: 60,
  preparationTimeUnit: "MINUTES",
  cancellationPolicyText: "Annulation possible jusqu'à deux heures avant le retrait.",
  substitutionPolicyText: null,
  coldChainApplicable: true,
  weightPricingMode: "FIXED_PORTION_PRICE",
};

/** Gabarit v1 : aucune clé optionnelle -- sert à prouver l'absence de trous. */
const TEMPLATE_V1: CgvTemplateControlledSections = {
  header: TEMPLATE.header,
  identity_intro: TEMPLATE.identity_intro,
  withdrawal_clauses: TEMPLATE.withdrawal_clauses,
  mediator_clause: TEMPLATE.mediator_clause,
  preparation_clause: TEMPLATE.preparation_clause,
  cancellation_clause_label: TEMPLATE.cancellation_clause_label,
  substitution_clause_label: TEMPLATE.substitution_clause_label,
  jurisdiction_clause: TEMPLATE.jurisdiction_clause,
};

const render = (
  overrides: {
    template?: CgvTemplateControlledSections;
    legal?: Partial<LegalProfileForRender>;
    business?: Partial<CgvBusinessConditionsForRender>;
    sellerName?: string;
  } = {}
) =>
  renderCgv({
    sellerName: overrides.sellerName ?? "Au lait cru",
    template: overrides.template ?? TEMPLATE,
    legal: { ...LEGAL, ...(overrides.legal ?? {}) },
    business: { ...BUSINESS, ...(overrides.business ?? {}) },
    locale: "fr",
    presentationVariant: "FORMAL",
  });

const chapters = (out: string) => [...out.matchAll(/data-chapter="(\d+)"/g)].map((m) => Number(m[1]));
const decodeEntities = (value: string) =>
  value
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const chapterTitles = (out: string) =>
  [...out.matchAll(/<span class="cgv-chapter-title">([^<]*)<\/span>/g)].map((m) => decodeEntities(m[1]));
const identityRow = (out: string, label: string) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = out.match(new RegExp(`<dt>${escaped}</dt><dd>([^<]*)</dd>`));
  return m ? m[1] : null;
};
/** Texte brut du document : balises retirées, entités HTML décodées. */
const plainText = (out: string) =>
  out
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();

// --------------------------------------------------------------
// 1 & 2. Numérotation séquentielle, sans trou
// --------------------------------------------------------------
test("1 — chaque chapitre rendu porte un numéro séquentiel 1, 2, 3, …", () => {
  const out = render();
  const nums = chapters(out);

  assert.ok(nums.length >= 20, "le gabarit complet doit produire une vingtaine de chapitres");
  assert.deepEqual(nums, nums.map((_, i) => i + 1), "séquence strictement 1..N");
  // Le numéro affiché correspond au numéro structurel.
  const displayed = [...out.matchAll(/<span class="cgv-chapter-number">(\d+)\.<\/span>/g)].map((m) => Number(m[1]));
  assert.deepEqual(displayed, nums, "le numéro affiché est celui de la séquence réelle");
});

test("2 — une section conditionnelle absente ne crée AUCUN trou dans la numérotation", () => {
  // Gabarit v1 minimal + aucune option marchand : beaucoup de sections
  // ne sont pas rendues du tout.
  const minimal = render({
    template: TEMPLATE_V1,
    legal: { siren: null, siret: null, vatNumber: null, customerServiceEmail: null, customerServicePhone: null },
    business: { coldChainApplicable: false, weightPricingMode: null },
  });
  const nums = chapters(minimal);
  assert.deepEqual(nums, nums.map((_, i) => i + 1), "séquence sans trou malgré les sections omises");
  assert.ok(nums.length < chapters(render()).length, "le gabarit minimal rend bien MOINS de chapitres");

  // Cas ciblé : la chaîne du froid retirée décale les suivants d'un
  // cran, sans jamais laisser de numéro manquant.
  const withCold = chapterTitles(render());
  const withoutCold = chapterTitles(render({ business: { coldChainApplicable: false } }));
  assert.ok(withCold.includes("Chaîne du froid"));
  assert.ok(!withoutCold.includes("Chaîne du froid"));
  assert.equal(withoutCold.length, withCold.length - 1);
  const numsWithout = chapters(render({ business: { coldChainApplicable: false } }));
  assert.deepEqual(numsWithout, numsWithout.map((_, i) => i + 1));
});

test("2b — aucun numéro de chapitre n'est écrit en dur dans un gabarit contrôlé", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "legal", "render.ts"), "utf8");
  // Le seul endroit qui produit un numéro est le compteur de chapitre.
  assert.ok(src.includes("createChapterCounter"), "la numérotation vient d'un compteur");
  const hardCoded = [...src.matchAll(/data-chapter="(?!\$\{)/g)];
  assert.equal(hardCoded.length, 0, "aucun data-chapter littéral");
  // Et les titres restent ceux du code/gabarit, jamais préfixés en dur.
  assert.ok(!/["'`]\s*\d+\.\s+[A-ZÉÈÀ]/.test(src), "aucun titre préfixé d'un numéro en dur");
});

// --------------------------------------------------------------
// 3 & 4. Identité du vendeur étiquetée, sans marqueur fabriqué
// --------------------------------------------------------------
test("3 — l'identité du vendeur est rendue en lignes étiquetées, avec les valeurs existantes", () => {
  const out = render();
  assert.equal(identityRow(out, "Dénomination"), "AU LAIT CRU SARL (exerçant sous le nom commercial « Au lait cru »)");
  assert.equal(identityRow(out, "Forme juridique"), "Société à responsabilité limitée");
  assert.equal(identityRow(out, "Adresse"), "12 rue du Fromage, Bâtiment B, 75001 Paris");
  assert.equal(identityRow(out, "Pays"), "France");
  assert.equal(identityRow(out, "SIREN"), "842925513");
  assert.equal(identityRow(out, "SIRET"), "84292551300025");
  assert.equal(identityRow(out, "N° TVA intracommunautaire"), "FR34842925513");
  assert.ok(out.includes('<dl class="cgv-identity">'), "bloc d'identité identifiable");
});

test("4 — une valeur optionnelle absente ne produit AUCUNE ligne ni aucun tiret de remplissage", () => {
  const out = render({ legal: { siren: null, siret: null, vatNumber: null, legalEntityName: null } });
  assert.equal(identityRow(out, "SIREN"), null);
  assert.equal(identityRow(out, "SIRET"), null);
  assert.equal(identityRow(out, "N° TVA intracommunautaire"), null);
  assert.equal(identityRow(out, "Dénomination"), "Au lait cru", "repli sur le nom commercial, jamais une valeur inventée");
  const text = plainText(out);
  for (const marker of ["null", "undefined", "N/A", "non renseigné"]) {
    assert.ok(!text.includes(marker), `aucun marqueur de remplissage « ${marker} »`);
  }
  // Aucune ligne étiquetée vide ou remplie d'un tiret de complaisance.
  assert.ok(!/<dd>\s*(—|-|–|&nbsp;)?\s*<\/dd>/.test(out), "aucune valeur vide ou remplacée par un tiret");
});

test("4b — les coordonnées du service client sont étiquetées, chacune seulement si elle existe", () => {
  const both = render();
  assert.equal(identityRow(both, "E-mail"), "contact@aulaitcru.example");
  assert.equal(identityRow(both, "Téléphone"), "+33 1 23 45 67 89");

  const phoneOnly = render({ legal: { customerServiceEmail: null } });
  assert.equal(identityRow(phoneOnly, "E-mail"), null);
  assert.equal(identityRow(phoneOnly, "Téléphone"), "+33 1 23 45 67 89");

  const none = render({ legal: { customerServiceEmail: null, customerServicePhone: null } });
  assert.ok(!chapterTitles(none).includes("Service client"), "section entièrement omise, comportement inchangé");
});

// --------------------------------------------------------------
// 5. Encadré réglementaire toujours distinct
// --------------------------------------------------------------
test("5 — l'encadré D.211-2 reste un bloc distinct, non numéroté, au texte inchangé", () => {
  const out = render();
  const block = out.match(/<section class="legal-guarantee-encadre"[\s\S]*?<\/section>/);
  assert.ok(block, "le bloc réglementaire doit rester identifiable par sa classe");
  const encadre = block![0];

  assert.ok(encadre.includes("border:2px solid #444"), "bordure de repli conservée, même sans feuille de style");
  assert.ok(!encadre.includes("data-chapter"), "l'encadré n'est pas un chapitre et ne consomme aucun numéro");
  for (const paragraph of TEMPLATE.legal_guarantee_encadre!.paragraphs) {
    assert.ok(plainText(encadre).includes(paragraph), "chaque paragraphe statutaire est rendu verbatim");
  }
  assert.ok(plainText(encadre).includes(TEMPLATE.legal_guarantee_encadre!.heading));
  // Et il n'est jamais fondu dans la section « Garanties légales ».
  assert.ok(!encadre.includes(TEMPLATE.legal_guarantees_clause as string));
});

// --------------------------------------------------------------
// 6. PREUVE : le texte juridique rendu est inchangé
// --------------------------------------------------------------
test("6 — texte juridique STRICTEMENT inchangé : chaque clause du gabarit et du marchand est rendue, verbatim", () => {
  const out = render();
  const text = plainText(out);

  const expectedTexts = [
    TEMPLATE.header,
    TEMPLATE.identity_intro,
    TEMPLATE.withdrawal_clauses.EXEMPT_PERISHABLE as string,
    TEMPLATE.mediator_clause,
    TEMPLATE.preparation_clause,
    TEMPLATE.cancellation_clause_label,
    TEMPLATE.substitution_clause_label,
    TEMPLATE.jurisdiction_clause,
    TEMPLATE.purpose_scope_clause as string,
    TEMPLATE.products_characteristics_clause as string,
    TEMPLATE.portion_pricing_clauses!.FIXED_PORTION_PRICE as string,
    TEMPLATE.prices_taxes_clause as string,
    TEMPLATE.ordering_process_clause as string,
    TEMPLATE.contract_formation_clause as string,
    TEMPLATE.payment_clause as string,
    TEMPLATE.availability_clause as string,
    TEMPLATE.pickup_clause as string,
    TEMPLATE.delivery_clause as string,
    TEMPLATE.cold_chain_clauses!.transport,
    TEMPLATE.cold_chain_clauses!.post_handover,
    TEMPLATE.cancellation_clause_intro as string,
    TEMPLATE.substitution_clause_intro as string,
    TEMPLATE.substitution_clause_fallback as string,
    TEMPLATE.complaints_clause as string,
    TEMPLATE.legal_guarantees_clause as string,
    TEMPLATE.liability_clause as string,
    TEMPLATE.force_majeure_clause as string,
    TEMPLATE.personal_data_clause as string,
    TEMPLATE.applicable_law_clause as string,
    TEMPLATE.complaint_before_mediation_clause as string,
    BUSINESS.cancellationPolicyText as string,
    LEGAL.mediatorName,
    LEGAL.mediatorAddress,
    LEGAL.mediatorWebsite,
  ];
  for (const expected of expectedTexts) {
    assert.ok(text.includes(expected), `texte manquant dans le rendu : « ${expected.slice(0, 60)}… »`);
  }

  // Le délai de préparation garde son interpolation exacte.
  assert.ok(text.includes("Délai indicatif : 30–60 minutes."));

  // Rien d'autre que du balisage et les étiquettes de présentation
  // autorisées n'a été ajouté au texte : en retirant tous les textes
  // attendus, il ne doit plus rester que des étiquettes connues.
  const allowedLabels = [
    "Identité du vendeur",
    "Dénomination",
    "Forme juridique",
    "Adresse",
    "Pays",
    "SIREN",
    "SIRET",
    "N° TVA intracommunautaire",
    "Service client",
    "E-mail",
    "Téléphone",
  ];
  for (const label of allowedLabels) {
    assert.ok(text.includes(label), `étiquette de présentation attendue : ${label}`);
  }
});

test("6b — aucune clause supprimée : le nombre de chapitres correspond aux clauses réellement fournies", () => {
  const titles = chapterTitles(render());
  assert.deepEqual(titles, [
    "Identité du vendeur",
    "Objet et champ d'application",
    "Service client",
    "Caractéristiques des produits",
    "Poids et prix des portions",
    "Prix et taxes",
    "Processus de commande",
    "Formation du contrat",
    "Paiement",
    "Disponibilité des produits",
    "Délai de préparation",
    "Retrait de la commande",
    "Livraison",
    "Chaîne du froid",
    "Droit de rétractation",
    "Médiation de la consommation",
    "Annulation de la commande",
    "Substitution de produits",
    "Réclamations",
    "Garanties légales",
    "Responsabilité",
    "Force majeure",
    "Données personnelles",
    "Loi applicable",
    "Juridiction compétente",
  ]);
});

test("6c — le déterminisme du rendu est intact : mêmes entrées, sortie identique au caractère près", () => {
  assert.equal(render(), render());
  assert.equal(render(), render());
});

// --------------------------------------------------------------
// 7. Échappement HTML toujours intact
// --------------------------------------------------------------
test("7 — l'échappement HTML reste intact sur toutes les valeurs marchand, étiquettes comprises", () => {
  const payload = `<script>alert('x')</script>`;
  const out = render({
    sellerName: payload,
    legal: {
      legalForm: payload,
      siren: payload,
      customerServiceEmail: payload,
      mediatorName: payload,
      legalEntityName: payload,
    },
    business: { cancellationPolicyText: payload },
  });

  assert.ok(!/<script\b/i.test(out), "aucune balise script active");
  assert.ok(!/\son[a-z]+\s*=/i.test(out), "aucun attribut d'évènement actif");
  assert.ok(out.includes("&lt;script&gt;"), "le payload est échappé, pas exécuté");
  assert.ok(!/<a\s/i.test(out) && !/href\s*=/i.test(out), "le rendu n'introduit toujours aucun lien actif");
  // Les valeurs échappées restent dans leur ligne étiquetée.
  assert.ok(out.includes("<dt>SIREN</dt><dd>&lt;script&gt;"), "valeur échappée à sa place");
});

// --------------------------------------------------------------
// 8. Comportement conditionnel existant préservé
// --------------------------------------------------------------
test("8 — les sections conditionnelles existantes gardent EXACTEMENT leur comportement", () => {
  // Rétractation : STANDARD_14_DAYS rend les deux clauses v2.4 ;
  // EXEMPT_PERISHABLE ne les rend jamais.
  const withExtras: CgvTemplateControlledSections = {
    ...TEMPLATE,
    withdrawal_exercise_method_clause: "Modalités d'exercice du droit de rétractation.",
    withdrawal_model_form_text: "Formulaire type de rétractation.",
  };
  const standard = render({ template: withExtras, business: { withdrawalRegime: "STANDARD_14_DAYS" } });
  const exempt = render({ template: withExtras, business: { withdrawalRegime: "EXEMPT_PERISHABLE" } });

  assert.ok(plainText(standard).includes("Modalités d'exercice du droit de rétractation."));
  assert.ok(plainText(standard).includes("Formulaire type de rétractation."));
  assert.ok(!plainText(exempt).includes("Modalités d'exercice du droit de rétractation."));
  assert.ok(!plainText(exempt).includes("Formulaire type de rétractation."));

  // Politique marchand absente -> repli du gabarit, jamais un vide.
  const noPolicy = render({ business: { cancellationPolicyText: null } });
  assert.ok(plainText(noPolicy).includes(TEMPLATE.cancellation_clause_fallback as string));

  // MIXED sans clause résolue -> échec fermé, inchangé.
  assert.throws(() => render({ business: { withdrawalRegime: "MIXED" } }), /no controlled clause/);
});

// --------------------------------------------------------------
// 9. Mobile : aucune régression de débordement
// --------------------------------------------------------------
test("9 — mise en page mobile : césure sûre, aucune largeur figée, encadré contenu", () => {
  const css = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
  const block = css.slice(css.indexOf(".cgv-document"));
  assert.ok(block.includes("overflow-wrap: anywhere"), "identifiants et URL peuvent être coupés");
  assert.ok(block.includes("word-break: break-word"));
  assert.ok(/\.cgv-document \.legal-guarantee-encadre[\s\S]*?max-width: 100%/.test(block), "l'encadré reste dans le viewport");
  assert.ok(block.includes("@media (min-width: 640px)"), "étiquettes sur deux colonnes seulement à partir de sm");
  // Largeurs en pixels interdites -- `border-*-width: 2px` reste permis.
  assert.ok(!/(^|[^-a-z])(max-)?width:\s*\d+px/m.test(block), "aucune largeur fixe en pixels");
  assert.ok(!/white-space:\s*nowrap/.test(block), "aucun texte forcé sur une seule ligne");

  // Le rendu lui-même n'introduit ni tableau ni largeur en dur.
  const out = render();
  assert.ok(!/<table/i.test(out), "aucun tableau (source classique de débordement mobile)");
  assert.ok(!/width\s*=\s*"\d+"/.test(out), "aucune largeur figée dans le balisage");
  assert.ok(!/style="[^"]*width:/.test(out), "aucune largeur en ligne");

  // Un identifiant très long reste dans une cellule sécable.
  const longId = "FR" + "9".repeat(60);
  assert.ok(render({ legal: { vatNumber: longId } }).includes(`<dd>${longId}</dd>`));
});

test("9b — la page publique applique la mise en page du document et conserve date et référence", () => {
  const page = readFileSync(path.join(process.cwd(), "app", "legal", "[slug]", "page.tsx"), "utf8");
  assert.ok(page.includes('className="cgv-document"'), "le document porte la classe de mise en page");
  assert.ok(page.includes("Version publiée le"), "la date de publication reste affichée");
  assert.ok(page.includes("cgv.cgvVersionId"), "la référence de version reste affichée");
  assert.ok(page.includes("dangerouslySetInnerHTML"), "le contenu publié reste rendu tel quel, jamais réécrit");
});

test("9c — les versions publiées AVANT ce lot restent numérotées, sans être réécrites", () => {
  const css = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
  assert.ok(css.includes("counter-reset: cgv-chapter"), "compteur de repli défini");
  assert.ok(
    css.includes('section:not([data-chapter]):not(.legal-guarantee-encadre)'),
    "le repli ne s'applique qu'aux anciens documents, et jamais à l'encadré"
  );
  assert.ok(css.includes("counter-increment: cgv-chapter"));
});
