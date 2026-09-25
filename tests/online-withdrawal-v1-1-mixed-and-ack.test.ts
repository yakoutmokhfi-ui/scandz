import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { renderCgv, MixedRegimeClauseMissingError } = await import("../lib/legal/render.ts");
const { translate, DICTS } = await import("../lib/i18n.ts");
import type { CgvTemplateControlledSections } from "../lib/legal/render.ts";

// ====================================================================
// SCANYM — ONLINE WITHDRAWAL v1.1 (Claude Monet)
// RÉGIME MIXTE DE PLEIN EXERCICE + ACCUSÉ DE RÉCEPTION FAIL-CLOSED
//
// Deux contrats non négociables, et un piège à éviter :
//
//   1. MIXED est un régime CONTRÔLÉ, publiable, PAS un alias de
//      STANDARD_14_DAYS. Le droit ne porte que sur la part éligible ;
//      les produits légalement exclus le restent ; la fonctionnalité
//      en ligne n'expose que les lignes éligibles ; renvoi,
//      remboursement et accusé de réception ne concernent que cette
//      part. Un gabarit sans clause MIXTE échoue toujours FERMÉ.
//
//   2. La fonctionnalité STATUTAIRE n'est pas « complète » tant que
//      l'accusé de réception ne peut pas être ENVOYÉ au consommateur
//      (D.221-5, transposant l'art. 11 bis de la directive 2011/83/UE
//      telle que modifiée par la directive (UE) 2023/2673 : « le
//      professionnel lui envoie sans retard excessif un accusé de
//      réception ... des informations sur son contenu ainsi que la
//      date et l'heure de sa soumission »). Enregistrer ne vaut pas
//      envoyer : la garde de publication reste donc false.
// ====================================================================

const repoRoot = process.cwd();
const sql = (file: string) => readFileSync(path.join(repoRoot, "supabase", file), "utf8");
const FOUNDATION = sql("DRAFT-lot-online-withdrawal-foundation-v1.sql");
const FOUNDATION_ROLLBACK = sql("DRAFT-lot-online-withdrawal-foundation-v1-ROLLBACK.sql");
const ENGINE = sql("DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql");
const ENGINE_ROLLBACK = sql("DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime-ROLLBACK.sql");
const CGV_V6 = sql("DRAFT-lot-online-withdrawal-cgv-template-v6.sql");
const flat = (value: string) => value.replace(/\s+/g, " ");

/** Le rendu échappe le HTML : « l'exercice » y devient « l&#39;exercice ».
 *  On compare donc le texte tel qu'un lecteur le lit, pas tel que le
 *  navigateur le reçoit. */
const readable = (html: string) => html.replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** SQL hors corps de fonction : ce que le fichier EXÉCUTE lui-même,
 *  par opposition au code qu'il se contente de (re)définir. Un
 *  `update` figurant dans le corps d'une fonction restaurée n'est pas
 *  une écriture faite par le rollback. */
const topLevelSql = (source: string) => source.replace(/as \$\$[\s\S]*?\$\$;/g, " <corps de fonction> ");

// --------------------------------------------------------------
// Fixtures de rendu
// --------------------------------------------------------------

const BASE_TEMPLATE: CgvTemplateControlledSections = {
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

/** Gabarit « version 6 » : clause MIXTE contrôlée + clauses conditionnelles. */
const V6_TEMPLATE: CgvTemplateControlledSections = {
  ...BASE_TEMPLATE,
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause EXEMPT_PERISHABLE.",
    STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.",
    MIXED: "Clause MIXTE : le droit ne porte que sur la part éligible (L221-18 et suivants), les produits exclus le restent (L221-28 4°).",
  },
  withdrawal_exercise_method_clause: "Méthode d'exercice en ligne.",
  mixed_order_withdrawal_clause: "Règle des commandes mixtes : seules les lignes éligibles.",
  withdrawal_return_and_refund_clause: "Renvoi (L221-23) et remboursement (L221-24).",
  withdrawal_acknowledgement_clause: "Accusé de réception sur support durable.",
  withdrawal_model_form_text: "Formulaire type de rétractation.",
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
  withdrawalRegime: "MIXED" as const,
  preparationTimeMin: 15,
  preparationTimeMax: 25,
  preparationTimeUnit: "MINUTES" as const,
  cancellationPolicyText: "Annulation possible avant préparation.",
  substitutionPolicyText: "Substitution équivalente si rupture.",
};

const render = (
  template: CgvTemplateControlledSections,
  regime: "MIXED" | "STANDARD_14_DAYS" | "EXEMPT_PERISHABLE"
) =>
  renderCgv({
    sellerName: "Maison Victor",
    template,
    legal: LEGAL,
    business: { ...BUSINESS, withdrawalRegime: regime },
    locale: "fr",
    presentationVariant: "FORMAL",
  });

// ==================================================================
// 1. MIXED — régime de plein exercice au rendu
// ==================================================================

test("MIXTE : le document est RENDU, avec la clause de régime MIXTE et aucune des deux autres", () => {
  const out = render(V6_TEMPLATE, "MIXED");
  assert.match(out, /Clause MIXTE/);
  assert.doesNotMatch(out, /Clause STANDARD_14_DAYS\./);
  assert.doesNotMatch(out, /Clause EXEMPT_PERISHABLE\./);
});

test("MIXTE : les clauses conditionnelles de rétractation sont rendues, dans le MÊME ordre que pour STANDARD_14_DAYS", () => {
  const mixed = readable(render(V6_TEMPLATE, "MIXED"));
  for (const clause of [
    "Méthode d'exercice en ligne.",
    "Règle des commandes mixtes : seules les lignes éligibles.",
    "Renvoi (L221-23) et remboursement (L221-24).",
    "Accusé de réception sur support durable.",
    "Formulaire type de rétractation.",
  ]) {
    assert.ok(mixed.includes(clause), `clause manquante : ${clause}`);
  }
  const order = (html: string) =>
    [
      "Méthode d'exercice",
      "Règle des commandes mixtes",
      "Renvoi (L221-23)",
      "Accusé de réception",
      "Formulaire type",
    ].map((needle) => html.indexOf(needle));
  const positions = order(mixed);
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "ordre de lecture : méthode -> commandes mixtes -> renvoi/remboursement -> accusé -> formulaire"
  );
  // Même ordre que le régime standard : aucune divergence de structure.
  const standardPositions = order(readable(render(V6_TEMPLATE, "STANDARD_14_DAYS")));
  assert.deepEqual(
    standardPositions,
    [...standardPositions].sort((a, b) => a - b)
  );
});

test("MIXTE n'est PAS un alias de STANDARD_14_DAYS : les deux documents diffèrent", () => {
  assert.notEqual(render(V6_TEMPLATE, "MIXED"), render(V6_TEMPLATE, "STANDARD_14_DAYS"));
});

test("MIXTE : un gabarit SANS clause de régime MIXTE échoue toujours FERMÉ (comportement v1 conservé)", () => {
  assert.throws(() => render(BASE_TEMPLATE, "MIXED"), /SCANYM_CGV_RENDER: no controlled clause/);
});

test("MIXTE : un gabarit AVEC clause de régime mais SANS règle des commandes mixtes échoue FERMÉ", () => {
  const partial: CgvTemplateControlledSections = { ...V6_TEMPLATE };
  delete (partial as { mixed_order_withdrawal_clause?: string }).mixed_order_withdrawal_clause;
  assert.throws(() => render(partial, "MIXED"), MixedRegimeClauseMissingError);
  // …alors que le MÊME gabarit reste rendu pour un marchand standard :
  // la règle des commandes mixtes y est un enrichissement, pas la
  // définition du régime.
  assert.ok(render(partial, "STANDARD_14_DAYS").length > 0);
});

test("EXEMPT_PERISHABLE : aucune clause de rétractation en ligne ne fuit (régression v1)", () => {
  const out = readable(render(V6_TEMPLATE, "EXEMPT_PERISHABLE"));
  assert.match(out, /Clause EXEMPT_PERISHABLE\./);
  for (const clause of [
    "Méthode d'exercice en ligne.",
    "Règle des commandes mixtes",
    "Renvoi (L221-23)",
    "Accusé de réception sur support durable.",
    "Formulaire type de rétractation.",
  ]) {
    assert.ok(!out.includes(clause), `clause rendue à tort pour un régime sans droit : ${clause}`);
  }
});

// ==================================================================
// 2. Gabarit version 6 — la clause MIXTE contrôlée
// ==================================================================

test("gabarit v6 : la clause MIXTE existe, cite le droit ET l'exclusion, et n'est pas une copie", () => {
  const match = CGV_V6.match(/"MIXED":\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(match, "la version 6 doit porter une clause MIXED non nulle");
  const clause = match![1]!;
  assert.match(clause, /L221-18/, "le droit applicable à la part éligible est cité");
  assert.match(clause, /L221-28/, "l'exclusion légale est citée");
  assert.match(clause, /4°/, "le point 4° (biens périssables) est cité");
  // Les quatre affirmations exigées par le mandat.
  assert.match(clause, /part éligible/i);
  assert.match(clause, /exclusion n'est pas levée/i);
  assert.match(clause, /ne présente au Client que les lignes de commande éligibles/i);
  assert.match(clause, /renvoi des biens, au remboursement et à l'accusé de réception/i);
  // …et ce n'est pas la clause standard recopiée.
  const standard = CGV_V6.match(/"STANDARD_14_DAYS":\s*"((?:[^"\\]|\\.)*)"/)![1]!;
  assert.notEqual(clause, standard);
});

test("gabarit v6 : les vérifications post-commit refusent une clause MIXTE absente ou aliasée", () => {
  const f = flat(CGV_V6);
  assert.match(f, /laisse le régime MIXTE sans clause contrôlée/);
  assert.match(f, /la clause MIXTE est un alias de STANDARD_14_DAYS/i);
});

test("gabarit v6 : son pré-vol teste les PRIMITIVES, jamais la garde de publication", () => {
  const f = flat(CGV_V6);
  assert.match(f, /_scanym_has_online_withdrawal_primitives\(\)/);
  assert.ok(
    !/if not public\._scanym_has_online_withdrawal_runtime\(\)/.test(f),
    "inscrire un gabarit au catalogue ne doit pas dépendre de la garde de PUBLICATION"
  );
});

// ==================================================================
// 3. Moteur CGV — MIXED conditionné, jamais refusé par principe
// ==================================================================

test("moteur : MIXED n'est plus refusé par principe, mais par ABSENCE de clause dans le gabarit APPLICABLE", () => {
  const f = flat(ENGINE);
  // L'ancien refus inconditionnel a disparu…
  assert.ok(
    !/elsif v_cgv\.withdrawal_regime = 'MIXED' then v_errors := array_append\(v_errors, 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED'\);/.test(f),
    "le refus inconditionnel du régime MIXTE doit avoir disparu"
  );
  // …remplacé par une vérification RÉELLE du gabarit applicable.
  assert.match(f, /v_applicable := public\._resolve_applicable_cgv_template\(p_restaurant_id\);/);
  assert.match(
    f,
    /if v_applicable\.id is null or coalesce\(btrim\(v_applicable\.controlled_sections->'withdrawal_clauses'->>'MIXED'\), ''\) = '' then v_errors := array_append\(v_errors, 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED'\);/
  );
  // Le code d'erreur reste celui que l'interface marchande sait traduire.
  assert.match(f, /WITHDRAWAL_REGIME_MIXED_UNSUPPORTED/);
});

test("moteur : les DEUX chemins de publication couvrent le régime MIXTE", () => {
  const f = flat(ENGINE);
  assert.match(
    f,
    /if v_withdrawal_regime_early in \('STANDARD_14_DAYS', 'MIXED'\) and not public\._scanym_has_online_withdrawal_runtime\(\)/,
    "persist_merchant_cgv_version"
  );
  assert.match(
    f,
    /v_online_withdrawal_function_gap := \(v_cgv\.withdrawal_regime in \('STANDARD_14_DAYS', 'MIXED'\)\);/,
    "resolve_cgv_publication_context"
  );
  // …et chacun refuse en plus un gabarit sans clause MIXTE.
  assert.equal(
    (f.match(/detail = 'WITHDRAWAL_REGIME_MIXED_UNSUPPORTED'/g) ?? []).length,
    2,
    "défense en profondeur : la vérification existe sur les deux chemins"
  );
});

test("moteur : aucun alias — MIXED n'est jamais réécrit en STANDARD_14_DAYS", () => {
  assert.ok(
    !/withdrawal_regime\s*:?=\s*'STANDARD_14_DAYS'/i.test(ENGINE),
    "aucun chemin ne doit requalifier un marchand MIXTE en marchand standard"
  );
});

test("moteur : signature et forme de sortie inchangées (aucun appelant à modifier)", () => {
  const f = flat(ENGINE);
  assert.match(f, /create or replace function public\.cgv_completeness_errors\(p_restaurant_id uuid\) returns text\[\]/);
  assert.match(f, /create or replace function public\.resolve_cgv_publication_context\(p_restaurant_id uuid\)/);
  assert.match(f, /online_withdrawal_function_gap\s+boolean/);
  assert.match(
    f,
    /create or replace function public\.persist_merchant_cgv_version\( p_restaurant_id uuid, p_template_id uuid, p_rendered_content text, p_expected_context_fingerprint text, p_acting_user_id uuid \)/
  );
  // Privilèges réaffirmés, jamais élargis.
  assert.match(f, /revoke all on function public\.cgv_completeness_errors\(uuid\) from public;/);
  assert.ok(!/grant execute on function public\.\w+\(uuid\) to anon/.test(f), "aucune exposition à anon");
});

test("moteur : rollback rétablit la forme antérieure des trois fonctions", () => {
  const f = flat(ENGINE_ROLLBACK);
  assert.match(f, /create or replace function public\.cgv_completeness_errors/);
  assert.match(f, /create or replace function public\.resolve_cgv_publication_context/);
  assert.match(f, /create or replace function public\.persist_merchant_cgv_version/);
  assert.match(f, /cgv_completeness_errors porte encore la forme v1\.1/);
  assert.match(f, /persist_merchant_cgv_version couvre encore le régime MIXTE/);
  // Le rollback du moteur ne touche AUCUNE donnée : les seules
  // instructions qu'il exécute lui-même sont des (re)définitions de
  // fonctions, des privilèges et ses propres vérifications. Les
  // `update` visibles dans le fichier appartiennent aux CORPS des
  // fonctions restaurées, pas au rollback.
  const executed = topLevelSql(ENGINE_ROLLBACK);
  assert.ok(!/\bdelete\s+from\b|\btruncate\b/i.test(executed), "aucune suppression de données");
  assert.ok(
    !/\bupdate\s+public\.(merchant_cgv_version|merchant_cgv_profile|cgv_template|order_cgv_acceptance)\b/i.test(executed),
    "aucune écriture sur les données juridiques"
  );
});

// ==================================================================
// 4. Accusé de réception — la garde statutaire est fail-closed
// ==================================================================

test("garde : la fonctionnalité statutaire exige les primitives ET un canal d'accusé opérationnel", () => {
  const f = flat(FOUNDATION);
  assert.match(
    f,
    /create or replace function public\._scanym_has_online_withdrawal_runtime\(\) returns boolean language sql stable set search_path = '' as \$\$ select public\._scanym_has_online_withdrawal_primitives\(\) and public\._scanym_has_operational_durable_ack_channel\(\); \$\$;/,
    "la garde est la CONJONCTION des deux conditions"
  );
  // Jamais un littéral de confort.
  assert.ok(!/_scanym_has_online_withdrawal_runtime\(\)[^$]*\$\$\s*select true/i.test(FOUNDATION));
});

test("garde : les deux questions restent SÉPARÉES (primitives livrées ≠ obligation remplie)", () => {
  const f = flat(FOUNDATION);
  assert.match(f, /create function public\._scanym_has_online_withdrawal_primitives\(\)/);
  // Les primitives testent des objets réels, jamais un booléen écrit en dur.
  assert.match(f, /to_regclass\('public\.withdrawal_requests'\) is not null/);
  assert.match(f, /to_regprocedure\('public\.submit_withdrawal_request_by_capability/);
});

// ------------------------------------------------------------------
// OW-V11-ACK-GUARD-01 (CRITIQUE) — le canal d'accusé ne peut pas être
// déclaré opérationnel par la seule existence d'un objet de schéma.
// ------------------------------------------------------------------

test("OW-V11-ACK-GUARD-01 : le canal d'accusé est EXPLICITEMENT fermé, sans sentinelle de schéma", () => {
  const channelFn = FOUNDATION.slice(
    FOUNDATION.indexOf("create function public._scanym_has_operational_durable_ack_channel()")
  );
  const body = channelFn.slice(channelFn.indexOf("as $$"), channelFn.indexOf("$$;") + 3);

  // Le corps ne fait plus qu'une chose : dire non.
  assert.match(body, /select false;/, "fail-closed explicite");

  // …et il ne consulte AUCUN indice d'existence : ni table, ni colonne,
  // ni fonction, ni ligne de configuration. C'est tout le défaut
  // corrigé : une table VIDE ne prouve aucun envoi.
  for (const sentinel of [
    "to_regclass",
    "to_regprocedure",
    "information_schema",
    "pg_class",
    "pg_proc",
    "withdrawal_acknowledgement_deliveries",
    "select 1 from",
    "exists",
  ]) {
    assert.ok(
      !body.toLowerCase().includes(sentinel.toLowerCase()),
      `le canal ne doit pas être déduit de « ${sentinel} »`
    );
  }
});

test("OW-V11-ACK-GUARD-01 : plus AUCUNE fonction du lot ne dérive le canal d'une table d'envois", () => {
  for (const [name, source] of [
    ["fondation", FOUNDATION],
    ["moteur", ENGINE],
    ["moteur (rollback)", ENGINE_ROLLBACK],
  ] as const) {
    const executableOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.ok(
      !/to_regclass\(\s*'public\.withdrawal_acknowledgement_deliveries'/.test(executableOnly),
      `${name} : la sentinelle de présence de table ne doit plus exister`
    );
  }
});

test("OW-V11-ACK-GUARD-01 : la correction est tracée dans le code, pas seulement dans un rapport", () => {
  assert.match(FOUNDATION, /OW-V11-ACK-GUARD-01/);
  // Le texte de l'interdiction vit DANS le corps de la fonction, là où
  // quelqu'un serait tenté de « rétablir » la sentinelle. (Les
  // commentaires SQL sont préfixés `--` : on cherche la phrase, pas sa
  // mise en page.)
  assert.match(
    FOUNDATION,
    /test de présence d'objet/,
    "l'interdiction est écrite là où la tentation se présentera"
  );
});

test("garde : la migration REFUSE de s'appliquer si elle se déclare complète sans canal d'envoi", () => {
  const f = flat(FOUNDATION);
  assert.match(f, /if not public\._scanym_has_online_withdrawal_primitives\(\) then/);
  assert.match(f, /if public\._scanym_has_operational_durable_ack_channel\(\) then/);
  assert.match(
    f,
    /if public\._scanym_has_online_withdrawal_runtime\(\) then raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la fonctionnalité statutaire est déclarée complète/
  );
});

test("garde : la base juridique de l'exigence d'ENVOI est citée dans le code, pas seulement dans un rapport", () => {
  assert.match(FOUNDATION, /D\.221-5/);
  assert.match(FOUNDATION, /11 bis/);
  assert.match(FOUNDATION, /2023\/2673/);
  assert.match(FOUNDATION, /19 juin 2026/);
  assert.match(ENGINE, /D\.221-5/);
});

test("accusé : aucun chemin n'écrit « sent » sans envoi réel (régression v1)", () => {
  // On vise l'AFFECTATION (`:=`) et l'insertion littérale, jamais la
  // comparaison : la table porte précisément une contrainte
  // `(acknowledgement_status = 'sent') = (acknowledgement_sent_at is
  // not null)`, qui est une GARANTIE d'honnêteté, pas une écriture.
  assert.ok(
    !/acknowledgement_status\s*:=\s*'sent'/.test(FOUNDATION),
    "aucune affectation directe du statut « envoyé »"
  );
  assert.match(
    flat(FOUNDATION),
    /\(acknowledgement_status = 'sent'\) = \(acknowledgement_sent_at is not null\)/,
    "un « envoyé » sans horodatage d'envoi reste impossible en base"
  );
  assert.match(
    flat(FOUNDATION),
    /case when public\._scanym_has_operational_durable_ack_channel\(\) then 'pending' else 'unavailable_no_channel' end/
  );
});

// ==================================================================
// 5. Instantané légal PAR LIGNE en régime MIXTE
// ==================================================================

// ------------------------------------------------------------------
// OW-V11-MIXED-BASIS-02 (ÉLEVÉ) — la base légale d'une ligne exclue
// n'est JAMAIS déduite d'une prose contractuelle générique.
// ------------------------------------------------------------------

test("OW-V11-MIXED-BASIS-02 : une ligne MIXTE exclue reçoit TOUJOURS le repli contrôlé, jamais une citation devinée", () => {
  const f = flat(FOUNDATION);
  assert.match(f, /if new\.merchant_withdrawal_regime_at_order_time = 'MIXED'/);
  // Éligible -> droit ouvert ; non éligible -> repli contrôlé, sans
  // condition, sans lecture de texte.
  assert.match(
    f,
    /if new\.withdrawal_eligible_at_order_time then new\.withdrawal_exempt_at_order_time := false; new\.withdrawal_legal_basis_at_order_time := 'STANDARD_14_DAYS_ELIGIBLE'; else new\.withdrawal_exempt_at_order_time := true; new\.withdrawal_legal_basis_at_order_time := 'MIXED_UNSPECIFIED_CITATION'; end if;/
  );
  // Éligibilité inconnue -> AUCUNE affirmation.
  assert.match(f, /and new\.withdrawal_eligible_at_order_time is not null/);
});

test("OW-V11-MIXED-BASIS-02 : le déclencheur ne lit plus AUCUNE source de texte juridique", () => {
  const trigger = FOUNDATION.slice(
    FOUNDATION.indexOf("create function public.snapshot_order_item_withdrawal_eligibility()"),
    FOUNDATION.indexOf("comment on function public.snapshot_order_item_withdrawal_eligibility()")
  );
  const executable = trigger
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const source of [
    "cgv_template",
    "order_cgv_acceptance",
    "merchant_cgv_version",
    "controlled_sections",
    "withdrawal_clauses",
    "ilike",
    "L221-28",
  ]) {
    assert.ok(
      !executable.includes(source),
      `le déclencheur ne doit plus consulter « ${source} » pour qualifier une ligne`
    );
  }
  // Il ne lit QUE la source autoritaire de l'éligibilité : le catalogue.
  assert.ok(executable.includes("from public.menu_items mi"));
});

test("OW-V11-MIXED-BASIS-02 : aucune citation précise ne peut être écrite par ce lot", () => {
  const executable = FOUNDATION.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  // Aucune AFFECTATION d'une citation précise, et aucune dérivation
  // depuis un texte. (Ces mêmes valeurs restent présentes plus bas,
  // dans le VOCABULAIRE fermé de la colonne -- une liste de valeurs
  // permises n'écrit rien.)
  for (const citation of ["'L221-28-4'", "'L221-28-3'"]) {
    assert.ok(
      !executable.includes(`:= ${citation}`),
      `aucune instruction ne doit affecter ${citation} : seule une source produit autoritaire pourrait le faire`
    );
  }
  assert.ok(!/ilike\s*'%L221-28/.test(executable), "aucune citation n'est cherchée dans un texte");
  // …ces valeurs restent néanmoins DANS le vocabulaire fermé, car des
  // lignes antérieures (régime EXEMPT_PERISHABLE, lot CGV v2.5) les
  // portent légitimement.
  assert.match(flat(FOUNDATION), /'L221-28-4', 'L221-28-3', 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION', 'STANDARD_14_DAYS_ELIGIBLE'/);
});

test("OW-V11-MIXED-BASIS-02 : le principe produit est écrit là où la tentation reviendra", () => {
  assert.match(FOUNDATION, /OW-V11-MIXED-BASIS-02/);
  for (const forbidden of [
    "ni du nom du produit",
    "catégorie",
    "ni d'une DLC/DDM",
    "ni d'une IA",
    "ni du texte des CGV",
  ]) {
    assert.ok(FOUNDATION.includes(forbidden), `le principe doit nommer l'interdit : ${forbidden}`);
  }
});

test("instantané : l'exclusion de ligne suit l'éligibilité, jamais le seul régime du marchand", () => {
  const f = flat(FOUNDATION);
  assert.match(f, /if new\.withdrawal_eligible_at_order_time then new\.withdrawal_exempt_at_order_time := false;/);
  assert.match(f, /new\.withdrawal_exempt_at_order_time := true;/);
});

test("instantané : le déclencheur reste BEFORE INSERT seulement (aucune réécriture rétroactive)", () => {
  const f = flat(FOUNDATION);
  assert.match(f, /create trigger trg_order_items_snapshot_withdrawal_eligibility before insert on public\.order_items/);
  assert.ok(!/after insert on public\.order_items/.test(f));
  assert.ok(
    !/update public\.order_items set withdrawal_legal_basis_at_order_time/.test(FOUNDATION),
    "un instantané légal déjà pris n'est jamais réécrit"
  );
});

test("vocabulaire : la liste des bases légales reste FERMÉE, étendue de la seule valeur du régime MIXTE", () => {
  const f = flat(FOUNDATION);
  assert.match(
    f,
    /check \(withdrawal_legal_basis_at_order_time is null or withdrawal_legal_basis_at_order_time in \( 'L221-28-4', 'L221-28-3', 'EXEMPT_PERISHABLE_UNSPECIFIED_CITATION', 'STANDARD_14_DAYS_ELIGIBLE', .*'MIXED_UNSPECIFIED_CITATION' \)\)/
  );
  // Le rollback refuse de détruire un instantané déjà pris.
  assert.match(flat(FOUNDATION_ROLLBACK), /SCANYM_ROLLBACK_BLOCKED: % ligne\(s\) de commande portent la base légale MIXED_UNSPECIFIED_CITATION/);
});

// ==================================================================
// 6. Périmètre — rien d'autre n'a bougé
// ==================================================================

test("périmètre : ni remboursement, ni payment_status, ni cycle de vie de commande", () => {
  for (const [name, source] of [
    ["fondation", FOUNDATION],
    ["moteur", ENGINE],
    ["moteur (rollback)", ENGINE_ROLLBACK],
  ] as const) {
    // Analyse du SQL EXÉCUTABLE : commentaires et littéraux retirés
    // (les fichiers DOCUMENTENT ces interdits en toutes lettres).
    let out = "";
    let i = 0;
    while (i < source.length) {
      if (source[i] === "-" && source[i + 1] === "-") {
        while (i < source.length && source[i] !== "\n") i += 1;
        out += " ";
        continue;
      }
      if (source[i] === "'") {
        i += 1;
        while (i < source.length) {
          if (source[i] === "'") {
            if (source[i + 1] === "'") {
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          i += 1;
        }
        out += " '' ";
        continue;
      }
      out += source[i];
      i += 1;
    }
    assert.ok(!/payment_status/i.test(out), `${name} : payment_status`);
    assert.ok(!/\brefund\w*/i.test(out), `${name} : remboursement`);
    assert.ok(!/update\s+public\.orders\b/i.test(out), `${name} : orders`);
  }
});

// ==================================================================
// 7. OW-V11-ACK-UX-03 — libellés strictement factuels, fr / en / ar
// ==================================================================

/** Formulations qui promettent une remise que rien ne garantit. */
const PROMESSES_INTERDITES: Record<string, string[]> = {
  fr: ["vous recevrez", "va vous être envoyé", "sera envoyé", "vous le transmettra", "vous sera transmis", "le commerçant vous"],
  en: ["you will receive", "will be sent", "the merchant will send", "will send it to you"],
  ar: ["سيتم إرسال", "سيُرسَل", "سيوافيك"],
};

test("OW-V11-ACK-UX-03 : aucun état d'accusé non confirmé ne promet une remise (fr, en, ar)", () => {
  for (const lang of ["fr", "en", "ar"]) {
    for (const key of ["withdrawalAckUnavailable", "withdrawalAckPending", "withdrawalAckAddressHelp"]) {
      const value = (DICTS as Record<string, Record<string, string>>)[lang]?.[key] ?? "";
      assert.ok(value.trim() !== "", `${key} absent en ${lang}`);
      for (const promise of PROMESSES_INTERDITES[lang]!) {
        assert.ok(
          !value.toLowerCase().includes(promise.toLowerCase()),
          `${lang}/${key} promet une remise non garantie : « ${promise} »`
        );
      }
    }
  }
});

test("OW-V11-ACK-UX-03 : les états non confirmés annoncent ce qui est VRAI -- enregistrement, date et heure", () => {
  assert.equal(
    translate("fr", "withdrawalAckUnavailable"),
    "Votre demande a été enregistrée, avec sa date et son heure. L'accusé de réception électronique n'est pas disponible actuellement."
  );
  assert.equal(
    translate("fr", "withdrawalAckPending"),
    "Votre demande a été enregistrée, avec sa date et son heure. L'accusé de réception électronique n'a pas encore été envoyé."
  );
  // L'anglais et l'arabe disent la MÊME chose : enregistré + indisponible.
  assert.match(translate("en", "withdrawalAckUnavailable"), /recorded, with its date and time/);
  assert.match(translate("en", "withdrawalAckUnavailable"), /not available at present/);
  assert.match(translate("ar", "withdrawalAckUnavailable"), /تم تسجيل طلبك/);
});

test("OW-V11-ACK-UX-03 : « envoyé » reste réservé à l'état RÉELLEMENT confirmé", () => {
  // Un seul libellé parle d'un envoi accompli…
  assert.match(translate("fr", "withdrawalAckSent"), /vous a été envoyé/);
  // …et le composant ne l'affiche que pour le statut 'sent'.
  const panel = readFileSync(path.join(repoRoot, "components", "WithdrawalPanel.tsx"), "utf8");
  assert.match(
    panel.replace(/\s+/g, " "),
    /receipt\.acknowledgementStatus === "sent" \? t\("withdrawalAckSent"\)/,
    "le libellé d'envoi est conditionné au statut confirmé par le serveur"
  );
  // La règle de rédaction est inscrite dans le dictionnaire lui-même.
  const i18n = readFileSync(path.join(repoRoot, "lib", "i18n.ts"), "utf8");
  assert.match(i18n, /OW-V11-ACK-UX-03/);
});
